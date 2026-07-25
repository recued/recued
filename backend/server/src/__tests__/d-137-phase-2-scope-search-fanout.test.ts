/** D-137 P2 § A.4 — Server-side read consolidation tests.
 *
 *  Covers the P2 acceptance set from D-137:
 *    - `contact.search` merges local + HubSpot — both return Peter;
 *      provenance per source preserved; dedup is the agent's concern
 *      (D-137 leaves multiple-source candidates in place, attributed).
 *    - HubSpot timeout partial result — HubSpot unreachable;
 *      `contact.search` returns local results + `partial: true` +
 *      `partial_failures: [{source: 'hubspot', reason: 'timeout'}]`.
 *    - `mail.search` local-only — searches `data.mail` without fan-out
 *      (mail mirrors fully locally; covered in Trio #A test for shape).
 *    - Settings toggle — Mary disables HubSpot for `contact.search`;
 *      subsequent calls skip HubSpot (source-skip path is silent — no
 *      partial_failure since the user explicitly opted out).
 *
 *  Tests use the deps-stub pattern from `d-137-trio-a-chat-tool-
 *  handlers.test.ts`. Stores return per-test fixtures; the fan-out
 *  runner composes the result envelope. */

import { describe, it, expect } from 'vitest';
import type { ChatDispatchContext } from '@recued/contracts';
import {
  buildChatTier1Handlers,
  type ChatToolHandlerDeps,
} from '../chat-tool-handlers.js';

const ctxInternal = (session_id = 'sess-p2', turn_id = 'turn-p2'): ChatDispatchContext => ({
  channel: 'internal_function_call',
  session_id,
  turn_id,
});

/** D-137 P2 — deps stub with each store getter undefined by default
 *  (matches the Trio #A harness). Per-test overrides wire the
 *  fixtures relevant to each acceptance scenario. */
const buildDepsStub = (
  overrides: Partial<ChatToolHandlerDeps> = {},
): ChatToolHandlerDeps => {
  const deps: ChatToolHandlerDeps = {
    getContactStore: () => undefined,
    getCollectionRegistry: () => undefined,
    getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined,
    getRecipeStore: () =>
      ({
        ids: () => [],
        get: () => null,
        getStored: () => null,
        listStored: () => [],
      }) as never,
    getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
    getExecuteRecipe: () => undefined,
    // D-190 — the generic CRM-source enumerator. The stub returns the two built-in
    // CRM vendors (the old hardcoded fan-out set) per crm_alias, so the deal.search
    // AND contact.search tests exercise the same hubspot + salesforce union; per-test
    // overrides can vary it.
    getBoundCrmMirrorSources: (crmAlias) => {
      if (crmAlias === 'deal') {
        return [
          { source_id: 'hubspot', scope: 'connection.api.hubspot.deal' },
          { source_id: 'salesforce', scope: 'connection.api.salesforce.opportunity' },
        ];
      }
      if (crmAlias === 'contact') {
        return [
          { source_id: 'hubspot', scope: 'connection.api.hubspot.contact' },
          { source_id: 'salesforce', scope: 'connection.api.salesforce.contact' },
        ];
      }
      return [];
    },
    ...overrides,
  };
  // D-190 (generic reconciler MS3) — `deal.search` reads `getCrmRecordMirror().list`,
  // NOT the producer-gated enrichment store. These fan-out tests express their
  // per-vendor DEAL fixtures as a `getEnrichmentStore().listScopeMeta` fake; `list`
  // and `listScopeMeta` share the exact `(scope, opts) -> {scope,target_id,meta}[]`
  // contract (MS1 made `list` a drop-in repoint), so when a test doesn't stub the
  // mirror explicitly, adapt its enrichment fake into the mirror getter the deal
  // source now reads. `contact.search` still reads the enrichment store directly, so
  // its fixtures route there unchanged.
  if (deps.getCrmRecordMirror === undefined) {
    deps.getCrmRecordMirror = () => {
      const es = deps.getEnrichmentStore() as
        | { listScopeMeta: (scope: string, opts?: unknown) => unknown }
        | undefined;
      return es
        ? ({ list: (scope: string, opts?: unknown) => es.listScopeMeta(scope, opts) } as never)
        : undefined;
    };
  }
  return deps;
};

