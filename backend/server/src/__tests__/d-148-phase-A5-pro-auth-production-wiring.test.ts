/** D-148 § A.5.3 / § A.6.5 — Pro auth production-wiring acceptance.
 *
 *  Covers the artefacts added by the 102nd slice:
 *
 *    - `createSqliteProAuthStore` — round-trips `ProAuthState` JSON
 *      through the `server_config` singleton row + restores on reload +
 *      deletes on sign-out + treats corrupted blobs as `null`.
 *    - `createProAuthStateMachine` — authenticate / signOut / current
 *      semantics + `onStateChanged` listener firing per persist.
 *    - `pro.*` rpc handlers — assertion of bearer validation, register-
 *      gate, display-only `current()` projection, and `not_configured`
 *      fall-through when deps are absent.
 *    - Closed-list `PRO_AUTH_RPC_ERROR_CODES` ratchet — exhaustive
 *      `Record<ProAuthRpcErrorCode, true>` sentinel forces future codes
 *      to extend the array.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  PRO_AUTH_RPC_ERROR_CODES,
  PRO_AUTH_TOKEN_MAX_BYTES,
  PRO_AUTH_TOKEN_MIN_BYTES,
  RpcError,
  type ProAuthRpcErrorCode,
} from '@recued/contracts';
import {
  createProAuthStateMachine,
  createInMemoryProAuthStore,
  type ProAuthState,
} from '../pro-auth/index.js';
import {
  createSqliteProAuthStore,
  PRO_AUTH_STATE_CONFIG_KEY,
} from '../pro-auth/sqlite-store.js';
import {
  handleProAuthenticate,
  handleProCurrent,
  handleProSignOut,
  makeProAuthHandlers,
} from '../pro-auth/handler.js';
import type { WsClient } from '../ws-server.js';

const seedDb = (): Database.Database => {
  const db = new Database(':memory:');
  db.exec(
    `CREATE TABLE IF NOT EXISTS server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  );
  return db;
};

// Sample bearer ≥ PRO_AUTH_TOKEN_MIN_BYTES (16) so the rpc test cases
// pass the lower-bound gate. The state-machine + store tests don't
// gate on length (the cloud helper validates contents), but using a
// realistic-shape token keeps the assertions readable.
const SAMPLE_TOKEN = 'pro_tok_test_abcdef1234';

const sampleState: ProAuthState = {
  pro_subscription_token: SAMPLE_TOKEN,
  authenticated_at: 1_700_000_000_000,
};

const registeredCtx = (): WsClient =>
  ({ instance_id: 'i_test', user_id: 'u_test' }) as unknown as WsClient;

const unregisteredCtx = (): WsClient =>
  ({ instance_id: null, user_id: null }) as unknown as WsClient;

// ────────────────────────────────────────────────────────────────
// SQLite store
// ────────────────────────────────────────────────────────────────

describe('createSqliteProAuthStore', () => {
  it('returns null when no row is present', async () => {
    const db = seedDb();
    const store = createSqliteProAuthStore({ db });
    expect(await store.load()).toBeNull();
  });

  it('round-trips a ProAuthState through save/load', async () => {
    const db = seedDb();
    const store = createSqliteProAuthStore({ db });
    await store.save(sampleState);
    expect(await store.load()).toEqual(sampleState);
  });

  it('overwrites an existing row on save (single-slot)', async () => {
    const db = seedDb();
    const store = createSqliteProAuthStore({ db });
    await store.save(sampleState);
    const next: ProAuthState = {
      pro_subscription_token: 'pro_tok_replacement_xyz',
      authenticated_at: 1_700_000_001_000,
    };
    await store.save(next);
    const loaded = await store.load();
    expect(loaded).toEqual(next);
  });

  it('delete() removes the row + load() returns null afterwards', async () => {
    const db = seedDb();
    const store = createSqliteProAuthStore({ db });
    await store.save(sampleState);
    expect(await store.load()).not.toBeNull();
    await store.delete();
    expect(await store.load()).toBeNull();
  });

  it('survives reload across fresh store instances on the same db', async () => {
    const db = seedDb();
    const writer = createSqliteProAuthStore({ db });
    await writer.save(sampleState);
    const reader = createSqliteProAuthStore({ db });
    expect(await reader.load()).toEqual(sampleState);
  });

  it('treats a corrupted JSON blob as null (graceful boot)', async () => {
    const db = seedDb();
    db.prepare(`INSERT INTO server_config (key, value) VALUES (?, ?)`).run(
      PRO_AUTH_STATE_CONFIG_KEY,
      '{this is not json',
    );
    const store = createSqliteProAuthStore({ db });
    expect(await store.load()).toBeNull();
  });

  it('treats a structurally invalid blob as null (missing fields)', async () => {
    const db = seedDb();
    db.prepare(`INSERT INTO server_config (key, value) VALUES (?, ?)`).run(
      PRO_AUTH_STATE_CONFIG_KEY,
      JSON.stringify({ pro_subscription_token: 'tok', authenticated_at: 'not-a-number' }),
    );
    const store = createSqliteProAuthStore({ db });
    expect(await store.load()).toBeNull();
  });

  it('treats an empty-token blob as null (single-slot invariant)', async () => {
    const db = seedDb();
    db.prepare(`INSERT INTO server_config (key, value) VALUES (?, ?)`).run(
      PRO_AUTH_STATE_CONFIG_KEY,
      JSON.stringify({ pro_subscription_token: '', authenticated_at: 1 }),
    );
    const store = createSqliteProAuthStore({ db });
    expect(await store.load()).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// State machine
// ────────────────────────────────────────────────────────────────

describe('createProAuthStateMachine', () => {
  it('current() returns null when no state persisted', async () => {
    const machine = createProAuthStateMachine({
      store: createInMemoryProAuthStore(),
    });
    expect(await machine.current()).toBeNull();
  });

  it('current() rehydrates from a pre-seeded store', async () => {
    const machine = createProAuthStateMachine({
      store: createInMemoryProAuthStore(sampleState),
    });
    expect(await machine.current()).toEqual(sampleState);
  });

  it('authenticate() persists + fires onStateChanged with the new snapshot', async () => {
    let fired: ProAuthState | null | undefined;
    const machine = createProAuthStateMachine({
      store: createInMemoryProAuthStore(),
      clock: () => 1_700_000_123_456,
      onStateChanged: (state) => {
        fired = state;
      },
    });
    const result = await machine.authenticate({
      pro_subscription_token: 'pro_tok_state_machine_a',
    });
    expect(result).toEqual({
      pro_subscription_token: 'pro_tok_state_machine_a',
      authenticated_at: 1_700_000_123_456,
    });
    expect(fired).toEqual(result);
    expect(await machine.current()).toEqual(result);
  });

  it('signOut() clears the slot + fires onStateChanged with null', async () => {
    const events: Array<ProAuthState | null> = [];
    const machine = createProAuthStateMachine({
      store: createInMemoryProAuthStore(sampleState),
      onStateChanged: (state) => {
        events.push(state);
      },
    });
    await machine.signOut();
    expect(events).toEqual([null]);
    expect(await machine.current()).toBeNull();
  });

  it('authenticate() replaces a prior slot atomically (single-slot)', async () => {
    let clock = 1_000;
    const machine = createProAuthStateMachine({
      store: createInMemoryProAuthStore(),
      clock: () => clock,
    });
    const tokenA = 'pro_tok_slot_aaaaaaaaaa';
    const tokenB = 'pro_tok_slot_bbbbbbbbbb';
    await machine.authenticate({ pro_subscription_token: tokenA });
    clock = 2_000;
    const second = await machine.authenticate({ pro_subscription_token: tokenB });
    expect(second.pro_subscription_token).toBe(tokenB);
    expect(second.authenticated_at).toBe(2_000);
    expect((await machine.current())?.pro_subscription_token).toBe(tokenB);
  });

  it('swallows onStateChanged listener errors so the mutation completes', async () => {
    const machine = createProAuthStateMachine({
      store: createInMemoryProAuthStore(),
      onStateChanged: () => {
        throw new Error('listener bug');
      },
    });
    const token = 'pro_tok_listener_test_y';
    const result = await machine.authenticate({ pro_subscription_token: token });
    expect(result.pro_subscription_token).toBe(token);
    expect(await machine.current()).toEqual(result);
  });

  it('persists across boot via the SQLite store backend', async () => {
    const db = seedDb();
    const firstMachine = createProAuthStateMachine({
      store: createSqliteProAuthStore({ db }),
    });
    const token = 'pro_tok_persist_across_boot';
    await firstMachine.authenticate({ pro_subscription_token: token });

    // Simulate a fresh boot — new state machine over the same db.
    const secondMachine = createProAuthStateMachine({
      store: createSqliteProAuthStore({ db }),
    });
    const restored = await secondMachine.current();
    expect(restored?.pro_subscription_token).toBe(token);
  });
});

// ────────────────────────────────────────────────────────────────
// rpc handlers
// ────────────────────────────────────────────────────────────────

describe('pro.* rpc handlers', () => {
  const buildMachine = (initial?: ProAuthState) =>
    createProAuthStateMachine({
      store: createInMemoryProAuthStore(initial),
      clock: () => 1_700_000_321_654,
    });

  it('authenticate persists + returns authenticated_at', async () => {
    const machine = buildMachine();
    const token = 'pro_tok_rpc_persist_test';
    const response = await handleProAuthenticate(
      { machine },
      { pro_subscription_token: token },
      registeredCtx(),
    );
    expect(response.authenticated).toBe(true);
    expect(response.authenticated_at).toBe(1_700_000_321_654);
    expect((await machine.current())?.pro_subscription_token).toBe(token);
  });

  it('authenticate rejects unregistered callers with forbidden', async () => {
    const machine = buildMachine();
    await expect(
      handleProAuthenticate(
        { machine },
        { pro_subscription_token: 'pro_tok_rpc_forbidden_test' },
        unregisteredCtx(),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('authenticate rejects non-string + too-short + oversize tokens', async () => {
    const machine = buildMachine();
    await expect(
      handleProAuthenticate(
        { machine },
        { pro_subscription_token: 42 as unknown as string },
        registeredCtx(),
      ),
    ).rejects.toBeInstanceOf(RpcError);
    // Empty + short tokens fall below PRO_AUTH_TOKEN_MIN_BYTES and are
    // rejected — see "Codex P2 fold" below. The display-only
    // `token_suffix` (last 4 chars) must reveal ≤ 25% of the bearer.
    await expect(
      handleProAuthenticate(
        { machine },
        { pro_subscription_token: '' },
        registeredCtx(),
      ),
    ).rejects.toBeInstanceOf(RpcError);
    await expect(
      handleProAuthenticate(
        { machine },
        { pro_subscription_token: 'x'.repeat(PRO_AUTH_TOKEN_MAX_BYTES + 1) },
        registeredCtx(),
      ),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('Codex P2 fold — rejects tokens below PRO_AUTH_TOKEN_MIN_BYTES', async () => {
    const machine = buildMachine();
    // Exactly one byte short of the floor — the suffix slicer would
    // expose at minimum 25% + 1 char of the bearer.
    const justUnder = 'x'.repeat(PRO_AUTH_TOKEN_MIN_BYTES - 1);
    await expect(
      handleProAuthenticate(
        { machine },
        { pro_subscription_token: justUnder },
        registeredCtx(),
      ),
    ).rejects.toBeInstanceOf(RpcError);
    // Exactly at the floor — accepted; the 4-char suffix reveals
    // exactly 25% which is the design cap.
    const atFloor = 'a'.repeat(PRO_AUTH_TOKEN_MIN_BYTES);
    const ok = await handleProAuthenticate(
      { machine },
      { pro_subscription_token: atFloor },
      registeredCtx(),
    );
    expect(ok.authenticated).toBe(true);
  });

  it('signOut clears the slot', async () => {
    const machine = buildMachine(sampleState);
    const response = await handleProSignOut({ machine }, {}, registeredCtx());
    expect(response.authenticated).toBe(false);
    expect(await machine.current()).toBeNull();
  });

  it('signOut rejects unregistered callers', async () => {
    const machine = buildMachine(sampleState);
    await expect(
      handleProSignOut({ machine }, {}, unregisteredCtx()),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('current returns authenticated:false when no slot', async () => {
    const machine = buildMachine();
    const response = await handleProCurrent({ machine }, {}, registeredCtx());
    expect(response).toEqual({ authenticated: false });
  });

  it('current returns token_suffix + authenticated_at when authenticated', async () => {
    const machine = buildMachine(sampleState);
    const response = await handleProCurrent({ machine }, {}, registeredCtx());
    expect(response).toEqual({
      authenticated: true,
      token_suffix: SAMPLE_TOKEN.slice(-4),
      authenticated_at: sampleState.authenticated_at,
    });
  });

  it('current never leaks the full bearer in the response', async () => {
    const machine = buildMachine(sampleState);
    const response = await handleProCurrent({ machine }, {}, registeredCtx());
    expect(JSON.stringify(response)).not.toContain(SAMPLE_TOKEN);
  });

  it('makeProAuthHandlers returns undefined when deps absent (drops the slice)', () => {
    expect(makeProAuthHandlers(undefined)).toBeUndefined();
  });

  it('makeProAuthHandlers wires three methods when deps present', () => {
    const machine = buildMachine();
    const slice = makeProAuthHandlers({ machine });
    expect(slice).toBeDefined();
    expect(slice?.methods).toEqual([
      'pro.authenticate',
      'pro.signOut',
      'pro.current',
    ]);
  });
});

// ────────────────────────────────────────────────────────────────
// Contract ratchet
// ────────────────────────────────────────────────────────────────

describe('PRO_AUTH_RPC_ERROR_CODES ratchet', () => {
  it('array membership equals the union (every code is present)', () => {
    // Compile-time exhaustiveness: any new union member without an
    // array entry breaks the Record initializer below.
    const sentinel: Record<ProAuthRpcErrorCode, true> = {
      pro_auth_token_invalid: true,
      pro_auth_not_authenticated: true,
    };
    for (const code of PRO_AUTH_RPC_ERROR_CODES) {
      expect(sentinel[code]).toBe(true);
    }
    expect(Object.keys(sentinel).length).toBe(PRO_AUTH_RPC_ERROR_CODES.length);
  });
});
