import {
  WEBHOOK_PROFILE_IDS,
  type WebhookProfileId,
} from '@recued/contracts';
import { describe, expect, it } from 'vitest';

import {
  WEBHOOK_RAW_BODY_HMAC_DELIVERY_PROFILE_PRESETS,
  WEBHOOK_STATIC_HEADER_TOKEN_DELIVERY_PROFILE_PRESETS,
  WEBHOOK_TIMESTAMPED_HMAC_DELIVERY_PROFILE_PRESETS,
} from '../webhook-delivery-engine-presets.js';
import {
  WEBHOOK_FORM_URLENCODED_DECODER_V1,
} from '../webhook-form-urlencoded-decoder.js';
import {
  createWebhookFormWrappedJsonDecoder,
} from '../webhook-form-wrapped-json-decoder.js';
import {
  WEBHOOK_JSON_OBJECT_DECODER_V1,
  WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET,
} from '../webhook-json-object-decoder.js';
import {
  createPrimitiveWebhookProfileAdapters,
} from '../webhook-primitive-profiles.js';
import {
  createWebhookRawBodyHmacMechanism,
} from '../webhook-raw-body-hmac-engine.js';
import type {
  RawWebhookRequest,
  WebhookProfileRuntimeContext,
} from '../webhook-profile-runtime.js';
import {
  createWebhookStaticHeaderTokenMechanism,
} from '../webhook-static-header-token-engine.js';
import {
  createWebhookTimestampedHmacMechanism,
} from '../webhook-timestamped-hmac-engine.js';

const NOW_MS = 2_000_000_000_000;
const RAW_CASE_COUNT = 2_048;
const HEADER_CASE_COUNT = 1_024;
const ROUND_TRIP_CASE_COUNT = 64;
const MAX_GENERATED_RAW_BYTES = 1_048_577;
const MAX_GENERATED_HEADER_CODE_UNITS = 16_384;
const PROTOTYPE_SENSITIVE_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

interface DeterministicGenerator {
  next(): number;
  integer(maxExclusive: number): number;
}

const generator = (seed: number): DeterministicGenerator => {
  let state = seed >>> 0;
  return Object.freeze({
    next(): number {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state;
    },
    integer(maxExclusive: number): number {
      if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1) {
        throw new Error('deterministic generator bound is invalid');
      }
      return this.next() % maxExclusive;
    },
  });
};

const asciiText = (
  random: DeterministicGenerator,
  maxLength: number,
): string => {
  const alphabet =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    + ' _.-:/=+%,;{}[]"\\\n\r\t';
  const length = random.integer(maxLength + 1);
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += alphabet[random.integer(alphabet.length)]!;
  }
  return value;
};

const randomBytes = (
  random: DeterministicGenerator,
  maxLength: number,
): Buffer => {
  const value = Buffer.allocUnsafe(random.integer(maxLength + 1));
  for (let index = 0; index < value.length; index += 1) {
    value[index] = random.next() & 0xff;
  }
  return value;
};

const generatedJsonValue = (
  random: DeterministicGenerator,
  depth: number,
): unknown => {
  if (depth >= 6) {
    switch (random.integer(5)) {
      case 0: return null;
      case 1: return random.integer(2) === 0;
      case 2: return random.next();
      case 3: return asciiText(random, 48);
      default: return -random.integer(10_000);
    }
  }
  const kind = random.integer(7);
  if (kind <= 3) return generatedJsonValue(random, 6);
  if (kind === 4) {
    return Array.from(
      { length: random.integer(9) },
      () => generatedJsonValue(random, depth + 1),
    );
  }
  const record = Object.create(null) as Record<string, unknown>;
  const keyCount = random.integer(9);
  for (let index = 0; index < keyCount; index += 1) {
    const key = random.integer(17) === 0
      ? [...PROTOTYPE_SENSITIVE_KEYS][random.integer(3)]!
      : `field_${index}_${random.integer(1_000)}`;
    Object.defineProperty(record, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: generatedJsonValue(random, depth + 1),
    });
  }
  return record;
};

