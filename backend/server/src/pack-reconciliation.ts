/** Launch-safe installed-pack reconciliation.
 *
 * This is deliberately NOT a general automatic update channel. A pack update
 * can add operations, widen editable targets, replace grants, move a connection
 * binding, or fan authority out to another audience. Those changes require the
 * owner's install review.
 *
 * The boot path below recognizes only transitions in a source-controlled,
 * hash-pinned ledger. Each transition must also satisfy a second, independent
 * authority-equivalence check against the body actually installed on this
 * server. The apply path then replaces only the local manifest + the version
 * field of the existing pack row; ingredient inventory, grants, bindings, and
 * audience rows are preserved exactly.
 *
 * The first ledger closes D-259's launch blocker: server releases bundle the
 * reviewed v2 Codex, yt-dlp, cloudflared, and Ollama manifests, so an unattended
 * or offline server can repair their now-rejected v1 execution declarations
 * before a listener accepts work.
 *
 * codex-pack LEFT the ledger at v5 (2026-10-07). v5 adds operations (resume,
 * review of uncommitted changes), and an added operation is never
 * authority-equivalent, so no boot could apply it. A still-stranded v1/v2 codex
 * install now takes the path the 2026-09-04 ruling set for everything outside the
 * ledger: the boot check names it unrunnable, the owner is notified with a link,
 * and the update goes through the reviewed dialog.
 */

import { isDeepStrictEqual } from 'node:util';

import {
  BULK_PACK_INSTALL_PERMISSION,
  normalizeBulkPackInstallPlan,
  parseBulkPackManifest,
  type BulkPackManifest,
  type EntitySchemaIngredientInput,
  type IngredientManifest,
} from '@recued/contracts';
import { canonicalHash, decomposeComposition } from '@recued/ingredient-authoring';

import {
  provisionPackCompositionForBulkInstall,
  type ProvisionAuthoredDeps,
} from './ingredient-authoring/install-composition.js';
import { findCommunityPackDir } from './bundled-pack-source.js';
import { resolveRootBundledPackManifest } from './pack-install-handler.js';
import { listInstalledPacks } from './pack-inventory.js';
import { BUNDLED_PACK_RECONCILIATION_TARGETS } from './bundled-pack-reconciliation.generated.js';

interface ApprovedPackTransition {
  publisher: 'recued-core';
  /** ⛔ A SET, NOT A LITERAL, AND THAT IS THE WHOLE POINT. One transition exists
   *  per pack slug and `resolveReconciliationTarget` resolves ONE shipped
   *  artifact, so a second hop cannot be expressed as a second entry. When the
   *  target moved to v3, `from_version: 1` alone would have answered
   *  `source_version_not_approved` to every HEALTHY v2 install, and
   *  `from_version: 2` alone would have abandoned the broken-v1 population this
   *  mechanism exists for. Every listed version must have a reviewed body hash in
   *  `source_body_hashes` — the set widens WHICH installs are eligible, never what
   *  they are repaired to. */
  from_versions: readonly number[];
  /** The exact shipped version the target artifact must declare, per pack — the
   *  entries need not move together. */
  to_version: number;
  catalog_slug: string;
  /** SHA-256 over canonical JSON, not file bytes (formatting is immaterial). */
  target_hash: string;
  /** Canonical hashes of the reviewed, persisted v1 catalog bodies after
   * presentation-only descriptions are removed. This is a source-lineage
   * fence, independent of the target hash and authority comparison. */
  source_body_hashes: readonly string[];
}

/** Closed review ledger. Adding an entry is a security decision and requires a
 * target hash, an exact source/target version, and authority-equivalence tests. */
const LAUNCH_SAFE_PACK_TRANSITIONS: Readonly<
  Record<string, ApprovedPackTransition>
