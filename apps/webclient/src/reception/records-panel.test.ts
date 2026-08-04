/** D-210 §4c — reception records PANEL glue tests.
 *
 *  The pure mapping is covered in `records-model.test.ts`. This file covers the seams no model
 *  test can reach: what actually goes on the wire when a filter is clicked, that the two
 *  never-swallow states (truncation, nothing-materialized) reach the DOM, and that a slow
 *  response cannot paint over a newer filter's answer.
 *
 *  Runs against a compact fake DOM — the panel writes `innerHTML` as a string, so assertions
 *  read that string directly rather than needing a parsed tree.
 */

import { describe, expect, it } from 'vitest';
import type {
  ReceptionBookingRecordSummary,
  ReceptionRecordListInput,
  ReceptionRecordListResult,
} from '@recued/contracts';

import {
  RECEPTION_RECORDS_EMPTY_ATTR,
  RECEPTION_RECORDS_ERROR_ATTR,
  RECEPTION_RECORDS_KIND_ATTR,
  RECEPTION_RECORDS_RETRY_ATTR,
  RECEPTION_RECORDS_TRUNCATED_ATTR,
  RECEPTION_RECORDS_UNRESOLVED_ATTR,
  RECEPTION_RECORDS_UNRESOLVED_COPY,
  RECEPTION_RECORDS_UNRESOLVED_TERMINAL_COPY,
  mountReceptionRecordsPanel,
  type ReceptionRecordsConn,
} from './records-panel.js';

const NOW = 1_700_000_000_000;

// ════════════════════════════════════════════════════════════════
// Fake DOM
// ════════════════════════════════════════════════════════════════

interface FakeEl {
  tagName: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  listeners: Map<string, Array<(ev: unknown) => void>>;
  innerHTML: string;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  appendChild(c: FakeEl): FakeEl;
  addEventListener(t: string, fn: (ev: unknown) => void): void;
  removeEventListener(t: string, fn: (ev: unknown) => void): void;
  remove(): void;
}

const makeEl = (tagName: string): FakeEl => ({
  tagName,
  attrs: new Map(),
  children: [],
  listeners: new Map(),
  innerHTML: '',
  setAttribute(k, v) {
    this.attrs.set(k, v);
  },
  getAttribute(k) {
    return this.attrs.has(k) ? (this.attrs.get(k) as string) : null;
  },
  appendChild(c) {
    this.children.push(c);
    return c;
  },
  addEventListener(t, fn) {
    const list = this.listeners.get(t) ?? [];
    list.push(fn);
    this.listeners.set(t, list);
  },
  removeEventListener(t, fn) {
    const list = this.listeners.get(t) ?? [];
    this.listeners.set(
      t,
      list.filter((f) => f !== fn),
    );
  },
  remove() {
    /* detach is a no-op in the fake tree */
  },
});

const makeDoc = (): { doc: Document; host: FakeEl } => {
  const host = makeEl('div');
  const doc = { createElement: (tag: string) => makeEl(tag) } as unknown as Document;
  return { doc, host };
};

/** The panel's root is the first child the host received. */
const rootOf = (host: FakeEl): FakeEl => host.children[0] as FakeEl;

const booking = (
  over: Partial<ReceptionBookingRecordSummary> = {},
): ReceptionBookingRecordSummary => ({
  kind: 'scheduling_link',
  record_id: 'bk_1',
  endpoint_id: 'ep_sched',
  received_at: NOW - 3_600_000,
  outcome: 'pending',
  slot: { start_at: NOW, end_at: NOW + 3_600_000, duration_minutes: 60 },
  resolved: [],
  ...over,
});

/** A conn that records every call's args and answers from a queue of results. */
const makeConn = (
  results: ReadonlyArray<ReceptionRecordListResult | Error>,
): {
  conn: ReceptionRecordsConn;
  calls: ReceptionRecordListInput[];
} => {
  const calls: ReceptionRecordListInput[] = [];
  let i = 0;
  const conn = ((_method: string, args?: ReceptionRecordListInput) => {
    calls.push(args ?? {});
    const next = results[Math.min(i, results.length - 1)];
    i += 1;
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }) as unknown as ReceptionRecordsConn;
  return { conn, calls };
};

