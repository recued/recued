import { describe, expect, it } from 'vitest';
import type { BrowserFailure, RecipeDefinition } from '@recued/contracts';
import { runStep } from '../step-runner.js';
import { runPrefetch } from '../prefetch.js';
import type { ExecutionContext } from '../types.js';

const fixture: BrowserFailure = { slug: 'dom-act', details: { executed: false, violations: [
  { path: 'steps[0].max_pages', code: 'out_of_range', message: 'max_pages is required, from 1 to 20',
    expected_type: 'integer', min: 1, max: 20, received: 50 },
] } };
const recipe: RecipeDefinition = { recipe_id: 'boundary', version: 1, ttl: 300,
  metadata: { name: 'Boundary', description: 'Failure details', author: 'test', supported_platforms: [] },
  variables: {}, prefetch_steps: [{ id: 'read', ingredient: 'dom-act', input: {} }], steps: [], output: { render: [] } };
const context = (error: unknown): ExecutionContext => ({ recipe,
  stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} }, ingredientExecutor: async () => { throw error; } });
const failure = (browser_failure: unknown) => Object.assign(new Error('Invalid collection'), { code: 'DOM_SELECTOR_MISSING',
  browser_failure, details: { account_email: 'private@example.org', input_value: 'SECRET' } });

describe('bounded browser failure carrier', () => {
  it('projects retained data receipts only for completed steps and refuses values or unrelated recovery claims', async () => {
    const capture = { step: 1, from: 'table', data_ref: 'data:12345678-1234-1234-1234-123456789abc', kind: 'array', row_count: 2,
      fields: [{ field: 'Name', types: ['string'] }], fields_complete: true, source_complete: false, value_omitted: true };
    const details = { batch_progress: { total_steps: 2, failed_step: 2, completed_steps: [1], effects: [],
      page_state: 'unknown', recovery: 'inspect_before_repeating_actions' }, completed_data: [capture] };
    const execute = (updated: unknown) => runStep({ id: 'act', ingredient: 'dom-act', input: {} }, context(failure({ slug: 'dom-act', details: updated })));
    expect((await execute(details)).error!.details).toEqual(details);
    for (const changed of [
      { ...details, completed_data: [{ ...capture, values: ['PRIVATE'] }] },
      { ...details, completed_data: [{ ...capture, step: 2 }] },
      { ...details, completed_data: [capture, capture] },
      { ...details, completed_data: [{ ...capture, from: 'click' }] },
      { ...details, completed_data: [{ ...capture, row_count: -1 }] },
      { batch_progress: details.batch_progress, completed_data_truncated: true },
    ]) expect((await execute(changed)).error!.details).toEqual({});
  });

  it('retains click-local obstruction facts and rejects malformed or unrelated failure claims', async () => {
    const obstruction = { operation: 'click', executed: false, reason: 'target_occluded', source: 'hit_test',
      target: { tag: 'button', ref: 'e2' }, blocker: { tag: 'iframe', label: 'Advertisement' }, waited_ms: 8000 };
    const error = (click_obstruction: unknown, code = 'DOM_WRITE_FAILED', slug = 'dom-click') =>
      Object.assign(failure({ slug, details: { click_obstruction } }), { code });
    const valid = await runStep({ id: 'act', ingredient: 'dom-click', input: {} }, context(error(obstruction)));
    expect(valid.error!.details).toEqual({ click_obstruction: obstruction });
    expect(valid.error!.details).not.toHaveProperty('executed');
    for (const invalid of [error({ ...obstruction, executed: true }), error({ ...obstruction, source: 'model' }),
      error({ ...obstruction, blocker: { tag: 'iframe', label: 'x'.repeat(81) } }),
      error({ ...obstruction, target: { tag: 'button', value: 'SECRET' } }), error({ ...obstruction, waited_ms: -1 }),
      error({ ...obstruction, blocker: { tag: 'div', label_truncated: true } }),
      error(obstruction, 'ACTION_DELIVERY_UNCERTAIN'), error(obstruction, 'DOM_WRITE_FAILED', 'dom-write')]) {
      const result = await runStep({ id: 'act', ingredient: 'dom-click', input: {} }, context(invalid));
      expect(result.error!.details).toEqual({});
    }
  });

  it('retains bounded control corrections only for a field-write refusal', async () => {
    const control_correction = { ref: 'e24', kind: 'link', name: 'Login', requested_action: 'type',
      supported_actions: ['click'], source: 'fresh_kept_read' };
    const error = (correction: unknown, code = 'DOM_WRITE_FAILED') => Object.assign(failure({
      slug: 'dom-write', details: { control_correction: correction } }), { code });
    const valid = await runStep({ id: 'act', ingredient: 'dom-write', input: {} }, context(error(control_correction)));
    expect(valid.error!.details).toEqual({ control_correction });
    for (const invalid of [error({ ...control_correction, input_value: 'SECRET' }),
      error({ ...control_correction, name: 'x'.repeat(161) }), error(control_correction, 'DOM_CLICK_FAILED')]) {
      const log = await runStep({ id: 'act', ingredient: 'dom-write', input: {} }, context(invalid));
      expect(log.error!.details).toEqual({});
    }
  });

  it('retains completed read contents with their original page, and refuses malformed read receipts', async () => {
    const details = { batch_progress: { total_steps: 3, failed_step: 3, completed_steps: [1, 2], effects: [],
      page_state: 'unknown' as const, recovery: 'inspect_before_repeating_actions' as const }, completed_reads: [{ step: 1,
      observation: { state: 'snapshot' as const, page: '7:ORIGINAL', url: 'https://example.com/article',
        title: 'Article', loading: false, source_truncated: false }, form: 'text' as const, content: '.name Grandfathered' }] };
    const valid: BrowserFailure = { slug: 'dom-act', details };
    const retained = await runStep({ id: 'act', ingredient: 'dom-act', input: {} }, context(failure(valid)));
    expect(retained.error!.details).toEqual(details);
    const read = details.completed_reads[0]!;
    for (const completed_reads of [
      [{ ...read, step: 3 }], [{ ...read, input_value: 'SECRET' }], [{ ...read, form: 'raw_html' }],
      [{ ...read, observation: { ...read.observation, account_email: 'private@example.com' } }],
      [{ ...read, content: 'x'.repeat(3_001) }], [read, read],
    ]) {
      const log = await runStep({ id: 'act', ingredient: 'dom-act', input: {} },
        context(failure({ slug: 'dom-act', details: { ...details, completed_reads } })));
      expect(log.error!.details).toEqual({});
    }
  });
  it('also survives a read-only prefetch failure without spreading unrelated adapter details', async () => {
    const [log] = await runPrefetch(context(failure(fixture)));
    expect(log!.error!.details).toEqual(fixture.details);
    expect(log!.error!.source.ingredient_slug).toBe('dom-act');
  });

  it('ordinary adapter details remain private even when their names resemble browser fields', async () => {
    const error = Object.assign(new Error('ordinary refusal'), { code: 'DOM_SELECTOR_MISSING',
      details: { ...fixture.details, account_email: 'private@example.org' } });
    const log = await runStep({ id: 'act', ingredient: 'dom-act', input: {} }, context(error));
    expect(log.error!.details).toEqual({});
  });

  it('a non-browser adapter code cannot introduce a browser carrier', async () => {
    const error = Object.assign(failure(fixture), { code: 'MAIL_SEND_SELF_LOOP_TO' });
    const log = await runStep({ id: 'send', ingredient: 'mail-send', input: {} }, context(error));
    expect(log.error!.code).toBe('MAIL_SEND_SELF_LOOP_TO');
    expect(log.error!.details).toEqual({});
  });

  it.each(['loading', 'unknown'] as const)('retains a known document independently of %s readiness', async page_state => {
    const details = { batch_progress: { total_steps: 2, failed_step: 2, completed_steps: [], effects: [],
      page_state, current_page: '7:DOC1' } };
    const log = await runStep({ id: 'act', ingredient: 'dom-act', input: {} }, context(failure({ slug: 'dom-act', details })));
    expect(log.error!.details).toEqual(details);
    expect(log.error!.details).not.toHaveProperty('executed');
  });

  it.each([
    { ...fixture, details: { ...fixture.details, account_email: 'private@example.org' } },
    { ...fixture, details: { ...fixture.details, violations: Array(17).fill(fixture.details.violations![0]) } },
    { ...fixture, details: { ...fixture.details, violations: [{ ...fixture.details.violations![0], received: Infinity }] } },
    { slug: 'dom-click', details: { executed: false } },
    { slug: 'dom-act', details: { batch_progress: { total_steps: 2, failed_step: 3, completed_steps: [], effects: [], recovery: 'inspect_before_repeating_actions' } } },
    { slug: 'dom-act', details: { batch_progress: { total_steps: 2, failed_step: 2, completed_steps: [2], effects: [], recovery: 'inspect_before_repeating_actions' } } },
    { slug: 'dom-act', details: { batch_progress: { total_steps: 2, failed_step: 2, completed_steps: [],
      effects: [{ step: 1, attempted: 1, acknowledged: 2 }], recovery: 'inspect_before_repeating_actions' } } },
    { slug: 'dom-act', details: { batch_progress: { total_steps: 2, failed_step: 2, completed_steps: [], effects: [],
      page_state: 'closed', current_page: '7:DOC1', recovery: 'inspect_before_repeating_actions' } } },
    { slug: 'dom-click', details: { page_observation: { state: 'snapshot', loading: false, source_truncated: false,
      title: 'x'.repeat(4_001) } } },
    { slug: 'dom-click', details: { page_observation: { state: 'snapshot', loading: false, source_truncated: false,
      field_evidence: { scope: 'page', items: [{ tag: 'h1', fields: { text: { value: 'secret', source: 'password' } } }], complete: true, note: '' } } } },
  ])('rejects an unknown, oversized or malformed carrier: %#', async browser_failure => {
    const log = await runStep({ id: 'act', ingredient: 'dom-act', input: {} }, context(failure(browser_failure)));
    expect(log.error!.details).toEqual({});
    expect(log.error!.code).toBe('DOM_SELECTOR_MISSING');
  });
});
