/** D-201 Slice 0 — portable webhook profile + consumer contracts.
 *
 * This module deliberately contains no verifier, request object, Buffer,
 * secret value, fetch hook, or registration adapter.  The server-side profile
 * registry will pair these serializable descriptors with trusted code in later
 * slices.  A pack may name a profile; it may never define the cryptography.
 *
 * Spec: D-201 §4 / §9 / Slice 0.
 */

// ────────────────────────────────────────────────────────────────
// Closed vocabularies
// ────────────────────────────────────────────────────────────────

export const WEBHOOK_MECHANISM_KINDS = [
  'static_header_token',
  'http_basic',
  'raw_body_hmac',
  'timestamped_hmac',
  'url_and_body_hmac',
  'canonical_fields_hmac',
  'asymmetric_signature',
  'jwt_or_jws',
  'remote_verification',
  'form_signed_envelope',
  'mutual_tls',
  'encrypted_envelope',
  'unauthenticated_pointer',
] as const;
export type WebhookMechanismKind = (typeof WEBHOOK_MECHANISM_KINDS)[number];

export const WEBHOOK_REGISTRATION_MODES = [
  'manual',
  'managed_endpoint',
  'operation_bound',
] as const;
export type WebhookRegistrationMode = (typeof WEBHOOK_REGISTRATION_MODES)[number];

export const WEBHOOK_TRANSPORT_ASSURANCES = [
  'authenticated',
  'notification_only',
] as const;
export type WebhookTransportAssurance = (typeof WEBHOOK_TRANSPORT_ASSURANCES)[number];

export const WEBHOOK_SOURCE_TRUTH_POLICIES = [
  'delivery_payload_allowed',
  'provider_readback_required',
] as const;
export type WebhookSourceTruthPolicy = (typeof WEBHOOK_SOURCE_TRUTH_POLICIES)[number];

export const WEBHOOK_DECODER_KINDS = [
  'json',
  'form_urlencoded',
  'xml',
  'jwt_claims',
  'binary',
  'encrypted',
  'vendor_sdk',
] as const;
export type WebhookDecoderKind = (typeof WEBHOOK_DECODER_KINDS)[number];

export const WEBHOOK_ENVIRONMENTS = ['test', 'live', 'custom'] as const;
export type WebhookEnvironment = (typeof WEBHOOK_ENVIRONMENTS)[number];

export const WEBHOOK_ENVIRONMENT_POLICIES = [
  'match_connection',
  'test_only',
  'live_only',
  'any',
] as const;
export type WebhookEnvironmentPolicy = (typeof WEBHOOK_ENVIRONMENT_POLICIES)[number];

export const WEBHOOK_DECODED_PAYLOAD_ACCESS = ['metadata_only', 'scoped_read'] as const;
export type WebhookDecodedPayloadAccess = (typeof WEBHOOK_DECODED_PAYLOAD_ACCESS)[number];

export const WEBHOOK_PROFILE_FIELD_KINDS = [
  'secret',
  'text',
  'username',
  'password',
  'certificate',
  'public_key',
  'private_key',
  'remote_id',
] as const;
export type WebhookProfileFieldKind = (typeof WEBHOOK_PROFILE_FIELD_KINDS)[number];

export const WEBHOOK_PROFILE_FIELD_SOURCES = [
  'owner',
  'recued_generated',
  'vendor_generated',
  'managed_registration_result',
] as const;
export type WebhookProfileFieldSource = (typeof WEBHOOK_PROFILE_FIELD_SOURCES)[number];

export const WEBHOOK_DEDUPLICATION_IDENTITY_KINDS = [
  'stable_provider_id',
  'stable_provider_id_or_signed_timestamp_body',
  'received_at_body_window',
  'signed_timestamp_body',
] as const;
export type WebhookDeduplicationIdentityKind =
  (typeof WEBHOOK_DEDUPLICATION_IDENTITY_KINDS)[number];

export type WebhookDeduplicationIdentity =
  | { kind: 'stable_provider_id' }
  | { kind: 'stable_provider_id_or_signed_timestamp_body' }
  | { kind: 'received_at_body_window'; window_ms: number }
  | { kind: 'signed_timestamp_body' };

/** Durable duplicate-processing promise for one profile-computed identity.
 * `tombstone_horizon_ms` is Recued's minimum retention boundary, not a claim
 * about how long a provider will retain or resend a delivery. The identity
 * variant keeps receipt-window, stable-id fallback, and newly-signed retries
 * from being presented as unconditional stable-provider-id deduplication. */
export interface WebhookDeduplicationPolicy {
  tombstone_horizon_ms: number;
  identity: WebhookDeduplicationIdentity;
}

/** Portable registry keys.  Presence here means the portable contract is known;
 * it does NOT mean a listener or server adapter is installed.  Later runtime
 * composition must independently require a code-backed adapter before exposing
 * a route. */
export const WEBHOOK_PROFILE_IDS = [
  'stripe.event.v1',
  'paddle.notification.v1',
  'lemonsqueezy.webhook.v1',
  'slack.request.v0',
  'slack.slash-command.v1',
  'telegram.bot-webhook.v1',
  'github.webhook.v1',
  'cal.webhook.v1',
  'generic.static-header-token.v1',
  'generic.raw-body-hmac-sha256.v1',
  'generic.timestamped-raw-body-hmac-sha256.v1',
  'generic.http-basic.v1',
  'recued-peer.exchange.v1',
] as const;
export type WebhookProfileId = (typeof WEBHOOK_PROFILE_IDS)[number];

export const WEBHOOK_BINDING_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** Existing catalog/connection slots commonly contain hyphens; unlike a
 * logical trigger binding they are not constrained to underscore form. */
export const WEBHOOK_CONNECTION_SLOT_RE = /^[a-z][a-z0-9_-]{0,63}$/;
export const WEBHOOK_EVENT_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export const WEBHOOK_PROFILE_ID_RE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.v[0-9]+$/;

export const MAX_WEBHOOK_REQUIREMENTS = 16;
export const MAX_WEBHOOK_PROFILES_PER_REQUIREMENT = 8;
export const MAX_WEBHOOK_EVENT_TYPES_PER_REQUIREMENT = 64;
export const MAX_WEBHOOK_TRIGGERS = 32;
export const MAX_WEBHOOK_EVENT_TYPES_PER_TRIGGER = 64;
export const MAX_WEBHOOK_INGRESS_DISPLAY_NAME_LENGTH = 160;
export const MAX_WEBHOOK_REGISTRATION_TARGET_KIND_LENGTH = 64;
export const MAX_WEBHOOK_REGISTRATION_TARGET_KEY_LENGTH = 512;
export const MAX_WEBHOOK_CREDENTIAL_VALUE_BYTES = 65_536;
export const MAX_WEBHOOK_CREDENTIAL_TOTAL_BYTES = 262_144;
/** One currently-verifying credential plus one overlap-safe rotation value. */
export const MAX_ACTIVE_WEBHOOK_CREDENTIAL_VERSIONS = 2;
export const MAX_WEBHOOK_DELIVERY_PAGE_SIZE = 50;
/** D-201 Slice 10B — the most unresolved dead letters a server keeps for its
 * owner. Past it the oldest is closed by the limit (its review record says so),
 * so dead letters neither stop intake nor grow storage without bound. */
export const WEBHOOK_DEAD_LETTER_REVIEW_LIMIT = 1_000;
/** The longest reason an owner may keep with a dead-letter decision. */
export const MAX_WEBHOOK_DEAD_LETTER_REASON_LENGTH = 500;
/** D-201 Slice 10F — why Recued closed a dead letter itself (a closure whose
 * `closed_by` is `server` carries one of these as its `reason`). */
export const WEBHOOK_DEAD_LETTER_SERVER_REASONS = [
  /** Past `WEBHOOK_DEAD_LETTER_REVIEW_LIMIT`, the oldest are closed. */
  'review_limit',
  /** The owner retired its webhook. */
  'webhook_retired',
  /** Its recipe was removed (uninstalled, or its pack no longer has it). */
  'recipe_removed',
  /** Its recipe was switched off. */
  'recipe_disarmed',
  /** Its recipe was saved with a different webhook setup, so the new version
   * may not take old messages. A save that keeps the setup carries them.
   * D-201 Slice 10Y (10V findings 7 and 17) — also a pack update that changes,
   * drops or stops shipping a recipe's webhook while the recipe stays
   * installed; `recipe_removed` is only for one no longer stored. */
  'recipe_replaced',
] as const;
export type WebhookDeadLetterServerReason = (typeof WEBHOOK_DEAD_LETTER_SERVER_REASONS)[number];

/** Ingress-known 4xx delivery failures eligible for the bounded owner ledger.
 * Operational/routing failures and retryable 5xx profile failures stay out. */
export const WEBHOOK_REJECTED_DELIVERY_REASON_CODES = [
  'uri_too_long',
  'request_headers_too_large',
  'method_not_allowed',
  'unsupported_media_type',
  'payload_too_large',
  'invalid_request',
  'authentication_failed',
  'structural_admission_failed',
  'unsupported_delivery',
] as const;

export type WebhookRejectedDeliveryReasonCode =
  (typeof WEBHOOK_REJECTED_DELIVERY_REASON_CODES)[number];

/** Names that are syntactically valid identifiers but unsafe as future object
 * keys.  Current validators use Map/null-prototype records, yet rejecting these
 * at the portable boundary prevents a later projection from re-introducing a
 * prototype-sensitive binding, connection slot, or profile field. */
const WEBHOOK_RESERVED_IDENTIFIERS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

const isSafeWebhookIdentifier = (value: string): boolean =>
  !WEBHOOK_RESERVED_IDENTIFIERS.has(value);

// ────────────────────────────────────────────────────────────────
// Portable trusted-profile registry
// ────────────────────────────────────────────────────────────────

export interface WebhookProfileField {
  key: string;
  label: string;
  kind: WebhookProfileFieldKind;
  required: boolean;
  source: WebhookProfileFieldSource;
  help_url?: string;
}

/** D-201 Slice 10C — the language an OPEN event catalog admits, chosen by the
 * profile from a closed set of reusable grammars. Each one is data only: there
 * is no regex input, callback or validator a pack or an owner can supply. The
 * kinds and fields are exactly the presets of the server's event-type parsers
 * (`webhook-*-event-type-parser.ts`, `webhook-ascii-identifier-parser.ts`),
 * and the server refuses to start a runtime parser whose preset differs from
 * its profile's grammar, so contracts, the RPC, registration, the runtime and
 * Settings admit one set. Every grammar is ASCII only (characters are bytes)
 * and at most 128 long, inside `WEBHOOK_EVENT_TYPE_RE`.
 *
 * - `ascii_alphanumeric_dot_colon_slash_dash.v1`: `[A-Za-z0-9][A-Za-z0-9._:/-]*`
 *   (Stripe's `customer.subscription.updated`).
 * - `ascii_identifier.v1`: `[A-Za-z][A-Za-z0-9_]*`. No shipped profile uses it
 *   since D-201 Slice 10G; it stays so a client still reads it from an older
 *   server, whose Telegram profile projected it.
 * - `lowercase_identifier_event_type.v1`: `[a-z][a-z0-9_]*` (GitHub's
 *   `pull_request`, Lemon Squeezy's `subscription_plan_changed`).
 * - `lowercase_json_member_event_type.v1` (D-201 Slice 10G): the same, but a
 *   name a delivery can carry as a JSON member name, so neither `constructor`
 *   nor `prototype`, which the server's JSON reader refuses anywhere in a
 *   delivery (Telegram's `edited_message`, the Update's one member).
 * - `lowercase_dot_segment_event_type.v1`: exactly `segment_count` segments
 *   joined by `.`, each `[a-z][a-z0-9_]*` and at most `max_segment_characters`
 *   long (Paddle's `transaction.completed`). */
export type WebhookEventTypeGrammar =
  | { kind: 'ascii_alphanumeric_dot_colon_slash_dash.v1'; max_bytes: number }
  | { kind: 'ascii_identifier.v1'; max_bytes: number }
  | { kind: 'lowercase_identifier_event_type.v1'; max_characters: number }
  | { kind: 'lowercase_json_member_event_type.v1'; max_characters: number }
  | {
      kind: 'lowercase_dot_segment_event_type.v1';
      segment_count: number;
      max_segment_characters: number;
    };

export const MAX_WEBHOOK_EVENT_TYPE_GRAMMAR_CHARACTERS = 128;
const MAX_WEBHOOK_EVENT_TYPE_SEGMENTS = 16;
const ASCII_ALPHANUMERIC_DOT_COLON_SLASH_DASH_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const ASCII_IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const LOWERCASE_IDENTIFIER_RE = /^[a-z][a-z0-9_]*$/;
/** The member names the server's JSON reader refuses that a lowercase
 *  identifier can spell (`__proto__` cannot: it starts with `_`). The
 *  server's lowercase parser holds the same two; the grammar parity tests
 *  compare the two answers name for name. */
const WEBHOOK_JSON_MEMBER_REFUSED_NAMES: readonly string[] = Object.freeze(['constructor', 'prototype']);

/** Why a grammar is not one this registry accepts; empty when it is. */
export const validateWebhookEventTypeGrammar = (grammar: unknown): string[] => {
  if (grammar === null || typeof grammar !== 'object' || Array.isArray(grammar)) {
    return ['event type grammar must be an object'];
  }
  const fields = grammar as Record<string, unknown>;
  const keys = Object.keys(fields).sort().join(',');
  const bounded = (value: unknown, maximum: number): boolean =>
    Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= maximum;
  switch (fields.kind) {
    case 'ascii_alphanumeric_dot_colon_slash_dash.v1':
    case 'ascii_identifier.v1':
      if (keys !== 'kind,max_bytes') return ['event type grammar must contain only kind and max_bytes'];
      return bounded(fields.max_bytes, MAX_WEBHOOK_EVENT_TYPE_GRAMMAR_CHARACTERS)
        ? []
        : [`event type grammar max_bytes must be in 1..${MAX_WEBHOOK_EVENT_TYPE_GRAMMAR_CHARACTERS}`];
    case 'lowercase_identifier_event_type.v1':
    case 'lowercase_json_member_event_type.v1':
      if (keys !== 'kind,max_characters') {
        return ['event type grammar must contain only kind and max_characters'];
      }
      return bounded(fields.max_characters, MAX_WEBHOOK_EVENT_TYPE_GRAMMAR_CHARACTERS)
        ? []
        : [`event type grammar max_characters must be in 1..${MAX_WEBHOOK_EVENT_TYPE_GRAMMAR_CHARACTERS}`];
    case 'lowercase_dot_segment_event_type.v1':
      if (keys !== 'kind,max_segment_characters,segment_count') {
        return ['event type grammar must contain only kind, segment_count and max_segment_characters'];
      }
      if (!bounded(fields.segment_count, MAX_WEBHOOK_EVENT_TYPE_SEGMENTS)
        || !bounded(fields.max_segment_characters, MAX_WEBHOOK_EVENT_TYPE_GRAMMAR_CHARACTERS)
        || (fields.segment_count as number) * (fields.max_segment_characters as number)
          + (fields.segment_count as number) - 1 > MAX_WEBHOOK_EVENT_TYPE_GRAMMAR_CHARACTERS) {
        return [`event type grammar segments must fit in ${MAX_WEBHOOK_EVENT_TYPE_GRAMMAR_CHARACTERS} characters`];
      }
      return [];
    default:
      return ['event type grammar kind is not a known grammar'];
  }
};

