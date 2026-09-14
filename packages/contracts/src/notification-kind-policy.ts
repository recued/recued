/** D-269 step 2 — the per-kind notification policy.
 *
 *  ⛔ THE HORIZON WAS A CONSTANT, NOT A SETTING. `WORK_ENTITY_DUE_SOON_WINDOW_MS`
 *  is `24 * 60 * 60 * 1000`, shared by tasks AND commitments, read straight by
 *  the sweep, commented *"the 24h horizon is a human-attention default"*. A
 *  booking wants a different lead time than a note-to-self deadline, and no
 *  owner could say so.
 *
 *  ── The axis is ANCHORED vs ARRIVAL ──────────────────────────────
 *  A kind earns a policy by carrying a TIME ANCHOR — a moment that has not
 *  happened yet. ⛔ NOT by being owned vs mirrored, which would put `calendar`
 *  on the wrong side: mirrored `calendar` gets one because it has a slot, and
 *  mirrored `mail` gets none because it has no anchor, not because it is
 *  mirrored. Arrival kinds (mail / file / crm) are already served by the
 *  D-115/D-124 reactive lane, where the "policy" is which recipes you installed.
 *
 *  ⛔ `project` IS DELIBERATELY ABSENT. It has a real anchor
 *  (`target_completion_at`) and the owner ruled it out: *"more manual"*. A
 *  project deadline is a thing the owner MOVES, not a thing that arrives;
 *  nudging it is a to-do list pretending to be a project tool.
 *
 *  ⛔⛔ AND THE POLICY GOVERNS TELLING, NEVER STATE. For a commitment the sweep
 *  also advances the persisted `due_status` column and flips
 *  `lifecycle_state → expired` under `strict_expire`. **An owner switching off a
 *  reminder must not stop a commitment expiring** — that would turn a
 *  notification preference into silent data corruption. `enabled` gates the
 *  EMISSION only; the classification and the write happen regardless.
 *
 *  Spec: internal design notes D-269 REV 2 Q2/Q4. */

/** The kinds that carry a time anchor, and therefore a reminder policy. */
export const NOTIFICATION_ANCHORED_KINDS = [
  'task',        // due_at
  'commitment',  // promised_for_at
  'booking',     // slot_start_at
  'calendar',    // start_at
] as const;

export type NotificationAnchoredKind = typeof NOTIFICATION_ANCHORED_KINDS[number];

export const isNotificationAnchoredKind = (
  value: unknown,
): value is NotificationAnchoredKind =>
  typeof value === 'string'
  && (NOTIFICATION_ANCHORED_KINDS as readonly string[]).includes(value);

/** One kind's policy. */
export interface NotificationKindPolicy {
  kind: NotificationAnchoredKind;
  /** Whether the owner is TOLD. ⛔ Never gates the state advance — see the
   *  header. A disabled kind still classifies, still writes `due_status`, still
   *  expires under `strict_expire`; it just stops emitting the reminder. */
  enabled: boolean;
  /** How far BEFORE the anchor the reminder fires, in ms. Replaces
   *  `WORK_ENTITY_DUE_SOON_WINDOW_MS` as the sweep's input. */
  offset_ms: number;
    updated_at: number;
}

/** ⚠ TASK AND COMMITMENT DEFAULT TO TODAY'S 24h, AND MUST. This ships to
 *  servers with live rows classified against that window; a different default
 *  would silently reclassify every one of them on upgrade, which is a data
 *  change dressed as a preference.
 *
 *  The two kinds with no emitter yet get the defaults their shape argues for
 *  rather than an inherited 24h: a booking is an appointment you travel to, and
 *  a calendar reminder that arrives a day early is the one everybody turns off. */
export const NOTIFICATION_KIND_DEFAULT_OFFSET_MS: Readonly<
  Record<NotificationAnchoredKind, number>
> = {
  task: 24 * 60 * 60 * 1000,
  commitment: 24 * 60 * 60 * 1000,
  booking: 2 * 60 * 60 * 1000,
  calendar: 15 * 60 * 1000,
};

/** ⛔ A NEGATIVE OFFSET IS NOT A SMALL MISTAKE — it is a different feature.
 *  "Tell me an hour AFTER it was due" is an escalation, and the sweep's
 *  forward-only classification cannot express it, so it is refused rather than
 *  quietly clamped to zero. */
export const NOTIFICATION_KIND_MIN_OFFSET_MS = 0;

/** ⚠ Bounded so a typo cannot arm a reminder that never stops firing: the sweep
 *  classifies everything inside the window as `due_soon`, so a 10-year offset
 *  makes every future task permanently due-soon — an always-on state that reads
 *  as a broken feature rather than as a setting. */
export const NOTIFICATION_KIND_MAX_OFFSET_MS = 30 * 24 * 60 * 60 * 1000;

export const isValidNotificationOffsetMs = (value: unknown): value is number =>
  typeof value === 'number'
  && Number.isFinite(value)
  && Number.isInteger(value)
  && value >= NOTIFICATION_KIND_MIN_OFFSET_MS
  && value <= NOTIFICATION_KIND_MAX_OFFSET_MS;

/** ⛔⛔⛔ `respects_quiet_hours` WAS HERE AND IS RETIRED — IT WAS A CATEGORY
 *  ERROR. It asked, per kind, *"may this interrupt the window?"*, which mixes two
 *  concerns that fail differently and are set at different times.
 *
 *  **Quiet hours is a MASTER SILENCER**: one fact about the person — when they
 *  are not to be disturbed — with exactly two controls, on/off and a range. **This
 *  policy is about the NOTIFICATIONS themselves**: which kinds you want at all,
 *  and how far ahead. A per-kind exemption from the window put a
 *  notification-policy question inside the quiet-hours concern, so neither panel
 *  could be read on its own and the window stopped meaning what it says.
 *
 *  ⚠ The stored column survives (unused, `DEFAULT 1`) rather than being dropped:
 *  self-hosted means no deploy order, and a column an old binary still writes is
 *  harmless while a dropped one is a downgrade that fails. See the store.
 *
 *  Owner's ruling, 2026-09-13 — see D-269 REV 15. */

export const defaultNotificationKindPolicy = (
  kind: NotificationAnchoredKind,
  updated_at = 0,
): NotificationKindPolicy => ({
  kind,
  // ⚠ ON by default, unlike quiet hours. These reminders are the behaviour the
  // server ALREADY has for task/commitment, so defaulting off would be a silent
  // feature removal on upgrade — the opposite of the quiet-hours case, where
  // default-ON would be a silent addition.
  enabled: true,
  offset_ms: NOTIFICATION_KIND_DEFAULT_OFFSET_MS[kind],
  updated_at,
});

/** `notification.kind_policy.get` — every kind, always all four, so a client
 *  renders the full list without knowing which rows exist. */
export interface NotificationKindPolicyGetResponse {
  policies: NotificationKindPolicy[];
}

export interface NotificationKindPolicySetRequest {
  kind: NotificationAnchoredKind;
  enabled?: boolean;
  offset_ms?: number;
}

export type NotificationKindPolicySetResponse = NotificationKindPolicyGetResponse;
