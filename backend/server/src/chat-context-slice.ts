// In-turn recovery of a value the trim ladder dropped.
//
// ⛔⛔ THIS IS NOT RECALL, AND THE DIFFERENCE IS THE WHOLE DESIGN. Measured over
// 2,326 stored packets carrying `prior_tool_calls`:
//
//   82% are under 8 KB           — nothing is ever trimmed; the model has it all
//   p50 2.7 KB / p90 60 KB       — the byte distribution is violently skewed
//   p99 366 KB, max 670 KB       — when it bites, it is not one small result
//   9.1% / 2.2%                  — share exceeding a 32k / 128k window alone
//
// So the in-turn case is RARE BUT SEVERE, and two consequences follow that a
// store-backed handle gets wrong:
//
//  1. HANDING THE VALUE BACK RE-CREATES THE OVERFLOW THAT CAUSED THE TRIM. At
//     p99 the ladder is shedding hundreds of KB; returning a row would put it
//     straight back. Retrieval must be SELECTIVE and byte-bounded, always.
//  2. THE DURABLE ROW IS THE WRONG STORAGE. It is deliberately PRE-ALIAS so a
//     future session can re-alias it, and its alias candidates are only
//     harvested at the AI call — AFTER the composition whose marker needs the
//     handle. That ordering cannot be satisfied (pinned in
//     `chat-trim-marker-handle.test.ts`). A turn-scoped value has no such
//     problem: it never leaves the turn, and the slice returned re-enters the
//     packet as an ordinary tool result, aliased by the same egress pass as
//     every other one.

/** How much a single slice may return. Deliberately small: the value was
 *  dropped BECAUSE the packet did not fit, so a generous slice would undo the
 *  trim it is compensating for. */
export const CONTEXT_SLICE_MAX_BYTES = 2_048;

export interface ContextSliceRequest {
  readonly ref?: unknown;
  readonly query?: unknown;
  readonly max_bytes?: unknown;
}

export type ContextSliceResult =
  | {
      readonly ok: true;
      readonly ref: string;
      readonly matched: number;
      readonly returned: number;
      readonly truncated: boolean;
      readonly slice: unknown;
    }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

const asText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/** The SMALLEST units inside `value` whose text contains `needle`, in order.
 *
 *  ⛔⛔ IT DESCENDS, AND THE FIRST CUT DID NOT. Matching only at the top level
 *  of an object returns the whole matching ENTRY — for the shape tool results
 *  actually take, `{rows: [...400 items]}`, that is the entire array as one
 *  atom. Measured: `matched: 1, returned: 0, truncated: true` — the search
 *  found the row, and the budget then refused the only thing it had, so a
 *  successful query returned nothing. Descending makes the unit the ROW.
 *
 *  ⚠ A container is never returned when a child matches; only when nothing
 *  inside it does and the container's own text matches (a scalar, or an object
 *  whose KEY is the hit). Otherwise one match would drag its siblings in, which
 *  is the same failure one level down. */
const selectMatches = (value: unknown, needle: string): unknown[] => {
  const want = needle.toLowerCase();
  const hit = (v: unknown): boolean => asText(v).toLowerCase().includes(want);
  const walk = (node: unknown): unknown[] => {
    // ⛔ AN ARRAY'S ELEMENT IS THE UNIT, and descending past it strips the
    //   context that makes a hit usable. Measured: matching to the leaf
    //   returned `["the xanthoril clause"]` — the text, without the `id` of the
    //   row it came from, which is the one field the model needs to act. A row
    //   is the smallest thing that still means something.
    if (Array.isArray(node)) return node.filter((el) => hit(el));
    if (node !== null && typeof node === 'object') {
      const inner = Object.entries(node as Record<string, unknown>)
        .flatMap(([k, v]) => {
          const deep = walk(v);
          if (deep.length > 0) return deep;
          return k.toLowerCase().includes(want) ? [{ [k]: v }] : [];
        });
      // Nothing inside matched, but the node as a whole might (a small record
      // whose match spans fields).
      if (inner.length === 0 && hit(node)) return [node];
      return inner;
    }
    return hit(node) ? [node] : [];
  };
  return walk(value);
};

/** Take from `items` until the byte budget is spent. Returns whole elements —
 *  never a half-serialized one, which would hand the model malformed JSON and
 *  look like data. */
const takeWithinBudget = (
  items: readonly unknown[],
  maxBytes: number,
): { taken: unknown[]; truncated: boolean } => {
  const taken: unknown[] = [];
  // ⛔ THE SEPARATORS COUNT. Summing element sizes alone overshot the cap by
  //   the commas and brackets the array adds around them — measured 2,081
  //   against a 2,048 bound. A safety limit that is only approximately
  //   respected is not one, so the budget starts at `[]` and pays a comma per
  //   element after the first.
  let used = 2;
  for (const item of items) {
    const size = Buffer.byteLength(asText(item), 'utf8')
      + (taken.length > 0 ? 1 : 0);
    if (used + size > maxBytes) return { taken, truncated: true };
    taken.push(item);
    used += size;
  }
  return { taken, truncated: false };
};

/** Resolve one slice request against the turn's elided values. */
export const resolveContextSlice = (
  args: ContextSliceRequest,
  elided: ReadonlyMap<string, unknown>,
): ContextSliceResult => {
  const ref = typeof args.ref === 'string' ? args.ref : '';
  if (ref === '') {
    return {
      ok: false,
      reason: 'invalid_args',
      detail:
        'Pass the `ref` printed beside the omitted value, exactly as written.',
    };
  }
  if (!elided.has(ref)) {
    // ⚠ Names the live refs rather than saying "not found": the turn is the
    //   only scope these exist in, so a stale or invented ref is the likely
    //   cause and the model can correct itself in one step.
    const known = [...elided.keys()];
    return {
      ok: false,
      reason: 'not_found',
      detail: known.length === 0
        ? 'Nothing was omitted from this turn, so there is nothing to fetch.'
        : `No such ref. This turn omitted: ${known.join(', ')}.`,
    };
  }
  const value = elided.get(ref);
  const requested = typeof args.max_bytes === 'number' && args.max_bytes > 0
    ? Math.min(Math.floor(args.max_bytes), CONTEXT_SLICE_MAX_BYTES)
    : CONTEXT_SLICE_MAX_BYTES;
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  // ⛔ NO QUERY IS NOT "EVERYTHING". The whole value is what did not fit; the
  //   honest answer to an unfiltered ask is a bounded head plus the count, so
  //   the model learns the shape and can ask a narrower question.
  const items = query === ''
    ? (Array.isArray(value) ? value : [value])
    : selectMatches(value, query);
  const { taken, truncated } = takeWithinBudget(items, requested);
  return {
    ok: true,
    ref,
    matched: items.length,
    returned: taken.length,
    truncated,
    slice: taken,
  };
};
