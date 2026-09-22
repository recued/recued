/** Executing a pack-declared `pattern` without handing the caller an exponent.
 *
 *  ⛔⛔ WHY THIS EXISTS. A declared `pattern` is compiled and run against a
 *  CALLER-supplied value at three places — the D-165 gateway
 *  (`closed-request-schema.ts`), the form renderer (`form-renderer/validators.ts`)
 *  and the reception inbox (`backend/server/src/reception-inbox-handler.ts`, a
 *  PUBLIC door). Node's loop is single-threaded and a synchronous regex is not
 *  interruptible, so a pattern that backtracks catastrophically stops the WHOLE
 *  SERVER rather than one request. Measured on this tree with `/^(a+)+$/`:
 *
 *      22 chars -> 16.8ms    26 chars -> 262.6ms
 *      24 chars -> 66.1ms    28 chars -> 1068.1ms      (~4x per 2 characters)
 *
 *  ⇒ 29 BYTES COSTS A SECOND. Size caps do not reach this: `MAX_CONTEXT_BYTES`
 *  is 52,428,800, which permits an input ~1.8 MILLION times longer than one that
 *  has already stalled the process. Memory and time are different axes and this
 *  bug is cheap on the one that is bounded.
 *
 *  🔑 SO THE FIX IS NOT TO EXECUTE IT. Measured over `community/packs/` at the
 *  time of writing: **18,204 pattern occurrences, but only 258 DISTINCT patterns**
 *  — they repeat ~70x each — and the head of that distribution is not "match this
 *  language", it is four or five semantic questions:
 *
 *      10,111 (55.5%)  "^-?(?:0|[1-9][0-9]*)$"     is this an integer
 *       2,163          "^\\s*\\{[\\s\\S]*\\}\\s*$"  does this look like a JSON object
 *         896          "^-?[0-9]+$"                is this an integer (different language!)
 *         860          uuid v1-8 + nil + max
 *         552          "^([a-f0-9]{24})$"          ObjectId
 *
 *  Each has a native implementation that is linear by construction and cannot
 *  backtrack. The table below dispatches the EXACT pattern string to that check;
 *  everything else compiles and runs as before.
 *
 *  🔑🔑 THE CONTRACT IS UNCHANGED, WHICH IS WHAT MAKES THIS SAFE. `pattern` is
 *  JSON Schema's keyword and it is published VERBATIM to MCP clients (the
 *  projection in `closed-request-schema.ts` is pass-through), so a model still
 *  reads the vendor's own regex. Nothing here re-derives what a vendor "meant";
 *  these are implementations OF the declared regex that happen not to backtrack.
 *
 *  ⛔ KEYED ON THE EXACT STRING, AND THAT IS THE SAFETY PROPERTY. No parsing, no
 *  inference, no "close enough" matching. A pattern differing by one character
 *  misses the table and falls to the engine — slower, never wrong. Fail-safe
 *  direction by construction.
 *
 *  ⛔⛔ AND A NATIVE CHECK IS WRITTEN AGAINST THE REGEX'S LANGUAGE, NEVER AGAINST
 *  THE HUMAN CONCEPT. The tempting `Number.isInteger(Number(s))` for entry 1
 *  disagrees with its own pattern on **1,760 of 11,171** probed inputs and every
 *  divergence FAILS OPEN — it accepts `""` (because `Number('')` is 0), `"-00"`,
 *  `" 1"`, `"1e3"`, `"0x10"`. Note also that `^-?(?:0|[1-9][0-9]*)$` and
 *  `^-?[0-9]+$` both read as "an integer" to a person and are DIFFERENT languages
 *  (the second admits `"007"`). Two entries, two checks, deliberately.
 *
 *  ⚠ Equivalence is enforced, not asserted once: `__tests__/declared-pattern.test.ts`
 *  drives every entry against `new RegExp(key)` over a generated corpus and fails
 *  if any recognizer ever diverges from the key it claims to implement. */

// ────────────────────────────────────────────────────────────────
// Character predicates — code-unit level, matching regex semantics
// ────────────────────────────────────────────────────────────────

const isDigit = (c: number): boolean => c >= 48 && c <= 57;

const isHexLower = (c: number): boolean => isDigit(c) || (c >= 97 && c <= 102);

const isHexAny = (c: number): boolean =>
  isDigit(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);

const isAlnum = (c: number): boolean =>
  isDigit(c) || (c >= 97 && c <= 122) || (c >= 65 && c <= 90);

