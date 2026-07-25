# Catalog System Prompt

> Bench-harvested verbatim from
> `the benchmark harness compose-agent:120-164`.
> Mirrored as string constants in `../templates/render.ts` (the runtime
> source of truth). This MD is provenance + diff-target for future
> bench re-harvests; the render code does NOT read this file at
> runtime.

## Catalog Framing

Bench v5d two-surface framing (`compose-agent.ts:124-127`), widened
from "two surfaces" to "six surfaces" to match D-164's 6-section
catalog (bench validates 2 sections; the other 4 are extrapolations
per design doc § 4).

```
You answer a question using the user's personal-data warehouse. You cannot
see the warehouse directly — you query it with tools. The catalog has six
surfaces; pick the one that fits.
```

## NOTATION block

Verbatim from `compose-agent.ts:154-158`. Teaches `REF<X>` once at
catalog level rather than per-tool (bench v3 finding: per-tool guidance
over-suppresses REF resolution — HANDOFF §1).

```
NOTATION
- `REF<X>` in a Returns shape marks a value that is a KEY into collection
  X (contacts, mail, calendar, files), not a human-readable string.
- Shapes use TypeScript-ish notation: { field: type }, [shape] for arrays,
  plus primitives number / string / boolean / null.
```

## PROTOCOL block

Verbatim from `compose-agent.ts:160-163`. JSON-only turn protocol —
either a `tool_calls` array or a final `answer`.

```
PROTOCOL
Each turn, reply with exactly ONE JSON object and nothing else:
  - To query:  {"tool_calls": [{"tool": "<name>", "arguments": {...}}, ...]}
  - To finish: {"answer": "<your answer to the question>"}
```

## Version pinning

`TOOL_CATALOG_VERSION` in bench (`tool-catalog.ts:463`) tracks the
catalog shape across bench runs. D-164's equivalent is the
`template_hash` on `TemplateBundle` (`../types.ts`) — populated when
the audit-grow substrate lands in P4d. For P4a renders, the framing /
NOTATION / PROTOCOL strings are checked-in source; future bench
re-harvests update the MD here + the matching constants in
`../templates/render.ts` together.
