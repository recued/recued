import { describe, expect, it, vi } from 'vitest';

import {
  CONTRACTS_PANEL_EMPTY_ATTR,
  CONTRACTS_PANEL_ERROR_ATTR,
  CONTRACTS_PANEL_HOST_ATTR,
  CONTRACTS_PANEL_LOADING_ATTR,
  CONTRACTS_PILL_ATTR,
  CONTRACTS_REVOKE_BUTTON_ATTR,
  CONTRACTS_REVOKE_CANCEL_ATTR,
  CONTRACTS_REVOKE_CONFIRM_ATTR,
  CONTRACTS_ROW_ATTR,
  CONTRACTS_ROW_ERROR_ATTR,
  mountContractsPanel,
  type ContractsListCaller,
  type ContractsRevokeCaller,
} from '../settings/contracts-panel.js';
import {
  type BroadcastListener,
  type BroadcastSubscriber,
} from '../realtime/subscriber.js';
import type {
  BroadcastEventKind,
  ContractDefinitionView,
  ServerEvent,
} from '@recued/contracts';

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  value: string;
  disabled: boolean;
  hidden: boolean;
  attrs: Map<string, string>;
  children: FakeEl[];
  listeners: Map<string, Array<(ev?: unknown) => void>>;
  parent: FakeEl | null;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: (ev?: unknown) => void): void;
  removeEventListener(type: string, fn: (ev?: unknown) => void): void;
  click(): void;
  remove(): void;
}

interface FakeDocument {
  createElement(tag: string): FakeEl;
}

const makeFakeElement = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    type: '',
    value: '',
    disabled: false,
    hidden: false,
    attrs: new Map(),
    children: [],
    listeners: new Map(),
    parent: null,
    get firstChild() {
      return el.children[0] ?? null;
    },
    setAttribute(k, v) {
      el.attrs.set(k, v);
      if (k === 'type') el.type = v;
      if (k === 'disabled') el.disabled = true;
    },
    removeAttribute(k) {
      el.attrs.delete(k);
      if (k === 'disabled') el.disabled = false;
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    hasAttribute(k) {
      return el.attrs.has(k);
    },
    appendChild(c) {
      el.children.push(c);
      c.parent = el;
      return c;
    },
    removeChild(c) {
      const i = el.children.indexOf(c);
      if (i < 0) throw new Error('removeChild: not a child');
      el.children.splice(i, 1);
      c.parent = null;
      return c;
    },
    addEventListener(type, fn) {
      const list = el.listeners.get(type) ?? [];
      list.push(fn);
      el.listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = el.listeners.get(type);
      if (list === undefined) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    click() {
      if (el.disabled || el.attrs.has('disabled')) return;
      for (const fn of el.listeners.get('click') ?? []) fn({ target: el });
    },
    remove() {
      if (el.parent) el.parent.removeChild(el);
    },
  };
  return el;
};

const makeFakeDocument = (): FakeDocument => ({
  createElement: makeFakeElement,
});

const collectByAttr = (
  root: FakeEl,
  attr: string,
  out: FakeEl[] = [],
): FakeEl[] => {
  if (root.attrs.has(attr)) out.push(root);
  for (const c of root.children) collectByAttr(c, attr, out);
  return out;
};

const collectByClass = (
  root: FakeEl,
  className: string,
  out: FakeEl[] = [],
): FakeEl[] => {
  if (root.className.split(/\s+/).includes(className)) out.push(root);
  for (const c of root.children) collectByClass(c, className, out);
  return out;
};

const allText = (root: FakeEl, acc: string[] = []): string[] => {
  if (root.textContent) acc.push(root.textContent);
  for (const c of root.children) allText(c, acc);
  return acc;
};

const onlyByAttr = (root: FakeEl, attr: string): FakeEl => {
  const matches = collectByAttr(root, attr);
  if (matches.length !== 1) {
    throw new Error(`expected one ${attr}, found ${matches.length}`);
  }
  return matches[0]!;
};

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const tick = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

const MINTED_AT = 1_714_867_200_000;
const REVOKED_AT = MINTED_AT + 60_000;

