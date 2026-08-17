/** D-139 P5 — engagement resolver exposure (WS-rpc + MCP).
 *
 *  Wires the already-built `resolveEngagementsForContact` resolver to two
 *  production surfaces and closes the two deferred D-184 MEDs:
 *    1. live `resolveMailTwins` join now runs in production (cross-account
 *       union over `data.mail`);
 *    2. `projectEngagementRowForMCP` now copies the resolver-layer fields
 *       (`vendor_twins` / `mail_twin_id` / `dedupe_candidates` /
 *       `dedupe_candidates_truncated`) onto the MCP projection.
 *
 *  Covers: the projection broadening (body still stripped by default),
 *  honest coverage (incl. the connection-scoped fold), the shared
 *  validation/resolve core + registered-client gate, the MCP body-strip +
 *  field-copy + live mail-twin flip, the cross-account mail union, and the
 *  per-token tool-checklist gate.
 *
 *  Spec: D-139 § A.5.1 + § P1a.1 + § A.9.5. */

import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

import {
  RpcError,
  projectEngagementRowForMCP,
  type EngagementRow,
  type EngagementsResolverRow,
} from '@recued/contracts';
import {
  createEngagementStore,
  type EngagementStore,
  type MailTwinResolver,
} from '../storage/engagement-store.js';
import type {
  BackoffState,
  BudgetUsage,
  EngagementRateControlStore,
} from '../storage/engagement-rate-control-store.js';
import { createCollectionTable } from '../collections/table.js';
import { buildRecord } from '../collections/mail/mail-collection.js';
import { createMailUnionTwinResolver } from '../collections/mail/mail-union-twin-resolver.js';
import {
  buildEngagementsResolverDeps,
  buildEngagementCoverage,
  ENGAGEMENT_SOURCE_STALENESS_MS,
  type EngagementsResolverDepsInput,
} from '../engagement-resolver-deps.js';
import {
  projectEngagementsResolverArgs,
  runContactEngagementsResolver,
  makeContactEngagementsRpcHandlers,
  type ContactEngagementsResolveDeps,
} from '../contact-engagements-rpc-handler.js';
import { handleContactEngagementsList } from '../mcp/contact-engagements.js';
import { _testing } from '../mcp-server.js';

const NOW = 1_714_867_300_000;
const EVENT_AT = 1_714_867_200_000;
const BUCKET_STARTED_AT = NOW - 3_600_000; // 1h into the current daily bucket
const inMemoryDb = (): Database.Database => new Database(':memory:');

/** Fake rate-control store for the `sources_degraded` axis. `usage`
 *  overrides the per-(connection, vendor) budget tier; `backoff` maps an
 *  entity name → its per-(connection, vendor, entity) 429 backoff override
 *  (entities absent from the map read as no-backoff). Both default to the
 *  at-full-reach `'normal'` / `next_attempt_at: 0` shape so a bare fake
 *  contributes nothing.
 *
 *  Key guard (Codex LOW fold) — the resolver MUST read keyed on the BARE
 *  connection name (`row.name`, e.g. `acme-hubspot`), matching the
 *  reconciler writer + the engagement substrate's canonical `connection_id`.
 *  The composite `row.pk` (`api:acme-hubspot`) would read a separate,
 *  always-`normal` seeded row in production. Reject any colon-bearing key so
 *  a `row.name → row.pk` regression FAILS instead of silently staying green. */
const assertBareConnectionId = (connection_id: string): void => {
  if (connection_id.includes(':')) {
    throw new Error(
      `rate-control read used the composite pk '${connection_id}'; expected the bare connection name`,
    );
  }
};
const fakeRateControlStore = (
  opts: {
    usage?: Partial<BudgetUsage>;
    backoff?: Record<string, Partial<BackoffState>>;
  } = {},
): Pick<EngagementRateControlStore, 'readUsage' | 'readBackoff'> => ({
  readUsage: ({ connection_id, vendor }) => {
    assertBareConnectionId(connection_id);
    return {
      connection_id,
      vendor,
      daily_budget: 250_000,
      calls_today: 0,
      bucket_started_at: BUCKET_STARTED_AT,
      budget_utilization_pct: 0,
      rate_control_state: 'normal',
      ...opts.usage,
    };
  },
  readBackoff: ({ connection_id, vendor, entity }) => {
    assertBareConnectionId(connection_id);
    return {
      connection_id,
      vendor,
      entity,
      consecutive_429s: 0,
      last_429_at: null,
      next_attempt_at: 0,
      ...(opts.backoff?.[entity] ?? {}),
    };
  },
});

// ── Fakes ──────────────────────────────────────────────────────────

