import { isSavedOAuthApp, isOAuthAppSecretExpiryDate, type SavedOAuthApp, type OAuthAppIssuer } from './foundational-oauth.js';
import type { ManagedOAuthConnectionUse } from './managed-oauth.js';

export interface OAuthAppNativeUse { platform: 'mail' | 'calendar'; slug: string }
export interface OAuthAppCredentialCopy {
  name: string; display_name: string;
  origin: 'confirmed' | 'unknown'; secret_matches: boolean; client_id_matches: boolean;
  group_id: string; group_complete: boolean; selected_by_default: boolean;
  uses: readonly ManagedOAuthConnectionUse[]; usage_available: boolean;
}
export interface OAuthAppUsageReview {
  id: string; fingerprint: string; expires_at: number; app: SavedOAuthApp;
  native_accounts: readonly OAuthAppNativeUse[];
  connections: readonly OAuthAppCredentialCopy[];
  unreadable_connections: readonly string[]; can_rotate: boolean; warnings: readonly string[];
}
export interface OAuthAppSecretRotationOutcome {
  attempt_id: string; issuer: OAuthAppIssuer; app_id: string;
  status: 'checking' | 'applied' | 'failed';
  selected_names: readonly string[]; skipped_names: readonly string[];
  native_accounts: readonly OAuthAppNativeUse[];
  verification: 'not_checked'; app_revision?: number;
  /** Proposed date for the new secret; authoritative only on an applied result. */
  secret_expires_on?: string;
  reason?: 'changed' | 'locked' | 'interrupted' | 'server_error';
}
export type OAuthAppUsageRequest =
  | { action: 'usage'; issuer: OAuthAppIssuer; id: string; expected_revision: number }
  | { action: 'retire_usage'; id: string }
  | { action: 'rotate_secret'; review_id: string; fingerprint: string; selected_names: readonly string[]; client_secret: string; attempt_id: string;
      secret_expires_on?: string | null }
  | { action: 'rotation_status'; attempt_id: string };

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const nonce = (v: unknown): boolean => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 2048 && !/[\x00-\x1f\x7f]/.test(v);
const names = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 256 && v.every(text) && new Set(v).size === v.length;
const native = (v: unknown): v is OAuthAppNativeUse => record(v) && ['mail', 'calendar'].includes(String(v.platform)) && text(v.slug);
export const isOAuthAppUsageReview = (v: unknown): v is OAuthAppUsageReview => record(v) && nonce(v.id)
  && typeof v.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(v.fingerprint) && Number.isSafeInteger(v.expires_at) && Number(v.expires_at) >= 0
  && isSavedOAuthApp(v.app) && Array.isArray(v.native_accounts) && v.native_accounts.length <= 256 && v.native_accounts.every(native)
  && names(v.unreadable_connections) && typeof v.can_rotate === 'boolean' && Array.isArray(v.warnings) && v.warnings.length <= 256 && v.warnings.every(text)
  && Array.isArray(v.connections) && v.connections.length <= 256 && new Set(v.connections.map(c => record(c) ? c.name : null)).size === v.connections.length && v.connections.every(c => record(c)
    && text(c.name) && text(c.display_name) && ['confirmed', 'unknown'].includes(String(c.origin)) && typeof c.secret_matches === 'boolean'
    && typeof c.client_id_matches === 'boolean'
    && text(c.group_id) && typeof c.group_complete === 'boolean' && typeof c.selected_by_default === 'boolean'
    && (!c.selected_by_default || c.origin === 'confirmed' && c.group_complete)
    && typeof c.usage_available === 'boolean' && Array.isArray(c.uses) && c.uses.length <= 10000 && c.uses.every(u => record(u)
      && ['pack', 'mail', 'calendar', 'file', 'recipe', 'dish', 'schedule'].includes(String(u.kind)) && text(u.id) && text(u.label)));
export const isOAuthAppSecretRotationOutcome = (v: unknown): v is OAuthAppSecretRotationOutcome => record(v) && nonce(v.attempt_id)
  && ['google', 'microsoft'].includes(String(v.issuer)) && typeof v.app_id === 'string' && /^(?:default|app-[a-f0-9]{32})$/.test(v.app_id)
  && ['checking', 'applied', 'failed'].includes(String(v.status)) && names(v.selected_names) && names(v.skipped_names)
  && Array.isArray(v.native_accounts) && v.native_accounts.length <= 256 && v.native_accounts.every(native) && v.verification === 'not_checked'
  && (v.app_revision === undefined || Number.isSafeInteger(v.app_revision) && Number(v.app_revision) >= 1)
  && (v.secret_expires_on === undefined || isOAuthAppSecretExpiryDate(v.secret_expires_on))
  && (v.reason === undefined || ['changed', 'locked', 'interrupted', 'server_error'].includes(String(v.reason)));
