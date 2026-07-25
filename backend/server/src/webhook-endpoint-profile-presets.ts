/** D-201 Slice 9AX — trusted endpoint-URL profile preset data.
 *
 * Generic control-plane policy and managed-registration composition select the
 * same serializable endpoint grammar here. Owner, marketplace, pack, and recipe
 * data cannot supply a port list, parser kind, URL template, or outbound target.
 */

import {
  webhookProfile,
  type WebhookProfileId,
} from '@recued/contracts';
import {
  createWebhookBoundedHttpsUrlParser,
  type WebhookBoundedHttpsUrlParserPreset,
} from './webhook-bounded-https-url-parser.js';

export interface WebhookEndpointProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly parser: WebhookBoundedHttpsUrlParserPreset;
}

const endpointProfilePreset = (
  profile_id: WebhookProfileId,
  parserInput: WebhookBoundedHttpsUrlParserPreset,
): WebhookEndpointProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  if (descriptor === null || descriptor.registration_modes.length === 0) {
    throw new Error(
      `webhook endpoint profile preset '${profile_id}' requires a registered profile`,
    );
  }
  const value = Object.freeze({
    profile_id,
    parser: createWebhookBoundedHttpsUrlParser(parserInput).preset,
  });
  JSON.stringify(value);
  return value;
};

const ENDPOINT_PROFILE_PRESET_LIST = [
  endpointProfilePreset('telegram.bot-webhook.v1', {
    kind: 'bounded_https_url.v1',
    max_bytes: 4_096,
    allowed_ports: [443, 80, 88, 8_443],
  }),
] as const;

const mutableEndpointProfilePresets = Object.create(null) as Record<
  WebhookProfileId,
  WebhookEndpointProfilePreset | undefined
>;
for (const value of ENDPOINT_PROFILE_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(
    mutableEndpointProfilePresets,
    value.profile_id,
  )) {
    throw new Error(`duplicate webhook endpoint profile preset '${value.profile_id}'`);
  }
  mutableEndpointProfilePresets[value.profile_id] = value;
}

export const WEBHOOK_ENDPOINT_PROFILE_PRESETS: Readonly<
  Partial<Record<WebhookProfileId, WebhookEndpointProfilePreset>>
> = Object.freeze(mutableEndpointProfilePresets);

export const webhookEndpointProfilePreset = (
  profileId: WebhookProfileId,
): WebhookEndpointProfilePreset | null =>
  WEBHOOK_ENDPOINT_PROFILE_PRESETS[profileId] ?? null;