/** Minimal contact store — non-merged identity by default. */
const fakeContactStore = (
  members: Record<string, string[]> = {},
): EngagementsResolverDepsInput['contactStore'] => ({
  get: () => null,
  // D-205 #3.5b — addressSet is the COMPLETE set (survivor INCLUDED), where
  // listMergedSourceEmails returned only what merged AWAY into it.
  addressSet: (survivor: string) =>
    [...new Set([survivor, ...(members[survivor] ?? [])])].sort(),
});

/** Minimal connection store over a fixed `(name, vendor)` list. */
const fakeConnectionStore = (
  conns: ReadonlyArray<{ name: string; vendor: string }>,
): EngagementsResolverDepsInput['connectionStore'] => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  list: (() =>
    conns.map((c) => ({
      pk: `api:${c.name}`,
      kind: 'api',
      name: c.name,
      display_name: c.name,
      config_json: JSON.stringify({ vendor: c.vendor }),
      auth_ciphertext: '',
      enrolled_at: 0,
      updated_at: 0,
    }))) as EngagementsResolverDepsInput['connectionStore']['list'],
});

const emailRow = (overrides: Partial<EngagementRow> = {}): EngagementRow => ({
  connection_id: 'acme-hubspot',
  target_id: 'hubspot_email_1',
  vendor: 'hubspot',
  entity: 'email',
  meta: { message_id: '<msg-1@example.com>' },
  mirror_blob_hash: null,
  authorship: 'user',
  direction: 'outbound',
  dedupe_confidence: 'none',
  lifecycle_state: 'point_in_time',
  event_at: EVENT_AT,
  vendor_created_at: EVENT_AT,
  vendor_modified_at: EVENT_AT + 500,
  ingested_at: EVENT_AT + 600,
  body_state: 'inline_body',
  body_inline: 'CRM-side inline copy',
  vendor_raw_timestamp: '1714867200000',
  ...overrides,
});

const seedEmailEngagement = (
  store: EngagementStore,
  row: EngagementRow,
  contactEmail = 'bob@acme.com',
): void => {
  store.upsert({ row });
  store.upsertEdge({
    connection_id: row.connection_id,
    engagement_target_id: row.target_id,
    edge_type: 'contact',
    resolveContactRedirect: () => null,
    target_kind: 'data.contact',
    target_id: contactEmail,
    created_at: 1,
  });
};

/** Build a full bundle over a live engagement store + fakes. */
const makeBundle = (opts: {
  store: EngagementStore;
  db: Database.Database;
  conns?: ReadonlyArray<{ name: string; vendor: string }>;
  resolveMailTwins?: MailTwinResolver;
  rateControlStore?: Pick<EngagementRateControlStore, 'readUsage' | 'readBackoff'>;
}): ContactEngagementsResolveDeps => ({
  engagementStore: opts.store,
  resolverDeps: buildEngagementsResolverDeps({
    db: opts.db,
    contactStore: fakeContactStore(),
    connectionStore: fakeConnectionStore(opts.conns ?? [{ name: 'acme-hubspot', vendor: 'hubspot' }]),
    ...(opts.resolveMailTwins ? { resolveMailTwins: opts.resolveMailTwins } : {}),
    ...(opts.rateControlStore ? { rateControlStore: opts.rateControlStore } : {}),
    now: () => NOW,
  }),
});

const fixedTwinResolver =
  (map: Record<string, string>): MailTwinResolver =>
  (ids) => {
    const out = new Map<string, string>();
    for (const id of ids) if (map[id]) out.set(id, map[id]!);
    return out;
  };

// ────────────────────────────────────────────────────────────────
// 1. projectEngagementRowForMCP broadening (MED #2 + privacy)
// ────────────────────────────────────────────────────────────────

