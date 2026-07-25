/** D-175 P5 — account-binding manager (server side).
 *
 *  The orchestration core of the binding protocol's server half:
 *  receive the relayed binding token → build the server-identity proof
 *  → exchange with the auth Worker → apply the conflict gate → store
 *  the returned server-scoped credential as identity-root material →
 *  emit the audit row. Plus unbind + a secret-free status read.
 *
 *  Storage split. The SECRET credential + its metadata persist in the
 *  identity-keys file via the `ServerKeyStore` single binding slot
 *  (`saveAccountBinding`), inheriting that file's at-rest protection
 *  (0600 + atomic write; cleartext under disk-access trust, or AEAD
 *  under `RECUED_IDENTITY_PASSPHRASE`). The single slot IS the
 *  "one server → one owning account at a time" invariant (D-175 D10).
 *  Only the secret-free `AccountBindingSummary` projection ever leaves
 *  this module; history (who owned the server, when, every failed
 *  exchange) lives in the signed audit ledger, not a state table.
 *
 *  Conflict gate. A bind whose exchanged account differs from the
 *  current owner returns `conflict` WITHOUT storing (and audits the
 *  contention) unless `confirm_rebind` is set — no silent rebind. The
 *  unconfirmed-conflict path discards the freshly-exchanged credential;
 *  the confirm flow re-mints + re-relays a fresh token (the Worker's
 *  ownership record reconciles on that confirmed exchange).
 *
 *  Order-independence. The manager imposes no "must have paired first"
 *  precondition: a bind completes whenever a valid token arrives and
 *  the server identity is booted (always true post-boot). Account-first
 *  and server-first both converge here.
 *
 *  Lazy identity. `getServerIdentity` / `getKeyStore` resolve through
 *  the same lazily-booted signing identity the audit-signing wrapper
 *  uses; a call before boot surfaces `not_ready` rather than crashing.
 *  Bind is user-initiated and always post-boot.
 */

import { RpcError } from '@recued/contracts';
import type {
  AccountBindResult,
  AccountBindingAuditAction,
  AccountBindingStatusResponse,
  AccountBindingProofClaims,
  AccountBindingExchangeRequest,
  AccountBindingSummary,
  AccountUnbindResult,
} from '@recued/contracts';
import { canonicalJSONStringify } from '@recued/crypto';
import type { AuditLogStore } from '@recued/storage';
import {
  ed25519Sign,
  type Ed25519Keypair,
  type ServerKeyStore,
  type StoredAccountBinding,
} from '../keys/index.js';
import type { AccountBindingExchangeClient } from './exchange-client.js';

/** Maximum accepted binding-token length. Generous for a JWT-like
 *  token; a guard against an unbounded relay payload. */
const MAX_BINDING_TOKEN_LEN = 8192;

/** Actor context for the audit row — the paired client that relayed
 *  the token. `user_id` is the ext-reported account label when the
 *  relaying client is signed in (provenance only; the binding token —
 *  Worker-verified — is the authoritative account-auth signal, so a
 *  null here does not block a bind). `instance_id` identifies the
 *  device that relayed. */
export interface AccountBindingActor {
  user_id: string | null;
  instance_id: string | null;
}

export interface AccountBindingManagerDeps {
  /** Resolve the current `server_identity_key` (for the exchange proof
   *  + the binding's anchor fingerprint). Throws before the signing
   *  identity is booted → the manager surfaces `not_ready`. */
  getServerIdentity: () => Ed25519Keypair;
  /** Resolve the `ServerKeyStore` that holds the binding slot. Same
   *  lazy-boot guarantee as `getServerIdentity`. */
  getKeyStore: () => ServerKeyStore;
  /** The Worker exchange boundary (HTTP in production; a mock in
   *  tests). */
  exchangeClient: AccountBindingExchangeClient;
  /** Signed-wrapper audit sink. Optional — absence is a no-op (binding
   *  still works, just without a ledger row). When present, the binding
   *  audit kinds (in `HIGH_ASSURANCE_AUDIT_KINDS`) are auto-signed +
   *  reserve-pinned by the wrapper. */
  auditLog?: Pick<AuditLogStore, 'logActivity'>;
  /** Clock seam (tests). Defaults to `Date.now`. */
  now?: () => number;
}

