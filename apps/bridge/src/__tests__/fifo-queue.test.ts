/** D-148 P3 — FIFO queue tests.
 *
 *  Covers spec § A.3.2: strict order, max_queue_depth backpressure,
 *  cancellation, pause/resume. */

import { describe, it, expect } from 'vitest';
import {
  BRIDGE_MAX_QUEUE_DEPTH,
  type BridgeCommand,
} from '@recued/contracts';
import { createFifoQueue } from '../queue/fifo-queue.js';

const buildCommand = (id: string): BridgeCommand => ({
  command_id: id,
  recipe_run_id: 'run-1',
  step_id: 'step-1',
  ingredient: {
    slug: 'draft-email-reader-hubspot',
    publisher_id: 'recued-core',
    version: '1.0.0',
    surface_kind: 'reading',
    domain_allowlist: ['*://app.hubspot.com/*'],
    domain_allowlist_signature: 'PUB_SIG',
  },
  action: 'read_dom',
  target_domain_pattern: '*://app.hubspot.com/*',
  args: {},
  expects_output_keys: ['text'],
  timeout_ms: 30_000,
  idempotency_key: `idem-${id}`,
});

describe('D-148 P3 — FIFO queue strict order', () => {
  it('three commands queued execute strictly in order', () => {
    const q = createFifoQueue();
    expect(q.enqueue(buildCommand('a')).ok).toBe(true);
    expect(q.enqueue(buildCommand('b')).ok).toBe(true);
    expect(q.enqueue(buildCommand('c')).ok).toBe(true);
    expect(q.depth()).toBe(3);

    const first = q.dequeue();
    expect(first?.command_id).toBe('a');
    expect(q.dequeue()).toBeNull(); // current_command set; can't dequeue more
    q.complete('a');
    expect(q.dequeue()?.command_id).toBe('b');
    q.complete('b');
    expect(q.dequeue()?.command_id).toBe('c');
  });
});

describe('D-148 P3 — max_queue_depth backpressure', () => {
  it('returns 429-shape outcome when queue full', () => {
    const q = createFifoQueue({ max_depth: 2 });
    expect(q.enqueue(buildCommand('a')).ok).toBe(true);
    expect(q.enqueue(buildCommand('b')).ok).toBe(true);
    const overflow = q.enqueue(buildCommand('c'));
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      expect(overflow.reason).toBe('queue_full');
      expect(overflow.depth).toBe(2);
      expect(overflow.max).toBe(2);
    }
  });

  it('default max is 32 per spec § A.3.2', () => {
    const q = createFifoQueue();
    expect(q.maxDepth()).toBe(BRIDGE_MAX_QUEUE_DEPTH);
  });

  it('33rd attempt against default-bounded queue rejects', () => {
    const q = createFifoQueue();
    for (let i = 0; i < BRIDGE_MAX_QUEUE_DEPTH; i++) {
      expect(q.enqueue(buildCommand(`c${i}`)).ok).toBe(true);
    }
    const overflow = q.enqueue(buildCommand('c33'));
    expect(overflow.ok).toBe(false);
  });
});

describe('D-148 P3 — cancellation flow', () => {
  it('cancel running command returns "running"', () => {
    const q = createFifoQueue();
    q.enqueue(buildCommand('a'));
    q.dequeue();
    expect(q.cancel('a')).toBe('running');
  });

  it('cancel queued command returns "dropped" + removes from queue', () => {
    const q = createFifoQueue();
    q.enqueue(buildCommand('a'));
    q.enqueue(buildCommand('b'));
    expect(q.cancel('b')).toBe('dropped');
    expect(q.depth()).toBe(1);
  });

  it('cancel unknown command returns "unknown"', () => {
    const q = createFifoQueue();
    expect(q.cancel('no-such')).toBe('unknown');
  });
});

describe('D-148 P3 — pause discipline', () => {
  it('paused queue stops handing out new commands', () => {
    const q = createFifoQueue();
    q.enqueue(buildCommand('a'));
    q.setPaused(true);
    expect(q.dequeue()).toBeNull();
    q.setPaused(false);
    expect(q.dequeue()?.command_id).toBe('a');
  });

  it('pause does not cancel queued commands', () => {
    const q = createFifoQueue();
    q.enqueue(buildCommand('a'));
    q.enqueue(buildCommand('b'));
    q.setPaused(true);
    expect(q.depth()).toBe(2);
  });
});

describe('D-148 P3 — clear() wipe', () => {
  it('removes pending but does not clear current_command_id', () => {
    const q = createFifoQueue();
    q.enqueue(buildCommand('a'));
    q.enqueue(buildCommand('b'));
    q.dequeue();
    q.clear();
    expect(q.depth()).toBe(0);
    const state = q.state();
    expect(state.current_command_id).toBe('a');
  });
});
