/** D-201 Slices 9I-9K + 9P-9R + 9AN-9AW — trusted parser presets shared across webhook lifecycles.
 *
 * Delivery and registration composition select the same serializable profile
 * data here without importing one another's engine/adapter registries.
 */

import {
  webhookProfile,
  type WebhookProfileId,
} from '@recued/contracts';
import {
  createWebhookCanonicalUuidParser,
  type WebhookCanonicalUuidParserPreset,
} from './webhook-canonical-uuid-parser.js';
import {
  createWebhookAsciiIdentifierParser,
  type WebhookAsciiIdentifierParserPreset,
} from './webhook-ascii-identifier-parser.js';
import {
  createWebhookAsciiEventTypeParser,
  type WebhookAsciiEventTypeParserPreset,
} from './webhook-ascii-event-type-parser.js';
import {
  createWebhookBoundedPrefixProviderIdParser,
  type WebhookBoundedPrefixProviderIdParserPreset,
} from './webhook-bounded-prefix-provider-id-parser.js';
import {
  createWebhookBoundedAsciiTokenParser,
  type WebhookBoundedAsciiTokenParserPreset,
} from './webhook-bounded-ascii-token-parser.js';
import {
  createWebhookDotSegmentEventTypeParser,
  type WebhookDotSegmentEventTypeParserPreset,
} from './webhook-dot-segment-event-type-parser.js';
import {
  createWebhookFixedPrefixProviderIdParser,
  type WebhookFixedPrefixProviderIdParserPreset,
} from './webhook-fixed-prefix-provider-id-parser.js';
import {
  createWebhookFixedLengthAsciiTokenParser,
  type WebhookFixedLengthAsciiTokenParserPreset,
} from './webhook-fixed-length-ascii-token-parser.js';
import {
  createWebhookJsonObjectProviderIdExtractor,
  type WebhookJsonObjectProviderIdExtractorPreset,
} from './webhook-json-object-provider-id-extractor.js';
import {
  createWebhookJsonRequiredObjectExtractor,
  type WebhookJsonRequiredObjectExtractorPreset,
} from './webhook-json-required-object-extractor.js';
import {
  createWebhookLowercaseIdentifierEventTypeParser,
  type WebhookLowercaseIdentifierEventTypeParserPreset,
} from './webhook-lowercase-identifier-event-type-parser.js';
import {
  createWebhookPositiveDecimalIdentifierParser,
  type WebhookPositiveDecimalIdentifierParserPreset,
} from './webhook-positive-decimal-identifier-parser.js';
import {
  createWebhookPrefixedPositiveDecimalIdCodec,
  type WebhookPrefixedPositiveDecimalIdCodecPreset,
} from './webhook-prefixed-positive-decimal-id-codec.js';
import {
  createWebhookPrefixedAsciiTokenParser,
  type WebhookPrefixedAsciiTokenParserPreset,
} from './webhook-prefixed-ascii-token-parser.js';
import {
  createWebhookSegmentedAsciiTokenParser,
  type WebhookSegmentedAsciiTokenParserPreset,
} from './webhook-segmented-ascii-token-parser.js';

export interface WebhookCanonicalUuidProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly parser: WebhookCanonicalUuidParserPreset;
}

const canonicalUuidPreset = (
  profile_id: WebhookProfileId,
  parserInput: WebhookCanonicalUuidParserPreset,
): WebhookCanonicalUuidProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  if (descriptor?.decoder_kind !== 'json'
    || descriptor.max_events_per_delivery !== 1) {
    throw new Error(
      `webhook canonical UUID preset '${profile_id}' requires a single-event JSON profile`,
    );
  }
  const value = Object.freeze({
    profile_id,
    parser: createWebhookCanonicalUuidParser(parserInput).preset,
  });
  JSON.stringify(value);
  return value;
};

const CANONICAL_UUID_PRESET_LIST = [
  canonicalUuidPreset('github.webhook.v1', {
    kind: 'canonical_uuid_hex.v1',
  }),
] as const;

const mutableCanonicalUuidPresets = Object.create(null) as Record<
  WebhookProfileId,
  WebhookCanonicalUuidProfilePreset | undefined
>;
for (const value of CANONICAL_UUID_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(
    mutableCanonicalUuidPresets,
    value.profile_id,
  )) {
    throw new Error(
      `duplicate webhook canonical UUID preset '${value.profile_id}'`,
    );
  }
  mutableCanonicalUuidPresets[value.profile_id] = value;
}

export const WEBHOOK_CANONICAL_UUID_PROFILE_PRESETS: Readonly<
  Partial<Record<WebhookProfileId, WebhookCanonicalUuidProfilePreset>>
> = Object.freeze(mutableCanonicalUuidPresets);

export const webhookCanonicalUuidProfilePreset = (
  profileId: WebhookProfileId,
): WebhookCanonicalUuidProfilePreset | null =>
  WEBHOOK_CANONICAL_UUID_PROFILE_PRESETS[profileId] ?? null;

const hasRequiredVendorGeneratedSecretField = (
  profileId: WebhookProfileId,
  credentialField: string,
): boolean => {
  const descriptor = webhookProfile(profileId);
  const field = descriptor?.fields.find(
    (candidate) => candidate.key === credentialField,
  );
  return field !== undefined
    && field.kind === 'secret'
    && field.required
    && field.source === 'vendor_generated';
};

