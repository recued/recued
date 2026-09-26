/** D-145 PA10 follow-on — `packs.list` rpc handler.
 *
 *  Reads the bundled pack roster through `bundled-pack-source.ts` — the
 *  `community/packs` tree in a checkout, the manifests embedded in the server
 *  bundle on a distribution (which ships no `community/`) — and joins it with
 *  the per-pair `RecipeStore` to compute the `installed` flag for each pack.
 *  ⛔ This handler read the directory itself, non-recursively, until
 *  2026-09-07: a deployed server listed NOTHING while running the six
 *  foundation packs its boot wire had installed, and a checkout hid the five
 *  nested under `community/packs/recued-core/`. See
 *  internal design notes.
 *
 *  The handler is the read counterpart to `packs.install` (PA10 follow-
 *  on). Together they back the Settings → Packs UI: `list` populates the
 *  pack roster, the user clicks Install on a non-installed bundled
 *  pack, the install dialog collects `granted_permissions` from
 *  `manifest.requires[]`, and `packs.install` runs the same engine
 *  transaction foundation packs use at boot.
 *
 *  Bundled-only resolution mirrors the `packs.install` security stance
 *  (see `pack-install-handler.ts` for the rationale): community packs
 *  carrying non-bundled recipes belong on a future marketplace-fetch
 *  path that resolves provenance before reaching the install
 *  transaction. v1 surfaces only first-party `recued-core` bundled
 *  packs + their `installed` state.
 *
 *  Channel-isolation invariant: `packs.` is in
 *  `MCP_RESERVED_RPC_PREFIXES` (D-138 P1). Read-only enumeration is
 *  low-risk, but the uniform private-prefix discipline keeps the
 *  `packs.*` surface a Settings-UI-only namespace — an MCP-channel
 *  agent enumerating packs is the half-step to driving `packs.install`,
 *  and the prefix gate is the simplest invariant that prevents both.
 *
 *  Malformed manifest handling: drop silently. The foundation-pack
 *  pre-install boot wire (`foundation-pack-pre-install.ts`) is the
 *  surface that logs validator failures into the boot log; the list
 *  rpc only surfaces packs the user can act on, so a broken manifest
 *  would render an Install button the user could never resolve.
 *
 *  Spec: D-145 § PA10 (pack-shipped Standing
 *  Instructions). */

import {
  type BulkPackManifest,
  type HandlerSlice,
  type PackListEntry,
  type PacksListResult,
  type ServerRpcRegistry,
} from '@recued/contracts';

import { loadBundledPackManifests } from './bundled-pack-source.js';
import {
  installedPackFromRow,
  isPackInstalledAtVersionFromRow,
  listInstalledPacks,
  scanInstalledPackRowsBySegment,
} from './pack-inventory.js';
import { reviewOwnerOperationsForPackUpdate } from './owner-operation-update-review.js';
import {
  prepareRecordsUpdateReview,
  type PackInstallRpcDeps,
} from './pack-install-handler.js';
import { hasPrivilegedRecordsStep, type RecordsMigrationArtifact } from './records/install-coordinator.js';
import {
  carriesRecords,
  compositionPackCurrentAccess,
  diffCompositionPackForUpdate,
  diffRecordsPackForUpdate,
  recordsPackCurrentAccess,
} from './pack-operation-update-diff.js';
import type { LocalManifestStore } from './ingredient-authoring/local-manifest-store.js';
import type { SellerInstallAudienceStore } from './ingredient-authoring/install-composition.js';
import { currentPackAudience, currentPackConnection } from './pack-update-carry-over.js';
import type { RecipeStore } from './recipe-store.js';
import type { ContractRow, ContractStore } from './storage/contract-store.js';
import type { WsClient } from './ws-server.js';
import type { RecordsNamespaceSummary, RecordsStore } from './records/store.js';

