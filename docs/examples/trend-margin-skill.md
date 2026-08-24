<!--
The same job as a SKILL.md, for comparison with the recipe in the README.

Provenance: written blind. The author was given the task statement, the endpoint
list and the CSV schema, and no sight of the recipe, the fixture internals or the
answer key. It is published unedited apart from this header — including its own
reasoning about where the tokens go, which is the interesting part.

It targets the benchmark fixture's endpoints (`services_invoke` against a mounted
`trend-margin` service). Pointing it at real APIs changes the fetch calls and
nothing else; the shape of the work is the point.
-->

---
name: research-trend-margin-scan-assisted
description: Build the trending-term slate and buying brief from Jane Recued's local trend-margin MCP service - parse the 7-day trends CSV, map terms to catalogue keywords, rank products by contribution, and emit the required JSON envelope. Use for any request mentioning /trends/us-7d, /trends/us-now, /catalog, /ad-costs, term slate, or trend-margin.
---

# Trend-margin slate + buying brief

`$SK` below = the directory this file was loaded from; `slate.py` and `rank.py` live there. Write working files in the current directory, not in `$SK`.

## Hard rules

- **`services_invoke` is the only data source.** No web search, no HTTP, no ports, no config or service files, no `lsof`/`ss`/`netstat`. Scripts only process data you already received.
- **Never pay for the same bytes twice.** A tool result is already in your context — never re-read it with `Read`, never quote it back, never copy a payload verbatim into a message. You only ever transcribe the *few fields* named below.
- **Batch.** Independent `services_invoke` calls go in ONE message; every extra turn re-sends the whole context (the 7d CSV is ~563 KB). The whole task is 5 turns.
- **Path segments only.** `services_invoke(service_route="trend-margin", method="GET", path="/catalog/foam-roller")`. Query strings are stripped; a slug outside `/catalog/index` errors and wastes a call.
- Keep every intermediate message to one line. The final message is one JSON object, no prose, no markdown fence.

## Turn 1 — three calls in one message

`/trends/us-now` · `/catalog/index` · `/trends/us-7d`

`/trends/us-7d` is huge and arrives as one escaped JSON string in `.csv` (rows separated by `\n`, fields RFC4180-quoted, `\"` inside). Read it where it sits. Do not save it, echo it, or summarise it.

**If the result carries `[... N more characters truncated]`**: the data is incomplete. Do **not** re-call it — the truncation is deterministic and a retry re-pays the full cost for the same fragment. Proceed with the days you can fully see and put an explicit caveat in `consolidated_report.caveats` naming the truncation and the affected days. Never present a fragment as complete.

Columns: `Trends` · `Search volume` (bucket string: `200+`, `2K+`, `200K+`, `10M+`) · `Started` (`August 23, 2026 at 11:30:00 AM UTC-7`; calendar day = the part before ` at `; a U+202F narrow space may sit before AM/PM) · `Ended` · `Trend breakdown` (many commas; ~43% of the payload; ignore) · `Explore link` (ignore).

## Turn 2 — extract, then build the slate

You need the top 5 terms per calendar day. Only the highest-volume rows can qualify, so transcribe only those.

For **each calendar day** in `Started` (rows are usually contiguous by day — expect 7 or 8 days):
1. Look at that day's rows and find the largest `Search volume` bucket labels present.
2. Take rows from the top bucket downward until you have **≥5 terms for that day**, then finish the bucket you stopped in — **every row of that day at that label**, no partial bucket. (Ties inside the last bucket are decided by term ascending, so a missed row can change the answer.)
3. Emit one line per collected row: `DATE|TERM|BUCKET` — e.g. `August 17, 2026|hurricanes weather|200K+`.

Typically ~5-15 lines per day. Then **one** Bash call — heredoc plus the script, no separate Write:

```bash
cat > rows.txt <<'ROWS'
August 17, 2026|hurricanes weather|2M+
...
ROWS
cat > now.txt <<'NOW'
hurricanes weather|2000+
...
NOW
python3 "$SK/slate.py" rows.txt --now now.txt
```

(`now.txt` = the 10 `/trends/us-now` terms, `term|approx_traffic_bucket`, one per line.)

`slate.py` parses buckets, groups by calendar day, takes the top 5 by volume descending / term ascending, dedupes a term that tops several days, appends the `us-now` terms not already present, and returns `{"ok",...,"term_count","slate":[{"t","v","d"}],"days","warnings"}`. `slate` is the authoritative term list in order; `v` = volume, `d` = the day it ranked (or `"now"`).

A non-zero exit still prints the JSON. Act on warnings — the CSV is still in context, so fixing costs almost nothing while a wrong slate poisons everything downstream:
- `INSUFFICIENT <day>` — add the next bucket down for that day and re-run.
- `VERIFY <day>` — rank 5 sits at your lowest supplied bucket; confirm you copied every row of that bucket for that day.
- `PARTIAL` / `TRUNCATED_INPUT` — declare it in `caveats`.

Only if a tool result *itself* says it was written to a file: pass that path to `slate.py` directly (it also accepts the whole JSON body or bare CSV). Never transcribe the CSV to disk yourself to enable that.

## Turn 3 — select keywords, then fetch everything in one message

Judgement, from the 144 `/catalog/index` slugs only. For each slate term ask: *what would someone who just searched this actually buy this week?*

