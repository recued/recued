import type { TransformFn } from './types.js';

const str = (v: unknown): string => (v == null ? '' : String(v));

export const lowercase: TransformFn = (p) => str(p.input).toLowerCase();
export const uppercase: TransformFn = (p) => str(p.input).toUpperCase();
export const trim: TransformFn = (p) => str(p.input).trim();
/** UTF-16 code-unit length, matching JavaScript string limits and the prior
 * split("") + count recipe idiom without materializing one array entry per
 * character. Non-strings fail closed instead of being coerced. */
export const string_length: TransformFn = (p) =>
  typeof p.input === 'string' ? p.input.length : null;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** UTF-8 text → standard base64 (RFC 4648 §4, `=`-padded) — the encoding
 *  `core.storage.file.write` expects for `body_b64`, and the only way a recipe
 *  can author a file from its own computed data.
 *
 *  Returns `null` rather than encoding when there are no usable bytes:
 *  - nullish input is "no data", NOT the empty file. `str()` would coerce it to
 *    `''` and we would base64 an empty string, silently writing a 0-byte file.
 *    Same footgun `date_parse` guards (`new Date(null)` → epoch 0).
 *  - a non-primitive would go through `String()` as `"[object Object]"` and be
 *    faithfully encoded into the file body. The receiving `Buffer.from(x,
 *    'base64')` is lenient and would not catch it either.
 *  A null propagates to `file.write`'s required `body_b64` and rejects at the op
 *  boundary — loud — instead of persisting wrong bytes. Gate it with `is_null`.
 *
 *  Not `btoa`: that is latin1-only and throws/corrupts on any non-ASCII input.
 *  `TextEncoder` is global in both Node and browsers, so this stays portable. */
/** Standard base64 only (RFC 4648 §4), `=`-padded, no whitespace, no base64url.
 *  Deliberately strict: `Buffer.from(x, 'base64')` — what the file dispatcher
 *  runs — silently DISCARDS characters it does not recognise, so it "decodes"
 *  plain text into garbage bytes without ever failing. A lenient decoder here
 *  would launder that garbage into a recipe as if it were content. */
const B64_STRICT = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** charCode → 6-bit value. `=` maps to 0; the regex has already rejected any
 *  character not in the alphabet, so an unmapped slot is unreachable. */