/** Whether `value` is in `grammar`'s language: the same test, value for value,
 * as the server's parser built from the same preset. */
export const webhookEventTypeGrammarAccepts = (
  grammar: WebhookEventTypeGrammar,
  value: unknown,
): value is string => {
  if (typeof value !== 'string') return false;
  switch (grammar.kind) {
    case 'ascii_alphanumeric_dot_colon_slash_dash.v1':
      return value.length <= grammar.max_bytes
        && ASCII_ALPHANUMERIC_DOT_COLON_SLASH_DASH_RE.test(value);
    case 'ascii_identifier.v1':
      return value.length <= grammar.max_bytes && ASCII_IDENTIFIER_RE.test(value);
    case 'lowercase_identifier_event_type.v1':
      return value.length <= grammar.max_characters && LOWERCASE_IDENTIFIER_RE.test(value);
    case 'lowercase_json_member_event_type.v1':
      return value.length <= grammar.max_characters
        && LOWERCASE_IDENTIFIER_RE.test(value)
        && !WEBHOOK_JSON_MEMBER_REFUSED_NAMES.includes(value);
    case 'lowercase_dot_segment_event_type.v1': {
      const maximum = grammar.segment_count * grammar.max_segment_characters
        + grammar.segment_count - 1;
      if (value.length < grammar.segment_count * 2 - 1 || value.length > maximum) return false;
      const segments = value.split('.');
      return segments.length === grammar.segment_count
        && segments.every((segment) => segment.length >= 1
          && segment.length <= grammar.max_segment_characters
          && LOWERCASE_IDENTIFIER_RE.test(segment));
    }
    default:
      return false;
  }
};

/** Whether two grammars denote the same language: the same kind and bounds. */
export const sameWebhookEventTypeGrammar = (
  left: WebhookEventTypeGrammar,
  right: unknown,
): boolean => {
  if (right === null || typeof right !== 'object' || Array.isArray(right)) return false;
  const other = right as Record<string, unknown>;
  const mine = left as unknown as Record<string, unknown>;
  const keys = Object.keys(mine).sort();
  return keys.join(',') === Object.keys(other).sort().join(',')
    && keys.every((key) => mine[key] === other[key]);
};

export type WebhookEventTypeCatalog =
  | { kind: 'closed'; values: readonly string[] }
  | {
      kind: 'open';
      /** Discovery only: the names Settings offers as checkboxes. */
      known_values: readonly string[];
      /** What the catalog admits beyond them (D-201 Slice 10C). */
      grammar: WebhookEventTypeGrammar;
      /** D-201 Slice 10T (10Q finding 19) — names the service takes and sends
       *  but never lists back, so a managed registration naming one could never
       *  be confirmed, and is refused. Settings words such a refusal as that,
       *  not as a misspelt name. Within the grammar, outside `known_values`. */
      never_listed?: readonly string[];
    };

/** JSON-safe half of a trusted server profile.  Exact header grammar,
 * canonicalization, freshness, crypto, decoder code, and registration code do
 * not belong here; those are selected by `profile_id` inside trusted core. */
export interface WebhookProfileDescriptor {
  profile_id: WebhookProfileId;
  vendor: string | 'generic';
  mechanism_kind: WebhookMechanismKind;
  transport_assurance: WebhookTransportAssurance;
  minimum_source_truth_policy: WebhookSourceTruthPolicy;
  decoder_kind: WebhookDecoderKind;
  decoded_schema_id: string;
  event_types: WebhookEventTypeCatalog;
  fields: readonly WebhookProfileField[];
  registration_modes: readonly WebhookRegistrationMode[];
  supported_environments: readonly WebhookEnvironment[];
  allowed_methods: readonly string[];
  allowed_content_types: readonly string[];
  max_body_bytes: number;
  max_events_per_delivery: number;
  deduplication: WebhookDeduplicationPolicy;
  /** Control-plane registration uses an outbound vendor connection. */
  managed_registration_requires_connection: boolean;
  /** D-201 Slice 10AW (10AS finding 8) — the kind of connection a paired
   *  webhook's registration reads (`webhookPairedConnectionKind`): `api`
   *  unless named. Telegram's bot is a `notification` connection, which
   *  readiness looked up as `api`, so a managed Telegram webhook registered and
   *  could never be switched on; and its deletion closed nothing. */
  paired_connection_kind?: WebhookPairedConnectionKind;
  /** Optional profile-specific handshake labels understood by trusted core. */
  handshakes: readonly string[];
}

/** D-201 Slice 10AW (10AS finding 8) — the kinds of connection a webhook can
 *  pair with. */
export const WEBHOOK_PAIRED_CONNECTION_KINDS = ['api', 'notification'] as const;
export type WebhookPairedConnectionKind = (typeof WEBHOOK_PAIRED_CONNECTION_KINDS)[number];

/** D-201 Slice 10AW (10AS finding 8) — the kind of connection a paired
 *  webhook's registration reads, for every caller: readiness, the deletion of
 *  a connection, and the registration itself. */
export const webhookPairedConnectionKind = (
  profile: Pick<WebhookProfileDescriptor, 'paired_connection_kind'>,
): WebhookPairedConnectionKind => profile.paired_connection_kind ?? 'api';

/** One profile-owned predicate for every control-plane and lifecycle caller.
 * Vendor names never decide whether deletion of a connection must close an
 * ingress; the selected registration mechanism plus descriptor capability do
 * (D-201 Slice 10AW: of the kind it pairs with, `webhookPairedConnectionKind`). */
export const webhookProfileRequiresPairedConnection = (
  profile: WebhookProfileDescriptor,
  mode: WebhookRegistrationMode,
): boolean => mode === 'operation_bound'
  || (mode === 'managed_endpoint' && profile.managed_registration_requires_connection);

const GENERIC_DELIVERY_EVENT_TYPES = { kind: 'closed', values: ['delivery'] } as const;
const GENERIC_ENVIRONMENTS = ['test', 'live', 'custom'] as const;
const JSON_CONTENT_TYPES = ['application/json'] as const;
const V1_PROFILE_DEDUPLICATION_TOMBSTONE_HORIZON_MS = 45 * 24 * 60 * 60 * 1_000;
const STABLE_PROVIDER_ID_DEDUPLICATION = {
  tombstone_horizon_ms: V1_PROFILE_DEDUPLICATION_TOMBSTONE_HORIZON_MS,
  identity: { kind: 'stable_provider_id' },
} as const;
const STABLE_PROVIDER_ID_OR_SIGNED_TIMESTAMP_BODY_DEDUPLICATION = {
  tombstone_horizon_ms: V1_PROFILE_DEDUPLICATION_TOMBSTONE_HORIZON_MS,
  identity: { kind: 'stable_provider_id_or_signed_timestamp_body' },
} as const;
const RECEIVED_AT_BODY_WINDOW_DEDUPLICATION = {
  tombstone_horizon_ms: V1_PROFILE_DEDUPLICATION_TOMBSTONE_HORIZON_MS,
  identity: { kind: 'received_at_body_window', window_ms: 5 * 60 * 1_000 },
} as const;
const SIGNED_TIMESTAMP_BODY_DEDUPLICATION = {
  tombstone_horizon_ms: V1_PROFILE_DEDUPLICATION_TOMBSTONE_HORIZON_MS,
  identity: { kind: 'signed_timestamp_body' },
} as const;

