/** Pairing, run by the service worker so it survives the page that asked.
 *
 *  The side panel only collects the server URL and code and shows where
 *  pairing stands; everything after "Pair this bridge" happens here: the
 *  `/auth/pair` POST, holding the accepted reply, finishing setup, and
 *  starting the worker's paired runtime (`onPaired`).
 *
 *  ⛔ WHY NOT THE PAGE. 0.0.1 paired from a popup, and Chrome closes a popup
 *  the moment it loses focus. `/auth/pair` spends the code and registers the
 *  bridge BEFORE it answers, and a server behind a tunnel can take seconds
 *  to answer (5.4 s measured against the review server, 2026-10-09). Closing
 *  the popup in that window lost the reply: the server listed the bridge,
 *  the bridge had nothing, and the next attempt was told the code was wrong.
 *  That fits everything known about the Chrome Web Store rejection of 0.0.1.
 *  The side panel that replaced the popup stays open on a click elsewhere,
 *  but the user can still close it, or the window; the worker keeps the
 *  request either way.
 *
 *  The side panel reaches this through one message type, {@link
 *  BRIDGE_PAIR_MESSAGE_TYPE}, with an `op`:
 *    - `status` — where pairing stands, without waiting.
 *    - `wait`   — the outcome of the attempt under way (null when none is).
 *    - `start`  — pair with what the user typed.
 *    - `finish` — finish an accepted pairing with the held reply. Never
 *                 posts the code, which the server has already spent.
 *    - `abandon` — drop an accepted pairing ("Start over").
 *
 *  ⛔ ONE ATTEMPT AT A TIME, CLAIMED SYNCHRONOUSLY. A second `start` while
 *  one runs would post a second code or interleave two finalizes. The slot
 *  is taken before the first `await`, so two arrivals in one turn cannot
 *  both pass the check.
 *
 *  ⛔ AN INSTANCE ID GOES WITH EVERY PAIR. The server stamps it on the token
 *  it issues, and resolves the bridge's identity from it on every
 *  connection. Without one, every owner rpc that needs a registered client
 *  refused the bridge — `events.subscribe` among them, so the panel never
 *  received a live update (the review server's approval-mode flip
 *  included). The webclient has always sent one. */

import type {
  BridgePairCodeInputCommitOptions,
  BridgePairCodeInputCommitResult,
  BridgePairCodeInputErrorCode,
} from './pair-code-input-host.js';
import {
  BRIDGE_PAIR_COMPLETION_FINAL_ERRORS,
  type BridgePairCompletionErrorCode,
  type BridgePairFinalizeResult,
} from './pair-completion.js';
import type {
  BridgeAcceptedPair,
  BridgePendingPairStore,
} from './pending-pair-store.js';
import type { BridgeSignInRefusalStore } from './sign-in-refusal-store.js';

// ════════════════════════════════════════════════════════════════
// Wire shape — side panel ⇄ service worker
// ════════════════════════════════════════════════════════════════

export const BRIDGE_PAIR_MESSAGE_TYPE = 'recued.bridge.pair' as const;

/** What the user typed. The recovery key is sent to the server and never
 *  kept. */
export interface BridgePairStartInput {
  serverUrl: string;
  code?: string;
  recoveryKey?: string;
  /** Device label for the server's roster ("Chrome on Windows"). */
  displayName?: string;
}

export type BridgePairRequest =
  | { type: typeof BRIDGE_PAIR_MESSAGE_TYPE; op: 'status' }
  | { type: typeof BRIDGE_PAIR_MESSAGE_TYPE; op: 'wait' }
  | { type: typeof BRIDGE_PAIR_MESSAGE_TYPE; op: 'start'; input: BridgePairStartInput }
  | { type: typeof BRIDGE_PAIR_MESSAGE_TYPE; op: 'finish' }
  | { type: typeof BRIDGE_PAIR_MESSAGE_TYPE; op: 'abandon' };