> = Object.freeze({
  // ⛔ NO `codex-pack` ENTRY, ON PURPOSE — see the header. From v5 its target adds
  // operations, which `comparePackUpdateAuthority` refuses by design, so an entry
  // could only ever hold. Re-adding it needs a target with v1's operation set.
  'yt-dlp': {
    publisher: 'recued-core',
    from_versions: [1, 2],
    to_version: 3,
    catalog_slug: 'yt-dlp',
    target_hash: 'b03c0aa6d7752b66f637b14e516faa1fcc76e62a9328516db87c490ce87cb0aa',
    source_body_hashes: [
      // bcf0b30f2; the preceding pack body had a different authority surface.
      'f00d1dc0d9e33d36f3fbf57a53b6b435309c393ccc137f70cd8aefde207e7958',
      // v2 (the previously reviewed target). Its ONLY delta to v3 is the
      // ADDED closed request schema, which narrows and grants nothing.
      'd7d3782fa7a80851749b64eb3c8cc41799b74c317b97512bf8c2549b158ba72f',
    ],
  },
  cloudflared: {
    publisher: 'recued-core',
    from_versions: [1, 2],
    to_version: 3,
    catalog_slug: 'cloudflared',
    target_hash: 'adf42962954afaf4c7beecb5820ac995ade2e35797919e820f3727848fc0c150',
    source_body_hashes: [
      // bcf0b30f2/a250d2aa2 and the authority-equivalent d73706d7d shape.
      '099903758de889b012c72b15c7330b1931ca85255310a26c5aa7eae4b8ac680a',
      '84e210046644cd00aeb93313094ef820ab0645cf7ab46b3bd01a20e858af1129',
      // v2 (the previously reviewed target). Its ONLY delta to v3 is the
      // ADDED closed request schema, which narrows and grants nothing.
      '34e98728c79396c941732332159396899aa51854387dd11157b617b2593557db',
    ],
  },
  ollama: {
    publisher: 'recued-core',
    from_versions: [1, 2],
    to_version: 3,
    catalog_slug: 'ollama',
    target_hash: '94c337b3014bdeddf939d59e9e861030d952fe0d716725a2926af05b913499be',
    source_body_hashes: [
      // bcf0b30f2; older bodies changed the authority surface and stay held.
      '716066313589646facdf0874b1acf72143000ba3747d6a46cb487c4e952d5931',
      // v2 (the previously reviewed target). Its ONLY delta to v3 is the
      // ADDED closed request schema, which narrows and grants nothing.
      'dc5da04525bf73293ff14fe907cbb1d5cd7c464f498ebf7b6f322cfad524ed5b',
    ],
  },
});

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const persistedClone = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;

/** Source checkouts prefer their root artifact. Deployed npm/Docker layouts do
 * not ship community/, so a missing/unparseable file falls back to the exact
 * generated artifact compiled into dist. A present-but-hash-mismatched file is
 * returned and rejected later; the embed never masks an altered valid target. */
const resolveReconciliationTarget = (
  packDir: string,
  packSlug: string,
): BulkPackManifest | null => {
  const filesystemTarget = resolveRootBundledPackManifest(packDir, packSlug);
  if (filesystemTarget !== null) return filesystemTarget;
  if (!Object.prototype.hasOwnProperty.call(BUNDLED_PACK_RECONCILIATION_TARGETS, packSlug)) {
    return null;
  }
  const embedded = BUNDLED_PACK_RECONCILIATION_TARGETS[packSlug];
  if (embedded === undefined) return null;
  const parsed = parseBulkPackManifest(persistedClone(embedded));
  return parsed.ok && parsed.manifest.slug === packSlug ? parsed.manifest : null;
};

/** Exact source proof with presentation prose removed. Descriptions never
 * affect dispatch or authority and changed independently while these packs
 * remained at v1; every executable/resource/grant field stays in the hash. */
const sourceBodySnapshot = (manifest: IngredientManifest): JsonRecord => {
  const snapshot = persistedClone(manifest) as unknown as JsonRecord;
  delete snapshot.description;
  const operations = isRecord(snapshot.operations) ? snapshot.operations : {};
  for (const value of Object.values(operations)) {
    if (isRecord(value)) delete value.description;
  }
  return snapshot;
};

/** Remove fields which affect implementation, presentation, or resource bounds
 * but do not grant an operation or change who/what it may target. The complete
 * execution binding may change only because the target artifact itself is
 * hash-pinned in the ledger above. */
const authoritySnapshot = (manifest: IngredientManifest): JsonRecord => {
  const snapshot = persistedClone(manifest) as unknown as JsonRecord;
  delete snapshot.description;
  delete snapshot.version;

  const operations = isRecord(snapshot.operations) ? snapshot.operations : {};
  for (const value of Object.values(operations)) {
    if (!isRecord(value)) continue;
    delete value.description;
    delete value.timeout_ms;
    delete value.cache_ttl_ms;
    delete value.editable_args;
    // ⛔ NOT "schemas don't matter" — compared DIRECTIONALLY below, exactly as
    // `editable_args` is. Deep-equality here would refuse a target that merely
    // ADDS a closed request schema, which can only ever narrow what an operation
    // accepts (`closedRequestSchemaViolation` admits everything when the schema is
    // absent — the gate is opt-in). Narrowing grants nothing and retargets nothing,
    // so it is not an authority change; CHANGING or REMOVING one is, and that is
    // what the directional check refuses.
    delete value.request_schema;
  }

  const surfaces = isRecord(snapshot.surfaces) ? snapshot.surfaces : {};
  for (const value of Object.values(surfaces)) {
    if (isRecord(value)) delete value.executes;
  }
  return snapshot;
};

