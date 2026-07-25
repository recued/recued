/** D-192 file SOURCE family (slice 5) — the per-vendor adapter leaves.
 *
 *  Each leaf satisfies `FileSourceListFn`: resolve the connection credential,
 *  walk the vendor list API to exhaustion (metadata only, never bytes), and
 *  return raw rows + a POSITIVE `complete` proof.
 *
 *  Surfaces:
 *   - S3 — `ListObjectsV2` full-metadata paging (continuation-token to
 *     exhaustion), `Key` → synthetic leaf `name` normalization, folder-marker
 *     filter, fail-closed `complete`, `basic`-auth credential mapping, typed
 *     error classification.
 *   - Dropbox — `list_folder` (+ `/continue`) bearer-auth walk, `.tag: 'file'`
 *     filter, root-path scoping, fail-closed `complete`, error classification.
 *   - The resolver factory — keyed by vendor slug, `undefined` for the rest.
 *
 *  A stub `FileFetch` scripts vendor responses + records requests; the S3
 *  SigV4 signing runs for real (the stub only skips the network). The leaf
 *  rows are also fed through the REAL slice-3 declaration + slice-4 projector
 *  to prove the normalization lands a valid `FileMetaProjection`. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONNECTION_SOURCE_ID,
  getFileVendorDeclaration,
  validateFileMetaProjection,
  type ConnectionAuth,
  type FileVendorDeclaration,
} from '@recued/contracts';

import { projectFileVendorRow } from '../file-source-projector.js';
import {
  runFileSourceSync,
  type FileSourceListRequest,
} from '../file-source-sync.js';
import {
  createFileMetaStore,
  ensureFileMetaSchema,
  type FileMetaStore,
} from '../storage/file-meta-store.js';
import {
  createFileSourceSyncStateStore,
  ensureFileSourceSyncStateSchema,
  initialFileSourceSyncState,
  type FileSourceSyncStateStore,
} from '../storage/file-source-sync-state.js';
import {
  buildBoxFileSourceLeaf,
  buildDropboxFileSourceLeaf,
  buildFileSourceAdapterResolver,
  buildGoogleFileSourceLeaf,
  buildOneDriveFileSourceLeaf,
  buildS3FileSourceLeaf,
  type FileConnectionCredential,
  type FileConnectionResolver,
  type FileFetch,
} from '../file-source-adapters/index.js';

const S3 = getFileVendorDeclaration('s3') as FileVendorDeclaration;
const DROPBOX = getFileVendorDeclaration('dropbox') as FileVendorDeclaration;
const ONEDRIVE = getFileVendorDeclaration('onedrive') as FileVendorDeclaration;
const GOOGLE = getFileVendorDeclaration('google') as FileVendorDeclaration;
const BOX = getFileVendorDeclaration('box') as FileVendorDeclaration;

// ────────────────────────────────────────────────────────────────
// Stubs
// ────────────────────────────────────────────────────────────────

interface StubCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A `FileFetch` stub — records each call + returns the scripted response for
 *  that call index. `text`/`json` derive from whichever the script set. */
const stubFetch = (
  responses: Array<{ ok?: boolean; status?: number; text?: string; json?: unknown }>,
): { fetchImpl: FileFetch; calls: StubCall[] } => {
  const calls: StubCall[] = [];
  const fetchImpl: FileFetch = async (url, init) => {
    const i = calls.length;
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      ...(typeof init.body === 'string' ? { body: init.body } : {}),
    });
    const r = responses[i] ?? { ok: false, status: 500, text: 'no scripted response' };
    const ok = r.ok ?? true;
    const status = r.status ?? (ok ? 200 : 500);
    const textBody = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : '');
    return {
      ok,
      status,
      headers: new Headers(),
      text: async () => textBody,
      json: async () => (r.json !== undefined ? r.json : JSON.parse(textBody.length > 0 ? textBody : 'null')),
      arrayBuffer: async () => new TextEncoder().encode(textBody).buffer as ArrayBuffer,
    };
  };
  return { fetchImpl, calls };
};

const resolverFor = (cred: FileConnectionCredential | null): FileConnectionResolver =>
  async () => cred;

/** A resolver that throws — models a locked vault / bad AEAD key. The leaf
 *  MUST convert this to an outcome (the housekeeping task is no-throw). */
const throwingResolver: FileConnectionResolver = async () => {
  throw new Error('vault locked');
};

const s3Request = (connection_name = 'c1'): FileSourceListRequest => ({
  source_id: CONNECTION_SOURCE_ID('s3', connection_name, 'file'),
  connection_name,
  vendor: 's3',
  declaration: S3,
  cursor: null,
});

const dropboxRequest = (
  connection_name = 'c1',
  cursor: string | null = null,
): FileSourceListRequest => ({
  source_id: CONNECTION_SOURCE_ID('dropbox', connection_name, 'file'),
  connection_name,
  vendor: 'dropbox',
  declaration: DROPBOX,
  cursor,
});

const s3Basic = (
  configOver: Record<string, unknown> = {},
): FileConnectionCredential => ({
  auth: { type: 'basic', username: 'AKIAEXAMPLE', password: 'secretkey' },
  config: { vendor: 's3', region: 'us-east-1', bucket: 'my-bucket', ...configOver },
});

interface S3XmlObj {
  key: string;
  size?: number;
  mtime?: string;
  etag?: string;
  owner?: string;
}

const s3Xml = (opts: {
  objects: S3XmlObj[];
  truncated?: boolean;
  nextToken?: string;
}): string => {
  const contents = opts.objects
    .map((o) =>
      [
        '<Contents>',
        `<Key>${o.key}</Key>`,
        o.mtime !== undefined ? `<LastModified>${o.mtime}</LastModified>` : '',
        o.etag !== undefined ? `<ETag>${o.etag}</ETag>` : '',
        o.size !== undefined ? `<Size>${o.size}</Size>` : '',
        o.owner !== undefined ? `<Owner><ID>id-x</ID><DisplayName>${o.owner}</DisplayName></Owner>` : '',
        '</Contents>',
      ].join(''),
    )
    .join('');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ListBucketResult>',
    '<Name>my-bucket</Name>',
    `<KeyCount>${opts.objects.length}</KeyCount>`,
    `<IsTruncated>${opts.truncated ? 'true' : 'false'}</IsTruncated>`,
    contents,
    opts.nextToken !== undefined ? `<NextContinuationToken>${opts.nextToken}</NextContinuationToken>` : '',
    '</ListBucketResult>',
  ].join('');
};

// ────────────────────────────────────────────────────────────────
// S3 leaf
// ────────────────────────────────────────────────────────────────

describe('buildS3FileSourceLeaf', () => {
  it('lists one complete page → normalized rows (Key → leaf name) + complete:true', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        text: s3Xml({
          objects: [
            { key: 'Work/report.pdf', size: 2048, mtime: '2026-07-01T00:00:00.000Z', etag: '&quot;etag1&quot;', owner: 'alice' },
            { key: 'notes.txt', size: 12, mtime: '2026-07-02T00:00:00.000Z', owner: 'bob' },
          ],
        }),
      },
    ]);
    const leaf = buildS3FileSourceLeaf({ resolveConnection: resolverFor(s3Basic()), fetchImpl });
    const out = await leaf(s3Request());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.complete).toBe(true);
    expect(out.rows).toEqual([
      { Key: 'Work/report.pdf', Size: 2048, LastModified: '2026-07-01T00:00:00.000Z', ETag: '"etag1"', Owner: { DisplayName: 'alice' }, name: 'report.pdf' },
      { Key: 'notes.txt', Size: 12, LastModified: '2026-07-02T00:00:00.000Z', Owner: { DisplayName: 'bob' }, name: 'notes.txt' },
    ]);
    // The request is ListObjectsV2 with owner fetch.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('list-type=2');
    expect(calls[0].url).toContain('fetch-owner=true');
  });

  it('feeds the projector a valid FileMetaProjection (filename = leaf, path/remote_id = full key)', async () => {
    const { fetchImpl } = stubFetch([
      { text: s3Xml({ objects: [{ key: 'a/b/c.pdf', size: 1, mtime: '2026-07-01T00:00:00.000Z', owner: 'z' }] }) },
    ]);
    const leaf = buildS3FileSourceLeaf({ resolveConnection: resolverFor(s3Basic()), fetchImpl });
    const out = await leaf(s3Request());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const projected = projectFileVendorRow(out.rows[0], S3);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.projection).toMatchObject({
      filename: 'c.pdf',
      path: 'a/b/c.pdf',
      remote_id: 'a/b/c.pdf',
      provider: 's3',
      owner: 'z',
    });
    expect(validateFileMetaProjection(projected.projection)).toEqual([]);
  });

  it('pages a truncated walk to exhaustion, threading the continuation token', async () => {
    const { fetchImpl, calls } = stubFetch([
      { text: s3Xml({ objects: [{ key: 'p1.txt', size: 1 }], truncated: true, nextToken: 'TOKEN-2' }) },
      { text: s3Xml({ objects: [{ key: 'p2.txt', size: 2 }], truncated: false }) },
    ]);
    const leaf = buildS3FileSourceLeaf({ resolveConnection: resolverFor(s3Basic()), fetchImpl });
    const out = await leaf(s3Request());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.complete).toBe(true);
    expect(out.rows.map((r) => r.Key)).toEqual(['p1.txt', 'p2.txt']);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).not.toContain('continuation-token');
    expect(calls[1].url).toContain('continuation-token=TOKEN-2');
  });

  it('skips ZERO-byte folder-marker keys but keeps a non-zero trailing-slash object present', async () => {
    const { fetchImpl } = stubFetch([
      {
        text: s3Xml({
          objects: [
            { key: 'Work/', size: 0 }, // zero-byte marker → folder, dropped
            { key: 'weird/', size: 42 }, // legal object w/ real bytes → kept present
            { key: 'Work/real.pdf', size: 3 },
          ],
        }),
      },
    ]);
    const leaf = buildS3FileSourceLeaf({ resolveConnection: resolverFor(s3Basic()), fetchImpl });
    const out = await leaf(s3Request());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // 'weird/' stays present so a complete walk can never tombstone it (it
    // fails projection later on its empty leaf name — degraded, never deleted).
    expect(out.rows.map((r) => r.Key)).toEqual(['weird/', 'Work/real.pdf']);
  });

  it('fail-closes (error) on a 200 list body missing IsTruncated (no false complete walk)', async () => {
    // A malformed / partial 200 body: objects present, but NO <IsTruncated>.
    // Must NOT be read as a proven complete walk (which would false-delete).
    const malformed =
      '<?xml version="1.0"?><ListBucketResult><Name>b</Name>' +
      '<Contents><Key>x.txt</Key><Size>1</Size></Contents></ListBucketResult>';
    const { fetchImpl } = stubFetch([{ text: malformed }]);
    const leaf = buildS3FileSourceLeaf({ resolveConnection: resolverFor(s3Basic()), fetchImpl });
    const out = await leaf(s3Request());
    expect(out).toMatchObject({ ok: false, kind: 'error' });
    if (out.ok) return;
    expect(out.reason).toMatch(/IsTruncated/);
  });

  it('pushes an import_scope prefix down to ListObjectsV2 (Prefix) + returns the scope', async () => {
    const { fetchImpl, calls } = stubFetch([{ text: s3Xml({ objects: [] }) }]);
    const leaf = buildS3FileSourceLeaf({
      resolveConnection: resolverFor(s3Basic({ import_scope: 'Invoices/**' })),
      fetchImpl,
    });
    const out = await leaf(s3Request());
    expect(calls[0].url).toContain('prefix=Invoices'); // 'Invoices/' url-encoded
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.scope).toEqual({ glob: 'Invoices/**', prefix: 'Invoices/' });
  });

  it('fail-closes complete when a truncated page carries no continuation token', async () => {
    const { fetchImpl } = stubFetch([
      { text: s3Xml({ objects: [{ key: 'x.txt', size: 1 }], truncated: true /* no nextToken */ }) },
    ]);
    const leaf = buildS3FileSourceLeaf({ resolveConnection: resolverFor(s3Basic()), fetchImpl });
    const out = await leaf(s3Request());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.complete).toBe(false);
    expect(out.rows.map((r) => r.Key)).toEqual(['x.txt']);
  });

  it('returns config when the connection is gone', async () => {
    const { fetchImpl } = stubFetch([]);
    const leaf = buildS3FileSourceLeaf({ resolveConnection: resolverFor(null), fetchImpl });
    const out = await leaf(s3Request());
    expect(out).toMatchObject({ ok: false, kind: 'config' });
  });

  it('converts a credential-resolution throw into an error outcome (never throws)', async () => {
    const { fetchImpl } = stubFetch([]);
    const leaf = buildS3FileSourceLeaf({ resolveConnection: throwingResolver, fetchImpl });
    const out = await leaf(s3Request());
    expect(out).toMatchObject({ ok: false, kind: 'error' });
    if (out.ok) return;
    expect(out.reason).toMatch(/resolution failed/);
  });

  it('returns config for a non-basic auth (no access key/secret carrier)', async () => {
    const { fetchImpl } = stubFetch([]);
    const cred: FileConnectionCredential = {
      auth: { type: 'bearer', token: 'nope' } as ConnectionAuth,
      config: { vendor: 's3', region: 'us-east-1', bucket: 'b' },
    };
    const leaf = buildS3FileSourceLeaf({ resolveConnection: resolverFor(cred), fetchImpl });
    const out = await leaf(s3Request());
    expect(out).toMatchObject({ ok: false, kind: 'config' });
    if (out.ok) return;
    expect(out.reason).toMatch(/basic/);
  });

  it('returns config when region/bucket are missing', async () => {
    const { fetchImpl } = stubFetch([]);
    const cred: FileConnectionCredential = {
      auth: { type: 'basic', username: 'a', password: 'b' },
      config: { vendor: 's3' /* no region/bucket */ },
    };
    const leaf = buildS3FileSourceLeaf({ resolveConnection: resolverFor(cred), fetchImpl });
    const out = await leaf(s3Request());
    expect(out).toMatchObject({ ok: false, kind: 'config' });
  });

  it('classifies AccessDenied → policy, SignatureDoesNotMatch → config, 500 → error', async () => {
    const denied = stubFetch([
      { ok: false, status: 403, text: '<Error><Code>AccessDenied</Code><Message>no</Message></Error>' },
    ]);
    const badSig = stubFetch([
      { ok: false, status: 403, text: '<Error><Code>SignatureDoesNotMatch</Code></Error>' },
    ]);
    const boom = stubFetch([{ ok: false, status: 500, text: '<Error><Code>InternalError</Code></Error>' }]);

    const mk = (f: FileFetch) => buildS3FileSourceLeaf({ resolveConnection: resolverFor(s3Basic()), fetchImpl: f });
    expect(await mk(denied.fetchImpl)(s3Request())).toMatchObject({ ok: false, kind: 'policy' });
    expect(await mk(badSig.fetchImpl)(s3Request())).toMatchObject({ ok: false, kind: 'config' });
    expect(await mk(boom.fetchImpl)(s3Request())).toMatchObject({ ok: false, kind: 'error' });
  });
});

