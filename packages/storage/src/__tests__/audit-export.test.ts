/** D-120 Phase 7 — shared memory-export serializer tests.
 *
 *  Drives `exportPage` + `estimateExport` against an in-memory
 *  `AuditExportSource` so the same wire-format guarantees are exercised
 *  on both the local (IDB-backed) and server (SQLite-backed) callers.
 *
 *  Covers:
 *    - envelope on first page only; subsequent pages omit it
 *    - recipe_insights deduped by hash inside the envelope
 *    - format-specific body serialization (json / jsonl / csv)
 *    - link join → per-entry `links` array with the joined rows
 *    - cursor round-trip pagination preserving descending order
 *    - estimate returns count + per-format byte estimate
 */

import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '../audit.js';
import {
  buildExportEntry,
  decodeAuditExportCursor,
  estimateExport,
  exportPage,
  type AuditExportSource,
  type AuditExportLinkRow,
} from '../audit-export.js';

const mkEntry = (
  run_id: string,
  recipe_id: string,
  recipe_hash: string,
  started_at: number,
): AuditEntry => ({
  run_id,
  recipe_id,
  recipe_hash,
  started_at,
  finished_at: started_at + 1_000,
  duration_ms: 1_000,
  commit_status: 'succeeded',
  config_snapshot: {},
  errors: [],
  trigger_url: null,
  trigger_source: 'manual',
  instance_id: 'ext-test',
});

const makeSource = (
  entries: AuditEntry[],
  links: AuditExportLinkRow[] = [],
  insights: Array<{ hash: string; slug: string; version: number; flattened: unknown }> = [],
): AuditExportSource => ({
  async fetchEntries(opts) {
    let filtered = entries.slice().sort((a, b) => b.started_at - a.started_at);
    if (opts.recipe_id !== undefined) {
      filtered = filtered.filter((e) => e.recipe_id === opts.recipe_id);
    }
    if (opts.since !== undefined) {
      filtered = filtered.filter((e) => e.started_at >= opts.since!);
    }
    if (opts.until !== undefined) {
      filtered = filtered.filter((e) => e.started_at <= opts.until!);
    }
    if (opts.cursor) {
      filtered = filtered.filter((e) => {
        if (e.started_at > opts.cursor!.last_started_at) return false;
        if (
          e.started_at === opts.cursor!.last_started_at
          && e.run_id >= opts.cursor!.last_run_id
        ) {
          return false;
        }
        return true;
      });
    }
    return filtered.slice(0, opts.page_size);
  },
  async fetchLinks(runIds) {
    return links.filter((l) => runIds.includes(l.memory_id));
  },
  async fetchInsights(hashes) {
    return insights.filter((i) => hashes.includes(i.hash));
  },
  async count(opts) {
    let n = 0;
    for (const e of entries) {
      if (opts.recipe_id !== undefined && e.recipe_id !== opts.recipe_id) continue;
      if (opts.since !== undefined && e.started_at < opts.since) continue;
      if (opts.until !== undefined && e.started_at > opts.until) continue;
      n += 1;
    }
    return n;
  },
});

describe('exportPage — envelope semantics', () => {
  it('emits the envelope on the first page only', async () => {
    const entries = [
      mkEntry('r1', 'recipe-a', 'h1', 100),
      mkEntry('r2', 'recipe-a', 'h1', 90),
    ];
    const source = makeSource(entries);
    const page1 = await exportPage(source, {
      instance_id: 'ext-1', scope: 'local', now: () => 200,
    }, { format: 'json', page_size: 1 });
    expect(page1.envelope).toBeDefined();
    expect(page1.envelope!.scope).toBe('local');
    expect(page1.envelope!.instance_id).toBe('ext-1');
    expect(page1.envelope!.format).toBe('json');
    expect(page1.next_cursor).toBeDefined();

    const page2 = await exportPage(source, {
      instance_id: 'ext-1', scope: 'local', now: () => 200,
    }, { format: 'json', page_size: 1, cursor: page1.next_cursor });
    expect(page2.envelope).toBeUndefined();
  });

  it('envelope dedups recipe_insights by hash across entries', async () => {
    // Two entries with the same recipe_hash should produce one
    // insight key in the envelope, not two.
    const entries = [
      mkEntry('r1', 'recipe-a', 'shared-hash', 100),
      mkEntry('r2', 'recipe-a', 'shared-hash', 90),
    ];
    const insights = [
      { hash: 'shared-hash', slug: 'recipe-a', version: 1, flattened: { steps: [] } },
    ];
    const source = makeSource(entries, [], insights);
    const page = await exportPage(source, {
      instance_id: 'ext-1', scope: 'local', now: () => 200,
    }, { format: 'json' });
    expect(Object.keys(page.envelope!.recipe_insights)).toHaveLength(1);
    expect(page.envelope!.recipe_insights['shared-hash']!.slug).toBe('recipe-a');
  });

  it('envelope reports unbounded since/until as null when omitted', async () => {
    const source = makeSource([mkEntry('r1', 'a', 'h1', 100)]);
    const page = await exportPage(source, {
      instance_id: 'ext-1', scope: 'local',
    }, {});
    expect(page.envelope!.since).toBeNull();
    expect(page.envelope!.until).toBeNull();
    expect(page.envelope!.recipe_filter).toBeNull();
  });

  it('envelope reports recipe_filter when supplied', async () => {
    const source = makeSource([mkEntry('r1', 'a', 'h1', 100)]);
    const page = await exportPage(source, {
      instance_id: 'ext-1', scope: 'local',
    }, { recipe_id: 'recipe-a' });
    expect(page.envelope!.recipe_filter).toBe('recipe-a');
  });
});

