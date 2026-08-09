/** D-201 Slices 8J + 9E + 9O + 9W + 9AC-9AE + 9AX + 9BQ — server-only control-plane policy by profile id.
 *
 * Generic ingress and reconciliation code calls this registry and never imports
 * vendor validators or target canonicalizers. Entries are trusted profile
 * presets; the functions they select are not portable or pack-authorable.
 */

import {
  WEBHOOK_PROFILE_IDS,
  webhookProfile,
  type WebhookProfileId,
  type WebhookRegistrationMode,
  type WebhookRegistrationTarget,
} from '@recued/contracts';
import { validatePrimitiveWebhookCredentialShape } from './webhook-primitive-profiles.js';
import {
  createTimestampedFormWebhookCredentialShapeValidator,
} from './webhook-timestamped-form-profile.js';
import {
  createTimestampedJsonSingleEventWebhookCredentialShapeValidator,
} from './webhook-timestamped-json-single-event-profile.js';
import {
  createTimestampedJsonSingleNotificationWebhookCredentialShapeValidator,
} from './webhook-timestamped-json-single-notification-profile.js';
import {
  createRawHeaderJsonSingleEventWebhookCredentialShapeValidator,
} from './webhook-raw-header-json-single-event-profile.js';
import {
  createRawBodyJsonApiSingleEventWebhookCredentialShapeValidator,
} from './webhook-raw-body-json-api-single-event-profile.js';
import {
  createStaticHeaderJsonSingleEventWebhookCredentialShapeValidator,
} from './webhook-static-header-json-single-event-profile.js';
import {
  createTimestampedJsonFormSingleEventWebhookCredentialShapeValidator,
} from './webhook-timestamped-json-form-single-event-profile.js';
import {
  createWebhookAccountResourceRegistrationTargetNormalizer,
} from './webhook-account-resource-registration-target-normalizer.js';
import {
  webhookRegistrationTargetProfilePreset,
} from './webhook-registration-target-profile-presets.js';
import {
  createWebhookBoundedHttpsUrlParser,
} from './webhook-bounded-https-url-parser.js';
import {
  webhookEndpointProfilePreset,
} from './webhook-endpoint-profile-presets.js';

export type WebhookRegistrationTargetResolution =
  | { ok: true; target: WebhookRegistrationTarget | null }
  | { ok: false; message: string };

export interface WebhookProfileControlPlanePolicy {
  readonly profile_id: WebhookProfileId;
  validateCredentialShape(credentials: Readonly<Record<string, string>>): boolean;
  resolveRegistrationTarget(
    value: unknown,
    mode: WebhookRegistrationMode,
  ): WebhookRegistrationTargetResolution;
  endpointSupported(endpointUrl: string): boolean;
}

export interface WebhookProfileControlPlanePolicyRegistry {
  get(profileId: WebhookProfileId): WebhookProfileControlPlanePolicy;
  list(): readonly WebhookProfileControlPlanePolicy[];
}

const noRegistrationTarget = (
  profileId: WebhookProfileId,
  value: unknown,
  mode: WebhookRegistrationMode,
): WebhookRegistrationTargetResolution => value === undefined || value === null
  ? { ok: true, target: null }
  : {
      ok: false,
      message: `registration_target is not supported for profile '${profileId}' in registration_mode '${mode}'`,
    };

const entry = (
  profile_id: WebhookProfileId,
  validateCredentialShape: WebhookProfileControlPlanePolicy['validateCredentialShape'],
): WebhookProfileControlPlanePolicy => {
  const targetPreset = webhookRegistrationTargetProfilePreset(profile_id);
  const targetNormalizer = targetPreset === null
    ? null
    : createWebhookAccountResourceRegistrationTargetNormalizer(
        targetPreset.normalizer,
      );
  const endpointPreset = webhookEndpointProfilePreset(profile_id);
  const endpointParser = endpointPreset === null
    ? null
    : createWebhookBoundedHttpsUrlParser(endpointPreset.parser);
  return Object.freeze({
    profile_id,
    validateCredentialShape,
    resolveRegistrationTarget: (
      value: unknown,
      mode: WebhookRegistrationMode,
    ): WebhookRegistrationTargetResolution => {
      if (targetPreset === null
        || targetNormalizer === null
        || !targetPreset.modes.includes(mode)) {
        return noRegistrationTarget(profile_id, value, mode);
      }
      const target = targetNormalizer.normalize(value);
      return target === null
        ? { ok: false, message: targetPreset.invalid_target_message }
        : { ok: true, target };
    },
    endpointSupported: (endpointUrl: string): boolean => endpointParser === null
      || endpointParser.parse(endpointUrl) !== null,
  });
};