interface EditableArgMapResult {
  ok: boolean;
  values: Map<string, JsonRecord>;
}

const editableArgMap = (value: unknown): EditableArgMapResult => {
  if (value === undefined) return { ok: true, values: new Map() };
  if (!Array.isArray(value)) return { ok: false, values: new Map() };
  const values = new Map<string, JsonRecord>();
  for (const field of value) {
    if (!isRecord(field) || typeof field.key !== 'string' || values.has(field.key)) {
      return { ok: false, values: new Map() };
    }
    values.set(field.key, field);
  }
  return { ok: true, values };
};

export interface PackAuthorityComparison {
  equivalent: boolean;
  reason?: string;
}

/** Compare the installed and incoming operation/grant surfaces. This is one
 * proof, not source identity: the reconciler separately requires the installed
 * body to match a reviewed source fingerprint. Editable arguments are
 * directional: removing an input is safe for these pinned migrations; adding
 * or changing one is not. */
export const comparePackUpdateAuthority = (
  current: IngredientManifest,
  incoming: IngredientManifest,
): PackAuthorityComparison => {
  // The local store keys artifacts by their body version. Allowing a different
  // body version here could leave a higher old row winning `getManifest()` even
  // after the target write, so the closed migration requires this identity too.
  if (current.version !== incoming.version) {
    return { equivalent: false, reason: 'body_version_changed' };
  }
  if (!isDeepStrictEqual(authoritySnapshot(current), authoritySnapshot(incoming))) {
    return { equivalent: false, reason: 'authority_surface_changed' };
  }

  const currentOperations = isRecord(current.operations) ? current.operations : {};
  const incomingOperations = isRecord(incoming.operations) ? incoming.operations : {};
  for (const [operationId, incomingValue] of Object.entries(incomingOperations)) {
    const currentValue = currentOperations[operationId];
    if (!isRecord(currentValue) || !isRecord(incomingValue)) {
      return { equivalent: false, reason: `operation_shape_changed:${operationId}` };
    }
    const before = editableArgMap(currentValue.editable_args);
    const after = editableArgMap(incomingValue.editable_args);
    if (!before.ok || !after.ok) {
      return { equivalent: false, reason: `editable_argument_shape:${operationId}` };
    }
    for (const [key, field] of after.values) {
      const prior = before.values.get(key);
      if (prior === undefined || !isDeepStrictEqual(prior, field)) {
        return {
          equivalent: false,
          reason: `editable_argument_added_or_changed:${operationId}:${key}`,
        };
      }
    }
    // A closed request schema may only be ADDED. An installed operation that
    // already declares one must keep it byte-identical: relaxing or replacing a
    // LIVE gate is an authority change however the artifact is hash-pinned.
    if (currentValue.request_schema !== undefined
      && !isDeepStrictEqual(currentValue.request_schema, incomingValue.request_schema)) {
      return {
        equivalent: false,
        reason: `request_schema_changed_or_removed:${operationId}`,
      };
    }
  }
  return { equivalent: true };
};

interface CandidateBodyResult {
  ok: boolean;
  body?: IngredientManifest;
  entitySchemas?: EntitySchemaIngredientInput[];
  reason?: string;
}

/** The ledger is intentionally limited to composition-only, connection-less
 * CLI capability packs. Recipes, dependencies, defaults, webhooks, MCP body
 * grants, and connection setup all carry authority or side effects of their
 * own and remain on the owner-reviewed update path. */