const hasRequiredRecuedGeneratedSecretField = (
  profileId: WebhookProfileId,
  credentialField: string,
): boolean => {
  const descriptor = webhookProfile(profileId);
  const field = descriptor?.fields.find(
    (candidate) => candidate.key === credentialField,
  );
  return field !== undefined
    && field.kind === 'secret'
    && field.required
    && field.source === 'recued_generated';
};

export interface WebhookFixedLengthAsciiCredentialProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly credential_field: string;
  readonly parser: WebhookFixedLengthAsciiTokenParserPreset;
}

const fixedLengthAsciiCredentialPreset = (
  profile_id: WebhookProfileId,
  credential_field: string,
  parserInput: WebhookFixedLengthAsciiTokenParserPreset,
): WebhookFixedLengthAsciiCredentialProfilePreset => {
  if (!hasRequiredRecuedGeneratedSecretField(profile_id, credential_field)) {
    throw new Error(
      `webhook fixed-length ASCII credential preset '${profile_id}' requires a Recued-generated secret field`,
    );
  }
  const value = Object.freeze({
    profile_id,
    credential_field,
    parser: createWebhookFixedLengthAsciiTokenParser(parserInput).preset,
  });
  JSON.stringify(value);
  return value;
};

const FIXED_LENGTH_ASCII_CREDENTIAL_PRESET_LIST = [
  fixedLengthAsciiCredentialPreset(
    'github.webhook.v1',
    'webhook_secret',
    {
      kind: 'fixed_length_ascii_token.v1',
      characters: 43,
    },
  ),
] as const;

const mutableFixedLengthAsciiCredentialPresets = Object.create(null) as Record<
  WebhookProfileId,
  WebhookFixedLengthAsciiCredentialProfilePreset | undefined
>;
for (const value of FIXED_LENGTH_ASCII_CREDENTIAL_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(
    mutableFixedLengthAsciiCredentialPresets,
    value.profile_id,
  )) {
    throw new Error(
      `duplicate webhook fixed-length ASCII credential preset '${value.profile_id}'`,
    );
  }
  mutableFixedLengthAsciiCredentialPresets[value.profile_id] = value;
}

export const WEBHOOK_FIXED_LENGTH_ASCII_CREDENTIAL_PROFILE_PRESETS: Readonly<
  Partial<Record<
    WebhookProfileId,
    WebhookFixedLengthAsciiCredentialProfilePreset
  >>
> = Object.freeze(mutableFixedLengthAsciiCredentialPresets);

export const webhookFixedLengthAsciiCredentialProfilePreset = (
  profileId: WebhookProfileId,
): WebhookFixedLengthAsciiCredentialProfilePreset | null =>
  WEBHOOK_FIXED_LENGTH_ASCII_CREDENTIAL_PROFILE_PRESETS[profileId] ?? null;

export interface WebhookBoundedAsciiCredentialProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly credential_field: string;
  readonly parser: WebhookBoundedAsciiTokenParserPreset;
}

const boundedAsciiCredentialPreset = (
  profile_id: WebhookProfileId,
  credential_field: string,
  parserInput: WebhookBoundedAsciiTokenParserPreset,
): WebhookBoundedAsciiCredentialProfilePreset => {
  if (!hasRequiredRecuedGeneratedSecretField(profile_id, credential_field)) {
    throw new Error(
      `webhook bounded ASCII credential preset '${profile_id}' requires a Recued-generated secret field`,
    );
  }
  const value = Object.freeze({
    profile_id,
    credential_field,
    parser: createWebhookBoundedAsciiTokenParser(parserInput).preset,
  });
  JSON.stringify(value);
  return value;
};

const BOUNDED_ASCII_CREDENTIAL_PRESET_LIST = [
  boundedAsciiCredentialPreset(
    'telegram.bot-webhook.v1',
    'secret_token',
    {
      kind: 'bounded_ascii_token.v1',
      max_characters: 256,
    },
  ),
] as const;

const mutableBoundedAsciiCredentialPresets = Object.create(null) as Record<
  WebhookProfileId,
  WebhookBoundedAsciiCredentialProfilePreset | undefined
>;
for (const value of BOUNDED_ASCII_CREDENTIAL_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(
    mutableBoundedAsciiCredentialPresets,
    value.profile_id,
  )) {
    throw new Error(
      `duplicate webhook bounded ASCII credential preset '${value.profile_id}'`,
    );
  }
  mutableBoundedAsciiCredentialPresets[value.profile_id] = value;
}

export const WEBHOOK_BOUNDED_ASCII_CREDENTIAL_PROFILE_PRESETS: Readonly<
  Partial<Record<
    WebhookProfileId,
    WebhookBoundedAsciiCredentialProfilePreset
  >>
> = Object.freeze(mutableBoundedAsciiCredentialPresets);

export const webhookBoundedAsciiCredentialProfilePreset = (
  profileId: WebhookProfileId,
): WebhookBoundedAsciiCredentialProfilePreset | null =>
  WEBHOOK_BOUNDED_ASCII_CREDENTIAL_PROFILE_PRESETS[profileId] ?? null;

export interface WebhookPrefixedAsciiCredentialProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly credential_field: string;
  readonly parser: WebhookPrefixedAsciiTokenParserPreset;
}

const prefixedAsciiCredentialPreset = (
  profile_id: WebhookProfileId,
  credential_field: string,
  parserInput: WebhookPrefixedAsciiTokenParserPreset,
): WebhookPrefixedAsciiCredentialProfilePreset => {
  if (!hasRequiredVendorGeneratedSecretField(profile_id, credential_field)) {
    throw new Error(
      `webhook prefixed ASCII credential preset '${profile_id}' requires a vendor-generated secret field`,
    );
  }
  const value = Object.freeze({
    profile_id,
    credential_field,
    parser: createWebhookPrefixedAsciiTokenParser(parserInput).preset,
  });
  JSON.stringify(value);
  return value;
};

const PREFIXED_ASCII_CREDENTIAL_PRESET_LIST = [
  prefixedAsciiCredentialPreset(
    'stripe.event.v1',
    'endpoint_secret',
    {
      kind: 'prefixed_ascii_token.v1',
      prefix: 'whsec_',
      max_bytes: 4_096,
    },
  ),
] as const;

const mutablePrefixedAsciiCredentialPresets = Object.create(null) as Record<
  WebhookProfileId,
  WebhookPrefixedAsciiCredentialProfilePreset | undefined
>;
for (const value of PREFIXED_ASCII_CREDENTIAL_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(
    mutablePrefixedAsciiCredentialPresets,
    value.profile_id,
  )) {
    throw new Error(
      `duplicate webhook prefixed ASCII credential preset '${value.profile_id}'`,
    );
  }
  mutablePrefixedAsciiCredentialPresets[value.profile_id] = value;
}

export const WEBHOOK_PREFIXED_ASCII_CREDENTIAL_PROFILE_PRESETS: Readonly<
  Partial<Record<WebhookProfileId, WebhookPrefixedAsciiCredentialProfilePreset>>
> = Object.freeze(mutablePrefixedAsciiCredentialPresets);

export const webhookPrefixedAsciiCredentialProfilePreset = (
  profileId: WebhookProfileId,
): WebhookPrefixedAsciiCredentialProfilePreset | null =>
  WEBHOOK_PREFIXED_ASCII_CREDENTIAL_PROFILE_PRESETS[profileId] ?? null;

export interface WebhookSegmentedAsciiCredentialProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly credential_field: string;
  readonly parser: WebhookSegmentedAsciiTokenParserPreset;
}

const segmentedAsciiCredentialPreset = (
  profile_id: WebhookProfileId,
  credential_field: string,
  parserInput: WebhookSegmentedAsciiTokenParserPreset,
): WebhookSegmentedAsciiCredentialProfilePreset => {
  if (!hasRequiredVendorGeneratedSecretField(profile_id, credential_field)) {
    throw new Error(
      `webhook segmented ASCII credential preset '${profile_id}' requires a vendor-generated secret field`,
    );
  }
  const value = Object.freeze({
    profile_id,
    credential_field,
    parser: createWebhookSegmentedAsciiTokenParser(parserInput).preset,
  });
  JSON.stringify(value);
  return value;
};

const SEGMENTED_ASCII_CREDENTIAL_PRESET_LIST = [
  segmentedAsciiCredentialPreset(
    'paddle.notification.v1',
    'endpoint_secret_key',
    {
      kind: 'segmented_ascii_token.v1',
      prefix: 'pdl_ntfset_',
      separator: '_',
      segment_lengths: [26, 32],
    },
  ),
] as const;

const mutableSegmentedAsciiCredentialPresets = Object.create(null) as Record<
  WebhookProfileId,
  WebhookSegmentedAsciiCredentialProfilePreset | undefined
>;
for (const value of SEGMENTED_ASCII_CREDENTIAL_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(
    mutableSegmentedAsciiCredentialPresets,
    value.profile_id,
  )) {
    throw new Error(
      `duplicate webhook segmented ASCII credential preset '${value.profile_id}'`,
    );
  }
  mutableSegmentedAsciiCredentialPresets[value.profile_id] = value;
}

export const WEBHOOK_SEGMENTED_ASCII_CREDENTIAL_PROFILE_PRESETS: Readonly<
  Partial<Record<WebhookProfileId, WebhookSegmentedAsciiCredentialProfilePreset>>
> = Object.freeze(mutableSegmentedAsciiCredentialPresets);

export const webhookSegmentedAsciiCredentialProfilePreset = (
  profileId: WebhookProfileId,
): WebhookSegmentedAsciiCredentialProfilePreset | null =>
  WEBHOOK_SEGMENTED_ASCII_CREDENTIAL_PROFILE_PRESETS[profileId] ?? null;

export interface WebhookBoundedPrefixRegistrationRemoteIdProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly parser: WebhookBoundedPrefixProviderIdParserPreset;
}

const boundedPrefixRegistrationRemoteIdPreset = (
  profile_id: WebhookProfileId,
  parserInput: WebhookBoundedPrefixProviderIdParserPreset,
): WebhookBoundedPrefixRegistrationRemoteIdProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  if (descriptor === null
    || !descriptor.registration_modes.includes('managed_endpoint')
    || !descriptor.managed_registration_requires_connection) {
    throw new Error(
      `webhook bounded-prefix registration remote-id preset '${profile_id}' requires connection-bound managed registration`,
    );
  }
  const value = Object.freeze({
    profile_id,
    parser: createWebhookBoundedPrefixProviderIdParser(parserInput).preset,
  });
  JSON.stringify(value);
  return value;
};

