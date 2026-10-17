/** A token-endpoint check proves renewal, independently of protected-resource access. */
import { isSavedOAuthApp, OAUTH_APP_ID, type OAuthAppIssuer, type SavedOAuthApp } from './foundational-oauth.js';
import { CONNECTION_NAME_REGEX } from './platform-record-id.js';

export type OAuthAppRenewalReason = 'origin_unknown' | 'secret_mismatch' | 'shared_grant_conflict' | 'missing_grant'
  | 'paused' | 'unavailable' | 'changed' | 'client_rejected' | 'grant_rejected' | 'persistence_failed' | 'interrupted' | 'not_selected' | 'not_checked';
export interface OAuthAppRenewalGrant {
  id: string; revision: string; label: string;
  connections: string[]; native_accounts: { platform: 'mail' | 'calendar'; slug: string }[];
  eligible: boolean; reason?: OAuthAppRenewalReason;
}
export interface OAuthAppRenewalReview {
  id: string; fingerprint: string; expires_at: number; app: SavedOAuthApp;
  grants: OAuthAppRenewalGrant[]; incomplete: boolean;
  latest?: OAuthAppRenewalVerification;
}
export interface OAuthAppRenewalResult extends OAuthAppRenewalGrant {
  status: 'passed' | 'failed' | 'unconfirmed'; reason?: OAuthAppRenewalReason;
  current: 'yes' | 'no' | 'unknown';
}
export interface OAuthAppRenewalVerification {
  id: string; issuer: OAuthAppIssuer; app_id: string; app_revision: number; app_label: string;
  status: 'checking' | 'completed'; started_at: number; finished_at?: number;
  results: OAuthAppRenewalResult[]; incomplete: boolean;
}
export type OAuthAppRenewalRequest =
  | { action: 'renewal_preview'; issuer: OAuthAppIssuer; id: string; expected_revision: number }
  | { action: 'renewal_retire'; review_id: string }
  | { action: 'renewal_run'; review_id: string; fingerprint: string; attempt_id: string; selected_ids: string[] }
  | { action: 'renewal_status'; id: string }
  | { action: 'renewal_status'; attempt_id: string };
export const OAUTH_APP_RENEWAL_ACTIONS = ['renewal_preview', 'renewal_retire', 'renewal_run', 'renewal_status'] as const;

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 2048 && !/[\x00-\x1f\x7f]/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const nonce = (v: unknown): boolean => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 8_640_000_000_000_000;
const jobId = (v: unknown): boolean => typeof v === 'string' && /^renewal-[a-f0-9-]{36}$/.test(v);
const reason = (v: unknown): boolean => typeof v === 'string' && ['origin_unknown', 'secret_mismatch', 'shared_grant_conflict', 'missing_grant', 'paused', 'unavailable', 'changed',
  'client_rejected', 'grant_rejected', 'persistence_failed', 'interrupted', 'not_selected', 'not_checked'].includes(v);
const grant = (v: unknown): boolean => record(v) && hash(v.id) && hash(v.revision) && text(v.label) && typeof v.eligible === 'boolean'
  && Array.isArray(v.connections) && v.connections.length <= 256 && v.connections.every(n => typeof n === 'string' && CONNECTION_NAME_REGEX.test(n))
  && new Set(v.connections).size === v.connections.length && Array.isArray(v.native_accounts) && v.native_accounts.length <= 256
  && v.native_accounts.every(a => record(a) && (a.platform === 'mail' || a.platform === 'calendar') && typeof a.slug === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(a.slug))
  && v.connections.length + v.native_accounts.length > 0 && (v.reason === undefined || reason(v.reason));
export const isOAuthAppRenewalVerification = (v: unknown): v is OAuthAppRenewalVerification => record(v) && jobId(v.id)
  && (v.issuer === 'google' || v.issuer === 'microsoft') && typeof v.app_id === 'string' && OAUTH_APP_ID.test(v.app_id)
  && text(v.app_label) && time(v.app_revision) && v.app_revision >= 1 && time(v.started_at) && typeof v.incomplete === 'boolean'
  && (v.status === 'checking' ? v.finished_at === undefined : v.status === 'completed' && time(v.finished_at) && v.finished_at >= v.started_at)
  && Array.isArray(v.results) && v.results.length > 0 && v.results.length <= 32 && new Set(v.results.map(r => record(r) ? r.id : null)).size === v.results.length
  && v.results.every(r => grant(r) && record(r) && (r.current === 'yes' || r.current === 'no' || r.current === 'unknown')
    && (r.status === 'passed' ? r.eligible === true && r.reason === undefined : (r.status === 'failed' || r.status === 'unconfirmed') && reason(r.reason))
    && (v.status !== 'completed' || r.reason !== 'not_checked'));
export const isOAuthAppRenewalReview = (v: unknown): v is OAuthAppRenewalReview => record(v) && nonce(v.id) && hash(v.fingerprint)
  && time(v.expires_at) && isSavedOAuthApp(v.app) && typeof v.incomplete === 'boolean' && Array.isArray(v.grants) && v.grants.length <= 32
  && new Set(v.grants.map(g => record(g) ? g.id : null)).size === v.grants.length && v.grants.every(g => grant(g) && record(g)
    && (g.eligible ? g.reason === undefined : typeof g.reason === 'string' && ['origin_unknown', 'secret_mismatch', 'shared_grant_conflict', 'missing_grant', 'paused', 'unavailable'].includes(g.reason)))
  && (v.latest === undefined || isOAuthAppRenewalVerification(v.latest) && v.latest.issuer === v.app.issuer && v.latest.app_id === v.app.id);
export const isOAuthAppRenewalRequest = (v: unknown): v is OAuthAppRenewalRequest => record(v) && (
  v.action === 'renewal_preview' && (v.issuer === 'google' || v.issuer === 'microsoft') && typeof v.id === 'string' && OAUTH_APP_ID.test(v.id) && time(v.expected_revision) && v.expected_revision >= 1
  || v.action === 'renewal_retire' && nonce(v.review_id) || v.action === 'renewal_status' && (jobId(v.id) && v.attempt_id === undefined || nonce(v.attempt_id) && v.id === undefined)
  || v.action === 'renewal_run' && nonce(v.review_id) && hash(v.fingerprint) && nonce(v.attempt_id)
    && Array.isArray(v.selected_ids) && v.selected_ids.length > 0 && v.selected_ids.length <= 32 && v.selected_ids.every(hash)
    && new Set(v.selected_ids).size === v.selected_ids.length);
