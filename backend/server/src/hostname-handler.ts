/** D-152 — `collection.hostname.*` rpc handlers.
 *
 * Thin Settings-only adapter over the hostname registry store plus the
 * ownership-proof state machine. The store remains the authority for
 * normalization, closed cert-source/listener-port validation, and SNI binding
 * eligibility; this file validates the rpc wire shape and prevents callers from
 * spoofing the server identity id.
 */

import {
  RpcError,
  isHostnameCertSource,
  isHostnameOwnershipStatus,
  isHostnameVerificationMethod,
  evaluateCustomDomainIssuanceEligibility,
  projectHostname,
  zoneByLabel,
  type CustomDomainIssuanceReadinessRequest,
  type CustomDomainIssuanceReadinessResponse,
  type CustomDomainPreflightRequest,
  type CustomDomainPreflightResponse,
  type HandlerSlice,
  type HostnameAddRequest,
  type HostnameCertChainMetadata,
  type HostnameGetRequest,
  type HostnameGetResponse,
  type HostnameListResponse,
  type HostnameMutationResponse,
  type HostnameOwnershipProofInput,
  type HostnameOwnershipProofResult,
  type HostnameRemoveRequest,
  type HostnameRemoveResponse,
  type HostnameUpdateRequest,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { InitialAcmeDomainIssuer } from './keys/rotation/acme-domain-renewer.js';
import type { TlsRenewalFailureReason } from './keys/rotation/index.js';
import { applyHostnameOwnershipProof } from './hostname/ownership-proof.js';
import {
  createNodeCustomDomainDnsResolver,
  runCustomDomainPreflight,
  type CustomDomainDnsResolver,
} from './hostname/custom-domain-preflight.js';
import {
  HostnameRegistryError,
  type HostnameRegistryStore,
  type HostnameRegistryUpsertInput,
} from './storage/hostname-registry.js';
import type { WsClient } from './ws-server.js';

/** D-235 P1 — the server's own Pro DDNS binding. Preflight derives the
 *  delegation target from THIS, never from the request: a caller that could
 *  name the handle could ask us to certify that someone else's domain is
 *  correctly delegated to a zone they don't hold. */
export interface HostnameProDdnsBinding {
  handle: string;
  /** `DdnsZone.label` (e.g. `net`). Absent ⇒ the registry default. */
  zone_label?: string;
  /** D-235 P2 § 3.2 gate 4 — is the reservation currently paid for?
   *
   *  ⚠ Computed by the composer, not here: `grace` is deliberately NOT active.
   *  The cloud pulls a lapsed subscription's DNS records, so DNS-01 cannot
   *  validate and every attempt would burn CA quota to fail — the same call
   *  `wire-pro-cert-enrollment.ts` already makes for the fleet-zone path. */
  subscription_active: boolean;
}

export interface HostnameRpcDeps {
  store: HostnameRegistryStore;
  serverIdentityId: string;
  initialAcmeIssuer?: () => InitialAcmeDomainIssuer | undefined;
  /** Resolves the server's reserved handle + bound zone. Absent (or resolving
   *  to null) means no Pro handle is reserved, so there is no delegation target
   *  to preflight against and `collection.hostname.preflight` declines. */
  proDdnsBinding?: () => Promise<HostnameProDdnsBinding | null>;
  /** DNS seam — injected by tests. Production builds a Node resolver lazily so
   *  a server that never opens the Domains panel never constructs one. */
  dnsResolver?: CustomDomainDnsResolver;
}

type HostnameMethods =
  | 'collection.hostname.list'
  | 'collection.hostname.get'
  | 'collection.hostname.add'
  | 'collection.hostname.update'
  | 'collection.hostname.remove'
  | 'collection.hostname.verifyOwnership'
  | 'collection.hostname.preflight'
  | 'collection.hostname.issuanceReadiness';

const requireCallerInstance = (
  caller: { instance_id: string | null | undefined } | undefined,
  method: string,
): void => {
  if (!caller?.instance_id) {
    throw new RpcError(
      'permission_denied',
      `${method}: requires a paired client (D-121); rpc dispatched from an unregistered connection`,
      403,
    );
  }
};

const badRequest = (message: string): RpcError =>
  new RpcError('bad_request', message, 400);

const ensureRecordArgs = (method: string, args: unknown): Record<string, unknown> => {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw badRequest(`${method}: args must be an object`);
  }
  return args as Record<string, unknown>;
};

