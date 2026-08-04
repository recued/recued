import { describe, expect, it, vi } from 'vitest';

import {
  SUGGESTED_RULES_ACCEPT_ATTR,
  SUGGESTED_RULES_CANCEL_ATTR,
  SUGGESTED_RULES_CARD_ATTR,
  SUGGESTED_RULES_CARD_ERROR_ATTR,
  SUGGESTED_RULES_DISMISS_ATTR,
  SUGGESTED_RULES_DISMISS_CONFIRM_ATTR,
  SUGGESTED_RULES_DOOR_DISCLOSURE_ATTR,
  SUGGESTED_RULES_ERROR_ATTR,
  SUGGESTED_RULES_HEADING_ATTR,
  SUGGESTED_RULES_MINT_ATTR,
  SUGGESTED_RULES_PANEL_HOST_ATTR,
  SUGGESTED_RULES_TTL_INPUT_ATTR,
  SUGGESTED_RULES_USES_INPUT_ATTR,
  mountSuggestedRulesPanel,
  type SuggestionsAcceptCaller,
  type SuggestionsDismissCaller,
  type SuggestionsListCaller,
} from '../contracts/suggested-rules-panel.js';
import {
  CONTRACTS_GROUP_HEADER_ATTR,
  CONTRACTS_PANEL_HOST_ATTR,
  CONTRACTS_ROW_ATTR,
  mountContractsPanel,
  type ContractsListCaller,
  type ContractsRevokeCaller,
} from '../contracts/contracts-panel.js';
import {
  type BroadcastListener,
  type BroadcastSubscriber,
} from '../realtime/subscriber.js';
import {
  DELEGATION_RULE_MAX_USES,
  DELEGATION_RULE_TTL_MS,
  type BroadcastEventKind,
  type ContractDefinitionView,
  type DelegationRuleSuggestionEvidence,
  type DelegationRuleSuggestionRow,
  type DelegationRuleSuggestionSnapshot,
  type ServerEvent,
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

const DAY_MS = 24 * 60 * 60 * 1000;
const TTL_CEILING_DAYS = Math.floor(DELEGATION_RULE_TTL_MS / DAY_MS);
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

type SuggestionOverrides = Partial<
  Omit<DelegationRuleSuggestionRow, 'key_hash' | 'snapshot' | 'evidence'>
> & {
  snapshot?: Partial<DelegationRuleSuggestionSnapshot>;
  evidence?: Partial<DelegationRuleSuggestionEvidence>;
};

const suggestionRow = (
  key_hash: string,
  over: SuggestionOverrides = {},
): DelegationRuleSuggestionRow => {
  const { snapshot, evidence, ...rest } = over;
  return {
    key_hash,
    state: 'open',
    snapshot: {
      channel: 'mcp',
      actor: 'contracted_user',
      ingredient_id: 'mail.send',
      operation_id: 'mail.send',
      connection_name: 'gmail-primary',
      recipe_id: 'recipe-1',
      recipe_hash: 'recipe-hash-1',
      arg_shape_hash: 'arg-shape-hash',
      risk_tier: 'write',
      entity_scope: 'deal-1',
      grant_mode: 'exact',
      canonical_payload_hash: 'payload-hash',
      ...snapshot,
    },
    evidence: {
      row_count: 3,
      distinct_session_count: 3,
      consumed_uses: 3,
      sample_contract_ids: ['ct_s1', 'ct_s2', 'ct_s3'],
      first_minted_at: MINTED_AT,
      last_minted_at: MINTED_AT + 120_000,
      ...evidence,
    },
    created_at: MINTED_AT + 180_000,
    updated_at: MINTED_AT + 240_000,
    ...rest,
  };
};

interface MountSuggestedForOptions {
  suggestions?: ReadonlyArray<DelegationRuleSuggestionRow>;
  runListSuggestions?: SuggestionsListCaller;
  runAcceptSuggestion?: SuggestionsAcceptCaller;
  runDismissSuggestion?: SuggestionsDismissCaller;
  subscribe?: BroadcastSubscriber['on'];
  /** Absent ⇒ NO contracts caller is wired at all (the door facet falls back to
   *  the raw id — the pre-resolution rendering, still pinned below). */
  runListContracts?: () => Promise<{ contracts: ReadonlyArray<ContractDefinitionView> }>;
}

const mountSuggestedFor = (opts: MountSuggestedForOptions = {}) => {
  const doc = makeFakeDocument();
  const host = doc.createElement('div');

  const runListSuggestions = vi.fn<SuggestionsListCaller>();
  runListSuggestions.mockImplementation(
    opts.runListSuggestions
      ?? (async () => ({ suggestions: opts.suggestions ?? [] })),
  );

  const runAcceptSuggestion = vi.fn<SuggestionsAcceptCaller>();
  runAcceptSuggestion.mockImplementation(
    opts.runAcceptSuggestion
      ?? (async ({ key_hash }) => ({
        rule: contractView(`rule_${key_hash}`, { grant_kind: 'delegation' }),
        suggestion: suggestionRow(key_hash, { state: 'accepted' }),
      })),
  );

  const runDismissSuggestion = vi.fn<SuggestionsDismissCaller>();
  runDismissSuggestion.mockImplementation(
    opts.runDismissSuggestion
      ?? (async ({ key_hash }) => ({
        suggestion: suggestionRow(key_hash, { state: 'dismissed' }),
      })),
  );

  const mount = mountSuggestedRulesPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runListSuggestions,
    runAcceptSuggestion,
    runDismissSuggestion,
    ...(opts.runListContracts !== undefined
      ? { runListContracts: opts.runListContracts }
      : {}),
    ...(opts.subscribe !== undefined ? { subscribe: opts.subscribe } : {}),
  });

  return {
    doc,
    host,
    mount,
    calls: {
      runListSuggestions,
      runAcceptSuggestion,
      runDismissSuggestion,
    },
  };
};

