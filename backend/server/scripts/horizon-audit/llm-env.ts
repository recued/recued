/** Give the booted server a real LLM, from the operator's own `dev.env`.
 *
 *  ⛔ WHY THIS EXISTS. `execution-case-sources-prune` was the last subsystem
 *  blocked on something the environment genuinely lacked. An execution report
 *  is written ONLY by the MODEL calling the `outcome_report` tool during a chat
 *  turn — `putImmutable` has exactly two callers, both in
 *  `chat-execution-case-tools.ts`, and there is no non-AI writer. With no LLM
 *  configured the seed can never hold a report, so the prune could only ever be
 *  driven against an empty corpus, which is "correctly idle" and proves
 *  nothing.
 *
 *  ⛔⛔ THE ENV PATH ALONE IS NOT ENOUGH, and it LOOKS like it is. The env
 *  config is the seed "when no db is present + as the fallback when the
 *  db-stored config can't decrypt" (`wire-llm-substrate.ts`). With a database
 *  present the DB-STORED config wins, and `resolveLlmConfig()` "prefers the
 *  manager's SQLite read". So the boot BANNER prints
 *  `LLM: google/gemini-2.5-flash` off the env value while the turn matcher
 *  reads SQLite, finds nothing, and answers "No AI model is available for your
 *  current model preference" — a configured-looking server that cannot route a
 *  turn. The slot is therefore also PERSISTED over `server.setLLMConfig`,
 *  which is what Settings → AI / Models does.
 *
 *  ⚠ THE KEY IS NEVER LOGGED, never returned, and never included in a report.
 *  It is read out of `dev.env` in-process and set on `process.env` for the
 *  child composition only. The caller receives the provider + model, which are
 *  not secret, so the drivability map can say what the run was driven with. */

import { existsSync, readFileSync } from 'node:fs';

export interface LlmSlotSpec {
  provider: string;
  model: string;
  api_key: string;
  base_url?: string;
  speed?: 'fast' | 'quality' | 'thinking';
  supports_json?: boolean;
}

export interface LlmEnvOutcome {
  readonly configured: boolean;
  /** Safe to print — provider + model only. */
  readonly detail: string;
  /** slot_1 — the fast lane. Carries the key, so it is handed straight to the
   *  rpc and never logged. */
  readonly slot?: LlmSlotSpec;
  /** slot_2 — a DIFFERENT PROVIDER with its own quota and context window.
   *
   *  ⛔ NOT redundancy for its own sake. A single free-tier credential is one
   *  429 away from making the whole LLM surface undrivable, which is exactly
   *  what blocked `execution-case-sources-prune` for most of this audit: the
   *  slot was configured, readable and pinned, and the turn still refused
   *  because the provider was out of quota. Two providers means an exhausted
   *  one degrades the run instead of ending it. */
  readonly slot2?: LlmSlotSpec;
}

const parseEnvFile = (path: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
};

/** Populate `RECUED_LLM_*` from `dev.env`'s GOOGLE_* entries. Must run BEFORE
 *  `serve()` — the config is resolved during storage composition. */
