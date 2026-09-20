/** D-148 P8 — handle governance state-machine acceptance.
 *
 *  Covers spec § P8 acceptance lines 2185-2191:
 *    - Handle reservation rpc + impersonation rejection
 *    - Reserved-name list rejection
 *    - Handle change flow + DDNS transfer + audit + broadcast
 *    - Dual-signature transfer flow
 *    - Expired-subscription 60d grace + handle release
 *    - Collision detection
 */

import { describe, it, expect } from 'vitest';
import {
  HANDLE_GRACE_PERIOD_MS,
  HANDLE_OLD_REDIRECT_WINDOW_MS,
  type HandleAbuseReportRequest,
  type HandleAbuseReportResponse,
  type HandleChangeRequest,
  type HandleChangeResponse,
  type HandleReserveRequest,
  type HandleReserveResponse,
  type HandleRpcErrorCode,
  type HandleSubscriptionState,
  type HandleTransferRequest,
  type HandleTransferResponse,
} from '@recued/contracts';
import type { ActivityEntry } from '@recued/storage';
import { canonicalJSONStringify } from '@recued/crypto';
import {
  ed25519Verify,
  generateEd25519Keypair,
  type Ed25519Keypair,
} from '../keys/index.js';
import {
  createHandleStateMachine,
  createInMemoryHandleStateStore,
  type CloudHandleClient,
  type HandleAuditEmitter,
  type HandleBroadcaster,
  type HandleChangedBroadcastEvent,
} from '../handle/index.js';

// ────────────────────────────────────────────────────────────────
// Fakes
// ────────────────────────────────────────────────────────────────

interface FakeCloud {
  client: CloudHandleClient;
  reservations: Map<string, { publisher_id: string; reserved_at: number; state: HandleSubscriptionState }>;
  reserveCalls: HandleReserveRequest[];
  changeCalls: HandleChangeRequest[];
  transferCalls: HandleTransferRequest[];
  abuseCalls: HandleAbuseReportRequest[];
  failures: Map<string, HandleRpcErrorCode>;
  /** Inject a `handle_taken` for the given handle on next reserve. */
  reserveWillFail(handle: string, err: HandleRpcErrorCode): void;
  changeWillFail(err: HandleRpcErrorCode): void;
  transferWillFail(err: HandleRpcErrorCode): void;
}

const makeCloud = (now = () => Date.now()): FakeCloud => {
  const reservations = new Map<string, { publisher_id: string; reserved_at: number; state: HandleSubscriptionState }>();
  const reserveCalls: HandleReserveRequest[] = [];
  const changeCalls: HandleChangeRequest[] = [];
  const transferCalls: HandleTransferRequest[] = [];
  const abuseCalls: HandleAbuseReportRequest[] = [];
  const failures = new Map<string, HandleRpcErrorCode>();
  const cloud: CloudHandleClient = {
    async reserveHandle(req) {
      reserveCalls.push(req);
      const k = `reserve:${req.handle}`;
      const planned = failures.get(k);
      if (planned) {
        failures.delete(k);
        return { ok: false, error: planned };
      }
      // Confusable detection — inject a separate failure key.
      const taken = reservations.get(req.handle);
      if (taken && taken.publisher_id !== req.publisher_id && taken.state !== 'released') {
        return { ok: false, error: 'handle_taken' };
      }
      const reserved_at = now();
      reservations.set(req.handle, {
        publisher_id: req.publisher_id,
        reserved_at,
        state: 'active',
      });
      return {
        ok: true,
        data: { reserved_at, handle: req.handle, state: 'active' as const },
      };
    },
    async changeHandle(req) {
      changeCalls.push(req);
      const planned = failures.get('change');
      if (planned) {
        failures.delete('change');
        return { ok: false, error: planned };
      }
      const old = reservations.get(req.current_handle);
      if (!old || old.publisher_id !== req.publisher_id) {
        return { ok: false, error: 'handle_transfer_handle_unowned' };
      }
      const candidate = reservations.get(req.new_handle);
      if (candidate && candidate.publisher_id !== req.publisher_id && candidate.state !== 'released') {
        return { ok: false, error: 'handle_taken' };
      }
      reservations.delete(req.current_handle);
      const reserved_at = now();
      reservations.set(req.new_handle, {
        publisher_id: req.publisher_id,
        reserved_at,
        state: 'active',
      });
      const data: HandleChangeResponse = {
        released_handle: req.current_handle,
        reserved_handle: req.new_handle,
        reserved_at,
        soft_redirect_until: reserved_at + HANDLE_OLD_REDIRECT_WINDOW_MS,
      };
      return { ok: true, data };
    },
    async transferHandle(req) {
      transferCalls.push(req);
      const planned = failures.get('transfer');
      if (planned) {
        failures.delete('transfer');
        return { ok: false, error: planned };
      }
      const row = reservations.get(req.handle);
      if (!row || row.publisher_id !== req.outgoing_publisher_id) {
        return { ok: false, error: 'handle_transfer_handle_unowned' };
      }
      const transferred_at = now();
      reservations.set(req.handle, {
        publisher_id: req.incoming_publisher_id,
        reserved_at: transferred_at,
        state: 'active',
      });
      const data: HandleTransferResponse = {
        transferred_at,
        handle: req.handle,
        outgoing_publisher_id: req.outgoing_publisher_id,
        incoming_publisher_id: req.incoming_publisher_id,
      };
      return { ok: true, data };
    },
    async abuseReport(req) {
      abuseCalls.push(req);
      const planned = failures.get('abuse');
      if (planned) {
        failures.delete('abuse');
        return { ok: false, error: planned };
      }
      const data: HandleAbuseReportResponse = {
        ticket_id: `t-${abuseCalls.length}`,
        received_at: now(),
      };
      return { ok: true, data };
    },
  };
  return {
    client: cloud,
    reservations,
    reserveCalls,
    changeCalls,
    transferCalls,
    abuseCalls,
    failures,
    reserveWillFail(handle, err) {
      failures.set(`reserve:${handle}`, err);
    },
    changeWillFail(err) {
      failures.set('change', err);
    },
    transferWillFail(err) {
      failures.set('transfer', err);
    },
  };
};

