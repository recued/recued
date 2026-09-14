/** D-145 PA4 — Due-status sweep for tasks + commitments.
 *
 *  Periodic deadline-crossing sweep that drives the three time-based
 *  trigger kinds:
 *    - `task_due_soon`        — task crosses `due_at - 24h` while pending
 *    - `task_overdue`         — task crosses `due_at` while pending
 *    - `commitment_due_soon`  — commitment crosses `promised_for_at - 24h`
 *                                while `lifecycle: pending`
 *    - `commitment_overdue`   — surfaced as `due_status: 'overdue'`
 *                                via the bus + on `lifecycle: expired`
 *                                when `expiry_policy: 'strict_expire'`.
 *
 *  Runs at server boot + on a fixed cadence (housekeeping wires the
 *  loop). Idempotent on the steady-state set:
 *    - **Commitments** persist `due_status` on the row, so the sweep
 *      detects + skips rows already at the classified target.
 *    - **Tasks** have no `due_status` column; the sweep uses an
 *      in-process emission ledger (`TaskEmissionLedger`) keyed on
 *      task id to dedup re-emits across cycles. Process restart
 *      drops the ledger — the next sweep emits `due_soon`/`overdue`
 *      again on first observation, but the warehouse-event binder's
 *      60s per-(record_id, event_kind) dedup window catches the
 *      immediate re-fire and the recipe-side reactive dedup catches
 *      the rest.
 *
 *  § A.1.3 — `expiry_policy` discriminates **lifecycle** treatment
 *  when a pending commitment crosses the deadline. The **due_status**
 *  axis advances independently of policy per the spec transition
 *  table (`due_status: due_soon → overdue` fires for any pending
 *  commitment regardless of policy):
 *    - `'strict_expire'`     → flip `lifecycle_state: pending → expired`
 *                              (terminal — no further transitions
 *                              without explicit user action). Emits
 *                              `state_changed` alongside `overdue`.
 *    - `'escalate_overdue'`  → keep `lifecycle: pending`, advance
 *                              `due_status: overdue`. The default —
 *                              monetary commitments must persist past
 *                              the deadline as overdue, not silently
 *                              expire.
 *    - `'indefinite'`        → keep `lifecycle: pending`, advance
 *                              `due_status: overdue`. The deadline
 *                              has no LIFECYCLE effect (rolling
 *                              obligations stay open until explicit
 *                              fulfilled / cancelled), but the
 *                              due_status axis still moves so
 *                              recipes can render the deadline
 *                              crossing.
 *
 *  Spec: D-145 § Phase PA4 + § A.1.3. */

import {
  WORK_ENTITY_DUE_SOON_WINDOW_MS,
  buildQuietHoursDigest,
  isQuietHoursDigestEmpty,
  type QuietHoursDigest,
  type QuietHoursDigestItem,
  WORK_ENTITY_BUS_ENTITY_TYPE,
  WORK_ENTITY_BUS_PLATFORM,
  type Commitment,
  type Task,
} from '@recued/contracts';
import type { WarehouseEventBus, WarehouseEventKind } from '@recued/warehouse-events';

import type { CascadeEngine } from './storage/enrichment-cascade.js';
import type { WorkEntityStore } from './storage/work-entity-store.js';

/** Per-process emission ledger for the task-side dedup. Tasks lack
 *  a persisted `due_status` column, so the sweep tracks the last-
 *  emitted classified state per task in memory. Construct one ledger
 *  per server process via `createTaskEmissionLedger()` and reuse it
 *  across sweep calls (the housekeeping wrapper does this); tests
 *  pass a fresh ledger per assertion to keep state explicit. */
export interface TaskEmissionLedger {
  get(task_id: string): 'due_soon' | 'overdue' | undefined;
  set(task_id: string, state: 'due_soon' | 'overdue'): void;
  delete(task_id: string): void;
  size(): number;
}