const BOUNDED_PREFIX_REGISTRATION_REMOTE_ID_PRESET_LIST = [
  boundedPrefixRegistrationRemoteIdPreset('stripe.event.v1', {
    kind: 'fixed_prefix_ascii_alphanumeric_id.v1',
    prefix: 'we_',
    min_suffix_length: 1,
    max_suffix_length: 252,
  }),
] as const;

const mutableBoundedPrefixRegistrationRemoteIdPresets =
  Object.create(null) as Record<
    WebhookProfileId,
    WebhookBoundedPrefixRegistrationRemoteIdProfilePreset | undefined
  >;
for (const value of BOUNDED_PREFIX_REGISTRATION_REMOTE_ID_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(
    mutableBoundedPrefixRegistrationRemoteIdPresets,
    value.profile_id,
  )) {
    throw new Error(
      `duplicate webhook bounded-prefix registration remote-id preset '${value.profile_id}'`,
    );
  }
  mutableBoundedPrefixRegistrationRemoteIdPresets[value.profile_id] = value;
}

export const WEBHOOK_BOUNDED_PREFIX_REGISTRATION_REMOTE_ID_PROFILE_PRESETS: Readonly<
  Partial<Record<
    WebhookProfileId,
    WebhookBoundedPrefixRegistrationRemoteIdProfilePreset
  >>
> = Object.freeze(mutableBoundedPrefixRegistrationRemoteIdPresets);

export const webhookBoundedPrefixRegistrationRemoteIdProfilePreset = (
  profileId: WebhookProfileId,
): WebhookBoundedPrefixRegistrationRemoteIdProfilePreset | null =>
  WEBHOOK_BOUNDED_PREFIX_REGISTRATION_REMOTE_ID_PROFILE_PRESETS[profileId]
    ?? null;

export interface WebhookPrefixedPositiveDecimalRegistrationRemoteIdProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly codec: WebhookPrefixedPositiveDecimalIdCodecPreset;
}

const prefixedPositiveDecimalRegistrationRemoteIdPreset = (
  profile_id: WebhookProfileId,
  codecInput: WebhookPrefixedPositiveDecimalIdCodecPreset,
): WebhookPrefixedPositiveDecimalRegistrationRemoteIdProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  if (descriptor === null
    || !descriptor.registration_modes.includes('managed_endpoint')
    || !descriptor.managed_registration_requires_connection) {
    throw new Error(
      `webhook prefixed positive-decimal registration remote-id preset '${profile_id}' requires connection-bound managed registration`,
    );
  }
  const value = Object.freeze({
    profile_id,
    codec: createWebhookPrefixedPositiveDecimalIdCodec(codecInput).preset,
  });
  JSON.stringify(value);
  return value;
};

const PREFIXED_POSITIVE_DECIMAL_REGISTRATION_REMOTE_ID_PRESET_LIST = [
  prefixedPositiveDecimalRegistrationRemoteIdPreset(
    'telegram.bot-webhook.v1',
    {
      kind: 'fixed_prefix_positive_decimal_id.v1',
      prefix: 'telegram_bot_',
      max_digits: 16,
    },
  ),
] as const;

const mutablePrefixedPositiveDecimalRegistrationRemoteIdPresets =
  Object.create(null) as Record<
    WebhookProfileId,
    WebhookPrefixedPositiveDecimalRegistrationRemoteIdProfilePreset | undefined
  >;
for (const value of PREFIXED_POSITIVE_DECIMAL_REGISTRATION_REMOTE_ID_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(
    mutablePrefixedPositiveDecimalRegistrationRemoteIdPresets,
    value.profile_id,
  )) {
    throw new Error(
      `duplicate webhook prefixed positive-decimal registration remote-id preset '${value.profile_id}'`,
    );
  }
  mutablePrefixedPositiveDecimalRegistrationRemoteIdPresets[value.profile_id] =
    value;
}

export const WEBHOOK_PREFIXED_POSITIVE_DECIMAL_REGISTRATION_REMOTE_ID_PROFILE_PRESETS: Readonly<
  Partial<Record<
    WebhookProfileId,
    WebhookPrefixedPositiveDecimalRegistrationRemoteIdProfilePreset
  >>
> = Object.freeze(mutablePrefixedPositiveDecimalRegistrationRemoteIdPresets);

export const webhookPrefixedPositiveDecimalRegistrationRemoteIdProfilePreset = (
  profileId: WebhookProfileId,
): WebhookPrefixedPositiveDecimalRegistrationRemoteIdProfilePreset | null =>
  WEBHOOK_PREFIXED_POSITIVE_DECIMAL_REGISTRATION_REMOTE_ID_PROFILE_PRESETS[
    profileId
  ] ?? null;

export interface WebhookFixedPrefixRegistrationRemoteIdProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly parser: WebhookFixedPrefixProviderIdParserPreset;
}