const WEBHOOK_PROFILE_DESCRIPTOR_LIST = [
  {
    profile_id: 'stripe.event.v1',
    vendor: 'stripe',
    mechanism_kind: 'timestamped_hmac',
    transport_assurance: 'authenticated',
    // D-196/D-200 payment transitions use the callback as an accelerator and
    // re-read Stripe before changing access/payment-derived state.
    minimum_source_truth_policy: 'provider_readback_required',
    decoder_kind: 'json',
    decoded_schema_id: 'stripe.event.v1',
    event_types: {
      kind: 'open',
      known_values: [
        'checkout.session.completed',
        'customer.subscription.created',
        'customer.subscription.deleted',
        'customer.subscription.updated',
        'invoice.paid',
        'invoice.payment_failed',
      ],
      grammar: { kind: 'ascii_alphanumeric_dot_colon_slash_dash.v1', max_bytes: 128 },
    },
    fields: [{
      key: 'endpoint_secret',
      label: 'Endpoint signing secret',
      kind: 'secret',
      required: true,
      source: 'vendor_generated',
    }],
    registration_modes: ['manual', 'managed_endpoint'],
    supported_environments: ['test', 'live'],
    allowed_methods: ['POST'],
    allowed_content_types: JSON_CONTENT_TYPES,
    max_body_bytes: 1_048_576,
    max_events_per_delivery: 1,
    deduplication: STABLE_PROVIDER_ID_DEDUPLICATION,
    managed_registration_requires_connection: true,
    handshakes: [],
  },
  {
    profile_id: 'paddle.notification.v1',
    vendor: 'paddle',
    mechanism_kind: 'timestamped_hmac',
    transport_assurance: 'authenticated',
    // The authenticated notification contains a complete provider snapshot.
    // Payment/entitlement consumers remain free to require the stronger
    // provider-readback policy without baking commerce semantics into this
    // transport profile.
    minimum_source_truth_policy: 'delivery_payload_allowed',
    decoder_kind: 'json',
    decoded_schema_id: 'paddle.notification.v1',
    event_types: {
      kind: 'open',
      known_values: [
        'address.created',
        'address.imported',
        'address.updated',
        'adjustment.created',
        'adjustment.updated',
        'api_key.created',
        'api_key.expired',
        'api_key.expiring',
        'api_key.revoked',
        'api_key.updated',
        'api_key_exposure.created',
        'business.created',
        'business.imported',
        'business.updated',
        'client_token.created',
        'client_token.revoked',
        'client_token.updated',
        'customer.created',
        'customer.imported',
        'customer.updated',
        'discount.created',
        'discount.imported',
        'discount.updated',
        'discount_group.created',
        'discount_group.updated',
        'flow_session.abandoned',
        'flow_session.completed',
        'flow_session.created',
        'funnel_session.abandoned',
        'funnel_session.completed',
        'funnel_session.created',
        'invoice.canceled',
        'invoice.issued',
        'invoice.overdue',
        'invoice.paid',
        'payment_method.deleted',
        'payment_method.saved',
        'payout.created',
        'payout.paid',
        'price.created',
        'price.imported',
        'price.updated',
        'product_collection.created',
        'product_collection.updated',
        'product.created',
        'product.imported',
        'product.updated',
        'report.created',
        'report.updated',
        'subscription.activated',
        'subscription.canceled',
        'subscription.created',
        'subscription.imported',
        'subscription.past_due',
        'subscription.paused',
        'subscription.resumed',
        'subscription.trialing',
        'subscription.updated',
        'transaction.billed',
        'transaction.canceled',
        'transaction.completed',
        'transaction.created',
        'transaction.paid',
        'transaction.past_due',
        'transaction.payment_failed',
        'transaction.ready',
        'transaction.revised',
        'transaction.updated',
      ],
      grammar: {
        kind: 'lowercase_dot_segment_event_type.v1',
        segment_count: 2,
        max_segment_characters: 63,
      },
    },
    fields: [{
      key: 'endpoint_secret_key',
      label: 'Endpoint secret key',
      kind: 'secret',
      required: true,
      source: 'vendor_generated',
      help_url:
        'https://developer.paddle.com/webhooks/about/signature-verification/',
    }],
    registration_modes: ['manual', 'managed_endpoint'],
    supported_environments: ['test', 'live'],
    allowed_methods: ['POST'],
    allowed_content_types: JSON_CONTENT_TYPES,
    max_body_bytes: 1_048_576,
    max_events_per_delivery: 1,
    deduplication: STABLE_PROVIDER_ID_DEDUPLICATION,
    managed_registration_requires_connection: true,
    handshakes: [],
  },
  {
    profile_id: 'lemonsqueezy.webhook.v1',
    vendor: 'lemonsqueezy',
    mechanism_kind: 'raw_body_hmac',
    transport_assurance: 'authenticated',
    // Authentication proves the exact delivery bytes, but Lemon Squeezy does
    // not document a signed timestamp or stable delivery id. Payment and
    // entitlement consumers must strengthen this minimum with provider
    // read-back instead of treating a possibly replayed callback as current
    // account state.
    minimum_source_truth_policy: 'delivery_payload_allowed',
    decoder_kind: 'json',
    decoded_schema_id: 'lemonsqueezy.webhook.v1',
    event_types: {
      kind: 'open',
      known_values: [
        'order_created',
        'order_refunded',
        'customer_updated',
        'subscription_created',
        'subscription_updated',
        'subscription_cancelled',
        'subscription_resumed',
        'subscription_expired',
        'subscription_paused',
        'subscription_unpaused',
        'subscription_payment_success',
        'subscription_payment_failed',
        'subscription_payment_recovered',
        'subscription_payment_refunded',
        'license_key_created',
        'license_key_updated',
        'affiliate_activated',
      ],
      grammar: { kind: 'lowercase_identifier_event_type.v1', max_characters: 128 },
    },
    fields: [{
      key: 'signing_secret',
      label: 'Signing secret',
      kind: 'secret',
      required: true,
      source: 'owner',
      help_url: 'https://docs.lemonsqueezy.com/help/webhooks/signing-requests',
    }],
    registration_modes: ['manual'],
    supported_environments: ['test', 'live'],
    allowed_methods: ['POST'],
    allowed_content_types: JSON_CONTENT_TYPES,
    max_body_bytes: 1_048_576,
    max_events_per_delivery: 1,
    deduplication: RECEIVED_AT_BODY_WINDOW_DEDUPLICATION,
    managed_registration_requires_connection: false,
    handshakes: [],
  },
  {
    profile_id: 'slack.request.v0',
    vendor: 'slack',
    mechanism_kind: 'timestamped_hmac',
    transport_assurance: 'authenticated',
    minimum_source_truth_policy: 'delivery_payload_allowed',
    decoder_kind: 'json',
    decoded_schema_id: 'slack.request.v0',
    event_types: {
      kind: 'open',
      known_values: ['event_callback'],
      grammar: { kind: 'ascii_alphanumeric_dot_colon_slash_dash.v1', max_bytes: 128 },
    },
    fields: [{
      key: 'signing_secret',
      label: 'Signing secret',
      kind: 'secret',
      required: true,
      source: 'vendor_generated',
    }],
    registration_modes: ['manual'],
    supported_environments: GENERIC_ENVIRONMENTS,
    allowed_methods: ['POST'],
    allowed_content_types: ['application/json', 'application/x-www-form-urlencoded'],
    max_body_bytes: 1_048_576,
    max_events_per_delivery: 1,
    deduplication: STABLE_PROVIDER_ID_OR_SIGNED_TIMESTAMP_BODY_DEDUPLICATION,
    managed_registration_requires_connection: false,
    handshakes: ['slack_url_verification'],
  },
  {
    profile_id: 'slack.slash-command.v1',
    vendor: 'slack',
    mechanism_kind: 'timestamped_hmac',
    transport_assurance: 'authenticated',
    minimum_source_truth_policy: 'delivery_payload_allowed',
    decoder_kind: 'form_urlencoded',
    decoded_schema_id: 'slack.slash-command.v1',
    event_types: { kind: 'closed', values: ['slash_command'] },
    fields: [{
      key: 'signing_secret',
      label: 'Signing secret',
      kind: 'secret',
      required: true,
      source: 'vendor_generated',
    }],
    registration_modes: ['manual'],
    supported_environments: GENERIC_ENVIRONMENTS,
    allowed_methods: ['POST'],
    allowed_content_types: ['application/x-www-form-urlencoded'],
    max_body_bytes: 1_048_576,
    max_events_per_delivery: 1,
    deduplication: STABLE_PROVIDER_ID_DEDUPLICATION,
    managed_registration_requires_connection: false,
    handshakes: [],
  },
  {
    profile_id: 'telegram.bot-webhook.v1',
    vendor: 'telegram',
    mechanism_kind: 'static_header_token',
    transport_assurance: 'authenticated',
    minimum_source_truth_policy: 'delivery_payload_allowed',
    decoder_kind: 'json',
    decoded_schema_id: 'telegram.bot-update.v1',
    event_types: {
      kind: 'open',
      known_values: ['message', 'edited_message', 'callback_query'],
      // D-201 Slice 10G — the names Telegram stores and sends: it lowercases
      // each name it is given (a `Message` came back `message`, so read-back
      // never matched and a manual webhook never received it). The name is the
      // Update's one member, so it must be one the JSON reader takes.
      grammar: { kind: 'lowercase_json_member_event_type.v1', max_characters: 128 },
      // D-201 Slices 10O and 10T — kinds the Bot API server holds but never
      // lists in `allowed_updates`.
      never_listed: ['custom_event', 'custom_query'],
    },
    fields: [{
      key: 'secret_token',
      label: 'Webhook secret token',
      kind: 'secret',
      required: true,
      source: 'recued_generated',
    }],
    registration_modes: ['manual', 'managed_endpoint'],
    supported_environments: GENERIC_ENVIRONMENTS,
    allowed_methods: ['POST'],
    allowed_content_types: JSON_CONTENT_TYPES,
    max_body_bytes: 1_048_576,
    max_events_per_delivery: 1,
    deduplication: STABLE_PROVIDER_ID_DEDUPLICATION,
    managed_registration_requires_connection: true,
    // D-201 Slice 10AW (10AS finding 8) — the bot is a notification connection.
    paired_connection_kind: 'notification',
    handshakes: [],
  },
  {
    profile_id: 'github.webhook.v1',
    vendor: 'github',
    mechanism_kind: 'raw_body_hmac',
    transport_assurance: 'authenticated',
    minimum_source_truth_policy: 'delivery_payload_allowed',
    decoder_kind: 'json',
    decoded_schema_id: 'github.webhook.v1',
    event_types: {
      kind: 'open',
      known_values: [
        'check_run',
        'check_suite',
        'create',
        'delete',
        'deployment',
        'deployment_status',
        'discussion',
        'discussion_comment',
        'fork',
        'issue_comment',
        'issues',
        'pull_request',
        'pull_request_review',
        'pull_request_review_comment',
        'push',
        'release',
        'repository',
        'status',
        'workflow_job',
        'workflow_run',
      ],
      grammar: { kind: 'lowercase_identifier_event_type.v1', max_characters: 128 },
    },
    fields: [{
      key: 'webhook_secret',
      label: 'Webhook secret',
      kind: 'secret',
      required: true,
      source: 'recued_generated',
      help_url:
        'https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries',
    }],
    registration_modes: ['manual', 'managed_endpoint'],
    supported_environments: GENERIC_ENVIRONMENTS,
    allowed_methods: ['POST'],
    allowed_content_types: JSON_CONTENT_TYPES,
    max_body_bytes: 1_048_576,
    max_events_per_delivery: 1,
    deduplication: STABLE_PROVIDER_ID_DEDUPLICATION,
    managed_registration_requires_connection: true,
    handshakes: [],
  },
  {
    profile_id: 'cal.webhook.v1',
    vendor: 'cal.com',
    mechanism_kind: 'raw_body_hmac',
    transport_assurance: 'authenticated',
    // Cal signs the delivery bytes, but project mutations are authorized only
    // by fresh booking and attendee reads over the paired account.
    minimum_source_truth_policy: 'provider_readback_required',
    decoder_kind: 'json',
    decoded_schema_id: 'cal.webhook.v1',
    event_types: {
      kind: 'closed',
      // This profile is deliberately narrower than Cal.com's whole webhook
      // catalog. Add another event only with its payload normalizer and stable
      // identity; accepting it here is an executable claim, not documentation.
      values: [
        'RECORDING_TRANSCRIPTION_GENERATED',
        'BOOKING_CANCELLED',
        'BOOKING_RESCHEDULED',
        'BOOKING_NO_SHOW_UPDATED',
        'BOOKING_PAID',
      ],
    },
    fields: [{
      key: 'signing_secret',
      label: 'Cal.com webhook signing secret',
      kind: 'secret',
      required: true,
      source: 'owner',
      help_url: 'https://cal.com/docs/developing/guides/automation/webhooks',
    }],
    registration_modes: ['manual'],
    supported_environments: GENERIC_ENVIRONMENTS,
    allowed_methods: ['POST'],
    allowed_content_types: JSON_CONTENT_TYPES,
    max_body_bytes: 1_048_576,
    max_events_per_delivery: 1,
    deduplication: STABLE_PROVIDER_ID_DEDUPLICATION,
    managed_registration_requires_connection: false,
    handshakes: [],
  },
  {
    profile_id: 'generic.static-header-token.v1',
    vendor: 'generic',
    mechanism_kind: 'static_header_token',
    transport_assurance: 'authenticated',
    minimum_source_truth_policy: 'delivery_payload_allowed',
    decoder_kind: 'json',
    decoded_schema_id: 'generic.delivery.v1',
    event_types: GENERIC_DELIVERY_EVENT_TYPES,
    fields: [
      { key: 'header_name', label: 'Header name', kind: 'text', required: true, source: 'owner' },
      { key: 'header_token', label: 'Header token', kind: 'secret', required: true, source: 'owner' },
    ],
    registration_modes: ['manual', 'operation_bound'],
    supported_environments: GENERIC_ENVIRONMENTS,
    allowed_methods: ['POST'],
    allowed_content_types: JSON_CONTENT_TYPES,
    max_body_bytes: 1_048_576,
    max_events_per_delivery: 1,
    deduplication: RECEIVED_AT_BODY_WINDOW_DEDUPLICATION,
    managed_registration_requires_connection: false,
    handshakes: [],
  },
  {
    profile_id: 'generic.raw-body-hmac-sha256.v1',
    vendor: 'generic',
    mechanism_kind: 'raw_body_hmac',
    transport_assurance: 'authenticated',
    minimum_source_truth_policy: 'delivery_payload_allowed',
    decoder_kind: 'json',
    decoded_schema_id: 'generic.delivery.v1',
    event_types: GENERIC_DELIVERY_EVENT_TYPES,
    fields: [
      { key: 'signature_header', label: 'Signature header', kind: 'text', required: true, source: 'owner' },
      { key: 'signing_secret', label: 'Signing secret', kind: 'secret', required: true, source: 'owner' },
    ],
    registration_modes: ['manual'],
    supported_environments: GENERIC_ENVIRONMENTS,
    allowed_methods: ['POST'],
    allowed_content_types: JSON_CONTENT_TYPES,
    max_body_bytes: 1_048_576,
    max_events_per_delivery: 1,
    deduplication: RECEIVED_AT_BODY_WINDOW_DEDUPLICATION,
    managed_registration_requires_connection: false,
    handshakes: [],
  },
  {
    profile_id: 'generic.timestamped-raw-body-hmac-sha256.v1',
    vendor: 'generic',
    mechanism_kind: 'timestamped_hmac',
    transport_assurance: 'authenticated',
    minimum_source_truth_policy: 'delivery_payload_allowed',
    decoder_kind: 'json',
    decoded_schema_id: 'generic.delivery.v1',
    event_types: GENERIC_DELIVERY_EVENT_TYPES,
    fields: [
      { key: 'signature_header', label: 'Timestamped signature header', kind: 'text', required: true, source: 'owner' },
      { key: 'signing_secret', label: 'Signing secret', kind: 'secret', required: true, source: 'owner' },
    ],
    registration_modes: ['manual'],
    supported_environments: GENERIC_ENVIRONMENTS,
    allowed_methods: ['POST'],
    allowed_content_types: JSON_CONTENT_TYPES,
    max_body_bytes: 1_048_576,
    max_events_per_delivery: 1,
    deduplication: SIGNED_TIMESTAMP_BODY_DEDUPLICATION,
    managed_registration_requires_connection: false,
    handshakes: [],
  },
  {
    profile_id: 'generic.http-basic.v1',
    vendor: 'generic',
    mechanism_kind: 'http_basic',
    transport_assurance: 'authenticated',
    minimum_source_truth_policy: 'delivery_payload_allowed',
    decoder_kind: 'json',
    decoded_schema_id: 'generic.delivery.v1',
    event_types: GENERIC_DELIVERY_EVENT_TYPES,
    fields: [
      { key: 'username', label: 'Username', kind: 'username', required: true, source: 'owner' },
      { key: 'password', label: 'Password', kind: 'password', required: true, source: 'owner' },
    ],
    registration_modes: ['manual'],
    supported_environments: GENERIC_ENVIRONMENTS,
    allowed_methods: ['POST'],
    allowed_content_types: JSON_CONTENT_TYPES,
    max_body_bytes: 1_048_576,
    max_events_per_delivery: 1,
    deduplication: RECEIVED_AT_BODY_WINDOW_DEDUPLICATION,
    managed_registration_requires_connection: false,
    handshakes: [],
  },
  {
    // SPIKE — Recued-to-Recued peer exchange. Unlike every other descriptor here
    // this one has no vendor on the far side: both ends are Recued servers, so
    // the wire format is ours to fix rather than a format we must accommodate.
    // Three differences from `generic.timestamped-raw-body-hmac-sha256.v1`, and
    // they are the whole reason this is a distinct profile:
    //   1. `event_types` is OPEN — a peer exchange kind (`appointment.reply`) is
    //      the trigger routing key, so it cannot be the single literal
    //      `'delivery'` that every generic profile collapses to.
    //   2. the signing secret is `recued_generated`, not owner-typed: enrolment
    //      mints it on one side and the peer stores it, which is the two-sided
    //      gesture D-209 §1.4 already calls the standing approval.
    //   3. `decoded_schema_id` names OUR envelope, so the normalizer can require
    //      `action_ref` rather than hoping a vendor supplies a stable id.
    profile_id: 'recued-peer.exchange.v1',
    // NOT `'generic'`, and the registry is right to insist: a generic profile is
    // a SHAPE with no event vocabulary (`validateWebhookProfileRegistry` pins it
    // to the single closed `'delivery'`). This profile has its own vocabulary,
    // so it must name a vendor — and the vendor of the Recued peer protocol is
    // Recued. Every other row here accommodates a format someone else owns;
    // this is the one where we are the far side.
    vendor: 'recued',
    mechanism_kind: 'timestamped_hmac',
    transport_assurance: 'authenticated',
    minimum_source_truth_policy: 'delivery_payload_allowed',
    decoder_kind: 'json',
    decoded_schema_id: 'recued-peer.exchange.v1',
    event_types: {
      kind: 'open',
      known_values: ['appointment.request', 'appointment.reply'],
      grammar: { kind: 'ascii_alphanumeric_dot_colon_slash_dash.v1', max_bytes: 128 },
    },
    fields: [
      {
        key: 'signing_secret',
        label: 'Peer signing secret',
        kind: 'secret',
        required: true,
        source: 'recued_generated',
      },
    ],
    registration_modes: ['manual'],
    // Not GENERIC_ENVIRONMENTS: the envelope's `live` boolean yields exactly
    // two environments, so claiming 'custom' would advertise a state the
    // admission map cannot produce.
    supported_environments: ['test', 'live'],
    allowed_methods: ['POST'],
    allowed_content_types: JSON_CONTENT_TYPES,
    max_body_bytes: 1_048_576,
    max_events_per_delivery: 1,
    deduplication: STABLE_PROVIDER_ID_OR_SIGNED_TIMESTAMP_BODY_DEDUPLICATION,
    managed_registration_requires_connection: false,
    handshakes: [],
  },
] as const satisfies readonly WebhookProfileDescriptor[];

const freezeProfileDescriptor = (
  profile: WebhookProfileDescriptor,
): WebhookProfileDescriptor => Object.freeze({
  ...profile,
  event_types: profile.event_types.kind === 'closed'
    ? Object.freeze({ kind: 'closed' as const, values: Object.freeze([...profile.event_types.values]) })
    : Object.freeze({
        kind: 'open' as const,
        known_values: Object.freeze([...profile.event_types.known_values]),
        grammar: Object.freeze({ ...profile.event_types.grammar }),
        ...(profile.event_types.never_listed !== undefined
          ? { never_listed: Object.freeze([...profile.event_types.never_listed]) }
          : {}),
      }),
  fields: Object.freeze(profile.fields.map((field) => Object.freeze({ ...field }))),
  registration_modes: Object.freeze([...profile.registration_modes]),
  supported_environments: Object.freeze([...profile.supported_environments]),
  allowed_methods: Object.freeze([...profile.allowed_methods]),
  allowed_content_types: Object.freeze([...profile.allowed_content_types]),
  deduplication: Object.freeze({
    ...profile.deduplication,
    identity: Object.freeze({ ...profile.deduplication.identity }),
  }),
  handshakes: Object.freeze([...profile.handshakes]),
});

