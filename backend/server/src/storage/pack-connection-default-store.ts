/** D-320 — a pack's default connection per slot, `contract.pack_connection_default`.
 *
 *  A slot is the connection name a pack's catalog declares (`http.connection`), so
 *  a pack holds one default per sign-in. The default is one of the pack's bound
 *  connections (`connection_catalog_binding`, the pack's list): the connection a
 *  run uses when neither the run nor its dish chooses (D-320 §3.3).
 *  - Install writes it: the connection the owner chose becomes the default.
 *  - The owner changes it (Make default) or removes it with its connection.
 *  - A pack with one connection on its list needs no row: that one is its default.
 *
 *  Local-only by construction — the contract store never syncs (D-090/D-097/D-168).
 */

import type { ConnectionStoreSqlite } from './connection-store.js';
import type { ContractStore } from './contract-store.js';
import { holdersOfPacks } from './pack-connection-holder-store.js';

/** The `pack_connection_default` scope name (a `composite_keys` entry). */
const DEFAULT_SCOPE = 'pack_connection_default';
/** `[installed_pack_id, slot]`. */
const SEGMENT_COUNT = 2;
const PACK_SEGMENT = 0;
const SLOT_SEGMENT = 1;

export interface PackConnectionDefault {
  installed_pack_id: string;
  slot: string;
  connection_name: string;
}

/** Defensive read of the `pack_connection_default_info` value. */
const readConnectionName = (value: unknown): string | undefined => {
  if (value === null || typeof value !== 'object') return undefined;
  const name = (value as { connection_name?: unknown }).connection_name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
};

const rowsOf = (
  rows: readonly { segments: readonly string[]; value: unknown }[],
): PackConnectionDefault[] => {
  const out: PackConnectionDefault[] = [];
  for (const row of rows) {
    if (row.segments.length !== SEGMENT_COUNT) continue;
    const connection_name = readConnectionName(row.value);
    if (connection_name === undefined) continue;
    out.push({
      installed_pack_id: row.segments[PACK_SEGMENT],
      slot: row.segments[SLOT_SEGMENT],
      connection_name,
    });
  }
  return out;
};

export interface PackConnectionDefaultStore {
  get(installed_pack_id: string, slot: string): string | undefined;
  /** Every slot default the pack holds. */
  forPack(installed_pack_id: string): PackConnectionDefault[];
  set(installed_pack_id: string, slot: string, connection_name: string): void;
  clear(installed_pack_id: string, slot: string): void;
  /** Uninstall: every default the pack holds goes. */
  removeForPack(installed_pack_id: string): void;
  /** Every default naming `connection_name` goes (the connection was deleted, or
   *  taken off the pack's list). Returns what it cleared. A run then never moves to
   *  another account unasked: one connection left is the default by itself; two or
   *  more leave the slot without one until the owner picks (spec §7). */
  clearForConnection(connection_name: string): PackConnectionDefault[];
}

export const createPackConnectionDefaultStore = (
  contractStore: ContractStore,
): PackConnectionDefaultStore => ({
  get(installed_pack_id, slot) {
    return readConnectionName(contractStore.get(DEFAULT_SCOPE, [installed_pack_id, slot])?.value);
  },

  forPack(installed_pack_id) {
    return rowsOf(contractStore.scan(DEFAULT_SCOPE, [installed_pack_id]))
      .filter((row) => row.installed_pack_id === installed_pack_id);
  },

  set(installed_pack_id, slot, connection_name) {
    contractStore.put(DEFAULT_SCOPE, [installed_pack_id, slot], { connection_name });
  },

  clear(installed_pack_id, slot) {
    contractStore.delete(DEFAULT_SCOPE, [installed_pack_id, slot]);
  },

  removeForPack(installed_pack_id) {
    contractStore.deleteByPrefix(DEFAULT_SCOPE, [installed_pack_id]);
  },

  clearForConnection(connection_name) {
    const cleared = rowsOf(contractStore.scan(DEFAULT_SCOPE, []))
      .filter((row) => row.connection_name === connection_name);
    for (const row of cleared) contractStore.delete(DEFAULT_SCOPE, [row.installed_pack_id, row.slot]);
    return cleared;
  },
});

/** D-320 — the defaults the given packs hold, read through a contract-store scan
 *  (the execute handler has `contractScan`, not the store). */
export const packConnectionDefaults = (
  scan: (scope: string, prefixSegments: readonly string[]) => readonly { segments: readonly string[]; value: unknown }[],
  installed_pack_ids: readonly string[],
): PackConnectionDefault[] => {
  const wanted = new Set(installed_pack_ids);
  if (wanted.size === 0) return [];
  return rowsOf(scan(DEFAULT_SCOPE, [])).filter((row) => wanted.has(row.installed_pack_id));
};

/** D-320 — a deleted connection's defaults go (spec §7, "A removed default"),
 *  once no row of that name is left (a same-name api + mcp pair shares it), as
 *  `wireConnectionGrantCleanup` does for grants. The pack's binding to it stays,
 *  dormant, as it always has: re-enrolling the name lights it up again, and with
 *  one connection on the list that one is the default by itself.
 *
 *  ⛔ Except the API row: a pack's list is of API connections (the candidates
 *  `packs.connections.*` offers), so a same-name MCP or notification row serves
 *  none of its HTTP catalogs. Kept while one was left, the default named a
 *  connection that no longer existed, the Access tab still marked it, and every
 *  run that took it failed `CONNECTION_NOT_FOUND`. */
export const wirePackConnectionDefaultCleanup = (
  connectionStore: Pick<ConnectionStoreSqlite, 'list' | 'addOnDelete'>,
  defaults: Pick<PackConnectionDefaultStore, 'clearForConnection'>,
): void => {
  connectionStore.addOnDelete((kind, name) => {
    if (kind !== 'api' && connectionStore.list().some((row) => row.name === name)) return;
    defaults.clearForConnection(name);
  });
};

/** D-320 — the stored default a run takes for one slot, given the bindings of the
 *  slot's catalogs (the set-up ones): every pack holding one decides, through its
 *  holder when it borrows (ruling 9); each must name exactly one default, all the
 *  same connection, and it must be bound to every catalog. Anything else is no
 *  default, and the pick layer asks. Shared by the run (`execute-handler.ts`) and
 *  the recipe tools' `connections` argument (`recipe-connection-choices.ts`), so
 *  the two never name different defaults. */
export const storedSlotDefault = (
  scan: (scope: string, prefixSegments: readonly string[]) => readonly { segments: readonly string[]; value: unknown }[],
  catalogs: readonly string[],
  bindings: readonly { connection_name: string; catalog_slug: string; installed_pack_id: string }[],
): string | undefined => {
  const packs = [...new Set(bindings.map((binding) => binding.installed_pack_id))];
  const holders = holdersOfPacks(scan, packs);
  const deciders = [...new Set(packs.map((pack) => holders.get(pack) ?? pack))];
  const defaults = packConnectionDefaults(scan, deciders);
  const named = new Set<string>();
  for (const pack of deciders) {
    // Every shipped pack declares one slot, so a pack names one default; none,
    // or several, is no answer for it.
    const its = defaults.filter((row) => row.installed_pack_id === pack);
    if (its.length !== 1) return undefined;
    named.add(its[0]!.connection_name);
  }
  if (named.size !== 1) return undefined;
  const chosen = [...named][0]!;
  const servesEvery = catalogs.every((catalog) =>
    bindings.some((binding) => binding.catalog_slug === catalog && binding.connection_name === chosen));
  return servesEvery ? chosen : undefined;
};
