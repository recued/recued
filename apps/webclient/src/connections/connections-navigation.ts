/** Typed hierarchical addresses for the Connections workspace. */

import {
  hierarchicalAddress,
  hierarchicalLevel,
  type HierarchicalAddress,
} from '../shell/hierarchical-navigation.js';
import { CONNECTION_NAME_REGEX, OAUTH_APP_ID, isAuthenticationIncidentScope, isAuthenticationAccessSelection,
  authenticationIncidentHistoryFilters, isAuthenticationIncidentHistoryFilters,
  type AuthenticationIncidentScope, type AuthenticationIncidentHistoryFilters, type AuthenticationAccessSelection, type OAuthAppIssuer } from '@recued/contracts';
import type { ShellRoute } from '../shell/route.js';
import { PACK_PERMISSION_REPAIR_ID } from '../settings/pack-permission-repair.js';

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

export const connectionsOAuthAppsAddress = (): HierarchicalAddress => hierarchicalAddress(
  'connections', hierarchicalLevel('connections-lane:others', 'others'), hierarchicalLevel('connections-flow:oauth-apps', 'oauth-apps'),
);
export const parseConnectionsOAuthApps = (segments: readonly string[]): boolean =>
  segments.length === 2 && segments[0] === 'others' && segments[1] === 'oauth-apps';

export interface ConnectionOAuthAppReview { issuer: OAuthAppIssuer; id: string; view: 'usage' | 'renewal' }
/** A destination identifies a saved app. Its current metadata is read on arrival. */
export const connectionsOAuthAppAddress = (app: ConnectionOAuthAppReview): HierarchicalAddress => hierarchicalAddress(
  'connections', hierarchicalLevel('connections-lane:others', 'others'), hierarchicalLevel('connections-flow:oauth-apps', 'oauth-apps'),
  hierarchicalLevel('connections-app-issuer:' + app.issuer, app.issuer), hierarchicalLevel('connections-app:' + app.id, app.id),
  hierarchicalLevel('connections-app-view:' + app.view, app.view),
);
export const parseConnectionsOAuthApp = (segments: readonly string[]): ConnectionOAuthAppReview | null =>
  segments.length === 5 && segments[0] === 'others' && segments[1] === 'oauth-apps'
    && (segments[2] === 'google' || segments[2] === 'microsoft') && OAUTH_APP_ID.test(segments[3] ?? '')
    && (segments[4] === 'usage' || segments[4] === 'renewal')
    ? { issuer: segments[2], id: segments[3]!, view: segments[4] } : null;

export const connectionsAccountAuthenticationAddress = (platform: 'mail' | 'calendar', slug: string): HierarchicalAddress => hierarchicalAddress(
  'connections', hierarchicalLevel('connections-lane:' + platform, platform), hierarchicalLevel('connections-account:' + slug, slug),
  hierarchicalLevel('connections-account-action:manage-authentication', 'manage-authentication'),
);
export const parseConnectionsAccountAuthentication = (segments: readonly string[]): { platform: 'mail' | 'calendar'; slug: string } | null =>
  segments.length === 3 && (segments[0] === 'mail' || segments[0] === 'calendar')
    && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(segments[1] ?? '') && segments[2] === 'manage-authentication'
    ? { platform: segments[0], slug: segments[1]! } : null;

/** Non-secret return context only. It cannot select credentials or grant consent. */
export const connectionsRenewalRepairReturn = (hash: string, issuer: OAuthAppIssuer, id: string): string =>
  hash + '/from-renewal/' + issuer + '/' + encodeURIComponent(id);
export const parseConnectionsRenewalRepairReturn = (segments: readonly string[]): { segments: readonly string[]; app: ConnectionOAuthAppReview } | null => {
  if (segments.at(-3) !== 'from-renewal') return null;
  const issuer = segments.at(-2); const id = segments.at(-1); const base = segments.slice(0, -3);
  if ((issuer !== 'google' && issuer !== 'microsoft') || !id || !OAUTH_APP_ID.test(id)) return null;
  const app = parseConnectionsOAuthApp(base);
  if (!parseConnectionsReviewAccess(base) && !parseConnectionsAccountAuthentication(base)
    && !(app?.view === 'usage' && app.issuer === issuer && app.id === id)) return null;
  return { segments: base, app: { issuer, id, view: 'renewal' } };
};

/** Opaque historical context only; neither a consent request nor proof of repair. */
export interface ConnectionAccessResultReference { verification_id: string; target_id: string }
export const isConnectionAccessResultReference = (value: unknown): value is ConnectionAccessResultReference =>
  typeof value === 'object' && value !== null && 'verification_id' in value && 'target_id' in value
  && isAuthenticationAccessSelection({ kind: 'verification', id: value.verification_id })
  && typeof value.target_id === 'string' && /^[a-f0-9]{64}$/.test(value.target_id);
