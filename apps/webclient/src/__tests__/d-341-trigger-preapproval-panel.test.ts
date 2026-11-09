/** D-341 slice B2b — "What it may do without asking" on a trigger's own page
 *  (`contracts/trigger-preapproval-panel.ts`): for each recipe the trigger starts, its pre-approvals
 *  (ended after one more step) and the writes it could make without asking, granted with how many
 *  times a run the owner chose, until they end it (ruling 10). A write a live one covers is not
 *  offered again; one that always asks is listed, not offered; a recipe that asks an AI is offered
 *  its writes, with a note that its AI decides what they carry (ruling 8). Focus stays where the
 *  owner is. The
 *  route mounts (a schedule's or a trigger's detail, a webhook's card) are the full-app e2e's
 *  (`e2e/trigger-preapproval.spec.ts`). */

import { describe, expect, it, vi } from 'vitest';
import type { TriggerPreapprovalChoice, TriggerPreapprovalTrigger, TriggerPreapprovalView } from '@recued/contracts';

import {
  createTriggerPreapprovalSupport,
  mountTriggerPreapprovalPanel,
  TRIGGER_PREAPPROVAL_PANEL_ATTR,
  TRIGGER_PREAPPROVAL_PANEL_AI_ATTR,
  TRIGGER_PREAPPROVAL_PANEL_CONFIRM_ATTR,
  TRIGGER_PREAPPROVAL_PANEL_END_ATTR,
  TRIGGER_PREAPPROVAL_PANEL_ERROR_ATTR,
  TRIGGER_PREAPPROVAL_PANEL_GRANT_ATTR,
  TRIGGER_PREAPPROVAL_PANEL_PER_RUN_ATTR,
  TRIGGER_PREAPPROVAL_PANEL_ROW_ATTR,
  TRIGGER_PREAPPROVAL_PANEL_WRITE_ATTR,
  type TriggerPreapprovalPanelCallers,
} from '../contracts/trigger-preapproval-panel.js';

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  value: string;
  checked: boolean;
  min: string;
  max: string;
  tabIndex: number;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  hidden: boolean;
  listeners: Map<string, Array<() => void>>;
  readonly firstChild: FakeEl | null;
  remove(): void;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  contains(other: FakeEl | null): boolean;
  addEventListener(type: string, fn: () => void): void;
  focus(): void;
  click(): void;
  fire(type: string): void;
}

const fakeDocument = () => {
  const doc = { activeElement: null as FakeEl | null, body: null as unknown as FakeEl, createElement: (tag: string) => element(tag) };
  const element = (tag: string): FakeEl => {
    const el: FakeEl = {
      tagName: tag.toUpperCase(), className: '', textContent: '', type: '', value: '', checked: false, min: '', max: '',
      tabIndex: 0, attrs: new Map(), children: [], parent: null, hidden: false, listeners: new Map(),
      get firstChild() { return el.children[0] ?? null; },
      remove() { el.parent?.removeChild(el); },
      setAttribute(k, v) { el.attrs.set(k, v); },
      getAttribute(k) { return el.attrs.get(k) ?? null; },
      appendChild(c) { el.children.push(c); c.parent = el; return c; },
      removeChild(c) {
        el.children.splice(el.children.indexOf(c), 1);
        c.parent = null;
        // As a browser does: focus inside a removed node falls to <body>.
        if (doc.activeElement !== null && (c === doc.activeElement || c.contains(doc.activeElement))) doc.activeElement = doc.body;
        return c;
      },
      contains(other) {
        for (let at = other; at !== null; at = at.parent) if (at === el) return true;
        return false;
      },
      addEventListener(type, fn) { el.listeners.set(type, [...(el.listeners.get(type) ?? []), fn]); },
      focus() { doc.activeElement = el; },
      click() { for (const fn of el.listeners.get('click') ?? []) fn(); },
      fire(type) { for (const fn of el.listeners.get(type) ?? []) fn(); },
    };
    return el;
  };
  doc.body = element('body');
  return doc;
};