const fixedPrefixRegistrationRemoteIdPreset = (
  profile_id: WebhookProfileId,
  parserInput: WebhookFixedPrefixProviderIdParserPreset,
): WebhookFixedPrefixRegistrationRemoteIdProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  if (descriptor === null
    || !descriptor.registration_modes.includes('managed_endpoint')
    || !descriptor.managed_registration_requires_connection) {
    throw new Error(
      `webhook fixed-prefix registration remote-id preset '${profile_id}' requires connection-bound managed registration`,
    );
  }
  const value = Object.freeze({
    profile_id,
    parser: createWebhookFixedPrefixProviderIdParser(parserInput).preset,
  });
  JSON.stringify(value);
  return value;
};

const FIXED_PREFIX_REGISTRATION_REMOTE_ID_PRESET_LIST = [
  fixedPrefixRegistrationRemoteIdPreset('paddle.notification.v1', {
    kind: 'fixed_prefix_lowercase_alphanumeric_id.v1',
    prefix: 'ntfset_',
    suffix_length: 26,
  }),
] as const;

const mutableFixedPrefixRegistrationRemoteIdPresets =
  Object.create(null) as Record<
    WebhookProfileId,
    WebhookFixedPrefixRegistrationRemoteIdProfilePreset | undefined
  >;
for (const value of FIXED_PREFIX_REGISTRATION_REMOTE_ID_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(
    mutableFixedPrefixRegistrationRemoteIdPresets,
    value.profile_id,
  )) {
    throw new Error(
      `duplicate webhook fixed-prefix registration remote-id preset '${value.profile_id}'`,
    );
  }
  mutableFixedPrefixRegistrationRemoteIdPresets[value.profile_id] = value;
}

export const WEBHOOK_FIXED_PREFIX_REGISTRATION_REMOTE_ID_PROFILE_PRESETS: Readonly<
  Partial<Record<
    WebhookProfileId,
    WebhookFixedPrefixRegistrationRemoteIdProfilePreset
  >>
> = Object.freeze(mutableFixedPrefixRegistrationRemoteIdPresets);

export const webhookFixedPrefixRegistrationRemoteIdProfilePreset = (
  profileId: WebhookProfileId,
): WebhookFixedPrefixRegistrationRemoteIdProfilePreset | null =>
  WEBHOOK_FIXED_PREFIX_REGISTRATION_REMOTE_ID_PROFILE_PRESETS[profileId]
    ?? null;

export interface WebhookPositiveDecimalStructuralEvidenceProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly parser: WebhookPositiveDecimalIdentifierParserPreset;
}

const positiveDecimalStructuralEvidencePreset = (
  profile_id: WebhookProfileId,
  parserInput: WebhookPositiveDecimalIdentifierParserPreset,
): WebhookPositiveDecimalStructuralEvidenceProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  if (descriptor?.decoder_kind !== 'json'
    || descriptor.max_events_per_delivery !== 1) {
    throw new Error(
      `webhook positive-decimal structural-evidence preset '${profile_id}' requires a single-event JSON profile`,
    );
  }
  const value = Object.freeze({
    profile_id,
    parser: createWebhookPositiveDecimalIdentifierParser(parserInput).preset,
  });
  JSON.stringify(value);
  return value;
};

const POSITIVE_DECIMAL_STRUCTURAL_EVIDENCE_PRESET_LIST = [
  positiveDecimalStructuralEvidencePreset('github.webhook.v1', {
    kind: 'positive_decimal_identifier.v1',
    max_digits: 32,
  }),
] as const;

const mutablePositiveDecimalStructuralEvidencePresets =
  Object.create(null) as Record<
    WebhookProfileId,
    WebhookPositiveDecimalStructuralEvidenceProfilePreset | undefined
  >;
for (const value of POSITIVE_DECIMAL_STRUCTURAL_EVIDENCE_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(
    mutablePositiveDecimalStructuralEvidencePresets,
    value.profile_id,
  )) {
    throw new Error(
      `duplicate webhook positive-decimal structural-evidence preset '${value.profile_id}'`,
    );
  }
  mutablePositiveDecimalStructuralEvidencePresets[value.profile_id] = value;
}

export const WEBHOOK_POSITIVE_DECIMAL_STRUCTURAL_EVIDENCE_PROFILE_PRESETS: Readonly<
  Partial<Record<
    WebhookProfileId,
    WebhookPositiveDecimalStructuralEvidenceProfilePreset
  >>
> = Object.freeze(mutablePositiveDecimalStructuralEvidencePresets);

export const webhookPositiveDecimalStructuralEvidenceProfilePreset = (
  profileId: WebhookProfileId,
): WebhookPositiveDecimalStructuralEvidenceProfilePreset | null =>
  WEBHOOK_POSITIVE_DECIMAL_STRUCTURAL_EVIDENCE_PROFILE_PRESETS[profileId]
    ?? null;

export interface WebhookPositiveDecimalRegistrationRemoteIdProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly parser: WebhookPositiveDecimalIdentifierParserPreset;
}

