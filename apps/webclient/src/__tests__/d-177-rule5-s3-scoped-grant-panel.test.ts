/** D-177 N.11 rule 5 (5.c, slice C) — the "Scoped grant proposals" panel:
 *  open-card rendering (rule-7 sentence + verbatim excerpt + connection
 *  affordance), the unmintable zero-candidate state, the approve call's
 *  args (auto-filled sole candidate + tighten-only bounds), the two-stage
 *  dismiss, and the resolved-row filter. Fake-DOM harness mirrors the P6c
 *  panel test. */

import { describe, expect, it, vi } from 'vitest';

import {
  SCOPED_GRANT_ACCEPT_ATTR,
  SCOPED_GRANT_CARD_ATTR,
  SCOPED_GRANT_DISMISS_ATTR,
  SCOPED_GRANT_DISMISS_CONFIRM_ATTR,
  SCOPED_GRANT_EXCERPT_ATTR,
  SCOPED_GRANT_HEADING_ATTR,
  SCOPED_GRANT_PANEL_HOST_ATTR,
  SCOPED_GRANT_SENTENCE_ATTR,
  SCOPED_GRANT_TTL_INPUT_ATTR,
  SCOPED_GRANT_PANEL_BROADCAST_KINDS,
  SCOPED_GRANT_UNMINTABLE_ATTR,
  SCOPED_GRANT_USES_INPUT_ATTR,
  mountScopedGrantPanel,
  type ScopedSuggestionsAcceptCaller,
  type ScopedSuggestionsDismissCaller,
  type ScopedSuggestionsListCaller,
} from '../contracts/scoped-grant-panel.js';
import {
  type ContractDefinitionView,
  type ScopedGrantSuggestionRow,
  type ScopedGrantSuggestionSnapshot,
} from '@recued/contracts';
import { WEBCLIENT_DEFAULT_SUBSCRIPTIONS } from '../realtime/subscriber.js';

// ── Minimal fake DOM (the P6c panel-test harness shape) ─────────────

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  value: string;
  disabled: boolean;
  attrs: Map<string, string>;
  children: FakeEl[];
  listeners: Map<string, Array<(ev?: unknown) => void>>;
  parent: FakeEl | null;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: (ev?: unknown) => void): void;
  click(): void;
}

const makeFakeElement = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    type: '',
    value: '',
    disabled: false,
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
      if (k === 'value') el.value = v;
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
    click() {
      if (el.disabled || el.attrs.has('disabled')) return;
      for (const fn of el.listeners.get('click') ?? []) fn({ target: el });
    },
  };
  return el;
};

const fakeDocument = { createElement: makeFakeElement } as unknown as Document;

