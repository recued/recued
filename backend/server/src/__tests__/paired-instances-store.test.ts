import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { DEFAULT_INSTANCE_PREFS } from '@recued/contracts';
import { createPairedInstancesStore } from '../paired-instances-store.js';
import type { PairedInstancesStore } from '../paired-instances-store.js';

let db: Database.Database;
let store: PairedInstancesStore;

beforeEach(() => {
  db = new Database(':memory:');
  store = createPairedInstancesStore(db);
});

describe('PairedInstancesStore', () => {
  describe('addOrRefresh', () => {
    it('inserts a new row as active (revoked_at null)', () => {
      const row = store.addOrRefresh({
        instance_id: 'ext-a',
        user_id: 'user-1',
        display_name: 'Laptop',
      });
      expect(row.instance_id).toBe('ext-a');
      expect(row.user_id).toBe('user-1');
      expect(row.display_name).toBe('Laptop');
      expect(row.revoked_at).toBeNull();
      expect(row.added_at).toBeGreaterThan(0);
    });

    it('refreshes display_name on re-register and clears revoked_at', () => {
      store.addOrRefresh({ instance_id: 'ext-a', user_id: 'user-1', display_name: 'Old Name' });
      store.revoke('ext-a');
      expect(store.isRevoked('ext-a')).toBe(true);

      // Re-register with new name
      const refreshed = store.addOrRefresh({
        instance_id: 'ext-a', user_id: 'user-1', display_name: 'New Name',
      });
      expect(refreshed.display_name).toBe('New Name');
      expect(refreshed.revoked_at).toBeNull();
      expect(store.isRevoked('ext-a')).toBe(false);
    });
  });

  describe('listActive / listAll', () => {
    it('listActive excludes revoked rows; listAll includes them', () => {
      store.addOrRefresh({ instance_id: 'ext-a', user_id: 'user-1', display_name: 'A' });
      store.addOrRefresh({ instance_id: 'ext-b', user_id: 'user-1', display_name: 'B' });
      store.addOrRefresh({ instance_id: 'ext-c', user_id: 'user-1', display_name: 'C' });
      store.revoke('ext-b');

      const active = store.listActive('user-1').map((r) => r.instance_id).sort();
      const all = store.listAll('user-1').map((r) => r.instance_id).sort();

      expect(active).toEqual(['ext-a', 'ext-c']);
      expect(all).toEqual(['ext-a', 'ext-b', 'ext-c']);
    });

    it('scopes by user_id', () => {
      store.addOrRefresh({ instance_id: 'a', user_id: 'user-1', display_name: 'A' });
      store.addOrRefresh({ instance_id: 'b', user_id: 'user-2', display_name: 'B' });

      expect(store.listActive('user-1').map((r) => r.instance_id)).toEqual(['a']);
      expect(store.listActive('user-2').map((r) => r.instance_id)).toEqual(['b']);
    });

    it('listAllActive returns active rows across ALL users in added_at order, excluding revoked', () => {
      // Insert OUT of added_at order (b@200, a@100, c@300) with seeded `now`
      // values so the assertion proves ORDER BY added_at ASC (NOT insertion
      // order) WITHOUT a masking .sort(). 'd' is revoked → excluded.
      store.addOrRefresh({ instance_id: 'b', user_id: 'user-2', display_name: 'B', now: 200 });
      store.addOrRefresh({ instance_id: 'a', user_id: 'user-1', display_name: 'A', now: 100 });
      store.addOrRefresh({ instance_id: 'c', user_id: 'user-2', display_name: 'C', now: 300 });
      store.addOrRefresh({ instance_id: 'd', user_id: 'user-1', display_name: 'D', now: 400 });
      store.revoke('d');

      // Cross-user (a@user-1 + b/c@user-2), revoked 'd' excluded, added_at ASC.
      expect(store.listAllActive().map((r) => r.instance_id)).toEqual([
        'a',
        'b',
        'c',
      ]);
    });

    it('empty list for unknown user', () => {
      expect(store.listActive('nobody')).toEqual([]);
      expect(store.listAll('nobody')).toEqual([]);
    });
  });

  describe('revoke', () => {
    it('marks revoked_at and returns the pre-revoke row', () => {
      store.addOrRefresh({ instance_id: 'ext-a', user_id: 'user-1', display_name: 'Laptop' });
      const before = store.revoke('ext-a', 1_700_000_000);
      expect(before).not.toBeNull();
      expect(before!.revoked_at).toBeNull(); // pre-revoke snapshot

      const after = store.get('ext-a');
      expect(after!.revoked_at).toBe(1_700_000_000);
      expect(store.isRevoked('ext-a')).toBe(true);
    });

    it('returns null for unknown instance', () => {
      expect(store.revoke('missing')).toBeNull();
    });
  });

  describe('replace', () => {
    it('revokes old and upserts new in one transaction', () => {
      store.addOrRefresh({ instance_id: 'ext-old', user_id: 'user-1', display_name: 'Old Laptop' });
      const { revoked, added } = store.replace({
        old_instance_id: 'ext-old',
        new_instance_id: 'ext-new',
        user_id: 'user-1',
        new_display_name: 'New Laptop',
        now: 1_700_000_100,
      });

      expect(revoked!.instance_id).toBe('ext-old');
      expect(added.instance_id).toBe('ext-new');
      expect(added.display_name).toBe('New Laptop');
      expect(added.revoked_at).toBeNull();

      expect(store.get('ext-old')!.revoked_at).toBe(1_700_000_100);
      expect(store.isRevoked('ext-new')).toBe(false);
    });

    it('works when old_instance_id does not exist (clean add path)', () => {
      const { revoked, added } = store.replace({
        old_instance_id: 'never-was',
        new_instance_id: 'ext-new',
        user_id: 'user-1',
        new_display_name: 'Fresh',
      });
      expect(revoked).toBeNull();
      expect(added.instance_id).toBe('ext-new');
    });
  });

  describe('revokeAllActive', () => {
    it('returns an empty list when no rows are active', () => {
      expect(store.revokeAllActive()).toEqual([]);
    });

    it('returns the revoked instance_ids and marks every active row revoked', () => {
      store.addOrRefresh({ instance_id: 'ext-a', user_id: 'user-1', display_name: 'A' });
      store.addOrRefresh({ instance_id: 'ext-b', user_id: 'user-1', display_name: 'B' });
      store.addOrRefresh({ instance_id: 'ext-c', user_id: 'user-2', display_name: 'C' });

      const revoked = store.revokeAllActive(1_800_000_000).sort();
      expect(revoked).toEqual(['ext-a', 'ext-b', 'ext-c']);
      // Cross-user-scoped — every user's active rows are flipped (D-148
      // pair-revoke cascade semantics; recover-pair semantics).
      expect(store.listActive('user-1')).toEqual([]);
      expect(store.listActive('user-2')).toEqual([]);
      expect(store.get('ext-a')!.revoked_at).toBe(1_800_000_000);
      expect(store.get('ext-c')!.revoked_at).toBe(1_800_000_000);
    });

    it('does not re-stamp already-revoked rows (idempotent at the boundary)', () => {
      store.addOrRefresh({ instance_id: 'ext-a', user_id: 'user-1', display_name: 'A' });
      store.revoke('ext-a', 1_700_000_000);
      // Second sweep is a no-op against already-revoked rows.
      const second = store.revokeAllActive(1_900_000_000);
      expect(second).toEqual([]);
      // Original revoke timestamp preserved (no double-stamp).
      expect(store.get('ext-a')!.revoked_at).toBe(1_700_000_000);
    });
  });

  describe('isRevoked', () => {
    it('returns false for unknown and active instances', () => {
      expect(store.isRevoked('missing')).toBe(false);
      store.addOrRefresh({ instance_id: 'active', user_id: 'user-1', display_name: 'A' });
      expect(store.isRevoked('active')).toBe(false);
    });

    it('returns true for revoked', () => {
      store.addOrRefresh({ instance_id: 'revoked-ext', user_id: 'user-1', display_name: 'A' });
      store.revoke('revoked-ext');
      expect(store.isRevoked('revoked-ext')).toBe(true);
    });
  });

  describe('persistence', () => {
    it('survives a fresh store over the same db', () => {
      store.addOrRefresh({ instance_id: 'ext-a', user_id: 'user-1', display_name: 'A' });
      const store2 = createPairedInstancesStore(db);
      expect(store2.get('ext-a')!.display_name).toBe('A');
    });
  });

  describe('kind (D-156 P10 — per-device surface)', () => {
    it('round-trips the kind through addOrRefresh / get / listAll', () => {
      store.addOrRefresh({ instance_id: 'br', user_id: 'u', display_name: 'Laptop', kind: 'bridge' });
      store.addOrRefresh({ instance_id: 'wc', user_id: 'u', display_name: 'Phone', kind: 'webclient' });
      store.addOrRefresh({ instance_id: 'cl', user_id: 'u', display_name: 'Server', kind: 'cli' });
      expect(store.get('br')!.kind).toBe('bridge');
      expect(store.get('wc')!.kind).toBe('webclient');
      expect(store.get('cl')!.kind).toBe('cli');
      const byId = Object.fromEntries(store.listAll('u').map((r) => [r.instance_id, r.kind]));
      expect(byId).toEqual({ br: 'bridge', wc: 'webclient', cl: 'cli' });
    });

    it('defaults to webclient when no kind is supplied (legacy / db-less register)', () => {
      store.addOrRefresh({ instance_id: 'no-kind', user_id: 'u', display_name: 'A' });
      expect(store.get('no-kind')!.kind).toBe('webclient');
    });

    it('a kind-less refresh PRESERVES a previously-recorded kind (COALESCE)', () => {
      store.addOrRefresh({ instance_id: 'br', user_id: 'u', display_name: 'A', kind: 'bridge' });
      // Re-register without a kind (e.g. a legacy register path) must not
      // clobber the recorded 'bridge' back to the default.
      store.addOrRefresh({ instance_id: 'br', user_id: 'u', display_name: 'A2' });
      expect(store.get('br')!.kind).toBe('bridge');
    });

    it('a kind-bearing refresh UPDATES the recorded kind', () => {
      store.addOrRefresh({ instance_id: 'x', user_id: 'u', display_name: 'A' });
      expect(store.get('x')!.kind).toBe('webclient');
      store.addOrRefresh({ instance_id: 'x', user_id: 'u', display_name: 'A', kind: 'bridge' });
      expect(store.get('x')!.kind).toBe('bridge');
    });

    it('replace carries new_kind onto the upserted row', () => {
      store.addOrRefresh({ instance_id: 'old', user_id: 'u', display_name: 'Old', kind: 'webclient' });
      const { added } = store.replace({
        old_instance_id: 'old',
        new_instance_id: 'new',
        user_id: 'u',
        new_display_name: 'New',
        new_kind: 'bridge',
      });
      expect(added.kind).toBe('bridge');
      expect(store.get('new')!.kind).toBe('bridge');
    });

    it('legacy rows with no kind column value resolve to webclient', () => {
      // Simulate a pre-migration row: write directly without the kind col,
      // then read through a fresh store (which runs the additive ALTER).
      db.prepare(
        `INSERT INTO paired_instances (instance_id, user_id, display_name, added_at, revoked_at) VALUES (?, ?, ?, ?, NULL)`,
      ).run('legacy', 'u', 'Legacy', 1_900_000);
      const store2 = createPairedInstancesStore(db);
      expect(store2.get('legacy')!.kind).toBe('webclient');
    });
  });

  describe('prefs (pair-scoped, pair-rpc/storage path)', () => {
    beforeEach(() => {
      store.addOrRefresh({ instance_id: 'ext-a', user_id: 'u', display_name: 'A' });
    });

    it('getPrefs returns defaults for a fresh row (null preferences col)', () => {
      expect(store.getPrefs('ext-a')).toEqual(DEFAULT_INSTANCE_PREFS);
    });

    it('getPrefs for an unknown instance returns defaults too', () => {
      expect(store.getPrefs('ext-unknown')).toEqual(DEFAULT_INSTANCE_PREFS);
    });

    it('setPrefs persists the patched value and getPrefs reads it back', () => {
      store.setPrefs('ext-a', { 'cache.sync_l2': false });
      expect(store.getPrefs('ext-a')['cache.sync_l2']).toBe(false);
    });

    it('setPrefs is additive — unspecified keys retain their previous value', () => {
      store.setPrefs('ext-a', { 'cache.sync_l2': false });
      store.setPrefs('ext-a', {});
      expect(store.getPrefs('ext-a')['cache.sync_l2']).toBe(false);
    });

    it('setPrefs on an unknown instance drops the patch (no orphan row)', () => {
      store.setPrefs('ext-ghost', { 'cache.sync_l2': false });
      expect(store.get('ext-ghost')).toBeNull();
    });

    it('addOrRefresh after a revoke keeps the preserved row\'s preferences', () => {
      store.setPrefs('ext-a', { 'cache.sync_l2': false });
      // Re-register (e.g. reconnect) — should NOT clobber preferences.
      store.addOrRefresh({ instance_id: 'ext-a', user_id: 'u', display_name: 'A2' });
      expect(store.getPrefs('ext-a')['cache.sync_l2']).toBe(false);
    });
  });
});
