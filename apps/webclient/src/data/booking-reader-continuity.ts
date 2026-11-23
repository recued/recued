export interface BookingReaderPosition { top: number; focus?: string }
/** The booking is an in-page reader, so its scroll belongs to the route host. */
export const createBookingReaderContinuity = () => {
  let binding = '', position: BookingReaderPosition = { top: 0 }, awaitingPaint = false;
  const reader = (root: HTMLElement) => {
    const view = typeof root.querySelector === 'function' ? root.querySelector<HTMLElement>('[data-booking-id]') : null;
    return view && typeof view.querySelectorAll === 'function' && typeof view.contains === 'function' ? view : null;
  };
  return {
    reset() { binding = ''; position = { top: 0 }; awaitingPaint = false; },
    bind(key: string) { if (key !== binding) { binding = key; position = { top: 0 }; awaitingPaint = false; } },
    capture(root: HTMLElement, host: Element | null) {
      const view = reader(root); if (!view || awaitingPaint || !binding) return;
      position.top = host?.scrollTop ?? 0;
      const active = root.ownerDocument?.activeElement as HTMLElement | null;
      if (active && view.contains(active)) position.focus = active.closest('[data-booking-focus]')?.getAttribute('data-booking-focus') ?? undefined;
      else if (active && active !== root.ownerDocument.body) position.focus = undefined;
    },
    interact() { awaitingPaint = false; position.focus = undefined; },
    snapshot(): BookingReaderPosition { return { ...position }; },
    resume(saved: BookingReaderPosition) { position = { ...saved }; awaitingPaint = true; },
    restore(root: HTMLElement, host: Element | null) {
      const view = reader(root); if (!view || !binding) return;
      if (host) host.scrollTop = position.top;
      const target = position.focus ? [...view.querySelectorAll<HTMLElement>('[data-booking-focus]')].find(node => node.getAttribute('data-booking-focus') === position.focus && !node.hasAttribute('disabled')) : null;
      if (target) target.focus({ preventScroll: true });
      else if (awaitingPaint && position.focus && !(position.focus === 'customer' && view.querySelector('[data-booking-customer-state="loading"]'))) {
        const fallback = position.focus === 'customer' ? view.querySelector<HTMLElement>('[data-booking-focus="retry-customer"]') : null;
        const heading = fallback ?? view.querySelector<HTMLElement>('[data-booking-focus="heading"]');
        heading?.focus({ preventScroll: true }); position.focus = heading?.getAttribute('data-booking-focus') ?? undefined;
      }
      // A customer return waits for the label lookup before restoring its button.
      awaitingPaint = !target && position.focus === 'customer' && !!view.querySelector('[data-booking-customer-state="loading"]');
    },
  };
};
