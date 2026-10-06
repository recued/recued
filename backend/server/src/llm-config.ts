/** Server-side LLM configuration — persisted in SQLite.
 *
 *  Manages two slots (fast + quality), daily token budget, and usage
 *  tracking. Same model as the extension's LLM settings but stored
 *  in the server's SQLite database instead of chrome.storage.
 *
 *  Priority: SQLite (persisted) → env vars (override) → none.
 */

import type Database from 'better-sqlite3';
import { initializePreapprovalLifecycle, synchronizePreapprovalIdentity } from './storage/preapproval-lifecycle.js';
import { llmSourceMaterial } from './preapproval-ai-description.js';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type {
  FreePoolEntry, LLMConfig, LLMSlot, CoordinationStrategy, LlmGatewayDefaultRoute,
  LLMMessageRole, LlmGatewayCallerSystemPolicy, EndpointCapabilityNote,
} from '@recued/llm';
import {
  isLLMMessageRole, isLlmGatewayCallerSystemPolicy,
  LLM_MESSAGE_ROLES, LLM_GATEWAY_CALLER_SYSTEM_POLICIES,
  defaultTranscriptionModel, imageInputSeen,
} from '@recued/llm';
import {
  checkBudgetStatus, DEFAULT_BUDGET_THRESHOLDS,
  isChatCatalogDeliveryMode, isChatModelSourceId, suggestFreePoolEntryId,
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
  /** D-262 § B1 — the dedicated transcription source. `null` clears it. */
  setTranscriptionSlot(slot: LLMSlot | null): void;
  /** D-262 § B5 — the one-time upgrade step that fills `transcription_slot`
   *  from a free-pool entry that used to serve transcription, so voice notes
   *  do not stop working on a server that upgrades into the dedicated slot.
   *  Returns what it did, for the boot log. Safe to call on every boot. */
  deriveTranscriptionSlotOnce():
    | 'derived'
    | 'already_marked'
    | 'no_candidate'
    /** D-262 — the credentials could not be READ (locked server, encrypted
     *  values, no DEK). Distinct from `no_candidate`, and the marker is NOT
     *  written: retry after unlock. */
    | 'deferred_locked';
  /** D-262 § B6 — the owner's spoken language (ISO-639-1). `null` clears back
   *  to auto-detect, which is a MEANINGFUL state and the default. */
  setTranscriptionLanguage(lang: string | null): void;
  getTranscriptionLanguage(): string | null;
  /** D-262 § B12.3 — the daily transcription cap in REQUESTS. `null` clears to
   *  unlimited. ⚠ Enforcement is process-lifetime only until the quota tracker
   *  is persisted — see `transcription_daily_requests` in contracts. */
  setTranscriptionDailyRequests(limit: number | null): void;
  getTranscriptionDailyRequests(): number | null;
  // ── Free LLM pool ──
  /** Replace the entire free pool (entries are stored as a JSON blob). */
  setPool(entries: FreePoolEntry[]): void;
  /** Get the current free pool. Empty array when unset. */
  getPool(): FreePoolEntry[];
  /** D-174 R28 — add or replace ONE pool entry (matched by `id`) via a
   *  synchronous read-modify-write over the blob, so a single-entry edit
   *  never clobbers the other entries (vs `setPool` which replaces all). A
   *  replaced entry keeps its place in the pool.
   *
   *  A blank `api_key` keeps the stored key, by the rule a slot's save uses:
   *  only for an existing entry whose `provider` and `base_url` are unchanged.
   *  Otherwise nothing is written and the answer is `key_required` — a
   *  keyless entry is one no call can use. */
  upsertPoolEntry(entry: FreePoolEntry): 'saved' | 'key_required';
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
      | { kind: 'slot'; slot_key: 'slot_1' | 'slot_2' | 'embeddings_slot' | 'transcription_slot' }
      | { kind: 'pool'; entry_id: string },
    patch: { system_role_ok?: boolean; native_json_ok?: boolean; image_input_ok?: boolean },
  ): void;
  /** What the gateway does with a CALLER's OpenAI `system` message. `null`
   *  clears back to `'context'` (the pre-existing behaviour). */
  setCallerSystemPolicy(policy: LlmGatewayCallerSystemPolicy | null): void;
  getCallerSystemPolicy(): LlmGatewayCallerSystemPolicy | undefined;
  // ⛔ D-262 follow-on — `addPoolUsage` / `getPoolUsage` / `isPoolEntryOverCap`
  // RETIRED here. They persisted `pool_usage.<entry>.<date>` rows and answered
  // "is this pool entry over its cap" — but NOTHING EVER CALLED `addPoolUsage`,
  // in this tree or in any commit since it was introduced, so the getter always
  // read 0 and the cap check always answered false.
  //
  // 🔑 THE DANGER WAS NOT THE DEAD CODE, IT WAS THE PLAUSIBLE NAME. Pool caps
  // ARE enforced — by `QuotaTracker.statusFor` against its own counter, which
  // is now persisted. Someone wiring `addPoolUsage` would have believed they
  // were feeding that enforcement and would have been feeding nothing, while
  // the real path kept working and hid the mistake.
  //
  // ⚠ No stored rows to clean up: a writer that never ran leaves no data.
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
  /** D-262 follow-on — the `QuotaTracker`'s persisted state.
   *
   *  ⛔ WITHOUT THIS EVERY PER-SOURCE BUDGET RESET ON RESTART. The tracker
   *  holds the counters that `statusFor` compares against a pool entry's
   *  `daily_cap_tokens`, that `slotOverCutoff` compares against a slot's
   *  `daily_budget_tokens`, and that the embeddings and transcription caps
   *  read. It was built unseeded and its `snapshot()` had no caller, so a
   *  server that restarted — which a self-hoster does on every update — began
   *  the day again. A daily cap you can clear by restarting is not a cap.
   *
   *  ⚠ Distinct from `getUsage`/`addUsage`, which persist ONE AGGREGATE
   *  counter (`usage.<date>`) for the global budget. Two systems, two
   *  questions: "how much has this server spent today" versus "how much has
   *  THIS source spent today". Both are live; only the second was volatile. */
  getQuotaSnapshot(): unknown;
  setQuotaSnapshot(snapshot: unknown): void;
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

