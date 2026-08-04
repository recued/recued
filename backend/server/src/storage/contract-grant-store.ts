/** D-165 P3.grant migration — the `contract.grant`-backed operation-GROUP grant
 *  store (LOCAL-ONLY).
 *
 *  This is the centralized replacement for the retired `connection_operation_grant`
 *  table: instead of a bespoke single-owner SQLite table keyed
 *  `(connection_name, group_id)`, a user's explicit operation-GROUP
 *  grants live as `contract.grant` rows in the one self-describing contract store —
 *  the SINGLE place all permission state (grants + overrides + inventory) lives, so
 *  the gateway, the override picker, and audit read one substrate (D-166 grant
 *  centralization, [[project-d165-grant-ownership-decision]]).
 *
 *  The `contract.grant` scope is keyed on the full 4-tuple
 *  `(installed_pack_id, ingredient_id, connection_name, group_id_or_operation_id)`
 *  (`contract-schema.ts`): a grant tracks its OWNING pack, so the effective view
 *  merges across owners (`union_with_stricter_wins`) and uninstalling one pack drops
 *  only that pack's rows. A USER-MANUAL grant (the Settings → Connections grant panel)
 *  has no owning pack, so it keys under the reserved `__user__` sentinel
 *  `installed_pack_id`; its `ingredient_id` is the connection vendor's catalog slug
 *  (`catalogSlugForVendor`, e.g. `hubspot-catalog`). Pack-owned grants the P3 install
 *  planner writes carry a real `installed_pack_id` and live in the SAME scope; the
 *  effective-view merge per `(ingredient_id, connection_name)` unions the two.
 *
 *  This store exposes BOTH halves of `contract.grant`:
 *    - the USER-MANUAL half (the `__user__` rows) — the keyed read/write/list/cleanup
 *      operations the grant rpcs + the profile boot seed need; and
 *    - the PACK-OWNED half (D-165 P3 install planner) — write/remove keyed on a
 *      pack's real `installed_pack_id`, plus `listPackOwnedGroups` (the cross-pack
 *      effective-view read). The install planner writes a pack's declared
 *      operation-group grants under its `installed_pack_id`; uninstall drops exactly
 *      that pack's rows (per-pack isolation — uninstall of pack A leaves pack B's
 *      grants on the same connection intact).
 *  The value is the `grant_policy` value_shape; a grant is the minimal
 *  `{ allowed: true }` (presence ⇒ granted), and a revoke/remove DELETES the row.
 *
 *  Effective at gateway dispatch via the PROFILE-UNION (D-165 P3, Path A). The
 *  runtime resolves operations against the in-memory `ConnectionOperationProfile`,
 *  NOT against `contract.grant` directly: `composeForRole('grant_resolution', …)`
 *  skips the `grant` scope because the dispatch context carries no `installed_pack_id`
 *  (the grant scope requires it as the LEADING segment, and the effective view must
 *  merge ACROSS packs — `contract-dispatch.ts` `strictRequiredPrefix` → null; gateway
 *  `OVERRIDE_TIGHTENING_ROLES` comment). Instead the profile seed
 *  (`connection-operation-profile-boot.ts`) UNIONS `listUserGroups` + `listPackOwnedGroups`
 *  per `(ingredient_id, connection_name)` and derives `allowed_operations` from the
 *  union — so a pack-owned grant is consulted at dispatch for any connection that has
 *  an operation profile. D-170 gap #2 (`483da23c`/`3d424707`) closed the local-catalog
 *  case: a private/local composition catalog binds to its connection at install
 *  (`connection_catalog_binding`), and the profile boot derives a profile from that
 *  binding even with no registered vendor — so a composition's own-catalog grants are
 *  now effective at dispatch once the connection is set up (install live-reconciles the
 *  profile so a connect-before-install dispatch works at once).
 *
 *  Local-only by construction — the contract store never syncs cloud (D-090/D-097/D-168).
 */

import type { ContractStore } from './contract-store.js';
import type { ConnectionStoreSqlite } from './connection-store.js';

/** The contract.grant scope name (a `composite_keys` entry in the contract schema). */
const GRANT_SCOPE = 'grant';

/** Reserved `installed_pack_id` for a user-MANUAL grant — one with no owning pack.
 *  Pack-owned grants carry a real pack slug here; user grants share this sentinel.
 *  A pack slug can never collide with it (pack slugs are vendor handles, never the
 *  double-underscore sentinel). */
export const USER_GRANT_PACK_ID = '__user__';

