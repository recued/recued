/** D-210 §4c slice 2 — the Records section's two lenses.
 *
 *  The assertions that matter here are the ones a rendering test can't see:
 *
 *    1. **Switching lenses disposes the previous one.** Both lenses append a root to the shared
 *       content host AND register a click listener on it. A switch that forgets to dispose leaves
 *       the old listener live underneath, so one click fires in both lenses.
 *    2. **The Responses lens calls the automation matcher with `(recipes, response)`.** Both args
 *       are object-ish, so a swap is exactly the kind of thing a looser signature would accept —
 *       and I got it backwards on the first write.
 */

import { describe, expect, it } from 'vitest';
import type { FormResponse, FormResponseListItem } from '@recued/contracts';

import {
  RECEPTION_RECORDS_LENS_ATTR,
  mountReceptionRecordsSection,
  type ReceptionRecordsSectionConn,
} from './records-section.js';
import {
  FR_LENS_EMPTY_COPY,
  FR_LENS_DETAIL_RETRY_ATTR,
  FR_LENS_ERROR_ATTR,
  FR_LENS_RETRY_ATTR,
  formResponseFields,
  type ReceptionFormResponseLensMount,
} from './form-response-lens.js';

const NOW = 1_700_000_000_000;

// ── Fake DOM (same compact harness as records-panel.test.ts) ────────────────
interface FakeEl {
  tagName: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  listeners: Map<string, Array<(ev: unknown) => void>>;
  innerHTML: string;
  className: string;
  textContent: string;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  appendChild(c: FakeEl): FakeEl;
  addEventListener(t: string, fn: (ev: unknown) => void): void;
  removeEventListener(t: string, fn: (ev: unknown) => void): void;
  remove(): void;
}

const makeEl = (tagName: string): FakeEl => {
  let html = '';
  const el: FakeEl = {
  tagName,
  attrs: new Map(),
  children: [],
  listeners: new Map(),
  // ⛔ A real `innerHTML = ''` DETACHES the children. A plain string field does not, and that
  // difference is load-bearing here: the section clears its content host that way on a lens
  // switch, so a non-clearing fake leaves the OLD lens's root at children[0] and every assertion
  // reads the wrong lens. The harness has to model the teardown or it hides the thing under test.
  get innerHTML() { return html; },
  set innerHTML(next: string) {
    html = next;
    if (next === '') el.children.length = 0;
  },
  className: '',
  textContent: '',
  setAttribute(k, v) { this.attrs.set(k, v); },
  getAttribute(k) { return this.attrs.has(k) ? (this.attrs.get(k) as string) : null; },
  appendChild(c) { this.children.push(c); return c; },
  addEventListener(t, fn) {
    const list = this.listeners.get(t) ?? [];
    list.push(fn);
    this.listeners.set(t, list);
  },
  removeEventListener(t, fn) {
    const list = this.listeners.get(t) ?? [];
    this.listeners.set(t, list.filter((f) => f !== fn));
  },
  remove() { /* detach is a no-op in the fake tree */ },
  };
  return el;
};

const makeDoc = (): { doc: Document; host: FakeEl } => ({
  doc: { createElement: (tag: string) => makeEl(tag) } as unknown as Document,
  host: makeEl('div'),
});

const listItem = (over: Partial<FormResponseListItem> = {}): FormResponseListItem => ({
  submission_id: 'sub_1',
  endpoint_id: 'ep_1',
  form_definition_id: 'contact_form',
  template_ref: 'recued/contact',
  visitor: { email: 'v@example.com' },
  submitted_at: NOW - 1000,
  accepted_at: NOW,
  ...over,
} as FormResponseListItem);

const makeConn = (over: Record<string, unknown> = {}) => {
  const calls: Array<{ method: string; args: unknown }> = [];
  const conn = ((method: string, args?: unknown) => {
    calls.push({ method, args });
    if (method in over) {
      const result = over[method];
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    }
    if (method === 'reception.record.list') return Promise.resolve({ records: [], truncated: false });
    if (method === 'form_response.list') return Promise.resolve({ responses: [] });
    if (method === 'recipe.list') return Promise.resolve({ recipes: [] });
    return Promise.resolve({});
  }) as unknown as ReceptionRecordsSectionConn;
  return { conn, calls };
};

