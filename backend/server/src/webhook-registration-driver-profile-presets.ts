/** D-201 Slices 9BI-9BK — trusted registration lifecycle-driver profile data.
 *
 * This registry names only code-backed lifecycle families and their closed
 * traversal/cardinality policy. Provider HTTP authority, response grammar,
 * correlation, ownership, and secret handling remain outside serializable
 * preset data and cannot be supplied by owners, packs, or recipes.
 */

import type { WebhookProfileId } from '@recued/contracts';
import {
  compileWebhookAddressableCollectionRegistrationDriverPreset,
  type WebhookAddressableCollectionRegistrationDriverPreset,
} from './webhook-addressable-collection-registration-driver.js';
import {
  compileWebhookTargetScopedCollectionRegistrationDriverPreset,
  type WebhookTargetScopedCollectionRegistrationDriverPreset,
} from './webhook-target-scoped-collection-registration-driver.js';
import {
  compileWebhookProviderSingletonRegistrationDriverPreset,
  type WebhookProviderSingletonRegistrationDriverPreset,
} from './webhook-provider-singleton-registration-driver.js';

export type WebhookRegistrationDriverProfilePreset =
  | WebhookAddressableCollectionRegistrationDriverPreset
  | WebhookTargetScopedCollectionRegistrationDriverPreset
  | WebhookProviderSingletonRegistrationDriverPreset;

const DRIVER_PROFILE_PRESET_LIST = [
  compileWebhookAddressableCollectionRegistrationDriverPreset({
    kind: 'addressable_endpoint_collection.v1',
    profile_id: 'stripe.event.v1',
    pagination: {
      kind: 'bounded_after_id.v1',
      max_pages: 10,
      page_size: 100,
    },
    search_exhausted_message:
      'Stripe webhook endpoint search exceeded its bounded page limit',
  }),
  /** Paddle rows include every subscribed event's full object, not only its
   * name. The smaller page bounds amplification before the body ceiling. */
  compileWebhookAddressableCollectionRegistrationDriverPreset({
    kind: 'addressable_endpoint_collection.v1',
    profile_id: 'paddle.notification.v1',
    pagination: {
      kind: 'bounded_after_id.v1',
      max_pages: 10,
      page_size: 25,
    },
    search_exhausted_message:
      'Paddle notification-setting search exceeded its bounded page limit',
  }),
  compileWebhookTargetScopedCollectionRegistrationDriverPreset({
    kind: 'target_scoped_endpoint_collection.v1',
    profile_id: 'github.webhook.v1',
    pagination: {
      kind: 'bounded_page_number.v1',
      max_pages: 10,
      page_size: 100,
    },
    search_exhausted_message:
      'GitHub webhook search exceeded its bounded page limit',
  }),
  compileWebhookProviderSingletonRegistrationDriverPreset({
    kind: 'provider_singleton_endpoint.v1',
    profile_id: 'telegram.bot-webhook.v1',
  }),
] as const;

const mutablePresets = Object.create(null) as Record<
  WebhookProfileId,
  WebhookRegistrationDriverProfilePreset | undefined
>;
for (const value of DRIVER_PROFILE_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(mutablePresets, value.profile_id)) {
    throw new Error(
      `duplicate webhook registration-driver preset '${value.profile_id}'`,
    );
  }
  mutablePresets[value.profile_id] = value;
}

export const WEBHOOK_REGISTRATION_DRIVER_PROFILE_PRESETS: Readonly<
  Partial<Record<WebhookProfileId, WebhookRegistrationDriverProfilePreset>>
> = Object.freeze(mutablePresets);

export const webhookAddressableCollectionRegistrationDriverPreset = (
  profileId: WebhookProfileId,
): WebhookAddressableCollectionRegistrationDriverPreset | null => {
  const preset = WEBHOOK_REGISTRATION_DRIVER_PROFILE_PRESETS[profileId];
  return preset?.kind === 'addressable_endpoint_collection.v1'
    ? preset
    : null;
};

export const webhookTargetScopedCollectionRegistrationDriverPreset = (
  profileId: WebhookProfileId,
): WebhookTargetScopedCollectionRegistrationDriverPreset | null => {
  const preset = WEBHOOK_REGISTRATION_DRIVER_PROFILE_PRESETS[profileId];
  return preset?.kind === 'target_scoped_endpoint_collection.v1'
    ? preset
    : null;
};

export const webhookProviderSingletonRegistrationDriverPreset = (
  profileId: WebhookProfileId,
): WebhookProviderSingletonRegistrationDriverPreset | null => {
  const preset = WEBHOOK_REGISTRATION_DRIVER_PROFILE_PRESETS[profileId];
  return preset?.kind === 'provider_singleton_endpoint.v1'
    ? preset
    : null;
};
