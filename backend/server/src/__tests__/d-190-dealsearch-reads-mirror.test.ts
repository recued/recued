/** D-190 (generic reconciler MS3) — deal.search reads the CRM record mirror.
 *
 *  The acceptance test for the repoint: `deal.search` now reads the dedicated
 *  `crm_record_mirror` store (which the reconciler + funnels write per record,
 *  MS2) instead of the producer-gated enrichment store. So a deal that NO AI
 *  producer ever enriched — present only in the mirror — surfaces, where the
 *  pre-MS3 `listScopeMeta WHERE meta IS NOT NULL` read would have hidden it.
 *
 *  Real SQLite + real `CrmRecordMirrorStore` + the real `deal.search` handler —
 *  an end-to-end proof of the completeness fix, not a stub assertion. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChatDispatchContext, EnrichmentScope } from '@recued/contracts';

import {
  buildChatTier1Handlers,
  type ChatToolHandlerDeps,
} from '../chat-tool-handlers.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import {
  createCrmRecordMirrorStore,
  ensureCrmRecordMirrorSchema,
  type CrmRecordMirrorStore,
} from '../storage/crm-record-mirror-store.js';

const DEAL_SCOPE = 'connection.api.hubspot.deal' as EnrichmentScope;
const CONTACT_SCOPE = 'connection.api.hubspot.contact' as EnrichmentScope;

const ctxInternal = (): ChatDispatchContext => ({
  channel: 'internal_function_call',
  session_id: 'sess-ms3',
  turn_id: 'turn-ms3',
});

let dir: string;
let db: Database.Database;
let enrichmentStore: EnrichmentStore;
let mirror: CrmRecordMirrorStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd190-ms3-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  enrichmentStore = createEnrichmentStore(db);
  ensureCrmRecordMirrorSchema(db);
  mirror = createCrmRecordMirrorStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Minimal deps wiring the REAL mirror + enrichment stores into deal.search. */
const buildDeps = (): ChatToolHandlerDeps => ({
  getContactStore: () => undefined,
  getCollectionRegistry: () => undefined,
  getAuditLog: () => undefined,
  getEnrichmentStore: () => enrichmentStore,
  getCrmRecordMirror: () => mirror,
  getRecipeStore: () =>
    ({ ids: () => [], get: () => null, getStored: () => null, listStored: () => [] }) as never,
  getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
  getExecuteRecipe: () => undefined,
  getBoundCrmMirrorSources: (crmAlias) => {
    if (crmAlias === 'deal') return [{ source_id: 'hubspot', scope: DEAL_SCOPE }];
    if (crmAlias === 'contact') return [{ source_id: 'hubspot', scope: CONTACT_SCOPE }];
    return [];
  },
  // S1 — per-connection mirror freshness the handler attaches as `crm_freshness`.
  getCrmConnectionFreshness: (crmAlias) =>
    crmAlias === 'deal'
      ? [{ connection_name: 'acme-hubspot', vendor: 'hubspot', entity: 'deal', synced_at: 1_700_000_000_000 }]
      : crmAlias === 'contact'
        ? [{ connection_name: 'acme-hubspot', vendor: 'hubspot', entity: 'contact', synced_at: 1_700_000_000_111 }]
        : [],
});