const all = (root: FakeEl, attr: string, value?: string): FakeEl[] => [
  ...(root.attrs.has(attr) && (value === undefined || root.attrs.get(attr) === value) ? [root] : []),
  ...root.children.flatMap((c) => all(c, attr, value)),
];
const one = (root: FakeEl, attr: string, value?: string): FakeEl => {
  const found = all(root, attr, value);
  if (found.length !== 1) throw new Error(`expected one [${attr}${value !== undefined ? `=${value}` : ''}], found ${found.length}`);
  return found[0]!;
};
const text = (root: FakeEl): string => [root.textContent, ...root.children.map(text)].join(' ').replace(/\s+/gu, ' ');
const tick = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const NOW = Date.UTC(2026, 10, 8);
const SCHEDULE: TriggerPreapprovalTrigger = { kind: 'schedule', schedule_id: 'sch_1' };
const POST = 'post-note';
const SEND = 'recued-core.mail.message.send';
const REMOVE = 'recued-core.body-signals.daily_metric.delete';

const view = (over: Partial<TriggerPreapprovalView> = {}): TriggerPreapprovalView => ({
  id: 'tpa_1', trigger: SCHEDULE, recipe_id: 'daily-brief', recipe_sha256: 'a'.repeat(64),
  writes: [POST], max_per_run: 1, uses: 4, created_at: NOW, state: 'live', ai_steps: [],
  recipe_name: 'Daily brief', write_labels: ['Post a note to the team'], description: 'unused here',
  ...over,
});

const choice = (over: Partial<TriggerPreapprovalChoice> = {}): TriggerPreapprovalChoice => ({
  recipe_id: 'daily-brief', recipe_name: 'Daily brief', ai_steps: [],
  writes: [
    { op: POST, label: 'Post a note to the team', offerable: true },
    { op: SEND, label: 'Send an email', offerable: true },
    { op: REMOVE, label: 'Delete one daily reading', offerable: false, reason: 'It deletes or can\'t be undone.' },
  ],
  preapprovals: [],
  ...over,
});

const mount = (recipes: TriggerPreapprovalChoice[] | (() => Promise<{ recipes: TriggerPreapprovalChoice[] }>),
  over: Partial<TriggerPreapprovalPanelCallers> = {}, trigger: TriggerPreapprovalTrigger = SCHEDULE) => {
  const doc = fakeDocument();
  const host = doc.createElement('details');
  doc.body.appendChild(host);
  const choices = vi.fn(typeof recipes === 'function' ? recipes : async () => ({ recipes }));
  const grant = vi.fn(async (args: Parameters<TriggerPreapprovalPanelCallers['grant']>[0]) =>
    ({ preapproval: view({ id: 'tpa_new', writes: [...args.writes] }) }));
  const revoke = vi.fn(async (args: { id: string }) => ({ preapproval: view({ id: args.id, state: 'revoked', revoked_at: NOW }) }));
  const callers = { choices, grant, revoke, ...over };
  const panel = mountTriggerPreapprovalPanel({ host: host as never, trigger, callers, document: doc as never });
  const root = one(host, TRIGGER_PREAPPROVAL_PANEL_ATTR);
  return { doc, host, root, panel, callers };
};

