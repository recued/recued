/** D-192 remote byte-fetch (follow-on B) — SLICE 1: the byte-resolver port +
 *  orchestrator (`collections/file/remote-file-byte-resolver.ts`). Drives the
 *  bridge from a `file:remote:*` id → meta-store row → connection recovery →
 *  per-vendor dispatch → size ceiling, with a stubbed meta-store / connection
 *  resolver / vendor registry. No channel wiring yet (later slice). */

import { describe, expect, it } from 'vitest';
import { RpcError, type FileMetaProjection } from '@recued/contracts';

import {
  connectionNameFromSourceScope,
  resolveRemoteFileBytes,
  REMOTE_FILE_READ_MAX_BYTES,
  EMPTY_REMOTE_FILE_BYTE_RESOLVERS,
  type RemoteFileByteResolver,
  type RemoteFileByteResolverRegistry,
  type RemoteFileReadDeps,
} from '../collections/file/remote-file-byte-resolver.js';
import { remoteFileRecordId } from '../file-view-resolver.js';
import type { FileConnectionCredential, FileConnectionResolver } from '../file-source-adapters/index.js';
import type { FileMetaRow, FileMetaStore } from '../storage/file-meta-store.js';

// ── builders ─────────────────────────────────────────────────────
const meta = (over: Partial<FileMetaProjection> = {}): FileMetaProjection => ({
  filename: 'report.pdf',
  provider: 'notion',
  remote_id: 'block-1',
  ...over,
});
const metaRow = (scope: string, target_id: string, m: FileMetaProjection): FileMetaRow => ({
  scope,
  target_id,
  meta: { ...m, snapshot_hash: 'h', snapshot_at: 1 },
});
/** A meta-store stub — only `.get` is exercised. */
const metaStoreWith = (row: FileMetaRow | null): FileMetaStore =>
  ({ get: (scope: string, target_id: string) => (row && row.scope === scope && row.target_id === target_id ? row : null) }) as unknown as FileMetaStore;
const cred: FileConnectionCredential = { auth: { type: 'bearer', token: 't' } as never, config: {} };
const resolverOk: FileConnectionResolver = async () => cred;
const resolverGone: FileConnectionResolver = async () => null;

const deps = (over: Partial<RemoteFileReadDeps> & Pick<RemoteFileReadDeps, 'fileMetaStore'>): RemoteFileReadDeps => ({
  resolveConnection: resolverOk,
  byteResolvers: EMPTY_REMOTE_FILE_BYTE_RESOLVERS,
  ...over,
});

const catchCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    throw new Error('expected a throw');
  } catch (err) {
    if (err instanceof RpcError) return err.code;
    throw err;
  }
};

describe('connectionNameFromSourceScope', () => {
  it('strips the <provider>. prefix + .file suffix', () => {
    expect(connectionNameFromSourceScope('notion.myconn.file', 'notion')).toBe('myconn');
    expect(connectionNameFromSourceScope('s3.prod-bucket.file', 's3')).toBe('prod-bucket');
  });
  it('preserves dots in the connection name (strips fixed ends, does not split on .)', () => {
    expect(connectionNameFromSourceScope('s3.my.dotted.conn.file', 's3')).toBe('my.dotted.conn');
  });
  it('fails closed on a mismatched provider prefix, missing .file suffix, or empty name', () => {
    expect(connectionNameFromSourceScope('dropbox.conn.file', 'notion')).toBeNull(); // wrong provider
    expect(connectionNameFromSourceScope('notion.conn.task', 'notion')).toBeNull();  // not a .file scope
    expect(connectionNameFromSourceScope('notion..file', 'notion')).toBeNull();      // empty name
  });
});

describe('resolveRemoteFileBytes — failure routing', () => {
  const scope = 'notion.myconn.file';
  const id = remoteFileRecordId(scope, 'block-1');

  it('a non-remote (CAS / junk) id → bad_request', async () => {
    const d = deps({ fileMetaStore: metaStoreWith(null) });
    expect(await catchCode(resolveRemoteFileBytes(d, 'file:deadbeef'))).toBe('bad_request');
  });

  it('a remote id with no meta-store row → file_not_found', async () => {
    const d = deps({ fileMetaStore: metaStoreWith(null) });
    expect(await catchCode(resolveRemoteFileBytes(d, id))).toBe('file_not_found');
  });

  it('a scope that cannot recover a connection → file_storage_missing', async () => {
    // The row's provider (dropbox) disagrees with the scope's prefix (notion) → strip fails.
    const badScope = 'notion.myconn.file';
    const row = metaRow(badScope, 'block-1', meta({ provider: 'dropbox' }));
    const d = deps({ fileMetaStore: metaStoreWith(row) });
    expect(await catchCode(resolveRemoteFileBytes(d, remoteFileRecordId(badScope, 'block-1')))).toBe('file_storage_missing');
  });

  it('a gone connection (resolver returns null) → file_storage_missing', async () => {
    const d = deps({ fileMetaStore: metaStoreWith(metaRow(scope, 'block-1', meta())), resolveConnection: resolverGone });
    expect(await catchCode(resolveRemoteFileBytes(d, id))).toBe('file_storage_missing');
  });

  it('no resolver for the provider (empty registry) → remote_provider_unsupported', async () => {
    const d = deps({ fileMetaStore: metaStoreWith(metaRow(scope, 'block-1', meta())) });
    expect(await catchCode(resolveRemoteFileBytes(d, id))).toBe('remote_provider_unsupported');
  });
});

