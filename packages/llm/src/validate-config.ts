/** Structural validation for an incoming `LLMConfig` payload.
 *
 *  Used at trust boundaries — currently just `server.setLLMConfig` on the
 *  pair WS, where a paired extension sends a config the server persists
 *  verbatim. Without this, a malformed payload (`slot_1: "not an object"`,
 *  `free_pool_strategy: 42`) would silently write garbage into SQLite and
 *  surface later as cryptic match failures.
 *
 *  Design notes:
 *  - Optional fields that are `undefined` are omitted from the output (so
 *    callers can distinguish "field absent, don't touch storage" from
 *    "field present with explicit value"). `null` is preserved only for
 *    slots, where it means "clear the slot".
 *  - Validation is shape-only — we do NOT verify that api_keys are real,
 *    URLs resolve, or that `model` names exist at the provider. That's
 *    the runtime's job and it already surfaces clean errors.
 *  - Errors carry a `field` path (e.g. `free_pool[2].speed`) so the
 *    caller can render specific messages.
 */

import type { ChatCatalogDeliveryMode, ChatModelSourceId, ModelHint } from '@recued/contracts';
import { isChatCatalogDeliveryMode, isChatModelSourceId } from '@recued/contracts';
import type {
  CoordinationStrategy, FreePoolApiEntry, FreePoolEntry,
  LLMConfig, LLMProvider, LLMSlot, LlmGatewayDefaultRoute, Modalities,
} from './types.js';
import {
  isLLMMessageRole, isLlmGatewayCallerSystemPolicy,
  LLM_MESSAGE_ROLES, LLM_GATEWAY_CALLER_SYSTEM_POLICIES,
} from './types.js';
import { LLM_PROVIDER_REGISTRY } from './providers/registry.js';

/** Raised when a config value fails shape validation. The `field` path is
 *  suitable for surfacing to the user in an inline error. */
