/** D-322 §44 — an explicit, resumable Google consent reset. */
import { isSavedOAuthApp, type SavedOAuthApp } from './foundational-oauth.js';
import type { OAuthPermissionRequest } from './oauth-permission-consolidation.js';
import type { ManagedOAuthAccountIdentity } from './managed-oauth.js';

export const OAUTH_PERMISSION_CLEANUP_ACTIONS = ['prepare_permission_cleanup', 'pause_permission_cleanup',
  'authorize_permission_cleanup', 'review_permission_cleanup', 'apply_permission_cleanup',
  'refresh_permission_cleanup', 'restore_permission_cleanup', 'reset_permission_cleanup', 'cancel_permission_cleanup', 'restart_permission_cleanup', 'permission_cleanup_status'] as const;
export type OAuthPermissionCleanupTarget = ({ platform: 'mail' | 'calendar'; slug: string; provider: 'gmail' | 'gcal' }
  | { platform: 'api'; slug: string; provider: 'google_api'; display_name: string; verification_url: string })
  & { account: ManagedOAuthAccountIdentity };
type TargetRef = Pick<OAuthPermissionCleanupTarget, 'platform' | 'slug'>;
export interface OAuthPermissionCleanupJob {
  id: string; revision: number; issuer: 'google'; mode: 'cleanup' | 'restore';
  status: 'prepared' | 'stopping' | 'awaiting_reset' | 'awaiting_reconnect' | 'ready_to_apply' | 'applied' | 'restored' | 'cancelled';
  app: SavedOAuthApp; targets: readonly OAuthPermissionCleanupTarget[];
  selected_scopes: readonly string[]; requested_scopes: readonly string[]; required_scopes: readonly string[];
  reset_confirmation: 'not_confirmed' | 'owner_confirmed';
  /** Checks the new grant and resource access, not the vendor's consent page. */
  verification: 'not_checked' | 'fresh_grant_checked';
  updated_at: number; granted_scopes?: readonly string[]; review_expires_at?: number;
  verified_targets?: readonly TargetRef[];
  last_error?: string; restart_needed?: readonly { platform: 'mail' | 'calendar'; slug: string }[];
}
export interface OAuthPermissionCleanupAuthorization {
  id: string; job_id: string; revision: number; expires_at: number;
  app: SavedOAuthApp; requested_scopes: readonly string[];
  target: Pick<OAuthPermissionCleanupTarget, 'platform' | 'slug' | 'provider'>;
}
type Selection = Omit<Extract<OAuthPermissionRequest, { action: 'preview_permission_cleanup' }>, 'action'>;
type Revision = { id: string; expected_revision: number };
export type OAuthPermissionCleanupRequest =
  | ({ action: 'prepare_permission_cleanup'; api_verification_urls?: readonly { name: string; url: string }[] } & Selection)
  | ({ action: 'pause_permission_cleanup'; confirm_shared_access: true } & Revision)
  | ({ action: 'authorize_permission_cleanup'; reset_confirmed: boolean } & Revision)
  | ({ action: 'review_permission_cleanup'; authorization_id: string; code: string; redirect_uri: string } & Revision)
  | ({ action: 'refresh_permission_cleanup'; api_verification_urls?: readonly { name: string; url: string }[] } & Revision)
  | ({ action: 'apply_permission_cleanup' | 'restore_permission_cleanup' | 'reset_permission_cleanup' | 'cancel_permission_cleanup' | 'restart_permission_cleanup' } & Revision)
  | { action: 'permission_cleanup_status'; id?: string };

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const nonce = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 1;
const scopes = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 256 && new Set(v).size === v.length
  && v.every(s => typeof s === 'string' && s.length > 0 && s.length <= 2048 && !/[\s\x00-\x1f\x7f]/.test(s));
const target = (v: unknown): v is OAuthPermissionCleanupTarget => {
  if (!record(v) || !record(v.account)) return false;
  const { email } = v.account;
  return targetRef(v)
    && (v.platform === 'api' ? v.provider === 'google_api' && typeof v.display_name === 'string' && v.display_name.length > 0 && v.display_name.length <= 2048
      && !/[\x00-\x1f\x7f]/.test(v.display_name) && safeReadUrl(v.verification_url)
      : v.provider === (v.platform === 'mail' ? 'gmail' : 'gcal'))
    && v.account.status === 'known' && typeof v.account.account_id === 'string' && v.account.account_id.length > 0
    && v.account.account_id.length <= 2048 && !/[\x00-\x1f\x7f]/.test(v.account.account_id)
    && typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email);
};
const targetRef = (v: Record<string, unknown>): boolean => typeof v.slug === 'string'
  && (v.platform === 'api' ? /^[a-z0-9][a-z0-9-]{0,47}$/.test(v.slug)
    : ['mail', 'calendar'].includes(String(v.platform)) && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(v.slug));
