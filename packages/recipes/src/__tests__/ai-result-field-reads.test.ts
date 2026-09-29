import { describe, expect, it } from 'vitest';
import { validateRecipe } from '../index.js';

/** A contracted AI step's stored result is the parsed contract object, so a read
 *  of any other field is empty on every run. Two shipped recipes stored a constant
 *  0.6 as each deal's "confidence" (`{{step.scoring.confidence}}` on `ai-score`), and
 *  thirty briefs rendered an empty block (`source: "step.summary.result"`). */

const recipe = (steps: unknown[], render: unknown[] = []) => ({
  recipe_id: 'probe',
  version: 1,
  metadata: { name: 'p', description: 'd', author: 'a', supported_platforms: [] },
  variables: {},
  prefetch_steps: [] as unknown[],
  steps,
  output: { render },
});

const score = { id: 'scoring', op: 'core.ai.score', args: { 'llm.data': 'deal', 'llm.criteria': ['fit'] } };
const summary = { id: 'summary', op: 'core.ai.summarize', args: { 'llm.data': 'text' } };
const card = (value: string) => ({ id: 'card', transform: 'to_summary', fields: [{ label: 'L', value }] });

type Issue = { severity: string; code: string; path: string; message: string };
const issuesOf = (r: Record<string, unknown>): Issue[] => validateRecipe(r).issues as Issue[];

/** Every `ai_result_field_unknown` finding, as `severity path`. */
const reads = (r: Record<string, unknown>): string[] => issuesOf(r)
  .filter((i) => i.code === 'ai_result_field_unknown')
  .map((i) => `${i.severity} ${i.path}`);

describe('ai_result_field_unknown — a read of a field the AI step never returns', () => {
  it('flags a template read, naming the fields the step does return', () => {
    const r = recipe([score, card('{{step.scoring.confidence}}')]);
    expect(reads(r)).toEqual(['warn steps[1].fields[0].value']);
    expect(issuesOf(r).find((i) => i.code === 'ai_result_field_unknown')?.message)
      .toBe('{{step.scoring.confidence}} reads "confidence", which ai-score never returns, so it is empty on '
        + 'every run. The step\'s result has only: score, breakdown, reasoning.');
  });

  it('flags an output section sourcing a "result" envelope the step never had', () => {
    const r = recipe([summary], [{ type: 'ai_analysis', source: 'step.summary.result' }]);
    expect(reads(r)).toEqual(['warn output.render[0].source']);
    expect(issuesOf(r).find((i) => i.code === 'ai_result_field_unknown')?.message)
      .toMatch(/not wrapped in "result" the way a catalog operation's result is/u);
  });

  it('accepts every field the step returns, the whole result, and paths into a field', () => {
    expect(reads(recipe(
      [score, summary, card('{{step.scoring.score}} {{step.scoring.breakdown.0.criterion}} {{step.summary.key_points.0}}')],
      [{ type: 'ai_analysis', source: 'step.summary' }, { type: 'text', source: 'step.summary.summary' }],
    ))).toEqual([]);
  });

  it('checks prefetch steps and ingredient-form steps like op steps', () => {
    const r = {
      ...recipe([card('{{step.pre.result}}')]),
      prefetch_steps: [{ id: 'pre', ingredient: 'core-ai-summarize', input: { 'llm.data': 'text' } }],
    };
    expect(reads(r)).toEqual(['warn steps[0].fields[0].value']);
  });

  it('skips a result that is not the contract object, and functions with no fixed fields', () => {
    const skipped = [
      // batch mode: one call returns an array of merged records
      { id: 'b', op: 'core.ai.summarize', args: { 'llm.data': '{{step.rows}}', 'llm.id_field': 'id' } },
      // foreach: per-iteration envelopes
      { id: 'f', op: 'core.ai.summarize', foreach: '{{step.rows}}', args: { 'llm.data': '{{item}}' } },
      // a step-level output mapping reshapes the result
      { id: 'o', ingredient: 'ai-summarize', input: { 'llm.data': 'text' }, output: { text: 'summary' } },
      // extract's fields are its own llm.fields; prompt is uncontracted
      { id: 'e', op: 'core.ai.extract', args: { 'llm.data': 'text', 'llm.fields': ['amount'] } },
      { id: 'p', op: 'core.ai.prompt', args: { 'llm.system_prompt': 's', 'llm.prompt': 'p' } },
    ];
    expect(reads(recipe([
      { id: 'rows', transform: 'default', value: [] },
      ...skipped,
      card('{{step.b.result}} {{step.f.result}} {{step.o.text}} {{step.e.amount}} {{step.p.verdict}}'),
    ]))).toEqual([]);
  });

  it('reads metadata.readme as prose, not as a read', () => {
    const r = recipe([score]);
    (r.metadata as Record<string, unknown>).readme = 'Never read `{{step.scoring.confidence}}`: score has none.';
    expect(reads(r)).toEqual([]);
  });

  it('warns, never errors — an installed recipe that runs today still runs', () => {
    // Every server run parses its recipe strictly, so an error here would stop a
    // recipe whose only fault is an empty row. `recipe-corpus-validity.test.ts`
    // refuses the finding for shipped recipes instead.
    const errorsOf = (r: Record<string, unknown>): string[] =>
      issuesOf(r).filter((i) => i.severity === 'error').map((i) => i.code);
    const broken = recipe([summary], [{ type: 'ai_analysis', source: 'step.summary.result' }]);
    const whole = recipe([summary], [{ type: 'ai_analysis', source: 'step.summary' }]);
    expect(reads(broken).length).toBeGreaterThan(0);
    expect(errorsOf(broken)).toEqual(errorsOf(whole));
  });
});
