import { renderResourceReview, type LocalUpdateUndoReview, type LocalUpdateUndoDecision,
  type LocalUpdateUndoResult } from '@recued/contracts';

export interface LocalUpdateUndoCallers {
  get(args: { receipt_id: string }): Promise<LocalUpdateUndoResult | null>;
  review(args: { receipt_id: string }): Promise<LocalUpdateUndoReview>;
  decide(args: LocalUpdateUndoDecision): Promise<LocalUpdateUndoResult>;
}
const pendingDecisions = new WeakSet<HTMLElement>();
/** A cached control may be folded away while its explicit decision still runs. */
export const hasLocalUpdateUndoWork = (control: HTMLElement): boolean => pendingDecisions.has(control);

const STYLES = `
[data-local-update-undo] {
  display: grid; gap: 12px; min-width: 0; max-width: 100%; margin-top: 12px;
  color: var(--fg); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere;
}
[data-local-update-undo] :is(p, h3) { margin: 0; }
[data-local-update-undo] h3 { font-size: 14px; font-weight: 650; line-height: 1.4; }
[data-local-update-undo] > p:empty { display: none; }
[data-local-update-undo] [role="alert"] { color: var(--danger); }
[data-local-update-undo] button {
  box-sizing: border-box; min-width: 0; max-width: 100%; min-height: var(--wc-control-h, 44px);
  padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px);
  background: var(--surface); color: var(--fg); font: inherit; font-weight: 600;
  line-height: 1.4; white-space: normal; overflow-wrap: anywhere; cursor: pointer;
}
[data-local-update-undo] > button { justify-self: start; }
[data-local-update-undo] button[data-local-update-undo-approve] {
  border-color: var(--accent); background: var(--accent); color: var(--on-accent);
}
[data-local-update-undo] button:disabled { opacity: .6; cursor: not-allowed; }
[data-local-update-undo] :is(button, pre, [role="status"], [role="alert"], h3):focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px;
}
[data-local-update-undo-panel]:empty { display: none; }
[data-local-update-undo-panel]:not(:empty) {
  display: grid; gap: 12px; min-width: 0; padding: 16px;
  border: 1px solid var(--border); border-radius: var(--wc-radius-lg, 14px); background: var(--surface);
}
[data-local-update-undo-preview] {
  box-sizing: border-box; width: 100%; min-width: 0; max-height: 24rem; margin: 0; padding: 12px;
  border: 1px solid var(--border); border-radius: var(--wc-radius, 9px); background: var(--surface-subtle);
  color: var(--fg); font: 12px/1.6 var(--mono, ui-monospace, monospace);
  overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
}
[data-local-update-undo-actions] { display: flex; flex-wrap: wrap; align-items: stretch; gap: 8px; }
@media (max-width: 600px) {
  [data-local-update-undo] button { min-height: 44px; }
  [data-local-update-undo-panel]:empty { display: none; }
[data-local-update-undo-panel]:not(:empty) { padding: 12px; }
  [data-local-update-undo-actions] > button { flex: 1 1 140px; }
}
`;

/** Opening the preview never grants permission. Result checks are read-only,
 * including after a lost response or page reload. */
