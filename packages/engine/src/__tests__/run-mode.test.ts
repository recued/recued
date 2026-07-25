/** D-120 Phase 7.5 — `deriveRunMode` engine helper tests.
 *
 *  Pure helper; covers the declarative-wins rule and trigger-source
 *  inference for every documented trigger plus the defensive
 *  fallback for unknown / missing values.
 */

import { describe, expect, it } from 'vitest';
import { deriveRunMode, KNOWN_TRIGGER_SOURCES } from '../run-mode.js';

describe('deriveRunMode — declarative wins', () => {
  it('returns the explicit recipe.run_mode regardless of trigger', () => {
    expect(deriveRunMode('backfill', 'manual')).toBe('backfill');
    expect(deriveRunMode('manual', 'auto_run')).toBe('manual');
    expect(deriveRunMode('live', 'backfill')).toBe('live');
  });

  it('rejects garbage values from recipe.run_mode and falls through to trigger inference', () => {
    // Type narrowed at the contract layer; this checks the runtime
    // guard rather than relying on TS-only enforcement.
    expect(deriveRunMode('invalid' as 'live', 'manual')).toBe('manual');
    expect(deriveRunMode('' as 'live', 'auto_run')).toBe('live');
  });
});

describe('deriveRunMode — trigger inference', () => {
  it("'manual' trigger → 'manual' run_mode", () => {
    expect(deriveRunMode(undefined, 'manual')).toBe('manual');
  });

  it("'backfill' trigger → 'backfill' run_mode", () => {
    expect(deriveRunMode(undefined, 'backfill')).toBe('backfill');
  });

  it("every other documented trigger source → 'live'", () => {
    const liveTriggers = [
      'auto_run', 'mcp', 'schedule', 'extension_ws',
      'reactive-remote', 'server_command',
    ];
    for (const src of liveTriggers) {
      expect(deriveRunMode(undefined, src)).toBe('live');
    }
  });

  it('unknown trigger source defaults to live (defensive)', () => {
    expect(deriveRunMode(undefined, 'cron-7am')).toBe('live');
    expect(deriveRunMode(undefined, 'webhook-github')).toBe('live');
  });

  it('null / undefined trigger source defaults to live', () => {
    expect(deriveRunMode(undefined, null)).toBe('live');
    expect(deriveRunMode(undefined, undefined)).toBe('live');
  });
});

describe('KNOWN_TRIGGER_SOURCES catalogue', () => {
  it('contains every trigger source the engine + hosts emit', () => {
    expect(new Set(KNOWN_TRIGGER_SOURCES)).toEqual(
      new Set([
        'manual',
        'backfill',
        'auto_run',
        'mcp',
        'schedule',
        'extension_ws',
        'reactive-remote',
        'server_command',
      ]),
    );
  });
});
