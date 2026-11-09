/** D-335 slice B — a held browser click or typing names its element the way
 *  the page shows it, never the way a model described it.
 *
 *  The real run holds the step and, while it builds the checkpoint, asks the
 *  Bridge to describe the element (a stub dispatcher answering `describe`); the
 *  real ask is raised from that checkpoint, as a restart re-raises it; the real
 *  card resolver reads its rows. The Bridge's own `describe` is pinned in real
 *  Chrome by `bridge-page-inspect-browser.test.ts`. */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_DESCRIBE_OUTPUT_KEYS,
  BRIDGE_PAGE_CHANGED_MESSAGE,
  BRIDGE_PAGE_GONE_MESSAGE,
  isCheckpoint, type BridgeResult, type Checkpoint, type Commit, type ExecutionSource, type RecipeDefinition,
} from '@recued/contracts';
import { PREFLIGHT_HANDLER_KIND } from '@recued/gateway';
import { createAuditLogStore, createCommitStore, createInMemoryCollection, type ActivityEntry, type AuditEntry } from '@recued/storage';
import type { PendingAsk } from '@recued/notification';

import { createAskCardDetailResolver } from '../ask-card-held-op-details.js';
import type { BatchApprovalCoordinator } from '../batch-approval.js';
import { browserPassOfferFor } from '../browser-passes.js';
import type { BridgeDispatcher, DispatchOutcome, DispatchRequest } from '../bridges/dispatcher.js';
import {
  describeHeldBrowserTarget,
  heldBrowserTargetRefusal,
  heldBrowserValueLabels,
} from '../bridges/dom-adapter.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createOpAdmissionGate } from '../op-admission-gate.js';
import { createContractOverlayResolver } from '../policy-contract-overlay.js';
import { createRecipeStore } from '../recipe-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createContractScanFn, createContractStore } from '../storage/contract-store.js';
import { createBrowserPassStore, type BrowserPassStore } from '../storage/browser-pass-store.js';
import { createBrowserFiles, type BrowserFiles } from '../bridges/browser-files.js';

/** The owner's own chat: the Browser Toolkit's first caller. */
const owner = {
  channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'owner-1', turn_id: 'turn-1',
} as ExecutionSource;
const TARGET = '*://mail.google.com/*';
const PAGE = '7:ABCDEF0123';

const described = (outputs: Record<string, unknown>): DispatchOutcome => ({
  kind: 'completed', bridge_client_token_id: 'bridge-1', attempts: 1,
  result: { command_id: 'c', duration_ms: 3, bridge_version: '0.0.3', idempotency_key_seen: false, status: 'ok',
    outputs: { page: PAGE, url: 'https://mail.google.com/mail/u/0/#inbox', title: 'Inbox', ...outputs } } as BridgeResult,
});

const manifestsWithKernel = () => {
  const manifests = createManifestRegistry('/nonexistent');
  for (const manifest of KERNEL_MANIFESTS) manifests.register(manifest);
  return manifests;
};

/** Run one browser step for the owner; return the response, the checkpoints
 *  written, the asks' texts, and what the Bridge was asked. */
const run = async (step: Record<string, unknown>, dispatch?: BridgeDispatcher['dispatch'], browserPasses?: BrowserPassStore,
  extra: Partial<ExecuteHandlerDeps> = {},
  /** D-335 slice AP/AQ — the owner's files, for a download kept and an upload named. */
  browserFiles?: BrowserFiles) => {
  const recipe = {
    recipe_id: 'browser-step', version: 1, ttl: 60,
    metadata: { name: 'Browser step', description: 'One step on a page.', author: 'test', supported_platforms: ['test'] },
    variables: {}, prefetch_steps: [], steps: [{ id: 'act', ...step }], output: { sidebar: [] },
  } as unknown as RecipeDefinition;
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);
  const checkpoints: Checkpoint[] = [];
  const asks: string[] = [];
  const sent = vi.fn<BridgeDispatcher['dispatch']>(dispatch ?? (async () => described({})));
  // The admission a server composes (`wire-execute-deps.ts`), with no grants:
  // the owner's default, where a write asks.
  const contractStore = createContractStore(new Database(':memory:'));
  const definitionStore = createContractDefinitionStore(contractStore);
  const grantEntryStore = createContractGrantEntryStore(contractStore);
  const deps: ExecuteHandlerDeps = {
    recipeStore,
    opAdmissionGate: createOpAdmissionGate({ grantEntryStore, definitionStore }),
    contractOverlay: createContractOverlayResolver({ definitionStore, grantEntryStore }),
    contractScan: createContractScanFn(contractStore),
    executorConfig: {
      manifests: manifestsWithKernel(),
      bridgeDispatcherRef: () => ({ dispatch: sent, cancel: vi.fn(), canResolve: vi.fn(() => false) }),
      ...(browserFiles !== undefined ? { browserFiles } : {}),
    },
    baseVault: {},
    instanceId: 'held-browser-target',
    checkpointStore: {
      write: vi.fn(async (cp: Checkpoint) => { checkpoints.push(cp); }),
    } as unknown as ExecuteHandlerDeps['checkpointStore'],
    auditLog: createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>()),
    ...(browserPasses !== undefined ? { browserPasses } : {}),
    preflightNotifier: {
      ask: vi.fn(async (message: { text: string }) => { asks.push(message.text); return { ask_id: 'ask-1' }; }),
      registerAskHandler: vi.fn(),
      notify: vi.fn(async () => undefined),
    },
    ...extra,
  };
  const response = await handleExecute(deps, { recipe_id: recipe.recipe_id, trigger_source: 'chat', execution_source: owner });
  return { response, checkpoints, asks, asked: sent.mock.calls.map(([request]) => request) };
};

/** Run one held browser step for the owner; return the checkpoint, the ask's
 *  text, and what the Bridge was asked. */
const hold = async (step: Record<string, unknown>, dispatch?: BridgeDispatcher['dispatch'], browserPasses?: BrowserPassStore) => {
  const { response, checkpoints, asks, asked } = await run(step, dispatch, browserPasses);
  expect(response.awaiting_approval, JSON.stringify(response.errors)).toBe(true);
  expect(checkpoints).toHaveLength(1);
  return { checkpoint: checkpoints[0]!, text: asks.at(-1)!, asked };
};

/** The Bridge's answer to `describe` for an element it could not read. */
const unreadable = (message: string): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'bridge-1', attempts: 1,
  result: { command_id: 'c', duration_ms: 3, bridge_version: '0.0.3', idempotency_key_seen: false, status: 'error',
    error: { code: 'selector_not_found', message } } as BridgeResult });