const ensureString = (
  method: string,
  field: string,
  value: unknown,
): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw badRequest(`${method}: ${field} must be a non-empty string`);
  }
  return value;
};

const ensureOptionalString = (
  method: string,
  field: string,
  value: unknown,
): string | undefined => {
  if (value === undefined) return undefined;
  return ensureString(method, field, value);
};

const ensureOptionalNumber = (
  method: string,
  field: string,
  value: unknown,
): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw badRequest(`${method}: ${field} must be a non-negative finite number`);
  }
  return value;
};

const ensureOptionalBoolean = (
  method: string,
  field: string,
  value: unknown,
): boolean | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw badRequest(`${method}: ${field} must be a boolean`);
  }
  return value;
};

const ensureCertChainMetadata = (
  method: string,
  value: unknown,
): HostnameCertChainMetadata | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(`${method}: cert_chain_metadata must be an object when present`);
  }
  const record = value as Record<string, unknown>;
  const issuer = ensureString(method, 'cert_chain_metadata.issuer', record.issuer);
  const subject = ensureString(method, 'cert_chain_metadata.subject', record.subject);
  return { issuer, subject };
};

const ensureListenerPorts = (
  method: string,
  value: unknown,
): ReadonlyArray<number> | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw badRequest(`${method}: listener_ports must be an array when present`);
  }
  const ports: number[] = [];
  for (const port of value) {
    if (typeof port !== 'number' || !Number.isFinite(port)) {
      throw badRequest(`${method}: listener_ports must contain only numbers`);
    }
    ports.push(port);
  }
  return ports;
};

const registryErrorToRpc = (method: string, err: HostnameRegistryError): RpcError => {
  const status = err.code === 'not_found' ? 404 : 400;
  return new RpcError(err.code, `${method}: ${err.message}`, status);
};

const withRegistryErrors = <T>(method: string, fn: () => T): T => {
  try {
    return fn();
  } catch (err) {
    if (err instanceof HostnameRegistryError) {
      throw registryErrorToRpc(method, err);
    }
    throw err;
  }
};

const fillOptionalUpsertFields = (
  method: string,
  input: HostnameRegistryUpsertInput,
  args: Record<string, unknown>,
): void => {
  const certBlobId = ensureOptionalString(method, 'cert_blob_id', args.cert_blob_id);
  if (certBlobId !== undefined) input.cert_blob_id = certBlobId;
  const certFingerprint = ensureOptionalString(method, 'cert_fingerprint', args.cert_fingerprint);
  if (certFingerprint !== undefined) input.cert_fingerprint = certFingerprint;
  const certExpiresAt = ensureOptionalNumber(method, 'cert_expires_at', args.cert_expires_at);
  if (certExpiresAt !== undefined) input.cert_expires_at = certExpiresAt;
  const certChainMetadata = ensureCertChainMetadata(method, args.cert_chain_metadata);
  if (certChainMetadata !== undefined) input.cert_chain_metadata = certChainMetadata;
  if (args.ownership_status !== undefined) {
    if (!isHostnameOwnershipStatus(args.ownership_status)) {
      throw badRequest(`${method}: ownership_status is invalid`);
    }
    input.ownership_status = args.ownership_status;
  }
  if (args.verification_method !== undefined) {
    if (!isHostnameVerificationMethod(args.verification_method)) {
      throw badRequest(`${method}: verification_method is invalid`);
    }
    input.verification_method = args.verification_method;
  }
  const verificationTokenHash = ensureOptionalString(
    method,
    'verification_token_hash',
    args.verification_token_hash,
  );
  if (verificationTokenHash !== undefined) input.verification_token_hash = verificationTokenHash;
  const verifiedAt = ensureOptionalNumber(method, 'verified_at', args.verified_at);
  if (verifiedAt !== undefined) input.verified_at = verifiedAt;
  const listenerPorts = ensureListenerPorts(method, args.listener_ports);
  if (listenerPorts !== undefined) input.listener_ports = listenerPorts;
  const ddnsManaged = ensureOptionalBoolean(method, 'ddns_managed', args.ddns_managed);
  if (ddnsManaged !== undefined) input.ddns_managed = ddnsManaged;
  const enabled = ensureOptionalBoolean(method, 'enabled', args.enabled);
  if (enabled !== undefined) input.enabled = enabled;
};

