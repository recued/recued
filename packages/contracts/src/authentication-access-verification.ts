/** Explicit owner checks of saved authentication. Reads never verify writes or run workflows. */
import { CONNECTION_NAME_REGEX } from './platform-record-id.js';
import type { AuthenticationRepairTarget } from './authentication-repair-worklist.js';
import type { ManagedOAuthConnectionUse } from './managed-oauth.js';

export type AuthenticationAccessSelection = { kind: 'repair'; id: string } | { kind: 'group'; id: string } | { kind: 'renewal'; id: string }
  | { kind: 'verification'; id: string };
export type AuthenticationAccessCheckKind = 'api_read' | 'collection_read' | 'file_metadata' | 'file_download' | 'write_permissions';
export type AuthenticationAccessReason = 'not_checked' | 'unsupported' | 'resource_required' | 'access_rejected' | 'unavailable'
  | 'inconclusive' | 'changed' | 'interrupted' | 'permission_evidence_missing' | 'not_executed';
export interface AuthenticationAccessCheck {
  kind: AuthenticationAccessCheckKind;
  status: 'passed' | 'failed' | 'unconfirmed';
  reason?: AuthenticationAccessReason;
}
export interface AuthenticationAccessTarget {
  id: string;
  target: AuthenticationRepairTarget;
  label: string;
  /** Opaque server fingerprint; never contains a credential or resource URL. */
  authentication_revision: string;
  check: 'api_read' | 'collection_read' | 'file_metadata' | 'unsupported';
  base_url?: string;
  default_url?: string;
  file_connection?: { name: string; updated_at: number };
}
export interface AuthenticationAccessPreview {
  id: string; fingerprint: string; expires_at: number;
  selection: AuthenticationAccessSelection; label: string;
  targets: AuthenticationAccessTarget[]; targets_truncated: boolean;
  /** Dependency inventory only. These workflows are not executed by verification. */
  uses: ManagedOAuthConnectionUse[]; usage_available: boolean;
  /** Status-only response for an active source-related job; this is not a runnable review. */
  running?: AuthenticationAccessVerification;
}
export interface AuthenticationAccessResult {
  id: string; target: AuthenticationRepairTarget; label: string; authentication_revision: string;
  /** A later edit supersedes a result; a locked vault cannot confirm the revision. */
  current: 'yes' | 'no' | 'unknown';
  /** Fresh local navigation metadata. Recomputed on status reads; never proof of access. */
  file_connection?: { name: string; updated_at: number };
  checks: AuthenticationAccessCheck[];
}
export interface AuthenticationAccessVerification {
  id: string; selection: AuthenticationAccessSelection;
  status: 'checking' | 'completed'; started_at: number; finished_at?: number;
  results: AuthenticationAccessResult[]; targets_truncated: boolean;
  uses: ManagedOAuthConnectionUse[]; usage_available: boolean;
}
/** Writes are deliberately unperformed, so they never make an otherwise passed target retryable. */
export const authenticationAccessRecheckResults = (value: AuthenticationAccessVerification): AuthenticationAccessResult[] =>
  value.status === 'completed' ? value.results.filter(r => r.checks.some(c => c.kind !== 'write_permissions' && c.status !== 'passed')) : [];
export interface AuthenticationAccessChoice { target_id: string; url?: string; file_id?: string }
export type AuthenticationAccessRequest =
  | { action: 'authentication_access_retire'; review_id: string }
  | { action: 'authentication_access_preview'; selection: AuthenticationAccessSelection }
  | { action: 'authentication_access_run'; review_id: string; fingerprint: string; attempt_id: string; choices: AuthenticationAccessChoice[];
      /** Explicit reviewed subset. Required for rechecks; omitted by older full-review clients. */
      target_ids?: string[] }
  | { action: 'authentication_access_status'; id: string };
export type AuthenticationAccessResponse =
  | { action: 'authentication_access_retire' }
  | { action: 'authentication_access_preview'; preview: AuthenticationAccessPreview }
  | { action: 'authentication_access_run' | 'authentication_access_status'; verification: AuthenticationAccessVerification };
export type AuthenticationAccessCaller = (request: AuthenticationAccessRequest) => Promise<AuthenticationAccessResponse>;

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 2048 && !/[\x00-\x1f\x7f]/.test(v);
const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 8_640_000_000_000_000;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const nonce = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
const url = (v: unknown): v is string => { if (!text(v)) return false; try { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.hash; } catch { return false; } };
export const isAuthenticationAccessSelection = (v: unknown): v is AuthenticationAccessSelection => record(v)
  && (v.kind === 'group' && hash(v.id) || v.kind === 'repair' && typeof v.id === 'string' && /^repair-[a-f0-9]{64}$/.test(v.id)
    || v.kind === 'renewal' && typeof v.id === 'string' && /^renewal-[a-f0-9-]{36}$/.test(v.id)
    || v.kind === 'verification' && typeof v.id === 'string' && /^verify-[a-f0-9-]{36}$/.test(v.id));
const target = (v: unknown): boolean => record(v) && (v.kind === 'connection' && typeof v.name === 'string' && CONNECTION_NAME_REGEX.test(v.name)
  || v.kind === 'file_source' && text(v.source_id) || v.kind === 'collection' && (v.platform === 'mail' || v.platform === 'calendar') && text(v.slug) || v.kind === 'oauth_apps');
