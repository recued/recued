/** `map` expressions must resolve KEBAB-CASE keys — they silently did not.
 *
 *  The six `item`-scoped patterns in `collection.ts` used `[a-zA-Z_][\w.]*`, which excludes
 *  `-`. A projection over a kebab-case payload therefore failed the single-ref match, fell
 *  through to the "return as-is" branch, and wrote the LITERAL TEMPLATE STRING into the
 *  row: a column reading `{{item.first-release-date}}` where a date belonged, with nothing
 *  raised anywhere.
 *
 *  Found while binding MusicBrainz, whose payload is kebab-case throughout —
 *  `first-release-date`, `primary-type`, `artist-credit`, `release-groups`. Plain
 *  `{{step.x.a-b}}` refs already resolved; only the item-scoped ones were narrow, so the
 *  failure was invisible until a projection was written over such an API.
 *
 *  ⚠ Widening was measured before it was made: ZERO shipped recipes used a hyphenated
 *  `item` ref, so the change can only turn a passthrough into a resolution. A hyphen
 *  inside `{{item.…}}` is unambiguously part of the key because the ref cannot extend past
 *  its closing `}}` — the math tests below are the proof that subtraction is untouched.
 */
import { describe, expect, it } from 'vitest';
import { getTransform } from '../index.js';

const map = getTransform('map')!;
const ctx = { resolve: (r: string) => r, evaluate: () => false,
              now: () => new Date(), getTransform } as never;
const run = (expression: unknown, rows: Record<string, unknown>[]): unknown =>
  map({ array: rows, expression }, ctx);

const ROW = {
  title: 'The Wall', 'first-release-date': '1979-11-30', 'primary-type': 'Album',
  'artist-credit': [{ name: 'Pink Floyd' }],
  a: 10, b: 4, plain: '250', 'odd-num': '30000',
  nested: { 'sub-key': 'deep' }, list: [{ 'inner-key': 'x' }],
};

describe('map expression — kebab-case item keys', () => {
  it('resolves a hyphenated key instead of emitting the template', () => {
    expect(run({ d: '{{item.first-release-date}}', t: '{{item.primary-type}}' }, [ROW]))
      .toEqual([{ d: '1979-11-30', t: 'Album' }]);
  });

  it('resolves hyphenated keys NESTED at any depth', () => {
    expect(run({ deep: '{{item.nested.sub-key}}',
                 arr: '{{item.list.0.inner-key}}',
                 credit: '{{item.artist-credit.0.name}}' }, [ROW]))
      .toEqual([{ deep: 'deep', arr: 'x', credit: 'Pink Floyd' }]);
  });

  it('preserves type on a hyphenated pure ref, like any other pure ref', () => {
    const out = run({ c: '{{item.artist-credit}}' }, [ROW]) as { c: unknown }[];
    expect(Array.isArray(out[0].c)).toBe(true);
  });

  it('honours the | number coercion on a hyphenated key', () => {
    expect(run({ n: '{{item.odd-num | number}}' }, [ROW])).toEqual([{ n: 30000 }]);
  });

  it('interpolates a hyphenated key inside a longer string', () => {
    expect(run({ s: 'released {{item.first-release-date}}.' }, [ROW]))
      .toEqual([{ s: 'released 1979-11-30.' }]);
  });

  it('still yields nothing for a key that genuinely is not there', () => {
    // The widening must not make a missing key resolve to its own template either.
    expect(run({ x: '{{item.no-such-key}}' }, [ROW])).toEqual([{ x: undefined }]);
  });
});

describe('map expression — the math path is unaffected by the widening', () => {
  it('a hyphen BETWEEN two refs is still subtraction', () => {
    // The failure mode the widening had to avoid: a ref swallowing the minus sign. It
    // cannot, because the ref is bounded by its own `}}`.
    expect(run('{{item.a}} - {{item.b}}', [ROW])).toEqual([6]);
  });

  it('other operators are unaffected', () => {
    expect(run('{{item.a}} / {{item.b}}', [ROW])).toEqual([2.5]);
    expect(run('{{item.a}} * {{item.b}}', [ROW])).toEqual([40]);
    expect(run('{{item.a}} + {{item.b}}', [ROW])).toEqual([14]);
  });

  it('the plain-key coercion path did not regress', () => {
    expect(run({ n: '{{item.plain | number}}' }, [ROW])).toEqual([{ n: 250 }]);
  });
});