/** Null-prototype, deeply frozen lookup table: profile ids come from untrusted
 * manifests, so neither inherited names (`constructor`) nor later mutation can
 * change which portable contract a profile id denotes. */
const mutableProfileRegistry = Object.create(null) as Record<WebhookProfileId, WebhookProfileDescriptor>;
for (const descriptor of WEBHOOK_PROFILE_DESCRIPTOR_LIST) {
  if (Object.prototype.hasOwnProperty.call(mutableProfileRegistry, descriptor.profile_id)) {
    throw new Error(`Duplicate D-201 webhook profile descriptor '${descriptor.profile_id}'`);
  }
  mutableProfileRegistry[descriptor.profile_id] = freezeProfileDescriptor(descriptor);
}
export const WEBHOOK_PROFILE_REGISTRY: Readonly<Record<WebhookProfileId, WebhookProfileDescriptor>> =
  Object.freeze(mutableProfileRegistry);

/** Trusted-registry self-check.  TypeScript closes enum spelling, while these
 * runtime invariants protect the security relationships between fields (most
 * importantly: notification-only admission can never authorize callback
 * payload state). */
export const validateWebhookProfileRegistry = (
  registry: Readonly<Record<string, WebhookProfileDescriptor>> = WEBHOOK_PROFILE_REGISTRY,
): string[] => {
  const issues: string[] = [];
  const expectedIds = new Set<string>(WEBHOOK_PROFILE_IDS);
  for (const profileId of WEBHOOK_PROFILE_IDS) {
    if (!Object.prototype.hasOwnProperty.call(registry, profileId)) {
      issues.push(`registry: missing required profile '${profileId}'`);
    }
  }
  for (const [key, profile] of Object.entries(registry)) {
    const at = `profile '${key}'`;
    if (!expectedIds.has(key)) issues.push(`${at}: registry key is not in WEBHOOK_PROFILE_IDS`);
    if (profile.profile_id !== key) issues.push(`${at}: profile_id must equal its registry key`);
    if (!WEBHOOK_PROFILE_ID_RE.test(profile.profile_id)) issues.push(`${at}: profile_id has invalid shape`);
    if (profile.transport_assurance === 'notification_only'
      && profile.minimum_source_truth_policy !== 'provider_readback_required') {
      issues.push(`${at}: notification_only profiles must require provider read-back`);
    }
    if (profile.transport_assurance === 'notification_only'
      && profile.mechanism_kind !== 'unauthenticated_pointer') {
      issues.push(`${at}: notification_only assurance requires unauthenticated_pointer mechanism_kind`);
    }
    if (profile.mechanism_kind === 'unauthenticated_pointer'
      && profile.transport_assurance !== 'notification_only') {
      issues.push(`${at}: unauthenticated_pointer mechanism_kind must be labelled notification_only`);
    }
    if (profile.vendor === 'generic' && profile.transport_assurance === 'notification_only') {
      issues.push(`${at}: generic profiles may not use notification_only assurance`);
    }
    const eventTypes = profile.event_types.kind === 'closed'
      ? profile.event_types.values
      : profile.event_types.known_values;
    if (profile.event_types.kind === 'closed' && eventTypes.length === 0) {
      issues.push(`${at}: a closed event catalog must not be empty`);
    }
    // D-201 Slice 10C — an open catalog names its grammar, and every name it
    // offers is in that grammar's language.
    const grammarIssues = profile.event_types.kind === 'open'
      ? validateWebhookEventTypeGrammar(profile.event_types.grammar)
      : [];
    for (const issue of grammarIssues) issues.push(`${at}: ${issue}`);
    const seenEvents = new Set<string>();
    for (const eventType of eventTypes) {
      if (!WEBHOOK_EVENT_TYPE_RE.test(eventType)) issues.push(`${at}: invalid event type '${eventType}'`);
      if (profile.event_types.kind === 'open'
        && grammarIssues.length === 0
        && !webhookEventTypeGrammarAccepts(profile.event_types.grammar, eventType)) {
        issues.push(`${at}: known event type '${eventType}' is outside the catalog's grammar`);
      }
      if (seenEvents.has(eventType)) issues.push(`${at}: duplicate event type '${eventType}'`);
      seenEvents.add(eventType);
    }
    // D-201 Slice 10T — a name the service never lists is one it takes: in the
    // grammar, and not one Settings offers.
    for (const eventType of profile.event_types.kind === 'open' ? profile.event_types.never_listed ?? [] : []) {
      if (profile.event_types.kind === 'open'
        && grammarIssues.length === 0
        && !webhookEventTypeGrammarAccepts(profile.event_types.grammar, eventType)) {
        issues.push(`${at}: never-listed event type '${eventType}' is outside the catalog's grammar`);
      }
      if (seenEvents.has(eventType)) issues.push(`${at}: never-listed event type '${eventType}' is also offered`);
    }
    if (profile.vendor === 'generic'
      && (profile.event_types.kind !== 'closed'
        || profile.event_types.values.length !== 1
        || profile.event_types.values[0] !== 'delivery')) {
      issues.push(`${at}: generic v1 profiles must expose only the closed 'delivery' event`);
    }
    if (profile.registration_modes.length === 0) issues.push(`${at}: registration_modes must not be empty`);
    if (profile.supported_environments.length === 0) issues.push(`${at}: supported_environments must not be empty`);
    if (profile.allowed_methods.length === 0
      || profile.allowed_methods.some((method) => !/^[A-Z]+$/.test(method))) {
      issues.push(`${at}: allowed_methods must contain uppercase HTTP methods`);
    }
    if (!Number.isInteger(profile.max_body_bytes) || profile.max_body_bytes <= 0) {
      issues.push(`${at}: max_body_bytes must be a positive integer`);
    }
    if (!Number.isInteger(profile.max_events_per_delivery) || profile.max_events_per_delivery <= 0) {
      issues.push(`${at}: max_events_per_delivery must be a positive integer`);
    }
    const deduplication = profile.deduplication as WebhookDeduplicationPolicy | undefined;
    if (deduplication === undefined
      || deduplication === null
      || typeof deduplication !== 'object'
      || !Number.isSafeInteger(deduplication.tombstone_horizon_ms)
      || deduplication.tombstone_horizon_ms <= 0) {
      issues.push(`${at}: deduplication tombstone horizon must be a positive safe integer`);
    } else {
      if (Object.keys(deduplication).sort().join(',') !== 'identity,tombstone_horizon_ms') {
        issues.push(`${at}: deduplication must contain only identity and tombstone_horizon_ms`);
      }
      const identity = deduplication.identity as WebhookDeduplicationIdentity | undefined;
      if (identity === undefined || identity === null || typeof identity !== 'object') {
        issues.push(`${at}: deduplication identity must be declared`);
      } else if (identity.kind === 'received_at_body_window') {
        if (Object.keys(identity).sort().join(',') !== 'kind,window_ms') {
          issues.push(`${at}: received-at body identity must contain only kind and window_ms`);
        }
        if (!Number.isSafeInteger(identity.window_ms) || identity.window_ms <= 0) {
          issues.push(`${at}: received-at body identity window must be a positive safe integer`);
        } else if (identity.window_ms > deduplication.tombstone_horizon_ms) {
          issues.push(`${at}: received-at body identity window must not outlive its tombstone horizon`);
        }
      } else if (identity.kind !== 'stable_provider_id'
        && identity.kind !== 'stable_provider_id_or_signed_timestamp_body'
        && identity.kind !== 'signed_timestamp_body') {
        issues.push(`${at}: unsupported deduplication identity kind`);
      } else if (Object.keys(identity).join(',') !== 'kind') {
        issues.push(`${at}: stable or signed deduplication identity must contain only kind`);
      }
    }
    if (profile.managed_registration_requires_connection
      && !profile.registration_modes.some((mode) => mode !== 'manual')) {
      issues.push(`${at}: managed_registration_requires_connection needs a managed registration mode`);
    }
    // D-201 Slice 10AW — named only where a webhook pairs, and from the list.
    if (profile.paired_connection_kind !== undefined) {
      if (!(WEBHOOK_PAIRED_CONNECTION_KINDS as readonly string[]).includes(profile.paired_connection_kind)) {
        issues.push(`${at}: paired_connection_kind must be one of ${WEBHOOK_PAIRED_CONNECTION_KINDS.join(', ')}`);
      }
      if (!profile.registration_modes.some((mode) => webhookProfileRequiresPairedConnection(profile, mode))) {
        issues.push(`${at}: paired_connection_kind needs a registration mode that pairs a connection`);
      }
    }
    const seenFields = new Set<string>();
    for (const field of profile.fields) {
      if (!WEBHOOK_BINDING_RE.test(field.key) || !isSafeWebhookIdentifier(field.key)) {
        issues.push(`${at}: invalid or reserved field key '${field.key}'`);
      }
      if (seenFields.has(field.key)) issues.push(`${at}: duplicate field key '${field.key}'`);
      seenFields.add(field.key);
    }
  }
  return issues;
};

const WEBHOOK_PROFILE_REGISTRY_ISSUES = validateWebhookProfileRegistry();
if (WEBHOOK_PROFILE_REGISTRY_ISSUES.length > 0) {
  throw new Error(`Invalid D-201 webhook profile registry:\n${WEBHOOK_PROFILE_REGISTRY_ISSUES.join('\n')}`);
}

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

export const isWebhookProfileId = (value: unknown): value is WebhookProfileId =>
  typeof value === 'string' && hasOwn(WEBHOOK_PROFILE_REGISTRY, value);

export const webhookProfile = (value: unknown): WebhookProfileDescriptor | null =>
  isWebhookProfileId(value) ? WEBHOOK_PROFILE_REGISTRY[value] : null;

/** The one answer to "does this profile take this event type", for every
 * caller: pack and recipe validation, the ingress RPC, registration, the
 * runtime listener and Settings. A closed catalog takes its values; an open one
 * takes its grammar's language (D-201 Slice 10C), which before then was the
 * broad `WEBHOOK_EVENT_TYPE_RE` for every open profile, wider than what each
 * profile's runtime parser admits. */
export const webhookProfileAcceptsEventType = (
  profile: WebhookProfileDescriptor,
  eventType: unknown,
): eventType is string => {
  if (typeof eventType !== 'string' || !WEBHOOK_EVENT_TYPE_RE.test(eventType)) return false;
  return profile.event_types.kind === 'open'
    ? webhookEventTypeGrammarAccepts(profile.event_types.grammar, eventType)
    : profile.event_types.values.includes(eventType);
};

// ────────────────────────────────────────────────────────────────
// Pack / local-recipe declarations
// ────────────────────────────────────────────────────────────────

export interface PackWebhookRequirement {
  binding: string;
  profile_ids: readonly WebhookProfileId[];
  paired_connection_slot?: string;
  required_event_types?: readonly string[];
  optional_event_types?: readonly string[];
  registration_modes?: readonly WebhookRegistrationMode[];
  environment_policy?: WebhookEnvironmentPolicy;
  decoded_payload_access: WebhookDecodedPayloadAccess;
  source_truth_policy: WebhookSourceTruthPolicy;
}

export type RecipeWebhookRequirement = PackWebhookRequirement;

/** D-295 — one webhook the install dialog has the owner choose: a pack's
 *  requirement, the owner's webhooks that FIT it (by the install's own rule, so
 *  the dialog never offers one the install then refuses), and on an update the
 *  one it uses now. Covers the pack and every dependency the install will touch. */
export interface PackWebhookPlanEntry {
  pack_slug: string;
  pack_name: string;
  binding: string;
  /** Who sends the events (`stripe`, `calcom`, …), from the first profile. */
  vendor: string;
  /** Every event the chosen webhook must deliver: the requirement's own, and
   *  each one a recipe of the pack triggers on. */
  event_types: readonly string[];
  /** The owner's webhooks that fit, by name. */
  candidates: ReadonlyArray<{ ingress_id: string; display_name: string }>;
  /** An update: the webhook this binding uses now. `fits: false` when it no
   *  longer does (disabled, missing an event…) — the dialog says so rather than
   *  quietly proposing another. */
  current?: { ingress_id: string; display_name: string; fits: boolean };
}

export interface RecipeWebhookTrigger {
  binding: string;
  event_types: readonly string[];
}

export interface WebhookContractIssue {
  code:
    | 'shape'
    | 'unknown_field'
    | 'binding_invalid'
    | 'binding_duplicate'
    | 'profile_ids_invalid'
    | 'profile_unknown'
    | 'profile_incompatible'
    | 'event_types_invalid'
    | 'event_type_duplicate'
    | 'event_type_overlap'
    | 'event_type_incompatible'
    | 'registration_mode_invalid'
    | 'registration_mode_incompatible'
    | 'environment_policy_invalid'
    | 'paired_connection_required'
    | 'paired_connection_invalid'
    | 'payload_access_invalid'
    | 'source_truth_policy_invalid'
    | 'source_truth_policy_too_weak'
    | 'trigger_binding_unknown'
    | 'trigger_event_undeclared';
  path: string;
  message: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const requirementKeys = new Set([
  'binding',
  'profile_ids',
  'paired_connection_slot',
  'required_event_types',
  'optional_event_types',
  'registration_modes',
  'environment_policy',
  'decoded_payload_access',
  'source_truth_policy',
]);

const appendPath = (base: string, field: string): string => base.length > 0 ? `${base}.${field}` : field;

const validateEventTypeArray = (
  value: unknown,
  path: string,
  required: boolean,
  max: number,
): { values: string[]; issues: WebhookContractIssue[] } => {
  const issues: WebhookContractIssue[] = [];
  if (value === undefined && !required) return { values: [], issues };
  if (!Array.isArray(value) || (required && value.length === 0) || value.length > max) {
    issues.push({
      code: 'event_types_invalid',
      path,
      message: `${path} must be ${required ? 'a non-empty' : 'an'} array with at most ${max} event types`,
    });
    return { values: [], issues };
  }
  const values: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    if (!hasOwn(value, i)) {
      issues.push({
        code: 'event_types_invalid',
        path: `${path}[${i}]`,
        message: 'event type entries must be own array elements (sparse/inherited entries are not allowed)',
      });
      continue;
    }
    const entry = value[i];
    if (typeof entry !== 'string' || !WEBHOOK_EVENT_TYPE_RE.test(entry)) {
      issues.push({
        code: 'event_types_invalid',
        path: `${path}[${i}]`,
        message: `event type must match ${WEBHOOK_EVENT_TYPE_RE.source}`,
      });
      continue;
    }
    if (seen.has(entry)) {
      issues.push({ code: 'event_type_duplicate', path: `${path}[${i}]`, message: `duplicate event type '${entry}'` });
      continue;
    }
    seen.add(entry);
    values.push(entry);
  }
  return { values, issues };
};

