/** D-169 P0 — bridge capability profile re-push.
 *
 *  Closes TR-17 + the spec's "Capability profile re-push on permission
 *  change" acceptance: the bridge listens to `chrome.permissions.onAdded`
 *  / `onRemoved` and re-pushes its `BridgeCapabilityProfile` to the
 *  server. Slice 4's multi-bridge dispatcher pre-filters on each bridge's
 *  most-recent `granted_origins`; without this monitor the server's
 *  registry holds whatever the bridge reported at pair time, so a fresh
 *  grant added during normal browsing keeps the bridge ineligible until
 *  re-pair. The listener pulls the canonical state via
 *  `chrome.permissions.getAll()` on every fire — `onAdded` + `onRemoved`
 *  payloads describe deltas, and Chrome fires both in close sequence
 *  when an existing grant is replaced; rebuilding from `getAll` dodges
 *  the add+remove ordering race.
 *
 *  The module is pure-logic — no `chrome.*` dependency at top level so
 *  it unit-tests under node. The bootstrap wires the production adapter
 *  in `service-worker-entry.ts`.
 */

import { BRIDGE_ACTIONS, type BridgeCapabilityProfile } from '@recued/contracts';

/** Chrome's `permissions.getAll` / `onAdded` / `onRemoved` payload shape.
 *  Only the two fields the spec's profile needs are surfaced — `permissions`
 *  (named API permissions) + `origins` (host patterns). */
export interface ChromePermissionsSnapshot {
  permissions?: string[];
  origins?: string[];
}

/** Listener subscription shape — mirrors chrome.events.Event. */
export interface ChromePermissionsEvent {
  addListener(handler: (perms: ChromePermissionsSnapshot) => void): void;
  removeListener(handler: (perms: ChromePermissionsSnapshot) => void): void;
}

/** Minimum slice of `chrome.permissions` the monitor consumes. */
export interface ChromePermissionsApi {
  getAll(): Promise<ChromePermissionsSnapshot>;
  onAdded: ChromePermissionsEvent;
  onRemoved: ChromePermissionsEvent;
}

/** Static fields of `BridgeCapabilityProfile` the chrome.permissions API
 *  can't supply on its own (software / browser version, optional UA). The
 *  bootstrap captures these once at boot + threads them through. */
export interface BridgeCapabilityProfileSnapshot {
  horizontal_scroll?: boolean;
  generated_download_wait?: boolean;
  double_click?: boolean;
  file_drop?: boolean;
  text_paste?: boolean;
  dom_readiness?: boolean;
  guarded_links?: boolean;
  wait_read?: boolean;
  /** Preserves omitted element siblings for positional collection. */
  structural_reads?: boolean;
  /** D-402 slice G — checks a row named by its texts again at the step (`within`). */
  row_checks?: boolean;
  /** 2026-11-21 (D-402, task P) — checks the card a step's element sits in (`within_card`), as a row. */
  card_rows?: boolean;
  /** 2026-11-21 (D-402, task H) — watches a click or a sent form, and waits for a page to change, up to 30 s. */
  long_waits?: boolean;
  /** 2026-11-20 — a read asked to settle waits for the page to stop changing (`settle_ms`). */
  settled_reads?: boolean;
  /** 2026-11-20 — a read asked to wait for a change waits for the page to change, then settle (`wait_change_ms`). */
  settled_waits?: boolean;
  software_version: string;
  chrome_version: string;
  user_agent?: string;
  offscreen_supported?: boolean;
  alarms_supported?: boolean;
  dom_documents?: BridgeCapabilityProfile['dom_documents'];
}

/** Build a fresh `BridgeCapabilityProfile` by reading the current
 *  permissions state. Pure function — caller composes the
 *  `ChromePermissionsApi.getAll` slice + the boot-time static snapshot.
 *
 *  Codex 2026-05-28 Angle 4 fold — `getAll()` rejections propagate as
 *  the function's own rejection. Previously the catch collapsed errors
 *  to an empty snapshot + the push still fired with empty `granted_origins`
 *  / `permissions_granted`, which would make Slice 4's eligibility
 *  filter route every dispatch around the bridge until the next event
 *  re-built successfully — worse than no push at all. Surfacing the
 *  rejection lets the monitor's `onPushError` log + keeps the server's
 *  prior registry profile intact. */
/** What the host needs in order to build a snapshot. Today: the origins the
 *  owner has actually granted, which bound the document inventory. */
export interface BridgeCapabilitySnapshotContext {
  granted_origins: string[];
}

