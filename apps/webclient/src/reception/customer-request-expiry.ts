import type { CustomerRequestClock } from './customer-request-clock.js';

const remaining = (expiresAt: number, now: number): string => {
  const left = expiresAt - now;
  const about = (value: number, unit: string) => `About ${value} ${unit}${value === 1 ? '' : 's'} left`;
  if (left <= 0) return 'Expired';
  if (left < 60_000) return 'Less than a minute left';
  if (left < 3_600_000) return about(Math.round(left / 60_000), 'minute');
  if (left < 172_800_000) return about(Math.round(left / 3_600_000), 'hour');
  return about(Math.round(left / 86_400_000), 'day');
};

const clocks = new WeakMap<HTMLElement, () => number>();
const nowFor = (node: HTMLElement) => clocks.get(node)?.() ?? Date.now();

/** The saved deadline belongs to the request. Resuming never restarts its life. */
export const customerRequestExpiry = (doc: Document, expiresAt: number, clock?: CustomerRequestClock): HTMLElement => {
  const root = doc.createElement('p'); root.setAttribute('data-customer-request-expiry', String(expiresAt));
  if (clock) clocks.set(root,clock);
  const label = doc.createElement('span'); label.textContent = 'Customer link expires '; root.appendChild(label);
  const time = doc.createElement('time'); time.dateTime = new Date(expiresAt).toISOString();
  time.textContent = new Date(expiresAt).toLocaleString(undefined, { timeZoneName: 'short' }); root.appendChild(time);
  const left = doc.createElement('span'); left.setAttribute('data-customer-request-remaining', '');
  left.textContent = ` · ${remaining(expiresAt, nowFor(root))}.`; root.appendChild(left); return root;
};

export const refreshCustomerRequestExpiries = (root: HTMLElement): void => {
  for (const node of root.querySelectorAll<HTMLElement>('[data-customer-request-expiry]')) {
    const expiresAt = Number(node.getAttribute('data-customer-request-expiry'));
    const label = node.querySelector<HTMLElement>('[data-customer-request-remaining]');
    if (label && Number.isFinite(expiresAt)) label.textContent = ` · ${remaining(expiresAt, nowFor(node))}.`;
  }
};

export const customerPreviewExpired = (error: unknown): boolean =>
  error !== null && typeof error === 'object' && 'code' in error && error.code === 'preview_hash_expired'
  || error instanceof Error && /preview_hash expired|preview has expired/i.test(error.message);
