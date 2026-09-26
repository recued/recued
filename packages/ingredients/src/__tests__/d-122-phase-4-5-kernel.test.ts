/** D-122 Phase 4.5 — kernel adapter dispatch tests for the four new
 *  ingredient slugs (`enrichment-upsert`, `enrichment-list`,
 *  `mail-get`, `notification-send`) plus `time-relative-watcher`
 *  routing through the unified watcher slot. */

import { describe, expect, it } from 'vitest';

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

  // D-312 — this dropped the name and sent to the rest. A channel list is the
  // owner's setting now, so a dropped name is one they believe it went to.
  it('refuses a name that is no channel, by name, where it used to drop it', async () => {
    let calls = 0;
    const adapter = createKernelAdapter({
      notificationSend: async () => {
        calls += 1;
        return { delivered_to: [], failed: [] };
      },
    });
    await expect(adapter(mkCall('notification-send', {
      channels: ['slack', 'not_a_transport', 'in_app'],
      text: 'hi',
    }))).rejects.toThrow(/"not_a_transport" is not a channel/);
    expect(calls).toBe(0);
  });

  it('reads a list setting\'s names as the owner wrote them', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      notificationSend: async (input) => {
        captured = input;
        return { delivered_to: [], failed: [] };
      },
    });
    // What the server hands on from a settings box that said "Slack, In-App, slack".
    await adapter(mkCall('notification-send', { channels: ['Slack', 'In-App', 'slack'], text: 'hi' }));
    expect(captured).toEqual({ channels: ['slack', 'in_app'], text: 'hi' });
  });

  // ⛔ D-312 — no channels is NO PREFERENCE, and the server has to receive it as
  // that. Filling in every channel here made "all you set up" look like "these,
  // by name", so each channel the owner never set up came back as a failure.
  it.each([
    ['omitted', { text: 'hi' }],
    ['a null the recipe wrote', { channels: null, text: 'hi' }],
    // What an unset setting delivers: `{{config.channels}}` resolves the key to undefined.
    ['a setting never filled in', { channels: undefined, text: 'hi' }],
    // The settings box saves text, so one emptied again is "".
    ['a setting emptied again', { channels: '', text: 'hi' }],
    ['blank text', { channels: '  ', text: 'hi' }],
  ])('dispatches no channels when they are %s, so the server fans out', async (_label, stepInput) => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      notificationSend: async (input) => {
        captured = input;
        return { delivered_to: [], failed: [] };
      },
    });
    await adapter(mkCall('notification-send', stepInput));
    expect(captured).toEqual({ text: 'hi' });
    expect(captured).not.toHaveProperty('channels');
  });

  it('⛔ reads a setting typed into its box as the list it spells', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      notificationSend: async (input) => {
        captured = input;
        return { delivered_to: [], failed: [] };
      },
    });
    await adapter(mkCall('notification-send', { channels: 'Slack, in-app; email, slack', text: 'hi' }));
    expect(captured).toEqual({ channels: ['slack', 'in_app', 'email'], text: 'hi' });
  });

  it('⛔ refuses a typed name that is no channel, by name, and sends nothing', async () => {
    let calls = 0;
    const adapter = createKernelAdapter({
      notificationSend: async () => {
        calls += 1;
        return { delivered_to: [], failed: [] };
      },
    });
    // Sending to Slack alone would leave the owner sure it went by email too.
    const refused = await adapter(mkCall('notification-send', { channels: 'slack, emial', text: 'hi' }))
      .then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(IngredientError);
    const message = (refused as Error).message;
    expect(message).toMatch(/"emial" is not a channel\./);
    // The names to use, spelled as an owner types them.
    expect(message).toMatch(/Use .*\bemail\b.*\bin-app\b/);
    expect(message).toMatch(/or leave it out for every channel you have set up$/);
    expect(calls).toBe(0);
  });

  // Names typed with spaces where commas were meant. The box's help asks for
  // commas; the channel names are a list that can tell one name from two.
  it.each([
    ['as text', 'slack email'],
    ['in a list a box saved before the checkboxes', ['slack email']],
  ])('⛔ reads `slack email` %s as the two channels it names', async (_label, channels) => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      notificationSend: async (input) => {
        captured = input;
        return { delivered_to: [], failed: [] };
      },
    });
    await adapter(mkCall('notification-send', { channels, text: 'hi' }));
    expect(captured).toEqual({ channels: ['slack', 'email'], text: 'hi' });
  });

  it('still refuses names typed with spaces when one of them is no channel, by the whole name', async () => {
    const adapter = createKernelAdapter({
      notificationSend: async () => ({ delivered_to: [], failed: [] }),
    });
    await expect(adapter(mkCall('notification-send', { channels: 'slack emial', text: 'hi' })))
      .rejects.toThrow(/"slack emial" is not a channel\./);
  });

  it('still refuses an empty list: it names no channel, which is not "any"', async () => {
    const adapter = createKernelAdapter({
      notificationSend: async () => ({ delivered_to: [], failed: [] }),
    });
    await expect(adapter(mkCall('notification-send', { channels: [], text: 'hi' })))
      .rejects.toBeInstanceOf(IngredientError);
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

  it('refuses a list item that is not a name at all', async () => {
    const adapter = createKernelAdapter({
      notificationSend: async () => ({ delivered_to: [], failed: [] }),
    });
    await expect(adapter(mkCall('notification-send', { channels: ['slack', 7], text: 'hi' })))
      .rejects.toThrow(/"7" is not a channel/);
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
