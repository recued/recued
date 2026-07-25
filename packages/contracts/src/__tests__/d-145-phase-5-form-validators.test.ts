/** D-145 PA5 — per-type validators + composite form validation.
 *
 *  Pin per § A.3.1:
 *    - Required gate: empty string + null + undefined → 'Required'.
 *    - Per-type shape gates: number rejects NaN; date rejects malformed
 *      / out-of-range; timestamp rejects naive (no TZ); uuid rejects
 *      malformed.
 *    - Hooks: `ref_exists` runs only after the pure validator passes.
 *    - `validateField` skips hidden fields (storage owns their value).
 *    - `validateForm` walks every field + returns one error per
 *      failing field.
 */

import { describe, expect, it } from 'vitest';

import {
  validateField,
  validateForm,
} from '../index.js';
import type {
  FormDefinition,
  FormField,
  ValidationHooks,
} from '../index.js';

const f = (over: Partial<FormField> & Pick<FormField, 'type'>): FormField => ({
  name: 'x',
  label: 'X',
  required: true,
  hidden: false,
  origin: 'canonical' as const,
  ...over,
});

describe('D-145 PA5 — text validator', () => {
  it('flags required + empty', () => {
    expect(validateField(f({ type: 'text' }), '')).toBe('Required');
    expect(validateField(f({ type: 'text' }), '   ')).toBe('Required');
    expect(validateField(f({ type: 'text' }), null)).toBe('Required');
    expect(validateField(f({ type: 'text' }), undefined)).toBe('Required');
  });

  it('passes when not required + empty', () => {
    expect(validateField(f({ type: 'text', required: false }), '')).toBeNull();
    expect(validateField(f({ type: 'text', required: false }), null)).toBeNull();
  });

  it('rejects non-string', () => {
    expect(validateField(f({ type: 'text' }), 7)).toBe('Must be a string');
    expect(validateField(f({ type: 'text' }), true)).toBe('Must be a string');
    expect(validateField(f({ type: 'text' }), {})).toBe('Must be a string');
  });

  it('enforces max_length with Unicode awareness', () => {
    const field = f({ type: 'text', max_length: 5 });
    expect(validateField(field, 'abcde')).toBeNull();
    expect(validateField(field, 'abcdef')).toBe('Must be ≤ 5 characters');
    expect(validateField(field, '🌟🌟🌟🌟🌟')).toBeNull();
    expect(validateField(field, '🌟🌟🌟🌟🌟🌟')).toBe('Must be ≤ 5 characters');
  });

  it('enforces pattern when provided (§ A.3.1 text: pattern)', () => {
    const field = f({ type: 'text', pattern: '^[A-Z]{3}$' });
    expect(validateField(field, 'USD')).toBeNull();
    expect(validateField(field, 'usd')).toBe('Must match the required format');
    expect(validateField(field, 'USDOLLAR')).toBe('Must match the required format');
  });

  it('skips pattern check when value empty + not required', () => {
    const field = f({
      type: 'text',
      required: false,
      pattern: '^[A-Z]{3}$',
    });
    expect(validateField(field, '')).toBeNull();
  });

  it('reports invalid pattern in field definition rather than throwing', () => {
    const field = f({ type: 'text', pattern: '[' });
    expect(validateField(field, 'anything')).toBe(
      'Invalid pattern in field definition',
    );
  });
});

describe('D-145 PA5 — textarea validator', () => {
  it('also enforces pattern (shared text-ish path)', () => {
    const field = f({ type: 'textarea', pattern: '^[a-z]+$' });
    expect(validateField(field, 'lowercase')).toBeNull();
    expect(validateField(field, 'MixedCase')).toBe('Must match the required format');
  });
});

describe('D-145 PA5 — textarea validator (length)', () => {
  it('flags required + empty', () => {
    expect(validateField(f({ type: 'textarea' }), '')).toBe('Required');
  });

  it('enforces max_length', () => {
    const field = f({ type: 'textarea', max_length: 3 });
    expect(validateField(field, 'abc')).toBeNull();
    expect(validateField(field, 'abcd')).toBe('Must be ≤ 3 characters');
  });
});

