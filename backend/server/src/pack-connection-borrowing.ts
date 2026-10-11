/** D-320 ruling 9 — a pack signing in through another pack's connections.
 *
 *  A borrowing pack names its holder in its connection requirement (`from_pack`,
 *  ruling 11). The holder keeps the list (its bindings) and the default. The
 *  borrower's catalogs are bound to every connection on the holder's list and on
 *  no other: real binding rows, so the gateway, the operation profiles and the
 *  pick layer serve a borrower exactly as they serve the holder, with no change.
 *  These functions keep the two in step whenever either side changes:
 *  - the borrower's install, and the holder's install or update;
 *  - a connection joining or leaving the holder's list (`packs.connections.*`).
 *
 *  A run reads the HOLDER's default for a borrower (`execute-handler.ts`), so a
 *  borrower stores none. */

import { createConnectionCatalogBindingStore } from './storage/connection-catalog-binding-store.js';
import type { ContractStore } from './storage/contract-store.js';
import { createContractGrantStore } from './storage/contract-grant-store.js';
import { createPackConnectionDefaultStore } from './storage/pack-connection-default-store.js';
import { createPackConnectionHolderStore } from './storage/pack-connection-holder-store.js';
import { currentPackConnection } from './pack-update-carry-over.js';

const GRANT_SCOPE = 'grant';
/** `[installed_pack_id, ingredient_id, connection_name, group]`. */
const GRANT_SEGMENT_COUNT = 4;

/** The connections a pack's catalogs are bound to, in bind order. */
export const packListedConnections = (contractStore: ContractStore, pack: string): string[] => {
  const out: string[] = [];
  for (const binding of createConnectionCatalogBindingStore(contractStore).list()) {
    if (binding.installed_pack_id === pack && !out.includes(binding.connection_name)) {
      out.push(binding.connection_name);
    }
  }
  return out;
};

/** The groups a pack holds grants for on one catalog, on any connection. */
const packGroupsFor = (contractStore: ContractStore, pack: string, catalog: string): string[] =>
  [...new Set(
    contractStore.scan(GRANT_SCOPE, [pack, catalog])
      .filter((row) => row.segments.length === GRANT_SEGMENT_COUNT)
      .map((row) => row.segments[3]!),
  )];

/** A connection joins a pack's list for one slot: each of `catalogs` is bound to
 *  it, and the pack's grants there mirror the ones it holds on its other
 *  connections. When the pack had ONE connection and no stored default, that one
 *  is stored as the default first, so runs that used it keep using it. Returns
 *  whether the list changed. Run it inside the caller's transaction.
 *
 *  With `isSetUp`, only connections that are set up count, as a run counts them
 *  (`currentPackConnection`). ⛔ A deleted connection's binding stays, dormant
 *  (D-320 slice 2h): counted, a list of it and one other stored nothing, and the
 *  runs that used the other started asking once a third joined, a scheduled one
 *  refused. */
export const addConnectionToPackList = (
  contractStore: ContractStore,
  pack: string,
  catalogs: readonly string[],
  slot: string,
  connection: string,
  isSetUp?: (connection_name: string) => boolean,
): boolean => {
  const listed = packListedConnections(contractStore, pack);
  if (listed.includes(connection)) return false;
  const defaults = createPackConnectionDefaultStore(contractStore);
  const counted = isSetUp === undefined ? listed : listed.filter(isSetUp);
  if (counted.length === 1 && defaults.get(pack, slot) === undefined) {
    defaults.set(pack, slot, counted[0]!);
  }
  const bindings = createConnectionCatalogBindingStore(contractStore);
  const grants = createContractGrantStore(contractStore);
  for (const catalog of catalogs) {
    const groups = packGroupsFor(contractStore, pack, catalog);
    bindings.bind(connection, catalog, pack, slot);
    for (const group of groups) grants.grantPackGroup(pack, catalog, connection, group);
  }
  return true;
};

/** Bind `borrower`'s catalogs to exactly its holder's list: missing connections
 *  bound (with the borrower's grants mirrored), connections the holder no longer
 *  lists unbound (with the borrower's grants there). Returns the connections whose
 *  bindings changed, which the caller re-derives profiles for. */