const mount = (over: Record<string, unknown> = {}) => {
  const { doc, host } = makeDoc();
  const { conn, calls } = makeConn(over);
  const section = mountReceptionRecordsSection({
    host: host as unknown as HTMLElement,
    conn,
    document: doc,
    now: () => NOW,
  });
  return { host, calls, section };
};

describe('mountReceptionRecordsSection — lenses', () => {
  it('renders one roving tab stop with a labelled tabpanel', () => {
    const { host } = mount();
    const root = host.children[0] as FakeEl;
    const nav = root.children.find((c) => c.className === 'reception-records-lenses')!;
    const content = root.children.at(-1)!;
    const [requests, responses] = nav.children;

    expect(nav.getAttribute('role')).toBe('tablist');
    expect(requests?.getAttribute('role')).toBe('tab');
    expect(requests?.getAttribute('aria-selected')).toBe('true');
    expect(requests?.getAttribute('tabindex')).toBe('0');
    expect(responses?.getAttribute('aria-selected')).toBe('false');
    expect(responses?.getAttribute('tabindex')).toBe('-1');
    expect(content.getAttribute('role')).toBe('tabpanel');
    expect(content.getAttribute('aria-labelledby')).toBe(
      requests?.getAttribute('id'),
    );
  });

  it('switches lenses with the horizontal tab keys', () => {
    const { host, section } = mount();
    const root = host.children[0] as FakeEl;
    const nav = root.children.find((c) => c.className === 'reception-records-lenses')!;
    const [requests, responses] = nav.children;
    const listener = nav.listeners.get('keydown')?.[0];
    let prevented = 0;

    listener?.({
      target: requests,
      key: 'ArrowRight',
      preventDefault: () => { prevented += 1; },
    });
    expect(section.activeLens()).toBe('responses');
    expect(responses?.getAttribute('aria-selected')).toBe('true');
    expect(responses?.getAttribute('tabindex')).toBe('0');

    listener?.({
      target: responses,
      key: 'Home',
      preventDefault: () => { prevented += 1; },
    });
    expect(section.activeLens()).toBe('requests');
    expect(requests?.getAttribute('aria-selected')).toBe('true');
    expect(prevented).toBe(2);
  });

  it('opens on Requests and queries the record list, not form responses', async () => {
    const { calls, section } = mount();
    await Promise.resolve();
    expect(section.activeLens()).toBe('requests');
    expect(calls.map((c) => c.method)).toContain('reception.record.list');
    expect(calls.map((c) => c.method)).not.toContain('form_response.list');
  });

  it('switching to Responses queries form_response.list', async () => {
    const { calls, section } = mount();
    section.setLens('responses');
    await Promise.resolve();
    await Promise.resolve();
    expect(section.activeLens()).toBe('responses');
    expect(calls.map((c) => c.method)).toContain('form_response.list');
  });

  it('DISPOSES the previous lens on switch — no stale listener underneath', async () => {
    // ⛔ Both lenses register a click listener on their own root inside the shared content host.
    // Without the dispose, the old root stays attached with a live listener and one click fires
    // in both lenses. Asserting the mount is torn down is the only way to see that from here.
    const { section } = mount();
    const first = section.current();
    let disposed = false;
    const realDispose = first.dispose.bind(first);
    (first as { dispose: () => void }).dispose = () => { disposed = true; realDispose(); };
    section.setLens('responses');
    expect(disposed).toBe(true);
    expect(section.current()).not.toBe(first);
  });

  it('is idempotent — re-selecting the active lens does not remount', async () => {
    const { section } = mount();
    const first = section.current();
    section.setLens('requests');
    expect(section.current()).toBe(first);
  });

  it('drives the lens switch from a CLICK, not just the api', async () => {
    const { host, section } = mount();
    // nav is the second child of the section root (style, nav, content).
    const root = host.children[0] as FakeEl;
    const nav = root.children.find((c) => c.className === 'reception-records-lenses');
    expect(nav).toBeDefined();
    const listener = nav?.listeners.get('click')?.[0];
    expect(listener).toBeTypeOf('function');
    listener?.({
      target: {
        getAttribute: (k: string) => (k === RECEPTION_RECORDS_LENS_ATTR ? 'responses' : null),
      },
    });
    expect(section.activeLens()).toBe('responses');
  });

  it('renders the empty copy that names WHERE the missing thing is', async () => {
    const { host, section } = mount({ 'form_response.list': { responses: [] } });
    section.setLens('responses');
    await Promise.resolve();
    await Promise.resolve();
    const root = host.children[0] as FakeEl;
    const content = root.children.at(-1) as FakeEl;
    const html = (content.children[0] as FakeEl | undefined)?.innerHTML ?? '';
    expect(html).toContain(FR_LENS_EMPTY_COPY);
    expect(FR_LENS_EMPTY_COPY).toContain('Reception Inbox');
  });

  it('lists accepted responses when there are some', async () => {
    const { host, section } = mount({
      'form_response.list': { responses: [listItem()] },
    });
    section.setLens('responses');
    await Promise.resolve();
    await Promise.resolve();
    const root = host.children[0] as FakeEl;
    const content = root.children.at(-1) as FakeEl;
    const html = (content.children[0] as FakeEl | undefined)?.innerHTML ?? '';
    expect(html).toContain('v@example.com');
    expect(html).not.toContain(FR_LENS_EMPTY_COPY);
  });

  it('offers an alerting Retry instead of empty copy after a list failure', async () => {
    const { host, section } = mount({
      'form_response.list': new Error('responses offline'),
    });
    section.setLens('responses');
    await Promise.resolve();
    await Promise.resolve();
    const root = host.children[0] as FakeEl;
    const content = root.children.at(-1) as FakeEl;
    const html = (content.children[0] as FakeEl | undefined)?.innerHTML ?? '';
    expect(html).toContain(FR_LENS_ERROR_ATTR);
    expect(html).toContain('role="alert"');
    expect(html).toContain('responses offline');
    expect(html).toContain(FR_LENS_RETRY_ATTR);
    expect(html).not.toContain(FR_LENS_EMPTY_COPY);
  });

  it('offers a detail-scoped Retry only when the detail read fails', async () => {
    const { host, section } = mount({
      'form_response.list': { responses: [listItem()] },
      'form_response.get': new Error('detail offline'),
    });
    section.setLens('responses');
    await Promise.resolve();
    await Promise.resolve();
    await (section.current() as ReceptionFormResponseLensMount).open('sub_1');
    const root = host.children[0] as FakeEl;
    const content = root.children.at(-1) as FakeEl;
    const html = (content.children[0] as FakeEl | undefined)?.innerHTML ?? '';
    expect(html).toContain(FR_LENS_ERROR_ATTR);
    expect(html).toContain('detail offline');
    expect(html).toContain(FR_LENS_DETAIL_RETRY_ATTR);
    expect(html).toContain('Try again or return to the list');
  });
});

