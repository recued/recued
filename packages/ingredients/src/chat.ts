/** Chat adapter — orchestrates a full write→submit→poll→read cycle on a
 *  web page in another browser tab.
 *
 *  Used for interacting with AI chat interfaces (Gemini, DeepSeek,
 *  ChatGPT) and messaging platforms (Discord, Slack, Reddit) from recipes.
 *
 *  From the recipe's perspective, a chat ingredient is like an LLM step —
 *  long-running "prompt in, response out." The adapter handles tab
 *  discovery, DOM interaction, and polling internally.
 *
 *  The adapter reuses the existing DOM content script bridge for all
 *  element interaction. It does NOT run DOM operations itself — it sends
 *  bridge messages to the target tab's content script.
 *
 *  Output key conventions in the ingredient manifest:
 *    chat.target   → URL pattern for tab discovery (like trigger for DOM)
 *    chat.new      → CSS selector for "New Chat" button (optional, preferred)
 *    chat.new_url  → URL to navigate to for a fresh conversation (fallback)
 *    chat.input    → CSS selector for the text input element
 *    chat.submit   → CSS selector for the submit/enter target
 *    chat.response → CSS selector for the response element (last match)
 *    chat.loading  → CSS selector for a loading indicator (optional)
 */

import { IngredientError, type ResolvedCall } from './types.js';
import { matchUrlPattern } from './url-match.js';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** Minimal tab shape returned by chrome.tabs.query. */
export interface TabInfo {
  id?: number;
  url?: string;
  active?: boolean;
}

/** Bridge request shapes matching DomBridge types. */
export interface BridgeExecuteRequest {
  kind: 'dom-bridge.execute';
  slug: string;
  risk_tier: string;
  input: Record<string, unknown>;
  output: Record<string, string>;
}

export interface BridgeWatchRequest {
  kind: 'dom-bridge.watch';
  responseSelector: string;
  loadingSelector: string | null;
  snapshotText: string | null;
  timeoutMs: number;
  stabilizeMs: number;
}

export type BridgeRequest = BridgeExecuteRequest | BridgeWatchRequest;

/** Bridge response shape matching DomBridgeResponse. */
export interface BridgeResponse {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

/** Audit entry emitted after each chat interaction. */
export interface ChatAuditEntry {
  ingredient_slug: string;
  prompt_length: number;
  response_length: number;
  duration_ms: number;
  mode: 'recipe' | 'conversation';
  success: boolean;
}

/** Dependencies injected by the caller (service worker). */
export interface ChatAdapterDeps {
  /** Query all open tabs. Maps to chrome.tabs.query({}). */
  queryTabs: () => Promise<TabInfo[]>;
  /** Send a bridge message to a specific tab. Maps to chrome.tabs.sendMessage. */
  sendTabMessage: (tabId: number, message: BridgeRequest) => Promise<BridgeResponse | null>;
  /** Navigate a tab to a new URL and wait for it to finish loading.
   *  Resolves when the page's load event fires (status: 'complete').
   *  Used to open a fresh chat conversation before typing. */
  navigateTab?: (tabId: number, url: string) => Promise<void>;
  /** Optional audit callback. Fires after each chat interaction. */
  onAudit?: (entry: ChatAuditEntry) => void;
}

/** Per-ingredient overrides (from input fields). */
export interface ChatConfig {
  timeoutMs: number;
  stabilizeMs: number;
}

/** Chat-specific selectors parsed from an ingredient's output mapping.
 *  Exported for unit tests only — not part of the public adapter API. */
export interface ChatSelectors {
  target: string | null;
  newButton: string | null;
  newUrl: string | null;
  inputSelector: string | null;
  submitSelector: string | null;
  responseSelector: string | null;
  loadingSelector: string | null;
}

/** Result of the pre-write "prepare tab" phase. Tells the main flow
 *  what snapshot (if any) to diff the response against, and whether
 *  a fresh chat was started (→ cleanup-click eligible).
 *  Exported for unit tests only — not part of the public adapter API. */
export interface PreparedChat {
  snapshotText: string | null;
  didStartFreshChat: boolean;
}

/** Bridge-send callable bound to a specific tab + ingredient. Hides
 *  the message shape, tabId, and retry-once-on-nav-failure policy
 *  from callers — they just send `(input, output)` and get data back.
 *  Exported for unit tests only — not part of the public adapter API. */
export type BridgeSender = (
  input: Record<string, unknown>,
  output: Record<string, string>,
) => Promise<unknown>;

const DEFAULT_TIMEOUT_MS = 90_000; // 90 seconds
const DEFAULT_STABILIZE_MS = 1500; // text must be stable for 1.5s

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/** Parse chat-specific selectors from the ingredient's output mapping. */
const parseChatSelectors = (output: Record<string, string>): ChatSelectors => {
  const sel: ChatSelectors = {
    target: null, newButton: null, newUrl: null,
    inputSelector: null, submitSelector: null,
    responseSelector: null, loadingSelector: null,
  };
  for (const [selector, value] of Object.entries(output)) {
    switch (value) {
      case 'chat.target':   sel.target = selector; break;
      case 'chat.new':      sel.newButton = selector; break;
      case 'chat.new_url':  sel.newUrl = selector; break;
      case 'chat.input':    sel.inputSelector = selector; break;
      case 'chat.submit':   sel.submitSelector = selector; break;
      case 'chat.response': sel.responseSelector = selector; break;
      case 'chat.loading':  sel.loadingSelector = selector; break;
    }
  }
  return sel;
};

/** Wait for a CSS selector to appear on the target tab. Called after
 *  navigateTab resolves (page loaded) — only needs to cover SPA
 *  hydration time, not the full network load. Retries a few times
 *  then fails with a clear "login required?" message. */
const waitForElement = async (
  deps: ChatAdapterDeps,
  tabId: number,
  resolved: ResolvedCall,
  selector: string,
  _timeoutMs: number,
): Promise<boolean> => {
  const probeIntervalMs = typeof resolved.input['chat.probe_interval_ms'] === 'number'
    ? resolved.input['chat.probe_interval_ms'] : 1500;
  const maxProbeMs = typeof resolved.input['chat.timeout_ms'] === 'number'
    ? Math.min(resolved.input['chat.timeout_ms'], 8000) : 8000;
  const maxAttempts = Math.max(1, Math.ceil(maxProbeMs / probeIntervalMs));
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, probeIntervalMs));
    try {
      const response = await deps.sendTabMessage(tabId, {
        kind: 'dom-bridge.execute',
        slug: resolved.slug,
        risk_tier: resolved.risk_tier,
        input: {},
        output: { [selector]: '_probe' },
      });
      if (response?.ok) {
        const data = response.data as Record<string, unknown> | null;
        if (data?._probe != null) return true;
      }
    } catch {
      // Content script not injected yet — keep trying
    }
  }
  return false;
};

