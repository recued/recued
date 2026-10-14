/** Typed hierarchical addresses for the Connections workspace. */

import {
  hierarchicalAddress,
  hierarchicalLevel,
  type HierarchicalAddress,
} from '../shell/hierarchical-navigation.js';
import { CONNECTION_NAME_REGEX } from '@recued/contracts';
import type { ShellRoute } from '../shell/route.js';

export const CONNECTIONS_TAB_IDS = [
  'mail',
  'calendar',
  'file',
  'others',
  'webhooks',
] as const;
export type ConnectionsTabId = (typeof CONNECTIONS_TAB_IDS)[number];

export const FOUNDATIONAL_CONNECTIONS_LANES = [
  'mail',
  'calendar',
  'file',
] as const;
export type FoundationalConnectionsLane =
  (typeof FOUNDATIONAL_CONNECTIONS_LANES)[number];

export const isConnectionsTabId = (
  value: unknown,
): value is ConnectionsTabId =>
  typeof value === 'string'
  && (CONNECTIONS_TAB_IDS as readonly string[]).includes(value);

export const isFoundationalConnectionsLane = (
  value: unknown,
): value is FoundationalConnectionsLane =>
  typeof value === 'string'
  && (FOUNDATIONAL_CONNECTIONS_LANES as readonly string[]).includes(value);

/** D-322 — resolve non-secret pack metadata locally, never an API URL from a route. */
export interface ConnectionEnrollmentPack { slug: string; slot?: string }

export type ConnectionsAddress =
  | {
      readonly kind: 'lane';
      readonly tab: ConnectionsTabId;
    }
  | {
      readonly kind: 'account';
      readonly lane: FoundationalConnectionsLane;
      readonly slug: string;
    }
  | {
      readonly kind: 'enroll';
      readonly vendor: string | null;
      readonly pack?: ConnectionEnrollmentPack;
    };

export const connectionsLaneAddress = (
  tab: ConnectionsTabId,
): HierarchicalAddress => hierarchicalAddress(
  'connections',
  hierarchicalLevel(`connections-lane:${tab}`, tab),
);

export const connectionsAccountAddress = (
  lane: FoundationalConnectionsLane,
  slug: string,
): HierarchicalAddress => hierarchicalAddress(
  'connections',
  hierarchicalLevel(`connections-lane:${lane}`, lane),
  hierarchicalLevel(`connections-account:${slug}`, slug),
);

export const connectionsEnrollAddress = (
  vendor?: string | null,
  pack?: ConnectionEnrollmentPack,
): HierarchicalAddress => hierarchicalAddress(
  'connections',
  hierarchicalLevel('connections-lane:others', 'others'),
  hierarchicalLevel('connections-flow:enroll', 'enroll'),
  ...(vendor === undefined || vendor === null || vendor.trim().length === 0
    ? []
    : [hierarchicalLevel(`connections-vendor:${vendor}`, vendor)]),
  ...(vendor && pack ? [
    hierarchicalLevel('connections-enrollment-source:pack', 'pack'),
    hierarchicalLevel(`connections-enrollment-pack:${pack.slug}`, pack.slug),
    ...(pack.slot ? [hierarchicalLevel(`connections-enrollment-slot:${pack.slot}`, pack.slot)] : []),
  ] : []),
);

/** D-322 §24 — a saved account review carries no scope, credential or API URL. */
export const connectionsReviewAccessAddress = (name: string): HierarchicalAddress => hierarchicalAddress(
  'connections',
  hierarchicalLevel('connections-lane:others', 'others'),
  hierarchicalLevel('connections-flow:review-access', 'review-access'),
  hierarchicalLevel('connections-kind:api', 'api'),
  hierarchicalLevel('connections-review:' + name, name),
);

export const parseConnectionsReviewAccess = (segments: readonly string[]): { name: string } | null =>
  segments.length === 4 && segments[0] === 'others' && segments[1] === 'review-access'
  && segments[2] === 'api' && CONNECTION_NAME_REGEX.test(segments[3] ?? '')
    ? { name: segments[3]! } : null;

/** Parse only durable workspace places. One-shot recovery/credential tails are
 * deliberately left to their authority-specific parsers and resolve to the
 * containing Apps & APIs lane here. */
export const parseConnectionsAddress = (
  route: ShellRoute,
): ConnectionsAddress | null => {
  if (route.surface !== 'connections') return null;
  const tab = isConnectionsTabId(route.segments[0])
    ? route.segments[0]
    : 'mail';
  const tail = route.segments[1];

  if (
    isFoundationalConnectionsLane(tab)
    && typeof tail === 'string'
    && tail.trim().length > 0
  ) {
    return { kind: 'account', lane: tab, slug: tail };
  }
  if (tab === 'others' && tail === 'enroll') {
    const vendor = route.segments[2];
    const slug = route.segments[3] === 'pack' ? route.segments[4] : undefined;
    const slot = route.segments[5];
    return {
      kind: 'enroll',
      vendor: typeof vendor === 'string' && vendor.trim().length > 0
        ? vendor
        : null,
      ...(typeof slug === 'string' && slug.trim() ? { pack: { slug,
        ...(typeof slot === 'string' && slot.trim() ? { slot } : {}) } } : {}),
    };
  }
  return { kind: 'lane', tab };
};

export const connectionsAddressSelection = (
  address: ConnectionsAddress | null | undefined,
): {
  readonly tab: ConnectionsTabId;
  readonly detailSlug: string | null;
  readonly enrollVendor: string | null;
} => {
  if (address?.kind === 'account') {
    return {
      tab: address.lane,
      detailSlug: address.slug,
      enrollVendor: null,
    };
  }
  if (address?.kind === 'enroll') {
    return {
      tab: 'others',
      detailSlug: null,
      enrollVendor: address.vendor,
    };
  }
  return {
    tab: address?.tab ?? 'mail',
    detailSlug: null,
    enrollVendor: null,
  };
};
