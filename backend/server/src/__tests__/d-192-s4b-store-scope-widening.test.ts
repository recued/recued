/** D-192 S4b — enrichment-store live-registry scope widening.
 *
 *  A pack CRM's `crm_alias`-anchored enrichment scope
 *  (`connection.api.<vendor>.contact` / `.deal` / `.account`) must become
 *  WRITABLE without a per-topic `valid_scopes` code edit — the pure static list
 *  can't see pack vendors (the enrichment-registry ↔ connection-vendors import
 *  cycle), so the backend store closes the gap where the live registry IS
 *  available. Injected via `CreateEnrichmentStoreOptions.resolveVendorRegistry`.
 *
 *  THE INVARIANT (byte-identical built-ins): the widening adds ONLY pack
 *  (non-built-in) vendors of the topic's own `crm_alias` family — a built-in
 *  crm_alias scope a topic's static list deliberately OMITS (`pipedrive.person`
 *  is a built-in `crm_alias:'contact'` scope not in `champion_deal_count`'s list)
 *  stays REJECTED. Design: `docs/d-192-engagement-facet.md` S4 + de-hardcode scope.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONNECTION_VENDOR_ENTITIES,
  type ConnectionVendorEntity,
} from '@recued/contracts';
import {
  createEnrichmentStore,
  EnrichmentScopeUnsupportedError,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import { handleEnrichmentRead } from '../mcp/enrichment-read.js';

/** A pack CRM contact vendor (`crm_alias:'contact'`) NOT in the built-in registry. */
const packContact: ConnectionVendorEntity = {
  vendor: 'dynamics',
  entity: 'contact',
  scope: 'connection.api.dynamics.contact',
  display_name: 'Dynamics Contact',
  crm_alias: 'contact',
  meta_fields: [],
};
const packDeal: ConnectionVendorEntity = {
  vendor: 'dynamics',
  entity: 'opportunity',
  scope: 'connection.api.dynamics.opportunity',
  display_name: 'Dynamics Opportunity',
  crm_alias: 'deal',
  meta_fields: [],
};

/** A valid `champion_deal_count` value (contact-anchored topic; static valid_scopes
 *  = hubspot.contact + salesforce.contact — no pipedrive.person, no pack). */
const championValue = {
  total_deals: 3,
  won_deals: 2,
  lost_deals: 1,
  open_deals: 0,
  win_rate: 0.67,
  bucket: 'champion' as const,
  cursor_at: 1_700_000_000_000,
  entity: 'a@dyn.example',
};

let dir: string;
let db: Database.Database;

const mkStore = (registry?: ReadonlyArray<ConnectionVendorEntity>): EnrichmentStore =>
  createEnrichmentStore(db, registry ? { resolveVendorRegistry: () => registry } : {});

