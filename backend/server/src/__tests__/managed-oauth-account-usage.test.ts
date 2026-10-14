/** D-322 §22 — exact usage and honest, sanitized health projections. */
import { describe, expect, it } from 'vitest';
import type { ConnectionRow, SourceRegistration } from '@recued/contracts';
import { managedOAuthConnectionUsage, managedOAuthConnectionUses } from '../managed-oauth-account-usage.js';

const row: ConnectionRow = { pk: 'api:work', kind: 'api', name: 'work', display_name: 'Work',
  config_json: '{"secret":"do-not-project"}', auth_ciphertext: 'private-encrypted-auth', enrolled_at: 1, updated_at: 2 };
const source = (id: string, source_kind: SourceRegistration['source_kind'] = 'connection'): SourceRegistration => ({
  id, source_kind, top_tier_kind: 'file', source_label: 'Work files', write_capable: false, registered_at: 1,
});

describe('D-322 account usage projection', () => {
  it.each([
    ['missing', undefined, 'unknown'], ['invalid JSON', '{', 'unknown'],
    ['bad status', '{"status":"great"}', 'unknown'], ['null', 'null', 'unknown'],
    ['old success', '{"status":"ok","last_probed_at":1}', 'unknown'],
    ['no timestamp', '{"status":"ok"}', 'unknown'],
    ['fresh success', '{"status":"ok","last_probed_at":2000000}', 'ok'],
    ['future success', '{"status":"ok","last_probed_at":9000000}', 'unknown'],
    ['authentication failure', '{"status":"auth_failed","last_probed_at":1}', 'auth_failed'],
    ['unreachable', '{"status":"unreachable","last_probed_at":1}', 'unreachable'],
    ['HTTP 503 reachability', '{"status":"ok","last_probed_at":2000000,"last_error":"http_status_503"}', 'unknown'],
    ['unverified root access', '{"status":"ok","last_probed_at":2000000,"last_error":"managed_oauth_permissions_unverified"}', 'unknown'],
  ])('reports %s honestly', (_label, health_json, expected) => {
    expect(managedOAuthConnectionUsage({ ...row, health_json }, 2_000_001).health.status).toBe(expected);
  });
  it('projects only identity, timestamps, status and explicit references', () => {
    const result = managedOAuthConnectionUsage({ ...row, health_json: JSON.stringify({ status: 'auth_failed',
      last_probed_at: 25, last_error: 'Bearer private-vendor-token', tools: ['private-tool'] }), last_used_at: 30 }, 40,
    { uses: [{ kind: 'mail', id: 'work-mail', label: 'Work mail' }], complete: true });
    expect(result).toEqual({ name: 'work', display_name: 'Work', updated_at: 2, health: { status: 'auth_failed', last_probed_at: 25 },
      last_used_at: 30, uses: [{ kind: 'mail', id: 'work-mail', label: 'Work mail' }], usage_available: true });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|config|ciphertext/);
  });
  it('does not call an unavailable reference reader an empty dependency list', () => {
    expect(managedOAuthConnectionUsage(row, 1).usage_available).toBe(false);
  });
  it('shows HTTP diagnostic codes but never arbitrary error text', () => {
    const result = managedOAuthConnectionUsage({ ...row, health_json: JSON.stringify({ status: 'auth_failed',
      last_probed_at: 1, last_error: 'http_status_403' }) }, 2);
    expect(result.health).toEqual({ status: 'auth_failed', last_probed_at: 1, http_status: 403 });
  });
  it('matches file bindings by the complete connection name, excludes other source kinds and deduplicates packs', () => {
    const result = managedOAuthConnectionUses('work.eu', { packSlugs: ['sales', 'sales'],
      packNames: new Map([['sales', 'Sales desk']]), instances: [],
      sources: [source('drive.work.eu.file'), source('drive.work.file'), source('drive.work.eu.file', 'builtin')], complete: true });
    expect(result).toEqual({ complete: true, uses: [
      { kind: 'file', id: 'drive.work.eu.file', label: 'Work files' }, { kind: 'pack', id: 'sales', label: 'Sales desk' },
    ] });
  });
});
