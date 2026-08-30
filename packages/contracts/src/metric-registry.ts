/** D-250 § D — the owner-metric registry.
 *
 *  ONE ENTRY PER METRIC, and the entry is the definition of record. § D3.1a puts
 *  `metric_version` on the published ROW as a displayed attribute rather than in the
 *  board key, so a reader can tell which arithmetic produced a number; the version
 *  constant plus its per-version logic comment IS how that arithmetic is pinned.
 *
 *  ⛔ HOW TO BUMP A VERSION (D-250 amendment 12). Bump when the number MOVES FOR
 *  IDENTICAL INPUT — not when the code changes. A refactor, a rename or a perf pass
 *  that leaves the arithmetic alone keeps the version. ⚠ A BUG FIX DOES BUMP: nobody
 *  calls a fix a definition change, but a board can no longer compare pre-fix numbers
 *  to post-fix ones, and comparability is the only thing the version protects. Add a
 *  line to the metric's `logic` array on every bump; never edit a shipped line.
 *
 *  🔑 A GOLDEN VECTOR WAS PROPOSED AND RULED OUT — do not re-derive it. A snapshot test
 *  whose fix-it move is "accept the new number" degrades into this same declaration with
 *  a green tick over it. The comment is the mechanism. (Amendment 12.)
 */

import type { RiskTier } from './ingredient.js';

/** What KIND of number a metric produces. § D5.2 — not everything is a ratio. */
/** A metric's reading, with the THREE states § D5.3 needs rather than two.
 *
 *  ⛔⛔ `unbounded` IS NOT AN ERROR AND NOT A ZERO — IT IS THE BEST CASE. Waved through
 *  is *askable ops ÷ approvals you answered*, so a period where the owner answered
 *  NOTHING while risky work still ran is the ideal, and § D5.3 rules it must "rank above
 *  every finite value" rather than divide by zero. A two-state `number | undefined`
 *  cannot say that: it would silently drop exactly the best periods, and the metric
 *  would punish the behaviour it exists to reward.
 *  ⚠ `absent` is the different fact that there was nothing to measure at all. */
export type MetricReading =
  | { readonly kind: 'value'; readonly value: number }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unbounded' };

export const metricValue = (value: number): MetricReading => ({ kind: 'value', value });
export const METRIC_ABSENT: MetricReading = { kind: 'absent' };
export const METRIC_UNBOUNDED: MetricReading = { kind: 'unbounded' };

/** Divide into a {@link MetricReading}. `zeroDenominatorIsBest` picks which of the two
 *  non-numeric states an empty denominator means — Waved through is the only metric
 *  where it is the best case rather than no data. */
export const metricRatio = (
  numerator: number,
  denominator: number,
  zeroDenominatorIsBest = false,
): MetricReading => {
  if (denominator > 0) return { kind: 'value', value: numerator / denominator };
  if (zeroDenominatorIsBest && numerator > 0) return { kind: 'unbounded' };
  return { kind: 'absent' };
};

export type MetricShape =
  | 'share' // 0..1, a part of a whole
  | 'ratio' // unbounded rate, numerator and denominator in different units
  | 'record' // the best single observation ever seen
  | 'streak' // consecutive-period counter
  | 'count' // a plain total (§ D2: internal only, never publishable)
  | 'milestone'; // binary, one-time

/** WHICH STORE holds it (§ Open 9a, amendment 17).
 *
 *  ⛔ THE TWO ARE PRODUCED DIFFERENTLY, WHICH IS WHY THEY ARE SEPARATE STORES:
 *  a `snapshot` metric is RECOMPUTED from the audit window and the row is replaced
 *  whole, so it keeps no memory and nothing survives audit eviction. An `artifact`
 *  metric ADVANCES from its own previous value plus today — it never scans the past,
 *  so it needs one prior key rather than a history, and it outlives the raw rows. */
export type MetricStore = 'snapshot' | 'artifact';

/** § D5.9 — prefer a share, else higher-is-better. `lower` exists because § B3
 *  supports it, not because anything Recued authors should use it. */
export type MetricDirection = 'higher' | 'lower';

