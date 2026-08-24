# A worked example: trend → margin

Two ways to do the same Monday-morning job, and what each one costs.

This is the long version of the example sketched in the
[root README](../README.md). It carries the recipe, the blind-authored
`SKILL.md` it is measured against, every figure with the run it came from, and
an account of a defect we found in our own prompt while writing it.

**Files here**

| file | what it is |
|:---|:---|
| [`trend-margin-recipe.json`](./trend-margin-recipe.json) | the recipe — 36 steps, 2 model calls |
| [`trend-margin-skill.md`](./trend-margin-skill.md) | the same job as a skill, written blind |
| [`slate.py`](./slate.py) · [`rank.py`](./rank.py) | the skill's two bundled scripts |

---

## The objective

Every Monday morning: pull the past week's rising search terms from Google
Trends and work out whether there is anything worth selling against them.

The catch is in the first step, and it is not a lookup. Trending searches name
people, teams, fixtures and events — `hurricanes weather`, `flau'jae johnson`,
`chapecoense vs são paulo`, `bmw championship payout`. None of those is a
product. Deciding that a storm means emergency kits and battery lanterns, that a
golf tournament means gloves and rangefinders, and that a WNBA player means
merch that will convert far worse than either — that is judgement, and it is the
one part of this job a model has to do. Plenty of terms warrant nothing at all,
and saying so is the correct output: on the fifty-term slate this example runs,
the model returns an empty set for eleven of them — `bankruptcy`, `moderna
stock`, `jake lang`, the politics — and product keywords for the other
thirty-nine.

Only then does the arithmetic start: for each product keyword the model chose,
ask the catalogue what it sells, look up what those clicks cost to bid on, and
work out what is actually left per product.

```text
per-sale margin  = price − landed cost − fees
acquisition cost = cost per click ÷ conversion rate
contribution     = per-sale margin − acquisition cost
```

Rank on that, weighting sales volume below margin, then reason over the
shortlist and write a buying brief — which is a judgement the arithmetic cannot
make: a thin contribution on a fading trend is worse than its number suggests.

## The recipe method

Every figure below comes from a run of
[`trend-margin-recipe.json`](./trend-margin-recipe.json) exactly as published.
Thirty-six steps. Two of them call a model.

```text
  connection-mcp-read   fetch the week's export           619KB
  csv_parse             3,031 rows                        0 tokens
  slice + map           the slate the judgement needs     50 terms
  connection-mcp-read   the catalogue's own vocabulary    144 slugs
→ core.ai.prompt        which slugs, if any, per term     AI CALL 1
  to_list, pluck,
  flatten               the model's picks, flattened      0 tokens
  filter … in           keep only slugs that exist        55 keywords
  foreach × 2           /catalog/<kw> + /ad-costs/<kw>    110 fetches
  pluck, flatten,
  filter, enrich_by     join products to their ad costs   1,249 rows
  map                   margin, acquisition, contribution 0 tokens
  max_by/min_by, map    weighted score
  sort + slice          top 15
→ core.ai.summarize     the buying brief                  AI CALL 2
```

The first call is `core.ai.prompt` rather than an extraction step, because
nothing in the trending export contains the answer: `bmw championship payout`
does not have `golf-glove` written anywhere inside it. The model is asked to
*produce* the mapping — each term to zero or more product keywords — and a
fifth of them correctly come back empty. It is then held to the catalogue's own
vocabulary: its picks are filtered against the 144 published slugs before
anything is fetched. In this run that filter dropped nothing — given the
vocabulary in its prompt, the model stayed inside it — but it is not optional,
because the failure it prevents is a quiet one. A slug the catalogue does not
carry has no route; the fan-out step fetches it, that one item errors, and the
step still reports `ok`. The result is a hole in the pool rather than a failed
run, which is the kind of thing you find out about a week later.

Because that filter runs over the vocabulary rather than over the picks, it
deduplicates in the same pass — the thirty-nine terms named a keyword 341 times
between them, and the twenty-five fixtures that all want `replica-jersey` still
fetch it once.

The two model calls see **3,007 input tokens between them** — fifty trending
terms and the catalogue's vocabulary, then fifteen ranked rows. Neither ever
sees the 619KB export or the 1,249 product rows, because the deterministic steps
consumed those. The cost of the run tracks how much *judgment* the job needs,
not how much *data* it touches.

That is the whole of it. Not that a recipe avoids AI — it calls it twice, for
the two things only a model can do — but that everything between those two
points is arithmetic, and arithmetic does not need a context window.

**What costs tokens here, and what is free.** The fan-out is the model's answer,
so it is a different size every run — 55, 55 and 58 keywords across clean runs,
pulling 1,249 to 1,317 product rows in behind them. Cost does track that: a
bigger fan-out is literally a longer answer, and across eleven runs from 32 to
58 keywords the two move together. What it does *not* track is the data. The
110 fetches those keywords trigger and the 1,249 rows they return cost nothing,
because they never enter a context window; the input side held near 3,000 tokens
across both calls in every run, smallest fan-out to largest, since the first
always sees the fifty-term slate and the 144-slug vocabulary and the second
always sees exactly fifteen ranked rows. The 619KB export is never in either.
On the run listed above output ran three and a half times input, which is the
usual shape on a reasoning model: the bill is what it writes, not what you send
it. Point this at a 6MB export and a 10,000-product catalogue and that input
figure does not move.

