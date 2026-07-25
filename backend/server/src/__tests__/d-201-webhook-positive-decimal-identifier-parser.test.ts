import { describe, expect, it } from 'vitest';

import {
  createWebhookPositiveDecimalIdentifierParser,
} from '../webhook-positive-decimal-identifier-parser.js';
import {
  WEBHOOK_POSITIVE_DECIMAL_REGISTRATION_REMOTE_ID_PROFILE_PRESETS,
  WEBHOOK_POSITIVE_DECIMAL_STRUCTURAL_EVIDENCE_PROFILE_PRESETS,
  webhookPositiveDecimalRegistrationRemoteIdProfilePreset,
  webhookPositiveDecimalStructuralEvidenceProfilePreset,
} from '../webhook-shared-profile-parser-presets.js';

const PRESET = {
  kind: 'positive_decimal_identifier.v1',
  max_digits: 32,
} as const;
const REGISTRATION_REMOTE_ID_PRESET = {
  kind: 'positive_decimal_identifier.v1',
  max_digits: 20,
} as const;

describe('D-201 Slices 9R + 9AN positive-decimal identifier parser', () => {
  it('accepts exact positive decimal text at bounded lengths', () => {
    const parser = createWebhookPositiveDecimalIdentifierParser(PRESET);
    for (const value of [
      '1',
      '9',
      '10',
      '292430182',
      '9'.repeat(32),
    ]) {
      expect(parser.parse(value)).toBe(value);
    }
    expect(Object.isFrozen(parser)).toBe(true);
    expect(Object.isFrozen(parser.preset)).toBe(true);
    expect(() => JSON.stringify(parser.preset)).not.toThrow();
  });

  it('rejects zero, leading zeros, non-digits, bounds, and coercion', () => {
    const parser = createWebhookPositiveDecimalIdentifierParser(PRESET);
    for (const value of [
      '',
      '0',
      '00',
      '01',
      '+1',
      '-1',
      '1.0',
      '1e3',
      ' 1',
      '1 ',
      '1a',
      'é',
      '9'.repeat(33),
      '1\n',
      '1\r',
      '1\u0000',
      null,
      1,
      1n,
      new String('1'),
    ]) {
      expect(parser.parse(value)).toBeNull();
    }
  });

  it('accepts only exact own-data bounded presets without executing accessors', () => {
    expect(() => createWebhookPositiveDecimalIdentifierParser(PRESET))
      .not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'positive_integer_callback.v1' },
      { ...PRESET, max_digits: 0 },
      { ...PRESET, max_digits: 129 },
      { ...PRESET, max_digits: 1.5 },
      Object.create(PRESET),
      new Proxy({}, {
        getPrototypeOf() {
          throw new Error('hostile identifier preset');
        },
      }),
    ]) {
      expect(() => createWebhookPositiveDecimalIdentifierParser(
        invalid as never,
      )).toThrow('invalid trusted preset');
    }

    let accessorReads = 0;
    const accessor = {
      kind: 'positive_decimal_identifier.v1',
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'max_digits', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return 32;
      },
    });
    expect(() => createWebhookPositiveDecimalIdentifierParser(
      accessor as never,
    )).toThrow('invalid trusted preset');
    expect(accessorReads).toBe(0);
  });

  it('binds distinct GitHub roles through trusted profile data', () => {
    const structuralEvidence = webhookPositiveDecimalStructuralEvidenceProfilePreset(
      'github.webhook.v1',
    );
    expect(structuralEvidence).toEqual({
      profile_id: 'github.webhook.v1',
      parser: PRESET,
    });
    const registrationRemoteId =
      webhookPositiveDecimalRegistrationRemoteIdProfilePreset(
        'github.webhook.v1',
      );
    expect(registrationRemoteId).toEqual({
      profile_id: 'github.webhook.v1',
      parser: REGISTRATION_REMOTE_ID_PRESET,
    });
    const registrationRemoteIdParser =
      createWebhookPositiveDecimalIdentifierParser(
        registrationRemoteId!.parser,
      );
    expect(registrationRemoteIdParser.parse('9'.repeat(20)))
      .toBe('9'.repeat(20));
    expect(registrationRemoteIdParser.parse('9'.repeat(21))).toBeNull();
    expect(webhookPositiveDecimalStructuralEvidenceProfilePreset(
      'telegram.bot-webhook.v1',
    )).toBeNull();
    expect(webhookPositiveDecimalRegistrationRemoteIdProfilePreset(
      'telegram.bot-webhook.v1',
    )).toBeNull();
    expect(Object.values(
      WEBHOOK_POSITIVE_DECIMAL_STRUCTURAL_EVIDENCE_PROFILE_PRESETS,
    ).map((value) => value?.profile_id)).toEqual(['github.webhook.v1']);
    expect(Object.values(
      WEBHOOK_POSITIVE_DECIMAL_REGISTRATION_REMOTE_ID_PROFILE_PRESETS,
    ).map((value) => value?.profile_id)).toEqual(['github.webhook.v1']);
    expect(Object.isFrozen(
      WEBHOOK_POSITIVE_DECIMAL_STRUCTURAL_EVIDENCE_PROFILE_PRESETS,
    )).toBe(true);
    expect(Object.isFrozen(
      WEBHOOK_POSITIVE_DECIMAL_REGISTRATION_REMOTE_ID_PROFILE_PRESETS,
    )).toBe(true);
    expect(Object.getPrototypeOf(
      WEBHOOK_POSITIVE_DECIMAL_REGISTRATION_REMOTE_ID_PROFILE_PRESETS,
    )).toBeNull();
    expect(Object.isFrozen(structuralEvidence)).toBe(true);
    expect(Object.isFrozen(structuralEvidence?.parser)).toBe(true);
    expect(Object.isFrozen(registrationRemoteId)).toBe(true);
    expect(Object.isFrozen(registrationRemoteId?.parser)).toBe(true);
    expect(() => JSON.stringify([
      structuralEvidence,
      registrationRemoteId,
    ])).not.toThrow();
  });
});