/** D-262 § B5 — set once the derivation has LOOKED, whatever it concluded.
 *  Lives in the same prefixed key/value store as the slots it guards, so the
 *  marker and the thing it protects cannot drift apart across a restore. */
const TRANSCRIPTION_DERIVED_MARKER = 'transcription_slot.derived';

/** D-262 follow-on — where the `QuotaTracker` snapshot lives.
 *
 *  ⚠ A PLAIN key, not a sensitive one: the blob holds per-source counters and
 *  a round-robin cursor keyed by ids like `slot_1` or a pool entry's id. No
 *  credential, nothing an attacker learns from that they could not read from
 *  the config surface anyway — and keeping it plain means it survives a locked
 *  server, which is precisely when a budget must keep counting. */
const QUOTA_SNAPSHOT_KEY = 'quota.snapshot';

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
  initializePreapprovalLifecycle(db);
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
    const providerName = get(`${prefix}.provider_name`);
    if (providerName !== undefined && providerName.length > 0) slot.provider_name = providerName;
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
    // ⚠ The opposite polarity: a PROOF, so only `1` is ever stored.
    if (get(`${prefix}.image_input_ok`) === '1') slot.image_input_ok = true;
    const speed = get(`${prefix}.speed`);
    if (speed === 'fast' || speed === 'quality' || speed === 'thinking') slot.speed = speed;
    const sJson = get(`${prefix}.supports_json`);
    if (sJson !== undefined) slot.supports_json = sJson === '1';
    const sSearch = get(`${prefix}.supports_search`);
    if (sSearch !== undefined) slot.supports_search = sSearch === '1';
    // D-172 P5 — round-trip the modality + transcription declarations so a
    // BYOK slot configured via the CLI can satisfy a media turn (without
    // these, `matchLLM` reads the slot as text-only).
    // D-262 § B4 — `transcription_model` is RETIRED and deliberately not
    // hydrated. The row may still exist on an upgraded server; the one-time
    // derivation reads it directly, and `writeSlot`'s clear list below removes
    // it on the next save of that slot.
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

  const writeSlot = (prefix: string, slot: LLMSlot | null): void => {
    const keys = [
      'provider',
      'provider_name',
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
      'image_input_ok',
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
    // ⛔ THE PICTURE PROOF IS THE EXCEPTION TO "DETECTED DIES ON SAVE". Its
    // default is "cannot", so killing it on a budget or name edit would switch
    // off every camera check the owner relies on until they think to press
    // Test again. It stays while the endpoint is the same one it was proven on,
    // and it is ADOPTED when a Test of the unsaved draft proved this very
    // endpoint (the in-memory proof, keyed by provider + base_url + model). A
    // value the client sent is never read: nothing outside a picture check may
    // assert one.
    const sameEndpoint = prevProvider === slot.provider
      && prevBaseUrl === (slot.base_url || undefined)
      && get(`${prefix}.model`) === slot.model;
    const picturesProven = imageInputSeen(slot)
      || (sameEndpoint && get(`${prefix}.image_input_ok`) === '1');
    if (picturesProven) set(`${prefix}.image_input_ok`, '1');
    else del(`${prefix}.image_input_ok`);
    set(`${prefix}.provider`, slot.provider);
    // The name is a label, not credential context: it is written or cleared
    // here and plays no part in the key guard below.
    if (slot.provider_name) set(`${prefix}.provider_name`, slot.provider_name);
    else del(`${prefix}.provider_name`);
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
    // D-262 § B4 — never written again. ⚠ It stays in the `keys` clear-list
    // above, so saving a slot removes the stale row rather than leaving a
    // value nothing reads sitting in the owner's database forever.
  };

  const saveSlot = (
    prefix: 'slot_1' | 'slot_2' | 'embeddings_slot' | 'transcription_slot',
    slot: LLMSlot | null,
  ): void => {
    db.transaction(() => {
      writeSlot(prefix, slot);
      // Keep account/model destruction and edit-then-restore observable even
      // if no execution reads the intermediate value. Usage counters do not
      // change this identity; normal quota checks remain live at dispatch.
      synchronizePreapprovalIdentity(db, 'llm_source', prefix, llmSourceMaterial(envConfig?.[prefix] ?? loadSlot(prefix)));
    }).immediate();
  };

  /** ⛔ The pool once took an entry with a BLANK id, and nothing could then
   *  remove, disable, test or edit it: the rpcs refuse a blank id and Settings
   *  drew no buttons for one. Each is named on read the way Settings names a
   *  new entry the owner left unnamed (`suggestFreePoolEntryId`), so the same
   *  pool always reads with the same names, and the next pool write stores
   *  them. */
  const nameUnnamedPoolEntries = (entries: FreePoolEntry[]): FreePoolEntry[] => {
    const named = (entry: FreePoolEntry): boolean =>
      typeof entry.id === 'string' && entry.id.trim().length > 0;
    if (entries.every(named)) return entries;
    const taken = new Set(entries.filter(named).map((entry) => entry.id));
    return entries.map((entry) => {
      if (named(entry)) return entry;
      const id = suggestFreePoolEntryId(
        { provider: entry.provider, ...(entry.base_url !== undefined ? { base_url: entry.base_url } : {}) },
        taken,
      );
      taken.add(id);
      return { ...entry, id };
    });
  };

  const parsePoolBlob = (raw: string | undefined): FreePoolEntry[] => {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return nameUnnamedPoolEntries(parsed as FreePoolEntry[]);
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


  return {
    getConfig() {
      // SQLite slots, env vars override
      const slot_1 = envConfig?.slot_1 ?? loadSlot('slot_1');
      const slot_2 = envConfig?.slot_2 ?? loadSlot('slot_2');
      // D-174 R28 Slice C — the dedicated embeddings source. `loadSlot`
      // requires provider + model + api_key, so a present embeddings_slot
      // always carries its (embeddings) model.
      const embeddings_slot = envConfig?.embeddings_slot ?? loadSlot('embeddings_slot');
      // D-262 § B1 — the dedicated transcription source. Same load path, same
      // provider+model+api_key requirement, so a present slot always carries
      // its (transcription) model.
      const transcription_slot =
        envConfig?.transcription_slot ?? loadSlot('transcription_slot');
      const free_pool = this.getPool();
      const config: LLMConfig = { slot_1, slot_2 };
      if (embeddings_slot) config.embeddings_slot = embeddings_slot;
      if (transcription_slot) config.transcription_slot = transcription_slot;
      // ⛔ Absent means AUTO-DETECT and is the default — so it is only written
      // into the config when the owner set one. An empty string would be a
      // pinned value to the provider, not an absence.
      const transcriptionLanguage =
        envConfig?.transcription_language ?? this.getTranscriptionLanguage();
      if (transcriptionLanguage) config.transcription_language = transcriptionLanguage;
      const transcriptionCap =
        envConfig?.transcription_daily_requests ?? this.getTranscriptionDailyRequests();
      // Absent means unlimited, so only a positive cap is written into config.
      if (transcriptionCap !== null && transcriptionCap !== undefined && transcriptionCap > 0) {
        config.transcription_daily_requests = transcriptionCap;
      }
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
    setTranscriptionSlot(slot) { saveSlot('transcription_slot', slot); },

    /** D-262 § B5 — MIGRATION, NOT A FALLBACK.
     *
     *  Messenger voice notes transcribed off the free pool before this slot
     *  existed, on servers that upgrade whenever their owner chooses. Deleting
     *  that path outright would stop those notes the moment the release lands,
     *  with nothing on screen explaining why. So the first boot after the
     *  upgrade copies a pool entry that declared transcription into the slot —
     *  the owner wakes to a visible, editable card holding credentials they
     *  already had — and the pool path is then genuinely gone.
     *
     *  ⛔⛔ GATED ON A PERSISTED MARKER, NEVER ON THE SLOT BEING ABSENT. Keying
     *  it on absence would re-run on EVERY boot, so an owner who deliberately
     *  cleared the slot would find it silently restored on the next restart —
     *  a default they cannot remove, which reads as the setting being ignored.
     *
     *  ⚠ And the marker is written whatever the outcome, so this is genuinely
     *  ONE-TIME: a server with no audio pool entry today does not get a slot
     *  conjured months later when it adds one. By then the owner is
     *  configuring, not migrating.
     *
     *  ⛔⛔ ONE EXCEPTION, AND IT IS THE DIFFERENCE BETWEEN "NOTHING TO FIND"
     *  AND "COULD NOT LOOK". On a locked server the pool blob is encrypted and
     *  unreadable, and `getPool()` deliberately returns `[]` rather than
     *  throwing — so a migration reading it saw an empty pool, concluded
     *  `no_candidate`, and wrote the one-time marker. Unlocking and restarting
     *  could never recover: the marker says the migration already ran, and the
     *  owner's audio pool entry is silently never derived. ⇒ This reads the
     *  pool STRICTLY (the same `readPoolStrict` every mutating op uses, for the
     *  same reason) and returns `deferred_locked` WITHOUT the marker.
     *
     *  The model resolution mirrors what the retired pool path resolved
     *  (`transcription_model` → provider default → the entry's chat model),
     *  because preserving behaviour is the entire point. */
    deriveTranscriptionSlotOnce() {
      if (get(TRANSCRIPTION_DERIVED_MARKER) === '1') return 'already_marked';

      const existing = envConfig?.transcription_slot ?? loadSlot('transcription_slot');
      if (existing) {
        set(TRANSCRIPTION_DERIVED_MARKER, '1');
        return 'already_marked';
      }

      // ⛔ A MIGRATION READS THE OLD SHAPE. `transcription_model` is retired
      // from `LLMSlot` / `FreePoolApiEntry`, but a server upgrading from the
      // pool-routing era still has the VALUE persisted — in the pool blob
      // (which `parsePoolBlob` JSON-parses without dropping unknown keys) and
      // in the per-slot `<prefix>.transcription_model` rows. Reading it through
      // a cast is the correct shape for a one-time upgrade step: the type
      // describes what the code writes NOW, the migration describes what it
      // finds.
      const legacyModelOf = (e: unknown): string | undefined => {
        const v = (e as { transcription_model?: unknown } | null)?.transcription_model;
        return typeof v === 'string' && v.length > 0 ? v : undefined;
      };

      // ⚠ POOL FIRST, THEN THE CHAT SLOTS — because that is the order the
      // retired `matchLLM` routing resolved in (free before BYOK). Preserving
      // WHICH source served transcription matters as much as preserving that
      // one did: deriving the paid slot when the free pool used to answer would
      // start billing an owner who was not being billed.
      //
      // ⛔ SLOTS WERE MISSING FROM THE FIRST CUT OF THIS MIGRATION, and that was
      // a real gap: `transcribe` used to match over slot_1 / slot_2 / free_pool
      // alike, so an owner whose transcription ran off an audio-capable BYOK
      // slot would have found voice notes simply stopped, with a correctly
      // marked migration reporting `no_candidate`.
      // ⛔ STRICT, so a locked read THROWS instead of reading as "empty". The
      // lenient `getPool()` is right for serving (a locked pool is simply no
      // source right now); it is wrong for a ONE-TIME migration, where an
      // unreadable pool recorded as `no_candidate` is unrecoverable.
      let poolCandidate: FreePoolEntry | undefined;
      let slotCandidate: { slot: LLMSlot; transcription_model?: string } | undefined;
      try {
        poolCandidate = readPoolStrict().find(
          // Only an ENABLED entry: a disabled one is an owner saying "not this".
          (e) => e.enabled
            && (legacyModelOf(e) !== undefined || e.modalities?.audio === true),
        );
        slotCandidate = poolCandidate
          ? undefined
          : (['slot_1', 'slot_2'] as const)
            .map((key) => {
              const slot = envConfig?.[key] ?? loadSlot(key);
              if (!slot) return undefined;
              const legacy = get(`${key}.transcription_model`);
              const usable = (legacy !== undefined && legacy.length > 0)
                || slot.modalities?.audio === true;
              return usable
                ? { slot, ...(legacy ? { transcription_model: legacy } : {}) }
                : undefined;
            })
            .find((c) => c !== undefined);
      } catch {
        // ⛔ COULD NOT LOOK ≠ NOTHING TO FIND. Leave the marker unwritten so
        // the next boot after an unlock runs the migration for real. Returning
        // `no_candidate` here would spend the one-time run on a read that saw
        // nothing because it was not allowed to see.
        return 'deferred_locked';
      }

      const source = poolCandidate
        ? {
            provider: poolCandidate.provider,
            model: legacyModelOf(poolCandidate)
              ?? defaultTranscriptionModel(poolCandidate.provider)
              ?? poolCandidate.model,
            api_key: poolCandidate.api_key,
            base_url: poolCandidate.base_url,
          }
        : slotCandidate
          ? {
              provider: slotCandidate.slot.provider,
              model: slotCandidate.transcription_model
                ?? defaultTranscriptionModel(slotCandidate.slot.provider)
                ?? slotCandidate.slot.model,
              api_key: slotCandidate.slot.api_key,
              base_url: slotCandidate.slot.base_url,
            }
          : undefined;

      if (!source) {
        set(TRANSCRIPTION_DERIVED_MARKER, '1');
        return 'no_candidate';
      }

      const derived: LLMSlot = {
        provider: source.provider,
        model: source.model,
        api_key: source.api_key,
        ...(source.base_url !== undefined ? { base_url: source.base_url } : {}),
      };
      db.transaction(() => {
        writeSlot('transcription_slot', derived);
        set(TRANSCRIPTION_DERIVED_MARKER, '1');
      }).immediate();
      return 'derived';
    },

    setTranscriptionLanguage(lang) {
      const trimmed = lang?.trim() ?? '';
      if (trimmed.length === 0) del('transcription_language');
      else set('transcription_language', trimmed);
    },
    getTranscriptionLanguage() {
      return get('transcription_language') ?? null;
    },

    setTranscriptionDailyRequests(limit) {
      if (limit === null || !Number.isFinite(limit) || limit <= 0) {
        del('transcription_daily_requests');
      } else {
        set('transcription_daily_requests', String(Math.floor(limit)));
      }
    },
    getTranscriptionDailyRequests() {
      const raw = get('transcription_daily_requests');
      if (raw === undefined || raw === null) return null;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : null;
    },

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
      const pool = readPoolStrict();
      const prev = pool.find((e) => e.id === entry.id);
      // The picture proof follows the same rule as a slot's (`writeSlot`):
      // kept while the endpoint is unchanged, adopted from a Test of this very
      // endpoint, and never taken from what the client sent.
      const { image_input_ok: _claimed, ...asSent } = entry;
      const sameEndpoint = prev !== undefined
        && prev.provider === entry.provider
        && (prev.base_url || undefined) === (entry.base_url || undefined)
        && prev.model === entry.model;
      const picturesProven = imageInputSeen(entry)
        || (sameEndpoint && prev.image_input_ok === true);
      let stored: FreePoolEntry = picturesProven ? { ...asSent, image_input_ok: true } : asSent;
      if (entry.api_key.length === 0) {
        // The same credential context `writeSlot` guards: a key never follows
        // its entry to another protocol or address.
        const sameContext = prev !== undefined
          && prev.provider === entry.provider
          && (prev.base_url || undefined) === (entry.base_url || undefined);
        if (prev === undefined || !sameContext || !prev.api_key) return 'key_required';
        stored = { ...stored, api_key: prev.api_key };
      }
      const next: FreePoolEntry[] = [];
      let placed = false;
      for (const e of pool) {
        if (e.id !== entry.id) next.push(e);
        else if (!placed) {
          next.push(stored);
          placed = true;
        }
      }
      if (!placed) next.push(stored);
      this.setPool(next);
      return 'saved';
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
        // A proof, so the polarity flips: only `1` is worth a row.
        if (patch.image_input_ok === true) setKey(`${prefix}.image_input_ok`, '1');
        else if (patch.image_input_ok === false) del(`${prefix}.image_input_ok`);
      };
      if (source.kind === 'slot') {
        write(set, del, source.slot_key);
        return;
      }
      // Pool entries live in one encrypted blob, so this is a read-modify-write
      // — the same shape the other field-level pool writes already use.
      const entries = readPoolStrict();
      const next = entries.map((e) => {
        if (e.id !== source.entry_id) return e;
        // A verdict either way replaces the proof; no verdict keeps it.
        const { image_input_ok: proven, ...rest } = e;
        const keepsProof = patch.image_input_ok ?? proven === true;
        return {
          ...rest,
          ...(patch.system_role_ok !== undefined
            ? { system_role_ok: patch.system_role_ok }
            : {}),
          ...(patch.native_json_ok !== undefined
            ? { native_json_ok: patch.native_json_ok }
            : {}),
          ...(keepsProof ? { image_input_ok: true } : {}),
        };
      });
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

    getQuotaSnapshot() {
      const raw = get(QUOTA_SNAPSHOT_KEY);
      if (raw === undefined || raw === null) return undefined;
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        // ⚠ A malformed blob reads as ABSENT, not as an error. The counters it
        // held are today's spend at worst; refusing to boot over them, or
        // throwing into the first LLM call, would trade a small
        // over-allowance for an unusable server.
        return undefined;
      }
    },
    setQuotaSnapshot(snapshot) {
      set(QUOTA_SNAPSHOT_KEY, JSON.stringify(snapshot));
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
      // Delete all usage.YYYY-MM-DD keys except today.
      //
      // ⚠ D-262 follow-on — the `pool_usage.%` clause went with the retired
      // trio above: nothing could create such a row any more.
      //
      // ⛔ AND THIS FUNCTION HAS NO CALLER, WHICH IS NOW A SETTLED HOLD RATHER
      // THAN A PENDING ONE (2026-09-06). The usage surface it was waiting on
      // shipped, and it reports TODAY ONLY — `server.getLLMUsage` returns one
      // `day`, and `getUsage()` reads `usage.<today>`. So nothing reads a past
      // day's row, which cuts both ways: pruning them is invisible, and they
      // are the ONLY record of past daily spend there is. ⇒ Wiring this trades
      // an irreversible loss of the sole spend history for one small row per
      // day of growth. Not worth it. The rows stay; the function stays
      // reachable for a future explicit "forget my history" decision.
      //
      // ⚠ NOT a per-slot reset and NOT a counter reset — the live daily
      // counters clear themselves in `QuotaTracker.maybeReset` at UTC
      // midnight, chat / embeddings / transcription buckets alike. Nothing
      // here resets a budget.
      const todayKey = `usage.${today()}`;
      const rows = db.prepare(
        `SELECT key FROM llm_config WHERE key LIKE 'usage.%'`,
      ).all() as { key: string }[];
      for (const { key } of rows) {
        if (key === todayKey) continue;
        del(key);
      }
    },
  };
};