export const createTaskEmissionLedger = (): TaskEmissionLedger => {
  const m = new Map<string, 'due_soon' | 'overdue'>();
  return {
    get: (id) => m.get(id),
    set: (id, state) => {
      m.set(id, state);
    },
    delete: (id) => {
      m.delete(id);
    },
    size: () => m.size,
  };
};

export interface DueStatusSweepDeps {
  store: WorkEntityStore;
  /** Optional warehouse event bus. Required to surface due_soon /
   *  overdue events to recipes — the sweep is silent without it. */
  bus?: WarehouseEventBus;
  /** Optional D-136 cascade engine. Fan invalidations on every
   *  commitment row that transitions (`update`-class change). */
  cascade?: CascadeEngine;
  /** Optional per-process task emission ledger (Codex P1 fold). Tasks
   *  have no persisted due_status — the sweep dedupes re-emits across
   *  cycles using this ledger. Absent → every sweep cycle re-emits
   *  for every still-eligible task (the pre-fold behavior, retained
   *  for one-shot test calls that don't care about idempotence). */
  taskEmissionLedger?: TaskEmissionLedger;
  /** D-269 step 2 — the owner's per-kind notification policy.
   *
   *  ⛔⛔ `enabled: false` GATES THE EMISSION AND NOTHING ELSE. For a commitment
   *  this sweep also advances the persisted `due_status` column and flips
   *  `lifecycle_state → expired` under `strict_expire`. Letting a notification
   *  preference stop that would turn "don't tell me about deadlines" into
   *  "commitments never expire" — a silent data change wearing a settings
   *  toggle. The classification and the write run regardless; only `emit` is
   *  skipped.
   *
   *  ⚠ Read PER SWEEP, not captured, so a policy change takes effect on the
   *  next cycle instead of at the next restart. Absent ⇒ the shared 24h
   *  constant and every kind enabled, exactly as before. */
  policy?: (kind: 'task' | 'commitment') => {
    enabled: boolean;
    offset_ms: number;
  };
  /** D-269 step 3 — is the owner's quiet-hours window active right now?
   *
   *  ⛔ SUPPRESSION IS SAFE HERE ONLY BECAUSE THE REMINDER IS RECONSTRUCTIBLE.
   *  A suppressed `due_soon` is not lost: the anchor row still says `due_soon`
   *  at 07:00, and for tasks the ledger is deliberately left un-advanced so the
   *  next sweep after the window re-emits. **The anchor rows are the queue** —
   *  which is why this holds nothing and stores nothing.
   *
   *  ⚠ Takes the instant so the caller owns the clock and the zone; this file
   *  knows nothing about either. Absent ⇒ never quiet, exactly as before. */
  isQuiet?: (at: number) => boolean;
  /** D-269 step 4 — the release edge and the card that follows it.
   *
   *  ⛔⛔ THE SWEEP DOES NOT HOLD ANYTHING. `wasQuiet` reads ONE PERSISTED
   *  INTEGER (the last instant a sweep saw the window active) and `onReleased`
   *  is handed a digest RECOMPUTED from the rows in front of it. No notification
   *  is stored during the window — `durable-outbox`'s test is *"would the
   *  receiver be unable to RECONSTRUCT it"*, and a reminder is fully
   *  reconstructable from its anchor. **Knowing the window closed is the one
   *  thing no anchor row records**, which is why the marker exists and why it
   *  holds nothing else.
   *
   *  🔑 Recomputing is also MORE CORRECT than replaying: a held queue would
   *  deliver a reminder for a commitment cancelled at 03:00. */
  wasQuiet?: () => number | null;
  markQuiet?: (at: number | null) => void;
  onReleased?: (digest: QuietHoursDigest) => void;
  /** D-269 follow-on — the SAME persisted ledger the reminder sweep marks.
   *
   *  ⛔⛔ SHARED SO THE OWNER IS TOLD ONCE, NOT TWICE. Once task and commitment
   *  gained real per-item reminders, the release edge had two mouths: the card
   *  ("while you were away: 3 things") and three individual pings about the same
   *  three rows. The ledger is what makes them exclusive — this block skips a row
   *  already marked and marks every row it names, so whichever sweep reaches the
   *  release cycle first is the one that speaks.
   *
   *  🔑 ORDER-INDEPENDENT ON PURPOSE. Housekeeping does not promise an order
   *  between two tasks, and a correctness argument that rests on one is a
   *  correctness argument with a scheduling change underneath it. Reminder sweep
   *  first ⇒ pings, and the card comes out empty and is not sent. This sweep
   *  first ⇒ the card, and the pings skip. Exactly one telling either way.
   *
   *  ⚠ It also fixes something older: a row told at 15:00 yesterday and still
   *  due_soon this morning was "while you were away" news about something you
   *  were told before you went away. Marked ⇒ no longer named. */
  reminderLedger?: { has(key: string): boolean; set(key: string, anchor_at: number): void };
  now?: () => number;
}

