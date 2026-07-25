/** D-177 P1 — adversarial tests for the canonical action-identity primitive.
 *
 *  The hashes back the Gateway's grant-match (N.4): a `canonical_payload_hash`
 *  collision admits a re-aimed action, a spurious mismatch re-asks (friction).
 *  So the security-load-bearing properties are: (1) value-equal-up-to-key-order
 *  payloads hash equal; (2) any authority-relevant value difference hashes
 *  different; (3) shape and value are independent guards; (4) exclusions remove
 *  ONLY what's declared and can NEVER reach an authority-bearing path. Each
 *  block names the invariant it defends. */

import { describe, it, expect } from 'vitest';
import {
  canonicalArgHash,
  projectResolvedArgs,
  validateHashExcludeArgs,
} from '../action-envelope.js';

const payloadHash = (a: Record<string, unknown>, excludePaths?: string[]) =>
  canonicalArgHash(a, excludePaths ? { excludePaths } : {}).canonical_payload_hash;
const shapeHash = (a: Record<string, unknown>) => canonicalArgHash(a).arg_shape_hash;

describe('canonicalArgHash — determinism + key-order invariance', () => {
  it('is stable across calls (pure)', () => {
    const a = { to: 'x', body: { n: 1 } };
    expect(canonicalArgHash(a)).toEqual(canonicalArgHash(a));
  });

  it('collapses key order at every nesting level (the core matching property)', () => {
    const a = { to: 'a@b.com', meta: { x: 1, y: 2 }, cc: ['p', 'q'] };
    const b = { cc: ['p', 'q'], meta: { y: 2, x: 1 }, to: 'a@b.com' };
    expect(payloadHash(a)).toBe(payloadHash(b));
    expect(shapeHash(a)).toBe(shapeHash(b));
  });

  it('does NOT reorder arrays — array order is semantic', () => {
    expect(payloadHash({ cc: ['a', 'b'] })).not.toBe(payloadHash({ cc: ['b', 'a'] }));
  });

  it('returns 64-char lowercase hex', () => {
    const { arg_shape_hash, canonical_payload_hash } = canonicalArgHash({ a: 1 });
    expect(arg_shape_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(canonical_payload_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('empty args is valid and stable', () => {
    expect(payloadHash({})).toBe(payloadHash({}));
    expect(payloadHash({})).not.toBe(payloadHash({ a: 1 }));
  });
});

describe('canonical_payload_hash — value sensitivity (no collisions on real diffs)', () => {
  it('a changed recipient hashes different (the re-aim guard)', () => {
    expect(payloadHash({ to: 'real@x.com' })).not.toBe(
      payloadHash({ to: 'attacker@x.com' }),
    );
  });

  it('distinguishes type without value change: 5 (number) vs "5" (string)', () => {
    expect(payloadHash({ n: 5 })).not.toBe(payloadHash({ n: '5' }));
  });

  it('distinguishes null from absent (no key collapse)', () => {
    expect(payloadHash({ a: null })).not.toBe(payloadHash({}));
  });

  it('distinguishes null from false and from 0 and from ""', () => {
    const hs = new Set([
      payloadHash({ a: null }),
      payloadHash({ a: false }),
      payloadHash({ a: 0 }),
      payloadHash({ a: '' }),
    ]);
    expect(hs.size).toBe(4);
  });

  it('does not confuse nesting: {a:{b:1}} vs {"a.b":1}', () => {
    expect(payloadHash({ a: { b: 1 } })).not.toBe(payloadHash({ 'a.b': 1 }));
  });

  it('does not confuse array vs object with numeric keys', () => {
    expect(payloadHash({ a: ['x'] })).not.toBe(payloadHash({ a: { 0: 'x' } }));
  });

  it('is sensitive to deep nested value changes', () => {
    expect(payloadHash({ a: { b: { c: 1 } } })).not.toBe(
      payloadHash({ a: { b: { c: 2 } } }),
    );
  });

  it('does not let key/value boundary slide: {ab:"c"} vs {a:"bc"}', () => {
    // A naive concat-without-delimiter canonicalizer collides these.
    expect(payloadHash({ ab: 'c' })).not.toBe(payloadHash({ a: 'bc' }));
  });
});

describe('arg_shape_hash — schema drift guard, independent of values', () => {
  it('same shape, different values → SAME shape hash', () => {
    expect(shapeHash({ to: 'a', n: 1 })).toBe(shapeHash({ to: 'z', n: 999 }));
  });

  it('different value-type → DIFFERENT shape hash', () => {
    expect(shapeHash({ n: 1 })).not.toBe(shapeHash({ n: 'one' }));
  });

  it('added/removed key → DIFFERENT shape hash', () => {
    expect(shapeHash({ a: 1 })).not.toBe(shapeHash({ a: 1, b: 2 }));
  });

  it('null leaf has a distinct shape from a string leaf', () => {
    expect(shapeHash({ a: null })).not.toBe(shapeHash({ a: 'x' }));
  });

  it('shape and value are independent: shapes can match while payloads differ', () => {
    const a = canonicalArgHash({ to: 'x' });
    const b = canonicalArgHash({ to: 'y' });
    expect(a.arg_shape_hash).toBe(b.arg_shape_hash);
    expect(a.canonical_payload_hash).not.toBe(b.canonical_payload_hash);
  });
});

describe('exclusions — remove exactly what is declared, nothing more', () => {
  it('excluding a volatile field makes two otherwise-equal payloads match', () => {
    const a = { to: 'x', client_ts: 111 };
    const b = { to: 'x', client_ts: 222 };
    expect(payloadHash(a)).not.toBe(payloadHash(b)); // differ without exclusion
    expect(payloadHash(a, ['client_ts'])).toBe(payloadHash(b, ['client_ts']));
  });

  it('excluding does NOT change a payload with no such field (no accidental match)', () => {
    expect(payloadHash({ to: 'x' }, ['client_ts'])).toBe(payloadHash({ to: 'x' }));
  });

  it('a real value difference still separates AFTER a volatile exclusion', () => {
    const a = { to: 'real@x.com', client_ts: 1 };
    const b = { to: 'evil@x.com', client_ts: 2 };
    expect(payloadHash(a, ['client_ts'])).not.toBe(payloadHash(b, ['client_ts']));
  });

  it('nested-object exclusion path works', () => {
    const a = { body: { to: 'x', ts: 1 } };
    const b = { body: { to: 'x', ts: 2 } };
    expect(payloadHash(a, ['body.ts'])).toBe(payloadHash(b, ['body.ts']));
    // and a sibling under the same parent still counts
    const c = { body: { to: 'x', ts: 1 } };
    const d = { body: { to: 'y', ts: 1 } };
    expect(payloadHash(c, ['body.ts'])).not.toBe(payloadHash(d, ['body.ts']));
  });

  it('a non-resolving exclusion path is a silent no-op on the hash', () => {
    const base = payloadHash({ a: { b: 1 } });
    expect(payloadHash({ a: { b: 1 } }, ['a.b.c.d'])).toBe(base); // descends past a scalar
    expect(payloadHash({ a: { b: 1 } }, ['z'])).toBe(base); // absent key
    expect(payloadHash({ a: { b: 1 } }, ['a.x'])).toBe(base); // absent nested key
  });

  it('exclusion does NOT traverse arrays (object-key paths only)', () => {
    // `list.0` must NOT remove element 0 — it is a no-op, leaving the hash intact.
    const base = payloadHash({ list: ['a', 'b'] });
    expect(payloadHash({ list: ['a', 'b'] }, ['list.0'])).toBe(base);
  });

  it('does NOT mutate the caller args object', () => {
    const a = { to: 'x', client_ts: 1 };
    canonicalArgHash(a, { excludePaths: ['client_ts'] });
    expect(a).toEqual({ to: 'x', client_ts: 1 });
  });

  it('arg_shape_hash is NOT reduced by exclusions (full schema stays pinned)', () => {
    // Spec N.2: exclusions touch the value hash only; the shape keeps the key.
    const withTs = canonicalArgHash({ to: 'x', client_ts: 1 }, { excludePaths: ['client_ts'] });
    const noTs = canonicalArgHash({ to: 'x' });
    expect(withTs.arg_shape_hash).not.toBe(noTs.arg_shape_hash);
  });

  it('multiple exclusion paths all apply', () => {
    const a = { to: 'x', t1: 1, t2: 9 };
    const b = { to: 'x', t1: 5, t2: 4 };
    expect(payloadHash(a, ['t1', 't2'])).toBe(payloadHash(b, ['t1', 't2']));
  });

  it('removes a literal dotted wire key, not only a nested object path', () => {
    const a = { to: 'x', 'body.client_ts': 111 };
    const b = { to: 'x', 'body.client_ts': 222 };
    expect(payloadHash(a)).not.toBe(payloadHash(b));
    expect(payloadHash(a, ['body.client_ts'])).toBe(payloadHash(b, ['body.client_ts']));
  });

  it('removes both literal and nested spellings when they coexist', () => {
    const a = {
      to: 'x',
      'body.client_ts': 111,
      body: { client_ts: 222, message: 'hi' },
    };
    const b = {
      to: 'x',
      'body.client_ts': 333,
      body: { client_ts: 444, message: 'hi' },
    };
    expect(payloadHash(a)).not.toBe(payloadHash(b));
    expect(payloadHash(a, ['body.client_ts'])).toBe(payloadHash(b, ['body.client_ts']));
  });

  it('single-segment exclusions are idempotent on the payload projection', () => {
    expect(payloadHash({ to: 'x', client_ts: 1 }, ['client_ts'])).toBe(
      payloadHash({ to: 'x' }, ['client_ts']),
    );
  });
});

describe('projectResolvedArgs — resolved-undefined JSON wire projection', () => {
  it('drops undefined object entries recursively', () => {
    const projected = projectResolvedArgs({
      a: undefined,
      b: 1,
      nested: { c: undefined, d: { e: undefined, f: 'ok' } },
      list: [{ g: undefined, h: true }],
    }) as Record<string, unknown>;

    expect(Object.prototype.hasOwnProperty.call(projected, 'a')).toBe(false);
    expect(projected.b).toBe(1);
    const nested = projected.nested as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(nested, 'c')).toBe(false);
    expect(nested.d).toMatchObject({ f: 'ok' });
    const item = (projected.list as Array<Record<string, unknown>>)[0];
    expect(Object.prototype.hasOwnProperty.call(item, 'g')).toBe(false);
    expect(item.h).toBe(true);
  });

  it('maps undefined array elements to null, including nested arrays', () => {
    expect(projectResolvedArgs({
      list: [undefined, { a: undefined, b: [undefined, 'x'] }],
    })).toMatchObject({
      list: [null, { b: [null, 'x'] }],
    });
  });

  it('passes Date, Map, and class instances through untouched so hashing still rejects them', () => {
    class Box {
      value = 1;
    }
    const date = new Date('2026-06-09T00:00:00.000Z');
    const map = new Map([['k', 'v']]);
    const box = new Box();

    const projected = projectResolvedArgs({ date, map, box });

    expect(projected.date).toBe(date);
    expect(projected.map).toBe(map);
    expect(projected.box).toBe(box);
    expect(() => canonicalArgHash(projected)).toThrow(TypeError);
  });

  it('returns null-prototype objects while preserving an own "__proto__" data key', () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"safe":1}') as Record<string, unknown>;
    const projected = projectResolvedArgs(input);

    expect(Object.getPrototypeOf(projected)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(projected, '__proto__')).toBe(true);
    expect((projected.__proto__ as Record<string, unknown>).polluted).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
  });

  it('never mutates the caller input', () => {
    const input = {
      a: undefined,
      nested: { b: undefined },
      list: [undefined],
    };

    projectResolvedArgs(input);

    expect(Object.prototype.hasOwnProperty.call(input, 'a')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(input.nested, 'b')).toBe(true);
    expect(input.list[0]).toBeUndefined();
  });

  it('composes with canonicalArgHash so undefined object fields equal absence', () => {
    expect(canonicalArgHash(projectResolvedArgs({ a: undefined, b: 1 }))).toEqual(
      canonicalArgHash(projectResolvedArgs({ b: 1 })),
    );
  });
});

describe('validateHashExcludeArgs — fail-closed on authority-bearing paths', () => {
  const AUTH = ['to', 'connection', 'body.calendar_id'];

  it('accepts a genuinely-volatile exclusion', () => {
    expect(validateHashExcludeArgs(['client_ts', 'trace_id'], AUTH).ok).toBe(true);
  });

  it('rejects excluding an authority path exactly', () => {
    const r = validateHashExcludeArgs(['to'], AUTH);
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual([{ path: 'to', reason: 'authority_bearing' }]);
  });

  it('rejects excluding a PARENT of an authority path (would drop the selector)', () => {
    // excluding `body` would remove `body.calendar_id`.
    expect(validateHashExcludeArgs(['body'], AUTH).ok).toBe(false);
  });

  it('rejects excluding a CHILD of an authority path (still touches the selector)', () => {
    expect(validateHashExcludeArgs(['to.name'], AUTH).ok).toBe(false);
  });

  it('does NOT reject a sibling that merely shares a prefix string', () => {
    // `toxic` is not under `to` segment-wise.
    expect(validateHashExcludeArgs(['toxic'], AUTH).ok).toBe(true);
    // `body.calendar_id_backup` is a different segment than `body.calendar_id`.
    expect(validateHashExcludeArgs(['body.calendar_id_backup'], AUTH).ok).toBe(true);
  });

  it('rejects an empty or blank-segment path (no silent no-op)', () => {
    expect(validateHashExcludeArgs([''], AUTH).violations[0].reason).toBe('empty_path');
    expect(validateHashExcludeArgs(['a..b'], AUTH).violations[0].reason).toBe('empty_path');
    expect(validateHashExcludeArgs(['a.'], AUTH).violations[0].reason).toBe('empty_path');
  });

  it('rejects an array-index segment (unsupported → would silently not exclude)', () => {
    expect(validateHashExcludeArgs(['list.0'], AUTH).violations[0].reason).toBe(
      'array_traversal',
    );
  });

  it('reports every violation, not just the first', () => {
    const r = validateHashExcludeArgs(['to', 'list.3', ''], AUTH);
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.reason).sort()).toEqual([
      'array_traversal',
      'authority_bearing',
      'empty_path',
    ]);
  });

  it('empty exclude list is trivially ok', () => {
    expect(validateHashExcludeArgs([], AUTH)).toEqual({ ok: true, violations: [] });
  });
});

