/** Schema-driven scalar server config.
 *
 *  The paired extension's generic schema renderer reads `buildSchema(deps)`
 *  and emits one control per field — the extension has no per-field UI
 *  code for the fields listed here. Rich surfaces (LLM pool editor,
 *  schedules, vault) keep their bespoke components and do NOT appear in
 *  this schema.
 *
 *  Adding a field = append one entry in `@recued/config`'s `RUNTIME_SCHEMA`
 *  and, when its storage is NOT the runtime store (e.g. LLM fields live in
 *  SQLite), add one case in `applyField` + one current-value read in
 *  `buildSchema`. */

import {
  RpcError,
  isChatCatalogDeliveryMode,
  isChatModelSourceId,
  type HandlerSlice,
  type ServerConfigField,
  type ServerConfigValue,
  type ServerRpcRegistry,
  type ServerLlmUsageSource,
} from '@recued/contracts';
import {
  RUNTIME_SCHEMA,
  type RuntimeConfigStore,
  type ScalarSchemaEntry,
} from '@recued/config';
import {
  parseLLMConfig,
  isLLMMessageRole,
  isLlmGatewayCallerSystemPolicy,
  LLMConfigValidationError,
  LLM_MESSAGE_ROLES,
  LLM_GATEWAY_CALLER_SYSTEM_POLICIES,
  probeEmbeddingsSource,
  probeLlmSource,
  probeTranscriptionSource,
  type AdapterRegistry,
  type EmbeddingsAdapterRegistry,
  type TranscriptionAdapterRegistry,
  type LLMSlot,
  type LLMConfig,
  type QuotaTracker,
} from '@recued/llm';
import type { LLMConfigManager, LlmPromptSurfaceKey } from './llm-config.js';
import { transcriptionProbeSample } from './transcription-probe-sample.js';
import { LLM_PROMPT_SURFACE_KEYS } from './llm-config.js';
import {
  alwaysOnPromptText,
  resolveCallerSystemPolicy,
  resolveLlmSystemPrompt,
} from './llm-system-prompt.js';
import type { WsClient } from './ws-server.js';

/** Narrow an untrusted wire value onto the closed surface list. Derived from
 *  the one const, so a third surface cannot be accepted here without existing. */
const isLlmPromptSurfaceKey = (value: unknown): value is LlmPromptSurfaceKey =>
  typeof value === 'string'
  && (LLM_PROMPT_SURFACE_KEYS as readonly string[]).includes(value);

export interface ConfigSchemaDeps {
  /** Surfaces the LLM config knobs (allow_upgrade_default,
   *  coordination strategy, budget) — these live in SQLite for
   *  historical reasons, not in the runtime TOML. */
  llmManager: LLMConfigManager;
  /** Surfaces every non-LLM runtime key (vault quotas, log levels,
   *  scheduler minimums, …). Optional so tests that only exercise the
   *  LLM fields don't need to wire a runtime store. */
  runtimeConfig?: RuntimeConfigStore;
  /** Test connection — the config slice's FIRST execution deps. Everything
   *  else here is parse-and-persist; probing is the one operation that leaves
   *  the process, so the adapter registry and the quota tracker have to reach
   *  this slice. Optional: a db-less / test wiring registers the method and
   *  answers `unavailable` rather than pretending it probed. */
  probe?: {
    adapters: AdapterRegistry;
    quota: QuotaTracker;
    /** Separate registry — embeddings is `embed`, not `complete`. */
    embeddingsAdapters?: EmbeddingsAdapterRegistry;
    /** D-262 § B7 — separate again: transcription is `transcribe`, and a chat
     *  completion sent to a Whisper endpoint reports its 404 as a missing
     *  model. */
    transcriptionAdapters?: TranscriptionAdapterRegistry;
  };
}

/** Fields handled directly by `LLMConfigManager` — SQLite-backed, not
 *  mirrored into the TOML runtime store. */
const LLM_FIELDS = new Set<string>([
  'llm.allow_upgrade_default',
  'llm.free_pool_strategy',
  'llm.budget',
]);

const humanize = (key: string): string =>
  key.split('.').pop()!.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const sectionFromKey = (key: string): string => {
  const top = key.split('.', 1)[0];
  return top.charAt(0).toUpperCase() + top.slice(1);
};

/** Read the current value for an LLM-managed key. */
const readLLMValue = (key: string, llm: LLMConfigManager): ServerConfigValue => {
  switch (key) {
    case 'llm.allow_upgrade_default':
      return llm.getAllowUpgradeDefault();
    case 'llm.free_pool_strategy':
      return llm.getPoolStrategy();
    case 'llm.budget':
      return llm.getBudget();
  }
  throw new Error(`readLLMValue: unknown key '${key}'`);
};

/** Produce the schema snapshot. Values are read fresh on each call so
 *  a `getConfigSchema` RPC following a `setConfigField` reflects the
 *  write without cache invalidation. */
