/** Capability search drops terms that match most of the set.
 *
 *  ⛔⛔ THE DEFECT THIS CLOSES. `scoreSearchable` matches by SUBSTRING, ORs the
 *  terms, and includes anything scoring > 0 — with no cap on the tool catalog
 *  (owner decision 2026-08-20: a cap turns the equal-score name tie-break into
 *  an EXCLUSION channel, so a publisher naming a recipe `aaa-…` displaces a
 *  rival). Two different tokens each dragged in ~85% of a 2,285-recipe corpus:
 *    · `or`   — 84%, because 2-char terms pass and matching is substring
 *               (rep-OR-t, rec-OR-d, st-OR-age, vend-OR)
 *    · `pack` — 86%, because `pack:<slug>` is a TAG NAMESPACE on 1,954 recipes
 *  Census of 1,281 real `tools.search` results: p50 3,666 chars, p90 69,961,
 *  max 554,231, 16.3% over 50k.
 *
 *  🔑 ONE PRIMITIVE, NOT TWO WORD LISTS. Frequency is what `chat-index-context`
 *  already uses (`CHAT_INDEX_TOO_COMMON_CAP`) for the same reason — `enron`
 *  is 45% of one owner's mail and 0.6% of another's, and only a per-corpus
 *  measure gets both right. A stopword list could never have caught `pack`, and
 *  a tag-namespace special case could never have caught `or`.
 */
import { describe, expect, it } from 'vitest';
import { rankSearchable } from '@recued/contracts';

type Entry = { name: string; description?: string; tags?: string[] };
const project = (e: Entry) => e;

/** 100 entries: every one namespaced `pack:*` (the real convention), one about
 *  buildings, one a report — mirroring why `pack` and `or` both over-matched. */
const corpus: Entry[] = Array.from({ length: 100 }, (_, i) => ({
  name: i === 0 ? 'list-buildings' : `filler-${i}`,
  // ⚠ FIXTURE NOTE — the filler MUST carry an "or" substring. A first version
  // used 'does a thing', so `or` matched 1 entry in 100 and was CORRECTLY kept
  // as discriminating; the test failed on its own data, not on the code. In the
  // real corpus `or` is 84% precisely because `record` / `report` / `storage` /
  // `vendor` are everywhere.
  description: i === 0 ? 'list buildings' : 'stores a record',
  tags: [`pack:demo-${i}`],
}));

describe('non-discriminating term filtering', () => {
  it('⛔ drops a TAG-NAMESPACE token that a stopword list could never catch', () => {
    // `pack` matches all 100 via `pack:*`; `buildings` matches one.
    const got = rankSearchable(corpus, project, 'pack buildings', 200);
    expect(got.map((e) => e.name)).toEqual(['list-buildings']);
  });

  it('⛔ drops the CONNECTIVE that a namespace fix could never catch', () => {
    // `or` substring-matches report/records; `buildings` matches one.
    const got = rankSearchable(corpus, project, 'buildings or properties', 200);
    expect(got.map((e) => e.name)).toEqual(['list-buildings']);
  });

  it('keeps a term that is rare even though another in the query is common', () => {
    const got = rankSearchable(corpus, project, 'pack or buildings', 200);
    expect(got.map((e) => e.name)).toEqual(['list-buildings']);
  });

  it('⛔ FALLBACK — an all-common query returns its results, never nothing', () => {
    // Every term matches everything. Dropping them all would empty the set; a
    // precision fix may not turn a result set that existed into no answer.
    const got = rankSearchable(corpus, project, 'pack', 200);
    expect(got.length).toBe(100);
  });

  it('leaves a small corpus alone — the share is relative, not absolute', () => {
    const tiny: Entry[] = [
      { name: 'invoice-list', description: 'list invoices', tags: [] },
      { name: 'invoice-send', description: 'send an invoice', tags: [] },
    ];
    // `invoice` is 100% here but there is nothing else to discriminate against;
    // the fallback keeps it rather than returning an empty set.
    expect(rankSearchable(tiny, project, 'invoice', 10).length).toBe(2);
  });

  it('does not disturb an already-precise query', () => {
    const got = rankSearchable(corpus, project, 'buildings', 200);
    expect(got.map((e) => e.name)).toEqual(['list-buildings']);
  });
});