describe('D-137 P2 § A.4 — contact.search fan-out (local + hubspot + salesforce)', () => {
  it('merges local + HubSpot candidates with per-source provenance', async () => {
    // Peter exists in local contact store + HubSpot's mirrored data.
    // Acceptance: both surface as candidates; source labels preserved.
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getContactStore: () =>
          ({
            list: () => [
              {
                _id: 'peter@acme.com',
                email: 'peter@acme.com',
                name: 'Peter Local',
                last_interaction: 1_700_000_000_000,
              },
            ],
            get: () => null,
          }) as never,
        getEnrichmentStore: () =>
          ({
            listScopeMeta: (
              scope: string,
            ): Array<{ scope: string; target_id: string; meta: Record<string, unknown> }> => {
              if (scope === 'connection.api.hubspot.contact') {
                return [
                  {
                    scope,
                    target_id: 'hubspot_contact_47291',
                    meta: {
                      snapshot_at: 1_700_001_000_000,
                      snapshot_hash: 'fnv1a:peter',
                      email: 'peter@acme.com',
                      name: 'Peter HubSpot',
                      lifecycle_stage: 'customer',
                      recent_activity_at: 1_700_001_000_000,
                    },
                  },
                ];
              }
              return [];
            },
          }) as never,
      }),
    );
    const result = await handlers['contact.search']!(
      { query: 'Peter', limit: 10 },
      ctxInternal(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as {
      candidates: Array<{
        source: string;
        record: { email: string | null; name?: string; target_id: string };
      }>;
      partial?: boolean;
      partial_failures?: unknown;
    };
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates.map((c) => c.source).sort()).toEqual(['hubspot', 'local']);
    expect(r.candidates.find((c) => c.source === 'local')?.record.email).toBe('peter@acme.com');
    expect(r.candidates.find((c) => c.source === 'hubspot')?.record.name).toBe('Peter HubSpot');
    expect(r.partial).toBeUndefined();
    expect(r.partial_failures).toBeUndefined();
  });

  it('surfaces partial: true + partial_failures when HubSpot times out', async () => {
    // Acceptance scenario verbatim: HubSpot source throws (simulating
    // remote / store-level failure); local results still come through;
    // partial flag + failure entry surface so the agent's response can
    // tell the user "HubSpot was unavailable; here's what local has".
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getContactStore: () =>
          ({
            list: () => [
              { _id: 'peter@acme.com', email: 'peter@acme.com', name: 'Peter Local' },
            ],
            get: () => null,
          }) as never,
        getEnrichmentStore: () =>
          ({
            listScopeMeta: (scope: string) => {
              if (scope === 'connection.api.hubspot.contact') {
                throw new Error('timeout');
              }
              return [];
            },
          }) as never,
      }),
    );
    const result = await handlers['contact.search']!(
      { query: 'Peter', limit: 10 },
      ctxInternal(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as {
      candidates: Array<{ source: string }>;
      partial?: boolean;
      partial_failures?: Array<{ source: string; reason: string }>;
    };
    expect(r.candidates.map((c) => c.source)).toEqual(['local']);
    expect(r.partial).toBe(true);
    expect(r.partial_failures).toEqual([{ source: 'hubspot', reason: 'timeout' }]);
  });


  it('routes email arg through every source (email_exact pinned on platform mirrors)', async () => {
    // Acceptance plumbing: when the agent supplies an exact email, the
    // local source uses `ContactStore.get(email)` and the platform
    // sources thread `email_exact` into `listScopeMeta`. Both paths
    // surface results when they exist; both no-op when they don't.
    const localGet = (email: string) =>
      email === 'peter@acme.com'
        ? { _id: email, email, name: 'Peter Local' }
        : null;
    let lastHubspotEmail: string | undefined;
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getContactStore: () =>
          ({ list: () => [], get: (e: string) => localGet(e) }) as never,
        getEnrichmentStore: () =>
          ({
            listScopeMeta: (
              scope: string,
              opts: { email_exact?: string },
            ): unknown[] => {
              if (scope === 'connection.api.hubspot.contact') {
                lastHubspotEmail = opts.email_exact;
                if (opts.email_exact === 'peter@acme.com') {
                  return [
                    {
                      scope,
                      target_id: 'hubspot_contact_47291',
                      meta: {
                        snapshot_at: 1,
                        snapshot_hash: 'h',
                        email: 'peter@acme.com',
                        name: 'Peter HubSpot',
                      },
                    },
                  ];
                }
              }
              return [];
            },
          }) as never,
      }),
    );
    const result = await handlers['contact.search']!(
      { email: 'peter@acme.com' },
      ctxInternal(),
    );
    expect(result.ok).toBe(true);
    expect(lastHubspotEmail).toBe('peter@acme.com');
    if (!result.ok) return;
    const r = result.result as { candidates: Array<{ source: string }> };
    expect(r.candidates.map((c) => c.source).sort()).toEqual(['hubspot', 'local']);
  });
});