/** Typed view of the `grant_policy` value_shape (`contract-schema.ts`). A grant
 *  row's presence unlocks the keyed group/operation; `allowed` is the only required
 *  field. The user-grant interim writes the minimal `{ allowed: true }`; the richer
 *  policy fields (carried by pack-owned grants the P3 install planner writes) compose
 *  under `union_with_stricter_wins`. Kept in lock-step with the value_shape — a field
 *  added there must be added here. */
export interface GrantPolicy {
  allowed: boolean;
  approval?: 'never' | 'ask' | 'always';
  risk_tier?: 'read' | 'write' | 'admin' | 'destructive';
  denied_operation_ids?: string[];
  approval_required_operation_ids?: string[];
  max_risk_without_approval?: 'read' | 'write' | 'admin' | 'none';
}

/** Both halves of `contract.grant` — the durable backing for the
 *  `grant/revoke/listOperationGroup` rpcs + the operation-profile boot seed
 *  (user-manual `__user__` rows) AND the D-165 P3 install planner's pack-owned
 *  rows (a real `installed_pack_id`). The `*User*` methods scope to the `__user__`
 *  sentinel; the `*Pack*` methods scope to a pack's real `installed_pack_id`;
 *  `listPackOwnedGroups` reads ACROSS packs for the effective-view union. */
export interface ContractGrantStore {
  /** The group ids the user has granted on `(ingredient_id, connection_name)`
   *  (`allowed === true`), ascending + deduped — the drop-in replacement for the
   *  retired store's `listGroups`. `ingredient_id` is the connection's catalog
   *  slug (`catalogSlugForVendor`). */
  listUserGroups(ingredient_id: string, connection_name: string): string[];
  /** Grant a group — idempotent upsert of `{ allowed: true }` under
   *  `(__user__, ingredient_id, connection_name, group_id)`. A repeat grant is a
   *  no-op on the granted set. */
  grantUserGroup(ingredient_id: string, connection_name: string, group_id: string): void;
  /** Revoke a group — delete the `(__user__, …)` row. No-op when absent. */
  revokeUserGroup(ingredient_id: string, connection_name: string, group_id: string): void;
  /** Drop EVERY user grant referencing `connection_name` (across catalog slugs) —
   *  called on connection delete so a stale grant never outlives the connection it
   *  described. Only `__user__` rows are dropped; pack-owned grants for the same
   *  connection are left to the P3 install planner's uninstall path (a connection
   *  has exactly one vendor, so all its user grants share one `ingredient_id`, but
   *  the connection-delete hook carries only the name — no slug — so we scan the
   *  `__user__` rows and filter by the `connection_name` segment). */
  deleteAllUserGroupsForConnection(connection_name: string): void;

  // ── D-165 P3 install planner — the pack-owned half ──

