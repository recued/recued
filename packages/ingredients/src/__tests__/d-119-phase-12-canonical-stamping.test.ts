/** D-119 Phase 12 — Canonical record stamping at the kernel adapter
 *  boundary.
 *
 *  Validates that every record-returning kernel slug attaches `_id` +
 *  `_collection` to its output without relying on per-runtime
 *  dispatcher participation. The stamping is idempotent — adapters
 *  that already stamp keep their values. */

import { describe, expect, it } from 'vitest';
import { createKernelAdapter } from '../kernel.js';

const mkCall = (slug: string, input: Record<string, unknown>) => ({
  slug,
  risk_tier: 'read' as const,
  input,
  output: {},
  manifest_version: 1,
});

describe('Phase 12 — collection (mail/file/webhook) stamping', () => {
  it('email-list stamps each record with _id=record_id and _collection=mail', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      collectionList: async (input) => {
        captured = input;
        return {
          records: [
            {
              record_id: 'm-1', received_at: 0, modified_at: 0, hot_fields: {},
              size_bytes: 2, source_id: 's1', body_inline: 'hi',
            },
            {
              record_id: 'm-2', received_at: 0, modified_at: 0, hot_fields: {},
              size_bytes: 99_999, source_id: 's2', blob_hash: 'body-hash',
            },
          ],
        };
      },
    });
    const res = (await adapter(mkCall('email-list', {
      slug: 'inbox',
      metadata_only: true,
    }))) as {
      records: Array<{
        _id: string;
        _collection: string;
        record_id: string;
        body_inline?: string;
        blob_hash?: string;
      }>;
    };
    expect(captured).toEqual({ platform: 'mail', slug: 'inbox' });
    expect(res.records).toHaveLength(2);
    expect(res.records[0]._id).toBe('m-1');
    expect(res.records[0]._collection).toBe('mail');
    expect(res.records[0]).not.toHaveProperty('body_inline');
    expect(res.records[0]).not.toHaveProperty('blob_hash');
    expect(res.records[1]._id).toBe('m-2');
    expect(res.records[1]._collection).toBe('mail');
    expect(res.records[1]).not.toHaveProperty('body_inline');
    expect(res.records[1]).not.toHaveProperty('blob_hash');
  });

  it('email-list preserves the legacy full row unless metadata_only is true', async () => {
    const adapter = createKernelAdapter({
      collectionList: async () => ({
        records: [{
          record_id: 'm-full', received_at: 0, modified_at: 0, hot_fields: {},
          size_bytes: 2, source_id: 's-full', body_inline: 'hi',
        }],
      }),
    });
    const res = (await adapter(mkCall('email-list', { slug: 'inbox' }))) as {
      records: Array<{ body_inline?: string }>;
    };
    expect(res.records[0]).toMatchObject({ body_inline: 'hi' });
  });

  it('email-list rejects a non-boolean metadata_only selector before dispatch', async () => {
    let dispatched = false;
    const adapter = createKernelAdapter({
      collectionList: async () => {
        dispatched = true;
        return { records: [] };
      },
    });
    await expect(adapter(mkCall('email-list', {
      slug: 'inbox',
      metadata_only: 'true',
    }))).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(dispatched).toBe(false);
  });

  it('file-list stamps records with _collection=file', async () => {
    const adapter = createKernelAdapter({
      collectionList: async () => ({
        records: [
          { record_id: 'f-1', received_at: 0, modified_at: 0, hot_fields: { path: '/x' }, size_bytes: 0, source_id: '/x' },
        ],
      }),
    });
    const res = (await adapter(mkCall('file-list', { slug: 'home' }))) as {
      records: { _id: string; _collection: string }[];
    };
    expect(res.records[0]._collection).toBe('file');
    expect(res.records[0]._id).toBe('f-1');
  });

  it('webhook-list stamps records with _collection=webhook', async () => {
    const adapter = createKernelAdapter({
      collectionList: async () => ({
        records: [
          { record_id: 'w-1', received_at: 0, modified_at: 0, hot_fields: {}, size_bytes: 0, source_id: 'req-1' },
        ],
      }),
    });
    const res = (await adapter(mkCall('webhook-list', { slug: 'github' }))) as {
      records: { _collection: string }[];
    };
    expect(res.records[0]._collection).toBe('webhook');
  });

  it('email-get stamps the single record', async () => {
    const adapter = createKernelAdapter({
      collectionGet: async () => ({
        record: { record_id: 'm-77', received_at: 0, modified_at: 0, hot_fields: {}, size_bytes: 0, source_id: 'src' },
      }),
    });
    const res = (await adapter(mkCall('email-get', { slug: 'inbox', record_id: 'm-77' }))) as {
      record: { _id: string; _collection: string };
    };
    expect(res.record._id).toBe('m-77');
    expect(res.record._collection).toBe('mail');
  });

  it('email-get passes through null without stamping', async () => {
    const adapter = createKernelAdapter({
      collectionGet: async () => ({ record: null }),
    });
    const res = (await adapter(mkCall('email-get', { slug: 'inbox', record_id: 'absent' }))) as {
      record: null;
    };
    expect(res.record).toBeNull();
  });

  it('email-search stamps each match', async () => {
    const adapter = createKernelAdapter({
      collectionSearch: async () => ({
        matches: [
          { record_id: 'm-9', hot_fields: {}, rank: -3.5, snippet: '...' },
        ],
      }),
    });
    const res = (await adapter(mkCall('email-search', { slug: 'inbox', query: 'q' }))) as {
      matches: { _id: string; _collection: string; rank: number }[];
    };
    expect(res.matches[0]._id).toBe('m-9');
    expect(res.matches[0]._collection).toBe('mail');
    expect(res.matches[0].rank).toBe(-3.5);
  });
});