describe('D-137 P2 § A.4 — deal.search fan-out (HubSpot deals + Salesforce opportunities)', () => {
  it('merges HubSpot deals + Salesforce opportunities with per-source provenance', async () => {
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getEnrichmentStore: () =>
          ({
            listScopeMeta: (scope: string) => {
              if (scope === 'connection.api.hubspot.deal') {
                return [
                  {
                    scope,
                    target_id: 'hubspot_deal_47291',
                    meta: {
                      snapshot_at: 1,
                      snapshot_hash: 'h',
                      name: 'Acme Q3 expansion',
                      stage: 'closedwon',
                      amount: 120_000,
                      owner: 'mary@own.example',
                      close_state: 'won',
                      key_dates: { close_date: 1_700_500_000_000 },
                    },
                  },
                ];
              }
              if (scope === 'connection.api.salesforce.opportunity') {
                return [
                  {
                    scope,
                    target_id: 'salesforce_opportunity_006...',
                    meta: {
                      snapshot_at: 1,
                      snapshot_hash: 's',
                      name: 'Globex Q4 pilot',
                      stage: 'Negotiation',
                      amount: 75_000,
                      close_state: 'open',
                    },
                  },
                ];
              }
              return [];
            },
          }) as never,
      }),
    );
    const result = await handlers['deal.search']!(
      { query: 'Q3', limit: 10 },
      ctxInternal(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as {
      candidates: Array<{
        source: string;
        record: {
          name: string;
          amount?: number;
          stage?: string;
          close_date?: number;
          close_state?: string;
        };
      }>;
    };
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates.map((c) => c.source).sort()).toEqual(['hubspot', 'salesforce']);
    const hubspot = r.candidates.find((c) => c.source === 'hubspot')!;
    expect(hubspot.record.name).toBe('Acme Q3 expansion');
    expect(hubspot.record.amount).toBe(120_000);
    expect(hubspot.record.close_date).toBe(1_700_500_000_000);
    expect(hubspot.record.close_state).toBe('won');
  });

  it('partial: true when Salesforce throws but HubSpot returns', async () => {
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getEnrichmentStore: () =>
          ({
            listScopeMeta: (scope: string) => {
              if (scope === 'connection.api.hubspot.deal') {
                return [
                  {
                    scope,
                    target_id: 'hubspot_deal_47291',
                    meta: { snapshot_at: 1, snapshot_hash: 'h', name: 'Acme' },
                  },
                ];
              }
              throw new Error('rate_limited');
            },
          }) as never,
      }),
    );
    const result = await handlers['deal.search']!(
      { query: 'Acme', limit: 10 },
      ctxInternal(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as {
      candidates: Array<{ source: string }>;
      partial?: boolean;
      partial_failures?: Array<{ source: string; reason: string }>;
    };
    expect(r.candidates.map((c) => c.source)).toEqual(['hubspot']);
    expect(r.partial).toBe(true);
    expect(r.partial_failures).toEqual([
      { source: 'salesforce', reason: 'rate_limited' },
    ]);
  });

});