describe('D-139 P5 — projectEngagementRowForMCP', () => {
  it('strips body_inline + vendor_raw_timestamp by default; keeps body_truncation_offset', () => {
    const row: EngagementRow = emailRow({ body_truncation_offset: 8240 });
    const proj = projectEngagementRowForMCP(row);
    expect(proj.body_inline).toBeUndefined();
    expect(proj.vendor_raw_timestamp).toBeUndefined();
    expect(proj.body_truncation_offset).toBe(8240);
  });

  it('inlines body_inline + vendor_raw_timestamp ONLY when body_content_granted', () => {
    const row: EngagementRow = emailRow();
    const proj = projectEngagementRowForMCP(row, { body_content_granted: true });
    expect(proj.body_inline).toBe('CRM-side inline copy');
    expect(proj.vendor_raw_timestamp).toBe('1714867200000');
  });

  it('copies the resolver-layer fields when present (MED #2 regression guard)', () => {
    const row: EngagementsResolverRow = {
      ...emailRow(),
      vendor_twins: ['salesforce_email_9'],
      mail_twin_id: 'mail-rec-42',
      dedupe_candidates: [
        {
          candidate_connection_id: 'personal-sf',
          candidate_target_id: 'sf_email_2',
          match_key: 'message_id',
          confidence: 'probable',
        },
      ],
      dedupe_candidates_truncated: true,
    };
    const proj = projectEngagementRowForMCP(row);
    expect(proj.vendor_twins).toEqual(['salesforce_email_9']);
    expect(proj.mail_twin_id).toBe('mail-rec-42');
    expect(proj.dedupe_candidates).toHaveLength(1);
    expect(proj.dedupe_candidates_truncated).toBe(true);
    // ...and body is STILL stripped (ids are safe, content is not).
    expect(proj.body_inline).toBeUndefined();
  });

  it('a plain EngagementRow projects with no resolver-layer fields', () => {
    const proj = projectEngagementRowForMCP(emailRow());
    expect(proj.vendor_twins).toBeUndefined();
    expect(proj.mail_twin_id).toBeUndefined();
    expect(proj.dedupe_candidates).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// 2. buildEngagementCoverage — honest sources_connected (+ Codex fold)
// ────────────────────────────────────────────────────────────────

describe('D-139 P5 — buildEngagementCoverage', () => {
  it('lists a connected vendor with ZERO rows in sources_connected', () => {
    const db = inMemoryDb();
    createEngagementStore(db); // ensure schema, no rows
    const coverage = buildEngagementCoverage(
      { db, connectionStore: fakeConnectionStore([{ name: 'acme-hubspot', vendor: 'hubspot' }]), now: () => NOW },
      { email: 'bob@acme.com' },
      () => null,
      () => [],
    );
    expect(coverage.sources_connected).toContain('connection.api.hubspot.email');
    expect(coverage.sources_connected).toContain('connection.api.hubspot.meeting');
    expect(coverage.last_source_event_at).toBe(0);
    expect(coverage.row_counts).toEqual({});
  });

  it('the vendor filter narrows sources_connected to one vendor', () => {
    const db = inMemoryDb();
    createEngagementStore(db);
    const conns = [
      { name: 'acme-hubspot', vendor: 'hubspot' },
      { name: 'acme-sf', vendor: 'salesforce' },
    ];
    const cov = buildEngagementCoverage(
      { db, connectionStore: fakeConnectionStore(conns), now: () => NOW },
      { email: 'bob@acme.com', vendor: 'salesforce' },
      () => null,
      () => [],
    );
    expect(cov.sources_connected.some((s) => s.startsWith('connection.api.salesforce.'))).toBe(true);
    expect(cov.sources_connected.some((s) => s.startsWith('connection.api.hubspot.'))).toBe(false);
  });

  it('a connection-scoped query reports ONLY the scoped connection (Codex MED fold)', () => {
    const db = inMemoryDb();
    createEngagementStore(db);
    // A HubSpot + a Salesforce connection enrolled; query scoped to the
    // HubSpot one with NO vendor filter. Without the connection_id fold the
    // Salesforce scopes would leak into sources_connected (only the vendor
    // filter was applied before); with the fold, only acme-hubspot's scopes
    // survive — distinguishing folded from unfolded behavior.
    const conns = [
      { name: 'acme-hubspot', vendor: 'hubspot' },
      { name: 'acme-sf', vendor: 'salesforce' },
    ];
    const cov = buildEngagementCoverage(
      { db, connectionStore: fakeConnectionStore(conns), now: () => NOW },
      { email: 'bob@acme.com', connection_id: 'acme-hubspot' },
      () => null,
      () => [],
    );
    expect(cov.sources_connected.every((s) => s.startsWith('connection.api.hubspot.'))).toBe(true);
    expect(cov.sources_connected.some((s) => s.startsWith('connection.api.salesforce.'))).toBe(false);
    expect(cov.sources_connected).toHaveLength(5);
  });

  it('row_counts + last_source_event_at reflect the contact\'s rows', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    seedEmailEngagement(store, emailRow());
    const cov = buildEngagementCoverage(
      { db, connectionStore: fakeConnectionStore([{ name: 'acme-hubspot', vendor: 'hubspot' }]), now: () => NOW },
      { email: 'bob@acme.com' },
      () => null,
      () => [],
    );
    expect(cov.row_counts['connection.api.hubspot.email']).toBe(1);
    expect(cov.last_source_event_at).toBe(EVENT_AT);
  });

  // ── sources_degraded — the third honesty tier (rate-control) ──────

  it('no rateControlStore wired → sources_degraded is [] (v1 behavior)', () => {
    const db = inMemoryDb();
    createEngagementStore(db);
    const cov = buildEngagementCoverage(
      { db, connectionStore: fakeConnectionStore([{ name: 'acme-hubspot', vendor: 'hubspot' }]), now: () => NOW },
      { email: 'bob@acme.com' },
      () => null,
      () => [],
    );
    expect(cov.sources_degraded).toEqual([]);
  });

  it('normal budget + no backoff → sources_degraded stays empty', () => {
    const db = inMemoryDb();
    createEngagementStore(db);
    const cov = buildEngagementCoverage(
      {
        db,
        connectionStore: fakeConnectionStore([{ name: 'acme-hubspot', vendor: 'hubspot' }]),
        rateControlStore: fakeRateControlStore(),
        now: () => NOW,
      },
      { email: 'bob@acme.com' },
      () => null,
      () => [],
    );
    expect(cov.sources_degraded).toEqual([]);
  });

  it('budget suspended → quota_suspended for EVERY scope of the connection', () => {
    const db = inMemoryDb();
    createEngagementStore(db);
    const cov = buildEngagementCoverage(
      {
        db,
        connectionStore: fakeConnectionStore([{ name: 'acme-hubspot', vendor: 'hubspot' }]),
        rateControlStore: fakeRateControlStore({ usage: { rate_control_state: 'suspended' } }),
        now: () => NOW,
      },
      { email: 'bob@acme.com' },
      () => null,
      () => [],
    );
    // HubSpot ships 5 engagement entities → 5 degraded scopes.
    expect(cov.sources_degraded).toHaveLength(5);
    expect(cov.sources_degraded.every((d) => d.reason === 'quota_suspended')).toBe(true);
    const emailDeg = cov.sources_degraded.find(
      (d) => d.source === 'connection.api.hubspot.email',
    );
    expect(emailDeg?.since).toBe(BUCKET_STARTED_AT);
    expect(emailDeg?.detail).toBeUndefined();
  });

  it('budget degraded_30m → rate_limit_active carrying a budget-% detail', () => {
    const db = inMemoryDb();
    createEngagementStore(db);
    const cov = buildEngagementCoverage(
      {
        db,
        connectionStore: fakeConnectionStore([{ name: 'acme-hubspot', vendor: 'hubspot' }]),
        rateControlStore: fakeRateControlStore({
          usage: { rate_control_state: 'degraded_30m', budget_utilization_pct: 0.86 },
        }),
        now: () => NOW,
      },
      { email: 'bob@acme.com' },
      () => null,
      () => [],
    );
    expect(cov.sources_degraded).toHaveLength(5);
    expect(cov.sources_degraded.every((d) => d.reason === 'rate_limit_active')).toBe(true);
    const emailDeg = cov.sources_degraded.find(
      (d) => d.source === 'connection.api.hubspot.email',
    );
    expect(emailDeg?.detail).toContain('86%');
    expect(emailDeg?.since).toBe(BUCKET_STARTED_AT);
  });

  it('an active 429 backoff → rate_limit_active for ONLY that entity scope', () => {
    const db = inMemoryDb();
    createEngagementStore(db);
    const cov = buildEngagementCoverage(
      {
        db,
        connectionStore: fakeConnectionStore([{ name: 'acme-hubspot', vendor: 'hubspot' }]),
        rateControlStore: fakeRateControlStore({
          backoff: {
            email: { next_attempt_at: NOW + 60_000, last_429_at: NOW - 30_000, consecutive_429s: 2 },
          },
        }),
        now: () => NOW,
      },
      { email: 'bob@acme.com' },
      () => null,
      () => [],
    );
    expect(cov.sources_degraded).toHaveLength(1);
    const deg = cov.sources_degraded[0]!;
    expect(deg.source).toBe('connection.api.hubspot.email');
    expect(deg.reason).toBe('rate_limit_active');
    expect(deg.since).toBe(NOW - 30_000); // last_429_at, not now
  });

  it('an EXPIRED backoff (next_attempt_at <= now) does NOT degrade', () => {
    const db = inMemoryDb();
    createEngagementStore(db);
    const cov = buildEngagementCoverage(
      {
        db,
        connectionStore: fakeConnectionStore([{ name: 'acme-hubspot', vendor: 'hubspot' }]),
        rateControlStore: fakeRateControlStore({
          backoff: { email: { next_attempt_at: NOW - 1, last_429_at: NOW - 60_000 } },
        }),
        now: () => NOW,
      },
      { email: 'bob@acme.com' },
      () => null,
      () => [],
    );
    expect(cov.sources_degraded).toEqual([]);
  });

  it('suspended budget OUTRANKS a concurrent per-entity backoff (dedup precedence)', () => {
    const db = inMemoryDb();
    createEngagementStore(db);
    const cov = buildEngagementCoverage(
      {
        db,
        connectionStore: fakeConnectionStore([{ name: 'acme-hubspot', vendor: 'hubspot' }]),
        rateControlStore: fakeRateControlStore({
          usage: { rate_control_state: 'suspended' },
          backoff: { email: { next_attempt_at: NOW + 60_000, last_429_at: NOW - 30_000 } },
        }),
        now: () => NOW,
      },
      { email: 'bob@acme.com' },
      () => null,
      () => [],
    );
    // 5 scopes, all quota_suspended — the email scope is NOT downgraded to
    // rate_limit_active by its concurrent backoff, and is not duplicated.
    expect(cov.sources_degraded).toHaveLength(5);
    const emailDegs = cov.sources_degraded.filter(
      (d) => d.source === 'connection.api.hubspot.email',
    );
    expect(emailDegs).toHaveLength(1);
    expect(emailDegs[0]!.reason).toBe('quota_suspended');
  });

  it('the vendor filter excludes a non-matching vendor from sources_degraded', () => {
    const db = inMemoryDb();
    createEngagementStore(db);
    const cov = buildEngagementCoverage(
      {
        db,
        connectionStore: fakeConnectionStore([
          { name: 'acme-hubspot', vendor: 'hubspot' },
          { name: 'acme-sf', vendor: 'salesforce' },
        ]),
        rateControlStore: fakeRateControlStore({ usage: { rate_control_state: 'suspended' } }),
        now: () => NOW,
      },
      { email: 'bob@acme.com', vendor: 'salesforce' },
      () => null,
      () => [],
    );
    expect(cov.sources_degraded.length).toBeGreaterThan(0);
    expect(
      cov.sources_degraded.every((d) => d.source.startsWith('connection.api.salesforce.')),
    ).toBe(true);
  });

  // ── sources_stale — freshest contact-scoped event older than window ───

  const STALE_EVENT_AT = NOW - ENGAGEMENT_SOURCE_STALENESS_MS - 1; // just over
  const hubspotConn = () => fakeConnectionStore([{ name: 'acme-hubspot', vendor: 'hubspot' }]);

  it('a source whose freshest event is older than the window → sources_stale', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    seedEmailEngagement(store, emailRow({ event_at: STALE_EVENT_AT }));
    const cov = buildEngagementCoverage(
      { db, connectionStore: hubspotConn(), now: () => NOW },
      { email: 'bob@acme.com' },
      () => null,
      () => [],
    );
    expect(cov.sources_stale).toHaveLength(1);
    const s = cov.sources_stale[0]!;
    expect(s.source).toBe('connection.api.hubspot.email');
    expect(s.last_event_at).toBe(STALE_EVENT_AT);
    expect(s.staleness_threshold_ms).toBe(ENGAGEMENT_SOURCE_STALENESS_MS);
  });

  it('a source with a fresh event is NOT stale', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    seedEmailEngagement(store, emailRow({ event_at: NOW - 1000 }));
    const cov = buildEngagementCoverage(
      { db, connectionStore: hubspotConn(), now: () => NOW },
      { email: 'bob@acme.com' },
      () => null,
      () => [],
    );
    expect(cov.sources_stale).toEqual([]);
  });

  it('an event exactly at the staleness boundary is NOT stale (strict <)', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    seedEmailEngagement(store, emailRow({ event_at: NOW - ENGAGEMENT_SOURCE_STALENESS_MS }));
    const cov = buildEngagementCoverage(
      { db, connectionStore: hubspotConn(), now: () => NOW },
      { email: 'bob@acme.com' },
      () => null,
      () => [],
    );
    expect(cov.sources_stale).toEqual([]);
  });

  it('a source whose rows all carry NULL event_at is unjudgeable, not stale', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    seedEmailEngagement(store, emailRow({ event_at: null }));
    const cov = buildEngagementCoverage(
      { db, connectionStore: hubspotConn(), now: () => NOW },
      { email: 'bob@acme.com' },
      () => null,
      () => [],
    );
    expect(cov.sources_stale).toEqual([]);
    // ...but it still counts as a present source with a row.
    expect(cov.row_counts['connection.api.hubspot.email']).toBe(1);
  });

  it('flags ONLY the stale source when a fresh sibling source exists', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    seedEmailEngagement(store, emailRow({ event_at: STALE_EVENT_AT }));
    seedEmailEngagement(
      store,
      emailRow({ target_id: 'hubspot_meeting_1', entity: 'meeting', event_at: NOW - 1000 }),
    );
    const cov = buildEngagementCoverage(
      { db, connectionStore: hubspotConn(), now: () => NOW },
      { email: 'bob@acme.com' },
      () => null,
      () => [],
    );
    expect(cov.sources_stale.map((s) => s.source)).toEqual([
      'connection.api.hubspot.email',
    ]);
  });

  it('sources_stale is empty when the contact has no rows', () => {
    const db = inMemoryDb();
    createEngagementStore(db); // schema only, no rows
    const cov = buildEngagementCoverage(
      { db, connectionStore: hubspotConn(), now: () => NOW },
      { email: 'bob@acme.com' },
      () => null,
      () => [],
    );
    expect(cov.sources_stale).toEqual([]);
  });

  it('multiple stale sources are returned sorted by source, each with its own last_event_at (Codex sort pin)', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    const meetingStaleAt = NOW - ENGAGEMENT_SOURCE_STALENESS_MS - 5000;
    const emailStaleAt = NOW - ENGAGEMENT_SOURCE_STALENESS_MS - 1000;
    // Seed `meeting` first, `email` second — insertion order is NOT the
    // sorted order, so a dropped sort would surface as a wrong sequence.
    seedEmailEngagement(
      store,
      emailRow({ target_id: 'hubspot_meeting_1', entity: 'meeting', event_at: meetingStaleAt }),
    );
    seedEmailEngagement(store, emailRow({ event_at: emailStaleAt }));
    const cov = buildEngagementCoverage(
      { db, connectionStore: hubspotConn(), now: () => NOW },
      { email: 'bob@acme.com' },
      () => null,
      () => [],
    );
    expect(cov.sources_stale.map((s) => s.source)).toEqual([
      'connection.api.hubspot.email',
      'connection.api.hubspot.meeting',
    ]);
    const byScope = Object.fromEntries(
      cov.sources_stale.map((s) => [s.source, s.last_event_at] as const),
    );
    expect(byScope['connection.api.hubspot.email']).toBe(emailStaleAt);
    expect(byScope['connection.api.hubspot.meeting']).toBe(meetingStaleAt);
  });
});

