/** D-174 ref-picker — Reception Inbox panel DOM-glue tests.
 *
 *  The pure projection model (Source→option mapping, the destination-field
 *  predicate, the edit semantics) is covered in `inbox-model.test.ts`. This
 *  file covers the PANEL glue those helpers feed: that a held-op "Destination"
 *  arg renders the shared ref-picker (not the dead "Picker unavailable" stub),
 *  that `work_entity.source.list` is loaded lazily + once, that a load failure
 *  degrades gracefully, and — the seam no model test can reach — that a picked
 *  destination flows through `pickerValues` → `collectEdits` into the approve
 *  dispatch, and does NOT leak across a hold change.
 *
 *  Like the ref-picker's own wire tests, this runs against a compact fake DOM
 *  (attribute-selector `querySelector` + bubbling dispatch). The one extension:
 *  setting a node's `innerHTML` to a ref-picker shell synthesizes the queryable
 *  shell subtree, so the panel's own `wireRefPicker` actually mounts and a
 *  selection can be driven — the production code path, not a stub.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import type {
  ArgEditField,
  InboxItem,
  SourceRegistration,
} from '@recued/contracts';
import { RefPicker } from '@recued/ui-shared';

import {
  RECEPTION_INBOX_ALLOW_BUTTON_ATTR,
  RECEPTION_INBOX_ALLOW_WITH_EDITS_COPY,
  RECEPTION_INBOX_BROADCAST_KINDS,
  mountReceptionInboxPanel,
  type ReceptionInboxConn,
} from './inbox-panel.js';
import { WEBCLIENT_DEFAULT_SUBSCRIPTIONS } from '../realtime/subscriber.js';

const NOW = 1_700_000_000_000;

// ════════════════════════════════════════════════════════════════════
// Fake DOM — attribute-selector querySelector + bubbling dispatch, with
// a ref-picker-shell-synthesizing innerHTML setter so the live picker
// mounts (mirrors `ref-picker.test.ts`'s harness + `buildShell`).
// ════════════════════════════════════════════════════════════════════

interface FakeEl {
  tagName: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<(ev: FakeEvent) => void>>;
  value: string;
  textContent: string;
  className: string;
  // Plain settable props the panel assigns (type/checked/disabled/...);
  // an index signature keeps them off the strict shape.
  [prop: string]: unknown;
  style: Record<string, string>;
  classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean };
  innerHTML: string;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  removeAttribute(k: string): void;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  remove(): void;
  addEventListener(type: string, fn: (ev: FakeEvent) => void): void;
  removeEventListener(type: string, fn: (ev: FakeEvent) => void): void;
  querySelector(sel: string): FakeEl | null;
  focus(): void;
}

interface FakeEvent {
  target: FakeEl;
  key?: string;
  defaultPrevented: boolean;
  preventDefault(): void;
}

const SELECTOR = /^\[([a-z0-9-]+)(?:="([^"]*)")?\]$/;

const matches = (node: FakeEl, selector: string): boolean => {
  const m = SELECTOR.exec(selector);
  if (m === null) return false;
  const [, name, value] = m;
  const have = node.attrs.get(name!);
  if (have === undefined) return false;
  return value === undefined ? true : have === value;
};

const querySelector = (root: FakeEl, selector: string): FakeEl | null => {
  for (const child of root.children) {
    if (matches(child, selector)) return child;
    const nested = querySelector(child, selector);
    if (nested !== null) return nested;
  }
  return null;
};

/** Hand-build the resting shell subtree `wireRefPicker` queries — shell →
 *  field → [input, clear] + results — so the live picker mounts even though
 *  the fake DOM does not parse the `innerHTML` string into nodes. */
const synthesizeRefPickerShell = (container: FakeEl, pickerId: string): void => {
  const shell = makeEl('div');
  shell.setAttribute('data-ref-picker', pickerId);
  const field = makeEl('div');
  const input = makeEl('input');
  input.setAttribute(RefPicker.REF_PICKER_INPUT_ATTR, '');
  const clear = makeEl('button');
  clear.setAttribute(RefPicker.REF_PICKER_CLEAR_ATTR, '');
  clear.setAttribute('hidden', '');
  const results = makeEl('ul');
  results.setAttribute(RefPicker.REF_PICKER_RESULTS_ATTR, '');
  results.setAttribute('hidden', '');
  field.appendChild(input);
  field.appendChild(clear);
  shell.appendChild(field);
  shell.appendChild(results);
  container.appendChild(shell);
};