describe('D-137 P2 § A.4 Codex P2 fold — merged-limit clamp', () => {
  it('contact.search truncates merged candidates to the requested limit', async () => {
    // Three sources each return 5 rows for a `limit: 6` call. Pre-fold
    // behavior: 15 candidates returned (3×5). Post-fold: clamped to 6;
    // sequential ordering keeps local + first two HubSpot rows.
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getContactStore: () =>
          ({
            list: () =>
              Array.from({ length: 5 }, (_, i) => ({
                _id: `local${i}@example.com`,
                email: `local${i}@example.com`,
                name: `Local ${i}`,
              })),
            get: () => null,
          }) as never,
        getEnrichmentStore: () =>
          ({
            listScopeMeta: (scope: string) =>
              Array.from({ length: 5 }, (_, i) => ({
                scope,
                target_id: `${scope.split('.')[2]}_contact_${i}`,
                meta: {
                  snapshot_at: 1,
                  snapshot_hash: 'h',
                  email: `${scope.split('.')[2]}${i}@example.com`,
                  name: `${scope.split('.')[2]} ${i}`,
                },
              })),
          }) as never,
      }),
    );
    const result = await handlers['contact.search']!(
      { query: 'anything', limit: 6 },
      ctxInternal(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as { candidates: Array<{ source: string }> };
    expect(r.candidates).toHaveLength(6);
    // Sequential ordering preserved: 5 local + first 1 HubSpot.
    expect(r.candidates.filter((c) => c.source === 'local')).toHaveLength(5);
    expect(r.candidates.filter((c) => c.source === 'hubspot')).toHaveLength(1);
    expect(r.candidates.filter((c) => c.source === 'salesforce')).toHaveLength(0);
  });

  it('clamp preserves partial flag + partial_failures after truncation', async () => {
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getContactStore: () =>
          ({
            list: () =>
              Array.from({ length: 12 }, (_, i) => ({
                _id: `u${i}@example.com`,
                email: `u${i}@example.com`,
                name: `U${i}`,
              })),
            get: () => null,
          }) as never,
        getEnrichmentStore: () =>
          ({
            listScopeMeta: () => {
              throw new Error('connection_refused');
            },
          }) as never,
      }),
    );
    const result = await handlers['contact.search']!(
      { query: 'u', limit: 5 },
      ctxInternal(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as {
      candidates: Array<{ source: string }>;
      partial?: boolean;
      partial_failures?: Array<{ source: string; reason: string }>;
    };
    expect(r.candidates).toHaveLength(5);
    expect(r.partial).toBe(true);
    // Both platform sources fail, both surface; clamp doesn't drop
    // partial-failure entries.
    expect(r.partial_failures?.map((f) => f.source).sort()).toEqual([
      'hubspot',
      'salesforce',
    ]);
  });
});

