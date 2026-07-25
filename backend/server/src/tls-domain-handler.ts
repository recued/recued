/** D-148 follow-up #4 — `tls_domain.{upload,remove,list}` rpc handlers.
 *
 *  Wire-A entry point for the webclient's Settings → Server → TLS
 *  Certificates page. Each rpc routes into the W3.6
 *  `SqliteTlsDomainStore` composed at boot in bin.ts (W3.2 contracts +
 *  W3.6 production wiring + persistent vault-DEK-encrypted private
 *  keys). The store is the sole authority over per-domain cert
 *  persistence — validation (SAN match / key-cert pair / chain
 *  termination / expiry > 7d) runs inside `store.upload(args)` via the
 *  caller-supplied `TLSDomainUploadVerifiers` seam.
 *
 *  The handler is a thin adapter:
 *
 *    1. Reject calls from unregistered (non-paired) WS clients — cert
 *       management is operator-only. Mirrors `exposure.*` /
 *       `mcp.visibility.write` posture per § A.13.5 P7.G.
 *    2. Validate the wire-shaped args against closed lists
 *       (`TLSDomainCertSource`, non-empty domain, PEM-shaped strings).
 *    3. Call the store's `upload` / `remove` / `list`.
 *    4. Convert `TlsDomainUploadValidationError`'s issue array into an
 *       `RpcError` keyed on the first issue's `code` (matches the
 *       `NetworkErrorCode` closed list) + thread ALL issues through
 *       `RpcError.details` so the upload form renders inline per-issue
 *       copy without parsing the message.
 *
 *  Channel isolation: `tls_domain.*` is in `MCP_RESERVED_RPC_PREFIXES`
 *  (D-138 ratchet test asserts the prefix stays reserved). External AI
 *  agents must never drive a cert upload / replace / remove — the
 *  cert + private key pair IS the server's identity to its pinned
 *  clients; an MCP-channel mutation would be catastrophic.
 *
 *  Spec: docs/d-148-spec.md § A.6.3 + Amendment 2026-05-11. */

import {
  RpcError,
  TLS_DOMAIN_CERT_SOURCES,
  isTLSDomainCertSource,
  type HandlerSlice,
  type ServerRpcRegistry,
  type TLSDomainCertListEntry,
  type TLSDomainCertSource,
  type TLSDomainUploadIssue,
  type TLSDomainUploadResult,
  type TlsDomainUploadErrorDetails,
} from '@recued/contracts';
import type { SqliteTlsDomainStore } from './tls/domain-store.js';
import {
  TlsDomainUploadValidationError,
  TlsDomainVaultLockedError,
} from './tls/domain-store.js';
import type { WsClient } from './ws-server.js';

/** `getStore` is lazy because the `SqliteTlsDomainStore` is composed
 *  in bin.ts under the same `db` + key-manager lifecycle that downstream
 *  handlers depend on; mirrors the `getMachine` thunk pattern from
 *  `exposure-handler.ts`. The thunk throws fail-loud if invoked before
 *  bin.ts has assigned the ref, which can only happen during the boot
 *  window before rpc dispatch is available. */
export interface TlsDomainRpcDeps {
  getStore: () => SqliteTlsDomainStore;
}

type TlsDomainMethods =
  | 'tls_domain.upload'
  | 'tls_domain.remove'
  | 'tls_domain.list';

// ────────────────────────────────────────────────────────────────
// Caller-identity gate + arg validators
// ────────────────────────────────────────────────────────────────

const requireCallerInstance = (
  caller: { instance_id: string | null | undefined } | undefined,
  method: string,
): string => {
  if (!caller?.instance_id) {
    throw new RpcError(
      'permission_denied',
      `${method}: requires a paired client (D-121); rpc dispatched from an unregistered connection`,
      403,
    );
  }
  return caller.instance_id;
};

const badRequest = (message: string): RpcError =>
  new RpcError('bad_request', message, 400);

/** Lower-bound PEM-shape check. The substrate-side `TLSDomainUploadVerifiers`
 *  parses the cert and key with `node:crypto`'s X509Certificate /
 *  `crypto.createPrivateKey`; that's the authoritative parser. The
 *  handler-edge check exists to give Mary a fast `bad_request` on a
 *  clearly-empty string rather than a generic `tls_chain_invalid` /
 *  `tls_key_pair_mismatch` from the verifier — the verifier would
 *  reject these anyway, but the closed-list issue codes are designed
 *  for "your cert was parsed but failed gate X", not "you sent nothing".
 *
 *  Returns false on empty / non-PEM strings; the substrate validator
 *  handles every other case. */
