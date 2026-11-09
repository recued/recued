/** The service worker's pairing session (`pairing/worker-pairing.ts`).
 *
 *  What these pin, in the order a pairing meets them:
 *    - one attempt at a time, claimed before anything awaits;
 *    - nothing is posted to a paired bridge, or past a held pairing;
 *    - an instance id goes with every pair;
 *    - the accepted reply is held BEFORE setup runs, and finishing uses it
 *      without ever posting the spent code;
 *    - success drops the reply, then starts the paired runtime in place
 *      (no extension restart, which would close the side panel) before
 *      answering;
 *    - a side panel opened mid-attempt can ask where things stand, and
 *      wait them out.
 *
 *  The fake server spends its code on the first post and refuses every later
 *  one, as `/auth/pair` does — a fake that accepted twice could not tell a
 *  second post from a finish. */

import { describe, expect, it, vi } from 'vitest';

import {
  createBridgeWorkerPairing,
  parseBridgePairStartInput,
  type BridgeWorkerPairingDeps,
} from '../pairing/worker-pairing.js';
import type { BridgePairCodeInputCommitOptions } from '../pairing/pair-code-input-host.js';
import type { BridgePairFinalizeResult } from '../pairing/pair-completion.js';
import type { BridgeAcceptedPair, BridgePendingPairStore } from '../pairing/pending-pair-store.js';

const URL_ = 'https://review.example';
const CODE = 'ABC12345';
const PASSPORT = { identity: { server_public_key: 'PUBKEY', current_handle: '' } };

/** `/auth/pair` as the pairing session sees it: the code works once. */
const buildSubmit = () => {
  const posts: BridgePairCodeInputCommitOptions[] = [];
  let spent = false;
  const submit = vi.fn(async (options: BridgePairCodeInputCommitOptions) => {
    posts.push(options);
    if (!spent && options.code === CODE) {
      spent = true;
      return { ok: true as const, token: 'bearer-1', token_id: 'tok-1', passport: PASSPORT };
    }
    return { ok: false as const, error: 'invalid_code' as const };
  });
  return { submit, posts };
};

const buildStore = () => {
  let saved: BridgeAcceptedPair | null = null;
  const store: BridgePendingPairStore & { readonly saved: BridgeAcceptedPair | null } = {
    get saved() {
      return saved;
    },
    load: vi.fn(async () => saved),
    save: vi.fn(async (p: BridgeAcceptedPair) => {
      saved = { ...p };
    }),
    clear: vi.fn(async () => {
      saved = null;
    }),
  };
  return store;
};

const OK: BridgePairFinalizeResult = { ok: true, server_url: 'wss://review.example/ws', token_id: 'tok-1' };
const PERSIST_FAILED: BridgePairFinalizeResult = {
  ok: false,
  error: 'pair_completion_persist_failed',
  detail: 'token-store wrap: OperationError',
};

const build = (overrides: Partial<BridgeWorkerPairingDeps> = {}) => {
  const server = buildSubmit();
  const store = buildStore();
  const finalize = vi.fn(async (_a: BridgeAcceptedPair): Promise<BridgePairFinalizeResult> => OK);
  const onPaired = vi.fn(async () => undefined);
  const deps: BridgeWorkerPairingDeps = {
    submit: server.submit,
    finalize,
    readPaired: async () => null,
    pendingStore: store,
    onPaired,
    mintInstanceId: () => 'inst-1',
    ...overrides,
  };
  return { pairing: createBridgeWorkerPairing(deps), server, store, finalize, onPaired };
};