  /** The group ids granted by ANY installed pack (a real `installed_pack_id`, the
   *  `__user__` sentinel EXCLUDED) on `(ingredient_id, connection_name)`, ascending
   *  + deduped. The effective-view union pairs this with `listUserGroups` (the two
   *  are disjoint by owner; `deriveAllowedOperations` dedupes the union anyway).
   *  `installed_pack_id` is the LEADING grant segment so a `(*, ingredient,
   *  connection)` match can't anchor a leading-prefix scan — we scan the whole
   *  (bounded) grant scope and filter, the same shape as
   *  `deleteAllUserGroupsForConnection`.
   *
   *  `excludePackId` (R2 §1.6 grant-only-degradation follow-on) drops ONE pack's
   *  rows from the view — the uninstall disclosure simulates a surviving
   *  connection's POST-uninstall profile by re-deriving with the uninstalling
   *  pack's groups excluded (exactly what `removePackGroups` + the profile
   *  reconcile will produce). Omitted → all packs (the live effective view). */
  listPackOwnedGroups(
    ingredient_id: string,
    connection_name: string,
    excludePackId?: string,
  ): string[];
  /** Grant a pack-owned operation group — idempotent upsert of `{ allowed: true }`
   *  under `(installed_pack_id, ingredient_id, connection_name, group_id)`. The
   *  install planner calls this once per declared grant default, inside the install
   *  transaction. Throws on the `__user__` sentinel (use `grantUserGroup` for the
   *  manual half) so a pack can never write into the user-owned space. */
  grantPackGroup(
    installed_pack_id: string,
    ingredient_id: string,
    connection_name: string,
    group_id: string,
  ): void;
  /** Drop EVERY grant owned by `installed_pack_id` (across ingredients + connections)
   *  — the uninstall counterpart, scoped by the LEADING `installed_pack_id` segment
   *  so a leading-prefix scan suffices. Other packs' grants (and `__user__` grants)
   *  on the same connection survive (per-pack isolation). Throws on the `__user__`
   *  sentinel so a pack uninstall can never nuke the manual-grant space. */
  removePackGroups(installed_pack_id: string): void;
  /** Drop EVERY pack-owned grant referencing `connection_name` (across ALL packs +
   *  ingredients) — the pack-owned counterpart of {@link deleteAllUserGroupsForConnection},
   *  called on connection delete (D-194 S-2). The connection is gone, so no installed
   *  pack should keep a grant on it: a same-name re-enroll would otherwise silently
   *  revive the pack's access to a possibly-DIFFERENT account (the row survives the
   *  connection it described). `connection_name` is a NON-leading segment and this
   *  spans every pack, so — like `deleteAllUserGroupsForConnection` — we scan the whole
   *  (bounded) grant scope and filter by the `connection_name` segment. The `__user__`
   *  half is SKIPPED (dropped by `deleteAllUserGroupsForConnection`, which the delete
   *  hook calls alongside this), so the two are disjoint and idempotent together.
   *  Deny-until-granted then holds on re-enroll — re-consent is required, exactly the
   *  uninstall→reinstall posture. */
  deleteAllPackGroupsForConnection(connection_name: string): void;
  /** The distinct `(ingredient_id, connection_name)` pairs `installed_pack_id`
   *  holds ≥1 grant row on — the targets `removePackGroups` will touch (R2 §1.6
   *  grant-only-degradation follow-on). The uninstall disclosure walks these to
   *  find SURVIVING connections whose profile shrinks when this pack's grants
   *  drop; the uninstall handler unions their connection names into its profile
   *  reconcile targets. Same leading-prefix scan as `removePackGroups` (every
   *  row counts, not just `allowed === true` — a pair whose rows contributed
   *  nothing just yields no transition). Deterministic pair order (ascending by
   *  ingredient then connection), deduped. */
  listPackGrantTargets(
    installed_pack_id: string,
  ): Array<{ ingredient_id: string; connection_name: string }>;
  /** The distinct `installed_pack_id`s that hold ≥1 pack-owned grant on
   *  `connection_name` — the "which packs are granted to dispatch on this
   *  connection" pivot (D-194 #6, the connection-detail "Used by packs" list).
   *  Post-D-194-3a a pack grant names the SPECIFIC connection (the install's
   *  `chosen_connection`), so this discriminates two accounts of one vendor
   *  (`onedrive_work` vs `onedrive_personal`) — unlike a vendor-keyed match.
   *  `connection_name` is a NON-leading segment, so — like
   *  `deleteAllPackGroupsForConnection` — this scans the whole (bounded) grant
   *  scope and filters, skipping the `__user__` sentinel (user grants are
   *  connection-level, not pack-attributed). Ascending + deduped. NOTE: a pack
   *  installed WITHOUT a chosen connection carries the authored literal here, not
   *  a real connection name, so it won't appear under a real connection (precise,
   *  but see the caller's fallback for the grant-absent case). */
  listPacksForConnection(connection_name: string): string[];
}

/** A grant row's segment depth — the `grant` scope is keyed on the full 4-tuple
 *  `(installed_pack_id, ingredient_id, connection_name, group_id_or_operation_id)`. */
const GRANT_SEGMENT_COUNT = 4;
/** Index of the `installed_pack_id` segment within the 4-tuple. */
const PACK_ID_SEGMENT = 0;
/** Index of the `ingredient_id` segment within the 4-tuple. */
const INGREDIENT_ID_SEGMENT = 1;
/** Index of the `connection_name` segment within the 4-tuple. */
const CONNECTION_NAME_SEGMENT = 2;
/** Index of the `group_id_or_operation_id` segment within the 4-tuple. */
const GROUP_SEGMENT = 3;

/** Wrap a {@link ContractStore} as the user-grant `ContractGrantStore`. Stateless —
 *  every call forwards to the shared store handle; safe to construct more than once
 *  over the same store. */
