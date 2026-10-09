import {
  MAIL_WORK_CLAIM_KINDS, type MailWorkClaimKind, type MailWorkCreateRequest, type MailWorkDetail,
  type MailWorkEmailRef, type MailWorkListRequest, type MailWorkListResult, type MailWorkSearchResult, type MailWorkUpdateRequest,
} from '@recued/contracts';
import { serializeShellRoute, serializeSourceRecordAddress } from '../shell/route.js';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import { MAIL_WORK_INTENTS, mailWorkChatPrompt, type MailWorkChatHandoff, type MailWorkIntent } from './mail-work-investigation.js';

export interface MailWorkCallers {
  list(args: MailWorkListRequest): Promise<MailWorkListResult>;
  get(args: { id: string }): Promise<MailWorkDetail>;
  create(args: MailWorkCreateRequest): Promise<MailWorkDetail>;
  update(args: MailWorkUpdateRequest): Promise<MailWorkDetail>;
  delete(args: { id: string; expected_revision: number }): Promise<{ id: string; deleted: true }>;
  review(args: { id: string; expected_revision: number }): Promise<MailWorkDetail>;
  search(args: { query: string }): Promise<MailWorkSearchResult>;
  openChat(args: { creation_id: string; title: string }): Promise<{ session_id: string }>;
}
export interface MailWorkRouteOptions {
  root: HTMLElement;
  segments: readonly string[];
  callers: MailWorkCallers;
  explore(handoff: MailWorkChatHandoff): void;
  /** Leaves this page, for example after deleting its work. Defaults to the address bar. */
  navigate?(hash: string): void;
  pollMs?: number;
}
const e = (value: string): string => value.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
export const mailWorkEmailHref = (email: MailWorkEmailRef): string => serializeSourceRecordAddress({ tab: 'mail', collectionSlug: email.slug, recordId: email.record_id });
export const mailWorkFollowHref = (email: MailWorkEmailRef): string => serializeShellRoute('mail', 'follow', email.slug, email.record_id);
const workHref = (id: string): string => serializeShellRoute('mail', 'work', id);
// Separate investigations of one conversation share its subject as their name,
// so work rows also say when each was updated.
const updated = (at: number): string => `Updated ${new Date(at).toLocaleString()}`;
/** A server from before following work has no such calls, and the webclient
 * updates separately. Say what to do instead of naming the missing call. */
const errorCopy = (caught: unknown): string => classifyRpcError(caught).code === 'unknown_method'
  ? 'Update this server to follow work.' : humanizeRpcError(caught);
const labels: Record<MailWorkClaimKind, string> = {
  request: 'What is being asked', agreement: 'What is agreed', progress: 'Progress and changes', dependency: 'Waiting on',
  question: 'Uncertainties and questions', next_action: 'Possible next steps', completion_condition: 'What would count as done',
};
const STYLES = `
.mail-work { max-width: 960px; margin: 0 auto; padding: 24px; color: var(--fg); }
.mail-work header, .mail-work .work-actions { display:flex; flex-wrap:wrap; align-items:center; gap:12px; margin:14px 0; }
.mail-work h1 { font-size:24px; margin:12px 0; } .mail-work h2 { font-size:19px; margin:24px 0 10px; }
.mail-work h3 { font-size:15px; margin:18px 0 8px; }
.mail-work p, .mail-work li { line-height:1.55; } .mail-work small { color:var(--fg-muted); }
.mail-work label { display:block; font-weight:500; margin:12px 0; }
.mail-work input, .mail-work textarea, .mail-work select { box-sizing:border-box; display:block; width:100%; margin-top:6px; padding:10px; border:1px solid var(--border); border-radius:6px; color:inherit; background:var(--surface); font:inherit; }
.mail-work textarea { min-height:84px; resize:vertical; }
.mail-work a { color:var(--rx-accent, var(--accent, #0e7490)); }
.mail-work button { padding:8px 14px; cursor:pointer; border:1px solid var(--border); border-radius:6px; background:var(--surface, white); color:inherit; font:inherit; }
.mail-work button[data-work-action=explore], .mail-work button[data-work-action=create] { color:var(--on-accent); background:var(--accent, #0e7490); border-color:transparent; }
.mail-work button[data-work-action=confirm-delete] { color:var(--on-danger); background:var(--danger, #b84138); border-color:transparent; }
.mail-work button:hover:not(:disabled) { filter:brightness(.96); } .mail-work button:disabled { cursor:wait; opacity:.6; }
.mail-work .work-card { border:1px solid var(--border); border-radius:8px; padding:16px; margin:10px 0; overflow-wrap:anywhere; }
.mail-work .work-card a { text-decoration:underline; } .mail-work .work-meta { display:block; margin-top:5px; }
.mail-work .work-notice { border-left:3px solid var(--accent, #7182bb); padding:10px 14px; background:var(--surface); }
.mail-work [role=alert] { color:var(--danger, #b84138); } .mail-work ul { padding-left:22px; }
.mail-work .work-evidence { display:flex; flex-wrap:wrap; gap:8px; font-size:12px; margin:4px 0 12px; }
.mail-work :focus-visible { outline:2px solid var(--accent, #7182bb); outline-offset:3px; }
@media(max-width:600px) { .mail-work { padding:14px; } }
`;