export interface PackListRpcDeps {
  /** Per-pair recipe store. Required — the recipe-bearing `installed`
   *  join is the point of the rpc. Absent → composer returns the
   *  undefined-bundle + the rpc returns `not_configured`. */
  recipeStore: RecipeStore;
  /** Gateway-read-only contract store — the `installed_pack` inventory
   *  registry. The canonical install-signal for EMPTY-`recipes[]` packs
   *  (composition / CLI / workflow), where the recipe-store check is
   *  structurally blind. Optional: dbless boots / older harnesses leave it
   *  undefined → an empty-recipes pack degrades to `installed: false`
   *  (its prior behavior); recipe-bearing packs are unaffected. */
  contractStore?: ContractStore;
  /** D-221 full-ref install/readiness registry. */
  recordsStore?: RecordsStore;
  /** The installed catalogs, so an offered update can carry the operation diff
   *  (`operation_diff`). Absent ⇒ no diff; the update is still offered. */
  localManifestStore?: Pick<LocalManifestStore, 'getManifest'>;
  /** Customer packages, so an offered update's audience can name the tiers it
   *  is shared with (D-294). Absent ⇒ shared customers come back one by one. */
  sellerStore?: SellerInstallAudienceStore;
  resolveRecordsMigrationArtifacts?: (input: {
    owner: { publisher: string; pack_slug: string };
    from_version: number;
    target_version: number;
  }) => Promise<readonly RecordsMigrationArtifact[]>;
  /** Override the default community/packs directory. Tests pass a
   *  scratch dir; production callers leave undefined to use the
   *  bundled location. ⚠ An explicit dir also means "this fixture is the
   *  corpus" — the embedded foundation manifests are NOT unioned in, so a
   *  harness sees exactly the packs it wrote. See `bundled-pack-source.ts`. */
  packDir?: string;
}

/** Fork 1 — the INSTALLED packs' manifests, for the connection-enroll scope
 *  union (the `startVendorOAuth` handler unions a vendor's installed packs'
 *  `required_scopes` into the requested OAuth scope set, so a connection isn't
 *  under-scoped for its packs). Reuses the same bundled-manifest load + the
 *  version-aware `installed_pack` registry check `handlePackList` projects
 *  `installed` from. `contractStore` absent (dbless / unwired boot) → `[]`:
 *  enroll then requests only the vendor const (its prior behavior). Erring
 *  toward UNDER-inclusion is safe — the pack-readiness block flags a missed
 *  pack post-enroll and the user re-authorizes; over-inclusion would
 *  over-scope, which this deliberately avoids. */
export const listInstalledPackManifests = (
  contractStore: ContractStore | undefined,
  packDir?: string,
): BulkPackManifest[] => {
  if (!contractStore) return [];
  const rows = scanInstalledPackRowsBySegment(contractStore);
  return loadBundledPackManifests(packDir).filter((m) =>
    isPackInstalledAtVersionFromRow(rows.get(m.slug) ?? null, m.version),
  );
};

