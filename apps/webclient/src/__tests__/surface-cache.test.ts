/** D-148 P4 — surface snapshot cache TTL discipline. */

import { describe, expect, it } from 'vitest';
import { WEBCLIENT_STATE_SNAPSHOT_TTL_MS } from '@recued/contracts';
import { createSurfaceSnapshotCache } from '../state-snapshot/surface-cache.js';

describe('D-148 P4 — surface snapshot cache', () => {
  it('TTL constant matches the documented 5 min', () => {
    expect(WEBCLIENT_STATE_SNAPSHOT_TTL_MS).toBe(5 * 60 * 1000);
  });

  it('set + get within TTL returns the entry', () => {
    let now = 1_000;
    const cache = createSurfaceSnapshotCache({ now: () => now });
    cache.set({
      surface: 'inbox',
      pending_approvals: [],
      recent_reactive_fires: [],
      cursor: 1,
    });
    const entry = cache.get('inbox');
    expect(entry).not.toBeNull();
    expect(entry?.snapshot.cursor).toBe(1);
    now += 60 * 1000;
    expect(cache.get('inbox')).not.toBeNull();
  });

  it('get past TTL evicts + returns null', () => {
    let now = 1_000;
    const cache = createSurfaceSnapshotCache({ now: () => now });
    cache.set({
      surface: 'settings.connections',
      connections: [],
      cursor: 0,
    });
    now += WEBCLIENT_STATE_SNAPSHOT_TTL_MS + 1;
    expect(cache.get('settings.connections')).toBeNull();
  });

  it('invalidate drops a single surface', () => {
    const cache = createSurfaceSnapshotCache();
    cache.set({ surface: 'inbox', pending_approvals: [], recent_reactive_fires: [], cursor: 0 });
    cache.set({ surface: 'settings.connections', connections: [], cursor: 0 });
    cache.invalidate('inbox');
    expect(cache.get('inbox')).toBeNull();
    expect(cache.get('settings.connections')).not.toBeNull();
  });

  it('clear drops every surface', () => {
    const cache = createSurfaceSnapshotCache();
    cache.set({ surface: 'inbox', pending_approvals: [], recent_reactive_fires: [], cursor: 0 });
    cache.set({ surface: 'settings.connections', connections: [], cursor: 0 });
    cache.clear();
    expect(cache.list()).toEqual([]);
  });

  it('list returns only non-expired entries', () => {
    let now = 1_000;
    const cache = createSurfaceSnapshotCache({ now: () => now });
    cache.set({ surface: 'inbox', pending_approvals: [], recent_reactive_fires: [], cursor: 0 });
    now += WEBCLIENT_STATE_SNAPSHOT_TTL_MS + 1;
    cache.set({ surface: 'settings.connections', connections: [], cursor: 0 });
    const entries = cache.list();
    const surfaces = entries.map((e) => e.surface).sort();
    expect(surfaces).toEqual(['settings.connections']);
  });

  it('get on unknown surface returns null', () => {
    const cache = createSurfaceSnapshotCache();
    expect(cache.get('not-a-surface' as never)).toBeNull();
  });
});