const positiveDecimalRegistrationRemoteIdPreset = (
  profile_id: WebhookProfileId,
  parserInput: WebhookPositiveDecimalIdentifierParserPreset,
): WebhookPositiveDecimalRegistrationRemoteIdProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  if (descriptor === null
    || !descriptor.registration_modes.includes('managed_endpoint')
    || !descriptor.managed_registration_requires_connection) {
    throw new Error(
      `webhook positive-decimal registration remote-id preset '${profile_id}' requires connection-bound managed registration`,
    );
  }
  const value = Object.freeze({
    profile_id,
    parser: createWebhookPositiveDecimalIdentifierParser(parserInput).preset,
  });
  JSON.stringify(value);
  return value;
};

const POSITIVE_DECIMAL_REGISTRATION_REMOTE_ID_PRESET_LIST = [
  positiveDecimalRegistrationRemoteIdPreset('github.webhook.v1', {
    kind: 'positive_decimal_identifier.v1',
    max_digits: 20,
  }),
] as const;

const mutablePositiveDecimalRegistrationRemoteIdPresets =
  Object.create(null) as Record<
    WebhookProfileId,
    WebhookPositiveDecimalRegistrationRemoteIdProfilePreset | undefined
  >;
for (const value of POSITIVE_DECIMAL_REGISTRATION_REMOTE_ID_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(
    mutablePositiveDecimalRegistrationRemoteIdPresets,
    value.profile_id,
  )) {
    throw new Error(
      `duplicate webhook positive-decimal registration remote-id preset '${value.profile_id}'`,
    );
  }
  mutablePositiveDecimalRegistrationRemoteIdPresets[value.profile_id] = value;
}

export const WEBHOOK_POSITIVE_DECIMAL_REGISTRATION_REMOTE_ID_PROFILE_PRESETS: Readonly<
  Partial<Record<
    WebhookProfileId,
    WebhookPositiveDecimalRegistrationRemoteIdProfilePreset
  >>
> = Object.freeze(mutablePositiveDecimalRegistrationRemoteIdPresets);

export const webhookPositiveDecimalRegistrationRemoteIdProfilePreset = (
  profileId: WebhookProfileId,
): WebhookPositiveDecimalRegistrationRemoteIdProfilePreset | null =>
  WEBHOOK_POSITIVE_DECIMAL_REGISTRATION_REMOTE_ID_PROFILE_PRESETS[profileId]
    ?? null;

export interface WebhookAsciiEventTypeProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly parser: WebhookAsciiEventTypeParserPreset;
}

const asciiEventTypePreset = (
  profile_id: WebhookProfileId,
  parserInput: WebhookAsciiEventTypeParserPreset,
): WebhookAsciiEventTypeProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  const parser = createWebhookAsciiEventTypeParser(parserInput);
  const catalogValues = descriptor?.event_types.kind === 'closed'
    ? descriptor.event_types.values
    : descriptor?.event_types.known_values;
  if (descriptor === null
    || catalogValues === undefined
    || catalogValues.some((eventType) => parser.parse(eventType) === null)) {
    throw new Error(
      `webhook ASCII event-type preset '${profile_id}' does not admit its catalog`,
    );
  }
  const value = Object.freeze({
    profile_id,
    parser: parser.preset,
  });
  JSON.stringify(value);
  return value;
};

const ASCII_EVENT_TYPE_PRESET_LIST = [
  asciiEventTypePreset('stripe.event.v1', {
    kind: 'ascii_alphanumeric_dot_colon_slash_dash.v1',
    max_bytes: 128,
  }),
] as const;

const mutableAsciiEventTypePresets = Object.create(null) as Record<
  WebhookProfileId,
  WebhookAsciiEventTypeProfilePreset | undefined
>;
for (const value of ASCII_EVENT_TYPE_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(
    mutableAsciiEventTypePresets,
    value.profile_id,
  )) {
    throw new Error(
      `duplicate webhook ASCII event-type preset '${value.profile_id}'`,
    );
  }
  mutableAsciiEventTypePresets[value.profile_id] = value;
}

export const WEBHOOK_ASCII_EVENT_TYPE_PROFILE_PRESETS: Readonly<
  Partial<Record<WebhookProfileId, WebhookAsciiEventTypeProfilePreset>>
> = Object.freeze(mutableAsciiEventTypePresets);

export const webhookAsciiEventTypeProfilePreset = (
  profileId: WebhookProfileId,
): WebhookAsciiEventTypeProfilePreset | null =>
  WEBHOOK_ASCII_EVENT_TYPE_PROFILE_PRESETS[profileId] ?? null;

export interface WebhookAsciiIdentifierEventTypeProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly parser: WebhookAsciiIdentifierParserPreset;
}

const asciiIdentifierEventTypePreset = (
  profile_id: WebhookProfileId,
  parserInput: WebhookAsciiIdentifierParserPreset,
): WebhookAsciiIdentifierEventTypeProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  const parser = createWebhookAsciiIdentifierParser(parserInput);
  const catalogValues = descriptor?.event_types.kind === 'closed'
    ? descriptor.event_types.values
    : descriptor?.event_types.known_values;
  if (descriptor === null
    || catalogValues === undefined
    || catalogValues.some((eventType) => parser.parse(eventType) === null)) {
    throw new Error(
      `webhook ASCII identifier event-type preset '${profile_id}' does not admit its catalog`,
    );
  }
  const value = Object.freeze({
    profile_id,
    parser: parser.preset,
  });
  JSON.stringify(value);
  return value;
};

