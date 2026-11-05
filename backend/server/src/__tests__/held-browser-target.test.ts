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
  extra: Partial<ExecuteHandlerDeps> = {}) => {
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
      message: 'core.dom.act: step 2: name the element by ref or by selector, one of the two' })]);
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