export const configureLlmFromDevEnv = (devEnvPath: string): LlmEnvOutcome => {
  if (!existsSync(devEnvPath)) {
    return { configured: false, detail: `no dev.env at ${devEnvPath}` };
  }
  let env: Record<string, string>;
  try {
    env = parseEnvFile(devEnvPath);
  } catch (err) {
    return {
      configured: false,
      detail: `dev.env unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const apiKey = env.GOOGLE_API_KEY;
  // ⛔ NOT `GOOGLE_MODEL3`. That slot holds `gemini-2.5-flash`, which Google has
  // RETIRED — the endpoint answers 404 "no longer available to new users", not
  // 429. The harness preferred it, reported `configured: true`, persisted it,
  // read it back intact, and every chat turn then refused. The whole LLM lane
  // read as "the product will not run a turn" for several rounds when the real
  // answer was "the harness pointed at a model that does not exist".
  //
  // 🔑 A CREDENTIAL THAT PERSISTS AND READS BACK IS NOT A CREDENTIAL THAT WORKS.
  // `preflightSlot` below is what closes that gap — presence was never the
  // question.
  const model = env.GOOGLE_MODEL;
  const baseUrl = env.GOOGLE_BASE_URL;

  // Qwen is OpenAI-compatible and lives behind its own base_url, with a quota
  // independent of Google's.
  const qwenKey = env.RECUED_QWEN_API_KEY;
  const qwenModel = env.RECUED_QWEN_MODEL;
  const qwenBase = env.RECUED_QWEN_BASE_URL;
  const slot2: LlmSlotSpec | undefined = qwenKey && qwenModel && qwenBase
    ? {
        provider: 'openai-compatible',
        model: qwenModel,
        api_key: qwenKey,
        base_url: qwenBase,
        // ⚠ `speed` and `supports_json` are OPTIONAL on a BYOK slot but
        // `slotMatches` compares `speed` EXACTLY and requires `supports_json`
        // for a json request. `normalizeLLMSlot` fills defaults, but stating
        // them keeps the harness's intent explicit rather than inherited.
        speed: 'quality',
        supports_json: true,
      }
    : undefined;

  if (!apiKey || !model) {
    if (!slot2) {
      return { configured: false, detail: 'dev.env has no GOOGLE_* or RECUED_QWEN_* credentials' };
    }
    // Google absent but Qwen present — run on Qwen alone.
    process.env.RECUED_LLM_PROVIDER = 'openai-compatible';
    process.env.RECUED_LLM_MODEL = slot2.model;
    process.env.RECUED_LLM_API_KEY = slot2.api_key;
    process.env.RECUED_LLM_BASE_URL = slot2.base_url!;
    return {
      configured: true,
      detail: `openai-compatible / ${slot2.model} (BYOK slot_1, qwen only)`,
      slot: { ...slot2, speed: 'fast' },
    };
  }

  const googleSlot: LlmSlotSpec = {
    provider: 'google', model, api_key: apiKey, speed: 'quality', supports_json: true,
  };

  // ⛔ SLOT_1 IS THE ONE THAT MUST HAVE QUOTA, and on this bench that is Qwen,
  // not Google. Chat's channel default tier is `fast`, which § A.14 maps to
  // slot_1, and D-191 INV3 makes a pinned slot FAIL-CLOSED — a 429 on the
  // pinned slot does NOT cascade to the other slot or the free pool. So with
  // Google pinned in slot_1 the run died on:
  //
  //    LLM rate limited (429): "You exceeded your current quota"
  //    — and no fallback LLM source matched after the failed source was
  //      excluded (speed: fast, json, forceLayer: byok, pinSlot: slot_1)
  //
  // while a perfectly good Qwen credential sat in slot_2 unused. That is the
  // pin behaving exactly as designed; the harness was pinning the wrong slot.
  //
  // ⚠ Google stays wired as slot_2 rather than being dropped. It is a REAL
  // second provider with a different context window, which is what makes the
  // long-conversation lane able to test context-window behaviour against
  // something other than the one model it normally runs.
  if (slot2) {
    process.env.RECUED_LLM_PROVIDER = slot2.provider;
    process.env.RECUED_LLM_MODEL = slot2.model;
    process.env.RECUED_LLM_API_KEY = slot2.api_key;
    process.env.RECUED_LLM_BASE_URL = slot2.base_url!;
    return {
      configured: true,
      detail: `${slot2.provider}/${slot2.model} (slot_1) + google/${model} (slot_2)`,
      slot: { ...slot2, speed: 'fast' },
      slot2: googleSlot,
    };
  }

  process.env.RECUED_LLM_PROVIDER = 'google';
  process.env.RECUED_LLM_MODEL = model;
  process.env.RECUED_LLM_API_KEY = apiKey;
  if (baseUrl) process.env.RECUED_LLM_BASE_URL = baseUrl;
  // ⚠ provider + model only in `detail`. Never the key.
  return {
    configured: true,
    detail: `google/${model} (slot_1, no second provider)`,
    slot: { ...googleSlot, speed: 'fast' },
  };
};

/** Ask the provider directly why a correctly-configured slot could not serve.
 *
 *  ⛔ WHY THIS EXISTS. The chat turn replaces every matcher failure with ONE
 *  message — "No AI model is available for your current model preference. Open
 *  Settings → AI / Models and choose a source" — which reads as "you have not
 *  configured a model". That is indistinguishable from the case where the slot
 *  is persisted, readable, key-bearing, and PINNED, and the provider is simply
 *  rate-limiting: a 429 puts the slot in cooldown (`availability.ts` →
 *  `quota.isInCooldown` → `available: false`), `collectCandidates` skips it,
 *  and a pinned slot excludes the free pool fail-closed, so the candidate set is
 *  empty for a reason that has nothing to do with configuration.
 *
 *  Without this the audit would have recorded "chat cannot route" as an
 *  unexplained subsystem failure. It is an exhausted external quota — an
 *  environment limit, in the same class as the missing DDNS binding, and NOT a
 *  finding against the server.
 *
 *  ⚠ Runs ONLY after a refusal, so a healthy run spends nothing. One request,
 *  same endpoint the server itself would call. The key is redacted out of any
 *  response text before it is returned. */
export const explainLlmRefusal = async (
  devEnvPath: string,
): Promise<string> => {
  if (!existsSync(devEnvPath)) return 'no dev.env to probe';
  const env = parseEnvFile(devEnvPath);
  const key = env.GOOGLE_API_KEY;
  // ⚠ MUST be the model the run actually CONFIGURED. A refusal probe aimed at a
  // different model answers a question nobody asked — and answers it
  // confidently.
  const model = env.GOOGLE_MODEL;
  if (!key || !model) return 'no credential to probe';
  const base = (env.GOOGLE_BASE_URL ?? 'https://generativelanguage.googleapis.com')
    .replace(/\/+$/, '');
  try {
    const res = await fetch(
      `${base}/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }] }),
      },
    );
    // ⛔ DO NOT SAY "THE CREDENTIAL WORKS". This probe sends a handful of
    // tokens; a chat turn sends a system prompt plus the whole tool catalog. A
    // free tier answers the first and 429s the second, so a 200 here rules out
    // exactly one thing — a dead or unauthorized key — and nothing else. The
    // earlier wording ("the refusal is SERVER-SIDE") sent this audit hunting a
    // matcher bug while the real failure was the provider's quota, visible
    // only in the turn's own detail string.
    if (res.ok) {
      return 'provider answers a MINIMAL request (HTTP 200) — the key is live, '
        + 'but this does NOT clear per-request or daily quota: a full turn '
        + 'sends orders of magnitude more tokens';
    }
    const text = (await res.text()).replaceAll(key, '<redacted>');
    const reason = res.status === 429
      ? 'provider quota EXHAUSTED (429) — the slot is in matcher cooldown, so a '
        + 'pinned-slot turn fail-closes with no candidates. Environment limit, '
        + 'not a server defect'
      : `provider HTTP ${res.status}`;
    return `${reason}: ${text.replace(/\s+/g, ' ').slice(0, 160)}`;
  } catch (err) {
    return `provider unreachable: ${err instanceof Error ? err.message : String(err)}`;
  }
};