/** The card's rows for the held run, as `notification.pending_asks` serves them. */
const cardRows = async (checkpoint: Checkpoint) => createAskCardDetailResolver({
  getCheckpoint: async (id) => (id === checkpoint.checkpoint_id ? checkpoint : null),
  getAnchor: async () => ({ commit_status: 'awaiting_approval', recipe_id: checkpoint.recipe_id } as AuditEntry),
  resolveArgEditSchema: () => ({ fields: [] }),
  timeZone: 'UTC',
})({ ask_id: 'ask-1', handler_kind: PREFLIGHT_HANDLER_KIND,
  handler_payload: { checkpoint_id: checkpoint.checkpoint_id } } as unknown as PendingAsk);

const CLICK = { op: 'core.dom.click', args: { target: TARGET, page: PAGE, ref: 'e12' } };
const TYPE = (value: string) => ({ op: 'core.dom.write', args: { target: TARGET, page: PAGE, ref: 'e5', value } });

describe('D-335 slice B — a held browser step names its element as the page shows it', () => {
  it('a click: the Bridge is asked about the element, and the ask names it and says it cannot be undone', async () => {
    const { checkpoint, text, asked } = await hold(CLICK, async () => described({ role: 'button', label: 'Send', protected: false }));
    expect(asked).toEqual([expect.objectContaining({ action: 'describe', args: { page: PAGE, ref: 'e12' },
      expects_output_keys: [...BRIDGE_DESCRIBE_OUTPUT_KEYS], target_domain_pattern: TARGET })]);
    expect(checkpoint.preflight_context?.browser_target).toEqual({ site: 'mail.google.com', title: 'Inbox',
      role: 'button', label: 'Send', protected: false, origin: 'https://mail.google.com' });
    expect(isCheckpoint(checkpoint)).toBe(true);
    // Line 2 stays the consequence: the approval card reads it from there.
    expect(text.split('\n')[1]).toBe('Write actions change data outside Recued, so Recued held it for you.');
    expect(text).toContain('\n\nOn “Inbox” (mail.google.com), this clicks the button “Send”. A click cannot be undone.');
    const rows = await cardRows(checkpoint);
    expect(rows).toContainEqual(expect.objectContaining({ value: '“Inbox” (mail.google.com)' }));
    expect(rows).toContainEqual(expect.objectContaining({ value: 'button “Send”' }));
  });

  // D-335 slice U — a key pressed in place of a click: the ask names the key and the element.
  it('a key: the Bridge is asked about the element, and the ask names the key and says what it does cannot be undone', async () => {
    const { checkpoint, text, asked } = await hold({ op: 'core.dom.click', args: { target: TARGET, page: PAGE, ref: 'e12', key: 'enter' } },
      async () => described({ role: 'text box', label: 'Message', protected: false }));
    expect(asked).toEqual([expect.objectContaining({ action: 'describe', args: { page: PAGE, ref: 'e12' } })]);
    expect(text).toContain('\n\nOn “Inbox” (mail.google.com), this presses Enter in the text box “Message”. '
      + 'What the key does there cannot be undone.');
    expect(await cardRows(checkpoint)).toContainEqual(expect.objectContaining({ value: 'text box “Message”' }));
  });

  it('typing: the ask names the field and quotes the whole text', async () => {
    const { text, asked } = await hold(TYPE('Thanks,\nAda'),
      async () => described({ role: 'text field', label: 'To', protected: false }));
    // The element, never the text it would type.
    expect(asked[0]!.args).toEqual({ page: PAGE, ref: 'e5' });
    expect(text).toContain('\n\nOn “Inbox” (mail.google.com), this types into the text field “To”. The text:\n"Thanks,\\nAda"');
  });

  /** D-335 slice N — typing that then picks one of the field's suggestions: the ask names it, and
   *  the read of the element carries neither the text nor the suggestion. */
  it('typing that picks a suggestion: the ask names the suggestion after the text', async () => {
    const { text, asked } = await hold({ op: 'core.dom.write', args: { target: TARGET, page: PAGE, ref: 'e5', value: 'Acme',
      pick: 'Acme Corp' } }, async () => described({ role: 'text field', label: 'Company', protected: false }));
    expect(asked[0]!.args).toEqual({ page: PAGE, ref: 'e5' });
    expect(text).toContain('\n\nOn “Inbox” (mail.google.com), this types into the text field “Company”. The text:\n"Acme"\n'
      + 'It then picks “Acme Corp” from its suggestions.');
  });

  it('typing into a password, sign-in code or card field: the text is shown nowhere', async () => {
    const { checkpoint, text } = await hold(TYPE('hunter2'),
      async () => described({ role: 'password field', label: 'Password', protected: true }));
    expect(text).toContain('this types into the password field “Password”. The text is not shown here');
    expect(text).not.toContain('hunter2');
    const rows = await cardRows(checkpoint);
    expect(rows).toContainEqual(expect.objectContaining({
      value: 'Not shown: the field is for a password, a sign-in code or a card' }));
    expect(JSON.stringify(rows)).not.toContain('hunter2');
  });

  it('a Bridge that cannot reach the page costs the description, never the hold', async () => {
    const { checkpoint, text } = await hold(CLICK, async () => ({ kind: 'capacity_gap',
      capacity_gap: { kind: 'bridge_online' }, reason: 'bridge_online', attempts: 0 }));
    expect(checkpoint.preflight_context?.browser_target).toEqual({ site: 'mail.google.com',
      unread: 'no Browser Bridge can reach that page' });
    expect(text).toContain('\n\nOn mail.google.com, this clicks ref e12. It could not be shown here: '
      + 'no Browser Bridge can reach that page. A click cannot be undone.');
  });

  // Slice D — the Browser Toolkit's calls are on every site (`*://*/*`): the
  // site is the page's, and an unread ask names none rather than the pattern.
  it('a Browser Toolkit click: the site is the page the Bridge read', async () => {
    const { checkpoint, text, asked } = await hold({ op: 'core.dom.click', args: { target: '*://*/*', page: PAGE, ref: 'e12' } },
      async () => described({ role: 'button', label: 'Send', protected: false }));
    expect(asked[0]!.target_domain_pattern).toBe('*://*/*');
    expect(checkpoint.preflight_context?.browser_target).toMatchObject({ site: 'mail.google.com' });
    expect(text).toContain('\n\nOn “Inbox” (mail.google.com), this clicks the button “Send”. A click cannot be undone.');
  });

  it('a Browser Toolkit click the Bridge could not read names no site, never the pattern', async () => {
    const { checkpoint, text } = await hold({ op: 'core.dom.click', args: { target: '*://*/*', page: PAGE, ref: 'e12' } },
      async () => ({ kind: 'capacity_gap', capacity_gap: { kind: 'bridge_online' }, reason: 'bridge_online', attempts: 0 }));
    expect(checkpoint.preflight_context?.browser_target).toEqual({ site: '', unread: 'no Browser Bridge can reach that page' });
    expect(text).toContain('\n\nIn your browser, this clicks ref e12. It could not be shown here: '
      + 'no Browser Bridge can reach that page. A click cannot be undone.');
    expect(text).not.toContain('*');
  });

  // Slice C — an opened page has no element yet; the address is what matters.
  it('opening a page: the ask shows the whole address, and the Bridge is not asked', async () => {
    const url = 'https://mail.google.com/mail/u/0/?q=from:bob';
    const { checkpoint, text, asked } = await hold({ op: 'core.dom.open', args: { target: TARGET, address: url } });
    expect(asked).toEqual([]);
    expect(checkpoint.preflight_context?.browser_target).toBeUndefined();
    expect(text.split('\n')[1]).toBe('Write actions change data outside Recued, so Recued held it for you.');
    expect(text).toContain(`\n\nThis opens a new tab in your browser at this address:\n"${url}"`);
  });

  it('an element the Bridge could not find by selector still asks, and says so: it may yet appear', async () => {
    const { checkpoint, text } = await hold({ op: 'core.dom.click', args: { target: TARGET, page: PAGE, selector: '#send' } },
      async () => unreadable('No element on the page matches the selector.'));
    expect(checkpoint.preflight_context?.browser_target).toEqual({ site: 'mail.google.com',
      unread: 'No element on the page matches the selector.' });
    expect(text).toContain('It could not be shown here: No element on the page matches the selector.');
  });
});