const safeReadUrl = (v: unknown): boolean => {
  if (typeof v !== 'string' || v.length > 4096 || /[\x00-\x1f\x7f]/.test(v)) return false;
  try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !u.hash
    && ['sheets.googleapis.com', 'www.googleapis.com', 'gmail.googleapis.com'].includes(u.hostname)
    && ![...u.searchParams.keys()].some(k => /^(?:access_token|refresh_token|client_secret|api_key|key|token|authorization)$/i.test(k)); }
  catch { return false; }
};
export const isOAuthPermissionCleanupJob = (v: unknown): v is OAuthPermissionCleanupJob => {
  if (!record(v) || !nonce(v.id) || !integer(v.revision) || v.issuer !== 'google' || !['cleanup', 'restore'].includes(String(v.mode))
    || !['prepared', 'stopping', 'awaiting_reset', 'awaiting_reconnect', 'ready_to_apply', 'applied', 'restored', 'cancelled'].includes(String(v.status))
    || !isSavedOAuthApp(v.app) || v.app.issuer !== 'google' || !v.app.has_secret
    || !Array.isArray(v.targets) || !v.targets.length || v.targets.length > 16 || !v.targets.every(target)
    || !scopes(v.selected_scopes) || !v.selected_scopes.length || !scopes(v.requested_scopes) || !v.requested_scopes.length || !scopes(v.required_scopes)
    || !v.required_scopes.length && !v.targets.every(t => t.platform === 'api')
    || !['not_confirmed', 'owner_confirmed'].includes(String(v.reset_confirmation))
    || !['not_checked', 'fresh_grant_checked'].includes(String(v.verification)) || !integer(v.updated_at)
    || v.granted_scopes !== undefined && !scopes(v.granted_scopes)
    || v.review_expires_at !== undefined && !integer(v.review_expires_at)
    || v.last_error !== undefined && (typeof v.last_error !== 'string' || v.last_error.length > 2048 || /[\x00-\x1f\x7f]/.test(v.last_error))) return false;
  const targets = v.targets; const requested = v.requested_scopes; const required = v.required_scopes; const granted = v.granted_scopes;
  const checkedTargets = v.verified_targets;
  return new Set(targets.map(t => t.platform + ':' + t.slug)).size === targets.length
    && (v.status !== 'applied' || v.mode === 'cleanup') && (v.status !== 'restored' || v.mode === 'restore')
    && (v.status !== 'ready_to_apply' || integer(v.review_expires_at))
    && (v.verification !== 'fresh_grant_checked' || ['ready_to_apply', 'applied', 'restored'].includes(String(v.status)))
    && (checkedTargets === undefined || Array.isArray(checkedTargets) && checkedTargets.length <= targets.length
      && new Set(checkedTargets.map(t => record(t) ? String(t.platform) + ':' + String(t.slug) : '')).size === checkedTargets.length
      && checkedTargets.every(t => record(t) && targets.some(row => row.platform === t.platform && row.slug === t.slug)))
    && (v.mode !== 'cleanup' || v.selected_scopes.every(s => !requested.includes(s) && !required.includes(s)))
    && (!['ready_to_apply', 'applied', 'restored'].includes(String(v.status))
      || v.verification === 'fresh_grant_checked' && scopes(granted) && Array.isArray(checkedTargets) && checkedTargets.length === targets.length
        && (v.mode !== 'cleanup' || v.reset_confirmation === 'owner_confirmed' && v.selected_scopes.every(s => !granted.includes(s))))
    && (v.restart_needed === undefined || Array.isArray(v.restart_needed) && v.restart_needed.length <= 16
      && v.restart_needed.every(t => record(t) && t.platform !== 'api' && targets.some(row => row.platform === t.platform && row.slug === t.slug)));
};
export const isOAuthPermissionCleanupAuthorization = (v: unknown): v is OAuthPermissionCleanupAuthorization => record(v)
  && nonce(v.id) && nonce(v.job_id) && integer(v.revision) && integer(v.expires_at)
  && isSavedOAuthApp(v.app) && v.app.issuer === 'google' && v.app.has_secret && scopes(v.requested_scopes) && v.requested_scopes.length > 0
  && record(v.target) && targetRef(v.target)
  && v.target.provider === (v.target.platform === 'api' ? 'google_api' : v.target.platform === 'mail' ? 'gmail' : 'gcal');
