import { describe, expect, it } from 'vitest';

import type { WebhookClockHealthAuthority } from '../webhook-clock-health.js';
import { createBuiltinWebhookDeliveryProfileAdapters } from '../webhook-delivery-profile-presets.js';
import {
  webhookJsonSingleNotificationProfilePreset,
  webhookPairedProviderIdProfilePreset,
  webhookRfc3339TimestampProfilePreset,
  webhookTimestampedHmacDeliveryProfilePreset,
} from '../webhook-delivery-engine-presets.js';
import {
  validatePaddleWebhookCredentialShape,
} from '../webhook-paddle-profile.js';
import { BUILTIN_WEBHOOK_PROFILE_POLICIES } from '../webhook-profile-policy.js';
import {
  webhookDotSegmentEventTypeProfilePreset,
  webhookJsonObjectProviderIdProfilePreset,
  webhookJsonRequiredObjectProfilePreset,
} from '../webhook-shared-profile-parser-presets.js';
import {
  createTimestampedJsonSingleNotificationWebhookCredentialShapeValidator,
  createTimestampedJsonSingleNotificationWebhookProfileAdapter,
} from '../webhook-timestamped-json-single-notification-profile.js';

const SECRET =
  'pdl_ntfset_01gkpjp8bkm3tm53kdgkx6sms7_6h3qd3uFSi9YCD3OLYAShQI90XTI5vEI';

const healthyClock: WebhookClockHealthAuthority = {
  check: async () => ({
    healthy: true,
    trusted_now_ms: 2_000_000_000_000,
    maximum_error_ms: 1_000,
    checked_at: 2_000_000_000_000,
  }),
};

describe('D-201 Slice 9O timestamped JSON single-notification composition', () => {
  it('selects one complete closed notification capability set', () => {
    const profileId = 'paddle.notification.v1';
    expect(webhookTimestampedHmacDeliveryProfilePreset(profileId))
      .toMatchObject({
        profile_id: profileId,
        decoder: { kind: 'bounded_json_object.v1' },
        form_decoder: null,
        form_json_envelope: null,
        flat_form_event_normalizer: null,
        handshake: null,
        event_projector: {
          kind: 'normalized_single_event.v1',
          occurred_at_unit: 'unix_milliseconds.v1',
        },
        delivery_deduplicator: {
          kind: 'normalized_paired_ids_sha256.v1',
        },
        event_normalizer: null,
        environment_admission: null,
        test_envelope: null,
        admission_method_label: 'paddle-hmac-sha256',
      });
    expect(webhookRfc3339TimestampProfilePreset(profileId)).not.toBeNull();
    expect(webhookPairedProviderIdProfilePreset(profileId)).not.toBeNull();
    expect(webhookDotSegmentEventTypeProfilePreset(profileId)).not.toBeNull();
    expect(webhookJsonObjectProviderIdProfilePreset(profileId)).not.toBeNull();
    expect(webhookJsonRequiredObjectProfilePreset(profileId)).not.toBeNull();
    expect(webhookJsonSingleNotificationProfilePreset(profileId)).not.toBeNull();

    const adapter = createTimestampedJsonSingleNotificationWebhookProfileAdapter(
      profileId,
    );
    expect(adapter).toMatchObject({
      profile_id: profileId,
      success_response: { status: 200 },
      verifyAndDecode: expect.any(Function),
    });
    expect(adapter.buildTestDelivery).toBeUndefined();
    expect(adapter.handleHandshake).toBeUndefined();
  });

  it('refuses partial, single-event, and form timestamped profiles', () => {
    for (const profileId of [
      'generic.timestamped-raw-body-hmac-sha256.v1',
      'stripe.event.v1',
      'slack.request.v0',
      'slack.slash-command.v1',
    ] as const) {
      expect(() =>
        createTimestampedJsonSingleNotificationWebhookProfileAdapter(profileId))
        .toThrow(`profile '${profileId}' is unavailable`);
      expect(() =>
        createTimestampedJsonSingleNotificationWebhookCredentialShapeValidator(
          profileId,
        )).toThrow(`profile '${profileId}' is unavailable`);
    }
  });

  it('derives credential validation from the selected mechanism only', () => {
    const validate =
      createTimestampedJsonSingleNotificationWebhookCredentialShapeValidator(
        'paddle.notification.v1',
      );
    const credentialFixtures: ReadonlyArray<Readonly<Record<string, string>>> = [
      { endpoint_secret_key: SECRET },
      { endpoint_secret_key: 'not-a-paddle-secret' },
      {
        endpoint_secret_key: SECRET,
        ignored_authority: 'must fail closed',
      },
      {},
    ];
    for (const credentials of credentialFixtures) {
      expect(validate(credentials)).toBe(
        validatePaddleWebhookCredentialShape(credentials),
      );
    }
    const inherited = Object.create({
      endpoint_secret_key: SECRET,
    }) as Record<string, string>;
    expect(validate(inherited)).toBe(false);
  });

  it('mounts and validates the profile directly through neutral factories', () => {
    expect(createBuiltinWebhookDeliveryProfileAdapters(null)
      .map((adapter) => adapter.profile_id))
      .not.toContain('paddle.notification.v1');
    const mounted = createBuiltinWebhookDeliveryProfileAdapters(healthyClock)
      .filter((adapter) => adapter.profile_id === 'paddle.notification.v1');
    expect(mounted).toHaveLength(1);
    expect(mounted[0]).toMatchObject({
      profile_id: 'paddle.notification.v1',
      success_response: { status: 200 },
      verifyAndDecode: expect.any(Function),
    });
    expect(mounted[0]?.buildTestDelivery).toBeUndefined();
    expect(mounted[0]?.handleHandshake).toBeUndefined();

    const policy = BUILTIN_WEBHOOK_PROFILE_POLICIES.get(
      'paddle.notification.v1',
    );
    expect(policy.validateCredentialShape({
      endpoint_secret_key: SECRET,
    })).toBe(true);
    expect(policy.validateCredentialShape({
      endpoint_secret_key: SECRET,
      ignored_authority: 'must fail closed',
    })).toBe(false);
  });
});
