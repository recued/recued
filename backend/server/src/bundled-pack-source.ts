/** The bundled pack manifest source — the one roster `packs.list`,
 *  `packs.install` and `packs.uninstall` read, and the one answer to whether a
 *  pack is a core feature or something the owner manages.
 *
 *  Two sources, one rule: every `*.json` under the `community/packs` tree (a
 *  source checkout), UNIONED with the manifests embedded in the server bundle
 *  (`bundled-foundation.generated.ts`) when the caller is on the default path.
 *  Disk wins on a slug collision — a checkout's file is the authoring source of
 *  truth and may be newer than the last generator run.
 *
 *  ⛔ WHY THE EMBED IS NOT AN OPTIMISATION. A distribution ships `dist/`, not
 *  the pack corpus: npm's `files` allowlist omits `community/`, the Docker
 *  runtime stage never COPYs it, and the SEA carries no corpus either — stated
 *  by `gen-bundled-foundation.mjs` and `gen-bundled-pack-reconciliation.mjs`
 *  both. So on a real install `findCommunityPackDir()` names a directory that
 *  does not exist, the scan yields nothing, and the embed is the ONLY source.
 *  A disk-only reader answers "this server ships no packs" on every deployed
 *  server. The embed carries BOTH kinds — `pre_install` core features, so the
 *  boot wire can install them, and `bundled` packs, so the owner has something
 *  to install — and this roster hands back only the second (see
 *  {@link isCoreFeaturePack}).
 *
 *  ⛔⛔ THE FOUR READERS DIVERGED, WHICH IS HOW THAT SURVIVED. The boot
 *  pre-install walked recursively AND unioned the embed; `packs.install` walked
 *  recursively and did not; `packs.list` and `packs.uninstall` did neither. A
 *  deployed server therefore installed its foundation packs at boot and then
 *  listed none of them, and even a source checkout hid the five packs nested
 *  under `community/packs/recued-core/`. Every layer degraded to silence rather
 *  than error, so there was no log line and no red test anywhere in the chain.
 *  One module now answers "what packs does this server ship", so a reader
 *  cannot answer it differently by accident.
 *  See internal design notes.
 *
 *  🔑 AN EXPLICIT `packDir` MEANS "THIS FIXTURE IS THE CORPUS" — no embed.
 *  Every harness that points a `packs.*` rpc at a scratch directory relies on
 *  it, and `foundation-pack-pre-install.ts` states the same rule for the boot
 *  scan. The gate is derived from the same argument as the directory, so the
 *  two cannot disagree: there is no way to be on the default path and skip the
 *  union, or to pin a fixture and be handed packs it never wrote.
 *  Production leaves `packDir` undefined (`serve/compose-rpc-context.ts` builds
 *  all three `packs.*` dep bundles without it). */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parseBulkPackManifest, type BulkPackManifest } from '@recued/contracts';

import { BUNDLED_FOUNDATION_PACKS } from './bundled-foundation.generated.js';

/** Default `community/packs` directory resolution — the project root three
 *  levels above this module (`<root>/backend/server/src`).
 *
 *  `moduleDir` overrides the base this resolves from. It exists so a test can
 *  drive the DISTRIBUTION layout in-process — resolve as if this module lived
 *  in an installed package's `dist/`, where the computed directory does not
 *  exist — because the difference between a checkout and a distribution is
 *  where this defect lived, and a checkout cannot otherwise observe it.
 *  Production never passes it. */
export const findCommunityPackDir = (moduleDir?: string): string => {
  const base = moduleDir ?? import.meta.dirname ?? __dirname;
  const projectRoot = resolve(base, '..', '..', '..');
  return join(projectRoot, 'community', 'packs');
};

/** Recursively collect every `*.json` under `dir`. First-party packs nest one
 *  level under a publisher directory (`community/packs/recued-core/*.json` —
 *  the reception core-packs and `mail-compose-foundation`), so a non-recursive
 *  scan silently misses five of the six foundation packs even in a checkout. */
export const walkJsonFiles = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsonFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
  }
  return out;
};

/** Parse one on-disk candidate. Malformed files drop silently: the pack tree
 *  also holds non-manifest JSON (a foundation pack's config templates), and the
 *  boot pre-install wire is the surface that logs validator failures — a list
 *  rpc that surfaced a broken manifest would render an Install button the user
 *  could never resolve. */
const readManifestFile = (file: string): BulkPackManifest | null => {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = parseBulkPackManifest(parsed);
  return result.ok ? result.manifest : null;
};

/** The embedded foundation manifests, re-validated and cloned.
 *
 *  ⛔⛔ PARSING IS LOAD-BEARING, NOT HYGIENE — a live drive proved it. The
 *  validator LIFTS a v2 manifest's `contents[]` into `recipes[]`, and two
 *  foundation packs (`mail-compose-foundation`, `personal-organizer-foundation`)
 *  declare their twelve recipes ONLY through `contents[]`. Read raw, they are
 *  recipe-less: the boot wire resolved zero recipes, `allRecipesAlreadyInstalled`
 *  answered its empty loop with `true`, and both packs were recorded `no_op` —
 *  "already installed" — on a server where they had never been installed at all.
 *  A disk manifest could never do that, because the disk path always parsed.
 *  D-259's reconciliation resolver re-parses its own embed for the same reason.
 *
 *  Cloning keeps a downstream in-place rewrite — op-step resolution rewrites a
 *  manifest before persist — from corrupting the shared module constant for the
 *  life of the process.
 *
 *  `invalid` is returned rather than dropped so a caller that reports outcomes
 *  (the boot wire) can say a bundled pack failed validation. A generator that
 *  emitted a bad manifest would otherwise remove a foundation pack from a
 *  release in silence, which is the failure mode this whole area is made of. */
