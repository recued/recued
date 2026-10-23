/** A healthy-evidence signal to an independently hosted heartbeat monitor.
 * The monitor owns missed-ping alerts; no provider or recovery work starts here. */
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { BACKUP_WATCHDOG_INTERVAL_MS, RpcError, serverBackupHealthView,
  type BackupWatchdogIssue, type BackupWatchdogStatus, type ServerBackupHealthSnapshot } from '@recued/contracts';
import { encrypt, decrypt, encodeCiphertext, decodeCiphertext } from '@recued/crypto';
import { writeFileAtomicSync } from '../durable-fs.js';
import { makeBoundedOriginHttpFetcher } from '../bounded-origin-http-fetcher.js';
import { createWebhookBoundedHttpsUrlParser } from '../webhook-bounded-https-url-parser.js';
import { advanceWatchdogDrill, validStoredWatchdogDrill, watchdogDrillMinutes, watchdogDrillOpen, watchdogDrillView, watchdogUuid, type StoredWatchdogDrill } from './backup-watchdog-drill.js';

export const backupWatchdogPath = (dbPath: string): string => `${resolve(dbPath)}.backup-watchdog.json`;
const parseUrl = createWebhookBoundedHttpsUrlParser({ kind: 'bounded_https_url.v1', max_bytes: 2048, allowed_ports: [443] }).parse;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v);
interface Saved {
  v: 1 | 2;
  revision: string;
  enabled: boolean;
  secret?: { id: string; ciphertext: string };
  last_attempt_at?: number;
  last_acknowledged_at?: number;
  last_issue?: 'vault_unavailable' | 'ping_failed';
  drill?: StoredWatchdogDrill;
}
const aad = (id: string) => new TextEncoder().encode(`recued/backup-watchdog/v1/${id}`);

