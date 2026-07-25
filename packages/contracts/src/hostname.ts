/** D-152 P0 — multi-hostname registry contracts.
 *
 * The registry is free substrate: it describes which hostnames a server may
 * answer for, how ownership was proven, and whether TLS terminates on Recued or
 * an upstream proxy. Public projections intentionally omit all cert/key bytes.
 */

import { resolveProDdnsHost } from './network.js';

declare const URL: {
  new (input: string): { hostname: string };
};

export const HOSTNAME_CERT_SOURCES = [
  'recued_acme',
  'byo_uploaded',
  'byo_external',
] as const;
export type HostnameCertSource = (typeof HOSTNAME_CERT_SOURCES)[number];

export const HOSTNAME_VERIFICATION_METHODS = [
  'cert_proof',
  'http_token',
  'dns_txt',
] as const;
export type HostnameVerificationMethod = (typeof HOSTNAME_VERIFICATION_METHODS)[number];

export const HOSTNAME_OWNERSHIP_STATUSES = [
  'pending',
  'verified',
  'failed',
] as const;
export type HostnameOwnershipStatus = (typeof HOSTNAME_OWNERSHIP_STATUSES)[number];

export const HOSTNAME_TLS_TOPOLOGIES = [
  'server_terminated',
  'upstream_terminated',
] as const;
export type HostnameTlsTopology = (typeof HOSTNAME_TLS_TOPOLOGIES)[number];

export const HOSTNAME_LISTENER_PORTS = [443, 8446, 8447, 8448] as const;
export type HostnameListenerPort = (typeof HOSTNAME_LISTENER_PORTS)[number];

export interface HostnameCertChainMetadata {
  issuer: string;
  subject: string;
}

/** Server-internal storage row. Never expose this shape over RPC. */
export interface HostnameStorageRow {
  hostname_id: string;
  server_identity_id: string;
  hostname_normalized: string;
  cert_source: HostnameCertSource;
  cert_blob_id?: string;
  cert_fingerprint?: string;
  cert_expires_at?: number;
  cert_chain_metadata?: HostnameCertChainMetadata;
  ownership_status: HostnameOwnershipStatus;
  verification_method?: HostnameVerificationMethod;
  verification_token_hash?: string;
  verified_at?: number;
  listener_ports: ReadonlyArray<HostnameListenerPort>;
  ddns_managed: boolean;
  enabled: boolean;
  tls_topology: HostnameTlsTopology;
  created_at: number;
  updated_at: number;
}

/** RPC/list projection. Excludes `cert_blob_id`, cert PEM, and private key PEM. */
export interface HostnameProjection {
  hostname_id: string;
  hostname: string;
  cert_source: HostnameCertSource;
  cert_fingerprint?: string;
  cert_expires_at?: number;
  cert_chain_metadata?: HostnameCertChainMetadata;
  ownership_status: HostnameOwnershipStatus;
  verification_method?: HostnameVerificationMethod;
  listener_ports: ReadonlyArray<HostnameListenerPort>;
  ddns_managed: boolean;
  enabled: boolean;
  tls_topology: HostnameTlsTopology;
}

export interface HostnameListResponse {
  hostnames: HostnameProjection[];
}

export interface HostnameGetRequest {
  hostname: string;
}

export interface HostnameGetResponse {
  hostname: HostnameProjection | null;
}

export interface HostnameAddRequest {
  hostname: string;
  cert_source: HostnameCertSource;
  cert_blob_id?: string;
  cert_fingerprint?: string;
  cert_expires_at?: number;
  cert_chain_metadata?: HostnameCertChainMetadata;
  ownership_status?: HostnameOwnershipStatus;
  verification_method?: HostnameVerificationMethod;
  verification_token_hash?: string;
  verified_at?: number;
  listener_ports?: ReadonlyArray<number>;
  ddns_managed?: boolean;
  enabled?: boolean;
}

export interface HostnameUpdateRequest
  extends Partial<Omit<HostnameAddRequest, 'hostname' | 'cert_source'>> {
  hostname: string;
  cert_source?: HostnameCertSource;
}

export interface HostnameMutationResponse {
  hostname: HostnameProjection;
}

export interface HostnameRemoveRequest {
  hostname: string;
}

export interface HostnameRemoveResponse {
  removed: boolean;
}

export type HostnameOwnershipProofInput =
  | {
      hostname: string;
      method: 'cert_proof';
      cert_matches_hostname: boolean;
    }
  | {
      hostname: string;
      method: 'http_token';
      observed_token_hash: string;
    }
  | {
      hostname: string;
      method: 'dns_txt';
      observed_token_hash: string;
    };

