/** D-163 — shared test helpers for the per-vendor `RemoteChannel`
 *  composer suites.
 *
 *  `composeSlackChannel` and `composeTelegramChannel` are thin shims
 *  over `composeRemoteChannel`. Their composer test files share four
 *  fixture builders that were near-identical before this consolidation
 *  slice: a plaintext-auth encoder, a connection-row factory, a
 *  connection-store stub, a key-manager stub, and a fetch stub. This
 *  module is the single source for those builders so a future shape
 *  change (new ConnectionRow field, KeyManagerState variant, fetch
 *  response envelope) lands in one place instead of two. */

import type {
  ConnectionAuth,
  ConnectionKind,
  ConnectionRow,
} from '@recued/contracts';
import { vi } from 'vitest';

import type { KeyManager, KeyManagerState } from '../key-manager.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';

/** Fixed deterministic instant used as `enrolled_at` / `updated_at` on
 *  every row this module builds. The exact value is not part of any
 *  test assertion — it is a stable timestamp so test failures don't
 *  drift with `Date.now()`. */
export const TEST_NOW = Date.parse('2026-05-27T12:00:00.000Z');

/** Encode a `ConnectionAuth` for the plaintext fallback path — matches
 *  `encodeAuthForStorage` when called with no key provider. The
 *  composer's `decodeAuthFromStorage` reads this back without a key
 *  provider on the plaintext branch. */
export const encodePlaintextAuth = (auth: ConnectionAuth): string =>
  Buffer.from(JSON.stringify(auth), 'utf8').toString('base64');

export interface BuildConnectionRowOverrides {
  auth: ConnectionAuth;
  config: Record<string, unknown>;
  /** Defaults to `'slack'`; callers override for telegram / others. */
  name?: string;
  /** Defaults to `'notification'`; callers override to test kind-
   *  mismatch branches. */
  kind?: ConnectionKind;
}

/** Build a `ConnectionRow` ready to drop into `stubConnectionStore`.
 *  The composer suites pass `auth` + `config` per scenario; `name` and
 *  `kind` only need overrides for the cross-kind mismatch tests. */
export const buildConnectionRow = (
  overrides: BuildConnectionRowOverrides,
): ConnectionRow => ({
  pk: `${overrides.kind ?? 'notification'}:${overrides.name ?? 'slack'}`,
  kind: overrides.kind ?? 'notification',
  name: overrides.name ?? 'slack',
  display_name: overrides.name ?? 'slack',
  config_json: JSON.stringify(overrides.config),
  auth_ciphertext: encodePlaintextAuth(overrides.auth),
  enrolled_at: TEST_NOW,
  updated_at: TEST_NOW,
});

/** Minimal `ConnectionStoreSqlite` stub exposing only `get` — the
 *  composer's only touch surface. Returns the supplied row only when
 *  the (kind, name) lookup matches exactly. */
export const stubConnectionStore = (
  row: ConnectionRow | null,
): ConnectionStoreSqlite =>
  ({
    get: vi.fn((kind: ConnectionKind, name: string) =>
      row !== null && row.kind === kind && row.name === name ? row : null,
    ),
  }) as unknown as ConnectionStoreSqlite;

/** Configurable KeyManager stub. `state()` flips via `setState(next)`
 *  so a single channel observes a mid-process transition (the
 *  transparent-unlock invariant). `keyProvider` is a `vi.fn` so tests
 *  can assert call args (`'connection'`) and call counts. */
export interface StubKeyManager extends KeyManager {
  setState(next: KeyManagerState): void;
}

export const stubKeyManager = (initial: KeyManagerState): StubKeyManager => {
  let state = initial;
  return {
    state: () => state,
    keyProvider: vi.fn(() => () => null),
    setState(next: KeyManagerState) {
      state = next;
    },
  } as unknown as StubKeyManager;
};

/** A key manager whose provider behaves like the real one
 *  (`key-manager.ts` `keyProvider`): the closure re-reads state on EVERY call
 *  and yields the key only while unlocked. `stubKeyManager`'s provider is
 *  always null, so it cannot show an unlock landing on a live channel. */
export const liveKeyManager = (initial: KeyManagerState, key: Uint8Array): StubKeyManager => {
  let state = initial;
  return {
    state: () => state,
    keyProvider: vi.fn(() => () => (state === 'unlocked' ? key : null)),
    setState(next: KeyManagerState) {
      state = next;
    },
  } as unknown as StubKeyManager;
};

export interface FetchStub {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  calls: Array<{ url: string; init: RequestInit }>;
}

/** fetch stub that captures every call + lets the test drive the
 *  response. The default response body is generic OK JSON; per-vendor
 *  composer tests pass a vendor-shaped envelope (e.g. Slack
 *  `chat.postMessage`'s `{ok: true, ts: '...'}` or Telegram
 *  `sendMessage`'s `{ok: true, result: {message_id: 42}}`). */
export const stubFetch = (
  responseBody: Record<string, unknown> = { ok: true },
): FetchStub => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return Object.assign(fn as unknown as FetchStub, { calls });
};
