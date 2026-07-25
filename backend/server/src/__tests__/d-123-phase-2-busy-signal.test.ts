/** D-123 Phase 2 — Engine busy-signal tests. */

import { describe, expect, it } from 'vitest';

import {
  createEngineBusySignal,
} from '../housekeeping/engine-busy-signal.js';
import type { CollectionInstanceRecord, CollectionInstanceStore } from '../collections/instance-store.js';

const NOW = 1_700_000_000_000;

const fakeStore = (
  records: ReadonlyArray<Pick<CollectionInstanceRecord, 'platform' | 'backfill_complete'>>,
): CollectionInstanceStore => ({
  list: () => records as CollectionInstanceRecord[],
  // The other methods aren't called by the busy signal — keep stubbed.
  get: () => undefined,
  upsert: () => {
    throw new Error('not implemented in fixture');
  },
  delete: () => undefined,
  markBackfillComplete: () => undefined,
}) as unknown as CollectionInstanceStore;

describe('createEngineBusySignal', () => {
  it('reports not busy on a fresh server with no instances', () => {
    const signal = createEngineBusySignal({ instances: fakeStore([]) });
    expect(signal.isExecuting()).toBe(false);
    expect(signal.isDraining()).toBe(false);
    expect(signal.isBusy()).toBe(false);
  });

  it('reports executing when autoRun.inFlight is true', () => {
    const signal = createEngineBusySignal({
      instances: fakeStore([]),
      autoRun: { inFlight: () => true },
    });
    expect(signal.isExecuting()).toBe(true);
    expect(signal.isBusy()).toBe(true);
  });

  it('reports draining when any draining-platform instance has backfill_complete=false', () => {
    const signal = createEngineBusySignal({
      instances: fakeStore([
        { platform: 'mail', backfill_complete: false },
        { platform: 'calendar', backfill_complete: true },
      ]),
    });
    expect(signal.isDraining()).toBe(true);
    expect(signal.isBusy()).toBe(true);
  });

  it('ignores non-draining platforms (webhook / service)', () => {
    const signal = createEngineBusySignal({
      instances: fakeStore([
        { platform: 'webhook', backfill_complete: false },
        { platform: 'service', backfill_complete: false },
      ]),
    });
    expect(signal.isDraining()).toBe(false);
  });

  it('reports not busy when all draining instances have completed', () => {
    const signal = createEngineBusySignal({
      instances: fakeStore([
        { platform: 'mail', backfill_complete: true },
        { platform: 'calendar', backfill_complete: true },
        { platform: 'file', backfill_complete: true },
      ]),
    });
    expect(signal.isDraining()).toBe(false);
    expect(signal.isBusy()).toBe(false);
  });

  it('records lastIdleTransitionAt when busy → idle', () => {
    let executing = true;
    const signal = createEngineBusySignal({
      instances: fakeStore([]),
      autoRun: { inFlight: () => executing },
    });
    signal.poll(NOW);
    expect(signal.lastIdleTransitionAt()).toBeNull();
    executing = false;
    signal.poll(NOW + 5_000);
    expect(signal.lastIdleTransitionAt()).toBe(NOW + 5_000);
  });

  it('does not advance lastIdleTransitionAt while continuously idle', () => {
    let executing = false;
    const signal = createEngineBusySignal({
      instances: fakeStore([]),
      autoRun: { inFlight: () => executing },
    });
    signal.poll(NOW);
    signal.poll(NOW + 60_000);
    expect(signal.lastIdleTransitionAt()).toBeNull();
    executing = true;
    signal.poll(NOW + 120_000);
    executing = false;
    signal.poll(NOW + 180_000);
    expect(signal.lastIdleTransitionAt()).toBe(NOW + 180_000);
  });
});
