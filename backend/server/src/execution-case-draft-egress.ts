/** D-219 item 2b — the owner's request, made safe to hand an authoring model.
 *
 *  Drafting a recipe from a learned case ships the owner's own words to a cloud
 *  or free-pool model. Recued aliases user content on BOTH its existing LLM
 *  boundaries — the chat egress and the wired enrichment-producer egress — so a
 *  third boundary matches or it is a regression, not a new feature.
 *
 *  🔑 **The model does not need the personal data.** It needs the INTENT and the
 *  shape of what happened, and then it writes a recipe whose parameters the
 *  owner fills. So this is not "alias the PII and hope" — an aliased request is
 *  a complete input for authoring, and the alias is actively USEFUL: a model
 *  reading `email pii.Person1 the quarterly report` has been handed the
 *  strongest possible cue that the recipient is a PARAMETER, which is exactly
 *  the `{{config.*}}` variable it should declare.
 *
 *  ⛔ **AND NOTHING IS RESTORED.** The chat path restores aliases before
 *  anything durable sees them; here that would be the defect. A restored draft
 *  bakes a real address into a recipe the owner then saves — the "always CC
 *  Alice" error arriving by the back door. An alias either becomes a variable or
 *  stays visibly fake in the Kitchen, where a person is looking at it.
 */

import { piiEgress } from '@recued/gateway';

import type { ChatStore } from './storage/chat-store.js';

/** Same bounds as the slot-ordering harvest, and deliberately its own instance:
 *  this walk runs only when the owner presses a button, not on every turn, so it
 *  must not consume a budget the live path depends on. */
export const DRAFT_EGRESS_MAX_ROWS = 256;
export const DRAFT_EGRESS_MAX_BYTES = 1_048_576;
export const DRAFT_EGRESS_MAX_CANDIDATES = 1_024;
export const DRAFT_EGRESS_MAX_MS = 250;

export interface CaseDraftEgressDeps {
  /** ⚠ The session's OWN rows. X1 governs the PII layer reading OTHER sessions;
   *  the ledger, the harvest and the text being aliased here are all one
   *  session, which is the same unconditional own-session read the slot-ordering
   *  seeder already performs. */
  harvest: NonNullable<ChatStore['harvestPiiSources']>;
  /** ⛔ A DETACHED store, NOT the live chat one.
   *
   *  Drafting is an offline read that can run WHILE a chat turn is in flight,
   *  and the live path deliberately serialises: it stages a ledger clone per
   *  request and commits it, precisely so two overlapping requests cannot
   *  allocate the same alias number to different people. Writing into the live
   *  ledger from outside that lease can have a later commit erase this
   *  allocation or publish conflicting numbering — corrupting the alias
   *  identity of a session the owner is actively reading.
   *
   *  A fresh store costs only that the numbering is per-draft rather than
   *  shared with the transcript, which is legibility, not safety. The ordering
   *  seed still runs, so the numbering is derived from the same durable rows. */
  ledgers: piiEgress.SessionLedgerStore;
  /** The deterministic numbering seed, so an alias in a draft means the same
   *  person it meant in that session's transcript. Optional: absent only
   *  degrades legibility, never safety. */
  seedSlotOrdering?: (
    ledger: ReturnType<piiEgress.SessionLedgerStore['getOrCreate']>,
    session_id: string,
  ) => Promise<void>;
}

export interface CaseDraftEgressResult {
  /** Safe to send. EMPTY when aliasing could not be established — see below. */
  prompt: string;
  /** False means the caller must draft WITHOUT the request text. */
  aliased: boolean;
}

/** ⛔ **FAILS CLOSED, and that inverts the sibling it borrows from.**
 *
 *  `createChatPiiSlotOrderingSeeder` fails OPEN by design: a locked vault or a
 *  harvest error leaves the numbering unseeded, which degrades legibility and
 *  gates no leak, so blocking the turn would cost more than it saves.
 *
 *  Here the harvest IS the protection. A failure means we do not know which
 *  spans of this request are personal — and the one thing that must never
 *  follow from "we could not tell" is sending the raw text anyway. So an empty
 *  prompt is returned and the draft proceeds from the tool shape and the owner's
 *  own instruction, which is weaker and safe, rather than complete and not. */
export const aliasCasePromptForAuthoring = async (
  deps: CaseDraftEgressDeps,
  input: { session_id: string; prompt: string },
): Promise<CaseDraftEgressResult> => {
  const text = input.prompt.trim();
  if (text.length === 0) return { prompt: '', aliased: true };
  try {
    const page = await deps.harvest({
      session_id: input.session_id,
      max_rows: DRAFT_EGRESS_MAX_ROWS,
      max_bytes: DRAFT_EGRESS_MAX_BYTES,
      max_candidates: DRAFT_EGRESS_MAX_CANDIDATES,
      max_ms: DRAFT_EGRESS_MAX_MS,
    });
    // ⛔⛔ A PARTIAL HARVEST IS A FAILURE HERE, and the store says so itself:
    // "a pending, unreadable, row/byte/candidate cutoff weakens enhancement
    // coverage but NEVER MAKES RETURNED RAW BYTES ELIGIBLE FOR EGRESS."
    //
    // This is the hole an earlier version had, and my own tests missed it
    // because they only exercised a THROWN harvest. A truncated scan — past
    // 256 rows, 1 MiB or 250 ms — or a row whose finalization failed returns
    // successfully with that row's candidates ABSENT. The aliaser is
    // seed-driven with no fresh-value discovery, so an unlisted address is not
    // aliased: the request would go out byte-for-byte raw, reported as
    // `aliased: true`, which ALSO suppresses the Kitchen's "thin draft" notice.
    // Coverage we cannot vouch for is not coverage.
    if (page.partial) return { prompt: '', aliased: false };
    const ledger = deps.ledgers.getOrCreate(input.session_id);
    await deps.seedSlotOrdering?.(ledger, input.session_id);
    const seeds: piiEgress.CandidateValueSeed[] = page.rows.flatMap((row) =>
      row.candidates.map((candidate) => ({
        value: candidate.value,
        kind: candidate.kind,
      })));
    // ⚠ P1 is preserved by the primitive, not by us: it filters identifier
    // seeds to values actually PRESENT in this packet and allocates only after
    // that presence gate, so handing it the whole session's candidate set
    // cannot widen the session's reverse map.
    const { aliased } = piiEgress.aliasCandidateValuesForEgress(
      ledger,
      { prompt: text },
      seeds,
      [],
    );
    // ⚠ NOTHING IS ENUMERATED BACK to the caller, and an earlier version that
    // did was removed. The authoring prompt does not distinguish personal from
    // non-personal values at all: it is told the recipe must be REUSABLE, and
    // parameterising a recipient falls out of that rule exactly as
    // parameterising a folder does. A model that cannot apply it will not
    // produce a valid recipe anyway.
    //
    // 🔑 And aliasing makes the failure MORE visible, not less: a draft that
    // wrongly hard-codes `m1@d1.invalid` is obviously wrong to a person reading
    // it in the Kitchen, where a real address would have looked fine.
    return { prompt: aliased.prompt, aliased: true };
  } catch {
    return { prompt: '', aliased: false };
  }
};
