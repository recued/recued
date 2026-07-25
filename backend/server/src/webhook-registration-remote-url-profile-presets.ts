/** D-201 Slice 9AY — trusted managed-registration remote-URL profile data.
 *
 * Provider adapters select the same frozen, serializable read-back grammar
 * here. Owner, marketplace, pack, and recipe data cannot supply URL bounds,
 * schemes, templates, callbacks, or provider request authority.
 */

import {
  webhookProfile,
  type WebhookProfileId,
} from '@recued/contracts';
import {
  createWebhookBoundedHttpUrlParser,
  type WebhookBoundedHttpUrlParserPreset,
} from './webhook-bounded-http-url-parser.js';

export interface WebhookRegistrationRemoteUrlProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly parser: WebhookBoundedHttpUrlParserPreset;
}

const remoteUrlProfilePreset = (
  profile_id: WebhookProfileId,
  parserInput: WebhookBoundedHttpUrlParserPreset,
): WebhookRegistrationRemoteUrlProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  const parser = createWebhookBoundedHttpUrlParser(parserInput).preset;
  if (descriptor === null
    || !descriptor.registration_modes.includes('managed_endpoint')
    || !descriptor.managed_registration_requires_connection) {
    throw new Error(
      `webhook registration remote-URL preset '${profile_id}' requires connection-bound managed registration`,
    );
  }
  const value = Object.freeze({ profile_id, parser });
  JSON.stringify(value);
  return value;
};

const REMOTE_URL_PROFILE_PRESET_LIST = [
  remoteUrlProfilePreset('stripe.event.v1', {
    kind: 'bounded_http_url.v1',
    max_bytes: 4_096,
  }),
  remoteUrlProfilePreset('github.webhook.v1', {
    kind: 'bounded_http_url.v1',
    max_bytes: 4_096,
  }),
] as const;

const mutableRemoteUrlProfilePresets = Object.create(null) as Record<
  WebhookProfileId,
  WebhookRegistrationRemoteUrlProfilePreset | undefined
>;
for (const value of REMOTE_URL_PROFILE_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(
    mutableRemoteUrlProfilePresets,
    value.profile_id,
  )) {
    throw new Error(
      `duplicate webhook registration remote-URL preset '${value.profile_id}'`,
    );
  }
  mutableRemoteUrlProfilePresets[value.profile_id] = value;
}

export const WEBHOOK_REGISTRATION_REMOTE_URL_PROFILE_PRESETS: Readonly<
  Partial<Record<
    WebhookProfileId,
    WebhookRegistrationRemoteUrlProfilePreset
  >>
> = Object.freeze(mutableRemoteUrlProfilePresets);

export const webhookRegistrationRemoteUrlProfilePreset = (
  profileId: WebhookProfileId,
): WebhookRegistrationRemoteUrlProfilePreset | null =>
  WEBHOOK_REGISTRATION_REMOTE_URL_PROFILE_PRESETS[profileId] ?? null;
