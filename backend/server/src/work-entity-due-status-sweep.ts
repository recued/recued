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
): 'not_due' | 'due_soon' | 'overdue' | 'no_deadline' => {
  if (commitment.promised_for_at === undefined) return 'no_deadline';
  if (now >= commitment.promised_for_at) return 'overdue';
  if (now >= commitment.promised_for_at - WORK_ENTITY_DUE_SOON_WINDOW_MS) {
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
): 'no_deadline' | 'not_due' | 'due_soon' | 'overdue' => {
  if (task.done) return 'no_deadline';
  if (task.due_at === undefined) return 'no_deadline';
  if (now >= task.due_at) return 'overdue';
  if (now >= task.due_at - WORK_ENTITY_DUE_SOON_WINDOW_MS) return 'due_soon';
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
      const cls = classifyTaskDueWindow(task, now);
      // Codex P1 fold — task event idempotence. Only emit when the
      // classified state diverges from the ledger's last entry. Tasks
      // not in the ledger are first-observation (or post-restart);
      // the sweep emits once and writes the ledger entry. Subsequent
      // sweeps see the entry and skip until the state moves.
      const last = deps.taskEmissionLedger?.get(task.id);
      if (cls === 'overdue') {
        if (last !== 'overdue') {
          emit(deps.bus, 'task', 'overdue', task, undefined, now);
          result.task_overdue_emitted++;
          deps.taskEmissionLedger?.set(task.id, 'overdue');
        }
      } else if (cls === 'due_soon') {
        if (last !== 'due_soon') {
          emit(deps.bus, 'task', 'due_soon', task, undefined, now);
          result.task_due_soon_emitted++;
          deps.taskEmissionLedger?.set(task.id, 'due_soon');
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
    const target = classifyCommitmentDueStatus(commitment, now);
    if (target === commitment.due_status) continue;
    // Only the forward-direction transitions are sweep-driven —
    // back-transitions (overdue → due_soon when rescheduled) are
    // dispatcher-driven (commitment-update with new
    // `promised_for_at`). The sweep only walks forward.
    if (
      (commitment.due_status === 'not_due' || commitment.due_status === 'no_deadline')
      && (target === 'due_soon' || target === 'overdue')
    ) {
      // legitimate forward move
    } else if (commitment.due_status === 'due_soon' && target === 'overdue') {
      // legitimate forward move
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

    if (target === 'overdue') {
      emit(deps.bus, 'commitment', 'overdue', next, prior, now);
      result.commitment_overdue_emitted++;
    } else if (target === 'due_soon') {
      emit(deps.bus, 'commitment', 'due_soon', next, prior, now);
      result.commitment_due_soon_emitted++;
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

  return result;
};
