/** D-201 Slice 10C — one portable grammar for every open event catalog.
 *
 * Before 10C every caller asked `webhookProfileAcceptsEventType`, which took
 * the broad `WEBHOOK_EVENT_TYPE_RE` for any open profile, while each profile's
 * runtime parser was narrower: an owner could select `Push` on GitHub or
 * `message.edited` on Telegram and the runtime then rejected every delivery
 * of it. Now an open catalog names its grammar, and these tests prove that one
 * set of names is admitted across every layer, for every open profile:
 * contracts, the runtime and registration parsers, the capability the server
 * projects to Settings, and the ingress RPC. Settings' own check is proven in
 * `apps/webclient/src/__tests__/d-174-p3-connections-route.test.ts`. */

import { createHmac } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WEBHOOK_PROFILE_IDS,
  WEBHOOK_PROFILE_REGISTRY,
  sameWebhookEventTypeGrammar,
  webhookEventTypeGrammarAccepts,
  webhookProfileAcceptsEventType,
  type WebhookEventTypeGrammar,
  type WebhookProfileId,
} from '@recued/contracts';
import {
  assertWebhookEventTypeParserMatchesProfile,
  webhookEventTypeParserFor,
  type WebhookEventTypeParserPresetData,
} from '../webhook-event-type-grammar-parity.js';
import {
  webhookAsciiEventTypeProfilePreset,
  webhookDotSegmentEventTypeProfilePreset,
  webhookLowercaseIdentifierEventTypeProfilePreset,
} from '../webhook-shared-profile-parser-presets.js';
import { webhookJsonApiSingleEventProfilePreset } from '../webhook-json-api-single-event-profile-presets.js';
import {
  webhookStaticHeaderTokenDeliveryProfilePreset,
  webhookTimestampedHmacDeliveryProfilePreset,
} from '../webhook-delivery-engine-presets.js';
import { webhookProfileRuntimeCapability } from '../webhook-profile-capability.js';
import {
  handleWebhookIngressCreate,
  handleWebhookIngressList,
  handleWebhookIngressUpdate,
  type WebhookIngressRpcDeps,
} from '../webhook-ingress-handler.js';
import { createWebhookIngressStore } from '../storage/webhook-ingress-store.js';
import { createLemonSqueezyWebhookProfileAdapter } from '../webhook-lemonsqueezy-profile.js';
import { createGitHubWebhookProfileAdapter } from '../webhook-github-profile.js';
import { createTelegramWebhookProfileAdapter } from '../webhook-telegram-profile.js';
import {
  GITHUB_DELIVERY_HEADER,
  GITHUB_EVENT_HEADER,
  GITHUB_HOOK_ID_HEADER,
  GITHUB_SIGNATURE_HEADER,
} from '../connections/providers/github-webhook-protocol.js';
import { TELEGRAM_SECRET_HEADER } from '../connections/providers/telegram-webhook-protocol.js';
import { STRIPE_SIGNATURE_HEADER } from '../connections/providers/stripe-webhook-protocol.js';
import { PADDLE_SIGNATURE_HEADER } from '../connections/providers/paddle-webhook-protocol.js';
import {
  SLACK_REQUEST_TIMESTAMP_HEADER,
  SLACK_SIGNATURE_HEADER,
} from '../connections/providers/slack-webhook-protocol.js';
import { createBuiltinWebhookDeliveryProfileAdapters } from '../webhook-delivery-profile-presets.js';
import { createClockGatedRecuedPeerWebhookProfileAdapter } from '../webhook-recued-peer-profile.js';
import { jsonSingleMemberEventTypeParserPreset } from '../webhook-json-single-member-event-normalizer.js';
import type { WebhookClockHealthAuthority } from '../webhook-clock-health.js';
import type {
  RawWebhookRequest,
  WebhookProfileResult,
  WebhookProfileRuntimeContext,
} from '../webhook-profile-runtime.js';

const OPEN_PROFILE_IDS = WEBHOOK_PROFILE_IDS.filter((profileId) =>
  WEBHOOK_PROFILE_REGISTRY[profileId].event_types.kind === 'open');

