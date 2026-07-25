/** D-145 PB1.5 — transparency-stream emission helper.
 *
 *  PB1 emits the typed event into a `CapacityTransparencyEmitter`.
 *  PB7's transparency-stream composer has landed, but no live caller
 *  yet wires this emitter through it to the webclient renderer +
 *  bridge popup + OS notification surface — so PB1.7's composer ships
 *  a no-op default.
 *
 *  Spec: § B.4.4. Design: § PB1.5. */

import type { CapacityCheckGapTransparencyEvent } from '@recued/contracts';

import type { CapacityTransparencyEmitter } from './types.js';

/** No-op emitter — the default until a live caller wires a real one.
 *  The walker still invokes it on every user-visible gap; the noop
 *  just absorbs the call. */
export const createNoopTransparencyEmitter = (): CapacityTransparencyEmitter => ({
  async emit() {
    // intentionally empty
  },
});

/** Test helper — captures every emitted event in an array for
 *  assertion. Returned as a tuple so tests can name the array
 *  cleanly. */
export const createCapturingTransparencyEmitter = (): [
  CapacityTransparencyEmitter,
  CapacityCheckGapTransparencyEvent[],
] => {
  const events: CapacityCheckGapTransparencyEvent[] = [];
  const emitter: CapacityTransparencyEmitter = {
    async emit(event) {
      events.push(event);
    },
  };
  return [emitter, events];
};
