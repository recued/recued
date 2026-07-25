import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { generateKeypair } from '@recued/release';
import { buildReleaseCheckDeps } from '../update/release-config.js';

// D-178 S3 — buildReleaseCheckDeps must fail closed on a malformed pinned key.
describe('buildReleaseCheckDeps key guard', () => {
  const make = (trustedPubkey: string) =>
    buildReleaseCheckDeps({
      db: new Database(':memory:'),
      currentVersion: '1.0.0',
      trustedPubkey,
      env: {},
    });

  it('accepts an empty pin (pre-GA — verifiers short-circuit to not-configured)', () => {
    expect(() => make('')).not.toThrow();
  });

  it('accepts a well-formed pinned key', () => {
    expect(() => make(generateKeypair().publicKeyText)).not.toThrow();
  });

  it('throws on a non-empty malformed pin rather than booting a half-trusted updater', () => {
    expect(() => make('this-is-not-a-minisign-key')).toThrow();
  });
});
