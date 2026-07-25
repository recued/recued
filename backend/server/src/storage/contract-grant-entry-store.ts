/** Grant-foundation slice 3 (D-187 AMENDMENT `693b7d03`) — the UNIFIED per-contract
 *  grant store (LOCAL-ONLY).
 *
 *  The amendment collapses op-admission + collection-read + topic-read into ONE
 *  consolidated grant namespace per contract. This store is the typed accessor over
 *  the `contract_grant` scope (`contract.contract_grant.<contract_id>.<entry_key>`) —
 *  the same wrap-the-`ContractStore` pattern as the D-187 S1
 *  `ContractEnrichmentVisibilityStore`, so every grant kind lives in one substrate the
 *  gateway resolver, the contract UI, and audit read.
 *
 *  `entry_key` is a {@link ../../../packages/contracts/src/grant-entry.ts} taxonomy id
 *  — `<operation_id>` (op admission) | `data.<collection>` (collection read) |
 *  `enrichment.<topic>` (topic read). It carries `.` / `/`; the contract-store seg_key
 *  codec escapes `.` (→ `%2E`) so a dotted op id keys a single segment and a leading
 *  `contract_id` prefix scan stays on a `.` boundary (a contract id `door` never bleeds
 *  into `doorway`). This store is dumb about the taxonomy — it never validates that
 *  `entry_key` names a LIVE op/collection/topic; that semantic check is the rpc /
 *  resolver layer's job (it holds the registries). The store only enforces non-empty
 *  ids + a boolean value (the value-shape gate runs in `contractStore.put`).
 *
 *  Three-state read: a row with `granted: true` = an explicit grant, `granted: false` =
 *  an explicit REVOKE (the owner toggled a seeded grant off — it must SURVIVE the boot
 *  reconcile, hence a stored `false` row rather than row-absence), and NO row =
 *  `undefined` → the resolver applies the author default. The owner contract is seeded
 *  complete by the boot reconcile, so its reads are never `undefined`; doors stay sparse.
 *
 *  Local-only by construction — the contract store never syncs cloud (D-090/D-097/D-168).
 *  Spec: D-187 AMENDMENT block; handover
 *  `handover_grant_foundation_slice3_amended.md`. */

import type { ContractStore } from './contract-store.js';

/** The `contract_grant` scope name (a `composite_keys` entry in the contract schema —
 *  `contract-schema.ts`). Distinct from the retiring connection-op `grant` scope
 *  (`contract-grant-store.ts`, `GRANT_SCOPE = 'grant'`), which collapses into pack-op
 *  grant entries here in slice 3b. */
const CONTRACT_GRANT_SCOPE = 'contract_grant';

/** A grant row's segment depth — `(contract_id, entry_key)`. */
const GRANT_ENTRY_SEGMENT_COUNT = 2;
/** Index of the `entry_key` segment within the 2-tuple (`contract_id` is segment 0). */
const ENTRY_KEY_SEGMENT = 1;

/** Typed view of the `grant_entry` value_shape (`contract-schema.ts`). A row's
 *  `granted` pins the explicit grant (`true`) / revoke (`false`) for the keyed entry;
 *  `set_at` (epoch-ms) records when it was written. Kept in lock-step with the
 *  value_shape — a field added there must be added here. */
export interface GrantEntryRow {
  granted: boolean;
  set_at?: number;
  /** D-182 §7.2 — the `installed_pack_id` of the "Install for everyone" fan-out
   *  that wrote this row, when it came from a pack fan-out. Absent on a mint-fold
   *  (door `scope.operation_ids`), owner, or manual row — those are NEVER touched
   *  by {@link ContractGrantEntryStore.clearForSourcePack}. */
  source_pack?: string;
}

/** Typed accessor over the `contract_grant` scope — the durable backing for the
 *  unified per-contract grant set (the grant resolver + the D-174 R22 transpose UIs
 *  consume it). Keyed by `(contract_id, entry_key)`: `get` / `set` / `clear` operate on
 *  one entry; `listForContract` enumerates a contract's whole grant set. */
