/** D-322 §43 — local permission inventory and a read-only cleanup preview. */
import type { OAuthAppIssuer } from './foundational-oauth.js';
import type { ManagedOAuthConnectionUse } from './managed-oauth.js';

export interface OAuthPermissionRequirement { scope: string; uses: readonly ManagedOAuthConnectionUse[] }
export interface OAuthPermissionNeeds {
  requirements: readonly OAuthPermissionRequirement[]; complete: boolean; warnings: readonly string[];
  uses?: readonly ManagedOAuthConnectionUse[];
}
export interface OAuthPermissionScope {
  scope: string; status: 'required' | 'unused_locally' | 'unknown';
  evidence: 'recorded_grant' | 'requested_only' | 'requirement_only';
  required_by: readonly ManagedOAuthConnectionUse[];
}
export interface OAuthPermissionGroup {
  id: string; app_key: string; app_label: string; issuer: OAuthAppIssuer | 'other';
  saved_app_id?: string; client_id?: string;
  authentication: 'direct_oauth' | 'broker'; account_label: string;
  connection_names: readonly string[];
  /** Non-secret service addresses used to choose protected read checks. */
  api_resources?: readonly { name: string; base_url: string }[];
  native_accounts: readonly { platform: 'mail' | 'calendar'; slug: string }[];
  uses: readonly ManagedOAuthConnectionUse[]; requirements_complete: boolean; grants_known: boolean;
  scopes: readonly OAuthPermissionScope[]; required_scopes: readonly string[]; warnings: readonly string[];
}
export interface OAuthPermissionInventory {
  fingerprint: string; observed_at: number;
  filter?: { issuer: OAuthAppIssuer; app_id: string };
  groups: readonly OAuthPermissionGroup[]; unavailable: readonly string[];
}
export interface OAuthPermissionCleanupPreview {
  inventory_fingerprint: string; group_id: string;
  selected_scopes: readonly string[]; retained_scopes: readonly string[]; required_scopes: readonly string[];
  connection_names: readonly string[]; uses: readonly ManagedOAuthConnectionUse[];
  /** Same app does not prove the same grant; these uses may also be affected. */
  related_group_ids: readonly string[];
  method: 'google_revoke_reconnect' | 'microsoft_consent_review' | 'vendor_consent_review';
  warnings: readonly string[];
  /** Previewing never changes provider consent, credentials or scope history. */
  mutation: false; verification: 'not_checked';
}
export type OAuthPermissionRequest =
  | { action: 'permission_inventory'; issuer?: OAuthAppIssuer; app_id?: string }
  | { action: 'preview_permission_cleanup'; inventory_fingerprint: string; group_id: string; selected_scopes: readonly string[];
      filter?: { issuer: OAuthAppIssuer; app_id: string } };

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 2048 && !/[\x00-\x1f\x7f]/.test(v);
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const texts = (v: unknown, max = 256): v is string[] => Array.isArray(v) && v.length <= max && v.every(text) && new Set(v).size === v.length;
const disjoint = (a: readonly string[], b: readonly string[]): boolean => a.every(scope => !b.includes(scope));
const uses = (v: unknown): v is ManagedOAuthConnectionUse[] => Array.isArray(v) && v.length <= 10000 && v.every(u => record(u)
  && ['pack', 'mail', 'calendar', 'file', 'recipe', 'dish', 'schedule'].includes(String(u.kind)) && text(u.id) && text(u.label)
  && (u.may_use === undefined || u.may_use === true) && (u.paused === undefined || u.paused === true));
const group = (v: unknown): v is OAuthPermissionGroup => record(v) && digest(v.id) && digest(v.app_key) && text(v.app_label)
  && ['google', 'microsoft', 'other'].includes(String(v.issuer)) && ['direct_oauth', 'broker'].includes(String(v.authentication))
  && (v.saved_app_id === undefined || typeof v.saved_app_id === 'string' && /^(?:default|app-[a-f0-9]{32})$/.test(v.saved_app_id))
  && (v.client_id === undefined || text(v.client_id)) && text(v.account_label) && texts(v.connection_names)
  && (v.api_resources === undefined || Array.isArray(v.api_resources) && v.api_resources.length <= 256
    && new Set(v.api_resources.map(r => record(r) ? r.name : undefined)).size === v.api_resources.length
    && v.api_resources.every(r => record(r) && text(r.name) && Array.isArray(v.connection_names) && v.connection_names.includes(r.name) && text(r.base_url)))
  && Array.isArray(v.native_accounts) && v.native_accounts.length <= 256 && v.native_accounts.every(n => record(n) && ['mail', 'calendar'].includes(String(n.platform)) && text(n.slug))
  && uses(v.uses) && typeof v.requirements_complete === 'boolean' && typeof v.grants_known === 'boolean'
  && texts(v.required_scopes) && texts(v.warnings)
  && Array.isArray(v.scopes) && v.scopes.length <= 512 && new Set(v.scopes.map(s => record(s) ? s.scope : undefined)).size === v.scopes.length
  && v.scopes.every(s => record(s) && text(s.scope) && ['required', 'unused_locally', 'unknown'].includes(String(s.status))
    && ['recorded_grant', 'requested_only', 'requirement_only'].includes(String(s.evidence)) && uses(s.required_by)
    && (s.status !== 'unused_locally' || s.evidence === 'recorded_grant' && v.requirements_complete === true && v.grants_known === true && s.required_by.length === 0)
    && (s.status !== 'required' || s.required_by.length > 0));
export const isOAuthPermissionInventory = (v: unknown): v is OAuthPermissionInventory => record(v) && digest(v.fingerprint)
  && Number.isSafeInteger(v.observed_at) && Number(v.observed_at) >= 0 && Number(v.observed_at) <= 8_640_000_000_000_000
  && (v.filter === undefined || record(v.filter) && ['google', 'microsoft'].includes(String(v.filter.issuer))
    && typeof v.filter.app_id === 'string' && /^(?:default|app-[a-f0-9]{32})$/.test(v.filter.app_id))
  && texts(v.unavailable) && Array.isArray(v.groups) && v.groups.length <= 512 && v.groups.every(group)
  && new Set(v.groups.map(g => g.id)).size === v.groups.length;
export const isOAuthPermissionCleanupPreview = (v: unknown): v is OAuthPermissionCleanupPreview => record(v)
  && digest(v.inventory_fingerprint) && digest(v.group_id) && texts(v.selected_scopes) && v.selected_scopes.length > 0
  && texts(v.retained_scopes, 512) && texts(v.required_scopes) && texts(v.connection_names)
  && texts(v.related_group_ids, 512) && v.related_group_ids.every(digest) && uses(v.uses) && texts(v.warnings)
  && ['google_revoke_reconnect', 'microsoft_consent_review', 'vendor_consent_review'].includes(String(v.method))
  && disjoint(v.selected_scopes, v.retained_scopes) && disjoint(v.selected_scopes, v.required_scopes)
  && v.mutation === false && v.verification === 'not_checked';
