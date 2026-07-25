/** D-128 Phase 1 — Platform-reference enrichment substrate (contracts surface).
 *
 *  Type-level: `EnrichmentScope` widens to include the four-segment
 *  `connection.api.<vendor>.<entity>` template-literal shape. Helpers:
 *  `composeVendorEntityScope` / `parseVendorEntityScope` /
 *  `isPlatformReferenceScope` round-trip the shape; `isEnrichmentScope`
 *  recognises both the closed-list family and the open four-segment
 *  family.
 *
 *  Substrate: `EnrichmentMeta` carries the canonical-fields snapshot
 *  for platform-resident records; `serializeEnrichmentMeta` enforces
 *  the 8 KB cap; `deserializeEnrichmentMeta` is null-safe across the
 *  pre-D-128 + post-D-128 column states.
 *
 *  Storage round-trips live in
 *  `backend/server/src/__tests__/d-128-phase-1-store.test.ts`. */

import { describe, expect, it } from 'vitest';

import {
  ALL_ENRICHMENT_SCOPES,
  composeEnrichmentScope,
  composeVendorEntityScope,
  isEnrichmentScope,
  isPlatformReferenceScope,
  parseVendorEntityScope,
  PLATFORM_REFERENCE_META_MAX_BYTES,
  PLATFORM_REFERENCE_DEFAULT_CADENCE,
  PLATFORM_REFERENCE_BATCH_SIZE,
  PLATFORM_REFERENCE_DELETE_DETECT_CADENCE,
  PLATFORM_REFERENCE_WEBHOOK_REPLAY_WINDOW_MS,
  MetaSnapshotTooLargeError,
  assertEnrichmentMetaShape,
  serializeEnrichmentMeta,
  deserializeEnrichmentMeta,
  type EnrichmentMeta,
  type EnrichmentScope,
} from '../index.js';

// ────────────────────────────────────────────────────────────────
// Scope shape + helpers
// ────────────────────────────────────────────────────────────────

describe('D-128 P1 — EnrichmentScope four-segment shape', () => {
  it('keeps the closed-list scopes recognised by isEnrichmentScope', () => {
    for (const s of ALL_ENRICHMENT_SCOPES) {
      expect(isEnrichmentScope(s)).toBe(true);
      expect(isPlatformReferenceScope(s)).toBe(false);
    }
  });

  it('recognises four-segment connection.api.<vendor>.<entity> as a valid scope', () => {
    const scope = 'connection.api.hubspot.deal';
    expect(isEnrichmentScope(scope)).toBe(true);
    expect(isPlatformReferenceScope(scope)).toBe(true);
  });

  it('rejects malformed platform-reference shapes', () => {
    expect(isPlatformReferenceScope('connection.api.hubspot')).toBe(false); // 3 segments
    expect(isPlatformReferenceScope('connection.api.hubspot.deal.extra')).toBe(false); // 5 segments
    expect(isPlatformReferenceScope('connection.api.HubSpot.deal')).toBe(false); // uppercase
    expect(isPlatformReferenceScope('connection.api.hubspot.Deal')).toBe(false); // uppercase
    expect(isPlatformReferenceScope('connection.api.1hubspot.deal')).toBe(false); // leading digit
    expect(isPlatformReferenceScope('connection.api.hubspot.1deal')).toBe(false);
    expect(isPlatformReferenceScope('connection.api..deal')).toBe(false);
    expect(isPlatformReferenceScope('connection.api.hubspot.')).toBe(false);
    expect(isPlatformReferenceScope('connection.notification.hubspot.deal')).toBe(false); // wrong kind
    expect(isPlatformReferenceScope('mail.foo.bar')).toBe(false);
  });

  it('isEnrichmentScope excludes shape-invalid four-segment strings', () => {
    expect(isEnrichmentScope('connection.api.HubSpot.deal')).toBe(false);
    expect(isEnrichmentScope('connection.api.hubspot..deal')).toBe(false);
    expect(isEnrichmentScope('not-a-scope')).toBe(false);
  });
});

