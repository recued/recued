/** Shared LLM-config availability predicates.
 *
 *  Pure functions over the `server.getLLMConfig` record shape
 *  (`ServerLLMConfig = Record<string, unknown>`). Two surfaces ask
 *  "is an AI source configured?" and MUST agree:
 *
 *    - Settings → AI / Models (`ai-models-page.ts`) — per-layer
 *      "fail loud" notice when the selected model preference has no
 *      matching provider.
 *    - Chat route (`chat/bootstrap-chat-route.ts`) — cold-start
 *      "no AI configured yet, add a key first" affordance that gates
 *      Send before the user hits the executor's loud NO_LLM_SOURCE.
 *
 *  Centralising the predicates keeps the two from drifting when a new
 *  source kind is added. Bridge-only web-chat tabs (D-069 / D-079) are
 *  a separate *runtime* signal (`context.tabs`) not visible in the
 *  static config, so they are intentionally out of scope here.
 */

import { isChatModelHint, isLocalSlotBaseUrl, type ChatModelHint } from '@recued/contracts';

/** The `server.getLLMConfig` payload `config` shape — loosely typed,
 *  matching contracts' `ServerLLMConfig`. */
export type LlmConfigRecord = Record<string, unknown>;

type LlmSlotKey = 'slot_1' | 'slot_2';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string =>
  typeof value === 'string' ? value : '';

const getSlot = (
  config: LlmConfigRecord | null,
  key: LlmSlotKey,
): Record<string, unknown> | null => asRecord(config?.[key]);

const getPoolEntries = (
  config: LlmConfigRecord | null,
): Array<Record<string, unknown>> =>
  (Array.isArray(config?.free_pool) ? (config!.free_pool as unknown[]) : [])
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null);

/** A BYOK slot is configured when it carries provider + model + a key.
 *  The wire redacts the secret to a boolean `has_key` (D-174 R28 Slice B),
 *  so we gate on that, not the (now absent) `api_key`. */
export const hasByokSlot = (config: LlmConfigRecord | null): boolean =>
  (['slot_1', 'slot_2'] as const).some((key) => {
    const slot = getSlot(config, key);
    return (
      slot !== null
      && asString(slot.provider).length > 0
      && asString(slot.model).length > 0
      && slot.has_key === true
    );
  });

/** A local slot (Ollama / vLLM) is configured when its base_url is local —
 *  no api_key required, so this is distinct from `hasByokSlot`. */
export const hasLocalSlot = (config: LlmConfigRecord | null): boolean =>
  (['slot_1', 'slot_2'] as const).some((key) => {
    const slot = getSlot(config, key);
    return (
      slot !== null
      && isLocalSlotBaseUrl(asString(slot.base_url) || undefined)
    );
  });

/** The free pool has at least one entry that is not explicitly disabled. */
export const hasEnabledFreePool = (config: LlmConfigRecord | null): boolean =>
  getPoolEntries(config).some((entry) => entry.enabled !== false);

/** § A.14 slot-aware chat routing — a configured BYOK / local slot, projected
 *  for the chat composer's slot-based model picker. */
export interface LlmSlotDetail {
  key: LlmSlotKey;
  provider: string;
  model: string;
  base_url: string;
  /** The slot's configured capability hint (its routing role). Defaults by
   *  slot key when the stored value is missing / off-list — slot_1 = `'fast'`,
   *  slot_2 = `'thinking'` (matching the Settings AI/Models slot vocabulary). */
  speed: ChatModelHint;
  /** True when `base_url` points at a localhost / RFC1918 endpoint. */
  is_local: boolean;
}

/** Read one BYOK / local slot's details, or `null` when the slot is not
 *  configured. "Configured" = a BYOK slot (provider + model + a key, via the
 *  redacted `has_key`) OR a local slot (a local `base_url`, which needs no
 *  key) — the same gates `hasByokSlot` / `hasLocalSlot` use. */
export const readLlmSlotDetail = (
  config: LlmConfigRecord | null,
  key: LlmSlotKey,
): LlmSlotDetail | null => {
  const slot = getSlot(config, key);
  if (slot === null) return null;
  const provider = asString(slot.provider);
  const model = asString(slot.model);
  const base_url = asString(slot.base_url);
  const is_local = isLocalSlotBaseUrl(base_url || undefined);
  const isByok = provider.length > 0 && model.length > 0 && slot.has_key === true;
  if (!isByok && !is_local) return null;
  const speedRaw = asString(slot.speed);
  const speed: ChatModelHint = isChatModelHint(speedRaw)
    ? speedRaw
    : key === 'slot_1'
      ? 'fast'
      : 'thinking';
  return { key, provider, model, base_url, speed, is_local };
};

/** True when ANY AI source is statically configured — the chat route's
 *  cold-start gate. The matcher's runtime view (quota-exhausted keys,
 *  Bridge web-chat tabs) is broader; the chat executor's loud
 *  NO_LLM_SOURCE failure stays the runtime backstop for what this static
 *  check cannot see. */
export const isAnyAiSourceConfigured = (
  config: LlmConfigRecord | null,
): boolean =>
  hasByokSlot(config) || hasLocalSlot(config) || hasEnabledFreePool(config);
