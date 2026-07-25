/** Phase 7 (D-110) — file-adapter registry.
 *
 *  Every supported adapter (`fs`, `s3`, `ext-downloads`, plus the
 *  in-test `null-adapter`) registers a `FileAdapterFactory` here.
 *  The registry is *closed* — new adapters require an upstream
 *  contribution (D-110 non-goal #3, "plugin system"). Keeping the
 *  map small + auditable is the whole point.
 *
 *  Each factory promises two things:
 *    1. `probeCaps(config)` — run a write-read-delete / HeadBucket
 *       / capabilities-rpc probe and return the caps for this
 *       config. Adapter writes caps; it does NOT write to the DB.
 *    2. `create(ctx)` — instantiate an adapter that exposes the
 *       existing `FsWatcher`-style `{ start, stop }` surface plus
 *       new mutation methods. Wires to the underlying collection
 *       machinery; the caller (enroll rpc + bin.ts wiring) decides
 *       when to start it.
 *
 *  Lifecycle: the registry is a static import in production; tests
 *  swap it with `createAdapterRegistry` + their own factories. No
 *  mutable global state — adapters are all pure functions that
 *  close over their config. */

import type { FileCollectionCaps, FileRecordStat } from '@recued/contracts';
import type { ProbedCaps } from './caps.js';
import { validateCaps } from './caps.js';

/** One event delivered by an adapter into the collection layer. Same
 *  shape the Phase D fs-adapter used — kept here so every adapter
 *  (including future S3 / ext-downloads) produces identical events. */
export interface FileAdapterEvent {
  type: 'present' | 'change' | 'remove';
  /** Path-style-native identifier — `fs` emits absolute FS paths,
   *  `s3` emits object keys, `ext-downloads` emits opaque IDs. The
   *  collection layer treats this as opaque and compares for
   *  equality; recipe-visible surface normalises against `path_style`. */
  path: string;
}

/** Minimal lifecycle contract every adapter instance implements.
 *  Phase 7 adapters also implement mutation methods
 *  (`writeRecord` / `deleteRecord`) — those surface via the
 *  `FileMutationCapable` extension below, gated on caps. */
export interface FileAdapterInstance {
  /** Start (or resume) sync. Idempotent. */
  start(): Promise<void>;
  /** Stop sync cleanly. Idempotent. */
  stop(): Promise<void>;
}

/** Mutation-capable adapter. Write / delete ingredients cast at
 *  runtime — trying to call `writeRecord` on an adapter that doesn't
 *  implement it throws `ADAPTER_CAPABILITY_MISMATCH`, which is also
 *  what the caps gate already refuses at parseRecipe time.
 *
 *  Every adapter implements `statRecord` (even read-only ones like
 *  `ext-downloads`) — it's the cheap metadata read backing the
 *  `file-stat` ingredient and is required for recipes to ask
 *  "does this file exist?" / "how big is it?" / "when did it
 *  change?" without pulling the full body.
 *
 *  Adapter methods throw `FileAdapterError` (see `./errors.ts`) for
 *  recognized failure cases (not_found / permission_denied /
 *  too_large / io_error). The dispatcher maps these onto recipe-
 *  visible codes. Unexpected throws (bugs) become generic 500 IO
 *  errors — explicit classification in the adapter is the contract. */
export interface FileMutationCapable extends FileAdapterInstance {
  writeRecord(path: string, body: Uint8Array, mime?: string): Promise<void>;
  deleteRecord(path: string): Promise<void>;
  readRecord(path: string): Promise<Uint8Array>;
  /** Lightweight metadata read. Returns `{ exists: false }` when the
   *  record is absent — this is NOT an error. Other failure modes
   *  (permission denied, IO error) throw `FileAdapterError`. */
  statRecord(path: string): Promise<FileRecordStat>;
}

export const isMutationCapable = (
  instance: FileAdapterInstance,
): instance is FileMutationCapable =>
  typeof (instance as FileMutationCapable).writeRecord === 'function' &&
  typeof (instance as FileMutationCapable).deleteRecord === 'function' &&
  typeof (instance as FileMutationCapable).readRecord === 'function' &&
  typeof (instance as FileMutationCapable).statRecord === 'function';

/** The context an adapter gets when being instantiated. Stays narrow
 *  so factories can't reach into the composition root and take
 *  dependencies that weren't declared. */
export interface FileAdapterContext {
  /** The user-chosen slug. Useful for log prefixes + file naming. */
  slug: string;
  /** Validated config for this instance — adapter-specific shape.
   *  Factories parse further at construction time. */
  config: Record<string, unknown>;
  /** Event sink — called once per discovered / changed / removed
   *  record. Failures in the sink must NOT propagate out of the
   *  adapter's loop; adapters log + swallow. */
  onEvent: (event: FileAdapterEvent) => Promise<void> | void;
  /** Optional log hook. Defaults to no-op. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
}

/** A factory promises two operations: probe an attempted config to
 *  see what caps this adapter supports there, and (on enroll)
 *  instantiate a running adapter for the same config. */
export interface FileAdapterFactory {
  /** Adapter registry key. Must match the `adapter_type` stored on
   *  the collection_instances row. */
  readonly type: string;
  /** Run a cheap capabilities probe — write-read-delete probe file,
   *  HeadBucket, `chrome.downloads` query. Must not keep any
   *  process state after resolving. */
  probeCaps(config: Record<string, unknown>): Promise<ProbedCaps>;
  /** Instantiate the adapter. Called after caps probe succeeds. */
  create(ctx: FileAdapterContext): FileAdapterInstance;
}

export interface FileAdapterRegistry {
  register(factory: FileAdapterFactory): void;
  /** Return the factory matching `type`, or `undefined` when
   *  unknown. Unknown adapter types must surface as a 400 on the
   *  enroll rpc. */
  get(type: string): FileAdapterFactory | undefined;
  /** Every registered adapter type in registration order. Used by
   *  the extension Options UI to populate the Add-instance picker. */
  listTypes(): string[];
}

export const createAdapterRegistry = (): FileAdapterRegistry => {
  const byType = new Map<string, FileAdapterFactory>();
  const order: string[] = [];
  return {
    register(factory) {
      if (byType.has(factory.type)) {
        throw new Error(
          `FileAdapterRegistry: duplicate registration for '${factory.type}'`,
        );
      }
      byType.set(factory.type, factory);
      order.push(factory.type);
    },
    get(type) {
      return byType.get(type);
    },
    listTypes() {
      return [...order];
    },
  };
};

/** Run a probe with caps validation. Wraps `factory.probeCaps` so
 *  every call site gets the same shape-check + error handling. */
export const probeAdapter = async (
  factory: FileAdapterFactory,
  config: Record<string, unknown>,
): Promise<FileCollectionCaps> => {
  let probed: ProbedCaps;
  try {
    probed = await factory.probeCaps(config);
  } catch (err) {
    throw new Error(
      `probe failed for adapter '${factory.type}': ${(err as Error).message}`,
    );
  }
  // Adapter may hand us back a partial / untyped shape; validateCaps
  // throws when the shape is wrong — intentionally surfaces as a
  // developer error (factory bug), not a user-facing config error.
  return validateCaps(probed);
};
