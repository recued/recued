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
  'generic.static-header-token.v1',
  'generic.raw-body-hmac-sha256.v1',
  'generic.timestamped-raw-body-hmac-sha256.v1',
  'generic.http-basic.v1',
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

export type WebhookEventTypeCatalog =
  | { kind: 'closed'; values: readonly string[] }
  | { kind: 'open'; known_values: readonly string[] };

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
  /** Optional profile-specific handshake labels understood by trusted core. */
  handshakes: readonly string[];
}

/** One profile-owned predicate for every control-plane and lifecycle caller.
 * Vendor names never decide whether deletion of an API connection must close
 * an ingress; the selected registration mechanism plus descriptor capability
 * do. */
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
    event_types: { kind: 'open', known_values: ['event_callback'] },
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
] as const satisfies readonly WebhookProfileDescriptor[];

const freezeProfileDescriptor = (
  profile: WebhookProfileDescriptor,
): WebhookProfileDescriptor => Object.freeze({
  ...profile,
  event_types: profile.event_types.kind === 'closed'
    ? Object.freeze({ kind: 'closed' as const, values: Object.freeze([...profile.event_types.values]) })
    : Object.freeze({ kind: 'open' as const, known_values: Object.freeze([...profile.event_types.known_values]) }),
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
    const seenEvents = new Set<string>();
    for (const eventType of eventTypes) {
      if (!WEBHOOK_EVENT_TYPE_RE.test(eventType)) issues.push(`${at}: invalid event type '${eventType}'`);
      if (seenEvents.has(eventType)) issues.push(`${at}: duplicate event type '${eventType}'`);
      seenEvents.add(eventType);
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

export const webhookProfileAcceptsEventType = (
  profile: WebhookProfileDescriptor,
  eventType: unknown,
): eventType is string => {
  if (typeof eventType !== 'string' || !WEBHOOK_EVENT_TYPE_RE.test(eventType)) return false;
  return profile.event_types.kind === 'open'
    || profile.event_types.values.includes(eventType);
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
  enabled_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Server-projected profile availability for owner Settings. Portable profile
 * presence alone cannot prove that its verifier or registration driver is
 * composed in this server process. */
export interface WebhookProfileRuntimeCapabilityView {
  profile_id: WebhookProfileId;
  registration_modes: readonly WebhookRegistrationMode[];
  deduplication: WebhookDeduplicationPolicy;
}

export interface WebhookIngressListResponse {
  ingresses: WebhookIngressView[];
  profiles: WebhookProfileRuntimeCapabilityView[];
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
  dispatch_state: AcceptedWebhookEventRecord['dispatch_state'];
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
  state: 'minted' | 'missing' | 'refused';
  /** Present when `state === 'minted'`. */
  contract_id?: string;
  /** The door's granted op closure — the "this webhook may: …" consent list.
   * Present when `state === 'minted'`. */
  operation_ids?: string[];
  /** Present on the SAVE that (re)minted the door: the capability diff
   * against the prior door. Both empty ⇒ the authority did not change. */
  added?: string[];
  removed?: string[];
  /** Present when `state === 'refused'` — why this recipe cannot back a
   * door (dynamic dispatch / unresolvable connection). */
  refusal?: { reason: string; step_id: string; detail: string };
}

/** Secret-free Kitchen projection for one standalone recipe's webhook
 * authority. A configured save is deliberately disarmed until a separate
 * owner action succeeds. */
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