describe('resolveRemoteFileBytes — dispatch + size ceiling', () => {
  const scope = 'notion.myconn.file';
  const id = remoteFileRecordId(scope, 'block-1');
  const registry = (fn: RemoteFileByteResolver): RemoteFileByteResolverRegistry => ({ notion: fn });

  it('happy path — dispatches to the provider resolver, returns bytes + resolved mime/filename', async () => {
    let seen: unknown;
    const fn: RemoteFileByteResolver = async (req) => {
      seen = req;
      return { bytes: Buffer.from('hello'), mime_type: 'application/pdf' };
    };
    const d = deps({ fileMetaStore: metaStoreWith(metaRow(scope, 'block-1', meta({ filename: 'r.pdf' }))), byteResolvers: registry(fn) });
    const out = await resolveRemoteFileBytes(d, id);
    expect(out).toEqual({ bytes: Buffer.from('hello'), mime_type: 'application/pdf', filename: 'r.pdf', size_bytes: 5 });
    // The resolver got the recovered credential + the vendor locator + the ceiling.
    expect(seen).toMatchObject({ cred, remote_id: 'block-1', maxBytes: REMOTE_FILE_READ_MAX_BYTES });
  });

  it('falls back to meta mime/filename, then to octet-stream/"file"', async () => {
    const bytesOnly: RemoteFileByteResolver = async () => ({ bytes: Buffer.from('x') });
    // meta carries mime + filename → used
    const withMeta = deps({ fileMetaStore: metaStoreWith(metaRow(scope, 'block-1', meta({ filename: 'a.txt', mime_type: 'text/plain' }))), byteResolvers: registry(bytesOnly) });
    expect(await resolveRemoteFileBytes(withMeta, id)).toMatchObject({ mime_type: 'text/plain', filename: 'a.txt' });
    // meta carries neither → hard defaults
    const bare = deps({ fileMetaStore: metaStoreWith(metaRow(scope, 'block-1', { filename: 'z', provider: 'notion', remote_id: 'block-1' })), byteResolvers: registry(bytesOnly) });
    const out = await resolveRemoteFileBytes(bare, id);
    expect(out.mime_type).toBe('application/octet-stream');
    expect(out.filename).toBe('z');
  });

  it('preflights the vendor-reported size BEFORE fetching → remote_too_large, resolver never called', async () => {
    let called = false;
    const fn: RemoteFileByteResolver = async () => { called = true; return { bytes: Buffer.from('x') }; };
    const d = deps({
      fileMetaStore: metaStoreWith(metaRow(scope, 'block-1', meta({ size: REMOTE_FILE_READ_MAX_BYTES + 1 }))),
      byteResolvers: registry(fn),
      maxBytes: REMOTE_FILE_READ_MAX_BYTES,
    });
    expect(await catchCode(resolveRemoteFileBytes(d, id))).toBe('remote_too_large');
    expect(called).toBe(false);
  });

  it('hard-stops on the ACTUAL fetched length when the vendor reports no size (Notion)', async () => {
    const fn: RemoteFileByteResolver = async () => ({ bytes: Buffer.alloc(11) });
    const d = deps({ fileMetaStore: metaStoreWith(metaRow(scope, 'block-1', meta())), byteResolvers: registry(fn), maxBytes: 10 });
    expect(await catchCode(resolveRemoteFileBytes(d, id))).toBe('remote_too_large');
  });

  it('a resolver generic throw → remote_fetch_failed; a resolver RpcError propagates as-is', async () => {
    const boom: RemoteFileByteResolver = async () => { throw new Error('network down'); };
    const dBoom = deps({ fileMetaStore: metaStoreWith(metaRow(scope, 'block-1', meta())), byteResolvers: registry(boom) });
    expect(await catchCode(resolveRemoteFileBytes(dBoom, id))).toBe('remote_fetch_failed');

    const unresolvable: RemoteFileByteResolver = async () => {
      throw new RpcError('remote_unresolvable', 'no re-fetchable id', 501);
    };
    const dUn = deps({ fileMetaStore: metaStoreWith(metaRow(scope, 'block-1', meta())), byteResolvers: registry(unresolvable) });
    expect(await catchCode(resolveRemoteFileBytes(dUn, id))).toBe('remote_unresolvable');
  });
});