describe('D-145 PA5 — number validator', () => {
  it('flags required + null', () => {
    expect(validateField(f({ type: 'number' }), null)).toBe('Required');
    expect(validateField(f({ type: 'number' }), undefined)).toBe('Required');
  });

  it('rejects NaN + Infinity + non-number', () => {
    expect(validateField(f({ type: 'number' }), Number.NaN)).toBe('Must be a finite number');
    expect(validateField(f({ type: 'number' }), Number.POSITIVE_INFINITY)).toBe('Must be a finite number');
    expect(validateField(f({ type: 'number' }), '7' as unknown)).toBe('Must be a finite number');
  });

  it('accepts finite values', () => {
    expect(validateField(f({ type: 'number' }), 0)).toBeNull();
    expect(validateField(f({ type: 'number' }), -3.14)).toBeNull();
    expect(validateField(f({ type: 'number' }), 99999)).toBeNull();
  });

  it('enforces min when provided (§ A.3.1 number: min)', () => {
    const field = f({ type: 'number', min: 0 });
    expect(validateField(field, 0)).toBeNull();
    expect(validateField(field, -1)).toBe('Must be ≥ 0');
  });

  it('enforces max when provided (§ A.3.1 number: max)', () => {
    const field = f({ type: 'number', max: 100 });
    expect(validateField(field, 100)).toBeNull();
    expect(validateField(field, 101)).toBe('Must be ≤ 100');
  });

  it('enforces integer when provided (§ A.3.1 number: integer)', () => {
    const field = f({ type: 'number', integer: true });
    expect(validateField(field, 7)).toBeNull();
    expect(validateField(field, 7.5)).toBe('Must be a whole number');
  });

  it('combines min + max + integer', () => {
    const field = f({ type: 'number', min: 1, max: 10, integer: true });
    expect(validateField(field, 5)).toBeNull();
    expect(validateField(field, 0)).toBe('Must be ≥ 1');
    expect(validateField(field, 11)).toBe('Must be ≤ 10');
    expect(validateField(field, 5.5)).toBe('Must be a whole number');
  });
});

describe('D-145 PA5 — boolean validator', () => {
  it('flags required + null', () => {
    expect(validateField(f({ type: 'boolean' }), null)).toBe('Required');
  });

  it('rejects non-boolean', () => {
    expect(validateField(f({ type: 'boolean' }), 'true' as unknown)).toBe('Must be true or false');
    expect(validateField(f({ type: 'boolean' }), 1 as unknown)).toBe('Must be true or false');
  });

  it('accepts true / false', () => {
    expect(validateField(f({ type: 'boolean' }), true)).toBeNull();
    expect(validateField(f({ type: 'boolean' }), false)).toBeNull();
  });
});

describe('D-145 PA5 — date validator', () => {
  const field = f({ type: 'date' });

  it('flags required + empty', () => {
    expect(validateField(field, '')).toBe('Required');
    expect(validateField(field, null)).toBe('Required');
  });

  it('rejects malformed shapes', () => {
    expect(validateField(field, 'not-a-date')).toBe(
      'Must be a date string (YYYY-MM-DD)',
    );
    expect(validateField(field, '2024/01/15')).toBe(
      'Must be a date string (YYYY-MM-DD)',
    );
  });

  it('rejects month > 12', () => {
    expect(validateField(field, '2024-13-01')).toBe('Month must be 01–12');
  });

  it('rejects Feb 30', () => {
    expect(validateField(field, '2024-02-30')).toContain('Day must be ≤');
  });

  it('rejects Feb 29 on a non-leap year', () => {
    expect(validateField(field, '2023-02-29')).toContain('Day must be ≤');
  });

  it('accepts Feb 29 on a leap year', () => {
    expect(validateField(field, '2024-02-29')).toBeNull();
  });

  it('accepts a normal date', () => {
    expect(validateField(field, '2024-07-04')).toBeNull();
  });
});

