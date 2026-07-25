/** D-201 Slice 9AZ — trusted managed-registration destination profile data.
 *
 * This distinct role models provider fields whose discriminator selects either
 * an HTTP(S) URL or an opaque destination. Owner, marketplace, pack, and recipe
 * data cannot supply discriminator labels, bounds, URL schemes, callbacks, or
 * provider request authority.
 */

import {
  webhookProfile,
  type WebhookProfileId,
} from '@recued/contracts';
import {
  createWebhookHttpOrOpaqueDestinationParser,
  type WebhookHttpOrOpaqueDestinationParserPreset,
} from './webhook-http-or-opaque-destination-parser.js';

export interface WebhookRegistrationDestinationProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly parser: WebhookHttpOrOpaqueDestinationParserPreset;
}

const destinationProfilePreset = (
  profile_id: WebhookProfileId,
  parserInput: WebhookHttpOrOpaqueDestinationParserPreset,
): WebhookRegistrationDestinationProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  const parser = createWebhookHttpOrOpaqueDestinationParser(parserInput).preset;
  if (descriptor === null
    || !descriptor.registration_modes.includes('managed_endpoint')
    || !descriptor.managed_registration_requires_connection) {
    throw new Error(
      `webhook registration destination preset '${profile_id}' requires connection-bound managed registration`,
    );
  }
  const value = Object.freeze({ profile_id, parser });
  JSON.stringify(value);
  return value;
};

const DESTINATION_PROFILE_PRESET_LIST = [
  destinationProfilePreset('paddle.notification.v1', {
    kind: 'http_or_opaque_destination.v1',
    max_characters: 2_048,
    http_url_discriminator: 'url',
    opaque_discriminator: 'email',
  }),
] as const;

const mutableDestinationProfilePresets = Object.create(null) as Record<
  WebhookProfileId,
  WebhookRegistrationDestinationProfilePreset | undefined
>;
for (const value of DESTINATION_PROFILE_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(
    mutableDestinationProfilePresets,
    value.profile_id,
  )) {
    throw new Error(
      `duplicate webhook registration destination preset '${value.profile_id}'`,
    );
  }
  mutableDestinationProfilePresets[value.profile_id] = value;
}

export const WEBHOOK_REGISTRATION_DESTINATION_PROFILE_PRESETS: Readonly<
  Partial<Record<
    WebhookProfileId,
    WebhookRegistrationDestinationProfilePreset
  >>
> = Object.freeze(mutableDestinationProfilePresets);

export const webhookRegistrationDestinationProfilePreset = (
  profileId: WebhookProfileId,
): WebhookRegistrationDestinationProfilePreset | null =>
  WEBHOOK_REGISTRATION_DESTINATION_PROFILE_PRESETS[profileId] ?? null;
