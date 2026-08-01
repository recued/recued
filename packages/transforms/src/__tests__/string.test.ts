import { describe, it, expect } from 'vitest';
import { lowercase, uppercase, trim, string_length, split, contains_any, concat, replace, template, truncate, strip_html, encode_base64, decode_base64 } from '../string.js';
import { ctx } from './helpers.js';

const c = ctx();

describe('string_length', () => {
  it('counts UTF-16 code units without materializing a character array', () => {
    expect(string_length({ input: '界😀' }, c)).toBe(3);
    expect(string_length({ input: null }, c)).toBeNull();
  });
});

describe('encode_base64', () => {
  // The contract that matters is the round-trip through the SAME decode the
  // file dispatcher runs (`Buffer.from(body_b64, 'base64')`, dispatcher.ts:209).
  // Asserting "it returns a string" would prove nothing — Buffer.from is
  // lenient and accepts near-anything.
  const decode = (b64: unknown): string =>
    Buffer.from(String(b64), 'base64').toString('utf8');

  it('round-trips ascii through the real decode', () => {
    const s = 'date,vendor,amount\n2026-07-16,Acme,12.00\n';
    expect(decode(encode_base64({ input: s }, c))).toBe(s);
  });

  it('round-trips multi-byte UTF-8 (btoa would corrupt this)', () => {
    const s = '# Rapport — café £9 · 日本語 · 🧾';
    expect(decode(encode_base64({ input: s }, c))).toBe(s);
  });

  it('matches Buffer base64 exactly across every padding remainder', () => {
    for (const s of ['', 'a', 'ab', 'abc', 'abcd', 'abcde', 'é', 'ée', 'éee']) {
      expect(encode_base64({ input: s }, c))
        .toBe(Buffer.from(s, 'utf8').toString('base64'));
    }
  });

  // Standard base64, NOT base64url — `file.write` decodes with
  // `Buffer.from(x, 'base64')`, which is alphabet-AGNOSTIC: it accepts `-_`
  // and `+/` alike. So no round-trip assertion can catch a base64url slip
  // (contracts/engagement.ts uses base64url, so the confusion is live). Only an
  // exact-match on input that reaches alphabet indices 62/63 pins it, and the
  // cases above never produce either character.
  it('emits the standard +/ alphabet, not base64url', () => {
    expect(encode_base64({ input: '>>>' }, c)).toBe('Pj4+');       // index 62
    expect(encode_base64({ input: '???' }, c)).toBe('Pz8/');       // index 63
    expect(encode_base64({ input: '🧾' }, c)).toBe('8J+nvg==');
    for (const s of ['>>>', '???', 'ÿþ', 'café £9 · 日本語 🧾']) {
      expect(encode_base64({ input: s }, c))
        .toBe(Buffer.from(s, 'utf8').toString('base64'));
    }
  });

  it('returns null for nullish — never a silent 0-byte file', () => {
    expect(encode_base64({ input: null }, c)).toBeNull();
    expect(encode_base64({ input: undefined }, c)).toBeNull();
  });

  it('returns null for a non-primitive rather than encoding "[object Object]"', () => {
    expect(encode_base64({ input: { a: 1 } }, c)).toBeNull();
    expect(encode_base64({ input: [1, 2] }, c)).toBeNull();
  });

  it('encodes primitives', () => {
    expect(decode(encode_base64({ input: 42 }, c))).toBe('42');
    expect(decode(encode_base64({ input: true }, c))).toBe('true');
  });
});