describe('2026-11-04 — a held browser write whose page or element has gone is not asked', () => {
  it('a ref whose element has gone: the run fails with the Bridge\'s words, and nothing is held or asked', async () => {
    const { response, checkpoints, asks, asked } = await run(CLICK, async () => unreadable(BRIDGE_PAGE_CHANGED_MESSAGE));
    expect(response.awaiting_approval).toBeUndefined();
    expect(response.success).toBe(false);
    expect(response.errors).toEqual([expect.objectContaining({ code: 'DOM_SELECTOR_NOT_FOUND',
      message: BRIDGE_PAGE_CHANGED_MESSAGE, source: expect.objectContaining({ step_id: 'act' }) })]);
    expect(checkpoints).toEqual([]);
    expect(asks).toEqual([]);
    // The element was read, once; nothing was clicked.
    expect(asked.map((request) => request.action)).toEqual(['describe']);
  });

  it('a page handle whose page has gone: the same, and the model is sent to the tabs', async () => {
    const { response, checkpoints, asks, asked } = await run(TYPE('Thanks'), async () => unreadable(BRIDGE_PAGE_GONE_MESSAGE));
    expect(response.success).toBe(false);
    expect(response.errors).toEqual([expect.objectContaining({ code: 'DOM_SELECTOR_NOT_FOUND',
      message: expect.stringContaining('list the tabs for its current page handle') })]);
    expect(checkpoints).toEqual([]);
    expect(asks).toEqual([]);
    expect(asked.map((request) => request.action)).toEqual(['describe']);
  });

  it('with passes on, the element is still read once, for the pass and the refusal', async () => {
    const passes = createBrowserPassStore(new Database(':memory:'));
    const { response, asks, asked } = await run({ op: 'core.dom.click', args: { target: '*://*/*', page: PAGE, ref: 'e12' } },
      async () => unreadable(BRIDGE_PAGE_CHANGED_MESSAGE), passes);
    expect(response.success).toBe(false);
    expect(asks).toEqual([]);
    expect(asked).toHaveLength(1);
  });
});

describe('describeHeldBrowserTarget', () => {
  const manifests = { get: (slug: string) => KERNEL_MANIFESTS.find(manifest => manifest.slug === slug) ?? null };
  const call = (dispatch: BridgeDispatcher['dispatch'] | undefined, slug = 'dom-click', input: unknown = CLICK.args) =>
    describeHeldBrowserTarget({ manifests, slug, input, run_id: 'run-1', step_id: 'act', timeoutMs: 20,
      dispatcher: dispatch === undefined ? undefined : { dispatch, cancel: vi.fn(), canResolve: vi.fn(() => false) } });

  it('waits a bounded time for the Bridge, then says it did not answer', async () => {
    expect(await call(() => new Promise<DispatchOutcome>(() => undefined))).toEqual({ site: 'mail.google.com',
      unread: 'the Browser Bridge did not answer in time' });
  });

  it('names an unconnected or outdated Bridge, or one not allowed on the site', async () => {
    expect(await call(undefined)).toEqual({ site: 'mail.google.com', unread: 'no Browser Bridge is connected' });
    expect(await call(async () => ({ kind: 'capacity_gap', capacity_gap: { kind: 'permission_missing', permission: TARGET },
      reason: 'site_not_granted', attempts: 0 }))).toEqual({ site: 'mail.google.com',
      unread: 'the Browser Bridge is not allowed on that site' });
    expect(await call(async () => ({ kind: 'capacity_gap', capacity_gap: { kind: 'bridge_online' },
      reason: 'bridge_update_required', attempts: 0 }))).toEqual({ site: 'mail.google.com',
      unread: 'the Browser Bridge needs an update to show it' });
  });

  it('asks nothing for a call that is not a browser write, and a fresh read every time', async () => {
    const dispatch = vi.fn<BridgeDispatcher['dispatch']>(async () => described({ role: 'link', label: 'Next', protected: false }));
    expect(await call(dispatch, 'mail-send', { to: ['bob@example.com'] })).toBeUndefined();
    expect(await call(dispatch, 'dom-inspect', { target: TARGET })).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
    await call(dispatch);
    await call(dispatch);
    const keys = dispatch.mock.calls.map(([request]) => (request as DispatchRequest).idempotency_key);
    expect(new Set(keys).size).toBe(2);
  });

  it('marks a page or an element gone for good, and nothing else', async () => {
    expect(await call(async () => unreadable(BRIDGE_PAGE_CHANGED_MESSAGE))).toEqual({ site: 'mail.google.com',
      unread: BRIDGE_PAGE_CHANGED_MESSAGE, gone: true });
    expect(await call(async () => unreadable(BRIDGE_PAGE_GONE_MESSAGE))).toEqual({ site: 'mail.google.com',
      unread: BRIDGE_PAGE_GONE_MESSAGE, gone: true });
    expect(await call(async () => unreadable('No element on the page matches the selector.'))).toEqual({
      site: 'mail.google.com', unread: 'No element on the page matches the selector.' });
    expect(await call(async () => ({ kind: 'completed', bridge_client_token_id: 'bridge-1', attempts: 1,
      result: { command_id: 'c', duration_ms: 3, bridge_version: '0.0.3', idempotency_key_seen: false, status: 'error',
        error: { code: 'unknown', message: BRIDGE_PAGE_CHANGED_MESSAGE } } as BridgeResult })))
      .toEqual({ site: 'mail.google.com', unread: BRIDGE_PAGE_CHANGED_MESSAGE });
  });

  it('refuses with the error the write would fail with once approved, only for a read marked gone', () => {
    const refusal = heldBrowserTargetRefusal('dom-click', { site: '', unread: BRIDGE_PAGE_GONE_MESSAGE, gone: true });
    expect(refusal).toMatchObject({ code: 'DOM_SELECTOR_NOT_FOUND', message: BRIDGE_PAGE_GONE_MESSAGE });
    expect(heldBrowserTargetRefusal('dom-click', { site: '', unread: BRIDGE_PAGE_GONE_MESSAGE })).toBeUndefined();
    expect(heldBrowserTargetRefusal('dom-click', { site: 'mail.google.com', title: 'Inbox', role: 'button', label: 'Send',
      protected: false })).toBeUndefined();
    expect(heldBrowserTargetRefusal('dom-click', undefined)).toBeUndefined();
  });

  it('labels the page, the element and a protected value for the card', () => {
    const read = { site: 'mail.google.com', title: 'Inbox', role: 'password field', label: 'Password', protected: true };
    expect(heldBrowserValueLabels(read, { page: PAGE, ref: 'e5', value: 'hunter2' })).toEqual({
      page: { [PAGE]: '“Inbox” (mail.google.com)' },
      ref: { e5: 'password field “Password”' },
      value: { hunter2: 'Not shown: the field is for a password, a sign-in code or a card' },
    });
    expect(heldBrowserValueLabels({ site: 'mail.google.com', unread: 'no Browser Bridge is connected' }, CLICK.args))
      .toBeUndefined();
  });
});