export const localUpdateUndoControl = (doc: Document, callers: LocalUpdateUndoCallers, receiptId: string): HTMLElement => {
  if (doc.head && !doc.head.querySelector('[data-local-update-undo-styles]')) {
    const style = doc.createElement('style'); style.setAttribute('data-local-update-undo-styles', ''); style.textContent = STYLES; doc.head.append(style);
  }
  const host = doc.createElement('div'); host.setAttribute('data-local-update-undo', receiptId);
  const open = doc.createElement('button'); open.type = 'button'; open.textContent = 'Review undo'; open.setAttribute('aria-expanded', 'false');
  const panel = doc.createElement('div'); panel.setAttribute('data-local-update-undo-panel', '');
  const message = doc.createElement('p'); message.setAttribute('role', 'status'); message.tabIndex = -1;
  let review: LocalUpdateUndoReview | null = null, busy = false;
  let lastResult: LocalUpdateUndoResult | null = null;
  const button = (label: string, action: () => void): HTMLButtonElement => {
    const value = doc.createElement('button'); value.type = 'button'; value.textContent = label;
    value.onclick = () => {
      if (busy || value.disabled || !host.isConnected || !host.contains(value)) return;
      value.focus({ preventScroll: true }); action();
    };
    return value;
  };
  const tell = (text: string, error = false): void => { message.setAttribute('role', error ? 'alert' : 'status'); message.textContent = text; };
  const showError = (error: unknown): void => tell(error instanceof Error ? error.message : 'Undo could not be checked. Try again.', true);
  const start = (text: string, writing = false): void => {
    busy = true; host.setAttribute('aria-busy', 'true');
    if (writing) pendingDecisions.add(host);
    tell(text); message.focus(); open.disabled = true;
    for (const control of panel.querySelectorAll('button')) control.disabled = true;
  };
  const finish = (): void => {
    busy = false; pendingDecisions.delete(host); host.setAttribute('aria-busy', 'false'); open.disabled = false;
  };
  const retryResult = (): void => {
    review = null; open.hidden = true; open.setAttribute('aria-expanded', 'false');
    panel.replaceChildren(button('Check undo result', () => { void checkResult(); }));
  };
  const showResult = (result: LocalUpdateUndoResult | null): void => {
    review = null; lastResult = result; panel.replaceChildren(); open.setAttribute('aria-expanded', 'false');
    if (!result) {
      open.hidden = false; open.textContent = 'Review undo';
      tell('No undo decision has been recorded. Review the changes again before approving.'); return;
    }
    const confirmed = result.status === 'completed' && result.local_receipt;
    tell(confirmed ? 'Undone. The change was reversed.'
      : result.status === 'denied' ? 'Undo declined. The original change remains.'
        : result.status === 'failed' ? 'Undo failed. The original change remains.'
          : 'Undo outcome is unknown. This approval will not run again.');
    open.hidden = result.status !== 'denied' && result.status !== 'failed';
    if (!open.hidden) open.textContent = 'Review undo again';
    if (result.status === 'unknown' || (result.status === 'completed' && !confirmed)) retryResult();
  };
  const checkResult = async (): Promise<void> => {
    if (busy || !host.isConnected) return;
    start('Checking undo result…');
    try { const result = await callers.get({ receipt_id: receiptId }); if (host.isConnected) showResult(result); }
    catch (error) { if (host.isConnected) { showError(error); retryResult(); } }
    finally { finish(); }
  };
  const expired = (ownsFocus = true): void => {
    review = null;
    for (const control of panel.querySelectorAll('button')) control.disabled = true;
    open.textContent = 'Review undo again';
    tell('This undo review expired. Review it again before deciding.', true);
    if (ownsFocus) message.focus({ preventScroll: true });
  };
  const decide = async (expected: LocalUpdateUndoReview, decision: 'approve' | 'deny'): Promise<void> => {
    if (busy || !host.isConnected || review !== expected) return;
    if (expected.expires_at <= Date.now()) { expired(); return; }
    start(decision === 'approve' ? 'Applying the reviewed undo…' : 'Declining undo…', true);
    try {
      const result = await callers.decide({ undo_id: expected.undo_id, review_hash: expected.review_hash, decision });
      if (host.isConnected) showResult(result);
    } catch (error) { if (host.isConnected) { showError(error); retryResult(); } }
    finally { finish(); }
  };
  open.onclick = async () => {
    if (busy || !host.isConnected) return;
    review = null; panel.replaceChildren(); open.setAttribute('aria-expanded', 'false'); start('Preparing undo review…');
    try {
      const prior = await callers.get({ receipt_id: receiptId });
      if (!host.isConnected) { tell(''); return; }
      if (prior && (prior.undo_id !== lastResult?.undo_id || (prior.status !== 'denied' && prior.status !== 'failed'))) { showResult(prior); return; }
      const material = await callers.review({ receipt_id: receiptId });
      if (!host.isConnected) { tell(''); return; }
      review = material;
      const title = doc.createElement('h3'); title.textContent = 'Undo this change?'; title.tabIndex = -1;
      const detail = doc.createElement('p'); detail.textContent = 'Undoing puts back what was there before. Check it, then approve. If it was edited since, the undo will not apply.';
      const changes = doc.createElement('pre'); changes.textContent = renderResourceReview(material.resource_review); changes.tabIndex = 0;
      changes.setAttribute('data-local-update-undo-preview', ''); changes.setAttribute('role', 'region'); changes.setAttribute('aria-label', 'Reviewed undo changes');
      const actions = doc.createElement('div'); actions.setAttribute('data-local-update-undo-actions', '');
      const approve = button('Approve undo', () => { void decide(material, 'approve'); }); approve.setAttribute('data-local-update-undo-approve', '');
      actions.append(approve, button('Decline undo', () => { void decide(material, 'deny'); })); panel.append(title, detail, changes, actions);
      const ownsFocus = doc.activeElement === message;
      open.setAttribute('aria-expanded', 'true'); tell('');
      if (material.expires_at <= Date.now()) expired(ownsFocus);
      else if (ownsFocus) title.focus({ preventScroll: true });
    } catch (error) { if (host.isConnected) showError(error); }
    finally { finish(); }
  };
  host.append(open, message, panel); return host;
};
