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
  COLLECTION_OPEN_RECORD_ACTION,
  COLLECTION_RECORD_ID_ATTR,
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
    expect(renderCollectionExplorer(base({ detail: { record_id: 'r1', loading: false, error: 'boom' } })))
      .toContain('boom');
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
