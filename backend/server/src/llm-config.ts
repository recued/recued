/** Server-side LLM configuration — persisted in SQLite.
 *
 *  Manages two slots (fast + quality), daily token budget, and usage
 *  tracking. Same model as the extension's LLM settings but stored
 *  in the server's SQLite database instead of chrome.storage.
 *
 *  Priority: SQLite (persisted) → env vars (override) → none.
 */

import type Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type {
  FreePoolEntry, LLMConfig, LLMSlot, CoordinationStrategy, LlmGatewayDefaultRoute,
  LLMMessageRole, LlmGatewayCallerSystemPolicy, EndpointCapabilityNote,
} from '@recued/llm';
import {
  isLLMMessageRole, isLlmGatewayCallerSystemPolicy,
  LLM_MESSAGE_ROLES, LLM_GATEWAY_CALLER_SYSTEM_POLICIES,
} from '@recued/llm';
import {
  checkBudgetStatus, DEFAULT_BUDGET_THRESHOLDS,
  isChatCatalogDeliveryMode, isChatModelSourceId,
  type BudgetThresholds, type BudgetStatus,
  type ChatCatalogDeliveryMode, type ChatModelSourceId,
} from '@recued/contracts';

/** THE list of prompt-bearing surfaces. It keys BOTH the SQLite rows
 *  (`chat.role_instructions`, `llm_gateway.system_role`, …) AND the `LLMConfig`
 *  fields (`chat_role_instructions`, …) — a template literal over this array
 *  builds each of them, so the storage keys and the config fields cannot drift
 *  apart, and adding a third surface is a one-line change here.
 *
 *  `llm-system-prompt.ts` (the resolver + defaults) imports THIS array rather
 *  than restating it: a restated subset would typecheck happily while silently
 *  dropping a surface from the reset path. It lives in this file, not there,
 *  because that module reaches into `chat-turn-executor.ts` for the chat
 *  prompt constant while this one is imported by the composition root long
 *  before any chat wiring exists. */
export const LLM_PROMPT_SURFACE_KEYS = ['chat', 'llm_gateway'] as const;

export type LlmPromptSurfaceKey = (typeof LLM_PROMPT_SURFACE_KEYS)[number];

// ────────────────────────────────────────────────────────────────
// At-rest encryption for sensitive fields (api_keys + pool blob)
// ────────────────────────────────────────────────────────────────

/** Marker prefix identifying encrypted values in the llm_config value
 *  column. Legacy (pre-encryption) rows lack the prefix and are returned
 *  as-is — new writes always produce prefixed ciphertext when a key is
 *  available. Versioned in case we ever need to rotate the scheme. */
const ENC_PREFIX = 'enc:v1:';

/** Wrap a plaintext string with AES-256-GCM using the provided key. AAD is
 *  typed to each storage row (e.g. `llm_config:slot_1.api_key`) so moved
 *  ciphertext can't decrypt in the wrong place. */
const encryptSync = (plaintext: string, key: Uint8Array, aad: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), iv);
  cipher.setAAD(Buffer.from(aad, 'utf-8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
};

/** Reverse of encryptSync. Throws if the payload is malformed or the tag
 *  mismatches (wrong key, wrong AAD, corruption). */
const decryptSync = (payload: string, key: Uint8Array, aad: string): string => {
  const b = Buffer.from(payload.slice(ENC_PREFIX.length), 'base64');
  if (b.length < 28) throw new Error('llm-config: encrypted payload too short');
  const iv = b.subarray(0, 12);
  const tag = b.subarray(12, 28);
  const ct = b.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), iv);
  decipher.setAuthTag(tag);
  decipher.setAAD(Buffer.from(aad, 'utf-8'));
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8');
};

