/** D-118 Phase 2 — service quota tracker.
 *
 *  Two-layer storage gate for `service-invoke` calls:
 *
 *    1. Cached per-instance bytes (`du` over the instance cwd)
 *       refreshed every N seconds. Cheap, stale-OK.
 *    2. Live OS free-space (`fs.statfs` over `data_path`) queried
 *       per invoke. Live, never cached — the OS knows the truth.
 *
 *  Either layer failing returns `SERVICE_STORAGE_PRESSURE`. Mid-
 *  invoke overruns (binary writes more than the slack predicts)
 *  fall through to the OS and surface as the binary's natural
 *  ENOSPC; the supervisor records the exit code in audit.
 *
 *  The `du` sampler is the only periodic work in this module — a
 *  single interval timer iterates every enrolled service slug,
 *  refreshes its `quota_bytes_cached` column, and moves on. Sampler
 *  work is intentionally serialised: walking five service cwds
 *  concurrently is a stress pattern with no upside on a personal
 *  server.
 */

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import { SERVICE_CWD_SUBDIR } from '@recued/contracts';
import { osFreeBytes } from '../../storage/disk-free.js';
import type { ServiceInstanceStateStore } from './service-state-table.js';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

/** Per-instance quota knobs the gate consults. Defaults flow from
 *  `runtime.collection.service.*` schema entries; per-instance
 *  overrides land here at enroll time (Phase 7 wires these from
 *  `collection_instances.config_json`). */
export interface ServiceQuotaConfig {
  /** Hard ceiling on bytes consumed by this instance's cwd. */
  quota_bytes: number;
  /** Headroom above the cached du sample, allowed before refusing
   *  the invoke. Covers binaries that write a few hundred MB inside
   *  a single op without forcing a du-sample-per-invoke. */
  invoke_slack_bytes: number;
  /** Floor on `statvfs(data_path).bavail` — when free space drops
   *  below this, every invoke gets `SERVICE_STORAGE_PRESSURE`
   *  regardless of per-instance quota. */
  min_disk_free_bytes: number;
}

/** Outcome of the two-layer pre-invoke gate. `'ok'` proceeds;
 *  `'reject'` returns `SERVICE_STORAGE_PRESSURE` to the caller with
 *  the layer that tripped. */
export type QuotaGateOutcome =
  | { ok: true }
  | {
      ok: false;
      tripped: 'instance_quota' | 'os_free_space';
      detail: string;
    };

export interface CheckInvokeQuotaInput {
  /** Slug of the enrolled service instance about to invoke. */
  slug: string;
  /** Per-instance + system quota config, resolved by the caller from
   *  the runtime schema + instance config. */
  config: ServiceQuotaConfig;
}

export interface ServiceQuotaTracker {
  /** Two-layer pre-invoke gate. Pure read — never mutates the
   *  state table; the du sampler keeps the cached value fresh. */
  checkInvokeQuota(input: CheckInvokeQuotaInput): QuotaGateOutcome;
  /** Run a single du sample for `slug` and write the result to
   *  `service_instance_state`. Used by the periodic sampler + by
   *  the dispatcher post-invoke when the binary is known to have
   *  written significant data. */
  sampleNow(slug: string): Promise<number>;
  /** Start the periodic sampling loop. Iterates `enrolledSlugs()`
   *  every `intervalMs`, refreshing each cwd's du. Returns a stop
   *  function the composition root invokes during drain. */
  startSampler(opts: StartSamplerOptions): () => void;
}

export interface StartSamplerOptions {
  /** Sampling cadence — typically
   *  `runtime.collection.service.du_sample_interval_s` × 1000. */
  intervalMs: number;
  /** Pull the live list of enrolled `data.service.*` slugs.
   *  Resolved per tick so newly-enrolled instances pick up sampling
   *  on the next interval without requiring a tracker restart. */
  enrolledSlugs: () => readonly string[];
}

