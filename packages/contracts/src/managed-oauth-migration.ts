/** D-322 §26 — owner-reviewed, per-connection bulk switches. Never contains credentials. */
import type { ManagedOAuthAccountPreview, AuthenticationSwitchAuthorization, ManagedOAuthImpactPreview } from './managed-oauth.js';
import { isManagedOAuthImpactPreview } from './managed-oauth.js';

export const MANAGED_OAUTH_MIGRATION_LIMIT = 20;
export interface ManagedOAuthMigrationCandidate {
  name: string; display_name: string; updated_at: number;
  base_url: string; vendor?: string; authentication: 'direct_oauth' | 'token' | 'broker';
  required_scopes: readonly string[]; verification_url: string;
  current?: ManagedOAuthAccountPreview;
}
export interface ManagedOAuthMigrationSelection {
  name: string; expected_updated_at: number; verification_url: string;
}
export interface ManagedOAuthMigrationRow {
  connection: ManagedOAuthMigrationCandidate;
  state: 'pending' | 'verified' | 'failed' | 'applying' | 'migrated' | 'skipped';
  impact?: ManagedOAuthImpactPreview;
  reason?: 'access_failed' | 'changed' | 'unavailable' | 'stopped';
  http_status?: number;
  attempt_id?: string;
}
export interface ManagedOAuthMigrationView {
  id: string; created_at: number; expires_at: number;
  state: 'preparing' | 'ready' | 'applying' | 'completed' | 'stopped' | 'expired';
  /** The completed native-check review. Apply must carry this exact hash. */
  fingerprint?: string;
  target?: ManagedOAuthAccountPreview;
  requested_scopes: readonly string[];
  rows: readonly ManagedOAuthMigrationRow[];
  warnings: readonly string[];
}
export type ManagedOAuthMigrationRequest =
  | { action: 'migration_candidates'; names?: readonly string[] }
  | { action: 'migration_prepare'; id: string; selections: readonly ManagedOAuthMigrationSelection[];
      auth: AuthenticationSwitchAuthorization; impact_fingerprint: string }
  | { action: 'migration_apply'; id: string; fingerprint: string }
  | { action: 'migration_status'; id?: string }
  | { action: 'migration_stop'; id: string };
export type ManagedOAuthMigrationResponse =
  | { action: 'migration_candidates'; candidates: readonly ManagedOAuthMigrationCandidate[] }
  | { action: 'migration_prepare' | 'migration_apply' | 'migration_stop'; migration: ManagedOAuthMigrationView }
  | { action: 'migration_status'; migrations: readonly ManagedOAuthMigrationView[] };

export const isManagedOAuthMigrationCandidate = (raw: unknown): raw is ManagedOAuthMigrationCandidate => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const v = raw as Record<string, unknown>;
  const text = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 4096 && !/[\r\n\0]/.test(s);
  if (!text(v.name) || !text(v.display_name) || !text(v.base_url) || typeof v.verification_url !== 'string'
    || !Number.isSafeInteger(v.updated_at) || Number(v.updated_at) < 0 || v.vendor !== undefined && !text(v.vendor)
    || typeof v.authentication !== 'string' || !['direct_oauth', 'token', 'broker'].includes(v.authentication)
    || !Array.isArray(v.required_scopes) || !v.required_scopes.every(text)) return false;
  try { if (!['http:', 'https:'].includes(new URL(v.base_url).protocol)) return false; } catch { return false; }
  return v.current === undefined || isManagedOAuthImpactPreview({ fingerprint: '0'.repeat(64), phase: 'before_save', mode: 'switch',
    consent: 'reuse', target: v.current, connections: [], warnings: [] });
};

export const isManagedOAuthMigrationView = (raw: unknown): raw is ManagedOAuthMigrationView => {
  const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\r\n\0]/.test(v);
  const strings = (v: unknown): boolean => Array.isArray(v) && v.every(text);
  const date = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (!record(raw) || !text(raw.id) || !date(raw.created_at) || !date(raw.expires_at)
    || typeof raw.state !== 'string' || !['preparing', 'ready', 'applying', 'completed', 'stopped', 'expired'].includes(raw.state)
    || raw.fingerprint !== undefined && (typeof raw.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(raw.fingerprint))
    || raw.target !== undefined && !isManagedOAuthImpactPreview({ fingerprint: '0'.repeat(64), phase: 'before_save', mode: 'switch',
      consent: 'reuse', target: raw.target, connections: [], warnings: [] })
    || !strings(raw.requested_scopes) || !strings(raw.warnings) || !Array.isArray(raw.rows)
    || raw.rows.length === 0 || raw.rows.length > MANAGED_OAUTH_MIGRATION_LIMIT) return false;
  return raw.rows.every(row => record(row) && isManagedOAuthMigrationCandidate(row.connection) && record(row.connection) && text(row.connection.name)
    && text(row.connection.display_name) && date(row.connection.updated_at) && text(row.connection.base_url)
    && (row.connection.vendor === undefined || text(row.connection.vendor))
    && typeof row.connection.authentication === 'string' && ['direct_oauth', 'token', 'broker'].includes(row.connection.authentication)
    && strings(row.connection.required_scopes) && typeof row.connection.verification_url === 'string'
    && typeof row.state === 'string' && ['pending', 'verified', 'failed', 'applying', 'migrated', 'skipped'].includes(row.state)
    && (row.impact === undefined || isManagedOAuthImpactPreview(row.impact))
    && (row.state !== 'verified' || row.impact !== undefined && raw.target !== undefined)
    && (raw.state !== 'ready' || raw.fingerprint !== undefined)
    && (row.attempt_id === undefined || text(row.attempt_id))
    && (row.http_status === undefined || Number.isInteger(row.http_status) && Number(row.http_status) >= 100 && Number(row.http_status) <= 599)
    && (row.reason === undefined || typeof row.reason === 'string' && ['access_failed', 'changed', 'unavailable', 'stopped'].includes(row.reason)));
};