// ────────────────────────────────────────────────────────────────
// 3. WS-rpc core — arg validation + full-shape resolve + slice gate
// ────────────────────────────────────────────────────────────────

describe('D-139 P5 — projectEngagementsResolverArgs', () => {
  it('requires email', () => {
    expect(() => projectEngagementsResolverArgs({})).toThrow(RpcError);
    expect(() => projectEngagementsResolverArgs({ email: '' })).toThrow(/email is required/);
  });

  it('passes any non-empty vendor through as an opaque filter (D-192)', () => {
    // The closed-union vendor gate was dropped: vendor is a pass-through filter
    // like `authorship` / `direction` — the resolver SQL is fully parameterized,
    // so an out-of-registry vendor simply matches no rows (a pack-declared
    // engagement vendor filters correctly with no code edit). Empty is ignored.
    expect(
      projectEngagementsResolverArgs({ email: 'a@b.com', vendor: 'pipedrive' }).vendor,
    ).toBe('pipedrive');
    expect(
      projectEngagementsResolverArgs({ email: 'a@b.com', vendor: '' }).vendor,
    ).toBeUndefined();
  });

  it('projects only recognized fields with correct types', () => {
    const args = projectEngagementsResolverArgs({
      email: 'a@b.com',
      since: 1,
      vendor: 'hubspot',
      authorship: ['user'],
      dedupe_acceptance: 'all',
      bogus: 'dropped',
      page_size: '50', // wrong type → dropped
    });
    expect(args).toEqual({
      email: 'a@b.com',
      since: 1,
      vendor: 'hubspot',
      authorship: ['user'],
      dedupe_acceptance: 'all',
    });
  });
});

