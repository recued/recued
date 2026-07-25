/** D-207 slice 1c — the GENERAL gated reception recipe runner.
 *
 *  Replaces the shape D-200 shipped: the ONLY raw `executeRecipe` in the server, which
 *  bypassed the Gateway, the contract, the actor and the run row — and was "safe" solely
 *  because its recipe profile was crippled to the point of being unable to dispatch a
 *  single ingredient. That safety and that narrowness were the same property.
 *
 *  Here safety comes from the GATE, so the profile can be WIDE. These pin the four things
 *  that make that true. */

import { describe, expect, it, vi } from 'vitest';

import type { ContractDefinition } from '@recued/contracts';

import { createReceptionRecipeRunner } from '../reception-recipe-runner.js';
import type { ContractDefinitionStore } from '../storage/contract-definition-store.js';
import type { ReceptionIntakeRecipePairStore } from '../storage/reception-intake-recipe-pair-store.js';

const NOW = () => 1_000;

const harness = (opts?: {
  contract_id?: string | null;
  revoked?: boolean;
  execute?: unknown;
  /** The installed dish's `config_overlay` — what `reception-door-bind` derived the door's
   *  capability from. `undefined` models a recipe with no install config at all. */
  config?: Record<string, unknown>;
}) => {
  const contractId = opts?.contract_id === undefined ? 'door_1' : opts.contract_id;
  const def = {
    contract_id: 'door_1',
    status: 'active',
    minted_at: NOW(),
    door_types: ['reception'],
    scope: { operation_ids: ['core.mail.send'], ingredient_ids: ['mail-send'] },
    ...(opts?.revoked === true ? { revoked_at: NOW() } : {}),
  } as unknown as ContractDefinition;

  const definitionStore = { get: (id: string) => (id === 'door_1' ? def : null) } as unknown as ContractDefinitionStore;
  const pairStore = {
    findByEndpoint: () => ({
      endpoint_id: 'ep1',
      binding: { recipe_id: 'lead-capture' },
      contract_id: contractId,
    }),
  } as unknown as ReceptionIntakeRecipePairStore;

  const handleExecute = vi.fn(async () =>
    opts?.execute ?? { success: true, output: { render: [{ type: 'text', data: 'ok' }], sidebar: [] }, errors: [] },
  );
  // Inject the REAL runner with a spied handleExecute so we assert what it HANDS THE GATE,
  // not a re-implementation of the gate.
  const executeDeps = { __spy: handleExecute } as never;
  // The SAME resolution `reception-door-bind` mints the door from. A harness that let these
  // two diverge could not catch the bug this dep exists to close.
  const resolveConfig = vi.fn((_recipeId: string) => opts?.config);
  return { definitionStore, pairStore, executeDeps, handleExecute, resolveConfig, now: NOW };
};

/** The runner imports `handleExecute` directly, so spy at the module boundary. */
vi.mock('../execute-handler.js', async (orig) => {
  const actual = await orig<typeof import('../execute-handler.js')>();
  return {
    ...actual,
    handleExecute: (deps: { __spy?: (...a: unknown[]) => unknown }, req: unknown, opts: unknown) =>
      (deps.__spy as (...a: unknown[]) => unknown)(deps, req, opts),
  };
});

const run = (h: ReturnType<typeof harness>) =>
  createReceptionRecipeRunner(h).run({
    endpoint_id: 'ep1',
    submission_id: 'sub_1',
    submission: { email: 'v@example.com', note: 'hi' },
  });

describe('D-207 slice 1c — the runner goes THROUGH the gate, not around it', () => {
  it('dispatches through handleExecute with an ANONYMOUS source carrying the door contract', async () => {
    const h = harness();
    await run(h);
    const [, req] = h.handleExecute.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    const src = (req as { execution_source: Record<string, unknown> }).execution_source;
    // The actor stays `anonymous` — the truth. `contracted_user` would render as an AGENT
    // assertion and launder the provenance of every row the recipe writes.
    expect(src).toMatchObject({
      channel: 'reception',
      actor: 'anonymous',
      reception_id: 'ep1',
      contract_id: 'door_1',
    });
    expect((req as { trigger_source: string }).trigger_source).toBe('reception');
  });

  it('carries a ContractSnapshot — NOT optional: a contract-bearing source without one THROWS', async () => {
    const h = harness();
    await run(h);
    const [, req] = h.handleExecute.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    const snap = (req as { contract_snapshot: { allowed_tools: string[] } }).contract_snapshot;
    // The tool axis, fed from the SAME derivation the mint wrote its grant rows from.
    expect(snap.allowed_tools).toEqual(['mail-send']);
  });

  it('the run id is anchored on the submission — a re-drive collapses, it does not re-fire', async () => {
    const h = harness();
    await run(h);
    const [, , opts] = h.handleExecute.mock.calls[0] as unknown as [unknown, unknown, { run_id: string }];
    expect(opts.run_id).toBe('reception:sub_1');
  });

  it('the visitor\'s fields reach the recipe as context.reception_submission', async () => {
    const h = harness();
    await run(h);
    const [, req] = h.handleExecute.mock.calls[0] as unknown as [unknown, { context: Record<string, unknown> }];
    expect(req.context).toEqual({ reception_submission: { email: 'v@example.com', note: 'hi' } });
  });
});

