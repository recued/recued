/** Retained local observations. History reads never check vendor access. */
import { CONNECTION_NAME_REGEX } from './platform-record-id.js';
import { isAuthenticationAccessVerification, type AuthenticationAccessVerification } from './authentication-access-verification.js';
import { isOAuthAppRenewalVerification, type OAuthAppRenewalVerification } from './oauth-app-renewal.js';
import { isAuthenticationRepairWorklist, type AuthenticationRepairGroup, type AuthenticationRepairTarget } from './authentication-repair-worklist.js';

export type AuthenticationIncidentScope = { kind: 'all' } | { kind: 'group'; id: string } | AuthenticationRepairTarget;
/** Stable field order and no unrelated RPC fields in cursors or responses. */
export const authenticationIncidentScope = (scope: AuthenticationIncidentScope): AuthenticationIncidentScope => {
  switch (scope.kind) {
    case 'all': return { kind: 'all' };
    case 'oauth_apps': return { kind: 'oauth_apps' };
    case 'group': return { kind: 'group', id: scope.id };
    case 'connection': return { kind: 'connection', name: scope.name };
    case 'collection': return { kind: 'collection', platform: scope.platform, slug: scope.slug };
    case 'file_source': return { kind: 'file_source', source_id: scope.source_id };
  }
};
export type AuthenticationIncidentLevel = 'review' | 'rejected' | 'expiry_30' | 'expiry_7' | 'expiry_passed';
export type AuthenticationIncidentRetirement = 'authentication_changed' | 'connection_removed' | 'use_removed_or_changed' | 'expiry_changed_or_removed';
export interface AuthenticationIncidentEvent {
  kind: 'opened' | 'recorded' | 'changed' | 'awaiting_confirmation' | 'recovered' | 'retired';
  at: number;
  level: AuthenticationIncidentLevel;
}
export interface AuthenticationIncident {
  id: string;
  status: 'open' | 'recovered' | 'retired';
  started_at: number;
  /** Older closed alert state did not retain the last actual problem time. */
  last_problem_at?: number;
  /** Earlier alert state can supply dates, but cannot invent earlier events. */
  history_started_at: number;
  ended_at?: number;
  /** Actual successful operation clocks, when retained for every failed use. */
  recovery_evidence?: { earliest_at: number; latest_at: number };
  retirement_reason?: AuthenticationIncidentRetirement;
  currently_reported: boolean;
  level: AuthenticationIncidentLevel;
  /** Bounded union of known affected uses. This is historical, not live status. */
  group: AuthenticationRepairGroup;
  events: AuthenticationIncidentEvent[];
  events_truncated: boolean;
  details_truncated: boolean;
}
export interface AuthenticationIncidentHistoryQuery {
  scope: AuthenticationIncidentScope;
  cursor?: string;
  limit?: number;
  /** Older clients cannot render renewal rows in the mixed order. */
  include_renewals?: boolean;
}
export interface AuthenticationRenewalHistory extends OAuthAppRenewalVerification {
  /** Import time can be later than the original check. No earlier ordering is inferred. */
  history_started_at: number;
  /** Related account/file references are historical and may be incomplete. */
  references_incomplete?: boolean;
}
export interface AuthenticationIncidentHistoryPage {
  scope: AuthenticationIncidentScope;
  observed_at: number;
  incidents: AuthenticationIncident[];
  /** Added by servers that retain owner repair receipts. Order covers both lists. */
  repairs?: AuthenticationRepairAction[];
  /** Explicit access checks, kept separate from repair apply and recovery. */
  verifications?: AuthenticationAccessVerification[];
  /** Present only when requested from a server that retains token-renewal history. */
  renewals?: AuthenticationRenewalHistory[];
  order?: string[];
  next_cursor?: string;
  retention_days: number;
}
export type AuthenticationRepairActionKind = 'reauthorize' | 'switch_oauth_app' | 'switch_authentication' | 'rotate_secret' | 'replace_credentials' | 'change_permissions';
export interface AuthenticationRepairMethod {
  type: 'direct_oauth' | 'broker' | 'other' | 'unknown';
  app_id?: string;
  broker_profile_id?: string;
  broker_account_id?: string;
  label?: string;
  connection_name?: string;
}
export type AuthenticationRepairFailure = 'access_failed' | 'changed' | 'interrupted' | 'locked' | 'server_error' | 'inconclusive' | 'unreachable';
/** A local apply receipt. Applied never means that subsequent work recovered. */
export interface AuthenticationRepairAction {
  access_verification?: AuthenticationAccessVerification;
  id: string;
  action: AuthenticationRepairActionKind;
  status: 'checking' | 'applied' | 'failed';
  started_at: number;
  finished_at?: number;
  reason?: AuthenticationRepairFailure;
  from?: AuthenticationRepairMethod;
  to?: AuthenticationRepairMethod;
  restart_required?: boolean;
  /** Every associated incident recorded later successful operations. No causal attribution. */
  recovery_confirmed_at?: number;
  targets: AuthenticationRepairTarget[];
  targets_truncated: boolean;
  /** Exact open incidents associated when the apply attempt was reserved. */
  incidents: { id: string; group_id: string; label: string }[];
  incidents_truncated: boolean;
}
export type AuthenticationIncidentHistoryCaller = (query: AuthenticationIncidentHistoryQuery) => Promise<AuthenticationIncidentHistoryPage>;

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 2048 && !/[\x00-\x1f\x7f]/.test(v);
const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 8_640_000_000_000_000;
const level = (v: unknown): boolean => typeof v === 'string' && ['review', 'rejected', 'expiry_30', 'expiry_7', 'expiry_passed'].includes(v);
const cursor = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(v);
const method = (v: unknown): boolean => record(v) && typeof v.type === 'string' && ['direct_oauth', 'broker', 'other', 'unknown'].includes(v.type)
  && (v.label === undefined || text(v.label)) && (v.connection_name === undefined || typeof v.connection_name === 'string' && CONNECTION_NAME_REGEX.test(v.connection_name))
  && (v.app_id === undefined || v.type === 'direct_oauth' && text(v.app_id))
  && (v.broker_account_id === undefined || v.type === 'broker' && text(v.broker_account_id))
  && (v.broker_profile_id === undefined || v.type === 'broker' && text(v.broker_profile_id));