export type HostnameOwnershipProofFailureCode =
  | 'invalid_hostname'
  | 'not_found'
  | 'recued_acme_preverified'
  | 'incompatible_proof_method'
  | 'method_mismatch'
  | 'missing_token_hash';

export type HostnameOwnershipProofResult =
  | {
      ok: true;
      hostname: string;
      method: HostnameVerificationMethod;
      status: Extract<HostnameOwnershipStatus, 'verified' | 'failed'>;
      projection: HostnameProjection;
    }
  | {
      ok: false;
      code: HostnameOwnershipProofFailureCode;
      hostname: string;
      method: HostnameVerificationMethod;
      expected_method?: HostnameVerificationMethod;
      cert_source?: HostnameCertSource;
    };

export const isHostnameCertSource = (value: unknown): value is HostnameCertSource =>
  typeof value === 'string'
  && (HOSTNAME_CERT_SOURCES as readonly string[]).includes(value);

export const isHostnameVerificationMethod = (
  value: unknown,
): value is HostnameVerificationMethod =>
  typeof value === 'string'
  && (HOSTNAME_VERIFICATION_METHODS as readonly string[]).includes(value);

export const isHostnameOwnershipStatus = (
  value: unknown,
): value is HostnameOwnershipStatus =>
  typeof value === 'string'
  && (HOSTNAME_OWNERSHIP_STATUSES as readonly string[]).includes(value);

export const isHostnameTlsTopology = (value: unknown): value is HostnameTlsTopology =>
  typeof value === 'string'
  && (HOSTNAME_TLS_TOPOLOGIES as readonly string[]).includes(value);

export const isHostnameListenerPort = (value: unknown): value is HostnameListenerPort =>
  typeof value === 'number'
  && (HOSTNAME_LISTENER_PORTS as readonly number[]).includes(value);

export const tlsTopologyForHostnameCertSource = (
  certSource: HostnameCertSource,
): HostnameTlsTopology =>
  certSource === 'byo_external' ? 'upstream_terminated' : 'server_terminated';

/** D-176 — is `hostname` a single-label handle subdomain of an ENABLED Pro
 *  DDNS zone, with an RFC-1123-valid label? Used by the registry / poller /
 *  reconciler to gate managed Pro DDNS rows. Zone-agnostic via the DDNS_ZONES
 *  registry: `resolveProDdnsHost` enforces "single-label handle of an enabled
 *  zone"; the regex re-validates the label charset (resolve deliberately does
 *  not — handle charset is a registration-time gate). */
export const isSingleLabelProDdnsHostname = (hostname: string): boolean => {
  const resolved = resolveProDdnsHost(hostname);
  return (
    resolved !== null
    && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(resolved.handle)
  );
};

const hasInvalidHostnameChars = (value: string): boolean =>
  /[\s/:?#\\]/.test(value);

/** Normalize a DNS hostname to lowercase ASCII/punycode. Returns null for
 * inputs that are not bare hostnames (schemes, paths, ports, empty labels,
 * overlong labels, and leading/trailing hyphens are rejected). */
export const normalizeHostname = (input: string): string | null => {
  const trimmed = input.trim().replace(/\.$/, '');
  if (!trimmed || hasInvalidHostnameChars(trimmed)) return null;

  let ascii: string;
  try {
    ascii = new URL(`http://${trimmed}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!ascii || ascii.length > 253 || ascii.includes('..')) return null;

  const labels = ascii.split('.');
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (
      label.length === 0
      || label.length > 63
      || label.startsWith('-')
      || label.endsWith('-')
      || !/^[a-z0-9-]+$/.test(label)
    ) {
      return null;
    }
  }
  return ascii;
};

export const projectHostname = (row: HostnameStorageRow): HostnameProjection => {
  const projection: HostnameProjection = {
    hostname_id: row.hostname_id,
    hostname: row.hostname_normalized,
    cert_source: row.cert_source,
    ownership_status: row.ownership_status,
    listener_ports: row.listener_ports,
    ddns_managed: row.ddns_managed,
    enabled: row.enabled,
    tls_topology: row.tls_topology,
  };
  if (row.cert_fingerprint !== undefined) projection.cert_fingerprint = row.cert_fingerprint;
  if (row.cert_expires_at !== undefined) projection.cert_expires_at = row.cert_expires_at;
  if (row.cert_chain_metadata !== undefined) projection.cert_chain_metadata = row.cert_chain_metadata;
  if (row.verification_method !== undefined) projection.verification_method = row.verification_method;
  return projection;
};

export const canBindHostname = (
  row: Pick<HostnameStorageRow, 'enabled' | 'ownership_status' | 'tls_topology'>,
  topology?: HostnameTlsTopology,
): boolean =>
  row.enabled
  && row.ownership_status === 'verified'
  && (topology === undefined || row.tls_topology === topology);
