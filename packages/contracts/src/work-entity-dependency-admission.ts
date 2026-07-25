/** D-192 Slice 7 — the transitive container-read admission, factored out so the
 *  GATE and the consent DISCLOSURE share ONE definition and can never drift.
 *
 *  A work-entity Source's create-assist / sync must READ its container
 *  dependencies (`source_dependencies[].list_op`, e.g. Linear `team.search`) as a
 *  mechanical sub-step of a GRANTED write op — you cannot create an issue without
 *  first reading which teams exist. That container-read op sits in its OWN entity
 *  group (`linear.team.read`), SEPARATE from the write group the user grants, so
 *  granting "Create issues" silently ALSO admits reading teams.
 *
 *  `deriveAllowedOperations` (`backend/server/src/connection-operation-profile-
 *  boot.ts`) is the GATE: it extends a granted op to the reads mechanically
 *  required to perform it. The install-consent + per-group grant UIs are the
 *  DISCLOSURE: they surface those same reads so the grant is legible. Both call
 *  THIS function over their own input shape (the gate over the catalog manifest,
 *  the UI over the by-value composition) via the injected `riskOfOp` seam, so the
 *  disclosure can never claim a read the gate would not admit, or miss one it
 *  would. Pure — no IO, no store, no `backend/` dependency. */

import type { RiskTier } from './ingredient.js';
import type { WorkEntitySourceDeclaration } from './work-entity-sources.js';

/** One transitively-admitted container read. */
export interface DependencyReadAdmission {
  /** The container entity's logical name (`dep.ref`) — the user-facing "what is
   *  read" label (`'team'` / `'workspace'` / `'project'`). */
  ref: string;
  /** The catalog op id that lists it (`dep.list_op`) — the exact op admitted
   *  (`'team.search'`), for a precise op-level caption. */
  list_op: string;
}

export interface DeriveDependencyReadAdmissionsInput {
  /** The Source declarations in scope (catalog manifest or composition). */
  sources: readonly WorkEntitySourceDeclaration[] | undefined;
  /** Resolve a catalog op id to its risk tier, or `undefined` when the op is not
   *  a declared op of the surface. The caller adapts its own op universe here (the
   *  gate: an own-property lookup on the manifest `operations`; a UI: the
   *  composition op→risk map). ONLY an op this returns `'read'` for is ever
   *  admitted. */
  riskOfOp: (op_id: string) => RiskTier | undefined;
  /** The DIRECTLY-granted op ids (from group / tier grants). NEVER mutated — a
   *  container read is unlocked only by a real grant on an op it BINDS, never by a
   *  sibling dependency's admitted read (the gate's snapshot invariant, inherent
   *  to this pure shape). */
  grantedOps: ReadonlySet<string>;
}

/** The container reads that granting `grantedOps` transitively admits. A
 *  dependency's `list_op` is admitted iff it resolves to a READ-tier op AND one
 *  of the dependency's `binds[].op` (resolved through `source.ops[slot]`) is in
 *  `grantedOps`. Deduped by `list_op`, in source/dependency declaration order. */
export const deriveDependencyReadAdmissions = (
  input: DeriveDependencyReadAdmissionsInput,
): DependencyReadAdmission[] => {
  const { sources, riskOfOp, grantedOps } = input;
  const out: DependencyReadAdmission[] = [];
  const seen = new Set<string>();
  for (const source of sources ?? []) {
    const ops = source.ops;
    for (const dep of source.source_dependencies ?? []) {
      const listOp = dep.list_op;
      if (typeof listOp !== 'string' || seen.has(listOp)) continue;
      // DEFENSE IN DEPTH: only a READ is ever admitted — the declaration
      // validator proves `list_op` is a non-empty string but NOT its risk tier,
      // so a malformed / adversarial pack could name a write (`team.create`) or a
      // broad read (`users.search`) as a `list_op`. A container choice-list is
      // always a read; anything else is refused.
      if (riskOfOp(listOp) !== 'read') continue;
      const boundOpGranted = (dep.binds ?? []).some((bind) => {
        // Own-property read — an INHERITED key on `source.ops` (a crafted /
        // non-JSON manifest) must not satisfy the bound-op gate. Mirrors the
        // gate's own-property discipline on `operations`; unreachable via a
        // JSON-parsed pack, cheap defense-in-depth for any other producer.
        const opKey =
          ops && Object.prototype.hasOwnProperty.call(ops, bind.op) ? ops[bind.op] : undefined;
        return typeof opKey === 'string' && grantedOps.has(opKey);
      });
      if (boundOpGranted) {
        seen.add(listOp);
        out.push({ ref: dep.ref, list_op: listOp });
      }
    }
  }
  return out;
};

/** Invert the admission per BOUND op: `op_key → the container reads granting that
 *  op ALONE admits`. The consent-disclosure UIs are op-keyed (a grant grid renders
 *  one row per op, a door checklist one row per tool), so this is the shape a UI
 *  attaches beside a write op ("Create issues — also reads: teams"). Only ops a
 *  dependency BINDS appear; ops that admit nothing are absent (the UI shows no
 *  caption). Built by reusing `deriveDependencyReadAdmissions` with a singleton
 *  granted set, so the per-op view and the gate stay one definition. */
export const derivePerOpDependencyReads = (input: {
  sources: readonly WorkEntitySourceDeclaration[] | undefined;
  riskOfOp: (op_id: string) => RiskTier | undefined;
}): Map<string, DependencyReadAdmission[]> => {
  const boundOps = new Set<string>();
  for (const source of input.sources ?? []) {
    for (const dep of source.source_dependencies ?? []) {
      for (const bind of dep.binds ?? []) {
        // Own-property read — see `deriveDependencyReadAdmissions`.
        const op =
          source.ops && Object.prototype.hasOwnProperty.call(source.ops, bind.op)
            ? source.ops[bind.op]
            : undefined;
        if (typeof op === 'string') boundOps.add(op);
      }
    }
  }
  const map = new Map<string, DependencyReadAdmission[]>();
  for (const op of boundOps) {
    const reads = deriveDependencyReadAdmissions({
      sources: input.sources,
      riskOfOp: input.riskOfOp,
      grantedOps: new Set([op]),
    });
    if (reads.length > 0) map.set(op, reads);
  }
  return map;
};