const makeAudit = (): { emitter: HandleAuditEmitter; rows: ActivityEntry[] } => {
  const rows: ActivityEntry[] = [];
  return {
    emitter: { log: (e) => { rows.push({ ...e }); } },
    rows,
  };
};

const makeBroadcaster = (): {
  broadcaster: HandleBroadcaster;
  events: HandleChangedBroadcastEvent[];
} => {
  const events: HandleChangedBroadcastEvent[] = [];
  return {
    broadcaster: { broadcast: (e) => { events.push({ ...e }); } },
    events,
  };
};

const makeMachine = (
  identityKey: Ed25519Keypair,
  cloud: FakeCloud,
  existing?: ReadonlySet<string>,
): {
  machine: ReturnType<typeof createHandleStateMachine>;
  audit: ActivityEntry[];
  events: HandleChangedBroadcastEvent[];
} => {
  const { emitter, rows: audit } = makeAudit();
  const { broadcaster, events } = makeBroadcaster();
  const store = createInMemoryHandleStateStore();
  const machine = createHandleStateMachine({
    store,
    cloud: cloud.client,
    audit: emitter,
    broadcaster,
    serverIdentity: () => identityKey,
    ...(existing ? { existingHandles: () => existing } : {}),
    clock: () => 1_700_000_000_000,
  });
  return { machine, audit, events };
};

// ────────────────────────────────────────────────────────────────
// Reservation
// ────────────────────────────────────────────────────────────────