/** Validate one pack/local-recipe requirement.  Returned paths are relative to
 * `path`, allowing pack, recipe, and install validators to share the grammar. */
export const validateWebhookRequirement = (
  input: unknown,
  path = '',
): WebhookContractIssue[] => {
  if (!isRecord(input)) {
    return [{ code: 'shape', path, message: 'webhook requirement must be an object' }];
  }
  const issues: WebhookContractIssue[] = [];
  for (const key of Object.keys(input)) {
    if (!requirementKeys.has(key)) {
      issues.push({
        code: 'unknown_field',
        path: appendPath(path, key),
        message: `unknown webhook requirement field '${key}'`,
      });
    }
  }

  if (typeof input.binding !== 'string'
    || !WEBHOOK_BINDING_RE.test(input.binding)
    || !isSafeWebhookIdentifier(input.binding)) {
    issues.push({
      code: 'binding_invalid',
      path: appendPath(path, 'binding'),
      message: `binding must match ${WEBHOOK_BINDING_RE.source} and must not be a prototype-sensitive reserved name`,
    });
  }

  const profiles: WebhookProfileDescriptor[] = [];
  if (!Array.isArray(input.profile_ids)
    || input.profile_ids.length === 0
    || input.profile_ids.length > MAX_WEBHOOK_PROFILES_PER_REQUIREMENT) {
    issues.push({
      code: 'profile_ids_invalid',
      path: appendPath(path, 'profile_ids'),
      message: `profile_ids must contain 1..${MAX_WEBHOOK_PROFILES_PER_REQUIREMENT} registered profile ids`,
    });
  } else {
    const seen = new Set<string>();
    for (let i = 0; i < input.profile_ids.length; i++) {
      if (!hasOwn(input.profile_ids, i)) {
        issues.push({
          code: 'profile_ids_invalid',
          path: `${appendPath(path, 'profile_ids')}[${i}]`,
          message: 'profile ids must be own array elements (sparse/inherited entries are not allowed)',
        });
        continue;
      }
      const profileId = input.profile_ids[i];
      const profilePath = `${appendPath(path, 'profile_ids')}[${i}]`;
      if (typeof profileId !== 'string' || !WEBHOOK_PROFILE_ID_RE.test(profileId)) {
        issues.push({ code: 'profile_ids_invalid', path: profilePath, message: `profile id must match ${WEBHOOK_PROFILE_ID_RE.source}` });
        continue;
      }
      if (seen.has(profileId)) {
        issues.push({ code: 'profile_ids_invalid', path: profilePath, message: `duplicate profile id '${profileId}'` });
        continue;
      }
      seen.add(profileId);
      const profile = webhookProfile(profileId);
      if (profile === null) {
        issues.push({ code: 'profile_unknown', path: profilePath, message: `webhook profile '${profileId}' is not in the trusted registry` });
      } else {
        profiles.push(profile);
      }
    }
  }

  const requiredEvents = validateEventTypeArray(
    input.required_event_types,
    appendPath(path, 'required_event_types'),
    false,
    MAX_WEBHOOK_EVENT_TYPES_PER_REQUIREMENT,
  );
  const optionalEvents = validateEventTypeArray(
    input.optional_event_types,
    appendPath(path, 'optional_event_types'),
    false,
    MAX_WEBHOOK_EVENT_TYPES_PER_REQUIREMENT,
  );
  issues.push(...requiredEvents.issues, ...optionalEvents.issues);
  const requiredSet = new Set(requiredEvents.values);
  for (let i = 0; i < optionalEvents.values.length; i++) {
    const eventType = optionalEvents.values[i];
    if (requiredSet.has(eventType)) {
      issues.push({
        code: 'event_type_overlap',
        path: `${appendPath(path, 'optional_event_types')}[${i}]`,
        message: `event type '${eventType}' cannot be both required and optional`,
      });
    }
  }
  for (const profile of profiles) {
    for (const eventType of [...requiredEvents.values, ...optionalEvents.values]) {
      if (!webhookProfileAcceptsEventType(profile, eventType)) {
        issues.push({
          code: 'event_type_incompatible',
          path: appendPath(path, 'profile_ids'),
          message: `profile '${profile.profile_id}' does not admit event type '${eventType}'`,
        });
      }
    }
  }

  if (profiles.length > 1) {
    const schemas = new Set(profiles.map((profile) => profile.decoded_schema_id));
    const assurances = new Set(profiles.map((profile) => profile.transport_assurance));
    if (schemas.size > 1 || assurances.size > 1) {
      issues.push({
        code: 'profile_incompatible',
        path: appendPath(path, 'profile_ids'),
        message: 'alternative profiles must expose the same decoded schema and transport assurance',
      });
    }
  }

  let registrationModes: WebhookRegistrationMode[] = [];
  if (input.registration_modes !== undefined) {
    if (!Array.isArray(input.registration_modes)
      || input.registration_modes.length === 0
      || input.registration_modes.length > WEBHOOK_REGISTRATION_MODES.length) {
      issues.push({
        code: 'registration_mode_invalid',
        path: appendPath(path, 'registration_modes'),
        message: 'registration_modes must be a non-empty array of registered modes when present',
      });
    } else {
      const seen = new Set<string>();
      for (let i = 0; i < input.registration_modes.length; i++) {
        if (!hasOwn(input.registration_modes, i)) {
          issues.push({
            code: 'registration_mode_invalid',
            path: `${appendPath(path, 'registration_modes')}[${i}]`,
            message: 'registration modes must be own array elements (sparse/inherited entries are not allowed)',
          });
          continue;
        }
        const mode = input.registration_modes[i];
        const modePath = `${appendPath(path, 'registration_modes')}[${i}]`;
        if (typeof mode !== 'string'
          || !(WEBHOOK_REGISTRATION_MODES as readonly string[]).includes(mode)) {
          issues.push({ code: 'registration_mode_invalid', path: modePath, message: `unknown webhook registration mode ${JSON.stringify(mode)}` });
          continue;
        }
        if (seen.has(mode)) {
          issues.push({ code: 'registration_mode_invalid', path: modePath, message: `duplicate registration mode '${mode}'` });
          continue;
        }
        seen.add(mode);
        registrationModes.push(mode as WebhookRegistrationMode);
      }
      for (const profile of profiles) {
        if (!registrationModes.some((mode) => profile.registration_modes.includes(mode))) {
          issues.push({
            code: 'registration_mode_incompatible',
            path: appendPath(path, 'registration_modes'),
            message: `none of the requested registration modes is supported by profile '${profile.profile_id}'`,
          });
        }
      }
      for (const mode of registrationModes) {
        if (profiles.length > 0
          && !profiles.some((profile) => profile.registration_modes.includes(mode))) {
          issues.push({
            code: 'registration_mode_incompatible',
            path: appendPath(path, 'registration_modes'),
            message: `registration mode '${mode}' is not supported by any referenced profile`,
          });
        }
      }
    }
  }

  const environmentPolicy = input.environment_policy ?? 'any';
  if (typeof environmentPolicy !== 'string'
    || !(WEBHOOK_ENVIRONMENT_POLICIES as readonly string[]).includes(environmentPolicy)) {
    issues.push({
      code: 'environment_policy_invalid',
      path: appendPath(path, 'environment_policy'),
      message: `environment_policy must be one of ${WEBHOOK_ENVIRONMENT_POLICIES.join('|')}`,
    });
  } else {
    const requiredEnvironment = environmentPolicy === 'test_only'
      ? 'test'
      : environmentPolicy === 'live_only'
      ? 'live'
      : null;
    if (requiredEnvironment !== null) {
      for (const profile of profiles) {
        if (!profile.supported_environments.includes(requiredEnvironment)) {
          issues.push({
            code: 'environment_policy_invalid',
            path: appendPath(path, 'environment_policy'),
            message: `profile '${profile.profile_id}' does not support the '${requiredEnvironment}' environment`,
          });
        }
      }
    }
  }

  if (typeof input.decoded_payload_access !== 'string'
    || !(WEBHOOK_DECODED_PAYLOAD_ACCESS as readonly string[]).includes(input.decoded_payload_access)) {
    issues.push({
      code: 'payload_access_invalid',
      path: appendPath(path, 'decoded_payload_access'),
      message: `decoded_payload_access must be one of ${WEBHOOK_DECODED_PAYLOAD_ACCESS.join('|')}`,
    });
  }

  const sourceTruth = input.source_truth_policy;
  if (typeof sourceTruth !== 'string'
    || !(WEBHOOK_SOURCE_TRUTH_POLICIES as readonly string[]).includes(sourceTruth)) {
    issues.push({
      code: 'source_truth_policy_invalid',
      path: appendPath(path, 'source_truth_policy'),
      message: `source_truth_policy must be one of ${WEBHOOK_SOURCE_TRUTH_POLICIES.join('|')}`,
    });
  } else if (sourceTruth !== 'provider_readback_required'
    && profiles.some((profile) => profile.minimum_source_truth_policy === 'provider_readback_required')) {
    issues.push({
      code: 'source_truth_policy_too_weak',
      path: appendPath(path, 'source_truth_policy'),
      message: 'source_truth_policy cannot weaken a profile that requires provider read-back',
    });
  }

  const paired = input.paired_connection_slot;
  if (paired !== undefined && (typeof paired !== 'string'
    || !WEBHOOK_CONNECTION_SLOT_RE.test(paired)
    || !isSafeWebhookIdentifier(paired))) {
    issues.push({
      code: 'paired_connection_invalid',
      path: appendPath(path, 'paired_connection_slot'),
      message: `paired_connection_slot must match ${WEBHOOK_CONNECTION_SLOT_RE.source} and must not be a prototype-sensitive reserved name`,
    });
  }
  const needsPairedConnection =
    sourceTruth === 'provider_readback_required'
    || profiles.some((profile) => profile.minimum_source_truth_policy === 'provider_readback_required')
    || environmentPolicy === 'match_connection'
    || profiles.some((profile) => profile.transport_assurance === 'notification_only')
    || registrationModes.includes('operation_bound')
    || profiles.some((profile) => (
      profile.managed_registration_requires_connection
      && registrationModes.some((mode) => profile.registration_modes.includes(mode) && mode !== 'manual')
    ));
  if (needsPairedConnection && (typeof paired !== 'string'
    || !WEBHOOK_CONNECTION_SLOT_RE.test(paired)
    || !isSafeWebhookIdentifier(paired))) {
    issues.push({
      code: 'paired_connection_required',
      path: appendPath(path, 'paired_connection_slot'),
      message: 'paired_connection_slot is required for read-back, connection-matched environments, notification-only admission, or managed registration',
    });
  }

  return issues;
};

export const validateWebhookRequirements = (
  input: unknown,
  path = 'webhook_requirements',
): WebhookContractIssue[] => {
  if (!Array.isArray(input)) {
    return [{ code: 'shape', path, message: `${path} must be an array` }];
  }
  if (input.length > MAX_WEBHOOK_REQUIREMENTS) {
    return [{
      code: 'shape',
      path,
      message: `${path} may contain at most ${MAX_WEBHOOK_REQUIREMENTS} entries`,
    }];
  }
  const issues: WebhookContractIssue[] = [];
  const seenBindings = new Set<string>();
  for (let i = 0; i < input.length; i++) {
    const entryPath = `${path}[${i}]`;
    if (!hasOwn(input, i)) {
      issues.push({ code: 'shape', path: entryPath, message: 'webhook requirements must be own array elements' });
      continue;
    }
    issues.push(...validateWebhookRequirement(input[i], entryPath));
    const binding = isRecord(input[i]) ? input[i].binding : undefined;
    if (typeof binding !== 'string' || !WEBHOOK_BINDING_RE.test(binding)) continue;
    if (seenBindings.has(binding)) {
      issues.push({ code: 'binding_duplicate', path: `${entryPath}.binding`, message: `duplicate webhook binding '${binding}'` });
    }
    seenBindings.add(binding);
  }
  return issues;
};

const triggerKeys = new Set(['binding', 'event_types']);

export const validateRecipeWebhookTrigger = (
  input: unknown,
  path = '',
): WebhookContractIssue[] => {
  if (!isRecord(input)) {
    return [{ code: 'shape', path, message: 'webhook trigger must be an object' }];
  }
  const issues: WebhookContractIssue[] = [];
  for (const key of Object.keys(input)) {
    if (!triggerKeys.has(key)) {
      issues.push({ code: 'unknown_field', path: appendPath(path, key), message: `unknown webhook trigger field '${key}'` });
    }
  }
  if (typeof input.binding !== 'string'
    || !WEBHOOK_BINDING_RE.test(input.binding)
    || !isSafeWebhookIdentifier(input.binding)) {
    issues.push({
      code: 'binding_invalid',
      path: appendPath(path, 'binding'),
      message: `binding must match ${WEBHOOK_BINDING_RE.source} and must not be a prototype-sensitive reserved name`,
    });
  }
  issues.push(...validateEventTypeArray(
    input.event_types,
    appendPath(path, 'event_types'),
    true,
    MAX_WEBHOOK_EVENT_TYPES_PER_TRIGGER,
  ).issues);
  return issues;
};

