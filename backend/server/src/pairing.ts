/** Extension ↔ Server pairing flow.
 *
 *  1. Server generates a short-lived pairing code on startup
 *  2. User enters the server URL + code in the extension
 *  3. Client POSTs to /auth/pair with the code + client kind
 *  4. Server verifies → returns a durable client_tokens credential
 *     (`token_id`, `bearer`) when that store is wired, with the
 *     legacy realm token retained only for db-less compositions
 *  5. Client stores `token_id` + bearer → auto-connects
 *
 *  The pairing code is displayed in the server's terminal banner.
 *  It expires after 15 minutes by default — `RECUED_PAIR_CODE_TTL_MS`
 *  widens that for a review/demo deployment (see `resolveDefaultTtl`).
 *  Once paired, the
 *  extension uses the realm token for all subsequent requests.
 */

import { timingSafeEqual } from 'node:crypto';
import { generateInstanceId } from '@recued/instances';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface PairingState {
  /** The short code displayed to the user. */
  code: string;
  /** When the code was generated. */
  created_at: number;
  /** When the code expires. */
  expires_at: number;
  /** Set to true after a successful pairing to prevent reuse. */
  consumed: boolean;
  /** ⛔ THE TTL TRAVELS WITH THE STATE, OR A REFRESH SILENTLY SHORTENS IT.
   *
   *  `--pair-code-ttl 7d` is a flag on `serve`, so it lives in the SERVER
   *  process's environment. `recued pair` is a different process and inherits
   *  none of it — without this field a refresh on a 7-day server would mint a
   *  15-minute code, and the operator would have no way to tell until a
   *  reviewer failed to pair days later. Recording the TTL that minted a state
   *  lets the next refresh inherit it wherever it runs from. */
  ttl_ms?: number;
}

export interface PairingConfig {
  /** Code lifetime in ms. Default: 15 minutes. */
  codeTtlMs?: number;
  /** Length of the pairing code. Default: 8. */
  codeLength?: number;
  /** ⛔ WITHOUT THIS THE CODE IS PER-PROCESS, AND `recued pair` IS A NO-OP.
   *
   *  The state below is closure-local. The RUNNING server's manager is the one
   *  `/auth/pair` verifies against, so a `recued pair` in its own short-lived
   *  process was minting a code the server had never heard of and would reject:
   *  a correct-looking code that fails at the door, with nothing on either side
   *  saying why. There was also no way at all to replace a burnt or expired code
   *  on a live server — `refreshCode` had exactly one caller, that same useless
   *  CLI, and no rpc exposed it.
   *
   *  Persisting the state to `server_config` makes both processes share ONE
   *  code, which fixes `recued pair` and turns it into the refresh path.
   *
   *  ⚠ Why this is not a new secret at rest: `server_config` already holds
   *  `realm_token`, a long-lived bearer. A pairing code is short-lived and
   *  single-use, and anyone who can read this table can already read the token
   *  and the warehouse beside it. The alternative — a loopback-gated refresh
   *  endpoint — is WORSE here: behind a tunnel that terminates locally (the
   *  Cloudflare Tunnel posture we recommend for demo servers) every remote
   *  request presents as loopback, so the gate would admit the internet.
   *
   *  Absent (tests / dbless) the manager stays in-memory, exactly as before. */
  store?: PairingStateStore;
  /** The realm token to issue on successful pairing.
   *  Auto-generated if not provided. */
  realmToken?: string;
  now?: () => number;
}

/** Persistence seam for {@link PairingState}. Implemented over `server_config`
 *  by the compositions that hold a database; omitted where there is none. */
export interface PairingStateStore {
  read(): PairingState | null;
  write(state: PairingState): void;
}

export interface PairingManager {
  /** The current pairing code (or null if expired/consumed). */
  getCode(): string | null;
  /** Generate a fresh pairing code. Replaces any existing one. */
  refreshCode(): string;
  /** Legacy realm token returned by db-less /auth/pair compositions. */
  getRealmToken(): string;
  /** Verify a code WITHOUT consuming it. The pre-gate for `/auth/pair`:
   *  the recovery-key work that follows has durable side effects (realm
   *  sentinel, vault bundle, database rekey), so the code must be proven
   *  before any of it runs. Consumption stays with `pair()` at the act
   *  site, so a mistyped recovery key rejects without burning the code. */
  checkCode(code: string): boolean;
  /** Verify a code and consume it. Returns the legacy realm token on
   *  success, or null when the code is wrong, expired, or already
   *  consumed. */
  pair(code: string): string | null;
  /** Time remaining on the current code in ms. 0 if expired. */
  timeRemaining(): number;
}

// ────────────────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────────────────

const BUILT_IN_TTL = 15 * 60_000; // 15 minutes