export interface MetricDefinition {
  readonly metric_id: string;
  /** ⛔ Bump only when the NUMBER MOVES for identical input. See the file header. */
  readonly metric_version: number;
  /** One line per version, oldest first. Index 0 is v1. The array length must equal
   *  `metric_version` — {@link assertMetricRegistryConsistent} enforces it, so a bump
   *  without a logic line fails at boot rather than shipping an unexplained number. */
  readonly logic: readonly string[];
  readonly shape: MetricShape;
  readonly store: MetricStore;
  readonly direction: MetricDirection;
  /** ⛔ § D2's scale-invariance test: a COUNT is internal, a RATIO is publishable.
   *  A count publishes VOLUME (how much server you own); a ratio publishes SKILL. */
  readonly publishable: boolean;
  /** Human label for the dashboard. */
  readonly label: string;
  /** ⛔⛔ ONE PLAIN SENTENCE SAYING WHAT THE NUMBER MEANS, and it travels on the wire
   *  for the same reason `direction` does (see `metric-rpc.ts`): client and server
   *  version independently, so a description held client-side would eventually describe
   *  a rule the server no longer runs. ⚠ It restates `logic` for a reader who does not
   *  know the schema — it is not a second definition, and it must not disagree with the
   *  logic line above it. */
  readonly description: string;
}

// ────────────────────────────────────────────────────────────────
// Autopilot's countable set — § D3.1's ratchet applies HERE
// ────────────────────────────────────────────────────────────────

/** How one `trigger_source` counts toward Autopilot.
 *
 *  ⛔⛔ AN UNLISTED SOURCE IS `'excluded'`, NEVER `'attended'` — AND THAT IS THE WHOLE
 *  POINT OF MAKING THIS A FUNCTION RATHER THAN A `Record`. A closed vocabulary keyed as
 *  a plain lookup FAILS OPEN: a `trigger_source` added elsewhere in the codebase would
 *  land in whichever bucket the fallback picked, the ratio would change meaning, and
 *  `metric_version` would not bump because nobody edited this file. Excluding the
 *  unknown keeps the ratio comparable and lets the caller COUNT what it could not
 *  classify, which is how the drift becomes visible instead of silent. */
export type AutopilotClass = 'unattended' | 'attended' | 'excluded';

/** ⚠ THE COUNTABLE SET IS PART OF THE DEFINITION (§ D3.1). Changing any line here
 *  changes what Autopilot MEANS and therefore bumps `metric_version`.
 *
 *  ⛔⛔ AND § D3.1's RATCHET CANNOT BE BUILT AGAINST `TriggerSource`, WHICH IS A
 *  DIFFERENT VOCABULARY WEARING THE SAME NAME. `approval.ts` declares
 *  `TriggerSource = 'manual' | 'auto_run' | 'scheduled' | 'server_command'` for approval
 *  TIMEOUT behaviour, while `AuditEntry.trigger_source` is `string | null` and actually
 *  carries `manual` / `chat` / `mcp` / `reactive` / `schedule` / `webhook` / `auto_run` /
 *  `reception` / `event_trigger` / `housekeeping` / `backfill`. Note `schedule` versus
 *  `scheduled`: pinning this map against the declared union would match NOTHING on the
 *  spelling that matters and silently classify every real scheduled run as unknown.
 *  ⇒ the list below is authored from the WRITERS, and `unclassified_runs` on the result
 *  is what makes a future addition visible instead of silent. */
export const AUTOPILOT_TRIGGER_CLASS: Readonly<Record<string, AutopilotClass>> = {
  // Ran with nobody watching — the behaviour the metric rewards.
  schedule: 'unattended',
  auto_run: 'unattended',
  reactive: 'unattended',
  webhook: 'unattended',
  reception: 'unattended',
  // `wire-event-triggers.ts` / `wire-records-outbox.ts` — a record change fired it.
  event_trigger: 'unattended',
  // The owner was there. `mcp` counts as attended: an external agent calling in is a
  // live request being served, not a standing arrangement running itself.
  manual: 'attended',
  chat: 'attended',
  mcp: 'attended',
  // ⛔ EXCLUDED FROM BOTH HALVES, deliberately.
  //  `backfill` is a bulk catch-up loop (D-120 tags it `run_mode: 'backfill'` precisely
  //  so it does not pollute activity feeds) — thousands of rows that describe a
  //  migration, not how the owner works.
  //  `housekeeping` is the SERVER'S OWN maintenance. Counting it as unattended would
  //  let a busy idle cycle inflate the owner's autonomy score for work they never
  //  arranged, which is exactly the § D6 failure — an optimal cheat that is not the
  //  desired behaviour.
  backfill: 'excluded',
  housekeeping: 'excluded',
};

/** The JS reading of {@link AUTOPILOT_TRIGGER_CLASS}.
 *
 *  ⚠ NO PRODUCTION CALLER TODAY — stated rather than implied. The compute path cannot
 *  call it (the classification happens inside SQL, whose IN-lists are GENERATED from
 *  the same map), so its job right now is to be the second reader the drift test drives
 *  the SQL against. Slice 4's dashboard breakdown is its first real caller. */