/** ⛔ The bug this closes was LIVE and SILENT in landed slice-1c code.
 *
 *  `handleExecute` merges the install dish's `config_overlay` ONLY for a run with no
 *  `run_id` — a gate written for `pick`/`saga`, which pass a `run_id` together with a
 *  CAPTURED config, so for them "has a run_id" really does mean "brought its own config".
 *
 *  The reception runner passes a `run_id` for an unrelated reason (idempotency) and brings
 *  NO config, so it fell through every branch and dispatched with an empty one. Meanwhile
 *  `reception-door-bind` derives the door's op closure — including which CONNECTION each
 *  step uses — from exactly that config, mints the grant rows from it, and shows the owner
 *  the list as the consent moment. Bind and run were reading different worlds. */
describe('D-207 slice 3c — the run resolves the SAME config the door was minted from', () => {
  it('passes the install-dish config to the engine — it is NOT merged for us', async () => {
    // Deliberately NOT a `seller_offer_id`: this harness has no seller substrate, and a
    // config naming an offer on a server that cannot sell is a REFUSAL (slice 3c), not a
    // dispatch. The selling path has its own suite, driven through a real seller store.
    const h = harness({ config: { stripe_conn: 'stripe-live', notify: 'ops@example.com' } });
    await run(h);

    const [, req, opts] = h.handleExecute.mock.calls[0] as unknown as [
      unknown,
      { config?: Record<string, unknown> },
      { run_id?: string },
    ];

    // NON-VACUITY: the whole bug is that a `run_id` suppresses the engine's own merge. If
    // this run carried no `run_id`, the engine would merge the overlay itself and the
    // assertion below would pass with the fix fully disarmed.
    expect(opts.run_id).toBe('reception:sub_1');

    expect(req.config).toEqual({ stripe_conn: 'stripe-live', notify: 'ops@example.com' });
    expect(h.resolveConfig).toHaveBeenCalledWith('lead-capture');
  });

  it('an unconfigured recipe dispatches with no config key at all — never an empty object', async () => {
    // `{}` and "absent" are different to a merge. Sending `config: {}` would let a caller's
    // empty object win over a source the engine might otherwise supply.
    const h = harness({ config: undefined });
    await run(h);
    const [, req] = h.handleExecute.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect('config' in req).toBe(false);
  });
});

describe('D-207 slice 1c — outcomes', () => {
  it('completed -> returns the recipe OUTPUT (the render blocks Slice 2 will consume)', async () => {
    const h = harness();
    const r = await run(h);
    expect(r.kind).toBe('completed');
    if (r.kind === 'completed') expect(r.output.render).toEqual([{ type: 'text', data: 'ok' }]);
  });

  it('HELD is not a FAILURE — awaiting_approval is queued, not failed', async () => {
    // The run is durably PAUSED at the D-157 gate and lands in the D-173 Inbox. Conflating
    // this with a failure would either lie to the visitor or show them an error for the
    // system working exactly as designed.
    const h = harness({ execute: { success: false, awaiting_approval: true, errors: [] } });
    const r = await run(h);
    expect(r.kind).toBe('held');
  });

  it('a real failure is a FAILURE — the visitor must be told', async () => {
    const h = harness({ execute: { success: false, errors: ['boom'] } });
    const r = await run(h);
    expect(r.kind).toBe('failed');
  });

  it('NO DOOR -> does not run at all', async () => {
    // A pair with no minted contract would dispatch contract-free... except it cannot: the
    // source would be floored to PUBLIC_CONTRACT_ID, which grants nothing, so every op
    // hard-denies. Detect it up front rather than manufacture a failed run.
    const h = harness({ contract_id: null });
    const r = await run(h);
    expect(r.kind).toBe('no_door');
    expect(h.handleExecute).not.toHaveBeenCalled();
  });

  it('a REVOKED door runs with an EMPTY allowlist — the live kill-switch', async () => {
    const h = harness({ revoked: true });
    await run(h);
    const [, req] = h.handleExecute.mock.calls[0] as unknown as [unknown, { contract_snapshot: { allowed_tools: string[] } }];
    // allowed_tools collapses to [] => every dispatch denies (`tool_not_in_contract`), over
    // a form that is ALREADY public and already taking traffic.
    expect(req.contract_snapshot.allowed_tools).toEqual([]);
  });
});
