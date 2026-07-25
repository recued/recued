/** D-192 email flagship E1 + E3 — the extraction→proposal funnel.
 *
 *  This is the last leg of the email flagship: the housekeeping
 *  `commitment_tracker` task produces per-contact `TrackedCommitment`
 *  rows (E2a/E2b); this funnel routes each NEW extracted commitment
 *  through the SAME `commitment-propose` gate the F1 CRM next-step
 *  showcase uses → the D-173 inbox → owner approves → a canonical
 *  `data_commitment` row (`derivation: 'evidence_captured'` + a `mail`
 *  evidence blob). One approval funnel, one canonical commitment truth.
 *
 *  Deliberate REUSE of the F1 proposal surface (no new inbox plumbing):
 *  each fire holds on the F1 synthetic proposal recipe
 *  (`COMMITMENT_EVIDENCE_PROPOSAL_RECIPE`, whose single op-step is the
 *  `commitment-propose` slug that rides the all-actor approval lift), and
 *  carries the F1 provenance pair (`source_recipe` /
 *  `event_kind`) so the D-173 inbox origin filter, source-kind recovery,
 *  and approve-with-editable-args allowlist all apply UNCHANGED — the
 *  minted commitment's `evidence_blob[].kind: 'mail'` is what distinguishes
 *  the mail funnel from the CRM-field funnel at the data layer. (A distinct
 *  mail-funnel token is a documented future option if the inbox ever needs
 *  to render mail vs crm_field cards differently — today the evidence kind
 *  already carries that.)
 *
 *  Dedup is on `commitment_id` (the D-139 paraphrase+source content hash)
 *  via the durable `commitment-extraction-ledger.ts` — so the task
 *  re-running every idle cycle over an unchanged contact never re-floods
 *  the inbox, and a DECLINED proposal never re-proposes. The claim happens
 *  BEFORE the fire (F1's both-halves-up-first discipline): a hard dispatch
 *  failure releases the claim so the next cycle re-proposes.
 *
 *  Spec: `docs/d-192-spec.md` § the email flagship funnel (E3) +
 *  § counterparty resolution (E1). */

import {
  COMMITMENT_MAIL_EVIDENCE_SNIPPET_MAX,
  COMMITMENT_MAIL_EVIDENCE_SOURCE_SET,
  COMMITMENT_STATEMENT_MAX,
  type CommitmentDirection,
  type CommitmentMailEvidence,
  type CommitmentMailEvidenceSource,
  type ExecutionSource,
  type RecipeDefinition,
  type TrackedCommitment,
} from '@recued/contracts';

import {
  COMMITMENT_EVIDENCE_CAPTURE_EVENT_KIND,
  COMMITMENT_EVIDENCE_PROPOSAL_RECIPE,
  COMMITMENT_EVIDENCE_PROPOSAL_RECIPE_ID,
  type FireCommitmentEvidenceProposal,
} from '../../commitment-evidence-capture.js';
import type { CommitmentExtractionLedger } from '../../storage/commitment-extraction-ledger.js';

// ────────────────────────────────────────────────────────────────
// E1 — the `mail_thread_contact` counterparty + direction resolver
// ────────────────────────────────────────────────────────────────

export interface MailCommitmentCounterpartyInput {
  /** Who made the promise (the extraction's `actor_email`). */
  actor_email: string;
  /** The contact whose engagements were walked (`CommitmentTrackerValue.entity`)
   *  — the mail-thread counterparty. */
  subject_email: string;
  /** D-138 canonical resolver
   *  (`contactStore.resolveCanonicalEmail(email).canonical_email`). Absent /
   *  throwing (malformed email, corrupt merge cycle) ⇒ direction falls back
   *  to the normalized raw emails and the counterparty stays unresolved. */
  resolveCanonical?: (email: string) => string | undefined;
}

export interface MailCommitmentCounterparty {
  direction: CommitmentDirection;
  counterparty_contact_id?: string;
}

