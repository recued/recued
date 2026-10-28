/** D-333 — Kitchen keeps work in progress as you type.
 *
 *  An item of work in progress exists from its first change until it is saved (it becomes
 *  a recipe or an installed pack) or discarded. This adapter writes the latest source:
 *  the first write creates the item, later ones update it at the revision it last saw,
 *  and only one write is in flight at a time. A conflict or a vanished item stops it, so
 *  it never overwrites work saved elsewhere. `finish` discards the item once its work has
 *  been saved as the real thing. */
import type { KitchenImportDraft } from '@recued/contracts';

export type WorkItemAutosaveStatus =
  | { state: 'idle' }
  | { state: 'saving' }
  | { state: 'saved' }
  | { state: 'stopped'; message: string }
  | { state: 'error'; message: string };

export interface WorkItemRef { draft_id: string; revision: number }

export interface WorkItemAutosaveOptions {
  kind: KitchenImportDraft['kind'];
  /** The item being edited; absent for new work, which is created at its first change. */
  item?: WorkItemRef;
  create: (kind: KitchenImportDraft['kind'], source: string) => Promise<KitchenImportDraft>;
  update: (draftId: string, revision: number, source: string) => Promise<KitchenImportDraft>;
  discard: (draftId: string, revision: number) => Promise<unknown>;
  /** New work became an item (the route keeps its address from here on). */
  onCreated?: (item: KitchenImportDraft) => void;
  onStatus?: (status: WorkItemAutosaveStatus) => void;
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface WorkItemAutosave {
  /** The source changed; it is written after a short pause. */
  changed(source: string): void;
  /** Stop keeping edits: drop what is not written yet, wait for the write in flight, and
   *  return the item as it now stands (to discard it at its latest revision). */
  stop(): Promise<WorkItemRef | undefined>;
  /** The work was saved as the real thing: stop, and discard the item. */
  finish(): Promise<void>;
  current(): WorkItemRef | undefined;
  /** Edits not yet written, or a write in flight. */
  busy(): boolean;
  /** Edits that were never written, whether or not keeping them stopped. */
  unwritten(): boolean;
  dispose(): void;
}

const codeOf = (error: unknown): string | undefined =>
  (error as { code?: unknown } | null)?.code as string | undefined;
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const createWorkItemAutosave = (options: WorkItemAutosaveOptions): WorkItemAutosave => {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const delay = options.delayMs ?? 800;
  let item = options.item ? { ...options.item } : undefined;
  let pending: string | undefined;
  let written: string | undefined;
  let timer: unknown;
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  let finished = false;
  /** The page is closing: write what is left at once, then nothing more. */
  let closing = false;
  const status = (next: WorkItemAutosaveStatus): void => options.onStatus?.(next);

  const write = (): void => {
    timer = undefined;
    if (stopped || inFlight || pending === undefined || pending === written) return;
    const source = pending;
    status({ state: 'saving' });
    const request = item
      ? options.update(item.draft_id, item.revision, source)
      : options.create(options.kind, source);
    inFlight = request.then((result) => {
      const isNew = item === undefined;
      item = { draft_id: result.draft_id, revision: result.revision };
      written = source;
      if (isNew) options.onCreated?.(result);
      if (!stopped) status({ state: 'saved' });
    }, (error: unknown) => {
      const code = codeOf(error);
      if (code === 'unknown_method' || code === 'not_configured') {
        // A server from before D-333: retrying at every change would only repeat this.
        stopped = true;
        status({ state: 'stopped', message: 'This Recued server cannot keep work in progress. Update it, or save to keep your work.' });
      } else if (code === 'conflict' || code === 'not_found') {
        // Someone else saved, changed or discarded it: never overwrite that.
        stopped = true;
        status({ state: 'stopped', message: code === 'conflict'
          ? 'This changed somewhere else, so your latest edits were not kept here. Reopen it from Kitchen.'
          : 'This is no longer in progress in Kitchen, so your latest edits were not kept.' });
      } else {
        status({ state: 'error', message: `Could not keep your latest edits: ${messageOf(error)}. They are kept again at your next change.` });
      }
    }).finally(() => {
      inFlight = undefined;
      // Edits made while the write was in flight go next (at once when the page is closing).
      if (stopped || pending === written) return;
      if (closing) write();
      else if (timer === undefined) timer = setTimer(write, delay);
    });
  };

  const stop = async (): Promise<WorkItemRef | undefined> => {
    stopped = true;
    if (timer !== undefined) { clearTimer(timer); timer = undefined; }
    await inFlight;
    return item ? { ...item } : undefined;
  };

  return {
    changed(source: string): void {
      if (stopped || closing) return;
      pending = source;
      if (timer !== undefined) clearTimer(timer);
      timer = setTimer(write, delay);
    },
    stop,
    async finish(): Promise<void> {
      if (finished) return;
      finished = true;
      const done = await stop();
      if (done) {
        // Saved as the real thing: the work in progress is done. If it changed elsewhere
        // meanwhile, leave it for the owner to see in Kitchen rather than lose that change.
        await options.discard(done.draft_id, done.revision).catch(() => undefined);
      }
      status({ state: 'idle' });
    },
    current: () => (item ? { ...item } : undefined),
    busy: () => !stopped && (inFlight !== undefined || (pending !== undefined && pending !== written)),
    unwritten: () => pending !== undefined && pending !== written,
    dispose(): void {
      if (timer !== undefined) { clearTimer(timer); timer = undefined; }
      if (stopped || closing) return;
      // Keep the last edits when the page closes: now, or right after the write in flight.
      closing = true;
      if (!inFlight) write();
    },
  };
};
