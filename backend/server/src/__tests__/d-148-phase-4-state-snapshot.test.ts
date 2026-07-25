/** D-148 P4 — server-side state.snapshot dispatcher. */

import { describe, expect, it } from 'vitest';
import {
  WEBCLIENT_SNAPSHOT_SURFACES,
  type WebclientSnapshotSurface,
} from '@recued/contracts';
import {
  StateSnapshotProjectionMissingError,
  StateSnapshotSurfaceUnknownError,
  buildDefaultEmptyProjection,
  createStateSnapshotDispatcher,
} from '../webclients/state-snapshot.js';

describe('D-148 P4 — state.snapshot dispatcher', () => {
  it('rejects unknown surface', async () => {
    const d = createStateSnapshotDispatcher();
    await expect(
      d.dispatch('not-a-surface', { client_token_id: 'tok' }),
    ).rejects.toBeInstanceOf(StateSnapshotSurfaceUnknownError);
  });

  it('rejects unregistered surface', async () => {
    const d = createStateSnapshotDispatcher();
    await expect(
      d.dispatch('inbox', { client_token_id: 'tok' }),
    ).rejects.toBeInstanceOf(StateSnapshotProjectionMissingError);
  });

  it('default empty projection per surface returns inert shape', async () => {
    const d = createStateSnapshotDispatcher();
    for (const s of WEBCLIENT_SNAPSHOT_SURFACES) {
      d.register(s, buildDefaultEmptyProjection(s));
    }
    const inbox = await d.dispatch('inbox', { client_token_id: 'tok' });
    expect(inbox.surface).toBe('inbox');
    if (inbox.surface === 'inbox') {
      expect(inbox.pending_approvals).toEqual([]);
      expect(inbox.recent_reactive_fires).toEqual([]);
      expect(inbox.cursor).toBe(0);
    }
    const exposure = await d.dispatch('settings.exposure', { client_token_id: 'tok' });
    expect(exposure.surface).toBe('settings.exposure');
    if (exposure.surface === 'settings.exposure') {
      expect(exposure.derived_preset_label).toBe('lan_only');
      expect(exposure.resolution.ws).toEqual({ lan: true, public: false });
    }
  });

  it('register replaces prior projection (idempotent)', async () => {
    const d = createStateSnapshotDispatcher();
    d.register('inbox', async () => ({
      surface: 'inbox',
      pending_approvals: [],
      recent_reactive_fires: [],
      cursor: 1,
    }));
    d.register('inbox', async () => ({
      surface: 'inbox',
      pending_approvals: [],
      recent_reactive_fires: [],
      cursor: 99,
    }));
    const out = await d.dispatch('inbox', { client_token_id: 'tok' });
    if (out.surface === 'inbox') {
      expect(out.cursor).toBe(99);
    }
  });

  it('registered() reports current set', () => {
    const d = createStateSnapshotDispatcher();
    expect(d.registered()).toEqual([]);
    d.register('inbox', buildDefaultEmptyProjection('inbox'));
    d.register('settings.connections', buildDefaultEmptyProjection('settings.connections'));
    expect([...d.registered()].sort()).toEqual(['inbox', 'settings.connections']);
  });

  it('threads client_token_id through the projection', async () => {
    let captured = '';
    const d = createStateSnapshotDispatcher();
    d.register('inbox', async (args) => {
      captured = args.client_token_id;
      return {
        surface: 'inbox',
        pending_approvals: [],
        recent_reactive_fires: [],
        cursor: 0,
      };
    });
    await d.dispatch('inbox', { client_token_id: 'tok_xyz' });
    expect(captured).toBe('tok_xyz');
  });
});
