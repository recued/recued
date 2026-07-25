/** D-210 step 2c — an edit is enforced to its DECLARED shape, server-side.
 *
 *  ## Why this is the whole of 2c
 *
 *  §4's original move — "an allowlist is theatre when the approver is the owner, so drop
 *  `editable_args`" — turned out wrong on its premise AND unnecessary (spec §4.1):
 *
 *    - `ArgEditField` is `{ key, type, label, required, privacy, options_source,
 *      affects_target, validation }` — the edit FORM's descriptor, not an authority fence.
 *      Dropping it leaves nothing to render a form FROM.
 *    - 1700 ops declare `editable_args`; 1652 (97%) already list every arg the op takes. All
 *      four reception core packs are in that 97%. There was nothing to drop.
 *    - The 48 that narrow, narrow PLUMBING (`header.Idempotency-Key`, `task_gid`).
 *
 *  So "all fields changeable" already held. What did NOT hold is that the declared shape was
 *  enforced anywhere but the browser: `validateEditsAgainstSchema` checked the KEY and did
 *  `out[key] = edits[key]` verbatim, so `ArgEditField.validation` was client-side-only in
 *  practice. Admin-only ⇒ never a privilege hole — but a declaration nothing enforces is
 *  decoration. [[declared_is_not_backed]]
 *
 *  ⛔ The rules MIRROR the webclient's (`inbox-panel.ts:459-524`) rather than inventing a
 *  second set — two rule sets would let the surfaces disagree about what a valid edit is, and
 *  the SERVER's answer is the one that reaches the op.
 *
 *  Drives the REAL validator against the REAL resolver's schema. */

import { describe, expect, it } from 'vitest';
import type { ArgEditSchema } from '@recued/contracts';
import { validateEditsAgainstSchema } from '../reception-inbox-handler.js';

const METHOD = 'reception.inbox.approve';

const schema = (...fields: ArgEditSchema['fields']): ArgEditSchema => ({ fields });

const field = (over: Partial<ArgEditSchema['fields'][number]> = {}) => ({
  key: 'title',
  type: 'string' as const,
  ...over,
});