describe('D-128 P1 — composeVendorEntityScope', () => {
  it('round-trips with parseVendorEntityScope', () => {
    const scope = composeVendorEntityScope('hubspot', 'deal');
    expect(scope).toBe('connection.api.hubspot.deal' satisfies EnrichmentScope);
    expect(parseVendorEntityScope(scope)).toEqual({ vendor: 'hubspot', entity: 'deal' });
  });

  it('accepts identifiers with digits + underscores after the leading letter', () => {
    expect(composeVendorEntityScope('linear_v2', 'issue_3')).toBe(
      'connection.api.linear_v2.issue_3',
    );
  });

  it('throws on uppercase, leading digits, hyphens, dots, or empty inputs', () => {
    expect(() => composeVendorEntityScope('HubSpot', 'deal')).toThrow(/vendor must match/);
    expect(() => composeVendorEntityScope('hubspot', 'Deal')).toThrow(/entity must match/);
    expect(() => composeVendorEntityScope('1hubspot', 'deal')).toThrow(/vendor must match/);
    expect(() => composeVendorEntityScope('hubspot', '1deal')).toThrow(/entity must match/);
    expect(() => composeVendorEntityScope('hub-spot', 'deal')).toThrow(/vendor must match/);
    expect(() => composeVendorEntityScope('hub.spot', 'deal')).toThrow(/vendor must match/);
    expect(() => composeVendorEntityScope('', 'deal')).toThrow(/vendor must match/);
    expect(() => composeVendorEntityScope('hubspot', '')).toThrow(/entity must match/);
  });

  it('parseVendorEntityScope returns null for closed-list + malformed scopes', () => {
    expect(parseVendorEntityScope('mail')).toBeNull();
    expect(parseVendorEntityScope('connection.api')).toBeNull();
    expect(parseVendorEntityScope('connection.api.hubspot')).toBeNull();
    expect(parseVendorEntityScope('connection.api.HubSpot.deal')).toBeNull();
    expect(parseVendorEntityScope('not.a.scope.at.all')).toBeNull();
  });
});

describe('D-128 P1 — composeEnrichmentScope still gates the closed list', () => {
  it('throws on a four-segment composition through the closed-list helper', () => {
    // Authors of platform-reference scopes must use composeVendorEntityScope.
    expect(() => composeEnrichmentScope('connection', 'api.hubspot.deal')).toThrow(
      /enrichment_scope_unknown/,
    );
  });
});

// ────────────────────────────────────────────────────────────────
// Meta snapshot — type, shape validation, serializer
// ────────────────────────────────────────────────────────────────

const sampleMeta = (): EnrichmentMeta => ({
  snapshot_at: 1730294400000,
  snapshot_hash: 'fnv1a:8a3f0123',
  name: 'Acme Q3 Expansion',
  status: 'negotiation',
  amount: 50000,
  owner: 'alice@acme.com',
  key_dates: { close_date: 1735689600000 },
});

describe('D-128 P1 — EnrichmentMeta shape validation', () => {
  it('accepts a well-formed snapshot', () => {
    expect(assertEnrichmentMetaShape(sampleMeta())).toEqual([]);
  });

  it('rejects non-object meta', () => {
    expect(assertEnrichmentMetaShape(null)).toEqual(['meta must be a non-array object']);
    expect(assertEnrichmentMetaShape('foo')).toEqual(['meta must be a non-array object']);
    expect(assertEnrichmentMetaShape([sampleMeta()])).toEqual(['meta must be a non-array object']);
  });

  it('rejects missing or non-numeric snapshot_at', () => {
    expect(
      assertEnrichmentMetaShape({ snapshot_hash: 'fnv1a:abc' }),
    ).toContain('meta.snapshot_at must be a finite number (unix-ms)');
    expect(
      assertEnrichmentMetaShape({ snapshot_at: 'now', snapshot_hash: 'fnv1a:abc' }),
    ).toContain('meta.snapshot_at must be a finite number (unix-ms)');
    expect(
      assertEnrichmentMetaShape({ snapshot_at: NaN, snapshot_hash: 'fnv1a:abc' }),
    ).toContain('meta.snapshot_at must be a finite number (unix-ms)');
  });

  it('rejects missing or empty snapshot_hash', () => {
    expect(
      assertEnrichmentMetaShape({ snapshot_at: 1 }),
    ).toContain('meta.snapshot_hash must be a non-empty string');
    expect(
      assertEnrichmentMetaShape({ snapshot_at: 1, snapshot_hash: '' }),
    ).toContain('meta.snapshot_hash must be a non-empty string');
  });
});

