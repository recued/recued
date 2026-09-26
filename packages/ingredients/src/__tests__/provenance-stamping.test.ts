import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** D-120 provenance stamping — `authored_by_recipe_id` and `recipe_hash` come
 *  from `StepMeta`, not from recipe JSON.
 *
 *  These are SOURCE-SHAPE assertions rather than dispatch drives: the five
 *  write adapters sit behind a large dispatcher whose deps are a wide surface,
 *  and what must not regress here is the SEAM — that no write forwards the
 *  caller's value raw. A future dispatch-level suite can layer on top; this
 *  catches the specific regression that a new write op (or a merge) reintroduces
 *  `input.authored_by_recipe_id` directly. */
const KERNEL = readFileSync(resolve(__dirname, '../kernel.ts'), 'utf8');

describe('kernel write adapters stamp provenance rather than trusting the caller', () => {
  it('no annotation dispatch carries the RETIRED recipe_hash', () => {
    // D-120 — `recipe_hash` was dropped from annotations entirely: no author
    // could produce a correct one (`hashRecipe` covers the step's own args), so
    // every stored value was a fabrication, and the run's audit row already
    // carries the real hash. ENRICHMENT keeps its own `recipe_hash` — a
    // different substrate, nullable, written server-side — so this asserts the
    // ANNOTATION dispatch shapes specifically, not the string's absence.
    const annotate = KERNEL.slice(KERNEL.indexOf("case 'annotation-create':"));
    const body = annotate
      .slice(0, annotate.indexOf('return dispatchers.annotationCreate'))
      // ⚠ Strip comments first. The block still MENTIONS the retired field to
      // explain why it is gone, and matching that prose would make this test
      // fail on its own documentation — passing only while nobody wrote any.
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(body).not.toContain('recipe_hash');
  });

  it('NO write forwards the caller-supplied identity raw', () => {
    // ⛔ The regression this pins: `authored_by_recipe_id: input.authored_by_recipe_id`
    // is a caller asserting its own identity — the pattern D-177 exists to
    // prevent, and the reason `origin_actor` / `origin_contract_id` /
    // `execution_source` are already engine-set at this same seam.
    expect(KERNEL).not.toContain('authored_by_recipe_id: input.authored_by_recipe_id');
  });

  it('the stamp prefers the engine value and falls back to the caller', () => {
    // Direct-rpc callers (Settings, MCP agent, tests) reach these collections
    // without an engine above them, so `StepMeta.recipe_id` is absent and their
    // own value must still be honoured — dropping the fallback would break them.
    const src = KERNEL.slice(KERNEL.indexOf('const stampedRecipeId'));
    expect(src).toContain('call.stepMeta?.recipe_id ?? authored');
  });

  it('every write that dispatches an author id uses the stamp helper', () => {
    // Counts the JOIN, not the definition: three writes take an author id
    // (annotation-create, link-create, enrichment-upsert), and each must route
    // through the helper — directly or via a narrowed local. (Five until
    // 2026-09-23, when `data-annotate` / `data-link` were retired.) A fourth
    // write landing without it fails here.
    const stamped = KERNEL.match(/stampedRecipeId\(call,/g) ?? [];
    expect(stamped.length).toBeGreaterThanOrEqual(3);
  });
});
