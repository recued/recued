/** D-240 § D11 — `reception.lookup.revoke`: the owner kills one submitter's
 *  viewback link.
 *
 *  Reserved admin-only, like every other `reception.*` method (the whole prefix
 *  is in `MCP_RESERVED_RPC_PREFIXES`, so this surface is paired-client-only by
 *  construction and implies no grant work).
 *
 *  Modelled on `reception-manage-mint-handler.ts`. Spec: D-240
 *  § D11. */

import type {
  ReceptionLookupRevokeInput,
  ReceptionLookupRevokeResult,
} from '@recued/contracts';

import {
  RECEPTION_CREDENTIAL_ID_MAX,
  type ReceptionManageCredentialStore,
} from './storage/reception-manage-credential-store.js';

export class ReceptionLookupRevokeRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ReceptionLookupRevokeRpcError';
  }
}

export interface ReceptionLookupRevokeDeps {
  readonly getCredentialStore: () => ReceptionManageCredentialStore;
  readonly now: () => number;
}

/** ⛔ The same gate every other `reception.*` method applies. The reserved prefix
 *  keeps this off MCP, but that is a CHANNEL fence, not an actor one — an
 *  unregistered connection on the paired transport is still a caller. Ending a
 *  visitor's access is an owner action; it answers to a paired admin or to
 *  nobody. */
const requireAdmin = (
  caller: { instance_id?: string | null | undefined } | undefined,
  method: string,
): void => {
  if (!caller?.instance_id) {
    throw new ReceptionLookupRevokeRpcError(
      'permission_denied',
      `${method}: requires a paired admin client (D-121); dispatched from an unregistered connection`,
      403,
    );
  }
};

export const handleReceptionLookupRevoke = (
  deps: ReceptionLookupRevokeDeps,
  args: ReceptionLookupRevokeInput | undefined,
  caller: { instance_id?: string | null | undefined } | undefined,
): ReceptionLookupRevokeResult => {
  const method = 'reception.lookup.revoke';
  requireAdmin(caller, method);

  // ⛔⛔ VALIDATED THE WAY THE STORE VALIDATES, because otherwise the two
  // disagree and the caller gets an error this rpc never declared. The store
  // TRIMS and CAPS at 256 and throws `ReceptionManageCredentialValidationError`;
  // a bare `length === 0` check here let `'   '` and a 10 KB id through to it,
  // so a shape this rpc considers valid surfaced as a store exception instead of
  // the contract's own `reception_lookup_revoke_invalid`.
  //
  // ⇒ Same trim, same cap, one error vocabulary. The store keeps its checks as
  // defense in depth; this one exists so the WIRE contract is honest.
  const clean = (value: unknown, field: string): string => {
    if (typeof value !== 'string') {
      throw new ReceptionLookupRevokeRpcError(
        'reception_lookup_revoke_invalid', `${method}: ${field} must be a string`, 400,
      );
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new ReceptionLookupRevokeRpcError(
        'reception_lookup_revoke_invalid', `${method}: ${field} must be non-empty`, 400,
      );
    }
    if (trimmed.length > RECEPTION_CREDENTIAL_ID_MAX) {
      throw new ReceptionLookupRevokeRpcError(
        'reception_lookup_revoke_invalid',
        `${method}: ${field} is too long (max ${RECEPTION_CREDENTIAL_ID_MAX})`,
        400,
      );
    }
    return trimmed;
  };
  const endpoint_id = clean(args?.endpoint_id, 'endpoint_id');
  const record_id = clean(args?.record_id, 'record_id');

  // ⚠ NO EXISTENCE CHECK ON THE RECORD, deliberately. This revokes CREDENTIALS;
  // whether the submission row still exists is a different question, and
  // refusing on it would make a revoke impossible for exactly the case where it
  // is most wanted — a record collected by retention whose link is still out
  // there in someone's inbox.
  const revoked = deps.getCredentialStore().revokeLookupsForRecord({
    endpoint_id,
    record_id,
    now: deps.now(),
  });

  return { revoked };
};

/** The rpc slice. ⛔ Returns `undefined` when the deps are absent so the method is
 *  simply not registered on a db-less boot — the same posture as the mint,
 *  record and inbox slices. */
export const makeReceptionLookupRevokeHandlers = <C extends { instance_id?: string | null }>(
  deps: ReceptionLookupRevokeDeps | undefined,
):
  | {
      methods: ReadonlyArray<'reception.lookup.revoke'>;
      handlers: {
        'reception.lookup.revoke': (
          args: ReceptionLookupRevokeInput,
          client: C | undefined,
        ) => Promise<ReceptionLookupRevokeResult>;
      };
    }
  | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['reception.lookup.revoke'],
    handlers: {
      'reception.lookup.revoke': async (args, client) =>
        handleReceptionLookupRevoke(
          deps,
          args,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
    },
  };
};