/** Project one parsed manifest into the rpc row shape + compute the
 *  per-pair `installed` flag.
 *
 *  Codex review fold (MAJOR 1) — version-aware presence check. The
 *  prior `getStored(slug) !== null` form falsely marked the pack
 *  installed when a stored recipe row from an older manifest version
 *  was still in place (drift hides the Install/upgrade UI). The new
 *  check requires every entry in `manifest.recipes` to have a stored
 *  row at the SAME `version` the manifest pinned — version drift on
 *  any recipe flips `installed` back to false, so the Settings UI
 *  surfaces the Install button + a manifest re-install picks up the
 *  new recipe versions. When inventory proves a NEWER pack is already
 *  installed, the older bundled manifest is treated as satisfied rather than
 *  exposing a downgrade action.
 *
 *  Codex review fold (twin packs P1) — ownership-aware check. Vendor
 *  twin packs (`recued-core.hubspot` / `recued-core.salesforce` share
 *  the `crm-contact-maintenance-*` recipe slugs, …) carry the same
 *  recipes deliberately: the recipes are connection-agnostic and
 *  install rebinds them to whichever vendor catalog the installing
 *  pack references (last-install-wins on the `recipe_id` PK). A
 *  presence-only check therefore marked the OTHER twin installed too,
 *  and the panel's disabled-Install / Uninstall affordances blocked
 *  the rebind path entirely. `installed` now additionally requires
 *  the stored row's `pack_slug` to name THIS pack — only the twin
 *  that currently owns the binding shows installed; the other twin
 *  keeps its Install button (which performs the rebind). Rows with
 *  NULL `pack_slug` (manually installed recipes) intentionally do
 *  NOT count either: a manually-installed canonical recipe never
 *  went through the pack's catalog binding, so a false `installed`
 *  would hide the Install button that performs it.
 *
 *  Packs-route delta 1 — HYBRID install-signal. The version-aware
 *  recipe-ownership check above is correct + load-bearing for
 *  recipe-BEARING packs (it models twin packs + version drift, which a
 *  slug-keyed registry row cannot), but it is structurally blind to the
 *  37/47 EMPTY-`recipes[]` v2 packs (composition / CLI / workflow):
 *  `recipes.length > 0` short-circuits them to a permanent
 *  `installed: false`, hiding their installed state. So:
 *    - recipe-bearing pack (`recipes.length > 0`) → the recipe check remains
 *      the ownership authority (twins/manual installs preserved), AND when an
 *      installed-pack inventory row exists its version must be this incoming
 *      version or newer;
 *      this catches metadata/composition-only pack bumps whose recipe pins did
 *      not change (D-211 Slice 5's update review would otherwise stay hidden);
 *    - empty-recipes pack → the `installed_pack` inventory registry at this
 *      manifest version OR NEWER, the
 *      canonical signal for them (the composition provisioner /
 *      `packs.install` rpc / boot wire all record a version-stamped row).
 *      Direction-aware so a bumped-on-disk pack re-shows Install while an
 *      older bundle never offers to downgrade a newer install. Absent contract store
 *      (dbless) → `false`, the prior behavior.
 *  The inventory check is a conjunction, never a registry-OR-recipe-check
 *  union, so it cannot double-count and mark BOTH twins installed. An absent
 *  inventory row preserves the legacy recipe-only result. */
/** The two per-pack reads the roster loops make, answered from ONE scan each.
 *
 *  ⛔ WHY THIS EXISTS, AND HONESTLY WHAT IT IS WORTH. Every roster loop walked
 *  the full bundled corpus calling `getInstalledPack` + `getNamespace` once per
 *  pack — 2,104 point reads for 1,052 packs. Measured on that realm they cost
 *  **69ms of a ~2,250ms `packs.list`**, so this is a tidy-up, not the fix for
 *  a slow list: the roster parse it sits next to was ~660ms and is cached now.
 *  Recorded because the next reader will otherwise re-derive the same estimate
 *  and expect more from it.
 *
 *  🔑 The `installed_pack` row is handed over RAW. Three functions read it and
 *  read it differently (see `scanInstalledPackRowsBySegment`), so normalizing
 *  here would silently pick one reading for all of them. */
interface PackRosterLookups {
  installedRow: (pack_slug: string) => ContractRow | null;
  namespace: (publisher: string, pack_slug: string) => RecordsNamespaceSummary | null;
}

const nsKey = (publisher: string, pack_slug: string): string => `${publisher}\u0000${pack_slug}`;

const buildPackRosterLookups = (
  contractStore: ContractStore | undefined,
  recordsStore: RecordsStore | undefined,
): PackRosterLookups => {
  const rows = contractStore === undefined
    ? new Map<string, ContractRow>()
    : scanInstalledPackRowsBySegment(contractStore);
  // `listNamespaces()` maps the SAME `summary()` over every row that
  // `getNamespace()` applies to one, so keying it is equivalent by
  // construction rather than by resemblance.
  const namespaces = new Map<string, RecordsNamespaceSummary>();
  for (const summary of recordsStore?.listNamespaces() ?? []) {
    namespaces.set(nsKey(summary.owner.publisher, summary.owner.pack_slug), summary);
  }
  return {
    installedRow: (pack_slug) => rows.get(pack_slug) ?? null,
    namespace: (publisher, pack_slug) => namespaces.get(nsKey(publisher, pack_slug)) ?? null,
  };
};

