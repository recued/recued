import { describe, expect, it } from 'vitest';

import {
  createWebhookNormalizedDeliveryDeduplicator,
} from '../webhook-normalized-delivery-deduplicator.js';

const PRESET = {
  kind: 'normalized_id_or_timestamp_body_sha256.v1',
  stable_id_field: 'request_id',
  stable_id_prefix: 'fixture:id:',
  fallback_prefix: 'fixture:request:',
  max_body_bytes: 16,
} as const;

const PAIRED_PRESET = {
  kind: 'normalized_paired_ids_sha256.v1',
  delivery_id_field: 'notification_id',
  event_id_field: 'event_id',
  delivery_id_prefix: 'fixture:notification:',
  event_id_prefix: 'fixture:event:',
} as const;

const REQUIRED_SINGLE_PRESET = {
  kind: 'normalized_required_single_id_sha256.v1',
  stable_id_field: 'delivery_id',
  stable_id_prefix: 'fixture:delivery:',
} as const;

describe('D-201 Slices 8R + 9N + 9T normalized delivery deduplicator', () => {
  it('uses one stable id or the exact timestamp-NUL-body fallback', () => {
    const deduplicator = createWebhookNormalizedDeliveryDeduplicator(PRESET);
    expect(Object.isFrozen(deduplicator.preset)).toBe(true);
    expect(() => JSON.stringify(deduplicator.preset)).not.toThrow();

    const stable = deduplicator.deduplicate(
      { request_id: 'abc', ignored: 'metadata' },
      'timestamp-not-in-stable-identity',
      Buffer.from('body-not-used'),
    );
    expect(stable).toEqual({
      delivery_dedup_key:
        'fixture:id:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      event_dedup_key:
        'fixture:id:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad:0',
    });
    expect(Object.isFrozen(stable)).toBe(true);
    expect(deduplicator.deduplicate(
      { request_id: 'abc' },
      'changed-timestamp',
      Buffer.from('changed-body'),
    )).toEqual(stable);
    expect(deduplicator.deduplicate(
      { request_id: 'i'.repeat(512) },
      '1',
      Buffer.alloc(0),
    )).not.toBeNull();

    const body = Buffer.from('{"ok":true}\n', 'utf8');
    const fallback = deduplicator.deduplicate(
      { request_id: null },
      '001750000000',
      body,
    );
    expect(fallback).toEqual({
      delivery_dedup_key:
        'fixture:request:8600a4cd439bfdc253a0cb939163f242e1ab571708e9094dc4ae2bcea09674ac',
      event_dedup_key:
        'fixture:request:8600a4cd439bfdc253a0cb939163f242e1ab571708e9094dc4ae2bcea09674ac:0',
    });
    expect(deduplicator.deduplicate(
      { request_id: null },
      '1750000000',
      body,
    )).not.toEqual(fallback);
    expect(deduplicator.deduplicate(
      { request_id: null },
      '001750000000',
      Buffer.from('{"ok":false}\n', 'utf8'),
    )).not.toEqual(fallback);
    expect(deduplicator.deduplicate(
      { request_id: null },
      '1',
      Buffer.alloc(16),
    )).not.toBeNull();
    expect(deduplicator.deduplicate(
      { request_id: null },
      't'.repeat(128),
      Buffer.alloc(0),
    )).not.toBeNull();
    expect(deduplicator.deduplicate(
      { request_id: null },
      '1',
      Buffer.from('23'),
    )).not.toEqual(deduplicator.deduplicate(
      { request_id: null },
      '12',
      Buffer.from('3'),
    ));
  });

  it('requires one stable id without admitting timestamp/body fallback', () => {
    const deduplicator = createWebhookNormalizedDeliveryDeduplicator(
      REQUIRED_SINGLE_PRESET,
    );
    const deduplicated = deduplicator.deduplicate(
      { delivery_id: 'abc', ignored: 'metadata' },
      '',
      'not raw bytes' as never,
    );
    expect(deduplicated).toEqual({
      delivery_dedup_key:
        'fixture:delivery:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      event_dedup_key:
        'fixture:delivery:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad:0',
    });
    expect(Object.isFrozen(deduplicator.preset)).toBe(true);
    expect(Object.isFrozen(deduplicated)).toBe(true);
    expect(() => JSON.stringify(deduplicator.preset)).not.toThrow();
    expect(deduplicator.deduplicate(
      { delivery_id: 'abc' },
      'changed-timestamp',
      Buffer.from('changed-body'),
    )).toEqual(deduplicated);
    expect(deduplicator.deduplicate(
      { delivery_id: 'abd' },
      '',
      Buffer.alloc(0),
    )).not.toEqual(deduplicated);

    for (const normalized of [
      null,
      {},
      { delivery_id: null },
      { delivery_id: '' },
      { delivery_id: ' padded ' },
      { delivery_id: 'bad\nid' },
      { delivery_id: 'i'.repeat(513) },
    ]) {
      expect(deduplicator.deduplicate(
        normalized,
        'timestamp-must-not-rescue-missing-id',
        Buffer.from('body-must-not-rescue-missing-id'),
      )).toBeNull();
    }

    let accessorInvoked = false;
    const selectedAccessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(selectedAccessor, 'delivery_id', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('required-id accessor must not execute');
      },
    });
    expect(deduplicator.deduplicate(
      selectedAccessor,
      '',
      Buffer.alloc(0),
    )).toBeNull();
    expect(accessorInvoked).toBe(false);
  });

  it('hashes paired delivery and event ids independently', () => {
    const deduplicator = createWebhookNormalizedDeliveryDeduplicator(
      PAIRED_PRESET,
    );
    expect(Object.isFrozen(deduplicator.preset)).toBe(true);
    expect(() => JSON.stringify(deduplicator.preset)).not.toThrow();

    const normalized = {
      notification_id: 'ntf_01ghbkd0frb9k95cnhwd1bxpvk',
      event_id: 'evt_01gks14ge726w50ch2tmaw2a1x',
      ignored: 'metadata',
    };
    const paired = deduplicator.deduplicate(
      normalized,
      'timestamp-not-in-paired-identity',
      Buffer.from('body-not-in-paired-identity'),
    );
    expect(paired).toEqual({
      delivery_dedup_key:
        'fixture:notification:b7ba6b652ac00b553bfa1c7dbbf51449aef1a58d0c237b0c38818dfaed41a547',
      event_dedup_key:
        'fixture:event:5893c79f326e89b2aaf146b016d26ea045b1cc751ac99c40466ff52725e2ae2d',
    });
    expect(Object.isFrozen(paired)).toBe(true);
    expect(deduplicator.deduplicate(
      normalized,
      '',
      'not raw bytes' as never,
    )).toEqual(paired);

    const changedDelivery = deduplicator.deduplicate({
      ...normalized,
      notification_id: 'ntf_01ghbkd0frb9k95cnhwd1bxpvm',
    }, '1', Buffer.alloc(0));
    expect(changedDelivery?.delivery_dedup_key)
      .not.toBe(paired?.delivery_dedup_key);
    expect(changedDelivery?.event_dedup_key).toBe(paired?.event_dedup_key);

    const changedEvent = deduplicator.deduplicate({
      ...normalized,
      event_id: 'evt_01gks14ge726w50ch2tmaw2a1y',
    }, '1', Buffer.alloc(0));
    expect(changedEvent?.delivery_dedup_key).toBe(paired?.delivery_dedup_key);
    expect(changedEvent?.event_dedup_key).not.toBe(paired?.event_dedup_key);
    expect(deduplicator.deduplicate({
      notification_id: 'n'.repeat(512),
      event_id: 'e'.repeat(512),
    }, '1', Buffer.alloc(0))).not.toBeNull();

    for (const normalizedValue of [
      null,
      {},
      { notification_id: null, event_id: 'event' },
      { notification_id: 'notification', event_id: null },
      { notification_id: '', event_id: 'event' },
      { notification_id: ' notification ', event_id: 'event' },
      { notification_id: 'notification', event_id: 'bad\nevent' },
      { notification_id: 'n'.repeat(513), event_id: 'event' },
      { notification_id: 'notification', event_id: 'e'.repeat(513) },
    ]) {
      expect(deduplicator.deduplicate(
        normalizedValue,
        '1',
        Buffer.alloc(0),
      )).toBeNull();
    }

    let accessorInvoked = false;
    const selectedAccessor = { notification_id: 'notification' };
    Object.defineProperty(selectedAccessor, 'event_id', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('paired-id accessor must not execute');
      },
    });
    expect(deduplicator.deduplicate(
      selectedAccessor,
      '1',
      Buffer.alloc(0),
    )).toBeNull();
    expect(accessorInvoked).toBe(false);
    const ignoredAccessor = { ...normalized };
    Object.defineProperty(ignoredAccessor, 'other', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('ignored paired-id accessor must not execute');
      },
    });
    expect(deduplicator.deduplicate(
      ignoredAccessor,
      '1',
      Buffer.alloc(0),
    )).toEqual(paired);
    expect(accessorInvoked).toBe(false);
  });

  it('fails closed on malformed runtime input without invoking accessors', () => {
    const deduplicator = createWebhookNormalizedDeliveryDeduplicator(PRESET);
    for (const [normalized, timestamp, body] of [
      [null, '1', Buffer.alloc(0)],
      [{}, '1', Buffer.alloc(0)],
      [{ request_id: undefined }, '1', Buffer.alloc(0)],
      [{ request_id: '' }, '1', Buffer.alloc(0)],
      [{ request_id: ' padded ' }, '1', Buffer.alloc(0)],
      [{ request_id: 'bad\nid' }, '1', Buffer.alloc(0)],
      [{ request_id: 'i'.repeat(513) }, '1', Buffer.alloc(0)],
      [{ request_id: null }, '', Buffer.alloc(0)],
      [{ request_id: null }, ' padded ', Buffer.alloc(0)],
      [{ request_id: null }, 'bad\ntime', Buffer.alloc(0)],
      [{ request_id: null }, 't'.repeat(129), Buffer.alloc(0)],
      [{ request_id: null }, '1', Buffer.alloc(17)],
      [{ request_id: null }, '1', 'not raw bytes' as never],
    ] as const) {
      expect(deduplicator.deduplicate(normalized, timestamp, body)).toBeNull();
    }

    let accessorInvoked = false;
    const selectedAccessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(selectedAccessor, 'request_id', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('stable-id accessor must not execute');
      },
    });
    expect(deduplicator.deduplicate(
      selectedAccessor,
      '1',
      Buffer.alloc(0),
    )).toBeNull();
    expect(accessorInvoked).toBe(false);

    const ignoredAccessor = { request_id: 'abc' };
    Object.defineProperty(ignoredAccessor, 'ignored', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('ignored accessor must not execute');
      },
    });
    expect(deduplicator.deduplicate(
      ignoredAccessor,
      '1',
      Buffer.alloc(0),
    )).not.toBeNull();
    expect(accessorInvoked).toBe(false);

    const inheritedFieldDeduplicator =
      createWebhookNormalizedDeliveryDeduplicator({
        ...PRESET,
        stable_id_field: 'toString',
      });
    expect(inheritedFieldDeduplicator.deduplicate(
      { request_id: 'ignored' },
      '1',
      Buffer.alloc(0),
    )).toBeNull();
    expect(deduplicator.deduplicate(new Proxy({}, {
      getPrototypeOf() {
        throw new Error('hostile normalized proxy');
      },
    }), '1', Buffer.alloc(0))).toBeNull();
  });

  it('rejects widened or executable trusted presets', () => {
    expect(() => createWebhookNormalizedDeliveryDeduplicator({
      ...PRESET,
      stable_id_prefix: `${'p'.repeat(127)}:`,
    })).not.toThrow();
    expect(() => createWebhookNormalizedDeliveryDeduplicator({
      ...PRESET,
      stable_id_field: 'bad-field',
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookNormalizedDeliveryDeduplicator({
      ...PRESET,
      stable_id_prefix: 'UPPER:id:',
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookNormalizedDeliveryDeduplicator({
      ...PRESET,
      fallback_prefix: PRESET.stable_id_prefix,
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookNormalizedDeliveryDeduplicator({
      ...PRESET,
      stable_id_prefix: `${'p'.repeat(128)}:`,
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookNormalizedDeliveryDeduplicator({
      ...PRESET,
      max_body_bytes: 0,
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookNormalizedDeliveryDeduplicator({
      ...PRESET,
      max_body_bytes: 1_048_577,
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookNormalizedDeliveryDeduplicator({
      ...PRESET,
      algorithm: 'sha512',
    } as never)).toThrow('invalid trusted preset');
    expect(() => createWebhookNormalizedDeliveryDeduplicator({
      ...PRESET,
      material: () => 'executable identity',
    } as never)).toThrow('invalid trusted preset');
    expect(() => createWebhookNormalizedDeliveryDeduplicator(
      PAIRED_PRESET,
    )).not.toThrow();
    expect(() => createWebhookNormalizedDeliveryDeduplicator(
      REQUIRED_SINGLE_PRESET,
    )).not.toThrow();
    expect(() => createWebhookNormalizedDeliveryDeduplicator({
      ...REQUIRED_SINGLE_PRESET,
      fallback_prefix: 'must:not:exist:',
    } as never)).toThrow('invalid trusted preset');
    expect(() => createWebhookNormalizedDeliveryDeduplicator({
      ...REQUIRED_SINGLE_PRESET,
      stable_id_field: 'bad-field',
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookNormalizedDeliveryDeduplicator({
      ...PAIRED_PRESET,
      event_id_field: PAIRED_PRESET.delivery_id_field,
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookNormalizedDeliveryDeduplicator({
      ...PAIRED_PRESET,
      event_id_field: 'bad-field',
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookNormalizedDeliveryDeduplicator({
      ...PAIRED_PRESET,
      event_id_prefix: PAIRED_PRESET.delivery_id_prefix,
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookNormalizedDeliveryDeduplicator({
      ...PAIRED_PRESET,
      delivery_id_prefix: 'UPPER:notification:',
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookNormalizedDeliveryDeduplicator({
      ...PAIRED_PRESET,
      max_body_bytes: 1,
    } as never)).toThrow('invalid trusted preset');

    let accessorInvoked = false;
    const accessorPreset = { ...PRESET } as Record<string, unknown>;
    Object.defineProperty(accessorPreset, 'kind', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('dedup preset accessor must not execute');
      },
    });
    expect(() => createWebhookNormalizedDeliveryDeduplicator(
      accessorPreset as never,
    )).toThrow('invalid trusted preset');
    expect(accessorInvoked).toBe(false);
  });
});
