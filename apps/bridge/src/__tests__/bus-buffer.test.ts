/** D-169 P2 Slice 1/2 — regression coverage for the SW bus buffer
 *  (`realtime/bus-buffer.ts`).
 *
 *  Locks in: newest-first + per-section cap; the notify synth-id
 *  (`notify:<cursor>`); the ask upsert-by-`ask_id` dedup + `ask_closed`
 *  removal; the execution upsert-by-`run_id` dedup with only terminal
 *  transitions landing a row; unhandled kinds are a no-op; `seed` is an
 *  authoritative capped replace; `reset` clears. */

import { describe, it, expect } from 'vitest';
import type { ServerEvent } from '@recued/contracts';
import { createBridgeBusBuffer, BRIDGE_BUS_BUFFER_CAP } from '../realtime/bus-buffer.js';

const FIXED_NOW = 1_700_000_000_000;
const makeBuffer = (cap?: number) =>
  createBridgeBusBuffer({ now: () => FIXED_NOW, ...(cap !== undefined ? { cap } : {}) });

// Typed event factories (avoid `title: undefined` — exactOptionalPropertyTypes).
const notify = (cursor: number, text: string, title?: string): ServerEvent => ({
  kind: 'notification.notify',
  ...(title !== undefined ? { title } : {}),
  text,
  cursor,
});
const ask = (cursor: number, ask_id: string, text: string): ServerEvent => ({
  kind: 'notification.ask',
  ask_id,
  text,
  options: [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' },
  ],
  cursor,
});
const askClosed = (cursor: number, ask_id: string): ServerEvent => ({
  kind: 'notification.ask_closed',
  ask_id,
  cursor,
});
const execution = (
  cursor: number,
  run_id: string,
  op: 'start' | 'progress' | 'complete' | 'error',
  recipe_id = 'recipe-x',
): ServerEvent => ({ kind: 'execution', recipe_id, run_id, op, cursor });

describe('bus buffer — notifications (LOG section)', () => {
  it('prepends newest-first with a synth id + receipt stamp', () => {
    const buf = makeBuffer();
    buf.apply(notify(1, 'first', 'Title A'));
    buf.apply(notify(2, 'second'));
    const { notifications } = buf.snapshot();
    expect(notifications).toHaveLength(2);
    expect(notifications[0]).toEqual({ id: 'notify:2', text: 'second', fired_at: FIXED_NOW });
    expect(notifications[1]).toEqual({
      id: 'notify:1',
      title: 'Title A',
      text: 'first',
      fired_at: FIXED_NOW,
    });
  });

  it('omits the title key entirely when the event has no title', () => {
    const buf = makeBuffer();
    buf.apply(notify(1, 'no title'));
    expect('title' in buf.snapshot().notifications[0]).toBe(false);
  });

  it('caps the section, dropping the oldest', () => {
    const buf = makeBuffer(3);
    for (let c = 1; c <= 5; c += 1) buf.apply(notify(c, `n${c}`));
    const { notifications } = buf.snapshot();
    expect(notifications).toHaveLength(3);
    expect(notifications.map((n) => n.id)).toEqual(['notify:5', 'notify:4', 'notify:3']);
  });
});

describe('bus buffer — approvals (SET section keyed by ask_id)', () => {
  it('upserts by ask_id (dedups at-least-once re-delivery), newest-first', () => {
    const buf = makeBuffer();
    buf.apply(ask(1, 'a1', 'first ask'));
    buf.apply(ask(2, 'a2', 'second ask'));
    buf.apply(ask(3, 'a1', 'first ask re-delivered')); // same id → upsert to top
    const { approvals } = buf.snapshot();
    expect(approvals.map((a) => a.ask_id)).toEqual(['a1', 'a2']);
    expect(approvals[0]).toMatchObject({ ask_id: 'a1', text: 'first ask re-delivered' });
  });

  it('removes an ask on ask_closed and is a no-op for an unknown id', () => {
    const buf = makeBuffer();
    buf.apply(ask(1, 'a1', 'ask one'));
    buf.apply(ask(2, 'a2', 'ask two'));
    buf.apply(askClosed(3, 'a1'));
    expect(buf.snapshot().approvals.map((a) => a.ask_id)).toEqual(['a2']);
    buf.apply(askClosed(4, 'nope')); // unknown → no-op
    expect(buf.snapshot().approvals.map((a) => a.ask_id)).toEqual(['a2']);
  });
});