- 0-3 slugs per term. Most terms deserve 0 or 1.
- **Select** on a specific, defensible buying link: a hurricane/storm term → emergency kit, flashlight, generator; a marathon or a team's playoff run → the matching gear category; a heatwave → cooling; a show or film → its practical tie-in category if one exists.
- **Reject** (`selected_keywords: []`, `rejected: true`) celebrity news, deaths, politics, crime, scores and results with no purchase intent, and anything whose only link is "a product exists in that general universe". A term that names a person, team or event is not itself a product. Rejecting well is part of the answer, not a failure.
- Prefer a slug you already picked for another term — **each distinct slug costs 2 tool calls**. Keep the distinct set to roughly 20 unless the slate genuinely needs more.
- Copy slugs verbatim from `/catalog/index`; never invent or guess one.
- Write a one-sentence `rationale` for every term, rejections included.

Then ONE message containing `/catalog/<slug>` **and** `/ad-costs/<slug>` for every distinct selected slug. Fetch nothing you did not select.

## Turn 4 — rank (one Bash call, two heredocs)

Transcribe only in-stock catalogue rows, six fields each; skip `in_stock: false` rows entirely. Do not do any arithmetic yourself.

```bash
cat > products.csv <<'P'
foam-roller,foam-roller-001,127.55,57.24,0.0885,217
P
cat > adcosts.csv <<'A'
foam-roller,0.48,1.59,0.03752
A
python3 "$SK/rank.py" products.csv adcosts.csv --top 15
```

`products.csv`: `slug,product_id,price_usd,landed_cost_usd,platform_fee_pct,monthly_units`.
`adcosts.csv`: `slug,cpc_low_usd,cpc_high_usd,conversion_rate_est`.
Add `--names names.txt` (`slug|product keyword` lines) only if some `product_keyword` is not its slug with hyphens turned into spaces.

`rank.py` computes `margin = price - landed - price*fee`, `acquisition = mean(cpc_low, cpc_high) / conversion_rate_est`, `contribution = margin - acquisition`, min-max normalises contribution and monthly_units across the whole surviving pool, scores `0.75*normC + 0.25*normU`, breaks ties on `product_id` ascending, and prints a copy-paste-ready `ranked_products` array plus `allowed_product_ids` and `diag` (`[product_id, score, margin/price, acq/margin]`).

A non-zero exit means fix and re-run: `MISSING_ADCOSTS` (fetch them), `BAD_PRODUCT_LINE`/`BAD_NUMBER` (typo), `CHECK ... look short` (you dropped rows while copying).

## Turn 5 — the brief, then the JSON

This is the part arithmetic cannot do; spend your context here, not on copying.

- `headline` — one line stating the actual finding, not a description of the task.
- `matrix_rows` — one per ranked product (≤15).
  - `margin_quality`: read it off `diag` — e.g. `"strong: margin is 65% of price and ads take 53% of it"`, `"thin: acquisition eats 90% of margin"`, `"negative: acquisition exceeds margin"`.
  - `demand_durability`: judge the **term** the keyword came from — `spike` (a game, a fight, an award show, an outage, a news moment: value decays in days), `seasonal` (weather, holiday, back-to-school: recurs but the window is short), `durable` (an evergreen need the trend merely surfaced). Use `v` and `d` from the slate: a term that ranked on several days is steadier than a one-day 10M+ burst.
  - `acquisition_cost` and `contribution_usd`: the numbers from `ranked_products`.
- Weight durability against the score: a thin contribution on a `spike` term is worse than its rank implies — say so explicitly for at least the cases where it applies.
- `caveats` — only what the data cannot support: volume buckets are floors, not counts; no historical baseline, so durability is inference from term type; `conversion_rate_est` is a single point estimate and acquisition cost scales inversely with it; Google bids only, no other channel; no inventory depth, lead time or margin-after-returns; term→keyword mapping is judgement; plus any truncation you hit.
- `recommended_product_ids` — the subset you would actually buy (usually 4-8), not the whole 15. Every id must come from `allowed_product_ids`; never type one from memory.

Emit exactly one JSON object, nothing before or after:

```json
{"scan_context":{"geo":"US","term_count":0,"vocabulary_size":0,"live_web_used":false},
 "keyword_selection":[{"term":"...","selected_keywords":["slug"],"rejected":false,"rationale":"..."}],
 "ranked_products":[],
 "source_coverage":{"fixture_set_id":"services/trend-margin","catalog_keywords_fetched":[],"ad_cost_keywords_fetched":[],"tool_calls":0,"live_web_used":false},
 "consolidated_report":{"headline":"","matrix_rows":[],"caveats":[],"recommended_product_ids":[]}}
```

Final checks:
- `scan_context.term_count` = `slate.py`'s `term_count`; `vocabulary_size` = `/catalog/index`'s `keyword_count`; `geo` = `"US"`; both `live_web_used` false.
- One `keyword_selection` entry per slate term, in slate order; `rejected` is true **exactly** when `selected_keywords` is empty.
- `ranked_products` is `rank.py`'s array verbatim, ≤15 rows.
- Every `product_id` in `consolidated_report` appears in `ranked_products`.
- `tool_calls` = the true number of `services_invoke` calls you issued, including failures and retries (3 + 2 × distinct slugs if nothing went wrong). The harness compares it against its own count; inflating it fails the run.
