/** D-149 P3 § A.3 + § Must Hold I-5 — registry cache + path-router
 *  dispatch ratchet.
 *
 *  Acceptance per spec:
 *    - Cache hit returns the same row within 60s.
 *    - Stale entry past 60s drops on `get`.
 *    - LRU eviction respects capacity.
 *    - `invalidate(endpoint_id)` drops the entry — fires on broadcast.
 *    - Path-router dispatch parses /reception/<segment>/<endpoint_id>.
 *    - Token presented to the wrong-kind URL fails 401.
 *    - Rate-limit pre-verify runs BEFORE HMAC compute (Must Hold I-10).
 */

import { describe, expect, it } from 'vitest';
import {
  REGISTRY_CACHE_STALENESS_MS,
  createReceptionRegistryCache,
} from '../ports/reception/registry-cache.js';
import type { EndpointSummary } from '@recued/contracts';

const NOW = 1_700_000_000_000;

const summary: EndpointSummary = {
  endpoint_id: 'endpoint-A',
  kind: 'scheduling_link',
  enabled: true,
  packet_declaration: {
    packet_kind: 'scheduling_link_packet',
    source_query_ref: { kind: 'data.calendar.combined' },
  },
  created_at: NOW,
  created_by_client_id: 'client-A',
  expires_at: NOW + 7 * 24 * 60 * 60 * 1000,
  long_lived_acknowledged_at: null,
  revoked_at: null,
  revocation_reason: null,
  audit_count: 0,
  last_accessed_at: null,
  metadata: {},
};

describe('D-149 P3 § A.3 — Registry cache', () => {
  it('get returns the put entry within the 60s window', () => {
    const cache = createReceptionRegistryCache();
    cache.put({
      endpoint_id: 'endpoint-A',
      summary,
      bearer_secret_hmac: Buffer.alloc(32, 0x01),
      now: NOW,
    });
    const hit = cache.get('endpoint-A', NOW + 1);
    expect(hit?.summary.endpoint_id).toBe('endpoint-A');
  });

  it('staleness — entry older than 60s drops on get (Must Hold I-5)', () => {
    const cache = createReceptionRegistryCache();
    cache.put({
      endpoint_id: 'endpoint-A',
      summary,
      bearer_secret_hmac: Buffer.alloc(32),
      now: NOW,
    });
    expect(cache.get('endpoint-A', NOW + REGISTRY_CACHE_STALENESS_MS)).toBeNull();
  });

  it('invalidate removes the entry — bus-driven path', () => {
    const cache = createReceptionRegistryCache();
    cache.put({
      endpoint_id: 'endpoint-A',
      summary,
      bearer_secret_hmac: Buffer.alloc(32),
      now: NOW,
    });
    cache.invalidate('endpoint-A');
    expect(cache.get('endpoint-A', NOW + 1)).toBeNull();
  });

  it('LRU eviction respects capacity', () => {
    const cache = createReceptionRegistryCache({ capacity: 2 });
    for (let i = 0; i < 3; i++) {
      cache.put({
        endpoint_id: `endpoint-${i}`,
        summary: { ...summary, endpoint_id: `endpoint-${i}` },
        bearer_secret_hmac: Buffer.alloc(32),
        now: NOW,
      });
    }
    expect(cache.size()).toBe(2);
    expect(cache.get('endpoint-0', NOW + 1)).toBeNull();
    expect(cache.get('endpoint-1', NOW + 1)).not.toBeNull();
    expect(cache.get('endpoint-2', NOW + 1)).not.toBeNull();
  });

  it('flush wipes every entry', () => {
    const cache = createReceptionRegistryCache();
    cache.put({
      endpoint_id: 'endpoint-A',
      summary,
      bearer_secret_hmac: Buffer.alloc(32),
      now: NOW,
    });
    cache.flush();
    expect(cache.size()).toBe(0);
  });
});