/** ⛔ 15 MINUTES IS FINE FOR A HUMAN AT THE TERMINAL AND USELESS FOR AN
 *  ASYNCHRONOUS REVIEWER.
 *
 *  A pairing code is single-use AND short-lived, which is the right posture for
 *  the normal flow: the owner runs `recued pair`, reads the code off the banner,
 *  and types it seconds later. A Chrome Web Store reviewer opens the submission
 *  hours or days after it is filed — by then the code in the dashboard notes has
 *  long expired, they cannot pair, and the extension is rejected as untestable.
 *
 *  `recued serve --pair-code-ttl 7d` (or `RECUED_PAIR_CODE_TTL_MS`) widens the
 *  window for exactly that deployment. Accepts `ms|s|m|h|d`, bare digits = ms.
 *
 *  ⛔ THE FLAG BELONGS ON `serve`, NOT ON `pair`. The code is closure state
 *  (`let state: PairingState`), never persisted — the RUNNING server's manager is
 *  the one `/auth/pair` verifies against. `recued pair` mints a code in its own
 *  short-lived process that the running server has never heard of, so a `--ttl`
 *  there would print "TTL 7 days" and hand out a code the door rejects: right
 *  label, dead code. Resolved HERE so both call sites funnel through one point.
 *
 *  ⚠ The code stays SINGLE-USE regardless — this lengthens the window, it does
 *  not make the code reusable. Only ever set it on a disposable server holding
 *  synthetic data; on a real one it widens the window for guessing a live code.
 *  An unset, malformed, zero, or negative value falls back to the 15-minute
 *  default rather than failing a boot over a typo'd env var. */
export const parsePairCodeTtl = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw.trim() === '') return undefined;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(raw.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = m[2] ?? 'ms';
  const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1;
  return n * scale;
};

const resolveDefaultTtl = (): number =>
  parsePairCodeTtl(process.env.RECUED_PAIR_CODE_TTL_MS) ?? BUILT_IN_TTL;
const DEFAULT_CODE_LENGTH = 8;

/** Generate a short alphanumeric code (uppercase, no ambiguous chars). */
const generateCode = (length: number): string => {
  // Exclude 0/O/I/1 to avoid visual ambiguity
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => chars[b % chars.length]).join('');
};

/** Generate a long-lived realm token (UUID-based). */
const generateRealmToken = (): string =>
  `realm-${generateInstanceId()}`;

/** Constant-time pairing-code compare. The supplied code is uppercased
 *  (the generated alphabet is already uppercase) and matched against the
 *  active code without an early-out per character. The length check is a
 *  non-secret (the code length is fixed + public); equal-length inputs
 *  go through `timingSafeEqual`. */
const codesMatch = (input: string, expected: string): boolean => {
  const a = Buffer.from(input.toUpperCase(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

export const createPairingManager = (config: PairingConfig = {}): PairingManager => {
  // Resolution ladder, most specific first: an explicit flag on THIS
  // invocation, then the TTL the live state was minted with (so a refresh from
  // another process inherits the server's configured window), then the env, then
  // the built-in default.
  const persistedTtl = (() => {
    try {
      const v = config.store?.read()?.ttl_ms;
      return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
    } catch { return undefined; }
  })();
  const ttl = config.codeTtlMs ?? persistedTtl ?? resolveDefaultTtl();
  const codeLength = config.codeLength ?? DEFAULT_CODE_LENGTH;
  const now = config.now ?? Date.now;
  const realmToken = config.realmToken ?? generateRealmToken();

  // Load a persisted code if one is there, so a server and a `recued pair` in
  // another process agree on which code is live. A malformed / absent row mints
  // a fresh state rather than failing a boot.
  const persisted = (() => {
    try { return config.store?.read() ?? null; } catch { return null; }
  })();
  let state: PairingState = persisted ?? generateState();
  if (!persisted) persist(state);

  function persist(next: PairingState): void {
    try { config.store?.write(next); } catch { /* best effort — never fail a boot on this */ }
  }

  /** Re-read before every decision. The other process may have refreshed or
   *  consumed the code since this manager last looked; trusting the local copy
   *  is what made the two processes disagree in the first place. */
  function current(): PairingState {
    try {
      const fresh = config.store?.read();
      if (fresh) state = fresh;
    } catch { /* fall back to the in-memory copy */ }
    return state;
  }

  function generateState(): PairingState {
    const created_at = now();
    return {
      code: generateCode(codeLength),
      created_at,
      expires_at: created_at + ttl,
      consumed: false,
      ttl_ms: ttl,
    };
  }

  return {
    getCode() {
      const s = current();
      if (s.consumed) return null;
      if (now() > s.expires_at) return null;
      return s.code;
    },

    refreshCode() {
      state = generateState();
      persist(state);
      return state.code;
    },

    getRealmToken() {
      return realmToken;
    },

    checkCode(code) {
      const s = current();
      if (s.consumed) return false;
      if (now() > s.expires_at) return false;
      return codesMatch(code, s.code);
    },

    pair(code) {
      // Re-read first: another process may have refreshed the code since this
      // manager last looked, and consuming a stale one would burn a code nobody
      // holds while leaving the live one usable.
      const s = current();
      if (s.consumed) return null;
      if (now() > s.expires_at) return null;
      if (!codesMatch(code, s.code)) return null;
      state = { ...s, consumed: true };
      persist(state);
      return realmToken;
    },

    timeRemaining() {
      const s = current();
      if (s.consumed) return 0;
      return Math.max(0, s.expires_at - now());
    },
  };
};
