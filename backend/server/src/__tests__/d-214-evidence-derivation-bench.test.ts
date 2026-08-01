/** D-214 piece 2 — EVIDENCE DERIVATION, benched on its own.
 *
 * `span → evidence_kinds` is the seam where BOTH of this session's substrate
 * bugs lived:
 *
 *   - a failed installed recipe derived `unverified_success` — a POSITIVE kind
 *     — because its qualified dispatch never paired with its bare-id audit row
 *     (`d-214-recipe-run-pairing`, fixed at `a45fd61c2`);
 *   - a preflight denial answered after the turn never reached the observation
 *     at all (`d-214-post-turn-denial-evidence`).
 *
 * Neither could have been caught downstream. `d-214-evidence-kind-partition`
 * is thorough about `kind → polarity → admission`, but its `observationOf`
 * helper passes `evidence_kinds: [kind]` in DIRECTLY — it starts below this
 * seam, so the derivation is exactly the part nothing systematically covers.
 *
 * This drives real spans through the real compiler and asserts which kind each
 * span condition produces. The `Record<CaseEvidenceKind, …>` below is the
 * ratchet: a new union member will not compile without a row here, so the
 * derivation table cannot silently fall behind the vocabulary.
 */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  InternalToolRegistry,
  ToolEntry,
  ToolTier,
} from '@recued/contracts';

import {
  createExecutionCaseCompiler,
} from '../execution-case-compiler.js';
import {
  createExecutionCaseLifecycle,
} from '../chat-execution-case-tools.js';
import {
  createExecutionCaseFeedbackRecorder,
} from '../execution-case-feedback.js';
import {
  createExecutionCaseVerificationRecorder,
} from '../execution-case-verification.js';
import type { CaseEvidenceKind } from '../execution-case-core.js';
import {
  createExecutionCaseStore,
} from '../storage/execution-case-store.js';
import {
  createExecutionReportStore,
} from '../storage/execution-report-store.js';
import {
  createExecutionSpanAnchorStore,
} from '../storage/execution-span-anchor-store.js';
import {
  createExecutionSpanDissectionStore,
} from '../storage/execution-span-dissection-store.js';
import {
  createCaseInterventionStore,
} from '../storage/case-intervention-store.js';
import {
  createExecutionCaseFeedbackStore,
} from '../storage/execution-case-feedback-store.js';
import {
  createExecutionCaseVerificationStore,
} from '../storage/execution-case-verification-store.js';
import type { ChatDispatchContext } from '../chat-tool-handlers.js';
import type { D214KeyProvider } from '../storage/d214-sealed-json.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const keyProvider = (): D214KeyProvider => {
  const key = new Uint8Array(32).fill(41);
  return () => key;
};

