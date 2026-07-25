/** D-201 Slices 8J + 8X + 9E + 9O + 9W + 9AC-9AD + 9BQ — trusted built-in delivery-profile composition.
 *
 * Boot installs this closed set as one unit. Vendor ids and their transitional
 * adapters stay out of generic listener composition while repeated protocol
 * families migrate onto reusable mechanism and decoder engines.
 */

import {
  createClockGatedTimestampedHmacWebhookProfileAdapter,
  createPrimitiveWebhookProfileAdapters,
} from './webhook-primitive-profiles.js';
import {
  createClockGatedTimestampedFormWebhookProfileAdapter,
} from './webhook-timestamped-form-profile.js';
import type { WebhookClockHealthAuthority } from './webhook-clock-health.js';
import type { WebhookIngressProfileAdapter } from './webhook-profile-runtime.js';
import {
  createClockGatedTimestampedJsonSingleEventWebhookProfileAdapter,
} from './webhook-timestamped-json-single-event-profile.js';
import {
  createClockGatedTimestampedJsonSingleNotificationWebhookProfileAdapter,
} from './webhook-timestamped-json-single-notification-profile.js';
import {
  createRawHeaderJsonSingleEventWebhookProfileAdapter,
} from './webhook-raw-header-json-single-event-profile.js';
import {
  createRawBodyJsonApiSingleEventWebhookProfileAdapter,
} from './webhook-raw-body-json-api-single-event-profile.js';
import {
  createStaticHeaderJsonSingleEventWebhookProfileAdapter,
} from './webhook-static-header-json-single-event-profile.js';
import {
  createClockGatedTimestampedJsonFormSingleEventWebhookProfileAdapter,
} from './webhook-timestamped-json-form-single-event-profile.js';

const ALWAYS_MOUNTED_PRIMITIVE_PROFILES = new Set([
  'generic.static-header-token.v1',
  'generic.http-basic.v1',
  'generic.raw-body-hmac-sha256.v1',
]);

export const createBuiltinWebhookDeliveryProfileAdapters = (
  clockAuthority: WebhookClockHealthAuthority | null,
): readonly WebhookIngressProfileAdapter[] => {
  const alwaysMounted: WebhookIngressProfileAdapter[] = [
    ...createPrimitiveWebhookProfileAdapters().filter((adapter) =>
      ALWAYS_MOUNTED_PRIMITIVE_PROFILES.has(adapter.profile_id)),
    createStaticHeaderJsonSingleEventWebhookProfileAdapter(
      'telegram.bot-webhook.v1',
    ),
    createRawHeaderJsonSingleEventWebhookProfileAdapter('github.webhook.v1'),
    createRawBodyJsonApiSingleEventWebhookProfileAdapter(
      'lemonsqueezy.webhook.v1',
    ),
  ];
  return clockAuthority === null
    ? alwaysMounted
    : [
        ...alwaysMounted,
        createClockGatedTimestampedHmacWebhookProfileAdapter(clockAuthority),
        createClockGatedTimestampedJsonSingleEventWebhookProfileAdapter(
          'stripe.event.v1',
          clockAuthority,
        ),
        createClockGatedTimestampedJsonSingleNotificationWebhookProfileAdapter(
          'paddle.notification.v1',
          clockAuthority,
        ),
        createClockGatedTimestampedJsonFormSingleEventWebhookProfileAdapter(
          'slack.request.v0',
          clockAuthority,
        ),
        createClockGatedTimestampedFormWebhookProfileAdapter(
          'slack.slash-command.v1',
          clockAuthority,
        ),
      ];
};
