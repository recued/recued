import type { RiskTier } from './ingredient.js';
import type { MessengerVendorSlug } from './messenger-vendors.js';
import type { PrefetchStep, RecipeStep } from './steps.js';
import type { RecipeDefinition } from './recipe.js';
import { stripCorePrefix } from './core-pack.js';

/** User's response to a runtime approval prompt. */
export type ApprovalDecision = 'allow_once' | 'allow_session' | 'allow_always' | 'deny';

/** How the recipe execution was triggered. Determines approval timeout behavior. */
export type TriggerSource = 'manual' | 'auto_run' | 'scheduled' | 'server_command';

/** Engine emits this when a write/admin/destructive ingredient needs runtime approval. */
export interface ApprovalRequest {
  request_id: string;
  recipe_id: string;
  step_id: string;
  ingredient_slug: string;
  risk_tier: RiskTier;
  /** Human-readable summary, e.g. "update notes on deal Acme Corp". */
  description: string;
  /** What will be sent to the ingredient (after vault + value resolution). */
  resolved_input: Record<string, unknown>;
  timestamp: string;
  /** How the recipe was triggered. Determines timeout behavior:
   *  - manual: no timeout (user is present, waiting)
   *  - auto_run: 5-min auto-deny (user may not have noticed)
   *  - scheduled: 5-min then queue to PendingQueue */
  trigger_source?: TriggerSource;
}

export interface ApprovalResponse {
  request_id: string;
  decision: ApprovalDecision;
  decided_at: string;
}

/** Per-recipe trust state. Tracks staged trust per risk tier.
 *  Synced across instances by default — counters are cumulative (5 on A + 5 on B = 10).
 *  Set instance_override to true to detach this device from synced trust.
 */
export interface RecipeTrustState {
  recipe_id: string;
  /** Reset prompted on update; user chooses keep or reset. */
  recipe_version: number;
  approval_counts: {
    write: number;
    admin: number;
    // destructive: never tracked — always prompts
  };
  trust_levels: {
    write: TrustLevel;
    admin: TrustLevel;
  };
  /** When 'auto' was earned for each tier (Pro feature only). */
  unlocked_at?: {
    write?: string;
    admin?: string;
  };
  /** Why this state exists. Pure workflow recipes bypass staged counters. */
  trust_basis?: 'staged_approval' | 'pure_workflow';
  /** When true, this device's state is local-only, detached from sync. Default false (synced). */
  instance_override?: boolean;
}

export type TrustLevel = 'prompt' | 'session' | 'auto';

/** Approval thresholds for unlocking 'auto' trust per tier. Pro feature. */
export const TRUST_THRESHOLDS: Record<'write' | 'admin', number> = {
  write: 10,
  admin: 20,
};

export type PureWorkflowStepKind = 'trigger' | 'guard' | 'foreach' | 'notify' | 'ask' | 'operation-invoke';

export const PURE_WORKFLOW_STEP_KINDS: readonly PureWorkflowStepKind[] = [
  'trigger',
  'guard',
  'foreach',
  'notify',
  'ask',
  'operation-invoke',
];