**And one sentence in that prompt was worth half the answer.** An earlier draft
told the model that *most* trending terms warrant nothing. We had taken that
from a statistic measured on a different population, and it is false of this
slate. It obeyed. Same recipe, same data, same model, only the prompt changed:

| the prompt said | keywords chosen | product rows reached | tokens |
|:---|:---|:---|:---|
| "most terms warrant nothing" | 22, 33, 38 | 501, 750, 864 | 10.1k, 8.8k |
| the premise removed | 55, 55, 58 | 1,249, 1,252, 1,317 | 13.4k, 12.9k, 17.0k |

<sub>Two token figures in the first row, three runs: the 22-keyword run's
measurement was discarded after its ledger turned out to include a second,
orphaned execution. Its fan-out and pool are its own and stand.</sub>

Two-fifths of the candidate pool never fetched, and a top-fifteen ranked over
rows that were missing. Every one of those runs reported success, because nothing
downstream can tell an incomplete answer from a correct one — the omission has
to be caught at the step that causes it. And the corrected prompt costs *more*,
which is the honest way round: the cheap runs were cheap because they were doing
less of the job.

Two details from fixing it, for anyone writing one of these. The failure was
never in the average — the same biased prompt chose 22, then 33, then 38
keywords from identical input, and its best run was fine. What it really
produced was a coin flip, and only a spread shows that; a mean would have
reported a mild, consistent underperformance that never actually happened.

And the repair that worked names the **output**: "a person trending in the news
implies media and merchandise about that person" fixed a miss that simply moving
"a person" onto the sellable list did not. A step asked to
generate a mapping needs to be told what to produce, not how to classify what it
was handed.

That is the part worth keeping. Not that a model needs a good prompt, which
everyone knows, but that in a recipe the model's discretion sits in one step,
with a prompt in version control and a diff you can measure. The arithmetic
downstream did not change and did not need to. In a skill the same judgement is
spread across the whole run, and a bad answer is a transcript to re-read.

**What is real here and what is not.** The trending terms are a real Google
Trends export, captured and committed rather than fetched live. The product
catalogue and the ad-cost lookups are **mocked** — a synthetic 144-keyword
catalogue with invented prices, landed costs, bid ranges and conversion rates,
served over MCP. No real supplier, product, price or advertiser bid is
represented, and there is no dropshipping API behind this. What the run measures
is the SHAPE of the work — where the bytes go and where the model is called —
not a claim about any real catalogue's economics. Point the same recipe at a
real API and the fetch steps change; nothing else does.

The recipe reads through an MCP connection named `trend-margin-http`, and the
fixture behind that name lives in our benchmark harness rather than in this
repository — so the file is published to be **read**, not to be run as-is. The
shape is what transfers: point the four `connection-mcp-read` steps at your own
endpoints and the other thirty-two are unchanged.

## The same job as a skill

A skill can do this too, and the honest version is not a strawman.
[`trend-margin-skill.md`](./trend-margin-skill.md), with its two bundled scripts
[`slate.py`](./slate.py) and [`rank.py`](./rank.py), was written blind — by an
author given the task, the endpoints and the file schema, but no sight of the
recipe — and it is genuinely good. It pushes the
loop into a bundled script, transcribes only the rows that can reach a top-five,
and keeps the catalogue out of the reasoning. If you want to know which shape
suits your job, run both against the same data and read your own token bill.

### The strongest version of the skill, and what it costs the argument

A tool result reaches an agent through its context window — that is what a tool
result *is* — so whatever you pull through one, you pay to receive at least
once. For this job that is the whole ballgame: the export is 563,182 characters,
roughly 140k tokens to receive a single time.

So the strongest skill does not pull it through at all. It shells out —
`curl -o week.csv …` — and hands the path to `slate.py`, and the bytes never
enter a context window. **That is the right way to write this skill, and we
should say so plainly rather than let the comparison flatter us.** It is not
merely cheaper. It also removes a failure we hit for real: agent runtimes cap a
single tool result, and at the default cap this CSV came back truncated
mid-payload, from which a lane built a slate out of head-and-tail fragments and
reported success. Fetching to disk makes that class of bug impossible.

The skill published here does not do it because the benchmark it was written for
forbids it — `services_invoke` is the channel being measured, so bypassing it
does not make the lane cheaper, it makes the comparison meaningless. The author
saw the opening and closed it deliberately ("Never transcribe the CSV to disk
yourself"). That constraint belongs to the fixture, not to skills. If you adapt
this one to a real trends URL, moving the fetch to disk is the first change to
make, and it will take most of the token gap with it.

What it does not take is the second thing. Look at what that skill has become: a
program with a natural-language wrapper. The loop is in a script, the parsing is
in a script, the fetch is a shell command — and it now needs its own
credentials, retries, rate limits, a place to keep the file, and a way to run on
Tuesday when nobody opens a session. A recipe is that program, on a server that
already has those. That is the argument, and it survives the token count going
either way.
