import type { MailFollowUpService } from './mail-follow-up-service.js';

/** Restart resumes persisted watches. One pass at a time; stop drains the
 * active pass before the host releases its database. */
export const createMailFollowUpRuntime = (service: Pick<MailFollowUpService, 'sweep'>, intervalMs = 30_000) => {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = service.sweep()
      .catch(() => { /* Locked and temporarily unavailable stores retry on the next tick. */ })
      .finally(() => { running = undefined; });
    return running;
  };
  return {
    tick,
    start() {
      if (timer || stopped) return;
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
};
