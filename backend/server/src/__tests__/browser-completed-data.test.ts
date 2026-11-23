import { describe, expect, it } from 'vitest';
import { BROWSER_COMPLETED_READS_CHARS, BROWSER_FAILURE_DETAILS_CHARS, isBrowserCompletedData, isBrowserDataFailure, readBrowserFailure, type BrowserCompletedData, type BrowserDataFailure } from '@recued/contracts';
import { completedBrowserReads } from '../bridges/browser-completed-reads.js';
import { createBrowserDataStore } from '../bridges/browser-data-store.js';
import { browserRetainedData } from '../bridges/browser-retained-data.js';
import { limitBrowserFailureDetails } from '../bridges/browser-failure-budget.js';
import { limitPageObservation } from '../bridges/browser-page-observation.js';

describe('bounded retained data recovery', () => {
  it('preserves references when whole values exceed the aggregate budget and never includes the failed step', () => {
    const captures: BrowserCompletedData[] = Array.from({ length: 4 }, (_, n) => ({ step: n + 1, from: 'data',
      data_ref: `data:12345678-1234-1234-1234-${String(n).padStart(12, '0')}`, kind: 'string', fields: [], fields_complete: true,
      source_complete: false, value_omitted: false, value: String(n).repeat(1_000) }));
    const recovered = completedBrowserReads([], 4, captures);
    expect(recovered.completed_data!.map(item => item.step)).toEqual([1, 2, 3]);
    expect(recovered.completed_data!.some(item => item.value_omitted)).toBe(true);
    expect(recovered.completed_data!.some(item => !item.value_omitted)).toBe(true);
    expect(recovered.completed_data!.every(isBrowserCompletedData)).toBe(true);
    expect(recovered.completed_data!.every(item => item.source_complete === false)).toBe(true);
    expect(JSON.stringify(recovered.completed_data).length).toBeLessThanOrEqual(3_000);
    expect(captures.every(item => item.value_omitted === false)).toBe(true);
    for (const malformed of [
      { ...captures[0], value_omitted: true }, { ...captures[0], value: Infinity },
      { ...captures[0], kind: 'array', row_count: 2, value: ['only one'] },
      { ...captures[0], kind: 'array', row_count: 1, value: Array(1) },
      { ...captures[0], value: { constructor: 'forbidden' }, kind: 'object' },
    ]) expect(isBrowserCompletedData(malformed)).toBe(false);
  });
  it('keeps data references and operation diagnostics when individually bounded evidence exceeds the aggregate error budget', () => {
    const capture = { step: 1, from: 'table' as const, data_ref: 'data:12345678-1234-1234-1234-123456789abc', kind: 'array' as const, row_count: 2,
      fields: [], fields_complete: false, source_complete: false, value_omitted: true as const };
    const observation = limitPageObservation({ state: 'snapshot', page: '7:DOC', loading: false, source_truncated: false,
      field_evidence: { scope: 'page', complete: false, note: '', items: Array.from({ length: 16 }, () => ({ tag: 'h1', fields: {
        text: { value: 'Observed text '.repeat(60), source: 'textContent' as const } } })) } })!;
    const data_failure: BrowserDataFailure = { operation: 1, transform: 'map', stage: 'execution', source_ref: capture.data_ref,
      input_kind: 'array', fields_complete: true, input_fields: Array.from({ length: 12 }, (_, i) => ({ name: `${String(i).padStart(2, '0')}${'f'.repeat(158)}`, types: ['string'] })),
      parameters_complete: true, parameters: Array.from({ length: 8 }, (_, i) => ({ name: `${i}${'p'.repeat(79)}`, type: 'any', required: false })),
      schema_step: { do: 'data', describe: ['map'] } };
    expect(isBrowserDataFailure(data_failure)).toBe(true);
    const details = { batch_progress: { total_steps: 3, failed_step: 3, completed_steps: [1, 2], effects: [], recovery: 'inspect_before_repeating_actions' as const },
      page_observation: observation, data_failure, completed_data: [capture], completed_reads: [
        { step: 1, form: 'text' as const, observation: { state: 'snapshot' as const, page: '7:ORIGINAL', loading: false, source_truncated: false }, content: 'text '.repeat(600) },
        { step: 2, form: 'text' as const, observation: { state: 'snapshot' as const, page: '7:OTHER', loading: false, source_truncated: false }, content: 'more '.repeat(600) },
      ] };
    // First apply the normal shared completed-evidence bound.
    while (JSON.stringify(details.completed_reads).length + JSON.stringify(details.completed_data).length > BROWSER_COMPLETED_READS_CHARS) {
      const first = details.completed_reads[0]!;
      if (first.content.length) first.content = first.content.slice(0, -256);
      else details.completed_reads.shift();
    }
    expect(JSON.stringify(details).length).toBeGreaterThan(BROWSER_FAILURE_DETAILS_CHARS);
    const bounded = limitBrowserFailureDetails(details);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(BROWSER_FAILURE_DETAILS_CHARS);
    expect(bounded.completed_data).toEqual([capture]);
    expect(bounded.data_failure).toEqual(data_failure);
    expect(readBrowserFailure({ code: 'DOM_CHECK_FAILED', browser_failure: { slug: 'dom-act', details: bounded } })?.details).toEqual(bounded);
  });

  it('prioritizes bounded references while preserving text recovery within the existing shared budget', () => {
    const store = createBrowserDataStore();
    const captures = Array.from({ length: 10 }, (_, index) => {
      const saved = store.keep('owner', [Object.fromEntries(Array.from({ length: 12 }, (_, field) => [`field_${field}_${'x'.repeat(140)}`, 'PRIVATE_ROW_VALUE']))],
        [{ kind: 'table', page: `7:DOC${index}`, url: 'https://example.com', title: '', complete: false, truncated: true, loading: false }]);
      return { step: index + 1, from: 'table' as const, ...browserRetainedData(saved.descriptor) };
    });
    const reads = [{ step: 1, page: '7:ORIGINAL', data: { text: '.name Grandfathered ' + 'text '.repeat(800) } }];
    const recovered = completedBrowserReads(reads, 11, captures);
    expect(recovered.completed_data!.at(-1)!.step).toBe(10);
    expect(recovered.completed_data_truncated).toBe(true);
    expect(recovered.completed_reads![0]!.content).toContain('.name Grandfathered');
    expect(JSON.stringify(recovered.completed_reads).length + JSON.stringify(recovered.completed_data).length).toBeLessThanOrEqual(BROWSER_COMPLETED_READS_CHARS);
    expect(JSON.stringify(recovered)).not.toContain('PRIVATE_ROW_VALUE');
    const details = { ...recovered, batch_progress: { total_steps: 11, failed_step: 11, completed_steps: captures.map(item => item.step), effects: [],
      page_state: 'unknown', recovery: 'inspect_before_repeating_actions' } };
    expect(readBrowserFailure({ code: 'DOM_CHECK_FAILED', browser_failure: { slug: 'dom-act', details } })?.details).toEqual(details);
  });
});