// ────────────────────────────────────────────────────────────────
// Slice 3 — the activity-side countable sets
// ────────────────────────────────────────────────────────────────

/** THE gateway-op row. D-165 P0 emits exactly one per gateway-routed catalog-form
 *  operation call, on success, execution failure AND gate denial.
 *
 *  🔑 THIS GRAIN IS THE § D5.5 RULING, not an implementation convenience. Counting
 *  `chat_tool_call` instead would make one-op-per-recipe-invocation the unit, taking a
 *  5-op recipe from 5 to 1 — **composing would LOWER your Burst**, pulling directly
 *  against Toolmaker. ⚠ And NOT `connection_api`, which is the TRANSPORT call: one
 *  operation can make several, so it would count the wrapper plus the internals. */
export const GATEWAY_OP_ACTION = 'connection_gateway';

/** Risk tiers that COULD have raised an ask (§ D5.3). */
export const ASKABLE_RISK_TIERS = ['write', 'admin', 'destructive'] as const satisfies
  readonly RiskTier[];
/** Risk tiers that could not. Declared so the ratchet below has both halves. */
export const NON_ASKABLE_RISK_TIERS = ['read'] as const satisfies readonly RiskTier[];

// ⛔⛔ COMPILE-TIME COMPLETENESS RATCHET — a new RiskTier is a TYPE ERROR here until
// somebody sorts it into one half. Mirrors `_RiskTiersComplete` in ingredient.ts, and
// it exists because BOTH silent outcomes are wrong: deriving askable as `!== 'read'`
// would silently absorb a new tier, and a hand-written list would silently exclude it.
// Either way Waved through and Creator would change meaning with no `metric_version`
// bump — the drift the version pin cannot detect. Forcing a decision is the point.
type _AskableRiskComplete =
  Exclude<
    RiskTier,
    (typeof ASKABLE_RISK_TIERS)[number] | (typeof NON_ASKABLE_RISK_TIERS)[number]
  > extends never
    ? true
    : ['a RiskTier is in neither ASKABLE_RISK_TIERS nor NON_ASKABLE_RISK_TIERS'];
const _askableRiskComplete: _AskableRiskComplete = true;
void _askableRiskComplete;

/** Channels § D5.5 counts as MODEL-INITIATED. Excludes cron, reactive ticks, Run-Now
 *  and webhooks — where the chunky long-running work lives.
 *
 *  ⚠ NO CHANNEL OR SESSION PARTITION BEYOND THIS FILTER (amendment 15). Slack, Telegram
 *  and ten webclients driven at once fold into ONE stretch, deliberately: the optimal
 *  cheat is running that much genuinely parallel AI-initiated work, which is the
 *  behaviour Burst wants. */
export const BURST_CHANNELS = ['chat', 'messenger'] as const;

/** § D5.5 — one hour, "almost a lunch break time".
 *  ⚠ At an hour Burst reads as your best DAY rather than your best sitting. That is the
 *  endurance-flavoured end of the dial and it was chosen knowingly. */
export const BURST_IDLE_GAP_MS = 3_600_000;

export const classifyAutopilotTrigger = (source: string | null | undefined): AutopilotClass =>
  source == null ? 'excluded' : (AUTOPILOT_TRIGGER_CLASS[source] ?? 'excluded');

// ────────────────────────────────────────────────────────────────
// The registry
// ────────────────────────────────────────────────────────────────

/** D-250 § D8.1 slice 2 — the three metrics computable from the run ANCHOR alone
 *  (`audit_entries`), needing no new index and no `operation_id` → risk resolution. */
export const ANCHOR_METRIC_IDS = ['autopilot', 'economy', 'throughput'] as const;
export type AnchorMetricId = (typeof ANCHOR_METRIC_IDS)[number];

/** D-250 § D8.1 slice 3 — the metrics read from `audit_activities`' gateway rows.
 *  ⚠ Scoped as needing a new index and an `operation_id` → risk lookup; NEITHER turned
 *  out to be true — see the slice-3 note in § D8.1. */
export const ACTIVITY_METRIC_IDS = ['toolmaker', 'waved_through', 'creator', 'burst'] as const;
export type ActivityMetricId = (typeof ACTIVITY_METRIC_IDS)[number];

