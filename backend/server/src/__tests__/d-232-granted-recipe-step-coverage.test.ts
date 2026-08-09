/** D-232 § 20.19 — a granted recipe's own steps ride the grant.
 *
 *  `allowed_tools` answers "what may this door call DIRECTLY". Before this
 *  slice the policy gate was also applying it to a different question — "what
 *  may a recipe the door was ALREADY GRANTED do internally" — so naming a
 *  recipe and then refusing its body were the same act.
 *
 *  The rule has to hold at THREE enforcement layers or it holds nowhere: the
 *  pre-run static walk, the per-call preflight admission probe, and any nested
 *  run the host dispatches on a granted run's behalf. Fixing one leaves the
 *  deny one layer down. Each layer gets its own describe below.
 *
 *  ⛔ ACCESS ONLY. None of this touches the RISK axis — `admitByOpRisk` still
 *  runs per step at every layer, so a granted recipe's `write` still meets the
 *  `ask` floor and its `destructive` still gates. The last describe pins that,
 *  because "granting a recipe grants what it does" and "granting a recipe is a
 *  standing key" differ by exactly that assertion.
 */

import { describe, expect, it } from 'vitest';
import { evaluatePreflightAdmission } from '@recued/gateway';
import type { ContractSnapshot, ExecutionSource } from '@recued/contracts';
import { buildVersionedContractSnapshot } from '../contract-snapshot-version.js';
import { recipeStepsCoveredByGrant } from '../policy-gate.js';

const snapshotWith = (allowed_tools: readonly string[]): ContractSnapshot =>
  buildVersionedContractSnapshot({
    contract_id: 'contract-cov',
    allowed_tools: [...allowed_tools],
    approval_required: [],
    scope_restrictions: [],
    resolved_at: 1_700_000_000_000,
  });

describe('D-232 § 20.19 layer 0 — the shared predicate', () => {
  it('covers the recipe the door was granted by wire name', () => {
    expect(
      recipeStepsCoveredByGrant(
        'peer-request-appointment',
        snapshotWith(['recued-core/peer-request-appointment']),
      ),
    ).toBe(true);
  });

  // 🔑 THE DISCRIMINATING NEGATIVE. This is what the by-name MCP route cannot
  // express (there, reaching a Tier-2 tool and being granted it are one fact),
  // and it is the whole difference between a per-recipe rule and a blanket
  // relaxation: a snapshot carrying SOME recipe grant must not cover a
  // DIFFERENT recipe's steps.
  it('does not cover a recipe the door was not granted', () => {
    expect(
      recipeStepsCoveredByGrant(
        'peer-appointment-reply',
        snapshotWith(['recued-core/peer-request-appointment']),
      ),
    ).toBe(false);
  });

  it('does not cover anything on a contract-free run', () => {
    expect(recipeStepsCoveredByGrant('peer-request-appointment', undefined)).toBe(false);
  });

  // ⚠ THE MATCH IS SUFFIX-AFTER-SLASH, NOT SUBSTRING. `allowed_tools` also
  // holds ingredient slugs, and the two vocabularies are disjoint only because
  // a slug never contains `/`. A bare entry equal to the recipe id must NOT
  // read as a grant — otherwise an ingredient that happened to share a recipe's
  // name would silently confer coverage.
  it('ignores a slug-shaped entry with no publisher segment', () => {
    expect(
      recipeStepsCoveredByGrant(
        'peer-request-appointment',
        snapshotWith(['peer-request-appointment']),
      ),
    ).toBe(false);
  });

  it('ignores a leading-slash entry (empty publisher)', () => {
    expect(
      recipeStepsCoveredByGrant('some-recipe', snapshotWith(['/some-recipe'])),
    ).toBe(false);
  });

  // The suffix is the WHOLE post-slash segment. A recipe whose id is a tail of
  // a granted recipe's id must not ride it.
  it('does not cover a recipe whose id is a suffix of a granted one', () => {
    expect(
      recipeStepsCoveredByGrant('appointment', snapshotWith(['recued-core/peer-appointment'])),
    ).toBe(false);
  });
});

describe('D-232 § 20.19 layer 2 — the per-call preflight probe', () => {
  const source: ExecutionSource = {
    channel: 'mcp',
    actor: 'contracted_user',
    agent_id: 'stdio_local',
    tool_call_id: 'coverage-test',
    mcp_token_id: 'tok-cov',
    contract_id: 'contract-cov',
  };
  const tool = { slug: 'peer-exchange-out', kind: 'connection', risk_tier: 'read' } as const;

  it('denies a step slug absent from allowed_tools when the run carries no coverage', () => {
    const decision = evaluatePreflightAdmission({
      source,
      tool,
      contract_snapshot: snapshotWith(['recued-core/peer-request-appointment']),
    });
    expect(decision.verdict).toBe('deny');
    // The REASON, not merely the verdict — a deny for any other cause would
    // pass a `verdict === 'deny'` assertion while proving nothing about access.
    expect(decision.verdict === 'deny' ? decision.code : undefined)
      .toBe('tool_not_in_contract');
  });

  it('admits the same step when the run IS the granted recipe', () => {
    const decision = evaluatePreflightAdmission({
      source,
      tool,
      contract_snapshot: snapshotWith(['recued-core/peer-request-appointment']),
      granted_recipe_steps: true,
    });
    // ⚠ ASSERT THE POSITIVE NAME. `.not.toBe('deny')` also passes on an `ask`,
    // an `undefined`, or a shape change — the read tier must reach `admit`.
    expect(decision.verdict).toBe('admit');
  });
});

describe('D-232 § 20.19 — coverage is ACCESS only, never risk', () => {
  const source: ExecutionSource = {
    channel: 'mcp',
    actor: 'contracted_user',
    agent_id: 'stdio_local',
    tool_call_id: 'coverage-test',
    mcp_token_id: 'tok-cov',
    contract_id: 'contract-cov',
  };

  // ⛔⛔ THE LOAD-BEARING TEST OF THE WHOLE SLICE. If coverage ever short-
  // circuited `admitByOpRisk` too, a granted read-only-looking recipe would
  // carry a destructive step past the owner without a card. The step slug is
  // absent from `allowed_tools` AND the run is covered — so the ONLY thing that
  // can still stop it is the risk axis, and it must.
  it('still gates a destructive step inside a granted recipe', () => {
    const decision = evaluatePreflightAdmission({
      source,
      tool: { slug: 'calendar-delete', kind: 'storage', risk_tier: 'destructive' },
      contract_snapshot: snapshotWith(['recued-core/peer-request-appointment']),
      granted_recipe_steps: true,
    });
    expect(decision.verdict).toBe('ask');
  });

  it('still holds a write step inside a granted recipe for approval', () => {
    const decision = evaluatePreflightAdmission({
      source,
      tool: { slug: 'calendar-create', kind: 'storage', risk_tier: 'write' },
      contract_snapshot: snapshotWith(['recued-core/peer-request-appointment']),
      granted_recipe_steps: true,
    });
    expect(decision.verdict).toBe('ask');
  });
});
