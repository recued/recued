/** D-152 P0 - hostname ownership-proof state machine.
 *
 * Network probing and cert parsing live outside this module. This helper only
 * consumes proof results and transitions the hostname registry row through the
 * closed-list ownership states.
 */

import type {
  HostnameOwnershipStatus,
  HostnameOwnershipProofInput,
  HostnameOwnershipProofResult,
  HostnameStorageRow,
  HostnameVerificationMethod,
} from '@recued/contracts';
import {
  HostnameRegistryError,
  type HostnameRegistryStore,
} from '../storage/hostname-registry.js';

export type {
  HostnameOwnershipProofFailureCode,
  HostnameOwnershipProofInput,
  HostnameOwnershipProofResult,
} from '@recued/contracts';

type OwnershipUpdate = Parameters<HostnameRegistryStore['setOwnership']>[0];

const isTokenProofMethod = (
  method: HostnameVerificationMethod,
): method is 'http_token' | 'dns_txt' =>
  method === 'http_token' || method === 'dns_txt';

const isCompatibleMethod = (
  row: HostnameStorageRow,
  method: HostnameVerificationMethod,
): boolean => {
  // `recued_acme` is pre-verified by construction (fleet-owned zone) and never
  // takes a proof; `evaluateProof` returns `recued_acme_preverified` before
  // this is reached.
  if (row.cert_source === 'recued_acme') return false;
  // D-235 § 3.2 — a custom hostname the FLEET will issue for takes only the two
  // challenge-response methods. `cert_proof` is refused with its own code (see
  // `evaluateProof`), not folded in here, so the user is told WHY rather than
  // just that the pairing is invalid.
  if (row.cert_source === 'recued_acme_custom') {
    return method === 'http_token' || method === 'dns_txt';
  }
  if (method === 'cert_proof') return row.cert_source === 'byo_uploaded';
  return row.cert_source === 'byo_uploaded' || row.cert_source === 'byo_external';
};

const evaluateProof = (
  row: HostnameStorageRow,
  input: HostnameOwnershipProofInput,
):
  | { ok: true; status: Extract<HostnameOwnershipStatus, 'verified' | 'failed'>; token_hash?: string }
  | Exclude<HostnameOwnershipProofResult, { ok: true }> => {
  if (row.cert_source === 'recued_acme') {
    return {
      ok: false,
      code: 'recued_acme_preverified',
      hostname: row.hostname_normalized,
      method: input.method,
      cert_source: row.cert_source,
    };
  }

  // D-235 § 3.2 ⛔ — `cert_proof` must NOT satisfy the gate that lets the fleet
  // MINT a certificate. Possessing a cert for a name proves someone once got
  // one; as authority to issue a new one it is circular, and a stale or leaked
  // chain carries it just as well as a live one. Checked ahead of the generic
  // compatibility test so the failure names the reason instead of collapsing
  // into "that method doesn't apply to this source".
  if (row.cert_source === 'recued_acme_custom' && input.method === 'cert_proof') {
    return {
      ok: false,
      code: 'cert_proof_insufficient',
      hostname: row.hostname_normalized,
      method: input.method,
      cert_source: row.cert_source,
    };
  }

  if (!isCompatibleMethod(row, input.method)) {
    return {
      ok: false,
      code: 'incompatible_proof_method',
      hostname: row.hostname_normalized,
      method: input.method,
      cert_source: row.cert_source,
    };
  }

  if (row.verification_method !== undefined && row.verification_method !== input.method) {
    return {
      ok: false,
      code: 'method_mismatch',
      hostname: row.hostname_normalized,
      method: input.method,
      expected_method: row.verification_method,
      cert_source: row.cert_source,
    };
  }

  if (input.method === 'cert_proof') {
    return {
      ok: true,
      status: input.cert_matches_hostname ? 'verified' : 'failed',
    };
  }

  if (!isTokenProofMethod(input.method) || row.verification_token_hash === undefined) {
    return {
      ok: false,
      code: 'missing_token_hash',
      hostname: row.hostname_normalized,
      method: input.method,
      cert_source: row.cert_source,
    };
  }

  return {
    ok: true,
    status: input.observed_token_hash === row.verification_token_hash ? 'verified' : 'failed',
    token_hash: row.verification_token_hash,
  };
};

export const applyHostnameOwnershipProof = (
  store: Pick<HostnameRegistryStore, 'get' | 'setOwnership'>,
  input: HostnameOwnershipProofInput,
): HostnameOwnershipProofResult => {
  let row: HostnameStorageRow | null;
  try {
    row = store.get(input.hostname);
  } catch (err) {
    if (err instanceof HostnameRegistryError && err.code === 'invalid_hostname') {
      return {
        ok: false,
        code: 'invalid_hostname',
        hostname: input.hostname,
        method: input.method,
      };
    }
    throw err;
  }

  if (!row) {
    return {
      ok: false,
      code: 'not_found',
      hostname: input.hostname,
      method: input.method,
    };
  }

  const evaluation = evaluateProof(row, input);
  if (!evaluation.ok) return evaluation;

  const update: OwnershipUpdate = {
    hostname: row.hostname_normalized,
    status: evaluation.status,
    verification_method: input.method,
  };
  if (evaluation.token_hash !== undefined) {
    update.verification_token_hash = evaluation.token_hash;
  }

  const projection = store.setOwnership(update);
  if (!projection) {
    return {
      ok: false,
      code: 'not_found',
      hostname: row.hostname_normalized,
      method: input.method,
    };
  }

  return {
    ok: true,
    hostname: row.hostname_normalized,
    method: input.method,
    status: evaluation.status,
    projection,
  };
};
