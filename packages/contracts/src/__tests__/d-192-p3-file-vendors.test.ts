/** D-192 slice 3 — the FileVendorDeclaration registry (contracts, pure).
 *
 *  Mirrors the messenger-vendors test: enum vocab, the shipped Dropbox + S3
 *  entries + their facts, the fail-closed per-entry validator (incl. the
 *  list mode<->cursor invariant), the throwing builder, the cross-entry
 *  dup-vendor guard, and the accessors. Boot self-validation is implicit —
 *  importing the module runs it; a bad registry would throw at load.
 */

import { describe, expect, it } from 'vitest';

import {
  FILE_AUTH_KINDS,
  FILE_CURSOR_KINDS,
  FILE_LIST_MODES,
  FILE_VENDOR_DECLARATIONS,
  assertFileVendorDeclarationShape,
  assertFileVendorRegistry,
  buildFileVendorDeclaration,
  getFileVendorDeclaration,
  isDeclaredFileVendor,
  listFileVendors,
  type FileVendorDeclaration,
} from '../index.js';

const valid = (): FileVendorDeclaration => ({
  vendor: 'dropbox',
  display_name: 'Dropbox',
  list: { mode: 'full_then_delta', cursor_kind: 'cursor' },
  projection: { filename: 'name', remote_id: 'id', path: 'path_display' },
  scope: { supports_prefix: true },
  auth: 'oauth',
});

describe('D-192 P3 — controlled vocabulary', () => {
  it('enumerates the closed enums', () => {
    expect([...FILE_LIST_MODES]).toEqual(['full', 'full_then_delta']);
    expect([...FILE_CURSOR_KINDS]).toEqual(['none', 'cursor', 'delta_link', 'page_token', 'stream_position']);
    expect([...FILE_AUTH_KINDS]).toEqual(['oauth', 'connection', 'access_key']);
  });
});

describe('D-192 P3 — the shipped registry', () => {
  it('is self-consistent (no cross-entry issues) and lists dropbox + s3 + onedrive + google + box + sharepoint + notion', () => {
    expect(assertFileVendorRegistry(FILE_VENDOR_DECLARATIONS)).toEqual([]);
    expect([...listFileVendors()]).toEqual(['dropbox', 's3', 'onedrive', 'google', 'box', 'sharepoint', 'notion']);
  });

  it('accessors resolve declared vendors and reject undeclared', () => {
    expect(getFileVendorDeclaration('dropbox')?.display_name).toBe('Dropbox');
    expect(getFileVendorDeclaration('s3')?.display_name).toBe('Amazon S3');
    expect(getFileVendorDeclaration('onedrive')?.display_name).toBe('OneDrive');
    expect(getFileVendorDeclaration('google')?.display_name).toBe('Google Drive');
    expect(getFileVendorDeclaration('box')?.display_name).toBe('Box');
    expect(getFileVendorDeclaration('sharepoint')?.display_name).toBe('SharePoint');
    expect(getFileVendorDeclaration('nope')).toBeNull();
    expect(isDeclaredFileVendor('s3')).toBe(true);
    expect(isDeclaredFileVendor('onedrive')).toBe(true);
    expect(isDeclaredFileVendor('google')).toBe(true);
    expect(isDeclaredFileVendor('box')).toBe(true);
    expect(isDeclaredFileVendor('sharepoint')).toBe(true);
    expect(isDeclaredFileVendor('nope')).toBe(false);
    expect(isDeclaredFileVendor(42)).toBe(false);
  });

  it('onedrive is a full_then_delta / delta_link (ID-keyed) vendor with a synthesized path', () => {
    const od = getFileVendorDeclaration('onedrive');
    expect(od?.list).toEqual({ mode: 'full_then_delta', cursor_kind: 'delta_link' });
    expect(od?.auth).toBe('oauth');
    expect(od?.scope.supports_prefix).toBe(false); // /delta is whole-drive; client-side glob only
    expect(od?.projection).toMatchObject({ filename: 'name', remote_id: 'id', path: 'path' });
  });

  it('google is a full_then_delta / page_token (ID-keyed) vendor with NO native path', () => {
    const g = getFileVendorDeclaration('google');
    expect(g?.list).toEqual({ mode: 'full_then_delta', cursor_kind: 'page_token' });
    expect(g?.auth).toBe('oauth');
    expect(g?.scope.supports_prefix).toBe(false); // changes.list is account-wide; no push-down
    expect(g?.projection).toMatchObject({
      filename: 'name',
      remote_id: 'id',
      mime_type: 'mimeType',
      mtime: 'modifiedTime',
      revision: 'version',
    });
    // Drive exposes no path (only parents[]) — omitted, NOT synthesized (the
    // distinguishing fact of the Google leaf).
    expect(g?.projection.path).toBeUndefined();
  });

  it('box is a full_then_delta / stream_position (ID-keyed) vendor with a synthesized path + no mime', () => {
    const b = getFileVendorDeclaration('box');
    expect(b?.list).toEqual({ mode: 'full_then_delta', cursor_kind: 'stream_position' });
    expect(b?.auth).toBe('oauth');
    expect(b?.scope.supports_prefix).toBe(false); // Box scopes by folder id, not a path prefix
    expect(b?.projection).toMatchObject({
      filename: 'name',
      remote_id: 'id',
      path: 'path', // synthesized from path_collection by the leaf
      mtime: 'modified_at',
      revision: 'etag',
      owner: 'owned_by.name',
    });
    expect(b?.projection.mime_type).toBeUndefined(); // Box file object carries no mime type
  });

  it('sharepoint is a declaration ALIAS of onedrive (a document library IS a Graph drive)', () => {
    const sp = getFileVendorDeclaration('sharepoint');
    const od = getFileVendorDeclaration('onedrive');
    expect(sp?.display_name).toBe('SharePoint');
    // The whole point of the alias: same Graph `/delta` list mode + cursor, same
    // driveItem projection, same whole-drive scope, same oauth — everything but
    // the vendor slug + display_name matches OneDrive verbatim (so it rides the
    // exact same adapter leaf, keyed by config.drive_id).
    expect(sp?.list).toEqual(od?.list);
    expect(sp?.list).toEqual({ mode: 'full_then_delta', cursor_kind: 'delta_link' });
    expect(sp?.projection).toEqual(od?.projection);
    expect(sp?.scope).toEqual(od?.scope);
    expect(sp?.scope.supports_prefix).toBe(false);
    expect(sp?.auth).toBe('oauth');
  });

  it('captures the real per-vendor variance (Dropbox delta cursor; S3 full re-list, no mime)', () => {
    const dropbox = getFileVendorDeclaration('dropbox');
    expect(dropbox?.list).toEqual({ mode: 'full_then_delta', cursor_kind: 'cursor' });
    expect(dropbox?.projection.revision).toBe('rev');
    expect(dropbox?.projection.mime_type).toBeUndefined();
    expect(dropbox?.auth).toBe('oauth');

    const s3 = getFileVendorDeclaration('s3');
    expect(s3?.list).toEqual({ mode: 'full', cursor_kind: 'none' });
    expect(s3?.projection.mime_type).toBeUndefined(); // ListObjectsV2 has no ContentType
    expect(s3?.projection.mtime).toBe('LastModified');
    expect(s3?.auth).toBe('access_key');
    expect(s3?.scope.supports_prefix).toBe(true);
  });
});

