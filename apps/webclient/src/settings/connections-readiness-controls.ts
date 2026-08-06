/** Connections readiness — pack-row "connection scope coverage" block.
 *
 *  A self-contained, READ-ONLY controller (the simpler sibling of
 *  `supervision-controls.ts`): the packs panel instantiates one, calls
 *  `refresh()` alongside its `packs.list` load, appends `renderForPack(pack)`
 *  per row, and `dispose()`s. Kept out of the 130 KB `packs-panel.ts`.
 *
 *  What it answers: for EVERY connection a pack's composition declares (the
 *  `declaredConnectionSlots` = any `http`/`connection`/`mcp` `connection` slot,
 *  scope-bearing OR not — an API-key connection like Stripe counts), is there an
 *  enrolled connection backing it (set up / not set up), and for a scope-bearing
 *  one, does it cover the pack's `required_scopes` (reuse) or is a scope missing
 *  (re-authorize)? This is the consumer of the D-? `granted_scopes` substrate.
 *
 *  Resolution = VENDOR-MATCH, consistent with the live runnability system
 *  (`resolveConnectionVendor` / `deriveBoundCrmConnections`): a pack ingredient's
 *  `http.connection` is the VENDOR (`hubspot`), and an enrolled api connection
 *  carries its vendor in `config.vendor` (flattened to `ConnectionView.vendor`).
 *  Any enrolled api connection with that vendor backs the slot (multi-account:
 *  several can — readiness reduces to the best). This is DISTINCT from the
 *  recipes route's `required-connections.ts`, which name-matches recipe
 *  `{{connection.<kind>.<name>}}` refs — a different binding mechanism.
 *
 *  Scope boundary: every declared connection (scope-bearing + API-key), each
 *  CTA deep-linking to the PRE-SELECTED enroll form —
 *  `#connections/others/enroll/<vendor>` opens the Others enroll panel with
 *  the vendor's form pre-filled (registered vendor → its vendor schema + the
 *  Fork-1 B scope union; API-key vendor → the bare api form seeded with
 *  `name` + the hidden `config.vendor` tag). READINESS, not an authz gate
 *  (the vendor owns OAuth-scope authz; the per-op contract grant is Recued's
 *  gate). */

import {
  declaredConnectionSlots,
  scopeCoverage,
  type ConnectionView,
  type PackListEntry,
} from '@recued/contracts';
import { serializeShellRoute } from '../shell/route.js';

/** `collection.connection.list` caller (unfiltered — we filter to `api`
 *  client-side). Shape matches the connections route's enroll-list caller. */
export type ConnectionsReadinessListCaller = () => Promise<{
  connections: ReadonlyArray<ConnectionView>;
}>;

export interface ConnectionsReadinessControllerOptions {
  /** DOM document seam (mirrors the packs panel's). */
  document: Document;
  /** `collection.connection.list` caller. Absent ⇒ the controller still renders
   *  the NEED + a "Set up" CTA but can't confirm enrollment (soft). */
  runConnectionList?: ConnectionsReadinessListCaller;
}

export interface ConnectionsReadinessController {
  /** True when the list caller is wired (enrollment status can be resolved). */
  readonly enabled: boolean;
  /** Load `collection.connection.list` into state. Called alongside the host's
   *  `packs.list` load. Generation-guarded — a stale load is dropped. A failed
   *  load leaves the cache null (renderForPack then degrades to need + CTA). */
  refresh(): Promise<void>;
  /** The readiness block for a pack, or null when the pack declares no
   *  scope-bearing connection. */
  renderForPack(pack: PackListEntry): HTMLElement | null;
  /** Test seam — the loaded connection list (null = not loaded / failed). */
  connections(): ReadonlyArray<ConnectionView> | null;
  dispose(): void;
}

/** Data attrs (stable test hooks). */
export const CONNECTIONS_READINESS_SECTION_ATTR = 'data-recued-connections-readiness';
export const CONNECTIONS_READINESS_ROW_ATTR = 'data-recued-connection-slot';
export const CONNECTIONS_READINESS_STATUS_ATTR = 'data-recued-connection-status';
export const CONNECTIONS_READINESS_CTA_ATTR = 'data-recued-connection-cta';

/** Per-slot readiness outcome. `status` is also the `data-…-status` value. */
type SlotStatus =
  | { status: 'not_set_up' }
  | { status: 'unknown_enrollment' }
  | { status: 'covered'; label: string }
  | { status: 'under_scoped'; label: string; missing: string[] }
  | { status: 'unverified'; label: string };