const initialAcmeFailureToRpc = (
  method: string,
  reason: TlsRenewalFailureReason,
): RpcError => {
  if (reason === 'helper_unavailable') {
    return new RpcError(
      'acme_helper_unavailable',
      `${method}: Recued ACME issuer is unavailable for initial hostname certificate issuance`,
      503,
    );
  }
  if (reason === 'subscription_required') {
    return new RpcError(
      'subscription_required',
      `${method}: Recued ACME certificate issuance requires an active Pro subscription`,
      402,
    );
  }
  // 429 from the cloud helper. Answered explicitly rather than left to fall
  // through to `storage_io_error` below — nothing failed to store; the
  // issuance was refused on quota, and 503-with-retry is the honest shape.
  if (reason === 'rate_limited') {
    return new RpcError(
      'acme_rate_limited',
      `${method}: this server has spent its daily certificate issuance allowance; retry after the 24h window resets`,
      429,
    );
  }
  return new RpcError(
    'storage_io_error',
    `${method}: issued Recued ACME certificate could not be stored`,
    500,
  );
};

const withInitialRecuedAcmeCert = async (
  deps: HostnameRpcDeps,
  method: string,
  hostname: string,
  /** True when the row existed BEFORE this mutation — see the defer note. */
  alreadyRegistered = false,
): Promise<HostnameMutationResponse> => {
  const row = withRegistryErrors(method, () => deps.store.get(hostname));
  if (!row) {
    throw new RpcError('not_found', `${method}: hostname not found after mutation`, 404);
  }
  if (
    row.cert_source !== 'recued_acme'
    || row.ownership_status !== 'verified'
    || row.cert_fingerprint !== undefined
  ) {
    return { hostname: projectHostname(row) };
  }

  // ⛔ DEFER WHEN THE ROW ALREADY EXISTED — `pro-cert-enrollment` owns it.
  //
  //    The background service creates the Pro DDNS row and orders its
  //    certificate on its own cadence, retrying on its own backoff. If this
  //    handler also issued for a row the service had already registered, one
  //    hostname would have TWO racing attempts — and CAs rate-limit FAILED
  //    validations (LE: 5 per account per hostname per hour), so a racing pair
  //    can exhaust the limit and block both. Observed live: the enrollment
  //    service and a manual `.add` both ordering for the same host in one run.
  //
  //    A FRESH add still issues inline, so a user adding a hostname gets
  //    immediate feedback rather than waiting for the next background tick.
  //
  //    Returning the row is the honest answer, not a silent no-op: it carries
  //    no `cert_fingerprint`, which is exactly the pending state the UI
  //    renders — "registered, provisioning", and the server finishes it.
  //
  // ⚠ Keyed on PRE-EXISTENCE, not on `ddns_managed`. My first attempt used the
  //   latter and was wrong twice over: `cert_source: 'recued_acme'` already
  //   REQUIRES a single-label Pro DDNS hostname (`hostname-registry.ts` — a BYO
  //   domain cannot use it), and BYO rows never reach this line anyway because
  //   the `cert_source !== 'recued_acme'` guard above returns first. So the
  //   "BYO keeps issuing inline" carve-out it was protecting cannot occur.
  if (alreadyRegistered) {
    return { hostname: projectHostname(row) };
  }

  if (!deps.initialAcmeIssuer) {
    return { hostname: projectHostname(row) };
  }
  const issuer = deps.initialAcmeIssuer();
  if (!issuer) {
    throw new RpcError(
      'not_configured',
      `${method}: Recued ACME issuer is not ready for initial hostname certificate issuance`,
      503,
    );
  }

  const issued = await issuer.issueInitialDomain({ domain: row.hostname_normalized });
  if (!issued.ok) {
    throw initialAcmeFailureToRpc(method, issued.reason);
  }

  const input: HostnameRegistryUpsertInput = {
    hostname_id: row.hostname_id,
    server_identity_id: deps.serverIdentityId,
    hostname: row.hostname_normalized,
    cert_source: row.cert_source,
    cert_fingerprint: issued.new_fingerprint,
    cert_expires_at: issued.cert_expires_at,
    ownership_status: row.ownership_status,
    listener_ports: row.listener_ports,
    ddns_managed: row.ddns_managed,
    enabled: row.enabled,
  };
  if (row.cert_blob_id !== undefined) input.cert_blob_id = row.cert_blob_id;
  if (row.cert_chain_metadata !== undefined) {
    input.cert_chain_metadata = row.cert_chain_metadata;
  }
  if (row.verification_method !== undefined) {
    input.verification_method = row.verification_method;
  }
  if (row.verification_token_hash !== undefined) {
    input.verification_token_hash = row.verification_token_hash;
  }
  if (row.verified_at !== undefined) input.verified_at = row.verified_at;

  return {
    hostname: withRegistryErrors(method, () => deps.store.upsert(input)),
  };
};

