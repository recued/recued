/** D-148 § A.5.6 — handle state machine production-wiring acceptance.
 *
 *  Covers the three artefacts added by the 101st slice:
 *
 *    - `createSqliteHandleStateStore` — round-trips `HandleState` JSON
 *      through the `server_config` singleton row + restores on reload.
 *    - `createRecuedCloudHandleClient` — POSTs canonical-JSON to the
 *      four `/v1/ddns/handle/*` endpoints + decodes the shared
 *      `{ data | error }` envelope into `CloudHandleResult`.
 *    - `onStateChanged` listener on the substrate factory — fires
 *      synchronously after every persist + lets bin.ts mirror
 *      `publisher_id` into the synchronous `PublisherIdResolver` ref the
 *      ACME factory reads per renewal cycle.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  HANDLE_RPC_ERROR_CODES,
  type HandleAbuseReportRequest,
  type HandleAbuseReportResponse,
  type HandleChangeRequest,
  type HandleChangeResponse,
  type HandleReserveRequest,
  type HandleReserveResponse,
  type HandleRpcErrorCode,
  type HandleTransferRequest,
  type HandleTransferResponse,
} from '@recued/contracts';
import {
  createHandleStateMachine,
  type HandleState,
  type CloudHandleClient,
  type HandleAuditEmitter,
  type HandleBroadcaster,
} from '../handle/index.js';
import {
  createSqliteHandleStateStore,
  HANDLE_STATE_CONFIG_KEY,
} from '../handle/sqlite-store.js';
import { createRecuedCloudHandleClient } from '../handle/recued-cloud-client.js';
import { generateEd25519Keypair } from '../keys/index.js';

const seedDb = (): Database.Database => {
  const db = new Database(':memory:');
  db.exec(
    `CREATE TABLE IF NOT EXISTS server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  );
  return db;
};

const sampleState: HandleState = {
  publisher_id: 'pub_test_01',
  current_handle: 'alice',
  handle_history: [
    {
      handle: 'alice',
      reserved_at: 1_700_000_000_000,
      reason: 'reserved',
    },
  ],
  subscription_state: 'active',
  last_synced_at: 1_700_000_000_000,
};

// ────────────────────────────────────────────────────────────────
// SQLite store
// ────────────────────────────────────────────────────────────────

describe('createSqliteHandleStateStore', () => {
  it('returns null when no row is present', async () => {
    const db = seedDb();
    const store = createSqliteHandleStateStore({ db });
    expect(await store.load()).toBeNull();
  });

  it('round-trips a HandleState through save/load', async () => {
    const db = seedDb();
    const store = createSqliteHandleStateStore({ db });
    await store.save(sampleState);
    const loaded = await store.load();
    expect(loaded).toEqual(sampleState);
  });

  it('overwrites an existing row on save', async () => {
    const db = seedDb();
    const store = createSqliteHandleStateStore({ db });
    await store.save(sampleState);
    const updated: HandleState = {
      ...sampleState,
      current_handle: 'bob',
      handle_history: [
        ...sampleState.handle_history,
        { handle: 'bob', reserved_at: 1_700_000_001_000, reason: 'changed' },
      ],
    };
    await store.save(updated);
    const loaded = await store.load();
    expect(loaded?.current_handle).toBe('bob');
    expect(loaded?.handle_history).toHaveLength(2);
  });

  it('survives reload across fresh store instances on the same db', async () => {
    const db = seedDb();
    const writer = createSqliteHandleStateStore({ db });
    await writer.save(sampleState);
    const reader = createSqliteHandleStateStore({ db });
    expect(await reader.load()).toEqual(sampleState);
  });

  it('treats a corrupted blob as null (graceful boot)', async () => {
    const db = seedDb();
    db.prepare(`INSERT INTO server_config (key, value) VALUES (?, ?)`).run(
      HANDLE_STATE_CONFIG_KEY,
      '{this is not json',
    );
    const store = createSqliteHandleStateStore({ db });
    expect(await store.load()).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// HTTP cloud client
// ────────────────────────────────────────────────────────────────

describe('createRecuedCloudHandleClient', () => {
  const cloud_base_url = 'https://cloud.test';

  const okResponse = <T>(data: T): Response =>
    new Response(JSON.stringify({ data, meta: { request_id: 'r1' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  const errResponse = (status: number, code: string, message: string): Response =>
    new Response(
      JSON.stringify({ error: { code, message }, meta: { request_id: 'r1' } }),
      { status, headers: { 'Content-Type': 'application/json' } },
    );

  it('POSTs reserve to /v1/ddns/handle/reserve + decodes ok envelope', async () => {
    const calls: Array<{ url: string; body: HandleReserveRequest }> = [];
    const fetchFake: typeof fetch = async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse((init as RequestInit).body as string),
      });
      const data: HandleReserveResponse = {
        reserved_at: 100,
        handle: 'alice',
        state: 'active',
      };
      return okResponse(data);
    };
    const client = createRecuedCloudHandleClient({ cloud_base_url, fetch: fetchFake });
    const result = await client.reserveHandle({
      publisher_id: 'pub_1',
      handle: 'alice',
      nonce: 'n',
      signature: 's',
      timestamp: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.handle).toBe('alice');
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://cloud.test/v1/ddns/handle/reserve');
    expect(calls[0]!.body.handle).toBe('alice');
  });

  it('maps a HandleRpcErrorCode from the error envelope', async () => {
    const fetchFake: typeof fetch = async () =>
      errResponse(409, 'handle_taken', 'already reserved');
    const client = createRecuedCloudHandleClient({ cloud_base_url, fetch: fetchFake });
    const result = await client.reserveHandle({
      publisher_id: 'pub_1',
      handle: 'taken',
      nonce: 'n',
      signature: 's',
      timestamp: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('handle_taken');
      expect(result.message).toBe('already reserved');
    }
  });

  it('collapses unknown error codes to handle_validation_error with the raw message', async () => {
    const fetchFake: typeof fetch = async () =>
      errResponse(500, 'SERVER_ERROR', 'database unreachable');
    const client = createRecuedCloudHandleClient({ cloud_base_url, fetch: fetchFake });
    const result = await client.changeHandle({
      publisher_id: 'pub_1',
      current_handle: 'a',
      new_handle: 'b',
      nonce: 'n',
      signature: 's',
      timestamp: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('handle_validation_error');
      expect(result.message).toContain('HTTP 500');
      expect(result.message).toContain('SERVER_ERROR');
    }
  });

  /** ⛔⛔ THE CASE THAT MAKES REMOVING `handle_subscription_lapsed` SAFE. It was a member
   *  of `HandleRpcErrorCode` until 2026-08-30, when the handle endpoints' Pro gate was
   *  lifted and the cloud stopped emitting it. Keeping a literal for a refusal the system
   *  can no longer make would advertise a policy that does not exist — but removing it is
   *  only safe if an owner still sees WHAT THE CLOUD SAID. They do: the raw code and
   *  message survive in the text, so the information is preserved while the typed
   *  vocabulary stays truthful. Pinned here rather than argued in a comment. */
  it('⛔ A RETIRED CODE STILL REACHES THE OWNER VERBATIM, it is not swallowed', async () => {
    const fetchFake: typeof fetch = async () =>
      errResponse(402, 'handle_subscription_lapsed', 'Pro subscription required');
    const client = createRecuedCloudHandleClient({ cloud_base_url, fetch: fetchFake });
    const result = await client.reserveHandle({
      publisher_id: 'pub_1', handle: 'a', nonce: 'n', signature: 's', timestamp: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Typed as a generic validation failure — no code implying a Pro gate…
      expect(result.error).toBe('handle_validation_error');
      // …and every word the cloud actually said is still in front of the owner.
      expect(result.message).toContain('402');
      expect(result.message).toContain('handle_subscription_lapsed');
      expect(result.message).toContain('Pro subscription required');
    }
  });

  it('reports network failures via handle_validation_error', async () => {
    const fetchFake: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const client = createRecuedCloudHandleClient({ cloud_base_url, fetch: fetchFake });
    const result = await client.transferHandle({
      outgoing_publisher_id: 'pub_a',
      incoming_publisher_id: 'pub_b',
      handle: 'alice',
      nonce: 'n',
      outgoing_signature: 'os',
      incoming_signature: 'is',
      timestamp: 1,
    } as HandleTransferRequest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('handle_validation_error');
      expect(result.message).toContain('ECONNREFUSED');
    }
  });

  it('routes each rpc to its dedicated endpoint', async () => {
    const seen: string[] = [];
    const fetchFake: typeof fetch = async (url) => {
      seen.push(String(url));
      const change: HandleChangeResponse = {
        released_handle: 'a',
        reserved_handle: 'b',
        reserved_at: 1,
        soft_redirect_until: 2,
      };
      const transfer: HandleTransferResponse = {
        transferred_at: 1,
        handle: 'a',
        outgoing_publisher_id: 'pa',
        incoming_publisher_id: 'pb',
      };
      const abuse: HandleAbuseReportResponse = { ticket_id: 't', received_at: 1 };
      const data = String(url).includes('change')
        ? change
        : String(url).includes('transfer')
          ? transfer
          : abuse;
      return okResponse(data);
    };
    const client = createRecuedCloudHandleClient({ cloud_base_url, fetch: fetchFake });
    await client.changeHandle({
      publisher_id: 'p',
      current_handle: 'a',
      new_handle: 'b',
      nonce: 'n',
      signature: 's',
      timestamp: 1,
    } as HandleChangeRequest);
    await client.transferHandle({
      outgoing_publisher_id: 'pa',
      incoming_publisher_id: 'pb',
      handle: 'a',
      nonce: 'n',
      outgoing_signature: 'os',
      incoming_signature: 'is',
      timestamp: 1,
    } as HandleTransferRequest);
    await client.abuseReport({
      reported_handle: 'evil',
      kind: 'phishing',
      detail: 'spam',
    } as HandleAbuseReportRequest);
    expect(seen).toEqual([
      'https://cloud.test/v1/ddns/handle/change',
      'https://cloud.test/v1/ddns/handle/transfer',
      'https://cloud.test/v1/ddns/handle/abuse-report',
    ]);
  });

  it('strips a trailing slash from cloud_base_url', async () => {
    const seen: string[] = [];
    const fetchFake: typeof fetch = async (url) => {
      seen.push(String(url));
      return okResponse<HandleReserveResponse>({
        reserved_at: 1,
        handle: 'alice',
        state: 'active',
      });
    };
    const client = createRecuedCloudHandleClient({
      cloud_base_url: 'https://cloud.test///',
      fetch: fetchFake,
    });
    await client.reserveHandle({
      publisher_id: 'p',
      handle: 'alice',
      nonce: 'n',
      signature: 's',
      timestamp: 1,
    });
    expect(seen[0]).toBe('https://cloud.test/v1/ddns/handle/reserve');
  });
});

