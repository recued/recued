/** D-115 Phase 6 — watcher dispatcher composition tests. */

import { describe, it, expect, vi } from 'vitest';
import type { KernelWatcherSlug } from '@recued/ingredients';

import { createWatcherDispatcher } from '../index.js';

describe('createWatcherDispatcher — routing', () => {
  it('routes time-watcher to evaluateTimeWatcher', async () => {
    const dispatch = createWatcherDispatcher({});
    const r = await dispatch({ slug: 'time-watcher', args: {} });
    expect(r.should_run).toBe(true);
  });

  it('reads a time window on the server\'s resolved zone, at the injected clock', async () => {
    // Monday 2026-10-05 15:30 UTC = 08:30 in Los Angeles.
    const now = () => Date.parse('2026-10-05T15:30:00Z');
    const args = { weekdays: [1], start_hour: 8, end_hour: 9 };
    const pacific = createWatcherDispatcher({ now, serverTimeZone: () => 'America/Los_Angeles' });
    const utc = createWatcherDispatcher({ now, serverTimeZone: () => 'UTC' });
    expect((await pacific({ slug: 'time-watcher', args })).should_run).toBe(true);
    expect((await utc({ slug: 'time-watcher', args })).should_run).toBe(false);
  });

  it('routes http-watcher through evaluateHttpWatcher', async () => {
    const fetchFn = vi.fn(async () => new Response('x', { status: 200 }));
    const dispatch = createWatcherDispatcher({
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const r = await dispatch({
      slug: 'http-watcher',
      args: { target_url: 'https://example.com' },
    });
    expect(r.should_run).toBe(true);
  });

  it.each(['dom-watcher', 'mail-watcher', 'file-watcher', 'calendar-watcher', 'webhook-watcher', 'recipe-watcher'])(
    'a retired watcher slug (%s) fails closed with SERVER_NOT_REACHABLE',
    async (slug) => {
      // The testTrigger rpc boundary casts `slug: string` into the union, so a
      // stale slug (a retired watcher, named by a recipe saved before it went)
      // or a typo reaches the dispatcher at runtime — the `default` arm must
      // fail closed, not fall through to an undefined return the caller then
      // dereferences.
      const dispatch = createWatcherDispatcher({});
      await expect(
        dispatch({ slug: slug as KernelWatcherSlug, args: {} }),
      ).rejects.toMatchObject({ name: 'IngredientError', code: 'SERVER_NOT_REACHABLE' });
    },
  );
});