const generatedJsonBody = (random: DeterministicGenerator): Buffer => {
  const root = Object.create(null) as Record<string, unknown>;
  const fieldCount = 1 + random.integer(12);
  for (let index = 0; index < fieldCount; index += 1) {
    const key = random.integer(19) === 0
      ? [...PROTOTYPE_SENSITIVE_KEYS][random.integer(3)]!
      : `root_${index}_${random.integer(10_000)}`;
    Object.defineProperty(root, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: generatedJsonValue(random, 0),
    });
  }
  return Buffer.from(JSON.stringify(root), 'utf8');
};

const generatedSafeJsonBody = (random: DeterministicGenerator): Buffer =>
  Buffer.from(JSON.stringify({
    nonce: random.next(),
    safe: asciiText(random, 64),
  }), 'utf8');

const generatedFormBody = (random: DeterministicGenerator): Buffer => {
  const fields: string[] = [];
  const wrappedJson = random.integer(4) === 0;
  const fieldCount = wrappedJson ? 1 : 1 + random.integer(70);
  let previousKey = 'field_0';
  for (let index = 0; index < fieldCount; index += 1) {
    let key: string;
    if (wrappedJson && index === 0) {
      key = 'payload';
    } else if (random.integer(23) === 0) {
      key = [...PROTOTYPE_SENSITIVE_KEYS][random.integer(3)]!;
    } else if (random.integer(17) === 0) {
      key = previousKey;
    } else {
      key = `field_${index}_${random.integer(1_000)}`;
    }
    previousKey = key;
    const encodedKey = encodeURIComponent(key);
    const value = wrappedJson && index === 0
      ? generatedJsonBody(random).toString('utf8')
      : asciiText(random, 64);
    const encodedValue = encodeURIComponent(value);
    fields.push(random.integer(29) === 0
      ? `${encodedKey}=%ZZ${encodedValue}`
      : `${encodedKey}=${encodedValue}`);
  }
  return Buffer.from(fields.join('&'), 'utf8');
};

const RAW_EDGE_CASES: readonly Buffer[] = Object.freeze([
  Buffer.alloc(0),
  Buffer.from([0xff]),
  Buffer.from('\ufeff{"safe":true}', 'utf8'),
  Buffer.from('{"__proto__":{"__d201_parser_polluted__":true}}', 'utf8'),
  Buffer.from('{"constructor":{"prototype":{"polluted":true}}}', 'utf8'),
  Buffer.from('safe=%F0%9F%92%A9&value=ok', 'utf8'),
  Buffer.from('__proto__=polluted', 'utf8'),
  Buffer.from('payload=%7B%22safe%22%3Atrue%7D', 'utf8'),
  Buffer.from('payload=%7B%22prototype%22%3Atrue%7D', 'utf8'),
  Buffer.from(`${'k'.repeat(129)}=value`, 'utf8'),
]);

const generatedRawCase = (
  random: DeterministicGenerator,
  index: number,
): Buffer => {
  if (index < RAW_EDGE_CASES.length) return RAW_EDGE_CASES[index]!;
  if (index === RAW_EDGE_CASES.length) return Buffer.alloc(1_048_576, 0x61);
  if (index === RAW_EDGE_CASES.length + 1) {
    return Buffer.alloc(MAX_GENERATED_RAW_BYTES, 0x61);
  }
  switch (index % 3) {
    case 0: return generatedJsonBody(random);
    case 1: return generatedFormBody(random);
    default: return randomBytes(random, 4_096);
  }
};