describe('D-335 slice J — a held sequence names each step as the page shows it, in one ask', () => {
  const ACT = (steps: unknown[]) => ({ op: 'core.dom.act', args: { target: '*://*/*', page: PAGE, steps } });
  const SIGN_IN = [
    { do: 'type', ref: 'e3', value: 'ada@example.com' },
    { do: 'type', ref: 'e5', value: 'hunter2', submit: true },
  ];
  const EMAIL = { role: 'text box', label: 'Email', protected: false };
  const PASSWORD = { role: 'password box', label: 'Password', protected: true };
  /** The Bridge's `describe`, answered by the element a request names. */
  const byElement = (elements: Record<string, Record<string, unknown> | DispatchOutcome>) =>
    async (request: DispatchRequest): Promise<DispatchOutcome> => {
      const found = elements[String(request.args.ref ?? request.args.selector)];
      if (found === undefined) return unreadable('No element on the page matches the selector.');
      return 'kind' in found ? found as DispatchOutcome : described(found);
    };

  it('a sign-in: the email quoted, the password never shown, and one ask for both', async () => {
    const { checkpoint, text, asked } = await hold(ACT(SIGN_IN), byElement({ e3: EMAIL, e5: PASSWORD }));
    // Each element read, never the text typed into it.
    expect(asked.map((request) => [request.action, request.args])).toEqual([
      ['describe', { page: PAGE, ref: 'e3' }], ['describe', { page: PAGE, ref: 'e5' }]]);
    expect(checkpoint.preflight_context?.browser_target).toEqual({ site: 'mail.google.com', title: 'Inbox',
      ...EMAIL, origin: 'https://mail.google.com', steps: [EMAIL, PASSWORD] });
    expect(isCheckpoint(checkpoint)).toBe(true);
    expect(text.split('\n')[1]).toBe('Write actions change data outside Recued, so Recued held it for you.');
    expect(text).toContain('\n\nOn “Inbox” (mail.google.com), this does 2 steps in your browser, in order:\n'
      + '1. Types into the text box “Email”:\n"ada@example.com"\n'
      + '2. Types into the password box “Password”, then sends its form. The text is not shown here, because the field is '
      + 'for a password, a sign-in code or a card.\n'
      + 'A click or a sent form cannot be undone. It stops at the first step that does not work.');
    expect(text).not.toContain('hunter2');
    const rows = await cardRows(checkpoint);
    expect(rows).toContainEqual(expect.objectContaining({ value: '2 steps, listed in the ask' }));
    expect(JSON.stringify(rows)).not.toContain('hunter2');
  });

  it('slice U — a key pressed in a sequence is a step of its own, named with its element', async () => {
    const MESSAGE = { role: 'text box', label: 'Message', protected: false };
    const { text } = await hold(ACT([{ do: 'type', ref: 'e3', value: 'Hello' }, { do: 'press', ref: 'e3', key: 'enter' }]),
      byElement({ e3: MESSAGE }));
    expect(text).toContain('\n\nOn “Inbox” (mail.google.com), this does 2 steps in your browser, in order:\n'
      + '1. Types into the text box “Message”:\n"Hello"\n2. Presses Enter in the text box “Message”.\n'
      + 'A click or a sent form cannot be undone. It stops at the first step that does not work.');
  });

  it('after a step that may load a new page, a step by selector is not read here, and its text is not shown', async () => {
    const steps = [
      { do: 'type', ref: 'e3', value: 'ada@example.com', submit: true },
      { do: 'wait', selector: '#password' },
      { do: 'type', selector: '#password', value: 'hunter2', submit: true },
      { do: 'click', ref: 'e9' },
    ];
    const { text, asked } = await hold(ACT(steps), byElement({ e3: EMAIL, e9: { role: 'button', label: 'Next', protected: false },
      // On this page, the selector names another field: the ask must not name it.
      '#password': { role: 'text box', label: 'Search', protected: false } }));
    expect(asked.map((request) => request.args.ref ?? request.args.selector)).toEqual(['e3', 'e9']);
    expect(text).toContain('in order:\n1. Types into the text box “Email”, then sends its form:\n"ada@example.com"\n'
      + '2. Waits for “#password” to show.\n'
      + '3. Types into “#password”, which could not be shown here (it is on the page as step 1 leaves it, which cannot be read '
      + 'before then), then sends its form. The text is not shown here, because the field could not be read to tell whether '
      + 'it is for a password.\n'
      + '4. Clicks the button “Next”.\n');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('Search');
  });

  /** ⛔ The shape a live model sent most (6 of 9 refused sequences), its kind under "type":
   *  refused until 2026-11-04, now held and asked like the same step under "do". */
  it('a step whose kind comes as "type" is held and listed as one under "do"', async () => {
    const search = { role: 'search box', label: 'Search Wikipedia', protected: false };
    const { text, asked } = await hold(ACT([{ type: 'type', ref: 'e4', value: 'Ada Lovelace', submit: true }]),
      byElement({ e4: search }));
    expect(asked.map((request) => [request.action, request.args])).toEqual([['describe', { page: PAGE, ref: 'e4' }]]);
    expect(text).toContain('this does 1 step in your browser, in order:\n'
      + '1. Types into the search box “Search Wikipedia”, then sends its form:\n"Ada Lovelace"\n');
  });

  /** D-335 slice L — the suggestion it picks, by the text the model gave, after the typing; a pick
   *  may load a new page, so a step by selector after it is not read here. */
  it('a pick names the suggestion after the typing, and a step by selector after it is not read', async () => {
    const company = { role: 'text field', label: 'Company', protected: false };
    const { text, asked } = await hold(ACT([
      { do: 'type', ref: 'e3', value: 'Acme', pick: 'Acme Corp' },
      { do: 'click', selector: '#save' },
    ]), byElement({ e3: company, '#save': { role: 'button', label: 'Save', protected: false } }));
    expect(asked.map((request) => request.args.ref ?? request.args.selector)).toEqual(['e3']);
    expect(text).toContain('this does 2 steps in your browser, in order:\n'
      + '1. Types into the text field “Company”, then picks “Acme Corp” from its suggestions:\n"Acme"\n'
      + '2. Clicks “#save”, which could not be shown here (it is on the page as step 1 leaves it, which cannot be read '
      + 'before then).\n'
      + 'A click or a sent form cannot be undone.');
    // With a send after it, the ask says both.
    const sent = await hold(ACT([{ do: 'type', ref: 'e3', value: 'Acme', pick: 'Acme Corp', submit: true }]),
      byElement({ e3: company }));
    expect(sent.text).toContain('1. Types into the text field “Company”, then picks “Acme Corp” from its suggestions and sends '
      + 'its form:\n"Acme"\n');
  });

  it('a step whose element has gone fails the run before anything is asked or done', async () => {
    const { response, checkpoints, asks, asked } = await run(ACT(SIGN_IN),
      byElement({ e3: EMAIL, e5: unreadable(BRIDGE_PAGE_CHANGED_MESSAGE) }));
    expect(response.success).toBe(false);
    expect(response.errors).toEqual([expect.objectContaining({ code: 'DOM_SELECTOR_NOT_FOUND',
      message: `Step 2: ${BRIDGE_PAGE_CHANGED_MESSAGE}` })]);
    expect(checkpoints).toEqual([]);
    expect(asks).toEqual([]);
    expect(asked.map((request) => request.action)).toEqual(['describe', 'describe']);
  });

  it('steps that cannot run fail with the run\'s own error, before the Bridge or the owner is asked', async () => {
    const { response, checkpoints, asks, asked } = await run(ACT([SIGN_IN[0], { do: 'click' }]),
      byElement({ e3: EMAIL }));
    expect(response.success).toBe(false);
    expect(response.errors).toEqual([expect.objectContaining({ code: 'DOM_SELECTOR_MISSING',
      message: 'core.dom.act: step 2: name the element by ref, by selector or by text, one of them' })]);
    expect(checkpoints).toEqual([]);
    expect(asks).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('typing only, with nothing clicked or sent, says nothing about undoing', async () => {
    const { text } = await hold(ACT([SIGN_IN[0], { do: 'wait', seconds: 2 }]), byElement({ e3: EMAIL }));
    expect(text).toContain('2. Waits 2 seconds.\nIt stops at the first step that does not work.');
    expect(text).not.toContain('cannot be undone');
  });

  it('a sequence asks on its own, offering a pass for its recipe on the page\'s site', async () => {
    const passes = createBrowserPassStore(new Database(':memory:'));
    const { checkpoint, text } = await hold(ACT(SIGN_IN), byElement({ e3: EMAIL, e5: PASSWORD }), passes);
    expect(checkpoint.preflight_context?.browser_pass).toMatchObject({
      key: { principal: { kind: 'owner_chat' }, recipe: 'browser-step', site: 'https://mail.google.com' } });
    expect(text).toContain('“Always allow on mail.google.com” stops asking about');
  });

  it('never joins a batched ask, which would list its raw steps: a click there does, as the control', async () => {
    const batches = () => ({
      registerHold: vi.fn<BatchApprovalCoordinator['registerHold']>(async () => ({ kind: 'registered' as const,
        ask_id: 'batch-ask-1', approval_ref: 'batch-1' })),
      reconcileOpenBatch: vi.fn<BatchApprovalCoordinator['reconcileOpenBatch']>(async () => ({ kind: 'not_open' as const })),
      hooks: { handleAnswer: vi.fn(async () => 'handled' as const) },
    }) as unknown as BatchApprovalCoordinator & { registerHold: ReturnType<typeof vi.fn> };
    // Batching is the commit gateway's: a server composes both.
    const commitStore = () => createCommitStore(createInMemoryCollection<Commit>());
    const click = batches();
    await run({ op: 'core.dom.click', args: { target: '*://*/*', page: PAGE, ref: 'e12' } },
      async () => described({ role: 'button', label: 'Send', protected: false }), undefined,
      { batchApprovals: click, commitStore: commitStore() });
    expect(click.registerHold).toHaveBeenCalledTimes(1);
    const sequence = batches();
    const { asks } = await run(ACT(SIGN_IN), byElement({ e3: EMAIL, e5: PASSWORD }), undefined,
      { batchApprovals: sequence, commitStore: commitStore() });
    expect(sequence.registerHold).not.toHaveBeenCalled();
    expect(asks).toHaveLength(1);
    expect(asks[0]).toContain('this does 2 steps in your browser');
    expect(asks[0]).not.toContain('hunter2');
  });

  it('reads every element at once: a Bridge that does not answer costs one wait, not one a step', async () => {
    const manifests = { get: (slug: string) => KERNEL_MANIFESTS.find(manifest => manifest.slug === slug) ?? null };
    const started: number[] = [];
    const dispatch = vi.fn<BridgeDispatcher['dispatch']>(async (request) => {
      started.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 40));
      return described(request.args.ref === 'e5' ? PASSWORD : EMAIL);
    });
    const read = await describeHeldBrowserTarget({ manifests, slug: 'dom-act', input: ACT([...SIGN_IN, { do: 'click', ref: 'e7' }]).args,
      run_id: 'run-1', step_id: 'act', timeoutMs: 1_000,
      dispatcher: { dispatch, cancel: vi.fn(), canResolve: vi.fn(() => false) } });
    expect(read).toMatchObject({ steps: [EMAIL, PASSWORD, EMAIL] });
    expect(started).toHaveLength(3);
    expect(Math.max(...started) - Math.min(...started)).toBeLessThan(30);
    // Steps that cannot run are not read at all.
    expect(await describeHeldBrowserTarget({ manifests, slug: 'dom-act', input: ACT([]).args, run_id: 'run-1', step_id: 'act',
      dispatcher: { dispatch, cancel: vi.fn(), canResolve: vi.fn(() => false) } })).toBeUndefined();
    expect(dispatch).toHaveBeenCalledTimes(3);
  });
});