export const isAuthenticationRepairAction = (v: unknown): v is AuthenticationRepairAction => record(v)
  && (v.access_verification === undefined || isAuthenticationAccessVerification(v.access_verification)
    && v.access_verification.selection.kind === 'repair' && v.access_verification.selection.id === v.id)
  && typeof v.id === 'string' && /^repair-[a-f0-9]{64}$/.test(v.id)
  && typeof v.action === 'string' && ['reauthorize', 'switch_oauth_app', 'switch_authentication', 'rotate_secret', 'replace_credentials', 'change_permissions'].includes(v.action)
  && time(v.started_at) && (v.from === undefined || method(v.from)) && (v.to === undefined || method(v.to))
  && (v.recovery_confirmed_at === undefined || v.status === 'applied' && time(v.recovery_confirmed_at) && time(v.finished_at)
    && v.recovery_confirmed_at > v.finished_at && Array.isArray(v.incidents) && v.incidents.length > 0 && v.incidents_truncated === false)
  && (v.status === 'checking' ? v.finished_at === undefined && v.reason === undefined && v.restart_required === undefined
    : (v.status === 'applied' || v.status === 'failed') && time(v.finished_at) && v.finished_at >= v.started_at
      && (v.status === 'applied' ? v.reason === undefined && (v.restart_required === undefined || typeof v.restart_required === 'boolean')
        : v.restart_required === undefined && typeof v.reason === 'string' && ['access_failed', 'changed', 'interrupted', 'locked', 'server_error', 'inconclusive', 'unreachable'].includes(v.reason)))
  && typeof v.targets_truncated === 'boolean' && Array.isArray(v.targets) && v.targets.length > 0 && v.targets.length <= 64
  && v.targets.every(t => isAuthenticationIncidentScope(t) && t.kind !== 'all' && t.kind !== 'group')
  && typeof v.incidents_truncated === 'boolean' && Array.isArray(v.incidents) && v.incidents.length <= 64
  && new Set(v.incidents.map(i => record(i) ? i.id : null)).size === v.incidents.length
  && v.incidents.every(i => record(i) && typeof i.id === 'string' && /^[a-f0-9-]{36}$/.test(i.id)
    && typeof i.group_id === 'string' && /^[a-f0-9]{64}$/.test(i.group_id) && text(i.label));
export const isAuthenticationIncidentScope = (v: unknown): v is AuthenticationIncidentScope => record(v) && (
  v.kind === 'all' || v.kind === 'oauth_apps'
  || v.kind === 'group' && typeof v.id === 'string' && /^[a-f0-9]{64}$/.test(v.id)
  || v.kind === 'connection' && typeof v.name === 'string' && CONNECTION_NAME_REGEX.test(v.name)
  || v.kind === 'file_source' && text(v.source_id)
  || v.kind === 'collection' && (v.platform === 'mail' || v.platform === 'calendar') && text(v.slug));
export const isAuthenticationIncidentHistoryQuery = (v: unknown): v is AuthenticationIncidentHistoryQuery => record(v)
  && isAuthenticationIncidentScope(v.scope) && (v.cursor === undefined || cursor(v.cursor))
  && (v.include_renewals === undefined || typeof v.include_renewals === 'boolean')
  && (v.limit === undefined || typeof v.limit === 'number' && Number.isInteger(v.limit) && v.limit >= 1 && v.limit <= 50);
