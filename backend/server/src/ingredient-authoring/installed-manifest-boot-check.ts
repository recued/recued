/** D-259 § 0.1.1 — the boot check that tells the owner an installed pack no
 *  longer runs.
 *
 *  ⛔ THE FAILURE THIS EXISTS FOR HAS NO SYMPTOM UNTIL SOMEBODY USES IT.
 *  Deleting the legacy CLI decoders made three declaration shapes rejected
 *  rather than tolerated — unsupervised detach, supervision without readiness,
 *  and progress with no `stall_ms`. A pack installed BEFORE that release keeps
 *  its old manifest on disk, so the op does not break at update time; it breaks
 *  the next time a recipe calls it, as an error about a binding the owner never
 *  wrote and cannot see.
 *
 *  There is no automatic pack update — discovery is a client-side join in
 *  Discover and an upgrade is the owner reinstalling — so on an unattended
 *  server nothing ever notices. This is what notices.
 *
 *  ⛔ IT CHECKS, IT DOES NOT FIX. Reinstalling a pack changes the operation set
 *  a grant was scoped for, which `pack-install-handler` calls "a different
 *  decision" and routes through the owner for exactly that reason. A boot path
 *  that silently re-scoped what an agent may do — with no human present — would
 *  contradict the thing the rest of this architecture is built to guarantee.
 *  So it reports and stops.
 *
 *  🔑 IT CALLS THE VALIDATOR RATHER THAN RE-STATING ITS RULES. A second copy of
 *  "what counts as legacy" would drift from the first, and the drift would show
 *  up as a boot check that stays quiet about the exact shape publication now
 *  refuses. `validateIngredient` is the one definition; this only decides WHEN
 *  to ask it and WHO to tell.
 */

import { validateIngredient } from '@recued/ingredients';
import type { IngredientManifest } from '@recued/contracts';

/** One installed manifest the current runtime would refuse to publish. */
export interface UnrunnableInstalledManifest {
  slug: string;
  version?: number;
  /** Stable validator codes, deduped — e.g. `CLI_LEGACY_UNSUPERVISED_DETACH`. */
  codes: string[];
  /** The first message, for a log line a human can act on. */
  detail: string;
}

export interface InstalledManifestBootCheckPorts {
  /** Every current-version installed manifest (`LocalManifestStore`). */
  listManifests: () => IngredientManifest[];
  /** Best-effort operator notify. Never throws, never blocks boot. */
  notify?: (message: string) => void;
  /** Durable record, so the finding survives a log rotation. */
  audit?: (entry: { slug: string; codes: string[]; detail: string }) => void;
  log?: (message: string) => void;
}

/** Pure judgement: which installed manifests would the CURRENT validator
 *  reject? Separated from the reporting so the decision is testable without a
 *  store, a clock or an audit sink. */
export const findUnrunnableInstalledManifests = (
  manifests: ReadonlyArray<IngredientManifest>,
): UnrunnableInstalledManifest[] => {
  const out: UnrunnableInstalledManifest[] = [];
  for (const manifest of manifests) {
    // ⚠ Guard the SHAPE before the judgement. A non-object row cannot be
    // reported ("which pack?") and must not crash the sweep of the packs that
    // can — one unreadable row should never hide every other finding.
    if (manifest === null || typeof manifest !== 'object') continue;
    const slug = (manifest as { slug?: unknown }).slug;
    if (typeof slug !== 'string' || slug.length === 0) continue;
    let result;
    try {
      result = validateIngredient(manifest);
    } catch {
      // ⚠ A validator throw is NOT a finding. It means we could not judge this
      // manifest, which is a different fact from "this manifest is broken", and
      // reporting it as the latter would send the owner to reinstall a pack
      // that is fine. Skip it; a real problem still surfaces at dispatch.
      continue;
    }
    const errors = (result.issues ?? []).filter((issue) => issue.severity === 'error');
    if (errors.length === 0) continue;
    const codes = [...new Set(errors.map((issue) => String(issue.code)))].sort();
    out.push({
      slug,
      ...(typeof manifest.version === 'number' ? { version: manifest.version } : {}),
      codes,
      detail: String(errors[0]?.message ?? ''),
    });
  }
  return out;
};

/** Run the check and report. Returns what it found so a caller can assert on
 *  it; never throws, because a boot check that can fail boot is worse than the
 *  drift it looks for. */
export const checkInstalledManifestsOnBoot = (
  ports: InstalledManifestBootCheckPorts,
): UnrunnableInstalledManifest[] => {
  let found: UnrunnableInstalledManifest[] = [];
  try {
    found = findUnrunnableInstalledManifests(ports.listManifests());
  } catch (err) {
    ports.log?.(
      '[packs] installed-manifest boot check could not run: '
        + (err instanceof Error ? err.message : String(err)),
    );
    return [];
  }
  if (found.length === 0) return [];

  // The log line names the FIX, not just the fault: the owner cannot infer
  // "reinstall from Discover" from a validator code.
  ports.log?.(
    `[packs] ⛔ ${found.length} installed pack(s) declare shapes this server no `
      + 'longer runs. Their operations will fail when called. Update them in '
      + 'Discover (Settings → Packs) to the current version:',
  );
  for (const row of found) {
    const at = row.version === undefined ? '' : ` v${row.version}`;
    ports.log?.(`[packs]    ${row.slug}${at} — ${row.codes.join(', ')}: ${row.detail}`);
    try {
      ports.audit?.({ slug: row.slug, codes: row.codes, detail: row.detail });
    } catch { /* audit is evidence, never authority over boot */ }
  }
  try {
    ports.notify?.(
      `${found.length} installed pack(s) need updating: `
        + `${found.map((r) => r.slug).join(', ')}. Their operations fail until you `
        + 'update them in Settings → Packs.',
    );
  } catch { /* best-effort */ }
  return found;
};
