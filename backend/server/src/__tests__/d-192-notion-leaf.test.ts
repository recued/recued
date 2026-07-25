/** D-192 file SOURCE family — the Notion leaf (`file-source-adapters/notion.ts`).
 *
 *  Notion is the first bearer-connection file vendor and the first full-only
 *  bespoke SEARCH → block-tree walk. These tests drive the leaf through a stubbed
 *  `FileFetch`: the two-level walk (search pages → recurse block children),
 *  filename synthesis (name / URL-basename / `{type}-{id}` fallback), the
 *  fail-closed completeness proof (a per-page 403/404 sinks `complete`), error
 *  classification (401 → config), the 429/529 inline retry, and the projection of
 *  a synthesized row through the shared declaration-driven projector. */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { getFileVendorDeclaration, type FileVendorDeclaration } from '@recued/contracts';

import { buildNotionFileSourceLeaf } from '../file-source-adapters/notion.js';
import type {
  FileConnectionCredential,
  FileConnectionResolver,
  FileFetch,
} from '../file-source-adapters/index.js';
import type { FileSourceListRequest } from '../file-source-sync.js';
import { projectFileVendorRow } from '../file-source-projector.js';

const NOTION = getFileVendorDeclaration('notion') as FileVendorDeclaration;

interface StubCall { url: string; method: string; headers: Record<string, string>; body?: string }

