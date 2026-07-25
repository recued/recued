import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

const source = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');

const VENDOR_PROFILE_IDS = [
  'stripe.event.v1',
  'paddle.notification.v1',
  'slack.request.v0',
  'slack.slash-command.v1',
  'telegram.bot-webhook.v1',
  'github.webhook.v1',
  'lemonsqueezy.webhook.v1',
] as const;
const VENDOR_NAMES = [
  'stripe',
  'paddle',
  'slack',
  'telegram',
  'github',
  'lemonsqueezy',
] as const;

describe('D-201 Slices 8J-9BK profile-generalization boundary', () => {
  it('keeps vendor ids out of generic control-plane, reconciliation, boot, and UI code', () => {
    const genericFiles = [
      'backend/server/src/webhook-ingress-handler.ts',
      'backend/server/src/webhook-registration-reconciler.ts',
      'backend/server/src/serve/compose-listeners.ts',
      'apps/webclient/src/connections/webhooks-panel.ts',
    ];
    for (const path of genericFiles) {
      const text = source(path);
      for (const profileId of VENDOR_PROFILE_IDS) {
        expect(text, `${path} must dispatch '${profileId}' through profile settings`)
          .not.toContain(profileId);
      }
    }
  });

  it('keeps vendor helpers and presentation branches out of generic webhook consumers', () => {
    for (const path of [
      'backend/server/src/webhook-ingress-handler.ts',
      'backend/server/src/webhook-registration-reconciler.ts',
      'apps/webclient/src/connections/webhooks-panel.ts',
    ]) {
      const text = source(path).toLowerCase();
      for (const vendor of VENDOR_NAMES) {
        expect(text, `${path} must not name vendor '${vendor}'`).not.toContain(vendor);
      }
    }

    const composer = source('backend/server/src/serve/compose-listeners.ts');
    for (const fragment of [
      'webhook-stripe-profile',
      'webhook-paddle-profile',
      'webhook-slack-profile',
      'webhook-telegram-profile',
      'webhook-github-profile',
      'stripe-webhook-registration',
      'paddle-webhook-registration',
      'telegram-webhook-registration',
      'github-webhook-registration',
      'telegram-webhook-protocol',
      'github-webhook-registration-target',
    ]) {
      expect(composer, `generic webhook composition must not import '${fragment}'`)
        .not.toContain(fragment);
    }
  });

  it('localizes trusted vendor presets outside generic consumers', () => {
    const ownerSettings = source(
      'packages/contracts/src/webhook-owner-profile-settings.ts',
    );
    const controlPlanePolicy = source(
      'backend/server/src/webhook-profile-policy.ts',
    );
    const deliveryPresets = source(
      'backend/server/src/webhook-delivery-profile-presets.ts',
    );
    const deliveryEnginePresets = source(
      'backend/server/src/webhook-delivery-engine-presets.ts',
    );
    const jsonApiProfilePresets = source(
      'backend/server/src/webhook-json-api-single-event-profile-presets.ts',
    );
    const sharedParserPresets = source(
      'backend/server/src/webhook-shared-profile-parser-presets.ts',
    );
    const registrationPresets = source(
      'backend/server/src/webhook-registration-profile-presets.ts',
    );
    const registrationTargetPresets = source(
      'backend/server/src/webhook-registration-target-profile-presets.ts',
    );
    const registrationResponsePresets = source(
      'backend/server/src/webhook-registration-response-profile-presets.ts',
    );
    const registrationIdempotencyKeyPresets = source(
      'backend/server/src/webhook-registration-idempotency-key-profile-presets.ts',
    );
    const endpointProfilePresets = source(
      'backend/server/src/webhook-endpoint-profile-presets.ts',
    );
    const registrationRemoteUrlPresets = source(
      'backend/server/src/webhook-registration-remote-url-profile-presets.ts',
    );
    const registrationDestinationPresets = source(
      'backend/server/src/webhook-registration-destination-profile-presets.ts',
    );
    const registrationConnectionTokenPresets = source(
      'backend/server/src/webhook-registration-connection-token-profile-presets.ts',
    );
    const registrationEnvironmentTokenPresets = source(
      'backend/server/src/webhook-registration-environment-token-profile-presets.ts',
    );
    const registrationAccessTokenPresets = source(
      'backend/server/src/webhook-registration-access-token-profile-presets.ts',
    );
    for (const profileId of VENDOR_PROFILE_IDS) {
      expect(ownerSettings).toContain(profileId);
      expect(controlPlanePolicy).toContain(profileId);
    }
    expect(ownerSettings).not.toContain("'whi_'");
    expect(controlPlanePolicy)
      .toContain('createTimestampedFormWebhookCredentialShapeValidator');
    expect(controlPlanePolicy)
      .toContain('createTimestampedJsonFormSingleEventWebhookCredentialShapeValidator');
    expect(controlPlanePolicy)
      .toContain('createTimestampedJsonSingleEventWebhookCredentialShapeValidator');
    expect(controlPlanePolicy)
      .toContain('createTimestampedJsonSingleNotificationWebhookCredentialShapeValidator');
    expect(controlPlanePolicy)
      .toContain('createRawHeaderJsonSingleEventWebhookCredentialShapeValidator');
    expect(controlPlanePolicy)
      .toContain('createStaticHeaderJsonSingleEventWebhookCredentialShapeValidator');
    expect(controlPlanePolicy).not.toContain('webhook-stripe-profile');
    expect(controlPlanePolicy).not.toContain('validateStripeWebhookCredentialShape');
    expect(controlPlanePolicy).not.toContain('webhook-paddle-profile');
    expect(controlPlanePolicy).not.toContain('validatePaddleWebhookCredentialShape');
    expect(controlPlanePolicy).not.toContain('webhook-github-profile');
    expect(controlPlanePolicy).not.toContain('validateGitHubWebhookCredentialShape');
    expect(controlPlanePolicy).not.toContain('webhook-telegram-profile');
    expect(controlPlanePolicy).not.toContain('validateTelegramWebhookCredentialShape');
    expect(controlPlanePolicy).not.toContain('webhook-slack-profile');
    expect(controlPlanePolicy).not.toContain('validateSlackWebhookCredentialShape');
    expect(controlPlanePolicy)
      .toContain('createWebhookAccountResourceRegistrationTargetNormalizer');
    expect(controlPlanePolicy)
      .toContain('webhookRegistrationTargetProfilePreset');
    expect(controlPlanePolicy)
      .not.toContain('github-webhook-registration-target');
    expect(controlPlanePolicy)
      .not.toContain('canonicalGitHubWebhookRegistrationTarget');
    expect(controlPlanePolicy).not.toContain("kind: 'repository'");
    expect(controlPlanePolicy).not.toContain("kind: 'organization'");
    expect(controlPlanePolicy)
      .not.toContain('GitHub managed registration requires registration_target');
    expect(controlPlanePolicy).toContain('webhookEndpointProfilePreset');
    expect(controlPlanePolicy).toContain('createWebhookBoundedHttpsUrlParser');
    expect(controlPlanePolicy).not.toContain('telegram-webhook-protocol');
    expect(controlPlanePolicy)
      .not.toContain('isTelegramWebhookEndpointSupported');
    expect(deliveryEnginePresets).toContain('generic.raw-body-hmac-sha256.v1');
    expect(deliveryEnginePresets).toContain('github.webhook.v1');
    expect(deliveryEnginePresets).toContain('lemonsqueezy.webhook.v1');
    expect(jsonApiProfilePresets).toContain('lemonsqueezy.webhook.v1');
    expect(jsonApiProfilePresets)
      .toContain("kind: 'json_api_single_event.v1'");
    expect(jsonApiProfilePresets)
      .toContain("kind: 'received_at_body_sha256_window.v1'");
    expect(deliveryEnginePresets)
      .toContain('generic.timestamped-raw-body-hmac-sha256.v1');
    expect(deliveryEnginePresets).toContain('stripe.event.v1');
    expect(deliveryEnginePresets)
      .toContain('webhookBoundedAsciiCredentialProfilePreset');
    expect(deliveryEnginePresets)
      .toContain('webhookFixedLengthAsciiCredentialProfilePreset');
    expect(deliveryEnginePresets)
      .toContain('webhookPrefixedAsciiCredentialProfilePreset');
    expect(deliveryEnginePresets)
      .toContain('webhookSegmentedAsciiCredentialProfilePreset');
    expect(deliveryEnginePresets).toContain('paddle.notification.v1');
    expect(deliveryEnginePresets).toContain('slack.request.v0');
    expect(deliveryEnginePresets).toContain('slack.slash-command.v1');
    expect(sharedParserPresets).toContain('paddle.notification.v1');
    expect(sharedParserPresets).toContain('github.webhook.v1');
    expect(sharedParserPresets)
      .toContain("kind: 'canonical_uuid_hex.v1'");
    expect(sharedParserPresets)
      .toContain("kind: 'positive_decimal_identifier.v1'");
    expect(sharedParserPresets)
      .toContain('webhookPositiveDecimalStructuralEvidenceProfilePreset');
    expect(sharedParserPresets)
      .toContain('webhookPositiveDecimalRegistrationRemoteIdProfilePreset');
    expect(sharedParserPresets).toContain('max_digits: 20');
    expect(sharedParserPresets)
      .toContain('webhookFixedPrefixRegistrationRemoteIdProfilePreset');
    expect(sharedParserPresets).toContain("prefix: 'ntfset_'");
    expect(sharedParserPresets)
      .toContain('webhookBoundedPrefixRegistrationRemoteIdProfilePreset');
    expect(sharedParserPresets)
      .toContain("kind: 'fixed_prefix_ascii_alphanumeric_id.v1'");
    expect(sharedParserPresets).toContain("prefix: 'we_'");
    expect(sharedParserPresets)
      .toContain('webhookPrefixedPositiveDecimalRegistrationRemoteIdProfilePreset');
    expect(sharedParserPresets)
      .toContain("kind: 'fixed_prefix_positive_decimal_id.v1'");
    expect(sharedParserPresets).toContain("prefix: 'telegram_bot_'");
    expect(sharedParserPresets)
      .toContain('webhookAsciiIdentifierEventTypeProfilePreset');
    expect(sharedParserPresets).toContain("kind: 'ascii_identifier.v1'");
    expect(sharedParserPresets)
      .toContain('webhookAsciiEventTypeProfilePreset');
    expect(sharedParserPresets)
      .toContain("kind: 'ascii_alphanumeric_dot_colon_slash_dash.v1'");
    expect(sharedParserPresets)
      .toContain('webhookBoundedAsciiCredentialProfilePreset');
    expect(sharedParserPresets)
      .toContain("kind: 'bounded_ascii_token.v1'");
    expect(sharedParserPresets).toContain('max_characters: 256');
    expect(sharedParserPresets)
      .toContain('webhookFixedLengthAsciiCredentialProfilePreset');
    expect(sharedParserPresets)
      .toContain("kind: 'fixed_length_ascii_token.v1'");
    expect(sharedParserPresets).toContain('characters: 43');
    expect(sharedParserPresets)
      .toContain('webhookPrefixedAsciiCredentialProfilePreset');
    expect(sharedParserPresets)
      .toContain("kind: 'prefixed_ascii_token.v1'");
    expect(sharedParserPresets).toContain("prefix: 'whsec_'");
    expect(sharedParserPresets)
      .toContain('webhookSegmentedAsciiCredentialProfilePreset');
    expect(sharedParserPresets)
      .toContain("kind: 'segmented_ascii_token.v1'");
    expect(sharedParserPresets).toContain("prefix: 'pdl_ntfset_'");
    expect(sharedParserPresets)
      .toContain("kind: 'lowercase_identifier_event_type.v1'");
    expect(sharedParserPresets)
      .toContain("kind: 'lowercase_dot_segment_event_type.v1'");
    expect(sharedParserPresets)
      .toContain("kind: 'optional_json_object_provider_id.v1'");
    expect(sharedParserPresets).toContain("field: 'id'");
    expect(sharedParserPresets)
      .toContain("kind: 'required_json_object_field.v1'");
    expect(sharedParserPresets).toContain("field: 'data'");
    expect(deliveryPresets).toContain('slack.slash-command.v1');
    expect(deliveryPresets).toContain('createBuiltinWebhookDeliveryProfileAdapters');
    expect(deliveryPresets)
      .toContain('createClockGatedTimestampedFormWebhookProfileAdapter');
    expect(deliveryPresets)
      .toContain('createClockGatedTimestampedJsonFormSingleEventWebhookProfileAdapter');
    expect(deliveryPresets)
      .toContain('createClockGatedTimestampedJsonSingleEventWebhookProfileAdapter');
    expect(deliveryPresets)
      .toContain('createClockGatedTimestampedJsonSingleNotificationWebhookProfileAdapter');
    expect(deliveryPresets)
      .toContain('createRawHeaderJsonSingleEventWebhookProfileAdapter');
    expect(deliveryPresets)
      .toContain('createRawBodyJsonApiSingleEventWebhookProfileAdapter');
    expect(deliveryPresets)
      .toContain('createStaticHeaderJsonSingleEventWebhookProfileAdapter');
    expect(deliveryPresets).not.toContain('webhook-stripe-profile');
    expect(deliveryPresets)
      .not.toContain('createClockGatedStripeWebhookProfileAdapter');
    expect(deliveryPresets).not.toContain('webhook-paddle-profile');
    expect(deliveryPresets)
      .not.toContain('createClockGatedPaddleWebhookProfileAdapter');
    expect(deliveryPresets).not.toContain('webhook-github-profile');
    expect(deliveryPresets).not.toContain('createGitHubWebhookProfileAdapter');
    expect(deliveryPresets).not.toContain('webhook-telegram-profile');
    expect(deliveryPresets).not.toContain('createTelegramWebhookProfileAdapter');
    expect(deliveryPresets).not.toContain('webhook-slack-profile');
    expect(deliveryPresets)
      .not.toContain('createClockGatedSlackWebhookProfileAdapter');
    expect(registrationPresets)
      .toContain('createBuiltinWebhookRegistrationProfileRegistry');
    expect(registrationPresets)
      .toContain('createWebhookAccountResourceRegistrationTargetNormalizer');
    expect(registrationPresets)
      .toContain('webhookRegistrationTargetProfilePreset');
    expect(registrationPresets)
      .not.toContain('canonicalGitHubWebhookRegistrationTarget');
    expect(registrationPresets)
      .toContain('createWebhookRegistrationJsonResponseReader');
    expect(registrationPresets)
      .toContain('webhookRegistrationResponseProfilePreset');
    expect(registrationPresets)
      .toContain('createWebhookRegistrationIdempotencyKeyParser');
    expect(registrationPresets)
      .toContain('webhookRegistrationIdempotencyKeyProfilePreset');
    expect(registrationPresets)
      .toContain('createWebhookPositiveDecimalIdentifierParser');
    expect(registrationPresets)
      .toContain('webhookPositiveDecimalRegistrationRemoteIdProfilePreset');
    expect(registrationPresets)
      .toContain('createWebhookFixedPrefixProviderIdParser');
    expect(registrationPresets)
      .toContain('webhookFixedPrefixRegistrationRemoteIdProfilePreset');
    expect(registrationPresets)
      .toContain('createWebhookBoundedPrefixProviderIdParser');
    expect(registrationPresets)
      .toContain('webhookBoundedPrefixRegistrationRemoteIdProfilePreset');
    expect(registrationPresets)
      .toContain('createWebhookPrefixedPositiveDecimalIdCodec');
    expect(registrationPresets)
      .toContain('webhookPrefixedPositiveDecimalRegistrationRemoteIdProfilePreset');
    expect(registrationPresets).toContain('createWebhookAsciiIdentifierParser');
    expect(registrationPresets)
      .toContain('webhookAsciiIdentifierEventTypeProfilePreset');
    expect(registrationPresets).toContain('createWebhookAsciiEventTypeParser');
    expect(registrationPresets)
      .toContain('webhookAsciiEventTypeProfilePreset');
    expect(registrationPresets)
      .toContain('createWebhookBoundedAsciiTokenParser');
    expect(registrationPresets)
      .toContain('webhookBoundedAsciiCredentialProfilePreset');
    expect(registrationPresets)
      .toContain('telegramCredentialPreset.credential_field');
    expect(registrationPresets)
      .toContain('createWebhookFixedLengthAsciiTokenParser');
    expect(registrationPresets)
      .toContain('webhookFixedLengthAsciiCredentialProfilePreset');
    expect(registrationPresets)
      .toContain('githubCredentialPreset.credential_field');
    expect(registrationPresets)
      .toContain('createWebhookPrefixedAsciiTokenParser');
    expect(registrationPresets)
      .toContain('webhookPrefixedAsciiCredentialProfilePreset');
    expect(registrationPresets)
      .toContain('createWebhookSegmentedAsciiTokenParser');
    expect(registrationPresets)
      .toContain('webhookSegmentedAsciiCredentialProfilePreset');
    expect(registrationPresets).toContain('webhookEndpointProfilePreset');
    expect(registrationPresets)
      .toContain('createWebhookBoundedHttpsUrlParser');
    expect(registrationPresets)
      .toContain('endpointParser: telegramRegistrationEndpointParser');
    expect(registrationPresets)
      .toContain('webhookRegistrationRemoteUrlProfilePreset');
    expect(registrationPresets)
      .toContain('createWebhookBoundedHttpUrlParser');
    expect(registrationPresets)
      .toContain('remoteUrlParser: stripeRegistrationRemoteUrlParser');
    expect(registrationPresets)
      .toContain('remoteUrlParser: githubRegistrationRemoteUrlParser');
    expect(registrationPresets)
      .toContain('webhookRegistrationDestinationProfilePreset');
    expect(registrationPresets)
      .toContain('createWebhookHttpOrOpaqueDestinationParser');
    expect(registrationPresets)
      .toContain('destinationParser: paddleRegistrationDestinationParser');
    expect(registrationPresets)
      .toContain('webhookRegistrationConnectionTokenProfilePreset');
    expect(registrationPresets)
      .toContain('createWebhookDecimalColonAsciiTokenParser');
    expect(registrationPresets)
      .toContain('connectionTokenParser: telegramRegistrationConnectionTokenParser');
    expect(registrationPresets)
      .toContain('webhookRegistrationEnvironmentTokenProfilePreset');
    expect(registrationPresets)
      .toContain('createWebhookEnvironmentMappedPrefixedAsciiTokenClassifier');
    expect(registrationPresets)
      .toContain('apiKeyClassifier: stripeRegistrationApiKeyClassifier');
    expect(registrationPresets)
      .toContain('createWebhookEnvironmentMappedSegmentedAsciiTokenClassifier');
    expect(registrationPresets)
      .toContain('apiKeyClassifier: paddleRegistrationApiKeyClassifier');
    expect(registrationPresets)
      .toContain('paddleRegistrationApiKeyClassifier.classify(auth.token)');
    expect(registrationPresets).toContain('api_key: apiKey');
    expect(registrationPresets).not.toContain('paddleApiKeyEnvironment');
    expect(registrationPresets)
      .toContain('webhookRegistrationAccessTokenProfilePreset');
    expect(registrationPresets)
      .toContain('createWebhookPrefixSetPrintableAsciiTokenParser');
    expect(registrationPresets)
      .toContain('accessTokenParser: githubRegistrationAccessTokenParser');
    expect(registrationPresets)
      .toContain('githubRegistrationAccessTokenParser.parse(auth.token)');
    expect(registrationPresets).toContain('access_token: accessToken');
    expect(registrationPresets)
      .not.toContain('hasGitHubPersonalAccessTokenPrefix');
    expect(registrationTargetPresets).toContain('github.webhook.v1');
    expect(registrationTargetPresets)
      .toContain("kind: 'account_or_account_resource.v1'");
    expect(registrationTargetPresets).toContain("account_kind: 'organization'");
    expect(registrationTargetPresets).toContain("resource_kind: 'repository'");
    expect(registrationResponsePresets).toContain('github.webhook.v1');
    expect(registrationResponsePresets)
      .toContain("kind: 'bounded_json_response.v1'");
    expect(registrationResponsePresets).toContain('max_bytes: 512 * 1024');
    expect(registrationResponsePresets)
      .toContain("error_label: 'GitHub webhook registration'");
    expect(registrationResponsePresets).toContain('paddle.notification.v1');
    expect(registrationResponsePresets)
      .toContain("error_label: 'Paddle webhook registration'");
    expect(registrationResponsePresets).toContain('telegram.bot-webhook.v1');
    expect(registrationResponsePresets).toContain('max_bytes: 128 * 1024');
    expect(registrationResponsePresets)
      .toContain("error_label: 'Telegram webhook registration'");
    expect(registrationResponsePresets).toContain('stripe.event.v1');
    expect(registrationResponsePresets)
      .toContain("error_label: 'Stripe webhook registration'");
    expect(registrationIdempotencyKeyPresets).toContain('stripe.event.v1');
    expect(registrationIdempotencyKeyPresets)
      .toContain('paddle.notification.v1');
    expect(registrationIdempotencyKeyPresets)
      .toContain('github.webhook.v1');
    expect(registrationIdempotencyKeyPresets)
      .toContain('telegram.bot-webhook.v1');
    expect(registrationIdempotencyKeyPresets)
      .toContain("kind: 'ascii_registration_idempotency_key.v1'");
    expect(registrationIdempotencyKeyPresets)
      .toContain('max_characters: 255');
    expect(endpointProfilePresets).toContain('telegram.bot-webhook.v1');
    expect(endpointProfilePresets).toContain("kind: 'bounded_https_url.v1'");
    expect(endpointProfilePresets).toContain('max_bytes: 4_096');
    expect(endpointProfilePresets)
      .toContain('allowed_ports: [443, 80, 88, 8_443]');
    expect(registrationRemoteUrlPresets).toContain('stripe.event.v1');
    expect(registrationRemoteUrlPresets).toContain('github.webhook.v1');
    expect(registrationRemoteUrlPresets)
      .toContain("kind: 'bounded_http_url.v1'");
    expect(registrationRemoteUrlPresets).toContain('max_bytes: 4_096');
    expect(registrationRemoteUrlPresets)
      .not.toContain('paddle.notification.v1');
    expect(registrationDestinationPresets).toContain('paddle.notification.v1');
    expect(registrationDestinationPresets)
      .toContain("kind: 'http_or_opaque_destination.v1'");
    expect(registrationDestinationPresets).toContain('max_characters: 2_048');
    expect(registrationDestinationPresets)
      .toContain("http_url_discriminator: 'url'");
    expect(registrationDestinationPresets)
      .toContain("opaque_discriminator: 'email'");
    expect(registrationDestinationPresets).not.toContain('stripe.event.v1');
    expect(registrationDestinationPresets).not.toContain('github.webhook.v1');
    expect(registrationConnectionTokenPresets)
      .toContain('telegram.bot-webhook.v1');
    expect(registrationConnectionTokenPresets)
      .toContain("kind: 'decimal_colon_ascii_token.v1'");
    expect(registrationConnectionTokenPresets).toContain('max_digits: 32');
    expect(registrationConnectionTokenPresets)
      .toContain('max_suffix_characters: 256');
    expect(registrationConnectionTokenPresets).not.toContain('stripe.event.v1');
    expect(registrationConnectionTokenPresets)
      .not.toContain('paddle.notification.v1');
    expect(registrationConnectionTokenPresets).not.toContain('github.webhook.v1');
    expect(registrationEnvironmentTokenPresets).toContain('stripe.event.v1');
    expect(registrationEnvironmentTokenPresets)
      .toContain("kind: 'environment_mapped_prefixed_ascii_token.v1'");
    expect(registrationEnvironmentTokenPresets).toContain('max_bytes: 512');
    expect(registrationEnvironmentTokenPresets).toContain("prefix: 'sk_test_'");
    expect(registrationEnvironmentTokenPresets).toContain("prefix: 'rk_test_'");
    expect(registrationEnvironmentTokenPresets).toContain("prefix: 'sk_live_'");
    expect(registrationEnvironmentTokenPresets).toContain("prefix: 'rk_live_'");
    expect(registrationEnvironmentTokenPresets)
      .toContain('paddle.notification.v1');
    expect(registrationEnvironmentTokenPresets)
      .toContain("kind: 'environment_mapped_segmented_ascii_token.v1'");
    expect(registrationEnvironmentTokenPresets).toContain("separator: '_'");
    expect(registrationEnvironmentTokenPresets)
      .toContain("{ length: 26, alphabet: 'lowercase_alphanumeric' }");
    expect(registrationEnvironmentTokenPresets)
      .toContain("{ length: 22, alphabet: 'ascii_alphanumeric' }");
    expect(registrationEnvironmentTokenPresets)
      .toContain("{ length: 3, alphabet: 'ascii_alphanumeric' }");
    expect(registrationEnvironmentTokenPresets)
      .toContain("prefix: 'pdl_sdbx_apikey_'");
    expect(registrationEnvironmentTokenPresets)
      .toContain("prefix: 'pdl_live_apikey_'");
    expect(registrationEnvironmentTokenPresets).not.toContain('github.webhook.v1');
    expect(registrationEnvironmentTokenPresets)
      .not.toContain('telegram.bot-webhook.v1');
    expect(registrationAccessTokenPresets).toContain('github.webhook.v1');
    expect(registrationAccessTokenPresets)
      .toContain("kind: 'prefix_set_printable_ascii_token.v1'");
    expect(registrationAccessTokenPresets).toContain('max_bytes: 4_096');
    expect(registrationAccessTokenPresets).toContain("'ghp_'");
    expect(registrationAccessTokenPresets).toContain("'github_pat_'");
    expect(registrationAccessTokenPresets).not.toContain('stripe.event.v1');
    expect(registrationAccessTokenPresets)
      .not.toContain('paddle.notification.v1');
    expect(registrationAccessTokenPresets)
      .not.toContain('telegram.bot-webhook.v1');
  });

  it('keeps shared mechanism, decoder, projection, and registration engines vendor-neutral', () => {
    for (const path of [
      'backend/server/src/webhook-raw-body-hmac-engine.ts',
      'backend/server/src/webhook-static-header-token-engine.ts',
      'backend/server/src/webhook-timestamped-hmac-engine.ts',
      'backend/server/src/webhook-json-object-decoder.ts',
      'backend/server/src/webhook-form-urlencoded-decoder.ts',
      'backend/server/src/webhook-form-wrapped-json-decoder.ts',
      'backend/server/src/webhook-flat-form-event-normalizer.ts',
      'backend/server/src/webhook-json-challenge-projector.ts',
      'backend/server/src/webhook-normalized-event-projector.ts',
      'backend/server/src/webhook-normalized-delivery-deduplicator.ts',
      'backend/server/src/webhook-json-event-normalizer.ts',
      'backend/server/src/webhook-json-environment-admission.ts',
      'backend/server/src/webhook-json-single-event-test-envelope.ts',
      'backend/server/src/webhook-rfc3339-timestamp-parser.ts',
      'backend/server/src/webhook-ascii-event-type-parser.ts',
      'backend/server/src/webhook-ascii-identifier-parser.ts',
      'backend/server/src/webhook-fixed-prefix-provider-id-parser.ts',
      'backend/server/src/webhook-bounded-prefix-provider-id-parser.ts',
      'backend/server/src/webhook-prefixed-positive-decimal-id-codec.ts',
      'backend/server/src/webhook-bounded-ascii-token-parser.ts',
      'backend/server/src/webhook-bounded-http-url-parser.ts',
      'backend/server/src/webhook-bounded-https-url-parser.ts',
      'backend/server/src/webhook-http-or-opaque-destination-parser.ts',
      'backend/server/src/webhook-decimal-colon-ascii-token-parser.ts',
      'backend/server/src/webhook-environment-mapped-prefixed-ascii-token-classifier.ts',
      'backend/server/src/webhook-environment-mapped-segmented-ascii-token-classifier.ts',
      'backend/server/src/webhook-bounded-prefixed-ascii-identifier-parser.ts',
      'backend/server/src/webhook-core-identity-parsers.ts',
      'backend/server/src/webhook-prefix-set-printable-ascii-token-parser.ts',
      'backend/server/src/webhook-fixed-length-ascii-token-parser.ts',
      'backend/server/src/webhook-prefixed-ascii-token-parser.ts',
      'backend/server/src/webhook-segmented-ascii-token-parser.ts',
      'backend/server/src/webhook-dot-segment-event-type-parser.ts',
      'backend/server/src/webhook-json-object-provider-id-extractor.ts',
      'backend/server/src/webhook-json-required-object-extractor.ts',
      'backend/server/src/webhook-json-single-notification-normalizer.ts',
      'backend/server/src/webhook-json-single-member-event-normalizer.ts',
      'backend/server/src/webhook-canonical-uuid-parser.ts',
      'backend/server/src/webhook-lowercase-identifier-event-type-parser.ts',
      'backend/server/src/webhook-positive-decimal-identifier-parser.ts',
      'backend/server/src/webhook-raw-header-single-event-metadata-normalizer.ts',
      'backend/server/src/webhook-metadata-payload-single-event-normalizer.ts',
      'backend/server/src/webhook-json-api-single-event-normalizer.ts',
      'backend/server/src/webhook-received-at-body-deduplicator.ts',
      'backend/server/src/webhook-raw-header-json-single-event-test-envelope.ts',
      'backend/server/src/webhook-account-resource-registration-target-normalizer.ts',
      'backend/server/src/webhook-registration-json-response-reader.ts',
      'backend/server/src/webhook-registration-idempotency-key-parser.ts',
    ]) {
      const text = source(path).toLowerCase();
      for (const profileId of VENDOR_PROFILE_IDS) expect(text).not.toContain(profileId);
      for (const vendor of VENDOR_NAMES) expect(text).not.toContain(vendor);
      expect(text).not.toContain('profile_id');
    }

    const timestampedFormProfile = source(
      'backend/server/src/webhook-timestamped-form-profile.ts',
    ).toLowerCase();
    for (const profileId of VENDOR_PROFILE_IDS) {
      expect(timestampedFormProfile).not.toContain(profileId);
    }
    for (const vendor of VENDOR_NAMES) {
      expect(timestampedFormProfile).not.toContain(vendor);
    }
    for (const vendorField of [
      'x-slack-signature',
      'x-slack-request-timestamp',
      'response_url',
      'ssl_check',
      'trigger_id',
      'team_id',
    ]) {
      expect(timestampedFormProfile).not.toContain(vendorField);
    }

    const timestampedJsonFormProfile = source(
      'backend/server/src/webhook-timestamped-json-form-single-event-profile.ts',
    );
    const timestampedJsonFormProfileLower =
      timestampedJsonFormProfile.toLowerCase();
    for (const profileId of VENDOR_PROFILE_IDS) {
      expect(timestampedJsonFormProfileLower).not.toContain(profileId);
    }
    for (const vendor of VENDOR_NAMES) {
      expect(timestampedJsonFormProfileLower).not.toContain(vendor);
    }
    for (const vendorField of [
      'x-slack-signature',
      'x-slack-request-timestamp',
      'url_verification',
      'slack-signature-v0',
      'slack:event:',
      'slack:request:',
      "json_field: 'payload'",
    ]) {
      expect(timestampedJsonFormProfileLower).not.toContain(vendorField);
    }

    const staticHeaderTokenEngine = source(
      'backend/server/src/webhook-static-header-token-engine.ts',
    ).toLowerCase();
    const rawBodyHmacEngine = source(
      'backend/server/src/webhook-raw-body-hmac-engine.ts',
    ).toLowerCase();
    const timestampedEngine = source(
      'backend/server/src/webhook-timestamped-hmac-engine.ts',
    ).toLowerCase();
    const timestampedJsonProfile = source(
      'backend/server/src/webhook-timestamped-json-single-event-profile.ts',
    );
    const timestampedJsonProfileLower = timestampedJsonProfile.toLowerCase();
    for (const profileId of VENDOR_PROFILE_IDS) {
      expect(timestampedJsonProfileLower).not.toContain(profileId);
    }
    for (const vendor of VENDOR_NAMES) {
      expect(timestampedJsonProfileLower).not.toContain(vendor);
    }
    const rawHeaderJsonProfile = source(
      'backend/server/src/webhook-raw-header-json-single-event-profile.ts',
    );
    const rawHeaderJsonProfileLower = rawHeaderJsonProfile.toLowerCase();
    for (const profileId of VENDOR_PROFILE_IDS) {
      expect(rawHeaderJsonProfileLower).not.toContain(profileId);
    }
    for (const vendor of VENDOR_NAMES) {
      expect(rawHeaderJsonProfileLower).not.toContain(vendor);
    }
    const rawBodyJsonApiProfile = source(
      'backend/server/src/webhook-raw-body-json-api-single-event-profile.ts',
    );
    const rawBodyJsonApiProfileLower = rawBodyJsonApiProfile.toLowerCase();
    for (const profileId of VENDOR_PROFILE_IDS) {
      expect(rawBodyJsonApiProfileLower).not.toContain(profileId);
    }
    for (const vendor of VENDOR_NAMES) {
      expect(rawBodyJsonApiProfileLower).not.toContain(vendor);
    }
    for (const vendorField of [
      'x-signature',
      'x-event-name',
      'event_name',
      'lemonsqueezy:request:',
      'lowerhex.v1',
    ]) {
      expect(rawBodyJsonApiProfileLower).not.toContain(vendorField);
    }
    const staticHeaderJsonProfile = source(
      'backend/server/src/webhook-static-header-json-single-event-profile.ts',
    );
    const staticHeaderJsonProfileLower = staticHeaderJsonProfile.toLowerCase();
    for (const profileId of VENDOR_PROFILE_IDS) {
      expect(staticHeaderJsonProfileLower).not.toContain(profileId);
    }
    for (const vendor of VENDOR_NAMES) {
      expect(staticHeaderJsonProfileLower).not.toContain(vendor);
    }
    for (const vendorField of [
      'stripe-signature',
      'whsec_',
      'evt_recued_test_',
      'recued_test_delivery',
      'livemode',
      'pdl_ntfset_',
      'x-slack-signature',
    ]) {
      expect(timestampedJsonProfileLower).not.toContain(vendorField);
    }
    const timestampedJsonNotificationProfile = source(
      'backend/server/src/webhook-timestamped-json-single-notification-profile.ts',
    );
    const timestampedJsonNotificationProfileLower =
      timestampedJsonNotificationProfile.toLowerCase();
    for (const profileId of VENDOR_PROFILE_IDS) {
      expect(timestampedJsonNotificationProfileLower).not.toContain(profileId);
    }
    for (const vendor of VENDOR_NAMES) {
      expect(timestampedJsonNotificationProfileLower).not.toContain(vendor);
    }
    for (const vendorField of [
      'paddle-signature',
      'pdl_ntfset_',
      'notification_id',
      'paddle:notification:',
      'paddle:event:',
    ]) {
      expect(timestampedJsonNotificationProfileLower).not.toContain(vendorField);
    }
    expect(timestampedEngine).not.toContain('whsec_');
    expect(timestampedEngine).not.toContain('pdl_ntfset_');
    expect(timestampedEngine)
      .toContain('createwebhookprefixedasciitokenparser');
    expect(timestampedEngine)
      .toContain('createwebhooksegmentedasciitokenparser');
    expect(timestampedEngine).not.toContain('ascii_token_re');
    expect(timestampedEngine).not.toContain('ascii_alphanumeric_re');
    expect(timestampedEngine).not.toContain('max_secret_segments');
    expect(timestampedEngine).not.toContain('freezesegmentlengths');
    expect(staticHeaderTokenEngine)
      .toContain('createwebhookboundedasciitokenparser');
    expect(staticHeaderTokenEngine).not.toContain('generated_token_re');
    expect(staticHeaderTokenEngine)
      .not.toContain('ascii_alphanumeric_underscore_dash_256');
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .not.toContain('ascii_alphanumeric_underscore_dash_256');
    expect(source('backend/server/src/webhook-shared-profile-parser-presets.ts'))
      .toContain('max_characters: 256');
    expect(rawBodyHmacEngine)
      .toContain('createwebhookfixedlengthasciitokenparser');
    expect(rawBodyHmacEngine).not.toContain('generated_secret_re');
    expect(rawBodyHmacEngine)
      .not.toContain('recued_generated_base64url_32');
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .not.toContain('recued_generated_base64url_32');
    expect(source('backend/server/src/webhook-shared-profile-parser-presets.ts'))
      .toContain('characters: 43');
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .not.toContain("prefix: 'whsec_'");
    expect(source('backend/server/src/webhook-shared-profile-parser-presets.ts'))
      .toContain("prefix: 'whsec_'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .not.toContain("prefix: 'pdl_ntfset_'");
    expect(source('backend/server/src/webhook-shared-profile-parser-presets.ts'))
      .toContain("prefix: 'pdl_ntfset_'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("discriminator_value: 'url_verification'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("provider_event_id_field: 'event_id'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("stable_id_prefix: 'slack:event:'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("stable_id_prefix: 'stripe:event:'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("fallback_prefix: 'stripe:request:'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("event_id_prefix: 'evt_recued_test_'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("marker_object_field: 'recued_test_delivery'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("resource_fallback_object_field: 'team'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("resource_fallback_object_field: 'data'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("resource_fallback_nested_object_field: 'object'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("value: 'event'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("boolean_field: 'livemode'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("invalid_resource_id_disposition: 'treat_as_absent.v1'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("when_event_type: 'event_callback'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("json_field: 'payload'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("event_type: 'slash_command'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("command_field: 'command'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("admission_method_label: admissionMethodLabelInput");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("runtime_error_label: runtimeErrorLabelInput");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("'stripe-signature-v1'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("kind: 'strict_rfc3339_milliseconds.v1'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("kind: 'fixed_prefix_lowercase_alphanumeric_id.v1'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("kind: 'raw_header_single_event_metadata.v1'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("kind: 'normalized_required_single_id_sha256.v1'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("kind: 'metadata_payload_single_event.v1'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("kind: 'raw_header_json_single_event_test_envelope.v1'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("kind: 'static_header_token.v1'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("kind: 'json_single_member_event.v1'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("stable_id_prefix: 'github:delivery:'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("'github-hmac-sha256', 'GitHub webhook', 'oldest'");
    expect(source('backend/server/src/webhook-shared-profile-parser-presets.ts'))
      .toContain("kind: 'lowercase_dot_segment_event_type.v1'");
    expect(source('backend/server/src/webhook-shared-profile-parser-presets.ts'))
      .toContain("kind: 'lowercase_identifier_event_type.v1'");
    expect(source('backend/server/src/webhook-shared-profile-parser-presets.ts'))
      .toContain("kind: 'positive_decimal_identifier.v1'");
    expect(source('backend/server/src/webhook-shared-profile-parser-presets.ts'))
      .toContain("kind: 'optional_json_object_provider_id.v1'");
    expect(source('backend/server/src/webhook-shared-profile-parser-presets.ts'))
      .toContain("kind: 'required_json_object_field.v1'");
    expect(source('backend/server/src/webhook-delivery-engine-presets.ts'))
      .toContain("kind: 'json_single_notification_fields.v1'");

    const primitives = source('backend/server/src/webhook-primitive-profiles.ts');
    const githubProfile = source('backend/server/src/webhook-github-profile.ts');
    const telegramProfile = source(
      'backend/server/src/webhook-telegram-profile.ts',
    );
    const telegramProtocol = source(
      'backend/server/src/connections/providers/telegram-webhook-protocol.ts',
    );
    const telegramRegistration = source(
      'backend/server/src/connections/providers/telegram-webhook-registration.ts',
    );
    const singleMemberEventNormalizer = source(
      'backend/server/src/webhook-json-single-member-event-normalizer.ts',
    );
    const jsonEventNormalizer = source(
      'backend/server/src/webhook-json-event-normalizer.ts',
    );
    const flatFormEventNormalizer = source(
      'backend/server/src/webhook-flat-form-event-normalizer.ts',
    );
    const stripeProfile = source('backend/server/src/webhook-stripe-profile.ts');
    const stripeProvider = source(
      'backend/server/src/connections/providers/stripe-provider.ts',
    );
    const stripeRegistration = source(
      'backend/server/src/connections/providers/stripe-webhook-registration.ts',
    );
    const stripeProtocol = source(
      'backend/server/src/connections/providers/stripe-webhook-protocol.ts',
    );
    const paddleProfile = source('backend/server/src/webhook-paddle-profile.ts');
    const paddleProtocol = source(
      'backend/server/src/connections/providers/paddle-webhook-protocol.ts',
    );
    const paddleRegistration = source(
      'backend/server/src/connections/providers/paddle-webhook-registration.ts',
    );
    const registrationPresets = source(
      'backend/server/src/webhook-registration-profile-presets.ts',
    );
    const ingressHandler = source(
      'backend/server/src/webhook-ingress-handler.ts',
    );
    const deliveryStore = source(
      'backend/server/src/storage/webhook-delivery-store.ts',
    );
    const coreIdentityParsers = source(
      'backend/server/src/webhook-core-identity-parsers.ts',
    );
    const positiveSafeIntegerTextParser = source(
      'backend/server/src/webhook-positive-safe-integer-text-parser.ts',
    );
    const credentialVersionRuntimeSources = [
      'backend/server/src/webhook-primitive-profiles.ts',
      'backend/server/src/webhook-raw-body-hmac-engine.ts',
      'backend/server/src/webhook-static-header-token-engine.ts',
      'backend/server/src/webhook-timestamped-hmac-engine.ts',
    ].map((path) => ({ path, text: source(path) }));
    const coreIdentityConfigurationSurfaces = [
      'packages/contracts/src/webhook-owner-profile-settings.ts',
      'packages/contracts/src/webhook-profiles.ts',
      'backend/server/src/webhook-profile-policy.ts',
      'backend/server/src/webhook-delivery-profile-presets.ts',
      'backend/server/src/webhook-delivery-engine-presets.ts',
      'backend/server/src/webhook-shared-profile-parser-presets.ts',
      'backend/server/src/webhook-registration-profile-presets.ts',
      'backend/server/src/webhook-registration-target-profile-presets.ts',
      'backend/server/src/webhook-registration-response-profile-presets.ts',
      'backend/server/src/webhook-registration-idempotency-key-profile-presets.ts',
      'backend/server/src/webhook-endpoint-profile-presets.ts',
      'backend/server/src/webhook-registration-remote-url-profile-presets.ts',
      'backend/server/src/webhook-registration-destination-profile-presets.ts',
      'backend/server/src/webhook-registration-connection-token-profile-presets.ts',
      'backend/server/src/webhook-registration-environment-token-profile-presets.ts',
      'backend/server/src/webhook-registration-access-token-profile-presets.ts',
      'apps/webclient/src/connections/webhooks-panel.ts',
    ].map((path) => ({ path, text: source(path) }));
    const slackProfile = source('backend/server/src/webhook-slack-profile.ts');
    const githubProtocol = source(
      'backend/server/src/connections/providers/github-webhook-protocol.ts',
    );
    const githubRegistration = source(
      'backend/server/src/connections/providers/github-webhook-registration.ts',
    );
    const githubRegistrationTarget = source(
      'backend/server/src/connections/providers/github-webhook-registration-target.ts',
    );
    const slackProtocol = source(
      'backend/server/src/connections/providers/slack-webhook-protocol.ts',
    );
    expect(primitives).toContain('createWebhookRawBodyHmacMechanism');
    expect(coreIdentityParsers)
      .toContain('createWebhookBoundedPrefixedAsciiIdentifierParser');
    for (const prefix of ['whi_', 'whd_', 'whe_', 'whr_']) {
      expect(coreIdentityParsers).toContain(`prefix: '${prefix}'`);
      for (const surface of coreIdentityConfigurationSurfaces) {
        expect(
          surface.text,
          `${surface.path} must not configure core identity prefix '${prefix}'`,
        ).not.toContain(prefix);
      }
    }
    expect(coreIdentityParsers).toContain('min_suffix_characters: 16');
    expect(coreIdentityParsers).toContain('max_suffix_characters: 128');
    expect(coreIdentityParsers)
      .toContain('createWebhookPositiveSafeIntegerTextParser');
    expect(coreIdentityParsers)
      .toContain('WEBHOOK_CREDENTIAL_VERSION_PARSER');
    expect(coreIdentityParsers)
      .toContain('max_value: Number.MAX_SAFE_INTEGER');
    expect(positiveSafeIntegerTextParser)
      .toContain("kind: 'positive_safe_integer_text.v1'");
    for (const surface of coreIdentityConfigurationSurfaces) {
      expect(
        surface.text,
        `${surface.path} must not configure the core credential-version parser`,
      ).not.toContain('positive_safe_integer_text.v1');
    }
    for (const text of [ingressHandler, deliveryStore]) {
      expect(text).toContain('WEBHOOK_CREDENTIAL_VERSION_PARSER.parse');
      expect(text).not.toContain('/^[1-9][0-9]*$/');
    }
    for (const runtime of credentialVersionRuntimeSources) {
      expect(
        runtime.text,
        `${runtime.path} must select the core credential-version parser`,
      ).toContain('WEBHOOK_CREDENTIAL_VERSION_PARSER.parse');
      const validatorStart = runtime.text.indexOf('const validCredentialVersion');
      const validatorEnd = runtime.text.indexOf(
        'const exactHeaderValue',
        validatorStart,
      );
      expect(validatorStart, `${runtime.path} must retain its local record validator`)
        .toBeGreaterThanOrEqual(0);
      expect(validatorEnd, `${runtime.path} must bound its local record validator`)
        .toBeGreaterThan(validatorStart);
      const validator = runtime.text.slice(validatorStart, validatorEnd);
      expect(validator).toContain('WEBHOOK_CREDENTIAL_VERSION_PARSER.parse');
      expect(validator).not.toContain('/^[1-9][0-9]*$/');
      expect(validator).not.toContain('Number.isSafeInteger(Number(');
    }
    for (const text of [
      stripeRegistration,
      paddleRegistration,
      githubRegistration,
      telegramRegistration,
      ingressHandler,
      deliveryStore,
    ]) {
      expect(text).toContain('WEBHOOK_INGRESS_ID_PARSER.parse');
      expect(text).not.toContain('/^whi_');
      expect(text).not.toContain("'whi_'");
    }
    for (const parser of [
      'WEBHOOK_DELIVERY_ID_PARSER',
      'WEBHOOK_EVENT_ID_PARSER',
      'WEBHOOK_REJECTION_ID_PARSER',
    ]) {
      expect(ingressHandler).toContain(`${parser}.parse`);
    }
    expect(deliveryStore).toContain('WEBHOOK_REJECTION_ID_PARSER.parse');
    for (const legacyPrefix of ['/^whd_', '/^whe_', '/^whr_']) {
      expect(ingressHandler).not.toContain(legacyPrefix);
      expect(deliveryStore).not.toContain(legacyPrefix);
    }
    for (const prefix of ['whd_', 'whe_', 'whr_']) {
      expect(ingressHandler).not.toContain(`'${prefix}'`);
    }
    for (const vendor of VENDOR_NAMES) {
      expect(coreIdentityParsers.toLowerCase()).not.toContain(vendor);
      expect(positiveSafeIntegerTextParser.toLowerCase()).not.toContain(vendor);
    }
    expect(primitives).toContain('createWebhookStaticHeaderTokenMechanism');
    expect(primitives).toContain('GENERIC_STATIC_HEADER_TOKEN_MECHANISM_PRESET');
    expect(primitives).not.toContain('configuredHeaderCredentials');
    expect(primitives).not.toContain('validHeaderToken');
    expect(primitives).toContain('GENERIC_RAW_BODY_HMAC_MECHANISM_PRESET');
    expect(primitives).toContain('webhookRawBodyHmacDeliveryProfilePreset');
    expect(githubProfile).not.toContain('createWebhookRawBodyHmacMechanism');
    expect(githubProfile).toContain('GITHUB_WEBHOOK_RAW_BODY_HMAC_MECHANISM_PRESET');
    expect(githubProfile).toContain('webhookRawBodyHmacDeliveryProfilePreset');
    expect(primitives).toContain('createWebhookJsonObjectDecoder');
    expect(githubProfile).not.toContain('createWebhookJsonObjectDecoder');
    expect(githubProfile).not.toContain('createWebhookCanonicalUuidParser');
    expect(githubProfile).toContain('GITHUB_DELIVERY_ID_PARSER_PRESET');
    expect(githubProfile)
      .not.toContain('createWebhookLowercaseIdentifierEventTypeParser');
    expect(githubProfile).toContain('GITHUB_EVENT_TYPE_PARSER_PRESET');
    expect(githubProfile)
      .not.toContain('createWebhookPositiveDecimalIdentifierParser');
    expect(githubProfile).toContain('GITHUB_HOOK_ID_PARSER_PRESET');
    expect(githubProfile)
      .not.toContain('createWebhookRawHeaderSingleEventMetadataNormalizer');
    expect(githubProfile)
      .toContain('GITHUB_RAW_HEADER_METADATA_NORMALIZER_PRESET');
    expect(githubProfile).not.toContain('exactHeaderValue');
    expect(githubProfile)
      .not.toContain('connections/providers/github-webhook-protocol');
    expect(githubProfile).not.toContain('GITHUB_DELIVERY_HEADER');
    expect(githubProfile).not.toContain('GITHUB_EVENT_HEADER');
    expect(githubProfile).not.toContain('GITHUB_HOOK_ID_HEADER');
    expect(githubProfile)
      .not.toContain('createWebhookNormalizedDeliveryDeduplicator');
    expect(githubProfile)
      .toContain('GITHUB_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET');
    expect(githubProfile).not.toContain('github:delivery:');
    expect(githubProfile).not.toContain('deliveryDedupKey');
    expect(githubProfile)
      .not.toContain('createWebhookMetadataPayloadSingleEventNormalizer');
    expect(githubProfile)
      .toContain('GITHUB_METADATA_PAYLOAD_EVENT_NORMALIZER_PRESET');
    expect(githubProfile)
      .not.toContain('createWebhookNormalizedSingleEventProjector');
    expect(githubProfile)
      .toContain('GITHUB_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET');
    expect(githubProfile).not.toContain('provider_event_id:');
    expect(githubProfile).not.toContain('provider_resource_id:');
    expect(githubProfile).not.toContain('provider_event_type:');
    expect(githubProfile).not.toContain('provider_occurred_at:');
    expect(githubProfile).not.toContain('decoded_payload:');
    expect(githubProfile)
      .not.toContain('createWebhookRawHeaderJsonSingleEventTestEnvelopeBuilder');
    expect(githubProfile)
      .toContain('GITHUB_RAW_HEADER_JSON_SINGLE_EVENT_TEST_ENVELOPE_PRESET');
    expect(githubProfile)
      .toContain('createRawHeaderJsonSingleEventWebhookProfileAdapter');
    expect(githubProfile)
      .toContain('createRawHeaderJsonSingleEventWebhookCredentialShapeValidator');
    expect(rawHeaderJsonProfile).toContain('createWebhookRawBodyHmacMechanism');
    expect(rawHeaderJsonProfile).toContain('createWebhookJsonObjectDecoder');
    expect(rawHeaderJsonProfile).toContain('createWebhookCanonicalUuidParser');
    expect(rawHeaderJsonProfile)
      .toContain('createWebhookRawHeaderSingleEventMetadataNormalizer');
    expect(rawHeaderJsonProfile)
      .toContain('createWebhookNormalizedDeliveryDeduplicator');
    expect(rawHeaderJsonProfile)
      .toContain('createWebhookMetadataPayloadSingleEventNormalizer');
    expect(rawHeaderJsonProfile)
      .toContain('createWebhookNormalizedSingleEventProjector');
    expect(rawHeaderJsonProfile)
      .toContain('createWebhookRawHeaderJsonSingleEventTestEnvelopeBuilder');
    expect(rawHeaderJsonProfile)
      .toContain("transport_assurance !== 'authenticated'");
    expect(rawHeaderJsonProfile).toContain('handshakes.length !== 0');
    expect(githubProfile).not.toContain("from 'node:crypto'");
    expect(githubProfile).not.toContain('TEST_DELIVERY_NONCE_RE');
    expect(githubProfile).not.toContain('testDeliveryGuid');
    expect(githubProfile).not.toContain('recued:github:test-delivery:');
    expect(githubProfile).not.toContain("action: 'recued_test_delivery'");
    expect(githubProfile).not.toContain("type: 'Repository'");
    expect(githubProtocol).toContain('WEBHOOK_JSON_OBJECT_DECODER_V1.decode');
    expect(githubProtocol).not.toContain('canonicalGitHubDeliveryId');
    expect(githubProtocol).not.toContain('GITHUB_DELIVERY_ID_RE');
    expect(githubProtocol).not.toContain('isValidGitHubEventType');
    expect(githubProtocol).not.toContain('GITHUB_EVENT_TYPE_RE');
    expect(githubProtocol).not.toContain('MAX_GITHUB_EVENT_TYPE_BYTES');
    expect(githubProtocol).not.toContain('isValidGitHubHookId');
    expect(githubProtocol).not.toContain('GITHUB_HOOK_ID_RE');
    expect(githubProtocol).not.toContain('MAX_GITHUB_HOOK_ID_BYTES');
    expect(githubProtocol).not.toContain('RECUED_GENERATED_SECRET_RE');
    expect(githubProtocol)
      .not.toContain('isValidGitHubGeneratedWebhookSecret');
    expect(githubProtocol).toContain('isValidGitHubWebhookSecret');
    expect(githubRegistration)
      .toContain('WebhookLowercaseIdentifierEventTypeParser');
    expect(githubRegistration).not.toContain('isValidGitHubEventType');
    expect(githubRegistration)
      .toContain('WebhookAccountResourceRegistrationTargetNormalizer');
    expect(githubRegistration).toContain('registrationTargetNormalizer.normalize');
    expect(githubRegistration)
      .not.toContain('canonicalGitHubWebhookRegistrationTarget');
    expect(githubRegistration)
      .not.toContain('github-webhook-registration-target');
    expect(githubRegistration).not.toContain("target.kind === 'organization'");
    expect(githubRegistration).not.toContain("target.kind !== 'repository'");
    expect(githubRegistrationTarget)
      .toContain('createWebhookAccountResourceRegistrationTargetNormalizer');
    expect(githubRegistrationTarget)
      .toContain('webhookRegistrationTargetProfilePreset');
    expect(githubRegistrationTarget).not.toContain('GITHUB_LOGIN_RE');
    expect(githubRegistrationTarget).not.toContain('GITHUB_REPOSITORY_RE');
    expect(githubRegistrationTarget).not.toContain("indexOf('/')");
    expect(githubRegistrationTarget).not.toContain('toLowerCase()');
    expect(githubRegistration)
      .toContain('WebhookRegistrationJsonResponseReader');
    expect(githubRegistration).toContain('responseReader.readText');
    expect(githubRegistration).toContain('responseReader.readJson');
    expect(githubRegistration).not.toContain('TextDecoder');
    expect(githubRegistration).not.toContain('JSON.parse');
    expect(githubRegistration)
      .not.toContain('MAX_GITHUB_REGISTRATION_RESPONSE_BYTES');
    expect(githubRegistration)
      .toContain('WebhookRegistrationIdempotencyKeyParser');
    expect(githubRegistration).toContain('parser.parse');
    expect(githubRegistration).not.toContain('IDEMPOTENCY_KEY_RE');
    expect(githubRegistration)
      .toContain('WebhookPositiveDecimalIdentifierParser');
    expect(githubRegistration).toContain('remoteIdParser.parse');
    expect(githubRegistration).not.toContain('GITHUB_REMOTE_ID_RE');
    expect(githubRegistration)
      .toContain('WebhookFixedLengthAsciiTokenParser');
    expect(githubRegistration).toContain('secretParser.parse');
    expect(githubRegistration).toContain('WebhookBoundedHttpUrlParser');
    expect(githubRegistration).toContain('remoteUrlParser.parse');
    expect(githubRegistration.match(/remoteUrlParser\.parse/g)).toHaveLength(3);
    expect(githubRegistration)
      .toContain('canonicalDesiredEndpoint(endpoint, deps.remoteUrlParser)');
    expect(githubRegistration).not.toContain('const boundedRemoteUrl');
    expect(githubRegistration)
      .not.toContain('isValidGitHubGeneratedWebhookSecret');
    expect(githubRegistration).not.toContain('github-webhook-protocol');
    expect(githubRegistration)
      .toContain('WebhookPrefixSetPrintableAsciiTokenParser');
    expect(githubRegistration).toContain('accessTokenParser.parse');
    expect(githubRegistration)
      .not.toContain('hasGitHubPersonalAccessTokenPrefix');
    expect(githubRegistration).not.toContain('GITHUB_ACCESS_TOKEN_RE');
    expect(githubRegistration).not.toContain("'ghp_'");
    expect(githubRegistration).not.toContain("'github_pat_'");
    expect(telegramProfile)
      .not.toContain('createWebhookStaticHeaderTokenMechanism');
    expect(telegramProfile)
      .toContain('TELEGRAM_STATIC_HEADER_TOKEN_MECHANISM_PRESET');
    expect(telegramProfile).not.toContain('createWebhookJsonObjectDecoder');
    expect(telegramProfile).toContain('TELEGRAM_JSON_OBJECT_DECODER_PRESET');
    expect(telegramProfile)
      .not.toContain('createWebhookJsonSingleMemberEventNormalizer');
    expect(telegramProfile)
      .toContain('TELEGRAM_JSON_SINGLE_MEMBER_EVENT_NORMALIZER_PRESET');
    expect(telegramProfile)
      .not.toContain('createWebhookNormalizedDeliveryDeduplicator');
    expect(telegramProfile)
      .toContain('TELEGRAM_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET');
    expect(telegramProfile)
      .not.toContain('createWebhookNormalizedSingleEventProjector');
    expect(telegramProfile)
      .toContain('TELEGRAM_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET');
    expect(telegramProfile)
      .toContain('createStaticHeaderJsonSingleEventWebhookProfileAdapter');
    expect(telegramProfile)
      .toContain('createStaticHeaderJsonSingleEventWebhookCredentialShapeValidator');
    expect(staticHeaderJsonProfile)
      .toContain('createWebhookStaticHeaderTokenMechanism');
    expect(staticHeaderJsonProfile).toContain('createWebhookJsonObjectDecoder');
    expect(staticHeaderJsonProfile)
      .toContain('createWebhookJsonSingleMemberEventNormalizer');
    expect(staticHeaderJsonProfile)
      .toContain('createWebhookNormalizedDeliveryDeduplicator');
    expect(staticHeaderJsonProfile)
      .toContain('createWebhookNormalizedSingleEventProjector');
    expect(staticHeaderJsonProfile)
      .toContain("transport_assurance !== 'authenticated'");
    expect(staticHeaderJsonProfile).toContain('handshakes.length !== 0');
    expect(primitives)
      .toContain('GENERIC_STATIC_HEADER_TOKEN_JSON_OBJECT_DECODER_PRESET');
    expect(telegramProfile).not.toContain('isValidTelegramWebhookSecret');
    expect(telegramProfile).not.toContain('verifyTelegramWebhookSecret');
    expect(telegramProfile).not.toContain('configuredCredentials');
    expect(telegramProfile).not.toContain('newestCredential');
    expect(telegramProfile).not.toContain('exactHeaderValue');
    expect(telegramProtocol).not.toContain('TextDecoder');
    expect(telegramProtocol).not.toContain('JSON.parse');
    expect(telegramProtocol).not.toContain('MAX_TELEGRAM_JSON_');
    expect(telegramProtocol).not.toContain('PROTOTYPE_SENSITIVE_KEYS');
    expect(telegramProtocol).not.toContain('isBoundedTelegramJsonGraph');
    expect(telegramProtocol).not.toContain('MAX_TELEGRAM_UPDATE_ID');
    expect(telegramProtocol).not.toContain('TELEGRAM_EVENT_TYPE_RE');
    expect(telegramProtocol).not.toContain('decodeTelegramBotUpdate');
    expect(telegramProtocol).not.toContain('update_id');
    expect(telegramProtocol).toContain('isValidTelegramWebhookSecret');
    expect(telegramProtocol).toContain('verifyTelegramWebhookSecret');
    expect(telegramProtocol).toContain('isTelegramWebhookEndpointSupported');
    expect(telegramRegistration)
      .toContain('WebhookRegistrationJsonResponseReader');
    expect(telegramRegistration).toContain('responseReader.readText');
    expect(telegramRegistration).toContain('responseReader.readJson');
    expect(telegramRegistration).not.toContain('TextDecoder');
    expect(telegramRegistration).not.toContain('JSON.parse');
    expect(telegramRegistration)
      .not.toContain('MAX_TELEGRAM_REGISTRATION_RESPONSE_BYTES');
    expect(telegramRegistration)
      .toContain('WebhookRegistrationIdempotencyKeyParser');
    expect(telegramRegistration).toContain('parser.parse');
    expect(telegramRegistration).not.toContain('IDEMPOTENCY_KEY_RE');
    expect(telegramRegistration)
      .toContain('WebhookPrefixedPositiveDecimalIdCodec');
    expect(telegramRegistration).toContain('codec.parse(remoteEndpointId)');
    expect(telegramRegistration).toContain('deps.remoteIdCodec.format');
    expect(telegramRegistration).not.toContain('TELEGRAM_BOT_ID_RE');
    expect(telegramRegistration).not.toContain('telegramManagedWebhookRemoteId');
    expect(telegramRegistration).not.toContain('telegram_bot_');
    expect(telegramRegistration).toContain('WebhookAsciiIdentifierParser');
    expect(telegramRegistration).toContain('eventTypeParser.parse');
    expect(telegramRegistration).not.toContain('TELEGRAM_EVENT_TYPE_RE');
    expect(telegramRegistration).toContain('WebhookBoundedAsciiTokenParser');
    expect(telegramRegistration).toContain('secretParser.parse');
    expect(telegramRegistration).not.toContain('isValidTelegramWebhookSecret');
    expect(telegramRegistration).toContain('WebhookBoundedHttpsUrlParser');
    expect(telegramRegistration).toContain('endpointParser.parse');
    expect(telegramRegistration)
      .not.toContain('isTelegramWebhookEndpointSupported');
    expect(telegramRegistration).not.toContain('telegram-webhook-protocol');
    expect(telegramRegistration)
      .toContain('WebhookDecimalColonAsciiTokenParser');
    expect(telegramRegistration).toContain('connectionTokenParser.parse');
    expect(telegramRegistration).not.toContain('TELEGRAM_BOT_TOKEN_RE');
    expect(telegramRegistration)
      .not.toContain('connection.bot_token.length > 512');
    expect(singleMemberEventNormalizer)
      .toContain('createWebhookAsciiIdentifierParser');
    expect(singleMemberEventNormalizer).not.toContain('EVENT_TYPE_RE');
    expect(telegramProfile).not.toContain('decodeTelegramBotUpdate');
    expect(telegramProfile).not.toContain('update.update_id');
    expect(telegramProfile).not.toContain('update.update_type');
    expect(telegramProfile).not.toContain("from 'node:crypto'");
    expect(telegramProfile).not.toContain('updateDedupKey');
    expect(telegramProfile).not.toContain("'telegram:update:'");
    expect(telegramProfile).not.toContain('event_dedup_key: `${');
    expect(telegramProfile).not.toContain('provider_event_id:');
    expect(telegramProfile).not.toContain('provider_resource_id:');
    expect(telegramProfile).not.toContain('provider_event_type:');
    expect(telegramProfile).not.toContain('provider_occurred_at:');
    expect(telegramProfile).not.toContain('decoded_payload:');
    expect(telegramProfile).not.toContain("'telegram-secret-token'");
    expect(telegramProfile).not.toContain('verifyAndDecode(');
    expect(telegramProfile).not.toContain('.authenticate(');
    expect(telegramProfile).not.toContain('.decode(');
    expect(telegramProfile).not.toContain('.normalize(');
    expect(telegramProfile).not.toContain('.deduplicate(');
    expect(telegramProfile).not.toContain('.project(');
    expect(primitives).toContain('createWebhookTimestampedHmacMechanism');
    expect(primitives).toContain('GENERIC_TIMESTAMPED_HMAC_MECHANISM_PRESET');
    expect(timestampedJsonProfile)
      .toContain('createWebhookTimestampedHmacMechanism');
    expect(stripeProfile).toContain('STRIPE_TIMESTAMPED_HMAC_MECHANISM_PRESET');
    expect(timestampedJsonProfile).toContain('createWebhookJsonObjectDecoder');
    expect(stripeProfile).toContain('STRIPE_JSON_OBJECT_DECODER_PRESET');
    expect(timestampedJsonProfile).toContain('createWebhookJsonEventNormalizer');
    expect(stripeProfile).toContain('STRIPE_JSON_EVENT_NORMALIZER_PRESET');
    expect(timestampedJsonProfile)
      .toContain('createWebhookJsonEnvironmentAdmission');
    expect(stripeProfile).toContain('STRIPE_JSON_ENVIRONMENT_ADMISSION_PRESET');
    expect(timestampedJsonProfile)
      .toContain('createWebhookNormalizedSingleEventProjector');
    expect(stripeProfile)
      .toContain('STRIPE_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET');
    expect(timestampedJsonProfile)
      .toContain('createWebhookNormalizedDeliveryDeduplicator');
    expect(stripeProfile)
      .toContain('STRIPE_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET');
    expect(timestampedJsonProfile)
      .toContain('createWebhookJsonSingleEventTestEnvelopeBuilder');
    expect(stripeProfile)
      .toContain('STRIPE_JSON_SINGLE_EVENT_TEST_ENVELOPE_PRESET');
    expect(stripeProfile)
      .toContain('createTimestampedJsonSingleEventWebhookProfileAdapter');
    expect(stripeProfile)
      .toContain('createClockGatedTimestampedJsonSingleEventWebhookProfileAdapter');
    expect(stripeProfile)
      .toContain('createTimestampedJsonSingleEventWebhookCredentialShapeValidator');
    expect(stripeProfile).not.toContain('verifyAndDecode(');
    expect(stripeProfile).not.toContain('buildTestDelivery(');
    expect(stripeProfile).not.toContain('.authenticate(');
    expect(stripeProfile).not.toContain('.decode(');
    expect(stripeProfile).not.toContain('.normalize(');
    expect(stripeProfile).not.toContain('.deduplicate(');
    expect(stripeProfile).not.toContain('.project(');
    expect(stripeProfile).not.toContain("'stripe-signature-v1'");
    expect(stripeProfile).not.toContain('decodeStripeWebhookEvent');
    expect(stripeProfile).not.toContain('stripe-webhook-protocol');
    expect(stripeProfile).not.toContain('ownBoolean');
    expect(stripeProfile).not.toContain("context.environment === 'live'");
    expect(stripeProfile).not.toContain('createHash');
    expect(stripeProfile).not.toContain("'stripe:event:'");
    expect(stripeProfile).not.toContain("'stripe:request:'");
    expect(stripeProfile).not.toContain('TEST_DELIVERY_NONCE_RE');
    expect(stripeProfile).not.toContain("'evt_recued_test_'");
    expect(stripeProfile).not.toContain("'recued_test_'");
    expect(stripeProfile).not.toContain("'recued_test_delivery'");
    expect(stripeProfile).not.toContain("object: 'event'");
    expect(stripeProfile).not.toContain('livemode: false');
    expect(stripeProtocol).toContain('WebhookJsonObjectDecoder');
    expect(stripeProtocol).not.toContain('WEBHOOK_JSON_OBJECT_DECODER_V1');
    expect(stripeProtocol).not.toContain('TextDecoder');
    expect(stripeProtocol).not.toContain('JSON.parse');
    expect(stripeProtocol).not.toContain('MAX_STRIPE_JSON_');
    expect(stripeProtocol).not.toContain('PROTOTYPE_SENSITIVE_KEYS');
    expect(stripeRegistration)
      .toContain('WebhookRegistrationJsonResponseReader');
    expect(stripeRegistration).toContain('responseReader.readText');
    expect(stripeRegistration).toContain('responseReader.readJson');
    expect(stripeRegistration).not.toContain('Buffer.concat');
    expect(stripeRegistration).not.toContain("toString('utf8')");
    expect(stripeRegistration).not.toContain('JSON.parse');
    expect(stripeRegistration).not.toContain('MAX_STRIPE_RESPONSE_BYTES');
    expect(stripeRegistration)
      .toContain('WebhookRegistrationIdempotencyKeyParser');
    expect(stripeRegistration).toContain('idempotencyKeyParser.parse');
    expect(stripeRegistration).not.toContain('IDEMPOTENCY_KEY_RE');
    expect(stripeRegistration)
      .toContain('WebhookBoundedPrefixProviderIdParser');
    expect(stripeRegistration).toContain('remoteIdParser.parse');
    expect(stripeRegistration).not.toContain('REMOTE_ID_RE');
    expect(stripeRegistration).toContain('WebhookAsciiEventTypeParser');
    expect(stripeRegistration).toContain('eventTypeParser.parse');
    expect(stripeRegistration).not.toContain('ASCII_EVENT_TYPE_RE');
    expect(stripeRegistration).not.toContain('A-Za-z0-9._:/-');
    expect(stripeRegistration)
      .toContain('WebhookPrefixedAsciiTokenParser');
    expect(stripeRegistration).toContain('endpointSecretParser.parse');
    expect(stripeRegistration).toContain('WebhookBoundedHttpUrlParser');
    expect(stripeRegistration).toContain('remoteUrlParser.parse');
    expect(stripeRegistration.match(/remoteUrlParser\.parse/g)).toHaveLength(2);
    expect(stripeRegistration).not.toContain('const boundedRemoteUrl');
    expect(stripeRegistration).not.toContain('isValidStripeEndpointSecret');
    expect(stripeRegistration).not.toContain('stripe-webhook-protocol');
    expect(stripeRegistration)
      .toContain('WebhookEnvironmentMappedPrefixedAsciiTokenClassifier');
    expect(stripeRegistration).toContain('apiKeyClassifier.classify');
    expect(stripeRegistration).not.toContain('environmentForApiKey');
    expect(stripeRegistration).not.toContain("'sk_test_'");
    expect(stripeRegistration).not.toContain("'rk_test_'");
    expect(stripeRegistration).not.toContain("'sk_live_'");
    expect(stripeRegistration).not.toContain("'rk_live_'");
    expect(paddleRegistration)
      .toContain('WebhookHttpOrOpaqueDestinationParser');
    expect(paddleRegistration).toContain('destinationParser.parse');
    expect(paddleRegistration)
      .toContain('destinationParser.preset.http_url_discriminator');
    expect(paddleRegistration)
      .toContain('destinationParser.preset.opaque_discriminator');
    expect(paddleRegistration).not.toContain('const boundedRemoteDestination');
    expect(paddleRegistration).not.toContain('const boundedRemoteUrl');
    expect(paddleRegistration).not.toContain("'url'");
    expect(paddleRegistration).not.toContain("'email'");
    expect(paddleRegistration).not.toContain('WebhookBoundedHttpUrlParser');
    expect(paddleRegistration)
      .toContain('WebhookEnvironmentMappedSegmentedAsciiTokenClassifier');
    expect(paddleRegistration).toContain('apiKeyClassifier.classify');
    expect(paddleRegistration).not.toContain('paddleApiKeyEnvironment');
    expect(paddleRegistration).not.toContain('PADDLE_API_KEY_RE');
    expect(paddleRegistration).not.toContain("'pdl_sdbx_apikey_'");
    expect(paddleRegistration).not.toContain("'pdl_live_apikey_'");
    expect(jsonEventNormalizer)
      .toContain('createWebhookAsciiEventTypeParser');
    expect(jsonEventNormalizer).not.toContain('EVENT_TYPE_RE');
    expect(flatFormEventNormalizer)
      .toContain('createWebhookAsciiEventTypeParser');
    expect(flatFormEventNormalizer).not.toContain('EVENT_TYPE_RE');
    expect(stripeProvider).toContain('WEBHOOK_JSON_OBJECT_DECODER_V1');
    expect(timestampedJsonNotificationProfile)
      .toContain('createWebhookTimestampedHmacMechanism');
    expect(paddleProfile).toContain('PADDLE_TIMESTAMPED_HMAC_MECHANISM_PRESET');
    expect(timestampedJsonNotificationProfile)
      .toContain('createWebhookJsonObjectDecoder');
    expect(paddleProfile).toContain('PADDLE_JSON_OBJECT_DECODER_PRESET');
    expect(timestampedJsonNotificationProfile)
      .toContain('createWebhookRfc3339TimestampParser');
    expect(paddleProfile).toContain('PADDLE_RFC3339_TIMESTAMP_PARSER_PRESET');
    expect(timestampedJsonNotificationProfile)
      .toContain('createWebhookFixedPrefixProviderIdParser');
    expect(paddleProfile).toContain('PADDLE_EVENT_ID_PARSER_PRESET');
    expect(paddleProfile).toContain('PADDLE_DELIVERY_ID_PARSER_PRESET');
    expect(timestampedJsonNotificationProfile)
      .toContain('createWebhookDotSegmentEventTypeParser');
    expect(paddleProfile).toContain('PADDLE_EVENT_TYPE_PARSER_PRESET');
    expect(timestampedJsonNotificationProfile)
      .toContain('createWebhookJsonObjectProviderIdExtractor');
    expect(paddleProfile).toContain('PADDLE_RESOURCE_ID_EXTRACTOR_PRESET');
    expect(timestampedJsonNotificationProfile)
      .toContain('createWebhookJsonRequiredObjectExtractor');
    expect(paddleProfile).toContain('PADDLE_DATA_OBJECT_EXTRACTOR_PRESET');
    expect(timestampedJsonNotificationProfile)
      .toContain('createWebhookJsonSingleNotificationNormalizer');
    expect(paddleProfile)
      .toContain('PADDLE_JSON_SINGLE_NOTIFICATION_NORMALIZER_PRESET');
    expect(timestampedJsonNotificationProfile)
      .toContain('createWebhookNormalizedSingleEventProjector');
    expect(paddleProfile)
      .toContain('PADDLE_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET');
    expect(timestampedJsonNotificationProfile).toContain('.project(');
    expect(timestampedJsonNotificationProfile)
      .toContain('createWebhookNormalizedDeliveryDeduplicator');
    expect(paddleProfile)
      .toContain('PADDLE_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET');
    expect(timestampedJsonNotificationProfile).toContain('.deduplicate(');
    expect(paddleProfile)
      .toContain('createTimestampedJsonSingleNotificationWebhookProfileAdapter');
    expect(paddleProfile)
      .toContain('createClockGatedTimestampedJsonSingleNotificationWebhookProfileAdapter');
    expect(paddleProfile)
      .toContain('createTimestampedJsonSingleNotificationWebhookCredentialShapeValidator');
    expect(paddleProfile).not.toContain('verifyAndDecode(');
    expect(paddleProfile).not.toContain('.authenticate(');
    expect(paddleProfile).not.toContain('.decode(');
    expect(paddleProfile).not.toContain('.normalize(');
    expect(paddleProfile).not.toContain('.deduplicate(');
    expect(paddleProfile).not.toContain('.project(');
    expect(paddleProfile).not.toContain("'paddle-hmac-sha256'");
    expect(paddleProfile).not.toContain('createHash');
    expect(paddleProfile).not.toContain("'paddle:notification:'");
    expect(paddleProfile).not.toContain("'paddle:event:'");
    expect(paddleProfile).not.toContain('notification.delivery_id');
    expect(paddleProfile).not.toContain('notification.event_id');
    expect(paddleProfile).not.toContain('provider_event_id:');
    expect(paddleProfile).not.toContain('provider_resource_id:');
    expect(paddleProfile).not.toContain('provider_event_type:');
    expect(paddleProfile).not.toContain('provider_occurred_at:');
    expect(paddleProfile).not.toContain('decoded_payload:');
    expect(paddleProfile).not.toContain('decodePaddleWebhookNotification');
    expect(paddleProfile).not.toContain('paddle-webhook-protocol');
    expect(paddleProtocol).not.toContain('WebhookJsonObjectDecoder');
    expect(paddleProtocol).not.toContain('WebhookRfc3339TimestampParser');
    expect(paddleProtocol).not.toContain('WebhookFixedPrefixProviderIdParser');
    expect(paddleProtocol).not.toContain('WebhookDotSegmentEventTypeParser');
    expect(paddleProtocol).not.toContain('WebhookJsonObjectProviderIdExtractor');
    expect(paddleProtocol).not.toContain('WebhookJsonRequiredObjectExtractor');
    expect(paddleProtocol).not.toContain('DecodedPaddleWebhookNotification');
    expect(paddleProtocol).not.toContain('decodePaddleWebhookNotification');
    expect(paddleProtocol).not.toContain('notification_id');
    expect(paddleProtocol).not.toContain('occurred_at');
    expect(paddleProtocol).not.toContain('resource_id');
    expect(paddleProtocol).not.toContain('WEBHOOK_JSON_OBJECT_DECODER_V1');
    expect(paddleProtocol).not.toContain('TextDecoder');
    expect(paddleProtocol).not.toContain('JSON.parse');
    expect(paddleProtocol).not.toContain('MAX_PADDLE_JSON_');
    expect(paddleProtocol).not.toContain('PROTOTYPE_SENSITIVE_KEYS');
    expect(paddleProtocol).not.toContain('isBoundedPaddleJsonGraph');
    expect(paddleProtocol).not.toContain('RFC3339_RE');
    expect(paddleProtocol).not.toContain('parsePaddleOccurredAt');
    expect(paddleProtocol).not.toContain('isLeapYear');
    expect(paddleProtocol).not.toContain('Date.UTC');
    expect(paddleProtocol).not.toContain('MAX_PADDLE_OCCURRED_AT_BYTES');
    expect(paddleProtocol).not.toContain('PADDLE_EVENT_ID_RE');
    expect(paddleProtocol).not.toContain('PADDLE_NOTIFICATION_ID_RE');
    expect(paddleProtocol).not.toContain('/^evt_');
    expect(paddleProtocol).not.toContain('/^ntf_');
    expect(paddleProtocol).not.toContain('PADDLE_EVENT_TYPE_RE');
    expect(paddleProtocol).not.toContain('MAX_PADDLE_EVENT_TYPE_BYTES');
    expect(paddleProtocol).not.toContain('isValidPaddleEventType');
    expect(paddleProtocol).not.toContain('MAX_PADDLE_RESOURCE_ID_BYTES');
    expect(paddleProtocol).not.toContain('paddleResourceId');
    expect(paddleProtocol).not.toContain('data.id');
    expect(paddleProtocol).not.toContain('envelope.data');
    expect(paddleProtocol).not.toContain("typeof data !== 'object'");
    expect(paddleProtocol).not.toContain('Array.isArray(data)');
    expect(paddleRegistration).toContain('WebhookDotSegmentEventTypeParser');
    expect(paddleRegistration).not.toContain('isValidPaddleEventType');
    expect(paddleRegistration)
      .toContain('WebhookRegistrationJsonResponseReader');
    expect(paddleRegistration).toContain('responseReader.readText');
    expect(paddleRegistration).toContain('responseReader.readJson');
    expect(paddleRegistration).not.toContain('TextDecoder');
    expect(paddleRegistration).not.toContain('JSON.parse');
    expect(paddleRegistration)
      .not.toContain('MAX_PADDLE_REGISTRATION_RESPONSE_BYTES');
    expect(paddleRegistration)
      .toContain('WebhookRegistrationIdempotencyKeyParser');
    expect(paddleRegistration).toContain('parser.parse');
    expect(paddleRegistration).not.toContain('IDEMPOTENCY_KEY_RE');
    expect(paddleRegistration)
      .toContain('WebhookFixedPrefixProviderIdParser');
    expect(paddleRegistration).toContain('remoteIdParser.parse');
    expect(paddleRegistration).not.toContain('PADDLE_REMOTE_ID_RE');
    expect(paddleRegistration)
      .toContain('WebhookSegmentedAsciiTokenParser');
    expect(paddleRegistration).toContain('endpointSecretParser.parse');
    expect(paddleRegistration)
      .not.toContain('isValidPaddleEndpointSecretKey');
    expect(paddleRegistration).not.toContain('paddle-webhook-protocol');
    expect(registrationPresets)
      .toContain('webhookDotSegmentEventTypeProfilePreset');
    expect(registrationPresets)
      .toContain('createWebhookDotSegmentEventTypeParser');
    expect(registrationPresets)
      .toContain('webhookLowercaseIdentifierEventTypeProfilePreset');
    expect(registrationPresets)
      .toContain('createWebhookLowercaseIdentifierEventTypeParser');
    expect(registrationPresets)
      .toContain('webhookAsciiIdentifierEventTypeProfilePreset');
    expect(registrationPresets).toContain('createWebhookAsciiIdentifierParser');
    expect(registrationPresets)
      .toContain('webhook-shared-profile-parser-presets');
    expect(registrationPresets)
      .not.toContain('webhook-delivery-engine-presets');
    expect(slackProfile).not.toContain('createWebhookTimestampedHmacMechanism');
    expect(slackProfile).toContain('SLACK_TIMESTAMPED_HMAC_MECHANISM_PRESET');
    expect(slackProfile).not.toContain('createWebhookJsonObjectDecoder');
    expect(slackProfile).toContain('SLACK_JSON_OBJECT_DECODER_PRESET');
    expect(slackProfile).not.toContain('createWebhookFormUrlencodedDecoder');
    expect(slackProfile).toContain('SLACK_FORM_URLENCODED_DECODER_PRESET');
    expect(slackProfile).not.toContain('createWebhookFormWrappedJsonDecoder');
    expect(slackProfile).toContain('SLACK_FORM_WRAPPED_JSON_DECODER_PRESET');
    expect(slackProfile).not.toContain('createWebhookFlatFormEventNormalizer');
    expect(slackProfile).toContain('SLACK_FLAT_FORM_EVENT_NORMALIZER_PRESET');
    expect(slackProfile).not.toContain('createWebhookJsonChallengeProjector');
    expect(slackProfile).toContain('SLACK_JSON_CHALLENGE_PROJECTOR_PRESET');
    expect(slackProfile)
      .not.toContain('createWebhookNormalizedSingleEventProjector');
    expect(slackProfile).toContain('SLACK_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET');
    expect(slackProfile)
      .not.toContain('createWebhookNormalizedDeliveryDeduplicator');
    expect(slackProfile).toContain('SLACK_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET');
    expect(slackProfile).not.toContain('createWebhookJsonEventNormalizer');
    expect(slackProfile).toContain('SLACK_JSON_EVENT_NORMALIZER_PRESET');
    expect(slackProfile)
      .toContain('createTimestampedJsonFormSingleEventWebhookProfileAdapter');
    expect(slackProfile)
      .toContain('createClockGatedTimestampedJsonFormSingleEventWebhookProfileAdapter');
    expect(slackProfile)
      .toContain('createTimestampedJsonFormSingleEventWebhookCredentialShapeValidator');
    expect(timestampedJsonFormProfile)
      .toContain('createWebhookTimestampedHmacMechanism');
    expect(timestampedJsonFormProfile).toContain('createWebhookJsonObjectDecoder');
    expect(timestampedJsonFormProfile)
      .toContain('createWebhookFormUrlencodedDecoder');
    expect(timestampedJsonFormProfile)
      .toContain('createWebhookFormWrappedJsonDecoder');
    expect(timestampedJsonFormProfile)
      .toContain('createWebhookFlatFormEventNormalizer');
    expect(timestampedJsonFormProfile)
      .toContain('createWebhookJsonChallengeProjector');
    expect(timestampedJsonFormProfile)
      .toContain('createWebhookNormalizedSingleEventProjector');
    expect(timestampedJsonFormProfile)
      .toContain('createWebhookNormalizedDeliveryDeduplicator');
    expect(timestampedJsonFormProfile)
      .toContain('createWebhookJsonEventNormalizer');
    expect(slackProtocol).not.toContain('WebhookJsonObjectDecoder');
    expect(slackProtocol).not.toContain('WebhookFormUrlencodedDecoder');
    expect(slackProtocol).not.toContain('WebhookFormWrappedJsonDecoder');
    expect(slackProtocol).not.toContain('WebhookFlatFormEventNormalizer');
    expect(slackProtocol).not.toContain('WebhookJsonEventNormalizer');
    expect(slackProtocol).not.toContain('decodeSlackWebhookRequest');
    expect(slackProtocol).not.toContain('decodeSlackWebhookFormRequest');
    expect(slackProtocol).not.toContain('WEBHOOK_JSON_OBJECT_DECODER_V1');
    expect(slackProtocol).not.toContain('WEBHOOK_FORM_URLENCODED_DECODER_V1');
    expect(slackProtocol).not.toContain('MAX_SLACK_EVENT_TYPE_BYTES');
    expect(slackProtocol).not.toContain('MAX_SLACK_CHALLENGE_BYTES');
    expect(slackProtocol).not.toContain('SLACK_EVENT_TYPE_RE');
    expect(slackProtocol).not.toContain('envelope.team_id');
    expect(slackProtocol).not.toContain('envelope.event_time');
    expect(slackProtocol).not.toContain("'event_callback'");
    expect(slackProtocol).not.toContain('normalized.payload.event');
    expect(slackProtocol)
      .not.toContain("hasOwnProperty.call(fields, 'payload')");
    expect(slackProtocol).not.toContain('keys.length !== 1');
    expect(slackProtocol).not.toContain('SLACK_COMMAND_RE');
    expect(slackProtocol).not.toContain("'slash_command'");
    expect(slackProtocol).not.toContain('fields.command');
    expect(slackProtocol).not.toContain('fields.team_id');
    expect(slackProtocol).not.toContain('fields.trigger_id');
    expect(slackProfile).not.toContain('verifySlackWebhookSignature');
    expect(slackProfile).not.toContain('SLACK_REQUEST_TIMESTAMP_HEADER');
    expect(slackProfile).not.toContain('SLACK_SIGNATURE_HEADER');
    expect(slackProfile).not.toContain("'url_verification'");
    expect(slackProfile).not.toContain('JSON.stringify({ challenge');
    expect(slackProfile).not.toContain('provider_event_id:');
    expect(slackProfile).not.toContain('provider_resource_id:');
    expect(slackProfile).not.toContain('provider_event_type:');
    expect(slackProfile).not.toContain('provider_occurred_at:');
    expect(slackProfile).not.toContain('decoded_payload:');
    expect(slackProfile).not.toContain('createHash');
    expect(slackProfile).not.toContain("'slack:event:'");
    expect(slackProfile).not.toContain("'slack:request:'");
    expect(slackProfile).not.toContain('decoded.event_id');
    expect(slackProfile).not.toContain('verifyAndDecode(');
    expect(slackProfile).not.toContain('handleHandshake(');
    expect(slackProfile).not.toContain('.authenticate(');
    expect(slackProfile).not.toContain('.decode(');
    expect(slackProfile).not.toContain('.normalize(');
    expect(slackProfile).not.toContain('.classify(');
    expect(slackProfile).not.toContain('.deduplicate(');
    expect(slackProfile).not.toContain('.project(');
    expect(slackProfile).not.toContain("'slack-signature-v0'");
  });

  it('selects Stripe and Paddle through one vendor-neutral addressable-collection driver', () => {
    const driver = source(
      'backend/server/src/webhook-addressable-collection-registration-driver.ts',
    );
    const driverLower = driver.toLowerCase();
    const presets = source(
      'backend/server/src/webhook-registration-driver-profile-presets.ts',
    );
    const stripe = source(
      'backend/server/src/connections/providers/stripe-webhook-registration.ts',
    );
    const paddle = source(
      'backend/server/src/connections/providers/paddle-webhook-registration.ts',
    );

    for (const profileId of VENDOR_PROFILE_IDS) {
      expect(driverLower).not.toContain(profileId);
    }
    for (const vendor of VENDOR_NAMES) {
      expect(driverLower).not.toContain(vendor);
    }
    for (const authorityFragment of [
      'https://',
      'fetch(',
      "method: 'get'",
      "method: 'post'",
      "method: 'patch'",
      "method: 'delete'",
    ]) {
      expect(driverLower).not.toContain(authorityFragment);
    }
    expect(driver).toContain("kind: 'addressable_endpoint_collection.v1'");
    expect(driver).toContain("kind: 'bounded_after_id.v1'");
    expect(driver).toContain('preset.pagination.max_pages');
    expect(driver).toContain('preset.pagination.page_size');
    expect(driver).toContain('prepareSearch');
    expect(driver).toContain('readSearchPage');

    expect(presets).toContain('stripe.event.v1');
    expect(presets).toContain('paddle.notification.v1');
    expect(presets).toContain("kind: 'addressable_endpoint_collection.v1'");
    for (const fixture of [stripe, paddle]) {
      expect(fixture).toContain(
        'createWebhookAddressableCollectionRegistrationDriver',
      );
      expect(fixture).toContain(
        'webhookAddressableCollectionRegistrationDriverPreset',
      );
    }
    expect(stripe).not.toContain('MAX_STRIPE_LIST_PAGES');
    expect(stripe).not.toContain('STRIPE_LIST_PAGE_SIZE');
    expect(paddle).not.toContain('MAX_PADDLE_LIST_PAGES');
    expect(paddle).not.toContain('PADDLE_LIST_PAGE_SIZE');

    for (const path of [
      'packages/contracts/src/webhook-profiles.ts',
      'packages/contracts/src/webhook-owner-profile-settings.ts',
      'backend/server/src/webhook-profile-policy.ts',
      'apps/webclient/src/connections/webhooks-panel.ts',
    ]) {
      expect(
        source(path),
        `${path} must not expose the code-backed driver kind`,
      ).not.toContain('addressable_endpoint_collection.v1');
    }
  });

  it('selects GitHub through the vendor-neutral target-scoped collection driver', () => {
    const driver = source(
      'backend/server/src/webhook-target-scoped-collection-registration-driver.ts',
    );
    const driverLower = driver.toLowerCase();
    const presets = source(
      'backend/server/src/webhook-registration-driver-profile-presets.ts',
    );
    const github = source(
      'backend/server/src/connections/providers/github-webhook-registration.ts',
    );

    for (const profileId of VENDOR_PROFILE_IDS) {
      expect(driverLower).not.toContain(profileId);
    }
    for (const vendor of VENDOR_NAMES) {
      expect(driverLower).not.toContain(vendor);
    }
    for (const authorityFragment of [
      'https://',
      'fetch(',
      "method: 'get'",
      "method: 'post'",
      "method: 'patch'",
      "method: 'delete'",
    ]) {
      expect(driverLower).not.toContain(authorityFragment);
    }
    expect(driver)
      .toContain("kind: 'target_scoped_endpoint_collection.v1'");
    expect(driver).toContain("kind: 'bounded_page_number.v1'");
    expect(driver).toContain('preset.pagination.max_pages');
    expect(driver).toContain('preset.pagination.page_size');
    expect(driver).toContain('prepareSearch');
    expect(driver).toContain('readSearchPage');

    expect(presets).toContain('github.webhook.v1');
    expect(presets)
      .toContain("kind: 'target_scoped_endpoint_collection.v1'");
    expect(github).toContain(
      'createWebhookTargetScopedCollectionRegistrationDriver',
    );
    expect(github).toContain(
      'webhookTargetScopedCollectionRegistrationDriverPreset',
    );
    expect(github).not.toContain('MAX_GITHUB_LIST_PAGES');
    expect(github).not.toContain('GITHUB_LIST_PAGE_SIZE');
    expect(github).not.toContain('for (let page');
    expect(github).not.toContain(
      'GitHub webhook search exceeded its bounded page limit',
    );

    for (const path of [
      'packages/contracts/src/webhook-profiles.ts',
      'packages/contracts/src/webhook-owner-profile-settings.ts',
      'backend/server/src/webhook-profile-policy.ts',
      'apps/webclient/src/connections/webhooks-panel.ts',
    ]) {
      expect(
        source(path),
        `${path} must not expose the code-backed driver kind`,
      ).not.toContain('target_scoped_endpoint_collection.v1');
    }
  });

  it('selects Telegram through the vendor-neutral provider-singleton driver', () => {
    const driver = source(
      'backend/server/src/webhook-provider-singleton-registration-driver.ts',
    );
    const driverLower = driver.toLowerCase();
    const presets = source(
      'backend/server/src/webhook-registration-driver-profile-presets.ts',
    );
    const telegram = source(
      'backend/server/src/connections/providers/telegram-webhook-registration.ts',
    );

    for (const profileId of VENDOR_PROFILE_IDS) {
      expect(driverLower).not.toContain(profileId);
    }
    for (const vendor of VENDOR_NAMES) {
      expect(driverLower).not.toContain(vendor);
    }
    for (const authorityFragment of [
      'https://',
      'fetch(',
      "method: 'get'",
      "method: 'post'",
      "method: 'patch'",
      "method: 'delete'",
    ]) {
      expect(driverLower).not.toContain(authorityFragment);
    }
    expect(driver).toContain("kind: 'provider_singleton_endpoint.v1'");
    expect(driver).toContain('snapshotDenseArrayValues(inspection.matches, 1)');
    expect(driver).toContain('inspect');

    expect(presets).toContain('telegram.bot-webhook.v1');
    expect(presets).toContain("kind: 'provider_singleton_endpoint.v1'");
    expect(telegram).toContain(
      'createWebhookProviderSingletonRegistrationDriver',
    );
    expect(telegram).toContain(
      'webhookProviderSingletonRegistrationDriverPreset',
    );
    expect(telegram).not.toContain('async find(context)');
    expect(telegram).not.toContain("profile_id: 'telegram.bot-webhook.v1'");

    for (const path of [
      'packages/contracts/src/webhook-profiles.ts',
      'packages/contracts/src/webhook-owner-profile-settings.ts',
      'backend/server/src/webhook-profile-policy.ts',
      'apps/webclient/src/connections/webhooks-panel.ts',
    ]) {
      expect(
        source(path),
        `${path} must not expose the code-backed driver kind`,
      ).not.toContain('provider_singleton_endpoint.v1');
    }
  });
});