export const buildSchema = (deps: ConfigSchemaDeps): ServerConfigField[] => {
  const fields: ServerConfigField[] = [];
  // Widen the tuple type: the `as const satisfies` declaration keeps
  // each element at its literal-specific shape (some entries lack
  // `min`/`max`/`enum`), which makes generic property access in the
  // loop type-check as `never`. Widening to `ScalarSchemaEntry` lets
  // us treat every optional field uniformly.
  for (const entry of RUNTIME_SCHEMA as readonly ScalarSchemaEntry[]) {
    // R26.2 Delta 2 — internal fields (e.g. `network.apex_mode`) persist via
    // the store but are owned by a dedicated rpc; never surface them to the
    // generic schema renderer.
    if (entry.internal === true) continue;
    const isLLM = LLM_FIELDS.has(entry.key);
    // Non-LLM fields require a runtime store — skip when none wired so
    // legacy tests / minimal compositions still get a usable schema.
    if (!isLLM && !deps.runtimeConfig) continue;

    const value = isLLM
      ? readLLMValue(entry.key, deps.llmManager)
      : (deps.runtimeConfig!.get(entry.key) as ServerConfigValue);

    const field: ServerConfigField = {
      section: entry.section ?? sectionFromKey(entry.key),
      key: entry.key,
      label: entry.label ?? humanize(entry.key),
      type: entry.type,
      value,
    };
    if (entry.description) field.description = entry.description;
    if (entry.type === 'enum' && entry.enum) field.enum = [...entry.enum];
    if (entry.min !== undefined) field.min = entry.min;
    if (entry.max !== undefined) field.max = entry.max;
    if (entry.integer === true) field.integer = true;
    fields.push(field);
  }
  return fields;
};

/** Apply a single field update. Validates the value shape before
 *  dispatching; throws a descriptive Error on bad input so the RPC
 *  surface can report it as `bad_request`. */
export const applyField = (
  key: string,
  value: ServerConfigValue,
  deps: ConfigSchemaDeps,
): void => {
  switch (key) {
    case 'llm.allow_upgrade_default': {
      if (typeof value !== 'boolean') {
        throw new Error(`llm.allow_upgrade_default expects boolean, got ${typeof value}`);
      }
      deps.llmManager.setAllowUpgradeDefault(value);
      return;
    }
    case 'llm.free_pool_strategy': {
      if (value !== 'round_robin' && value !== 'weighted') {
        throw new Error(`llm.free_pool_strategy expects 'round_robin' | 'weighted', got ${JSON.stringify(value)}`);
      }
      deps.llmManager.setPoolStrategy(value);
      return;
    }
    case 'llm.budget': {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`llm.budget expects a non-negative finite number, got ${JSON.stringify(value)}`);
      }
      deps.llmManager.setBudget(value);
      return;
    }
    default: {
      if (!deps.runtimeConfig) {
        throw new Error(`Unknown config key: '${key}'`);
      }
      // R26.2 Delta 2 — internal fields are owned by a dedicated rpc (e.g.
      // `network.apex_mode` → `exposure.set_apex`, which cross-validates).
      // Reject the generic write so the consistency gate can't be bypassed.
      const internalEntry = (RUNTIME_SCHEMA as readonly ScalarSchemaEntry[]).find(
        (e) => e.key === key && e.internal === true,
      );
      if (internalEntry) {
        throw new Error(
          `Config key '${key}' is not editable through setConfigField — use its dedicated rpc.`,
        );
      }
      // RuntimeConfigStore throws ConfigValidationError with a clear
      // message on unknown keys + shape mismatches — its `.message`
      // travels through to the rpc `bad_request` surface unchanged.
      deps.runtimeConfig.set(key, value);
      return;
    }
  }
};

// ────────────────────────────────────────────────────────────────
// D-174 R28 Slice B — api_key redaction for the wire
// ────────────────────────────────────────────────────────────────

/** Strip a slot's `api_key` off the wire, replacing it with a boolean
 *  `has_key`. The browser only needs to know WHETHER a key is set, never
 *  the secret. The blank-preserve merge that used to depend on the client
 *  echoing the key back now lives server-side in `saveSlot`. */
const redactSlot = (slot: LLMSlot): Record<string, unknown> => {
  const { api_key, ...rest } = slot;
  return { ...rest, has_key: typeof api_key === 'string' && api_key.length > 0 };
};

/** Redact every api_key (slots + free-pool entries) before the config
 *  crosses to the browser. `getConfig()` stays honest for in-process
 *  consumers (the matcher / executor); only this wire view is redacted. */
const redactLLMConfig = (config: LLMConfig): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...config };
  if (config.slot_1) out.slot_1 = redactSlot(config.slot_1);
  if (config.slot_2) out.slot_2 = redactSlot(config.slot_2);
  if (config.embeddings_slot) out.embeddings_slot = redactSlot(config.embeddings_slot);
  if (config.transcription_slot) out.transcription_slot = redactSlot(config.transcription_slot);
  if (Array.isArray(config.free_pool)) {
    out.free_pool = config.free_pool.map((entry) => {
      const { api_key, ...rest } = entry as unknown as Record<string, unknown>;
      return { ...rest, has_key: typeof api_key === 'string' && api_key.length > 0 };
    });
  }
  return out;
};

