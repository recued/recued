/** D-201 Slice 0 — portable trusted-profile registry and pack requirement
 * validation.  No test here opens a listener or treats registry presence as a
 * runtime adapter: this slice proves only the serializable contract boundary. */

import { describe, expect, it } from 'vitest';

import {
  BULK_PACK_INSTALL_PERMISSION,
  BULK_PACK_MANIFEST_VERSION_V2,
  parseBulkPackManifest,
} from '../bulk-pack.js';
import {
  WEBHOOK_PROFILE_IDS,
  WEBHOOK_PROFILE_REGISTRY,
  isWebhookProfileId,
  validateRecipeWebhookTrigger,
  validateWebhookProfileRegistry,
  validateWebhookRequirement,
  validateWebhookRequirements,
  validateWebhookTriggerBindings,
  webhookProfile,
  webhookProfileAcceptsEventType,
  webhookProfileRequiresPairedConnection,
  type PackWebhookRequirement,
} from '../webhook-profiles.js';
import {
  WEBHOOK_OWNER_PROFILE_SETTINGS,
  webhookOwnerTextForEnvironment,
} from '../webhook-owner-profile-settings.js';

const stripeRequirement = (
  overrides: Partial<PackWebhookRequirement> = {},
): PackWebhookRequirement => ({
  binding: 'billing_events',
  profile_ids: ['stripe.event.v1'],
  paired_connection_slot: 'stripe',
  required_event_types: ['checkout.session.completed', 'invoice.paid'],
  registration_modes: ['manual'],
  environment_policy: 'match_connection',
  decoded_payload_access: 'scoped_read',
  source_truth_policy: 'provider_readback_required',
  ...overrides,
});

const basePack = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  manifest_version: BULK_PACK_MANIFEST_VERSION_V2,
  slug: 'stripe-workflows',
  publisher: 'community-author',
  name: 'Stripe workflows',
  description: 'Webhook profile contract fixture',
  version: 1,
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: [],
  contents: [{ type: 'recipe', slug: 'stripe-listener', version: 1 }],
  ...extra,
});

const issueCodes = (value: unknown): string[] =>
  validateWebhookRequirement(value).map((issue) => issue.code);

const expectDeeplyFrozen = (value: unknown, seen = new WeakSet<object>()): void => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    expectDeeplyFrozen((value as Record<PropertyKey, unknown>)[key], seen);
  }
};

