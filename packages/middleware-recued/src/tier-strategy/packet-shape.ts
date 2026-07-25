/** D-145 PB4 — packet shape budget enforcement.
 *
 *  Per § B.3.1 (per-tier packet shape table) + § B.3.3 (strategy
 *  implications). The engine narrows context to the per-tier budget
 *  BEFORE invoking `ai.synthesize`; over-budget packets fail the
 *  shape validator rather than silently truncating, since silent
 *  truncation hides what was dropped from the audit trail.
 *
 *  Three independent budgets per tier:
 *    - `max_packet_bytes` — serialized JSON size
 *    - `max_alternatives` — alternatives the engine includes (§ B.6)
 *    - `max_rounds` — synthesis rounds per turn
 *
 *  Pure validator. The orchestrator policy / synthesis composer
 *  invokes it before the `ai.synthesize` primitive call so violations
 *  surface as structured `PacketShapeViolation` instances rather
 *  than primitive-call errors after the fact.
 *
 *  Spec: § B.3.1 + § B.3.3 + § C.3.6. */

import {
  TIER_PACKET_BUDGETS,
  type ModelTier,
  type TierPacketBudget,
} from '@recued/contracts';

export const PACKET_SHAPE_VIOLATION_KINDS = [
  'packet_oversized',
  'too_many_alternatives',
  'too_many_rounds',
] as const;
export type PacketShapeViolationKind = (typeof PACKET_SHAPE_VIOLATION_KINDS)[number];
export const PACKET_SHAPE_VIOLATION_KIND_SET: ReadonlySet<PacketShapeViolationKind> = new Set(
  PACKET_SHAPE_VIOLATION_KINDS,
);

export interface PacketShapeViolation {
  readonly kind: PacketShapeViolationKind;
  readonly tier: ModelTier;
  readonly limit: number;
  readonly actual: number;
  readonly detail: string;
}

export class PacketShapeError extends Error {
  readonly code = 'PACKET_SHAPE_VIOLATION' as const;
  readonly violations: ReadonlyArray<PacketShapeViolation>;
  constructor(violations: ReadonlyArray<PacketShapeViolation>) {
    super(`Packet shape violation: ${violations.length} issue(s)`);
    this.name = 'PacketShapeError';
    this.violations = violations;
  }
}

export interface PacketShapeInput {
  readonly tier: ModelTier;
  /** Caller MUST supply a JSON-serializable packet OR pre-computed
   *  byte count (the broker may already have a canonical-bytes
   *  measurement and want to skip re-serializing). */
  readonly packet?: unknown;
  readonly packet_bytes?: number;
  /** When the packet carries an `alternatives` array per § B.6,
   *  caller passes the count separately so we don't re-walk. */
  readonly alternatives_count?: number;
  /** When the orchestrator has already dispatched N synthesis rounds
   *  in this request, caller passes the cumulative count so the
   *  next round's budget check accounts for it. */
  readonly rounds_so_far?: number;
}

export interface PacketShapeOk {
  readonly ok: true;
  readonly tier: ModelTier;
  readonly bytes: number;
  readonly alternatives: number;
  readonly rounds: number;
  readonly budget: TierPacketBudget;
}

export interface PacketShapeFail {
  readonly ok: false;
  readonly tier: ModelTier;
  readonly violations: ReadonlyArray<PacketShapeViolation>;
  readonly budget: TierPacketBudget;
}

export type PacketShapeResult = PacketShapeOk | PacketShapeFail;

const measurePacketBytes = (packet: unknown): number => {
  if (packet === undefined || packet === null) return 0;
  if (typeof packet === 'string') {
    // Approximate UTF-8 byte length; most packets are JSON so this
    // dominates. The +/- ~1% drift is well below the per-tier
    // budget margin.
    return new TextEncoder().encode(packet).length;
  }
  try {
    const json = JSON.stringify(packet);
    return json === undefined ? 0 : new TextEncoder().encode(json).length;
  } catch {
    return Number.MAX_SAFE_INTEGER; // unencodable → fail-closed
  }
};

/** Pure validator. Caller supplies one of `packet` (will be
 *  measured) or `packet_bytes` (already measured). Returns
 *  `{ ok: true, ... }` when the packet fits all three budgets;
 *  otherwise `{ ok: false, violations: [...] }`.
 *
 *  Per § B.3.1 — the validator does NOT silently truncate; the
 *  caller decides whether to drop low-priority context, demote tier,
 *  or surface the violation as a Plan IR `omitted_context` row. */
export const validatePacketShape = (input: PacketShapeInput): PacketShapeResult => {
  const budget = TIER_PACKET_BUDGETS[input.tier];
  const bytes =
    input.packet_bytes !== undefined
      ? input.packet_bytes
      : measurePacketBytes(input.packet);
  const alternatives = input.alternatives_count ?? 0;
  const rounds = input.rounds_so_far !== undefined ? input.rounds_so_far + 1 : 1;

  const violations: PacketShapeViolation[] = [];

  if (bytes > budget.max_packet_bytes) {
    violations.push({
      kind: 'packet_oversized',
      tier: input.tier,
      limit: budget.max_packet_bytes,
      actual: bytes,
      detail: `tier '${input.tier}' packet ${bytes}B exceeds ${budget.max_packet_bytes}B`,
    });
  }
  if (alternatives > budget.max_alternatives) {
    violations.push({
      kind: 'too_many_alternatives',
      tier: input.tier,
      limit: budget.max_alternatives,
      actual: alternatives,
      detail: `tier '${input.tier}' alternatives count ${alternatives} exceeds max ${budget.max_alternatives}`,
    });
  }
  if (rounds > budget.max_rounds) {
    violations.push({
      kind: 'too_many_rounds',
      tier: input.tier,
      limit: budget.max_rounds,
      actual: rounds,
      detail: `tier '${input.tier}' synthesis round ${rounds} exceeds max ${budget.max_rounds}`,
    });
  }

  if (violations.length > 0) {
    return { ok: false, tier: input.tier, violations, budget };
  }
  return { ok: true, tier: input.tier, bytes, alternatives, rounds, budget };
};

/** Throw `PacketShapeError` when the packet exceeds any budget.
 *  Convenience for orchestrator callers that prefer try/catch. */
export const assertPacketShape = (input: PacketShapeInput): PacketShapeOk => {
  const result = validatePacketShape(input);
  if (!result.ok) throw new PacketShapeError(result.violations);
  return result;
};