export interface CreateServiceQuotaTrackerOptions {
  /** Server `data_path` — quota tracker resolves per-instance cwds
   *  as `<data_path>/<SERVICE_CWD_SUBDIR>/<slug>/`. */
  dataPath: string;
  /** Where du samples land. */
  store: ServiceInstanceStateStore;
  /** Test hook — defaults to `Date.now`. */
  now?: () => number;
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/** Walk a directory, summing every regular-file `size`. Symlinks
 *  are skipped to avoid cycles + double-counting referenced
 *  content. Errors at the leaves (file vanished mid-walk, perms
 *  flipped) silently zero — the sampler value is intentionally
 *  best-effort, and a strict failure would freeze the gate. */
const directorySize = async (root: string): Promise<number> => {
  let total = 0;
  let stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.isFile()) {
        try {
          const stat = await fsp.stat(path);
          total += stat.size;
        } catch {
          // file vanished mid-walk; skip
        }
      }
      // symlinks + special files: ignored
    }
  }
  return total;
};

// Live OS free-space probe (`osFreeBytes`) now lives in the shared
// `storage/disk-free.ts` — the archive export pre-flight (M1) reuses the
// same `bavail × bsize` coercion.

// ────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────

export const createServiceQuotaTracker = (
  opts: CreateServiceQuotaTrackerOptions,
): ServiceQuotaTracker => {
  const { dataPath, store, now = () => Date.now() } = opts;

  const cwdFor = (slug: string): string =>
    join(dataPath, SERVICE_CWD_SUBDIR, slug);

  const sampleNow = async (slug: string): Promise<number> => {
    const bytes = await directorySize(cwdFor(slug));
    store.upsert(slug, {
      quota_bytes_cached: bytes,
      quota_bytes_sampled_at: now(),
    });
    return bytes;
  };

  const checkInvokeQuota = (input: CheckInvokeQuotaInput): QuotaGateOutcome => {
    const row = store.get(input.slug);
    const cached = row?.quota_bytes_cached ?? 0;

    // Layer 1 — cached du + slack must fit under the per-instance
    // ceiling. The slack covers a single invoke's expected writes
    // without forcing a synchronous du sample on the hot path.
    const projected = cached + input.config.invoke_slack_bytes;
    if (projected > input.config.quota_bytes) {
      return {
        ok: false,
        tripped: 'instance_quota',
        detail:
          `quota ${input.config.quota_bytes} exceeded by ` +
          `cached ${cached} + slack ${input.config.invoke_slack_bytes}`,
      };
    }

    // Layer 2 — live OS free-space must clear the floor. Done last
    // because statfs is the more expensive of the two checks (one
    // syscall) and the cheap layer rejects most failure cases.
    let free: number;
    try {
      free = osFreeBytes(dataPath);
    } catch (err) {
      // Gate-open on probe failure — we'd rather let an invoke run
      // and surface ENOSPC than wedge the entire surface because
      // statfs is not implemented on this filesystem.
      return { ok: true };
    }
    if (free < input.config.min_disk_free_bytes) {
      return {
        ok: false,
        tripped: 'os_free_space',
        detail:
          `OS free ${free} < min_disk_free ${input.config.min_disk_free_bytes}`,
      };
    }

    return { ok: true };
  };

  const startSampler = (samplerOpts: StartSamplerOptions): (() => void) => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      if (stopped) return;
      const slugs = samplerOpts.enrolledSlugs();
      // Serialised on purpose — see file header.
      for (const slug of slugs) {
        if (stopped) return;
        try {
          await sampleNow(slug);
        } catch {
          // Sampling errors are non-fatal; the row's cached value
          // simply doesn't refresh this tick.
        }
      }
      if (!stopped) {
        timer = setTimeout(() => {
          void tick();
        }, samplerOpts.intervalMs);
        // Don't keep the event loop alive on the sampler alone —
        // the server's main listener is what should hold it open.
        if (typeof timer.unref === 'function') timer.unref();
      }
    };

    // First sample fires immediately so the cache primes before
    // the first invoke arrives.
    void tick();

    return (): void => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    };
  };

  return {
    checkInvokeQuota,
    sampleNow,
    startSampler,
  };
};