interface MountContractsForOptions {
  contracts?: ReadonlyArray<ContractDefinitionView>;
  runListContracts?: ContractsListCaller;
  runRevokeContract?: ContractsRevokeCaller;
  subscribe?: BroadcastSubscriber['on'];
}

const mountContractsFor = (opts: MountContractsForOptions = {}) => {
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

const suggestionCardFor = (root: FakeEl, keyHash: string): FakeEl | undefined =>
  collectByAttr(root, SUGGESTED_RULES_CARD_ATTR).find(
    (r) => r.getAttribute('data-key-hash') === keyHash,
  );

const suggestionButtonFor = (
  root: FakeEl,
  attr: string,
  keyHash: string,
): FakeEl | undefined =>
  collectByAttr(root, attr).find(
    (b) => b.getAttribute('data-key-hash') === keyHash,
  );

const contractRowFor = (root: FakeEl, contractId: string): FakeEl | undefined =>
  collectByAttr(root, CONTRACTS_ROW_ATTR).find(
    (r) => r.getAttribute('data-contract-id') === contractId,
  );

const armAcceptEditor = (host: FakeEl, keyHash: string): void => {
  suggestionButtonFor(host, SUGGESTED_RULES_ACCEPT_ATTR, keyHash)!.click();
};

const setBoundsAndMint = (
  host: FakeEl,
  keyHash: string,
  ttlDays: string,
  uses: string,
): void => {
  onlyByAttr(host, SUGGESTED_RULES_TTL_INPUT_ATTR).value = ttlDays;
  onlyByAttr(host, SUGGESTED_RULES_USES_INPUT_ATTR).value = uses;
  suggestionButtonFor(host, SUGGESTED_RULES_MINT_ATTR, keyHash)!.click();
};

type AnyBroadcastListener = (event: ServerEvent) => void;

interface FakeSubscribeCall {
  kind: BroadcastEventKind;
  listener: AnyBroadcastListener;
  unsubscribeCalls: number;
}

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

const delegationSuggestedEvent = (
  key_hash = 'key_live',
  cursor = 1,
): Extract<ServerEvent, { kind: 'contract.delegation_rule_suggested' }> => ({
  kind: 'contract.delegation_rule_suggested',
  key_hash,
  ingredient_id: 'mail.send',
  operation_id: 'mail.send',
  cursor,
});

const delegationResolvedEvent = (
  key_hash = 'key_live',
  resolution: 'accepted' | 'dismissed' = 'accepted',
  cursor = 2,
): Extract<ServerEvent, { kind: 'contract.delegation_rule_suggestion_resolved' }> => ({
  kind: 'contract.delegation_rule_suggestion_resolved',
  key_hash,
  resolution,
  cursor,
});

const directPanelChildren = (host: FakeEl): FakeEl[] =>
  onlyByAttr(host, CONTRACTS_PANEL_HOST_ATTR).children;

describe('D-177 P6c Suggested rules panel', () => {
  it('renders nothing visible for an empty list and settles ready', async () => {
    const { host, mount } = mountSuggestedFor({ suggestions: [] });

    await mount.whenLoaded();

    expect(mount.getState()).toBe('ready');
    expect(collectByAttr(host, SUGGESTED_RULES_PANEL_HOST_ATTR)).toHaveLength(1);
    expect(collectByAttr(host, SUGGESTED_RULES_HEADING_ATTR)).toHaveLength(0);
    expect(collectByAttr(host, SUGGESTED_RULES_CARD_ATTR)).toHaveLength(0);
    expect(allText(host).join(' ').trim()).toBe('');
    mount.dispose();
  });

  it('filters accepted and dismissed suggestions out of the open list', async () => {
    const open = suggestionRow('key_open');
    const accepted = suggestionRow('key_accepted', { state: 'accepted' });
    const dismissed = suggestionRow('key_dismissed', { state: 'dismissed' });
    const { host, mount } = mountSuggestedFor({
      suggestions: [open, accepted, dismissed],
    });

    await mount.whenLoaded();

    expect(collectByAttr(host, SUGGESTED_RULES_CARD_ATTR)).toHaveLength(1);
    expect(mount.getOpenSuggestions()).toHaveLength(1);
    expect(mount.getOpenSuggestions()[0]).toEqual(open);
    expect(suggestionCardFor(host, 'key_open')).toBeDefined();
    expect(suggestionCardFor(host, 'key_accepted')).toBeUndefined();
    expect(suggestionCardFor(host, 'key_dismissed')).toBeUndefined();
    mount.dispose();
  });

  it('renders the operation heading and every authority facet including actor', async () => {
    const row = suggestionRow('key_facets');
    const { host, mount } = mountSuggestedFor({ suggestions: [row] });

    await mount.whenLoaded();

    const card = suggestionCardFor(host, 'key_facets')!;
    expect(collectByClass(card, 'sr-card-heading')[0]?.textContent)
      .toContain('mail.send');
    expect(collectByClass(card, 'sr-facet').map((c) => c.textContent)).toEqual(
      expect.arrayContaining([
        'channel: mcp',
        'actor: contracted_user',
        'ingredient: mail.send',
        'risk: write',
        'mode: exact',
      ]),
    );
    mount.dispose();
  });

  it('N.14 — a door suggestion renders its door facet, form-evidence copy, and the riding disclosure', async () => {
    const row = suggestionRow('key_door', {
      snapshot: {
        channel: 'reception',
        actor: 'anonymous',
        bound_contract_id: 'ct_door_a',
        grant_mode: 'open',
        pinned_projection_hash: 'proj-hash',
        open_projection: {
        version: 1,
        args: [
          {
            path: 'to',
            skeleton: '{{context.reception_submission.email}}',
            roots: [
              {
                ref: 'context.reception_submission.email',
                origin: 'door_submission',
              },
            ],
            },
          ],
        },
      },
    });
    // NO contracts caller wired ⇒ this pins the FALLBACK rendering (raw id),
    // not the preferred one. The resolved-name cases are the two tests below.
    const { host, mount } = mountSuggestedFor({ suggestions: [row] });

    await mount.whenLoaded();

    const card = suggestionCardFor(host, 'key_door')!;
    expect(collectByClass(card, 'sr-facet').map((c) => c.textContent)).toEqual(
      expect.arrayContaining(['form door: ct_door_a', 'mode: open']),
    );
    // Door evidence drops the misleading "1 session" phrasing.
    const evidenceTexts = collectByClass(card, 'sr-evidence').map((c) => c.textContent);
    expect(evidenceTexts.some((t) => t.includes('on this form'))).toBe(true);
    expect(evidenceTexts.some((t) => t.includes('session'))).toBe(false);
    // The N.14.3 riding disclosure names the visitor-varying authority arg.
    const disclosure = collectByAttr(card, SUGGESTED_RULES_DOOR_DISCLOSURE_ATTR);
    expect(disclosure).toHaveLength(1);
    expect(disclosure[0]!.textContent).toContain('to');
    expect(disclosure[0]!.textContent).toContain('vary');
    mount.dispose();
  });

  /** A door row + the contracts list that names its door. */
  const doorRow = (key = 'key_door_named') =>
    suggestionRow(key, {
      snapshot: {
        channel: 'reception',
        actor: 'anonymous',
        bound_contract_id: 'ct_door_a',
        grant_mode: 'exact',
      },
    });

  it('#5 — the door facet names the door with the string the contract inventory shows, not the raw ct_ id', async () => {
    // `contracts-panel.ts` lists a contract by `display_name` and NEVER by id,
    // so the raw `ct_…` matched nothing the owner could see. The name below is
    // shaped exactly as `mint-door-contract.ts` composes it.
    const { host, mount } = mountSuggestedFor({
      suggestions: [doorRow()],
      runListContracts: async () => ({
        contracts: [
          contractView('ct_door_a', { display_name: 'Reception door — book-a-call' }),
          contractView('ct_other', { display_name: 'Reception door — unrelated' }),
        ],
      }),
    });

    await mount.whenLoaded();

    const facets = collectByClass(suggestionCardFor(host, 'key_door_named')!, 'sr-facet')
      .map((c) => c.textContent);
    expect(facets).toEqual(
      expect.arrayContaining(['form door: Reception door — book-a-call']),
    );
    // The opaque id is GONE from the card — that is the whole point.
    expect(facets.some((t) => t.includes('ct_door_a'))).toBe(false);
    // ⛔ non-vacuity: a resolver that returned every name would also pass the
    // assertion above. The OTHER door's name must not leak onto this card.
    expect(facets.some((t) => t.includes('unrelated'))).toBe(false);
    mount.dispose();
  });

  it('#5 — an unresolvable door (revoked/absent, or the contracts list failing) falls back to the id and never costs the card', async () => {
    // A stale or guessed name would MISIDENTIFY the door a rule binds to, and
    // naming it exactly is this facet's whole job — so degrade to the id.
    const { host: h1, mount: m1 } = mountSuggestedFor({
      suggestions: [doorRow('key_absent')],
      // The door is not in the list (revoked / raced).
      runListContracts: async () => ({ contracts: [] }),
    });
    await m1.whenLoaded();
    expect(
      collectByClass(suggestionCardFor(h1, 'key_absent')!, 'sr-facet').map((c) => c.textContent),
    ).toEqual(expect.arrayContaining(['form door: ct_door_a']));
    m1.dispose();

    // The cosmetic lookup THROWING must not fail the suggestions load: the card
    // still renders, with the id, and no list error is surfaced.
    const { host: h2, mount: m2 } = mountSuggestedFor({
      suggestions: [doorRow('key_boom')],
      runListContracts: async () => {
        throw new Error('listContracts exploded');
      },
    });
    await m2.whenLoaded();
    const card = suggestionCardFor(h2, 'key_boom');
    expect(card).not.toBeNull();
    expect(
      collectByClass(card!, 'sr-facet').map((c) => c.textContent),
    ).toEqual(expect.arrayContaining(['form door: ct_door_a']));
    expect(m2.getListError()).toBeNull();
    expect(m2.getOpenSuggestions()).toHaveLength(1);
    m2.dispose();
  });

  it('N.14.8 fork 3 — the door evidence line SAYS the rejections, so the card cannot assert a clean record it does not have', async () => {
    const row = suggestionRow('key_rejects', {
      snapshot: { channel: 'reception', actor: 'anonymous', bound_contract_id: 'ct_door_a' },
      evidence: { door_rejected_count: 20, door_last_rejected_at: 1 },
    });
    const { host, mount } = mountSuggestedFor({ suggestions: [row] });
    await mount.whenLoaded();
    const ev = collectByClass(suggestionCardFor(host, 'key_rejects')!, 'sr-evidence')
      .map((c) => c.textContent);
    expect(ev.some((t) => t.includes('20 rejections on this form'))).toBe(true);
    mount.dispose();
  });

  it('N.14.8 fork 3 — ZERO rejections is EARNED evidence and is said; NOT COUNTED says nothing', async () => {
    // The two must not collapse: "no rejections" is a claim the card can back;
    // an unwired counter cannot back any claim, so it makes none.
    const zero = suggestionRow('key_zero', {
      snapshot: { channel: 'reception', actor: 'anonymous', bound_contract_id: 'ct_door_a' },
      evidence: { door_rejected_count: 0 },
    });
    const { host: h1, mount: m1 } = mountSuggestedFor({ suggestions: [zero] });
    await m1.whenLoaded();
    expect(
      collectByClass(suggestionCardFor(h1, 'key_zero')!, 'sr-evidence')
        .some((c) => c.textContent.includes('no rejections on this form')),
    ).toBe(true);
    m1.dispose();

    const uncounted = suggestionRow('key_uncounted', {
      snapshot: { channel: 'reception', actor: 'anonymous', bound_contract_id: 'ct_door_a' },
    });
    const { host: h2, mount: m2 } = mountSuggestedFor({ suggestions: [uncounted] });
    await m2.whenLoaded();
    const ev = collectByClass(suggestionCardFor(h2, 'key_uncounted')!, 'sr-evidence')
      .map((c) => c.textContent);
    expect(ev.some((t) => t.includes('on this form'))).toBe(true);
    expect(ev.some((t) => t.includes('rejection'))).toBe(false);
    m2.dispose();
  });

  it('N.14 — an owner suggestion renders NO door facet and NO disclosure (regression pin)', async () => {
    const row = suggestionRow('key_owner_plain');
    const { host, mount } = mountSuggestedFor({ suggestions: [row] });

    await mount.whenLoaded();

    const card = suggestionCardFor(host, 'key_owner_plain')!;
    expect(
      collectByClass(card, 'sr-facet').some((c) => c.textContent.startsWith('form door:')),
    ).toBe(false);
    expect(collectByAttr(card, SUGGESTED_RULES_DOOR_DISCLOSURE_ATTR)).toHaveLength(0);
    mount.dispose();
  });

  it('surfaces list failures as a panel error state', async () => {
    const { host, mount } = mountSuggestedFor({
      runListSuggestions: async () => {
        throw new Error('suggestions unavailable');
      },
    });

    await mount.whenLoaded();

    expect(mount.getState()).toBe('error');
    expect(mount.getListError()).toBe('suggestions unavailable');
    expect(collectByAttr(host, SUGGESTED_RULES_ERROR_ATTR)).toHaveLength(1);
    expect(collectByAttr(host, SUGGESTED_RULES_ERROR_ATTR)[0]!.textContent)
      .toContain('suggestions unavailable');
    mount.dispose();
  });

  it('expands the accept editor with default TTL and use-budget ceilings', async () => {
    const row = suggestionRow('key_accept_defaults');
    const { host, mount } = mountSuggestedFor({ suggestions: [row] });
    await mount.whenLoaded();

    armAcceptEditor(host, 'key_accept_defaults');

    expect(onlyByAttr(host, SUGGESTED_RULES_TTL_INPUT_ATTR).getAttribute('value'))
      .toBe(String(TTL_CEILING_DAYS));
    expect(onlyByAttr(host, SUGGESTED_RULES_USES_INPUT_ATTR).getAttribute('value'))
      .toBe(String(DELEGATION_RULE_MAX_USES));
    mount.dispose();
  });

  it('mints with tightened bounds and drops the accepted card after re-list', async () => {
    const open = suggestionRow('key_accept');
    const accepted = suggestionRow('key_accept', { state: 'accepted' });
    let listCall = 0;
    const { host, mount, calls } = mountSuggestedFor({
      runListSuggestions: async () => {
        listCall += 1;
        return { suggestions: listCall === 1 ? [open] : [accepted] };
      },
      runAcceptSuggestion: async () => ({
        rule: contractView('ct_rule', { grant_kind: 'delegation' }),
        suggestion: accepted,
      }),
    });
    await mount.whenLoaded();

    armAcceptEditor(host, 'key_accept');
    setBoundsAndMint(host, 'key_accept', '7', '5');
    await tick();
    await mount.whenLoaded();
    await tick();

    expect(calls.runAcceptSuggestion).toHaveBeenCalledTimes(1);
    expect(calls.runAcceptSuggestion.mock.calls[0]![0]).toEqual({
      key_hash: 'key_accept',
      ttl_ms: 7 * DAY_MS,
      max_uses: 5,
    });
    expect(calls.runListSuggestions).toHaveBeenCalledTimes(2);
    expect(collectByAttr(host, SUGGESTED_RULES_CARD_ATTR)).toHaveLength(0);
    expect(mount.getOpenSuggestions()).toHaveLength(0);
    mount.dispose();
  });

  it('owns an unresolved suggestion decision until the RPC settles', async () => {
    const row = suggestionRow('key_pending_accept');
    const accepting = deferred<Awaited<ReturnType<SuggestionsAcceptCaller>>>();
    const { mount } = mountSuggestedFor({
      suggestions: [row],
      runAcceptSuggestion: () => accepting.promise,
    });
    await mount.whenLoaded();

    const pending = mount.acceptSuggestion('key_pending_accept', {
      ttl_ms: 7 * DAY_MS,
      max_uses: 5,
    });
    expect(mount.hasInFlightWork()).toBe(true);

    accepting.resolve({
      rule: contractView('ct_pending', { grant_kind: 'delegation' }),
      suggestion: suggestionRow('key_pending_accept', { state: 'accepted' }),
    });
    await pending;

    expect(mount.hasInFlightWork()).toBe(false);
    mount.dispose();
  });

  it('rejects TTL values above the delegation ceiling client-side', async () => {
    const row = suggestionRow('key_ttl_guard');
    const { host, mount, calls } = mountSuggestedFor({ suggestions: [row] });
    await mount.whenLoaded();

    armAcceptEditor(host, 'key_ttl_guard');
    setBoundsAndMint(
      host,
      'key_ttl_guard',
      String(TTL_CEILING_DAYS + 1),
      String(DELEGATION_RULE_MAX_USES),
    );
    await tick();

    expect(calls.runAcceptSuggestion).not.toHaveBeenCalled();
    expect(collectByAttr(host, SUGGESTED_RULES_CARD_ERROR_ATTR)).toHaveLength(1);
    mount.dispose();
  });

  it('rejects use budgets above the delegation ceiling client-side', async () => {
    const row = suggestionRow('key_uses_high_guard');
    const { host, mount, calls } = mountSuggestedFor({ suggestions: [row] });
    await mount.whenLoaded();

    armAcceptEditor(host, 'key_uses_high_guard');
    setBoundsAndMint(
      host,
      'key_uses_high_guard',
      String(TTL_CEILING_DAYS),
      String(DELEGATION_RULE_MAX_USES + 1),
    );
    await tick();

    expect(calls.runAcceptSuggestion).not.toHaveBeenCalled();
    expect(collectByAttr(host, SUGGESTED_RULES_CARD_ERROR_ATTR)).toHaveLength(1);
    mount.dispose();
  });

  it('rejects zero use budgets client-side', async () => {
    const row = suggestionRow('key_uses_zero_guard');
    const { host, mount, calls } = mountSuggestedFor({ suggestions: [row] });
    await mount.whenLoaded();

    armAcceptEditor(host, 'key_uses_zero_guard');
    setBoundsAndMint(host, 'key_uses_zero_guard', String(TTL_CEILING_DAYS), '0');
    await tick();

    expect(calls.runAcceptSuggestion).not.toHaveBeenCalled();
    expect(collectByAttr(host, SUGGESTED_RULES_CARD_ERROR_ATTR)).toHaveLength(1);
    mount.dispose();
  });

  it('rejects fractional use budgets client-side', async () => {
    const row = suggestionRow('key_uses_fraction_guard');
    const { host, mount, calls } = mountSuggestedFor({ suggestions: [row] });
    await mount.whenLoaded();

    armAcceptEditor(host, 'key_uses_fraction_guard');
    setBoundsAndMint(host, 'key_uses_fraction_guard', String(TTL_CEILING_DAYS), '2.5');
    await tick();

    expect(calls.runAcceptSuggestion).not.toHaveBeenCalled();
    expect(collectByAttr(host, SUGGESTED_RULES_CARD_ERROR_ATTR)).toHaveLength(1);
    mount.dispose();
  });

  it('surfaces accept RPC failures, retains the card, and re-enables controls', async () => {
    const row = suggestionRow('key_accept_fail');
    const { host, mount, calls } = mountSuggestedFor({
      suggestions: [row],
      runAcceptSuggestion: async () => {
        throw new Error('mint denied');
      },
    });
    await mount.whenLoaded();

    armAcceptEditor(host, 'key_accept_fail');
    setBoundsAndMint(host, 'key_accept_fail', '7', '5');
    await tick();

    expect(calls.runAcceptSuggestion).toHaveBeenCalledTimes(1);
    expect(suggestionCardFor(host, 'key_accept_fail')).toBeDefined();
    const errors = collectByAttr(host, SUGGESTED_RULES_CARD_ERROR_ATTR);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.textContent).toContain('mint denied');
    const accept = suggestionButtonFor(
      host,
      SUGGESTED_RULES_ACCEPT_ATTR,
      'key_accept_fail',
    );
    expect(accept).toBeDefined();
    expect(accept!.disabled).toBe(false);
    expect(accept!.hasAttribute('disabled')).toBe(false);
    mount.dispose();
  });

  it('disarms dismiss confirmation on Cancel without calling dismiss', async () => {
    const row = suggestionRow('key_dismiss_cancel');
    const { host, mount, calls } = mountSuggestedFor({ suggestions: [row] });
    await mount.whenLoaded();

    suggestionButtonFor(host, SUGGESTED_RULES_DISMISS_ATTR, 'key_dismiss_cancel')!.click();
    expect(
      suggestionButtonFor(
        host,
        SUGGESTED_RULES_DISMISS_CONFIRM_ATTR,
        'key_dismiss_cancel',
      ),
    ).toBeDefined();
    suggestionButtonFor(host, SUGGESTED_RULES_CANCEL_ATTR, 'key_dismiss_cancel')!.click();

    expect(calls.runDismissSuggestion).not.toHaveBeenCalled();
    expect(
      suggestionButtonFor(
        host,
        SUGGESTED_RULES_DISMISS_CONFIRM_ATTR,
        'key_dismiss_cancel',
      ),
    ).toBeUndefined();
    expect(suggestionButtonFor(host, SUGGESTED_RULES_DISMISS_ATTR, 'key_dismiss_cancel'))
      .toBeDefined();
    mount.dispose();
  });

  it('confirms dismiss once and drops the dismissed card after re-list', async () => {
    const open = suggestionRow('key_dismiss');
    const dismissed = suggestionRow('key_dismiss', { state: 'dismissed' });
    let listCall = 0;
    const { host, mount, calls } = mountSuggestedFor({
      runListSuggestions: async () => {
        listCall += 1;
        return { suggestions: listCall === 1 ? [open] : [dismissed] };
      },
      runDismissSuggestion: async () => ({ suggestion: dismissed }),
    });
    await mount.whenLoaded();

    suggestionButtonFor(host, SUGGESTED_RULES_DISMISS_ATTR, 'key_dismiss')!.click();
    expect(allText(suggestionCardFor(host, 'key_dismiss')!).join(' '))
      .toContain('Dismiss forever');
    suggestionButtonFor(host, SUGGESTED_RULES_DISMISS_CONFIRM_ATTR, 'key_dismiss')!
      .click();
    await tick();
    await mount.whenLoaded();
    await tick();

    expect(calls.runDismissSuggestion).toHaveBeenCalledTimes(1);
    expect(calls.runDismissSuggestion.mock.calls[0]![0]).toEqual({
      key_hash: 'key_dismiss',
    });
    expect(calls.runListSuggestions).toHaveBeenCalledTimes(2);
    expect(collectByAttr(host, SUGGESTED_RULES_CARD_ATTR)).toHaveLength(0);
    mount.dispose();
  });

  it('re-lists on delegation-rule-suggested broadcasts', async () => {
    const fake = makeFakeSubscribe();
    const { mount, calls } = mountSuggestedFor({ subscribe: fake.subscribe });
    await mount.whenLoaded();
    await tick();
    const list0 = calls.runListSuggestions.mock.calls.length;

    fake.dispatch(delegationSuggestedEvent());
    await tick();
    await mount.whenLoaded();

    expect(calls.runListSuggestions.mock.calls.length).toBe(list0 + 1);
    mount.dispose();
  });

  it('re-lists on delegation-rule-suggestion-resolved broadcasts', async () => {
    const fake = makeFakeSubscribe();
    const { mount, calls } = mountSuggestedFor({ subscribe: fake.subscribe });
    await mount.whenLoaded();
    await tick();
    const list0 = calls.runListSuggestions.mock.calls.length;

    fake.dispatch(delegationResolvedEvent());
    await tick();
    await mount.whenLoaded();

    expect(calls.runListSuggestions.mock.calls.length).toBe(list0 + 1);
    mount.dispose();
  });

  it('unsubscribes all broadcast listeners on dispose', async () => {
    const fake = makeFakeSubscribe();
    const { mount } = mountSuggestedFor({ subscribe: fake.subscribe });
    await mount.whenLoaded();

    expect(fake.calls.map((c) => c.kind)).toEqual([
      'contract.delegation_rule_suggested',
      'contract.delegation_rule_suggestion_resolved',
    ]);
    expect(fake.activeCount()).toBe(2);

    mount.dispose();

    expect(fake.activeCount()).toBe(0);
    expect(fake.calls.map((c) => c.unsubscribeCalls)).toEqual([1, 1]);
  });

  it('no-ops programmatic accept for an unknown key hash', async () => {
    const row = suggestionRow('key_known_accept');
    const { mount, calls } = mountSuggestedFor({ suggestions: [row] });
    await mount.whenLoaded();

    await mount.acceptSuggestion('key_missing', { ttl_ms: DAY_MS, max_uses: 1 });

    expect(calls.runAcceptSuggestion).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('no-ops programmatic dismiss for an unknown key hash', async () => {
    const row = suggestionRow('key_known_dismiss');
    const { mount, calls } = mountSuggestedFor({ suggestions: [row] });
    await mount.whenLoaded();

    await mount.dismissSuggestion('key_missing');

    expect(calls.runDismissSuggestion).not.toHaveBeenCalled();
    mount.dispose();
  });
});

describe('D-177 P6c contracts inventory grouping', () => {
  it('leaves all-standing inventories without group headers', async () => {
    const rows = [
      contractView('ct_a', { display_name: 'Standing A' }),
      contractView('ct_b', {
        display_name: 'Standing B',
        grant_kind: 'standing',
      }),
    ];
    const { host, mount } = mountContractsFor({ contracts: rows });

    await mount.whenLoaded();

    expect(collectByAttr(host, CONTRACTS_GROUP_HEADER_ATTR)).toHaveLength(0);
    mount.dispose();
  });

  it('renders all-standing rows flat in server order', async () => {
    const rows = [
      contractView('ct_a', { display_name: 'Standing A' }),
      contractView('ct_b', {
        display_name: 'Standing B',
        grant_kind: 'standing',
      }),
    ];
    const { host, mount } = mountContractsFor({ contracts: rows });

    await mount.whenLoaded();

    expect(collectByAttr(host, CONTRACTS_ROW_ATTR).map((r) =>
      r.getAttribute('data-contract-id'),
    )).toEqual(['ct_a', 'ct_b']);
    expect(collectByAttr(host, CONTRACTS_ROW_ATTR).map((r) =>
      r.getAttribute('data-group'),
    )).toEqual([null, null]);
    mount.dispose();
  });

  it('renders mixed inventory group headers in display order', async () => {
    const rows = [
      contractView('ct_session', { grant_kind: 'session' }),
      contractView('ct_future', {
        grant_kind: 'future_kind' as unknown as ContractDefinitionView['grant_kind'],
      }),
      contractView('ct_standing'),
      contractView('ct_delegation', { grant_kind: 'delegation' }),
    ];
    const { host, mount } = mountContractsFor({ contracts: rows });

    await mount.whenLoaded();

    const headers = collectByAttr(host, CONTRACTS_GROUP_HEADER_ATTR);
    expect(headers.map((h) => h.textContent)).toEqual([
      'Standing contracts',
      'Delegation rules',
      'Session grants',
      'Other grants',
    ]);
    expect(headers.map((h) => h.getAttribute('data-group'))).toEqual([
      'standing',
      'delegation',
      'session',
      'other',
    ]);
    mount.dispose();
  });

  it('files mixed inventory rows under the correct groups and labels delegation rules', async () => {
    const rows = [
      contractView('ct_session', { grant_kind: 'session' }),
      contractView('ct_future', {
        grant_kind: 'future_kind' as unknown as ContractDefinitionView['grant_kind'],
      }),
      contractView('ct_standing'),
      contractView('ct_delegation', {
        display_name: 'Delegation row',
        grant_kind: 'delegation',
      }),
    ];
    const { host, mount } = mountContractsFor({ contracts: rows });

    await mount.whenLoaded();

    expect(directPanelChildren(host).map((child) => {
      if (child.hasAttribute(CONTRACTS_GROUP_HEADER_ATTR)) {
        return `header:${child.getAttribute('data-group')}`;
      }
      if (child.hasAttribute(CONTRACTS_ROW_ATTR)) {
        return `row:${child.getAttribute('data-contract-id')}`;
      }
      return child.tagName;
    })).toEqual([
      'header:standing',
      'row:ct_standing',
      'header:delegation',
      'row:ct_delegation',
      'header:session',
      'row:ct_session',
      'header:other',
      'row:ct_future',
    ]);
    expect(allText(contractRowFor(host, 'ct_delegation')!).join(' '))
      .toContain('delegation rule');
    expect(contractRowFor(host, 'ct_future')).toBeDefined();
    mount.dispose();
  });

  it('D-196: hides customer template and instance rows from the generic contracts inventory', async () => {
    const rows = [
      contractView('ct_standing'),
      contractView('ct_customer_template', { grant_kind: 'customer_template' }),
      contractView('ct_customer_instance', { grant_kind: 'customer_instance' }),
    ];
    const { host, mount } = mountContractsFor({ contracts: rows });

    await mount.whenLoaded();

    expect(mount.getContracts().map((row) => row.contract_id)).toEqual(['ct_standing']);
    expect(contractRowFor(host, 'ct_standing')).toBeDefined();
    expect(contractRowFor(host, 'ct_customer_template')).toBeUndefined();
    expect(contractRowFor(host, 'ct_customer_instance')).toBeUndefined();
    mount.dispose();
  });
});
