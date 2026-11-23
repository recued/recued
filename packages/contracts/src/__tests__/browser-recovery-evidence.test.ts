import { describe, expect, it } from 'vitest';
import { isBrowserDataFailure, isBrowserExtractionTargets, parseBrowserActSteps, readBrowserFailure } from '../index.js';

const page = 'bridge:owner:7:DOCUMENT';
const progress = { total_steps: 2, failed_step: 2, completed_steps: [1], effects: [{ step: 1, attempted: 1, acknowledged: 1 }],
  page_state: 'ready', current_page: page, recovery: 'inspect_before_repeating_actions', next_step: { do: 'read', page, form: 'outline' } };
const error = (batch: unknown) => ({ code: 'DOM_CHECK_FAILED', browser_failure: { slug: 'dom-act', details: { batch_progress: batch } } });

describe('bounded browser recovery evidence', () => {
  it('accepts factual batch progress without a prescribed follow-up call', () => {
    const { next_step: _next, recovery: _recovery, ...facts } = progress;
    expect(readBrowserFailure(error(facts))?.details.batch_progress).toEqual(facts);
  });
  it('carries a valid read of the acknowledged destination through the failure seam', () => {
    const result = readBrowserFailure(error(progress));
    expect(result?.details.batch_progress?.next_step).toEqual(progress.next_step);
    expect(parseBrowserActSteps([result?.details.batch_progress?.next_step])).toMatchObject({ ok: true });
    const { next_step: _next, ...legacy } = progress;
    expect(readBrowserFailure(error(legacy))).toBeDefined();
  });
  it('rejects action recovery, another page and uncertain command delivery', () => {
    for (const changed of [
      { ...progress, next_step: { do: 'reload', page, form: 'outline' } },
      { ...progress, next_step: { ...progress.next_step, page: 'bridge:other:8:OTHER' } },
      { ...progress, effects: [{ step: 1, attempted: 1, acknowledged: 0 }] },
      { ...progress, next_step: { ...progress.next_step, selector: '#guess' } },
    ]) expect(readBrowserFailure(error(changed))).toBeUndefined();
    expect(readBrowserFailure({ ...error(progress), code: 'ACTION_DELIVERY_UNCERTAIN' })).toBeUndefined();
    expect(readBrowserFailure({ ...error(progress), code: 'DOM_PAGE_NOT_MATCHING' })).toBeUndefined();
  });
  it('validates data diagnostics without admitting captured values or a replacement browser action', () => {
    const failure = { operation: 2, transform: 'map', stage: 'output', source_ref: 'data:12345678-1234-1234-1234-123456789abc',
      input_kind: 'array', input_fields: [{ name: 'count', types: ['number'] }], fields_complete: true,
      parameters: [{ name: 'expression', type: 'any', required: false }], parameters_complete: true,
      schema_step: { do: 'data', describe: ['map'] }, output_path: '$[0]["total"]', problem: 'undefined' };
    expect(isBrowserDataFailure(failure)).toBe(true);
    expect(readBrowserFailure({ code: 'DOM_CHECK_FAILED', browser_failure: { slug: 'dom-act', details: { data_failure: failure } } }))
      .toMatchObject({ details: { data_failure: failure } });
    expect(isBrowserDataFailure({ ...failure, input_values: ['private'] })).toBe(false);
    expect(isBrowserDataFailure({ ...failure, schema_step: { do: 'click', ref: 'e1' } })).toBe(false);
  });
  it('limits observed extraction hints to table reads', () => {
    const targets = { source: 'captured_dom', scope: 'page', source_complete: true, tables_complete: true,
      tables: [{ step: { do: 'table', selector: '#actual' } }] };
    expect(isBrowserExtractionTargets(targets)).toBe(true);
    expect(isBrowserExtractionTargets({ ...targets, tables: [{ step: { do: 'click', selector: '#actual' } }] })).toBe(false);
  });
});
