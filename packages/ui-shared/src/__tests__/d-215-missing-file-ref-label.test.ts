/** D-215 § 9e — an unresolvable `file_ref` must READ as broken.
 *
 *  A dish (or an auto-run row) can hold a `file_ref` whose underlying
 *  `data.file` was deleted, and NOTHING refcounts that: the eviction
 *  cascade's keepsets are `cache ∪ collection refs` and `shared ∪
 *  annotation refs` — a `config_overlay` is not a reference root. Before
 *  this the stored id rendered as its own label, so a broken argument
 *  looked like an ordinary (if ugly) value until the run failed.
 *
 *  The overlay needs a Document; this rule does not, so it lives in a pure
 *  function and is tested here. The WIRING (search → relabel via
 *  `setValue`, which deliberately does not fire `onChange`) is proven in
 *  the browser verify.
 */

import { describe, it, expect } from 'vitest';
import { fileRefDisplayLabel, MISSING_FILE_PREFIX } from '../variable-widgets.js';

describe('D-215 § 9e — fileRefDisplayLabel', () => {
  it('uses the inventory label when the ref resolves', () => {
    expect(fileRefDisplayLabel('file:abc', [
      { id: 'file:abc', label: 'poster.png' },
      { id: 'file:zzz', label: 'other.png' },
    ])).toBe('poster.png');
  });

  it('marks a ref MISSING when the inventory has no such id', () => {
    const label = fileRefDisplayLabel('file:gone', [{ id: 'file:abc', label: 'poster.png' }]);
    expect(label).toContain(MISSING_FILE_PREFIX);
    // The id survives in the label — the owner needs to know WHICH file.
    expect(label).toContain('file:gone');
  });

  it('marks it missing on an EMPTY inventory rather than rendering blank', () => {
    expect(fileRefDisplayLabel('file:gone', [])).toBe(`${MISSING_FILE_PREFIX}file:gone`);
  });

  it('does not accept a same-id hit with an empty label as resolution', () => {
    // A hit whose label is blank would paint an empty combobox — visually
    // identical to "no value", which is the blankness § 9e forbids.
    expect(fileRefDisplayLabel('file:abc', [{ id: 'file:abc', label: '' }]))
      .toBe(`${MISSING_FILE_PREFIX}file:abc`);
  });

  it('matches on the id, never on a coincidentally-equal label', () => {
    expect(fileRefDisplayLabel('poster.png', [{ id: 'file:abc', label: 'poster.png' }]))
      .toBe(`${MISSING_FILE_PREFIX}poster.png`);
  });
});