export interface ContractGrantEntryStore {
  /** The explicit grant value the contract has stored for `(contract_id, entry_key)`:
   *  `true` (granted) / `false` (explicit revoke), or `undefined` when NO row is
   *  persisted (the resolver then applies the author default). A malformed row resolves
   *  to `undefined` too — a corrupt value can never read as a hard error; it falls to
   *  the resolver's defined default (fail-safe). */
  get(contract_id: string, entry_key: string): boolean | undefined;
  /** Pin an entry's grant under a contract — idempotent upsert of
   *  `{ granted, set_at: now[, source_pack] }`. `granted: true` grants, `false` records
   *  an explicit revoke (survives the boot reconcile). `source_pack` (D-182 §7.2) stamps
   *  the row as a pack fan-out grant so {@link clearForSourcePack} can later drop exactly
   *  it; OMIT it for mint-fold / owner / manual writes (they must stay untouched by a pack
   *  uninstall). Throws on an empty id (a degenerate key the structural gate would reject —
   *  fail loud with a clear error). `now` is epoch-ms. */
  set(contract_id: string, entry_key: string, granted: boolean, now: number, source_pack?: string): void;
  /** Clear an entry's row under a contract — subsequent reads fall back to the resolver
   *  default. Idempotent: returns `true` iff a row was removed. */
  clear(contract_id: string, entry_key: string): boolean;
  /** D-182 §7.2 — clear EVERY row (across all contracts) stamped with this
   *  `source_pack` — the isolated revoke for the "Install for everyone" op-admission
   *  fan-out. Used at pack uninstall AND as the pre-clean of a reinstall (replace, not
   *  append), so a `for-everyone → for-you` reinstall drops the prior per-door grants.
   *  A row with NO `source_pack` (a mint-fold door grant, an owner/manual row) is NEVER
   *  matched, so per-pack isolation holds even when a hand-minted door independently
   *  granted the same op. Whole-scope value scan (not a hot path — install/uninstall
   *  only). Returns the number of rows removed; an empty `source_pack` matches nothing
   *  (returns 0). */
  clearForSourcePack(source_pack: string): number;
  /** Every entry the contract has a row for (grants AND revokes), ascending by
   *  entry_key + deduped (the store keys one row per `(contract_id, entry_key)`). Drops
   *  malformed rows so the surface shows only well-formed grants. */
  listForContract(
    contract_id: string,
  ): Array<{ entry_key: string; granted: boolean; set_at?: number; source_pack?: string }>;
  /** Every contract that has a row for `entry_key` (grants AND revokes) — the
   *  TRANSPOSE of {@link listForContract} (the topic/op-detail "column" across
   *  contracts, for the D-174 R22 topic-detail UI). `entry_key` is segment 1, not the
   *  leading segment, so this is a whole-scope scan filtered on the entry — an
   *  owner-surface column read, deliberately NOT a gate hot-path lookup. Ascending by
   *  contract_id; drops malformed rows. */
  listForEntry(
    entry_key: string,
  ): Array<{ contract_id: string; granted: boolean; set_at?: number; source_pack?: string }>;
}

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

/** Wrap a {@link ContractStore} as the `ContractGrantEntryStore`. Stateless — every
 *  call forwards to the shared store handle; safe to construct more than once over the
 *  same store (mirrors `createContractEnrichmentVisibilityStore`). */