/** Resolve a mail-extracted commitment's direction + counterparty (E1 —
 *  the `mail_thread_contact` strategy). The `commitment_tracker` producer
 *  walks PER CONTACT, so the counterparty IS the walked subject contact;
 *  direction derives by comparing the promise `actor_email` to that
 *  subject:
 *   - actor IS the subject ⇒ `inbound` (they promised us);
 *   - else ⇒ `outbound` (our side promised them — the common default; a
 *     third-party CC'd actor also lands here and the owner corrects at
 *     approval).
 *  The counterparty is the subject contact's D-138 canonical email, set
 *  only when the resolver returns one (nullable column — the owner fills
 *  at approval otherwise). Pure. */
export const resolveMailCommitmentCounterparty = (
  input: MailCommitmentCounterpartyInput,
): MailCommitmentCounterparty => {
  const safe = (email: string): string | undefined => {
    if (input.resolveCanonical === undefined) return undefined;
    try {
      const canonical = input.resolveCanonical(email);
      return canonical !== undefined && canonical.length > 0 ? canonical : undefined;
    } catch {
      return undefined; // malformed email / corrupt merge chain — fail closed
    }
  };
  const norm = (email: string): string => email.trim().toLowerCase();
  const subjectCanonical = safe(input.subject_email);
  const actorCanonical = safe(input.actor_email);
  // Direction: compare canonical when available, else the normalized raw
  // emails — so the pure helper still derives a direction with no contact
  // store at all (the store is an accuracy improvement, not a requirement).
  const subjectKey = subjectCanonical ?? norm(input.subject_email);
  const actorKey = actorCanonical ?? norm(input.actor_email);
  const direction: CommitmentDirection = actorKey === subjectKey ? 'inbound' : 'outbound';
  return {
    direction,
    ...(subjectCanonical !== undefined ? { counterparty_contact_id: subjectCanonical } : {}),
  };
};

// ────────────────────────────────────────────────────────────────
// E3 — mail evidence composition
// ────────────────────────────────────────────────────────────────

/** Compose the immutable `mail` evidence snapshots for an extracted
 *  commitment — one per backing evidence link whose source family is a
 *  MAIL evidence source (`attachment` is excluded at v1: the promise text
 *  lives in a message/engagement body, not an attachment blob — the
 *  producer only ever emits engagement sources, so the filter is defense
 *  in depth). The `snippet` is the LLM paraphrase (`commitment.text`,
 *  already ≤ the D-139 200-char cap = `COMMITMENT_MAIL_EVIDENCE_SNIPPET_MAX`)
 *  — never a raw body excerpt. An empty result means the commitment binds
 *  no valid mail source ⇒ the caller drops it (invariant 1: no evidence,
 *  no commitment). */
export const composeMailEvidenceEntries = (
  commitment: TrackedCommitment,
  captured_at: number,
): CommitmentMailEvidence[] => {
  const entries: CommitmentMailEvidence[] = [];
  for (const link of commitment.evidence_links) {
    if (!COMMITMENT_MAIL_EVIDENCE_SOURCE_SET.has(link.source)) continue;
    entries.push({
      kind: 'mail',
      full_target_id: link.source_id,
      source: link.source as CommitmentMailEvidenceSource,
      actor_email: commitment.actor_email,
      snippet: commitment.text.slice(0, COMMITMENT_MAIL_EVIDENCE_SNIPPET_MAX),
      confidence: commitment.confidence,
      source_at: link.source_at,
      captured_at,
    });
  }
  return entries;
};

// ────────────────────────────────────────────────────────────────
// E3 — the funnel dispatch
// ────────────────────────────────────────────────────────────────

export interface CommitmentProposalFunnelDeps {
  /** The held-proposal dispatch (F1's `fire`) — read LAZILY per call: the
   *  runtime ref is late-populated by the post-listener wire, so a funnel
   *  built at compose time reads the live `fire` only when the task
   *  actually runs. Absent (pre-wire / dbless) ⇒ the funnel skips WITHOUT
   *  claiming the ledger, so the next cycle re-proposes once the runtime is
   *  up (mirrors the F1 producer's absent-runtime posture). */
  getFire: () => FireCommitmentEvidenceProposal | undefined;
  ledger: CommitmentExtractionLedger;
  /** D-138 canonical resolver for the E1 counterparty seam. */
  resolveCanonical?: (email: string) => string | undefined;
  now?: () => number;
}

export interface CommitmentProposalFunnelInput {
  /** The walked contact's canonical email (`CommitmentTrackerValue.entity`). */
  subject_email: string;
  /** The producer's current per-contact commitment set. */
  commitments: readonly TrackedCommitment[];
}