const assertSafeJsonGraph = (root: Record<string, unknown>): void => {
  const stack: Array<{ value: object; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 1;
  while (stack.length > 0) {
    const current = stack.pop()!;
    expect(current.depth).toBeLessThanOrEqual(
      WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET.max_depth,
    );
    if (Array.isArray(current.value)) {
      expect(current.value.length).toBeLessThanOrEqual(
        WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET.max_array_items,
      );
      for (const child of current.value) {
        nodes += 1;
        if (typeof child === 'number') expect(Number.isFinite(child)).toBe(true);
        if (child !== null && typeof child === 'object') {
          stack.push({ value: child, depth: current.depth + 1 });
        }
      }
      continue;
    }
    expect(Object.getPrototypeOf(current.value)).toBe(Object.prototype);
    const keys = Object.keys(current.value);
    expect(keys.length).toBeLessThanOrEqual(
      WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET.max_object_keys,
    );
    for (const key of keys) {
      expect(PROTOTYPE_SENSITIVE_KEYS.has(key)).toBe(false);
      expect(Buffer.byteLength(key, 'utf8')).toBeLessThanOrEqual(
        WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET.max_key_bytes,
      );
      nodes += 1;
      const child = (current.value as Record<string, unknown>)[key];
      if (typeof child === 'number') expect(Number.isFinite(child)).toBe(true);
      if (child !== null && typeof child === 'object') {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  expect(nodes).toBeLessThanOrEqual(
    WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET.max_nodes,
  );
};

const assertSafeForm = (fields: Readonly<Record<string, string>>): void => {
  expect(Object.getPrototypeOf(fields)).toBeNull();
  expect(Object.isFrozen(fields)).toBe(true);
  const keys = Object.keys(fields);
  expect(keys.length).toBeLessThanOrEqual(
    WEBHOOK_FORM_URLENCODED_DECODER_V1.preset.max_fields,
  );
  for (const key of keys) {
    expect(PROTOTYPE_SENSITIVE_KEYS.has(key)).toBe(false);
    expect(Buffer.byteLength(key, 'utf8')).toBeLessThanOrEqual(
      WEBHOOK_FORM_URLENCODED_DECODER_V1.preset.max_key_bytes,
    );
    expect(Buffer.byteLength(fields[key]!, 'utf8')).toBeLessThanOrEqual(
      WEBHOOK_FORM_URLENCODED_DECODER_V1.preset.max_value_bytes,
    );
  }
};

const CREDENTIALS: Readonly<Partial<
  Record<WebhookProfileId, Readonly<Record<string, string>>>
>> = Object.freeze({
  'cal.webhook.v1': Object.freeze({
    signing_secret: 'generated-cal-webhook-signing-secret',
  }),
  'generic.static-header-token.v1': Object.freeze({
    header_name: 'x-d201-generated-token',
    header_token: 'generated-static-token',
  }),
  'generic.http-basic.v1': Object.freeze({
    username: 'generated-user',
    password: 'generated-password',
  }),
  'generic.raw-body-hmac-sha256.v1': Object.freeze({
    signature_header: 'x-d201-generated-signature',
    signing_secret: 'generated-raw-hmac-secret',
  }),
  'generic.timestamped-raw-body-hmac-sha256.v1': Object.freeze({
    signature_header: 'x-d201-generated-signature',
    signing_secret: 'generated-timestamped-hmac-secret',
  }),
  'stripe.event.v1': Object.freeze({
    endpoint_secret: 'whsec_D201GeneratedPropertyHarness',
  }),
  'paddle.notification.v1': Object.freeze({
    endpoint_secret_key:
      'pdl_ntfset_01gkpjp8bkm3tm53kdgkx6sms7_6h3qd3uFSi9YCD3OLYAShQI90XTI5vEI',
  }),
  'slack.request.v0': Object.freeze({
    signing_secret: 'generated-slack-signing-secret',
  }),
  'slack.slash-command.v1': Object.freeze({
    signing_secret: 'generated-slack-signing-secret',
  }),
  'telegram.bot-webhook.v1': Object.freeze({
    secret_token: 'Telegram_secret-token_d201',
  }),
  'github.webhook.v1': Object.freeze({
    webhook_secret: 'A'.repeat(43),
  }),
  'lemonsqueezy.webhook.v1': Object.freeze({
    signing_secret: 'generated-lemonsqueezy-signing-secret',
  }),
  'recued-peer.exchange.v1': Object.freeze({
    signing_secret: 'generated-recued-peer-signing-secret',
  }),
});

const credentialsFor = (
  profileId: WebhookProfileId,
): Readonly<Record<string, string>> => {
  const credentials = CREDENTIALS[profileId];
  if (credentials === undefined) {
    throw new Error(`missing generated credential for ${profileId}`);
  }
  return credentials;
};

const contextFor = (profileId: WebhookProfileId): WebhookProfileRuntimeContext => ({
  ingress_id: `whi_d201_property_${profileId.replaceAll('.', '_')}`,
  environment: 'test',
  credential_versions: [{
    version: '1',
    created_at: NOW_MS,
    credentials: credentialsFor(profileId),
  }],
  now: () => NOW_MS,
});

const rawRequest = (
  rawBody: Buffer,
  headers: ReadonlyMap<string, readonly string[]>,
): RawWebhookRequest => ({
  method: 'POST',
  raw_body: rawBody,
  headers,
  raw_path_and_query: '/v1/webhooks/d201-property',
  canonical_public_url: 'https://hooks.example.test/v1/webhooks/d201-property',
  received_at: NOW_MS,
  remote_ip: '127.0.0.1',
});

const headerNameFrom = (
  selection: Readonly<{ kind: 'fixed'; name: string }>
    | Readonly<{ kind: 'credential_field'; field: string }>,
  credentials: Readonly<Record<string, string>>,
): string => selection.kind === 'fixed'
  ? selection.name
  : credentials[selection.field]!;

const generatedHeaderValue = (
  random: DeterministicGenerator,
  index: number,
): string => {
  const edgeLengths = [
    0, 1, 2, 3, 31, 32, 63, 64, 65, 127, 128, 129,
    255, 256, 257, 8_191, 8_192, 8_193, MAX_GENERATED_HEADER_CODE_UNITS,
  ] as const;
  const length = edgeLengths[index]
    ?? random.integer(513);
  const codeUnits = [
    0x00, 0x09, 0x0a, 0x0d, 0x20, 0x25, 0x2b, 0x2c, 0x2d, 0x2f,
    0x30, 0x31, 0x3a, 0x3b, 0x3d, 0x41, 0x5a, 0x5f, 0x61, 0x7a,
    0x7f, 0x80, 0xff, 0x2028, 0xd800, 0xdc00,
  ] as const;
  let value = '';
  for (let offset = 0; offset < length; offset += 1) {
    value += String.fromCharCode(codeUnits[random.integer(codeUnits.length)]!);
  }
  return value;
};

const setGeneratedHeader = (
  headers: Map<string, readonly string[]>,
  name: string,
  value: string,
  alternate: string,
  variant: number,
): void => {
  switch (variant % 4) {
    case 0: return;
    case 1: headers.set(name, []); return;
    case 2: headers.set(name, [value]); return;
    default: headers.set(name, [value, alternate]);
  }
};

const present = <T>(value: T | undefined): value is T => value !== undefined;

describe('D-201 Slice 9BM deterministic bounded parser properties', () => {
  it('contains generated raw bytes across JSON, form, and wrapped-JSON admission', () => {
    const random = generator(0xd201_9b01);
    const wrappedJson = createWebhookFormWrappedJsonDecoder({
      kind: 'exclusive_form_json_field.v1',
      json_field: 'payload',
    });
    const objectPrototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype);

    for (let index = 0; index < RAW_CASE_COUNT; index += 1) {
      const raw = generatedRawCase(random, index);
      expect(raw.byteLength).toBeLessThanOrEqual(MAX_GENERATED_RAW_BYTES);

      const json = WEBHOOK_JSON_OBJECT_DECODER_V1.decode(raw);
      if (json !== null) assertSafeJsonGraph(json);

      const form = WEBHOOK_FORM_URLENCODED_DECODER_V1.decode(raw);
      if (form !== null) assertSafeForm(form);

      const wrapped = wrappedJson.classify(form, WEBHOOK_JSON_OBJECT_DECODER_V1);
      if (wrapped.kind === 'matched') assertSafeJsonGraph(wrapped.envelope);
    }

    expect(Object.getOwnPropertyDescriptors(Object.prototype))
      .toEqual(objectPrototypeBefore);
    expect(({} as Record<string, unknown>).__d201_parser_polluted__)
      .toBeUndefined();
  });

  it('keeps every shipped header and signature grammar total for generated values', async () => {
    const random = generator(0xd201_9b02);
    const staticMechanisms = Object.values(
      WEBHOOK_STATIC_HEADER_TOKEN_DELIVERY_PROFILE_PRESETS,
    ).filter(present).map((profile) => ({
      profile,
      mechanism: createWebhookStaticHeaderTokenMechanism(profile.mechanism),
    }));
    const rawHmacMechanisms = Object.values(
      WEBHOOK_RAW_BODY_HMAC_DELIVERY_PROFILE_PRESETS,
    ).filter(present).map((profile) => ({
      profile,
      mechanism: createWebhookRawBodyHmacMechanism(profile.mechanism),
    }));
    const timestampedMechanisms = Object.values(
      WEBHOOK_TIMESTAMPED_HMAC_DELIVERY_PROFILE_PRESETS,
    ).filter(present).map((profile) => ({
      profile,
      mechanism: createWebhookTimestampedHmacMechanism(profile.mechanism),
    }));
    const basicAdapter = createPrimitiveWebhookProfileAdapters().find(
      (adapter) => adapter.profile_id === 'generic.http-basic.v1',
    );
    if (basicAdapter === undefined) throw new Error('HTTP Basic adapter unavailable');

    for (let index = 0; index < HEADER_CASE_COUNT; index += 1) {
      const value = generatedHeaderValue(random, index);
      const alternate = generatedHeaderValue(random, index + 1);
      expect(value.length).toBeLessThanOrEqual(MAX_GENERATED_HEADER_CODE_UNITS);
      const body = randomBytes(random, 4_096);

      for (const { profile, mechanism } of staticMechanisms) {
        const credentials = credentialsFor(profile.profile_id);
        const headers = new Map<string, readonly string[]>();
        setGeneratedHeader(
          headers,
          headerNameFrom(profile.mechanism.token_header, credentials),
          value,
          alternate,
          index,
        );
        const result = mechanism.authenticate(
          rawRequest(body, headers),
          contextFor(profile.profile_id),
        );
        expect(typeof result.ok).toBe('boolean');
      }

      for (const { profile, mechanism } of rawHmacMechanisms) {
        const credentials = credentialsFor(profile.profile_id);
        const headers = new Map<string, readonly string[]>();
        setGeneratedHeader(
          headers,
          headerNameFrom(profile.mechanism.signature_header, credentials),
          value,
          alternate,
          index,
        );
        const result = mechanism.authenticate(
          rawRequest(body, headers),
          contextFor(profile.profile_id),
        );
        expect(typeof result.ok).toBe('boolean');
      }

      for (const { profile, mechanism } of timestampedMechanisms) {
        const credentials = credentialsFor(profile.profile_id);
        const headers = new Map<string, readonly string[]>();
        setGeneratedHeader(
          headers,
          headerNameFrom(profile.mechanism.signature_header, credentials),
          value,
          alternate,
          index,
        );
        if (profile.mechanism.timestamp_source.kind === 'fixed_header') {
          setGeneratedHeader(
            headers,
            profile.mechanism.timestamp_source.name,
            alternate,
            value,
            index + 1,
          );
        }
        const result = mechanism.authenticate(
          rawRequest(body, headers),
          contextFor(profile.profile_id),
        );
        expect(typeof result.ok).toBe('boolean');
      }

      const basicHeaders = new Map<string, readonly string[]>();
      setGeneratedHeader(
        basicHeaders,
        'authorization',
        value,
        alternate,
        index,
      );
      const basicResult = await basicAdapter.verifyAndDecode(
        rawRequest(Buffer.from('{}', 'utf8'), basicHeaders),
        contextFor('generic.http-basic.v1'),
      );
      expect(typeof basicResult.ok).toBe('boolean');
    }
  });

  it('round-trips generated bodies through every shipped authentication family', async () => {
    const random = generator(0xd201_9b03);
    const coveredProfiles = new Set<WebhookProfileId>();

    for (const profile of Object.values(
      WEBHOOK_STATIC_HEADER_TOKEN_DELIVERY_PROFILE_PRESETS,
    ).filter(present)) {
      const mechanism = createWebhookStaticHeaderTokenMechanism(profile.mechanism);
      const context = contextFor(profile.profile_id);
      const presentation = mechanism.buildPresentation(context, 'newest');
      expect(presentation).not.toBeNull();
      const headers = new Map<string, readonly string[]>([[
        presentation!.header_name,
        [presentation!.header_value],
      ]]);
      expect(mechanism.authenticate(
        rawRequest(randomBytes(random, 4_096), headers),
        context,
      ).ok).toBe(true);
      coveredProfiles.add(profile.profile_id);
    }

    for (const profile of Object.values(
      WEBHOOK_RAW_BODY_HMAC_DELIVERY_PROFILE_PRESETS,
    ).filter(present)) {
      const mechanism = createWebhookRawBodyHmacMechanism(profile.mechanism);
      const context = contextFor(profile.profile_id);
      for (let index = 0; index < ROUND_TRIP_CASE_COUNT; index += 1) {
        const body = randomBytes(random, 4_096);
        const signature = mechanism.sign(body, context, 'newest');
        expect(signature).not.toBeNull();
        const headers = new Map<string, readonly string[]>([[
          signature!.header_name,
          [signature!.header_value],
        ]]);
        expect(mechanism.authenticate(rawRequest(body, headers), context).ok)
          .toBe(true);
      }
      coveredProfiles.add(profile.profile_id);
    }

    for (const profile of Object.values(
      WEBHOOK_TIMESTAMPED_HMAC_DELIVERY_PROFILE_PRESETS,
    ).filter(present)) {
      const mechanism = createWebhookTimestampedHmacMechanism(profile.mechanism);
      const context = contextFor(profile.profile_id);
      for (let index = 0; index < ROUND_TRIP_CASE_COUNT; index += 1) {
        const body = randomBytes(random, 4_096);
        const signature = mechanism.sign(body, context, 'newest');
        expect(signature).not.toBeNull();
        const headers = new Map<string, readonly string[]>([[
          signature!.header_name,
          [signature!.header_value],
        ]]);
        if (signature!.timestamp_header !== null) {
          headers.set(
            signature!.timestamp_header.name,
            [signature!.timestamp_header.value],
          );
        }
        expect(mechanism.authenticate(rawRequest(body, headers), context).ok)
          .toBe(true);
      }
      coveredProfiles.add(profile.profile_id);
    }

    const basicAdapter = createPrimitiveWebhookProfileAdapters().find(
      (adapter) => adapter.profile_id === 'generic.http-basic.v1',
    );
    if (basicAdapter === undefined) throw new Error('HTTP Basic adapter unavailable');
    const basicCredentials = credentialsFor('generic.http-basic.v1');
    const basicHeader = Buffer.from(
      `${basicCredentials.username}:${basicCredentials.password}`,
      'utf8',
    ).toString('base64');
    await expect(basicAdapter.verifyAndDecode(
      rawRequest(generatedSafeJsonBody(random), new Map([
        ['authorization', [`Basic ${basicHeader}`]],
      ])),
      contextFor('generic.http-basic.v1'),
    )).resolves.toMatchObject({ ok: true });
    coveredProfiles.add('generic.http-basic.v1');

    expect([...coveredProfiles].sort()).toEqual([...WEBHOOK_PROFILE_IDS].sort());
  });
});
