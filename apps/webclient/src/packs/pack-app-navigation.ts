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

/** Unknown tails deliberately stop at the pack detail. Commands/results are not
 * reconstructed from URL segments, so a stale or invented tail cannot run one. */
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
  return { kind: 'pack', packSlug, viewId };
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