/** Pick a tab matching the URL pattern. Prefers inactive (background)
 *  tabs so we don't hijack the user's current interaction. Returns
 *  null when nothing matches — caller handles as "skip, no chat tab".
 *  Exported for unit tests only. */
export const findChatTab = async (
  deps: ChatAdapterDeps,
  urlPattern: string,
): Promise<number | null> => {
  const tabs = await deps.queryTabs();
  const candidates = tabs.filter(t => t.url && t.id != null && matchUrlPattern(urlPattern, t.url));
  const backgroundTab = candidates.find(t => !t.active);
  const anyTab = candidates[0];
  return (backgroundTab?.id ?? anyTab?.id) ?? null;
};

/** Bind a BridgeSender to a (tab, ingredient). The returned function
 *  hides the dom-bridge.execute envelope and applies the same
 *  retry-once-on-nav-failure policy as the DOM adapter proxy —
 *  content-script re-injection after SPA navigation is the common
 *  cause of DOM_PAGE_NOT_MATCHING, and one retry after 1.5s covers it. */
const createBridgeSender = (
  deps: ChatAdapterDeps,
  tabId: number,
  slug: string,
  risk_tier: string,
): BridgeSender => async (input, output) => {
  const msg: BridgeExecuteRequest = {
    kind: 'dom-bridge.execute',
    slug, risk_tier, input, output,
  };

  const attempt = async (): Promise<unknown> => {
    const response = await deps.sendTabMessage(tabId, msg);
    if (!response) {
      throw new IngredientError(
        'DOM_PAGE_NOT_MATCHING',
        `Chat target tab ${tabId} has no content script — is the page loaded?`,
        { tab_id: tabId, slug },
      );
    }
    if (!response.ok) {
      throw new IngredientError(
        response.error?.code ?? 'DOM_PAGE_NOT_MATCHING',
        response.error?.message ?? 'Chat bridge call failed',
        response.error?.details as Record<string, unknown> | undefined,
      );
    }
    return response.data;
  };

  try {
    return await attempt();
  } catch (e) {
    if (e instanceof IngredientError && e.code === 'DOM_PAGE_NOT_MATCHING') {
      await new Promise((r) => setTimeout(r, 1500));
      return attempt();
    }
    throw e;
  }
};

/** Read the current response text (one-shot). Used both for
 *  conversation-mode snapshots and as the fallback when no
 *  new-chat mechanism is available. */
const snapshotResponse = async (
  sendBridge: BridgeSender,
  responseSelector: string,
): Promise<string | null> => {
  const data = await sendBridge({}, { [responseSelector]: 'response' }) as Record<string, unknown> | null;
  return (data?.response ?? null) as string | null;
};

