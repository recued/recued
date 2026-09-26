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

/** Every issue for a recipe, as `severity code path`. */
const issuesOf = (recipe: Record<string, unknown>): string[] =>
  ((validateRecipe(recipe) as { issues?: Array<{ severity: string; code: string; path: string }> }).issues ?? [])
    .filter((i) => i.code === 'kernel_input_missing_key' || i.code.startsWith('ai_function_input'))
    .map((i) => `${i.severity} ${i.code} ${i.path}`);

describe('D-307: the 26 shipped steps no rule saw', () => {
  it('⛔ an op backed by a core-* slug is checked (six digests sent `body` to notification-send)', () => {
    expect(issuesOf(base({ id: 'n', op: 'core.notification.send', args: { title: 't', body: 'b' } })))
      .toEqual(["warn kernel_input_missing_key steps[0].args['text']"]);
    expect(issuesOf(base({ id: 'n', op: 'core.notification.send', args: { title: 't', text: 'b' } }))).toEqual([]);
  });

  it('⛔ trigger and prefetch steps are checked (four smoke recipes listed with no topic)', () => {
    const list = { id: 'l', op: 'core.data.enrichment.list', args: { scope: 'connection.api.hubspot.contact' } };
    expect(issuesOf({ ...base({ id: 's', transform: 'count', input: [] }), prefetch_steps: [list] }))
      .toEqual(["warn kernel_input_missing_key prefetch_steps[0].args['topic']"]);
    expect(issuesOf({ ...base({ id: 's', transform: 'count', input: [] }), trigger_steps: [list] }))
      .toEqual(["warn kernel_input_missing_key trigger_steps[0].args['topic']"]);
  });

  it('⛔ an AI op step is checked like an AI ingredient step (16 summaries passed `input`)', () => {
    expect(issuesOf(base({ id: 's', op: 'core.ai.summarize', args: { title: 't', input: {}, instructions: 'i' } })))
      .toEqual(["warn ai_function_input_missing_key steps[0].args['llm.data']"]);
    expect(issuesOf(base({ id: 's', op: 'core.ai.summarize', args: { 'llm.data': {}, 'llm.focus': 'i' } }))).toEqual([]);
  });
});

/** ⛔ Severity is not a free choice here. Every server run parses its recipe
 *  strictly (`execute-handler.ts`, `strict: true`), and an error-severity finding
 *  refuses the whole run. So a finding the wider coverage NEWLY reaches must warn:
 *  as an error it would stop an installed recipe that runs today, even one whose
 *  broken step is never reached. What was already an error stays one. Shipped
 *  recipes are held to zero findings by `recipe-corpus-validity.test.ts` instead. */
describe('D-307: nothing that parsed before stops parsing', () => {
  /** Error codes only. ⚠ Not `valid`: this file's `base` recipe fails on an
   *  unrelated rule, so a `valid` check here would pass over nothing. */
  const errorsOf = (recipe: Record<string, unknown>): string[] =>
    ((validateRecipe(recipe) as { issues?: Array<{ severity: string; code: string }> }).issues ?? [])
      .filter((i) => i.severity === 'error')
      .map((i) => i.code);

  it('a newly reached finding adds no error, so a strict run that starts today still starts', () => {
    const pairs: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ id: 'n', op: 'core.notification.send', args: {} },
        { id: 'n', op: 'core.notification.send', args: { title: 't', text: 'x' } }],
      [{ id: 's', op: 'core.ai.summarize', args: { input: {} } },
        { id: 's', op: 'core.ai.summarize', args: { 'llm.data': {} } }],
    ];
    for (const [broken, whole] of pairs) {
      expect(issuesOf(base(broken)).length, JSON.stringify(broken)).toBeGreaterThan(0);
      expect(errorsOf(base(broken)), JSON.stringify(broken)).toEqual(errorsOf(base(whole)));
    }
    const prefetching = (input: Record<string, unknown>) => ({
      ...base({ id: 's', transform: 'count', input: [] }),
      prefetch_steps: [{ id: 'c', ingredient: 'ai-classify', input }],
    });
    expect(issuesOf(prefetching({ 'llm.data': 'x' })))
      .toEqual(["warn ai_function_input_missing_key prefetch_steps[0].input['llm.categories']"]);
    expect(errorsOf(prefetching({ 'llm.data': 'x' })))
      .toEqual(errorsOf(prefetching({ 'llm.data': 'x', 'llm.categories': ['a', 'b'] })));
  });

  it('the AI check on an ingredient step in `steps` is still an error, as it always was', () => {
    expect(issuesOf(base({ id: 's', ingredient: 'core-ai-summarize', input: {} })))
      .toEqual(["error ai_function_input_missing_key steps[0].input['llm.data']"]);
    expect(issuesOf(base({ id: 's', ingredient: 'ai-summarize', input: {} })))
      .toEqual(["error ai_function_input_missing_key steps[0].input['llm.data']"]);
  });
});