// ────────────────────────────────────────────────────────────────
// Dropbox leaf
// ────────────────────────────────────────────────────────────────

const dbxBearer = (configOver: Record<string, unknown> = {}): FileConnectionCredential => ({
  auth: { type: 'bearer', token: 'dbx-token' },
  config: { vendor: 'dropbox', ...configOver },
});

const dbxFile = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  '.tag': 'file',
  name: 'report.pdf',
  path_display: '/Work/report.pdf',
  id: 'id:abc',
  size: 1024,
  server_modified: '2026-07-01T00:00:00.000Z',
  rev: 'a1b2',
  ...over,
});

describe('buildDropboxFileSourceLeaf', () => {
  it('lists one page, filters folders + deleted, sets the bearer header, complete:true', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        json: {
          entries: [
            dbxFile({ id: 'f1', name: 'a.pdf' }),
            { '.tag': 'folder', name: 'Work', id: 'id:folder' },
            { '.tag': 'deleted', name: 'gone.pdf', path_display: '/gone.pdf' },
            dbxFile({ id: 'f2', name: 'b.pdf' }),
          ],
          cursor: 'CUR1',
          has_more: false,
        },
      },
    ]);
    const leaf = buildDropboxFileSourceLeaf({ resolveConnection: resolverFor(dbxBearer()), fetchImpl });
    const out = await leaf(dropboxRequest());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.walk).toBe('full'); // cursor:null ⇒ a full walk (delete authority)
    expect(out.complete).toBe(true);
    expect(out.rows.map((r) => r.id)).toEqual(['f1', 'f2']);
    // A full walk owns removals by ABSENCE — it emits no explicit `removed_paths`
    // (the `deleted` entry above is simply filtered out of `rows`).
    expect(out.removed_paths).toBeUndefined();
    expect(out.next_cursor).toBe('CUR1'); // final page cursor captured as the delta watermark
    expect(calls[0].url).toContain('/2/files/list_folder');
    expect(calls[0].headers.authorization).toBe('Bearer dbx-token');
    // Root walk from '' recursive.
    expect(JSON.parse(calls[0].body ?? '{}')).toMatchObject({ path: '', recursive: true });
  });

  it('projects a file entry into a valid FileMetaProjection', async () => {
    const { fetchImpl } = stubFetch([{ json: { entries: [dbxFile()], has_more: false } }]);
    const leaf = buildDropboxFileSourceLeaf({ resolveConnection: resolverFor(dbxBearer()), fetchImpl });
    const out = await leaf(dropboxRequest());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const projected = projectFileVendorRow(out.rows[0], DROPBOX);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.projection).toMatchObject({
      filename: 'report.pdf',
      path: '/Work/report.pdf',
      remote_id: 'id:abc',
      provider: 'dropbox',
      revision: 'a1b2',
    });
    expect(validateFileMetaProjection(projected.projection)).toEqual([]);
  });

  it('follows the continue cursor to exhaustion', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: { entries: [dbxFile({ id: 'p1' })], cursor: 'CUR-A', has_more: true } },
      { json: { entries: [dbxFile({ id: 'p2' })], cursor: 'CUR-B', has_more: false } },
    ]);
    const leaf = buildDropboxFileSourceLeaf({ resolveConnection: resolverFor(dbxBearer()), fetchImpl });
    const out = await leaf(dropboxRequest());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.complete).toBe(true);
    expect(out.rows.map((r) => r.id)).toEqual(['p1', 'p2']);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain('/2/files/list_folder/continue');
    expect(JSON.parse(calls[1].body ?? '{}')).toEqual({ cursor: 'CUR-A' });
  });

  it('translates an import_scope to the list_folder folder path + returns the scope', async () => {
    const { fetchImpl, calls } = stubFetch([{ json: { entries: [], has_more: false } }]);
    const leaf = buildDropboxFileSourceLeaf({
      resolveConnection: resolverFor(dbxBearer({ import_scope: 'Team/**' })),
      fetchImpl,
    });
    const out = await leaf(dropboxRequest());
    expect(JSON.parse(calls[0].body ?? '{}')).toMatchObject({ path: '/Team' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.scope).toEqual({ glob: 'Team/**', prefix: 'Team/' });
  });

  it('fail-closes complete when has_more stays true but no cursor is returned', async () => {
    const { fetchImpl } = stubFetch([
      { json: { entries: [dbxFile({ id: 'x' })], has_more: true /* no cursor */ } },
    ]);
    const leaf = buildDropboxFileSourceLeaf({ resolveConnection: resolverFor(dbxBearer()), fetchImpl });
    const out = await leaf(dropboxRequest());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.complete).toBe(false);
  });

  it('fail-closes (error) on a malformed 200 body (missing entries / has_more — no false complete)', async () => {
    // A `{}` body (schema drift / proxy corruption) must NOT read as a
    // complete empty walk that tombstones every mirrored file.
    const emptyObj = buildDropboxFileSourceLeaf({
      resolveConnection: resolverFor(dbxBearer()),
      fetchImpl: stubFetch([{ json: {} }]).fetchImpl,
    });
    expect(await emptyObj(dropboxRequest())).toMatchObject({ ok: false, kind: 'error' });
    // entries present but has_more missing → still malformed.
    const noHasMore = buildDropboxFileSourceLeaf({
      resolveConnection: resolverFor(dbxBearer()),
      fetchImpl: stubFetch([{ json: { entries: [] } }]).fetchImpl,
    });
    expect(await noHasMore(dropboxRequest())).toMatchObject({ ok: false, kind: 'error' });
  });

  it('returns config when the connection is gone or carries no bearer token', async () => {
    const gone = buildDropboxFileSourceLeaf({ resolveConnection: resolverFor(null), fetchImpl: stubFetch([]).fetchImpl });
    expect(await gone(dropboxRequest())).toMatchObject({ ok: false, kind: 'config' });

    const noToken = buildDropboxFileSourceLeaf({
      resolveConnection: resolverFor({ auth: { type: 'none' }, config: { vendor: 'dropbox' } }),
      fetchImpl: stubFetch([]).fetchImpl,
    });
    expect(await noToken(dropboxRequest())).toMatchObject({ ok: false, kind: 'config' });
  });

  it('converts a credential-resolution throw into an error outcome (never throws)', async () => {
    const leaf = buildDropboxFileSourceLeaf({
      resolveConnection: throwingResolver,
      fetchImpl: stubFetch([]).fetchImpl,
    });
    const out = await leaf(dropboxRequest());
    expect(out).toMatchObject({ ok: false, kind: 'error' });
  });

  it('classifies 401 → config, 403 → policy, 500 → error', async () => {
    const mk = (status: number): FileFetch => stubFetch([{ ok: false, status, text: 'err' }]).fetchImpl;
    const leaf = (status: number) =>
      buildDropboxFileSourceLeaf({ resolveConnection: resolverFor(dbxBearer()), fetchImpl: mk(status) });
    expect(await leaf(401)(dropboxRequest())).toMatchObject({ ok: false, kind: 'config' });
    expect(await leaf(403)(dropboxRequest())).toMatchObject({ ok: false, kind: 'policy' });
    expect(await leaf(500)(dropboxRequest())).toMatchObject({ ok: false, kind: 'error' });
  });

  // ── delta walk (a stored cursor is passed) ──────────────────────

  it('rides the stored cursor on a delta walk: /continue, upserts changes, SURFACES deleted tombstone paths in removed_paths (Option 3), walk:delta', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        json: {
          entries: [
            dbxFile({ id: 'f9', name: 'new.pdf' }),
            { '.tag': 'deleted', name: 'gone.pdf', path_display: '/gone.pdf' }, // Option 3 — surfaced as an explicit removal
          ],
          cursor: 'CUR-NEXT',
          has_more: false,
        },
      },
    ]);
    const leaf = buildDropboxFileSourceLeaf({ resolveConnection: resolverFor(dbxBearer()), fetchImpl });
    const out = await leaf(dropboxRequest('c1', 'CUR-PREV'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.walk).toBe('delta');
    expect(out.complete).toBe(false); // a delta is never delete-authoritative BY ABSENCE
    expect(out.rows.map((r) => r.id)).toEqual(['f9']); // the file rides in `rows`
    // The tombstone rides in `removed_paths` (path_display) — the runner reverse-
    // looks it up + tombstones the mirror row THIS cycle (no more 24h delete-lag).
    expect(out.removed_paths).toEqual(['/gone.pdf']);
    expect(out.next_cursor).toBe('CUR-NEXT'); // watermark advanced (the delta drained)
    // It replayed /continue with the STORED cursor — no fresh list_folder.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/2/files/list_folder/continue');
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ cursor: 'CUR-PREV' });
  });

  it('pages a delta continue to exhaustion, advancing to the final cursor + accumulating removed_paths across pages', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        json: {
          entries: [dbxFile({ id: 'd1' }), { '.tag': 'deleted', name: 'g1', path_display: '/g1.pdf' }],
          cursor: 'CUR-2',
          has_more: true,
        },
      },
      {
        json: {
          entries: [dbxFile({ id: 'd2' }), { '.tag': 'deleted', name: 'g2', path_display: '/g2.pdf' }],
          cursor: 'CUR-3',
          has_more: false,
        },
      },
    ]);
    const leaf = buildDropboxFileSourceLeaf({ resolveConnection: resolverFor(dbxBearer()), fetchImpl });
    const out = await leaf(dropboxRequest('c1', 'CUR-1'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.walk).toBe('delta');
    expect(out.rows.map((r) => r.id)).toEqual(['d1', 'd2']);
    expect(out.removed_paths).toEqual(['/g1.pdf', '/g2.pdf']); // both pages' tombstones accumulated
    expect(out.next_cursor).toBe('CUR-3');
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ cursor: 'CUR-1' });
    expect(JSON.parse(calls[1].body ?? '{}')).toEqual({ cursor: 'CUR-2' });
  });

  it('skips a delta tombstone with no usable path_display (unmatchable — the full walk backstops it)', async () => {
    const { fetchImpl } = stubFetch([
      {
        json: {
          entries: [
            dbxFile({ id: 'k1' }),
            { '.tag': 'deleted', name: 'nopath' }, // no path_display → not a usable removal
            { '.tag': 'deleted', name: 'empty', path_display: '' }, // empty path → skipped too
            { '.tag': 'deleted', name: 'ok', path_display: '/ok.pdf' },
          ],
          cursor: 'C2',
          has_more: false,
        },
      },
    ]);
    const leaf = buildDropboxFileSourceLeaf({ resolveConnection: resolverFor(dbxBearer()), fetchImpl });
    const out = await leaf(dropboxRequest('c1', 'C1'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.removed_paths).toEqual(['/ok.pdf']); // only the tombstone with a usable path
  });

  it('SUPPRESSES removed_paths + forces a full re-list when a delta cannot drain (has_more:true, no cursor) — no false-delete of an unreached move (regression)', async () => {
    // A malformed / proxy-corrupted delta page: a deleted tombstone, has_more
    // true, but NO cursor to continue. The unreachable next page could carry the
    // moved file's new-path entry, so trusting this tombstone would false-delete
    // the moved file. The leaf must NOT emit the removal from an undrained delta,
    // and must force a full re-list (next_cursor null) rather than replay.
    const { fetchImpl } = stubFetch([
      {
        json: {
          entries: [
            dbxFile({ id: 'stay' }),
            { '.tag': 'deleted', name: 'movedaway', path_display: '/A/x.pdf' },
          ],
          has_more: true, // more pages exist...
          // ...but NO cursor → the leaf cannot continue (undrained).
        },
      },
    ]);
    const leaf = buildDropboxFileSourceLeaf({ resolveConnection: resolverFor(dbxBearer()), fetchImpl });
    const out = await leaf(dropboxRequest('c1', 'STALE'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.walk).toBe('delta');
    expect(out.removed_paths).toEqual([]); // SUPPRESSED — an undrained delta's tombstones are untrustworthy
    expect(out.next_cursor).toBeNull(); // force a full re-list next cycle (not a replay of the bad cursor)
    expect(out.rows.map((r) => r.id)).toEqual(['stay']); // the upsert we DID see still lands (additive/safe)
  });

  it('a DRAINED delta whose FINAL page carries no cursor trusts removals but returns next_cursor null (force full re-list, not a stale intermediate cursor)', async () => {
    // A drained (has_more:false) multi-page delta whose TERMINAL page is missing
    // its cursor. Removals ARE trustworthy (the delta drained), but the watermark
    // to continue from does not exist — so the leaf must return next_cursor null
    // (full re-list next cycle), NOT the earlier intermediate 'CUR-2' (which would
    // re-fetch the same pages forever without advancing).
    const { fetchImpl } = stubFetch([
      { json: { entries: [dbxFile({ id: 'd1' }), { '.tag': 'deleted', name: 'g', path_display: '/g.pdf' }], cursor: 'CUR-2', has_more: true } },
      { json: { entries: [dbxFile({ id: 'd2' })], has_more: false /* NO cursor on the terminal page */ } },
    ]);
    const leaf = buildDropboxFileSourceLeaf({ resolveConnection: resolverFor(dbxBearer()), fetchImpl });
    const out = await leaf(dropboxRequest('c1', 'CUR-1'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.walk).toBe('delta');
    expect(out.rows.map((r) => r.id)).toEqual(['d1', 'd2']); // both pages' files
    expect(out.removed_paths).toEqual(['/g.pdf']); // drained ⇒ removals trusted
    expect(out.next_cursor).toBeNull(); // terminal page had no cursor ⇒ null, NOT the intermediate 'CUR-2'
  });

  it('a cursor RESET (409 reset) transparently falls back to a full list_folder walk', async () => {
    const { fetchImpl, calls } = stubFetch([
      // The delta /continue with the stale cursor → 409 reset.
      { ok: false, status: 409, text: '{"error_summary":"reset/...","error":{".tag":"reset"}}' },
      // The transparent fallback: a fresh full list_folder walk.
      { json: { entries: [dbxFile({ id: 'z1' })], cursor: 'FRESH', has_more: false } },
    ]);
    const leaf = buildDropboxFileSourceLeaf({ resolveConnection: resolverFor(dbxBearer()), fetchImpl });
    const out = await leaf(dropboxRequest('c1', 'STALE-CURSOR'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Recovered as a FULL walk THIS cycle — delete authority + fresh watermark restored.
    expect(out.walk).toBe('full');
    expect(out.complete).toBe(true);
    expect(out.rows.map((r) => r.id)).toEqual(['z1']);
    expect(out.next_cursor).toBe('FRESH');
    // Call 0 = the failed /continue; call 1 = the fallback list_folder (base, not continue).
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('/2/files/list_folder/continue');
    expect(calls[1].url).toContain('/2/files/list_folder');
    expect(calls[1].url).not.toContain('/continue');
    expect(JSON.parse(calls[1].body ?? '{}')).toMatchObject({ path: '', recursive: true });
  });

  it('a non-reset 409 is classified as a retryable error, NOT a full fallback', async () => {
    // A 409 without a `reset` tag must not masquerade as a reset (which would
    // wrongly re-list); it is a plain retryable error.
    const { fetchImpl, calls } = stubFetch([
      { ok: false, status: 409, text: '{"error_summary":"path/conflict/...","error":{".tag":"path"}}' },
    ]);
    const leaf = buildDropboxFileSourceLeaf({ resolveConnection: resolverFor(dbxBearer()), fetchImpl });
    const out = await leaf(dropboxRequest('c1', 'SOME-CURSOR'));
    expect(out).toMatchObject({ ok: false, kind: 'error' });
    expect(calls).toHaveLength(1); // no full fallback fired
  });
});

// ────────────────────────────────────────────────────────────────
// OneDrive (MS Graph /delta) — the first ID-keyed delta vendor
// ────────────────────────────────────────────────────────────────

const odBearer = (configOver: Record<string, unknown> = {}): FileConnectionCredential => ({
  auth: { type: 'bearer', token: 'od-token' },
  config: { vendor: 'onedrive', ...configOver },
});

/** A Graph driveItem carrying a `file` facet (a real file). */
const odItem = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'itm-1',
  name: 'report.pdf',
  size: 2048,
  lastModifiedDateTime: '2026-07-01T00:00:00.000Z',
  eTag: '"{GUID},1"',
  file: { mimeType: 'application/pdf' },
  parentReference: { path: '/drive/root:/Work' },
  ...over,
});

/** A Graph `deleted`-facet tombstone — ID-keyed (`removed_keys`). */
const odDeleted = (id: string): Record<string, unknown> => ({ id, deleted: { state: 'deleted' } });

/** A Graph folder item — skipped (not a file). */
const odFolder = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'fld-1',
  name: 'Work',
  folder: { childCount: 3 },
  parentReference: { path: '/drive/root:' },
  ...over,
});