const grammarOf = (profileId: WebhookProfileId): WebhookEventTypeGrammar => {
  const catalog = WEBHOOK_PROFILE_REGISTRY[profileId].event_types;
  if (catalog.kind !== 'open') throw new Error(`${profileId} has a closed catalog`);
  return catalog.grammar;
};

/** Names that tell the grammars apart: open values outside every known list,
 *  and names the old global shape took that a narrower grammar does not. */
const CURATED = [
  // Open values each profile's grammar takes.
  'subscription_plan_changed',
  'merge_group',
  'security_advisory',
  'business_message',
  'message_reaction',
  'chat_boost',
  'Message',
  'customer.future_event',
  'v2.core.account:updated/x-y',
  'transaction.completed',
  'future_entity.created',
  'app_mention',
  'message.channels',
  // The member names the JSON reader refuses: Telegram's grammar leaves them
  // out (D-201 Slice 10G), the plain lowercase grammar does not.
  'constructor',
  'prototype',
  // Globally shaped (the old `WEBHOOK_EVENT_TYPE_RE` took them), narrower out.
  'Push',
  'Subscription_Plan_Changed',
  'pull_request.opened',
  'order-created',
  'order.created',
  'message.edited',
  'chat-boost',
  '1message',
  '_message',
  'transaction',
  'transaction.payment.failed',
  'Transaction.completed',
  'transaction.1completed',
  'transaction..completed',
  'transaction.completed.',
  'charge:refunded',
  'a/b',
  // Not names at all.
  '',
  ' ',
  'push ',
  'pull request',
  'é',
  'push\n',
  '😀',
  '\u0000',
];