const candidateBody = (
  manifest: BulkPackManifest,
  transition: ApprovedPackTransition,
): CandidateBodyResult => {
  const plan = normalizeBulkPackInstallPlan(manifest);
  if (
    manifest.manifest_version !== 2
    || manifest.publisher !== transition.publisher
    || manifest.version !== transition.to_version
    || manifest.pack_kind !== 'app_pack'
    || manifest.service_kind !== 'cli'
    || !isDeepStrictEqual(manifest.requires, [BULK_PACK_INSTALL_PERMISSION])
    || manifest.pre_install === true
    || plan.recipes.length !== 0
    || plan.contents.length !== 1
    || (manifest.dependencies?.length ?? 0) !== 0
    || (manifest.connection_requirements?.length ?? 0) !== 0
    || (manifest.connection_hints?.length ?? 0) !== 0
    || (manifest.webhook_requirements?.length ?? 0) !== 0
    || (manifest.mcp_body_visibility_grants?.length ?? 0) !== 0
  ) {
    return { ok: false, reason: 'target_not_composition_only_cli' };
  }

  const content = plan.contents[0];
  if (content?.type !== 'composition') {
    return { ok: false, reason: 'target_not_single_composition' };
  }
  const composition = content.composition;
  if (
    composition.slug !== transition.catalog_slug
    || composition.ingredients.length !== 1
    || composition.ingredients.some((ingredient) => ingredient.kind !== 'cli')
    || (composition.recipe_templates?.length ?? 0) !== 0
    || (composition.recipes?.length ?? 0) !== 0
    || (composition.default_grants?.length ?? 0) !== 0
    || (composition.work_entity_sources?.length ?? 0) !== 0
  ) {
    return { ok: false, reason: 'target_composition_has_side_effects' };
  }

  const decompose = decomposeComposition[composition.schema_version];
  if (decompose === undefined) {
    return { ok: false, reason: 'target_composition_version_unsupported' };
  }
  try {
    const artifacts = decompose(composition);
    const body = artifacts.catalog ?? artifacts.ingredient;
    return body === undefined
      ? { ok: false, reason: 'target_decomposed_to_no_body' }
      : {
          ok: true,
          // Compare the exact JSON shape the SQLite stores persist; freshly
          // decomposed objects may still carry optional `undefined` properties.
          body: persistedClone(body),
          entitySchemas: persistedClone(artifacts.entity_schemas ?? []),
        };
  } catch {
    return { ok: false, reason: 'target_decomposition_failed' };
  }
};

export type PackReconciliationStatus = 'updated' | 'current' | 'held';

export interface PackReconciliationEntry {
  pack_slug: string;
  from_version: number;
  to_version: number;
  status: PackReconciliationStatus;
  reason?: string;
}

export interface PackReconciliationReport {
  entries: PackReconciliationEntry[];
  updated: number;
  held: number;
}

export interface PackReconciliationDeps extends ProvisionAuthoredDeps {
  /** Defaults to the same bundled root as list/install/uninstall. */
  packDir?: string;
  /** Operator evidence only; logging never controls the transaction. */
  log?: (message: string) => void;
}

const held = (
  pack_slug: string,
  from_version: number,
  to_version: number,
  reason: string,
): PackReconciliationEntry => ({
  pack_slug,
  from_version,
  to_version,
  status: 'held',
  reason,
});

interface InstalledPackState {
  installedPack: JsonRecord;
  installedIngredient: JsonRecord;
  publisher?: string;
  version: number;
  body: IngredientManifest;
  entitySchemas: EntitySchemaIngredientInput[];
}

type InstalledPackStateResult =
  | { ok: true; state: InstalledPackState }
  | { ok: false; reason: string };