describe('D-145 PA5 — timestamp validator', () => {
  const field = f({ type: 'timestamp' });

  it('flags required + empty', () => {
    expect(validateField(field, '')).toBe('Required');
    expect(validateField(field, null)).toBe('Required');
  });

  it('rejects naive ISO (no TZ)', () => {
    expect(validateField(field, '2024-07-04T12:00:00')).toBe(
      'Timestamp must include a timezone (Z or ±HH:MM)',
    );
  });

  it('accepts Z-suffixed ISO', () => {
    expect(validateField(field, '2024-07-04T12:00:00Z')).toBeNull();
  });

  it('accepts offset-suffixed ISO', () => {
    expect(validateField(field, '2024-07-04T12:00:00+09:00')).toBeNull();
    expect(validateField(field, '2024-07-04T12:00:00-0500')).toBeNull();
  });

  it('accepts non-negative epoch ms', () => {
    expect(validateField(field, 0)).toBeNull();
    expect(validateField(field, 1_700_000_000_000)).toBeNull();
  });

  it('rejects negative epoch ms', () => {
    expect(validateField(field, -1)).toBe(
      'Must be a non-negative epoch milliseconds value',
    );
  });

  it('rejects unparseable strings', () => {
    expect(validateField(field, 'gibberish')).toBe(
      'Must be an ISO 8601 timestamp',
    );
  });

  it('rejects impossible calendar dates rather than silently rolling forward', () => {
    // Date.parse silently maps 2024-02-30T10:00:00Z → 2024-03-01.
    // The validator now parses components explicitly + rejects.
    expect(validateField(field, '2024-02-30T10:00:00Z')).toMatch(/Day must be ≤/);
    expect(validateField(field, '2023-02-29T10:00:00Z')).toMatch(/Day must be ≤/);
    expect(validateField(field, '2024-13-01T10:00:00Z')).toBe('Month must be 01–12');
  });

  it('accepts Feb 29 on a leap year', () => {
    expect(validateField(field, '2024-02-29T10:00:00Z')).toBeNull();
  });

  it('accepts a missing-seconds variant', () => {
    expect(validateField(field, '2024-07-04T12:00Z')).toBeNull();
  });

  it('rejects out-of-range hour / minute / second', () => {
    expect(validateField(field, '2024-07-04T25:00:00Z')).toBe('Hour must be 00–23');
    expect(validateField(field, '2024-07-04T12:60:00Z')).toBe('Minute must be 00–59');
    expect(validateField(field, '2024-07-04T12:00:61Z')).toBe('Second must be 00–60');
  });
});

describe('D-145 PA5 — enum validator', () => {
  const field = f({ type: 'enum', enum_values: ['low', 'high'] });

  it('flags required + empty', () => {
    expect(validateField(field, '')).toBe('Required');
  });

  it('rejects values outside the closed list', () => {
    expect(validateField(field, 'medium')).toBe('Must be one of low, high');
  });

  it('accepts a value in the closed list', () => {
    expect(validateField(field, 'low')).toBeNull();
  });

  it('accepts any value when enum_values empty (open enum)', () => {
    const open = f({ type: 'enum', enum_values: [] });
    expect(validateField(open, 'whatever')).toBeNull();
  });
});

describe('D-145 PA5 — ref validator', () => {
  it('flags required + empty', () => {
    expect(validateField(f({ type: 'ref', ref_target: 'data.contact' }), '')).toBe('Required');
  });

  it('passes when not required + empty', () => {
    expect(
      validateField(
        f({ type: 'ref', ref_target: 'data.contact', required: false }),
        '',
      ),
    ).toBeNull();
  });

  it('passes shape gate for non-empty string', () => {
    expect(
      validateField(f({ type: 'ref', ref_target: 'data.contact' }), 'abc'),
    ).toBeNull();
  });

  it('runs `ref_exists` hook only for non-empty values', () => {
    const hooks: ValidationHooks = {
      ref_exists: () => false,
    };
    expect(
      validateField(
        f({ type: 'ref', ref_target: 'data.contact', required: false }),
        '',
        hooks,
      ),
    ).toBeNull();
    expect(
      validateField(
        f({ type: 'ref', ref_target: 'data.contact' }),
        'missing-id',
        hooks,
      ),
    ).toBe('Entity not found');
  });

  it('passes when `ref_exists` hook returns true', () => {
    const hooks: ValidationHooks = { ref_exists: () => true };
    expect(
      validateField(
        f({ type: 'ref', ref_target: 'data.contact' }),
        'present-id',
        hooks,
      ),
    ).toBeNull();
  });

  it('skips ref_exists hook when target absent', () => {
    const hooks: ValidationHooks = { ref_exists: () => false };
    // No ref_target set — substrate can't dispatch the hook.
    expect(
      validateField(f({ type: 'ref' }), 'present-id', hooks),
    ).toBeNull();
  });
});

describe('D-145 PA5 — uuid validator', () => {
  const field = f({ type: 'uuid' });

  it('flags required + empty', () => {
    expect(validateField(field, '')).toBe('Required');
  });

  it('accepts canonical uuid (with dashes)', () => {
    expect(validateField(field, '550e8400-e29b-41d4-a716-446655440000')).toBeNull();
  });

  it('accepts compact uuid (no dashes)', () => {
    expect(validateField(field, '550e8400e29b41d4a716446655440000')).toBeNull();
  });

  it('rejects malformed', () => {
    expect(validateField(field, 'zzz')).toBe('Must be a uuid string');
    expect(validateField(field, '12345')).toBe('Must be a uuid string');
  });
});

