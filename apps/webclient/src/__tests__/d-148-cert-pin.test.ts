/** D-148 § A.6.5 — webclient cert-pin handler tests.
 *
 *  Covers the consumer side of the two-pin overlap protocol:
 *   - Pair-time first-pin acquisition via
 *     `deriveCertPinStateFromConsumeResponse` (slice 122).
 *   - Rotation-notice handler: signature verify + persist
 *     `next_fingerprint` + update `current_valid_until`.
 *   - Revert handler: restore `current_fingerprint`, clear next.
 *   - Failure isolation (verify / read / persist) routes through
 *     `onError` without throwing.
 *   - Serialization of back-to-back events via the internal promise
 *     chain.
 *
 *  Round-trip signature tests use WebCrypto Ed25519 inline so the
 *  same byte-for-byte canonical-JSON transcript covers both ends.
 */

import { describe, expect, it } from 'vitest';
import {
  type ServerEvent,
  type WebclientCertPinState,
} from '@recued/contracts';
import { bytesToBase64 } from '@recued/crypto';

import {
  applyRotationNoticeToState,
  applyRotationRevertedToState,
  createCertPinHandler,
  type CertPinFailureContext,
} from '../realtime/cert-pin.js';
import {
  createBroadcastSubscriber,
  type BroadcastSubscriber,
} from '../realtime/subscriber.js';
import {
  createInMemoryWebclientLocalStore,
  type WebclientLocalStore,
} from '../storage/local-store.js';

const ed25519Available = async (): Promise<boolean> => {
  try {
    await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    return true;
  } catch {
    return false;
  }
};

// D-156 P8: the `deriveCertPinStateFromConsumeResponse` describe block
// retired with `pair-consume-bootstrap.ts`. Equivalent coverage for
// the post-pair pin-derivation lives in
// `d-156-phase-5-pair-code-success.test.ts` (`finalizePairCodeSuccess`
// + its private `deriveCertPinFromPassport`), so the surface is still
// asserted; it just reads from the passport projection instead of the
// retired pair-blob consume response.

// ════════════════════════════════════════════════════════════════
// applyRotationNoticeToState
// ════════════════════════════════════════════════════════════════

describe('D-148 § A.6.5 — applyRotationNoticeToState (pure transition)', () => {
  const noticeEvent = (
    over?: Partial<Extract<ServerEvent, { kind: 'cert.rotation_notice' }>>,
  ): Extract<ServerEvent, { kind: 'cert.rotation_notice' }> => ({
    kind: 'cert.rotation_notice',
    current_fingerprint: 'sha256:current',
    next_fingerprint: 'sha256:next',
    rotation_at: 5_000_000,
    signature: 'sig',
    signer_fingerprint: 'sha256:signer',
    emitted_at: 4_900_000,
    cursor: 1,
    ...over,
  });

  it('stages next_fingerprint + updates current_valid_until to rotation_at', () => {
    const current: WebclientCertPinState = {
      current_fingerprint: 'sha256:current',
      current_valid_until: 8_000_000,
    };
    const result = applyRotationNoticeToState(current, noticeEvent(), 1_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.current_fingerprint).toBe('sha256:current');
      expect(result.next.next_fingerprint).toBe('sha256:next');
      expect(result.next.current_valid_until).toBe(5_000_000);
    }
  });

  it('keeps last_rotated_at if previously set', () => {
    const current: WebclientCertPinState = {
      current_fingerprint: 'sha256:current',
      current_valid_until: 8_000_000,
      last_rotated_at: 3_000_000,
    };
    const result = applyRotationNoticeToState(current, noticeEvent(), 1_000);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.last_rotated_at).toBe(3_000_000);
  });

  it('seeds current_fingerprint from notice when no prior state exists (DD#2)', () => {
    const result = applyRotationNoticeToState(null, noticeEvent(), 1_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.current_fingerprint).toBe('sha256:current');
      expect(result.next.next_fingerprint).toBe('sha256:next');
    }
  });

  it('rejects current_fingerprint_mismatch (Codex P2 fold)', () => {
    const current: WebclientCertPinState = {
      current_fingerprint: 'sha256:pinned',
      current_valid_until: 8_000_000,
    };
    const result = applyRotationNoticeToState(
      current,
      noticeEvent({ current_fingerprint: 'sha256:divergent' }),
      1_000,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('current_fingerprint_mismatch');
  });

  it('rejects rotation_at_in_past (Codex P2 fold)', () => {
    const current: WebclientCertPinState = {
      current_fingerprint: 'sha256:current',
      current_valid_until: 8_000_000,
    };
    const result = applyRotationNoticeToState(
      current,
      noticeEvent({ rotation_at: 500 }),
      1_000,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('rotation_at_in_past');
  });

  it('preserves previous_fingerprint across a notice (slice 115 follow-up)', () => {
    // A notice stages the NEXT rotation but doesn't complete it (no
    // promotion yet). The prior rollback target (the previous_finger-
    // print from an earlier passport-fetch promotion) is still valid
    // until a subsequent promotion overwrites it or a revert consumes
    // it.
    const promoted: WebclientCertPinState = {
      current_fingerprint: 'sha256:current',
      previous_fingerprint: 'sha256:older',
      current_valid_until: 8_000_000,
    };
    const result = applyRotationNoticeToState(promoted, noticeEvent(), 1_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.previous_fingerprint).toBe('sha256:older');
      expect(result.next.next_fingerprint).toBe('sha256:next');
    }
  });
});