/** Every code unit in `[from, to)` satisfies `pred`. */
const allBetween = (
  s: string,
  from: number,
  to: number,
  pred: (c: number) => boolean,
): boolean => {
  for (let i = from; i < to; i += 1) {
    if (!pred(s.charCodeAt(i))) return false;
  }
  return true;
};

// ────────────────────────────────────────────────────────────────
// The recognizers
// ────────────────────────────────────────────────────────────────

/** `^-?(?:0|[1-9][0-9]*)$` — a canonical integer: optional sign, then either a
 *  lone `0` or a non-zero leading digit. Rejects `"00"`, `"007"`, `"-0."`, `""`,
 *  `"-"`. Accepts `"-0"`, exactly as the pattern does. */
const isCanonicalInt = (v: string): boolean => {
  const n = v.length;
  const start = v.charCodeAt(0) === 45 ? 1 : 0;
  if (start >= n) return false;
  if (v.charCodeAt(start) === 48) return n - start === 1;
  return allBetween(v, start, n, isDigit);
};

/** `^-?[0-9]+$` — optional sign then one or more digits. Leading zeros ADMITTED;
 *  this is deliberately a different language from {@link isCanonicalInt}. */
const isSignedDigits = (v: string): boolean => {
  const n = v.length;
  const start = v.charCodeAt(0) === 45 ? 1 : 0;
  return start < n && allBetween(v, start, n, isDigit);
};

/** `^[0-9]+$` */
const isDigits = (v: string): boolean => v.length > 0 && allBetween(v, 0, v.length, isDigit);

/** `^\s*\{[\s\S]*\}\s*$` — leading/trailing whitespace around a brace-delimited
 *  body. `[\s\S]*` matches anything including newlines, so the whole question is
 *  the first and last non-space character.
 *
 *  ⚠ `String.prototype.trim` strips WhiteSpace + LineTerminator, which is exactly
 *  the set JS `\s` matches (` `, ` `, `﻿` included). The
 *  equivalence test drives those code points specifically. */
const looksJsonObject = (v: string): boolean => {
  const t = v.trim();
  return t.length >= 2 && t.charCodeAt(0) === 123 && t.charCodeAt(t.length - 1) === 125;
};

/** `^\s*\[[\s\S]*\]\s*$` */
const looksJsonArray = (v: string): boolean => {
  const t = v.trim();
  return t.length >= 2 && t.charCodeAt(0) === 91 && t.charCodeAt(t.length - 1) === 93;
};

/** `^([a-f0-9]{24})$` — Mongo ObjectId. Lower-case hex only. */
const isObjectId = (v: string): boolean => v.length === 24 && allBetween(v, 0, 24, isHexLower);

/** `^AC[0-9a-fA-F]{32}$` */
const isAcSid = (v: string): boolean =>
  v.length === 34
  && v.charCodeAt(0) === 65
  && v.charCodeAt(1) === 67
  && allBetween(v, 2, 34, isHexAny);

/** Dash positions shared by every 8-4-4-4-12 hex form. */
const hasUuidFrame = (v: string): boolean =>
  v.length === 36
  && v.charCodeAt(8) === 45
  && v.charCodeAt(13) === 45
  && v.charCodeAt(18) === 45
  && v.charCodeAt(23) === 45;

const uuidHexRunsAny = (v: string): boolean =>
  allBetween(v, 0, 8, isHexAny)
  && allBetween(v, 9, 13, isHexAny)
  && allBetween(v, 14, 18, isHexAny)
  && allBetween(v, 19, 23, isHexAny)
  && allBetween(v, 24, 36, isHexAny);

/** `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` */
const isUuidAnyVersion = (v: string): boolean => hasUuidFrame(v) && uuidHexRunsAny(v);

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

/** The versioned form: `[1-8]` at the version nibble and `[89abAB]` at the
 *  variant nibble, OR the nil / max literals (lower-case only, as written). */
const isUuidVersioned = (v: string): boolean => {
  if (v === NIL_UUID || v === MAX_UUID) return true;
  if (!hasUuidFrame(v) || !uuidHexRunsAny(v)) return false;
  const version = v.charCodeAt(14);
  if (version < 49 || version > 56) return false; // '1'..'8'
  const variant = v.charCodeAt(19);
  return variant === 56 || variant === 57        // '8' '9'
    || variant === 97 || variant === 98          // 'a' 'b'
    || variant === 65 || variant === 66;         // 'A' 'B'
};