export interface DueStatusSweepResult {
  /** Number of tasks the sweep visited (subset of pending tasks with
   *  a `due_at`). */
  tasks_visited: number;
  /** Number of `task_due_soon` events emitted this sweep. */
  task_due_soon_emitted: number;
  /** Number of `task_overdue` events emitted this sweep. */
  task_overdue_emitted: number;
  /** Number of commitments the sweep visited (pending + has
   *  `promised_for_at`). */
  commitments_visited: number;
  /** Number of `commitment_due_soon` events emitted. */
  commitment_due_soon_emitted: number;
  /** Number of `commitment_overdue` events emitted. */
  commitment_overdue_emitted: number;
  /** Number of commitments flipped to `lifecycle: expired` under
   *  `strict_expire` policy. */
  commitments_expired: number;
  /** Number of commitments whose `due_status` advanced (write
   *  transactions completed). */
  commitments_due_status_updated: number;
}

/** ⛔⛔ MUST AGREE WITH `reminderMarkKey` BYTE FOR BYTE, and it is asserted to
 *  in `d-269-reminder-substrate.test.ts` rather than trusted. Two independently
 *  written key builders that "obviously" match is how a dedup silently stops
 *  deduping: each half reads as correct and only the PAIR is wrong. Not imported
 *  from the reminder sweep because that module imports the classifiers from this
 *  one, and the cycle would be real. */
const digestMarkKey = (i: QuietHoursDigestItem, now: number): string => {
  // ⚠ PRECONDITION: every item here classified `due_soon` or `overdue` a few
  // lines ago, and both classifiers split those two on exactly `now >= anchor`.
  // So this re-derives the state from the anchor rather than carrying it —
  // which is NOT a second copy of the window arithmetic (the offset-dependent
  // half), only of the past/future split the precondition already narrowed to.
  const state = i.anchor_at <= now ? 'overdue' : 'due_soon';
  return `${i.kind}:${i.id}:${i.anchor_at}:${state}`;
};

const emit = (
  bus: WarehouseEventBus | undefined,
  kind: 'task' | 'commitment',
  event_kind: WarehouseEventKind,
  record: Task | Commitment,
  prior: Task | Commitment | undefined,
  at: number,
): void => {
  if (!bus) return;
  try {
    bus.emit({
      platform: WORK_ENTITY_BUS_PLATFORM,
      slug: kind,
      entity_type: WORK_ENTITY_BUS_ENTITY_TYPE,
      event_kind,
      record_id: record.id,
      at,
      prev: {
        record: { _kind: kind, ...record },
        source_id: record.source_id,
        ...(prior ? { prior: { _kind: kind, ...prior } } : {}),
      },
    });
  } catch {
    // Bus emission must not abort the sweep.
  }
};

/** Sweep-side classifier. Returns the target `due_status` for a
 *  commitment given its `promised_for_at` + the current clock. Pure
 *  function — used by the sweep's transition logic + by tests. */