/** The connection list is keyed by name; the readiness layer keys by VENDOR.
 *  Mirror `resolveConnectionVendor` (config.vendor, else subtype). `vendor`
 *  rides the view's index signature (flattened config) so it reads as
 *  `unknown` — narrow it. */
const viewVendor = (v: ConnectionView): string | undefined => {
  const raw = (v as { vendor?: unknown }).vendor;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return typeof v.subtype === 'string' && v.subtype.length > 0 ? v.subtype : undefined;
};

const viewLabel = (v: ConnectionView): string =>
  (typeof v.display_name === 'string' && v.display_name.length > 0
    ? v.display_name
    : v.name);

/** Reduce the connections backing one vendor slot to a single status. Any
 *  covered connection wins (reuse); else the known connection with the FEWEST
 *  missing scopes (the closest to ready, the one to re-authorize); else
 *  unverified (enrolled but the granted set is unknown — a soft hint). */
const reduceStatus = (
  needed: string[],
  backing: ConnectionView[],
): SlotStatus => {
  if (backing.length === 0) return { status: 'not_set_up' };
  // No-scope slot (an API-key connection like Stripe declares a `connection` but
  // no OAuth `required_scopes`): an enrolled connection is fully ready — there is
  // nothing to verify, so don't fall through to the "scopes not verified" hint.
  if (needed.length === 0) return { status: 'covered', label: viewLabel(backing[0]) };
  let bestUnderScoped: { label: string; missing: string[] } | null = null;
  let firstUnverified: string | null = null;
  for (const conn of backing) {
    const cov = scopeCoverage(needed, conn.granted_scopes);
    const label = viewLabel(conn);
    if (cov.covered) return { status: 'covered', label };
    if (cov.known) {
      if (
        bestUnderScoped === null
        || cov.missing.length < bestUnderScoped.missing.length
      ) {
        bestUnderScoped = { label, missing: cov.missing };
      }
    } else if (firstUnverified === null) {
      firstUnverified = label;
    }
  }
  if (bestUnderScoped !== null) {
    return { status: 'under_scoped', ...bestUnderScoped };
  }
  return { status: 'unverified', label: firstUnverified ?? viewLabel(backing[0]) };
};

/** Resolve one slot's status from the loaded list (or `unknown_enrollment`
 *  when the list is unavailable). Exported for unit tests. */
export const resolveSlotStatus = (
  slot: string,
  needed: string[],
  connections: ReadonlyArray<ConnectionView> | null,
): SlotStatus => {
  if (connections === null) return { status: 'unknown_enrollment' };
  const backing = connections.filter(
    (c) => c.kind === 'api' && viewVendor(c) === slot,
  );
  return reduceStatus(needed, backing);
};

/** Status → user-facing line + whether a CTA shows + its verb. */
const STATUS_COPY: Record<
  SlotStatus['status'],
  { suffix: (s: SlotStatus) => string; cta: string | null }
> = {
  covered: { suffix: () => 'connected', cta: null },
  unverified: { suffix: () => 'connected · scopes not verified', cta: null },
  under_scoped: {
    suffix: (s) =>
      s.status === 'under_scoped'
        ? `connected · missing ${s.missing.join(', ')}`
        : 'connected',
    cta: 'Re-authorize',
  },
  not_set_up: { suffix: () => 'not set up', cta: 'Set up' },
  unknown_enrollment: { suffix: () => '', cta: 'Set up' },
};

export const CONNECTIONS_READINESS_STYLES = `
[${CONNECTIONS_READINESS_SECTION_ATTR}] {
  display: grid;
  min-width: 0;
  max-width: 100%;
  gap: 6px;
  margin: 10px 0 2px;
  padding-top: 8px;
  border-top: 1px solid var(--border, #e5e5e5);
}
[${CONNECTIONS_READINESS_SECTION_ATTR}] .packs-connections-heading {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted, #666);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  overflow-wrap: anywhere;
}
[${CONNECTIONS_READINESS_SECTION_ATTR}] .packs-connection-row {
  display: flex;
  min-width: 0;
  max-width: 100%;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
}
[${CONNECTIONS_READINESS_SECTION_ATTR}] .packs-connection-vendor {
  min-width: 0; max-width: 100%; font-weight: 600; overflow-wrap: anywhere;
}
[${CONNECTIONS_READINESS_SECTION_ATTR}] .packs-connection-status {
  flex: 1 1 140px; min-width: 0; max-width: 100%;
  color: var(--muted, #666); overflow-wrap: anywhere;
}
[${CONNECTIONS_READINESS_SECTION_ATTR}] .packs-connection-row[${CONNECTIONS_READINESS_STATUS_ATTR}="under_scoped"] .packs-connection-status,
[${CONNECTIONS_READINESS_SECTION_ATTR}] .packs-connection-row[${CONNECTIONS_READINESS_STATUS_ATTR}="not_set_up"] .packs-connection-status {
  color: var(--danger, #b3261e);
}
[${CONNECTIONS_READINESS_SECTION_ATTR}] .packs-connection-cta {
  box-sizing: border-box; display: inline-flex; flex: 0 0 auto;
  min-height: 36px; align-items: center; margin-left: auto; padding: 4px;
  border-radius: 6px; font-size: 12px;
}
[${CONNECTIONS_READINESS_SECTION_ATTR}] .packs-connection-cta:hover {
  background: var(--accent-weak);
}
@media (max-width: 640px) {
  [${CONNECTIONS_READINESS_SECTION_ATTR}] .packs-connection-cta { min-height: 44px; }
}
`;

