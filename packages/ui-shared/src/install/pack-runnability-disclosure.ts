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
 *  when its missing provider or declared pack is restored.
 *
 *  Pure shape → data, deliberately NOT shape → HTML: the route renders
 *  blocks as escaped template strings, the packs panel via
 *  `createElement` + `textContent`. Sharing the copy (not the markup)
 *  keeps each surface in its own rendering idiom while the user-facing
 *  language can't drift between them. A runnability entry can now be blocked
 *  by either a connection family or an uninstalled pack, so the shared layer
 *  also owns that distinction; consumers must not each guess at the cause.
 *
 *  § 7 surfacing slice — the install blocks also carry the per-recipe PII
 *  posture (`BulkPackInstallResultLike.pii_disclosure`, kind `'pii'`): the
 *  summary messages arrive server-built and render verbatim.
 */

import { isKernelConnectionFamily } from '@recued/contracts';
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
/** A dependency whose `capability` is not one of the closed connection families
 *  is a PACK ref (`<publisher>.<pack>`) — the backend reuses this wire shape for
 *  a declared pack it cannot resolve rather than widening the contract.
 *
 *  ⚠ Tested against the authoritative `['crm','acct']` list, NOT against
 *  punctuation. "Contains a dot" would also have worked today and would have
 *  broken silently the first time a family name gained one; this cannot.
 *  Adding a family to `KERNEL_CONNECTION_FAMILIES` keeps this correct for free. */
const isPackDependency = (capability: string): boolean =>
  !isKernelConnectionFamily(capability);

/** Publisher-qualified pack refs that currently block this recipe.
 *
 *  Kept beside the copy classifier so every consumer agrees on what the
 *  backend's reused `DependencyResolution` shape means. De-duplicating is
 *  defensive against version-skewed servers and avoids rendering two consent
 *  links to the same pack. */
export const missingPackRefsFromRunnability = (
  entry: RecipeRunnabilityEntry,
): string[] => {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const dep of entry.dependencies) {
    if (
      dep.satisfied
      || !isPackDependency(dep.capability)
      || seen.has(dep.capability)
    ) continue;
    seen.add(dep.capability);
    refs.push(dep.capability);
  }
  return refs;
};

/** `recued-core.officecli` → `officecli`. The publisher qualifies the ref for
 *  the machine; a person reads the pack by its own name. */
const packSlug = (capability: string): string => {
  const dot = capability.indexOf('.');
  return dot === -1 ? capability : capability.slice(dot + 1);
};

export const runnabilityDisclosureLines = (
  entry: RecipeRunnabilityEntry,
): string[] =>
  entry.dependencies
    .filter((dep) => !dep.satisfied)
    .map((dep) => {
      const suffix = dep.optional ? ' (optional — those steps skip)' : '';
      // A missing pack is not a missing PROVIDER — nothing to connect, nothing
      // to pick. The remedy is an install, and saying "add a provider for
      // recued-core.officecli" would send the owner to Connections, which has
      // nothing for them.
      if (isPackDependency(dep.capability)) {
        return `Install the ${packSlug(dep.capability)} pack to make this recipe work${suffix}.`;
      }
      return dep.unprovided_ops.length > 0
        ? `Add a provider for ${formatCapabilityOps(dep.capability, dep.unprovided_ops)}${suffix}.`
        : `No single connected provider covers all of ${formatCapabilityOps(dep.capability, dep.ops)}${suffix}.`;
    });

const installItem = (entry: RecipeRunnabilityEntry): PackDisclosureItem => ({
  recipe_id: entry.recipe_id,
  detail:
    runnabilityDisclosureLines(entry).join(' ')
    || 'a declared dependency is unavailable.',
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
    const includesMissingPack = blocked.some(
      (entry) => missingPackRefsFromRunnability(entry).length > 0,
    );
    blocks.push({
      kind: 'born-blocked',
      headline: includesMissingPack
        ? `This pack added ${plural(blocked.length, 'recipe')} that cannot run until ${blocked.length === 1 ? 'its' : 'their'} missing dependencies are resolved:`
        : `This pack added ${plural(blocked.length, 'recipe')} that cannot run until a provider is connected:`,
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
 *  blocked-then-degraded order). Would-disable: the SURVIVING recipes that
 *  went blocked because this uninstall removed a required dependency — either
 *  their last provider or a pack they directly declare — never deleted (doc
 *  §1.6's forbidden destructive failure). The transition wire shape does not
 *  carry the cause, so the headline must remain honest for both.
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
      headline: `This disabled ${plural(disabled.length, 'recipe')} by removing a required dependency — they stay installed and recover when it is restored:`,
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