describe('D-201 trusted portable profile registry', () => {
  it('derives paired-connection lifecycle from profile capability and mechanism, never vendor', () => {
    const stripe = webhookProfile('stripe.event.v1')!;
    const generic = webhookProfile('generic.static-header-token.v1')!;
    expect(webhookProfileRequiresPairedConnection(stripe, 'managed_endpoint')).toBe(true);
    expect(webhookProfileRequiresPairedConnection(stripe, 'manual')).toBe(false);
    expect(webhookProfileRequiresPairedConnection(generic, 'operation_bound')).toBe(true);
    expect(webhookProfileRequiresPairedConnection(generic, 'manual')).toBe(false);
  });

  it('covers every profile with deeply frozen serializable owner settings', () => {
    expect(Object.keys(WEBHOOK_OWNER_PROFILE_SETTINGS).sort())
      .toEqual([...WEBHOOK_PROFILE_IDS].sort());
    expect(Object.getPrototypeOf(WEBHOOK_OWNER_PROFILE_SETTINGS)).toBeNull();
    expectDeeplyFrozen(WEBHOOK_OWNER_PROFILE_SETTINGS);
    for (const profileId of WEBHOOK_PROFILE_IDS) {
      const settings = WEBHOOK_OWNER_PROFILE_SETTINGS[profileId];
      expect(settings.profile_id).toBe(profileId);
      expect(() => JSON.stringify(settings)).not.toThrow();
      expect(Object.keys(settings.create_instructions).sort())
        .toEqual([...WEBHOOK_PROFILE_REGISTRY[profileId].registration_modes].sort());
    }
    const github = WEBHOOK_OWNER_PROFILE_SETTINGS['github.webhook.v1'];
    expect(github.registration_target).toMatchObject({
      modes: ['managed_endpoint'],
      key_normalization: 'lowercase',
      kinds: [
        { value: 'repository', key_placeholder: 'owner/repository' },
        { value: 'organization', key_placeholder: 'organization' },
      ],
    });
    expect(webhookOwnerTextForEnvironment(
      WEBHOOK_OWNER_PROFILE_SETTINGS['paddle.notification.v1']
        .managed_reconciliation_instructions,
      'test',
    )).toContain('Paddle Sandbox account');
  });

  it('contains only the pinned implemented ids and is prototype-safe', () => {
    expect(Object.keys(WEBHOOK_PROFILE_REGISTRY).sort()).toEqual([...WEBHOOK_PROFILE_IDS].sort());
    for (const profileId of WEBHOOK_PROFILE_IDS) {
      expect(isWebhookProfileId(profileId)).toBe(true);
      expect(webhookProfile(profileId)?.profile_id).toBe(profileId);
    }
    expect(isWebhookProfileId('constructor')).toBe(false);
    expect(isWebhookProfileId('toString')).toBe(false);
    expect(webhookProfile('__proto__')).toBeNull();
    expect(Object.getPrototypeOf(WEBHOOK_PROFILE_REGISTRY)).toBeNull();
    expect(Object.isFrozen(WEBHOOK_PROFILE_REGISTRY)).toBe(true);
    expect(Object.isFrozen(WEBHOOK_PROFILE_REGISTRY['stripe.event.v1'])).toBe(true);
    expect(Object.isFrozen(WEBHOOK_PROFILE_REGISTRY['stripe.event.v1'].fields)).toBe(true);
    expectDeeplyFrozen(WEBHOOK_PROFILE_REGISTRY);
    expect(validateWebhookProfileRegistry()).toEqual([]);
  });

  it('declares a bounded tombstone horizon and honest identity semantics for every profile', () => {
    const horizon = 45 * 24 * 60 * 60 * 1_000;
    for (const profileId of WEBHOOK_PROFILE_IDS) {
      expect(WEBHOOK_PROFILE_REGISTRY[profileId].deduplication.tombstone_horizon_ms)
        .toBe(horizon);
    }
    for (const profileId of [
      'stripe.event.v1',
      'paddle.notification.v1',
      'slack.slash-command.v1',
      'telegram.bot-webhook.v1',
      'github.webhook.v1',
    ] as const) {
      expect(WEBHOOK_PROFILE_REGISTRY[profileId].deduplication.identity)
        .toEqual({ kind: 'stable_provider_id' });
    }
    expect(WEBHOOK_PROFILE_REGISTRY['slack.request.v0'].deduplication.identity)
      .toEqual({ kind: 'stable_provider_id_or_signed_timestamp_body' });
    for (const profileId of [
      'generic.static-header-token.v1',
      'generic.raw-body-hmac-sha256.v1',
      'generic.http-basic.v1',
      'lemonsqueezy.webhook.v1',
    ] as const) {
      expect(WEBHOOK_PROFILE_REGISTRY[profileId].deduplication.identity).toEqual({
        kind: 'received_at_body_window',
        window_ms: 5 * 60 * 1_000,
      });
    }
    expect(WEBHOOK_PROFILE_REGISTRY['generic.timestamped-raw-body-hmac-sha256.v1']
      .deduplication.identity).toEqual({ kind: 'signed_timestamp_body' });
  });

  it('rejects invalid or internally inconsistent deduplication metadata', () => {
    const stripe = WEBHOOK_PROFILE_REGISTRY['stripe.event.v1'];
    expect(validateWebhookProfileRegistry({
      ...WEBHOOK_PROFILE_REGISTRY,
      'stripe.event.v1': {
        ...stripe,
        deduplication: {
          ...stripe.deduplication,
          tombstone_horizon_ms: 0,
        },
      },
    }).join('\n')).toContain(
      'deduplication tombstone horizon must be a positive safe integer',
    );
    expect(validateWebhookProfileRegistry({
      ...WEBHOOK_PROFILE_REGISTRY,
      'stripe.event.v1': {
        ...stripe,
        deduplication: {
          ...stripe.deduplication,
          identity: {
            ...stripe.deduplication.identity,
            ignored: true,
          },
        } as unknown as typeof stripe.deduplication,
      },
    }).join('\n')).toContain(
      'stable or signed deduplication identity must contain only kind',
    );

    const generic = WEBHOOK_PROFILE_REGISTRY['generic.static-header-token.v1'];
    expect(validateWebhookProfileRegistry({
      ...WEBHOOK_PROFILE_REGISTRY,
      'generic.static-header-token.v1': {
        ...generic,
        deduplication: {
          tombstone_horizon_ms: 1_000,
          identity: { kind: 'received_at_body_window', window_ms: 1_001 },
        },
      },
    }).join('\n')).toContain(
      'received-at body identity window must not outlive its tombstone horizon',
    );
  });

  it('rejects a notification-only registry entry that trusts callback payload state', () => {
    const stripe = WEBHOOK_PROFILE_REGISTRY['stripe.event.v1'];
    expect(validateWebhookProfileRegistry({
      'stripe.event.v1': {
        ...stripe,
        transport_assurance: 'notification_only',
        minimum_source_truth_policy: 'delivery_payload_allowed',
      },
    }).join('\n')).toContain('notification_only profiles must require provider read-back');
  });

  it('keeps notification-only admission vendor-specific and paired to pointer semantics', () => {
    const generic = WEBHOOK_PROFILE_REGISTRY['generic.http-basic.v1'];
    const issues = validateWebhookProfileRegistry({
      ...WEBHOOK_PROFILE_REGISTRY,
      'generic.http-basic.v1': {
        ...generic,
        mechanism_kind: 'unauthenticated_pointer',
        transport_assurance: 'notification_only',
        minimum_source_truth_policy: 'provider_readback_required',
      },
    }).join('\n');
    expect(issues).toContain('generic profiles may not use notification_only assurance');

    const stripe = WEBHOOK_PROFILE_REGISTRY['stripe.event.v1'];
    expect(validateWebhookProfileRegistry({
      ...WEBHOOK_PROFILE_REGISTRY,
      'stripe.event.v1': {
        ...stripe,
        transport_assurance: 'notification_only',
      },
    }).join('\n')).toContain(
      'notification_only assurance requires unauthenticated_pointer mechanism_kind',
    );
  });

  it('rejects missing and unexpected registry keys instead of trusting a type cast', () => {
    const missing = { ...WEBHOOK_PROFILE_REGISTRY } as Record<string, typeof WEBHOOK_PROFILE_REGISTRY['stripe.event.v1']>;
    delete missing['stripe.event.v1'];
    expect(validateWebhookProfileRegistry(missing)).toContain(
      "registry: missing required profile 'stripe.event.v1'",
    );

    const unexpected = {
      ...WEBHOOK_PROFILE_REGISTRY,
      'seller.shadow.v1': {
        ...WEBHOOK_PROFILE_REGISTRY['stripe.event.v1'],
        profile_id: 'stripe.event.v1' as const,
      },
    };
    expect(validateWebhookProfileRegistry(unexpected).join('\n')).toContain(
      "profile 'seller.shadow.v1': registry key is not in WEBHOOK_PROFILE_IDS",
    );
  });

  it('rejects prototype-sensitive profile field keys', () => {
    const stripe = WEBHOOK_PROFILE_REGISTRY['stripe.event.v1'];
    expect(validateWebhookProfileRegistry({
      ...WEBHOOK_PROFILE_REGISTRY,
      'stripe.event.v1': {
        ...stripe,
        fields: [{ ...stripe.fields[0]!, key: 'constructor' }],
      },
    }).join('\n')).toContain("invalid or reserved field key 'constructor'");
  });

  it('is JSON-safe metadata, not an executable verifier registry', () => {
    const serialized = JSON.stringify(WEBHOOK_PROFILE_REGISTRY);
    expect(serialized).toContain('stripe.event.v1');
    expect(serialized).not.toContain('verifyAndDecode');
    expect(serialized).not.toContain('signing_secret_value');
    expect(Object.values(WEBHOOK_PROFILE_REGISTRY).every((profile) => (
      Object.values(profile).every((value) => typeof value !== 'function')
    ))).toBe(true);
  });

  it('keeps open vendor event catalogs distinct from closed generic delivery', () => {
    const stripe = webhookProfile('stripe.event.v1');
    const generic = webhookProfile('generic.raw-body-hmac-sha256.v1');
    expect(stripe).not.toBeNull();
    expect(generic).not.toBeNull();
    expect(webhookProfileAcceptsEventType(stripe!, 'customer.future_event')).toBe(true);
    expect(webhookProfileAcceptsEventType(generic!, 'delivery')).toBe(true);
    expect(webhookProfileAcceptsEventType(generic!, 'invoice.paid')).toBe(false);
  });

  it('pins the generic timestamped primitive without exposing a signing DSL', () => {
    const profile = webhookProfile('generic.timestamped-raw-body-hmac-sha256.v1');
    expect(profile).toMatchObject({
      vendor: 'generic',
      mechanism_kind: 'timestamped_hmac',
      transport_assurance: 'authenticated',
      decoder_kind: 'json',
      event_types: { kind: 'closed', values: ['delivery'] },
      fields: [
        { key: 'signature_header', kind: 'text', required: true },
        { key: 'signing_secret', kind: 'secret', required: true },
      ],
    });
    expect(JSON.stringify(profile)).not.toMatch(
      /algorithm|canonicalization|base_string|tolerance|template|url/i,
    );
  });

  it('pins the dormant Slack slash-command lifecycle as a separate form-only profile', () => {
    const profile = webhookProfile('slack.slash-command.v1');
    expect(profile).toMatchObject({
      vendor: 'slack',
      mechanism_kind: 'timestamped_hmac',
      transport_assurance: 'authenticated',
      minimum_source_truth_policy: 'delivery_payload_allowed',
      decoder_kind: 'form_urlencoded',
      decoded_schema_id: 'slack.slash-command.v1',
      event_types: { kind: 'closed', values: ['slash_command'] },
      fields: [{
        key: 'signing_secret',
        kind: 'secret',
        required: true,
        source: 'vendor_generated',
      }],
      registration_modes: ['manual'],
      supported_environments: ['test', 'live', 'custom'],
      allowed_methods: ['POST'],
      allowed_content_types: ['application/x-www-form-urlencoded'],
      max_body_bytes: 1_048_576,
      max_events_per_delivery: 1,
      managed_registration_requires_connection: false,
      handshakes: [],
    });
    expect(webhookProfileAcceptsEventType(profile!, 'slash_command')).toBe(true);
    expect(webhookProfileAcceptsEventType(profile!, 'event_callback')).toBe(false);
    const settings = WEBHOOK_OWNER_PROFILE_SETTINGS['slack.slash-command.v1'];
    expect(settings.create_instructions.manual?.default)
      .toContain('Features > Slash Commands');
    expect(settings.create_instructions.manual?.default)
      .toContain('public distribution disabled');
    expect(settings.create_instructions.manual?.default)
      .toContain('Signing Secret from Basic Information');
    expect(settings.manual_confirmation_instructions.default)
      .toContain('do not use the Events API url_verification challenge');
    expect(settings.manual_confirmation_instructions.default)
      .toContain('ssl_check request is not supported');
    expect(settings.manual_confirmation_instructions.default)
      .toContain('withholds response_url and the deprecated token field');
    expect(settings.test_delivery_boundary)
      .toContain('No Recued-originated test delivery is available');
  });

  it('pins GitHub metadata and managed intent without making portable HTTP code', () => {
    const profile = webhookProfile('github.webhook.v1');
    expect(profile).toMatchObject({
      vendor: 'github',
      mechanism_kind: 'raw_body_hmac',
      transport_assurance: 'authenticated',
      minimum_source_truth_policy: 'delivery_payload_allowed',
      decoder_kind: 'json',
      decoded_schema_id: 'github.webhook.v1',
      event_types: {
        kind: 'open',
        known_values: expect.arrayContaining(['issues', 'pull_request', 'push']),
      },
      fields: [{
        key: 'webhook_secret',
        kind: 'secret',
        required: true,
        source: 'recued_generated',
      }],
      registration_modes: ['manual', 'managed_endpoint'],
      managed_registration_requires_connection: true,
    });
    expect(webhookProfileAcceptsEventType(profile!, 'future_github_event')).toBe(true);
    expect(JSON.stringify(profile)).not.toMatch(/verify|hmac_base|header_name|fetch|api_path/i);
  });

  it('pins Paddle notification metadata without exposing its signature grammar', () => {
    const profile = webhookProfile('paddle.notification.v1');
    expect(profile).toMatchObject({
      vendor: 'paddle',
      mechanism_kind: 'timestamped_hmac',
      transport_assurance: 'authenticated',
      minimum_source_truth_policy: 'delivery_payload_allowed',
      decoder_kind: 'json',
      decoded_schema_id: 'paddle.notification.v1',
      event_types: {
        kind: 'open',
        known_values: expect.arrayContaining([
          'api_key_exposure.created',
          'flow_session.completed',
          'invoice.paid',
          'product_collection.updated',
          'subscription.updated',
          'transaction.completed',
        ]),
      },
      fields: [{
        key: 'endpoint_secret_key',
        kind: 'secret',
        required: true,
        source: 'vendor_generated',
      }],
      registration_modes: ['manual', 'managed_endpoint'],
      supported_environments: ['test', 'live'],
      managed_registration_requires_connection: true,
    });
    expect(webhookProfileAcceptsEventType(profile!, 'future_entity.created'))
      .toBe(true);
    expect(JSON.stringify(profile)).not.toMatch(
      /Paddle-Signature|h1|canonicalization|tolerance|fetch|api_path/i,
    );
  });

  it('pins Lemon Squeezy manual profile metadata without exposing its signature grammar', () => {
    const profile = webhookProfile('lemonsqueezy.webhook.v1');
    expect(profile).toMatchObject({
      vendor: 'lemonsqueezy',
      mechanism_kind: 'raw_body_hmac',
      transport_assurance: 'authenticated',
      minimum_source_truth_policy: 'delivery_payload_allowed',
      decoder_kind: 'json',
      decoded_schema_id: 'lemonsqueezy.webhook.v1',
      event_types: {
        kind: 'open',
        known_values: expect.arrayContaining([
          'order_created',
          'subscription_payment_success',
          'affiliate_activated',
        ]),
      },
      fields: [{
        key: 'signing_secret',
        kind: 'secret',
        required: true,
        source: 'owner',
      }],
      registration_modes: ['manual'],
      supported_environments: ['test', 'live'],
      managed_registration_requires_connection: false,
    });
    expect(webhookProfileAcceptsEventType(profile!, 'future_event')).toBe(true);
    expect(JSON.stringify(profile)).not.toMatch(
      /X-Signature|X-Event-Name|hmac_base|canonicalization|fetch|api_path/i,
    );
    const settings = WEBHOOK_OWNER_PROFILE_SETTINGS['lemonsqueezy.webhook.v1'];
    expect(settings.create_instructions.manual?.default)
      .toContain('Settings > Webhooks');
    expect(settings.test_delivery_boundary)
      .toContain('No Recued-originated test delivery is available');
  });
});