/** Where this bridge's pairing stands. `serverUrl` is for display: the URL
 *  the user typed while pairing, the stored connection URL once paired. */
export type BridgePairStatus =
  /** `refused`: the server at that address stopped accepting this bridge's sign-in, which is
   *  why it is unpaired (`sign-in-refusal-store.ts`). `disconnected`: the owner disconnected it
   *  and that server could not be told, so it still lists this bridge under Devices. */
  | { state: 'unpaired'; refused?: { serverUrl: string }; disconnected?: { serverUrl: string } }
  | { state: 'pairing'; serverUrl: string }
  | { state: 'accepted'; serverUrl: string }
  | { state: 'paired'; serverUrl: string };

/** How one `start` or `finish` ended. */
export type BridgePairOutcome =
  /** Paired, and the worker's paired runtime has started connecting. */
  | { ok: true; serverUrl: string }
  /** The server said no, or was never reached. `error` keys the pair form's
   *  copy; the code is whatever the server's answer says it is. */
  | {
      ok: false;
      kind: 'refused';
      error: BridgePairCodeInputErrorCode;
      detail?: string;
      serverSaid?: string;
      serverCode?: string;
    }
  /** The server accepted the code (it is spent) and setup did not finish.
   *  `finish` retries with the held reply. `reason` is absent when this
   *  answers a `start` that found an accepted pairing already waiting. */
  | {
      ok: false;
      kind: 'accepted';
      serverUrl: string;
      reason?: BridgePairCompletionErrorCode;
      detail?: string;
    }
  /** The server accepted the code and finishing can never succeed; the held
   *  reply was dropped. Pairing again takes a new code. */
  | { ok: false; kind: 'final'; error: BridgePairCompletionErrorCode; detail?: string }
  /** Another attempt is under way. */
  | { ok: false; kind: 'busy'; serverUrl: string }
  /** This bridge is already paired; nothing was sent. */
  | { ok: false; kind: 'paired'; serverUrl: string }
  /** `finish` found no accepted pairing (a browser restart empties it). */
  | { ok: false; kind: 'nothing_to_finish' }
  /** The worker could not be reached or failed unexpectedly. Produced by
   *  the side panel's client as well as here. */
  | { ok: false; kind: 'error'; detail: string };

/** Reads a `start` op's input off the wire. Null when it has no server URL
 *  string; optional fields that are not non-empty strings are dropped. */
export const parseBridgePairStartInput = (raw: unknown): BridgePairStartInput | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.serverUrl !== 'string') return null;
  const text = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  const code = text(r.code);
  const recoveryKey = text(r.recoveryKey);
  const displayName = text(r.displayName);
  return {
    serverUrl: r.serverUrl,
    ...(code !== undefined ? { code } : {}),
    ...(recoveryKey !== undefined ? { recoveryKey } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
  };
};

// ════════════════════════════════════════════════════════════════
// Orchestrator
// ════════════════════════════════════════════════════════════════

export interface BridgeWorkerPairingDeps {
  /** POST `/auth/pair`. Production: `submitBridgePairCodeInput` over the
   *  worker's fetch. Never throws by contract. */
  submit: (
    options: BridgePairCodeInputCommitOptions,
  ) => Promise<BridgePairCodeInputCommitResult>;
  /** Finish setup with an accepted reply. Production: `finalizeBridgePair`
   *  over the worker's stores. Never throws by contract. */
  finalize: (accepted: BridgeAcceptedPair) => Promise<BridgePairFinalizeResult>;
  /** The stored connection URL when this bridge is paired (server URL,
   *  bearer and server key all present), else null. */
  readPaired: () => Promise<{ serverUrl: string } | null>;
  /** Where an accepted reply waits across worker restarts. Absent ⇒ memory
   *  only. */
  pendingStore?: BridgePendingPairStore;
  /** Starts this worker's paired runtime once setup has finished.
   *  Production: the bootstrap's in-place start, which connects to the
   *  server without restarting the extension — a restart would close the
   *  side panel the user paired from. Awaited before `start` / `finish`
   *  answers, so the panel's next status read finds the socket coming up.
   *  A throw is swallowed here: the pairing itself is complete, and the
   *  bootstrap owns recovering from a runtime that would not start. */
  onPaired?: () => Promise<void> | void;
  /** Mints the instance id sent with each pair. */
  mintInstanceId?: () => string;
  /** The server that refused this bridge's sign-in, if one did since the last pairing. Absent ⇒
   *  no reason is ever given. */
  refusals?: Pick<BridgeSignInRefusalStore, 'load' | 'clear'>;
}

