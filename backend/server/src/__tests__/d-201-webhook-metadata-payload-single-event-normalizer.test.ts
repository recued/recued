import { describe, expect, it } from 'vitest';

import {
  createWebhookMetadataPayloadSingleEventNormalizer,
} from '../webhook-metadata-payload-single-event-normalizer.js';

const PRESET = { kind: 'metadata_payload_single_event.v1' } as const;

describe('D-201 Slice 9U metadata-payload single-event normalizer', () => {
  it('promotes delivery identity while fixing resource and time as absent', () => {
    const normalizer = createWebhookMetadataPayloadSingleEventNormalizer(PRESET);
    const payload = { action: 'opened', repository: { id: 1 } };
    const normalized = normalizer.normalize({
      delivery_id: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
      event_type: 'issues',
      structural_evidence: '292430182',
    }, payload);

    expect(normalized).toEqual({
      delivery_id: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
      event_id: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
      event_type: 'issues',
      occurred_at: null,
      resource_id: null,
      payload,
    });
    expect('structural_evidence' in (normalized ?? {})).toBe(false);
    expect(normalized?.payload).toBe(payload);
    expect(Object.isFrozen(normalizer)).toBe(true);
    expect(Object.isFrozen(normalizer.preset)).toBe(true);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(() => JSON.stringify(normalizer.preset)).not.toThrow();
  });

  it('rejects malformed selected roles and payloads without coercion', () => {
    const normalizer = createWebhookMetadataPayloadSingleEventNormalizer(PRESET);
    for (const [metadata, payload] of [
      [null, {}],
      [{}, {}],
      [{ delivery_id: null, event_type: 'issues' }, {}],
      [{ delivery_id: '', event_type: 'issues' }, {}],
      [{ delivery_id: ' padded ', event_type: 'issues' }, {}],
      [{ delivery_id: 'bad\nid', event_type: 'issues' }, {}],
      [{ delivery_id: 'i'.repeat(513), event_type: 'issues' }, {}],
      [{ delivery_id: 'id', event_type: null }, {}],
      [{ delivery_id: 'id', event_type: '' }, {}],
      [{ delivery_id: 'id', event_type: 'bad\nevent' }, {}],
      [{ delivery_id: 'id', event_type: 'e'.repeat(129) }, {}],
      [{ delivery_id: 'id', event_type: 'issues' }, null],
      [{ delivery_id: 'id', event_type: 'issues' }, []],
      [{ delivery_id: 'id', event_type: 'issues' }, 'payload'],
    ] as const) {
      expect(normalizer.normalize(metadata, payload)).toBeNull();
    }
  });

  it('does not execute selected, ignored, or payload accessors', () => {
    const normalizer = createWebhookMetadataPayloadSingleEventNormalizer(PRESET);
    let accessorInvoked = false;
    const selectedAccessor = { event_type: 'issues' };
    Object.defineProperty(selectedAccessor, 'delivery_id', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('selected metadata accessor must not execute');
      },
    });
    expect(normalizer.normalize(selectedAccessor, {})).toBeNull();
    expect(accessorInvoked).toBe(false);

    const metadata = { delivery_id: 'id', event_type: 'issues' };
    Object.defineProperty(metadata, 'structural_evidence', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('ignored metadata accessor must not execute');
      },
    });
    const payload = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(payload, 'ignored', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('payload accessor must not execute');
      },
    });
    expect(normalizer.normalize(metadata, payload)).not.toBeNull();
    expect(accessorInvoked).toBe(false);
    expect(normalizer.normalize(new Proxy({}, {
      getPrototypeOf() {
        throw new Error('hostile metadata proxy');
      },
    }), {})).toBeNull();
  });

  it('accepts only the exact own-data inert preset', () => {
    expect(() => createWebhookMetadataPayloadSingleEventNormalizer(PRESET))
      .not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { kind: 'owner_projection_callback.v1' },
      Object.create(PRESET),
      new Proxy({}, {
        ownKeys() {
          throw new Error('hostile normalizer preset');
        },
      }),
    ]) {
      expect(() => createWebhookMetadataPayloadSingleEventNormalizer(
        invalid as never,
      )).toThrow('invalid trusted preset');
    }

    let accessorReads = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, 'kind', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return PRESET.kind;
      },
    });
    expect(() => createWebhookMetadataPayloadSingleEventNormalizer(
      accessor as never,
    )).toThrow('invalid trusted preset');
    expect(accessorReads).toBe(0);
  });
});