export const buildCapabilityProfile = async (deps: {
  chromePermissions: Pick<ChromePermissionsApi, 'getAll'>;
  snapshot: (context: BridgeCapabilitySnapshotContext) =>
    BridgeCapabilityProfileSnapshot | Promise<BridgeCapabilityProfileSnapshot>;
}): Promise<BridgeCapabilityProfile> => {
  const snapshot = (await deps.chromePermissions.getAll()) ?? {};
  // The origins are read BEFORE the snapshot on purpose: the document
  // inventory is scoped to them, so it cannot be built without them.
  const s = await deps.snapshot({ granted_origins: [...(snapshot.origins ?? [])] });
  const profile: BridgeCapabilityProfile = {
    software_version: s.software_version,
    chrome_version: s.chrome_version,
    permissions_granted: [...(snapshot.permissions ?? [])],
    granted_origins: [...(snapshot.origins ?? [])],
    offscreen_supported: s.offscreen_supported ?? false,
    alarms_supported: s.alarms_supported ?? false,
    // What this build runs, so a server asking for a newer action can say
    // "update the Bridge" instead of sending it (D-335).
    supported_actions: [...BRIDGE_ACTIONS],
  };
  if (s.user_agent !== undefined) profile.user_agent = s.user_agent;
  if (s.dom_documents !== undefined) profile.dom_documents = s.dom_documents;
  if (s.dom_readiness !== undefined) profile.dom_readiness = s.dom_readiness;
  if (s.horizontal_scroll !== undefined) profile.horizontal_scroll = s.horizontal_scroll;
  if (s.generated_download_wait !== undefined) profile.generated_download_wait = s.generated_download_wait;
  if (s.double_click !== undefined) profile.double_click = s.double_click;
  if (s.file_drop !== undefined) profile.file_drop = s.file_drop;
  if (s.text_paste !== undefined) profile.text_paste = s.text_paste;
  if (s.guarded_links !== undefined) profile.guarded_links = s.guarded_links;
  if (s.wait_read !== undefined) profile.wait_read = s.wait_read;
  if (s.structural_reads !== undefined) profile.structural_reads = s.structural_reads;
  if (s.row_checks !== undefined) profile.row_checks = s.row_checks;
  if (s.card_rows !== undefined) profile.card_rows = s.card_rows;
  if (s.long_waits !== undefined) profile.long_waits = s.long_waits;
  if (s.settled_reads !== undefined) profile.settled_reads = s.settled_reads;
  if (s.settled_waits !== undefined) profile.settled_waits = s.settled_waits;
  return profile;
};

export interface BridgeCapabilityProfileMonitorOptions {
  chromePermissions: ChromePermissionsApi;
  /** Boot-time static fields. Re-read on every fire so the bootstrap can
   *  swap in a fresh user-agent / version mid-session if a later slice
   *  surfaces that affordance. */
  snapshot: (context: BridgeCapabilitySnapshotContext) =>
    BridgeCapabilityProfileSnapshot | Promise<BridgeCapabilityProfileSnapshot>;
  /** Sink. `pushNow` + the chrome.permissions listeners both invoke this
   *  with the freshly built profile. Push failures are NOT rethrown —
   *  they're surfaced through `onPushError` so callers can log via
   *  console.warn at one place. */
  push(profile: BridgeCapabilityProfile): Promise<void> | void;
  /** Optional error sink. When push() rejects, the monitor invokes this
   *  with the rejection reason so the bootstrap can console.warn without
   *  the monitor caring about logging conventions. */
  onPushError?(err: unknown): void;
}

export interface BridgeCapabilityProfileMonitor {
  /** Build + push the current profile. Returns the promise for tests
   *  + future callers that want to await the round-trip; production
   *  fires this fire-and-forget via `void pushNow()` from
   *  `chrome.permissions.onAdded` / `onRemoved` AND from the WsClient's
   *  `onConnected` hook (push failures land in `onPushError`, not on
   *  the caller's await). Concurrent calls collapse onto the in-flight
   *  promise + the monitor marks itself dirty; the in-flight push's
   *  `finally` re-fires once when a permission event lands during the
   *  push (Codex 2026-05-28 Angle 3 fold) so a grant change that
   *  raced the previous push doesn't get silently dropped. */
  pushNow(): Promise<void>;
  /** Remove listeners. Idempotent. After stop(), `pushNow` is a no-op
   *  so the bootstrap can `stop()` from teardown without racing a
   *  permission-event firing concurrently. */
  stop(): void;
}

export const createBridgeCapabilityProfileMonitor = (
  options: BridgeCapabilityProfileMonitorOptions,
): BridgeCapabilityProfileMonitor => {
  let stopped = false;
  let inflight: Promise<void> | null = null;
  // Codex 2026-05-28 Angle 3 fold — dirty-flag re-fire. A
  // `chrome.permissions.onAdded` event firing AFTER `getAll()` has
  // already resolved its snapshot but BEFORE `options.push(profile)`
  // completes would otherwise collapse silently into the in-flight
  // push (the second call sees `inflight` is non-null and returns
  // early without scheduling a fresh read). The newly granted origin
  // would stay absent from the server until the next reconnect /
  // permission event. The dirty flag records the request; the
  // `finally` block re-fires once if any call landed during the
  // in-flight window.
  let dirty = false;

  const doPush = async (): Promise<void> => {
    if (stopped) return;
    try {
      const profile = await buildCapabilityProfile({
        chromePermissions: options.chromePermissions,
        snapshot: options.snapshot,
      });
      if (stopped) return;
      await Promise.resolve(options.push(profile));
    } catch (err) {
      if (stopped) return;
      options.onPushError?.(err);
    }
  };

  const pushNow = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inflight) {
      // A push is already in flight; mark dirty so the finally path
      // re-fires once when the current push settles. We deliberately
      // return the in-flight promise rather than the re-fire promise —
      // callers awaiting `pushNow` only need to know "a push is
      // running"; the re-fire is a background catch-up triggered by
      // the second mutation.
      dirty = true;
      return inflight;
    }
    inflight = (async () => {
      try {
        await doPush();
      } finally {
        inflight = null;
        if (dirty && !stopped) {
          dirty = false;
          // Re-arm by recursing through `pushNow` so the new push
          // observes a fresh `inflight = null` + can itself be marked
          // dirty by a third event firing during it.
          void pushNow();
        } else {
          dirty = false;
        }
      }
    })();
    return inflight;
  };

  const onAdded = (): void => {
    void pushNow();
  };
  const onRemoved = (): void => {
    void pushNow();
  };

  options.chromePermissions.onAdded.addListener(onAdded);
  options.chromePermissions.onRemoved.addListener(onRemoved);

  return {
    pushNow,
    stop(): void {
      if (stopped) return;
      stopped = true;
      options.chromePermissions.onAdded.removeListener(onAdded);
      options.chromePermissions.onRemoved.removeListener(onRemoved);
    },
  };
};
