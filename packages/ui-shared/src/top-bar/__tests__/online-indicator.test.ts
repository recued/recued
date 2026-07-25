/** D-119 Phase 3 — online-indicator threshold tests. */

import { describe, expect, it } from 'vitest';
import {
  computeOnlineIndicator,
  ONLINE_INDICATOR_THRESHOLDS_MS,
  renderOnlineDot,
} from '../online-indicator.js';

describe('computeOnlineIndicator', () => {
  const NOW = 1_700_000_000_000;

  it('returns gray when lastSeenMs is null', () => {
    expect(computeOnlineIndicator(null, NOW)).toBe('gray');
  });

  it('returns gray when lastSeenMs is undefined', () => {
    expect(computeOnlineIndicator(undefined, NOW)).toBe('gray');
  });

  it('returns green inside the 90s window', () => {
    expect(computeOnlineIndicator(NOW - 0, NOW)).toBe('green');
    expect(computeOnlineIndicator(NOW - 30_000, NOW)).toBe('green');
    expect(computeOnlineIndicator(NOW - 89_999, NOW)).toBe('green');
  });

  it('returns amber from 90s up to (but not including) 5min', () => {
    expect(computeOnlineIndicator(NOW - 90_000, NOW)).toBe('amber');
    expect(computeOnlineIndicator(NOW - 180_000, NOW)).toBe('amber');
    expect(computeOnlineIndicator(NOW - 299_999, NOW)).toBe('amber');
  });

  it('returns gray at and beyond 5min', () => {
    expect(computeOnlineIndicator(NOW - 300_000, NOW)).toBe('gray');
    expect(computeOnlineIndicator(NOW - 60 * 60 * 1000, NOW)).toBe('gray');
    expect(computeOnlineIndicator(NOW - 24 * 60 * 60 * 1000, NOW)).toBe('gray');
  });

  it('clamps future-dated heartbeats to green (clock skew tolerance)', () => {
    expect(computeOnlineIndicator(NOW + 30_000, NOW)).toBe('green');
    expect(computeOnlineIndicator(NOW + 5 * 60 * 1000, NOW)).toBe('green');
  });

  it('exports the threshold constants for tuning visibility', () => {
    expect(ONLINE_INDICATOR_THRESHOLDS_MS.green).toBe(90_000);
    expect(ONLINE_INDICATOR_THRESHOLDS_MS.amber).toBe(300_000);
  });
});

describe('renderOnlineDot', () => {
  it('emits class + glyph + aria for each indicator state', () => {
    const green = renderOnlineDot('green');
    const amber = renderOnlineDot('amber');
    const gray = renderOnlineDot('gray');

    expect(green).toContain('device-dot--green');
    expect(green).toContain('🟢');
    expect(green).toContain('aria-label="online"');

    expect(amber).toContain('device-dot--amber');
    expect(amber).toContain('🟡');
    expect(amber).toContain('aria-label="recently seen"');

    expect(gray).toContain('device-dot--gray');
    expect(gray).toContain('⚪');
    expect(gray).toContain('aria-label="offline"');
  });
});