describe('exportPage — format serialization', () => {
  const entries = [
    mkEntry('r1', 'recipe-a', 'h1', 100),
    mkEntry('r2', 'recipe-b', 'h2', 90),
  ];

  it('json format serializes entries as comma-separated JSON fragments', async () => {
    const source = makeSource(entries);
    const page = await exportPage(source, {
      instance_id: 'ext-1', scope: 'local',
    }, { format: 'json' });
    // Body is a JSON array fragment (no surrounding []), parseable by
    // wrapping in [].
    const parsed = JSON.parse(`[${page.body}]`);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe('r1');
    expect(parsed[1].id).toBe('r2');
  });

  it('jsonl format prepends the envelope as a _meta line on the first page', async () => {
    const source = makeSource(entries);
    const page = await exportPage(source, {
      instance_id: 'ext-1', scope: 'local',
    }, { format: 'jsonl' });
    const lines = page.body.split('\n');
    const meta = JSON.parse(lines[0]!);
    expect(meta._meta).toBeDefined();
    expect(meta._meta.scope).toBe('local');
    const entry0 = JSON.parse(lines[1]!);
    expect(entry0.id).toBe('r1');
  });

  it('jsonl format omits the _meta line on subsequent pages', async () => {
    const source = makeSource(entries);
    const page1 = await exportPage(source, {
      instance_id: 'ext-1', scope: 'local',
    }, { format: 'jsonl', page_size: 1 });
    const page2 = await exportPage(source, {
      instance_id: 'ext-1', scope: 'local',
    }, { format: 'jsonl', page_size: 1, cursor: page1.next_cursor });
    // First line on page 2 is an entry, not a `_meta` envelope wrapper.
    const firstLine = page2.body.split('\n')[0]!;
    const parsed = JSON.parse(firstLine);
    expect(parsed._meta).toBeUndefined();
    expect(parsed.id).toBeDefined();
  });

  it('csv format prepends header on first page only', async () => {
    const source = makeSource(entries);
    const page1 = await exportPage(source, {
      instance_id: 'ext-1', scope: 'local',
    }, { format: 'csv', page_size: 1 });
    const lines1 = page1.body.split('\n');
    expect(lines1[0]).toContain('id,recipe_id');
    expect(lines1).toHaveLength(2); // header + 1 row

    const page2 = await exportPage(source, {
      instance_id: 'ext-1', scope: 'local',
    }, { format: 'csv', page_size: 1, cursor: page1.next_cursor });
    const lines2 = page2.body.split('\n');
    expect(lines2[0]).not.toContain('id,recipe_id');
  });
});

