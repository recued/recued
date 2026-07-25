/** D-152 P0 — SQLite-backed multi-hostname registry.
 *
 * This is the server-internal substrate behind future `hostname.*` RPCs and
 * listener binding. It deliberately has no entitlement/Pro imports: the free
 * registry accepts BYO hostnames, while DDNS/ACME-specific callers decide when
 * a `recued_acme` row is allowed.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  HOSTNAME_LISTENER_PORTS,
  canBindHostname,
  isHostnameListenerPort,
  isSingleLabelProDdnsHostname,
  normalizeHostname,
  projectHostname,
  tlsTopologyForHostnameCertSource,
  type HostnameCertChainMetadata,
  type HostnameCertSource,
  type HostnameListenerPort,
  type HostnameOwnershipStatus,
  type HostnameProjection,
  type HostnameStorageRow,
  type HostnameTlsTopology,
  type HostnameVerificationMethod,
} from '@recued/contracts';

export const HOSTNAME_REGISTRY_TABLES = ['hostname_registry', 'cert_blob'] as const;
export type HostnameRegistryTableName = (typeof HOSTNAME_REGISTRY_TABLES)[number];

export const ensureHostnameRegistrySchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cert_blob (
      id TEXT PRIMARY KEY,
      cert_pem_encrypted BLOB NOT NULL,
      private_key_pem_encrypted BLOB NOT NULL,
      sub_dek_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hostname_registry (
      hostname_id TEXT PRIMARY KEY,
      server_identity_id TEXT NOT NULL,
      hostname_normalized TEXT NOT NULL UNIQUE,
      cert_source TEXT NOT NULL CHECK (cert_source IN ('recued_acme', 'byo_uploaded', 'byo_external')),
      cert_blob_id TEXT,
      cert_fingerprint TEXT,
      cert_expires_at INTEGER,
      cert_chain_metadata_json TEXT,
      ownership_status TEXT NOT NULL DEFAULT 'pending' CHECK (ownership_status IN ('pending', 'verified', 'failed')),
      verification_method TEXT CHECK (verification_method IN ('cert_proof', 'http_token', 'dns_txt')),
      verification_token_hash TEXT,
      verified_at INTEGER,
      listener_ports_json TEXT NOT NULL,
      ddns_managed INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 0,
      tls_topology TEXT NOT NULL CHECK (tls_topology IN ('server_terminated', 'upstream_terminated')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS hostname_registry_by_server
      ON hostname_registry(server_identity_id);
    CREATE INDEX IF NOT EXISTS hostname_registry_by_status
      ON hostname_registry(ownership_status);
  `);
};

export type HostnameRegistryErrorCode =
  | 'invalid_hostname'
  | 'invalid_listener_port'
  | 'invalid_ddns_managed_hostname'
  | 'invalid_recued_acme_hostname'
  | 'not_found';

export class HostnameRegistryError extends Error {
  constructor(
    public readonly code: HostnameRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HostnameRegistryError';
  }
}

export interface HostnameRegistryUpsertInput {
  hostname_id?: string;
  server_identity_id: string;
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

export interface HostnameRegistryStore {
  upsert(input: HostnameRegistryUpsertInput): HostnameProjection;
  get(hostname: string): HostnameStorageRow | null;
  list(): ReadonlyArray<HostnameProjection>;
  setEnabled(hostname: string, enabled: boolean): HostnameProjection | null;
  setOwnership(input: {
    hostname: string;
    status: HostnameOwnershipStatus;
    verification_method?: HostnameVerificationMethod;
    verification_token_hash?: string;
  }): HostnameProjection | null;
  remove(hostname: string): boolean;
  lookupBinding(hostname: string, topology: HostnameTlsTopology): HostnameStorageRow | null;
}

export interface CreateHostnameRegistryStoreOptions {
  now?: () => number;
  newId?: () => string;
}

interface HostnameRegistryDbRow {
  hostname_id: string;
  server_identity_id: string;
  hostname_normalized: string;
  cert_source: string;
  cert_blob_id: string | null;
  cert_fingerprint: string | null;
  cert_expires_at: number | null;
  cert_chain_metadata_json: string | null;
  ownership_status: string;
  verification_method: string | null;
  verification_token_hash: string | null;
  verified_at: number | null;
  listener_ports_json: string;
  ddns_managed: number;
  enabled: number;
  tls_topology: string;
  created_at: number;
  updated_at: number;
}

const DEFAULT_LISTENER_PORTS: ReadonlyArray<HostnameListenerPort> = [443];

const normalizeOrThrow = (hostname: string): string => {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    throw new HostnameRegistryError(
      'invalid_hostname',
      `hostname registry: invalid hostname '${hostname}'`,
    );
  }
  return normalized;
};

const normalizePorts = (
  ports: ReadonlyArray<number> | undefined,
): ReadonlyArray<HostnameListenerPort> => {
  const raw = ports ?? DEFAULT_LISTENER_PORTS;
  const out: HostnameListenerPort[] = [];
  for (const port of raw) {
    if (!isHostnameListenerPort(port)) {
      throw new HostnameRegistryError(
        'invalid_listener_port',
        `hostname registry: listener port ${String(port)} is not allowed`,
      );
    }
    if (!out.includes(port)) out.push(port);
  }
  return out.length > 0 ? out : DEFAULT_LISTENER_PORTS;
};

const parsePorts = (raw: string): ReadonlyArray<HostnameListenerPort> => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter(isHostnameListenerPort);
    }
  } catch {
    /* tampered row */
  }
  return [];
};

