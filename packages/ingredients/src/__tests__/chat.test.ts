import { describe, it, expect } from 'vitest';
import {
  createChatAdapter,
  findChatTab,
  prepareChatTab,
  type ChatAdapterDeps,
  type ChatConfig,
  type ChatSelectors,
  type BridgeResponse,
  type BridgeRequest,
  type BridgeSender,
} from '../chat.js';
import type { ResolvedCall } from '../types.js';

// ────────────────────────────────────────────────────────────────
// Test fixtures
// ────────────────────────────────────────────────────────────────

/** Resolved call WITHOUT chat.new_url (snapshot mode). */
const mkResolved = (overrides?: Partial<ResolvedCall>): ResolvedCall => ({
  slug: 'web-chat-gemini',
  risk_tier: 'write',
  input: { 'chat.prompt': 'What is 2+2?', 'chat.timeout_ms': 500, 'chat.stabilize_ms': 50, 'chat.probe_interval_ms': 10 },
  output: {
    'gemini.google.com/*': 'chat.target',
    'textarea.input': 'chat.input',
    'textarea.submit': 'chat.submit',
    '.response:last-child': 'chat.response',
    '.loading': 'chat.loading',
  },
  ...overrides,
});

/** Resolved call WITH chat.new button (preferred fresh chat mode). */
const mkResolvedFresh = (overrides?: Partial<ResolvedCall>): ResolvedCall => ({
  ...mkResolved(),
  output: {
    ...mkResolved().output,
    'button.new-chat': 'chat.new',
  },
  ...overrides,
});

/** Resolved call WITH chat.new_url only (fallback fresh chat mode). */
const mkResolvedFreshUrl = (overrides?: Partial<ResolvedCall>): ResolvedCall => ({
  ...mkResolved(),
  output: {
    ...mkResolved().output,
    'https://gemini.google.com/app': 'chat.new_url',
  },
  ...overrides,
});

const okResponse = (data: unknown): BridgeResponse => ({ ok: true, data });
const errorResponse = (code: string, message: string): BridgeResponse => ({
  ok: false,
  error: { code, message },
});

/** Create mock deps. The sendTabMessage handler can inspect the message
 *  kind to distinguish execute vs watch calls. */
const mkDeps = (
  tabs: { id?: number; url?: string }[],
  handler: (msg: BridgeRequest, idx: number) => BridgeResponse | null,
): { deps: ChatAdapterDeps; calls: BridgeRequest[] } => {
  const calls: BridgeRequest[] = [];
  let idx = 0;
  return {
    deps: {
      queryTabs: async () => tabs,
      sendTabMessage: async (_tabId, message) => {
        // Auto-handle health probe transparently — don't increment idx
        if (message.kind === 'dom-bridge.execute' &&
            Object.values(message.output).includes('_probe')) {
          return okResponse({ _probe: 'found' });
        }
        calls.push(message);
        return handler(message, idx++);
      },
    },
    calls,
  };
};

/** Simple sequential response handler for basic tests. */
const sequential = (responses: BridgeResponse[]) => {
  let i = 0;
  return (_msg: BridgeRequest) => responses[i++] ?? null;
};

