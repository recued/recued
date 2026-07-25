/** D-201 Slice 9BA — trusted managed-registration connection-token profiles.
 *
 * This role describes structural admission for a token resolved from a paired
 * connection. It is separate from webhook delivery/signing credentials.
 * Owner, marketplace, pack, and recipe data cannot supply token bounds,
 * grammars, callbacks, credential paths, or outbound request authority.
 */

import {
  webhookProfile,
  type WebhookProfileId,
} from '@recued/contracts';
import {
  createWebhookDecimalColonAsciiTokenParser,
  type WebhookDecimalColonAsciiTokenParserPreset,
} from './webhook-decimal-colon-ascii-token-parser.js';

export interface WebhookRegistrationConnectionTokenProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly parser: WebhookDecimalColonAsciiTokenParserPreset;
}

const connectionTokenProfilePreset = (
  profile_id: WebhookProfileId,
  parserInput: WebhookDecimalColonAsciiTokenParserPreset,
): WebhookRegistrationConnectionTokenProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  const parser = createWebhookDecimalColonAsciiTokenParser(parserInput).preset;
  if (descriptor === null
    || !descriptor.registration_modes.includes('managed_endpoint')
    || !descriptor.managed_registration_requires_connection) {
    throw new Error(
      `webhook registration connection-token preset '${profile_id}' requires connection-bound managed registration`,
    );
  }
  const value = Object.freeze({ profile_id, parser });
  JSON.stringify(value);
  return value;
};

const CONNECTION_TOKEN_PROFILE_PRESET_LIST = [
  connectionTokenProfilePreset('telegram.bot-webhook.v1', {
    kind: 'decimal_colon_ascii_token.v1',
    max_digits: 32,
    max_suffix_characters: 256,
  }),
] as const;

const mutableConnectionTokenProfilePresets = Object.create(null) as Record<
  WebhookProfileId,
  WebhookRegistrationConnectionTokenProfilePreset | undefined
>;
for (const value of CONNECTION_TOKEN_PROFILE_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(
    mutableConnectionTokenProfilePresets,
    value.profile_id,
  )) {
    throw new Error(
      `duplicate webhook registration connection-token preset '${value.profile_id}'`,
    );
  }
  mutableConnectionTokenProfilePresets[value.profile_id] = value;
}

export const WEBHOOK_REGISTRATION_CONNECTION_TOKEN_PROFILE_PRESETS: Readonly<
  Partial<Record<
    WebhookProfileId,
    WebhookRegistrationConnectionTokenProfilePreset
  >>
> = Object.freeze(mutableConnectionTokenProfilePresets);

export const webhookRegistrationConnectionTokenProfilePreset = (
  profileId: WebhookProfileId,
): WebhookRegistrationConnectionTokenProfilePreset | null =>
  WEBHOOK_REGISTRATION_CONNECTION_TOKEN_PROFILE_PRESETS[profileId] ?? null;
