/** D-165 follow-on — Settings → Connections operation-group grant panel.
 *
 *  The PWA surface that makes `write → ask` reachable in-product. Write
 *  operations on a catalog connection are never auto-granted (Invariant 3
 *  — the enrolment boot seed admits read-tier ops only), so a recipe step
 *  that calls e.g. `contact.update` is denied `operation_not_granted`
 *  until the user explicitly grants the operation GROUP it belongs to.
 *  Before this panel there was no surface to do that; the grant rpc family
 *  (`collection.connection.{grant,revoke,list}OperationGroup`, returning an
 *  `OperationGroupGrantView`) shipped server-side in the same D-165 arc but
 *  had no consumer. This panel is that consumer.
 *
 *  ── Two-level data model: connections → operation groups ─────────────
 *  On mount the panel lists the user's API connections (`collection.connection.
 *  list` is bound to `{ kind: 'api' }` in production), then fans out one
 *  `listOperationGroups` read per API connection to fetch its available groups
 *  + per-group `granted` flags. Each API connection renders as a card; resolved
 *  catalog operation groups render as rows inside it, and unresolved candidates
 *  show a card-local error.
 *
 *  Grantable is intentionally SERVER-resolved. Registered vendors still resolve
 *  through the contracts registry (HubSpot / Salesforce), while D-170 local
 *  composition catalogs resolve through the install-recorded
 *  connection->catalog binding (`resolveLocalCatalog`) and therefore have no
 *  browser-visible vendor registry entry. The panel only filters to API
 *  connections and lets `listOperationGroups` be the effective gate. A
 *  per-connection read failure is caught and surfaced as a card-local error
 *  chip, so an API connection with no operation catalog degrades to "could not
 *  load permissions" rather than wiping the panel.
 *
 *  ── No live broadcast subscription (unlike the Approvals panel) ──────
 *  Connection enrolment / grant / revoke do NOT emit a D-121 broadcast
 *  event (the connection record syncs over the pair-sync wire, not the
 *  realtime bus), so — unlike `asks-panel.ts` — this panel takes no
 *  `subscribe` seam. It stays current two ways instead: (1) every
 *  grant / revoke rpc RETURNS the connection's fresh `OperationGroupGrant
 *  View`, which the toggle handler writes straight back into that card's
 *  state (no re-fetch, no read-after-write race); (2) `refresh()` on the
 *  handle re-lists for host-driven reloads (e.g. after enrolling a new
 *  connection elsewhere). The `loadGeneration` guard (shared discipline
 *  with packs / asks / the cache card) drops a stale in-flight re-list when
 *  a newer one overtakes it.
 *
 *  ── Concurrency (two races, both closed — see Codex review) ──────────
 *  (1) Per-connection serialization. Each grant / revoke response carries
 *  the connection's FULL fresh view, so two responses for the SAME
 *  connection landing out of order would let the older clobber the newer
 *  (dropping a group's update). So a mutation is allowed one-at-a-time per
 *  connection (`pendingByConnection`): while one is in flight, EVERY toggle
 *  in that card is aria-disabled and inert but remains focusable. Toggles on
 *  DIFFERENT connections still run concurrently (independent server records /
 *  cards).
 *  (2) A toggle bumps `loadGeneration` at start, invalidating any older
 *  in-flight `runListConnections` so its (pre-mutation) write can't overwrite
 *  the toggle's authoritative result. A refresh started AFTER the toggle
 *  keeps the newest gen and still wins — it re-fetches the post-mutation view.
 *
 *  ── Read groups are informational, not toggles ──────────────────────
 *  A read-tier group's operations are auto-granted (Invariant 3) regardless
 *  of any explicit group grant, so the group's `granted` flag is `false`
 *  yet its ops are already in `allowed_operations`. Rendering a "Grant"
 *  button for it would be misleading (clicking adds a redundant store row
 *  that changes nothing the gateway resolves). So read-floor groups render
 *  as a non-interactive "Always allowed" row; only write-floor (and any
 *  unspecified-floor) groups render an actual grant / revoke toggle — which
 *  is the whole point of the surface.
 *
 *  ── Render model: DOM nodes, not innerHTML ──────────────────────────
 *  The toggle buttons carry real click listeners, so the panel rebuilds its
 *  content via `createElement` + `clearChildren` on every render (the same
 *  shape as `asks-panel.ts` / the bridge side-panel mount), not via an HTML
 *  string with `data-action` delegation.
 *
 *  Spec: D-165 (operation-group grant surface); the rpc shapes
 *  live in `packages/contracts/src/ingredient-catalog.ts`
 *  (`OperationGroupGrantView` / `OperationGroupGrantState`). */