describe('decode_base64', () => {
  it('round-trips with encode_base64, including multi-byte', () => {
    for (const s of ['', 'a', 'ab', 'abc', 'date,amount\n2026-07-17,12.00\n',
      '# Rapport — café £9 · 日本語 · 🧾', '>>>', '???']) {
      expect(decode_base64({ input: encode_base64({ input: s }, c) }, c)).toBe(s);
    }
  });

  it("decodes what core.storage.file.read's body_b64 actually carries", () => {
    // file.read returns Buffer-produced standard base64 (dispatcher.ts:246).
    const body = '# Lease\n\nTerm: 12 months\nNotice: 60 days\n';
    const body_b64 = Buffer.from(body, 'utf8').toString('base64');
    expect(decode_base64({ input: body_b64 }, c)).toBe(body);
  });

  // ⛔ The leniency refusals. `Buffer.from(x, 'base64')` DISCARDS unrecognised
  // characters, so it "succeeds" on plain text and hands back garbage. A decoder
  // that mirrors that would launder garbage into a recipe as content.
  it('returns null for input that is not well-formed base64', () => {
    for (const bad of ['not base64 at all!', 'Pj4+extra', 'Pj4', 'ab*d', 'Pj4-']) {
      expect(decode_base64({ input: bad }, c), bad).toBeNull();
    }
    // ...where the lenient decoder happily returns bytes for the same input:
    expect(Buffer.from('not base64 at all!', 'base64').length).toBeGreaterThan(0);
  });

  it('returns null for well-formed base64 whose bytes are NOT text', () => {
    // A PDF header. Decoding this with a replacing decoder yields U+FFFD mojibake
    // that would flow onward to a model or a file as though it were content.
    const pdfBytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x80, 0xff, 0xfe]);
    expect(decode_base64({ input: pdfBytes.toString('base64') }, c)).toBeNull();
  });

  it('returns null for nullish / non-string', () => {
    expect(decode_base64({ input: null }, c)).toBeNull();
    expect(decode_base64({ input: undefined }, c)).toBeNull();
    expect(decode_base64({ input: 42 }, c)).toBeNull();
    expect(decode_base64({ input: { a: 1 } }, c)).toBeNull();
  });
});

describe('lowercase', () => {
  it('lowercases', () => expect(lowercase({ input: 'HELLO' }, c)).toBe('hello'));
  it('handles null', () => expect(lowercase({ input: null }, c)).toBe(''));
});

describe('uppercase', () => {
  it('uppercases', () => expect(uppercase({ input: 'hello' }, c)).toBe('HELLO'));
});

describe('trim', () => {
  it('trims whitespace', () => expect(trim({ input: '  hi  ' }, c)).toBe('hi'));
});

describe('split', () => {
  it('splits by delimiter', () => expect(split({ input: 'a,b,c', delimiter: ',' }, c)).toEqual(['a', 'b', 'c']));
});

describe('contains_any', () => {
  it('matches any non-empty term case-insensitively by default', () => {
    expect(contains_any({ input: 'Quarterly Invoice Ready', terms: ['receipt', ' invoice '] }, c)).toBe(true);
  });

  it('returns false when no terms match', () => {
    expect(contains_any({ input: 'Newsletter', terms: ['invoice', 'urgent'] }, c)).toBe(false);
  });

  it('ignores empty terms', () => {
    expect(contains_any({ input: 'Newsletter', terms: ['', '   '] }, c)).toBe(false);
  });

  it('can match case-sensitively', () => {
    expect(contains_any({ input: 'Invoice', terms: ['invoice'], case_sensitive: true }, c)).toBe(false);
    expect(contains_any({ input: 'Invoice', terms: ['Inv'], case_sensitive: true }, c)).toBe(true);
  });
});

describe('concat', () => {
  it('concatenates values', () => expect(concat({ values: ['a', 'b', 'c'] }, c)).toBe('abc'));
  it('handles non-strings', () => expect(concat({ values: [1, true, null] }, c)).toBe('1true'));
});

describe('replace', () => {
  it('replaces first occurrence', () => expect(replace({ input: 'aaa', pattern: 'a', replacement: 'b' }, c)).toBe('baa'));
  it('replaces all', () => expect(replace({ input: 'aaa', pattern: 'a', replacement: 'b', all: true }, c)).toBe('bbb'));
});

