import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  createWebhookCanonicalUuidParser,
} from '../webhook-canonical-uuid-parser.js';
import {
  createWebhookLowercaseIdentifierEventTypeParser,
} from '../webhook-lowercase-identifier-event-type-parser.js';
import {
  createWebhookPositiveDecimalIdentifierParser,
} from '../webhook-positive-decimal-identifier-parser.js';
import {
  WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET,
} from '../webhook-json-object-decoder.js';
import {
  createWebhookRawHeaderJsonSingleEventTestEnvelopeBuilder,
  type WebhookRawHeaderJsonSingleEventTestEnvelopePreset,
} from '../webhook-raw-header-json-single-event-test-envelope.js';
import type {
  WebhookRawHeaderSingleEventMetadataNormalizerDependencies,
} from '../webhook-raw-header-single-event-metadata-normalizer.js';

const PRESET: WebhookRawHeaderJsonSingleEventTestEnvelopePreset = {
  kind: 'raw_header_json_single_event_test_envelope.v1',
  nonce_grammar: 'lowercase_hex_64.v1',
  delivery_id_derivation: 'sha256_uuid_v4_variant8.v1',
  delivery_id_domain_separator: 'recued:fixture:test-delivery:',
  structural_evidence: '1',
  base_payload_json: '{"action":"test","source":{"id":1}}',
  marker_object_field: 'test_delivery',
  marker_nonce_field: 'nonce',
  max_body_bytes: 1_024,
};

const METADATA_PRESET = {
  kind: 'raw_header_single_event_metadata.v1',
  delivery_id_header: 'x-delivery-id',
  event_type_header: 'x-event-type',
  structural_evidence_header: 'x-structural-id',
} as const;

const DEPENDENCIES: WebhookRawHeaderSingleEventMetadataNormalizerDependencies = {
  delivery_id_parser: createWebhookCanonicalUuidParser({
    kind: 'canonical_uuid_hex.v1',
  }),
  event_type_parser: createWebhookLowercaseIdentifierEventTypeParser({
    kind: 'lowercase_identifier_event_type.v1',
    max_characters: 128,
  }),
  structural_evidence_parser: createWebhookPositiveDecimalIdentifierParser({
    kind: 'positive_decimal_identifier.v1',
    max_digits: 32,
  }),
};

const createBuilder = (
  preset: WebhookRawHeaderJsonSingleEventTestEnvelopePreset = PRESET,
  dependencies: WebhookRawHeaderSingleEventMetadataNormalizerDependencies =
    DEPENDENCIES,
) => createWebhookRawHeaderJsonSingleEventTestEnvelopeBuilder(
  preset,
  WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET,
  METADATA_PRESET,
  dependencies,
);

