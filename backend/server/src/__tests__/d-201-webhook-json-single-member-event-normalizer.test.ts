import { describe, expect, it } from 'vitest';

import {
  createWebhookJsonSingleMemberEventNormalizer,
} from '../webhook-json-single-member-event-normalizer.js';

const PRESET = {
  kind: 'json_single_member_event.v1',
  event_id_field: 'sequence_id',
  event_id_grammar: 'positive_safe_integer.v1',
  event_id_max_value: 2_147_483_647,
  event_type_grammar: 'ascii_identifier.v1',
  event_type_max_bytes: 128,
} as const;

describe('D-201 Slice 9Z JSON single-member event normalizer', () => {
  it('normalizes one numeric identity and object-valued dynamic event member', () => {
    const normalizer = createWebhookJsonSingleMemberEventNormalizer(PRESET);
    const envelope = {
      Edited_Message9: { message_id: 81 },
      sequence_id: 104_200,
    };

    const normalized = normalizer.normalize(envelope);
    expect(normalized).toEqual({
      event_id: '104200',
      event_type: 'Edited_Message9',
      occurred_at: null,
      resource_id: null,
      payload: envelope,
    });
    expect(normalized?.payload).toBe(envelope);
    expect(Object.isFrozen(normalizer)).toBe(true);
    expect(Object.isFrozen(normalizer.preset)).toBe(true);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(() => JSON.stringify(normalizer.preset)).not.toThrow();

    const maximumEventType = `E${'v'.repeat(127)}`;
    expect(normalizer.normalize({
      sequence_id: PRESET.event_id_max_value,
      [maximumEventType]: {},
    })).toMatchObject({
      event_id: String(PRESET.event_id_max_value),
      event_type: maximumEventType,
    });
  });

  it('delegates the selected event-type byte ceiling to the shared parser', () => {
    const normalizer = createWebhookJsonSingleMemberEventNormalizer({
      ...PRESET,
      event_type_max_bytes: 3,
    });
    expect(normalizer.normalize({ sequence_id: 1, Msg: {} })).toMatchObject({
      event_id: '1',
      event_type: 'Msg',
    });
    expect(normalizer.normalize({ sequence_id: 1, Message: {} })).toBeNull();
  });

  it('rejects ambiguous envelopes, invalid identities, and invalid event members', () => {
    const normalizer = createWebhookJsonSingleMemberEventNormalizer(PRESET);
    for (const value of [
      null,
      [],
      {},
      { sequence_id: 1 },
      { sequence_id: 1, message: {}, extra: {} },
      { sequence_id: '1', message: {} },
      { sequence_id: 0, message: {} },
      { sequence_id: -1, message: {} },
      { sequence_id: 1.5, message: {} },
      { sequence_id: PRESET.event_id_max_value + 1, message: {} },
      { sequence_id: 1, '9message': {} },
      { sequence_id: 1, 'edited.message': {} },
      { sequence_id: 1, ['e'.repeat(129)]: {} },
      { sequence_id: 1, message: null },
      { sequence_id: 1, message: [] },
      { sequence_id: 1, message: 'payload' },
      Object.create({ sequence_id: 1, message: {} }),
    ]) {
      expect(normalizer.normalize(value)).toBeNull();
    }

    const withSymbol = { sequence_id: 1, message: {} } as Record<
      PropertyKey,
      unknown
    >;
    withSymbol[Symbol('extra')] = true;
    expect(normalizer.normalize(withSymbol)).toBeNull();

    const nonEnumerable = { sequence_id: 1 };
    Object.defineProperty(nonEnumerable, 'message', {
      enumerable: false,
      value: {},
    });
    expect(normalizer.normalize(nonEnumerable)).toBeNull();
  });

  it('does not execute envelope or event-member accessors and contains proxies', () => {
    const normalizer = createWebhookJsonSingleMemberEventNormalizer(PRESET);
    let accessorReads = 0;
    const identityAccessor = { message: {} };
    Object.defineProperty(identityAccessor, 'sequence_id', {
      enumerable: true,
      get() {
        accessorReads += 1;
        throw new Error('identity accessor must not execute');
      },
    });
    expect(normalizer.normalize(identityAccessor)).toBeNull();

    const eventAccessor = { sequence_id: 1 };
    Object.defineProperty(eventAccessor, 'message', {
      enumerable: true,
      get() {
        accessorReads += 1;
        throw new Error('event accessor must not execute');
      },
    });
    expect(normalizer.normalize(eventAccessor)).toBeNull();
    expect(accessorReads).toBe(0);

    expect(normalizer.normalize(new Proxy({}, {
      ownKeys() {
        throw new Error('hostile envelope proxy');
      },
    }))).toBeNull();
  });

  it('accepts only an exact own-data inert preset with hard-capped policy', () => {
    expect(() => createWebhookJsonSingleMemberEventNormalizer(PRESET))
      .not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'owner_callback.v1' },
      { ...PRESET, event_id_field: 'constructor' },
      { ...PRESET, event_id_grammar: 'coerce_number.v1' },
      { ...PRESET, event_id_max_value: 0 },
      { ...PRESET, event_id_max_value: Number.MAX_SAFE_INTEGER + 1 },
      { ...PRESET, event_type_grammar: 'owner_regex.v1' },
      { ...PRESET, event_type_max_bytes: 0 },
      { ...PRESET, event_type_max_bytes: 129 },
      Object.create(PRESET),
      new Proxy({}, {
        ownKeys() {
          throw new Error('hostile preset proxy');
        },
      }),
    ]) {
      expect(() => createWebhookJsonSingleMemberEventNormalizer(
        invalid as never,
      )).toThrow('invalid trusted preset');
    }

    let accessorReads = 0;
    const accessor = { ...PRESET } as Record<string, unknown>;
    Object.defineProperty(accessor, 'event_id_field', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return PRESET.event_id_field;
      },
    });
    expect(() => createWebhookJsonSingleMemberEventNormalizer(
      accessor as never,
    )).toThrow('invalid trusted preset');
    expect(accessorReads).toBe(0);
  });
});
