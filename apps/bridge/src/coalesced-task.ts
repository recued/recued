/** A fixed batching window and one active task. Requests received during a
 *  task become one follow-up; they cannot postpone the current window. */
export const createCoalescedTask = (run: () => unknown | Promise<unknown>, delay_ms = 50) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false, dirty = false, stopped = false;
  const schedule = (): void => {
    if (stopped || running || timer !== undefined || !dirty) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped) return;
      dirty = false; running = true;
      void Promise.resolve().then(run).catch(() => undefined).then(() => {
        running = false;
        schedule();
      });
    }, delay_ms);
  };
  return {
    request(): void {
      if (stopped) return;
      dirty = true;
      schedule();
    },
    stop(): void {
      stopped = true; dirty = false;
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    },
  };
};