export const createBackupWatchdog = (options: {
  dbPath: string;
  /** Fresh derived bytes owned by this caller, wiped after sealing/opening. */
  getEncryptionKey(): Uint8Array | null;
  readEvidence(forceRefresh?: boolean): ServerBackupHealthSnapshot;
  canRun?: () => boolean;
  now?: () => number;
  fetchImpl?: typeof fetch;
}) => {
  const path = backupWatchdogPath(options.dbPath), now = options.now ?? Date.now;
  const fetchPing = makeBoundedOriginHttpFetcher({ fetchImpl: options.fetchImpl, timeoutMs: 5000, maxResponseBytes: 64, redirectPolicy: 'error' });
  let stopped = false, active: Promise<void> | undefined, saving: Promise<BackupWatchdogStatus> | undefined;
  let controller: AbortController | undefined;
  const read = (): Saved | null => {
    let value: unknown;
    try {
      if (statSync(path).size > 8192) throw new Error('size');
      value = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Monitor settings unavailable'); }
    if (!object(value) || !only(value, ['v', 'revision', 'enabled', 'secret', 'last_attempt_at', 'last_acknowledged_at', 'last_issue', 'drill'])
      || (value.v !== 1 && value.v !== 2) || !uuid(value.revision) || typeof value.enabled !== 'boolean'
      || (value.secret !== undefined && (!object(value.secret) || !only(value.secret, ['id', 'ciphertext'])
        || !uuid(value.secret.id) || typeof value.secret.ciphertext !== 'string' || !value.secret.ciphertext.length || value.secret.ciphertext.length > 6000))
      || (value.enabled && !value.secret)
      || (value.last_attempt_at !== undefined && !integer(value.last_attempt_at))
      || (value.last_acknowledged_at !== undefined && (!integer(value.last_acknowledged_at) || !integer(value.last_attempt_at)))
      || (value.last_issue !== undefined && value.last_issue !== 'vault_unavailable' && value.last_issue !== 'ping_failed')
      || (value.drill !== undefined && (value.v !== 2 || !validStoredWatchdogDrill(value.drill)
        || (watchdogDrillOpen(value.drill) && (value.drill.bound_revision !== value.revision || !value.enabled || !value.secret))))) throw new Error('Monitor settings unavailable');
    return value as unknown as Saved;
  };
  const write = (value: Saved) => writeFileAtomicSync(path, `${JSON.stringify(value)}\n`);
  const evidenceIssue = (fresh = false): BackupWatchdogIssue | undefined => {
    try {
      const evidence = options.readEvidence(fresh), view = serverBackupHealthView(evidence);
      if (!view || view.warnings.length || evidence.monitoring !== 'active') return 'backup_attention';
      if (evidence.backup_state !== 'current') return 'backup_not_current';
      if (evidence.integrity.monitoring === 'active' && evidence.integrity.state !== 'completed') return 'scan_not_ready';
      return undefined;
    } catch { return 'backup_attention'; }
  };
  const clockBad = (saved: Saved): boolean => {
    const at = now(), d = saved.drill;
    return !integer(at) || (saved.last_attempt_at !== undefined && saved.last_attempt_at > at)
      || (saved.last_acknowledged_at !== undefined && saved.last_acknowledged_at > at)
      || !!(d && d.bound_revision === saved.revision && [d.started_at, d.resumed_at, d.alert_reported_at, d.ping_acknowledged_at].some(time => time !== undefined && time > at));
  };
  const drillView = (saved: Saved) => saved.drill ? { drill: watchdogDrillView(saved.drill, saved.revision, now()) } : {};
  const status = (): BackupWatchdogStatus => {
    let saved: Saved | null;
    try { saved = read(); }
    catch { return { configured: false, enabled: false, state: 'unavailable', issue: 'settings_unavailable' }; }
    if (!saved?.secret) return { configured: false, enabled: false, state: 'not_configured', ...(saved ? drillView(saved) : {}) };
    const base = { configured: true, enabled: saved.enabled, configuration_revision: saved.revision, ...drillView(saved),
      ...(saved.last_attempt_at === undefined ? {} : { last_attempt_at: saved.last_attempt_at }),
      ...(saved.last_acknowledged_at === undefined ? {} : { last_acknowledged_at: saved.last_acknowledged_at }) };
    if (!saved.enabled) return { ...base, state: 'paused' };
    if (clockBad(saved)) return { ...base, state: 'unavailable', issue: 'clock_changed' };
    if (saved.drill && advanceWatchdogDrill(saved.drill, now()).phase === 'paused') return { ...base, state: 'drill_paused' };
    const issue = evidenceIssue();
    if (issue) return { ...base, state: 'blocked', issue };
    if (active) return { ...base, state: 'sending' };
    if (saved.last_issue) return { ...base, state: 'failed', issue: saved.last_issue };
    return { ...base, state: saved.last_acknowledged_at === undefined ? 'waiting' : 'acknowledged' };
  };
  const saveWork = async (input: unknown): Promise<BackupWatchdogStatus> => {
    if (!object(input) || !only(input, ['enabled', 'ping_url', 'forget']) || typeof input.enabled !== 'boolean'
      || (input.ping_url !== undefined && (typeof input.ping_url !== 'string' || !parseUrl(input.ping_url)))
      || (input.forget !== undefined && typeof input.forget !== 'boolean')
      || (input.forget === true && (input.enabled || input.ping_url !== undefined))) throw new RpcError('invalid_args', 'Use an HTTPS success-ping URL on port 443 with no query, fragment, or login. Remove a monitor only when disabled.', 400);
    let previous: Saved | null;
    try { previous = read(); }
    catch { throw new RpcError('not_configured', 'Monitor settings could not be read. Refresh before trying again.', 503); }
    let secret = input.forget ? undefined : previous?.secret;
    if (input.ping_url !== undefined) {
      let key: Uint8Array | undefined, bytes: Uint8Array | undefined;
      try {
        key = options.getEncryptionKey() ?? undefined;
        if (!key) throw new RpcError('locked', 'Unlock the server vault before saving a ping URL.', 409);
        bytes = new TextEncoder().encode(input.ping_url);
        const id = randomUUID(); secret = { id, ciphertext: encodeCiphertext(await encrypt(key, bytes, aad(id))) };
      } catch (error) {
        if (error instanceof RpcError) throw error;
        throw new RpcError('not_configured', 'The ping URL could not be sealed. Check the vault and try again.', 503);
      } finally { key?.fill(0); bytes?.fill(0); }
    }
    if (input.enabled && !secret) throw new RpcError('invalid_args', 'Enter the monitor success-ping URL once to enable it.', 400);
    try {
      const latest = read();
      if (latest?.revision !== previous?.revision) throw new Error('changed');
      const changed = input.ping_url !== undefined || input.forget;
      const saved: Saved = { v: latest?.v ?? 1, revision: randomUUID(), enabled: input.enabled,
        ...(secret ? { secret } : {}),
        ...(latest?.drill ? { drill: watchdogDrillOpen(latest.drill)
          ? { ...latest.drill, phase: 'superseded' as const, finished_at: now() } : latest.drill } : {}),
        ...(!changed && previous?.last_attempt_at !== undefined ? { last_attempt_at: previous.last_attempt_at } : {}),
        ...(!changed && previous?.last_acknowledged_at !== undefined ? { last_acknowledged_at: previous.last_acknowledged_at } : {}),
        ...(!changed && previous?.last_issue ? { last_issue: previous.last_issue } : {}) };
      write(saved); controller?.abort(); return status();
    } catch { throw new RpcError('not_configured', 'Monitor settings could not be saved. Refresh before trying again.', 503); }
  };
  const send = async (): Promise<void> => {
    let saved: Saved | null;
    try { saved = read(); } catch { return; }
    if (!saved?.enabled || !saved.secret || clockBad(saved)
      || (saved.drill && advanceWatchdogDrill(saved.drill, now()).phase === 'paused') || evidenceIssue(true)
      || (saved.last_attempt_at !== undefined && now() - saved.last_attempt_at < BACKUP_WATCHDOG_INTERVAL_MS)) return;
    const ownController = new AbortController(); controller = ownController;
    let attemptedAt = now();
    let admittedDrill: string | undefined;
    let key: Uint8Array | undefined, bytes: Uint8Array | undefined;
    let failure: 'vault_unavailable' | 'ping_failed' | undefined = 'vault_unavailable';
    try {
      key = options.getEncryptionKey() ?? undefined; if (!key) throw new Error('locked');
      bytes = await decrypt(key, decodeCiphertext(saved.secret.ciphertext), aad(saved.secret.id));
      const url = parseUrl(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!url) throw new Error('url');
      const latest = read();
      if (stopped || options.canRun?.() === false || ownController.signal.aborted || latest?.revision !== saved.revision || clockBad(latest) || evidenceIssue(true)) return;
      if (latest.drill) {
        latest.drill = advanceWatchdogDrill(latest.drill, now());
        if (latest.drill.phase === 'paused') return;
        if (latest.drill.phase === 'resuming') admittedDrill = latest.drill.operation_id;
      }
      saved = latest;
      attemptedAt = now(); saved.last_attempt_at = attemptedAt;
      try { write(saved); } catch { return; } // No durable intent means no request.
      failure = 'ping_failed';
      const response = await fetchPing(url, { method: 'GET', signal: ownController.signal });
      if (response.status === 200 && (await response.text()).trim() === 'OK' && !ownController.signal.aborted) failure = undefined;
    } catch { /* Raw endpoint URLs, response bodies, and key errors stay private. */ }
    finally {
      key?.fill(0); bytes?.fill(0);
      if (controller === ownController) controller = undefined;
    }
    try {
      const latest = read();
      if (latest?.revision !== saved.revision || stopped || ownController.signal.aborted || clockBad(latest)) return;
      // A vault failure also needs a durable rate limit across restarts.
      latest.last_attempt_at = attemptedAt;
      if (failure) latest.last_issue = failure;
      else {
        latest.last_acknowledged_at = now(); delete latest.last_issue;
        const d = latest.drill;
        if (admittedDrill && d?.operation_id === admittedDrill && d.bound_revision === latest.revision
          && d.phase === 'resuming' && d.resumed_at !== undefined && attemptedAt >= d.resumed_at) {
          d.ping_acknowledged_at = latest.last_acknowledged_at; latest.drill = advanceWatchdogDrill(d, now());
        }
      }
      write(latest);
    } catch { /* A remote acknowledgment can be lost; next minute retries. */ }
  };
  const drillSettings = (): Saved => {
    if (stopped || saving || options.canRun?.() === false) throw new RpcError('conflict', 'Wait until the monitor is running and setup has finished.', 409);
    let saved: Saved | null;
    try { saved = read(); } catch { throw new RpcError('not_configured', 'Monitor settings could not be read. Refresh before trying again.', 503); }
    if (!saved?.enabled || !saved.secret) throw new RpcError('not_configured', 'Enable a monitor before testing its alerts.', 409);
    return saved;
  };
  const writeDrill = (saved: Saved): BackupWatchdogStatus => {
    try { write(saved); } catch { throw new RpcError('not_configured', 'The alert drill could not be saved. Refresh before trying again.', 503); }
    return status();
  };
  return {
    status,
    save(input: unknown): Promise<BackupWatchdogStatus> {
      if (stopped || saving) return Promise.reject(new RpcError('conflict', 'Wait for monitor setup to finish.', 409));
      saving = saveWork(input).finally(() => { saving = undefined; }); return saving;
    },
    startDrill(input: unknown): BackupWatchdogStatus {
      if (!object(input) || !only(input, ['operation_id', 'configuration_revision', 'pause_minutes']) || !watchdogUuid(input.operation_id)
        || !watchdogUuid(input.configuration_revision) || !watchdogDrillMinutes(input.pause_minutes)) throw new RpcError('invalid_args', 'Choose a 10, 15, 30, or 60 minute alert drill for the current monitor setup.', 400);
      const saved = drillSettings(), prior = saved.drill, at = now();
      if (prior?.operation_id === input.operation_id) {
        if (prior.origin_revision !== input.configuration_revision || prior.bound_revision !== saved.revision || prior.pause_minutes !== input.pause_minutes) throw new RpcError('conflict', 'This drill belongs to another monitor setup. Refresh first.', 409);
        return status();
      }
      if (saved.revision !== input.configuration_revision || (prior && watchdogDrillOpen(advanceWatchdogDrill(prior, at)))) throw new RpcError('conflict', 'Review the current monitor setup and finish its earlier drill first.', 409);
      if (active || clockBad(saved) || evidenceIssue(true) || saved.last_issue || saved.last_acknowledged_at === undefined
        || at - saved.last_acknowledged_at >= 2 * BACKUP_WATCHDOG_INTERVAL_MS) throw new RpcError('conflict', 'Wait for healthy backup proof and a recent ping acknowledgment before starting a drill.', 409);
      const revision = randomUUID(), deadline = at + input.pause_minutes * 60_000;
      if (!integer(deadline)) throw new RpcError('conflict', 'Check the server clock before starting a drill.', 409);
      saved.v = 2; saved.revision = revision;
      saved.drill = { operation_id: input.operation_id, origin_revision: input.configuration_revision, bound_revision: revision,
        phase: 'paused', pause_minutes: input.pause_minutes, started_at: at, pause_until: deadline };
      return writeDrill(saved);
    },
    updateDrill(input: unknown): BackupWatchdogStatus {
      if (!object(input) || !only(input, ['operation_id', 'action']) || !watchdogUuid(input.operation_id)
        || (input.action !== 'confirm_alert' && input.action !== 'cancel')) throw new RpcError('invalid_args', 'Choose whether you received this drill alert or want to end the drill.', 400);
      const saved = drillSettings(), at = now();
      if (!saved.drill || saved.drill.operation_id !== input.operation_id || saved.drill.bound_revision !== saved.revision) throw new RpcError('conflict', 'This drill no longer owns the monitor setup. Refresh first.', 409);
      const d = advanceWatchdogDrill(saved.drill, at);
      if (input.action === 'cancel') {
        if (d.phase === 'cancelled') return status();
        if (!watchdogDrillOpen(d)) throw new RpcError('conflict', 'This drill has already ended. Refresh to review its result.', 409);
        d.phase = 'cancelled'; d.finished_at = at; saved.drill = d;
        const result = writeDrill(saved); controller?.abort(); return result;
      }
      if (clockBad(saved)) throw new RpcError('conflict', 'Check the server clock before confirming an alert.', 409);
      if (d.phase === 'completed') return status();
      if (!watchdogDrillOpen(d)) throw new RpcError('conflict', 'This drill has already ended. Refresh to review its result.', 409);
      d.alert_reported_at ??= at;
      if (d.phase === 'paused') { d.phase = 'resuming'; d.resumed_at = at; }
      saved.drill = advanceWatchdogDrill(d, at); return writeDrill(saved);
    },
    tick(): Promise<void> {
      if (stopped || saving || options.canRun?.() === false || active) return Promise.resolve();
      active = send().catch(() => {}).finally(() => { active = undefined; }); return active;
    },
    async stop(): Promise<void> { stopped = true; controller?.abort(); await Promise.allSettled([active, saving]); },
    resume(): void { stopped = false; },
  };
};
export type BackupWatchdog = ReturnType<typeof createBackupWatchdog>;