describe('D-335 slice F — a held browser write offers a pass on its site', () => {
  const passes = () => createBrowserPassStore(new Database(':memory:'));

  it('a click: who, the recipe and the page\'s origin, read once for the pass and the ask', async () => {
    const { checkpoint, text, asked } = await hold({ op: 'core.dom.click', args: { target: '*://*/*', page: PAGE, ref: 'e12' } },
      async () => described({ role: 'button', label: 'Send', protected: false }), passes());
    expect(checkpoint.preflight_context?.browser_pass).toEqual({
      key: { principal: { kind: 'owner_chat' }, recipe: 'browser-step', site: 'https://mail.google.com' },
      host: 'mail.google.com', channel_session_id: 'chat:chat-1' });
    expect(isCheckpoint(checkpoint)).toBe(true);
    expect(asked).toHaveLength(1);
    expect(text).toContain('“Always allow on mail.google.com” stops asking about them in all your chats');
  });

  it('opening a page: the site is the address\'s, and the Bridge is not asked', async () => {
    const { checkpoint, asked } = await hold({ op: 'core.dom.open',
      args: { target: TARGET, address: 'https://mail.google.com/mail/u/0/?q=from:bob' } }, undefined, passes());
    expect(asked).toEqual([]);
    expect(checkpoint.preflight_context?.browser_pass).toMatchObject({
      key: { site: 'https://mail.google.com' }, host: 'mail.google.com' });
  });

  it('a page the Bridge could not read names no site, so the ask offers no pass', async () => {
    const { checkpoint, text } = await hold({ op: 'core.dom.click', args: { target: '*://*/*', page: PAGE, ref: 'e12' } },
      async () => ({ kind: 'capacity_gap', capacity_gap: { kind: 'bridge_online' }, reason: 'bridge_online', attempts: 0 }),
      passes());
    expect(checkpoint.preflight_context?.browser_pass).toBeUndefined();
    expect(text).not.toContain('Always allow');
  });

  it('a pass names the owner\'s chats or one AI app, and no other caller', () => {
    const at = { recipe_id: 'click-web-element', site: 'https://github.com', channel_session_id: 'x' };
    const sources: Array<[ExecutionSource, unknown]> = [
      [owner, { kind: 'owner_chat' }],
      [{ channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' } as ExecutionSource, { kind: 'owner_chat' }],
      [{ channel: 'mcp', actor: 'contracted_user', contract_id: 'ct-1', mcp_token_id: 't' } as ExecutionSource,
        { kind: 'ai_app', contract_id: 'ct-1' }],
      [{ ...owner, contract_id: 'ct-household' } as ExecutionSource, undefined],
      [{ channel: 'schedule', actor: 'system', cron: '0 9 * * *', source_recipe: 'r' } as ExecutionSource, undefined],
    ];
    for (const [source, principal] of sources) {
      expect(browserPassOfferFor({ ...at, source })?.key.principal, JSON.stringify(source)).toEqual(principal);
    }
    expect(browserPassOfferFor({ ...at, source: owner, site: undefined })).toBeUndefined();
    expect(browserPassOfferFor({ ...at, source: owner, channel_session_id: undefined })).toBeUndefined();
  });
});

describe('D-335 slice X — a batch across tabs: what asks, and how the ask lists it', () => {
  const WIKI = { page: '21:WIKI', url: 'https://en.wikipedia.org/wiki/Ada_Lovelace', title: 'Ada Lovelace' };
  const MAIL = { page: '22:MAIL', url: 'https://mail.google.com/mail/u/0/#inbox', title: 'Inbox' };
  const BATCH = (steps: unknown[]) => ({ op: 'core.dom.act', args: { target: '*://*/*', steps } });
  const completed = (outputs: Record<string, unknown>): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'bridge-1',
    attempts: 1, result: { command_id: 'c', duration_ms: 3, bridge_version: '0.0.8', idempotency_key_seen: false, status: 'ok',
      outputs } as BridgeResult });
  const page = (tab: typeof WIKI) => completed({ ...tab, html: `<main><h1>${tab.title}</h1></main>`, truncated: false });

  it('only reads, on tabs already open: it runs without an ask, nothing held, the reads answered per tab', async () => {
    const passes = createBrowserPassStore(new Database(':memory:'));
    // The pass seam is the commit gateway's, which a server composes with its commit store.
    const { response, checkpoints, asks, asked } = await run(BATCH([
      { url: WIKI.url, do: 'read', find: 'See also' }, { url: MAIL.url, do: 'read' },
    ]), async (request) => request.action === 'list_tabs' ? completed({ tabs: [WIKI, MAIL], truncated: false })
      : page(request.args.page === WIKI.page ? WIKI : MAIL), passes, { commitStore: createCommitStore(createInMemoryCollection<Commit>()) });
    expect(response.awaiting_approval ?? false).toBe(false);
    expect(response.success, JSON.stringify(response.errors)).toBe(true);
    expect(checkpoints).toHaveLength(0);
    expect(asks).toHaveLength(0);
    // The tabs listed once to tell that they are open, then once by the run; nothing written.
    expect(asked.map((request) => request.action).sort()).toEqual(['inspect', 'inspect', 'list_tabs', 'list_tabs']);
  });

  it('types on one site after reading another: one ask, its steps under each tab, a pass offered for that site', async () => {
    const passes = createBrowserPassStore(new Database(':memory:'));
    const { checkpoint, text } = await hold(BATCH([
      { url: WIKI.url, do: 'read' },
      { url: MAIL.url, do: 'type', ref: 'e3', value: 'Ada' },
    ]), async (request) => request.action === 'list_tabs' ? completed({ tabs: [WIKI, MAIL], truncated: false })
      : described({ role: 'text box', label: 'Search mail', protected: false }), passes);
    expect(text).toContain('This does 2 steps in your browser, in order:\n'
      + 'On “Ada Lovelace” (en.wikipedia.org):\n1. Reads the page.\n'
      + 'On “Inbox” (mail.google.com):\n2. Types into the text box “Search mail”:\n"Ada"\n'
      + 'It stops at the first step that does not work.');
    // A read changes nothing: the batch acts on one site, whose pass could stand in for its ask.
    expect(checkpoint.preflight_context?.browser_pass).toMatchObject({ key: { site: 'https://mail.google.com' } });
  });

  it('acts on two sites: one ask, and no pass offered, since one site\'s pass could not stand in for it', async () => {
    const passes = createBrowserPassStore(new Database(':memory:'));
    const { checkpoint, text } = await hold(BATCH([
      { url: WIKI.url, do: 'click', ref: 'e7' },
      { url: MAIL.url, do: 'type', ref: 'e3', value: 'Ada' },
    ]), async (request) => request.action === 'list_tabs' ? completed({ tabs: [WIKI, MAIL], truncated: false })
      : request.args.page === WIKI.page ? described({ page: WIKI.page, url: WIKI.url, title: WIKI.title, role: 'link', label: 'Edit',
        protected: false })
        : described({ role: 'text box', label: 'Search mail', protected: false }), passes);
    expect(text).toContain('On “Ada Lovelace” (en.wikipedia.org):\n1. Clicks the link “Edit”.\n'
      + 'On “Inbox” (mail.google.com):\n2. Types into the text box “Search mail”:\n"Ada"\n'
      + 'A click or a sent form cannot be undone.');
    expect(checkpoint.preflight_context?.browser_pass).toBeUndefined();
    expect(text).not.toContain('Always allow on');
  });

  // D-335 slice AD — an ask sends the page's text to a model: in a batch that asks, it is listed.
  it('a question for a tab, in a batch that types, is listed in the ask with the question in full', async () => {
    const passes = createBrowserPassStore(new Database(':memory:'));
    const { text } = await hold(BATCH([
      { url: WIKI.url, do: 'ask', question: 'Who designed it?' },
      { url: MAIL.url, do: 'type', ref: 'e3', value: 'Ada' },
    ]), async (request) => request.action === 'list_tabs' ? completed({ tabs: [WIKI, MAIL], truncated: false })
      : described({ role: 'text box', label: 'Search mail', protected: false }), passes);
    expect(text).toContain('On “Ada Lovelace” (en.wikipedia.org):\n'
      + '1. Has a separate AI answer from the page\'s text: “Who designed it?”.\n'
      + 'On “Inbox” (mail.google.com):\n2. Types into the text box “Search mail”:\n"Ada"\n');
  });

  it('a tab to open makes even a batch of reads ask, the address in full', async () => {
    const passes = createBrowserPassStore(new Database(':memory:'));
    const { text } = await hold(BATCH([{ url: 'https://news.ycombinator.com/', do: 'read' }]),
      async () => completed({ tabs: [WIKI], truncated: false }), passes);
    expect(text).toContain('This does 1 step in your browser, in order:\nIn a new tab at "https://news.ycombinator.com/":\n'
      + '1. Reads the page.\nIt stops at the first step that does not work.');
  });

  it('a tab open when the batch was let through and closed before its step: it stops, opening nothing', async () => {
    const passes = createBrowserPassStore(new Database(':memory:'));
    let listings = 0;
    const { response, asks, asked } = await run(BATCH([{ url: WIKI.url, do: 'read' }]), async (request) => {
      if (request.action === 'list_tabs') {
        listings += 1;
        return completed({ tabs: listings === 1 ? [WIKI] : [], truncated: false });
      }
      return page(WIKI);
    }, passes, { commitStore: createCommitStore(createInMemoryCollection<Commit>()) });
    expect(asks).toHaveLength(0);
    expect(response.success).toBe(false);
    expect(JSON.stringify(response.errors)).toContain('this batch ran without an ask, which opens no tab');
    expect(asked.map((request) => request.action)).toEqual(['list_tabs', 'list_tabs']);
  });
});

