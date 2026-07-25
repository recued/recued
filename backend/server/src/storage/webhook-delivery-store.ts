/** D-201 Slices 2 + 5B2B + 9BE-9BG — durable accepted/rejected delivery substrate.
 *
 * Admission is persisted in one SQLite transaction: delivery dedup tombstone,
 * fresh event rows, encrypted decoded payloads, and one outbox row per fresh
 * selected event. Provider acknowledgement happens only after this method
 * returns. The outbox uses expiring claims, so a crash after commit or after a
 * sink side effect is recovered with at-least-once delivery keyed by event_id.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  decodeCiphertext,
  decrypt,
  encodeCiphertext,
  encrypt,
} from '@recued/crypto';
import {
  MAX_WEBHOOK_DELIVERY_PAGE_SIZE,
  WEBHOOK_REJECTED_DELIVERY_REASON_CODES,
} from '@recued/contracts';
import type {
  AcceptedWebhookDeliveryRecord,
  AcceptedWebhookEventRecord,
  WebhookDeliveryRetentionPruneResult,
  WebhookEnvironment,
  WebhookProfileDescriptor,
  WebhookIngressRecord,
  WebhookProfileId,
  WebhookRejectedDeliveryReasonCode,
  WebhookSourceTruthPolicy,
  WebhookTransportAssurance,
} from '@recued/contracts';
import type { WebhookProfileHttpResponse } from '../webhook-profile-runtime.js';
import {
  WEBHOOK_CREDENTIAL_VERSION_PARSER,
  WEBHOOK_INGRESS_ID_PARSER,
  WEBHOOK_REJECTION_ID_PARSER,
} from '../webhook-core-identity-parsers.js';
import type {
  WebhookParsedPositiveSafeIntegerText,
} from '../webhook-positive-safe-integer-text-parser.js';

export const DEFAULT_WEBHOOK_PAYLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const DEFAULT_WEBHOOK_DEDUP_RETENTION_MS = 45 * 24 * 60 * 60 * 1_000;
export const DEFAULT_WEBHOOK_REJECTION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const DEFAULT_WEBHOOK_REJECTION_BUCKET_MS = 60_000;
export const DEFAULT_WEBHOOK_REJECTION_SUMMARIES_PER_INGRESS = 500;
export const DEFAULT_WEBHOOK_REJECTION_SUMMARIES_TOTAL = 10_000;
const MAX_WEBHOOK_REJECTION_COUNTER_BUCKETS = 2;

export type WebhookDeliveryStoreErrorCode =
  | 'not_found'
  | 'locked'
  | 'conflict'
  | 'ingress_closed'
  | 'backpressure'
  | 'stale_claim'
  | 'corrupt';

export class WebhookDeliveryStoreError extends Error {
  constructor(
    readonly code: WebhookDeliveryStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WebhookDeliveryStoreError';
  }
}

export interface WebhookAcceptedEventInput {
  event_dedup_key: string;
  provider_event_id: string | null;
  provider_resource_id: string | null;
  provider_event_type: string;
  provider_occurred_at: number | null;
  /** Canonical JSON emitted by the bounded core normalizer, not adapter JSON. */
  decoded_payload_json: string;
}

export interface WebhookAcceptedDeliveryInput {
  ingress_id: string;
  profile_id: WebhookProfileId;
  environment: WebhookEnvironment;
  received_at: number;
  delivery_dedup_key: string;
  raw_body_sha256: string;
  decoded_content_type: string;
  decoded_schema_id: string;
  transport_assurance: WebhookTransportAssurance;
  minimum_source_truth_policy: WebhookSourceTruthPolicy;
  credential_version: string | null;
  admission_method: string;
  freshness_checked: boolean;
  response: WebhookProfileHttpResponse;
  events: readonly WebhookAcceptedEventInput[];
}

export interface WebhookAcceptResult {
  duplicate_delivery: boolean;
  delivery: AcceptedWebhookDeliveryRecord;
  fresh_events: readonly AcceptedWebhookEventRecord[];
  response: WebhookProfileHttpResponse;
}

export type WebhookOutboxState =
  | 'pending'
  | 'leased'
  | 'dispatched'
  | 'dead_letter';

export interface WebhookOutboxView {
  outbox_id: string;
  event_id: string;
  state: WebhookOutboxState;
  attempt_count: number;
  available_at: number;
  lease_expires_at: number | null;
  last_error_code: string | null;
  created_at: number;
  updated_at: number;
}

export interface WebhookOutboxClaim {
  outbox_id: string;
  claim_token: string;
  attempt_count: number;
  event: AcceptedWebhookEventRecord;
  delivery: AcceptedWebhookDeliveryRecord;
}

export type WebhookRetentionResult = WebhookDeliveryRetentionPruneResult;

export interface WebhookDeliveryPage {
  deliveries: AcceptedWebhookDeliveryRecord[];
  has_more: boolean;
}

interface WebhookStoredEventInspectionBase {
  event: AcceptedWebhookEventRecord;
}

export type WebhookStoredEventInspection = WebhookStoredEventInspectionBase & (
  | { payload_retained: true; payload_expires_at: number }
  | { payload_retained: false; payload_expires_at: null }
);

export interface WebhookRetainedEventPayload {
  payload: unknown;
}

export interface WebhookRejectedDeliveryInput {
  ingress_id: string;
  profile_id: WebhookProfileId;
  environment: WebhookEnvironment;
  received_at: number;
  reason_code: WebhookRejectedDeliveryReasonCode;
  http_status: number;
}

export interface WebhookRejectedDeliveryRecord {
  rejection_id: string;
  ingress_id: string;
  profile_id: WebhookProfileId;
  environment: WebhookEnvironment;
  reason_code: WebhookRejectedDeliveryReasonCode;
  http_status: number;
  bucket_started_at: number;
  first_recorded_at: number;
  last_recorded_at: number;
  recorded_attempt_count: number;
  expires_at: number;
}

export interface WebhookRejectedDeliveryPage {
  rejections: WebhookRejectedDeliveryRecord[];
  has_more: boolean;
}

export interface WebhookDeliveryStoreOptions {
  now?: () => number;
  getEncryptionKey?: () => Uint8Array | null;
  newDeliveryId?: () => string;
  newEventId?: () => string;
  newPayloadRef?: () => string;
  newOutboxId?: () => string;
  newClaimToken?: () => string;
  newRejectionId?: () => string;
  payloadRetentionMs?: number;
  dedupRetentionMs?: number;
  /** Boot supplies the complete trusted profile registry. Tests that exercise
   * sub-day pruning may omit it; production must never do so. */
  profileDeduplicationRequirements?: readonly Pick<
    WebhookProfileDescriptor,
    'profile_id' | 'deduplication'
  >[];
  rejectionRetentionMs?: number;
  rejectionBucketMs?: number;
  maxRejectionSummariesPerIngress?: number;
  maxRejectionSummaries?: number;
  maxOutboxBacklog?: number;
  /** Slice 4 binding-aware front-line selector. The ingress's remote event
   * selection is necessary but no longer sufficient: an outbox row exists only
   * when an enabled installed-recipe trigger currently matches. Absent fails
   * closed to inspection-only persistence. */
  hasDispatchTarget?: (
    ingressId: string,
    providerEventType: string,
  ) => boolean;
  /** Test-only crash point. Throwing here rolls the whole accept transaction back. */
  beforeAcceptCommit?: () => void;
}

