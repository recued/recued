import { mailFollowUpHref, mailFollowUpTimeHref, mailFollowUpLabel, type MailFollowUp, type MailFollowUpCursor } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import { readFollowUpPage, followUpNeedsAttention, followUpResultHref, type MailFollowUpListCaller } from '../mail/mail-follow-up-search.js';

/** A read-only projection of owner watches. Rendering Today never checks a
 * thread, creates a draft, or changes a watch's scheduled time. */
export const createTodayFollowUps = (opts: { list?: MailFollowUpListCaller; now(): number; changed(): void }) => {
  let rows: MailFollowUp[] = [], loading = false, loaded = false, error: string | undefined;
  /** ⛔ A server without reply watches (one not yet updated answers `unknown_method`; one with the service
   *  unwired, `not_configured`) has none to show: the card stays away and Today's empty state and freshness
   *  check are not held by it. Found at the 26.11.26 cut: an older server kept an alert on Today, hid
   *  "Nothing is due" and failed every return-to-Today check. Each load still asks, so an update brings it in. */
  let absent = false;
  let generation = 0, disposed = false;
  const load = async (): Promise<void> => {
    if (!opts.list || disposed) return;
    const token = ++generation, at = opts.now(), found = new Map<string, MailFollowUp>();
    let cursor: MailFollowUpCursor | null = null;
    loading = true; error = undefined; opts.changed();
    try {
      // There can be at most 256 active watches. The server applies the active
      // attention filter before paging, so terminal history cannot hide one.
      for (let pages = 0; pages < 6; pages++) {
        const page = await readFollowUpPage(opts.list, { attention_at: at, ...(cursor ? { cursor } : {}) });
        if (disposed || token !== generation) return;
        for (const watch of page.watches) {
          if (!followUpNeedsAttention(watch, at)) throw Error('The reply watch summary could not be confirmed. Refresh and try again.');
          found.set(watch.id, watch);
        }
        cursor = page.next_cursor;
        if (!cursor) break;
      }
      if (cursor) throw Error('Some reply watches are still missing. Refresh to check again.');
      rows = [...found.values()].sort((a, b) => a.check_at - b.check_at || a.id.localeCompare(b.id)); loaded = true; absent = false;
    } catch (cause) {
      if (disposed || token !== generation) return;
      const code = classifyRpcError(cause).code;
      if (code === 'unknown_method' || code === 'not_configured') { absent = true; rows = []; }
      else error = humanizeRpcError(cause);
    }
    if (disposed || token !== generation) return;
    loading = false; opts.changed();
  };
  return {
    load,
    loading: () => loading,
    canClaimEmpty: () => !opts.list || absent || loaded && !loading && !error && rows.length === 0,
    current: () => !opts.list || absent || loaded && !loading && !error,
    render(actionAttr: string): string {
      if (!opts.list || absent) return '';
      const time = (at: number) => `<time datetime="${new Date(at).toISOString()}">${e(new Date(at).toLocaleString())}</time>`;
      return `<section class="today-reminders" aria-label="Reply watches" data-today-follow-ups aria-busy="${loading}">
        <header class="today-reminders-header"><div><h2>Reply watches</h2><p>Due checks, ready drafts, and watches needing attention · All mailboxes</p></div>
          <button type="button" class="today-refresh" ${actionAttr}="today-follow-ups-refresh" aria-disabled="${loading}">Refresh reply watches</button></header>
        ${loading ? `<p role="status">${loaded ? 'Updating reply watches. These are the last confirmed results.' : 'Loading reply watches…'}</p>` : ''}
        ${error ? `<p role="alert">${e(error)} <a href="#mail">Open Mail</a></p>` : ''}
        ${loaded && !loading && !error && !rows.length ? '<p>No reply watches need attention.</p>' : ''}
        ${rows.length ? `<ul class="today-list">${rows.map(watch => `<li class="today-row" data-today-follow-up="${e(watch.id)}">${time(watch.check_at)}<div>
          <a href="${e(followUpResultHref(watch))}">${e(watch.subject || '(No subject)')}</a>
          <div class="today-meta">${e(watch.state === 'waiting' ? 'Check due' : mailFollowUpLabel(watch))} · ${e(watch.mail_ref.slug)}</div>
          ${watch.state === 'delivery_failed' && watch.delivery_failure ? `<p>Reported reason: ${e(watch.delivery_failure.reason ?? watch.delivery_failure.status)}.</p>` : ''}
          ${watch.detail ? `<p>${e(watch.detail)}</p>` : ''}
          <p class="today-meta">${watch.checked_at !== undefined ? `Last checked ${time(watch.checked_at)}` : 'Not checked yet'}. Checks use synced messages.</p>
          <div class="today-task-actions">${watch.state === 'delivery_failed' && watch.delivery_failure ? `<a href="${e(followUpResultHref(watch))}" aria-label="Open delivery report for ${e(watch.subject)}">Open delivery report</a>` : ''}${watch.state === 'draft_ready' && watch.draft_id ? `<a href="${e(followUpResultHref(watch))}" aria-label="Open draft for ${e(watch.subject)}">Open draft</a>` : ''}
            <a href="${e(mailFollowUpHref(watch.id))}" aria-label="Check now: ${e(watch.subject)}">Check now</a>
            ${!watch.delivery_failure ? `<a href="${e(mailFollowUpTimeHref(watch.id))}" aria-label="${watch.draft_id ? 'Snooze' : 'Change time'}: ${e(watch.subject)}">${watch.draft_id ? 'Snooze' : 'Change time'}</a>` : ''}</div>
        </div></li>`).join('')}</ul>` : ''}</section>`;
    },
    dispose() { disposed = true; generation++; },
  };
};