describe('exportPage — links join', () => {
  it('attaches the joined link rows onto each entry', async () => {
    const entries = [mkEntry('r1', 'recipe-a', 'h1', 100)];
    const links: AuditExportLinkRow[] = [
      { memory_id: 'r1', entity_id: 'mail:msg-1', kind: 'execution.action', ts: 105 },
      { memory_id: 'r1', entity_id: 'deal:42', kind: 'execution.write', ts: 106 },
      { memory_id: 'r-other', entity_id: 'mail:msg-2', kind: 'execution.read', ts: 107 },
    ];
    const source = makeSource(entries, links);
    const page = await exportPage(source, {
      instance_id: 'ext-1', scope: 'local',
    }, { format: 'json' });
    const parsed = JSON.parse(`[${page.body}]`);
    expect(parsed[0].links).toHaveLength(2);
    expect(parsed[0].links[0].entity_id).toBe('mail:msg-1');
    expect(parsed[0].links[1].entity_id).toBe('deal:42');
  });

  it('returns an empty links array when no link rows match', async () => {
    const entries = [mkEntry('r1', 'recipe-a', 'h1', 100)];
    const source = makeSource(entries);
    const page = await exportPage(source, {
      instance_id: 'ext-1', scope: 'local',
    }, {});
    const parsed = JSON.parse(`[${page.body}]`);
    expect(parsed[0].links).toEqual([]);
  });
});

describe('exportPage — cursor pagination', () => {
  it('round-trips through descending order', async () => {
    const entries = [
      mkEntry('r1', 'a', 'h', 100),
      mkEntry('r2', 'a', 'h', 90),
      mkEntry('r3', 'a', 'h', 80),
      mkEntry('r4', 'a', 'h', 70),
    ];
    const source = makeSource(entries);
    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await exportPage(source, {
        instance_id: 'ext-1', scope: 'local',
      }, { format: 'json', page_size: 2, cursor });
      const parsed = JSON.parse(`[${page.body}]`);
      for (const e of parsed) collected.push(e.id);
      cursor = page.next_cursor;
      pages += 1;
      if (pages > 10) throw new Error('runaway pagination');
    } while (cursor);

    expect(collected).toEqual(['r1', 'r2', 'r3', 'r4']);
  });

  it('stops paginating when fewer rows than page_size return', async () => {
    const entries = [mkEntry('r1', 'a', 'h', 100), mkEntry('r2', 'a', 'h', 90)];
    const source = makeSource(entries);
    const page = await exportPage(source, {
      instance_id: 'ext-1', scope: 'local',
    }, { format: 'json', page_size: 10 });
    expect(page.next_cursor).toBeUndefined();
    expect(page.entries_in_page).toBe(2);
  });

  it('decodeAuditExportCursor returns null on malformed input', () => {
    expect(decodeAuditExportCursor('not-base64')).toBeNull();
    expect(decodeAuditExportCursor('')).toBeNull();
    expect(decodeAuditExportCursor(undefined)).toBeNull();
  });
});

describe('estimateExport', () => {
  it('returns the count + format-aware byte estimate', async () => {
    const entries = [
      mkEntry('r1', 'a', 'h', 100),
      mkEntry('r2', 'a', 'h', 90),
      mkEntry('r3', 'b', 'h2', 80),
    ];
    const source = makeSource(entries);
    const json = await estimateExport(source, { format: 'json' });
    const csv = await estimateExport(source, { format: 'csv' });
    expect(json.entry_count).toBe(3);
    expect(csv.entry_count).toBe(3);
    // CSV constant is smaller than JSON's
    expect(csv.estimated_bytes).toBeLessThan(json.estimated_bytes);
  });

  it('honours the recipe_id filter when estimating', async () => {
    const entries = [
      mkEntry('r1', 'a', 'h', 100),
      mkEntry('r2', 'b', 'h2', 90),
    ];
    const source = makeSource(entries);
    const est = await estimateExport(source, { recipe_id: 'a' });
    expect(est.entry_count).toBe(1);
  });

  it('honours since/until bounds', async () => {
    const entries = [
      mkEntry('r1', 'a', 'h', 100),
      mkEntry('r2', 'a', 'h', 50),
      mkEntry('r3', 'a', 'h', 10),
    ];
    const source = makeSource(entries);
    const est = await estimateExport(source, { since: 40, until: 90 });
    expect(est.entry_count).toBe(1); // only r2 (started_at=50)
  });
});

describe('buildExportEntry — shape adapter', () => {
  it('translates an AuditEntry + links into the wire shape', () => {
    const entry = mkEntry('r1', 'recipe-a', 'h1', 100);
    const links: AuditExportLinkRow[] = [
      { memory_id: 'r1', entity_id: 'deal:42', kind: 'execution.write', ts: 105 },
    ];
    const out = buildExportEntry(entry, links);
    expect(out.id).toBe('r1');
    expect(out.recipe_id).toBe('recipe-a');
    expect(out.recipe_hash).toBe('h1');
    expect(out.links).toHaveLength(1);
    expect(out.links[0]!.kind).toBe('execution.write');
  });
});