export const validateRecipeWebhookTriggers = (
  input: unknown,
  path = 'webhook_triggers',
): WebhookContractIssue[] => {
  if (!Array.isArray(input)) {
    return [{ code: 'shape', path, message: `${path} must be an array` }];
  }
  if (input.length > MAX_WEBHOOK_TRIGGERS) {
    return [{ code: 'shape', path, message: `${path} may contain at most ${MAX_WEBHOOK_TRIGGERS} entries` }];
  }
  const issues: WebhookContractIssue[] = [];
  for (let i = 0; i < input.length; i++) {
    if (!hasOwn(input, i)) {
      issues.push({ code: 'shape', path: `${path}[${i}]`, message: 'webhook triggers must be own array elements' });
      continue;
    }
    issues.push(...validateRecipeWebhookTrigger(input[i], `${path}[${i}]`));
  }
  const seenSubscriptions = new Set<string>();
  for (let i = 0; i < input.length; i++) {
    if (!hasOwn(input, i)) continue;
    const trigger = input[i];
    if (!isRecord(trigger)
      || typeof trigger.binding !== 'string'
      || !WEBHOOK_BINDING_RE.test(trigger.binding)
      || !Array.isArray(trigger.event_types)) continue;
    const seenInEntry = new Set<string>();
    for (let j = 0; j < trigger.event_types.length; j++) {
      const eventType = trigger.event_types[j];
      if (typeof eventType !== 'string'
        || !WEBHOOK_EVENT_TYPE_RE.test(eventType)
        || seenInEntry.has(eventType)) continue;
      seenInEntry.add(eventType);
      const key = `${trigger.binding}\u0000${eventType}`;
      if (seenSubscriptions.has(key)) {
        issues.push({
          code: 'event_type_duplicate',
          path: `${path}[${i}].event_types[${j}]`,
          message: `duplicate webhook subscription '${trigger.binding}' / '${eventType}'`,
        });
      }
      seenSubscriptions.add(key);
    }
  }
  return issues;
};

/** Cross-artifact check used for local recipes immediately and by pack
 * publish/install once recipe refs have been resolved.  A trigger may consume
 * only event types declared by its logical requirement. */
export const validateWebhookTriggerBindings = (
  requirements: readonly unknown[],
  triggers: readonly unknown[],
  path = 'webhook_triggers',
): WebhookContractIssue[] => {
  const byBinding = new Map<string, Record<string, unknown>>();
  for (const requirement of requirements) {
    if (!isRecord(requirement)
      || typeof requirement.binding !== 'string'
      || !WEBHOOK_BINDING_RE.test(requirement.binding)) continue;
    byBinding.set(requirement.binding, requirement);
  }
  const issues: WebhookContractIssue[] = [];
  for (let i = 0; i < triggers.length; i++) {
    const trigger = triggers[i];
    if (!isRecord(trigger)
      || typeof trigger.binding !== 'string'
      || !WEBHOOK_BINDING_RE.test(trigger.binding)) continue;
    const requirement = byBinding.get(trigger.binding);
    if (requirement === undefined) {
      issues.push({
        code: 'trigger_binding_unknown',
        path: `${path}[${i}].binding`,
        message: `webhook trigger binding '${trigger.binding}' has no matching webhook requirement`,
      });
      continue;
    }
    const declared = new Set<string>([
      ...(Array.isArray(requirement.required_event_types) ? requirement.required_event_types.filter((v): v is string => typeof v === 'string') : []),
      ...(Array.isArray(requirement.optional_event_types) ? requirement.optional_event_types.filter((v): v is string => typeof v === 'string') : []),
    ]);
    if (!Array.isArray(trigger.event_types)) continue;
    for (let j = 0; j < trigger.event_types.length; j++) {
      const eventType = trigger.event_types[j];
      if (typeof eventType === 'string' && !declared.has(eventType)) {
        issues.push({
          code: 'trigger_event_undeclared',
          path: `${path}[${i}].event_types[${j}]`,
          message: `event type '${eventType}' is not required or optional on binding '${trigger.binding}'`,
        });
      }
    }
  }
  return issues;
};

// ────────────────────────────────────────────────────────────────
// Durable/presentation wire types (no request bytes or secrets)
// ────────────────────────────────────────────────────────────────

export type WebhookRegistrationState =
  | 'not_applicable'
  | 'manual_pending'
  | 'managed_pending'
  | 'registered'
  | 'drifted'
  | 'cleanup_pending'
  | 'retired';

export type WebhookIntakeState =
  | 'draft'
  | 'verification_pending'
  | 'ready'
  | 'enabled'
  | 'degraded'
  | 'disabled'
  | 'retired';

/** Secret-free provider scope selected by the owner for endpoint registration.
 * `profile_id` supplies the vendor-specific meaning and trusted core validates
 * the closed kind/key grammar before persistence or adapter dispatch. */
export interface WebhookRegistrationTarget {
  kind: string;
  key: string;
}

export interface WebhookIngressRecord {
  ingress_id: string;
  public_id: string;
  display_name: string;
  profile_id: WebhookProfileId;
  environment: WebhookEnvironment;
  paired_connection_id: string | null;
  registration_target: WebhookRegistrationTarget | null;
  /** Durable owner-selected target while trusted core is still removing the
   * endpoint from the current paired connection. Safe control-plane metadata;
   * it is never a credential or provider endpoint id. */
  pending_paired_connection_id?: string | null;
  credential_set_ref: string | null;
  registration_mode: WebhookRegistrationMode;
  remote_endpoint_id: string | null;
  /** Canonical endpoint the owner last confirmed at the vendor. Server-only
   * registration evidence; never accepted from a wire create/update payload. */
  confirmed_endpoint_url: string | null;
  selected_event_types: readonly string[];
  registration_state: WebhookRegistrationState;
  intake_state: WebhookIntakeState;
  test_observed_at: number | null;
  enabled_at: number | null;
  last_delivery_at: number | null;
  last_error_code: string | null;
  /** D-201 Slice 10K — with `last_error_code`
   * `managed_registration_event_types_unknown`: the event names the vendor did
   * not keep, for Settings to name. D-201 Slice 10O — and with
   * `managed_registration_event_types_unrestored`, the same when the vendor
   * could not be put back to the set it had and may now send every event
   * type. D-201 Slice 10Z (10V finding 25) — and with
   * `managed_registration_event_types_on_default`, the same when the vendor was
   * on its default set already and nothing was put back. Absent with any other
   * code. */
  last_error_event_types?: readonly string[];
  created_at: number;
  updated_at: number;
}

/** Secret-free metadata for one encrypted credential version.  The version is
 * opaque to consumers even though the current SQLite implementation allocates
 * monotonically increasing integers. */
export interface WebhookCredentialVersionView {
  version: string;
  created_at: number;
  retired_at: number | null;
  /** Safe transport-health metadata. Set only after this credential version
   * authenticates a durably accepted delivery; never carries credential data. */
  last_verified_at: number | null;
}

export type WebhookIngressReadinessBlocker =
  | 'credentials_incomplete'
  | 'credential_shape_invalid'
  | 'registration_incomplete'
  | 'registration_endpoint_changed'
  | 'event_selection_empty'
  | 'profile_runtime_unavailable'
  | 'paired_connection_unavailable'
  | 'paired_connection_rebind_required'
  | 'listener_unavailable'
  | 'public_url_unavailable'
  | 'public_reachability_disabled'
  | 'tls_unavailable'
  | 'clock_unverified'
  | 'vault_locked'
  | 'server_paused'
  | 'retired';

export interface WebhookIngressReadinessView {
  credentials_complete: boolean;
  registration_complete: boolean;
  /** Manual/managed endpoint mode: the trusted current endpoint equals the
   * exact endpoint last confirmed at the vendor. Operation-bound mode has no
   * durable remote endpoint object and reports true here. */
  registration_endpoint_matches: boolean;
  event_selection_complete: boolean;
  /** Persisted prerequisites only. Kept separate from the live runtime gate so
   * a configured-but-unreachable endpoint is never presented as enableable. */
  local_configuration_complete: boolean;
  profile_runtime_available: boolean;
  /** Live lookup of the required API connection. Optional manual profiles do
   * not depend on this field; a deletion latch remains a separate blocker even
   * when a same-name connection has since been enrolled. */
  paired_connection_available: boolean;
  listener_available: boolean;
  public_url_available: boolean;
  public_reachability_enabled: boolean;
  tls_ready: boolean;
  clock_ready: boolean;
  /** A code-backed simulator exists for this profile and test-environment
   * ingress. It is informational, not an enablement prerequisite; the action
   * still requires the ordinary live readiness fields above. */
  test_delivery_supported: boolean;
  vault_unlocked: boolean;
  server_unpaused: boolean;
  /** True when every projected non-secret local and live prerequisite passes.
   * Confirm/enable still revalidate decrypted credential shapes so legacy
   * invalid ciphertext metadata cannot make the mutation succeed. */
  can_enable: boolean;
  blockers: readonly WebhookIngressReadinessBlocker[];
}

export type WebhookIngressHealthStatus =
  | 'draft'
  | 'pending'
  | 'ready'
  | 'healthy'
  | 'degraded'
  | 'disabled'
  | 'retired';

export interface WebhookIngressHealthView {
  status: WebhookIngressHealthStatus;
  test_observed_at: number | null;
  last_delivery_at: number | null;
  last_error_code: string | null;
  /** D-201 Slice 10K — the event names the vendor did not keep, with
   * `last_error_code` `managed_registration_event_types_unknown`, (D-201
   * Slice 10O) `managed_registration_event_types_unrestored` or (D-201 Slice
   * 10Z) `managed_registration_event_types_on_default` only. */
  last_error_event_types?: readonly string[];
  /** D-201 Slice 10AN (the owner's call, 2026-11-20) — requests to the
   * webhook's address are being refused, none verifying with the secret it
   * holds, and no message has verified since `since`: at least `refused` of
   * them. `status` then reads `degraded`, never `healthy`. `set_again`: Recued
   * sets this webhook's secret at its service, and sets it again with the one
   * it holds, at most once an hour (`set_again_at` when it has in this run;
   * `set_again_failed_at` when its latest try in this run failed) and, since
   * D-201 Slice 10AU, while messages are still refused after its last set
   * again: a server from 10AR to 10AT did so once per run. Absent otherwise:
   * the secret is the service's or the owner's.
   * Absent from a server older than 10AN. D-201 Slice 10AR (10AM findings 11,
   * 28 and 30) — present only while the webhook takes messages; the run
   * counts from its last verified message, its last switch-on, or the making
   * of the secret it holds, whichever is latest; a time a clock that ran ahead
   * wrote is not trusted. Who sent them is not known: anyone with the address
   * can. `set_again_failed_at` is absent from a server older than 10AR. */
  refusing?: {
    refused: number;
    since: number;
    set_again?: true;
    set_again_at?: number;
    set_again_failed_at?: number;
  };
}

/** Owner-facing ingress projection.  `credential_set_ref`, ciphertext, and
 * credential values are deliberately unrepresentable.  Field names are profile
 * schema metadata rather than values and let the UI render configured/missing
 * state while the vault is locked. */
export interface WebhookIngressView {
  ingress_id: string;
  public_id: string;
  display_name: string;
  profile_id: WebhookProfileId;
  environment: WebhookEnvironment;
  paired_connection_id: string | null;
  registration_target: WebhookRegistrationTarget | null;
  /** Present while a managed-endpoint connection cutover is cleaning the old
   * provider account. The current connection remains authoritative until the
   * old endpoint is confirmed absent. */
  pending_paired_connection_id?: string | null;
  registration_mode: WebhookRegistrationMode;
  /** Trusted canonical URL derived by the server from its public-base
   * configuration. Null means reachability/TLS must be fixed before enablement.
   * It is never derived from a client Host header. */
  endpoint_url: string | null;
  remote_endpoint_id: string | null;
  selected_event_types: readonly string[];
  registration_state: WebhookRegistrationState;
  intake_state: WebhookIntakeState;
  configured_fields: readonly string[];
  missing_required_fields: readonly string[];
  active_credential_versions: readonly WebhookCredentialVersionView[];
  readiness: WebhookIngressReadinessView;
  health: WebhookIngressHealthView;
  /** D-201 Slice 10B — this ingress's unresolved dead letters. Absent from a
   * server that cannot count them. */
  dead_letters_unresolved?: number;
  /** D-201 Slice 10AH (10AE finding 8) — endpoints of this webhook's left at
   * its service that Recued could not remove yet: found by a change of
   * connection, a search after a create whose outcome was unknown, or a sweep.
   * The server's sweep keeps removing them, for a week of tries. Absent when
   * there are none, and from a server that cannot count them.
   * (D-201 Slice 10AQ, 10AM finding 26 — it said only "a move to another
   * connection" found them.) */
  stray_endpoints?: number;
  /** D-201 Slice 10AL (10AI finding 21) — endpoints of this webhook's left at
   * its service that Recued stopped trying to remove, after a week of failed
   * tries: the owner removes them there, then says so
   * (`webhook.ingress.strays.dismiss`). Absent when there are none, and from
   * a server older than 10AL, which has no such call. */
  stray_endpoints_given_up?: number;
  /** D-201 Slice 10AQ (10AM finding 7) — each of those strays, named: its
   * endpoint at the service and the connection whose account it is at, so the
   * owner can tell it from this webhook's own endpoint (`remote_endpoint_id`)
   * at the same account and address, whose removal stops messages coming in.
   * Absent when there are none, and from a server older than 10AQ, which
   * counts them only. */
  strays?: readonly WebhookStrayEndpointView[];
  /** D-201 Slice 10X — the recipes this webhook starts, each with its door,
   * so its card can show and open them (the switch here is the owner's
   * control, never a pack's). Absent from a server older than 10X. */
  recipes?: readonly WebhookIngressRecipeView[];
  /** D-201 Slice 10AF (the owner's rulings of 2026-11-20) — this server takes
   * `webhook.ingress.door.set`, so a card listing several recipes gives each
   * its own door switch beside the webhook's. Absent from an older server,
   * whose card opens doors by switching the webhook on. */
  recipe_door_switch?: true;
  enabled_at: number | null;
  created_at: number;
  updated_at: number;
}

/** D-201 Slice 10AQ (10AM finding 7) — one endpoint of a webhook's left at its
 *  service. */
export interface WebhookStrayEndpointView {
  /** Its id at the service. Null for one a server before 10AL recorded, which
   *  kept no id. */
  remote_endpoint_id: string | null;
  /** The connection whose account it is at: perhaps not the webhook's now. */
  connection_id: string;
  /** Recued stopped trying to remove it, after a week of failed tries: the
   *  owner removes it there, then says so (`webhook.ingress.strays.dismiss`). */
  given_up: boolean;
  /** D-201 Slice 10BA (10AY finding 4) — the search found it but could not
   *  prove it is this webhook's (it was changed at the service), so Recued does
   *  not remove it: the owner checks it there. With `given_up`, Recued stopped
   *  looking at it after a week. Absent from a server before 10BA. D-201 Slice
   *  10BQ (10BM finding 13) — at this webhook's address, or, with `elsewhere`,
   *  at another: this said always at this webhook's address.
   *
   *  D-201 Slice 10BK (10BF finding 14) said a webclient before 10BA counts
   *  such a stray among those Recued keeps trying to remove. D-201 Slice 10BY
   *  (10BX finding 3) — the released 26.11.9 webclient shows no notice of
   *  strays at all, so none does: that described builds no release carries. */
  unproven?: true;
  /** D-201 Slice 10BQ (10BM finding 13) — unproven, and found sending to
   *  another address than this webhook's (its address now, since 10BT; none of
   *  the addresses this server takes its messages at, since 10BY): what it
   *  sends never reaches this webhook, so it is no source of the messages
   *  refused here, though it still refuses setting this webhook up again. An
   *  address the server no longer lists as its own counts as another, though
   *  a name that still reaches the server would send here.
   *  Absent from a server before 10BQ, and on one found at this webhook's
   *  address. A given-up stray is not looked at again, so it keeps the value
   *  its last look found. The released 26.11.9 webclient shows no notice of
   *  strays at all; one built between 10BA and 10BQ, which no release carries,
   *  words it as sending to this webhook's address. */
  elsewhere?: true;
}

