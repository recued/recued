/** Storable-encoding gate — reject strings Postgres `jsonb` cannot hold.
 *
 *  Two characters, in two files, once stopped the marketplace seed dead
 *  (2026-07-21) and left 476 of 926 packs unpublished:
 *
 *    - an orphaned high surrogate (U+D83D) — an emoji cut in half by a
 *      code-unit `slice()` in a docs-import generator;
 *    - a raw NUL inside a perfectly correct filename regex `^[^<NUL>/\\]+$`
 *      lifted from a vendor's OpenAPI spec.
 *
 *  The second is why this belongs in the publish path and not just in a corpus
 *  test: it was not corruption. Any publisher importing a spec can reproduce it,
 *  and without this gate they get `PGRST102: Empty or invalid json` from
 *  PostgREST — a message naming neither the file, the field, nor the character.
 *  Finding the first one took a row-by-row bisect of a 50-row batch.
 *
 *  ⚠ WALKS THE PARSED VALUE, NEVER `JSON.stringify` OUTPUT. ES2019 well-formed
 *  stringify escapes both a lone surrogate and a NUL into six ASCII characters,
 *  so scanning serialized JSON reports CLEAN on exactly the input that is
 *  broken. Both defects were missed that way on first pass.
 *
 *  REJECTS, never sanitises. Silently stripping characters would have changed
 *  what the Samsara regex means — the publisher has to see it and decide.
 */

export type UnstorableKind = 'lone_surrogate' | 'raw_nul';

export interface UnstorableFinding {
  /** JSON path to the offending string, e.g. `.contents[0].composition.name`. */
  path: string;
  kind: UnstorableKind;
  /** Code point in `U+XXXX` form. */
  code: string;
  /** Index of the offending character within the string. */
  index: number;
  /** Short excerpt around the offender, for a human-readable message. */
  excerpt: string;
}

/** A high surrogate not followed by a low one, or a low one not preceded by a
 *  high one. Either half alone is unrepresentable in UTF-8. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Built by code point, never written as an escape literal: tooling that
 *  rewrites this file can turn the literal escape into an actual NUL byte —
 *  which is one of the ways the defect gets introduced in the first place. */
const NUL_CODE = 0;
const RAW_NUL = new RegExp(String.fromCharCode(NUL_CODE));

const isUnstorable = (codeUnit: number): boolean =>
  codeUnit === NUL_CODE || (codeUnit >= 0xd800 && codeUnit <= 0xdfff);

/** Default cap on reported findings. A corrupted document can carry thousands;
 *  a publisher needs the first few, not a wall. The CAP IS REPORTED by the
 *  caller — never let a truncated list read as "that's all of them". */
export const UNSTORABLE_FINDING_LIMIT = 20;

/** Every string leaf in `doc` that Postgres jsonb would reject.
 *
 *  Returns `[]` for a storable document, so `findUnstorableStrings(x).length === 0`
 *  is the gate. Non-string leaves, cycles-free plain data only — this runs on
 *  parsed JSON, which by construction has neither cycles nor exotic types. */
export const findUnstorableStrings = (
  doc: unknown,
  opts: { limit?: number } = {},
): UnstorableFinding[] => {
  const limit = opts.limit ?? UNSTORABLE_FINDING_LIMIT;
  const found: UnstorableFinding[] = [];

  const visit = (node: unknown, path: string): void => {
    if (found.length >= limit) return;
    if (typeof node === 'string') {
      const lone = LONE_SURROGATE.test(node);
      const nul = RAW_NUL.test(node);
      if (!lone && !nul) return;
      const index = [...node].findIndex((c) => isUnstorable(c.charCodeAt(0)));
      if (index < 0) return;
      const unit = node.charCodeAt(index);
      found.push({
        path,
        kind: unit === NUL_CODE ? 'raw_nul' : 'lone_surrogate',
        code: `U+${unit.toString(16).toUpperCase().padStart(4, '0')}`,
        index,
        excerpt: node.slice(Math.max(0, index - 30), index + 10),
      });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => visit(v, `${path}[${i}]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) visit(v, `${path}.${k}`);
    }
  };

  visit(doc, '');
  return found;
};

/** Human-readable message for one finding. Names the exact character and where
 *  it sits — the thing PostgREST's error refuses to tell you. */
export const describeUnstorable = (f: UnstorableFinding): string =>
  f.kind === 'raw_nul'
    ? `contains a NUL character (${f.code}) at index ${f.index}, which Postgres cannot store. `
      + `If a regex needs to mean "no NUL", spell it \\x00 instead — same match, storable.`
    : `contains an unpaired UTF-16 surrogate (${f.code}) at index ${f.index} — usually an emoji `
      + `truncated mid-pair. Remove it or restore the full character.`;
