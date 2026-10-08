/** D-198 Slice 5 — collection-explorer render tests (pure module).
 *
 *  Covers `renderCollectionExplorer` (`apps/webclient/src/data/collection-explorer.ts`):
 *  schema-driven rows (primary + summary via `readDisplayField`, top-level +
 *  hot_fields fallback), the instance picker, the record detail (fields + inline
 *  body + blob note + raw), empty/loading/error states, and XSS escaping. Route
 *  integration (mount, collection.* callers) is exercised by the browser verify. */

import { describe, expect, it } from 'vitest';
import type { CollectionInstanceRow, CollectionRecord } from '@recued/contracts';
import {
  COLLECTION_DETAIL_RETRY_ACTION,
  COLLECTION_DETAIL_RETRY_ATTR,
  COLLECTION_DETAIL_HEADING_ATTR,
  COLLECTION_EXPLORER_STYLES,
  COLLECTION_OPEN_RECORD_ACTION,
  COLLECTION_RECORD_ID_ATTR,
  COLLECTION_RETRY_ACTION,
  COLLECTION_RETRY_ATTR,
  COLLECTION_SELECT_INSTANCE_ACTION,
  renderCollectionExplorer,
  type CollectionExplorerProps,
} from '../data/collection-explorer.js';

const mkRecord = (o: Partial<CollectionRecord> & { record_id: string }): CollectionRecord => ({
  received_at: 1_700_000_000_000,
  modified_at: 1_700_000_000_000,
  hot_fields: {},
  size_bytes: 0,
  source_id: o.record_id,
  ...o,
});

const mkInstance = (slug: string, adapter_type: string): CollectionInstanceRow =>
  ({ slug, platform: 'mail', adapter_type, caps: {}, auth_state: 'ok', last_synced_at: null }) as unknown as CollectionInstanceRow;

const base = (o: Partial<CollectionExplorerProps> = {}): CollectionExplorerProps => ({
  collection: 'mail',
  instances: [mkInstance('acct-1', 'gmail')],
  selectedSlug: 'acct-1',
  records: [],
  loading: false,
  now: 1_700_000_050_000,
  actionAttr: 'data-act',
  ...o,
});