const schema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_entries (
      key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_activities (
      key TEXT PRIMARY KEY, data TEXT NOT NULL);
  `);
};

const mailEntry: ToolEntry = {
  name: 'mail.send',
  tier: 2,
  description: 'send mail',
  arg_schema: {},
  topic_tags: ['mail'],
  classification: 'write',
  risk_tier: 'write',
  concurrency_safe: false,
};
const fileEntry: ToolEntry = {
  name: 'file.search',
  tier: 1,
  description: 'search files',
  arg_schema: {},
  topic_tags: ['files'],
  classification: 'read',
  risk_tier: 'read',
  concurrency_safe: true,
};

const registry = (): InternalToolRegistry => {
  const all = [mailEntry, fileEntry];
  return {
    list: () => all,
    listByTier: (tier: ToolTier) => all.filter((e) => e.tier === tier),
    getByName: (name) => all.find((e) => e.name === name) ?? null,
    dispatch: async () => ({ ok: false, reason: 'not_implemented' }),
    subscribeRefresh: () => () => {},
  };
};

const addActivity = (
  db: Database.Database,
  input: {
    id: string;
    at: number;
    tool: string;
    status?: 'ok' | 'error';
    reason?: string;
  },
): void => {
  db.prepare(
    'INSERT OR REPLACE INTO audit_activities (key, data) VALUES (?, ?)',
  ).run(input.id, JSON.stringify({
    activity_id: input.id,
    timestamp: input.at,
    action: 'chat_tool_call',
    target: `s1:t1:${input.tool}`,
    detail: JSON.stringify({
      status: input.status ?? 'ok',
      ...(input.reason ? { reason: input.reason } : {}),
    }),
  }));
};

/** A recipe-run audit anchor, so a PREFLIGHT denial can be reproduced: the
 * owner refuses a HELD send after the turn, `denyRun` flips the anchor to
 * failed with RECIPE_POLICY_DENIED, and the activity that dispatched it pairs
 * to that run. */
const putRecipeRun = (
  db: Database.Database,
  input: { id: string; at: number; recipe: string; status: string; codes?: string[] },
): void => {
  db.prepare(
    'INSERT OR REPLACE INTO audit_entries (key, data) VALUES (?, ?)',
  ).run(input.id, JSON.stringify({
    run_id: input.id,
    recipe_id: input.recipe,
    recipe_hash: `hash-${input.id}`,
    started_at: input.at,
    finished_at: input.at + 1,
    commit_status: input.status,
    errors: (input.codes ?? []).map((code) => ({ code })),
    execution_source: {
      channel: 'chat',
      actor: 'user_self',
      chat_session_id: 's1',
      user_id: 'owner',
      turn_id: 't1',
    },
  }));
};

const fixture = async () => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  schema(db);
  const key = keyProvider();
  const anchorStore = createExecutionSpanAnchorStore(db, key);
  const reportStore = createExecutionReportStore(db, key);
  const caseStore = createExecutionCaseStore(db, key);
  const dissectionStore = createExecutionSpanDissectionStore(db, key);
  const interventionStore = createCaseInterventionStore(
    db, key, new TextEncoder().encode('derivation-secret'),
  );
  const feedbackStore = createExecutionCaseFeedbackStore(db);
  const verificationStore = createExecutionCaseVerificationStore(db);
  const tools = registry();
  const compiler = createExecutionCaseCompiler({
    db, anchorStore, reportStore, caseStore, dissectionStore,
    feedbackStore, verificationStore, registry: tools,
  });
  let clock = 1_000;
  const lifecycle = createExecutionCaseLifecycle({
    anchorStore,
    reportStore,
    caseStore: undefined as never,
    dissectionStore,
    compiler,
    registry: tools,
    interventionStore,
    now: () => clock++,
    newReportId: () => 'report-1',
  } as Parameters<typeof createExecutionCaseLifecycle>[0]);
  const feedbackRecorder = createExecutionCaseFeedbackRecorder({
    anchorStore, reportStore, caseStore, feedbackStore,
    interventionStore, compiler, now: () => clock++,
  });
  const verificationRecorder = createExecutionCaseVerificationRecorder({
    anchorStore, reportStore, caseStore, verificationStore,
    compiler, now: () => clock++,
  });
  return {
    db, anchorStore, caseStore, compiler, lifecycle,
    feedbackRecorder, verificationRecorder,
  };
};

const context = (): ChatDispatchContext => ({
  channel: 'internal_function_call',
  session_id: 's1',
  turn_id: 't1',
  turn_state: new Map<string, unknown>(),
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** How a span is shaped so the derivation produces a given kind, and whether
 * this bench can produce it through the real compiler at all. */
interface DerivationRow {
  /** The span condition, in the compiler's own terms. */
  readonly condition: string;
  /** Drives the span; `null` when this bench cannot reach the kind. */
  readonly build: ((f: Fixture) => Promise<void>) | null;
  /** Why it is unreachable here, when it is. */
  readonly unreachable?: string;
}

const openSpan = async (f: Fixture) => {
  await f.anchorStore.openSpan({
    root_request_id: 'r1',
    session_id: 's1',
    surface: 'chat',
    root_request: 'send the quarterly report to the customer',
    turn_id: 't1',
    now: 100,
  });
};

/** Two substantive calls, so the §8.2 Layer-1 bar is cleared and the span is a
 * real opportunity rather than a degenerate one. */
const twoCalls = (f: Fixture, over: {
  secondStatus?: 'ok' | 'error';
  secondReason?: string;
} = {}) => {
  addActivity(f.db, { id: 'a1', at: 101, tool: 'file.search' });
  addActivity(f.db, {
    id: 'a2',
    at: 102,
    tool: 'mail.send',
    ...(over.secondStatus ? { status: over.secondStatus } : {}),
    ...(over.secondReason ? { reason: over.secondReason } : {}),
  });
};

const closeSpan = async (f: Fixture, claim = 'fulfilled') => {
  await f.lifecycle.dispatchOutcome({ claim }, context());
  await f.lifecycle.finalizeTurn({ session_id: 's1', turn_id: 't1' });
};

// ⛔ `Record<CaseEvidenceKind, …>` — a new union member will not COMPILE
// without a row here. The derivation table cannot fall behind the vocabulary
// the way three hand-written sets did (see `d-214-evidence-kind-partition`).
const DERIVATION: Record<CaseEvidenceKind, DerivationRow> = {
  execution_failure: {
    condition: 'an activity errored for a non-denial reason',
    build: async (f) => {
      await openSpan(f);
      twoCalls(f, { secondStatus: 'error' });
      await closeSpan(f);
    },
  },
  gateway_denial: {
    condition: 'an activity errored with a GATEWAY denial reason',
    build: async (f) => {
      await openSpan(f);
      twoCalls(f, { secondStatus: 'error', secondReason: 'policy_denied' });
      await closeSpan(f);
    },
  },
  unverified_success: {
    condition: 'nothing failed, was denied, superseded, abandoned, '
      + 'and no feedback or verification arrived',
    build: async (f) => {
      await openSpan(f);
      twoCalls(f);
      await closeSpan(f);
    },
  },
  model_claim: {
    condition: 'always present — the model said something about the outcome',
    build: async (f) => {
      await openSpan(f);
      twoCalls(f);
      await closeSpan(f);
    },
  },
  typed_acceptance: {
    condition: 'chat.execution.feedback {kind: accepted} after closure',
    build: async (f) => {
      await openSpan(f);
      twoCalls(f);
      await closeSpan(f);
      await f.feedbackRecorder.record({
        session_id: 's1', turn_id: 't1', kind: 'accepted',
      });
    },
  },
  typed_correction: {
    condition: 'chat.execution.feedback {kind: corrected} after closure',
    build: async (f) => {
      await openSpan(f);
      twoCalls(f);
      await closeSpan(f);
      await f.feedbackRecorder.record({
        session_id: 's1', turn_id: 't1', kind: 'corrected',
      });
    },
  },
  typed_rejection: {
    condition: 'chat.execution.feedback {kind: rejected} after closure',
    build: async (f) => {
      await openSpan(f);
      twoCalls(f);
      await closeSpan(f);
      await f.feedbackRecorder.record({
        session_id: 's1', turn_id: 't1', kind: 'rejected',
      });
    },
  },
  typed_undo: {
    condition: 'chat.execution.feedback {kind: undone} after closure',
    build: async (f) => {
      await openSpan(f);
      twoCalls(f);
      await closeSpan(f);
      await f.feedbackRecorder.record({
        session_id: 's1', turn_id: 't1', kind: 'undone',
      });
    },
  },
  verification_pass: {
    condition: 'a verification record with kind passed',
    build: async (f) => {
      await openSpan(f);
      twoCalls(f);
      await closeSpan(f);
      await f.verificationRecorder.record({
        session_id: 's1', turn_id: 't1', kind: 'passed',
        postcondition_key: 'mail-delivered', source_event_id: 'verify-passed',
      });
    },
  },
  verification_fail: {
    condition: 'a verification record with kind failed',
    build: async (f) => {
      await openSpan(f);
      twoCalls(f);
      await closeSpan(f);
      await f.verificationRecorder.record({
        session_id: 's1', turn_id: 't1', kind: 'failed',
        postcondition_key: 'mail-delivered', source_event_id: 'verify-failed',
      });
    },
  },
  flow_superseded: {
    condition: 'a later flow in the same root replaced an earlier one',
    build: null,
    unreachable: 'needs two flow groups in one root; this bench drives one turn',
  },
  abandoned: {
    condition: 'an approval expired (RECIPE_APPROVAL_TIMEOUT)',
    build: null,
    unreachable: 'needs a held plan aged past its approval window',
  },
  untyped_decline: {
    condition: 'the owner declined without a typed feedback record',
    build: null,
    unreachable: 'needs an untyped decline signal this bench does not emit',
  },
};

const KINDS = Object.keys(DERIVATION) as CaseEvidenceKind[];

const derivedKinds = async (kind: CaseEvidenceKind): Promise<string[]> => {
  const f = await fixture();
  await DERIVATION[kind].build!(f);
  const observations = await f.caseStore.listObservations();
  return observations.flatMap((o) => o.evidence_kinds);
};

describe('D-214 admission is ASYMMETRIC in substantive calls', () => {
  // ⛔ THIS ASYMMETRY BROKE A DIFFERENTIAL DESIGN. `EXECUTION_CASE_MIN_CALLS_
  // NEGATIVE` is 1 and `MIN_CALLS_POSITIVE` is 2, so ONE request shape can seed
  // a DENIAL corpus and fail to seed an APPROVAL corpus — measured live in the
  // 157 pair: identical wording, denial half compiled 2 cases, approval half
  // compiled 0 from 7 observations, all ineligible.
  //
  // The asymmetry is deliberate (§8.2 — be readier to remember a failure than a
  // success). The consequence for a bench is that a differential pair CANNOT
  // share a single-action request; it needs ≥2 substantive calls so both halves
  // clear their own bar.
  const spanWithCalls = async (count: number, succeeded: boolean) => {
    const f = await fixture();
    await openSpan(f);
    for (let i = 0; i < count; i += 1) {
      addActivity(f.db, {
        id: `a${i}`,
        at: 101 + i,
        tool: i === 0 ? 'file.search' : 'mail.send',
        // ⚠ D-219 slice 3 — the negative arm NO LONGER breaks the activity.
        // `execution_failure` is an absolute exclusion: an observation carrying
        // it is not a case even when the owner ALSO corrected the turn, because
        // a flow that broke never finished and cannot attest to its approach.
        // The negative here is the CORRECTION alone.
      });
    }
    await closeSpan(f);
    // ⚠ D-219 slice 3 — the NEGATIVE arm records an owner CORRECTION rather than
    // relying on the activity error. A failure is now an exclusion, so a span
    // that merely broke admits nothing and this helper could no longer exercise
    // the negative call floor at all.
    await f.feedbackRecorder.record({
      session_id: 's1', turn_id: 't1', kind: succeeded ? 'accepted' : 'corrected',
    });
    return (await f.caseStore.listAll()).length;
  };

  it('D-219 slice 7: a ONE-call turn is not a candidate in EITHER direction', async () => {
    // ⚠ REVERSES this file's own earlier claim. The asymmetry — negatives at 1,
    // positives at 2 — is gone: candidacy is uniform at MORE THAN ONE governed
    // call, because a case is for a procedure worth short-circuiting and one
    // call is not a procedure.
    expect(await spanWithCalls(1, false)).toBe(0);
    expect(await spanWithCalls(1, true)).toBe(0);
    // ⚠ …and TWO still admits, in both directions, or this would pass against a
    // substrate that admits nothing.
    expect(await spanWithCalls(2, false)).toBe(1);
    expect(await spanWithCalls(2, true)).toBe(1);
  });

  it('does NOT admit a POSITIVE at one substantive call', async () => {
    expect(await spanWithCalls(1, true)).toBe(0);
  });

  it('admits a POSITIVE once it reaches two', async () => {
    expect(await spanWithCalls(2, true)).toBe(1);
  });
});

