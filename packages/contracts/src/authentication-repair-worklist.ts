/** Local observations only. Opening the worklist never performs vendor requests. */
import type { ManagedOAuthConnectionUse } from './managed-oauth.js';
import { isOAuthAppSecretExpiryDate } from './foundational-oauth.js';
import { isAuthenticationAccessVerification, type AuthenticationAccessVerification } from './authentication-access-verification.js';
import { isAuthenticationAccessSummary, authenticationAccessSummaryMatchesTargets, type AuthenticationAccessSummary } from './authentication-access-summary.js';

export type AuthenticationRepairIssueCode = 'credential_rejected' | 'access_unconfirmed' | 'source_check_failed'
  | 'binding_changed' | 'connection_missing' | 'app_missing' | 'secret_expiry';
export type AuthenticationRepairTarget =
  | { kind: 'connection'; name: string }
  | { kind: 'collection'; platform: 'mail' | 'calendar'; slug: string }
  | { kind: 'file_source'; source_id: string }
  | { kind: 'oauth_apps' };
export interface AuthenticationRepairIssue {
  id: string;
  code: AuthenticationRepairIssueCode;
  message: string;
  /** Time of the stored observation, not a fresh vendor access check. */
  observed_at?: number;
  secret_expires_on?: string;
}
export interface AuthenticationRepairGroup {
  access_verification?: AuthenticationAccessVerification;
  access_summary?: AuthenticationAccessSummary;
  id: string;
  kind: 'account' | 'app';
  label: string;
  authentication: 'direct_oauth' | 'broker' | 'other' | 'unknown';
  /** Exact local references; an email match alone never joins credentials. */
  connection_names: string[];
  issues: AuthenticationRepairIssue[];
  uses: ManagedOAuthConnectionUse[];
  usage_available: boolean;
  targets: AuthenticationRepairTarget[];
}
export interface AuthenticationRepairWorklist {
  observed_at: number;
  groups: AuthenticationRepairGroup[];
  /** Missing inventory is never represented as an empty, healthy list. */
  unavailable: string[];
}
export type AuthenticationRepairCaller = () => Promise<AuthenticationRepairWorklist>;

export const isAuthenticationRepairWorklist = (value: unknown): value is AuthenticationRepairWorklist => {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 2048 && !/[\x00-\x1f\x7f]/.test(v);
  const time = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 8_640_000_000_000_000;
  const id = (v: unknown): boolean => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const target = (v: unknown): boolean => record(v) && (v.kind === 'oauth_apps'
    || v.kind === 'connection' && text(v.name)
    || v.kind === 'file_source' && text(v.source_id)
    || v.kind === 'collection' && (v.platform === 'mail' || v.platform === 'calendar') && text(v.slug));
  const issue = (v: unknown): boolean => record(v) && id(v.id) && typeof v.code === 'string'
    && ['credential_rejected', 'access_unconfirmed', 'source_check_failed', 'binding_changed', 'connection_missing', 'app_missing', 'secret_expiry'].includes(v.code)
    && text(v.message) && (v.observed_at === undefined || time(v.observed_at))
    && (v.secret_expires_on === undefined || isOAuthAppSecretExpiryDate(v.secret_expires_on));
  return record(value) && time(value.observed_at) && Array.isArray(value.unavailable) && value.unavailable.length <= 16 && value.unavailable.every(text)
    && Array.isArray(value.groups) && value.groups.length <= 2048 && new Set(value.groups.map(g => record(g) ? g.id : null)).size === value.groups.length
    && value.groups.every(g => record(g) && id(g.id) && (g.kind === 'account' || g.kind === 'app') && text(g.label)
      && (g.access_verification === undefined || isAuthenticationAccessVerification(g.access_verification)
        && g.access_verification.selection.kind === 'group' && g.access_verification.selection.id === g.id)
      && typeof g.authentication === 'string' && ['direct_oauth', 'broker', 'other', 'unknown'].includes(g.authentication)
      && typeof g.usage_available === 'boolean' && Array.isArray(g.connection_names) && g.connection_names.length <= 512 && g.connection_names.every(text)
      && Array.isArray(g.issues) && g.issues.length <= 2048 && g.issues.every(issue)
      && Array.isArray(g.targets) && g.targets.length <= 2048 && g.targets.every(target)
      && (g.access_summary === undefined || isAuthenticationAccessSummary(g.access_summary)
        && g.access_summary.selection.kind === 'group' && g.access_summary.selection.id === g.id
        && authenticationAccessSummaryMatchesTargets(g.access_summary, g.targets))
      && Array.isArray(g.uses) && g.uses.length <= 10000 && g.uses.every(u => record(u) && typeof u.kind === 'string'
        && ['pack', 'mail', 'calendar', 'file', 'recipe', 'dish', 'schedule'].includes(u.kind) && text(u.id) && text(u.label)));
};
