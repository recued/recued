/** Tests for the mutable runtime config store — validation, in-memory
 *  fallback, and TOML round-trip when persisted. */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import toml from '@iarna/toml';

import {
  createRuntimeConfigStore,
  runtimeDefaults,
  ConfigValidationError,
} from '../index.js';

const mkTmpFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-config-'));
  return join(dir, 'config.toml');
};

describe('createRuntimeConfigStore — reads', () => {
  it('returns schema defaults for keys never set', () => {
    const store = createRuntimeConfigStore({});
    expect(store.get('vault.quota.per_publisher_bytes')).toBe(1 * 1024 * 1024);
    expect(store.get('log.level')).toBe('info');
  });

  it('returns the initial value when provided', () => {
    const store = createRuntimeConfigStore({ 'log.level': 'warn' });
    expect(store.get('log.level')).toBe('warn');
  });

  it('throws ConfigValidationError for unknown keys', () => {
    const store = createRuntimeConfigStore({});
    expect(() => store.get('llm.nope')).toThrow(ConfigValidationError);
    expect(() => store.get('constructor')).toThrow(ConfigValidationError);
    expect(() => store.get('__proto__')).toThrow(ConfigValidationError);
  });
});

describe('createRuntimeConfigStore — writes (memory)', () => {
  it('set() validates number bounds', () => {
    const store = createRuntimeConfigStore({});
    expect(() => store.set('storage.reserve_pct', -1)).toThrow(/must be >= 0/);
    expect(() => store.set('storage.reserve_pct', 101)).toThrow(/must be <= 100/);
    store.set('storage.reserve_pct', 10);
    expect(store.get('storage.reserve_pct')).toBe(10);
  });

  it('set() validates public_port as an integer listener port', () => {
    const store = createRuntimeConfigStore({});
    expect(store.get('public_port')).toBe(443);
    expect(() => store.set('public_port', 0)).toThrow(/must be >= 1/);
    expect(() => store.set('public_port', 65536)).toThrow(/must be <= 65535/);
    expect(() => store.set('public_port', 8443.5)).toThrow(/must be an integer/);
    store.set('public_port', 8443);
    expect(store.get('public_port')).toBe(8443);
  });

  it('set() validates enum members', () => {
    const store = createRuntimeConfigStore({});
    expect(() => store.set('log.level', 'trace')).toThrow(/must be one of/);
    store.set('log.level', 'warn');
    expect(store.get('log.level')).toBe('warn');
  });

  it('set() validates type', () => {
    const store = createRuntimeConfigStore({});
    expect(() => store.set('vault.quota.total_bytes', 'big' as unknown as number))
      .toThrow(/expects finite number/);
  });

  it('set() rejects prototype-sensitive unknown keys', () => {
    const store = createRuntimeConfigStore({});
    expect(() => store.set('constructor', 'polluted' as never)).toThrow(ConfigValidationError);
    expect(() => store.set('__proto__', 'polluted' as never)).toThrow(ConfigValidationError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('snapshot() returns the in-memory map', () => {
    const store = createRuntimeConfigStore({ 'log.level': 'info' });
    store.set('storage.reserve_pct', 5);
    const snap = store.snapshot();
    expect(snap['storage.reserve_pct']).toBe(5);
    expect(snap['log.level']).toBe('info');
  });
});

describe('createRuntimeConfigStore — persistence', () => {
  it('writes to the TOML file when a path is supplied', () => {
    const path = mkTmpFile();
    const store = createRuntimeConfigStore(runtimeDefaults(), { path });
    store.set('vault.quota.per_publisher_bytes', 2 * 1024 * 1024);

    const parsed = toml.parse(readFileSync(path, 'utf8')) as {
      runtime?: Record<string, unknown>;
    };
    expect(parsed.runtime?.['vault.quota.per_publisher_bytes']).toBe(2 * 1024 * 1024);
  });

  it('does NOT touch the filesystem when no path is given', () => {
    // Composition without a persisted file: writes succeed in memory,
    // nothing to observe on disk.
    const store = createRuntimeConfigStore({});
    expect(() => store.set('log.level', 'debug')).not.toThrow();
    expect(store.get('log.level')).toBe('debug');
  });
});

// ────────────────────────────────────────────────────────────────
// Phase B — onChange propagation
// ────────────────────────────────────────────────────────────────

describe('createRuntimeConfigStore — onChange', () => {
  it('fires listeners after every set', () => {
    const store = createRuntimeConfigStore({});
    const events: Array<{ key: string; value: unknown }> = [];
    store.onChange((key, value) => events.push({ key, value }));
    store.set('log.level', 'warn');
    store.set('cache.max_bytes', 100);
    expect(events).toEqual([
      { key: 'log.level', value: 'warn' },
      { key: 'cache.max_bytes', value: 100 },
    ]);
  });

  it('returns an unsubscribe that silences the listener', () => {
    const store = createRuntimeConfigStore({});
    const events: string[] = [];
    const un = store.onChange((key) => events.push(key));
    store.set('log.level', 'warn');
    un();
    store.set('log.level', 'error');
    expect(events).toEqual(['log.level']);
  });

  it('does not fire when set throws ConfigValidationError', () => {
    const store = createRuntimeConfigStore({});
    const events: string[] = [];
    store.onChange((key) => events.push(key));
    expect(() => store.set('log.level', 123 as unknown as string))
      .toThrow(ConfigValidationError);
    expect(events).toEqual([]);
  });

  it('swallows listener exceptions — subsequent listeners still run', () => {
    const store = createRuntimeConfigStore({});
    const seen: string[] = [];
    store.onChange(() => { throw new Error('boom'); });
    store.onChange((key) => seen.push(key));
    expect(() => store.set('log.level', 'warn')).not.toThrow();
    expect(seen).toEqual(['log.level']);
  });

  it('snapshot reflects set values (sanity for onChange consumers)', () => {
    const store = createRuntimeConfigStore({});
    let seenSnapshot: Record<string, unknown> | null = null;
    store.onChange(() => { seenSnapshot = store.snapshot(); });
    store.set('cache.max_bytes', 42);
    expect(seenSnapshot).not.toBeNull();
    expect(seenSnapshot!['cache.max_bytes']).toBe(42);
  });
});

// ────────────────────────────────────────────────────────────────
// Phase B — new config keys roundtrip
// ────────────────────────────────────────────────────────────────

describe('Phase B runtime schema additions', () => {
  it('returns defaults for the new audit / account / scheduler / cascade keys', () => {
    const store = createRuntimeConfigStore({});
    // D-120 post-amendment — default flipped to 0 (wire sentinel for
    // "no expiry"; bin.ts collapses 0 → null before the pruner sees it).
    expect(store.get('audit.retention_days')).toBe(0);
    expect(store.get('audit.quota.bytes')).toBe(50 * 1024 * 1024);
    expect(store.get('audit.prune_at_pct')).toBe(70);
    expect(store.get('audit.prune_interval_s')).toBe(3600);
    expect(store.get('audit.prune_max_rows_per_run')).toBe(1000);
    expect(store.get('audit.reserve_pct')).toBe(4);
    expect(store.get('account.quota.bytes')).toBe(10 * 1024 * 1024);
    expect(store.get('scheduler.quota.bytes')).toBe(5 * 1024 * 1024);
    expect(store.get('cascade.debounce_window_s')).toBe(60);
    expect(store.get('cascade.orphan_scan_max_blobs')).toBe(1000);
  });

  it('accepts valid set() calls on the new keys', () => {
    const store = createRuntimeConfigStore({});
    expect(() => store.set('audit.retention_days', 7)).not.toThrow();
    expect(store.get('audit.retention_days')).toBe(7);
    expect(() => store.set('cascade.debounce_window_s', 15)).not.toThrow();
    expect(store.get('cascade.debounce_window_s')).toBe(15);
  });

  it('rejects out-of-range values per the schema bounds', () => {
    const store = createRuntimeConfigStore({});
    // audit.prune_at_pct has max 99
    expect(() => store.set('audit.prune_at_pct', 100)).toThrow(ConfigValidationError);
    // cascade.debounce_window_s has min 5
    expect(() => store.set('cascade.debounce_window_s', 2)).toThrow(ConfigValidationError);
  });
});
