/** The shared CSV cell serializer — the rule four surfaces now agree on. */

import { describe, expect, it } from 'vitest';

import { csvCell } from '../csv.js';

describe('csvCell — formula neutralisation', () => {
  it('⛔⛔ prefixes every character a spreadsheet reads as a formula start', () => {
    for (const lead of ['=', '+', '-', '@']) {
      expect(csvCell(`${lead}cmd`), lead).toBe(`'${lead}cmd`);
    }
  });

  it('⛔ finds the trigger PAST leading whitespace', () => {
    // ` =1+1` still evaluates in some applications, which is why the rule is
    // `^\s*` and not `^`.
    expect(csvCell('  =1+1')).toBe("'  =1+1");
    expect(csvCell('\t@SUM(A1)')).toBe("'\t@SUM(A1)");
  });

  it('⛔ leaves an ordinary value alone — this is not a blanket prefix', () => {
    for (const plain of ['ordinary', 'a=b', '1+1', 'user@example.com', '', 'x-y']) {
      expect(csvCell(plain), plain).toBe(plain);
    }
  });

  it('⚠ a trigger character NOT at the start is not a formula', () => {
    // `a=b` is text. Prefixing it would corrupt ordinary data for no gain.
    expect(csvCell('total=5')).toBe('total=5');
  });
});

describe('csvCell — RFC 4180 quoting', () => {
  it('quotes a cell containing the delimiter, a quote, or a newline', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  it('⛔ honours a NON-COMMA delimiter', () => {
    // `to_csv` takes a caller-supplied delimiter. Quoting against a hardcoded
    // comma would under-trigger and split the row on the real separator.
    expect(csvCell('a;b', { delimiter: ';' })).toBe('"a;b"');
    expect(csvCell('a;b')).toBe('a;b');
    expect(csvCell('a,b', { delimiter: ';' })).toBe('a,b');
  });

  it('⛔ alwaysQuote preserves a uniformly-quoted file', () => {
    // Two surfaces quote every cell. Adopting the shared helper must not
    // change the SHAPE of their output, only neutralise formulas.
    expect(csvCell('plain', { alwaysQuote: true })).toBe('"plain"');
    expect(csvCell('', { alwaysQuote: true })).toBe('""');
  });
});

describe('csvCell — the two layers together', () => {
  it('⛔⛔ neutralises FIRST, then quotes the final text', () => {
    // ⚠ ORDER IS LOAD-BEARING. The prefix changes the value, so the quoting
    // decision belongs to the prefixed string. Reversed, a neutralised cell
    // containing a delimiter would be escaped on the pre-prefix text.
    expect(csvCell('=a,b')).toBe('"\'=a,b"');
    expect(csvCell('=a"b')).toBe('"\'=a""b"');
  });

  it('⛔⛔ QUOTING ALONE NEVER DISARMS A FORMULA — the point of the whole file', () => {
    // A quoted formula is still a formula: the application strips the quotes,
    // then evaluates what is left. Only the prefix changes the VALUE.
    const quotedOnly = `"${'=HYPERLINK("http://x","go")'.replace(/"/g, '""')}"`;
    expect(quotedOnly.startsWith('"=')).toBe(true); // ← live after parsing
    expect(csvCell('=HYPERLINK("http://x","go")').startsWith('"\'=')).toBe(true);
  });
});
