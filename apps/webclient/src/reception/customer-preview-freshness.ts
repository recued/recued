import { customerRequestClock, type CustomerRequestClock } from './customer-request-clock.js';

/** Both saved deadlines use the response's server clock and monotonic elapsed
 * time. Older servers retain guarded review recovery and a local expiry clock. */
export const mountCustomerPreviewFreshness = (opts: {
  document: Document; host: HTMLElement; expiresAt?: number; serverNow?: number;
  customerExpiresAt: number;
  clock?: CustomerRequestClock;
  refreshLabel: string; onExpire: () => void; onRefresh: () => void;
}) => {
  const { document: doc, expiresAt, serverNow, customerExpiresAt } = opts;
  if (!Number.isSafeInteger(customerExpiresAt) || !Number.isFinite(new Date(customerExpiresAt).getTime())) return;
  const hasReview = Number.isSafeInteger(expiresAt) && Number.isSafeInteger(serverNow)
    && Number.isFinite(new Date(expiresAt!).getTime());
  const view = doc.defaultView;
  const now = opts.clock ?? customerRequestClock(doc,serverNow);
  const reference = now();
  const reviewRemaining = hasReview ? Math.max(0, expiresAt! - reference) : Infinity;
  const customerRemaining = Math.max(0, customerExpiresAt - reference);
  const root = doc.createElement('div'); opts.host.appendChild(root);
  const message = doc.createElement('p'); message.setAttribute('role', 'status'); root.appendChild(message);
  const refresh = doc.createElement('button'); refresh.type = 'button'; refresh.textContent = opts.refreshLabel; root.appendChild(refresh);
  let disposed = false; let busy = false; let forced = false; let failed = false;
  type State = 'fresh' | 'review_expired' | 'customer_expired';
  let displayed: State | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = () => Math.max(0,now() - reference);
  const customerExpired = () => elapsed() >= customerRemaining;
  const state = (): State => customerExpired() ? 'customer_expired'
    : forced || elapsed() >= reviewRemaining ? 'review_expired' : 'fresh';
  const isExpired = () => state() !== 'fresh';
  const render = (current: State) => {
    root.hidden = !hasReview && !forced && current === 'fresh';
    if (hasReview || forced) root.setAttribute('data-customer-preview-freshness','');
    if (current === 'customer_expired') root.setAttribute('data-customer-request-ended','');
    message.replaceChildren();
    if (current === 'customer_expired') message.textContent = 'The saved customer link deadline has passed. Prepare a new request to continue. Refreshing the review cannot extend it.';
    else if (failed) message.textContent = 'Could not refresh this review. Retry to review the same saved request. The customer link deadline stays the same.';
    else if (current === 'review_expired') message.textContent = 'This review needs to be refreshed before publishing. The saved customer link deadline stays the same.';
    else if (hasReview) {
      message.appendChild(doc.createTextNode('Review valid until '));
      const time = doc.createElement('time'); time.dateTime = new Date(expiresAt!).toISOString();
      time.textContent = new Date(expiresAt!).toLocaleString(undefined, { timeZoneName: 'short' }); message.appendChild(time);
      message.appendChild(doc.createTextNode('. The customer link deadline is shown separately above.'));
    }
    refresh.textContent = failed ? opts.refreshLabel.replace(/^Refresh /,'Retry ') : opts.refreshLabel;
    refresh.hidden = current !== 'review_expired'; refresh.disabled = busy;
  };
  const update = () => {
    if (disposed) return;
    if (root.isConnected === false) { dispose(); return; }
    if (timer !== undefined) clearTimeout(timer);
    const current = state(); const changed = displayed !== undefined && displayed !== current;
    displayed = current; render(current); if (changed && current !== 'fresh') opts.onExpire();
    // The customer deadline can end while an expired review waits for a retry.
    if (current !== 'customer_expired') {
      const next = Math.min(customerRemaining, current === 'fresh' ? reviewRemaining : Infinity);
      timer = setTimeout(update, Math.min(Math.max(1,next - elapsed()), 2_147_483_647));
    }
  };
  const returned = () => { if (doc.visibilityState !== 'hidden') update(); };
  const dispose = () => {
    disposed = true; if (timer !== undefined) clearTimeout(timer);
    doc.removeEventListener?.('visibilitychange', returned); view?.removeEventListener('focus', returned); root.remove();
  };
  refresh.addEventListener('click', () => { if (!busy && !disposed && state() === 'review_expired') opts.onRefresh(); });
  doc.addEventListener?.('visibilitychange', returned); view?.addEventListener('focus', returned);
  update();
  return { element: root,isExpired,customerExpired,
    invalidateReview: () => { forced = true; update(); },
    failed: () => { forced = true; failed = true; update(); },
    setBusy: (value: boolean) => { busy = value; refresh.disabled = value; }, dispose };
};
