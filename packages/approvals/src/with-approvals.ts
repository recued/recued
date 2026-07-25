import {
  TRUST_THRESHOLDS, SESSION_LIMITS,
} from '@recued/contracts';
import type {
  RiskTier, BackgroundConsent, ApprovalRequest, ApprovalResponse, TriggerSource,
  StepOptions, StepMeta,
  ApprovalPendingRecord, ApprovalResolutionRecord,
} from '@recued/contracts';
import { computeEffectiveDecision } from './gossip/data-plane.js';
import type { ApprovalBus } from './gossip/bus.js';
import type {
  ApprovalProvider, TrustStateStore, SessionStore, PendingQueue, ManifestLookup,
} from './types.js';

type IngredientExecutor = (
  slug: string,
  input: Record<string, unknown>,
  stepOutput?: Record<string, string>,
  stepOptions?: StepOptions,
  stepMeta?: StepMeta,
) => Promise<unknown>;

/** D-113 default approval timeouts applied when the recipe step omits
 *  `timeout_ms`. Interactive sessions are generous — the user is present
 *  and might need time to read + decide; scheduled runs are tighter
 *  because the user won't see the prompt until they open a surface. */
const DEFAULT_INTERACTIVE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_SCHEDULED_TIMEOUT_MS = 5 * 60 * 1000;

export type ExecutionMode = 'interactive' | 'scheduled';