/** Inverse of redaction for the whole-blob `setLLMConfig` path. A slot /
 *  pool entry read back from the redacted `getLLMConfig` carries `has_key`
 *  and no `api_key`; that is a blank-key UPDATE, so inject `api_key: ''` —
 *  it then passes validation and `saveSlot`'s blank-preserve keeps the
 *  stored secret (or drops it on a provider/base_url change). Import
 *  payloads (real keys, no `has_key`) pass through untouched, so the
 *  redacted get / full-secret set pair is no longer a write-back trap. */
const normalizeRedactedConfig = (config: unknown): unknown => {
  if (typeof config !== 'object' || config === null) return config;
  const src = config as Record<string, unknown>;
  const fill = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null) return value;
    const record = value as Record<string, unknown>;
    if (record.api_key === undefined && 'has_key' in record) {
      const { has_key: _drop, ...rest } = record;
      return { ...rest, api_key: '' };
    }
    return value;
  };
  const out: Record<string, unknown> = { ...src };
  if ('slot_1' in src) out.slot_1 = fill(src.slot_1);
  if ('slot_2' in src) out.slot_2 = fill(src.slot_2);
  if ('embeddings_slot' in src) out.embeddings_slot = fill(src.embeddings_slot);
  if ('transcription_slot' in src) out.transcription_slot = fill(src.transcription_slot);
  if (Array.isArray(src.free_pool)) out.free_pool = src.free_pool.map(fill);
  return out;
};

// ────────────────────────────────────────────────────────────────
// Handler slice — composeHandlers factory
// ────────────────────────────────────────────────────────────────

export type ConfigMethods =
  | 'server.getConfigSchema'
  | 'server.setConfigField'
  | 'server.getLLMConfig'
  | 'server.setLLMConfig'
  | 'server.setLLMSlot'
  | 'server.setEmbeddingsSlot'
  | 'server.setTranscriptionSlot'
  | 'server.setTranscriptionLanguage'
  | 'server.setTranscriptionDailyRequests'
  | 'server.getLLMUsage'
  | 'server.upsertFreePoolEntry'
  | 'server.removeFreePoolEntry'
  | 'server.setFreePoolEntryEnabled'
  | 'server.setChatCatalogMode'
  | 'server.getLlmPrompts'
  | 'server.setLlmPrompt'
  | 'server.probeLlmSource';

/** Builds the `server.*` config rpc slice. Factory takes just
 *  `llmManager` (required) + optional `runtimeConfig`; the LLM side is
 *  always wired when this slice is built, the runtime side extends the
 *  schema when present. */
