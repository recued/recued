/** D-320 slice 2b — a pack's connections per slot, behind the Access page's
 *  Connections block (`packs.connections.*`, D-320 §4).
 *
 *  A slot is the connection name a pack's catalog declares (`http.connection`):
 *  one sign-in. The pack's LIST for a slot is the connections its catalog is bound
 *  to (`connection_catalog_binding`), which is what lets the gateway serve the
 *  pack's operations there. One of them is the slot's default: the connection a
 *  run uses when neither the run nor its dish chooses. */

/** One connection on a pack's list. */
export interface PackConnectionEntry {
  connection_name: string;
  /** The owner's alias for it, its Display Name; the name when it has none. */
  display_name: string;
  /** Whether a connection by this name is set up. A pack stays bound to a name
   *  whose connection was deleted, and lights up again when it is re-added. */
  enrolled: boolean;
  /** The one a run uses when neither the run nor its dish chooses: the stored
   *  default, or the only connection on the list. */
  is_default: boolean;
}

/** One of the owner's connections that could join a slot's list: set up, of the
 *  same kind, at the same API as the connections the pack signs in to. */
export interface PackConnectionCandidate {
  connection_name: string;
  display_name: string;
}

export interface PackConnectionSlot {
  slot: string;
  /** The pack's catalogs that sign in through this slot. */
  catalogs: string[];
  connections: PackConnectionEntry[];
  candidates: PackConnectionCandidate[];
  /** D-320 ruling 9 — this pack signs in through another pack's connections (its
   *  requirement's `from_pack`): the holder's slug. The connections and the default
   *  shown are the holder's, they change on the holder, and this pack offers no
   *  candidates. */
  held_by?: string;
  /** D-320 slice 2h — the holder's name, beside `held_by`; its slug when the
   *  server cannot read its manifest. */
  held_by_name?: string;
  /** D-320 ruling 9 — the packs that sign in through this pack's connections; a
   *  change to this list reaches them too. */
  shared_with?: string[];
  /** D-320 slice 2h — their names, in `shared_with`'s order. */
  shared_with_names?: string[];
  /** D-320 slice 2h — the vendor its requirement names, for "Set up a new
   *  connection" (the vendor's form). Absent without a manifest or requirement. */
  vendor?: string;
}

export interface PackConnectionsView {
  pack_slug: string;
  /** Empty for a pack with no catalog of its own (an umbrella that brings in
   *  other packs), or one installed with no connection. */
  slots: PackConnectionSlot[];
}

/** Which connection, in which slot of which pack. */
export interface PackConnectionChange {
  pack_slug: string;
  slot: string;
  connection_name: string;
}

/** D-320 §3.4 / §4 — one slot a recipe signs in through, as the dish form and the
 *  run dialog show it (`packs.connections.recipe`). */
export interface RecipeConnectionSlot {
  slot: string;
  /** The recipe's settings its steps read the connection from. The form shows
   *  this slot's Connection line in their place, and never asks for them: the
   *  pack holds the connection. */
  variables: string[];
  /** The connections on the list for it (bound to each of the recipe's catalogs
   *  in the slot, and set up), the default marked. Two or more is a choice. */
  connections: Array<{
    connection_name: string;
    /** The owner's alias for it; the name when it has none. */
    display_name: string;
    is_default: boolean;
  }>;
  /** D-320 ruling 20 (2026-10-11) — a vendor-neutral FAMILY (`crm`, `acct`), not a
   *  pack's slot: its `core.crm.*` / `core.acct.*` steps, which name no vendor.
   *  `slot` is the family, `connections` every connection that can serve all of
   *  them (of any vendor; none is a default), and choosing one keeps them on it.
   *  Left unchosen, a search reads every connection and a step on a record takes the
   *  record's connection, so the line offers "any" where a pack's slot offers
   *  "choose one". */
  family?: true;
}

/** The slots a recipe signs in through. A vendor-neutral step (`core.crm.*`)
 *  names no pack's slot until a connection is given; its family is listed as one
 *  (`family`), with every connection that can serve it. */
export interface RecipeConnectionsView {
  recipe_id: string;
  slots: RecipeConnectionSlot[];
}

/** D-320 slice 2g (ruling 16) — what removing a connection does to a pack's runs
 *  that name no connection, by the run's own rule (one set-up connection on the list is
 *  the default; two or more take the stored one):
 *  - `moves`: they use another connection from now on (`after`);
 *  - `no_default`: two or more are left and none is the default, so owner runs
 *    ask and scheduled runs are refused until one is chosen;
 *  - `no_list`: nothing is left on the list, but connections of a registered vendor
 *    (HubSpot, Salesforce, Pipedrive, Exa) serve its packs on no list
 *    (`fallback`): scheduled runs stop, the owner's own runs use the one or ask
 *    among several;
 *  - `stops`: nothing is left that can serve it, and they stop until a connection
 *    is added;
 *  - `unchanged`: they go where they went before. */