describe('bus buffer — recipe results (execution terminal only)', () => {
  it('lands a row only on terminal complete/error, never start/progress', () => {
    const buf = makeBuffer();
    buf.apply(execution(1, 'run1', 'start'));
    buf.apply(execution(2, 'run1', 'progress'));
    expect(buf.snapshot().recipe_results).toHaveLength(0);
    buf.apply(execution(3, 'run1', 'complete'));
    expect(buf.snapshot().recipe_results).toEqual([
      {
        run_id: 'run1',
        recipe_id: 'recipe-x',
        status: 'ok',
        started_at: FIXED_NOW,
        duration_ms: null,
      },
    ]);
  });

  it('maps error → status error', () => {
    const buf = makeBuffer();
    buf.apply(execution(1, 'run2', 'error'));
    expect(buf.snapshot().recipe_results[0]).toMatchObject({ run_id: 'run2', status: 'error' });
  });

  it('upserts by run_id (dedups a terminal event that crosses the rpc seed)', () => {
    const buf = makeBuffer();
    buf.apply(execution(1, 'run1', 'complete'));
    buf.apply(execution(2, 'run2', 'error'));
    buf.apply(execution(3, 'run1', 'complete')); // same run_id → dedup to top
    expect(buf.snapshot().recipe_results.map((r) => r.run_id)).toEqual(['run1', 'run2']);
  });
});

describe('bus buffer — unhandled kinds, seed, reset', () => {
  it('is a no-op for a subscribed-but-unhandled kind', () => {
    const buf = makeBuffer();
    buf.apply({ kind: 'schedule', op: 'updated', cursor: 1 } as ServerEvent);
    const snap = buf.snapshot();
    expect(snap.recipe_results).toHaveLength(0);
    expect(snap.notifications).toHaveLength(0);
    expect(snap.approvals).toHaveLength(0);
  });

  it('seed authoritatively REPLACES all three sections (capped, un-aliased)', () => {
    const buf = makeBuffer(2);
    buf.apply(notify(1, 'live'));
    const seededNotifs = [
      { id: 'notify:9', text: 'seed a', fired_at: 1 },
      { id: 'notify:8', text: 'seed b', fired_at: 2 },
      { id: 'notify:7', text: 'seed c', fired_at: 3 },
    ];
    buf.seed({ recipe_results: [], notifications: seededNotifs, approvals: [] });
    const { notifications } = buf.snapshot();
    expect(notifications.map((n) => n.id)).toEqual(['notify:9', 'notify:8']); // replaced + capped
    // Mutating the caller's array must not leak into the buffer.
    seededNotifs.push({ id: 'notify:6', text: 'late', fired_at: 4 });
    expect(buf.snapshot().notifications).toHaveLength(2);
  });

  it('reset clears every section', () => {
    const buf = makeBuffer();
    buf.apply(notify(1, 'n'));
    buf.apply(ask(2, 'a1', 'a'));
    buf.apply(execution(3, 'run1', 'complete'));
    buf.reset();
    const snap = buf.snapshot();
    expect(snap.notifications).toHaveLength(0);
    expect(snap.approvals).toHaveLength(0);
    expect(snap.recipe_results).toHaveLength(0);
  });

  it('exposes the documented default cap', () => {
    expect(BRIDGE_BUS_BUFFER_CAP).toBe(50);
  });
});