export const createContractGrantEntryStore = (
  contractStore: ContractStore,
): ContractGrantEntryStore => {
  return {
    get(contract_id, entry_key) {
      if (!contract_id || !entry_key) return undefined; // an empty id is never a real key
      const row = contractStore.get(CONTRACT_GRANT_SCOPE, [contract_id, entry_key]);
      if (!row) return undefined;
      const value = row.value as Partial<GrantEntryRow> | null;
      return isBool(value?.granted) ? value.granted : undefined;
    },

    set(contract_id, entry_key, granted, now, source_pack) {
      if (!contract_id) {
        throw new Error('contract_grant_contract_id_required');
      }
      if (!entry_key) {
        throw new Error('contract_grant_entry_key_required');
      }
      if (!isBool(granted)) {
        throw new Error(`contract_grant_granted_invalid: '${String(granted)}' — must be a boolean`);
      }
      // `contract_grant` is an `override` merge_rule scope (not `tightening_only`), so
      // `put` runs only the structural value-shape gate + an idempotent upsert keyed on
      // (scope, segments) — no aggregate loosen-check fires. `source_pack` is written only
      // when provided (a pack fan-out grant); mint-fold / owner / manual writes omit it.
      contractStore.put(
        CONTRACT_GRANT_SCOPE,
        [contract_id, entry_key],
        {
          granted,
          set_at: now,
          ...(source_pack ? { source_pack } : {}),
        } satisfies GrantEntryRow,
      );
    },

    clear(contract_id, entry_key) {
      if (!contract_id || !entry_key) return false;
      return contractStore.delete(CONTRACT_GRANT_SCOPE, [contract_id, entry_key]);
    },

    clearForSourcePack(source_pack) {
      // An empty source_pack is never a real stamp — matching it would be a WHOLE-scope
      // wipe. Return 0 (no-op) rather than risk clearing every grant row.
      if (!source_pack) return 0;
      // Whole-scope scan filtered on the row VALUE (`source_pack` is not a key segment) —
      // the same owner-surface scan shape as `listForEntry`, deliberately not a gate
      // hot-path (install / uninstall only).
      const rows = contractStore.scan(CONTRACT_GRANT_SCOPE, []);
      let removed = 0;
      for (const row of rows) {
        if (row.segments.length !== GRANT_ENTRY_SEGMENT_COUNT) continue;
        const value = row.value as Partial<GrantEntryRow> | null;
        if (value?.source_pack !== source_pack) continue;
        const contract_id = row.segments[0];
        const entry_key = row.segments[ENTRY_KEY_SEGMENT];
        if (!contract_id || !entry_key) continue;
        if (contractStore.delete(CONTRACT_GRANT_SCOPE, [contract_id, entry_key])) removed += 1;
      }
      return removed;
    },

    listForContract(contract_id) {
      // GUARD an empty `contract_id` FIRST: the backing `ContractStore.scan` treats an
      // encoded-empty prefix as a WHOLE-SCOPE scan (`encodeSegKey(['']) === ''`), so an
      // empty id would degenerate this per-contract read into "every contract's rows" — a
      // cross-contract bleed. An empty id is never a real bound contract, so return nothing.
      if (!contract_id) return [];
      // With a non-empty id, `contract_id` is the LEADING segment, so a leading-prefix
      // scan returns exactly this contract's rows (the seg_key codec keeps the scan on a
      // `.` boundary, so a contract id `door` never bleeds into `doorway`).
      const rows = contractStore.scan(CONTRACT_GRANT_SCOPE, [contract_id]);
      const out: Array<{ entry_key: string; granted: boolean; set_at?: number; source_pack?: string }> = [];
      for (const row of rows) {
        if (row.segments.length !== GRANT_ENTRY_SEGMENT_COUNT) continue;
        const entry_key = row.segments[ENTRY_KEY_SEGMENT];
        if (!entry_key) continue;
        const value = row.value as Partial<GrantEntryRow> | null;
        if (!isBool(value?.granted)) continue;
        const set_at = value.set_at;
        const source_pack = value.source_pack;
        out.push({
          entry_key,
          granted: value.granted,
          ...(typeof set_at === 'number' ? { set_at } : {}),
          ...(typeof source_pack === 'string' ? { source_pack } : {}),
        });
      }
      // Ascending by entry_key — deterministic surface order.
      return out.sort((a, b) =>
        a.entry_key < b.entry_key ? -1 : a.entry_key > b.entry_key ? 1 : 0,
      );
    },

    listForEntry(entry_key) {
      if (!entry_key) return [];
      // entry_key is segment 1 (NOT the leading segment), so a prefix scan can't target
      // it — this is a whole-scope scan filtered on the entry segment. The owner-surface
      // topic/op-detail column read, deliberately not a gate hot-path lookup.
      const rows = contractStore.scan(CONTRACT_GRANT_SCOPE, []);
      const out: Array<{ contract_id: string; granted: boolean; set_at?: number; source_pack?: string }> = [];
      for (const row of rows) {
        if (row.segments.length !== GRANT_ENTRY_SEGMENT_COUNT) continue;
        if (row.segments[ENTRY_KEY_SEGMENT] !== entry_key) continue;
        const contract_id = row.segments[0];
        if (!contract_id) continue;
        const value = row.value as Partial<GrantEntryRow> | null;
        if (!isBool(value?.granted)) continue;
        const set_at = value.set_at;
        const source_pack = value.source_pack;
        out.push({
          contract_id,
          granted: value.granted,
          ...(typeof set_at === 'number' ? { set_at } : {}),
          ...(typeof source_pack === 'string' ? { source_pack } : {}),
        });
      }
      return out.sort((a, b) =>
        a.contract_id < b.contract_id ? -1 : a.contract_id > b.contract_id ? 1 : 0,
      );
    },
  };
};