const odRequest = (
  connection_name = 'c1',
  cursor: string | null = null,
): FileSourceListRequest => ({
  source_id: CONNECTION_SOURCE_ID('onedrive', connection_name, 'file'),
  connection_name,
  vendor: 'onedrive',
  declaration: ONEDRIVE,
  cursor,
});

const OD_ROOT_DELTA = 'https://graph.microsoft.com/v1.0/me/drive/root/delta';

describe('buildOneDriveFileSourceLeaf', () => {
  // ── full walk (cursor:null ⇒ a from-scratch /delta drain) ────────

  it('full-walks /me/drive/root/delta, keeps file items, skips folders + deleted, sets the bearer header, complete:true', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        json: {
          value: [
            odItem({ id: 'f1', name: 'a.pdf' }),
            odFolder(),
            odDeleted('x'), // a tombstone on a from-scratch drain — filtered, NOT surfaced
            odItem({ id: 'f2', name: 'b.pdf' }),
          ],
          '@odata.deltaLink': `${OD_ROOT_DELTA}?token=DL1`,
        },
      },
    ]);
    const leaf = buildOneDriveFileSourceLeaf({ resolveConnection: resolverFor(odBearer()), fetchImpl });
    const out = await leaf(odRequest());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.walk).toBe('full'); // cursor:null ⇒ full walk (delete authority)
    expect(out.complete).toBe(true); // reached a deltaLink ⇒ whole feed walked
    expect(out.rows.map((r) => r.id)).toEqual(['f1', 'f2']); // folder + tombstone dropped
    // A full walk owns removals by ABSENCE — it emits no explicit `removed_keys`.
    expect(out.removed_keys).toBeUndefined();
    expect(out.next_cursor).toBe(`${OD_ROOT_DELTA}?token=DL1`); // deltaLink captured as watermark
    expect(calls[0].url).toBe(OD_ROOT_DELTA);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].headers.authorization).toBe('Bearer od-token');
  });

  it('projects a Graph file item into a valid FileMetaProjection (synthetic path, dotted mime)', async () => {
    const { fetchImpl } = stubFetch([{ json: { value: [odItem()], '@odata.deltaLink': `${OD_ROOT_DELTA}?token=D` } }]);
    const leaf = buildOneDriveFileSourceLeaf({ resolveConnection: resolverFor(odBearer()), fetchImpl });
    const out = await leaf(odRequest());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const projected = projectFileVendorRow(out.rows[0], ONEDRIVE);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.projection).toMatchObject({
      filename: 'report.pdf',
      path: '/Work/report.pdf', // synthesized from parentReference.path + name
      remote_id: 'itm-1',
      provider: 'onedrive',
      mime_type: 'application/pdf', // dotted read of file.mimeType
      revision: '"{GUID},1"',
      size: 2048,
    });
    expect(validateFileMetaProjection(projected.projection)).toEqual([]);
  });

  it('synthesizes the canonical path from parentReference.path (root-level, nested, URL-decoded)', async () => {
    const { fetchImpl } = stubFetch([
      {
        json: {
          value: [
            odItem({ id: 'r', name: 'root.pdf', parentReference: { path: '/drive/root:' } }),
            odItem({ id: 'n', name: 'deep.pdf', parentReference: { path: '/drive/root:/A/B' } }),
            odItem({ id: 'e', name: 'q1.pdf', parentReference: { path: '/drive/root:/My%20Docs' } }),
            odItem({ id: 'b', name: 'biz.pdf', parentReference: { path: '/drives/b!xyz/root:/Reports' } }),
          ],
          '@odata.deltaLink': `${OD_ROOT_DELTA}?token=D`,
        },
      },
    ]);
    const leaf = buildOneDriveFileSourceLeaf({ resolveConnection: resolverFor(odBearer()), fetchImpl });
    const out = await leaf(odRequest());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows.map((r) => r.path)).toEqual([
      '/root.pdf',
      '/A/B/deep.pdf',
      '/My Docs/q1.pdf', // %20 decoded
      '/Reports/biz.pdf', // /drives/{id}/root: prefix stripped too
    ]);
  });

  it('follows @odata.nextLink to exhaustion, capturing the terminal deltaLink', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: { value: [odItem({ id: 'p1' })], '@odata.nextLink': `${OD_ROOT_DELTA}?token=NEXT` } },
      { json: { value: [odItem({ id: 'p2' })], '@odata.deltaLink': `${OD_ROOT_DELTA}?token=DLZ` } },
    ]);
    const leaf = buildOneDriveFileSourceLeaf({ resolveConnection: resolverFor(odBearer()), fetchImpl });
    const out = await leaf(odRequest());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.complete).toBe(true);
    expect(out.rows.map((r) => r.id)).toEqual(['p1', 'p2']);
    expect(out.next_cursor).toBe(`${OD_ROOT_DELTA}?token=DLZ`);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe(`${OD_ROOT_DELTA}?token=NEXT`); // followed the nextLink
  });

  it('fail-closes complete when a page has neither nextLink nor deltaLink (undrained, no false complete)', async () => {
    const { fetchImpl } = stubFetch([{ json: { value: [odItem({ id: 'x' })] /* no links */ } }]);
    const leaf = buildOneDriveFileSourceLeaf({ resolveConnection: resolverFor(odBearer()), fetchImpl });
    const out = await leaf(odRequest());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.complete).toBe(false); // no deltaLink reached ⇒ unproven walk
    expect(out.next_cursor).toBeNull();
  });

  it('fail-closes (error) on a malformed 200 body (no value array — no false complete-empty walk)', async () => {
    const emptyObj = buildOneDriveFileSourceLeaf({
      resolveConnection: resolverFor(odBearer()),
      fetchImpl: stubFetch([{ json: {} }]).fetchImpl,
    });
    expect(await emptyObj(odRequest())).toMatchObject({ ok: false, kind: 'error' });
  });

  it('returns config when the connection is gone or carries no bearer token', async () => {
    const gone = buildOneDriveFileSourceLeaf({ resolveConnection: resolverFor(null), fetchImpl: stubFetch([]).fetchImpl });
    expect(await gone(odRequest())).toMatchObject({ ok: false, kind: 'config' });
    const noToken = buildOneDriveFileSourceLeaf({
      resolveConnection: resolverFor({ auth: { type: 'none' }, config: { vendor: 'onedrive' } }),
      fetchImpl: stubFetch([]).fetchImpl,
    });
    expect(await noToken(odRequest())).toMatchObject({ ok: false, kind: 'config' });
  });

  it('converts a credential-resolution throw into an error outcome (never throws)', async () => {
    const leaf = buildOneDriveFileSourceLeaf({ resolveConnection: throwingResolver, fetchImpl: stubFetch([]).fetchImpl });
    expect(await leaf(odRequest())).toMatchObject({ ok: false, kind: 'error' });
  });

  it('classifies 401 → config, 403 → policy, 500 → error', async () => {
    const mk = (status: number): FileFetch => stubFetch([{ ok: false, status, text: '{"error":{"code":"x"}}' }]).fetchImpl;
    const leaf = (status: number) =>
      buildOneDriveFileSourceLeaf({ resolveConnection: resolverFor(odBearer()), fetchImpl: mk(status) });
    expect(await leaf(401)(odRequest())).toMatchObject({ ok: false, kind: 'config' });
    expect(await leaf(403)(odRequest())).toMatchObject({ ok: false, kind: 'policy' });
    expect(await leaf(500)(odRequest())).toMatchObject({ ok: false, kind: 'error' });
  });

  it('targets a non-default drive when config.drive_id is set (full walk start URL)', async () => {
    const { fetchImpl, calls } = stubFetch([{ json: { value: [], '@odata.deltaLink': 'x' } }]);
    const leaf = buildOneDriveFileSourceLeaf({
      resolveConnection: resolverFor(odBearer({ drive_id: 'b!xyz' })),
      fetchImpl,
    });
    await leaf(odRequest());
    expect(calls[0].url).toBe('https://graph.microsoft.com/v1.0/drives/b!xyz/root/delta');
  });

  it('returns an import_scope in the outcome but pushes NOTHING down (client-side glob only)', async () => {
    const { fetchImpl, calls } = stubFetch([{ json: { value: [], '@odata.deltaLink': 'x' } }]);
    const leaf = buildOneDriveFileSourceLeaf({
      resolveConnection: resolverFor(odBearer({ import_scope: 'Team/**' })),
      fetchImpl,
    });
    const out = await leaf(odRequest());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.scope).toEqual({ glob: 'Team/**', prefix: 'Team/' });
    expect(calls[0].url).toBe(OD_ROOT_DELTA); // no query filter — /delta has no server-side prefix
  });

  // ── delta walk (a stored deltaLink is passed) ────────────────────

  it('rides the stored deltaLink on a delta walk: GETs it directly, upserts changes, SURFACES deleted ids in removed_keys, walk:delta', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        json: {
          value: [
            odItem({ id: 'f9', name: 'new.pdf' }),
            odDeleted('gone-id'), // Option 3 — an ID-keyed explicit removal
          ],
          '@odata.deltaLink': `${OD_ROOT_DELTA}?token=DL2`,
        },
      },
    ]);
    const storedLink = `${OD_ROOT_DELTA}?token=DL-PREV`;
    const leaf = buildOneDriveFileSourceLeaf({ resolveConnection: resolverFor(odBearer()), fetchImpl });
    const out = await leaf(odRequest('c1', storedLink));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.walk).toBe('delta');
    expect(out.complete).toBe(false); // a delta is never delete-authoritative by ABSENCE
    expect(out.rows.map((r) => r.id)).toEqual(['f9']); // the file rides in `rows`
    // The tombstone rides in `removed_keys` (the item id) — the runner deletes the
    // mirror key DIRECTLY (no reverse lookup), tombstoning it THIS cycle.
    expect(out.removed_keys).toEqual(['gone-id']);
    expect(out.next_cursor).toBe(`${OD_ROOT_DELTA}?token=DL2`); // watermark advanced
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(storedLink); // GET the stored deltaLink directly, no re-derive
  });

  it('pages a delta to exhaustion, accumulating removed_keys across pages', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: { value: [odItem({ id: 'd1' }), odDeleted('g1')], '@odata.nextLink': `${OD_ROOT_DELTA}?token=P2` } },
      { json: { value: [odItem({ id: 'd2' }), odDeleted('g2')], '@odata.deltaLink': `${OD_ROOT_DELTA}?token=DL3` } },
    ]);
    const leaf = buildOneDriveFileSourceLeaf({ resolveConnection: resolverFor(odBearer()), fetchImpl });
    const out = await leaf(odRequest('c1', `${OD_ROOT_DELTA}?token=P1`));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.walk).toBe('delta');
    expect(out.rows.map((r) => r.id)).toEqual(['d1', 'd2']);
    expect(out.removed_keys).toEqual(['g1', 'g2']); // both pages' tombstones accumulated
    expect(out.next_cursor).toBe(`${OD_ROOT_DELTA}?token=DL3`);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe(`${OD_ROOT_DELTA}?token=P2`);
  });

  it('SUPPRESSES removed_keys + forces a full re-list when a delta cannot drain (terminal page: no links) — regression', async () => {
    // A malformed / proxy-corrupted delta page: a tombstone, but NO nextLink AND
    // NO deltaLink to finalize. The undrained delta has NOT seen the full change
    // set, so trusting its tombstone could false-delete an unidentified move
    // destination on the unreached page. Suppress + force a full re-list.
    const { fetchImpl } = stubFetch([{ json: { value: [odItem({ id: 'stay' }), odDeleted('movedaway')] /* no links */ } }]);
    const leaf = buildOneDriveFileSourceLeaf({ resolveConnection: resolverFor(odBearer()), fetchImpl });
    const out = await leaf(odRequest('c1', `${OD_ROOT_DELTA}?token=STALE`));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.walk).toBe('delta');
    expect(out.removed_keys).toEqual([]); // SUPPRESSED — an undrained delta's tombstones are untrustworthy
    expect(out.next_cursor).toBeNull(); // force a full re-list next cycle
    expect(out.rows.map((r) => r.id)).toEqual(['stay']); // the upsert we DID see still lands
  });

  it('a RESYNC (410 Gone) transparently falls back to a full from-scratch /delta walk', async () => {
    const { fetchImpl, calls } = stubFetch([
      // The delta from the stale deltaLink → 410 resyncRequired.
      { ok: false, status: 410, text: '{"error":{"code":"resyncRequired","message":"..."}}' },
      // The transparent fallback: a fresh from-scratch /delta full walk.
      { json: { value: [odItem({ id: 'z1' })], '@odata.deltaLink': `${OD_ROOT_DELTA}?token=FRESH` } },
    ]);
    const leaf = buildOneDriveFileSourceLeaf({ resolveConnection: resolverFor(odBearer()), fetchImpl });
    const out = await leaf(odRequest('c1', `${OD_ROOT_DELTA}?token=STALE`));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.walk).toBe('full'); // recovered as a FULL walk THIS cycle
    expect(out.complete).toBe(true);
    expect(out.rows.map((r) => r.id)).toEqual(['z1']);
    expect(out.next_cursor).toBe(`${OD_ROOT_DELTA}?token=FRESH`);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(`${OD_ROOT_DELTA}?token=STALE`); // the failed delta
    expect(calls[1].url).toBe(OD_ROOT_DELTA); // the fallback full /delta from scratch
  });

  it('detects resyncRequired by error CODE even on a non-410 status (defensive) → full fallback', async () => {
    const { fetchImpl, calls } = stubFetch([
      { ok: false, status: 400, text: '{"error":{"code":"resyncRequired"}}' },
      { json: { value: [odItem({ id: 'z' })], '@odata.deltaLink': 'x' } },
    ]);
    const leaf = buildOneDriveFileSourceLeaf({ resolveConnection: resolverFor(odBearer()), fetchImpl });
    const out = await leaf(odRequest('c1', `${OD_ROOT_DELTA}?token=STALE`));
    expect(out).toMatchObject({ ok: true, walk: 'full' });
    expect(calls).toHaveLength(2);
  });

  it('a non-resync error on a delta walk is classified (error), NOT a full fallback', async () => {
    const { fetchImpl, calls } = stubFetch([{ ok: false, status: 500, text: '{"error":{"code":"serviceError"}}' }]);
    const leaf = buildOneDriveFileSourceLeaf({ resolveConnection: resolverFor(odBearer()), fetchImpl });
    const out = await leaf(odRequest('c1', `${OD_ROOT_DELTA}?token=SOME`));
    expect(out).toMatchObject({ ok: false, kind: 'error' });
    expect(calls).toHaveLength(1); // no fallback fired
  });

  // ── review folds: path-omission safety + last-occurrence dedup ────

  it('leaves the path UNRESOLVED (never a fabricated root) when parentReference.path is absent — a nested item is not misfiled', async () => {
    // A Graph /delta item may omit parentReference.path. Guessing `/name` would
    // misfile a nested file as root-level (→ false-drop under a scope, and on a
    // full walk a false-DELETE of its prior in-scope mirror row). The leaf must
    // leave path undefined (present-but-unlocatable — the runner keeps it).
    const { fetchImpl } = stubFetch([
      {
        json: {
          value: [
            odItem({ id: 'no-parent-path', name: 'orphan.pdf', parentReference: { driveId: 'd!1' /* no path */ } }),
            odItem({ id: 'no-parent', name: 'bare.pdf', parentReference: undefined }),
            odItem({ id: 'rooted', name: 'top.pdf', parentReference: { path: '/drive/root:' } }), // genuinely root
          ],
          '@odata.deltaLink': `${OD_ROOT_DELTA}?token=D`,
        },
      },
    ]);
    const leaf = buildOneDriveFileSourceLeaf({ resolveConnection: resolverFor(odBearer()), fetchImpl });
    const out = await leaf(odRequest());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const pathById = new Map(out.rows.map((r) => [r.id, r.path]));
    expect(pathById.get('no-parent-path')).toBeUndefined(); // NOT fabricated as '/orphan.pdf'
    expect(pathById.get('no-parent')).toBeUndefined();
    expect(pathById.get('rooted')).toBe('/top.pdf'); // a genuine root item still resolves
  });

  it('collapses a repeated id to its LAST occurrence: file→deleted removes it (not upserted)', async () => {
    // Graph delta is last-occurrence-wins + may repeat an id across the drain. A
    // file that ENDS `deleted` must ride ONLY in removed_keys — never both rows +
    // removed_keys (which the runner's polledKeys guard would resolve to a KEPT
    // row = a MISSED delete).
    const { fetchImpl } = stubFetch([
      {
        json: {
          value: [odItem({ id: 'A', name: 'a.pdf' }), odDeleted('A')], // A ends deleted
          '@odata.deltaLink': `${OD_ROOT_DELTA}?token=D`,
        },
      },
    ]);
    const leaf = buildOneDriveFileSourceLeaf({ resolveConnection: resolverFor(odBearer()), fetchImpl });
    const out = await leaf(odRequest('c1', `${OD_ROOT_DELTA}?token=P`));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows.map((r) => r.id)).toEqual([]); // NOT upserted
    expect(out.removed_keys).toEqual(['A']); // removed (last state wins)
  });

  it('collapses a repeated id to its LAST occurrence: deleted→file keeps it (not removed)', async () => {
    const { fetchImpl } = stubFetch([
      {
        json: {
          value: [odDeleted('B'), odItem({ id: 'B', name: 'b.pdf' })], // B ends as a live file
          '@odata.deltaLink': `${OD_ROOT_DELTA}?token=D`,
        },
      },
    ]);
    const leaf = buildOneDriveFileSourceLeaf({ resolveConnection: resolverFor(odBearer()), fetchImpl });
    const out = await leaf(odRequest('c1', `${OD_ROOT_DELTA}?token=P`));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows.map((r) => r.id)).toEqual(['B']); // upserted (last state wins)
    expect(out.removed_keys).toEqual([]); // NOT removed
  });

  it('last-occurrence-wins holds ACROSS pages (file on page 1, deleted on page 2 → removed)', async () => {
    const { fetchImpl } = stubFetch([
      { json: { value: [odItem({ id: 'C', name: 'c.pdf' })], '@odata.nextLink': `${OD_ROOT_DELTA}?token=P2` } },
      { json: { value: [odDeleted('C')], '@odata.deltaLink': `${OD_ROOT_DELTA}?token=D` } },
    ]);
    const leaf = buildOneDriveFileSourceLeaf({ resolveConnection: resolverFor(odBearer()), fetchImpl });
    const out = await leaf(odRequest('c1', `${OD_ROOT_DELTA}?token=P1`));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows.map((r) => r.id)).toEqual([]); // the page-1 upsert is superseded
    expect(out.removed_keys).toEqual(['C']);
  });
});