describe('Phase 12 — calendar stamping', () => {
  const baseEventHotFields = {
    calendar_id: 'cal-1',
    summary: 'Standup',
    start_at: 1_700_000_000_000,
    end_at: 1_700_003_600_000,
    status: 'confirmed' as const,
    is_all_day: false,
    is_recurring: false,
  };

  it('calendar-list stamps records with _id=ical_uid and _collection=calendar', async () => {
    const adapter = createKernelAdapter({
      calendarList: async () => ({
        records: [
          { ...baseEventHotFields, ical_uid: 'uid-101' },
          { ...baseEventHotFields, ical_uid: 'uid-102', summary: 'Other' },
        ],
      }),
    });
    const res = (await adapter(mkCall('calendar-list', { slug: 'work' }))) as {
      records: { _id: string; _collection: string; ical_uid: string }[];
    };
    expect(res.records[0]._id).toBe('uid-101');
    expect(res.records[0]._collection).toBe('calendar');
    expect(res.records[1]._id).toBe('uid-102');
  });

  it('calendar-get prefers ical_uid over source_id for _id', async () => {
    const adapter = createKernelAdapter({
      calendarGet: async () => ({
        record: { source_id: 'src-99', ical_uid: 'uid-101', summary: 'Standup' },
      }),
    });
    const res = (await adapter(mkCall('calendar-get', { slug: 'work', source_id: 'src-99' }))) as {
      record: { _id: string; _collection: string };
    };
    expect(res.record._id).toBe('uid-101');
    expect(res.record._collection).toBe('calendar');
  });

  it('calendar-get falls back to source_id when ical_uid is missing', async () => {
    const adapter = createKernelAdapter({
      calendarGet: async () => ({
        record: { source_id: 'src-only', summary: 'Test' },
      }),
    });
    const res = (await adapter(mkCall('calendar-get', { slug: 'work', source_id: 'src-only' }))) as {
      record: { _id: string; _collection: string };
    };
    expect(res.record._id).toBe('src-only');
    expect(res.record._collection).toBe('calendar');
  });

  it('calendar-search stamps matches with ical_uid + snippet', async () => {
    const adapter = createKernelAdapter({
      calendarSearch: async () => ({
        matches: [
          { ...baseEventHotFields, ical_uid: 'uid-555', snippet: 'standup notes' },
        ],
      }),
    });
    const res = (await adapter(mkCall('calendar-search', { slug: 'work', query: 'standup' }))) as {
      matches: { _id: string; _collection: string; snippet: string }[];
    };
    expect(res.matches[0]._id).toBe('uid-555');
    expect(res.matches[0]._collection).toBe('calendar');
    expect(res.matches[0].snippet).toBe('standup notes');
  });
});

describe('Phase 12 — shared stamping', () => {
  it('shared-list stamps each entry with _id=key and _collection=shared', async () => {
    const adapter = createKernelAdapter({
      list: async () => ({
        entries: [
          { key: 'data.shared.a', value: 1 },
          { key: 'data.shared.b', value: 'two' },
        ],
      }),
    });
    const res = (await adapter(mkCall('shared-list', { prefix: 'data.shared.' }))) as {
      entries: { _id: string; _collection: string; key: string }[];
    };
    expect(res.entries[0]._id).toBe('data.shared.a');
    expect(res.entries[0]._collection).toBe('shared');
    expect(res.entries[1]._id).toBe('data.shared.b');
  });

  it('shared-search stamps matches with rank preserved', async () => {
    const adapter = createKernelAdapter({
      search: async () => ({
        matches: [{ key: 'shared.x', value: 'hit', rank: -2.1 }],
      }),
    });
    const res = (await adapter(mkCall('shared-search', { scope: 's', query: 'q' }))) as {
      matches: { _id: string; _collection: string; rank: number }[];
    };
    expect(res.matches[0]._id).toBe('shared.x');
    expect(res.matches[0]._collection).toBe('shared');
    expect(res.matches[0].rank).toBe(-2.1);
  });
});

describe('Phase 12 — idempotent stamping (adapter-side ids win)', () => {
  it('preserves an adapter-supplied _id even when the slug-derived id differs', async () => {
    const adapter = createKernelAdapter({
      collectionList: async () => ({
        records: [
          // Pre-stamped record — adapter has authoritative knowledge.
          {
            _id: 'pre-stamped',
            _collection: 'mail',
            record_id: 'different-id',
            received_at: 0, modified_at: 0, hot_fields: {}, size_bytes: 0, source_id: 's',
          } as never,
        ],
      }),
    });
    const res = (await adapter(mkCall('email-list', { slug: 'inbox' }))) as {
      records: { _id: string; _collection: string }[];
    };
    expect(res.records[0]._id).toBe('pre-stamped');
    expect(res.records[0]._collection).toBe('mail');
  });
});