describe('worker pairing — start', () => {
  it('posts the code with an instance id, holds the reply BEFORE setup, then finishes', async () => {
    const t = build();
    const order: string[] = [];
    (t.store.save as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('held');
    });
    t.finalize.mockImplementation(async (accepted) => {
      order.push('finalize');
      expect(accepted).toEqual({
        serverUrl: URL_,
        token: 'bearer-1',
        token_id: 'tok-1',
        passport: PASSPORT,
        instanceId: 'inst-1',
      });
      return OK;
    });

    const outcome = await t.pairing.start({ serverUrl: URL_, code: CODE, displayName: 'Chrome on Windows' });

    expect(outcome).toEqual({ ok: true, serverUrl: URL_ });
    expect(t.server.posts).toEqual([
      { serverUrl: URL_, code: CODE, displayName: 'Chrome on Windows', instanceId: 'inst-1' },
    ]);
    expect(order).toEqual(['held', 'finalize']);
  });

  it('drops the reply, then starts the paired runtime ONCE before answering', async () => {
    const t = build();
    const heldAtStart: Array<BridgeAcceptedPair | null> = [];
    let started!: () => void;
    t.onPaired.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          heldAtStart.push(t.store.saved);
          started = () => resolve(undefined);
        }),
    );
    let answered = false;
    const pairing = t.pairing.start({ serverUrl: URL_, code: CODE }).then((outcome) => {
      answered = true;
      return outcome;
    });
    await vi.waitFor(() => expect(t.onPaired).toHaveBeenCalledTimes(1));
    // The panel's next status read must find the runtime coming up, so the
    // answer waits for the start.
    expect(answered).toBe(false);
    started();
    expect(await pairing).toEqual({ ok: true, serverUrl: URL_ });
    // The held reply was already dropped when the runtime started.
    expect(heldAtStart).toEqual([null]);
    expect(t.onPaired).toHaveBeenCalledTimes(1);
    expect(await t.pairing.status()).toEqual({ state: 'unpaired' }); // readPaired fake stays null
  });

  it('no runtime start for a pairing that did not finish', async () => {
    const t = build();
    t.finalize.mockResolvedValueOnce(PERSIST_FAILED);
    await t.pairing.start({ serverUrl: URL_, code: CODE });
    expect(t.onPaired).not.toHaveBeenCalled();
    await t.pairing.start({ serverUrl: URL_, code: 'WRONG' });
    expect(t.onPaired).not.toHaveBeenCalled();
  });

  it('never sends the recovery key anywhere but the POST, and holds none', async () => {
    const t = build();
    await t.pairing.start({ serverUrl: URL_, code: CODE, recoveryKey: 'word '.repeat(24).trim() });
    expect(t.server.posts[0].recoveryKey).toBe('word '.repeat(24).trim());
    const held = (t.store.save as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.stringify(held)).not.toContain('word word');
    expect(JSON.stringify(t.finalize.mock.calls[0][0])).not.toContain('word word');
  });

  it('refuses a paired bridge before posting anything', async () => {
    const t = build({ readPaired: async () => ({ serverUrl: 'wss://review.example/ws' }) });
    const outcome = await t.pairing.start({ serverUrl: URL_, code: CODE });
    expect(outcome).toEqual({ ok: false, kind: 'paired', serverUrl: 'wss://review.example/ws' });
    expect(t.server.posts).toHaveLength(0);
  });

  it('refuses to post past a held pairing — it can only be finished', async () => {
    const t = build();
    await t.store.save({ serverUrl: URL_, token: 'bearer-0', token_id: 'tok-0' });
    const outcome = await t.pairing.start({ serverUrl: URL_, code: CODE });
    expect(outcome).toEqual({ ok: false, kind: 'accepted', serverUrl: URL_ });
    expect(t.server.posts).toHaveLength(0);
  });

  it('⛔ claims the slot before anything awaits: a second start in the same turn is busy and posts nothing', async () => {
    const t = build();
    const first = t.pairing.start({ serverUrl: URL_, code: CODE });
    const second = t.pairing.start({ serverUrl: URL_, code: CODE });
    expect(await second).toEqual({ ok: false, kind: 'busy', serverUrl: URL_ });
    expect((await first).ok).toBe(true);
    expect(t.server.posts).toHaveLength(1);
  });

  it('passes a refusal through, holds nothing, and frees the slot', async () => {
    const t = build();
    t.server.submit.mockResolvedValueOnce({
      ok: false,
      error: 'pair_code_input_server_refused',
      detail: 'Back at 14:00',
      serverSaid: 'Back at 14:00',
      serverCode: 'realm_sealed_for_maintenance',
    } as never);
    const outcome = await t.pairing.start({ serverUrl: URL_, code: CODE });
    expect(outcome).toEqual({
      ok: false,
      kind: 'refused',
      error: 'pair_code_input_server_refused',
      detail: 'Back at 14:00',
      serverSaid: 'Back at 14:00',
      serverCode: 'realm_sealed_for_maintenance',
    });
    expect(t.store.saved).toBeNull();
    expect(t.finalize).not.toHaveBeenCalled();
    expect(await t.pairing.status()).toEqual({ state: 'unpaired' });
  });
});