const stubFetch = (
  responses: Array<{ ok?: boolean; status?: number; json?: unknown; headers?: Record<string, string> }>,
): { fetchImpl: FileFetch; calls: StubCall[] } => {
  const calls: StubCall[] = [];
  const fetchImpl: FileFetch = async (url, init) => {
    const i = calls.length;
    calls.push({ url, method: init.method, headers: init.headers, ...(typeof init.body === 'string' ? { body: init.body } : {}) });
    const r = responses[i] ?? { ok: false, status: 500 };
    const ok = r.ok ?? true;
    const status = r.status ?? (ok ? 200 : 500);
    const body = r.json !== undefined ? JSON.stringify(r.json) : '';
    return {
      ok, status,
      headers: new Headers(r.headers ?? {}),
      text: async () => body,
      json: async () => (r.json !== undefined ? r.json : null),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  return { fetchImpl, calls };
};

const resolverFor = (cred: FileConnectionCredential | null): FileConnectionResolver => async () => cred;

const notionCred = (configOver: Record<string, unknown> = {}): FileConnectionCredential => ({
  auth: { type: 'bearer', token: 'ntn_secret-xyz' },
  config: { vendor: 'notion', ...configOver },
});

const req = (connection_name = 'c1'): FileSourceListRequest => ({
  source_id: `notion.${connection_name}.file`,
  connection_name,
  vendor: 'notion',
  declaration: NOTION,
  cursor: null,
});

// ── response builders ────────────────────────────────────────────
const listResp = (results: unknown[], nextCursor?: string) => ({
  json: { object: 'list', results, has_more: nextCursor !== undefined, next_cursor: nextCursor ?? null },
});
const page = (id: string, title = 'My Page') => ({
  object: 'page', id, last_edited_time: '2026-07-01T00:00:00.000Z',
  properties: { Name: { id: 'title', type: 'title', title: [{ type: 'text', plain_text: title }] } },
});
const fileBlock = (id: string, over: { name?: string; url?: string; type?: string; external?: boolean; has_children?: boolean; mtime?: string } = {}) => {
  const type = over.type ?? 'file';
  const url = over.url ?? 'https://prod-files.s3.amazonaws.com/ws/uuid/report.pdf?X-Amz-Signature=abc';
  const inner = over.external ? { type: 'external', external: { url } } : { type: 'file', file: { url, expiry_time: '2026-07-01T01:00:00.000Z' } };
  return {
    object: 'block', id, type,
    last_edited_time: over.mtime ?? '2026-07-02T00:00:00.000Z',
    has_children: over.has_children ?? false,
    [type]: { ...inner, ...(over.name !== undefined ? { name: over.name } : {}) },
  };
};
const textBlock = (id: string, has_children = false) => ({
  object: 'block', id, type: 'paragraph', has_children,
  last_edited_time: '2026-07-02T00:00:00.000Z',
  paragraph: { rich_text: [{ plain_text: 'hi' }] },
});
const childPageBlock = (id: string) => ({
  object: 'block', id, type: 'child_page', has_children: true,
  last_edited_time: '2026-07-02T00:00:00.000Z',
  child_page: { title: 'Child' },
});
// ── prong-2 (data-source `files`-property) builders ──────────────
const dataSource = (id: string, title = 'My DB') => ({
  object: 'data_source', id, title: [{ type: 'text', plain_text: title }],
});
// A `files`-property ENTRY. Notion-hosted signed-S3 `file` by default; the S3
// object PATH (before `?`) is the stable identity — `sig` varies the query only.
const propFile = (over: { name?: string; type?: 'file' | 'external' | 'file_upload'; path?: string; sig?: string; url?: string; uploadId?: string } = {}) => {
  const type = over.type ?? 'file';
  if (type === 'file_upload') {
    return { ...(over.name !== undefined ? { name: over.name } : {}), type, file_upload: { id: over.uploadId ?? 'up-123' } };
  }
  const url = over.url ?? `https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/${over.path ?? 'attach-uuid'}/report.pdf?X-Amz-Signature=${over.sig ?? 'sig1'}`;
  const inner = type === 'external' ? { type, external: { url } } : { type, file: { url, expiry_time: '2026-07-02T01:00:00.000Z' } };
  return { ...(over.name !== undefined ? { name: over.name } : {}), ...inner };
};
// A data-source ROW (a page object) carrying a `files` property `Attachments`.
const row = (id: string, title: string, files: unknown[], over: { mtime?: string; propId?: string; propName?: string } = {}) => ({
  object: 'page', id, last_edited_time: over.mtime ?? '2026-07-03T00:00:00.000Z',
  properties: {
    Name: { id: 'title', type: 'title', title: [{ type: 'text', plain_text: title }] },
    [over.propName ?? 'Attachments']: { id: over.propId ?? 'pAtt', type: 'files', files },
  },
});
// Trailing "no shared data sources" response — prong 2's empty search, appended to
// every prong-1 test (the walk now makes this extra call after the block walk).
const noDataSources = () => listResp([]);

const run = (responses: Parameters<typeof stubFetch>[0], cred = notionCred()) => {
  const { fetchImpl, calls } = stubFetch(responses);
  const leaf = buildNotionFileSourceLeaf({ resolveConnection: resolverFor(cred), fetchImpl }, { sleep: async () => {} });
  return { leaf, calls };
};

describe('buildNotionFileSourceLeaf — full walk', () => {
  it('search → block children → collects file blocks, complete:true, walk:full, no cursor', async () => {
    const { leaf, calls } = run([
      listResp([page('p1', 'Runbook')]),                              // POST /search (pages)
      listResp([fileBlock('b1', { name: 'plan.pdf' }), textBlock('t1')]), // GET /blocks/p1/children
      noDataSources(),                                                // POST /search (data_source)
    ]);
    const out = await leaf(req());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.walk).toBe('full');
    expect(out.complete).toBe(true);
    expect(out.next_cursor).toBeNull();
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ remote_id: 'b1', filename: 'plan.pdf', mtime: '2026-07-02T00:00:00.000Z', path: 'Runbook/plan.pdf' });
    // Bearer + pinned Notion-Version on every call.
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/v1/search');
    expect(calls[0].headers.Authorization).toBe('Bearer ntn_secret-xyz');
    expect(calls[0].headers['Notion-Version']).toBeDefined();
    expect(calls[1].url).toContain('/v1/blocks/p1/children');
  });

  it('a synthesized row projects through the shared projector (filename/remote_id/path/mtime; no size/mime/revision)', async () => {
    const { leaf } = run([listResp([page('p1', 'Docs')]), listResp([fileBlock('b1', { name: 'q3.pdf' })]), noDataSources()]);
    const out = await leaf(req());
    if (!out.ok) throw new Error('expected ok');
    const projected = projectFileVendorRow(out.rows[0], NOTION);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    // The projector normalizes the ISO `last_edited_time` to canonical epoch-ms.
    expect(projected.projection).toMatchObject({ filename: 'q3.pdf', provider: 'notion', remote_id: 'b1', path: 'Docs/q3.pdf', mtime: Date.parse('2026-07-02T00:00:00.000Z') });
    expect(projected.projection.size).toBeUndefined();
    expect(projected.projection.mime_type).toBeUndefined();
    expect(projected.projection.revision).toBeUndefined();
  });

  it('filename fallback: image block (no name) → URL basename; nameless+urlless file → {type}-{id}', async () => {
    const { leaf } = run([
      listResp([page('p1')]),
      listResp([
        fileBlock('img1', { type: 'image', url: 'https://prod-files.s3.amazonaws.com/ws/uuid/diagram%20v2.png?sig=x' }),
        fileBlock('f2', { url: '' }), // no name, no usable url
      ]),
      noDataSources(),
    ]);
    const out = await leaf(req());
    if (!out.ok) throw new Error('expected ok');
    const byId = Object.fromEntries(out.rows.map((r) => [r.remote_id, r.filename]));
    expect(byId.img1).toBe('diagram v2.png'); // percent-decoded basename
    expect(byId.f2).toBe('file-f2');            // {type}-{shortId} fallback
  });

  it('recurses into blocks with has_children, collecting nested file blocks', async () => {
    const { leaf, calls } = run([
      listResp([page('p1', 'Top')]),
      listResp([textBlock('toggle1', true)]),        // p1 children: a toggle with children
      listResp([fileBlock('nested', { name: 'inner.pdf' })]), // toggle1 children
      noDataSources(),
    ]);
    const out = await leaf(req());
    if (!out.ok) throw new Error('expected ok');
    expect(out.complete).toBe(true);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ remote_id: 'nested', filename: 'inner.pdf', path: 'Top/inner.pdf' });
    expect(calls[2].url).toContain('/v1/blocks/toggle1/children');
  });

  it('paginates both search and block children (next_cursor)', async () => {
    const { leaf, calls } = run([
      listResp([page('p1')], 'sc2'),                 // search page 1
      listResp([page('p2')]),                        // search page 2
      listResp([fileBlock('b1', { name: 'a.pdf' })], 'cc2'), // p1 children page 1
      listResp([fileBlock('b2', { name: 'b.pdf' })]),        // p1 children page 2
      listResp([]),                                  // p2 children (empty)
      noDataSources(),
    ]);
    const out = await leaf(req());
    if (!out.ok) throw new Error('expected ok');
    expect(out.rows.map((r) => r.remote_id).sort()).toEqual(['b1', 'b2']);
    expect(calls[1].body).toContain('sc2');          // search page 2 carried the cursor
    expect(calls[3].url).toContain('start_cursor=cc2');
  });

  it('ignores non-file blocks', async () => {
    const { leaf } = run([listResp([page('p1')]), listResp([textBlock('t1'), textBlock('t2')]), noDataSources()]);
    const out = await leaf(req());
    if (!out.ok) throw new Error('expected ok');
    expect(out.rows).toHaveLength(0);
    expect(out.complete).toBe(true);
  });

  it('does NOT recurse into a child_page block — /search enumerates it, so its files collect ONCE (no double-walk / no path churn)', async () => {
    const { leaf, calls } = run([
      listResp([page('p1', 'Parent'), page('cp', 'Child')]), // search returns the nested page independently
      listResp([childPageBlock('cp')]),                      // Parent's children: the child_page block → NOT recursed
      listResp([fileBlock('f1', { name: 'doc.pdf' })]),      // Child's own children (via search) → the file's single home
      noDataSources(),                                        // POST /search (data_source) → none
    ]);
    const out = await leaf(req());
    if (!out.ok) throw new Error('expected ok');
    expect(out.complete).toBe(true);
    expect(out.rows).toHaveLength(1);                         // collected ONCE, not twice
    expect(out.rows[0]).toMatchObject({ remote_id: 'f1', path: 'Child/doc.pdf' }); // its own page's title, not the parent's
    // 4 calls: search(pages), Parent/children, Child/children, search(data_source)
    // — the block prong stays 3 (NO cp recursion under Parent; that would be a 5th).
    expect(calls).toHaveLength(4);
    expect(calls.filter((c) => c.url.includes('/blocks/cp/children'))).toHaveLength(1);
  });

  it('carries the resolved import_scope back in the outcome', async () => {
    const { leaf } = run(
      [listResp([page('p1')]), listResp([]), noDataSources()],
      notionCred({ import_scope: 'Projects/**' }),
    );
    const out = await leaf(req());
    if (!out.ok) throw new Error('expected ok');
    expect(out.scope).toMatchObject({ glob: 'Projects/**' });
  });
});

