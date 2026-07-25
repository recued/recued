/** Supervision feature — the daemon lifecycle → D-120 activity-row adapter.
 *
 *  `buildDaemonAuditEmitter` is the seam the composition root hands the
 *  supervisor as its `audit` callback: it maps a daemon state TRANSITION to one
 *  `ActivityEntry` and writes it fire-and-forget. This pins the state→action
 *  mapping (the queryable action codes consumers filter on), the row shape
 *  (target / detail / activity_id), the unmapped-state skip, and the
 *  never-throw discipline. The supervisor-side emit (which transitions fire, and
 *  the boot-reconciliation suppression) is covered in
 *  supervision-cli-daemon-supervisor.test.ts. */

import { describe, it, expect, vi } from 'vitest';
import type { ActivityEntry, AuditLogStore } from '@recued/storage';
import {
  buildDaemonAuditEmitter,
  STATE_TO_AUDIT_ACTION,
} from '../supervision/compose-supervision-stack.js';
import type { DaemonAuditEvent } from '../supervision/cli-daemon-supervisor.js';

const event = (over: Partial<DaemonAuditEvent> = {}): DaemonAuditEvent => ({
  ingredient_slug: 'cloudflared',
  op: 'tunnel.run_detached',
  state: 'running',
  pid: 4242,
  last_exit_code: null,
  consecutive_crashes: 0,
  at: 1_700_000_000_000,
  ...over,
});

const mockAuditLog = (): { store: AuditLogStore; logActivity: ReturnType<typeof vi.fn> } => {
  const logActivity = vi.fn((_entry: ActivityEntry) => Promise.resolve());
  return { store: { logActivity } as unknown as AuditLogStore, logActivity };
};

describe('buildDaemonAuditEmitter — daemon lifecycle → activity row', () => {
  it('maps each audit-worthy state to its action, target, and timestamp', () => {
    const cases: Array<[DaemonAuditEvent['state'], string]> = [
      ['running', 'supervised_daemon_started'],
      ['crashed', 'supervised_daemon_crashed'],
      ['stopped', 'supervised_daemon_stopped'],
      ['permanently_crashed', 'supervised_daemon_permanently_crashed'],
    ];
    for (const [state, action] of cases) {
      const { store, logActivity } = mockAuditLog();
      buildDaemonAuditEmitter(store)(event({ state }));
      expect(logActivity).toHaveBeenCalledTimes(1);
      const entry = logActivity.mock.calls[0][0] as ActivityEntry;
      expect(entry.action).toBe(action);
      expect(entry.target).toBe('cloudflared/tunnel.run_detached');
      expect(entry.timestamp).toBe(1_700_000_000_000);
      expect(entry.activity_id).toMatch(/^daemon_cloudflared_tunnel\.run_detached_1700000000000_/);
    }
  });

  it('encodes the runtime facts in the JSON detail', () => {
    const { store, logActivity } = mockAuditLog();
    buildDaemonAuditEmitter(store)(
      event({ state: 'crashed', pid: null, last_exit_code: 9, consecutive_crashes: 3 }),
    );
    const entry = logActivity.mock.calls[0][0] as ActivityEntry;
    expect(JSON.parse(entry.detail as string)).toEqual({
      op: 'tunnel.run_detached',
      state: 'crashed',
      pid: null,
      last_exit_code: 9,
      consecutive_crashes: 3,
    });
  });

  it('writes no row for an unmapped state (unknown is initial-only, never a transition target)', () => {
    const { store, logActivity } = mockAuditLog();
    buildDaemonAuditEmitter(store)(event({ state: 'unknown' }));
    expect(logActivity).not.toHaveBeenCalled();
  });

  it('every mapped action is a distinct supervised_daemon_* code', () => {
    const actions = Object.values(STATE_TO_AUDIT_ACTION);
    expect(new Set(actions).size).toBe(actions.length);
    for (const a of actions) expect(a).toMatch(/^supervised_daemon_/);
  });

  it('is fire-and-forget — a rejected write never throws out of the emitter', async () => {
    const logActivity = vi.fn((_entry: ActivityEntry) => Promise.reject(new Error('disk full')));
    const store = { logActivity } as unknown as AuditLogStore;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => buildDaemonAuditEmitter(store)(event())).not.toThrow();
    await Promise.resolve(); // let the .catch microtask run under the spy
    warn.mockRestore();
  });
});