const projectManifest = (
  manifest: BulkPackManifest,
  recipeStore: RecipeStore,
  contractStore: ContractStore | undefined,
  lookups: PackRosterLookups,
  localManifestStore?: Pick<LocalManifestStore, 'getManifest'>,
  sellerStore?: SellerInstallAudienceStore,
): PackListEntry => {
  const recordsNamespace = lookups.namespace(manifest.publisher, manifest.slug);
  if (recordsNamespace !== null) {
    const active = recordsNamespace.state.state === 'ready';
    const ownsRetainedNamespace = active || recordsNamespace.state.state === 'orphaned';
    const installedVersion = recordsNamespace.state.state === 'ready'
      ? recordsNamespace.state.version
      : recordsNamespace.state.state === 'orphaned'
        ? recordsNamespace.state.last_version
        : 0;
    const installed = active && installedVersion >= manifest.version;
    const ownerOperationReview =
      contractStore !== undefined && ownsRetainedNamespace && !installed
        ? reviewOwnerOperationsForPackUpdate(contractStore, manifest)
        : [];
    return {
      slug: manifest.slug,
      publisher: manifest.publisher,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      pre_install: manifest.pre_install === true,
      installed,
      installed_any_version: ownsRetainedNamespace,
      ...(ownerOperationReview.length > 0
        ? { owner_operation_review: ownerOperationReview }
        : {}),
      requires: [...manifest.requires],
      recipe_count: manifest.recipes.length,
      body_visibility_grant_count: manifest.mcp_body_visibility_grants?.length ?? 0,
      recipe_refs: manifest.recipes.map((r) => ({ slug: r.slug, version: r.version })),
      body_visibility_grant_keys: [...(manifest.mcp_body_visibility_grants ?? [])],
      ...(typeof manifest.service_kind === 'string' ? { service_kind: manifest.service_kind } : {}),
      ...(typeof manifest.repo === 'string' ? { repo: manifest.repo } : {}),
      // The four scalars the list surfaces read — 365 bytes a pack, against
      // the ~36 KB `manifest` they used to reach through to get them.
      ...(Array.isArray(manifest.tags) ? { tags: [...manifest.tags] } : {}),
      ...(typeof manifest.pack_kind === 'string' ? { pack_kind: manifest.pack_kind } : {}),
      ...(manifest.connection_requirements !== undefined
        ? { connection_requirements: manifest.connection_requirements }
        : {}),
      ...(manifest.connection_hints !== undefined
        ? { connection_hints: manifest.connection_hints }
        : {}),
      // ⛔ NO `manifest` — see the twin below and `PackListEntry.manifest`.
    };
  }
  const installedPack = contractStore === undefined
    ? null
    : installedPackFromRow(lookups.installedRow(manifest.slug));
  const recipesInstalled = manifest.recipes.length > 0
    && manifest.recipes.every((ref) => {
      const stored = recipeStore.getStored(ref.slug);
      return (
        stored !== null
        && stored.version === ref.version
        && stored.pack_slug === manifest.slug
      );
    });
  const ownsRecipeContent = manifest.recipes.length > 0
    && recipeStore.listForPack(manifest.slug).length > 0;
  const newerInstalledPack = installedPack?.version !== undefined
    && installedPack.version > manifest.version;
  const installed =
    manifest.recipes.length > 0
      ? newerInstalledPack
        ? ownsRecipeContent
        : recipesInstalled
          && (
            installedPack === null
            || installedPack.version === manifest.version
          )
      : installedPack !== null
        && installedPack.version !== undefined
        && installedPack.version >= manifest.version;
  // D-182 — is the pack genuinely installed IGNORING the version (owned at ANY
  // version), as distinct from `installed` (owned AT the disk-manifest version)?
  // The two diverge when a pack owns content but does not satisfy the incoming
  // manifest (most importantly: installed version LOWER than incoming, or recipe
  // refs replaced). A HIGHER installed version satisfies an older bundle so the
  // panel never offers a downgrade; `installed_versions` still carries the real
  // version for Discover's marketplace compare. Ownership (not just presence)
  // keeps a STALE vendor-twin row — whose recipes another pack owns — from
  // reading as installed.
  // Probe the ACTUALLY-OWNED rows (`listForPack`), NOT the disk manifest's recipe
  // refs: a higher marketplace version can add / drop / REPLACE recipe slugs, so
  // the installed rows may share NO slug with the (lagging) disk manifest —
  // iterating disk refs would then wrongly read `false` for a real install.
  // `listForPack(slug)` = "owns >=1 recipe row under this pack_slug, any slug /
  // any version" (a stale twin owns none of its shared recipes -> false).
  const installedAnyVersion =
    manifest.recipes.length > 0
      ? ownsRecipeContent
      : installedPack !== null;
  const ownerOperationReview =
    contractStore !== undefined && installedAnyVersion && !installed
      ? reviewOwnerOperationsForPackUpdate(contractStore, manifest)
      : [];
  // The whole-pack diff an update review shows: every removed, changed and
  // added operation, not only the ones the owner set a rule for.
  const offeredUpdate = contractStore !== undefined && localManifestStore !== undefined
    && installedAnyVersion && !installed;
  const operationDiff = offeredUpdate
    ? diffCompositionPackForUpdate(contractStore!, localManifestStore!, manifest)
    : undefined;
  // Where the update's Access choice STARTS: what the pack holds now.
  const currentAccess = offeredUpdate
    ? compositionPackCurrentAccess(contractStore!, localManifestStore!, manifest)
    : undefined;
  // …and "Who may use it" starts at who has it now (D-294). A Records pack
  // stamps its share with its catalog id, not this slug — its branch below.
  const currentAudience = contractStore !== undefined && installedAnyVersion && !installed
    && !carriesRecords(manifest)
    ? currentPackAudience({
      contractStore,
      ...(sellerStore !== undefined ? { sellerStore } : {}),
      sourcePack: manifest.slug,
      now: Date.now,
    })
    : undefined;
  // …and Connect at the account it uses now.
  const currentConnection = contractStore !== undefined && installedAnyVersion && !installed
    && !carriesRecords(manifest)
    ? currentPackConnection(contractStore, manifest.slug)
    : undefined;
  return {
    slug: manifest.slug,
    publisher: manifest.publisher,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    pre_install: manifest.pre_install === true,
    installed,
    installed_any_version: installedAnyVersion,
    ...(ownerOperationReview.length > 0
      ? { owner_operation_review: ownerOperationReview }
      : {}),
    ...(operationDiff !== undefined ? { operation_diff: operationDiff } : {}),
    ...(currentAccess !== undefined ? { current_access: currentAccess } : {}),
    ...(currentAudience !== undefined ? { current_audience: currentAudience } : {}),
    ...(currentConnection !== undefined ? { current_connection: currentConnection } : {}),
    requires: [...manifest.requires],
    recipe_count: manifest.recipes.length,
    body_visibility_grant_count:
      manifest.mcp_body_visibility_grants?.length ?? 0,
    // The slim stand-ins for the manifest the collision + overlap projections
    // used to read off it. See `PackListEntry.recipe_slugs`.
    recipe_refs: manifest.recipes.map((r) => ({ slug: r.slug, version: r.version })),
    body_visibility_grant_keys: [...(manifest.mcp_body_visibility_grants ?? [])],
      ...(typeof manifest.service_kind === 'string' ? { service_kind: manifest.service_kind } : {}),
      ...(typeof manifest.repo === 'string' ? { repo: manifest.repo } : {}),
      // The four scalars the list surfaces read — 365 bytes a pack, against
      // the ~36 KB `manifest` they used to reach through to get them.
      ...(Array.isArray(manifest.tags) ? { tags: [...manifest.tags] } : {}),
      ...(typeof manifest.pack_kind === 'string' ? { pack_kind: manifest.pack_kind } : {}),
      ...(manifest.connection_requirements !== undefined
        ? { connection_requirements: manifest.connection_requirements }
        : {}),
      ...(manifest.connection_hints !== undefined
        ? { connection_hints: manifest.connection_hints }
        : {}),
    // ⛔⛔ NO `manifest` ON A LIST RESPONSE, AT ALL. The previous cut here kept it
    // for installed packs, which took the response from 44.6 MB to 17 MB but left
    // the cost PROPORTIONAL TO THE INSTALL COUNT — and nothing bounds that count.
    // At ~36 KB a manifest it re-crosses the 16 MiB socket ceiling at ~110
    // installed packs; a demo realm with 466 produced a 17,719,350-byte frame that
    // `sendBoundedWsJson` terminated, so the Packs panel hung forever against a
    // server whose own log said `ok=true`. The list's own fields are 0.77 MB for
    // all 1,052 packs and do not grow with installs. See
    // internal design notes.
    //
    // 🔑 NOTHING LOST A READER: every manifest this list could ever carry is a
    // BUNDLED one (`packs[]` is built from `loadBundledPackManifests`; a
    // marketplace install appears only in `installed_versions`) and is therefore
    // resolvable from disk by `packs.resolveBySlug`, which already refuses
    // nothing here — that loader filters core-feature packs out of the roster, and
    // they are the only slug resolve rejects. The client's `ensureDetailResolved`
    // already fetches exactly this on detail open and backfills the row in place,
    // which is why the detail readers need no change.
    //
    // ⚠ This includes the ORPHANED records pack the old comment kept the field
    // for: it is orphaned in the INVENTORY, while its manifest is still on disk,
    // so resolve serves it like any other.
  };
};

