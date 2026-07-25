import { describe, expect, it } from 'vitest';

import {
  createWebhookFlatFormEventNormalizer,
} from '../webhook-flat-form-event-normalizer.js';
import {
  WEBHOOK_FORM_URLENCODED_DECODER_V1,
} from '../webhook-form-urlencoded-decoder.js';

const PRESET = {
  kind: 'flat_form_slash_command_event.v1',
  event_type: 'command.received',
  payload_event_type_field: 'kind',
  command_field: 'operation',
  event_id_field: 'request_id',
  event_id_max_bytes: 8,
  resource_id_field: 'workspace',
  resource_id_max_bytes: 8,
  reserved_fields: ['kind', 'event_id', 'occurred_at', 'challenge'],
  payload_omitted_fields: ['reply_url'],
} as const;

describe('D-201 Slices 8V + 8X flat-form event normalizer', () => {
  it('projects one bounded slash command while withholding selected payload fields', () => {
    const normalizer = createWebhookFlatFormEventNormalizer(PRESET);
    expect(Object.isFrozen(normalizer.preset)).toBe(true);
    expect(Object.isFrozen(normalizer.preset.reserved_fields)).toBe(true);
    expect(Object.isFrozen(normalizer.preset.payload_omitted_fields)).toBe(true);
    expect(() => JSON.stringify(normalizer.preset)).not.toThrow();
    const fields = WEBHOOK_FORM_URLENCODED_DECODER_V1.decode(Buffer.from(
      'operation=%2Fgo&request_id=req_123&workspace=ws_123&text=hello+world&reply_url=https%3A%2F%2Fexample.test%2Fbearer',
      'utf8',
    ));
    const normalized = normalizer.normalize(fields);
    expect(normalized).toEqual({
      event_type: 'command.received',
      event_id: 'req_123',
      resource_id: 'ws_123',
      occurred_at: null,
      challenge: null,
      payload: {
        kind: 'command.received',
        operation: '/go',
        request_id: 'req_123',
        workspace: 'ws_123',
        text: 'hello world',
      },
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized?.payload)).toBe(true);
    expect(Object.getPrototypeOf(normalized?.payload)).toBeNull();
  });

  it('enforces the code-fixed command grammar and provider-id bounds', () => {
    const normalizer = createWebhookFlatFormEventNormalizer(PRESET);
    const input = (operation: unknown, requestId: unknown = 'request8',
      workspace: unknown = 'workspc8'): Record<string, unknown> => ({
      operation,
      request_id: requestId,
      workspace,
    });
    for (const operation of [
      '/a',
      `/!#$%&'*+-.09AZ_az`,
      `/${'a'.repeat(255)}`,
    ]) {
      expect(normalizer.normalize(input(operation))).not.toBeNull();
    }
    for (const operation of [
      '',
      '/',
      'go',
      '/bad command',
      '/bad?',
      '/é',
      `/${'a'.repeat(256)}`,
    ]) {
      expect(normalizer.normalize(input(operation))).toBeNull();
    }
    expect(normalizer.normalize(input('/go', 'i'.repeat(8), 'r'.repeat(8))))
      .not.toBeNull();
    for (const [requestId, workspace] of [
      ['i'.repeat(9), 'workspc8'],
      ['request8', 'r'.repeat(9)],
      ['', 'workspc8'],
      ['request8', ''],
      ['request8', ' padded '],
      ['bad\nid', 'workspc8'],
    ]) {
      expect(normalizer.normalize(input('/go', requestId, workspace))).toBeNull();
    }
  });

  it('rejects missing, reserved, inherited, and executable form authority', () => {
    const normalizer = createWebhookFlatFormEventNormalizer(PRESET);
    for (const fields of [
      null,
      [],
      { operation: '/go', request_id: 'request8' },
      { operation: '/go', workspace: 'workspc8' },
      { request_id: 'request8', workspace: 'workspc8' },
      { operation: 1, request_id: 'request8', workspace: 'workspc8' },
      Object.create({
        operation: '/go',
        request_id: 'request8',
        workspace: 'workspc8',
      }),
      {
        operation: '/go',
        request_id: 'request8',
        workspace: 'workspc8',
        'bad field': 'unsafe',
      },
    ]) {
      expect(normalizer.normalize(fields)).toBeNull();
    }
    for (const reservedField of PRESET.reserved_fields) {
      expect(normalizer.normalize({
        operation: '/go',
        request_id: 'request8',
        workspace: 'workspc8',
        [reservedField]: 'shadowed',
      })).toBeNull();
    }

    let accessorInvoked = false;
    const accessorFields = {
      request_id: 'request8',
      workspace: 'workspc8',
    } as Record<string, unknown>;
    Object.defineProperty(accessorFields, 'operation', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('flat form accessor must not execute');
      },
    });
    expect(normalizer.normalize(accessorFields)).toBeNull();
    expect(accessorInvoked).toBe(false);

    const nonEnumerable = {
      request_id: 'request8',
      workspace: 'workspc8',
    };
    Object.defineProperty(nonEnumerable, 'operation', {
      enumerable: false,
      value: '/go',
    });
    expect(normalizer.normalize(nonEnumerable)).toBeNull();

    const symbolFields = {
      operation: '/go',
      request_id: 'request8',
      workspace: 'workspc8',
      [Symbol('hidden')]: 'authority',
    };
    expect(normalizer.normalize(symbolFields)).toBeNull();
    expect(normalizer.normalize(new Proxy({}, {
      getPrototypeOf() {
        throw new Error('hostile flat-form record');
      },
    }))).toBeNull();
  });

  it('rejects widened, colliding, sparse, and executable presets', () => {
    expect(() => createWebhookFlatFormEventNormalizer({
      ...PRESET,
      event_type: `e${'t'.repeat(127)}`,
      payload_event_type_field: 'p'.repeat(128),
      command_field: 'c'.repeat(128),
      event_id_field: 'i'.repeat(128),
      event_id_max_bytes: 512,
      resource_id_field: 'r'.repeat(128),
      resource_id_max_bytes: 512,
      reserved_fields: ['p'.repeat(128)],
    })).not.toThrow();
    const maximumReservedFields = [
      'kind',
      ...Array.from({ length: 63 }, (_, index) => `reserved_${index}`),
    ];
    const maximumOmittedFields = Array.from(
      { length: 64 },
      (_, index) => `omitted_${index}`,
    );
    expect(() => createWebhookFlatFormEventNormalizer({
      ...PRESET,
      reserved_fields: maximumReservedFields,
    })).not.toThrow();
    expect(() => createWebhookFlatFormEventNormalizer({
      ...PRESET,
      payload_omitted_fields: maximumOmittedFields,
    })).not.toThrow();
    for (const input of [
      { ...PRESET, event_type: 'bad value' },
      { ...PRESET, event_type: `e${'t'.repeat(128)}` },
      { ...PRESET, command_field: 'bad field' },
      { ...PRESET, command_field: 'f'.repeat(129) },
      { ...PRESET, command_field: 'constructor' },
      { ...PRESET, event_id_max_bytes: 0 },
      { ...PRESET, resource_id_max_bytes: 513 },
      { ...PRESET, event_id_field: PRESET.command_field },
      { ...PRESET, payload_event_type_field: PRESET.command_field },
      { ...PRESET, reserved_fields: ['event_id'] },
      { ...PRESET, reserved_fields: ['kind', 'kind'] },
      { ...PRESET, reserved_fields: ['kind', PRESET.command_field] },
      { ...PRESET, payload_omitted_fields: ['reply_url', 'reply_url'] },
      { ...PRESET, payload_omitted_fields: [PRESET.command_field] },
      { ...PRESET, payload_omitted_fields: ['kind'] },
      { ...PRESET, payload_omitted_fields: ['constructor'] },
      {
        ...PRESET,
        reserved_fields: [
          ...maximumReservedFields,
          'reserved_64',
        ],
      },
      {
        ...PRESET,
        payload_omitted_fields: [...maximumOmittedFields, 'omitted_64'],
      },
      { ...PRESET, validator: () => true },
    ]) {
      expect(() => createWebhookFlatFormEventNormalizer(input as never))
        .toThrow('invalid trusted preset');
    }

    const sparseReserved = new Array(2) as string[];
    sparseReserved[0] = 'kind';
    expect(() => createWebhookFlatFormEventNormalizer({
      ...PRESET,
      reserved_fields: sparseReserved,
    })).toThrow('invalid trusted preset');
    const sparseOmitted = new Array(2) as string[];
    sparseOmitted[0] = 'reply_url';
    expect(() => createWebhookFlatFormEventNormalizer({
      ...PRESET,
      payload_omitted_fields: sparseOmitted,
    })).toThrow('invalid trusted preset');

    const extraReservedAuthority = ['kind'] as Array<string> & {
      validator?: () => boolean;
    };
    extraReservedAuthority.validator = () => true;
    expect(() => createWebhookFlatFormEventNormalizer({
      ...PRESET,
      reserved_fields: extraReservedAuthority,
    })).toThrow('invalid trusted preset');

    let accessorInvoked = false;
    const accessorReserved = ['kind'] as unknown[];
    Object.defineProperty(accessorReserved, 0, {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('reserved-field accessor must not execute');
      },
    });
    expect(() => createWebhookFlatFormEventNormalizer({
      ...PRESET,
      reserved_fields: accessorReserved as string[],
    })).toThrow('invalid trusted preset');
    expect(accessorInvoked).toBe(false);

    const accessorOmitted = ['reply_url'] as unknown[];
    Object.defineProperty(accessorOmitted, 0, {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('omitted-field accessor must not execute');
      },
    });
    expect(() => createWebhookFlatFormEventNormalizer({
      ...PRESET,
      payload_omitted_fields: accessorOmitted as string[],
    })).toThrow('invalid trusted preset');
    expect(accessorInvoked).toBe(false);

    const accessorPreset = { ...PRESET } as Record<string, unknown>;
    Object.defineProperty(accessorPreset, 'event_type', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('flat-form preset accessor must not execute');
      },
    });
    expect(() => createWebhookFlatFormEventNormalizer(accessorPreset as never))
      .toThrow('invalid trusted preset');
    expect(accessorInvoked).toBe(false);

    let inheritedIteratorInvoked = false;
    const customPrototypeOmitted = ['reply_url'];
    Object.setPrototypeOf(customPrototypeOmitted, {
      [Symbol.iterator]() {
        inheritedIteratorInvoked = true;
        throw new Error('inherited iterator must not execute');
      },
    });
    expect(() => createWebhookFlatFormEventNormalizer({
      ...PRESET,
      payload_omitted_fields: customPrototypeOmitted,
    })).toThrow('invalid trusted preset');
    expect(inheritedIteratorInvoked).toBe(false);

    const mutableReservedFields = ['kind'];
    const mutableOmittedFields = ['reply_url'];
    const isolated = createWebhookFlatFormEventNormalizer({
      ...PRESET,
      reserved_fields: mutableReservedFields,
      payload_omitted_fields: mutableOmittedFields,
    });
    mutableReservedFields[0] = 'mutated';
    mutableOmittedFields[0] = 'mutated';
    expect(isolated.preset.reserved_fields).toEqual(['kind']);
    expect(isolated.preset.payload_omitted_fields).toEqual(['reply_url']);
  });
});