export const connectionsAccessResultAddress = (reference: ConnectionAccessResultReference): HierarchicalAddress => hierarchicalAddress(
  'connections', hierarchicalLevel('connections-lane:others', 'others'), hierarchicalLevel('connections-flow:access-result', 'access-result'),
  hierarchicalLevel('connections-access-result:' + reference.verification_id, reference.verification_id),
  hierarchicalLevel('connections-access-target:' + reference.target_id, reference.target_id),
);
export const parseConnectionsAccessResult = (segments: readonly string[]): ConnectionAccessResultReference | null => {
  const reference = { verification_id: segments[2], target_id: segments[3] };
  return segments.length === 4 && segments[0] === 'others' && segments[1] === 'access-result'
    && isConnectionAccessResultReference(reference) ? reference : null;
};

/** A saved-status destination for any receipt, including passed and running checks. */
export interface ConnectionAccessCheckReference { verification_id: string; view: 'result' | 'comparison'; target_id?: string }
export const isConnectionAccessCheckReference = (value: unknown): value is ConnectionAccessCheckReference =>
  typeof value === 'object' && value !== null && 'verification_id' in value && 'view' in value
  && isAuthenticationAccessSelection({ kind: 'verification', id: value.verification_id }) && (value.view === 'result' || value.view === 'comparison')
  && (!('target_id' in value) || value.target_id === undefined || typeof value.target_id === 'string' && /^[a-f0-9]{64}$/.test(value.target_id));
export const connectionsAccessCheckAddress = (reference: ConnectionAccessCheckReference): HierarchicalAddress => hierarchicalAddress(
  'connections', hierarchicalLevel('connections-lane:others', 'others'), hierarchicalLevel('connections-flow:access-check', 'access-check'),
  hierarchicalLevel('connections-access-check:' + reference.verification_id, reference.verification_id),
  ...(reference.target_id ? [hierarchicalLevel('connections-access-focus', 'target'), hierarchicalLevel('connections-access-target:' + reference.target_id, reference.target_id)] : []),
  ...(reference.view === 'comparison' ? [hierarchicalLevel('connections-access-view:comparison', 'compare')] : []),
);
export const parseConnectionsAccessCheck = (segments: readonly string[]): ConnectionAccessCheckReference | null => {
  if (segments[0] !== 'others' || segments[1] !== 'access-check') return null;
  const comparison = segments.at(-1) === 'compare'; const base = comparison ? segments.slice(0, -1) : segments;
  if (base.length !== 3 && !(base.length === 5 && base[3] === 'target')) return null;
  if (base.length === 5 && typeof base[4] !== 'string') return null;
  const reference = { verification_id: base[2], view: comparison ? 'comparison' : 'result', ...(base.length === 5 ? { target_id: base[4] } : {}) };
  return isConnectionAccessCheckReference(reference) ? reference : null;
};
export const connectionsAccessRepairReturn = (hash: string, reference: ConnectionAccessResultReference): string =>
  hash + '/from-access/' + reference.verification_id + '/' + reference.target_id;
export const parseConnectionsAccessRepairReturn = (segments: readonly string[]): { segments: readonly string[]; reference: ConnectionAccessResultReference } | null => {
  if (segments.at(-3) !== 'from-access') return null;
  const reference = { verification_id: segments.at(-2), target_id: segments.at(-1) }; const base = segments.slice(0, -3);
  if (!isConnectionAccessResultReference(reference) || !(base.length === 1 && base[0] === 'others')
    && !parseConnectionsReviewAccess(base) && !parseConnectionsAccountAuthentication(base) && !parseConnectionsFileAuthentication(base)
    && !parseConnectionsOAuthApps(base) && !parseConnectionsOAuthApp(base)) return null;
  return { segments: base, reference };
};

