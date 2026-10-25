/** D-329 §3.4 — the Contracts panel for the write rules an AI's approvals teach: a
 *  suggestion is accepted within tighten-only bounds or dismissed for good, and a live rule
 *  is ended — each a deliberate second step. */

import { describe, expect, it, vi } from 'vitest';
import {
  WRITE_RULE_MAX_USES,
  WRITE_RULE_TTL_MS,
  type WriteRuleRow,
  type WriteRuleSuggestionRow,
} from '@recued/contracts';

import {
  mountWriteRulesPanel,
  WRITE_RULES_ACCEPT_ATTR,
  WRITE_RULES_CONFIRM_ATTR,
  WRITE_RULES_DAYS_ATTR,
  WRITE_RULES_DISMISS_ATTR,
  WRITE_RULES_ERROR_ATTR,
  WRITE_RULES_MINT_ATTR,
  WRITE_RULES_REVOKE_ATTR,
  WRITE_RULES_RULE_ATTR,
  WRITE_RULES_SUGGESTION_ATTR,
  WRITE_RULES_USES_ATTR,
} from '../contracts/write-rules-panel.js';

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

const NOW = 1_760_000_000_000;
const suggestion: WriteRuleSuggestionRow = {
  key_hash: 'kh-1',
  key: { principal: { kind: 'owner_chat' }, tool: 'work.create', scope: 'task' },
  evidence: { approvals: 4, occasions: 3, refused: false, first_at: NOW - 3 * 86_400_000, last_at: NOW, suggest: true },
  suggested_at: NOW,
};
const rule: WriteRuleRow = {
  rule_id: 'rule-1', key_hash: 'kh-2',
  key: { principal: { kind: 'ai_app', contract_id: 'ct-claude' }, tool: 'calendar.create', scope: 'local' },
  created_at: NOW, expires_at: NOW + 10 * 86_400_000, max_uses: 100, uses_remaining: 97,
};

const mount = (lists: { suggestions?: WriteRuleSuggestionRow[]; rules?: WriteRuleRow[] } = {}) => {
  const host = element('div');
  const state = { suggestions: lists.suggestions ?? [suggestion], rules: lists.rules ?? [rule] };
  const accept = vi.fn(async (args: { key_hash: string; ttl_ms?: number; max_uses?: number }) => {
    state.suggestions = [];
    return { rule: { ...rule, rule_id: 'rule-new' }, suggestion: { ...suggestion, key_hash: args.key_hash } };
  });
  const dismiss = vi.fn(async (args: { key_hash: string }) => { state.suggestions = []; return args; });
  const revoke = vi.fn(async (args: { rule_id: string }) => { state.rules = []; return { rule: { ...rule, revoked_at: NOW } }; });
  const panel = mountWriteRulesPanel({
    host: host as never,
    document: { createElement: element } as never,
    listSuggestions: async () => ({ suggestions: state.suggestions }),
    listRules: async () => ({ rules: state.rules }),
    accept, dismiss, revoke,
    listContracts: async () => ({ contracts: [{ contract_id: 'ct-claude', display_name: 'Claude Desktop' }] }),
  });
  return { host, panel, accept, dismiss, revoke };
};

describe('D-329 §3.4 — the write rules panel', () => {
  it('shows nothing when there is nothing to decide', async () => {
    const h = mount({ suggestions: [], rules: [] });
    await h.panel.whenLoaded();
    expect(h.host.children[0]!.children).toHaveLength(0);
  });

  it('says what a suggestion would let happen, who asks, and what earned it', async () => {
    const h = mount();
    await h.panel.whenLoaded();
    const [card] = all(h.host, WRITE_RULES_SUGGESTION_ATTR);
    expect(text(card!)).toContain('Add a task, note or more, for task');
    expect(text(card!)).toContain('Asked by your chats');
    expect(text(card!)).toContain('You said yes 4 times, on 3 different occasions');
    const [live] = all(h.host, WRITE_RULES_RULE_ATTR);
    expect(text(live!)).toContain('Add a calendar event, for your Recued calendar');
    expect(text(live!)).toContain('Asked by Claude Desktop');
    expect(text(live!)).toContain('97 of 100 left');
  });

  it('accepts only after the bounds are shown, within the ceilings, tighter if asked', async () => {
    const h = mount();
    await h.panel.whenLoaded();
    all(h.host, WRITE_RULES_ACCEPT_ATTR)[0]!.click();
    expect(h.accept).not.toHaveBeenCalled();
    const days = all(h.host, WRITE_RULES_DAYS_ATTR)[0]!;
    const uses = all(h.host, WRITE_RULES_USES_ATTR)[0]!;
    expect(days.value).toBe(String(WRITE_RULE_TTL_MS / 86_400_000));
    expect(uses.value).toBe(String(WRITE_RULE_MAX_USES));
    uses.value = String(WRITE_RULE_MAX_USES + 1);
    all(h.host, WRITE_RULES_MINT_ATTR)[0]!.click();
    expect(h.accept).not.toHaveBeenCalled();
    expect(all(h.host, WRITE_RULES_ERROR_ATTR)).toHaveLength(1);
    all(h.host, WRITE_RULES_USES_ATTR)[0]!.value = '10';
    all(h.host, WRITE_RULES_DAYS_ATTR)[0]!.value = '7';
    all(h.host, WRITE_RULES_MINT_ATTR)[0]!.click();
    await tick();
    expect(h.accept).toHaveBeenCalledWith({ key_hash: 'kh-1', ttl_ms: 7 * 86_400_000, max_uses: 10 });
    await h.panel.whenLoaded();
    expect(all(h.host, WRITE_RULES_SUGGESTION_ATTR)).toHaveLength(0);
  });

  it('dismisses only after saying it is for good', async () => {
    const h = mount();
    await h.panel.whenLoaded();
    all(h.host, WRITE_RULES_DISMISS_ATTR)[0]!.click();
    expect(h.dismiss).not.toHaveBeenCalled();
    expect(text(h.host)).toContain('Recued will not suggest this again.');
    all(h.host, WRITE_RULES_CONFIRM_ATTR)[0]!.click();
    await tick();
    expect(h.dismiss).toHaveBeenCalledWith({ key_hash: 'kh-1' });
  });

  it('ends a rule only after asking once more', async () => {
    const h = mount({ suggestions: [] });
    await h.panel.whenLoaded();
    all(h.host, WRITE_RULES_REVOKE_ATTR)[0]!.click();
    expect(h.revoke).not.toHaveBeenCalled();
    all(h.host, WRITE_RULES_CONFIRM_ATTR)[0]!.click();
    await tick();
    expect(h.revoke).toHaveBeenCalledWith({ rule_id: 'rule-1' });
    await h.panel.whenLoaded();
    expect(all(h.host, WRITE_RULES_RULE_ATTR)).toHaveLength(0);
  });
});
