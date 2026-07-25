/** D-148 P4 — server-side webclient connection registry. */

import { describe, expect, it } from 'vitest';
import {
  createWebclientRegistry,
  type WebclientConnectionRecord,
} from '../webclients/registry.js';

const buildRecord = (
  overrides: Partial<WebclientConnectionRecord> = {},
): WebclientConnectionRecord => ({
  client_token_id: 'tok_1',
  session_id: 'sess_a',
  online_since: 1_000,
  last_seen_at: 1_000,
  ...overrides,
});

describe('D-148 P4 — webclient registry', () => {
  it('attach + get round-trips', () => {
    const reg = createWebclientRegistry();
    reg.attach(buildRecord());
    expect(reg.get('tok_1')?.session_id).toBe('sess_a');
    expect(reg.get('tok_2')).toBeNull();
  });

  it('attach replaces prior entry on reconnect', () => {
    const reg = createWebclientRegistry();
    reg.attach(buildRecord());
    reg.attach(buildRecord({ session_id: 'sess_b', online_since: 2_000, last_seen_at: 2_000 }));
    const cur = reg.get('tok_1');
    expect(cur?.session_id).toBe('sess_b');
    expect(reg.list().length).toBe(1);
  });

  it('detach is idempotent', () => {
    const reg = createWebclientRegistry();
    reg.attach(buildRecord());
    reg.detach('tok_1');
    reg.detach('tok_1');
    expect(reg.list().length).toBe(0);
  });

  it('touch advances last_seen_at', () => {
    const reg = createWebclientRegistry();
    reg.attach(buildRecord());
    reg.touch('tok_1', 5_000);
    expect(reg.get('tok_1')?.last_seen_at).toBe(5_000);
    // Unknown token is a no-op.
    reg.touch('tok_unknown', 9_000);
    expect(reg.list().length).toBe(1);
  });

  it('bySession resolves the active record', () => {
    const reg = createWebclientRegistry();
    reg.attach(buildRecord({ client_token_id: 'tok_1', session_id: 'sess_a' }));
    reg.attach(buildRecord({ client_token_id: 'tok_2', session_id: 'sess_b' }));
    expect(reg.bySession('sess_a')?.client_token_id).toBe('tok_1');
    expect(reg.bySession('sess_b')?.client_token_id).toBe('tok_2');
    expect(reg.bySession('sess_unknown')).toBeNull();
  });

  it('clear wipes everything', () => {
    const reg = createWebclientRegistry();
    reg.attach(buildRecord());
    reg.attach(buildRecord({ client_token_id: 'tok_2', session_id: 'sess_b' }));
    reg.clear();
    expect(reg.list()).toEqual([]);
  });
});
