/** D-115 Phase 6 — kernel adapter routing for the watcher slugs. The
 *  adapter fans every watcher slug out through the unified `watcher`
 *  dispatcher slot so runtime wiring can mount one handler covering all
 *  reactive gates. The mail, file, calendar, webhook and recipe watchers
 *  were retired 2026-10-05. */

import { describe, expect, it } from 'vitest';

import { createKernelAdapter, type KernelWatcherSlug, type KernelTriggerOutput } from '../kernel.js';
import { IngredientError } from '../types.js';

const mkCall = (slug: string, input: Record<string, unknown>) => ({
  slug,
  risk_tier: 'read' as const,
  input,
  output: {},
  manifest_version: 1,
});

const WATCHER_SLUGS: KernelWatcherSlug[] = [
  'time-watcher',
  'time-relative-watcher',
  'http-watcher',
];

describe('createKernelAdapter — watcher routing', () => {
  it('routes every watcher slug through the unified dispatcher', async () => {
    const seen: Array<{ slug: string; args: Record<string, unknown> }> = [];
    const adapter = createKernelAdapter({
      watcher: async (input) => {
        seen.push(input);
        return { should_run: true };
      },
    });
    for (const slug of WATCHER_SLUGS) {
      await adapter(mkCall(slug, { example: slug }));
    }
    expect(seen.map((s) => s.slug)).toEqual(WATCHER_SLUGS);
  });

  it('surfaces SERVER_NOT_REACHABLE when no watcher dispatcher is wired', async () => {
    const adapter = createKernelAdapter({});
    for (const slug of WATCHER_SLUGS) {
      await expect(adapter(mkCall(slug, {}))).rejects.toBeInstanceOf(IngredientError);
      try {
        await adapter(mkCall(slug, {}));
      } catch (e) {
        expect((e as IngredientError).code).toBe('SERVER_NOT_REACHABLE');
      }
    }
  });

  it('forwards args verbatim to the dispatcher', async () => {
    let captured: Record<string, unknown> | null = null;
    const adapter = createKernelAdapter({
      watcher: async (input) => {
        captured = input.args;
        return { should_run: false };
      },
    });
    await adapter(mkCall('time-watcher', {
      weekdays: [1, 2, 3, 4, 5],
      start_hour: 8,
      end_hour: 9,
    }));
    expect(captured).toEqual({
      weekdays: [1, 2, 3, 4, 5],
      start_hour: 8,
      end_hour: 9,
    });
  });

  it('returns whatever TriggerOutput the dispatcher emits (should_run true)', async () => {
    const adapter = createKernelAdapter({
      watcher: async () => ({
        should_run: true,
        items: [{ id: 'm1', subject: 'hi' }],
        last_seen_at: 1234,
      }),
    });
    const res = await adapter(mkCall('time-relative-watcher', {})) as KernelTriggerOutput;
    expect(res.should_run).toBe(true);
    expect(res.items).toEqual([{ id: 'm1', subject: 'hi' }]);
    expect(res.last_seen_at).toBe(1234);
  });

  it('returns should_run: false for a dispatcher that gates the tick', async () => {
    const adapter = createKernelAdapter({
      watcher: async () => ({ should_run: false }),
    });
    const res = await adapter(mkCall('time-watcher', { start_hour: 9, end_hour: 17 })) as KernelTriggerOutput;
    expect(res).toEqual({ should_run: false });
  });

  it('does not consume dispatchers unrelated to watchers (isolation)', async () => {
    // When only the watcher slot is wired, non-watcher kernel slugs
    // should still surface SERVER_NOT_REACHABLE rather than routing
    // through the watcher slot by accident.
    const adapter = createKernelAdapter({
      watcher: async () => ({ should_run: true }),
    });
    await expect(adapter(mkCall('shared-write', { key: 'x', value: 1 }))).rejects.toMatchObject({
      code: 'SERVER_NOT_REACHABLE',
    });
  });

  it('rejects unknown watcher-looking slugs (not in the enumerated set)', async () => {
    const adapter = createKernelAdapter({
      watcher: async () => ({ should_run: true }),
    });
    // slack-watcher is NOT in the starter set (spec defers it pending
    // cloud relay work — see D-115 spec §Non-goals).
    await expect(adapter(mkCall('slack-watcher', {}))).rejects.toMatchObject({
      code: 'INGREDIENT_NOT_FOUND',
    });
  });

  it.each(['mail-watcher', 'file-watcher', 'calendar-watcher', 'webhook-watcher', 'recipe-watcher'])(
    'a retired watcher (%s) is not routed: a step naming one fails as an unknown ingredient',
    async (slug) => {
      const adapter = createKernelAdapter({
        watcher: async () => ({ should_run: true }),
      });
      await expect(adapter(mkCall(slug, {}))).rejects.toMatchObject({ code: 'INGREDIENT_NOT_FOUND' });
    },
  );

  it('passes the full args object without mutation to the handler', async () => {
    const args = { weekdays: [1], start_hour: 8, end_hour: 9, now: 1_700_000_000_000 };
    let dispatched: Record<string, unknown> | null = null;
    const adapter = createKernelAdapter({
      watcher: async (input) => {
        dispatched = input.args;
        return { should_run: true, items: [] };
      },
    });
    await adapter(mkCall('time-watcher', args));
    expect(dispatched).toEqual(args);
    // Reference equality would indicate the adapter handed through the
    // live reference — assert structural equality instead.
  });
});
