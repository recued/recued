import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadAttestedWebclientBundle } from '../../scripts/release-webclient-attestation.mjs';

const roots: string[] = [];
const revision = 'a'.repeat(40);
const fixture = (overrides: Record<string, unknown> = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'release-webclient-attestation-'));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  const bytes = Buffer.from('<title>release</title>');
  writeFileSync(join(root, 'index.html'), bytes);
  writeFileSync(join(root, 'webclient-bundle-manifest.json'), `${JSON.stringify({
    build: {
      schema: 1,
      source_revision: revision,
      source_dirty: false,
      cloud_apex: 'recued.com',
      minified: true,
      ...overrides,
    },
    files: [{
      path: 'index.html',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }],
  })}\n`);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('release webclient attestation', () => {
  it('accepts exact clean production bytes', () => {
    const loaded = loadAttestedWebclientBundle({
      buildDir: fixture(),
      expectedSourceRevision: revision,
    });
    expect(loaded.archiveFiles.map((file) => file.path)).toEqual([
      'webclient-bundle-manifest.json',
      'index.html',
    ]);
  });

  it.each([
    ['stale source', { source_revision: 'b'.repeat(40) }],
    ['dirty source', { source_dirty: true }],
    ['wrong apex', { cloud_apex: 'recued2.com' }],
    ['unminified build', { minified: false }],
  ])('rejects %s provenance', (_label, overrides) => {
    expect(() => loadAttestedWebclientBundle({
      buildDir: fixture(overrides),
      expectedSourceRevision: revision,
    })).toThrow(/build attestation does not match/);
  });

  it('rejects an inner hash mismatch before custody signing', () => {
    const root = fixture();
    writeFileSync(join(root, 'index.html'), 'changed after manifest emission');
    expect(() => loadAttestedWebclientBundle({
      buildDir: root,
      expectedSourceRevision: revision,
    })).toThrow(/inner integrity verification failed/);
  });
});
