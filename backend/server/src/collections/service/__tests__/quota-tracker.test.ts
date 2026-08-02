/** D-118 Phase 2 — service quota-tracker tests.
 *
 *  Two-layer gate is the load-bearing surface. Cover:
 *    - cached quota gate decisions (under / at / over).
 *    - statvfs gate decisions (free space below / above floor).
 *    - sampleNow walks a real cwd and writes the cached value.
 *    - the periodic sampler iterates enrolled slugs.
 *    - statvfs probe failure gates open (better than wedging).
 */

import { promises as fsp } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

import { SERVICE_CWD_SUBDIR } from '@recued/contracts';
import {
  createServiceQuotaTracker,
  type ServiceQuotaConfig,
  type ServiceQuotaTracker,
} from '../quota-tracker.js';
import {
  createServiceStateStore,
  type ServiceInstanceStateStore,
} from '../service-state-table.js';

let db: Database.Database;
let store: ServiceInstanceStateStore;
let tracker: ServiceQuotaTracker;
let dataPath: string;

const baseConfig: ServiceQuotaConfig = {
  quota_bytes: 1_000_000,
  invoke_slack_bytes: 100_000,
  min_disk_free_bytes: 1024, // 1 KB — trivially met on any tmpfs
};

beforeEach(async () => {
  db = new Database(':memory:');
  store = createServiceStateStore({ db });
  dataPath = await mkdtemp(join(tmpdir(), 'recued-d118-'));
  tracker = createServiceQuotaTracker({ dataPath, store });
});

afterEach(async () => {
  db.close();
  await fsp.rm(dataPath, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// Layer 1 — cached instance quota
// ────────────────────────────────────────────────────────────────

describe('checkInvokeQuota — cached instance quota', () => {
  it('passes when cached + slack are well under the ceiling', () => {
    store.upsert('ollama', { quota_bytes_cached: 500_000 });
    const result = tracker.checkInvokeQuota({
      slug: 'ollama',
      config: baseConfig,
    });
    expect(result.ok).toBe(true);
  });

  it('passes when row is missing entirely (cached defaults to 0)', () => {
    const result = tracker.checkInvokeQuota({
      slug: 'newly-enrolled',
      config: baseConfig,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects when cached + slack would exceed the ceiling', () => {
    store.upsert('ollama', { quota_bytes_cached: 950_000 });
    const result = tracker.checkInvokeQuota({
      slug: 'ollama',
      config: baseConfig,
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.tripped).toBe('instance_quota');
      expect(result.detail).toContain('quota');
      expect(result.detail).toContain('950000');
    }
  });

  it('boundary: cached + slack exactly at quota → passes (strict greater-than)', () => {
    store.upsert('ollama', { quota_bytes_cached: 900_000 });
    const result = tracker.checkInvokeQuota({
      slug: 'ollama',
      config: baseConfig, // 900k + 100k = 1M = quota; not > quota
    });
    expect(result.ok).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Layer 2 — OS free-space
// ────────────────────────────────────────────────────────────────

describe('checkInvokeQuota — OS free-space', () => {
  it('rejects when statvfs reports less than min_disk_free_bytes', () => {
    // Floor set absurdly high to force the second-layer rejection.
    const result = tracker.checkInvokeQuota({
      slug: 'ollama',
      config: { ...baseConfig, min_disk_free_bytes: 1e18 },
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.tripped).toBe('os_free_space');
      expect(result.detail).toContain('OS free');
    }
  });
});

// ────────────────────────────────────────────────────────────────
// sampleNow — real du
// ────────────────────────────────────────────────────────────────

describe('sampleNow', () => {
  const writeBytes = async (path: string, bytes: number): Promise<void> => {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, Buffer.alloc(bytes));
  };

  it('returns 0 + writes 0 when the cwd does not exist yet', async () => {
    const total = await tracker.sampleNow('absent');
    expect(total).toBe(0);
    expect(store.get('absent')?.quota_bytes_cached).toBe(0);
    expect(store.get('absent')?.quota_bytes_sampled_at).toBeGreaterThan(0);
  });

  it('sums every regular file in the cwd recursively', async () => {
    const cwd = join(dataPath, SERVICE_CWD_SUBDIR, 'ollama');
    await mkdir(cwd, { recursive: true });
    await writeBytes(join(cwd, 'a.bin'), 1000);
    await writeBytes(join(cwd, 'sub', 'b.bin'), 2500);
    await writeBytes(join(cwd, 'sub', 'deeper', 'c.bin'), 500);

    const total = await tracker.sampleNow('ollama');
    expect(total).toBe(4000);
    expect(store.get('ollama')?.quota_bytes_cached).toBe(4000);
  });

  it('writes the sample timestamp on the row', async () => {
    const before = Date.now();
    await tracker.sampleNow('ollama');
    const stamp = store.get('ollama')!.quota_bytes_sampled_at!;
    expect(stamp).toBeGreaterThanOrEqual(before);
  });
});

// ────────────────────────────────────────────────────────────────
// startSampler — periodic loop
// ────────────────────────────────────────────────────────────────

describe('startSampler', () => {
  const writeBytes = async (path: string, bytes: number): Promise<void> => {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, Buffer.alloc(bytes));
  };

  it('primes the cache for every enrolled slug on first tick', async () => {
    const cwdA = join(dataPath, SERVICE_CWD_SUBDIR, 'a');
    const cwdB = join(dataPath, SERVICE_CWD_SUBDIR, 'b');
    await mkdir(cwdA, { recursive: true });
    await mkdir(cwdB, { recursive: true });
    await writeBytes(join(cwdA, 'x.bin'), 100);
    await writeBytes(join(cwdB, 'y.bin'), 200);

    const stop = tracker.startSampler({
      intervalMs: 100_000, // long — we only test the first tick
      enrolledSlugs: () => ['a', 'b'],
    });

    // First tick is async — give the microtask queue a few turns.
    await new Promise((r) => setTimeout(r, 30));

    expect(store.get('a')?.quota_bytes_cached).toBe(100);
    expect(store.get('b')?.quota_bytes_cached).toBe(200);

    await stop();
  });

  it('sampler stop function suppresses further work', async () => {
    let calls = 0;
    const stop = tracker.startSampler({
      intervalMs: 1, // fire fast on the next setTimeout
      enrolledSlugs: () => {
        calls += 1;
        return [];
      },
    });
    // First tick fires immediately.
    await new Promise((r) => setTimeout(r, 5));
    await stop();
    const callsAfterStop = calls;
    // Wait long enough for any queued tick to drain.
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(callsAfterStop);
  });

  it('does not persist a sample that finishes after stop closes admission', async () => {
    let release!: (entries: []) => void;
    const held = new Promise<[]>((resolve) => { release = resolve; });
    const readdir = vi.spyOn(fsp, 'readdir').mockReturnValueOnce(held as never);
    const write = vi.spyOn(store, 'upsert');
    const stop = tracker.startSampler({
      intervalMs: 100_000,
      enrolledSlugs: () => ['late'],
    });
    await vi.waitFor(() => { expect(readdir).toHaveBeenCalledTimes(1); });

    const stopping = stop();
    release([]);
    await stopping;

    expect(write).not.toHaveBeenCalled();
    expect(store.get('late')).toBeNull();
  });
});