describe('D-128 P1 — serializeEnrichmentMeta + deserializeEnrichmentMeta', () => {
  it('round-trips a typical snapshot', () => {
    const meta = sampleMeta();
    const json = serializeEnrichmentMeta(meta);
    expect(JSON.parse(json)).toEqual(meta);
    expect(deserializeEnrichmentMeta(json)).toEqual(meta);
  });

  it('throws MetaSnapshotTooLargeError when serialised meta exceeds the cap', () => {
    const big: EnrichmentMeta = {
      snapshot_at: 1,
      snapshot_hash: 'fnv1a:abc',
      // 9 KB string — comfortably over the 8 KB cap.
      bloat: 'x'.repeat(9 * 1024),
    };
    expect(() => serializeEnrichmentMeta(big)).toThrow(MetaSnapshotTooLargeError);
    try {
      serializeEnrichmentMeta(big);
    } catch (e) {
      expect(e).toBeInstanceOf(MetaSnapshotTooLargeError);
      const err = e as MetaSnapshotTooLargeError;
      expect(err.code).toBe('META_SNAPSHOT_TOO_LARGE');
      expect(err.cap).toBe(PLATFORM_REFERENCE_META_MAX_BYTES);
      expect(err.bytes).toBeGreaterThan(PLATFORM_REFERENCE_META_MAX_BYTES);
    }
  });

  it('accepts a meta payload right at the byte cap', () => {
    // Build a meta whose serialised form is just under 8 KB. Two-pass
    // sizing avoids fragility on JSON quoting overhead.
    const base: EnrichmentMeta = { snapshot_at: 1, snapshot_hash: 'fnv1a:abc' };
    const pad = PLATFORM_REFERENCE_META_MAX_BYTES - JSON.stringify(base).length - '"pad":"",'.length;
    const meta = { ...base, pad: 'x'.repeat(pad) } satisfies EnrichmentMeta;
    expect(() => serializeEnrichmentMeta(meta)).not.toThrow();
  });

  it('throws on shape-invalid meta before sizing', () => {
    expect(() => serializeEnrichmentMeta({} as EnrichmentMeta)).toThrow(/meta_snapshot_invalid/);
  });

  it('deserialiser returns null for null / empty / invalid JSON / shape-invalid blobs', () => {
    expect(deserializeEnrichmentMeta(null)).toBeNull();
    expect(deserializeEnrichmentMeta('')).toBeNull();
    expect(deserializeEnrichmentMeta('not-json')).toBeNull();
    expect(deserializeEnrichmentMeta('{"foo":1}')).toBeNull();
  });

  it('measures byte length in UTF-8 (multi-byte characters count as more than one)', () => {
    // Build a meta whose ASCII size is in-bounds but UTF-8 size is over.
    const baseHash = 'fnv1a:abc';
    const baseAt = 1;
    const overhead = JSON.stringify({ snapshot_at: baseAt, snapshot_hash: baseHash, big: '' })
      .length;
    // Each '🎉' is 4 bytes in UTF-8; we need just over the cap.
    const charsNeeded = Math.ceil((PLATFORM_REFERENCE_META_MAX_BYTES - overhead) / 4) + 1;
    const meta: EnrichmentMeta = {
      snapshot_at: baseAt,
      snapshot_hash: baseHash,
      big: '🎉'.repeat(charsNeeded),
    };
    expect(() => serializeEnrichmentMeta(meta)).toThrow(MetaSnapshotTooLargeError);
  });
});

// ────────────────────────────────────────────────────────────────
// Constants smoke
// ────────────────────────────────────────────────────────────────

describe('D-128 P1 — constants', () => {
  it('PLATFORM_REFERENCE_META_MAX_BYTES is 8 KB', () => {
    expect(PLATFORM_REFERENCE_META_MAX_BYTES).toBe(8192);
  });

  it('reserved cadence + batch + replay constants exposed', () => {
    expect(PLATFORM_REFERENCE_DEFAULT_CADENCE).toBe('6h');
    expect(PLATFORM_REFERENCE_BATCH_SIZE).toBe(200);
    expect(PLATFORM_REFERENCE_DELETE_DETECT_CADENCE).toBe('24h');
    expect(PLATFORM_REFERENCE_WEBHOOK_REPLAY_WINDOW_MS).toBe(5 * 60 * 1000);
  });
});