export interface WithApprovalsOptions {
  manifestLookup: ManifestLookup;
  recipe_id: string;
  recipe_version: number;
  execution_mode: ExecutionMode;
  provider: ApprovalProvider;
  trustStore: TrustStateStore;
  sessionStore: SessionStore;
  pendingQueue: PendingQueue;
  /** Pro entitlement gates the "Always allow" auto-trust unlock. */
  isPro: boolean;
  /** Background consent for scheduled execution. */
  backgroundConsent?: BackgroundConsent;
  /** Instance ID for pending action records. */
  instance_id: string;
  /** How the recipe was triggered. Propagated to ApprovalRequest for timeout decisions. */
  trigger_source?: TriggerSource;
  /** Optional callback fired after each approval decision. For audit logging. */
  onApproval?: (slug: string, decision: 'allow_once' | 'allow_session' | 'allow_always' | 'deny', tier: RiskTier) => void;
  /** D-113 gossip bridge. When provided AND `gossip_active` is true,
   *  write/admin/destructive ingredients publish a pending record to the
   *  bus and await the first resolution (instead of synchronously
   *  calling `provider.prompt`). Auto-trust and session approvals still
   *  short-circuit locally — gossip only fires when we'd otherwise
   *  prompt. */
  approvalBus?: ApprovalBus;
  /** Evaluated once at wrap time by the composition root (typically
   *  from `gossipActive({ config, server_paired })`). When false the
   *  bridge is skipped and the legacy `provider.prompt` path runs,
   *  preserving pre-D-113 behaviour for solo users. */
  gossip_active?: boolean;
  /** Clock override for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** Wrap an IngredientExecutor with approval gating. Returns a new executor.
 *  - read ingredients: pass through
 *  - write/admin: gated by trust state, prompts via provider (or bus in D-113)
 *  - destructive: ALWAYS prompts (no auto-trust)
 *  - scheduled mode: defers to pending queue if no consent / destructive
 *
 *  D-113 — when `approvalBus` is supplied AND `gossip_active` is true,
 *  the prompt step routes through the gossip bus instead of
 *  `provider.prompt`. Auto-trust + session short-circuits still apply
 *  before the bus, so the bridge only fires on paths that would
 *  otherwise have prompted. Solo users (gossip_active=false) retain
 *  the legacy provider.prompt flow unchanged.
 */
export const withApprovals = (
  executor: IngredientExecutor,
  options: WithApprovalsOptions,
): IngredientExecutor => async (slug, input, stepOutput, stepOptions, stepMeta) => {
  const manifest = await options.manifestLookup(slug);
  if (!manifest) return executor(slug, input, stepOutput, stepOptions, stepMeta);

  const tier = manifest.risk_tier;

  // Read tier and AI ingredients are not gated by approval
  if (tier === 'read' || manifest.category === 'ai') {
    return executor(slug, input, stepOutput, stepOptions, stepMeta);
  }

  // Scheduled execution path
  if (options.execution_mode === 'scheduled') {
    return handleScheduled(executor, slug, input, stepOutput, stepOptions, stepMeta, tier, options);
  }

  // Interactive execution path
  return handleInteractive(executor, slug, input, stepOutput, stepOptions, stepMeta, tier, options);
};

// ── Scheduled execution ────────────────────────────────────────────

const handleScheduled = async (
  executor: IngredientExecutor,
  slug: string,
  input: Record<string, unknown>,
  stepOutput: Record<string, string> | undefined,
  stepOptions: StepOptions | undefined,
  stepMeta: StepMeta | undefined,
  tier: RiskTier,
  options: WithApprovalsOptions,
): Promise<unknown> => {
  // Destructive NEVER auto-runs in background — route through gossip if
  // active so the user can resolve from any surface, else fall back to
  // the legacy pending queue.
  if (tier === 'destructive') {
    if (options.approvalBus && options.gossip_active) {
      return requestViaBus(executor, slug, input, stepOutput, stepOptions, stepMeta, tier, options);
    }
    await queuePending(slug, input, tier, 'destructive', options);
    return null;
  }

  // Write/admin require background consent. Without consent, defer to
  // the legacy queue — gossip doesn't auto-grant unattended writes.
  const consent = options.backgroundConsent;
  if (!consent?.allow_unattended) {
    await queuePending(slug, input, tier, 'no_background_consent', options);
    return null;
  }

  return executor(slug, input, stepOutput, stepOptions, stepMeta);
};

// ── Interactive execution ──────────────────────────────────────────

const handleInteractive = async (
  executor: IngredientExecutor,
  slug: string,
  input: Record<string, unknown>,
  stepOutput: Record<string, string> | undefined,
  stepOptions: StepOptions | undefined,
  stepMeta: StepMeta | undefined,
  tier: RiskTier,
  options: WithApprovalsOptions,
): Promise<unknown> => {
  // Destructive ALWAYS prompts — no auto-trust, no session shortcut
  if (tier === 'destructive') {
    return promptAndExecute(executor, slug, input, stepOutput, stepOptions, stepMeta, tier, options);
  }

  // Check existing trust level
  const state = await options.trustStore.get(options.recipe_id);
  const level = state?.trust_levels?.[tier as 'write' | 'admin'] ?? 'prompt';

  // Auto trust — execute without prompting
  if (level === 'auto' && options.isPro) {
    return executor(slug, input, stepOutput, stepOptions, stepMeta);
  }

  // Session approval valid — execute
  if (options.sessionStore.isValid(options.recipe_id, tier)) {
    return executor(slug, input, stepOutput, stepOptions, stepMeta);
  }

  // Otherwise prompt
  return promptAndExecute(executor, slug, input, stepOutput, stepOptions, stepMeta, tier, options);
};

// ── Prompt + execute ───────────────────────────────────────────────

const promptAndExecute = async (
  executor: IngredientExecutor,
  slug: string,
  input: Record<string, unknown>,
  stepOutput: Record<string, string> | undefined,
  stepOptions: StepOptions | undefined,
  stepMeta: StepMeta | undefined,
  tier: RiskTier,
  options: WithApprovalsOptions,
): Promise<unknown> => {
  // D-113 — when gossip is active, route through the bus instead of
  // provider.prompt. Keeps every other branch of this function intact;
  // solo users (no bus, or gossip_active=false) retain the legacy flow.
  if (options.approvalBus && options.gossip_active) {
    return requestViaBus(executor, slug, input, stepOutput, stepOptions, stepMeta, tier, options);
  }

  const request: ApprovalRequest = {
    request_id: `${options.recipe_id}::${slug}::${Date.now()}::${Math.random().toString(36).slice(2, 8)}`,
    recipe_id: options.recipe_id,
    step_id: stepMeta?.step_id ?? '',
    ingredient_slug: slug,
    risk_tier: tier,
    description: `${slug} requested by recipe ${options.recipe_id}`,
    resolved_input: input,
    timestamp: new Date().toISOString(),
    trigger_source: options.trigger_source,
  };

  const response = await options.provider.prompt(request);
  return handleResponse(executor, slug, input, stepOutput, stepOptions, stepMeta, tier, response, options);
};

const handleResponse = async (
  executor: IngredientExecutor,
  slug: string,
  input: Record<string, unknown>,
  stepOutput: Record<string, string> | undefined,
  stepOptions: StepOptions | undefined,
  stepMeta: StepMeta | undefined,
  tier: RiskTier,
  response: ApprovalResponse,
  options: WithApprovalsOptions,
): Promise<unknown> => {
  options.onApproval?.(slug, response.decision, tier);

  if (response.decision === 'deny') {
    throw new ApprovalDeniedError(`User denied ${slug}`);
  }

  // Increment counter for write/admin only (destructive is never tracked)
  if (tier === 'write' || tier === 'admin') {
    await options.trustStore.increment(options.recipe_id, options.recipe_version, tier);
  }

  // Apply session approval
  if (response.decision === 'allow_session') {
    const now = Date.now();
    options.sessionStore.add({
      recipe_id: options.recipe_id,
      risk_tier: tier,
      granted_at: new Date(now).toISOString(),
      last_used_at: new Date(now).toISOString(),
      expires_at: new Date(now + SESSION_LIMITS.max_duration_ms).toISOString(),
    });
  }

  // Apply auto trust — only for write/admin, only if Pro, only if threshold met
  if (response.decision === 'allow_always' && (tier === 'write' || tier === 'admin') && options.isPro) {
    const state = await options.trustStore.get(options.recipe_id);
    const count = state?.approval_counts?.[tier] ?? 0;
    if (count >= TRUST_THRESHOLDS[tier]) {
      await options.trustStore.setAuto(options.recipe_id, options.recipe_version, tier);
    }
  }

  return executor(slug, input, stepOutput, stepOptions, stepMeta);
};

// ── D-113 gossip bridge ────────────────────────────────────────────

/** Route an approval through the gossip bus: publish a pending record,
 *  set an owner-side timeout watchdog (safety net in case gossip hasn't
 *  scanned at timeout_at yet — peer takeover already handled by the
 *  data plane's `scanForTimeouts`), wait for the first resolution, and
 *  map its effective decision back to the executor.
 *
 *  Effective decisions:
 *    approve   → run executor + mirror bookkeeping from the legacy path
 *    reject    → throw ApprovalDeniedError
 *    expired   → throw ApprovalTimeoutError (on_timeout='fail' only;
 *                on_timeout='approve'|'reject' maps to those branches
 *                inside computeEffectiveDecision)
 *    cancelled → throw ApprovalCancelledError (executor_*, not user) */
const requestViaBus = async (
  executor: IngredientExecutor,
  slug: string,
  input: Record<string, unknown>,
  stepOutput: Record<string, string> | undefined,
  stepOptions: StepOptions | undefined,
  stepMeta: StepMeta | undefined,
  tier: RiskTier,
  options: WithApprovalsOptions,
): Promise<unknown> => {
  const bus = options.approvalBus!;
  const now = options.now ?? (() => Date.now());
  const createdAt = now();
  const timeoutMs = stepMeta?.timeout_ms
    ?? (options.execution_mode === 'scheduled'
      ? DEFAULT_SCHEDULED_TIMEOUT_MS
      : DEFAULT_INTERACTIVE_TIMEOUT_MS);
  const onTimeout = stepMeta?.on_timeout ?? 'fail';
  const approval_id = `${options.recipe_id}::${stepMeta?.step_id ?? slug}::${createdAt}::${Math.random().toString(36).slice(2, 8)}`;

  const pending: ApprovalPendingRecord = {
    approval_id,
    initiator_instance: options.instance_id,
    recipe_id: options.recipe_id,
    step_id: stepMeta?.step_id ?? '',
    prompt: stepMeta?.prompt ?? `${slug} requested by recipe ${options.recipe_id}`,
    created_at: createdAt,
    timeout_at: createdAt + timeoutMs,
  };

  // Owner-side watchdog — fires `executor_timeout` locally when
  // timeout_at elapses with no resolution. The data plane's peer
  // takeover still fires from any online peer past
  // OWNER_GRACE_WINDOW_MS; this is the redundant first-responder when
  // the initiator itself is still online.
  const waiterPromise = bus.request(pending);
  let watchdog: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    bus.publishResolution(approval_id, {
      approval_id,
      created_by_instance: options.instance_id,
      kind: 'executor_timeout',
      resolved_at: pending.timeout_at,
      executor_reason: 'timeout reached',
    });
  }, timeoutMs);

  let resolution: ApprovalResolutionRecord;
  try {
    resolution = await waiterPromise;
  } finally {
    if (watchdog) { clearTimeout(watchdog); watchdog = undefined; }
  }

  const effective = computeEffectiveDecision(resolution, onTimeout);

  // Mirror the legacy onApproval callback for audit log + UI parity.
  const mapped: 'allow_once' | 'deny' | null =
    effective === 'approve' ? 'allow_once'
      : effective === 'reject' ? 'deny'
      : null;
  if (mapped) options.onApproval?.(slug, mapped, tier);

  if (effective === 'approve') {
    // Only write / admin accumulate toward the auto-trust threshold —
    // destructive never grants auto (same as the legacy path).
    if (tier === 'write' || tier === 'admin') {
      await options.trustStore.increment(options.recipe_id, options.recipe_version, tier);
    }
    return executor(slug, input, stepOutput, stepOptions, stepMeta);
  }
  if (effective === 'reject') {
    const via = resolution.actor?.channel ?? resolution.kind;
    throw new ApprovalDeniedError(`${slug} rejected via ${via}`);
  }
  if (effective === 'expired') {
    throw new ApprovalTimeoutError(
      `${slug} approval timed out after ${timeoutMs}ms (on_timeout=fail)`,
    );
  }
  // 'cancelled' — executor_cancelled / executor_cascade / executor_killed.
  throw new ApprovalCancelledError(
    `${slug} approval cancelled (${resolution.kind}${resolution.executor_reason ? `: ${resolution.executor_reason}` : ''})`,
  );
};

