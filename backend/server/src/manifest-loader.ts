/** Ingredient manifest loader for the headless server.
 *
 *  Loads manifests from two disjoint sources:
 *  1. Bundled: community/ingredients/*.json files on disk
 *  2. Local/inline: caller can register additional manifests at runtime
 *
 *  D-170 N.16 precedence is deliberately slug-scoped:
 *    - a local manifest present for a slug shadows the bundled layer;
 *    - when no local manifest exists, resolution falls through to bundled;
 *    - a requested version must match the winning layer exactly. A local
 *      version mismatch returns null rather than falling through to bundled.
 *
 *  The loader is a function from slug → manifest, matching the
 *  ManifestLoader type expected by @recued/ingredients dispatch.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isCoreSlug } from '@recued/contracts';
import type { IngredientManifest } from '@recued/contracts';
import type Database from 'better-sqlite3';
import { initializePreapprovalLifecycle, synchronizePreapprovalIdentity } from './storage/preapproval-lifecycle.js';
import { KERNEL_MANIFESTS } from './kernel-manifests.js';

export interface ManifestRegistry {
  /** Look up an ingredient manifest by slug. When `version` is supplied, only
   *  an exact version match in the winning layer resolves; mismatches return
   *  null. */
  get(slug: string, version?: number): IngredientManifest | null;
  /** Number of loaded manifests. */
  size(): number;
  /** All loaded slugs. */
  slugs(): string[];
  /** Register an additional local/inline manifest (e.g., from a request or
   *  test). Local manifests shadow bundled manifests of the same slug until
   *  unregistered. */
  register(manifest: IngredientManifest): void;
  /** D-170 — drop a manifest by slug from live resolution (uninstall of a
   *  locally-authored catalog / ingredient). Only the local/inline layer is
   *  removed; if a bundled manifest shares the slug, it becomes visible again.
   *  Returns true iff a local/inline manifest was present. */
  unregister(slug: string): boolean;
}

/** Scan a directory for *.json files and load each as an IngredientManifest.
 *  Skips files that fail to parse or lack a slug. */
const loadFromDirectory = (dir: string): Map<string, IngredientManifest> => {
  const manifests = new Map<string, IngredientManifest>();
  if (!existsSync(dir)) return manifests;

  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = readFileSync(join(dir, file), 'utf-8');
      const manifest = JSON.parse(raw) as IngredientManifest;
      if (manifest.slug) {
        manifests.set(manifest.slug, manifest);
      }
    } catch {
      // Skip malformed files — don't crash the server for a bad ingredient
    }
  }
  return manifests;
};

const versionMatches = (
  manifest: IngredientManifest,
  requestedVersion: number | undefined,
): boolean =>
  requestedVersion === undefined || manifest.version === requestedVersion;

const getFromLayer = (
  manifests: Map<string, IngredientManifest>,
  slug: string,
  requestedVersion: number | undefined,
): IngredientManifest | null => {
  const manifest = manifests.get(slug);
  if (!manifest) return null;
  return versionMatches(manifest, requestedVersion) ? manifest : null;
};

const unionSlugs = (
  bundled: Map<string, IngredientManifest>,
  local: Map<string, IngredientManifest>,
): string[] => {
  const slugs = [...bundled.keys()];
  for (const slug of local.keys()) {
    if (!bundled.has(slug)) slugs.push(slug);
  }
  return slugs;
};

/** Resolve the community/ingredients directory relative to the project root.
 *  Walks up from the server src dir to find the workspace root. */
const findCommunityDir = (): string => {
  // backend/server/src/ → the repository root
  const projectRoot = resolve(import.meta.dirname ?? __dirname, '..', '..', '..');
  return join(projectRoot, 'community', 'ingredients');
};

/** Create a manifest registry pre-loaded with bundled community ingredients. */
export const createManifestRegistry = (
  communityDir?: string,
  db?: Database.Database,
): ManifestRegistry => {
  if (db) initializePreapprovalLifecycle(db);
  const dir = communityDir ?? findCommunityDir();
  const bundledManifests = loadFromDirectory(dir);
  // Kernel substrate is inlined in code (KERNEL_MANIFESTS) so it ships in the server bundle —
  // community/ is NOT copied into the production runtime image, and the kernel must always
  // resolve. Seed it as the authoritative bundled layer on the default path; a test-supplied
  // communityDir injects its own manifests and is left untouched.
  if (communityDir === undefined) {
    for (const m of KERNEL_MANIFESTS) bundledManifests.set(m.slug, m);
  }
  const localManifests = new Map<string, IngredientManifest>();
  const synchronize = (slug: string, value: IngredientManifest | null, removed = false): void => {
    if (!db) return;
    db.transaction(() => {
      if (removed) synchronizePreapprovalIdentity(db, 'installed_manifest', slug, null);
      synchronizePreapprovalIdentity(db, 'installed_manifest', slug, value);
    }).immediate();
  };

  return {
    get(slug, version) {
      // §5 anti-shadow — a `core-*` slug ALWAYS resolves to the bundled kernel
      // layer; a local manifest can never shadow it. The publish gate trusts a
      // recipe's direct `core-*` ingredient steps as kernel capabilities, so if a
      // user-registered (composition / save-as-new) manifest could shadow a
      // `core-*` slug with arbitrary behavior, that trust anchor would be
      // spoofable. The `register` guard below also keeps `core-*` out of the local
      // layer; this is the belt to that suspenders.
      if (isCoreSlug(slug)) {
        return getFromLayer(bundledManifests, slug, version);
      }
      if (localManifests.has(slug)) {
        return getFromLayer(localManifests, slug, version);
      }
      return getFromLayer(bundledManifests, slug, version);
    },
    size() {
      return unionSlugs(bundledManifests, localManifests).length;
    },
    slugs() {
      return unionSlugs(bundledManifests, localManifests);
    },
    register(manifest) {
      // §5 anti-shadow — refuse to register a `core-*` slug into the local layer.
      // The reserved kernel namespace is bundled-only; a local registration (e.g.
      // a compiled composition / save-as-new manifest) must not be able to claim a
      // `core-*` identity. `get()` already ignores the local layer for `core-*`, so
      // this keeps the local map clean (size()/slugs() stay accurate) and fails
      // closed at the write.
      if (isCoreSlug(manifest.slug)) {
        return;
      }
      synchronize(manifest.slug, manifest);
      localManifests.set(manifest.slug, manifest);
    },
    unregister(slug) {
      if (localManifests.has(slug)) synchronize(slug, bundledManifests.get(slug) ?? null, true);
      return localManifests.delete(slug);
    },
  };
};

/** Wrap a ManifestRegistry as an async ManifestLoader for the dispatch layer. */
export const asManifestLoader = (
  registry: ManifestRegistry,
): ((slug: string) => Promise<IngredientManifest | null>) =>
  async (slug) => registry.get(slug);
