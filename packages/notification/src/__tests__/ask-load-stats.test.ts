/** `askLoadStats` — the λ×W approval-load readout behind `system.status`'s
 *  `ask_load` field.
 *
 *  The window is `HANDLED_ASK_RETENTION_MS` by construction (any longer would
 *  be silently incomplete once the prune runs); `raised` counts arrivals in
 *  the window; the median is over answer latencies of answers that LANDED in
 *  the window; `load` = (raised / window_ms) × median. Answered-only — W is
 *  right-censored while asks sit open, which the caller renders
 *  `pending_asks` beside. */

import { createInMemoryCollection } from '@recued/storage';
import { describe, expect, it } from 'vitest';
import {
  HANDLED_ASK_RETENTION_MS,
  createAskStore,
  createNotificationBlock,
  createNotificationSettingsStore,
  createUiChannel,
  type AskStore,
  type NewPendingAsk,
  type NotificationSettings,
  type PendingAsk,
} from '../index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const newAsk = (ask_id: string, created_at: number): NewPendingAsk => ({
  ask_id,
  created_at,
  message: { title: 't', text: 'x', link_url: '/a' },
  options: [{ id: 'ok', label: 'OK' }],
  handler_kind: 'gateway.preflight',
  handler_payload: { checkpoint_id: 'c' },
  fanout_channels: ['ui'],
});

const harness = async (now: number) => {
  const store: AskStore = createAskStore(createInMemoryCollection<PendingAsk>());
  const block = createNotificationBlock({
    askStore: store,
    channels: [createUiChannel({ busSink: () => undefined })],
    settingsStore: createNotificationSettingsStore(
      createInMemoryCollection<NotificationSettings>(),
    ),
    now: () => now,
    mintAskId: () => 'unused',
  });
  return { store, block };
};

describe('askLoadStats', () => {
  const NOW = 100 * DAY_MS;

  it('empty store → zero raised, null median, null load, the retention window', async () => {
    const { block } = await harness(NOW);
    await expect(block.askLoadStats()).resolves.toEqual({
      window_ms: HANDLED_ASK_RETENTION_MS,
      raised: 0,
      answered_sample: 0,
      median_answer_ms: null,
      load: null,
    });
  });

  it('counts arrivals in the window, medians answers landing in it, and multiplies', async () => {
    const { store, block } = await harness(NOW);
    // Three raised in-window; two answered (latencies 2h and 4h → median 3h);
    // one still open (right-censored — must NOT enter the median).
    await store.create(newAsk('a1', NOW - 3 * DAY_MS));
    await store.recordAnswer(
      'a1',
      { option: 'ok', answered_at: NOW - 3 * DAY_MS + 2 * 60 * 60 * 1000 },
      'ui',
    );
    await store.create(newAsk('a2', NOW - 2 * DAY_MS));
    await store.recordAnswer(
      'a2',
      { option: 'ok', answered_at: NOW - 2 * DAY_MS + 4 * 60 * 60 * 1000 },
      'ui',
    );
    await store.create(newAsk('a3', NOW - DAY_MS)); // open

    const stats = await block.askLoadStats();
    expect(stats.raised).toBe(3);
    expect(stats.answered_sample).toBe(2);
    expect(stats.median_answer_ms).toBe(3 * 60 * 60 * 1000);
    expect(stats.load).toBeCloseTo(
      (3 / HANDLED_ASK_RETENTION_MS) * 3 * 60 * 60 * 1000,
      10,
    );
  });

  it('an ask raised BEFORE the window whose answer lands IN it feeds the median, not raised', async () => {
    const { store, block } = await harness(NOW);
    const before = NOW - HANDLED_ASK_RETENTION_MS - 2 * DAY_MS;
    await store.create(newAsk('old', before));
    await store.recordAnswer(
      'old',
      { option: 'ok', answered_at: NOW - DAY_MS },
      'ui',
    );
    const stats = await block.askLoadStats();
    expect(stats.raised).toBe(0);
    expect(stats.answered_sample).toBe(1);
    // Latency measured from creation — a long-ignored ask reports honestly long.
    expect(stats.median_answer_ms).toBe(NOW - DAY_MS - before);
    // λ = 0 in-window arrivals ⇒ zero load even though a median exists.
    expect(stats.load).toBe(0);
  });

  it('a cancelled ask counts toward raised and never toward the median', async () => {
    const { store, block } = await harness(NOW);
    await store.create(newAsk('c1', NOW - DAY_MS));
    await expect(store.cancel('c1')).resolves.toBe('cancelled');
    const stats = await block.askLoadStats();
    expect(stats.raised).toBe(1);
    expect(stats.answered_sample).toBe(0);
    expect(stats.median_answer_ms).toBeNull();
    expect(stats.load).toBeNull();
  });

  it('even-count median averages the middle pair', async () => {
    const { store, block } = await harness(NOW);
    const latencies = [1000, 2000, 5000, 9000]; // median (2000+5000)/2 = 3500
    for (const [i, ms] of latencies.entries()) {
      const created = NOW - DAY_MS - i * 1000;
      await store.create(newAsk(`e${i}`, created));
      await store.recordAnswer(
        `e${i}`,
        { option: 'ok', answered_at: created + ms },
        'ui',
      );
    }
    const stats = await block.askLoadStats();
    expect(stats.answered_sample).toBe(4);
    expect(stats.median_answer_ms).toBe(3500);
  });
});