const collectByAttr = (root: FakeEl, attr: string, out: FakeEl[] = []): FakeEl[] => {
  if (root.attrs.has(attr)) out.push(root);
  for (const c of root.children) collectByAttr(c, attr, out);
  return out;
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

// ── Fixtures ─────────────────────────────────────────────────────

const snapshot = (
  overrides: Partial<ScopedGrantSuggestionSnapshot> = {},
): ScopedGrantSuggestionSnapshot => ({
  channel: 'chat',
  channel_session_id: 'chat:s-1',
  ingredient_id: 'mailbox-catalog',
  operation_id: 'mail.reply',
  risk_tier: 'write',
  scoped_source: 'forwarded_item_sender',
  ttl_ms: 4 * 60 * 60 * 1000,
  entity: 'mail',
  action: 'reply',
  ...overrides,
});

const row = (
  overrides: Partial<ScopedGrantSuggestionRow> = {},
): ScopedGrantSuggestionRow => ({
  key_hash: 'key-1',
  state: 'open',
  snapshot: snapshot(),
  triggering_excerpt: 'auto-approve replying to each email I forward this afternoon',
  connection_candidates: ['mailbox-1'],
  created_at: 1,
  updated_at: 1,
  ...overrides,
});

const mountWith = (rows: ScopedGrantSuggestionRow[]) => {
  const host = makeFakeElement('div') as unknown as HTMLElement;
  const runListSuggestions: ScopedSuggestionsListCaller = vi
    .fn()
    .mockResolvedValue({ suggestions: rows });
  const runAcceptSuggestion: ScopedSuggestionsAcceptCaller = vi.fn().mockResolvedValue({
    grant: { contract_id: 'ct_1' } as unknown as ContractDefinitionView,
    suggestion: { ...rows[0], state: 'accepted' },
    sentence: 'ok?',
  });
  const runDismissSuggestion: ScopedSuggestionsDismissCaller = vi
    .fn()
    .mockResolvedValue({ suggestion: { ...rows[0], state: 'dismissed' } });
  const mount = mountScopedGrantPanel({
    host,
    document: fakeDocument,
    runListSuggestions,
    runAcceptSuggestion,
    runDismissSuggestion,
  });
  return { host: host as unknown as FakeEl, mount, runAcceptSuggestion, runDismissSuggestion };
};

describe('scoped-grant panel', () => {
  it('renders the open card: sentence, verbatim excerpt, bounds inputs', async () => {
    const { host, mount } = mountWith([row(), row({ key_hash: 'k2', state: 'accepted' })]);
    await mount.whenLoaded();
    const root = collectByAttr(host, SCOPED_GRANT_PANEL_HOST_ATTR)[0];
    expect(collectByAttr(root, SCOPED_GRANT_HEADING_ATTR)).toHaveLength(1);
    // resolved rows never render
    expect(collectByAttr(root, SCOPED_GRANT_CARD_ATTR)).toHaveLength(1);
    const sentence = collectByAttr(root, SCOPED_GRANT_SENTENCE_ATTR)[0];
    expect(sentence.textContent).toContain('mail.reply on mailbox-1');
    expect(sentence.textContent).toContain('for 4 hours');
    const excerpt = collectByAttr(root, SCOPED_GRANT_EXCERPT_ATTR)[0];
    expect(excerpt.textContent).toContain('auto-approve replying to each email');
    expect(mount.getOpenSuggestions()).toHaveLength(1);
  });

  it('approve auto-fills the sole candidate and sends the tightened bounds', async () => {
    const { host, mount, runAcceptSuggestion } = mountWith([row()]);
    await mount.whenLoaded();
    const root = collectByAttr(host, SCOPED_GRANT_PANEL_HOST_ATTR)[0];
    const ttl = collectByAttr(root, SCOPED_GRANT_TTL_INPUT_ATTR)[0];
    const uses = collectByAttr(root, SCOPED_GRANT_USES_INPUT_ATTR)[0];
    ttl.value = '30';
    uses.value = '3';
    collectByAttr(root, SCOPED_GRANT_ACCEPT_ATTR)[0].click();
    await mount.whenLoaded();
    expect(runAcceptSuggestion).toHaveBeenCalledWith({
      key_hash: 'key-1',
      connection_name: 'mailbox-1',
      ttl_ms: 30 * 60_000,
      max_uses: 3,
    });
  });

  it('owns an unresolved scoped decision until the RPC settles', async () => {
    const { mount, runAcceptSuggestion } = mountWith([row()]);
    const accepting = deferred<Awaited<ReturnType<ScopedSuggestionsAcceptCaller>>>();
    vi.mocked(runAcceptSuggestion).mockReturnValueOnce(accepting.promise);
    await mount.whenLoaded();

    const pending = mount.acceptSuggestion('key-1', {
      connection_name: 'mailbox-1',
      ttl_ms: 30 * 60_000,
      max_uses: 3,
    });
    expect(mount.hasInFlightWork()).toBe(true);

    accepting.resolve({
      grant: { contract_id: 'ct_pending' } as unknown as ContractDefinitionView,
      suggestion: { ...row(), state: 'accepted' },
      sentence: 'ok?',
    });
    await pending;

    expect(mount.hasInFlightWork()).toBe(false);
  });

  it('renders the unmintable state with zero candidates (dismiss only)', async () => {
    const { host, mount } = mountWith([row({ connection_candidates: [] })]);
    await mount.whenLoaded();
    const root = collectByAttr(host, SCOPED_GRANT_PANEL_HOST_ATTR)[0];
    expect(collectByAttr(root, SCOPED_GRANT_UNMINTABLE_ATTR)).toHaveLength(1);
    expect(collectByAttr(root, SCOPED_GRANT_ACCEPT_ATTR)).toHaveLength(0);
    expect(collectByAttr(root, SCOPED_GRANT_DISMISS_ATTR)).toHaveLength(1);
  });

  it('dismiss is two-stage (arm then confirm)', async () => {
    const { host, mount, runDismissSuggestion } = mountWith([row()]);
    await mount.whenLoaded();
    let root = collectByAttr(host, SCOPED_GRANT_PANEL_HOST_ATTR)[0];
    collectByAttr(root, SCOPED_GRANT_DISMISS_ATTR)[0].click();
    expect(runDismissSuggestion).not.toHaveBeenCalled();
    root = collectByAttr(host, SCOPED_GRANT_PANEL_HOST_ATTR)[0];
    collectByAttr(root, SCOPED_GRANT_DISMISS_CONFIRM_ATTR)[0].click();
    await mount.whenLoaded();
    expect(runDismissSuggestion).toHaveBeenCalledWith({ key_hash: 'key-1' });
  });
});

describe('scoped-grant panel — broadcast subscription parity', () => {
  // D-169 TR-10: the server fans only the kinds each client names, so every
  // kind this panel subscribes to must be in the webclient default set or its
  // listeners silently never fire (the live-refresh drift this ratchet guards).
  // The panel subscribes off SCOPED_GRANT_PANEL_BROADCAST_KINDS (single source
  // of truth), so this is the only assertion needed to keep the two in lockstep.
  it('SCOPED_GRANT_PANEL_BROADCAST_KINDS ⊆ WEBCLIENT_DEFAULT_SUBSCRIPTIONS', () => {
    for (const kind of SCOPED_GRANT_PANEL_BROADCAST_KINDS) {
      expect(WEBCLIENT_DEFAULT_SUBSCRIPTIONS).toContain(kind);
    }
  });
});
