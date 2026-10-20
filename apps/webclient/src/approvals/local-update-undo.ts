import { renderResourceReview, type LocalUpdateUndoReview, type LocalUpdateUndoDecision,
  type LocalUpdateUndoResult } from '@recued/contracts';

export interface LocalUpdateUndoCallers {
  get(args: { receipt_id: string }): Promise<LocalUpdateUndoResult | null>;
  review(args: { receipt_id: string }): Promise<LocalUpdateUndoReview>;
  decide(args: LocalUpdateUndoDecision): Promise<LocalUpdateUndoResult>;
}
/** Opening the preview never grants permission. Result checks are read-only,
 * including after a lost response or page reload. */
export const localUpdateUndoControl = (doc: Document, callers: LocalUpdateUndoCallers, receiptId: string): HTMLElement => {
  const host = doc.createElement('div'); host.setAttribute('data-local-update-undo', receiptId);
  host.style.cssText = 'max-width:100%;min-width:0;overflow-wrap:anywhere';
  const open = doc.createElement('button'); open.type = 'button'; open.textContent = 'Review undo';
  open.setAttribute('aria-expanded', 'false');
  const panel = doc.createElement('div');
  const message = doc.createElement('p'); message.setAttribute('role', 'status'); message.tabIndex = -1;
  let review: LocalUpdateUndoReview | null = null, busy = false;
  let lastResult: LocalUpdateUndoResult | null = null;
  const button = (label: string): HTMLButtonElement => {
    const value = doc.createElement('button'); value.type = 'button'; value.textContent = label;
    value.style.cssText = 'margin:4px 8px 4px 0;padding:8px 12px;font:inherit'; return value;
  };
  const showError = (error: unknown): void => { message.textContent = error instanceof Error ? error.message : 'Undo could not be checked. Try again.'; };
  const showResult = (result: LocalUpdateUndoResult | null): void => {
    review = null; lastResult = result; panel.replaceChildren(); open.setAttribute('aria-expanded', 'false');
    if (!result) {
      open.hidden = false;
      message.textContent = 'No undo decision has been recorded. Review the changes again before approving.';
      return;
    }
    const confirmed = result.status === 'completed' && result.local_receipt;
    message.textContent = confirmed
      ? 'Undo confirmed. Original receipt: ' + result.predecessor_receipt_id + '. Undo receipt: ' + confirmed.receipt_id
      : result.status === 'denied' ? 'Undo declined. The original change remains.'
        : result.status === 'failed' ? 'Undo failed. No confirmed reverse change was recorded.'
          : 'Undo outcome is unknown. This approval will not run again.';
    open.hidden = result.status !== 'denied' && result.status !== 'failed';
    if (!open.hidden) open.textContent = 'Review undo again';
    if (result.status === 'unknown' || (result.status === 'completed' && !confirmed)) {
      const retry = button('Check undo result'); retry.onclick = () => { void checkResult(); }; panel.append(retry);
    }
  };
  const checkResult = async (): Promise<void> => {
    if (busy) return;
    busy = true; open.disabled = true;
    for (const control of panel.querySelectorAll('button')) control.disabled = true;
    message.textContent = 'Checking undo result…';
    try { showResult(await callers.get({ receipt_id: receiptId })); }
    catch (error) { showError(error); retryResult(); }
    finally { busy = false; open.disabled = false; if (message.isConnected) message.focus(); }
  };
  const retryResult = (): void => {
    open.hidden = true;
    const retry = button('Check undo result'); retry.onclick = () => { void checkResult(); }; panel.replaceChildren(retry);
  };
  const decide = async (decision: 'approve' | 'deny'): Promise<void> => {
    if (busy || !review) return;
    busy = true; open.disabled = true;
    for (const control of panel.querySelectorAll('button')) control.disabled = true;
    message.textContent = decision === 'approve' ? 'Applying the reviewed undo…' : 'Declining undo…';
    try { showResult(await callers.decide({ undo_id: review.undo_id, review_hash: review.review_hash, decision })); }
    catch (error) { showError(error); retryResult(); }
    finally { busy = false; open.disabled = false; if (message.isConnected) message.focus(); }
  };
  open.onclick = async () => {
    if (busy) return;
    busy = true; open.disabled = true; panel.replaceChildren(); message.textContent = 'Preparing undo review…';
    try {
      const prior = await callers.get({ receipt_id: receiptId });
      if (prior && (prior.undo_id !== lastResult?.undo_id || (prior.status !== 'denied' && prior.status !== 'failed'))) {
        showResult(prior); if (message.isConnected) message.focus(); return;
      }
      review = await callers.review({ receipt_id: receiptId });
      const title = doc.createElement('h3'); title.textContent = 'Review reverse changes'; title.tabIndex = -1;
      const detail = doc.createElement('p'); detail.textContent = 'This is a new action requested by you. Check the changes, then approve undo. Later edits prevent it from applying.';
      const changes = doc.createElement('pre'); changes.textContent = renderResourceReview(review.resource_review); changes.tabIndex = 0;
      changes.setAttribute('data-local-update-undo-preview', '');
      changes.style.cssText = 'max-width:100%;max-height:24rem;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere';
      const approve = button('Approve undo'); approve.onclick = () => { void decide('approve'); };
      const deny = button('Decline undo'); deny.onclick = () => { void decide('deny'); };
      panel.append(title, detail, changes, approve, deny);
      open.setAttribute('aria-expanded', 'true'); message.textContent = '';
      if (title.isConnected) title.focus();
    } catch (error) { showError(error); }
    finally { busy = false; open.disabled = false; }
  };
  host.append(open, message, panel); return host;
};