// ════════════════════════════════════════════════════════════════
// applyRotationRevertedToState
// ════════════════════════════════════════════════════════════════

describe('D-148 § A.6.5 — applyRotationRevertedToState (pure transition)', () => {
  const revertedEvent = (
    over?: Partial<Extract<ServerEvent, { kind: 'cert.rotation_reverted' }>>,
  ): Extract<ServerEvent, { kind: 'cert.rotation_reverted' }> => ({
    kind: 'cert.rotation_reverted',
    reverted_to_fingerprint: 'sha256:was_current',
    reverted_at: 6_000_000,
    signature: 'sig',
    signer_fingerprint: 'sha256:signer',
    cursor: 1,
    ...over,
  });

  it('reverts to current + clears next when target matches current', () => {
    const staged: WebclientCertPinState = {
      current_fingerprint: 'sha256:was_current',
      next_fingerprint: 'sha256:was_next',
      current_valid_until: 5_000_000,
    };
    const result = applyRotationRevertedToState(staged, revertedEvent());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.current_fingerprint).toBe('sha256:was_current');
      expect(result.next.next_fingerprint).toBeUndefined();
      expect(result.next.last_rotated_at).toBe(6_000_000);
    }
  });

  it('reverts to next when target matches the staged next', () => {
    const staged: WebclientCertPinState = {
      current_fingerprint: 'sha256:current',
      next_fingerprint: 'sha256:reverted',
      current_valid_until: 5_000_000,
    };
    const result = applyRotationRevertedToState(
      staged,
      revertedEvent({ reverted_to_fingerprint: 'sha256:reverted' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.current_fingerprint).toBe('sha256:reverted');
  });

  it('rejects pin_unknown_revert_target (Codex P2 fold)', () => {
    const staged: WebclientCertPinState = {
      current_fingerprint: 'sha256:was_current',
      next_fingerprint: 'sha256:was_next',
      current_valid_until: 5_000_000,
    };
    const result = applyRotationRevertedToState(
      staged,
      revertedEvent({ reverted_to_fingerprint: 'sha256:unrelated' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('pin_unknown_revert_target');
  });

  it('rejects when no prior state exists (nothing to revert to)', () => {
    const result = applyRotationRevertedToState(null, revertedEvent());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('pin_unknown_revert_target');
  });

  it('preserves existing current_valid_until when present', () => {
    const staged: WebclientCertPinState = {
      current_fingerprint: 'sha256:was_current',
      current_valid_until: 9_000_000,
    };
    const result = applyRotationRevertedToState(staged, revertedEvent());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.current_valid_until).toBe(9_000_000);
  });

  it('reverts to previous_fingerprint when target matches the retained prior-current within the window (Codex P2 fold, slice 115 follow-up)', () => {
    // Closes the post-promotion rollback gap: passport-fetch promoted
    // {current:A, next:B} → {current:B, previous:A}; a subsequent
    // revert naming A must find a trusted target. Pre-fold this would
    // reject as pin_unknown_revert_target.
    const promoted: WebclientCertPinState = {
      current_fingerprint: 'sha256:promoted',
      previous_fingerprint: 'sha256:was_current',
      previous_valid_until: 10_000_000,
      current_valid_until: 9_000_000,
      last_rotated_at: 5_000_000,
    };
    const result = applyRotationRevertedToState(
      promoted,
      revertedEvent({ reverted_to_fingerprint: 'sha256:was_current' }),
      6_000_000, // within window (< previous_valid_until = 10_000_000)
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.current_fingerprint).toBe('sha256:was_current');
      // previous_* cleared — the rollback target has become the new
      // pinned current; no longer a "prior" to keep around.
      expect(result.next.previous_fingerprint).toBeUndefined();
      expect(result.next.previous_valid_until).toBeUndefined();
      expect(result.next.next_fingerprint).toBeUndefined();
      expect(result.next.last_rotated_at).toBe(6_000_000);
    }
  });

  it('rejects pin_unknown_revert_target when previous_fingerprint match is past the window (Codex P2 fold, slice 116)', () => {
    // Stale-but-signed `cert.rotation_reverted` replay defense — a
    // revert naming previous after the overlap window has elapsed
    // should NOT roll the pin back to a decommissioned cert.
    const promoted: WebclientCertPinState = {
      current_fingerprint: 'sha256:promoted',
      previous_fingerprint: 'sha256:was_current',
      previous_valid_until: 10_000_000,
      current_valid_until: 9_000_000,
      last_rotated_at: 5_000_000,
    };
    const result = applyRotationRevertedToState(
      promoted,
      revertedEvent({ reverted_to_fingerprint: 'sha256:was_current' }),
      11_000_000, // past window (> previous_valid_until = 10_000_000)
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('pin_unknown_revert_target');
  });

  it('rejects previous_fingerprint match when previous_valid_until is unset (defense-in-depth)', () => {
    // Promotion always sets both fields together; a pin that has
    // previous_fingerprint without previous_valid_until is a defensive
    // null state — reject rather than honor a stale slot.
    const malformed: WebclientCertPinState = {
      current_fingerprint: 'sha256:current',
      previous_fingerprint: 'sha256:was_current',
      // previous_valid_until intentionally undefined
      current_valid_until: 9_000_000,
    };
    const result = applyRotationRevertedToState(
      malformed,
      revertedEvent({ reverted_to_fingerprint: 'sha256:was_current' }),
      6_000_000,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('pin_unknown_revert_target');
  });

  it('skips the previous window check when now is undefined (BACK-COMPAT for legacy callers)', () => {
    // Legacy callers that don't thread a clock get the pre-fold
    // behavior — match on previous if the slot exists. The
    // recommended path (cert-pin handler + verify orchestrator)
    // always threads now; this branch keeps existing call sites
    // compiling without an immediate audit-blocked rollout.
    const promoted: WebclientCertPinState = {
      current_fingerprint: 'sha256:promoted',
      previous_fingerprint: 'sha256:was_current',
      previous_valid_until: 10_000_000,
      current_valid_until: 9_000_000,
    };
    const result = applyRotationRevertedToState(
      promoted,
      revertedEvent({ reverted_to_fingerprint: 'sha256:was_current' }),
      // now: undefined
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.current_fingerprint).toBe('sha256:was_current');
    }
  });

  it('rejects pin_unknown_revert_target when none of current/next/previous match', () => {
    // Sanity check that previous_fingerprint widens the accept set but
    // doesn't make every revert valid.
    const promoted: WebclientCertPinState = {
      current_fingerprint: 'sha256:current',
      next_fingerprint: 'sha256:next',
      previous_fingerprint: 'sha256:previous',
      previous_valid_until: 10_000_000,
      current_valid_until: 5_000_000,
    };
    const result = applyRotationRevertedToState(
      promoted,
      revertedEvent({ reverted_to_fingerprint: 'sha256:wild' }),
      6_000_000,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('pin_unknown_revert_target');
  });
});

// ════════════════════════════════════════════════════════════════
// createCertPinHandler — signature path + persistence
// ════════════════════════════════════════════════════════════════

interface KeyFixture {
  pubkeyB64: string;
  privateKey: CryptoKey;
}

const generateEd25519Fixture = async (): Promise<KeyFixture> => {
  const kp = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as unknown as { privateKey: CryptoKey; publicKey: CryptoKey };
  const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
  return { pubkeyB64: bytesToBase64(new Uint8Array(spki)), privateKey: kp.privateKey };
};

const signTranscript = async (
  privateKey: CryptoKey,
  transcript: Uint8Array,
): Promise<string> => {
  const sig = await crypto.subtle.sign(
    { name: 'Ed25519' },
    privateKey,
    transcript as BufferSource,
  );
  return bytesToBase64(new Uint8Array(sig));
};

const seedStoreWithServerKey = async (
  pubkeyB64: string,
): Promise<WebclientLocalStore> => {
  const store = createInMemoryWebclientLocalStore();
  await store.set('server_public_key', pubkeyB64);
  return store;
};

// `handler.flush()` is the test affordance for draining the internal
// serialization chain — tests await it after `subscriber.dispatch(...)`.

describe('D-148 § A.6.5 — createCertPinHandler (signature + persist)', () => {
  it('persists next_fingerprint on a validly-signed rotation_notice', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const store = await seedStoreWithServerKey(key.pubkeyB64);
    const subscriber: BroadcastSubscriber = createBroadcastSubscriber();
    // Clock seeded behind rotation_at so the `rotation_at_in_past`
    // gate doesn't reject the notice.
    const handle = createCertPinHandler({
      localStore: store,
      subscriber,
      now: () => 1_000,
    });

    // Server-compatible transcript: literal-order `{current_fp,
    // next_fp, rotation_at, type}` via plain JSON.stringify.
    const transcript = new TextEncoder().encode(
      JSON.stringify({
        current_fingerprint: 'sha256:c',
        next_fingerprint: 'sha256:n',
        rotation_at: 5_000_000,
        type: 'cert_rotation_notice',
      }),
    );
    const signature = await signTranscript(key.privateKey, transcript);

    subscriber.dispatch({
      kind: 'cert.rotation_notice',
      current_fingerprint: 'sha256:c',
      next_fingerprint: 'sha256:n',
      rotation_at: 5_000_000,
      signature,
      signer_fingerprint: 'sha256:signer',
      emitted_at: 4_900_000,
      cursor: 1,
    });
    await handle.flush();

    const persisted = await store.get('cert_pin_state');
    expect(persisted?.next_fingerprint).toBe('sha256:n');
    expect(persisted?.current_valid_until).toBe(5_000_000);
  });

  it('drops a forged rotation_notice silently + reports verify failure', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const store = await seedStoreWithServerKey(key.pubkeyB64);
    const subscriber: BroadcastSubscriber = createBroadcastSubscriber();
    const failures: CertPinFailureContext[] = [];
    const handle = createCertPinHandler({
      localStore: store,
      subscriber,
      onError: (_err, ctx) => failures.push(ctx),
    });

    subscriber.dispatch({
      kind: 'cert.rotation_notice',
      current_fingerprint: 'sha256:c',
      next_fingerprint: 'sha256:n',
      rotation_at: 5_000_000,
      signature: 'AAAA',
      signer_fingerprint: 'sha256:signer',
      emitted_at: 4_900_000,
      cursor: 1,
    });
    await handle.flush();

    expect(failures.length).toBe(1);
    expect(failures[0]).toEqual({ stage: 'verify', kind: 'cert.rotation_notice' });
    expect(await store.get('cert_pin_state')).toBeNull();
  });

  it('reports read_pair_context when server_public_key is missing', async () => {
    if (!(await ed25519Available())) return;
    // Store seeded WITHOUT server_public_key.
    const store = createInMemoryWebclientLocalStore();
    const subscriber: BroadcastSubscriber = createBroadcastSubscriber();
    const failures: CertPinFailureContext[] = [];
    const handle = createCertPinHandler({
      localStore: store,
      subscriber,
      onError: (_err, ctx) => failures.push(ctx),
    });
    subscriber.dispatch({
      kind: 'cert.rotation_notice',
      current_fingerprint: 'sha256:c',
      next_fingerprint: 'sha256:n',
      rotation_at: 5_000_000,
      signature: 'AAAA',
      signer_fingerprint: 'sha256:signer',
      emitted_at: 4_900_000,
      cursor: 1,
    });
    await handle.flush();
    expect(failures.length).toBe(1);
    expect(failures[0]).toEqual({
      stage: 'read_pair_context',
      kind: 'cert.rotation_notice',
    });
  });

  it('persists rotation_reverted state with a valid signature', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const store = await seedStoreWithServerKey(key.pubkeyB64);
    // Seed a staged-rotation state with a `next_fingerprint` that
    // matches the upcoming revert target — the new gate rejects any
    // unknown revert target.
    await store.set('cert_pin_state', {
      current_fingerprint: 'sha256:current',
      next_fingerprint: 'sha256:was_next',
      current_valid_until: 5_000_000,
    });
    const subscriber: BroadcastSubscriber = createBroadcastSubscriber();
    const handle = createCertPinHandler({ localStore: store, subscriber });

    // Server-compatible transcript: `{reverted_to_fingerprint,
    // reason: reason ?? null, reverted_at, type}` via plain
    // JSON.stringify. `reason: null` MUST be present (Codex P2 fold).
    const transcript = new TextEncoder().encode(
      JSON.stringify({
        reverted_to_fingerprint: 'sha256:was_next',
        reason: null,
        reverted_at: 6_000_000,
        type: 'cert_rotation_reverted',
      }),
    );
    const signature = await signTranscript(key.privateKey, transcript);

    subscriber.dispatch({
      kind: 'cert.rotation_reverted',
      reverted_to_fingerprint: 'sha256:was_next',
      reverted_at: 6_000_000,
      signature,
      signer_fingerprint: 'sha256:signer',
      cursor: 2,
    });
    await handle.flush();

    const persisted = await store.get('cert_pin_state');
    expect(persisted?.current_fingerprint).toBe('sha256:was_next');
    expect(persisted?.next_fingerprint).toBeUndefined();
    expect(persisted?.last_rotated_at).toBe(6_000_000);
  });

  it('serializes back-to-back notices through the internal promise chain', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const store = await seedStoreWithServerKey(key.pubkeyB64);
    // Seed an initial pin so the first notice doesn't need to seed
    // `current` from the notice itself.
    await store.set('cert_pin_state', {
      current_fingerprint: 'sha256:pinned',
      current_valid_until: 1_000_000,
    });
    const subscriber: BroadcastSubscriber = createBroadcastSubscriber();
    const handle = createCertPinHandler({
      localStore: store,
      subscriber,
      now: () => 1_000,
    });

    const fireNotice = async (next_fp: string, rotation_at: number): Promise<void> => {
      // Server-compatible literal-order transcript.
      const transcript = new TextEncoder().encode(
        JSON.stringify({
          current_fingerprint: 'sha256:pinned',
          next_fingerprint: next_fp,
          rotation_at,
          type: 'cert_rotation_notice',
        }),
      );
      const sig = await signTranscript(key.privateKey, transcript);
      subscriber.dispatch({
        kind: 'cert.rotation_notice',
        current_fingerprint: 'sha256:pinned',
        next_fingerprint: next_fp,
        rotation_at,
        signature: sig,
        signer_fingerprint: 'sha256:signer',
        emitted_at: rotation_at - 100,
        cursor: rotation_at,
      });
    };

    await fireNotice('sha256:next_a', 2_000_000);
    await fireNotice('sha256:next_b', 3_000_000);
    await handle.flush();
    const persisted = await store.get('cert_pin_state');
    // The later notice wins.
    expect(persisted?.next_fingerprint).toBe('sha256:next_b');
    expect(persisted?.current_valid_until).toBe(3_000_000);
  });

  it('rejects current_fingerprint_mismatch on a signed but stale-lineage notice (Codex P2 fold)', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const store = await seedStoreWithServerKey(key.pubkeyB64);
    await store.set('cert_pin_state', {
      current_fingerprint: 'sha256:pinned',
      current_valid_until: 1_000_000,
    });
    const subscriber: BroadcastSubscriber = createBroadcastSubscriber();
    const failures: CertPinFailureContext[] = [];
    const handle = createCertPinHandler({
      localStore: store,
      subscriber,
      now: () => 1_000,
      onError: (_err, ctx) => failures.push(ctx),
    });
    const transcript = new TextEncoder().encode(
      JSON.stringify({
        current_fingerprint: 'sha256:divergent',
        next_fingerprint: 'sha256:n',
        rotation_at: 5_000_000,
        type: 'cert_rotation_notice',
      }),
    );
    const sig = await signTranscript(key.privateKey, transcript);
    subscriber.dispatch({
      kind: 'cert.rotation_notice',
      current_fingerprint: 'sha256:divergent',
      next_fingerprint: 'sha256:n',
      rotation_at: 5_000_000,
      signature: sig,
      signer_fingerprint: 'sha256:signer',
      emitted_at: 4_900_000,
      cursor: 1,
    });
    await handle.flush();
    expect(failures.length).toBe(1);
    expect(failures[0].stage).toBe('current_fingerprint_mismatch');
    // No persistence on rejection.
    const persisted = await store.get('cert_pin_state');
    expect(persisted?.next_fingerprint).toBeUndefined();
    expect(persisted?.current_fingerprint).toBe('sha256:pinned');
  });

  it('rejects pin_unknown_revert_target on a revert to an untrusted fingerprint (Codex P2 fold)', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const store = await seedStoreWithServerKey(key.pubkeyB64);
    await store.set('cert_pin_state', {
      current_fingerprint: 'sha256:current',
      next_fingerprint: 'sha256:next',
      current_valid_until: 8_000_000,
    });
    const subscriber: BroadcastSubscriber = createBroadcastSubscriber();
    const failures: CertPinFailureContext[] = [];
    const handle = createCertPinHandler({
      localStore: store,
      subscriber,
      onError: (_err, ctx) => failures.push(ctx),
    });
    const transcript = new TextEncoder().encode(
      JSON.stringify({
        reverted_to_fingerprint: 'sha256:unrelated',
        reason: null,
        reverted_at: 6_000_000,
        type: 'cert_rotation_reverted',
      }),
    );
    const sig = await signTranscript(key.privateKey, transcript);
    subscriber.dispatch({
      kind: 'cert.rotation_reverted',
      reverted_to_fingerprint: 'sha256:unrelated',
      reverted_at: 6_000_000,
      signature: sig,
      signer_fingerprint: 'sha256:signer',
      cursor: 1,
    });
    await handle.flush();
    expect(failures.length).toBe(1);
    expect(failures[0].stage).toBe('pin_unknown_revert_target');
    // The current + next pin stays intact.
    const persisted = await store.get('cert_pin_state');
    expect(persisted?.current_fingerprint).toBe('sha256:current');
    expect(persisted?.next_fingerprint).toBe('sha256:next');
  });

  it('dispose detaches the subscription', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const store = await seedStoreWithServerKey(key.pubkeyB64);
    const subscriber: BroadcastSubscriber = createBroadcastSubscriber();
    const handle = createCertPinHandler({ localStore: store, subscriber });
    expect(subscriber.size('cert.rotation_notice')).toBe(1);
    expect(subscriber.size('cert.rotation_reverted')).toBe(1);
    handle.dispose();
    expect(subscriber.size('cert.rotation_notice')).toBe(0);
    expect(subscriber.size('cert.rotation_reverted')).toBe(0);
  });

  it('failure-sink throws are isolated from the dispatch loop', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const store = await seedStoreWithServerKey(key.pubkeyB64);
    const subscriber: BroadcastSubscriber = createBroadcastSubscriber();
    createCertPinHandler({
      localStore: store,
      subscriber,
      onError: () => {
        throw new Error('test sink throws');
      },
    });
    // Bad signature → triggers the onError sink → throw should be
    // swallowed by the handler.
    expect(() => {
      subscriber.dispatch({
        kind: 'cert.rotation_notice',
        current_fingerprint: 'sha256:c',
        next_fingerprint: 'sha256:n',
        rotation_at: 5_000_000,
        signature: 'AAAA',
        signer_fingerprint: 'sha256:signer',
        emitted_at: 4_900_000,
        cursor: 1,
      });
    }).not.toThrow();
  });

  // Slice 113 — `onStateChanged` hook for the cert-pin state watcher.
  it('fires onStateChanged after a successful rotation_notice persist', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const store = await seedStoreWithServerKey(key.pubkeyB64);
    const subscriber: BroadcastSubscriber = createBroadcastSubscriber();
    const observed: Array<{ current?: string; next?: string }> = [];
    const handle = createCertPinHandler({
      localStore: store,
      subscriber,
      now: () => 1_000,
      onStateChanged: (state) => {
        observed.push({
          ...(state.current_fingerprint !== undefined
            ? { current: state.current_fingerprint }
            : {}),
          ...(state.next_fingerprint !== undefined
            ? { next: state.next_fingerprint }
            : {}),
        });
      },
    });
    const transcript = new TextEncoder().encode(
      JSON.stringify({
        current_fingerprint: 'sha256:c',
        next_fingerprint: 'sha256:n',
        rotation_at: 5_000_000,
        type: 'cert_rotation_notice',
      }),
    );
    const signature = await signTranscript(key.privateKey, transcript);
    subscriber.dispatch({
      kind: 'cert.rotation_notice',
      current_fingerprint: 'sha256:c',
      next_fingerprint: 'sha256:n',
      rotation_at: 5_000_000,
      signature,
      signer_fingerprint: 'sha256:signer',
      emitted_at: 4_900_000,
      cursor: 1,
    });
    await handle.flush();
    expect(observed).toEqual([{ current: 'sha256:c', next: 'sha256:n' }]);
  });

  it('does NOT fire onStateChanged when persist fails', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    // Wrap the seeded store so `set('cert_pin_state', …)` rejects but
    // the server_public_key read still succeeds.
    const baseStore = await seedStoreWithServerKey(key.pubkeyB64);
    const failingStore = {
      get: baseStore.get.bind(baseStore),
      set: (k: string, v: unknown) => {
        if (k === 'cert_pin_state') {
          return Promise.reject(new Error('idb dead'));
        }
        return baseStore.set(
          k as Parameters<typeof baseStore.set>[0],
          v as Parameters<typeof baseStore.set>[1],
        );
      },
      remove: baseStore.remove.bind(baseStore),
      clear: baseStore.clear.bind(baseStore),
      inspect: baseStore.inspect.bind(baseStore),
    };
    const subscriber: BroadcastSubscriber = createBroadcastSubscriber();
    const observed: Array<unknown> = [];
    const failures: CertPinFailureContext[] = [];
    const handle = createCertPinHandler({
      localStore: failingStore,
      subscriber,
      now: () => 1_000,
      onError: (_err, ctx) => failures.push(ctx),
      onStateChanged: (state) => observed.push(state),
    });
    const transcript = new TextEncoder().encode(
      JSON.stringify({
        current_fingerprint: 'sha256:c',
        next_fingerprint: 'sha256:n',
        rotation_at: 5_000_000,
        type: 'cert_rotation_notice',
      }),
    );
    const signature = await signTranscript(key.privateKey, transcript);
    subscriber.dispatch({
      kind: 'cert.rotation_notice',
      current_fingerprint: 'sha256:c',
      next_fingerprint: 'sha256:n',
      rotation_at: 5_000_000,
      signature,
      signer_fingerprint: 'sha256:signer',
      emitted_at: 4_900_000,
      cursor: 1,
    });
    await handle.flush();
    expect(failures.map((f) => f.stage)).toEqual(['persist']);
    expect(observed).toEqual([]);
  });

  it('onStateChanged throws are isolated from the dispatch loop', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const store = await seedStoreWithServerKey(key.pubkeyB64);
    const subscriber: BroadcastSubscriber = createBroadcastSubscriber();
    const handle = createCertPinHandler({
      localStore: store,
      subscriber,
      now: () => 1_000,
      onStateChanged: () => {
        throw new Error('test state-changed sink throws');
      },
    });
    const transcript = new TextEncoder().encode(
      JSON.stringify({
        current_fingerprint: 'sha256:c',
        next_fingerprint: 'sha256:n',
        rotation_at: 5_000_000,
        type: 'cert_rotation_notice',
      }),
    );
    const signature = await signTranscript(key.privateKey, transcript);
    subscriber.dispatch({
      kind: 'cert.rotation_notice',
      current_fingerprint: 'sha256:c',
      next_fingerprint: 'sha256:n',
      rotation_at: 5_000_000,
      signature,
      signer_fingerprint: 'sha256:signer',
      emitted_at: 4_900_000,
      cursor: 1,
    });
    await expect(handle.flush()).resolves.not.toThrow();
    const persisted = await store.get('cert_pin_state');
    expect(persisted?.next_fingerprint).toBe('sha256:n');
  });
});
