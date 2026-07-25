/** D-192 Slice 7 — `deriveDependencyReadAdmissions`, the shared source-dependency
 *  read admission the GATE (`deriveAllowedOperations`) and the consent-disclosure
 *  UIs both call. These pin the pure contract directly (the gate's own
 *  `d-192-dependency-grant-derivation.test.ts` exercises the same logic THROUGH
 *  the manifest); the UI relies on the SAME output shape (`{ref, list_op}`) to
 *  caption "also reads: <ref>" beside a bound write group. */

import { describe, expect, it } from 'vitest';

import type { IngredientManifest, RiskTier } from '../index.js';
import type { WorkEntitySourceDeclaration } from '../work-entity-sources.js';
import { catalogIngredientViews } from '../contract-override.js';
import { deriveDependencyReadAdmissions } from '../work-entity-dependency-admission.js';

// A synthetic vendor op universe: issue/project/task writes + team/workspace/
// project/issue container reads.
const RISK: Record<string, RiskTier> = {
  'issue.search': 'read',
  'team.search': 'read',
  'workspace.search': 'read',
  'project.search': 'read',
  'issue.create': 'write',
  'task.create': 'write',
  'task.list': 'read',
  'project.create': 'write',
};
const riskOfOp = (op: string): RiskTier | undefined => RISK[op];

/** Build a minimal Source declaration — only the two fields the admission reads
 *  (`ops`, `source_dependencies`); the rest of the shape is irrelevant here. */
const src = (
  ops: Record<string, string | null>,
  source_dependencies: unknown[],
): WorkEntitySourceDeclaration =>
  ({ ops, source_dependencies }) as unknown as WorkEntitySourceDeclaration;

/** Linear's team dependency: pick-only, bound to the CREATE write. */
const teamDep = {
  ref: 'team', list_op: 'team.search', id_field: 'id', label_field: 'name',
  binds: [{ op: 'create', arg: 'teamId' }], resolve: 'prompt',
};

