import type { CollectionRecord, MailMessageState, MailMessageStateChange } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import type { DataCollectionGetCaller } from './bootstrap-data-route.js';
import type { MailMessageCallers } from './mail-message-surface.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

type Change = MailMessageStateChange['change'];
type Binding = Pick<CollectionRecord, 'record_id' | 'source_id' | 'received_at'> & { rfc: unknown; thread: unknown };
type Selected = { binding: Binding; subject: string; sender: string; identity?: string; state?: MailMessageState; checking: boolean; error?: string };
type Outcome = { email: Selected; state: 'waiting' | 'running' | 'confirmed' | 'failed' | 'unconfirmed'; message?: string };
export const MAIL_BULK_FOCUS = 'data-mail-bulk-focus';
export const MAIL_BULK_LIMIT = 100;
const binding = (row: CollectionRecord): Binding => ({ record_id: row.record_id, source_id: row.source_id,
  received_at: row.received_at, rfc: row.hot_fields.rfc_message_id ?? null, thread: row.hot_fields.thread_id ?? null });
const sameRecord = (row: CollectionRecord | null, original: Binding): row is CollectionRecord => !!row
  && row.record_id === original.record_id && row.source_id === original.source_id && row.received_at === original.received_at
  && (row.hot_fields.rfc_message_id ?? null) === original.rfc && (row.hot_fields.thread_id ?? null) === original.thread;
const verified = (state: MailMessageState | undefined): state is MailMessageState & { identity: string } => !!state
  && state.verified === true && typeof state.identity === 'string' && /^[a-f0-9]{64}$/i.test(state.identity)
  && typeof state.is_read === 'boolean' && typeof state.is_flagged === 'boolean';
const allowed = (state: MailMessageState, change: Change): boolean => (change.kind === 'read' ? state.can_mark : state.can_flag) === true;
const achieved = (state: MailMessageState, change: Change): boolean => (change.kind === 'read' ? state.is_read : state.is_flagged) === change.value;
const changedIdentity = 'This email or mailbox changed. Clear this selection and select it again.';
const label = (change: Change): string => change.kind === 'read' ? change.value ? 'Mark read' : 'Mark unread' : change.value ? 'Star' : 'Remove stars';

/** Selection binds each email before the owner chooses a change. Every write
 * then checks that binding again and uses the existing guarded mail RPC. */
