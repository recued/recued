/** D-322 §22 — recovery clears old probe diagnostics without losing capability metadata. */
import { describe, expect, it } from 'vitest';
import { foldConnectionDispatchHealth } from '../connection.js';

describe('connection dispatch health', () => {
  it('recovers from a 403 without keeping the old refusal alongside a fresh success', () => {
    const health = foldConnectionDispatchHealth({ status: 'auth_failed', last_probed_at: 10,
      last_error: 'http_status_403', tools: ['lookup'] }, 'ok', 20);
    expect(health).toEqual({ status: 'ok', last_probed_at: 20, tools: ['lookup'] });
    expect(JSON.stringify(health)).not.toContain('403');
  });
  it('replaces the prior reason on a new failure and leaves call failures unobserved', () => {
    expect(foldConnectionDispatchHealth({ status: 'auth_failed', last_error: 'old refusal' }, 'unreachable', 30, 'network unavailable'))
      .toEqual({ status: 'unreachable', last_probed_at: 30, last_error: 'network unavailable' });
    expect(foldConnectionDispatchHealth({ status: 'ok', last_probed_at: 20 }, 'call_failed', 30)).toBeNull();
  });
});
