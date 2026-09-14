import {
  BOOKING_DEFAULT_LIFECYCLE_STATE,
  type WorkEntity,
  type WorkEntityKind,
} from '@recued/contracts';

/** `work_entity.upsert`, answered for the full-app harness.
 *
 *  ⛔⛔ WITHOUT THIS, EVERY CAPTURE EXCEPT CONTACT HANGS ON COMMIT. An
 *  unanswered method in this harness never settles, so the Create overlay sat
 *  on "Committing draft…" forever for task / note / commitment / project /
 *  booking while `contact.upsert` — the one that IS answered — completed
 *  normally. Traced with `?trace_pending=1`: one unanswered method,
 *  `work_entity.upsert`, on all five.
 *
 *  ⚠ WHY IT WENT UNNOTICED. The shipped Create commit test drives the CONTACT
 *  target and asserts only the PENDING state ("Committing…", focus retained,
 *  aria-busy) before escaping — it never completes a commit, so it never needed
 *  an answer. A whole confirmation path was untested at this layer, and nothing
 *  said so.
 *
 *  ⛔ ECHOES WHAT WAS SENT, TYPED AS THE REAL UNION. A blob cast to `WorkEntity`
 *  would answer the call without carrying the message: the overlay's
 *  confirmation reads `title` / `body` / `statement` off the returned row, so a
 *  stub that invented a shape would let a broken label pass. Typing each arm
 *  makes the compiler hold this fixture to the same contract the server keeps.
 *
 *  ⚠ DECLINES under `?data=work-entities-paged`, which has its own stateful
 *  `work_entity.upsert` (it renames a `task-N` row and re-reads it). Two
 *  answers for one method would mean the later one silently wins. */
const FIXED_NOW = Date.parse('2026-09-08T12:00:00-07:00');

const identity = {
  source_id: 'recued.local',
  last_seen_at: FIXED_NOW,
  sync_state: 'live',
  conflict_policy: 'recued_wins',
} as const;

const stamps = { created_at: FIXED_NOW, updated_at: FIXED_NOW } as const;

const text = (value: unknown, fallback = ''): string =>
  typeof value === 'string' && value.trim().length > 0 ? value : fallback;

const built = (args: Record<string, unknown>, kind: WorkEntityKind): WorkEntity | null => {
  const id = text(args.id, `${kind}-fixture-1`);
  switch (kind) {
    case 'task':
      return { ...identity, ...stamps, _kind: 'task', id,
        title: text(args.title, 'Untitled task'), done: args.done === true,
        blocks_task_ids: [],
        ...(typeof args.due_at === 'number' ? { due_at: args.due_at } : {}),
        ...(typeof args.body === 'string' ? { body: args.body } : {}) };
    case 'note':
      return { ...identity, ...stamps, _kind: 'note', id,
        body: text(args.body), last_user_action_at: FIXED_NOW,
        related_contact_ids: [], related_calendar_event_ids: [],
        related_mail_thread_ids: [], related_project_ids: [],
        ...(typeof args.title === 'string' ? { title: args.title } : {}) };
    case 'project':
      return { ...identity, ...stamps, _kind: 'project', id,
        title: text(args.title, 'Untitled project'),
        state: (args.state as never) ?? 'active', last_activity_at: FIXED_NOW,
        related_contact_ids: [],
        ...(typeof args.description === 'string' ? { description: args.description } : {}) };
    case 'commitment':
      return { ...identity, ...stamps, _kind: 'commitment', id,
        statement: text(args.statement), direction: (args.direction as never) ?? 'outbound',
        derivation: (args.derivation as never) ?? 'user_declared',
        lifecycle_state: 'pending', due_status: 'not_due',
        expiry_policy: (args.expiry_policy as never) ?? 'escalate_overdue',
        promised_at: FIXED_NOW, state_changed_at: FIXED_NOW,
        lifecycle_changed_at: FIXED_NOW, due_status_changed_at: FIXED_NOW,
        blocks_task_ids: [], blocks_project_ids: [],
        ...(typeof args.promised_for_at === 'number'
          ? { promised_for_at: args.promised_for_at } : {}) };
    case 'booking':
      return { ...identity, ...stamps, _kind: 'booking', id,
        title: text(args.title, 'Untitled booking'),
        // ⛔ Echoes the state the caller SENT, defaulting the way the contract
        // does — by name, never `BOOKING_LIFECYCLE_STATES[0]`, which is
        // `pending` and is deliberately not the default.
        lifecycle_state: (args.lifecycle_state as never) ?? BOOKING_DEFAULT_LIFECYCLE_STATE,
        state_changed_at: FIXED_NOW,
        ...(typeof args.slot_start_at === 'number' && typeof args.slot_end_at === 'number'
          ? { slot_start_at: args.slot_start_at, slot_end_at: args.slot_end_at } : {}),
        ...(args.monetary_value !== undefined
          ? { monetary_value: args.monetary_value as never } : {}) };
    default:
      return null;
  }
};

export const workEntityUpsertDemoReply = (
  method: string,
  raw: unknown,
): { result?: unknown } | null => {
  if (method !== 'work_entity.upsert') return null;
  if (new URLSearchParams(location.search).get('data') === 'work-entities-paged') return null;
  const args = (raw ?? {}) as Record<string, unknown>;
  const entity = built(args, args.kind as WorkEntityKind);
  return entity === null ? null : { result: { entity } };
};