const primitiveEntry = (profileId: WebhookProfileId): WebhookProfileControlPlanePolicy =>
  entry(
    profileId,
    (credentials) => validatePrimitiveWebhookCredentialShape(profileId, credentials) === true,
  );

const validateSlackSlashCommandCredentialShape =
  createTimestampedFormWebhookCredentialShapeValidator(
    'slack.slash-command.v1',
  );

const validateSlackRequestCredentialShape =
  createTimestampedJsonFormSingleEventWebhookCredentialShapeValidator(
    'slack.request.v0',
  );

const validateStripeDeliveryCredentialShape =
  createTimestampedJsonSingleEventWebhookCredentialShapeValidator(
    'stripe.event.v1',
  );

/** SPIKE — the peer profile is vendor-family (it rides the timestamped-JSON
 *  single-event composer), so it needs a full `entry`, not a `primitiveEntry`.
 *  Built here rather than imported from the profile module for the same reason
 *  every other validator is: the policy registry must not depend on a profile
 *  module that depends back on it. */
const validateRecuedPeerDeliveryCredentialShape =
  createTimestampedJsonSingleEventWebhookCredentialShapeValidator(
    'recued-peer.exchange.v1',
  );

const validatePaddleDeliveryCredentialShape =
  createTimestampedJsonSingleNotificationWebhookCredentialShapeValidator(
    'paddle.notification.v1',
  );

const validateGitHubDeliveryCredentialShape =
  createRawHeaderJsonSingleEventWebhookCredentialShapeValidator(
    'github.webhook.v1',
  );

const validateLemonSqueezyDeliveryCredentialShape =
  createRawBodyJsonApiSingleEventWebhookCredentialShapeValidator(
    'lemonsqueezy.webhook.v1',
  );

const validateTelegramDeliveryCredentialShape =
  createStaticHeaderJsonSingleEventWebhookCredentialShapeValidator(
    'telegram.bot-webhook.v1',
  );

const BUILTIN_POLICIES = [
  entry('stripe.event.v1', validateStripeDeliveryCredentialShape),
  entry('paddle.notification.v1', validatePaddleDeliveryCredentialShape),
  entry('slack.request.v0', validateSlackRequestCredentialShape),
  entry('slack.slash-command.v1', validateSlackSlashCommandCredentialShape),
  entry('telegram.bot-webhook.v1', validateTelegramDeliveryCredentialShape),
  entry('github.webhook.v1', validateGitHubDeliveryCredentialShape),
  entry(
    'lemonsqueezy.webhook.v1',
    validateLemonSqueezyDeliveryCredentialShape,
  ),
  primitiveEntry('generic.static-header-token.v1'),
  primitiveEntry('generic.raw-body-hmac-sha256.v1'),
  primitiveEntry('generic.timestamped-raw-body-hmac-sha256.v1'),
  primitiveEntry('generic.http-basic.v1'),
  entry('recued-peer.exchange.v1', validateRecuedPeerDeliveryCredentialShape),
] as const;

export const createWebhookProfileControlPlanePolicyRegistry = (
  policies: readonly WebhookProfileControlPlanePolicy[],
): WebhookProfileControlPlanePolicyRegistry => {
  const byId = new Map<WebhookProfileId, WebhookProfileControlPlanePolicy>();
  for (const policy of policies) {
    if (!webhookProfile(policy.profile_id)) {
      throw new Error(`webhook profile policy: unknown profile '${policy.profile_id}'`);
    }
    if (byId.has(policy.profile_id)) {
      throw new Error(`webhook profile policy: duplicate profile '${policy.profile_id}'`);
    }
    byId.set(policy.profile_id, Object.freeze({
      profile_id: policy.profile_id,
      validateCredentialShape: policy.validateCredentialShape.bind(policy),
      resolveRegistrationTarget: policy.resolveRegistrationTarget.bind(policy),
      endpointSupported: policy.endpointSupported.bind(policy),
    }));
  }
  const listed = Object.freeze([...byId.values()]);
  return Object.freeze({
    get(profileId: WebhookProfileId): WebhookProfileControlPlanePolicy {
      const policy = byId.get(profileId);
      if (!policy) {
        throw new Error(`webhook profile policy: unavailable profile '${profileId}'`);
      }
      return policy;
    },
    list: () => listed,
  });
};

export const BUILTIN_WEBHOOK_PROFILE_POLICIES =
  createWebhookProfileControlPlanePolicyRegistry(BUILTIN_POLICIES);

for (const profileId of WEBHOOK_PROFILE_IDS) {
  BUILTIN_WEBHOOK_PROFILE_POLICIES.get(profileId);
}