describe('D-190 deal.search union slice — canonical filter threading + enum guard', () => {
  it('threads close_state + the close-date window into every vendor source as listScopeMeta opts', async () => {
    const seen: Array<{ scope: string; opts: unknown }> = [];
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getEnrichmentStore: () =>
          ({
            listScopeMeta: (scope: string, opts: unknown) => {
              seen.push({ scope, opts });
              return [];
            },
          }) as never,
      }),
    );
    const result = await handlers['deal.search']!(
      { close_state: 'won', close_since: 1000, close_until: 2000, limit: 10 },
      ctxInternal(),
    );
    expect(result.ok).toBe(true);
    // Both vendor sources fan out with the SAME canonical filter opts (the union
    // is filtered uniformly per the materialized-mirror model).
    expect(seen.map((s) => s.scope).sort()).toEqual([
      'connection.api.hubspot.deal',
      'connection.api.salesforce.opportunity',
    ]);
    for (const { opts } of seen) {
      expect(opts).toMatchObject({
        meta_equals: [{ path: '$.close_state', value: 'won' }],
        meta_ranges: [{ path: '$.key_dates.close_date', min: 1000, max: 2000 }],
      });
    }
  });

  it('rejects an out-of-enum close_state with the allowed list (substrate-support)', async () => {
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getEnrichmentStore: () =>
          ({ listScopeMeta: () => [] }) as never,
      }),
    );
    const result = await handlers['deal.search']!(
      { close_state: 'maybe' },
      ctxInternal(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_args');
    expect(result.detail).toContain('open, won, lost');
  });

  it('a name-only query carries no canonical filter opts (back-compat)', async () => {
    const seen: Array<unknown> = [];
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getEnrichmentStore: () =>
          ({
            listScopeMeta: (_scope: string, opts: unknown) => {
              seen.push(opts);
              return [];
            },
          }) as never,
      }),
    );
    await handlers['deal.search']!({ query: 'Acme', limit: 10 }, ctxInternal());
    for (const opts of seen) {
      expect(opts).not.toHaveProperty('meta_equals');
      expect(opts).not.toHaveProperty('meta_ranges');
      expect(opts).toMatchObject({ name_contains: 'Acme' });
    }
  });
});

describe('D-190 deal.search — generic CRM-source enumeration (no hardcoded vendors)', () => {
  it('fans out over WHATEVER getBoundCrmMirrorSources returns (e.g. a Pipedrive source)', async () => {
    // Pipedrive is NOT in the old hardcoded hubspot/salesforce list; the source comes
    // purely from the enumerator → it fans out, proving the vendor list is generic.
    const seen: string[] = [];
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getBoundCrmMirrorSources: (crmAlias) =>
          crmAlias === 'deal'
            ? [{ source_id: 'pipedrive', scope: 'connection.api.pipedrive.deal' }]
            : [],
        getEnrichmentStore: () =>
          ({
            listScopeMeta: (scope: string) => {
              seen.push(scope);
              return scope === 'connection.api.pipedrive.deal'
                ? [
                    {
                      scope,
                      target_id: 'pipedrive_deal_1',
                      meta: { snapshot_at: 1, snapshot_hash: 'p', name: 'Pipedrive deal' },
                    },
                  ]
                : [];
            },
          }) as never,
      }),
    );
    const result = await handlers['deal.search']!(
      { query: 'Pipedrive', limit: 10 },
      ctxInternal(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as {
      candidates: Array<{ source: string; record: { name: string } }>;
    };
    // ONLY the pipedrive scope was queried — no hardcoded hubspot/salesforce.
    expect(seen).toEqual(['connection.api.pipedrive.deal']);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.source).toBe('pipedrive');
    expect(r.candidates[0]!.record.name).toBe('Pipedrive deal');
  });

  it('returns zero candidates when no CRM connection is bound (empty source set)', async () => {
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getBoundCrmMirrorSources: () => [],
        getEnrichmentStore: () =>
          ({
            listScopeMeta: () => {
              throw new Error('should not be called');
            },
          }) as never,
      }),
    );
    const result = await handlers['deal.search']!(
      { query: 'Anything', limit: 10 },
      ctxInternal(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as { candidates: unknown[]; partial?: boolean };
    expect(r.candidates).toHaveLength(0);
    expect(r.partial).toBeUndefined();
  });
});
