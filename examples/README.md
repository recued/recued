# A worked example: trend → margin

Two ways to do the same Monday-morning job, and what each one costs.

This is the long version of the example in the [root README](../README.md).
It holds the recipe. It holds the `SKILL.md` it is measured against, which was
written blind. Every figure comes with the run it came from. And it tells the
story of a defect we found in our own prompt while writing it.

**Files here**

| file | what it is |
|:---|:---|
| [`trend-margin-recipe.json`](./trend-margin-recipe.json) | the recipe — 36 steps, 2 model calls |
| [`trend-margin-skill.md`](./trend-margin-skill.md) | the same job as a skill, written blind |
| [`slate.py`](./slate.py) · [`rank.py`](./rank.py) | the skill's two bundled scripts |

---

## The objective

Every Monday morning: pull the past week's rising search terms from Google
Trends. Then work out whether there is anything worth selling against them.

The catch is in the first step, and it is not a lookup. Trending searches name
people, teams, fixtures, and events: `hurricanes weather`, `flau'jae johnson`,
`chapecoense vs são paulo`, `bmw championship payout`. None of those is a
product. A storm means emergency kits and battery lanterns. A golf tournament
means gloves and rangefinders. A WNBA player means merch, and that merch will
turn far fewer clicks into sales than either. Deciding all that is judgement. It is the one
part of this job a model has to do. Plenty of terms warrant nothing at all.
Saying so is the correct output. This example runs a fifty-term slate. The
model returns an empty set for eleven of them: `bankruptcy`, `moderna
stock`, `jake lang`, the politics. It returns product keywords for the other
thirty-nine.

Only then does the arithmetic start. For each product keyword the model
chose: ask the catalogue what it sells. Look up what those clicks cost to bid
on. Work out what is really left per product.

```text
per-sale margin  = price − landed cost − fees
acquisition cost = cost per click ÷ conversion rate
contribution     = per-sale margin − acquisition cost
```

Rank on that. Weight sales volume below margin. Then reason over the
shortlist and write a buying brief. That last part is a judgement the
arithmetic cannot make. A thin contribution on a fading trend is worse than
its number suggests.

## The recipe method

Every figure below comes from a run of
[`trend-margin-recipe.json`](./trend-margin-recipe.json), exactly as
published. Thirty-six steps. Two of them call a model.

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

The first call is `core.ai.prompt`, not an extraction step. Here is why.
Nothing in the trending export contains the answer. The term
`bmw championship payout` does not have `golf-glove` written anywhere inside
it. The model is
asked to *produce* the mapping: each term to zero or more product keywords.
And a fifth of them correctly come back empty. Then it is held to the
catalogue's own vocabulary. Its picks are filtered against the 144 published
slugs before anything is fetched. In this run that filter dropped nothing.
Given the vocabulary in its prompt, the model stayed inside it. But the
filter is not optional, because the failure it prevents is a quiet one. A
slug the catalogue does not carry has no route. The fan-out step fetches it.
That one item errors. And the step still reports `ok`. The result is a hole
in the pool, not a failed run. That is the kind of thing you find out about
a week later.

That filter runs over the vocabulary, not over the picks. So it removes
duplicates in the same pass. The thirty-nine terms named a keyword 341 times
between them. The twenty-five fixtures that all want `replica-jersey` still
fetch it once.

The two model calls see **3,007 input tokens between them**. The first sees
fifty trending terms and the catalogue's vocabulary. The second sees fifteen
ranked rows. Neither ever sees the 619KB export or the 1,249 product rows.
The plain, non-model steps consumed those. So the cost of the run tracks how much
*judgment* the job needs. It does not track how much *data* it touches.