describe('worker pairing — an accepted pairing is finished, never sent again (DD#6)', () => {
  it('a failed setup keeps the reply; finish completes it without posting', async () => {
    const t = build();
    t.finalize.mockResolvedValueOnce(PERSIST_FAILED);
    const first = await t.pairing.start({ serverUrl: URL_, code: CODE });
    expect(first).toEqual({
      ok: false,
      kind: 'accepted',
      serverUrl: URL_,
      reason: 'pair_completion_persist_failed',
      detail: 'token-store wrap: OperationError',
    });
    expect(await t.pairing.status()).toEqual({ state: 'accepted', serverUrl: URL_ });

    const finished = await t.pairing.finish();
    expect(finished).toEqual({ ok: true, serverUrl: URL_ });
    expect(t.server.posts).toHaveLength(1);
    expect(t.finalize).toHaveBeenCalledTimes(2);
    expect(t.finalize.mock.calls[1][0]).toEqual(t.finalize.mock.calls[0][0]);
    expect(t.store.saved).toBeNull();
  });

  it('a worker that restarted finishes from the store', async () => {
    const t = build();
    t.finalize.mockResolvedValueOnce(PERSIST_FAILED);
    await t.pairing.start({ serverUrl: URL_, code: CODE });

    // Chrome stopped the idle worker; a new one wakes with the same store.
    const finalize = vi.fn(async (_a: BridgeAcceptedPair): Promise<BridgePairFinalizeResult> => OK);
    const restarted = createBridgeWorkerPairing({
      submit: t.server.submit,
      finalize,
      readPaired: async () => null,
      pendingStore: t.store,
    });
    expect(await restarted.status()).toEqual({ state: 'accepted', serverUrl: URL_ });
    expect(await restarted.finish()).toEqual({ ok: true, serverUrl: URL_ });
    expect(finalize.mock.calls[0][0]).toMatchObject({ token: 'bearer-1', instanceId: 'inst-1' });
    expect(t.server.posts).toHaveLength(1);
  });

  it('a store that cannot save still finishes from memory', async () => {
    const t = build();
    (t.store.save as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('QUOTA_BYTES'));
    (t.store.load as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('unreadable'));
    t.finalize.mockResolvedValueOnce(PERSIST_FAILED);
    await t.pairing.start({ serverUrl: URL_, code: CODE });
    expect(await t.pairing.finish()).toEqual({ ok: true, serverUrl: URL_ });
    expect(t.server.posts).toHaveLength(1);
  });

  it('a finalize that throws is a failed setup, not a lost pairing', async () => {
    const t = build();
    t.finalize.mockRejectedValueOnce(new Error('boom'));
    const outcome = await t.pairing.start({ serverUrl: URL_, code: CODE });
    expect(outcome).toMatchObject({
      ok: false,
      kind: 'accepted',
      reason: 'pair_completion_persist_failed',
      detail: 'finalize crashed: boom',
    });
    expect(t.store.saved).not.toBeNull();
  });

  it('a final setup error drops the reply instead of offering a retry', async () => {
    const t = build();
    t.finalize.mockResolvedValueOnce({ ok: false, error: 'pair_completion_invalid_server_url' });
    const outcome = await t.pairing.start({ serverUrl: URL_, code: CODE });
    expect(outcome).toEqual({ ok: false, kind: 'final', error: 'pair_completion_invalid_server_url' });
    expect(t.store.saved).toBeNull();
    expect(await t.pairing.finish()).toEqual({ ok: false, kind: 'nothing_to_finish' });
  });

  it('finish with nothing held says so (a browser restart empties session storage)', async () => {
    const t = build();
    expect(await t.pairing.finish()).toEqual({ ok: false, kind: 'nothing_to_finish' });
    expect(t.finalize).not.toHaveBeenCalled();
  });

  it('abandon drops the held reply; a fresh code can then be posted', async () => {
    const t = build();
    t.finalize.mockResolvedValueOnce(PERSIST_FAILED);
    await t.pairing.start({ serverUrl: URL_, code: CODE });
    expect(await t.pairing.abandon()).toEqual({ ok: true });
    expect(t.store.saved).toBeNull();
    expect(await t.pairing.status()).toEqual({ state: 'unpaired' });
  });

  it('abandon is refused while an attempt runs', async () => {
    const t = build();
    let release!: (v: BridgePairFinalizeResult) => void;
    t.finalize.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const running = t.pairing.start({ serverUrl: URL_, code: CODE });
    await vi.waitFor(() => expect(t.finalize).toHaveBeenCalled());
    expect(await t.pairing.abandon()).toEqual({ ok: false });
    release(OK);
    expect((await running).ok).toBe(true);
  });
});