const parseCertChainMetadata = (
  raw: string | null,
): HostnameCertChainMetadata | undefined => {
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && typeof (parsed as { issuer?: unknown }).issuer === 'string'
      && typeof (parsed as { subject?: unknown }).subject === 'string'
    ) {
      return parsed as HostnameCertChainMetadata;
    }
  } catch {
    /* tampered row */
  }
  return undefined;
};

const rowToStorage = (row: HostnameRegistryDbRow): HostnameStorageRow => {
  const out: HostnameStorageRow = {
    hostname_id: row.hostname_id,
    server_identity_id: row.server_identity_id,
    hostname_normalized: row.hostname_normalized,
    cert_source: row.cert_source as HostnameCertSource,
    ownership_status: row.ownership_status as HostnameOwnershipStatus,
    listener_ports: parsePorts(row.listener_ports_json),
    ddns_managed: row.ddns_managed === 1,
    enabled: row.enabled === 1,
    tls_topology: row.tls_topology as HostnameTlsTopology,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.cert_blob_id !== null) out.cert_blob_id = row.cert_blob_id;
  if (row.cert_fingerprint !== null) out.cert_fingerprint = row.cert_fingerprint;
  if (row.cert_expires_at !== null) out.cert_expires_at = row.cert_expires_at;
  const certChainMetadata = parseCertChainMetadata(row.cert_chain_metadata_json);
  if (certChainMetadata !== undefined) out.cert_chain_metadata = certChainMetadata;
  if (row.verification_method !== null) {
    out.verification_method = row.verification_method as HostnameVerificationMethod;
  }
  if (row.verification_token_hash !== null) out.verification_token_hash = row.verification_token_hash;
  if (row.verified_at !== null) out.verified_at = row.verified_at;
  return out;
};

const rowToProjection = (row: HostnameRegistryDbRow): HostnameProjection =>
  projectHostname(rowToStorage(row));

