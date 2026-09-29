/**
 * D-315 §6 — announcing that the owner's mail facts moved, on the realtime
 * bus's `mail_fact` kind, so a Mail facts view re-reads what it shows.
 *
 * A scan or a backfill writes one email's facts at a time. Announcing each
 * write would put hundreds of identical frames on the bus and push other
 * kinds out of its replay ring, so a change is announced at most once per
 * `delayMs`, trailing: the change that arrives last is always announced.
 */

/** The `mail_fact` broadcast's subkinds. */
export type MailFactAnnouncement = 'facts' | 'templates' | 'backfill';

export interface MailFactAnnouncer {
  announce(what: MailFactAnnouncement): void;
  /** Drop pending announcements (shutdown). */
  dispose(): void;
}

export const createMailFactAnnouncer = (
  emit: (what: MailFactAnnouncement) => void,
  delayMs = 1_000,
): MailFactAnnouncer => {
  const pending = new Map<MailFactAnnouncement, ReturnType<typeof setTimeout>>();
  return {
    announce: (what) => {
      if (pending.has(what)) return;
      const timer = setTimeout(() => {
        pending.delete(what);
        try {
          emit(what);
        } catch {
          /* the bus is best-effort; the facts are already stored */
        }
      }, delayMs);
      (timer as { unref?: () => void }).unref?.();
      pending.set(what, timer);
    },
    dispose: () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    },
  };
};