const ok = (
  records: ReadonlyArray<ReceptionBookingRecordSummary>,
  truncated = false,
): ReceptionRecordListResult => ({ records, truncated });

const mount = (
  results: ReadonlyArray<ReceptionRecordListResult | Error>,
): {
  host: FakeEl;
  calls: ReceptionRecordListInput[];
  panel: ReturnType<typeof mountReceptionRecordsPanel>;
} => {
  const { doc, host } = makeDoc();
  const { conn, calls } = makeConn(results);
  const panel = mountReceptionRecordsPanel({
    host: host as unknown as HTMLElement,
    conn,
    document: doc,
    now: () => NOW,
  });
  return { host, calls, panel };
};

// ════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════

describe('mountReceptionRecordsPanel — what reaches the wire', () => {
  it('loads unfiltered on mount', async () => {
    const { calls, panel } = mount([ok([booking()])]);
    await panel.refresh();
    expect(calls[0]).toEqual({});
  });

  it('sends the WAITING filter to the server, not to a client-side filter', async () => {
    // 🔑 The whole point: filtering server-side keeps `truncated` meaningful. If this ever
    // regresses to filtering the rendered rows, `truncated` starts describing a page the owner
    // never sees.
    const { calls, panel } = mount([ok([booking()])]);
    await panel.setOutcome('waiting');
    expect(calls.at(-1)).toEqual({ outcome: 'pending' });
  });

  it('sends the kind filter, and both together', async () => {
    const { calls, panel } = mount([ok([booking()])]);
    await panel.setKind('intake_form');
    expect(calls.at(-1)).toEqual({ kind: 'intake_form' });
    await panel.setOutcome('waiting');
    expect(calls.at(-1)).toEqual({ kind: 'intake_form', outcome: 'pending' });
  });

  it('re-loads when a filter chip is CLICKED (the delegation, not just the api)', async () => {
    const { host, calls, panel } = mount([ok([booking()])]);
    await panel.refresh();
    const before = calls.length;
    const listener = rootOf(host).listeners.get('click')?.[0];
    expect(listener).toBeTypeOf('function');
    listener?.({
      target: {
        getAttribute: (k: string) =>
          k === RECEPTION_RECORDS_KIND_ATTR ? 'scheduling_link' : null,
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.length).toBeGreaterThan(before);
    expect(calls.at(-1)).toEqual({ kind: 'scheduling_link' });
  });

  it('exposes each filter group and its selected button', async () => {
    const { host, panel } = mount([ok([])]);
    await panel.refresh();
    const html = rootOf(host).innerHTML;
    expect(html).toContain('role="group" aria-label="Record kind"');
    expect(html).toContain(
      `aria-pressed="true" ${RECEPTION_RECORDS_KIND_ATTR}="all"`,
    );
    expect(html).toContain(
      `aria-pressed="false" ${RECEPTION_RECORDS_KIND_ATTR}="scheduling_link"`,
    );
  });
});

describe('mountReceptionRecordsPanel — what reaches the DOM', () => {
  it('says a record materialized NOTHING', async () => {
    const { host, panel } = mount([ok([booking({ resolved: [] })])]);
    await panel.refresh();
    const html = rootOf(host).innerHTML;
    expect(html).toContain(RECEPTION_RECORDS_UNRESOLVED_COPY);
    expect(html).toContain(RECEPTION_RECORDS_UNRESOLVED_ATTR);
  });

  it('drops the "yet" once the outcome is final', async () => {
    // ⛔ The two copies overlap ('Nothing materialized' is a prefix of '... yet'), so asserting
    // only the terminal string would pass on the non-terminal render. Both directions pinned.
    const { host, panel } = mount([
      ok([booking({ outcome: 'rejected', resolved: [] })]),
    ]);
    await panel.refresh();
    const html = rootOf(host).innerHTML;
    expect(html).toContain(RECEPTION_RECORDS_UNRESOLVED_TERMINAL_COPY);
    expect(html).not.toContain(RECEPTION_RECORDS_UNRESOLVED_COPY);
  });

  it('keeps the "yet" while something may still materialize', async () => {
    const { host, panel } = mount([
      ok([booking({ outcome: 'pending', resolved: [] })]),
    ]);
    await panel.refresh();
    expect(rootOf(host).innerHTML).toContain(RECEPTION_RECORDS_UNRESOLVED_COPY);
  });

  it('does NOT say it when the record resolved', async () => {
    const { host, panel } = mount([
      ok([booking({ resolved: [{ kind: 'calendar.event', id: 'ev_1' }] })]),
    ]);
    await panel.refresh();
    const html = rootOf(host).innerHTML;
    expect(html).not.toContain(RECEPTION_RECORDS_UNRESOLVED_COPY);
    expect(html).toContain('Calendar event');
    expect(html).toContain('ev_1');
  });

  it('surfaces truncation rather than swallowing it', async () => {
    const { host, panel } = mount([ok([booking()], true)]);
    await panel.refresh();
    expect(rootOf(host).innerHTML).toContain(RECEPTION_RECORDS_TRUNCATED_ATTR);
  });

  it('omits the truncation notice when the answer is complete', async () => {
    const { host, panel } = mount([ok([booking()], false)]);
    await panel.refresh();
    expect(rootOf(host).innerHTML).not.toContain(RECEPTION_RECORDS_TRUNCATED_ATTR);
  });

  it('tells "none yet" apart from "none match"', async () => {
    const { host, panel } = mount([ok([])]);
    await panel.refresh();
    expect(rootOf(host).innerHTML).toContain('No reception records yet');
    await panel.setOutcome('waiting');
    const html = rootOf(host).innerHTML;
    expect(html).toContain(RECEPTION_RECORDS_EMPTY_ATTR);
    expect(html).toContain('No records match these filters');
  });

  it('renders an error with a retry instead of an empty list', async () => {
    // ⛔ A failed load must never render as "no records" — on this surface that is a lie the
    // owner acts on.
    const { host, panel } = mount([new Error('server said no')]);
    await panel.refresh();
    const html = rootOf(host).innerHTML;
    expect(html).toContain(RECEPTION_RECORDS_ERROR_ATTR);
    expect(html).toContain('role="alert"');
    expect(html).toContain('server said no');
    expect(html).toContain(RECEPTION_RECORDS_RETRY_ATTR);
    expect(html).not.toContain('No reception records yet');
  });

  it('escapes record ids rather than injecting them', async () => {
    const { host, panel } = mount([
      ok([booking({ endpoint_id: '<img src=x onerror=alert(1)>' })]),
    ]);
    await panel.refresh();
    const html = rootOf(host).innerHTML;
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});

describe('mountReceptionRecordsPanel — the generation guard', () => {
  it('does not let a slow earlier load paint over a newer filter', async () => {
    const { doc, host } = makeDoc();
    // Assigned synchronously by the Promise executor below; seeded with a no-op because TS's
    // control-flow analysis cannot see through the executor callback and would narrow a
    // `| null` back to `null` at the call site.
    let releaseFirst: (v: ReceptionRecordListResult) => void = () => {};
    const calls: ReceptionRecordListInput[] = [];
    let call = 0;
    const conn = ((_m: string, args?: ReceptionRecordListInput) => {
      calls.push(args ?? {});
      call += 1;
      if (call === 1) {
        return new Promise<ReceptionRecordListResult>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve(ok([booking({ record_id: 'SECOND' })]));
    }) as unknown as ReceptionRecordsConn;

    const panel = mountReceptionRecordsPanel({
      host: host as unknown as HTMLElement,
      conn,
      document: doc,
      now: () => NOW,
    });

    // Second load starts + settles while the first is still in flight.
    await panel.setKind('scheduling_link');
    expect(rootOf(host).innerHTML).toContain('SECOND');

    // Now the stale first load answers. It must be dropped.
    releaseFirst(ok([booking({ record_id: 'FIRST_STALE' })]));
    await Promise.resolve();
    await Promise.resolve();
    const html = rootOf(host).innerHTML;
    expect(html).toContain('SECOND');
    expect(html).not.toContain('FIRST_STALE');
    panel.dispose();
  });
});
