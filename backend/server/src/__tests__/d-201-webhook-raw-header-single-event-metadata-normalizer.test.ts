import { describe, expect, it, vi } from 'vitest';

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
  compileWebhookRawHeaderSingleEventMetadataNormalizerPreset,
  createWebhookRawHeaderSingleEventMetadataNormalizer,
} from '../webhook-raw-header-single-event-metadata-normalizer.js';

const PRESET = {
  kind: 'raw_header_single_event_metadata.v1',
  delivery_id_header: 'x-delivery-id',
  event_type_header: 'x-event-type',
  structural_evidence_header: 'x-structural-id',
} as const;

const dependencies = () => ({
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
});

const DELIVERY_ID = '72d3162e-cc78-11e3-81ab-4c9367dc0958';

describe('D-201 Slice 9S raw-header single-event metadata normalizer', () => {
  it('maps three exact singleton headers through their injected parsers', () => {
    const normalizer = createWebhookRawHeaderSingleEventMetadataNormalizer(
      PRESET,
      dependencies(),
    );
    const normalized = normalizer.normalize(new Map([
      [PRESET.delivery_id_header, [DELIVERY_ID.toUpperCase()]],
      [PRESET.event_type_header, ['pull_request']],
      [PRESET.structural_evidence_header, ['292430182']],
    ]));

    expect(normalized).toEqual({
      delivery_id: DELIVERY_ID,
      event_type: 'pull_request',
      structural_evidence: '292430182',
    });
    expect('provider_resource_id' in (normalized ?? {})).toBe(false);
    expect(Object.isFrozen(normalizer)).toBe(true);
    expect(Object.isFrozen(normalizer.preset)).toBe(true);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(() => JSON.stringify(normalizer.preset)).not.toThrow();
  });

  it('rejects missing, repeated, non-string, and role-invalid headers', () => {
    const normalizer = createWebhookRawHeaderSingleEventMetadataNormalizer(
      PRESET,
      dependencies(),
    );
    const validEntries: Array<[string, readonly string[]]> = [
      [PRESET.delivery_id_header, [DELIVERY_ID]],
      [PRESET.event_type_header, ['issues']],
      [PRESET.structural_evidence_header, ['292430182']],
    ];
    const cases: ReadonlyMap<string, readonly string[]>[] = [
      new Map(validEntries.slice(1)),
      new Map(validEntries.map(([name, values]) => [
        name,
        name === PRESET.delivery_id_header ? [values[0]!, values[0]!] : values,
      ])),
      new Map(validEntries.map(([name, values]) => [
        name,
        name === PRESET.event_type_header ? [] : values,
      ])),
      new Map(validEntries.map(([name, values]) => [
        name,
        name === PRESET.structural_evidence_header
          ? [1 as never]
          : values,
      ])),
      new Map(validEntries.map(([name, values]) => [
        name,
        name === PRESET.delivery_id_header ? ['not-a-uuid'] : values,
      ])),
      new Map(validEntries.map(([name, values]) => [
        name,
        name === PRESET.event_type_header ? ['Issues'] : values,
      ])),
      new Map(validEntries.map(([name, values]) => [
        name,
        name === PRESET.structural_evidence_header ? ['01'] : values,
      ])),
    ];
    for (const headers of cases) expect(normalizer.normalize(headers)).toBeNull();
  });

  it('uses parser results as the sole normalized role authority', () => {
    const delivery = vi.fn((value: unknown) => `delivery:${String(value)}`);
    const event = vi.fn((value: unknown) => `event:${String(value)}`);
    const evidence = vi.fn((value: unknown) => `evidence:${String(value)}`);
    const normalizer = createWebhookRawHeaderSingleEventMetadataNormalizer(
      PRESET,
      {
        delivery_id_parser: { parse: delivery },
        event_type_parser: { parse: event },
        structural_evidence_parser: { parse: evidence },
      },
    );

    expect(normalizer.normalize(new Map([
      [PRESET.delivery_id_header, ['raw-delivery']],
      [PRESET.event_type_header, ['raw-event']],
      [PRESET.structural_evidence_header, ['raw-evidence']],
    ]))).toEqual({
      delivery_id: 'delivery:raw-delivery',
      event_type: 'event:raw-event',
      structural_evidence: 'evidence:raw-evidence',
    });
    expect(delivery).toHaveBeenCalledOnce();
    expect(event).toHaveBeenCalledOnce();
    expect(evidence).toHaveBeenCalledOnce();
  });

  it('owns exact singleton admission even when injected parsers are permissive', () => {
    const parse = vi.fn(() => 'accepted');
    const normalizer = createWebhookRawHeaderSingleEventMetadataNormalizer(
      PRESET,
      {
        delivery_id_parser: { parse },
        event_type_parser: { parse },
        structural_evidence_parser: { parse },
      },
    );

    expect(normalizer.normalize(new Map([
      [PRESET.delivery_id_header, ['delivery']],
      [PRESET.event_type_header, ['event']],
    ]))).toBeNull();
    expect(normalizer.normalize(new Map([
      [PRESET.delivery_id_header, ['delivery', 'delivery']],
      [PRESET.event_type_header, ['event']],
      [PRESET.structural_evidence_header, ['evidence']],
    ]))).toBeNull();
    expect(normalizer.normalize(new Map([
      [PRESET.delivery_id_header, ['delivery']],
      [PRESET.event_type_header, [1 as never]],
      [PRESET.structural_evidence_header, ['evidence']],
    ]))).toBeNull();
    expect(parse).not.toHaveBeenCalled();
  });

  it('accepts only exact own-data presets with distinct lowercase header names', () => {
    expect(compileWebhookRawHeaderSingleEventMetadataNormalizerPreset(PRESET))
      .toEqual(PRESET);
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'owner_header_callback.v1' },
      { ...PRESET, delivery_id_header: '' },
      { ...PRESET, delivery_id_header: 'X-Delivery-Id' },
      { ...PRESET, delivery_id_header: 'x delivery id' },
      { ...PRESET, delivery_id_header: 'x'.repeat(129) },
      { ...PRESET, event_type_header: PRESET.delivery_id_header },
      Object.create(PRESET),
      new Proxy({}, {
        ownKeys() {
          throw new Error('hostile metadata preset');
        },
      }),
    ]) {
      expect(() => compileWebhookRawHeaderSingleEventMetadataNormalizerPreset(
        invalid as never,
      )).toThrow('invalid trusted preset');
    }

    let accessorReads = 0;
    const accessor = {
      kind: PRESET.kind,
      delivery_id_header: PRESET.delivery_id_header,
      event_type_header: PRESET.event_type_header,
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'structural_evidence_header', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return PRESET.structural_evidence_header;
      },
    });
    expect(() => compileWebhookRawHeaderSingleEventMetadataNormalizerPreset(
      accessor as never,
    )).toThrow('invalid trusted preset');
    expect(accessorReads).toBe(0);
  });
});