/** D-200 Slice 6 — the synchronous, ownership- AND pack-version-exact bundled
 *  manifest view used by Seller paid-workflow discovery. Recipe ownership
 *  proves that this pack still owns every lifecycle implementation; the
 *  installed-pack inventory independently proves that the installed pack
 *  version is the version carrying the descriptor. Both are required: a v19
 *  install can have the same recipe pins as a v20 metadata-only bump and must
 *  not be advertised with v20 offer copy before upgrade. No inventory store or
 *  no exact row fails closed. Marketplace-only manifests are not persisted in
 *  inventory yet and remain a later discovery-index increment. */
export const listVersionExactInstalledPackManifests = (
  deps: PackListRpcDeps,
): BulkPackManifest[] => {
  const contractStore = deps.contractStore;
  if (contractStore === undefined) return [];
  const lookups = buildPackRosterLookups(contractStore, deps.recordsStore);
  const rows = scanInstalledPackRowsBySegment(contractStore);
  return loadBundledPackManifests(deps.packDir).filter((manifest) =>
    projectManifest(manifest, deps.recipeStore, contractStore, lookups).installed
    && (
      lookups.namespace(manifest.publisher, manifest.slug)?.state.state === 'ready'
      || isPackInstalledAtVersionFromRow(rows.get(manifest.slug) ?? null, manifest.version)
    ));
};

