/** Runtime navigation adapter for the app projected from an installed pack. */

import {
  hierarchicalAddress,
  hierarchicalLevel,
  type HierarchicalAddress,
} from '../shell/hierarchical-navigation.js';
import type { ShellRoute } from '../shell/route.js';
import type { PackAppSurface } from './pack-app-model.js';

export type PacksAddress =
  | { readonly kind: 'list' }
  | {
      readonly kind: 'pack';
      readonly packSlug: string;
      readonly viewId: string | null;
      /** D-282 B5 — the record a LOOKUP was opened on, when the tail carries
       *  one. Null for a plain view address.
       *
       *  ⚠ A CLAIM OF INTENT, NEVER OF SAFETY. The parser has no roster, so it
       *  cannot know whether `viewId` names a view, a lookup, or an operation
       *  on this server today. The mount re-derives that from the installed
       *  surface and ignores the value unless the recipe is a lookup RIGHT NOW.
       *  See `mountPackAppView`. */
      readonly target: string | null;
    };

export const packsListAddress = (): HierarchicalAddress =>
  hierarchicalAddress('packs');

export const packDetailAddress = (packSlug: string): HierarchicalAddress =>
  hierarchicalAddress(
    'packs',
    hierarchicalLevel(`pack:${packSlug}`, packSlug),
  );

/** A generated read-only view is a place. Its recipe id is stable installed
 * identity, so it can hydrate by rerunning that proven-read-only recipe. */
export const packAppViewAddress = (
  packSlug: string,
  viewId: string,
): HierarchicalAddress => hierarchicalAddress(
  'packs',
  hierarchicalLevel(`pack:${packSlug}`, packSlug),
  hierarchicalLevel('pack-workspace:use', 'use'),
  hierarchicalLevel(`pack-view:${viewId}`, viewId),
);

/** A generated read-only LOOKUP, pointed at one record. Four segments, because
 * a detail page is a place: `#packs/rental-book/use/show-building/bld_42` is
 * bookmarkable, shareable, and a real Back step from the list.
 *
 * ⛔ LOOKUPS ONLY — never an operation. The extra segment makes an address
 * runnable, and an address that can replay a WRITE is a URL that acts. The
 * distinction is not made here (this function has no roster); it is made at
 * the mount, against `surface.lookups`, on every hydration. */
export const packAppLookupAddress = (
  packSlug: string,
  lookupId: string,
  target: string,
): HierarchicalAddress => hierarchicalAddress(
  'packs',
  hierarchicalLevel(`pack:${packSlug}`, packSlug),
  hierarchicalLevel('pack-workspace:use', 'use'),
  hierarchicalLevel(`pack-view:${lookupId}`, lookupId),
  hierarchicalLevel(`pack-detail:${target}`, target),
);

/** Unknown tails deliberately stop at the pack detail. Commands/results are not
 * reconstructed from URL segments, so a stale or invented tail cannot run one.
 *
 * ⚠ A FOURTH SEGMENT IS REPORTED, NOT HONOURED. `target` is read here and
 * carried; whether it may be used is decided later, from the installed roster.
 * That split is deliberate — the router must never be the thing that decides a
 * recipe is safe to run. */
export const parsePacksAddress = (route: ShellRoute): PacksAddress | null => {
  if (route.surface !== 'packs') return null;
  const packSlug = route.segments[0];
  if (packSlug === undefined || packSlug.trim().length === 0) {
    return { kind: 'list' };
  }
  const viewId = route.segments[1] === 'use'
    && typeof route.segments[2] === 'string'
    && route.segments[2]!.trim().length > 0
      ? route.segments[2]!
      : null;
  // A target without a view to hang it on is not an address — it is a truncated
  // one, and honouring half of it would run the wrong recipe.
  const target = viewId !== null
    && typeof route.segments[3] === 'string'
    && route.segments[3]!.trim().length > 0
      ? route.segments[3]!
      : null;
  return { kind: 'pack', packSlug, viewId, target };
};

export interface PackAppNavigationNode {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly address: HierarchicalAddress;
}

export interface PackAppNavigationProjection {
  readonly nodes: readonly PackAppNavigationNode[];
  readonly activeViewId: string | null;
  /** False only when a route requested a recipe that is no longer one of this
   * pack's proven read-only, zero-input views. */
  readonly requestedViewFound: boolean;
}

/** Absorb a runtime-derived PackAppSurface into the fixed navigation contract.
 * The adapter consumes only `views`: lookups and operations are commands, and
 * automations are lifecycle links. None become auto-hydrated navigation
 * nodes. */
export const projectPackAppNavigation = (
  packSlug: string,
  surface: PackAppSurface,
  requestedViewId?: string | null,
): PackAppNavigationProjection => {
  const nodes = surface.views.map((view) => ({
    id: view.recipe_id,
    label: view.name,
    description: view.description,
    address: packAppViewAddress(packSlug, view.recipe_id),
  }));
  const requested = requestedViewId ?? null;
  const matched = requested === null
    ? undefined
    : nodes.find((node) => node.id === requested);
  return {
    nodes,
    activeViewId: matched?.id ?? nodes[0]?.id ?? null,
    requestedViewFound: requested === null || matched !== undefined,
  };
};