export const classifyCommitmentDueStatus = (
  commitment: Pick<Commitment, 'promised_for_at' | 'due_status'>,
  now: number,
  /** D-269 step 2 — the owner's per-kind horizon. Defaults to the shared 24h
   *  constant so every existing caller (and every test) keeps its meaning. */
  offsetMs: number = WORK_ENTITY_DUE_SOON_WINDOW_MS,
): 'not_due' | 'due_soon' | 'overdue' | 'no_deadline' => {
  if (commitment.promised_for_at === undefined) return 'no_deadline';
  if (now >= commitment.promised_for_at) return 'overdue';
  if (now >= commitment.promised_for_at - offsetMs) {
    return 'due_soon';
  }
  return 'not_due';
};

/** Equivalent classifier for tasks — tasks don't carry a
 *  `due_status` column, so the sweep emits the matching event_kind
 *  directly. */
export const classifyTaskDueWindow = (
  task: Pick<Task, 'due_at' | 'done'>,
  now: number,
  /** D-269 step 2 — see `classifyCommitmentDueStatus`. */
  offsetMs: number = WORK_ENTITY_DUE_SOON_WINDOW_MS,
): 'no_deadline' | 'not_due' | 'due_soon' | 'overdue' => {
  if (task.done) return 'no_deadline';
  if (task.due_at === undefined) return 'no_deadline';
  if (now >= task.due_at) return 'overdue';
  if (now >= task.due_at - offsetMs) return 'due_soon';
  return 'not_due';
};

const buildEmptyResult = (): DueStatusSweepResult => ({
  tasks_visited: 0,
  task_due_soon_emitted: 0,
  task_overdue_emitted: 0,
  commitments_visited: 0,
  commitment_due_soon_emitted: 0,
  commitment_overdue_emitted: 0,
  commitments_expired: 0,
  commitments_due_status_updated: 0,
});

/** Run one due-status sweep. Walks all live (non-tombstoned) pending
 *  commitments + tasks-with-due-dates, computes the target due_status
 *  for each, and emits + cascades on transitions.
 *
 *  Designed to be idempotent on the steady-state set — rows already
 *  at the target due_status are skipped. The sweep is bounded by the
 *  store's list pagination; callers can run it multiple times if the
 *  per-call window doesn't cover the warehouse (default 1000 rows
 *  per pass). */
