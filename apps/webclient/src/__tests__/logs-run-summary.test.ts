import { describe, expect, it } from 'vitest';
import { RUN_ANCHOR_STATUSES, type RunDetail } from '@recued/contracts';
import { logsRunSummary, renderLogsRunSummary } from '../logs/run-summary.js';

const detail = (): RunDetail => ({
  audit: {
    run_id: 'run-1', recipe_id: 'mail/send', recipe_hash: 'a'.repeat(64),
    started_at: 1_700_000_000_000, finished_at: 1_700_000_001_000,
    duration_ms: 1000, status: 'succeeded',
    origin: { actor: 'user_self', label: 'user_self', channel: 'user' },
    trigger_source: null, instance_id: null, errors: [],
  },
  approvals: { checkpoints: [] }, errors: [], links: [],
  gateway: { policy_result: 'allowed', per_call_trace: [] },
});

describe('historical run summary metadata', () => {
  it.each(RUN_ANCHOR_STATUSES)('preserves the recorded lifecycle state %s', status => {
    const run = detail(); run.audit.status = status;
    expect(logsRunSummary(run)).toContain(`Recorded status: ${status}\n`);
  });

  it('reads only the allowed metadata, deduplicating known codes from both error lists', () => {
    const run = detail();
    const error = { code: 'BAD_INPUT',
      get message() { throw new Error('message must not be read'); },
      get details() { throw new Error('details must not be read'); },
      get source() { throw new Error('source must not be read'); },
    } as unknown as RunDetail['errors'][number];
    run.audit.errors = [error];
    run.errors = [error, { code: 'STEP_TIMEOUT' } as typeof error, { code: 'private@example.test' } as unknown as typeof error];
    for (const key of ['origin', 'output_string', 'trigger_source', 'instance_id', 'total_usage', 'ask_id']) {
      Object.defineProperty(run.audit, key, { get() { throw new Error(`${key} must not be read`); } });
    }
    for (const key of ['approvals', 'links']) {
      Object.defineProperty(run, key, { get() { throw new Error(`${key} must not be read`); } });
    }
    Object.defineProperty(run.gateway, 'per_call_trace', { get() { throw new Error('trace must not be read'); } });
    const text = logsRunSummary(run);
    expect(text).toContain('Recipe: mail/send\n');
    expect(text).toContain('Run ID: run-1\n');
    expect(text).toContain('Policy result: allowed\nStarted: 2023-11-14T22:13:20.000Z\nDuration: 1000 ms');
    expect(text).toContain('Error codes: BAD_INPUT, STEP_TIMEOUT');
    expect(text).toContain('Unrecognized error codes: present');
    expect(text).not.toContain('private');
  });

  it('keeps absent yield distinct from recorded zeroes', () => {
    const run = detail();
    expect(logsRunSummary(run)).toContain('Yield: Not recorded');
    expect(logsRunSummary(run)).not.toContain('Steps run: 0');
    run.audit.run_yield = { steps_run: 0, steps_skipped: 0, items_total: 0, items_failed: 0, stopped_at: null };
    expect(logsRunSummary(run)).toContain('Steps run: 0\nSteps skipped: 0\nItems attempted: 0\nFailed items: 0\nEnded early: No');
    expect(logsRunSummary(run)).not.toContain('All attempted items failed');
  });

  it('reports all failed items even with a succeeded status and does not copy step names', () => {
    const run = detail();
    run.audit.run_yield = { steps_run: 4, steps_skipped: 1, items_total: 12, items_failed: 12,
      stopped_at: 'private-stop-step', skipped_step_ids: ['private-skipped-step'] };
    const text = logsRunSummary(run);
    expect(text).toContain('Recorded status: succeeded');
    expect(text).toContain('Items attempted: 12\nFailed items: 12\nItem outcome: All attempted items failed\nEnded early: Yes');
    expect(text).not.toContain('private');
  });

  it('retains partial failures without claiming all attempted items failed', () => {
    const run = detail();
    run.audit.run_yield = { steps_run: 4, steps_skipped: 1, items_total: 12, items_failed: 3 };
    expect(logsRunSummary(run)).toContain('Items attempted: 12\nFailed items: 3');
    expect(logsRunSummary(run)).not.toContain('Item outcome:');
    expect(logsRunSummary(run)).not.toContain('Ended early:');
  });

  it('does not manufacture metrics from malformed counts or dates', () => {
    const run = detail(); run.audit.started_at = Infinity; run.audit.duration_ms = NaN;
    run.audit.run_yield = { steps_run: -1, steps_skipped: 1.5, items_total: 2, items_failed: 3 };
    const text = logsRunSummary(run);
    expect(text).toContain('Started: Not recorded\nDuration: Not recorded');
    expect(text).toContain('Steps run: Not recorded\nSteps skipped: Not recorded\nItems attempted: 2\nFailed items: Not recorded');
    expect(text).not.toContain('All attempted items failed');
  });

  it('rejects arbitrary lifecycle, policy, and error codes instead of copying them', () => {
    const run = detail();
    run.audit.status = 'private-status' as typeof run.audit.status;
    run.gateway.policy_result = '__proto__' as typeof run.gateway.policy_result;
    run.errors = ['__proto__', 'toString', 'private-code'].map(code => ({ code }) as RunDetail['errors'][number]);
    const text = logsRunSummary(run);
    expect(text).toContain('Recorded status: Not recorded\nPolicy result: Not recorded');
    expect(text).toContain('Error codes: Not reported');
    expect(text).not.toMatch(/private|__proto__|toString/);
  });

  it('bounds identity fields, strips control characters, and escapes preview markup', () => {
    const run = detail(); run.audit.recipe_id = `</textarea>\n${'x'.repeat(1000)}`;
    run.audit.run_id = '\u0000\u202Erun-1'; run.audit.recipe_hash = '\u0000';
    const text = logsRunSummary(run);
    expect(text).toContain('Recipe hash: Not recorded');
    expect(text).toContain('Run ID: run-1');
    expect(text).not.toMatch(/[\u0000\u202E]/);
    expect(text.length).toBeLessThan(650);
    const html = renderLogsRunSummary(run, 'idle', false);
    expect(html).toContain('&lt;/textarea&gt;');
    expect(html).not.toContain('</textarea> x');
    expect(html).toContain('readonly');
    expect(html).toContain('Copy run summary');
  });
});