export interface WebhookDeliveryStore {
  accept(input: WebhookAcceptedDeliveryInput): Promise<WebhookAcceptResult>;
  getDelivery(deliveryId: string): AcceptedWebhookDeliveryRecord | null;
  /** Internal test-delivery observation seam. Raw bytes never leave the store;
   * the caller supplies the hash of a freshly generated nonce-bearing body. */
  findDeliveryByRawBodySha256(
    ingressId: string,
    rawBodySha256: string,
  ): AcceptedWebhookDeliveryRecord | null;
  listDeliveries(ingressId: string): AcceptedWebhookDeliveryRecord[];
  listDeliveriesPage(input: {
    ingress_id: string;
    limit: number;
    cursor?: { received_at: number; delivery_id: string };
  }): WebhookDeliveryPage;
  getEvent(eventId: string): AcceptedWebhookEventRecord | null;
  listEvents(ingressId: string): AcceptedWebhookEventRecord[];
  listEventsForDelivery(deliveryId: string): WebhookStoredEventInspection[];
  readEventPayload(eventId: string): Promise<unknown | null>;
  readRetainedEventPayload(eventId: string): Promise<WebhookRetainedEventPayload | null>;
  recordRejectedDelivery(input: WebhookRejectedDeliveryInput): void;
  listRejectedDeliveriesPage(input: {
    ingress_id: string;
    limit: number;
    cursor?: { bucket_started_at: number; rejection_id: string };
  }): WebhookRejectedDeliveryPage;
  listOutbox(): WebhookOutboxView[];
  claimOutbox(input: {
    limit: number;
    lease_ms: number;
    max_attempts?: number;
  }): WebhookOutboxClaim[];
  /** Turn ambiguous crashed claims into durable review work once their retry
   * ceiling is exhausted. This prevents lease recovery from bypassing the
   * dispatcher's bounded-attempt contract forever. */
  deadLetterExhaustedOutbox(input: { max_attempts: number }): number;
  markOutboxDispatched(outboxId: string, claimToken: string): void;
  markOutboxFailed(input: {
    outbox_id: string;
    claim_token: string;
    error_code: string;
    retry_delay_ms: number;
    max_attempts: number;
  }): 'pending' | 'dead_letter';
  prune(at?: number): WebhookRetentionResult;
  /** Owner-control-plane prune. It deliberately has no timestamp parameter. */
  pruneIngress(input: { ingress_id: string }): WebhookRetentionResult;
}

interface DeliverySqlRow {
  delivery_id: string;
  ingress_id: string;
  profile_id: string;
  environment: string;
  received_at: number;
  delivery_dedup_key: string;
  raw_body_sha256: string;
  raw_body_ref: string | null;
  decoded_content_type: string;
  decoded_schema_id: string;
  transport_assurance: string;
  minimum_source_truth_policy: string;
  credential_version: string | null;
  admission_method: string;
  freshness_checked: number;
  event_count: number;
  response_status: number;
  response_content_type: string | null;
  response_body: string | null;
  expires_at: number;
}

interface EventSqlRow {
  event_id: string;
  delivery_id: string;
  ingress_id: string;
  event_index: number;
  event_dedup_key: string;
  provider_event_id: string | null;
  provider_resource_id: string | null;
  provider_event_type: string;
  provider_occurred_at: number | null;
  decoded_payload_ref: string;
  selected_for_dispatch: number;
  dispatch_state: string;
  expires_at: number;
}

interface EventInspectionSqlRow extends EventSqlRow {
  payload_expires_at: number | null;
  payload_event_id: string | null;
  payload_ingress_id: string | null;
  payload_event_dedup_key: string | null;
}

interface PayloadSqlRow {
  payload_ref: string;
  ingress_id: string;
  event_id: string;
  event_dedup_key: string;
  ciphertext: string;
  expires_at: number;
}

interface OutboxSqlRow {
  outbox_id: string;
  event_id: string;
  state: WebhookOutboxState;
  attempt_count: number;
  available_at: number;
  claim_token: string | null;
  lease_expires_at: number | null;
  last_error_code: string | null;
  expires_at: number;
  created_at: number;
  updated_at: number;
}

interface RejectedDeliverySqlRow {
  rejection_id: string;
  ingress_id: string;
  profile_id: string;
  environment: string;
  reason_code: string;
  http_status: number;
  bucket_started_at: number;
  first_recorded_at: number;
  last_recorded_at: number;
  recorded_attempt_count: number;
  expires_at: number;
}

interface AcceptingIngressSqlRow {
  ingress_id: string;
  profile_id: string;
  environment: string;
  selected_event_types_json: string;
  intake_state: string;
}

