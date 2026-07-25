/** D-201 Slices 9AJ-9AM — trusted registration idempotency-key profile data. */

import {
  webhookProfile,
  type WebhookProfileId,
} from '@recued/contracts';
import {
  createWebhookRegistrationIdempotencyKeyParser,
  type WebhookRegistrationIdempotencyKeyParserPreset,
} from './webhook-registration-idempotency-key-parser.js';

export interface WebhookRegistrationIdempotencyKeyProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly parser: WebhookRegistrationIdempotencyKeyParserPreset;
}

const idempotencyKeyProfilePreset = (
  profile_id: WebhookProfileId,
  parserInput: WebhookRegistrationIdempotencyKeyParserPreset,
): WebhookRegistrationIdempotencyKeyProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  const parser = createWebhookRegistrationIdempotencyKeyParser(parserInput).preset;
  if (descriptor === null
    || !descriptor.registration_modes.includes('managed_endpoint')
    || !descriptor.managed_registration_requires_connection) {
    throw new Error(
      `webhook registration idempotency-key preset '${profile_id}' requires connection-bound managed registration`,
    );
  }
  const value = Object.freeze({ profile_id, parser });
  JSON.stringify(value);
  return value;
};

const IDEMPOTENCY_KEY_PROFILE_PRESET_LIST = [
  idempotencyKeyProfilePreset(
    'stripe.event.v1',
    {
      kind: 'ascii_registration_idempotency_key.v1',
      max_characters: 255,
    },
  ),
  idempotencyKeyProfilePreset(
    'paddle.notification.v1',
    {
      kind: 'ascii_registration_idempotency_key.v1',
      max_characters: 255,
    },
  ),
  idempotencyKeyProfilePreset(
    'github.webhook.v1',
    {
      kind: 'ascii_registration_idempotency_key.v1',
      max_characters: 255,
    },
  ),
  idempotencyKeyProfilePreset(
    'telegram.bot-webhook.v1',
    {
      kind: 'ascii_registration_idempotency_key.v1',
      max_characters: 255,
    },
  ),
] as const;

const mutablePresets = Object.create(null) as Record<
  WebhookProfileId,
  WebhookRegistrationIdempotencyKeyProfilePreset | undefined
>;
for (const value of IDEMPOTENCY_KEY_PROFILE_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(mutablePresets, value.profile_id)) {
    throw new Error(
      `duplicate webhook registration idempotency-key preset '${value.profile_id}'`,
    );
  }
  mutablePresets[value.profile_id] = value;
}

export const WEBHOOK_REGISTRATION_IDEMPOTENCY_KEY_PROFILE_PRESETS: Readonly<
  Partial<Record<WebhookProfileId, WebhookRegistrationIdempotencyKeyProfilePreset>>
> = Object.freeze(mutablePresets);

export const webhookRegistrationIdempotencyKeyProfilePreset = (
  profileId: WebhookProfileId,
): WebhookRegistrationIdempotencyKeyProfilePreset | null =>
  WEBHOOK_REGISTRATION_IDEMPOTENCY_KEY_PROFILE_PRESETS[profileId] ?? null;