describe('buildNotionFileSourceLeaf — fail-closed + errors', () => {
  it('a per-page 404/403 during the block walk is SKIPPED and sinks complete', async () => {
    const { leaf } = run([
      listResp([page('p1', 'Gone'), page('p2', 'Live')]),
      { ok: false, status: 404 },                    // p1 children → gone
      listResp([fileBlock('b2', { name: 'ok.pdf' })]), // p2 children → fine
      noDataSources(),                                 // POST /search (data_source) → none
    ]);
    const out = await leaf(req());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.complete).toBe(false);                // fail-closed — no absence-deletes
    expect(out.rows.map((r) => r.remote_id)).toEqual(['b2']); // p2's file still mirrored
  });

  it('an id-less file block fails the walk CLOSED (complete:false), never dropped silently', async () => {
    const idless = { object: 'block', type: 'file', has_children: false, last_edited_time: '2026-07-02T00:00:00.000Z', file: { type: 'file', file: { url: 'https://x/y.pdf' } } };
    const { leaf } = run([listResp([page('p1')]), listResp([idless, fileBlock('ok1', { name: 'ok.pdf' })]), noDataSources()]);
    const out = await leaf(req());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The malformed id-less block is unkeyable → the walk is no longer
    // delete-authoritative (fail-closed, matching the Box posture). The healthy
    // sibling is still mirrored.
    expect(out.complete).toBe(false);
    expect(out.rows.map((r) => r.remote_id)).toEqual(['ok1']);
  });

  it('a search-level failure aborts the cycle with an error outcome', async () => {
    const { leaf } = run([{ ok: false, status: 500 }]);
    const out = await leaf(req());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe('error');
  });

  it('401 (bad/revoked token) classifies as config, not a retryable error', async () => {
    const { leaf } = run([{ ok: false, status: 401 }]);
    const out = await leaf(req());
    expect(out).toMatchObject({ ok: false, kind: 'config' });
  });

  it('retries inline on 429 honoring Retry-After, then succeeds', async () => {
    const { leaf, calls } = run([
      { ok: false, status: 429, headers: { 'retry-after': '0' } }, // search → rate limited
      listResp([page('p1')]),                                       // retry → ok
      listResp([fileBlock('b1', { name: 'x.pdf' })]),               // p1 children
      noDataSources(),                                              // POST /search (data_source) → none
    ]);
    const out = await leaf(req());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows).toHaveLength(1);
    // 4 calls: search(429→retry counts as the SAME slot), search(retry ok),
    // p1 children, search(data_source). The 429 was retried in place, not lost.
    expect(calls).toHaveLength(4);
    expect(calls[0].url).toContain('/v1/search');
    expect(calls[1].url).toContain('/v1/search'); // the retry reused the search slot
  });

  it('a malformed page (has_more with no next_cursor) fails closed', async () => {
    const { leaf } = run([{ json: { object: 'list', results: [], has_more: true, next_cursor: null } }]);
    const out = await leaf(req());
    expect(out.ok).toBe(false); // can't certify exhaustion → aborts (search-level)
  });

  it('a throwing resolver becomes an error outcome (no throw escapes the leaf)', async () => {
    const leaf = buildNotionFileSourceLeaf(
      { resolveConnection: async () => { throw new Error('vault locked'); }, fetchImpl: (async () => { throw new Error('unreached'); }) as FileFetch },
    );
    const out = await leaf(req());
    expect(out).toMatchObject({ ok: false, kind: 'error' });
  });

  it('a missing connection → config; a connection without a bearer token → config', async () => {
    const gone = buildNotionFileSourceLeaf({ resolveConnection: resolverFor(null), fetchImpl: (async () => { throw new Error('x'); }) as FileFetch });
    expect(await gone(req())).toMatchObject({ ok: false, kind: 'config' });
    const noTok = buildNotionFileSourceLeaf({
      resolveConnection: resolverFor({ auth: { type: 'none' }, config: { vendor: 'notion' } } as unknown as FileConnectionCredential),
      fetchImpl: (async () => { throw new Error('x'); }) as FileFetch,
    });
    expect(await noTok(req())).toMatchObject({ ok: false, kind: 'config' });
  });
});