describe('D-145 PA5 — array validator', () => {
  it('flags required + empty', () => {
    const field = f({ type: 'array', item_type: 'text' });
    expect(validateField(field, [])).toBe('Required');
  });

  it('passes empty when not required', () => {
    const field = f({ type: 'array', item_type: 'text', required: false });
    expect(validateField(field, [])).toBeNull();
  });

  it('rejects non-array', () => {
    const field = f({ type: 'array', item_type: 'text' });
    expect(validateField(field, 'abc' as unknown)).toBe('Must be a list');
  });

  it('walks per-item validators', () => {
    const field = f({ type: 'array', item_type: 'number' });
    expect(validateField(field, [1, 'two' as unknown, 3])).toMatch(
      /Item 2: /,
    );
  });

  it('passes when every item validates', () => {
    const field = f({ type: 'array', item_type: 'number' });
    expect(validateField(field, [1, 2, 3])).toBeNull();
  });

  it('passes per-item enum from item_enum_values', () => {
    const field = f({
      type: 'array',
      item_type: 'enum',
      item_enum_values: ['a', 'b'],
    });
    expect(validateField(field, ['a', 'b'])).toBeNull();
    expect(validateField(field, ['a', 'c'])).toMatch(/Must be one of a, b/);
  });
});

describe('D-145 PA5 — validateField hidden fields', () => {
  it('skips hidden fields entirely', () => {
    const hidden = f({ type: 'uuid', hidden: true });
    expect(validateField(hidden, '')).toBeNull();
    expect(validateField(hidden, null)).toBeNull();
    expect(validateField(hidden, 'malformed')).toBeNull();
  });
});

describe('D-145 PA5 — validateForm composite', () => {
  const def: FormDefinition = {
    kind: 'task',
    fields: [
      f({ name: 'id', type: 'uuid', hidden: true, required: false }),
      f({ name: 'title', type: 'text', max_length: 200 }),
      f({ name: 'priority', type: 'enum', enum_values: ['low', 'high'], required: false }),
      f({ name: 'due_at', type: 'timestamp', required: false }),
    ],
  };

  it('returns empty array when every visible field passes', () => {
    expect(
      validateForm(def, {
        title: 'walk the dog',
        priority: 'low',
        due_at: '2026-05-09T12:00:00Z',
      }),
    ).toEqual([]);
  });

  it('surfaces one error per failing visible field', () => {
    const errors = validateForm(def, {
      title: '',
      priority: 'medium',
      due_at: 'naive',
    });
    expect(errors.length).toBe(3);
    expect(errors.map((e) => e.field)).toEqual([
      'title',
      'priority',
      'due_at',
    ]);
  });

  it('skips hidden fields', () => {
    const errors = validateForm(def, {
      title: 'ok',
      priority: 'low',
      due_at: '2026-05-09T12:00:00Z',
    });
    expect(errors.find((e) => e.field === 'id')).toBeUndefined();
  });

  it('routes ref_exists hook through to ref fields', () => {
    const refDef: FormDefinition = {
      kind: 'task',
      fields: [
        f({
          name: 'assigned_contact',
          type: 'ref',
          ref_target: 'data.contact',
        }),
      ],
    };
    const errors = validateForm(
      refDef,
      { assigned_contact: 'missing-id' },
      { ref_exists: () => false },
    );
    expect(errors).toEqual([
      { field: 'assigned_contact', message: 'Entity not found' },
    ]);
  });

  it('routes ref_exists hook through to array<ref> fields per item', () => {
    const arrayRefDef: FormDefinition = {
      kind: 'task',
      fields: [
        f({
          name: 'blocks_task',
          type: 'array',
          item_type: 'ref',
          ref_target: 'data.task',
          required: false,
        }),
      ],
    };
    const errors = validateForm(
      arrayRefDef,
      { blocks_task: ['present', 'missing'] },
      { ref_exists: (_t, id) => id === 'present' },
    );
    expect(errors).toEqual([
      { field: 'blocks_task', message: 'Item 2: Entity not found' },
    ]);
  });

  it('treats every array<ref> item as required (per-item required gate)', () => {
    const arrayRefDef: FormDefinition = {
      kind: 'task',
      fields: [
        f({
          name: 'blocks_task',
          type: 'array',
          item_type: 'ref',
          ref_target: 'data.task',
          required: false,
        }),
      ],
    };
    // An empty string in an array<ref> is incomplete input — the array
    // validator's per-item required gate catches it before hooks run.
    const errors = validateForm(
      arrayRefDef,
      { blocks_task: ['', 'present'] },
      { ref_exists: () => true },
    );
    expect(errors).toEqual([
      { field: 'blocks_task', message: 'Item 1: Required' },
    ]);
  });
});