const parseIncidentHistoryScope = (segments: readonly string[]): AuthenticationIncidentScope | null => {
  if (segments[0] !== 'others' || segments[1] !== 'incident-history') return null;
  const kind = segments[2];
  const scope = segments.length === 2 ? { kind: 'all' }
    : kind === 'oauth_apps' && segments.length === 3 ? { kind }
    : kind === 'connection' && segments.length === 4 ? { kind, name: segments[3] }
    : kind === 'group' && segments.length === 4 ? { kind, id: segments[3] }
    : kind === 'file_source' && segments.length === 4 ? { kind, source_id: segments[3] }
    : kind === 'collection' && segments.length === 5 ? { kind, platform: segments[3], slug: segments[4] } : null;
  return isAuthenticationIncidentScope(scope) ? scope : null;
};
export const connectionsIncidentHistoryAddress = (scope: AuthenticationIncidentScope, filters: AuthenticationIncidentHistoryFilters = {}): HierarchicalAddress => {
  const tail = scope.kind === 'all' ? [] : scope.kind === 'oauth_apps' ? [scope.kind] : scope.kind === 'collection' ? [scope.kind, scope.platform, scope.slug]
    : [scope.kind, scope.kind === 'group' ? scope.id : scope.kind === 'connection' ? scope.name : scope.source_id];
  const entries = Object.entries(authenticationIncidentHistoryFilters(filters));
  return hierarchicalAddress('connections', ...['others', 'incident-history', ...tail, ...(entries.length ? ['filter', ...entries.flatMap(([key, value]) => [key, value])] : [])]
    .map((segment, index) => hierarchicalLevel('connections-history:' + index + ':' + segment, segment)));
};
export const parseConnectionsIncidentHistoryView = (segments: readonly string[]): { scope: AuthenticationIncidentScope; filters: AuthenticationIncidentHistoryFilters } | null => {
  const kind = segments[2]; const length = kind === undefined || kind === 'filter' ? 2 : kind === 'oauth_apps' ? 3
    : kind === 'collection' ? 5 : kind === 'group' || kind === 'connection' || kind === 'file_source' ? 4 : 0;
  if (!length) return null;
  const scope = parseIncidentHistoryScope(segments.slice(0, length)); if (!scope) return null;
  const tail = segments.slice(length); if (!tail.length) return { scope, filters: {} };
  if (tail[0] !== 'filter' || tail.length < 3 || tail.length > 11 || tail.length % 2 !== 1) return null;
  const filters: Record<string, string> = {};
  for (let index = 1; index < tail.length; index += 2) {
    const key = tail[index]!; const value = tail[index + 1];
    if (!['search', 'type', 'outcome', 'from', 'through'].includes(key) || key in filters || typeof value !== 'string' || !value.trim()) return null;
    filters[key] = value;
  }
  return isAuthenticationIncidentHistoryFilters(filters) ? { scope, filters: authenticationIncidentHistoryFilters(filters) } : null;
};
export const parseConnectionsIncidentHistory = (segments: readonly string[]): AuthenticationIncidentScope | null => parseConnectionsIncidentHistoryView(segments)?.scope ?? null;

/** An opaque selection opens a local resource review; no URL or consent comes from navigation. */
export const connectionsVerifyAccessAddress = (selection: AuthenticationAccessSelection): HierarchicalAddress => hierarchicalAddress(
  'connections', hierarchicalLevel('connections-lane:others', 'others'), hierarchicalLevel('connections-flow:verify-access', 'verify-access'),
  hierarchicalLevel('connections-access-kind:' + selection.kind, selection.kind), hierarchicalLevel('connections-access:' + selection.id, selection.id),
);
export const parseConnectionsVerifyAccess = (segments: readonly string[]): AuthenticationAccessSelection | null => {
  if (segments.length !== 4 || segments[0] !== 'others' || segments[1] !== 'verify-access') return null;
  const selection = { kind: segments[2], id: segments[3] };
  return isAuthenticationAccessSelection(selection) ? selection : null;
};

export const parseConnectionsReviewAccess = (segments: readonly string[]): { name: string } | null =>
  segments.length === 4 && segments[0] === 'others' && segments[1] === 'review-access'
  && segments[2] === 'api' && CONNECTION_NAME_REGEX.test(segments[3] ?? '')
    ? { name: segments[3]! } : null;

export const connectionsFileAuthenticationAddress = (name: string): HierarchicalAddress => hierarchicalAddress(
  'connections', hierarchicalLevel('connections-lane:others', 'others'),
  hierarchicalLevel('connections-flow:switch-file-authentication', 'switch-file-authentication'),
  hierarchicalLevel('connections-kind:api', 'api'), hierarchicalLevel('connections-file-auth:' + name, name),
);
export const parseConnectionsFileAuthentication = (segments: readonly string[]): { name: string } | null =>
  segments.length === 4 && segments[0] === 'others' && segments[1] === 'switch-file-authentication'
    && segments[2] === 'api' && CONNECTION_NAME_REGEX.test(segments[3] ?? '') ? { name: segments[3]! } : null;

export const connectionsPermissionRepairAddress = (name: string, id: string): HierarchicalAddress => hierarchicalAddress(
  'connections', hierarchicalLevel('connections-lane:others', 'others'),
  hierarchicalLevel('connections-flow:repair-pack-permissions', 'repair-pack-permissions'),
  hierarchicalLevel('connections-kind:api', 'api'),
  hierarchicalLevel('connections-repair:' + name, name),
  hierarchicalLevel('connections-repair-context:' + id, id),
);
export const parseConnectionsPermissionRepair = (segments: readonly string[]): { name: string; id: string } | null =>
  segments.length === 5 && segments[0] === 'others' && segments[1] === 'repair-pack-permissions'
    && segments[2] === 'api' && CONNECTION_NAME_REGEX.test(segments[3] ?? '') && PACK_PERMISSION_REPAIR_ID.test(segments[4] ?? '')
    ? { name: segments[3]!, id: segments[4]! } : null;

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