const GEMINI_TABS = [{ id: 42, url: 'https://gemini.google.com/app' }];

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe('createChatAdapter', () => {
  it('returns null when no matching tab is found', async () => {
    const { deps } = mkDeps([{ id: 1, url: 'https://example.com' }], () => null);
    const result = await createChatAdapter(deps)(mkResolved());
    expect(result).toBeNull();
  });

  it('returns null when tabs are empty', async () => {
    const { deps } = mkDeps([], () => null);
    const result = await createChatAdapter(deps)(mkResolved());
    expect(result).toBeNull();
  });

  it('happy path: snapshot, write, submit, watch → response', async () => {
    const { deps, calls } = mkDeps(GEMINI_TABS, (msg) => {
      if (msg.kind === 'dom-bridge.execute') {
        // Snapshot read, write, or submit
        if (msg.output['.response:last-child'] === 'response') return okResponse({ response: 'old' });
        return okResponse({ written: 1 });
      }
      if (msg.kind === 'dom-bridge.watch') {
        return okResponse({ response: 'The answer is 4' });
      }
      return null;
    });
    const result = await createChatAdapter(deps)(mkResolved());

    expect(result).toEqual({ response: 'The answer is 4' });
    // 4 calls: snapshot + write + submit + watch
    expect(calls.length).toBe(4);
    expect(calls[0].kind).toBe('dom-bridge.execute'); // snapshot
    expect(calls[1].kind).toBe('dom-bridge.execute'); // write
    expect(calls[2].kind).toBe('dom-bridge.execute'); // submit
    expect(calls[3].kind).toBe('dom-bridge.watch');   // watch
  });

  it('watch passes correct parameters', async () => {
    const { deps, calls } = mkDeps(GEMINI_TABS, (msg) => {
      if (msg.kind === 'dom-bridge.execute') return okResponse({ response: 'snapshot text' });
      if (msg.kind === 'dom-bridge.watch') return okResponse({ response: 'new' });
      return null;
    });
    await createChatAdapter(deps)(mkResolved());

    const watchCall = calls.find(c => c.kind === 'dom-bridge.watch')!;
    expect(watchCall.kind).toBe('dom-bridge.watch');
    if (watchCall.kind === 'dom-bridge.watch') {
      expect(watchCall.responseSelector).toBe('.response:last-child');
      expect(watchCall.loadingSelector).toBe('.loading');
      expect(watchCall.snapshotText).toBe('snapshot text');
      expect(watchCall.timeoutMs).toBe(500);
      expect(watchCall.stabilizeMs).toBe(50);
    }
  });

  it('returns null on watch timeout (content script returns null data)', async () => {
    const { deps } = mkDeps(GEMINI_TABS, (msg) => {
      if (msg.kind === 'dom-bridge.execute') return okResponse({ response: 'old' });
      if (msg.kind === 'dom-bridge.watch') return okResponse(null); // timeout
      return null;
    });
    const result = await createChatAdapter(deps)(mkResolved());
    expect(result).toBeNull();
  });

  it('throws on missing required output keys', async () => {
    const { deps } = mkDeps([], () => null);
    await expect(createChatAdapter(deps)({
      slug: 'bad',
      risk_tier: 'write',
      input: { 'chat.prompt': 'hi' },
      output: { 'gemini.google.com/*': 'chat.target' },
    })).rejects.toThrow('missing required output keys');
  });

  it('throws on missing prompt', async () => {
    const { deps } = mkDeps(GEMINI_TABS, () => null);
    await expect(createChatAdapter(deps)({
      ...mkResolved(),
      input: {},
    })).rejects.toThrow('chat.prompt');
  });

  it('throws on write failure (no silent null)', async () => {
    let callIdx = 0;
    const { deps } = mkDeps(GEMINI_TABS, () => {
      callIdx++;
      if (callIdx === 1) return okResponse({ response: 'old' }); // snapshot
      return errorResponse('DOM_SELECTOR_NOT_FOUND', 'Input not found'); // write fails
    });
    await expect(createChatAdapter(deps)(mkResolved())).rejects.toThrow('Input not found');
  });

  it('throws on submit failure', async () => {
    let callIdx = 0;
    const { deps } = mkDeps(GEMINI_TABS, () => {
      callIdx++;
      if (callIdx === 1) return okResponse({ response: 'old' }); // snapshot
      if (callIdx === 2) return okResponse({ written: 1 }); // write
      return errorResponse('DOM_SELECTOR_NOT_FOUND', 'Submit not found'); // submit fails
    });
    await expect(createChatAdapter(deps)(mkResolved())).rejects.toThrow('Submit not found');
  });

  it('returns null when tab closes during watch', async () => {
    const { deps } = mkDeps(GEMINI_TABS, (msg) => {
      if (msg.kind === 'dom-bridge.execute') return okResponse({ response: 'old' });
      if (msg.kind === 'dom-bridge.watch') return null; // tab closed
      return null;
    });
    const result = await createChatAdapter(deps)(mkResolved());
    expect(result).toBeNull();
  });

  it('matches tab URL with wildcard pattern', async () => {
    const { deps } = mkDeps(
      [{ id: 1, url: 'https://example.com' }, { id: 2, url: 'https://gemini.google.com/app/conv123' }],
      (msg) => {
        if (msg.kind === 'dom-bridge.execute') return okResponse({ response: 'old' });
        if (msg.kind === 'dom-bridge.watch') return okResponse({ response: 'new' });
        return null;
      },
    );
    const result = await createChatAdapter(deps)(mkResolved());
    expect(result).toEqual({ response: 'new' });
  });

  it('works without chat.loading selector', async () => {
    const resolved = mkResolved();
    const { '.loading': _, ...outputWithoutLoading } = resolved.output;

    const { deps, calls } = mkDeps(GEMINI_TABS, (msg) => {
      if (msg.kind === 'dom-bridge.execute') return okResponse({ response: 'old' });
      if (msg.kind === 'dom-bridge.watch') {
        // Verify loadingSelector is null
        return okResponse({ response: 'new' });
      }
      return null;
    });
    const result = await createChatAdapter(deps)({ ...resolved, output: outputWithoutLoading });
    expect(result).toEqual({ response: 'new' });
    const watchCall = calls.find(c => c.kind === 'dom-bridge.watch')!;
    if (watchCall.kind === 'dom-bridge.watch') {
      expect(watchCall.loadingSelector).toBeNull();
    }
  });

  it('retries once on content script not injected (nav retry)', async () => {
    let callCount = 0;
    const deps: ChatAdapterDeps = {
      queryTabs: async () => GEMINI_TABS,
      sendTabMessage: async (_tabId, msg) => {
        callCount++;
        // Auto-handle health probe
        if (msg.kind === 'dom-bridge.execute' && Object.values(msg.output).includes('_probe')) {
          return okResponse({ _probe: 'found' });
        }
        // First non-probe call (snapshot): content script not ready → null
        if (callCount === 2) return null;
        // Retry succeeds
        if (msg.kind === 'dom-bridge.execute') return okResponse({ response: 'old' });
        if (msg.kind === 'dom-bridge.watch') return okResponse({ response: 'new' });
        return null;
      },
    };
    const result = await createChatAdapter(deps)(mkResolved());
    expect(result).toEqual({ response: 'new' });
  });

  it('propagates watch error', async () => {
    const { deps } = mkDeps(GEMINI_TABS, (msg) => {
      if (msg.kind === 'dom-bridge.execute') return okResponse({ response: 'old' });
      if (msg.kind === 'dom-bridge.watch') return errorResponse('DOM_CROSS_ORIGIN', 'Cross-origin frame');
      return null;
    });
    await expect(createChatAdapter(deps)(mkResolved())).rejects.toThrow('Cross-origin frame');
  });

  // ── Fresh chat via button click (chat.new) ──

  it('fresh chat button: clicks new chat, verifies clear, gets response', async () => {
    let callIdx = 0;
    const { deps, calls } = mkDeps(GEMINI_TABS, (msg) => {
      callIdx++;
      if (msg.kind === 'dom-bridge.execute') {
        // Call 1: click new-chat button → returns written:1
        // Call 2: probe response is empty (conversation cleared)
        // Call 3: write prompt
        // Call 4: submit
        if (callIdx === 2) return okResponse({ response: null }); // cleared
        return okResponse({ written: 1 });
      }
      if (msg.kind === 'dom-bridge.watch') return okResponse({ response: 'The answer is 4' });
      return null;
    });

    const result = await createChatAdapter(deps)(mkResolvedFresh());

    expect(result).toEqual({ response: 'The answer is 4' });
    // click + clear-probe + write + submit + cleanup-click = 5 execute + 1 watch
    expect(calls.filter(c => c.kind === 'dom-bridge.execute').length).toBe(5);
    expect(calls.filter(c => c.kind === 'dom-bridge.watch').length).toBe(1);
    // First call clicks new chat, last execute call is cleanup click
    expect(calls[0].kind === 'dom-bridge.execute' && calls[0].output['button.new-chat']).toBe('click');
    const execCalls = calls.filter(c => c.kind === 'dom-bridge.execute');
    expect(execCalls[execCalls.length - 1].output['button.new-chat']).toBe('click');
  });

  it('fresh chat button: watch receives null snapshotText', async () => {
    const { deps, calls } = mkDeps(GEMINI_TABS, (msg) => {
      if (msg.kind === 'dom-bridge.execute') return okResponse({ written: 1 });
      if (msg.kind === 'dom-bridge.watch') return okResponse({ response: 'answer' });
      return null;
    });

    await createChatAdapter(deps)(mkResolvedFresh());

    const watchCall = calls.find(c => c.kind === 'dom-bridge.watch')!;
    if (watchCall.kind === 'dom-bridge.watch') {
      expect(watchCall.snapshotText).toBeNull();
    }
  });

  // ── Fresh chat via URL navigation (chat.new_url fallback) ──

  it('fresh chat URL: navigates, probes input, gets response', async () => {
    const navigated: string[] = [];
    const { deps, calls } = mkDeps(GEMINI_TABS, (msg) => {
      if (msg.kind === 'dom-bridge.execute') {
        if (msg.output['textarea.input'] === '_probe') return okResponse({ _probe: 'found' });
        return okResponse({ written: 1 });
      }
      if (msg.kind === 'dom-bridge.watch') return okResponse({ response: 'The answer is 4' });
      return null;
    });
    deps.navigateTab = async (_tabId, url) => { navigated.push(url); };

    const result = await createChatAdapter(deps)(mkResolvedFreshUrl());

    expect(result).toEqual({ response: 'The answer is 4' });
    expect(navigated).toEqual(['https://gemini.google.com/app']);
  });

  it('fresh chat URL: throws when input never appears (login required)', async () => {
    // Manually create deps — bypass the auto-probe handler so the
    // health check AND waitForElement both fail (simulating login page).
    const deps: ChatAdapterDeps = {
      queryTabs: async () => GEMINI_TABS,
      sendTabMessage: async (_tabId, msg) => {
        if (msg.kind === 'dom-bridge.execute') return okResponse({ _probe: null });
        return null;
      },
      navigateTab: async () => {},
    };

    await expect(createChatAdapter(deps)(mkResolvedFreshUrl()))
      .rejects.toThrow('logged in');
  });

  // ── No fresh chat declared → snapshot mode ──

  it('no chat.new or chat.new_url: falls back to snapshot mode', async () => {
    const { deps, calls } = mkDeps(GEMINI_TABS, (msg) => {
      if (msg.kind === 'dom-bridge.execute') {
        if (msg.output['.response:last-child'] === 'response') return okResponse({ response: 'existing' });
        return okResponse({ written: 1 });
      }
      if (msg.kind === 'dom-bridge.watch') return okResponse({ response: 'new answer' });
      return null;
    });

    // mkResolved() has no chat.new or chat.new_url
    const result = await createChatAdapter(deps)(mkResolved());
    expect(result).toEqual({ response: 'new answer' });
    // snapshot + write + submit + watch = 4 calls
    expect(calls.length).toBe(4);
  });

  // ── Conversation mode ──

  it('conversation mode: skips new-chat, uses snapshot, no cleanup click', async () => {
    const resolved = mkResolvedFresh();
    const { deps, calls } = mkDeps(GEMINI_TABS, (msg) => {
      if (msg.kind === 'dom-bridge.execute') {
        if (msg.output['.response:last-child'] === 'response') return okResponse({ response: 'prev answer' });
        return okResponse({ written: 1 });
      }
      if (msg.kind === 'dom-bridge.watch') return okResponse({ response: 'new answer' });
      return null;
    });

    const result = await createChatAdapter(deps)({
      ...resolved,
      input: { ...resolved.input, 'chat.mode': 'conversation' },
    });

    expect(result).toEqual({ response: 'new answer' });
    // snapshot + write + submit + watch = 4 calls (no new-chat click, no cleanup)
    const execCalls = calls.filter(c => c.kind === 'dom-bridge.execute');
    // No click calls — all execute calls should be snapshot/write/submit
    expect(execCalls.every(c => !c.output['button.new-chat'])).toBe(true);
  });

  // ── Audit logging ──

  it('emits audit entry after successful chat', async () => {
    const audits: unknown[] = [];
    const { deps } = mkDeps(GEMINI_TABS, (msg) => {
      if (msg.kind === 'dom-bridge.execute') return okResponse({ response: 'old' });
      if (msg.kind === 'dom-bridge.watch') return okResponse({ response: 'The answer' });
      return null;
    });
    deps.onAudit = (entry) => audits.push(entry);

    await createChatAdapter(deps)(mkResolved());

    expect(audits).toHaveLength(1);
    const entry = audits[0] as Record<string, unknown>;
    expect(entry.ingredient_slug).toBe('web-chat-gemini');
    expect(entry.success).toBe(true);
    expect(entry.mode).toBe('recipe');
    expect(typeof entry.duration_ms).toBe('number');
    expect(typeof entry.prompt_length).toBe('number');
    expect(typeof entry.response_length).toBe('number');
  });

  // ── Concurrency lock ──

  it('serializes concurrent calls (lock)', async () => {
    const callOrder: string[] = [];
    const { deps } = mkDeps(GEMINI_TABS, (msg) => {
      if (msg.kind === 'dom-bridge.execute') return okResponse({ response: 'old' });
      if (msg.kind === 'dom-bridge.watch') {
        callOrder.push('watch');
        return okResponse({ response: 'answer' });
      }
      return null;
    });

    // Fire two calls concurrently — second should wait for first
    const adapter = createChatAdapter(deps);
    const p1 = adapter(mkResolved());
    const p2 = adapter({ ...mkResolved(), slug: 'second-call' });

    await Promise.all([p1, p2]);
    // Both completed — the lock serialized them
    expect(callOrder).toHaveLength(2);
  });
});