export const createConnectionsReadinessController = (
  opts: ConnectionsReadinessControllerOptions,
): ConnectionsReadinessController => {
  const doc = opts.document;
  let connections: ConnectionView[] | null = null;
  let generation = 0;
  let disposed = false;

  const refresh = async (): Promise<void> => {
    if (disposed || opts.runConnectionList === undefined) return;
    const gen = ++generation;
    try {
      const res = await opts.runConnectionList();
      if (disposed || gen !== generation) return; // stale load dropped
      connections = [...res.connections];
    } catch {
      // Soft — leave the cache null; renderForPack degrades to need + CTA.
      if (disposed || gen !== generation) return;
      connections = null;
    }
  };

  const renderForPack = (pack: PackListEntry): HTMLElement | null => {
    // EVERY connection the pack binds (via `http`/`connection`/`mcp` `connection`),
    // not just OAuth-scope-bearing ones — so an API-key connection (Stripe) shows
    // a "set up" row too. Scope-bearing slots carry their scope union; no-scope
    // slots carry `[]` and reduce to a plain enrolled/not-set-up readiness.
    // No manifest ⇒ the pack is not installed, and its connection slots are
    // unknown rather than empty. Rendering nothing is the honest degradation;
    // an empty slot map would claim it binds no connections.
    if (pack.manifest === undefined) return null;
    const scopesBySlot = declaredConnectionSlots(pack.manifest);
    const slots = Object.keys(scopesBySlot).sort();
    if (slots.length === 0) return null; // pack binds no connection (cli/ai only)

    const section = doc.createElement('section');
    section.setAttribute(CONNECTIONS_READINESS_SECTION_ATTR, '');

    const heading = doc.createElement('p');
    heading.className = 'packs-connections-heading';
    heading.textContent = 'Connections';
    section.appendChild(heading);

    for (const slot of slots) {
      const needed = scopesBySlot[slot];
      const status = resolveSlotStatus(slot, needed, connections);
      const copy = STATUS_COPY[status.status];

      const row = doc.createElement('div');
      row.className = 'packs-connection-row';
      row.setAttribute(CONNECTIONS_READINESS_ROW_ATTR, slot);
      row.setAttribute(CONNECTIONS_READINESS_STATUS_ATTR, status.status);

      const vendor = doc.createElement('span');
      vendor.className = 'packs-connection-vendor';
      vendor.textContent = slot;
      row.appendChild(vendor);

      const suffix = copy.suffix(status);
      if (suffix.length > 0) {
        const statusEl = doc.createElement('span');
        statusEl.className = 'packs-connection-status';
        statusEl.textContent = `— ${suffix}`;
        row.appendChild(statusEl);
      }

      if (copy.cta !== null) {
        const cta = doc.createElement('a');
        cta.className = 'packs-connection-cta rx-link';
        cta.setAttribute(CONNECTIONS_READINESS_CTA_ATTR, status.status);
        // Deep link into the Others enroll form pre-selected for this vendor
        // (Set up AND Re-authorize — the pre-filled scope union is exactly
        // the re-authorize flow; granted scopes re-persist via enroll).
        cta.setAttribute(
          'href',
          serializeShellRoute('connections', 'others', 'enroll', slot),
        );
        cta.textContent = `${copy.cta} →`;
        row.appendChild(cta);
      }

      section.appendChild(row);
    }
    return section;
  };

  return {
    get enabled() {
      return opts.runConnectionList !== undefined;
    },
    refresh,
    renderForPack,
    connections: () => connections,
    dispose: () => {
      disposed = true;
      connections = null;
    },
  };
};