const makeEl = (tag: string): FakeEl => {
  let rawInnerHTML = '';
  const el = {
    tagName: tag.toUpperCase(),
    attrs: new Map<string, string>(),
    children: [] as FakeEl[],
    parent: null as FakeEl | null,
    listeners: new Map<string, Array<(ev: FakeEvent) => void>>(),
    value: '',
    textContent: '',
    className: '',
    style: {} as Record<string, string>,
    classList: {
      add: () => {},
      remove: () => {},
      contains: () => false,
    },
    get firstChild() {
      return el.children[0] ?? null;
    },
    get innerHTML() {
      return rawInnerHTML;
    },
    set innerHTML(html: string) {
      rawInnerHTML = html;
      el.children = [];
      const m = /data-ref-picker="([^"]+)"/.exec(html);
      if (m !== null) synthesizeRefPickerShell(el, m[1]!);
    },
    setAttribute(k: string, v: string) {
      el.attrs.set(k, v);
    },
    getAttribute(k: string) {
      return el.attrs.get(k) ?? null;
    },
    removeAttribute(k: string) {
      el.attrs.delete(k);
    },
    hasAttribute(k: string) {
      return el.attrs.has(k);
    },
    appendChild(c: FakeEl) {
      c.parent = el;
      el.children.push(c);
      return c;
    },
    removeChild(c: FakeEl) {
      const idx = el.children.indexOf(c);
      if (idx >= 0) el.children.splice(idx, 1);
      c.parent = null;
      return c;
    },
    remove() {
      if (el.parent !== null) el.parent.removeChild(el);
    },
    addEventListener(type: string, fn: (ev: FakeEvent) => void) {
      const arr = el.listeners.get(type) ?? [];
      arr.push(fn);
      el.listeners.set(type, arr);
    },
    removeEventListener(type: string, fn: (ev: FakeEvent) => void) {
      const arr = el.listeners.get(type);
      if (arr === undefined) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    querySelector(sel: string) {
      return querySelector(el, sel);
    },
    focus() {},
  } as unknown as FakeEl;
  return el;
};

const makeDoc = (): Document =>
  ({
    createElement: (tag: string) => makeEl(tag),
    createTextNode: (text: string) => {
      const n = makeEl('#text');
      n.textContent = text;
      return n;
    },
  }) as unknown as Document;

