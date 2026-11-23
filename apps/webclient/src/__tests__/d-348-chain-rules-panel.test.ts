/** D-348 slice 3 — the Contracts panel for a request the owner repeats: its words and each call,
 *  accepted within tighten-only bounds or dismissed for good; a longer chain replaces its rule;
 *  its delete offered on its own, with its own two answers; a live rule ended. Each a deliberate
 *  second step. */

import { describe, expect, it, vi } from 'vitest';
import {
  CHAIN_RULE_MAX_USES,
  CHAIN_RULE_TTL_MS,
  RpcError,
  type ChainRuleRow,
  type ChainSuggestionRow,
} from '@recued/contracts';

import {
  CHAIN_ACCEPT_ATTR,
  CHAIN_CONFIRM_ATTR,
  CHAIN_DAYS_ATTR,
  CHAIN_DELETE_ACCEPT_ATTR,
  CHAIN_DELETE_DISMISS_ATTR,
  CHAIN_DISMISS_ATTR,
  CHAIN_ERROR_ATTR,
  CHAIN_MINT_ATTR,
  CHAIN_REVOKE_ATTR,
  CHAIN_RULE_ATTR,
  CHAIN_SUGGESTION_ATTR,
  CHAIN_USES_ATTR,
  chainCallLine,
  mountChainRulesPanel,
} from '../contracts/chain-rules-panel.js';

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  value: string;
  disabled: boolean;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<() => void>>;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: () => void): void;
  click(): void;
}

const element = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(), className: '', textContent: '', type: '', value: '', disabled: false,
    attrs: new Map(), children: [], parent: null, listeners: new Map(),
    get firstChild() { return el.children[0] ?? null; },
    setAttribute(k, v) { el.attrs.set(k, v); },
    getAttribute(k) { return el.attrs.get(k) ?? null; },
    appendChild(c) { el.children.push(c); c.parent = el; return c; },
    removeChild(c) { el.children.splice(el.children.indexOf(c), 1); c.parent = null; return c; },
    addEventListener(type, fn) { el.listeners.set(type, [...(el.listeners.get(type) ?? []), fn]); },
    click() { if (!el.disabled) for (const fn of el.listeners.get('click') ?? []) fn(); },
  };
  return el;
};
const all = (root: FakeEl, attr: string): FakeEl[] => [
  ...(root.attrs.has(attr) ? [root] : []),
  ...root.children.flatMap((c) => all(c, attr)),
];
const text = (root: FakeEl): string => [root.textContent, ...root.children.map(text)].join(' ');
const tick = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

const DAY = 86_400_000;
const NOW = 1_760_000_000_000;
const SEND = {
  signature_hash: 'h-send', title: 'Send mail',
  signature: { op: 'step:send@h|mail-send||', pins: { to: ['ann@example.com', 'ben@example.com'] } },
};
const TASK = { signature_hash: 'h-task', title: 'Add a task', signature: { op: 'tier1:work.create:task', pins: {} } };
const CLEAR = {
  signature_hash: 'h-clear', title: 'Delete a task',
  signature: { op: 'op:recued-core/tasks|task.delete|', pins: {}, delete: true as const },
};
const evidence = { occasions: 3, members: ['h-send', 'h-task'], deletes: [], first_at: NOW - 2 * DAY, last_at: NOW };
const suggestion: ChainSuggestionRow = {
  key_hash: 'kh-1', words: 'Tell the guests the new time', members: [SEND, TASK], deletes: [], evidence, suggested_at: NOW,
};
const rule: ChainRuleRow = {
  rule_id: 'rule-1', key_hash: 'kh-2', words: 'Clear my done tasks', members: [TASK], deletes: [CLEAR],
  created_at: NOW, expires_at: NOW + 10 * DAY, max_uses: 100, uses_remaining: 97,
};

