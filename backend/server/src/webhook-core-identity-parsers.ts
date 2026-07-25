/** D-201 Slices 9BE-9BG — code-owned webhook core identity parsers.
 *
 * Internal ingress, delivery, event, and rejection identities are authority
 * minted by Recued, not vendor profile, owner, marketplace, pack, or recipe
 * configuration. Credential versions are likewise core-minted positive
 * integers rather than profile data. Core consumers share these compiled
 * parsers for existing admission boundaries without widening their roles.
 */

import {
  createWebhookBoundedPrefixedAsciiIdentifierParser,
} from './webhook-bounded-prefixed-ascii-identifier-parser.js';
import {
  createWebhookPositiveSafeIntegerTextParser,
} from './webhook-positive-safe-integer-text-parser.js';

export const WEBHOOK_INGRESS_ID_PARSER =
  createWebhookBoundedPrefixedAsciiIdentifierParser({
    kind: 'bounded_prefixed_ascii_identifier.v1',
    prefix: 'whi_',
    min_suffix_characters: 16,
    max_suffix_characters: 128,
  });

export const WEBHOOK_DELIVERY_ID_PARSER =
  createWebhookBoundedPrefixedAsciiIdentifierParser({
    kind: 'bounded_prefixed_ascii_identifier.v1',
    prefix: 'whd_',
    min_suffix_characters: 16,
    max_suffix_characters: 128,
  });

export const WEBHOOK_EVENT_ID_PARSER =
  createWebhookBoundedPrefixedAsciiIdentifierParser({
    kind: 'bounded_prefixed_ascii_identifier.v1',
    prefix: 'whe_',
    min_suffix_characters: 16,
    max_suffix_characters: 128,
  });

export const WEBHOOK_REJECTION_ID_PARSER =
  createWebhookBoundedPrefixedAsciiIdentifierParser({
    kind: 'bounded_prefixed_ascii_identifier.v1',
    prefix: 'whr_',
    min_suffix_characters: 16,
    max_suffix_characters: 128,
  });

export const WEBHOOK_CREDENTIAL_VERSION_PARSER =
  createWebhookPositiveSafeIntegerTextParser({
    kind: 'positive_safe_integer_text.v1',
    max_value: Number.MAX_SAFE_INTEGER,
  });