const looksLikePem = (s: unknown): s is string =>
  typeof s === 'string' && s.length > 0 && s.includes('-----BEGIN ');

// Domain validation: non-empty string, no whitespace, no scheme prefix,
// no path. The store canonicalises on lowercase + trim; we reject
// pathological inputs at the handler edge so the substrate doesn't
// have to.
const looksLikeHostname = (s: unknown): s is string => {
  if (typeof s !== 'string') return false;
  const trimmed = s.trim();
  if (trimmed.length === 0 || trimmed.length > 253) return false;
  // No scheme, no path, no whitespace, no URL chars.
  if (/[\s/?#:]/.test(trimmed)) return false;
  return true;
};

// ────────────────────────────────────────────────────────────────
// Result mapping — TlsDomainUploadValidationError → RpcError
// ────────────────────────────────────────────────────────────────
//
// The store's `upload()` throws `TlsDomainUploadValidationError` with
// an `issues` array on validation failure. We surface the issues two
// ways:
//
//   - `RpcError.code` is set to the FIRST issue's code. The closed
//     `NetworkErrorCode` list pins this so the dispatcher carries it
//     end-to-end. Verifier order (SAN → key pair → chain → expiry)
//     matches the spec's bullet order; the first-failing gate is the
//     most actionable feedback.
//   - `RpcError.details` carries the full `issues` array under
//     `TlsDomainUploadErrorDetails`. The upload form renders one
//     inline hint per issue via `TLS_UPLOAD_ISSUE_COPY`.

const firstIssueCode = (
  issues: ReadonlyArray<TLSDomainUploadIssue>,
): TLSDomainUploadIssue['code'] => {
  if (issues.length === 0) {
    // Defense in depth — `TlsDomainUploadValidationError` is built from
    // `validateTLSDomainUpload`'s failure branch, which only constructs
    // the error when `issues.length > 0`. If we somehow land here, the
    // safest closed-list code is `tls_chain_invalid` (the catch-all
    // parse-failure path in the store's fingerprint helper).
    return 'tls_chain_invalid';
  }
  return issues[0]!.code;
};

const uploadValidationErrorToRpc = (
  method: string,
  err: TlsDomainUploadValidationError,
): RpcError => {
  const code = firstIssueCode(err.issues);
  const details: TlsDomainUploadErrorDetails = { issues: err.issues };
  return new RpcError(
    code,
    `${method}: ${err.message}`,
    400,
    undefined,
    details as unknown as Readonly<Record<string, unknown>>,
  );
};

const vaultLockedToRpc = (
  method: string,
  err: TlsDomainVaultLockedError,
): RpcError => {
  // Vault locked at upload time means the server's FileVault isn't
  // unlocked yet. The store can't AEAD-encrypt the private key without
  // the sub-DEK; refusing the upload (vs storing plaintext) is the
  // right call. Surface a clear-enough code; existing
  // `not_configured` already signals "this server isn't ready for this
  // rpc yet" — the upload form can offer Mary an "unlock vault" link.
  return new RpcError(
    'not_configured',
    `${method}: ${err.message}`,
    503,
  );
};

// ────────────────────────────────────────────────────────────────
// Handler functions
// ────────────────────────────────────────────────────────────────

export const handleTlsDomainUpload = async (
  deps: TlsDomainRpcDeps,
  args: {
    domain?: unknown;
    cert_pem?: unknown;
    private_key_pem?: unknown;
    chain_pem?: unknown;
    source?: unknown;
  },
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<TLSDomainUploadResult> => {
  const method = 'tls_domain.upload';
  requireCallerInstance(caller, method);

  // Capture into locals so the type narrowing from each `looksLike*`
  // predicate persists past subsequent checks. TypeScript's flow
  // analysis on `args.X` doesn't survive multiple intervening
  // statements on independent fields; local bindings carry the
  // narrowed type cleanly to the store call below.
  const rawDomain = args.domain;
  if (!looksLikeHostname(rawDomain)) {
    throw badRequest(
      `${method}: domain must be a non-empty hostname (no scheme, no path); got ${JSON.stringify(rawDomain)}`,
    );
  }
  const rawCert = args.cert_pem;
  if (!looksLikePem(rawCert)) {
    throw badRequest(
      `${method}: cert_pem must be a non-empty PEM-encoded string`,
    );
  }
  const rawKey = args.private_key_pem;
  if (!looksLikePem(rawKey)) {
    throw badRequest(
      `${method}: private_key_pem must be a non-empty PEM-encoded string`,
    );
  }
  const rawChain = args.chain_pem;
  if (rawChain !== undefined && !looksLikePem(rawChain)) {
    throw badRequest(
      `${method}: chain_pem must be a PEM-encoded string when present`,
    );
  }
  const rawSource = args.source;
  if (!isTLSDomainCertSource(rawSource)) {
    throw badRequest(
      `${method}: source must be one of ${TLS_DOMAIN_CERT_SOURCES.join(', ')}; got ${JSON.stringify(rawSource)}`,
    );
  }

  const uploadInput: {
    domain: string;
    cert_pem: string;
    private_key_pem: string;
    chain_pem?: string;
    source: TLSDomainCertSource;
  } = {
    domain: rawDomain,
    cert_pem: rawCert,
    private_key_pem: rawKey,
    source: rawSource,
  };
  if (typeof rawChain === 'string') {
    uploadInput.chain_pem = rawChain;
  }

  try {
    return await deps.getStore().upload(uploadInput);
  } catch (err) {
    if (err instanceof TlsDomainUploadValidationError) {
      throw uploadValidationErrorToRpc(method, err);
    }
    if (err instanceof TlsDomainVaultLockedError) {
      throw vaultLockedToRpc(method, err);
    }
    throw err;
  }
};

export const handleTlsDomainRemove = async (
  deps: TlsDomainRpcDeps,
  args: { domain?: unknown },
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<{ removed: boolean }> => {
  const method = 'tls_domain.remove';
  requireCallerInstance(caller, method);

  const rawDomain = args.domain;
  if (!looksLikeHostname(rawDomain)) {
    throw badRequest(
      `${method}: domain must be a non-empty hostname (no scheme, no path); got ${JSON.stringify(rawDomain)}`,
    );
  }

  // The substrate's `remove` is idempotent — delete-missing is a no-op
  // and returns void. We need to tell the renderer whether a row was
  // actually deleted (so the "removed" toast doesn't fire on a stale
  // row), so probe `list()` before + after. The list is bounded by the
  // domain count (one row per Pro hostname + per BYO domain), so this
  // is cheap. The store canonicalises lowercase + trim at the
  // persistence boundary (W3.6 P2 fold) — mirror that here so the
  // pre-state probe hits the same row the substrate will delete.
  const canonical = rawDomain.trim().toLowerCase();
  const store = deps.getStore();
  const existing = store.list().find((e) => e.domain === canonical);

  // Codex FU4 P2 fold — spec § A.6.3: "always allowed for `byo_upload`;
  // `pro_acme` requires explicit DDNS unbinding handled by the caller
  // before this rpc fires." A `pro_acme` row backs the auto-managed
  // `<handle>.recued.cloud` DDNS subdomain; deleting the cert without
  // first unbinding the DDNS leaves the public hostname without its
  // managed cert (and the next ACME renewal tick would re-create the
  // row from scratch, masking the operator's intent). Refuse the
  // operation here; the caller (Settings → Server → TLS Certificates
  // page) routes Pro-managed removals through the dedicated unbind
  // flow (FU5 — Pro auto-managed `<handle>.recued.cloud` flow) which
  // tears down the DDNS subdomain + cert in one transaction.
  if (existing?.source === 'pro_acme') {
    throw new RpcError(
      'tls_pro_acme_unbind_required',
      `${method}: Pro-managed cert for ${canonical} cannot be removed directly; unbind the DDNS subdomain first`,
      400,
    );
  }

  await store.remove(rawDomain);
  return { removed: existing !== undefined };
};

export const handleTlsDomainList = async (
  deps: TlsDomainRpcDeps,
  _args: Record<string, unknown>,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<{ entries: ReadonlyArray<TLSDomainCertListEntry> }> => {
  const method = 'tls_domain.list';
  requireCallerInstance(caller, method);
  return { entries: deps.getStore().list() };
};

// ────────────────────────────────────────────────────────────────
// Slice factory
// ────────────────────────────────────────────────────────────────

export const makeTlsDomainHandlers = (
  deps: TlsDomainRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, TlsDomainMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['tls_domain.upload', 'tls_domain.remove', 'tls_domain.list'],
    handlers: {
      'tls_domain.upload': async (args, client) =>
        handleTlsDomainUpload(
          deps,
          args as {
            domain?: unknown;
            cert_pem?: unknown;
            private_key_pem?: unknown;
            chain_pem?: unknown;
            source?: unknown;
          },
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'tls_domain.remove': async (args, client) =>
        handleTlsDomainRemove(
          deps,
          args as { domain?: unknown },
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'tls_domain.list': async (args, client) =>
        handleTlsDomainList(
          deps,
          args as Record<string, unknown>,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
    },
  };
};