/** Prepare the chat tab before writing the new prompt. Three modes:
 *
 *    conversation    → snapshot current response, keep thread intact.
 *    recipe + newButton → click "New Chat", wait for clear.
 *    recipe + newUrl    → navigate to a fresh URL, wait for input ready.
 *    recipe + fallback  → snapshot current response (treats as
 *                         "old-response diff" baseline).
 *
 *  newButton is preferred because it's SPA-native (no reload).
 *  newUrl is the fallback when the button is missing/broken. If
 *  neither works, we snapshot so the MutationObserver watcher can
 *  still distinguish "new response arrived" from the existing text.
 *  Exported for unit tests only. */
export const prepareChatTab = async (
  deps: ChatAdapterDeps,
  tabId: number,
  resolved: ResolvedCall,
  mode: 'recipe' | 'conversation',
  selectors: ChatSelectors,
  config: ChatConfig,
  sendBridge: BridgeSender,
): Promise<PreparedChat> => {
  const { newButton, newUrl, inputSelector, responseSelector } = selectors;

  if (mode === 'conversation') {
    return { snapshotText: await snapshotResponse(sendBridge, responseSelector!), didStartFreshChat: false };
  }

  if (newButton) {
    const clickResult = await sendBridge({}, { [newButton]: 'click' }) as Record<string, unknown> | null;
    if (clickResult && (clickResult as { written?: number }).written) {
      // Click landed — probe up to 5x (~2.5s) for the response area to
      // clear. Not strictly required (the watcher can still diff an
      // empty snapshot) but avoids racing the next write against the
      // previous conversation's tail.
      const probeInterval = typeof resolved.input['chat.probe_interval_ms'] === 'number'
        ? resolved.input['chat.probe_interval_ms'] : 500;
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, probeInterval));
        const probe = await sendBridge({}, { [responseSelector!]: 'response' }) as Record<string, unknown> | null;
        if (!probe?.response) break;
      }
      return { snapshotText: null, didStartFreshChat: true };
    }
    // Click missed (button gone / selector stale) — fall through to newUrl or snapshot.
  }

  if (newUrl && deps.navigateTab) {
    const fullUrl = newUrl.startsWith('http') ? newUrl : `https://${newUrl}`;
    await deps.navigateTab(tabId, fullUrl);
    const ready = await waitForElement(deps, tabId, resolved, inputSelector!, config.timeoutMs);
    if (!ready) {
      throw new IngredientError(
        'DOM_SELECTOR_NOT_FOUND',
        `Chat input not found on ${newUrl} — is the chat service logged in?`,
        { slug: resolved.slug, selector: inputSelector, url: newUrl },
      );
    }
    return { snapshotText: null, didStartFreshChat: true };
  }

  return { snapshotText: await snapshotResponse(sendBridge, responseSelector!), didStartFreshChat: false };
};

/** Health-check the input element before writing. Catches stale tabs
 *  (session expired, SPA crashed, navigated away). If the probe fails
 *  and navigateTab is available, refresh the tab to current URL and
 *  re-check. Throws DOM_SELECTOR_NOT_FOUND when recovery isn't
 *  possible so the recipe surfaces a clear "log in?" message instead
 *  of a cryptic write failure later. */
const verifyInputReady = async (
  deps: ChatAdapterDeps,
  tabId: number,
  resolved: ResolvedCall,
  selectors: ChatSelectors,
  config: ChatConfig,
  sendBridge: BridgeSender,
): Promise<void> => {
  const { inputSelector, target } = selectors;
  const inputProbe = await sendBridge({}, { [inputSelector!]: '_probe' }) as Record<string, unknown> | null;
  if (inputProbe?._probe) return;

  if (deps.navigateTab && target) {
    const currentUrl = (await deps.queryTabs()).find(t => t.id === tabId)?.url;
    if (currentUrl) {
      await deps.navigateTab(tabId, currentUrl);
      const ready = await waitForElement(deps, tabId, resolved, inputSelector!, config.timeoutMs);
      if (!ready) {
        throw new IngredientError(
          'DOM_SELECTOR_NOT_FOUND',
          `Chat input not found after refresh — is the chat service logged in?`,
          { slug: resolved.slug, selector: inputSelector },
        );
      }
    }
    // currentUrl missing (tab closed during health-check) — fall through;
    // downstream write will surface the error.
    return;
  }

  throw new IngredientError(
    'DOM_SELECTOR_NOT_FOUND',
    `Chat input not found — the chat tab may need a refresh or login`,
    { slug: resolved.slug, selector: inputSelector },
  );
};

// ────────────────────────────────────────────────────────────────
// Public adapter — lock + orchestration
// ────────────────────────────────────────────────────────────────

