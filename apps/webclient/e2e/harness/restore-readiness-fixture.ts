import type { WebclientLocalStore } from '../../src/storage/local-store.js';

const ID = '11111111-1111-4111-8111-111111111111';
/** Seed only the opaque browser receipt. The loopback transport supplies its
 * synthetic server verdict; no actual import or secret material is involved. */
export const seedRestoreReadinessReceipt = async (store: WebclientLocalStore): Promise<void> => {
  const address = await store.get('server_url'), identity = await store.get('server_public_key');
  if (!address || !identity) throw new Error('Missing fixture pair');
  const url = new URL(address); url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = url.pathname.replace(/\/ws\/?$/u, '').replace(/\/+$/u, '');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([url.toString(), identity])));
  const scope = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  const key = `recued.webclient.archive-import.${scope}`;
  if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, JSON.stringify({ id: ID, seen_terminal: false }));
};
export const restoreReadinessFixture = (mode: string | null, method: string): unknown => {
  if (!mode) return undefined;
  const now = Date.now(), destination = { connection_name: 'fixture-storage', destination_id: 'current' };
  const schedule = { cadence: 'daily', hour_utc: 2, minute_utc: 0, weekday_utc: 0 };
  if (method === 'server.archive.import_status') return { status: mode === 'accepted' ? 'waiting_for_restart' : 'completed' };
  if (method === 'server.archive.destinations') return { destinations: [{ ...destination, bucket: 'fixture-bucket', region: 'fixture', endpoint: 'https://storage.example.test', prefix: 'fixture' }] };
  if (method === 'server.archive.backups') return { backups: [] };
  if (method === 'server.archive.drills') return { drills: [] };
  if (method === 'server.archive.unattended.get') return mode === 'attention' ? { configured: false }
    : { configured: true, settings: { ...destination, enabled: true, keep_last: 5, schedule }, next_run_at: now + 3600_000 };
  if (method === 'server.archive.health.get') return {
    checked_at: now, monitoring: mode === 'attention' ? 'not_configured' : 'active', destination,
    policy: { alerts_enabled: true, backup_max_age_hours: 36, recovery_max_age_days: 30 }, alerts: [],
    backup: { state: 'current', created_at: now - 1000, due_at: now + 3600_000 },
    recovery: { state: 'current', finished_at: now - 1000, due_at: now + 3600_000 },
  };
  if (method === 'server.archive.integrity.get') return { monitoring: mode === 'attention' ? 'not_configured' : 'active', destination,
    policy: { enabled: mode !== 'attention', schedule }, last_run: mode === 'attention' ? undefined : {
      operation_id: ID, destination_id: destination.destination_id, started_at: now - 2000, finished_at: now - 1000,
      outcome: 'completed', total: 2, checked: 2, failed: 0, skipped: 0,
    } };
  if (method === 'server.archive.watchdog.get') return mode === 'attention' ? { configured: false, enabled: false, state: 'not_configured' }
    : { configured: true, enabled: true, state: 'acknowledged', configuration_revision: ID, last_acknowledged_at: now - 50, drill: {
      operation_id: ID, phase: 'completed', current_configuration: true, pause_minutes: 10,
      started_at: now - 10000, pause_until: now - 5000, resumed_at: now - 5000,
      alert_reported_at: now - 6000, ping_acknowledged_at: now - 3000, finished_at: now - 2000,
    } };
  return undefined;
};