describe('validateHashExcludeArgs — destination-name backstop (D-177 N.2 gap fold)', () => {
  // The primary authority check only protects DECLARED authority paths (wire
  // targets ∪ path_scope ∪ affects_target ∪ authority_args). A semantic
  // recipient an op author neglected to declare would otherwise be excludable,
  // dropping the destination out of the grant hash (re-aim a@b → c@d). The
  // backstop rejects a destination-shaped LEAF regardless of declaration.
  const NO_AUTH: readonly string[] = [];

  it('rejects an UNDECLARED recipient leaf (the gap)', () => {
    // `to` is NOT in the (empty) authority set — the old gate would allow it.
    const r = validateHashExcludeArgs(['to'], NO_AUTH);
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual([{ path: 'to', reason: 'destination_name' }]);
  });

  it('rejects a nested undeclared destination leaf (matches on the LEAF segment)', () => {
    for (const p of ['body.to', 'query.recipient', 'params.calendar_id', 'body.channel_id']) {
      const r = validateHashExcludeArgs([p], NO_AUTH);
      expect(r.ok, `${p} should be rejected`).toBe(false);
      expect(r.violations[0]!.reason).toBe('destination_name');
    }
  });

  it('is case-insensitive on the leaf', () => {
    expect(validateHashExcludeArgs(['body.To'], NO_AUTH).violations[0]!.reason)
      .toBe('destination_name');
    expect(validateHashExcludeArgs(['Recipient'], NO_AUTH).violations[0]!.reason)
      .toBe('destination_name');
  });

  it('covers the spec N.2 enumerated destinations + target-affecting leaves', () => {
    for (const leaf of [
      'to', 'cc', 'bcc', 'recipient', 'recipients', 'email', 'attendees',
      'phone', 'channel', 'channel_id', 'conversation_id', 'calendar_id',
      'source_id', 'destination_source_id', 'connection_id', 'connection_name',
    ]) {
      expect(validateHashExcludeArgs([leaf], NO_AUTH).ok, `${leaf} excludable?`).toBe(false);
    }
  });

  it('does NOT denylist generic volatile tokens (intended exclusions still validate)', () => {
    // The realistic intended use — client timestamps / correlation tokens —
    // must keep validating; only destination-shaped leaves are denied.
    expect(validateHashExcludeArgs(
      ['client_ts', 'trace_id', 'correlation_id', 'request_id', 'idempotency_key', 'nonce', 'bucket', 'note'],
      NO_AUTH,
    )).toEqual({ ok: true, violations: [] });
  });

  it('does NOT over-match a leaf that merely contains a destination word', () => {
    // `email_template` / `to_be_done` are not destinations.
    expect(validateHashExcludeArgs(['email_template'], NO_AUTH).ok).toBe(true);
    expect(validateHashExcludeArgs(['to_be_done'], NO_AUTH).ok).toBe(true);
  });

  it('a DECLARED destination still reports authority_bearing (backstop runs second)', () => {
    expect(validateHashExcludeArgs(['to'], ['to']).violations[0]!.reason)
      .toBe('authority_bearing');
  });
});