const validEvents = (events: unknown, status: string, reported: boolean, since: number, currentLevel: unknown, ended: unknown): boolean => {
  if (!Array.isArray(events) || !events.length || events.length > 32) return false;
  let at = since; let kind: unknown; let lastLevel: unknown;
  for (const [index, event] of events.entries()) {
    if (!record(event) || typeof event.kind !== 'string' || !time(event.at) || event.at < at || !level(event.level)
      || !['opened', 'recorded', 'changed', 'awaiting_confirmation', 'recovered', 'retired'].includes(event.kind)) return false;
    if (index === 0 ? event.kind !== 'opened' && event.kind !== 'recorded' : event.kind === 'opened' || event.kind === 'recorded') return false;
    if ((event.kind === 'recovered' || event.kind === 'retired') && index !== events.length - 1) return false;
    at = event.at; kind = event.kind; lastLevel = event.level;
  }
  if (lastLevel !== currentLevel) return false;
  if (status === 'open') return kind === 'changed' || kind === 'recorded' || (reported ? kind === 'opened' : kind === 'awaiting_confirmation');
  // Importing a closed legacy alert records its known state after the fact.
  return kind === status ? time(ended) && at <= ended : kind === 'recorded' && events.length === 1;
};
export const isAuthenticationRenewalHistory = (v: unknown): v is AuthenticationRenewalHistory => isOAuthAppRenewalVerification(v)
  && record(v) && time(v.history_started_at) && v.history_started_at >= v.started_at
  && (v.references_incomplete === undefined || typeof v.references_incomplete === 'boolean');
const validRepairs = (incidents: unknown[], repairs: unknown, order: unknown, verifications: unknown, renewals: unknown): boolean => {
  if (repairs === undefined && order === undefined && verifications === undefined && renewals === undefined) return true;
  const checks = verifications ?? [];
  const tokens = renewals ?? [];
  if (!Array.isArray(checks) || !checks.every(isAuthenticationAccessVerification)
    || !Array.isArray(tokens) || !tokens.every(isAuthenticationRenewalHistory)
    || !Array.isArray(repairs) || !repairs.every(isAuthenticationRepairAction) || incidents.length + repairs.length + checks.length + tokens.length > 50
    || !Array.isArray(order) || order.length !== incidents.length + repairs.length + checks.length + tokens.length || new Set(order).size !== order.length) return false;
  const ids = [...incidents, ...repairs, ...checks, ...tokens].map(row => record(row) ? row.id : null);
  return order.every(id => typeof id === 'string' && ids.includes(id)) && repairs.every(repair => repair.recovery_confirmed_at === undefined
    || repair.incidents.every(link => {
      const incident = incidents.find(i => record(i) && i.id === link.id);
      return incident === undefined || record(incident) && incident.status === 'recovered' && record(incident.recovery_evidence)
        && time(incident.recovery_evidence.earliest_at) && time(incident.recovery_evidence.latest_at)
        && incident.recovery_evidence.earliest_at > repair.finished_at! && incident.recovery_evidence.latest_at <= repair.recovery_confirmed_at!;
    }));
};
export const isAuthenticationIncidentHistoryPage = (v: unknown): v is AuthenticationIncidentHistoryPage => record(v)
  && isAuthenticationIncidentScope(v.scope) && time(v.observed_at) && v.retention_days === 90
  && (v.next_cursor === undefined || cursor(v.next_cursor)) && Array.isArray(v.incidents) && v.incidents.length <= 50
  && new Set(v.incidents.map(i => record(i) ? i.id : null)).size === v.incidents.length
  && validRepairs(v.incidents, v.repairs, v.order, v.verifications, v.renewals)
  && v.incidents.every(i => record(i) && typeof i.id === 'string' && /^[a-f0-9-]{36}$/.test(i.id)
    && typeof i.status === 'string' && ['open', 'recovered', 'retired'].includes(i.status) && time(i.started_at)
    && (i.last_problem_at === undefined || time(i.last_problem_at) && i.last_problem_at >= i.started_at) && time(i.history_started_at) && level(i.level)
    && typeof i.currently_reported === 'boolean' && (i.status === 'open' || i.currently_reported === false)
    && (i.recovery_evidence === undefined || i.status === 'recovered' && record(i.recovery_evidence)
      && time(i.recovery_evidence.earliest_at) && time(i.recovery_evidence.latest_at) && time(i.ended_at)
      && i.recovery_evidence.earliest_at > i.started_at && i.recovery_evidence.earliest_at <= i.recovery_evidence.latest_at && i.recovery_evidence.latest_at <= i.ended_at)
    && (i.status === 'open' ? i.ended_at === undefined && i.retirement_reason === undefined
      : time(i.ended_at) && i.ended_at >= i.started_at && (i.last_problem_at === undefined || i.last_problem_at <= i.ended_at) && (i.status === 'recovered' ? i.retirement_reason === undefined
        : typeof i.retirement_reason === 'string' && ['authentication_changed', 'connection_removed', 'use_removed_or_changed', 'expiry_changed_or_removed'].includes(i.retirement_reason)))
    && typeof i.events_truncated === 'boolean' && typeof i.details_truncated === 'boolean'
    && isAuthenticationRepairWorklist({ observed_at: v.observed_at, groups: [i.group], unavailable: [] })
    && validEvents(i.events, i.status, i.currently_reported, i.history_started_at, i.level, i.ended_at));
