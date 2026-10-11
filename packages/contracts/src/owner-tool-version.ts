/** D-321 — the owner's choice, per tool, of what a run does when the installed
 * version is outside the range its pack was tested with (R1).
 *
 * The pack declares a default (`version.outside`: refuse or warn). The owner can
 * switch it per tool on the pack's page, the way D-211 lets the owner replace a
 * pack's declared approval for an action. One row per cli catalog, since a cli
 * catalog runs one tool, keyed by the catalog's slug.
 *
 * The row is stamped with a hash of the pack's `version` block as the owner saw
 * it. A pack update that changes the range or the default makes a Warn stale,
 * and the pack's default applies until the owner chooses again: a Warn given for
 * 1.x is never carried onto 2.x, the case a refusal exists for. A Refuse stays
 * (D-321 audit): nothing is stricter, so a pack update is never what lets an
 * untested version run where the owner refused it.
 */

import { canonicalJSONStringify } from '@recued/crypto/canonical-json';
import { sha256Hex } from '@recued/crypto/hash';
import {
  CLI_VERSION_OUTSIDE,
  type CliToolVersionPolicy,
  type CliVersionOutside,
} from './cli-tool-version.js';

/** Actorless row key: `(ingredient_id)`, the cli catalog's slug. */
export const OWNER_TOOL_VERSION_SCOPE = 'owner_tool_version';

/** The stamp of a declared `version` block: its range and its default. */
export const cliToolVersionHash = (version: CliToolVersionPolicy): string =>
  sha256Hex(canonicalJSONStringify(version));

export const isCliVersionOutside = (value: unknown): value is CliVersionOutside =>
  typeof value === 'string' && (CLI_VERSION_OUTSIDE as readonly string[]).includes(value);

/** One stored owner choice. */
export interface OwnerToolVersionRow {
  outside: CliVersionOutside;
  /** `cliToolVersionHash` of the pack's `version` block when the owner chose. */
  version_hash: string;
}

/** Narrow a stored row value. A malformed hand-stored row reads as no choice,
 * so local state that does not parse falls back to the pack's default. */
export const readOwnerToolVersionRow = (value: unknown): OwnerToolVersionRow | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { outside, version_hash } = value as Record<string, unknown>;
  if (!isCliVersionOutside(outside)) return undefined;
  if (typeof version_hash !== 'string' || !/^[0-9a-f]{64}$/u.test(version_hash)) return undefined;
  return { outside, version_hash };
};

/** What a run does outside the tested range: the owner's choice when it was made
 * for the `version` block the pack declares now, else the pack's default; and an
 * owner's Refuse whatever it was made for. */
export const effectiveToolVersionOutside = (
  declared: CliToolVersionPolicy,
  owner: OwnerToolVersionRow | undefined,
): { outside: CliVersionOutside; source: 'owner' | 'pack'; stale_owner_choice: boolean } => {
  if (owner === undefined) return { outside: declared.outside, source: 'pack', stale_owner_choice: false };
  if (owner.version_hash === cliToolVersionHash(declared)) {
    return { outside: owner.outside, source: 'owner', stale_owner_choice: false };
  }
  // ⛔ ONLY A LOOSENING LAPSES. A Warn made for other terms is not carried onto
  // these; a Refuse is, since no setting is stricter.
  if (owner.outside === 'refuse') return { outside: 'refuse', source: 'owner', stale_owner_choice: false };
  return { outside: declared.outside, source: 'pack', stale_owner_choice: true };
};

/** D-321 — a program whose handling outside its tested range a pack update
 * changes, shown in the update's review beside D-211's owner rules.
 *
 * An owner's choice is made for the `version` block the pack declares then, and
 * an update that declares another makes it stale: a stale Warn lapses to the
 * pack's default, a stale Refuse holds (`effectiveToolVersionOutside`). Listed
 * only when the update changes what happens to an untested version; a choice it
 * leaves in force stays quiet, as D-211's review does. */
export interface ToolVersionUpdateReviewItem {
  /** The catalog the program belongs to: the key of the owner's choice. */
  ingredient_id: string;
  /** The program the pack's actions run. */
  tool: string;
  /** What happens to an untested version now, and once the update is installed. */
  outside_now: CliVersionOutside;
  outside_after: CliVersionOutside;
  /** The range the update was tested with. */
  tested: CliToolVersionPolicy['tested'];
}

/** One owner choice, as the rpc returns it. */
export interface OwnerToolVersionView {
  ingredient_id: string;
  outside: CliVersionOutside;
  /** The pack's declared default, shown beside the owner's choice. */
  pack_outside: CliVersionOutside;
  tested: CliToolVersionPolicy['tested'];
  version_hash: string;
  written_at: number;
}
