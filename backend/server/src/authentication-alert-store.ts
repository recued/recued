/** One durable episode per local account/app. Only the passive inventory can
 * open it; only later positive evidence can call an access problem recovered. */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { oauthAppSecretExpiry, type AuthenticationRepairGroup, type AuthenticationRepairIssue,
  type AuthenticationIncidentLevel, type AuthenticationIncidentRetirement, type AuthenticationIncidentHistoryQuery, type AuthenticationIncidentHistoryPage } from '@recued/contracts';
import type { AuthenticationRepairCheck, AuthenticationRepairSnapshot } from './authentication-repair-worklist.js';
import { createAuthenticationIncidentStore } from './authentication-incident-store.js';

export const AUTHENTICATION_ALERT_GRACE_MS = 15 * 60_000;
export type AuthenticationAlertLevel = AuthenticationIncidentLevel;
export interface AuthenticationAlertNotice {
  id: string;
  group_id: string;
  kind: 'problem' | 'recovery';
  level: AuthenticationAlertLevel;
  group: AuthenticationRepairGroup;
  created_at: number;
}
interface RequiredCheck { id: string; context?: string; failed_at: number; succeeded_at?: number }
export interface Episode {
  id: string;
  group_id: string;
  status: 'open' | 'recovered' | 'retired';
  retirement_reason?: AuthenticationIncidentRetirement;
  first_seen_at: number;
  last_seen_at: number;
  last_level?: AuthenticationAlertLevel;
  announced_level?: AuthenticationAlertLevel;
  problem_since_at: number;
  present: boolean;
  removed_uses?: boolean;
  verification_incomplete?: boolean;
  required_checks?: RequiredCheck[];
  /** Date changes are owner metadata, never proof that vendor access works. */
  expiry_date?: string;
  issues: AuthenticationRepairIssue[];
  group: AuthenticationRepairGroup;
  announced: boolean;
}
export interface AuthenticationAlertStore {
  evaluate(snapshot: AuthenticationRepairSnapshot): void;
  pending(): AuthenticationAlertNotice[];
  claim(id: string): boolean;
  history(query: AuthenticationIncidentHistoryQuery, now?: number): AuthenticationIncidentHistoryPage;
}
const levelRank: Record<AuthenticationAlertLevel, number> = { review: 1, rejected: 2, expiry_30: 1, expiry_7: 2, expiry_passed: 3 };
const checkKey = (check: { id: string; context?: string }): string => JSON.stringify([check.id, check.context ?? null]);
/** Copy-affecting fields only. Repeated failure timestamps must not prevent
 * delivery, but changed account labels, uses and repair destinations must. */