const canonicalPackVersion = (value: unknown): number | null => {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const catalogClaimedByAnotherPack = (
  deps: PackReconciliationDeps,
  packSlug: string,
  catalogSlug: string,
): boolean => deps.contractStore.scan('installed_pack').some((row) => {
  if (row.segments.length === 1 && row.segments[0] === packSlug) return false;
  if (!isRecord(row.value) || !Array.isArray(row.value.ingredient_ids)) return false;
  return row.value.ingredient_ids.includes(catalogSlug);
});

/** Re-read one pack from the authoritative stores. The enumeration is only a
 * slug index: another process may have updated that slug before this read, so
 * all decisions below use this coherent observed identity instead. */
const readInstalledPackState = (
  deps: PackReconciliationDeps,
  packSlug: string,
  transition: ApprovedPackTransition,
): InstalledPackStateResult => {
  const installedRow = deps.contractStore.get('installed_pack', [packSlug]);
  const installedPack = installedRow?.value;
  if (!isRecord(installedPack) || installedPack.pack_slug !== packSlug) {
    return { ok: false, reason: 'installed_state_changed_during_scan' };
  }
  const version = canonicalPackVersion(installedPack.version);
  if (version === null) {
    return { ok: false, reason: 'installed_version_invalid' };
  }
  if (!isDeepStrictEqual(installedPack.ingredient_ids, [transition.catalog_slug])) {
    return { ok: false, reason: 'installed_inventory_shape_changed' };
  }
  const body = deps.localManifestStore.getManifest(transition.catalog_slug);
  if (body === null) return { ok: false, reason: 'installed_body_missing' };
  const bodyVersion = body.version ?? 1;
  if (!Number.isSafeInteger(bodyVersion) || bodyVersion < 1) {
    return { ok: false, reason: 'installed_body_version_invalid' };
  }
  const installedIngredientRow = deps.contractStore.get(
    'installed_ingredient',
    [transition.catalog_slug],
  );
  const installedIngredient = installedIngredientRow?.value;
  const expectedCatalogKind = (body as { catalog_kind?: unknown }).catalog_kind
    ?? 'private_byo';
  if (catalogClaimedByAnotherPack(deps, packSlug, transition.catalog_slug)) {
    return { ok: false, reason: 'installed_catalog_shared' };
  }
  if (
    !isRecord(installedIngredient)
    || installedIngredient.ingredient_id !== transition.catalog_slug
    || installedIngredient.version !== String(bodyVersion)
    || installedIngredient.source_pack_slug !== packSlug
    || installedIngredient.catalog_kind !== expectedCatalogKind
  ) {
    return { ok: false, reason: 'installed_ingredient_not_owned' };
  }
  const publisher = typeof installedPack.publisher === 'string'
    && installedPack.publisher.length > 0
    ? installedPack.publisher
    : undefined;
  return {
    ok: true,
    state: {
      installedPack,
      installedIngredient,
      ...(publisher === undefined ? {} : { publisher }),
      version,
      body,
      entitySchemas: deps.localManifestStore.getEntitySchemas(transition.catalog_slug),
    },
  };
};

/** Run before listener construction. Never throws: one malformed/ambiguous pack
 * is held for owner review and cannot prevent the server from starting. */
export const reconcileInstalledPacksOnBoot = async (
  deps: PackReconciliationDeps,
): Promise<PackReconciliationReport> => {
  const entries: PackReconciliationEntry[] = [];
  const packDir = deps.packDir ?? findCommunityPackDir();
  const log = (message: string): void => {
    try {
      deps.log?.(message);
    } catch {
      // Operator evidence is best-effort and must never become a boot gate.
    }
  };
  let installed;
  try {
    installed = listInstalledPacks(deps.contractStore);
  } catch (error) {
    log(
      '[packs] launch-safe reconciliation could not enumerate installed packs: '
        + (error instanceof Error ? error.message : String(error)),
    );
    return { entries, updated: 0, held: 0 };
  }

  for (const row of installed) {
    if (!Object.prototype.hasOwnProperty.call(LAUNCH_SAFE_PACK_TRANSITIONS, row.pack_slug)) {
      continue;
    }
    const transition = LAUNCH_SAFE_PACK_TRANSITIONS[row.pack_slug];
    if (transition === undefined) continue; // Type guard for indexed access.

    let observedVersion = row.version;
    try {
      const observed = readInstalledPackState(deps, row.pack_slug, transition);
      if (!observed.ok) {
        entries.push(held(
          row.pack_slug,
          observedVersion,
          transition.to_version,
          observed.reason,
        ));
        continue;
      }
      const state = observed.state;
      observedVersion = state.version;
      if (state.publisher !== transition.publisher) {
        entries.push(held(
          row.pack_slug,
          observedVersion,
          transition.to_version,
          'installed_publisher_mismatch',
        ));
        continue;
      }
      if (
        !transition.from_versions.includes(observedVersion)
        && observedVersion !== transition.to_version
      ) {
        entries.push(held(
          row.pack_slug,
          observedVersion,
          transition.to_version,
          'source_version_not_approved',
        ));
        continue;
      }

      const target = resolveReconciliationTarget(packDir, row.pack_slug);
      if (target === null) {
        entries.push(held(
          row.pack_slug,
          observedVersion,
          transition.to_version,
          'approved_bundled_target_missing',
        ));
        continue;
      }
      if (await canonicalHash(target) !== transition.target_hash) {
        entries.push(held(
          row.pack_slug,
          observedVersion,
          transition.to_version,
          'approved_bundled_target_hash_mismatch',
        ));
        continue;
      }

      const candidate = candidateBody(target, transition);
      if (
        !candidate.ok
        || candidate.body === undefined
        || candidate.entitySchemas === undefined
      ) {
        entries.push(held(
          row.pack_slug,
          observedVersion,
          transition.to_version,
          candidate.reason ?? 'approved_target_invalid',
        ));
        continue;
      }
      if (!isDeepStrictEqual(state.entitySchemas, candidate.entitySchemas)) {
        entries.push(held(
          row.pack_slug,
          observedVersion,
          transition.to_version,
          'installed_entity_schemas_changed',
        ));
        continue;
      }

      // A second process may have completed the migration after this process
      // preloaded its registry. Prove the persisted v2 body is the reviewed
      // target and refresh the process-local registry before accepting work.
      if (observedVersion === transition.to_version) {
        if (!isDeepStrictEqual(state.body, candidate.body)) {
          entries.push(held(
            row.pack_slug,
            observedVersion,
            transition.to_version,
            'current_body_not_approved_target',
          ));
          continue;
        }
        deps.registry.register(state.body);
        entries.push({
          pack_slug: row.pack_slug,
          from_version: observedVersion,
          to_version: transition.to_version,
          status: 'current',
        });
        continue;
      }

      const authority = comparePackUpdateAuthority(state.body, candidate.body);
      if (!authority.equivalent) {
        entries.push(held(
          row.pack_slug,
          observedVersion,
          transition.to_version,
          authority.reason ?? 'authority_not_equivalent',
        ));
        continue;
      }
      const sourceApproved = isDeepStrictEqual(state.body, candidate.body)
        || transition.source_body_hashes.includes(
          await canonicalHash(sourceBodySnapshot(state.body)),
        );
      if (!sourceApproved) {
        entries.push(held(
          row.pack_slug,
          observedVersion,
          transition.to_version,
          'source_body_not_approved',
        ));
        continue;
      }

      const applied = provisionPackCompositionForBulkInstall(
        deps,
        target,
        [],
        undefined,
        undefined,
        {
          preserveExistingAuthority: true,
          expectedInstalledState: {
            installed_pack: persistedClone(state.installedPack),
            installed_ingredient: persistedClone(state.installedIngredient),
            body: state.body,
            entity_schemas: state.entitySchemas,
          },
        },
      );
      if (!applied.ok) {
        // Another boot may have won the exact same transition, or the database
        // commit may have succeeded before an in-memory registry write failed.
        // Accept either only after re-reading and proving the full target; an
        // uninstall, future update, or partial write remains held.
        const latest = readInstalledPackState(deps, row.pack_slug, transition);
        if (
          latest.ok
          && latest.state.publisher === transition.publisher
          && latest.state.version === transition.to_version
          && isDeepStrictEqual(latest.state.body, candidate.body)
          && isDeepStrictEqual(latest.state.entitySchemas, candidate.entitySchemas)
        ) {
          deps.registry.register(latest.state.body);
          entries.push({
            pack_slug: row.pack_slug,
            from_version: transition.to_version,
            to_version: transition.to_version,
            status: 'current',
          });
          continue;
        }
        entries.push(held(
          row.pack_slug,
          observedVersion,
          transition.to_version,
          applied.message === 'installed pack changed during reconciliation'
            ? 'installed_state_changed_during_apply'
            : `apply_failed:${applied.code}`,
        ));
        continue;
      }
      entries.push({
        pack_slug: row.pack_slug,
        from_version: observedVersion,
        to_version: transition.to_version,
        status: 'updated',
      });
    } catch (error) {
      entries.push(held(
        row.pack_slug,
        observedVersion,
        transition.to_version,
        `unexpected:${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  }

  const updatedEntries = entries.filter((entry) => entry.status === 'updated');
  const heldEntries = entries.filter((entry) => entry.status === 'held');
  if (updatedEntries.length > 0) {
    log(
      `[packs] launch-safe reconciliation updated ${updatedEntries.length} pack(s): `
        + updatedEntries.map((entry) => (
          `${entry.pack_slug} v${entry.from_version}→v${entry.to_version}`
        )).join(', '),
    );
  }
  if (heldEntries.length > 0) {
    log(
      `[packs] launch-safe reconciliation held ${heldEntries.length} pack(s) for owner review: `
        + heldEntries.map((entry) => `${entry.pack_slug} (${entry.reason})`).join(', '),
    );
  }
  return {
    entries,
    updated: updatedEntries.length,
    held: heldEntries.length,
  };
};