describe('D-214 evidence derivation — the PREFLIGHT denial path', () => {
  /** The owner refuses a HELD send after the turn. This is the denial shape the
   * substrate-bench actually produces, and arguably the commonest real one:
   * `denyRun` flips the run anchor to failed with RECIPE_POLICY_DENIED, and the
   * pairing marks the dispatching activity `status: 'error'` while leaving
   * `reason` undefined. */
  const preflightDenied = async () => {
    const f = await fixture();
    await openSpan(f);
    addActivity(f.db, { id: 'a1', at: 101, tool: 'file.search' });
    addActivity(f.db, { id: 'a2', at: 102, tool: 'mail.send' });
    putRecipeRun(f.db, {
      id: 'run-held',
      at: 102,
      recipe: 'mail.send',
      status: 'failed',
      codes: ['RECIPE_POLICY_DENIED'],
    });
    await closeSpan(f);
    const observations = await f.caseStore.listObservations();
    return observations.flatMap((o) => o.evidence_kinds);
  };

  it('treats EVERY owner-refusal error code as a denial, not just the emitted one', async () => {
    // ⛔ A SURVIVING MUTATION asked for this: shrinking the refusal set to the
    // one code that is currently emitted broke nothing, because nothing tested
    // the other. `RECIPE_APPROVAL_DENIED` — message "You blocked this step. The
    // recipe stopped without making the change." — is declared in the
    // RecipeErrorCode union and emitted by NOTHING today. The moment anything
    // emits it, a one-string check would file an owner refusal as a capability
    // failure again: the exact defect V7 and V8 were fixing, recurring through
    // a hand-copied vocabulary.
    const f = await fixture();
    await openSpan(f);
    addActivity(f.db, { id: 'a1', at: 101, tool: 'file.search' });
    addActivity(f.db, { id: 'a2', at: 102, tool: 'mail.send' });
    putRecipeRun(f.db, {
      id: 'run-blocked',
      at: 102,
      recipe: 'mail.send',
      status: 'failed',
      codes: ['RECIPE_APPROVAL_DENIED'],
    });
    await closeSpan(f);
    const kinds = (await f.caseStore.listObservations())
      .flatMap((o) => o.evidence_kinds);
    expect(kinds).toContain('gateway_denial');
    expect(kinds).not.toContain('execution_failure');
  });

  it('carries the failure CODE from the run onto the observation', async () => {
    // ⛔ A SURVIVING MUTATION asked for this. The presentation tests build
    // observations with `failure_codes` already set, so nothing covered the
    // COMPILER actually lifting them off the paired run — the one step that
    // makes a real failure diagnosable. Deleting that population broke nothing.
    //
    // This is the seam that closes substrate-bench 161: the card could say THAT
    // a flow failed and never WHY, and a card with no diagnosis changed nothing
    // (baseline 24/24 and card-shown 13/13 both hit the same known-failing
    // action).
    const f = await fixture();
    await openSpan(f);
    addActivity(f.db, { id: 'a1', at: 101, tool: 'file.search' });
    addActivity(f.db, { id: 'a2', at: 102, tool: 'mail.send' });
    putRecipeRun(f.db, {
      id: 'run-selfloop',
      at: 102,
      recipe: 'mail.send',
      status: 'failed',
      codes: ['MAIL_SEND_SELF_LOOP_TO'],
    });
    await closeSpan(f);
    const observations = await f.caseStore.listObservations();
    expect(observations).toHaveLength(1);
    expect(observations[0]!.failure_codes).toContain('MAIL_SEND_SELF_LOOP_TO');
    // …and it is still a FAILURE, not a denial — this code is not a refusal.
    expect(observations[0]!.evidence_kinds).toContain('execution_failure');
  });

  it('files an owner PREFLIGHT refusal as a denial, not a failure', async () => {
    // ⛔ The V7 fix covered ACTIVITY-reason denials (`policy_denied`,
    // `classification_blocked`) — but `denied` reads only `activity.reason`,
    // and a preflight refusal carries no reason. It arrives as
    // `recipe_error_codes: ['RECIPE_POLICY_DENIED']` with `status: 'error'`
    // attached by the pairing, so `failed && !denied` filed it as a CAPABILITY
    // failure — exactly what the ruling says a denial is not.
    //
    // Found because the reasoning-support bench came back VACUOUS: the card
    // reached the model in 4 of 8 turns and carried a denial in 0 of them,
    // because the seeded corpus held `execution_failure` instead.
    const kinds = await preflightDenied();
    expect(kinds).toContain('gateway_denial');
    expect(kinds).not.toContain('execution_failure');
  });
});

