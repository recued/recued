import {
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  RECORDS_DEFAULT_BYTE_QUOTA,
  RECORDS_DEFAULT_OUTBOX_QUOTA,
  RECORDS_DEFAULT_PAGE_SIZE,
  RECORDS_DEFAULT_ROW_QUOTA,
  RECORDS_DECIMAL_SCALE,
  RECORDS_MAX_CAUSAL_DEPTH,
  RECORDS_MAX_CAUSAL_FANOUT,
  RECORDS_MAX_GET_MANY_IDS,
  RECORDS_MAX_ID_BYTES,
  RECORDS_MAX_IN_ITEMS,
  RECORDS_MAX_INDEXED_STRING_BYTES,
  RECORDS_MAX_PAGE_SIZE,
  RECORDS_MAX_PREDICATES,
  RECORDS_MAX_BATCH_OPS,
  RECORDS_MAX_QUERY_ROWS,
  RECORDS_MAX_ROW_BYTES,
  RECORDS_MAX_TEXT_BYTES,
  RecordsContractError,
  isRecordsExecutionBinding,
  type EntitySchemaIngredientInput,
  type IngredientManifest,
  type RecipeDefinition,
  type RecordsAuthorBinding,
  type RecordsCsvExportEnvelope,
  type RecordsEventPointer,
  type RecordsExportEnvelope,
  type RecordsExecutionBinding,
  type RecordsExecutionCall,
  type RecordsFieldKind,
  createRecordsAggregator,
  createRecordsGroupedAggregator,
  validateRecordsGroupBy,
  type RecordsBatchAllow,
  type RecordsGroupedAggregateResult,
  validateRecordsAggregateSelect,
  type RecordsFieldSnapshot,
  type RecordsFilter,
  type RecordsFriendlyRecord,
  type RecordsGlobalQuotaSnapshot,
  type RecordsMutationCause,
  type RecordsNamespaceState,
  type RecordsNamespaceView,
  type RecordsOutboxOverview,
  type RecordsOutboxStatus,
  type RecordsOwnerRecordDiagnostics,
  type RecordsPackRef,
  type RecordsQuotaSnapshot,
  type RecordsRetentionPolicy,
  type RecordsSchemaSnapshot,
  type RecordsSearchResult,
  type RecordsSlot,
  type RecordsUpdateReviewFence,
} from '@recued/contracts';
import { hashRecipe } from '@recued/recipes';
import type {
  RecordsMigrationFinalizeStep,
  RecordsMigrationPlan,
  RecordsMigrationTransformStep,
  RecordsMigrationVerifyStep,
} from './migration.js';
import {
  deriveRecordsSubscriberBindings,
  recordsSubscriberMatches,
  type RecordsSubscriberBinding,
} from './subscribers.js';
import {
  recordsNamespaceReviewDigest,
  recordsOwnerPolicyDigest,
} from './review-fence.js';

const ROW_TABLE = 'core_records';
const NAMESPACE_TABLE = 'core_record_namespaces';
const REVERSE_TABLE = 'core_record_reverse_refs';
const OUTBOX_TABLE = 'core_record_outbox';
const RETENTION_TABLE = 'core_record_retention';
const META_TABLE = 'core_record_meta';
const RECEIPT_TABLE = 'core_record_migration_receipts';
const MIGRATION_TABLE = 'core_record_migrations';
const MIGRATION_STEP_TABLE = 'core_record_migration_steps';
const OUTBOX_DELIVERY_TABLE = 'core_record_outbox_deliveries';
const CURSOR_TABLE = 'core_record_cursors';

/** One export envelope is fully materialized (it carries a digest over the whole
 *  selection), so it is bounded by accounting rather than by streaming. */
const RECORDS_MAX_EXPORT_BYTES = 64 * 1024 * 1024;

const SLOT_NAMES: readonly RecordsSlot[] = [
  'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n10',
  'dec1', 'dec2', 'dec3', 'dec4', 'dec5',
  's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10',
  't1', 't2',
  'd1', 'd2', 'd3',
  'dt1', 'dt2', 'dt3',
  'b1', 'b2', 'b3', 'b4', 'b5',
  'r1', 'r2', 'r3', 'r4', 'r5',
];
const INDEXED_SLOTS = SLOT_NAMES.filter((slot) => !slot.startsWith('t'));
const SLOT_SET = new Set<string>(SLOT_NAMES);
const SUPPRESSED_CAUSES = new Set<RecordsMutationCause>([
  'migration',
  'retention',
  'uninstall_purge',
  'owner_bulk_delete',
]);
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const encoder = new TextEncoder();

interface NamespaceRow {
  publisher: string;
  pack_slug: string;
  state: string;
  version: number | null;
  from_version: number | null;
  target_version: number | null;
  storage_schema_hash: string | null;
  declaration_hash: string | null;
  target_storage_schema_hash: string | null;
  migration_id: string | null;
  schema_json: string;
  operations_json: string;
  migration_plans_json: string;
  artifact_digest: string;
  activation_generation: number;
  state_generation: number;
  data_generation: number;
  row_count: number;
  payload_bytes: number;
  row_limit: number;
  byte_limit: number;
  outbox_count: number;
  outbox_limit: number;
  subscriber_digest: string;
  subscribers_json: string;
  last_known_state: string | null;
  detected_at: number | null;
  reason: string | null;
  evidence_ref: string | null;
  updated_at: number;
}

interface MigrationRow {
  publisher: string;
  pack_slug: string;
  migration_id: string;
  plan_digest: string;
  from_version: number;
  target_version: number;
  lock_generation: number;
  target_storage_schema_hash: string;
  target_declaration_hash: string;
  target_artifact_digest: string;
  target_schema_json: string;
  route_schemas_json: string;
  artifact_pins_json: string;
  target_operations_json: string;
  target_migration_plans_json: string;
  target_subscriber_digest: string;
  target_subscribers_json: string;
  required_steps_json: string;
  ordered_steps_json: string;
  reserved_byte_delta: number;
  status: 'running' | 'complete' | 'failed';
  error: string | null;
  started_at: number;
  updated_at: number;
}

interface MigrationStepRow {
  cursor: string;
  rows_changed: number;
  complete: number;
  args_hash: string;
  op: string;
}

export interface RecordsMigrationRequiredStep {
  recipe_digest: string;
  step_id: string;
  args_hash: string;
  op: string;
}

type PhysicalValue = string | number | bigint | null;
type PhysicalFields = Record<RecordsSlot, PhysicalValue>;
type RowShape = PhysicalFields & {
  publisher: string;
  pack_slug: string;
  kind: string;
  pk: string;
  version: number;
  revision: number;
  created_at: number;
  updated_at: number;
  created_by: string;
  updated_by: string;
  payload_bytes: number;
};

interface CursorPayload {
  v: 1;
  publisher: string;
  pack_slug: string;
  version: number;
  /** Bound so an activation replacement can DROP a namespace's cursors rather
   *  than compare against them — install/promote/orphan/purge all invalidate. */
  activation_generation: number;
  operation_digest: string;
  entity: string;
  filters_hash: string;
  sort: string;
  nav: 'next' | 'prev';
  boundary_id: string;
  boundary_value: CursorValue;
}

type CursorValue =
  | { type: 'null' }
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'bigint'; value: string };

export interface RecordsInstallInput {
  owner: RecordsPackRef;
  version: number;
  storage_schema_hash: string;
  declaration_hash: string;
  artifact_digest: string;
  schema: RecordsSchemaSnapshot;
  bindings: Record<string, RecordsAuthorBinding | RecordsExecutionBinding>;
  migration_plans?: readonly RecordsMigrationPlan[];
  subscriber_digest?: string;
  subscribers?: readonly RecordsSubscriberBinding[];
  expected_state_generation?: number;
}

export type RecordsNamespaceSummary = RecordsNamespaceView;

export interface RecordsOwnerSearchInput {
  owner: RecordsPackRef;
  entity: string;
  filters?: Record<string, unknown>;
  sort?: string;
  cursor?: string;
  limit?: number;
  include_orphaned?: boolean;
}

export interface RecordsStore {
  installNamespace(input: RecordsInstallInput): RecordsNamespaceSummary;
  execute(call: RecordsExecutionCall): unknown;
  getNamespace(owner: RecordsPackRef): RecordsNamespaceSummary | null;
  listNamespaces(): RecordsNamespaceSummary[];
  listKinds(owner: RecordsPackRef): Array<{ kind: string; rows: number; payload_bytes: number }>;
  ownerSearch(input: RecordsOwnerSearchInput): RecordsSearchResult;
  ownerGet(owner: RecordsPackRef, entity: string, id: string): RecordsFriendlyRecord | null;
  ownerInspect(owner: RecordsPackRef, entity: string, id: string): {
    record: RecordsFriendlyRecord | null;
    diagnostics: RecordsOwnerRecordDiagnostics | null;
  };
  ownerDelete(input: {
    owner: RecordsPackRef;
    entity: string;
    id: string;
    expected_version: number;
    expected_revision: number;
    principal: string;
  }): { deleted: true; id: string; revision: number };
  setQuota(owner: RecordsPackRef, input: { row_limit?: number; byte_limit?: number; outbox_limit?: number }): RecordsQuotaSnapshot;
  getGlobalQuota(): RecordsGlobalQuotaSnapshot;
  setGlobalQuota(input: { row_limit?: number; byte_limit?: number; outbox_limit?: number }): RecordsGlobalQuotaSnapshot;
  setRetention(owner: RecordsPackRef, entity: string, policy: RecordsRetentionPolicy): void;
  getRetention(owner: RecordsPackRef): Record<string, RecordsRetentionPolicy>;
  runRetention(owner: RecordsPackRef, now?: number, batchSize?: number): { deleted: number; blocked: string[] };
  exportNamespace(owner: RecordsPackRef, entity?: string): RecordsExportEnvelope;
  exportNamespaceCsv(owner: RecordsPackRef, entity?: string): RecordsCsvExportEnvelope;
  orphanNamespace(owner: RecordsPackRef, expectedStateGeneration?: number): RecordsNamespaceSummary;
  purgeNamespace(owner: RecordsPackRef, confirmation: string): { rows_deleted: number; events_deleted: number };
  ownerPurgeNamespace(owner: RecordsPackRef, confirmation: string): { rows_deleted: number; events_deleted: number };
  auditAccounting(owner: RecordsPackRef): {
    coherent: boolean;
    expected_rows: number;
    expected_bytes: number;
    expected_outbox: number;
  };
  repairAccounting(owner: RecordsPackRef): RecordsNamespaceSummary;
  /** Per-entity installed natural key, canonically ordered. Read by the upgrade
   *  authority: a natural key is NOT part of `storage_schema_hash`, so without
   *  this a key added or changed at a version bump takes the schema-unchanged
   *  sweep and leaves existing rows at ids the new key does not derive. */
  getEntityNaturalKeys(owner: RecordsPackRef): Record<string, string[]>;
  isInstalledOperationId(operationId: string): boolean;
  isInstalledCatalogOperation(catalogSlug: string, operationKey: string): boolean;
  listOutbox(owner: RecordsPackRef, status?: 'pending' | 'delivered' | 'dead_letter'): RecordsEventPointer[];
  getOutboxOverview(owner: RecordsPackRef, status?: RecordsOutboxStatus, limit?: number): RecordsOutboxOverview;
  retireOutboxEvent(owner: RecordsPackRef, eventId: string, confirmation: string): boolean;
  acknowledgeEvent(eventId: string, subscriberDigest: string): boolean;
  deadLetterEvent(eventId: string, reason: string): boolean;
  listPendingDeliveries(limit?: number): RecordsOutboxDelivery[];
  acknowledgeDelivery(eventId: string, bindingDigest: string): boolean;
  failDelivery(eventId: string, bindingDigest: string, reason: string, maxRetries?: number): boolean;
  explainIndexes(): string[];
  beginMigration(input: RecordsMigrationStartInput): RecordsMigrationView;
  getMigration(owner: RecordsPackRef): RecordsMigrationView | null;
  getInstalledMigrationPlans(owner: RecordsPackRef): RecordsMigrationPlan[];
  runMigrationTransform(input: RecordsMigrationStepRunInput): RecordsMigrationBatchResult;
  runMigrationVerify(input: RecordsMigrationVerifyRunInput): RecordsMigrationBatchResult;
  runMigrationFinalizer(input: RecordsMigrationFinalizeRunInput): RecordsMigrationBatchResult;
  promoteMigration(input: RecordsMigrationPromoteInput): RecordsNamespaceSummary;
  preflightMigration(input: RecordsMigrationPreflightInput): RecordsMigrationPreflightResult;
  acquireExecutionLease(input: RecordsExecutionLeaseInput): RecordsExecutionLease;
  fenceNamespace(input: RecordsNamespaceFenceInput): RecordsNamespaceFence;
  waitForNamespaceQuiescence(input: RecordsNamespaceQuiescenceInput): Promise<RecordsNamespaceQuiescenceResult>;
  releaseNamespaceFence(fence: RecordsNamespaceFence): void;
  /** Final synchronous CAS immediately before update mutation. */
  assertUpdateReviewFence(fence: RecordsUpdateReviewFence): void;
  countActiveExecutionLeases(owner: RecordsPackRef): number;
}

export interface RecordsExecutionLeaseTarget {
  binding: RecordsExecutionBinding;
}

export interface RecordsExecutionLeaseInput {
  lease_id: string;
  recipe_id: string;
  caller_pack: string;
  targets: readonly RecordsExecutionLeaseTarget[];
}

export interface RecordsExecutionLease {
  lease_id: string;
  release(): void;
}

export interface RecordsNamespaceFenceInput {
  owner: RecordsPackRef;
  expected_activation_generation: number;
}

export interface RecordsNamespaceFence {
  fence_id: string;
  owner: RecordsPackRef;
  activation_generation: number;
}

export interface RecordsNamespaceQuiescenceInput extends RecordsNamespaceFence {
  timeout_ms: number;
}

export interface RecordsNamespaceLeaseBlocker {
  lease_id: string;
  recipe_id: string;
  caller_pack: string;
}

export interface RecordsNamespaceQuiescenceResult {
  drained: boolean;
  blockers: RecordsNamespaceLeaseBlocker[];
}

export interface RecordsMigrationStartInput {
  owner: RecordsPackRef;
  migration_id: string;
  plan_digest: string;
  from_version: number;
  target_version: number;
  target_storage_schema_hash: string;
  target_declaration_hash: string;
  target_artifact_digest: string;
  target_schema: RecordsSchemaSnapshot;
  route_schemas?: Record<string, RecordsSchemaSnapshot>;
  /** Immutable provenance digests for every source/intermediate/target
   * artifact selected by the route review. */
  artifact_pins: Record<string, string>;
  target_bindings: Record<string, RecordsExecutionBinding>;
  target_migration_plans?: readonly RecordsMigrationPlan[];
  target_subscriber_digest: string;
  target_subscribers: readonly RecordsSubscriberBinding[];
  required_steps: readonly RecordsMigrationRequiredStep[];
  /** Full classified literal bodies in execution order. Identities alone are
   * insufficient to resume safely while offline after a crash. */
  ordered_steps: ReadonlyArray<RecordsMigrationSelectedStep>;
  expected_state_generation: number;
  /** Positive target growth proven by the rolled-back exact preflight. */
  reserved_byte_delta?: number;
}

export interface RecordsMigrationSelectedStep {
  recipe_digest: string;
  step: RecordsMigrationTransformStep | RecordsMigrationVerifyStep | RecordsMigrationFinalizeStep;
}

export interface RecordsMigrationView {
  owner: RecordsPackRef;
  migration_id: string;
  plan_digest: string;
  from_version: number;
  target_version: number;
  lock_generation: number;
  status: 'running' | 'complete' | 'failed';
  target_schema: RecordsSchemaSnapshot;
  reserved_byte_delta: number;
  started_at: number;
  updated_at: number;
  error?: string;
}

interface RecordsMigrationRunBase {
  owner: RecordsPackRef;
  migration_id: string;
  lock_generation: number;
  recipe_digest: string;
  batch_size?: number;
}

export interface RecordsMigrationStepRunInput extends RecordsMigrationRunBase {
  step: RecordsMigrationTransformStep;
}
export interface RecordsMigrationVerifyRunInput extends RecordsMigrationRunBase {
  step: RecordsMigrationVerifyStep;
}
export interface RecordsMigrationFinalizeRunInput extends RecordsMigrationRunBase {
  step: RecordsMigrationFinalizeStep;
  required_receipts: ReadonlyArray<{
    recipe_digest: string;
    step_id: string;
    args_hash: string;
  }>;
}
export interface RecordsMigrationBatchResult {
  done: boolean;
  cursor: string;
  rows_changed: number;
}
export interface RecordsMigrationPromoteInput {
  owner: RecordsPackRef;
  migration_id: string;
  lock_generation: number;
  finalizer: {
    recipe_digest: string;
    step_id: string;
    args_hash: string;
  };
}

export interface RecordsMigrationPreflightInput {
  start: RecordsMigrationStartInput;
  ordered_steps: ReadonlyArray<RecordsMigrationSelectedStep>;
}

export interface RecordsMigrationPreflightResult {
  batches: number;
  rows_changed: number;
  byte_delta: number;
}

export interface RecordsOutboxDelivery {
  event: RecordsEventPointer;
  subscriber: RecordsSubscriberBinding;
  root_event_id: string;
  causal_depth: number;
  watcher_digest?: string;
  retry_count: number;
}

export interface CreateRecordsStoreOptions {
  now?: () => number;
  id?: () => string;
}

const fail = (
  code: ConstructorParameters<typeof RecordsContractError>[0],
  message: string,
  details?: Record<string, unknown>,
  retryable = false,
): never => {
  throw new RecordsContractError(code, message, { details, retryable });
};

const requireValue = <T>(value: T | null | undefined, code: 'records_not_found' | 'records_incoherent', message: string): T => {
  if (value === null || value === undefined) fail(code, message);
  return value as T;
};

const assertPackRef = (owner: RecordsPackRef): void => {
  if (!owner || typeof owner.publisher !== 'string' || owner.publisher.length === 0
    || typeof owner.pack_slug !== 'string' || owner.pack_slug.length === 0) {
    fail('records_invalid', 'a verified publisher and pack slug are required');
  }
};

const bytes = (value: string): number => encoder.encode(value).byteLength;

/** The smallest string strictly greater than every string starting with
 *  `prefix`, under binary collation — i.e. the exclusive upper bound of the
 *  prefix range. Increments the last code point below U+10FFFF and drops the
 *  U+10FFFF tail after it. `null` when no such string exists (an all-U+10FFFF
 *  prefix), where the range is unbounded above. */
const lexicographicSuccessor = (prefix: string): string | null => {
  const points = [...prefix];
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const code = points[index]!.codePointAt(0)!;
    if (code < 0x10ffff) {
      // Skip the surrogate block so the successor stays well-formed.
      const next = code === 0xd7ff ? 0xe000 : code + 1;
      return [...points.slice(0, index), String.fromCodePoint(next)].join('');
    }
  }
  return null;
};

/** Lone surrogates survive JS string validation and byte-length checks, but
 *  SQLite stores UTF-8 — so they land as U+FFFD. Two distinct inputs then read
 *  back identical while having hashed to DIFFERENT natural ids, which both
 *  defeats uniqueness and turns an exact retry into a conflict instead of a
 *  replay. Refuse them at the boundary rather than persisting a value the store
 *  cannot represent. */
const hasLoneSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0xd800 || code > 0xdfff) continue;
    if (code >= 0xdc00) return true; // Trailing surrogate with no lead.
    const next = value.charCodeAt(index + 1);
    if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
    index += 1; // Well-formed pair.
  }
  return false;
};

const assertId = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail('records_invalid', 'record id must be a non-empty string without NUL');
  }
  const id = value as string;
  if (hasLoneSurrogate(id)) {
    fail('records_invalid', 'record id contains an unpaired UTF-16 surrogate');
  }
  if (bytes(id) > RECORDS_MAX_ID_BYTES) {
    fail('records_invalid', `record id exceeds ${RECORDS_MAX_ID_BYTES} UTF-8 bytes`);
  }
  return id;
};

const assertSafePositive = (value: unknown, name: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail('records_invalid', `${name} must be a positive safe integer`);
  }
  return value as number;
};

const assertSafeNonNegative = (value: unknown, name: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail('records_invalid', `${name} must be a non-negative safe integer`);
  }
  return value as number;
};

/** Reject exotic runtime values even when an internal caller bypasses JSON. */
const assertJsonTree = (value: unknown, path = '$', seen = new Set<object>()): void => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('records_invalid', `${path} contains a non-finite number`);
    return;
  }
  if (typeof value !== 'object') fail('records_invalid', `${path} is not JSON data`);
  const object = value as object;
  if (seen.has(object)) fail('records_invalid', `${path} is cyclic`);
  seen.add(object);
  if (Array.isArray(value)) {
    for (let idx = 0; idx < value.length; idx += 1) {
      if (!Object.hasOwn(value, idx)) fail('records_invalid', `${path} contains a sparse array`);
      assertJsonTree(value[idx], `${path}[${idx}]`, seen);
    }
  } else {
    const record = value as Record<PropertyKey, unknown>;
    const proto = Object.getPrototypeOf(record);
    if (proto !== Object.prototype && proto !== null) fail('records_invalid', `${path} is not a plain object`);
    for (const rawKey of Reflect.ownKeys(record)) {
      if (typeof rawKey !== 'string') {
        fail('records_invalid', `${path} contains a symbol key`);
      }
      const key = rawKey as string;
      if (key === '__proto__' || key === 'prototype' || key === 'constructor' || key.includes('.')) {
        fail('records_invalid', `${path}.${key} is not a safe own-property key`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || descriptor.get || descriptor.set) fail('records_invalid', `${path}.${key} is an accessor`);
      assertJsonTree(descriptor!.value, `${path}.${key}`, seen);
    }
  }
  seen.delete(object);
};

const pathValue = (root: Record<string, unknown>, path: string): { present: boolean; value: unknown } => {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)
      || !Object.hasOwn(current, segment)) return { present: false, value: undefined };
    current = (current as Record<string, unknown>)[segment];
  }
  return { present: true, value: current };
};

const setPath = (root: Record<string, unknown>, path: string, value: unknown): void => {
  const segments = path.split('.');
  let cursor = root;
  for (let idx = 0; idx < segments.length - 1; idx += 1) {
    const segment = segments[idx];
    const next = cursor[segment];
    if (next === undefined) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
};

const leafPaths = (value: Record<string, unknown>, prefix = ''): string[] => {
  const out: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      const nested = leafPaths(child as Record<string, unknown>, path);
      if (nested.length === 0) out.push(path);
      else out.push(...nested);
    } else {
      out.push(path);
    }
  }
  return out;
};

const encodeDecimal = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^[+-]?[0-9]+(?:\.[0-9]{1,4})?$/.test(value)) {
    fail('records_invalid', `decimal must be an ASCII fixed-point string with at most ${RECORDS_DECIMAL_SCALE} fractional digits`);
  }
  const input = value as string;
  const negative = input.startsWith('-');
  const unsigned = input.replace(/^[+-]/, '');
  const [whole, fraction = ''] = unsigned.split('.');
  const scaled = BigInt(whole) * 10n ** BigInt(RECORDS_DECIMAL_SCALE)
    + BigInt(fraction.padEnd(RECORDS_DECIMAL_SCALE, '0'));
  const signed = negative ? -scaled : scaled;
  if (signed < INT64_MIN || signed > INT64_MAX) fail('records_invalid', 'decimal exceeds signed 64-bit scaled range');
  return signed;
};

const decodeDecimal = (value: number | bigint): string => {
  const scaled = typeof value === 'bigint' ? value : BigInt(value);
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const base = 10n ** BigInt(RECORDS_DECIMAL_SCALE);
  return `${negative ? '-' : ''}${abs / base}.${(abs % base).toString().padStart(RECORDS_DECIMAL_SCALE, '0')}`;
};

const encodeDate = (value: unknown): string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail('records_invalid', 'date must be canonical YYYY-MM-DD');
  }
  const input = value as string;
  // `Date.UTC(0..99, ...)` silently adds 1900, so validate through the ISO
  // parser instead. Four-digit proleptic years (including 0000..0099) are part
  // of the admitted canonical grammar and must not be rejected accidentally.
  const date = new Date(`${input}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== input) {
    fail('records_invalid', `'${input}' is not a real calendar date`);
  }
  return input;
};

const encodeDatetime = (value: unknown): number => {
  if (typeof value !== 'string') {
    fail('records_invalid', 'datetime must be an offset-bearing ISO timestamp without leap seconds');
  }
  const input = value as string;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(input);
  if (match === null) {
    return fail('records_invalid', 'datetime must be an offset-bearing ISO timestamp without leap seconds');
  }
  // Date.parse normalizes invalid calendar/time components (for example,
  // 2023-02-29 and 24:00) instead of rejecting them. Validate every component
  // before using the parser so distinct invalid wire values cannot silently
  // converge on a different stored instant.
  encodeDate(`${match[1]}-${match[2]}-${match[3]}`);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === 'Z' ? 0 : Number(match[10]);
  const offsetMinute = match[8] === 'Z' ? 0 : Number(match[11]);
  if (hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    fail('records_invalid', 'datetime contains an invalid clock or UTC-offset component');
  }
  const parsed = Date.parse(input);
  if (!Number.isSafeInteger(parsed)) fail('records_invalid', 'datetime is outside the supported epoch-ms range');
  return parsed;
};

const canonicalRef = (value: unknown): { encoded: string; kind: string; id: string } => {
  if (typeof value !== 'string' || value.split('/').length !== 2) {
    fail('records_invalid', 'reference must contain exactly one unescaped slash');
  }
  const input = value as string;
  const [kind, encodedId] = input.split('/');
  if (!/^[a-z][a-z0-9_]*$/.test(kind) || encodedId.length === 0) {
    fail('records_invalid', 'reference kind/id is malformed');
  }
  let id: string;
  try {
    id = decodeURIComponent(encodedId);
  } catch {
    return fail('records_invalid', 'reference contains malformed percent encoding');
  }
  assertId(id);
  const canonical = `${kind}/${encodeURIComponent(id)}`;
  if (canonical !== input) fail('records_invalid', 'reference is not canonically percent encoded');
  return { encoded: canonical, kind, id };
};

const normalizeField = (field: RecordsFieldSnapshot, value: unknown): PhysicalValue => {
  if (value === null || value === undefined) return null;
  switch (field.kind) {
    case 'id': return assertId(value);
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)
        || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
        return fail('records_invalid', `field '${field.key}' requires a finite number (integer values must be safe)`);
      }
      // Collapse -0 to 0. SQLite reads -0 back as +0, while replay-equality and
      // the update no-op check both use `Object.is` — so persisting -0 makes an
      // exact create retry look like a DIFFERENT row (conflict instead of
      // replay) and makes `0 → -0` look like a real edit (revision bump plus a
      // watcher event for a value the store cannot even represent).
      return value === 0 ? 0 : value;
    case 'decimal': return encodeDecimal(value);
    case 'string':
      if (typeof value !== 'string' || bytes(value) > RECORDS_MAX_INDEXED_STRING_BYTES) {
        return fail('records_invalid', `field '${field.key}' requires at most ${RECORDS_MAX_INDEXED_STRING_BYTES} UTF-8 bytes`);
      }
      if (hasLoneSurrogate(value)) {
        return fail('records_invalid', `field '${field.key}' contains an unpaired UTF-16 surrogate`);
      }
      return value;
    case 'text':
      if (typeof value !== 'string' || bytes(value) > RECORDS_MAX_TEXT_BYTES) {
        return fail('records_invalid', `field '${field.key}' requires at most ${RECORDS_MAX_TEXT_BYTES} UTF-8 bytes`);
      }
      if (hasLoneSurrogate(value)) {
        return fail('records_invalid', `field '${field.key}' contains an unpaired UTF-16 surrogate`);
      }
      return value;
    case 'date': return encodeDate(value);
    case 'datetime': return encodeDatetime(value);
    case 'boolean':
      if (typeof value !== 'boolean') return fail('records_invalid', `field '${field.key}' requires a boolean`);
      return value ? 1 : 0;
    case 'ref': return canonicalRef(value).encoded;
  }
};

const wireValue = (field: RecordsFieldSnapshot, value: PhysicalValue): unknown => {
  if (value === null) return null;
  if (field.kind === 'decimal') return decodeDecimal(value as number | bigint);
  if (field.kind === 'datetime') return new Date(Number(value)).toISOString();
  if (field.kind === 'boolean') return value === 1 || value === 1n;
  return value;
};

const emptyPhysical = (): PhysicalFields => Object.fromEntries(
  SLOT_NAMES.map((slot) => [slot, null]),
) as PhysicalFields;

const logicalPayloadBytes = (id: string, values: PhysicalFields): number => {
  let total = bytes(id);
  for (const slot of SLOT_NAMES) {
    const value = values[slot];
    if (value === null) continue;
    total += typeof value === 'string' ? bytes(value) : bytes(String(value));
  }
  if (total > RECORDS_MAX_ROW_BYTES) fail('records_invalid', `record exceeds ${RECORDS_MAX_ROW_BYTES} logical bytes`);
  return total;
};

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
};

const csvCell = (value: unknown): string => {
  const rendered = value === null || value === undefined
    ? ''
    : typeof value === 'string'
      ? value
      : typeof value === 'object'
        ? canonicalJson(value)
        : String(value);
  return `"${rendered.replace(/"/g, '""')}"`;
};

const stateFromRow = (row: NamespaceRow): RecordsNamespaceState => {
  if (row.state === 'ready') return {
    state: 'ready',
    version: row.version!,
    storage_schema_hash: row.storage_schema_hash!,
    declaration_hash: row.declaration_hash!,
  };
  if (row.state === 'migrating') return {
    state: 'migrating',
    from_version: row.from_version!,
    target_version: row.target_version!,
    target_storage_schema_hash: row.target_storage_schema_hash!,
    migration_id: row.migration_id!,
  };
  if (row.state === 'orphaned') return {
    state: 'orphaned',
    last_version: row.version!,
    storage_schema_hash: row.storage_schema_hash!,
    declaration_hash: row.declaration_hash!,
  };
  return {
    state: 'incoherent',
    last_known_state: row.last_known_state ?? 'unknown',
    detected_at: row.detected_at ?? row.updated_at,
    reason: row.reason ?? 'namespace metadata is incoherent',
    ...(row.evidence_ref ? { evidence_ref: row.evidence_ref } : {}),
  };
};