// ════════════════════════════════════════════════════════════════════
// PRONG 2 — data-source `files`-property files
// ════════════════════════════════════════════════════════════════════
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

describe('buildNotionFileSourceLeaf — prong 2: data-source files-property', () => {
  it('search(data_source) → query rows → collects each row\'s files-property files (breadcrumb path, row mtime)', async () => {
    const { leaf, calls } = run([
      listResp([]),                                                   // POST /search (pages) → none
      listResp([dataSource('ds1', 'Contracts DB')]),                  // POST /search (data_source)
      listResp([row('r1', 'Acme MSA', [propFile({ name: 'msa.pdf', path: 'attach-1' })], { mtime: '2026-07-05T00:00:00.000Z' })]),
    ]);
    const out = await leaf(req());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.walk).toBe('full');
    expect(out.complete).toBe(true);
    expect(out.next_cursor).toBeNull();
    expect(out.rows).toHaveLength(1);
    // remote_id = rowId:propId:file:sha(objectPath) — NOT index, NOT the signed URL.
    expect(out.rows[0]).toMatchObject({
      remote_id: `r1:pAtt:file:${sha('/ws/attach-1/report.pdf')}`,
      filename: 'msa.pdf',
      path: 'Contracts DB/Acme MSA/Attachments/msa.pdf',
      mtime: '2026-07-05T00:00:00.000Z',
    });
    // Call order: search(pages), search(data_source), data_sources/ds1/query.
    expect(calls[1].url).toContain('/v1/search');
    expect(calls[1].body).toContain('data_source');
    expect(calls[2].url).toContain('/v1/data_sources/ds1/query');
    expect(calls[2].method).toBe('POST');
  });

  it('a synthesized property-file row projects through the shared projector (no size/mime/revision)', async () => {
    const { leaf } = run([
      listResp([]),
      listResp([dataSource('ds1', 'Docs')]),
      listResp([row('r1', 'Row', [propFile({ name: 'q3.pdf', path: 'a1' })])]),
    ]);
    const out = await leaf(req());
    if (!out.ok) throw new Error('expected ok');
    const projected = projectFileVendorRow(out.rows[0], NOTION);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.projection).toMatchObject({
      filename: 'q3.pdf', provider: 'notion', path: 'Docs/Row/Attachments/q3.pdf',
      mtime: Date.parse('2026-07-03T00:00:00.000Z'),
    });
    expect(projected.projection.size).toBeUndefined();
    expect(projected.projection.mime_type).toBeUndefined();
    expect(projected.projection.revision).toBeUndefined();
  });

  it('⚠ CRUX: a reorder of the files array is a NO-OP — same remote_ids, no churn', async () => {
    const walk = (files: unknown[]) => run([
      listResp([]),
      listResp([dataSource('ds1', 'DB')]),
      listResp([row('r1', 'Row', files)]),
    ]).leaf(req());
    const a = propFile({ name: 'a.pdf', path: 'attach-A' });
    const b = propFile({ name: 'b.pdf', path: 'attach-B' });
    const first = await walk([a, b]);
    const second = await walk([b, a]); // SAME files, reordered (Notion overwrites the whole array on edit)
    if (!first.ok || !second.ok) throw new Error('expected ok');
    const ids = (o: typeof first) => (o.ok ? o.rows.map((r) => r.remote_id).sort() : []);
    expect(ids(first)).toEqual(ids(second)); // index-independent → the runner never delete-then-recreates
    expect(ids(first)).toHaveLength(2);
  });

  it('⚠ CRUX: a signed-URL signature rotation is a NO-OP — the key hashes the object PATH, not the query', async () => {
    const walk = (sig: string) => run([
      listResp([]),
      listResp([dataSource('ds1', 'DB')]),
      listResp([row('r1', 'Row', [propFile({ name: 'x.pdf', path: 'attach-1', sig })])]),
    ]).leaf(req());
    const t0 = await walk('X-Amz-Signature-HOUR-0');
    const t1 = await walk('X-Amz-Signature-HOUR-1'); // one hour later — fresh signature, SAME S3 object
    if (!t0.ok || !t1.ok) throw new Error('expected ok');
    expect(t0.rows[0].remote_id).toBe(t1.rows[0].remote_id);
    expect(t0.rows[0].remote_id).toBe(`r1:pAtt:file:${sha('/ws/attach-1/report.pdf')}`);
  });

  it('keys external by the permanent URL, and file_upload by the upload id (both stable, distinct namespaces)', async () => {
    const { leaf } = run([
      listResp([]),
      listResp([dataSource('ds1', 'DB')]),
      listResp([row('r1', 'Row', [
        propFile({ name: 'logo.png', type: 'external', url: 'https://cdn.example.com/logo.png' }),
        propFile({ name: 'upload.pdf', type: 'file_upload', uploadId: 'up-abc' }),
      ])]),
    ]);
    const out = await leaf(req());
    if (!out.ok) throw new Error('expected ok');
    const byName = Object.fromEntries(out.rows.map((r) => [r.filename, r.remote_id]));
    expect(byName['logo.png']).toBe(`r1:pAtt:ext:${sha('https://cdn.example.com/logo.png')}`);
    expect(byName['upload.pdf']).toBe('r1:pAtt:upload:up-abc');
  });

  it('a nameless external file falls back to the URL basename', async () => {
    const { leaf } = run([
      listResp([]),
      listResp([dataSource('ds1', 'DB')]),
      listResp([row('r1', 'Row', [propFile({ type: 'external', url: 'https://cdn.example.com/assets/brochure%20v2.pdf' })])]),
    ]);
    const out = await leaf(req());
    if (!out.ok) throw new Error('expected ok');
    expect(out.rows[0].filename).toBe('brochure v2.pdf'); // percent-decoded basename
  });

  it('keys on the property ID (survives a column rename); the human name rides the path', async () => {
    const walk = (propName: string) => run([
      listResp([]),
      listResp([dataSource('ds1', 'DB')]),
      listResp([row('r1', 'Row', [propFile({ name: 'f.pdf', path: 'a1' })], { propId: 'stableColId', propName })]),
    ]).leaf(req());
    const before = await walk('Attachments');
    const after = await walk('Files'); // user renamed the column — same stable property id
    if (!before.ok || !after.ok) throw new Error('expected ok');
    expect(before.rows[0].remote_id).toBe(after.rows[0].remote_id); // rename is NOT a re-key
    expect(before.rows[0].path).toBe('DB/Row/Attachments/f.pdf');
    expect(after.rows[0].path).toBe('DB/Row/Files/f.pdf');           // only the breadcrumb moves
  });

  it('ignores non-files properties and rows with no files property', async () => {
    const { leaf } = run([
      listResp([]),
      listResp([dataSource('ds1', 'DB')]),
      listResp([
        { object: 'page', id: 'r1', last_edited_time: '2026-07-03T00:00:00.000Z', properties: { Name: { id: 'title', type: 'title', title: [{ plain_text: 'Plain' }] }, Status: { id: 's', type: 'select', select: { name: 'Open' } } } },
        row('r2', 'Has files', [propFile({ name: 'y.pdf', path: 'a2' })]),
      ]),
    ]);
    const out = await leaf(req());
    if (!out.ok) throw new Error('expected ok');
    expect(out.complete).toBe(true);
    expect(out.rows.map((r) => r.filename)).toEqual(['y.pdf']); // only the row with a files property
  });

  it('paginates both the data_source search and the row query', async () => {
    const { leaf, calls } = run([
      listResp([]),                                              // search pages → none
      listResp([dataSource('ds1', 'DB1')], 'dsc2'),              // data_source search page 1
      listResp([dataSource('ds2', 'DB2')]),                     // data_source search page 2
      listResp([row('r1', 'R1', [propFile({ name: 'a.pdf', path: 'a1' })])], 'rq2'), // ds1 rows page 1
      listResp([row('r2', 'R2', [propFile({ name: 'b.pdf', path: 'a2' })])]),        // ds1 rows page 2
      listResp([row('r3', 'R3', [propFile({ name: 'c.pdf', path: 'a3' })])]),        // ds2 rows
    ]);
    const out = await leaf(req());
    if (!out.ok) throw new Error('expected ok');
    expect(out.rows.map((r) => r.filename).sort()).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    expect(calls[2].body).toContain('dsc2');                    // data_source search carried the cursor
    expect(calls[4].body).toContain('rq2');                     // ds1 row query carried the cursor
  });

  it('both prongs compose — a block file AND a property file, disjoint remote_id namespaces', async () => {
    const { leaf } = run([
      listResp([page('p1', 'Runbook')]),                          // search pages → 1 page
      listResp([fileBlock('b1', { name: 'block.pdf' })]),         // p1 children → 1 block file
      listResp([dataSource('ds1', 'DB')]),                       // search data_source → 1 ds
      listResp([row('r1', 'Row', [propFile({ name: 'prop.pdf', path: 'a1' })])]), // ds1 rows → 1 property file
    ]);
    const out = await leaf(req());
    if (!out.ok) throw new Error('expected ok');
    expect(out.complete).toBe(true);
    const ids = out.rows.map((r) => r.remote_id).sort();
    expect(ids).toEqual([`r1:pAtt:file:${sha('/ws/a1/report.pdf')}`, 'b1'].sort());
    // The block key is a bare id; the property key is colon-joined → never collide.
    expect(out.rows.some((r) => r.remote_id === 'b1')).toBe(true);
  });
});