describe('D-148 P8 — handle reservation', () => {
  it('reserves an unused handle', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    const { machine, audit } = makeMachine(ik, cloud);
    const result = await machine.reserveInitial({
      publisher_id: 'pub_1',
      handle: 'alice',
      publisher_identity_fingerprint: 'sha256:foo',
      changed_by_client_id: 'cli_1',
    });
    expect(result.ok).toBe(true);
    expect(cloud.reserveCalls).toHaveLength(1);
    expect(cloud.reserveCalls[0]?.handle).toBe('alice');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe('handle_change');
    expect(audit[0]?.detail).toContain('kind=reserved');
  });

  it('rejects reserved-name on local validation', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    const { machine } = makeMachine(ik, cloud);
    const result = await machine.reserveInitial({
      publisher_id: 'pub_1',
      handle: 'admin',
      publisher_identity_fingerprint: 'sha256:foo',
      changed_by_client_id: 'cli_1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('handle_reserved');
    }
    // Did not reach the cloud.
    expect(cloud.reserveCalls).toHaveLength(0);
  });

  it('rejects impersonation (Unicode confusable to existing)', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    const existing = new Set(['alice']);
    const { machine } = makeMachine(ik, cloud, existing);
    const result = await machine.reserveInitial({
      publisher_id: 'pub_2',
      handle: 'alicé',
      publisher_identity_fingerprint: 'sha256:foo',
      changed_by_client_id: 'cli_1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('handle_confusable_to_existing');
    }
  });

  it('rejects format violations', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    const { machine } = makeMachine(ik, cloud);
    const result = await machine.reserveInitial({
      publisher_id: 'pub_1',
      handle: '_invalid',
      publisher_identity_fingerprint: 'sha256:foo',
      changed_by_client_id: 'cli_1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('handle_format');
    }
  });

  it('propagates cloud handle_taken on collision', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    cloud.reserveWillFail('alice', 'handle_taken');
    const { machine } = makeMachine(ik, cloud);
    const result = await machine.reserveInitial({
      publisher_id: 'pub_1',
      handle: 'alice',
      publisher_identity_fingerprint: 'sha256:foo',
      changed_by_client_id: 'cli_1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('handle_taken');
    }
  });

  /** ⚠ RETARGETED 2026-08-30 — the fake returned `handle_subscription_lapsed`, which the
   *  real cloud can no longer send for a reserve: the handle endpoints' Pro gate was
   *  lifted (free with any account; Pro buys DDNS + the certificate). The propagation is
   *  the property under test, so it now propagates a rejection the cloud actually makes. */
  it('a cloud reserve rejection propagates as error', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    cloud.reserveWillFail('alice', 'handle_taken');
    const { machine } = makeMachine(ik, cloud);
    const result = await machine.reserveInitial({
      publisher_id: 'pub_1',
      handle: 'alice',
      publisher_identity_fingerprint: 'sha256:foo',
      changed_by_client_id: 'cli_1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('handle_taken');
    }
  });

  it('signs the reserve request with server_identity_key', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    const { machine } = makeMachine(ik, cloud);
    await machine.reserveInitial({
      publisher_id: 'pub_1',
      handle: 'alice',
      publisher_identity_fingerprint: 'sha256:foo',
      changed_by_client_id: 'cli_1',
    });
    const req = cloud.reserveCalls[0];
    expect(req).toBeDefined();
    expect(req?.signature.length).toBeGreaterThan(0);
    // Codex P8 contract fold #2 — every signed request carries a
    // nonce. Two consecutive signed requests must mint distinct nonces.
    expect(req?.nonce).toBeDefined();
    expect(req?.nonce.length).toBeGreaterThan(0);
  });

  it('refuses second reserveInitial when local state already exists (correctness fold #1)', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    const { machine } = makeMachine(ik, cloud);
    await machine.reserveInitial({
      publisher_id: 'pub_1',
      handle: 'alice',
      publisher_identity_fingerprint: 'sha256:foo',
      changed_by_client_id: 'cli_1',
    });
    const result = await machine.reserveInitial({
      publisher_id: 'pub_2',
      handle: 'evil',
      publisher_identity_fingerprint: 'sha256:bar',
      changed_by_client_id: 'cli_1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('handle_already_reserved');
    }
    // Cloud only saw the first call.
    expect(cloud.reserveCalls).toHaveLength(1);
  });

  it('history row carries closed-list reason + free-text note separately (contract fold #1)', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    const { machine } = makeMachine(ik, cloud);
    await machine.reserveInitial({
      publisher_id: 'pub_1',
      handle: 'alice',
      publisher_identity_fingerprint: 'sha256:foo',
      changed_by_client_id: 'cli_1',
      reason: 'main brand handle',
    });
    const state = await machine.current();
    expect(state?.handle_history[0]?.reason).toBe('reserved');
    expect(state?.handle_history[0]?.note).toBe('main brand handle');
  });
});

// ────────────────────────────────────────────────────────────────
// Change
// ────────────────────────────────────────────────────────────────