describe('D-341 slice B2b — what a trigger\'s page shows', () => {
  it('names each recipe, lists its pre-approvals that cover something or say why not, and offers the rest', async () => {
    const { root, callers } = mount([choice({ preapprovals: [
      view(),
      view({ id: 'tpa_out', state: 'outdated', write_labels: ['Send an email'], writes: [SEND] }),
      view({ id: 'tpa_rev', state: 'revoked', revoked_at: NOW }),
    ] })]);
    expect(text(root)).toContain('Loading…');
    await tick();
    expect(callers.choices).toHaveBeenCalledWith({ trigger: SCHEDULE });
    expect(text(root)).toContain('Daily brief');
    expect(all(root, TRIGGER_PREAPPROVAL_PANEL_ROW_ATTR).map((row) => row.getAttribute(TRIGGER_PREAPPROVAL_PANEL_ROW_ATTR)))
      .toEqual(['tpa_1', 'tpa_out']);
    expect(text(one(root, TRIGGER_PREAPPROVAL_PANEL_ROW_ATTR, 'tpa_1'))).toContain('Without asking: Post a note to the team');
    expect(text(one(root, TRIGGER_PREAPPROVAL_PANEL_ROW_ATTR, 'tpa_1'))).toContain('Once a run · used 4 times · until you end it');
    expect(text(one(root, TRIGGER_PREAPPROVAL_PANEL_ROW_ATTR, 'tpa_out'))).toContain('Not in use: the recipe changed since.');
    // The live one covers the note, so only the email is offered: an outdated one covers nothing.
    expect(all(root, TRIGGER_PREAPPROVAL_PANEL_WRITE_ATTR).map((box) => box.getAttribute(TRIGGER_PREAPPROVAL_PANEL_WRITE_ATTR)))
      .toEqual([SEND]);
    expect(text(root)).toContain('Also let these happen without asking when this schedule runs it:');
    expect(text(root)).toContain('Always asks: Delete one daily reading. It deletes or can\'t be undone.');
    // How many times a run is the one bound it asks for: it lasts until the owner ends it.
    expect(PER_RUN(root).value).toBe('1');
    expect(all(root, 'data-recued-trigger-preapproval-uses')).toHaveLength(0);
    expect(all(root, 'data-recued-trigger-preapproval-days')).toHaveLength(0);
    expect(text(root)).toContain('It stays on until you end it.');
    expect(all(root, TRIGGER_PREAPPROVAL_PANEL_AI_ATTR)).toHaveLength(0);
  });

  it('on an auto-run\'s page, it says the recipe runs on its own (B1b), and grants for that timer', async () => {
    const timer = { kind: 'auto_run', dish_id: 'dsh_1' } as const;
    const { root, callers } = mount([choice()], {}, timer);
    await tick();
    expect(callers.choices).toHaveBeenCalledWith({ trigger: timer });
    expect(text(root)).toContain('Let these happen without asking when it runs on its own:');
    one(root, TRIGGER_PREAPPROVAL_PANEL_GRANT_ATTR).click();
    expect(callers.grant).toHaveBeenCalledWith({ trigger: timer, recipe_id: 'daily-brief', writes: [POST, SEND], max_per_run: 1 });
    // A webhook's says "this webhook".
    const hook = mount([choice()], {}, { kind: 'webhook', ingress_id: 'whi_1' });
    await tick();
    expect(text(hook.root)).toContain('Let these happen without asking when this webhook runs it:');
    // B4 — a form's says "this form", and grants for that form.
    const formTrigger = { kind: 'reception', endpoint_id: '-ep_1' } as const;
    const form = mount([choice()], {}, formTrigger);
    await tick();
    expect(form.callers.choices).toHaveBeenCalledWith({ trigger: formTrigger });
    expect(text(form.root)).toContain('Let these happen without asking when this form runs it:');
    one(form.root, TRIGGER_PREAPPROVAL_PANEL_GRANT_ATTR).click();
    expect(form.callers.grant).toHaveBeenCalledWith({ trigger: formTrigger, recipe_id: 'daily-brief', writes: [POST, SEND], max_per_run: 1 });
  });

  it('a recipe that asks an AI is offered its writes, and says its AI decides what it writes (ruling 8)', async () => {
    const { root } = mount([choice({ recipe_id: 'ai', recipe_name: 'Summarize new mail', ai_steps: ['summarize'],
      preapprovals: [view({ recipe_id: 'ai' })] })]);
    await tick();
    expect(text(one(root, TRIGGER_PREAPPROVAL_PANEL_AI_ATTR)).trim()).toBe('Its AI decides what it writes.');
    expect(all(root, TRIGGER_PREAPPROVAL_PANEL_WRITE_ATTR).map((box) => box.getAttribute(TRIGGER_PREAPPROVAL_PANEL_WRITE_ATTR)))
      .toEqual([SEND]);
    expect(all(root, TRIGGER_PREAPPROVAL_PANEL_GRANT_ATTR)).toHaveLength(1);
  });

  it('one with no write that asks says so; a covered one shows no form, and its AI note still shows', async () => {
    const { root } = mount([
      choice({ recipe_id: 'quiet', recipe_name: 'Quiet one', writes: [] }),
      choice({ recipe_id: 'covered', recipe_name: 'Covered one', ai_steps: ['summarize'],
        writes: [{ op: POST, label: 'Post a note to the team', offerable: true }], preapprovals: [view({ recipe_id: 'covered' })] }),
    ]);
    await tick();
    expect(text(root)).toContain('It makes no change that asks you.');
    expect(all(root, TRIGGER_PREAPPROVAL_PANEL_WRITE_ATTR)).toHaveLength(0);
    expect(all(root, TRIGGER_PREAPPROVAL_PANEL_GRANT_ATTR)).toHaveLength(0);
    expect(all(root, TRIGGER_PREAPPROVAL_PANEL_AI_ATTR)).toHaveLength(1);
  });

  it('a trigger that runs nothing says so; a list it could not load says why, without the method\'s name', async () => {
    expect(text((await (async () => { const m = mount([]); await tick(); return m; })()).root)).toContain('It runs no recipe now.');
    const failing = mount(async () => { throw new Error('collection.contract.triggerPreapprovalChoices: triggers cannot be checked here'); });
    await tick();
    expect(text(one(failing.root, TRIGGER_PREAPPROVAL_PANEL_ERROR_ATTR)).trim())
      .toBe('Recued could not load what this may do without asking: triggers cannot be checked here');
  });
});