describe('D-139 P5 — runContactEngagementsResolver', () => {
  it('returns the FULL row shape (body present) for the owner channel', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    seedEmailEngagement(store, emailRow());
    const result = runContactEngagementsResolver(makeBundle({ store, db }), {
      email: 'bob@acme.com',
      since: 0,
    });
    expect(result.engagements).toHaveLength(1);
    expect(result.engagements[0]!.body_inline).toBe('CRM-side inline copy');
    expect(result.coverage.sources_connected).toContain('connection.api.hubspot.email');
  });

  it('maps a bad cursor onto RpcError(bad_request)', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    expect(() =>
      runContactEngagementsResolver(makeBundle({ store, db }), {
        email: 'bob@acme.com',
        cursor: 'not-a-valid-cursor',
      }),
    ).toThrow(RpcError);
  });

  it('threads rateControlStore through the bundle into coverage.sources_degraded', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    seedEmailEngagement(store, emailRow());
    const result = runContactEngagementsResolver(
      makeBundle({
        store,
        db,
        rateControlStore: fakeRateControlStore({ usage: { rate_control_state: 'suspended' } }),
      }),
      { email: 'bob@acme.com', since: 0 },
    );
    expect(
      result.coverage.sources_degraded.some(
        (d) => d.source === 'connection.api.hubspot.email' && d.reason === 'quota_suspended',
      ),
    ).toBe(true);
  });
});