describe('formResponseFields — the ported projection', () => {
  const response = (over: Partial<FormResponse> = {}): FormResponse => ({
    definition_snapshot: {
      fields: [
        { name: 'full_name', label: 'Your name' },
        { name: 'topic' },
      ],
    },
    values: { full_name: 'Ada', topic: 'Booking', stray_extra: 'kept' },
    ...over,
  } as unknown as FormResponse);

  it('keeps the frozen snapshot order and its labels', () => {
    const fields = formResponseFields(response());
    expect(fields.slice(0, 2).map((f) => [f.name, f.label])).toEqual([
      ['full_name', 'Your name'],
      ['topic', 'Topic'],
    ]);
  });

  it('never SILENTLY DROPS a value missing from the snapshot', () => {
    // ⚠ Ported behaviour, deliberately: on a record surface an answer that exists but was not
    // declared must still be visible — a dropped answer and an unanswered question look identical
    // to the owner otherwise.
    const fields = formResponseFields(response());
    expect(fields.map((f) => f.name)).toContain('stray_extra');
    expect(fields.at(-1)).toEqual({ name: 'stray_extra', label: 'Stray Extra', value: 'kept' });
  });

  it('tolerates a malformed snapshot rather than throwing', () => {
    const fields = formResponseFields(
      response({ definition_snapshot: { fields: 'not-an-array' } } as Partial<FormResponse>),
    );
    expect(fields.map((f) => f.name).sort()).toEqual(['full_name', 'stray_extra', 'topic']);
  });
});