describe('D-335 slice Y — a held step that names its element by its text', () => {
  const HTML = '<main><form><input ref="e1" type="search" aria-label="Search mail"><button ref="e2">Search</button></form>'
    + '<div><button ref="e7">Archive</button><button ref="e8">Delete</button></div></main>';
  /** The Bridge: the page's HTML for a read, and each element as the page shows it for a `describe`. */
  const bridge = (page: string) => async (request: DispatchRequest): Promise<DispatchOutcome> => request.action === 'inspect'
    ? described({ page, html: HTML, truncated: false })
    : described({ page, ...({ e1: { role: 'search box', label: 'Search mail', protected: false },
      e7: { role: 'button', label: 'Archive', protected: false } } as Record<string, Record<string, unknown>>)[String(request.args.ref)] });
  // Each its own page: what a hold reads is kept for the run that follows, server-wide.
  const ACT = (page: string, steps: unknown[]) => ({ op: 'core.dom.act', args: { target: TARGET, page, steps } });

  it('a click by text: the page read, the element it names described, and the ask naming it as the page shows it', async () => {
    const page = '31:YCLICK';
    const { text, asked } = await hold({ op: 'core.dom.click', args: { target: TARGET, page, text: 'archive' } }, bridge(page));
    expect(asked.map((request) => [request.action, request.args.ref ?? null])).toEqual([['inspect', null], ['describe', 'e7']]);
    expect(text).toContain('\n\nOn “Inbox” (mail.google.com), this clicks the button “Archive”. A click cannot be undone.');
  });

  it('two steps by text on one page: the page read once for both', async () => {
    const page = '31:YTWO';
    const { text, asked } = await hold(ACT(page, [{ do: 'type', text: 'Search mail', value: 'invoice' },
      { do: 'press', text: 'Search mail', role: 'field', key: 'Enter' }]), bridge(page));
    expect(asked.map((request) => [request.action, request.args.ref ?? null])).toEqual([
      ['inspect', null], ['describe', 'e1'], ['describe', 'e1']]);
    expect(text).toContain('1. Types into the search box “Search mail”:\n"invoice"\n2. Presses Enter in the search box “Search mail”.');
  });

  it('after a step that may load a new page, a step by text is named by its text; one naming nothing says why', async () => {
    const page = '31:YMOVE';
    const { text, asked } = await hold(ACT(page, [{ do: 'click', text: 'Archive' }, { do: 'click', text: 'Undo', role: 'button' },
    ]), bridge(page));
    expect(asked.map((request) => [request.action, request.args.ref ?? null])).toEqual([['inspect', null], ['describe', 'e7']]);
    expect(text).toContain('1. Clicks the button “Archive”.\n2. Clicks the button “Undo”, which could not be shown here (it is on '
      + 'the page as step 1 leaves it, which cannot be read before then).');
    const none = '31:YNONE';
    const missing = await hold(ACT(none, [{ do: 'click', text: 'Sign up' }]), bridge(none));
    expect(missing.text).toContain('Clicks “Sign up”, which could not be shown here (nothing a person can act on is called '
      + '“Sign up” on the page)');
  });
});

