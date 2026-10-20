import { renderResourceReview, type Conn, type ServerRpcRegistry, type LocalChangeSetInspection,
  type LocalChangeSetDecision, type LocalChangeSetUndoPrepare } from '@recued/contracts';
import { serializeShellRoute } from '../shell/route.js';

export const localChangesHref = (id?: string): string => serializeShellRoute('approvals','local-changes',id);
export const bootstrapLocalChangesRoute = (opts: {
  root: HTMLElement; call: Conn<ServerRpcRegistry>; document?: Document; changeSetId?: string; now?: () => number;
}) => {
  const doc = opts.document ?? document, now = opts.now ?? Date.now;
  const host = doc.createElement('section'); host.setAttribute('data-local-change-sets-route','');
  host.style.cssText = 'max-width:960px;margin:auto;padding:24px;min-width:0;overflow-wrap:anywhere'; opts.root.append(host);
  let disposed = false, busy = false, generation = 0, error = '', note = '';
  let view: LocalChangeSetInspection | null = null, items: LocalChangeSetInspection[] = [], cursor: string | null = null;
  let pendingDecision: LocalChangeSetDecision | null = null, pendingUndo: LocalChangeSetUndoPrepare | null = null;
  let loaded: Promise<void> = Promise.resolve();
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const value = doc.createElement(tag); if (text !== undefined) value.textContent = text; return value;
  };
  const link = (label: string, href: string): HTMLAnchorElement => { const value = node('a',label); value.href = href; return value; };
  const button = (label: string, action: () => void, disabled = false): HTMLButtonElement => {
    const value = node('button',label); value.type = 'button'; value.disabled = busy || disabled;
    value.style.cssText = 'margin:4px 8px 4px 0;padding:8px 12px;font:inherit'; value.onclick = action; return value;
  };
  const focusStatus = (): void => { host.querySelector<HTMLElement>('[role=alert], [role=status]')?.focus(); };
  const render = (): void => {
    if (disposed) return;
    host.replaceChildren(); host.append(link('Approvals',serializeShellRoute('approvals')));
    const title = node('h1',view?.review?.title ?? 'Atomic local changes'); title.tabIndex = -1; host.append(title);
    host.append(button(busy ? 'Loading…' : 'Refresh',() => { void refresh(); }));
    if (error) { const alert = node('p',error); alert.setAttribute('role','alert'); alert.tabIndex = -1; host.append(alert); }
    if (note) { const status = node('p',note); status.setAttribute('role','status'); status.tabIndex = -1; host.append(status); }
    if (!opts.changeSetId) {
      if (!busy && !error && items.length === 0) host.append(node('p','No local change sets have been prepared. Open a pending run review to prepare one.'));
      host.append(link('Runs you have looked at',serializeShellRoute('approvals','preapproval')));
      const list = node('ul');
      for (const entry of items) {
        const item = node('li'); item.append(link(`${entry.undo_of ? 'Undo' : 'Local changes'} · ${entry.status} · ${entry.change_set_id}`,localChangesHref(entry.change_set_id))); list.append(item);
      }
      host.append(list);
      if (cursor) host.append(button('Load more',() => { void refresh(cursor!); }));
      return;
    }
    host.append(link('Every local change set',localChangesHref()));
    if (!view) return;
    if (view.source_proposal_id) host.append(node('p'),link('Original run review',serializeShellRoute('approvals','preapproval',view.source_proposal_id)));
    if (view.undo_of) host.append(node('p'),link('Original change set',localChangesHref(view.undo_of)));
    const state = node('p',view.status === 'completed' ? `All ${view.receipts.length} local changes are confirmed.`
      : view.status === 'unknown' ? 'The outcome is unknown. This decision will not run again.'
        : view.status === 'failed' ? 'The change set failed. No complete local transaction was confirmed.'
          : view.status === 'denied' ? 'Local changes declined. Nothing was applied.'
            : view.status === 'expired' ? 'This review expired. Nothing can be approved from this page.' : 'Review every change before deciding.');
    state.setAttribute('role','status'); state.tabIndex = -1; host.append(state);
    if (view.review && view.status === 'pending') {
      const review = view.review, expired = review.expires_at <= now();
      host.append(node('p',`Requested through ${review.requested_through}. Those permissions still apply.`),
        node('p','One approval applies all the changes shown here now. If any change conflicts, the entire transaction rolls back.'),
        node('p',`Decide by ${new Date(review.expires_at).toLocaleString()}.`));
      if (view.source_proposal_id) host.append(node('p','When this transaction commits, it replaces the scheduled run review.'));
      for (const member of review.changes) {
        const section = node('article'); section.setAttribute('data-local-change-member',member.member_id);
        section.style.cssText = 'border:1px solid var(--border);padding:16px;margin:12px 0;min-width:0';
        const detail = node('pre',renderResourceReview(member.resource_review)); detail.tabIndex = 0;
        detail.style.cssText = 'max-width:100%;max-height:24rem;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere';
        section.append(node('h2',member.label),detail); host.append(section);
      }
      if (expired) host.append(node('p','This review expired. Prepare a fresh review.'));
      host.append(button(view.undo_of ? 'Approve undo together' : 'Approve changes together',() => { void decide('approve'); },expired || pendingDecision !== null),
        button('Decline changes',() => { void decide('deny'); },expired || pendingDecision !== null));
    }
    if (view.receipts.length) {
      const list = node('ul'); list.setAttribute('data-local-change-receipts','');
      for (const item of view.receipts) list.append(node('li',`${item.local_receipt.kind === 'records' ? 'Records' : 'Calendar'} receipt: ${item.local_receipt.receipt_id}`));
      host.append(list);
    }
    if (pendingDecision || view.status === 'unknown') host.append(button('Check result',() => { void refresh(); }));
    if (view.status === 'completed' && view.undo_available) host.append(button('Review undo together',() => { void prepareUndo(); }));
    if (view.undo_change_set_id) host.append(link('Confirmed grouped undo',localChangesHref(view.undo_change_set_id)));
  };
  const refresh = async (next?: string): Promise<void> => {
    if (disposed || busy) return;
    const current = ++generation; busy = true; error = ''; note = ''; render();
    try {
      if (opts.changeSetId) {
        const state = await opts.call('local_changes.get',{ change_set_id: opts.changeSetId });
        if (disposed || current !== generation) return;
        if (pendingDecision && state.status === 'pending') note = 'No decision has been recorded. Review the changes before approving again.';
        view = state; pendingDecision = null;
      } else {
        const page = await opts.call('local_changes.list',{ cursor: next ?? '' });
        if (disposed || current !== generation) return;
        items = next ? [...items,...page.items] : page.items; cursor = page.next_cursor;
      }
    } catch (cause) { if (!disposed && current === generation) error = cause instanceof Error ? cause.message : 'The local result could not be checked.'; }
    finally { if (!disposed && current === generation) { busy = false; render(); focusStatus(); } }
  };
  const decide = async (decision: 'approve' | 'deny'): Promise<void> => {
    if (disposed || busy || !view?.review || pendingDecision) return;
    const request: LocalChangeSetDecision = { change_set_id: view.change_set_id,review_hash: view.review.review_hash,decision };
    pendingDecision = request; busy = true; error = ''; note = ''; render();
    try { view = await opts.call('local_changes.decide',request); pendingDecision = null; }
    catch (cause) { error = cause instanceof Error ? cause.message : 'The response was lost. Check the result.'; }
    finally { busy = false; render(); focusStatus(); }
  };
  const prepareUndo = async (): Promise<void> => {
    if (disposed || busy || !view?.undo_available) return;
    pendingUndo ??= { change_set_id: view.change_set_id,request_id: crypto.randomUUID() };
    busy = true; error = ''; note = ''; render();
    try {
      const next = await opts.call('local_changes.prepare_undo',pendingUndo);
      if (!disposed) doc.defaultView?.location.assign(localChangesHref(next.change_set_id));
    } catch (cause) { error = cause instanceof Error ? cause.message : 'Grouped undo could not be reviewed.'; }
    finally { busy = false; render(); focusStatus(); }
  };
  loaded = refresh();
  let expired = false;
  const timer = setInterval(() => {
    if (!expired && !busy && view?.status === 'pending' && view.review && view.review.expires_at <= now()) {
      expired = true; render();
    }
  },1000);
  return { refresh: () => { loaded = refresh(); return loaded; }, whenLoaded: () => loaded, hasInFlightWork: () => busy,
    dispose() { disposed = true; generation++; clearInterval(timer); host.remove(); } };
};