const isEncrypted = (v: string): boolean => v.startsWith(ENC_PREFIX);

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface LLMConfigManager {
  /** Get the current LLM config (both slots + free_pool + defaults). */
  getConfig(): LLMConfig;
  /** Set slot_1 (fast). Pass null to clear. */
  setSlot1(slot: LLMSlot | null): void;
  /** Set slot_2 (quality/thinking). Pass null to clear. */
  setSlot2(slot: LLMSlot | null): void;
  /** D-174 R28 Slice C — set the dedicated embeddings slot. Pass null to
   *  clear. Its `model` field carries the embeddings model string. */
  setEmbeddingsSlot(slot: LLMSlot | null): void;
  // ── Free LLM pool ──
  /** Replace the entire free pool (entries are stored as a JSON blob). */
  setPool(entries: FreePoolEntry[]): void;
  /** Get the current free pool. Empty array when unset. */
  getPool(): FreePoolEntry[];
  /** D-174 R28 — add or replace ONE pool entry (matched by `id`) via a
   *  synchronous read-modify-write over the blob, so a single-entry edit
   *  never clobbers the other entries (vs `setPool` which replaces all). */
  upsertPoolEntry(entry: FreePoolEntry): void;
  /** D-174 R28 — remove ONE pool entry by `id`. Returns whether an entry
   *  matched (false = no-op). */
  removePoolEntry(id: string): boolean;
  /** D-174 R28 — enable/disable ONE pool entry by `id` without resending
   *  it. Returns whether an entry matched (false = no-op). */
  setPoolEntryEnabled(id: string, enabled: boolean): boolean;
  /** Coordination strategy for the free pool. */
  setPoolStrategy(s: CoordinationStrategy): void;
  getPoolStrategy(): CoordinationStrategy;
  /** Global user-level fallback for allow_upgrade. */
  setAllowUpgradeDefault(v: boolean): void;
  getAllowUpgradeDefault(): boolean;
  // ── Lever-2 per-slot — chat catalog delivery mode per LLM source ──
  /** Get the persisted per-source chat catalog modes. Empty object when unset;
   *  defensively filtered to known source→mode pairs (a hand-edited SQLite row
   *  can't surface a bad key/mode the orchestrator would choke on). */
  getCatalogModes(): Partial<Record<ChatModelSourceId, ChatCatalogDeliveryMode>>;
  /** Replace the whole per-source catalog-mode map. An empty map clears the
   *  persisted row (so `getConfig()` omits the field). */
  setCatalogModes(modes: Partial<Record<ChatModelSourceId, ChatCatalogDeliveryMode>>): void;
  /** Set ONE source's catalog mode (`null` clears just that source), via a
   *  read-modify-write so a single-source edit never clobbers the others.
   *  Mirrors `upsertPoolEntry`. */
  setCatalogMode(source: ChatModelSourceId, mode: ChatCatalogDeliveryMode | null): void;
  /** D-196 S2c — OpenAI-compatible gateway route. Null clears and makes the
   *  gateway fail closed before any model call. */
  setLlmGatewayDefaultRoute(route: LlmGatewayDefaultRoute | null): void;
  getLlmGatewayDefaultRoute(): LlmGatewayDefaultRoute | undefined;
  /** D-196 S2c — public alias returned by `/v1/models`; null/blank clears. */
  setLlmGatewayModelAlias(alias: string | null): void;
  getLlmGatewayModelAlias(): string | undefined;
  /** The owner's ROLE + INSTRUCTIONS for one surface — block 1 of the system
   *  prompt, and the only editable block. `null`/blank DELETES the row, which
   *  is the reset-to-default: the next read falls through to the built-in
   *  byte-for-byte. It can never reach a Recued feature — the core + feature
   *  blocks are composed AROUND it (`llm-system-prompt.ts`), not merged into it. */
  setRoleInstructions(surface: LlmPromptSurfaceKey, text: string | null): void;
  getRoleInstructions(surface: LlmPromptSurfaceKey): string | undefined;
  /** Wire role the surface's system prompt is delivered under. `null` clears
   *  back to `'system'`. A TRANSPORT knob (some OpenAI-compatible endpoints
   *  reject a `system` role) — unrelated to the role the owner writes above. */
  setSystemRole(surface: LlmPromptSurfaceKey, role: LLMMessageRole | null): void;
  getSystemRole(surface: LlmPromptSurfaceKey): LLMMessageRole | undefined;
  /** D-208 follow-on — record a DETECTED endpoint capability on the source it
   *  belongs to (`slot.system_role_ok` / `native_json_ok`, or the matching
   *  free-pool entry).
   *
   *  ⛔ NOT a side blob keyed by a content fingerprint, which is what this was
   *  first built as. The fingerprint existed to auto-invalidate when
   *  provider/base_url/model change — but a SOURCE EDIT is that moment, and the
   *  save path already runs then, so the whole content-addressing layer was
   *  buying something the write path already knew. Storing on the source also
   *  means a deleted source takes its observations with it: no orphans, no
   *  prune, nothing to resurrect.
   *
   *  ⛔ And still not `supports_json`: that field is a MATCH input, so a
   *  detected value there would make a source unroutable rather than
   *  degraded. */
  setSourceCapability(
    source:
      | { kind: 'slot'; slot_key: 'slot_1' | 'slot_2' | 'embeddings_slot' }
      | { kind: 'pool'; entry_id: string },
    patch: { system_role_ok?: boolean; native_json_ok?: boolean },
  ): void;
  /** What the gateway does with a CALLER's OpenAI `system` message. `null`
   *  clears back to `'context'` (the pre-existing behaviour). */
  setCallerSystemPolicy(policy: LlmGatewayCallerSystemPolicy | null): void;
  getCallerSystemPolicy(): LlmGatewayCallerSystemPolicy | undefined;
  // ── Per-entry pool usage ──
  /** Record tokens consumed by a pool entry today. Returns the new running total. */
  addPoolUsage(entryId: string, tokens: number): number;
  /** Get today's tokens consumed for a pool entry. */
  getPoolUsage(entryId: string): number;
  /** Whether a pool entry has passed its daily_cap_tokens (caller supplies the cap). */
  isPoolEntryOverCap(entryId: string, cap: number | undefined): boolean;
  // ── Budget (legacy single-pair slot) ──
  /** Get daily token budget (0 = unlimited). */
  getBudget(): number;
  /** Set daily token budget. */
  setBudget(tokens: number): void;
  /** Get today's token usage. */
  getUsage(): number;
  /** Add tokens to today's usage. Returns new total. */
  addUsage(tokens: number): number;
  /** Check budget status against thresholds. */
  getStatus(expectedTokens?: number): { status: BudgetStatus; percent: number };
  /** Check if hard limit exceeded (blocks all AI). */
  isOverBudget(expectedTokens?: number): boolean;
  /** Check if schedule cutoff reached (blocks scheduled runs). */
  isScheduleCutoff(): boolean;
  /** Get/set custom thresholds. */
  getThresholds(): BudgetThresholds;
  setThresholds(t: Partial<BudgetThresholds>): void;
  /** Reset daily usage (called on date change; prunes stale usage. and pool_usage. rows). */
  resetUsage(): void;
}