export const METRIC_REGISTRY: Readonly<Record<string, MetricDefinition>> = {
  autopilot: {
    metric_id: 'autopilot',
    metric_version: 1,
    logic: [
      'v1: runs whose trigger_source is unattended ÷ runs classified either way, '
        + 'per AUTOPILOT_TRIGGER_CLASS; unclassified and excluded sources count toward neither.',
    ],
    shape: 'share',
    store: 'snapshot',
    direction: 'higher',
    publishable: true,
    label: 'Autopilot',
    description: 'Of the runs Recued could classify, the share that started on their own instead of you starting them.',
  },
  economy: {
    metric_id: 'economy',
    metric_version: 1,
    logic: [
      'v1: (items_total − items_failed) ÷ (total_tokens ÷ 1000), summed over runs having '
        + 'BOTH items_total > 0 AND total_tokens > 0.',
    ],
    shape: 'ratio',
    store: 'snapshot',
    direction: 'higher',
    publishable: true,
    label: 'Economy',
    description: 'Useful items finished for every 1,000 tokens spent.',
  },
  toolmaker: {
    metric_id: 'toolmaker',
    metric_version: 1,
    logic: [
      'v1: gateway ops carrying a recipe_id ÷ all gateway ops, over connection_gateway '
        + 'activity rows; recipe_id read from the row detail, not the activity column.',
    ],
    shape: 'share',
    store: 'snapshot',
    direction: 'higher',
    publishable: true,
    label: 'Toolmaker',
    description: 'The share of AI actions that went through one of your recipes rather than being improvised.',
  },
  waved_through: {
    metric_id: 'waved_through',
    metric_version: 1,
    logic: [
      'v1: gateway ops whose risk_tier is askable ÷ approval_allow + approval_deny '
        + 'activities. Zero answered with askable ops present is UNBOUNDED, not absent.',
    ],
    shape: 'ratio',
    store: 'snapshot',
    direction: 'higher',
    publishable: true,
    label: 'Waved through',
    description: 'Actions that could have asked you, for each decision you actually answered.',
  },
  creator: {
    metric_id: 'creator',
    metric_version: 1,
    logic: ['v1: count of gateway ops whose risk_tier is askable.'],
    shape: 'count',
    store: 'snapshot',
    direction: 'higher',
    // ⛔ § D2 — a count publishes VOLUME, not SKILL. Dashboard only.
    publishable: false,
    label: 'Creator',
    description: 'How many actions were risky enough that they could have asked you.',
  },
  burst: {
    metric_id: 'burst',
    metric_version: 1,
    logic: [
      'v1: most model-initiated gateway ops in one stretch, a stretch ending after '
        + 'BURST_IDLE_GAP_MS of no activity; no channel or session partition.',
    ],
    shape: 'record',
    // ⛔ ARTIFACT, NOT SNAPSHOT — a record ADVANCES from its own prior value. The
    // compute below returns the best stretch IN THE WINDOW; maxing that against the
    // stored record is the artifact store's job (amendment 17).
    store: 'artifact',
    direction: 'higher',
    publishable: true,
    label: 'Burst',
    description: 'The most actions Recued took in one unbroken stretch.',
  },
  throughput: {
    metric_id: 'throughput',
    metric_version: 1,
    logic: [
      'v1: (items_total − items_failed) ÷ (duration_ms ÷ 60000), summed over runs having '
        + 'BOTH items_total > 0 AND duration_ms > 0.',
    ],
    shape: 'ratio',
    store: 'snapshot',
    direction: 'higher',
    publishable: true,
    label: 'Throughput',
    description: 'Useful items finished per minute of run time.',
  },
};

/** BUILD-TIME consistency check — called by the D-250 anchor-metrics suite, and
 *  deliberately NOT at boot.
 *
 *  ⛔ NOT A BOOT CHECK, AND THE DISTINCTION IS THE POINT. Everything it catches is a
 *  DEVELOPER mistake (a bump with no logic line, a publishable count), so failing a
 *  user's server start over it would trade a real outage for a documentation slip.
 *  CI is where this belongs; the test is its only caller and that is correct.
 *
 *  🔑 IT ENFORCES THE ONE RULE THE VERSION COMMENT CANNOT ENFORCE ITSELF: that a bump
 *  came with an explanation. Everything else about versioning is a declaration by
 *  design (amendment 12); this is the sliver that is mechanically checkable. */
export const assertMetricRegistryConsistent = (): void => {
  for (const def of Object.values(METRIC_REGISTRY)) {
    if (def.logic.length !== def.metric_version) {
      throw new Error(
        `metric '${def.metric_id}' is at v${def.metric_version} but carries `
          + `${def.logic.length} logic line(s) — a version bump owes a line saying what moved`,
      );
    }
    if (def.shape === 'count' && def.publishable) {
      // § D2: a count publishes VOLUME, a ratio publishes SKILL. The registry is where
      // that rule is cheapest to enforce.
      throw new Error(`metric '${def.metric_id}' is a count and cannot be publishable (§ D2)`);
    }
  }
};
