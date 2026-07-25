import { describe, expect, it } from 'vitest';

import type { WebhookClockHealthAuthority } from '../webhook-clock-health.js';
import { createBuiltinWebhookDeliveryProfileAdapters } from '../webhook-delivery-profile-presets.js';
import {
  WEBHOOK_TIMESTAMPED_HMAC_DELIVERY_PROFILE_PRESETS,
  webhookTimestampedHmacDeliveryProfilePreset,
} from '../webhook-delivery-engine-presets.js';
import { BUILTIN_WEBHOOK_PROFILE_POLICIES } from '../webhook-profile-policy.js';
import { validateStripeWebhookCredentialShape } from '../webhook-stripe-profile.js';
import {
  createTimestampedJsonSingleEventWebhookCredentialShapeValidator,
  createTimestampedJsonSingleEventWebhookProfileAdapter,
} from '../webhook-timestamped-json-single-event-profile.js';

const healthyClock: WebhookClockHealthAuthority = {
  check: async () => ({
    healthy: true,
    trusted_now_ms: 2_000_000_000_000,
    maximum_error_ms: 1_000,
    checked_at: 2_000_000_000_000,
  }),
};

describe('D-201 Slices 9D + 9E + 9AD timestamped JSON single-event composition', () => {
  it('selects the complete closed capability set and trusted runtime labels', () => {
    const preset = webhookTimestampedHmacDeliveryProfilePreset('stripe.event.v1');
    expect(preset).not.toBeNull();
    expect(preset).toMatchObject({
      profile_id: 'stripe.event.v1',
      decoder: { kind: 'bounded_json_object.v1' },
      form_decoder: null,
      form_json_envelope: null,
      flat_form_event_normalizer: null,
      handshake: null,
      event_projector: { kind: 'normalized_single_event.v1' },
      delivery_deduplicator: {
        kind: 'normalized_id_or_timestamp_body_sha256.v1',
      },
      event_normalizer: { kind: 'json_single_event_fields.v1' },
      environment_admission: { kind: 'json_boolean_environment_map.v1' },
      test_envelope: { kind: 'json_single_event_test_envelope.v1' },
      admission_method_label: 'stripe-signature-v1',
      runtime_error_label: 'Stripe webhook',
    });
    expect(Object.isFrozen(preset)).toBe(true);

    const adapter = createTimestampedJsonSingleEventWebhookProfileAdapter(
      'stripe.event.v1',
    );
    expect(adapter.profile_id).toBe('stripe.event.v1');
    expect(adapter.success_response).toEqual({ status: 200 });
    expect(adapter.buildTestDelivery).toBeTypeOf('function');

    expect(Object.values(WEBHOOK_TIMESTAMPED_HMAC_DELIVERY_PROFILE_PRESETS)
      .flatMap((candidate) => candidate !== undefined
        && (candidate.admission_method_label !== null
          || candidate.runtime_error_label !== null)
        ? [{
            profile_id: candidate.profile_id,
            admission_method_label: candidate.admission_method_label,
            runtime_error_label: candidate.runtime_error_label,
          }]
        : [])).toEqual([{
          profile_id: 'stripe.event.v1',
          admission_method_label: 'stripe-signature-v1',
          runtime_error_label: 'Stripe webhook',
        }, {
          profile_id: 'paddle.notification.v1',
          admission_method_label: 'paddle-hmac-sha256',
          runtime_error_label: null,
        }, {
          profile_id: 'slack.request.v0',
          admission_method_label: 'slack-signature-v0',
          runtime_error_label: 'Slack webhook',
        }]);
  });

  it('refuses partial, mixed-shape, and form-only timestamped presets', () => {
    for (const profileId of [
      'generic.timestamped-raw-body-hmac-sha256.v1',
      'paddle.notification.v1',
      'slack.request.v0',
      'slack.slash-command.v1',
    ] as const) {
      expect(() => createTimestampedJsonSingleEventWebhookProfileAdapter(profileId))
        .toThrow(`profile '${profileId}' is unavailable`);
      expect(() =>
        createTimestampedJsonSingleEventWebhookCredentialShapeValidator(profileId))
        .toThrow(`profile '${profileId}' is unavailable`);
    }
  });

  it('derives credential validation from the selected mechanism only', () => {
    const validate =
      createTimestampedJsonSingleEventWebhookCredentialShapeValidator(
        'stripe.event.v1',
      );
    expect(validate({ endpoint_secret: 'whsec_D201Slice9D123' })).toBe(true);
    expect(validate({
      endpoint_secret: 'whsec_D201Slice9D123',
      ignored_authority: 'must fail closed',
    })).toBe(false);
    expect(validate({ endpoint_secret: 'not-prefixed' })).toBe(false);

    const inherited = Object.create({
      endpoint_secret: 'whsec_D201Slice9D123',
    }) as Record<string, string>;
    expect(validate(inherited)).toBe(false);
  });

  it('mounts and validates Stripe directly through the neutral factories', () => {
    expect(createBuiltinWebhookDeliveryProfileAdapters(null)
      .map((adapter) => adapter.profile_id)).not.toContain('stripe.event.v1');

    const mounted = createBuiltinWebhookDeliveryProfileAdapters(healthyClock)
      .filter((adapter) => adapter.profile_id === 'stripe.event.v1');
    expect(mounted).toHaveLength(1);
    expect(mounted[0]).toMatchObject({
      profile_id: 'stripe.event.v1',
      success_response: { status: 200 },
      buildTestDelivery: expect.any(Function),
      verifyAndDecode: expect.any(Function),
    });
    expect(mounted[0]?.handleHandshake).toBeUndefined();

    const policy = BUILTIN_WEBHOOK_PROFILE_POLICIES.get('stripe.event.v1');
    const credentialFixtures: ReadonlyArray<Readonly<Record<string, string>>> = [
      { endpoint_secret: 'whsec_D201Slice9E123' },
      { endpoint_secret: 'not-prefixed' },
      {
        endpoint_secret: 'whsec_D201Slice9E123',
        ignored_authority: 'must fail closed',
      },
      {},
    ];
    for (const credentials of credentialFixtures) {
      expect(policy.validateCredentialShape(credentials)).toBe(
        validateStripeWebhookCredentialShape(credentials),
      );
    }

    let accessorReads = 0;
    const accessor = Object.defineProperty({}, 'endpoint_secret', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return 'whsec_D201Slice9E123';
      },
    }) as Record<string, string>;
    expect(policy.validateCredentialShape(accessor)).toBe(false);
    expect(accessorReads).toBe(0);
  });
});