export const handlePacksList = async (
  deps: PackListRpcDeps,
): Promise<PacksListResult> => {
  const manifests = loadBundledPackManifests(deps.packDir);
  // Sort alphabetically by slug for deterministic panel render order.
  // The panel can re-group visually (installed / foundation / rest) on
  // top of a stable sort without a second-pass server query.
  manifests.sort((a, b) => a.slug.localeCompare(b.slug));
  // One scan each, before the loop — not one point read per pack.
  const lookups = buildPackRosterLookups(deps.contractStore, deps.recordsStore);
  const packs = await Promise.all(manifests.map(async (manifest) => {
    const base = projectManifest(
      manifest,
      deps.recipeStore,
      deps.contractStore,
      lookups,
      deps.localManifestStore,
      deps.sellerStore,
    );
    if (deps.recordsStore === undefined) return base;
    // ⛔⛔ A RECORDS PACK READS AS INSTALLED ON ITS VERSION ALONE, and its recipes
    // can move without one. D-292 moved three importers' pins at the same pack
    // version; every owner who already had the pack kept `installed: true`, was
    // offered nothing, and Pack Use kept running the v1 body (proved by booting
    // the current server on a 26.9.21 realm). The update itself was never
    // missing: recipe bodies are in the artifact digest, so the review builder
    // already answers a same-version recipe change with a transition — only this
    // list never asked. An installed records pack whose stored recipes are
    // BEHIND its pins is offered that review like any other update. Behind, not
    // different: a newer stored version is never offered as a downgrade.
    //
    // ⚠ Only the recipes an install STORES: its business recipes. The runtime
    // canary and migration recipes never get a row, so a missing row for one is
    // not "behind" — counted, every records pack would read as out of date
    // forever, including right after its update (caught by
    // `records-same-version-recipe-update.test.ts`, not by reading it).
    const recipesBehind = base.installed
      && lookups.namespace(manifest.publisher, manifest.slug) !== null
      && manifest.recipes.some((ref) => {
        const bundled = deps.recipeStore.getBundled(ref.slug);
        if (bundled !== null && hasPrivilegedRecordsStep(bundled)) return false;
        const stored = deps.recipeStore.getStored(ref.slug);
        return stored === null || stored.version < ref.version;
      });
    if (base.installed && !recipesBehind) return base;
    try {
      const prepared = await prepareRecordsUpdateReview(
        deps as PackInstallRpcDeps,
        manifest,
        async (slug) => {
          const recipe = deps.recipeStore.getBundled(slug);
          return recipe === null
            ? null
            : { recipe, publisher_id: manifest.publisher, version: recipe.version };
        },
      );
      if (prepared?.transition === null || prepared === null) return base;
      // The same shape a version update has: not installed AT this manifest,
      // installed at some version, and the owner-operation review a version
      // update carries (computed only when `installed` was false).
      const ownerOperationReview = recipesBehind && deps.contractStore !== undefined
        ? reviewOwnerOperationsForPackUpdate(deps.contractStore, manifest)
        : [];
      // ⛔ A RECORDS pack's operations live in its STAMPED catalog, keyed by the
      // derived `records-<hash>` id its owner rules and grants use — not the
      // composition's authored slug, which is why D-211's review never saw them.
      const operationDiff = deps.contractStore !== undefined && deps.localManifestStore !== undefined
        ? diffRecordsPackForUpdate(deps.contractStore, deps.localManifestStore, prepared.target.catalog)
        : undefined;
      const currentAccess = deps.contractStore !== undefined && deps.localManifestStore !== undefined
        ? recordsPackCurrentAccess(deps.contractStore, deps.localManifestStore, prepared.target)
        : undefined;
      const currentAudience = deps.contractStore !== undefined
        ? currentPackAudience({
          contractStore: deps.contractStore,
          ...(deps.sellerStore !== undefined ? { sellerStore: deps.sellerStore } : {}),
          sourcePack: prepared.target.catalog.slug,
          now: Date.now,
        })
        : undefined;
      return {
        ...base,
        ...(recipesBehind ? { installed: false } : {}),
        ...(ownerOperationReview.length > 0 ? { owner_operation_review: ownerOperationReview } : {}),
        ...(operationDiff !== undefined ? { operation_diff: operationDiff } : {}),
        ...(currentAccess !== undefined ? { current_access: currentAccess } : {}),
        ...(currentAudience !== undefined ? { current_audience: currentAudience } : {}),
        records_review: prepared.transition.review,
        manifest_review_hash: prepared.review_hash,
      };
    } catch {
      // Fail closed: no review token means the update submit is refused. The
      // authoring/install diagnostics retain the concrete validation message.
      return base;
    }
  }));
  // D-182 — the full installed-version set from the inventory (bundled +
  // marketplace), so the Discover install-state join can flag a
  // marketplace-installed pack's installed / upgrade state even though its
  // manifest isn't bundled on disk (absent from `packs[]`). Only the inventory
  // records marketplace installs; a dbless boot (no `contractStore`) omits the
  // field and the join falls back to `packs[].installed` (bundled-only, its
  // prior behavior).
  if (deps.contractStore === undefined) return { packs };
  const installed_versions = listInstalledPacks(deps.contractStore).map((r) => ({
    slug: r.pack_slug,
    version: r.version,
    ...(r.publisher !== undefined ? { publisher: r.publisher } : {}),
  }));
  for (const namespace of deps.recordsStore?.listNamespaces() ?? []) {
    if (namespace.state.state !== 'ready') continue;
    const existing = installed_versions.find((entry) =>
      entry.slug === namespace.owner.pack_slug
      && entry.publisher === namespace.owner.publisher);
    if (existing) existing.version = namespace.state.version;
    else installed_versions.push({
      slug: namespace.owner.pack_slug,
      publisher: namespace.owner.publisher,
      version: namespace.state.version,
    });
  }
  return { packs, installed_versions };
};

type PacksListMethods = 'packs.list';

export const makePackListHandlers = (
  deps: PackListRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, PacksListMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['packs.list'],
    handlers: {
      'packs.list': async () => handlePacksList(deps),
    },
  };
};

