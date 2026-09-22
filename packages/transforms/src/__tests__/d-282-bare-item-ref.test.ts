/** `{{item}}` in a `map` expression — the element itself.
 *
 *  ⛔⛔ IT USED TO SHIP AS LITERAL TEXT. Every item regex required
 *  `item.<path>`, so a bare reference matched none of them and fell to
 *  `resolveExpression`'s final case — "Anything else: returned as-is". Six
 *  shipped recipes mapped a STRING array into objects (urls, terms, claim
 *  lines, checklist labels) — precisely the shape where no path exists to
 *  write — and every one rendered the characters `{{item}}` while reporting
 *  success.
 *
 *  🔑 The rule was already this everywhere else: `resolveRef` ends
 *  `return path ? walkPath(store, path) : store`, so a bare `{{item}}` under a
 *  `foreach` has always been the element. 97 of the corpus's 103 bare refs are
 *  `foreach` uses and work; only `map` disagreed with its own sibling. */
import { describe, expect, it } from 'vitest';

import { map } from '../collection.js';

const mapped = (array: unknown[], expression: unknown): unknown =>
  map({ array, expression } as never, {} as never);

describe('a bare {{item}} in a map expression', () => {
  it('resolves to a string element', () => {
    expect(mapped(['https://a', 'https://b'], { url: '{{item}}' }))
      .toEqual([{ url: 'https://a' }, { url: 'https://b' }]);
  });

  /** Pure refs preserve type — the same rule `{{item.path}}` follows, which is
   *  why this returns a number rather than "7". */
  it('preserves the element type when the whole expression is the ref', () => {
    expect(mapped([7, 8], '{{item}}')).toEqual([7, 8]);
    expect(mapped([{ a: 1 }], '{{item}}')).toEqual([{ a: 1 }]);
    expect(mapped([null], '{{item}}')).toEqual([null]);
  });

  it('interpolates into surrounding text', () => {
    expect(mapped(['first', 'second'], '• {{item}}'))
      .toEqual(['• first', '• second']);
  });

  /** ⚠ An object element renders as compact JSON, never "[object Object]" —
   *  `interpolationText`'s garble rule, inherited rather than re-decided. */
  it('renders an object element readably when interpolated', () => {
    expect(mapped([{ a: 1 }], 'row: {{item}}')).toEqual(['row: {"a":1}']);
  });

  it('works inside a nested template, beside a pathed ref', () => {
    expect(mapped(
      [{ n: 'x' }],
      { whole: '{{item}}', part: '{{item.n}}', list: ['{{item}}'] },
    )).toEqual([{ whole: { n: 'x' }, part: 'x', list: [{ n: 'x' }] }]);
  });

  it('coerces, the same way a pathed ref does', () => {
    expect(mapped(['30000', ''], '{{item | number}}')).toEqual([30000, null]);
    expect(mapped(['alice@example.com'], '{{item | local_part}}')).toEqual(['alice']);
  });

  it('participates in arithmetic', () => {
    expect(mapped([10, 20], '{{item}} * 2')).toEqual([20, 40]);
  });

  /** ⛔ THE REGRESSION GUARD FOR THE WIDENING ITSELF. Making the path optional
   *  must not change what a PATHED ref does — including the case where the
   *  field is missing, which drops the key rather than emitting null. */
  it('leaves pathed refs exactly as they were', () => {
    expect(mapped([{ a: 1, b: 2 }], { x: '{{item.a}}', y: '{{item.b}}' }))
      .toEqual([{ x: 1, y: 2 }]);
    expect(mapped([{ a: 1 }], { x: '{{item.nope}}' })).toEqual([{}]);
  });

  /** ⛔ A NUMERIC PATH SEGMENT — the SECOND way these regexes were narrow, and
   *  the corpus check beside this file is what found it. `getField` has always
   *  indexed an array by a numeric segment; only the regex required a letter
   *  first. `track-flight-opensky` reads OpenSky state vectors, which ARE
   *  positional arrays, and rendered `{{item.0}}` for twelve fields. */
  it('reads a positional element by index', () => {
    expect(mapped([['icao', 'CALLSIGN', 'DE']], { id: '{{item.0}}', country: '{{item.2}}' }))
      .toEqual([{ id: 'icao', country: 'DE' }]);
    expect(mapped([{ rows: [{ n: 9 }] }], '{{item.rows.0.n}}')).toEqual([9]);
  });

  /** And a string that merely CONTAINS the word item is still literal text. */
  it('does not touch text that is not a reference', () => {
    expect(mapped(['x'], 'item')).toEqual(['item']);
    expect(mapped(['x'], '{{items}}')).toEqual(['{{items}}']);
  });
});