export class LLMConfigValidationError extends Error {
  constructor(public field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'LLMConfigValidationError';
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isString = (v: unknown): v is string => typeof v === 'string';
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);
const isPositiveSafeInteger = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

const MODEL_HINTS: ReadonlySet<ModelHint> = new Set(['fast', 'quality', 'thinking']);
const isModelHint = (v: unknown): v is ModelHint =>
  isString(v) && MODEL_HINTS.has(v as ModelHint);

/** Validator-side provider set derived from `LLM_PROVIDER_REGISTRY` so adding a provider to the
 *  registry automatically widens the trust boundary's allow-list. */
const PROVIDERS: ReadonlySet<LLMProvider> = new Set(
  LLM_PROVIDER_REGISTRY.map((entry) => entry.provider),
);
const PROVIDER_LIST_MSG = Array.from(PROVIDERS).join(' | ');
const isProvider = (v: unknown): v is LLMProvider =>
  isString(v) && PROVIDERS.has(v as LLMProvider);

const STRATEGIES: ReadonlySet<CoordinationStrategy> = new Set([
  'round_robin', 'weighted',
]);
const isStrategy = (v: unknown): v is CoordinationStrategy =>
  isString(v) && STRATEGIES.has(v as CoordinationStrategy);

const LLM_GATEWAY_ROUTES: ReadonlySet<LlmGatewayDefaultRoute> = new Set([
  'pool',
  'slot:slot_1',
  'slot:slot_2',
]);
const isLlmGatewayDefaultRoute = (v: unknown): v is LlmGatewayDefaultRoute =>
  isString(v) && LLM_GATEWAY_ROUTES.has(v as LlmGatewayDefaultRoute);

/** D-172 P5 — validate a `{ image?, audio?, document? }` modality capability
 *  record. Each flag optional + boolean. Preserving this through the config
 *  trust boundary is load-bearing: `matchLLM` reads absent modalities as
 *  text-only, so dropping it here would make every configured model fail a
 *  media turn with `AI_MODALITY_UNSUPPORTED`. */
const parseModalities = (v: unknown, field: string): Modalities => {
  if (!isObject(v)) throw new LLMConfigValidationError(field, 'must be an object');
  const out: Modalities = {};
  for (const k of ['image', 'audio', 'document'] as const) {
    if (v[k] !== undefined) {
      if (!isBoolean(v[k])) throw new LLMConfigValidationError(`${field}.${k}`, 'must be a boolean');
      out[k] = v[k] as boolean;
    }
  }
  return out;
};

/** Validate an LLMSlot or null. Returns the canonicalized value. Throws with
 *  a field path like `slot_1.provider` on failure. */
const parseSlot = (v: unknown, field: string): LLMSlot | null => {
  if (v === null) return null;
  if (!isObject(v)) {
    throw new LLMConfigValidationError(field, 'must be an object or null');
  }
  if (!isProvider(v.provider)) {
    throw new LLMConfigValidationError(`${field}.provider`,
      `must be one of ${PROVIDER_LIST_MSG} (got ${JSON.stringify(v.provider)})`);
  }
  if (!isString(v.model)) {
    throw new LLMConfigValidationError(`${field}.model`, 'must be a string');
  }
  if (!isString(v.api_key)) {
    throw new LLMConfigValidationError(`${field}.api_key`, 'must be a string');
  }
  const out: LLMSlot = { provider: v.provider, model: v.model, api_key: v.api_key };
  if (v.base_url !== undefined) {
    if (!isString(v.base_url)) {
      throw new LLMConfigValidationError(`${field}.base_url`, 'must be a string');
    }
    out.base_url = v.base_url;
  }
  if (v.max_output_tokens !== undefined) {
    if (!isFiniteNumber(v.max_output_tokens) || v.max_output_tokens < 0) {
      throw new LLMConfigValidationError(`${field}.max_output_tokens`, 'must be a non-negative number');
    }
    out.max_output_tokens = v.max_output_tokens;
  }
  if (v.context_window_tokens !== undefined) {
    if (!isPositiveSafeInteger(v.context_window_tokens)) {
      throw new LLMConfigValidationError(
        `${field}.context_window_tokens`,
        'must be a positive integer',
      );
    }
    out.context_window_tokens = v.context_window_tokens;
  }
  if (v.daily_budget_tokens !== undefined) {
    if (!isFiniteNumber(v.daily_budget_tokens) || v.daily_budget_tokens < 0) {
      throw new LLMConfigValidationError(`${field}.daily_budget_tokens`, 'must be a non-negative number');
    }
    out.daily_budget_tokens = v.daily_budget_tokens;
  }
  if (v.speed !== undefined) {
    if (!isModelHint(v.speed)) {
      throw new LLMConfigValidationError(`${field}.speed`, 'must be fast | quality | thinking');
    }
    out.speed = v.speed;
  }
  if (v.supports_json !== undefined) {
    if (!isBoolean(v.supports_json)) {
      throw new LLMConfigValidationError(`${field}.supports_json`, 'must be a boolean');
    }
    out.supports_json = v.supports_json;
  }
  if (v.supports_search !== undefined) {
    if (!isBoolean(v.supports_search)) {
      throw new LLMConfigValidationError(`${field}.supports_search`, 'must be a boolean');
    }
    out.supports_search = v.supports_search;
  }
  if (v.supports_thinking !== undefined) {
    if (!isBoolean(v.supports_thinking)) {
      throw new LLMConfigValidationError(`${field}.supports_thinking`, 'must be a boolean');
    }
    out.supports_thinking = v.supports_thinking;
  }
  if (v.modalities !== undefined) {
    out.modalities = parseModalities(v.modalities, `${field}.modalities`);
  }
  if (v.transcription_model !== undefined) {
    if (!isString(v.transcription_model)) {
      throw new LLMConfigValidationError(`${field}.transcription_model`, 'must be a string');
    }
    out.transcription_model = v.transcription_model;
  }
  return out;
};

const parseApiEntry = (v: Record<string, unknown>, field: string): FreePoolApiEntry => {
  if (!isString(v.id)) throw new LLMConfigValidationError(`${field}.id`, 'must be a string');
  if (!isProvider(v.provider)) {
    throw new LLMConfigValidationError(`${field}.provider`,
      `must be one of ${PROVIDER_LIST_MSG}`);
  }
  if (!isString(v.model)) throw new LLMConfigValidationError(`${field}.model`, 'must be a string');
  if (!isString(v.api_key)) throw new LLMConfigValidationError(`${field}.api_key`, 'must be a string');
  if (!isModelHint(v.speed)) {
    throw new LLMConfigValidationError(`${field}.speed`, 'must be fast | quality | thinking');
  }
  if (!isBoolean(v.supports_json)) {
    throw new LLMConfigValidationError(`${field}.supports_json`, 'must be a boolean');
  }
  if (!isBoolean(v.enabled)) {
    throw new LLMConfigValidationError(`${field}.enabled`, 'must be a boolean');
  }
  const out: FreePoolApiEntry = {
    id: v.id, type: 'api', provider: v.provider, model: v.model, api_key: v.api_key,
    speed: v.speed, supports_json: v.supports_json, enabled: v.enabled,
  };
  if (v.base_url !== undefined) {
    if (!isString(v.base_url)) throw new LLMConfigValidationError(`${field}.base_url`, 'must be a string');
    out.base_url = v.base_url;
  }
  if (v.supports_search !== undefined) {
    if (!isBoolean(v.supports_search)) {
      throw new LLMConfigValidationError(`${field}.supports_search`, 'must be a boolean');
    }
    out.supports_search = v.supports_search;
  }
  if (v.weight !== undefined) {
    if (!isFiniteNumber(v.weight) || v.weight < 0) {
      throw new LLMConfigValidationError(`${field}.weight`, 'must be a non-negative number');
    }
    out.weight = v.weight;
  }
  if (v.daily_cap_tokens !== undefined) {
    if (!isFiniteNumber(v.daily_cap_tokens) || v.daily_cap_tokens < 0) {
      throw new LLMConfigValidationError(`${field}.daily_cap_tokens`, 'must be a non-negative number');
    }
    out.daily_cap_tokens = v.daily_cap_tokens;
  }
  if (v.rpm_cap !== undefined) {
    if (!isFiniteNumber(v.rpm_cap) || v.rpm_cap < 0) {
      throw new LLMConfigValidationError(`${field}.rpm_cap`, 'must be a non-negative number');
    }
    out.rpm_cap = v.rpm_cap;
  }
  if (v.context_window_tokens !== undefined) {
    if (!isPositiveSafeInteger(v.context_window_tokens)) {
      throw new LLMConfigValidationError(
        `${field}.context_window_tokens`,
        'must be a positive integer',
      );
    }
    out.context_window_tokens = v.context_window_tokens;
  }
  if (v.modalities !== undefined) {
    out.modalities = parseModalities(v.modalities, `${field}.modalities`);
  }
  if (v.transcription_model !== undefined) {
    if (!isString(v.transcription_model)) {
      throw new LLMConfigValidationError(`${field}.transcription_model`, 'must be a string');
    }
    out.transcription_model = v.transcription_model;
  }
  return out;
};

const parsePoolEntry = (v: unknown, field: string): FreePoolEntry => {
  if (!isObject(v)) throw new LLMConfigValidationError(field, 'must be an object');
  if (v.type === 'api') return parseApiEntry(v, field);
  throw new LLMConfigValidationError(`${field}.type`, 'must be "api"');
};

/** Lever-2 per-slot — validate the `catalog_modes` map: an object keyed by chat
 *  model source id (`slot_1` | `slot_2` | `free_pool`) with catalog-delivery-mode
 *  values (`full` | `index` | `lean-core`). A bad key or value is REJECTED (not
 *  silently dropped) so a typo surfaces at the trust boundary instead of
 *  persisting a mode the orchestrator would ignore. An empty object is valid (no
 *  sources overridden). Both guards come from `@recued/contracts` — the same
 *  ones the orchestrator resolves against — so the accepted set can't drift. */
const parseCatalogModes = (
  v: unknown,
  field: string,
): Partial<Record<ChatModelSourceId, ChatCatalogDeliveryMode>> => {
  if (!isObject(v)) throw new LLMConfigValidationError(field, 'must be an object');
  const out: Partial<Record<ChatModelSourceId, ChatCatalogDeliveryMode>> = {};
  for (const [key, value] of Object.entries(v)) {
    if (!isChatModelSourceId(key)) {
      throw new LLMConfigValidationError(`${field}.${key}`,
        'key must be slot_1 | slot_2 | free_pool');
    }
    if (!isChatCatalogDeliveryMode(value)) {
      throw new LLMConfigValidationError(`${field}.${key}`,
        `must be full | index | lean-core (got ${JSON.stringify(value)})`);
    }
    out[key] = value;
  }
  return out;
};

/** Validate an unknown value as an LLMConfig. Fields not present in the
 *  input are omitted from the output — callers use the returned object
 *  with "if field !== undefined, write to storage" semantics.
 *
 *  Throws `LLMConfigValidationError` with a specific field path. */
export const parseLLMConfig = (raw: unknown): LLMConfig => {
  if (!isObject(raw)) {
    throw new LLMConfigValidationError('config', 'must be an object');
  }
  const out: LLMConfig = {};

  if (raw.slot_1 !== undefined) {
    const v = parseSlot(raw.slot_1, 'slot_1');
    if (v !== null) out.slot_1 = v;
    else (out as Record<string, unknown>).slot_1 = null;
  }
  if (raw.slot_2 !== undefined) {
    const v = parseSlot(raw.slot_2, 'slot_2');
    if (v !== null) out.slot_2 = v;
    else (out as Record<string, unknown>).slot_2 = null;
  }
  // D-174 R28 Slice C — dedicated embeddings source. Same `parseSlot` shape
  // as slot_1/slot_2 (its `model` field carries the embeddings model string);
  // `null` clears it. Kept out of slot_1/slot_2 so the chat match resolver
  // never sees it — embeddings is a recipe/housekeeping-only source.
  if (raw.embeddings_slot !== undefined) {
    const v = parseSlot(raw.embeddings_slot, 'embeddings_slot');
    if (v !== null) out.embeddings_slot = v;
    else (out as Record<string, unknown>).embeddings_slot = null;
  }
  if (raw.free_pool !== undefined) {
    if (!Array.isArray(raw.free_pool)) {
      throw new LLMConfigValidationError('free_pool', 'must be an array');
    }
    out.free_pool = raw.free_pool.map((e, i) => parsePoolEntry(e, `free_pool[${i}]`));
  }
  if (raw.free_pool_strategy !== undefined) {
    if (!isStrategy(raw.free_pool_strategy)) {
      throw new LLMConfigValidationError('free_pool_strategy',
        'must be round_robin | weighted');
    }
    out.free_pool_strategy = raw.free_pool_strategy;
  }
  if (raw.allow_upgrade_default !== undefined) {
    if (!isBoolean(raw.allow_upgrade_default)) {
      throw new LLMConfigValidationError('allow_upgrade_default', 'must be a boolean');
    }
    out.allow_upgrade_default = raw.allow_upgrade_default;
  }
  if (raw.catalog_modes !== undefined) {
    out.catalog_modes = parseCatalogModes(raw.catalog_modes, 'catalog_modes');
  }
  if (raw.llm_gateway_default_route !== undefined) {
    if (raw.llm_gateway_default_route === null) {
      (out as Record<string, unknown>).llm_gateway_default_route = null;
    } else if (!isLlmGatewayDefaultRoute(raw.llm_gateway_default_route)) {
      throw new LLMConfigValidationError(
        'llm_gateway_default_route',
        'must be pool | slot:slot_1 | slot:slot_2',
      );
    } else {
      out.llm_gateway_default_route = raw.llm_gateway_default_route;
    }
  }
  if (raw.llm_gateway_model_alias !== undefined) {
    if (raw.llm_gateway_model_alias === null) {
      (out as Record<string, unknown>).llm_gateway_model_alias = null;
    } else if (!isString(raw.llm_gateway_model_alias)) {
      throw new LLMConfigValidationError('llm_gateway_model_alias', 'must be a string');
    } else {
      out.llm_gateway_model_alias = raw.llm_gateway_model_alias;
    }
  }
  // Owner-authored ROLE + INSTRUCTIONS (block 1) + the wire role, per surface.
  // `null` is an explicit clear (the reset-to-default), NOT a value — same
  // shape as the two gateway fields above. No content validation beyond "is a
  // string": block 1 is the owner's to write, and a substrate that silently
  // rewrote it would be lying about what it sends to the model. It needs no
  // guarding, because it cannot reach a Recued feature by construction — the
  // core + feature blocks are composed around it, not merged into it.
  for (const field of [
    'chat_role_instructions',
    'llm_gateway_role_instructions',
  ] as const) {
    if (raw[field] === undefined) continue;
    if (raw[field] === null) {
      (out as Record<string, unknown>)[field] = null;
    } else if (!isString(raw[field])) {
      throw new LLMConfigValidationError(field, 'must be a string');
    } else {
      out[field] = raw[field];
    }
  }
  for (const field of ['chat_system_role', 'llm_gateway_system_role'] as const) {
    if (raw[field] === undefined) continue;
    if (raw[field] === null) {
      (out as Record<string, unknown>)[field] = null;
    } else if (!isLLMMessageRole(raw[field])) {
      throw new LLMConfigValidationError(
        field,
        `must be ${LLM_MESSAGE_ROLES.join(' | ')}`,
      );
    } else {
      out[field] = raw[field];
    }
  }
  if (raw.llm_gateway_caller_system_policy !== undefined) {
    if (raw.llm_gateway_caller_system_policy === null) {
      (out as Record<string, unknown>).llm_gateway_caller_system_policy = null;
    } else if (
      !isLlmGatewayCallerSystemPolicy(raw.llm_gateway_caller_system_policy)
    ) {
      throw new LLMConfigValidationError(
        'llm_gateway_caller_system_policy',
        `must be ${LLM_GATEWAY_CALLER_SYSTEM_POLICIES.join(' | ')}`,
      );
    } else {
      out.llm_gateway_caller_system_policy = raw.llm_gateway_caller_system_policy;
    }
  }
  return out;
};
