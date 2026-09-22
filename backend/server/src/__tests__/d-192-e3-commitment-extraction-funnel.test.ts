/** D-192 email flagship E1 + E3 — the extraction→proposal funnel.
 *
 *  The last leg: the housekeeping `commitment_tracker` task produces
 *  per-contact `TrackedCommitment` rows; this funnel routes each NEW one
 *  through the SAME F1 `commitment-propose` gate → the D-173 inbox → mint.
 *
 *  Coverage:
 *   - E1 `resolveMailCommitmentCounterparty` — direction (inbound iff the
 *     actor IS the subject; else outbound) + canonical counterparty, incl.
 *     merge-chain resolution + the no-store / throwing-resolver fallbacks;
 *   - `composeMailEvidenceEntries` — one `mail` entry per mail-source link,
 *     `attachment` dropped, empty ⇒ drop the commitment (invariant 1);
 *   - the `commitment_id` dedup ledger;
 *   - `runCommitmentProposalFunnel` — fires one held proposal per new
 *     commitment (payload shape), dedups, skips-without-claim when the
 *     runtime is down, releases the claim on a hard fire failure;
 *   - the `commitment_tracker` task hook wires the produced commitments in. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COMMITMENT_MAIL_EVIDENCE_SNIPPET_MAX,
  type Authorship,
  type CommitmentEvidenceLink,
  type CommitmentMailEvidence,
  type CommitmentTrackerValue,
  type CoverageMetadata,
  type DedupeConfidence,
  type Direction,
  type EngagementLifecycleState,
  type EngagementVendor,
  type EngagementsResolverArgs,
  type EngagementsResolverResult,
  type EngagementsResolverRow,
  type EnrichmentScope,
  type TrackedCommitment,
} from '@recued/contracts';

import {
  COMMITMENT_EVIDENCE_CAPTURE_EVENT_KIND,
  COMMITMENT_EVIDENCE_PROPOSAL_RECIPE_ID,
  type FireCommitmentEvidenceProposal,
} from '../commitment-evidence-capture.js';
import {
  composeMailEvidenceEntries,
  resolveMailCommitmentCounterparty,
  runCommitmentProposalFunnel,
} from '../housekeeping/engagement-aggregates/commitment-extraction-funnel.js';
import {
  createCommitmentExtractionLedger,
  type CommitmentExtractionLedger,
} from '../storage/commitment-extraction-ledger.js';
import {
  processOneCommitmentTrackerContact,
} from '../housekeeping/engagement-aggregates/commitment-tracker-task.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

const NOW = 1_714_867_200_000;
const SOURCE_AT = NOW - 3_600_000;
const SUBJECT = 'anna@acme.com';
const OWNER = 'me@own.com';

type FireMock = ReturnType<typeof vi.fn<FireCommitmentEvidenceProposal>>;
type ProposalRequest = Parameters<FireCommitmentEvidenceProposal>[0];

const link = (over: Partial<CommitmentEvidenceLink> = {}): CommitmentEvidenceLink => ({
  source: 'engagement_email',
  source_id: 'hubspot_email_conn_e1',
  source_at: SOURCE_AT,
  ...over,
});

const commitment = (over: Partial<TrackedCommitment> = {}): TrackedCommitment => ({
  commitment_id: 'ct_abc123',
  text: 'Send the revised SOW by Friday.',
  status: 'pending',
  actor_email: SUBJECT,
  evidence_links: [link()],
  extracted_at: NOW,
  confidence: 0.82,
  ...over,
});

// Identity canonical resolver (a fresh store returns the email itself, so
// this mirrors production for un-merged contacts).
const identityCanonical = (email: string): string => email.trim().toLowerCase();

// ────────────────────────────────────────────────────────────────
// E1 — resolveMailCommitmentCounterparty
// ────────────────────────────────────────────────────────────────

describe('D-192 E1 — mail_thread_contact counterparty resolver', () => {
  it('inbound: actor IS the subject → the subject is the counterparty', () => {
    const r = resolveMailCommitmentCounterparty({
      actor_email: SUBJECT,
      subject_email: SUBJECT,
      resolveCanonical: identityCanonical,
    });
    expect(r.direction).toBe('inbound');
    expect(r.counterparty_contact_id).toBe(SUBJECT);
  });

  it('outbound: our side made the promise → the subject is still the counterparty', () => {
    const r = resolveMailCommitmentCounterparty({
      actor_email: OWNER,
      subject_email: SUBJECT,
      resolveCanonical: identityCanonical,
    });
    expect(r.direction).toBe('outbound');
    expect(r.counterparty_contact_id).toBe(SUBJECT);
  });

  it('follows the D-138 merge chain: an actor alias merged into the subject reads inbound', () => {
    const resolveCanonical = (email: string): string =>
      email === 'anna.alias@acme.com' ? SUBJECT : identityCanonical(email);
    const r = resolveMailCommitmentCounterparty({
      actor_email: 'anna.alias@acme.com',
      subject_email: SUBJECT,
      resolveCanonical,
    });
    expect(r.direction).toBe('inbound');
    expect(r.counterparty_contact_id).toBe(SUBJECT);
  });

  it('no resolver → direction from raw emails (case-insensitive), counterparty unresolved', () => {
    expect(resolveMailCommitmentCounterparty({ actor_email: 'ANNA@ACME.COM', subject_email: SUBJECT }))
      .toEqual({ direction: 'inbound' });
    expect(resolveMailCommitmentCounterparty({ actor_email: OWNER, subject_email: SUBJECT }))
      .toEqual({ direction: 'outbound' });
  });

  it('a throwing resolver (malformed email / corrupt merge cycle) fails closed', () => {
    const throwing = (): string => { throw new Error('contact_redirect_cycle'); };
    const r = resolveMailCommitmentCounterparty({
      actor_email: SUBJECT,
      subject_email: SUBJECT,
      resolveCanonical: throwing,
    });
    // Direction still derives from the raw emails; counterparty stays empty.
    expect(r.direction).toBe('inbound');
    expect(r.counterparty_contact_id).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// E3 — mail evidence composition
// ────────────────────────────────────────────────────────────────

describe('D-192 E3 — mail evidence composition', () => {
  it('maps each mail-source link to one immutable mail evidence entry', () => {
    const entries = composeMailEvidenceEntries(commitment(), NOW);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e).toEqual<CommitmentMailEvidence>({
      kind: 'mail',
      full_target_id: 'hubspot_email_conn_e1',
      source: 'engagement_email',
      actor_email: SUBJECT,
      snippet: 'Send the revised SOW by Friday.',
      confidence: 0.82,
      source_at: SOURCE_AT,
      captured_at: NOW,
    });
  });

  it('drops non-mail (attachment) source links but keeps the mail ones', () => {
    const entries = composeMailEvidenceEntries(
      commitment({
        evidence_links: [
          link({ source: 'attachment', source_id: 'att_1' }),
          link({ source: 'engagement_note', source_id: 'note_9' }),
        ],
      }),
      NOW,
    );
    expect(entries.map((e) => e.source)).toEqual(['engagement_note']);
    expect(entries[0]!.full_target_id).toBe('note_9');
  });

  it('a commitment binding no mail source yields no entries (invariant 1)', () => {
    expect(composeMailEvidenceEntries(commitment({ evidence_links: [link({ source: 'attachment' })] }), NOW))
      .toEqual([]);
  });

  it('never exceeds the snippet cap', () => {
    const long = 'x'.repeat(COMMITMENT_MAIL_EVIDENCE_SNIPPET_MAX + 50);
    const entries = composeMailEvidenceEntries(commitment({ text: long }), NOW);
    expect(entries[0]!.snippet.length).toBeLessThanOrEqual(COMMITMENT_MAIL_EVIDENCE_SNIPPET_MAX);
  });
});

// ────────────────────────────────────────────────────────────────
// E3 — the commitment_id dedup ledger
// ────────────────────────────────────────────────────────────────

describe('D-192 E3 — commitment-extraction ledger', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd-192-e3-ledger-'));
    db = new Database(join(dir, 'test.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('claims once, dedups a re-claim, releases, and probes', () => {
    const ledger = createCommitmentExtractionLedger(db);
    const input = { commitment_id: 'ct_1', subject_email: SUBJECT };
    expect(ledger.tryClaim(input, NOW)).toBe(true);
    expect(ledger.has('ct_1')).toBe(true);
    expect(ledger.tryClaim(input, NOW)).toBe(false); // already claimed
    ledger.release('ct_1');
    expect(ledger.has('ct_1')).toBe(false);
    expect(ledger.tryClaim(input, NOW)).toBe(true); // re-claimable after release
  });
});

// ────────────────────────────────────────────────────────────────
// E3 — the funnel dispatch
// ────────────────────────────────────────────────────────────────

describe('D-192 E3 — extraction→proposal funnel', () => {
  let dir: string;
  let db: Database.Database;
  let ledger: CommitmentExtractionLedger;

  const okFire = (): FireMock => vi.fn<FireCommitmentEvidenceProposal>(async () => undefined);
  const firstCall = (fire: FireMock): ProposalRequest => {
    const call = fire.mock.calls[0];
    if (call === undefined) throw new Error('expected a proposal fire');
    return call[0];
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd-192-e3-funnel-'));
    db = new Database(join(dir, 'test.db'));
    ledger = createCommitmentExtractionLedger(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('fires one held proposal per commitment with the F1 provenance + a mail payload', async () => {
    const fire = okFire();
    const res = await runCommitmentProposalFunnel(
      { getFire: () => fire, ledger, resolveCanonical: identityCanonical, now: () => NOW },
      { subject_email: SUBJECT, commitments: [commitment()] },
    );
    expect(res).toEqual({ proposed: 1, skipped: 0 });

    const req = firstCall(fire);
    expect(req.execution_source).toMatchObject({
      channel: 'reactive',
      actor: 'system',
      event_kind: COMMITMENT_EVIDENCE_CAPTURE_EVENT_KIND,
      source_recipe: COMMITMENT_EVIDENCE_PROPOSAL_RECIPE_ID,
    });
    expect(req.payload).toMatchObject({
      direction: 'inbound', // actor === subject
      statement: 'Send the revised SOW by Friday.',
      derivation: 'evidence_captured',
      promised_at: SOURCE_AT, // the source authorship time, not capture time
      counterparty_contact_id: SUBJECT,
    });
    const blob = req.payload.evidence_blob as CommitmentMailEvidence[];
    expect(blob).toHaveLength(1);
    expect(blob[0]!.kind).toBe('mail');
    // No `promised_for_at` (owner sets the deadline at approval); no mail
    // thread id for a CRM engagement source.
    expect(req.payload.promised_for_at).toBeUndefined();
    expect(req.payload.derived_from_mail_thread_id).toBeUndefined();
    expect(ledger.has('ct_abc123')).toBe(true);
  });

  it('sets derived_from_mail_thread_id only for a genuine warehouse-mail source', async () => {
    const fire = okFire();
    await runCommitmentProposalFunnel(
      { getFire: () => fire, ledger, resolveCanonical: identityCanonical, now: () => NOW },
      {
        subject_email: SUBJECT,
        commitments: [commitment({ commitment_id: 'ct_mail', evidence_links: [link({ source: 'mail', source_id: 'msg-77' })] })],
      },
    );
    expect(firstCall(fire).payload.derived_from_mail_thread_id).toBe('msg-77');
  });

  it('dedups on commitment_id — a re-run over the same commitment does not re-fire', async () => {
    const fire = okFire();
    const deps = { getFire: () => fire, ledger, resolveCanonical: identityCanonical, now: () => NOW };
    await runCommitmentProposalFunnel(deps, { subject_email: SUBJECT, commitments: [commitment()] });
    const second = await runCommitmentProposalFunnel(deps, { subject_email: SUBJECT, commitments: [commitment()] });
    expect(second).toEqual({ proposed: 0, skipped: 1 });
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('skips WITHOUT claiming when the fire runtime is not up yet', async () => {
    const res = await runCommitmentProposalFunnel(
      { getFire: () => undefined, ledger, resolveCanonical: identityCanonical, now: () => NOW },
      { subject_email: SUBJECT, commitments: [commitment()] },
    );
    expect(res).toEqual({ proposed: 0, skipped: 1 });
    expect(ledger.has('ct_abc123')).toBe(false); // no claim — re-proposes once the runtime is up
  });

  it('releases the claim when a proposal fire hard-fails, so the next cycle re-proposes', async () => {
    const rejecting = vi.fn<FireCommitmentEvidenceProposal>(async () => { throw new Error('pre-hold failure'); });
    const first = await runCommitmentProposalFunnel(
      { getFire: () => rejecting, ledger, resolveCanonical: identityCanonical, now: () => NOW },
      { subject_email: SUBJECT, commitments: [commitment()] },
    );
    expect(first).toEqual({ proposed: 0, skipped: 1 });
    expect(ledger.has('ct_abc123')).toBe(false); // released

    const fire = okFire();
    const retry = await runCommitmentProposalFunnel(
      { getFire: () => fire, ledger, resolveCanonical: identityCanonical, now: () => NOW },
      { subject_email: SUBJECT, commitments: [commitment()] },
    );
    expect(retry).toEqual({ proposed: 1, skipped: 0 });
  });

  it('drops a commitment binding no mail evidence without claiming or firing', async () => {
    const fire = okFire();
    const res = await runCommitmentProposalFunnel(
      { getFire: () => fire, ledger, resolveCanonical: identityCanonical, now: () => NOW },
      {
        subject_email: SUBJECT,
        commitments: [commitment({ commitment_id: 'ct_att', evidence_links: [link({ source: 'attachment' })] })],
      },
    );
    expect(res).toEqual({ proposed: 0, skipped: 1 });
    expect(fire).not.toHaveBeenCalled();
    expect(ledger.has('ct_att')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// E3 — the commitment_tracker task hook
// ────────────────────────────────────────────────────────────────

const EMPTY_COVERAGE: CoverageMetadata = {
  sources_connected: [],
  sources_unavailable: [],
  sources_stale: [],
  sources_degraded: [],
  row_counts: {},
  last_source_event_at: 0,
};

const engagementRow = (over: Partial<EngagementsResolverRow> = {}): EngagementsResolverRow => ({
  connection_id: 'acme-hubspot',
  target_id: 'e1',
  vendor: 'hubspot' as EngagementVendor,
  entity: 'email',
  meta: { from: SUBJECT },
  mirror_blob_hash: null,
  authorship: 'user' as Authorship,
  direction: 'inbound' as Direction,
  dedupe_confidence: 'none' as DedupeConfidence,
  lifecycle_state: 'point_in_time' as EngagementLifecycleState,
  event_at: NOW - 60_000,
  vendor_created_at: NOW - 60_000,
  vendor_modified_at: NOW - 60_000,
  ingested_at: NOW - 60_000,
  body_state: 'inline_body',
  body_inline: 'I will send the revised SOW by Friday.',
  ...over,
});

describe('D-192 E3 — commitment_tracker task funnel hook', () => {
  let dir: string;
  let db: Database.Database;
  let store: EnrichmentStore;

  const ctx = (over: Partial<HousekeepingContext> = {}): HousekeepingContext =>
    ({
      db,
      bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
      enrichmentStore: store,
      recipeStore: {} as never,
      now: () => NOW,
      emitAuditRow: () => undefined,
      llmWithMeta: vi.fn(async () => ({
        result: { commitments: [{ index: 0, actor: SUBJECT, text: 'Send the SOW by Friday' }] },
        model_id: 'groq:llama-3-70b',
      })),
      resolveContactEngagements: (_args: EngagementsResolverArgs): EngagementsResolverResult => ({
        engagements: [engagementRow()],
        coverage: EMPTY_COVERAGE,
      }),
      ...over,
    }) as unknown as HousekeepingContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd-192-e3-hook-'));
    db = new Database(join(dir, 'test.db'));
    db.pragma('journal_mode = WAL');
    store = createEnrichmentStore(db);
  });
  afterEach(() => {
    store.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('hands the produced commitments to the proposal funnel', async () => {
    const funnel = vi.fn<
      NonNullable<HousekeepingContext['commitmentProposalFunnel']>
    >(async () => ({ proposed: 1, skipped: 0 }));
    const contact = { target_id: 'hubspot_contact_1', meta_json: JSON.stringify({ email: SUBJECT, name: 'Anna' }) };
    const out = await processOneCommitmentTrackerContact(
      ctx({ commitmentProposalFunnel: funnel }),
      'connection.api.hubspot.contact' as EnrichmentScope,
      contact,
      'free',
    );
    expect(out.produced).toBe(true);
    expect(funnel).toHaveBeenCalledTimes(1);
    const arg = funnel.mock.calls[0]![0];
    expect(arg.subject_email).toBe(SUBJECT);
    expect(arg.commitments).toHaveLength(1);
    expect(arg.commitments[0]!.text).toBe('Send the SOW by Friday');
    expect(arg.commitments[0]!.actor_email).toBe(SUBJECT);
  });

  it('funnels the persisted commitments again on a dedup-hit cycle (retry path)', async () => {
    // codex HIGH: a commitment produced while `fire` was down (or whose prior
    // fire hard-failed) must get retried even though the next cycle's producer
    // dedup-hits (produced:false, writes nothing). The task hook is NOT gated
    // on `out.produced`, so the funnel re-sees the persisted commitments.
    const funnel = vi.fn<
      NonNullable<HousekeepingContext['commitmentProposalFunnel']>
    >(async () => ({ proposed: 0, skipped: 1 }));
    const c = ctx({ commitmentProposalFunnel: funnel });
    const contact = { target_id: 'hubspot_contact_dh', meta_json: JSON.stringify({ email: SUBJECT }) };
    const scope = 'connection.api.hubspot.contact' as EnrichmentScope;

    const first = await processOneCommitmentTrackerContact(c, scope, contact, 'free');
    expect(first.produced).toBe(true);

    // Second identical cycle — same source rows + stable cursor ⇒ the producer
    // dedup-hits (produced:false) and never re-calls the LLM, but the funnel
    // still receives the persisted commitment.
    const second = await processOneCommitmentTrackerContact(c, scope, contact, 'free');
    expect(second.produced).toBe(false);
    expect(funnel).toHaveBeenCalledTimes(2);
    expect(funnel.mock.calls[1]![0].commitments).toHaveLength(1);
  });

  it('does not call the funnel for a zero-commitment tombstone', async () => {
    const funnel = vi.fn(async () => ({ proposed: 0, skipped: 0 }));
    // No qualifying engagements → tombstone (produced true, empty commitments).
    const contact = { target_id: 'hubspot_contact_2', meta_json: JSON.stringify({ email: SUBJECT }) };
    const out = await processOneCommitmentTrackerContact(
      ctx({
        commitmentProposalFunnel: funnel,
        resolveContactEngagements: () => ({ engagements: [], coverage: EMPTY_COVERAGE }),
      }),
      'connection.api.hubspot.contact' as EnrichmentScope,
      contact,
      'free',
    );
    expect(out.produced).toBe(true);
    expect(funnel).not.toHaveBeenCalled();
  });

  it('produces normally when no funnel is wired (dbless / pre-wire)', async () => {
    const contact = { target_id: 'hubspot_contact_3', meta_json: JSON.stringify({ email: SUBJECT }) };
    const out = await processOneCommitmentTrackerContact(
      ctx(),
      'connection.api.hubspot.contact' as EnrichmentScope,
      contact,
      'free',
    );
    expect(out.produced).toBe(true);
  });
});