describe('template', () => {
  it('returns resolved template', () => expect(template({ template: 'hello world' }, c)).toBe('hello world'));
});

describe('truncate', () => {
  it('truncates long string', () => expect(truncate({ input: 'hello world', max_length: 8 }, c)).toBe('hello...'));
  it('preserves short string', () => expect(truncate({ input: 'hi', max_length: 10 }, c)).toBe('hi'));
  it('custom suffix', () => expect(truncate({ input: 'hello world', max_length: 8, suffix: '~' }, c)).toBe('hello w~'));
});

describe('strip_html', () => {
  it('strips tags to plain text', () =>
    expect(strip_html({ input: '<p>Hello <b>world</b></p>' }, c)).toBe('Hello world'));
  it('drops <script>/<style> including their content', () =>
    expect(strip_html({ input: '<style>.x{color:red}</style>Hi<script>alert(1)</script>' }, c)).toBe('Hi'));
  it('drops HTML comments entirely', () =>
    expect(strip_html({ input: 'A<!-- secret -->B' }, c)).toBe('AB'));
  it('decodes named entities', () =>
    expect(strip_html({ input: 'Tom &amp; Jerry' }, c)).toBe('Tom & Jerry'));
  it('decodes numeric decimal + hex entities', () =>
    expect(strip_html({ input: '&#65;&#x42;C' }, c)).toBe('ABC'));
  it('treats &nbsp; as space and collapses whitespace', () =>
    expect(strip_html({ input: 'a&nbsp;&nbsp;b\n\n   c' }, c)).toBe('a b c'));
  it('preserves text that was HTML-encoded to display literally', () =>
    expect(strip_html({ input: '&lt;b&gt;x&lt;/b&gt;' }, c)).toBe('<b>x</b>'));
  it('leaves an out-of-range numeric entity verbatim', () =>
    expect(strip_html({ input: 'x&#9999999999;y' }, c)).toBe('x&#9999999999;y'));
  it('does not eat a stray < in text', () =>
    expect(strip_html({ input: '3 < 5 and a>b' }, c)).toBe('3 < 5 and a>b'));
  it('sanitizes Confluence storage-format XHTML to a clean title', () =>
    expect(strip_html({ input: '<p>Review the <ac:link ac:anchor="x">design doc</ac:link> today</p>' }, c))
      .toBe('Review the design doc today'));
  it('handles null', () => expect(strip_html({ input: null }, c)).toBe(''));
  it('coerces non-strings', () => expect(strip_html({ input: 123 }, c)).toBe('123'));
  // hardening (codex review fold)
  it('drops an unclosed <script> body to EOF', () =>
    expect(strip_html({ input: '<script>alert(1)' }, c)).toBe(''));
  it('drops a script block with a spaced close </script >', () =>
    expect(strip_html({ input: 'a<script>x</script >b' }, c)).toBe('a b'));
  it('leaves control + surrogate numeric entities verbatim (no NUL/control emitted)', () =>
    expect(strip_html({ input: '&#0;X&#xD800;Y' }, c)).toBe('&#0;X&#xD800;Y'));
  it('decodes an allowed tab entity then collapses it', () =>
    expect(strip_html({ input: 'a&#9;b' }, c)).toBe('a b'));
  it('decodes the extended named-entity set (accents/currency/punctuation)', () =>
    expect(strip_html({ input: 'caf&eacute; &euro;5 &laquo;q&raquo;' }, c)).toBe('café €5 «q»'));
  it('caps oversized input (bounds the O(n^2) worst case)', () =>
    expect(strip_html({ input: 'x'.repeat(150_000) }, c)).toHaveLength(100_000));
  it('KNOWN LIMITATION (#2a): a > inside a quoted attribute leaves a tail fragment', () =>
    expect(strip_html({ input: '<div title="2 > 1">Hello</div>' }, c)).toBe('1">Hello'));
});