// ────────────────────────────────────────────────────────────────
// Internal helpers — findChatTab
// ────────────────────────────────────────────────────────────────

describe('findChatTab', () => {
  const mkQueryDeps = (tabs: { id?: number; url?: string; active?: boolean }[]): ChatAdapterDeps => ({
    queryTabs: async () => tabs,
    sendTabMessage: async () => null,
  });

  it('returns null on empty tab list', async () => {
    expect(await findChatTab(mkQueryDeps([]), 'gemini.google.com/*')).toBe(null);
  });

  it('returns null when no tab URL matches the pattern', async () => {
    const deps = mkQueryDeps([{ id: 1, url: 'https://example.com' }]);
    expect(await findChatTab(deps, 'gemini.google.com/*')).toBe(null);
  });

  it('returns the tab id when a single background match exists', async () => {
    const deps = mkQueryDeps([{ id: 42, url: 'https://gemini.google.com/app', active: false }]);
    expect(await findChatTab(deps, 'gemini.google.com/*')).toBe(42);
  });

  it('prefers background tabs over active tabs so focus is not stolen', async () => {
    const deps = mkQueryDeps([
      { id: 1, url: 'https://gemini.google.com/app', active: true },
      { id: 2, url: 'https://gemini.google.com/app', active: false },
    ]);
    expect(await findChatTab(deps, 'gemini.google.com/*')).toBe(2);
  });

  it('falls back to the first match when all candidates are active', async () => {
    const deps = mkQueryDeps([
      { id: 10, url: 'https://gemini.google.com/app', active: true },
      { id: 11, url: 'https://gemini.google.com/app', active: true },
    ]);
    expect(await findChatTab(deps, 'gemini.google.com/*')).toBe(10);
  });
});