describe('D-139 P5 — makeContactEngagementsRpcHandlers', () => {
  it('returns undefined when deps are absent', () => {
    expect(makeContactEngagementsRpcHandlers(undefined)).toBeUndefined();
  });

  it('rejects an unregistered WS client', async () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    const slice = makeContactEngagementsRpcHandlers(makeBundle({ store, db }))!;
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      slice.handlers['data.contact.engagements.list']({ email: 'bob@acme.com' } as any, {} as any),
    ).rejects.toThrow(/registered paired client/);
  });

  it('resolves for a registered client', async () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    seedEmailEngagement(store, emailRow());
    const slice = makeContactEngagementsRpcHandlers(makeBundle({ store, db }))!;
    const result = await slice.handlers['data.contact.engagements.list'](
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { email: 'bob@acme.com', since: 0 } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { instance_id: 'client-1' } as any,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).engagements).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────
// 4. MCP handler — body strip + field copy + live mail-twin flip
// ────────────────────────────────────────────────────────────────

describe('D-139 P5 — handleContactEngagementsList (MCP)', () => {
  it('strips body content from the projection', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    seedEmailEngagement(store, emailRow());
    const out = handleContactEngagementsList(makeBundle({ store, db }), {
      email: 'bob@acme.com',
      since: 0,
    });
    expect(out.engagements).toHaveLength(1);
    expect(out.engagements[0]!.body_inline).toBeUndefined();
    expect(out.engagements[0]!.vendor_raw_timestamp).toBeUndefined();
  });

  it('P6.B — inlines body content + vendor_raw_timestamp when body_content_granted', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    seedEmailEngagement(store, emailRow());
    const out = handleContactEngagementsList(
      makeBundle({ store, db }),
      { email: 'bob@acme.com', since: 0 },
      { body_content_granted: true },
    );
    expect(out.engagements[0]!.body_inline).toBe('CRM-side inline copy');
    expect(out.engagements[0]!.vendor_raw_timestamp).toBe('1714867200000');
  });

  it('P6.B — body_content_granted:false strips exactly like the default', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    seedEmailEngagement(store, emailRow());
    const out = handleContactEngagementsList(
      makeBundle({ store, db }),
      { email: 'bob@acme.com', since: 0 },
      { body_content_granted: false },
    );
    expect(out.engagements[0]!.body_inline).toBeUndefined();
    expect(out.engagements[0]!.vendor_raw_timestamp).toBeUndefined();
  });

  it('flips body_state → mail_link, sets mail_twin_id, drops body when a twin exists (MED #1 e2e)', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    seedEmailEngagement(store, emailRow()); // meta.message_id = <msg-1@example.com>
    const out = handleContactEngagementsList(
      makeBundle({
        store,
        db,
        resolveMailTwins: fixedTwinResolver({ '<msg-1@example.com>': 'mail-rec-1' }),
      }),
      { email: 'bob@acme.com', since: 0 },
    );
    const row = out.engagements[0]!;
    expect(row.body_state).toBe('mail_link');
    expect(row.mail_twin_id).toBe('mail-rec-1'); // copied onto the MCP projection
    expect(row.body_inline).toBeUndefined();
    expect(row.body_truncation_offset).toBeUndefined();
  });

  it('CASE 2 — no twin resolver wired → row keeps its as-ingested body_state', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    seedEmailEngagement(store, emailRow());
    const out = handleContactEngagementsList(makeBundle({ store, db }), {
      email: 'bob@acme.com',
      since: 0,
    });
    expect(out.engagements[0]!.body_state).toBe('inline_body');
    expect(out.engagements[0]!.mail_twin_id).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// 5. Cross-account mail union twin resolver
// ────────────────────────────────────────────────────────────────

describe('D-139 P5 — createMailUnionTwinResolver', () => {
  const seedMail = (
    db: Database.Database,
    slug: string,
    msgId: string,
    receivedAt: number,
  ): string => {
    const table = createCollectionTable({ db, platform: 'mail', slug });
    const { record } = buildRecord(
      {
        source_id: `uid@${slug}`,
        rfc_message_id: msgId,
        from: 'bob@acme.com',
        to: ['alice@recued.com'],
        cc: [],
        subject: 's',
        thread_id: 't',
        folder_or_label: 'INBOX',
        is_read: true,
        is_flagged: false,
        has_attachments: false,
        received_at: receivedAt,
        body_text: 'body',
      },
      () => NOW,
    );
    table.upsert(record);
    return record.record_id;
  };

  it('finds a Message-ID stored in a DIFFERENT account table', () => {
    const db = inMemoryDb();
    seedMail(db, 'work', '<other@example.com>', 1000);
    const recId = seedMail(db, 'personal', '<target@example.com>', 2000);
    const map = createMailUnionTwinResolver(db)(['<target@example.com>']);
    expect(map.get('<target@example.com>')).toBe(recId);
  });

  it('picks the most-recent row across accounts for a shared Message-ID', () => {
    const db = inMemoryDb();
    seedMail(db, 'work', '<dup@example.com>', 1000);
    const newer = seedMail(db, 'personal', '<dup@example.com>', 2000);
    const map = createMailUnionTwinResolver(db)(['<dup@example.com>']);
    expect(map.get('<dup@example.com>')).toBe(newer);
  });

  it('returns empty when no mail accounts exist (CRM-only)', () => {
    const db = inMemoryDb();
    createEngagementStore(db); // unrelated table present, no mail tables
    expect(createMailUnionTwinResolver(db)(['<x@example.com>']).size).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// 6. MCP per-token tool-checklist gate
// ────────────────────────────────────────────────────────────────

describe('D-139 P5 — recued_contactEngagementsList per-token gate', () => {
  it('is rejected when inboundTokenAuthorize denies the tool', async () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    const res = (await _testing.handleToolCall(
      { name: 'recued_contactEngagementsList', arguments: { email: 'bob@acme.com' } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {
        // ⛔ NO `ownerAdmitAll` HERE, deliberately. This test's whole subject is
        // that the checklist REFUSES, and the owner claim outranks the checklist
        // — adding it (a blanket fixture sweep did, and this test caught it)
        // turns a refusal assertion into a test of nothing.
        engagementsResolveDeps: makeBundle({ store, db }),
        inboundTokenAuthorize: () => false,
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    )) as any;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/per-tool checklist/);
  });

  it('returns "not configured" when the resolver bundle is absent', async () => {
    const res = (await _testing.handleToolCall(
      { name: 'recued_contactEngagementsList', arguments: { email: 'bob@acme.com' } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // D-228 slice 6 — the owner claim is what keeps this test's subject alive:
      // "resolver bundle absent" must be the reason for the error, not "no
      // checklist". Without it the tool gate refuses first and the assertion
      // below would pass on the wrong message.
      { ownerAdmitAll: true } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    )) as any;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not configured/);
  });

  it('dispatches + body-strips when granted (no gate)', async () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    seedEmailEngagement(store, emailRow());
    const res = (await _testing.handleToolCall(
      { name: 'recued_contactEngagementsList', arguments: { email: 'bob@acme.com', since: 0 } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { ownerAdmitAll: true, engagementsResolveDeps: makeBundle({ store, db }) } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    )) as any;
    expect(res.isError).toBeUndefined();
    const payload = JSON.parse(res.content[0].text);
    expect(payload.engagements).toHaveLength(1);
    expect(payload.engagements[0].body_inline).toBeUndefined();
  });

  it('P6.B — body INLINED when the body-visibility store grants the registry key', async () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    seedEmailEngagement(store, emailRow());
    const res = (await _testing.handleToolCall(
      { name: 'recued_contactEngagementsList', arguments: { email: 'bob@acme.com', since: 0 } },
      {
        // D-228 slice 6 — owner principal declared; absent now denies.
        ownerAdmitAll: true,
        engagementsResolveDeps: makeBundle({ store, db }),
        // Server-scoped grant present (as if crm-commitment-tracker installed).
        mcpBodyVisibilityStore: { isGranted: () => true },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    )) as any;
    expect(res.isError).toBeUndefined();
    const payload = JSON.parse(res.content[0].text);
    expect(payload.engagements[0].body_inline).toBe('CRM-side inline copy');
    expect(payload.engagements[0].vendor_raw_timestamp).toBe('1714867200000');
  });

  it('P6.B — body STRIPPED when the store denies the key', async () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    seedEmailEngagement(store, emailRow());
    const res = (await _testing.handleToolCall(
      { name: 'recued_contactEngagementsList', arguments: { email: 'bob@acme.com', since: 0 } },
      {
        // D-228 slice 6 — owner principal declared; absent now denies.
        ownerAdmitAll: true,
        engagementsResolveDeps: makeBundle({ store, db }),
        mcpBodyVisibilityStore: { isGranted: () => false },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    )) as any;
    expect(res.isError).toBeUndefined();
    const payload = JSON.parse(res.content[0].text);
    expect(payload.engagements[0].body_inline).toBeUndefined();
  });
});