export const syncBorrowerToHolder = (
  contractStore: ContractStore,
  borrower: string,
  holder: string,
  borrowerCatalogs: readonly string[],
  slot: string | undefined,
): string[] => {
  const desired = packListedConnections(contractStore, holder);
  const bindings = createConnectionCatalogBindingStore(contractStore);
  const grants = createContractGrantStore(contractStore);
  const changed = new Set<string>();
  for (const catalog of borrowerCatalogs) {
    const groups = packGroupsFor(contractStore, borrower, catalog);
    const current = bindings.list()
      .filter((b) => b.installed_pack_id === borrower && b.catalog_slug === catalog)
      .map((b) => b.connection_name);
    for (const connection of desired) {
      if (current.includes(connection)) continue;
      bindings.bind(connection, catalog, borrower, slot);
      for (const group of groups) grants.grantPackGroup(borrower, catalog, connection, group);
      changed.add(connection);
    }
    for (const connection of current) {
      if (desired.includes(connection)) continue;
      bindings.unbind(connection, catalog);
      contractStore.deleteByPrefix(GRANT_SCOPE, [borrower, catalog, connection]);
      changed.add(connection);
    }
  }
  return [...changed];
};

/** Re-sync every pack that borrows `holder`'s sign-in, after its list changed.
 *  `catalogsOf` names a pack's catalogs a connection serves. Returns the
 *  connections whose bindings changed. */
export const syncBorrowersOf = (
  contractStore: ContractStore,
  holder: string,
  catalogsOf: (pack: string) => readonly string[],
): string[] => {
  const holders = createPackConnectionHolderStore(contractStore);
  const changed = new Set<string>();
  for (const borrower of holders.borrowersOf(holder)) {
    const slot = holders.get(borrower)?.slot;
    for (const connection of syncBorrowerToHolder(contractStore, borrower, holder, catalogsOf(borrower), slot)) {
      changed.add(connection);
    }
  }
  return [...changed];
};

/** D-320 §4 — a connection's "Used by packs", for the Connections page: the packs
 *  whose list holds it (their bindings; grants have not gated since 2026-08-07),
 *  and those that use it by default: the stored default, or the only connection
 *  on the list. A pack signing in through another's (ruling 9) uses its holder's.
 *  With `isSetUp`, the default is read by the run's own rule (slice 2h,
 *  `currentPackConnection`), and `holders` maps each listed pack signing in
 *  through another listed one to it, so the page names a family once. */
export const packsUsingConnection = (
  contractStore: ContractStore,
  connection: string,
  isSetUp?: (connection_name: string) => boolean,
): { listed: string[]; defaultFor: string[]; holders: Record<string, string> } => {
  const holders = createPackConnectionHolderStore(contractStore);
  const listed = [...new Set(
    createConnectionCatalogBindingStore(contractStore).list()
      .filter((binding) => binding.connection_name === connection)
      .map((binding) => binding.installed_pack_id),
  )].sort();
  const defaultFor = listed.filter((pack) =>
    currentPackConnection(contractStore, holders.get(pack)?.holder_pack_id ?? pack, isSetUp) === connection);
  const families: Record<string, string> = {};
  for (const pack of listed) {
    const holder = holders.get(pack)?.holder_pack_id;
    if (holder !== undefined && holder !== pack && listed.includes(holder)) families[pack] = holder;
  }
  return { listed, defaultFor, holders: families };
};

/** D-320 §4 — the connection list's "Used by packs" deps, as the server composes
 *  them (`handleConnectionList`): the packs on a connection are those granted on
 *  it and those whose list holds it; the second set has no grant at all for most
 *  packs (the Wise suite). Each closure only where its store is wired. */
export const connectionPackUsageDeps = (deps: {
  grantStore?: { listPacksForConnection(connection_name: string): string[] };
  contractStore?: ContractStore;
  /** Whether a connection by this name is set up, for the run's own rule. */
  isSetUp?: (connection_name: string) => boolean;
}): {
  boundPackSlugsForConnection?: (connection_name: string) => string[];
  defaultPackSlugsForConnection?: (connection_name: string) => string[];
  packHoldersForConnection?: (connection_name: string) => Record<string, string>;
} => {
  const { grantStore, contractStore, isSetUp } = deps;
  return {
    ...(grantStore !== undefined
      ? {
          boundPackSlugsForConnection: (name: string) => [...new Set([
            ...grantStore.listPacksForConnection(name),
            ...(contractStore !== undefined ? packsUsingConnection(contractStore, name).listed : []),
          ])].sort(),
        }
      : {}),
    ...(contractStore !== undefined
      ? {
          defaultPackSlugsForConnection: (name: string) => packsUsingConnection(contractStore, name, isSetUp).defaultFor,
          packHoldersForConnection: (name: string) => packsUsingConnection(contractStore, name).holders,
        }
      : {}),
  };
};