// ── Pending queue helper ───────────────────────────────────────────

const queuePending = async (
  slug: string,
  input: Record<string, unknown>,
  tier: RiskTier,
  reason: 'no_background_consent' | 'destructive' | 'consent_revoked',
  options: WithApprovalsOptions,
): Promise<void> => {
  await options.pendingQueue.add({
    pending_id: `${options.recipe_id}::${slug}::${Date.now()}::${Math.random().toString(36).slice(2, 8)}`,
    recipe_id: options.recipe_id,
    step_id: '',
    ingredient_slug: slug,
    risk_tier: tier,
    description: `${slug} deferred (${reason})`,
    resolved_input: input,
    queued_at: new Date().toISOString(),
    reason,
  });
};

/** Thrown when the user denies an approval prompt. */
export class ApprovalDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalDeniedError';
  }
}

/** D-113 — thrown when a gossip-bridged approval times out with
 *  `on_timeout: 'fail'`. Distinct from ApprovalDeniedError so fail_on
 *  conditions and UI copy can tell the difference between "user
 *  rejected" and "nobody answered in time". */
export class ApprovalTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalTimeoutError';
  }
}

/** D-113 — thrown when a gossip-bridged approval is cancelled by the
 *  executor (recipe cancelled, cascade from a failed dependency, or
 *  engine killed mid-run). Distinct from timeout / deny for the same
 *  audit + UI reasons. */
export class ApprovalCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalCancelledError';
  }
}
