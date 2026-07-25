/** D-164 P11 — referent list-shape parsing.
 *
 *  Parses the REFERENT text (the prior assistant turn) into an ordered
 *  item list so the list-anaphora binder (`./anaphora-rewrite.ts`) can
 *  resolve "the second one" / "that one" to one item. This is the
 *  list-item half of the two-text mechanism: pronouns bind the
 *  referent's unique NAME (P9); ordinals / demonstratives index into
 *  the referent's LIST SHAPE — a different closed mechanism on the same
 *  intention substrate.
 *
 *  Closed shapes only (design § 3 Invariant 5 — a mis-parsed list is a
 *  WRONG-PERSON answer downstream, so anything unmodeled returns `null`
 *  and the gate passes through):
 *    - **Numbered lines** — `1. item` / `1) item`. The authored numbers
 *      must run EXACTLY 1..N in order: a broken or restarted sequence
 *      means two lists or stray numbering, and markdown's all-`1.`
 *      authoring convention (renderers renumber; the raw text the user
 *      SAW disagrees with what we'd index) also fails the rule — defer
 *      rather than mis-index.
 *    - **Bulleted lines** — `- item` / `* item` / `• item`, indexed in
 *      order of appearance.
 *    - **Mixed shapes defer.** A message carrying BOTH numbered and
 *      bulleted lines (commonly a nested list) is ambiguous about which
 *      list "the second one" indexes.
 *    - **Uniform indentation.** Every list line must share the SAME
 *      leading-whitespace prefix. Differing indents are a nested list
 *      flattened ("1. Pat\n   - detail\n2. Bob" already defers as
 *      mixed; "- Pat\n  - sub" defers here) — sub-items must not
 *      consume ordinal positions.
 *    - **One contiguous list.** Between the first and last list line,
 *      every line must be a list line or BLANK (markdown's loose-list
 *      authoring). A prose line interleaved means visually SEPARATE
 *      lists ("Sales:\n- Pat Lee\nEngineering:\n- Bob Stone") that must
 *      not merge into one ordinal space — "the second one" against
 *      merged blocks indexes a different item than the user counted
 *      (codex fold: the wrong-person merge).
 *    - **No bare markers.** A line that is ONLY a list marker
 *      (`-` / `2.` with no item text) anywhere in the message is a
 *      list shape the parser can't model — the user may count the
 *      empty slot, the parser can't — so the whole referent defers
 *      rather than silently compacting ordinals (codex fold).
 *
 *  Other non-list lines (prose, blanks) outside the list span are
 *  ignored — a list embedded in a longer answer ("I found these:\n
 *  1. …\n2. …\nWant more?") still parses. Items are the line
 *  remainders after the marker; markdown decoration (`**bold**`,
 *  trailing detail) stays in the item text — the binder's per-item NER
 *  handles it.
 *
 *  Pure module: text in, items-or-null out. No ctx, no IO. */

/** One parsed list line: its indent, marker kind, authored number (for
 *  numbered lines), and the item text after the marker. */
interface ListLine {
  readonly indent: string;
  readonly kind: 'numbered' | 'bulleted';
  readonly ordinal: number | null;
  readonly text: string;
}

/** `1. item` / `1) item` — up to three digits (the sequence rule bounds
 *  real lists far below that; longer digit runs are ids, not markers). */
const NUMBERED_LINE_RE = /^(\s*)(\d{1,3})[.)]\s+(\S.*)$/;

/** `- item` / `* item` / `• item`. The required whitespace after the
 *  marker keeps `*emphasis*` / a leading minus sign from reading as a
 *  bullet. */
const BULLETED_LINE_RE = /^(\s*)[-*•]\s+(\S.*)$/;

/** A line that is ONLY a marker — `-` / `2.` / `3)` with no item text.
 *  (A markdown horizontal rule `---` has more than one marker char and
 *  stays prose.) */
const BARE_MARKER_LINE_RE = /^\s*(?:\d{1,3}[.)]|[-*•])\s*$/;

/** Whitespace-only — permitted INSIDE the list span (loose lists). */
const BLANK_LINE_RE = /^\s*$/;

const parseLine = (line: string): ListLine | null => {
  const numbered = NUMBERED_LINE_RE.exec(line);
  if (numbered !== null) {
    return {
      indent: numbered[1]!,
      kind: 'numbered',
      ordinal: Number.parseInt(numbered[2]!, 10),
      text: numbered[3]!,
    };
  }
  const bulleted = BULLETED_LINE_RE.exec(line);
  if (bulleted !== null) {
    return {
      indent: bulleted[1]!,
      kind: 'bulleted',
      ordinal: null,
      text: bulleted[2]!,
    };
  }
  return null;
};

/** True when ANY line of `text` is a list-marker line — numbered,
 *  bulleted, or a bare marker. The inline comma-list parser
 *  (`./referent-inline-list.ts`) consults this as a hard precondition:
 *  a referent that carries line-list shapes belongs to THIS parser's
 *  jurisdiction, and when this parser REFUSES such a referent (mixed
 *  shapes, broken numbering, bare markers, …) the inline parser must
 *  not resurrect it — every existing line-parser defer stays a defer.
 *  Structural only (markers / digits / whitespace) — word-free by the
 *  multilingual boundary discipline. */
export const containsListMarkerLine = (text: string): boolean =>
  text
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .some((l) => BARE_MARKER_LINE_RE.test(l) || parseLine(l) !== null);

/** Parse `text` into an ordered list of item texts, or `null` when the
 *  text carries no list in a closed shape (see the file header for the
 *  rule-by-rule rationale). The returned array index `i` IS the item's
 *  ordinal position `i + 1` — the binder's only contract. */
export const parseReferentList = (
  text: string,
): readonly string[] | null => {
  // CRLF-transported referents split cleanly (`\r` would otherwise ride
  // every line end and fail the `$`-anchored line shapes).
  const rawLines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const lines: ListLine[] = [];
  let firstListLine = -1;
  let lastListLine = -1;
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i]!;
    if (BARE_MARKER_LINE_RE.test(raw)) return null; // unmodeled empty slot
    const parsed = parseLine(raw);
    if (parsed === null) continue;
    lines.push(parsed);
    if (firstListLine === -1) firstListLine = i;
    lastListLine = i;
  }
  if (lines.length === 0) return null;

  // One contiguous list: inside the span, only list lines or blanks. A
  // prose line between list lines marks visually separate blocks.
  for (let i = firstListLine + 1; i < lastListLine; i += 1) {
    const raw = rawLines[i]!;
    if (parseLine(raw) === null && !BLANK_LINE_RE.test(raw)) return null;
  }

  const first = lines[0]!;
  for (const line of lines) {
    if (line.kind !== first.kind) return null; // mixed shapes
    if (line.indent !== first.indent) return null; // nested list
  }
  if (first.kind === 'numbered') {
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i]!.ordinal !== i + 1) return null; // not exactly 1..N
    }
  }
  return lines.map((line) => line.text);
};