const PER_RUN = (root: FakeEl) => one(root, TRIGGER_PREAPPROVAL_PANEL_PER_RUN_ATTR);
const type = (input: FakeEl, value: string) => { input.value = value; input.fire('input'); };
const untick = (root: FakeEl, op: string) => {
  const box = one(root, TRIGGER_PREAPPROVAL_PANEL_WRITE_ATTR, op);
  box.checked = false;
  box.fire('change');
};

describe('D-341 slice B2b — "Allow without asking"', () => {
  it('grants the ticked writes with the owner\'s bounds, one at a time, focus on it while it runs', async () => {
    const answer = deferred<{ preapproval: TriggerPreapprovalView }>();
    let listed = [choice()];
    const { root, panel, callers, doc } = mount(async () => ({ recipes: listed }), { grant: vi.fn(() => answer.promise) });
    await tick();
    untick(root, POST);
    type(PER_RUN(root), '2');
    one(root, TRIGGER_PREAPPROVAL_PANEL_GRANT_ATTR).click();
    // No end date, no use cap: what it asks for is the writes and how many a run (ruling 10).
    expect(callers.grant).toHaveBeenCalledWith({ trigger: SCHEDULE, recipe_id: 'daily-brief', writes: [SEND], max_per_run: 2 });
    const working = one(root, TRIGGER_PREAPPROVAL_PANEL_GRANT_ATTR);
    expect(working.textContent).toBe('Working…');
    expect(working.getAttribute('aria-busy')).toBe('true');
    expect(doc.activeElement).toBe(working);
    expect(panel.pending()).toBe(true);
    // Every control says it is unavailable, and pressing one does nothing.
    expect(all(root, TRIGGER_PREAPPROVAL_PANEL_GRANT_ATTR).every((b) => b.getAttribute('aria-disabled') === 'true')).toBe(true);
    working.click();
    expect(callers.grant).toHaveBeenCalledTimes(1);
    listed = [choice({ preapprovals: [view({ id: 'tpa_new', writes: [SEND], write_labels: ['Send an email'] })] })];
    answer.resolve({ preapproval: listed[0]!.preapprovals[0]! });
    await tick();
    expect(panel.pending()).toBe(false);
    expect(callers.choices).toHaveBeenCalledTimes(2);
    expect(text(one(root, TRIGGER_PREAPPROVAL_PANEL_ROW_ATTR, 'tpa_new'))).toContain('Without asking: Send an email');
    // The note is still on offer, as the owner left it: unticked, with the times a run they typed.
    const box = one(root, TRIGGER_PREAPPROVAL_PANEL_WRITE_ATTR, POST);
    expect(box.checked).toBe(false);
    expect(PER_RUN(root).value).toBe('2');
    expect(doc.activeElement).toBe(one(root, TRIGGER_PREAPPROVAL_PANEL_GRANT_ATTR));
  });

  it('when the grant leaves nothing to offer, focus goes to the panel', async () => {
    let listed = [choice({ writes: [{ op: POST, label: 'Post a note to the team', offerable: true }] })];
    const { root, doc } = mount(async () => ({ recipes: listed }));
    await tick();
    listed = [choice({ writes: listed[0]!.writes, preapprovals: [view()] })];
    one(root, TRIGGER_PREAPPROVAL_PANEL_GRANT_ATTR).click();
    await tick();
    expect(all(root, TRIGGER_PREAPPROVAL_PANEL_GRANT_ATTR)).toHaveLength(0);
    expect(doc.activeElement).toBe(root);
    expect(root.tabIndex).toBe(-1);
  });

  it('asks for a tick and a whole number of times a run, 1 to 100, before it calls anything', async () => {
    const { root, callers, doc } = mount([choice()]);
    await tick();
    untick(root, POST);
    untick(root, SEND);
    one(root, TRIGGER_PREAPPROVAL_PANEL_GRANT_ATTR).click();
    expect(text(one(root, TRIGGER_PREAPPROVAL_PANEL_ERROR_ATTR))).toContain('Tick at least one change to allow.');
    expect(doc.activeElement).toBe(one(root, TRIGGER_PREAPPROVAL_PANEL_GRANT_ATTR));
    one(root, TRIGGER_PREAPPROVAL_PANEL_WRITE_ATTR, SEND).checked = true;
    one(root, TRIGGER_PREAPPROVAL_PANEL_WRITE_ATTR, SEND).fire('change');
    for (const value of ['0', '101', '2.5', '']) {
      type(PER_RUN(root), value);
      one(root, TRIGGER_PREAPPROVAL_PANEL_GRANT_ATTR).click();
      expect(text(one(root, TRIGGER_PREAPPROVAL_PANEL_ERROR_ATTR)), `${value}`)
        .toContain('Times a run is a whole number from 1 to 100.');
    }
    expect(callers.grant).not.toHaveBeenCalled();
  });

  it('a refused grant says why, in the server\'s words, and leaves the form as the owner set it', async () => {
    const { root, panel } = mount([choice()], { grant: vi.fn(async () => {
      throw new Error('collection.contract.grantTriggerPreapproval: Daily brief changed since you opened this');
    }) });
    await tick();
    untick(root, POST);
    type(PER_RUN(root), '12');
    one(root, TRIGGER_PREAPPROVAL_PANEL_GRANT_ATTR).click();
    await tick();
    const error = one(root, TRIGGER_PREAPPROVAL_PANEL_ERROR_ATTR);
    expect(error.getAttribute('role')).toBe('alert');
    expect(text(error).trim()).toBe('Daily brief changed since you opened this');
    expect(one(root, TRIGGER_PREAPPROVAL_PANEL_WRITE_ATTR, POST).checked).toBe(false);
    expect(PER_RUN(root).value).toBe('12');
    expect(panel.pending()).toBe(false);
  });

  it('an owner who moved on while it ran keeps their place', async () => {
    const answer = deferred<{ preapproval: TriggerPreapprovalView }>();
    const { root, doc } = mount([choice()], { grant: vi.fn(() => answer.promise) });
    await tick();
    one(root, TRIGGER_PREAPPROVAL_PANEL_GRANT_ATTR).click();
    const elsewhere = doc.createElement('input');
    doc.body.appendChild(elsewhere);
    elsewhere.focus();
    answer.resolve({ preapproval: view() });
    await tick();
    expect(doc.activeElement).toBe(elsewhere);
  });
});