/** A deterministic generator, so a failure names a value that reproduces. */
const mulberry32 = (seed: number): (() => number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const corpus = (): string[] => {
  const values = new Set<string>(CURATED);
  for (const profileId of WEBHOOK_PROFILE_IDS) {
    const catalog = WEBHOOK_PROFILE_REGISTRY[profileId].event_types;
    for (const value of catalog.kind === 'open' ? catalog.known_values : catalog.values) {
      values.add(value);
    }
  }
  // Every length bound, from each side.
  for (const length of [1, 2, 62, 63, 64, 65, 126, 127, 128, 129, 130, 200]) {
    values.add('a'.repeat(length));
    values.add('A'.repeat(length));
    values.add('7'.repeat(length));
    values.add(`a${'_'.repeat(length - 1)}`);
    values.add(`${'a'.repeat(length)}.b`);
    values.add(`b.${'a'.repeat(length)}`);
    values.add(`${'a'.repeat(length)}.${'b'.repeat(length)}`);
  }
  const random = mulberry32(0x10c);
  const pick = (alphabet: string): string =>
    alphabet[Math.floor(random() * alphabet.length)]!;
  const wide = 'azAZ079_.:/- é+#\n';
  const narrow = 'abz09_.';
  for (let i = 0; i < 1_500; i++) {
    const alphabet = i % 2 === 0 ? wide : narrow;
    const length = Math.floor(random() * 24);
    let value = '';
    for (let j = 0; j < length; j++) value += pick(alphabet);
    values.add(value);
  }
  // Dot-segmented names of every segment count up to four.
  for (let i = 0; i < 400; i++) {
    const segments: string[] = [];
    const count = 1 + Math.floor(random() * 4);
    for (let j = 0; j < count; j++) {
      const length = 1 + Math.floor(random() * 70);
      let segment = pick('abzAZ0_');
      for (let k = 1; k < length; k++) segment += pick('abz09_');
      segments.push(segment);
    }
    values.add(segments.join('.'));
  }
  return [...values];
};

const CORPUS = corpus();
const NON_STRINGS: unknown[] = [undefined, null, 7, true, {}, [], ['push']];

/** Every runtime and registration event-type parser preset composed for a
 *  profile, by where it comes from. */
const runtimeParserPresets = (
  profileId: WebhookProfileId,
): Array<{ source: string; preset: WebhookEventTypeParserPresetData }> => {
  const found: Array<{ source: string; preset: WebhookEventTypeParserPresetData }> = [];
  const shared: Array<[string, WebhookEventTypeParserPresetData | undefined]> = [
    ['shared ASCII event-type preset (runtime + registration)',
      webhookAsciiEventTypeProfilePreset(profileId)?.parser],
    ['shared lowercase identifier preset (runtime + registration)',
      webhookLowercaseIdentifierEventTypeProfilePreset(profileId)?.parser],
    ['shared dot-segment preset (runtime + registration)',
      webhookDotSegmentEventTypeProfilePreset(profileId)?.parser],
    ['JSON:API single-event preset (runtime)',
      webhookJsonApiSingleEventProfilePreset(profileId)?.event_type_parser],
  ];
  for (const [source, preset] of shared) {
    if (preset !== undefined) found.push({ source, preset });
  }
  const timestamped = webhookTimestampedHmacDeliveryProfilePreset(profileId)
    ?.event_normalizer;
  if (timestamped) {
    found.push({
      source: 'timestamped delivery event normalizer (runtime)',
      preset: {
        kind: timestamped.event_type_grammar,
        max_bytes: timestamped.event_type_max_bytes,
      },
    });
  }
  const staticHeader = webhookStaticHeaderTokenDeliveryProfilePreset(profileId)
    ?.event_normalizer;
  if (staticHeader) {
    found.push({
      source: 'static header-token event normalizer (runtime)',
      preset: jsonSingleMemberEventTypeParserPreset(staticHeader),
    });
  }
  return found;
};

/** The values on which two answers differ, at most a few, for the message. */
const disagreements = (
  values: readonly unknown[],
  left: (value: unknown) => boolean,
  right: (value: unknown) => boolean,
): unknown[] => values.filter((value) => left(value) !== right(value)).slice(0, 5);

describe('D-201 Slice 10C — one grammar for every open event catalog', () => {
  it('composes at least one runtime parser per open profile, each admitting exactly the profile grammar', () => {
    expect(OPEN_PROFILE_IDS).toEqual([
      'stripe.event.v1',
      'paddle.notification.v1',
      'lemonsqueezy.webhook.v1',
      'slack.request.v0',
      'telegram.bot-webhook.v1',
      'github.webhook.v1',
      'recued-peer.exchange.v1',
    ]);
    const all = [...CORPUS, ...NON_STRINGS];
    for (const profileId of OPEN_PROFILE_IDS) {
      const descriptor = WEBHOOK_PROFILE_REGISTRY[profileId];
      const presets = runtimeParserPresets(profileId);
      expect(presets.length, profileId).toBeGreaterThan(0);
      for (const { source, preset } of presets) {
        expect(sameWebhookEventTypeGrammar(grammarOf(profileId), preset), `${profileId}: ${source}`)
          .toBe(true);
        const parser = webhookEventTypeParserFor(preset);
        expect(disagreements(
          all,
          (value) => parser.parse(value) !== null,
          (value) => webhookProfileAcceptsEventType(descriptor, value),
        ), `${profileId}: ${source}`).toEqual([]);
      }
    }
  });

  it('answers the contracts check from the grammar alone, inside the old global shape', () => {
    for (const profileId of OPEN_PROFILE_IDS) {
      const descriptor = WEBHOOK_PROFILE_REGISTRY[profileId];
      const grammar = grammarOf(profileId);
      expect(disagreements(
        [...CORPUS, ...NON_STRINGS],
        (value) => webhookProfileAcceptsEventType(descriptor, value),
        (value) => webhookEventTypeGrammarAccepts(grammar, value),
      ), profileId).toEqual([]);
    }
    // Each narrower grammar refuses names the old global shape took.
    const accepts = (profileId: WebhookProfileId, value: string): boolean =>
      webhookProfileAcceptsEventType(WEBHOOK_PROFILE_REGISTRY[profileId], value);
    expect(accepts('lemonsqueezy.webhook.v1', 'subscription_plan_changed')).toBe(true);
    expect(accepts('lemonsqueezy.webhook.v1', 'Subscription_Plan_Changed')).toBe(false);
    expect(accepts('lemonsqueezy.webhook.v1', 'order.created')).toBe(false);
    expect(accepts('github.webhook.v1', 'merge_group')).toBe(true);
    expect(accepts('github.webhook.v1', 'Push')).toBe(false);
    expect(accepts('github.webhook.v1', 'pull_request.opened')).toBe(false);
    expect(accepts('telegram.bot-webhook.v1', 'business_message')).toBe(true);
    // D-201 Slice 10G — Telegram lowercases what it is given and sends only
    // lowercase names, so its grammar is lowercase too.
    expect(accepts('telegram.bot-webhook.v1', 'Message')).toBe(false);
    // The name is the Update's one JSON member, and the JSON reader refuses
    // these two as a member name anywhere in a delivery.
    expect(accepts('telegram.bot-webhook.v1', 'constructor')).toBe(false);
    expect(accepts('telegram.bot-webhook.v1', 'prototype')).toBe(false);
    expect(accepts('github.webhook.v1', 'constructor')).toBe(true);
    expect(accepts('telegram.bot-webhook.v1', 'message.edited')).toBe(false);
    expect(accepts('telegram.bot-webhook.v1', '1message')).toBe(false);
    expect(accepts('paddle.notification.v1', 'future_entity.created')).toBe(true);
    expect(accepts('paddle.notification.v1', 'transaction.payment.failed')).toBe(false);
    expect(accepts('paddle.notification.v1', `${'a'.repeat(64)}.created`)).toBe(false);
    expect(accepts('paddle.notification.v1', `${'a'.repeat(63)}.created`)).toBe(true);
    expect(accepts('stripe.event.v1', 'v2.core.account:updated/x-y')).toBe(true);
    expect(accepts('stripe.event.v1', 'a'.repeat(128))).toBe(true);
    expect(accepts('stripe.event.v1', 'a'.repeat(129))).toBe(false);
  });

  it('refuses at construction a runtime parser that admits a different language', () => {
    for (const profileId of OPEN_PROFILE_IDS) {
      const grammar = grammarOf(profileId);
      expect(() => assertWebhookEventTypeParserMatchesProfile(
        profileId,
        grammar as WebhookEventTypeParserPresetData,
        'fixture',
      )).not.toThrow();
      const variants: WebhookEventTypeParserPresetData[] = [];
      switch (grammar.kind) {
        case 'ascii_alphanumeric_dot_colon_slash_dash.v1':
        case 'ascii_identifier.v1':
          variants.push(
            { ...grammar, max_bytes: grammar.max_bytes - 1 },
            { kind: grammar.kind === 'ascii_identifier.v1'
              ? 'ascii_alphanumeric_dot_colon_slash_dash.v1'
              : 'ascii_identifier.v1', max_bytes: grammar.max_bytes },
          );
          break;
        case 'lowercase_identifier_event_type.v1':
          variants.push(
            { ...grammar, max_characters: grammar.max_characters - 1 },
            { kind: 'ascii_identifier.v1', max_bytes: grammar.max_characters },
          );
          break;
        case 'lowercase_dot_segment_event_type.v1':
          variants.push(
            { ...grammar, segment_count: grammar.segment_count + 1 },
            { ...grammar, max_segment_characters: grammar.max_segment_characters - 1 },
            { kind: 'lowercase_identifier_event_type.v1', max_characters: 127 },
          );
          break;
      }
      for (const variant of variants) {
        expect(() => assertWebhookEventTypeParserMatchesProfile(profileId, variant, 'fixture'),
          `${profileId} ${JSON.stringify(variant)}`)
          .toThrow(/admits a different event-type language/);
      }
    }
    // A closed catalog: the parser must take each listed name.
    expect(() => assertWebhookEventTypeParserMatchesProfile(
      'cal.webhook.v1',
      { kind: 'lowercase_identifier_event_type.v1', max_characters: 128 },
      'fixture',
    )).toThrow(/does not admit its closed event catalog/);
    expect(() => assertWebhookEventTypeParserMatchesProfile(
      'cal.webhook.v1',
      { kind: 'ascii_identifier.v1', max_bytes: 128 },
      'fixture',
    )).not.toThrow();
  });

  it('projects each catalog, grammar included, to Settings over the ingress list', async () => {
    const deps = makeDeps();
    const listed = await handleWebhookIngressList(deps, undefined, owner);
    // What Settings receives is what crosses the wire.
    const profiles = JSON.parse(JSON.stringify(listed.profiles)) as typeof listed.profiles;
    expect(profiles?.map((profile) => profile.profile_id)).toEqual([...WEBHOOK_PROFILE_IDS]);
    for (const profile of profiles ?? []) {
      expect(profile.event_types, profile.profile_id)
        .toEqual(WEBHOOK_PROFILE_REGISTRY[profile.profile_id].event_types);
      const catalog = profile.event_types!;
      if (catalog.kind !== 'open') continue;
      const descriptor = WEBHOOK_PROFILE_REGISTRY[profile.profile_id];
      expect(disagreements(
        [...CORPUS, ...NON_STRINGS],
        (value) => webhookEventTypeGrammarAccepts(catalog.grammar, value),
        (value) => webhookProfileAcceptsEventType(descriptor, value),
      ), profile.profile_id).toEqual([]);
    }
    // The projection is frozen data, never the registry's own objects.
    const capability = webhookProfileRuntimeCapability(
      WEBHOOK_PROFILE_REGISTRY['github.webhook.v1'],
      false,
    );
    expect(capability.registration_modes).toEqual(['manual']);
    expect(Object.isFrozen(capability.event_types)).toBe(true);
    expect(capability.event_types).not.toBe(WEBHOOK_PROFILE_REGISTRY['github.webhook.v1'].event_types);
  });

  it('creates and updates an ingress with exactly the names the grammar admits', async () => {
    const deps = makeDeps();
    for (const profileId of OPEN_PROFILE_IDS) {
      const descriptor = WEBHOOK_PROFILE_REGISTRY[profileId];
      const known = descriptor.event_types.kind === 'open'
        ? descriptor.event_types.known_values[0]!
        : '';
      const created = await createManual(deps, profileId, [known]);
      const strings = CORPUS.filter((_, index) => index % 3 === 0 || index < CURATED.length);
      // Expected from the grammar itself, not the contracts check the
      // handler also calls: one regression there must not move both sides.
      const grammar = grammarOf(profileId);
      for (const value of [...strings, ...NON_STRINGS]) {
        const expected = webhookEventTypeGrammarAccepts(grammar, value);
        const update = handleWebhookIngressUpdate(deps, {
          ingress_id: created.ingress.ingress_id,
          patch: { selected_event_types: [value as string] },
        }, owner);
        if (expected) {
          await expect(update, `${profileId} ${JSON.stringify(value)}`).resolves.toMatchObject({
            ingress: { selected_event_types: [value] },
          });
        } else {
          await expect(update, `${profileId} ${JSON.stringify(value)}`).rejects.toMatchObject({
            code: 'bad_request',
          });
        }
      }
      for (const value of CURATED) {
        const create = createManual(deps, profileId, [value]);
        if (webhookEventTypeGrammarAccepts(grammar, value)) {
          await expect(create, `${profileId} ${JSON.stringify(value)}`).resolves.toMatchObject({
            ingress: { selected_event_types: [value] },
          });
        } else {
          await expect(create, `${profileId} ${JSON.stringify(value)}`).rejects.toMatchObject({
            code: 'bad_request',
          });
        }
      }
    }
  });

  it('delivers an open name through the runtime and rejects a globally shaped one its grammar refuses', async () => {
    // Lemon Squeezy names its event in the signed body and a header.
    const lemon = createLemonSqueezyWebhookProfileAdapter();
    const lemonAccepted = await lemon.verifyAndDecode(
      lemonRequest('subscription_plan_changed'),
      runtimeContext({ signing_secret: LEMON_SECRET }),
    );
    expect(firstEventType(lemonAccepted)).toBe('subscription_plan_changed');
    for (const refused of ['Subscription_Plan_Changed', 'order.created', 'order-created']) {
      expect((await lemon.verifyAndDecode(
        lemonRequest(refused),
        runtimeContext({ signing_secret: LEMON_SECRET }),
      )).ok, refused).toBe(false);
    }

    // GitHub names it in a header.
    const github = createGitHubWebhookProfileAdapter();
    const githubAccepted = await github.verifyAndDecode(
      githubRequest('merge_group'),
      runtimeContext({ webhook_secret: GITHUB_SECRET }),
    );
    expect(firstEventType(githubAccepted)).toBe('merge_group');
    for (const refused of ['Push', 'pull_request.opened', 'check-run']) {
      expect((await github.verifyAndDecode(
        githubRequest(refused),
        runtimeContext({ webhook_secret: GITHUB_SECRET }),
      )).ok, refused).toBe(false);
    }

    // Telegram names it by the Update's one member.
    const telegram = createTelegramWebhookProfileAdapter();
    const telegramAccepted = await telegram.verifyAndDecode(
      telegramRequest('business_message'),
      runtimeContext({ secret_token: TELEGRAM_SECRET }),
    );
    expect(firstEventType(telegramAccepted)).toBe('business_message');
    for (const refused of ['message.edited', 'chat-boost', '1message']) {
      expect((await telegram.verifyAndDecode(
        telegramRequest(refused),
        runtimeContext({ secret_token: TELEGRAM_SECRET }),
      )).ok, refused).toBe(false);
    }
  });

  it('admits exactly the grammar through each composed runtime adapter, not only its parser preset', async () => {
    // D-201 Slice 10G (10D finding 16): the presets agreed while the composed
    // Telegram normalizer refused `constructor` and `prototype` by a rule of its
    // own. Each adapter as production composes it (the builtin list, on a
    // trusted clock), and the peer profile's from its own module, since the
    // builtin list does not mount it.
    const clock: WebhookClockHealthAuthority = {
      check: async () => ({
        healthy: true,
        trusted_now_ms: NOW_MS,
        maximum_error_ms: 1_000,
        checked_at: NOW_MS,
      }),
    };
    const composed = new Map(createBuiltinWebhookDeliveryProfileAdapters(clock)
      .map((adapter) => [adapter.profile_id, adapter]));
    composed.set('recued-peer.exchange.v1', createClockGatedRecuedPeerWebhookProfileAdapter(clock));
    const names = [...new Set([
      ...CURATED,
      'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty',
      '__proto__', '__defineGetter__', 'Constructor',
      'a'.repeat(127), 'a'.repeat(128), 'a'.repeat(129),
      `${'a'.repeat(63)}.created`, `${'a'.repeat(64)}.created`,
      ...OPEN_PROFILE_IDS.flatMap((profileId) => {
        const catalog = WEBHOOK_PROFILE_REGISTRY[profileId].event_types;
        return catalog.kind === 'open' ? catalog.known_values : [];
      }),
    ])];
    for (const profileId of OPEN_PROFILE_IDS) {
      const adapter = composed.get(profileId);
      expect(adapter, profileId).toBeDefined();
      const { credentials, request } = composedDelivery[profileId]!;
      const disagreeing: string[] = [];
      for (const name of names) {
        const result = await adapter!.verifyAndDecode(request(name), runtimeContext(credentials));
        const delivered = result.ok
          && result.delivery.events.length === 1
          && result.delivery.events[0]!.provider_event_type === name;
        if (delivered !== webhookProfileAcceptsEventType(WEBHOOK_PROFILE_REGISTRY[profileId], name)) {
          disagreeing.push(name);
        }
      }
      expect(disagreeing, profileId).toEqual([]);
    }
  });
});

const databases: Database.Database[] = [];
afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

const owner = { instance_id: 'owner-webclient' };

const makeDeps = (): WebhookIngressRpcDeps => {
  const db = new Database(':memory:');
  databases.push(db);
  let stamp = 1_900_000_000_000;
  return {
    store: createWebhookIngressStore(db, {
      now: () => ++stamp,
      getEncryptionKey: () => new Uint8Array(32).fill(7),
    }),
    profileCapabilities: WEBHOOK_PROFILE_IDS.map((profileId) =>
      webhookProfileRuntimeCapability(WEBHOOK_PROFILE_REGISTRY[profileId], true)),
    generateSecret: () => 'recued-generated-secret-once',
    countConsumerBindings: () => 0,
    pairedConnectionAvailable: () => true,
    runtimeReadiness: (ingress) => ({
      endpoint_url: `https://hooks.example/v1/webhooks/${ingress.public_id}`,
      profile_runtime_available: true,
      paired_connection_available: true,
      listener_available: true,
      public_reachability_enabled: true,
      tls_ready: true,
      clock_ready: true,
      test_delivery_supported: false,
      vault_unlocked: true,
      server_unpaused: true,
    }),
  };
};

const createManual = (
  deps: WebhookIngressRpcDeps,
  profileId: WebhookProfileId,
  selected: string[],
) => handleWebhookIngressCreate(deps, {
  display_name: `${profileId} events`,
  profile_id: profileId,
  environment: 'test',
  registration_mode: 'manual',
  selected_event_types: selected,
}, owner);

const NOW_MS = Date.parse('2026-11-19T12:00:00.000Z');
const LEMON_SECRET = 'lemonsqueezy-grammar-secret';
const GITHUB_SECRET = 'G'.repeat(43);
const TELEGRAM_SECRET = 'Telegram_grammar-token_d201';

const runtimeContext = (
  credentials: Record<string, string>,
): WebhookProfileRuntimeContext => ({
  ingress_id: 'whi_d201grammarfixture000000000000',
  environment: 'test',
  credential_versions: [{ version: '1', created_at: NOW_MS, credentials }],
  now: () => NOW_MS,
});

const firstEventType = (result: WebhookProfileResult): string | null => {
  if (!result.ok) throw new Error(`expected acceptance, got ${result.failure.code}`);
  return result.delivery.events[0]?.provider_event_type ?? null;
};

const rawRequest = (
  body: Buffer,
  headers: Array<[string, string]>,
): RawWebhookRequest => ({
  method: 'POST',
  raw_body: body,
  headers: new Map([
    ['content-type', ['application/json']],
    ...headers.map(([name, value]): [string, string[]] => [name, [value]]),
  ]),
  raw_path_and_query: '/v1/webhooks/grammar-fixture',
  canonical_public_url: 'https://hooks.example.test/v1/webhooks/grammar-fixture',
  received_at: NOW_MS,
  remote_ip: '127.0.0.1',
});

const lemonRequest = (eventName: string): RawWebhookRequest => {
  const body = Buffer.from(JSON.stringify({
    meta: { event_name: eventName, custom_data: { user_id: '123' } },
    data: {
      type: 'subscriptions',
      id: '129339',
      attributes: { store_id: 1, status: 'active', test_mode: true },
      links: { self: 'https://api.lemonsqueezy.com/v1/subscriptions/129339' },
    },
  }), 'utf8');
  return rawRequest(body, [
    ['x-signature', createHmac('sha256', LEMON_SECRET).update(body).digest('hex')],
    ['x-event-name', eventName],
  ]);
};

const githubRequest = (eventType: string): RawWebhookRequest => {
  const body = Buffer.from(JSON.stringify({
    action: 'checks_requested',
    repository: { id: 1_296_269, full_name: 'octocat/Hello-World' },
    sender: { id: 1, login: 'octocat' },
  }), 'utf8');
  return rawRequest(body, [
    [GITHUB_SIGNATURE_HEADER,
      `sha256=${createHmac('sha256', GITHUB_SECRET).update(body).digest('hex')}`],
    [GITHUB_DELIVERY_HEADER, '72d3162e-cc78-11e3-81ab-4c9367dc0958'],
    [GITHUB_EVENT_HEADER, eventType],
    [GITHUB_HOOK_ID_HEADER, '292430182'],
  ]);
};

const telegramRequest = (member: string): RawWebhookRequest => rawRequest(
  Buffer.from(JSON.stringify({
    update_id: 104_200,
    [member]: { message_id: 81, date: 1_752_000_000, chat: { id: 1, type: 'private' } },
  }), 'utf8'),
  [[TELEGRAM_SECRET_HEADER, TELEGRAM_SECRET]],
);


const NOW_SECONDS = Math.floor(NOW_MS / 1_000);
const STRIPE_SECRET = 'whsec_D201Slice10Grammar0123456789';
const PADDLE_SECRET =
  'pdl_ntfset_01gkpjp8bkm3tm53kdgkx6sms7_6h3qd3uFSi9YCD3OLYAShQI90XTI5vEI';
const SLACK_SECRET = 'slack-grammar-signing-secret';
const PEER_SECRET = 'peer-grammar-signing-secret';

const hmacHex = (secret: string, prefix: string, body: Buffer): string =>
  createHmac('sha256', secret).update(prefix).update(body).digest('hex');

/** One delivery per open profile, named by `name`, signed as its vendor signs. */
const composedDelivery: Partial<Record<WebhookProfileId, {
  credentials: Record<string, string>;
  request(name: string): RawWebhookRequest;
}>> = {
  'stripe.event.v1': {
    credentials: { endpoint_secret: STRIPE_SECRET },
    request: (name) => {
      const body = Buffer.from(JSON.stringify({
        id: 'evt_d201grammar',
        object: 'event',
        type: name,
        created: NOW_SECONDS,
        livemode: false,
        data: { object: { id: 'cus_d201grammar' } },
      }), 'utf8');
      return rawRequest(body, [[STRIPE_SIGNATURE_HEADER,
        `t=${NOW_SECONDS},v1=${hmacHex(STRIPE_SECRET, `${NOW_SECONDS}.`, body)}`]]);
    },
  },
  'paddle.notification.v1': {
    credentials: { endpoint_secret_key: PADDLE_SECRET },
    request: (name) => {
      const body = Buffer.from(JSON.stringify({
        event_id: 'evt_01gks14ge726w50ch2tmaw2a1x',
        event_type: name,
        occurred_at: '2026-11-19T11:59:58.125Z',
        notification_id: 'ntf_01ghbkd0frb9k95cnhwd1bxpvk',
        data: { id: 'sub_01h04vsc0qhwtsbsxh3422wjs4', status: 'active' },
      }), 'utf8');
      return rawRequest(body, [[PADDLE_SIGNATURE_HEADER,
        `ts=${NOW_SECONDS};h1=${hmacHex(PADDLE_SECRET, `${NOW_SECONDS}:`, body)}`]]);
    },
  },
  'lemonsqueezy.webhook.v1': {
    credentials: { signing_secret: LEMON_SECRET },
    request: lemonRequest,
  },
  'slack.request.v0': {
    credentials: { signing_secret: SLACK_SECRET },
    request: (name) => {
      const body = Buffer.from(JSON.stringify({
        type: name,
        event_id: 'Ev_d201grammar',
        team_id: 'T_d201grammar',
        event_time: NOW_SECONDS - 10,
        event: { type: 'message' },
      }), 'utf8');
      return rawRequest(body, [
        [SLACK_REQUEST_TIMESTAMP_HEADER, String(NOW_SECONDS)],
        [SLACK_SIGNATURE_HEADER, `v0=${hmacHex(SLACK_SECRET, `v0:${NOW_SECONDS}:`, body)}`],
      ]);
    },
  },
  'telegram.bot-webhook.v1': {
    credentials: { secret_token: TELEGRAM_SECRET },
    request: telegramRequest,
  },
  'github.webhook.v1': {
    credentials: { webhook_secret: GITHUB_SECRET },
    request: githubRequest,
  },
  'recued-peer.exchange.v1': {
    credentials: { signing_secret: PEER_SECRET },
    request: (name) => {
      const body = Buffer.from(JSON.stringify({
        v: '1',
        kind: name,
        action_ref: 'ref_d201grammar',
        ts: NOW_SECONDS,
        live: false,
        data: { id: 'booking_d201grammar' },
      }), 'utf8');
      return rawRequest(body, [['x-recued-signature',
        `t=${NOW_SECONDS},v1=${hmacHex(PEER_SECRET, `${NOW_SECONDS}.`, body)}`]]);
    },
  },
};