/** D-201 Slice 10X — one recipe a webhook starts, and the door its deliveries
 * run under. */
export interface WebhookIngressRecipeView {
  recipe_id: string;
  /** Its name, when the server holds the recipe. */
  name?: string;
  /** A Kitchen recipe, or one a pack installed (`pack_slug`). */
  consumer_kind: 'local_recipe' | 'pack_install';
  pack_slug?: string;
  /** Whether its own switch is on (a Kitchen recipe's, in Kitchen). */
  armed: boolean;
  /** `open`: its deliveries run. `missing`: no door was made (why, when the
   * server can tell: `door_reason`). `closed`: its door is gone or was closed;
   * switching the webhook on makes another. */
  door: 'open' | 'missing' | 'closed';
  /** Why the door cannot be made now, in plain words. D-201 Slice 10AX (10AS
   *  finding 10) — also with `door: 'closed'` and {@link no_door}: why there is
   *  no door behind a recipe whose owner closed it. D-201 Slice 10BE (10AY
   *  finding 16) — for any door not open: a closed one that still stands
   *  too, since opening it makes a door. */
  door_reason?: string;
  /** `no_account`: a setting names no account yet; `refused`: the recipe
   * cannot have a door as it stands; `fault`: it could not be checked. */
  door_reason_code?: 'no_account' | 'refused' | 'fault';
  /** D-201 Slice 10AF — with `door: 'closed'`, its owner closed it: on this
   *  card, or answering a pack update's switch. A webhook that starts several
   *  recipes leaves it closed when switched on; only its own switch opens it. */
  closed_by_owner?: true;
  /** D-201 Slice 10AO (10AM finding 15) — with `closed_by_owner`, its rows
   *  carry no door yet: its owner closed it before a door was made (an
   *  answer, or their switch, kept while a door step did not finish), so what
   *  is sent to it is kept as having no door (`door_missing`). A server before
   *  10AO never sets it, and a card then words it as a closed door.
   *  D-201 Slice 10AX (10AS finding 10) — only then: 10AO set it for a door its
   *  owner closed after it was made, its rows door-less since, too. */
  no_door_yet?: true;
  /** D-201 Slice 10AX (10AS finding 10) — with `closed_by_owner`, its rows
   *  carry no door now, whenever its owner closed it: what is sent to it is
   *  kept as having none (`door_missing`), and {@link door_reason} says why,
   *  when the server can tell. {@link no_door_yet} says the closing came
   *  before any door was made. A server before 10AX never sets it. */
  no_door?: true;
}

/** Server-projected profile availability for owner Settings. Portable profile
 * presence alone cannot prove that its verifier or registration driver is
 * composed in this server process. */
export interface WebhookProfileRuntimeCapabilityView {
  profile_id: WebhookProfileId;
  registration_modes: readonly WebhookRegistrationMode[];
  deduplication: WebhookDeduplicationPolicy;
  /** D-201 Slice 10C — the event catalog this server admits, grammar included,
   * so Settings checks a typed event name against the server's language rather
   * than its own copy. Absent from a server older than 10C, which Settings
   * then offers no typed names for. */
  event_types?: WebhookEventTypeCatalog;
}

export interface WebhookIngressListResponse {
  ingresses: WebhookIngressView[];
  profiles: WebhookProfileRuntimeCapabilityView[];
  /** D-201 Slice 10B — the server's unresolved dead letters against its limit. */
  dead_letter_review?: WebhookDeadLetterReviewSummary;
}

export interface WebhookIngressCreateRequest {
  display_name: string;
  profile_id: WebhookProfileId;
  environment: WebhookEnvironment;
  paired_connection_id?: string | null;
  registration_target?: WebhookRegistrationTarget | null;
  registration_mode: WebhookRegistrationMode;
  selected_event_types: readonly string[];
}

export interface WebhookIngressUpdateRequest {
  ingress_id: string;
  patch: {
    display_name?: string;
    profile_id?: WebhookProfileId;
    environment?: WebhookEnvironment;
    paired_connection_id?: string | null;
    registration_target?: WebhookRegistrationTarget | null;
    registration_mode?: WebhookRegistrationMode;
    selected_event_types?: readonly string[];
  };
}

export interface WebhookIngressCredentialWriteRequest {
  ingress_id: string;
  /** Complete credential version. Partial versions are rejected so rotation
   * cannot silently drop one required field. Recued-generated fields must be
   * omitted; trusted core creates them and may return them once below. */
  credentials: Readonly<Record<string, string>>;
}

export interface WebhookIngressCredentialWriteResponse {
  ingress: WebhookIngressView;
  credential_version: WebhookCredentialVersionView;
  /** Present only for fields whose trusted profile source is
   * `recued_generated`. This is the one save response in which the plaintext is
   * readable so an owner can copy it into a manual vendor dashboard. List/get
   * projections can never carry this property. */
  one_time_generated_credentials?: Readonly<Record<string, string>>;
}

export interface WebhookIngressCredentialRetireRequest {
  ingress_id: string;
  credential_version: string;
}

export interface WebhookIngressManualConfirmRequest {
  ingress_id: string;
}

/** Owner-triggered reconciliation of one bounded managed-endpoint adapter.
 * The wire carries only the ingress identity: trusted core derives the paired
 * connection, canonical callback URL, event selection, correlation metadata,
 * and provider idempotency key. */
export interface WebhookIngressRegistrationReconcileRequest {
  ingress_id: string;
  /** Optional owner-selected replacement for a managed endpoint's paired
   * connection. Core validates the target and owns the old-endpoint cutover;
   * no provider URL, id, credential, or request template is accepted. */
  paired_connection_id?: string;
}

export interface WebhookIngressEnableRequest {
  ingress_id: string;
}

/** D-201 Slice 10AF (10AE finding 17; the owner's ruling of 2026-11-20) — a
 *  recipe a pack update brings from another publisher (an owner who edits a
 *  pack publishes it under their own name), with the state its webhook door
 *  was left in: `packs.install_preview` raises its switch, as Kitchen's save
 *  asks before keeping a webhook on. */
export interface PackWebhookPublisherChange {
  pack_slug: string;
  recipe_id: string;
  /** Its name, when it has one. */
  name?: string;
  /** The publisher its door was made under. */
  from_publisher: string;
  /** The state its owner left the door in: `closed` when its owner closed it. */
  door: 'open' | 'closed';
}

/** D-201 Slice 10AF — the owner's answer to a `PackWebhookPublisherChange`
 *  (`packs.install` `webhook_door_choices`). Without one, the door keeps the
 *  state it was left in. */
export interface PackWebhookDoorChoice {
  pack_slug: string;
  recipe_id: string;
  door: 'open' | 'closed';
}

/** D-201 Slice 10AF (the owner's rulings of 2026-11-20) — open or close the
 *  door of one recipe this webhook starts, beside the webhook's own switch:
 *  for a webhook that starts several recipes, each has its own. A closed door
 *  keeps what arrives for its recipe as dead letters. Advertised by
 *  `WebhookIngressView.recipe_door_switch`. */
export interface WebhookIngressDoorSetRequest {
  ingress_id: string;
  recipe_id: string;
  open: boolean;
}

/** D-201 Slice 10AL (10AI finding 21) — the owner removed, at the webhook's
 *  service, the endpoints Recued stopped trying to remove
 *  (`WebhookIngressView.stray_endpoints_given_up`): their record goes. */
export interface WebhookIngressStraysDismissRequest {
  ingress_id: string;
}

export interface WebhookIngressDisableRequest {
  ingress_id: string;
}

export interface WebhookIngressTestDeliveryRequest {
  ingress_id: string;
}

export interface WebhookIngressTestDeliveryResponse {
  ingress: WebhookIngressView;
  delivery_id: string;
  observed_at: number;
}

export interface WebhookIngressRetireRequest {
  ingress_id: string;
}

/** `dead_letters_closed` (D-201 Slice 10F): the dead letters retiring it
 * closed. Absent from a server older than 10F. */
export interface WebhookIngressRetireResponse {
  ingress: WebhookIngressView;
  dead_letters_closed?: number;
}

/** Stable owner cursor over `(received_at DESC, delivery_id ASC)`. Both fields
 * are required so multiple deliveries accepted in one millisecond paginate
 * without gaps or duplicates. */
export interface WebhookDeliveryListCursor {
  received_at: number;
  delivery_id: string;
}

export interface WebhookDeliveryListRequest {
  ingress_id: string;
  limit?: number;
  cursor?: WebhookDeliveryListCursor;
}

export interface WebhookDeliveryGetRequest {
  ingress_id: string;
  delivery_id: string;
}

export interface WebhookDeliveryEventGetRequest {
  ingress_id: string;
  delivery_id: string;
  event_id: string;
}

/** Stable cursor over immutable rejection buckets. Bucket aggregation bounds
 * high-volume repeats without making pagination depend on mutable last-seen. */
export interface WebhookRejectedDeliveryListCursor {
  bucket_started_at: number;
  rejection_id: string;
}

export interface WebhookRejectedDeliveryListRequest {
  ingress_id: string;
  limit?: number;
  cursor?: WebhookRejectedDeliveryListCursor;
}

/** Content-free owner summary. Rejected bodies, hashes, paths, headers,
 * signatures, credentials, response bodies, and raw network identifiers have
 * no representation in this contract. */
export interface WebhookRejectedDeliverySummaryView {
  rejection_id: string;
  ingress_id: string;
  profile_id: WebhookProfileId;
  environment: WebhookEnvironment;
  reason_code: WebhookRejectedDeliveryReasonCode;
  http_status: number;
  bucket_started_at: number;
  first_recorded_at: number;
  last_recorded_at: number;
  /** Durable lower bound; high-volume repeats checkpoint at powers of two. */
  recorded_attempt_count: number;
  metadata_prune_eligible_at: number;
}

export interface WebhookRejectedDeliveryListResponse {
  rejections: readonly WebhookRejectedDeliverySummaryView[];
  next_cursor: WebhookRejectedDeliveryListCursor | null;
}

/** Owner-triggered housekeeping for one ingress. The caller cannot provide a
 * timestamp or shorten a retention window: core prunes only rows that are
 * already eligible under server-owned clocks and retention thresholds. */
export interface WebhookDeliveryRetentionPruneRequest {
  ingress_id: string;
}

export interface WebhookDeliveryRetentionPruneResult {
  payloads_deleted: number;
  outbox_rows_deleted: number;
  events_deleted: number;
  deliveries_deleted: number;
  rejected_summaries_deleted: number;
}

export interface WebhookDeliveryRetentionPruneResponse {
  result: WebhookDeliveryRetentionPruneResult;
}

/** D-201 Slice 10B — what kind of dead letter: an event whose handoff to its
 * recipes spent its attempts (`event`), or one recipe's run of an event that
 * spent its attempts (`target`). */
export type WebhookDeadLetterKind = 'event' | 'target';

export interface WebhookDeadLetterRef {
  kind: WebhookDeadLetterKind;
  /** The event's outbox id, or the target's dispatch id. */
  dead_letter_id: string;
}

/** D-201 Slice 10F — who closed a dead letter, when and why. */
export interface WebhookDeadLetterClosure {
  closed_at: number;
  /** `owner`: the owner closed it, `reason` in their words. `server`: Recued
   * did, `reason` a `WebhookDeadLetterServerReason`. */
  closed_by: 'owner' | 'server';
  reason: string | null;
}

/** One dead letter for the owner's review. Identifiers, status and error codes
 * only: the payload stays behind `webhook.delivery.event.get`. */
export interface WebhookDeadLetterView extends WebhookDeadLetterRef {
  ingress_id: string;
  delivery_id: string;
  event_id: string;
  provider_event_type: string;
  received_at: number;
  /** The recipe a `target` dead letter runs; null for an `event` one. */
  recipe_id: string | null;
  attempt_count: number;
  last_error_code: string | null;
  /** When it became a dead letter (for a closed one, when it was closed). An
   * action names it, and is refused (`stale`) if the dead letter changed since. */
  dead_lettered_at: number;
  payload_retained: boolean;
  /** Slice 10F — set on a closed one (`closed: true` lists only). */
  closure?: WebhookDeadLetterClosure;
  /** D-201 Slice 10W — on an `approved_run_in_doubt` target held for its try
   * again: the step in doubt, which the try again goes on from and the only
   * one that can run twice. `asks_again`: it is the approved step, which asks
   * the owner again. `progress_unknown`: the server stopped without warning, so
   * how far the run got past it is unknown, and the steps after it run again
   * too. Absent from a server before 10W, and on one not held (its try again
   * runs the recipe from its first step).
   *
   * D-201 Slice 10AB — `failed` (10AA finding 2): the owner's try again failed
   * at this step rather than being stopped, and the next one goes on from it.
   * `recipe_changed` (10AA finding 4): the recipe changed since, so what the run
   * kept cannot stand in for this version's steps, and the try again runs the
   * recipe from its first step; `step_id` is then the approved step. Absent
   * from a server before 10AB.
   *
   * D-201 Slice 10AG (10AE finding 11) — since 10AG only the states a Settings
   * from 10W words right are sent here: a step a restart caught, asked for
   * again or not, and the approved step with how far the run got unknown. The
   * others (`failed`, `recipe_changed`, and a try again the process went
   * during) are in `held_try_again` alone, so an older Settings says the try
   * again runs the recipe from its first step, never "only that step can run
   * twice" of a step that failed, nor that it asks again. */
  step_in_doubt?: {
    step_id: string;
    asks_again?: true;
    progress_unknown?: true;
    failed?: true;
    recipe_changed?: true;
  };
  /** D-201 Slice 10AG (10AE finding 11) — every held state, as
   *  `step_in_doubt` was (its fields mean the same). A Settings since 10AG
   *  reads it first. Absent from an older server, and on one not held.
   *
   *  D-201 Slice 10BC (10AY findings 2 and 9) — `later_run_again`: the run went
   *  past `step_id` and Recued could not keep what ran after it, so the try
   *  again runs again each step after it that went through, not that step
   *  alone. Held at an approved step it cannot keep (a loop resumed past its
   *  first item, a chunked upload, a resume bound to an egress budget or a
   *  resource review, a hand-off its receipt cannot prove; a loop that finished
   *  is kept since 10BH), or a row a later write could not replace. Only here,
   *  never in `step_in_doubt`. Absent from a server before 10BC.
   *
   *  D-201 Slice 10BI (10BF finding 7) — what an older Settings says of it, as
   *  10BC said it wrongly: a Settings from 10AG up to 10BE reads this field
   *  first, does not know `later_run_again`, and says only that step can run
   *  twice; one before 10AG reads `step_in_doubt` alone, not sent here, and says
   *  the try again runs the recipe from its first step. No released webclient
   *  carries a build from 10AG up to 10BE. D-201 Slice 10BP (10BM finding 12) —
   *  it said "from 10AG to 10BB": 10BC landed before 10BA and 10BB, whose
   *  Settings know `later_run_again`.
   *
   *  D-201 Slice 10BI (10BF finding 5) — `handoff_unproven`: held at the
   *  approved step `step_id`, which returned having handed its work on, with
   *  no hand-off its receipt can check. What the run did is kept; only that
   *  hand-off is unproven, so the try again asks for the step again (and, with
   *  `later_run_again`, runs again the steps after it that went through).
   *  Absent from a server before 10BI. A Settings before 10BI ignores it: with
   *  `later_run_again` it words such a run as one whose progress Recued could
   *  not keep, and without it, held at the step that handed its work on with
   *  nothing after it run, as one in doubt whose try again asks for that step
   *  again, so that only it can run twice (D-201 Slice 10BP, 10BM finding 12:
   *  this said only the first). */
  held_try_again?: {
    step_id: string;
    asks_again?: true;
    progress_unknown?: true;
    failed?: true;
    recipe_changed?: true;
    later_run_again?: true;
    handoff_unproven?: true;
  };
}