// ────────────────────────────────────────────────────────────────
// Google Drive (changes.list) — the second ID-keyed delta vendor
// ────────────────────────────────────────────────────────────────

const gBearer = (configOver: Record<string, unknown> = {}): FileConnectionCredential => ({
  auth: { type: 'bearer', token: 'g-token' },
  config: { vendor: 'google', ...configOver },
});

/** A Drive File resource (a real file). */
const gFile = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'file-1',
  name: 'report.pdf',
  mimeType: 'application/pdf',
  size: '2048',
  modifiedTime: '2026-07-01T00:00:00.000Z',
  version: '7',
  trashed: false,
  parents: ['folder-1'],
  owners: [{ displayName: 'Ada Lovelace' }],
  ...over,
});

/** A Drive folder File — skipped (not a file). */
const gFolder = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'fld-1',
  name: 'Work',
  mimeType: 'application/vnd.google-apps.folder',
  ...over,
});

/** A `changes.list` entry wrapping a live file change (an upsert). */
const gChange = (file: Record<string, unknown>): Record<string, unknown> => ({
  kind: 'drive#change',
  changeType: 'file',
  removed: false,
  fileId: String(file.id),
  file,
});

/** A `changes.list` REMOVED tombstone — ID-keyed (`removed_keys`). */
const gRemoved = (fileId: string): Record<string, unknown> => ({
  kind: 'drive#change',
  changeType: 'file',
  removed: true,
  fileId,
});

