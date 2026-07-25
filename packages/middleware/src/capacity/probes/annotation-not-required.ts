/** D-145 PB1.4 — annotation_not_required sentinel.
 *
 *  Always-pass sentinel: never invokes any external state, never
 *  consults a cache row. The walker's switch dispatches to this
 *  probe before any cache read so the sentinel can short-circuit
 *  cleanly even when the broader cache subsystem is misconfigured. */

import type { CapacityProbe } from '../types.js';

export const createAnnotationNotRequiredProbe = (): CapacityProbe => ({
  kind: 'annotation_not_required',
  async probe() {
    return { ok: true };
  },
});
