/** Re-wrap a freshly-issued bearer for the ALREADY-paired server, in place.
 *
 *  The shared core behind two surfaces that swap this client's bearer
 *  WITHOUT re-pairing — the server's identity (and thus `server_url` +
 *  `server_public_key`) is unchanged, only the `client_tokens` row behind
 *  the bearer rotated:
 *
 *    1. `token.rotated` broadcast (D-148 § A.4.4, `realtime/token-rotation.ts`)
 *       — periodic 90d hygiene / compromise reissue / admin rotate.
 *    2. Archive-restore re-pair handoff (M5 S2b) — a committing
 *       `server.archive.import` swaps the whole db, wiping THIS driving
 *       client's bearer row; the server mints a fresh one INTO the restored
 *       db + returns it as `ArchiveImportRebind` so the client reconnects
 *       seamlessly into the restored realm.
 *
 *  Both need the identical envelope the bootstrap's `resolveBearer` reads at
 *  reconnect (`webclient-bootstrap.ts` DD#2): the bearer AES-GCM-wrapped under
 *  the local non-extractable key, AAD-bound to `{ token_id, server_url,
 *  server_public_key }`. Factoring the read-context → wrap → persist sequence
 *  here keeps the two callers provably in lock-step with that envelope (a
 *  divergence would surface as a `webclient_token_corrupt` unwrap failure +
 *  silent re-pair).
 *
 *  IN-PLACE invariant: this ONLY overwrites `webclient_token`. `server_url` +
 *  `server_public_key` are read, never written — so the bootstrap's strict
 *  pair-triple discriminant (`server_url` + `server_public_key` +
 *  `webclient_token` all non-null — `hydratePairState`) never breaks mid-swap.
 *  There is no partial-stash window that could lock the user out: the bearer
 *  field transitions old-valid-record → new-valid-record, never null. (A first
 *  pair, which DOES build the triple from scratch, goes through
 *  `finalizePairCodeSuccess`, not this helper.)
 *
 *  Never throws — every failure is a tagged result so callers route to
 *  per-stage telemetry / fallback (the rotation handler's `onError`; the
 *  restore panel's best-effort "degrade to re-pair"). The plaintext bearer is
 *  held only for the `wrap` call + discarded on return; it never persists. */

import type { WebclientTokenRecord } from '@recued/contracts';

import type { WebclientLocalStore } from './local-store.js';
import type {
  WebclientTokenAad,
  WebclientTokenStore,
} from './token-store.js';

/** Closed list of failure stages. Identical to the rotation handler's
 *  `TokenRotationFailureStage` (it maps these straight onto `onError`). */
export type RewrapBearerFailureStage =
  | 'read_pair_context'
  | 'wrap'
  | 'persist';

export type RewrapBearerResult =
  | { ok: true; record: WebclientTokenRecord }
  | { ok: false; stage: RewrapBearerFailureStage; error: Error };

export interface RewrapBearerForActivePairArgs {
  localStore: WebclientLocalStore;
  tokenStore: WebclientTokenStore;
  /** New server-issued token id — becomes BOTH the AAD `token_id` and the
   *  persisted `WebclientTokenRecord.token_id` so unwrap-time AAD
   *  reconstruction (`{ ...aad, token_id: record.token_id }`) lines up. */
  token_id: string;
  /** New plaintext bearer. Held only for the `wrap` call. */
  bearer: string;
  /** Optional authoritative issue time to stamp onto the persisted record.
   *  `token.rotated` carries the server's issue time (so Settings + audit rows
   *  match the server's record); absent ⇒ keep the wrap's client-clock stamp. */
  issued_at?: number;
}

const asError = (err: unknown): Error =>
  err instanceof Error ? err : new Error(String(err));

export const rewrapBearerForActivePair = async (
  args: RewrapBearerForActivePairArgs,
): Promise<RewrapBearerResult> => {
  let serverUrl: string | null;
  let serverPublicKey: string | null;
  try {
    serverUrl = await args.localStore.get('server_url');
    serverPublicKey = await args.localStore.get('server_public_key');
  } catch (err) {
    return { ok: false, stage: 'read_pair_context', error: asError(err) };
  }
  if (!serverUrl || !serverPublicKey) {
    return {
      ok: false,
      stage: 'read_pair_context',
      error: new Error(
        `rewrap-bearer: pair context incomplete (server_url=${serverUrl ?? 'null'}, server_public_key=${serverPublicKey ?? 'null'})`,
      ),
    };
  }

  const aad: WebclientTokenAad = {
    token_id: args.token_id,
    server_url: serverUrl,
    server_public_key: serverPublicKey,
  };

  let wrapped: WebclientTokenRecord;
  try {
    wrapped = await args.tokenStore.wrap({
      token_id: args.token_id,
      bearer: args.bearer,
      aad,
    });
  } catch (err) {
    return { ok: false, stage: 'wrap', error: asError(err) };
  }

  const record: WebclientTokenRecord =
    args.issued_at !== undefined ? { ...wrapped, issued_at: args.issued_at } : wrapped;

  try {
    await args.localStore.set('webclient_token', record);
  } catch (err) {
    return { ok: false, stage: 'persist', error: asError(err) };
  }

  return { ok: true, record };
};