describe('D-341 slice B2b — "End it"', () => {
  it('asks once more, then ends it; Cancel puts focus back on "End it"', async () => {
    let listed = [choice({ preapprovals: [view()] })];
    const { root, callers, doc } = mount(async () => ({ recipes: listed }));
    await tick();
    one(root, TRIGGER_PREAPPROVAL_PANEL_END_ATTR, '').click();
    expect(text(one(root, TRIGGER_PREAPPROVAL_PANEL_ROW_ATTR, 'tpa_1'))).toContain('It asks again from now on.');
    expect(doc.activeElement).toBe(one(root, TRIGGER_PREAPPROVAL_PANEL_CONFIRM_ATTR));
    one(root, 'data-recued-trigger-preapproval-cancel').click();
    expect(callers.revoke).not.toHaveBeenCalled();
    expect(doc.activeElement).toBe(one(root, TRIGGER_PREAPPROVAL_PANEL_END_ATTR));
    one(root, TRIGGER_PREAPPROVAL_PANEL_END_ATTR).click();
    listed = [choice({ preapprovals: [view({ state: 'revoked', revoked_at: NOW })] })];
    one(root, TRIGGER_PREAPPROVAL_PANEL_CONFIRM_ATTR).click();
    expect(callers.revoke).toHaveBeenCalledWith({ id: 'tpa_1' });
    await tick();
    expect(all(root, TRIGGER_PREAPPROVAL_PANEL_ROW_ATTR)).toHaveLength(0);
    // The note is on offer again, and focus waits on the panel.
    expect(all(root, TRIGGER_PREAPPROVAL_PANEL_WRITE_ATTR, POST)).toHaveLength(1);
    expect(doc.activeElement).toBe(root);
  });

  it('a refused end stays asking, says why, focus on the confirm', async () => {
    const { root, doc } = mount([choice({ preapprovals: [view()] })], { revoke: vi.fn(async () => {
      throw new Error('collection.contract.revokeTriggerPreapproval: no pre-approval tpa_1');
    }) });
    await tick();
    one(root, TRIGGER_PREAPPROVAL_PANEL_END_ATTR).click();
    one(root, TRIGGER_PREAPPROVAL_PANEL_CONFIRM_ATTR).click();
    await tick();
    expect(text(one(root, TRIGGER_PREAPPROVAL_PANEL_ERROR_ATTR)).trim()).toBe('no pre-approval tpa_1');
    expect(doc.activeElement).toBe(one(root, TRIGGER_PREAPPROVAL_PANEL_CONFIRM_ATTR));
  });
});