// ────────────────────────────────────────────────────────────────
// Internal helpers — prepareChatTab
// ────────────────────────────────────────────────────────────────

describe('prepareChatTab', () => {
  const SELECTORS: ChatSelectors = {
    target: 'gemini.google.com/*',
    newButton: null,
    newUrl: null,
    inputSelector: 'textarea.input',
    submitSelector: 'textarea.submit',
    responseSelector: '.response',
    loadingSelector: null,
  };
  const CONFIG: ChatConfig = { timeoutMs: 50, stabilizeMs: 10 };

  /** Scripted BridgeSender that replays queued responses in order.
   *  Each script entry matches one `sendBridge(...)` call. */
  const mkSender = (script: unknown[]): { sender: BridgeSender; calls: { input: Record<string, unknown>; output: Record<string, string> }[] } => {
    const calls: { input: Record<string, unknown>; output: Record<string, string> }[] = [];
    let i = 0;
    return {
      calls,
      sender: async (input, output) => {
        calls.push({ input, output });
        return script[i++];
      },
    };
  };

  it('conversation mode snapshots the existing response text', async () => {
    const { sender, calls } = mkSender([{ response: 'prior text' }]);
    const deps: ChatAdapterDeps = { queryTabs: async () => [], sendTabMessage: async () => null };

    const result = await prepareChatTab(deps, 1, mkResolved(), 'conversation', SELECTORS, CONFIG, sender);

    expect(result).toEqual({ snapshotText: 'prior text', didStartFreshChat: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].output).toEqual({ '.response': 'response' });
  });

  it('recipe + newButton click lands → clears conversation and reports fresh', async () => {
    const { sender, calls } = mkSender([
      { written: 1 },      // newButton click lands
      { response: null },   // probe: cleared immediately, loop breaks
    ]);
    const deps: ChatAdapterDeps = { queryTabs: async () => [], sendTabMessage: async () => null };
    const selectors: ChatSelectors = { ...SELECTORS, newButton: 'button.new-chat' };

    const result = await prepareChatTab(deps, 1, mkResolved(), 'recipe', selectors, CONFIG, sender);

    expect(result).toEqual({ snapshotText: null, didStartFreshChat: true });
    expect(calls[0].output).toEqual({ 'button.new-chat': 'click' });
    expect(calls[1].output).toEqual({ '.response': 'response' });
  });

  it('recipe + newUrl + navigateTab → navigates and reports fresh', async () => {
    const { sender } = mkSender([]);
    const navigations: { tabId: number; url: string }[] = [];
    const deps: ChatAdapterDeps = {
      queryTabs: async () => [],
      // waitForElement probes via sendTabMessage directly — return a hit on
      // the first probe so the ready check resolves fast.
      sendTabMessage: async () => ({ ok: true, data: { _probe: 'found' } }),
      navigateTab: async (tabId, url) => { navigations.push({ tabId, url }); },
    };
    const selectors: ChatSelectors = { ...SELECTORS, newUrl: 'gemini.google.com/app' };

    const result = await prepareChatTab(deps, 7, mkResolved(), 'recipe', selectors, CONFIG, sender);

    expect(result).toEqual({ snapshotText: null, didStartFreshChat: true });
    expect(navigations).toEqual([{ tabId: 7, url: 'https://gemini.google.com/app' }]);
  });

  it('recipe + no newButton + no newUrl → falls back to snapshot', async () => {
    const { sender, calls } = mkSender([{ response: 'keep-diff-against-this' }]);
    const deps: ChatAdapterDeps = { queryTabs: async () => [], sendTabMessage: async () => null };

    const result = await prepareChatTab(deps, 1, mkResolved(), 'recipe', SELECTORS, CONFIG, sender);

    expect(result).toEqual({ snapshotText: 'keep-diff-against-this', didStartFreshChat: false });
    expect(calls).toHaveLength(1);
  });

  it('throws DOM_SELECTOR_NOT_FOUND when newUrl nav finishes but input never appears', async () => {
    const { sender } = mkSender([]);
    const deps: ChatAdapterDeps = {
      queryTabs: async () => [],
      // Every probe misses — waitForElement exhausts attempts and returns false.
      sendTabMessage: async () => ({ ok: true, data: { _probe: null } }),
      navigateTab: async () => { /* succeeds */ },
    };
    const selectors: ChatSelectors = { ...SELECTORS, newUrl: 'gemini.google.com/app' };
    // Tight timeout so waitForElement exhausts quickly (timeout_ms / probe_interval_ms probes).
    const resolved = mkResolved({ input: { ...mkResolved().input, 'chat.timeout_ms': 30 } });

    await expect(prepareChatTab(deps, 1, resolved, 'recipe', selectors, CONFIG, sender))
      .rejects.toThrow(/Chat input not found on/);
  });

  it('recipe + newButton click misses → falls through to newUrl branch', async () => {
    // Button click returns with written falsy → adapter should try newUrl next.
    const { sender, calls } = mkSender([
      { written: 0 },     // click missed
    ]);
    const navigations: string[] = [];
    const deps: ChatAdapterDeps = {
      queryTabs: async () => [],
      sendTabMessage: async () => ({ ok: true, data: { _probe: 'found' } }),
      navigateTab: async (_tabId, url) => { navigations.push(url); },
    };
    const selectors: ChatSelectors = {
      ...SELECTORS,
      newButton: 'button.new-chat',
      newUrl: 'gemini.google.com/app',
    };
    const result = await prepareChatTab(deps, 9, mkResolved(), 'recipe', selectors, CONFIG, sender);
    expect(result.didStartFreshChat).toBe(true);
    expect(navigations).toEqual(['https://gemini.google.com/app']);
    // Only the missed click landed on the bridge sender; the rest goes through
    // the deps.sendTabMessage probe path above.
    expect(calls).toHaveLength(1);
  });

  it('recipe + newUrl but no navigateTab provided → snapshots instead of navigating', async () => {
    const { sender } = mkSender([{ response: 'still here' }]);
    const deps: ChatAdapterDeps = { queryTabs: async () => [], sendTabMessage: async () => null };
    const selectors: ChatSelectors = { ...SELECTORS, newUrl: 'gemini.google.com/app' };
    // No navigateTab on deps → the newUrl branch is skipped; falls through to snapshot.
    const result = await prepareChatTab(deps, 1, mkResolved(), 'recipe', selectors, CONFIG, sender);
    expect(result).toEqual({ snapshotText: 'still here', didStartFreshChat: false });
  });

  it('recipe + newUrl already has http:// prefix → passed verbatim', async () => {
    const { sender } = mkSender([]);
    const navigations: string[] = [];
    const deps: ChatAdapterDeps = {
      queryTabs: async () => [],
      sendTabMessage: async () => ({ ok: true, data: { _probe: 'found' } }),
      navigateTab: async (_tabId, url) => { navigations.push(url); },
    };
    const selectors: ChatSelectors = { ...SELECTORS, newUrl: 'http://already.example/app' };
    await prepareChatTab(deps, 1, mkResolved(), 'recipe', selectors, CONFIG, sender);
    expect(navigations).toEqual(['http://already.example/app']);
  });
});