describe('D-210 2c — the KEY boundary still holds (unchanged)', () => {
  it('refuses a key outside the allowlist as a CAPABILITY answer', () => {
    expect(() => validateEditsAgainstSchema({ nope: 'x' }, schema(field()), METHOD))
      .toThrow(/not in the operation's editable-args allowlist/);
  });

  it('refuses prototype-sensitive keys', () => {
    // ⚠ Built via `JSON.parse`, deliberately. An object LITERAL `{ __proto__: 'x' }` sets the
    // prototype instead of creating an own key, so `Object.keys` never sees it and the test
    // would pass without ever reaching the guard. The rpc receives JSON-parsed input, where
    // `__proto__` IS an own property — that is the shape the guard exists for.
    const edits = JSON.parse('{"__proto__": "x"}') as Record<string, unknown>;
    expect(Object.keys(edits)).toEqual(['__proto__']);
    expect(() => validateEditsAgainstSchema(edits, schema(field()), METHOD))
      .toThrow(/prototype-sensitive/);
  });

  it('passes a well-shaped edit through unchanged', () => {
    expect(validateEditsAgainstSchema({ title: 'Design review' }, schema(field()), METHOD))
      .toEqual({ title: 'Design review' });
  });
});

describe('D-210 2c — the VALUE is now enforced to its declared type', () => {
  it('refuses a string where a datetime is declared — the case that reached mergeArgOverrides', () => {
    // The exact hole: an admin rpc client could put a string in a `datetime` and it landed in
    // the op untouched. `scheduling.materialize` declares `start_at` as `datetime`.
    const s = schema(field({ key: 'start_at', type: 'datetime' }));
    expect(() => validateEditsAgainstSchema({ start_at: 'next tuesday' }, s, METHOD))
      .toThrow(/must be a finite number/);
  });

  it('accepts a datetime as unix ms — the shape the webclient actually sends', () => {
    // ⚠ `datetime` IS a number on the wire: the control converts with
    // `new Date(raw).getTime()`, so by the rpc the type is a number. Validating datetime and
    // number together is the truth, not a shortcut.
    const s = schema(field({ key: 'start_at', type: 'datetime' }));
    expect(validateEditsAgainstSchema({ start_at: 1_700_000_000_000 }, s, METHOD))
      .toEqual({ start_at: 1_700_000_000_000 });
  });

  it('refuses NaN / Infinity, which are numbers but not values', () => {
    const s = schema(field({ key: 'n', type: 'number' }));
    expect(() => validateEditsAgainstSchema({ n: Number.NaN }, s, METHOD))
      .toThrow(/finite number/);
    expect(() => validateEditsAgainstSchema({ n: Number.POSITIVE_INFINITY }, s, METHOD))
      .toThrow(/finite number/);
  });

  it('refuses a non-boolean where boolean is declared', () => {
    const s = schema(field({ key: 'flag', type: 'boolean' }));
    expect(() => validateEditsAgainstSchema({ flag: 'true' }, s, METHOD))
      .toThrow(/must be a boolean/);
    expect(validateEditsAgainstSchema({ flag: false }, s, METHOD)).toEqual({ flag: false });
  });

  it('refuses a number where a string is declared', () => {
    expect(() => validateEditsAgainstSchema({ title: 42 }, schema(field()), METHOD))
      .toThrow(/must be a string/);
  });

  it('bounds a json field to something that survives the checkpoint round-trip', () => {
    const s = schema(field({ key: 'meta', type: 'json' }));
    expect(validateEditsAgainstSchema({ meta: { a: 1 } }, s, METHOD)).toEqual({ meta: { a: 1 } });
    // A bare scalar is a string/number field mis-declared.
    expect(() => validateEditsAgainstSchema({ meta: 'x' }, s, METHOD))
      .toThrow(/object or array/);
    // A cycle would not survive the checkpoint's JSON round-trip.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validateEditsAgainstSchema({ meta: cyclic }, s, METHOD))
      .toThrow(/JSON-serializable/);
  });
});

describe('D-210 2c — required + validation are enforced, not decoration', () => {
  it('refuses an empty required string', () => {
    const s = schema(field({ required: true }));
    expect(() => validateEditsAgainstSchema({ title: '   ' }, s, METHOD)).toThrow(/is required/);
    expect(() => validateEditsAgainstSchema({ title: null }, s, METHOD)).toThrow(/is required/);
  });

  it('lets a NON-required field be cleared', () => {
    const s = schema(field({ key: 'body', required: false }));
    expect(validateEditsAgainstSchema({ body: null }, s, METHOD)).toEqual({ body: null });
  });

  it('enforces validation.min / max on a number', () => {
    const s = schema(field({ key: 'n', type: 'number', validation: { min: 5, max: 10 } }));
    expect(() => validateEditsAgainstSchema({ n: 4 }, s, METHOD)).toThrow(/>= 5/);
    expect(() => validateEditsAgainstSchema({ n: 11 }, s, METHOD)).toThrow(/<= 10/);
    expect(validateEditsAgainstSchema({ n: 7 }, s, METHOD)).toEqual({ n: 7 });
  });

  it('enforces validation.pattern on a string', () => {
    const s = schema(field({ key: 'email', validation: { pattern: '^[^@]+@[^@]+$' } }));
    expect(() => validateEditsAgainstSchema({ email: 'not-an-email' }, s, METHOD))
      .toThrow(/does not match/);
    expect(validateEditsAgainstSchema({ email: 'a@b.test' }, s, METHOD))
      .toEqual({ email: 'a@b.test' });
  });

  it('REFUSES on a malformed pack pattern rather than silently allowing everything', () => {
    // ⛔ A broken regex must not become an accidental allow-all. It also must not become an
    // un-editable field with no stated cause — the refusal names the pattern.
    const s = schema(field({ validation: { pattern: '([unclosed' } }));
    expect(() => validateEditsAgainstSchema({ title: 'anything' }, s, METHOD))
      .toThrow(/invalid pattern/);
  });
});

describe('D-210 2c — the layer boundary', () => {
  it('validates SHAPE only — never value semantics', () => {
    // ⛔ A slot in the past is a well-shaped datetime. Whether it is bookable is the
    // projection's (`reject_if_slot_past`) and the gate's — a validator reaching for it would
    // be the wrong layer holding the wrong rule, and would disagree the first time either
    // changed.
    const s = schema(field({ key: 'start_at', type: 'datetime' }));
    expect(validateEditsAgainstSchema({ start_at: 1 }, s, METHOD)).toEqual({ start_at: 1 });
  });

  it('an empty schema still refuses every key (fail-closed, unchanged)', () => {
    // `form_response` targets hard-code `{ fields: [] }` — an immutable ADDITION has nothing
    // to edit, which is correct under the owner's destination model.
    expect(() => validateEditsAgainstSchema({ title: 'x' }, schema(), METHOD))
      .toThrow(/not in the operation's editable-args allowlist/);
  });

  it('no edits stays no edits', () => {
    expect(validateEditsAgainstSchema(undefined, schema(field()), METHOD)).toEqual({});
  });
});
