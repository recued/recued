/** The owner's held run, once it settled — kept in memory for the page still
 *  showing "held". Bounds and the filter on WHO it is kept for. */

import { describe, expect, it } from 'vitest';
import type { ServerExecuteResponse } from '@recued/contracts';

import {
  createSettledRunResults,
  rememberOwnerPageRun,
} from '../settled-run-results.js';

const response = (recipe_id: string): ServerExecuteResponse => ({
  recipe_id,
  recipe_hash: `hash-${recipe_id}`,
  success: true,
  output: { render: [], sidebar: [] },
  steps: [],
  errors: [],
  duration_ms: 1,
});

const OWNER_PAGE = { channel: 'user', actor: 'user_self', user_id: 'u', client_token_id: 't' };

describe('createSettledRunResults', () => {
  it('hands back what it was given, by run id', () => {
    const store = createSettledRunResults();
    const kept = response('a');
    store.remember('run-a', kept);
    expect(store.get('run-a')).toBe(kept);
    expect(store.get('run-b')).toBeUndefined();
  });

  it('lets go of a result once it is older than the TTL', () => {
    let now = 1_000;
    const store = createSettledRunResults({ ttlMs: 100, now: () => now });
    store.remember('run-a', response('a'));
    now = 1_099;
    expect(store.get('run-a')).toBeDefined();
    now = 1_100;
    expect(store.get('run-a')).toBeUndefined();
  });

  it('keeps at most `max`, dropping the oldest first', () => {
    const store = createSettledRunResults({ max: 2 });
    store.remember('run-1', response('1'));
    store.remember('run-2', response('2'));
    store.remember('run-3', response('3'));
    expect(store.get('run-1')).toBeUndefined();
    expect(store.get('run-2')).toBeDefined();
    expect(store.get('run-3')).toBeDefined();
  });

  it('a result remembered again is young again', () => {
    let now = 0;
    const store = createSettledRunResults({ max: 2, ttlMs: 100, now: () => now });
    store.remember('run-1', response('1'));
    store.remember('run-2', response('2'));
    now = 50;
    store.remember('run-1', response('1 again'));
    store.remember('run-3', response('3'));
    // run-2 was the oldest once run-1 was renewed.
    expect(store.get('run-2')).toBeUndefined();
    expect(store.get('run-1')?.recipe_id).toBe('1 again');
  });
});

describe('rememberOwnerPageRun', () => {
  it('keeps a run the owner started from a page', () => {
    const store = createSettledRunResults();
    rememberOwnerPageRun(store, {
      execution_source: OWNER_PAGE, run_id: 'run-a', tool_name: 'a', result: response('a'), ts: 0,
    });
    expect(store.get('run-a')?.recipe_id).toBe('a');
  });

  it('keeps nothing for chat, a door, a schedule or a peer — no page is waiting on those', () => {
    const store = createSettledRunResults();
    for (const channel of ['chat', 'mcp', 'reactive', 'cron', 'reception', 'peer']) {
      rememberOwnerPageRun(store, {
        execution_source: { channel, actor: 'system' },
        run_id: `run-${channel}`, tool_name: 'a', result: response('a'), ts: 0,
      });
      expect(store.get(`run-${channel}`), channel).toBeUndefined();
    }
  });

  it('keeps nothing for a denial — it settles with no result to show', () => {
    const store = createSettledRunResults();
    rememberOwnerPageRun(store, {
      execution_source: OWNER_PAGE, run_id: 'run-denied', tool_name: 'a',
      result: { denied: true, message: 'The owner denied it.' }, ts: 0,
    });
    expect(store.get('run-denied')).toBeUndefined();
  });

  it('is a no-op without a store', () => {
    expect(() => rememberOwnerPageRun(undefined, {
      execution_source: OWNER_PAGE, run_id: 'run-a', tool_name: 'a', result: response('a'), ts: 0,
    })).not.toThrow();
  });
});
