/** Settings → Learning panel (D-219 slice 9c).
 *
 *  The one control that governs whether Recued ever asks how a multi-step turn
 *  turned out — and therefore whether anything becomes precedent at all.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_INSTANCE_PREFS,
  type ExecutionCaseLearnedEntry,
  type InstancePrefs,
} from '@recued/contracts';

import {
  mountLearningPanel,
  LEARNING_PANEL_CASE_ATTR,
  LEARNING_PANEL_CASE_AUTHORED_ATTR,
  LEARNING_PANEL_CASE_INERT_ATTR,
  LEARNING_PANEL_CASES_ATTR,
  LEARNING_PANEL_CASES_EMPTY_ATTR,
  LEARNING_PANEL_CASES_ERROR_ATTR,
  LEARNING_PANEL_DRAFT_ATTR,
  LEARNING_PANEL_DRAFT_CONFIRM_ATTR,
  LEARNING_PANEL_DRAFT_ERROR_ATTR,
  LEARNING_PANEL_DRAFT_PROMPT_ATTR,
  LEARNING_PANEL_ERROR_ATTR,
  LEARNING_PANEL_FORGET_ATTR,
  LEARNING_PANEL_FORGET_ERROR_ATTR,
  LEARNING_PANEL_HOST_ATTR,
  LEARNING_PANEL_STYLES,
  LEARNING_PANEL_OFF_HINT_ATTR,
  LEARNING_PANEL_TOGGLE_ATTR,
  type LearningDraftRecipeCaller,
} from '../learning-panel.js';

// ── minimal fake DOM (mirrors the other webclient render tests) ──
interface FakeElement {
  tagName: string;
  textContent: string;
  className: string;
  checked: boolean;
  disabled: boolean;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  listeners: Map<string, Array<() => void>>;
  readonly firstChild: FakeElement | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  removeAttribute(k: string): void;
  appendChild(el: FakeElement): FakeElement;
  removeChild(el: FakeElement): FakeElement;
  addEventListener(type: string, fn: () => void): void;
  querySelector(selector: string): FakeElement | null;
  querySelectorAll(selector: string): FakeElement[];
  focus(): void;
  dispatchChange(): void;
  dispatchClick(): void;
  dispatchInput(): void;
  value: string;
}

const makeFakeElement = (
  tagName: string,
  onFocus?: (element: FakeElement) => void,
): FakeElement => {
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    className: '',
    checked: false,
    disabled: false,
    value: '',
    children: [],
    parent: null,
    attrs: new Map(),
    listeners: new Map(),
    get firstChild() { return el.children[0] ?? null; },
    setAttribute(k, v) { el.attrs.set(k, v); },
    getAttribute(k) { return el.attrs.get(k) ?? null; },
    hasAttribute(k) { return el.attrs.has(k); },
    removeAttribute(k) { el.attrs.delete(k); },
    appendChild(child) { el.children.push(child); child.parent = el; return child; },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i >= 0) { el.children.splice(i, 1); child.parent = null; }
      return child;
    },
    addEventListener(type, fn) {
      const list = el.listeners.get(type) ?? [];
      list.push(fn);
      el.listeners.set(type, list);
    },
    querySelector(selector) {
      return el.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector) {
      const match = /^\[([^\]=]+)\]$/.exec(selector);
      if (!match) return [];
      const attr = match[1]!;
      const matches: FakeElement[] = [];
      const visit = (root: FakeElement): void => {
        for (const child of root.children) {
          if (child.hasAttribute(attr)) matches.push(child);
          visit(child);
        }
      };
      visit(el);
      return matches;
    },
    focus() { onFocus?.(el); },
    dispatchChange() {
      for (const fn of el.listeners.get('change') ?? []) fn();
    },
    dispatchClick() {
      for (const fn of el.listeners.get('click') ?? []) fn();
    },
    dispatchInput() {
      for (const fn of el.listeners.get('input') ?? []) fn();
    },
  };
  return el;
};

interface FakeDocument {
  activeElement: FakeElement | null;
  createElement(tagName: string): FakeElement;
}

const makeFakeDocument = (): FakeDocument => {
  const doc: FakeDocument = {
    activeElement: null,
    createElement: (tagName) => makeFakeElement(tagName, (element) => {
      doc.activeElement = element;
    }),
  };
  return doc;
};

const findAllByAttr = (
  root: FakeElement, attr: string, out: FakeElement[] = [],
): FakeElement[] => {
  if (root.hasAttribute(attr)) out.push(root);
  for (const c of root.children) findAllByAttr(c, attr, out);
  return out;
};
const findByAttr = (root: FakeElement, attr: string): FakeElement | null =>
  findAllByAttr(root, attr)[0] ?? null;
const textOf = (el: FakeElement): string =>
  `${el.textContent}${el.children.map(textOf).join('')}`;

const prefs = (over: Partial<InstancePrefs> = {}): InstancePrefs => ({
  ...DEFAULT_INSTANCE_PREFS,
  ...over,
});

const mount = (opts: {
  get?: () => Promise<{ prefs: InstancePrefs }>;
  set?: (args: { patch: Partial<InstancePrefs> }) => Promise<{ prefs: InstancePrefs }>;
} = {}) => {
  const host = makeFakeElement('div');
  const doc = makeFakeDocument();
  const runPrefsSet = vi.fn(
    opts.set ?? (async (args: { patch: Partial<InstancePrefs> }) =>
      ({ prefs: prefs(args.patch) })),
  );
  const panel = mountLearningPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runPrefsGet: opts.get ?? (async () => ({ prefs: prefs() })),
    runPrefsSet,
  });
  return { host, doc, panel, runPrefsSet };
};

describe('Settings → Learning — the ask that feeds precedent', () => {
  it('renders the toggle ON by default, since the registry default is on', async () => {
    // ⚠ The default is asserted through the REAL registry (`DEFAULT_INSTANCE_PREFS`),
    // not a literal `true` in the fixture — a flipped registry default must land
    // here rather than in a bench run months later.
    const h = mount();
    await h.panel.whenLoaded();
    expect(h.host.hasAttribute(LEARNING_PANEL_HOST_ATTR)).toBe(true);
    const toggle = findByAttr(h.host, LEARNING_PANEL_TOGGLE_ATTR);
    expect(toggle?.getAttribute(LEARNING_PANEL_TOGGLE_ATTR))
      .toBe('chat.execution_case_offer');
    expect(toggle?.checked).toBe(true);
    expect(findByAttr(h.host, LEARNING_PANEL_OFF_HINT_ATTR)).toBeNull();
  });

  it('saves a single-key patch and adopts the server\'s merged answer', async () => {
    const h = mount();
    await h.panel.whenLoaded();
    const toggle = findByAttr(h.host, LEARNING_PANEL_TOGGLE_ATTR)!;
    toggle.focus();
    toggle.checked = false;
    toggle.dispatchChange();
    await h.panel.whenSaveSettled();

    // ⛔ ONE KEY. A whole-prefs write would clobber another surface's
    // concurrent change to an unrelated pref.
    expect(h.runPrefsSet).toHaveBeenCalledTimes(1);
    expect(h.runPrefsSet.mock.calls[0]![0]).toEqual({
      patch: { 'chat.execution_case_offer': false },
    });
    expect(h.panel.getState().prefs?.['chat.execution_case_offer']).toBe(false);
    expect(findByAttr(h.host, LEARNING_PANEL_TOGGLE_ATTR)?.checked).toBe(false);
  });

  it('keeps a focused pending value truthful and single-flight until the server answers', async () => {
    let settle!: (value: { prefs: InstancePrefs }) => void;
    const h = mount({
      set: () => new Promise((resolve) => { settle = resolve; }),
    });
    await h.panel.whenLoaded();
    expect(h.panel.hasInFlightWork()).toBe(false);
    let toggle = findByAttr(h.host, LEARNING_PANEL_TOGGLE_ATTR)!;
    toggle.focus();
    toggle.checked = false;
    toggle.dispatchChange();

    toggle = findByAttr(h.host, LEARNING_PANEL_TOGGLE_ATTR)!;
    expect(h.panel.hasInFlightWork()).toBe(true);
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    expect(toggle.getAttribute('aria-busy')).toBe('true');
    expect(h.doc.activeElement).toBe(toggle);

    // A second native toggle while ARIA-locked is immediately rolled back and
    // never starts a competing write.
    toggle.checked = true;
    toggle.dispatchChange();
    expect(toggle.checked).toBe(false);
    expect(h.runPrefsSet).toHaveBeenCalledTimes(1);

    settle({ prefs: prefs({ 'chat.execution_case_offer': false }) });
    await h.panel.whenSaveSettled();
    expect(h.panel.hasInFlightWork()).toBe(false);
    toggle = findByAttr(h.host, LEARNING_PANEL_TOGGLE_ATTR)!;
    expect(toggle.checked).toBe(false);
    expect(toggle.hasAttribute('aria-disabled')).toBe(false);
    expect(toggle.hasAttribute('aria-busy')).toBe(false);
    expect(h.doc.activeElement).toBe(toggle);
  });

  it('says what is LOST while it is off, and that past answers are kept', async () => {
    // The hint is the honest half: nothing else feeds precedent, so "off" is not
    // a display preference — Recued stops learning from these turns.
    const h = mount({
      get: async () => ({ prefs: prefs({ 'chat.execution_case_offer': false }) }),
    });
    await h.panel.whenLoaded();
    const hint = findByAttr(h.host, LEARNING_PANEL_OFF_HINT_ATTR);
    expect(hint).not.toBeNull();
    expect(textOf(hint!)).toContain('will not learn these turns from you');
    expect(textOf(hint!)).toContain('already given are kept');
    // ⛔ AND IT MUST NOT OVERCLAIM. This asserted "will not become precedent",
    // which the switch cannot promise: an independently verified outcome is
    // strong evidence and never runs through the ask. The hint now names that
    // exception, and this pins it so the honest half cannot be edited away.
    expect(textOf(hint!)).toContain('verify independently may still count');
  });

  it('tells the owner the switch is server-wide, not per-device', async () => {
    // ⛔ The server resolves the roster off-anywhere-wins, so a row that read as
    // per-device would be a lie on the second device.
    const h = mount();
    await h.panel.whenLoaded();
    expect(textOf(h.host)).toContain('Applies to every device');
  });

  it('surfaces a load failure instead of rendering a toggle it cannot back', async () => {
    const h = mount({ get: async () => { throw new Error('pair offline'); } });
    await h.panel.whenLoaded();
    expect(h.panel.getState().phase).toBe('error');
    expect(findByAttr(h.host, LEARNING_PANEL_ERROR_ATTR)).not.toBeNull();
    // ⚠ …and NO toggle: a control rendered over an unknown value would show a
    // state the server never confirmed.
    expect(findByAttr(h.host, LEARNING_PANEL_TOGGLE_ATTR)).toBeNull();
  });

  it('keeps the last known value visible when a SAVE fails, and says so', async () => {
    const h = mount({ set: async () => { throw new Error('pair offline'); } });
    await h.panel.whenLoaded();
    const toggle = findByAttr(h.host, LEARNING_PANEL_TOGGLE_ATTR)!;
    toggle.focus();
    toggle.checked = false;
    toggle.dispatchChange();
    await h.panel.whenSaveSettled();
    expect(h.panel.getState().phase).toBe('ready');
    // The server never confirmed the change, so the rendered value stays at the
    // last authoritative one rather than the optimistic click.
    expect(findByAttr(h.host, LEARNING_PANEL_TOGGLE_ATTR)?.checked).toBe(true);
    expect(findByAttr(h.host, LEARNING_PANEL_ERROR_ATTR)).not.toBeNull();
    expect(h.doc.activeElement).toBe(
      findByAttr(h.host, LEARNING_PANEL_TOGGLE_ATTR),
    );
  });

  it('dispose clears the host and its marker', async () => {
    const h = mount();
    await h.panel.whenLoaded();
    h.panel.dispose();
    expect(h.host.children).toHaveLength(0);
    expect(h.host.hasAttribute(LEARNING_PANEL_HOST_ATTR)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// D-219 item 2 — what Recued has learned
// ════════════════════════════════════════════════════════════════

const learned = (
  over: Partial<ExecutionCaseLearnedEntry> = {},
): ExecutionCaseLearnedEntry => ({
  case_id: 'case_one',
  request: ['send the quarterly report'],
  flows: [{
    // ⚠ The server sends this DEDUPED AND SORTED — it names WHICH ops a request
    // may need, not the order anything ran in.
    tools_that_may_be_needed: ['file.search', 'mail.send'],
    outcome: ['You confirmed this was right.'],
  }],
  shown_to_model: true,
  request_observations: 1,
  last_seen_at: Date.UTC(2026, 6, 20, 12, 0, 0),
  ...over,
});

const mountWithCases = (opts: {
  cases?: () => Promise<{ cases: ExecutionCaseLearnedEntry[] }>;
  forget?: (
    args: { case_id: string },
  ) => Promise<{ removed: boolean; cases_remaining: number }>;
} = {}) => {
  const host = makeFakeElement('div');
  const doc = makeFakeDocument();
  const runCasesList = vi.fn(
    opts.cases ?? (async () => ({ cases: [learned()] })),
  );
  const runCaseForget = vi.fn(
    opts.forget ?? (async () => ({ removed: true, cases_remaining: 0 })),
  );
  const panel = mountLearningPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runPrefsGet: async () => ({ prefs: prefs() }),
    runPrefsSet: async (args) => ({ prefs: prefs(args.patch) }),
    runCasesList,
    runCaseForget,
  });
  return { host, doc, panel, runCasesList, runCaseForget };
};

describe('Settings → Learning — what Recued has learned', () => {
  it('is absent entirely when the list caller is unwired', async () => {
    // The D-160 removability rule: an unwired dep degrades to the panel that
    // shipped with 9c, never to a half-built section.
    const h = mount();
    await h.panel.whenLoaded();
    expect(findByAttr(h.host, LEARNING_PANEL_CASES_ATTR)).toBeNull();
    // …and the toggle it sits under is untouched.
    expect(findByAttr(h.host, LEARNING_PANEL_TOGGLE_ATTR)).not.toBeNull();
  });

  it('shows the request, the steps, and what the OWNER concluded', async () => {
    // ⛔ The point of the whole page. Before this the owner answered "was that
    // right?" and had no way to see that anything came of it.
    const h = mountWithCases();
    await h.panel.whenLoaded();
    const item = findByAttr(h.host, LEARNING_PANEL_CASE_ATTR);
    expect(item?.getAttribute(LEARNING_PANEL_CASE_ATTR)).toBe('case_one');
    const text = textOf(item!);
    expect(text).toContain('send the quarterly report');
    expect(text).toContain('May need: file.search, mail.send');
    expect(text).toContain('You confirmed this was right.');
    // A real date, in the viewer's zone — the model-bound card carries none.
    expect(text).toContain('Seen once');
  });

  it('names the candidate ops WITHOUT claiming they ran in that order', async () => {
    // ⛔⛔ The property the field's rename exists to protect, and no type can
    // enforce it: `tools_that_may_be_needed.join(' → ')` typechecks perfectly
    // and is exactly the bug.
    //
    // The panel rendered `tool_sequence.join(' → ')` until the card stopped
    // claiming a route — three live A/B rounds having shown what a claimed
    // procedure does to a reader. What arrives now is deduped and
    // alphabetically SORTED, so an arrow would present sort order as the order
    // things happened: a claim about the owner's own history that nothing
    // observed, on the page that exists to answer "what does it know about me"
    // honestly.
    const h = mountWithCases();
    await h.panel.whenLoaded();
    const text = textOf(findByAttr(h.host, LEARNING_PANEL_CASE_ATTR)!);
    expect(text).toContain('file.search');
    expect(text).toContain('mail.send');
    expect(text, 'an arrow asserts an order that was never observed')
      .not.toContain('→');
  });

  it('says when a stored case is NOT currently used', async () => {
    // ⛔ An inert case rendered identically to a live one would misreport the
    // reach of everything on the page.
    const h = mountWithCases({
      cases: async () => ({
        cases: [learned({ shown_to_model: false, flows: [] })],
      }),
    });
    await h.panel.whenLoaded();
    const inert = findByAttr(h.host, LEARNING_PANEL_CASE_INERT_ATTR);
    expect(inert).not.toBeNull();
    expect(textOf(inert!)).toContain('not currently used');
    // …and the marker is absent on a live one, so it cannot become boilerplate.
    const live = mountWithCases();
    await live.panel.whenLoaded();
    expect(findByAttr(live.host, LEARNING_PANEL_CASE_INERT_ATTR)).toBeNull();
  });

  it('explains an empty list instead of leaving a blank block', async () => {
    const h = mountWithCases({ cases: async () => ({ cases: [] }) });
    await h.panel.whenLoaded();
    const empty = findByAttr(h.host, LEARNING_PANEL_CASES_EMPTY_ATTR);
    expect(empty).not.toBeNull();
    // Names the ONE way anything gets here, so empty reads as a stage rather
    // than a failure — and points back at the toggle above it.
    expect(textOf(empty!)).toContain('only from turns you answer');
  });

  it('⛔ forgets only on the SECOND tap', async () => {
    // Forgetting deletes the source turns and the answer the owner gave about
    // them. There is no undo, so one stray tap must not do it.
    const h = mountWithCases();
    await h.panel.whenLoaded();
    const button = findByAttr(h.host, LEARNING_PANEL_FORGET_ATTR)!;
    button.dispatchClick();
    expect(h.runCaseForget).not.toHaveBeenCalled();
    expect(textOf(findByAttr(h.host, LEARNING_PANEL_FORGET_ATTR)!))
      .toContain('Tap again');

    findByAttr(h.host, LEARNING_PANEL_FORGET_ATTR)!.dispatchClick();
    await h.panel.whenForgetSettled();
    expect(h.runCaseForget).toHaveBeenCalledTimes(1);
    expect(h.runCaseForget.mock.calls[0]![0]).toEqual({ case_id: 'case_one' });
  });

  it('keeps a keyboard-owned confirmation and pending Forget single-flight', async () => {
    let listed = [learned()];
    let settle!: () => void;
    const h = mountWithCases({
      cases: async () => ({ cases: listed }),
      forget: () => new Promise((resolve) => {
        settle = () => {
          listed = [];
          resolve({ removed: true, cases_remaining: 0 });
        };
      }),
    });
    await h.panel.whenLoaded();
    let button = findByAttr(h.host, LEARNING_PANEL_FORGET_ATTR)!;
    button.focus();
    button.dispatchClick();

    button = findByAttr(h.host, LEARNING_PANEL_FORGET_ATTR)!;
    expect(textOf(button)).toContain('Tap again');
    expect(h.doc.activeElement).toBe(button);
    button.dispatchClick();

    button = findByAttr(h.host, LEARNING_PANEL_FORGET_ATTR)!;
    expect(h.panel.hasInFlightWork()).toBe(true);
    expect(textOf(button)).toContain('Forgetting...');
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(h.doc.activeElement).toBe(button);
    button.dispatchClick();
    button.dispatchClick();
    expect(h.runCaseForget).toHaveBeenCalledTimes(1);

    settle();
    await h.panel.whenForgetSettled();
    expect(h.panel.hasInFlightWork()).toBe(false);
    const empty = findByAttr(h.host, LEARNING_PANEL_CASES_EMPTY_ATTR)!;
    expect(empty.getAttribute('tabindex')).toBe('-1');
    expect(h.doc.activeElement).toBe(empty);
  });

  it('keeps a failed Forget beside its case, armed and focused for retry', async () => {
    const h = mountWithCases({
      forget: async () => { throw new Error('pair offline'); },
    });
    await h.panel.whenLoaded();
    let button = findByAttr(h.host, LEARNING_PANEL_FORGET_ATTR)!;
    button.focus();
    button.dispatchClick();
    findByAttr(h.host, LEARNING_PANEL_FORGET_ATTR)!.dispatchClick();
    await h.panel.whenForgetSettled();

    button = findByAttr(h.host, LEARNING_PANEL_FORGET_ATTR)!;
    expect(findByAttr(h.host, LEARNING_PANEL_CASE_ATTR)).not.toBeNull();
    expect(findByAttr(h.host, LEARNING_PANEL_CASES_ERROR_ATTR)).toBeNull();
    expect(textOf(findByAttr(h.host, LEARNING_PANEL_FORGET_ERROR_ATTR)!))
      .toContain('pair offline');
    expect(textOf(button)).toContain('Tap again');
    expect(h.doc.activeElement).toBe(button);

    button.dispatchClick();
    await h.panel.whenForgetSettled();
    expect(h.runCaseForget).toHaveBeenCalledTimes(2);
  });

  it('⛔ RE-READS the list after forgetting rather than splicing locally', async () => {
    // Forgetting removes the case's SOURCE reports, and a report shared with
    // another case takes that one with it. Only the server knows what actually
    // went; a local removal would show a list that quietly disagreed.
    let listed = [learned(), learned({ case_id: 'case_two' })];
    const h = mountWithCases({
      cases: async () => ({ cases: listed }),
      forget: async () => {
        listed = [];
        return { removed: true, cases_remaining: 0 };
      },
    });
    await h.panel.whenLoaded();
    expect(findAllByAttr(h.host, LEARNING_PANEL_CASE_ATTR)).toHaveLength(2);

    const button = findByAttr(h.host, LEARNING_PANEL_FORGET_ATTR)!;
    button.dispatchClick();
    findByAttr(h.host, LEARNING_PANEL_FORGET_ATTR)!.dispatchClick();
    await h.panel.whenForgetSettled();

    expect(h.runCasesList).toHaveBeenCalledTimes(2);
    // BOTH are gone — the shared-source outcome the server reported, which a
    // local splice of the tapped row alone would have hidden.
    expect(findAllByAttr(h.host, LEARNING_PANEL_CASE_ATTR)).toHaveLength(0);
  });

  it('keeps the toggle usable when the LIST fails', async () => {
    // ⚠ The list fails on its own. That toggle is the tap for everything the
    // AI learns; losing it because a corpus query failed would be the larger
    // loss — and an empty list would claim nothing was learned, which is
    // exactly what is unknown.
    const h = mountWithCases({
      cases: async () => { throw new Error('pair offline'); },
    });
    await h.panel.whenLoaded();
    expect(h.panel.getState().phase).toBe('ready');
    expect(findByAttr(h.host, LEARNING_PANEL_TOGGLE_ATTR)).not.toBeNull();
    expect(findByAttr(h.host, LEARNING_PANEL_CASES_ERROR_ATTR)).not.toBeNull();
    expect(findByAttr(h.host, LEARNING_PANEL_CASES_EMPTY_ATTR)).toBeNull();
  });

  it('⛔ offers no "make a recipe" action — RULED OUT, not merely unbuilt', async () => {
    // ⛔⛔ AUDITED 2026-07-29, and the answer is stronger than "not yet". A case
    // records CHAT TOOL names; a recipe's steps are kernel ops; and across all
    // ELEVEN Tier-1 tools not one is a thin wrapper over an op. They are
    // agent-facing surfaces — 6 of 11 carry a read-grant fence returning a
    // GUIDED EMPTY rather than an error (the Tier-1 anti-loop invariant), four
    // fan out across collections or CRM vendors, and their arguments are shaped
    // for a model that does not know slugs or record ids. The ops are the
    // opposite: per-collection, per-record primitives that require exactly
    // those identifiers.
    //
    // So a generated recipe would need the arguments D-214 excludes BY DESIGN
    // (acceptance #47), and would silently drop the fences — at `success: true`.
    // ⚠ The closest thing to a declared correspondence is `work.search` naming
    // `core.work-entity.read`, and that is a GRANT the tool is gated on, not an
    // implementation it wraps. An earlier handover proposed declaring a
    // `backing_op`; the audit RETRACTS that — it would assert an equivalence
    // that does not hold.
    //
    // ⏭ This test is re-pointed only if the TOOLS change — if a Tier-1 surface
    // ever becomes a real op wrapper — not by writing a mapping table.
    const h = mountWithCases();
    await h.panel.whenLoaded();
    expect(textOf(h.host).toLowerCase()).not.toContain('recipe');
  });
});

// ════════════════════════════════════════════════════════════════
// D-219 item 2b — turning a case into a recipe
// ════════════════════════════════════════════════════════════════

const CONFIRMATION = 'It is a slow call and it spends your model quota.';

const mountWithDraft = (opts: {
  draft?: LearningDraftRecipeCaller;
  cases?: ExecutionCaseLearnedEntry[];
  forget?: (
    args: { case_id: string },
  ) => Promise<{ removed: boolean; cases_remaining: number }>;
  handoff?: (draft: {
    case_id: string;
    recipe: unknown;
    request_aliased: boolean;
  }) => boolean | void;
} = {}) => {
  const host = makeFakeElement('div');
  const doc = makeFakeDocument();
  const onDraftReady = vi.fn(opts.handoff ?? (() => undefined));
  const runDraftRecipe = vi.fn(
    opts.draft ?? (async () =>
      ({ ok: true, recipe: { recipe_id: 'r' }, issues: [], request_aliased: true })),
  );
  const runCaseForget = vi.fn(
    opts.forget ?? (async () => ({ removed: true, cases_remaining: 0 })),
  );
  const panel = mountLearningPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runPrefsGet: async () => ({ prefs: prefs() }),
    runPrefsSet: async (args) => ({ prefs: prefs(args.patch) }),
    runCasesList: async () => ({ cases: opts.cases ?? [learned()] }),
    runCaseForget,
    runDraftRecipe,
    onDraftReady,
    draftConfirmation: CONFIRMATION,
  });
  return {
    host,
    doc,
    panel,
    runCaseForget,
    runDraftRecipe,
    onDraftReady,
  };
};

describe('Settings → Learning — make a recipe from a case', () => {
  it('is absent unless BOTH the caller and the hand-off are wired', async () => {
    // ⛔ A Generate control that produces a draft nothing then opens is a dead
    // end, and an expensive one. They are wired as a pair or not at all.
    const h = mountWithCases();
    await h.panel.whenLoaded();
    expect(findByAttr(h.host, LEARNING_PANEL_DRAFT_ATTR)).toBeNull();
  });

  it('⛔ shows the confirmation FIRST and spends nothing on the first press', async () => {
    // ⛔⛔ THE POINT OF THE TWO PRESSES. This is a slow call against the owner's
    // model quota; an accidental tap must not spend it. The first press only
    // reveals what they are agreeing to.
    const h = mountWithDraft();
    await h.panel.whenLoaded();
    expect(findByAttr(h.host, LEARNING_PANEL_DRAFT_CONFIRM_ATTR)).toBeNull();

    let button = findByAttr(h.host, LEARNING_PANEL_DRAFT_ATTR)!;
    button.focus();
    button.dispatchClick();
    expect(h.runDraftRecipe).not.toHaveBeenCalled();
    const confirm = findByAttr(h.host, LEARNING_PANEL_DRAFT_CONFIRM_ATTR);
    // ⛔ The SERVER's copy, threaded through — not a paraphrase this panel owns,
    // which could soften what the owner is agreeing to.
    expect(textOf(confirm!)).toBe(CONFIRMATION);
    button = findByAttr(h.host, LEARNING_PANEL_DRAFT_ATTR)!;
    expect(textOf(button)).toContain('Yes, write the draft');
    expect(h.doc.activeElement).toBe(button);
  });

  it('retains the prompt and focused single-flight control through failure', async () => {
    let reject!: (reason: Error) => void;
    const h = mountWithDraft({
      draft: () => new Promise((_resolve, rejectDraft) => {
        reject = rejectDraft;
      }),
    });
    await h.panel.whenLoaded();
    let button = findByAttr(h.host, LEARNING_PANEL_DRAFT_ATTR)!;
    button.focus();
    button.dispatchClick();

    const prompt = findByAttr(h.host, LEARNING_PANEL_DRAFT_PROMPT_ATTR)!;
    prompt.value = 'run it every Monday';
    prompt.dispatchInput();
    button = findByAttr(h.host, LEARNING_PANEL_DRAFT_ATTR)!;
    button.focus();
    button.dispatchClick();

    button = findByAttr(h.host, LEARNING_PANEL_DRAFT_ATTR)!;
    expect(h.panel.hasInFlightWork()).toBe(true);
    expect(textOf(button)).toContain('Asking your AI...');
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(h.doc.activeElement).toBe(button);
    expect(findByAttr(h.host, LEARNING_PANEL_DRAFT_PROMPT_ATTR)?.value)
      .toBe('run it every Monday');
    button.dispatchClick();
    button.dispatchClick();
    expect(h.runDraftRecipe).toHaveBeenCalledTimes(1);

    reject(new Error('pair offline'));
    await h.panel.whenDraftSettled();
    expect(h.panel.hasInFlightWork()).toBe(false);
    button = findByAttr(h.host, LEARNING_PANEL_DRAFT_ATTR)!;
    expect(textOf(button)).toContain('Yes, write the draft');
    expect(findByAttr(h.host, LEARNING_PANEL_DRAFT_PROMPT_ATTR)?.value)
      .toBe('run it every Monday');
    expect(textOf(findByAttr(h.host, LEARNING_PANEL_DRAFT_ERROR_ATTR)!))
      .toContain('pair offline');
    expect(h.doc.activeElement).toBe(button);
  });

  it('serializes drafting and forgetting so neither can race the other', async () => {
    let settleDraft!: () => void;
    const drafting = mountWithDraft({
      draft: () => new Promise((resolve) => {
        settleDraft = () => resolve({
          ok: false,
          issues: ['not used'],
          reason: 'invalid_recipe',
        });
      }),
    });
    await drafting.panel.whenLoaded();
    findByAttr(drafting.host, LEARNING_PANEL_DRAFT_ATTR)!.dispatchClick();
    findByAttr(drafting.host, LEARNING_PANEL_DRAFT_ATTR)!.dispatchClick();

    let competing = findByAttr(drafting.host, LEARNING_PANEL_FORGET_ATTR)!;
    expect(competing.getAttribute('aria-disabled')).toBe('true');
    expect(competing.disabled).toBe(false);
    competing.dispatchClick();
    competing.dispatchClick();
    expect(drafting.runCaseForget).not.toHaveBeenCalled();
    settleDraft();
    await drafting.panel.whenDraftSettled();

    let settleForget!: () => void;
    const forgetting = mountWithDraft({
      forget: () => new Promise((resolve) => {
        settleForget = () => resolve({ removed: true, cases_remaining: 0 });
      }),
    });
    await forgetting.panel.whenLoaded();
    findByAttr(forgetting.host, LEARNING_PANEL_FORGET_ATTR)!.dispatchClick();
    findByAttr(forgetting.host, LEARNING_PANEL_FORGET_ATTR)!.dispatchClick();

    competing = findByAttr(forgetting.host, LEARNING_PANEL_DRAFT_ATTR)!;
    expect(competing.getAttribute('aria-disabled')).toBe('true');
    expect(competing.disabled).toBe(false);
    competing.dispatchClick();
    competing.dispatchClick();
    expect(forgetting.runDraftRecipe).not.toHaveBeenCalled();
    settleForget();
    await forgetting.panel.whenForgetSettled();
  });

  it('sends the owner\'s instruction, and hands the draft back', async () => {
    const ownershipDuringHandoff: Array<{
      inFlight: boolean;
      unsaved: boolean;
    }> = [];
    let readOwnership = (): { inFlight: boolean; unsaved: boolean } => ({
      inFlight: true,
      unsaved: true,
    });
    const h = mountWithDraft({
      handoff: () => {
        ownershipDuringHandoff.push(readOwnership());
      },
    });
    readOwnership = () => ({
      inFlight: h.panel.hasInFlightWork(),
      unsaved: h.panel.hasUnsavedChanges(),
    });
    await h.panel.whenLoaded();
    findByAttr(h.host, LEARNING_PANEL_DRAFT_ATTR)!.dispatchClick();

    const prompt = findByAttr(h.host, LEARNING_PANEL_DRAFT_PROMPT_ATTR)!;
    prompt.value = 'run it every Monday';
    prompt.dispatchInput();
    findByAttr(h.host, LEARNING_PANEL_DRAFT_ATTR)!.dispatchClick();
    await h.panel.whenDraftSettled();

    expect(h.runDraftRecipe.mock.calls[0]![0])
      .toEqual({ case_id: 'case_one', prompt: 'run it every Monday' });
    // ⛔ The panel does NOT route. It hands the draft to the shell, which keeps
    // Kitchen routes out of a Settings panel's concerns.
    expect(h.onDraftReady).toHaveBeenCalledTimes(1);
    expect(h.onDraftReady.mock.calls[0]![0]).toEqual({
      case_id: 'case_one',
      recipe: { recipe_id: 'r' },
      request_aliased: true,
    });
    expect(ownershipDuringHandoff).toEqual([{
      inFlight: false,
      unsaved: false,
    }]);
  });

  it('retries a finished hand-off without asking the model again', async () => {
    let handoffAttempts = 0;
    const h = mountWithDraft({
      handoff: () => {
        handoffAttempts += 1;
        return handoffAttempts > 1;
      },
    });
    await h.panel.whenLoaded();
    let button = findByAttr(h.host, LEARNING_PANEL_DRAFT_ATTR)!;
    button.focus();
    button.dispatchClick();
    findByAttr(h.host, LEARNING_PANEL_DRAFT_ATTR)!.dispatchClick();
    await h.panel.whenDraftSettled();

    button = findByAttr(h.host, LEARNING_PANEL_DRAFT_ATTR)!;
    expect(h.panel.hasInFlightWork()).toBe(false);
    expect(h.panel.hasUnsavedChanges()).toBe(true);
    expect(textOf(button)).toContain('Open finished draft');
    expect(textOf(findByAttr(h.host, LEARNING_PANEL_DRAFT_ERROR_ATTR)!))
      .toContain('does not ask your AI or spend model quota again');
    expect(h.runDraftRecipe).toHaveBeenCalledTimes(1);
    expect(h.onDraftReady).toHaveBeenCalledTimes(1);
    expect(h.doc.activeElement).toBe(button);

    button.dispatchClick();
    expect(h.panel.hasUnsavedChanges()).toBe(false);
    expect(h.onDraftReady).toHaveBeenCalledTimes(2);
    expect(h.runDraftRecipe).toHaveBeenCalledTimes(1);
    expect(findByAttr(h.host, LEARNING_PANEL_DRAFT_ERROR_ATTR)).toBeNull();
    button = findByAttr(h.host, LEARNING_PANEL_DRAFT_ATTR)!;
    expect(textOf(button)).toContain('Make a recipe...');
    expect(h.doc.activeElement).toBe(button);
  });

  it('⚠ shows what the validator found, rather than failing silently', async () => {
    // A model that wrote something unusable is an ANSWER. Saying what was wrong
    // gives the owner the only lever they have — a clearer instruction.
    const h = mountWithDraft({
      draft: async () => ({
        ok: false, issues: ['steps: required'], reason: 'invalid_recipe',
      }),
    });
    await h.panel.whenLoaded();
    findByAttr(h.host, LEARNING_PANEL_DRAFT_ATTR)!.dispatchClick();
    findByAttr(h.host, LEARNING_PANEL_DRAFT_ATTR)!.dispatchClick();
    await h.panel.whenDraftSettled();

    const error = findByAttr(h.host, LEARNING_PANEL_DRAFT_ERROR_ATTR);
    expect(textOf(error!)).toContain('steps: required');
    // ⛔ …and nothing was handed off, so a bad draft cannot reach the Kitchen.
    expect(h.onDraftReady).not.toHaveBeenCalled();
  });

  it('⚠ the error belongs to ITS case, not to every one on the page', async () => {
    // ⚠ NEEDS TWO CASES, and a first version with one PASSED against a global
    // message: with a single control on the page, "scoped to this case" and
    // "shown everywhere" render identically. The panel renders one control per
    // case, so a bare message would sit under all of them and misattribute the
    // failure to cases that were never tried.
    const h = mountWithDraft({
      cases: [learned(), learned({ case_id: 'case_two' })],
      draft: async () => ({ ok: false, issues: ['nope'] }),
    });
    await h.panel.whenLoaded();
    // Non-vacuity: there really are two controls to confuse.
    expect(findAllByAttr(h.host, LEARNING_PANEL_DRAFT_ATTR)).toHaveLength(2);

    const second = findAllByAttr(h.host, LEARNING_PANEL_DRAFT_ATTR)[1]!;
    second.dispatchClick();
    findAllByAttr(h.host, LEARNING_PANEL_DRAFT_ATTR)[1]!.dispatchClick();
    await h.panel.whenDraftSettled();

    const errors = findAllByAttr(h.host, LEARNING_PANEL_DRAFT_ERROR_ATTR);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.getAttribute(LEARNING_PANEL_DRAFT_ERROR_ATTR))
      .toBe('case_two');
  });
});

// ──────────────────────────────────────────────────────────────────
// The classes the panel assigns must actually be DEFINED
// ──────────────────────────────────────────────────────────────────

/** ⛔ THE BUG THIS EXISTS FOR. The panel assigned `learning-row`,
 *  `learning-row-text`, `learning-row-label`, `learning-row-detail`,
 *  `learning-muted` and `learning-case` from the day it shipped — and NOTHING
 *  defined any of them. There was no `LEARNING_PANEL_STYLES` at all.
 *
 *  In a browser the label and its description are both bare `<span>`s, so they
 *  rendered as one run-together, un-bolded sentence ("…turned outAfter Recued
 *  works through…") directly beneath the Transparency rows, which DO ship
 *  styles and look right. Every render test passed the whole time: they assert
 *  structure and text, and a missing stylesheet changes neither.
 *
 *  ⚠ This asserts the classes the panel ACTUALLY RENDERS, walked off the live
 *  DOM rather than listed by hand — a hand-kept list would go stale exactly
 *  when someone adds the next unstyled class. */