// ────────────────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────────────────

const today = (): string => new Date().toISOString().slice(0, 10);

const isLlmGatewayDefaultRoute = (value: unknown): value is LlmGatewayDefaultRoute =>
  value === 'pool' || value === 'slot:slot_1' || value === 'slot:slot_2';

export interface LLMConfigManagerOptions {
  /** Environment-variable fallback for slot_1/slot_2. Overrides SQLite. */
  envConfig?: LLMConfig;
  /** Returns the sub-DEK used to encrypt sensitive fields (api_keys on
   *  slots + the whole pool blob which contains api_keys). Null means
   *  "locked or encryption disabled":
   *    - When null AND a value is already ciphertext on disk: reads throw
   *      (locked server can't serve keys).
   *    - When null AND a value is plaintext on disk: reads pass through
   *      unchanged (legacy data or dev setup without encryption wired).
   *    - When null on writes: falls back to plaintext (legacy behavior).
   *  Pass `keys.keyProvider('server-data')` here to align with the other
   *  storage layers (sqlite-cache-store) that use the same sub-DEK. */
  getEncryptionKey?: () => Uint8Array | null;
}

export const createLLMConfigManager = (
  db: Database.Database,
  envConfigOrOptions?: LLMConfig | LLMConfigManagerOptions,
): LLMConfigManager => {
  // Overload: old callers pass just envConfig. New callers pass an options
  // bag. Detect by the presence of `envConfig` or `getEncryptionKey`.
  const opts: LLMConfigManagerOptions = envConfigOrOptions && (
    'envConfig' in envConfigOrOptions || 'getEncryptionKey' in envConfigOrOptions
  )
    ? envConfigOrOptions as LLMConfigManagerOptions
    : { envConfig: envConfigOrOptions as LLMConfig | undefined };
  const envConfig = opts.envConfig;
  const getKey = opts.getEncryptionKey;
  // Ensure table
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const get = (key: string): string | undefined => {
    const row = db.prepare('SELECT value FROM llm_config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  };

  /** Read a value that may be encrypted at rest. When the raw value is
   *  prefixed with ENC_PREFIX, decrypt with the current sub-DEK. When no
   *  key is available and the value IS encrypted, throw — the caller is
   *  trying to serve secrets from a locked server. Legacy plaintext rows
   *  (no prefix) pass through regardless of key availability so existing
   *  setups keep working. */
  const getSensitive = (key: string): string | undefined => {
    const raw = get(key);
    if (raw === undefined) return undefined;
    if (!isEncrypted(raw)) return raw;
    const dek = getKey?.();
    if (!dek) {
      throw new Error(
        `llm-config: cannot decrypt '${key}' — server is locked (no DEK available). `
        + 'Unlock the server or clear the value.',
      );
    }
    return decryptSync(raw, dek, `llm_config:${key}`);
  };

  const set = (key: string, value: string): void => {
    db.prepare('INSERT OR REPLACE INTO llm_config (key, value) VALUES (?, ?)').run(key, value);
  };

  /** Write a sensitive value — wrapped with AES-256-GCM when a DEK is
   *  available.
   *
   *  Three cases, distinguished carefully so we never write a fresh
   *  secret as plaintext on a runtime that's *supposed* to encrypt:
   *
   *    1. No `getEncryptionKey` wired at all (dev / legacy setup) →
   *       plaintext write. Caller has opted out of encryption entirely.
   *    2. `getEncryptionKey` wired, returns a key (unlocked) → encrypted.
   *    3. `getEncryptionKey` wired, returns null (locked) → THROW.
   *       Writing a fresh api_key in plaintext to storage that's
   *       otherwise encrypted would be a bait-and-switch: the user
   *       configured encryption, locked the server, and a paired client
   *       then pushed new keys. Fail the write loudly instead. */
  const setSensitive = (key: string, value: string): void => {
    if (!getKey) {
      // Case 1: no encryption wired. Matches the legacy single-arg
      // `createLLMConfigManager(db, envConfig)` signature for dev setups.
      set(key, value);
      return;
    }
    const dek = getKey();
    if (!dek) {
      // Case 3: encryption wired but server locked.
      throw new Error(
        `llm-config: cannot write '${key}' — server is locked (no DEK available). `
        + 'Unlock the server before provisioning LLM credentials.',
      );
    }
    // Case 2: encrypted write.
    set(key, encryptSync(value, dek, `llm_config:${key}`));
  };

  const del = (key: string): void => {
    db.prepare('DELETE FROM llm_config WHERE key = ?').run(key);
  };

  const loadSlot = (prefix: string): LLMSlot | undefined => {
    const provider = get(`${prefix}.provider`);
    const model = get(`${prefix}.model`);
    const apiKey = getSensitive(`${prefix}.api_key`);
    if (!provider || !model || !apiKey) return undefined;
    const slot: LLMSlot = {
      provider: provider as LLMSlot['provider'],
      model,
      api_key: apiKey,
      base_url: get(`${prefix}.base_url`),
    };
    const maxOutputTokens = get(`${prefix}.max_output_tokens`);
    if (maxOutputTokens !== undefined) {
      const parsed = Number(maxOutputTokens);
      if (Number.isFinite(parsed) && parsed >= 0) slot.max_output_tokens = parsed;
    }
    const contextWindowTokens = get(`${prefix}.context_window_tokens`);
    if (contextWindowTokens !== undefined) {
      const parsed = Number(contextWindowTokens);
      if (Number.isSafeInteger(parsed) && parsed > 0) slot.context_window_tokens = parsed;
    }
    const dailyBudgetTokens = get(`${prefix}.daily_budget_tokens`);
    if (dailyBudgetTokens !== undefined) {
      const parsed = Number(dailyBudgetTokens);
      if (Number.isFinite(parsed) && parsed >= 0) slot.daily_budget_tokens = parsed;
    }
    // DETECTED capabilities. Only a definite `false` is ever stored — absent
    // means "not yet known", which reads as yes.
    if (get(`${prefix}.system_role_ok`) === '0') slot.system_role_ok = false;
    if (get(`${prefix}.native_json_ok`) === '0') slot.native_json_ok = false;
    const speed = get(`${prefix}.speed`);
    if (speed === 'fast' || speed === 'quality' || speed === 'thinking') slot.speed = speed;
    const sJson = get(`${prefix}.supports_json`);
    if (sJson !== undefined) slot.supports_json = sJson === '1';
    const sSearch = get(`${prefix}.supports_search`);
    if (sSearch !== undefined) slot.supports_search = sSearch === '1';
    // D-172 P5 — round-trip the modality + transcription declarations so a
    // BYOK slot configured via the CLI can satisfy a media turn (without
    // these, `matchLLM` reads the slot as text-only).
    const transcriptionModel = get(`${prefix}.transcription_model`);
    if (transcriptionModel !== undefined) slot.transcription_model = transcriptionModel;
    const modalitiesRaw = get(`${prefix}.modalities`);
    if (modalitiesRaw !== undefined) {
      try {
        slot.modalities = JSON.parse(modalitiesRaw) as LLMSlot['modalities'];
      } catch {
        /* malformed persisted modalities — treat as text-only */
      }
    }
    return slot;
  };

  const saveSlot = (prefix: string, slot: LLMSlot | null): void => {
    const keys = [
      'provider',
      'model',
      'api_key',
      'base_url',
      'max_output_tokens',
      'context_window_tokens',
      'daily_budget_tokens',
      'speed',
      'supports_json',
      'supports_search',
      'modalities',
      'transcription_model',
      // ⛔ DETECTED capabilities are cleared by every save, on purpose. A save
      // is the only moment provider/base_url/model can change, and an
      // observation about the previous endpoint is a guess about one nobody
      // asked about. This is the invalidation the old fingerprint scheme was
      // built to provide — the write path had it all along.
      'system_role_ok',
      'native_json_ok',
    ];
    if (!slot) {
      for (const k of keys) del(`${prefix}.${k}`);
      return;
    }
    // ⛔ DETECTED capabilities die on every save. The `keys` list above only
    // runs on the CLEAR path, so this is not covered by it — and a save is
    // precisely when provider/base_url/model can change, which is what makes a
    // prior observation a guess about an endpoint nobody asked about. This is
    // the invalidation the old content-fingerprint scheme existed to provide.
    del(`${prefix}.system_role_ok`);
    del(`${prefix}.native_json_ok`);
    // Read the prior credential context BEFORE overwriting provider/base_url —
    // a blank-key preserve is only honest when the context is unchanged.
    const prevProvider = get(`${prefix}.provider`);
    const prevBaseUrl = get(`${prefix}.base_url`);
    set(`${prefix}.provider`, slot.provider);
    set(`${prefix}.model`, slot.model);
    // D-174 R28 Slice B — a blank api_key PRESERVES the existing stored key,
    // but ONLY when the credential context (provider + base_url) is unchanged.
    // The webclient never receives the key (redacted to `has_key` on the
    // wire), so its "leave blank to keep existing" path can't echo the key
    // back; the merge lives here instead. A non-empty value writes (encrypts)
    // the new key. A blank key with a CHANGED provider/base_url would attach
    // the previous provider's key to a new endpoint, so the key is dropped
    // instead (the slot reads as un-keyed until a new key is set). To remove a
    // key deliberately, clear the whole slot (`saveSlot(null)`).
    if (slot.api_key.length > 0) {
      setSensitive(`${prefix}.api_key`, slot.api_key);
    } else if (prevProvider !== slot.provider || prevBaseUrl !== (slot.base_url || undefined)) {
      del(`${prefix}.api_key`);
    }
    if (slot.base_url) set(`${prefix}.base_url`, slot.base_url); else del(`${prefix}.base_url`);
    if (slot.max_output_tokens !== undefined) {
      set(`${prefix}.max_output_tokens`, String(slot.max_output_tokens));
    } else {
      del(`${prefix}.max_output_tokens`);
    }
    if (slot.context_window_tokens !== undefined) {
      set(`${prefix}.context_window_tokens`, String(slot.context_window_tokens));
    } else {
      del(`${prefix}.context_window_tokens`);
    }
    if (slot.daily_budget_tokens !== undefined) {
      set(`${prefix}.daily_budget_tokens`, String(slot.daily_budget_tokens));
    } else {
      del(`${prefix}.daily_budget_tokens`);
    }
    if (slot.speed) set(`${prefix}.speed`, slot.speed); else del(`${prefix}.speed`);
    if (slot.supports_json !== undefined) set(`${prefix}.supports_json`, slot.supports_json ? '1' : '0');
    else del(`${prefix}.supports_json`);
    if (slot.supports_search !== undefined) set(`${prefix}.supports_search`, slot.supports_search ? '1' : '0');
    else del(`${prefix}.supports_search`);
    if (slot.modalities !== undefined) set(`${prefix}.modalities`, JSON.stringify(slot.modalities));
    else del(`${prefix}.modalities`);
    if (slot.transcription_model) set(`${prefix}.transcription_model`, slot.transcription_model);
    else del(`${prefix}.transcription_model`);
  };

  const parsePoolBlob = (raw: string | undefined): FreePoolEntry[] => {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed as FreePoolEntry[];
    } catch {
      /* malformed persisted pool — treat as empty */
    }
    return [];
  };

  /** Strict pool read for MUTATING ops — propagates a locked/decrypt
   *  failure (unlike `getPool`, which swallows it to `[]` so a read-only
   *  `getConfig()` doesn't crash). A remove / toggle on a locked server
   *  MUST surface the 423 `locked` error rather than silently no-op and
   *  let the client confirm a change the encrypted config never applied
   *  (D-174 R28 Slice D — codex MED). `setSensitive` already throws on
   *  the locked WRITE; this closes the locked-READ gap. */
  const readPoolStrict = (): FreePoolEntry[] => parsePoolBlob(getSensitive('pool'));

  const poolUsageKey = (entryId: string): string => `pool_usage.${entryId}.${today()}`;

  return {
    getConfig() {
      // SQLite slots, env vars override
      const slot_1 = envConfig?.slot_1 ?? loadSlot('slot_1');
      const slot_2 = envConfig?.slot_2 ?? loadSlot('slot_2');
      // D-174 R28 Slice C — the dedicated embeddings source. `loadSlot`
      // requires provider + model + api_key, so a present embeddings_slot
      // always carries its (embeddings) model.
      const embeddings_slot = envConfig?.embeddings_slot ?? loadSlot('embeddings_slot');
      const free_pool = this.getPool();
      const config: LLMConfig = { slot_1, slot_2 };
      if (embeddings_slot) config.embeddings_slot = embeddings_slot;
      if (free_pool.length > 0) config.free_pool = free_pool;
      const strat = this.getPoolStrategy();
      if (strat !== 'round_robin') config.free_pool_strategy = strat;
      const upDef = this.getAllowUpgradeDefault();
      if (upDef) config.allow_upgrade_default = true;
      // Lever-2 per-slot — include the persisted per-source catalog modes only
      // when set, so an unconfigured server's config stays byte-identical.
      const catalogModes = this.getCatalogModes();
      if (Object.keys(catalogModes).length > 0) config.catalog_modes = catalogModes;
      const gatewayRoute =
        envConfig?.llm_gateway_default_route ?? this.getLlmGatewayDefaultRoute();
      if (gatewayRoute) config.llm_gateway_default_route = gatewayRoute;
      const gatewayAlias =
        envConfig?.llm_gateway_model_alias ?? this.getLlmGatewayModelAlias();
      if (gatewayAlias) config.llm_gateway_model_alias = gatewayAlias;
      // The owner's role+instructions block (1) + the wire role. Only ever
      // present when the owner actually authored one, so an unconfigured
      // server's config blob stays byte-identical and the resolver falls
      // through to the built-in. Absence IS the default; deleting IS the reset.
      for (const surface of LLM_PROMPT_SURFACE_KEYS) {
        const roleInstructions = this.getRoleInstructions(surface);
        if (roleInstructions) config[`${surface}_role_instructions`] = roleInstructions;
        const role = this.getSystemRole(surface);
        if (role) config[`${surface}_system_role`] = role;
      }
      const callerPolicy = this.getCallerSystemPolicy();
      if (callerPolicy) config.llm_gateway_caller_system_policy = callerPolicy;
      return config;
    },

    setSlot1(slot) { saveSlot('slot_1', slot); },
    setSlot2(slot) { saveSlot('slot_2', slot); },
    setEmbeddingsSlot(slot) { saveSlot('embeddings_slot', slot); },

    setPool(entries) {
      if (entries.length === 0) {
        del('pool');
        return;
      }
      // Pool entries contain api_keys; encrypt the full JSON blob.
      setSensitive('pool', JSON.stringify(entries));
    },
    getPool() {
      let raw: string | undefined;
      try {
        raw = getSensitive('pool');
      } catch {
        // Locked-server failure — return empty rather than crash the whole
        // getConfig() call. The executor will later hit AI_LLM_UNAVAILABLE
        // if the pool was the only source. Mutating ops use `readPoolStrict`
        // instead so a locked write surfaces the 423.
        return [];
      }
      return parsePoolBlob(raw);
    },

    // D-174 R28 field-level pool writes — each is a synchronous
    // read-modify-write (`readPoolStrict` + setPool with no await in between,
    // so the single-threaded rpc dispatch can't interleave two of them
    // mid-mutation). This is what lets two surfaces edit different entries
    // without the whole-blob `setLLMConfig` last-write-wins clobber.
    // `readPoolStrict` (not `getPool`) so a locked server fails loud (423)
    // instead of treating the unreadable pool as empty and no-op'ing.
    upsertPoolEntry(entry) {
      const next = readPoolStrict().filter((e) => e.id !== entry.id);
      next.push(entry);
      this.setPool(next);
    },
    removePoolEntry(id) {
      const pool = readPoolStrict();
      const next = pool.filter((e) => e.id !== id);
      if (next.length === pool.length) return false;
      this.setPool(next);
      return true;
    },
    setPoolEntryEnabled(id, enabled) {
      const pool = readPoolStrict();
      let found = false;
      const next = pool.map((e) => {
        if (e.id !== id) return e;
        found = true;
        return { ...e, enabled };
      });
      if (found) this.setPool(next);
      return found;
    },

    setPoolStrategy(s) {
      // 'round_robin' is the default; avoid writing it to keep storage tidy.
      if (s === 'round_robin') del('pool_strategy');
      else set('pool_strategy', s);
    },
    getPoolStrategy() {
      const raw = get('pool_strategy');
      if (raw === 'weighted') return 'weighted';
      return 'round_robin';
    },

    setAllowUpgradeDefault(v) {
      if (v) set('allow_upgrade_default', '1');
      else del('allow_upgrade_default');
    },
    getAllowUpgradeDefault() {
      return get('allow_upgrade_default') === '1';
    },

    // ── Lever-2 per-slot — chat catalog delivery mode per LLM source ──
    // Persisted as a plaintext JSON key (non-sensitive — no secrets), read
    // LIVE by the chat orchestrator (`getLlmConfig()?.catalog_modes`) so a
    // saved mode routes without a restart (D-174 R28 per-use read).
    getCatalogModes() {
      const raw = get('catalog_modes');
      if (!raw) return {};
      const out: Partial<Record<ChatModelSourceId, ChatCatalogDeliveryMode>> = {};
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          // Defensive filter — the rpc validates on write, but a hand-edited
          // SQLite row could carry a bad key/mode; drop anything unrecognized
          // so the orchestrator never resolves a garbage mode.
          for (const [k, v] of Object.entries(parsed)) {
            if (isChatModelSourceId(k) && isChatCatalogDeliveryMode(v)) out[k] = v;
          }
        }
      } catch {
        /* malformed persisted catalog_modes — treat as unset */
      }
      return out;
    },
    setCatalogModes(modes) {
      // Keep only valid source→mode pairs; drop the row entirely when nothing
      // remains so storage stays tidy and getConfig() omits the field.
      const entries = Object.entries(modes).filter(
        ([k, v]) => isChatModelSourceId(k) && isChatCatalogDeliveryMode(v),
      );
      if (entries.length === 0) {
        del('catalog_modes');
        return;
      }
      set('catalog_modes', JSON.stringify(Object.fromEntries(entries)));
    },
    setCatalogMode(source, mode) {
      // Read-modify-write (no await between read + write; single-threaded rpc
      // dispatch can't interleave) so a single-source edit never clobbers the
      // others — mirrors `upsertPoolEntry`. `null` clears just this source.
      const next = this.getCatalogModes();
      if (mode === null) delete next[source];
      else next[source] = mode;
      this.setCatalogModes(next);
    },

    setLlmGatewayDefaultRoute(route) {
      if (route === null) {
        del('llm_gateway.default_route');
        return;
      }
      if (!isLlmGatewayDefaultRoute(route)) {
        throw new Error(`llm_gateway.default_route invalid: ${String(route)}`);
      }
      set('llm_gateway.default_route', route);
    },
    getLlmGatewayDefaultRoute() {
      const raw = get('llm_gateway.default_route');
      return isLlmGatewayDefaultRoute(raw) ? raw : undefined;
    },
    setLlmGatewayModelAlias(alias) {
      const clean = typeof alias === 'string' ? alias.trim() : '';
      if (clean.length === 0) {
        del('llm_gateway.model_alias');
        return;
      }
      set('llm_gateway.model_alias', clean);
    },
    getLlmGatewayModelAlias() {
      const raw = get('llm_gateway.model_alias');
      if (raw === undefined) return undefined;
      const clean = raw.trim();
      return clean.length > 0 ? clean : undefined;
    },

    setRoleInstructions(surface, text) {
      const clean = typeof text === 'string' ? text.trim() : '';
      if (clean.length === 0) {
        // The reset-to-default. Absence is how the default is expressed, so
        // there is nothing to "restore" — the row simply stops existing.
        del(`${surface}.role_instructions`);
        return;
      }
      set(`${surface}.role_instructions`, clean);
    },
    getRoleInstructions(surface) {
      const raw = get(`${surface}.role_instructions`);
      if (raw === undefined) return undefined;
      const clean = raw.trim();
      return clean.length > 0 ? clean : undefined;
    },
    setSystemRole(surface, role) {
      if (role === null) {
        del(`${surface}.system_role`);
        return;
      }
      if (!isLLMMessageRole(role)) {
        throw new Error(
          `system_role must be ${LLM_MESSAGE_ROLES.join(' | ')}, got ${String(role)}`,
        );
      }
      set(`${surface}.system_role`, role);
    },
    getSystemRole(surface) {
      // Defensive read — a hand-edited SQLite row must not be able to surface a
      // role the adapters would choke on.
      const raw = get(`${surface}.system_role`);
      return isLLMMessageRole(raw) ? raw : undefined;
    },
    setSourceCapability(source, patch) {
      // Absent means "not yet known" and reads as YES, so only a definite
      // `false` is worth a row — writing `1` everywhere would double the
      // config's size to record the default.
      const write = (setKey: (k: string, v: string) => void, del: (k: string) => void,
                     prefix: string): void => {
        for (const field of ['system_role_ok', 'native_json_ok'] as const) {
          const value = patch[field];
          if (value === undefined) continue;
          if (value === false) setKey(`${prefix}.${field}`, '0');
          else del(`${prefix}.${field}`);
        }
      };
      if (source.kind === 'slot') {
        write(set, del, source.slot_key);
        return;
      }
      // Pool entries live in one encrypted blob, so this is a read-modify-write
      // — the same shape the other field-level pool writes already use.
      const entries = readPoolStrict();
      const next = entries.map((e) => (e.id === source.entry_id
        ? {
            ...e,
            ...(patch.system_role_ok !== undefined
              ? { system_role_ok: patch.system_role_ok }
              : {}),
            ...(patch.native_json_ok !== undefined
              ? { native_json_ok: patch.native_json_ok }
              : {}),
          }
        : e));
      // Nothing matched — the entry was removed between the discovery and this
      // write. Drop the observation rather than resurrect a dead entry, and do
      // not rewrite the pool at all: it holds api keys and is stored
      // `setSensitive`, so a redundant write re-encrypts every credential in it
      // under a fresh IV for no reason.
      if (next.some((e, i) => e !== entries[i])) this.setPool(next);
    },
    setCallerSystemPolicy(policy) {
      if (policy === null) {
        del('llm_gateway.caller_system_policy');
        return;
      }
      if (!isLlmGatewayCallerSystemPolicy(policy)) {
        throw new Error(
          `caller_system_policy must be ${LLM_GATEWAY_CALLER_SYSTEM_POLICIES.join(' | ')}, got ${String(policy)}`,
        );
      }
      set('llm_gateway.caller_system_policy', policy);
    },
    getCallerSystemPolicy() {
      const raw = get('llm_gateway.caller_system_policy');
      return isLlmGatewayCallerSystemPolicy(raw) ? raw : undefined;
    },

    addPoolUsage(entryId, tokens) {
      const key = poolUsageKey(entryId);
      const current = parseInt(get(key) ?? '0', 10);
      const next = current + tokens;
      set(key, String(next));
      return next;
    },
    getPoolUsage(entryId) {
      const key = poolUsageKey(entryId);
      return parseInt(get(key) ?? '0', 10);
    },
    isPoolEntryOverCap(entryId, cap) {
      if (cap == null || cap <= 0) return false;
      return this.getPoolUsage(entryId) >= cap;
    },

    getBudget() {
      return parseInt(get('budget') ?? '0', 10);
    },

    setBudget(tokens) {
      set('budget', String(tokens));
    },

    getUsage() {
      const key = `usage.${today()}`;
      return parseInt(get(key) ?? '0', 10);
    },

    addUsage(tokens) {
      const key = `usage.${today()}`;
      const current = parseInt(get(key) ?? '0', 10);
      const next = current + tokens;
      set(key, String(next));
      return next;
    },

    getStatus(expectedTokens = 0) {
      return checkBudgetStatus(this.getUsage() + expectedTokens, this.getBudget(), this.getThresholds());
    },

    isOverBudget(expectedTokens = 0) {
      return this.getStatus(expectedTokens).status === 'exceeded';
    },

    isScheduleCutoff() {
      const s = this.getStatus();
      return s.status === 'schedule_cutoff' || s.status === 'warning' || s.status === 'exceeded';
    },

    getThresholds() {
      const raw = get('thresholds');
      if (raw) try { return { ...DEFAULT_BUDGET_THRESHOLDS, ...JSON.parse(raw) }; } catch {}
      return { ...DEFAULT_BUDGET_THRESHOLDS };
    },

    setThresholds(t) {
      const current = this.getThresholds();
      set('thresholds', JSON.stringify({ ...current, ...t }));
    },

    resetUsage() {
      // Delete all usage.YYYY-MM-DD keys except today, plus stale
      // pool_usage.<entry>.<YYYY-MM-DD> rows from earlier days.
      const todayStr = today();
      const todayKey = `usage.${todayStr}`;
      const rows = db.prepare(
        `SELECT key FROM llm_config WHERE key LIKE 'usage.%' OR key LIKE 'pool_usage.%'`,
      ).all() as { key: string }[];
      for (const { key } of rows) {
        if (key === todayKey) continue;
        if (key.startsWith('pool_usage.') && key.endsWith(`.${todayStr}`)) continue;
        del(key);
      }
    },
  };
};