const contractView = (
  contract_id: string,
  over: Partial<ContractDefinitionView> = {},
): ContractDefinitionView => ({
  contract_id,
  minted_at: MINTED_AT,
  minted_by: 'Bob MacBook',
  display_name: `Contract ${contract_id}`,
  scope: {},
  lifecycle_state: 'active',
  ...over,
});

interface MountForOptions {
  contracts?: ReadonlyArray<ContractDefinitionView>;
  runListContracts?: ContractsListCaller;
  runRevokeContract?: ContractsRevokeCaller;
  // D-171 slice-2c follow-on #2 — the D-121 broadcast subscribe seam.
  subscribe?: BroadcastSubscriber['on'];
}

const mountFor = (opts: MountForOptions = {}) => {
  const doc = makeFakeDocument();
  const host = doc.createElement('div');

  const runListContracts = vi.fn<ContractsListCaller>();
  runListContracts.mockImplementation(
    opts.runListContracts
      ?? (async () => ({ contracts: opts.contracts ?? [] })),
  );

  const runRevokeContract = vi.fn<ContractsRevokeCaller>();
  runRevokeContract.mockImplementation(
    opts.runRevokeContract
      ?? (async ({ contract_id, reason }) => {
        const base =
          opts.contracts?.find((c) => c.contract_id === contract_id)
          ?? contractView(contract_id);
        return {
          ...base,
          revoked_at: REVOKED_AT,
          revocation_reason: reason ?? 'Revoked from Settings',
          lifecycle_state: 'revoked',
        };
      }),
  );

  // D-171 slice 3b — the standalone mint form is demoted (decision 7); the panel
  // is a read+revoke inventory + kill-switch inspector. Minting moved to the
  // #contracts MCP door Advanced sub-panel (tested in the permissions panel).
  const mount = mountContractsPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runListContracts,
    runRevokeContract,
    ...(opts.subscribe !== undefined ? { subscribe: opts.subscribe } : {}),
  });

  return {
    doc,
    host,
    mount,
    calls: {
      runListContracts,
      runRevokeContract,
    },
  };
};

const rowFor = (root: FakeEl, contractId: string): FakeEl | undefined =>
  collectByAttr(root, CONTRACTS_ROW_ATTR).find(
    (r) => r.getAttribute('data-contract-id') === contractId,
  );

const buttonFor = (
  root: FakeEl,
  attr: string,
  contractId: string,
): FakeEl | undefined =>
  collectByAttr(root, attr).find(
    (b) => b.getAttribute('data-contract-id') === contractId,
  );

const revokeButtonFor = (root: FakeEl, contractId: string): FakeEl | undefined =>
  buttonFor(root, CONTRACTS_REVOKE_BUTTON_ATTR, contractId);

const confirmButtonFor = (root: FakeEl, contractId: string): FakeEl | undefined =>
  buttonFor(root, CONTRACTS_REVOKE_CONFIRM_ATTR, contractId);

const cancelButtonFor = (root: FakeEl, contractId: string): FakeEl | undefined =>
  buttonFor(root, CONTRACTS_REVOKE_CANCEL_ATTR, contractId);

