/** D-125 Phase 6.1 — Enrichment substrate convention (contracts surface).
 *
 *  Registry reserves three housekeeping topics on the connection.*
 *  scopes; `composeEnrichmentScope` round-trips both namespaces. Store
 *  + resolver round-trips live alongside the storage code in
 *  `backend/server/src/__tests__/d-125-phase-6-1-substrate-convention.test.ts`. */

import { describe, expect, it } from 'vitest';

import {
  ALL_ENRICHMENT_SCOPES,
  CONNECTION_ENRICHMENT_SCOPES,
  ENRICHMENT_REGISTRY,
  composeEnrichmentScope,
  isEnrichmentScope,
  isEnrichmentTopic,
  type EnrichmentScope,
} from '../index.js';

describe('D-125 P6.1 — Registry reserves connection.* topics', () => {
  it('exposes connection.api / connection.mcp / connection.notification in ALL_ENRICHMENT_SCOPES', () => {
    for (const s of CONNECTION_ENRICHMENT_SCOPES) {
      expect(ALL_ENRICHMENT_SCOPES).toContain(s);
      expect(isEnrichmentScope(s)).toBe(true);
    }
  });

  it('reserves connection_health_trend / last_used_pattern / optimal_batch_size topics', () => {
    expect(isEnrichmentTopic('connection_health_trend')).toBe(true);
    expect(isEnrichmentTopic('connection_last_used_pattern')).toBe(true);
    expect(isEnrichmentTopic('connection_optimal_batch_size')).toBe(true);
  });

  it('connection_health_trend valid_scopes covers all three connection kinds', () => {
    const def = ENRICHMENT_REGISTRY.connection_health_trend;
    expect(def.valid_scopes).toEqual(
      expect.arrayContaining([
        'connection.api',
        'connection.mcp',
        'connection.notification',
      ] satisfies EnrichmentScope[]),
    );
    expect(def.producer_kind).toBe('housekeeping');
    expect(def.shape).toBe('per_record');
  });

  it('connection_optimal_batch_size excludes notification (no batching)', () => {
    const def = ENRICHMENT_REGISTRY.connection_optimal_batch_size;
    expect(def.valid_scopes).toEqual(
      expect.arrayContaining([
        'connection.api',
        'connection.mcp',
      ] satisfies EnrichmentScope[]),
    );
    expect(def.valid_scopes).not.toContain('connection.notification');
  });
});

describe('D-125 P6.1 — composeEnrichmentScope helper', () => {
  it('data namespace round-trips bare collection names', () => {
    expect(composeEnrichmentScope('data', 'mail')).toBe('mail');
    expect(composeEnrichmentScope('data', 'contact')).toBe('contact');
    expect(composeEnrichmentScope('data', 'calendar')).toBe('calendar');
    expect(composeEnrichmentScope('data', 'file')).toBe('file');
  });

  it('connection namespace prefixes the kind segment', () => {
    expect(composeEnrichmentScope('connection', 'api')).toBe('connection.api');
    expect(composeEnrichmentScope('connection', 'mcp')).toBe('connection.mcp');
    expect(composeEnrichmentScope('connection', 'notification')).toBe('connection.notification');
  });

  it('throws when the composed pair is not in ALL_ENRICHMENT_SCOPES', () => {
    expect(() => composeEnrichmentScope('data', 'memory')).toThrow(/enrichment_scope_unknown/);
    expect(() => composeEnrichmentScope('connection', 'service')).toThrow(/enrichment_scope_unknown/);
  });
});
