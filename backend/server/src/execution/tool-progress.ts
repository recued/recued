import { AsyncLocalStorage } from 'node:async_hooks';
import { isToolProgress, TOOL_PROGRESS_INTERVAL_MS, type ToolProgress } from '@recued/contracts';

type ProgressListener = (progress: ToolProgress) => void;
const observers = new AsyncLocalStorage<{ report?: ProgressListener }>();

/** Capture at dispatch, not when a pooled transport receives a notification:
 * that socket may have been opened by an entirely different conversation. */
export const captureToolProgressReporter = (): ProgressListener | undefined => observers.getStore()?.report;

export const reportToolProgress = (progress: ToolProgress): void => {
  observers.getStore()?.report?.(progress);
};

/** One passive display per call. Coalesce to the latest real observation,
 * never manufacture timed heartbeats, and discard pending captions on settle.
 * The final result/approval/failure uses its ordinary delivery path immediately. */
export const withToolProgress = async <T>(
  listener: ProgressListener | undefined,
  run: () => Promise<T>,
): Promise<T> => {
  let active = true;
  let lastAt: number | undefined;
  let lastKey: string | undefined;
  let pending: ToolProgress | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const emit = (): void => {
    timer = undefined;
    if (!active || pending === undefined) return;
    const progress = pending;
    pending = undefined;
    const key = JSON.stringify(progress);
    if (key === lastKey) return;
    lastKey = key;
    lastAt = Date.now();
    try { listener?.(progress); } catch { /* display failure cannot fail work */ }
  };
  const report: ProgressListener = (progress) => {
    if (!active || listener === undefined || !isToolProgress(progress)) return;
    // Copy only display fields. Never forward unexpected provider properties.
    pending = { kind: progress.kind, current: progress.current,
      ...(progress.total === undefined ? {} : { total: progress.total }) };
    if (timer !== undefined) return;
    const remaining = lastAt === undefined ? 0 : TOOL_PROGRESS_INTERVAL_MS - (Date.now() - lastAt);
    if (remaining <= 0) emit();
    else {
      timer = setTimeout(emit, remaining);
      timer.unref?.();
    }
  };
  try { return await observers.run(listener === undefined ? {} : { report }, run); }
  finally {
    active = false;
    pending = undefined;
    if (timer !== undefined) clearTimeout(timer);
  }
};
