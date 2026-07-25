/** D-201 Slices 9BB + 9BD — trusted connection-environment token profiles.
 *
 * This role binds a connection-resolved token grammar to the environments a
 * connection-bound managed-registration profile supports. It is separate from
 * webhook delivery/signing credentials and from the connection auth transport.
 * Owner, marketplace, pack, and recipe data cannot supply mappings, bounds,
 * callbacks, credential paths, or outbound request authority.
 */

import {
  webhookProfile,
  type WebhookProfileId,
} from '@recued/contracts';
import {
  createWebhookEnvironmentMappedPrefixedAsciiTokenClassifier,
  type WebhookEnvironmentMappedPrefixedAsciiTokenClassifierPreset,
} from './webhook-environment-mapped-prefixed-ascii-token-classifier.js';
import {
  createWebhookEnvironmentMappedSegmentedAsciiTokenClassifier,
  type WebhookEnvironmentMappedSegmentedAsciiTokenClassifierPreset,
} from './webhook-environment-mapped-segmented-ascii-token-classifier.js';

export type WebhookRegistrationEnvironmentTokenClassifierPreset =
  | WebhookEnvironmentMappedPrefixedAsciiTokenClassifierPreset
  | WebhookEnvironmentMappedSegmentedAsciiTokenClassifierPreset;

export interface WebhookRegistrationEnvironmentTokenProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly classifier: WebhookRegistrationEnvironmentTokenClassifierPreset;
}

const environmentTokenProfilePreset = (
  profile_id: WebhookProfileId,
  classifierInput: WebhookRegistrationEnvironmentTokenClassifierPreset,
): WebhookRegistrationEnvironmentTokenProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  const classifier = classifierInput.kind
    === 'environment_mapped_prefixed_ascii_token.v1'
    ? createWebhookEnvironmentMappedPrefixedAsciiTokenClassifier(
      classifierInput,
    ).preset
    : createWebhookEnvironmentMappedSegmentedAsciiTokenClassifier(
      classifierInput,
    ).preset;
  const mappedEnvironments = [...new Set(
    classifier.mappings.map((mapping) => mapping.environment),
  )];
  if (descriptor === null
    || !descriptor.registration_modes.includes('managed_endpoint')
    || !descriptor.managed_registration_requires_connection
    || mappedEnvironments.length !== descriptor.supported_environments.length
    || mappedEnvironments.some((environment) =>
      !descriptor.supported_environments.includes(environment))) {
    throw new Error(
      `webhook registration environment-token preset '${profile_id}' does not match its connection-bound managed-registration environments`,
    );
  }
  const value = Object.freeze({ profile_id, classifier });
  JSON.stringify(value);
  return value;
};

const ENVIRONMENT_TOKEN_PROFILE_PRESET_LIST = [
  environmentTokenProfilePreset('stripe.event.v1', {
    kind: 'environment_mapped_prefixed_ascii_token.v1',
    max_bytes: 512,
    mappings: [
      { prefix: 'sk_test_', environment: 'test' },
      { prefix: 'rk_test_', environment: 'test' },
      { prefix: 'sk_live_', environment: 'live' },
      { prefix: 'rk_live_', environment: 'live' },
    ],
  }),
  environmentTokenProfilePreset('paddle.notification.v1', {
    kind: 'environment_mapped_segmented_ascii_token.v1',
    separator: '_',
    segments: [
      { length: 26, alphabet: 'lowercase_alphanumeric' },
      { length: 22, alphabet: 'ascii_alphanumeric' },
      { length: 3, alphabet: 'ascii_alphanumeric' },
    ],
    mappings: [
      { prefix: 'pdl_sdbx_apikey_', environment: 'test' },
      { prefix: 'pdl_live_apikey_', environment: 'live' },
    ],
  }),
] as const;

const mutableEnvironmentTokenProfilePresets = Object.create(null) as Record<
  WebhookProfileId,
  WebhookRegistrationEnvironmentTokenProfilePreset | undefined
>;
for (const value of ENVIRONMENT_TOKEN_PROFILE_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(
    mutableEnvironmentTokenProfilePresets,
    value.profile_id,
  )) {
    throw new Error(
      `duplicate webhook registration environment-token preset '${value.profile_id}'`,
    );
  }
  mutableEnvironmentTokenProfilePresets[value.profile_id] = value;
}

export const WEBHOOK_REGISTRATION_ENVIRONMENT_TOKEN_PROFILE_PRESETS: Readonly<
  Partial<Record<
    WebhookProfileId,
    WebhookRegistrationEnvironmentTokenProfilePreset
  >>
> = Object.freeze(mutableEnvironmentTokenProfilePresets);

export const webhookRegistrationEnvironmentTokenProfilePreset = (
  profileId: WebhookProfileId,
): WebhookRegistrationEnvironmentTokenProfilePreset | null =>
  WEBHOOK_REGISTRATION_ENVIRONMENT_TOKEN_PROFILE_PRESETS[profileId] ?? null;