describe('D-201 Slice 9V raw-header JSON single-event test envelope', () => {
  it('builds one canonical nonce-bearing body and normalized metadata headers', () => {
    const builder = createBuilder();
    const nonce = 'd'.repeat(64);
    const built = builder.build({ nonce, event_type: 'issues' });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error('expected a built envelope');

    expect(built.raw_body.toString('utf8')).toBe(
      `{"action":"test","source":{"id":1},`
      + `"test_delivery":{"nonce":"${nonce}"}}`,
    );
    const digest = createHash('sha256')
      .update(`${PRESET.delivery_id_domain_separator}${nonce}`, 'utf8')
      .digest('hex');
    const deliveryId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}`
      + `-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}`
      + `-${digest.slice(20, 32)}`;
    expect({ ...built.headers }).toEqual({
      'x-delivery-id': deliveryId,
      'x-event-type': 'issues',
      'x-structural-id': '1',
    });
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.headers)).toBe(true);

    const changed = builder.build({
      nonce: `${nonce.slice(0, -1)}e`,
      event_type: 'issues',
    });
    expect(changed.ok).toBe(true);
    if (!changed.ok) throw new Error('expected a changed envelope');
    expect(changed.headers['x-delivery-id']).not.toBe(deliveryId);
  });

  it('rejects malformed input without coercion or accessor execution', () => {
    const builder = createBuilder();
    for (const nonce of [
      undefined,
      null,
      'invalid',
      'D'.repeat(64),
      'd'.repeat(63),
      'd'.repeat(65),
    ]) {
      expect(builder.hasValidNonce(nonce)).toBe(false);
      expect(builder.build({ nonce, event_type: 'issues' })).toEqual({
        ok: false,
        reason: 'invalid_nonce',
      });
    }
    for (const eventType of [undefined, null, 1, 'Issues', 'invalid event']) {
      expect(builder.build({
        nonce: 'd'.repeat(64),
        event_type: eventType,
      })).toEqual({ ok: false, reason: 'invalid_envelope' });
    }

    let accessorCalls = 0;
    const accessor = { nonce: 'd'.repeat(64) } as Record<string, unknown>;
    Object.defineProperty(accessor, 'event_type', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return 'issues';
      },
    });
    expect(builder.build(accessor as never)).toEqual({
      ok: false,
      reason: 'invalid_envelope',
    });
    expect(accessorCalls).toBe(0);

    let coercionCalls = 0;
    expect(builder.build({
      nonce: 'd'.repeat(64),
      event_type: {
        toString() {
          coercionCalls += 1;
          return 'issues';
        },
      },
    })).toEqual({ ok: false, reason: 'invalid_envelope' });
    expect(coercionCalls).toBe(0);
  });

  it('copies only exact frozen serializable preset authority', () => {
    const input = { ...PRESET };
    const builder = createBuilder(input);
    input.base_payload_json = '{}';

    expect(builder.preset).toEqual(PRESET);
    expect(Object.isFrozen(builder)).toBe(true);
    expect(Object.isFrozen(builder.preset)).toBe(true);
    expect(JSON.parse(JSON.stringify(builder.preset))).toEqual(PRESET);
  });

  it('rejects widened, executable, noncanonical, and unsafe preset data', () => {
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'other' },
      { ...PRESET, nonce_grammar: 'uuid.v1' },
      { ...PRESET, delivery_id_derivation: 'random_uuid.v1' },
      { ...PRESET, delivery_id_domain_separator: 'bad domain' },
      { ...PRESET, delivery_id_domain_separator: 'x'.repeat(129) + ':' },
      { ...PRESET, structural_evidence: '' },
      { ...PRESET, base_payload_json: 'not-json' },
      { ...PRESET, base_payload_json: ' {"action":"test"}' },
      { ...PRESET, base_payload_json: '{"__proto__":{}}' },
      {
        ...PRESET,
        base_payload_json: '{"test_delivery":{}}',
      },
      { ...PRESET, marker_object_field: '__proto__' },
      { ...PRESET, marker_nonce_field: 'constructor' },
      { ...PRESET, max_body_bytes: 1 },
      { ...PRESET, max_body_bytes: 1_048_577 },
      Object.create(PRESET),
    ]) {
      expect(() => createBuilder(invalid as never)).toThrow(
        'invalid trusted preset',
      );
    }

    let getterCalls = 0;
    const accessor = { ...PRESET } as Record<string, unknown>;
    Object.defineProperty(accessor, 'base_payload_json', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return PRESET.base_payload_json;
      },
    });
    expect(() => createBuilder(accessor as never))
      .toThrow('invalid trusted preset');
    expect(getterCalls).toBe(0);

    expect(() => createBuilder(new Proxy(PRESET, {
      ownKeys() {
        throw new Error('hostile preset');
      },
    }))).toThrow('invalid trusted preset');
  });

  it('fails construction when selected metadata parsers reject fixed output', () => {
    expect(() => createBuilder(PRESET, {
      ...DEPENDENCIES,
      delivery_id_parser: { parse: () => null },
    })).toThrow('invalid trusted preset');
    expect(() => createBuilder(PRESET, {
      ...DEPENDENCIES,
      structural_evidence_parser: { parse: () => 'canonicalized' },
    })).toThrow('invalid trusted preset');
  });
});
