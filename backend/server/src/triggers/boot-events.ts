/**
 * D-124 — what reached the warehouse bus before the trigger dispatcher could
 * hear it.
 *
 * At boot the collections start before `composeListeners` composes the
 * dispatcher: a mailbox's `sync.start()` awaits its scan, which reads the mail
 * that came while the server was down, and each such email's
 * `data.mail.<slug>.message.created` reached no trigger. Every recipe that
 * runs on new mail missed it, on every server whose vault unlocks at boot — and
 * a calendar's scan the same, a meeting moved while the server was down, and a
 * folder's walk and the mail's attachments.
 *
 * The recorder listens from before the collections start. It keeps what a
 * trigger would have been told — `keep` applies the dispatcher's own rules at
 * the moment of the event, so a mailbox's first scan, which finds past mail,
 * stays silent — until the dispatcher subscribes (`seal`), and hands it over
 * once the dispatcher can act on it (`replay`), one event at a time as its
 * queue has room. It never emits on the bus: the bus's other subscribers
 * heard each event when it came.
 */

import type { WarehouseEvent, WarehouseEventBus, WarehouseEventKind } from '@recued/warehouse-events';

import type { BackfillStateLookup } from './backfill-state.js';

/** What a trigger would have been told of, by platform: mail's arrivals; a
 *  calendar's changes, since a meeting moved while the server was down is what
 *  an `updated` trigger watches; a file's — a watched folder's, and a mail
 *  attachment received while the server was down. Each is emitted only for a
 *  real change. */
export const BOOT_EVENT_KINDS: Readonly<Partial<Record<string, readonly WarehouseEventKind[]>>> = {
  mail: ['created'],
  calendar: ['created', 'updated', 'deleted'],
  file: ['created', 'updated', 'deleted'],
};

/** The dispatcher's own rules, asked as each event comes: of a kind kept for
 *  its platform, from a collection whose first scan had finished — a first
 *  scan finds what was already there, which fires nothing (Phase 2.2). */
export const bootEventKeep = (backfill: Pick<BackfillStateLookup, 'isComplete'> | undefined) =>
  (event: WarehouseEvent): boolean =>
    BOOT_EVENT_KINDS[event.platform]?.includes(event.event_kind) === true
    && event.in_drain !== true
    && backfill?.isComplete(event.platform, event.slug) === true;

export interface BootEventRecorder {
  /** The dispatcher is subscribed and hears what comes now: record no more. */
  seal(): void;
  /** Once, after `seal`: each recorded event, in order, to `deliver`, each
   *  once `room` resolves. Resolves when the last has been handed over. */
  replay(deliver: (event: WarehouseEvent) => void, room?: () => Promise<void>): Promise<void>;
}

export const createBootEventRecorder = (opts: {
  readonly bus: WarehouseEventBus;
  /** The bus pattern of the events kept, e.g. `data.mail.**.created`. */
  readonly pattern: string;
  /** Whether a trigger would have been told of it, asked as it comes. */
  readonly keep: (event: WarehouseEvent) => boolean;
  readonly logger?: { warn(message: string, detail?: unknown): void };
}): BootEventRecorder => {
  const recorded: WarehouseEvent[] = [];
  let unsubscribe: (() => void) | null = opts.bus.subscribe(opts.pattern, (event) => {
    if (opts.keep(event)) recorded.push(event);
  });
  let replayed: Promise<void> | null = null;
  const seal = (): void => {
    unsubscribe?.();
    unsubscribe = null;
  };
  return {
    seal,
    replay: (deliver, room) => {
      // Handed over, nothing is recorded again.
      seal();
      replayed ??= (async () => {
        while (recorded.length > 0) {
          if (room !== undefined) {
            try {
              await room();
            } catch {
              /* the event is handed over regardless */
            }
          }
          const event = recorded.shift()!;
          try {
            deliver(event);
          } catch (error) {
            opts.logger?.warn('boot events: one could not be handed over', { error, pattern: opts.pattern });
          }
        }
      })();
      return replayed;
    },
  };
};