describe('deriveDependencyReadAdmissions', () => {
  it('admits the container read when its BOUND write op is granted', () => {
    const out = deriveDependencyReadAdmissions({
      sources: [src({ create: 'issue.create' }, [teamDep])],
      riskOfOp,
      grantedOps: new Set(['issue.create']),
    });
    expect(out).toEqual([{ ref: 'team', list_op: 'team.search' }]);
  });

  it('admits nothing when the bound op is not granted (read-only grant, dep binds create)', () => {
    const out = deriveDependencyReadAdmissions({
      sources: [src({ create: 'issue.create' }, [teamDep])],
      riskOfOp,
      grantedOps: new Set(['issue.search']), // a read grant — never reaches the create bind
    });
    expect(out).toEqual([]);
  });

  it('REFUSES a dependency whose list_op is a WRITE op (defense-in-depth)', () => {
    const out = deriveDependencyReadAdmissions({
      sources: [src({ create: 'issue.create' }, [
        { ref: 'x', list_op: 'project.create', binds: [{ op: 'create', arg: 'a' }], resolve: 'prompt' },
      ])],
      riskOfOp,
      grantedOps: new Set(['issue.create']),
    });
    expect(out).toEqual([]);
  });

  it('REFUSES a list_op the surface does not declare (riskOfOp → undefined)', () => {
    const out = deriveDependencyReadAdmissions({
      sources: [src({ create: 'issue.create' }, [
        { ref: 'x', list_op: 'unknown.search', binds: [{ op: 'create', arg: 'a' }], resolve: 'prompt' },
      ])],
      riskOfOp,
      grantedOps: new Set(['issue.create']),
    });
    expect(out).toEqual([]);
  });

  it('a LIST-bound dependency is admitted when the list op is granted (persist / sync-scope)', () => {
    const out = deriveDependencyReadAdmissions({
      sources: [src({ list: 'task.list', create: 'task.create' }, [
        { ref: 'workspace', list_op: 'workspace.search',
          binds: [{ op: 'list', arg: 'q' }, { op: 'create', arg: 'ws' }], resolve: 'persist' },
      ])],
      riskOfOp,
      grantedOps: new Set(['task.list']), // only the list bind is granted — enough
    });
    expect(out).toEqual([{ ref: 'workspace', list_op: 'workspace.search' }]);
  });

  it('does NOT admit a dependency transitively via another dependency’s admitted read (snapshot invariant)', () => {
    // srcA: create granted → admits its list_op issue.search (a read).
    // srcB: its bound op resolves to issue.search — which was only srcA-ADMITTED,
    // never granted — so srcB must NOT be admitted.
    const out = deriveDependencyReadAdmissions({
      sources: [
        src({ create: 'issue.create' }, [
          { ref: 'a', list_op: 'issue.search', binds: [{ op: 'create', arg: 'x' }], resolve: 'prompt' },
        ]),
        src({ list: 'issue.search' }, [
          { ref: 'b', list_op: 'team.search', binds: [{ op: 'list', arg: 'y' }], resolve: 'persist' },
        ]),
      ],
      riskOfOp,
      grantedOps: new Set(['issue.create']),
    });
    expect(out).toEqual([{ ref: 'a', list_op: 'issue.search' }]); // team.search NOT admitted
  });

  it('dedupes a list_op admitted from two sources', () => {
    const out = deriveDependencyReadAdmissions({
      sources: [
        src({ create: 'issue.create' }, [teamDep]),
        src({ create: 'issue.create' }, [teamDep]),
      ],
      riskOfOp,
      grantedOps: new Set(['issue.create']),
    });
    expect(out).toEqual([{ ref: 'team', list_op: 'team.search' }]);
  });

  it('skips a bind whose op slot maps to null (undeclared slot) without throwing', () => {
    const out = deriveDependencyReadAdmissions({
      sources: [src({ create: null }, [teamDep])],
      riskOfOp,
      grantedOps: new Set(['issue.create']),
    });
    expect(out).toEqual([]);
  });

  it('ignores an INHERITED (non-own) op slot on source.ops (defense-in-depth)', () => {
    // A crafted `ops` whose `create` is inherited, not an own property, must NOT
    // satisfy the bound-op gate (codex MED fold — own-property read).
    const inheritedOps = Object.create({ create: 'issue.create' }) as Record<string, string>;
    const out = deriveDependencyReadAdmissions({
      sources: [src(inheritedOps, [teamDep])],
      riskOfOp,
      grantedOps: new Set(['issue.create']),
    });
    expect(out).toEqual([]);
  });

  it('is empty for undefined / empty sources', () => {
    expect(deriveDependencyReadAdmissions({ sources: undefined, riskOfOp, grantedOps: new Set() })).toEqual([]);
    expect(deriveDependencyReadAdmissions({ sources: [], riskOfOp, grantedOps: new Set(['issue.create']) })).toEqual([]);
  });
});

// ── The projection the #contracts grant grid consumes (CatalogOperationView) ──

describe('catalogIngredientViews — also_reads projection (D-192 Slice 7)', () => {
  const linearLikeManifest = (): IngredientManifest =>
    ({
      slug: 'linear',
      name: 'Linear',
      operations: {
        'issue.search': { operation_id: 'recued-core/linear.issue.search', risk_tier: 'read' },
        'issue.create': { operation_id: 'recued-core/linear.issue.create', risk_tier: 'write' },
        'team.search': { operation_id: 'recued-core/linear.team.search', risk_tier: 'read' },
      },
      work_entity_sources: [
        {
          kind: 'task',
          ops: { list: 'issue.search', create: 'issue.create' },
          source_dependencies: [teamDep],
        },
      ],
    }) as unknown as IngredientManifest;

  it('attaches also_reads to the bound WRITE op (issue.create → team.search)', () => {
    const [view] = catalogIngredientViews([linearLikeManifest()]);
    const create = view!.operations.find((o) => o.operation_key === 'issue.create');
    expect(create?.also_reads).toEqual([{ ref: 'team', list_op: 'team.search' }]);
  });

  it('does NOT attach also_reads to ops that bind no dependency (issue.search / team.search)', () => {
    const [view] = catalogIngredientViews([linearLikeManifest()]);
    for (const key of ['issue.search', 'team.search']) {
      expect(view!.operations.find((o) => o.operation_key === key)?.also_reads).toBeUndefined();
    }
  });

  it('omits also_reads entirely for a non-work-entity manifest', () => {
    const plain = {
      slug: 'x', name: 'X',
      operations: { 'a.read': { operation_id: 'x/a.read', risk_tier: 'read' } },
    } as unknown as IngredientManifest;
    const [view] = catalogIngredientViews([plain]);
    expect(view!.operations.every((o) => o.also_reads === undefined)).toBe(true);
  });
});
