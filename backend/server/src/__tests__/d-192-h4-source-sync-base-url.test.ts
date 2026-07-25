/** D-192 H4 — the background Source-sync fetch deps must resolve the connection's
 *  per-tenant base URL.
 *
 *  The bug: `buildCanonicalPollDeps` (the fetchDeps the work-entity Source sync
 *  composes — see `serve/compose-work-entity-source-sync.ts`) wired
 *  `getSubresourcePath` but NOT `getBaseUrl`, so `source-mirror/fetch.ts` built a
 *  gateway ctx with no `connectionBaseUrlResolver`. The pagination origin-pin then
 *  fell back to the pack's placeholder `default_base_url`, which for a
 *  multi-tenant vendor (Zendesk `<subdomain>.zendesk.com`, self-hosted GitLab)
 *  never matches the real origin — so every absolute `links.next` was rejected
 *  cross-origin and the mirror truncated at page 1, silently, for every user. The
 *  recipe + raw-op dispatch paths already wired the resolver; only the background
 *  sync path did not. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildCanonicalPollDeps } from '../watch/canonical-poll-deps.js';
import {
  createConnectionStore,
  type ConnectionStoreSqlite,
  type ConnectionUpsert,
} from '../storage/connection-store.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';

let db: Database.Database;
let store: ConnectionStoreSqlite;

const mkApiConn = (name: string, config: unknown): ConnectionUpsert => ({
  kind: 'api',
  name,
  display_name: name,
  config_json: JSON.stringify(config),
  auth_ciphertext: 'AEAD',
  enrolled_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
});

beforeEach(() => {
  db = new Database(':memory:');
  store = createConnectionStore(db);
});

afterEach(() => {
  db.close();
});

describe('D-192 H4 — Source-sync fetch deps resolve the per-tenant base URL', () => {
  it('threads getBaseUrl from the connection config_json.base_url', () => {
    // A multi-tenant Zendesk connection: the real origin differs from the pack's
    // placeholder default (`https://example.zendesk.com`).
    store.upsert(mkApiConn('acme-zendesk', { base_url: 'https://acme.zendesk.com' }));

    const deps = buildCanonicalPollDeps({} as ExecuteHandlerDeps, store);

    // The resolver MUST be present (its absence was the whole bug) and MUST return
    // the enrolled tenant origin, not undefined (→ placeholder → cross-origin drop).
    expect(deps.getBaseUrl).toBeDefined();
    expect(deps.getBaseUrl?.('acme-zendesk')).toBe('https://acme.zendesk.com');
  });

  it('returns undefined for a fixed-base connection and an unknown name (safe fallback)', () => {
    store.upsert(mkApiConn('fixed-base', {})); // no base_url → fixed-base vendor

    const deps = buildCanonicalPollDeps({} as ExecuteHandlerDeps, store);

    // undefined is the correct fixed-base answer — the origin-pin then uses the
    // pack default, which for a single-origin vendor IS the real origin.
    expect(deps.getBaseUrl?.('fixed-base')).toBeUndefined();
    expect(deps.getBaseUrl?.('never-enrolled')).toBeUndefined();
  });
});