describe('worker pairing — a side panel opened mid-attempt can follow it', () => {
  it('status says pairing while the server is answering, and wait() hands back the outcome', async () => {
    const t = build();
    let answer!: () => void;
    t.server.submit.mockImplementationOnce(
      (options) =>
        new Promise((resolve) => {
          answer = () =>
            resolve({ ok: true, token: 'bearer-1', token_id: 'tok-1', passport: PASSPORT } as never);
          void options;
        }),
    );
    const running = t.pairing.start({ serverUrl: URL_, code: CODE });
    await vi.waitFor(() => expect(t.server.submit).toHaveBeenCalled());
    expect(await t.pairing.status()).toEqual({ state: 'pairing', serverUrl: URL_ });
    const waited = t.pairing.wait();
    answer();
    expect(await waited).toEqual({ ok: true, serverUrl: URL_ });
    expect(await running).toEqual({ ok: true, serverUrl: URL_ });
    expect(await t.pairing.wait()).toBeNull();
  });

  it('a finish in flight reports the held server once it has loaded it', async () => {
    const t = build();
    t.finalize.mockResolvedValueOnce(PERSIST_FAILED);
    await t.pairing.start({ serverUrl: URL_, code: CODE });
    let release!: (v: BridgePairFinalizeResult) => void;
    t.finalize.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const finishing = t.pairing.finish();
    await vi.waitFor(() => expect(t.finalize).toHaveBeenCalledTimes(2));
    expect(await t.pairing.status()).toEqual({ state: 'pairing', serverUrl: URL_ });
    expect(await t.pairing.finish()).toEqual({ ok: false, kind: 'busy', serverUrl: URL_ });
    release(OK);
    expect(await finishing).toEqual({ ok: true, serverUrl: URL_ });
  });

  it('paired wins over a stale held reply', async () => {
    const t = build({ readPaired: async () => ({ serverUrl: 'wss://review.example/ws' }) });
    await t.store.save({ serverUrl: URL_, token: 'bearer-0' });
    expect(await t.pairing.status()).toEqual({ state: 'paired', serverUrl: 'wss://review.example/ws' });
  });

  it('a runtime start that fails does not undo the pairing', async () => {
    for (const onPaired of [
      () => {
        throw new Error('sync');
      },
      () => Promise.reject(new Error('async')),
    ]) {
      const t = build({ onPaired });
      expect(await t.pairing.start({ serverUrl: URL_, code: CODE })).toEqual({
        ok: true,
        serverUrl: URL_,
      });
      expect(t.store.saved).toBeNull();
    }
  });
});

describe('parseBridgePairStartInput', () => {
  it('keeps the server URL and the non-empty optional strings', () => {
    expect(
      parseBridgePairStartInput({ serverUrl: URL_, code: CODE, recoveryKey: '', displayName: 'X', extra: 1 }),
    ).toEqual({ serverUrl: URL_, code: CODE, displayName: 'X' });
  });

  it('refuses anything without a server URL string', () => {
    expect(parseBridgePairStartInput(null)).toBeNull();
    expect(parseBridgePairStartInput({ code: CODE })).toBeNull();
    expect(parseBridgePairStartInput({ serverUrl: 42 })).toBeNull();
  });

  it('drops optional fields that are not strings', () => {
    expect(parseBridgePairStartInput({ serverUrl: URL_, code: 7, displayName: {} })).toEqual({
      serverUrl: URL_,
    });
  });
});