describe('D-190 MS3 — deal.search reads the CRM record mirror', () => {
  it('surfaces an UN-ENRICHED deal that exists only in the mirror (no enrichment row)', async () => {
    // The reconciler mirrored this deal; NO producer ever enriched it.
    mirror.upsert({
      scope: DEAL_SCOPE,
      target_id: 'hubspot_deal_90001',
      meta: {
        snapshot_at: 1,
        snapshot_hash: 'fnv1a:unenriched',
        name: 'Northwind renewal',
        stage: 'Contract sent',
        amount: 48_000,
        close_state: 'open',
        key_dates: { close_date: 1_700_500_000_000 },
      },
      now: 1_000,
    });
    // Sanity: the OLD reader (enrichment store) sees nothing for this scope —
    // this is exactly the deal the pre-MS3 path hid.
    expect(enrichmentStore.listScopeMeta(DEAL_SCOPE)).toHaveLength(0);

    const handlers = buildChatTier1Handlers(buildDeps());
    const result = await handlers['deal.search']!({ query: 'Northwind', limit: 10 }, ctxInternal());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as {
      candidates: Array<{
        source: string;
        record: { name: string; amount?: number; stage?: string; close_state?: string; close_date?: number };
      }>;
    };
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.source).toBe('hubspot');
    expect(r.candidates[0]!.record.name).toBe('Northwind renewal');
    expect(r.candidates[0]!.record.amount).toBe(48_000);
    expect(r.candidates[0]!.record.close_state).toBe('open');
  });

  it('threads the canonical close_state filter into the mirror read', async () => {
    mirror.upsert({
      scope: DEAL_SCOPE, target_id: 'hubspot_deal_won', now: 1,
      meta: { snapshot_at: 1, snapshot_hash: 'h1', name: 'Acme won', close_state: 'won' },
    });
    mirror.upsert({
      scope: DEAL_SCOPE, target_id: 'hubspot_deal_open', now: 2,
      meta: { snapshot_at: 1, snapshot_hash: 'h2', name: 'Acme open', close_state: 'open' },
    });

    const handlers = buildChatTier1Handlers(buildDeps());
    const result = await handlers['deal.search']!({ close_state: 'won', limit: 10 }, ctxInternal());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as { candidates: Array<{ record: { name: string; close_state?: string } }> };
    expect(r.candidates.map((c) => c.record.name)).toEqual(['Acme won']);
  });

  it('S1 — attaches per-connection crm_freshness (synced_at) to the result', async () => {
    mirror.upsert({
      scope: DEAL_SCOPE, target_id: 'hubspot_deal_acme-hubspot_1', now: 1,
      meta: { snapshot_at: 1, snapshot_hash: 'h', name: 'Acme', close_state: 'open' },
    });
    const handlers = buildChatTier1Handlers(buildDeps());
    const result = await handlers['deal.search']!({ query: 'Acme', limit: 10 }, ctxInternal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as {
      crm_freshness: Array<{
        connection_name: string; vendor: string; entity: string; synced_at: number | null; filter_applied?: string;
      }>;
    };
    // No live fetcher wired (S1-only deps) → no escalation → filter_applied 'local'.
    expect(r.crm_freshness).toEqual([
      { connection_name: 'acme-hubspot', vendor: 'hubspot', entity: 'deal', synced_at: 1_700_000_000_000, filter_applied: 'local' },
    ]);
  });

  it('S1 — crm_freshness is [] when the freshness dep is unwired (graceful)', async () => {
    const deps: ChatToolHandlerDeps = { ...buildDeps(), getCrmConnectionFreshness: undefined };
    const handlers = buildChatTier1Handlers(deps);
    const result = await handlers['deal.search']!({ query: 'x', limit: 10 }, ctxInternal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.result as { crm_freshness: unknown[] }).crm_freshness).toEqual([]);
  });

  it('returns no candidates when the mirror getter is unwired (graceful degradation)', async () => {
    const deps: ChatToolHandlerDeps = { ...buildDeps(), getCrmRecordMirror: undefined };
    mirror.upsert({
      scope: DEAL_SCOPE, target_id: 'hubspot_deal_1', now: 1,
      meta: { snapshot_at: 1, snapshot_hash: 'h', name: 'Acme' },
    });
    const handlers = buildChatTier1Handlers(deps);
    const result = await handlers['deal.search']!({ query: 'Acme', limit: 10 }, ctxInternal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.result as { candidates: unknown[] }).candidates).toHaveLength(0);
  });
});

describe('D-190 — contact.search reads the CRM record mirror (repoint + genericize)', () => {
  it('surfaces an UN-ENRICHED contact that exists only in the mirror', async () => {
    // The reconciler mirrored this contact; NO producer ever enriched it.
    mirror.upsert({
      scope: CONTACT_SCOPE,
      target_id: 'hubspot_contact_90001',
      meta: {
        snapshot_at: 1,
        snapshot_hash: 'fnv1a:unenriched',
        email: 'morgan@acme.com',
        name: 'Morgan Hale',
        lifecycle_stage: 'customer',
      },
      now: 1_000,
    });
    // Sanity: the OLD reader (enrichment store) sees nothing for this scope.
    expect(enrichmentStore.listScopeMeta(CONTACT_SCOPE)).toHaveLength(0);

    const handlers = buildChatTier1Handlers(buildDeps());
    const result = await handlers['contact.search']!({ query: 'Morgan', limit: 10 }, ctxInternal());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as {
      candidates: Array<{ source: string; record: { name?: string; email: string | null } }>;
    };
    // The local data.contact source is unwired (getContactStore→undefined), so the
    // ONLY candidate is the mirrored platform contact.
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.source).toBe('hubspot');
    expect(r.candidates[0]!.record.name).toBe('Morgan Hale');
    expect(r.candidates[0]!.record.email).toBe('morgan@acme.com');
  });

  it('matches a mirrored contact by email_exact (identifier lookup)', async () => {
    mirror.upsert({
      scope: CONTACT_SCOPE, target_id: 'hubspot_contact_2', now: 1,
      meta: { snapshot_at: 1, snapshot_hash: 'h', email: 'jordan@initech.com', name: 'Jordan Diaz' },
    });
    const handlers = buildChatTier1Handlers(buildDeps());
    const result = await handlers['contact.search']!({ email: 'jordan@initech.com', limit: 10 }, ctxInternal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as { candidates: Array<{ record: { name?: string } }> };
    expect(r.candidates.map((c) => c.record.name)).toEqual(['Jordan Diaz']);
  });
});