describe('adversarial: collision attempts an injected agent might try', () => {
  it('cannot forge a match by reordering nested keys to hide a changed destination', () => {
    const approved = { to: 'boss@co.com', subject: 's', body: 'b' };
    const tampered = { body: 'b', subject: 's', to: 'attacker@co.com' };
    expect(payloadHash(approved)).not.toBe(payloadHash(tampered));
  });

  it('cannot smuggle a destination change through an unexcluded sibling rename', () => {
    // shape changes too → the shape guard catches it even if a hash somehow aligned.
    const approved = canonicalArgHash({ to: 'boss@co.com' });
    const tampered = canonicalArgHash({ recipient: 'attacker@co.com' });
    expect(approved.arg_shape_hash).not.toBe(tampered.arg_shape_hash);
    expect(approved.canonical_payload_hash).not.toBe(tampered.canonical_payload_hash);
  });

  it('whitespace/structure in string values is preserved (no trimming collisions)', () => {
    expect(payloadHash({ to: 'a@b.com' })).not.toBe(payloadHash({ to: ' a@b.com' }));
    expect(payloadHash({ to: 'a@b.com' })).not.toBe(payloadHash({ to: 'a@b.com\n' }));
  });

  it('unicode-distinct destinations do not collide', () => {
    expect(payloadHash({ to: 'paypal.com' })).not.toBe(payloadHash({ to: 'pаypal.com' })); // Cyrillic а
  });
});

