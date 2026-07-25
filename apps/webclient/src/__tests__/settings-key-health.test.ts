/** D-148 P4 — settings: key health rendering. */

import { describe, expect, it } from 'vitest';
import type { KeyClass, KeyHealthBundle } from '@recued/contracts';
import { KEY_HEALTH_STATUS_ORDER, buildKeyHealthRows } from '../settings/key-health.js';

describe('D-148 P4 — settings.key_health', () => {
  it('exposes the documented status ordering', () => {
    expect(KEY_HEALTH_STATUS_ORDER).toEqual(['overdue', 'warning', 'healthy']);
  });

  it('builds rows + sorts by severity then class', () => {
    const bundle: Partial<Record<KeyClass, KeyHealthBundle[KeyClass]>> = {
      master_dek: { status: 'healthy', last_rotated_at: 1 },
      server_identity_key: { status: 'overdue', last_rotated_at: 2, expiry_warning: true },
      tls_private_key: { status: 'warning', last_rotated_at: 3 },
      webclient_token: { status: 'healthy', last_rotated_at: 4 },
    };
    const rows = buildKeyHealthRows(bundle as KeyHealthBundle);
    expect(rows.map((r) => r.status)).toEqual(['overdue', 'warning', 'healthy', 'healthy']);
    // Within healthy, alphabetical by class id.
    const healthyClasses = rows.filter((r) => r.status === 'healthy').map((r) => r.key_class);
    expect(healthyClasses).toEqual([...healthyClasses].sort());
  });

  it('drops malformed entries silently', () => {
    const rows = buildKeyHealthRows({
      master_dek: { status: 'healthy' },
      bogus: 'not-a-shape',
    } as unknown as KeyHealthBundle);
    expect(rows.length).toBe(1);
    expect(rows[0].key_class).toBe('master_dek');
  });

  it('threads the optional flags through', () => {
    const rows = buildKeyHealthRows({
      master_dek: { status: 'overdue', expiry_warning: true, compromise_alert: true },
    } as KeyHealthBundle);
    expect(rows[0].expiry_warning).toBe(true);
    expect(rows[0].compromise_alert).toBe(true);
  });
});