describe('D-341 slice B2b — its life on the page', () => {
  it('disposed, it leaves its host and paints nothing late', async () => {
    const listed = deferred<{ recipes: TriggerPreapprovalChoice[] }>();
    const { host, panel } = mount(() => listed.promise);
    panel.dispose();
    expect(all(host, TRIGGER_PREAPPROVAL_PANEL_ATTR)).toHaveLength(0);
    listed.resolve({ recipes: [choice()] });
    await tick();
    expect(all(host, TRIGGER_PREAPPROVAL_PANEL_ATTR)).toHaveLength(0);
  });

  it('an older list that answers late is not painted over a newer one', async () => {
    const first = deferred<{ recipes: TriggerPreapprovalChoice[] }>();
    const answers = [first.promise, Promise.resolve({ recipes: [choice({ recipe_name: 'Newer' })] })];
    const { root, panel } = mount(() => answers.shift()!);
    await panel.refresh();
    first.resolve({ recipes: [choice({ recipe_name: 'Older' })] });
    await tick();
    expect(text(root)).toContain('Newer');
    expect(text(root)).not.toContain('Older');
  });
});

describe('D-341 slice B3 — a scheduled prompt\'s card', () => {
  const PROMPT = { kind: 'prompt_schedule', schedule_id: 'ps_1' } as const;
  const promptRow = (over: Partial<TriggerPreapprovalView> = {}) => view({
    id: 'tpa_prompt', trigger: PROMPT, recipe_id: 'ps_1', writes: ['work.create:task'], write_labels: ['Add a task'],
    ai_steps: ['prompt'], recipe_name: 'Morning bills', ...over,
  });
  const promptChoice = (over: Partial<TriggerPreapprovalChoice> = {}) =>
    choice({ recipe_id: 'ps_1', recipe_name: 'Morning bills', ai_steps: ['prompt'], writes: [], ...over });

  it('lists its pre-approvals, says its AI decides, and how to allow a change from its ask; offers none here', async () => {
    const { root, callers } = mount([promptChoice({ preapprovals: [promptRow()] })], {}, PROMPT);
    await tick();
    expect(callers.choices).toHaveBeenCalledWith({ trigger: PROMPT });
    expect(text(one(root, TRIGGER_PREAPPROVAL_PANEL_AI_ATTR)).trim()).toBe('Its AI decides what it writes.');
    expect(text(root)).toContain('Without asking: Add a task');
    expect(text(root)).toContain('Its other changes still ask you. To stop asking about one, answer “Always allow for this scheduled'
      + ' prompt” on its ask.');
    expect(all(root, TRIGGER_PREAPPROVAL_PANEL_GRANT_ATTR)).toHaveLength(0);
    expect(all(root, TRIGGER_PREAPPROVAL_PANEL_WRITE_ATTR)).toHaveLength(0);
    // Ended from here, as any other.
    one(root, TRIGGER_PREAPPROVAL_PANEL_END_ATTR).click();
    one(root, TRIGGER_PREAPPROVAL_PANEL_CONFIRM_ATTR).click();
    expect(callers.revoke).toHaveBeenCalledWith({ id: 'tpa_prompt' });
  });

  it('with none, says its changes ask; one for an edited prompt says so; a prompt it cannot read says so', async () => {
    const empty = mount([promptChoice()], {}, PROMPT);
    await tick();
    expect(text(empty.root)).toContain('Its changes ask you. To stop asking about one, answer “Always allow for this scheduled prompt”'
      + ' on its ask.');
    expect(text(empty.root)).not.toContain('It makes no change that asks you.');
    const edited = mount([promptChoice({ preapprovals: [promptRow({ state: 'outdated' })] })], {}, PROMPT);
    await tick();
    expect(text(edited.root)).toContain('Not in use: its prompt changed since.');
    const unread = mount([], {}, PROMPT);
    await tick();
    expect(text(unread.root)).toContain('Recued could not read this scheduled prompt now.');
    expect(text(unread.root)).not.toContain('It runs no recipe now.');
  });
});