const mount = (lists: { suggestions?: ChainSuggestionRow[]; rules?: ChainRuleRow[]; failWith?: unknown } = {}) => {
  const host = element('div');
  const state = { suggestions: lists.suggestions ?? [suggestion], rules: lists.rules ?? [rule] };
  const accept = vi.fn(async (args: { key_hash: string }) => {
    state.suggestions = [];
    return { rule: { ...rule, rule_id: 'rule-new' }, suggestion: { ...suggestion, key_hash: args.key_hash } };
  });
  const dismiss = vi.fn(async (args: { key_hash: string; part?: 'all' | 'deletes' }) => {
    state.suggestions = [];
    return { key_hash: args.key_hash, part: args.part ?? 'all' };
  });
  const revoke = vi.fn(async () => { state.rules = []; return { rule: { ...rule, revoked_at: NOW } }; });
  const panel = mountChainRulesPanel({
    host: host as never,
    document: { createElement: element } as never,
    listSuggestions: async () => {
      if (lists.failWith !== undefined) throw lists.failWith;
      return { suggestions: state.suggestions };
    },
    listRules: async () => ({ rules: state.rules }),
    accept, dismiss, revoke,
  });
  return { host, panel, accept, dismiss, revoke };
};

describe('D-348 slice 3 — the requests you repeat, on Contracts', () => {
  it('shows nothing when there is nothing to decide, and nothing from a server without chains', async () => {
    const h = mount({ suggestions: [], rules: [] });
    await h.panel.whenLoaded();
    expect(h.host.children[0]!.children).toHaveLength(0);
    const old = mount({ rules: [], failWith: new RpcError('unknown_method', 'no such method') });
    await old.panel.whenLoaded();
    expect(old.host.children[0]!.children).toHaveLength(0);
  });

  it('a suggestion: the words, each call by its name and whom it reaches, and the days that earned it', async () => {
    const h = mount();
    await h.panel.whenLoaded();
    const [card] = all(h.host, CHAIN_SUGGESTION_ATTR);
    expect(text(card!)).toContain('When you ask “Tell the guests the new time”');
    expect(text(card!)).toContain('Send mail · To: ann@example.com, ben@example.com');
    expect(text(card!)).toContain('Add a task');
    expect(text(card!)).toContain('You said yes to it on 3 different days');
    const [live] = all(h.host, CHAIN_RULE_ATTR);
    expect(text(live!)).toContain('When you ask “Clear my done tasks”');
    expect(text(live!)).toContain('Delete a task (only what this request found itself)');
    expect(text(live!)).toContain('97 of 100 left');
  });

  it('accepts only after the bounds are shown, within the ceilings, tighter if asked', async () => {
    const h = mount();
    await h.panel.whenLoaded();
    all(h.host, CHAIN_ACCEPT_ATTR)[0]!.click();
    expect(h.accept).not.toHaveBeenCalled();
    expect(all(h.host, CHAIN_DAYS_ATTR)[0]!.value).toBe(String(CHAIN_RULE_TTL_MS / DAY));
    expect(all(h.host, CHAIN_USES_ATTR)[0]!.value).toBe(String(CHAIN_RULE_MAX_USES));
    all(h.host, CHAIN_USES_ATTR)[0]!.value = String(CHAIN_RULE_MAX_USES + 1);
    all(h.host, CHAIN_MINT_ATTR)[0]!.click();
    expect(h.accept).not.toHaveBeenCalled();
    expect(all(h.host, CHAIN_ERROR_ATTR)).toHaveLength(1);
    all(h.host, CHAIN_USES_ATTR)[0]!.value = '10';
    all(h.host, CHAIN_DAYS_ATTR)[0]!.value = '7';
    all(h.host, CHAIN_MINT_ATTR)[0]!.click();
    await tick();
    expect(h.accept).toHaveBeenCalledWith({ key_hash: 'kh-1', ttl_ms: 7 * DAY, max_uses: 10 });
    await h.panel.whenLoaded();
    expect(all(h.host, CHAIN_SUGGESTION_ATTR)).toHaveLength(0);
  });

  it('a longer chain replaces its rule, keeping that rule\'s days and uses: no bounds asked or sent', async () => {
    const longer: ChainSuggestionRow = { ...suggestion, key_hash: 'kh-2', rule_id: 'rule-1', members: [TASK, SEND] };
    const h = mount({ suggestions: [longer] });
    await h.panel.whenLoaded();
    expect(text(all(h.host, CHAIN_SUGGESTION_ATTR)[0]!)).toContain('It adds to the rule you have for this request');
    all(h.host, CHAIN_ACCEPT_ATTR)[0]!.click();
    expect(all(h.host, CHAIN_DAYS_ATTR)).toHaveLength(0);
    expect(text(h.host)).toContain('It replaces the rule you have for this request.');
    all(h.host, CHAIN_MINT_ATTR)[0]!.click();
    await tick();
    expect(h.accept).toHaveBeenCalledWith({ key_hash: 'kh-2' });
  });

  it('its delete is offered on its own: "Also let this run" or "Not this", each asked once more', async () => {
    const withDelete: ChainSuggestionRow = { ...suggestion, deletes: [CLEAR] };
    const h = mount({ suggestions: [withDelete] });
    await h.panel.whenLoaded();
    const card = all(h.host, CHAIN_SUGGESTION_ATTR)[0]!;
    expect(text(card)).toContain('Also, on its own, if you want it to run without asking too:');
    all(h.host, CHAIN_DELETE_ACCEPT_ATTR)[0]!.click();
    expect(h.accept).not.toHaveBeenCalled();
    expect(text(h.host)).toContain('only on what the request found itself');
    all(h.host, CHAIN_CONFIRM_ATTR)[0]!.click();
    await tick();
    expect(h.accept).toHaveBeenCalledWith({ key_hash: 'kh-1', deletes: true });

    const g = mount({ suggestions: [withDelete] });
    await g.panel.whenLoaded();
    all(g.host, CHAIN_DELETE_DISMISS_ATTR)[0]!.click();
    expect(g.dismiss).not.toHaveBeenCalled();
    expect(text(g.host)).toContain('Recued will not offer this again; it keeps asking.');
    all(g.host, CHAIN_CONFIRM_ATTR)[0]!.click();
    await tick();
    expect(g.dismiss).toHaveBeenCalledWith({ key_hash: 'kh-1', part: 'deletes' });
  });

  it('a delete left to decide beside a rule that holds the rest offers only the delete', async () => {
    const onlyDelete: ChainSuggestionRow = {
      ...suggestion, key_hash: 'kh-2', rule_id: 'rule-1', members: [TASK], deletes: [CLEAR],
    };
    const h = mount({ suggestions: [onlyDelete], rules: [{ ...rule, deletes: [] }] });
    await h.panel.whenLoaded();
    const card = all(h.host, CHAIN_SUGGESTION_ATTR)[0]!;
    expect(all(card, CHAIN_ACCEPT_ATTR)).toHaveLength(0);
    expect(all(card, CHAIN_DISMISS_ATTR)).toHaveLength(0);
    expect(all(card, CHAIN_DELETE_ACCEPT_ATTR)).toHaveLength(1);
    expect(text(card)).not.toContain('It adds to the rule');
  });

  it('dismisses only after saying it is for good', async () => {
    const h = mount();
    await h.panel.whenLoaded();
    all(h.host, CHAIN_DISMISS_ATTR)[0]!.click();
    expect(h.dismiss).not.toHaveBeenCalled();
    expect(text(h.host)).toContain('Recued will not suggest this request again.');
    all(h.host, CHAIN_CONFIRM_ATTR)[0]!.click();
    await tick();
    expect(h.dismiss).toHaveBeenCalledWith({ key_hash: 'kh-1', part: 'all' });
  });

  it('ends a rule only after asking once more', async () => {
    const h = mount({ suggestions: [] });
    await h.panel.whenLoaded();
    all(h.host, CHAIN_REVOKE_ATTR)[0]!.click();
    expect(h.revoke).not.toHaveBeenCalled();
    all(h.host, CHAIN_CONFIRM_ATTR)[0]!.click();
    await tick();
    expect(h.revoke).toHaveBeenCalledWith({ rule_id: 'rule-1' });
    await h.panel.whenLoaded();
    expect(all(h.host, CHAIN_RULE_ATTR)).toHaveLength(0);
  });

  it('a call with no name reads as its operation; one it cannot open says so', () => {
    expect(chainCallLine({ signature_hash: 'x', signature: { op: 'op:recued-core/hubspot|deal.update|hubspot', pins: { deal_id: ['9001'] } } }))
      .toBe('deal.update · Deal ID: 9001');
    expect(chainCallLine({ signature_hash: 'x', signature: { op: 'step:send@h|mail-send||', pins: {} } })).toBe('mail-send');
    expect(chainCallLine({ signature_hash: 'x', signature: { op: 'tier1:work.create:task', pins: {} } })).toBe('work.create:task');
    expect(chainCallLine({ signature_hash: 'x' })).toBe('A call Recued cannot show now');
  });

  it('what a call names, as its approval card names it, where it read "Source ID: 54d0ecc0-…" (live, 2026-11-13)', () => {
    const rename = { op: 'tier1:calendar.update:local', pins: { source_id: ['54d0ecc0'] } };
    const title = 'Change a calendar event, for your Recued calendar';
    expect(chainCallLine({ signature_hash: 'x', title, signature: rename,
      pin_labels: { source_id: { '54d0ecc0': 'Team sync, Sat 14 Nov 10:00' } } }))
      .toBe(`${title} · Event: Team sync, Sat 14 Nov 10:00`);
    // With no name known, the field is still named as the card names it.
    expect(chainCallLine({ signature_hash: 'x', title, signature: rename })).toBe(`${title} · Event: 54d0ecc0`);
    // A record's id nobody can name now (removed since, or one this read cannot see) is said so, never
    // shown: it read "Event: 54d0ecc0-…".
    const uuid = '54d0ecc0-1f2a-4b3c-9d8e-7f6a5b4c3d2e';
    expect(chainCallLine({ signature_hash: 'x', title, signature: { op: 'tier1:calendar.update:local', pins: { source_id: [uuid] } } }))
      .toBe(`${title} · Event: one Recued cannot show now`);
    expect(chainCallLine({ signature_hash: 'x', title: 'Change a task', signature: { op: 'tier1:work.update:task',
      pins: { id: ['we1:task:recued.task:local:33a2f46b-2823-43d3'] } } })).toBe('Change a task · Task: one Recued cannot show now');
    // A record by its kind and title; a contact by name.
    expect(chainCallLine({ signature_hash: 'x', title: 'Change a task', signature: { op: 'tier1:work.update:task', pins: { id: ['t-1'] } },
      pin_labels: { id: { 't-1': 'Pay rent' } } })).toBe('Change a task · Task: Pay rent');
    expect(chainCallLine({ signature_hash: 'x', title: 'Change a contact', signature: { op: 'tier1:contact.write:change',
      pins: { target_id: ['c-1'] } }, pin_labels: { target_id: { 'c-1': 'Mia Whitfield' } } })).toBe('Change a contact · Contact: Mia Whitfield');
    // A guest's address inside an event is shown as it is; another call's values by their fields.
    expect(chainCallLine({ signature_hash: 'x', title: 'Add a calendar event', signature: { op: 'tier1:calendar.create:local',
      pins: { 'attendees.email': ['ann@example.com'] } } })).toBe('Add a calendar event · Attendees email: ann@example.com');
    expect(chainCallLine({ signature_hash: 'x', signature: { op: 'step:send@h|mail-send||', pins: { to: ['ann@example.com'] } },
      pin_labels: { to: { 'ann@example.com': 'Ann Lee <ann@example.com>' } } })).toBe('mail-send · To: Ann Lee <ann@example.com>');
  });
});