// ────────────────────────────────────────────────────────────────
// onStateChanged listener
// ────────────────────────────────────────────────────────────────

describe('createHandleStateMachine onStateChanged', () => {
  const identity = generateEd25519Keypair('server_identity_key');

  const fakeCloud = (): CloudHandleClient => ({
    async reserveHandle(req: HandleReserveRequest) {
      const data: HandleReserveResponse = {
        reserved_at: 1_700_000_000_000,
        handle: req.handle,
        state: 'active',
      };
      return { ok: true, data };
    },
    async changeHandle(req: HandleChangeRequest) {
      const data: HandleChangeResponse = {
        released_handle: req.current_handle,
        reserved_handle: req.new_handle,
        reserved_at: 1_700_000_001_000,
        soft_redirect_until: 1_700_000_001_000 + 86_400_000,
      };
      return { ok: true, data };
    },
    async transferHandle(req: HandleTransferRequest) {
      const data: HandleTransferResponse = {
        transferred_at: 1_700_000_002_000,
        handle: req.handle,
        outgoing_publisher_id: req.outgoing_publisher_id,
        incoming_publisher_id: req.incoming_publisher_id,
      };
      return { ok: true, data };
    },
    async abuseReport() {
      return { ok: true, data: { ticket_id: 't', received_at: 1 } };
    },
  });

  const noopAudit: HandleAuditEmitter = { log: () => undefined };
  const noopBroadcast: HandleBroadcaster = { broadcast: () => undefined };

  it('fires after reserveInitial / changeHandle / transferHandleOut / applyLifecycleUpdate', async () => {
    const seen: HandleState[] = [];
    const db = seedDb();
    const machine = createHandleStateMachine({
      store: createSqliteHandleStateStore({ db }),
      cloud: fakeCloud(),
      audit: noopAudit,
      broadcaster: noopBroadcast,
      serverIdentity: () => identity,
      onStateChanged: (state) => {
        seen.push(state);
      },
    });
    const reserve = await machine.reserveInitial({
      publisher_id: 'pub_1',
      handle: 'alice',
      publisher_identity_fingerprint: 'fp',
      changed_by_client_id: 'c',
    });
    expect(reserve.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.publisher_id).toBe('pub_1');
    expect(seen[0]!.current_handle).toBe('alice');

    const change = await machine.changeHandle({
      next_handle: 'bob',
      changed_by_client_id: 'c',
    });
    expect(change.ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.current_handle).toBe('bob');

    const transfer = await machine.transferHandleOut({
      incoming_publisher_id: 'pub_2',
      incoming_signature: 'sig',
      nonce: 'n',
      transfer_timestamp: 1_700_000_002_000,
      changed_by_client_id: 'c',
    });
    expect(transfer.ok).toBe(true);
    expect(seen).toHaveLength(3);
    expect(seen[2]!.current_handle).toBe('');
    expect(seen[2]!.publisher_id).toBe('pub_1');

    await machine.applyLifecycleUpdate({ state: 'grace', grace_until: 1, now: 2 });
    expect(seen).toHaveLength(4);
    expect(seen[3]!.subscription_state).toBe('grace');
  });

  it('persists state across machine instances on the same store', async () => {
    const db = seedDb();
    const store = createSqliteHandleStateStore({ db });
    const m1 = createHandleStateMachine({
      store,
      cloud: fakeCloud(),
      audit: noopAudit,
      broadcaster: noopBroadcast,
      serverIdentity: () => identity,
    });
    await m1.reserveInitial({
      publisher_id: 'pub_persist',
      handle: 'carol',
      publisher_identity_fingerprint: 'fp',
      changed_by_client_id: 'c',
    });
    // Fresh machine + fresh store on the same db simulates a reboot
    const m2 = createHandleStateMachine({
      store: createSqliteHandleStateStore({ db }),
      cloud: fakeCloud(),
      audit: noopAudit,
      broadcaster: noopBroadcast,
      serverIdentity: () => identity,
    });
    const restored = await m2.current();
    expect(restored?.publisher_id).toBe('pub_persist');
    expect(restored?.current_handle).toBe('carol');
  });

  it('swallows listener errors without aborting the mutation', async () => {
    const db = seedDb();
    const machine = createHandleStateMachine({
      store: createSqliteHandleStateStore({ db }),
      cloud: fakeCloud(),
      audit: noopAudit,
      broadcaster: noopBroadcast,
      serverIdentity: () => identity,
      onStateChanged: () => {
        throw new Error('listener bug');
      },
    });
    const result = await machine.reserveInitial({
      publisher_id: 'pub_swallow',
      handle: 'dave',
      publisher_identity_fingerprint: 'fp',
      changed_by_client_id: 'c',
    });
    expect(result.ok).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Codex P2 fold #1 — snapshot gate on release / transfer
// ────────────────────────────────────────────────────────────────

describe('publisher_id snapshot gate (Codex P2 fold #1)', () => {
  // Mirrors the bin.ts snapshot computation. Kept literally aligned
  // with the production binding so a future change has one place to
  // verify the gate against.
  const computeSnapshot = (state: HandleState | null): string | null => {
    if (!state) return null;
    if (state.subscription_state === 'released') return null;
    if (!state.current_handle || state.current_handle.length === 0) return null;
    if (!state.publisher_id || state.publisher_id.length === 0) return null;
    return state.publisher_id;
  };

  it('returns null for no state', () => {
    expect(computeSnapshot(null)).toBeNull();
  });

  it('returns publisher_id for an active reservation', () => {
    expect(
      computeSnapshot({
        publisher_id: 'pub_active',
        current_handle: 'alice',
        handle_history: [],
        subscription_state: 'active',
        last_synced_at: 1,
      }),
    ).toBe('pub_active');
  });

  it('returns publisher_id during grace (still owned)', () => {
    expect(
      computeSnapshot({
        publisher_id: 'pub_grace',
        current_handle: 'alice',
        handle_history: [],
        subscription_state: 'grace',
        grace_until: 2,
        last_synced_at: 1,
      }),
    ).toBe('pub_grace');
  });

  it('returns null after transfer-out (current_handle empty)', () => {
    expect(
      computeSnapshot({
        publisher_id: 'pub_xfer',
        current_handle: '',
        handle_history: [],
        subscription_state: 'active',
        last_synced_at: 1,
      }),
    ).toBeNull();
  });

  it('returns null when subscription_state is released', () => {
    expect(
      computeSnapshot({
        publisher_id: 'pub_released',
        current_handle: '',
        handle_history: [],
        subscription_state: 'released',
        last_synced_at: 1,
      }),
    ).toBeNull();
  });

  it('returns null when publisher_id is empty', () => {
    expect(
      computeSnapshot({
        publisher_id: '',
        current_handle: 'alice',
        handle_history: [],
        subscription_state: 'active',
        last_synced_at: 1,
      }),
    ).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Codex P2 fold #2 — schema validation on load
// ────────────────────────────────────────────────────────────────

describe('createSqliteHandleStateStore schema validation', () => {
  const writeRaw = (value: string): Database.Database => {
    const db = seedDb();
    db.prepare(`INSERT INTO server_config (key, value) VALUES (?, ?)`).run(
      HANDLE_STATE_CONFIG_KEY,
      value,
    );
    return db;
  };

  it('returns null when the row is missing required fields', async () => {
    const store = createSqliteHandleStateStore({
      db: writeRaw(JSON.stringify({})),
    });
    expect(await store.load()).toBeNull();
  });

  it('returns null when publisher_id is the wrong type', async () => {
    const store = createSqliteHandleStateStore({
      db: writeRaw(
        JSON.stringify({
          publisher_id: 42,
          current_handle: 'alice',
          handle_history: [],
          subscription_state: 'active',
          last_synced_at: 1,
        }),
      ),
    });
    expect(await store.load()).toBeNull();
  });

  it('returns null when subscription_state is outside the closed list', async () => {
    const store = createSqliteHandleStateStore({
      db: writeRaw(
        JSON.stringify({
          publisher_id: 'p',
          current_handle: 'alice',
          handle_history: [],
          subscription_state: 'mystery',
          last_synced_at: 1,
        }),
      ),
    });
    expect(await store.load()).toBeNull();
  });

  it('returns null when handle_history contains a malformed entry', async () => {
    const store = createSqliteHandleStateStore({
      db: writeRaw(
        JSON.stringify({
          publisher_id: 'p',
          current_handle: 'alice',
          handle_history: [{ handle: 'alice' }], // missing reserved_at + reason
          subscription_state: 'active',
          last_synced_at: 1,
        }),
      ),
    });
    expect(await store.load()).toBeNull();
  });

  it('returns the row when every required field is present + typed', async () => {
    const valid: HandleState = {
      publisher_id: 'pub_ok',
      current_handle: 'alice',
      handle_history: [
        { handle: 'alice', reserved_at: 1, reason: 'reserved' },
      ],
      subscription_state: 'active',
      last_synced_at: 1,
    };
    const store = createSqliteHandleStateStore({
      db: writeRaw(JSON.stringify(valid)),
    });
    expect(await store.load()).toEqual(valid);
  });
});

// ────────────────────────────────────────────────────────────────
// Codex P3 fold — HandleRpcErrorCode exhaustiveness ratchet
// ────────────────────────────────────────────────────────────────

describe('HANDLE_RPC_ERROR_CODES ratchet', () => {
  it('contains every literal in the HandleRpcErrorCode union', () => {
    // Exhaustiveness gate at the type layer — adding a new code to the
    // contract union without extending HANDLE_RPC_ERROR_CODES would
    // fail to type-check here, since the literal-typed sentinel
    // assignment requires every union member to be present in the array.
    const sentinel: Record<HandleRpcErrorCode, true> = {
      handle_signature_invalid: true,
      handle_publisher_unknown: true,
      handle_replay_window_exceeded: true,
      handle_replay_duplicate: true,
      handle_taken: true,
      handle_already_reserved: true,
      handle_confusable_to_existing: true,
      handle_reserved: true,
      handle_validation_error: true,
      handle_grace_pending: true,
      handle_transfer_signature_mismatch: true,
      handle_transfer_handle_unowned: true,
      handle_authority_handle_mismatch: true,
      handle_abuse_kind_unknown: true,
      handle_abuse_detail_too_large: true,
      handle_abuse_signature_invalid: true,
      handle_abuse_signature_required: true,
      handle_rate_limited: true,
    };
    const declared = new Set(HANDLE_RPC_ERROR_CODES);
    const expected = new Set(Object.keys(sentinel)) as Set<string>;
    expect(declared.size).toBe(expected.size);
    for (const code of expected) {
      expect(declared.has(code as HandleRpcErrorCode)).toBe(true);
    }
  });

  it('round-trips every code through the cloud client decoder', async () => {
    const seen: HandleRpcErrorCode[] = [];
    for (const code of HANDLE_RPC_ERROR_CODES) {
      const fetchFake: typeof fetch = async () =>
        new Response(
          JSON.stringify({ error: { code, message: '' }, meta: {} }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      const client = createRecuedCloudHandleClient({
        cloud_base_url: 'https://test',
        fetch: fetchFake,
      });
      const result = await client.reserveHandle({
        publisher_id: 'p',
        handle: 'h',
        nonce: 'n',
        signature: 's',
        timestamp: 1,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) seen.push(result.error);
    }
    expect(new Set(seen)).toEqual(new Set(HANDLE_RPC_ERROR_CODES));
  });
});