describe('D-166 Contracts panel', () => {
  it('loads to ready and renders server-ordered lifecycle rows with facets', async () => {
    const list = deferred<{ contracts: ContractDefinitionView[] }>();
    const revoked = contractView('ct_revoked', {
      display_name: 'Revoked session',
      lifecycle_state: 'revoked',
      revoked_at: REVOKED_AT,
      revocation_reason: 'operator stopped it',
      scope: {},
    });
    const active = contractView('ct_active', {
      display_name: 'Active scoped session',
      lifecycle_state: 'active',
      scope: {
        channels: ['mcp', 'chat'],
        actors: ['contracted_user'],
        ingredient_ids: ['gmail/inbox'],
      },
      expiry_at: MINTED_AT + 86_400_000,
      max_uses: 3,
      uses_remaining: 2,
    });
    const expired = contractView('ct_expired', {
      display_name: 'Expired connection session',
      lifecycle_state: 'expired',
      scope: { connection_names: ['gmail'] },
      expiry_at: MINTED_AT - 1,
    });
    const rows = [revoked, active, expired];
    const { host, mount, calls } = mountFor({
      runListContracts: () => list.promise,
    });

    expect(mount.getState()).toBe('loading');
    expect(collectByAttr(host, CONTRACTS_PANEL_HOST_ATTR)).toHaveLength(1);
    expect(collectByAttr(host, CONTRACTS_PANEL_LOADING_ATTR)).toHaveLength(1);

    list.resolve({ contracts: rows });
    await mount.whenLoaded();

    expect(mount.getState()).toBe('ready');
    expect(mount.getContracts()).toEqual(rows);
    expect(calls.runListContracts).toHaveBeenCalledTimes(1);

    const renderedRows = collectByAttr(host, CONTRACTS_ROW_ATTR);
    expect(renderedRows.map((r) => r.getAttribute('data-contract-id'))).toEqual([
      'ct_revoked',
      'ct_active',
      'ct_expired',
    ]);
    expect(renderedRows.map((r) => r.getAttribute('data-state'))).toEqual([
      'revoked',
      'active',
      'expired',
    ]);
    expect(onlyByAttr(rowFor(host, 'ct_revoked')!, CONTRACTS_PILL_ATTR).textContent).toBe('Revoked');
    expect(onlyByAttr(rowFor(host, 'ct_active')!, CONTRACTS_PILL_ATTR).textContent).toBe('Active');
    expect(onlyByAttr(rowFor(host, 'ct_expired')!, CONTRACTS_PILL_ATTR).textContent).toBe('Expired');

    const activeText = allText(rowFor(host, 'ct_active')!).join(' ');
    expect(activeText).toContain('channels: mcp, chat');
    expect(activeText).toContain('actors: contracted_user');
    expect(activeText).toContain('ingredients: gmail/inbox');
    expect(activeText).toContain('expires ');
    expect(activeText).toContain('uses 2/3');

    const revokedRow = rowFor(host, 'ct_revoked')!;
    const revokedText = allText(revokedRow).join(' ');
    expect(revokedText).toContain('Unrestricted scope');
    expect(revokedText).toContain('operator stopped it');
    expect(collectByClass(revokedRow, 'ct-revoked-line')).toHaveLength(1);
    expect(revokeButtonFor(host, 'ct_revoked')).toBeUndefined();
    expect(revokeButtonFor(host, 'ct_active')).toBeDefined();
    mount.dispose();
  });

  it('revokes through two-stage controls, reconciles, and supports the programmatic handle', async () => {
    const uiRow = contractView('ct_ui', { display_name: 'UI revocable' });
    const programRow = contractView('ct_program', { display_name: 'Program revocable' });
    const uiRevoked = contractView('ct_ui', {
      ...uiRow,
      lifecycle_state: 'revoked',
      revoked_at: REVOKED_AT,
      revocation_reason: 'Revoked from Settings',
    });
    const uiReconciled = contractView('ct_ui', {
      ...uiRevoked,
      display_name: 'UI reconciled',
    });
    const programRevoked = contractView('ct_program', {
      ...programRow,
      lifecycle_state: 'revoked',
      revoked_at: REVOKED_AT + 1,
      revocation_reason: 'manual revoke',
    });
    const relist = deferred<{ contracts: ContractDefinitionView[] }>();
    let listCall = 0;
    const { host, mount, calls } = mountFor({
      runListContracts: async () => {
        listCall += 1;
        if (listCall === 1) return { contracts: [uiRow, programRow] };
        if (listCall === 2) return relist.promise;
        return { contracts: [uiReconciled, programRevoked] };
      },
      runRevokeContract: async ({ contract_id }) => {
        if (contract_id === 'ct_ui') return uiRevoked;
        return programRevoked;
      },
    });
    await mount.whenLoaded();

    revokeButtonFor(host, 'ct_ui')!.click();
    expect(confirmButtonFor(host, 'ct_ui')).toBeDefined();
    expect(cancelButtonFor(host, 'ct_ui')).toBeDefined();
    cancelButtonFor(host, 'ct_ui')!.click();
    expect(calls.runRevokeContract).not.toHaveBeenCalled();
    expect(confirmButtonFor(host, 'ct_ui')).toBeUndefined();
    expect(revokeButtonFor(host, 'ct_ui')).toBeDefined();

    revokeButtonFor(host, 'ct_ui')!.click();
    confirmButtonFor(host, 'ct_ui')!.click();
    await tick();

    expect(calls.runRevokeContract).toHaveBeenCalledTimes(1);
    expect(calls.runRevokeContract.mock.calls[0]![0]).toEqual({
      contract_id: 'ct_ui',
    });
    expect(calls.runListContracts).toHaveBeenCalledTimes(2);
    expect(mount.getContracts()[0]).toEqual(uiRevoked);

    relist.resolve({ contracts: [uiReconciled, programRow] });
    await mount.whenLoaded();

    expect(mount.getContracts()).toEqual([uiReconciled, programRow]);
    expect(allText(rowFor(host, 'ct_ui')!).join(' ')).toContain('UI reconciled');
    expect(rowFor(host, 'ct_ui')!.getAttribute('data-state')).toBe('revoked');
    expect(revokeButtonFor(host, 'ct_ui')).toBeUndefined();

    await mount.revokeContract('ct_program', 'manual revoke');

    expect(calls.runRevokeContract).toHaveBeenCalledTimes(2);
    expect(calls.runRevokeContract.mock.calls[1]![0]).toEqual({
      contract_id: 'ct_program',
      reason: 'manual revoke',
    });
    expect(calls.runListContracts).toHaveBeenCalledTimes(3);
    expect(rowFor(host, 'ct_program')!.getAttribute('data-state')).toBe('revoked');
    expect(revokeButtonFor(host, 'ct_program')).toBeUndefined();
    mount.dispose();
  });

  it('surfaces a per-row revoke error and leaves the row intact', async () => {
    const row = contractView('ct_fail', { display_name: 'Still active' });
    const { host, mount, calls } = mountFor({
      contracts: [row],
      runRevokeContract: async () => {
        throw new Error('revoke denied');
      },
    });
    await mount.whenLoaded();

    await mount.revokeContract('ct_fail');

    expect(calls.runRevokeContract).toHaveBeenCalledTimes(1);
    expect(calls.runListContracts).toHaveBeenCalledTimes(1);
    expect(mount.getContracts()).toEqual([row]);
    expect(rowFor(host, 'ct_fail')!.getAttribute('data-state')).toBe('active');
    expect(revokeButtonFor(host, 'ct_fail')).toBeDefined();
    const errors = collectByAttr(rowFor(host, 'ct_fail')!, CONTRACTS_ROW_ERROR_ATTR);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.textContent).toContain('revoke denied');
    mount.dispose();
  });

  it('renders no mint form (D-171 slice 3b demotion) — read+revoke inventory only', async () => {
    // Decision 7: the standalone mint form is removed; minting moved to the
    // #contracts MCP door Advanced sub-panel. The panel still lists + revokes.
    const row = contractView('ct_read_only');
    const { host, mount, calls } = mountFor({ contracts: [row] });

    await mount.whenLoaded();

    expect(calls.runListContracts).toHaveBeenCalledTimes(1);
    expect(mount.getContracts()).toEqual([row]);
    // No mint-form DOM is present (the attrs are deleted, so assert by literal).
    expect(collectByAttr(host, 'data-recued-contracts-mint')).toHaveLength(0);
    expect(collectByAttr(host, 'data-recued-contracts-mint-name')).toHaveLength(0);
    expect(collectByAttr(host, 'data-recued-contracts-mint-save')).toHaveLength(0);
    // The revoke kill-switch inspector still works.
    expect(rowFor(host, 'ct_read_only')).toBeDefined();
    expect(revokeButtonFor(host, 'ct_read_only')).toBeDefined();
    mount.dispose();
  });

  it('surfaces list errors and recovers on a later refresh', async () => {
    const recovered = contractView('ct_recovered');
    let listCall = 0;
    const { host, mount, calls } = mountFor({
      runListContracts: async () => {
        listCall += 1;
        if (listCall === 1) throw new Error('list unavailable');
        return { contracts: [recovered] };
      },
    });

    await mount.whenLoaded();

    expect(mount.getState()).toBe('error');
    expect(mount.getListError()).toBe('list unavailable');
    expect(collectByAttr(host, CONTRACTS_PANEL_ERROR_ATTR)).toHaveLength(1);
    expect(collectByAttr(host, CONTRACTS_PANEL_ERROR_ATTR)[0]!.textContent).toContain(
      'list unavailable',
    );

    await mount.refresh();

    expect(calls.runListContracts).toHaveBeenCalledTimes(2);
    expect(mount.getState()).toBe('ready');
    expect(mount.getListError()).toBeNull();
    expect(collectByAttr(host, CONTRACTS_PANEL_ERROR_ATTR)).toHaveLength(0);
    expect(rowFor(host, 'ct_recovered')).toBeDefined();
    mount.dispose();
  });

  it('renders empty state and ignores a late list after dispose', async () => {
    const empty = mountFor({ contracts: [] });
    await empty.mount.whenLoaded();

    expect(empty.mount.getState()).toBe('ready');
    expect(collectByAttr(empty.host, CONTRACTS_PANEL_EMPTY_ATTR)).toHaveLength(1);
    empty.mount.dispose();

    const list = deferred<{ contracts: ContractDefinitionView[] }>();
    const row = contractView('ct_late');
    const { host, mount } = mountFor({
      runListContracts: () => list.promise,
    });

    expect(host.children).toHaveLength(1);
    mount.dispose();
    expect(host.children).toHaveLength(0);
    expect(() => mount.dispose()).not.toThrow();

    list.resolve({ contracts: [row] });
    await mount.whenLoaded();
    await tick();

    expect(host.children).toHaveLength(0);
    expect(mount.getState()).toBe('loading');
    expect(mount.getContracts()).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════
// D-171 slice-2c follow-on #2 — inbound-token broadcast subscription
// ════════════════════════════════════════════════════════════════

type AnyBroadcastListener = (event: ServerEvent) => void;

interface FakeSubscribeCall {
  kind: BroadcastEventKind;
  listener: AnyBroadcastListener;
  unsubscribeCalls: number;
}

/** A `BroadcastSubscriber['on']` fake — mirrors the packs / permissions broadcast
 *  tests: records registrations, fans `dispatch`/`fireStored`, tracks unsubscribes. */
const makeFakeSubscribe = (opts: { throwOnUnsubscribe?: boolean } = {}) => {
  const calls: FakeSubscribeCall[] = [];
  const listeners = new Map<BroadcastEventKind, Set<AnyBroadcastListener>>();
  const subscribe = (<K extends BroadcastEventKind>(
    kind: K,
    listener: BroadcastListener<K>,
  ): (() => void) => {
    const narrowed = listener as unknown as AnyBroadcastListener;
    const call: FakeSubscribeCall = { kind, listener: narrowed, unsubscribeCalls: 0 };
    calls.push(call);
    const set = listeners.get(kind) ?? new Set<AnyBroadcastListener>();
    set.add(narrowed);
    listeners.set(kind, set);
    return () => {
      call.unsubscribeCalls += 1;
      set.delete(narrowed);
      if (set.size === 0) listeners.delete(kind);
      if (opts.throwOnUnsubscribe) throw new Error(`unsubscribe failed for ${kind}`);
    };
  }) as BroadcastSubscriber['on'];
  const activeCount = (): number => {
    let total = 0;
    for (const set of listeners.values()) total += set.size;
    return total;
  };
  const dispatch = (event: ServerEvent): void => {
    const set = listeners.get(event.kind);
    if (!set) return;
    for (const listener of [...set]) listener(event);
  };
  const fireStored = (event: ServerEvent): void => {
    for (const call of calls) if (call.kind === event.kind) call.listener(event);
  };
  return { subscribe, calls, listeners, activeCount, dispatch, fireStored };
};

type InboundTokenOp = 'issue' | 'update_grants' | 'update_contract' | 'revoke' | 'delete';

const inboundTokenChangedEvent = (
  op: InboundTokenOp,
  cursor = 1,
): Extract<ServerEvent, { kind: 'chat.inbound_token_changed' }> => ({
  kind: 'chat.inbound_token_changed',
  op,
  token_id: 'door_live',
  record: null,
  cursor,
});

/** D-171 — the authoritative `contract_definition` lifecycle event the inspector
 *  re-lists off (replacing the `chat.inbound_token_changed` proxy). */
const contractDefinitionChangedEvent = (
  op: 'mint' | 'revoke',
  contract_id = 'ct_a',
  cursor = 1,
): Extract<ServerEvent, { kind: 'contract.contract_definition_changed' }> => ({
  kind: 'contract.contract_definition_changed',
  op,
  contract_id,
  cursor,
});

describe('D-171 slice-2c follow-on #2 — contracts inspector broadcast subscription', () => {
  it('subscribes to contract.contract_definition_changed on mount when subscribe is wired (D-171)', async () => {
    const fake = makeFakeSubscribe();
    const { mount } = mountFor({ subscribe: fake.subscribe });
    await mount.whenLoaded();
    await tick();

    // D-171 — the inspector keys off the authoritative contract kind, NOT the old
    // `chat.inbound_token_changed` proxy.
    expect(fake.listeners.get('contract.contract_definition_changed')?.size).toBe(1);
    expect(fake.calls.map((c) => c.kind)).toEqual(['contract.contract_definition_changed']);
    mount.dispose();
  });

  it('re-lists on every contract frame (mint / revoke); ignores token frames (D-171)', async () => {
    const fake = makeFakeSubscribe();
    const { mount, calls } = mountFor({
      contracts: [contractView('ct_a')],
      subscribe: fake.subscribe,
    });
    await mount.whenLoaded();
    await tick();
    const list0 = calls.runListContracts.mock.calls.length;

    // Token frames are NOT subscribed — a door grant storm never churns the
    // inventory (the inspector ignores them outright).
    fake.dispatch(inboundTokenChangedEvent('issue'));
    fake.dispatch(inboundTokenChangedEvent('update_contract'));
    await tick();
    expect(calls.runListContracts.mock.calls.length).toBe(list0);

    // Every contract frame re-lists — `mint`…
    fake.dispatch(contractDefinitionChangedEvent('mint'));
    await tick();
    expect(calls.runListContracts.mock.calls.length).toBe(list0 + 1);

    // …and `revoke`, INCLUDING the trailing bare `revokeContract` of a prior limit
    // that the old token proxy missed (the slice-2c follow-on #2 residual).
    fake.dispatch(contractDefinitionChangedEvent('revoke'));
    await tick();
    expect(calls.runListContracts.mock.calls.length).toBe(list0 + 2);

    mount.dispose();
  });

  it('dispose unsubscribes the broadcast handle', async () => {
    const fake = makeFakeSubscribe();
    const { mount } = mountFor({ subscribe: fake.subscribe });
    await mount.whenLoaded();

    mount.dispose();

    expect(fake.activeCount()).toBe(0);
    expect(fake.calls.map((c) => c.unsubscribeCalls)).toEqual([1]);
  });

  it('does not re-list after dispose when a stored listener still fires', async () => {
    const fake = makeFakeSubscribe();
    const { mount, calls } = mountFor({ subscribe: fake.subscribe });
    await mount.whenLoaded();
    await tick();
    const list0 = calls.runListContracts.mock.calls.length;

    mount.dispose();
    fake.fireStored(contractDefinitionChangedEvent('revoke'));
    await tick();

    expect(calls.runListContracts.mock.calls.length).toBe(list0);
  });

  it('dispose completes when the unsubscribe handle throws', async () => {
    const fake = makeFakeSubscribe({ throwOnUnsubscribe: true });
    const { mount } = mountFor({ subscribe: fake.subscribe });
    await mount.whenLoaded();

    expect(() => mount.dispose()).not.toThrow();
    expect(fake.activeCount()).toBe(0);
    expect(fake.calls.map((c) => c.unsubscribeCalls)).toEqual([1]);
  });

  it('stays on the re-list-after-write path when subscribe is unwired', async () => {
    const { mount, calls } = mountFor({ contracts: [contractView('ct_a')] });
    await mount.whenLoaded();
    // No subscribe wired — the panel mounted + listed once, no listener registered.
    expect(calls.runListContracts).toHaveBeenCalledTimes(1);
    mount.dispose();
  });
});
