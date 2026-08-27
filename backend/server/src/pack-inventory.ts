/** D-165 P3.1 — install-inventory bookkeeping for the `contract.*` store.
 *
 *  On a successful pack install the server records two kinds of inventory
 *  row so the contract store finally reflects what is installed (today it
 *  holds only the seeded schema + D-166 user overrides):
 *
 *    - `contract.installed_pack.<pack_slug>` — one row per installed pack
 *      (`installed_pack_info`: pack_slug, version, installed_at,
 *      ingredient_ids[]).
 *    - `contract.installed_ingredient.<ingredient_id>` — one row per catalog
 *      ingredient the pack's `contents[]` declared
 *      (`installed_ingredient_info`: ingredient_id, version, installed_at,
 *      source_pack_slug).
 *
 *  This is PURE inventory bookkeeping — it does NOT provision capability.
 *  Pack-owned operation-group grants, connection binding, channel
 *  registration, and schema discovery remain deferred (the engine echoes
 *  them as `deferred_contents`; their provisioning is the later P3 grant /
 *  discovery slices). An `installed_ingredient` row records that a pack
 *  brought a catalog ingredient into the system; the gateway still gates
 *  every operation on grants (default-OFF), so inventory presence alone
 *  grants nothing. The later slices build on these rows: the D-166 override
 *  picker can source the real catalog (today it falls back to the manifest
 *  registry because this table is empty), the gateway `ingredient_inventory`
 *  / `pack_inventory` dispatch roles get rows to scan, and the install
 *  planner can read prior inventory.
 *
 *  Ownership model. `installed_ingredient` is keyed on `[ingredient_id]`
 *  alone — ONE row per ingredient, shared across every pack that declares
 *  it (a later install upserts it). The authoritative many-packs→ingredient
 *  mapping lives in each `installed_pack.ingredient_ids`, so the invariant
 *  is: an `installed_ingredient[X]` row exists iff at least one
 *  `installed_pack` row still lists X. `source_pack_slug` is the most-recent
 *  installer (provenance / audit only) — NOT the deletion signal; uninstall
 *  decides what to drop by scanning whether any OTHER `installed_pack` still
 *  lists the id, so a shared ingredient survives until its last owner is
 *  uninstalled. The full multi-pack grant merge is deferred (D-166 P2 / the
 *  P3 grant migration); this scan IS the correct inventory rule on its own.
 *
 *  Scope note — recipe-only (v1) packs and foundation packs auto-installed
 *  at boot carry no catalog ingredients, so they contribute only an
 *  `installed_pack` row with an empty `ingredient_ids`. The boot
 *  foundation-pack path (`compose-storage-context.ts`) runs before the
 *  app-context contract store exists, so it does NOT pass a store and is a
 *  no-op here — foundation packs are absent from inventory until a later
 *  boot-ordering / reconcile slice. The user-driven `packs.install` /
 *  `packs.uninstall` rpc path is fully covered.
 *
 *  Spec: D-165 § "Install planner" (bullet 6, inventory
 *  half); the `contract.*` schema + write-validator live in
 *  `packages/contracts/src/contract-schema.ts`. */

import { OWNER_OPERATION_SCOPE } from '@recued/contracts';
import type { CatalogKind, IngredientManifest, PackContentRef } from '@recued/contracts';
import type { PackOpBinding, PackOpResolution } from '@recued/recipes';

import type { ContractStore } from './storage/contract-store.js';

/** The `installed_ingredient` / `installed_pack` contract scopes. Named
 *  here so the writer + the uninstall remover agree on the strings the
 *  `D165_CONTRACT_SCHEMA.composite_keys` declare. */
const INSTALLED_INGREDIENT_SCOPE = 'installed_ingredient';
const INSTALLED_PACK_SCOPE = 'installed_pack';

/** A non-null, non-array JSON object — guards a `ContractRow.value` (typed
 *  `unknown`) before field access. */
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Read an `installed_pack` row's `ingredient_ids` defensively — every
 *  string entry, deduped in first-seen order. Returns `[]` for an absent /
 *  malformed row. */