const ASCII_IDENTIFIER_EVENT_TYPE_PRESET_LIST = [
  asciiIdentifierEventTypePreset('telegram.bot-webhook.v1', {
    kind: 'ascii_identifier.v1',
    max_bytes: 128,
  }),
] as const;

const mutableAsciiIdentifierEventTypePresets = Object.create(null) as Record<
  WebhookProfileId,
  WebhookAsciiIdentifierEventTypeProfilePreset | undefined
>;
for (const value of ASCII_IDENTIFIER_EVENT_TYPE_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(
    mutableAsciiIdentifierEventTypePresets,
    value.profile_id,
  )) {
    throw new Error(
      `duplicate webhook ASCII identifier event-type preset '${value.profile_id}'`,
    );
  }
  mutableAsciiIdentifierEventTypePresets[value.profile_id] = value;
}

export const WEBHOOK_ASCII_IDENTIFIER_EVENT_TYPE_PROFILE_PRESETS: Readonly<
  Partial<Record<
    WebhookProfileId,
    WebhookAsciiIdentifierEventTypeProfilePreset
  >>
> = Object.freeze(mutableAsciiIdentifierEventTypePresets);

export const webhookAsciiIdentifierEventTypeProfilePreset = (
  profileId: WebhookProfileId,
): WebhookAsciiIdentifierEventTypeProfilePreset | null =>
  WEBHOOK_ASCII_IDENTIFIER_EVENT_TYPE_PROFILE_PRESETS[profileId] ?? null;

export interface WebhookLowercaseIdentifierEventTypeProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly parser: WebhookLowercaseIdentifierEventTypeParserPreset;
}

const lowercaseIdentifierEventTypePreset = (
  profile_id: WebhookProfileId,
  parserInput: WebhookLowercaseIdentifierEventTypeParserPreset,
): WebhookLowercaseIdentifierEventTypeProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  const parser = createWebhookLowercaseIdentifierEventTypeParser(parserInput);
  const catalogValues = descriptor?.event_types.kind === 'closed'
    ? descriptor.event_types.values
    : descriptor?.event_types.known_values;
  if (descriptor === null
    || catalogValues === undefined
    || catalogValues.some((eventType) => parser.parse(eventType) === null)) {
    throw new Error(
      `webhook lowercase identifier event-type preset '${profile_id}' does not admit its catalog`,
    );
  }
  const value = Object.freeze({
    profile_id,
    parser: parser.preset,
  });
  JSON.stringify(value);
  return value;
};

const LOWERCASE_IDENTIFIER_EVENT_TYPE_PRESET_LIST = [
  lowercaseIdentifierEventTypePreset('github.webhook.v1', {
    kind: 'lowercase_identifier_event_type.v1',
    max_characters: 128,
  }),
] as const;

const mutableLowercaseIdentifierEventTypePresets = Object.create(null) as Record<
  WebhookProfileId,
  WebhookLowercaseIdentifierEventTypeProfilePreset | undefined
>;
for (const value of LOWERCASE_IDENTIFIER_EVENT_TYPE_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(
    mutableLowercaseIdentifierEventTypePresets,
    value.profile_id,
  )) {
    throw new Error(
      `duplicate webhook lowercase identifier event-type preset '${value.profile_id}'`,
    );
  }
  mutableLowercaseIdentifierEventTypePresets[value.profile_id] = value;
}

export const WEBHOOK_LOWERCASE_IDENTIFIER_EVENT_TYPE_PROFILE_PRESETS: Readonly<
  Partial<Record<
    WebhookProfileId,
    WebhookLowercaseIdentifierEventTypeProfilePreset
  >>
> = Object.freeze(mutableLowercaseIdentifierEventTypePresets);

export const webhookLowercaseIdentifierEventTypeProfilePreset = (
  profileId: WebhookProfileId,
): WebhookLowercaseIdentifierEventTypeProfilePreset | null =>
  WEBHOOK_LOWERCASE_IDENTIFIER_EVENT_TYPE_PROFILE_PRESETS[profileId] ?? null;

export interface WebhookDotSegmentEventTypeProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly parser: WebhookDotSegmentEventTypeParserPreset;
}

const dotSegmentEventTypePreset = (
  profile_id: WebhookProfileId,
  parserInput: WebhookDotSegmentEventTypeParserPreset,
): WebhookDotSegmentEventTypeProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  const parser = createWebhookDotSegmentEventTypeParser(parserInput);
  const catalogValues = descriptor?.event_types.kind === 'closed'
    ? descriptor.event_types.values
    : descriptor?.event_types.known_values;
  if (descriptor === null
    || catalogValues === undefined
    || catalogValues.some((eventType) => parser.parse(eventType) === null)) {
    throw new Error(
      `webhook dot-segment event-type preset '${profile_id}' does not admit its catalog`,
    );
  }
  const value = Object.freeze({
    profile_id,
    parser: parser.preset,
  });
  JSON.stringify(value);
  return value;
};

const DOT_SEGMENT_EVENT_TYPE_PRESET_LIST = [
  dotSegmentEventTypePreset('paddle.notification.v1', {
    kind: 'lowercase_dot_segment_event_type.v1',
    segment_count: 2,
    max_segment_characters: 63,
  }),
] as const;

