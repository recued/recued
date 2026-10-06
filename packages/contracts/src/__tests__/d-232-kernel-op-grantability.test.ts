/** D-232 § 20.20 — which kernel ops a door may be granted.
 *
 * ⛔ THIS IS A USEFULNESS FENCE, NOT A SAFETY ONE, and the tests are written to
 * keep it that way. Everything dangerous stays GRANTABLE and is gated by RISK;
 * what is excluded is excluded because granting it accomplishes nothing for the
 * holder. A future reader tempted to add "this one looks scary" to the exclusion
 * list should fail the destructive/dom assertions below first.
 */
import { describe, expect, it } from 'vitest';

import {
  KERNEL_OP_GRANT_EXCLUSIONS,
  KERNEL_OP_REGISTRY,
  isGrantableKernelOp,
} from '../index.js';

describe('D-232 § 20.20 — the kernel grant fence', () => {
  it('⛔ excludes every ai op — the grant would spend the owner\'s inference budget', () => {
    const ai = KERNEL_OP_REGISTRY.filter((e) => e.domain === 'ai').map((e) => e.op);
    expect(ai.length).toBeGreaterThan(0);
    for (const op of ai) expect(isGrantableKernelOp(op), op).toBe(false);
  });

  it('⛔ excludes every watch op — a watcher is a trigger evaluator, not a read', () => {
    const watch = KERNEL_OP_REGISTRY.filter((e) => e.domain === 'watch').map((e) => e.op);
    expect(watch.length).toBeGreaterThan(0);
    for (const op of watch) expect(isGrantableKernelOp(op), op).toBe(false);
  });

  it('⛔ excludes the recipe-callback — a door must not queue pushes at other doors', () => {
    expect(isGrantableKernelOp('core.notification.recipe-callback')).toBe(false);
  });

  it('✅✅ DESTRUCTIVE ops stay grantable — risk gates them, grantability does not', () => {
    // The assertion that keeps this a usefulness fence. If someone later "hardens"
    // it by excluding destructive ops, this reddens and says why: an owner who
    // cannot NAME an op cannot grant it deliberately either, and the approval
    // floor already stops it running unasked.
    const destructive = KERNEL_OP_REGISTRY
      .filter((e) => e.risk === 'destructive').map((e) => e.op);
    expect(destructive.length).toBeGreaterThan(0);
    for (const op of destructive) expect(isGrantableKernelOp(op), op).toBe(true);
  });

  it('✅ dom.read and dom.write stay grantable — invasive is a reason to GATE', () => {
    // Owner's explicit call: a door driving the owner's browser is a real
    // capability to offer (`codex → recued → dom`), and `dom.write` is `write`
    // risk so it already asks.
    expect(isGrantableKernelOp('core.dom.read')).toBe(true);
    expect(isGrantableKernelOp('core.dom.write')).toBe(true);
  });

  it('✅ the everyday reads a delegated AI needs are grantable', () => {
    for (const op of [
      'core.data.calendar.list', 'core.mail.email.list', 'core.storage.file.list',
      'core.contact.resolve', 'core.memory.timeline.read',
    ]) {
      expect(isGrantableKernelOp(op), op).toBe(true);
    }
  });

  it('⛔ an UNREGISTERED id is not grantable — the fence never invents ops', () => {
    expect(isGrantableKernelOp('core.nope.invented')).toBe(false);
    expect(isGrantableKernelOp('')).toBe(false);
  });

  it('⚠ the exclusion set is DERIVED, and stays small', () => {
    // Derived from the registry (`domain === 'ai' | 'watch'`), so a kernel op
    // added tomorrow is grantable by DEFAULT — the correct direction for a
    // usefulness fence: forgetting one means "the owner cannot grant something
    // useful", never "a door reaches something it should not".
    // 15 since 2026-10-05: five `core.watch.*` ops were retired (it was 20).
    const grantable = KERNEL_OP_REGISTRY.filter((e) => isGrantableKernelOp(e.op));
    expect(KERNEL_OP_GRANT_EXCLUSIONS.size).toBe(15);
    expect(grantable.length).toBe(KERNEL_OP_REGISTRY.length - 15);
  });
});