describe('D-190 — account.search reads the CRM record mirror', () => {
  // HubSpot's `crm_alias:'account'` entity is `company` → scope + target_id use it.
  const ACCOUNT_SCOPE = 'connection.api.hubspot.company' as EnrichmentScope;
  /** account-aware deps; no live fetcher (S1 / mirror tests, like `buildDeps`). */
  const accountDeps = (synced_at: number | null = 1_700_000_000_000): ChatToolHandlerDeps => ({
    ...buildDeps(),
    getBoundCrmMirrorSources: (crmAlias) =>
      crmAlias === 'account' ? [{ source_id: 'hubspot', scope: ACCOUNT_SCOPE }] : [],
    getCrmConnectionFreshness: (crmAlias) =>
      crmAlias === 'account'
        ? [{ connection_name: 'acme-hubspot', vendor: 'hubspot', entity: 'company', synced_at }]
        : [],
  });
  /** + a controllable live fetcher for the S3 escalation tests. */
  const accountS3Deps = (
    synced_at: number | null,
    live: Map<string, Record<string, unknown>> | null,
  ): ChatToolHandlerDeps => ({ ...accountDeps(synced_at), getCrmLiveRecords: async () => live });

  it('surfaces an account that exists only in the mirror (all canonical fields projected)', async () => {
    mirror.upsert({
      scope: ACCOUNT_SCOPE, target_id: 'hubspot_company_acme-hubspot_a1', now: 1,
      meta: {
        snapshot_at: 1, snapshot_hash: 'h', name: 'Acme Inc', domain: 'acme.com',
        industry: 'Software', owner: 'rep@acme.com', num_employees: 50, annual_revenue: 1_000_000,
      },
    });
    const handlers = buildChatTier1Handlers(accountDeps());
    const result = await handlers['account.search']!({ query: 'Acme', limit: 10 }, ctxInternal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as {
      candidates: Array<{ source: string; record: {
        target_id: string; name: string; domain?: string; industry?: string;
        owner?: string; num_employees?: number; annual_revenue?: number;
      } }>;
    };
    expect(r.candidates).toHaveLength(1);
    const rec = r.candidates[0]!;
    expect(rec.source).toBe('hubspot');
    expect(rec.record.target_id).toBe('hubspot_company_acme-hubspot_a1');
    expect(rec.record.name).toBe('Acme Inc');
    expect(rec.record.domain).toBe('acme.com');
    expect(rec.record.industry).toBe('Software');
    expect(rec.record.owner).toBe('rep@acme.com');
    expect(rec.record.num_employees).toBe(50);
    expect(rec.record.annual_revenue).toBe(1_000_000);
  });

  it('matches by domain_exact (CASE-INSENSITIVE identifier lookup); excludes other domains', async () => {
    mirror.upsert({
      scope: ACCOUNT_SCOPE, target_id: 'hubspot_company_acme-hubspot_a1', now: 1,
      meta: { snapshot_at: 1, snapshot_hash: 'h', name: 'Acme Inc', domain: 'Acme.COM' }, // mixed-case stored
    });
    mirror.upsert({
      scope: ACCOUNT_SCOPE, target_id: 'hubspot_company_acme-hubspot_a2', now: 1,
      meta: { snapshot_at: 1, snapshot_hash: 'h', name: 'Other Co', domain: 'other.com' },
    });
    const handlers = buildChatTier1Handlers(accountDeps());
    const result = await handlers['account.search']!({ domain: 'acme.com', limit: 10 }, ctxInternal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as { candidates: Array<{ record: { target_id: string } }> };
    expect(r.candidates.map((c) => c.record.target_id)).toEqual(['hubspot_company_acme-hubspot_a1']);
  });

  it('lists accounts with NO filter (NOT identifier-gated, unlike contact.search)', async () => {
    mirror.upsert({
      scope: ACCOUNT_SCOPE, target_id: 'hubspot_company_acme-hubspot_a1', now: 1,
      meta: { snapshot_at: 1, snapshot_hash: 'h', name: 'Acme Inc' },
    });
    mirror.upsert({
      scope: ACCOUNT_SCOPE, target_id: 'hubspot_company_acme-hubspot_a2', now: 1,
      meta: { snapshot_at: 1, snapshot_hash: 'h', name: 'Beta LLC' },
    });
    const handlers = buildChatTier1Handlers(accountDeps());
    const result = await handlers['account.search']!({ limit: 10 }, ctxInternal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as { candidates: Array<{ record: { target_id: string } }> };
    expect(r.candidates.map((c) => c.record.target_id).sort()).toEqual([
      'hubspot_company_acme-hubspot_a1', 'hubspot_company_acme-hubspot_a2',
    ]);
  });

  it('S1 — attaches per-connection crm_freshness (synced_at) to the result', async () => {
    mirror.upsert({
      scope: ACCOUNT_SCOPE, target_id: 'hubspot_company_acme-hubspot_a1', now: 1,
      meta: { snapshot_at: 1, snapshot_hash: 'h', name: 'Acme Inc', domain: 'acme.com' },
    });
    const handlers = buildChatTier1Handlers(accountDeps(1_700_000_000_000));
    const result = await handlers['account.search']!({ query: 'Acme', limit: 10 }, ctxInternal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as {
      crm_freshness: Array<{
        connection_name: string; vendor: string; entity: string; synced_at: number | null; filter_applied?: string;
      }>;
    };
    // No live fetcher wired (S1-only deps) → no escalation → filter_applied 'local'.
    expect(r.crm_freshness).toEqual([
      { connection_name: 'acme-hubspot', vendor: 'hubspot', entity: 'company', synced_at: 1_700_000_000_000, filter_applied: 'local' },
    ]);
  });

  it('S3 — STALE connection live-escalates; mirror REPLACED + live domain match is case-insensitive', async () => {
    mirror.upsert({
      scope: ACCOUNT_SCOPE, target_id: 'hubspot_company_acme-hubspot_stale', now: 1,
      meta: { snapshot_at: 1, snapshot_hash: 'h', name: 'Stale Co', domain: 'stale.com' },
    });
    // Live record carries a MIXED-CASE domain; the user searches the lowercase form.
    const live = new Map<string, Record<string, unknown>>([
      ['live1', { snapshot_at: 1, snapshot_hash: 'h', name: 'Acme', domain: 'ACME.com' }],
    ]);
    const handlers = buildChatTier1Handlers(accountS3Deps(null, live)); // synced_at null = stale
    const result = await handlers['account.search']!({ domain: 'acme.com', limit: 10 }, ctxInternal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as {
      candidates: Array<{ record: { target_id: string } }>;
      crm_freshness: Array<{ filter_applied?: string }>;
    };
    expect(r.candidates.map((c) => c.record.target_id)).toEqual(['hubspot_company_acme-hubspot_live1']);
    expect(r.crm_freshness[0]!.filter_applied).toBe('server');
  });
});

describe('S3 — live escalation (stale / narrow-miss)', () => {
  /** Deps with a controllable per-connection synced_at + a controllable live fetcher. */
  const s3Deps = (
    synced_at: number | null,
    live: Map<string, Record<string, unknown>> | null,
  ): ChatToolHandlerDeps => ({
    getContactStore: () => undefined,
    getCollectionRegistry: () => undefined,
    getAuditLog: () => undefined,
    getEnrichmentStore: () => enrichmentStore,
    getCrmRecordMirror: () => mirror,
    getRecipeStore: () =>
      ({ ids: () => [], get: () => null, getStored: () => null, listStored: () => [] }) as never,
    getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
    getExecuteRecipe: () => undefined,
    getBoundCrmMirrorSources: (crmAlias) =>
      crmAlias === 'deal' ? [{ source_id: 'hubspot', scope: DEAL_SCOPE }] : [],
    getCrmConnectionFreshness: (crmAlias) =>
      crmAlias === 'deal'
        ? [{ connection_name: 'acme-hubspot', vendor: 'hubspot', entity: 'deal', synced_at }]
        : [],
    getCrmLiveRecords: async () => live,
  });

  const liveDeal = (id: string, name: string): readonly [string, Record<string, unknown>] =>
    [id, { snapshot_at: 1, snapshot_hash: 'h', name, close_state: 'open' }];

  /** Contact variant of `s3Deps` — a controllable synced_at + live fetcher over the
   *  `contact` crm_alias, plus an optional local `data.contact` store (default: empty). */
  const contactS3Deps = (
    synced_at: number | null,
    live: Map<string, Record<string, unknown>> | null,
    contactStore?: { get: (email: string) => Record<string, unknown> | null; list: () => unknown[] },
  ): ChatToolHandlerDeps => ({
    ...buildDeps(),
    getContactStore: () => (contactStore ?? { get: () => null, list: () => [] }) as never,
    getBoundCrmMirrorSources: (crmAlias) =>
      crmAlias === 'contact' ? [{ source_id: 'hubspot', scope: CONTACT_SCOPE }] : [],
    getCrmConnectionFreshness: (crmAlias) =>
      crmAlias === 'contact'
        ? [{ connection_name: 'acme-hubspot', vendor: 'hubspot', entity: 'contact', synced_at }]
        : [],
    getCrmLiveRecords: async () => live,
  });

  it('STALE (synced_at null) → live-fetches; the connection mirror rows are REPLACED + filter_applied flips to server', async () => {
    mirror.upsert({
      scope: DEAL_SCOPE, target_id: 'hubspot_deal_acme-hubspot_stale', now: 1,
      meta: { snapshot_at: 1, snapshot_hash: 'h', name: 'Live stale mirror', close_state: 'open' },
    });
    const live = new Map([liveDeal('fresh1', 'Live fresh1')]);
    const handlers = buildChatTier1Handlers(s3Deps(null, live));
    const result = await handlers['deal.search']!({ query: 'Live', limit: 10 }, ctxInternal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as {
      candidates: Array<{ record: { target_id: string } }>;
      crm_freshness: Array<{ filter_applied?: string; synced_at: number | null }>;
    };
    // the stale mirror row is gone; only the live row remains.
    expect(r.candidates.map((c) => c.record.target_id)).toEqual(['hubspot_deal_acme-hubspot_fresh1']);
    expect(r.crm_freshness[0]!.filter_applied).toBe('server');
    expect(r.crm_freshness[0]!.synced_at).toBeGreaterThan(1_700_000_000_000); // refreshed to ~now
  });

  it('FRESH connection with a result → NO escalation (live fetcher never called); mirror kept, filter_applied:local', async () => {
    mirror.upsert({
      scope: DEAL_SCOPE, target_id: 'hubspot_deal_acme-hubspot_m1', now: 1,
      meta: { snapshot_at: 1, snapshot_hash: 'h', name: 'Mirror deal', close_state: 'open' },
    });
    const deps: ChatToolHandlerDeps = {
      ...s3Deps(Date.now(), null),
      getCrmLiveRecords: async () => {
        throw new Error('escalated when it should not have');
      },
    };
    const result = await buildChatTier1Handlers(deps)['deal.search']!({ query: 'Mirror', limit: 10 }, ctxInternal());
    expect(result.ok).toBe(true); // a thrown live fetch would surface as ok:false
    if (!result.ok) return;
    const r = result.result as {
      candidates: Array<{ record: { target_id: string } }>;
      crm_freshness: Array<{ filter_applied?: string }>;
    };
    expect(r.candidates.map((c) => c.record.target_id)).toEqual(['hubspot_deal_acme-hubspot_m1']);
    expect(r.crm_freshness[0]!.filter_applied).toBe('local');
  });

  it('NARROW-MISS (fresh mirror, but the query returns 0 for the connection) → live-fetches', async () => {
    mirror.upsert({
      scope: DEAL_SCOPE, target_id: 'hubspot_deal_acme-hubspot_nw', now: 1,
      meta: { snapshot_at: 1, snapshot_hash: 'h', name: 'Northwind', close_state: 'open' },
    });
    const live = new Map([liveDeal('found', 'Acme renewal')]);
    const handlers = buildChatTier1Handlers(s3Deps(Date.now(), live));
    const result = await handlers['deal.search']!({ query: 'Acme', limit: 10 }, ctxInternal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as {
      candidates: Array<{ record: { name: string } }>;
      crm_freshness: Array<{ filter_applied?: string }>;
    };
    expect(r.candidates.map((c) => c.record.name)).toEqual(['Acme renewal']);
    expect(r.crm_freshness[0]!.filter_applied).toBe('server');
  });

  it('a FAILED live fetch (null) keeps the mirror (graceful), filter_applied:local', async () => {
    mirror.upsert({
      scope: DEAL_SCOPE, target_id: 'hubspot_deal_acme-hubspot_keep', now: 1,
      meta: { snapshot_at: 1, snapshot_hash: 'h', name: 'Kept deal', close_state: 'open' },
    });
    const handlers = buildChatTier1Handlers(s3Deps(null, null)); // stale, but live returns null
    const result = await handlers['deal.search']!({ query: 'Kept', limit: 10 }, ctxInternal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as {
      candidates: Array<{ record: { target_id: string } }>;
      crm_freshness: Array<{ filter_applied?: string }>;
    };
    expect(r.candidates.map((c) => c.record.target_id)).toEqual(['hubspot_deal_acme-hubspot_keep']);
    expect(r.crm_freshness[0]!.filter_applied).toBe('local');
  });

  // ── Codex S3 review folds (Q3 meta-faithful matching + Q1 source-gated merge) ──

  it('Q3 — a LIVE deal with NO name does NOT match via its composed target_id (mirror SQL would not)', async () => {
    // Stale → escalates. The live record has NO `name`; its native id `Acme-1` makes the
    // composed target_id `hubspot_deal_acme-hubspot_Acme-1` (contains "acme"). The OLD
    // candidate-based matcher fell back name→target_id and matched query "Acme"; the new
    // meta-based matcher does not (`json_extract(meta,'$.name')` is NULL → no match).
    const live = new Map<string, Record<string, unknown>>([
      ['Acme-1', { snapshot_at: 1, snapshot_hash: 'h', close_state: 'open' }], // no name
    ]);
    const handlers = buildChatTier1Handlers(s3Deps(null, live));
    const result = await handlers['deal.search']!({ query: 'Acme', limit: 10 }, ctxInternal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as { candidates: Array<{ record: { target_id: string } }> };
    expect(r.candidates.map((c) => c.record.target_id)).not.toContain('hubspot_deal_acme-hubspot_Acme-1');
    expect(r.candidates).toHaveLength(0); // empty mirror + no live name-match
  });

  it('Q3 — contact email_exact is CASE-INSENSITIVE on the live leg (mirrors LOWER(...) SQL)', async () => {
    // Stale contact connection → escalates. The live record carries a MIXED-CASE email;
    // the user searches the lowercase form. A raw `===` (old) rejected it; the meta-based
    // matcher lowercases both, like `LOWER(json_extract(meta,'$.email')) = LOWER(?)`.
    const live = new Map<string, Record<string, unknown>>([
      ['c1', { snapshot_at: 1, snapshot_hash: 'h', email: 'Jordan@Initech.com', name: 'Jordan' }],
    ]);
    const handlers = buildChatTier1Handlers(contactS3Deps(null, live));
    const result = await handlers['contact.search']!({ email: 'jordan@initech.com', limit: 10 }, ctxInternal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as { candidates: Array<{ record: { target_id: string } }> };
    expect(r.candidates.map((c) => c.record.target_id)).toContain('hubspot_contact_acme-hubspot_c1');
  });

  it('Q1 — a LOCAL contact whose email coincidentally starts with an escalated CRM prefix is NOT dropped', async () => {
    // Contrived but possible: a local data.contact row whose email LITERALLY starts with
    // the escalated connection's `hubspot_contact_acme-hubspot_` prefix. The merge drop is
    // gated on the PLATFORM source id (`source==='hubspot'`), so the local row (source
    // 'local') survives — a prefix-only filter (old) would have wrongly dropped it.
    const coincidental = 'hubspot_contact_acme-hubspot_jane@example.com';
    const contactStore = {
      get: (email: string) => (email === coincidental ? { email: coincidental, name: 'Jane' } : null),
      list: () => [],
    };
    const live = new Map<string, Record<string, unknown>>(); // empty → conn escalates with 0 live rows
    const handlers = buildChatTier1Handlers(contactS3Deps(null, live, contactStore));
    const result = await handlers['contact.search']!({ email: coincidental, limit: 10 }, ctxInternal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as { candidates: Array<{ record: { target_id: string } }> };
    expect(r.candidates.map((c) => c.record.target_id)).toContain(coincidental);
  });
});