/** `^[A-Za-z0-9][A-Za-z0-9._:-]{7,254}$` — 8..255 code units, alnum first. */
const isDottedHandle = (v: string): boolean => {
  const n = v.length;
  if (n < 8 || n > 255) return false;
  if (!isAlnum(v.charCodeAt(0))) return false;
  for (let i = 1; i < n; i += 1) {
    const c = v.charCodeAt(i);
    if (!isAlnum(c) && c !== 46 && c !== 95 && c !== 58 && c !== 45) return false;
  }
  return true;
};

/** `^[A-Za-z0-9._~-]+$` */
const isUnreservedToken = (v: string): boolean => {
  const n = v.length;
  if (n === 0) return false;
  for (let i = 0; i < n; i += 1) {
    const c = v.charCodeAt(i);
    if (!isAlnum(c) && c !== 46 && c !== 95 && c !== 126 && c !== 45) return false;
  }
  return true;
};

/** `^[^/?#]+$` — one or more of anything except `/`, `?`, `#`. A negated class
 *  DOES match a newline, and JS `$` without the `m` flag is a strict end of
 *  input, so `"a\nb"` is admitted. */
const isPathSegmentish = (v: string): boolean => {
  const n = v.length;
  if (n === 0) return false;
  for (let i = 0; i < n; i += 1) {
    const c = v.charCodeAt(i);
    if (c === 47 || c === 63 || c === 35) return false;
  }
  return true;
};

// ────────────────────────────────────────────────────────────────
// The table
// ────────────────────────────────────────────────────────────────

/** Exact pattern source -> a linear implementation of that same language.
 *
 *  ⚠ The comment beside each entry is its occurrence count in `community/packs/`
 *  when the table was written. It is provenance for WHY the entry earns a place,
 *  not a live figure — `declared-pattern.test.ts` asserts each key is still
 *  present in the corpus, never that the count still holds. */
export const DECLARED_PATTERN_FAST_PATHS: ReadonlyMap<string, (value: string) => boolean> =
  new Map<string, (value: string) => boolean>([
    ['^-?(?:0|[1-9][0-9]*)$', isCanonicalInt],                                  // 10,111
    ['^\\s*\\{[\\s\\S]*\\}\\s*$', looksJsonObject],                             //  2,163
    ['^-?[0-9]+$', isSignedDigits],                                             //    896
    [
      '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}'
      + '-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000'
      + '|ffffffff-ffff-ffff-ffff-ffffffffffff)$',
      isUuidVersioned,
    ],                                                                          //    860
    ['^([a-f0-9]{24})$', isObjectId],                                           //    552
    ['^[A-Za-z0-9][A-Za-z0-9._:-]{7,254}$', isDottedHandle],                    //    297
    ['^AC[0-9a-fA-F]{32}$', isAcSid],                                           //    274
    ['^[0-9]+$', isDigits],                                                     //    212
    ['^[A-Za-z0-9._~-]+$', isUnreservedToken],                                  //    149
    [
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
      isUuidAnyVersion,
    ],                                                                          //    143
    ['^[^/?#]+$', isPathSegmentish],                                            //    120
    ['^\\s*\\[[\\s\\S]*\\]\\s*$', looksJsonArray],                              //    107
  ]);

/** Compiled-regex cache for everything the table does not cover.
 *
 *  ⛔ THE CALL SITES COMPILED A FRESH `RegExp` ON EVERY DISPATCH. For the 10,111
 *  integer declarations that was a regex compilation per call, to check a number.
 *  Bounded because the key space is installed-pack content rather than caller
 *  input: past the cap we simply stop caching, which stays correct. */
const COMPILE_CACHE_MAX = 512;
const compiled = new Map<string, RegExp>();

/** Test `value` against a pack-declared `pattern`.
 *
 *  Semantics are those of `new RegExp(pattern).test(value)` — including THROWING
 *  on a pattern that does not compile, so callers that distinguish "invalid
 *  pattern" from "did not match" keep their existing `try`/`catch`. A recognized
 *  pattern is a known-valid literal and never throws. */
export const testDeclaredPattern = (pattern: string, value: string): boolean => {
  const fast = DECLARED_PATTERN_FAST_PATHS.get(pattern);
  if (fast !== undefined) return fast(value);
  let re = compiled.get(pattern);
  if (re === undefined) {
    re = new RegExp(pattern);
    if (compiled.size < COMPILE_CACHE_MAX) compiled.set(pattern, re);
  }
  return re.test(value);
};
