// What the tail eviction leaves behind.
//
// ⛔⛔ THE BARE NOTICE IS WHY A MODEL MISREADS ITS OWN AMNESIA. Measured on a
// live drive: at a 22k budget the model carried an accumulating computation
// correctly across an active trim (running totals 689, then 1443, both right),
// then eviction dropped the tail from 3 rows to 1 — taking its own prior
// answers — and it reported "I don't have access to any data source or tool
// that contains information about rings 09-12. I searched for relevant tools
// but found nothing." The catalog was intact and `work.search` was present in
// all ten packets. It attributed a CONTEXT LOSS to MISSING INFRASTRUCTURE, in
// a sentence that would send an owner to check their data sources.
//
// The notice said `Older complete conversation or tool-result groups were
// omitted` — that something went, never what. That gap is the whole distance
// between "I have lost my place, let me re-establish it" and "this was never
// here".
//
// ⚠ MECHANICAL, NEVER MODEL-GENERATED. A summarising call mid-trim spends a
// round at the exact moment the turn is already short of room, and introduces a
// second thing that can be wrong. This quotes; it does not paraphrase.

/** The bare notice — kept verbatim as the floor case and the provider-compaction
 *  case. Changing this string changes a shipped model-facing prompt. */
export const CONTEXT_OMISSION_NOTICE =
  '[llm_gateway context notice] Older complete conversation or tool-result '
  + 'groups were omitted to fit the selected model context window.';

/** Total characters a briefing may add BEYOND the bare notice — ALL of it: the
 *  anchor lines AND the closing guidance.
 *
 *  ⚠ The first cut capped only the lines and left the closing sentence
 *  uncounted, so a "400-char" briefing measured 661. A cap that governs part of
 *  the thing it names is not a cap; it is a number that happens to appear in
 *  the code near the value it fails to bound.
 *
 *  ⛔ IT IS CAPPED BECAUSE AN AFFORDANCE THAT RAISES THE FLOOR DEFEATS THE TRIM
 *  IT SERVES. A 27-character `recover_with` on every omission marker once
 *  pushed the ladder's irreducible floor past budget, so the preview search ran
 *  to zero, abandoned, and passed a 20 KB payload through whole. This is the
 *  same hazard one rung up: the briefing replaces rows far larger than itself,
 *  but only while it stays bounded. */
export const BRIEFING_MAX_CHARS = 400;

/** ⛔⛔ AND IT MAY NEVER COST MORE THAN A FRACTION OF WHAT IT REPLACES. A flat
 *  cap still raises the FLOOR — the size of a fully-evicted packet — because at
 *  the floor the tail is empty and the briefing is all that is left. Caught by
 *  `chat-tail-eviction-sweep` the first time this shipped: a budget that
 *  previously evicted-and-fitted began ABANDONING instead, which passes the
 *  whole untrimmed conversation through and is strictly worse than a bare
 *  notice. Charging a quarter of the evicted bytes makes the briefing
 *  self-limiting: small when little went, and never able to outgrow the room it
 *  freed. */
export const BRIEFING_MAX_SHARE_OF_EVICTED = 0.25;

const OMITTED_LEAD = 'Omitted, newest first — ';

/** ⛔ THE SENTENCE THAT ADDRESSES THE MEASURED FAILURE, and the reason the
 *  briefing is worth any bytes at all. The model did not merely lose context;
 *  it concluded the DATA did not exist. Naming what went is only half the fix —
 *  the other half is saying what the absence means. */
const GUIDANCE = '. This is your own earlier conversation, not missing data.';

/** One evicted exchange, reduced to the part that re-anchors the model. */
const anchorLine = (m: { role: string; content: string }): string | undefined => {
  const text = m.content.trim().replace(/\s+/gu, ' ');
  if (text.length === 0) return undefined;
  // ⚠ The USER's question is the anchor, not the assistant's answer. The answer
  //   is longer, more variable, and — the point — RECONSTRUCTIBLE from the
  //   question plus the tools, whereas the question is the only record of what
  //   was being asked at all.
  const label = m.role === 'user' ? 'you were asked' : 'you answered';
  const cut = text.length > 96 ? `${text.slice(0, 96)}…` : text;
  return `${label}: ${cut}`;
};

/** The notice, plus what went — bounded, quoting, and degrading to the bare
 *  notice when there is no room. */
export const buildEvictionBriefing = (
  evicted: ReadonlyArray<{ role: string; content: string }>,
  options: { readonly maxChars?: number; readonly providerCompacts?: boolean } = {},
): string => {
  // ⛔ PROVIDER FIRST. When the endpoint manages context itself, our summary is
  //   a second, worse copy of a job already being done — and it costs input
  //   room the provider is about to reclaim. Defer, and say only that something
  //   went, which stays true either way.
  if (options.providerCompacts === true) return CONTEXT_OMISSION_NOTICE;
  if (evicted.length === 0) return CONTEXT_OMISSION_NOTICE;

  const evictedChars = evicted.reduce((n, m) => n + m.content.length, 0);
  const budget = Math.min(
    options.maxChars ?? BRIEFING_MAX_CHARS,
    Math.floor(evictedChars * BRIEFING_MAX_SHARE_OF_EVICTED),
  );
  const lines: string[] = [];
  // The fixed parts are charged FIRST, so the cap bounds the whole briefing
  // rather than only the part that happens to be variable.
  let used = OMITTED_LEAD.length + GUIDANCE.length;
  if (used >= budget) return CONTEXT_OMISSION_NOTICE;
  // Newest first: if only some fit, the ones nearest the current turn are the
  // ones still load-bearing.
  for (const m of [...evicted].reverse()) {
    const line = anchorLine(m);
    if (line === undefined) continue;
    if (used + line.length + 2 > budget) break;
    lines.push(line);
    used += line.length + 2;
  }
  if (lines.length === 0) return CONTEXT_OMISSION_NOTICE;

  const shown = lines.length;
  const hidden = evicted.length - shown;
  return `${CONTEXT_OMISSION_NOTICE} ${OMITTED_LEAD}${lines.reverse().join(' | ')}`
    + (hidden > 0 ? ` | +${String(hidden)} earlier` : '')
    + GUIDANCE;
};