export const authenticationAlertGroupSignature = (group: AuthenticationRepairGroup): string => JSON.stringify({
  label: group.label, names: group.connection_names, uses: group.uses, usage_available: group.usage_available, targets: group.targets,
  issues: group.issues.map(i => [i.id, i.code, i.secret_expires_on ?? null]),
});
const expiryLevel = (date: string, now: number): AuthenticationAlertLevel | undefined => {
  const expiry = oauthAppSecretExpiry({ secret_expires_on: date }, now);
  return expiry.status === 'past_due' || expiry.status === 'due_today' ? 'expiry_passed' : expiry.status === 'due_soon'
    ? expiry.days_remaining <= 7 ? 'expiry_7' : 'expiry_30' : undefined;
};
export const createAuthenticationAlertStore = (db: Database.Database): AuthenticationAlertStore => {
  const incidents = createAuthenticationIncidentStore(db);
  db.exec(`CREATE TABLE IF NOT EXISTS authentication_alert_episodes (group_id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS authentication_alert_notices (id TEXT PRIMARY KEY NOT NULL, group_id TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_authentication_alert_notices_group ON authentication_alert_notices(group_id);`);
  const episodes = () => (db.prepare('SELECT data FROM authentication_alert_episodes').all() as Array<{ data: string }>).map(r => JSON.parse(r.data) as Episode);
  const writeEpisode = (episode: Episode) => db.prepare('INSERT OR REPLACE INTO authentication_alert_episodes (group_id, data) VALUES (?, ?)').run(episode.group_id, JSON.stringify(episode));
  const write = (episode: Episode, now: number): void => { writeEpisode(episode); incidents.record(episode, now); };
  const cancelPending = (id: string) => db.prepare('DELETE FROM authentication_alert_notices WHERE group_id = ?').run(id);
  const refreshPending = (group: AuthenticationRepairGroup): void => {
    const row = db.prepare('SELECT data FROM authentication_alert_notices WHERE group_id = ?').get(group.id) as { data: string } | undefined;
    if (!row) return;
    const notice = JSON.parse(row.data) as AuthenticationAlertNotice;
    if (authenticationAlertGroupSignature(notice.group) !== authenticationAlertGroupSignature(group)) {
      db.prepare('UPDATE authentication_alert_notices SET data = ? WHERE id = ?').run(JSON.stringify({ ...notice, group }), notice.id);
    }
  };
  const enqueue = (episode: Episode, kind: AuthenticationAlertNotice['kind'], level: AuthenticationAlertLevel, at: number): void => {
    cancelPending(episode.group_id);
    const notice: AuthenticationAlertNotice = { id: `authentication-alert:${randomUUID()}`, group_id: episode.group_id,
      kind, level, group: episode.group, created_at: at };
    db.prepare('INSERT INTO authentication_alert_notices (id, group_id, data) VALUES (?, ?, ?)').run(notice.id, notice.group_id, JSON.stringify(notice));
  };
  return {
    evaluate: db.transaction((snapshot: AuthenticationRepairSnapshot): void => {
      const { worklist, checks } = snapshot; const now = worklist.observed_at;
      const current = new Map(worklist.groups.map(g => [g.id, g]));
      const evidence = new Map(checks.map(c => [checkKey(c), c]));
      const byIssue = new Map<string, AuthenticationRepairCheck[]>();
      for (const check of checks) { const values = byIssue.get(check.id) ?? []; values.push(check); byIssue.set(check.id, values); }
      const requirements = (episode: Episode): RequiredCheck[] => {
        episode.required_checks ??= episode.issues.map(i => ({ id: i.id, failed_at: i.observed_at ?? episode.first_seen_at }));
        return episode.required_checks;
      };
      const observeSuccesses = (episode: Episode): void => {
        for (const required of requirements(episode)) {
          const check = evidence.get(checkKey(required));
          if (check?.state === 'succeeded' && check.observed_at !== undefined
            && check.observed_at > Math.max(required.failed_at, episode.first_seen_at)) required.succeeded_at = check.observed_at;
        }
      };
      const before = new Map(episodes().map(e => [e.group_id, e]));
      // Existing alert state can supply its known dates, but not an invented
      // sequence of events from before retained history was installed.
      for (const episode of before.values()) incidents.record(episode, now, true);
      for (const group of worklist.groups) {
        if (!group.issues.length) continue;
        // Unreadable credentials have no trustworthy grant identity. Do not
        // split a known shared account into a second fallback account alert.
        if (group.authentication === 'unknown' && group.connection_names.length) continue;
        const expiry = group.issues.find(i => i.code === 'secret_expiry')?.secret_expires_on;
        let episode = before.get(group.id);
        if (!episode || episode.status !== 'open' || episode.expiry_date !== expiry) {
          if (episode?.status === 'open') {
            episode.status = 'retired'; episode.retirement_reason = 'expiry_changed_or_removed'; episode.last_seen_at = now; write(episode, now);
          }
          cancelPending(group.id);
          episode = { id: randomUUID(), group_id: group.id, status: 'open', first_seen_at: now, last_seen_at: now,
            problem_since_at: now, present: true, issues: [], group, announced: false, ...(expiry ? { expiry_date: expiry } : {}) };
        }
        if (!episode.present) { episode.problem_since_at = now; episode.present = true; }
        // Repeated failure timestamps do not create new episodes or reminders.
        // Retain each failed use until a matching later success is observed.
        if (!worklist.unavailable.length && episode.issues.some(i => !byIssue.has(i.id))) episode.removed_uses = true;
        const prior = new Map(episode.issues.filter(i => worklist.unavailable.length || byIssue.has(i.id)).map(i => [i.id, i]));
        for (const issue of group.issues) prior.set(issue.id, issue);
        const required = new Map(requirements(episode).map(check => [checkKey(check), check]));
        for (const issue of group.issues) {
          const failures = (byIssue.get(issue.id) ?? []).filter(c => c.state === 'failed');
          for (const failed of failures.length ? failures : [{ id: issue.id, observed_at: issue.observed_at }]) {
            const key = checkKey(failed); const old = required.get(key);
            if (old) { old.failed_at = Math.max(old.failed_at, failed.observed_at ?? episode.first_seen_at); delete old.succeeded_at; }
            else if (required.size < 2048) required.set(key, { id: failed.id, ...('context' in failed && failed.context ? { context: failed.context } : {}),
              failed_at: failed.observed_at ?? episode.first_seen_at });
            else episode.verification_incomplete = true;
          }
        }
        episode.required_checks = [...required.values()]; observeSuccesses(episode);
        episode.issues = [...prior.values()]; episode.group = group; episode.last_seen_at = now;
        const level = expiry ? expiryLevel(expiry, now) : group.issues.some(i => i.code === 'credential_rejected') ? 'rejected' : 'review';
        const due = level && (level !== 'review' || now - episode.problem_since_at >= AUTHENTICATION_ALERT_GRACE_MS);
        const queued = db.prepare('SELECT data FROM authentication_alert_notices WHERE group_id = ?').get(group.id) as { data: string } | undefined;
        if (queued && (JSON.parse(queued.data) as AuthenticationAlertNotice).level !== level) {
          cancelPending(group.id); episode.last_level = episode.announced_level;
        }
        if (due && (!episode.last_level || levelRank[level] > levelRank[episode.last_level])) {
          enqueue(episode, 'problem', level, now); episode.last_level = level;
        }
        refreshPending(group);
        write(episode, now); before.delete(group.id);
      }
      for (const episode of before.values()) {
        const group = current.get(episode.group_id);
        if (group && !group.issues.length && episode.status === 'open') {
          cancelPending(episode.group_id); episode.present = false; episode.last_level = episode.announced_level;
          observeSuccesses(episode);
        }
        // Missing inventory can pause a notice, but cannot remove a failed
        // use, retire an account, or manufacture recovery.
        if (worklist.unavailable.length) {
          if (group && !group.issues.length && episode.status === 'open') write(episode, now);
          continue;
        }
        if (episode.status !== 'open') {
          if (!group) cancelPending(episode.group_id);
          else refreshPending(group);
          continue;
        }
        if (!group || episode.expiry_date) {
          const replaced = worklist.groups.some(current => current.id !== episode.group_id && current.targets.some(target =>
            target.kind !== 'oauth_apps' && episode.group.targets.some(old => JSON.stringify(old) === JSON.stringify(target))));
          episode.status = 'retired'; episode.retirement_reason = episode.expiry_date ? 'expiry_changed_or_removed'
            : replaced ? 'authentication_changed' : 'connection_removed';
          episode.last_seen_at = now; cancelPending(episode.group_id); write(episode, now); continue;
        }
        if (episode.removed_uses || episode.issues.some(i => !byIssue.has(i.id))) {
          // Removed/replaced uses retire the notice without claiming recovery.
          episode.status = 'retired'; episode.retirement_reason = 'use_removed_or_changed'; episode.last_seen_at = now; cancelPending(episode.group_id); write(episode, now); continue;
        }
        observeSuccesses(episode);
        const recovered = !episode.verification_incomplete && requirements(episode).every(check => check.succeeded_at !== undefined);
        // A pending problem that no longer exists is not pushed late. Its
        // episode remains until success, removal, or a new observed problem.
        cancelPending(episode.group_id);
        episode.present = false; episode.last_level = episode.announced_level;
        if (!recovered) { write(episode, now); continue; }
        episode.status = 'recovered'; episode.group = group; episode.last_seen_at = now;
        if (episode.announced) enqueue(episode, 'recovery', episode.last_level ?? 'review', now);
        write(episode, now);
      }
      // Closed episode rows are only deduplication state. Bound their lifetime;
      // the owner's notification history remains in the ordinary audit store.
      for (const episode of episodes()) if (episode.status !== 'open' && now - episode.last_seen_at > 30 * 86_400_000) {
        // A history-persistence failure must not strand an unclaimed notice
        // by removing the episode which gives its push claim authority.
        if (!db.prepare('SELECT 1 FROM authentication_alert_notices WHERE group_id = ?').get(episode.group_id)) {
          db.prepare('DELETE FROM authentication_alert_episodes WHERE group_id = ?').run(episode.group_id);
        }
      }
      incidents.prune(now);
    }).immediate,
    history: incidents.history,
    pending: () => (db.prepare('SELECT data FROM authentication_alert_notices ORDER BY rowid LIMIT 4096').all() as Array<{ data: string }>).map(r => JSON.parse(r.data) as AuthenticationAlertNotice),
    claim: db.transaction((id: string): boolean => {
      const row = db.prepare('SELECT data FROM authentication_alert_notices WHERE id = ?').get(id) as { data: string } | undefined;
      if (!row) return false;
      const notice = JSON.parse(row.data) as AuthenticationAlertNotice;
      const stored = db.prepare('SELECT data FROM authentication_alert_episodes WHERE group_id = ?').get(notice.group_id) as { data: string } | undefined;
      if (!stored) return false;
      const episode = JSON.parse(stored.data) as Episode;
      if (notice.kind === 'problem') { if (episode.status !== 'open') return false; episode.announced = true; episode.announced_level = notice.level; writeEpisode(episode); }
      else if (episode.status !== 'recovered') return false;
      db.prepare('DELETE FROM authentication_alert_notices WHERE id = ?').run(id);
      return true;
    }).immediate,
  };
};
