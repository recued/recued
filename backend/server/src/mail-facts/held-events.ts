/**
 * D-315 §5 — a fact's event, held until a trigger can hear it.
 *
 * A fact announces once: marked announced, it is never emitted again. At boot
 * the mailboxes start — a restart's scan reads the mail that came while the
 * server was down, and the AI pass resumes its queue — before the trigger
 * dispatcher subscribes (`startBootRecoveryAndAdapters` runs before
 * `composeListeners`). An event emitted then reached no trigger, and its
 * recipe never ran.
 *
 * So the fact writer's events wait here until the server opens them — once the
 * dispatcher is subscribed and the pre-approval driver it captures through is
 * there — and then go out in order, each waiting for room in the trigger queue
 * as a producer that can wait does. What comes while they go out waits behind
 * them; after, events go straight out.
 */

import type { WarehouseEvent } from '@recued/warehouse-events';

export interface HeldMailFactEvents {
  /** The fact writer's `emit`. */
  emit(event: WarehouseEvent): void;
  /** Once: the held events go out, in order. Resolves when the last has. */
  open(room?: () => Promise<void>): Promise<void>;
}

export const createHeldMailFactEvents = (
  emit: (event: WarehouseEvent) => void,
  logger?: { warn(message: string, detail?: unknown): void },
): HeldMailFactEvents => {
  const held: WarehouseEvent[] = [];
  let flowing = false;
  let opened: Promise<void> | null = null;
  const send = (event: WarehouseEvent): void => {
    try {
      emit(event);
    } catch (error) {
      logger?.warn('mail fact: an event could not be emitted', { error });
    }
  };
  return {
    emit: (event) => {
      if (flowing) send(event);
      else held.push(event);
    },
    open: (room) => {
      opened ??= (async () => {
        while (held.length > 0) {
          if (room !== undefined) {
            try {
              await room();
            } catch {
              /* the event goes out regardless */
            }
          }
          send(held.shift()!);
        }
        flowing = true;
      })();
      return opened;
    },
  };
};
