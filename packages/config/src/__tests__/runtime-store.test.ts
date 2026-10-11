/** Tests for the mutable runtime config store — validation, in-memory
 *  fallback, and TOML round-trip when persisted. */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
    expect(store.get('supervisor.mode')).toBe('auto');
  });

  it('returns the initial value when provided', () => {
    const store = createRuntimeConfigStore({ 'supervisor.mode': 'systemd' });
    expect(store.get('supervisor.mode')).toBe('systemd');
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
    expect(() => store.set('supervisor.mode', 'trace')).toThrow(/must be one of/);
    store.set('supervisor.mode', 'systemd');
    expect(store.get('supervisor.mode')).toBe('systemd');
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
    const store = createRuntimeConfigStore({ 'supervisor.mode': 'auto' });
    store.set('storage.reserve_pct', 5);
    const snap = store.snapshot();
    expect(snap['storage.reserve_pct']).toBe(5);
    expect(snap['supervisor.mode']).toBe('auto');
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
    expect(() => store.set('supervisor.mode', 'docker')).not.toThrow();
    expect(store.get('supervisor.mode')).toBe('docker');
  });
});

// ────────────────────────────────────────────────────────────────
// Phase B — onChange propagation
// ────────────────────────────────────────────────────────────────

describe('createRuntimeConfigStore — a failed persist changes NOTHING', () => {
  /** Force the write to fail deterministically, WITHOUT depending on uid or
   *  chmod (a suite running as root would sail through a read-only dir): point
   *  the config at a path whose PARENT is a regular file, so `writeAtomic`'s
   *  `mkdirSync` throws ENOTDIR.
   *
   *  The real-world trigger is the shipped `docker-compose.yml`, which
   *  bind-mounts `config.toml` `:ro` on purpose — config-as-code, edited on the
   *  host. Every Settings write under docker takes this path. */
  const unwritablePath = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-config-ro-'));
    const blocker = join(dir, 'not-a-directory');
    writeFileSync(blocker, 'x');
    return join(blocker, 'config.toml');
  };

  it('leaves the in-memory value UNCHANGED when the write throws', () => {
    const store = createRuntimeConfigStore({ 'supervisor.mode': 'systemd' }, { path: unwritablePath() });
    expect(() => store.set('supervisor.mode', 'launchd')).toThrow();
    // The bug: `set` mutated memory before persisting, so this read returned
    // 'launchd' — the caller was told the write failed while the running server
    // had already adopted the new value, and a restart reverted it.
    expect(store.get('supervisor.mode')).toBe('systemd');
  });

  it('does not fire onChange listeners when the write throws', () => {
    const store = createRuntimeConfigStore({ 'supervisor.mode': 'systemd' }, { path: unwritablePath() });
    const events: string[] = [];
    store.onChange((key) => events.push(key));
    expect(() => store.set('supervisor.mode', 'launchd')).toThrow();
    expect(events).toEqual([]);
  });

  it('STILL applies and notifies when the path IS writable', () => {
    // The positive case. Every assertion above is equally satisfied by a `set`
    // that never applies anything, which would be a broken store that looks
    // impressively safe.
    const store = createRuntimeConfigStore({ 'supervisor.mode': 'systemd' }, { path: mkTmpFile() });
    const events: string[] = [];
    store.onChange((key) => events.push(key));
    store.set('supervisor.mode', 'launchd');
    expect(store.get('supervisor.mode')).toBe('launchd');
    expect(events).toEqual(['supervisor.mode']);
  });

  it('applies in memory when there is no path at all (memory-only store)', () => {
    // Persist-first must not turn the pathless store into a no-op.
    const store = createRuntimeConfigStore({ 'supervisor.mode': 'systemd' });
    store.set('supervisor.mode', 'launchd');
    expect(store.get('supervisor.mode')).toBe('launchd');
  });
});

describe('createRuntimeConfigStore — onChange', () => {
  it('fires listeners after every set', () => {
    const store = createRuntimeConfigStore({});
    const events: Array<{ key: string; value: unknown }> = [];
    store.onChange((key, value) => events.push({ key, value }));
    store.set('supervisor.mode', 'systemd');
    store.set('cache.max_bytes', 100);
    expect(events).toEqual([
      { key: 'supervisor.mode', value: 'systemd' },
      { key: 'cache.max_bytes', value: 100 },
    ]);
  });

  it('returns an unsubscribe that silences the listener', () => {
    const store = createRuntimeConfigStore({});
    const events: string[] = [];
    const un = store.onChange((key) => events.push(key));
    store.set('supervisor.mode', 'systemd');
    un();
    store.set('supervisor.mode', 'launchd');
    expect(events).toEqual(['supervisor.mode']);
  });

  it('does not fire when set throws ConfigValidationError', () => {
    const store = createRuntimeConfigStore({});
    const events: string[] = [];
    store.onChange((key) => events.push(key));
    expect(() => store.set('supervisor.mode', 123 as unknown as string))
      .toThrow(ConfigValidationError);
    expect(events).toEqual([]);
  });

  it('swallows listener exceptions — subsequent listeners still run', () => {
    const store = createRuntimeConfigStore({});
    const seen: string[] = [];
    store.onChange(() => { throw new Error('boom'); });
    store.onChange((key) => seen.push(key));
    expect(() => store.set('supervisor.mode', 'systemd')).not.toThrow();
    expect(seen).toEqual(['supervisor.mode']);
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
    // Server scale, not the extension-era 50 MB. This surface is `data.memory.*`
    // (D-120) and it EVICTS oldest-first when full, with age-prune off by
    // default — so the ceiling is what decides how much of the owner's memory
    // survives, and 50 MB was reached as routine housekeeping.
    expect(store.get('audit.quota.bytes')).toBe(5 * 1024 * 1024 * 1024);
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