export const bootstrapMailWorkRoute = (opts: MailWorkRouteOptions) => {
  const { root, callers } = opts;
  const doc = root.ownerDocument;
  const seed = opts.segments[0] === 'follow' && opts.segments.length === 3
    ? { slug: opts.segments[1]!, record_id: opts.segments[2]! } : null;
  const id = opts.segments[0] === 'work' && opts.segments.length === 2 ? opts.segments[1]! : null;
  const valid = seed !== null || (opts.segments[0] === 'work' && opts.segments.length <= 2);
  const requestId = crypto.randomUUID();
  let current: MailWorkDetail | null = null;
  let matches: MailWorkListResult['works'] = [];
  let page: MailWorkListResult = { works: [], next_cursor: null };
  let found: MailWorkSearchResult | null = null;
  let query = '';
  let intent: MailWorkIntent = 'orient';
  let draft = { title: '', goal: '', owner_notes: '', resolution_note: '' };
  let dirty = false;
  let busy = false;
  let loading = valid;
  let disposed = false;
  let generation = 0;
  let remoteChanged = false;
  let error = '';
  // Delete asks about the version on screen; a reloaded version needs a new answer.
  let deleteAsked: number | null = null;
  let deleteError = '';
  let deleted = false;
  let focusAction: string | null = null;
  const setCurrent = (detail: MailWorkDetail): void => {
    current = detail;
    const work = detail.work;
    draft = { title: work.title, goal: work.goal, owner_notes: work.owner_notes, resolution_note: work.resolution_note };
    dirty = false; remoteChanged = false;
  };
  const button = (action: string, label: string, attrs = ''): string => `<button type="button" data-work-action="${action}" ${attrs} ${busy || loading ? 'disabled' : ''}>${e(label)}</button>`;
  const field = (name: keyof typeof draft, label: string, max: number, multiline = true): string => `<label>${e(label)}${multiline
    ? `<textarea data-work-field="${name}" maxlength="${max}" ${busy ? 'disabled' : ''}>${e(draft[name])}</textarea>`
    : `<input data-work-field="${name}" maxlength="${max}" value="${e(draft[name])}" ${busy ? 'disabled' : ''}>`}</label>`;
  const link = (email: MailWorkEmailRef, label: string): string => `<a href="${e(mailWorkEmailHref(email))}">${e(label)}</a>`;
  const intentField = (): string => `<label>What would help now? (optional)<select data-work-intent ${busy ? 'disabled' : ''}>${Object.entries(MAIL_WORK_INTENTS).map(([key, label]) => `<option value="${key}" ${key === intent ? 'selected' : ''}>${e(label)}</option>`).join('')}</select></label>`;
  const paint = (): void => {
    if (disposed) return;
    const active = doc.activeElement;
    const focused = active && root.contains(active) ? active.getAttribute('data-work-field') : null;
    const selection = focused && active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] : null;
    let content = '';
    if (!valid) content = '<p role="alert">This work address is incomplete. Open an email to start following it.</p>';
    else if (seed) {
      content = `<h1>Follow this work</h1><p>Opening Chat from ${link(seed, 'this email')}. Recued will investigate the conversation and relevant attachments there.</p>`;
      if (matches.length > 1 && !current) content = `<h1>Choose an investigation</h1><p>This conversation is followed in more than one Chat.</p>
        ${matches.map((work, index) => `<div class="work-card">${button('resume', work.title, `data-index="${index}" aria-describedby="mail-work-choice-${index}"`)}<small class="work-meta" id="mail-work-choice-${index}">${e(work.status)} · ${e(updated(work.updated_at))}</small></div>`).join('')}
        ${button('separate', 'Start a separate investigation')}`;
      if (current && error) content += `<p>Your work is saved: <a href="${e(workHref(current.work.id))}">${e(current.work.title)}</a>.</p>`;
      if (error) content += button('retry-entry', 'Try again');
    } else if (id && current) {
      const { work } = current;
      content = `<h1>${e(work.title)}</h1><small>${e(work.status)} · Updated ${e(new Date(work.updated_at).toLocaleString())}</small>
        ${work.goal ? `<p>${e(work.goal)}</p>` : ''}
        <p class="work-notice" data-work-updates>${remoteChanged ? 'This work was edited elsewhere. Reload the saved version before saving.' : current.needs_review ? 'Mail or context has changed. Review it to update the current understanding.' : 'The current mail matches the last review.'}</p>
        ${intentField()}<div class="work-actions">${button('explore', 'Investigate in Chat')}${button('open-chat', 'Open investigation')}${button('separate-current', 'Start a separate investigation')}${button('reload', 'Reload saved version')}</div>
        <p><small>Investigate rereads the current context and starts a new Chat turn. Open investigation returns to the saved conversation.</small></p>
        <details ${!work.brief || dirty ? 'open' : ''}><summary>Your outcome and context</summary>${field('title', 'Name', 200, false)}
          ${field('goal', 'Desired outcome', 4000)}${field('owner_notes', 'Your context, corrections and offline decisions', 12000)}
          ${button('save', 'Save context')}</details>
        <h2>Linked mail review</h2><p><small>This review covers the conversations linked below. The wider investigation and its findings are saved in Chat.</small></p>
        ${button('review', busy ? 'Working…' : 'Review with AI', work.status !== 'active' ? 'disabled' : '')}`;
      if (!work.brief) content += '<p>No review yet. Ask Recued to reconstruct the work from the linked conversations.</p>';
      else {
        content += `<p><small>AI interpretation · Reviewed ${e(new Date(work.brief.reviewed_at).toLocaleString())}. Check the evidence and add corrections above.</small></p>`;
        for (const kind of MAIL_WORK_CLAIM_KINDS) {
          const claims = work.brief.claims.filter(claim => claim.kind === kind);
          if (!claims.length) continue;
          content += `<section><h3>${labels[kind]}</h3><ul>${claims.map(claim => `<li>${e(claim.text)}
            <div class="work-evidence"><span>${claim.basis === 'inference' ? 'AI inference' : claim.basis === 'owner' ? 'Your context' : 'Email evidence'}</span>
            ${claim.evidence.map(ref => link(ref, current!.sources.find(source => source.slug === ref.slug && source.record_id === ref.record_id)?.subject || 'Source email')).join('')}</div></li>`).join('')}</ul></section>`;
        }
      }
      const warnings = [...new Set([...current.warnings, ...(work.brief?.warnings ?? [])])];
      if (warnings.length) content += `<details><summary>Limits of this review (${warnings.length})</summary><ul>${warnings.map(warning => `<li>${e(warning)}</li>`).join('')}</ul></details>`;
      content += `<h2>Linked conversations</h2><p><small>Each conversation can belong to more than one work item. Remove a link if it belongs to different work.</small></p>
        ${work.threads.map((thread, index) => `<div class="work-card">${link({ slug: thread.slug, record_id: thread.seed_record_id }, thread.subject)}
          <small class="work-meta">${e(thread.slug)}</small>${work.threads.length > 1 ? button('unlink', 'Remove from this work', `data-index="${index}"`) : ''}</div>`).join('')}
        <details><summary>Messages in scope (${current.sources.length})</summary><ul>${current.sources.map(source => `<li>${link(source, source.subject || 'Untitled email')} <small>${e(source.from)} · ${e(source.date)}${source.changed ? ' · New or changed since review' : ''}</small></li>`).join('')}</ul></details>
        <h3>Find related conversations</h3><p>Search client names, project references or phrases coworkers might use. Check each match before linking it.</p>
        ${work.brief?.search_queries.length ? `<div class="work-actions">${work.brief.search_queries.map((term, index) => button('suggested-search', term, `data-index="${index}"`)).join('')}</div>` : ''}
        <label>Search mail<input data-work-search value="${e(query)}" maxlength="240" ${busy ? 'disabled' : ''}></label>${button('search', 'Search conversations')}`;
      if (found) {
        content += found.warnings.map(warning => `<p class="work-notice">${e(warning)}</p>`).join('');
        content += found.emails.length ? found.emails.map((email, index) => {
          const linked = work.threads.some(thread => thread.slug === email.slug && (thread.thread_id === null ? thread.seed_record_id === email.record_id : thread.thread_id === email.thread_id));
          return `<div class="work-card">${link(email, email.subject || 'Untitled email')}<small class="work-meta">${e(email.from)} · ${e(email.slug)}</small>
            ${linked ? '<small>Already linked</small>' : button('link', 'Link conversation', `data-index="${index}"`)}</div>`;
        }).join('') : '<p>No matching conversations were found.</p>';
      }
      content += `<h2>Resolution</h2>${field('resolution_note', 'How was this resolved, or what changed?', 4000)}
        <div class="work-actions">${work.status === 'active' ? button('resolve', 'Mark resolved') + button('archive', 'Archive') : button('reopen', 'Reopen work')}</div>
        <p><small>Resolving this work records your decision. Any separate commitments keep their own status.</small></p>`;
      content += deleteAsked === work.revision
        ? `<div class="work-notice" role="group" aria-label="Delete followed work"><p>Delete this followed work? Its notes and AI review are removed. The Chat stays; delete it in Chat if you want.</p>
          ${deleteError ? `<p role="alert">${e(deleteError)}</p>` : ''}<div class="work-actions">${button('confirm-delete', 'Delete')}${button('cancel-delete', 'Cancel')}</div></div>`
        : `<div class="work-actions">${button('delete', 'Delete followed work')}</div>`;
    } else if (id && deleted) {
      content = '<p role="status">This followed work was deleted.</p>';
    } else if (!id) {
      content = `<h1>Work you’re following</h1><p>Follow work from any email, whether you need a plan, a progress update, or help wrapping up and revisiting it.</p>
        <a href="${serializeShellRoute('data', 'mail')}">Open mail to start following work →</a><div class="work-actions">${button('reload', 'Check for updates')}</div>
        ${page.works.map(work => `<article class="work-card"><a href="${e(workHref(work.id))}">${e(work.title)}</a><small class="work-meta">${e(work.status)} · ${e(updated(work.updated_at))}${work.needs_review ? ' · Needs review' : ''}</small></article>`).join('')}
        ${!loading && !page.works.length && !error ? '<p>No work is being followed yet.</p>' : ''}${page.next_cursor ? button('more', 'More work') : ''}`;
    }
    root.innerHTML = `<style>${STYLES}</style><section class="mail-work"><header><a href="${serializeShellRoute('mail')}">Mail</a> / <a href="${serializeShellRoute('mail', 'work')}">Following work</a></header>
      ${error ? `<p role="alert">${e(error)}</p>${!current && id ? button('reload', 'Try again') : ''}` : ''}
      ${loading ? '<p role="status">Loading work…</p>' : ''}${busy ? '<p role="status">Working…</p>' : ''}${content}</section>`;
    if (focused) {
      const input = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-work-field="${focused}"]`);
      input?.focus();
      if (selection && input instanceof HTMLTextAreaElement) input.setSelectionRange(selection[0]!, selection[1]!);
    } else if (focusAction) root.querySelector<HTMLElement>(`[data-work-action="${focusAction}"]`)?.focus();
    focusAction = null;
  };
  const load = async (more = false): Promise<void> => {
    if (disposed || !valid) return;
    const turn = ++generation;
    loading = true; error = ''; paint();
    try {
      if (seed) {
        if (current) { await enterChat(false, true); return; }
        const value = await callers.list({ email: seed });
        if (disposed || turn !== generation) return;
        if (value.matched_email?.slug !== seed.slug || value.matched_email.record_id !== seed.record_id) {
          throw new Error('Update this server to open a Chat from this email. Its existing investigations have not been changed.');
        }
        matches = value.works;
        if (matches.length > 1) return;
        const selected = matches[0];
        const detail = selected ? await callers.get({ id: selected.id }) : await callers.create({ request_id: requestId, email: seed });
        if (disposed || turn !== generation) return;
        setCurrent(detail);
        await enterChat(!selected && !detail.existing_work, true);
      } else if (id) {
        const value = await callers.get({ id });
        if (disposed || turn !== generation) return;
        setCurrent(value);
      } else {
        const value = await callers.list(more && page.next_cursor ? { before: page.next_cursor } : {});
        if (disposed || turn !== generation) return;
        page = more ? { works: [...new Map([...page.works, ...value.works].map(work => [work.id, work])).values()], next_cursor: value.next_cursor } : value;
      }
    } catch (caught) { if (!disposed && turn === generation) error = errorCopy(caught); }
    finally { if (!disposed && turn === generation) { loading = false; paint(); } }
  };
  const save = async (extra: Partial<MailWorkUpdateRequest> = {}): Promise<void> => {
    if (!current) return;
    const value = await callers.update({ id: current.work.id, expected_revision: current.work.revision, ...draft, ...extra });
    if (!disposed) setCurrent(value);
  };
  const enterChat = async (investigate: boolean, initial = false, selected = current): Promise<void> => {
    if (!selected || disposed) return;
    if (!selected.chat_session_id) throw new Error('Update this server to start a saved work investigation. Your work is saved.');
    const { session_id } = await callers.openChat({ creation_id: selected.chat_session_id, title: selected.work.title });
    if (disposed) return;
    // Session creation can be slow; use the latest owner context after it.
    const latest = await callers.get({ id: selected.work.id });
    if (disposed) return;
    if (!id || latest.work.id === id) setCurrent(latest);
    busy = false;
    // Empty saved Chats can resume a failed handoff. Existing conversations open
    // without another turn. Initial submissions retain ordinary queue deduplication.
    const submit = initial ? latest.investigation_started === false || (latest.investigation_started === undefined && investigate) : investigate;
    // The follow address is a handoff, not a place. Chat takes its history entry,
    // so Back returns to the email instead of running the handoff again.
    opts.explore({ sessionId: session_id, ...(submit ? { prompt: mailWorkChatPrompt(latest, intent), repeat: !initial,
      mailWork: { seeds: latest.work.threads.map(thread => ({ slug: thread.slug, record_id: thread.seed_record_id, thread_id: thread.thread_id })) } } : {}), ...(seed ? { replace: true } : {}) });
  };
  const run = async (action: string, index: number): Promise<void> => {
    if (busy || loading) return;
    busy = true; error = ''; paint();
    try {
      if (action === 'resume' && matches[index]) {
        const detail = await callers.get({ id: matches[index]!.id });
        if (disposed) return;
        setCurrent(detail); await enterChat(false, true);
      } else if ((action === 'separate' && seed) || (action === 'separate-current' && current)) {
        if (dirty) await save();
        if (disposed) return;
        const thread = current?.work.threads[0];
        const email = seed ?? { slug: thread!.slug, record_id: thread!.seed_record_id };
        const detail = await callers.create({ request_id: requestId, email, separate: true });
        if (disposed) return;
        if (seed) setCurrent(detail);
        await enterChat(true, true, detail);
      } else if (action === 'reload' || action === 'more' || action === 'retry-entry') { await load(action === 'more'); }
      else if (action === 'save') await save();
      else if (action === 'review' && current) {
        if (dirty) await save();
        if (disposed) return;
        const value = await callers.review({ id: current.work.id, expected_revision: current.work.revision });
        if (!disposed) setCurrent(value);
      } else if ((action === 'explore' || action === 'open-chat') && current) {
        if (dirty) await save();
        await enterChat(action === 'explore');
      } else if (action === 'search' || action === 'suggested-search') {
        if (action === 'suggested-search') query = current?.work.brief?.search_queries[index] ?? '';
        if (query.trim()) { const result = await callers.search({ query }); if (!disposed) found = result; }
      } else if (action === 'link' && found?.emails[index]) await save({ link_email: found.emails[index] });
      else if (action === 'unlink' && current?.work.threads[index]) await save({ unlink_thread: current.work.threads[index] });
      else if (action === 'resolve') await save({ status: 'resolved' });
      else if (action === 'archive') await save({ status: 'archived' });
      else if (action === 'reopen') await save({ status: 'active' });
      else if ((action === 'delete' || action === 'cancel-delete') && current) {
        deleteAsked = action === 'delete' ? current.work.revision : null;
        deleteError = '';
        focusAction = action === 'delete' ? 'cancel-delete' : 'delete';
      } else if (action === 'confirm-delete' && current && deleteAsked === current.work.revision) {
        try { await callers.delete({ id: current.work.id, expected_revision: current.work.revision }); }
        catch (caught) {
          // Shown beside the question: it sits at the end of a long page.
          if (!disposed) deleteError = classifyRpcError(caught).code === 'unknown_method'
            ? 'Update your server to delete followed work.' : humanizeRpcError(caught);
          focusAction = 'cancel-delete';
          return;
        }
        if (disposed) return;
        // Nothing is left to save or finish, so leaving needs no confirmation.
        current = null; deleted = true; dirty = false; busy = false;
        const list = serializeShellRoute('mail', 'work');
        if (opts.navigate) opts.navigate(list);
        else { const location = doc.defaultView?.location; if (location) location.hash = list; }
      }
    } catch (caught) { if (!disposed) error = errorCopy(caught); }
    finally { if (!disposed) { busy = false; paint(); } }
  };
  const click = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const control = target.closest<HTMLElement>('[data-work-action]');
    if (control) void run(control.dataset.workAction!, Number(control.dataset.index ?? -1));
  };
  const input = (event: Event): void => {
    const target = event.target;
    if (target instanceof HTMLSelectElement && target.hasAttribute('data-work-intent')) {
      if (Object.hasOwn(MAIL_WORK_INTENTS, target.value)) intent = target.value as MailWorkIntent;
      return;
    }
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return;
    if (target.hasAttribute('data-work-search')) query = target.value;
    const name = target.getAttribute('data-work-field');
    if (name === 'title' || name === 'goal' || name === 'owner_notes' || name === 'resolution_note') { draft[name] = target.value; dirty = true; }
  };
  root.addEventListener('click', click); root.addEventListener('input', input);
  paint();
  const loaded = load();
  let polling = false;
  const timer = setInterval(() => {
    if (disposed || busy || loading || polling || doc.visibilityState === 'hidden') return;
    if (!id || !current || current.work.status !== 'active') return;
    polling = true;
    const revision = current.work.revision;
    const turn = generation;
    void callers.get({ id }).then(value => {
      if (disposed || busy || loading || turn !== generation || current?.work.revision !== revision) return;
      if (value.work.revision !== revision) remoteChanged = true;
      else { current = value; }
      // Polling never replaces form controls or discards unsaved context.
      const notice = root.querySelector('[data-work-updates]');
      if (notice) notice.textContent = remoteChanged ? 'This work was edited elsewhere. Reload the saved version before saving.'
        : value.needs_review ? 'Mail or context has changed. Review it to update the current understanding.' : 'The current mail matches the last review.';
    }, () => {
      const notice = root.querySelector('[data-work-updates]');
      if (!disposed && !busy && !loading && turn === generation && current?.work.revision === revision && notice) notice.textContent = 'Could not check for new mail. Reload to try again.';
    }).finally(() => { polling = false; });
  }, opts.pollMs ?? 30_000);
  return {
    refresh: () => dirty ? Promise.resolve() : load(), whenLoaded: () => loaded,
    hasUnsavedChanges: () => dirty,
    unsavedChangesPrompt: () => dirty ? 'Your work context has unsaved changes. Leave without saving?' : null,
    hasInFlightWork: () => busy,
    inFlightWorkPrompt: () => busy ? 'This work is still being saved or reviewed. Leave anyway?' : null,
    dispose() { disposed = true; generation++; clearInterval(timer); root.removeEventListener('click', click); root.removeEventListener('input', input); root.replaceChildren(); },
  };
};