const createSchema = (db: Database.Database): void => {
  const rejectedReasonSql = WEBHOOK_REJECTED_DELIVERY_REASON_CODES
    .map((code) => `'${code}'`)
    .join(', ');
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_accepted_deliveries (
      delivery_id TEXT PRIMARY KEY,
      ingress_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      environment TEXT NOT NULL CHECK (environment IN ('test', 'live', 'custom')),
      received_at INTEGER NOT NULL,
      delivery_dedup_key TEXT NOT NULL,
      raw_body_sha256 TEXT NOT NULL,
      raw_body_ref TEXT,
      decoded_content_type TEXT NOT NULL,
      decoded_schema_id TEXT NOT NULL,
      transport_assurance TEXT NOT NULL CHECK (
        transport_assurance IN ('authenticated', 'notification_only')
      ),
      minimum_source_truth_policy TEXT NOT NULL CHECK (
        minimum_source_truth_policy IN (
          'delivery_payload_allowed', 'provider_readback_required'
        )
      ),
      credential_version TEXT,
      admission_method TEXT NOT NULL,
      freshness_checked INTEGER NOT NULL CHECK (freshness_checked IN (0, 1)),
      event_count INTEGER NOT NULL CHECK (event_count > 0),
      response_status INTEGER NOT NULL CHECK (response_status BETWEEN 200 AND 299),
      response_content_type TEXT,
      response_body TEXT,
      expires_at INTEGER NOT NULL,
      UNIQUE (ingress_id, delivery_dedup_key),
      FOREIGN KEY (ingress_id) REFERENCES webhook_ingresses(ingress_id)
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_ingress_received
      ON webhook_accepted_deliveries(ingress_id, received_at DESC, delivery_id ASC);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_ingress_raw_hash
      ON webhook_accepted_deliveries(ingress_id, raw_body_sha256);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_expiry
      ON webhook_accepted_deliveries(expires_at);

    CREATE TABLE IF NOT EXISTS webhook_rejected_delivery_summaries (
      rejection_id TEXT PRIMARY KEY,
      ingress_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      environment TEXT NOT NULL CHECK (environment IN ('test', 'live', 'custom')),
      reason_code TEXT NOT NULL CHECK (reason_code IN (${rejectedReasonSql})),
      http_status INTEGER NOT NULL CHECK (http_status BETWEEN 400 AND 499),
      bucket_started_at INTEGER NOT NULL,
      first_recorded_at INTEGER NOT NULL,
      last_recorded_at INTEGER NOT NULL,
      recorded_attempt_count INTEGER NOT NULL CHECK (recorded_attempt_count > 0),
      expires_at INTEGER NOT NULL,
      UNIQUE (ingress_id, reason_code, http_status, bucket_started_at),
      FOREIGN KEY (ingress_id) REFERENCES webhook_ingresses(ingress_id)
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_rejections_ingress_bucket
      ON webhook_rejected_delivery_summaries(
        ingress_id, bucket_started_at DESC, rejection_id ASC
      );
    CREATE INDEX IF NOT EXISTS idx_webhook_rejections_expiry
      ON webhook_rejected_delivery_summaries(expires_at);

    CREATE TABLE IF NOT EXISTS webhook_accepted_events (
      event_id TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL,
      ingress_id TEXT NOT NULL,
      event_index INTEGER NOT NULL CHECK (event_index >= 0),
      event_dedup_key TEXT NOT NULL,
      provider_event_id TEXT,
      provider_resource_id TEXT,
      provider_event_type TEXT NOT NULL,
      provider_occurred_at INTEGER,
      decoded_payload_ref TEXT NOT NULL UNIQUE,
      selected_for_dispatch INTEGER NOT NULL CHECK (selected_for_dispatch IN (0, 1)),
      dispatch_state TEXT NOT NULL CHECK (
        dispatch_state IN ('ignored', 'pending', 'dispatched', 'dead_letter')
      ),
      expires_at INTEGER NOT NULL,
      UNIQUE (ingress_id, event_dedup_key),
      FOREIGN KEY (delivery_id) REFERENCES webhook_accepted_deliveries(delivery_id),
      FOREIGN KEY (ingress_id) REFERENCES webhook_ingresses(ingress_id)
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_events_delivery
      ON webhook_accepted_events(delivery_id, event_index ASC);
    CREATE INDEX IF NOT EXISTS idx_webhook_events_ingress_received
      ON webhook_accepted_events(ingress_id, event_id ASC);
    CREATE INDEX IF NOT EXISTS idx_webhook_events_expiry
      ON webhook_accepted_events(expires_at, dispatch_state);

    CREATE TABLE IF NOT EXISTS webhook_decoded_payloads (
      payload_ref TEXT PRIMARY KEY,
      ingress_id TEXT NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      event_dedup_key TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_payloads_expiry
      ON webhook_decoded_payloads(expires_at);

    CREATE TABLE IF NOT EXISTS webhook_payload_pins (
      pin_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      run_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_payload_pins_event
      ON webhook_payload_pins(event_id);

    CREATE TABLE IF NOT EXISTS webhook_event_outbox (
      outbox_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (
        state IN ('pending', 'leased', 'dispatched', 'dead_letter')
      ),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      available_at INTEGER NOT NULL,
      claim_token TEXT,
      lease_expires_at INTEGER,
      last_error_code TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (
        (state = 'leased' AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (state <> 'leased' AND claim_token IS NULL AND lease_expires_at IS NULL)
      ),
      FOREIGN KEY (event_id) REFERENCES webhook_accepted_events(event_id)
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_outbox_claim
      ON webhook_event_outbox(state, available_at, lease_expires_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_webhook_outbox_expiry
      ON webhook_event_outbox(expires_at, state);
  `);
};

const deliveryFromSql = (row: DeliverySqlRow): AcceptedWebhookDeliveryRecord => ({
  delivery_id: row.delivery_id,
  ingress_id: row.ingress_id,
  profile_id: row.profile_id as WebhookProfileId,
  environment: row.environment as WebhookEnvironment,
  received_at: row.received_at,
  delivery_dedup_key: row.delivery_dedup_key,
  raw_body_sha256: row.raw_body_sha256,
  raw_body_ref: row.raw_body_ref,
  decoded_content_type: row.decoded_content_type,
  decoded_schema_id: row.decoded_schema_id,
  transport_assurance: row.transport_assurance as WebhookTransportAssurance,
  minimum_source_truth_policy:
    row.minimum_source_truth_policy as WebhookSourceTruthPolicy,
  credential_version: row.credential_version,
  admission_method: row.admission_method,
  freshness_checked: row.freshness_checked === 1,
  event_count: row.event_count,
  expires_at: row.expires_at,
});

const eventFromSql = (row: EventSqlRow): AcceptedWebhookEventRecord => ({
  event_id: row.event_id,
  delivery_id: row.delivery_id,
  ingress_id: row.ingress_id,
  event_index: row.event_index,
  event_dedup_key: row.event_dedup_key,
  provider_event_id: row.provider_event_id,
  provider_resource_id: row.provider_resource_id,
  provider_event_type: row.provider_event_type,
  provider_occurred_at: row.provider_occurred_at,
  decoded_payload_ref: row.decoded_payload_ref,
  selected_for_dispatch: row.selected_for_dispatch === 1,
  dispatch_state: row.dispatch_state as AcceptedWebhookEventRecord['dispatch_state'],
  expires_at: row.expires_at,
});

const responseFromSql = (row: DeliverySqlRow): WebhookProfileHttpResponse => ({
  status: row.response_status,
  ...(row.response_content_type !== null
    ? { content_type: row.response_content_type }
    : {}),
  ...(row.response_body !== null ? { body: row.response_body } : {}),
});

const outboxFromSql = (row: OutboxSqlRow): WebhookOutboxView => ({
  outbox_id: row.outbox_id,
  event_id: row.event_id,
  state: row.state,
  attempt_count: row.attempt_count,
  available_at: row.available_at,
  lease_expires_at: row.lease_expires_at,
  last_error_code: row.last_error_code,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const rejectedDeliveryFromSql = (
  row: RejectedDeliverySqlRow,
): WebhookRejectedDeliveryRecord => ({
  rejection_id: row.rejection_id,
  ingress_id: row.ingress_id,
  profile_id: row.profile_id as WebhookProfileId,
  environment: row.environment as WebhookEnvironment,
  reason_code: row.reason_code as WebhookRejectedDeliveryReasonCode,
  http_status: row.http_status,
  bucket_started_at: row.bucket_started_at,
  first_recorded_at: row.first_recorded_at,
  last_recorded_at: row.last_recorded_at,
  recorded_attempt_count: row.recorded_attempt_count,
  expires_at: row.expires_at,
});

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
};

const parseSelectedEventTypes = (raw: string): Set<string> => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)
      || parsed.some((entry) => typeof entry !== 'string')) {
      throw new Error('invalid event selection');
    }
    return new Set(parsed);
  } catch {
    throw new WebhookDeliveryStoreError(
      'corrupt',
      'webhook ingress has corrupt event-selection metadata',
    );
  }
};

const payloadAad = (input: {
  ingress_id: string;
  event_id: string;
  event_dedup_key: string;
  payload_ref: string;
}): Uint8Array => new TextEncoder().encode(
  `recued/v1/webhook-payload/${input.ingress_id}/${input.event_id}/${input.event_dedup_key}/${input.payload_ref}`,
);

const defaultDeliveryId = (): string => `whd_${randomUUID().replace(/-/g, '')}`;
const defaultEventId = (): string => `whe_${randomUUID().replace(/-/g, '')}`;
const defaultPayloadRef = (): string => `whp_${randomUUID().replace(/-/g, '')}`;
const defaultOutboxId = (): string => `who_${randomUUID().replace(/-/g, '')}`;
const defaultRejectionId = (): string => `whr_${randomUUID().replace(/-/g, '')}`;
const defaultClaimToken = (): string => randomUUID();

const isUniqueFailure = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('UNIQUE constraint failed');

const assertPositiveDuration = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`webhook delivery store: ${label} must be a positive integer`);
  }
};

/** Fail closed when the actual configured durable retention cannot honor a
 * registered profile's Recued-owned tombstone promise. Identity formation is
 * deliberately irrelevant here: profiles own their stable/windowed keys, and
 * this check guarantees how long each resulting key remains remembered. */
export const assertWebhookDeduplicationRetentionCoversProfiles = (
  dedupRetentionMs: number,
  profiles: readonly Pick<
    WebhookProfileDescriptor,
    'profile_id' | 'deduplication'
  >[],
): void => {
  assertPositiveDuration(dedupRetentionMs, 'dedupRetentionMs');
  if (profiles.length === 0) {
    throw new Error(
      'webhook delivery store: profile deduplication requirements must not be empty',
    );
  }
  const seen = new Set<string>();
  for (const profile of profiles) {
    if (seen.has(profile.profile_id)) {
      throw new Error(
        `webhook delivery store: duplicate profile deduplication requirement '${profile.profile_id}'`,
      );
    }
    seen.add(profile.profile_id);
    const horizonMs = profile.deduplication?.tombstone_horizon_ms;
    if (typeof horizonMs !== 'number'
      || !Number.isSafeInteger(horizonMs)
      || horizonMs <= 0) {
      throw new Error(
        `webhook delivery store: profile '${profile.profile_id}' has an invalid deduplication tombstone horizon`,
      );
    }
    if (dedupRetentionMs < horizonMs) {
      throw new Error(
        `webhook delivery store: dedup retention ${dedupRetentionMs}ms is shorter than profile '${profile.profile_id}' tombstone horizon ${horizonMs}ms`,
      );
    }
  }
};

export const createWebhookDeliveryStore = (
  db: Database.Database,
  options: WebhookDeliveryStoreOptions = {},
): WebhookDeliveryStore => {
  const now = options.now ?? Date.now;
  const payloadRetentionMs = options.payloadRetentionMs
    ?? DEFAULT_WEBHOOK_PAYLOAD_RETENTION_MS;
  const dedupRetentionMs = options.dedupRetentionMs
    ?? DEFAULT_WEBHOOK_DEDUP_RETENTION_MS;
  const rejectionRetentionMs = options.rejectionRetentionMs
    ?? DEFAULT_WEBHOOK_REJECTION_RETENTION_MS;
  const rejectionBucketMs = options.rejectionBucketMs
    ?? DEFAULT_WEBHOOK_REJECTION_BUCKET_MS;
  const maxRejectionSummariesPerIngress = options.maxRejectionSummariesPerIngress
    ?? DEFAULT_WEBHOOK_REJECTION_SUMMARIES_PER_INGRESS;
  const maxRejectionSummaries = options.maxRejectionSummaries
    ?? DEFAULT_WEBHOOK_REJECTION_SUMMARIES_TOTAL;
  const maxOutboxBacklog = options.maxOutboxBacklog ?? 10_000;
  const hasDispatchTarget = options.hasDispatchTarget ?? (() => false);
  assertPositiveDuration(payloadRetentionMs, 'payloadRetentionMs');
  assertPositiveDuration(dedupRetentionMs, 'dedupRetentionMs');
  assertPositiveDuration(rejectionRetentionMs, 'rejectionRetentionMs');
  assertPositiveDuration(rejectionBucketMs, 'rejectionBucketMs');
  if (options.profileDeduplicationRequirements !== undefined) {
    assertWebhookDeduplicationRetentionCoversProfiles(
      dedupRetentionMs,
      options.profileDeduplicationRequirements,
    );
  }
  if (dedupRetentionMs < payloadRetentionMs) {
    throw new Error(
      'webhook delivery store: dedup retention must outlive payload retention',
    );
  }
  if (!Number.isSafeInteger(maxOutboxBacklog)
    || maxOutboxBacklog < 1
    || maxOutboxBacklog > 1_000_000) {
    throw new Error('webhook delivery store: maxOutboxBacklog must be in 1..1000000');
  }
  if (!Number.isSafeInteger(maxRejectionSummariesPerIngress)
    || maxRejectionSummariesPerIngress < 1
    || maxRejectionSummariesPerIngress > 100_000) {
    throw new Error(
      'webhook delivery store: maxRejectionSummariesPerIngress must be in 1..100000',
    );
  }
  if (!Number.isSafeInteger(maxRejectionSummaries)
    || maxRejectionSummaries < maxRejectionSummariesPerIngress
    || maxRejectionSummaries > 1_000_000) {
    throw new Error(
      'webhook delivery store: maxRejectionSummaries must cover the per-ingress cap and be at most 1000000',
    );
  }

  createSchema(db);

  const newDeliveryId = options.newDeliveryId ?? defaultDeliveryId;
  const newEventId = options.newEventId ?? defaultEventId;
  const newPayloadRef = options.newPayloadRef ?? defaultPayloadRef;
  const newOutboxId = options.newOutboxId ?? defaultOutboxId;
  const newRejectionId = options.newRejectionId ?? defaultRejectionId;
  const newClaimToken = options.newClaimToken ?? defaultClaimToken;
  const rejectionCounterBuckets = new Map<
    number,
    Map<string, { observed: number; persisted: number }>
  >();

  const selectDeliveryById = db.prepare(`
    SELECT * FROM webhook_accepted_deliveries WHERE delivery_id = ?
  `);
  const selectDeliveryByDedup = db.prepare(`
    SELECT * FROM webhook_accepted_deliveries
    WHERE ingress_id = ? AND delivery_dedup_key = ?
  `);
  const selectDeliveryByRawBodySha256 = db.prepare(`
    SELECT * FROM webhook_accepted_deliveries
    WHERE ingress_id = ? AND raw_body_sha256 = ?
    ORDER BY received_at DESC, delivery_id ASC
    LIMIT 1
  `);
  const selectEventById = db.prepare(`
    SELECT * FROM webhook_accepted_events WHERE event_id = ?
  `);
  const selectEventByDedup = db.prepare(`
    SELECT * FROM webhook_accepted_events
    WHERE ingress_id = ? AND event_dedup_key = ?
  `);

  const requireEncryptionKey = (): Uint8Array => {
    const key = options.getEncryptionKey?.() ?? null;
    if (!key) {
      throw new WebhookDeliveryStoreError(
        'locked',
        'webhook payload persistence requires an unlocked server vault',
      );
    }
    return key;
  };

  const requireAcceptingIngress = (
    input: Pick<WebhookAcceptedDeliveryInput, 'ingress_id' | 'profile_id' | 'environment'>,
  ): AcceptingIngressSqlRow => {
    const row = db.prepare(`
      SELECT ingress_id, profile_id, environment, selected_event_types_json, intake_state
      FROM webhook_ingresses WHERE ingress_id = ?
    `).get(input.ingress_id) as AcceptingIngressSqlRow | undefined;
    if (!row) {
      throw new WebhookDeliveryStoreError('not_found', 'webhook ingress not found');
    }
    if (row.intake_state !== 'enabled' && row.intake_state !== 'degraded') {
      throw new WebhookDeliveryStoreError(
        'ingress_closed',
        'webhook ingress closed while accepting delivery',
      );
    }
    if (row.profile_id !== input.profile_id || row.environment !== input.environment) {
      throw new WebhookDeliveryStoreError(
        'conflict',
        'webhook ingress identity changed while accepting delivery',
      );
    }
    return row;
  };

  const parseMatchedCredentialVersion = (
    value: unknown,
  ): WebhookParsedPositiveSafeIntegerText | null => {
    if (value === null) return null;
    const parsed = WEBHOOK_CREDENTIAL_VERSION_PARSER.parse(value);
    if (!parsed.ok) {
      throw new WebhookDeliveryStoreError(
        'conflict',
        'webhook profile returned an invalid credential version',
      );
    }
    return parsed;
  };

  const requireMatchedCredentialActive = (
    ingressId: string,
    credentialVersion: WebhookParsedPositiveSafeIntegerText | null,
  ): void => {
    if (credentialVersion === null) return;
    const activeCredential = db.prepare(`
      SELECT 1 FROM webhook_credential_versions
      WHERE ingress_id = ? AND version = ? AND state = 'active'
    `).get(ingressId, credentialVersion.value);
    if (!activeCredential) {
      throw new WebhookDeliveryStoreError(
        'conflict',
        'matched webhook credential was retired before durable acceptance',
      );
    }
  };

  const recordRejectedDelivery = (input: WebhookRejectedDeliveryInput): void => {
    if (!Number.isSafeInteger(input.received_at) || input.received_at < 0) {
      throw new WebhookDeliveryStoreError(
        'conflict',
        'rejected webhook delivery timestamp is invalid',
      );
    }
    if (!WEBHOOK_REJECTED_DELIVERY_REASON_CODES.includes(input.reason_code)
      || !Number.isSafeInteger(input.http_status)
      || input.http_status < 400
      || input.http_status > 499) {
      throw new WebhookDeliveryStoreError(
        'conflict',
        'rejected webhook delivery reason is invalid',
      );
    }
    requireAcceptingIngress(input);
    const bucketStartedAt = Math.floor(input.received_at / rejectionBucketMs)
      * rejectionBucketMs;
    const expiresAt = input.received_at + rejectionRetentionMs;
    if (!Number.isSafeInteger(bucketStartedAt) || !Number.isSafeInteger(expiresAt)) {
      throw new WebhookDeliveryStoreError(
        'conflict',
        'rejected webhook delivery retention timestamp is invalid',
      );
    }
    let rejectionCounters = rejectionCounterBuckets.get(bucketStartedAt);
    if (!rejectionCounters) {
      rejectionCounters = new Map();
      rejectionCounterBuckets.set(bucketStartedAt, rejectionCounters);
      // A verification started just before a minute boundary can finish after
      // one from the next minute. Retain both adjacent buckets so alternating
      // completions cannot reset the logarithmic checkpoint state, while still
      // bounding unauthenticated diagnostic memory.
      if (rejectionCounterBuckets.size > MAX_WEBHOOK_REJECTION_COUNTER_BUCKETS) {
        const oldestBucket = Math.min(...rejectionCounterBuckets.keys());
        rejectionCounterBuckets.delete(oldestBucket);
      }
    }
    const counterKey = `${input.ingress_id}\u0000${input.reason_code}\u0000${input.http_status}`;
    const counter = rejectionCounters.get(counterKey) ?? { observed: 0, persisted: 0 };
    counter.observed += 1;
    rejectionCounters.set(counterKey, counter);
    const nextCheckpoint = counter.persisted === 0 ? 1 : counter.persisted * 2;
    if (counter.observed < nextCheckpoint) return;
    const recordedIncrement = counter.observed - counter.persisted;
    const rejectionId = newRejectionId();
    const persist = db.transaction(() => {
      db.prepare(`
        DELETE FROM webhook_rejected_delivery_summaries WHERE expires_at <= ?
      `).run(input.received_at);
      db.prepare(`
        INSERT INTO webhook_rejected_delivery_summaries (
          rejection_id, ingress_id, profile_id, environment, reason_code,
          http_status, bucket_started_at, first_recorded_at, last_recorded_at,
          recorded_attempt_count, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (ingress_id, reason_code, http_status, bucket_started_at)
        DO UPDATE SET
          first_recorded_at = MIN(first_recorded_at, excluded.first_recorded_at),
          last_recorded_at = MAX(last_recorded_at, excluded.last_recorded_at),
          recorded_attempt_count = MIN(
            recorded_attempt_count + excluded.recorded_attempt_count,
            2147483647
          ),
          expires_at = MAX(expires_at, excluded.expires_at)
      `).run(
        rejectionId,
        input.ingress_id,
        input.profile_id,
        input.environment,
        input.reason_code,
        input.http_status,
        bucketStartedAt,
        input.received_at,
        input.received_at,
        recordedIncrement,
        expiresAt,
      );
      db.prepare(`
        DELETE FROM webhook_rejected_delivery_summaries
        WHERE rejection_id IN (
          SELECT rejection_id FROM webhook_rejected_delivery_summaries
          WHERE ingress_id = ?
          ORDER BY bucket_started_at DESC, last_recorded_at DESC, rejection_id ASC
          LIMIT -1 OFFSET ?
        )
      `).run(input.ingress_id, maxRejectionSummariesPerIngress);
      db.prepare(`
        DELETE FROM webhook_rejected_delivery_summaries
        WHERE rejection_id IN (
          SELECT rejection_id FROM webhook_rejected_delivery_summaries
          ORDER BY bucket_started_at DESC, last_recorded_at DESC, rejection_id ASC
          LIMIT -1 OFFSET ?
        )
      `).run(maxRejectionSummaries);
    });
    persist();
    counter.persisted = counter.observed;
  };

  const markMatchedCredentialVerified = (
    input: Pick<
      WebhookAcceptedDeliveryInput,
      'ingress_id' | 'received_at'
    >,
    credentialVersion: WebhookParsedPositiveSafeIntegerText | null,
  ): void => {
    if (credentialVersion === null) return;
    const updated = db.prepare(`
      UPDATE webhook_credential_versions
      SET last_verified_at = CASE
        WHEN last_verified_at IS NULL OR last_verified_at < ? THEN ?
        ELSE last_verified_at
      END
      WHERE ingress_id = ? AND version = ? AND state = 'active'
    `).run(
      input.received_at,
      input.received_at,
      input.ingress_id,
      credentialVersion.value,
    );
    if (updated.changes !== 1) {
      throw new WebhookDeliveryStoreError(
        'conflict',
        'matched webhook credential was retired before verification was recorded',
      );
    }
  };

  const duplicateResult = (row: DeliverySqlRow): WebhookAcceptResult => ({
    duplicate_delivery: true,
    delivery: deliveryFromSql(row),
    fresh_events: [],
    response: responseFromSql(row),
  });

  const requireOutboxCapacity = (): void => {
    const row = db.prepare(`
      SELECT COUNT(*) AS count FROM webhook_event_outbox
      WHERE state IN ('pending', 'leased', 'dead_letter')
    `).get() as { count: number };
    if (row.count >= maxOutboxBacklog) {
      throw new WebhookDeliveryStoreError(
        'backpressure',
        'webhook outbox backlog is at capacity',
      );
    }
  };

  const accept = async (
    input: WebhookAcceptedDeliveryInput,
  ): Promise<WebhookAcceptResult> => {
    // A route retirement cannot interleave with this synchronous duplicate
    // fast path. Re-verification happened before this store call, so a locked
    // vault may still acknowledge an already-durable delivery safely.
    const initialIngress = requireAcceptingIngress(input);
    const matchedCredentialVersion = parseMatchedCredentialVersion(
      input.credential_version,
    );
    requireMatchedCredentialActive(input.ingress_id, matchedCredentialVersion);
    const existing = selectDeliveryByDedup.get(
      input.ingress_id,
      input.delivery_dedup_key,
    ) as DeliverySqlRow | undefined;
    if (existing) {
      markMatchedCredentialVerified(input, matchedCredentialVersion);
      return duplicateResult(existing);
    }
    const initialSelection = parseSelectedEventTypes(
      initialIngress.selected_event_types_json,
    );
    const mayAppendOutbox = input.events.some((event) =>
      initialSelection.has(event.provider_event_type)
      && hasDispatchTarget(input.ingress_id, event.provider_event_type)
      && !selectEventByDedup.get(input.ingress_id, event.event_dedup_key));
    if (mayAppendOutbox) requireOutboxCapacity();

    const key = requireEncryptionKey();
    const deliveryId = newDeliveryId();
    const preparedEvents = input.events.map((event, eventIndex) => ({
      input: event,
      event_index: eventIndex,
      event_id: newEventId(),
      payload_ref: newPayloadRef(),
      outbox_id: newOutboxId(),
    }));
    const encryptedPayloads: string[] = [];
    for (const event of preparedEvents) {
      const plaintext = new TextEncoder().encode(event.input.decoded_payload_json);
      try {
        encryptedPayloads.push(encodeCiphertext(await encrypt(
          key,
          plaintext,
          payloadAad({
            ingress_id: input.ingress_id,
            event_id: event.event_id,
            event_dedup_key: event.input.event_dedup_key,
            payload_ref: event.payload_ref,
          }),
        )));
      } finally {
        plaintext.fill(0);
      }
    }

    const acceptedAt = now();
    const payloadExpiresAt = acceptedAt + payloadRetentionMs;
    const dedupExpiresAt = acceptedAt + dedupRetentionMs;
    const transaction = db.transaction((): WebhookAcceptResult => {
      const currentKey = requireEncryptionKey();
      if (!equalBytes(currentKey, key)) {
        throw new WebhookDeliveryStoreError(
          'conflict',
          'webhook payload key changed while encrypting; retry the delivery',
        );
      }
      const ingress = requireAcceptingIngress(input);
      requireMatchedCredentialActive(
        input.ingress_id,
        matchedCredentialVersion,
      );
      const racedDelivery = selectDeliveryByDedup.get(
        input.ingress_id,
        input.delivery_dedup_key,
      ) as DeliverySqlRow | undefined;
      if (racedDelivery) {
        markMatchedCredentialVerified(input, matchedCredentialVersion);
        return duplicateResult(racedDelivery);
      }
      const selectedEventTypes = parseSelectedEventTypes(
        ingress.selected_event_types_json,
      );

      db.prepare(`
        INSERT INTO webhook_accepted_deliveries (
          delivery_id, ingress_id, profile_id, environment, received_at,
          delivery_dedup_key, raw_body_sha256, raw_body_ref,
          decoded_content_type, decoded_schema_id, transport_assurance,
          minimum_source_truth_policy, credential_version, admission_method,
          freshness_checked, event_count, response_status,
          response_content_type, response_body, expires_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        deliveryId,
        input.ingress_id,
        input.profile_id,
        input.environment,
        input.received_at,
        input.delivery_dedup_key,
        input.raw_body_sha256,
        input.decoded_content_type,
        input.decoded_schema_id,
        input.transport_assurance,
        input.minimum_source_truth_policy,
        matchedCredentialVersion?.text ?? null,
        input.admission_method,
        input.freshness_checked ? 1 : 0,
        input.events.length,
        input.response.status,
        input.response.content_type ?? null,
        input.response.body ?? null,
        dedupExpiresAt,
      );

      const freshEvents: AcceptedWebhookEventRecord[] = [];
      for (let index = 0; index < preparedEvents.length; index += 1) {
        const prepared = preparedEvents[index]!;
        const existingEvent = selectEventByDedup.get(
          input.ingress_id,
          prepared.input.event_dedup_key,
        ) as EventSqlRow | undefined;
        if (existingEvent) continue;
        const selected = selectedEventTypes.has(prepared.input.provider_event_type)
          && hasDispatchTarget(
            input.ingress_id,
            prepared.input.provider_event_type,
          );
        if (selected) requireOutboxCapacity();
        const dispatchState: AcceptedWebhookEventRecord['dispatch_state'] =
          selected ? 'pending' : 'ignored';

        db.prepare(`
          INSERT INTO webhook_decoded_payloads (
            payload_ref, ingress_id, event_id, event_dedup_key, ciphertext, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          prepared.payload_ref,
          input.ingress_id,
          prepared.event_id,
          prepared.input.event_dedup_key,
          encryptedPayloads[index]!,
          payloadExpiresAt,
        );
        db.prepare(`
          INSERT INTO webhook_accepted_events (
            event_id, delivery_id, ingress_id, event_index, event_dedup_key,
            provider_event_id, provider_resource_id, provider_event_type,
            provider_occurred_at, decoded_payload_ref, selected_for_dispatch,
            dispatch_state, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          prepared.event_id,
          deliveryId,
          input.ingress_id,
          prepared.event_index,
          prepared.input.event_dedup_key,
          prepared.input.provider_event_id,
          prepared.input.provider_resource_id,
          prepared.input.provider_event_type,
          prepared.input.provider_occurred_at,
          prepared.payload_ref,
          selected ? 1 : 0,
          dispatchState,
          dedupExpiresAt,
        );
        if (selected) {
          db.prepare(`
            INSERT INTO webhook_event_outbox (
              outbox_id, event_id, state, attempt_count, available_at,
              claim_token, lease_expires_at, last_error_code, expires_at,
              created_at, updated_at
            ) VALUES (?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?, ?)
          `).run(
            prepared.outbox_id,
            prepared.event_id,
            acceptedAt,
            dedupExpiresAt,
            acceptedAt,
            acceptedAt,
          );
        }
        freshEvents.push(eventFromSql({
          event_id: prepared.event_id,
          delivery_id: deliveryId,
          ingress_id: input.ingress_id,
          event_index: prepared.event_index,
          event_dedup_key: prepared.input.event_dedup_key,
          provider_event_id: prepared.input.provider_event_id,
          provider_resource_id: prepared.input.provider_resource_id,
          provider_event_type: prepared.input.provider_event_type,
          provider_occurred_at: prepared.input.provider_occurred_at,
          decoded_payload_ref: prepared.payload_ref,
          selected_for_dispatch: selected ? 1 : 0,
          dispatch_state: dispatchState,
          expires_at: dedupExpiresAt,
        }));
      }

      db.prepare(`
        UPDATE webhook_ingresses
        SET
          test_observed_at = CASE
            WHEN test_observed_at IS NULL OR test_observed_at > ? THEN ?
            ELSE test_observed_at
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
          last_delivery_at = CASE
            WHEN last_delivery_at IS NULL OR last_delivery_at < ? THEN ?
            ELSE last_delivery_at
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
        input.received_at,
        input.received_at,
        input.received_at,
        input.received_at,
        acceptedAt,
        input.ingress_id,
      );
      markMatchedCredentialVerified(input, matchedCredentialVersion);
      options.beforeAcceptCommit?.();

      const persisted = selectDeliveryById.get(deliveryId) as DeliverySqlRow;
      return {
        duplicate_delivery: false,
        delivery: deliveryFromSql(persisted),
        fresh_events: freshEvents,
        response: responseFromSql(persisted),
      };
    });

    try {
      return transaction();
    } catch (error) {
      if (error instanceof WebhookDeliveryStoreError) throw error;
      if (isUniqueFailure(error)) {
        const raced = selectDeliveryByDedup.get(
          input.ingress_id,
          input.delivery_dedup_key,
        ) as DeliverySqlRow | undefined;
        if (raced) return duplicateResult(raced);
        throw new WebhookDeliveryStoreError(
          'conflict',
          'concurrent webhook event acceptance; retry the delivery',
        );
      }
      throw error;
    }
  };

  const getDelivery = (deliveryId: string): AcceptedWebhookDeliveryRecord | null => {
    const row = selectDeliveryById.get(deliveryId) as DeliverySqlRow | undefined;
    return row ? deliveryFromSql(row) : null;
  };

  const getEvent = (eventId: string): AcceptedWebhookEventRecord | null => {
    const row = selectEventById.get(eventId) as EventSqlRow | undefined;
    return row ? eventFromSql(row) : null;
  };

  const readRetainedEventPayload = async (
    eventId: string,
  ): Promise<WebhookRetainedEventPayload | null> => {
    const event = selectEventById.get(eventId) as EventSqlRow | undefined;
    if (!event) throw new WebhookDeliveryStoreError('not_found', 'webhook event not found');
    const row = db.prepare(`
      SELECT * FROM webhook_decoded_payloads WHERE payload_ref = ?
    `).get(event.decoded_payload_ref) as PayloadSqlRow | undefined;
    if (!row) return null;
    if (row.event_id !== event.event_id
      || row.ingress_id !== event.ingress_id
      || row.event_dedup_key !== event.event_dedup_key) {
      throw new WebhookDeliveryStoreError(
        'corrupt',
        `webhook event '${eventId}' payload identity does not match`,
      );
    }
    const key = requireEncryptionKey();
    let plaintext: Uint8Array | null = null;
    try {
      plaintext = await decrypt(
        key,
        decodeCiphertext(row.ciphertext),
        payloadAad({
          ingress_id: row.ingress_id,
          event_id: row.event_id,
          event_dedup_key: row.event_dedup_key,
          payload_ref: row.payload_ref,
        }),
      );
      const currentKey = requireEncryptionKey();
      if (!equalBytes(currentKey, key)) {
        throw new WebhookDeliveryStoreError(
          'conflict',
          'webhook payload key changed while decrypting; retry the read',
        );
      }
      const stillPresent = db.prepare(`
        SELECT 1 FROM webhook_decoded_payloads
        WHERE payload_ref = ? AND event_id = ?
      `).get(row.payload_ref, eventId);
      if (!stillPresent) return null;
      return { payload: JSON.parse(new TextDecoder().decode(plaintext)) as unknown };
    } catch (error) {
      if (error instanceof WebhookDeliveryStoreError) throw error;
      throw new WebhookDeliveryStoreError(
        'corrupt',
        `webhook event '${eventId}' payload cannot be decrypted`,
      );
    } finally {
      plaintext?.fill(0);
    }
  };

  const readEventPayload = async (eventId: string): Promise<unknown | null> =>
    (await readRetainedEventPayload(eventId))?.payload ?? null;

  const claimOutbox = (input: {
    limit: number;
    lease_ms: number;
    max_attempts?: number;
  }): WebhookOutboxClaim[] => {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error('webhook outbox: limit must be an integer in 1..100');
    }
    if (!Number.isSafeInteger(input.lease_ms)
      || input.lease_ms < 1_000
      || input.lease_ms > 15 * 60 * 1_000) {
      throw new Error('webhook outbox: lease_ms must be an integer in 1000..900000');
    }
    const maxAttempts = input.max_attempts ?? 100;
    if (!Number.isSafeInteger(maxAttempts)
      || maxAttempts < 1
      || maxAttempts > 100) {
      throw new Error('webhook outbox: max_attempts must be in 1..100');
    }
    const stamp = now();
    const claim = db.transaction((): WebhookOutboxClaim[] => {
      const rows = db.prepare(`
        SELECT * FROM webhook_event_outbox
        WHERE (state = 'pending' AND available_at <= ? AND attempt_count < ?)
           OR (state = 'leased' AND lease_expires_at <= ? AND attempt_count < ?)
        ORDER BY created_at ASC, outbox_id ASC
        LIMIT ?
      `).all(stamp, maxAttempts, stamp, maxAttempts, input.limit) as OutboxSqlRow[];
      const claims: WebhookOutboxClaim[] = [];
      for (const row of rows) {
        const token = newClaimToken();
        const updated = db.prepare(`
          UPDATE webhook_event_outbox SET
            state = 'leased',
            attempt_count = attempt_count + 1,
            claim_token = ?,
            lease_expires_at = ?,
            updated_at = ?
          WHERE outbox_id = ?
            AND attempt_count < ?
            AND ((state = 'pending' AND available_at <= ?)
              OR (state = 'leased' AND lease_expires_at <= ?))
        `).run(
          token,
          stamp + input.lease_ms,
          stamp,
          row.outbox_id,
          maxAttempts,
          stamp,
          stamp,
        );
        if (updated.changes !== 1) continue;
        const eventRow = selectEventById.get(row.event_id) as EventSqlRow | undefined;
        if (!eventRow) {
          throw new WebhookDeliveryStoreError(
            'corrupt',
            `webhook outbox '${row.outbox_id}' references a missing event`,
          );
        }
        const deliveryRow = selectDeliveryById.get(
          eventRow.delivery_id,
        ) as DeliverySqlRow | undefined;
        if (!deliveryRow) {
          throw new WebhookDeliveryStoreError(
            'corrupt',
            `webhook event '${eventRow.event_id}' references a missing delivery`,
          );
        }
        claims.push({
          outbox_id: row.outbox_id,
          claim_token: token,
          attempt_count: row.attempt_count + 1,
          event: eventFromSql(eventRow),
          delivery: deliveryFromSql(deliveryRow),
        });
      }
      return claims;
    });
    return claim();
  };

  const requireClaim = (
    outboxId: string,
    claimToken: string,
  ): OutboxSqlRow => {
    const row = db.prepare(`
      SELECT * FROM webhook_event_outbox
      WHERE outbox_id = ? AND state = 'leased' AND claim_token = ?
    `).get(outboxId, claimToken) as OutboxSqlRow | undefined;
    if (!row) {
      throw new WebhookDeliveryStoreError(
        'stale_claim',
        'webhook outbox claim is stale or no longer owned',
      );
    }
    return row;
  };

  const deadLetterExhaustedOutbox = (input: {
    max_attempts: number;
  }): number => {
    if (!Number.isSafeInteger(input.max_attempts)
      || input.max_attempts < 1
      || input.max_attempts > 100) {
      throw new Error('webhook outbox: max_attempts must be in 1..100');
    }
    const stamp = now();
    const persist = db.transaction((): number => {
      db.prepare(`
        UPDATE webhook_accepted_events SET dispatch_state = 'dead_letter'
        WHERE event_id IN (
          SELECT event_id FROM webhook_event_outbox
          WHERE (state = 'pending' AND attempt_count >= ?)
             OR (state = 'leased' AND lease_expires_at <= ?
               AND attempt_count >= ?)
        )
      `).run(input.max_attempts, stamp, input.max_attempts);
      const exhausted = db.prepare(`
        UPDATE webhook_event_outbox SET
          state = 'dead_letter', claim_token = NULL,
          lease_expires_at = NULL,
          last_error_code = 'lease_expired_attempt_limit', updated_at = ?
        WHERE (state = 'pending' AND attempt_count >= ?)
           OR (state = 'leased' AND lease_expires_at <= ?
             AND attempt_count >= ?)
      `).run(
        stamp,
        input.max_attempts,
        stamp,
        input.max_attempts,
      );
      return exhausted.changes;
    });
    return persist();
  };

  const markOutboxDispatched = (outboxId: string, claimToken: string): void => {
    const stamp = now();
    const persist = db.transaction(() => {
      const row = requireClaim(outboxId, claimToken);
      db.prepare(`
        UPDATE webhook_event_outbox SET
          state = 'dispatched', claim_token = NULL, lease_expires_at = NULL,
          last_error_code = NULL, updated_at = ?
        WHERE outbox_id = ? AND state = 'leased' AND claim_token = ?
      `).run(stamp, outboxId, claimToken);
      db.prepare(`
        UPDATE webhook_accepted_events SET dispatch_state = 'dispatched'
        WHERE event_id = ?
      `).run(row.event_id);
    });
    persist();
  };

  const markOutboxFailed = (input: {
    outbox_id: string;
    claim_token: string;
    error_code: string;
    retry_delay_ms: number;
    max_attempts: number;
  }): 'pending' | 'dead_letter' => {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(input.error_code)) {
      throw new Error('webhook outbox: error_code has invalid shape');
    }
    if (!Number.isSafeInteger(input.retry_delay_ms)
      || input.retry_delay_ms < 0
      || input.retry_delay_ms > 24 * 60 * 60 * 1_000) {
      throw new Error('webhook outbox: retry_delay_ms is out of range');
    }
    if (!Number.isSafeInteger(input.max_attempts)
      || input.max_attempts < 1
      || input.max_attempts > 100) {
      throw new Error('webhook outbox: max_attempts must be in 1..100');
    }
    const stamp = now();
    const persist = db.transaction((): 'pending' | 'dead_letter' => {
      const row = requireClaim(input.outbox_id, input.claim_token);
      const nextState = row.attempt_count >= input.max_attempts
        ? 'dead_letter'
        : 'pending';
      db.prepare(`
        UPDATE webhook_event_outbox SET
          state = ?, available_at = ?, claim_token = NULL,
          lease_expires_at = NULL, last_error_code = ?, updated_at = ?
        WHERE outbox_id = ? AND state = 'leased' AND claim_token = ?
      `).run(
        nextState,
        stamp + input.retry_delay_ms,
        input.error_code,
        stamp,
        input.outbox_id,
        input.claim_token,
      );
      db.prepare(`
        UPDATE webhook_accepted_events SET dispatch_state = ?
        WHERE event_id = ?
      `).run(nextState === 'dead_letter' ? 'dead_letter' : 'pending', row.event_id);
      return nextState;
    });
    return persist();
  };

  const pruneScope = (
    at: number,
    ingressId: string | null,
  ): WebhookRetentionResult => {
    if (!Number.isSafeInteger(at) || at < 0) {
      throw new Error('webhook retention: at must be a non-negative integer');
    }
    if (ingressId !== null
      && WEBHOOK_INGRESS_ID_PARSER.parse(ingressId) === null) {
      throw new Error('webhook retention: ingress_id has invalid shape');
    }
    const parameters = { at, ingress_id: ingressId };
    const persist = db.transaction((): WebhookRetentionResult => {
      const payloads = db.prepare(`
        DELETE FROM webhook_decoded_payloads
        WHERE expires_at <= @at
          AND (@ingress_id IS NULL OR ingress_id = @ingress_id)
          AND NOT EXISTS (
            SELECT 1 FROM webhook_accepted_events event
            WHERE event.event_id = webhook_decoded_payloads.event_id
              AND event.dispatch_state IN ('pending', 'dead_letter')
          )
          AND NOT EXISTS (
            SELECT 1 FROM webhook_event_outbox outbox
            WHERE outbox.event_id = webhook_decoded_payloads.event_id
              AND outbox.state IN ('pending', 'leased', 'dead_letter')
          )
          AND NOT EXISTS (
            SELECT 1 FROM webhook_payload_pins pin
            WHERE pin.event_id = webhook_decoded_payloads.event_id
          )
      `).run(parameters);

      const outbox = db.prepare(`
        DELETE FROM webhook_event_outbox
        WHERE expires_at <= @at AND state = 'dispatched'
          AND (
            @ingress_id IS NULL
            OR EXISTS (
              SELECT 1 FROM webhook_accepted_events scoped_event
              WHERE scoped_event.event_id = webhook_event_outbox.event_id
                AND scoped_event.ingress_id = @ingress_id
            )
          )
      `).run(parameters);

      db.prepare(`
        DELETE FROM webhook_decoded_payloads
        WHERE (@ingress_id IS NULL OR ingress_id = @ingress_id)
          AND event_id IN (
            SELECT event_id FROM webhook_accepted_events
            WHERE expires_at <= @at
              AND (@ingress_id IS NULL OR ingress_id = @ingress_id)
              AND dispatch_state IN ('ignored', 'dispatched')
          )
          AND NOT EXISTS (
            SELECT 1 FROM webhook_payload_pins pin
            WHERE pin.event_id = webhook_decoded_payloads.event_id
          )
      `).run(parameters);
      const events = db.prepare(`
        DELETE FROM webhook_accepted_events
        WHERE expires_at <= @at
          AND (@ingress_id IS NULL OR ingress_id = @ingress_id)
          AND dispatch_state IN ('ignored', 'dispatched')
          AND NOT EXISTS (
            SELECT 1 FROM webhook_event_outbox outbox
            WHERE outbox.event_id = webhook_accepted_events.event_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM webhook_payload_pins pin
            WHERE pin.event_id = webhook_accepted_events.event_id
          )
      `).run(parameters);
      const deliveries = db.prepare(`
        DELETE FROM webhook_accepted_deliveries
        WHERE expires_at <= @at
          AND (@ingress_id IS NULL OR ingress_id = @ingress_id)
          AND NOT EXISTS (
            SELECT 1 FROM webhook_accepted_events event
            WHERE event.delivery_id = webhook_accepted_deliveries.delivery_id
          )
      `).run(parameters);
      const rejected = db.prepare(`
        DELETE FROM webhook_rejected_delivery_summaries
        WHERE expires_at <= @at
          AND (@ingress_id IS NULL OR ingress_id = @ingress_id)
      `).run(parameters);
      return {
        payloads_deleted: payloads.changes,
        outbox_rows_deleted: outbox.changes,
        events_deleted: events.changes,
        deliveries_deleted: deliveries.changes,
        rejected_summaries_deleted: rejected.changes,
      };
    });
    return persist();
  };
  const prune = (at = now()): WebhookRetentionResult => pruneScope(at, null);
  const pruneIngress: WebhookDeliveryStore['pruneIngress'] = (input) =>
    pruneScope(now(), input.ingress_id);

  return {
    accept,
    getDelivery,
    findDeliveryByRawBodySha256(ingressId, rawBodySha256) {
      if (!/^[0-9a-f]{64}$/.test(rawBodySha256)) {
        throw new Error('webhook delivery raw-body hash must be lowercase SHA-256');
      }
      const row = selectDeliveryByRawBodySha256.get(
        ingressId,
        rawBodySha256,
      ) as DeliverySqlRow | undefined;
      return row ? deliveryFromSql(row) : null;
    },
    listDeliveries(ingressId) {
      return (db.prepare(`
        SELECT * FROM webhook_accepted_deliveries
        WHERE ingress_id = ?
        ORDER BY received_at DESC, delivery_id ASC
      `).all(ingressId) as DeliverySqlRow[]).map(deliveryFromSql);
    },
    listDeliveriesPage(input) {
      if (!Number.isSafeInteger(input.limit)
        || input.limit < 1
        || input.limit > MAX_WEBHOOK_DELIVERY_PAGE_SIZE) {
        throw new Error(
          `webhook delivery page: limit must be in 1..${MAX_WEBHOOK_DELIVERY_PAGE_SIZE}`,
        );
      }
      if (input.cursor !== undefined
        && (!Number.isSafeInteger(input.cursor.received_at)
          || input.cursor.received_at < 0
          || typeof input.cursor.delivery_id !== 'string'
          || input.cursor.delivery_id.length === 0
          || input.cursor.delivery_id.length > 256
          || /[\u0000-\u001f\u007f]/.test(input.cursor.delivery_id))) {
        throw new Error('webhook delivery page: cursor is invalid');
      }
      const rows = input.cursor === undefined
        ? db.prepare(`
            SELECT * FROM webhook_accepted_deliveries
            WHERE ingress_id = ?
            ORDER BY received_at DESC, delivery_id ASC
            LIMIT ?
          `).all(input.ingress_id, input.limit + 1) as DeliverySqlRow[]
        : db.prepare(`
            SELECT * FROM webhook_accepted_deliveries
            WHERE ingress_id = ?
              AND (
                received_at < ?
                OR (received_at = ? AND delivery_id > ?)
              )
            ORDER BY received_at DESC, delivery_id ASC
            LIMIT ?
          `).all(
            input.ingress_id,
            input.cursor.received_at,
            input.cursor.received_at,
            input.cursor.delivery_id,
            input.limit + 1,
          ) as DeliverySqlRow[];
      return {
        deliveries: rows.slice(0, input.limit).map(deliveryFromSql),
        has_more: rows.length > input.limit,
      };
    },
    recordRejectedDelivery,
    listRejectedDeliveriesPage(input) {
      if (!Number.isSafeInteger(input.limit)
        || input.limit < 1
        || input.limit > MAX_WEBHOOK_DELIVERY_PAGE_SIZE) {
        throw new Error(
          `webhook rejection page: limit must be in 1..${MAX_WEBHOOK_DELIVERY_PAGE_SIZE}`,
        );
      }
      let cursor: { bucket_started_at: number; rejection_id: string } | undefined;
      if (input.cursor !== undefined) {
        const bucketStartedAt = input.cursor.bucket_started_at;
        if (!Number.isSafeInteger(bucketStartedAt)
          || bucketStartedAt < 0) {
          throw new Error('webhook rejection page: cursor is invalid');
        }
        const rejectionId = WEBHOOK_REJECTION_ID_PARSER.parse(
          input.cursor.rejection_id,
        );
        if (rejectionId === null) {
          throw new Error('webhook rejection page: cursor is invalid');
        }
        cursor = {
          bucket_started_at: bucketStartedAt,
          rejection_id: rejectionId,
        };
      }
      const visibleAt = now();
      const rows = cursor === undefined
        ? db.prepare(`
            SELECT * FROM webhook_rejected_delivery_summaries
            WHERE ingress_id = ? AND expires_at > ?
            ORDER BY bucket_started_at DESC, rejection_id ASC
            LIMIT ?
          `).all(
            input.ingress_id,
            visibleAt,
            input.limit + 1,
          ) as RejectedDeliverySqlRow[]
        : db.prepare(`
            SELECT * FROM webhook_rejected_delivery_summaries
            WHERE ingress_id = ? AND expires_at > ?
              AND (
                bucket_started_at < ?
                OR (bucket_started_at = ? AND rejection_id > ?)
              )
            ORDER BY bucket_started_at DESC, rejection_id ASC
            LIMIT ?
          `).all(
            input.ingress_id,
            visibleAt,
            cursor.bucket_started_at,
            cursor.bucket_started_at,
            cursor.rejection_id,
            input.limit + 1,
          ) as RejectedDeliverySqlRow[];
      return {
        rejections: rows.slice(0, input.limit).map(rejectedDeliveryFromSql),
        has_more: rows.length > input.limit,
      };
    },
    getEvent,
    listEvents(ingressId) {
      return (db.prepare(`
        SELECT * FROM webhook_accepted_events
        WHERE ingress_id = ?
        ORDER BY event_id ASC
      `).all(ingressId) as EventSqlRow[]).map(eventFromSql);
    },
    listEventsForDelivery(deliveryId) {
      return (db.prepare(`
        SELECT event.*,
          payload.expires_at AS payload_expires_at,
          payload.event_id AS payload_event_id,
          payload.ingress_id AS payload_ingress_id,
          payload.event_dedup_key AS payload_event_dedup_key
        FROM webhook_accepted_events event
        LEFT JOIN webhook_decoded_payloads payload
          ON payload.payload_ref = event.decoded_payload_ref
        WHERE event.delivery_id = ?
        ORDER BY event.event_index ASC, event.event_id ASC
      `).all(deliveryId) as EventInspectionSqlRow[]).map((row) => {
        if (row.payload_expires_at !== null
          && (row.payload_event_id !== row.event_id
            || row.payload_ingress_id !== row.ingress_id
            || row.payload_event_dedup_key !== row.event_dedup_key)) {
          throw new WebhookDeliveryStoreError(
            'corrupt',
            `webhook event '${row.event_id}' payload identity does not match`,
          );
        }
        const event = eventFromSql(row);
        return row.payload_expires_at === null
          ? { event, payload_retained: false, payload_expires_at: null }
          : {
              event,
              payload_retained: true,
              payload_expires_at: row.payload_expires_at,
            };
      });
    },
    readEventPayload,
    readRetainedEventPayload,
    listOutbox() {
      return (db.prepare(`
        SELECT * FROM webhook_event_outbox ORDER BY created_at ASC, outbox_id ASC
      `).all() as OutboxSqlRow[]).map(outboxFromSql);
    },
    claimOutbox,
    deadLetterExhaustedOutbox,
    markOutboxDispatched,
    markOutboxFailed,
    prune,
    pruneIngress,
  };
};
