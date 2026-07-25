/** D-201 Slice 9BC — trusted managed-registration access-token profiles.
 *
 * This role binds a connection-resolved access-token grammar to a
 * connection-bound managed-registration profile. It is separate from webhook
 * delivery/signing credentials, credential-kind attestation, and Bearer
 * transport. Owner, marketplace, pack, and recipe data cannot supply prefixes,
 * bounds, callbacks, credential paths, or outbound request authority.
 */

import {
  webhookProfile,
  type WebhookProfileId,
} from '@recued/contracts';
import {
  createWebhookPrefixSetPrintableAsciiTokenParser,
  type WebhookPrefixSetPrintableAsciiTokenParserPreset,
} from './webhook-prefix-set-printable-ascii-token-parser.js';

export interface WebhookRegistrationAccessTokenProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly parser: WebhookPrefixSetPrintableAsciiTokenParserPreset;
}

const accessTokenProfilePreset = (
  profile_id: WebhookProfileId,
  parserInput: WebhookPrefixSetPrintableAsciiTokenParserPreset,
): WebhookRegistrationAccessTokenProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  const parser = createWebhookPrefixSetPrintableAsciiTokenParser(
    parserInput,
  ).preset;
  if (descriptor === null
    || !descriptor.registration_modes.includes('managed_endpoint')
    || !descriptor.managed_registration_requires_connection) {
    throw new Error(
      `webhook registration access-token preset '${profile_id}' requires connection-bound managed registration`,
    );
  }
  const value = Object.freeze({ profile_id, parser });
  JSON.stringify(value);
  return value;
};

const ACCESS_TOKEN_PROFILE_PRESET_LIST = [
  accessTokenProfilePreset('github.webhook.v1', {
    kind: 'prefix_set_printable_ascii_token.v1',
    max_bytes: 4_096,
    prefixes: ['ghp_', 'github_pat_'],
  }),
] as const;

const mutableAccessTokenProfilePresets = Object.create(null) as Record<
  WebhookProfileId,
  WebhookRegistrationAccessTokenProfilePreset | undefined
>;
for (const value of ACCESS_TOKEN_PROFILE_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(
    mutableAccessTokenProfilePresets,
    value.profile_id,
  )) {
    throw new Error(
      `duplicate webhook registration access-token preset '${value.profile_id}'`,
    );
  }
  mutableAccessTokenProfilePresets[value.profile_id] = value;
}

export const WEBHOOK_REGISTRATION_ACCESS_TOKEN_PROFILE_PRESETS: Readonly<
  Partial<Record<
    WebhookProfileId,
    WebhookRegistrationAccessTokenProfilePreset
  >>
> = Object.freeze(mutableAccessTokenProfilePresets);

export const webhookRegistrationAccessTokenProfilePreset = (
  profileId: WebhookProfileId,
): WebhookRegistrationAccessTokenProfilePreset | null =>
  WEBHOOK_REGISTRATION_ACCESS_TOKEN_PROFILE_PRESETS[profileId] ?? null;