const mutableDotSegmentEventTypePresets = Object.create(null) as Record<
  WebhookProfileId,
  WebhookDotSegmentEventTypeProfilePreset | undefined
>;
for (const value of DOT_SEGMENT_EVENT_TYPE_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(
    mutableDotSegmentEventTypePresets,
    value.profile_id,
  )) {
    throw new Error(
      `duplicate webhook dot-segment event-type preset '${value.profile_id}'`,
    );
  }
  mutableDotSegmentEventTypePresets[value.profile_id] = value;
}

export const WEBHOOK_DOT_SEGMENT_EVENT_TYPE_PROFILE_PRESETS: Readonly<
  Partial<Record<WebhookProfileId, WebhookDotSegmentEventTypeProfilePreset>>
> = Object.freeze(mutableDotSegmentEventTypePresets);

export const webhookDotSegmentEventTypeProfilePreset = (
  profileId: WebhookProfileId,
): WebhookDotSegmentEventTypeProfilePreset | null =>
  WEBHOOK_DOT_SEGMENT_EVENT_TYPE_PROFILE_PRESETS[profileId] ?? null;

export interface WebhookJsonObjectProviderIdProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly extractor: WebhookJsonObjectProviderIdExtractorPreset;
}

const jsonObjectProviderIdPreset = (
  profile_id: WebhookProfileId,
  extractorInput: WebhookJsonObjectProviderIdExtractorPreset,
): WebhookJsonObjectProviderIdProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  if (descriptor?.decoder_kind !== 'json') {
    throw new Error(
      `webhook JSON-object provider-id preset '${profile_id}' requires a JSON profile`,
    );
  }
  const value = Object.freeze({
    profile_id,
    extractor: createWebhookJsonObjectProviderIdExtractor(
      extractorInput,
    ).preset,
  });
  JSON.stringify(value);
  return value;
};

const JSON_OBJECT_PROVIDER_ID_PRESET_LIST = [
  jsonObjectProviderIdPreset('paddle.notification.v1', {
    kind: 'optional_json_object_provider_id.v1',
    field: 'id',
    grammar: 'control_free_trimmed_utf8.v1',
    max_bytes: 512,
  }),
] as const;

const mutableJsonObjectProviderIdPresets = Object.create(null) as Record<
  WebhookProfileId,
  WebhookJsonObjectProviderIdProfilePreset | undefined
>;
for (const value of JSON_OBJECT_PROVIDER_ID_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(
    mutableJsonObjectProviderIdPresets,
    value.profile_id,
  )) {
    throw new Error(
      `duplicate webhook JSON-object provider-id preset '${value.profile_id}'`,
    );
  }
  mutableJsonObjectProviderIdPresets[value.profile_id] = value;
}

export const WEBHOOK_JSON_OBJECT_PROVIDER_ID_PROFILE_PRESETS: Readonly<
  Partial<Record<WebhookProfileId, WebhookJsonObjectProviderIdProfilePreset>>
> = Object.freeze(mutableJsonObjectProviderIdPresets);

export const webhookJsonObjectProviderIdProfilePreset = (
  profileId: WebhookProfileId,
): WebhookJsonObjectProviderIdProfilePreset | null =>
  WEBHOOK_JSON_OBJECT_PROVIDER_ID_PROFILE_PRESETS[profileId] ?? null;

export interface WebhookJsonRequiredObjectProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly extractor: WebhookJsonRequiredObjectExtractorPreset;
}

const jsonRequiredObjectPreset = (
  profile_id: WebhookProfileId,
  extractorInput: WebhookJsonRequiredObjectExtractorPreset,
): WebhookJsonRequiredObjectProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  if (descriptor?.decoder_kind !== 'json') {
    throw new Error(
      `webhook required JSON-object preset '${profile_id}' requires a JSON profile`,
    );
  }
  const value = Object.freeze({
    profile_id,
    extractor: createWebhookJsonRequiredObjectExtractor(
      extractorInput,
    ).preset,
  });
  JSON.stringify(value);
  return value;
};

const JSON_REQUIRED_OBJECT_PRESET_LIST = [
  jsonRequiredObjectPreset('paddle.notification.v1', {
    kind: 'required_json_object_field.v1',
    field: 'data',
  }),
] as const;

const mutableJsonRequiredObjectPresets = Object.create(null) as Record<
  WebhookProfileId,
  WebhookJsonRequiredObjectProfilePreset | undefined
>;
for (const value of JSON_REQUIRED_OBJECT_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(
    mutableJsonRequiredObjectPresets,
    value.profile_id,
  )) {
    throw new Error(
      `duplicate webhook required JSON-object preset '${value.profile_id}'`,
    );
  }
  mutableJsonRequiredObjectPresets[value.profile_id] = value;
}

export const WEBHOOK_JSON_REQUIRED_OBJECT_PROFILE_PRESETS: Readonly<
  Partial<Record<WebhookProfileId, WebhookJsonRequiredObjectProfilePreset>>
> = Object.freeze(mutableJsonRequiredObjectPresets);

export const webhookJsonRequiredObjectProfilePreset = (
  profileId: WebhookProfileId,
): WebhookJsonRequiredObjectProfilePreset | null =>
  WEBHOOK_JSON_REQUIRED_OBJECT_PROFILE_PRESETS[profileId] ?? null;