/** Newest first: by `dead_lettered_at`, then `event` before `target`, then id. */
export interface WebhookDeadLetterListCursor {
  dead_lettered_at: number;
  kind: WebhookDeadLetterKind;
  dead_letter_id: string;
}

export interface WebhookDeadLetterListRequest {
  ingress_id: string;
  limit?: number;
  cursor?: WebhookDeadLetterListCursor;
  /** D-201 Slice 10F — list the closed ones instead, newest closed first. They
   * last as long as their event (its retention). */
  closed?: boolean;
}

/** How many unresolved dead letters the server holds, against its limit. */
export interface WebhookDeadLetterReviewSummary {
  unresolved: number;
  limit: number;
}

export interface WebhookDeadLetterListResponse {
  dead_letters: readonly WebhookDeadLetterView[];
  next_cursor: WebhookDeadLetterListCursor | null;
  review: WebhookDeadLetterReviewSummary;
}

/** Try a dead letter again (`webhook.delivery.dead_letter.requeue`) or close it
 * (`webhook.delivery.dead_letter.resolve`). A reason is kept with the decision:
 * optional to try again, required to close. */
export interface WebhookDeadLetterActionRequest {
  ingress_id: string;
  dead_letter: WebhookDeadLetterRef;
  dead_lettered_at: number;
  reason?: string;
}

export interface WebhookDeadLetterActionResponse {
  dead_letter: WebhookDeadLetterRef;
  outcome: 'requeued' | 'resolved';
  review_id: string;
  acted_at: number;
}

/** Secret-free accepted-request summary for the owner control plane. Internal
 * dedup keys, payload refs, response bodies, and credential values are omitted. */
export interface WebhookDeliverySummaryView {
  delivery_id: string;
  ingress_id: string;
  profile_id: WebhookProfileId;
  environment: WebhookEnvironment;
  received_at: number;
  raw_body_sha256: string;
  raw_body_retained: boolean;
  decoded_content_type: string;
  decoded_schema_id: string;
  transport_assurance: WebhookTransportAssurance;
  minimum_source_truth_policy: WebhookSourceTruthPolicy;
  credential_version: string | null;
  admission_method: string;
  freshness_checked: boolean;
  event_count: number;
  /** Delivery/dedup metadata prune threshold. Referenced rows may live longer. */
  metadata_expires_at: number;
}

interface WebhookDeliveryEventSummaryBaseView {
  event_id: string;
  delivery_id: string;
  ingress_id: string;
  event_index: number;
  provider_event_id: string | null;
  provider_resource_id: string | null;
  provider_event_type: string;
  /** Provider occurrence time normalized to Unix epoch milliseconds. */
  provider_occurred_at: number | null;
  selected_for_dispatch: boolean;
  /** `resolved` (Slice 10B): a dead letter the owner, or the review limit,
   * closed. */
  dispatch_state: AcceptedWebhookEventRecord['dispatch_state'] | 'resolved';
  /** Event/dedup metadata prune threshold. Referenced rows may live longer. */
  metadata_expires_at: number;
}

/** Physical payload presence and its expiry metadata are one discriminated
 * state: a retained row always has an expiry, while a pruned row has neither. */
export type WebhookDeliveryEventSummaryView = WebhookDeliveryEventSummaryBaseView & (
  | {
      payload_retained: true;
      /** Payload prune threshold. Active work/pins may extend physical retention. */
      payload_expires_at: number;
    }
  | {
      payload_retained: false;
      payload_expires_at: null;
    }
);

export interface WebhookDeliveryDetailView {
  delivery: WebhookDeliverySummaryView;
  events: readonly WebhookDeliveryEventSummaryView[];
}

export interface WebhookDeliveryListResponse {
  deliveries: readonly WebhookDeliverySummaryView[];
  next_cursor: WebhookDeliveryListCursor | null;
}

/** `payload_retained` is the discriminator so a retained JSON `null` is never
 * confused with a payload that retention already removed. */
export type WebhookDeliveryEventPayloadView =
  | {
      event: Extract<WebhookDeliveryEventSummaryView, { payload_retained: false }>;
      payload_retained: false;
    }
  | {
      event: Extract<WebhookDeliveryEventSummaryView, { payload_retained: true }>;
      payload_retained: true;
      payload: unknown;
    };

export interface WebhookConsumerBindingRecord {
  binding_id: string;
  consumer_kind: 'pack_install' | 'local_recipe';
  consumer_id: string;
  logical_binding: string;
  ingress_id: string;
  required_profile_id: WebhookProfileId;
  decoded_payload_access: WebhookDecodedPayloadAccess;
  source_truth_policy: WebhookSourceTruthPolicy;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

/** Owner-supplied logical binding choice. The recipe/pack declaration owns the
 * logical name; the owner control plane supplies only an opaque ingress id. */
export interface WebhookIngressBindingSelection {
  binding: string;
  ingress_id: string;
}

/** D-209 #1 — the state of one webhook recipe's DOOR CONTRACT (the derived
 * `contract.anonymous` definition its dispatches run under; minted at save /
 * pack install, stamped on the recipe's trigger rows).
 *
 * `missing` is a live fail-closed state, not an error: a dispatch whose
 * trigger carries no contract floors to `PUBLIC_CONTRACT_ID` and denies.
 * The owner's remedy is always the same — re-save the recipe. */
export interface LocalRecipeWebhookDoorStatus {
  /** D-201 Slice 10AC (10AA finding 9) — `closed`: it has a door, closed
   *  (revoked), which switching the recipe on opens again, as the webhook's
   *  card does. A server before 10AC reports it `missing`. D-201 Slice 10AF
   *  (10AE finding 16) — a server since 10AF sends a closed door as `missing`
   *  with {@link closed}, which a Kitchen before 10AC reads as letting nothing
   *  through, as it does; it read an unknown `closed` as an open door. */
  state: 'minted' | 'missing' | 'refused' | 'closed';
  /** D-201 Slice 10AF (10AE finding 16) — with `state: 'missing'`, the door
   *  is there and closed (revoked), not missing. D-201 Slice 10AX (10AS
   *  finding 13) — or, with {@link no_door}, its owner closed it and there is
   *  none: it reads as closed to a Kitchen before 10AX, which it is. */
  closed?: true;
  /** D-201 Slice 10AX (10AS finding 13) — its owner closed the door, as the
   *  webhook's card says (`WebhookIngressRecipeView.closed_by_owner`): with a
   *  closed door, or with `state: 'refused'`, a version that cannot have one
   *  under its owner's closing. Kitchen said "refused" alone where the card said
   *  "you closed it", and "the door is closed" where the card said there was
   *  none. The three fields here are the card's own. */
  closed_by_owner?: true;
  /** D-201 Slice 10AX (10AS finding 13) — with {@link closed_by_owner}, its
   *  rows carry no door now (`WebhookIngressRecipeView.no_door`). */
  no_door?: true;
  /** D-201 Slice 10AX (10AS finding 13) — with {@link no_door}, its owner
   *  closed it before any door was made (`WebhookIngressRecipeView.no_door_yet`). */
  no_door_yet?: true;
  /** Present when `state === 'minted'`. */
  contract_id?: string;
  /** The door's granted op closure — the "this webhook may: …" consent list.
   * Present when `state === 'minted'`. */
  operation_ids?: string[];
  /** Present on the SAVE that (re)minted the door: the capability diff
   * against the prior door. Both empty ⇒ the authority did not change.
   * D-201 Slice 10Y (10V finding 20) — an operation in `switched_off` is not
   * listed as added: it stays off, so the save did not change that. */
  added?: string[];
  removed?: string[];
  /** D-201 Slice 10S (10Q finding 12) — what the owner switched off on this
   * door under Contracts: in `operation_ids`, yet it never runs. A save that
   * switches the webhook off keeps an unchanged door, switch-offs and all, so
   * switching it on must not list them as let through. D-201 Slice 10Y (10V
   * finding 20) — only the door's own: a switch-off carried onto a door
   * without that operation (kept should a later version take it back) is not
   * listed. */
  switched_off?: string[];
  /** Present when `state === 'refused'` — why this recipe cannot back a
   * door (dynamic dispatch / unresolvable connection). */
  refusal?: { reason: string; step_id: string; detail: string };
}

/** D-201 Slice 10I — what saving a draft would let its webhook do, asked before
 * the save so the owner answers "keep its webhook on?" knowing. */
export interface LocalRecipeWebhookDoorPreview {
  /** `derivable`: the door this version would get; `refused`: it cannot have
   *  one, or (Slice 10M) a save cannot keep its webhook on. */
  state: 'derivable' | 'refused';
  /** Present when `derivable`. */
  operation_ids?: string[];
  /** Against the saved version's door now, all of them when it has none, as
   *  the mint names them (D-201 Slice 10M): an operation id,
   *  `ingredient:<id>` or `connection:<name>`. */
  added?: string[];
  removed?: string[];
  /** D-201 Slice 10M — each slot whose messages this version may use more of,
   *  as `<slot>:<policy>`: `scoped_read` (it reads them) or
   *  `delivery_payload_allowed` (it trusts them unchecked). */
  widened?: string[];
  /** D-201 Slice 10M — what the owner switched off on the door. A save that
   *  keeps the webhook on keeps them off. D-201 Slice 10Y (10V finding 20) —
   *  only the operations this version's door has. */
  kept_off?: string[];
  /** D-201 Slice 10M — what keeping it on does with the messages that did not
   *  reach it and the ones waiting: `kept` for this version, `closed` (the
   *  setup changes), or `none` (none can be waiting). `closed` when any trigger
   *  closes: see `history_triggers` for which. */
  history?: 'kept' | 'closed' | 'none';
  /** D-201 Slice 10Y (10V finding 6) — per trigger on now (its slot and
   *  event): whether its history stays with this version or closes. A keep-on
   *  save keeps every one that continues. Absent from a server before 10Y. */
  history_triggers?: Array<{ slot: string; event_type: string; history: 'kept' | 'closed' }>;
  /** D-201 Slice 10M — whether its webhook is on now. D-201 Slice 10Y (10V
   *  finding 21) — on a refusal too. */
  armed?: boolean;
  /** D-201 Slice 10M — what this answer covers, opaque. `recipe.save` takes it
   *  back as `webhook_consent` and refuses when it no longer matches. */
  consent?: string;
  /** Present when `refused`. */
  refusal?: { reason: string; step_id: string; detail: string };
}

/** Secret-free Kitchen projection for one standalone recipe's webhook
 * authority. A save leaves it off unless the owner answered the save's
 * question by keeping it on (`recipe.save` `webhook_on`, D-201 Slice 10I). */
export interface LocalRecipeWebhookStatus {
  declared: boolean;
  configured: boolean;
  armed: boolean;
  bindings: ReadonlyArray<WebhookIngressBindingSelection>;
  /** D-209 #1 — present only when the recipe declares webhook triggers AND
   * the door substrate is wired (absent on partial harnesses). */
  door?: LocalRecipeWebhookDoorStatus;
}

export interface AcceptedWebhookDeliveryRecord {
  delivery_id: string;
  ingress_id: string;
  profile_id: WebhookProfileId;
  environment: WebhookEnvironment;
  received_at: number;
  delivery_dedup_key: string;
  raw_body_sha256: string;
  raw_body_ref: string | null;
  decoded_content_type: string;
  decoded_schema_id: string;
  transport_assurance: WebhookTransportAssurance;
  minimum_source_truth_policy: WebhookSourceTruthPolicy;
  credential_version: string | null;
  admission_method: string;
  freshness_checked: boolean;
  event_count: number;
  expires_at: number;
}

export interface AcceptedWebhookEventRecord {
  event_id: string;
  delivery_id: string;
  ingress_id: string;
  event_index: number;
  event_dedup_key: string;
  provider_event_id: string | null;
  provider_resource_id: string | null;
  provider_event_type: string;
  /** Provider occurrence time normalized to Unix epoch milliseconds. */
  provider_occurred_at: number | null;
  decoded_payload_ref: string;
  selected_for_dispatch: boolean;
  dispatch_state: 'ignored' | 'pending' | 'dispatched' | 'dead_letter';
  expires_at: number;
}

export interface WebhookTriggerContext {
  kind: 'webhook';
  binding: string;
  event_ref: string;
  delivery_ref: string;
  event_id: string;
  ingress_id: string;
  profile_id: WebhookProfileId;
  transport_assurance: WebhookTransportAssurance;
  source_truth_policy: WebhookSourceTruthPolicy;
  provider_event_id: string | null;
  provider_resource_id: string | null;
  provider_event_type: string;
  /** Provider occurrence time normalized to Unix epoch milliseconds. */
  provider_occurred_at: number | null;
  received_at: number;
  duplicate: false;
}