describe('D-148 P8 — handle change', () => {
  it('changes from current to new + emits audit + broadcast', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    const { machine, audit, events } = makeMachine(ik, cloud);
    await machine.reserveInitial({
      publisher_id: 'pub_1',
      handle: 'alice',
      publisher_identity_fingerprint: 'sha256:foo',
      changed_by_client_id: 'cli_1',
    });
    const result = await machine.changeHandle({
      next_handle: 'alice2',
      changed_by_client_id: 'cli_1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.released_handle).toBe('alice');
      expect(result.data.reserved_handle).toBe('alice2');
    }
    expect(audit).toHaveLength(2);
    expect(audit[1]?.detail).toContain('kind=changed');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'handle_changed',
      previous_handle: 'alice',
      current_handle: 'alice2',
    });
  });

  it('refuses change to identical handle', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    const { machine } = makeMachine(ik, cloud);
    await machine.reserveInitial({
      publisher_id: 'pub_1',
      handle: 'alice',
      publisher_identity_fingerprint: 'sha256:foo',
      changed_by_client_id: 'cli_1',
    });
    const result = await machine.changeHandle({
      next_handle: 'alice',
      changed_by_client_id: 'cli_1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('handle_validation_error');
    }
  });

  it('refuses change without prior local state', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    const { machine } = makeMachine(ik, cloud);
    const result = await machine.changeHandle({
      next_handle: 'alice',
      changed_by_client_id: 'cli_1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('handle_state_missing');
    }
  });

  it('marks history row released on successful change', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    const { machine } = makeMachine(ik, cloud);
    await machine.reserveInitial({
      publisher_id: 'pub_1',
      handle: 'alice',
      publisher_identity_fingerprint: 'sha256:foo',
      changed_by_client_id: 'cli_1',
    });
    await machine.changeHandle({
      next_handle: 'alice2',
      changed_by_client_id: 'cli_1',
    });
    const state = await machine.current();
    expect(state).not.toBeNull();
    if (state) {
      expect(state.handle_history).toHaveLength(2);
      expect(state.handle_history[0]?.handle).toBe('alice');
      expect(state.handle_history[0]?.released_at).toBeDefined();
      expect(state.handle_history[1]?.handle).toBe('alice2');
      expect(state.current_handle).toBe('alice2');
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Transfer
// ────────────────────────────────────────────────────────────────

describe('D-148 P8 — handle transfer (dual signature)', () => {
  it('transfers ownership when both signatures verify', async () => {
    const outgoingKey = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    const { machine, audit, events } = makeMachine(outgoingKey, cloud);
    await machine.reserveInitial({
      publisher_id: 'pub_alice',
      handle: 'alice',
      publisher_identity_fingerprint: 'sha256:foo',
      changed_by_client_id: 'cli_1',
    });
    const result = await machine.transferHandleOut({
      incoming_publisher_id: 'pub_bob',
      // Incoming signature is a stand-in — the cloud-side test
      // exercises the dual-verify; here the substrate just forwards.
      incoming_signature: 'fake-sig',
      nonce: 'nonce-123',
      transfer_timestamp: 1_700_000_000_000,
      changed_by_client_id: 'cli_1',
    });
    expect(result.ok).toBe(true);
    expect(cloud.transferCalls).toHaveLength(1);
    const req = cloud.transferCalls[0];
    expect(req).toBeDefined();
    expect(req?.outgoing_publisher_id).toBe('pub_alice');
    expect(req?.incoming_publisher_id).toBe('pub_bob');
    // ⛔⛔ VERIFIED, NOT MEASURED. `length > 0` proved something was in the
    // slot, not that it was the OUTGOING server's signature — mutation showed
    // it: putting `args.incoming_signature` in both slots passes a length
    // check, and the whole point of the dual-signature transfer is that the
    // two slots carry two parties' consent. § A.5.6 makes handle ownership
    // load-bearing for marketplace publisher provenance; one party supplying
    // both halves is exactly what it must not permit.
    expect(req?.outgoing_signature).not.toBe(req?.incoming_signature);
    expect(
      ed25519Verify(
        outgoingKey.public_key_b64,
        canonicalJSONStringify({
          outgoing_publisher_id: 'pub_alice',
          incoming_publisher_id: 'pub_bob',
          handle: 'alice',
          nonce: 'nonce-123',
          timestamp: 1_700_000_000_000,
        }),
        req!.outgoing_signature,
      ),
      'the outgoing slot did not carry this server’s signature over this transfer',
    ).toBe(true);
    expect(req?.incoming_signature).toBe('fake-sig');
    expect(req?.nonce).toBe('nonce-123');
    expect(audit.find((a) => a.detail?.includes('transferred_out'))).toBeDefined();
    expect(events).toHaveLength(1);
    expect(events[0]?.transfer_counterparty_publisher_id).toBe('pub_bob');
  });

  it('post-transfer state has empty current_handle', async () => {
    const outgoingKey = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    const { machine } = makeMachine(outgoingKey, cloud);
    await machine.reserveInitial({
      publisher_id: 'pub_alice',
      handle: 'alice',
      publisher_identity_fingerprint: 'sha256:foo',
      changed_by_client_id: 'cli_1',
    });
    await machine.transferHandleOut({
      incoming_publisher_id: 'pub_bob',
      incoming_signature: 'fake-sig',
      nonce: 'nonce-456',
      transfer_timestamp: 1_700_000_000_000,
      changed_by_client_id: 'cli_1',
    });
    const state = await machine.current();
    expect(state?.current_handle).toBe('');
    expect(state?.handle_history).toHaveLength(1);
    expect(state?.handle_history[0]?.released_at).toBeDefined();
    expect(state?.handle_history[0]?.transfer_counterparty_publisher_id).toBe('pub_bob');
  });

  it('cloud transfer-signature-mismatch propagates', async () => {
    const outgoingKey = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    cloud.transferWillFail('handle_transfer_signature_mismatch');
    const { machine } = makeMachine(outgoingKey, cloud);
    await machine.reserveInitial({
      publisher_id: 'pub_alice',
      handle: 'alice',
      publisher_identity_fingerprint: 'sha256:foo',
      changed_by_client_id: 'cli_1',
    });
    const result = await machine.transferHandleOut({
      incoming_publisher_id: 'pub_bob',
      incoming_signature: 'bad',
      nonce: 'nonce-789',
      transfer_timestamp: 1_700_000_000_000,
      changed_by_client_id: 'cli_1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('handle_transfer_signature_mismatch');
    }
  });

  it('signTransferAcceptance produces a valid signature for the incoming side', async () => {
    const incomingKey = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    const { machine } = makeMachine(incomingKey, cloud);
    const result = machine.signTransferAcceptance({
      outgoing_publisher_id: 'pub_alice',
      incoming_publisher_id: 'pub_bob',
      handle: 'alice',
      nonce: 'nonce-aaa',
      timestamp: 1_700_000_000_000,
    });
    const expectedPayload = {
      outgoing_publisher_id: 'pub_alice',
      incoming_publisher_id: 'pub_bob',
      handle: 'alice',
      nonce: 'nonce-aaa',
      timestamp: 1_700_000_000_000,
    };
    expect(result.payload).toEqual(expectedPayload);
    // ⛔⛔ "VALID" IS NOW CHECKED, NOT COUNTED. This asserted
    // `signature.length > 0` and echoed the payload back — neither of which
    // says the bytes verify, nor that THIS key produced them. Mutation showed
    // what that cost: dropping `nonce` from the signed bytes, and dropping
    // `timestamp`, both survived.
    expect(
      ed25519Verify(
        incomingKey.public_key_b64,
        canonicalJSONStringify(expectedPayload),
        result.signature,
      ),
      'the acceptance signature does not verify over its own payload',
    ).toBe(true);
  });

  it('⛔⛔ an acceptance signature does NOT carry over to a different transfer', async () => {
    // ⛔ THE INCOMING SIDE'S CONSENT IS ONE-TIME. § A.5.6 makes a transfer need
    // both parties, and the nonce + timestamp are what bind that consent to ONE
    // transfer. If they are outside the signed bytes, the same acceptance is
    // valid for every later transfer of the same (outgoing, incoming, handle)
    // triple — so the outgoing party can reuse a consent the incoming party
    // gave once, for a hand-back they never agreed to.
    //
    // ⚠ Asserted as a NON-verification against a neighbouring payload, which is
    // the only shape that can see it: signing and verifying the same bytes
    // agrees whether or not the field is in them.
    const incomingKey = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    const { machine } = makeMachine(incomingKey, cloud);
    const base = {
      outgoing_publisher_id: 'pub_alice',
      incoming_publisher_id: 'pub_bob',
      handle: 'alice',
      nonce: 'nonce-aaa',
      timestamp: 1_700_000_000_000,
    };
    const result = machine.signTransferAcceptance(base);

    for (const [field, replayed] of [
      ['nonce', { ...base, nonce: 'nonce-bbb' }],
      ['timestamp', { ...base, timestamp: 1_800_000_000_000 }],
    ] as const) {
      expect(
        ed25519Verify(
          incomingKey.public_key_b64,
          canonicalJSONStringify(replayed),
          result.signature,
        ),
        `the acceptance verified for a transfer differing only in ${field}`,
      ).toBe(false);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Lifecycle (subscription lapse + grace + release)
// ────────────────────────────────────────────────────────────────

describe('D-148 P8 — subscription lifecycle', () => {
  it('applyLifecycleUpdate transitions active → grace → released', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    const { machine } = makeMachine(ik, cloud);
    await machine.reserveInitial({
      publisher_id: 'pub_1',
      handle: 'alice',
      publisher_identity_fingerprint: 'sha256:foo',
      changed_by_client_id: 'cli_1',
    });
    const t0 = 1_700_000_000_000;
    const grace_until = t0 + HANDLE_GRACE_PERIOD_MS;
    const grace = await machine.applyLifecycleUpdate({
      state: 'grace',
      grace_until,
      now: t0,
    });
    expect(grace.subscription_state).toBe('grace');
    expect(grace.grace_until).toBe(grace_until);
    // After grace expires, release.
    const released = await machine.applyLifecycleUpdate({
      state: 'released',
      now: t0 + HANDLE_GRACE_PERIOD_MS + 1,
    });
    expect(released.subscription_state).toBe('released');
    expect(released.current_handle).toBe('');
    expect(released.handle_history).toHaveLength(1);
    expect(released.handle_history[0]?.released_at).toBe(t0 + HANDLE_GRACE_PERIOD_MS + 1);
    expect(released.handle_history[0]?.reason).toBe('released_after_grace');
  });

  it('applyLifecycleUpdate without prior state throws', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    const { machine } = makeMachine(ik, cloud);
    await expect(
      machine.applyLifecycleUpdate({ state: 'grace' }),
    ).rejects.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// Abuse report
// ────────────────────────────────────────────────────────────────

describe('D-148 P8 — abuse report', () => {
  it('forwards report through the cloud', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    const { machine } = makeMachine(ik, cloud);
    await machine.reserveInitial({
      publisher_id: 'pub_1',
      handle: 'alice',
      publisher_identity_fingerprint: 'sha256:foo',
      changed_by_client_id: 'cli_1',
    });
    const result = await machine.reportAbuse({
      reported_handle: 'evilbob',
      kind: 'impersonation',
      detail: 'looks like real bob',
      changed_by_client_id: 'cli_1',
    });
    expect(result.ok).toBe(true);
    expect(cloud.abuseCalls).toHaveLength(1);
    expect(cloud.abuseCalls[0]?.reported_handle).toBe('evilbob');
    expect(cloud.abuseCalls[0]?.reporter_publisher_id).toBe('pub_1');
  });

  it('rejects detail > 4 KB locally', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    const { machine } = makeMachine(ik, cloud);
    await machine.reserveInitial({
      publisher_id: 'pub_1',
      handle: 'alice',
      publisher_identity_fingerprint: 'sha256:foo',
      changed_by_client_id: 'cli_1',
    });
    const big = 'a'.repeat(5000);
    const result = await machine.reportAbuse({
      reported_handle: 'evilbob',
      kind: 'impersonation',
      detail: big,
      changed_by_client_id: 'cli_1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('handle_abuse_detail_too_large');
    }
    expect(cloud.abuseCalls).toHaveLength(0);
  });

  it('anonymous report (no local state) still posts', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    const { machine } = makeMachine(ik, cloud);
    const result = await machine.reportAbuse({
      reported_handle: 'evilbob',
      kind: 'phishing',
      detail: 'sent malicious link',
      changed_by_client_id: 'cli_1',
    });
    expect(result.ok).toBe(true);
    expect(cloud.abuseCalls).toHaveLength(1);
    expect(cloud.abuseCalls[0]?.reporter_publisher_id).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// reReserve — corrective re-anchor after a server_identity_key rotation
// (D-175 — the Pro provisioner's stale_handle_state self-heal)
// ────────────────────────────────────────────────────────────────

describe('D-175 — handle reReserve (rotation re-anchor)', () => {
  const OLD_PUBLISHER = 'sha256:' + 'a'.repeat(64);

  /** Seed local state as if reserved under a now-rotated-away identity
   *  (publisher_id = OLD_PUBLISHER, handle 'alice'), which also reserves
   *  'alice' at the cloud fake under that old id. */
  const seedRotatedAway = async (
    machine: ReturnType<typeof createHandleStateMachine>,
  ): Promise<void> => {
    await machine.reserveInitial({
      publisher_id: OLD_PUBLISHER,
      handle: 'alice',
      publisher_identity_fingerprint: OLD_PUBLISHER,
      changed_by_client_id: 'cli_old',
    });
  };

  it('re-anchors local state to the live fingerprint + handle, audits + broadcasts', async () => {
    const liveKey = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    const { machine, audit, events } = makeMachine(liveKey, cloud);
    await seedRotatedAway(machine);
    // The old reservation has been released / migrated cloud-side (the
    // auth-worker concern) — the handle is free for the live identity.
    cloud.reservations.delete('alice');

    const result = await machine.reReserve({
      publisher_id: liveKey.public_key_fingerprint,
      handle: 'alice',
      changed_by_client_id: 'cli_live',
    });

    expect(result.ok).toBe(true);
    const state = await machine.current();
    // publisher_id flips to the rotated-to (live) fingerprint; handle kept.
    expect(state?.publisher_id).toBe(liveKey.public_key_fingerprint);
    expect(state?.current_handle).toBe('alice');
    // History: prior row closed, re-anchor row appended (closed-list
    // `changed` reason + rotation note carried in `note`).
    expect(state?.handle_history).toHaveLength(2);
    expect(state?.handle_history[0]?.released_at).toBeGreaterThan(0);
    expect(state?.handle_history[1]?.reason).toBe('changed');
    expect(state?.handle_history[1]?.note).toContain('rotation');
    // High-assurance audit (action handle_change) records the pid flip.
    expect(audit).toHaveLength(2);
    expect(audit[1]?.action).toBe('handle_change');
    expect(audit[1]?.detail).toContain('kind=changed');
    expect(audit[1]?.detail).toContain(OLD_PUBLISHER);
    expect(audit[1]?.detail).toContain(liveKey.public_key_fingerprint);
    // Broadcast carries the live publisher_id.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'handle_changed',
      current_handle: 'alice',
      publisher_id: liveKey.public_key_fingerprint,
    });
  });

  it('the re-reserve request carries the live fingerprint + is signed by the live identity key (structural invariant)', async () => {
    const liveKey = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    const { machine } = makeMachine(liveKey, cloud);
    await seedRotatedAway(machine);
    cloud.reservations.delete('alice');

    await machine.reReserve({
      publisher_id: liveKey.public_key_fingerprint,
      handle: 'alice',
      changed_by_client_id: 'cli_live',
    });

    const req = cloud.reserveCalls[cloud.reserveCalls.length - 1]!;
    // The publisher_id SENT is the live fingerprint (never the OLD one).
    expect(req.publisher_id).toBe(liveKey.public_key_fingerprint);
    expect(req.publisher_id).not.toBe(OLD_PUBLISHER);
    // …and it verifies against the LIVE identity's public key — only the
    // live key could have produced this reserve.
    const signed = canonicalJSONStringify({
      publisher_id: req.publisher_id,
      handle: req.handle,
      nonce: req.nonce,
      timestamp: req.timestamp,
    });
    expect(ed25519Verify(liveKey.public_key_b64, signed, req.signature)).toBe(true);
  });

  it('resets a stale (grace) lifecycle to the cloud active stamp — no lapsed state carried forward', async () => {
    const liveKey = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    const { machine } = makeMachine(liveKey, cloud);
    await seedRotatedAway(machine);
    // The old subscription had lapsed into grace with a deadline stamped —
    // a `...state` spread would carry both forward past the fresh reserve,
    // leaving DDNS/ACME treating the re-anchored handle as lapsed.
    await machine.applyLifecycleUpdate({ state: 'grace', grace_until: 999, now: 1 });
    cloud.reservations.delete('alice');

    const result = await machine.reReserve({
      publisher_id: liveKey.public_key_fingerprint,
      handle: 'alice',
      changed_by_client_id: 'cli_live',
    });

    expect(result.ok).toBe(true);
    const state = await machine.current();
    // The cloud reserve is authoritative → active; the grace deadline is gone.
    expect(state?.subscription_state).toBe('active');
    expect(state?.grace_until).toBeUndefined();
    expect(state?.current_handle).toBe('alice');
  });

  it('refuses with handle_state_missing when there is no existing reserved state', async () => {
    const liveKey = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    const { machine, audit, events } = makeMachine(liveKey, cloud);
    const result = await machine.reReserve({
      publisher_id: liveKey.public_key_fingerprint,
      handle: 'alice',
      changed_by_client_id: 'cli_live',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('handle_state_missing');
    // Never reached the cloud + never mutated.
    expect(cloud.reserveCalls).toHaveLength(0);
    expect(audit).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('leaves local state untouched when the cloud rejects (old reservation still stranded → handle_taken)', async () => {
    const liveKey = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    const { machine, audit, events } = makeMachine(liveKey, cloud);
    await seedRotatedAway(machine);
    // Old reservation NOT released — 'alice' is still pinned to the
    // rotated-away id at the cloud, so the live identity's reserve 409s.

    const result = await machine.reReserve({
      publisher_id: liveKey.public_key_fingerprint,
      handle: 'alice',
      changed_by_client_id: 'cli_live',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('handle_taken');
    // The store still mirrors the pre-correction (rotated-away) state —
    // the substrate never invents a reservation the cloud refused.
    const state = await machine.current();
    expect(state?.publisher_id).toBe(OLD_PUBLISHER);
    expect(state?.current_handle).toBe('alice');
    expect(state?.handle_history).toHaveLength(1);
    // Only the seed's audit/broadcast — no corrective rows.
    expect(audit).toHaveLength(1);
    expect(events).toHaveLength(0);
  });

  it('rejects an invalid (reserved-name) target handle before the cloud', async () => {
    const liveKey = generateEd25519Keypair('server_identity_key');
    const cloud = makeCloud();
    const { machine } = makeMachine(liveKey, cloud);
    await seedRotatedAway(machine);
    const reserveCallsAfterSeed = cloud.reserveCalls.length;

    const result = await machine.reReserve({
      publisher_id: liveKey.public_key_fingerprint,
      handle: 'admin',
      changed_by_client_id: 'cli_live',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('handle_reserved');
    // No additional cloud reserve beyond the seed.
    expect(cloud.reserveCalls).toHaveLength(reserveCallsAfterSeed);
  });
});

describe('D-176 — ddns_zone mirrored from the cloud response into HandleState', () => {
  const reserve = (machine: ReturnType<typeof createHandleStateMachine>) =>
    machine.reserveInitial({
      publisher_id: 'pub_1',
      handle: 'alice',
      publisher_identity_fingerprint: 'sha256:foo',
      changed_by_client_id: 'cli_1',
    });

  it('persists the zone label the cloud returns on reserve', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const base = makeCloud();
    // The real cloud always echoes the bound zone post-D-176; wrap the fake to
    // do the same so the server-side mirror is exercised.
    const zoned: FakeCloud = {
      ...base,
      client: {
        ...base.client,
        async reserveHandle(req) {
          const r = await base.client.reserveHandle(req);
          return r.ok ? { ok: true, data: { ...r.data, zone: 'net' } } : r;
        },
      },
    };
    const { machine } = makeMachine(ik, zoned);
    expect((await reserve(machine)).ok).toBe(true);
    expect((await machine.current())?.ddns_zone).toBe('net');
  });

  it('leaves ddns_zone absent when an older cloud omits zone (forward-compat)', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    // The base fake omits zone — exactly an older cloud. The conditional-spread
    // persist must leave the field absent, not write `undefined`/a default.
    const { machine } = makeMachine(ik, makeCloud());
    expect((await reserve(machine)).ok).toBe(true);
    expect((await machine.current())?.ddns_zone).toBeUndefined();
  });
});
