/** Boot-scoped authority for source-server work that has been dispatched but
 * has not settled yet. Callers are wrapped at the composition boundary so
 * background reads remain invisible to the server-switch fence, while work
 * survives an ordinary route change until its outcome is known. */
export interface ServerSwitchActiveWork {
  /** Stable for the lifetime of this one action. Switch reviews compare ids so
   * a newly-started request cannot hide behind an older `in_flight` review. */
  readonly id: string;
  /** Short, owner-facing description such as "Creating a backup". */
  readonly label: string;
  /** Exact source-server route where the owner can inspect progress/result. */
  readonly returnHref?: string;
  /** Optional action copy; defaults to "Return to work" at the surface. */
  readonly returnLabel?: string;
  /** Server job identity, when a short request starts longer-lived work. */
  readonly jobId?: string;
  /** A terminal outcome can still need a source-server receipt to be seen. */
  readonly phase?: 'working' | 'result_ready';
}

export type ServerSwitchWorkDetails = Omit<ServerSwitchActiveWork, 'id'> & {
  readonly id?: string;
};

/** Callable to preserve the original `release()` ergonomics. Metadata can be
 * enriched after a start rpc returns a durable server job id. */
export interface ServerSwitchWorkLease {
  (): void;
  readonly id: string;
  update(details: Partial<Omit<ServerSwitchActiveWork, 'id'>>): void;
}

export interface ServerSwitchWorkTracker {
  /** Mark callback-driven work (streaming upload/download) active. The
   * returned release is idempotent so success, error, and cancel may race. */
  begin(details?: ServerSwitchWorkDetails): ServerSwitchWorkLease;
  track<Args extends unknown[], Result>(
    work: (...args: Args) => Promise<Result>,
    details?: ServerSwitchWorkDetails,
  ): (...args: Args) => Promise<Result>;
  hasInFlightWork(): boolean;
  /** Oldest-first immutable snapshot for switch copy and return actions. */
  activeWork(): ReadonlyArray<ServerSwitchActiveWork>;
  /** Route-independent chrome uses this to keep an active-work callout live. */
  subscribe(
    listener: (work: ReadonlyArray<ServerSwitchActiveWork>) => void,
  ): () => void;
}

const DEFAULT_WORK_LABEL = 'Finishing an action';

export const createServerSwitchWorkTracker = (
  defaultDetails?: () => ServerSwitchWorkDetails,
): ServerSwitchWorkTracker => {
  let nextId = 0;
  const active = new Map<string, ServerSwitchActiveWork>();
  const listeners = new Set<(
    work: ReadonlyArray<ServerSwitchActiveWork>,
  ) => void>();
  const snapshot = (): ReadonlyArray<ServerSwitchActiveWork> =>
    Array.from(active.values(), (work) => ({ ...work }));
  const notify = (): void => {
    const work = snapshot();
    for (const listener of listeners) {
      try {
        listener(work);
      } catch {
        /* presentation observers never own action execution */
      }
    }
  };
  const begin = (details?: ServerSwitchWorkDetails): ServerSwitchWorkLease => {
    let resolved: ServerSwitchWorkDetails;
    try {
      resolved = details ?? defaultDetails?.() ?? { label: DEFAULT_WORK_LABEL };
    } catch {
      // A presentation probe must never make the protected action fail.
      resolved = details ?? { label: DEFAULT_WORK_LABEL };
    }
    const requestedId = resolved.id?.trim();
    const incarnation = ++nextId;
    // A reviewed action id must never be recycled for a later action. Append a
    // boot-monotonic incarnation instead of retaining an unbounded retired-id
    // set for the lifetime of a long-running tab.
    const id = requestedId !== undefined && requestedId.length > 0
      ? `${requestedId}:${incarnation}`
      : `work-${incarnation}`;
    active.set(id, {
      id,
      label: resolved.label.trim() || DEFAULT_WORK_LABEL,
      ...(resolved.returnHref !== undefined
        ? { returnHref: resolved.returnHref }
        : {}),
      ...(resolved.returnLabel !== undefined
        ? { returnLabel: resolved.returnLabel }
        : {}),
      ...(resolved.jobId !== undefined ? { jobId: resolved.jobId } : {}),
      ...(resolved.phase !== undefined ? { phase: resolved.phase } : {}),
    });
    notify();
    let released = false;
    const release = (() => {
      if (released) return;
      released = true;
      active.delete(id);
      notify();
    }) as ServerSwitchWorkLease;
    Object.defineProperty(release, 'id', { value: id, enumerable: true });
    release.update = (update) => {
      if (released) return;
      const current = active.get(id);
      if (current === undefined) return;
      active.set(id, {
        ...current,
        ...update,
        label: update.label?.trim() || current.label,
      });
      notify();
    };
    return release;
  };
  return {
    begin,
    track: <Args extends unknown[], Result>(
      work: (...args: Args) => Promise<Result>,
      details?: ServerSwitchWorkDetails,
    ): ((...args: Args) => Promise<Result>) => async (...args) => {
      const release = begin(details);
      try {
        return await work(...args);
      } finally {
        release();
      }
    },
    hasInFlightWork: () => active.size > 0,
    activeWork: snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      try {
        listener(snapshot());
      } catch {
        /* match update isolation */
      }
      return () => listeners.delete(listener);
    },
  };
};
