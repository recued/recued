import type { AuditLogStore } from '@recued/storage';
import type { NotificationBlock, NotificationMessage } from '@recued/notification';
import { CONNECTION_NAME_REGEX, type AuthenticationRepairTarget } from '@recued/contracts';
import { authenticationRepairTargetHasIssue, type AuthenticationRepairSnapshot } from './authentication-repair-worklist.js';
import { authenticationAlertGroupSignature, type AuthenticationAlertNotice, type AuthenticationAlertStore } from './authentication-alert-store.js';
import { PUSH_GRACE_MS, settleWithin, STOP_GRACE_MS } from './lifecycle/settle-within.js';

/** The same non-secret destinations as the repair worklist. Every target
 * still requires pairing and the existing owner-reviewed repair flow. */
export const authenticationRepairHash = (target?: AuthenticationRepairTarget): string => {
  if (target?.kind === 'connection' && CONNECTION_NAME_REGEX.test(target.name)) return '#connections/others/review-access/api/' + encodeURIComponent(target.name);
  if (target?.kind === 'collection') return '#connections/' + target.platform + '/' + encodeURIComponent(target.slug);
  if (target?.kind === 'file_source') return '#data/files/' + encodeURIComponent('remote:' + target.source_id);
  if (target?.kind === 'oauth_apps') return '#connections/others/oauth-apps';
  return '#connections';
};
const label = (text: string): string => text.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120);
const useKind = { pack: 'Pack', recipe: 'Recipe', dish: 'Dish', schedule: 'Schedule', mail: 'Mail', calendar: 'Calendar', file: 'Files' } as const;
export const authenticationAlertMessage = (notice: AuthenticationAlertNotice, publicBaseUrl?: string | null): {
  message: NotificationMessage; hash: string;
} => {
  const { group } = notice; const expiry = notice.level.startsWith('expiry_');
  const issues = notice.level === 'rejected' ? group.issues.filter(i => i.code === 'credential_rejected') : group.issues;
  const affected = group.targets.filter(t => authenticationRepairTargetHasIssue(group, t, issues));
  const sourceIssues = issues.filter(i => i.code === 'source_check_failed');
  const target = expiry ? group.targets.find(t => t.kind === 'oauth_apps')
    : affected.find(t => t.kind === 'file_source' && authenticationRepairTargetHasIssue(group, t, sourceIssues))
      ?? affected.find(t => t.kind === 'connection') ?? affected.find(t => t.kind === 'collection') ?? affected[0]
      ?? group.targets.find(t => t.kind === 'connection') ?? group.targets.find(t => t.kind === 'collection') ?? group.targets[0];
  const hash = authenticationRepairHash(target);
  const uses = [...group.uses].sort((a,b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const preview = uses.slice(0, 4).map(u => `${useKind[u.kind]}: ${label(u.label)}`).join('; ');
  const usage = (preview ? `\nKnown uses: ${preview}${uses.length > 4 ? `; and ${uses.length - 4} more` : ''}.` : '')
    + (!group.usage_available ? '\nThe list of affected uses may be incomplete.' : '');
  let title: string; let text: string;
  if (notice.kind === 'recovery') {
    title = 'Connection operation succeeded again';
    text = `${label(group.label)}: a later successful operation was recorded for every problem reported in this alert. Review the account for its current status. This does not verify every permission or replay failed work.`;
  } else if (expiry) {
    title = notice.level === 'expiry_passed' ? 'Saved app secret expiry date reached' : 'Saved app secret expiry is approaching';
    const date = group.issues.find(i => i.code === 'secret_expiry')?.secret_expires_on;
    text = `${label(group.label)}: the secret expiry date you recorded is ${date ?? 'unknown'}. Review usage and rotate the secret if needed. This date is a reminder; it does not prove that vendor access has stopped.`;
  } else if (notice.level === 'rejected') {
    title = 'Connection access was rejected';
    text = `${label(group.label)}: a saved check or background operation reported rejected sign-in or permissions. Open the account and choose Manage authentication to review and repair access.`;
  } else {
    title = 'Connection needs attention';
    text = `${label(group.label)}: a recorded access or configuration problem has remained for at least 15 minutes. A network, service or configuration problem may be the cause; an authentication cause is unconfirmed. Open the saved account or source to review its status.`;
  }
  return { hash, message: { title, text: text + usage,
    ...(publicBaseUrl ? { link_url: `${publicBaseUrl.replace(/\/+$/, '')}/${hash}` } : {}) } };
};

/** Durably record the owner's history before claiming a best-effort push.
 * Claimed pushes are never replayed on restart. The worker performs no vendor
 * requests, credential changes, automatic authorization, or job retries. */
export const createAuthenticationAlertRuntime = (deps: {
  store: AuthenticationAlertStore;
  read(): Promise<AuthenticationRepairSnapshot>;
  auditLog: Pick<AuditLogStore, 'logActivity'>;
  notifier: Pick<NotificationBlock, 'notify'>;
  getPublicBaseUrl?: () => string | null;
  canRun?: () => boolean;
  intervalMs?: number;
}) => {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined; let stopped = false;
  /** The claimed push in flight, if any (`stop`). */
  let pushing: Promise<void> | undefined;
  const deliverable = (snapshot: AuthenticationRepairSnapshot, notice: AuthenticationAlertNotice): boolean => {
    const group = snapshot.worklist.groups.find(g => g.id === notice.group_id);
    if (!group) return false;
    if (notice.kind === 'recovery') return !snapshot.worklist.unavailable.length && !group.issues.length;
    if (notice.level.startsWith('expiry_')) return group.issues.some(i => i.code === 'secret_expiry'
      && i.secret_expires_on === notice.group.issues.find(old => old.code === 'secret_expiry')?.secret_expires_on);
    return notice.level === 'rejected' ? group.issues.some(i => i.code === 'credential_rejected') : group.issues.length > 0;
  };
  const tick = (): Promise<void> => {
    if (stopped || deps.canRun?.() === false) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      let snapshot = await deps.read(); if (stopped || deps.canRun?.() === false) return;
      deps.store.evaluate(snapshot);
      let delivered = 0;
      for (const notice of deps.store.pending()) {
        if (delivered >= 10) break;
        if (stopped || deps.canRun?.() === false) return;
        if (!deliverable(snapshot, notice)) continue;
        const { message, hash } = authenticationAlertMessage(notice, deps.getPublicBaseUrl?.());
        await deps.auditLog.logActivity({ activity_id: notice.id, timestamp: notice.created_at, action: 'notification_fired', target: notice.group_id,
          detail: JSON.stringify({ ...message, link_url: message.link_url ?? hash }) });
        if (stopped || deps.canRun?.() === false) return;
        // The owner may repair/remove a connection while history persistence
        // yields. Re-read before the atomic push claim, never re-use stale state.
        snapshot = await deps.read(); if (stopped || deps.canRun?.() === false) return;
        deps.store.evaluate(snapshot);
        const currentGroup = snapshot.worklist.groups.find(group => group.id === notice.group_id);
        if (currentGroup && authenticationAlertGroupSignature(currentGroup) !== authenticationAlertGroupSignature(notice.group)) continue;
        if (!deliverable(snapshot, notice) || !deps.store.claim(notice.id)) continue;
        delivered += 1;
        const push = (async () => deps.notifier.notify(message, undefined, { persisted_activity_id: notice.id, ui_link_url: hash }))();
        pushing = push;
        try { await push; }
        catch { /* Best-effort external delivery; durable owner history exists. */ }
        finally { pushing = undefined; }
      }
    })().catch(() => { console.warn('[authentication-alerts] local status or notification history is unavailable; retrying on the next check'); })
      .finally(() => { running = undefined; });
    return running;
  };
  return {
    tick,
    start(): void {
      if (stopped || timer) return;
      timer = setInterval(() => { void tick(); }, deps.intervalMs ?? 60_000); timer.unref(); void tick();
    },
    /** Claim no further notice, and wait for the check in progress at most
     *  `STOP_GRACE_MS` — `PUSH_GRACE_MS` while a claimed push is in flight.
     *
     *  An unclaimed notice stays in the store and is sent by the first tick
     *  after the restart. A claimed one is never sent again: "Claimed pushes
     *  are never replayed on restart" (above), and `notify()` keeps no outbox.
     *  So its push gets the longer grace, and one still going after it is cut
     *  by the exit after the drain, leaving only its history row: waiting on
     *  would run out the drain step, which makes an update refuse to swap. */
    async stop(): Promise<void> {
      stopped = true; if (timer) clearInterval(timer); timer = undefined;
      if (running) await settleWithin(running, pushing !== undefined ? PUSH_GRACE_MS : STOP_GRACE_MS);
    },
  };
};