// ────────────────────────────────────────────────────────────────
// Full adapter — verifyInputReady recovery paths (health-check)
// ────────────────────────────────────────────────────────────────

describe('createChatAdapter — verifyInputReady recovery', () => {
  it('throws DOM_SELECTOR_NOT_FOUND when input probe fails and no navigateTab is configured', async () => {
    // The flow: findTab ok → prepareChatTab (snapshot) ok → verifyInputReady probes
    // and the probe misses. Without navigateTab on deps, no refresh is possible.
    const deps: ChatAdapterDeps = {
      queryTabs: async () => GEMINI_TABS,
      sendTabMessage: async (_tabId, msg) => {
        if (msg.kind !== 'dom-bridge.execute') return null;
        // Snapshot call (looks up chat.response) succeeds.
        if (msg.output['.response:last-child'] === 'response') return okResponse({ response: 'old' });
        // All probe calls return a miss so health check fails.
        if (Object.values(msg.output).includes('_probe')) return okResponse({ _probe: null });
        return okResponse({ written: 1 });
      },
      // No navigateTab configured.
    };
    await expect(createChatAdapter(deps)(mkResolved()))
      .rejects.toThrow(/may need a refresh or login/);
  });

  it('refreshes the tab and succeeds when probe misses but input appears after refresh', async () => {
    // First probe (verifyInputReady health check) fails, then the adapter
    // refreshes and probes succeed, and the remaining flow completes.
    let probesSeen = 0;
    const deps: ChatAdapterDeps = {
      queryTabs: async () => GEMINI_TABS,
      sendTabMessage: async (_tabId, msg) => {
        if (msg.kind === 'dom-bridge.watch') return okResponse({ response: 'final answer' });
        if (msg.kind !== 'dom-bridge.execute') return null;
        if (msg.output['.response:last-child'] === 'response') return okResponse({ response: 'old' });
        if (Object.values(msg.output).includes('_probe')) {
          probesSeen++;
          // First probe (health check) misses; subsequent probes succeed.
          return okResponse({ _probe: probesSeen === 1 ? null : 'found' });
        }
        return okResponse({ written: 1 });
      },
      navigateTab: async () => { /* success */ },
    };
    const result = await createChatAdapter(deps)(mkResolved());
    expect(result).toEqual({ response: 'final answer' });
  });

  it('falls through when currentUrl cannot be resolved (tab closed during health check)', async () => {
    let tabsQueried = 0;
    const deps: ChatAdapterDeps = {
      queryTabs: async () => {
        tabsQueried++;
        // First call (findChatTab) returns the tab. Second call (inside
        // verifyInputReady) returns an empty list so currentUrl is undefined
        // → the function returns without throwing.
        return tabsQueried === 1 ? GEMINI_TABS : [];
      },
      sendTabMessage: async (_tabId, msg) => {
        if (msg.kind === 'dom-bridge.watch') return okResponse({ response: 'done' });
        if (msg.kind !== 'dom-bridge.execute') return null;
        if (msg.output['.response:last-child'] === 'response') return okResponse({ response: 'old' });
        if (Object.values(msg.output).includes('_probe')) return okResponse({ _probe: null });
        return okResponse({ written: 1 });
      },
      navigateTab: async () => { /* ignored */ },
    };
    const result = await createChatAdapter(deps)(mkResolved());
    expect(result).toEqual({ response: 'done' });
  });
});
