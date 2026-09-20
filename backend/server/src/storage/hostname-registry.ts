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
  CUSTOM_DOMAIN_MAX_PER_SERVER,
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
  isHostnameCertProvisioningState,
  isCustomDomainDelegationState,
  type CustomDomainDelegationState,
  type HostnameCertProvisioningState,
} from '@recued/contracts';

export const HOSTNAME_REGISTRY_TABLES = ['hostname_registry', 'cert_blob'] as const;
export type HostnameRegistryTableName = (typeof HOSTNAME_REGISTRY_TABLES)[number];

/** Column list shared by the CREATE and the D-235 CHECK rebuild, so the two can
 *  never drift into copying a different set than they declare. */
const HOSTNAME_REGISTRY_COLUMNS = [
  'hostname_id',
  'server_identity_id',
  'hostname_normalized',
  'cert_source',
  'cert_blob_id',
  'cert_fingerprint',
  'cert_expires_at',
  'cert_chain_metadata_json',
  'cert_provisioning',
  'cert_last_error',
  // ⛔ D-235 P4 — THESE MUST BE HERE, NOT ONLY IN THE GUARDED ALTER. The
  //    ALTERs run BEFORE the CHECK rebuild (they have to — the rebuild SELECTs
  //    the full column set out of the old table). If the rebuild's column list
  //    omitted them it would silently DROP them on any database old enough to
  //    need the rebuild, and the next boot's ALTER would re-add them EMPTY —
  //    losing every delegation observation, once, invisibly.
  'delegation_state',
  'delegation_checked_at',
  'ownership_status',
  'verification_method',
  'verification_token_hash',
  'verified_at',
  'listener_ports_json',
  'ddns_managed',
  'enabled',
  'tls_topology',
  'created_at',
  'updated_at',
] as const;

const hostnameRegistryTableDdl = (
  tableName: string,
  ifNotExists = false,
): string => `
    CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${tableName} (
      hostname_id TEXT PRIMARY KEY,
      server_identity_id TEXT NOT NULL,
      hostname_normalized TEXT NOT NULL UNIQUE,
      cert_source TEXT NOT NULL CHECK (cert_source IN ('recued_acme', 'recued_acme_custom', 'byo_uploaded', 'byo_external')),
      cert_blob_id TEXT,
      cert_fingerprint TEXT,
      cert_expires_at INTEGER,
      cert_chain_metadata_json TEXT,
      cert_provisioning TEXT,
      cert_last_error TEXT,
      delegation_state TEXT,
      delegation_checked_at INTEGER,
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
    )`;

/** ⛔⛔ `cert_blob` IS DECLARED AND NEVER USED — DO NOT CITE IT AS "where the
 *  certificate is stored".
 *
 *  Verified 2026-09-18: no INSERT / SELECT / UPDATE / DELETE names that table
 *  anywhere in the tree, and its `private_key_pem_encrypted` and `sub_dek_id`
 *  columns each occur exactly ONCE in the whole repo — in the CREATE below.
 *  `hostname_registry.cert_blob_id` is fully plumbed (accepted by the rpc,
 *  carried through updates, persisted) but nothing ever PRODUCES a value for
 *  it, so it is null in practice.
 *
 *  🔑 The live cert store is `tls_domains` (`backend/server/src/tls/domain-store.ts`)
 *  — `cert_pem` plus `private_key_encrypted`, written through its upsert and read
 *  by `readExpiresAt`. `d148-constants.ts` cited THIS table as proof the
 *  certificate is stored, which is how a correct conclusion came to rest on an
 *  empty one.
 *
 *  ⚠ Left in place rather than dropped: removing a table is a migration, and an
 *  unused CREATE costs nothing except the confusion this note now absorbs. */
export const ensureHostnameRegistrySchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cert_blob (
      id TEXT PRIMARY KEY,
      cert_pem_encrypted BLOB NOT NULL,
      private_key_pem_encrypted BLOB NOT NULL,
      sub_dek_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.exec(hostnameRegistryTableDdl('hostname_registry', true));

  // Zero-migration: the columns are in the CREATE above for fresh dbs, but a
  // registry from an earlier boot needs a guarded ALTER so it gains them
  // without a destructive rebuild. PRAGMA-guarded ⇒ idempotent, safe every
  // boot. Nullable on purpose — an existing row predates provisioning
  // tracking, and NULL reads as "unknown", which the projection leaves absent
  // rather than asserting a state it never observed.
  //
  // ⚠ MUST run BEFORE the D-235 rebuild below, which SELECTs the full column
  //   set out of the old table — a legacy table missing these would fail the
  //   copy rather than the ALTER.
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(hostname_registry)`).all() as { name: string }[])
      .map((c) => c.name),
  );
  if (!cols.has('cert_provisioning')) {
    db.exec(`ALTER TABLE hostname_registry ADD COLUMN cert_provisioning TEXT`);
  }
  if (!cols.has('cert_last_error')) {
    db.exec(`ALTER TABLE hostname_registry ADD COLUMN cert_last_error TEXT`);
  }
  // D-235 § 5.1 — the delegation watch. Guarded ALTER, no CHECK constraint:
  // ALTER-added columns here have never carried one (see the two above), and
  // adding one would force the whole 12-step rebuild for a nullable field.
  // `isCustomDomainDelegationState` validates on read instead, which also means
  // a value written by a newer build reads as absent rather than crashing an
  // older one.
  if (!cols.has('delegation_state')) {
    db.exec(`ALTER TABLE hostname_registry ADD COLUMN delegation_state TEXT`);
  }
  if (!cols.has('delegation_checked_at')) {
    db.exec(`ALTER TABLE hostname_registry ADD COLUMN delegation_checked_at INTEGER`);
  }

  // D-235 — widen the `cert_source` CHECK to admit `recued_acme_custom`.
  // SQLite cannot ALTER a CHECK constraint, so this is the 12-step rebuild
  // (mirrors `reception-store.ts`). Guarded on the LIVE constraint text rather
  // than a version counter: `sqlite_master.sql` is the schema SQLite is
  // actually enforcing, so the guard cannot claim a migration that a restored
  // backup or a hand-edited file silently lacks.
  //
  // Safe to do bluntly: `hostname_registry` declares no foreign keys, so
  // nothing cascades on DROP and no other object's references need rewriting
  // on RENAME. The whole rebuild runs in ONE transaction — a crash mid-way
  // leaves the original table untouched rather than a half-copied registry,
  // which would drop the hostnames the public listener binds SNI for.
  const liveDdl = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hostname_registry'`,
    )
    .get() as { sql: string | null } | undefined;
  if (liveDdl?.sql && !liveDdl.sql.includes('recued_acme_custom')) {
    const columnList = HOSTNAME_REGISTRY_COLUMNS.join(', ');
    db.transaction(() => {
      db.exec(`DROP TABLE IF EXISTS hostname_registry_rebuild`);
      db.exec(hostnameRegistryTableDdl('hostname_registry_rebuild'));
      db.exec(`
        INSERT INTO hostname_registry_rebuild (${columnList})
          SELECT ${columnList} FROM hostname_registry;
        DROP TABLE hostname_registry;
        ALTER TABLE hostname_registry_rebuild RENAME TO hostname_registry;
      `);
    })();
  }

  // ⚠ AFTER the rebuild, not before: DROP TABLE takes the table's indexes with
  //   it, so creating them ahead of the rebuild would leave the server running
  //   a boot with no index on a table it lists on every Settings open.
  db.exec(`
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
  /** D-235 — `recued_acme_custom` was used for a hostname INSIDE the fleet's
   *  own zone. The custom source exists for names the fleet does not own; a
   *  fleet-zone host under it would take the delegated-ownership path (parks at
   *  `pending`, needs a challenge-response proof) for a name whose ownership is
   *  already implicit — busywork at best, and at worst a second, weaker way to
   *  reach issuance for `<handle>.recued.net`. Use `recued_acme`. */
  | 'invalid_custom_acme_hostname'
  /** D-235 § 7 — this server already holds `CUSTOM_DOMAIN_MAX_PER_SERVER`
   *  custom-domain rows. Each one is a recurring claim on the fleet's ACME
   *  budget, and CAs rate-limit FAILED validations too, so a server with a
   *  dozen half-configured domains can starve its own legitimate renewals. */
  | 'custom_hostname_cap_reached'
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
  cert_provisioning?: HostnameCertProvisioningState;
  cert_last_error?: string;
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
  /** D-235 § 5.1 — record a delegation observation.
   *
   *  ⚠ A DEDICATED WRITER, NOT `upsert`. `upsert` rewrites every column from
   *  its input, so a watch that used it would have to reconstruct the whole row
   *  correctly on every tick — and one missing optional field would silently
   *  clear a fingerprint or an ownership proof. A monitor must not be able to
   *  damage what it is monitoring. */
  setDelegationState(input: {
    hostname: string;
    state: CustomDomainDelegationState;
    checked_at?: number;
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
  cert_provisioning: string | null;
  cert_last_error: string | null;
  delegation_state: string | null;
  delegation_checked_at: number | null;
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
  // NULL = a row written before provisioning tracking existed. Left ABSENT
  // rather than defaulted to 'pending', which would assert a state never
  // observed — an already-provisioned legacy row would read as "not started".
  const certProvisioning = row.cert_provisioning;
  if (certProvisioning !== null && isHostnameCertProvisioningState(certProvisioning)) {
    out.cert_provisioning = certProvisioning;
  }
  if (row.cert_last_error !== null) out.cert_last_error = row.cert_last_error;
  // D-235 § 5.1 — validated on read rather than by a CHECK constraint, so a
  // value written by a newer build reads as ABSENT (never observed) on an older
  // one rather than as a state it cannot interpret.
  if (
    row.delegation_state !== null
    && isCustomDomainDelegationState(row.delegation_state)
  ) {
    out.delegation_state = row.delegation_state;
  }
  if (row.delegation_checked_at !== null) {
    out.delegation_checked_at = row.delegation_checked_at;
  }
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
      cert_provisioning, cert_last_error, delegation_state, delegation_checked_at,
      ownership_status, verification_method, verification_token_hash, verified_at,
      listener_ports_json, ddns_managed, enabled, tls_topology, created_at, updated_at
    ) VALUES (
      @hostname_id, @server_identity_id, @hostname_normalized, @cert_source,
      @cert_blob_id, @cert_fingerprint, @cert_expires_at, @cert_chain_metadata_json,
      @cert_provisioning, @cert_last_error, @delegation_state, @delegation_checked_at,
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
      cert_provisioning = excluded.cert_provisioning,
      cert_last_error = excluded.cert_last_error,
      delegation_state = excluded.delegation_state,
      delegation_checked_at = excluded.delegation_checked_at,
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
  const setDelegationStateStmt = db.prepare<{
    hostname_normalized: string;
    delegation_state: string;
    delegation_checked_at: number;
    updated_at: number;
  }>(`
    UPDATE hostname_registry
       SET delegation_state = @delegation_state,
           delegation_checked_at = @delegation_checked_at,
           updated_at = @updated_at
     WHERE hostname_normalized = @hostname_normalized
  `);
  const deleteStmt = db.prepare<{ hostname_normalized: string }>(`
    DELETE FROM hostname_registry WHERE hostname_normalized = @hostname_normalized
  `);
  // D-235 § 7 — enrolled custom-domain rows, for the per-server cap.
  const countCustomStmt = db.prepare(`
    SELECT COUNT(*) AS n FROM hostname_registry
     WHERE cert_source = 'recued_acme_custom'
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
      const isFleetZoneHostname = isSingleLabelProDdnsHostname(hostname_normalized);
      if (
        (input.cert_source === 'recued_acme' || input.ddns_managed === true)
        && !isFleetZoneHostname
      ) {
        throw new HostnameRegistryError(
          input.cert_source === 'recued_acme'
            ? 'invalid_recued_acme_hostname'
            : 'invalid_ddns_managed_hostname',
          `hostname registry: ${hostname_normalized} is not a single-label recued.cloud hostname`,
        );
      }
      // D-235 — the mirror gate. `recued_acme` REQUIRES a fleet-zone hostname;
      // `recued_acme_custom` REFUSES one. Written as a second explicit throw
      // rather than folded into the condition above so neither source can drift
      // into accepting the other's shape.
      if (input.cert_source === 'recued_acme_custom' && isFleetZoneHostname) {
        throw new HostnameRegistryError(
          'invalid_custom_acme_hostname',
          `hostname registry: ${hostname_normalized} is inside the fleet's own DDNS zone; use cert_source 'recued_acme'`,
        );
      }

      const at = now();
      const existing = getByHostnameStmt.get({ hostname_normalized }) as
        | HostnameRegistryDbRow
        | undefined;

      // D-235 § 7 — the per-server cap, counted at the moment a row would
      // BECOME custom. ⚠ Gated on the row not ALREADY being custom, not on the
      // row not existing: an update that re-saves an at-cap custom row must
      // pass, while a `byo_uploaded` row switching source must not slip past
      // the cap just because it happens to exist.
      if (
        input.cert_source === 'recued_acme_custom'
        && existing?.cert_source !== 'recued_acme_custom'
      ) {
        const { n } = countCustomStmt.get() as { n: number };
        if (n >= CUSTOM_DOMAIN_MAX_PER_SERVER) {
          throw new HostnameRegistryError(
            'custom_hostname_cap_reached',
            `hostname registry: this server already has ${n} custom-domain hostnames `
              + `(limit ${CUSTOM_DOMAIN_MAX_PER_SERVER}); remove one before adding ${hostname_normalized}`,
          );
        }
      }
      const tls_topology = tlsTopologyForHostnameCertSource(input.cert_source);
      // ⛔ `recued_acme` ONLY — do NOT generalize this to
      //    `isFleetIssuedCertSource`. The implicit-verification shortcut is
      //    justified solely by the fleet owning the zone, which is true for
      //    `<handle>.recued.net` and false for every `recued_acme_custom` row.
      //    D-235 § 6 P1 requires the custom row to park at `pending`, and it
      //    does so here by falling into the else branch — the safe default is
      //    the one you get for free.
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
        // D-235 § 5.1 — CARRIED FORWARD, never taken from `input`: the watch
        // owns this pair through `setDelegationState`, and an ordinary upsert
        // (an enrolment write, an enable/disable) must not be able to erase a
        // monitor's observation as a side effect.
        //
        // ⚠ …except when the row stops BEING a custom domain. A past
        //   delegation reading is meaningless for a `byo_uploaded` row and
        //   would render as a delegation warning on a hostname that has no
        //   delegation, so a source change clears it.
        delegation_state: input.cert_source === 'recued_acme_custom'
          ? existing?.delegation_state ?? null
          : null,
        delegation_checked_at: input.cert_source === 'recued_acme_custom'
          ? existing?.delegation_checked_at ?? null
          : null,
        cert_provisioning: input.cert_provisioning ?? existing?.cert_provisioning ?? null,
        cert_last_error: input.cert_last_error
          ?? (input.cert_provisioning === 'ready' ? null : existing?.cert_last_error ?? null),
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
    setDelegationState(input) {
      const hostname_normalized = normalizeOrThrow(input.hostname);
      const at = input.checked_at ?? now();
      const result = setDelegationStateStmt.run({
        hostname_normalized,
        delegation_state: input.state,
        delegation_checked_at: at,
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
