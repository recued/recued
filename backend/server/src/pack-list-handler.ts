/** D-145 PA10 follow-on — `packs.list` rpc handler.
 *
 *  Reads bundled pack manifests off disk (`community/packs/*.json`),
 *  parses each via the contracts validator, and joins with the per-pair
 *  `RecipeStore` to compute the `installed` flag for each pack.
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
 *  Spec: `docs/d-145-spec.md` § PA10 (pack-shipped Standing
 *  Instructions). */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  parseBulkPackManifest,
  RpcError,
  type BulkPackManifest,
  type HandlerSlice,
  type PackListEntry,
  type PacksListResult,
  type ServerRpcRegistry,
} from '@recued/contracts';

import { getInstalledPack, isPackInstalledAtVersion, listInstalledPacks } from './pack-inventory.js';
import type { RecipeStore } from './recipe-store.js';
import type { ContractStore } from './storage/contract-store.js';
import type { WsClient } from './ws-server.js';

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
  /** Override the default community/packs directory. Tests pass a
   *  scratch dir; production callers leave undefined to use the
   *  bundled location. */
  packDir?: string;
}

/** Default community/packs directory resolution. Mirrors
 *  `foundation-pack-pre-install.ts:findCommunityPackDir` and
 *  `recipe-store.ts:findCommunityDir` so test harnesses passing a
 *  custom community dir get the same shape regardless of which
 *  substrate's loader runs first. */
const findCommunityPackDir = (): string => {
  const projectRoot = resolve(import.meta.dirname ?? __dirname, '..', '..', '..');
  return join(projectRoot, 'community', 'packs');
};

/** Scan + parse every `*.json` file in `packDir`. Malformed manifests
 *  are silently dropped so the rpc only surfaces installable packs;
 *  the boot wire (`foundation-pack-pre-install.ts`) is the surface
 *  that logs validation failures. */
const loadPackManifests = (packDir: string): BulkPackManifest[] => {
  if (!existsSync(packDir)) return [];
  const out: BulkPackManifest[] = [];
  for (const file of readdirSync(packDir)) {
    if (!file.endsWith('.json')) continue;
    let raw: string;
    try {
      raw = readFileSync(join(packDir, file), 'utf-8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const result = parseBulkPackManifest(parsed);
    if (!result.ok) continue;
    out.push(result.manifest);
  }
  return out;
};

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
  const dir = packDir ?? findCommunityPackDir();
  return loadPackManifests(dir).filter((m) =>
    isPackInstalledAtVersion(contractStore, m.slug, m.version),
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
 *  new recipe versions.
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
 *    - recipe-bearing pack (`recipes.length > 0`) → the recipe check
 *      (UNCHANGED — twins, version drift, manual-install all preserved);
 *    - empty-recipes pack → the `installed_pack` inventory registry
 *      AT the manifest version (`isPackInstalledAtVersion`), the
 *      canonical signal for them (the composition provisioner /
 *      `packs.install` rpc / boot wire all record a version-stamped row).
 *      Version-matched so a bumped-on-disk pack re-shows Install, exactly
 *      like the recipe branch's drift detection. Absent contract store
 *      (dbless) → `false`, the prior behavior.
 *  This is strictly narrower than a registry-OR-recipe-check union,
 *  which would double-count and mark BOTH twins installed. */
const projectManifest = (
  manifest: BulkPackManifest,
  recipeStore: RecipeStore,
  contractStore: ContractStore | undefined,
): PackListEntry => {
  const installed =
    manifest.recipes.length > 0
      ? manifest.recipes.every((ref) => {
          const stored = recipeStore.getStored(ref.slug);
          return (
            stored !== null
            && stored.version === ref.version
            && stored.pack_slug === manifest.slug
          );
        })
      : contractStore !== undefined
        && isPackInstalledAtVersion(contractStore, manifest.slug, manifest.version);
  // D-182 — is the pack genuinely installed IGNORING the version (owned at ANY
  // version), as distinct from `installed` (owned AT the disk-manifest version)?
  // The two diverge when a bundled pack is installed at a DIFFERENT version than
  // the server's bundle — most often the marketplace version is HIGHER than the
  // server bundle (the catalog is re-seeded from `community/packs` on marketplace
  // deploy; a user's server bundles `community/packs` at its release, which lags).
  // Then `installed` is false (version mismatch) but the pack IS installed; the
  // Discover join needs this to keep showing "installed"/"update" (via the
  // inventory's real version) rather than flipping to "available". Ownership (not
  // just presence) keeps a STALE vendor-twin row — whose recipes another pack
  // owns — from reading as installed.
  // Probe the ACTUALLY-OWNED rows (`listForPack`), NOT the disk manifest's recipe
  // refs: a higher marketplace version can add / drop / REPLACE recipe slugs, so
  // the installed rows may share NO slug with the (lagging) disk manifest —
  // iterating disk refs would then wrongly read `false` for a real install.
  // `listForPack(slug)` = "owns >=1 recipe row under this pack_slug, any slug /
  // any version" (a stale twin owns none of its shared recipes -> false).
  const installedAnyVersion =
    manifest.recipes.length > 0
      ? recipeStore.listForPack(manifest.slug).length > 0
      : contractStore !== undefined
        && getInstalledPack(contractStore, manifest.slug) !== null;
  return {
    slug: manifest.slug,
    publisher: manifest.publisher,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    pre_install: manifest.pre_install === true,
    installed,
    installed_any_version: installedAnyVersion,
    requires: [...manifest.requires],
    recipe_count: manifest.recipes.length,
    body_visibility_grant_count:
      manifest.mcp_body_visibility_grants?.length ?? 0,
    manifest,
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
  const packDir = deps.packDir ?? findCommunityPackDir();
  return loadPackManifests(packDir).filter((manifest) =>
    projectManifest(manifest, deps.recipeStore, contractStore).installed
    && isPackInstalledAtVersion(contractStore, manifest.slug, manifest.version));
};

export const handlePacksList = async (
  deps: PackListRpcDeps,
): Promise<PacksListResult> => {
  const packDir = deps.packDir ?? findCommunityPackDir();
  const manifests = loadPackManifests(packDir);
  // Sort alphabetically by slug for deterministic panel render order.
  // The panel can re-group visually (installed / foundation / rest) on
  // top of a stable sort without a second-pass server query.
  manifests.sort((a, b) => a.slug.localeCompare(b.slug));
  const packs = manifests.map((m) =>
    projectManifest(m, deps.recipeStore, deps.contractStore),
  );
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

// `RpcError` is re-exported for parity with `pack-install-handler.ts`
// even though `packs.list` has no `bad_request` path today (no args).
// Future args (filter by publisher / installed-state) land their
// validation here without a fresh import.
export { RpcError };
