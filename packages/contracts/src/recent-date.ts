/** Epoch normalisation for RECENT timestamps — the one place that decides
 *  whether a number is unix-MILLISECONDS or unix-SECONDS.
 *
 *  ⛔ WHY THIS EXISTS. `:date` / `:relative` and a `to_table` `{format}` are
 *  string-only, so an epoch NUMBER rendered as a date came out as the raw
 *  integer — `formatValue(1751328000000, 'date')` → `"1751328000000"` — while
 *  the run stayed `success: true`. Twelve recipes shipped that way in 2026-07;
 *  no gate could see it because a green run rendering an integer is a green run.
 *  Every warehouse timestamp is unix-ms (`received_at`, `start_at`,
 *  `updated_at`, timeline `ts`), and a vendor pass-through body may be unix
 *  SECONDS (Stripe's `created` / `due_date`), so the two live side by side in
 *  one corpus.
 *
 *  🔑 "RECENT" IS THE ENTIRE CORRECTNESS ARGUMENT — it is what makes this an
 *  inference rather than a guess, and it is easy to get wrong. A single
 *  ±N-year window DOES NOT WORK: a seconds value read as ms lands in 1970, and
 *  1970 is only ~56 years ago, so a natural-looking ±60y window calls BOTH
 *  readings recent and disambiguates nothing (measured: 5 of 8 probe cases
 *  ambiguous). The window must EXCLUDE 1970. Hence two BOUNDED ranges whose
 *  INPUTS are disjoint — a value can match at most one branch:
 *
 *      [MS_MIN .. MS_MAX] = [1e12 .. 4e12]  → already milliseconds
 *      [S_MIN  .. S_MAX ] = [1e9  .. 4e9 ]  → seconds, ×1000
 *      anything else                        → null: NOT a recent timestamp
 *
 *  ⛔ DO NOT WIDEN THE WINDOW. Reaching for "±60 years, seems generous" silently
 *  re-opens the ambiguity this exists to close, and `recent-date.test.ts` pins
 *  that. The bounds are 2001-09-09 (when ms timestamps became 13 digits and
 *  seconds 10) through ~2096.
 *
 *  ⛔ REFUSING IS A FEATURE, NOT A GAP. Epoch 0 and 1970-01-02 return `null`.
 *  Those are the `new Date(null)` → epoch-0 footgun that `date_parse` guards
 *  against by name — an AI-extracted date that was null when unstated. A naive
 *  "small number ⇒ ×1000" would launder that BUG into a plausible 1972 and make
 *  it invisible. Refusing keeps it visible.
 *
 *  ⚠ WHAT THIS CANNOT DO: tell you the value is a timestamp AT ALL. A duration
 *  in ms sits in the same numeric range as a 2001–2096 seconds timestamp —
 *  `window_ms: 2592000000` (30 days, and it IS in the corpus) normalises to
 *  2052. That residual is carried by the CALLER's assertion that the field is a
 *  date (`{format: 'date'}`, or reaching for `to_recent_date`), which is where
 *  it belongs. Pinned as a known-refused case in the tests so nobody "fixes" it
 *  by widening the window.
 */

/** Lower bound: 2001-09-09T01:46:40Z — the moment ms epochs became 13 digits. */
export const RECENT_MS_MIN = 1e12;
/** Upper bound: ~2096. Beyond this a "ms" reading is not a recent timestamp. */
export const RECENT_MS_MAX = 4e12;
/** The same instants expressed in seconds. Disjoint from the ms range by 1000×. */
export const RECENT_S_MIN = 1e9;
export const RECENT_S_MAX = 4e9;

/** A finite number → unix-ms, or `null` when it is not a RECENT timestamp.
 *  Never guesses: the two accepted input ranges are disjoint, so at most one
 *  branch can match, and anything outside both is refused rather than coerced. */
export const toRecentMs = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value >= RECENT_MS_MIN && value <= RECENT_MS_MAX) return value;
  if (value >= RECENT_S_MIN && value <= RECENT_S_MAX) return value * 1000;
  return null;
};
