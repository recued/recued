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
 *  It expires after 15 minutes (configurable). Once paired, the
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
}

export interface PairingConfig {
  /** Code lifetime in ms. Default: 15 minutes. */
  codeTtlMs?: number;
  /** Length of the pairing code. Default: 8. */
  codeLength?: number;
  /** The realm token to issue on successful pairing.
   *  Auto-generated if not provided. */
  realmToken?: string;
  now?: () => number;
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

const DEFAULT_TTL = 15 * 60_000; // 15 minutes
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
  const ttl = config.codeTtlMs ?? DEFAULT_TTL;
  const codeLength = config.codeLength ?? DEFAULT_CODE_LENGTH;
  const now = config.now ?? Date.now;
  const realmToken = config.realmToken ?? generateRealmToken();

  let state: PairingState = generateState();

  function generateState(): PairingState {
    const created_at = now();
    return {
      code: generateCode(codeLength),
      created_at,
      expires_at: created_at + ttl,
      consumed: false,
    };
  }

  return {
    getCode() {
      if (state.consumed) return null;
      if (now() > state.expires_at) return null;
      return state.code;
    },

    refreshCode() {
      state = generateState();
      return state.code;
    },

    getRealmToken() {
      return realmToken;
    },

    checkCode(code) {
      if (state.consumed) return false;
      if (now() > state.expires_at) return false;
      return codesMatch(code, state.code);
    },

    pair(code) {
      if (state.consumed) return null;
      if (now() > state.expires_at) return null;
      if (!codesMatch(code, state.code)) return null;
      state.consumed = true;
      return realmToken;
    },

    timeRemaining() {
      if (state.consumed) return 0;
      return Math.max(0, state.expires_at - now());
    },
  };
};