export const createHostnameRegistryStore = (
  db: Database.Database,
  options: CreateHostnameRegistryStoreOptions = {},
): HostnameRegistryStore => {
  ensureHostnameRegistrySchema(db);
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? (() => randomUUID());

  const getByHostnameStmt = db.prepare<{ hostname_normalized: string }>(`
    SELECT * FROM hostname_registry WHERE hostname_normalized = @hostname_normalized
  `);
  const listStmt = db.prepare(`
    SELECT * FROM hostname_registry ORDER BY hostname_normalized ASC
  `);
  const upsertStmt = db.prepare(`
    INSERT INTO hostname_registry (
      hostname_id, server_identity_id, hostname_normalized, cert_source,
      cert_blob_id, cert_fingerprint, cert_expires_at, cert_chain_metadata_json,
      ownership_status, verification_method, verification_token_hash, verified_at,
      listener_ports_json, ddns_managed, enabled, tls_topology, created_at, updated_at
    ) VALUES (
      @hostname_id, @server_identity_id, @hostname_normalized, @cert_source,
      @cert_blob_id, @cert_fingerprint, @cert_expires_at, @cert_chain_metadata_json,
      @ownership_status, @verification_method, @verification_token_hash, @verified_at,
      @listener_ports_json, @ddns_managed, @enabled, @tls_topology, @created_at, @updated_at
    )
    ON CONFLICT(hostname_normalized) DO UPDATE SET
      server_identity_id = excluded.server_identity_id,
      cert_source = excluded.cert_source,
      cert_blob_id = excluded.cert_blob_id,
      cert_fingerprint = excluded.cert_fingerprint,
      cert_expires_at = excluded.cert_expires_at,
      cert_chain_metadata_json = excluded.cert_chain_metadata_json,
      ownership_status = excluded.ownership_status,
      verification_method = excluded.verification_method,
      verification_token_hash = excluded.verification_token_hash,
      verified_at = excluded.verified_at,
      listener_ports_json = excluded.listener_ports_json,
      ddns_managed = excluded.ddns_managed,
      enabled = excluded.enabled,
      tls_topology = excluded.tls_topology,
      updated_at = excluded.updated_at
  `);
  const setEnabledStmt = db.prepare<{
    hostname_normalized: string;
    enabled: number;
    updated_at: number;
  }>(`
    UPDATE hostname_registry
       SET enabled = @enabled, updated_at = @updated_at
     WHERE hostname_normalized = @hostname_normalized
  `);
  const setOwnershipStmt = db.prepare<{
    hostname_normalized: string;
    ownership_status: string;
    verification_method: string | null;
    verification_token_hash: string | null;
    verified_at: number | null;
    updated_at: number;
  }>(`
    UPDATE hostname_registry
       SET ownership_status = @ownership_status,
           verification_method = @verification_method,
           verification_token_hash = @verification_token_hash,
           verified_at = @verified_at,
           updated_at = @updated_at
     WHERE hostname_normalized = @hostname_normalized
  `);
  const deleteStmt = db.prepare<{ hostname_normalized: string }>(`
    DELETE FROM hostname_registry WHERE hostname_normalized = @hostname_normalized
  `);

  const get = (hostname: string): HostnameStorageRow | null => {
    const hostname_normalized = normalizeOrThrow(hostname);
    const row = getByHostnameStmt.get({ hostname_normalized }) as
      | HostnameRegistryDbRow
      | undefined;
    return row ? rowToStorage(row) : null;
  };

  const readProjection = (hostname_normalized: string): HostnameProjection | null => {
    const row = getByHostnameStmt.get({ hostname_normalized }) as
      | HostnameRegistryDbRow
      | undefined;
    return row ? rowToProjection(row) : null;
  };

  return {
    upsert(input) {
      const hostname_normalized = normalizeOrThrow(input.hostname);
      if (
        (input.cert_source === 'recued_acme' || input.ddns_managed === true)
        && !isSingleLabelProDdnsHostname(hostname_normalized)
      ) {
        throw new HostnameRegistryError(
          input.cert_source === 'recued_acme'
            ? 'invalid_recued_acme_hostname'
            : 'invalid_ddns_managed_hostname',
          `hostname registry: ${hostname_normalized} is not a single-label recued.cloud hostname`,
        );
      }

      const at = now();
      const existing = getByHostnameStmt.get({ hostname_normalized }) as
        | HostnameRegistryDbRow
        | undefined;
      const tls_topology = tlsTopologyForHostnameCertSource(input.cert_source);
      const ownership_status = input.ownership_status
        ?? (input.cert_source === 'recued_acme' ? 'verified' : 'pending');
      const verified_at = input.verified_at
        ?? (ownership_status === 'verified' ? at : null);
      upsertStmt.run({
        hostname_id: input.hostname_id ?? existing?.hostname_id ?? newId(),
        server_identity_id: input.server_identity_id,
        hostname_normalized,
        cert_source: input.cert_source,
        cert_blob_id: input.cert_blob_id ?? null,
        cert_fingerprint: input.cert_fingerprint ?? null,
        cert_expires_at: input.cert_expires_at ?? null,
        cert_chain_metadata_json: input.cert_chain_metadata
          ? JSON.stringify(input.cert_chain_metadata)
          : null,
        ownership_status,
        verification_method: input.verification_method ?? null,
        verification_token_hash: input.verification_token_hash ?? null,
        verified_at,
        listener_ports_json: JSON.stringify(normalizePorts(input.listener_ports)),
        ddns_managed: input.ddns_managed === true ? 1 : 0,
        enabled: input.enabled === true ? 1 : 0,
        tls_topology,
        created_at: existing?.created_at ?? at,
        updated_at: at,
      });
      const out = readProjection(hostname_normalized);
      if (!out) throw new Error('hostname registry: upsert did not persist row');
      return out;
    },
    get,
    list() {
      return (listStmt.all() as HostnameRegistryDbRow[]).map(rowToProjection);
    },
    setEnabled(hostname, enabled) {
      const hostname_normalized = normalizeOrThrow(hostname);
      const result = setEnabledStmt.run({
        hostname_normalized,
        enabled: enabled ? 1 : 0,
        updated_at: now(),
      });
      return result.changes > 0 ? readProjection(hostname_normalized) : null;
    },
    setOwnership(input) {
      const hostname_normalized = normalizeOrThrow(input.hostname);
      const at = now();
      const result = setOwnershipStmt.run({
        hostname_normalized,
        ownership_status: input.status,
        verification_method: input.verification_method ?? null,
        verification_token_hash: input.verification_token_hash ?? null,
        verified_at: input.status === 'verified' ? at : null,
        updated_at: at,
      });
      return result.changes > 0 ? readProjection(hostname_normalized) : null;
    },
    remove(hostname) {
      const hostname_normalized = normalizeOrThrow(hostname);
      return deleteStmt.run({ hostname_normalized }).changes > 0;
    },
    lookupBinding(hostname, topology) {
      const row = get(hostname);
      return row && canBindHostname(row, topology) ? row : null;
    },
  };
};

export { HOSTNAME_LISTENER_PORTS };
