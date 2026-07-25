/** D-201 Slice 9AE — trusted registration-target profile preset data.
 *
 * This is the profile/vendor boundary for secret-free registration scopes.
 * Generic control-plane policy and registration composition select a closed
 * normalizer through this registry; owner input cannot provide kind grammars,
 * normalization policy, error text, or executable target authority.
 */

import {
  webhookOwnerProfileSettings,
  webhookProfile,
  type WebhookProfileId,
  type WebhookRegistrationMode,
} from '@recued/contracts';
import {
  createWebhookAccountResourceRegistrationTargetNormalizer,
  type WebhookAccountResourceRegistrationTargetNormalizerPreset,
} from './webhook-account-resource-registration-target-normalizer.js';

export interface WebhookRegistrationTargetProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly modes: readonly WebhookRegistrationMode[];
  readonly normalizer: WebhookAccountResourceRegistrationTargetNormalizerPreset;
  readonly invalid_target_message: string;
}

const REGISTRATION_MODES = new Set<WebhookRegistrationMode>([
  'manual',
  'managed_endpoint',
  'operation_bound',
]);

const targetProfilePreset = (
  profile_id: WebhookProfileId,
  modesInput: readonly WebhookRegistrationMode[],
  normalizerInput: WebhookAccountResourceRegistrationTargetNormalizerPreset,
  invalidTargetMessageInput: string,
): WebhookRegistrationTargetProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  const ownerTarget = webhookOwnerProfileSettings(profile_id).registration_target;
  const normalizer = createWebhookAccountResourceRegistrationTargetNormalizer(
    normalizerInput,
  ).preset;
  const modes = [...modesInput];
  const ownerKinds = ownerTarget?.kinds.map((kind) => kind.value) ?? [];
  const normalizerKinds = [normalizer.account_kind, normalizer.resource_kind];
  if (descriptor === null
    || ownerTarget === null
    || modes.length === 0
    || new Set(modes).size !== modes.length
    || modes.some((mode) => !REGISTRATION_MODES.has(mode)
      || !descriptor.registration_modes.includes(mode))
    || modes.length !== ownerTarget.modes.length
    || modes.some((mode) => !ownerTarget.modes.includes(mode))
    || ownerKinds.length !== normalizerKinds.length
    || new Set(ownerKinds).size !== ownerKinds.length
    || normalizerKinds.some((kind) => !ownerKinds.includes(kind))
    || ownerTarget.key_normalization !== 'lowercase'
    || typeof invalidTargetMessageInput !== 'string'
    || invalidTargetMessageInput.length === 0
    || invalidTargetMessageInput.length > 1_024
    || !/^[\x20-\x7e]+$/.test(invalidTargetMessageInput)) {
    throw new Error(
      `webhook registration-target preset '${profile_id}' does not match its profile settings`,
    );
  }
  const value = Object.freeze({
    profile_id,
    modes: Object.freeze(modes),
    normalizer,
    invalid_target_message: invalidTargetMessageInput,
  });
  JSON.stringify(value);
  return value;
};

const TARGET_PROFILE_PRESET_LIST = [
  targetProfilePreset(
    'github.webhook.v1',
    ['managed_endpoint'],
    {
      kind: 'account_or_account_resource.v1',
      account_kind: 'organization',
      resource_kind: 'repository',
    },
    "GitHub managed registration requires registration_target { kind: 'repository', key: 'owner/repository' } or { kind: 'organization', key: 'organization' }",
  ),
] as const;

const mutablePresets = Object.create(null) as Record<
  WebhookProfileId,
  WebhookRegistrationTargetProfilePreset | undefined
>;
for (const value of TARGET_PROFILE_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(mutablePresets, value.profile_id)) {
    throw new Error(
      `duplicate webhook registration-target preset '${value.profile_id}'`,
    );
  }
  mutablePresets[value.profile_id] = value;
}

export const WEBHOOK_REGISTRATION_TARGET_PROFILE_PRESETS: Readonly<
  Partial<Record<WebhookProfileId, WebhookRegistrationTargetProfilePreset>>
> = Object.freeze(mutablePresets);

export const webhookRegistrationTargetProfilePreset = (
  profileId: WebhookProfileId,
): WebhookRegistrationTargetProfilePreset | null =>
  WEBHOOK_REGISTRATION_TARGET_PROFILE_PRESETS[profileId] ?? null;