describe('D-219 — every class the Learning panel assigns has a rule', () => {
  const classesRendered = (root: FakeElement): Set<string> => {
    const out = new Set<string>();
    const walk = (n: FakeElement): void => {
      for (const cls of (n.className ?? '').split(/\s+/u)) {
        if (cls.startsWith('learning-')) out.add(cls);
      }
      for (const c of n.children) walk(c);
    };
    walk(root);
    return out;
  };

  it('the toggle row, the case list and the draft controls are all styled', async () => {
    // Drive the three mounts so every branch's classes get rendered.
    const plain = mount();
    await plain.panel.whenLoaded();
    const withCases = mountWithCases();
    await withCases.panel.whenLoaded();
    const withDraft = mountWithDraft();
    await withDraft.panel.whenLoaded();

    const used = new Set<string>([
      ...classesRendered(plain.host),
      ...classesRendered(withCases.host),
      ...classesRendered(withDraft.host),
    ]);
    // Guard the guard: if the panel stopped assigning classes entirely this
    // test would pass vacuously.
    expect(used.size).toBeGreaterThan(3);

    const undefined_classes = [...used].filter(
      (cls) => !LEARNING_PANEL_STYLES.includes(`.${cls}`),
    );
    expect(undefined_classes).toEqual([]);
  });

  it('scopes every rule to the panel host, so the section is inert when unmounted', () => {
    // The rules ride the shared `#settings` stylesheet, which loads whether or
    // not the bootstrap wired the prefs callers. Unscoped selectors would leak
    // onto whatever else happened to use the name.
    const selectors = LEARNING_PANEL_STYLES.split('{')
      .slice(0, -1)
      .map((chunk) => chunk.split('}').pop()!.trim())
      .filter((s) => s.length > 0);
    expect(selectors.length).toBeGreaterThan(3);
    for (const selector of selectors) {
      expect(selector).toContain(`[${LEARNING_PANEL_HOST_ATTR}]`);
    }
  });
});