That is the whole of it. A recipe does not avoid AI. It calls a model twice,
for the two things only a model can do. But everything between those two
points is arithmetic. And arithmetic does not need a context window (the
model's working memory).

**What costs tokens here, and what is free.** The fan-out is the model's
answer. So it is a different size every run. Clean runs chose 55, 55, and
58 keywords. Those pulled 1,249 to 1,317 product rows in behind them. Cost
does track that. A bigger fan-out is a longer answer. Across eleven runs, from 32
to 58 keywords, the two move together. What cost does *not* track is the
data. The 110 fetches those keywords trigger, and the 1,249 rows they return,
cost nothing. They never enter a context window. The input side held near
3,000 tokens across both calls in every run. That was true from the smallest
fan-out to the largest. That is because the first call always sees the fifty-term slate and the
144-slug vocabulary. The second always sees exactly fifteen ranked rows. The 619KB
export is never in either. On the run listed above, output ran three and a
half times input. That is the usual shape on a reasoning model. The bill is
what it writes, not what you send it. Point this at a 6MB export and a
10,000-product catalogue, and that input figure does not move.

**And one sentence in that prompt was worth half the answer.** An earlier
draft told the model that *most* trending terms warrant nothing. We had taken
that from a statistic measured on a different population. It is false of this
slate. The model obeyed anyway. Same recipe, same data, same model. Only the
prompt changed:

| the prompt said | keywords chosen | product rows reached | tokens |
|:---|:---|:---|:---|
| "most terms warrant nothing" | 22, 33, 38 | 501, 750, 864 | 10.1k, 8.8k |
| the premise removed | 55, 55, 58 | 1,249, 1,252, 1,317 | 13.4k, 12.9k, 17.0k |

<sub>The first row has two token figures but three runs. The 22-keyword run's
token measurement was thrown out, because its token ledger turned out to
include a second, stray run. Its fan-out and pool are its own and stand.</sub>

Two-fifths of the candidate pool were never fetched. The top fifteen was
ranked over rows that were missing. Every one of those runs reported success.
That is because nothing downstream can tell an incomplete answer from a
correct one. So the omission has to be caught at the step that causes it. And the corrected
prompt costs *more*. That is the honest way round. The cheap runs were cheap
because they were doing less of the job.

Two details from fixing it, for anyone writing one of these. First, the
failure was never in the average. The same biased prompt chose 22, then 33,
then 38 keywords from identical input. Its best run was fine. What it really
produced was a coin flip. Only a spread shows that. A mean would have reported
a mild, steady underperformance that never actually happened.

Second, the repair that worked names the **output**. The line "a person
trending in the news implies media and merchandise about that person" fixed
a miss.
Simply moving "a person" onto the sellable list did not. A step asked to
generate a mapping needs to be told what to produce, not how to put labels
on what it was handed.

That is the part worth keeping. Everyone knows a model needs a good prompt.
The point is different. In a recipe, the model's discretion sits in one step.
Its prompt is in version control. A change is a diff you can measure. The
arithmetic downstream did not change and did not need to. In a skill, the
same judgement is spread across the whole run. A bad answer is a transcript
to re-read.

**What is real here and what is not.** The trending terms are a real Google
Trends export. It was captured and committed, not fetched live. The product
catalogue and the ad-cost lookups are **mocked**. They are a made-up
144-keyword catalogue served over MCP. Its prices, landed costs, bid ranges,
and conversion rates are invented. No real supplier, product, price, or
advertiser bid is represented. There is no dropshipping API behind this.
What the run measures is the SHAPE of the work. Where do the bytes go? Where
is the model called? It is not a claim about any real catalogue's economics.
Point the same recipe at a real API and the fetch steps change. Nothing else
does.

The recipe reads through an MCP connection named `trend-margin-http`. The
fixture behind that name lives in our benchmark harness, not in this
repository. So the file is published to be **read**, not to be run as-is. The
shape is what carries over. Point the four `connection-mcp-read` steps at
your own endpoints. The other thirty-two steps are unchanged.

## The same job as a skill

A skill can do this too. The honest version is not a strawman, a weak version
set up to lose. The file
[`trend-margin-skill.md`](./trend-margin-skill.md) was written blind, along
with its two bundled scripts [`slate.py`](./slate.py) and
[`rank.py`](./rank.py). Its author got the task, the endpoints, and the file schema, but never
saw the recipe. And it is genuinely good. It pushes the loop into a bundled
script. It copies out only the rows that can reach a top five. It keeps the
catalogue out of the reasoning. Want to know which shape suits your job? Run
both against the same data and read your own token bill.

### The strongest version of the skill, and what it costs the argument

A tool result reaches an agent through its context window. That is what a
tool result *is*. So whatever you pull through one, you pay to receive at
least once. The export here is 563,182 characters.

So the strongest skill does not pull it through at all. It shells out, with
`curl -o week.csv …`, and hands the path to `slate.py`. The bytes never enter
a context window. So they cost nothing to receive. The same trick works for
the per-keyword fetches. **That is the right way to write this skill. It
belongs here, not in a footnote, because the comparison flatters us without
it.** It is not only cheaper. It also removes a failure we hit for real.
Agent runtimes cap a single tool result. At the default cap, this CSV came
back cut off mid-payload at 63,998 characters. From that, one lane built a
slate out of head-and-tail fragments and reported success. Bytes that go to
disk cannot be silently cut off on the way into a context window.

So we built that lane and ran it. Same harness, same model. Every payload was
curled to disk and parsed by a bundled script:

| lane | tokens | outcome |
|:---|---:|:---|
| the recipe | 13,385 | top 15 exact, in order |
| skill, fetching to disk | **61,045** | top 15 exact, in order |
| skill, receiving tool results | 116,834 · 133,836 | no valid answer |

<sub>The fetch-to-disk skill is the one arm here we wrote ourselves, to test
this idea. The other three were authored blind, with no sight of the recipe
or the answer key. That makes them better evidence about what a skill author
really produces. Like those three, it answered in prose rather than the
required JSON. So its ranking was scored by comparing the product ids it
named against the answer key.</sub>

**The direction was right and the size was wrong.** Fetching to disk roughly
halves a skill that copies the data through its context. That is real, and
worth doing. But it lands at four and a half times the recipe, not near it.
Taking the data out of the context window does not take the agent out of the
loop. What is left is the scaffolding, the skill text, and every turn
re-sending the conversation so far. The 563,182-character export is gone from
the bill. The agent is not.

**What it is not is less correct.** Given the same judgement, it reaches the
same fifteen rows in the same order. We should say that plainly, because our
first run of this arm did not. It returned ten of the fifteen. It would have
been convenient to leave that as the finding. It was our prompt's fault. That
draft listed five kinds of sellable term as illustrations. The model read
them as the whole set. It rejected `flock cameras` as *"tech news, nothing
sellable"*, a category we never wrote. That cost it `dash-cam`, and five of
the true top fifteen belong to `dash-cam`. We told it to read down the
vocabulary before rejecting anything, and that the examples were only
examples. That recovered all five at no extra cost.

Two things are worth taking from that. A keyword the model never thinks of is
a hole nothing downstream can see. The bad run reported no errors. It named
fifteen plausible products. Only the answer key caught it. And the same
defect had already been found and fixed in the recipe's prompt, almost word
for word. A list of examples reads as a closed list. Neither shape is
immune, because both ask a model to use judgement. What differs is where that
judgement lives. It is in one prompt you can diff and measure again. Or it is
in a transcript you re-read.

What it does not take away is the second thing. Look at what that skill has
become: a program with a natural-language wrapper. The loop is in a script.
The parsing is in a script. The fetch is a shell command. And now it needs
its own credentials, retries, and rate limits. It needs a place to keep the
file. It needs a way to run on Tuesday, when nobody opens a session. A recipe
is that program, on a server that already has those. That is the argument,
and it survives the token count going either way.