const gRequest = (
  connection_name = 'c1',
  cursor: string | null = null,
): FileSourceListRequest => ({
  source_id: CONNECTION_SOURCE_ID('google', connection_name, 'file'),
  connection_name,
  vendor: 'google',
  declaration: GOOGLE,
  cursor,
});

const G_FILES = 'https://www.googleapis.com/drive/v3/files';
const G_CHANGES = 'https://www.googleapis.com/drive/v3/changes';
const G_START = 'https://www.googleapis.com/drive/v3/changes/startPageToken?supportsAllDrives=true';

describe('buildGoogleFileSourceLeaf', () => {
  // ── full walk (cursor:null ⇒ getStartPageToken + files.list) ─────

  it('full-walks: getStartPageToken THEN files.list, keeps files, skips folders + trashed, bearer header, complete:true, watermark = the up-front token', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: { startPageToken: 'SPT-1' } },
      {
        json: {
          files: [
            gFile({ id: 'f1', name: 'a.pdf' }),
            gFolder(),
            gFile({ id: 't', name: 'gone.pdf', trashed: true }),
            gFile({ id: 'f2', name: 'b.pdf' }),
          ],
        },
      },
    ]);
    const leaf = buildGoogleFileSourceLeaf({ resolveConnection: resolverFor(gBearer()), fetchImpl });
    const out = await leaf(gRequest());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.walk).toBe('full'); // cursor:null ⇒ full walk (delete authority)
    expect(out.complete).toBe(true); // files.list drained ⇒ whole tree walked
    expect(out.rows.map((r) => r.id)).toEqual(['f1', 'f2']); // folder + trashed dropped
    // A full walk owns removals by ABSENCE — no explicit `removed_keys`.
    expect(out.removed_keys).toBeUndefined();
    expect(out.next_cursor).toBe('SPT-1'); // the up-front start token is the watermark
    expect(out.scope).toBeNull(); // Drive v1: no native path ⇒ no scope
    expect(calls[0].url).toBe(G_START); // token captured BEFORE the list (Google's rule)
    expect(calls[1].url).toContain(`${G_FILES}?`);
    // D-192 hardening — the full-walk list spans My Drive + SHARED drives.
    expect(calls[1].url).toContain('corpora=allDrives');
    expect(calls[1].url).toContain('includeItemsFromAllDrives=true');
    expect(calls[1].url).toContain('supportsAllDrives=true');
    expect(calls[1].method).toBe('GET');
    expect(calls[1].headers.authorization).toBe('Bearer g-token');
  });

  it('projects a Drive file into a valid FileMetaProjection (NO path — Drive exposes none)', async () => {
    const { fetchImpl } = stubFetch([{ json: { startPageToken: 'T' } }, { json: { files: [gFile()] } }]);
    const leaf = buildGoogleFileSourceLeaf({ resolveConnection: resolverFor(gBearer()), fetchImpl });
    const out = await leaf(gRequest());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const projected = projectFileVendorRow(out.rows[0], GOOGLE);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.projection).toMatchObject({
      filename: 'report.pdf',
      remote_id: 'file-1',
      provider: 'google',
      mime_type: 'application/pdf',
      revision: '7', // Drive's monotonic version counter
      size: 2048, // '2048' string coerced to bytes
      owner: 'Ada Lovelace', // owners.0.displayName (array-index dot-path)
    });
    expect(projected.projection.path).toBeUndefined(); // omitted — Drive has no path
    expect(validateFileMetaProjection(projected.projection)).toEqual([]);
  });

  it('pages files.list to exhaustion via nextPageToken', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: { startPageToken: 'T' } },
      { json: { files: [gFile({ id: 'p1' })], nextPageToken: 'NP2' } },
      { json: { files: [gFile({ id: 'p2' })] } },
    ]);
    const leaf = buildGoogleFileSourceLeaf({ resolveConnection: resolverFor(gBearer()), fetchImpl });
    const out = await leaf(gRequest());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.complete).toBe(true);
    expect(out.rows.map((r) => r.id)).toEqual(['p1', 'p2']);
    expect(out.next_cursor).toBe('T');
    expect(calls).toHaveLength(3);
    expect(calls[2].url).toContain('pageToken=NP2'); // followed the nextPageToken
  });

  it('fail-closes (error) on a malformed files.list body (no files array — no false complete-empty walk)', async () => {
    const leaf = buildGoogleFileSourceLeaf({
      resolveConnection: resolverFor(gBearer()),
      fetchImpl: stubFetch([{ json: { startPageToken: 'T' } }, { json: {} }]).fetchImpl,
    });
    expect(await leaf(gRequest())).toMatchObject({ ok: false, kind: 'error' });
  });

  it('fail-closes complete:false when files.list reports incompleteSearch (partial set, no nextPageToken) — no false absence-delete', async () => {
    // Drive sets `incompleteSearch: true` (with NO nextPageToken) when it could
    // not fully execute the query — the one way files.list returns a partial set
    // without a pagination token. It must sink the completeness proof so the
    // runner's absence-delete diff never false-deletes the unsearched files.
    const { fetchImpl } = stubFetch([
      { json: { startPageToken: 'T' } },
      { json: { files: [gFile({ id: 'partial' })], incompleteSearch: true } },
    ]);
    const leaf = buildGoogleFileSourceLeaf({ resolveConnection: resolverFor(gBearer()), fetchImpl });
    const out = await leaf(gRequest());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.walk).toBe('full');
    expect(out.complete).toBe(false); // incompleteSearch sinks the completeness proof
    expect(out.rows.map((r) => r.id)).toEqual(['partial']); // what we DID see still upserts
    expect(out.next_cursor).toBe('T'); // the token is valid — the delta can still progress
  });

  it('a malformed startPageToken body is non-fatal: the walk proceeds, next_cursor null (re-full-walk next cycle)', async () => {
    const { fetchImpl } = stubFetch([
      { json: {} }, // no startPageToken
      { json: { files: [gFile({ id: 'x' })] } },
    ]);
    const leaf = buildGoogleFileSourceLeaf({ resolveConnection: resolverFor(gBearer()), fetchImpl });
    const out = await leaf(gRequest());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.walk).toBe('full');
    expect(out.complete).toBe(true);
    expect(out.rows.map((r) => r.id)).toEqual(['x']); // the list still lands
    expect(out.next_cursor).toBeNull(); // no token ⇒ next cycle full-walks
  });

  it('ignores import_scope in v1 (Drive has no path): returns scope null, pushes no filter down', async () => {
    const { fetchImpl, calls } = stubFetch([{ json: { startPageToken: 'T' } }, { json: { files: [] } }]);
    const leaf = buildGoogleFileSourceLeaf({
      resolveConnection: resolverFor(gBearer({ import_scope: 'Team/**' })),
      fetchImpl,
    });
    const out = await leaf(gRequest());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.scope).toBeNull(); // NOT honored — whole-Drive mirror in v1
    expect(calls[1].url).not.toContain('Team'); // no push-down
  });

  it('returns config when the connection is gone or carries no bearer token', async () => {
    const gone = buildGoogleFileSourceLeaf({ resolveConnection: resolverFor(null), fetchImpl: stubFetch([]).fetchImpl });
    expect(await gone(gRequest())).toMatchObject({ ok: false, kind: 'config' });
    const noToken = buildGoogleFileSourceLeaf({
      resolveConnection: resolverFor({ auth: { type: 'none' }, config: { vendor: 'google' } }),
      fetchImpl: stubFetch([]).fetchImpl,
    });
    expect(await noToken(gRequest())).toMatchObject({ ok: false, kind: 'config' });
  });

  it('converts a credential-resolution throw into an error outcome (never throws)', async () => {
    const leaf = buildGoogleFileSourceLeaf({ resolveConnection: throwingResolver, fetchImpl: stubFetch([]).fetchImpl });
    expect(await leaf(gRequest())).toMatchObject({ ok: false, kind: 'error' });
  });

  it('classifies 401 → config, 403 → policy, 500 → error (on the up-front token call)', async () => {
    const mk = (status: number): FileFetch => stubFetch([{ ok: false, status, text: '{"error":{"message":"x"}}' }]).fetchImpl;
    const leaf = (status: number) =>
      buildGoogleFileSourceLeaf({ resolveConnection: resolverFor(gBearer()), fetchImpl: mk(status) });
    expect(await leaf(401)(gRequest())).toMatchObject({ ok: false, kind: 'config' });
    expect(await leaf(403)(gRequest())).toMatchObject({ ok: false, kind: 'policy' });
    expect(await leaf(500)(gRequest())).toMatchObject({ ok: false, kind: 'error' });
  });

  // ── delta walk (a stored page token is passed) ───────────────────

  it('rides the stored page token on a delta walk: changes.list, upserts changes, SURFACES removed ids in removed_keys, walk:delta', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        json: {
          changes: [gChange(gFile({ id: 'f9', name: 'new.pdf' })), gRemoved('gone-id')],
          newStartPageToken: 'SPT-2',
        },
      },
    ]);
    const leaf = buildGoogleFileSourceLeaf({ resolveConnection: resolverFor(gBearer()), fetchImpl });
    const out = await leaf(gRequest('c1', 'SPT-PREV'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.walk).toBe('delta');
    expect(out.complete).toBe(false); // a delta is never delete-authoritative by ABSENCE
    expect(out.rows.map((r) => r.id)).toEqual(['f9']); // the file rides in `rows`
    expect(out.removed_keys).toEqual(['gone-id']); // the tombstone's fileId — direct key delete
    expect(out.next_cursor).toBe('SPT-2'); // watermark advanced
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`${G_CHANGES}?`);
    // D-192 hardening — the delta feed also spans shared drives.
    expect(calls[0].url).toContain('includeItemsFromAllDrives=true');
    expect(calls[0].url).toContain('supportsAllDrives=true');
    expect(calls[0].url).toContain('pageToken=SPT-PREV'); // rides the stored token
  });

  it('treats a TRASHED file (removed:false, file.trashed:true) as an ID-keyed removal', async () => {
    const { fetchImpl } = stubFetch([
      {
        json: {
          changes: [
            gChange(gFile({ id: 'keep' })),
            { changeType: 'file', removed: false, fileId: 'trash-id', file: gFile({ id: 'trash-id', trashed: true }) },
          ],
          newStartPageToken: 'S',
        },
      },
    ]);
    const leaf = buildGoogleFileSourceLeaf({ resolveConnection: resolverFor(gBearer()), fetchImpl });
    const out = await leaf(gRequest('c1', 'PREV'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows.map((r) => r.id)).toEqual(['keep']); // trashed file NOT upserted
    expect(out.removed_keys).toEqual(['trash-id']); // trashed = a removal
  });

  it('skips a drive-only change (no file) and a folder change (not a file)', async () => {
    const { fetchImpl } = stubFetch([
      {
        json: {
          changes: [
            { changeType: 'drive', removed: false, driveId: 'd1' }, // a shared-drive change — no file
            gChange(gFolder({ id: 'fld-x' })), // a folder change — skipped
            gChange(gFile({ id: 'real' })),
          ],
          newStartPageToken: 'S',
        },
      },
    ]);
    const leaf = buildGoogleFileSourceLeaf({ resolveConnection: resolverFor(gBearer()), fetchImpl });
    const out = await leaf(gRequest('c1', 'PREV'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows.map((r) => r.id)).toEqual(['real']);
    expect(out.removed_keys).toEqual([]);
  });

  it('pages a delta to exhaustion via nextPageToken, accumulating removed_keys across pages', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: { changes: [gChange(gFile({ id: 'd1' })), gRemoved('g1')], nextPageToken: 'CP2' } },
      { json: { changes: [gChange(gFile({ id: 'd2' })), gRemoved('g2')], newStartPageToken: 'SPT-3' } },
    ]);
    const leaf = buildGoogleFileSourceLeaf({ resolveConnection: resolverFor(gBearer()), fetchImpl });
    const out = await leaf(gRequest('c1', 'CP1'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows.map((r) => r.id)).toEqual(['d1', 'd2']);
    expect(out.removed_keys).toEqual(['g1', 'g2']); // both pages' tombstones accumulated
    expect(out.next_cursor).toBe('SPT-3');
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain('pageToken=CP2');
  });

  it('SUPPRESSES removed_keys + forces a full re-list when a delta cannot drain (terminal page: no tokens) — regression', async () => {
    // A malformed / proxy-corrupted terminal page: a tombstone, but NO
    // nextPageToken AND NO newStartPageToken. The undrained delta has NOT seen the
    // full change set, so trusting its tombstone could false-delete an
    // unidentified move destination on the unreached page. Suppress + force full.
    const { fetchImpl } = stubFetch([
      { json: { changes: [gChange(gFile({ id: 'stay' })), gRemoved('movedaway')] /* no tokens */ } },
    ]);
    const leaf = buildGoogleFileSourceLeaf({ resolveConnection: resolverFor(gBearer()), fetchImpl });
    const out = await leaf(gRequest('c1', 'STALE'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.walk).toBe('delta');
    expect(out.removed_keys).toEqual([]); // SUPPRESSED — undrained tombstones untrustworthy
    expect(out.next_cursor).toBeNull(); // force a full re-list next cycle
    expect(out.rows.map((r) => r.id)).toEqual(['stay']); // the upsert we DID see still lands
  });

  it('an invalidated page token (400 Invalid Value) transparently falls back to a full walk', async () => {
    const { fetchImpl, calls } = stubFetch([
      { ok: false, status: 400, text: '{"error":{"code":400,"message":"Invalid Value"}}' }, // stale-token changes.list
      { json: { startPageToken: 'FRESH' } }, // fallback: getStartPageToken
      { json: { files: [gFile({ id: 'z1' })] } }, // fallback: files.list
    ]);
    const leaf = buildGoogleFileSourceLeaf({ resolveConnection: resolverFor(gBearer()), fetchImpl });
    const out = await leaf(gRequest('c1', 'STALE-TOKEN'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.walk).toBe('full'); // recovered as a FULL walk THIS cycle
    expect(out.complete).toBe(true);
    expect(out.rows.map((r) => r.id)).toEqual(['z1']);
    expect(out.next_cursor).toBe('FRESH');
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toContain(`${G_CHANGES}?`); // the failed delta
    expect(calls[1].url).toBe(G_START); // fallback token
    expect(calls[2].url).toContain(`${G_FILES}?`); // fallback list
  });

  it('a 404 and a 410 on the delta also trigger the full fallback (token invalidations)', async () => {
    for (const status of [404, 410]) {
      const { fetchImpl } = stubFetch([
        { ok: false, status, text: '{"error":{"message":"page token expired"}}' },
        { json: { startPageToken: 'F' } },
        { json: { files: [gFile({ id: 'r' })] } },
      ]);
      const leaf = buildGoogleFileSourceLeaf({ resolveConnection: resolverFor(gBearer()), fetchImpl });
      expect(await leaf(gRequest('c1', 'STALE'))).toMatchObject({ ok: true, walk: 'full' });
    }
  });

  it('a 401/403 on a delta is classified (NOT a reset fallback) — real auth/permission issues', async () => {
    const leaf = (f: FileFetch) => buildGoogleFileSourceLeaf({ resolveConnection: resolverFor(gBearer()), fetchImpl: f });
    const c401 = stubFetch([{ ok: false, status: 401, text: '{"error":{"message":"x"}}' }]);
    expect(await leaf(c401.fetchImpl)(gRequest('c1', 'T'))).toMatchObject({ ok: false, kind: 'config' });
    expect(c401.calls).toHaveLength(1); // no fallback fired
    const c403 = stubFetch([{ ok: false, status: 403, text: '{"error":{"message":"x"}}' }]);
    expect(await leaf(c403.fetchImpl)(gRequest('c1', 'T'))).toMatchObject({ ok: false, kind: 'policy' });
    expect(c403.calls).toHaveLength(1);
  });

  it('a transient 500 on a delta is a retryable error, NOT a full fallback', async () => {
    const { fetchImpl, calls } = stubFetch([{ ok: false, status: 500, text: '{"error":{"message":"backend"}}' }]);
    const leaf = buildGoogleFileSourceLeaf({ resolveConnection: resolverFor(gBearer()), fetchImpl });
    expect(await leaf(gRequest('c1', 'SOME'))).toMatchObject({ ok: false, kind: 'error' });
    expect(calls).toHaveLength(1); // no fallback fired
  });

  it('a 429 rate-limit on a delta retries as error, NOT a full fallback (escalating would make MORE calls under throttling)', async () => {
    const { fetchImpl, calls } = stubFetch([{ ok: false, status: 429, text: '{"error":{"message":"Rate Limit Exceeded"}}' }]);
    const leaf = buildGoogleFileSourceLeaf({ resolveConnection: resolverFor(gBearer()), fetchImpl });
    expect(await leaf(gRequest('c1', 'SOME'))).toMatchObject({ ok: false, kind: 'error' });
    expect(calls).toHaveLength(1); // NOT a reset — the cursor holds, the delta replays next cycle
  });

  // ── last-occurrence-wins dedup (same as OneDrive) ────────────────

  it('collapses a repeated fileId to its LAST occurrence: change→removed removes it (not upserted)', async () => {
    const { fetchImpl } = stubFetch([
      { json: { changes: [gChange(gFile({ id: 'A' })), gRemoved('A')], newStartPageToken: 'S' } },
    ]);
    const leaf = buildGoogleFileSourceLeaf({ resolveConnection: resolverFor(gBearer()), fetchImpl });
    const out = await leaf(gRequest('c1', 'P'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows.map((r) => r.id)).toEqual([]); // NOT upserted
    expect(out.removed_keys).toEqual(['A']); // removed (last state wins)
  });

  it('collapses a repeated fileId to its LAST occurrence: removed→change keeps it (not removed)', async () => {
    const { fetchImpl } = stubFetch([
      { json: { changes: [gRemoved('B'), gChange(gFile({ id: 'B', name: 'b.pdf' }))], newStartPageToken: 'S' } },
    ]);
    const leaf = buildGoogleFileSourceLeaf({ resolveConnection: resolverFor(gBearer()), fetchImpl });
    const out = await leaf(gRequest('c1', 'P'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows.map((r) => r.id)).toEqual(['B']); // upserted (last state wins)
    expect(out.removed_keys).toEqual([]); // NOT removed
  });

  it('last-occurrence-wins holds ACROSS pages (change on page 1, removed on page 2 → removed)', async () => {
    const { fetchImpl } = stubFetch([
      { json: { changes: [gChange(gFile({ id: 'C' }))], nextPageToken: 'P2' } },
      { json: { changes: [gRemoved('C')], newStartPageToken: 'S' } },
    ]);
    const leaf = buildGoogleFileSourceLeaf({ resolveConnection: resolverFor(gBearer()), fetchImpl });
    const out = await leaf(gRequest('c1', 'P1'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows.map((r) => r.id)).toEqual([]); // the page-1 upsert is superseded
    expect(out.removed_keys).toEqual(['C']);
  });
});

// ────────────────────────────────────────────────────────────────
// Box (/2.0/events + folder-tree walk) — the third ID-keyed delta vendor
// ────────────────────────────────────────────────────────────────

const boxBearer = (configOver: Record<string, unknown> = {}): FileConnectionCredential => ({
  auth: { type: 'bearer', token: 'box-token' },
  config: { vendor: 'box', ...configOver },
});

/** A Box file item (a folder-walk entry OR an event source). */
const boxFile = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'file',
  id: 'file-1',
  name: 'report.pdf',
  size: 2048,
  modified_at: '2026-07-01T00:00:00-07:00',
  etag: '3',
  sha1: 'abc123',
  item_status: 'active',
  path_collection: { total_count: 1, entries: [{ type: 'folder', id: '0', name: 'All Files' }] },
  owned_by: { type: 'user', id: 'u1', name: 'Ada Lovelace' },
  ...over,
});

/** A Box folder item (drives recursion in the full walk; not a file). */
const boxFolder = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'folder',
  id: 'fld-1',
  name: 'Work',
  ...over,
});