export interface BridgeWorkerPairing {
  status(): Promise<BridgePairStatus>;
  wait(): Promise<BridgePairOutcome | null>;
  start(input: BridgePairStartInput): Promise<BridgePairOutcome>;
  finish(): Promise<BridgePairOutcome>;
  abandon(): Promise<{ ok: boolean }>;
}

const defaultMintInstanceId = (): string => {
  const cryptoLike = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoLike && typeof cryptoLike.randomUUID === 'function') {
    return cryptoLike.randomUUID();
  }
  return `bridge-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
};

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const createBridgeWorkerPairing = (
  deps: BridgeWorkerPairingDeps,
): BridgeWorkerPairing => {
  /** The attempt under way. `serverUrl` fills in once a `finish` has loaded
   *  the held reply. */
  let inFlight: { serverUrl: string; done: Promise<BridgePairOutcome> } | null = null;
  /** The accepted reply, in memory as well as the store: a store that cannot
   *  save must not cost a pairing the server already accepted. */
  let held: BridgeAcceptedPair | null = null;

  const loadHeld = async (): Promise<BridgeAcceptedPair | null> => {
    if (held !== null) return held;
    try {
      return (await deps.pendingStore?.load()) ?? null;
    } catch {
      return null;
    }
  };
  const remember = async (accepted: BridgeAcceptedPair): Promise<void> => {
    held = accepted;
    try {
      await deps.pendingStore?.save(accepted);
    } catch {
      /* the in-memory copy still finishes it while this worker runs */
    }
  };
  const forget = async (): Promise<void> => {
    held = null;
    try {
      await deps.pendingStore?.clear();
    } catch {
      /* best-effort; a held reply for a paired bridge is never used: `start`
         and `status` check the stored pair first */
    }
  };
  const readPaired = async (): Promise<{ serverUrl: string } | null> => {
    try {
      return await deps.readPaired();
    } catch {
      return null;
    }
  };

  const startPairedRuntime = async (): Promise<void> => {
    // Paired again: the refusal is history.
    await deps.refusals?.clear().catch(() => undefined);
    try {
      await deps.onPaired?.();
    } catch {
      /* the pairing is complete; the bootstrap recovers a runtime that
         would not start */
    }
  };

  /** Claims the single slot before anything awaits. */
  const run = (
    serverUrl: string,
    work: (slot: { serverUrl: string }) => Promise<BridgePairOutcome>,
  ): Promise<BridgePairOutcome> => {
    const slot = { serverUrl };
    const done = work(slot)
      .catch((err): BridgePairOutcome => ({ ok: false, kind: 'error', detail: describe(err) }))
      .finally(() => {
        if (inFlight?.done === done) inFlight = null;
      });
    inFlight = {
      get serverUrl() {
        return slot.serverUrl;
      },
      done,
    };
    return done;
  };

  const busy = (): BridgePairOutcome | null =>
    inFlight === null ? null : { ok: false, kind: 'busy', serverUrl: inFlight.serverUrl };

  /** Finish setup with an accepted reply; the reply is dropped on success
   *  and on a failure no retry can fix, and kept otherwise. */
  const complete = async (accepted: BridgeAcceptedPair): Promise<BridgePairOutcome> => {
    let result: BridgePairFinalizeResult;
    try {
      result = await deps.finalize(accepted);
    } catch (err) {
      result = {
        ok: false,
        error: 'pair_completion_persist_failed',
        detail: `finalize crashed: ${describe(err)}`,
      };
    }
    if (result.ok) {
      await forget();
      await startPairedRuntime();
      return { ok: true, serverUrl: accepted.serverUrl };
    }
    if (BRIDGE_PAIR_COMPLETION_FINAL_ERRORS.has(result.error)) {
      await forget();
      return {
        ok: false,
        kind: 'final',
        error: result.error,
        ...(result.detail ? { detail: result.detail } : {}),
      };
    }
    return {
      ok: false,
      kind: 'accepted',
      serverUrl: accepted.serverUrl,
      reason: result.error,
      ...(result.detail ? { detail: result.detail } : {}),
    };
  };

  return {
    async status() {
      if (inFlight !== null) return { state: 'pairing', serverUrl: inFlight.serverUrl };
      const paired = await readPaired();
      if (paired !== null) return { state: 'paired', serverUrl: paired.serverUrl };
      const pending = await loadHeld();
      if (pending !== null) return { state: 'accepted', serverUrl: pending.serverUrl };
      const refusal = await deps.refusals?.load().catch(() => null);
      if (!refusal) return { state: 'unpaired' };
      return refusal.kind === 'disconnected'
        ? { state: 'unpaired', disconnected: { serverUrl: refusal.serverUrl } }
        : { state: 'unpaired', refused: { serverUrl: refusal.serverUrl } };
    },

    async wait() {
      return inFlight === null ? null : inFlight.done;
    },

    start(input) {
      const already = busy();
      if (already) return Promise.resolve(already);
      return run(input.serverUrl, async () => {
        // Checked before anything is sent: a code posted here would be spent
        // on a pairing that cannot finish.
        const paired = await readPaired();
        if (paired !== null) return { ok: false, kind: 'paired', serverUrl: paired.serverUrl };
        const pending = await loadHeld();
        if (pending !== null) return { ok: false, kind: 'accepted', serverUrl: pending.serverUrl };

        const instanceId = (deps.mintInstanceId ?? defaultMintInstanceId)();
        const code = input.code?.trim() ?? '';
        const result = await deps.submit({
          serverUrl: input.serverUrl,
          ...(code.length > 0 ? { code } : {}),
          ...(input.recoveryKey ? { recoveryKey: input.recoveryKey } : {}),
          ...(input.displayName ? { displayName: input.displayName } : {}),
          instanceId,
        });
        if (!result.ok) {
          return {
            ok: false,
            kind: 'refused',
            error: result.error,
            ...(result.detail ? { detail: result.detail } : {}),
            ...(result.serverSaid ? { serverSaid: result.serverSaid } : {}),
            ...(result.serverCode ? { serverCode: result.serverCode } : {}),
          };
        }
        // ⛔ Held BEFORE setup runs: from here on, this reply is the only way
        // left to finish.
        const accepted: BridgeAcceptedPair = {
          serverUrl: input.serverUrl,
          token: result.token,
          ...(result.token_id !== undefined ? { token_id: result.token_id } : {}),
          ...(result.passport !== undefined ? { passport: result.passport } : {}),
          ...(result.serverId !== undefined ? { serverId: result.serverId } : {}),
          instanceId,
        };
        await remember(accepted);
        return complete(accepted);
      });
    },

    finish() {
      const already = busy();
      if (already) return Promise.resolve(already);
      return run(held?.serverUrl ?? '', async (slot) => {
        const pending = await loadHeld();
        if (pending === null) return { ok: false, kind: 'nothing_to_finish' };
        slot.serverUrl = pending.serverUrl;
        held = pending;
        return complete(pending);
      });
    },

    async abandon() {
      if (inFlight !== null) return { ok: false };
      await forget();
      return { ok: true };
    },
  };
};