describe('D-335 slice Z — a held step that types a secret names its kind, never a value', () => {
  const ACT = (steps: unknown[]) => ({ op: 'core.dom.act', args: { target: TARGET, page: PAGE, steps } });
  it('a password and a sign-in code: what each is and where it goes, with no value to show', async () => {
    const { text } = await hold(ACT([
      { do: 'type', ref: 'e3', value: 'ada@example.com' },
      { do: 'type', ref: 'e5', secret: 'password', submit: true },
      { do: 'type', selector: '#otp', secret: 'sign-in code', submit: true },
    ]), async (request) => described(request.args.ref === 'e3' ? { role: 'text box', label: 'Email', protected: false }
      : { role: 'password box', label: 'Password', protected: true }));
    expect(text).toContain('1. Types into the text box “Email”:\n"ada@example.com"\n'
      + '2. Types your password into the password box “Password”, then sends its form. Recued types the one you saved for this '
      + 'field on this site, or asks you for it when the step runs.\n'
      + '3. Types your sign-in code into “#otp”, which could not be shown here (it is on the page as step 2 leaves it, which '
      + 'cannot be read before then), then sends its form. Recued asks you for it when the step runs.');
  });
});

describe('D-341 slice A — the owner\'s chat with its switch on lets browser writes through', () => {
  const ok = (outputs: Record<string, unknown>): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'bridge-1',
    attempts: 1, result: { command_id: 'c', duration_ms: 3, bridge_version: '0.0.8', idempotency_key_seen: false, status: 'ok',
      outputs } as BridgeResult });
  const INBOX = { page: PAGE, url: 'https://mail.google.com/mail/u/0/#inbox', title: 'Inbox' };
  const HN = { page: '41:HN', url: 'https://news.ycombinator.com/', title: 'Hacker News' };
  const bridge = async (request: DispatchRequest): Promise<DispatchOutcome> => {
    switch (request.action) {
      case 'describe': return described({ role: 'button', label: 'Send', protected: false });
      case 'list_tabs': return ok({ tabs: [INBOX], truncated: false });
      case 'open_tab': return ok(HN);
      default: return ok({ clicked: 1, ...(request.args.page === HN.page ? HN : INBOX) });
    }
  };
  const commits = () => ({ commitStore: createCommitStore(createInMemoryCollection<Commit>()) });

  it('a click on a site nothing allowed runs without an ask while it is on, and asks again once it is off', async () => {
    const passes = createBrowserPassStore(new Database(':memory:'));
    passes.startRequestPass('chat:chat-1', Date.now());
    const on = await run({ op: 'core.dom.click', args: { target: '*://*/*', page: PAGE, ref: 'e12' } }, bridge, passes, commits());
    expect(on.response.awaiting_approval ?? false).toBe(false);
    expect(on.response.success, JSON.stringify(on.response.errors)).toBe(true);
    expect(on.checkpoints).toHaveLength(0);
    expect(passes.requestPass('chat:chat-1', Date.now())?.uses).toBe(1);
    passes.endRequestPass('chat:chat-1', Date.now());
    const off = await run({ op: 'core.dom.click', args: { target: '*://*/*', page: PAGE, ref: 'e12' } }, bridge, passes, commits());
    expect(off.response.awaiting_approval).toBe(true);
  });

  it('a batch it lets through may open a tab on another site', async () => {
    const passes = createBrowserPassStore(new Database(':memory:'));
    passes.startRequestPass('chat:chat-1', Date.now());
    const { response, checkpoints, asked } = await run({ op: 'core.dom.act', args: { target: '*://*/*', steps: [
      { url: INBOX.url, do: 'click', ref: 'e12' }, { url: HN.url, do: 'click', ref: 'e1' },
    ] } }, bridge, passes, commits());
    expect(response.success, JSON.stringify(response.errors)).toBe(true);
    expect(checkpoints).toHaveLength(0);
    expect(asked.map((request) => request.action)).toContain('open_tab');
  });
});

