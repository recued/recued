/** A map expression that builds a REFERENCE, not arithmetic.
 *
 *  ⛔ Every Records reference is `<entity>/<id>`, so `"rental_contract/{{item.id}}"`
 *  contains a `/` — and the math case fired on "has a ref AND an operator".
 *  The ref substituted to a number, `rental_contract/0` evaluated, and the
 *  expression resolved to NULL. Silently: a seeded grid row arrived with a null
 *  tenancy and the write failed later for an unrelated-looking reason.
 *
 *  Found by driving `collect-rent` against a real store. No artifact test could
 *  see it — the recipe is well-formed and the transform is "working".
 */
import { describe, expect, it } from 'vitest';
import { map } from '../collection.js';

const run = (expression: unknown, items: unknown[]) =>
  map({ array: items, expression }, {} as never) as unknown[];

describe('map expressions that are text, not arithmetic', () => {
  it('builds a reference prefix containing a slash', () => {
    expect(run('rental_contract/{{item.id}}', [{ id: 'rec_1' }]))
      .toEqual(['rental_contract/rec_1']);
  });

  it('builds one inside an object template, which is how a row is seeded', () => {
    expect(run({ contract_ref: 'rental_contract/{{item.id}}', amount: '' }, [{ id: 'rec_1' }]))
      .toEqual([{ contract_ref: 'rental_contract/rec_1', amount: '' }]);
  });

  it('handles every ref prefix the corpus uses', () => {
    for (const kind of ['customer', 'unit', 'building', 'rental_contract', 'engagement']) {
      expect(run(`${kind}/{{item.id}}`, [{ id: 'x' }])).toEqual([`${kind}/x`]);
    }
  });

  /** ⛔ Parentheses around a ref left only `( )` once the refs were stripped,
   *  which passed the arithmetic test: `0 (0)` evaluated and every label read
   *  "0". Found listing Home Assistant cameras by name and entity id. */
  it('builds a label with the id in parentheses', () => {
    expect(run('{{item.name}} ({{item.id}})', [
      { name: 'Front Door', id: 'camera.front_door' },
      { name: 'Garden', id: 'camera.garden_east' },
    ])).toEqual(['Front Door (camera.front_door)', 'Garden (camera.garden_east)']);
  });

  it('still interpolates ordinary text that happens to contain an operator', () => {
    // A hyphen, a bracket, a percent sign in prose — all operators to the old
    // guard, none of them arithmetic.
    expect(run('{{item.name}} (self-serve) — 20% off', [{ name: 'Ada' }]))
      .toEqual(['Ada (self-serve) — 20% off']);
  });
});

describe('real arithmetic still evaluates', () => {
  it('computes a weighted value', () => {
    expect(run('{{item.amount}} * {{item.prob}} / 100', [{ amount: 1000, prob: 40 }]))
      .toEqual([400]);
  });

  it('handles parens, subtraction and a literal', () => {
    expect(run('({{item.a}} + {{item.b}}) * 2', [{ a: 3, b: 4 }])).toEqual([14]);
    expect(run('{{item.total}} - {{item.paid}}', [{ total: 1200, paid: 800 }])).toEqual([400]);
  });

  it('leaves a pure ref alone, preserving its type', () => {
    expect(run('{{item.n}}', [{ n: 7 }])).toEqual([7]);
  });

  it('evaluates every FUNCTION the math evaluator supports', () => {
    // ⚠ The regression my first fix caused. The guard checks what is left after
    // the refs are removed — so it has to strip the function names too, or it
    // rejects the expressions it exists to protect. This shape prices every
    // line in `billable-hours` and `invoice-book`: `round(minutes * rate / 60 *
    // 100) / 100`, with the step ref already substituted by the engine.
    expect(run('round({{item.minutes}} * 125 / 60 * 100) / 100', [{ minutes: 90 }]))
      .toEqual([187.5]);
    expect(run('min({{item.a}}, 5)', [{ a: 9 }])).toEqual([5]);
    expect(run('max({{item.a}}, 5)', [{ a: 9 }])).toEqual([9]);
    expect(run('abs({{item.a}})', [{ a: -3 }])).toEqual([3]);
    expect(run('floor({{item.a}} / 2)', [{ a: 7 }])).toEqual([3]);
    expect(run('ceil({{item.a}} / 2)', [{ a: 7 }])).toEqual([4]);
  });

  it('does NOT mistake a word that merely contains a function name', () => {
    // `background/…` contains `round`. Stripping on a word boundary keeps it
    // text, which is what a ref prefix is.
    expect(run('background/{{item.id}}', [{ id: 'x' }])).toEqual(['background/x']);
  });
});
