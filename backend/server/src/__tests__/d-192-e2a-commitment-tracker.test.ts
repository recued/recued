/** D-192 email flagship E2a — `commitment_tracker` extraction producer.
 *
 *  The pure fan-in producer over a contact's engagement rows: filter →
 *  indexed prompt → ai-extract → validate+bind → per-contact value.
 *  Mirrors the D-139 P5 producer test harness (real `createEnrichmentStore`
 *  + a queued `llmWithMeta` mock). The standalone task + resolver walk are
 *  slice E2b. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COMMITMENT_TEXT_MAX_CHARS,
  COMMITMENT_TRACKER_COMMITMENTS_MAX,
  type Authorship,
  type CommitmentTrackerValue,
  type CoverageMetadata,
  type DedupeConfidence,
  type Direction,
  type EngagementLifecycleState,
  type EngagementVendor,
  type EngagementsResolverRow,
} from '@recued/contracts';

import {
  COMMITMENT_TRACKER_AUTHORED_BY,
  COMMITMENT_TRACKER_DEFAULT_CONFIDENCE,
  COMMITMENT_TRACKER_TOPIC,
  buildCommitmentPrompt,
  buildCommitmentTrackerValue,
  composeCommitmentId,
  engagementEvidenceSource,
  filterRowsForCommitmentTracker,
  processOneCommitmentTracker,
  validateCommitmentExtraction,
} from '../housekeeping/engagement-aggregates/commitment-tracker.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

const NOW = 1_714_867_200_000;
const day = 24 * 60 * 60 * 1000;
const CONTACT_SCOPE = 'connection.api.hubspot.contact' as const;
const CONTACT_TARGET = 'hubspot_contact_acme_99';
const SUBJECT = 'anna@acme.com';

const EMPTY_COVERAGE: CoverageMetadata = {
  sources_connected: ['connection.api.hubspot.email'],
  sources_unavailable: [],
  sources_stale: [],
  sources_degraded: [],
  row_counts: {},
  last_source_event_at: 0,
};

const buildRow = (
  overrides: Partial<EngagementsResolverRow> = {},
): EngagementsResolverRow => ({
  connection_id: 'acme-hubspot',
  target_id: 'hubspot_email_1',
  vendor: 'hubspot' as EngagementVendor,
  entity: 'email',
  meta: { from: 'anna@acme.com' },
  mirror_blob_hash: null,
  authorship: 'user' as Authorship,
  direction: 'inbound' as Direction,
  dedupe_confidence: 'none' as DedupeConfidence,
  lifecycle_state: 'point_in_time' as EngagementLifecycleState,
  event_at: NOW - 1 * day,
  vendor_created_at: NOW - 1 * day,
  vendor_modified_at: NOW - 1 * day,
  ingested_at: NOW - 1 * day,
  body_state: 'inline_body',
  body_inline: 'I will send the revised SOW by Friday.',
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// filterRowsForCommitmentTracker — registry acceptance
// ────────────────────────────────────────────────────────────────

describe('E2a — filterRowsForCommitmentTracker applies registry acceptance', () => {
  it('accepts a qualifying inline-body row', () => {
    expect(filterRowsForCommitmentTracker([buildRow()])).toHaveLength(1);
  });
  it('rejects automation / system_process authorship (cannot make commitments)', () => {
    expect(filterRowsForCommitmentTracker([buildRow({ authorship: 'crm_automation' })])).toHaveLength(0);
    expect(filterRowsForCommitmentTracker([buildRow({ authorship: 'system_process' })])).toHaveLength(0);
  });
  it('rejects non-inline body states (truncated preview loses the promise fragment)', () => {
    expect(filterRowsForCommitmentTracker([buildRow({ body_state: 'truncated_inline' })])).toHaveLength(0);
    expect(filterRowsForCommitmentTracker([buildRow({ body_state: 'none', body_inline: undefined })])).toHaveLength(0);
  });
  it('rejects pending / scheduled lifecycle (no commitment-bearing body)', () => {
    expect(filterRowsForCommitmentTracker([buildRow({ lifecycle_state: 'pending' })])).toHaveLength(0);
    expect(filterRowsForCommitmentTracker([buildRow({ lifecycle_state: 'scheduled' })])).toHaveLength(0);
  });
  it('rejects null event_at, tombstoned rows, and empty bodies', () => {
    expect(filterRowsForCommitmentTracker([buildRow({ event_at: null })])).toHaveLength(0);
    expect(filterRowsForCommitmentTracker([buildRow({ deleted_at: NOW })])).toHaveLength(0);
    expect(filterRowsForCommitmentTracker([buildRow({ body_inline: '   ' })])).toHaveLength(0);
  });
  it('rejects rows older than the producer window', () => {
    const old = buildRow({ event_at: NOW - 200 * day });
    expect(filterRowsForCommitmentTracker([old], NOW - 90 * day)).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────
// engagementEvidenceSource — entity → closed source family
// ────────────────────────────────────────────────────────────────

describe('E2a — engagementEvidenceSource maps vendor/entity to a source family', () => {
  it('maps HubSpot + Salesforce engagement entities', () => {
    expect(engagementEvidenceSource(buildRow({ vendor: 'hubspot', entity: 'email' }))).toBe('engagement_email');
    expect(engagementEvidenceSource(buildRow({ vendor: 'hubspot', entity: 'meeting' }))).toBe('engagement_meeting');
    expect(engagementEvidenceSource(buildRow({ vendor: 'hubspot', entity: 'call' }))).toBe('engagement_call');
    expect(engagementEvidenceSource(buildRow({ vendor: 'salesforce', entity: 'email_message' }))).toBe('engagement_email_message');
    expect(engagementEvidenceSource(buildRow({ vendor: 'salesforce', entity: 'event' }))).toBe('engagement_event');
  });
  it('returns undefined for an unknown vendor/entity pair', () => {
    expect(engagementEvidenceSource(buildRow({ vendor: 'hubspot', entity: 'mystery' }))).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// buildCommitmentPrompt — indexing + freshest-window
// ────────────────────────────────────────────────────────────────

describe('E2a — buildCommitmentPrompt indexes oldest-first', () => {
  it('numbers engagements and returns the indexed slice for back-reference', () => {
    const rows = [
      buildRow({ target_id: 'm1', entity: 'meeting', event_at: NOW - 1 * day }),
      buildRow({ target_id: 'e1', entity: 'email', event_at: NOW - 3 * day }),
    ];
    const { prompt, indexed } = buildCommitmentPrompt(SUBJECT, rows);
    // Sorted oldest-first: e1 (index 0), m1 (index 1)
    expect(indexed[0]!.target_id).toBe('e1');
    expect(indexed[1]!.target_id).toBe('m1');
    expect(prompt).toContain('[0]');
    expect(prompt).toContain('[1]');
    expect(prompt).toContain(SUBJECT);
  });
});

// ────────────────────────────────────────────────────────────────
// composeCommitmentId — stable content hash
// ────────────────────────────────────────────────────────────────

describe('E2a — composeCommitmentId is stable + content-addressed', () => {
  it('same text + source → same id; a change flips it', () => {
    expect(composeCommitmentId('send SOW', 'e1')).toBe(composeCommitmentId('send SOW', 'e1'));
    expect(composeCommitmentId('send SOW', 'e1')).not.toBe(composeCommitmentId('send SOW', 'e2'));
    expect(composeCommitmentId('send SOW', 'e1')).not.toBe(composeCommitmentId('send POC', 'e1'));
  });
});

// ────────────────────────────────────────────────────────────────
// validateCommitmentExtraction — the core bind + fail-closed drops
// ────────────────────────────────────────────────────────────────

describe('E2a — validateCommitmentExtraction binds evidence + drops fail-closed', () => {
  const indexedRows = (): EngagementsResolverRow[] =>
    buildCommitmentPrompt(SUBJECT, [
      buildRow({ target_id: 'e1', entity: 'email', event_at: NOW - 3 * day }),
      buildRow({ target_id: 'm1', entity: 'meeting', event_at: NOW - 1 * day }),
    ]).indexed;

  it('binds each commitment to its source engagement', () => {
    const out = validateCommitmentExtraction(
      { commitments: [
        { index: 0, actor: 'anna@acme.com', text: 'Send the revised SOW by Friday' },
        { index: 1, actor: 'bob@acme.com', text: 'Schedule the technical review' },
      ] },
      indexedRows(),
      NOW,
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.evidence_links[0]!.source).toBe('engagement_email');
    expect(out[0]!.evidence_links[0]!.source_id).toBe('e1');
    expect(out[0]!.status).toBe('pending');
    expect(out[0]!.confidence).toBe(COMMITMENT_TRACKER_DEFAULT_CONFIDENCE);
    expect(out[1]!.evidence_links[0]!.source).toBe('engagement_meeting');
    expect(out[1]!.evidence_links[0]!.source_id).toBe('m1');
  });

  it('drops a commitment whose index does not resolve (hallucinated source)', () => {
    const out = validateCommitmentExtraction(
      { commitments: [{ index: 9, actor: 'anna@acme.com', text: 'ghost promise' }] },
      indexedRows(),
      NOW,
    );
    expect(out).toHaveLength(0);
  });

  it('drops non-email-shaped actors + empty text (fail-closed)', () => {
    const out = validateCommitmentExtraction(
      { commitments: [
        { index: 0, actor: 'not an email', text: 'x' },
        { index: 0, actor: 'anna@acme.com', text: '   ' },
      ] },
      indexedRows(),
      NOW,
    );
    expect(out).toHaveLength(0);
  });

  it('drops an actor that would fail the strict schema regex (comma-joined addresses)', () => {
    // Passes a naive "has @, no whitespace" check but fails
    // COMMITMENT_ACTOR_EMAIL_RE — must drop the single commitment here, NOT
    // survive to fail the whole-value upsert (codex MEDIUM).
    const out = validateCommitmentExtraction(
      { commitments: [{ index: 0, actor: 'anna@acme.com,bob@acme.com', text: 'promise' }] },
      indexedRows(),
      NOW,
    );
    expect(out).toHaveLength(0);
  });

  it('drops a commitment on a row with no known source family', () => {
    const indexed = buildCommitmentPrompt(SUBJECT, [
      buildRow({ target_id: 'z1', entity: 'mystery', event_at: NOW - 2 * day }),
    ]).indexed;
    const out = validateCommitmentExtraction(
      { commitments: [{ index: 0, actor: 'anna@acme.com', text: 'promise' }] },
      indexed,
      NOW,
    );
    expect(out).toHaveLength(0);
  });

  it('drops below-min-confidence commitments and honors an in-range confidence', () => {
    const out = validateCommitmentExtraction(
      { commitments: [
        { index: 0, actor: 'anna@acme.com', text: 'low conf', confidence: 0.3 },
        { index: 1, actor: 'anna@acme.com', text: 'high conf', confidence: 0.9 },
      ] },
      indexedRows(),
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('high conf');
    expect(out[0]!.confidence).toBe(0.9);
  });

  it('clamps text over the cap + dedups identical commitments', () => {
    const long = 'p'.repeat(COMMITMENT_TEXT_MAX_CHARS + 50);
    const out = validateCommitmentExtraction(
      { commitments: [
        { index: 0, actor: 'anna@acme.com', text: long },
        { index: 0, actor: 'anna@acme.com', text: long },
      ] },
      indexedRows(),
      NOW,
    );
    expect(out).toHaveLength(1); // deduped
    expect(out[0]!.text.length).toBe(COMMITMENT_TEXT_MAX_CHARS);
  });

  it('caps the commitment count', () => {
    const many = Array.from({ length: COMMITMENT_TRACKER_COMMITMENTS_MAX + 20 }, (_v, i) => ({
      index: 0,
      actor: 'anna@acme.com',
      text: `promise number ${i}`,
    }));
    const out = validateCommitmentExtraction({ commitments: many }, indexedRows(), NOW);
    expect(out.length).toBeLessThanOrEqual(COMMITMENT_TRACKER_COMMITMENTS_MAX);
  });

  it('returns [] for a non-object / missing-commitments payload', () => {
    expect(validateCommitmentExtraction(null, indexedRows(), NOW)).toEqual([]);
    expect(validateCommitmentExtraction({ nope: true }, indexedRows(), NOW)).toEqual([]);
  });
});

describe('E2a — buildCommitmentTrackerValue shape', () => {
  it('assembles the per-contact value', () => {
    const value = buildCommitmentTrackerValue(SUBJECT, 'Anna Acme', [], 3, NOW - day, NOW);
    expect(value).toEqual({
      name: 'Anna Acme',
      entity: SUBJECT,
      commitments: [],
      samples: 3,
      cursor_at: NOW - day,
      computed_at: NOW,
    });
  });
  it('omits name when absent', () => {
    const value = buildCommitmentTrackerValue(SUBJECT, undefined, [], 0, 0, NOW);
    expect('name' in value).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// processOneCommitmentTracker — integration (real store + mock LLM)
// ────────────────────────────────────────────────────────────────

describe('E2a — processOneCommitmentTracker integration', () => {
  let dir: string;
  let db: Database.Database;
  let store: EnrichmentStore;
  let llmCalls: number;
  let llmResponses: unknown[];

  const ctx = (): HousekeepingContext => ({
    db,
    bus: {
      emit: () => undefined,
      subscribe: () => () => undefined,
      dispose: () => undefined,
    } as never,
    enrichmentStore: store,
    recipeStore: {} as never,
    now: () => NOW,
    emitAuditRow: () => undefined,
    llm: vi.fn(async () => {
      llmCalls += 1;
      if (llmResponses.length === 0) throw new Error('no llm response queued');
      return llmResponses.shift();
    }),
    llmWithMeta: vi.fn(async () => {
      llmCalls += 1;
      if (llmResponses.length === 0) throw new Error('no llm response queued');
      return { result: llmResponses.shift(), model_id: 'groq:llama-3-70b' };
    }),
    resolveLLMModelId: vi.fn(async () => 'groq:llama-3-70b'),
  });

  const input = (rows: EngagementsResolverRow[]) => ({
    rows,
    scope: CONTACT_SCOPE,
    target_id: CONTACT_TARGET,
    subject_email: SUBJECT,
    subject_name: 'Anna Acme',
    coverage: EMPTY_COVERAGE,
    source_record_hash: 'fnv1a:anna_anchor',
    as_of: NOW,
    now: NOW,
    forceLayer: 'free' as const,
  });

  const persisted = (): CommitmentTrackerValue | undefined => {
    const rows = store.list({
      topic: COMMITMENT_TRACKER_TOPIC,
      scope: CONTACT_SCOPE,
      target_id: CONTACT_TARGET,
      authored_by: COMMITMENT_TRACKER_AUTHORED_BY,
    });
    return rows[0]?.value as CommitmentTrackerValue | undefined;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd-192-e2a-'));
    db = new Database(join(dir, 'test.db'));
    db.pragma('journal_mode = WAL');
    store = createEnrichmentStore(db);
    llmCalls = 0;
    llmResponses = [];
  });

  afterEach(() => {
    store.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns no_llm when llmWithMeta is unwired', async () => {
    const noLlm = { ...ctx(), llmWithMeta: undefined } as HousekeepingContext;
    const res = await processOneCommitmentTracker(noLlm, input([buildRow()]));
    expect(res).toEqual({ produced: false, reason: 'no_llm' });
  });

  it('extracts a commitment and persists it at the contact scope with bound evidence', async () => {
    llmResponses.push({
      commitments: [{ index: 0, actor: 'anna@acme.com', text: 'Send the revised SOW by Friday' }],
    });
    const rows = [buildRow({ target_id: 'hubspot_email_7', entity: 'email', event_at: NOW - 2 * day })];
    const res = await processOneCommitmentTracker(ctx(), input(rows));
    expect(res.produced).toBe(true);
    expect(llmCalls).toBe(1);
    const value = persisted();
    expect(value?.entity).toBe(SUBJECT);
    expect(value?.commitments).toHaveLength(1);
    expect(value?.commitments[0]!.text).toBe('Send the revised SOW by Friday');
    expect(value?.commitments[0]!.evidence_links[0]!.source_id).toBe('hubspot_email_7');
    expect(value?.commitments[0]!.text.length).toBeLessThanOrEqual(COMMITMENT_TEXT_MAX_CHARS);
  });

  it('writes an empty-commitments tombstone WITHOUT an LLM call when nothing qualifies', async () => {
    const res = await processOneCommitmentTracker(ctx(), input([buildRow({ authorship: 'system_process' })]));
    expect(res.produced).toBe(true);
    expect(llmCalls).toBe(0); // no token spend on a quiet contact
    expect(persisted()?.commitments).toEqual([]);
  });

  it('clears a quiet contact deterministically even when llmWithMeta is unwired (codex HIGH)', async () => {
    const noLlm = { ...ctx(), llmWithMeta: undefined } as HousekeepingContext;
    const res = await processOneCommitmentTracker(noLlm, input([buildRow({ authorship: 'system_process' })]));
    expect(res.produced).toBe(true); // the deterministic tombstone runs before the no-LLM guard
    expect(llmCalls).toBe(0);
    expect(persisted()?.commitments).toEqual([]);
  });

  it('dedups a repeated zero-row tombstone', async () => {
    const quiet = input([buildRow({ authorship: 'system_process' })]);
    expect((await processOneCommitmentTracker(ctx(), quiet)).produced).toBe(true);
    expect(await processOneCommitmentTracker(ctx(), quiet)).toEqual({ produced: false, reason: 'dedup_hit' });
  });

  it('re-extracts (no dedup) when a folded row body changes under a fixed modstamp (codex MEDIUM)', async () => {
    llmResponses.push({ commitments: [{ index: 0, actor: 'anna@acme.com', text: 'v1 promise' }] });
    llmResponses.push({ commitments: [{ index: 0, actor: 'anna@acme.com', text: 'v2 promise' }] });
    const row1 = buildRow({
      target_id: 'hubspot_email_9',
      event_at: NOW - 2 * day,
      body_inline: 'I will send the deck.',
      vendor_modstamp: 'stamp-fixed',
    });
    expect((await processOneCommitmentTracker(ctx(), input([row1]))).produced).toBe(true);
    // Same target + SAME modstamp, but the body changed → the body-hash in
    // the fingerprint must force a re-extraction, not a dedup hit.
    const row2 = { ...row1, body_inline: 'Actually I will send the full proposal.' };
    const second = await processOneCommitmentTracker(ctx(), input([row2]));
    expect(second.produced).toBe(true);
    expect(second.reason).toBeUndefined();
    expect(llmCalls).toBe(2);
  });

  it('persists an empty commitment set when the LLM finds none', async () => {
    llmResponses.push({ commitments: [] });
    const res = await processOneCommitmentTracker(ctx(), input([buildRow()]));
    expect(res.produced).toBe(true);
    expect(persisted()?.commitments).toEqual([]);
  });

  it('dedups an unchanged re-run (same inputs → dedup_hit, no second write)', async () => {
    llmResponses.push({
      commitments: [{ index: 0, actor: 'anna@acme.com', text: 'Send the SOW' }],
    });
    const rows = [buildRow({ target_id: 'hubspot_email_7', event_at: NOW - 2 * day })];
    const first = await processOneCommitmentTracker(ctx(), input(rows));
    expect(first.produced).toBe(true);
    const second = await processOneCommitmentTracker(ctx(), input(rows));
    expect(second).toEqual({ produced: false, reason: 'dedup_hit' });
    expect(llmCalls).toBe(1); // the second run short-circuits on the dedup probe
  });

  it('dedups ACROSS CYCLES when only the clock moves (stable cursor_at fingerprint — codex HIGH)', async () => {
    llmResponses.push({ commitments: [{ index: 0, actor: 'anna@acme.com', text: 'Send the SOW' }] });
    // Same engagement rows (same modstamp), later cycle (as_of/now advanced).
    // A moving `as_of` in the fingerprint would re-extract every cycle; the
    // stable `cursor_at` anchor makes the unchanged contact dedup.
    const rows = [buildRow({ target_id: 'hubspot_email_7', event_at: NOW - 2 * day, vendor_modified_at: NOW - 2 * day })];
    const first = await processOneCommitmentTracker(ctx(), { ...input(rows), as_of: NOW, now: NOW });
    expect(first.produced).toBe(true);
    const laterCycle = NOW + 10 * day;
    const second = await processOneCommitmentTracker(ctx(), { ...input(rows), as_of: laterCycle, now: laterCycle });
    expect(second).toEqual({ produced: false, reason: 'dedup_hit' });
    expect(llmCalls).toBe(1); // NOT re-extracted just because the clock advanced
  });
});
