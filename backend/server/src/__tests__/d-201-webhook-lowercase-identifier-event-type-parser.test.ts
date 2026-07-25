import { describe, expect, it } from 'vitest';

import {
  createWebhookLowercaseIdentifierEventTypeParser,
} from '../webhook-lowercase-identifier-event-type-parser.js';
import {
  WEBHOOK_LOWERCASE_IDENTIFIER_EVENT_TYPE_PROFILE_PRESETS,
  webhookLowercaseIdentifierEventTypeProfilePreset,
} from '../webhook-shared-profile-parser-presets.js';

const PRESET = {
  kind: 'lowercase_identifier_event_type.v1',
  max_characters: 128,
} as const;

describe('D-201 Slice 9Q lowercase identifier event-type parser', () => {
  it('accepts bounded lowercase ASCII identifiers exactly', () => {
    const parser = createWebhookLowercaseIdentifierEventTypeParser(PRESET);
    for (const value of [
      'a',
      'issues',
      'pull_request',
      `a${'0'.repeat(127)}`,
    ]) {
      expect(parser.parse(value)).toBe(value);
    }
    expect(Object.isFrozen(parser)).toBe(true);
    expect(Object.isFrozen(parser.preset)).toBe(true);
    expect(() => JSON.stringify(parser.preset)).not.toThrow();
  });

  it('rejects wrong alphabets, bounds, controls, and coercion', () => {
    const parser = createWebhookLowercaseIdentifierEventTypeParser(PRESET);
    for (const value of [
      '',
      'Issues',
      'issues.opened',
      'issue-comment',
      'issues/opened',
      'issues:opened',
      '1issues',
      '_issues',
      'é',
      `a${'0'.repeat(128)}`,
      'issues\n',
      'issues\r',
      'issues\u0000',
      'issues\u2028',
      null,
      1,
      new String('issues'),
    ]) {
      expect(parser.parse(value)).toBeNull();
    }
  });

  it('accepts only exact own-data bounded presets without executing accessors', () => {
    expect(() => createWebhookLowercaseIdentifierEventTypeParser(PRESET))
      .not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'owner_regex.v1' },
      { ...PRESET, max_characters: 0 },
      { ...PRESET, max_characters: 129 },
      { ...PRESET, max_characters: 1.5 },
      Object.create(PRESET),
      new Proxy({}, {
        ownKeys() {
          throw new Error('hostile event-type preset');
        },
      }),
    ]) {
      expect(() => createWebhookLowercaseIdentifierEventTypeParser(
        invalid as never,
      )).toThrow('invalid trusted preset');
    }

    let accessorReads = 0;
    const accessor = {
      kind: 'lowercase_identifier_event_type.v1',
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'max_characters', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return 128;
      },
    });
    expect(() => createWebhookLowercaseIdentifierEventTypeParser(
      accessor as never,
    )).toThrow('invalid trusted preset');
    expect(accessorReads).toBe(0);
  });

  it('binds only GitHub to the grammar through trusted profile data', () => {
    const selected = webhookLowercaseIdentifierEventTypeProfilePreset(
      'github.webhook.v1',
    );
    expect(selected).toEqual({
      profile_id: 'github.webhook.v1',
      parser: PRESET,
    });
    expect(webhookLowercaseIdentifierEventTypeProfilePreset(
      'paddle.notification.v1',
    )).toBeNull();
    expect(Object.values(
      WEBHOOK_LOWERCASE_IDENTIFIER_EVENT_TYPE_PROFILE_PRESETS,
    ).map((value) => value?.profile_id)).toEqual(['github.webhook.v1']);
    expect(Object.isFrozen(
      WEBHOOK_LOWERCASE_IDENTIFIER_EVENT_TYPE_PROFILE_PRESETS,
    )).toBe(true);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected?.parser)).toBe(true);
    expect(() => JSON.stringify(selected)).not.toThrow();
  });
});
