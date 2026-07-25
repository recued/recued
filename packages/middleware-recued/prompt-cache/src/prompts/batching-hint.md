# Batching Hint

> Bench-harvested verbatim from
> `recued-enrichment-benchmark/enrichment-farm/harness/compose-agent.ts:140-150`.
> Mirrored as a string constant in `../templates/render.ts` (the
> runtime source of truth). The renderer inserts this block after the
> entity-query section header (where bench places it) so the canonical
> batching example sits next to the section most likely to fan out.

## Parallel tool calls

Bench-validated: framework parallel dispatch when ALL `tool_use`
blocks declare `concurrency_safe: true`; any `false` collapses to
sequential dispatch in emit order (design doc § 6).

The batching hint itself is embedded in the entity-query section
description (`compose-agent.ts:140`):

```
Batch independent calls in one tool_calls array — they run in parallel.
```

## Sequential fallback

Not explicitly verbalized to the LLM — the framework handles
sequential dispatch transparently when any `concurrency_safe: false`
entry lands in the batch. The LLM emits batches optimistically; the
dispatcher reconciles.

## Catalog prompt placement

Bench renders the canonical example between the entity-query section
description and its tool rows (`compose-agent.ts:145-150`):

```
Example — resolve three REF<contacts> emails in one batched call:
{"tool_calls": [
  {"tool":"entity.query","arguments":{"operation":"search","kind":"contact","text":"alice@x.com"}},
  {"tool":"entity.query","arguments":{"operation":"search","kind":"contact","text":"bob@x.com"}},
  {"tool":"entity.query","arguments":{"operation":"search","kind":"contact","text":"carol@x.com"}}
]}
```

P4a placement matches bench: the renderer emits this block right after
the entity-query section description and before the entity-query tool
rows. Code location: `../templates/render.ts` → `BATCHING_HINT_EXAMPLE`.

The example uses synthetic emails (`alice@x.com` / `bob@x.com` /
`carol@x.com`) so the prompt carries no per-user data — generic
catalog discipline per design doc § 4.
