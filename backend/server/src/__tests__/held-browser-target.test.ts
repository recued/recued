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
  isCheckpoint, type BridgeResult, type Checkpoint, type ExecutionSource, type RecipeDefinition,
} from '@recued/contracts';
import { PREFLIGHT_HANDLER_KIND } from '@recued/gateway';
import { createAuditLogStore, createInMemoryCollection, type ActivityEntry, type AuditEntry } from '@recued/storage';
import type { PendingAsk } from '@recued/notification';

import { createAskCardDetailResolver } from '../ask-card-held-op-details.js';
import type { BridgeDispatcher, DispatchOutcome, DispatchRequest } from '../bridges/dispatcher.js';
import {
  describeHeldBrowserTarget,
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

/** Run one held browser step for the owner; return the checkpoint, the ask's
 *  text, and what the Bridge was asked. */
const hold = async (step: Record<string, unknown>, dispatch?: BridgeDispatcher['dispatch']) => {
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
    preflightNotifier: {
      ask: vi.fn(async (message: { text: string }) => { asks.push(message.text); return { ask_id: 'ask-1' }; }),
      registerAskHandler: vi.fn(),
      notify: vi.fn(async () => undefined),
    },
  };
  const response = await handleExecute(deps, { recipe_id: recipe.recipe_id, trigger_source: 'chat', execution_source: owner });
  expect(response.awaiting_approval, JSON.stringify(response.errors)).toBe(true);
  expect(checkpoints).toHaveLength(1);
  return { checkpoint: checkpoints[0]!, text: asks.at(-1)!, asked: sent.mock.calls.map(([request]) => request) };
};

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
      role: 'button', label: 'Send', protected: false });
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

  it('a page that changed since it was inspected says so on the ask', async () => {
    const { text } = await hold(CLICK, async () => ({ kind: 'completed', bridge_client_token_id: 'bridge-1', attempts: 1,
      result: { command_id: 'c', duration_ms: 3, bridge_version: '0.0.3', idempotency_key_seen: false, status: 'error',
        error: { code: 'selector_not_found', message: 'The page changed since it was inspected: inspect it again.' } } }));
    expect(text).toContain('It could not be shown here: The page changed since it was inspected: inspect it again.');
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
