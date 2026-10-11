/** D-320 ruling 9 — `contract.pack_connection_holder`: which pack holds a
 *  borrowing pack's sign-in.
 *
 *  A pack whose connection requirement names `from_pack` signs in through that
 *  pack's connections. The HOLDER keeps the list (its bindings) and the default
 *  (`pack_connection_default`); the BORROWER's catalog is bound to every
 *  connection on the holder's list and on no other, so the gateway serves it
 *  exactly as it serves the holder's (`pack-connection-borrowing.ts` keeps the
 *  two in step). Written at the borrower's install, dropped at its uninstall.
 *
 *  Local-only by construction — the contract store never syncs (D-090/D-097/D-168).
 */

import type { ContractStore } from './contract-store.js';

const HOLDER_SCOPE = 'pack_connection_holder';
/** `[installed_pack_id]` — the borrowing pack. */
const SEGMENT_COUNT = 1;

export interface PackConnectionHolder {
  /** The borrowing pack. */
  installed_pack_id: string;
  holder_pack_id: string;
  /** The slot it borrows (the connection name both catalogs declare), when known. */
  slot?: string;
}

const readHolder = (
  installed_pack_id: string,
  value: unknown,
): PackConnectionHolder | undefined => {
  if (value === null || typeof value !== 'object') return undefined;
  const v = value as { holder_pack_id?: unknown; slot?: unknown };
  if (typeof v.holder_pack_id !== 'string' || v.holder_pack_id.length === 0) return undefined;
  return {
    installed_pack_id,
    holder_pack_id: v.holder_pack_id,
    ...(typeof v.slot === 'string' && v.slot.length > 0 ? { slot: v.slot } : {}),
  };
};

const rowsOf = (
  rows: readonly { segments: readonly string[]; value: unknown }[],
): PackConnectionHolder[] => {
  const out: PackConnectionHolder[] = [];
  for (const row of rows) {
    if (row.segments.length !== SEGMENT_COUNT) continue;
    const holder = readHolder(row.segments[0]!, row.value);
    if (holder !== undefined) out.push(holder);
  }
  return out;
};

export interface PackConnectionHolderStore {
  /** The pack holding `installed_pack_id`'s sign-in, or undefined when it holds
   *  its own. */
  get(installed_pack_id: string): PackConnectionHolder | undefined;
  set(installed_pack_id: string, holder_pack_id: string, slot?: string): void;
  remove(installed_pack_id: string): void;
  /** The packs that sign in through `holder_pack_id`'s connections, sorted. */
  borrowersOf(holder_pack_id: string): string[];
}

export const createPackConnectionHolderStore = (
  contractStore: ContractStore,
): PackConnectionHolderStore => ({
  get(installed_pack_id) {
    return readHolder(installed_pack_id, contractStore.get(HOLDER_SCOPE, [installed_pack_id])?.value);
  },

  set(installed_pack_id, holder_pack_id, slot) {
    contractStore.put(HOLDER_SCOPE, [installed_pack_id], {
      holder_pack_id,
      ...(slot !== undefined ? { slot } : {}),
    });
  },

  remove(installed_pack_id) {
    contractStore.delete(HOLDER_SCOPE, [installed_pack_id]);
  },

  borrowersOf(holder_pack_id) {
    return rowsOf(contractStore.scan(HOLDER_SCOPE, []))
      .filter((row) => row.holder_pack_id === holder_pack_id)
      .map((row) => row.installed_pack_id)
      .sort();
  },
});

/** D-320 — the holder of each of `installed_pack_ids` that borrows, through a
 *  contract-store scan (the execute handler has `contractScan`, not the store). */
export const holdersOfPacks = (
  scan: (scope: string, prefixSegments: readonly string[]) => readonly { segments: readonly string[]; value: unknown }[],
  installed_pack_ids: readonly string[],
): Map<string, string> => {
  const wanted = new Set(installed_pack_ids);
  const out = new Map<string, string>();
  if (wanted.size === 0) return out;
  for (const row of rowsOf(scan(HOLDER_SCOPE, []))) {
    if (wanted.has(row.installed_pack_id)) out.set(row.installed_pack_id, row.holder_pack_id);
  }
  return out;
};