describe('D-214 evidence derivation — span → evidence_kinds', () => {
  it('reports which kinds this bench can drive from a real span', () => {
    const reachable = KINDS.filter((k) => DERIVATION[k].build !== null);
    const unreachable = KINDS.filter((k) => DERIVATION[k].build === null);
    // eslint-disable-next-line no-console
    console.log([
      '── DERIVATION COVERAGE (span → evidence kind) ──',
      `  driven from a real span ${reachable.length}/${KINDS.length}`,
      ...unreachable.map((k) =>
        `  NOT DRIVEN  ${k} — ${DERIVATION[k].unreachable}`),
    ].join('\n'));
    // ⚠ A gap that is NAMED is a gap; one that is silent is a false green.
    expect(reachable.length).toBeGreaterThan(unreachable.length);
  });

  for (const kind of KINDS) {
    const row = DERIVATION[kind];
    if (row.build === null) continue;
    it(`derives '${kind}' from: ${row.condition}`, async () => {
      expect(await derivedKinds(kind)).toContain(kind);
    });
  }

  // ── The polarity guards. These are the two bugs, generalised. ──────────

  it('never derives a POSITIVE kind from a span that failed', async () => {
    // The pairing defect in one assertion: a failed span filing
    // `unverified_success` is not a missing negative, it is an inverted one.
    const kinds = await derivedKinds('execution_failure');
    expect(kinds).toContain('execution_failure');
    expect(kinds).not.toContain('unverified_success');
    expect(kinds).not.toContain('verification_pass');
    expect(kinds).not.toContain('typed_acceptance');
  });

  it('never derives a POSITIVE kind from a span that was DENIED', async () => {
    const kinds = await derivedKinds('gateway_denial');
    expect(kinds).toContain('gateway_denial');
    expect(kinds).not.toContain('unverified_success');
  });

  it('a DENIAL is not a FAILURE — the two consumers now agree', async () => {
    // Found by a SURVIVING mutation: removing `!denied` from the
    // unverified_success suppression changed nothing, because `failed` was
    // already true for a denied span. One denied activity was deriving BOTH
    // `gateway_denial` and `execution_failure` — two strong negatives for one
    // event, and both bypass the recurrence floor.
    //
    // `execution_failure` is evidence about CAPABILITY (it was tried and did
    // not work). `gateway_denial` is evidence about the OWNER'S JUDGEMENT (it
    // works; they said no). Conflating them told the card "this broke" when
    // the truth was "you declined", so the model could not frame a re-request
    // as a choice.
    //
    // Not new semantics: `outcome.execution` already reads `not_executed` for a
    // denial, and the experiment axis already excluded denial reasons from
    // `execution_failure`. The evidence array was the last place conflating
    // them.
    const kinds = await derivedKinds('gateway_denial');
    expect(kinds).toContain('gateway_denial');
    expect(kinds).not.toContain('execution_failure');
    // The warning survives: a denial is still a strong negative, so the flow is
    // still a material contradiction and still reaches the card.
    expect(kinds).not.toContain('unverified_success');
  });

  it('derives unverified_success ONLY when nothing adverse happened', async () => {
    // The else-branch is the one that inverts polarity when an upstream signal
    // is missed, so pin that it fires on a clean span and nowhere else.
    expect(await derivedKinds('unverified_success'))
      .toContain('unverified_success');
    for (const adverse of [
      'execution_failure', 'gateway_denial', 'verification_fail',
      'typed_correction', 'typed_rejection', 'typed_undo',
    ] as const) {
      expect(await derivedKinds(adverse), `${adverse} must suppress it`)
        .not.toContain('unverified_success');
    }
  });

  it('always carries model_claim, and it never stands alone as a signal', async () => {
    // `model_claim` is the only INERT kind — it moves no counter. If it were
    // ever the sole derived kind the span would be uncompilable evidence, so
    // the derivation must always pair it with something that means something.
    for (const kind of KINDS.filter((k) => DERIVATION[k].build !== null)) {
      const kinds = await derivedKinds(kind);
      expect(kinds, `${kind} span`).toContain('model_claim');
      expect(
        kinds.filter((k) => k !== 'model_claim').length,
        `${kind} span must derive more than model_claim`,
      ).toBeGreaterThan(0);
    }
  });
});
