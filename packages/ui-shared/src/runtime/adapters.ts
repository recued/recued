/** D-121 Phase 3 — runtime adapter interfaces.
 *
 *  `packages/ui-shared/` is consumed by `apps/webclient/` (single-tab
 *  PWA). UI components reach the platform via these four interfaces;
 *  the webclient ships a concrete implementation and tests inject
 *  mocks. The extension/webapp surfaces that originally co-consumed
 *  this module were retired in D-148 P11.
 *
 *  Spec ref: `docs/d-121-spec.md` Phase 3 + Phase 4 (`WebStorageAdapter`
 *  / `WebRpcAdapter` / `WebIdentityAdapter` / `WebTabAdapter`). */

/** Key/value storage abstraction.
 *
 *  Webclient binding: an IDB-backed adapter for the per-client
 *  server heartbeat snapshot cache per Phase G.
 *
 *  All operations are async and best-effort: missing keys, malformed
 *  values, and platform absence resolve to `null` / no-op rather than
 *  rejecting. Callers fall back to defaults on `null`. */
export interface StorageAdapter {
  /** Read the value at `key`. Returns `null` when the key is absent,
   *  storage is unavailable, or the value is the wrong shape. The
   *  `T` type is unverified — callers narrow / validate. */
  get<T = unknown>(key: string): Promise<T | null>;
  /** Write `value` at `key`. Resolves silently when storage is
   *  unavailable. */
  set(key: string, value: unknown): Promise<void>;
  /** Remove the entry at `key`. Resolves silently when storage is
   *  unavailable or the key is absent. */
  remove(key: string): Promise<void>;
}

/** Cross-surface message channel.
 *
 *  Webclient binding: a no-op send + WebSocket-derived subscribe
 *  that surfaces the realtime broadcast bus shapes per Phase 6.
 *  Server-paired clients receive these events from the bus.
 *
 *  Listeners receive raw payloads — typing happens at the consumer.
 *  Subscriptions return an `unsubscribe()` handle; callers must call
 *  it on dispose to avoid leaks. */
export interface RpcAdapter {
  /** Subscribe to incoming messages. Returns a function that detaches
   *  the listener when invoked. */
  subscribe(listener: (message: unknown) => void): () => void;
  /** Fire-and-forget send. Resolves when the platform accepted the
   *  message (or silently when no listener is reachable). Errors are
   *  swallowed — broadcasts are advisory. */
  send(message: unknown): Promise<void>;
}

/** Browser navigation abstraction.
 *
 *  Webclient binding: a single-tab router push for in-app routes +
 *  `window.open` for external URLs.
 *
 *  `openOptionsPage` is optional and unused at present — it was a
 *  carve-out for surfaces with a separate Options host; callers
 *  should fall back to `openUrl` with a deep link when needed. */
export interface TabAdapter {
  /** Open a separate Options page. Returns a promise that resolves
   *  when the page has been opened (or silently when the surface does
   *  not have one). */
  openOptionsPage?(): Promise<void>;
  /** Open `url` in a new tab / window. Always available. */
  openUrl(url: string): Promise<void>;
}

/** OAuth + identity flow abstraction. Declared here so all four
 *  canonical adapters live in one place.
 *
 *  Webclient binding: a top-level `window.location.assign` redirect
 *  followed by parsing the callback URL fragment on return — wired
 *  in Phase 4 + Phase 5 (cloud-pairing path 2). */
export interface IdentityAdapter {
  /** Launch an OAuth authorization flow against `authUrl` with the
   *  declared `redirectUri`. Resolves to the redirect URL the
   *  authorization server returned to (with the `code` / `state`
   *  query params attached). Rejects on user cancel or platform
   *  failure. */
  launchOAuth(authUrl: string, redirectUri: string): Promise<string>;
  /** Stable redirect URI this surface registers. The webclient uses
   *  an absolute origin URL. */
  getRedirectUri(): string;
}

/** Convenience bundle of the four adapters. Surfaces typically
 *  construct one instance at boot and pass it through to consumers
 *  that need any subset. */
export interface RuntimeAdapters {
  storage: StorageAdapter;
  rpc: RpcAdapter;
  tab: TabAdapter;
  identity: IdentityAdapter;
}
