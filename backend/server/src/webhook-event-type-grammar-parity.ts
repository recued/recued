/** D-201 Slice 10C — a runtime event-type parser admits exactly its profile's
 *  declared language.
 *
 *  An open event catalog names its grammar in the portable descriptor
 *  (`WebhookEventTypeCatalog.grammar`), and that grammar is what
 *  `webhookProfileAcceptsEventType` answers for pack and recipe validation,
 *  the ingress RPC, registration and Settings. Before 10C those callers
 *  admitted the broad `WEBHOOK_EVENT_TYPE_RE` for every open profile while each
 *  profile's runtime parser was narrower, so an owner could select an event the
 *  runtime would then reject. Every place that builds an event-type parser for
 *  a profile calls this; a preset that differs from the descriptor stops the
 *  server from starting rather than admitting a different set at runtime.
 *
 *  For a closed catalog the parser must take each listed value; the listener
 *  then keeps exactly those (`webhookProfileAcceptsEventType`). */

import {
  sameWebhookEventTypeGrammar,
  webhookProfile,
  type WebhookProfileId,
} from '@recued/contracts';
import { createWebhookAsciiEventTypeParser } from './webhook-ascii-event-type-parser.js';
import { createWebhookAsciiIdentifierParser } from './webhook-ascii-identifier-parser.js';
import { createWebhookLowercaseIdentifierEventTypeParser } from './webhook-lowercase-identifier-event-type-parser.js';
import { createWebhookDotSegmentEventTypeParser } from './webhook-dot-segment-event-type-parser.js';

/** The preset of one of the four server event-type parsers. */
export type WebhookEventTypeParserPresetData =
  | { kind: 'ascii_alphanumeric_dot_colon_slash_dash.v1'; max_bytes: number }
  | { kind: 'ascii_identifier.v1'; max_bytes: number }
  | { kind: 'lowercase_identifier_event_type.v1'; max_characters: number }
  | { kind: 'lowercase_json_member_event_type.v1'; max_characters: number }
  | {
      kind: 'lowercase_dot_segment_event_type.v1';
      segment_count: number;
      max_segment_characters: number;
    };

/** The server parser a preset selects. */
export const webhookEventTypeParserFor = (
  preset: WebhookEventTypeParserPresetData,
): { parse(value: unknown): string | null } => {
  switch (preset.kind) {
    case 'ascii_alphanumeric_dot_colon_slash_dash.v1':
      return createWebhookAsciiEventTypeParser(preset);
    case 'ascii_identifier.v1':
      return createWebhookAsciiIdentifierParser(preset);
    case 'lowercase_identifier_event_type.v1':
    case 'lowercase_json_member_event_type.v1':
      return createWebhookLowercaseIdentifierEventTypeParser(preset);
    case 'lowercase_dot_segment_event_type.v1':
      return createWebhookDotSegmentEventTypeParser(preset);
  }
};

/** Throws unless `preset` admits exactly `profileId`'s catalog language. */
export const assertWebhookEventTypeParserMatchesProfile = (
  profileId: WebhookProfileId,
  preset: WebhookEventTypeParserPresetData,
  label: string,
): void => {
  const descriptor = webhookProfile(profileId);
  if (descriptor === null) {
    throw new Error(`${label} '${profileId}': the profile is not registered`);
  }
  if (descriptor.event_types.kind === 'open') {
    if (!sameWebhookEventTypeGrammar(descriptor.event_types.grammar, { ...preset })) {
      throw new Error(
        `${label} '${profileId}' admits a different event-type language from its profile's grammar`,
      );
    }
    return;
  }
  const parser = webhookEventTypeParserFor(preset);
  if (descriptor.event_types.values.some((value) => parser.parse(value) === null)) {
    throw new Error(`${label} '${profileId}' does not admit its closed event catalog`);
  }
};
