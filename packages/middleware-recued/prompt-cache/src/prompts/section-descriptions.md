# Section Descriptions

> Bench-harvested verbatim from
> `the benchmark harness compose-agent:128-140`
> for the two bench-validated sections (enrichment + entity-query).
> Mirrored as string constants in `../catalog/sections/*.ts` (the
> runtime source of truth — see each `<SECTION>_SECTION_DESCRIPTION`).
> The four extrapolation sections (memory-recall, entity-action,
> recipes, other) are TODO(P4-bench): tune once each section has a
> bench arm.

## Enrichment + entity-query labels (bench-validated)

Bench v5d split: catalog presented as two surfaces, each framed by
purpose. Per-section labels lifted target-topic intent 0% → 67-100%
on smoke (HANDOFF §1).

### ENRICHMENT TOOLS — fast track (`compose-agent.ts:128-131`)

```
Pre-computed facts (rates, patterns, scores). If one enrichment answers
the question, call it and answer.
```

Code location: `../catalog/sections/enrichment.ts` →
`ENRICHMENT_SECTION_DESCRIPTION`.

### ENTITY QUERY — safe path / resolver (`compose-agent.ts:134-140`)

```
Raw warehouse rows. Use to:
  (a) resolve REF<X> identifiers in an enrichment result when the question
      needs the resolved value (e.g. a human name behind a REF<contacts>
      email when the user asked WHO);
  (b) compose from raw rows when no enrichment fits.
Batch independent calls in one tool_calls array — they run in parallel.
```

Code location: `../catalog/sections/entity-query.ts` →
`ENTITY_QUERY_SECTION_DESCRIPTION`.

## Four-section extrapolation (D-164 greenfield)

No bench precedent. P4a ships reasoned placeholders per design doc § 4.
Each entry below points at the code constant. TODO(P4-bench): validate
or tune copy once each section has a bench arm.

| Section          | Code location                                | Bench? |
|------------------|----------------------------------------------|--------|
| memory-recall    | `../catalog/sections/memory-recall.ts`       | no     |
| entity-action    | `../catalog/sections/entity-action.ts`       | no     |
| recipes          | `../catalog/sections/recipes.ts`             | no     |
| other            | `../catalog/sections/other.ts`               | no     |

## Catalog assembly fit

The `SectionAssembly.description` field carries the active description
per render; the renderer does NOT consult this MD at runtime. P3's
`assembleCatalog` threads the constants from each section file into
the assembly. Updates flow: bench re-harvest → edit constants in
`../catalog/sections/*.ts` → update this MD's reference + verbatim
block.