export const createContractGrantStore = (
  contractStore: ContractStore,
): ContractGrantStore => {
  const userGrantSegments = (
    ingredient_id: string,
    connection_name: string,
    group_id: string,
  ): [string, string, string, string] => [
    USER_GRANT_PACK_ID,
    ingredient_id,
    connection_name,
    group_id,
  ];

  return {
    listUserGroups(ingredient_id, connection_name) {
      // Prefix-scan anchors on the 3 leading segments; the contract store's seg_key
      // codec keeps the scan on a `.` boundary, so a connection_name of `deal` never
      // bleeds into `dealflow`. Every match is a full 4-segment grant row.
      const rows = contractStore.scan(GRANT_SCOPE, [
        USER_GRANT_PACK_ID,
        ingredient_id,
        connection_name,
      ]);
      const groups: string[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        if (row.segments.length !== GRANT_SEGMENT_COUNT) continue;
        const group_id = row.segments[GROUP_SEGMENT];
        const value = row.value as Partial<GrantPolicy> | null;
        if (value?.allowed === true && !seen.has(group_id)) {
          seen.add(group_id);
          groups.push(group_id);
        }
      }
      // Ascending order — matches the retired store's `ORDER BY group_id ASC` so the
      // rpc view + the merged `allowed_operations` derivation stay deterministic.
      // Catalog group ids are lowercase-ascii, so UTF-16 sort agrees with SQLite BINARY.
      return groups.sort();
    },

    grantUserGroup(ingredient_id, connection_name, group_id) {
      // `put` is an idempotent upsert keyed on (scope, segments); re-granting rewrites
      // the identical value (granted set unchanged). The `grant` scope is
      // `union_with_stricter_wins`, NOT `tightening_only`, so no loosen-check runs.
      contractStore.put(
        GRANT_SCOPE,
        userGrantSegments(ingredient_id, connection_name, group_id),
        { allowed: true } satisfies GrantPolicy,
      );
    },

    revokeUserGroup(ingredient_id, connection_name, group_id) {
      contractStore.delete(
        GRANT_SCOPE,
        userGrantSegments(ingredient_id, connection_name, group_id),
      );
    },

    deleteAllUserGroupsForConnection(connection_name) {
      // The connection-delete hook carries only the name (no vendor/slug), so scan
      // every user grant and drop the ones whose connection_name segment matches.
      // The grant scope is tiny (a handful of rows), so a full `__user__` scan is cheap.
      const rows = contractStore.scan(GRANT_SCOPE, [USER_GRANT_PACK_ID]);
      for (const row of rows) {
        if (
          row.segments.length === GRANT_SEGMENT_COUNT &&
          row.segments[CONNECTION_NAME_SEGMENT] === connection_name
        ) {
          contractStore.delete(GRANT_SCOPE, row.segments);
        }
      }
    },

    listPackOwnedGroups(ingredient_id, connection_name, excludePackId) {
      // `installed_pack_id` is the LEADING segment, so a `(*, ingredient, connection)`
      // match can't be anchored by a leading-prefix scan — scan the whole (bounded)
      // grant scope and filter. The `__user__` sentinel is excluded so this stays
      // disjoint from `listUserGroups` (the seed unions the two).
      const rows = contractStore.scan(GRANT_SCOPE, []);
      const groups: string[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        if (row.segments.length !== GRANT_SEGMENT_COUNT) continue;
        if (row.segments[PACK_ID_SEGMENT] === USER_GRANT_PACK_ID) continue;
        if (excludePackId !== undefined && row.segments[PACK_ID_SEGMENT] === excludePackId)
          continue;
        if (row.segments[INGREDIENT_ID_SEGMENT] !== ingredient_id) continue;
        if (row.segments[CONNECTION_NAME_SEGMENT] !== connection_name) continue;
        const group_id = row.segments[GROUP_SEGMENT];
        const value = row.value as Partial<GrantPolicy> | null;
        if (value?.allowed === true && !seen.has(group_id)) {
          seen.add(group_id);
          groups.push(group_id);
        }
      }
      // Ascending — matches `listUserGroups` so the unioned `allowed_operations`
      // derivation stays deterministic regardless of which half a group came from.
      return groups.sort();
    },

    grantPackGroup(installed_pack_id, ingredient_id, connection_name, group_id) {
      if (installed_pack_id === USER_GRANT_PACK_ID) {
        // Defensive: a pack slug can never BE the double-underscore sentinel, so
        // this guards a programmer error (calling the pack path with the user
        // sentinel) rather than a reachable input.
        throw new Error(
          `grantPackGroup: refusing to write into the reserved '${USER_GRANT_PACK_ID}' user-grant space — use grantUserGroup`,
        );
      }
      // Idempotent upsert keyed on (scope, segments); a re-install rewrites the
      // identical value. The `grant` scope is `union_with_stricter_wins`, NOT
      // `tightening_only`, so no loosen-check runs.
      contractStore.put(
        GRANT_SCOPE,
        [installed_pack_id, ingredient_id, connection_name, group_id],
        { allowed: true } satisfies GrantPolicy,
      );
    },

    removePackGroups(installed_pack_id) {
      if (installed_pack_id === USER_GRANT_PACK_ID) {
        // A pack uninstall must never delete the user-manual grant space.
        throw new Error(
          `removePackGroups: refusing to drop the reserved '${USER_GRANT_PACK_ID}' user-grant space`,
        );
      }
      // `installed_pack_id` is the LEADING segment, so a leading-prefix scan returns
      // exactly this pack's rows (and nothing else — the seg_key codec keeps the scan
      // on a `.` boundary, so a pack id `acme` never bleeds into `acme-extended`).
      const rows = contractStore.scan(GRANT_SCOPE, [installed_pack_id]);
      for (const row of rows) {
        if (row.segments.length === GRANT_SEGMENT_COUNT) {
          contractStore.delete(GRANT_SCOPE, row.segments);
        }
      }
    },

    deleteAllPackGroupsForConnection(connection_name) {
      // `connection_name` is a NON-leading segment (index 2), so a leading-prefix scan
      // can't anchor it — scan the whole (bounded) grant scope and filter, the same
      // shape as `deleteAllUserGroupsForConnection`/`listPackOwnedGroups`. The `__user__`
      // half is skipped: the delete hook calls `deleteAllUserGroupsForConnection`
      // alongside this, so the two stay disjoint (and re-running either is idempotent).
      // `scan` materializes the rows before we delete, so mutating mid-loop is safe.
      const rows = contractStore.scan(GRANT_SCOPE, []);
      for (const row of rows) {
        if (row.segments.length !== GRANT_SEGMENT_COUNT) continue;
        if (row.segments[PACK_ID_SEGMENT] === USER_GRANT_PACK_ID) continue;
        if (row.segments[CONNECTION_NAME_SEGMENT] !== connection_name) continue;
        contractStore.delete(GRANT_SCOPE, row.segments);
      }
    },

    listPackGrantTargets(installed_pack_id) {
      // Same leading-prefix scan as `removePackGroups` — the targets are exactly
      // the pairs that removal will touch, regardless of each row's value.
      const pairs = new Map<string, { ingredient_id: string; connection_name: string }>();
      for (const row of contractStore.scan(GRANT_SCOPE, [installed_pack_id])) {
        if (row.segments.length !== GRANT_SEGMENT_COUNT) continue;
        const ingredient_id = row.segments[INGREDIENT_ID_SEGMENT];
        const connection_name = row.segments[CONNECTION_NAME_SEGMENT];
        pairs.set(`${ingredient_id}\u0000${connection_name}`, { ingredient_id, connection_name });
      }
      return [...pairs.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, pair]) => pair);
    },

    listPacksForConnection(connection_name) {
      // `connection_name` is a NON-leading segment (index 2), so scan the whole
      // (bounded) grant scope and filter — the same shape as
      // `deleteAllPackGroupsForConnection`, collecting the distinct pack ids
      // instead of deleting. The `__user__` half is skipped: user grants are
      // connection-level (keyed on catalog slug, not a pack), so they carry no
      // pack attribution for a "used by packs" pivot.
      const packs = new Set<string>();
      for (const row of contractStore.scan(GRANT_SCOPE, [])) {
        if (row.segments.length !== GRANT_SEGMENT_COUNT) continue;
        if (row.segments[PACK_ID_SEGMENT] === USER_GRANT_PACK_ID) continue;
        if (row.segments[CONNECTION_NAME_SEGMENT] !== connection_name) continue;
        packs.add(row.segments[PACK_ID_SEGMENT]);
      }
      return [...packs].sort();
    },
  };
};

/** Couple name-keyed operation grants to the durable connection lifecycle.
 * Connection rows are keyed by `(kind, name)`, so a same-name sibling keeps
 * the shared grants alive; deleting the final row drops both grant owners and
 * forces explicit consent before a same-name re-enrollment can dispatch. */
export const wireConnectionGrantCleanup = (
  connectionStore: Pick<ConnectionStoreSqlite, 'list' | 'addOnDelete'>,
  grantStore: Pick<
    ContractGrantStore,
    'deleteAllUserGroupsForConnection' | 'deleteAllPackGroupsForConnection'
  >,
): void => {
  connectionStore.addOnDelete((_kind, name) => {
    if (connectionStore.list().some((row) => row.name === name)) return;
    grantStore.deleteAllUserGroupsForConnection(name);
    grantStore.deleteAllPackGroupsForConnection(name);
  });
};