/** Route each NEW extracted commitment to one held `commitment-propose`
 *  run. Dedups on `commitment_id`; composes the `mail` evidence blob +
 *  the E1 direction/counterparty; fires the F1 proposal recipe INLINE
 *  (the preflight checkpoint carries the recipe snapshot, so resume works
 *  without a store registration). Returns the per-call tally. Never
 *  throws — a single commitment's dispatch failure releases its claim and
 *  the loop continues. */
export const runCommitmentProposalFunnel = async (
  deps: CommitmentProposalFunnelDeps,
  input: CommitmentProposalFunnelInput,
): Promise<{ proposed: number; skipped: number }> => {
  const now = deps.now ?? ((): number => Date.now());
  let proposed = 0;
  let skipped = 0;

  for (const commitment of input.commitments) {
    const fire = deps.getFire();
    if (fire === undefined) {
      // Runtime not up yet — skip WITHOUT claiming so the next cycle
      // re-proposes. (Break would be equally correct since `getFire` is
      // stable across the loop, but `continue` keeps the counters honest.)
      skipped += 1;
      continue;
    }

    const captured_at = now();
    const evidence = composeMailEvidenceEntries(commitment, captured_at);
    if (evidence.length === 0) {
      skipped += 1; // invariant 1: no evidence, no commitment
      continue;
    }

    // Claim BEFORE firing (F1's both-halves-up-first): a claim without a
    // fire would swallow this commitment identity forever.
    if (
      !deps.ledger.tryClaim(
        { commitment_id: commitment.commitment_id, subject_email: input.subject_email },
        captured_at,
      )
    ) {
      skipped += 1; // already proposed (pending / approved / declined)
      continue;
    }

    const { direction, counterparty_contact_id } = resolveMailCommitmentCounterparty({
      actor_email: commitment.actor_email,
      subject_email: input.subject_email,
      resolveCanonical: deps.resolveCanonical,
    });
    const primary = evidence[0];
    const payload: Record<string, unknown> = {
      direction,
      statement: commitment.text.slice(0, COMMITMENT_STATEMENT_MAX),
      derivation: 'evidence_captured',
      // The source authorship time IS the promise timestamp (when the mail /
      // engagement carrying the promise was authored). The deadline
      // (`promised_for_at`) defaults ABSENT — v1 does no text-date parsing;
      // the owner sets it at approval (the F1 posture).
      promised_at: primary.source_at,
      evidence_blob: evidence,
      ...(counterparty_contact_id !== undefined ? { counterparty_contact_id } : {}),
      // Only a genuine warehouse-`mail` source id is a mail-thread id; for
      // CRM engagement sources (v1) this stays absent. Forward-ready for the
      // warehouse-mail extraction follow-on.
      ...(primary.source === 'mail' ? { derived_from_mail_thread_id: primary.full_target_id } : {}),
    };
    const execution_source: ExecutionSource = {
      channel: 'reactive',
      actor: 'system',
      event_kind: COMMITMENT_EVIDENCE_CAPTURE_EVENT_KIND,
      source_recipe: COMMITMENT_EVIDENCE_PROPOSAL_RECIPE_ID,
    };
    try {
      // Await (unlike F1's fire-and-forget on the bus emit path) — the task
      // is already async and off any hot emit chain, so we can settle the
      // hold + tally accurately. `fire` resolves on a durable
      // `awaiting_approval` hold (the expected outcome) and THROWS on a hard
      // pre-hold failure.
      await fire({
        recipe: COMMITMENT_EVIDENCE_PROPOSAL_RECIPE as RecipeDefinition,
        execution_source,
        payload,
        run_id: `commitment-extraction-${commitment.commitment_id}-${captured_at}`,
      });
      proposed += 1;
    } catch {
      // Hard failure (never reached the hold) — release the claim so the
      // next cycle re-proposes (mirrors F1's release-on-reject). A throwing
      // release leaves the claim (fail-safe toward fewer proposals).
      try {
        deps.ledger.release(commitment.commitment_id);
      } catch {
        /* keep the claim */
      }
      skipped += 1;
    }
  }

  return { proposed, skipped };
};