import type {
  ConnectionView,
  OperationGroupGrantState,
  OperationGroupGrantView,
} from '@recued/contracts';

// ════════════════════════════════════════════════════════════════
// Caller seams + handle
// ════════════════════════════════════════════════════════════════

/** `collection.connection.list` caller seam. Production wires it bound to
 *  `{ kind: 'api' }`; the panel still filters to API connections itself, so a
 *  caller that lists every kind is also safe. */
export type ConnectionsListCaller = () => Promise<{
  connections: ReadonlyArray<ConnectionView>;
}>;

/** `collection.connection.listOperationGroups` caller seam — one read per API
 *  connection candidate. Returns every catalog group flagged `granted`. */
export type ConnectionsListGroupsCaller = (args: {
  name: string;
  kind: 'api';
}) => Promise<OperationGroupGrantView>;

/** `collection.connection.grantOperationGroup` caller seam. Returns the
 *  connection's FRESH grant view (the toggle handler writes it straight
 *  back — no re-fetch). */
export type ConnectionsGrantGroupCaller = (args: {
  name: string;
  kind: 'api';
  group_id: string;
}) => Promise<OperationGroupGrantView>;

/** `collection.connection.revokeOperationGroup` caller seam. Same fresh-view
 *  return contract as grant. */
export type ConnectionsRevokeGroupCaller = (args: {
  name: string;
  kind: 'api';
  group_id: string;
}) => Promise<OperationGroupGrantView>;

export type ConnectionsGrantPanelState = 'loading' | 'ready' | 'error';

export interface MountConnectionsGrantPanelOptions {
  /** Host element the panel renders into. The panel appends a single
   *  wrapper div + rebuilds its inner contents across state changes.
   *  `dispose()` drops the wrapper. */
  host: HTMLElement;
  /** DOM document seam. Defaults to `globalThis.document`. */
  document?: Document;
  /** `collection.connection.list` caller seam. */
  runListConnections: ConnectionsListCaller;
  /** `collection.connection.listOperationGroups` caller seam. */
  runListGroups: ConnectionsListGroupsCaller;
  /** `collection.connection.grantOperationGroup` caller seam. */
  runGrant: ConnectionsGrantGroupCaller;
  /** `collection.connection.revokeOperationGroup` caller seam. */
  runRevoke: ConnectionsRevokeGroupCaller;
}

/** One API connection candidate's row in the panel — the connection plus the
 *  result of its `listOperationGroups` read (`view`), or the read error
 *  (`groupsError`). Exactly one of `view` / `groupsError` is non-null after a
 *  settled load. */
export interface ConnectionGrantRow {
  connection: ConnectionView;
  view: OperationGroupGrantView | null;
  groupsError: string | null;
}

