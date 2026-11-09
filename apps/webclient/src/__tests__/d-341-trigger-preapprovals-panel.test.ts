/** D-341 slice B2 — the triggers' pre-approvals on the Contracts panel, among the things happening
 *  without asking: what each lets its recipe do (in the owner's words), which trigger, what is left of
 *  it, and why one that covers nothing now is still listed; ended after one more step. Ended, used up
 *  and revoked ones are not listed. */

import { describe, expect, it, vi } from 'vitest';
import type { TriggerPreapprovalView } from '@recued/contracts';

import {
  mountWriteRulesPanel,
  TRIGGER_PREAPPROVAL_ATTR,
  TRIGGER_PREAPPROVAL_END_ATTR,
  WRITE_RULES_CONFIRM_ATTR,
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
const view = (over: Partial<TriggerPreapprovalView> = {}): TriggerPreapprovalView => ({
  id: 'tpa_1', trigger: { kind: 'webhook', ingress_id: 'whi_1' }, door_contract_id: 'door-1',
  recipe_id: 'receive-body-metrics-apple-health', recipe_sha256: 'a'.repeat(64),
  writes: ['recued-core.body-signals.daily_metric.batch'], max_per_run: 1, uses: 4,
  created_at: NOW, state: 'live', ai_steps: [],
  recipe_name: 'Receive Apple Health readings',
  write_labels: ['Save up to 100 daily readings in one transaction, all or none'],
  description: 'unused here',
  ...over,
});

const mount = (rows: TriggerPreapprovalView[], wired = true) => {
  const host = element('div');
  let state = rows;
  const revoke = vi.fn(async (args: { id: string }) => {
    state = state.filter((row) => row.id !== args.id);
    return { preapproval: view({ id: args.id, state: 'revoked', revoked_at: NOW }) };
  });
  const panel = mountWriteRulesPanel({
    host: host as never,
    document: { createElement: element } as never,
    listSuggestions: async () => ({ suggestions: [] }),
    listRules: async () => ({ rules: [] }),
    accept: vi.fn(), dismiss: vi.fn(), revoke: vi.fn(),
    ...(wired ? { triggers: { list: async () => ({ preapprovals: state }), revoke } } : {}),
  });
  return { host, panel, revoke };
};

describe('D-341 slice B2 — the triggers\' pre-approvals on the Contracts panel', () => {
  it('lists a live one with what it does, which trigger, how often it was used, and that it lasts until ended', async () => {
    const h = mount([view(), view({ id: 'tpa_ai', ai_steps: ['summarize'] })]);
    await h.panel.whenLoaded();
    expect(text(h.host)).toContain('Happening without asking');
    const [card, ai] = all(h.host, TRIGGER_PREAPPROVAL_ATTR);
    expect(text(card!)).toContain('Save up to 100 daily readings in one transaction, all or none');
    expect(text(card!)).toContain('Receive Apple Health readings, when its webhook runs it');
    expect(text(card!)).toContain('Once a run · used 4 times · until you end it');
    expect(text(card!)).not.toContain('recued-core.body-signals');
    expect(text(card!)).not.toContain('Its AI decides');
    // A recipe that asks an AI says so (ruling 8).
    expect(text(ai!)).toContain('Its AI decides what it writes.');
  });

  it('names an auto-run\'s as running on its own (B1b)', async () => {
    const h = mount([view({ id: 'tpa_timer', trigger: { kind: 'auto_run', dish_id: 'dsh_1' }, door_contract_id: undefined,
      recipe_name: 'Watch pipeline' })]);
    await h.panel.whenLoaded();
    expect(text(all(h.host, TRIGGER_PREAPPROVAL_ATTR)[0]!)).toContain('Watch pipeline, when it runs on its own');
  });

  it('names a form\'s by its form (B4)', async () => {
    const h = mount([view({ id: 'tpa_form', trigger: { kind: 'reception', endpoint_id: '-ep_1' }, door_contract_id: 'door-r1',
      recipe_name: 'Book a table' })]);
    await h.panel.whenLoaded();
    expect(text(all(h.host, TRIGGER_PREAPPROVAL_ATTR)[0]!)).toContain('Book a table, when its form runs it');
  });

  it('names a scheduled prompt\'s as running on its schedule, and an edited prompt\'s as changed (B3)', async () => {
    const PROMPT = { kind: 'prompt_schedule', schedule_id: 'ps_1' } as const;
    const h = mount([
      view({ id: 'tpa_prompt', trigger: PROMPT, door_contract_id: undefined, recipe_id: 'ps_1', recipe_name: 'Morning bills',
        writes: ['work.create:task'], write_labels: ['Add a task'], ai_steps: ['prompt'] }),
      view({ id: 'tpa_edited', trigger: PROMPT, door_contract_id: undefined, recipe_id: 'ps_1', recipe_name: 'Morning bills',
        writes: ['work.create:task'], write_labels: ['Add a task'], ai_steps: ['prompt'], state: 'outdated' }),
    ]);
    await h.panel.whenLoaded();
    const [live, edited] = all(h.host, TRIGGER_PREAPPROVAL_ATTR);
    expect(text(live!)).toContain('Morning bills, when it runs on its schedule');
    expect(text(live!)).toContain('Its AI decides what it writes.');
    expect(text(edited!)).toContain('Not in use: its prompt changed since.');
  });

  it('reads one from a server that sends no AI steps', async () => {
    const { ai_steps: _dropped, ...older } = view();
    const h = mount([older as TriggerPreapprovalView]);
    await h.panel.whenLoaded();
    expect(all(h.host, TRIGGER_PREAPPROVAL_ATTR)).toHaveLength(1);
  });

  it('says why one that covers nothing now is still listed, and leaves out the ended ones', async () => {
    const h = mount([
      view({ id: 'tpa_out', state: 'outdated', trigger: { kind: 'schedule', schedule_id: 'sch_1' } }),
      view({ id: 'tpa_det', state: 'detached', trigger: { kind: 'event_trigger', trigger_id: 'trg_1' } }),
      view({ id: 'tpa_rev', state: 'revoked' }),
    ]);
    await h.panel.whenLoaded();
    const cards = all(h.host, TRIGGER_PREAPPROVAL_ATTR);
    expect(cards.map((card) => card.getAttribute(TRIGGER_PREAPPROVAL_ATTR))).toEqual(['tpa_out', 'tpa_det']);
    expect(text(cards[0]!)).toContain('when its schedule runs it');
    expect(text(cards[0]!)).toContain('Not in use: the recipe changed since, or is gone.');
    expect(text(cards[1]!)).toContain('when its trigger runs it');
    expect(text(cards[1]!)).toContain('Not in use: its trigger no longer runs this recipe as it did.');
  });

  it('ends one after one more step', async () => {
    const h = mount([view()]);
    await h.panel.whenLoaded();
    all(h.host, TRIGGER_PREAPPROVAL_END_ATTR)[0]!.click();
    expect(h.revoke).not.toHaveBeenCalled();
    expect(text(h.host)).toContain('It asks again from now on.');
    all(h.host, WRITE_RULES_CONFIRM_ATTR)[0]!.click();
    await tick();
    expect(h.revoke).toHaveBeenCalledWith({ id: 'tpa_1' });
    await h.panel.whenLoaded();
    expect(all(h.host, TRIGGER_PREAPPROVAL_ATTR)).toHaveLength(0);
  });

  it('shows none when there are none, or when the page is not given them', async () => {
    for (const h of [mount([]), mount([view()], false)]) {
      await h.panel.whenLoaded();
      expect(h.host.children[0]!.children).toHaveLength(0);
    }
  });
});
