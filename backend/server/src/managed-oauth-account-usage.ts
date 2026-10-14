/** D-322 §22 — local broker-account usage, with the existing connection-health expiry. */
import { effectiveConnectionHealth, type ConnectionRow,
  type ManagedOAuthConnectionUse, type ManagedOAuthConnectionUsage, type SourceRegistration } from '@recued/contracts';
import type { CollectionInstanceRecord } from './collections/instance-store.js';
import { sourceIdConnectionName } from './work-entity-source-boot.js';

export const managedOAuthConnectionUses = (name: string, input: {
  packSlugs: readonly string[];
  packNames: ReadonlyMap<string, string>;
  instances: readonly CollectionInstanceRecord[];
  sources: readonly SourceRegistration[];
  complete: boolean;
}): { uses: ManagedOAuthConnectionUse[]; complete: boolean } => {
  const uses: ManagedOAuthConnectionUse[] = input.packSlugs.map(id => ({
    kind: 'pack', id, label: input.packNames.get(id) ?? id,
  }));
  for (const row of input.instances) {
    if (row.platform !== 'mail' && row.platform !== 'calendar') continue;
    const binding = row.config.managed_oauth;
    if (binding === null || typeof binding !== 'object' || Array.isArray(binding)
      || (binding as Record<string, unknown>).connection_name !== name) continue;
    uses.push({ kind: row.platform, id: row.slug, label: row.slug });
  }
  for (const source of input.sources) {
    if (source.top_tier_kind !== 'file' || source.source_kind !== 'connection'
      || sourceIdConnectionName(source.id) !== name) continue;
    uses.push({ kind: 'file', id: source.id, label: source.source_label });
  }
  const unique = new Map(uses.map(use => [`${use.kind}:${use.id}`, use]));
  return { uses: [...unique.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)),
    complete: input.complete };
};

const timestamp = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000 ? value : undefined;
const readHealth = (raw: string | undefined): ManagedOAuthConnectionUsage['health'] | undefined => {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as { status?: ManagedOAuthConnectionUsage['health']['status']; last_probed_at?: number; last_error?: unknown } | null;
    if (!value || !['ok', 'auth_failed', 'unreachable', 'unknown'].includes(value.status ?? '')) return undefined;
    const match = typeof value.last_error === 'string' ? /^http_status_([1-5]\d\d)$/.exec(value.last_error) : null;
    return { status: value.status!, ...(timestamp(value.last_probed_at) === undefined ? {} : {
      last_probed_at: timestamp(value.last_probed_at),
    }), ...(match ? { http_status: Number(match[1]) } : {}),
    ...(value.last_error === 'managed_oauth_permissions_unverified' ? { permissions_unverified: true as const } : {}) };
  } catch { return undefined; }
};

export const managedOAuthConnectionUsage = (row: ConnectionRow, now: number,
  references?: { uses: readonly ManagedOAuthConnectionUse[]; complete: boolean }): ManagedOAuthConnectionUsage => {
  const health = readHealth(row.health_json);
  // Future timestamps cannot make a stale or imported observation look fresh.
  const status = (health?.last_probed_at !== undefined && health.last_probed_at > now)
    || (health?.status === 'ok' && ((health.http_status ?? 0) >= 400 || health.permissions_unverified))
    ? 'unknown' : effectiveConnectionHealth(health, now);
  return { name: row.name, display_name: row.display_name, updated_at: row.updated_at, health: { status,
    ...(health?.last_probed_at === undefined ? {} : { last_probed_at: health.last_probed_at }),
    ...(health?.http_status === undefined ? {} : { http_status: health.http_status }),
    ...(health?.permissions_unverified ? { permissions_unverified: true as const } : {}) },
    ...(timestamp(row.last_used_at) === undefined ? {} : { last_used_at: row.last_used_at }),
    uses: references?.uses ?? [], usage_available: references?.complete ?? false };
};