/** Serialize concurrent chat calls. Only one call can use a given chat
 *  tab at a time — a second caller waits for the first to finish. */
let chatLock: Promise<unknown> = Promise.resolve();

/** Create the chat adapter. Dependency-injected so tests can provide
 *  fake tab queries and bridge senders. */
export const createChatAdapter = (deps: ChatAdapterDeps) =>
  async (resolved: ResolvedCall): Promise<unknown> => {
    const prev = chatLock;
    let releaseLock: () => void;
    chatLock = new Promise<void>((r) => { releaseLock = r; });
    await prev;
    try {
      return await executeChatCall(deps, resolved);
    } finally {
      releaseLock!();
    }
  };

const executeChatCall = async (
  deps: ChatAdapterDeps,
  resolved: ResolvedCall,
): Promise<unknown> => {
  const selectors = parseChatSelectors(resolved.output);
  const { target, newButton, inputSelector, submitSelector, responseSelector, loadingSelector } = selectors;

  if (!target || !inputSelector || !submitSelector || !responseSelector) {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `Chat ingredient '${resolved.slug}' missing required output keys: chat.target, chat.input, chat.submit, chat.response`,
      { slug: resolved.slug },
    );
  }

  const rawPrompt = resolved.input['chat.prompt'];
  const prompt = typeof rawPrompt === 'string' ? rawPrompt.trim() : '';
  if (!prompt) {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `Chat ingredient '${resolved.slug}' requires a non-empty chat.prompt input`,
      { slug: resolved.slug },
    );
  }

  const mode: 'recipe' | 'conversation' = resolved.input['chat.mode'] === 'conversation'
    ? 'conversation' : 'recipe';

  const config: ChatConfig = {
    timeoutMs: (typeof resolved.input['chat.timeout_ms'] === 'number')
      ? resolved.input['chat.timeout_ms']
      : DEFAULT_TIMEOUT_MS,
    stabilizeMs: (typeof resolved.input['chat.stabilize_ms'] === 'number')
      ? resolved.input['chat.stabilize_ms']
      : DEFAULT_STABILIZE_MS,
  };

  const startTime = Date.now();

  // 1. Find target tab. Null → no matching tab; return null so the
  //    recipe can fallback via skip_when/coalesce.
  const tabId = await findChatTab(deps, target);
  if (tabId === null) return null;

  const sendBridge = createBridgeSender(deps, tabId, resolved.slug, resolved.risk_tier);

  // 2. Prepare the tab — start fresh chat (recipe mode) or snapshot
  //    (conversation mode / fallback).
  const { snapshotText, didStartFreshChat } = await prepareChatTab(
    deps, tabId, resolved, mode, selectors, config, sendBridge,
  );

  // 2.5. Health-check the input element. Throws on unrecoverable failure.
  await verifyInputReady(deps, tabId, resolved, selectors, config, sendBridge);

  // 3. Write prompt.
  await sendBridge({ prompt }, { [inputSelector]: 'dom.prompt' });

  // 4. Submit via Enter key.
  await sendBridge({}, { [submitSelector]: 'enter' });

  // 5. Watch for new response via MutationObserver (single async call).
  //    The content script resolves when the response text changes from
  //    the snapshot and stabilizes. For fresh chats, snapshotText is
  //    null — the observer resolves on the first AI response.
  const watchResponse = await deps.sendTabMessage(tabId, {
    kind: 'dom-bridge.watch',
    responseSelector,
    loadingSelector,
    snapshotText,
    timeoutMs: config.timeoutMs,
    stabilizeMs: config.stabilizeMs,
  });

  if (!watchResponse) return null; // Tab closed or content script gone
  if (!watchResponse.ok) {
    throw new IngredientError(
      watchResponse.error?.code ?? 'DOM_PAGE_NOT_MATCHING',
      watchResponse.error?.message ?? 'Chat watch failed',
      watchResponse.error?.details as Record<string, unknown> | undefined,
    );
  }

  const result = watchResponse.data;
  const responseText = (result as { response?: string } | null)?.response ?? '';

  // 6. Cleanup: click "New Chat" to erase the conversation (recipe mode only).
  //    Conversation mode retains the thread for follow-up messages.
  if (mode === 'recipe' && didStartFreshChat && newButton) {
    try { await sendBridge({}, { [newButton]: 'click' }); } catch { /* best-effort */ }
  }

  // 7. Audit: log the interaction (prompt length, response length, no content).
  if (deps.onAudit) {
    try {
      deps.onAudit({
        ingredient_slug: resolved.slug,
        prompt_length: prompt.length,
        response_length: responseText.length,
        duration_ms: Date.now() - startTime,
        mode,
        success: !!responseText,
      });
    } catch { /* audit is best-effort */ }
  }

  return result;
};
