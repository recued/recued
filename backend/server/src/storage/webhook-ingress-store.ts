/** D-201 Slices 1 + 7D + 8D + 9BO — durable webhook ingress + encrypted credential versions.
 *
 * The ingress row is safe control-plane metadata. Credential plaintext crosses
 * this module only at the write/read-internal methods and is always persisted as
 * AES-256-GCM ciphertext under the dedicated `webhook_secrets` sub-DEK. There is
 * deliberately no plaintext fallback: a missing or locked key provider closes
 * credential writes and reads while list/get metadata remains available.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  decrypt,
  decodeCiphertext,
  encodeCiphertext,
  encrypt,
} from '@recued/crypto';
import {
  MAX_WEBHOOK_CREDENTIAL_TOTAL_BYTES,
  MAX_WEBHOOK_CREDENTIAL_VALUE_BYTES,
  MAX_WEBHOOK_REGISTRATION_TARGET_KEY_LENGTH,
  MAX_WEBHOOK_REGISTRATION_TARGET_KIND_LENGTH,
  MAX_ACTIVE_WEBHOOK_CREDENTIAL_VERSIONS,
  webhookProfile,
  webhookProfileRequiresPairedConnection,
  type WebhookCredentialVersionView,
  type WebhookEnvironment,
  type WebhookIngressRecord,
  type WebhookProfileId,
  type WebhookRegistrationTarget,
  type WebhookRegistrationMode,
} from '@recued/contracts';

export type WebhookIngressStoreErrorCode =
  | 'not_found'
  | 'retired'
  | 'locked'
  | 'conflict'
  | 'invalid_state'
  | 'immutable'
  | 'corrupt';

/** Durable latch written in the same transaction that removes a required API
 * connection. A same-name connection row does not clear this evidence. */
export const WEBHOOK_PAIRED_CONNECTION_DELETED = 'paired_connection_deleted';

export class WebhookIngressStoreError extends Error {
  constructor(
    readonly code: WebhookIngressStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WebhookIngressStoreError';
  }
}

export interface WebhookCredentialVersionMetadata extends WebhookCredentialVersionView {
  active: boolean;
  configured_fields: readonly string[];
}

export interface DecryptedWebhookCredentialVersion {
  version: string;
  created_at: number;
  credentials: Readonly<Record<string, string>>;
}

export interface WebhookIngressCreateInput {
  display_name: string;
  profile_id: WebhookProfileId;
  environment: WebhookEnvironment;
  paired_connection_id: string | null;
  registration_target?: WebhookRegistrationTarget | null;
  registration_mode: WebhookRegistrationMode;
  selected_event_types: readonly string[];
}

export interface WebhookIngressUpdateInput {
  display_name?: string;
  profile_id?: WebhookProfileId;
  environment?: WebhookEnvironment;
  paired_connection_id?: string | null;
  registration_target?: WebhookRegistrationTarget | null;
  registration_mode?: WebhookRegistrationMode;
  selected_event_types?: readonly string[];
}

export interface WebhookIngressStoreOptions {
  now?: () => number;
  getEncryptionKey?: () => Uint8Array | null;
  newIngressId?: () => string;
  newPublicId?: () => string;
  newCredentialSetRef?: () => string;
}

export type WebhookManagedRegistrationFailureCode =
  | 'managed_registration_ambiguous'
  | 'managed_registration_unconfirmed'
  | 'managed_registration_drift'
  | 'managed_remote_missing';

export type WebhookManagedRegistrationCleanupIntent = 'disable' | 'retire' | 'rebind';

/** Server-only compare-and-set snapshot for one remote mutation attempt. The
 * attempt counter never enters an RPC view; it exists solely to derive a fresh
 * provider idempotency key after an orphan endpoint is conclusively deleted. */
export interface WebhookManagedRegistrationExpectation {
  ingress_id: string;
  public_id: string;
  profile_id: WebhookProfileId;
  environment: WebhookEnvironment;
  paired_connection_id: string;
  registration_target: WebhookRegistrationTarget | null;
  pending_paired_connection_id: string | null;
  registration_attempt_connection_id: string | null;
  remote_endpoint_id: string | null;
  confirmed_endpoint_url: string | null;
  registration_state: WebhookIngressRecord['registration_state'];
  intake_state: WebhookIngressRecord['intake_state'];
  selected_event_types: readonly string[];
  attempt: number;
}

export interface WebhookManagedRegistrationAttempt {
  ingress: WebhookIngressRecord;
  expected: WebhookManagedRegistrationExpectation;
}

export interface WebhookManagedConnectionRebindPreparation
  extends WebhookManagedRegistrationAttempt {
  cleanup_required: boolean;
}

export interface WebhookIngressStore {
  create(input: WebhookIngressCreateInput): WebhookIngressRecord;
  get(ingressId: string): WebhookIngressRecord | null;
  getByPublicId(publicId: string): WebhookIngressRecord | null;
  list(input?: { include_retired?: boolean }): WebhookIngressRecord[];
  update(ingressId: string, patch: WebhookIngressUpdateInput): WebhookIngressRecord;
  writeCredentialVersion(
    ingressId: string,
    credentials: Readonly<Record<string, string>>,
  ): Promise<WebhookCredentialVersionMetadata>;
  retireCredentialVersion(ingressId: string, version: number): WebhookIngressRecord;
  listCredentialVersions(ingressId: string): WebhookCredentialVersionMetadata[];
  readActiveCredentialVersions(ingressId: string): Promise<DecryptedWebhookCredentialVersion[]>;
  confirmManualRegistration(
    ingressId: string,
    input: { requires_handshake: boolean; endpoint_url: string },
  ): WebhookIngressRecord;
  confirmHandshakeReadiness(ingressId: string): WebhookIngressRecord;
  confirmOperationBoundReadiness(ingressId: string): WebhookIngressRecord;
  snapshotManagedRegistration(ingressId: string): WebhookManagedRegistrationAttempt;
  prepareManagedRegistration(ingressId: string): WebhookManagedRegistrationAttempt;
  rotateManagedRegistrationAttempt(
    expected: WebhookManagedRegistrationExpectation,
  ): WebhookManagedRegistrationAttempt;
  commitManagedRegistrationCreate(input: {
    expected: WebhookManagedRegistrationExpectation;
    remote_endpoint_id: string;
    endpoint_url: string;
    credentials: Readonly<Record<string, string>>;
    requires_handshake: boolean;
  }): Promise<WebhookIngressRecord>;
  confirmManagedRegistrationReadBack(input: {
    expected: WebhookManagedRegistrationExpectation;
    remote_endpoint_id: string;
    endpoint_url: string;
    requires_handshake: boolean;
  }): WebhookIngressRecord;
  markManagedRegistrationDrift(
    expected: WebhookManagedRegistrationExpectation,
    code: WebhookManagedRegistrationFailureCode,
  ): WebhookIngressRecord;
  commitManagedConnectionAliasRebind(input: {
    expected: WebhookManagedRegistrationExpectation;
    paired_connection_id: string;
  }): WebhookIngressRecord;
  prepareManagedConnectionRebind(input: {
    expected: WebhookManagedRegistrationExpectation;
    paired_connection_id: string;
  }): WebhookManagedConnectionRebindPreparation;
  prepareManagedRegistrationCleanup(
    ingressId: string,
    intent: WebhookManagedRegistrationCleanupIntent,
  ): WebhookManagedRegistrationAttempt;
  completeManagedRegistrationCleanup(input: {
    expected: WebhookManagedRegistrationExpectation;
    intent: WebhookManagedRegistrationCleanupIntent;
  }): WebhookIngressRecord;
  markManagedRegistrationCleanupPending(
    expected: WebhookManagedRegistrationExpectation,
    code: 'managed_cleanup_ambiguous' | 'managed_cleanup_unconfirmed',
  ): WebhookIngressRecord;
  enable(ingressId: string): WebhookIngressRecord;
  disable(ingressId: string): WebhookIngressRecord;
  recordAcceptedDelivery(ingressId: string, receivedAt: number): WebhookIngressRecord;
  /** Record only trusted runtime faults. Invalid unauthenticated requests must
   * never let an attacker degrade ingress health through this method. */
  recordRuntimeFailure(
    ingressId: string,
    code: 'unsupported_delivery' | 'profile_dependency_unavailable' | 'profile_internal_error',
  ): WebhookIngressRecord;
  /** Atomically close every non-retired ingress whose registration mechanism
   * requires the deleted API connection. Never-enabled operation-bound rows
   * retain their non-exposed intake state so retirement remains unambiguous;
   * the durable deletion latch closes listener and enable admission. Called
   * only from the connection store's transaction-critical pre-delete hook. */
  failCloseForDeletedPairedConnection(pairedConnectionId: string): number;
  /** Explicit operation-bound recovery after trusted core has proved both the
   * replacement API connection and remote-account continuity. Managed
   * endpoints recover through the provider read-back reconciler instead. */
  recoverDeletedOperationBoundConnection(
    ingressId: string,
    pairedConnectionId: string,
  ): WebhookIngressRecord;
  retire(ingressId: string): WebhookIngressRecord;
}

interface IngressSqlRow {
  ingress_id: string;
  public_id: string;
  display_name: string;
  profile_id: string;
  environment: string;
  paired_connection_id: string | null;
  registration_target_json: string | null;
  pending_paired_connection_id: string | null;
  credential_set_ref: string | null;
  registration_mode: string;
  remote_endpoint_id: string | null;
  confirmed_endpoint_url: string | null;
  selected_event_types_json: string;
  registration_state: string;
  intake_state: string;
  test_observed_at: number | null;
  enabled_at: number | null;
  last_delivery_at: number | null;
  last_error_code: string | null;
  created_at: number;
  updated_at: number;
  registration_attempt: number;
  registration_attempt_connection_id: string | null;
}

interface CredentialSqlRow {
  credential_set_ref: string;
  ingress_id: string;
  version: number;
  ciphertext: string;
  configured_fields_json: string;
  state: 'active' | 'retired';
  created_at: number;
  retired_at: number | null;
  last_verified_at: number | null;
}

const createSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_ingresses (
      ingress_id TEXT PRIMARY KEY,
      public_id TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      environment TEXT NOT NULL CHECK (environment IN ('test', 'live', 'custom')),
      paired_connection_id TEXT,
      registration_target_json TEXT,
      pending_paired_connection_id TEXT,
      credential_set_ref TEXT UNIQUE,
      registration_mode TEXT NOT NULL CHECK (
        registration_mode IN ('manual', 'managed_endpoint', 'operation_bound')
      ),
      remote_endpoint_id TEXT,
      confirmed_endpoint_url TEXT,
      selected_event_types_json TEXT NOT NULL,
      registration_state TEXT NOT NULL CHECK (
        registration_state IN (
          'not_applicable', 'manual_pending', 'managed_pending', 'registered',
          'drifted', 'cleanup_pending', 'retired'
        )
      ),
      intake_state TEXT NOT NULL CHECK (
        intake_state IN (
          'draft', 'verification_pending', 'ready', 'enabled', 'degraded',
          'disabled', 'retired'
        )
      ),
      test_observed_at INTEGER,
      enabled_at INTEGER,
      last_delivery_at INTEGER,
      last_error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      registration_attempt INTEGER NOT NULL DEFAULT 0 CHECK (registration_attempt >= 0),
      registration_attempt_connection_id TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_ingresses_public_id
      ON webhook_ingresses(public_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_ingresses_updated
      ON webhook_ingresses(updated_at DESC, ingress_id ASC);

    CREATE TABLE IF NOT EXISTS webhook_credential_versions (
      credential_set_ref TEXT NOT NULL,
      ingress_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      ciphertext TEXT NOT NULL,
      configured_fields_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'retired')),
      created_at INTEGER NOT NULL,
      retired_at INTEGER,
      last_verified_at INTEGER,
      CHECK (
        (state = 'active' AND retired_at IS NULL)
        OR (state = 'retired' AND retired_at IS NOT NULL)
      ),
      PRIMARY KEY (credential_set_ref, version),
      UNIQUE (ingress_id, version),
      FOREIGN KEY (ingress_id) REFERENCES webhook_ingresses(ingress_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_credentials_active
      ON webhook_credential_versions(ingress_id, state, version DESC);
  `);
  const ingressColumns = db.prepare(
    'PRAGMA table_info(webhook_ingresses)',
  ).all() as Array<{ name: string }>;
  if (!ingressColumns.some((column) => column.name === 'confirmed_endpoint_url')) {
    db.exec(
      'ALTER TABLE webhook_ingresses ADD COLUMN confirmed_endpoint_url TEXT',
    );
  }
  if (!ingressColumns.some((column) => column.name === 'registration_target_json')) {
    db.exec(
      'ALTER TABLE webhook_ingresses ADD COLUMN registration_target_json TEXT',
    );
  }
  if (!ingressColumns.some((column) => column.name === 'registration_attempt')) {
    db.exec(
      'ALTER TABLE webhook_ingresses ADD COLUMN registration_attempt INTEGER NOT NULL DEFAULT 0 CHECK (registration_attempt >= 0)',
    );
  }
  if (!ingressColumns.some((column) => column.name === 'pending_paired_connection_id')) {
    db.exec(
      'ALTER TABLE webhook_ingresses ADD COLUMN pending_paired_connection_id TEXT',
    );
  }
  if (!ingressColumns.some((column) =>
    column.name === 'registration_attempt_connection_id')) {
    // DDL participates in the same SQLite transaction as the conservative
    // legacy-row backfill. A crash can therefore expose neither a half-added
    // marker column nor an unowned attempt that may already have mutated the
    // provider. Legacy managed_pending rows are intentionally treated as
    // possibly orphaned; that shape is also reachable when create succeeds but
    // the process dies before the remote id and one-time secret are committed.
    db.transaction(() => {
      db.exec(
        'ALTER TABLE webhook_ingresses ADD COLUMN registration_attempt_connection_id TEXT',
      );
      db.exec(`
        UPDATE webhook_ingresses
        SET registration_attempt_connection_id = paired_connection_id
        WHERE registration_mode = 'managed_endpoint'
          AND registration_attempt > 0
          AND paired_connection_id IS NOT NULL
          AND registration_state <> 'retired'
      `);
    })();
  }
  const credentialColumns = db.prepare(
    'PRAGMA table_info(webhook_credential_versions)',
  ).all() as Array<{ name: string }>;
  if (!credentialColumns.some((column) => column.name === 'last_verified_at')) {
    db.exec(
      'ALTER TABLE webhook_credential_versions ADD COLUMN last_verified_at INTEGER',
    );
  }
};

const initialRegistrationState = (
  mode: WebhookRegistrationMode,
): WebhookIngressRecord['registration_state'] => {
  if (mode === 'manual') return 'manual_pending';
  if (mode === 'managed_endpoint') return 'managed_pending';
  return 'not_applicable';
};

const equalStringSets = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false;
  const sortedLeft = left.slice().sort();
  const sortedRight = right.slice().sort();
  return sortedLeft.every((entry, index) => entry === sortedRight[index]);
};

const equalRegistrationTargets = (
  left: WebhookRegistrationTarget | null,
  right: WebhookRegistrationTarget | null,
): boolean => left === null
  ? right === null
  : right !== null && left.kind === right.kind && left.key === right.key;

const registrationTargetFromUnknown = (
  value: unknown,
  where: string,
  code: 'invalid_state' | 'corrupt',
): WebhookRegistrationTarget | null => {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new WebhookIngressStoreError(code, `${where}: invalid registration target metadata`);
  }
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length !== 2
    || !Object.prototype.hasOwnProperty.call(source, 'kind')
    || !Object.prototype.hasOwnProperty.call(source, 'key')
    || keys.some((key) => key !== 'kind' && key !== 'key')
    || typeof source.kind !== 'string'
    || source.kind.length === 0
    || source.kind.length > MAX_WEBHOOK_REGISTRATION_TARGET_KIND_LENGTH
    || typeof source.key !== 'string'
    || source.key.length === 0
    || source.key.length > MAX_WEBHOOK_REGISTRATION_TARGET_KEY_LENGTH) {
    throw new WebhookIngressStoreError(code, `${where}: invalid registration target metadata`);
  }
  return Object.freeze({ kind: source.kind, key: source.key });
};

const parseRegistrationTarget = (
  raw: string | null,
  where: string,
): WebhookRegistrationTarget | null => {
  if (raw === null) return null;
  try {
    return registrationTargetFromUnknown(JSON.parse(raw), where, 'corrupt');
  } catch (error) {
    if (error instanceof WebhookIngressStoreError) throw error;
    throw new WebhookIngressStoreError('corrupt', `${where}: corrupt registration target metadata`);
  }
};

const parseStringArray = (raw: string, where: string): string[] => {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      throw new Error('not a string array');
    }
    return value.slice();
  } catch {
    throw new WebhookIngressStoreError('corrupt', `${where}: corrupt string-array metadata`);
  }
};

const rowFromSql = (row: IngressSqlRow): WebhookIngressRecord => ({
  ingress_id: row.ingress_id,
  public_id: row.public_id,
  display_name: row.display_name,
  profile_id: row.profile_id as WebhookProfileId,
  environment: row.environment as WebhookEnvironment,
  paired_connection_id: row.paired_connection_id,
  registration_target: parseRegistrationTarget(
    row.registration_target_json,
    `webhook ingress ${row.ingress_id}`,
  ),
  pending_paired_connection_id: row.pending_paired_connection_id,
  credential_set_ref: row.credential_set_ref,
  registration_mode: row.registration_mode as WebhookRegistrationMode,
  remote_endpoint_id: row.remote_endpoint_id,
  confirmed_endpoint_url: row.confirmed_endpoint_url,
  selected_event_types: parseStringArray(
    row.selected_event_types_json,
    `webhook ingress ${row.ingress_id}`,
  ),
  registration_state: row.registration_state as WebhookIngressRecord['registration_state'],
  intake_state: row.intake_state as WebhookIngressRecord['intake_state'],
  test_observed_at: row.test_observed_at,
  enabled_at: row.enabled_at,
  last_delivery_at: row.last_delivery_at,
  last_error_code: row.last_error_code,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const credentialMetadataFromSql = (
  row: CredentialSqlRow,
): WebhookCredentialVersionMetadata => ({
  version: String(row.version),
  created_at: row.created_at,
  retired_at: row.retired_at,
  last_verified_at: row.last_verified_at,
  active: row.state === 'active',
  configured_fields: parseStringArray(
    row.configured_fields_json,
    `webhook credential ${row.ingress_id}/${row.version}`,
  ),
});

const defaultIngressId = (): string =>
  `whi_${randomUUID().replace(/-/g, '')}`;
const defaultPublicId = (): string => randomBytes(24).toString('base64url');
const defaultCredentialSetRef = (): string =>
  `whc_${randomUUID().replace(/-/g, '')}`;

const aadFor = (
  ingress: Pick<WebhookIngressRecord, 'ingress_id' | 'profile_id' | 'environment'>,
  version: number,
  configuredFields: readonly string[],
): Uint8Array => new TextEncoder().encode(
  `recued/v1/webhook-credential/${ingress.ingress_id}/${ingress.profile_id}/${ingress.environment}/${version}/${JSON.stringify(configuredFields)}`,
);

const isSqliteUniqueFailure = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('UNIQUE constraint failed');

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
};

const safeCredentialObject = (value: unknown, where: string): Record<string, string> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebhookIngressStoreError('corrupt', `${where}: decrypted credential is not an object`);
  }
  const source = value as Record<string, unknown>;
  const result = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(source)) {
    if (typeof source[key] !== 'string') {
      throw new WebhookIngressStoreError('corrupt', `${where}: decrypted credential field has invalid type`);
    }
    result[key] = source[key];
  }
  return result;
};

export const createWebhookIngressStore = (
  db: Database.Database,
  options: WebhookIngressStoreOptions = {},
): WebhookIngressStore => {
  createSchema(db);
  const now = options.now ?? (() => Date.now());
  const newIngressId = options.newIngressId ?? defaultIngressId;
  const newPublicId = options.newPublicId ?? defaultPublicId;
  const newCredentialSetRef = options.newCredentialSetRef ?? defaultCredentialSetRef;

  const selectById = db.prepare(
    'SELECT * FROM webhook_ingresses WHERE ingress_id = ?',
  );
  const selectByPublicId = db.prepare(
    'SELECT * FROM webhook_ingresses WHERE public_id = ?',
  );
  const selectCredentialVersions = db.prepare(`
    SELECT * FROM webhook_credential_versions
    WHERE ingress_id = ?
    ORDER BY version DESC
  `);

  const get = (ingressId: string): WebhookIngressRecord | null => {
    const row = selectById.get(ingressId) as IngressSqlRow | undefined;
    return row ? rowFromSql(row) : null;
  };

  const requireIngress = (ingressId: string): WebhookIngressRecord => {
    const row = get(ingressId);
    if (!row) {
      throw new WebhookIngressStoreError('not_found', `webhook ingress '${ingressId}' not found`);
    }
    return row;
  };

  const requireIngressSql = (ingressId: string): IngressSqlRow => {
    const row = selectById.get(ingressId) as IngressSqlRow | undefined;
    if (!row) {
      throw new WebhookIngressStoreError('not_found', `webhook ingress '${ingressId}' not found`);
    }
    return row;
  };

  const registrationExpectation = (
    row: WebhookIngressRecord,
    attempt: number,
  ): WebhookManagedRegistrationExpectation => {
    if (row.paired_connection_id === null) {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'managed webhook registration requires a paired connection',
      );
    }
    const sql = requireIngressSql(row.ingress_id);
    return {
      ingress_id: row.ingress_id,
      public_id: row.public_id,
      profile_id: row.profile_id,
      environment: row.environment,
      paired_connection_id: row.paired_connection_id,
      registration_target: row.registration_target === null
        ? null
        : Object.freeze({ ...row.registration_target }),
      pending_paired_connection_id: row.pending_paired_connection_id ?? null,
      registration_attempt_connection_id: sql.registration_attempt_connection_id,
      remote_endpoint_id: row.remote_endpoint_id,
      confirmed_endpoint_url: row.confirmed_endpoint_url,
      registration_state: row.registration_state,
      intake_state: row.intake_state,
      selected_event_types: row.selected_event_types.slice(),
      attempt,
    };
  };

  const assertManagedExpectation = (
    expected: WebhookManagedRegistrationExpectation,
    allowCleanupState = false,
  ): WebhookIngressRecord => {
    const sql = requireIngressSql(expected.ingress_id);
    const current = rowFromSql(sql);
    const eventTypesMatch = equalStringSets(
      current.selected_event_types,
      expected.selected_event_types,
    );
    if (current.public_id !== expected.public_id
      || current.profile_id !== expected.profile_id
      || current.environment !== expected.environment
      || current.paired_connection_id !== expected.paired_connection_id
      || !equalRegistrationTargets(
        current.registration_target,
        expected.registration_target,
      )
      || (current.pending_paired_connection_id ?? null)
        !== expected.pending_paired_connection_id
      || current.registration_mode !== 'managed_endpoint'
      || current.remote_endpoint_id !== expected.remote_endpoint_id
      || current.confirmed_endpoint_url !== expected.confirmed_endpoint_url
      || current.registration_state !== expected.registration_state
      || current.intake_state !== expected.intake_state
      || sql.registration_attempt !== expected.attempt
      || sql.registration_attempt_connection_id
        !== expected.registration_attempt_connection_id
      || !eventTypesMatch) {
      throw new WebhookIngressStoreError(
        'conflict',
        'webhook registration inputs changed during remote reconciliation',
      );
    }
    if (!allowCleanupState && current.intake_state === 'retired') {
      throw new WebhookIngressStoreError('retired', 'webhook ingress is retired');
    }
    if (!allowCleanupState && current.registration_state === 'cleanup_pending') {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'managed webhook cleanup must finish before registration can change',
      );
    }
    return current;
  };

  const requireEncryptionKey = (): Uint8Array => {
    const key = options.getEncryptionKey?.() ?? null;
    if (!key) {
      throw new WebhookIngressStoreError(
        'locked',
        'webhook credentials require an unlocked server vault',
      );
    }
    return key;
  };

  const create = (input: WebhookIngressCreateInput): WebhookIngressRecord => {
    const stamp = now();
    const registrationTarget = registrationTargetFromUnknown(
      input.registration_target ?? null,
      'webhook ingress create',
      'invalid_state',
    );
    const row: WebhookIngressRecord = {
      ingress_id: newIngressId(),
      public_id: newPublicId(),
      display_name: input.display_name,
      profile_id: input.profile_id,
      environment: input.environment,
      paired_connection_id: input.paired_connection_id,
      registration_target: registrationTarget,
      pending_paired_connection_id: null,
      credential_set_ref: null,
      registration_mode: input.registration_mode,
      remote_endpoint_id: null,
      confirmed_endpoint_url: null,
      selected_event_types: input.selected_event_types.slice(),
      registration_state: initialRegistrationState(input.registration_mode),
      intake_state: 'draft',
      test_observed_at: null,
      enabled_at: null,
      last_delivery_at: null,
      last_error_code: null,
      created_at: stamp,
      updated_at: stamp,
    };
    try {
      db.prepare(`
        INSERT INTO webhook_ingresses (
          ingress_id, public_id, display_name, profile_id, environment,
          paired_connection_id, registration_target_json,
          pending_paired_connection_id,
          credential_set_ref, registration_mode,
          remote_endpoint_id, confirmed_endpoint_url, selected_event_types_json,
          registration_state, intake_state, test_observed_at, enabled_at,
          last_delivery_at, last_error_code, created_at, updated_at
        ) VALUES (
          @ingress_id, @public_id, @display_name, @profile_id, @environment,
          @paired_connection_id, @registration_target_json,
          @pending_paired_connection_id,
          @credential_set_ref, @registration_mode,
          @remote_endpoint_id, @confirmed_endpoint_url,
          @selected_event_types_json, @registration_state, @intake_state,
          @test_observed_at, @enabled_at, @last_delivery_at, @last_error_code,
          @created_at, @updated_at
        )
      `).run({
        ...row,
        registration_target_json: row.registration_target === null
          ? null
          : JSON.stringify(row.registration_target),
        selected_event_types_json: JSON.stringify(row.selected_event_types),
      });
    } catch (error) {
      if (isSqliteUniqueFailure(error)) {
        throw new WebhookIngressStoreError(
          'conflict',
          'webhook ingress identity collision; retry creation',
        );
      }
      throw error;
    }
    return row;
  };

  const update = (
    ingressId: string,
    patch: WebhookIngressUpdateInput,
  ): WebhookIngressRecord => {
    const current = requireIngress(ingressId);
    if (current.intake_state === 'retired') {
      throw new WebhookIngressStoreError('retired', 'retired webhook ingress is immutable');
    }
    const changesIdentity =
      (patch.profile_id !== undefined && patch.profile_id !== current.profile_id)
      || (patch.environment !== undefined && patch.environment !== current.environment)
      || (patch.registration_mode !== undefined
        && patch.registration_mode !== current.registration_mode);
    const registrationAttempt = requireIngressSql(ingressId).registration_attempt;
    const registrationTarget = patch.registration_target !== undefined
      ? registrationTargetFromUnknown(
        patch.registration_target,
        `webhook ingress ${ingressId}`,
        'invalid_state',
      )
      : current.registration_target;
    const changesRegistrationTarget = !equalRegistrationTargets(
      current.registration_target,
      registrationTarget,
    );
    if (changesIdentity
      && (current.intake_state !== 'draft' || registrationAttempt > 0)) {
      throw new WebhookIngressStoreError(
        'immutable',
        'profile, environment, and registration mode are immutable after registration starts',
      );
    }
    if (patch.paired_connection_id !== undefined
      && patch.paired_connection_id !== current.paired_connection_id
      && current.registration_mode === 'managed_endpoint'
      && registrationAttempt > 0) {
      throw new WebhookIngressStoreError(
        'immutable',
        'paired connection is immutable after managed registration starts',
      );
    }
    if (changesRegistrationTarget
      && current.registration_mode === 'managed_endpoint'
      && registrationAttempt > 0) {
      throw new WebhookIngressStoreError(
        'immutable',
        'registration target is immutable after managed registration starts',
      );
    }

    const registrationMode = patch.registration_mode ?? current.registration_mode;
    const selectedEventTypes = patch.selected_event_types ?? current.selected_event_types;
    if (current.registration_state === 'cleanup_pending'
      && patch.selected_event_types !== undefined
      && !equalStringSets(current.selected_event_types, patch.selected_event_types)) {
      throw new WebhookIngressStoreError(
        'immutable',
        'event selection is immutable while managed registration cleanup is pending',
      );
    }
    const changesManagedRegistrationConfig = current.registration_mode === 'managed_endpoint'
      && registrationAttempt > 0
      && patch.selected_event_types !== undefined
      && !equalStringSets(current.selected_event_types, patch.selected_event_types);
    if (changesManagedRegistrationConfig
      && registrationAttempt >= Number.MAX_SAFE_INTEGER) {
      throw new WebhookIngressStoreError(
        'corrupt',
        'webhook registration attempt counter is exhausted',
      );
    }
    const stamp = now();
    db.prepare(`
      UPDATE webhook_ingresses SET
        display_name = ?,
        profile_id = ?,
        environment = ?,
        paired_connection_id = ?,
        registration_target_json = ?,
        registration_mode = ?,
        selected_event_types_json = ?,
        registration_state = ?,
        confirmed_endpoint_url = ?,
        last_error_code = ?,
        registration_attempt = ?,
        updated_at = ?
      WHERE ingress_id = ?
    `).run(
      patch.display_name ?? current.display_name,
      patch.profile_id ?? current.profile_id,
      patch.environment ?? current.environment,
      patch.paired_connection_id !== undefined
        ? patch.paired_connection_id
        : current.paired_connection_id,
      registrationTarget === null ? null : JSON.stringify(registrationTarget),
      registrationMode,
      JSON.stringify(selectedEventTypes),
      changesIdentity
        ? initialRegistrationState(registrationMode)
        : changesManagedRegistrationConfig
          ? 'drifted'
          : current.registration_state,
      changesIdentity ? null : current.confirmed_endpoint_url,
      changesIdentity
        ? null
        : changesManagedRegistrationConfig
          ? 'managed_registration_drift'
          : current.last_error_code,
      changesManagedRegistrationConfig
        ? registrationAttempt + 1
        : registrationAttempt,
      stamp,
      ingressId,
    );
    return requireIngress(ingressId);
  };

  const writeCredentialVersion = async (
    ingressId: string,
    credentials: Readonly<Record<string, string>>,
  ): Promise<WebhookCredentialVersionMetadata> => {
    const ingress = requireIngress(ingressId);
    if (ingress.intake_state === 'retired') {
      throw new WebhookIngressStoreError('retired', 'cannot write credentials to retired ingress');
    }
    const key = requireEncryptionKey();
    const activeCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM webhook_credential_versions
      WHERE ingress_id = ? AND state = 'active'
    `).get(ingressId) as { count: number };
    if (activeCount.count >= MAX_ACTIVE_WEBHOOK_CREDENTIAL_VERSIONS) {
      throw new WebhookIngressStoreError(
        'invalid_state',
        `webhook credential overlap is limited to ${MAX_ACTIVE_WEBHOOK_CREDENTIAL_VERSIONS} active versions`,
      );
    }
    const versionRow = db.prepare(`
      SELECT COALESCE(MAX(version), 0) + 1 AS next_version
      FROM webhook_credential_versions WHERE ingress_id = ?
    `).get(ingressId) as { next_version: number };
    const version = versionRow.next_version;
    const credentialSetRef = ingress.credential_set_ref ?? newCredentialSetRef();
    const configuredFields = Object.keys(credentials).sort();
    const serialized = JSON.stringify(credentials);
    const plaintext = new TextEncoder().encode(serialized);
    let ciphertext: string;
    try {
      ciphertext = encodeCiphertext(
        await encrypt(key, plaintext, aadFor(ingress, version, configuredFields)),
      );
    } finally {
      plaintext.fill(0);
    }
    const stamp = now();

    const persist = db.transaction(() => {
      // Encryption is asynchronous. Re-read every security-relevant field inside
      // the synchronous transaction so an interleaved draft identity edit,
      // credential write, vault lock, or ingress retirement cannot commit
      // ciphertext against stale AAD/key state or resurrect an active credential
      // on a retired ingress.
      const currentKey = requireEncryptionKey();
      if (!equalBytes(currentKey, key)) {
        throw new WebhookIngressStoreError(
          'conflict',
          'webhook encryption key changed while encrypting credentials; retry the write',
        );
      }
      const current = requireIngress(ingressId);
      if (current.intake_state === 'retired') {
        throw new WebhookIngressStoreError(
          'retired',
          'cannot write credentials to retired ingress',
        );
      }
      if (current.profile_id !== ingress.profile_id
        || current.environment !== ingress.environment) {
        throw new WebhookIngressStoreError(
          'conflict',
          'webhook ingress identity changed while encrypting credentials; retry the write',
        );
      }
      if (current.credential_set_ref !== null
        && current.credential_set_ref !== credentialSetRef) {
        throw new WebhookIngressStoreError(
          'conflict',
          'webhook credential set changed while encrypting; retry the write',
        );
      }
      const activeNow = db.prepare(`
        SELECT COUNT(*) AS count
        FROM webhook_credential_versions
        WHERE ingress_id = ? AND state = 'active'
      `).get(ingressId) as { count: number };
      if (activeNow.count >= MAX_ACTIVE_WEBHOOK_CREDENTIAL_VERSIONS) {
        throw new WebhookIngressStoreError(
          'invalid_state',
          `webhook credential overlap is limited to ${MAX_ACTIVE_WEBHOOK_CREDENTIAL_VERSIONS} active versions`,
        );
      }
      const versionNow = db.prepare(`
        SELECT COALESCE(MAX(version), 0) + 1 AS next_version
        FROM webhook_credential_versions WHERE ingress_id = ?
      `).get(ingressId) as { next_version: number };
      if (versionNow.next_version !== version) {
        throw new WebhookIngressStoreError(
          'conflict',
          'webhook credential version changed while encrypting; retry the write',
        );
      }
      db.prepare(`
        INSERT INTO webhook_credential_versions (
          credential_set_ref, ingress_id, version, ciphertext,
          configured_fields_json, state, created_at, retired_at,
          last_verified_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, NULL)
      `).run(
        credentialSetRef,
        ingressId,
        version,
        ciphertext,
        JSON.stringify(configuredFields),
        stamp,
      );
      db.prepare(`
        UPDATE webhook_ingresses SET
          credential_set_ref = ?,
          intake_state = CASE WHEN intake_state = 'draft'
            THEN 'verification_pending' ELSE intake_state END,
          updated_at = ?
        WHERE ingress_id = ?
      `).run(credentialSetRef, stamp, ingressId);
    });
    try {
      persist();
    } catch (error) {
      if (error instanceof WebhookIngressStoreError) throw error;
      if (isSqliteUniqueFailure(error)) {
        throw new WebhookIngressStoreError(
          'conflict',
          'concurrent webhook credential rotation; retry the write',
        );
      }
      throw error;
    }
    return {
      version: String(version),
      created_at: stamp,
      retired_at: null,
      last_verified_at: null,
      active: true,
      configured_fields: configuredFields,
    };
  };

  const listCredentialVersions = (
    ingressId: string,
  ): WebhookCredentialVersionMetadata[] => {
    requireIngress(ingressId);
    return (selectCredentialVersions.all(ingressId) as CredentialSqlRow[])
      .map(credentialMetadataFromSql);
  };

  const readActiveCredentialVersions = async (
    ingressId: string,
  ): Promise<DecryptedWebhookCredentialVersion[]> => {
    const ingress = requireIngress(ingressId);
    if (ingress.intake_state === 'retired') return [];
    const key = requireEncryptionKey();
    const rows = (selectCredentialVersions.all(ingressId) as CredentialSqlRow[])
      .filter((row) => row.state === 'active');
    const result: DecryptedWebhookCredentialVersion[] = [];
    for (const row of rows) {
      let plaintext: Uint8Array | null = null;
      try {
        const configuredFields = parseStringArray(
          row.configured_fields_json,
          `webhook credential ${row.ingress_id}/${row.version}`,
        );
        plaintext = await decrypt(
          key,
          decodeCiphertext(row.ciphertext),
          aadFor(ingress, row.version, configuredFields),
        );
        const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
        const credentials = safeCredentialObject(
          parsed,
          `webhook credential ${ingressId}/${row.version}`,
        );
        if (JSON.stringify(Object.keys(credentials).sort()) !== JSON.stringify(configuredFields)) {
          throw new WebhookIngressStoreError(
            'corrupt',
            `webhook credential ${ingressId}/${row.version}: configured-field metadata mismatch`,
          );
        }
        result.push({
          version: String(row.version),
          created_at: row.created_at,
          credentials,
        });
      } catch (error) {
        if (error instanceof WebhookIngressStoreError) throw error;
        throw new WebhookIngressStoreError(
          'corrupt',
          `webhook credential ${ingressId}/${row.version}: decryption failed`,
        );
      } finally {
        plaintext?.fill(0);
      }
    }

    // Do not let an async decrypt cross a vault lock or credential/ingress
    // retirement boundary. The final provider and SQLite reads are synchronous,
    // so no lifecycle mutation can interleave between this check and return.
    const currentKey = requireEncryptionKey();
    if (!equalBytes(currentKey, key)) {
      throw new WebhookIngressStoreError(
        'conflict',
        'webhook encryption key changed while decrypting credentials; retry the read',
      );
    }
    const currentIngress = requireIngress(ingressId);
    if (currentIngress.intake_state === 'retired') return [];
    const stillActive = new Set(
      (selectCredentialVersions.all(ingressId) as CredentialSqlRow[])
        .filter((row) => row.state === 'active')
        .map((row) => String(row.version)),
    );
    return result.filter((entry) => stillActive.has(entry.version));
  };

  const retireCredentialVersion = (
    ingressId: string,
    version: number,
  ): WebhookIngressRecord => {
    const ingress = requireIngress(ingressId);
    if (ingress.intake_state === 'retired') {
      throw new WebhookIngressStoreError('retired', 'webhook ingress is retired');
    }
    const row = db.prepare(`
      SELECT * FROM webhook_credential_versions
      WHERE ingress_id = ? AND version = ?
    `).get(ingressId, version) as CredentialSqlRow | undefined;
    if (!row) {
      throw new WebhookIngressStoreError(
        'not_found',
        `webhook credential version '${version}' not found`,
      );
    }
    if (row.state === 'active') {
      const active = db.prepare(`
        SELECT COUNT(*) AS count
        FROM webhook_credential_versions
        WHERE ingress_id = ? AND state = 'active'
      `).get(ingressId) as { count: number };
      if (ingress.registration_mode === 'managed_endpoint'
        && ingress.remote_endpoint_id !== null
        && active.count <= 1) {
        throw new WebhookIngressStoreError(
          'invalid_state',
          'managed endpoint credentials must be replaced through provider registration',
        );
      }
      if (ingress.intake_state === 'ready'
        || ingress.intake_state === 'enabled'
        || ingress.intake_state === 'degraded') {
        if (active.count <= 1) {
          throw new WebhookIngressStoreError(
            'invalid_state',
            'disable the ingress or activate a replacement before retiring its last credential',
          );
        }
        if (ingress.intake_state === 'enabled'
          || ingress.intake_state === 'degraded') {
          const verifiedRemaining = db.prepare(`
            SELECT 1 FROM webhook_credential_versions
            WHERE ingress_id = ?
              AND version <> ?
              AND state = 'active'
              AND last_verified_at IS NOT NULL
            LIMIT 1
          `).get(ingressId, version);
          if (!verifiedRemaining) {
            throw new WebhookIngressStoreError(
              'invalid_state',
              'verify a remaining credential with an accepted delivery before retiring this version',
            );
          }
        }
      }
      const stamp = now();
      const persist = db.transaction(() => {
        db.prepare(`
          UPDATE webhook_credential_versions
          SET state = 'retired', retired_at = ?
          WHERE ingress_id = ? AND version = ? AND state = 'active'
        `).run(stamp, ingressId, version);
        db.prepare(
          'UPDATE webhook_ingresses SET updated_at = ? WHERE ingress_id = ?',
        ).run(stamp, ingressId);
      });
      persist();
    }
    return requireIngress(ingressId);
  };

  const activeCredentialCount = (ingressId: string): number => {
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM webhook_credential_versions
      WHERE ingress_id = ? AND state = 'active'
    `).get(ingressId) as { count: number };
    return row.count;
  };

  const validConfirmedEndpointUrl = (
    value: string,
    publicId: string,
  ): boolean => {
    if (Buffer.byteLength(value, 'utf8') > 4_096
      || value.includes('?')
      || value.includes('#')) {
      return false;
    }
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:'
        && parsed.username.length === 0
        && parsed.password.length === 0
        && parsed.pathname.endsWith(`/v1/webhooks/${publicId}`)
        && parsed.href === value;
    } catch {
      return false;
    }
  };

  const validRemoteEndpointId = (value: string): boolean =>
    /^[A-Za-z0-9_:-]{1,256}$/.test(value);

  const validPairedConnectionId = (value: string): boolean =>
    value.trim().length > 0 && value.length <= 256;

  const snapshotManagedRegistration: WebhookIngressStore['snapshotManagedRegistration'] = (
    ingressId,
  ) => {
    const current = requireIngress(ingressId);
    if (current.intake_state === 'retired') {
      throw new WebhookIngressStoreError('retired', 'webhook ingress is retired');
    }
    if (current.registration_mode !== 'managed_endpoint') {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'managed registration requires managed_endpoint mode',
      );
    }
    const sql = requireIngressSql(ingressId);
    if (!Number.isSafeInteger(sql.registration_attempt) || sql.registration_attempt < 0) {
      throw new WebhookIngressStoreError(
        'corrupt',
        `webhook ingress ${ingressId}: invalid registration attempt`,
      );
    }
    return {
      ingress: current,
      expected: registrationExpectation(current, sql.registration_attempt),
    };
  };

  const prepareManagedRegistration: WebhookIngressStore['prepareManagedRegistration'] = (
    ingressId,
  ) => {
    const current = requireIngress(ingressId);
    if (current.intake_state === 'retired') {
      throw new WebhookIngressStoreError('retired', 'webhook ingress is retired');
    }
    if (current.registration_mode !== 'managed_endpoint') {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'managed registration requires managed_endpoint mode',
      );
    }
    if (current.registration_state === 'cleanup_pending') {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'managed registration cleanup must finish before reconciliation',
      );
    }
    if ((current.pending_paired_connection_id ?? null) !== null) {
      throw new WebhookIngressStoreError(
        'corrupt',
        'managed registration has a target connection outside cleanup',
      );
    }
    registrationExpectation(current, 0);
    const sql = requireIngressSql(ingressId);
    if (current.remote_endpoint_id === null
      && sql.registration_attempt >= Number.MAX_SAFE_INTEGER) {
      throw new WebhookIngressStoreError(
        'corrupt',
        'webhook registration attempt counter is exhausted',
      );
    }
    let attempt = sql.registration_attempt;
    if (sql.registration_attempt_connection_id !== null
      && sql.registration_attempt_connection_id !== current.paired_connection_id) {
      throw new WebhookIngressStoreError(
        'corrupt',
        'managed registration attempt belongs to another paired connection',
      );
    }
    if (attempt === 0 || sql.registration_attempt_connection_id === null) {
      attempt = attempt === 0 ? 1 : attempt;
      const stamp = now();
      const changed = db.prepare(`
        UPDATE webhook_ingresses
        SET registration_attempt = ?, registration_attempt_connection_id = ?,
            updated_at = ?
        WHERE ingress_id = ? AND registration_attempt = ?
          AND registration_attempt_connection_id IS ?
      `).run(
        attempt,
        current.paired_connection_id,
        stamp,
        ingressId,
        sql.registration_attempt,
        sql.registration_attempt_connection_id,
      );
      if (changed.changes !== 1) {
        throw new WebhookIngressStoreError(
          'conflict',
          'webhook registration attempt changed concurrently',
        );
      }
    }
    if (!Number.isSafeInteger(attempt) || attempt < 1) {
      throw new WebhookIngressStoreError(
        'corrupt',
        `webhook ingress ${ingressId}: invalid registration attempt`,
      );
    }
    const ingress = requireIngress(ingressId);
    return { ingress, expected: registrationExpectation(ingress, attempt) };
  };

  const rotateManagedRegistrationAttempt: WebhookIngressStore['rotateManagedRegistrationAttempt'] = (
    expected,
  ) => {
    const current = assertManagedExpectation(expected);
    if (current.remote_endpoint_id !== null) {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'cannot rotate registration attempt while a remote endpoint is committed',
      );
    }
    if (expected.attempt >= Number.MAX_SAFE_INTEGER) {
      throw new WebhookIngressStoreError(
        'corrupt',
        'webhook registration attempt counter is exhausted',
      );
    }
    const nextAttempt = expected.attempt + 1;
    const stamp = now();
    const changed = db.prepare(`
      UPDATE webhook_ingresses
      SET registration_attempt = ?,
          registration_attempt_connection_id = ?,
          registration_state = 'managed_pending',
          last_error_code = CASE
            WHEN last_error_code IN (
              'managed_registration_ambiguous',
              'managed_registration_unconfirmed',
              'managed_registration_drift',
              'managed_remote_missing'
            ) THEN NULL ELSE last_error_code
          END,
          updated_at = ?
      WHERE ingress_id = ? AND registration_attempt = ?
    `).run(
      nextAttempt,
      current.paired_connection_id,
      stamp,
      expected.ingress_id,
      expected.attempt,
    );
    if (changed.changes !== 1) {
      throw new WebhookIngressStoreError(
        'conflict',
        'webhook registration attempt changed concurrently',
      );
    }
    const ingress = requireIngress(expected.ingress_id);
    return {
      ingress,
      expected: registrationExpectation(ingress, nextAttempt),
    };
  };

  const ensureManagedEndpointValues = (
    current: WebhookIngressRecord,
    remoteEndpointId: string,
    endpointUrl: string,
  ): void => {
    if (!validRemoteEndpointId(remoteEndpointId)) {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'managed registration returned an invalid remote endpoint id',
      );
    }
    if (!validConfirmedEndpointUrl(endpointUrl, current.public_id)) {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'managed registration requires the canonical HTTPS endpoint URL',
      );
    }
  };

  const commitManagedRegistrationCreate: WebhookIngressStore['commitManagedRegistrationCreate'] = async (
    input,
  ) => {
    const ingress = assertManagedExpectation(input.expected);
    ensureManagedEndpointValues(ingress, input.remote_endpoint_id, input.endpoint_url);
    const activeBefore = activeCredentialCount(ingress.ingress_id);
    if (activeBefore > 0) {
      if (ingress.remote_endpoint_id === input.remote_endpoint_id
        && ingress.confirmed_endpoint_url === input.endpoint_url
        && ingress.registration_state === 'registered') {
        return ingress;
      }
      throw new WebhookIngressStoreError(
        'invalid_state',
        'managed registration cannot replace an active credential implicitly',
      );
    }

    const configuredFields = Object.keys(input.credentials).sort();
    if (configuredFields.length === 0) {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'managed registration returned no credential fields',
      );
    }
    let totalBytes = 0;
    for (const field of configuredFields) {
      const value = input.credentials[field];
      if (typeof value !== 'string' || value.length === 0) {
        throw new WebhookIngressStoreError(
          'invalid_state',
          `managed registration credential '${field}' is empty`,
        );
      }
      const bytes = Buffer.byteLength(value, 'utf8');
      if (bytes > MAX_WEBHOOK_CREDENTIAL_VALUE_BYTES) {
        throw new WebhookIngressStoreError(
          'invalid_state',
          `managed registration credential '${field}' is too large`,
        );
      }
      totalBytes += bytes;
    }
    if (totalBytes > MAX_WEBHOOK_CREDENTIAL_TOTAL_BYTES) {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'managed registration credential result is too large',
      );
    }

    const key = requireEncryptionKey();
    const versionRow = db.prepare(`
      SELECT COALESCE(MAX(version), 0) + 1 AS next_version
      FROM webhook_credential_versions WHERE ingress_id = ?
    `).get(ingress.ingress_id) as { next_version: number };
    const version = versionRow.next_version;
    const credentialSetRef = ingress.credential_set_ref ?? newCredentialSetRef();
    const plaintext = new TextEncoder().encode(JSON.stringify(input.credentials));
    let ciphertext: string;
    try {
      ciphertext = encodeCiphertext(
        await encrypt(key, plaintext, aadFor(ingress, version, configuredFields)),
      );
    } finally {
      plaintext.fill(0);
    }
    const stamp = now();
    const targetIntake = input.requires_handshake ? 'verification_pending' : 'ready';
    const persist = db.transaction(() => {
      const currentKey = requireEncryptionKey();
      if (!equalBytes(currentKey, key)) {
        throw new WebhookIngressStoreError(
          'conflict',
          'webhook encryption key changed while committing managed registration',
        );
      }
      const current = assertManagedExpectation(input.expected);
      ensureManagedEndpointValues(current, input.remote_endpoint_id, input.endpoint_url);
      if (current.remote_endpoint_id !== null
        && current.remote_endpoint_id !== input.remote_endpoint_id) {
        throw new WebhookIngressStoreError(
          'conflict',
          'webhook remote endpoint changed concurrently',
        );
      }
      if (activeCredentialCount(current.ingress_id) !== 0) {
        throw new WebhookIngressStoreError(
          'conflict',
          'webhook credentials changed while committing managed registration',
        );
      }
      const versionNow = db.prepare(`
        SELECT COALESCE(MAX(version), 0) + 1 AS next_version
        FROM webhook_credential_versions WHERE ingress_id = ?
      `).get(current.ingress_id) as { next_version: number };
      if (versionNow.next_version !== version) {
        throw new WebhookIngressStoreError(
          'conflict',
          'webhook credential version changed while committing managed registration',
        );
      }
      if (current.credential_set_ref !== null
        && current.credential_set_ref !== credentialSetRef) {
        throw new WebhookIngressStoreError(
          'conflict',
          'webhook credential set changed while committing managed registration',
        );
      }
      db.prepare(`
        INSERT INTO webhook_credential_versions (
          credential_set_ref, ingress_id, version, ciphertext,
          configured_fields_json, state, created_at, retired_at,
          last_verified_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, NULL)
      `).run(
        credentialSetRef,
        current.ingress_id,
        version,
        ciphertext,
        JSON.stringify(configuredFields),
        stamp,
      );
      db.prepare(`
        UPDATE webhook_ingresses SET
          credential_set_ref = ?, remote_endpoint_id = ?,
          confirmed_endpoint_url = ?, registration_state = 'registered',
          intake_state = CASE
            WHEN intake_state IN ('draft', 'verification_pending') THEN ?
            ELSE intake_state
          END,
          last_error_code = CASE
            WHEN last_error_code IN (
              'managed_registration_ambiguous',
              'managed_registration_unconfirmed',
              'managed_registration_drift',
              'managed_remote_missing',
              'paired_connection_deleted'
            ) THEN NULL ELSE last_error_code
          END,
          updated_at = ?
        WHERE ingress_id = ?
      `).run(
        credentialSetRef,
        input.remote_endpoint_id,
        input.endpoint_url,
        targetIntake,
        stamp,
        current.ingress_id,
      );
    });
    try {
      persist();
    } catch (error) {
      if (error instanceof WebhookIngressStoreError) throw error;
      if (isSqliteUniqueFailure(error)) {
        throw new WebhookIngressStoreError(
          'conflict',
          'concurrent managed webhook registration commit',
        );
      }
      throw error;
    }
    return requireIngress(ingress.ingress_id);
  };

  const confirmManagedRegistrationReadBack: WebhookIngressStore['confirmManagedRegistrationReadBack'] = (
    input,
  ) => {
    const current = assertManagedExpectation(input.expected);
    ensureManagedEndpointValues(current, input.remote_endpoint_id, input.endpoint_url);
    if (current.remote_endpoint_id !== input.remote_endpoint_id) {
      throw new WebhookIngressStoreError(
        'conflict',
        'managed registration read-back does not match the committed endpoint',
      );
    }
    if (activeCredentialCount(current.ingress_id) === 0) {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'managed registration has no active verification credential',
      );
    }
    const stamp = now();
    const targetIntake = input.requires_handshake ? 'verification_pending' : 'ready';
    db.prepare(`
      UPDATE webhook_ingresses SET
        confirmed_endpoint_url = ?, registration_state = 'registered',
        intake_state = CASE
          WHEN intake_state IN ('draft', 'verification_pending') THEN ?
          ELSE intake_state
        END,
        last_error_code = CASE
          WHEN last_error_code IN (
            'managed_registration_ambiguous',
            'managed_registration_unconfirmed',
            'managed_registration_drift',
            'managed_remote_missing',
            'paired_connection_deleted'
          ) THEN NULL ELSE last_error_code
        END,
        updated_at = ?
      WHERE ingress_id = ?
    `).run(input.endpoint_url, targetIntake, stamp, current.ingress_id);
    return requireIngress(current.ingress_id);
  };

  const markManagedRegistrationDrift: WebhookIngressStore['markManagedRegistrationDrift'] = (
    expected,
    code,
  ) => {
    const current = assertManagedExpectation(expected);
    const stamp = now();
    db.prepare(`
      UPDATE webhook_ingresses SET
        registration_state = 'drifted', last_error_code = ?, updated_at = ?
      WHERE ingress_id = ?
    `).run(code, stamp, current.ingress_id);
    return requireIngress(current.ingress_id);
  };

  const commitManagedConnectionAliasRebind: WebhookIngressStore['commitManagedConnectionAliasRebind'] = (
    input,
  ) => {
    const current = assertManagedExpectation(input.expected);
    if (!validPairedConnectionId(input.paired_connection_id)
      || input.paired_connection_id === current.paired_connection_id
      || (current.pending_paired_connection_id ?? null) !== null
      || current.remote_endpoint_id === null
      || current.confirmed_endpoint_url === null
      || input.expected.registration_attempt_connection_id
        !== current.paired_connection_id
      || activeCredentialCount(current.ingress_id) === 0) {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'managed connection alias rebind is not admissible',
      );
    }
    const stamp = now();
    const changed = db.prepare(`
      UPDATE webhook_ingresses SET
        paired_connection_id = ?, registration_attempt_connection_id = ?,
        registration_state = 'registered',
        last_error_code = CASE
          WHEN last_error_code = 'paired_connection_deleted'
          THEN NULL ELSE last_error_code
        END,
        updated_at = ?
      WHERE ingress_id = ? AND paired_connection_id = ?
        AND pending_paired_connection_id IS NULL
    `).run(
      input.paired_connection_id,
      input.paired_connection_id,
      stamp,
      current.ingress_id,
      current.paired_connection_id,
    );
    if (changed.changes !== 1) {
      throw new WebhookIngressStoreError(
        'conflict',
        'managed paired connection changed concurrently',
      );
    }
    return requireIngress(current.ingress_id);
  };

  const prepareManagedConnectionRebind: WebhookIngressStore['prepareManagedConnectionRebind'] = (
    input,
  ) => {
    const current = assertManagedExpectation(input.expected);
    if (!validPairedConnectionId(input.paired_connection_id)
      || input.paired_connection_id === current.paired_connection_id
      || (current.pending_paired_connection_id ?? null) !== null) {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'managed paired connection replacement is invalid',
      );
    }
    const sql = requireIngressSql(current.ingress_id);
    const hasActiveCredentials = activeCredentialCount(current.ingress_id) > 0;
    const cleanupRequired = current.remote_endpoint_id !== null
      || sql.registration_attempt_connection_id !== null
      || hasActiveCredentials;
    const stamp = now();
    if (!cleanupRequired) {
      if (current.intake_state !== 'draft' && current.intake_state !== 'disabled') {
        throw new WebhookIngressStoreError(
          'invalid_state',
          'managed connection replacement requires closed intake',
        );
      }
      db.prepare(`
        UPDATE webhook_ingresses SET
          paired_connection_id = ?, registration_state = 'managed_pending',
          last_error_code = CASE
            WHEN last_error_code IN (
              'managed_registration_ambiguous',
              'managed_registration_unconfirmed',
              'managed_registration_drift',
              'managed_remote_missing',
              'managed_cleanup_ambiguous',
              'managed_cleanup_unconfirmed'
            ) THEN NULL ELSE last_error_code
          END,
          updated_at = ?
        WHERE ingress_id = ?
      `).run(input.paired_connection_id, stamp, current.ingress_id);
      const ingress = requireIngress(current.ingress_id);
      return {
        ingress,
        expected: registrationExpectation(ingress, sql.registration_attempt),
        cleanup_required: false,
      };
    }
    if (!Number.isSafeInteger(sql.registration_attempt)
      || sql.registration_attempt < 1
      || sql.registration_attempt >= Number.MAX_SAFE_INTEGER
      || sql.registration_attempt_connection_id !== current.paired_connection_id) {
      throw new WebhookIngressStoreError(
        'corrupt',
        'managed connection cutover has no safe old-connection attempt',
      );
    }
    db.prepare(`
      UPDATE webhook_ingresses SET
        pending_paired_connection_id = ?,
        registration_state = 'cleanup_pending',
        intake_state = 'disabled', enabled_at = NULL,
        last_error_code = CASE
          WHEN last_error_code IN (
            'managed_registration_ambiguous',
            'managed_registration_unconfirmed',
            'managed_registration_drift',
            'managed_remote_missing',
            'managed_cleanup_ambiguous',
            'managed_cleanup_unconfirmed'
          ) THEN NULL ELSE last_error_code
        END,
        updated_at = ?
      WHERE ingress_id = ?
    `).run(input.paired_connection_id, stamp, current.ingress_id);
    const ingress = requireIngress(current.ingress_id);
    return {
      ingress,
      expected: registrationExpectation(ingress, sql.registration_attempt),
      cleanup_required: true,
    };
  };

  const prepareManagedRegistrationCleanup: WebhookIngressStore['prepareManagedRegistrationCleanup'] = (
    ingressId,
    intent,
  ) => {
    const current = requireIngress(ingressId);
    if (current.registration_mode !== 'managed_endpoint'
      || current.registration_state !== 'cleanup_pending'
      || (intent === 'disable'
        && (current.intake_state !== 'disabled'
          || (current.pending_paired_connection_id ?? null) !== null))
      || (intent === 'rebind'
        && (current.intake_state !== 'disabled'
          || (current.pending_paired_connection_id ?? null) === null))
      || (intent === 'retire' && current.intake_state !== 'retired')) {
      throw new WebhookIngressStoreError(
        'invalid_state',
        `managed webhook ${intent} cleanup is not pending`,
      );
    }
    const sql = requireIngressSql(ingressId);
    if (!Number.isSafeInteger(sql.registration_attempt) || sql.registration_attempt < 1) {
      throw new WebhookIngressStoreError(
        'corrupt',
        'managed webhook cleanup has no durable registration attempt',
      );
    }
    if (sql.registration_attempt_connection_id !== current.paired_connection_id) {
      throw new WebhookIngressStoreError(
        'corrupt',
        'managed webhook cleanup attempt belongs to another connection',
      );
    }
    return {
      ingress: current,
      expected: registrationExpectation(current, sql.registration_attempt),
    };
  };

  const completeManagedRegistrationCleanup: WebhookIngressStore['completeManagedRegistrationCleanup'] = (
    input,
  ) => {
    const current = assertManagedExpectation(input.expected, true);
    if (current.registration_state !== 'cleanup_pending'
      || (input.intent === 'disable'
        && (current.intake_state !== 'disabled'
          || (current.pending_paired_connection_id ?? null) !== null))
      || (input.intent === 'rebind'
        && (current.intake_state !== 'disabled'
          || (current.pending_paired_connection_id ?? null) === null))
      || (input.intent === 'retire' && current.intake_state !== 'retired')) {
      throw new WebhookIngressStoreError(
        'conflict',
        'managed webhook cleanup intent changed concurrently',
      );
    }
    const stamp = now();
    const persist = db.transaction(() => {
      assertManagedExpectation(input.expected, true);
      db.prepare(`
        UPDATE webhook_credential_versions
        SET state = 'retired', retired_at = COALESCE(retired_at, ?)
        WHERE ingress_id = ? AND state = 'active'
      `).run(stamp, current.ingress_id);
      db.prepare(`
        UPDATE webhook_ingresses SET
          paired_connection_id = ?,
          pending_paired_connection_id = NULL,
          remote_endpoint_id = NULL,
          confirmed_endpoint_url = NULL,
          registration_state = ?,
          registration_attempt = ?,
          registration_attempt_connection_id = NULL,
          last_error_code = CASE
            WHEN last_error_code IN (
              'managed_registration_ambiguous',
              'managed_registration_unconfirmed',
              'managed_registration_drift',
              'managed_remote_missing',
              'managed_cleanup_ambiguous',
              'managed_cleanup_unconfirmed'
            ) THEN NULL ELSE last_error_code
          END,
          updated_at = ?
        WHERE ingress_id = ?
      `).run(
        input.intent === 'rebind'
          ? current.pending_paired_connection_id
          : current.paired_connection_id,
        input.intent === 'retire' ? 'retired' : 'managed_pending',
        input.intent !== 'retire' && input.expected.attempt < Number.MAX_SAFE_INTEGER
          ? input.expected.attempt + 1
          : input.expected.attempt,
        stamp,
        current.ingress_id,
      );
    });
    persist();
    return requireIngress(current.ingress_id);
  };

  const markManagedRegistrationCleanupPending: WebhookIngressStore['markManagedRegistrationCleanupPending'] = (
    expected,
    code,
  ) => {
    const current = assertManagedExpectation(expected, true);
    if (current.registration_state !== 'cleanup_pending') {
      throw new WebhookIngressStoreError(
        'conflict',
        'managed webhook cleanup is no longer pending',
      );
    }
    const stamp = now();
    db.prepare(`
      UPDATE webhook_ingresses
      SET last_error_code = ?, updated_at = ?
      WHERE ingress_id = ?
    `).run(code, stamp, current.ingress_id);
    return requireIngress(current.ingress_id);
  };

  const confirmManualRegistration: WebhookIngressStore['confirmManualRegistration'] = (
    ingressId,
    input,
  ) => {
    const current = requireIngress(ingressId);
    if (current.intake_state === 'retired') {
      throw new WebhookIngressStoreError('retired', 'webhook ingress is retired');
    }
    if (current.registration_mode !== 'manual') {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'manual registration confirmation requires manual registration mode',
      );
    }
    if (!validConfirmedEndpointUrl(input.endpoint_url, current.public_id)) {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'manual registration requires a canonical HTTPS endpoint URL',
      );
    }
    if (activeCredentialCount(ingressId) === 0) {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'write a complete credential version before confirming registration',
      );
    }
    if (current.registration_state === 'registered'
      && (current.intake_state === 'ready'
        || current.intake_state === 'verification_pending'
        || current.intake_state === 'enabled'
        || current.intake_state === 'degraded'
        || current.intake_state === 'disabled')) {
      if (current.confirmed_endpoint_url === input.endpoint_url) return current;
      const stamp = now();
      db.prepare(`
        UPDATE webhook_ingresses SET
          confirmed_endpoint_url = ?,
          intake_state = CASE
            WHEN ? = 1 THEN 'verification_pending'
            ELSE intake_state
          END,
          enabled_at = CASE
            WHEN ? = 1 THEN NULL
            ELSE enabled_at
          END,
          updated_at = ?
        WHERE ingress_id = ?
      `).run(
        input.endpoint_url,
        input.requires_handshake ? 1 : 0,
        input.requires_handshake ? 1 : 0,
        stamp,
        ingressId,
      );
      return requireIngress(ingressId);
    }
    if (current.registration_state !== 'manual_pending') {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'webhook ingress is not awaiting manual registration',
      );
    }
    const stamp = now();
    db.prepare(`
      UPDATE webhook_ingresses SET
        registration_state = 'registered',
        confirmed_endpoint_url = ?,
        intake_state = ?,
        last_error_code = NULL,
        updated_at = ?
      WHERE ingress_id = ?
    `).run(
      input.endpoint_url,
      input.requires_handshake ? 'verification_pending' : 'ready',
      stamp,
      ingressId,
    );
    return requireIngress(ingressId);
  };

  const confirmHandshakeReadiness: WebhookIngressStore['confirmHandshakeReadiness'] = (
    ingressId,
  ) => {
    const current = requireIngress(ingressId);
    if (current.intake_state === 'retired') {
      throw new WebhookIngressStoreError('retired', 'webhook ingress is retired');
    }
    if (current.registration_state !== 'registered'
      && current.registration_state !== 'not_applicable') {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'webhook handshake requires completed registration',
      );
    }
    if (current.confirmed_endpoint_url === null) {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'webhook handshake requires a confirmed endpoint',
      );
    }
    if (activeCredentialCount(ingressId) === 0) {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'webhook handshake requires active verification credentials',
      );
    }
    if (current.intake_state === 'ready'
      || current.intake_state === 'enabled'
      || current.intake_state === 'degraded') {
      return current;
    }
    if (current.intake_state !== 'verification_pending') {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'webhook ingress is not awaiting handshake verification',
      );
    }
    const stamp = now();
    db.prepare(`
      UPDATE webhook_ingresses
      SET intake_state = 'ready',
        last_error_code = CASE
          WHEN last_error_code = 'paired_connection_deleted'
          THEN last_error_code ELSE NULL
        END,
        updated_at = ?
      WHERE ingress_id = ? AND intake_state = 'verification_pending'
    `).run(stamp, ingressId);
    return requireIngress(ingressId);
  };

  const confirmOperationBoundReadiness: WebhookIngressStore['confirmOperationBoundReadiness'] = (
    ingressId,
  ) => {
    const current = requireIngress(ingressId);
    if (current.intake_state === 'retired') {
      throw new WebhookIngressStoreError('retired', 'webhook ingress is retired');
    }
    if (current.registration_mode !== 'operation_bound'
      || current.registration_state !== 'not_applicable'
      || current.paired_connection_id === null) {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'operation-bound readiness requires a paired operation-bound ingress',
      );
    }
    if (activeCredentialCount(ingressId) === 0) {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'operation-bound readiness requires active verification credentials',
      );
    }
    if (current.intake_state !== 'draft'
      && current.intake_state !== 'verification_pending') return current;
    const stamp = now();
    db.prepare(`
      UPDATE webhook_ingresses
      SET intake_state = 'ready',
        last_error_code = CASE
          WHEN last_error_code = 'paired_connection_deleted'
          THEN last_error_code ELSE NULL
        END,
        updated_at = ?
      WHERE ingress_id = ?
    `).run(stamp, ingressId);
    return requireIngress(ingressId);
  };

  const enable: WebhookIngressStore['enable'] = (ingressId) => {
    const current = requireIngress(ingressId);
    if (current.intake_state === 'retired') {
      throw new WebhookIngressStoreError('retired', 'webhook ingress is retired');
    }
    if (current.intake_state === 'enabled' || current.intake_state === 'degraded') {
      return current;
    }
    if (current.last_error_code === WEBHOOK_PAIRED_CONNECTION_DELETED) {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'deleted paired connection requires an explicit rebind or reconciliation',
      );
    }
    if (current.registration_state !== 'registered'
      && current.registration_state !== 'not_applicable') {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'webhook registration is incomplete',
      );
    }
    if (activeCredentialCount(ingressId) === 0) {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'webhook credentials are incomplete',
      );
    }
    if (current.intake_state !== 'ready' && current.intake_state !== 'disabled') {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'webhook ingress is not ready to enable',
      );
    }
    const stamp = now();
    db.prepare(`
      UPDATE webhook_ingresses SET
        intake_state = 'enabled',
        enabled_at = ?,
        last_error_code = NULL,
        updated_at = ?
      WHERE ingress_id = ?
    `).run(stamp, stamp, ingressId);
    return requireIngress(ingressId);
  };

  const disable: WebhookIngressStore['disable'] = (ingressId) => {
    const current = requireIngress(ingressId);
    if (current.intake_state === 'retired') {
      throw new WebhookIngressStoreError('retired', 'webhook ingress is retired');
    }
    // D-201 Slice 6B3 — `disabled` is the durable possibly-exposed marker for
    // operation-bound intake. Do not let an ingress that never crossed the
    // attach gate enter that ambiguous state; it can retire directly instead.
    if (current.registration_mode === 'operation_bound'
      && (current.intake_state === 'ready'
        || current.intake_state === 'verification_pending')) {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'never-enabled operation-bound ingress must be retired instead of disabled',
      );
    }
    const needsManagedCleanup = current.registration_mode === 'managed_endpoint'
      && current.remote_endpoint_id !== null;
    if (current.intake_state === 'disabled'
      && (!needsManagedCleanup || current.registration_state === 'cleanup_pending')) {
      return current;
    }
    if (current.intake_state !== 'ready'
      && current.intake_state !== 'verification_pending'
      && current.intake_state !== 'enabled'
      && current.intake_state !== 'degraded'
      && !(current.intake_state === 'disabled' && needsManagedCleanup)) {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'webhook ingress has not reached a disableable state',
      );
    }
    const stamp = now();
    db.prepare(`
      UPDATE webhook_ingresses SET
        intake_state = 'disabled',
        registration_state = CASE
          WHEN registration_mode = 'managed_endpoint'
            AND remote_endpoint_id IS NOT NULL
          THEN 'cleanup_pending'
          ELSE registration_state
        END,
        enabled_at = NULL,
        updated_at = ?
      WHERE ingress_id = ?
    `).run(stamp, ingressId);
    return requireIngress(ingressId);
  };

  const recordAcceptedDelivery: WebhookIngressStore['recordAcceptedDelivery'] = (
    ingressId,
    receivedAt,
  ) => {
    const current = requireIngress(ingressId);
    if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'accepted webhook delivery timestamp is invalid',
      );
    }
    if (current.intake_state === 'retired') return current;
    const stamp = now();
    db.prepare(`
      UPDATE webhook_ingresses SET
        test_observed_at = CASE
          WHEN test_observed_at IS NULL OR test_observed_at > ? THEN ?
          ELSE test_observed_at
        END,
        last_delivery_at = CASE
          WHEN last_delivery_at IS NULL OR last_delivery_at < ? THEN ?
          ELSE last_delivery_at
        END,
        intake_state = CASE
          WHEN intake_state = 'degraded'
            AND last_error_code IN (
              'unsupported_delivery',
              'profile_dependency_unavailable',
              'profile_internal_error'
            )
            AND registration_state IN ('registered', 'not_applicable')
          THEN 'enabled'
          ELSE intake_state
        END,
        last_error_code = CASE
          WHEN last_error_code IN (
            'unsupported_delivery',
            'profile_dependency_unavailable',
            'profile_internal_error'
          )
          THEN NULL
          ELSE last_error_code
        END,
        updated_at = ?
      WHERE ingress_id = ?
    `).run(
      receivedAt,
      receivedAt,
      receivedAt,
      receivedAt,
      stamp,
      ingressId,
    );
    return requireIngress(ingressId);
  };

  const recordRuntimeFailure: WebhookIngressStore['recordRuntimeFailure'] = (
    ingressId,
    code,
  ) => {
    const current = requireIngress(ingressId);
    if (current.intake_state !== 'enabled'
      && current.intake_state !== 'degraded'
      && current.intake_state !== 'verification_pending') {
      return current;
    }
    const stamp = now();
    db.prepare(`
      UPDATE webhook_ingresses SET
        intake_state = CASE WHEN intake_state = 'enabled'
          THEN 'degraded' ELSE intake_state END,
        last_error_code = ?,
        updated_at = ?
      WHERE ingress_id = ?
    `).run(code, stamp, ingressId);
    return requireIngress(ingressId);
  };

  const failCloseForDeletedPairedConnection: WebhookIngressStore['failCloseForDeletedPairedConnection'] = (
    pairedConnectionId,
  ) => {
    if (!validPairedConnectionId(pairedConnectionId)) {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'deleted paired connection id is invalid',
      );
    }
    const stamp = now();
    const selectCandidates = db.prepare(`
      SELECT * FROM webhook_ingresses
      WHERE intake_state <> 'retired'
        AND (
          paired_connection_id = ?
          OR pending_paired_connection_id = ?
        )
      ORDER BY created_at ASC, ingress_id ASC
    `);
    const closeOne = db.prepare(`
      UPDATE webhook_ingresses SET
        intake_state = CASE
          WHEN registration_mode = 'operation_bound'
            AND intake_state IN ('draft', 'verification_pending', 'ready')
          THEN intake_state
          ELSE 'disabled'
        END,
        registration_state = CASE
          WHEN registration_mode = 'managed_endpoint'
            AND registration_state <> 'cleanup_pending'
          THEN 'drifted'
          ELSE registration_state
        END,
        enabled_at = NULL,
        last_error_code = 'paired_connection_deleted',
        updated_at = ?
      WHERE ingress_id = ? AND intake_state <> 'retired'
    `);
    const persist = db.transaction((): number => {
      let changed = 0;
      const candidates = selectCandidates.all(
        pairedConnectionId,
        pairedConnectionId,
      ) as IngressSqlRow[];
      for (const candidate of candidates) {
        const ingress = rowFromSql(candidate);
        const profile = webhookProfile(ingress.profile_id);
        if (!profile) {
          throw new WebhookIngressStoreError(
            'corrupt',
            `webhook ingress '${ingress.ingress_id}' references an unknown profile`,
          );
        }
        if (!profile.registration_modes.includes(ingress.registration_mode)) {
          throw new WebhookIngressStoreError(
            'corrupt',
            `webhook ingress '${ingress.ingress_id}' has an unsupported registration mode`,
          );
        }
        if (!webhookProfileRequiresPairedConnection(
          profile,
          ingress.registration_mode,
        )) continue;
        changed += closeOne.run(stamp, ingress.ingress_id).changes;
      }
      return changed;
    });
    return persist();
  };

  const recoverDeletedOperationBoundConnection: WebhookIngressStore['recoverDeletedOperationBoundConnection'] = (
    ingressId,
    pairedConnectionId,
  ) => {
    const current = requireIngress(ingressId);
    const profile = webhookProfile(current.profile_id);
    if (!profile
      || !profile.registration_modes.includes(current.registration_mode)
      || !webhookProfileRequiresPairedConnection(
        profile,
        current.registration_mode,
      )) {
      throw new WebhookIngressStoreError(
        'corrupt',
        `webhook ingress '${ingressId}' has invalid paired-connection metadata`,
      );
    }
    if (!validPairedConnectionId(pairedConnectionId)
      || current.registration_mode !== 'operation_bound'
      || current.registration_state !== 'not_applicable'
      || (current.intake_state !== 'draft'
        && current.intake_state !== 'verification_pending'
        && current.intake_state !== 'ready'
        && current.intake_state !== 'disabled')
      || current.last_error_code !== WEBHOOK_PAIRED_CONNECTION_DELETED) {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'operation-bound ingress is not awaiting paired connection recovery',
      );
    }
    const stamp = now();
    const changed = db.prepare(`
      UPDATE webhook_ingresses SET
        paired_connection_id = ?,
        last_error_code = NULL,
        updated_at = ?
      WHERE ingress_id = ?
        AND registration_mode = 'operation_bound'
        AND registration_state = 'not_applicable'
        AND intake_state IN ('draft', 'verification_pending', 'ready', 'disabled')
        AND last_error_code = 'paired_connection_deleted'
    `).run(pairedConnectionId, stamp, ingressId);
    if (changed.changes !== 1) {
      throw new WebhookIngressStoreError(
        'conflict',
        'paired connection recovery changed concurrently',
      );
    }
    return requireIngress(ingressId);
  };

  const retire = (ingressId: string): WebhookIngressRecord => {
    const current = requireIngress(ingressId);
    if (current.intake_state === 'retired') return current;
    if (current.registration_mode === 'operation_bound'
      && (current.intake_state === 'enabled'
        || current.intake_state === 'degraded'
        || current.intake_state === 'disabled')) {
      throw new WebhookIngressStoreError(
        'invalid_state',
        'operation-bound webhook cleanup must complete before retirement',
      );
    }
    const stamp = now();
    const persist = db.transaction(() => {
      db.prepare(`
        UPDATE webhook_credential_versions
        SET state = 'retired', retired_at = ?
        WHERE ingress_id = ? AND state = 'active'
      `).run(stamp, ingressId);
      db.prepare(`
        UPDATE webhook_ingresses SET
          intake_state = 'retired',
          registration_state = CASE
            WHEN registration_mode = 'managed_endpoint'
              AND (
                remote_endpoint_id IS NOT NULL
                OR registration_attempt_connection_id IS NOT NULL
              )
            THEN 'cleanup_pending'
            WHEN remote_endpoint_id IS NOT NULL THEN 'cleanup_pending'
            ELSE 'retired'
          END,
          enabled_at = NULL,
          updated_at = ?
        WHERE ingress_id = ?
      `).run(stamp, ingressId);
    });
    persist();
    return requireIngress(ingressId);
  };

  return {
    create,
    get,
    getByPublicId(publicId) {
      const row = selectByPublicId.get(publicId) as IngressSqlRow | undefined;
      return row ? rowFromSql(row) : null;
    },
    list(input = {}) {
      const rows = input.include_retired
        ? db.prepare(`
            SELECT * FROM webhook_ingresses
            ORDER BY updated_at DESC, ingress_id ASC
          `).all()
        : db.prepare(`
            SELECT * FROM webhook_ingresses
            WHERE intake_state <> 'retired' OR registration_state = 'cleanup_pending'
            ORDER BY updated_at DESC, ingress_id ASC
          `).all();
      return (rows as IngressSqlRow[]).map(rowFromSql);
    },
    update,
    writeCredentialVersion,
    retireCredentialVersion,
    listCredentialVersions,
    readActiveCredentialVersions,
    confirmManualRegistration,
    confirmHandshakeReadiness,
    confirmOperationBoundReadiness,
    snapshotManagedRegistration,
    prepareManagedRegistration,
    rotateManagedRegistrationAttempt,
    commitManagedRegistrationCreate,
    confirmManagedRegistrationReadBack,
    markManagedRegistrationDrift,
    commitManagedConnectionAliasRebind,
    prepareManagedConnectionRebind,
    prepareManagedRegistrationCleanup,
    completeManagedRegistrationCleanup,
    markManagedRegistrationCleanupPending,
    enable,
    disable,
    recordAcceptedDelivery,
    recordRuntimeFailure,
    failCloseForDeletedPairedConnection,
    recoverDeletedOperationBoundConnection,
    retire,
  };
};
