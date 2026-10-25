import type { CustomerRequestClock } from './customer-request-clock.js';

/** Keep bearer links in the current view only. A late clipboard response must
 * never update a replacement view or a disposed route. */
export const mountCustomerLinkShare = (opts: {
  document: Document; host: HTMLElement; label: string; heading: string;
  url: string; expiresAt: number; check?: () => Promise<boolean>;
  now?: CustomerRequestClock;
  customer: string; quoteLabel: string; quoteReference?: string;
}) => {
  const doc = opts.document;
  const root = doc.createElement('section');
  root.setAttribute('data-customer-link-share', '');
  root.setAttribute('aria-label', opts.label + ' sharing');
  const style = doc.createElement('style');
  style.textContent = `[data-customer-link-share]{display:grid;gap:12px;min-width:0;padding:16px;border:1px solid var(--border);border-radius:10px;background:var(--surface-sunk)}
    [data-customer-link-share] h3,[data-customer-link-share] p{margin:0}
    [data-customer-link-share] input{min-width:0;box-sizing:border-box;max-width:100%}
    [data-customer-link-share] button{min-height:44px;background:var(--accent);border-color:var(--accent);color:var(--on-accent,#fff)}`;
  root.appendChild(style);
  const heading = doc.createElement('h3'); heading.textContent = opts.heading; root.appendChild(heading);
  const identity = doc.createElement('p'); identity.setAttribute('data-customer-link-identity', '');
  identity.textContent = `${opts.quoteLabel} — ${opts.customer}${opts.quoteReference ? ` · Quote ${opts.quoteReference}` : ''}`;
  root.appendChild(identity);
  const help = doc.createElement('p');
  help.textContent = 'Copy this link to share with your customer. It accepts one response. If you lose it, rotate the link in Manage.';
  root.appendChild(help);
  const expiry = doc.createElement('p'); expiry.textContent = 'Expires ';
  const time = doc.createElement('time');
  time.dateTime = new Date(opts.expiresAt).toISOString();
  time.textContent = new Date(opts.expiresAt).toLocaleString(undefined, { timeZoneName: 'short' });
  expiry.appendChild(time); root.appendChild(expiry);
  const label = doc.createElement('label'); label.textContent = opts.label;
  const input = doc.createElement('input'); input.type = 'url'; input.readOnly = true; input.value = opts.url;
  label.appendChild(input); root.appendChild(label);
  input.addEventListener('focus', () => input.select());
  const copy = doc.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy link'; root.appendChild(copy);
  const message = doc.createElement('p'); message.setAttribute('role', 'status'); root.appendChild(message);
  const retry = doc.createElement('button'); retry.type = 'button'; retry.textContent = 'Check link availability'; retry.hidden = true; root.appendChild(retry);
  let revision = 0; let available = true; let disposed = false;
  let interaction = 0;
  let clipboardIntent = 0;
  const copiedElsewhere = (event: Event) => { if (event.isTrusted) clipboardIntent++; };
  doc.addEventListener('copy', copiedElsewhere, true); doc.addEventListener('cut', copiedElsewhere, true);
  const interacted = () => { interaction++; };
  doc.addEventListener('pointerdown', interacted, true); doc.addEventListener('keydown', interacted, true);
  const focusedElsewhere = (event: Event) => { if (event.target !== input) interacted(); };
  doc.addEventListener('focusin', focusedElsewhere, true);
  let inFlight: { revision: number; promise: Promise<boolean> } | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const now = opts.now ?? Date.now;
  const expired = () => now() >= opts.expiresAt;
  const unavailable = (isExpired = false) => {
    revision++; available = false; copy.disabled = true; input.disabled = true; input.value = ''; retry.hidden = true;
    heading.textContent = 'Link unavailable';
    help.textContent = isExpired ? 'This saved link has expired. Review the request before preparing another link.'
      : 'This saved link is no longer available. Review the request in history before sharing another link.';
    message.textContent = isExpired ? 'Link expired. Do not share it.' : 'Link replaced, closed, expired or rotated. Do not share it.';
    if (expiryTimer !== undefined) { clearTimeout(expiryTimer); expiryTimer = undefined; }
  };
  const watchExpiry = () => {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    if (disposed) return;
    if (expired()) { unavailable(true); return; }
    expiryTimer = setTimeout(() => {
      expiryTimer = undefined;
      if (!root.isConnected) { dispose(); return; }
      watchExpiry();
    }, Math.min(opts.expiresAt - now(), 2_147_483_647));
  };
  const checking = () => {
    if (disposed) return;
    revision++; available = false; copy.disabled = true; input.disabled = true; input.value = ''; retry.hidden = true;
    heading.textContent = 'Checking saved link';
    message.textContent = 'Checking whether this saved link is still available…';
  };
  const check = (): Promise<boolean> => {
    if (disposed || !root.isConnected) return Promise.resolve(false);
    if (expired()) { unavailable(true); return Promise.resolve(false); }
    if (!opts.check) return Promise.resolve(available);
    if (inFlight?.revision === revision) return inFlight.promise;
    const selection = doc.activeElement === input && !input.disabled && input.value === opts.url
      ? { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection, interaction,
        fallback: message.textContent?.startsWith('Copy is unavailable.') ? message.textContent : undefined } : undefined;
    checking(); const current = revision;
    const promise = Promise.resolve().then(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (disposed || !root.isConnected || current !== revision) return false;
        const valid = await Promise.race([opts.check!(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Link check timed out')), 5_000);
        })]);
        if (disposed || !root.isConnected || current !== revision) return false;
        if (!valid || expired()) { unavailable(expired()); return false; }
        available = true; copy.disabled = false; input.disabled = false; input.value = opts.url;
        heading.textContent = opts.heading;
        help.textContent = 'This saved link is still available. Copy it to share with your customer.';
        message.textContent = 'Link available.';
        if (selection && selection.interaction === interaction && (doc.activeElement === doc.body || doc.activeElement === input)) {
          input.focus({ preventScroll: true });
          input.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
          if (selection.fallback) message.textContent = selection.fallback;
        }
        watchExpiry(); return true;
      } catch {
        if (disposed || !root.isConnected || current !== revision) return false;
        heading.textContent = 'Link availability unknown';
        message.textContent = 'Could not confirm this link’s availability. Check again before sharing.'; retry.hidden = false;
        return false;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (inFlight?.revision === current) inFlight = undefined;
      }
    });
    inFlight = { revision: current, promise }; return promise;
  };
  retry.addEventListener('click', () => { void check(); });
  copy.addEventListener('click', async () => {
    if (copy.disabled || !available || !root.isConnected) return;
    const copyInteraction = interaction;
    const copyIntent = clipboardIntent;
    if (!await check() || !available || disposed || !root.isConnected) return;
    if (expired()) { unavailable(true); return; }
    if (copyIntent !== clipboardIntent) {
      message.textContent = 'You copied something else. Choose Copy link again to copy this link.';
      return;
    }
    const current = revision;
    copy.disabled = true;
    let copied = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const clipboard = doc.defaultView?.navigator.clipboard;
      if (!clipboard?.writeText) throw new Error('Clipboard unavailable');
      await Promise.race([
        clipboard.writeText(opts.url),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Clipboard timed out')), 2_000); }),
      ]);
      if (root.isConnected && current === revision) { copied = true; message.textContent = 'Link copied.'; }
    } catch {
      if (root.isConnected && current === revision) {
        const select = copyInteraction === interaction
          && (doc.activeElement === doc.body || doc.activeElement === copy || doc.activeElement === input);
        if (select) { input.focus(); input.select(); }
        message.textContent = select ? 'Copy is unavailable. The link is selected; copy it from the field above.'
          : 'Copy is unavailable. Select and copy the link from the field above.';
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (!disposed && root.isConnected && current === revision) {
        copy.disabled = !available;
        if (copied && available && copyInteraction === interaction && copyIntent === clipboardIntent
          && (doc.activeElement === doc.body || doc.activeElement === copy)) copy.focus({ preventScroll: true });
      }
    }
  });
  const onReturn = () => {
    if (disposed || !root.isConnected || doc.visibilityState === 'hidden') return;
    void check();
  };
  const dispose = () => {
    disposed = true; revision++; available = false;
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    doc.removeEventListener('visibilitychange', onReturn);
    doc.removeEventListener('pointerdown', interacted, true); doc.removeEventListener('keydown', interacted, true);
    doc.removeEventListener('focusin', focusedElsewhere, true);
    doc.removeEventListener('copy', copiedElsewhere, true); doc.removeEventListener('cut', copiedElsewhere, true);
    doc.defaultView?.removeEventListener('focus', onReturn); root.remove();
  };
  opts.host.replaceChildren(root);
  doc.addEventListener('visibilitychange', onReturn); doc.defaultView?.addEventListener('focus', onReturn);
  watchExpiry();
  return { checking, check, close: () => unavailable(expired()), dispose };
};