export const parseEmbeddedFoundationManifests = (): {
  ok: BulkPackManifest[];
  invalid: { slug: string; reason: string }[];
} => {
  const ok: BulkPackManifest[] = [];
  const invalid: { slug: string; reason: string }[] = [];
  for (const manifest of BUNDLED_FOUNDATION_PACKS) {
    const result = parseBulkPackManifest(structuredClone(manifest));
    if (result.ok) ok.push(result.manifest);
    else {
      invalid.push({
        slug: String((manifest as { slug?: unknown }).slug ?? 'unknown'),
        reason: result.issues
          .filter((issue) => issue.severity === 'error')
          .map((issue) => `${issue.code}@${issue.path}: ${issue.message}`)
          .join('; '),
      });
    }
  }
  return { ok, invalid };
};

const embeddedFoundationManifests = (): BulkPackManifest[] =>
  parseEmbeddedFoundationManifests().ok;

/** Is this a core feature rather than a pack the owner manages?
 *
 *  🔑 The owner's rule, 2026-09-07: a core feature installs itself and never
 *  appears in Packs, *because the user cannot manage it*; anything manageable
 *  like a normal pack is shown. `pre_install` is that line — see
 *  `BulkPackManifest.pre_install`. The reception core-packs are the case: they
 *  provision the reception door, which has its own settings surface, so a Packs
 *  row for them could only offer a Delete the next boot silently undoes.
 *
 *  Shared so the roster, the install refusal and the uninstall refusal cannot
 *  answer it differently — the divergence this module exists to end. */
export const isCoreFeaturePack = (manifest: BulkPackManifest): boolean =>
  manifest.pre_install === true;

/** The bundled pack roster: the pack tree, unioned with the embedded
 *  foundation manifests on the default path. Deduped by manifest `slug` (walk
 *  order wins, then the embed fills what disk did not provide) so a duplicate
 *  slug can never render two rows for one pack.
 *
 *  ⚠ CORE-FEATURE PACKS ARE NOT IN IT. Every caller of this function is a
 *  surface the owner acts through — the Packs roster, the install resolver's
 *  dependency walk, the connection-enroll scope union — and a pack the owner
 *  cannot manage belongs in none of them. The BOOT WIRE reads its own scan
 *  (`foundation-pack-pre-install.ts`) precisely because it needs the packs this
 *  one hides. */
export const loadBundledPackManifests = (
  packDir?: string,
  moduleDir?: string,
): BulkPackManifest[] => {
  const dir = packDir ?? findCommunityPackDir(moduleDir);
  const bySlug = new Map<string, BulkPackManifest>();
  for (const file of walkJsonFiles(dir)) {
    const manifest = readManifestFile(file);
    if (manifest === null || bySlug.has(manifest.slug)) continue;
    bySlug.set(manifest.slug, manifest);
  }
  if (packDir === undefined) {
    for (const manifest of embeddedFoundationManifests()) {
      if (!bySlug.has(manifest.slug)) bySlug.set(manifest.slug, manifest);
    }
  }
  return [...bySlug.values()].filter((manifest) => !isCoreFeaturePack(manifest));
};

/** Resolve one pack by manifest `slug`, disk first, embed second.
 *
 *  Walks and returns on the first match rather than loading the whole roster:
 *  `packs.resolveBySlug` fires on every pack detail render, and a checkout's
 *  tree is 1,000+ manifests. The file name on disk does not have to match the
 *  manifest's `slug` — row identity is the parsed slug everywhere — so this
 *  cannot become a direct `<dir>/<slug>.json` read (that is
 *  `resolveRootBundledPackManifest`, whose closed reconciliation ledger wants
 *  exactly the opposite trade). */
export const resolveBundledPackManifest = (
  packDir: string | undefined,
  packSlug: string,
  moduleDir?: string,
): BulkPackManifest | null => {
  // ⚠ NOT filtered by `isCoreFeaturePack`: this answers "what is this pack",
  // which the install/uninstall handlers need in order to REFUSE a core pack by
  // name. Filtering here would turn a refusal into "no such pack", which is a
  // different and less honest answer to the owner.
  const dir = packDir ?? findCommunityPackDir(moduleDir);
  for (const file of walkJsonFiles(dir)) {
    const manifest = readManifestFile(file);
    if (manifest !== null && manifest.slug === packSlug) return manifest;
  }
  if (packDir !== undefined) return null;
  for (const manifest of embeddedFoundationManifests()) {
    if (manifest.slug === packSlug) return manifest;
  }
  return null;
};
