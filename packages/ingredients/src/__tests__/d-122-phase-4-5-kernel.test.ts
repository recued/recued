/** D-122 Phase 4.5 — kernel adapter dispatch tests for the four new
 *  ingredient slugs (`enrichment-upsert`, `enrichment-list`,
 *  `mail-get`, `notification-send`) plus `time-relative-watcher`
 *  routing through the unified watcher slot. */

import { describe, expect, it } from 'vitest';
import { NOTIFICATION_DELIVERY_CHANNELS } from '@recued/contracts';

import { createKernelAdapter } from '../kernel.js';
import { IngredientError, type ResolvedCall } from '../types.js';

const mkCall = (
  slug: string,
  input: Record<string, unknown>,
  stepMeta?: ResolvedCall['stepMeta'],
): ResolvedCall => ({
  slug,
  risk_tier: 'read' as const,
  input,
  output: {},
  ...(stepMeta ? { stepMeta } : {}),
});

describe('kernel adapter — enrichment-upsert', () => {
  it('routes a per-record write to the dispatcher', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      enrichmentUpsert: async (input) => {
        captured = input;
        return { _id: 'enr_1', wrote: true };
      },
    });
    const out = await adapter(mkCall('enrichment-upsert', {
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      id: 'bob@x.com',
      value: { interaction_count: 1 },
      authored_by_recipe_id: 'r1',
    }));
    expect(out).toEqual({ _id: 'enr_1', wrote: true });
    expect(captured).toMatchObject({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      id: 'bob@x.com',
    });
  });

  it('routes a derived-entity write (no scope)', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      enrichmentUpsert: async (input) => { captured = input; return { _id: 'cluster_1', wrote: true }; },
    });
    await adapter(mkCall('enrichment-upsert', {
      topic: 'topic_cluster',
      id: 'cluster_1',
      value: { members: ['msg-1'] },
      authored_by_recipe_id: 'r1',
    }));
    expect(captured).toMatchObject({ topic: 'topic_cluster', id: 'cluster_1' });
    expect((captured as { scope?: unknown }).scope).toBeUndefined();
  });

  it('rejects missing topic', async () => {
    const adapter = createKernelAdapter({
      enrichmentUpsert: async () => ({ _id: 'x', wrote: true }),
    });
    await expect(adapter(mkCall('enrichment-upsert', {
      id: 'x', value: {}, authored_by_recipe_id: 'r',
    }))).rejects.toBeInstanceOf(IngredientError);
  });

  it('SERVER_NOT_REACHABLE without a dispatcher', async () => {
    const adapter = createKernelAdapter({});
    await expect(adapter(mkCall('enrichment-upsert', {
      topic: 'topic_cluster', id: 'a', value: {}, authored_by_recipe_id: 'r',
    }))).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' });
  });
});

describe('kernel adapter — enrichment-list', () => {
  it('forwards filters', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      enrichmentList: async (input) => {
        captured = input;
        return { entries: [], next_cursor: null };
      },
    });
    await adapter(mkCall('enrichment-list', {
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'bob@x.com',
      limit: 25,
    }));
    expect(captured).toMatchObject({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'bob@x.com',
      limit: 25,
    });
  });
});

describe('kernel adapter — mail-get', () => {
  it('routes to the mail-get dispatcher', async () => {
    const adapter = createKernelAdapter({
      mailGet: async ({ slug, record_id }) => ({
        record: { _id: record_id, slug, hot_fields: { received_at: 1 } },
      }),
    });
    const out = await adapter(mkCall('mail-get', { slug: 'gmail', record_id: 'msg-1' }));
    expect(out).toEqual({
      record: { _id: 'msg-1', slug: 'gmail', hot_fields: { received_at: 1 } },
    });
  });

  it('rejects missing record_id', async () => {
    const adapter = createKernelAdapter({
      mailGet: async () => ({ record: null }),
    });
    await expect(adapter(mkCall('mail-get', { slug: 'gmail' })))
      .rejects.toBeInstanceOf(IngredientError);
  });
});

describe('kernel adapter — notification-send', () => {
  it('routes channels + text + link_url to the dispatcher', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      notificationSend: async (input) => {
        captured = input;
        return { delivered_to: ['slack'], failed: [] };
      },
    });
    const out = await adapter(mkCall('notification-send', {
      channels: ['slack'],
      text: 'body',
      link_url: 'https://example.com',
    }));
    expect(out).toEqual({ delivered_to: ['slack'], failed: [] });
    expect(captured).toMatchObject({
      channels: ['slack'],
      text: 'body',
      link_url: 'https://example.com',
    });
  });

  it('filters invalid channel slugs out of the dispatch input', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      notificationSend: async (input) => {
        captured = input;
        return { delivered_to: [], failed: [] };
      },
    });
    await adapter(mkCall('notification-send', {
      channels: ['slack', 'not_a_transport', 'in_app'],
      text: 'hi',
    }));
    expect((captured as { channels: string[] }).channels).toEqual(['slack', 'in_app']);
  });

  it('defaults omitted channels to fanout', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      notificationSend: async (input) => {
        captured = input;
        return { delivered_to: [], failed: [] };
      },
    });
    await adapter(mkCall('notification-send', { text: 'hi' }));
    // Derived: omitting `channels` fans out to EVERY delivery channel, so the
    // expectation is the registry itself. Hand-listing it meant a newly declared
    // vendor silently changed the default fan-out with nothing asserting the shape.
    expect((captured as { channels: string[] }).channels).toEqual([
      ...NOTIFICATION_DELIVERY_CHANNELS,
    ]);
  });

  it('rejects when no valid channels remain', async () => {
    const adapter = createKernelAdapter({
      notificationSend: async () => ({ delivered_to: [], failed: [] }),
    });
    await expect(adapter(mkCall('notification-send', {
      channels: ['not_a_transport'],
      text: 'hi',
    }))).rejects.toBeInstanceOf(IngredientError);
  });
});

describe('kernel adapter — time-relative-watcher routing', () => {
  it('routes through the unified watcher slot with the engine-owned recipe id', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      watcher: async (input) => {
        captured = input;
        return { should_run: false };
      },
    });
    await adapter(mkCall('time-relative-watcher', {
      collection: 'data.calendar',
      anchor_field: 'start_at',
      offsets: ['-1h'],
    }, { step_id: 'watch', recipe_id: 'r1' }));
    expect((captured as { slug: string }).slug).toBe('time-relative-watcher');
    expect((captured as { args: { offsets: string[]; recipe_id: string } }).args)
      .toMatchObject({ offsets: ['-1h'], recipe_id: 'r1' });
  });

  it('does not let authored input override the engine-owned recipe id', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      watcher: async (input) => {
        captured = input;
        return { should_run: false };
      },
    });
    await adapter(mkCall('time-relative-watcher', {
      collection: 'data.task',
      anchor_field: 'due_at',
      offsets: ['0s'],
      recipe_id: 'spoofed-recipe',
    }, { step_id: 'due', recipe_id: 'reminder-due-notifier' }));
    expect((captured as { args: { recipe_id: string } }).args.recipe_id)
      .toBe('reminder-due-notifier');
  });
});