describe('D-192 P3 — per-entry validator (fail-closed)', () => {
  it('accepts a well-formed entry', () => {
    expect(assertFileVendorDeclarationShape(valid())).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(assertFileVendorDeclarationShape(null)).toEqual(['expected object']);
    expect(assertFileVendorDeclarationShape('x')).toEqual(['expected object']);
    expect(assertFileVendorDeclarationShape([])).toEqual(['expected object']);
  });

  const bad: Array<[string, (d: Record<string, unknown>) => void]> = [
    ['bad vendor slug (uppercase)', (d) => { d.vendor = 'Dropbox'; }],
    ['empty vendor', (d) => { d.vendor = ''; }],
    ['empty display_name', (d) => { d.display_name = ''; }],
    ['bad list.mode', (d) => { (d.list as Record<string, unknown>).mode = 'bogus'; }],
    ['bad list.cursor_kind', (d) => { (d.list as Record<string, unknown>).cursor_kind = 'bogus'; }],
    ['full mode with a non-none cursor', (d) => { d.list = { mode: 'full', cursor_kind: 'cursor' }; }],
    ['delta mode with a none cursor', (d) => { d.list = { mode: 'full_then_delta', cursor_kind: 'none' }; }],
    ['missing projection.filename', (d) => { delete (d.projection as Record<string, unknown>).filename; }],
    ['missing projection.remote_id', (d) => { delete (d.projection as Record<string, unknown>).remote_id; }],
    ['empty projection.filename', (d) => { (d.projection as Record<string, unknown>).filename = ''; }],
    ['non-string projection.path', (d) => { (d.projection as Record<string, unknown>).path = 5; }],
    ['empty optional projection field', (d) => { (d.projection as Record<string, unknown>).mtime = ''; }],
    ['non-boolean scope.supports_prefix', (d) => { (d.scope as Record<string, unknown>).supports_prefix = 'yes'; }],
    ['bad auth', (d) => { d.auth = 'password'; }],
    ['list not an object', (d) => { d.list = 'full'; }],
    ['projection not an object', (d) => { d.projection = null; }],
    ['scope not an object', (d) => { d.scope = []; }],
  ];

  for (const [name, mutate] of bad) {
    it(`rejects: ${name}`, () => {
      const d = valid() as unknown as Record<string, unknown>;
      // deep-clone the nested facets so a mutation does not leak across cases
      d.list = { ...(d.list as object) };
      d.projection = { ...(d.projection as object) };
      d.scope = { ...(d.scope as object) };
      mutate(d);
      expect(assertFileVendorDeclarationShape(d).length).toBeGreaterThan(0);
    });
  }

  it('buildFileVendorDeclaration throws on an invalid entry', () => {
    expect(() => buildFileVendorDeclaration({ ...valid(), auth: 'password' } as unknown as FileVendorDeclaration))
      .toThrow(/invalid FileVendorDeclaration/);
  });

  it('assertFileVendorRegistry catches a duplicate vendor slug', () => {
    const dup = assertFileVendorRegistry([valid(), valid()]);
    expect(dup.some((i) => i.includes('duplicate vendor'))).toBe(true);
  });
});