describe('collection-explorer — schema-driven list', () => {
  it('renders a row with the primary_field title + summary fields (hot_fields fallback)', () => {
    const html = renderCollectionExplorer(base({
      records: [mkRecord({
        record_id: 'r1',
        hot_fields: { subject: 'Q3 renewal', from: 'sam@acme.com' },
        received_at: 1_700_000_000_000,
      })],
    }));
    expect(html).toContain('Q3 renewal'); // primary_field 'subject' (from hot_fields)
    expect(html).toContain('sam@acme.com'); // summary field 'from'
    // opens the record by id
    expect(html).toContain(`${COLLECTION_OPEN_RECORD_ACTION}`);
    expect(html).toContain(`${COLLECTION_RECORD_ID_ATTR}="r1"`);
  });

  it('falls back to record_id as the title when the primary field is missing', () => {
    const html = renderCollectionExplorer(base({ records: [mkRecord({ record_id: 'uid-42' })] }));
    expect(html).toContain('uid-42');
  });

  it('shows the instance picker when >1 instance, and hides it for a single one', () => {
    const multi = renderCollectionExplorer(base({
      instances: [mkInstance('a', 'gmail'), mkInstance('b', 'imap')],
      selectedSlug: null,
    }));
    expect(multi).toContain(COLLECTION_SELECT_INSTANCE_ACTION);
    expect(multi).toContain('Choose an instance');

    const single = renderCollectionExplorer(base());
    expect(single).not.toContain(COLLECTION_SELECT_INSTANCE_ACTION);
  });

  it('empty states: no instances vs no records', () => {
    expect(renderCollectionExplorer(base({ instances: [], selectedSlug: null })))
      .toContain('Nothing connected');
    expect(renderCollectionExplorer(base({ records: [] }))).toContain('No records');
    const failed = renderCollectionExplorer(base({ error: 'Check where it came from failed' }));
    expect(failed).toContain('class="col-explorer-error" role="alert"');
    expect(failed).not.toContain(COLLECTION_RETRY_ACTION);

    const retryable = renderCollectionExplorer(base({
      error: 'Check where it came from failed',
      retryable: true,
    }));
    expect(retryable).toContain(COLLECTION_RETRY_ACTION);
    expect(retryable).toContain(COLLECTION_RETRY_ATTR);
    expect(retryable).toContain('>Retry<');

    const retrying = renderCollectionExplorer(base({
      error: 'Check where it came from failed',
      retryable: true,
      retrying: true,
    }));
    expect(retrying).toContain('aria-disabled="true" aria-busy="true"');
    expect(retrying).toContain('>Retrying…<');
  });

  it('formats future time fields as "in …" (calendar start_at), not "just now"', () => {
    const now = 1_700_000_000_000;
    const html = renderCollectionExplorer(base({
      collection: 'calendar', // primary summary + summary_fields start_at/end_at/location
      now,
      records: [mkRecord({
        record_id: 'e1',
        hot_fields: { summary: 'Roadmap review', start_at: now + 3 * 86_400_000, end_at: now - 2 * 3_600_000 },
      })],
    }));
    expect(html).toContain('Roadmap review'); // primary title
    expect(html).toContain('in 3d'); // future start_at
    expect(html).toContain('2h ago'); // past end_at still reads "ago"
    expect(html).not.toContain('just now');
  });

  it('lists an all-day event by the days it covers, not the evening before (2026-10-07)', () => {
    // Local noon on 20 Dec where the test runs: "today" is the viewer's day.
    const now = new Date(2026, 11, 20, 12, 0).getTime();
    const day = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d);
    const html = renderCollectionExplorer(base({
      collection: 'calendar',
      now,
      records: [
        mkRecord({ record_id: 'a', hot_fields: { summary: 'Office closed', is_all_day: true, start_at: day(2026, 12, 20), end_at: day(2026, 12, 21) } }),
        mkRecord({ record_id: 'b', hot_fields: { summary: 'Holiday', is_all_day: true, start_at: day(2026, 12, 21), end_at: day(2026, 12, 23) } }),
        mkRecord({ record_id: 'c', hot_fields: { summary: 'Conference', is_all_day: true, start_at: day(2027, 2, 14), end_at: day(2027, 2, 15) } }),
      ],
    }));
    const rowOf = (title: string): string => html.slice(html.indexOf(title), html.indexOf('</li>', html.indexOf(title)));
    // Stored at the UTC midnights of its days; read as instants they were
    // hours off ("16h ago" / "in 8h" in Los Angeles), never "today".
    expect(rowOf('Office closed')).toMatch(/Start<\/span>today.*End<\/span>today/s);
    // The end is the LAST day, not the stored day after it.
    expect(rowOf('Holiday')).toMatch(/Start<\/span>tomorrow.*End<\/span>in 2d/s);
    const far = new Date(day(2027, 2, 14)).toLocaleDateString(undefined, { timeZone: 'UTC' });
    expect(rowOf('Conference')).toContain(far);
  });

  it("says a record is all-day in its detail, and leaves a timed one's times as they were", () => {
    const now = new Date(2026, 11, 20, 12, 0).getTime();
    const allDay = renderCollectionExplorer(base({
      collection: 'calendar',
      now,
      detail: {
        record_id: 'h1',
        loading: false,
        record: mkRecord({ record_id: 'h1', hot_fields: { summary: 'Holiday', is_all_day: true, start_at: Date.UTC(2026, 11, 21), end_at: Date.UTC(2026, 11, 22) } }),
      },
    }));
    expect(allDay).toContain('<dt>All day</dt><dd>Yes</dd>');
    expect(allDay).toContain('<dt>Start</dt><dd>tomorrow</dd>');
    const timed = renderCollectionExplorer(base({
      collection: 'calendar',
      now,
      detail: {
        record_id: 't1',
        loading: false,
        record: mkRecord({ record_id: 't1', hot_fields: { summary: 'Call', is_all_day: false, start_at: now + 3 * 3_600_000, end_at: now + 4 * 3_600_000 } }),
      },
    }));
    expect(timed).not.toContain('All day');
    expect(timed).toContain('<dt>Start</dt><dd>in 3h</dd>');
  });

  it('escapes field values (XSS)', () => {
    const html = renderCollectionExplorer(base({
      records: [mkRecord({ record_id: 'r1', hot_fields: { subject: '<script>alert(1)</script>' } })],
    }));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('collection-explorer — record detail', () => {
  it('renders a field list + inline body + raw hot_fields', () => {
    const html = renderCollectionExplorer(base({
      detail: {
        record_id: 'r1',
        loading: false,
        record: mkRecord({
          record_id: 'r1',
          hot_fields: { subject: 'Hello', from: 'x@y.com' },
          body_inline: 'the full message body',
          size_bytes: 21,
        }),
      },
    }));
    expect(html).toContain('Hello'); // title
    expect(html).toContain('x@y.com'); // field
    expect(html).toContain('the full message body'); // inline body
    expect(html).toContain('Raw fields'); // hot_fields disclosure
    expect(html).toContain(
      `<h2 class="col-explorer-detail-title" `
      + `${COLLECTION_DETAIL_HEADING_ATTR} tabindex="-1">Hello</h2>`,
    );
  });

  it('does not repeat metadata already rendered by the display schema', () => {
    const mail = renderCollectionExplorer(base({
      detail: {
        record_id: 'mail-1',
        loading: false,
        record: mkRecord({
          record_id: 'mail-1',
          hot_fields: { subject: 'Hello', received_at: 1_700_000_000_000 },
        }),
      },
    }));
    expect(mail.match(/>Received</g)).toHaveLength(1);

    const file = renderCollectionExplorer(base({
      collection: 'file',
      detail: {
        record_id: 'file-1',
        loading: false,
        record: mkRecord({
          record_id: 'file-1',
          size_bytes: 5,
          hot_fields: { path: '/docs/plan.txt', size: 5 },
        }),
      },
    }));
    expect(file.match(/>Size</g)).toHaveLength(1);
    expect(file).not.toContain('>Size kept in Recued<');
  });

  it('distinguishes stored body size when it differs from source size', () => {
    const html = renderCollectionExplorer(base({
      collection: 'file',
      detail: {
        record_id: 'file-1',
        loading: false,
        record: mkRecord({
          record_id: 'file-1',
          size_bytes: 12,
          hot_fields: { path: '/docs/plan.txt', size: 5 },
        }),
      },
    }));
    expect(html).toContain('>Size<');
    expect(html).toContain('>Size kept in Recued<');
  });

  it('uses canonical theme tokens for readable light and dark record details', () => {
    expect(COLLECTION_EXPLORER_STYLES).toContain('color: var(--fg)');
    expect(COLLECTION_EXPLORER_STYLES).toContain(
      'color: var(--on-accent)',
    );
    expect(COLLECTION_EXPLORER_STYLES).toContain(
      'background: var(--surface-sunk)',
    );
    expect(COLLECTION_EXPLORER_STYLES).not.toMatch(
      /--(?:text|text-muted|surface-2)\b/,
    );
  });

  it('keeps the raw-fields disclosure at the desktop control floor', () => {
    expect(COLLECTION_EXPLORER_STYLES).toContain(
      '.col-explorer-detail-raw summary {\n  min-height: 36px;',
    );
  });

  it('notes a CAS blob body instead of rendering it', () => {
    const html = renderCollectionExplorer(base({
      detail: {
        record_id: 'r1',
        loading: false,
        record: mkRecord({ record_id: 'r1', blob_hash: 'abc', size_bytes: 200_000 }),
      },
    }));
    expect(html).toContain('Large body');
    expect(html).not.toContain('abc'); // the hash is not surfaced as body
  });

  it('detail loading + error + vanished states', () => {
    expect(renderCollectionExplorer(base({ detail: { record_id: 'r1', loading: true } })))
      .toContain('Loading record');
    const failed = renderCollectionExplorer(base({
      detail: { record_id: 'r1', loading: false, error: 'boom' },
    }));
    expect(failed).toContain('boom');
    expect(failed).not.toContain(COLLECTION_DETAIL_RETRY_ACTION);

    const retryable = renderCollectionExplorer(base({
      detail: { record_id: 'r1', loading: false, error: 'boom' },
      detailRetryable: true,
    }));
    expect(retryable).toContain(COLLECTION_DETAIL_RETRY_ACTION);
    expect(retryable).toContain(COLLECTION_DETAIL_RETRY_ATTR);
    expect(retryable).toContain('>Retry<');

    const retrying = renderCollectionExplorer(base({
      detail: { record_id: 'r1', loading: false, error: 'boom' },
      detailRetryable: true,
      detailRetrying: true,
    }));
    expect(retrying).toContain('aria-disabled="true" aria-busy="true"');
    expect(retrying).toContain('>Retrying…<');
    expect(renderCollectionExplorer(base({ detail: { record_id: 'r1', loading: false, record: null } })))
      .toContain('no longer exists');
  });

  it('single-collection mode skips the instance bar + "Nothing connected" state', () => {
    // Provenance (annotation/link) has no instances; empty → "No records", not
    // the platform-only "Nothing connected".
    const empty = renderCollectionExplorer(base({
      collection: 'annotation', instances: [], selectedSlug: null, records: [], singleCollection: true,
    }));
    expect(empty).not.toContain('Nothing connected');
    expect(empty).not.toContain('Choose an instance');
    expect(empty).toContain('No records');

    const filled = renderCollectionExplorer(base({
      collection: 'annotation', instances: [], selectedSlug: null, singleCollection: true,
      records: [mkRecord({ record_id: 'a1', hot_fields: { key: 'summary', target_collection: 'mail', target_id: 'msg-1' } })],
    }));
    expect(filled).toContain('summary'); // primary_field (key) title
    expect(filled).toContain('mail'); // summary field (target_collection)
    expect(filled).not.toContain('col-explorer-instance-chip'); // no instance bar
  });

  it('detail hides redundant Size(0) / Modified(=Received) / Source-id(=record_id) rows', () => {
    const html = renderCollectionExplorer(base({
      collection: 'annotation', singleCollection: true,
      detail: { record_id: 'a1', loading: false, record: mkRecord({
        record_id: 'a1', // mkRecord defaults source_id := record_id → Source id hidden
        received_at: 1_700_000_000_000, modified_at: 1_700_000_000_000, // equal → Modified hidden
        size_bytes: 0, // → Size hidden
        hot_fields: { key: 'summary', target_collection: 'mail', target_id: 'msg-1', value: 'x' },
      }) },
    }));
    expect(html).toContain('summary'); // title
    expect(html).not.toContain('>Modified<');
    expect(html).not.toContain('>Size<');
    expect(html).not.toContain('>Source id<');
    expect(html).toContain('Raw fields'); // full row still in the disclosure
    // ...but Record id survives the compact trim — in compact mode Source id is
    // dropped precisely BECAUSE it equals record_id, so trimming both would
    // leave the record with no visible identity at all.
    expect(html).toContain('>Record id<');
  });

  // The `file` collection holds TWO record shapes: a watched-folder entry
  // (`path`) and an inbound upload / captured tool output (`filename`, no
  // `path`). With a single title field the second shape titled every row with
  // its 32-hex record_id, which reads as an id column rather than as a field
  // the record lacks. `primary_field_fallbacks: ['filename']` closes it.
  it('titles an uploaded file by filename, and a watched-folder file by path', () => {
    const uploaded = renderCollectionExplorer(base({
      collection: 'file',
      records: [mkRecord({
        record_id: `file:${'a'.repeat(32)}`,
        hot_fields: { filename: 'invoice-template-eu.docx', mime_type: 'application/vnd.x', size: 4096 },
      })],
    }));
    expect(uploaded).toContain('invoice-template-eu.docx');
    // ⛔ The defect: the id standing in for a title.
    expect(uploaded).not.toContain(`>file:${'a'.repeat(32)}<`);

    // `path` still wins when the record has one — the fallback is a fallback.
    const watched = renderCollectionExplorer(base({
      collection: 'file',
      records: [mkRecord({
        record_id: 'file:w1',
        hot_fields: { path: '/docs/notes.txt', filename: 'notes.txt' },
      })],
    }));
    expect(watched).toContain('/docs/notes.txt');
  });

  // A recipe references a stored record ONLY by its id
  // (`{{config.invoice_template}}` → officecli `document.template_fill`), so the
  // id needs a row of its own — especially now that the title is a filename.
  it('detail exposes the record_id a recipe references a stored file by', () => {
    const record = mkRecord({
      record_id: 'file:abc',
      source_id: 'upl_session_7', // an upload SESSION id — not the record id
      size_bytes: 4096,
      hot_fields: { filename: 'invoice-template-eu.docx' },
    });
    const html = renderCollectionExplorer(base({
      collection: 'file',
      detail: { record_id: 'file:abc', loading: false, record },
    }));
    expect(html).toContain('>Record id<');
    expect(html).toContain('file:abc');
    expect(html).toContain('upl_session_7');

    // The id must survive the title carrying a real filename — the state the
    // schema lands in the moment `primary_field` gains a fallback chain.
    const titled = renderCollectionExplorer(base({
      collection: 'file',
      detail: { record_id: 'file:abc', loading: false, record: {
        ...record, hot_fields: { ...record.hot_fields, path: '/templates/eu.docx' },
      } },
    }));
    expect(titled).toContain('/templates/eu.docx'); // now the title
    expect(titled).toContain('>Record id<'); // ...and the id is still reachable
    expect(titled).toContain('file:abc');
  });

  it('compact detail hides "Received" when the record has no timestamp (shared KV)', () => {
    const html = renderCollectionExplorer(base({
      collection: 'shared', singleCollection: true,
      detail: { record_id: 'k1', loading: false, record: mkRecord({
        record_id: 'k1', received_at: 0, modified_at: 0, size_bytes: 0,
        hot_fields: { key: 'data.shared.k', value: 'v' },
      }) },
    }));
    expect(html).toContain('data.shared.k'); // primary_field (key) title
    expect(html).not.toContain('>Received<'); // no timestamp → no Received row
    expect(html).not.toContain('>Modified<');
  });

  it('slots detailActionsHtml into the detail bar (Files download), never the list', () => {
    // Phase 1c — the route injects the Files "Download file" control here; the
    // engine only renders the string (in the DETAIL view, beside "← Back").
    const download = '<button data-recued-data-download-file>Download file</button>';
    const detail = renderCollectionExplorer(base({
      detail: { record_id: 'r1', loading: false, record: mkRecord({ record_id: 'r1' }) },
      detailActionsHtml: download,
    }));
    expect(detail).toContain('data-recued-data-download-file');
    // The list view never shows the detail-bar controls.
    const list = renderCollectionExplorer(base({
      records: [mkRecord({ record_id: 'r1' })],
      detailActionsHtml: download,
    }));
    expect(list).not.toContain('data-recued-data-download-file');
  });

  it('slots detailTimelineHtml below the fields (D-210 calendar timeline), never the list', () => {
    // The route pre-renders the calendar event's timeline (its move history)
    // and passes it here; the explorer only renders the string, in the DETAIL
    // view, after the record's fields.
    const timeline = '<section data-recued-calendar-timeline>Timeline</section>';
    const detail = renderCollectionExplorer(base({
      collection: 'calendar',
      detail: { record_id: 'evt-1', loading: false, record: mkRecord({ record_id: 'evt-1' }) },
      detailTimelineHtml: timeline,
    }));
    expect(detail).toContain('data-recued-calendar-timeline');
    // The list view never shows the detail's timeline.
    const list = renderCollectionExplorer(base({
      collection: 'calendar',
      records: [mkRecord({ record_id: 'evt-1' })],
      detailTimelineHtml: timeline,
    }));
    expect(list).not.toContain('data-recued-calendar-timeline');
  });
});

describe('collection-explorer — a record not in its usual state says so', () => {
  // ⛔ A cancelled event looked exactly like a live one in both views: the
  // status was on the record and only in the collapsed raw JSON (live drive,
  // 2026-10-07). The calendar schema now names `status` as its state field.
  const event = (record_id: string, status: string, summary = 'Dental check-up'): CollectionRecord =>
    mkRecord({ record_id, hot_fields: { summary, start_at: 1_700_100_000_000, status } });
  const calendar = (o: Partial<CollectionExplorerProps> = {}): string => renderCollectionExplorer(base({
    collection: 'calendar',
    instances: [mkInstance('local', 'local')],
    selectedSlug: 'local',
    ...o,
  }));

  it('badges a cancelled or tentative event in the list, and leaves a confirmed one alone', () => {
    const html = calendar({
      records: [event('e1', 'cancelled'), event('e2', 'tentative'), event('e3', 'confirmed')],
    });
    expect(html).toContain('data-recued-collection-state="cancelled">Cancelled<');
    expect(html).toContain('data-recued-collection-state="tentative">Tentative<');
    expect(html).not.toContain('data-recued-collection-state="confirmed"');
    expect(html).not.toContain('>Confirmed<');
  });

  it('keeps the badge OUTSIDE the title, which ellipsizes a long name', () => {
    const html = calendar({ records: [event('e1', 'cancelled', 'A'.repeat(200))] });
    const title = html.match(/<span class="col-explorer-row-title">([^<]*)<\/span>/);
    expect(title?.[1]).toBe('A'.repeat(200));
    expect(html).toMatch(/col-explorer-row-title">A+<\/span><span class="col-explorer-state"/);
  });

  it('the detail lists the status in every state and badges only an unusual one', () => {
    const cancelled = calendar({ detail: { record_id: 'e1', loading: false, record: event('e1', 'cancelled') } });
    expect(cancelled).toContain('<dt>Status</dt><dd>Cancelled</dd>');
    expect(cancelled).toContain('data-recued-collection-state="cancelled"');

    const confirmed = calendar({ detail: { record_id: 'e3', loading: false, record: event('e3', 'confirmed') } });
    expect(confirmed).toContain('<dt>Status</dt><dd>Confirmed</dd>');
    expect(confirmed).not.toContain('data-recued-collection-state=');
  });

  it('a collection with no state field renders as before', () => {
    const html = renderCollectionExplorer(base({
      records: [mkRecord({ record_id: 'r1', hot_fields: { subject: 'Hi', status: 'cancelled' } })],
    }));
    expect(html).not.toContain('data-recued-collection-state');
  });
});