/** Dispatch `type` at `target` and bubble up the parent chain. */
const dispatch = (target: FakeEl, type: string, key?: string): void => {
  const event: FakeEvent = {
    target,
    key,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  let node: FakeEl | null = target;
  while (node !== null) {
    for (const fn of node.listeners.get(type) ?? []) fn(event);
    node = node.parent;
  }
};

const allNodes = (root: FakeEl): FakeEl[] => {
  const out: FakeEl[] = [];
  const walk = (n: FakeEl): void => {
    out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
};

const findButton = (root: FakeEl, label: string): FakeEl => {
  const btn = allNodes(root).find(
    (n) => n.tagName === 'BUTTON' && n.textContent === label,
  );
  if (btn === undefined) throw new Error(`button "${label}" not found`);
  return btn;
};

/** Drain the microtask queue — the conn returns settled promises, so the
 *  panel's `await`-chains (list load → render → source load → render) clear
 *  in a handful of turns; no timers are involved on the paths we exercise. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

// ════════════════════════════════════════════════════════════════════
// Fixtures + a recording conn.
// ════════════════════════════════════════════════════════════════════

const DESTINATION_FIELD: ArgEditField = {
  key: 'source_id',
  type: 'string',
  label: 'Destination',
  options_source: 'reception_destination_sources',
  affects_target: true,
};

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  hold_id: over.hold_id ?? 'hold-1',
  operation_id: over.operation_id ?? 'crm.commitment.create',
  top_tier_kind: over.top_tier_kind ?? 'commitment',
  source: over.source ?? { kind: 'intake_form', endpoint_id: 'ep-1', record_ref: 'rec-1' },
  args: over.args ?? { title: 'Follow up' },
  arg_schema: over.arg_schema ?? { fields: [DESTINATION_FIELD] },
  preview: over.preview ?? { title: 'Follow up with Sam' },
  proposed_action: over.proposed_action ?? 'Create a commitment',
  status: over.status ?? 'pending',
  ...(over.allow_offer !== undefined ? { allow_offer: over.allow_offer } : {}),
});

const source = (over: Partial<SourceRegistration> = {}): SourceRegistration => ({
  id: over.id ?? 'builtin.task',
  top_tier_kind: over.top_tier_kind ?? 'task',
  source_kind: over.source_kind ?? 'builtin',
  source_label: over.source_label ?? 'Tasks',
  write_capable: over.write_capable ?? true,
  mcp_exposed: over.mcp_exposed ?? false,
  enabled: over.enabled,
  registered_at: over.registered_at ?? NOW,
});

const SOURCES: SourceRegistration[] = [
  source({ id: 'builtin.task', source_label: 'Tasks', top_tier_kind: 'task' }),
  source({ id: 'builtin.commit', source_label: 'Commitments', top_tier_kind: 'commitment' }),
  source({ id: 'ro.external', source_label: 'Read-only CRM', write_capable: false }),
];

interface ConnCall {
  op: string;
  payload: unknown;
}

interface Harness {
  mount: ReturnType<typeof mountReceptionInboxPanel>;
  root: FakeEl;
  calls: ConnCall[];
  approveCalls: () => Array<{ hold_id: string; edits: Record<string, unknown> }>;
  sourceListCount: () => number;
}

const setup = (opts: {
  items: InboxItem[];
  sources?: SourceRegistration[];
  failSourceList?: boolean;
}): Harness => {
  const calls: ConnCall[] = [];
  const conn = ((op: string, payload?: unknown): Promise<unknown> => {
    calls.push({ op, payload });
    switch (op) {
      case 'reception.inbox.list':
        return Promise.resolve({ items: opts.items });
      case 'work_entity.source.list':
        return opts.failSourceList === true
          ? Promise.reject(new Error('source list unavailable'))
          : Promise.resolve({ sources: opts.sources ?? SOURCES, defaults_by_kind: {} });
      case 'reception.inbox.approve':
        return Promise.resolve({
          hold_id: (payload as { hold_id: string }).hold_id,
          released: true,
          edited_keys: Object.keys((payload as { edits?: Record<string, unknown> }).edits ?? {}),
        });
      case 'reception.inbox.reject':
        return Promise.resolve({
          hold_id: (payload as { hold_id: string }).hold_id,
          status: 'dismissed',
        });
      default:
        return Promise.reject(new Error(`unexpected op ${op}`));
    }
  }) as unknown as ReceptionInboxConn;

  const host = makeEl('div');
  const mount = mountReceptionInboxPanel({
    host: host as unknown as HTMLElement,
    conn,
    document: makeDoc(),
    now: () => NOW,
  });
  const root = host.children[0]!;
  return {
    mount,
    root,
    calls,
    approveCalls: () =>
      calls
        .filter((c) => c.op === 'reception.inbox.approve')
        .map((c) => c.payload as { hold_id: string; edits: Record<string, unknown> }),
    sourceListCount: () => calls.filter((c) => c.op === 'work_entity.source.list').length,
  };
};

/** Focus the picker input (immediate search → all options), then click the
 *  first rendered option, driving the production select path. */
const pickFirstDestination = async (root: FakeEl): Promise<void> => {
  const input = root.querySelector(`[${RefPicker.REF_PICKER_INPUT_ATTR}]`);
  if (input === null) throw new Error('picker input not mounted');
  dispatch(input, 'focusin');
  await flush();
  const results = root.querySelector(`[${RefPicker.REF_PICKER_RESULTS_ATTR}]`)!;
  const li = makeEl('li');
  li.setAttribute(RefPicker.REF_PICKER_OPTION_INDEX_ATTR, '0');
  results.appendChild(li);
  dispatch(li, 'mousedown');
};

beforeAll(() => {
  // `collectEdits` builds a `[data-…="${CSS.escape(key)}"]` selector for the
  // non-picker fields; node has no global CSS — an identity escape suffices
  // for the simple keys these tests use.
  (globalThis as { CSS?: { escape(v: string): string } }).CSS = {
    escape: (v: string) => v,
  };
});

// ════════════════════════════════════════════════════════════════════
// Tests.
// ════════════════════════════════════════════════════════════════════

describe('reception inbox panel — destination ref-picker', () => {
  it('renders FormResponse answers as read-only review content', async () => {
    const { root } = setup({
      items: [item({
        top_tier_kind: 'form_response',
        args: {
          title: 'Client intake form submission',
          body: 'Project: Launch\nTimeline: Next month',
        },
        arg_schema: { fields: [] },
      })],
    });
    await flush();

    const summary = allNodes(root).find(
      (node) => node.className === 'reception-inbox-response-summary',
    );
    expect(summary).toBeDefined();
    expect(summary?.children.map((node) => node.textContent)).toEqual([
      'Submitted answers',
      'Project: Launch\nTimeline: Next month',
    ]);
    expect(root.querySelector('[data-recued-reception-inbox-field="body"]')).toBeNull();
  });

  it('renders the destination arg as a ref-picker, not the "Picker unavailable" stub', async () => {
    const { root } = setup({ items: [item()] });
    await flush();

    // The picker container is present…
    expect(root.querySelector('[data-recued-reception-inbox-picker="source_id"]')).not.toBeNull();
    // …and the live shell mounted inside it.
    expect(root.querySelector('[data-ref-picker="reception-inbox-dest-source_id"]')).not.toBeNull();
    // …while the dead <select> stub control was NOT rendered for this field.
    expect(root.querySelector('[data-recued-reception-inbox-field="source_id"]')).toBeNull();
  });

  it('loads work_entity.source.list lazily and only once across re-renders', async () => {
    const h = setup({ items: [item()] });
    await flush();
    expect(h.sourceListCount()).toBe(1);

    // Re-render (re-select the same hold) — the registry is cached, so the
    // panel must NOT re-fetch.
    h.mount.select('hold-1');
    await flush();
    expect(h.sourceListCount()).toBe(1);
  });

  it('keeps the "Picker unavailable" stub for an unknown options_source', async () => {
    const field: ArgEditField = {
      key: 'widget',
      type: 'string',
      label: 'Widget',
      options_source: 'some_other_source',
    };
    const { root } = setup({ items: [item({ arg_schema: { fields: [field] } })] });
    await flush();

    const control = root.querySelector('[data-recued-reception-inbox-field="widget"]');
    expect(control).not.toBeNull();
    expect(control!.tagName).toBe('SELECT');
    expect(control!.disabled).toBe(true);
    const emptyOption = control!.children[0]!;
    expect(emptyOption.textContent).toBe('Picker unavailable: some_other_source');
    // No live ref-picker for an unresolved source.
    expect(root.querySelector('[data-recued-reception-inbox-picker="widget"]')).toBeNull();
  });

  it('degrades gracefully when work_entity.source.list fails', async () => {
    const h = setup({ items: [item()], failSourceList: true });
    await flush();

    // The load failure is swallowed (it is not a panel-level error) and the
    // picker shell still renders.
    expect(h.mount.getState().error).toBeNull();
    expect(h.root.querySelector('[data-recued-reception-inbox-picker="source_id"]')).not.toBeNull();
    expect(h.sourceListCount()).toBe(1);
  });

  it('flows a picked destination into the approve dispatch', async () => {
    const h = setup({ items: [item({ hold_id: 'hold-1', args: { title: 'Follow up' } })] });
    await flush();

    await pickFirstDestination(h.root);
    findButton(h.root, 'Approve');
    dispatch(findButton(h.root, 'Approve'), 'click');
    await flush();

    const approves = h.approveCalls();
    expect(approves).toHaveLength(1);
    expect(approves[0]).toMatchObject({
      hold_id: 'hold-1',
      // First write-capable, enabled Source — `builtin.task` (label "Tasks").
      edits: { source_id: 'builtin.task' },
    });
  });

  it('does not leak a staged pick across a hold change', async () => {
    const h = setup({
      items: [
        item({ hold_id: 'hold-1', args: { title: 'A' } }),
        item({ hold_id: 'hold-2', args: { title: 'B' }, arg_schema: { fields: [] } }),
      ],
    });
    await flush();

    // Stage a pick on hold-1…
    await pickFirstDestination(h.root);
    // …and prove the pick is genuinely staged (non-vacuity): the committed
    // label now shows in the picker input, so the reset below is dropping a
    // REAL selection — not passing because nothing was ever picked.
    expect(
      h.root.querySelector(`[${RefPicker.REF_PICKER_INPUT_ATTR}]`)?.value,
    ).toBe('Tasks');
    // …then detour to hold-2 and back — the staged pick belongs to hold-1's
    // selection and must be dropped on the change.
    h.mount.select('hold-2');
    await flush();
    h.mount.select('hold-1');
    await flush();

    dispatch(findButton(h.root, 'Approve'), 'click');
    await flush();

    const approves = h.approveCalls();
    expect(approves).toHaveLength(1);
    expect(approves[0]!.hold_id).toBe('hold-1');
    // The picker re-mounted empty — no destination edit survives the detour.
    expect(approves[0]!.edits).toEqual({});
  });
});

describe('reception inbox panel — D-177 N.14 allow-for-this-form', () => {
  const OFFER = { ttl_ms: 86_400_000, max_uses: 20 };

  it('renders the allow button off the server-projected offer and flows allow into the dispatch', async () => {
    const h = setup({
      items: [item({ hold_id: 'hold-1', arg_schema: { fields: [] }, allow_offer: OFFER })],
    });
    await flush();

    const btn = h.root.querySelector(`[${RECEPTION_INBOX_ALLOW_BUTTON_ATTR}]`);
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain('24 h / 20 uses');

    dispatch(btn!, 'click');
    await flush();

    const approve = h.calls.find((c) => c.op === 'reception.inbox.approve');
    expect(approve).toBeDefined();
    expect(approve!.payload).toMatchObject({ hold_id: 'hold-1', allow: true, edits: {} });
  });

  it('renders NO allow button when the item carries no offer', async () => {
    const h = setup({ items: [item({ hold_id: 'hold-1', arg_schema: { fields: [] } })] });
    await flush();
    expect(h.root.querySelector(`[${RECEPTION_INBOX_ALLOW_BUTTON_ATTR}]`)).toBeNull();
  });

  it('refuses allow with staged edits — explains instead of silently dropping them', async () => {
    const h = setup({ items: [item({ hold_id: 'hold-1', allow_offer: OFFER })] });
    await flush();

    // Stage a real edit (the destination pick), then try to allow.
    await pickFirstDestination(h.root);
    dispatch(h.root.querySelector(`[${RECEPTION_INBOX_ALLOW_BUTTON_ATTR}]`)!, 'click');
    await flush();

    expect(h.mount.getState().error).toBe(RECEPTION_INBOX_ALLOW_WITH_EDITS_COPY);
    expect(h.calls.some((c) => c.op === 'reception.inbox.approve')).toBe(false);
  });
});

describe('reception inbox panel — broadcast subscription parity', () => {
  // D-169 TR-10: the server fans only the kinds each client names, so every
  // kind this panel subscribes to must be in the webclient default set or its
  // listener silently never fires (the live-refresh drift this ratchet guards).
  // The panel subscribes off RECEPTION_INBOX_BROADCAST_KINDS (single source of
  // truth), so this is the only assertion needed to keep the two in lockstep.
  it('RECEPTION_INBOX_BROADCAST_KINDS ⊆ WEBCLIENT_DEFAULT_SUBSCRIPTIONS', () => {
    for (const kind of RECEPTION_INBOX_BROADCAST_KINDS) {
      expect(WEBCLIENT_DEFAULT_SUBSCRIPTIONS).toContain(kind);
    }
  });
});