export type ConnectionRemovalOutcome = 'moves' | 'no_default' | 'no_list' | 'stops' | 'unchanged';

/** A connection by name and alias. */
export interface PackConnectionRef {
  connection_name: string;
  display_name: string;
}

/** One pack holding the connection on its list, and what removing it does there. */
export interface PackRemovalEffect {
  pack_slug: string;
  /** The pack's name; its slug when the server cannot read its manifest. */
  pack_name: string;
  slot: string;
  /** The packs that sign in through this one (ruling 9): their runs go the same way. */
  members: Array<{ pack_slug: string; pack_name: string }>;
  outcome: ConnectionRemovalOutcome;
  /** The connection its runs use now, if any. */
  before?: PackConnectionRef;
  /** The connection they use afterwards, if any. */
  after?: PackConnectionRef;
  /** The set-up connections left on its list. */
  remaining: PackConnectionRef[];
  /** `no_list`: the set-up connections that still serve it by their vendor. */
  fallback?: PackConnectionRef[];
}

/** D-320 audit — one installed recipe whose sign-in spans two or more packs' lists
 *  (ruling 14: a family with no core pack keeps a list per pack). Its runs need one
 *  connection on every one of those lists, so the packs' own answers can say their runs
 *  move while this recipe's stop: taking a connection off `shortcut-workspace`'s list
 *  "moves to" the other one there, while `workspace-map-shortcut`, which also reads
 *  `shortcut-planning`, finds no connection on both lists. Same outcomes as a pack's, over
 *  the connections on every one of its lists. */
export interface RecipeRemovalEffect {
  recipe_id: string;
  /** Its name; its id when it has none. */
  recipe_name: string;
  slot: string;
  /** The packs whose lists its sign-in spans (a family once, by its holder). */
  packs: Array<{ pack_slug: string; pack_name: string }>;
  outcome: ConnectionRemovalOutcome;
  /** The connection its runs that name none use now, if any. */
  before?: PackConnectionRef;
  /** The connection they use afterwards, if any. */
  after?: PackConnectionRef;
  /** The set-up connections left on every one of its lists. Never `no_list`: with the
   *  lists empty, no registered vendor's connection serves two packs' catalogs. */
  remaining: PackConnectionRef[];
}

/** `packs.connections.removal`: every pack holding the connection (a family once,
 *  by its holder), or the one asked about. */
export interface ConnectionRemovalView {
  connection_name: string;
  packs: PackRemovalEffect[];
  /** D-320 audit — the installed recipes whose sign-in spans two or more of those
   *  packs' lists, where their own answer is not their packs'. Absent when there are
   *  none, and from a server before it. */
  recipes?: RecipeRemovalEffect[];
}

/** D-320 slice 2h (ruling 16) — one cell of a sign-in's grid: the connection is the
 *  pack's default (and on its list), on its list, could join it, or cannot serve
 *  the pack at all. */
export type PackSignInCell = 'default' | 'listed' | 'available' | 'unavailable';

/** One pack holding its own list, as a grid row. */
export interface PackSignInRow {
  pack_slug: string;
  /** Its name; its slug when the server cannot read its manifest. */
  pack_name: string;
  /** The packs that sign in through it (ruling 9). They follow its list. */
  members: Array<{ pack_slug: string; pack_name: string }>;
  /** Per connection in the sign-in's `connections`, by connection name. */
  cells: Record<string, PackSignInCell>;
  /** The connection its runs that name none use, by the run's own rule. */
  default?: string;
}

/** One sign-in: the connection name packs' catalogs declare (`hubspot`). */
export interface PackSignIn {
  slot: string;
  /** What to call it: the vendor its packs' requirement names, else the slot. */
  label: string;
  /** The vendor, for "Set up a new connection". */
  vendor?: string;
  /** The owner's set-up connections on a row's list or able to join one, by alias. */
  connections: PackConnectionRef[];
  rows: PackSignInRow[];
}

/** `packs.connections.signins`: every sign-in installed packs hold a list for. */
export interface PackSignInsView {
  signins: PackSignIn[];
}

/** `packs.connections.add_many`: one connection onto several packs' lists, all or
 *  none; `make_default` also makes it their default. */
export interface PackConnectionAddMany {
  connection_name: string;
  targets: Array<{ pack_slug: string; slot: string }>;
  make_default?: boolean;
}