describe('D-201 webhook requirement validation', () => {
  it('accepts a Stripe requirement only with its strong read-back + connection declaration', () => {
    expect(validateWebhookRequirement(stripeRequirement())).toEqual([]);
  });

  it('rejects unknown profiles, weak source truth, and a missing read-back connection', () => {
    expect(issueCodes(stripeRequirement({
      profile_ids: ['future.vendor.v1' as never],
    }))).toContain('profile_unknown');

    const weak = validateWebhookRequirement(stripeRequirement({
      paired_connection_slot: undefined,
      source_truth_policy: 'delivery_payload_allowed',
      environment_policy: 'any',
    }));
    expect(weak.map((issue) => issue.code)).toContain('source_truth_policy_too_weak');
    expect(weak.map((issue) => issue.code)).toContain('paired_connection_required');
  });

  it('rejects closed-profile event mismatches and duplicate/overlapping event declarations', () => {
    const issues = validateWebhookRequirement({
      binding: 'generic_delivery',
      profile_ids: ['generic.http-basic.v1'],
      required_event_types: ['invoice.paid', 'delivery', 'delivery'],
      optional_event_types: ['delivery'],
      decoded_payload_access: 'metadata_only',
      source_truth_policy: 'delivery_payload_allowed',
    });
    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'event_type_duplicate',
      'event_type_overlap',
      'event_type_incompatible',
    ]));
  });

  it('requires a paired connection for managed registration and match_connection', () => {
    const issues = validateWebhookRequirement({
      binding: 'messages',
      profile_ids: ['telegram.bot-webhook.v1'],
      required_event_types: ['message'],
      registration_modes: ['managed_endpoint'],
      environment_policy: 'match_connection',
      decoded_payload_access: 'metadata_only',
      source_truth_policy: 'delivery_payload_allowed',
    });
    expect(issues.map((issue) => issue.code)).toContain('paired_connection_required');

    expect(validateWebhookRequirement({
      binding: 'messages',
      profile_ids: ['telegram.bot-webhook.v1'],
      paired_connection_slot: 'telegram-bot',
      required_event_types: ['message'],
      registration_modes: ['managed_endpoint'],
      environment_policy: 'match_connection',
      decoded_payload_access: 'metadata_only',
      source_truth_policy: 'delivery_payload_allowed',
    })).toEqual([]);

    expect(validateWebhookRequirement(stripeRequirement({
      registration_modes: ['managed_endpoint'],
    }))).toEqual([]);
  });

  it('rejects requested registration modes unsupported by every named profile', () => {
    const issues = validateWebhookRequirement(stripeRequirement({
      registration_modes: ['manual', 'operation_bound'],
    }));
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'registration_mode_incompatible',
      message: expect.stringContaining("'operation_bound'"),
    }));
  });

  it('does not accept inherited requirement fields', () => {
    const inherited = Object.create(stripeRequirement()) as Record<string, unknown>;
    expect(validateWebhookRequirement(inherited)).toEqual([
      expect.objectContaining({ code: 'shape' }),
    ]);
  });

  it('rejects prototype-sensitive logical bindings and connection slots', () => {
    expect(validateWebhookRequirement(stripeRequirement({ binding: 'constructor' }))
      .map((issue) => issue.code)).toContain('binding_invalid');
    expect(validateWebhookRequirement(stripeRequirement({ paired_connection_slot: 'prototype' }))
      .map((issue) => issue.code)).toEqual(expect.arrayContaining([
        'paired_connection_invalid',
        'paired_connection_required',
      ]));
    expect(validateRecipeWebhookTrigger({
      binding: 'constructor',
      event_types: ['invoice.paid'],
    }).map((issue) => issue.code)).toContain('binding_invalid');
  });

  it('rejects sparse arrays instead of reading inherited array entries', () => {
    const sparseProfiles = new Array(1);
    const issues = validateWebhookRequirement({
      ...stripeRequirement(),
      profile_ids: sparseProfiles,
    });
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'profile_ids_invalid',
      path: 'profile_ids[0]',
    }));

    const sparseRequirements = new Array(1);
    expect(validateWebhookRequirements(sparseRequirements)).toContainEqual(expect.objectContaining({
      code: 'shape',
      path: 'webhook_requirements[0]',
    }));
  });

  it('caps the list and rejects duplicate logical bindings', () => {
    const duplicate = validateWebhookRequirements([
      stripeRequirement(),
      stripeRequirement({ required_event_types: ['invoice.payment_failed'] }),
    ]);
    expect(duplicate.map((issue) => issue.code)).toContain('binding_duplicate');
  });

  it('validates the strict recipe trigger grammar and requirement cross-reference', () => {
    expect(validateRecipeWebhookTrigger({
      binding: 'billing_events',
      event_types: ['invoice.paid'],
    })).toEqual([]);
    expect(validateRecipeWebhookTrigger({
      binding: 'billing_events',
      event_types: ['invoice.paid'],
      filter: { missing: 'passes' },
    }).map((issue) => issue.code)).toContain('unknown_field');

    expect(validateRecipeWebhookTrigger(Object.create({
      binding: 'billing_events',
      event_types: ['invoice.paid'],
    })).map((issue) => issue.code)).toContain('shape');

    const cross = validateWebhookTriggerBindings(
      [stripeRequirement()],
      [
        { binding: 'missing', event_types: ['invoice.paid'] },
        { binding: 'billing_events', event_types: ['charge.refunded'] },
      ],
    );
    expect(cross.map((issue) => issue.code)).toEqual([
      'trigger_binding_unknown',
      'trigger_event_undeclared',
    ]);
  });
});

describe('D-201 BulkPackManifest integration', () => {
  it('accepts registered webhook requirements for non-core publishers', () => {
    const parsed = parseBulkPackManifest(basePack({
      webhook_requirements: [stripeRequirement()],
    }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.manifest.webhook_requirements).toEqual([stripeRequirement()]);
  });

  it('blocks unknown profile ids at the portable install parser', () => {
    const parsed = parseBulkPackManifest(basePack({
      webhook_requirements: [stripeRequirement({
        profile_ids: ['seller.supplied-scheme.v1' as never],
      })],
    }));
    expect(parsed.ok).toBe(false);
    expect(parsed.issues).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'pack_webhook_requirement_profile_unknown',
      path: 'webhook_requirements[0].profile_ids[0]',
    }));
  });
});
