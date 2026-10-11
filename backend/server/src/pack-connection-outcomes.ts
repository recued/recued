/** D-320 slice 2g (ruling 16) — where a pack's runs go when a connection leaves its
 *  list.
 *
 *  A run that names no connection takes its slot's default by the run's own rule
 *  (`execute-handler.ts`, `packConnectionFor`): of the connections bound to the
 *  slot's catalogs that are set up, one is the default by itself; with two or more
 *  the stored default decides (`storedSlotDefault`), and with none stored the run
 *  asks, and a scheduled run is refused.
 *
 *  So taking a connection off a list of two moves every such run to the other one.
 *  The Access tab's Remove and the Connections page's Delete used to say nothing of
 *  it. They now say what this module works out: the same rule, over the bindings
 *  without that connection. The Access tab's Default badge reads the same rule, so it
 *  shows the connection runs use, not a stored row a deletion left behind.
 *
 *  ⚠ AN EMPTY LIST IS NOT ALWAYS A STOP. With nothing on the list the run falls
 *  to the pick layer (`settleUnboundSlot`), whose candidates are every connection
 *  whose operation profile serves the catalog. A connection of a REGISTERED vendor
 *  (`CATALOG_VENDOR_SLUGS`: HubSpot, Salesforce, Pipedrive, Exa) serves its
 *  vendor's catalog whether or not it is on any list, so for those packs the
 *  owner's own runs go on: on the one such connection, or asking among several. A
 *  scheduled run (`actor: 'system'`) is refused whenever it would have to pick,
 *  so it stops either way. Found building this slice; the dialog says it as it
 *  is (`no_list`). */

import { storedSlotDefault } from './storage/pack-connection-default-store.js';

type Scan = Parameters<typeof storedSlotDefault>[0];
type Binding = Parameters<typeof storedSlotDefault>[2][number];

/** The connection a run that names no connection uses for a slot: one set-up
 *  connection bound to the slot's catalogs is the default by itself; two or more
 *  take the stored one, or none. `bindings` are the rows for `catalogs`. */
export const effectiveSlotDefault = (
  scan: Scan,
  catalogs: readonly string[],
  bindings: readonly Binding[],
  enrolled: ReadonlySet<string>,
): string | undefined => {
  const setUp = bindings.filter((binding) => enrolled.has(binding.connection_name));
  const held = [...new Set(setUp.map((binding) => binding.connection_name))];
  if (held.length <= 1) return held[0];
  return storedSlotDefault(scan, catalogs, setUp);
};

/** What removing one connection does to a slot's runs that name no connection.
 *  - `moves`: they use another connection from now on (`after`).
 *  - `no_default`: two or more connections are left and none is the default, so owner
 *    runs ask and scheduled runs are refused until one is chosen.
 *  - `no_list`: nothing is left on the list, but set-up connections of a registered
 *    vendor still serve the pack (`fallback`): scheduled runs stop, the owner's
 *    own runs use the one, or ask among several.
 *  - `stops`: nothing is left that can serve the pack; the runs stop until an
 *    connection is added.
 *  - `unchanged`: they go where they went before. */
export type RemovalOutcomeKind = 'moves' | 'no_default' | 'no_list' | 'stops' | 'unchanged';

export interface RemovalOutcome {
  outcome: RemovalOutcomeKind;
  /** The connection those runs use now, if any. */
  before?: string;
  /** The connection they use afterwards, if any. */
  after?: string;
  /** The set-up connections left on the list. */
  remaining: string[];
  /** `no_list`: the set-up connections that still serve the pack by their vendor. */
  fallback?: string[];
}

export interface RemovalQuestion {
  scan: Scan;
  /** The slot's catalogs, and every binding row for them. */
  catalogs: readonly string[];
  bindings: readonly Binding[];
  /** The connection names set up now. */
  enrolled: ReadonlySet<string>;
  /** The connection leaving the list. */
  connection: string;
  /** True when it is only taken off the list (it stays set up); false when it
   *  is deleted. */
  staysSetUp: boolean;
  /** Whether a set-up connection serves one of `catalogs` by its registered
   *  vendor, on no list. */
  servesByVendor: (connection_name: string) => boolean;
}

/** The slot's outcome when `connection` leaves it: its binding gone (a deleted
 *  connection's binding stays, but it is not set up, and its stored default goes
 *  with it: the run sees the same). */
export const removalOutcome = (q: RemovalQuestion): RemovalOutcome => {
  const before = effectiveSlotDefault(q.scan, q.catalogs, q.bindings, q.enrolled);
  const without = q.bindings.filter((binding) => binding.connection_name !== q.connection);
  const left = new Set([...q.enrolled].filter((name) => name !== q.connection));
  // A stored default naming `connection` is no answer once its bindings are gone
  // (`storedSlotDefault` requires the default to serve every catalog), which is
  // exactly what clearing it does.
  const after = effectiveSlotDefault(q.scan, q.catalogs, without, left);
  const remaining = [...new Set(
    without.filter((binding) => left.has(binding.connection_name)).map((binding) => binding.connection_name),
  )];
  const base = {
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
    remaining,
  };
  if (after !== undefined) return { outcome: after === before ? 'unchanged' : 'moves', ...base };
  if (remaining.length > 0) {
    // Two or more left and none the default. It had none before either: nothing
    // a run does changes.
    return { outcome: before === undefined ? 'unchanged' : 'no_default', ...base };
  }
  // Nothing left on the list: the run falls to the pick layer.
  const setUp = q.staysSetUp ? q.enrolled : left;
  const fallback = [...setUp].filter((name) => q.servesByVendor(name)).sort();
  if (fallback.length > 0) return { outcome: 'no_list', ...base, fallback };
  return { outcome: before === undefined ? 'unchanged' : 'stops', ...base };
};
