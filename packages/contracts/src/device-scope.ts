/** D-119 Phase 5 — UI device scope router.
 *
 *  The sidebar scope-switcher (top-bar Devices Dropdown) selects which
 *  device's recipe list / settings / history to render. Three kinds:
 *
 *    - `local`           — this extension's own data (IDB)
 *    - `server:<id>`     — paired server's recipes (pair WS)
 *    - `remote-ext:<id>` — another extension's heartbeat-only thin view
 *
 *  Stored as a tagged object so callers don't string-parse `${kind}:${id}`
 *  at every read site. Round-trip helpers serialize to / from the wire
 *  string form for storage (`chrome.storage.local`) and for the
 *  dropdown's `data-device-id` attribute, which is the only public
 *  identifier the renderer carries.
 *
 *  Naming intent: this is *device* scope (which physical / virtual
 *  device's data is on screen), distinct from vault scope (publisher
 *  isolation in `scope.ts` / `bundle.ts`). A user with an extension +
 *  paired server has 2 scopes; a Pro multi-device user has more. The
 *  default is always `local` — the device the sidebar is rendering on.
 *
 *  Pure module. No side effects. */

/** Fixed wire string for the local extension. Matches the
 *  `data-device-id` value the Devices Dropdown sets on the self row. */
export const DEVICE_SCOPE_LOCAL_ID = 'this-extension' as const;

/** The currently-viewed device. Default `'local'` for the rendering
 *  extension itself; `'server'` and `'remote-ext'` carry the target
 *  device id so the data-source switch in the sidebar knows which
 *  pair-WS / heartbeat row to read from. */
export type DeviceScope =
  | { kind: 'local' }
  | { kind: 'server'; id: string }
  | { kind: 'remote-ext'; id: string };

/** The default scope for a freshly-mounted sidebar — the local
 *  extension itself. Storage / pick-device action overrides as needed. */
export const DEFAULT_DEVICE_SCOPE: DeviceScope = { kind: 'local' };

/** Parse a device-id string (the form the dropdown writes into
 *  `data-device-id`) into a typed `DeviceScope`. Returns `null` on
 *  malformed input — callers fall back to `DEFAULT_DEVICE_SCOPE`.
 *
 *  Wire form:
 *    - `'this-extension'`         → `{ kind: 'local' }`
 *    - `'server:<id>'`            → `{ kind: 'server', id }`
 *    - `'remote-ext:<id>'`        → `{ kind: 'remote-ext', id }`
 *
 *  The Phase 3 dropdown emitted `'paired-server'` for the single
 *  paired-server row; Phase 5 normalizes that to the typed form by
 *  also accepting the literal `'paired-server'` as `{ kind: 'server',
 *  id: 'paired-server' }`. There is at most one paired server per
 *  extension, so a fixed id keeps the dropdown's existing wire format
 *  without introducing a new id source. */
export function parseDeviceScope(id: string): DeviceScope | null {
  if (typeof id !== 'string' || id.length === 0) return null;
  if (id === DEVICE_SCOPE_LOCAL_ID) return { kind: 'local' };
  if (id === 'paired-server') return { kind: 'server', id: 'paired-server' };
  // Allow `<instance-id>:server` (the Phase 3 row id for a remote-ext's
  // own paired server) → server scope keyed off the remote ext's id.
  if (id.endsWith(':server')) {
    const ext = id.slice(0, -':server'.length);
    if (ext.length === 0) return null;
    return { kind: 'server', id };
  }
  if (id.startsWith('server:')) {
    const rest = id.slice('server:'.length);
    if (rest.length === 0) return null;
    return { kind: 'server', id: rest };
  }
  if (id.startsWith('remote-ext:')) {
    const rest = id.slice('remote-ext:'.length);
    if (rest.length === 0) return null;
    return { kind: 'remote-ext', id: rest };
  }
  // Bare instance ids (UUIDs / handles emitted by the Phase 3 dropdown
  // for remote-ext rows) — treat as remote-ext.
  return { kind: 'remote-ext', id };
}

/** Serialize a `DeviceScope` to the wire form storable in
 *  `chrome.storage.local` and round-trippable through
 *  `parseDeviceScope`. The local form is the fixed
 *  `DEVICE_SCOPE_LOCAL_ID` so it matches the Phase 3 dropdown's
 *  `data-device-id` exactly. */
export function serializeDeviceScope(scope: DeviceScope): string {
  switch (scope.kind) {
    case 'local':
      return DEVICE_SCOPE_LOCAL_ID;
    case 'server':
      // Preserve the Phase 3 fixed id for the single-paired-server case
      // so the dropdown's current = scope check still works.
      if (scope.id === 'paired-server') return 'paired-server';
      // `<ext-id>:server` form is already prefixed correctly.
      if (scope.id.endsWith(':server')) return scope.id;
      return `server:${scope.id}`;
    case 'remote-ext':
      return `remote-ext:${scope.id}`;
  }
}

/** True when two scopes refer to the same device. Used by the
 *  Devices Dropdown to render the `current` checkmark and by the
 *  scope router to avoid no-op state churn on re-pick. */
export function deviceScopeEquals(a: DeviceScope, b: DeviceScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'local') return true;
  return (a as { id: string }).id === (b as { id: string }).id;
}

/** Discriminator for the per-scope sidebar tabs. The spec gives:
 *
 *    - `local`      → `Recipes | ⚙ Settings`
 *    - `server`     → `Recipes | Dashboard | Warehouse | ⚙ Settings`
 *    - `remote-ext` → `Recipes` only (no Settings, no Warehouse,
 *                     limited heartbeat-only view)
 *
 *  This helper centralizes that decision so callers (sidebar tabs,
 *  picker, gear icon) read one source of truth. Returned tabs are
 *  ordered the way they should render. */
export type DeviceScopeTab = 'recipes' | 'dashboard' | 'warehouse' | 'settings';

export function deviceScopeTabs(scope: DeviceScope): DeviceScopeTab[] {
  switch (scope.kind) {
    case 'local':
      return ['recipes', 'settings'];
    case 'server':
      return ['recipes', 'dashboard', 'warehouse', 'settings'];
    case 'remote-ext':
      return ['recipes'];
  }
}

/** True when the scope supports a Settings panel (gear icon). Local +
 *  server only; remote-ext is limited-view by design (open Recued on
 *  that device for full state). */
export function deviceScopeHasSettings(scope: DeviceScope): boolean {
  return scope.kind === 'local' || scope.kind === 'server';
}

/** True when the scope renders the limited-view banner ("📡 Limited
 *  view — open Recued on <Name>…"). Remote-ext only. */
export function deviceScopeIsLimitedView(scope: DeviceScope): boolean {
  return scope.kind === 'remote-ext';
}
