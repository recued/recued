/** v3 `repo` field — pack-manifest validation.
 *
 *  The author's source repo URL (https-only) entered in the marketplace
 *  publish flow; issues / support route there. Optional; when present
 *  the parser gates the scheme and carries the value through to the
 *  typed manifest.
 */

import { describe, expect, it } from 'vitest';
import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
  isHttpsRepoUrl,
  parseBulkPackManifest,
  type BulkPackManifest,
} from '../index.js';

const validPack = (overrides: Partial<BulkPackManifest> = {}): unknown => ({
  manifest_version: BULK_INSTALL_PACK_VERSION,
  slug: 'personal-crm-foundation',
  publisher: 'recued-core',
  name: 'Personal CRM Foundation',
  description: 'Ten foundational extraction recipes.',
  version: 1,
  recipes: [{ slug: 'extract-contact-from-mail', version: 1 }],
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: ['pack:personal-crm'],
  ...overrides,
});

describe('v3 — isHttpsRepoUrl', () => {
  it('accepts an https URL', () => {
    expect(isHttpsRepoUrl('https://github.com/recued/example')).toBe(true);
  });

  it('rejects http, non-URL strings, empty strings, and non-strings', () => {
    expect(isHttpsRepoUrl('http://github.com/recued/example')).toBe(false);
    expect(isHttpsRepoUrl('github.com/recued/example')).toBe(false);
    expect(isHttpsRepoUrl('')).toBe(false);
    expect(isHttpsRepoUrl(42)).toBe(false);
    expect(isHttpsRepoUrl(null)).toBe(false);
  });

  it('rejects parser-normalized forms the renderers would refuse', () => {
    expect(isHttpsRepoUrl(' https://github.com/recued/example')).toBe(false);
    expect(isHttpsRepoUrl('HTTPS://github.com/recued/example')).toBe(false);
    expect(isHttpsRepoUrl('https:example.com')).toBe(false);
  });
});

describe('v3 — pack manifest `repo`', () => {
  it('is optional — manifests without it stay valid', () => {
    const result = parseBulkPackManifest(validPack());
    expect(result.ok).toBe(true);
  });

  it('carries a valid https repo through to the typed manifest', () => {
    const result = parseBulkPackManifest(
      validPack({ repo: 'https://github.com/recued/personal-crm' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.repo).toBe('https://github.com/recued/personal-crm');
    }
  });

  it('rejects a non-https repo with pack_repo_invalid', () => {
    const result = parseBulkPackManifest(
      validPack({ repo: 'http://github.com/recued/personal-crm' }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === 'pack_repo_invalid')).toBe(true);
  });

  it('rejects a non-string repo with pack_repo_invalid', () => {
    const result = parseBulkPackManifest(
      validPack({ repo: 42 as unknown as string }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === 'pack_repo_invalid')).toBe(true);
  });
});