export interface AccountBindingManager {
  /** Receive a relayed binding token, exchange it, and store the
   *  returned credential under the conflict gate. */
  bind(
    args: { binding_token: string; confirm_rebind?: boolean },
    actor: AccountBindingActor,
  ): Promise<AccountBindResult>;
  /** Clear the server's account binding. Idempotent. */
  unbind(actor: AccountBindingActor): Promise<AccountUnbindResult>;
  /** Secret-free current binding state. */
  status(): AccountBindingStatusResponse;
}

/** Project the stored (secret-bearing) record down to the secret-free
 *  wire summary. The `server_scoped_credential` is deliberately
 *  dropped. */
const summarize = (b: StoredAccountBinding): AccountBindingSummary => ({
  account_id: b.account_id,
  ...(b.publisher_handle ? { publisher_handle: b.publisher_handle } : {}),
  server_fingerprint: b.server_fingerprint,
  bound_at: b.bound_at,
  ...(b.rebound_at !== undefined ? { rebound_at: b.rebound_at } : {}),
  ...(b.credential_expires_at !== undefined
    ? { credential_expires_at: b.credential_expires_at }
    : {}),
});

export const createAccountBindingManager = (
  deps: AccountBindingManagerDeps,
): AccountBindingManager => {
  const now = deps.now ?? Date.now;
  // Per-manager monotonic counter so concurrent / same-millisecond
  // events get distinct `activity_id`s. The signing wrapper signs the
  // entry (incl. `activity_id`) BEFORE the underlying store persists,
  // so the id MUST be populated up front or the signed bytes diverge
  // from the stored bytes (mirrors the `pair_revoke` rationale). Unlike
  // `pair_revoke` (deterministic id for idempotency), binding events
  // are append-only history, so uniqueness — not determinism — is what
  // we need.
  let auditSeq = 0;

  /** Best-effort signed-audit emit. Awaited so the row lands before the
   *  rpc returns, but a sink throw is swallowed — the binding mutation
   *  is the load-bearing effect; an audit-sink failure is a missed row,
   *  not a rolled-back bind (mirrors `pair_revoke`). */
  const emitAudit = async (
    action: AccountBindingAuditAction,
    server_fingerprint: string,
    at: number,
    detail: Record<string, unknown>,
  ): Promise<void> => {
    if (!deps.auditLog) return;
    try {
      await deps.auditLog.logActivity({
        activity_id: `${action}:${server_fingerprint}:${at}:${auditSeq++}`,
        timestamp: at,
        action,
        target: server_fingerprint,
        detail: JSON.stringify(detail),
      });
    } catch {
      /* best-effort */
    }
  };

  const actorDetail = (
    actor: AccountBindingActor,
  ): Record<string, unknown> => ({
    actor_surface: 'pair_client',
    ...(actor.user_id !== null ? { actor_user_id: actor.user_id } : {}),
    ...(actor.instance_id !== null
      ? { actor_instance_id: actor.instance_id }
      : {}),
  });

  /** Resolve the booted identity or surface `not_ready`. */
  const requireIdentity = (): Ed25519Keypair => {
    try {
      return deps.getServerIdentity();
    } catch {
      throw new RpcError(
        'not_ready',
        'server signing identity is not ready yet; retry after boot',
        503,
      );
    }
  };

  const requireKeyStore = (): ServerKeyStore => {
    try {
      return deps.getKeyStore();
    } catch {
      throw new RpcError(
        'not_ready',
        'server signing identity is not ready yet; retry after boot',
        503,
      );
    }
  };

  return {
    async bind(args, actor) {
      const token = args.binding_token;
      if (typeof token !== 'string' || token.trim().length === 0) {
        throw new RpcError('bad_request', 'binding_token is required', 400);
      }
      if (token.length > MAX_BINDING_TOKEN_LEN) {
        throw new RpcError(
          'bad_request',
          `binding_token exceeds ${MAX_BINDING_TOKEN_LEN} chars`,
          400,
        );
      }

      const identity = requireIdentity();
      const keyStore = requireKeyStore();
      const server_fingerprint = identity.public_key_fingerprint;
      const at = now();
      // STRICT confirmation — over the wire `args` is untyped JSON, so a
      // truthiness check would treat `"false"` / `1` / `{}` as confirmed
      // and silently rebind. Only a real boolean `true` authorizes a
      // rebind (defends the no-silent-rebind invariant).
      const confirmRebind = args.confirm_rebind === true;

      // Read the current owner BEFORE the exchange so the Worker can gate
      // the rebind: it commits cloud-side ownership (and consumes the
      // token nonce) on exchange, so an unconfirmed different-account
      // bind must be declined at the Worker BEFORE that write — the
      // server cannot un-write it after the fact.
      const current = keyStore.loadAccountBinding();

      // Build the server-identity proof: sign a canonical payload that
      // binds the (opaque) token + the proving identity + a freshness
      // stamp. Binding the token into the signed bytes stops a captured
      // proof being replayed against a different token.
      const claims: AccountBindingProofClaims = {
        binding_token: token,
        server_fingerprint,
        purpose: 'account_bind_exchange',
        signed_at: at,
      };
      const proof_payload = canonicalJSONStringify(claims);
      const request: AccountBindingExchangeRequest = {
        binding_token: token,
        server_fingerprint,
        server_public_key_b64: identity.public_key_b64,
        proof_payload,
        proof_signature: ed25519Sign(identity, proof_payload),
        ...(current ? { current_owner_account_id: current.account_id } : {}),
        confirm_rebind: confirmRebind,
      };

      const outcome = await deps.exchangeClient.exchange(request);

      // Rebind needs confirmation — the Worker declined to commit (no
      // cloud ownership write, token nonce not consumed). Surface the
      // conflict; the user re-sends with confirm_rebind. Nothing stored.
      if (!outcome.ok && outcome.conflict === true) {
        await emitAudit('account_bind_conflict', server_fingerprint, at, {
          current_account_id: outcome.current_owner.account_id,
          incoming_account_id: outcome.incoming.account_id,
          outcome: 'conflict',
          ...actorDetail(actor),
        });
        return {
          outcome: 'conflict',
          current_owner: current
            ? summarize(current)
            : {
                account_id: outcome.current_owner.account_id,
                ...(outcome.current_owner.publisher_handle
                  ? { publisher_handle: outcome.current_owner.publisher_handle }
                  : {}),
                server_fingerprint,
                bound_at: 0,
              },
          incoming: {
            account_id: outcome.incoming.account_id,
            ...(outcome.incoming.publisher_handle
              ? { publisher_handle: outcome.incoming.publisher_handle }
              : {}),
          },
        };
      }

      if (!outcome.ok) {
        await emitAudit('account_bind_exchange_failed', server_fingerprint, at, {
          reason: outcome.code,
          ...(outcome.message ? { message: outcome.message } : {}),
          ...actorDetail(actor),
        });
        // Status class by failure origin: transport/Worker-side faults
        // are 5xx (don't masquerade as a client/token error + drive the
        // wrong retry); token / proof faults are 4xx (the caller's
        // input is bad). `internal` = a malformed / unexpected Worker
        // response → 502 (upstream), NOT 400.
        const status =
          outcome.code === 'exchange_unavailable'
            ? 503
            : outcome.code === 'internal'
              ? 502
              : outcome.code === 'account_not_authenticated'
                ? 401
                : 400;
        throw new RpcError(
          'binding_exchange_failed',
          `account binding exchange failed (${outcome.code})`,
          status,
          undefined,
          { reason: outcome.code },
        );
      }

      // Defense-in-depth — fail closed on a Worker contract violation.
      // The Worker gates the rebind (it returns `conflict`, not success,
      // for an unconfirmed different-account bind). If it nonetheless
      // returns success for a DIFFERENT account while `confirmRebind`
      // was false, do NOT silently overwrite the local owner: the server
      // has the information to detect the violation, so it preserves the
      // no-silent-rebind invariant locally + surfaces a conflict (the
      // user can then confirm). The `worker_overcommit` flag distinguishes
      // this from a normal pre-commit conflict in the forensic ledger.
      if (
        current &&
        current.account_id !== outcome.account_id &&
        !confirmRebind
      ) {
        await emitAudit('account_bind_conflict', server_fingerprint, at, {
          current_account_id: current.account_id,
          incoming_account_id: outcome.account_id,
          outcome: 'conflict',
          worker_overcommit: true,
          ...actorDetail(actor),
        });
        return {
          outcome: 'conflict',
          current_owner: summarize(current),
          incoming: {
            account_id: outcome.account_id,
            ...(outcome.publisher_handle
              ? { publisher_handle: outcome.publisher_handle }
              : {}),
          },
        };
      }

      // Success — the Worker committed (fresh bind, same-account refresh,
      // or a confirmed rebind). Mirror it into the local store.
      const isSameAccountRefresh =
        current !== null && current.account_id === outcome.account_id;
      const isConfirmedRebind =
        current !== null && current.account_id !== outcome.account_id;

      const stored: StoredAccountBinding = {
        account_id: outcome.account_id,
        ...(outcome.publisher_handle
          ? { publisher_handle: outcome.publisher_handle }
          : {}),
        server_scoped_credential: outcome.server_scoped_credential,
        server_fingerprint,
        // Same-account refresh preserves the original first-bind stamp;
        // a fresh bind / confirmed rebind stamps now.
        bound_at: isSameAccountRefresh ? current!.bound_at : at,
        ...(isConfirmedRebind
          ? { rebound_at: at }
          : current?.rebound_at !== undefined
            ? { rebound_at: current.rebound_at }
            : {}),
        credential_issued_at: outcome.credential_issued_at,
        ...(outcome.credential_expires_at !== undefined
          ? { credential_expires_at: outcome.credential_expires_at }
          : {}),
      };

      keyStore.saveAccountBinding(stored);
      // Durability fence — the identity-root credential must be on disk
      // before we report success (mirrors the identity-boot flush).
      if (keyStore.flush) await keyStore.flush();

      if (isConfirmedRebind) {
        await emitAudit('account_rebind', server_fingerprint, at, {
          account_id: outcome.account_id,
          previous_account_id: current!.account_id,
          outcome: 'rebound',
          ...actorDetail(actor),
        });
        return {
          outcome: 'rebound',
          binding: summarize(stored),
          previous_account_id: current!.account_id,
        };
      }

      await emitAudit('account_bind', server_fingerprint, at, {
        account_id: outcome.account_id,
        outcome: 'bound',
        ...(isSameAccountRefresh ? { refresh: true } : {}),
        ...actorDetail(actor),
      });
      return { outcome: 'bound', binding: summarize(stored) };
    },

    async unbind(actor) {
      const keyStore = requireKeyStore();
      const current = keyStore.loadAccountBinding();
      if (!current) return { outcome: 'not_bound' };
      keyStore.clearAccountBinding();
      if (keyStore.flush) await keyStore.flush();
      await emitAudit('account_unbind', current.server_fingerprint, now(), {
        account_id: current.account_id,
        outcome: 'unbound',
        ...actorDetail(actor),
      });
      return { outcome: 'unbound', previous: summarize(current) };
    },

    status() {
      const current = requireKeyStore().loadAccountBinding();
      return {
        status: current ? 'bound' : 'unbound',
        binding: current ? summarize(current) : null,
      };
    },
  };
};
