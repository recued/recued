/** Phase G (D-109) — activity label resolution.
 *
 *  `ACTIVITY_LABELS` is the source of truth for every known action
 *  code's human-readable label. The Feed tab reads it on every row
 *  render, so coverage here matters — a missing label would render
 *  a blank cell instead of graceful-degrading. */

import { describe, expect, it } from 'vitest';
import { ACTIVITY_LABELS, resolveActivityLabel } from '../activity-labels.js';

describe('ACTIVITY_LABELS', () => {
  it('covers every Phase A–G code shipped so far', () => {
    const expected = [
      // Core lifecycle
      'install',
      'uninstall',
      'vault_set',
      'vault_clear',
      'approval_allow',
      'approval_deny',
      'schedule_create',
      'schedule_update',
      'schedule_delete',
      // Phase A
      'shared_write',
      'pressure_state_change',
      'crash_halt_toggle',
      'account_mismatch_rejected',
      // Phase B
      'pressure_eviction_run',
      'audit_retention_prune',
      // Phase C
      'server_boot',
      'server_shutdown',
      'server_restart',
      'server_crashed',
      'drain_started',
      'drain_completed',
      'drain_aborted',
      'crash_loop_detected',
      'crash_loop_reset',
      'lock_conflict',
      'signal_received',
      'config_hot_reloaded',
      // Phase D
      'collection_sync_start',
      'collection_sync_complete',
      'collection_sync_error',
      'collection_record_created',
      'webhook_received',
      'webhook_rejected_auth',
      // Phase G
      'trigger_fired',
      'trigger_auto_disabled',
      'archive_export_start',
      'archive_export_complete',
      'archive_import_start',
      'archive_import_complete',
      'audit_export',
      // D-178 — release self-update lifecycle
      'update_applied',
      'update_rolled_back',
    ];
    for (const code of expected) {
      expect(ACTIVITY_LABELS).toHaveProperty(code);
      const label = ACTIVITY_LABELS[code as keyof typeof ACTIVITY_LABELS];
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
      expect(label.length).toBeLessThan(50);
    }
  });

  it('every label starts with an uppercase letter', () => {
    for (const label of Object.values(ACTIVITY_LABELS)) {
      expect(label[0]).toMatch(/[A-Z]/);
    }
  });
});

describe('resolveActivityLabel', () => {
  it('returns the known label for a known action', () => {
    expect(resolveActivityLabel('install')).toBe(ACTIVITY_LABELS.install);
    expect(resolveActivityLabel('trigger_fired')).toBe(ACTIVITY_LABELS.trigger_fired);
  });

  it('falls back to title-case for unknown codes', () => {
    expect(resolveActivityLabel('made_up_code')).toBe('Made Up Code');
  });

  it('handles empty string safely', () => {
    expect(resolveActivityLabel('')).toBe('Unknown');
  });

  it('handles single-word unknowns', () => {
    expect(resolveActivityLabel('whatever')).toBe('Whatever');
  });

  it('collapses double underscores without producing double spaces', () => {
    expect(resolveActivityLabel('a__b')).toBe('A B');
  });
});