const ensureSchema = (db: Database.Database): void => {
  const slotSql = [
    ...Array.from({ length: 10 }, (_, idx) => `n${idx + 1} REAL`),
    ...Array.from({ length: 5 }, (_, idx) => `dec${idx + 1} INTEGER`),
    ...Array.from({ length: 10 }, (_, idx) => `s${idx + 1} TEXT COLLATE BINARY`),
    't1 TEXT', 't2 TEXT',
    'd1 TEXT', 'd2 TEXT', 'd3 TEXT',
    'dt1 INTEGER', 'dt2 INTEGER', 'dt3 INTEGER',
    ...Array.from({ length: 5 }, (_, idx) => `b${idx + 1} INTEGER CHECK (b${idx + 1} IS NULL OR b${idx + 1} IN (0,1))`),
    'r1 TEXT', 'r2 TEXT', 'r3 TEXT', 'r4 TEXT', 'r5 TEXT',
  ].join(',\n');
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${ROW_TABLE} (
      publisher TEXT NOT NULL,
      pack_slug TEXT NOT NULL,
      kind TEXT NOT NULL,
      pk TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
      ${slotSql},
      PRIMARY KEY (publisher, pack_slug, kind, pk)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS ${NAMESPACE_TABLE} (
      publisher TEXT NOT NULL,
      pack_slug TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('ready','migrating','orphaned','incoherent')),
      version INTEGER,
      from_version INTEGER,
      target_version INTEGER,
      storage_schema_hash TEXT,
      declaration_hash TEXT,
      target_storage_schema_hash TEXT,
      migration_id TEXT,
      schema_json TEXT NOT NULL,
      operations_json TEXT NOT NULL,
      migration_plans_json TEXT NOT NULL DEFAULT '[]',
      artifact_digest TEXT NOT NULL,
      activation_generation INTEGER NOT NULL,
      state_generation INTEGER NOT NULL,
      data_generation INTEGER NOT NULL,
      row_count INTEGER NOT NULL,
      payload_bytes INTEGER NOT NULL,
      row_limit INTEGER NOT NULL,
      byte_limit INTEGER NOT NULL,
      outbox_count INTEGER NOT NULL,
      outbox_limit INTEGER NOT NULL,
      subscriber_digest TEXT NOT NULL,
      subscribers_json TEXT NOT NULL,
      last_known_state TEXT,
      detected_at INTEGER,
      reason TEXT,
      evidence_ref TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (publisher, pack_slug)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS ${REVERSE_TABLE} (
      publisher TEXT NOT NULL,
      pack_slug TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_pk TEXT NOT NULL,
      source_slot TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_pk TEXT NOT NULL,
      PRIMARY KEY (publisher, pack_slug, source_kind, source_pk, source_slot),
      FOREIGN KEY (publisher, pack_slug, source_kind, source_pk)
        REFERENCES ${ROW_TABLE}(publisher, pack_slug, kind, pk) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS core_record_reverse_target_idx
      ON ${REVERSE_TABLE}(publisher, pack_slug, target_kind, target_pk, source_kind, source_pk);

    CREATE TABLE IF NOT EXISTS ${OUTBOX_TABLE} (
      event_id TEXT PRIMARY KEY,
      publisher TEXT NOT NULL,
      pack_slug TEXT NOT NULL,
      kind TEXT NOT NULL,
      pk TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_revision INTEGER NOT NULL,
      changed_fields_json TEXT NOT NULL,
      activation_generation INTEGER NOT NULL,
      subscriber_digest TEXT NOT NULL,
      cause TEXT NOT NULL,
      root_event_id TEXT NOT NULL,
      causal_depth INTEGER NOT NULL,
      watcher_digest TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending','delivered','dead_letter')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS core_record_outbox_pack_idx
      ON ${OUTBOX_TABLE}(publisher, pack_slug, status, created_at, event_id);

    CREATE TABLE IF NOT EXISTS ${OUTBOX_DELIVERY_TABLE} (
      event_id TEXT NOT NULL,
      binding_digest TEXT NOT NULL,
      recipe_id TEXT NOT NULL,
      recipe_digest TEXT NOT NULL,
      trigger_digest TEXT NOT NULL,
      subscriber_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','delivered','dead_letter')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      delivered_at INTEGER,
      PRIMARY KEY (event_id, binding_digest),
      FOREIGN KEY (event_id) REFERENCES ${OUTBOX_TABLE}(event_id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS core_record_outbox_delivery_pending_idx
      ON ${OUTBOX_DELIVERY_TABLE}(status,event_id,binding_digest);

    CREATE TABLE IF NOT EXISTS ${RETENTION_TABLE} (
      publisher TEXT NOT NULL,
      pack_slug TEXT NOT NULL,
      kind TEXT NOT NULL,
      policy_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (publisher, pack_slug, kind)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS ${CURSOR_TABLE} (
      token TEXT PRIMARY KEY,
      publisher TEXT NOT NULL,
      pack_slug TEXT NOT NULL,
      entity TEXT NOT NULL,
      operation_digest TEXT NOT NULL,
      pack_version INTEGER NOT NULL,
      activation_generation INTEGER NOT NULL,
      filters_hash TEXT NOT NULL,
      sort TEXT NOT NULL,
      nav TEXT NOT NULL CHECK (nav IN ('next','prev')),
      boundary_id TEXT NOT NULL,
      boundary_value_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS core_record_cursors_owner_idx
      ON ${CURSOR_TABLE}(publisher, pack_slug, created_at);
    CREATE INDEX IF NOT EXISTS core_record_cursors_age_idx
      ON ${CURSOR_TABLE}(created_at);

    CREATE TABLE IF NOT EXISTS ${RECEIPT_TABLE} (
      publisher TEXT NOT NULL,
      pack_slug TEXT NOT NULL,
      migration_id TEXT NOT NULL,
      batch_cursor TEXT NOT NULL,
      mapping_hash TEXT NOT NULL,
      rows_changed INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (publisher, pack_slug, migration_id, batch_cursor)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      publisher TEXT NOT NULL,
      pack_slug TEXT NOT NULL,
      migration_id TEXT NOT NULL,
      plan_digest TEXT NOT NULL,
      from_version INTEGER NOT NULL,
      target_version INTEGER NOT NULL,
      lock_generation INTEGER NOT NULL,
      target_storage_schema_hash TEXT NOT NULL,
      target_declaration_hash TEXT NOT NULL,
      target_artifact_digest TEXT NOT NULL,
      target_schema_json TEXT NOT NULL,
      route_schemas_json TEXT NOT NULL,
      artifact_pins_json TEXT NOT NULL,
      target_operations_json TEXT NOT NULL,
      target_migration_plans_json TEXT NOT NULL DEFAULT '[]',
      target_subscriber_digest TEXT NOT NULL,
      target_subscribers_json TEXT NOT NULL,
      required_steps_json TEXT NOT NULL,
      ordered_steps_json TEXT NOT NULL,
      reserved_byte_delta INTEGER NOT NULL DEFAULT 0 CHECK(reserved_byte_delta >= 0),
      status TEXT NOT NULL CHECK(status IN ('running','complete','failed')),
      error TEXT,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (publisher, pack_slug)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS ${MIGRATION_STEP_TABLE} (
      publisher TEXT NOT NULL,
      pack_slug TEXT NOT NULL,
      migration_id TEXT NOT NULL,
      recipe_digest TEXT NOT NULL,
      step_id TEXT NOT NULL,
      op TEXT NOT NULL,
      args_hash TEXT NOT NULL,
      cursor TEXT NOT NULL,
      rows_changed INTEGER NOT NULL,
      complete INTEGER NOT NULL CHECK(complete IN (0,1)),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (publisher, pack_slug, migration_id, recipe_digest, step_id)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS ${META_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const namespaceColumns = db.prepare(`PRAGMA table_info(${NAMESPACE_TABLE})`).all() as Array<{ name: string }>;
  if (!namespaceColumns.some((column) => column.name === 'migration_plans_json')) {
    db.exec(`ALTER TABLE ${NAMESPACE_TABLE} ADD COLUMN migration_plans_json TEXT NOT NULL DEFAULT '[]'`);
  }
  const migrationColumns = db.prepare(`PRAGMA table_info(${MIGRATION_TABLE})`).all() as Array<{ name: string }>;
  if (!migrationColumns.some((column) => column.name === 'target_migration_plans_json')) {
    db.exec(`ALTER TABLE ${MIGRATION_TABLE} ADD COLUMN target_migration_plans_json TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!migrationColumns.some((column) => column.name === 'artifact_pins_json')) {
    db.exec(`ALTER TABLE ${MIGRATION_TABLE} ADD COLUMN artifact_pins_json TEXT NOT NULL DEFAULT '{}'`);
  }
  if (!migrationColumns.some((column) => column.name === 'ordered_steps_json')) {
    db.exec(`ALTER TABLE ${MIGRATION_TABLE} ADD COLUMN ordered_steps_json TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!migrationColumns.some((column) => column.name === 'reserved_byte_delta')) {
    db.exec(`ALTER TABLE ${MIGRATION_TABLE} ADD COLUMN reserved_byte_delta INTEGER NOT NULL DEFAULT 0`);
  }
  for (const slot of INDEXED_SLOTS) {
    const indexName = `core_records_${slot}_idx`;
    const existing = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name=?`)
      .get(indexName) as { sql: string | null } | undefined;
    // D-221 is pre-launch: replace the early dense prototype indexes in place.
    // A null-heavy row should enter only the few indexes for fields it owns,
    // not all 41 fixed-family indexes. `is_null` deliberately uses the bounded
    // namespace-primary-key path below rather than rebuilding a dense mirror.
    if (existing?.sql && !existing.sql.toLowerCase().includes(`where ${slot} is not null`)) {
      db.exec(`DROP INDEX ${indexName}`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS core_records_${slot}_idx
      ON ${ROW_TABLE}(publisher, pack_slug, kind, ${slot}, pk)
      WHERE ${slot} IS NOT NULL`);
  }
};

/** Validate the Records portion of a staged whole-database restore without
 * mutating it. Old archives that predate Records contain none of these tables
 * and remain valid. Once any Records table is present, however, the restore
 * must carry the complete namespace/data/control-plane checkpoint. */
export const assertRecordsRestoreCoherence = (db: Database.Database): void => {
  const tableExists = (name: string): boolean => Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`,
  ).get(name));
  const decodeContractSegments = (key: string): string[] => key.split('.').map((segment) =>
    segment.replace(/%2E/gi, '.').replace(/%25/gi, '%'));
  const requiredTables = [
    ROW_TABLE,
    NAMESPACE_TABLE,
    REVERSE_TABLE,
    OUTBOX_TABLE,
    OUTBOX_DELIVERY_TABLE,
    RETENTION_TABLE,
    META_TABLE,
    RECEIPT_TABLE,
    MIGRATION_TABLE,
    MIGRATION_STEP_TABLE,
  ] as const;
  const present = new Set((db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'core_record%'`,
  ).all() as Array<{ name: string }>).map((row) => row.name));
  if (present.size === 0) return;
  const missing = requiredTables.filter((table) => !present.has(table));
  if (missing.length > 0) {
    throw new Error(`records_restore_incoherent: incomplete Records checkpoint; missing ${missing.join(', ')}`);
  }

  const recordsTables = new Set<string>(requiredTables);
  const foreignKeyFailures = (db.prepare('PRAGMA foreign_key_check').all() as Array<{ table: string }>)
    .filter((failure) => recordsTables.has(failure.table));
  if (foreignKeyFailures.length > 0) {
    throw new Error(`records_restore_incoherent: ${foreignKeyFailures.length} Records foreign-key failure(s)`);
  }
  for (const table of [ROW_TABLE, REVERSE_TABLE, OUTBOX_TABLE, RETENTION_TABLE, RECEIPT_TABLE, MIGRATION_TABLE, MIGRATION_STEP_TABLE]) {
    const orphan = db.prepare(`SELECT 1 FROM ${table} AS child
      LEFT JOIN ${NAMESPACE_TABLE} AS ns
        ON ns.publisher=child.publisher AND ns.pack_slug=child.pack_slug
      WHERE ns.publisher IS NULL LIMIT 1`).get();
    if (orphan) throw new Error(`records_restore_incoherent: ${table} contains a namespace orphan`);
  }

  const namespaceRows = db.prepare(`SELECT * FROM ${NAMESPACE_TABLE} ORDER BY publisher,pack_slug`).all() as NamespaceRow[];
  for (const ns of namespaceRows) {
    const label = `${ns.publisher}/${ns.pack_slug}`;
    let schema: RecordsSchemaSnapshot;
    let operations: Record<string, RecordsExecutionBinding>;
    let migrationPlans: RecordsMigrationPlan[];
    let subscribers: RecordsSubscriberBinding[];
    try {
      schema = JSON.parse(ns.schema_json) as RecordsSchemaSnapshot;
      operations = JSON.parse(ns.operations_json) as Record<string, RecordsExecutionBinding>;
      migrationPlans = JSON.parse(ns.migration_plans_json) as RecordsMigrationPlan[];
      subscribers = JSON.parse(ns.subscribers_json) as RecordsSubscriberBinding[];
    } catch {
      throw new Error(`records_restore_incoherent: ${label} has unreadable immutable snapshots`);
    }
    if (!schema || typeof schema !== 'object' || !schema.entities
      || !operations || typeof operations !== 'object' || !Array.isArray(migrationPlans)
      || !Array.isArray(subscribers)
      || sha256(canonicalJson(subscribers)) !== ns.subscriber_digest) {
      throw new Error(`records_restore_incoherent: ${label} has invalid schema/operation/subscriber snapshots`);
    }

    const actual = db.prepare(`SELECT count(*) AS n,coalesce(sum(payload_bytes),0) AS b
      FROM ${ROW_TABLE} WHERE publisher=? AND pack_slug=?`)
      .get(ns.publisher, ns.pack_slug) as { n: number; b: number };
    const pending = db.prepare(`SELECT count(*) AS n FROM ${OUTBOX_TABLE}
      WHERE publisher=? AND pack_slug=? AND status='pending'`)
      .get(ns.publisher, ns.pack_slug) as { n: number };
    if (ns.state !== 'incoherent'
      && (actual.n !== ns.row_count || actual.b !== ns.payload_bytes || pending.n !== ns.outbox_count)) {
      throw new Error(`records_restore_incoherent: ${label} accounting does not match its checkpoint`);
    }

    if (ns.state === 'ready') {
      if (!Number.isSafeInteger(ns.version) || (ns.version ?? 0) <= 0
        || !ns.storage_schema_hash || !ns.declaration_hash || !ns.artifact_digest) {
        throw new Error(`records_restore_incoherent: ${label} has incomplete ready authority`);
      }
      const wrongVersion = db.prepare(`SELECT 1 FROM ${ROW_TABLE}
        WHERE publisher=? AND pack_slug=? AND version<>? LIMIT 1`)
        .get(ns.publisher, ns.pack_slug, ns.version);
      if (wrongVersion) throw new Error(`records_restore_incoherent: ${label} has rows outside its ready version`);
      const staleEvent = db.prepare(`SELECT 1 FROM ${OUTBOX_TABLE}
        WHERE publisher=? AND pack_slug=? AND status='pending'
          AND (activation_generation<>? OR subscriber_digest<>?) LIMIT 1`)
        .get(ns.publisher, ns.pack_slug, ns.activation_generation, ns.subscriber_digest);
      if (staleEvent) throw new Error(`records_restore_incoherent: ${label} has a stale runnable event pointer`);

      const internalPackId = `records-${sha256(canonicalJson({
        publisher: ns.publisher,
        pack_slug: ns.pack_slug,
      })).slice(0, 32)}`;
    } else if (ns.state === 'migrating') {
      const migration = db.prepare(`SELECT * FROM ${MIGRATION_TABLE}
        WHERE publisher=? AND pack_slug=?`).get(ns.publisher, ns.pack_slug) as MigrationRow | undefined;
      if (!migration || migration.migration_id !== ns.migration_id
        || migration.lock_generation !== ns.state_generation
        || migration.from_version !== ns.from_version
        || migration.target_version !== ns.target_version
        || migration.target_storage_schema_hash !== ns.target_storage_schema_hash) {
        throw new Error(`records_restore_incoherent: ${label} migration recovery state is missing or divergent`);
      }
      try {
        const targetSchema = JSON.parse(migration.target_schema_json) as RecordsSchemaSnapshot;
        const routeSchemas = JSON.parse(migration.route_schemas_json) as Record<string, RecordsSchemaSnapshot>;
        const artifactPins = JSON.parse(migration.artifact_pins_json) as Record<string, string>;
        const targetOperations = JSON.parse(migration.target_operations_json) as Record<string, RecordsExecutionBinding>;
        const targetPlans = JSON.parse(migration.target_migration_plans_json) as RecordsMigrationPlan[];
        const targetSubscribers = JSON.parse(migration.target_subscribers_json) as RecordsSubscriberBinding[];
        const required = JSON.parse(migration.required_steps_json) as RecordsMigrationRequiredStep[];
        const ordered = JSON.parse(migration.ordered_steps_json) as RecordsMigrationSelectedStep[];
        if (!targetSchema?.entities || !routeSchemas || !artifactPins || !targetOperations
          || !Array.isArray(targetPlans) || !Array.isArray(targetSubscribers)
          || !Array.isArray(required) || !Array.isArray(ordered)
          || !Number.isSafeInteger(migration.reserved_byte_delta)
          || migration.reserved_byte_delta < 0
          || required.length === 0 || required.length !== ordered.length
          || sha256(canonicalJson(targetSubscribers)) !== migration.target_subscriber_digest
          || canonicalJson(routeSchemas[String(migration.from_version)]) !== canonicalJson(schema)
          || canonicalJson(routeSchemas[String(migration.target_version)]) !== canonicalJson(targetSchema)
          || artifactPins[String(migration.from_version)] !== ns.artifact_digest
          || artifactPins[String(migration.target_version)] !== migration.target_artifact_digest
          || required.some((identity, index) => {
            const selected = ordered[index];
            return selected === undefined
              || selected.recipe_digest !== identity.recipe_digest
              || selected.step.id !== identity.step_id
              || selected.step.op !== identity.op
              || selected.step.args_hash !== identity.args_hash;
          })) {
          throw new Error('invalid migration recovery snapshot');
        }
      } catch {
        throw new Error(`records_restore_incoherent: ${label} has unreadable or divergent migration artifacts`);
      }
    } else if (ns.state === 'orphaned') {
      if (!Number.isSafeInteger(ns.version) || (ns.version ?? 0) <= 0
        || !ns.storage_schema_hash || !ns.declaration_hash) {
        throw new Error(`records_restore_incoherent: ${label} has incomplete retained authority`);
      }
    } else if (ns.state !== 'incoherent') {
      throw new Error(`records_restore_incoherent: ${label} has unknown state '${ns.state}'`);
    }

    if (ns.state === 'ready' || ns.state === 'migrating') {
      const supportTables = ['local_manifest', 'contract_store', 'recipes'] as const;
      const missingSupport = supportTables.filter((table) => !tableExists(table));
      if (missingSupport.length > 0) {
        throw new Error(
          `records_restore_incoherent: ${label} runnable checkpoint is missing ${missingSupport.join(', ')}`,
        );
      }
      const activeVersion = ns.state === 'ready' ? ns.version : ns.from_version;
      if (!Number.isSafeInteger(activeVersion) || (activeVersion ?? 0) <= 0) {
        throw new Error(`records_restore_incoherent: ${label} has no valid active artifact version`);
      }
      const internalPackId = `records-${sha256(canonicalJson({
        publisher: ns.publisher,
        pack_slug: ns.pack_slug,
      })).slice(0, 32)}`;

      const local = db.prepare(`SELECT manifest_json,entity_schemas_json FROM local_manifest
        WHERE slug=? AND version=?`).get(internalPackId, activeVersion) as {
          manifest_json: string;
          entity_schemas_json: string;
        } | undefined;
      let manifest: IngredientManifest | undefined;
      let entitySchemas: EntitySchemaIngredientInput[] | undefined;
      try {
        manifest = local ? JSON.parse(local.manifest_json) as IngredientManifest : undefined;
        const parsedSchemas = local ? JSON.parse(local.entity_schemas_json) : undefined;
        entitySchemas = Array.isArray(parsedSchemas)
          ? parsedSchemas as EntitySchemaIngredientInput[]
          : undefined;
      } catch { /* checked below */ }
      const manifestRecords = manifest?.surfaces?.records;
      if (!local || !manifest || !entitySchemas
        || manifest.slug !== internalPackId
        || manifest.author !== ns.publisher
        || manifest.version !== activeVersion
        || canonicalJson(manifestRecords?.schema) !== canonicalJson(schema)
        || canonicalJson(manifestRecords?.executes) !== canonicalJson(operations)) {
        throw new Error(`records_restore_incoherent: ${label} active catalog snapshot is missing or divergent`);
      }

      const inventory = db.prepare(`SELECT value_inline FROM contract_store
        WHERE scope='installed_pack' AND seg_key=?`).get(internalPackId) as {
          value_inline: string;
        } | undefined;
      let inventoryValue: {
        pack_slug?: unknown;
        version?: unknown;
        publisher?: unknown;
        ingredient_ids?: unknown;
      } | undefined;
      try {
        inventoryValue = inventory
          ? JSON.parse(inventory.value_inline) as typeof inventoryValue
          : undefined;
      } catch { /* checked below */ }
      if (!inventoryValue
        || inventoryValue.pack_slug !== internalPackId
        || inventoryValue.version !== String(activeVersion)
        || inventoryValue.publisher !== ns.publisher
        || !Array.isArray(inventoryValue.ingredient_ids)
        || !inventoryValue.ingredient_ids.includes(internalPackId)) {
        throw new Error(`records_restore_incoherent: ${label} active inventory is missing or divergent`);
      }

      const storedRecipes = db.prepare(`SELECT recipe_id,publisher_id,version,recipe_hash,recipe_json
        FROM recipes WHERE pack_slug=? ORDER BY recipe_id`).all(internalPackId) as Array<{
          recipe_id: string;
          publisher_id: string;
          version: number;
          recipe_hash: string;
          recipe_json: string;
        }>;
      const recipeDigests: Record<string, string> = {};
      const subscriberRecipes: Array<{
        recipe: RecipeDefinition;
        publisher_id: string;
        recipe_digest: string;
      }> = [];
      for (const row of storedRecipes) {
        let recipe: RecipeDefinition;
        try {
          recipe = JSON.parse(row.recipe_json) as RecipeDefinition;
        } catch {
          throw new Error(`records_restore_incoherent: ${label} has unreadable recipe '${row.recipe_id}'`);
        }
        const digest = sha256(canonicalJson(recipe));
        if (recipe.recipe_id !== row.recipe_id
          || recipe.version !== row.version
          || row.recipe_hash !== hashRecipe(recipe)
          || row.publisher_id !== ns.publisher
          || recipe.metadata?.recipe_bundle !== label) {
          throw new Error(`records_restore_incoherent: ${label} recipe '${row.recipe_id}' has divergent provenance`);
        }
        recipeDigests[row.recipe_id] = digest;
        subscriberRecipes.push({ recipe, publisher_id: row.publisher_id, recipe_digest: digest });
      }
      const recomputedArtifactDigest = sha256(canonicalJson({
        owner: { publisher: ns.publisher, pack_slug: ns.pack_slug },
        version: activeVersion,
        catalog: manifest,
        schemas: entitySchemas,
        recipes: recipeDigests,
        migration_plans: migrationPlans,
      }));
      if (recomputedArtifactDigest !== ns.artifact_digest) {
        throw new Error(`records_restore_incoherent: ${label} pinned artifact bodies do not match their digest`);
      }

      const grantRows = (db.prepare(`SELECT seg_key,value_inline FROM contract_store
        WHERE scope='grant' ORDER BY seg_key`).all() as Array<{
          seg_key: string;
          value_inline: string;
        }>).map((row) => {
          let value: unknown;
          try { value = JSON.parse(row.value_inline); } catch {
            throw new Error(`records_restore_incoherent: ${label} has unreadable grant truth`);
          }
          return { segments: decodeContractSegments(row.seg_key), value };
        });
      const ownedGrantRows = grantRows.filter((row) => row.segments[0] === internalPackId);
      const declaredGroups = manifest.operation_groups ?? {};
      for (const row of ownedGrantRows) {
        const groupId = row.segments[3];
        if (row.segments.length !== 4
          || row.segments[1] !== internalPackId
          || row.segments[2] !== internalPackId
          || groupId === undefined
          || declaredGroups[groupId] === undefined
          || (row.value as { allowed?: unknown } | null)?.allowed !== true) {
          throw new Error(`records_restore_incoherent: ${label} has divergent operation-group grant truth`);
        }
      }
      const liveGroupIds = ownedGrantRows.map((row) => row.segments[3]!).sort();
      const storedSnapshot = subscribers[0]?.grant_snapshot;
      for (const subscriber of subscribers) {
        if (subscriber.grant_snapshot.installed_pack_id !== internalPackId
          || subscriber.grant_snapshot.ingredient_id !== internalPackId
          || subscriber.grant_snapshot.connection_name !== internalPackId
          || subscriber.grant_snapshot.group_ids.some((groupId) => declaredGroups[groupId] === undefined)
          || (storedSnapshot !== undefined
            && canonicalJson(subscriber.grant_snapshot) !== canonicalJson(storedSnapshot))) {
          throw new Error(`records_restore_incoherent: ${label} has divergent subscriber grant provenance`);
        }
      }
      const expectedSubscribers = deriveRecordsSubscriberBindings(
        { publisher: ns.publisher, pack_slug: ns.pack_slug },
        subscriberRecipes,
        storedSnapshot ?? {
          installed_pack_id: internalPackId,
          ingredient_id: internalPackId,
          connection_name: internalPackId,
          group_ids: liveGroupIds,
        },
      );
      if (expectedSubscribers.digest !== ns.subscriber_digest
        || canonicalJson(expectedSubscribers.bindings) !== canonicalJson(subscribers)) {
        throw new Error(`records_restore_incoherent: ${label} subscriber generation does not match its recipes`);
      }
    }
  }
  const limitFromMeta = (key: string): number => {
    const row = db.prepare(`SELECT value FROM ${META_TABLE} WHERE key=?`).get(key) as { value: string } | undefined;
    if (row === undefined) return Number.MAX_SAFE_INTEGER;
    const value = Number(row.value);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`records_restore_incoherent: invalid global Records quota '${key}'`);
    }
    return value;
  };
  const globalRows = db.prepare(`SELECT count(*) AS rows,coalesce(sum(payload_bytes),0) AS bytes
    FROM ${ROW_TABLE}`).get() as { rows: number; bytes: number };
  const globalOutbox = db.prepare(`SELECT count(*) AS events FROM ${OUTBOX_TABLE}
    WHERE status='pending'`).get() as { events: number };
  const globalReserved = db.prepare(`SELECT coalesce(sum(reserved_byte_delta),0) AS bytes
    FROM ${MIGRATION_TABLE} WHERE status IN ('running','failed')`).get() as { bytes: number };
  if (globalRows.rows > limitFromMeta('records.global.row_limit')
    || globalRows.bytes + globalReserved.bytes > limitFromMeta('records.global.byte_limit')
    || globalOutbox.events > limitFromMeta('records.global.outbox_limit')) {
    throw new Error('records_restore_incoherent: global Records usage/reservations exceed owner policy');
  }
};

export const createRecordsStore = (
  db: Database.Database,
  options: CreateRecordsStoreOptions = {},
): RecordsStore => {
  ensureSchema(db);
  const now = options.now ?? (() => Date.now());
  const createId = options.id ?? (() => `rec_${randomUUID()}`);
  const namespaceKey = (owner: RecordsPackRef): string =>
    JSON.stringify([owner.publisher, owner.pack_slug]);
  const activeLeases = new Map<string, {
    lease_id: string;
    recipe_id: string;
    caller_pack: string;
    targets: ReadonlyMap<string, number>;
  }>();
  const namespaceFences = new Map<string, RecordsNamespaceFence>();
  const quiescenceWaiters = new Map<string, Set<() => void>>();

  const signalQuiescence = (key: string): void => {
    const waiters = quiescenceWaiters.get(key);
    if (!waiters) return;
    quiescenceWaiters.delete(key);
    for (const wake of waiters) wake();
  };

  const namespaceRow = (owner: RecordsPackRef): NamespaceRow | undefined =>
    db.prepare(`SELECT * FROM ${NAMESPACE_TABLE} WHERE publisher=? AND pack_slug=?`)
      .get(owner.publisher, owner.pack_slug) as NamespaceRow | undefined;

  const globalLimit = (key: 'row_limit' | 'byte_limit' | 'outbox_limit'): number => {
    const row = db.prepare(`SELECT value FROM ${META_TABLE} WHERE key=?`)
      .get(`records.global.${key}`) as { value: string } | undefined;
    if (row === undefined) return Number.MAX_SAFE_INTEGER;
    const parsed = Number(row.value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      fail('records_incoherent', `global Records ${key} policy is invalid`);
    }
    return parsed;
  };

  const globalQuota = (): RecordsGlobalQuotaSnapshot => {
    const rows = db.prepare(`SELECT count(*) AS row_count,
      coalesce(sum(payload_bytes),0) AS payload_bytes FROM ${ROW_TABLE}`)
      .get() as { row_count: number; payload_bytes: number };
    const events = db.prepare(`SELECT count(*) AS outbox_count FROM ${OUTBOX_TABLE}
      WHERE status='pending'`).get() as { outbox_count: number };
    const reservations = db.prepare(`SELECT coalesce(sum(reserved_byte_delta),0) AS bytes
      FROM ${MIGRATION_TABLE} WHERE status IN ('running','failed')`)
      .get() as { bytes: number };
    return {
      row_count: rows.row_count,
      payload_bytes: rows.payload_bytes,
      outbox_count: events.outbox_count,
      reserved_payload_bytes: reservations.bytes,
      row_limit: globalLimit('row_limit'),
      byte_limit: globalLimit('byte_limit'),
      outbox_limit: globalLimit('outbox_limit'),
    };
  };

  const summary = (row: NamespaceRow): RecordsNamespaceSummary => ({
    owner: { publisher: row.publisher, pack_slug: row.pack_slug },
    state: stateFromRow(row),
    activation_generation: row.activation_generation,
    state_generation: row.state_generation,
    quota: {
      row_count: row.row_count,
      payload_bytes: row.payload_bytes,
      row_limit: row.row_limit,
      byte_limit: row.byte_limit,
      outbox_count: row.outbox_count,
      outbox_limit: row.outbox_limit,
      data_generation: row.data_generation,
    },
    schema: JSON.parse(row.schema_json) as RecordsSchemaSnapshot,
    artifact_digest: row.artifact_digest,
    subscriber_digest: row.subscriber_digest,
    updated_at: row.updated_at,
  });

  const requireState = (
    binding: RecordsExecutionBinding,
    mutate = false,
  ): { namespace: NamespaceRow; schema: RecordsSchemaSnapshot } => {
    if (!isRecordsExecutionBinding(binding)) fail('records_unauthorized', 'unstamped or forged Records binding');
    const row = requireValue(
      namespaceRow(binding.owner),
      'records_incoherent',
      'Records rows/capability have no namespace authority',
    );
    if (row.state === 'migrating') fail('records_not_ready', 'Records namespace is migrating', undefined, true);
    if (row.state === 'orphaned') fail('records_not_ready', 'Records namespace is orphaned');
    if (row.state !== 'ready') fail('records_incoherent', row.reason ?? 'Records namespace is incoherent');
    if (
      row.version !== binding.pack_version
      || row.storage_schema_hash !== binding.storage_schema_hash
      || row.declaration_hash !== binding.declaration_hash
    ) {
      fail('records_stale_operation', 'Records operation does not match the ready activation', {
        ready_version: row.version,
        operation_version: binding.pack_version,
      });
    }
    const installed = JSON.parse(row.operations_json) as Record<string, RecordsExecutionBinding>;
    const exact = Object.values(installed).find((candidate) => candidate.operation_digest === binding.operation_digest);
    // ⛔⛔ THE ONE ADMITTED DIVERGENCE FROM AN EXACT MATCH: an op INSIDE a batch.
    //
    // A batch re-enters `execute` per op with the entity and action swapped to
    // the pair being written, and that binding was never installed — correctly,
    // because installing it would make each inner write callable on its own by
    // anyone holding the digest, which is a wider grant than the batch. So the
    // divergence is admitted here instead, and narrowly:
    //
    //   - the installed op must BE a batch, and
    //   - the pair must be in the allow-list it was installed with, and
    //   - ⛔ EVERYTHING ELSE must be byte-identical to the installed binding.
    //
    // That last clause is what stops this being an escape hatch: a caller
    // cannot ride it to change the owner, the hashes, the allow-list or a
    // `select`, because the reconstructed binding is compared whole.
    const admittedInBatch = exact !== undefined
      && exact.action === 'batch'
      && Array.isArray(exact.allow)
      && (exact.allow as RecordsBatchAllow[]).some(
        (pair) => pair.entity === binding.entity && pair.action === binding.action)
      && canonicalJson({ ...binding, entity: exact.entity, action: exact.action })
        === canonicalJson(exact);
    if (!exact || (canonicalJson(exact) !== canonicalJson(binding) && !admittedInBatch)) {
      fail('records_stale_operation', 'Records operation digest/binding is not installed');
    }
    if (mutate && row.row_count < 0) fail('records_incoherent', 'negative Records accounting');
    return { namespace: row, schema: JSON.parse(row.schema_json) as RecordsSchemaSnapshot };
  };

  const blockersFor = (
    owner: RecordsPackRef,
    activationGeneration: number,
  ): RecordsNamespaceLeaseBlocker[] => {
    const key = namespaceKey(owner);
    return [...activeLeases.values()]
      .filter((lease) => lease.targets.get(key) === activationGeneration)
      .map(({ lease_id, recipe_id, caller_pack }) => ({ lease_id, recipe_id, caller_pack }))
      .sort((a, b) => a.lease_id.localeCompare(b.lease_id));
  };

  const assertExecutionAdmitted = (call: RecordsExecutionCall): void => {
    const key = namespaceKey(call.binding.owner);
    const fence = namespaceFences.get(key);
    if (!fence) return;
    const lease = call.execution_lease_id === undefined
      ? undefined
      : activeLeases.get(call.execution_lease_id);
    if (!lease || lease.targets.get(key) !== fence.activation_generation) {
      fail(
        'records_not_ready',
        'Records namespace is fenced for update or uninstall',
        { owner: call.binding.owner },
        true,
      );
    }
  };

  const assertOwnerMutationNotFenced = (owner: RecordsPackRef): void => {
    if (namespaceFences.has(namespaceKey(owner))) {
      fail('records_not_ready', 'Records namespace is fenced for update or uninstall', undefined, true);
    }
  };

  const entityFor = (schema: RecordsSchemaSnapshot, kind: string) => {
    const entity = schema.entities[kind];
    if (!entity) fail('records_invalid', `entity '${kind}' is not installed`);
    return entity!;
  };

  const rowStmt = (owner: RecordsPackRef, kind: string, id: string): RowShape | undefined => {
    const stmt = db.prepare(`SELECT * FROM ${ROW_TABLE} WHERE publisher=? AND pack_slug=? AND kind=? AND pk=?`);
    stmt.safeIntegers(true);
    return stmt.get(owner.publisher, owner.pack_slug, kind, id) as RowShape | undefined;
  };

  const safeNumber = (value: number | bigint, label: string): number => {
    const number = typeof value === 'bigint' ? Number(value) : value;
    if (!Number.isSafeInteger(number)) fail('records_incoherent', `${label} is outside JS safe integer range`);
    return number;
  };

  const projectRow = (row: RowShape, schema: RecordsSchemaSnapshot): RecordsFriendlyRecord => {
    const entity = entityFor(schema, row.kind);
    const record: Record<string, unknown> = { id: row.pk };
    for (const field of entity.fields) {
      if (field.kind === 'id') continue;
      setPath(record, field.key, wireValue(field, row[field.slot as RecordsSlot]));
    }
    record._record = {
      entity: row.kind,
      version: safeNumber(row.version, 'row version'),
      revision: safeNumber(row.revision, 'row revision'),
      created_at: safeNumber(row.created_at, 'created_at'),
      updated_at: safeNumber(row.updated_at, 'updated_at'),
    };
    return record as RecordsFriendlyRecord;
  };

  const normalizeValues = (
    schema: RecordsSchemaSnapshot,
    kind: string,
    input: unknown,
    mode: 'full' | 'partial',
  ): { physical: PhysicalFields; present: Set<string> } => {
    assertJsonTree(input, '$.values');
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      fail('records_invalid', 'values/set must be a plain object');
    }
    const values = input as Record<string, unknown>;
    if (Object.hasOwn(values, 'id') || Object.hasOwn(values, '_record')) {
      fail('records_invalid', 'id and _record are protected');
    }
    const entity = entityFor(schema, kind);
    const writable = entity.fields.filter((field) => field.kind !== 'id');
    const known = new Set(writable.map((field) => field.key));
    for (const path of leafPaths(values)) {
      if (!known.has(path)) fail('records_invalid', `unknown friendly field '${path}'`);
    }
    const physical = emptyPhysical();
    const present = new Set<string>();
    for (const field of writable) {
      const found = pathValue(values, field.key);
      if (found.present) present.add(field.key);
      if (mode === 'full' && field.required && (!found.present || found.value === null || found.value === undefined)) {
        fail('records_invalid', `required field '${field.key}' is missing/null`);
      }
      physical[field.slot as RecordsSlot] = found.present ? normalizeField(field, found.value) : null;
    }
    return { physical, present };
  };

  const validateReferences = (
    owner: RecordsPackRef,
    kind: string,
    id: string,
    physical: PhysicalFields,
  ): void => {
    for (const slot of SLOT_NAMES.filter((name) => name.startsWith('r'))) {
      const value = physical[slot];
      if (value === null) continue;
      const ref = canonicalRef(value);
      if (ref.kind === kind && ref.id === id) continue;
      if (!rowStmt(owner, ref.kind, ref.id)) {
        fail('records_invalid', `reference '${ref.encoded}' does not target an existing row in this pack`);
      }
    }
  };

  const replaceReverseRefs = (
    owner: RecordsPackRef,
    kind: string,
    id: string,
    physical: PhysicalFields,
  ): void => {
    db.prepare(`DELETE FROM ${REVERSE_TABLE} WHERE publisher=? AND pack_slug=? AND source_kind=? AND source_pk=?`)
      .run(owner.publisher, owner.pack_slug, kind, id);
    const insert = db.prepare(`INSERT INTO ${REVERSE_TABLE}
      (publisher,pack_slug,source_kind,source_pk,source_slot,target_kind,target_pk)
      VALUES (?,?,?,?,?,?,?)`);
    for (const slot of SLOT_NAMES.filter((name) => name.startsWith('r'))) {
      const value = physical[slot];
      if (value === null) continue;
      const ref = canonicalRef(value);
      insert.run(owner.publisher, owner.pack_slug, kind, id, slot, ref.kind, ref.id);
    }
  };

  const reserveMutation = (ns: NamespaceRow, rowDelta: number, byteDelta: number, emits: boolean): void => {
    if (ns.row_count + rowDelta > ns.row_limit || ns.payload_bytes + byteDelta > ns.byte_limit) {
      fail('records_quota_exceeded', 'Records namespace quota would be exceeded', {
        rows: ns.row_count,
        row_limit: ns.row_limit,
        payload_bytes: ns.payload_bytes,
        byte_limit: ns.byte_limit,
        requested_row_delta: rowDelta,
        requested_byte_delta: byteDelta,
      });
    }
    if (emits && ns.outbox_count + 1 > ns.outbox_limit) {
      fail('records_backpressure', 'Records outbox quota would be exceeded');
    }
    const global = globalQuota();
    if (global.row_count + rowDelta > global.row_limit
      || global.payload_bytes + global.reserved_payload_bytes + byteDelta > global.byte_limit) {
      fail('records_quota_exceeded', 'global Records quota would be exceeded', {
        rows: global.row_count,
        row_limit: global.row_limit,
        payload_bytes: global.payload_bytes,
        byte_limit: global.byte_limit,
        requested_row_delta: rowDelta,
        requested_byte_delta: byteDelta,
      });
    }
    if (emits && global.outbox_count + 1 > global.outbox_limit) {
      fail('records_backpressure', 'global Records outbox quota would be exceeded');
    }
  };

  const updateAccounting = (
    owner: RecordsPackRef,
    rowDelta: number,
    byteDelta: number,
    eventDelta: number,
    stamp: number,
  ): void => {
    const changed = db.prepare(`UPDATE ${NAMESPACE_TABLE}
      SET row_count=row_count+?, payload_bytes=payload_bytes+?, outbox_count=outbox_count+?,
          data_generation=data_generation+1, updated_at=?
      WHERE publisher=? AND pack_slug=?
        AND row_count+? >= 0 AND payload_bytes+? >= 0 AND outbox_count+? >= 0`)
      .run(rowDelta, byteDelta, eventDelta, stamp, owner.publisher, owner.pack_slug, rowDelta, byteDelta, eventDelta);
    if (changed.changes !== 1) fail('records_incoherent', 'Records accounting update failed');
  };

  const decrementOutboxAccounting = (owner: RecordsPackRef, stamp: number): void => {
    const changed = db.prepare(`UPDATE ${NAMESPACE_TABLE}
      SET outbox_count=outbox_count-1,updated_at=?
      WHERE publisher=? AND pack_slug=? AND outbox_count>0`)
      .run(stamp, owner.publisher, owner.pack_slug);
    if (changed.changes !== 1) {
      fail('records_incoherent', 'Records outbox accounting decrement failed');
    }
  };

  const enqueue = (
    ns: NamespaceRow,
    kind: string,
    id: string,
    revision: number,
    type: RecordsEventPointer['type'],
    changedFields: string[],
    cause: RecordsMutationCause,
    execution: Pick<RecordsExecutionCall, 'root_event_id' | 'causal_depth' | 'watcher_digest'>,
    stamp: number,
  ): boolean => {
    if (SUPPRESSED_CAUSES.has(cause)) return false;
    const depth = execution.causal_depth ?? 0;
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > RECORDS_MAX_CAUSAL_DEPTH) {
      fail('records_invalid', 'record watcher causal depth is invalid/exhausted');
    }
    const eventId = randomUUID();
    const rootEventId = execution.root_event_id ?? eventId;
    if (execution.root_event_id !== undefined
      && !db.prepare(`SELECT 1 FROM ${OUTBOX_TABLE} WHERE event_id=? OR root_event_id=? LIMIT 1`)
        .get(rootEventId, rootEventId)) {
      fail('records_invalid', 'record watcher root event is forged or expired');
    }
    if (execution.root_event_id !== undefined) {
      const fanout = db.prepare(`SELECT count(*) AS n FROM ${OUTBOX_TABLE} WHERE root_event_id=?`)
        .get(rootEventId) as { n: number };
      if (fanout.n >= RECORDS_MAX_CAUSAL_FANOUT) {
        fail('records_backpressure', 'record watcher causal fan-out budget is exhausted');
      }
    }
    db.prepare(`INSERT INTO ${OUTBOX_TABLE}
      (event_id,publisher,pack_slug,kind,pk,event_type,event_revision,changed_fields_json,
       activation_generation,subscriber_digest,cause,root_event_id,causal_depth,watcher_digest,
       status,retry_count,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending',0,?)`)
      .run(
        eventId, ns.publisher, ns.pack_slug, kind, id, type, revision,
        JSON.stringify([...changedFields].sort()), ns.activation_generation,
        ns.subscriber_digest, cause, rootEventId, depth, execution.watcher_digest ?? null, stamp,
      );
    const pointer: RecordsEventPointer = {
      event_id: eventId,
      type,
      owner: { publisher: ns.publisher, pack_slug: ns.pack_slug },
      entity: kind,
      id,
      revision,
      changed_fields: [...changedFields].sort(),
      activation_generation: ns.activation_generation,
      subscriber_digest: ns.subscriber_digest,
      cause,
      created_at: stamp,
    };
    const subscribers = JSON.parse(ns.subscribers_json) as RecordsSubscriberBinding[];
    const insertDelivery = db.prepare(`INSERT INTO ${OUTBOX_DELIVERY_TABLE}
      (event_id,binding_digest,recipe_id,recipe_digest,trigger_digest,subscriber_json,status,retry_count)
      VALUES (?,?,?,?,?,?, 'pending',0)`);
    for (const subscriber of subscribers) {
      if (!recordsSubscriberMatches(subscriber, pointer)) continue;
      insertDelivery.run(
        eventId, subscriber.binding_digest, subscriber.recipe_id,
        subscriber.recipe_digest, subscriber.trigger_digest, canonicalJson(subscriber),
      );
    }
    return true;
  };

  const physicalFromRow = (row: RowShape): PhysicalFields => Object.fromEntries(
    SLOT_NAMES.map((slot) => {
      const value = row[slot];
      return [slot, typeof value === 'bigint' && !slot.startsWith('dec') ? Number(value) : value];
    }),
  ) as PhysicalFields;

  const assertRowCoherent = (ns: NamespaceRow, row: RowShape): void => {
    const version = safeNumber(row.version, 'row version');
    if (version !== ns.version) {
      db.prepare(`UPDATE ${NAMESPACE_TABLE}
        SET state='incoherent',last_known_state='ready',detected_at=?,reason=?,state_generation=state_generation+1,updated_at=?
        WHERE publisher=? AND pack_slug=? AND state='ready'`)
        .run(now(), `row ${row.kind}/${row.pk} has version ${version}, ready is ${ns.version}`, now(), ns.publisher, ns.pack_slug);
      fail('records_incoherent', 'row version disagrees with ready namespace');
    }
  };

  const naturalId = (binding: RecordsExecutionBinding, schema: RecordsSchemaSnapshot, values: unknown): string => {
    const entity = entityFor(schema, binding.entity);
    const byKey = new Map(entity.fields.map((field) => [field.key, field]));
    const source = values as Record<string, unknown>;
    const tuple = binding.natural_key!.map((key) => {
      const field = byKey.get(key)!;
      const found = pathValue(source, key);
      if (!found.present || found.value === null) fail('records_invalid', `natural_key field '${key}' is required`);
      const normalized = normalizeField(field, found.value);
      return typeof normalized === 'bigint' ? normalized.toString() : normalized;
    });
    return `nk_${sha256(canonicalJson([binding.entity, ...tuple]))}`;
  };

  const immutableFields = (ns: NamespaceRow, entity: string): Set<string> => {
    const binds = Object.values(JSON.parse(ns.operations_json) as Record<string, RecordsExecutionBinding>);
    return new Set(binds
      .filter((bind) => bind.entity === entity && bind.action === 'create')
      .flatMap((bind) => bind.natural_key ?? []));
  };

  /** D-221 §6.2 — the ENTITY's natural key, read from the installed operation
   *  inventory rather than from whichever bind the caller dispatched.
   *
   *  `natural_key` is admissible only on `create` (authoring §5.2), so keying
   *  the derivation off `call.binding.natural_key` alone leaves every SIBLING
   *  bind on the same entity — a second unkeyed `create`, or an `upsert` —
   *  free to seat a row at a caller-chosen id holding an already-taken tuple.
   *  Uniqueness has to be a property of the entity, not of the dispatch. */
  const declaredNaturalKey = (ns: NamespaceRow, entity: string): string[] | undefined => {
    const binds = Object.values(JSON.parse(ns.operations_json) as Record<string, RecordsExecutionBinding>);
    for (const bind of binds) {
      if (bind.entity === entity && bind.action === 'create' && bind.natural_key !== undefined) {
        return bind.natural_key;
      }
    }
    return undefined;
  };

  const entityNaturalKeys = (owner: RecordsPackRef): Record<string, string[]> => {
    assertPackRef(owner);
    const ns = namespaceRow(owner);
    if (!ns) return {};
    const out: Record<string, string[]> = {};
    const schema = JSON.parse(ns.schema_json) as RecordsSchemaSnapshot;
    for (const entity of Object.keys(schema.entities ?? {})) {
      const key = declaredNaturalKey(ns, entity);
      if (key !== undefined) out[entity] = [...key].sort();
    }
    return out;
  };

  const insertRow = (
    owner: RecordsPackRef,
    kind: string,
    id: string,
    version: number,
    principal: string,
    physical: PhysicalFields,
    payload: number,
    stamp: number,
  ): void => {
    const columns = SLOT_NAMES.join(',');
    const placeholders = SLOT_NAMES.map(() => '?').join(',');
    db.prepare(`INSERT INTO ${ROW_TABLE}
      (publisher,pack_slug,kind,pk,version,revision,created_at,updated_at,created_by,updated_by,payload_bytes,${columns})
      VALUES (?,?,?,?,?,0,?,?,?,?,?,${placeholders})`)
      .run(
        owner.publisher, owner.pack_slug, kind, id, version, stamp, stamp, principal, principal, payload,
        ...SLOT_NAMES.map((slot) => physical[slot]),
      );
  };

  const createRecord = (
    call: RecordsExecutionCall,
    ns: NamespaceRow,
    schema: RecordsSchemaSnapshot,
  ): { record: RecordsFriendlyRecord; replayed: boolean } => {
    const values = call.args.values;
    const normalized = normalizeValues(schema, call.binding.entity, values, 'full');
    // Derive from the ENTITY key, not this bind's. A sibling unkeyed `create`
    // (or the `upsert` insert branch, which lands here) must not be able to
    // supply its own id for a tuple the entity says is unique.
    const entityNaturalKey = declaredNaturalKey(ns, call.binding.entity);
    if (entityNaturalKey !== undefined
      && call.binding.natural_key !== undefined
      && canonicalJson(call.binding.natural_key) !== canonicalJson(entityNaturalKey)) {
      fail('records_invalid', `natural_key on '${call.binding.entity}' disagrees with the installed entity key`);
    }
    const id = entityNaturalKey !== undefined
      ? (() => {
          if (call.args.id !== undefined) fail('records_invalid', 'id is forbidden on a natural_key entity');
          return naturalId({ ...call.binding, natural_key: entityNaturalKey }, schema, values);
        })()
      : call.args.id === undefined ? assertId(createId()) : assertId(call.args.id);
    const payload = logicalPayloadBytes(id, normalized.physical);
    const cause = call.cause ?? 'recipe';
    const emits = !SUPPRESSED_CAUSES.has(cause);
    const tx = db.transaction(() => {
      const currentNs = namespaceRow(call.binding.owner)!;
      requireState(call.binding, true);
      const existing = rowStmt(call.binding.owner, call.binding.entity, id);
      if (existing) {
        assertRowCoherent(currentNs, existing);
        const current = physicalFromRow(existing);
        if (SLOT_NAMES.every((slot) => Object.is(current[slot], normalized.physical[slot]))) {
          return { row: existing, replayed: true };
        }
        fail('records_conflict', `record '${id}' already exists with different/currently edited values`, {
          version: safeNumber(existing.version, 'version'),
          revision: safeNumber(existing.revision, 'revision'),
        });
      }
      reserveMutation(currentNs, 1, payload, emits);
      validateReferences(call.binding.owner, call.binding.entity, id, normalized.physical);
      const stamp = now();
      insertRow(call.binding.owner, call.binding.entity, id, call.binding.pack_version, call.principal, normalized.physical, payload, stamp);
      replaceReverseRefs(call.binding.owner, call.binding.entity, id, normalized.physical);
      const event = enqueue(currentNs, call.binding.entity, id, 0, 'record.created', [...normalized.present], cause, call, stamp);
      updateAccounting(call.binding.owner, 1, payload, event ? 1 : 0, stamp);
      return { row: rowStmt(call.binding.owner, call.binding.entity, id)!, replayed: false };
    })();
    return { record: projectRow(tx.row, schema), replayed: tx.replayed };
  };

  const updateRecord = (
    call: RecordsExecutionCall,
    ns: NamespaceRow,
    schema: RecordsSchemaSnapshot,
  ): { record: RecordsFriendlyRecord } => {
    const id = assertId(call.args.id);
    const expectedVersion = assertSafePositive(call.args.expected_version, 'expected_version');
    const expectedRevision = assertSafeNonNegative(call.args.expected_revision, 'expected_revision');
    const setInput = call.args.set ?? {};
    const unsetInput = call.args.unset ?? [];
    const set = normalizeValues(schema, call.binding.entity, setInput, 'partial');
    if (!Array.isArray(unsetInput) || unsetInput.some((value) => typeof value !== 'string')
      || new Set(unsetInput).size !== unsetInput.length) {
      fail('records_invalid', 'unset must be a unique array of friendly field names');
    }
    const unset = unsetInput as string[];
    for (const key of unset) {
      if (set.present.has(key)) fail('records_invalid', `field '${key}' appears in both set and unset`);
    }
    const entity = entityFor(schema, call.binding.entity);
    const fieldByKey = new Map(entity.fields.map((field) => [field.key, field]));
    const immutable = immutableFields(ns, call.binding.entity);
    for (const key of [...set.present, ...unset]) {
      const field = fieldByKey.get(key);
      if (!field || field.kind === 'id') fail('records_invalid', `field '${key}' is unknown/protected`);
      if (immutable.has(key)) fail('records_invalid', `natural_key field '${key}' is immutable`);
      if (unset.includes(key) && field!.required) fail('records_invalid', `required field '${key}' cannot be unset`);
    }
    const cause = call.cause ?? 'recipe';
    const tx = db.transaction(() => {
      const currentNs = namespaceRow(call.binding.owner)!;
      requireState(call.binding, true);
      const current = requireValue(
        rowStmt(call.binding.owner, call.binding.entity, id),
        'records_not_found',
        `record '${id}' was not found`,
      );
      assertRowCoherent(currentNs, current);
      const revision = safeNumber(current.revision, 'revision');
      const version = safeNumber(current.version, 'version');
      if (version !== expectedVersion || revision !== expectedRevision || expectedVersion !== currentNs.version) {
        fail('records_conflict', 'stale Records version/revision', { current_version: version, current_revision: revision });
      }
      // ⛔ Compare the PREIMAGE, never the raw row. The row statements set
      // `safeIntegers(true)`, so every INTEGER column arrives as a `bigint` while
      // `next` holds normalized values — `Object.is(1785000000000n, 1785000000000)`
      // is false, so an INTEGER-backed slot always read as changed. That silently
      // defeated the no-op refusal for exactly `b*` and `dt*` (`n*` is REAL and
      // `dec*` stays a bigint on both sides, so neither was affected): a re-issued
      // identical update bumped `revision` and emitted `record.updated` with
      // `changed_fields` naming fields that had not changed. Every sibling
      // comparison in this file — the create replay check and both migration
      // paths — already normalizes first; this one did not.
      const preimage = physicalFromRow(current);
      const next = { ...preimage };
      for (const key of set.present) {
        const field = fieldByKey.get(key)!;
        next[field.slot as RecordsSlot] = set.physical[field.slot as RecordsSlot];
      }
      for (const key of unset) {
        const field = fieldByKey.get(key)!;
        next[field.slot as RecordsSlot] = null;
      }
      const changed = [...new Set([...set.present, ...unset])].filter((key) => {
        const field = fieldByKey.get(key)!;
        return !Object.is(preimage[field.slot as RecordsSlot], next[field.slot as RecordsSlot]);
      });
      if (changed.length === 0) fail('records_noop', 'update has no effective change');
      const payload = logicalPayloadBytes(id, next);
      const delta = payload - safeNumber(current.payload_bytes, 'payload_bytes');
      const emits = !SUPPRESSED_CAUSES.has(cause);
      reserveMutation(currentNs, 0, delta, emits);
      validateReferences(call.binding.owner, call.binding.entity, id, next);
      const stamp = now();
      const assignments = SLOT_NAMES.map((slot) => `${slot}=?`).join(',');
      const result = db.prepare(`UPDATE ${ROW_TABLE} SET ${assignments},revision=revision+1,
        updated_at=?,updated_by=?,payload_bytes=?
        WHERE publisher=? AND pack_slug=? AND kind=? AND pk=? AND version=? AND revision=?`)
        .run(
          ...SLOT_NAMES.map((slot) => next[slot]), stamp, call.principal, payload,
          call.binding.owner.publisher, call.binding.owner.pack_slug, call.binding.entity, id,
          expectedVersion, expectedRevision,
        );
      if (result.changes !== 1) fail('records_conflict', 'concurrent Records update lost CAS');
      replaceReverseRefs(call.binding.owner, call.binding.entity, id, next);
      const event = enqueue(currentNs, call.binding.entity, id, revision + 1, 'record.updated', changed, cause, call, stamp);
      updateAccounting(call.binding.owner, 0, delta, event ? 1 : 0, stamp);
      return rowStmt(call.binding.owner, call.binding.entity, id)!;
    })();
    return { record: projectRow(tx, schema) };
  };

  const deleteRecord = (
    call: RecordsExecutionCall,
    schema: RecordsSchemaSnapshot,
    ownerControl = false,
  ): { deleted: true; id: string; revision: number } => {
    const id = assertId(call.args.id);
    const expectedVersion = assertSafePositive(call.args.expected_version, 'expected_version');
    const expectedRevision = assertSafeNonNegative(call.args.expected_revision, 'expected_revision');
    const cause = call.cause ?? 'recipe';
    return db.transaction(() => {
      const currentNs = namespaceRow(call.binding.owner)!;
      if (ownerControl) {
        if (currentNs?.state !== 'ready') {
          fail('records_not_ready', `owner delete requires a ready namespace`);
        }
        if (
          currentNs.version !== call.binding.pack_version
          || currentNs.storage_schema_hash !== call.binding.storage_schema_hash
          || currentNs.declaration_hash !== call.binding.declaration_hash
        ) {
          fail('records_conflict', 'namespace activation changed before owner delete');
        }
        entityFor(schema, call.binding.entity);
      } else {
        requireState(call.binding, true);
      }
      const current = requireValue(
        rowStmt(call.binding.owner, call.binding.entity, id),
        'records_not_found',
        `record '${id}' was not found`,
      );
      assertRowCoherent(currentNs, current);
      const version = safeNumber(current.version, 'version');
      const revision = safeNumber(current.revision, 'revision');
      if (version !== expectedVersion || revision !== expectedRevision || expectedVersion !== currentNs.version) {
        fail('records_conflict', 'stale Records version/revision', { current_version: version, current_revision: revision });
      }
      const blockers = db.prepare(`SELECT source_kind,source_pk,source_slot FROM ${REVERSE_TABLE}
        WHERE publisher=? AND pack_slug=? AND target_kind=? AND target_pk=? LIMIT 21`)
        .all(call.binding.owner.publisher, call.binding.owner.pack_slug, call.binding.entity, id) as Array<Record<string, string>>;
      if (blockers.length > 0) {
        fail('records_relationship_restrict', 'record has inbound references', { blockers: blockers.slice(0, 20) });
      }
      const emits = !SUPPRESSED_CAUSES.has(cause);
      reserveMutation(currentNs, -1, -safeNumber(current.payload_bytes, 'payload_bytes'), emits);
      const stamp = now();
      const deleted = db.prepare(`DELETE FROM ${ROW_TABLE}
        WHERE publisher=? AND pack_slug=? AND kind=? AND pk=? AND version=? AND revision=?`)
        .run(call.binding.owner.publisher, call.binding.owner.pack_slug, call.binding.entity, id, expectedVersion, expectedRevision);
      if (deleted.changes !== 1) fail('records_conflict', 'concurrent Records delete lost CAS');
      const event = enqueue(currentNs, call.binding.entity, id, revision + 1, 'record.deleted', [], cause, call, stamp);
      updateAccounting(call.binding.owner, -1, -safeNumber(current.payload_bytes, 'payload_bytes'), event ? 1 : 0, stamp);
      return { deleted: true as const, id, revision: revision + 1 };
    })();
  };

  const filterList = (
    input: unknown,
    binding: Pick<RecordsExecutionBinding, 'filter_fields'>,
    schema: RecordsSchemaSnapshot,
    entityName: string,
    ownerMode = false,
  ): RecordsFilter[] => {
    if (input === undefined) return [];
    assertJsonTree(input, '$.filters');
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('records_invalid', 'filters must be an object');
    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length > RECORDS_MAX_PREDICATES) fail('records_invalid', `at most ${RECORDS_MAX_PREDICATES} predicates are admitted`);
    const admitted = new Set(binding.filter_fields ?? []);
    const entity = entityFor(schema, entityName);
    const byKey = new Map(entity.fields.map((field) => [field.key, field]));
    return entries.map(([fieldName, raw]): RecordsFilter => {
      const field = byKey.get(fieldName);
      if (!field || field.kind === 'id' || (!ownerMode && !admitted.has(fieldName))) {
        fail('records_invalid', `filter field '${fieldName}' is not admitted`);
      }
      const admittedField = field!;
      const descriptor = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : { op: 'eq', value: raw };
      const op = descriptor.op;
      if (typeof op !== 'string' || !['eq','ne','lt','lte','gt','gte','in','prefix','is_null'].includes(op)) {
        fail('records_invalid', `predicate '${String(op)}' is not admitted`);
      }
      if (Object.keys(descriptor).some((key) => key !== 'op' && key !== 'value')) {
        fail('records_invalid', `filter '${fieldName}' has unknown keys`);
      }
      if (op === 'is_null') {
        if (descriptor.value !== undefined && typeof descriptor.value !== 'boolean') fail('records_invalid', 'is_null value must be boolean/omitted');
        return { field: fieldName, op: 'is_null', value: descriptor.value ?? true };
      }
      const predicate = op as RecordsFilter['op'];
      if (admittedField.kind === 'text') fail('records_invalid', `long-text field '${fieldName}' admits only is_null`);
      if (predicate === 'prefix' && admittedField.kind !== 'string') fail('records_invalid', 'prefix is admitted only on indexed strings');
      if (['lt','lte','gt','gte'].includes(predicate) && !['number','decimal','date','datetime'].includes(admittedField.kind)) {
        fail('records_invalid', `range predicate is not admitted on ${admittedField.kind}`);
      }
      if (predicate === 'in') {
        if (!Array.isArray(descriptor.value) || descriptor.value.length === 0 || descriptor.value.length > RECORDS_MAX_IN_ITEMS) {
          fail('records_invalid', `in requires 1..${RECORDS_MAX_IN_ITEMS} items`);
        }
        const values = descriptor.value as unknown[];
        return { field: fieldName, op: 'in', value: values.map((entry: unknown) => normalizeField(admittedField, entry)) };
      }
      return { field: fieldName, op: predicate, value: normalizeField(admittedField, descriptor.value) };
    });
  };

  const filterCanonical = (filters: RecordsFilter[]): string => canonicalJson(filters.map((filter) => ({
    ...filter,
    value: Array.isArray(filter.value)
      ? filter.value.map((value) => typeof value === 'bigint' ? value.toString() : value)
      : typeof filter.value === 'bigint' ? filter.value.toString() : filter.value,
  })).sort((a, b) => a.field.localeCompare(b.field)));

  const sqlFilters = (
    filters: RecordsFilter[],
    schema: RecordsSchemaSnapshot,
    kind: string,
  ): { sql: string; params: PhysicalValue[] } => {
    const byKey = new Map(entityFor(schema, kind).fields.map((field) => [field.key, field]));
    const parts: string[] = [];
    const params: PhysicalValue[] = [];
    for (const filter of filters) {
      const field = byKey.get(filter.field)!;
      const slot = field.slot;
      if (!SLOT_SET.has(slot)) fail('records_invalid', 'protected/raw slot filter refused');
      if (filter.op === 'is_null') {
        parts.push(`${slot} IS ${filter.value === false ? 'NOT ' : ''}NULL`);
      } else if (filter.op === 'in') {
        const values = filter.value as PhysicalValue[];
        parts.push(`${slot} IN (${values.map(() => '?').join(',')})`);
        params.push(...values);
      } else if (filter.op === 'prefix') {
        // Binary range avoids LIKE's wildcard/collation ambiguity.
        const prefix = filter.value as string;
        // ⛔ `prefix + U+10FFFF` is NOT an upper bound: it is itself a string
        // with that prefix, and anything continuing past it (`x` + U+10FFFF +
        // "tail") sorts ABOVE it while still satisfying `startsWith(prefix)`.
        // Verified — such a row stored fine and matched neither search nor
        // count. The true exclusive bound is the lexicographic successor:
        // increment the last code point that can be incremented, dropping any
        // U+10FFFF suffix. A prefix that is entirely U+10FFFF has no successor,
        // so it takes the lower bound alone.
        const successor = lexicographicSuccessor(prefix);
        if (successor === null) {
          parts.push(`${slot} >= ? COLLATE BINARY`);
          params.push(prefix);
        } else {
          parts.push(`(${slot} >= ? COLLATE BINARY AND ${slot} < ? COLLATE BINARY)`);
          params.push(prefix, successor);
        }
      } else {
        const sqlOp = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' }[filter.op];
        parts.push(`${slot} ${sqlOp} ?`);
        params.push(filter.value as PhysicalValue);
      }
    }
    return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
  };

  const assertQueryPlanWithinBudget = (
    sql: string,
    params: readonly PhysicalValue[],
    ns: NamespaceRow,
    label: 'search' | 'count' | 'aggregate',
  ): void => {
    // Candidate cardinality caps the result side below. This preflight closes
    // the other half of the budget: a sparse-index miss (notably `is_null:true`
    // or an unfiltered browse) must not inspect an arbitrarily large namespace
    // merely because it happens to return few rows.
    if (ns.row_count <= RECORDS_MAX_QUERY_ROWS) return;
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>;
    const usesFixedSparseIndex = plan.some((entry) =>
      /USING (?:COVERING )?INDEX core_records_(?:n|dec|s|d|dt|b|r)\d+_idx/i.test(entry.detail));
    if (!usesFixedSparseIndex) {
      fail(
        'records_query_budget',
        `${label} would scan more than the ${RECORDS_MAX_QUERY_ROWS}-row namespace budget`,
        { namespace_rows: ns.row_count, plan: plan.map((entry) => entry.detail).slice(0, 8) },
      );
    }
  };

  const fixedQueryDriver = (
    filters: readonly RecordsFilter[],
    schema: RecordsSchemaSnapshot,
    kind: string,
  ): { filter: RecordsFilter; field: RecordsFieldSnapshot } | undefined => {
    const fields = new Map(entityFor(schema, kind).fields.map((field) => [field.key, field]));
    const ranked = filters
      // `ne` is not a bounded index range: SQLite may walk a million equal
      // entries before producing a small number of non-equal candidates. A
      // LIMIT therefore bounds results, not examined index entries. It can be
      // applied as a secondary predicate after another safe driver, but must
      // never be the large-namespace driver itself.
      .filter((filter) => filter.op !== 'ne'
        && (filter.op !== 'is_null' || filter.value === false))
      .map((filter) => ({
        filter,
        field: fields.get(filter.field),
        rank: filter.op === 'eq' || filter.op === 'in' ? 0
          : filter.op === 'prefix' || ['lt', 'lte', 'gt', 'gte'].includes(filter.op) ? 1
            : 2,
      }))
      .filter((entry): entry is typeof entry & { field: RecordsFieldSnapshot } =>
        entry.field !== undefined && INDEXED_SLOTS.includes(entry.field.slot as RecordsSlot))
      .sort((left, right) => left.rank - right.rank || left.filter.field.localeCompare(right.filter.field));
    const selected = ranked[0];
    return selected === undefined
      ? undefined
      : { filter: selected.filter, field: selected.field };
  };

  /** The SELECT list a scan needs, and nothing else.
   *
   *  ⛔ `SELECT *` here is a memory bound, not a style question. A row may carry
   *  2 MiB (`RECORDS_MAX_ROW_BYTES`) and the work ceiling is 100,000 rows
   *  (`RECORDS_MAX_QUERY_ROWS`), so hydrating every candidate to select a
   *  200-row page — or to return a single integer — puts the whole candidate set
   *  in memory at once. The quota that used to make that survivable is
   *  owner-settable to any safe integer, so raising it turned an ordinary broad
   *  `search`/`count` into something that can exhaust the process.
   *
   *  A scan only ever reads: `pk` (identity + sort tie-break), the two
   *  `_record` timestamps it may sort on, the slots its filters name, and the
   *  slot it sorts by. `t*` is the expensive family (1 MiB each) and only
   *  `is_null` can reach it, so a text slot is projected as a NULL-PRESERVING
   *  sentinel — null-ness is the only fact any admitted text predicate needs. */
  const scanColumns = (
    filters: readonly RecordsFilter[],
    schema: RecordsSchemaSnapshot,
    kind: string,
    sortSlot?: string,
  ): string => {
    const fields = new Map(entityFor(schema, kind).fields.map((field) => [field.key, field]));
    const slots = new Set<string>();
    for (const filter of filters) {
      const slot = fields.get(filter.field)?.slot;
      if (slot !== undefined && SLOT_SET.has(slot)) slots.add(slot);
    }
    if (sortSlot !== undefined && SLOT_SET.has(sortSlot)) slots.add(sortSlot);
    const projected = [...slots].sort().map((slot) => slot.startsWith('t')
      // Keeps `IS NULL` / `is_not_null` exact without reading up to 1 MiB.
      ? `CASE WHEN ${slot} IS NULL THEN NULL ELSE '' END AS ${slot}`
      : slot);
    return ['pk', 'created_at', 'updated_at', ...projected].join(',');
  };

  const matchesPhysicalFilters = (
    row: RowShape,
    filters: readonly RecordsFilter[],
    schema: RecordsSchemaSnapshot,
    kind: string,
  ): boolean => {
    const fields = new Map(entityFor(schema, kind).fields.map((field) => [field.key, field]));
    return filters.every((filter) => {
      const field = fields.get(filter.field);
      if (field === undefined || !SLOT_SET.has(field.slot)) return false;
      const actual = row[field.slot as RecordsSlot];
      if (filter.op === 'is_null') return filter.value === false ? actual !== null : actual === null;
      if (actual === null) return false; // SQL comparisons with NULL never match.
      if (filter.op === 'in') {
        return (filter.value as PhysicalValue[]).some((value) => compareWire(actual, value) === 0);
      }
      if (filter.op === 'prefix') {
        return typeof actual === 'string' && actual.startsWith(filter.value as string);
      }
      const compared = compareWire(actual, filter.value as PhysicalValue);
      switch (filter.op) {
        case 'eq': return compared === 0;
        case 'ne': return compared !== 0;
        case 'lt': return compared < 0;
        case 'lte': return compared <= 0;
        case 'gt': return compared > 0;
        case 'gte': return compared >= 0;
        default: return false;
      }
    });
  };

  /** D-221 §6.5 — a cursor is a server-side HANDLE, not a signed payload.
   *
   *  It used to be `base64url(json) + HMAC`, which is integrity WITHOUT
   *  confidentiality: anyone holding one could decode the boundary and read the
   *  raw record id and sort value out of it. That mattered twice — the aliaser
   *  masks a record's id on the way to a model and then handed the same id back
   *  in the cursor beside it, and D-222 § 6 designs a visitor-facing paging link
   *  that carries a cursor into a PUBLIC URL on the stated basis that it is
   *  "opaque and authenticated". It was authenticated. It was not opaque.
   *
   *  Since core owns both ends there is nothing to gain from a stateless token:
   *  the handle is 32 random bytes, so it discloses nothing and there is no
   *  payload for a caller to tamper with — which removes the MAC, the canonical
   *  JSON, the base64url-canonicality check and the payload-shape validator that
   *  only existed because the old body was attacker-supplied. The binding is
   *  compared exactly as before; it is simply read from a row.
   *
   *  Binding to `activation_generation` also turns a comparison into a delete:
   *  install/promote/orphan/purge drop the namespace's cursors outright. */
  const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
  const CURSOR_CAP_PER_NAMESPACE = 512;

  /** Age out cursors. `core_record_cursors` is an ordinary DURABLE table, so an
   *  unswept row is a permanent orphan.
   *
   *  The TTL pass is GLOBAL, not scoped to whoever is paging: a per-namespace
   *  sweep only ran when THAT namespace minted again, so a pack that paged once
   *  and stopped kept its rows until something else touched it. Any minting
   *  activity anywhere now ages out everyone's, and `createRecordsStore` runs one
   *  pass at boot so a server that stops paging entirely converges to empty.
   *
   *  The CAP stays per-namespace and is applied only for the namespace given, so
   *  one busy pack cannot evict a quiet one's live cursors. */
  const sweepCursors = (owner?: RecordsPackRef): void => {
    db.prepare(`DELETE FROM ${CURSOR_TABLE} WHERE created_at < ?`)
      .run(now() - CURSOR_TTL_MS);
    if (owner === undefined) return;
    db.prepare(`DELETE FROM ${CURSOR_TABLE}
      WHERE publisher=? AND pack_slug=? AND token NOT IN (
        SELECT token FROM ${CURSOR_TABLE} WHERE publisher=? AND pack_slug=?
        ORDER BY created_at DESC LIMIT ?)`)
      .run(
        owner.publisher, owner.pack_slug,
        owner.publisher, owner.pack_slug, CURSOR_CAP_PER_NAMESPACE,
      );
  };

  const mintCursor = (payload: CursorPayload): string => {
    const token = randomBytes(32).toString('base64url');
    const stamp = now();
    db.prepare(`INSERT INTO ${CURSOR_TABLE}
      (token,publisher,pack_slug,entity,operation_digest,pack_version,activation_generation,
       filters_hash,sort,nav,boundary_id,boundary_value_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        token, payload.publisher, payload.pack_slug, payload.entity,
        payload.operation_digest, payload.version, payload.activation_generation,
        payload.filters_hash, payload.sort, payload.nav, payload.boundary_id,
        JSON.stringify(payload.boundary_value), stamp,
      );
    sweepCursors({ publisher: payload.publisher, pack_slug: payload.pack_slug });
    return token;
  };

  const dropCursors = (owner: RecordsPackRef): void => {
    db.prepare(`DELETE FROM ${CURSOR_TABLE} WHERE publisher=? AND pack_slug=?`)
      .run(owner.publisher, owner.pack_slug);
  };

  const resolveCursor = (
    value: string,
    expected: Omit<CursorPayload, 'nav' | 'boundary_id' | 'boundary_value'>,
  ): CursorPayload => {
    const row = db.prepare(`SELECT * FROM ${CURSOR_TABLE} WHERE token=?`).get(value) as
      Record<string, string | number> | undefined;
    // Unknown, swept or expired all read the same to a caller — a handle nobody
    // issued is indistinguishable from one that has aged out, and neither
    // reveals whether some other query's cursor exists.
    if (row === undefined || safeNumber(Number(row.created_at), 'cursor created_at') < now() - CURSOR_TTL_MS) {
      return fail('records_cursor_invalid', 'Records cursor is unknown or expired');
    }
    const payload: CursorPayload = {
      v: 1,
      publisher: String(row.publisher),
      pack_slug: String(row.pack_slug),
      version: safeNumber(Number(row.pack_version), 'cursor pack_version'),
      activation_generation: safeNumber(Number(row.activation_generation), 'cursor activation_generation'),
      operation_digest: String(row.operation_digest),
      entity: String(row.entity),
      filters_hash: String(row.filters_hash),
      sort: String(row.sort),
      nav: row.nav === 'prev' ? 'prev' : 'next',
      boundary_id: String(row.boundary_id),
      boundary_value: JSON.parse(String(row.boundary_value_json)) as CursorValue,
    };
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
      if (payload[key] !== expected[key]) fail('records_cursor_invalid', `cursor is bound to another ${key}`);
    }
    return payload;
  };

  const encodeCursorValue = (value: unknown): CursorValue => {
    if (value === null) return { type: 'null' };
    if (typeof value === 'bigint') return { type: 'bigint', value: value.toString() };
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('records_incoherent', 'cursor boundary contains a non-finite number');
      return { type: 'number', value };
    }
    if (typeof value === 'string') return { type: 'string', value };
    return fail('records_incoherent', 'cursor boundary has an unsupported physical type');
  };

  const decodeCursorValue = (value: CursorValue): PhysicalValue => {
    if (value.type === 'null') return null;
    if (value.type === 'bigint') return BigInt(value.value);
    return value.value;
  };

  const compareWire = (left: unknown, right: unknown): number => {
    if (left === null && right === null) return 0;
    if (left === null) return -1;
    if (right === null) return 1;
    if (typeof left === 'bigint' || typeof right === 'bigint') {
      const a = BigInt(left as bigint | number);
      const b = BigInt(right as bigint | number);
      return a < b ? -1 : a > b ? 1 : 0;
    }
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
  };

  const search = (
    binding: RecordsExecutionBinding,
    args: Record<string, unknown>,
    ns: NamespaceRow,
    schema: RecordsSchemaSnapshot,
    ownerMode = false,
    includeOrphaned = false,
  ): RecordsSearchResult => {
    if (!ownerMode) requireState(binding);
    else if (ns.state !== 'ready' && !(includeOrphaned && ns.state === 'orphaned')) {
      fail(ns.state === 'incoherent' ? 'records_incoherent' : 'records_not_ready', `namespace is ${ns.state}`);
    }
    const filters = filterList(args.filters, binding, schema, binding.entity, ownerMode);
    const requestedSort = args.sort === undefined
      ? 'id'
      : typeof args.sort === 'string'
        ? args.sort
        : fail('records_invalid', 'sort must be a string');
    if (requestedSort.length === 0 || requestedSort.startsWith('--')) {
      fail('records_invalid', 'sort must be a field with an optional single leading -');
    }
    const descending = requestedSort.startsWith('-');
    const sortName = descending ? requestedSort.slice(1) : requestedSort;
    if (sortName.includes('-') || (!ownerMode && sortName !== 'id' && !(binding.sort_fields ?? []).includes(sortName))) {
      fail('records_invalid', `sort '${requestedSort}' is not admitted`);
    }
    const entity = entityFor(schema, binding.entity);
    const sortField = entity.fields.find((field) => field.key === sortName);
    if (sortName !== 'id' && sortName !== '_record.created_at' && sortName !== '_record.updated_at') {
      if (!sortField || !['number','decimal','date','datetime','boolean'].includes(sortField.kind)) {
        fail('records_invalid', `sort field '${sortName}' is not ordered`);
      }
    }
    const rawLimit = args.limit === undefined ? RECORDS_DEFAULT_PAGE_SIZE : args.limit;
    if (!Number.isSafeInteger(rawLimit) || (rawLimit as number) < 1 || (rawLimit as number) > RECORDS_MAX_PAGE_SIZE) {
      fail('records_invalid', `limit must be an integer in 1..${RECORDS_MAX_PAGE_SIZE}`);
    }
    const limit = rawLimit as number;
    const filterHash = sha256(filterCanonical(filters));
    const expectedCursor = {
      v: 1 as const,
      publisher: binding.owner.publisher,
      pack_slug: binding.owner.pack_slug,
      version: binding.pack_version,
      activation_generation: ns.activation_generation,
      operation_digest: binding.operation_digest,
      entity: binding.entity,
      filters_hash: filterHash,
      sort: requestedSort,
    };
    // ⛔ An EMPTY cursor is "no page", not a bad handle. `''` is this system's
    // canonical first-page value in three separate places: the engine injects
    // a paged recipe's declared default into config (`execute.ts`), the engine
    // OFFERS paging only when that default is exactly `''`
    // (`resolveFilterDescriptor`), and a fresh Search explicitly re-sets
    // `config.cursor = ''` (`outputFilterSearchConfig`). Looking `''` up as a
    // token failed every one of those — so a paged Records list broke on its
    // FIRST load and again on every new search, with "cursor is unknown or
    // expired" pointing at page state rather than at the empty default that
    // caused it. `mintCursor` never issues an empty token, so nothing legitimate
    // is being swallowed here.
    const cursor = args.cursor === undefined || args.cursor === ''
      ? undefined
      : typeof args.cursor === 'string'
        ? resolveCursor(args.cursor, expectedCursor)
        : fail('records_cursor_invalid', 'cursor must be a string');
    const driver = fixedQueryDriver(filters, schema, binding.entity);
    // Above the namespace budget, drive from ONE exact sparse-index predicate
    // and admit only when that predicate's whole candidate set fits. Applying
    // all predicates in SQL can hide a million-entry scan behind a selective
    // second predicate; EXPLAIN merely saying "uses an index" is not a work
    // bound. Fetching the driver set first makes the inspected-row ceiling
    // constructive, then the remaining predicates run over at most 100k rows.
    const scanFilters = ns.row_count > RECORDS_MAX_QUERY_ROWS
      ? driver === undefined
        ? []
        : [driver.filter]
      : filters;
    const where = sqlFilters(scanFilters, schema, binding.entity);
    const indexedBy = driver === undefined
      ? ''
      : ` INDEXED BY core_records_${driver.field.slot}_idx`;
    // Scan THIN: the page is at most `RECORDS_MAX_PAGE_SIZE` rows, so the full
    // row bodies are fetched once the page is known (below), never for all
    // 100k candidates. `filters` — not `scanFilters` — because the over-budget
    // path re-applies the remaining predicates in JS and needs their slots.
    const candidateSql = `SELECT ${scanColumns(filters, schema, binding.entity, sortField?.slot)}
      FROM ${ROW_TABLE}${indexedBy}
      WHERE publisher=? AND pack_slug=? AND kind=?${where.sql}
      LIMIT ?`;
    const candidateParams = [
      binding.owner.publisher, binding.owner.pack_slug, binding.entity,
      ...where.params, RECORDS_MAX_QUERY_ROWS + 1,
    ] as const;
    assertQueryPlanWithinBudget(candidateSql, candidateParams, ns, 'search');
    const stmt = db.prepare(candidateSql);
    stmt.safeIntegers(true);
    const sortValue = (row: RowShape): unknown => {
      if (sortName === 'id') return row.pk;
      if (sortName === '_record.created_at') return row.created_at;
      if (sortName === '_record.updated_at') return row.updated_at;
      return row[sortField!.slot as RecordsSlot];
    };
    const order = (a: RowShape, b: RowShape): number => {
      const primary = compareWire(sortValue(a), sortValue(b));
      const tied = primary === 0 ? compareWire(a.pk, b.pk) : primary;
      return descending ? -tied : tied;
    };
    const compareRowToCursor = (row: RowShape, value: CursorPayload): number => {
      const primary = compareWire(sortValue(row), decodeCursorValue(value.boundary_value));
      const tied = primary === 0 ? compareWire(row.pk, value.boundary_id) : primary;
      return descending ? -tied : tied;
    };
    // ⛔ STREAM the candidates; never hold them. This used to `.all()` the whole
    // set — up to `RECORDS_MAX_QUERY_ROWS` (100,000) rows — sort it, then slice a
    // page of at most 200 out of it. Thinning the projection cut each row's WIDTH
    // but not the COUNT, so a shape with several filterable indexed slots still
    // accumulated the lot. The owner byte quota that once bounded this is
    // settable to any safe integer, so raising it made an ordinary broad read
    // able to exhaust the process.
    //
    // Only `limit` rows can ever be returned, so only `limit` need be retained:
    // keep a bounded run of the best candidates seen so far, insert in order, and
    // drop the far end. Peak retention is O(page), not O(candidates), and the
    // page is identical because a full sort and a bounded ordered insert select
    // the same rows under the same comparator.
    const keepFromEnd = cursor?.nav === 'prev';
    const best: RowShape[] = [];
    let scannedCount = 0;
    let eligibleDropped = false;
    let excludedByCursor = false;
    for (const row of stmt.iterate(...candidateParams) as IterableIterator<RowShape>) {
      scannedCount += 1;
      if (scannedCount > RECORDS_MAX_QUERY_ROWS) {
        fail('records_query_budget', `query exceeds the ${RECORDS_MAX_QUERY_ROWS}-row work budget`);
      }
      if (scanFilters !== filters
        && !matchesPhysicalFilters(row, filters, schema, binding.entity)) continue;
      if (cursor !== undefined) {
        const side = compareRowToCursor(row, cursor);
        if (cursor.nav === 'next' ? side <= 0 : side >= 0) {
          // A candidate the cursor excludes still proves a page exists on the
          // other side of it — this is what `firstIndex > 0` used to say.
          excludedByCursor = true;
          continue;
        }
      }
      // Bounded ordered insert. `limit` is capped at RECORDS_MAX_PAGE_SIZE, so
      // the linear scan of `best` is over at most 200 entries.
      let at = best.length;
      while (at > 0 && order(best[at - 1]!, row) > 0) at -= 1;
      if (best.length < limit) {
        best.splice(at, 0, row);
      } else if (keepFromEnd) {
        if (at > 0) { best.shift(); best.splice(at - 1, 0, row); eligibleDropped = true; }
        else eligibleDropped = true;
      } else if (at < limit) {
        best.pop(); best.splice(at, 0, row); eligibleDropped = true;
      } else {
        eligibleDropped = true;
      }
    }
    const selected = best;
    if (selected.length === 0) return { records: [] };
    // `prev` fills from the far end, so a dropped candidate lies BEFORE the page;
    // otherwise it lies after. Either way it is the boundary the other cursor
    // describes, and the cursor-excluded flag covers the opposite side.
    const hasBefore = keepFromEnd ? eligibleDropped : excludedByCursor;
    const hasAfter = keepFromEnd ? excludedByCursor : eligibleDropped;

    // Phase 2 — hydrate ONLY the page, in the order the scan settled on. Bounded
    // by `limit` (≤ `RECORDS_MAX_PAGE_SIZE`), so the widest possible query holds
    // 200 full rows rather than every candidate. A row deleted between the two
    // phases simply drops out, which is the documented weak-consistency contract
    // (§ 6.5: clients merging live pages deduplicate by id).
    const hydrated = new Map<string, RowShape>();
    for (const row of db.prepare(`SELECT * FROM ${ROW_TABLE}
      WHERE publisher=? AND pack_slug=? AND kind=?
        AND pk IN (${selected.map(() => '?').join(',')})`)
      .safeIntegers(true)
      .all(
        binding.owner.publisher, binding.owner.pack_slug, binding.entity,
        ...selected.map((row) => row.pk),
      ) as RowShape[]) {
      hydrated.set(row.pk, row);
    }
    return {
      records: selected.flatMap((row) => {
        const full = hydrated.get(row.pk);
        return full === undefined ? [] : [projectRow(full, schema)];
      }),
      ...(hasAfter
        ? { next_cursor: mintCursor({
            ...expectedCursor,
            nav: 'next',
            boundary_id: selected[selected.length - 1].pk,
            boundary_value: encodeCursorValue(sortValue(selected[selected.length - 1])),
          }) }
        : {}),
      ...(hasBefore
        ? { prev_cursor: mintCursor({
            ...expectedCursor,
            nav: 'prev',
            boundary_id: selected[0].pk,
            boundary_value: encodeCursorValue(sortValue(selected[0])),
          }) }
        : {}),
    };
  };

  const count = (
    binding: RecordsExecutionBinding,
    args: Record<string, unknown>,
    ns: NamespaceRow,
    schema: RecordsSchemaSnapshot,
  ): { count: number } => {
    requireState(binding);
    const filters = filterList(args.filters, binding, schema, binding.entity);
    const driver = fixedQueryDriver(filters, schema, binding.entity);
    const scanFilters = ns.row_count > RECORDS_MAX_QUERY_ROWS
      ? driver === undefined
        ? []
        : [driver.filter]
      : filters;
    const where = sqlFilters(scanFilters, schema, binding.entity);
    const indexedBy = driver === undefined
      ? ''
      : ` INDEXED BY core_records_${driver.field.slot}_idx`;
    // `count` returns a single integer and hydrated NOTHING from a row body, so
    // `SELECT *` here bought precisely nothing at up to 2 MiB per candidate. It
    // still has to MATERIALIZE rather than `SELECT COUNT(*)`: the over-budget
    // refusal is constructive — it counts the rows the scan actually inspected
    // against the 100k ceiling — and an aggregate would report a number without
    // revealing the work behind it, which § 6.5 refuses to approximate.
    const countSql = `SELECT ${scanColumns(filters, schema, binding.entity)}
      FROM ${ROW_TABLE}${indexedBy}
      WHERE publisher=? AND pack_slug=? AND kind=?${where.sql} LIMIT ?`;
    const countParams = [
      binding.owner.publisher, binding.owner.pack_slug, binding.entity,
      ...where.params, RECORDS_MAX_QUERY_ROWS + 1,
    ] as const;
    assertQueryPlanWithinBudget(countSql, countParams, ns, 'count');
    const stmt = db.prepare(countSql);
    stmt.safeIntegers(true);
    // A count returns one integer and retains NOTHING, so it streams: the budget
    // is enforced as the scan runs and refuses the moment it is exceeded, rather
    // than materializing 100,001 rows to discover the same thing. Peak retention
    // is one row.
    let scannedCount = 0;
    let matched = 0;
    for (const row of stmt.iterate(...countParams) as IterableIterator<RowShape>) {
      scannedCount += 1;
      if (scannedCount > RECORDS_MAX_QUERY_ROWS) {
        fail('records_query_budget', 'count exceeds exact query-work budget');
      }
      if (scanFilters === filters
        || matchesPhysicalFilters(row, filters, schema, binding.entity)) matched += 1;
    }
    return { count: matched };
  };

  /** D-226 — a declared rollup over the rows a filter admits.
   *
   *  Streams exactly like `count` and for the same reason: the budget must be
   *  enforced AS the scan runs, and an aggregate that materialized 100k rows to
   *  return six numbers would retain megabytes to say "135 minutes". Peak
   *  retention is one row plus the accumulators.
   *
   *  ⛔ The rollup comes from `binding.select` — DECLARED at authoring time and
   *  validated at install against this entity's field kinds — never from caller
   *  args. The caller chooses the occasion and the filters, never the shape. */
  const aggregate = (
    binding: RecordsExecutionBinding,
    args: Record<string, unknown>,
    ns: NamespaceRow,
    schema: RecordsSchemaSnapshot,
  ): { aggregate: Record<string, unknown> } | RecordsGroupedAggregateResult => {
    requireState(binding);
    if (binding.select === undefined || Object.keys(binding.select).length === 0) {
      fail('records_invalid', 'aggregate binding declares no select');
    }
    const select = binding.select as NonNullable<RecordsExecutionBinding['select']>;
    const groupBy = binding.group_by;
    const entity = entityFor(schema, binding.entity);
    const byKey = new Map(entity.fields.map((field) => [field.key, field]));

    const referenced = new Set<string>();
    for (const spec of Object.values(select)) {
      if (typeof spec.field === 'string') referenced.add(spec.field);
      if (typeof spec.by === 'string') referenced.add(spec.by);
    }
    if (groupBy !== undefined) referenced.add(groupBy);
    const kinds: Record<string, RecordsFieldKind> = {};
    for (const key of referenced) {
      const field = byKey.get(key);
      // Install validated this against the schema it was stamped for. A miss
      // here means the schema moved underneath the binding, which is a refusal
      // and not something to aggregate around.
      if (field === undefined || field.kind === 'id') {
        fail('records_invalid', `aggregate field '${key}' is not on entity '${binding.entity}'`);
        continue;
      }
      kinds[key] = field.kind as RecordsFieldKind;
    }
    const problems = validateRecordsAggregateSelect(select, kinds);
    if (problems.length > 0) fail('records_invalid', `aggregate select: ${problems[0]}`);
    if (groupBy !== undefined) {
      const groupProblems = validateRecordsGroupBy(groupBy, kinds);
      if (groupProblems.length > 0) fail('records_invalid', `aggregate ${groupProblems[0]}`);
    }

    const filters = filterList(args.filters, binding, schema, binding.entity);
    const driver = fixedQueryDriver(filters, schema, binding.entity);
    const scanFilters = ns.row_count > RECORDS_MAX_QUERY_ROWS
      ? driver === undefined ? [] : [driver.filter]
      : filters;
    const where = sqlFilters(scanFilters, schema, binding.entity);
    const indexedBy = driver === undefined ? '' : ` INDEXED BY core_records_${driver.field.slot}_idx`;

    // Columns: the filter slots `count` would take, plus every slot the rollup
    // reads. ⚠ A `t` slot is projected WHOLE when its value is actually needed
    // (count_distinct / latest / earliest); `count` alone keeps the existing
    // NULL-vs-'' trick so a 1 MiB body is not read to answer "how many".
    const valueNeeded = new Set<string>();
    for (const spec of Object.values(select)) {
      if (spec.fn !== 'count' && typeof spec.field === 'string') valueNeeded.add(spec.field);
      if (typeof spec.by === 'string') valueNeeded.add(spec.by);
    }
    // The group key is always a VALUE read. ⚠ UNREACHABLE TODAY and kept
    // deliberately: only a `t` slot is projected as the NULL-vs-'' presence
    // trick, and `text` is not an admissible group key — so there is no input
    // that reaches this line's effect. It becomes load-bearing the moment
    // `RECORDS_GROUP_BY_KINDS` widens, and its absence then would put every
    // non-null row in one empty-string bucket with correct-looking totals in it.
    if (groupBy !== undefined) valueNeeded.add(groupBy);
    const slots = new Set<string>();
    for (const filter of filters) {
      const slot = byKey.get(filter.field)?.slot;
      if (slot !== undefined && SLOT_SET.has(slot)) slots.add(slot);
    }
    const wholeText = new Set<string>();
    for (const key of referenced) {
      const field = byKey.get(key)!;
      if (SLOT_SET.has(field.slot)) {
        slots.add(field.slot);
        if (field.slot.startsWith('t') && valueNeeded.has(key)) wholeText.add(field.slot);
      }
    }
    const projected = [...slots].sort().map((slot) =>
      slot.startsWith('t') && !wholeText.has(slot)
        ? `CASE WHEN ${slot} IS NULL THEN NULL ELSE '' END AS ${slot}`
        : slot);
    const columns = ['pk', 'created_at', 'updated_at', ...projected].join(',');

    const sql = `SELECT ${columns}
      FROM ${ROW_TABLE}${indexedBy}
      WHERE publisher=? AND pack_slug=? AND kind=?${where.sql} LIMIT ?`;
    const params = [
      binding.owner.publisher, binding.owner.pack_slug, binding.entity,
      ...where.params, RECORDS_MAX_QUERY_ROWS + 1,
    ] as const;
    assertQueryPlanWithinBudget(sql, params, ns, 'aggregate');
    const stmt = db.prepare(sql);
    stmt.safeIntegers(true);

    const acc = groupBy === undefined
      ? createRecordsAggregator(select as Parameters<typeof createRecordsAggregator>[0], kinds)
      : createRecordsGroupedAggregator(
        groupBy, select as Parameters<typeof createRecordsAggregator>[0], kinds);
    let scanned = 0;
    for (const row of stmt.iterate(...params) as IterableIterator<RowShape>) {
      scanned += 1;
      if (scanned > RECORDS_MAX_QUERY_ROWS) {
        fail('records_query_budget', 'aggregate exceeds exact query-work budget');
      }
      if (scanFilters !== filters
        && !matchesPhysicalFilters(row, filters, schema, binding.entity)) continue;
      const projectedRow: Record<string, unknown> = {};
      for (const key of referenced) {
        const field = byKey.get(key)!;
        projectedRow[key] = wireValue(field, row[field.slot as RecordsSlot]);
      }
      acc.push(projectedRow);
    }
    const finished = acc.finish();
    // The op's SHAPE is a property of the declaration, never of the call — an
    // op with a `group_by` always returns groups, one without never does. That
    // is what keeps a consumer able to read it without probing.
    return groupBy === undefined
      ? { aggregate: finished as Record<string, unknown> }
      : finished as RecordsGroupedAggregateResult;
  };

  /** D-226 — N declared writes, ONE transaction, all or none.
   *
   *  ⛔⛔ THE UNIT OF WORK IS THE ONLY THING THAT CHANGES. Every op inside runs
   *  through the SAME `createRecord` / `updateRecord` / `deleteRecord` as a
   *  single-row call — same validation, same CAS, same event emission, same
   *  everything. A batch is not a second write path; it is a transaction
   *  wrapped around the existing one. Anything else and the two would drift,
   *  and a rule enforced on a single write but not inside a batch is a rule an
   *  author can step around by wrapping.
   *
   *  ⛔ THE ALLOW-LIST IS DECLARED, THE ROWS ARE NOT. The caller says what to
   *  write; the bind says what KINDS of write are admissible. So a batch
   *  declared for two creates can never be handed a delete, and the op's risk
   *  tier — computed at authoring from this same list — stays a property of the
   *  op rather than of the call.
   *
   *  ⚠ Nested `db.transaction` is a SAVEPOINT in better-sqlite3, so the inner
   *  per-row transactions roll back with the outer one. Verified, because the
   *  whole value of this depends on it: the enqueued change events are ordinary
   *  rows in that same transaction, so a rolled-back batch also un-emits.
   *
   *  ⛔ NO READS. A read inside a write transaction is the first half of a
   *  read-modify-write loop and CAS exists so that loop cannot be written. Read
   *  first, pass the revisions in, let the batch refuse on a stale one. */
  const batchWrite = (
    call: RecordsExecutionCall,
    _namespace: NamespaceRow,
    _schema: RecordsSchemaSnapshot,
  ): { batch: true; count: number; results: unknown[] } => {
    requireState(call.binding);
    const allow = call.binding.allow;
    if (!Array.isArray(allow) || allow.length === 0) {
      fail('records_invalid', 'batch binding declares no allow list');
    }
    const admitted = new Set(
      (allow as RecordsBatchAllow[]).map((pair) => `${pair.entity}:${pair.action}`));

    const ops = call.args.ops;
    if (!Array.isArray(ops) || ops.length === 0) {
      fail('records_invalid', 'batch requires a non-empty ops array');
    }
    const list = ops as unknown[];
    if (list.length > RECORDS_MAX_BATCH_OPS) {
      fail('records_invalid', `batch admits at most ${RECORDS_MAX_BATCH_OPS} ops`);
    }

    // ⛔ ADMISSION IS CHECKED FOR EVERY OP BEFORE ANY OP RUNS. Checking inside
    // the loop would roll back correctly, but it would also mean a refusal
    // arrives only after the earlier writes have been done and undone — and the
    // events for them enqueued and discarded. A refusal that never started is
    // cheaper to reason about and impossible to observe half-done.
    const planned = list.map((raw, index) => {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        fail('records_invalid', `ops[${index}] must be an object { entity, action, args }`);
      }
      const op = raw as Record<string, unknown>;
      for (const key of Object.keys(op)) {
        if (!['entity', 'action', 'args'].includes(key)) {
          fail('records_invalid', `ops[${index}] has unknown key '${key}'`);
        }
      }
      const entity = op.entity, action = op.action;
      if (typeof entity !== 'string' || typeof action !== 'string'
        || !admitted.has(`${entity}:${action}`)) {
        fail('records_invalid',
          `ops[${index}] '${String(entity)}.${String(action)}' is not in this batch's allow list`);
      }
      const args = op.args === undefined ? {} : op.args;
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        fail('records_invalid', `ops[${index}].args must be an object`);
      }
      return {
        // Each op runs under the SAME binding with its own entity/action — so
        // the owner, the version and the schema hashes are the batch's, and
        // there is no way for one op to address another pack's rows.
        binding: {
          ...call.binding, entity: entity as string,
          action: action as RecordsExecutionBinding['action'],
        },
        args: args as Record<string, unknown>,
      };
    });

    // ⛔⛔ IT RE-ENTERS `execute`. Not a switch of its own — `upsert` is
    // implemented inline in that switch and copying it here would have been a
    // second write path one edit away from disagreeing with the first. Going
    // back through the front door means a batch cannot diverge from a single
    // write even in principle. `batch` is not a batchable action, so this
    // cannot recurse further.
    const results = db.transaction(() => planned.map(({ binding, args }) =>
      execute({ ...call, binding, args })))();

    return { batch: true, count: results.length, results };
  };

  const getOne = (binding: RecordsExecutionBinding, args: Record<string, unknown>, schema: RecordsSchemaSnapshot) => {
    requireState(binding);
    const id = assertId(args.id);
    const row = rowStmt(binding.owner, binding.entity, id);
    if (!row) return { record: null };
    return { record: projectRow(row, schema) };
  };

  const getMany = (binding: RecordsExecutionBinding, args: Record<string, unknown>, schema: RecordsSchemaSnapshot) => {
    requireState(binding);
    if (!Array.isArray(args.ids) || args.ids.length < 1 || args.ids.length > RECORDS_MAX_GET_MANY_IDS) {
      fail('records_invalid', `ids must contain 1..${RECORDS_MAX_GET_MANY_IDS} values`);
    }
    const ids = (args.ids as unknown[]).map(assertId);
    if (new Set(ids).size !== ids.length) fail('records_invalid', 'get_many refuses duplicate ids');
    const records: RecordsFriendlyRecord[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const row = rowStmt(binding.owner, binding.entity, id);
      if (row) records.push(projectRow(row, schema));
      else missing.push(id);
    }
    return { records, missing };
  };

  const installNamespace = (input: RecordsInstallInput): RecordsNamespaceSummary => {
    assertPackRef(input.owner);
    assertSafePositive(input.version, 'pack version');
    if (!input.storage_schema_hash || !input.declaration_hash || !input.artifact_digest) {
      fail('records_invalid', 'Records install requires immutable schema/declaration/artifact digests');
    }
    if (input.schema.decimal_scale !== RECORDS_DECIMAL_SCALE || Object.keys(input.schema.entities).length === 0) {
      fail('records_invalid', 'Records install requires a non-empty fixed-scale schema snapshot');
    }
    for (const binding of Object.values(input.bindings)) {
      if (!isRecordsExecutionBinding(binding)
        || binding.owner.publisher !== input.owner.publisher
        || binding.owner.pack_slug !== input.owner.pack_slug
        || binding.pack_version !== input.version
        || binding.storage_schema_hash !== input.storage_schema_hash
        || binding.declaration_hash !== input.declaration_hash) {
        fail('records_invalid', 'Records install contains an unstamped/foreign operation binding');
      }
    }
    const subscribersJson = canonicalJson(input.subscribers ?? []);
    const subscriberDigest = input.subscriber_digest ?? sha256(subscribersJson);
    if (subscriberDigest !== sha256(subscribersJson)) {
      fail('records_invalid', 'Records subscriber digest does not match its immutable binding snapshot');
    }
    const migrationPlansJson = canonicalJson(input.migration_plans ?? []);
    return db.transaction(() => {
      const prior = namespaceRow(input.owner);
      const stamp = now();
      if (input.expected_state_generation !== undefined
        && prior?.state_generation !== input.expected_state_generation) {
        fail('records_conflict', 'Records install preview fence changed');
      }
      if (prior?.state === 'incoherent' || prior?.state === 'migrating') {
        fail(prior.state === 'incoherent' ? 'records_incoherent' : 'records_not_ready', `cannot install over ${prior.state}`);
      }
      // Uninstall RETAINS by default, so the orphaned namespace still carries the
      // newer version's rows and this fires on the ordinary
      // install-v3 → uninstall → install-v2 path. The refusal is correct — the
      // rows describe a schema epoch v2 does not know — but naming only the
      // reverse migration read as a dead end, because that exit belongs to the
      // PACK AUTHOR. The owner's own exit is export-then-purge, and the
      // reinstall-newer exit is one click. State both, and carry the two
      // versions structurally so a surface can render them without parsing prose.
      if (prior && input.version < (prior.version ?? 0)) {
        const retained = prior.version ?? 0;
        fail(
          'records_conflict',
          `this pack's retained Records data is at v${retained}, newer than the v${input.version} being installed. `
          + `Install v${retained} or later to adopt it, or export and purge this pack's Records data `
          + `(Data → Pack records) to install v${input.version} on empty storage. `
          + 'Downgrading in place instead needs a reverse migration pinned by the retained artifact.',
          { retained_version: retained, requested_version: input.version },
        );
      }
      if (prior && prior.row_count > 0 && prior.storage_schema_hash !== input.storage_schema_hash) {
        fail('records_conflict', 'populated Records schema changed without a classified migration route');
      }
      // A populated version transition always belongs to the durable migration
      // kernel, including a schema-unchanged sweep. Keeping a convenience
      // sweep here would let an internal caller bypass receipts, quiescence,
      // crash-resume, and the pack-wide finalizer.
      if (prior && prior.row_count > 0 && prior.version !== input.version) {
        fail('records_conflict', 'populated Records version changes require the durable migration coordinator');
      }
      // ⛔ A SAME-VERSION activation replacement never reaches the migration
      // coordinator — the guard above only fires when the version moves, and the
      // upgrade authority's rekey check only runs on a version change. So
      // reinstalling v1 over v1 with a NEW natural_key skipped every other gate:
      // verified, the legacy row survived at its caller-chosen id and the next
      // create of that same tuple seated a second row beside it.
      //
      // This is the last gate before bindings are swapped, and unlike the
      // authority's it takes nothing from a caller — the prior key comes from the
      // namespace's own installed operations. Populated kinds only: rekeying an
      // empty kind is free, and no route can rewrite a `pk` anyway (§ 10.4).
      if (prior !== undefined) {
        const priorKeys = entityNaturalKeys(input.owner);
        const nextKeys: Record<string, string[]> = {};
        for (const candidate of Object.values(input.bindings)) {
          if (candidate.action !== 'create' || candidate.natural_key === undefined) continue;
          nextKeys[candidate.entity] = [...candidate.natural_key].sort();
        }
        const populated = new Set((db.prepare(`SELECT DISTINCT kind FROM ${ROW_TABLE}
          WHERE publisher=? AND pack_slug=?`)
          .all(input.owner.publisher, input.owner.pack_slug) as Array<{ kind: string }>)
          .map((row) => row.kind));
        const rekeyed = [...new Set([...Object.keys(priorKeys), ...Object.keys(nextKeys)])]
          .filter((entity) => populated.has(entity)
            && JSON.stringify(priorKeys[entity] ?? null) !== JSON.stringify(nextKeys[entity] ?? null))
          .sort();
        if (rekeyed.length > 0) {
          fail('records_conflict',
            `natural_key changed on populated ${rekeyed.join(', ')}. Records has no mapping that `
            + 'rewrites a primary key, so the existing rows cannot be relocated: keep the key as it '
            + 'was, or export and purge those kinds first.',
            { rekeyed_entities: rekeyed });
        }
      }
      // Every cursor names a boundary in the OLD activation. Dropping them is
      // stronger than comparing and is the whole reason the handle binds
      // `activation_generation`.
      if (prior !== undefined) dropCursors(input.owner);
      let retainedOutboxCount = prior?.outbox_count ?? 0;
      if (prior !== undefined) {
        const retired = db.prepare(`UPDATE ${OUTBOX_TABLE}
          SET status='dead_letter',error='retired by Records activation replacement'
          WHERE publisher=? AND pack_slug=? AND status='pending'`)
          .run(input.owner.publisher, input.owner.pack_slug).changes;
        db.prepare(`UPDATE ${OUTBOX_DELIVERY_TABLE} SET status='dead_letter',
          error='retired by Records activation replacement'
          WHERE status='pending' AND event_id IN (
            SELECT event_id FROM ${OUTBOX_TABLE}
            WHERE publisher=? AND pack_slug=? AND status='dead_letter'
          )`).run(input.owner.publisher, input.owner.pack_slug);
        if (retired !== retainedOutboxCount) {
          fail('records_incoherent', 'activation retirement disagrees with Records outbox accounting');
        }
        retainedOutboxCount -= retired;
      }
      const activation = (prior?.activation_generation ?? 0) + 1;
      const generation = (prior?.state_generation ?? 0) + 1;
      db.prepare(`INSERT INTO ${NAMESPACE_TABLE}
        (publisher,pack_slug,state,version,from_version,target_version,storage_schema_hash,declaration_hash,
         target_storage_schema_hash,migration_id,schema_json,operations_json,migration_plans_json,artifact_digest,
         activation_generation,state_generation,data_generation,row_count,payload_bytes,row_limit,byte_limit,
         outbox_count,outbox_limit,subscriber_digest,subscribers_json,last_known_state,detected_at,reason,evidence_ref,updated_at)
        VALUES (?,?, 'ready',?,NULL,NULL,?,?,NULL,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,?)
        ON CONFLICT(publisher,pack_slug) DO UPDATE SET
          state='ready',version=excluded.version,from_version=NULL,target_version=NULL,
          storage_schema_hash=excluded.storage_schema_hash,declaration_hash=excluded.declaration_hash,
          target_storage_schema_hash=NULL,migration_id=NULL,schema_json=excluded.schema_json,
          operations_json=excluded.operations_json,migration_plans_json=excluded.migration_plans_json,
          artifact_digest=excluded.artifact_digest,
          activation_generation=excluded.activation_generation,state_generation=excluded.state_generation,
          outbox_count=excluded.outbox_count,
          subscriber_digest=excluded.subscriber_digest,subscribers_json=excluded.subscribers_json,
          last_known_state=NULL,detected_at=NULL,reason=NULL,
          evidence_ref=NULL,updated_at=excluded.updated_at`)
        .run(
          input.owner.publisher, input.owner.pack_slug, input.version,
          input.storage_schema_hash, input.declaration_hash,
          JSON.stringify(input.schema), JSON.stringify(input.bindings), migrationPlansJson, input.artifact_digest,
          activation, generation, prior?.data_generation ?? 0,
          prior?.row_count ?? 0, prior?.payload_bytes ?? 0,
          prior?.row_limit ?? RECORDS_DEFAULT_ROW_QUOTA,
          prior?.byte_limit ?? RECORDS_DEFAULT_BYTE_QUOTA,
          retainedOutboxCount,
          prior?.outbox_limit ?? RECORDS_DEFAULT_OUTBOX_QUOTA,
          subscriberDigest, subscribersJson, stamp,
        );
      return summary(namespaceRow(input.owner)!);
    })();
  };

  const migrationRow = (owner: RecordsPackRef): MigrationRow | undefined =>
    db.prepare(`SELECT * FROM ${MIGRATION_TABLE} WHERE publisher=? AND pack_slug=?`)
      .get(owner.publisher, owner.pack_slug) as MigrationRow | undefined;

  const migrationView = (row: MigrationRow): RecordsMigrationView => ({
    owner: { publisher: row.publisher, pack_slug: row.pack_slug },
    migration_id: row.migration_id,
    plan_digest: row.plan_digest,
    from_version: row.from_version,
    target_version: row.target_version,
    lock_generation: row.lock_generation,
    status: row.status,
    target_schema: JSON.parse(row.target_schema_json) as RecordsSchemaSnapshot,
    reserved_byte_delta: row.reserved_byte_delta,
    started_at: row.started_at,
    updated_at: row.updated_at,
    ...(row.error ? { error: row.error } : {}),
  });

  const requiredMigrationSteps = (migration: MigrationRow): RecordsMigrationRequiredStep[] =>
    JSON.parse(migration.required_steps_json) as RecordsMigrationRequiredStep[];

  const requireMigration = (
    owner: RecordsPackRef,
    migrationId: string,
    lockGeneration: number,
  ): { namespace: NamespaceRow; migration: MigrationRow } => {
    const namespace = requireValue(namespaceRow(owner), 'records_incoherent', 'Records migration namespace is missing');
    const migration = requireValue(migrationRow(owner), 'records_incoherent', 'Records migration state is missing');
    if (namespace.state !== 'migrating'
      || namespace.migration_id !== migrationId
      || migration.migration_id !== migrationId
      || namespace.state_generation !== lockGeneration
      || migration.lock_generation !== lockGeneration) {
      fail('records_conflict', 'stale Records migration lock generation');
    }
    if (migration.status === 'complete') fail('records_conflict', 'Records migration is already complete');
    return { namespace, migration };
  };

  const stepRow = (
    owner: RecordsPackRef,
    migrationId: string,
    identity: Pick<RecordsMigrationRequiredStep, 'recipe_digest' | 'step_id'>,
  ): MigrationStepRow | undefined =>
    db.prepare(`SELECT cursor,rows_changed,complete,args_hash,op FROM ${MIGRATION_STEP_TABLE}
      WHERE publisher=? AND pack_slug=? AND migration_id=? AND recipe_digest=? AND step_id=?`)
      .get(owner.publisher, owner.pack_slug, migrationId, identity.recipe_digest, identity.step_id) as MigrationStepRow | undefined;

  const sameStep = (left: RecordsMigrationRequiredStep, right: RecordsMigrationRequiredStep): boolean =>
    left.recipe_digest === right.recipe_digest
    && left.step_id === right.step_id
    && left.args_hash === right.args_hash
    && left.op === right.op;

  const admitMigrationStep = (
    owner: RecordsPackRef,
    migration: MigrationRow,
    identity: RecordsMigrationRequiredStep,
    args: unknown,
  ): MigrationStepRow => {
    if (!identity.recipe_digest || !identity.step_id || !identity.args_hash || !identity.op
      || sha256(canonicalJson(args)) !== identity.args_hash) {
      fail('records_unauthorized', 'migration step identity/args hash is invalid');
    }
    const required = requiredMigrationSteps(migration);
    const index = required.findIndex((candidate) => sameStep(candidate, identity));
    if (index < 0) fail('records_unauthorized', 'migration step is not in the locked plan');
    for (const prior of required.slice(0, index)) {
      const receipt = stepRow(owner, migration.migration_id, prior);
      if (!receipt?.complete || receipt.args_hash !== prior.args_hash || receipt.op !== prior.op) {
        fail('records_conflict', `migration step '${identity.step_id}' is out of order`);
      }
    }
    const existing = stepRow(owner, migration.migration_id, identity);
    if (existing) {
      if (existing.args_hash !== identity.args_hash || existing.op !== identity.op) {
        fail('records_conflict', 'migration step identity was reused with different content');
      }
      return existing;
    }
    db.prepare(`INSERT INTO ${MIGRATION_STEP_TABLE}
      (publisher,pack_slug,migration_id,recipe_digest,step_id,op,args_hash,cursor,rows_changed,complete,updated_at)
      VALUES (?,?,?,?,?,?,?, '',0,0,?)`)
      .run(
        owner.publisher, owner.pack_slug, migration.migration_id,
        identity.recipe_digest, identity.step_id, identity.op, identity.args_hash, now(),
      );
    return stepRow(owner, migration.migration_id, identity)!;
  };

  const recordMigrationBatch = (
    owner: RecordsPackRef,
    migrationId: string,
    identity: RecordsMigrationRequiredStep,
    cursor: string,
    changed: number,
    complete: boolean,
  ): void => {
    const stamp = now();
    const updated = db.prepare(`UPDATE ${MIGRATION_STEP_TABLE}
      SET cursor=?,rows_changed=rows_changed+?,complete=?,updated_at=?
      WHERE publisher=? AND pack_slug=? AND migration_id=? AND recipe_digest=? AND step_id=?
        AND args_hash=? AND op=? AND complete=0`)
      .run(
        cursor, changed, complete ? 1 : 0, stamp,
        owner.publisher, owner.pack_slug, migrationId, identity.recipe_digest, identity.step_id,
        identity.args_hash, identity.op,
      );
    if (updated.changes !== 1) fail('records_conflict', 'migration receipt changed concurrently');
    const batchCursor = `${identity.recipe_digest}:${identity.step_id}:${cursor || '$complete'}`;
    db.prepare(`INSERT INTO ${RECEIPT_TABLE}
      (publisher,pack_slug,migration_id,batch_cursor,mapping_hash,rows_changed,created_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(publisher,pack_slug,migration_id,batch_cursor) DO NOTHING`)
      .run(owner.publisher, owner.pack_slug, migrationId, batchCursor, identity.args_hash, changed, stamp);
    db.prepare(`UPDATE ${MIGRATION_TABLE} SET status='running',error=NULL,updated_at=?
      WHERE publisher=? AND pack_slug=? AND migration_id=?`)
      .run(stamp, owner.publisher, owner.pack_slug, migrationId);
  };

  const migrationBatchSize = (value: number | undefined): number => {
    const size = value ?? 500;
    if (!Number.isSafeInteger(size) || size < 1 || size > 5_000) {
      fail('records_invalid', 'migration batch_size must be an integer in 1..5000');
    }
    return size;
  };

  const routeSchema = (migration: MigrationRow, version: number): RecordsSchemaSnapshot => {
    const schemas = JSON.parse(migration.route_schemas_json) as Record<string, RecordsSchemaSnapshot>;
    return requireValue(schemas[String(version)], 'records_incoherent', `migration schema snapshot v${version} is missing`);
  };

  const assertPhysicalTarget = (
    owner: RecordsPackRef,
    row: RowShape,
    targetSchema: RecordsSchemaSnapshot,
  ): void => {
    const entity = entityFor(targetSchema, row.kind);
    const declared = new Set<RecordsSlot>();
    const physical = physicalFromRow(row);
    for (const field of entity.fields) {
      if (field.kind === 'id') continue;
      const slot = field.slot as RecordsSlot;
      declared.add(slot);
      const value = physical[slot];
      if (field.required && value === null) {
        fail('records_invalid', `migration target ${row.kind}/${row.pk} is missing required field '${field.key}'`);
      }
      if (value !== null) {
        const normalized = normalizeField(field, wireValue(field, value));
        if (!Object.is(normalized, value)) {
          fail('records_invalid', `migration target ${row.kind}/${row.pk} has an invalid '${field.key}' value`);
        }
      }
    }
    for (const slot of SLOT_NAMES) {
      if (!declared.has(slot) && physical[slot] !== null) {
        fail('records_invalid', `migration target ${row.kind}/${row.pk} retains data in undeclared slot '${slot}'`);
      }
    }
    validateReferences(owner, row.kind, row.pk, physical);
  };

  const migrationStepIdentity = (
    recipeDigest: string,
    step: RecordsMigrationTransformStep | RecordsMigrationVerifyStep | RecordsMigrationFinalizeStep,
  ): RecordsMigrationRequiredStep => ({
    recipe_digest: recipeDigest,
    step_id: step.id,
    args_hash: step.args_hash,
    op: step.op,
  });

  const beginMigration = (input: RecordsMigrationStartInput): RecordsMigrationView => {
    assertPackRef(input.owner);
    assertSafePositive(input.from_version, 'migration from_version');
    assertSafePositive(input.target_version, 'migration target_version');
    assertSafeNonNegative(input.expected_state_generation, 'migration expected_state_generation');
    const reservedByteDelta = input.reserved_byte_delta ?? 0;
    assertSafeNonNegative(reservedByteDelta, 'migration reserved_byte_delta');
    if (!input.migration_id || bytes(input.migration_id) > 512
      || !input.plan_digest || !input.target_storage_schema_hash
      || !input.target_declaration_hash || !input.target_artifact_digest
      || !input.target_subscriber_digest) {
      fail('records_invalid', 'migration requires bounded immutable identities and target digests');
    }
    if (input.target_schema.decimal_scale !== RECORDS_DECIMAL_SCALE
      || Object.keys(input.target_schema.entities).length === 0) {
      fail('records_invalid', 'migration target schema is empty or uses another decimal scale');
    }
    for (const binding of Object.values(input.target_bindings)) {
      if (!isRecordsExecutionBinding(binding)
        || binding.owner.publisher !== input.owner.publisher
        || binding.owner.pack_slug !== input.owner.pack_slug
        || binding.pack_version !== input.target_version
        || binding.storage_schema_hash !== input.target_storage_schema_hash
        || binding.declaration_hash !== input.target_declaration_hash) {
        fail('records_invalid', 'migration target contains an unstamped/foreign operation binding');
      }
    }
    if (input.required_steps.length < 1
      || input.required_steps.at(-1)?.op !== 'core.records.finalize-migration') {
      fail('records_invalid', 'migration plan requires a final finalizer step');
    }
    if (input.ordered_steps.length !== input.required_steps.length) {
      fail('records_invalid', 'durable migration step bodies do not match the selected plan');
    }
    const identities = new Set<string>();
    for (const [index, step] of input.required_steps.entries()) {
      if (!step.recipe_digest || !step.step_id || !step.args_hash
        || !['core.records.migrate','core.records.verify-migration','core.records.finalize-migration'].includes(step.op)) {
        fail('records_invalid', 'migration plan contains an invalid step identity');
      }
      const selected = input.ordered_steps[index];
      if (selected === undefined
        || selected.recipe_digest !== step.recipe_digest
        || selected.step.id !== step.step_id
        || selected.step.op !== step.op
        || selected.step.args_hash !== step.args_hash) {
        fail('records_invalid', 'durable migration step order/body disagrees with its required identity');
      }
      const identity = `${step.recipe_digest}\0${step.step_id}`;
      if (identities.has(identity)) fail('records_invalid', 'migration plan repeats a recipe/step identity');
      identities.add(identity);
    }
    const initial = requireValue(namespaceRow(input.owner), 'records_not_found', 'Records namespace was not found');
    const routeSchemas = {
      ...(input.route_schemas ?? {}),
      [String(input.from_version)]: JSON.parse(initial.schema_json) as RecordsSchemaSnapshot,
      [String(input.target_version)]: input.target_schema,
    };
    const artifactPins = input.artifact_pins;
    if (artifactPins === null || typeof artifactPins !== 'object' || Array.isArray(artifactPins)) {
      fail('records_invalid', 'migration artifact pins must be an object');
    }
    for (const [version, schema] of Object.entries(routeSchemas)) {
      if (!Number.isSafeInteger(Number(version)) || Number(version) <= 0
        || schema.decimal_scale !== RECORDS_DECIMAL_SCALE || Object.keys(schema.entities).length === 0) {
        fail('records_invalid', `migration route schema '${version}' is invalid`);
      }
      if (typeof artifactPins[version] !== 'string' || artifactPins[version]!.length === 0) {
        fail('records_invalid', `migration route schema '${version}' lacks an artifact digest pin`);
      }
    }
    for (const [version, digest] of Object.entries(artifactPins)) {
      if (!Number.isSafeInteger(Number(version)) || Number(version) <= 0
        || typeof digest !== 'string' || digest.length === 0
        || routeSchemas[version] === undefined) {
        fail('records_invalid', `migration artifact pin '${version}' has no matching route schema`);
      }
    }
    const targetSchemaJson = canonicalJson(input.target_schema);
    const routeSchemasJson = canonicalJson(routeSchemas);
    const artifactPinsJson = canonicalJson(artifactPins);
    const targetBindingsJson = canonicalJson(input.target_bindings);
    const targetMigrationPlansJson = canonicalJson(input.target_migration_plans ?? []);
    const requiredStepsJson = canonicalJson(input.required_steps);
    const orderedStepsJson = canonicalJson(input.ordered_steps);
    const targetSubscribersJson = canonicalJson(input.target_subscribers);
    if (input.target_subscriber_digest !== sha256(targetSubscribersJson)) {
      fail('records_invalid', 'migration subscriber digest does not match its immutable binding snapshot');
    }
    return db.transaction(() => {
      const ns = requireValue(namespaceRow(input.owner), 'records_not_found', 'Records namespace was not found');
      const existing = migrationRow(input.owner);
      if (ns.state === 'migrating') {
        if (!existing
          || ns.migration_id !== input.migration_id
          || existing.migration_id !== input.migration_id
          || existing.plan_digest !== input.plan_digest
          || existing.from_version !== input.from_version
          || existing.target_version !== input.target_version
          || existing.target_storage_schema_hash !== input.target_storage_schema_hash
          || existing.target_declaration_hash !== input.target_declaration_hash
          || existing.target_artifact_digest !== input.target_artifact_digest
          || canonicalJson(JSON.parse(existing.target_schema_json)) !== targetSchemaJson
          || canonicalJson(JSON.parse(existing.route_schemas_json)) !== routeSchemasJson
          || canonicalJson(JSON.parse(existing.artifact_pins_json)) !== artifactPinsJson
          || canonicalJson(JSON.parse(existing.target_operations_json)) !== targetBindingsJson
          || canonicalJson(JSON.parse(existing.target_migration_plans_json)) !== targetMigrationPlansJson
          || canonicalJson(JSON.parse(existing.target_subscribers_json)) !== targetSubscribersJson
          || canonicalJson(JSON.parse(existing.required_steps_json)) !== requiredStepsJson
          || canonicalJson(JSON.parse(existing.ordered_steps_json)) !== orderedStepsJson
          || existing.reserved_byte_delta !== reservedByteDelta) {
          fail('records_conflict', 'another Records migration owns this namespace');
        }
        const lockedMigration = existing!;
        if (ns.state_generation !== lockedMigration.lock_generation) {
          fail('records_incoherent', 'migration lock generation disagrees with namespace state');
        }
        if (lockedMigration.status === 'failed') {
          db.prepare(`UPDATE ${MIGRATION_TABLE} SET status='running',error=NULL,updated_at=?
            WHERE publisher=? AND pack_slug=?`).run(now(), input.owner.publisher, input.owner.pack_slug);
        }
        return migrationView(migrationRow(input.owner)!);
      }
      if (ns.state !== 'ready' && ns.state !== 'orphaned') {
        fail(ns.state === 'incoherent' ? 'records_incoherent' : 'records_not_ready', `cannot migrate namespace in state '${ns.state}'`);
      }
      if (ns.state_generation !== input.expected_state_generation) {
        fail('records_conflict', 'migration review fence changed before lock');
      }
      if (ns.version !== input.from_version) {
        fail('records_conflict', 'migration source version changed before lock');
      }
      const wrong = db.prepare(`SELECT kind,pk,version FROM ${ROW_TABLE}
        WHERE publisher=? AND pack_slug=? AND version<>? ORDER BY kind,pk LIMIT 1`);
      wrong.safeIntegers(true);
      const wrongRow = wrong.get(input.owner.publisher, input.owner.pack_slug, input.from_version) as RowShape | undefined;
      if (wrongRow) fail('records_incoherent', `row ${wrongRow.kind}/${wrongRow.pk} has an unexpected pre-migration version`);
      const global = globalQuota();
      if (global.payload_bytes + global.reserved_payload_bytes + reservedByteDelta > global.byte_limit) {
        fail('records_quota_exceeded', 'migration reservation exceeds the global Records quota');
      }
      const stamp = now();
      const lockGeneration = ns.state_generation + 1;
      const retired = db.prepare(`UPDATE ${OUTBOX_TABLE}
        SET status='dead_letter',error='retired by Records migration activation fence'
        WHERE publisher=? AND pack_slug=? AND status='pending'`)
        .run(input.owner.publisher, input.owner.pack_slug).changes;
      if (retired !== ns.outbox_count) {
        fail('records_incoherent', 'migration event retirement disagrees with Records outbox accounting');
      }
      db.prepare(`UPDATE ${OUTBOX_DELIVERY_TABLE} SET status='dead_letter',
        error='retired by Records migration activation fence'
        WHERE status='pending' AND event_id IN (
          SELECT event_id FROM ${OUTBOX_TABLE} WHERE publisher=? AND pack_slug=? AND status='dead_letter'
        )`).run(input.owner.publisher, input.owner.pack_slug);
      const locked = db.prepare(`UPDATE ${NAMESPACE_TABLE} SET
        state='migrating',from_version=?,target_version=?,target_storage_schema_hash=?,migration_id=?,
        activation_generation=activation_generation+1,state_generation=?,outbox_count=outbox_count-?,
        last_known_state=NULL,detected_at=NULL,reason=NULL,evidence_ref=NULL,updated_at=?
        WHERE publisher=? AND pack_slug=? AND state_generation=? AND state IN ('ready','orphaned')
          AND outbox_count>=?`)
        .run(
          input.from_version, input.target_version, input.target_storage_schema_hash, input.migration_id,
          lockGeneration, retired, stamp, input.owner.publisher, input.owner.pack_slug,
          input.expected_state_generation, retired,
        );
      if (locked.changes !== 1) fail('records_conflict', 'migration lock compare-and-set failed');
      db.prepare(`INSERT INTO ${MIGRATION_TABLE}
        (publisher,pack_slug,migration_id,plan_digest,from_version,target_version,lock_generation,
         target_storage_schema_hash,target_declaration_hash,target_artifact_digest,target_schema_json,
         route_schemas_json,artifact_pins_json,target_operations_json,target_migration_plans_json,target_subscriber_digest,target_subscribers_json,required_steps_json,ordered_steps_json,reserved_byte_delta,
         status,error,started_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'running',NULL,?,?)
        ON CONFLICT(publisher,pack_slug) DO UPDATE SET
          migration_id=excluded.migration_id,plan_digest=excluded.plan_digest,
          from_version=excluded.from_version,target_version=excluded.target_version,
          lock_generation=excluded.lock_generation,target_storage_schema_hash=excluded.target_storage_schema_hash,
          target_declaration_hash=excluded.target_declaration_hash,target_artifact_digest=excluded.target_artifact_digest,
          target_schema_json=excluded.target_schema_json,route_schemas_json=excluded.route_schemas_json,
          artifact_pins_json=excluded.artifact_pins_json,
          target_operations_json=excluded.target_operations_json,
          target_migration_plans_json=excluded.target_migration_plans_json,
          target_subscriber_digest=excluded.target_subscriber_digest,
          target_subscribers_json=excluded.target_subscribers_json,
          required_steps_json=excluded.required_steps_json,ordered_steps_json=excluded.ordered_steps_json,
          reserved_byte_delta=excluded.reserved_byte_delta,status='running',error=NULL,
          started_at=excluded.started_at,updated_at=excluded.updated_at`)
        .run(
          input.owner.publisher, input.owner.pack_slug, input.migration_id, input.plan_digest,
          input.from_version, input.target_version, lockGeneration,
          input.target_storage_schema_hash, input.target_declaration_hash, input.target_artifact_digest,
          targetSchemaJson, routeSchemasJson, artifactPinsJson, targetBindingsJson, targetMigrationPlansJson, input.target_subscriber_digest,
          targetSubscribersJson,
          requiredStepsJson, orderedStepsJson, reservedByteDelta, stamp, stamp,
        );
      return migrationView(migrationRow(input.owner)!);
    })();
  };

  const markMigrationFailure = (owner: RecordsPackRef, migrationId: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : 'unknown migration failure';
    db.prepare(`UPDATE ${MIGRATION_TABLE} SET status='failed',error=?,updated_at=?
      WHERE publisher=? AND pack_slug=? AND migration_id=? AND status<>'complete'`)
      .run(message.slice(0, 4096), now(), owner.publisher, owner.pack_slug, migrationId);
  };

  const persistMigratedRow = (
    owner: RecordsPackRef,
    current: RowShape,
    nextKind: string,
    next: PhysicalFields,
    stamp: number,
  ): number => {
    const payload = logicalPayloadBytes(current.pk, next);
    const currentPayload = safeNumber(current.payload_bytes, 'payload_bytes');
    const assignments = SLOT_NAMES.map((slot) => `${slot}=?`).join(',');
    const updated = db.prepare(`UPDATE ${ROW_TABLE} SET kind=?,${assignments},revision=revision+1,
      updated_at=?,updated_by='system:records-migration',payload_bytes=?
      WHERE publisher=? AND pack_slug=? AND kind=? AND pk=? AND version=? AND revision=?`)
      .run(
        nextKind, ...SLOT_NAMES.map((slot) => next[slot]), stamp, payload,
        owner.publisher, owner.pack_slug, current.kind, current.pk,
        safeNumber(current.version, 'row version'), safeNumber(current.revision, 'row revision'),
      );
    if (updated.changes !== 1) fail('records_conflict', `migration lost CAS for ${current.kind}/${current.pk}`);
    replaceReverseRefs(owner, nextKind, current.pk, next);
    return payload - currentPayload;
  };

  const updateMigrationAccounting = (
    owner: RecordsPackRef,
    byteDelta: number,
    changedRows: number,
    stamp: number,
  ): void => {
    if (changedRows === 0) return;
    const global = globalQuota();
    if (global.payload_bytes > global.byte_limit) {
      fail('records_quota_exceeded', 'migration payload delta exceeds the global Records quota');
    }
    const updated = db.prepare(`UPDATE ${NAMESPACE_TABLE} SET
      payload_bytes=payload_bytes+?,data_generation=data_generation+?,updated_at=?
      WHERE publisher=? AND pack_slug=? AND state='migrating'
        AND payload_bytes+? BETWEEN 0 AND byte_limit`)
      .run(byteDelta, changedRows, stamp, owner.publisher, owner.pack_slug, byteDelta);
    if (updated.changes !== 1) fail('records_quota_exceeded', 'migration payload delta exceeds the reserved namespace quota');
  };

  const assertNoFriendlyPrefixAliases = (names: readonly string[]): void => {
    const unique = [...new Set(names)].sort();
    for (let left = 0; left < unique.length; left += 1) {
      for (let right = left + 1; right < unique.length; right += 1) {
        if (unique[right]!.startsWith(`${unique[left]}.`)) {
          fail('records_invalid', `migration field aliases '${unique[left]}' and '${unique[right]}' overlap`);
        }
      }
    }
  };

  const applyMigrationMapping = (
    owner: RecordsPackRef,
    current: RowShape,
    oldSchema: RecordsSchemaSnapshot,
    targetSchema: RecordsSchemaSnapshot,
    step: RecordsMigrationTransformStep,
    stamp: number,
  ): { changedRows: number; byteDelta: number } => {
    const mappings = step.args.field_mapping;
    const kindMoves = mappings.filter((mapping) => mapping.op === 'change_kind');
    if (kindMoves.length > 0) {
      if (kindMoves.length !== 1 || mappings.length !== 1) {
        fail('records_invalid', 'change_kind must be the sole mapping in its migration step');
      }
      const move = kindMoves[0]!;
      if (move.from !== step.args.kind || current.kind !== move.from) {
        fail('records_invalid', 'change_kind source must equal the step source kind');
      }
      entityFor(oldSchema, move.from);
      entityFor(targetSchema, move.to);
      if (rowStmt(owner, move.to, current.pk)) {
        fail('records_conflict', `change_kind destination collision at ${move.to}/${current.pk}`);
      }
      const inbound = db.prepare(`SELECT source_kind,source_pk,source_slot FROM ${REVERSE_TABLE}
        WHERE publisher=? AND pack_slug=? AND target_kind=? AND target_pk=?
        ORDER BY source_kind,source_pk,source_slot`)
        .all(owner.publisher, owner.pack_slug, current.kind, current.pk) as Array<{
          source_kind: string;
          source_pk: string;
          source_slot: string;
        }>;
      const next = physicalFromRow(current);
      const oldRef = `${current.kind}/${encodeURIComponent(current.pk)}`;
      const newRef = `${move.to}/${encodeURIComponent(current.pk)}`;
      for (const reference of inbound) {
        if (reference.source_kind === current.kind && reference.source_pk === current.pk) {
          const slot = reference.source_slot as RecordsSlot;
          if (next[slot] !== oldRef) fail('records_incoherent', 'reverse-reference index disagrees with source row');
          next[slot] = newRef;
        }
      }
      validateReferences(owner, move.to, current.pk, next);
      db.prepare(`DELETE FROM ${REVERSE_TABLE}
        WHERE publisher=? AND pack_slug=? AND source_kind=? AND source_pk=?`)
        .run(owner.publisher, owner.pack_slug, current.kind, current.pk);
      let byteDelta = persistMigratedRow(owner, current, move.to, next, stamp);
      let changedRows = 1;
      const grouped = new Map<string, { kind: string; pk: string; slots: RecordsSlot[] }>();
      for (const reference of inbound) {
        if (reference.source_kind === current.kind && reference.source_pk === current.pk) continue;
        const key = `${reference.source_kind}\0${reference.source_pk}`;
        const group = grouped.get(key) ?? { kind: reference.source_kind, pk: reference.source_pk, slots: [] };
        group.slots.push(reference.source_slot as RecordsSlot);
        grouped.set(key, group);
      }
      for (const group of grouped.values()) {
        const source = requireValue(rowStmt(owner, group.kind, group.pk), 'records_incoherent', 'reverse-reference source row is missing');
        if (safeNumber(source.version, 'row version') !== step.args.from_v) {
          fail('records_incoherent', `inbound reference source ${group.kind}/${group.pk} has an unexpected version`);
        }
        const rewritten = physicalFromRow(source);
        for (const slot of group.slots) {
          if (rewritten[slot] !== oldRef) fail('records_incoherent', 'reverse-reference index disagrees with source row');
          rewritten[slot] = newRef;
        }
        validateReferences(owner, group.kind, group.pk, rewritten);
        byteDelta += persistMigratedRow(owner, source, source.kind, rewritten, stamp);
        changedRows += 1;
      }
      return { changedRows, byteDelta };
    }

    const oldEntity = entityFor(oldSchema, step.args.kind);
    const targetEntity = entityFor(targetSchema, step.args.kind);
    const oldByKey = new Map(oldEntity.fields.map((field) => [field.key, field]));
    const targetByKey = new Map(targetEntity.fields.map((field) => [field.key, field]));
    const targetSlots = new Set(targetEntity.fields.filter((field) => field.kind !== 'id').map((field) => field.slot));
    const targetKeys = new Set<string>();
    const clearingSlots = new Set<string>();
    const friendlyNames: string[] = [];
    for (const mapping of mappings) {
      if (mapping.op === 'safe_cast') {
        fail('records_invalid', 'safe_cast is not admitted until the lossless matrix is frozen');
      }
      if ('from' in mapping) friendlyNames.push(mapping.from);
      if ('to' in mapping) friendlyNames.push(mapping.to);
      if ('to' in mapping) {
        if (targetKeys.has(mapping.to)) fail('records_invalid', `migration writes target '${mapping.to}' twice`);
        targetKeys.add(mapping.to);
      }
      if (mapping.op === 'move' || mapping.op === 'clear' || mapping.op === 'relationship') {
        const source = oldByKey.get(mapping.from);
        if (!source || source.kind === 'id') fail('records_invalid', `migration source '${mapping.from}' is unknown/protected`);
        clearingSlots.add(source!.slot);
      }
    }
    assertNoFriendlyPrefixAliases(friendlyNames);
    for (const mapping of mappings) {
      if (mapping.op === 'clear') continue;
      if (mapping.op === 'change_kind' || mapping.op === 'safe_cast') continue;
      const target = targetByKey.get(mapping.to);
      if (!target || target.kind === 'id') fail('records_invalid', `migration target '${mapping.to}' is unknown/protected`);
      if (mapping.op === 'default') continue;
      const source = oldByKey.get(mapping.from);
      if (!source || source.kind === 'id') fail('records_invalid', `migration source '${mapping.from}' is unknown/protected`);
      const admittedSource = source!;
      const admittedTarget = target!;
      if (mapping.op === 'relationship' && (admittedSource.kind !== 'ref' || admittedTarget.kind !== 'ref')) {
        fail('records_invalid', 'relationship mapping requires ref source and target fields');
      }
      if (mapping.op === 'copy' && !targetSlots.has(admittedSource.slot)) {
        fail('records_invalid', `copy source '${mapping.from}' does not remain declared in the target schema`);
      }
      const displaced = oldEntity.fields.find((field) => field.kind !== 'id' && field.slot === admittedTarget.slot);
      if (displaced && displaced.key !== admittedSource.key && !clearingSlots.has(displaced.slot)) {
        fail('records_invalid', `migration target '${mapping.to}' would overwrite '${displaced.key}' without relocation/clear`);
      }
    }
    const preimage = physicalFromRow(current);
    const next = { ...preimage };
    for (const mapping of mappings) {
      if (mapping.op === 'move' || mapping.op === 'clear' || mapping.op === 'relationship') {
        const source = oldByKey.get(mapping.from)!;
        next[source.slot as RecordsSlot] = null;
      }
    }
    for (const mapping of mappings) {
      if (mapping.op === 'clear') continue;
      if (mapping.op === 'change_kind' || mapping.op === 'safe_cast') continue;
      const target = targetByKey.get(mapping.to)!;
      const targetSlot = target.slot as RecordsSlot;
      if (mapping.op === 'default') {
        if (preimage[targetSlot] === null) next[targetSlot] = normalizeField(target, mapping.value);
        continue;
      }
      const source = oldByKey.get(mapping.from)!;
      const value = preimage[source.slot as RecordsSlot];
      if (mapping.op === 'relationship' && value !== null) canonicalRef(value);
      next[targetSlot] = value;
    }
    const changed = SLOT_NAMES.some((slot) => !Object.is(preimage[slot], next[slot]));
    if (!changed) return { changedRows: 0, byteDelta: 0 };
    validateReferences(owner, current.kind, current.pk, next);
    return {
      changedRows: 1,
      byteDelta: persistMigratedRow(owner, current, current.kind, next, stamp),
    };
  };

  const runMigrationTransform = (input: RecordsMigrationStepRunInput): RecordsMigrationBatchResult => {
    const size = migrationBatchSize(input.batch_size);
    const identity = migrationStepIdentity(input.recipe_digest, input.step);
    try {
      return db.transaction(() => {
        const { migration } = requireMigration(input.owner, input.migration_id, input.lock_generation);
        const receipt = admitMigrationStep(input.owner, migration, identity, input.step.args);
        if (receipt.complete) return { done: true, cursor: receipt.cursor, rows_changed: receipt.rows_changed };
        const oldSchema = routeSchema(migration, input.step.args.from_v);
        const targetSchema = routeSchema(migration, input.step.args.new_v);
        entityFor(oldSchema, input.step.args.kind);
        const wrong = db.prepare(`SELECT pk,version FROM ${ROW_TABLE}
          WHERE publisher=? AND pack_slug=? AND kind=? AND version<>? ORDER BY pk LIMIT 1`);
        wrong.safeIntegers(true);
        const wrongRow = wrong.get(
          input.owner.publisher, input.owner.pack_slug, input.step.args.kind, input.step.args.from_v,
        ) as { pk: string; version: bigint } | undefined;
        if (wrongRow) fail('records_incoherent', `migration source ${input.step.args.kind}/${wrongRow.pk} has an unexpected version`);
        const stmt = db.prepare(`SELECT * FROM ${ROW_TABLE}
          WHERE publisher=? AND pack_slug=? AND kind=? AND pk>? ORDER BY pk LIMIT ?`);
        stmt.safeIntegers(true);
        const candidates = stmt.all(
          input.owner.publisher, input.owner.pack_slug, input.step.args.kind, receipt.cursor, size + 1,
        ) as RowShape[];
        const batch = candidates.slice(0, size);
        let changedRows = 0;
        let byteDelta = 0;
        const stamp = now();
        for (const row of batch) {
          const result = applyMigrationMapping(input.owner, row, oldSchema, targetSchema, input.step, stamp);
          changedRows += result.changedRows;
          byteDelta += result.byteDelta;
        }
        updateMigrationAccounting(input.owner, byteDelta, changedRows, stamp);
        const cursor = batch.at(-1)?.pk ?? receipt.cursor;
        const complete = candidates.length <= size;
        recordMigrationBatch(input.owner, input.migration_id, identity, cursor, changedRows, complete);
        const updated = stepRow(input.owner, input.migration_id, identity)!;
        return { done: Boolean(updated.complete), cursor: updated.cursor, rows_changed: updated.rows_changed };
      })();
    } catch (error) {
      markMigrationFailure(input.owner, input.migration_id, error);
      throw error;
    }
  };

  const runMigrationVerify = (input: RecordsMigrationVerifyRunInput): RecordsMigrationBatchResult => {
    const size = migrationBatchSize(input.batch_size);
    const identity = migrationStepIdentity(input.recipe_digest, input.step);
    try {
      return db.transaction(() => {
        const { migration } = requireMigration(input.owner, input.migration_id, input.lock_generation);
        const receipt = admitMigrationStep(input.owner, migration, identity, input.step.args);
        if (receipt.complete) return { done: true, cursor: receipt.cursor, rows_changed: receipt.rows_changed };
        routeSchema(migration, input.step.args.from_v);
        const targetSchema = routeSchema(migration, input.step.args.new_v);
        entityFor(targetSchema, input.step.args.kind);
        const stmt = db.prepare(`SELECT * FROM ${ROW_TABLE}
          WHERE publisher=? AND pack_slug=? AND kind=? AND pk>? ORDER BY pk LIMIT ?`);
        stmt.safeIntegers(true);
        const candidates = stmt.all(
          input.owner.publisher, input.owner.pack_slug, input.step.args.kind, receipt.cursor, size + 1,
        ) as RowShape[];
        const batch = candidates.slice(0, size);
        for (const row of batch) {
          if (safeNumber(row.version, 'row version') !== input.step.args.from_v) {
            fail('records_incoherent', `verify source ${row.kind}/${row.pk} has an unexpected version`);
          }
          assertPhysicalTarget(input.owner, row, targetSchema);
        }
        const cursor = batch.at(-1)?.pk ?? receipt.cursor;
        const complete = candidates.length <= size;
        recordMigrationBatch(input.owner, input.migration_id, identity, cursor, 0, complete);
        const updated = stepRow(input.owner, input.migration_id, identity)!;
        return { done: Boolean(updated.complete), cursor: updated.cursor, rows_changed: updated.rows_changed };
      })();
    } catch (error) {
      markMigrationFailure(input.owner, input.migration_id, error);
      throw error;
    }
  };

  const decodeFinalizerCursor = (cursor: string): [string, string] => {
    if (!cursor) return ['', ''];
    let parsed: unknown;
    try { parsed = JSON.parse(cursor); }
    catch { return fail('records_incoherent', 'finalizer cursor is malformed'); }
    if (!Array.isArray(parsed) || parsed.length !== 2
      || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') {
      fail('records_incoherent', 'finalizer cursor is malformed');
    }
    const tuple = parsed as [string, string];
    return [tuple[0], tuple[1]];
  };

  const runMigrationFinalizer = (input: RecordsMigrationFinalizeRunInput): RecordsMigrationBatchResult => {
    const size = migrationBatchSize(input.batch_size);
    const identity = migrationStepIdentity(input.recipe_digest, input.step);
    try {
      return db.transaction(() => {
        const { migration } = requireMigration(input.owner, input.migration_id, input.lock_generation);
        const required = requiredMigrationSteps(migration);
        const finalizerIndex = required.findIndex((candidate) => sameStep(candidate, identity));
        if (finalizerIndex < 0) fail('records_unauthorized', 'finalizer is not in the locked plan');
        const expectedReceipts = required.slice(0, finalizerIndex).map(({ recipe_digest, step_id, args_hash }) => ({
          recipe_digest, step_id, args_hash,
        }));
        if (canonicalJson(input.required_receipts) !== canonicalJson(expectedReceipts)) {
          fail('records_unauthorized', 'finalizer receipt gate does not match the locked plan');
        }
        const receipt = admitMigrationStep(input.owner, migration, identity, input.step.args);
        if (receipt.complete) return { done: true, cursor: receipt.cursor, rows_changed: receipt.rows_changed };
        routeSchema(migration, input.step.args.from_v);
        const targetSchema = routeSchema(migration, input.step.args.new_v);
        const [cursorKind, cursorPk] = decodeFinalizerCursor(receipt.cursor);
        const behindWhere = receipt.cursor
          ? `AND (kind<? OR (kind=? AND pk<=?)) AND version<>?`
          : `AND 0`;
        const behindParams = receipt.cursor
          ? [cursorKind, cursorKind, cursorPk, input.step.args.new_v]
          : [];
        const badBehind = db.prepare(`SELECT kind,pk,version FROM ${ROW_TABLE}
          WHERE publisher=? AND pack_slug=? ${behindWhere} ORDER BY kind,pk LIMIT 1`);
        badBehind.safeIntegers(true);
        const behind = badBehind.get(
          input.owner.publisher, input.owner.pack_slug, ...behindParams,
        ) as RowShape | undefined;
        if (behind) fail('records_incoherent', `finalizer cursor has uncommitted row ${behind.kind}/${behind.pk} behind it`);
        const aheadWhere = receipt.cursor
          ? `AND (kind>? OR (kind=? AND pk>?))`
          : '';
        const aheadParams = receipt.cursor ? [cursorKind, cursorKind, cursorPk] : [];
        const badAhead = db.prepare(`SELECT kind,pk,version FROM ${ROW_TABLE}
          WHERE publisher=? AND pack_slug=? ${aheadWhere} AND version<>? ORDER BY kind,pk LIMIT 1`);
        badAhead.safeIntegers(true);
        const ahead = badAhead.get(
          input.owner.publisher, input.owner.pack_slug, ...aheadParams, input.step.args.from_v,
        ) as RowShape | undefined;
        if (ahead) fail('records_incoherent', `finalizer found unexpected row version at ${ahead.kind}/${ahead.pk}`);
        const stmt = db.prepare(`SELECT * FROM ${ROW_TABLE}
          WHERE publisher=? AND pack_slug=? ${aheadWhere} ORDER BY kind,pk LIMIT ?`);
        stmt.safeIntegers(true);
        const candidates = stmt.all(
          input.owner.publisher, input.owner.pack_slug, ...aheadParams, size + 1,
        ) as RowShape[];
        const batch = candidates.slice(0, size);
        for (const row of batch) {
          if (safeNumber(row.version, 'row version') !== input.step.args.from_v) {
            fail('records_incoherent', `finalizer source ${row.kind}/${row.pk} has an unexpected version`);
          }
          assertPhysicalTarget(input.owner, row, targetSchema);
          const updated = db.prepare(`UPDATE ${ROW_TABLE} SET version=?
            WHERE publisher=? AND pack_slug=? AND kind=? AND pk=? AND version=?`)
            .run(
              input.step.args.new_v, input.owner.publisher, input.owner.pack_slug,
              row.kind, row.pk, input.step.args.from_v,
            );
          if (updated.changes !== 1) fail('records_conflict', `finalizer lost CAS for ${row.kind}/${row.pk}`);
        }
        const last = batch.at(-1);
        const cursor = last ? canonicalJson([last.kind, last.pk]) : receipt.cursor;
        const complete = candidates.length <= size;
        if (complete) {
          const mismatch = db.prepare(`SELECT kind,pk FROM ${ROW_TABLE}
            WHERE publisher=? AND pack_slug=? AND version<>? ORDER BY kind,pk LIMIT 1`)
            .get(input.owner.publisher, input.owner.pack_slug, input.step.args.new_v) as { kind: string; pk: string } | undefined;
          if (mismatch) fail('records_incoherent', `finalizer left a non-target row at ${mismatch.kind}/${mismatch.pk}`);
        }
        recordMigrationBatch(input.owner, input.migration_id, identity, cursor, batch.length, complete);
        const updated = stepRow(input.owner, input.migration_id, identity)!;
        return { done: Boolean(updated.complete), cursor: updated.cursor, rows_changed: updated.rows_changed };
      })();
    } catch (error) {
      markMigrationFailure(input.owner, input.migration_id, error);
      throw error;
    }
  };

  const promoteMigration = (input: RecordsMigrationPromoteInput): RecordsNamespaceSummary => {
    return db.transaction(() => {
      const { migration } = requireMigration(input.owner, input.migration_id, input.lock_generation);
      const required = requiredMigrationSteps(migration);
      const expectedFinalizer = required.at(-1);
      if (!expectedFinalizer || !sameStep(expectedFinalizer, {
        ...input.finalizer,
        op: 'core.records.finalize-migration',
      })) {
        fail('records_unauthorized', 'promotion finalizer does not match the locked plan');
      }
      for (const step of required) {
        const receipt = stepRow(input.owner, input.migration_id, step);
        if (!receipt?.complete || receipt.args_hash !== step.args_hash || receipt.op !== step.op) {
          fail('records_conflict', `promotion is missing completion receipt '${step.step_id}'`);
        }
      }
      const targetSchema = JSON.parse(migration.target_schema_json) as RecordsSchemaSnapshot;
      // D-221 §6.2 — the target's own natural keys, read from the bindings
      // PERSISTED at `beginMigration`, never from a promote-time argument. The
      // upgrade authority already refuses a rekey on a populated kind, but that
      // gate lives in the coordinator and takes its inputs from a caller; this
      // one re-derives every id from the target declaration itself, so a
      // promotion cannot enter `ready(target)` claiming a key the rows do not
      // satisfy. No mapping op rewrites a `pk` (§ 10.4 — `change_kind` preserves
      // it), so a mismatch here is unrepairable by any route and must refuse.
      const targetNaturalKeys = new Map<string, readonly string[]>();
      for (const bind of Object.values(
        JSON.parse(migration.target_operations_json) as Record<string, RecordsExecutionBinding>,
      )) {
        if (bind.action === 'create'
          && bind.natural_key !== undefined
          && !targetNaturalKeys.has(bind.entity)) {
          targetNaturalKeys.set(bind.entity, bind.natural_key);
        }
      }
      const rows = db.prepare(`SELECT * FROM ${ROW_TABLE}
        WHERE publisher=? AND pack_slug=? ORDER BY kind,pk`);
      rows.safeIntegers(true);
      let actualRows = 0;
      let actualBytes = 0;
      for (const row of rows.iterate(input.owner.publisher, input.owner.pack_slug) as IterableIterator<RowShape>) {
        if (safeNumber(row.version, 'row version') !== migration.target_version) {
          fail('records_incoherent', `promotion found non-target row ${row.kind}/${row.pk}`);
        }
        assertPhysicalTarget(input.owner, row, targetSchema);
        const naturalKey = targetNaturalKeys.get(row.kind);
        if (naturalKey !== undefined) {
          // Re-derive through the SAME function a create uses, from the same
          // friendly shape, so this can never disagree with the id a create
          // would mint for these values.
          const derived = naturalId(
            { entity: row.kind, natural_key: [...naturalKey] } as RecordsExecutionBinding,
            targetSchema,
            projectRow(row, targetSchema),
          );
          if (derived !== row.pk) {
            fail(
              'records_incoherent',
              `promotion found ${row.kind}/${row.pk} at an id the target natural_key does not derive`,
              { entity: row.kind, id: row.pk, derived_id: derived },
            );
          }
        }
        actualRows += 1;
        actualBytes += safeNumber(row.payload_bytes, 'payload_bytes');
      }
      const ns = namespaceRow(input.owner)!;
      if (actualRows !== ns.row_count || actualBytes !== ns.payload_bytes) {
        fail('records_incoherent', 'promotion accounting proof disagrees with namespace totals');
      }
      // The promotion bumps `activation_generation`, so every outstanding cursor
      // names a boundary in a version that no longer exists.
      dropCursors(input.owner);
      const stamp = now();
      const promoted = db.prepare(`UPDATE ${NAMESPACE_TABLE} SET
        state='ready',version=?,from_version=NULL,target_version=NULL,
        storage_schema_hash=?,declaration_hash=?,target_storage_schema_hash=NULL,migration_id=NULL,
        schema_json=?,operations_json=?,migration_plans_json=?,artifact_digest=?,subscriber_digest=?,
        subscribers_json=?,
        activation_generation=activation_generation+1,state_generation=state_generation+1,
        last_known_state=NULL,detected_at=NULL,reason=NULL,evidence_ref=NULL,updated_at=?
        WHERE publisher=? AND pack_slug=? AND state='migrating' AND migration_id=? AND state_generation=?`)
        .run(
          migration.target_version, migration.target_storage_schema_hash, migration.target_declaration_hash,
          migration.target_schema_json, migration.target_operations_json, migration.target_migration_plans_json,
          migration.target_artifact_digest,
          migration.target_subscriber_digest, migration.target_subscribers_json,
          stamp, input.owner.publisher, input.owner.pack_slug,
          input.migration_id, input.lock_generation,
        );
      if (promoted.changes !== 1) fail('records_conflict', 'migration promotion lost its lock fence');
      db.prepare(`UPDATE ${MIGRATION_TABLE} SET status='complete',error=NULL,updated_at=?
        WHERE publisher=? AND pack_slug=? AND migration_id=?`)
        .run(stamp, input.owner.publisher, input.owner.pack_slug, input.migration_id);
      return summary(namespaceRow(input.owner)!);
    })();
  };

  const preflightMigration = (
    input: RecordsMigrationPreflightInput,
  ): RecordsMigrationPreflightResult => {
    if (input.ordered_steps.length < 1
      || input.ordered_steps.at(-1)?.step.op !== 'core.records.finalize-migration') {
      fail('records_invalid', 'migration preflight requires the complete ordered plan');
    }
    const rollback = Symbol('records-migration-preflight-rollback');
    const beforeBytes = requireValue(
      namespaceRow(input.start.owner),
      'records_not_found',
      'Records migration namespace was not found',
    ).payload_bytes;
    let result: RecordsMigrationPreflightResult = {
      batches: 0,
      rows_changed: 0,
      byte_delta: 0,
    };
    try {
      db.transaction(() => {
        const migration = beginMigration(input.start);
        for (let index = 0; index < input.ordered_steps.length; index += 1) {
          const entry = input.ordered_steps[index]!;
          for (let batch = 0; batch < 1_000_000; batch += 1) {
            let outcome: RecordsMigrationBatchResult;
            if (entry.step.op === 'core.records.migrate') {
              outcome = runMigrationTransform({
                owner: input.start.owner,
                migration_id: input.start.migration_id,
                lock_generation: migration.lock_generation,
                recipe_digest: entry.recipe_digest,
                step: entry.step,
              });
            } else if (entry.step.op === 'core.records.verify-migration') {
              outcome = runMigrationVerify({
                owner: input.start.owner,
                migration_id: input.start.migration_id,
                lock_generation: migration.lock_generation,
                recipe_digest: entry.recipe_digest,
                step: entry.step,
              });
            } else {
              const requiredReceipts = input.ordered_steps.slice(0, index).map((prior) => ({
                recipe_digest: prior.recipe_digest,
                step_id: prior.step.id,
                args_hash: prior.step.args_hash,
              }));
              outcome = runMigrationFinalizer({
                owner: input.start.owner,
                migration_id: input.start.migration_id,
                lock_generation: migration.lock_generation,
                recipe_digest: entry.recipe_digest,
                step: entry.step,
                required_receipts: requiredReceipts,
              });
            }
            result = {
              batches: result.batches + 1,
              rows_changed: result.rows_changed + (outcome.done ? outcome.rows_changed : 0),
              byte_delta: result.byte_delta,
            };
            if (outcome.done) break;
            if (batch === 999_999) fail('records_invalid', 'migration preflight exceeded the bounded batch count');
          }
        }
        const final = input.ordered_steps.at(-1)!;
        promoteMigration({
          owner: input.start.owner,
          migration_id: input.start.migration_id,
          lock_generation: migration.lock_generation,
          finalizer: {
            recipe_digest: final.recipe_digest,
            step_id: final.step.id,
            args_hash: final.step.args_hash,
          },
        });
        result.byte_delta = namespaceRow(input.start.owner)!.payload_bytes - beforeBytes;
        throw rollback;
      })();
    } catch (error) {
      if (error !== rollback) throw error;
    }
    return result;
  };

  const execute = (call: RecordsExecutionCall): unknown => {
    if (!call || typeof call.principal !== 'string' || call.principal.length === 0) {
      fail('records_unauthorized', 'Records execution requires a derived principal');
    }
    assertJsonTree(call.args, '$.args');
    assertExecutionAdmitted(call);
    const { namespace, schema } = requireState(call.binding, ['create','update','upsert','delete'].includes(call.binding.action));
    switch (call.binding.action) {
      case 'batch': return batchWrite(call, namespace, schema);
      case 'create': return createRecord(call, namespace, schema);
      case 'get': return getOne(call.binding, call.args, schema);
      case 'get_many': return getMany(call.binding, call.args, schema);
      case 'search': return search(call.binding, call.args, namespace, schema);
      case 'count': return count(call.binding, call.args, namespace, schema);
      case 'aggregate': return aggregate(call.binding, call.args, namespace, schema);
      case 'update': return updateRecord(call, namespace, schema);
      case 'delete': return deleteRecord(call, schema);
      case 'upsert': {
        // An `upsert` cannot coexist with a natural_key entity: its insert half
        // would seat a caller-chosen id on a derived-id tuple, and its update
        // half rewrites every field — including the immutable key components —
        // so it could only ever refuse. Install refuses the pair outright
        // (authoring §5.2); this is the store-side floor for a namespace whose
        // bindings were written some other way.
        if (declaredNaturalKey(namespace, call.binding.entity) !== undefined) {
          fail('records_invalid', `upsert is not admitted on natural_key entity '${call.binding.entity}'`);
        }
        const id = assertId(call.args.id);
        const expectedVersion = assertSafePositive(call.args.expected_version, 'expected_version');
        if (expectedVersion !== namespace.version) {
          fail('records_conflict', 'stale Records version', {
            current_version: namespace.version,
            expected_version: expectedVersion,
          });
        }
        const existing = rowStmt(call.binding.owner, call.binding.entity, id);
        if (!existing) {
          if (call.args.expected_revision !== undefined) {
            fail('records_conflict', 'upsert insert refuses expected_revision');
          }
          return createRecord({ ...call, args: { id, values: call.args.values } }, namespace, schema);
        }
        if (call.args.expected_revision === undefined) {
          fail('records_conflict', 'upsert existing row requires expected_revision', {
            current_revision: safeNumber(existing.revision, 'revision'),
          });
        }
        const full = normalizeValues(schema, call.binding.entity, call.args.values, 'full');
        const setObject: Record<string, unknown> = {};
        for (const field of entityFor(schema, call.binding.entity).fields) {
          if (field.kind === 'id') continue;
          setPath(setObject, field.key, wireValue(field, full.physical[field.slot as RecordsSlot]));
        }
        return updateRecord({
          ...call,
          args: {
            id,
            expected_version: expectedVersion,
            expected_revision: call.args.expected_revision,
            set: setObject,
            unset: [],
          },
        }, namespace, schema);
      }
    }
  };

  const ownerBinding = (
    ns: NamespaceRow,
    entity: string,
    action: RecordsExecutionBinding['action'] = 'search',
  ): RecordsExecutionBinding => ({
    kind: 'core.records',
    action,
    entity,
    owner: { publisher: ns.publisher, pack_slug: ns.pack_slug },
    pack_version: ns.version ?? 1,
    storage_schema_hash: ns.storage_schema_hash ?? '',
    declaration_hash: ns.declaration_hash ?? '',
    operation_digest: `owner-control:${ns.activation_generation}`,
  });

  const ownerGet = (owner: RecordsPackRef, entity: string, id: string): RecordsFriendlyRecord | null => {
    assertPackRef(owner);
    const ns = namespaceRow(owner);
    if (!ns) return null;
    if (ns.state !== 'ready' && ns.state !== 'orphaned' && ns.state !== 'incoherent') {
      fail('records_not_ready', `namespace is ${ns.state}`);
    }
    const schema = JSON.parse(ns.schema_json) as RecordsSchemaSnapshot;
    entityFor(schema, entity);
    const row = rowStmt(owner, entity, assertId(id));
    return row ? projectRow(row, schema) : null;
  };

  const ownerInspect = (
    owner: RecordsPackRef,
    entity: string,
    id: string,
  ): { record: RecordsFriendlyRecord | null; diagnostics: RecordsOwnerRecordDiagnostics | null } => {
    assertPackRef(owner);
    const ns = namespaceRow(owner);
    if (!ns) return { record: null, diagnostics: null };
    if (ns.state !== 'ready' && ns.state !== 'orphaned' && ns.state !== 'incoherent') {
      fail('records_not_ready', `namespace is ${ns.state}`);
    }
    const schema = JSON.parse(ns.schema_json) as RecordsSchemaSnapshot;
    entityFor(schema, entity);
    const row = rowStmt(owner, entity, assertId(id));
    if (!row) return { record: null, diagnostics: null };
    const raw = physicalFromRow(row);
    const rawSlots = Object.fromEntries(SLOT_NAMES.map((slot) => {
      const value = raw[slot];
      return [slot, typeof value === 'bigint' ? value.toString() : value];
    })) as RecordsOwnerRecordDiagnostics['raw_slots'];
    const edges = db.prepare(`SELECT source_kind,source_pk,source_slot,target_kind,target_pk
      FROM ${REVERSE_TABLE}
      WHERE publisher=? AND pack_slug=?
        AND ((source_kind=? AND source_pk=?) OR (target_kind=? AND target_pk=?))
      ORDER BY source_kind,source_pk,source_slot,target_kind,target_pk`)
      .all(owner.publisher, owner.pack_slug, entity, id, entity, id) as Array<{
        source_kind: string;
        source_pk: string;
        source_slot: RecordsSlot;
        target_kind: string;
        target_pk: string;
      }>;
    const impacts = edges.map((edge) => {
      const sourceField = requireValue(
        entityFor(schema, edge.source_kind).fields.find((field) => field.slot === edge.source_slot),
        'records_incoherent',
        'reverse-reference index points at an unknown schema slot',
      );
      if (sourceField.kind !== 'ref') {
        fail('records_incoherent', 'reverse-reference index points at a non-reference schema slot');
      }
      return {
        source_entity: edge.source_kind,
        source_id: edge.source_pk,
        source_field: sourceField.key,
        source_slot: edge.source_slot,
        target_entity: edge.target_kind,
        target_id: edge.target_pk,
      };
    });
    return {
      record: projectRow(row, schema),
      diagnostics: {
        raw_slots: rawSlots,
        outgoing: impacts.filter((impact) =>
          impact.source_entity === entity && impact.source_id === id),
        incoming: impacts.filter((impact) =>
          impact.target_entity === entity && impact.target_id === id),
      },
    };
  };

  const exportNamespace = (owner: RecordsPackRef, onlyEntity?: string): RecordsExportEnvelope => {
    const tx = db.transaction(() => {
      const ns = requireValue(namespaceRow(owner), 'records_not_found', 'Records namespace was not found');
      if (ns.state === 'migrating') fail('records_not_ready', 'export waits for migration to finish');
      const schema = JSON.parse(ns.schema_json) as RecordsSchemaSnapshot;
      if (onlyEntity) entityFor(schema, onlyEntity);
      const entities = onlyEntity ? [onlyEntity] : Object.keys(schema.entities).sort();
      // ⛔ Export is the one read that CANNOT stream: it returns a single
      // digest-signed envelope, so the whole selection is in memory by
      // construction. Streaming it would change the public
      // `RecordsExportEnvelope` contract, so instead it refuses up front on the
      // accounting the namespace already keeps — O(1), no scan — rather than
      // discovering the limit by exhausting the process. A whole-namespace
      // export over budget has a real exit (per entity); a single entity over
      // budget is an honest statement of the envelope's limit.
      const selectedBytes = onlyEntity === undefined
        ? safeNumber(ns.payload_bytes, 'payload_bytes')
        : (db.prepare(`SELECT coalesce(sum(payload_bytes),0) AS b FROM ${ROW_TABLE}
            WHERE publisher=? AND pack_slug=? AND kind=?`)
            .get(owner.publisher, owner.pack_slug, onlyEntity) as { b: number | bigint }).b;
      if (Number(selectedBytes) > RECORDS_MAX_EXPORT_BYTES) {
        fail('records_query_budget',
          `export exceeds the ${RECORDS_MAX_EXPORT_BYTES}-byte envelope budget`
          + (onlyEntity === undefined
            ? '; export one kind at a time instead'
            : `; kind '${onlyEntity}' is too large for a single export envelope`),
          { selected_bytes: Number(selectedBytes), budget_bytes: RECORDS_MAX_EXPORT_BYTES });
      }
      const records: Record<string, RecordsFriendlyRecord[]> = {};
      for (const entity of entities) {
        const stmt = db.prepare(`SELECT * FROM ${ROW_TABLE} WHERE publisher=? AND pack_slug=? AND kind=? ORDER BY pk`);
        stmt.safeIntegers(true);
        records[entity] = (stmt.all(owner.publisher, owner.pack_slug, entity) as RowShape[])
          .map((row) => projectRow(row, schema));
      }
      const unsigned = {
        format: 'recued.records.v1' as const,
        owner,
        version: ns.version ?? 0,
        activation_generation: ns.activation_generation,
        data_generation: ns.data_generation,
        storage_schema_hash: ns.storage_schema_hash ?? '',
        declaration_hash: ns.declaration_hash ?? '',
        schema,
        records,
        exported_at: now(),
      };
      return { ...unsigned, digest: sha256(canonicalJson(unsigned)) };
    });
    return tx();
  };

  const exportNamespaceCsv = (owner: RecordsPackRef, onlyEntity?: string): RecordsCsvExportEnvelope => {
    const snapshot = exportNamespace(owner, onlyEntity);
    const entities = Object.keys(snapshot.records).sort();
    const qualifiedFields = entities.flatMap((entity) =>
      snapshot.schema.entities[entity]!.fields
        .filter((field) => field.kind !== 'id')
        .map((field) => `${entity}.${field.key}`));
    const headers = [
      'pack_publisher', 'pack_slug', 'pack_version', 'activation_generation',
      'data_generation', 'storage_schema_hash', 'declaration_hash', 'schema_json',
      'kind', 'id', 'record_version', 'record_revision', 'created_at', 'updated_at',
      ...qualifiedFields,
    ];
    const schemaJson = canonicalJson(snapshot.schema);
    const common = [
      snapshot.owner.publisher,
      snapshot.owner.pack_slug,
      snapshot.version,
      snapshot.activation_generation,
      snapshot.data_generation,
      snapshot.storage_schema_hash,
      snapshot.declaration_hash,
      schemaJson,
    ];
    const lines = [headers.map(csvCell).join(',')];
    let emitted = false;
    for (const entity of entities) {
      for (const record of snapshot.records[entity]!) {
        emitted = true;
        const values = qualifiedFields.map((qualified) => {
          const separator = qualified.indexOf('.');
          const qualifiedEntity = qualified.slice(0, separator);
          const field = qualified.slice(separator + 1);
          return qualifiedEntity === entity ? pathValue(record, field).value : undefined;
        });
        lines.push([
          ...common,
          entity,
          record.id,
          record._record.version,
          record._record.revision,
          record._record.created_at,
          record._record.updated_at,
          ...values,
        ].map(csvCell).join(','));
      }
    }
    // A zero-row export still carries the schema/version checkpoint as a valid
    // CSV data row rather than degenerating into an unbound header artifact.
    if (!emitted) {
      lines.push([...common, '', '', '', '', '', '', ...qualifiedFields.map(() => '')]
        .map(csvCell).join(','));
    }
    const unsigned = {
      format: 'recued.records.csv.v1' as const,
      owner: snapshot.owner,
      version: snapshot.version,
      activation_generation: snapshot.activation_generation,
      data_generation: snapshot.data_generation,
      storage_schema_hash: snapshot.storage_schema_hash,
      declaration_hash: snapshot.declaration_hash,
      schema: snapshot.schema,
      csv: `${lines.join('\r\n')}\r\n`,
      exported_at: snapshot.exported_at,
    };
    return { ...unsigned, digest: sha256(canonicalJson(unsigned)) };
  };

  const eventPointer = (row: Record<string, unknown>): RecordsEventPointer => ({
    event_id: row.event_id as string,
    type: row.event_type as RecordsEventPointer['type'],
    owner: { publisher: row.publisher as string, pack_slug: row.pack_slug as string },
    entity: row.kind as string,
    id: row.pk as string,
    revision: Number(row.event_revision),
    changed_fields: JSON.parse(row.changed_fields_json as string) as string[],
    activation_generation: Number(row.activation_generation),
    subscriber_digest: row.subscriber_digest as string,
    cause: row.cause as RecordsMutationCause,
    created_at: Number(row.created_at),
  });

  const getOutboxOverview = (
    owner: RecordsPackRef,
    status?: RecordsOutboxStatus,
    limit = 100,
  ): RecordsOutboxOverview => {
    assertPackRef(owner);
    requireValue(namespaceRow(owner), 'records_not_found', 'Records namespace was not found');
    if (status !== undefined && !['pending', 'delivered', 'dead_letter'].includes(status)) {
      fail('records_invalid', 'outbox status is invalid');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      fail('records_invalid', 'outbox diagnostic limit must be an integer in 1..500');
    }
    const counts = db.prepare(`SELECT
      sum(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      sum(CASE WHEN status='delivered' THEN 1 ELSE 0 END) AS delivered,
      sum(CASE WHEN status='dead_letter' THEN 1 ELSE 0 END) AS dead_letter,
      coalesce(sum(retry_count),0) AS total_retries,
      min(CASE WHEN status='pending' THEN created_at END) AS oldest_pending_at
      FROM ${OUTBOX_TABLE} WHERE publisher=? AND pack_slug=?`)
      .get(owner.publisher, owner.pack_slug) as {
        pending: number | null;
        delivered: number | null;
        dead_letter: number | null;
        total_retries: number;
        oldest_pending_at: number | null;
      };
    const whereStatus = status === undefined ? '' : ' AND o.status=?';
    const params: Array<string | number> = status === undefined
      ? [owner.publisher, owner.pack_slug, limit]
      : [owner.publisher, owner.pack_slug, status, limit];
    const eventRows = db.prepare(`SELECT o.* FROM ${OUTBOX_TABLE} o
      WHERE o.publisher=? AND o.pack_slug=?${whereStatus}
      ORDER BY CASE o.status WHEN 'pending' THEN 0 WHEN 'dead_letter' THEN 1 ELSE 2 END,
        o.created_at,o.event_id LIMIT ?`).all(...params) as Array<Record<string, unknown>>;
    const deliveryStmt = db.prepare(`SELECT binding_digest,recipe_id,status,retry_count,error
      FROM ${OUTBOX_DELIVERY_TABLE} WHERE event_id=? ORDER BY binding_digest`);
    const oldestPendingAt = counts.oldest_pending_at ?? undefined;
    return {
      pending: counts.pending ?? 0,
      delivered: counts.delivered ?? 0,
      dead_letter: counts.dead_letter ?? 0,
      total_retries: counts.total_retries,
      ...(oldestPendingAt === undefined ? {} : {
        oldest_pending_at: oldestPendingAt,
        oldest_pending_age_ms: Math.max(0, now() - oldestPendingAt),
      }),
      events: eventRows.map((row) => ({
        event: eventPointer(row),
        status: row.status as RecordsOutboxStatus,
        retry_count: Number(row.retry_count),
        ...(typeof row.error === 'string' ? { error: row.error } : {}),
        deliveries: (deliveryStmt.all(row.event_id) as Array<{
          binding_digest: string;
          recipe_id: string;
          status: RecordsOutboxStatus;
          retry_count: number;
          error: string | null;
        }>).map((delivery) => ({
          binding_digest: delivery.binding_digest,
          recipe_id: delivery.recipe_id,
          status: delivery.status,
          retry_count: delivery.retry_count,
          ...(delivery.error === null ? {} : { error: delivery.error }),
        })),
      })),
    };
  };

  const retireOutboxEvent = (
    owner: RecordsPackRef,
    eventId: string,
    confirmation: string,
  ): boolean => {
    assertPackRef(owner);
    if (!eventId || confirmation !== eventId) {
      fail('records_invalid', 'event retirement confirmation must equal the exact event id');
    }
    return db.transaction(() => {
      const row = requireValue(db.prepare(`SELECT publisher,pack_slug,status FROM ${OUTBOX_TABLE}
        WHERE event_id=?`).get(eventId) as {
          publisher: string;
          pack_slug: string;
          status: RecordsOutboxStatus;
        } | undefined, 'records_not_found', 'Records event was not found in that namespace');
      if (row.publisher !== owner.publisher || row.pack_slug !== owner.pack_slug) {
        fail('records_not_found', 'Records event was not found in that namespace');
      }
      if (row.status === 'dead_letter') return true;
      if (row.status !== 'pending') fail('records_conflict', 'only a pending event can be retired');
      const reason = 'owner explicitly retired pending Records event';
      db.prepare(`UPDATE ${OUTBOX_DELIVERY_TABLE} SET status='dead_letter',error=?
        WHERE event_id=? AND status='pending'`).run(reason, eventId);
      const changed = db.prepare(`UPDATE ${OUTBOX_TABLE} SET status='dead_letter',error=?,delivered_at=?
        WHERE event_id=? AND status='pending'`).run(reason, now(), eventId);
      if (changed.changes !== 1) fail('records_conflict', 'Records event changed during retirement');
      decrementOutboxAccounting(owner, now());
      return true;
    })();
  };

  const purgeNamespaceRows = (
    owner: RecordsPackRef,
    confirmation: string,
    requireOrphaned: boolean,
  ): { rows_deleted: number; events_deleted: number } => {
    assertPackRef(owner);
    if (confirmation !== `${owner.publisher}/${owner.pack_slug}`) {
      fail('records_invalid', 'purge confirmation must equal the full pack reference');
    }
    const ns = namespaceRow(owner);
    if (!ns) return { rows_deleted: 0, events_deleted: 0 };
    if (ns.state === 'migrating') fail('records_not_ready', 'cannot purge an in-progress migration');
    if (requireOrphaned && ns.state !== 'orphaned') {
      fail('records_not_ready', 'owner bulk purge requires an orphaned namespace; uninstall the pack first');
    }
    return db.transaction(() => {
      // Recheck in the same write transaction so a concurrent reattachment
      // cannot turn an approved orphan purge into installed-code data loss.
      const current = requireValue(namespaceRow(owner), 'records_not_found', 'Records namespace was not found');
      if (requireOrphaned && current.state !== 'orphaned') {
        fail('records_conflict', 'Records namespace changed before purge');
      }
      db.prepare(`DELETE FROM ${REVERSE_TABLE} WHERE publisher=? AND pack_slug=?`).run(owner.publisher, owner.pack_slug);
      const rows = db.prepare(`DELETE FROM ${ROW_TABLE} WHERE publisher=? AND pack_slug=?`).run(owner.publisher, owner.pack_slug).changes;
      const events = db.prepare(`DELETE FROM ${OUTBOX_TABLE} WHERE publisher=? AND pack_slug=?`).run(owner.publisher, owner.pack_slug).changes;
      db.prepare(`DELETE FROM ${RETENTION_TABLE} WHERE publisher=? AND pack_slug=?`).run(owner.publisher, owner.pack_slug);
      dropCursors(owner);
      db.prepare(`DELETE FROM ${RECEIPT_TABLE} WHERE publisher=? AND pack_slug=?`).run(owner.publisher, owner.pack_slug);
      db.prepare(`DELETE FROM ${MIGRATION_STEP_TABLE} WHERE publisher=? AND pack_slug=?`).run(owner.publisher, owner.pack_slug);
      db.prepare(`DELETE FROM ${MIGRATION_TABLE} WHERE publisher=? AND pack_slug=?`).run(owner.publisher, owner.pack_slug);
      db.prepare(`DELETE FROM ${NAMESPACE_TABLE} WHERE publisher=? AND pack_slug=?`).run(owner.publisher, owner.pack_slug);
      return { rows_deleted: rows, events_deleted: events };
    })();
  };

  const acquireExecutionLease = (
    input: RecordsExecutionLeaseInput,
  ): RecordsExecutionLease => {
    if (!input || typeof input.lease_id !== 'string' || input.lease_id.length === 0
      || typeof input.recipe_id !== 'string' || input.recipe_id.length === 0
      || typeof input.caller_pack !== 'string' || input.caller_pack.length === 0) {
      fail('records_invalid', 'Records execution lease requires a run, recipe, and caller-pack identity');
    }
    if (!Array.isArray(input.targets) || input.targets.length === 0) {
      fail('records_invalid', 'Records execution lease requires at least one namespace target');
    }
    if (activeLeases.has(input.lease_id)) {
      fail('records_conflict', `Records execution lease '${input.lease_id}' is already active`);
    }
    const targets = new Map<string, number>();
    for (const target of input.targets) {
      const { namespace } = requireState(target.binding);
      const key = namespaceKey(target.binding.owner);
      if (namespaceFences.has(key)) {
        fail(
          'records_not_ready',
          `Records namespace '${target.binding.owner.publisher}/${target.binding.owner.pack_slug}' is fenced`,
          undefined,
          true,
        );
      }
      const prior = targets.get(key);
      if (prior !== undefined && prior !== namespace.activation_generation) {
        fail('records_conflict', 'one run resolved conflicting Records activation generations');
      }
      targets.set(key, namespace.activation_generation);
    }
    activeLeases.set(input.lease_id, {
      lease_id: input.lease_id,
      recipe_id: input.recipe_id,
      caller_pack: input.caller_pack,
      targets,
    });
    let released = false;
    return {
      lease_id: input.lease_id,
      release() {
        if (released) return;
        released = true;
        const lease = activeLeases.get(input.lease_id);
        if (!lease) return;
        activeLeases.delete(input.lease_id);
        for (const key of lease.targets.keys()) signalQuiescence(key);
      },
    };
  };

  const fenceNamespace = (input: RecordsNamespaceFenceInput): RecordsNamespaceFence => {
    assertPackRef(input.owner);
    assertSafeNonNegative(input.expected_activation_generation, 'expected activation generation');
    const ns = requireValue(namespaceRow(input.owner), 'records_not_found', 'Records namespace was not found');
    if (ns.state !== 'ready' && ns.state !== 'orphaned') {
      fail(ns.state === 'incoherent' ? 'records_incoherent' : 'records_not_ready', `cannot fence namespace in state '${ns.state}'`);
    }
    if (ns.activation_generation !== input.expected_activation_generation) {
      fail('records_conflict', 'Records namespace activation changed before its execution fence');
    }
    const key = namespaceKey(input.owner);
    if (namespaceFences.has(key)) fail('records_conflict', 'Records namespace is already fenced');
    const fence: RecordsNamespaceFence = {
      fence_id: `records-fence:${randomUUID()}`,
      owner: { ...input.owner },
      activation_generation: ns.activation_generation,
    };
    namespaceFences.set(key, fence);
    return fence;
  };

  const waitForNamespaceQuiescence = async (
    input: RecordsNamespaceQuiescenceInput,
  ): Promise<RecordsNamespaceQuiescenceResult> => {
    if (!Number.isSafeInteger(input.timeout_ms) || input.timeout_ms < 0 || input.timeout_ms > 120_000) {
      fail('records_invalid', 'Records quiescence timeout must be an integer in 0..120000ms');
    }
    const key = namespaceKey(input.owner);
    const deadline = Date.now() + input.timeout_ms;
    for (;;) {
      const fence = namespaceFences.get(key);
      if (!fence || fence.fence_id !== input.fence_id
        || fence.activation_generation !== input.activation_generation) {
        fail('records_conflict', 'Records namespace quiescence fence is stale');
      }
      const blockers = blockersFor(input.owner, input.activation_generation);
      if (blockers.length === 0) return { drained: true, blockers: [] };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { drained: false, blockers };
      await new Promise<void>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout>;
        const wake = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          quiescenceWaiters.get(key)?.delete(wake);
          resolve();
        };
        const waiters = quiescenceWaiters.get(key) ?? new Set<() => void>();
        waiters.add(wake);
        quiescenceWaiters.set(key, waiters);
        timer = setTimeout(wake, remaining);
      });
    }
  };

  const releaseNamespaceFence = (fence: RecordsNamespaceFence): void => {
    const key = namespaceKey(fence.owner);
    const current = namespaceFences.get(key);
    if (!current || current.fence_id !== fence.fence_id) return;
    namespaceFences.delete(key);
    signalQuiescence(key);
  };

  const assertUpdateReviewFence = (fence: RecordsUpdateReviewFence): void => {
    assertPackRef(fence.owner);
    const namespace = namespaceRow(fence.owner);
    if (namespace === undefined) {
      fail('records_conflict', 'Records update review namespace no longer exists');
    }
    const retentionRows = db.prepare(`SELECT kind,policy_json FROM ${RETENTION_TABLE}
      WHERE publisher=? AND pack_slug=? ORDER BY kind`)
      .all(fence.owner.publisher, fence.owner.pack_slug) as Array<{
        kind: string;
        policy_json: string;
      }>;
    const retention = Object.fromEntries(retentionRows.map((row) => [
      row.kind,
      JSON.parse(row.policy_json) as RecordsRetentionPolicy,
    ]));
    if (
      recordsNamespaceReviewDigest(summary(namespace!)) !== fence.current_snapshot_digest
      || recordsOwnerPolicyDigest({ retention, global_quota: globalQuota() }) !== fence.owner_policy_digest
    ) {
      fail('records_conflict', 'Records update review became stale');
    }
  };

  const countActiveExecutionLeases = (owner: RecordsPackRef): number => {
    assertPackRef(owner);
    const key = namespaceKey(owner);
    let count = 0;
    for (const lease of activeLeases.values()) {
      if (lease.targets.has(key)) count += 1;
    }
    return count;
  };

  const finishEventWhenTargetsTerminal = (eventId: string): void => {
    const event = db.prepare(`SELECT publisher,pack_slug,status FROM ${OUTBOX_TABLE} WHERE event_id=?`)
      .get(eventId) as { publisher: string; pack_slug: string; status: string } | undefined;
    if (!event || event.status !== 'pending') return;
    const targets = db.prepare(`SELECT
      count(*) AS total,
      sum(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      sum(CASE WHEN status='dead_letter' THEN 1 ELSE 0 END) AS dead
      FROM ${OUTBOX_DELIVERY_TABLE} WHERE event_id=?`)
      .get(eventId) as { total: number; pending: number | null; dead: number | null };
    if ((targets.pending ?? 0) > 0) return;
    const status = (targets.dead ?? 0) > 0 ? 'dead_letter' : 'delivered';
    const changed = db.prepare(`UPDATE ${OUTBOX_TABLE} SET status=?,delivered_at=?,
      error=CASE WHEN ?='dead_letter' THEN 'one or more watcher targets dead-lettered' ELSE error END
      WHERE event_id=? AND status='pending'`)
      .run(status, now(), status, eventId);
    if (changed.changes === 1) {
      decrementOutboxAccounting({
        publisher: event.publisher,
        pack_slug: event.pack_slug,
      }, now());
    }
  };

  // One pass at construction, so a server that stops paging entirely converges to
  // empty instead of holding whatever the last session left behind.
  sweepCursors();

  return {
    installNamespace,
    beginMigration,
    getMigration(owner) {
      assertPackRef(owner);
      const row = migrationRow(owner);
      return row ? migrationView(row) : null;
    },
    getInstalledMigrationPlans(owner) {
      assertPackRef(owner);
      const row = namespaceRow(owner);
      if (!row) return [];
      try {
        const plans = JSON.parse(row.migration_plans_json) as unknown;
        return Array.isArray(plans) ? plans as RecordsMigrationPlan[] : [];
      } catch {
        return fail('records_incoherent', 'installed migration authority snapshot is unreadable');
      }
    },
    runMigrationTransform,
    runMigrationVerify,
    runMigrationFinalizer,
    promoteMigration,
    preflightMigration,
    acquireExecutionLease,
    fenceNamespace,
    waitForNamespaceQuiescence,
    releaseNamespaceFence,
    assertUpdateReviewFence,
    countActiveExecutionLeases,
    execute,
    getNamespace(owner) {
      assertPackRef(owner);
      const row = namespaceRow(owner);
      return row ? summary(row) : null;
    },
    listNamespaces() {
      return (db.prepare(`SELECT * FROM ${NAMESPACE_TABLE} ORDER BY publisher,pack_slug`).all() as NamespaceRow[]).map(summary);
    },
    listKinds(owner) {
      assertPackRef(owner);
      const ns = requireValue(namespaceRow(owner), 'records_not_found', 'Records namespace was not found');
      const counts = db.prepare(`SELECT kind,count(*) AS rows,coalesce(sum(payload_bytes),0) AS payload_bytes
        FROM ${ROW_TABLE} WHERE publisher=? AND pack_slug=? GROUP BY kind ORDER BY kind`)
        .all(owner.publisher, owner.pack_slug) as Array<{ kind: string; rows: number; payload_bytes: number }>;
      const byKind = new Map(counts.map((entry) => [entry.kind, entry]));
      const schema = JSON.parse(ns.schema_json) as RecordsSchemaSnapshot;
      return Object.keys(schema.entities).sort().map((kind) =>
        byKind.get(kind) ?? { kind, rows: 0, payload_bytes: 0 });
    },
    ownerSearch(input) {
      const ns = requireValue(namespaceRow(input.owner), 'records_not_found', 'Records namespace was not found');
      const schema = JSON.parse(ns.schema_json) as RecordsSchemaSnapshot;
      entityFor(schema, input.entity);
      const binding = ownerBinding(ns, input.entity);
      return search(binding, {
        ...(input.filters !== undefined ? { filters: input.filters } : {}),
        ...(input.sort !== undefined ? { sort: input.sort } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      }, ns, schema, true, input.include_orphaned ?? true);
    },
    ownerGet,
    ownerInspect,
    ownerDelete(input) {
      assertOwnerMutationNotFenced(input.owner);
      const ns = requireValue(namespaceRow(input.owner), 'records_not_found', 'Records namespace was not found');
      if (ns.state !== 'ready') fail('records_not_ready', 'owner delete requires a ready namespace');
      const schema = JSON.parse(ns.schema_json) as RecordsSchemaSnapshot;
      entityFor(schema, input.entity);
      // Privacy/recovery deletion is an owner control-plane capability, not a
      // business operation the pack must choose to publish. It still goes
      // through the same CAS/ref/quota/outbox transaction as recipe delete.
      const deleteBinding = ownerBinding(ns, input.entity, 'delete');
      return deleteRecord({
        binding: deleteBinding,
        args: {
          id: input.id,
          expected_version: input.expected_version,
          expected_revision: input.expected_revision,
        },
        principal: input.principal,
        cause: 'owner_delete',
      }, schema, true);
    },
    setQuota(owner, input) {
      assertOwnerMutationNotFenced(owner);
      const ns = requireValue(namespaceRow(owner), 'records_not_found', 'Records namespace was not found');
      if (ns.state === 'migrating') fail('records_not_ready', 'quota changes are fenced during migration');
      const nextRows = input.row_limit ?? ns.row_limit;
      const nextBytes = input.byte_limit ?? ns.byte_limit;
      const nextOutbox = input.outbox_limit ?? ns.outbox_limit;
      for (const [name, value] of Object.entries({ row_limit: nextRows, byte_limit: nextBytes, outbox_limit: nextOutbox })) {
        if (!Number.isSafeInteger(value) || value < 0) fail('records_invalid', `${name} must be a non-negative safe integer`);
      }
      if (nextRows < ns.row_count || nextBytes < ns.payload_bytes || nextOutbox < ns.outbox_count) {
        fail('records_quota_exceeded', 'quota cannot be lowered below current usage/backlog');
      }
      db.prepare(`UPDATE ${NAMESPACE_TABLE} SET row_limit=?,byte_limit=?,outbox_limit=?,state_generation=state_generation+1,updated_at=?
        WHERE publisher=? AND pack_slug=?`).run(nextRows, nextBytes, nextOutbox, now(), owner.publisher, owner.pack_slug);
      return summary(namespaceRow(owner)!).quota;
    },
    getGlobalQuota() {
      return globalQuota();
    },
    setGlobalQuota(input) {
      const current = globalQuota();
      const next = {
        row_limit: input.row_limit ?? current.row_limit,
        byte_limit: input.byte_limit ?? current.byte_limit,
        outbox_limit: input.outbox_limit ?? current.outbox_limit,
      };
      for (const [name, value] of Object.entries(next)) {
        if (!Number.isSafeInteger(value) || value < 0) {
          fail('records_invalid', `global ${name} must be a non-negative safe integer`);
        }
      }
      if (next.row_limit < current.row_count
        || next.byte_limit < current.payload_bytes + current.reserved_payload_bytes
        || next.outbox_limit < current.outbox_count) {
        fail('records_quota_exceeded', 'global quota cannot be lowered below current usage/backlog');
      }
      db.transaction(() => {
        const put = db.prepare(`INSERT INTO ${META_TABLE}(key,value) VALUES (?,?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
        put.run('records.global.row_limit', String(next.row_limit));
        put.run('records.global.byte_limit', String(next.byte_limit));
        put.run('records.global.outbox_limit', String(next.outbox_limit));
      })();
      return globalQuota();
    },
    setRetention(owner, entity, policy) {
      assertOwnerMutationNotFenced(owner);
      const ns = requireValue(namespaceRow(owner), 'records_not_found', 'Records namespace was not found');
      entityFor(JSON.parse(ns.schema_json) as RecordsSchemaSnapshot, entity);
      if (policy.mode === 'expire_after_days' && (!Number.isSafeInteger(policy.days) || (policy.days ?? 0) <= 0)) {
        fail('records_invalid', 'expiry retention requires positive integer days');
      }
      if (policy.mode === 'keep' && policy.days !== undefined) fail('records_invalid', 'keep retention does not accept days');
      db.transaction(() => {
        const stamp = now();
        db.prepare(`INSERT INTO ${RETENTION_TABLE}(publisher,pack_slug,kind,policy_json,updated_at)
          VALUES (?,?,?,?,?) ON CONFLICT(publisher,pack_slug,kind) DO UPDATE SET policy_json=excluded.policy_json,updated_at=excluded.updated_at`)
          .run(owner.publisher, owner.pack_slug, entity, JSON.stringify(policy), stamp);
        db.prepare(`UPDATE ${NAMESPACE_TABLE}
          SET state_generation=state_generation+1,updated_at=?
          WHERE publisher=? AND pack_slug=?`)
          .run(stamp, owner.publisher, owner.pack_slug);
      })();
    },
    getRetention(owner) {
      const rows = db.prepare(`SELECT kind,policy_json FROM ${RETENTION_TABLE} WHERE publisher=? AND pack_slug=? ORDER BY kind`)
        .all(owner.publisher, owner.pack_slug) as Array<{ kind: string; policy_json: string }>;
      return Object.fromEntries(rows.map((row) => [row.kind, JSON.parse(row.policy_json) as RecordsRetentionPolicy]));
    },
    runRetention(owner, at = now(), batchSize = 500) {
      assertOwnerMutationNotFenced(owner);
      if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5_000) fail('records_invalid', 'retention batch size is invalid');
      const ns = requireValue(namespaceRow(owner), 'records_not_found', 'Records namespace was not found');
      if (ns.state !== 'ready') fail('records_not_ready', 'retention requires a ready namespace');
      const policyRows = db.prepare(`SELECT kind,policy_json FROM ${RETENTION_TABLE}
        WHERE publisher=? AND pack_slug=? ORDER BY kind`)
        .all(owner.publisher, owner.pack_slug) as Array<{ kind: string; policy_json: string }>;
      const policies = Object.fromEntries(policyRows.map((row) => [
        row.kind, JSON.parse(row.policy_json) as RecordsRetentionPolicy,
      ]));
      let deleted = 0;
      const blocked: string[] = [];
      for (const [kind, policy] of Object.entries(policies)) {
        if (policy.mode !== 'expire_after_days' || policy.legal_hold) continue;
        const before = at - policy.days! * 86_400_000;
        const rows = db.prepare(`SELECT pk,version,revision FROM ${ROW_TABLE}
          WHERE publisher=? AND pack_slug=? AND kind=? AND updated_at<? ORDER BY pk LIMIT ?`)
          .all(owner.publisher, owner.pack_slug, kind, before, batchSize - deleted) as Array<{ pk: string; version: number; revision: number }>;
        // Expiry is owner policy, not a capability the installed pack must
        // elect to publish. Use the same CAS/ref/accounting primitive as an
        // explorer delete even when no business delete operation exists.
        const binding = ownerBinding(ns, kind, 'delete');
        for (const row of rows) {
          try {
            deleteRecord({
              binding,
              args: { id: row.pk, expected_version: row.version, expected_revision: row.revision },
              principal: 'system:records-retention',
              cause: 'retention',
            }, JSON.parse(ns.schema_json) as RecordsSchemaSnapshot, true);
            deleted += 1;
          } catch (error) {
            if (error instanceof RecordsContractError && error.code === 'records_relationship_restrict') blocked.push(row.pk);
            else throw error;
          }
          if (deleted >= batchSize) break;
        }
      }
      return { deleted, blocked };
    },
    exportNamespace,
    exportNamespaceCsv,
    orphanNamespace(owner, expectedStateGeneration) {
      const ns = requireValue(namespaceRow(owner), 'records_not_found', 'Records namespace was not found');
      if (ns.state === 'migrating') fail('records_not_ready', 'cannot uninstall while migration is in progress');
      if (expectedStateGeneration !== undefined && ns.state_generation !== expectedStateGeneration) {
        fail('records_conflict', 'uninstall disposition fence changed');
      }
      const result = db.prepare(`UPDATE ${NAMESPACE_TABLE}
        SET state='orphaned',activation_generation=activation_generation+1,state_generation=state_generation+1,updated_at=?
        WHERE publisher=? AND pack_slug=? AND state='ready' AND state_generation=?`)
        .run(now(), owner.publisher, owner.pack_slug, ns.state_generation);
      if (result.changes !== 1 && ns.state !== 'orphaned') fail('records_conflict', 'namespace state changed during orphan transition');
      dropCursors(owner);
      return summary(namespaceRow(owner)!);
    },
    purgeNamespace(owner, confirmation) {
      return purgeNamespaceRows(owner, confirmation, false);
    },
    ownerPurgeNamespace(owner, confirmation) {
      return purgeNamespaceRows(owner, confirmation, true);
    },
    auditAccounting(owner) {
      const ns = requireValue(namespaceRow(owner), 'records_not_found', 'Records namespace was not found');
      const actual = db.prepare(`SELECT count(*) AS n,coalesce(sum(payload_bytes),0) AS b FROM ${ROW_TABLE}
        WHERE publisher=? AND pack_slug=?`).get(owner.publisher, owner.pack_slug) as { n: number; b: number };
      const pending = db.prepare(`SELECT count(*) AS n FROM ${OUTBOX_TABLE}
        WHERE publisher=? AND pack_slug=? AND status='pending'`)
        .get(owner.publisher, owner.pack_slug) as { n: number };
      const coherent = actual.n === ns.row_count
        && actual.b === ns.payload_bytes
        && pending.n === ns.outbox_count;
      if (!coherent && ns.state !== 'incoherent') {
        db.prepare(`UPDATE ${NAMESPACE_TABLE} SET state='incoherent',last_known_state=state,detected_at=?,reason='Records accounting drift',state_generation=state_generation+1,updated_at=?
          WHERE publisher=? AND pack_slug=?`).run(now(), now(), owner.publisher, owner.pack_slug);
      }
      return {
        coherent,
        expected_rows: actual.n,
        expected_bytes: actual.b,
        expected_outbox: pending.n,
      };
    },
    repairAccounting(owner) {
      const ns = requireValue(namespaceRow(owner), 'records_not_found', 'Records namespace was not found');
      if (ns.state !== 'incoherent'
        || (ns.last_known_state !== 'ready' && ns.last_known_state !== 'orphaned')
        || ns.reason !== 'Records accounting drift') {
        fail(
          'records_incoherent',
          'accounting repair requires an audit-detected ready/orphaned accounting drift',
        );
      }
      if (!Number.isSafeInteger(ns.version) || (ns.version ?? 0) <= 0
        || !ns.storage_schema_hash || !ns.declaration_hash || !ns.artifact_digest) {
        fail('records_incoherent', 'accounting repair cannot prove retained namespace authority');
      }
      let schema: RecordsSchemaSnapshot;
      let operations: Record<string, RecordsExecutionBinding>;
      let subscribers: RecordsSubscriberBinding[];
      try {
        schema = JSON.parse(ns.schema_json) as RecordsSchemaSnapshot;
        operations = JSON.parse(ns.operations_json) as Record<string, RecordsExecutionBinding>;
        subscribers = JSON.parse(ns.subscribers_json) as RecordsSubscriberBinding[];
      } catch {
        return fail('records_incoherent', 'accounting repair found unreadable immutable snapshots');
      }
      if (!schema?.entities || !operations || typeof operations !== 'object'
        || !Array.isArray(subscribers)
        || sha256(canonicalJson(subscribers)) !== ns.subscriber_digest
        || Object.values(operations).some((binding) =>
          !isRecordsExecutionBinding(binding)
          || binding.owner.publisher !== owner.publisher
          || binding.owner.pack_slug !== owner.pack_slug
          || binding.pack_version !== ns.version
          || binding.storage_schema_hash !== ns.storage_schema_hash
          || binding.declaration_hash !== ns.declaration_hash)) {
        fail('records_incoherent', 'accounting repair found divergent schema/operation/subscriber authority');
      }
      const actual = db.prepare(`SELECT count(*) AS n,coalesce(sum(payload_bytes),0) AS b,
        count(DISTINCT version) AS versions,min(version) AS min_v,max(version) AS max_v FROM ${ROW_TABLE}
        WHERE publisher=? AND pack_slug=?`).get(owner.publisher, owner.pack_slug) as { n: number; b: number; versions: number; min_v: number | null; max_v: number | null };
      if (actual.versions > 1 || (actual.versions === 1 && actual.min_v !== ns.version)) {
        fail('records_incoherent', 'accounting repair cannot prove a single ready row version');
      }
      const rows = db.prepare(`SELECT * FROM ${ROW_TABLE}
        WHERE publisher=? AND pack_slug=? ORDER BY kind,pk`);
      rows.safeIntegers(true);
      const expectedReverse = new Set<string>();
      try {
        for (const row of rows.iterate(owner.publisher, owner.pack_slug) as IterableIterator<RowShape>) {
          assertPhysicalTarget(owner, row, schema);
          const physical = physicalFromRow(row);
          for (const slot of SLOT_NAMES.filter((name) => name.startsWith('r'))) {
            const value = physical[slot];
            if (value === null) continue;
            const ref = canonicalRef(value);
            expectedReverse.add(canonicalJson([
              row.kind, row.pk, slot, ref.kind, ref.id,
            ]));
          }
        }
      } catch (error) {
        fail(
          'records_incoherent',
          `accounting repair physical proof failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const actualReverse = new Set((db.prepare(`SELECT source_kind,source_pk,source_slot,target_kind,target_pk
        FROM ${REVERSE_TABLE} WHERE publisher=? AND pack_slug=?`)
        .all(owner.publisher, owner.pack_slug) as Array<{
          source_kind: string;
          source_pk: string;
          source_slot: string;
          target_kind: string;
          target_pk: string;
        }>).map((entry) => canonicalJson([
          entry.source_kind, entry.source_pk, entry.source_slot, entry.target_kind, entry.target_pk,
        ])));
      if (expectedReverse.size !== actualReverse.size
        || [...expectedReverse].some((entry) => !actualReverse.has(entry))) {
        fail('records_incoherent', 'accounting repair found a divergent reverse-reference index');
      }
      const pending = db.prepare(`SELECT count(*) AS n FROM ${OUTBOX_TABLE}
        WHERE publisher=? AND pack_slug=? AND status='pending'`)
        .get(owner.publisher, owner.pack_slug) as { n: number };
      if (ns.last_known_state === 'ready') {
        const stale = db.prepare(`SELECT 1 FROM ${OUTBOX_TABLE}
          WHERE publisher=? AND pack_slug=? AND status='pending'
            AND (activation_generation<>? OR subscriber_digest<>?) LIMIT 1`)
          .get(owner.publisher, owner.pack_slug, ns.activation_generation, ns.subscriber_digest);
        if (stale) fail('records_incoherent', 'accounting repair found a stale runnable event pointer');
      }
      const restoredState = ns.last_known_state;
      const changed = db.prepare(`UPDATE ${NAMESPACE_TABLE} SET state=?,row_count=?,payload_bytes=?,outbox_count=?,last_known_state=NULL,
        detected_at=NULL,reason=NULL,evidence_ref=NULL,state_generation=state_generation+1,updated_at=?
        WHERE publisher=? AND pack_slug=? AND state='incoherent' AND state_generation=?`)
        .run(restoredState, actual.n, actual.b, pending.n, now(), owner.publisher, owner.pack_slug, ns.state_generation);
      if (changed.changes !== 1) fail('records_conflict', 'accounting repair fence changed');
      return summary(namespaceRow(owner)!);
    },
    getEntityNaturalKeys: entityNaturalKeys,
    /** Exact installed Tier-P operation membership used by the non-owner
     * exposure gate. The full id is derived from namespace authority plus the
     * immutable local operation key; author tags and recipe metadata do not
     * participate. */
    isInstalledOperationId(operationId) {
      if (typeof operationId !== 'string' || operationId.length === 0) return false;
      // Include incoherent namespaces too. An accounting repair or reinstall
      // can make their immutable operation ids runnable again; treating them
      // as non-Records while temporarily incoherent would let an unsafe door
      // be granted now and spring open after recovery.
      const rows = db.prepare(`SELECT publisher,pack_slug,operations_json
        FROM ${NAMESPACE_TABLE}`)
        .all() as Array<Pick<NamespaceRow, 'publisher' | 'pack_slug' | 'operations_json'>>;
      for (const row of rows) {
        let operations: Record<string, unknown>;
        try {
          operations = JSON.parse(row.operations_json) as Record<string, unknown>;
        } catch {
          continue;
        }
        for (const key of Object.keys(operations)) {
          if (`${row.publisher}.${row.pack_slug}.${key}` === operationId) return true;
        }
      }
      return false;
    },
    isInstalledCatalogOperation(catalogSlug, operationKey) {
      if (typeof catalogSlug !== 'string' || catalogSlug.length === 0
        || typeof operationKey !== 'string' || operationKey.length === 0) {
        return false;
      }
      const rows = db.prepare(`SELECT publisher,pack_slug,operations_json
        FROM ${NAMESPACE_TABLE}`).all() as Array<
          Pick<NamespaceRow, 'publisher' | 'pack_slug' | 'operations_json'>
        >;
      for (const row of rows) {
        const expectedCatalog = `records-${sha256(canonicalJson({
          publisher: row.publisher,
          pack_slug: row.pack_slug,
        })).slice(0, 32)}`;
        if (expectedCatalog !== catalogSlug) continue;
        try {
          const operations = JSON.parse(row.operations_json) as Record<string, unknown>;
          return Object.prototype.hasOwnProperty.call(operations, operationKey);
        } catch {
          return false;
        }
      }
      return false;
    },
    listOutbox(owner, status) {
      const whereStatus = status ? ' AND status=?' : '';
      const params = status ? [owner.publisher, owner.pack_slug, status] : [owner.publisher, owner.pack_slug];
      const rows = db.prepare(`SELECT * FROM ${OUTBOX_TABLE} WHERE publisher=? AND pack_slug=?${whereStatus} ORDER BY created_at,event_id`)
        .all(...params) as Array<Record<string, unknown>>;
      return rows.map(eventPointer);
    },
    getOutboxOverview,
    retireOutboxEvent,
    listPendingDeliveries(limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
        fail('records_invalid', 'outbox delivery limit must be an integer in 1..5000');
      }
      return db.transaction(() => {
        const untargeted = db.prepare(`SELECT event_id FROM ${OUTBOX_TABLE} o
          WHERE o.status='pending' AND NOT EXISTS (
            SELECT 1 FROM ${OUTBOX_DELIVERY_TABLE} d WHERE d.event_id=o.event_id
          ) ORDER BY o.created_at,o.event_id LIMIT ?`)
          .all(limit) as Array<{ event_id: string }>;
        for (const row of untargeted) finishEventWhenTargetsTerminal(row.event_id);
        const rows = db.prepare(`SELECT o.*,d.subscriber_json,d.retry_count AS delivery_retry_count
          FROM ${OUTBOX_DELIVERY_TABLE} d JOIN ${OUTBOX_TABLE} o ON o.event_id=d.event_id
          WHERE o.status='pending' AND d.status='pending'
          ORDER BY o.created_at,o.event_id,d.binding_digest LIMIT ?`)
          .all(limit) as Array<Record<string, unknown>>;
        return rows.map((row) => ({
          event: eventPointer(row),
          subscriber: JSON.parse(row.subscriber_json as string) as RecordsSubscriberBinding,
          root_event_id: row.root_event_id as string,
          causal_depth: Number(row.causal_depth),
          ...(typeof row.watcher_digest === 'string' ? { watcher_digest: row.watcher_digest } : {}),
          retry_count: Number(row.delivery_retry_count),
        }));
      })();
    },
    acknowledgeDelivery(eventId, bindingDigest) {
      return db.transaction(() => {
        const changed = db.prepare(`UPDATE ${OUTBOX_DELIVERY_TABLE}
          SET status='delivered',delivered_at=?,error=NULL
          WHERE event_id=? AND binding_digest=? AND status='pending'`)
          .run(now(), eventId, bindingDigest);
        if (changed.changes !== 1) {
          const row = db.prepare(`SELECT status FROM ${OUTBOX_DELIVERY_TABLE}
            WHERE event_id=? AND binding_digest=?`).get(eventId, bindingDigest) as { status: string } | undefined;
          return row?.status === 'delivered';
        }
        finishEventWhenTargetsTerminal(eventId);
        return true;
      })();
    },
    failDelivery(eventId, bindingDigest, reason, maxRetries = 10) {
      if (!reason || bytes(reason) > 4096) fail('records_invalid', 'delivery failure reason is required and bounded');
      if (!Number.isSafeInteger(maxRetries) || maxRetries < 1 || maxRetries > 1_000) {
        fail('records_invalid', 'delivery retry cap must be an integer in 1..1000');
      }
      return db.transaction(() => {
        const row = db.prepare(`SELECT retry_count,status FROM ${OUTBOX_DELIVERY_TABLE}
          WHERE event_id=? AND binding_digest=?`).get(eventId, bindingDigest) as { retry_count: number; status: string } | undefined;
        if (!row || row.status !== 'pending') return false;
        const retries = row.retry_count + 1;
        const terminal = retries >= maxRetries;
        const changed = db.prepare(`UPDATE ${OUTBOX_DELIVERY_TABLE}
          SET retry_count=?,status=?,error=?
          WHERE event_id=? AND binding_digest=? AND status='pending' AND retry_count=?`)
          .run(retries, terminal ? 'dead_letter' : 'pending', reason, eventId, bindingDigest, row.retry_count);
        if (changed.changes !== 1) return false;
        db.prepare(`UPDATE ${OUTBOX_TABLE} SET retry_count=retry_count+1,error=?
          WHERE event_id=? AND status='pending'`).run(reason, eventId);
        if (terminal) finishEventWhenTargetsTerminal(eventId);
        return true;
      })();
    },
    acknowledgeEvent(eventId, subscriberDigest) {
      return db.transaction(() => {
        const row = db.prepare(`SELECT publisher,pack_slug,status,subscriber_digest FROM ${OUTBOX_TABLE} WHERE event_id=?`)
          .get(eventId) as { publisher: string; pack_slug: string; status: string; subscriber_digest: string } | undefined;
        if (!row || row.subscriber_digest !== subscriberDigest) return false;
        if (row.status === 'delivered') return true;
        if (row.status !== 'pending') return false;
        db.prepare(`UPDATE ${OUTBOX_DELIVERY_TABLE} SET status='delivered',delivered_at=?,error=NULL
          WHERE event_id=? AND status='pending'`).run(now(), eventId);
        const changed = db.prepare(`UPDATE ${OUTBOX_TABLE} SET status='delivered',delivered_at=? WHERE event_id=? AND status='pending'`)
          .run(now(), eventId);
        if (changed.changes === 1) {
          decrementOutboxAccounting({ publisher: row.publisher, pack_slug: row.pack_slug }, now());
        }
        return changed.changes === 1;
      })();
    },
    deadLetterEvent(eventId, reason) {
      if (!reason || bytes(reason) > 4096) fail('records_invalid', 'dead-letter reason is required and bounded');
      return db.transaction(() => {
        const row = db.prepare(`SELECT publisher,pack_slug,status FROM ${OUTBOX_TABLE} WHERE event_id=?`).get(eventId) as { publisher: string; pack_slug: string; status: string } | undefined;
        if (!row || row.status !== 'pending') return false;
        db.prepare(`UPDATE ${OUTBOX_DELIVERY_TABLE} SET status='dead_letter',error=?
          WHERE event_id=? AND status='pending'`).run(reason, eventId);
        const changed = db.prepare(`UPDATE ${OUTBOX_TABLE} SET status='dead_letter',error=? WHERE event_id=? AND status='pending'`).run(reason, eventId);
        if (changed.changes === 1) {
          decrementOutboxAccounting({ publisher: row.publisher, pack_slug: row.pack_slug }, now());
        }
        return changed.changes === 1;
      })();
    },
    explainIndexes() {
      return (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'core_records_%_idx' ORDER BY name`).all() as Array<{ name: string }>).map((row) => row.name);
    },
  };
};

export const RECORDS_TABLES = {
  rows: ROW_TABLE,
  namespaces: NAMESPACE_TABLE,
  reverse_refs: REVERSE_TABLE,
  outbox: OUTBOX_TABLE,
  outbox_deliveries: OUTBOX_DELIVERY_TABLE,
  retention: RETENTION_TABLE,
  migration_receipts: RECEIPT_TABLE,
  migrations: MIGRATION_TABLE,
  migration_steps: MIGRATION_STEP_TABLE,
  cursors: CURSOR_TABLE,
} as const;