const uses = (v: unknown): boolean => Array.isArray(v) && v.length <= 256 && Array.from(v).every(u => record(u) && text(u.id) && text(u.label)
  && typeof u.kind === 'string' && ['pack', 'mail', 'calendar', 'file', 'recipe', 'dish', 'schedule'].includes(u.kind));
export const isAuthenticationAccessCheck = (v: unknown): v is AuthenticationAccessCheck => record(v)
  && typeof v.kind === 'string' && ['api_read', 'collection_read', 'file_metadata', 'file_download', 'write_permissions'].includes(v.kind)
  && (v.kind !== 'write_permissions' || v.status === 'unconfirmed')
  && (v.status === 'passed' ? v.reason === undefined : (v.status === 'failed' || v.status === 'unconfirmed')
    && typeof v.reason === 'string' && ['not_checked', 'unsupported', 'resource_required', 'access_rejected', 'unavailable', 'inconclusive', 'changed', 'interrupted', 'permission_evidence_missing', 'not_executed'].includes(v.reason));
export const isAuthenticationAccessPreview = (v: unknown): v is AuthenticationAccessPreview => record(v) && nonce(v.id) && hash(v.fingerprint)
  && time(v.expires_at) && isAuthenticationAccessSelection(v.selection) && text(v.label) && typeof v.targets_truncated === 'boolean'
  && (v.running === undefined || isAuthenticationAccessVerification(v.running) && v.running.status === 'checking'
    && v.running.selection.kind === v.selection.kind && v.running.selection.id === v.selection.id)
  && typeof v.usage_available === 'boolean' && uses(v.uses) && Array.isArray(v.targets) && v.targets.length > 0 && v.targets.length <= 32
  && new Set(v.targets.map(t => record(t) ? t.id : null)).size === v.targets.length && Array.from(v.targets).every(t => record(t) && hash(t.id)
    && target(t.target) && text(t.label) && hash(t.authentication_revision) && typeof t.check === 'string' && ['api_read', 'collection_read', 'file_metadata', 'unsupported'].includes(t.check)
    && record(t.target) && (t.check === 'unsupported' || t.check === 'api_read' && t.target.kind === 'connection'
      || t.check === 'collection_read' && t.target.kind === 'collection' || t.check === 'file_metadata' && t.target.kind === 'file_source')
    && (t.base_url === undefined || t.check === 'api_read' && url(t.base_url)) && (t.default_url === undefined || t.check === 'api_read' && url(t.default_url))
    && (t.file_connection === undefined || t.check === 'file_metadata' && record(t.file_connection)
      && typeof t.file_connection.name === 'string' && CONNECTION_NAME_REGEX.test(t.file_connection.name) && time(t.file_connection.updated_at)));
export const isAuthenticationAccessVerification = (v: unknown): v is AuthenticationAccessVerification => record(v)
  && typeof v.id === 'string' && /^verify-[a-f0-9-]{36}$/.test(v.id) && isAuthenticationAccessSelection(v.selection) && time(v.started_at)
  && (v.status === 'checking' ? v.finished_at === undefined : v.status === 'completed' && time(v.finished_at) && v.finished_at >= v.started_at)
  && typeof v.targets_truncated === 'boolean' && typeof v.usage_available === 'boolean' && uses(v.uses)
  && Array.isArray(v.results) && v.results.length > 0 && v.results.length <= 32 && new Set(v.results.map(r => record(r) ? r.id : null)).size === v.results.length
  && Array.from(v.results).every(r => record(r) && hash(r.id) && hash(r.authentication_revision) && target(r.target) && text(r.label)
    && (r.file_connection === undefined || record(r.target) && r.target.kind === 'file_source' && r.current === 'yes' && record(r.file_connection)
      && typeof r.file_connection.name === 'string' && CONNECTION_NAME_REGEX.test(r.file_connection.name) && time(r.file_connection.updated_at))
    && (r.current === 'yes' || r.current === 'no' || r.current === 'unknown') && Array.isArray(r.checks) && r.checks.length > 0 && r.checks.length <= 5
    && new Set(r.checks.map(c => record(c) ? c.kind : null)).size === r.checks.length && Array.from(r.checks).every(isAuthenticationAccessCheck)
    && (v.status !== 'completed' || r.checks.every(c => !record(c) || c.reason !== 'not_checked')));
export const isAuthenticationAccessRequest = (v: unknown): v is AuthenticationAccessRequest => record(v) && (
  v.action === 'authentication_access_retire' && nonce(v.review_id)
  || v.action === 'authentication_access_preview' && isAuthenticationAccessSelection(v.selection)
  || v.action === 'authentication_access_status' && typeof v.id === 'string' && /^verify-[a-f0-9-]{36}$/.test(v.id)
  || v.action === 'authentication_access_run' && nonce(v.review_id) && hash(v.fingerprint) && nonce(v.attempt_id)
    && (v.target_ids === undefined || Array.isArray(v.target_ids) && v.target_ids.length > 0 && v.target_ids.length <= 32
      && Array.from(v.target_ids).every(hash) && new Set(v.target_ids).size === v.target_ids.length)
    && Array.isArray(v.choices) && v.choices.length <= 32 && new Set(v.choices.map(c => record(c) ? c.target_id : null)).size === v.choices.length
    && Array.from(v.choices).every(c => record(c) && hash(c.target_id) && (c.url === undefined || typeof c.url === 'string' && c.url.length <= 4096 && !/[\x00-\x1f\x7f]/.test(c.url))
      && (c.file_id === undefined || text(c.file_id) && c.file_id.length <= 255)));
