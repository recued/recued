/** D-174 ref-picker — Reception Inbox panel DOM-glue tests.
 *
 *  The pure projection model (Source→option mapping, the destination-field
 *  predicate, the edit semantics) is covered in `inbox-model.test.ts`. This
 *  file covers the PANEL glue those helpers feed: that a held-op "Destination"
 *  arg renders the shared ref-picker (not the dead "Picker unavailable" stub),
 *  that `work_entity.source.list` is loaded lazily + once, that a load failure
 *  degrades gracefully, and — the seam no model test can reach — that a picked
 *  destination flows through `pickerValues` → `collectEdits` into the approve
 *  dispatch, that a failed registry read has an owned Retry, and that a picked
 *  destination does NOT leak across a hold change.
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
  RECEPTION_INBOX_DETAIL_HEADING_ATTR,
  RECEPTION_INBOX_DESTINATION_ERROR_ATTR,
  RECEPTION_INBOX_DESTINATION_RETRY_ATTR,
  RECEPTION_INBOX_HEADING_ATTR,
  RECEPTION_INBOX_REFRESH_ATTR,
  RECEPTION_INBOX_ROW_ATTR,
  RECEPTION_INBOX_STYLES,
  RECEPTION_INBOX_VIEW_ATTR,
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
const synthesizeRefPickerShell = (
  container: FakeEl,
  pickerId: string,
  onFocus?: (el: FakeEl) => void,
): void => {
  const shell = makeEl('div', onFocus);
  shell.setAttribute('data-ref-picker', pickerId);
  const field = makeEl('div', onFocus);
  const input = makeEl('input', onFocus);
  input.setAttribute(RefPicker.REF_PICKER_INPUT_ATTR, '');
  const clear = makeEl('button', onFocus);
  clear.setAttribute(RefPicker.REF_PICKER_CLEAR_ATTR, '');
  clear.setAttribute('hidden', '');
  const results = makeEl('ul', onFocus);
  results.setAttribute(RefPicker.REF_PICKER_RESULTS_ATTR, '');
  results.setAttribute('hidden', '');
  field.appendChild(input);
  field.appendChild(clear);
  shell.appendChild(field);
  shell.appendChild(results);
  container.appendChild(shell);
};

const makeEl = (tag: string, onFocus?: (el: FakeEl) => void): FakeEl => {
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
      if (m !== null) synthesizeRefPickerShell(el, m[1]!, onFocus);
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
    focus() {
      onFocus?.(el);
    },
  } as unknown as FakeEl;
  return el;
};

const makeDoc = (): Document => {
  let activeElement: FakeEl | null = null;
  return ({
    get activeElement() {
      return activeElement;
    },
    createElement: (tag: string) => makeEl(tag, (el) => {
      activeElement = el;
    }),
    createTextNode: (text: string) => {
      const n = makeEl('#text');
      n.textContent = text;
      return n;
    },
  }) as unknown as Document;
};

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
  ...(over.booking_history !== undefined ? { booking_history: over.booking_history } : {}),
});

const source = (over: Partial<SourceRegistration> = {}): SourceRegistration => ({
  id: over.id ?? 'builtin.task',
  top_tier_kind: over.top_tier_kind ?? 'task',
  source_kind: over.source_kind ?? 'builtin',
  // ⚠ The REAL label. `autoRegisterRecuedBuiltinSources` registers one
  // built-in per kind and gives all of them this same name — a fixture that
  // said 'Tasks' made the Source name look like a kind, which is precisely
  // what hid four indistinguishable picker options from these tests.
  source_label: over.source_label ?? 'Recued built-in',
  write_capable: over.write_capable ?? true,
  registered_at: over.registered_at ?? NOW,
});

const SOURCES: SourceRegistration[] = [
  source({ id: 'builtin.task', source_label: 'Recued built-in', top_tier_kind: 'task' }),
  source({ id: 'builtin.commit', source_label: 'Recued built-in', top_tier_kind: 'commitment' }),
  source({ id: 'ro.external', source_label: 'Read-only CRM', write_capable: false }),
];

interface ConnCall {
  op: string;
  payload: unknown;
}

interface Harness {
  mount: ReturnType<typeof mountReceptionInboxPanel>;
  root: FakeEl;
  document: Document;
  calls: ConnCall[];
  approveCalls: () => Array<{ hold_id: string; edits: Record<string, unknown> }>;
  sourceListCount: () => number;
}

const setup = (opts: {
  items: InboxItem[];
  sources?: SourceRegistration[];
  sourceListFailures?: number;
  sourceListGateAfterFirst?: Promise<void>;
  removeResolved?: boolean;
  decisionGate?: Promise<void>;
  failListAfterDecision?: boolean;
  listGateAfterFirst?: Promise<void>;
  headingLevel?: 2 | 3;
}): Harness => {
  const calls: ConnCall[] = [];
  let items = [...opts.items];
  let decisionAcknowledged = false;
  let listCalls = 0;
  let sourceListCalls = 0;
  let sourceListFailuresRemaining = opts.sourceListFailures ?? 0;
  const conn = ((op: string, payload?: unknown): Promise<unknown> => {
    calls.push({ op, payload });
    switch (op) {
      case 'reception.inbox.list':
        listCalls += 1;
        if (opts.failListAfterDecision === true && decisionAcknowledged) {
          return Promise.reject(new Error('refresh unavailable'));
        }
        return (
          listCalls > 1
            ? opts.listGateAfterFirst ?? Promise.resolve()
            : Promise.resolve()
        ).then(() => ({ items }));
      case 'work_entity.source.list':
        sourceListCalls += 1;
        if (sourceListFailuresRemaining > 0) {
          sourceListFailuresRemaining -= 1;
          return Promise.reject(new Error('source list unavailable'));
        }
        return (
          sourceListCalls > 1
            ? opts.sourceListGateAfterFirst ?? Promise.resolve()
            : Promise.resolve()
        ).then(() => ({
          sources: opts.sources ?? SOURCES,
          defaults_by_kind: {},
        }));
      case 'reception.inbox.approve':
        return (opts.decisionGate ?? Promise.resolve()).then(() => {
          decisionAcknowledged = true;
          if (opts.removeResolved === true) {
            const holdId = (payload as { hold_id: string }).hold_id;
            items = items.filter((item) => item.hold_id !== holdId);
          }
          return {
            hold_id: (payload as { hold_id: string }).hold_id,
            released: true,
            edited_keys: Object.keys(
              (payload as { edits?: Record<string, unknown> }).edits ?? {},
            ),
          };
        });
      case 'reception.inbox.reject':
        return (opts.decisionGate ?? Promise.resolve()).then(() => {
          decisionAcknowledged = true;
          if (opts.removeResolved === true) {
            const holdId = (payload as { hold_id: string }).hold_id;
            items = items.filter((item) => item.hold_id !== holdId);
          }
          return {
            hold_id: (payload as { hold_id: string }).hold_id,
            status: 'dismissed',
          };
        });
      default:
        return Promise.reject(new Error(`unexpected op ${op}`));
    }
  }) as unknown as ReceptionInboxConn;

  const host = makeEl('div');
  const document = makeDoc();
  const mount = mountReceptionInboxPanel({
    host: host as unknown as HTMLElement,
    conn,
    document,
    now: () => NOW,
    ...(opts.headingLevel !== undefined
      ? { headingLevel: opts.headingLevel }
      : {}),
  });
  const root = host.children[0]!;
  return {
    mount,
    root,
    document,
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
  it('owns its narrow grid and long-text containment', () => {
    expect(RECEPTION_INBOX_STYLES).toMatch(
      /\.reception-inbox-shell\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(RECEPTION_INBOX_STYLES).toContain(
      'grid-template-columns: minmax(0, 1fr);',
    );
    expect(RECEPTION_INBOX_STYLES).toMatch(
      /\.reception-inbox-row\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*max-width:\s*100%/s,
    );
  });

  it('nests inbox sections below a caller-owned route heading', async () => {
    const h = setup({
      items: [item()],
      headingLevel: 2,
    });
    await flush();

    expect(h.root.querySelector(
      `[${RECEPTION_INBOX_HEADING_ATTR}]`,
    )?.tagName).toBe('H2');
    const detailHeading = h.root.querySelector(
      `[${RECEPTION_INBOX_DETAIL_HEADING_ATTR}="hold-1"]`,
    );
    expect(detailHeading?.tagName).toBe('H3');
    expect(detailHeading?.getAttribute('id')).toBe(
      'recued-reception-inbox-detail-hold-1-title',
    );
    expect(h.root.querySelector(
      '[aria-labelledby="recued-reception-inbox-detail-hold-1-title"]',
    )?.tagName).toBe('FORM');
  });

  it('moves focus into a selected detail and preserves it through refresh', async () => {
    const h = setup({
      items: [
        item({ hold_id: 'hold-1', preview: { title: 'First request' } }),
        item({ hold_id: 'hold-2', preview: { title: 'Second request' } }),
      ],
    });
    await flush();

    const row = h.root.querySelector(
      `[${RECEPTION_INBOX_ROW_ATTR}="hold-2"]`,
    );
    if (row === null) throw new Error('second inbox row not mounted');
    dispatch(row, 'click');

    const heading = h.root.querySelector(
      `[${RECEPTION_INBOX_DETAIL_HEADING_ATTR}="hold-2"]`,
    );
    expect(heading).not.toBeNull();
    expect(heading!.tagName).toBe('H4');
    expect(heading!.getAttribute('tabindex')).toBe('-1');
    expect(h.document.activeElement).toBe(heading);

    await h.mount.refresh();
    const refreshedHeading = h.root.querySelector(
      `[${RECEPTION_INBOX_DETAIL_HEADING_ATTR}="hold-2"]`,
    );
    expect(refreshedHeading).not.toBe(heading);
    expect(h.document.activeElement).toBe(refreshedHeading);
  });

  it('preserves dirty fields, reject reason, and exact focus through refresh', async () => {
    const h = setup({
      items: [item({
        hold_id: 'hold-draft',
        args: { title: 'Server title' },
        arg_schema: {
          fields: [{
            key: 'title',
            type: 'string',
            label: 'Title',
            required: true,
          }],
        },
      })],
    });
    await flush();

    const title = h.root.querySelector(
      '[data-recued-reception-inbox-field="title"]',
    );
    const reason = h.root.querySelector(
      '[data-recued-reception-inbox-reason]',
    );
    if (title === null || reason === null) {
      throw new Error('decision draft controls not mounted');
    }
    const titleLabel = allNodes(h.root).find(
      (node) => node.tagName === 'LABEL' && node.textContent === 'Title *',
    );
    expect(title.getAttribute('aria-label')).toBe('Title');
    expect(title.getAttribute('id')).not.toBeNull();
    expect(titleLabel?.getAttribute('for')).toBe(title.getAttribute('id'));
    expect(reason.getAttribute('aria-label')).toBe('Reject reason');
    title.value = 'Owner draft';
    reason.value = 'Need the account owner to confirm.';
    title.focus();

    await h.mount.refresh();

    const refreshedTitle = h.root.querySelector(
      '[data-recued-reception-inbox-field="title"]',
    );
    const refreshedReason = h.root.querySelector(
      '[data-recued-reception-inbox-reason]',
    );
    expect(refreshedTitle?.value).toBe('Owner draft');
    expect(refreshedReason?.value).toBe('Need the account owner to confirm.');
    expect(h.document.activeElement).toBe(refreshedTitle);

    dispatch(findButton(h.root, 'Approve'), 'click');
    await flush();
    expect(h.approveCalls()).toHaveLength(1);
    expect(h.approveCalls()[0]!.edits).toEqual({ title: 'Owner draft' });
  });

  it('keeps manual Refresh focused and single-flight through its repaint', async () => {
    let releaseRefresh: () => void = () => {};
    const listGateAfterFirst = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const h = setup({
      items: [item({ arg_schema: { fields: [] } })],
      listGateAfterFirst,
    });
    await flush();

    const refresh = h.root.querySelector(
      `[${RECEPTION_INBOX_REFRESH_ATTR}]`,
    )!;
    refresh.focus();
    dispatch(refresh, 'click');
    await flush();

    const refreshing = h.root.querySelector(
      `[${RECEPTION_INBOX_REFRESH_ATTR}]`,
    )!;
    expect(refreshing.textContent).toBe('Refreshing…');
    expect(refreshing.getAttribute('aria-disabled')).toBe('true');
    expect(refreshing.getAttribute('aria-busy')).toBe('true');
    expect(refreshing.disabled).not.toBe(true);
    expect(h.document.activeElement).toBe(refreshing);
    dispatch(refreshing, 'click');
    dispatch(refreshing, 'click');
    expect(
      h.calls.filter((call) => call.op === 'reception.inbox.list'),
    ).toHaveLength(2);

    releaseRefresh();
    await flush();
    const settled = h.root.querySelector(
      `[${RECEPTION_INBOX_REFRESH_ATTR}]`,
    )!;
    expect(settled.textContent).toBe('Refresh');
    expect(h.document.activeElement).toBe(settled);
  });

  it('preserves an already-focused Refresh through a background refresh', async () => {
    let releaseRefresh: () => void = () => {};
    const listGateAfterFirst = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const h = setup({
      items: [item({ arg_schema: { fields: [] } })],
      listGateAfterFirst,
    });
    await flush();

    h.root.querySelector(`[${RECEPTION_INBOX_REFRESH_ATTR}]`)!.focus();
    const pendingRefresh = h.mount.refresh();
    await flush();
    const refreshing = h.root.querySelector(
      `[${RECEPTION_INBOX_REFRESH_ATTR}]`,
    )!;
    expect(refreshing.textContent).toBe('Refreshing…');
    expect(h.document.activeElement).toBe(refreshing);

    releaseRefresh();
    await pendingRefresh;
    await flush();
    expect(h.document.activeElement).toBe(h.root.querySelector(
      `[${RECEPTION_INBOX_REFRESH_ATTR}]`,
    ));
  });

  it('keeps an inbox view switch focused, selected, and single-flight', async () => {
    let releaseRefresh: () => void = () => {};
    const listGateAfterFirst = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const h = setup({
      items: [item({ arg_schema: { fields: [] } })],
      listGateAfterFirst,
    });
    await flush();

    const open = h.root.querySelector(
      `[${RECEPTION_INBOX_VIEW_ATTR}="open"]`,
    )!;
    const dismissed = h.root.querySelector(
      `[${RECEPTION_INBOX_VIEW_ATTR}="subview"]`,
    )!;
    expect(open.getAttribute('aria-pressed')).toBe('true');
    expect(dismissed.getAttribute('aria-pressed')).toBe('false');
    dismissed.focus();
    dispatch(dismissed, 'click');
    await flush();

    const switching = h.root.querySelector(
      `[${RECEPTION_INBOX_VIEW_ATTR}="subview"]`,
    )!;
    expect(switching.getAttribute('aria-disabled')).toBe('true');
    expect(switching.getAttribute('aria-busy')).toBe('true');
    expect(switching.disabled).not.toBe(true);
    expect(h.document.activeElement).toBe(switching);
    dispatch(switching, 'click');
    dispatch(switching, 'click');
    expect(
      h.calls.filter((call) => call.op === 'reception.inbox.list'),
    ).toHaveLength(2);

    releaseRefresh();
    await flush();
    const settled = h.root.querySelector(
      `[${RECEPTION_INBOX_VIEW_ATTR}="subview"]`,
    )!;
    expect(settled.getAttribute('aria-pressed')).toBe('true');
    expect(h.root.querySelector(
      `[${RECEPTION_INBOX_VIEW_ATTR}="open"]`,
    )?.getAttribute('aria-pressed')).toBe('false');
    expect(h.document.activeElement).toBe(settled);

    dispatch(settled, 'click');
    await flush();
    expect(
      h.calls.filter((call) => call.op === 'reception.inbox.list'),
    ).toHaveLength(2);
  });

  it('does not reclaim view-switch focus after the owner moves into detail', async () => {
    let releaseRefresh: () => void = () => {};
    const listGateAfterFirst = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const h = setup({
      items: [item({ arg_schema: { fields: [] } })],
      listGateAfterFirst,
    });
    await flush();

    const dismissed = h.root.querySelector(
      `[${RECEPTION_INBOX_VIEW_ATTR}="subview"]`,
    )!;
    dismissed.focus();
    dispatch(dismissed, 'click');
    await flush();
    h.root.querySelector(
      `[${RECEPTION_INBOX_DETAIL_HEADING_ATTR}="hold-1"]`,
    )!.focus();

    releaseRefresh();
    await flush();
    expect(h.document.activeElement).toBe(h.root.querySelector(
      `[${RECEPTION_INBOX_DETAIL_HEADING_ATTR}="hold-1"]`,
    ));
  });

  it('does not reclaim Refresh focus after the owner moves into the detail', async () => {
    let releaseRefresh: () => void = () => {};
    const listGateAfterFirst = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const h = setup({
      items: [item({ arg_schema: { fields: [] } })],
      listGateAfterFirst,
    });
    await flush();

    const refresh = h.root.querySelector(
      `[${RECEPTION_INBOX_REFRESH_ATTR}]`,
    )!;
    refresh.focus();
    dispatch(refresh, 'click');
    await flush();
    const heading = h.root.querySelector(
      `[${RECEPTION_INBOX_DETAIL_HEADING_ATTR}="hold-1"]`,
    )!;
    heading.focus();

    releaseRefresh();
    await flush();
    expect(h.document.activeElement).toBe(h.root.querySelector(
      `[${RECEPTION_INBOX_DETAIL_HEADING_ATTR}="hold-1"]`,
    ));
  });

  it('selects and focuses the next visible item after approving the middle row', async () => {
    let releaseDecision!: () => void;
    const decisionGate = new Promise<void>((resolve) => {
      releaseDecision = resolve;
    });
    const h = setup({
      items: [
        item({
          hold_id: 'hold-1',
          preview: { title: 'First request' },
          arg_schema: { fields: [] },
        }),
        item({
          hold_id: 'hold-2',
          preview: { title: 'Second request' },
          arg_schema: { fields: [] },
        }),
        item({
          hold_id: 'hold-3',
          preview: { title: 'Third request' },
          arg_schema: { fields: [] },
        }),
      ],
      removeResolved: true,
      decisionGate,
    });
    await flush();

    dispatch(h.root.querySelector(
      `[${RECEPTION_INBOX_ROW_ATTR}="hold-2"]`,
    )!, 'click');
    const approve = findButton(h.root, 'Approve');
    approve.focus();
    dispatch(approve, 'click');

    const approving = findButton(h.root, 'Approving…');
    expect(h.document.activeElement).toBe(approving);
    expect(approving.disabled).not.toBe(true);
    expect(approving.getAttribute('aria-disabled')).toBe('true');
    expect(approving.getAttribute('aria-busy')).toBe('true');
    expect(h.mount.hasInFlightWork()).toBe(true);
    dispatch(approving, 'click');
    dispatch(approving, 'click');
    expect(h.approveCalls()).toHaveLength(1);

    releaseDecision();
    await flush();

    expect(h.mount.hasInFlightWork()).toBe(false);
    expect(h.mount.getState().selected_hold_id).toBe('hold-3');
    expect(h.root.querySelector(
      `[${RECEPTION_INBOX_ROW_ATTR}="hold-2"]`,
    )).toBeNull();
    const nextHeading = h.root.querySelector(
      `[${RECEPTION_INBOX_DETAIL_HEADING_ATTR}="hold-3"]`,
    );
    expect(h.document.activeElement).toBe(nextHeading);
  });

  it('does not resurrect an acknowledged decision from a stale refresh', async () => {
    const h = setup({
      items: [
        item({ hold_id: 'hold-1', arg_schema: { fields: [] } }),
        item({ hold_id: 'hold-2', arg_schema: { fields: [] } }),
      ],
    });
    await flush();

    const approve = findButton(h.root, 'Approve');
    approve.focus();
    dispatch(approve, 'click');
    await flush();

    expect(h.approveCalls()).toHaveLength(1);
    expect(h.root.querySelector(
      `[${RECEPTION_INBOX_ROW_ATTR}="hold-1"]`,
    )).toBeNull();
    expect(h.mount.getState().selected_hold_id).toBe('hold-2');
    expect(h.document.activeElement).toBe(h.root.querySelector(
      `[${RECEPTION_INBOX_DETAIL_HEADING_ATTR}="hold-2"]`,
    ));
  });

  it('keeps an acknowledged decision settled when its refresh fails', async () => {
    const h = setup({
      items: [
        item({ hold_id: 'hold-1', arg_schema: { fields: [] } }),
        item({ hold_id: 'hold-2', arg_schema: { fields: [] } }),
      ],
      failListAfterDecision: true,
    });
    await flush();

    const approve = findButton(h.root, 'Approve');
    approve.focus();
    dispatch(approve, 'click');
    await flush();

    expect(h.approveCalls()).toHaveLength(1);
    expect(h.mount.getState().in_flight).toBe(false);
    expect(h.mount.getState().error).toBe(
      "Decision saved, but the inbox couldn't refresh: refresh unavailable",
    );
    expect(h.root.querySelector(
      `[${RECEPTION_INBOX_ROW_ATTR}="hold-1"]`,
    )).toBeNull();
    expect(h.root.querySelector('[role="alert"]')?.textContent).toBe(
      "Decision saved, but the inbox couldn't refresh: refresh unavailable",
    );
    expect(h.mount.getState().selected_hold_id).toBe('hold-2');
    expect(h.document.activeElement).toBe(h.root.querySelector(
      `[${RECEPTION_INBOX_DETAIL_HEADING_ATTR}="hold-2"]`,
    ));
  });

  it('settles a decision after the owner reviews a different row in flight', async () => {
    let releaseDecision!: () => void;
    const decisionGate = new Promise<void>((resolve) => {
      releaseDecision = resolve;
    });
    const h = setup({
      items: [
        item({ hold_id: 'hold-1', arg_schema: { fields: [] } }),
        item({ hold_id: 'hold-2', arg_schema: { fields: [] } }),
      ],
      removeResolved: true,
      decisionGate,
    });
    await flush();

    dispatch(h.root.querySelector(
      `[${RECEPTION_INBOX_ROW_ATTR}="hold-2"]`,
    )!, 'click');
    dispatch(findButton(h.root, 'Approve'), 'click');
    dispatch(h.root.querySelector(
      `[${RECEPTION_INBOX_ROW_ATTR}="hold-1"]`,
    )!, 'click');

    releaseDecision();
    await flush();

    expect(h.mount.getState().in_flight).toBe(false);
    expect(h.mount.getState().selected_hold_id).toBe('hold-1');
    expect(h.root.querySelector(
      `[${RECEPTION_INBOX_ROW_ATTR}="hold-2"]`,
    )).toBeNull();
    expect(h.document.activeElement).toBe(h.root.querySelector(
      `[${RECEPTION_INBOX_DETAIL_HEADING_ATTR}="hold-1"]`,
    ));
  });

  it('focuses the inbox heading after rejecting the final item', async () => {
    let releaseDecision!: () => void;
    const decisionGate = new Promise<void>((resolve) => {
      releaseDecision = resolve;
    });
    const h = setup({
      items: [item({ hold_id: 'hold-1', arg_schema: { fields: [] } })],
      removeResolved: true,
      decisionGate,
    });
    await flush();

    dispatch(h.root.querySelector(
      `[${RECEPTION_INBOX_ROW_ATTR}="hold-1"]`,
    )!, 'click');
    const reject = findButton(h.root, 'Reject');
    reject.focus();
    dispatch(reject, 'click');

    const rejecting = findButton(h.root, 'Rejecting…');
    expect(h.document.activeElement).toBe(rejecting);
    expect(rejecting.disabled).not.toBe(true);
    expect(rejecting.getAttribute('aria-disabled')).toBe('true');
    expect(rejecting.getAttribute('aria-busy')).toBe('true');

    releaseDecision();
    await flush();

    expect(h.mount.getState().selected_hold_id).toBeNull();
    const heading = h.root.querySelector(`[${RECEPTION_INBOX_HEADING_ATTR}]`);
    expect(heading?.getAttribute('tabindex')).toBe('-1');
    expect(h.document.activeElement).toBe(heading);
  });

  it('renders owner-only prior booking history in the review detail', async () => {
    const { root } = setup({
      items: [item({
        top_tier_kind: 'booking',
        source: { kind: 'scheduling_link', endpoint_id: 'ep-1', record_ref: 'cp-1' },
        booking_history: {
          counterparty_contact_id: 'contact-opaque',
          total: 1,
          entries: [{
            id: 'booking-old',
            title: 'Earlier consultation',
            lifecycle_state: 'no_show',
            created_at: NOW - 2,
            state_changed_at: NOW - 1,
          }],
        },
      })],
    });
    await flush();

    const history = allNodes(root).find((node) => node.className === 'reception-inbox-history');
    expect(history).toBeDefined();
    const text = allNodes(history!).map((node) => node.textContent).join('\n');
    expect(text).toContain('Previous bookings (1)');
    expect(text).toContain('Earlier consultation — no show');
    expect(text).not.toContain('contact-opaque');
    expect(text).not.toContain('@');
  });

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

  it('keeps a failed destination inventory explicit, single-flight, and recoverable', async () => {
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const h = setup({
      items: [item()],
      sourceListFailures: 1,
      sourceListGateAfterFirst: retryGate,
    });
    await flush();

    // The enhancement stays scoped to its field, but a failed registry read
    // no longer strands the owner in a terminal empty picker.
    expect(h.mount.getState().error).toBeNull();
    const failure = h.root.querySelector(
      `[${RECEPTION_INBOX_DESTINATION_ERROR_ATTR}="source_id"]`,
    );
    expect(failure).not.toBeNull();
    expect(failure?.getAttribute('role')).toBe('alert');
    expect(allNodes(failure!).map((node) => node.textContent).join(' '))
      .toContain('source list unavailable');
    expect(h.root.querySelector(
      '[data-ref-picker="reception-inbox-dest-source_id"]',
    )).toBeNull();
    expect(h.sourceListCount()).toBe(1);

    const retry = h.root.querySelector(
      `[${RECEPTION_INBOX_DESTINATION_RETRY_ATTR}="source_id"]`,
    )!;
    retry.focus();
    dispatch(retry, 'click');
    expect(h.sourceListCount()).toBe(2);
    const retrying = findButton(h.root, 'Retrying…');
    expect(h.document.activeElement).toBe(retrying);
    expect(retrying.getAttribute('aria-disabled')).toBe('true');
    expect(retrying.getAttribute('aria-busy')).toBe('true');
    dispatch(retrying, 'click');
    dispatch(retrying, 'click');
    expect(h.sourceListCount()).toBe(2);

    releaseRetry();
    await flush();
    expect(h.root.querySelector(
      `[${RECEPTION_INBOX_DESTINATION_ERROR_ATTR}="source_id"]`,
    )).toBeNull();
    const picker = h.root.querySelector(`[${RefPicker.REF_PICKER_INPUT_ATTR}]`);
    expect(picker).not.toBeNull();
    expect(h.document.activeElement).toBe(picker);
  });

  it('sends a NEVER-PREFILLED datetime as epoch ms, not the raw string', async () => {
    // D-210 audit finding 7 — the coercion used to be conditional on the arg
    // already holding a number:
    //     if (typeof field.value === 'number') return new Date(raw).getTime();
    //     return raw;
    // …so a `datetime` the op never prefilled shipped the raw wall-clock STRING,
    // and the server's edit validator demands a finite number — `edit_invalid`,
    // thrown BEFORE release, failing the whole approve. Live on the only path
    // that reaches it: `reception-approval.json` declares `promised_for_at` as
    // `datetime` and the approval processor never sets it, so "Due" always
    // renders empty. The `/ask` landing surface coerced correctly, so the
    // owner's two surfaces disagreed on the same field — exactly what the
    // server-side enforcement's own comment says it exists to prevent.
    //
    // Asserting the REQUEST: what the client puts on the wire is this module's
    // responsibility. ⇒ [[a_defaulted_field_is_not_evidence]]
    const h = setup({
      items: [item({
        hold_id: 'hold-dt',
        // No `promised_for_at` in args — the never-prefilled case.
        args: { title: 'Follow up' },
        arg_schema: {
          fields: [{
            key: 'promised_for_at',
            type: 'datetime',
            label: 'Due',
            required: false,
          }],
        },
      })],
    });
    await flush();

    const input = h.root.querySelector('[data-recued-reception-inbox-field]');
    if (input === null) throw new Error('edit control not mounted');
    input.value = '2026-08-01T10:00';
    dispatch(input, 'input');
    dispatch(findButton(h.root, 'Approve'), 'click');
    await flush();

    const approves = h.approveCalls();
    expect(approves).toHaveLength(1);
    const sent = approves[0]!.edits.promised_for_at;
    // ⛔ The finding: pre-fix this was the string '2026-08-01T10:00'.
    expect(typeof sent).toBe('number');
    expect(Number.isFinite(sent as number)).toBe(true);
  });

  it('puts a CLEARED optional field on the wire as null, not a dropped key', async () => {
    // ⛔ REGRESSION GUARD, and the reason it asserts the REQUEST: `JSON.stringify`
    // drops own properties valued `undefined`, so `edits[key] = undefined` — what
    // `parseFieldValue` returns for an emptied optional field — never reached the
    // server at all. `validateEditsAgainstSchema` iterates `Object.keys(edits)`,
    // saw nothing, wrote no override, and the promotion fell back to the SEALED
    // ORIGINAL. The owner clears the visitor's email, the RPC reports
    // `released: true, edited_keys: []`, and the address they deleted is what
    // lands on the canonical record. A local assertion on the `edits` object
    // would have passed — only the serialized request shows it.
    // ⇒ [[a_defaulted_field_is_not_evidence]]
    const h = setup({
      items: [item({
        hold_id: 'hold-clear',
        args: { form_response_visitor_email: 'typo@exmaple.test' },
        arg_schema: {
          fields: [{
            key: 'form_response_visitor_email',
            type: 'string',
            label: 'Visitor email',
            required: false,
          }],
        },
      })],
    });
    await flush();

    const input = h.root.querySelector('[data-recued-reception-inbox-field]');
    if (input === null) throw new Error('edit control not mounted');
    input.value = '';
    dispatch(input, 'input');
    dispatch(findButton(h.root, 'Approve'), 'click');
    await flush();

    const approves = h.approveCalls();
    expect(approves).toHaveLength(1);
    const { edits } = approves[0]!;
    // The key must SURVIVE serialization — this is the half that was broken.
    const wire = JSON.parse(JSON.stringify(edits)) as Record<string, unknown>;
    expect(Object.hasOwn(wire, 'form_response_visitor_email')).toBe(true);
    expect(wire.form_response_visitor_email).toBeNull();
    expect(JSON.stringify(wire)).not.toContain('exmaple');
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
    ).toBe('Task · Recued built-in');
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
    let releaseDecision!: () => void;
    const decisionGate = new Promise<void>((resolve) => {
      releaseDecision = resolve;
    });
    const h = setup({
      items: [item({ hold_id: 'hold-1', arg_schema: { fields: [] }, allow_offer: OFFER })],
      decisionGate,
    });
    await flush();

    const btn = h.root.querySelector(`[${RECEPTION_INBOX_ALLOW_BUTTON_ATTR}]`);
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain('24 h / 20 uses');

    dispatch(btn!, 'click');

    const allowing = findButton(h.root, 'Approving & allowing…');
    expect(h.document.activeElement).toBe(allowing);
    expect(allowing.disabled).not.toBe(true);
    expect(allowing.getAttribute('aria-disabled')).toBe('true');
    expect(allowing.getAttribute('aria-busy')).toBe('true');

    releaseDecision();
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
