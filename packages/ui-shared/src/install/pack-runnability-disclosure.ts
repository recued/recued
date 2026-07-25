/** R2 build step 4 — pack install/uninstall runnability disclosure copy.
 *
 *  The SHARED copy layer for the "born blocked / born degraded" install
 *  disclosure (4c.2, `BulkPackInstallResultLike.born_blocked` /
 *  `.born_degraded`) and the "disables N recipes" uninstall disclosure
 *  (4c.3 + the §1.6 follow-on, `BulkPackUninstallResultLike.would_disable`
 *  / `.would_degrade`), so the #recipes route and the Settings → Packs
 *  panel speak the same language (recipe-identity doc §1.6). DISCLOSURE
 *  over the D-157 gate, never enforcement — every line is
 *  recoverability-honest: a blocked recipe stays installed and recovers
 *  the moment a provider is bound.
 *
 *  Pure shape → data, deliberately NOT shape → HTML: the route renders
 *  blocks as escaped template strings, the packs panel via
 *  `createElement` + `textContent`. Sharing the copy (not the markup)
 *  keeps each surface in its own rendering idiom while the user-facing
 *  language can't drift between them.
 *
 *  § 7 surfacing slice — the install blocks also carry the per-recipe PII
 *  posture (`BulkPackInstallResultLike.pii_disclosure`, kind `'pii'`): the
 *  summary messages arrive server-built and render verbatim.
 */

import type {
  BulkPackInstallResultLike,
  BulkPackUninstallResultLike,
  RecipeRunnabilityEntry,
} from '@recued/contracts';

export type PackDisclosureKind =
  | 'born-blocked'
  | 'born-degraded'
  | 'pii'
  | 'would-disable'
  | 'would-degrade';

export interface PackDisclosureItem {
  recipe_id: string;
  /** Human detail after the recipe id (the per-recipe "why"); empty
   *  string = none. Surfaces render `${recipe_id} — ${detail}` when
   *  non-empty. */
  detail: string;
}

export interface PackDisclosureBlock {
  kind: PackDisclosureKind;
  headline: string;
  items: PackDisclosureItem[];
}

const plural = (count: number, singular: string): string =>
  `${count} ${count === 1 ? singular : `${singular}s`}`;

const formatCapabilityOps = (
  capability: string,
  ops: readonly string[],
): string => ops.map((op) => `${capability}.${op}`).join(', ');

/** One human line per UNSATISFIED dependency (doc §1.6 disclosure copy).
 *  `unprovided_ops` names exactly what a new provider must add; when it's
 *  empty despite `satisfied: false` (every op granted somewhere but no
 *  SINGLE provider covers them all — the cross-provider spread, doc §4)
 *  the line falls back to the dependency's full op list. */
export const runnabilityDisclosureLines = (
  entry: RecipeRunnabilityEntry,
): string[] =>
  entry.dependencies
    .filter((dep) => !dep.satisfied)
    .map((dep) => {
      const suffix = dep.optional ? ' (optional — those steps skip)' : '';
      return dep.unprovided_ops.length > 0
        ? `Add a provider for ${formatCapabilityOps(dep.capability, dep.unprovided_ops)}${suffix}.`
        : `No single connected provider covers all of ${formatCapabilityOps(dep.capability, dep.ops)}${suffix}.`;
    });

const installItem = (entry: RecipeRunnabilityEntry): PackDisclosureItem => ({
  recipe_id: entry.recipe_id,
  detail:
    runnabilityDisclosureLines(entry).join(' ')
    || 'a declared dependency has no provider.',
});

/** The install result's "born blocked / degraded" disclosure (4c.2) as
 *  renderable blocks — one per non-empty partition, in blocked-then-
 *  degraded order. Empty when the result carries neither field (the
 *  contract omits them when empty / unwired). Callers should gate on
 *  `result.ok` — the fields are success-path only, and rendering them
 *  beside failure copy would contradict it. */
export const installDisclosureBlocks = (
  result: BulkPackInstallResultLike,
): PackDisclosureBlock[] => {
  const blocked = result.born_blocked ?? [];
  const degraded = result.born_degraded ?? [];
  const blocks: PackDisclosureBlock[] = [];
  if (blocked.length > 0) {
    blocks.push({
      kind: 'born-blocked',
      headline: `This pack added ${plural(blocked.length, 'recipe')} that cannot run until a provider is connected:`,
      items: blocked.map(installItem),
    });
  }
  if (degraded.length > 0) {
    blocks.push({
      kind: 'born-degraded',
      headline: `${plural(degraded.length, 'recipe')} will run with an optional capability skipped:`,
      items: degraded.map(installItem),
    });
  }
  const pii = result.pii_disclosure ?? [];
  if (pii.length > 0) {
    blocks.push({
      kind: 'pii',
      headline: 'PII handling for this pack\'s recipes:',
      items: pii.map((entry) => ({
        recipe_id: entry.recipe_id,
        // Headline first, then the standing warnings; info lines stay on the
        // per-recipe surfaces (the recipes view) — the install notice keeps
        // to what changes the user's decision.
        detail: [entry.summary.headline, ...entry.summary.warnings.map((w) => w.message)]
          .filter((line) => line !== '')
          .join(' '),
      })),
    });
  }
  return blocks;
};

/** The uninstall result's "disables N recipes" disclosure (4c.3 + the
 *  §1.6 follow-on) as renderable blocks — would-disable then
 *  would-degrade, one per non-empty field (mirrors the install blocks'
 *  blocked-then-degraded order). Would-disable: the SURVIVING recipes
 *  that went blocked because this uninstall removed their last provider
 *  — never deleted (doc §1.6's forbidden destructive failure).
 *  Would-degrade: survivors that keep running with an optional
 *  capability's steps skipped (the degraded run is AUTHORED, doc §1.5).
 *  Empty when nothing worsened. Same `result.ok` gating note as the
 *  install blocks. */
export const uninstallDisclosureBlocks = (
  result: BulkPackUninstallResultLike,
): PackDisclosureBlock[] => {
  const disabled = result.would_disable ?? [];
  const degraded = result.would_degrade ?? [];
  const blocks: PackDisclosureBlock[] = [];
  if (disabled.length > 0) {
    blocks.push({
      kind: 'would-disable',
      headline: `This disabled ${plural(disabled.length, 'recipe')} that lost their last provider — they stay installed and recover when a provider is connected:`,
      items: disabled.map((transition) => ({
        recipe_id: transition.recipe_id,
        detail:
          transition.before === 'degraded' ? 'was already degraded.' : '',
      })),
    });
  }
  if (degraded.length > 0) {
    blocks.push({
      kind: 'would-degrade',
      headline: `${plural(degraded.length, 'recipe')} lost an optional capability — they keep running with those steps skipped, and recover when a provider is connected:`,
      items: degraded.map((transition) => ({
        recipe_id: transition.recipe_id,
        detail: '',
      })),
    });
  }
  return blocks;
};
