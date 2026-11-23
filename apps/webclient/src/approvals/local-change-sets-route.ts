import { renderResourceReview, type Conn, type ServerRpcRegistry, type LocalChangeSetInspection,
  type LocalChangeSetDecision, type LocalChangeSetUndoPrepare } from '@recued/contracts';
import { serializeShellRoute } from '../shell/route.js';
import { createApprovalReviewLayout } from './review-layout.js';

export const localChangesHref = (id?: string): string => serializeShellRoute('approvals', 'local-changes', id);
export const bootstrapLocalChangesRoute = (opts: {
  root: HTMLElement; call: Conn<ServerRpcRegistry>; document?: Document; changeSetId?: string; now?: () => number;
}) => {
  const doc = opts.document ?? document, now = opts.now ?? Date.now;
  const host = doc.createElement('section'); host.setAttribute('data-local-change-sets-route', '');
  opts.root.append(host);
  let disposed = false, busy = false, writing = false, generation = 0, error = '', note = '', renderedExpired = false;
  let view: LocalChangeSetInspection | null = null, items: LocalChangeSetInspection[] = [], cursor: string | null = null;
  let pendingDecision: LocalChangeSetDecision | null = null, pendingUndo: LocalChangeSetUndoPrepare | null = null;
  let loaded: Promise<void> = Promise.resolve();
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const value = doc.createElement(tag); if (text !== undefined) value.textContent = text; return value;
  };
  const link = (label: string, href: string): HTMLAnchorElement => { const value = node('a', label); value.href = href; return value; };
  const button = (label: string, action: () => void, disabled = false, tone: 'default' | 'primary' = 'default'): HTMLButtonElement => {
    const value = node('button', label); value.type = 'button'; value.disabled = busy || disabled;
    value.className = 'approval-review-button' + (tone === 'primary' ? ' approval-review-button-primary' : '');
    value.dataset.localChangeFocus = label;
    value.onclick = () => {
      if (disposed || busy || value.disabled || !host.contains(value)) return;
      value.focus({ preventScroll: true }); action();
    };
    return value;
  };
  const refreshControl = button('Refresh', () => { void refresh(); });
  refreshControl.onclick = () => { if (!disposed && !busy) void refresh(); };
  const more = button('Load more', () => { if (cursor) void refresh(cursor); });
  const frame = createApprovalReviewLayout(doc, host, { title: 'Atomic local changes', view: 'changes', refresh: refreshControl });
  const progress = node('p'); progress.setAttribute('role', 'status'); progress.tabIndex = -1;
  progress.setAttribute('data-local-change-progress', '');
  const sync = (target: HTMLElement, children: Node[]): void => {
    for (let index = 0; index < children.length; index++) {
      const child = children[index]!;
      if (child.parentNode === target) continue;
      target.insertBefore(child, children.slice(index + 1).find(item => item.parentNode === target) ?? null);
    }
    for (const child of [...target.childNodes]) if (!children.includes(child)) child.remove();
  };
  const focusResult = (): void => {
    (host.querySelector<HTMLElement>('[role="alert"], [data-review-status]') ?? frame.heading).focus();
  };
  const render = (): void => {
    if (disposed) return;
    const active = doc.activeElement as HTMLElement | null;
    const focusKey = active && host.contains(active) ? active.dataset.localChangeFocus : undefined;
    const focusedDecision = active?.hasAttribute('data-local-change-decision') === true;
    const previousHash = host.getAttribute('data-local-change-review');
    const resources = [...host.querySelectorAll<HTMLElement>('[data-local-change-resource-review]')].map(element => ({
      id: element.dataset.localChangeResourceReview, text: element.textContent, top: element.scrollTop, left: element.scrollLeft, focused: active === element,
    }));
    const scroll = new Map<Element, [number, number]>();
    for (let parent: Element | null = host; parent; parent = parent.parentElement) {
      if (parent.scrollTop || parent.scrollLeft) scroll.set(parent, [parent.scrollTop, parent.scrollLeft]);
    }
    const summary: Node[] = [], content: Node[] = [], actions: Node[] = [];
    frame.heading.textContent = view?.review?.title ?? 'Atomic local changes';
    host.setAttribute('data-local-change-review', view?.review?.review_hash ?? '');
    host.setAttribute('aria-busy', String(busy));
    refreshControl.textContent = busy ? 'Loading…' : 'Refresh';
    for (const control of [refreshControl, more]) {
      control.setAttribute('aria-disabled', String(busy)); control.setAttribute('aria-busy', String(busy));
    }
    if (busy) (view && opts.changeSetId ? actions : summary).push(progress);
    if (error) { const alert = node('p', error); alert.setAttribute('role', 'alert'); alert.tabIndex = -1; summary.push(alert); }
    if (note) { const status = node('p', note); status.setAttribute('role', 'status'); summary.push(status); }
    if (!opts.changeSetId) {
      if (!busy && !error && items.length === 0) content.push(node('p', 'No local change sets have been prepared. Open a pending run review to prepare one.'));
      const list = node('ul'); list.className = 'approval-review-list';
      for (const entry of items) {
        const item = node('li');
        const open = link(entry.review?.title ?? (entry.undo_of ? 'Grouped undo' : 'Local changes'), localChangesHref(entry.change_set_id));
        open.setAttribute('data-local-change-entry', entry.change_set_id);
        item.append(open, node('p', `${entry.status.replaceAll('_', ' ')} · Requested ${new Date(entry.created_at).toLocaleString()}`)); list.append(item);
      }
      content.push(list); if (cursor) content.push(more);
    } else {
      content.push(link('Every local change set', localChangesHref()));
      if (view) {
        if (view.source_proposal_id) summary.push(link('Original run review', serializeShellRoute('approvals', 'preapproval', view.source_proposal_id)));
        if (view.undo_of) summary.push(link('Original change set', localChangesHref(view.undo_of)));
        const expired = view.status === 'pending' && !!view.review && view.review.expires_at <= now();
        renderedExpired = expired;
        const state = node('p', view.status === 'completed' ? `All ${view.receipts.length} local changes are confirmed.`
          : view.status === 'unknown' ? 'The outcome is unknown. This decision will not run again.'
            : view.status === 'failed' ? 'The change set failed. No complete local transaction was confirmed.'
              : view.status === 'denied' ? 'Local changes declined. Nothing was applied.'
                : view.status === 'expired' || expired ? 'This review expired. Nothing can be approved from this page.' : 'Review every change before deciding.');
        state.setAttribute('role', 'status'); state.tabIndex = -1; state.setAttribute('data-review-status', expired ? 'expired' : view.status); summary.push(state);
        if (view.review && view.status === 'pending') {
          const review = view.review;
          summary.push(node('p', `Requested through ${review.requested_through}. Those permissions still apply.`),
            node('p', 'One approval applies all the changes shown here now. If any change conflicts, the entire transaction rolls back.'),
            node('p', `Decide by ${new Date(review.expires_at).toLocaleString()}.`));
          if (view.source_proposal_id) summary.push(node('p', 'When this transaction commits, it replaces the scheduled run review.'));
          for (const member of review.changes) {
            const section = node('article'); section.setAttribute('data-local-change-member', member.member_id);
            section.className = 'approval-review-member'; section.setAttribute('aria-label', member.label);
            const detail = node('pre', renderResourceReview(member.resource_review)); detail.tabIndex = 0;
            detail.setAttribute('data-local-change-resource-review', member.member_id);
            detail.setAttribute('role', 'region'); detail.setAttribute('aria-label', 'Reviewed changes for ' + member.label);
            detail.style.cssText = 'max-width:100%;max-height:24rem;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere';
            section.append(node('h2', member.label), detail); content.push(section);
          }
          if (expired) {
            const notice = node('p', 'This review expired. Prepare a fresh review.'); notice.tabIndex = -1;
            notice.setAttribute('role', 'status'); notice.setAttribute('data-local-change-expiry', ''); actions.push(notice);
          }
          const approve = button(view.undo_of ? 'Approve undo together' : 'Approve changes together', () => { void decide('approve'); }, expired || pendingDecision !== null, 'primary');
          const deny = button('Decline changes', () => { void decide('deny'); }, expired || pendingDecision !== null);
          approve.setAttribute('data-local-change-decision', 'approve'); deny.setAttribute('data-local-change-decision', 'deny');
          actions.push(approve, deny);
        }
        if (view.receipts.length) {
          const list = node('ul'); list.setAttribute('data-local-change-receipts', ''); list.className = 'approval-review-receipts';
          for (const receipt of view.receipts) {
            const item = node('li', `${receipt.local_receipt.kind === 'records' ? 'Records' : 'Calendar'} change confirmed`);
            item.setAttribute('data-local-mutation-receipt', receipt.local_receipt.receipt_id); list.append(item);
          }
          content.push(node('h2', 'Confirmed changes'), list);
        }
        if (pendingDecision || view.status === 'unknown') actions.push(button('Check result', () => { void refresh(); }));
        if (view.status === 'completed' && view.undo_available) actions.push(button('Review undo together', () => { void prepareUndo(); }));
        if (view.undo_change_set_id) actions.push(link('Confirmed grouped undo', localChangesHref(view.undo_change_set_id)));
      }
    }
    sync(frame.summary, summary); sync(frame.content, content); sync(frame.actions, actions);
    if (active && !active.isConnected && (!doc.activeElement || doc.activeElement === doc.body || host.contains(doc.activeElement))) {
      const target = [...host.querySelectorAll<HTMLButtonElement>('[data-local-change-focus]')]
        .find(control => control.dataset.localChangeFocus === focusKey && !control.disabled);
      (target ?? (focusedDecision ? host.querySelector<HTMLElement>('[data-local-change-expiry]') : null))?.focus({ preventScroll: true });
    }
    if (previousHash === (view?.review?.review_hash ?? '')) for (const saved of resources) {
      const target = [...host.querySelectorAll<HTMLElement>('[data-local-change-resource-review]')]
        .find(element => element.dataset.localChangeResourceReview === saved.id && element.textContent === saved.text);
      if (!target) continue;
      target.scrollTop = saved.top; target.scrollLeft = saved.left;
      if (saved.focused && (!doc.activeElement || doc.activeElement === doc.body)) target.focus({ preventScroll: true });
    }
    for (const [element, [top, left]] of scroll) { element.scrollTop = top; element.scrollLeft = left; }
  };
  const refresh = async (next?: string): Promise<void> => {
    if (disposed || busy) return;
    const current = ++generation, previousCount = items.length;
    const fromCheck = (doc.activeElement as HTMLElement | null)?.dataset.localChangeFocus === 'Check result';
    busy = true; error = ''; note = ''; progress.textContent = 'Checking the current local result…'; render();
    if (fromCheck) progress.focus({ preventScroll: true });
    try {
      if (opts.changeSetId) {
        const state = await opts.call('local_changes.get', { change_set_id: opts.changeSetId });
        if (disposed || current !== generation) return;
        if (pendingDecision && state.status === 'pending') note = 'No decision has been recorded. Review the changes before approving again.';
        view = state; pendingDecision = null;
      } else {
        const page = await opts.call('local_changes.list', { cursor: next ?? '' });
        if (disposed || current !== generation) return;
        items = next ? [...items, ...page.items] : page.items; cursor = page.next_cursor;
      }
    } catch (cause) {
      if (!disposed && current === generation) error = cause instanceof Error ? cause.message : 'The local result could not be checked.';
    } finally {
      if (!disposed && current === generation) {
        const ownsProgress = doc.activeElement === progress, ownsPagination = doc.activeElement === more;
        busy = false; render();
        if (ownsProgress) focusResult();
        else if (ownsPagination && !more.isConnected) {
          (host.querySelectorAll<HTMLElement>('[data-local-change-entry]')[previousCount] ?? refreshControl).focus({ preventScroll: true });
        }
      }
    }
  };
  const write = async (label: string, action: () => Promise<void | (() => void)>): Promise<void> => {
    if (disposed || busy) return;
    busy = true; writing = true; error = ''; note = ''; progress.textContent = label; render(); progress.focus({ preventScroll: true });
    let navigate: void | (() => void) = undefined;
    try { navigate = await action(); }
    catch (cause) { if (!disposed) error = cause instanceof Error ? cause.message : 'The response was lost. Check the result.'; }
    finally {
      const ownsFocus = doc.activeElement === progress;
      busy = false; writing = false;
      if (!disposed) { render(); if (ownsFocus) focusResult(); }
    }
    if (!disposed && navigate) navigate();
  };
  const decide = async (decision: 'approve' | 'deny'): Promise<void> => {
    if (disposed || busy || view?.status !== 'pending' || !view.review || pendingDecision) return;
    if (view.review.expires_at <= now()) { render(); focusResult(); return; }
    const request: LocalChangeSetDecision = { change_set_id: view.change_set_id, review_hash: view.review.review_hash, decision };
    pendingDecision = request;
    await write(decision === 'approve' ? 'Applying the reviewed local changes…' : 'Declining local changes…', async () => {
      const result = await opts.call('local_changes.decide', request);
      if (!disposed) { view = result; pendingDecision = null; }
    });
  };
  const prepareUndo = async (): Promise<void> => {
    if (disposed || busy || view?.status !== 'completed' || !view.undo_available) return;
    pendingUndo ??= { change_set_id: view.change_set_id, request_id: crypto.randomUUID() };
    await write('Preparing grouped undo review…', async () => {
      const next = await opts.call('local_changes.prepare_undo', pendingUndo!);
      return () => doc.defaultView?.location.assign(localChangesHref(next.change_set_id));
    });
  };
  loaded = refresh();
  const timer = setInterval(() => {
    if (!busy && !renderedExpired && view?.status === 'pending' && view.review && view.review.expires_at <= now()) render();
  }, 1000);
  return {
    refresh: () => { loaded = refresh(); return loaded; }, whenLoaded: () => loaded,
    hasInFlightWork: () => writing,
    inFlightWorkPrompt: () => writing ? 'A local change request is still in progress. Leave this page anyway?' : null,
    dispose() { disposed = true; generation++; clearInterval(timer); host.remove(); },
  };
};