// D-335 slices AP and AQ (2026-11-07) — a batch that saves a file a page links to, and one that puts one of
// the owner's files into a page. The owner: "for #4 and #5 it should be generic".
describe('D-335 slices AP and AQ — files in a held batch', () => {
  const ok = (outputs: Record<string, unknown>): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'bridge-1',
    attempts: 1, result: { command_id: 'c', duration_ms: 3, bridge_version: '0.0.8', idempotency_key_seen: false, status: 'ok',
      outputs } as BridgeResult });
  const PDF = Buffer.from('%PDF-1.4 A statement for October.');
  const REF = `file:${'a'.repeat(32)}`;
  const owners = () => {
    const kept: string[] = [];
    const files = createBrowserFiles(() => ({
      ingest: async (input) => { kept.push(input.filename); return { record_id: REF, hot_fields: { filename: input.filename } }; },
      readBytes: async () => ({ bytes: PDF, mime_type: 'application/pdf', filename: 'october.pdf' }),
      get: (id) => (id === REF ? { hot_fields: { filename: 'october.pdf', mime_type: 'application/pdf', size: PDF.length } } : null),
    }));
    return { files, kept };
  };
  const ACT = (steps: unknown[]) => ({ op: 'core.dom.act', args: { target: '*://*/*', page: PAGE, steps } });
  const bridge = async (request: DispatchRequest): Promise<DispatchOutcome> => {
    if (request.action === 'describe') {
      return described(request.args.ref === 'e5' ? { role: 'link', label: 'October statement', protected: false }
        : request.args.ref === 'e7' ? { role: 'file field', label: 'Statement', protected: false }
          : { role: 'button', label: 'Send', protected: false });
    }
    if (request.action === 'download_file') {
      return ok({ page: PAGE, url: 'https://mail.google.com/mail/u/0/#inbox', title: 'Inbox', address: 'https://mail.google.com/x.pdf',
        filename: 'october.pdf', mime_type: 'application/pdf', size: PDF.length, data: PDF.toString('base64') });
    }
    return ok({ clicked: 1, page: PAGE, url: 'https://mail.google.com/mail/u/0/#inbox', title: 'Inbox' });
  };

  it('a batch that only saves a file the page links to asks nothing, and keeps the file', async () => {
    const { files, kept } = owners();
    // As a server composes it: the pass seam lets a batch that only reads through.
    const passes = createBrowserPassStore(new Database(':memory:'));
    const commits = { commitStore: createCommitStore(createInMemoryCollection<Commit>()) };
    const { response, checkpoints } = await run(ACT([{ do: 'download', ref: 'e5' }]), bridge, passes, commits, files);
    expect(response.success, JSON.stringify(response.errors)).toBe(true);
    expect(checkpoints).toHaveLength(0);
    expect(kept).toEqual(['october.pdf']);
  });

  it('the ask lists a download by the link it follows, and an upload by the file that leaves, its name and size', async () => {
    const { files } = owners();
    const { text } = await hold(ACT([{ do: 'download', ref: 'e5' }, { do: 'upload', ref: 'e7', file: REF }, { do: 'click', ref: 'e12' }]),
      bridge, undefined);
    expect(text).toContain('1. Saves the file the link “October statement” links to among your files.\n'
      + `2. Puts your file ${REF} into the file field “Statement”, for the site to receive.\n3. Clicks the button “Send”.`);
    const named = await run(ACT([{ do: 'upload', ref: 'e7', file: REF }]), bridge, undefined, {}, files);
    expect(named.response.awaiting_approval).toBe(true);
    expect(named.asks.at(-1)).toContain('1. Puts your file “october.pdf” (33 bytes) into the file field “Statement”, for the site to receive.');
  });

  it('an upload is asked about with the conversation\'s switch on, which lets a click through', async () => {
    const { files } = owners();
    const passes = createBrowserPassStore(new Database(':memory:'));
    passes.startRequestPass('chat:chat-1', Date.now());
    const commits = { commitStore: createCommitStore(createInMemoryCollection<Commit>()) };
    const upload = await run(ACT([{ do: 'upload', ref: 'e7', file: REF }]), bridge, passes, commits, files);
    expect(upload.response.awaiting_approval).toBe(true);
    const click = await run(ACT([{ do: 'click', ref: 'e12' }]), bridge, passes, commits, files);
    expect(click.response.awaiting_approval ?? false).toBe(false);
  });
});