const B64_INDEX = (() => {
  const t = new Uint8Array(128);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** Standard base64 → UTF-8 text. The inverse of `encode_base64`, and the only
 *  way to read `core.storage.file.read`'s `body_b64` as content.
 *
 *  Returns `null` — never a lie — in three cases:
 *  - nullish / non-primitive input: no data.
 *  - input that is not well-formed base64: see `B64_STRICT`. Plain text through
 *    a lenient decoder yields plausible-looking garbage, which is worse than a
 *    refusal because it flows onward as if it were the file's content.
 *  - bytes that are not valid UTF-8 (a PDF, a JPEG, an encrypted blob). Decoding
 *    those with the default replacing decoder yields mojibake studded with
 *    U+FFFD, which then reaches a model or a file as though it were text. `fatal`
 *    turns "this is not text" into a null the recipe can gate with `is_null`.
 *
 *  ⚠ It decodes to TEXT. It is not a way to move bytes: to copy a file, pass
 *  `file.read`'s `body_b64` straight to `file.write` and never decode at all. */
export const decode_base64: TransformFn = (p) => {
  const v = p.input;
  if (v == null || typeof v !== 'string') return null;
  if (!B64_STRICT.test(v)) return null;
  const pad = v.endsWith('==') ? 2 : v.endsWith('=') ? 1 : 0;
  const byteLen = (v.length / 4) * 3 - pad;
  const bytes = new Uint8Array(byteLen);
  let bi = 0;
  for (let i = 0; i < v.length; i += 4) {
    const n = (B64_INDEX[v.charCodeAt(i)]! << 18)
      | (B64_INDEX[v.charCodeAt(i + 1)]! << 12)
      | (B64_INDEX[v.charCodeAt(i + 2)]! << 6)
      | B64_INDEX[v.charCodeAt(i + 3)]!;
    if (bi < byteLen) bytes[bi++] = (n >> 16) & 0xff;
    if (bi < byteLen) bytes[bi++] = (n >> 8) & 0xff;
    if (bi < byteLen) bytes[bi++] = n & 0xff;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null; // well-formed base64, but the bytes are not text
  }
};

export const encode_base64: TransformFn = (p) => {
  const v = p.input;
  if (v == null) return null;
  if (typeof v === 'object') return null;
  const bytes = new TextEncoder().encode(String(v));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : undefined;
    out += B64[b0 >> 2];
    out += B64[((b0 & 0b11) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : B64[((b1 & 0b1111) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : B64[b2 & 0b111111];
  }
  return out;
};

export const split: TransformFn = (p) => str(p.input).split(str(p.delimiter));

export const contains_any: TransformFn = (p) => {
  const terms = p.terms as unknown[];
  if (!Array.isArray(terms)) return false;
  const caseSensitive = p.case_sensitive === true;
  const haystack = caseSensitive ? str(p.input) : str(p.input).toLowerCase();
  return terms.some((term) => {
    const needle = str(term).trim();
    if (!needle) return false;
    return haystack.includes(caseSensitive ? needle : needle.toLowerCase());
  });
};

export const concat: TransformFn = (p) => {
  const values = p.values as unknown[];
  return Array.isArray(values) ? values.map(str).join('') : '';
};

export const replace: TransformFn = (p) => {
  const input = str(p.input);
  const pattern = str(p.pattern);
  if (!pattern) return input;
  return p.all ? input.replaceAll(pattern, str(p.replacement)) : input.replace(pattern, str(p.replacement));
};

export const template: TransformFn = (p) => str(p.template);

/** ⛔⛔ THE BUDGET IS THE CONTRACT: the result must never be longer than
 *  `max_length`. The previous implementation could return FIVE TIMES it.
 *
 *  `input.slice(0, max - suffix.length)` goes NEGATIVE whenever `max` is smaller
 *  than the suffix, and `String.prototype.slice` reads a negative end as an
 *  offset from the END of the string — so it kept nearly everything and then
 *  appended the suffix on top. Measured on the old code with the DEFAULT suffix:
 *  `truncate({ input: 'abcdefgh', max_length: 2 })` returned `'abcdefg...'`,
 *  ten code units for a budget of two; `max_length: 0` returned eight.
 *  ⚠ The two corpus callers at `max_length: 2` pass `suffix: ''` and so never
 *  tripped it, which is exactly why it survived — the defect is invisible until
 *  someone omits the suffix and takes the default.
 *
 *  ⛔ AND THE CUT MUST FALL ON A CODE POINT. Slicing by UTF-16 unit can land
 *  between the halves of a surrogate pair and emit a lone surrogate — a string
 *  that is not merely wrong but ill-formed (`.isWellFormed() === false`), which
 *  then propagates into whatever consumes the preview.
 *
 *  When the budget cannot fit the suffix we drop the SUFFIX, not the content:
 *  at that size there is no room for a truncation marker, and returning some of
 *  the value beats returning a marker and none of it. */
const sliceCodePoints = (s: string, end: number): string => {
  if (end <= 0) return '';
  if (end >= s.length) return s;
  const cut = s.slice(0, end);
  const last = cut.charCodeAt(cut.length - 1);
  // A high surrogate at the cut has lost its partner — drop it.
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};

export const truncate: TransformFn = (p) => {
  const input = str(p.input);
  const max = Number(p.max_length);
  if (isNaN(max) || input.length <= max) return input;
  if (max <= 0) return '';
  const suffix = str(p.suffix ?? '...');
  if (suffix.length >= max) return sliceCodePoints(input, max);
  return sliceCodePoints(input, max - suffix.length) + suffix;
};

/** Common named HTML entities — the set that actually appears in vendor
 *  bodies (storage-format XHTML, email HTML), plus common accents / currency /
 *  punctuation. Numeric entities (decimal + hex) are decoded generically below.
 *  Full named coverage would need a large table; uncommon names are left
 *  verbatim (readable, e.g. `&hearts;`). */
const HTML_NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  middot: '·', bull: '•', deg: '°', plusmn: '±', times: '×', divide: '÷',
  sect: '§', para: '¶', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  pound: '£', euro: '€', cent: '¢', yen: '¥',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', ntilde: 'ñ',
  auml: 'ä', ouml: 'ö', uuml: 'ü', szlig: 'ß',
};

/** Decode named + numeric (decimal / hex) HTML entities. Unknown names,
 *  out-of-range code points, lone surrogates, and C0/C1 control chars (except
 *  tab / LF / CR) are left verbatim rather than emitted — so `&#0;` never
 *  injects a NUL / control byte into the plain-text output. Never throws. */
const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (m: string, body: string) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      if (code >= 0xd800 && code <= 0xdfff) return m; // lone surrogate
      if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
        || (code >= 0x7f && code <= 0x9f)) return m; // C0/C1 control
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return HTML_NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });

/** Max input processed — bounds the O(n²) worst case the tag / script / comment
 *  regexes hit on adversarial *unclosed* markup (`<a`×N with no `>`). Real
 *  bodies are far smaller; longer input is sliced (best-effort). Exported so a
 *  caller that needs COMPLETE output (not best-effort) can refuse over-length
 *  input up front rather than accept a silently-clipped result — the D-192
 *  CORE #8e projection-derive fails the row on `input.length > this`. */
export const STRIP_HTML_MAX_INPUT = 100_000;

/** Strip HTML/XHTML to plain text: drop <script>/<style> (including their
 *  content — even unclosed, or with a spaced close `</script >`), comments, and
 *  every tag; decode entities; collapse whitespace. Pure + deterministic. The
 *  output is plain text for DISPLAY (never re-injected as HTML), so decoding
 *  entities to literal characters is safe. Tags are stripped BEFORE entities are
 *  decoded, so text encoded to display literally (`&lt;b&gt;`) survives as
 *  literal text, not markup. NOT a full HTML parser: a `>` inside a quoted
 *  attribute value can leave a short attribute-tail fragment — acceptable under
 *  the plain-text contract, do NOT rely on this for HTML-injection safety.
 *
 *  The pure `string → string` core is exported separately (`stripHtmlText`)
 *  so non-transform callers can reuse it without a `TransformContext` — the
 *  D-192 CORE #8e work-entity projection-derive (`title ←
 *  strip_html(body.storage.value)`) is the first such consumer. The
 *  registered `strip_html` transform delegates to it (str-coerces its input
 *  first, matching the recipe-facing contract). */
export const stripHtmlText = (raw: string): string => {
  const input = raw.length > STRIP_HTML_MAX_INPUT ? raw.slice(0, STRIP_HTML_MAX_INPUT) : raw;
  const text = decodeEntities(
    input
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')  // closed blocks (spaced close ok)
      .replace(/<(script|style)\b[^>]*>[\s\S]*$/gi, ' ')            // unclosed block → drop to EOF
      .replace(/<!--[\s\S]*?-->/g, '')                             // comments (invisible)
      // Real tags only (name starts with a letter, or `!`/`?` for doctype/PI),
      // so a stray `<` in text (e.g. `3 < 5`) is preserved, not eaten.
      .replace(/<\/?[a-zA-Z!?][^>]*>/g, ' '),
  );
  return text.replace(/\s+/g, ' ').trim();
};

export const strip_html: TransformFn = (p) => stripHtmlText(str(p.input));