export interface ConnectionsGrantPanelMount {
  /** Current panel state — primary surface for tests + host introspection. */
  getState(): ConnectionsGrantPanelState;
  /** The API connection rows in display order. On a refresh failure
   *  the prior rows are RETAINED beneath the error chip (a transient
   *  failure must not wipe grants the user can still toggle), so this is
   *  empty only before the first successful load, or after a successful
   *  load that found zero API connections. */
  getConnections(): ReadonlyArray<ConnectionGrantRow>;
  /** Top-level connection-list error message. Null when the last list
   *  succeeded (a PER-connection group-read failure lives on its row's
   *  `groupsError`, not here). */
  getListError(): string | null;
  /** Host-driven refresh — re-lists connections + re-reads every API
   *  connection's groups. Returns the load promise. */
  refresh(): Promise<void>;
  /** Initial load promise — resolves after the most recent list+fan-out
   *  settles (success → `'ready'`, list failure → `'error'`). */
  whenLoaded(): Promise<void>;
  /** True while at least one connection owns an unresolved grant/revoke
   *  mutation. The route uses this to guard navigation that would detach the
   *  visible action owner before the server outcome is known. */
  hasInFlightWork(): boolean;
  /** Flip one group's grant on a connection — the same path a toggle click
   *  drives (looks up the current `granted` state, calls grant or revoke,
   *  writes the fresh view back). A no-op for an unknown connection / group,
   *  a read-floor (auto-granted) group, or a connection that already has a
   *  mutation in flight. Test seam + host convenience; awaits the rpc + the
   *  resulting re-render. */
  toggleGroup(connectionName: string, groupId: string): Promise<void>;
  /** Tear down the panel DOM. Idempotent. */
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// Attribute constants — stable hooks for tests + the Settings shell
// ════════════════════════════════════════════════════════════════

/** Wrapper the panel owns inside the caller's host. */
export const CONNECTIONS_GRANT_PANEL_HOST_ATTR =
  'data-recued-connections-grant-panel';
/** The loading line (first list in flight). */
export const CONNECTIONS_GRANT_PANEL_LOADING_ATTR =
  'data-recued-connections-grant-loading';
/** The empty-state line (ready, zero API connections). */
export const CONNECTIONS_GRANT_PANEL_EMPTY_ATTR =
  'data-recued-connections-grant-empty';
/** The top-level list-error chip (a `runListConnections` failure). */
export const CONNECTIONS_GRANT_PANEL_ERROR_ATTR =
  'data-recued-connections-grant-error';
/** One API connection candidate's card. Carries `data-connection-name`. */
export const CONNECTIONS_GRANT_CARD_ATTR = 'data-recued-conn-grant-card';
/** A grant / revoke toggle button. Carries `data-connection-name`,
 *  `data-group-id`, `data-granted`, and `aria-pressed`. */
export const CONNECTIONS_GRANT_TOGGLE_ATTR = 'data-recued-conn-grant-toggle';
/** A per-connection group-read error chip (a `listOperationGroups` /
 *  grant / revoke failure scoped to one card). */
export const CONNECTIONS_GRANT_GROUP_ERROR_ATTR =
  'data-recued-conn-grant-group-error';

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════

interface InternalState {
  phase: ConnectionsGrantPanelState;
  rows: ReadonlyArray<ConnectionGrantRow>;
  listError: string | null;
}

interface GrantToggleFocusTarget {
  connectionName: string;
  groupId: string;
}

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const isGrantCandidate = (c: ConnectionView): boolean => c.kind === 'api';

/** A read-tier group is auto-granted (Invariant 3) — it renders as an
 *  informational "Always allowed" row, never a toggle. */
const isAutoGrantedGroup = (g: OperationGroupGrantState): boolean =>
  g.risk_floor === 'read';

/** Catalog-local label for a fully-qualified group id — drops the
 *  `<publisher>/` prefix (`recued-core/hubspot.contacts.write` →
 *  `hubspot.contacts.write`). */
const groupLabel = (groupId: string): string => {
  const slash = groupId.lastIndexOf('/');
  return slash >= 0 ? groupId.slice(slash + 1) : groupId;
};

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

export const mountConnectionsGrantPanel = (
  opts: MountConnectionsGrantPanelOptions,
): ConnectionsGrantPanelMount => {
  const doc =
    opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountConnectionsGrantPanel: no document available — pass `opts.document` for non-browser environments',
    );
  }

  let state: InternalState = { phase: 'loading', rows: [], listError: null };
  let disposed = false;
  // Bumped before every `runListConnections` await; the post-await write only
  // lands when its captured generation is still current. A toggle ALSO bumps
  // it (runToggle below) so a slow refresh started before the toggle drops
  // its now-stale write instead of clobbering the toggle's result.
  let loadGeneration = 0;
  let pendingLoad: Promise<void> = Promise.resolve();
  // Connections with a grant/revoke rpc in flight, mapped to the group_id
  // being toggled. Serialized PER CONNECTION (not per group): each rpc
  // returns the connection's FULL fresh view, so two concurrent toggles on
  // different groups of the same connection could land out of order and the
  // older response would clobber the newer one. While a connection has a
  // mutation in flight, ALL its toggles render aria-disabled + inert; the
  // mapped group shows the in-flight label and owns aria-busy.
  const pendingByConnection = new Map<string, string>();

  const root = doc.createElement('div');
  root.setAttribute(CONNECTIONS_GRANT_PANEL_HOST_ATTR, '');
  opts.host.appendChild(root);

  const clearChildren = (node: HTMLElement): void => {
    while (node.firstChild) node.removeChild(node.firstChild);
  };

  const captureToggleFocus = (): GrantToggleFocusTarget | null => {
    const active = doc.activeElement as HTMLElement | null | undefined;
    if (
      active === null
      || active === undefined
      || !root.contains(active)
      || !active.hasAttribute(CONNECTIONS_GRANT_TOGGLE_ATTR)
    ) {
      return null;
    }
    const connectionName = active.getAttribute('data-connection-name');
    const groupId = active.getAttribute('data-group-id');
    return connectionName !== null && groupId !== null
      ? { connectionName, groupId }
      : null;
  };

  const findToggle = (
    node: HTMLElement,
    target: GrantToggleFocusTarget,
  ): HTMLElement | null => {
    if (
      node.hasAttribute(CONNECTIONS_GRANT_TOGGLE_ATTR)
      && node.getAttribute('data-connection-name') === target.connectionName
      && node.getAttribute('data-group-id') === target.groupId
    ) {
      return node;
    }
    for (const child of Array.from(node.children)) {
      const found = findToggle(child as HTMLElement, target);
      if (found !== null) return found;
    }
    return null;
  };

  const restoreToggleFocus = (
    target: GrantToggleFocusTarget | null,
  ): void => {
    if (target === null) return;
    try {
      findToggle(root, target)?.focus({ preventScroll: true });
    } catch {
      // A detached test DOM or a browser removing the route concurrently can
      // reject focus. The route transition owns focus in that case.
    }
  };

  const appendLine = (
    parent: HTMLElement,
    attr: string,
    className: string,
    text: string,
  ): void => {
    const line = doc.createElement('div');
    line.setAttribute(attr, '');
    line.className = className;
    line.textContent = text;
    parent.appendChild(line);
  };

  const renderGroupRow = (
    card: HTMLElement,
    connectionName: string,
    connectionDisplayName: string,
    group: OperationGroupGrantState,
  ): void => {
    const groupRow = doc.createElement('div');
    groupRow.className = 'conn-grant-group';
    groupRow.setAttribute('data-group-id', group.group_id);

    const info = doc.createElement('div');
    info.className = 'conn-grant-group-info';

    const label = doc.createElement('span');
    label.className = 'conn-grant-group-id';
    label.textContent = groupLabel(group.group_id);
    info.appendChild(label);

    if (group.operations.length > 0) {
      const ops = doc.createElement('span');
      ops.className = 'conn-grant-group-ops';
      ops.textContent = `Unlocks: ${group.operations.join(', ')}`;
      info.appendChild(ops);
    }

    if (group.risk_floor !== undefined) {
      const risk = doc.createElement('span');
      risk.className = 'conn-grant-risk';
      risk.setAttribute('data-risk-floor', group.risk_floor);
      risk.textContent = group.risk_floor;
      info.appendChild(risk);
    }
    groupRow.appendChild(info);

    if (isAutoGrantedGroup(group)) {
      // Read-tier — auto-granted, no toggle.
      const note = doc.createElement('span');
      note.className = 'conn-grant-auto';
      note.textContent = 'Always allowed';
      groupRow.appendChild(note);
      card.appendChild(groupRow);
      return;
    }

    const toggle = doc.createElement('button');
    toggle.setAttribute(CONNECTIONS_GRANT_TOGGLE_ATTR, '');
    toggle.setAttribute('type', 'button');
    toggle.setAttribute('data-connection-name', connectionName);
    toggle.setAttribute('data-group-id', group.group_id);
    toggle.setAttribute('data-granted', group.granted ? 'true' : 'false');
    toggle.setAttribute('aria-pressed', group.granted ? 'true' : 'false');
    toggle.className = group.granted
      ? 'conn-grant-toggle granted'
      : 'conn-grant-toggle';
    toggle.textContent = group.granted ? 'Revoke' : 'Grant';
    const pendingGroup = pendingByConnection.get(connectionName);
    const accessibleTarget =
      `${groupLabel(group.group_id)} for ${connectionDisplayName} (${connectionName})`;
    if (pendingGroup !== undefined) {
      // A mutation is in flight on this connection. Every toggle is inert, but
      // stays in the tab order so rebuilding the card does not discard the
      // keyboard action owner. Only the exact writer announces itself busy.
      toggle.setAttribute('aria-disabled', 'true');
      if (pendingGroup === group.group_id) {
        toggle.setAttribute('aria-busy', 'true');
        toggle.textContent = group.granted ? 'Revoking…' : 'Granting…';
      }
    } else {
      toggle.addEventListener('click', () => {
        void runToggle(connectionName, group.group_id, group.granted);
      });
    }
    toggle.setAttribute(
      'aria-label',
      `${pendingGroup === group.group_id
        ? (group.granted ? 'Revoking…' : 'Granting…')
        : (group.granted ? 'Revoke' : 'Grant')} ${accessibleTarget}`,
    );
    groupRow.appendChild(toggle);
    card.appendChild(groupRow);
  };

  const renderCard = (row: ConnectionGrantRow): void => {
    const card = doc.createElement('div');
    card.setAttribute(CONNECTIONS_GRANT_CARD_ATTR, '');
    card.setAttribute('data-connection-name', row.connection.name);

    const header = doc.createElement('div');
    header.className = 'conn-grant-header';
    const title = doc.createElement('strong');
    title.className = 'conn-grant-display';
    title.textContent = row.connection.display_name;
    header.appendChild(title);
    const name = doc.createElement('span');
    name.className = 'conn-grant-name';
    name.textContent = row.connection.name;
    header.appendChild(name);
    card.appendChild(header);

    if (row.groupsError !== null) {
      appendLine(
        card,
        CONNECTIONS_GRANT_GROUP_ERROR_ATTR,
        'conn-grant-group-error',
        `Could not load permissions: ${row.groupsError}`,
      );
    }

    if (row.view !== null) {
      for (const group of row.view.available_groups) {
        renderGroupRow(
          card,
          row.connection.name,
          row.connection.display_name,
          group,
        );
      }
    }
    root.appendChild(card);
  };

  const render = (focusTarget: GrantToggleFocusTarget | null = null): void => {
    if (disposed) return;
    clearChildren(root);

    // A list error surfaces as a chip ABOVE any still-visible cards — a
    // transient re-list failure shows the chip without wiping the grants
    // the user can still act on.
    if (state.listError !== null) {
      appendLine(
        root,
        CONNECTIONS_GRANT_PANEL_ERROR_ATTR,
        'conn-grant-error',
        `Could not load connections: ${state.listError}`,
      );
    }

    if (state.rows.length > 0) {
      for (const row of state.rows) renderCard(row);
      restoreToggleFocus(focusTarget);
      return;
    }

    if (state.phase === 'loading') {
      appendLine(
        root,
        CONNECTIONS_GRANT_PANEL_LOADING_ATTR,
        'conn-grant-loading',
        'Loading connections…',
      );
      restoreToggleFocus(focusTarget);
      return;
    }
    if (state.phase === 'ready') {
      appendLine(
        root,
        CONNECTIONS_GRANT_PANEL_EMPTY_ATTR,
        'conn-grant-empty',
        'No API connections. Vendor and private/local catalog connections you can grant operation permissions to appear here.',
      );
    }
    // phase === 'error' with zero rows → the error chip above is the whole
    // surface; no empty / loading line.
    restoreToggleFocus(focusTarget);
  };

  const doRefresh = (): Promise<void> => {
    const gen = ++loadGeneration;
    pendingLoad = (async () => {
      try {
        const { connections } = await opts.runListConnections();
        if (disposed || gen !== loadGeneration) return; // stale / torn down
        const apiConnections = connections.filter(isGrantCandidate);
        // Fan out one group-read per API connection. The server resolves whether
        // the connection has a registered-vendor catalog or a D-170 local/private
        // catalog binding. A single read's
        // failure degrades to a card-local error chip, never the whole list.
        const rows = await Promise.all(
          apiConnections.map(async (connection): Promise<ConnectionGrantRow> => {
            try {
              const view = await opts.runListGroups({
                name: connection.name,
                kind: 'api',
              });
              return { connection, view, groupsError: null };
            } catch (err) {
              return {
                connection,
                view: null,
                groupsError: errMessage(err),
              };
            }
          }),
        );
        if (disposed || gen !== loadGeneration) return;
        state = { phase: 'ready', rows, listError: null };
        render(captureToggleFocus());
      } catch (err) {
        if (disposed || gen !== loadGeneration) return;
        // Keep any currently-visible cards; surface the error as a chip.
        state = { phase: 'error', rows: state.rows, listError: errMessage(err) };
        render(captureToggleFocus());
      }
    })();
    return pendingLoad;
  };

  /** Flip one group's grant. Writes the FRESH view the rpc returns straight
   *  back into that connection's card (the rpc is the authority — no
   *  re-list). A grant / revoke failure surfaces on the card's group-error
   *  chip; the toggles re-enable either way. */
  const runToggle = async (
    connectionName: string,
    groupId: string,
    currentlyGranted: boolean,
  ): Promise<void> => {
    // One mutation in flight per connection (the response replaces the whole
    // connection view, so concurrent same-connection toggles can't be applied
    // safely). Defense-in-depth: the card's toggles also render aria-disabled
    // and without listeners while the write is pending.
    if (pendingByConnection.has(connectionName)) return;
    const focusTarget = captureToggleFocus();
    pendingByConnection.set(connectionName, groupId);
    // Invalidate any in-flight `runListConnections` so its (now-stale) write
    // can't clobber this mutation's authoritative result when it lands after
    // us. A refresh started AFTER this toggle keeps the latest gen + still
    // wins (it re-fetches the post-mutation view). doRefresh checks this gen;
    // runToggle writes its own card unconditionally (the `disposed` check
    // aside).
    loadGeneration += 1;
    render(focusTarget);
    try {
      const fresh = currentlyGranted
        ? await opts.runRevoke({ name: connectionName, kind: 'api', group_id: groupId })
        : await opts.runGrant({ name: connectionName, kind: 'api', group_id: groupId });
      if (disposed) return;
      state = {
        ...state,
        rows: state.rows.map((r) =>
          r.connection.name === connectionName
            ? { ...r, view: fresh, groupsError: null }
            : r,
        ),
      };
    } catch (err) {
      if (disposed) return;
      const message = errMessage(err);
      state = {
        ...state,
        rows: state.rows.map((r) =>
          r.connection.name === connectionName
            ? { ...r, groupsError: message }
            : r,
        ),
      };
    } finally {
      // Respect deliberate focus movement during the await. If focus remains
      // on a panel toggle, carry that exact identity through the final rebuild;
      // if it moved outside the panel, do not steal it back.
      const finalFocusTarget = captureToggleFocus();
      pendingByConnection.delete(connectionName);
      if (!disposed) render(finalFocusTarget);
    }
  };

  // ── Initial paint + seed load ────────────────────────────────────
  render();
  void doRefresh();

  return {
    getState: () => state.phase,
    getConnections: () => state.rows,
    getListError: () => state.listError,
    refresh: () => doRefresh(),
    whenLoaded: () => pendingLoad,
    hasInFlightWork: () => pendingByConnection.size > 0,
    toggleGroup: async (connectionName, groupId) => {
      const row = state.rows.find(
        (r) => r.connection.name === connectionName,
      );
      const group = row?.view?.available_groups.find(
        (g) => g.group_id === groupId,
      );
      // No-op for an unknown connection / group or a read-floor (auto-
      // granted) group — those render no toggle. (A connection already
      // mutating is also a no-op, guarded inside runToggle.)
      if (group === undefined || isAutoGrantedGroup(group)) return;
      await runToggle(connectionName, groupId, group.granted);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        opts.host.removeChild(root);
      } catch {
        // Some fake DOMs / a detached host throw on removeChild; ignore —
        // the host is the caller's to retain or discard.
      }
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════

/** Self-scoped CSS for the Connections grant section, scoped under
 *  `[data-recued-connections-grant-panel]` so the rules are inert when the
 *  section isn't mounted. The settings route joins this into its one
 *  `<style>` bundle (mirrors `ASKS_PANEL_STYLES`). */
export const CONNECTIONS_GRANT_PANEL_STYLES = `
[data-recued-connections-grant-panel] {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
}
[data-recued-connections-grant-panel] .conn-grant-loading,
[data-recued-connections-grant-panel] .conn-grant-empty {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 13px;
  color: var(--muted);
  padding: 6px 2px;
}
[data-recued-connections-grant-panel] .conn-grant-error,
[data-recued-connections-grant-panel] .conn-grant-group-error {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 13px;
  color: var(--fail);
  padding: 6px 2px;
}
[data-recued-connections-grant-panel] [${CONNECTIONS_GRANT_CARD_ATTR}] {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin: 8px 0;
}
[data-recued-connections-grant-panel] .conn-grant-header {
  min-width: 0;
  max-width: 100%;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 6px;
}
[data-recued-connections-grant-panel] .conn-grant-display {
  min-width: 0;
  overflow-wrap: anywhere;
}
[data-recued-connections-grant-panel] .conn-grant-name {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
  font-size: 12px;
  color: var(--muted);
  font-family: var(--mono, ui-monospace, monospace);
}
[data-recued-connections-grant-panel] .conn-grant-group {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  border-top: 1px solid var(--border-subtle);
}
[data-recued-connections-grant-panel] .conn-grant-group-info {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  max-width: 100%;
}
[data-recued-connections-grant-panel] .conn-grant-group-id {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 13px;
  font-family: var(--mono, ui-monospace, monospace);
}
[data-recued-connections-grant-panel] .conn-grant-group-ops {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 12px;
  color: var(--muted);
}
[data-recued-connections-grant-panel] .conn-grant-risk {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
}
[data-recued-connections-grant-panel] .conn-grant-risk[data-risk-floor='write'] {
  color: var(--warn);
}
[data-recued-connections-grant-panel] .conn-grant-auto {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
[data-recued-connections-grant-panel] .conn-grant-toggle {
  box-sizing: border-box;
  flex: 0 0 auto;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  cursor: pointer;
  white-space: nowrap;
}
[data-recued-connections-grant-panel] .conn-grant-toggle.granted {
  border-color: var(--warn);
  color: var(--warn);
}
[data-recued-connections-grant-panel] .conn-grant-toggle[aria-disabled='true'] {
  opacity: 0.6;
  cursor: default;
}
@media (max-width: 520px) {
  [data-recued-connections-grant-panel] .conn-grant-header {
    align-items: stretch;
    flex-direction: column;
    gap: 2px;
  }
  [data-recued-connections-grant-panel] .conn-grant-group {
    align-items: flex-start;
  }
}
`;