export const makeConfigHandlers = (
  llmManager: LLMConfigManager | undefined,
  runtimeConfig: RuntimeConfigStore | undefined,
  probe?: ConfigSchemaDeps['probe'],
): HandlerSlice<ServerRpcRegistry, ConfigMethods, WsClient> | undefined => {
  if (!llmManager) return undefined;
  const deps: ConfigSchemaDeps = { llmManager, runtimeConfig, ...(probe ? { probe } : {}) };
  // Shared locked-server guard for the LLM write paths — a `setSensitive`
  // write on a wired-but-locked server throws "...locked..."; surface it as
  // the 423 `locked` rpc error rather than a 500. Returns `never` so a
  // `catch` can `return rethrowLocked(...)` and stay type-correct.
  const rethrowLocked = (e: unknown, action: string): never => {
    const msg = e instanceof Error ? e.message : String(e);
    if (/locked/i.test(msg)) {
      throw new RpcError('locked', `Server is locked — unlock to ${action}`, 423);
    }
    throw e;
  };
  return {
    methods: [
      'server.getConfigSchema',
      'server.setConfigField',
      'server.getLLMConfig',
      'server.setLLMConfig',
      'server.setLLMSlot',
      'server.setEmbeddingsSlot',
      'server.setTranscriptionSlot',
      'server.setTranscriptionLanguage',
      'server.setTranscriptionDailyRequests',
      'server.getLLMUsage',
      'server.upsertFreePoolEntry',
      'server.removeFreePoolEntry',
      'server.setFreePoolEntryEnabled',
      'server.setChatCatalogMode',
      'server.getLlmPrompts',
      'server.setLlmPrompt',
      'server.probeLlmSource',
    ],
    handlers: {
      'server.getConfigSchema': async () => {
        try {
          return { schema: buildSchema(deps) };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/locked/i.test(msg)) {
            throw new RpcError('locked', 'Server is locked — unlock to read config', 423);
          }
          throw e;
        }
      },
      'server.setConfigField': async (args) => {
        if (typeof args.key !== 'string') {
          throw new RpcError('bad_request', 'key must be a string', 400);
        }
        try {
          applyField(args.key, args.value, deps);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/locked/i.test(msg)) {
            throw new RpcError('locked', 'Server is locked — unlock to write config', 423);
          }
          if (/Unknown (config|runtime) key|expects |must be /.test(msg)) {
            throw new RpcError('bad_request', msg, 400);
          }
          throw e;
        }
        return { ok: true };
      },
      'server.getLLMConfig': async () => {
        try {
          // Redact every api_key off the wire (D-174 R28 Slice B) — the
          // browser receives `has_key` booleans, never the secret.
          return { config: redactLLMConfig(llmManager.getConfig()) };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/locked/i.test(msg)) {
            throw new RpcError('locked', 'Server is locked — unlock to read LLM config', 423);
          }
          throw e;
        }
      },
      'server.setLLMConfig': async (args) => {
        let cfg;
        try {
          // Accept a redacted get-payload written back (has_key, no api_key)
          // as a blank-key update; import payloads pass through untouched.
          cfg = parseLLMConfig(normalizeRedactedConfig(args.config));
        } catch (e) {
          if (e instanceof LLMConfigValidationError) {
            throw new RpcError('bad_request', e.message, 400);
          }
          throw e;
        }
        try {
          if (cfg.slot_1 !== undefined) llmManager.setSlot1(cfg.slot_1 ?? null);
          if (cfg.slot_2 !== undefined) llmManager.setSlot2(cfg.slot_2 ?? null);
          if (cfg.embeddings_slot !== undefined) llmManager.setEmbeddingsSlot(cfg.embeddings_slot ?? null);
          if (cfg.transcription_slot !== undefined) llmManager.setTranscriptionSlot(cfg.transcription_slot ?? null);
          // ⛔ `in`, not `!== undefined`: absent means auto-detect and clearing
          // is an explicit `null`, so the two have to stay distinguishable.
          if ('transcription_language' in (cfg as Record<string, unknown>)) {
            llmManager.setTranscriptionLanguage(cfg.transcription_language ?? null);
          }
          if ('transcription_daily_requests' in (cfg as Record<string, unknown>)) {
            llmManager.setTranscriptionDailyRequests(cfg.transcription_daily_requests ?? null);
          }
          if (cfg.free_pool !== undefined) llmManager.setPool(cfg.free_pool ?? []);
          if (cfg.free_pool_strategy !== undefined) llmManager.setPoolStrategy(cfg.free_pool_strategy);
          if (cfg.allow_upgrade_default !== undefined) llmManager.setAllowUpgradeDefault(cfg.allow_upgrade_default);
          // Lever-2 per-slot — the whole-blob path also carries the per-source
          // catalog modes (for import / bulk set); `parseLLMConfig` already
          // validated the map. An empty map clears the persisted row.
          if (cfg.catalog_modes !== undefined) llmManager.setCatalogModes(cfg.catalog_modes);
          if ('llm_gateway_default_route' in (cfg as Record<string, unknown>)) {
            llmManager.setLlmGatewayDefaultRoute(cfg.llm_gateway_default_route ?? null);
          }
          if ('llm_gateway_model_alias' in (cfg as Record<string, unknown>)) {
            llmManager.setLlmGatewayModelAlias(cfg.llm_gateway_model_alias ?? null);
          }
        } catch (e) {
          return rethrowLocked(e, 'write LLM config');
        }
        return { ok: true };
      },
      // ── D-174 R28 field-level writes ───────────────────────────────
      // Each edits ONE slot / pool entry so two surfaces editing
      // different slots don't clobber via the whole-blob `setLLMConfig`.
      // Single slots / entries reuse `parseLLMConfig` by wrapping them as
      // a one-field config, so they get the exact same validation.
      'server.setLLMSlot': async (args) => {
        if (args.slot_key !== 'slot_1' && args.slot_key !== 'slot_2') {
          throw new RpcError('bad_request', "slot_key must be 'slot_1' | 'slot_2'", 400);
        }
        const slotKey = args.slot_key;
        // `null` clears the slot; a present object is validated like the
        // whole-config path. We DON'T route `null` through the parser
        // (parseSlot treats null as "clear", but being explicit is clearer).
        let slot: LLMSlot | null = null;
        if (args.slot !== null && args.slot !== undefined) {
          try {
            const parsed = parseLLMConfig({ [slotKey]: args.slot });
            slot = (slotKey === 'slot_1' ? parsed.slot_1 : parsed.slot_2) ?? null;
          } catch (e) {
            if (e instanceof LLMConfigValidationError) {
              throw new RpcError('bad_request', e.message, 400);
            }
            throw e;
          }
        }
        try {
          if (slotKey === 'slot_1') llmManager.setSlot1(slot);
          else llmManager.setSlot2(slot);
        } catch (e) {
          return rethrowLocked(e, 'write LLM config');
        }
        return { ok: true };
      },
      // D-174 R28 Slice C — the dedicated embeddings slot. No slot_key (there
      // is exactly one); otherwise identical to setLLMSlot — validated via
      // parseLLMConfig, blank-key preserve handled in saveSlot.
      'server.setEmbeddingsSlot': async (args) => {
        let slot: LLMSlot | null = null;
        if (args.slot !== null && args.slot !== undefined) {
          try {
            const parsed = parseLLMConfig({ embeddings_slot: args.slot });
            slot = parsed.embeddings_slot ?? null;
          } catch (e) {
            if (e instanceof LLMConfigValidationError) {
              throw new RpcError('bad_request', e.message, 400);
            }
            throw e;
          }
        }
        try {
          llmManager.setEmbeddingsSlot(slot);
        } catch (e) {
          return rethrowLocked(e, 'write LLM config');
        }
        return { ok: true };
      },
      // D-262 § B1 — same shape as the embeddings write above: validate through
      // `parseLLMConfig`, and let `saveSlot` handle the blank-key preserve rule.
      'server.setTranscriptionSlot': async (args) => {
        let slot: LLMSlot | null = null;
        if (args.slot !== null && args.slot !== undefined) {
          try {
            const parsed = parseLLMConfig({ transcription_slot: args.slot });
            slot = parsed.transcription_slot ?? null;
          } catch (e) {
            if (e instanceof LLMConfigValidationError) {
              throw new RpcError('bad_request', e.message, 400);
            }
            throw e;
          }
        }
        try {
          llmManager.setTranscriptionSlot(slot);
        } catch (e) {
          return rethrowLocked(e, 'write LLM config');
        }
        return { ok: true };
      },
      // D-262 § B6 — ⛔ an empty/blank language is CLEARING, not a value: the
      // provider reads an empty string as a pin and renders speech into
      // nothing. Absence is auto-detect and is the default.
      'server.setTranscriptionLanguage': async (args) => {
        const raw = args.language;
        if (raw !== null && typeof raw !== 'string') {
          throw new RpcError('bad_request', 'language must be a string or null', 400);
        }
        try {
          llmManager.setTranscriptionLanguage(
            raw === null || raw.trim().length === 0 ? null : raw.trim(),
          );
        } catch (e) {
          return rethrowLocked(e, 'write LLM config');
        }
        return { ok: true };
      },
      // D-262 § B12.3 — ⛔ zero and negative both mean UNLIMITED here, the same
      // reading `daily_budget_tokens` has. A cap of 0 that meant "block
      // everything" would turn a fat-fingered field into a silently disabled
      // feature, and the owner would have no way to tell it apart from a
      // broken slot.
      'server.setTranscriptionDailyRequests': async (args) => {
        const raw = args.limit;
        if (raw !== null && typeof raw !== 'number') {
          throw new RpcError('bad_request', 'limit must be a number or null', 400);
        }
        if (raw !== null && !Number.isFinite(raw)) {
          throw new RpcError('bad_request', 'limit must be a finite number', 400);
        }
        try {
          llmManager.setTranscriptionDailyRequests(raw === null || raw <= 0 ? null : raw);
        } catch (e) {
          return rethrowLocked(e, 'write LLM config');
        }
        return { ok: true };
      },
      // D-262 follow-on — what each source has spent today, against its cap.
      //
      // ⛔ EVERY BUDGET WAS ENFORCED AND INVISIBLE before this. A pool entry's
      // `daily_cap_tokens`, a slot's `daily_budget_tokens`, the embeddings
      // cutoff and the transcription cap all decided whether a call could
      // proceed, and nothing showed the number they decided on — so an owner
      // could be refused with no way to tell a spent budget from a bad key.
      'server.getLLMUsage': async () => {
        const quota = deps.probe?.quota;
        if (!quota) {
          throw new RpcError(
            'unavailable',
            'Usage tracking is not wired on this server',
            503,
          );
        }
        const config = llmManager.getConfig();
        const sources: ServerLlmUsageSource[] = [];

        const chatSlot = (
          key: 'slot_1' | 'slot_2',
          label: string,
        ): void => {
          const slot = config[key];
          if (!slot) return;
          const used = quota.tokensToday(key);
          const limit = slot.daily_budget_tokens;
          sources.push({
            id: key,
            kind: 'chat_slot',
            label,
            provider: slot.provider,
            model: slot.model,
            tokens_today: used,
            // ⚠ Non-positive is UNLIMITED, matching `slotOverCutoff` — the
            // surface must agree with the enforcement or it teaches the owner
            // something false.
            ...(limit !== undefined && limit > 0
              ? { limit, limit_unit: 'tokens' as const }
              : {}),
            over_limit: limit !== undefined && limit > 0 && used >= limit,
            in_cooldown: quota.isInCooldown(key),
          });
        };
        chatSlot('slot_1', 'Slot 1: fast');
        chatSlot('slot_2', 'Slot 2: quality / thinking');

        if (config.embeddings_slot) {
          const slot = config.embeddings_slot;
          const used = quota.tokensToday('embeddings_slot');
          const limit = slot.daily_budget_tokens;
          sources.push({
            id: 'embeddings_slot',
            kind: 'embeddings_slot',
            label: 'Embeddings slot',
            provider: slot.provider,
            model: slot.model,
            tokens_today: used,
            ...(limit !== undefined && limit > 0
              ? { limit, limit_unit: 'tokens' as const }
              : {}),
            over_limit: limit !== undefined && limit > 0 && used >= limit,
            in_cooldown: quota.isInCooldown('embeddings_slot'),
          });
        }

        if (config.transcription_slot) {
          const slot = config.transcription_slot;
          // ⛔ REQUESTS, not tokens — the unit its cap is counted in, and the
          // only one that is always exact. Bytes and seconds ride along for
          // orientation; seconds is an under-count by construction.
          const used = quota.transcriptionRequestsToday('transcription_slot');
          const limit = config.transcription_daily_requests;
          sources.push({
            id: 'transcription_slot',
            kind: 'transcription_slot',
            label: 'Transcription slot',
            provider: slot.provider,
            model: slot.model,
            transcription_requests_today: used,
            transcription_bytes_today: quota.transcriptionBytesToday('transcription_slot'),
            transcription_seconds_today: quota.transcriptionSecondsToday('transcription_slot'),
            ...(limit !== undefined && limit > 0
              ? { limit, limit_unit: 'requests' as const }
              : {}),
            over_limit: limit !== undefined && limit > 0 && used >= limit,
            in_cooldown: quota.isInCooldown('transcription_slot'),
          });
        }

        for (const entry of config.free_pool ?? []) {
          const used = quota.tokensToday(entry.id);
          const limit = entry.daily_cap_tokens;
          sources.push({
            id: entry.id,
            kind: 'pool_entry',
            label: `Free pool: ${entry.id}`,
            provider: entry.provider,
            model: entry.model,
            tokens_today: used,
            ...(limit !== undefined && limit > 0
              ? { limit, limit_unit: 'tokens' as const }
              : {}),
            over_limit: limit !== undefined && limit > 0 && used >= limit,
            in_cooldown: quota.isInCooldown(entry.id),
          });
        }

        const budget = llmManager.getBudget();
        return {
          // ⛔ `currentDay()`, NOT `snapshot().daily_reset_at`. The snapshot's
          // key is the day the buckets were last WRITTEN on and stays stale
          // until the next write; every counter above is day-aware and reports
          // 0 the moment the UTC day rolls. Labelling today's (correctly
          // empty) numbers with yesterday's date is the exact disagreement
          // this field exists to prevent.
          day: quota.currentDay(),
          sources,
          server_tokens_today: llmManager.getUsage(),
          ...(budget > 0 ? { server_budget_tokens: budget } : {}),
        };
      },
      'server.upsertFreePoolEntry': async (args) => {
        let entry;
        try {
          const parsed = parseLLMConfig({ free_pool: [args.entry] });
          // free_pool was just validated as a one-element array.
          entry = parsed.free_pool![0];
        } catch (e) {
          if (e instanceof LLMConfigValidationError) {
            throw new RpcError('bad_request', e.message, 400);
          }
          throw e;
        }
        try {
          llmManager.upsertPoolEntry(entry);
        } catch (e) {
          return rethrowLocked(e, 'write LLM config');
        }
        return { ok: true };
      },
      'server.removeFreePoolEntry': async (args) => {
        if (typeof args.id !== 'string' || args.id.length === 0) {
          throw new RpcError('bad_request', 'id must be a non-empty string', 400);
        }
        let removed: boolean;
        try {
          removed = llmManager.removePoolEntry(args.id);
        } catch (e) {
          return rethrowLocked(e, 'write LLM config');
        }
        return { ok: true, removed };
      },
      'server.setFreePoolEntryEnabled': async (args) => {
        if (typeof args.id !== 'string' || args.id.length === 0) {
          throw new RpcError('bad_request', 'id must be a non-empty string', 400);
        }
        if (typeof args.enabled !== 'boolean') {
          throw new RpcError('bad_request', 'enabled must be a boolean', 400);
        }
        let found: boolean;
        try {
          found = llmManager.setPoolEntryEnabled(args.id, args.enabled);
        } catch (e) {
          return rethrowLocked(e, 'write LLM config');
        }
        return { ok: true, found };
      },
      // ── Lever-2 per-slot — field-level catalog-mode write ──────────
      // Sets ONE source's chat catalog delivery mode without resending the
      // whole config; `null` clears just that source (falls back to the
      // resolver's smart default / env-global / full). Read-modify-write in
      // the manager keeps concurrent single-source edits from clobbering.
      'server.setChatCatalogMode': async (args) => {
        if (!isChatModelSourceId(args.source_id)) {
          throw new RpcError('bad_request', "source_id must be 'slot_1' | 'slot_2' | 'free_pool'", 400);
        }
        // `null` clears the source; any other value must be a valid mode.
        if (args.mode !== null && !isChatCatalogDeliveryMode(args.mode)) {
          throw new RpcError('bad_request', "mode must be 'full' | 'index' | 'lean-core' | null", 400);
        }
        try {
          llmManager.setCatalogMode(args.source_id, args.mode);
        } catch (e) {
          return rethrowLocked(e, 'write LLM config');
        }
        return { ok: true };
      },

      // Every surface's block 1, its built-in, AND the always-on core + feature
      // text. The always-on text ships so the page can render it read-only
      // beneath the editor: an owner should be able to SEE everything else the
      // model is told. A fence you cannot read is indistinguishable from a
      // fence that is not there.
      'server.getLlmPrompts': async () => {
        let config: LLMConfig;
        try {
          config = llmManager.getConfig();
        } catch (e) {
          return rethrowLocked(e, 'read LLM config');
        }
        return {
          prompts: LLM_PROMPT_SURFACE_KEYS.map((surface) => {
            const effective = resolveLlmSystemPrompt(surface, config);
            const built_in = resolveLlmSystemPrompt(surface, undefined);
            return {
              surface,
              role_instructions: effective.role_instructions,
              default_role_instructions: built_in.role_instructions,
              always_on_text: [...alwaysOnPromptText(surface)],
              composed_preview: effective.prompt,
              role: effective.role,
              default_role: built_in.role,
              is_default: effective.is_default,
              ...(surface === 'llm_gateway'
                ? { caller_system_policy: resolveCallerSystemPolicy(config) }
                : {}),
            };
          }),
        };
      },

      // Test connection — the one operation in this slice that leaves the
      // process. Everything else is parse-and-persist, which is exactly why a
      // mistyped key / model / base_url is accepted silently today and only
      // surfaces hours later as a failed recipe.
      //
      // ⚠ Costs a real request against the owner's credential, so it is
      // button-driven only (never automatic on save) and its usage is metered
      // through the same QuotaTracker as any other call — an unmetered probe
      // behind a button is a hole in the daily budget.
      'server.probeLlmSource': async (args) => {
        const target = args.target;
        if (
          target?.kind !== 'slot' && target?.kind !== 'pool_entry'
        ) {
          throw new RpcError('bad_request', "target.kind must be 'slot' | 'pool_entry'", 400);
        }
        // ⚠ The accepted set and the message it advertises are ONE list in
        // three places (this guard, the rpc type, and the string below). A
        // guard that accepts a key the message does not name is the shape where
        // accept ≠ advertise, so they move together or not at all.
        if (
          target.kind === 'slot'
          && target.slot_key !== 'slot_1'
          && target.slot_key !== 'slot_2'
          && target.slot_key !== 'embeddings_slot'
          && target.slot_key !== 'transcription_slot'
        ) {
          throw new RpcError(
            'bad_request',
            "slot_key must be 'slot_1' | 'slot_2' | 'embeddings_slot' | 'transcription_slot'",
            400,
          );
        }
        if (!deps.probe) {
          throw new RpcError(
            'unavailable',
            'Test connection is not wired on this server',
            503,
          );
        }
        let config: LLMConfig;
        try {
          config = llmManager.getConfig();
        } catch (e) {
          return rethrowLocked(e, 'read LLM config');
        }

        // What is STORED for this target — the credential source of truth, and
        // the thing a blank draft key falls back to.
        let stored: LLMSlot | undefined;
        let sourceId: string;
        if (target.kind === 'pool_entry') {
          const entry = (config.free_pool ?? [])
            .find((e) => e.id === target.entry_id);
          sourceId = `pool:${target.entry_id}`;
          stored = entry === undefined ? undefined : {
            provider: entry.provider,
            model: entry.model,
            api_key: entry.api_key,
            ...(entry.base_url !== undefined ? { base_url: entry.base_url } : {}),
            supports_json: entry.supports_json,
          };
          if (entry === undefined) {
            return {
              ok: false,
              diagnosis: 'rejected' as const,
              detail: `No free-pool entry with id '${target.entry_id}'.`,
              elapsed_ms: 0,
            };
          }
        } else {
          sourceId = target.slot_key;
          stored = target.slot_key === 'slot_1'
            ? config.slot_1
            : target.slot_key === 'slot_2'
              ? config.slot_2
              : target.slot_key === 'embeddings_slot'
                ? config.embeddings_slot
                : config.transcription_slot;
        }

        // A draft probe answers "will this WORK if I save it" — so it must
        // resolve a blank key exactly as `server.setLLMSlot` would, including
        // that rule's guard. The webclient never receives the stored key
        // (redacted to `has_key`), so a blank field means "keep the existing
        // one" — but only while the credential CONTEXT is unchanged. Probing a
        // new endpoint with the previous provider's key would report a result
        // for a configuration that will never exist.
        let slot: LLMSlot | undefined = stored;
        if (args.draft !== null && args.draft !== undefined) {
          const draft = args.draft;
          const baseUrl = draft.base_url && draft.base_url.length > 0
            ? draft.base_url
            : undefined;
          const contextUnchanged = stored !== undefined
            && stored.provider === draft.provider
            && stored.base_url === baseUrl;
          const apiKey = draft.api_key && draft.api_key.length > 0
            ? draft.api_key
            : (contextUnchanged ? stored?.api_key ?? '' : '');
          slot = {
            provider: draft.provider as LLMSlot['provider'],
            model: draft.model,
            api_key: apiKey,
            ...(baseUrl !== undefined ? { base_url: baseUrl } : {}),
            ...(draft.supports_json !== undefined
              ? { supports_json: draft.supports_json }
              : {}),
          };
        }

        if (!slot || slot.model.length === 0) {
          return {
            ok: false,
            diagnosis: 'rejected' as const,
            detail: 'This source has no model configured yet.',
            elapsed_ms: 0,
          };
        }
        if (slot.api_key.length === 0) {
          // Not a provider failure, so it never reaches the probe — but it IS
          // the answer, and it points at the field the owner has to fill.
          return {
            ok: false,
            diagnosis: 'auth' as const,
            detail: 'No API key is stored for this source. Enter one and test again.',
            elapsed_ms: 0,
          };
        }

        const quota = deps.probe.quota;
        const onUsage = (tokens: number): void => {
          quota.recordUsage(sourceId, tokens);
        };
        quota.registerRequest(sourceId);

        // ⚠ The embeddings slot is a DIFFERENT PROVIDER CALL, not this probe
        // pointed at another slot: `embed` vs `complete`, its own registry, and
        // none of the chat capability questions apply. Sending a chat
        // completion to an embeddings model would report its 404 as a missing
        // model — true, and useless.
        if (target.kind === 'slot' && target.slot_key === 'embeddings_slot') {
          if (!deps.probe.embeddingsAdapters) {
            throw new RpcError(
              'unavailable',
              'Embeddings test connection is not wired on this server',
              503,
            );
          }
          return probeEmbeddingsSource({
            adapters: deps.probe.embeddingsAdapters,
            slot,
            onUsage,
          });
        }

        // D-262 § B7 — and the transcription slot is a THIRD provider call
        // (`transcribe`), for the same reason spelled out above.
        if (target.kind === 'slot' && target.slot_key === 'transcription_slot') {
          if (!deps.probe.transcriptionAdapters) {
            throw new RpcError(
              'unavailable',
              'Transcription test connection is not wired on this server',
              503,
            );
          }
          const language = deps.llmManager.getTranscriptionLanguage();
          // ⛔⛔ THE PROBE IS METERED AND CAPPED LIKE ANY OTHER CALL. The rule is
          // already stated at this handler's head — "an unmetered probe behind a
          // button is a hole in the daily budget" — and the chat path keeps it
          // via `onUsage`. This branch reaches the adapter directly, so it kept
          // neither half: two presses at the limit spent two real provider
          // calls, moved no counter, and left the usage surface under-reporting
          // by exactly the calls the owner had just made.
          const cap = deps.llmManager.getTranscriptionDailyRequests();
          if (cap !== null && cap > 0) {
            const usedToday = quota.transcriptionRequestsToday('transcription_slot');
            if (usedToday >= cap) {
              return {
                ok: false,
                diagnosis: 'rejected' as const,
                detail: `Transcription is over its daily limit `
                  + `(${String(usedToday)}/${String(cap)} calls). It resets at 00:00 UTC, `
                  + `or raise the limit above.`,
                elapsed_ms: 0,
              };
            }
          }
          const sample = transcriptionProbeSample();
          const probed = await probeTranscriptionSource({
            adapters: deps.probe.transcriptionAdapters,
            slot,
            // ⚠ The owner's pin rides the probe deliberately: a language they
            // did not mean returns fluent nonsense rather than an error, and
            // this is the one surface that shows them the difference.
            ...(language ? { language } : {}),
            ...(sample ? { sample } : {}),
          });
          // ⚠ Recorded only when the call actually happened and succeeded —
          // matching `transcribe`'s posture, and `no_sample` never left the
          // process at all.
          if (probed.ok && sample) {
            quota.recordTranscriptionUsage('transcription_slot', {
              bytes: sample.bytes.length,
            });
          }
          return probed;
        }

        const adapter = deps.probe.adapters(slot.provider);
        if (!adapter) {
          return {
            ok: false,
            diagnosis: 'rejected' as const,
            detail: `Provider '${slot.provider}' is not available in this runtime.`,
            elapsed_ms: 0,
          };
        }
        return probeLlmSource({ adapter, slot, onUsage });
      },

      // Writes block 1 (+ the transport role, + the gateway's caller policy).
      // `null` is the reset: the manager deletes the row, so the next read falls
      // through to the built-in — there is no "restore" step, because absence is
      // how the default is expressed. Recued's core + feature text are NOT
      // writable here, by construction: they are composed around block 1.
      'server.setLlmPrompt': async (args) => {
        if (!isLlmPromptSurfaceKey(args.surface)) {
          throw new RpcError(
            'bad_request',
            `surface must be ${LLM_PROMPT_SURFACE_KEYS.join(' | ')}`,
            400,
          );
        }
        if (
          args.role_instructions !== null
          && typeof args.role_instructions !== 'string'
        ) {
          throw new RpcError(
            'bad_request',
            'role_instructions must be a string or null',
            400,
          );
        }
        if (args.role !== null && !isLLMMessageRole(args.role)) {
          throw new RpcError(
            'bad_request',
            `role must be ${LLM_MESSAGE_ROLES.join(' | ')} or null`,
            400,
          );
        }
        const policy = args.caller_system_policy;
        if (
          policy !== undefined
          && policy !== null
          && !isLlmGatewayCallerSystemPolicy(policy)
        ) {
          throw new RpcError(
            'bad_request',
            `caller_system_policy must be ${LLM_GATEWAY_CALLER_SYSTEM_POLICIES.join(' | ')} or null`,
            400,
          );
        }
        try {
          llmManager.setRoleInstructions(args.surface, args.role_instructions);
          llmManager.setSystemRole(args.surface, args.role);
          // The caller policy is a GATEWAY concept — a caller's system message
          // only exists on that door. Silently ignored for `chat` rather than
          // rejected, so a client can send one payload shape for both.
          if (args.surface === 'llm_gateway' && policy !== undefined) {
            llmManager.setCallerSystemPolicy(policy);
          }
        } catch (e) {
          return rethrowLocked(e, 'write LLM config');
        }
        return { ok: true };
      },
    },
  };
};
