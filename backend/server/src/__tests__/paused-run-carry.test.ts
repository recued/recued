/** What a record that ends or resumes a paused run keeps from the paused record
 *  (`execution/paused-run-carry.ts`). The three writers that end one (deny,
 *  expiry, abandoned peer hold) are pinned in their own tests; this pins the
 *  list and the resumed spend. */

import type { TokenUsageReport } from '@recued/contracts';
import { buildAuditEntry, type AuditEntry } from '@recued/storage';
import { describe, expect, it } from 'vitest';

import {
  carriedFromPausedRun,
  readPausedRecord,
  resumedRunUsage,
} from '../execution/paused-run-carry.js';

const paused = (overrides: Partial<Parameters<typeof buildAuditEntry>[0]> = {}): AuditEntry =>
  buildAuditEntry({
    run_id: 'run-1',
    recipe_id: 'recipe-1',
    recipe_hash: 'hash-1',
    now: 1_000,
    duration_ms: 5,
    commit_status: 'awaiting_approval',
    config_snapshot: {},
    errors: [],
    trigger_url: null,
    trigger_source: 'manual',
    instance_id: 'server-1',
    ...overrides,
  });

const USAGE: TokenUsageReport = { input_tokens: 100, output_tokens: 20, total_tokens: 120, provider_calls: 2 };
const NOTE = {
  tool: 'opencode', version: '2.0.1', tested: { from: '1.18.35', before: '2.0.0' }, state: 'untested' as const,
};
const YIELD = { steps_run: 2, steps_skipped: 1, items_total: 3, items_failed: 0 };
const SOURCE = {
  channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'tok_1',
} as const;

describe('carriedFromPausedRun', () => {
  it('keeps what links the run and what it did before it paused', () => {
    const anchor = paused({
      dish_id: 'dsh_1',
      recipe_insight_id: 7,
      process_id: 'proc_1',
      run_mode: 'live',
      execution_source: SOURCE,
      correlation_id: 'corr_1',
      run_yield: YIELD,
      total_usage: USAGE,
      connections_used: [{ slot: 'hubspot', connection_name: 'hubspot-key' }],
      untested_tools: [NOTE],
    });
    expect(carriedFromPausedRun(anchor)).toEqual({
      dish_id: 'dsh_1',
      recipe_insight_id: 7,
      process_id: 'proc_1',
      run_mode: 'live',
      execution_source: SOURCE,
      correlation_id: 'corr_1',
      run_yield: YIELD,
      total_usage: USAGE,
      connections_used: [{ slot: 'hubspot', connection_name: 'hubspot-key' }],
      untested_tools: [NOTE],
    });
  });

  it('carries nothing a paused record does not hold', () => {
    expect(carriedFromPausedRun(paused())).toEqual({});
  });

  it('keeps an all-zero yield, which is a fact, and drops empty lists', () => {
    const zero = { steps_run: 0, steps_skipped: 0, items_total: 0, items_failed: 0 };
    const carried = carriedFromPausedRun({
      ...paused({ run_yield: zero }),
      connections_used: [],
      untested_tools: [],
    });
    expect(carried).toEqual({ run_yield: zero });
  });
});

describe('resumedRunUsage', () => {
  const LATER: TokenUsageReport = { input_tokens: 10, output_tokens: 5, total_tokens: 15, provider_calls: 1 };

  it('adds what the paused record holds to what this part spent', () => {
    expect(resumedRunUsage(paused({ total_usage: USAGE }), LATER)).toEqual({
      input_tokens: 110, output_tokens: 25, total_tokens: 135, provider_calls: 3,
    });
  });

  it('keeps what was spent before the pause when this part spent nothing', () => {
    expect(resumedRunUsage(paused({ total_usage: USAGE }), undefined)).toEqual(USAGE);
  });

  it('is this part\'s spend for a run with no paused record, or one that spent nothing', () => {
    expect(resumedRunUsage(undefined, LATER)).toBe(LATER);
    expect(resumedRunUsage(paused(), LATER)).toBe(LATER);
    expect(resumedRunUsage(undefined, undefined)).toBeUndefined();
  });

  it('counts a stored total that is not a usage report as none', () => {
    for (const total_usage of [
      { input_tokens: '10', output_tokens: 5, total_tokens: 15 },
      { input_tokens: 10, output_tokens: 5 },
      { input_tokens: 10, output_tokens: 5, total_tokens: 15, provider_calls: Number.NaN },
      { input_tokens: -1, output_tokens: 5, total_tokens: 4 },
      'lots',
    ]) {
      const anchor = { ...paused(), total_usage } as unknown as AuditEntry;
      expect(resumedRunUsage(anchor, LATER)).toBe(LATER);
    }
  });
});

describe('readPausedRecord', () => {
  it('is the stored record, or none when there is none or it cannot be read', async () => {
    const anchor = paused();
    expect(await readPausedRecord({ get: async () => anchor }, 'run-1')).toBe(anchor);
    expect(await readPausedRecord({ get: async () => null }, 'run-1')).toBeUndefined();
    expect(await readPausedRecord({ get: async () => { throw new Error('disk'); } }, 'run-1'))
      .toBeUndefined();
  });
});
