/** D-201 Slices 9AF-9AI — trusted registration-response profile preset data.
 *
 * This is the profile/vendor boundary for bounded provider response reading.
 * Registration adapters receive a compiled closed reader; packs, recipes, and
 * owner input cannot select response limits, diagnostics, decoders, or schemas.
 */

import {
  webhookProfile,
  type WebhookProfileId,
} from '@recued/contracts';
import {
  createWebhookRegistrationJsonResponseReader,
  type WebhookRegistrationJsonResponseReaderPreset,
} from './webhook-registration-json-response-reader.js';

export interface WebhookRegistrationResponseProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly reader: WebhookRegistrationJsonResponseReaderPreset;
}

const responseProfilePreset = (
  profile_id: WebhookProfileId,
  readerInput: WebhookRegistrationJsonResponseReaderPreset,
): WebhookRegistrationResponseProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  const reader = createWebhookRegistrationJsonResponseReader(readerInput).preset;
  if (descriptor === null
    || !descriptor.registration_modes.includes('managed_endpoint')
    || !descriptor.managed_registration_requires_connection) {
    throw new Error(
      `webhook registration-response preset '${profile_id}' requires connection-bound managed registration`,
    );
  }
  const value = Object.freeze({ profile_id, reader });
  JSON.stringify(value);
  return value;
};

const RESPONSE_PROFILE_PRESET_LIST = [
  responseProfilePreset(
    'github.webhook.v1',
    {
      kind: 'bounded_json_response.v1',
      max_bytes: 512 * 1024,
      error_label: 'GitHub webhook registration',
    },
  ),
  responseProfilePreset(
    'paddle.notification.v1',
    {
      kind: 'bounded_json_response.v1',
      max_bytes: 512 * 1024,
      error_label: 'Paddle webhook registration',
    },
  ),
  responseProfilePreset(
    'telegram.bot-webhook.v1',
    {
      kind: 'bounded_json_response.v1',
      max_bytes: 128 * 1024,
      error_label: 'Telegram webhook registration',
    },
  ),
  responseProfilePreset(
    'stripe.event.v1',
    {
      kind: 'bounded_json_response.v1',
      max_bytes: 512 * 1024,
      error_label: 'Stripe webhook registration',
    },
  ),
] as const;

const mutablePresets = Object.create(null) as Record<
  WebhookProfileId,
  WebhookRegistrationResponseProfilePreset | undefined
>;
for (const value of RESPONSE_PROFILE_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(mutablePresets, value.profile_id)) {
    throw new Error(
      `duplicate webhook registration-response preset '${value.profile_id}'`,
    );
  }
  mutablePresets[value.profile_id] = value;
}

export const WEBHOOK_REGISTRATION_RESPONSE_PROFILE_PRESETS: Readonly<
  Partial<Record<WebhookProfileId, WebhookRegistrationResponseProfilePreset>>
> = Object.freeze(mutablePresets);

export const webhookRegistrationResponseProfilePreset = (
  profileId: WebhookProfileId,
): WebhookRegistrationResponseProfilePreset | null =>
  WEBHOOK_REGISTRATION_RESPONSE_PROFILE_PRESETS[profileId] ?? null;