describe('D-219 — "you already made a recipe from this"', () => {
  it('renders the server\'s authored record, and nothing when there is none', async () => {
    // ⛔ From the SERVER's record, never inferred from the recipe list: a recipe
    // of a similar name proves nothing about where it came from. The point is to
    // stop the owner paying for a second draft of something they already built.
    const withLink = mountWithCases({
      cases: async () => ({
        cases: [
          learned({
            case_id: 'c_made',
            authored: [{
              recipe_id: 'weekly-summary', recipe_hash: 'h', authored_at: 1,
              state: 'unchanged',
            }],
          }),
          learned({ case_id: 'c_plain' }),
        ],
      }),
    });
    await withLink.panel.whenLoaded();
    const lines = findAllByAttr(withLink.host, LEARNING_PANEL_CASE_AUTHORED_ATTR);
    // ⚠ The permitting witness is the COUNT: exactly one line for two cases, or
    // this would pass against a renderer that annotated every case.
    expect(lines).toHaveLength(1);
    expect(lines[0]!.getAttribute(LEARNING_PANEL_CASE_AUTHORED_ATTR)).toBe('c_made');
    expect(lines[0]!.textContent).toContain('weekly-summary');
  });

  it('⛔ says the recipe is GONE or EDITED rather than implying it is there', async () => {
    // ⛔ "You made a recipe from this" is merely incomplete once they have edited
    // it, and actively MISLEADING when the recipe is not saved any more. The
    // server resolves the stored hash against the live recipe so this can be
    // honest about both.
    const h = mountWithCases({
      cases: async () => ({
        cases: [
          learned({ case_id: 'c_gone', authored: [{
            recipe_id: 'deleted-one', recipe_hash: 'h', authored_at: 1,
            state: 'gone',
          }] }),
          learned({ case_id: 'c_edited', authored: [{
            recipe_id: 'changed-one', recipe_hash: 'h', authored_at: 1,
            state: 'edited',
          }] }),
          learned({ case_id: 'c_same', authored: [{
            recipe_id: 'intact-one', recipe_hash: 'h', authored_at: 1,
            state: 'unchanged',
          }] }),
        ],
      }),
    });
    await h.panel.whenLoaded();
    const text = (id: string) => findAllByAttr(h.host, LEARNING_PANEL_CASE_AUTHORED_ATTR)
      .find((el) => el.getAttribute(LEARNING_PANEL_CASE_AUTHORED_ATTR) === id)
      ?.textContent ?? '';
    expect(text('c_gone')).toContain('no longer saved');
    expect(text('c_edited')).toContain('edited since');
    // ⚠ The permitting witness: an UNCHANGED one carries no qualifier, or every
    // line would read as a warning and the owner would stop reading them.
    expect(text('c_same')).toContain('intact-one');
    expect(text('c_same')).not.toContain('no longer saved');
    expect(text('c_same')).not.toContain('edited since');
  });

  it('counts them when there are several', async () => {
    const h = mountWithCases({
      cases: async () => ({
        cases: [learned({
          case_id: 'c_two',
          authored: [
            { recipe_id: 'weekly', recipe_hash: 'h1', authored_at: 1,
              state: 'unchanged' },
            { recipe_id: 'monthly', recipe_hash: 'h2', authored_at: 2,
              state: 'unchanged' },
          ],
        })],
      }),
    });
    await h.panel.whenLoaded();
    const made = findAllByAttr(h.host, LEARNING_PANEL_CASE_AUTHORED_ATTR)[0];
    expect(made?.textContent).toContain('2 recipes');
    expect(made?.textContent).toContain('monthly');
  });
});