export const createMailBulkActions = (deps: {
  view: () => { scope: string; slug: string; records: readonly CollectionRecord[]; ready: boolean } | null;
  get?: DataCollectionGetCaller;
  mail?: MailMessageCallers;
  render: () => void;
  begin: () => void;
  confirmed: (record: CollectionRecord) => void;
}) => {
  const selected = new Map<string, Selected>();
  let scope: string | null = null, results: Outcome[] = [], change: Change | null = null;
  let busy = false, stopping = false, disposed = false, review = false, error = '';
  let focusRequest: string | null = null, pending = Promise.resolve();
  const queue: Selected[] = [], reads = new Set<Promise<void>>();
  const enabled = (): boolean => !!deps.get && !!deps.mail?.get && !!deps.mail.updateState;
  const paint = (): void => { if (!disposed) deps.render(); };
  const reset = (): void => {
    if (busy) return;
    selected.clear(); queue.length = 0; scope = null; results = []; change = null; review = false; error = ''; focusRequest = null;
  };
  const view = () => {
    const current = deps.view();
    if (!busy && scope !== null && current?.scope !== scope) reset();
    return current;
  };
  const owns = (email: Selected): boolean => !disposed && deps.view()?.scope === scope && selected.get(email.binding.record_id) === email;
  const fresh = async (email: Selected, slug: string) => {
    const [{ record }, message] = await Promise.all([
      deps.get!({ platform: 'mail', slug, record_id: email.binding.record_id }),
      deps.mail!.get!({ slug, record_id: email.binding.record_id }),
    ]);
    if (!sameRecord(record, email.binding) || message.slug !== slug || message.record_id !== email.binding.record_id) throw new Error(changedIdentity);
    if (!verified(message.state)) throw new Error(message.state?.unavailable_reason ?? 'Email status could not be verified. Recheck before changing it.');
    if (email.identity !== undefined && email.identity !== message.state.identity) throw new Error(changedIdentity);
    return { record, state: message.state };
  };
  const pump = (): void => {
    while (!disposed && reads.size < 3 && queue.length) {
      const email = queue.shift()!;
      if (!owns(email)) continue;
      const slug = deps.view()!.slug;
      const work = (async () => {
        try {
          const { state } = await fresh(email, slug);
          if (!owns(email)) return;
          email.identity ??= state.identity; email.state = state; email.error = undefined;
        } catch (failure) {
          if (owns(email)) { email.state = undefined; email.error = humanizeRpcError(failure); }
        } finally {
          if (owns(email)) { email.checking = false; paint(); }
        }
      })();
      reads.add(work);
      void work.finally(() => { reads.delete(work); pump(); });
    }
  };
  const add = (row: CollectionRecord): void => {
    if (selected.has(row.record_id)) return;
    if (selected.size >= MAIL_BULK_LIMIT) { error = `Choose up to ${MAIL_BULK_LIMIT} emails at a time.`; return; }
    const email: Selected = { binding: binding(row), subject: String(row.hot_fields.subject || '(No subject)'),
      sender: String(row.hot_fields.from || 'Unknown sender'), checking: true };
    selected.set(row.record_id, email); queue.push(email);
  };
  const toggle = (id: string, checked: boolean): void => {
    const current = view();
    if (disposed || busy || results.length || !enabled() || !current?.ready) return;
    const row = current.records.find(item => item.record_id === id);
    if (!row) return;
    scope = current.scope;
    if (checked) add(row); else selected.delete(id);
    paint(); pump();
  };
  const canSubmit = (chosen: Change): boolean => {
    const current = view();
    return !disposed && !busy && !results.length && enabled() && !!current?.ready && selected.size > 0
      && [...selected.values()].every(email => !email.checking && verified(email.state) && allowed(email.state, chosen));
  };
  const confirm = (result: Outcome, record: CollectionRecord, state: MailMessageState): void => {
    result.state = 'confirmed'; result.message = undefined;
    deps.confirmed({ ...record, hot_fields: { ...record.hot_fields, is_read: state.is_read, is_flagged: state.is_flagged } });
  };
  const run = async (targets: Outcome[], checkOnly: boolean): Promise<void> => {
    const current = view();
    if (disposed || busy || !change || !current || current.scope !== scope) return;
    const chosen = change;
    busy = true; stopping = false; error = ''; deps.begin(); paint();
    for (const result of targets) {
      if (disposed || deps.view()?.scope !== scope) break;
      if (stopping) { result.state = checkOnly ? 'unconfirmed' : 'failed'; result.message = 'Not started: you stopped the batch.'; continue; }
      result.state = 'running'; result.message = undefined; paint();
      let dispatched = false;
      try {
        const { record, state } = await fresh(result.email, current.slug);
        if (disposed || deps.view()?.scope !== scope) break;
        if (achieved(state, chosen)) { confirm(result, record, state); continue; }
        if (checkOnly) {
          result.state = 'failed'; result.message = 'Checked: the requested status is not set. You can retry this email.'; continue;
        }
        if (!allowed(state, chosen)) throw new Error(state.unavailable_reason ?? 'This mailbox no longer allows this change. Recheck its access in Connections.');
        dispatched = true;
        const out = await deps.mail!.updateState!({ slug: current.slug, record_id: result.email.binding.record_id,
          expected_identity: result.email.identity!, change: chosen });
        if (disposed || deps.view()?.scope !== scope) break;
        if (out.slug !== current.slug || out.record_id !== result.email.binding.record_id || !sameRecord(out.record, result.email.binding)
          || !verified(out.state) || out.state.identity !== result.email.identity || !achieved(out.state, chosen)) {
          throw new Error('The server did not confirm the requested email status.');
        }
        confirm(result, out.record, out.state);
      } catch (failure) {
        if (disposed || deps.view()?.scope !== scope) break;
        result.state = checkOnly || dispatched ? 'unconfirmed' : 'failed';
        result.message = humanizeRpcError(failure);
      }
    }
    busy = false; focusRequest = 'results'; paint();
  };
  const submit = (chosen: Change): Promise<void> => {
    if (!canSubmit(chosen)) return pending;
    change = { ...chosen }; results = [...selected.values()].map(email => ({ email, state: 'waiting' }));
    pending = run(results, false); return pending;
  };
  const retry = (checkOnly = false): Promise<void> => {
    if (disposed || busy) return pending;
    const targets = results.filter(row => row.state === (checkOnly ? 'unconfirmed' : 'failed'));
    if (targets.length) pending = run(targets, checkOnly);
    return pending;
  };
  const focusAttr = (key: string): string => `${MAIL_BULK_FOCUS}="${e(key)}"`;
  const button = (key: string, text: string, disabled = false): string => `<button type="button" class="data-button" data-action="mail-bulk-${key}" ${focusAttr(key)}${disabled ? ' disabled' : ''}>${e(text)}</button>`;
  const render = (): string => {
    const current = view();
    if (!enabled() || !current) return '';
    if (results.length) {
      const count = (state: Outcome['state']) => results.filter(row => row.state === state).length;
      return `<section class="mail-bulk mail-bulk-results" aria-label="Email batch results" tabindex="-1" ${focusAttr('results')}${busy ? ' aria-busy="true"' : ''}>
        <h3>${e(label(change!))}</h3><p role="status" aria-live="polite">${count('confirmed')} confirmed · ${count('failed')} failed · ${count('unconfirmed')} unconfirmed${busy ? ` · ${count('waiting') + count('running')} remaining` : ''}</p>
        <div class="mail-bulk-buttons">${busy ? button('stop', stopping ? 'Stopping after this email…' : 'Stop after current email', stopping)
          : `${count('failed') ? button('retry', 'Retry failed') : ''}${count('unconfirmed') ? button('check', 'Check unconfirmed') : ''}${button('reset', 'Start another selection')}`}</div>
        <ul>${results.map(result => `<li><div><strong>${e(result.email.subject)}</strong><span>${e(result.email.sender)}</span></div><div><strong data-mail-bulk-state="${result.state}">${result.state === 'confirmed' ? 'Confirmed' : result.state === 'failed' ? 'Failed' : result.state === 'unconfirmed' ? 'Unconfirmed' : result.state === 'running' ? 'Working…' : 'Waiting'}</strong>${result.message ? `<p>${e(result.message)}</p>` : ''}</div></li>`).join('')}</ul></section>`;
    }
    const emails = [...selected.values()], checking = emails.filter(email => email.checking).length;
    const unavailable = emails.filter(email => !email.checking && (!verified(email.state) || !email.state.can_mark && !email.state.can_flag)).length;
    return `<section class="mail-bulk${emails.length ? '' : ' mail-bulk--idle'}" aria-label="Email selection" tabindex="-1" ${focusAttr('selection')}>
      <div class="mail-bulk-heading"><strong role="status" aria-live="polite">${emails.length ? `${emails.length} email${emails.length === 1 ? '' : 's'} selected${checking ? ` · ${checking} checking` : unavailable ? ` · ${unavailable} unavailable` : ''}` : 'Tidy mail together'}</strong>
        <div class="mail-bulk-buttons">${button('all', 'Select shown', !current.ready || !current.records.length)}${emails.length ? button('reset', 'Clear selection') : ''}</div></div>
      ${emails.length ? `<div class="mail-bulk-buttons" role="group" aria-label="Change selected emails">${button('read', 'Mark read', !canSubmit({ kind: 'read', value: true }))}${button('unread', 'Mark unread', !canSubmit({ kind: 'read', value: false }))}${button('star', 'Star', !canSubmit({ kind: 'star', value: true }))}${button('unstar', 'Remove stars', !canSubmit({ kind: 'star', value: false }))}</div>
        <p>Only emails shown in this mailbox and these filters are included. Up to ${MAIL_BULK_LIMIT} per batch. Actions require verified editing access for every selected email.</p>
        <div class="mail-bulk-buttons">${button('review', review ? 'Hide selected details' : 'Review selected')}${button('recheck', 'Recheck selected', checking > 0)}</div>
        ${review ? `<ul class="mail-bulk-review">${emails.map(email => `<li><strong>${e(email.subject)}</strong><span>${e(email.checking ? 'Checking email access…' : email.error ?? (!email.state?.can_mark && !email.state?.can_flag ? email.state?.unavailable_reason ?? 'Email editing is unavailable.' : `${email.state.can_mark ? 'Read status available' : 'Read status unavailable'} · ${email.state.can_flag ? 'Stars available' : 'Stars unavailable'}`))}</span></li>`).join('')}</ul>` : ''}` : `<p>Only emails shown in this mailbox and these filters are included. Up to ${MAIL_BULK_LIMIT} per batch.</p>`}
      ${error ? `<p role="alert">${e(error)}</p>` : ''}</section>`;
  };
  return {
    enabled, toggle, submit, retry, render, reset,
    busy: () => busy,
    holdsList: () => selected.size > 0 || results.length > 0,
    snapshot: () => results.map(row => ({ id: row.email.binding.record_id, state: row.state, message: row.message })),
    async whenSettled(): Promise<void> {
      while (reads.size || queue.length) { pump(); await Promise.all([...reads]); }
      await pending;
    },
    checkbox(record: CollectionRecord): string {
      const current = view();
      return `<label class="mail-bulk-select"><input type="checkbox" data-mail-bulk-id="${e(record.record_id)}" ${focusAttr(`email:${record.record_id}`)} aria-label="Select ${e(String(record.hot_fields.subject || '(No subject)'))}"${selected.has(record.record_id) ? ' checked' : ''}${busy || results.length || !current?.ready ? ' disabled' : ''}></label>`;
    },
    handleAction(action: string): boolean {
      if (!action.startsWith('mail-bulk-')) return false;
      const command = action.slice('mail-bulk-'.length), current = view();
      if (command === 'all' && !busy && !results.length && enabled() && current?.ready) {
        scope = current.scope; for (const row of current.records) add(row); paint(); pump();
      } else if (command === 'reset' && !busy) { reset(); focusRequest = 'all'; paint(); }
      else if (command === 'stop' && busy) { stopping = true; paint(); }
      else if (command === 'review' && !busy) { review = !review; paint(); }
      else if (command === 'recheck' && !busy && !results.length && ![...selected.values()].some(email => email.checking)) {
        for (const email of selected.values()) { email.checking = true; queue.push(email); } paint(); pump();
      } else if (command === 'retry') void retry();
      else if (command === 'check') void retry(true);
      else if (command === 'read' || command === 'unread') void submit({ kind: 'read', value: command === 'read' });
      else if (command === 'star' || command === 'unstar') void submit({ kind: 'star', value: command === 'star' });
      return true;
    },
    restoreFocus(root: ParentNode, key: string | null): void {
      const request = focusRequest; focusRequest = null;
      if (disposed || key === null) return;
      const wanted = request ?? key, escape = (value: string) => value.replace(/["\\]/g, '\\$&');
      const control = root.querySelector<HTMLElement>(`[${MAIL_BULK_FOCUS}="${escape(wanted)}"]:not(:disabled)`)
        ?? root.querySelector<HTMLElement>(`[${MAIL_BULK_FOCUS}="results"], [${MAIL_BULK_FOCUS}="selection"]`);
      control?.focus({ preventScroll: request === null || wanted === key });
    },
    dispose() { disposed = true; queue.length = 0; selected.clear(); },
  };
};

export const MAIL_BULK_STYLES = `
.mail-bulk { display:grid; gap:.65rem; padding:1rem; margin:1rem 0; border:1px solid var(--border); border-radius:.65rem; background:var(--surface); }
.mail-bulk h3,.mail-bulk p { margin:0; }
.mail-bulk p,.mail-bulk li span { color:var(--fg-muted); font-size:.85rem; }
.mail-bulk-heading,.mail-bulk-buttons { display:flex; align-items:center; flex-wrap:wrap; gap:.65rem; }
.mail-bulk-heading { justify-content:space-between; }
.mail-bulk ul { display:grid; gap:.5rem; margin:0; padding:0; list-style:none; }
.mail-bulk li { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:.5rem; padding:.5rem 0; border-top:1px solid var(--border); overflow-wrap:anywhere; }
.mail-bulk li > div,.mail-bulk-review li { display:grid; align-content:start; gap:.25rem; }
.mail-bulk [role=alert],[data-mail-bulk-state=failed] { color:var(--danger); }
[data-mail-bulk-state=confirmed] { color:var(--accent); }
.mail-bulk-select { display:flex; align-items:center; justify-content:center; min-width:44px; min-height:44px; padding:.5rem; box-sizing:border-box; }
.mail-bulk-select input { width:1.15rem; height:1.15rem; accent-color:var(--accent); }
@media(max-width:600px) { .mail-bulk li { grid-template-columns:minmax(0,1fr); } .mail-bulk--idle { margin:.5rem 0; padding:.6rem .75rem; } .mail-bulk--idle .mail-bulk-heading { flex-wrap:nowrap; } .mail-bulk--idle > p { display:none; } }
`;