describe('prototype-key smuggling (codex HIGH #1)', () => {
  it('an own __proto__ key is hashed, not erased — no collision with {}', () => {
    const smuggled = JSON.parse('{"__proto__":{"to":"evil@x.com"}}');
    expect(payloadHash(smuggled)).not.toBe(payloadHash({}));
    expect(shapeHash(smuggled)).not.toBe(shapeHash({}));
  });

  it('different __proto__ payloads hash differently (the key really participates)', () => {
    const a = JSON.parse('{"__proto__":{"to":"real@x.com"}}');
    const b = JSON.parse('{"__proto__":{"to":"evil@x.com"}}');
    expect(payloadHash(a)).not.toBe(payloadHash(b));
  });

  it('hashing a smuggled payload does not pollute Object.prototype', () => {
    canonicalArgHash(JSON.parse('{"__proto__":{"polluted":true}}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('accepts a null-prototype args object and hashes it like its plain twin', () => {
    const o: Record<string, unknown> = Object.create(null);
    o.a = 1;
    o.b = 'x';
    expect(canonicalArgHash(o)).toEqual(canonicalArgHash({ a: 1, b: 'x' }));
  });
});

describe('fail-closed on non-JSON-clean args (codex HIGH #2)', () => {
  it('throws on NaN and ±Infinity (no collapse-to-null collision)', () => {
    expect(() => canonicalArgHash({ n: NaN })).toThrow(TypeError);
    expect(() => canonicalArgHash({ n: Infinity })).toThrow(TypeError);
    expect(() => canonicalArgHash({ n: -Infinity })).toThrow(TypeError);
  });

  it('throws on undefined object values (no omit-collision with absent)', () => {
    expect(() => canonicalArgHash({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalArgHash({ a: 1, b: undefined })).toThrow(TypeError);
  });

  it('throws on bigint / function / symbol leaves', () => {
    expect(() => canonicalArgHash({ a: 1n })).toThrow(TypeError);
    expect(() => canonicalArgHash({ a: () => 0 })).toThrow(TypeError);
    expect(() => canonicalArgHash({ a: Symbol('s') })).toThrow(TypeError);
  });

  it('throws on non-plain objects (Date / Map / RegExp / class instance)', () => {
    expect(() => canonicalArgHash({ d: new Date(0) })).toThrow(TypeError);
    expect(() => canonicalArgHash({ m: new Map() })).toThrow(TypeError);
    expect(() => canonicalArgHash({ r: /x/ })).toThrow(TypeError);
    class C { x = 1; }
    expect(() => canonicalArgHash({ c: new C() })).toThrow(TypeError);
  });

  it('throws on a sparse-array hole', () => {
    expect(() => canonicalArgHash({ a: [1, , 3] })).toThrow(TypeError); // eslint-disable-line no-sparse-arrays
  });

  it('throws on a non-finite value nested deep, naming the path', () => {
    expect(() => canonicalArgHash({ a: { b: [{ c: NaN }] } })).toThrow(/a\.b\[0\]\.c/);
  });

  it('still accepts all genuinely-clean JSON values', () => {
    expect(() =>
      canonicalArgHash({ s: 'x', n: 1.5, b: true, z: null, arr: [1, 'a'], o: { k: 0 } }),
    ).not.toThrow();
  });
});

describe('validateHashExcludeArgs — prototype-reserved segments (codex MEDIUM)', () => {
  it('rejects __proto__ / prototype / constructor anywhere in the path', () => {
    expect(validateHashExcludeArgs(['__proto__'], []).violations[0].reason).toBe(
      'reserved_segment',
    );
    expect(validateHashExcludeArgs(['a.constructor.b'], []).violations[0].reason).toBe(
      'reserved_segment',
    );
    expect(validateHashExcludeArgs(['prototype'], []).violations[0].reason).toBe(
      'reserved_segment',
    );
  });

  it('a reserved exclude path passed to canonicalArgHash is an inert no-op (no pollution)', () => {
    const base = payloadHash({ a: 1 });
    expect(payloadHash({ a: 1 }, ['__proto__.polluted'])).toBe(base);
    expect(payloadHash({ a: 1 }, ['constructor.prototype.polluted'])).toBe(base);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