export const handleHostnameList = async (
  deps: HostnameRpcDeps,
  _args: void,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<HostnameListResponse> => {
  const method = 'collection.hostname.list';
  requireCallerInstance(caller, method);
  return { hostnames: deps.store.list().slice() };
};

export const handleHostnameGet = async (
  deps: HostnameRpcDeps,
  args: HostnameGetRequest,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<HostnameGetResponse> => {
  const method = 'collection.hostname.get';
  requireCallerInstance(caller, method);
  const a = ensureRecordArgs(method, args);
  const hostname = ensureString(method, 'hostname', a.hostname);
  const row = withRegistryErrors(method, () => deps.store.get(hostname));
  return { hostname: row ? projectHostname(row) : null };
};

export const handleHostnameAdd = async (
  deps: HostnameRpcDeps,
  args: HostnameAddRequest,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<HostnameMutationResponse> => {
  const method = 'collection.hostname.add';
  requireCallerInstance(caller, method);
  const a = ensureRecordArgs(method, args);
  const hostname = ensureString(method, 'hostname', a.hostname);
  if (!isHostnameCertSource(a.cert_source)) {
    throw badRequest(`${method}: cert_source is invalid`);
  }
  const input: HostnameRegistryUpsertInput = {
    server_identity_id: deps.serverIdentityId,
    hostname,
    cert_source: a.cert_source,
  };
  fillOptionalUpsertFields(method, input, a);
  // Read BEFORE the upsert — afterwards every row looks pre-existing.
  const alreadyRegistered = withRegistryErrors(method, () => deps.store.get(hostname)) !== null;
  const hostnameProjection = withRegistryErrors(method, () => deps.store.upsert(input));
  return withInitialRecuedAcmeCert(
    deps, method, hostnameProjection.hostname, alreadyRegistered,
  );
};

export const handleHostnameUpdate = async (
  deps: HostnameRpcDeps,
  args: HostnameUpdateRequest,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<HostnameMutationResponse> => {
  const method = 'collection.hostname.update';
  requireCallerInstance(caller, method);
  const a = ensureRecordArgs(method, args);
  const hostname = ensureString(method, 'hostname', a.hostname);
  const existing = withRegistryErrors(method, () => deps.store.get(hostname));
  if (!existing) {
    throw new RpcError('not_found', `${method}: hostname not found`, 404);
  }
  if (a.cert_source !== undefined && !isHostnameCertSource(a.cert_source)) {
    throw badRequest(`${method}: cert_source is invalid`);
  }

  const certSource = a.cert_source ?? existing.cert_source;
  const certSourceChanged = certSource !== existing.cert_source;
  const proofConfigChanged = certSourceChanged
    || a.verification_method !== undefined
    || a.verification_token_hash !== undefined;
  const input: HostnameRegistryUpsertInput = {
    hostname_id: existing.hostname_id,
    server_identity_id: deps.serverIdentityId,
    hostname: existing.hostname_normalized,
    cert_source: certSource,
    listener_ports: existing.listener_ports,
    ddns_managed: existing.ddns_managed,
    enabled: existing.enabled,
  };

  if (!certSourceChanged && existing.cert_blob_id !== undefined) {
    input.cert_blob_id = existing.cert_blob_id;
  }
  if (!certSourceChanged && existing.cert_fingerprint !== undefined) {
    input.cert_fingerprint = existing.cert_fingerprint;
  }
  if (!certSourceChanged && existing.cert_expires_at !== undefined) {
    input.cert_expires_at = existing.cert_expires_at;
  }
  if (!certSourceChanged && existing.cert_chain_metadata !== undefined) {
    input.cert_chain_metadata = existing.cert_chain_metadata;
  }
  if (!proofConfigChanged) {
    input.ownership_status = existing.ownership_status;
    if (existing.verification_method !== undefined) {
      input.verification_method = existing.verification_method;
    }
    if (existing.verification_token_hash !== undefined) {
      input.verification_token_hash = existing.verification_token_hash;
    }
    if (existing.verified_at !== undefined) {
      input.verified_at = existing.verified_at;
    }
  }

  fillOptionalUpsertFields(method, input, a);
  const hostnameProjection = withRegistryErrors(method, () => deps.store.upsert(input));
  return withInitialRecuedAcmeCert(deps, method, hostnameProjection.hostname);
};

export const handleHostnameRemove = async (
  deps: HostnameRpcDeps,
  args: HostnameRemoveRequest,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<HostnameRemoveResponse> => {
  const method = 'collection.hostname.remove';
  requireCallerInstance(caller, method);
  const a = ensureRecordArgs(method, args);
  const hostname = ensureString(method, 'hostname', a.hostname);
  return {
    removed: withRegistryErrors(method, () => deps.store.remove(hostname)),
  };
};

const ensureProofInput = (
  method: string,
  args: unknown,
): HostnameOwnershipProofInput => {
  const a = ensureRecordArgs(method, args);
  const hostname = ensureString(method, 'hostname', a.hostname);
  const proofMethod = ensureString(method, 'method', a.method);
  if (proofMethod === 'cert_proof') {
    if (typeof a.cert_matches_hostname !== 'boolean') {
      throw badRequest(`${method}: cert_matches_hostname must be a boolean`);
    }
    return {
      hostname,
      method: proofMethod,
      cert_matches_hostname: a.cert_matches_hostname,
    };
  }
  if (proofMethod === 'http_token' || proofMethod === 'dns_txt') {
    return {
      hostname,
      method: proofMethod,
      observed_token_hash: ensureString(method, 'observed_token_hash', a.observed_token_hash),
    };
  }
  throw badRequest(`${method}: method is invalid`);
};

export const handleHostnameVerifyOwnership = async (
  deps: HostnameRpcDeps,
  args: HostnameOwnershipProofInput,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<HostnameOwnershipProofResult> => {
  const method = 'collection.hostname.verifyOwnership';
  requireCallerInstance(caller, method);
  return applyHostnameOwnershipProof(deps.store, ensureProofInput(method, args));
};

/** D-235 P1 — read-only DNS preflight for a bring-your-own-domain hostname.
 *
 *  Reads nothing from the registry and writes nothing anywhere: the hostname
 *  need not be enrolled yet, which is the point — the user checks their two
 *  CNAMEs BEFORE committing to a row. Failures are reported in the payload,
 *  not thrown, so the Settings panel can render per-record guidance; the only
 *  throws are "you didn't give me a hostname" and "this server has no Pro
 *  handle, so there is no delegation target to check against". */
export const handleHostnamePreflight = async (
  deps: HostnameRpcDeps,
  args: CustomDomainPreflightRequest,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<CustomDomainPreflightResponse> => {
  const method = 'collection.hostname.preflight';
  requireCallerInstance(caller, method);
  const a = ensureRecordArgs(method, args);
  const hostname = ensureString(method, 'hostname', a.hostname);

  const binding = deps.proDdnsBinding ? await deps.proDdnsBinding() : null;
  if (!binding || binding.handle.length === 0) {
    throw new RpcError(
      'not_configured',
      `${method}: no Pro DDNS handle is reserved on this server, so there is no `
        + `_acme-challenge delegation target to check a custom domain against`,
      // 503, not 4xx: the handle is reserved by a background service ~26s into
      // boot, so a client that asks too early should retry rather than be told
      // its request was wrong.
      503,
    );
  }
  // An unknown label falls back to the registry default rather than failing —
  // same forward-compat rule the rest of the D-176 zone plumbing follows.
  const zone = binding.zone_label !== undefined
    ? zoneByLabel(binding.zone_label)
    : undefined;

  const preflight = await runCustomDomainPreflight({
    hostname,
    handle: binding.handle,
    ...(zone !== undefined ? { zone } : {}),
    resolver: deps.dnsResolver ?? createNodeCustomDomainDnsResolver(),
  });
  return { preflight };
};

/** D-235 P2 — would the fleet issue for this hostname right now?
 *
 *  Runs a LIVE preflight and composes § 3.2's four gates over it. Returns the
 *  preflight alongside the decision so the panel renders one consistent view
 *  rather than asking twice and getting two answers from a zone mid-edit.
 *
 *  ⛔ Local policy, not authority — see `evaluateCustomDomainIssuanceEligibility`
 *  and spec § 8.2. A hostname this says is ready can still be refused by the
 *  cloud, which re-resolves the delegation itself. */
export const handleHostnameIssuanceReadiness = async (
  deps: HostnameRpcDeps,
  args: CustomDomainIssuanceReadinessRequest,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<CustomDomainIssuanceReadinessResponse> => {
  const method = 'collection.hostname.issuanceReadiness';
  const { preflight } = await handleHostnamePreflight(deps, args, caller);
  const row = withRegistryErrors(method, () => deps.store.get(preflight.hostname));
  const binding = deps.proDdnsBinding ? await deps.proDdnsBinding() : null;

  // An un-enrolled hostname is not a custom-ACME row, so the gate declines with
  // `not_a_custom_acme_hostname` — which is the honest answer to "would you
  // issue for this?" before the user has asked us to.
  const decision = evaluateCustomDomainIssuanceEligibility({
    row: row ?? {
      cert_source: 'unregistered',
      ownership_status: 'pending',
      enabled: false,
    },
    preflight,
    subscription_active: binding?.subscription_active === true,
    enrolled_custom_count: deps.store
      .list()
      .filter((h) => h.cert_source === 'recued_acme_custom').length,
  });
  return { decision, preflight };
};

export const makeHostnameHandlers = (
  deps: HostnameRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, HostnameMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: [
      'collection.hostname.list',
      'collection.hostname.get',
      'collection.hostname.add',
      'collection.hostname.update',
      'collection.hostname.remove',
      'collection.hostname.verifyOwnership',
      'collection.hostname.preflight',
      'collection.hostname.issuanceReadiness',
    ],
    handlers: {
      'collection.hostname.list': async (args, client) =>
        handleHostnameList(
          deps,
          args as void,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'collection.hostname.get': async (args, client) =>
        handleHostnameGet(
          deps,
          args as HostnameGetRequest,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'collection.hostname.add': async (args, client) =>
        handleHostnameAdd(
          deps,
          args as HostnameAddRequest,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'collection.hostname.update': async (args, client) =>
        handleHostnameUpdate(
          deps,
          args as HostnameUpdateRequest,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'collection.hostname.remove': async (args, client) =>
        handleHostnameRemove(
          deps,
          args as HostnameRemoveRequest,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'collection.hostname.verifyOwnership': async (args, client) =>
        handleHostnameVerifyOwnership(
          deps,
          args as HostnameOwnershipProofInput,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'collection.hostname.preflight': async (args, client) =>
        handleHostnamePreflight(
          deps,
          args as CustomDomainPreflightRequest,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'collection.hostname.issuanceReadiness': async (args, client) =>
        handleHostnameIssuanceReadiness(
          deps,
          args as CustomDomainIssuanceReadinessRequest,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
    },
  };
};
