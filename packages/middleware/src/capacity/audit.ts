/** D-145 PB1.5 — audit emission helper.
 *
 *  Wraps an `AuditLogStore`-shaped emitter. The emitter contract is
 *  intentionally minimal so the engine package doesn't depend on
 *  `@recued/storage`'s SQLite-bound `AuditLogStore` directly — the
 *  PB1.7 composer constructs an adapter around the live store.
 *
 *  Spec: § B.4.4. Design: § PB1.5. */

import {
  CAPACITY_AUDIT_GAP_ACTION,
  CAPACITY_AUDIT_OK_ACTION,
  type CapacityCheckAuditDetail,
} from '@recued/contracts';

import type { CapacityAuditEmitter, CapacityWalkContext } from './types.js';

/** Minimal audit-log adapter the engine consumes. The PB1.7
 *  composer wraps a real `AuditLogStore` (or the in-memory store
 *  from `@recued/storage` test utilities). */
export interface AuditLogAdapter {
  logActivity(entry: {
    activity_id: string;
    timestamp: number;
    action: string;
    target: string;
    detail?: string;
  }): Promise<void> | void;
}

const mintActivityId = (walk_id: string, suffix: 'ok' | 'gap'): string =>
  `${walk_id}:${suffix}`;

const targetFromCtx = (ctx: CapacityWalkContext): string =>
  ctx.primitive ?? ctx.recipe_id ?? 'engine';

export const createCapacityAuditEmitter = (
  adapter: AuditLogAdapter,
): CapacityAuditEmitter => ({
  async emitOk(detail: CapacityCheckAuditDetail, ctx: CapacityWalkContext) {
    const now = ctx.now ? ctx.now() : Date.now();
    await adapter.logActivity({
      activity_id: mintActivityId(detail.walk_id, 'ok'),
      timestamp: now,
      action: CAPACITY_AUDIT_OK_ACTION,
      target: targetFromCtx(ctx),
      detail: JSON.stringify(detail),
    });
  },
  async emitGap(detail: CapacityCheckAuditDetail, ctx: CapacityWalkContext) {
    const now = ctx.now ? ctx.now() : Date.now();
    await adapter.logActivity({
      activity_id: mintActivityId(detail.walk_id, 'gap'),
      timestamp: now,
      action: CAPACITY_AUDIT_GAP_ACTION,
      target: targetFromCtx(ctx),
      detail: JSON.stringify(detail),
    });
  },
});