/** A Box events entry wrapping an item change (default = an upsert). */
const boxEvent = (
  source: Record<string, unknown>,
  event_type = 'ITEM_UPLOAD',
): Record<string, unknown> => ({ type: 'event', event_id: 'e1', event_type, source });

/** A Box `ITEM_TRASH` event — the ID-keyed removal. */
const boxTrash = (fileId: string): Record<string, unknown> => ({
  type: 'event',
  event_id: 'e1',
  event_type: 'ITEM_TRASH',
  source: { type: 'file', id: fileId },
});

/** A Box `path_collection` from ancestor folder names (root "All Files" first). */
const boxPathCollection = (
  ...ancestors: Array<{ id: string; name: string }>
): Record<string, unknown> => ({
  total_count: ancestors.length + 1,
  entries: [{ type: 'folder', id: '0', name: 'All Files' }, ...ancestors.map((a) => ({ type: 'folder', ...a }))],
});

const boxRequest = (
  connection_name = 'c1',
  cursor: string | null = null,
): FileSourceListRequest => ({
  source_id: CONNECTION_SOURCE_ID('box', connection_name, 'file'),
  connection_name,
  vendor: 'box',
  declaration: BOX,
  cursor,
});

const B_FOLDERS = 'https://api.box.com/2.0/folders';
const B_EVENTS = 'https://api.box.com/2.0/events';