const ingredientIdsOf = (value: unknown): string[] => {
  if (!isRecord(value) || !Array.isArray(value.ingredient_ids)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of value.ingredient_ids) {
    if (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
};

/** The set of ingredient ids still listed by some installed pack OTHER than
 *  `exceptSlug` — the survivor set that must NOT be dropped when `exceptSlug`
 *  is uninstalled OR drops an ingredient on re-install. Excludes `exceptSlug`'s
 *  own row so the caller's current/new pack state never keeps an id alive by
 *  itself. Cheap (spec storage-scale: ~10 packs). */
const idsClaimedByOtherPacks = (store: ContractStore, exceptSlug: string): Set<string> => {
  const claimed = new Set<string>();
  for (const other of store.scan(INSTALLED_PACK_SCOPE)) {
    if (other.segments[0] === exceptSlug) continue;
    for (const id of ingredientIdsOf(other.value)) claimed.add(id);
  }
  return claimed;
};

/** Resolve the (id, version) identity of one ingredient content ref —
 *  requiring EXACTLY ONE COMPLETE addressing mode, mirroring the manifest
 *  validator (`validatePackContentRef`):
 *    - id-mode:   `ingredient_id` (non-empty string) + `ingredient_version`
 *                 (number), with no slug-mode field present;
 *    - slug-mode: `slug` (non-empty string) + `version` (number), with no
 *                 id-mode field present (`role` is a slug-mode field).
 *  A cross-mode ref (`ingredient_id` + `version`), a partial ref (one field
 *  of a mode), or an empty ref returns null so the caller skips it rather
 *  than writing a schema-valid-but-semantically-wrong row. The inventory key
 *  segment is `ingredient_id`; the marketplace `slug` is the identifier in
 *  slug-mode. */
const resolveIngredientIdentity = (
  c: Extract<PackContentRef, { type: 'ingredient' }>,
): { id: string; version: number } | null => {
  const byId = c.ingredient_id !== undefined || c.ingredient_version !== undefined;
  const bySlug = c.slug !== undefined || c.version !== undefined || c.role !== undefined;
  // Mixed modes — the manifest validator rejects these; refuse here too.
  if (byId && bySlug) return null;
  if (byId) {
    if (
      typeof c.ingredient_id === 'string'
      && c.ingredient_id.length > 0
      && typeof c.ingredient_version === 'number'
    ) {
      return { id: c.ingredient_id, version: c.ingredient_version };
    }
    return null;
  }
  if (bySlug) {
    if (
      typeof c.slug === 'string'
      && c.slug.length > 0
      && typeof c.version === 'number'
    ) {
      return { id: c.slug, version: c.version };
    }
    return null;
  }
  return null;
};

export interface RecordPackInventoryInput {
  /** URL-safe pack slug — the `installed_pack` key + the `source_pack_slug`
   *  stamped on every `installed_ingredient` row this pack writes. */
  pack_slug: string;
  /** D-182 Slice 4 — the pack's publisher handle (`manifest.publisher`). Written
   *  on the `installed_pack` row (when present) so the inventory is the
   *  authoritative `pack_ref` (`<publisher>.<pack_slug>`) → catalog source the
   *  Tier-P op-step lowering resolves against. The three production callers always
   *  pass it (the manifest parser non-empty-checks `publisher`); OPTIONAL so a
   *  fixture / non-pack inventory write need not — a row written without it has no
   *  resolvable `pack_ref`, so `buildPackOpResolution` skips it fail-closed. */
  publisher?: string;
  /** The slug the pack's AUTHOR gave it, when `pack_slug` above is NOT that.
   *  Only the Records coordinator passes it: a Records pack's row is keyed by
   *  its generated content-addressed catalog id (`records-<hash>`), so without
   *  this the authored name is absent from the row entirely and no dependent
   *  pack's Tier-P op can resolve against it. Every other caller's `pack_slug`
   *  already IS the authored slug, so they omit it. */
  authored_pack_slug?: string;
  /** Monotonic pack-manifest version (`manifest.version`). Stored as a
   *  string per the `installed_pack_info.version` value_shape. */
  pack_version: number;
  /** Normalized pack contents (`normalizeBulkPackInstallPlan(manifest).contents`).
   *  Only `type: 'ingredient'` entries become `installed_ingredient` rows;
   *  recipe / operation_group / channel_binding / policy entries are
   *  ignored here (recipes install via the engine; the rest stay deferred). */
  contents: readonly PackContentRef[];
  /** D-170 — `catalog_kind` stamped on every `installed_ingredient` row derived
   *  from a `contents` entry. Locally-authored composition catalogs pass
   *  `'private_byo'` (the signal a row's body lives in the local manifest store,
   *  not the marketplace). Omitted for marketplace pack installs (the field stays
   *  absent, as before). Does NOT apply to `local_catalogs` — those carry their
   *  own per-entry kind. */
  catalog_kind?: CatalogKind;
  /** D-170 (packs.install composition branch) — decomposed local composition
   *  catalogs to record ALONGSIDE the by-ref `contents` ingredients in ONE
   *  `installed_pack` row. Each joins `installed_pack.ingredient_ids` and gets an
   *  `installed_ingredient` row carrying its OWN `catalog_kind` (`private_byo` →
   *  the body lives in the local manifest store, the gateway resolves it via N.16).
   *  Recording them here lets a composition app_pack that ALSO lists by-ref
   *  marketplace ingredients persist both with correct per-row kinds — the by-ref
   *  rows keep their marketplace kind, the composition catalog gets `private_byo`.
   *  When an id appears in both lists, the `local_catalogs` kind wins (a local body
   *  must signal `private_byo`). Empty / absent for every non-composition install. */
  local_catalogs?: ReadonlyArray<{
    ingredient_id: string;
    version: number;
    catalog_kind: CatalogKind;
  }>;
  /** Epoch-ms install timestamp — the same `now` the recipe install used. */
  installed_at: number;
}

/** What {@link recordPackInventory} wrote — the deduped ingredient ids that
 *  landed in `installed_pack.ingredient_ids` (and as `installed_ingredient`
 *  rows). Returned for logging + test assertions; the caller may ignore it. */
export interface RecordPackInventoryResult {
  ingredient_ids: string[];
}

/** Record `installed_pack` + `installed_ingredient` inventory for one
 *  successful pack install. Idempotent upsert keyed on the scopes' segments,
 *  so a re-install (version bump) overwrites in place. `installed_at` is set
 *  to the passed value on every write (the time of the most recent install
 *  transaction for this pack).
 *
 *  Atomic: every row is written inside one `store.transaction` — a throw
 *  (only a schema-validation bug on well-formed data, or a SQLite-level
 *  error, could) rolls the whole batch back, so the store never holds a
 *  partial install (e.g. orphan `installed_ingredient` rows with no pack
 *  row). The rpc caller wraps the call so a bookkeeping failure never fails
 *  the user's already-committed install; with rollback that failure leaves
 *  the inventory cleanly absent (a re-install re-records it). */
export const recordPackInventory = (
  store: ContractStore,
  input: RecordPackInventoryInput,
): RecordPackInventoryResult => {
  // Resolve identities first (pure) so the transaction body is write-only. Each
  // row carries the catalog_kind it should persist with: a by-ref `contents`
  // ingredient takes the input-wide `catalog_kind` (absent for marketplace),
  // a `local_catalogs` entry takes its own (`private_byo`). Processed contents-
  // first so a colliding id's `local_catalogs` kind wins the last write.
  const rows: Array<{ id: string; version: number; catalog_kind?: CatalogKind }> = [];
  const ingredientIds: string[] = [];
  const seen = new Set<string>();
  const addRow = (id: string, version: number, catalog_kind?: CatalogKind): void => {
    rows.push({ id, version, ...(catalog_kind ? { catalog_kind } : {}) });
    if (!seen.has(id)) {
      seen.add(id);
      ingredientIds.push(id);
    }
  };
  for (const content of input.contents) {
    if (content.type !== 'ingredient') continue;
    const identity = resolveIngredientIdentity(content);
    // A ref the manifest validator would have rejected (mixed / partial /
    // empty addressing) — skip rather than write an invalid row.
    if (identity === null) continue;
    addRow(identity.id, identity.version, input.catalog_kind);
  }
  for (const cat of input.local_catalogs ?? []) {
    addRow(cat.ingredient_id, cat.version, cat.catalog_kind);
  }

  store.transaction(() => {
    // Ids THIS pack listed BEFORE this (re-)install — read before overwriting
    // so we can GC any an updated manifest dropped.
    const priorRow = store.get(INSTALLED_PACK_SCOPE, [input.pack_slug]);
    const priorIds = priorRow === null ? [] : ingredientIdsOf(priorRow.value);

    for (const { id, version, catalog_kind } of rows) {
      store.put(INSTALLED_INGREDIENT_SCOPE, [id], {
        ingredient_id: id,
        version: String(version),
        installed_at: input.installed_at,
        source_pack_slug: input.pack_slug,
        ...(catalog_kind ? { catalog_kind } : {}),
      });
    }
    store.put(INSTALLED_PACK_SCOPE, [input.pack_slug], {
      pack_slug: input.pack_slug,
      // Written only when supplied — keeps a publisher-less fixture row's shape
      // unchanged (the field is optional in the schema; the builder fail-closes
      // on its absence rather than minting a `<undefined>.<pack>` pack_ref).
      ...(input.publisher !== undefined && input.publisher.length > 0
        ? { publisher: input.publisher }
        : {}),
      version: String(input.pack_version),
      installed_at: input.installed_at,
      ingredient_ids: ingredientIds,
      // Written only when it actually differs — a non-Records pack would just
      // duplicate `pack_slug`, and a redundant field invites a reader to pick
      // the wrong one of two identical values.
      ...(input.authored_pack_slug !== undefined
        && input.authored_pack_slug.length > 0
        && input.authored_pack_slug !== input.pack_slug
        ? { authored_pack_slug: input.authored_pack_slug }
        : {}),
    });

    // GC ingredients this pack previously listed but the new manifest dropped —
    // delete each unless another installed pack still lists it. Keeps the
    // "installed_ingredient[X] exists iff some installed_pack lists X" invariant
    // across re-installs (a version bump that removes an ingredient).
    const newIds = new Set(ingredientIds);
    const dropped = priorIds.filter((id) => !newIds.has(id));
    if (dropped.length > 0) {
      const claimedByOthers = idsClaimedByOtherPacks(store, input.pack_slug);
      for (const id of dropped) {
        if (!claimedByOthers.has(id)) store.delete(INSTALLED_INGREDIENT_SCOPE, [id]);
      }
    }
  });

  return { ingredient_ids: ingredientIds };
};

/** What {@link removePackInventory} dropped. */
export interface RemovePackInventoryResult {
  /** Count of `installed_ingredient` rows removed (those this pack listed
   *  that no other installed pack still lists). */
  removed_ingredients: number;
  /** True iff an `installed_pack` row existed + was removed. */
  removed_pack: boolean;
}

/** Reverse {@link recordPackInventory} for one uninstalled pack. Reads the
 *  pack's own `installed_pack.ingredient_ids` (the authoritative record of
 *  what THIS pack installed — robust to manifest drift between install and
 *  uninstall, mirroring how the recipe uninstall path keys off the stored
 *  `pack_slug` column rather than the current manifest), drops the
 *  `installed_pack` row, and drops each `installed_ingredient` row this pack
 *  listed that NO OTHER `installed_pack` still lists.
 *
 *  Using "still listed by another pack" (not `source_pack_slug`) as the
 *  ownership signal keeps a shared ingredient alive until its last owner is
 *  uninstalled, regardless of install order: install A(X) then B(X) then
 *  uninstall B leaves X (A still lists it); uninstalling A then drops it.
 *
 *  Atomic + idempotent: all reads + deletes run inside one `store.transaction`,
 *  and an absent `installed_pack` row removes nothing. The rpc caller wraps
 *  the call so a bookkeeping failure never fails the uninstall. */
export const removePackInventory = (
  store: ContractStore,
  pack_slug: string,
): RemovePackInventoryResult => {
  let removedIngredients = 0;
  let removedPack = false;

  store.transaction(() => {
    const packRow = store.get(INSTALLED_PACK_SCOPE, [pack_slug]);
    const ownedIds = packRow === null ? [] : ingredientIdsOf(packRow.value);
    // Ids still claimed by any OTHER installed pack must survive even though
    // this pack listed them (excludes this pack's own row).
    const claimedByOthers =
      ownedIds.length > 0 ? idsClaimedByOtherPacks(store, pack_slug) : new Set<string>();

    removedPack = store.delete(INSTALLED_PACK_SCOPE, [pack_slug]);
    for (const id of ownedIds) {
      if (claimedByOthers.has(id)) continue;
      if (store.delete(INSTALLED_INGREDIENT_SCOPE, [id])) removedIngredients += 1;
    }
  });

  return { removed_ingredients: removedIngredients, removed_pack: removedPack };
};

/** D-170 — what `removePackInventory(pack_slug)` WOULD drop, computed WITHOUT
 *  mutating. The authored-uninstall pin-guard reads this before removing so it
 *  can block on a dependent recipe (and tell a pack-absent `not_found` apart
 *  from a pack whose ingredients are all still claimed by other packs). */
export interface PreviewPackDropResult {
  /** True iff an `installed_pack` row exists for the slug. */
  exists: boolean;
  /** Ids this pack owns that no OTHER installed pack still lists — exactly the
   *  set `removePackInventory` would delete. */
  droppable: string[];
}

export const previewDroppableIds = (
  store: ContractStore,
  pack_slug: string,
): PreviewPackDropResult => {
  const packRow = store.get(INSTALLED_PACK_SCOPE, [pack_slug]);
  if (packRow === null) return { exists: false, droppable: [] };
  const ownedIds = ingredientIdsOf(packRow.value);
  if (ownedIds.length === 0) return { exists: true, droppable: [] };
  const claimedByOthers = idsClaimedByOtherPacks(store, pack_slug);
  return { exists: true, droppable: ownedIds.filter((id) => !claimedByOthers.has(id)) };
};

/** D-170 (packs.install composition branch) — true iff `installed_ingredient.<id>`
 *  is recorded as a LOCAL composition catalog (`catalog_kind === 'private_byo'`).
 *  The ownership signal that gates body deletion to ids a pack actually authored:
 *  a by-ref marketplace id has no `catalog_kind`, and a standalone local body a
 *  pack merely LISTS by-ref has its `private_byo` kind cleared when the by-ref
 *  recording overwrites the row — so neither qualifies, and neither's body is
 *  deleted on reinstall-orphan-cleanup or uninstall. */
export const isPrivateByoIngredient = (
  store: ContractStore,
  ingredient_id: string,
): boolean => {
  const row = store.get(INSTALLED_INGREDIENT_SCOPE, [ingredient_id]);
  return row !== null && isRecord(row.value) && row.value.catalog_kind === 'private_byo';
};

/** D-170 (packs.install composition branch) — the droppable ids this pack
 *  provisioned as a LOCAL composition catalog, the exact set whose local body +
 *  registry entry the uninstall should delete. Strictly NARROWER than
 *  `previewDroppableIds().droppable`: filters to {@link isPrivateByoIngredient} so
 *  a by-ref marketplace id (or a standalone local body a pack merely lists by-ref)
 *  is excluded — uninstall never deletes a body this pack didn't author. Still
 *  refcount-aware (drops nothing another pack lists, via `previewDroppableIds`). */
export const privateByoDropIds = (
  store: ContractStore,
  pack_slug: string,
): string[] => {
  const { droppable } = previewDroppableIds(store, pack_slug);
  return droppable.filter((id) => isPrivateByoIngredient(store, id));
};

/** D-170 — true iff some installed pack lists `ingredient_id`. The standalone
 *  uninstall path uses this to refuse a direct ingredient uninstall of a
 *  pack-owned child (uninstall the owning pack instead). */
export const isIngredientPackOwned = (
  store: ContractStore,
  ingredient_id: string,
): boolean =>
  // `''` excludes no pack (no pack slug is empty per SLUG_RE), so this asks
  // "is the id claimed by ANY installed pack?".
  idsClaimedByOtherPacks(store, '').has(ingredient_id);

/** D-170 — current ownership of one ingredient id, used by the install
 *  cross-mode guard. `installed` is false when no `installed_ingredient` row
 *  exists. When installed, `pack_slug` is the owning pack (most-recent
 *  installer) or undefined for a standalone (1×1) install. NOTE: pack ownership
 *  is authoritatively the `installed_pack.ingredient_ids` lists; this reads the
 *  row's `source_pack_slug` provenance, which is sufficient for the mode guard
 *  (standalone rows never carry it). */
export interface IngredientOwnership {
  installed: boolean;
  pack_slug?: string;
}
export const ingredientOwnership = (
  store: ContractStore,
  ingredient_id: string,
): IngredientOwnership => {
  const row = store.get(INSTALLED_INGREDIENT_SCOPE, [ingredient_id]);
  if (row === null) return { installed: false };
  const value = isRecord(row.value) ? row.value : {};
  const sp = typeof value.source_pack_slug === 'string' ? value.source_pack_slug : undefined;
  return sp !== undefined ? { installed: true, pack_slug: sp } : { installed: true };
};

/** D-170 — every ingredient id one installed pack lists (its
 *  `installed_pack.ingredient_ids`), or `[]` when the pack is absent. The pack
 *  reinstall path reads this BEFORE re-recording inventory to find a prior
 *  catalog id that a renamed composition dropped, so its body + registry entry
 *  can be cleaned (else the old catalog orphans — still resolvable, never
 *  removable). */
export const packIngredientIds = (
  store: ContractStore,
  pack_slug: string,
): string[] => {
  const row = store.get(INSTALLED_PACK_SCOPE, [pack_slug]);
  return row === null ? [] : ingredientIdsOf(row.value);
};

/** Packs-route delta 1 — true iff an `installed_pack` row exists for the slug
 *  AT the given pack version, i.e. the pack went through a real install
 *  transaction (the `packs.install` rpc, the composition provisioner, or — for
 *  a pre_install pack — the boot wire) at THIS manifest version. This is the
 *  canonical install-signal for packs whose `recipes[]` is empty (the 37/47 v2
 *  composition / CLI / workflow packs), where the recipe-store presence check
 *  is structurally blind (length 0 → vacuously not installed).
 *
 *  Version-aware for PARITY with the recipe-bearing branch
 *  (`pack-list-handler.ts`), which flips `installed` back to false on version
 *  drift so the panel surfaces the upgrade path: a v2 app/CLI pack installed at
 *  v1 then bumped to v2 on disk must re-show Install, not read as up-to-date.
 *  The install callers stamp `installed_pack.version = String(manifest.version)`
 *  (`recordPackInventory`), so an exact string compare is the pack-level analog
 *  of the recipe check's `stored.version === ref.version`. Recipe-BEARING packs
 *  keep that recipe-ownership check (it also models twin packs sharing recipe
 *  slugs, which a slug-keyed registry row cannot). */
export const isPackInstalledAtVersion = (
  store: ContractStore,
  pack_slug: string,
  pack_version: number,
): boolean => {
  const row = store.get(INSTALLED_PACK_SCOPE, [pack_slug]);
  return row !== null && isRecord(row.value) && row.value.version === String(pack_version);
};

/** One enumerated `installed_pack` row — the minimal identity + version the
 *  Discover install-state join needs. `version` is parsed from the row's stored
 *  string form. */
export interface InstalledPackRow {
  pack_slug: string;
  version: number;
  publisher?: string;
}

/** Enumerate EVERY `installed_pack` inventory row — bundled AND
 *  marketplace-installed. This is the authoritative "what packs are installed +
 *  at what version" source (the bundled-manifest disk scan `packs.list` walks
 *  can't see a marketplace-installed pack). A row whose stored `version` isn't a
 *  finite number, or whose `pack_slug` is missing/empty, is skipped — a
 *  malformed row can't drive an upgrade compare. Deterministic (scan order is
 *  segment-key sorted). */
/** Parse a stored `installed_pack.version` (persisted as a string) to its
 *  CANONICAL positive-integer form, or `null` when it isn't one. `Number.isFinite`
 *  alone is too weak — `''`, `'1.5'`, `'-1'`, `'0x10'` all coerce to finite
 *  numbers, and `/^\d+$/` would still admit leading-zero forms like `'03'`.
 *  `/^[1-9]\d*$/` is exactly the form the writer emits (`String(n)`, n ≥ 1);
 *  anything else is a corrupt/migrated row that must not drive a version compare. */
const parsePackVersion = (raw: unknown): number | null => {
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
};

const readPublisher = (raw: unknown): string | undefined =>
  typeof raw === 'string' && raw.length > 0 ? raw : undefined;

export const listInstalledPacks = (store: ContractStore): InstalledPackRow[] => {
  const out: InstalledPackRow[] = [];
  for (const row of store.scan(INSTALLED_PACK_SCOPE)) {
    if (!isRecord(row.value)) continue;
    const slug = row.value.pack_slug;
    if (typeof slug !== 'string' || slug.length === 0) continue;
    const version = parsePackVersion(row.value.version);
    if (version === null) continue; // corrupt/migrated version → skip
    const publisher = readPublisher(row.value.publisher);
    out.push({
      pack_slug: slug,
      version,
      ...(publisher !== undefined ? { publisher } : {}),
    });
  }
  return out;
};

/** Is a pack with this AUTHORED slug installed, and at what version? `null` when
 *  it is not, or when its row carries no usable version.
 *
 *  ⛔⛔ `getInstalledPack(store, slug)` CANNOT ANSWER THIS, and the way it fails
 *  is silent. It reads the row KEYED by `slug` — and a Records pack's row is
 *  keyed by its generated content-addressed catalog id (`records-<hash>`), a name
 *  no author writes. So asking it about `federated-projects` returns `null` for a
 *  pack that is very much installed, and any caller branching on that answer
 *  takes the not-installed path for exactly the pack class where being wrong
 *  costs the most. Driven: the inventory held
 *  `records-84016f4885cb4d94b248193d6b702c5e` and nothing else for that pack.
 *
 *  🔑 THE ROW CARRIES ITS OWN AUTHORED NAME. `authored_pack_slug` exists for this
 *  (the Records coordinator is its only writer), and matching EITHER identity is
 *  the same dual-ref rule `buildPackOpResolution` already applies when it binds
 *  both `<publisher>.records-<hash>` and `<publisher>.<authored>`. One more
 *  reader of one existing field, not a second source of truth.
 *
 *  ⚠ STRICT ON VERSION, unlike {@link getInstalledPack}. That one is lenient so a
 *  corrupt row stays removable; a caller asking "is my requirement met" must not
 *  credit a version it cannot read. */
export const findInstalledPackByAuthoredSlug = (
  store: ContractStore,
  authored_slug: string,
): InstalledPackRow | null => {
  for (const row of store.scan(INSTALLED_PACK_SCOPE)) {
    if (!isRecord(row.value)) continue;
    const slug = row.value.pack_slug;
    if (typeof slug !== 'string' || slug.length === 0) continue;
    const authored = typeof row.value.authored_pack_slug === 'string'
      ? row.value.authored_pack_slug.trim()
      : '';
    if (slug !== authored_slug && authored !== authored_slug) continue;
    const version = parsePackVersion(row.value.version);
    if (version === null) return null;
    const publisher = readPublisher(row.value.publisher);
    return { pack_slug: slug, version, ...(publisher !== undefined ? { publisher } : {}) };
  }
  return null;
};

/** Read ONE `installed_pack` row's identity for the uninstall path — the
 *  EXISTENCE proof (bundled OR marketplace) plus the publisher/version a
 *  bundled manifest would otherwise supply. Unlike {@link listInstalledPacks}
 *  this is LENIENT on version: a corrupt-version row still EXISTS and must
 *  stay removable, so `version` is left `undefined` rather than dropping the
 *  whole row. `null` = no inventory row (the pack isn't installed). */
export const getInstalledPack = (
  store: ContractStore,
  pack_slug: string,
): { pack_slug: string; version?: number; publisher?: string } | null => {
  const row = store.get(INSTALLED_PACK_SCOPE, [pack_slug]);
  if (row === null || !isRecord(row.value)) return null;
  const slug = row.value.pack_slug;
  if (typeof slug !== 'string' || slug.length === 0) return null;
  const version = parsePackVersion(row.value.version);
  const publisher = readPublisher(row.value.publisher);
  return {
    pack_slug: slug,
    ...(version !== null ? { version } : {}),
    ...(publisher !== undefined ? { publisher } : {}),
  };
};

// ════════════════════════════════════════════════════════════════
// D-170 — standalone (1×1, no-pack) ingredient inventory
// ════════════════════════════════════════════════════════════════
//
// A 1×1 composition installs as ONE `installed_ingredient` row with NO
// `installed_pack` and NO `source_pack_slug` — nothing owns it (N.14: "1×1 →
// install one ingredient, no pack"). It coexists with the pack refcount model:
// a standalone id is never in any pack's `ingredient_ids`, so `recordPackInventory`'s
// GC never touches it, and `removeStandaloneIngredient` refuses to remove an id
// any pack still lists (so a pack-owned child is never orphaned via a direct
// ingredient uninstall).

export interface RecordStandaloneIngredientInput {
  ingredient_id: string;
  version: number;
  /** Locally-authored 1×1 ingredients pass `'private_byo'`. */
  catalog_kind?: CatalogKind;
  installed_at: number;
}

/** Record (idempotent upsert) a standalone 1×1 installed ingredient. */
export const recordStandaloneIngredient = (
  store: ContractStore,
  input: RecordStandaloneIngredientInput,
): void => {
  store.put(INSTALLED_INGREDIENT_SCOPE, [input.ingredient_id], {
    ingredient_id: input.ingredient_id,
    version: String(input.version),
    installed_at: input.installed_at,
    ...(input.catalog_kind ? { catalog_kind: input.catalog_kind } : {}),
  });
};

export interface RemoveStandaloneIngredientResult {
  /** True iff the `installed_ingredient` row was removed. */
  removed: boolean;
  /** True iff some `installed_pack` still lists this id — the row was NOT
   *  removed (uninstall the owning pack instead). */
  pack_owned: boolean;
}

/** Remove a standalone 1×1 ingredient by id. Refuses (no-op, `pack_owned:
 *  true`) when any installed pack still lists the id. */
export const removeStandaloneIngredient = (
  store: ContractStore,
  ingredient_id: string,
): RemoveStandaloneIngredientResult => {
  let removed = false;
  let packOwned = false;
  store.transaction(() => {
    // `''` excludes no pack (no pack slug is empty per SLUG_RE), so this is
    // "is the id claimed by ANY installed pack?".
    if (idsClaimedByOtherPacks(store, '').has(ingredient_id)) {
      packOwned = true;
      return;
    }
    removed = store.delete(INSTALLED_INGREDIENT_SCOPE, [ingredient_id]);
  });
  return { removed, pack_owned: packOwned };
};

// ════════════════════════════════════════════════════════════════
// D-182 Slice 4 — Tier-P op-step resolution (the `EMPTY_PACK_OP_RESOLUTION` seam)
// ════════════════════════════════════════════════════════════════

/** A minimal scan over ONE contract scope — the shape BOTH `ContractStore.scan`
 *  (bound to a scope, the install path) and the dispatcher's read-only `ScanFn`
 *  (the dispatch / pick paths) satisfy structurally (each returns rows carrying
 *  `segments` + a `value`). Lets {@link buildPackOpResolution} source the
 *  installed-pack inventory from either, with no store-type coupling. */
export type InstalledPackScan = () => readonly { segments: readonly string[]; value: unknown }[];

/** D-182 Slice 4 — build the Tier-P `pack_ref → catalog binding` resolution map
 *  from the installed-pack inventory + the live manifest registry. This is the
 *  map source the op-step lowering seam (`lowerPackOpStep` / `lowerTwoTierOpSteps`,
 *  `@recued/recipes`) consumes to resolve a `<publisher>.<pack>.<operation>`
 *  op-step to its concrete catalog fetch — replacing the deferred
 *  `EMPTY_PACK_OP_RESOLUTION` seam (`pick-candidates.ts`,
 *  `install-composition.ts`, `dispatch-canonical-resolve.ts`).
 *
 *  The edge (readiness-amendment "depends_on → installed_pack → catalog"): for
 *  each `installed_pack` row → `pack_ref = <publisher>.<pack_slug>` → its
 *  `ingredient_ids` (the catalog ingredient slugs the pack owns) → each catalog
 *  `IngredientManifest` from the registry → its declared `operations`. Resolves
 *  correctly when pack-slug ≠ catalog-slug (`gdrive` → catalog `google-drive`),
 *  for composition packs (`whisper`) AND by-ref packs (`hubspot-catalog`), and
 *  for the connection-less cli packs the connection→catalog edge cannot reach.
 *
 *  LIMITATION (pre-existing, out of Gate-2 scope): `installed_pack` is keyed by
 *  `pack_slug` alone (contract-schema `installed_pack.segments: ['pack_slug']`),
 *  so two packs with the SAME slug from different publishers cannot coexist in the
 *  inventory (the later install overwrites the row). The minted `pack_ref` is
 *  publisher-qualified, but the inventory can hold only one row per slug — so spec
 *  §3's `alice.whisper` + `bob.whisper` anti-squat coexistence would need the
 *  inventory re-keyed to `(publisher, pack_slug)` first. The corpus is all
 *  `recued-core`, so no collision arises today.
 *
 *  Single-catalog packs only — the entire Tier-P corpus (each cli / storage /
 *  tool pack owns ONE op-declaring catalog). A pack with >1 op-declaring catalog
 *  is AMBIGUOUS under the single-`catalog_slug` `PackOpBinding` shape, so it is
 *  SKIPPED (no binding); the lowering then fails closed
 *  ("no resolved catalog binding") rather than guessing the wrong catalog — a
 *  per-operation resolution would be the extension if such a pack ever ships.
 *  Also skipped (no binding): a publisher-less row (the optional field is
 *  forward-safe but unresolvable to a `pack_ref`), and a pack with zero
 *  op-declaring catalogs (a pure-workflow pack — its ops resolve through ITS
 *  deps' bindings, not its own row). Pure of writes; never throws. */
export const buildPackOpResolution = (
  scanInstalledPacks: InstalledPackScan,
  getManifest: (slug: string) => IngredientManifest | null,
  // D-182 Slice 4 — the `pack_ref` of the pack CURRENTLY being (re)installed, so
  // its own row is excluded from the map. The install callers pass it: on FIRST
  // install the pack isn't in the inventory yet, but on REINSTALL its PRIOR row is
  // still present (the new row commits after resolution) — without this exclusion
  // a pack's own Tier-P op would resolve through the STALE prior binding instead
  // of failing closed / binding via its own composition. Omitted at dispatch/pick
  // (no "self"). The map is always the OTHER installed (dependency) packs.
  excludePackRef?: string,
): PackOpResolution => {
  const map = new Map<string, PackOpBinding>();
  for (const row of scanInstalledPacks()) {
    const packSlug = row.segments[0];
    if (typeof packSlug !== 'string' || packSlug.length === 0) continue;
    const value = isRecord(row.value) ? row.value : {};
    const publisher = typeof value.publisher === 'string' ? value.publisher : '';
    // Fail-closed: no `pack_ref` without a publisher (forward-safe optional field).
    if (publisher.length === 0) continue;
    const packRef = `${publisher}.${packSlug}`;
    if (excludePackRef !== undefined && packRef === excludePackRef) continue;
    // The pack's op-declaring catalogs (an installed ingredient whose manifest
    // declares a non-empty `operations` table). A pure-workflow pack has none.
    const catalogs: PackOpBinding[] = [];
    for (const id of ingredientIdsOf(value)) {
      const manifest = getManifest(id);
      const ops = manifest?.operations;
      if (manifest === null || ops === undefined) continue;
      const opKeys = Object.keys(ops);
      if (opKeys.length === 0) continue;
      // `catalog_slug` is the manifest's own slug (the engine dispatch target the
      // lowering emits as `ingredient:`), canonical even if it differs from `id`.
      catalogs.push({ catalog_slug: manifest.slug, operations: new Set(opKeys) });
    }
    // 0 op-catalogs → pure-workflow (no own binding); >1 → ambiguous (skip → the
    // lowering fails closed). Exactly one → the pack's Tier-P binding.
    if (catalogs.length !== 1) continue;
    map.set(packRef, catalogs[0]);
    // A Records pack's row is KEYED by its generated catalog id, so `packRef`
    // above is `<publisher>.records-<hash>` — a name no author writes and no
    // recipe can reference. Also bind the AUTHORED ref when the row carries one,
    // which is the pack_ref a dependent's Tier-P op actually names
    // (`recued-core.billable-hours.entry.get`). ADDITIVE: the keyed ref stays in
    // the map, so nothing that resolved before resolves differently now.
    const authored = typeof value.authored_pack_slug === 'string'
      ? value.authored_pack_slug.trim()
      : '';
    if (authored.length > 0 && authored !== packSlug) {
      const authoredRef = `${publisher}.${authored}`;
      if (excludePackRef === undefined || authoredRef !== excludePackRef) {
        map.set(authoredRef, catalogs[0]);
      }
    }
  }
  return map;
};

/** D-225 Slice 2 — drop the OWNER RULINGS a pack's operations carry.
 *
 *  ⛔ **Deliberately NOT part of `removePackInventory`, and not called on the
 *  ordinary uninstall path.** For a marketplace pack, retaining an owner's
 *  per-op risk/approval tuning across an uninstall/reinstall is the friendly
 *  behaviour and is what ships today — they tuned it, they reinstalled the same
 *  pack, their settings come back.
 *
 *  A GENERATED MCP pack is the opposite case. Its slug is derived from
 *  `{kind, name}` and is therefore stable, so deleting the connection and later
 *  enrolling a different server under the same name would silently re-adopt
 *  rulings the owner made about a server that is gone. Deleting a connection is
 *  the owner saying "this is gone" — most sharply when they removed it BECAUSE
 *  they stopped trusting it — and leaving invisible policy state that reattaches
 *  later contradicts that.
 *
 *  ⚠ Descriptor-hashed op ids keep the re-adoption technically SAFE (a ruling
 *  can only reattach to a byte-identical tool), which is exactly why this is
 *  worth writing down: the danger here is not privilege, it is an owner
 *  believing they had a clean slate when they did not.
 *
 *  Scoped by `ingredient_id` — the leading row segment — so only this pack's
 *  rulings go. Atomic + idempotent: a pack with no rulings removes nothing. */
export const removePackOwnerRulings = (
  store: ContractStore,
  ingredient_ids: readonly string[],
): { removed_rulings: number } => {
  const targets = new Set(ingredient_ids);
  // ⛔ An empty target list is a NO-OP, never a wildcard. Read the other way,
  // the first caller that passed a pack with no ingredient ids would wipe every
  // owner ruling on the server.
  if (targets.size === 0) return { removed_rulings: 0 };
  let removed = 0;
  store.transaction(() => {
    const doomed: string[][] = [];
    for (const row of store.scan(OWNER_OPERATION_SCOPE)) {
      if (row.segments.length !== 2) continue;
      if (!targets.has(row.segments[0]!)) continue;
      doomed.push([...row.segments]);
    }
    // Collected before deleting — mutating a store mid-scan is the kind of
    // thing that works until the store's iterator stops being a snapshot.
    for (const segments of doomed) {
      if (store.delete(OWNER_OPERATION_SCOPE, segments)) removed += 1;
    }
  });
  return { removed_rulings: removed };
};

/** The packs a recipe DECLARES but the inventory cannot resolve — the pre-run
 *  answer to "will this recipe lower?".
 *
 *  ⛔ WHY A DECLARATION AND NOT THE OPS. `depends_on` is the recipe's own
 *  `<publisher>.<pack>` list, enforced corpus-wide against the ops it actually
 *  calls (`recipe-depends-on-coverage`). Re-deriving from op ids here would be a
 *  second source of truth that could disagree with the field every other surface
 *  reads — the uninstall disclosure, the schedule refusal, and the install offer
 *  must all name the SAME packs or the user is told different stories by each.
 *
 *  A resolvable `pack_ref` means `lowerPackOpStep` will bind it; an unresolvable
 *  one means `lowerSequentialStep` throws `CanonicalOpResolutionError` before
 *  step 1. So an empty result is "this recipe can lower", and a non-empty one
 *  names exactly what is missing — which is what an install offer needs.
 *
 *  Pure: no writes, never throws. A recipe with no `depends_on` returns `[]`
 *  (nothing declared ⇒ nothing missing), which is correct now that the
 *  declaration is enforced. */
export const missingPackDependencies = (
  recipe: { depends_on?: unknown },
  /** Anything that can answer "is this pack_ref resolvable" — a
   *  `PackOpResolution` (the run + scheduler path) or a plain `Set` of refs (the
   *  runnability read). Typed structurally so BOTH callers share this one
   *  implementation: a second copy would be a second source of truth for exactly
   *  the property every surface is supposed to agree on. */
  packs: { has(ref: string): boolean },
): string[] => {
  const declared = recipe.depends_on;
  if (!Array.isArray(declared)) return [];
  const missing: string[] = [];
  for (const entry of declared) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    if (packs.has(entry) || missing.includes(entry)) continue;
    missing.push(entry);
  }
  return missing;
};
