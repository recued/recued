import type { WebChatTab } from '@recued/contracts';
import type {
  AvailabilitySnapshot,
  AvailabilityStatus,
  LLMConfig,
  LLMSlot,
} from './types.js';
import type { QuotaTracker } from './quota.js';

/** Dependencies the snapshot needs. `tabProbe` remains as an inert compatibility seam after
 *  web-chat retirement. `budgetStatus` is injected by the runtime so this module doesn't have to
 *  know how cutoff percentages are wired. */
export interface BuildAvailabilityDeps {
  config: LLMConfig;
  quota: QuotaTracker;
  tabProbe: () => Promise<Set<WebChatTab>>;
  /** Returns whether a slot has passed its user-configured scheduled-cutoff
   *  threshold (e.g. 80% of daily budget). Null means "no budget / unknown"
   *  which is treated as `over_cutoff: false`. */
  budgetStatus?: (slotKey: 'slot_1' | 'slot_2') => { over_cutoff: boolean } | null;
  /** Retired with web-chat; accepted for older call sites and ignored. */
  webChatSupported?: boolean;
}

const slotStatus = (
  slot: LLMSlot | undefined,
  slotKey: 'slot_1' | 'slot_2',
  quota: { isInCooldown(id: string): boolean },
): AvailabilityStatus => {
  if (!slot) return { available: false, reason: 'no_key' };
  if (!slot.api_key) return { available: false, reason: 'no_key' };
  if (!slot.model) return { available: false, reason: 'no_model' };
  // Post-429 cross-call cooldown (in-memory, expires after Retry-After or
  // 60s default). Slots register under their stable slot key.
  if (quota.isInCooldown(slotKey)) return { available: false, reason: 'quota_exhausted' };
  return { available: true };
};

/** Compute a full snapshot of every configured source's live state. Runs once
 *  per executeLLM call. Pure side-effects: may invoke the tabProbe callback
 *  which can do I/O, but no mutation of config or quota state. */
export const buildAvailability = async (deps: BuildAvailabilityDeps): Promise<AvailabilitySnapshot> => {
  const { config, quota, budgetStatus } = deps;
  const pool = config.free_pool ?? [];

  const free_pool = pool.map((entry) => {
    return { id: entry.id, status: quota.statusFor(entry) };
  });

  const slot_1 = slotStatus(config.slot_1, 'slot_1', quota);
  const slot_2 = slotStatus(config.slot_2, 'slot_2', quota);

  return {
    web_chat: {},
    free_pool,
    slot_1,
    slot_2,
    slot_budget: {
      slot_1: { over_cutoff: slotOverCutoff('slot_1', config, quota, budgetStatus) },
      slot_2: { over_cutoff: slotOverCutoff('slot_2', config, quota, budgetStatus) },
    },
  };
};

/** Per-slot daily-budget cutoff (D-079/D-094 per-slot budgets, reinstated).
 *  An explicitly-injected `budgetStatus` wins (back-compat seam); otherwise
 *  derive from the slot's `daily_budget_tokens` vs the `QuotaTracker`'s
 *  per-slot tokens-today. Absent / non-positive budget = unlimited (never
 *  over). Over budget → `matchLLM` drops the slot from ALL matching until
 *  the next UTC daily reset ("everywhere" cutoff). */
const slotOverCutoff = (
  slotKey: 'slot_1' | 'slot_2',
  config: LLMConfig,
  quota: QuotaTracker,
  budgetStatus?: (slotKey: 'slot_1' | 'slot_2') => { over_cutoff: boolean } | null,
): boolean => {
  const explicit = budgetStatus?.(slotKey);
  if (explicit != null) return explicit.over_cutoff;
  const budget = config[slotKey]?.daily_budget_tokens;
  if (budget === undefined || budget <= 0) return false;
  return quota.tokensToday(slotKey) >= budget;
};