describe('D-219 — a paid draft survives the owner navigating away', () => {
  const pressTwice = (host: FakeElement) => {
    const find = () => findAllByAttr(host, LEARNING_PANEL_DRAFT_ATTR)
      .find((el) => el.getAttribute(LEARNING_PANEL_DRAFT_ATTR) === 'case_one')!;
    find().dispatchClick();   // arm
    find().dispatchClick();   // fire
  };

  it('⛔⛔ HANDS THE DRAFT OVER even when the panel was disposed mid-call', async () => {
    // ⛔⛔ THE WORST SMALL FAILURE THIS FEATURE HAD, and it was invisible: a
    // 90-second call, the owner leaves Settings, and `if (disposed) return`
    // threw away a draft they had already been billed for. Nothing said so.
    //
    // The hand-off now happens regardless; only the STATE UPDATE is suppressed,
    // which is what the disposal guard was actually protecting.
    let release: ((v: unknown) => void) | undefined;
    const h = mountWithDraft({
      draft: (() => new Promise((resolve) => { release = resolve; })) as never,
    });
    await h.panel.whenLoaded();
    pressTwice(h.host);

    h.panel.dispose();                     // the owner leaves, mid-call
    release!({ ok: true, recipe: { recipe_id: 'paid-for' }, issues: [] });
    await h.panel.whenDraftSettled();

    expect(h.onDraftReady).toHaveBeenCalledTimes(1);
    expect(h.onDraftReady.mock.calls[0]![0]).toMatchObject({
      case_id: 'case_one', recipe: { recipe_id: 'paid-for' },
    });
  });

  it('⚠ a FAILED draft after disposal hands over nothing', async () => {
    // The permitting witness: without it the change above would pass against a
    // panel that handed over whatever came back, valid or not.
    let release: ((v: unknown) => void) | undefined;
    const h = mountWithDraft({
      draft: (() => new Promise((resolve) => { release = resolve; })) as never,
    });
    await h.panel.whenLoaded();
    pressTwice(h.host);
    h.panel.dispose();
    release!({ ok: false, issues: ['nope'], reason: 'invalid_recipe' });
    await h.panel.whenDraftSettled();
    expect(h.onDraftReady).not.toHaveBeenCalled();
  });
});