const upsertChampion = (store: EnrichmentStore, scope: string): void => {
  store.upsert({
    topic: 'champion_deal_count',
    scope: scope as never,
    target_id: 'dynamics_contact_a@dyn.example',
    value: championValue,
    authored_by: 'recipe.refresh-champion-deal-count',
  });
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'enr-s4b-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('D-192 S4b — enrichment-store live-registry scope widening', () => {
  it('accepts a PACK crm_alias:contact scope when the live registry declares it', () => {
    const store = mkStore([...CONNECTION_VENDOR_ENTITIES, packContact]);
    expect(() => upsertChampion(store, 'connection.api.dynamics.contact')).not.toThrow();
  });

  it('REJECTS the same pack scope with NO resolver (built-ins only — today\'s behaviour)', () => {
    const store = mkStore();
    expect(() => upsertChampion(store, 'connection.api.dynamics.contact')).toThrow(
      EnrichmentScopeUnsupportedError,
    );
  });

  it('a built-in scope IN the static valid_scopes still writes — with OR without a resolver (fast path)', () => {
    expect(() => upsertChampion(mkStore([...CONNECTION_VENDOR_ENTITIES, packContact]), 'connection.api.hubspot.contact')).not.toThrow();
    expect(() => upsertChampion(mkStore(), 'connection.api.salesforce.contact')).not.toThrow();
  });

  it('BYTE-IDENTICAL built-ins: a built-in crm_alias:contact scope OMITTED from the static list (pipedrive.person) stays REJECTED even WITH a resolver', () => {
    // `champion_deal_count.valid_scopes` omits pipedrive.person; the widening adds
    // only PACK vendors, so a built-in omission is never re-included.
    const store = mkStore([...CONNECTION_VENDOR_ENTITIES, packContact]);
    expect(() => upsertChampion(store, 'connection.api.pipedrive.person')).toThrow(
      EnrichmentScopeUnsupportedError,
    );
  });

  it('WRONG FAMILY: a pack crm_alias:DEAL scope is rejected for a CONTACT topic', () => {
    const store = mkStore([...CONNECTION_VENDOR_ENTITIES, packDeal]);
    expect(() =>
      store.upsert({
        topic: 'champion_deal_count',
        scope: 'connection.api.dynamics.opportunity' as never,
        target_id: 'dynamics_opportunity_x',
        value: championValue,
        authored_by: 'recipe.refresh-champion-deal-count',
      }),
    ).toThrow(EnrichmentScopeUnsupportedError);
  });

  it('a NON-CRM topic (empty crm_alias family) never widens — a pack scope stays rejected', () => {
    // `contact_timeline_rollup.valid_scopes` = ['contact'] (not a connection.api
    // scope), so its derived family is empty and the live registry can't widen it.
    const store = mkStore([...CONNECTION_VENDOR_ENTITIES, packContact]);
    expect(() =>
      store.upsert({
        topic: 'contact_timeline_rollup',
        scope: 'connection.api.dynamics.contact' as never,
        target_id: 'a@dyn.example',
        value: {
          interaction_count: 1,
          last_interaction: 1_700_000_000_000,
          recent_subjects: ['x'],
          cursor_at: 1_700_000_000_000,
          window_ms: 30 * 24 * 60 * 60 * 1000,
        },
        authored_by: 'recipe.x',
      }),
    ).toThrow(EnrichmentScopeUnsupportedError);
  });

  it('the chain-walk read gate MIRRORS the write gate: a written pack scope is readable', () => {
    const registry = [...CONNECTION_VENDOR_ENTITIES, packContact];
    const store = mkStore(registry);
    upsertChampion(store, 'connection.api.dynamics.contact');
    // getRowAsOf runs validateChainArgs — must accept the pack scope (else a row
    // written via the widened upsert would be unreadable).
    expect(() =>
      store.getRowAsOf({
        topic: 'champion_deal_count',
        scope: 'connection.api.dynamics.contact' as never,
        target_id: 'dynamics_contact_a@dyn.example',
        as_of: 1_700_000_100_000,
      }),
    ).not.toThrow();
    // and a resolver-less store REJECTS the same read (mirror of the write gate).
    const bareStore = mkStore();
    expect(() =>
      bareStore.getRowAsOf({
        topic: 'champion_deal_count',
        scope: 'connection.api.dynamics.contact' as never,
        target_id: 'dynamics_contact_a@dyn.example',
        as_of: 1_700_000_100_000,
      }),
    ).toThrow(EnrichmentScopeUnsupportedError);
  });
});

// D-192 S4b fold (Codex) — the MCP read handler had a THIRD scope gate
// (`validateInput`'s bare `valid_scopes.includes`) that ran BEFORE dispatch, so a
// pack-scope row written via the widened upsert was unreadable via MCP. It now
// delegates to `store.isScopeSupported`, the single source of truth.
describe('D-192 S4b — MCP read gate mirrors the store (isScopeSupported)', () => {
  const readInput = {
    topic: 'champion_deal_count',
    scope: 'connection.api.dynamics.contact',
    target_id: 'dynamics_contact_a@dyn.example',
  } as const;

  it('MCP read REJECTS a pack scope when the store has NO resolver (bare valid_scopes)', () => {
    const store = mkStore();
    expect(() => handleEnrichmentRead({ enrichmentStore: store }, { ...readInput })).toThrow(
      /does not support scope/,
    );
  });

  it('MCP read ACCEPTS the widened pack scope + returns the row when the resolver declares the vendor', () => {
    const store = mkStore([...CONNECTION_VENDOR_ENTITIES, packContact]);
    upsertChampion(store, 'connection.api.dynamics.contact');
    const out = handleEnrichmentRead({ enrichmentStore: store }, { ...readInput });
    // the scope gate passed (no throw) AND the widened row is read back.
    expect(out.result).not.toBeNull();
  });
});
