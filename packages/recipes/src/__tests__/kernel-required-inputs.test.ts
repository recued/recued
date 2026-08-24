import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateRecipe } from '../index.js';
import { KERNEL_REQUIRED_INPUTS } from '../validate/constants.js';

/** The two fields the ENGINE stamps from `StepMeta` (`stampedRecipeId` /
 *  `stampedRecipeHash` in `packages/ingredients/src/kernel.ts`). They are
 *  guarded at dispatch but are NOT the author's obligation, so they must never
 *  reach the authoring registry — requiring them would flag every correct
 *  recipe, which is precisely the state this suite exists to prevent. */
const ENGINE_STAMPED = ['authored_by_recipe_id', 'recipe_hash'];

const base = (step: Record<string, unknown>) => ({
  recipe_id: 'probe',
  version: 1,
  metadata: { name: 'p', description: 'd', author: 'a', supported_platforms: [] },
  variables: {},
  prefetch_steps: [],
  steps: [step],
  output: { sidebar: [] },
});

const findings = (step: Record<string, unknown>): string[] =>
  ((validateRecipe(base(step)) as { issues?: Array<{ code: string; message: string }> }).issues ?? [])
    .filter((i) => i.code === 'kernel_input_missing_key')
    .map((i) => i.message);

describe('kernel required-input validator rule', () => {
  it('flags an op step that omits a required arg, and stays silent when complete', () => {
    // The failure this rule exists for: SEVEN shipped `enrichment-upsert` steps
    // were dead on dispatch with nothing at authoring time saying so.
    expect(findings({ id: 'u', op: 'core.data.enrichment.upsert', args: { id: 'x', value: 1 } }))
      .toEqual(['enrichment-upsert requires args.topic']);
    expect(findings({ id: 'u', op: 'core.data.enrichment.upsert', args: { id: 'x', topic: 't', value: 1 } }))
      .toEqual([]);
  });

  it('flags an ingredient step the same way — op lowering is not a special case', () => {
    expect(findings({ id: 'a', ingredient: 'annotation-create', input: { target: 'contact:x', source_record_hash: 'h' } }))
      .toEqual(['annotation-create requires input.key']);
    expect(findings({ id: 'a', ingredient: 'annotation-create', input: { target: 'contact:x', key: 'k', source_record_hash: 'h' } }))
      .toEqual([]);
  });

  it('never demands an ENGINE-STAMPED field from the author', () => {
    // `enrichment-upsert` guards `authored_by_recipe_id` at dispatch, but the
    // engine supplies it — so a recipe omitting it is CORRECT, not broken.
    expect(findings({ id: 'u', op: 'core.data.enrichment.upsert', args: { id: 'x', topic: 't' } })).toEqual([]);
    for (const slug of Object.keys(KERNEL_REQUIRED_INPUTS)) {
      for (const stamped of ENGINE_STAMPED) {
        expect(KERNEL_REQUIRED_INPUTS[slug]).not.toContain(stamped);
      }
    }
  });

  it('under-flags rather than over-flags: a templated slug is not knowable here', () => {
    expect(findings({ id: 'z', ingredient: '{{config.slug}}', input: {} })).toEqual([]);
  });

  it('RATCHET — every adapter guard is represented in the registry', () => {
    // ⛔ The registry is DERIVED from the adapter's own guards, so a new
    // `'<slug>: <field> is required'` throw must land here too or it becomes
    // another field only the runtime checks. Parsing the source is deliberate:
    // it is a COVERAGE check over the guards, never the behaviour itself.
    const kernel = readFileSync(
      resolve(__dirname, '../../../ingredients/src/kernel.ts'),
      'utf8',
    );
    const pat = /[`']([a-z][a-z0-9-]+):\s*([a-z_]+(?:\s*\+\s*[a-z_]+)*)\s+(?:is|are)\s+required[`']/g;
    const missing: string[] = [];
    let m: RegExpExecArray | null;
    let seen = 0;
    while ((m = pat.exec(kernel)) !== null) {
      const slug = m[1]!;
      for (const field of m[2]!.split('+').map((f) => f.trim())) {
        if (ENGINE_STAMPED.includes(field)) continue;
        seen++;
        if (!KERNEL_REQUIRED_INPUTS[slug]?.includes(field)) missing.push(`${slug}.${field}`);
      }
    }
    // Guards the guard: a regex that matched nothing would make this vacuous.
    expect(seen).toBeGreaterThan(40);
    expect(missing).toEqual([]);
  });
});