const PURE_WORKFLOW_NOTIFY_INGREDIENTS: ReadonlySet<string> = new Set([
  'notification-send',
  'mail-post',
  'slack-post',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isAiIngredientSlug = (slug: string): boolean => {
  // §5 — a `core-ai-*` kernel alias is an AI ingredient just like its bare slug.
  // Strip the prefix so a recipe using `core-ai-classify` is NOT mis-classified as
  // a pure-workflow `operation-invoke` step (which would wrongly auto-trust it for
  // write/admin — the opposite of how a bare `ai-classify` step is treated).
  const lower = stripCorePrefix(slug.toLowerCase());
  return lower === 'ai'
    || lower.startsWith('ai-')
    || lower.startsWith('llm-')
    || lower.includes('openai');
};

export const classifyPureWorkflowStep = (
  step: RecipeStep | PrefetchStep,
): PureWorkflowStepKind | null => {
  if (!isRecord(step)) return null;
  const record = step as Record<string, unknown>;
  if ('transform' in record) return null;
  if ('guard' in record) return 'guard';
  // Connection-agnostic canonical op-step (D-170 N.18) — `{ op: '<crm_alias>.<verb>' }`
  // with no concrete ingredient. An entity-op (e.g. `deal.search`) is a portable,
  // gated catalog operation, so it counts as a pure-workflow step (`operation-invoke`).
  // Only entity-ops exist today; an open-kind escape-hatch op would be a richer tier.
  // `transform`/`guard` are already handled above, so guarding on the absence of a
  // concrete `ingredient` is enough to isolate the op-step.
  if (typeof record.op === 'string' && record.op.length > 0 && !('ingredient' in record)) {
    return 'operation-invoke';
  }
  if (typeof record.ingredient === 'string' && record.ingredient.length > 0) {
    if (isAiIngredientSlug(record.ingredient)) return null;
    // §5 — a `core-notification-send` / `core-mail-post` / `core-slack-post` kernel
    // alias is the same notify capability as its bare slug. Strip the prefix before
    // the notify-set lookup so a published recipe's core-notify step classifies as
    // `notify` (not `operation-invoke`) exactly like its bare counterpart — the
    // sibling fix to `isAiIngredientSlug` above (the `core-` namespace breaks every
    // bare-slug heuristic; both must `stripCorePrefix`).
    if (PURE_WORKFLOW_NOTIFY_INGREDIENTS.has(stripCorePrefix(record.ingredient))) return 'notify';
    if ('prompt' in record || 'timeout_ms' in record || 'on_timeout' in record) return 'ask';
    if ('foreach' in record) return 'foreach';
    return 'operation-invoke';
  }
  return null;
};

const allPureWorkflowSteps = (steps: readonly unknown[] | undefined): boolean =>
  (steps ?? []).every((step) => classifyPureWorkflowStep(step as RecipeStep | PrefetchStep) !== null);

export const isPureWorkflowRecipe = (
  recipe: Pick<RecipeDefinition, 'steps' | 'prefetch_steps' | 'trigger_steps' | 'event_triggers' | 'trigger'>,
): boolean => {
  if (!isRecord(recipe)) return false;
  if (!allPureWorkflowSteps(recipe.prefetch_steps)) return false;
  if (!allPureWorkflowSteps(recipe.trigger_steps)) return false;
  if (!allPureWorkflowSteps(recipe.steps)) return false;
  return recipe.event_triggers !== undefined
    || recipe.trigger !== undefined
    || recipe.trigger_steps !== undefined
    || (recipe.steps ?? []).length > 0
    || (recipe.prefetch_steps ?? []).length > 0;
};

export const recipeTrustStateForPureWorkflow = (
  recipe: Pick<RecipeDefinition, 'recipe_id' | 'version'>,
  now: () => string = () => new Date().toISOString(),
): RecipeTrustState => {
  const unlockedAt = now();
  return {
    recipe_id: recipe.recipe_id,
    recipe_version: recipe.version,
    approval_counts: { write: 0, admin: 0 },
    trust_levels: { write: 'auto', admin: 'auto' },
    unlocked_at: { write: unlockedAt, admin: unlockedAt },
    trust_basis: 'pure_workflow',
  };
};

/** Session approval — in-memory only, scoped to {recipe_id, risk_tier}. */
export interface SessionApproval {
  recipe_id: string;
  risk_tier: RiskTier;
  granted_at: string;
  last_used_at: string;
  expires_at: string;
}

/** Session timeout limits. */
export const SESSION_LIMITS = {
  max_duration_ms: 8 * 60 * 60 * 1000,  // 8 hours hard cap
  idle_timeout_ms: 2 * 60 * 60 * 1000,  // 2 hours idle
} as const;

/** Per-recipe consent for unattended (scheduled) execution.
 *  A scheduled recipe runs on exactly ONE instance — the one bound by scheduled_instance_id.
 *  Other instances do not run the schedule (manual execution still works on any instance).
 */
export interface BackgroundConsent {
  recipe_id: string;
  recipe_version: number;
  /** The ONE instance hosting scheduled execution. Only this instance runs unattended. */
  scheduled_instance_id: string;
  /** When false, scheduled writes/admin are queued for review instead of auto-running. */
  allow_unattended: boolean;
  granted_at: string;
  // Destructive is NEVER unattended, regardless of this flag.
}

/** Action queued for user review (deferred from scheduled execution). */
export interface PendingAction {
  pending_id: string;
  recipe_id: string;
  step_id: string;
  ingredient_slug: string;
  risk_tier: RiskTier;
  description: string;
  resolved_input: Record<string, unknown>;
  queued_at: string;
  reason: 'no_background_consent' | 'destructive' | 'consent_revoked';
}

// ─────────────────────────────────────────────────────────────────
// D-113 — Multi-surface approval channels + gossip protocol
//
// Pro users configure approval channels (extension, Slack, Telegram,
// email); pending approvals fan out across them, and any action-capable
// surface can resolve. Mechanism is a ciphertext gossip protocol over
// the heartbeat relay, with the cloud Worker acting as a stateless
// fire-and-forget broker for slash commands + email magic-link actions.
//
// Scope boundaries (see docs/d-113-spec.md):
//   - Approvals only (no generalised interaction primitive).
//   - Single-responder (no multi-user team approvals in v1).
//   - One server per pairing (no cross-server consolidation).
//   - Stateless worker (no ACK/claim, no retries).
// ─────────────────────────────────────────────────────────────────

// ── Timing constants ────────────────────────────────────────────

/** Steady heartbeat cadence. Idle instances stay on this. */
export const HEARTBEAT_INTERVAL_STEADY_MS = 5_000;
/** Burst heartbeat cadence for 20s after any approval event. */
export const HEARTBEAT_INTERVAL_BURST_MS = 1_000;
/** How long burst cadence persists after the triggering event. */
export const HEARTBEAT_BURST_DURATION_MS = 20_000;
/** Matched pending+action pairs drop from gossip after this (3× steady). */
export const PAIR_TTL_MS = 15_000;
/** Unmatched items drop after this. Same duration as PAIR_TTL. */
export const ITEM_TTL_MS = 15_000;
/** After this window post-resolution, peers may take over owner
 *  responsibilities (chat update, timeout emission). 2× steady. */
export const OWNER_GRACE_WINDOW_MS = 10_000;
/** Worker → instance dispatch expires after this with no retry. */
export const DISPATCH_EXPIRY_MS = 60_000;
/** Worker's routing-table entry lifetime (rebuilt from heartbeats). */
export const ROUTING_TABLE_ENTRY_TTL_MS = 60_000;
/** Extension UI "recent resolved" window — decoupled from gossip TTL. */
export const RECENT_RESOLVED_WINDOW_EXT_MS = 300_000;
/** Default per-channel TTL for Slack / Telegram. */
export const CHAT_CHANNEL_DEFAULT_TTL_MS = 7_200_000;
/** Default per-channel TTL for email. Sentinel `-1` = full approval
 *  lifetime (email links live until `approval.timeout_at`). */
export const EMAIL_CHANNEL_DEFAULT_TTL_MS = -1;

// ── D-114 constants ─────────────────────────────────────────────

/** Caller-side KV TTL for ext-to-ext `dispatch.poll` metadata.
 *  Matches the legacy `/v1/dispatch` + `/v1/result` window. */
export const DISPATCH_RESULT_TTL_SEC = 300;
/** Matching TTL for the pending-entry side of the ext-to-ext dispatch
 *  poll path. Caller stashes `{caller_user_id, target_instance_id}`
 *  under `cmd:{id}` until `/v1/result` swaps it for `result:{id}`. */
export const DISPATCH_PENDING_TTL_SEC = 300;
/** Telegram reply window — caller keeps reply-target metadata this
 *  long so outbound Telegram follow-ups can land on the right chat. */
export const DISPATCH_TELEGRAM_TTL_SEC = 1_800;
/** Per-instance chat-relay buffer retention — D-115's slack-watcher /
 *  telegram-watcher ingredients pick up buffered messages during
 *  `trigger_steps` evaluation. */
export const CHAT_MESSAGE_RELAY_TTL_MS = 300_000;
// ── Channel config (account.approval.*) ─────────────────────────

/** Per-channel permission. `'read'` = can view pendings but not act;
 *  `'action'` = can submit approve/reject/cancel decisions. */
export type ApprovalPermission = 'read' | 'action';

export interface ApprovalExtensionChannel {
  /** Instance id of the paired extension holding this channel. */
  slug: string;
  display_name?: string;
  permission: ApprovalPermission;
  enabled: boolean;
}

export interface ApprovalSlackChannel {
  /** Identifier for the workspace + channel binding. Post-D-125 P5.2,
   *  the binding lives in the local approvals config IDB store rather
   *  than the retired `account.slack.*` namespace. */
  slug: string;
  permission: ApprovalPermission;
  enabled: boolean;
  /** ms; default `CHAT_CHANNEL_DEFAULT_TTL_MS`. */
  ttl_ms?: number;
}

export interface ApprovalTelegramChannel {
  /** Identifier for the chat binding. Post-D-125 P5.2, the binding
   *  lives in the local approvals config IDB store rather than the
   *  retired `account.telegram.*` namespace. */
  slug: string;
  permission: ApprovalPermission;
  enabled: boolean;
  /** ms; default `CHAT_CHANNEL_DEFAULT_TTL_MS`. */
  ttl_ms?: number;
}

export interface ApprovalEmailChannel {
  slug: string;
  permission: ApprovalPermission;
  enabled: boolean;
  to_address: string;
  verified_at?: number;
  verification_source?: 'manual_click' | 'data_mail_auto';
  /** Populated when verification_source === 'data_mail_auto'. */
  mail_channel_slug?: string;
  /** ms; default `EMAIL_CHANNEL_DEFAULT_TTL_MS` (-1 = full lifetime). */
  ttl_ms?: number;
}

/** Complete channel config for one user. Persisted under
 *  `account.approval` keys in the sync account object. */
export interface ApprovalChannelConfig {
  extension: ApprovalExtensionChannel[];
  slack: ApprovalSlackChannel[];
  telegram: ApprovalTelegramChannel[];
  email: ApprovalEmailChannel[];
}

// ── Gossip records ──────────────────────────────────────────────

/** One posted chat handle — the coordinates we need to edit/delete
 *  the original message once the approval resolves. */
export interface SlackChannelHandle {
  workspace_slug: string;
  channel_id: string;
  message_ts: string;
  posted_at: number;
}

export interface TelegramChannelHandle {
  chat_slug: string;
  chat_id: number;
  message_id: number;
  posted_at: number;
}

/** A pending approval circulated via gossip. Emitted by the initiator,
 *  consumed by every action-capable surface. */
export interface ApprovalPendingRecord {
  approval_id: string;
  initiator_instance: string;
  recipe_id: string;
  step_id: string;
  prompt: string;
  created_at: number;
  timeout_at: number;
  /** Chat-side message coordinates, populated after the Slack /
   *  Telegram adapter posts. Lets any peer edit/delete the message
   *  on resolution (owner-first-with-grace, see data plane). */
  channel_handles?: {
    slack?: SlackChannelHandle[];
    telegram?: TelegramChannelHandle[];
  };
}

/** How an approval ended. `user_action` — a human clicked something.
 *  The `executor_*` kinds are all engine-emitted lifecycle resolutions
 *  (timeout reached, parent recipe cancelled, cascade from dependency,
 *  process killed). */
export type ApprovalResolutionKind =
  | 'user_action'
  | 'executor_timeout'
  | 'executor_cancelled'
  | 'executor_cascade'
  | 'executor_killed';

export interface ApprovalResolutionRecord {
  approval_id: string;
  /** The instance that created this resolution record (the one whose
   *  chat adapter / extension handled the click, or the timeout
   *  emitter). Used in the deterministic tiebreaker. */
  created_by_instance: string;
  kind: ApprovalResolutionKind;
  resolved_at: number;

  /** Populated when kind === 'user_action'. */
  actor?: {
    channel:
      | 'extension'
      | 'slack'
      | 'telegram'
      | 'email'
      | 'slack-slash'
      | 'telegram-slash';
    identifier?: string;
    user_display?: string;
  };
  decision?: 'approve' | 'reject' | 'cancel';
  note?: string;

  /** Populated when kind !== 'user_action'. */
  executor_reason?: string;

  /** Computed locally at match-time by pickEffective + timeout policy.
   *  Not serialised — derived view. */
  effective_decision?: 'approve' | 'reject' | 'expired' | 'cancelled';
  /** Count of other same-approval_id resolution records observed but
   *  not chosen by tiebreaker. Debug field for operator trace. */
  superseded_attempts?: number;

  /** Chat-update coordination flags — written by whichever peer
   *  performed the chat edit + follow-up post so other peers skip.
   *  D-192 seam 10 — one optional flag per declared chat transport, keyed off the
   *  registry, so a new transport coordinates its own updates with no edit. */
  channel_updates_done?: Partial<Record<MessengerVendorSlug, boolean>>;
}

// ── WorkerDispatch (worker → instance) ──────────────────────────
//
// Unified worker work-order shape. D-113 seeded the envelope with
// four approval variants; D-114 extends it with five more kinds
// (run_recipe / cron_recipe / recipe_backfill / reactive_recipe /
// chat_message_relay) that all ride `encrypted_payload`. Every
// cloud→instance work order is now one of these.

export type WorkerDispatchKind =
  | 'approval_list'
  | 'approval_status'
  | 'approval_action'
  | 'approval_channel_verify'
  // ── D-114 — encrypted-payload kinds ──────────────────
  | 'run_recipe'
  | 'cron_recipe'
  | 'recipe_backfill'
  | 'reactive_recipe'
  | 'chat_message_relay'
  | 'admin_command';

export interface ApprovalListPayload {
  /** Intentionally empty — worker asks the instance to respond with
   *  its current pending set via the dispatch callback. */
  _?: never;
}

export interface ApprovalStatusPayload {
  approval_id: string;
}

export interface ApprovalActionPayload {
  approval_id: string;
  decision: 'approve' | 'reject' | 'cancel';
  /** Which worker-brokered surface produced this action. */
  actor_channel: 'email' | 'slack-slash' | 'telegram-slash';
  actor_identifier?: string;
  note?: string;
  /** HMAC-derived nonce; the worker dedups by this against its
   *  bounded cache to collapse double-submits from re-clicks. */
  nonce: string;
}

/** C9: worker → instance — mark an email channel as verified after the
 *  recipient clicked the HMAC-signed verify-callback link. The instance
 *  finds `account.approval.email[slug]`, stamps `verified_at`, and
 *  flushes via the usual dual-transport sync. */
export interface ApprovalChannelVerifyPayload {
  /** Matches `ApprovalEmailChannel.slug`. */
  email_slug: string;
  /** Sanity check — must match the current to_address on the channel
   *  so a stale link can't verify a re-pointed address. */
  to_address: string;
  /** Epoch ms of the click (worker's clock). */
  verified_at: number;
}

export type WorkerDispatchPayload =
  | ApprovalListPayload
  | ApprovalStatusPayload
  | ApprovalActionPayload
  | ApprovalChannelVerifyPayload;

// ── D-114 encrypted-payload plaintexts ──────────────────────────
//
// The five recipe / relay kinds carry their content in
// `encrypted_payload: EncryptedBlob` under K_inst. These interfaces
// describe the plaintext shapes each blob decrypts to. The Worker
// never sees these — only producers + target instances do.

/** `run_recipe` payload — ext-to-ext dispatches, email/telegram/slack
 *  triggers, and any manual remote fire. */
export interface RunRecipePlaintext {
  type: 'run_recipe';
  command_id: string;
  issued_at: number;
  recipe_id?: string;
  /** Inline recipe JSON for ext-to-ext dispatches that don't rely on
   *  a marketplace-installed recipe_id. */
  recipe?: unknown;
  publisher_id?: string;
  config?: Record<string, unknown>;
  context?: Record<string, unknown>;
  /** When true, receiving extension delegates execution to its paired
   *  server over the ext↔server WS rpc (Path B). */
  isServer?: boolean;
  requested_by_slack_user?: string;
  requested_by_telegram_chat?: number;
  trigger_source?:
    | 'manual'
    | 'schedule'
    | 'backfill'
    | 'reactive'
    | 'slack'
    | 'telegram'
    | 'email';
  /** Present only for Smart Backfill catch-ups. Diagnostic metadata
   *  surfaced in audit as "N cycles missed since <t>". `missed_cycles`
   *  is `'unknown'` on the first catch-up after schedule creation
   *  (no prev_run_at sample yet to compute observed cadence). */
  backfill?: { missed_cycles: number | 'unknown'; last_run_at_before: number };
}

/** `cron_recipe` payload — cloud-hosted cron fire. Mechanically the
 *  same as `run_recipe`; distinct kind so audit UIs can filter cron
 *  vs manual fires without cracking the ciphertext. */
export interface CronRecipePlaintext extends Omit<RunRecipePlaintext, 'type' | 'trigger_source'> {
  type: 'cron_recipe';
  schedule_id: string;
  trigger_source: 'schedule' | 'backfill';
}

/** `recipe_backfill` payload — Smart Backfill catch-up fire. Always
 *  carries `backfill` metadata + `trigger_source: 'backfill'`. See
 *  {@link RunRecipePlaintext.backfill} for the `'unknown'` sentinel
 *  semantics. */
export interface RecipeBackfillPlaintext extends Omit<CronRecipePlaintext, 'type' | 'trigger_source' | 'backfill'> {
  type: 'recipe_backfill';
  trigger_source: 'backfill';
  backfill: { missed_cycles: number | 'unknown'; last_run_at_before: number };
}

/** `reactive_recipe` payload — remote reactive tick. Receiving
 *  instance evaluates the recipe's `trigger_steps` phase; silent
 *  skip if any returns `{should_run: false}`, else executes full
 *  recipe. Process_id continuity preserved across ticks. */
export interface ReactiveRecipePlaintext {
  type: 'reactive_recipe';
  command_id: string;
  issued_at: number;
  recipe_id: string;
  publisher_id: string;
  /** Stable across ticks (D-115) — audit rolls up by process_id. */
  process_id: string;
  context?: Record<string, unknown>;
  trigger_source: 'reactive-remote';
}

/** `chat_message_relay` payload — encrypted Slack / Telegram message
 *  fan-out for D-115's slack-watcher + telegram-watcher adapters.
 *  Worker encrypts once per bound instance; per-instance chat-relay
 *  buffer retains for `CHAT_MESSAGE_RELAY_TTL_MS`. */
export interface ChatMessageRelayPlaintext {
  type: 'chat_message_relay';
  /** D-192 seam 10 — a chat transport, so the declared vendor slugs (NOT the
   *  wider channel list: `email` / `ui` / `bridge` never relay a chat message). */
  source: MessengerVendorSlug;
  /** Slack channel id (C…) or Telegram chat id (stringified number). */
  channel_id: string;
  /** Slack ts or Telegram message id. Used for dedup in the buffer. */
  message_id: string;
  /** Slack team id. Absent for Telegram. */
  team_id?: string;
  sender: { id: string; name?: string };
  text: string;
  /** Epoch ms of the originating event (Worker's clock). */
  posted_at: number;
}

/** `admin_command` payload — Slack-issued non-`run_recipe` slash
 *  commands that target the receiving instance's command-handler
 *  switch (list_recipes / list_schedules / recent_audit /
 *  check_budget / health / help / etc.). Most cases today still
 *  return placeholder strings, but they share the unified envelope
 *  so the cloud→instance transport is one shape end-to-end. */
export interface AdminCommandPlaintext {
  type: string;
  command_id: string;
  issued_at: number;
  /** Slack user id that issued the slash command. Surfaces in audit. */
  requested_by_slack_user: string;
  /** When true, the command targets the paired recued-server rather
   *  than the extension itself. Most admin placeholders ignore this
   *  today; preserved here for parity with the legacy payload. */
  isServer?: boolean;
}

/** Union of every plaintext shape that rides `encrypted_payload`. */
export type EncryptedDispatchPlaintext =
  | RunRecipePlaintext
  | CronRecipePlaintext
  | RecipeBackfillPlaintext
  | ReactiveRecipePlaintext
  | ChatMessageRelayPlaintext
  | AdminCommandPlaintext;

/** Where the instance should send the dispatch's response. `slack`
 *  replies via Slack's ephemeral response_url; `telegram` edits a
 *  previously-posted message (message_id) or sends a new one. */
export type DispatchCallback =
  | { kind: 'slack'; response_url: string; ephemeral?: boolean }
  | { kind: 'telegram'; chat_id: number; message_id?: number };

/** Envelope fields shared by every WorkerDispatch variant. Kept
 *  separate so the discriminated-union below doesn't re-list them. */
interface WorkerDispatchBase {
  request_id: string;
  target_instance_id: string;
  callback?: DispatchCallback;
  created_at: number;
  /** now + DISPATCH_EXPIRY_MS at creation. Worker drops at TTL. */
  expires_at: number;
  /** D-114 — AEAD ciphertext under target K_inst for recipe / relay
   *  kinds. Approval kinds omit this and use their cleartext
   *  `payload` as D-113 defined. Exactly one of (`payload`,
   *  `encrypted_payload`) is populated per variant. */
  encrypted_payload?: EncryptedBlob;
}

/** Discriminated on `kind`. Narrowing `d.kind === 'approval_action'`
 *  gives `d.payload: ApprovalActionPayload`; narrowing to one of the
 *  D-114 kinds gives `d.encrypted_payload: EncryptedBlob`. Approval
 *  kinds have `payload`; D-114 kinds have `encrypted_payload`. */
export type WorkerDispatch =
  | (WorkerDispatchBase & { kind: 'approval_list'; payload: ApprovalListPayload })
  | (WorkerDispatchBase & { kind: 'approval_status'; payload: ApprovalStatusPayload })
  | (WorkerDispatchBase & { kind: 'approval_action'; payload: ApprovalActionPayload })
  | (WorkerDispatchBase & { kind: 'approval_channel_verify'; payload: ApprovalChannelVerifyPayload })
  | (WorkerDispatchBase & { kind: 'run_recipe'; encrypted_payload: EncryptedBlob })
  | (WorkerDispatchBase & { kind: 'cron_recipe'; encrypted_payload: EncryptedBlob })
  | (WorkerDispatchBase & { kind: 'recipe_backfill'; encrypted_payload: EncryptedBlob })
  | (WorkerDispatchBase & { kind: 'reactive_recipe'; encrypted_payload: EncryptedBlob })
  | (WorkerDispatchBase & { kind: 'admin_command'; encrypted_payload: EncryptedBlob })
  | (WorkerDispatchBase & { kind: 'chat_message_relay'; encrypted_payload: EncryptedBlob });

// ── Encrypted blob shape ────────────────────────────────────────

/** Base64 AEAD ciphertext + nonce. Each instance encrypts its own
 *  gossip contribution with the account's approval sub-DEK (derived
 *  from the recovery-key-bound KEK, same model as D-100 sync). The
 *  heartbeat worker sees only opaque blobs. */
export interface EncryptedBlob {
  /** Base64-encoded AEAD ciphertext. */
  ciphertext: string;
  /** Base64-encoded per-payload nonce (unique per encryption). */
  iv: string;
  /** Sender instance id, in plaintext for routing. The ciphertext
   *  protects the payload, not the sender identity (which the worker
   *  already knows from the heartbeat source anyway). */
  from: string;
}

// ── Heartbeat payload additions ─────────────────────────────────

/** Outbound contribution from one instance, and inbound aggregate
 *  from the worker. Symmetric shape — the worker's aggregate is
 *  just every online instance's contribution concatenated by
 *  account_id. Ciphertext stays opaque to the worker throughout. */
export interface HeartbeatApprovalsPayload {
  pending: EncryptedBlob[];
  actions: EncryptedBlob[];
}

/** Slack team ids + Telegram chat ids this instance is currently
 *  bound to. Worker uses them to rebuild its ephemeral routing
 *  table (ROUTING_TABLE_ENTRY_TTL_MS) — slash commands arrive at
 *  the cloud, worker looks up team_id → account_id, dispatches to
 *  whichever instance is freshest. */
export interface HeartbeatBindings {
  slack_team_ids?: string[];
  telegram_chat_ids?: number[];
}