describe('buildNotionFileSourceLeaf — prong 2: fail-closed + errors', () => {
  it('a per-data-source 404/403 during the row query is SKIPPED and sinks complete', async () => {
    const { leaf } = run([
      listResp([]),                                              // search pages → none
      listResp([dataSource('ds1', 'Gone'), dataSource('ds2', 'Live')]),
      { ok: false, status: 403 },                               // ds1 query → unreadable
      listResp([row('r2', 'Row', [propFile({ name: 'ok.pdf', path: 'a2' })])]), // ds2 query → fine
    ]);
    const out = await leaf(req());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.complete).toBe(false);                           // fail-closed — no absence-deletes
    expect(out.rows.map((r) => r.filename)).toEqual(['ok.pdf']); // ds2's file still mirrored
  });

  it('the data_source search failing aborts the cycle (block rows are uncommitted — a retry re-walks)', async () => {
    const { leaf } = run([
      listResp([page('p1', 'P')]),                              // search pages → ok
      listResp([fileBlock('b1', { name: 'x.pdf' })]),           // p1 children → ok (rows collected in-memory)
      { ok: false, status: 500 },                               // search data_source → hard error
    ]);
    const out = await leaf(req());
    expect(out.ok).toBe(false); // whole cycle aborts; the mirror is untouched (ok:false never mutates)
    if (out.ok) return;
    expect(out.kind).toBe('error');
  });

  it('an unkeyable property file (unknown type / no url) fails the walk CLOSED, healthy sibling kept', async () => {
    const { leaf } = run([
      listResp([]),
      listResp([dataSource('ds1', 'DB')]),
      listResp([row('r1', 'Row', [
        { name: 'weird', type: 'file', file: {} },              // type file but NO url → unkeyable
        propFile({ name: 'ok.pdf', path: 'a1' }),               // healthy sibling
      ])]),
    ]);
    const out = await leaf(req());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.complete).toBe(false);                           // unkeyable → not delete-authoritative
    expect(out.rows.map((r) => r.filename)).toEqual(['ok.pdf']);
  });

  it('an id-less data-source row is skipped and sinks complete', async () => {
    const { leaf } = run([
      listResp([]),
      listResp([dataSource('ds1', 'DB')]),
      listResp([
        { object: 'page', properties: { Att: { id: 'p', type: 'files', files: [propFile({ name: 'z.pdf', path: 'a1' })] } } }, // no id
        row('r2', 'Row', [propFile({ name: 'ok.pdf', path: 'a2' })]),
      ]),
    ]);
    const out = await leaf(req());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.complete).toBe(false);
    expect(out.rows.map((r) => r.filename)).toEqual(['ok.pdf']);
  });

  it('a files column whose `files` is NOT an array (malformed) fails the walk closed', async () => {
    const { leaf } = run([
      listResp([]),
      listResp([dataSource('ds1', 'DB')]),
      listResp([{
        object: 'page', id: 'r1', last_edited_time: '2026-07-03T00:00:00.000Z',
        properties: { Att: { id: 'p', type: 'files', files: null } }, // files-typed but malformed
      }]),
    ]);
    const out = await leaf(req());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.complete).toBe(false); // fail-closed (a silent skip could absence-delete live files)
    expect(out.rows).toHaveLength(0);
  });

  it('a row whose `properties` is malformed (non-object) fails the walk closed', async () => {
    const { leaf } = run([
      listResp([]),
      listResp([dataSource('ds1', 'DB')]),
      listResp([{ object: 'page', id: 'r1', last_edited_time: '2026-07-03T00:00:00.000Z', properties: null }]),
    ]);
    const out = await leaf(req());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.complete).toBe(false);
    expect(out.rows).toHaveLength(0);
  });

  it('a row with ONLY non-files properties does NOT sink complete (benign skip, still delete-authoritative)', async () => {
    // Guards the split: a `select`/`title` column must be ignored WITHOUT failing
    // closed (else the leaf could never absence-delete → the mirror never cleans up).
    const { leaf } = run([
      listResp([]),
      listResp([dataSource('ds1', 'DB')]),
      listResp([{
        object: 'page', id: 'r1', last_edited_time: '2026-07-03T00:00:00.000Z',
        properties: {
          Name: { id: 'title', type: 'title', title: [{ plain_text: 'Row' }] },
          Status: { id: 's', type: 'select', select: { name: 'Open' } },
        },
      }]),
    ]);
    const out = await leaf(req());
    if (!out.ok) throw new Error('expected ok');
    expect(out.complete).toBe(true); // no files anywhere, and nothing malformed → still authoritative
    expect(out.rows).toHaveLength(0);
  });

  it('a data source with a malformed (untitled) object still queries — path falls back to Untitled', async () => {
    const { leaf } = run([
      listResp([]),
      listResp([{ object: 'data_source', id: 'ds1' }]),         // no title
      listResp([row('r1', 'Row', [propFile({ name: 'f.pdf', path: 'a1' })])]),
    ]);
    const out = await leaf(req());
    if (!out.ok) throw new Error('expected ok');
    expect(out.complete).toBe(true);
    expect(out.rows[0].path).toBe('Untitled/Row/Attachments/f.pdf');
  });
});
