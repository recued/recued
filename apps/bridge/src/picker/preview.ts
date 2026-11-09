/** "Watch this element" picker — selector preview (brick 2).
 *
 *  Pure helpers that turn a candidate selector into the live preview the
 *  overlay panel renders: how many elements it matches + a text sample of
 *  the first. Kept DOM-free (injected probes) so it is unit-testable; the
 *  overlay binds the probes to `document.querySelectorAll` / `readPageField`.
 *  The preview mirrors the bridge `read_dom` action, which reads what the
 *  first match shows: a form field's value, else its `innerText`
 *  (actions/page-fields.ts). */

/** The longest sample we surface in the panel — enough to recognise the
 *  element, short enough not to overflow the small overlay. */
export const SAMPLE_PREVIEW_MAX_LEN = 140;

/** Human-readable match summary. Negative `count` signals an invalid
 *  selector (the probe threw); `0` means a valid-but-unmatched selector. */
export const formatMatchSummary = (count: number): string => {
  if (count < 0) return 'invalid selector';
  if (count === 0) return 'no match';
  if (count === 1) return '1 match';
  return `${count} matches`;
};

/** Collapse whitespace + cap length for display. `null` passes through. */
export const truncateSample = (text: string | null, max = SAMPLE_PREVIEW_MAX_LEN): string | null => {
  if (text === null) return null;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(0, max - 1))}…`;
};

export interface SelectorPreview {
  /** Match count, or `-1` for an invalid selector. */
  readonly count: number;
  /** Truncated sample text of the first match, or `null`. */
  readonly sample: string | null;
  /** Human summary (`formatMatchSummary`). */
  readonly summary: string;
  /** True iff the selector matches exactly one element — a good watch
   *  target. The panel nudges the user toward this. */
  readonly ok: boolean;
}

export interface PreviewProbes {
  /** Count matches; return `-1` if the selector is syntactically invalid. */
  count: (selector: string) => number;
  /** Read what the first match shows (`read_dom`'s reading), or `null` if none. */
  readText: (selector: string) => string | null;
}

/** Preview a candidate selector. An empty/whitespace selector short-
 *  circuits to a friendly "empty" state rather than probing. */
export const previewSelector = (probes: PreviewProbes, selector: string): SelectorPreview => {
  const trimmed = selector.trim();
  if (trimmed === '') {
    return { count: 0, sample: null, summary: 'empty selector', ok: false };
  }
  const count = probes.count(trimmed);
  const sample = count > 0 ? truncateSample(probes.readText(trimmed)) : null;
  return { count, sample, summary: formatMatchSummary(count), ok: count === 1 };
};