describe('buildBoxFileSourceLeaf', () => {
  // ── full walk (cursor:null ⇒ stream_position=now + folder-tree recursion) ──

  it('full-walks: stream_position=now THEN recurses the folder tree, keeps files, recurses folders, skips web_links, complete:true, watermark = the up-front position', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: { next_stream_position: 1001, entries: [] } }, // stream_position=now
      {
        json: {
          entries: [
            boxFile({ id: 'f1', name: 'a.pdf' }),
            boxFolder({ id: 'sub' }),
            { type: 'web_link', id: 'w1', name: 'link' }, // not a file — skipped
          ],
        },
      }, // folders/0/items
      { json: { entries: [boxFile({ id: 'f2', name: 'b.pdf' })] } }, // folders/sub/items
    ]);
    const leaf = buildBoxFileSourceLeaf({ resolveConnection: resolverFor(boxBearer()), fetchImpl });
    const out = await leaf(boxRequest());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.walk).toBe('full'); // cursor:null ⇒ full walk (delete authority)
    expect(out.complete).toBe(true); // whole tree drained without error
    expect(out.rows.map((r) => r.id).sort()).toEqual(['f1', 'f2']); // folder recursed, web_link dropped
    expect(out.removed_keys).toBeUndefined(); // a full walk owns removals by ABSENCE
    expect(out.next_cursor).toBe('1001'); // the up-front events position is the watermark
    expect(calls[0].url).toContain(`${B_EVENTS}?`);
    expect(calls[0].url).toContain('stream_position=now');
    expect(calls[0].headers.authorization).toBe('Bearer box-token');
    expect(calls[1].url).toContain(`${B_FOLDERS}/0/items`);
    expect(calls[2].url).toContain(`${B_FOLDERS}/sub/items`); // descended into the subfolder
  });

  it('projects a Box file into a valid FileMetaProjection (synthetic path from path_collection)', async () => {
    const { fetchImpl } = stubFetch([
      { json: { next_stream_position: 1000, entries: [] } },
      {
        json: {
          entries: [
            boxFile({
              id: 'file-1',
              name: 'report.pdf',
              path_collection: boxPathCollection({ id: '10', name: 'Work' }, { id: '11', name: '2026' }),
            }),
          ],
        },
      },
    ]);
    const leaf = buildBoxFileSourceLeaf({ resolveConnection: resolverFor(boxBearer()), fetchImpl });
    const out = await leaf(boxRequest());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const projected = projectFileVendorRow(out.rows[0], BOX);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.projection).toMatchObject({
      filename: 'report.pdf',
      remote_id: 'file-1',
      provider: 'box',
      path: '/Work/2026/report.pdf', // ancestors (minus the All Files root) + name
      size: 2048,
      revision: '3', // etag
      owner: 'Ada Lovelace', // owned_by.name
    });
    expect(projected.projection.mime_type).toBeUndefined(); // Box carries no mime type
    expect(validateFileMetaProjection(projected.projection)).toEqual([]);
  });

  it('synthesizes /-anchored paths (root-level + nested), and leaves path UNRESOLVED when path_collection is absent', async () => {
    const { fetchImpl } = stubFetch([
      { json: { next_stream_position: 1000, entries: [] } },
      {
        json: {
          entries: [
            boxFile({ id: 'r', name: 'root.pdf', path_collection: boxPathCollection() }),
            boxFile({ id: 'n', name: 'deep.pdf', path_collection: boxPathCollection({ id: '9', name: 'A' }, { id: '8', name: 'B' }) }),
            boxFile({ id: 'o', name: 'orphan.pdf', path_collection: undefined }), // no ancestors → unresolved
          ],
        },
      },
    ]);
    const leaf = buildBoxFileSourceLeaf({ resolveConnection: resolverFor(boxBearer()), fetchImpl });
    const out = await leaf(boxRequest());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const byId = new Map(out.rows.map((r) => [r.id, r.path]));
    expect(byId.get('r')).toBe('/root.pdf'); // only the root ancestor → /name
    expect(byId.get('n')).toBe('/A/B/deep.pdf');
    expect(byId.get('o')).toBeUndefined(); // NOT misfiled as '/orphan.pdf'
  });

  it('paginates a folder to exhaustion via next_marker', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: { next_stream_position: 1000, entries: [] } },
      { json: { entries: [boxFile({ id: 'p1' })], next_marker: 'M2' } },
      { json: { entries: [boxFile({ id: 'p2' })] } }, // no next_marker → folder drained
    ]);
    const leaf = buildBoxFileSourceLeaf({ resolveConnection: resolverFor(boxBearer()), fetchImpl });
    const out = await leaf(boxRequest());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.complete).toBe(true);
    expect(out.rows.map((r) => r.id)).toEqual(['p1', 'p2']);
    expect(calls[2].url).toContain('marker=M2'); // followed the next_marker
  });

  it('a benign 403/404 on a subfolder is SKIPPED + sinks complete (fail-closed — no absence-deletes)', async () => {
    const { fetchImpl } = stubFetch([
      { json: { next_stream_position: 1000, entries: [] } },
      { json: { entries: [boxFile({ id: 'f1' }), boxFolder({ id: 'locked' })] } }, // folders/0
      { ok: false, status: 403, text: '{"message":"Forbidden"}' }, // folders/locked → 403
    ]);
    const leaf = buildBoxFileSourceLeaf({ resolveConnection: resolverFor(boxBearer()), fetchImpl });
    const out = await leaf(boxRequest());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.walk).toBe('full');
    expect(out.complete).toBe(false); // the skipped subtree sinks completeness
    expect(out.rows.map((r) => r.id)).toEqual(['f1']); // the accessible file still lands
  });

  it('a hard error (500) mid-walk aborts the cycle (error), never a partial complete walk', async () => {
    const { fetchImpl } = stubFetch([
      { json: { next_stream_position: 1000, entries: [] } },
      { ok: false, status: 500, text: '{"message":"server"}' }, // folders/0 → 500
    ]);
    const leaf = buildBoxFileSourceLeaf({ resolveConnection: resolverFor(boxBearer()), fetchImpl });
    expect(await leaf(boxRequest())).toMatchObject({ ok: false, kind: 'error' });
  });

  it('fail-closes (error) on a malformed folder items body (no entries array)', async () => {
    const leaf = buildBoxFileSourceLeaf({
      resolveConnection: resolverFor(boxBearer()),
      fetchImpl: stubFetch([{ json: { next_stream_position: 1000, entries: [] } }, { json: {} }]).fetchImpl,
    });
    expect(await leaf(boxRequest())).toMatchObject({ ok: false, kind: 'error' });
  });

  it('config.folder_id bounds the full-walk root', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: { next_stream_position: 1000, entries: [] } },
      { json: { entries: [] } },
    ]);
    const leaf = buildBoxFileSourceLeaf({ resolveConnection: resolverFor(boxBearer({ folder_id: '99' })), fetchImpl });
    await leaf(boxRequest());
    expect(calls[1].url).toContain(`${B_FOLDERS}/99/items`);
  });

  it('returns an import_scope in the outcome (Box has a synthesized path → client-side glob)', async () => {
    const { fetchImpl } = stubFetch([
      { json: { next_stream_position: 1000, entries: [] } },
      { json: { entries: [] } },
    ]);
    const leaf = buildBoxFileSourceLeaf({
      resolveConnection: resolverFor(boxBearer({ import_scope: 'Work/**' })),
      fetchImpl,
    });
    const out = await leaf(boxRequest());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.scope).toEqual({ glob: 'Work/**', prefix: 'Work/' });
  });

  it('returns config when the connection is gone or carries no bearer token', async () => {
    const gone = buildBoxFileSourceLeaf({ resolveConnection: resolverFor(null), fetchImpl: stubFetch([]).fetchImpl });
    expect(await gone(boxRequest())).toMatchObject({ ok: false, kind: 'config' });
    const noToken = buildBoxFileSourceLeaf({
      resolveConnection: resolverFor({ auth: { type: 'none' }, config: { vendor: 'box' } }),
      fetchImpl: stubFetch([]).fetchImpl,
    });
    expect(await noToken(boxRequest())).toMatchObject({ ok: false, kind: 'config' });
  });

  it('converts a credential-resolution throw into an error outcome (never throws)', async () => {
    const leaf = buildBoxFileSourceLeaf({ resolveConnection: throwingResolver, fetchImpl: stubFetch([]).fetchImpl });
    expect(await leaf(boxRequest())).toMatchObject({ ok: false, kind: 'error' });
  });

  it('classifies 401 → config, 403 → policy, 500 → error (on the up-front events probe)', async () => {
    const mk = (status: number): FileFetch => stubFetch([{ ok: false, status, text: '{"message":"x"}' }]).fetchImpl;
    const leaf = (status: number) =>
      buildBoxFileSourceLeaf({ resolveConnection: resolverFor(boxBearer()), fetchImpl: mk(status) });
    expect(await leaf(401)(boxRequest())).toMatchObject({ ok: false, kind: 'config' });
    expect(await leaf(403)(boxRequest())).toMatchObject({ ok: false, kind: 'policy' });
    expect(await leaf(500)(boxRequest())).toMatchObject({ ok: false, kind: 'error' });
  });

  // ── delta walk (a stored stream position is passed) ──────────────

  it('rides the stored stream position: drains /2.0/events (poll until empty), upserts + removed_keys (ITEM_TRASH), walk:delta', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: { next_stream_position: 2000, entries: [boxEvent(boxFile({ id: 'f9', name: 'new.pdf' })), boxTrash('gone-id')] } },
      { json: { next_stream_position: 3000, entries: [] } }, // empty chunk = caught up
    ]);
    const leaf = buildBoxFileSourceLeaf({ resolveConnection: resolverFor(boxBearer()), fetchImpl });
    const out = await leaf(boxRequest('c1', '1900'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.walk).toBe('delta');
    expect(out.complete).toBe(false);
    expect(out.rows.map((r) => r.id)).toEqual(['f9']);
    expect(out.removed_keys).toEqual(['gone-id']); // the ITEM_TRASH source id
    expect(out.next_cursor).toBe('3000'); // the empty poll's position
    expect(calls[0].url).toContain('stream_position=1900'); // rides the stored position
    expect(calls[1].url).toContain('stream_position=2000'); // polled again from the non-empty page
  });

  it('treats a trashed item_status (not an ITEM_TRASH event) as a removal', async () => {
    const { fetchImpl } = stubFetch([
      {
        json: {
          next_stream_position: 2000,
          entries: [boxEvent(boxFile({ id: 'keep' })), boxEvent(boxFile({ id: 'trash-id', item_status: 'trashed' }), 'ITEM_MODIFY')],
        },
      },
      { json: { next_stream_position: 3000, entries: [] } },
    ]);
    const leaf = buildBoxFileSourceLeaf({ resolveConnection: resolverFor(boxBearer()), fetchImpl });
    const out = await leaf(boxRequest('c1', 'PREV'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows.map((r) => r.id)).toEqual(['keep']);
    expect(out.removed_keys).toEqual(['trash-id']); // trashed status = a removal
  });

  it('skips a folder-source event + a non-item (no file source) event', async () => {
    const { fetchImpl } = stubFetch([
      {
        json: {
          next_stream_position: 2000,
          entries: [
            boxEvent(boxFolder({ id: 'fld' }), 'ITEM_CREATE'), // folder source — skip (full walk owns folders)
            { type: 'event', event_id: 'x', event_type: 'COMMENT_CREATE', source: { type: 'comment', id: 'c1' } },
            boxEvent(boxFile({ id: 'real' })),
          ],
        },
      },
      { json: { next_stream_position: 3000, entries: [] } },
    ]);
    const leaf = buildBoxFileSourceLeaf({ resolveConnection: resolverFor(boxBearer()), fetchImpl });
    const out = await leaf(boxRequest('c1', 'PREV'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows.map((r) => r.id)).toEqual(['real']);
    expect(out.removed_keys).toEqual([]);
  });

  it('under a folder_id bound: an out-of-folder upsert is skipped; a removal rides through (harmless no-op if unmirrored)', async () => {
    const inFolder = boxFile({ id: 'in', path_collection: boxPathCollection({ id: '99', name: 'Scoped' }) });
    const outFolder = boxFile({ id: 'out', path_collection: boxPathCollection({ id: '50', name: 'Other' }) });
    const { fetchImpl } = stubFetch([
      { json: { next_stream_position: 2000, entries: [boxEvent(inFolder), boxEvent(outFolder), boxTrash('any-id')] } },
      { json: { next_stream_position: 3000, entries: [] } },
    ]);
    const leaf = buildBoxFileSourceLeaf({ resolveConnection: resolverFor(boxBearer({ folder_id: '99' })), fetchImpl });
    const out = await leaf(boxRequest('c1', 'PREV'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows.map((r) => r.id)).toEqual(['in']); // the out-of-folder upsert is skipped
    expect(out.removed_keys).toEqual(['any-id']); // the removal rides through
  });

  it('last-occurrence-wins: an upload then a trash of the same id → removed (not upserted)', async () => {
    const { fetchImpl } = stubFetch([
      { json: { next_stream_position: 2000, entries: [boxEvent(boxFile({ id: 'A' })), boxTrash('A')] } },
      { json: { next_stream_position: 3000, entries: [] } },
    ]);
    const leaf = buildBoxFileSourceLeaf({ resolveConnection: resolverFor(boxBearer()), fetchImpl });
    const out = await leaf(boxRequest('c1', 'PREV'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows.map((r) => r.id)).toEqual([]);
    expect(out.removed_keys).toEqual(['A']);
  });

  it('an invalidated stream position (400) transparently falls back to a full walk', async () => {
    const { fetchImpl, calls } = stubFetch([
      { ok: false, status: 400, text: '{"message":"Invalid Value"}' }, // the stale-position events poll
      { json: { next_stream_position: 4000, entries: [] } }, // fallback: stream_position=now
      { json: { entries: [boxFile({ id: 'z1' })] } }, // fallback: folders/0
    ]);
    const leaf = buildBoxFileSourceLeaf({ resolveConnection: resolverFor(boxBearer()), fetchImpl });
    const out = await leaf(boxRequest('c1', '1500'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.walk).toBe('full'); // recovered as a FULL walk THIS cycle
    expect(out.complete).toBe(true);
    expect(out.rows.map((r) => r.id)).toEqual(['z1']);
    expect(out.next_cursor).toBe('4000');
    expect(calls).toHaveLength(3);
  });

  it('a transient 500 on a delta is a retryable error, NOT a full fallback', async () => {
    const { fetchImpl, calls } = stubFetch([{ ok: false, status: 500, text: '{"message":"server"}' }]);
    const leaf = buildBoxFileSourceLeaf({ resolveConnection: resolverFor(boxBearer()), fetchImpl });
    expect(await leaf(boxRequest('c1', '1234'))).toMatchObject({ ok: false, kind: 'error' });
    expect(calls).toHaveLength(1); // no fallback fired
  });

  // ── fail-closed folds ────────────────────────────────────────────

  it('preserves a full-precision next_stream_position > 2^53 (Box positions overflow a double — read as a digit STRING, never via JSON.parse)', async () => {
    // 1152922976252290886 is past 2^53; JSON.parse would truncate it to ...290800.
    // The leaf must read it out of the RAW TEXT verbatim — both as the full-walk
    // watermark AND when the delta advances the cursor. (A `text` fixture carries
    // the exact digits; a JS-number fixture would itself be pre-truncated.)
    const big = '1152922976252290886';
    const bigger = '1152922976252291999';
    const full = buildBoxFileSourceLeaf({
      resolveConnection: resolverFor(boxBearer()),
      fetchImpl: stubFetch([
        { text: `{"chunk_size":0,"next_stream_position":${big},"entries":[]}` }, // stream_position=now
        { json: { entries: [boxFile({ id: 'x' })] } }, // folders/0
      ]).fetchImpl,
    });
    const outFull = await full(boxRequest());
    expect(outFull.ok).toBe(true);
    if (!outFull.ok) return;
    expect(outFull.next_cursor).toBe(big); // EXACT — not the double-rounded value

    const delta = buildBoxFileSourceLeaf({
      resolveConnection: resolverFor(boxBearer()),
      fetchImpl: stubFetch([{ text: `{"next_stream_position":${bigger},"entries":[]}` }]).fetchImpl,
    });
    const outDelta = await delta(boxRequest('c1', big));
    expect(outDelta.ok).toBe(true);
    if (!outDelta.ok) return;
    expect(outDelta.next_cursor).toBe(bigger); // EXACT terminal position
  });

  it('a folder entry with NO id sinks complete (fail-closed — an undescendable subtree is not delete-authoritative)', async () => {
    const { fetchImpl } = stubFetch([
      { json: { next_stream_position: 1000, entries: [] } },
      { json: { entries: [boxFile({ id: 'f1' }), { type: 'folder', name: 'Archive' /* no id */ }] } },
    ]);
    const leaf = buildBoxFileSourceLeaf({ resolveConnection: resolverFor(boxBearer()), fetchImpl });
    const out = await leaf(boxRequest());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.walk).toBe('full');
    expect(out.complete).toBe(false); // the id-less folder can't be descended → no absence-deletes
    expect(out.rows.map((r) => r.id)).toEqual(['f1']); // the accessible file still lands
  });
});

// ────────────────────────────────────────────────────────────────
// Resolver factory
// ────────────────────────────────────────────────────────────────

describe('buildFileSourceAdapterResolver', () => {
  it('resolves dropbox + s3 + onedrive + google + box + sharepoint + notion leaves and undefined for any other vendor', () => {
    const resolve = buildFileSourceAdapterResolver({
      resolveConnection: resolverFor(null),
      fetchImpl: stubFetch([]).fetchImpl,
    });
    expect(typeof resolve('dropbox')).toBe('function');
    expect(typeof resolve('s3')).toBe('function');
    expect(typeof resolve('onedrive')).toBe('function');
    expect(typeof resolve('google')).toBe('function');
    expect(typeof resolve('box')).toBe('function');
    expect(typeof resolve('sharepoint')).toBe('function'); // reuses the OneDrive Graph leaf
    expect(typeof resolve('notion')).toBe('function'); // the bespoke search → block-tree leaf
    expect(resolve('hubspot')).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// SharePoint — a document library IS a Graph drive, so the vendor
// reuses the OneDrive `/delta` leaf verbatim, resolved by the SAME
// production resolver map, targeted via the REQUIRED `config.drive_id`.
// These prove the reuse end-to-end: the drive-id start URL, the alias
// declaration flowing `provider: 'sharepoint'` through the real
// projector, and the vendor-label param flavoring outcomes.
// ────────────────────────────────────────────────────────────────

const SHAREPOINT = getFileVendorDeclaration('sharepoint') as FileVendorDeclaration;

const spBearer = (configOver: Record<string, unknown> = {}): FileConnectionCredential => ({
  auth: { type: 'bearer', token: 'sp-token' },
  // drive_id is REQUIRED for SharePoint — it points at the document library drive.
  config: { vendor: 'sharepoint', drive_id: 'b!lib', ...configOver },
});

const spRequest = (
  connection_name = 'sp1',
  cursor: string | null = null,
): FileSourceListRequest => ({
  source_id: CONNECTION_SOURCE_ID('sharepoint', connection_name, 'file'),
  connection_name,
  vendor: 'sharepoint',
  declaration: SHAREPOINT,
  cursor,
});

describe('SharePoint reuses the OneDrive Graph leaf (via the production resolver)', () => {
  it('full-walks /drives/{drive_id}/root/delta and projects with provider:sharepoint through the real projector', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        json: {
          value: [odItem()],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/drives/b!lib/root/delta?token=DL',
        },
      },
    ]);
    // Resolve the leaf the SAME way production does (the vendor→leaf map).
    const resolve = buildFileSourceAdapterResolver({
      resolveConnection: resolverFor(spBearer()),
      fetchImpl,
    });
    const leaf = resolve('sharepoint');
    expect(leaf).toBeDefined();
    const out = await leaf!(spRequest());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The required drive_id targets the document library drive — NOT /me/drive
    // (which is where a blank drive_id would wrongly send a SharePoint mirror).
    expect(calls[0].url).toBe('https://graph.microsoft.com/v1.0/drives/b!lib/root/delta');
    expect(out.walk).toBe('full');
    expect(out.complete).toBe(true);
    // The alias declaration flows through: provider is the SharePoint slug, not onedrive.
    const projected = projectFileVendorRow(out.rows[0], SHAREPOINT);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.projection).toMatchObject({
      filename: 'report.pdf',
      remote_id: 'itm-1',
      provider: 'sharepoint',
      mime_type: 'application/pdf',
    });
    expect(validateFileMetaProjection(projected.projection)).toEqual([]);
  });

  it('surfaces the sharepoint vendor label (not onedrive) in a no-token config outcome', async () => {
    const resolve = buildFileSourceAdapterResolver({
      resolveConnection: resolverFor({
        auth: { type: 'none' },
        config: { vendor: 'sharepoint', drive_id: 'b!lib' },
      }),
      fetchImpl: stubFetch([]).fetchImpl,
    });
    const out = await resolve('sharepoint')!(spRequest());
    expect(out).toMatchObject({ ok: false, kind: 'config' });
    if (out.ok) return;
    expect(out.reason).toContain('sharepoint');
    expect(out.reason).not.toContain('onedrive');
  });
});

// ────────────────────────────────────────────────────────────────
// Integration — the REAL google leaf drives the runner's delete
// ────────────────────────────────────────────────────────────────
//
// The leaf tests above assert the leaf's OUTPUT shape; the slice-4 runner tests
// assert the runner's delete logic over SYNTHETIC ids. This seam — the real
// `buildGoogleFileSourceLeaf` feeding a real `runFileSourceSync` + FileMetaStore
// — is the only place the load-bearing KEYING INVARIANT is proven end-to-end:
// that a delta's `removed_keys` value (`change.fileId`) equals the key the real
// projector stored the upsert under (`remote_id` = `file.id`), so the tombstone
// lands on the right row. Every leaf fixture sets `fileId === file.id` (as Drive
// guarantees), so without this test that equivalence is assumed, never exercised.

describe('buildGoogleFileSourceLeaf — runner integration (removed_keys deletes the projected row)', () => {
  const NOW = 1_700_000_000_000;
  const GSOURCE = CONNECTION_SOURCE_ID('google', 'gconn', 'file');
  let dir: string;
  let db: Database.Database;
  let store: FileMetaStore;
  let syncState: FileSourceSyncStateStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd192-google-int-'));
    db = new Database(join(dir, 'test.db'));
    ensureFileMetaSchema(db);
    store = createFileMetaStore(db);
    ensureFileSourceSyncStateSchema(db);
    syncState = createFileSourceSyncStateStore(db);
    syncState.upsert(initialFileSourceSyncState(GSOURCE));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('cycle 1 full-walk upserts a file; cycle 2 delta gRemoved deletes THAT mirror row (fileId ↔ remote_id proven through the real projector + runner)', async () => {
    // One leaf, one scripted fetch queue spanning BOTH cycles:
    //  cycle 1 (full):  getStartPageToken → 'SPT-1'; files.list → file 'X'.
    //  cycle 2 (delta): changes.list('SPT-1') → gRemoved('X') + a fresh watermark.
    const { fetchImpl } = stubFetch([
      { json: { startPageToken: 'SPT-1' } },
      { json: { files: [gFile({ id: 'X', name: 'keep.pdf' })] } },
      { json: { changes: [gRemoved('X')], newStartPageToken: 'SPT-2' } },
    ]);
    const leaf = buildGoogleFileSourceLeaf({ resolveConnection: resolverFor(gBearer()), fetchImpl });
    const run = () =>
      runFileSourceSync(
        { store, syncState, listFiles: leaf, now: () => NOW },
        { source_id: GSOURCE, connection_name: 'gconn', declaration: GOOGLE },
      );

    // Cycle 1 — a full walk that upserts X under the PROJECTED remote_id (=file.id).
    const c1 = await run();
    expect(c1).toMatchObject({ ok: true, walk: 'full', upserted: 1, deleted: 0 });
    expect(store.list(GSOURCE).map((r) => r.target_id)).toEqual(['X']);

    // Cycle 2 — same clock ⇒ !fullDue ⇒ the runner rides the stored 'SPT-1'
    // cursor for a DELTA walk; the leaf reports X removed → the runner tombstones
    // it directly by that id. If `removed_keys` and `remote_id` ever diverged,
    // the delete would miss and X would survive — this is the pin.
    const c2 = await run();
    expect(c2).toMatchObject({ ok: true, walk: 'delta', deleted: 1 });
    expect(store.list(GSOURCE)).toHaveLength(0); // X is gone
  });
});