/** Ask the provider whether it will actually answer, before the run leans on it.
 *
 *  ⛔ WHY THIS EXISTS. `configureLlmFromDevEnv` proves a credential is PRESENT;
 *  `readBackLlmConfig` proves the server PERSISTED it. Neither proves the model
 *  answers, and the gap between them is where a retired model hid for rounds —
 *  the refusal surfaced at the chat turn, far from its cause, and looked like a
 *  matcher bug.
 *
 *  One cheap completion per slot. Cost is a few tokens; the alternative is
 *  attributing a dead credential to the product.
 *
 *  ⚠ THE KEY IS NEVER LOGGED, never returned, and never included in a report —
 *  only provider, model, and the transport's verdict. */
export const preflightSlot = async (
  slot: LlmSlotSpec,
  timeoutMs = 20_000,
): Promise<{ ok: boolean; detail: string }> => {
  const label = `${slot.provider}/${slot.model}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const google = slot.provider === 'google';
    const base = slot.base_url ?? 'https://generativelanguage.googleapis.com';
    const url = google
      ? `${base}/v1beta/models/${slot.model}:generateContent`
      : `${base.replace(/\/$/, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'content-type': 'application/json',
        ...(google
          ? { 'x-goog-api-key': slot.api_key }
          : { authorization: `Bearer ${slot.api_key}` }),
      },
      body: JSON.stringify(
        google
          ? { contents: [{ parts: [{ text: 'ok' }] }] }
          : { model: slot.model, messages: [{ role: 'user', content: 'ok' }], max_tokens: 8 },
      ),
    });
    if (res.ok) return { ok: true, detail: `${label} answers` };
    // ⚠ Status ONLY. A provider error body can echo request material, and this
    // string is printed into the run report.
    const why = res.status === 404 ? 'model retired / unknown'
      : res.status === 429 ? 'quota exhausted'
      : res.status === 401 || res.status === 403 ? 'credential rejected'
      : `HTTP ${res.status}`;
    return { ok: false, detail: `${label} — ${why} (HTTP ${res.status})` };
  } catch (err) {
    const msg = err instanceof Error && err.name === 'AbortError'
      ? `no answer in ${timeoutMs}ms`
      : err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `${label} — ${msg}` };
  } finally {
    clearTimeout(timer);
  }
};