export const runDueStatusSweep = (
  deps: DueStatusSweepDeps,
): DueStatusSweepResult => {
  const result = buildEmptyResult();
  const now = deps.now?.() ?? Date.now();
  // D-269 step 2 — resolved once per sweep so every row in one cycle is judged
  // against the same horizon; a policy write mid-sweep would otherwise classify
  // the first half of the list differently from the second.
  const taskPolicy = deps.policy?.('task')
    ?? { enabled: true, offset_ms: WORK_ENTITY_DUE_SOON_WINDOW_MS };
  const commitmentPolicy = deps.policy?.('commitment')
    ?? { enabled: true, offset_ms: WORK_ENTITY_DUE_SOON_WINDOW_MS };
  // D-269 step 3 — resolved once per sweep, like the policy, so one cycle does
  // not straddle the window boundary and classify half its rows each way.
  const taskQuiet = deps.isQuiet?.(now) ?? false;
  const commitmentQuiet = deps.isQuiet?.(now) ?? false;
  const tellTask = taskPolicy.enabled && !taskQuiet;
  const tellCommitment = commitmentPolicy.enabled && !commitmentQuiet;

  // ── D-269 step 4: the release edge ─────────────────────────────
  // ⚠ The EDGE, not the state. "Quiet now" fires every cycle of the night; what
  // the owner gets one card for is the transition out of it, and that is only
  // knowable by comparing against the last observation.
  const anyQuiet = taskQuiet || commitmentQuiet;
  const lastActive = deps.wasQuiet?.() ?? null;
  const released = !anyQuiet && lastActive !== null;
  if (anyQuiet) deps.markQuiet?.(now);
  else if (released) deps.markQuiet?.(null);

  // ── tasks ──────────────────────────────────────────────────────
  // Codex P1 fold — paginate so warehouses with > PAGE_SIZE pending
  // tasks fully sweep in one call. PAGE_SIZE matches MAX_LIST_LIMIT
  // in the work-entity-store; the inner offset loop walks the rest.
  const PAGE_SIZE = 1000;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = deps.store.listTasks({
      sync_states: ['live'],
      limit: PAGE_SIZE,
      offset,
    });
    if (page.length === 0) break;
    for (const task of page) {
      if (task.done) {
        // Drop the ledger entry — the task is no longer eligible.
        deps.taskEmissionLedger?.delete(task.id);
        continue;
      }
      if (task.due_at === undefined) {
        deps.taskEmissionLedger?.delete(task.id);
        continue;
      }
      result.tasks_visited++;
      const cls = classifyTaskDueWindow(task, now, taskPolicy.offset_ms);
      // Codex P1 fold — task event idempotence. Only emit when the
      // classified state diverges from the ledger's last entry. Tasks
      // not in the ledger are first-observation (or post-restart);
      // the sweep emits once and writes the ledger entry. Subsequent
      // sweeps see the entry and skip until the state moves.
      const last = deps.taskEmissionLedger?.get(task.id);
      // ⛔ THE LEDGER ADVANCES EVEN WHEN THE POLICY IS OFF. It records what the
      // task's state IS, not what was sent — so re-enabling the kind does not
      // replay every crossing that happened while it was off. A ledger that
      // only moved on emission would turn the toggle into a queue.
      // ⛔⛔ THE TWO SUPPRESSIONS ARE NOT THE SAME AND MUST NOT BE MERGED.
      //  · POLICY OFF (`enabled: false`) — the owner does not want this kind at
      //    all, so the crossing is passed over and the LEDGER ADVANCES.
      //    Re-enabling must not replay a month of crossings.
      //  · QUIET HOURS — the owner wants it LATER. The ledger is deliberately
      //    left where it is, so the next sweep after the window sees the state
      //    still diverging and emits then. That is the whole deferral mechanism:
      //    no queue, no stored pending notification, because the anchor row
      //    already carries everything needed to reproduce the reminder.
      if (cls === 'overdue') {
        if (last !== 'overdue') {
          if (tellTask) {
            emit(deps.bus, 'task', 'overdue', task, undefined, now);
            result.task_overdue_emitted++;
          }
          if (!taskQuiet) deps.taskEmissionLedger?.set(task.id, 'overdue');
        }
      } else if (cls === 'due_soon') {
        if (last !== 'due_soon') {
          if (tellTask) {
            emit(deps.bus, 'task', 'due_soon', task, undefined, now);
            result.task_due_soon_emitted++;
          }
          if (!taskQuiet) deps.taskEmissionLedger?.set(task.id, 'due_soon');
        }
      } else {
        // not_due / no_deadline — clear the ledger so a forward
        // crossing back into due_soon / overdue re-fires.
        deps.taskEmissionLedger?.delete(task.id);
      }
    }
    if (page.length < PAGE_SIZE) break;
  }

  // ── commitments ────────────────────────────────────────────────
  // Codex P1 fold — paginate. Commitments persist due_status on the
  // row so the sweep is already steady-state idempotent (rows already
  // at target skip in the body); pagination just means we visit every
  // pending row instead of capping at the first page.
  const commitments: Commitment[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = deps.store.listCommitments({
      sync_states: ['live'],
      limit: PAGE_SIZE,
      offset,
    });
    if (page.length === 0) break;
    commitments.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  for (const commitment of commitments) {
    if (commitment.lifecycle_state !== 'pending') continue;
    if (commitment.promised_for_at === undefined) continue;
    result.commitments_visited++;
    const target = classifyCommitmentDueStatus(commitment, now, commitmentPolicy.offset_ms);
    if (target === commitment.due_status) continue;
    // Forward-direction transitions are sweep-driven; back-transitions
    // (overdue → due_soon when rescheduled) are dispatcher-driven
    // (commitment-update with new `promised_for_at`).
    //
    // ⛔⛔ EXCEPT ONE, AND D-269 STEP 2 IS WHAT CREATED IT. `due_soon` used to
    // mean "inside the shared 24h constant", so nothing but a moved deadline
    // could take a row back out of it. It now means "inside the owner's
    // horizon" — and SHRINKING that horizon reclassifies rows that are already
    // `due_soon`. Without this branch they would stay `due_soon` until they
    // went overdue: the owner narrows their window and the rows that should
    // have left it never do. Forward-only was safe when the window was a
    // constant; it stops being safe the moment the window is a setting.
    //
    // ⚠ `overdue → due_soon` stays forbidden. That needs the ANCHOR to move,
    // which is a commitment update and not a policy change.
    if (
      (commitment.due_status === 'not_due' || commitment.due_status === 'no_deadline')
      && (target === 'due_soon' || target === 'overdue')
    ) {
      // legitimate forward move
    } else if (commitment.due_status === 'due_soon' && target === 'overdue') {
      // legitimate forward move
    } else if (commitment.due_status === 'due_soon' && target === 'not_due') {
      // policy narrowed the horizon out from under this row
    } else {
      continue;
    }

    const prior = commitment;
    const next: Commitment = {
      ...commitment,
      due_status: target,
      due_status_changed_at: now,
      state_changed_at: now,
      // strict_expire flips lifecycle on overdue per § A.1.3.
      ...(target === 'overdue' && commitment.expiry_policy === 'strict_expire'
        ? {
            lifecycle_state: 'expired' as const,
            lifecycle_changed_at: now,
          }
        : {}),
      updated_at: now,
    };

    deps.store.writeCommitment(
      {
        id: next.id,
        direction: next.direction,
        statement: next.statement,
        derivation: next.derivation,
        source_id: next.source_id,
        created_at: next.created_at,
        promised_at: next.promised_at,
        lifecycle_state: next.lifecycle_state,
        due_status: next.due_status,
        expiry_policy: next.expiry_policy,
        state_changed_at: next.state_changed_at,
        lifecycle_changed_at: next.lifecycle_changed_at,
        due_status_changed_at: next.due_status_changed_at,
        sync_state: next.sync_state,
        conflict_policy: next.conflict_policy,
        blocks_task_ids: next.blocks_task_ids,
        blocks_project_ids: next.blocks_project_ids,
        ...(next.promised_for_at !== undefined ? { promised_for_at: next.promised_for_at } : {}),
        ...(next.derivation_confidence !== undefined ? { derivation_confidence: next.derivation_confidence } : {}),
        ...(next.monetary_value !== undefined ? { monetary_value: next.monetary_value } : {}),
        ...(next.counterparty_contact_id !== undefined ? { counterparty_contact_id: next.counterparty_contact_id } : {}),
        ...(next.derived_from_mail_thread_id !== undefined ? { derived_from_mail_thread_id: next.derived_from_mail_thread_id } : {}),
        ...(next.derived_from_meeting_id !== undefined ? { derived_from_meeting_id: next.derived_from_meeting_id } : {}),
        ...(next.source_record_id !== undefined ? { source_record_id: next.source_record_id } : {}),
        ...(next.connection_id !== undefined ? { connection_id: next.connection_id } : {}),
        ...(next.source_record_hash !== undefined ? { source_record_hash: next.source_record_hash } : {}),
        // D-192 P4 — the vendor version base must survive the sweep's
        // full-row rewrite (codex review: the upsert would NULL both,
        // stranding the read-before-write / conditional-write base).
        ...(next.source_version_token !== undefined ? { source_version_token: next.source_version_token } : {}),
        ...(next.source_updated_at !== undefined ? { source_updated_at: next.source_updated_at } : {}),
        ...(next.source_extension_blob !== undefined ? { source_extension_blob: next.source_extension_blob } : {}),
      },
      now,
    );
    result.commitments_due_status_updated++;

    // ⛔⛔ GATED HERE, AFTER THE WRITE, AND THAT PLACEMENT IS THE WHOLE POINT.
    // The row above has already advanced `due_status` and expired under
    // `strict_expire`. Moving this gate any earlier would make "don't remind me
    // about commitments" mean "commitments never expire" — a settings toggle
    // silently changing what the data says.
    // ⚠ A COMMITMENT CANNOT DEFER THE WAY A TASK DOES, and the asymmetry is
    // forced: `due_status` is persisted and has already advanced above, so the
    // row will not diverge again on the next sweep. Nothing is lost — the row
    // still READS `due_soon` / `overdue` at 07:00, which is exactly what the
    // release digest queries — but the re-emit is the digest's job, not this
    // sweep's, and pretending otherwise here would mean storing a pending
    // notification, which is the queue the design refuses.
    if (tellCommitment) {
      if (target === 'overdue') {
        emit(deps.bus, 'commitment', 'overdue', next, prior, now);
        result.commitment_overdue_emitted++;
      } else if (target === 'due_soon') {
        emit(deps.bus, 'commitment', 'due_soon', next, prior, now);
        result.commitment_due_soon_emitted++;
      }
    }

    // strict_expire policy transitions lifecycle alongside due_status.
    // Emit the matching state_changed event so recipes subscribing
    // to lifecycle moves see the expire transition.
    if (target === 'overdue' && commitment.expiry_policy === 'strict_expire') {
      emit(deps.bus, 'commitment', 'state_changed', next, prior, now);
      result.commitments_expired++;
    }

    // Cascade — every transitioned commitment row invalidates
    // downstream PA9 enrichment (commitment_followthrough_score /
    // outbound_commitment_overdue_count etc.) the moment producers
    // register.
    if (deps.cascade) {
      try {
        deps.cascade.cascadeForSourceUpdate('commitment', next.id);
      } catch {
        /* non-fatal */
      }
    }
  }

  // ── D-269 step 4: the card, RECOMPUTED ────────────────────────
  // ⛔ Queried from the rows this sweep just walked, not from anything stored
  // during the window. A commitment cancelled at 03:00 is simply not here.
  if (released && deps.onReleased) {
    const items: QuietHoursDigestItem[] = [];
    for (const c of commitments) {
      if (c.lifecycle_state !== 'pending') continue;
      if (c.promised_for_at === undefined) continue;
      if (c.due_status !== 'due_soon' && c.due_status !== 'overdue') continue;
      items.push({
        kind: 'commitment', id: c.id, title: c.statement, anchor_at: c.promised_for_at,
      });
    }
    // ⚠ Tasks are re-walked rather than remembered from the loop above, because
    // that loop's job was emission and this one's is the card — and a shared
    // accumulator would quietly couple the two.
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = deps.store.listTasks({ sync_states: ['live'], limit: PAGE_SIZE, offset });
      if (page.length === 0) break;
      for (const t of page) {
        if (t.done || t.due_at === undefined) continue;
        const cls = classifyTaskDueWindow(t, now, taskPolicy.offset_ms);
        if (cls !== 'due_soon' && cls !== 'overdue') continue;
        items.push({ kind: 'task', id: t.id, title: t.title, anchor_at: t.due_at });
      }
      if (page.length < PAGE_SIZE) break;
    }

    // ⚠ Drop what the per-item reminders already covered (or are about to), and
    // claim what survives. `state` is part of the key because a row is told once
    // approaching and once past — see `reminderMarkKey`.
    const ledger = deps.reminderLedger;
    const named = ledger === undefined
      ? items
      : items.filter((i) => !ledger.has(digestMarkKey(i, now)));
    if (ledger !== undefined) {
      for (const i of named) ledger.set(digestMarkKey(i, now), i.anchor_at);
    }

    const digest = buildQuietHoursDigest(named, { from: lastActive!, to: now }, now);
    // ⛔ AN EMPTY CARD IS NOT SENT. "Nothing happened while you were away", every
    // morning, is the notification an owner switches off — taking the feature
    // with it.
    if (!isQuietHoursDigestEmpty(digest)) deps.onReleased(digest);
  }

  return result;
};