describe('D-341 — a server from before pre-approvals shows no "What it may do without asking"', () => {
  const tooOld = (): Error => Object.assign(new Error('collection.contract.triggerPreapprovalChoices: unknown method'), { code: 'unknown_method' });
  const timedOut = (): Error => Object.assign(new Error('The server did not answer in time.'), { code: 'timeout' });

  it('the panel takes its section away, rather than saying it could not load', async () => {
    const { host, panel } = mount(async () => { throw tooOld(); });
    await panel.whenLoaded(); await tick();
    expect(host.hidden).toBe(true);
    expect(all(host, TRIGGER_PREAPPROVAL_PANEL_ERROR_ATTR)).toEqual([]);
    expect(all(host, TRIGGER_PREAPPROVAL_PANEL_ATTR)).toEqual([]);
  });

  it('a read that fails another way still says why, in a section that stays', async () => {
    const { host, panel } = mount(async () => { throw timedOut(); });
    await panel.whenLoaded(); await tick();
    expect(host.hidden).toBe(false);
    expect(text(one(host, TRIGGER_PREAPPROVAL_PANEL_ERROR_ATTR))).toContain('Recued could not load what this may do without asking');
  });

  it('a page asks once, then hides every section it made, and any it makes later', async () => {
    const doc = fakeDocument();
    const answer = deferred<never>();
    const choices = vi.fn(() => answer.promise);
    const support = createTriggerPreapprovalSupport(choices);
    const first = doc.createElement('details'), second = doc.createElement('details');
    support.show(first as never, SCHEDULE);
    support.show(second as never, { kind: 'webhook', ingress_id: 'whi_1' });
    // Shown until the server answers.
    expect([first.hidden, second.hidden]).toEqual([false, false]);
    expect(choices.mock.calls).toEqual([[{ trigger: SCHEDULE }]]);
    answer.reject(tooOld()); await tick();
    expect([first.hidden, second.hidden]).toEqual([true, true]);
    const later = doc.createElement('details');
    support.show(later as never, SCHEDULE);
    expect(later.hidden).toBe(true);
    expect(choices).toHaveBeenCalledTimes(1);
  });

  it('a server that offers them keeps every section, asked once; a read that failed another way is asked again', async () => {
    const doc = fakeDocument();
    const offered = vi.fn(async () => ({ recipes: [] }));
    const support = createTriggerPreapprovalSupport(offered);
    const sections = [doc.createElement('details'), doc.createElement('details')];
    support.show(sections[0] as never, SCHEDULE); await tick();
    support.show(sections[1] as never, SCHEDULE); await tick();
    expect(sections.map((one) => one.hidden)).toEqual([false, false]);
    expect(offered).toHaveBeenCalledTimes(1);

    const flaky = vi.fn().mockRejectedValueOnce(timedOut()).mockResolvedValue({ recipes: [] });
    const again = createTriggerPreapprovalSupport(flaky);
    const before = doc.createElement('details'), after = doc.createElement('details');
    again.show(before as never, SCHEDULE); await tick();
    expect(before.hidden).toBe(false);
    again.show(after as never, SCHEDULE); await tick();
    expect(flaky).toHaveBeenCalledTimes(2);
    expect([before.hidden, after.hidden]).toEqual([false, false]);
  });
});

