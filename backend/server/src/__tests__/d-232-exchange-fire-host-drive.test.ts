/** D-232 § 19 — the exchange FIRES, through the real handler.
 *
 * The engine's `d-232-fire-exchange-output.test.ts` proves the payload is
 * derived from the RUN and that the fire point is reached on both of
 * `executeRecipe`'s exit paths. It proves nothing about what happens next,
 * because the host hook it exercises is a `fired.push(p)` array.
 *
 * This file is the next step: a recipe declaring `output.exchange`, run through
 * `handleExecute`, whose answer comes out the other side as a REAL dispatch —
 * resolved to an installed operation, crossing the ordinary catalog gate, under
 * the contract that authorized the run that declared it.
 *
 * ⛔ THE FIRE IS ITS OWN RUN. The declaring run is over by the time the fire
 * happens, so a gated send has nowhere to pause — dispatching inline would mean
 * an `ask` fails the fire and the peer gets SILENCE, which § 19.4 calls the worst
 * outcome for a correspondent. Re-entering `handleExecute` through the
 * `run-ingredient` kernel recipe buys the pause machinery instead: the send is
 * gated, an `ask` holds durably against that dispatch, and approval delivers it.
 *
 * ⚠ WHAT THE OWNER CHOSE, AND WHAT IT COSTS. The send target is resolved from a
 * TOOL NAME (`deliver_to`), which on the answering side is the one the far side
 * supplied — so at fire time it can be peer-supplied. Three narrowings are what
 * make that a posture rather than a hole, and each has a test here: the name must
 * match an INSTALLED binding, the binding must be `mcp`, and an ambiguous match
 * REFUSES. The grant is still the gate; this only decides what is being asked
 * about.
 *
 * ⚠ `deliver_to` is NOT `callback_op` — see § 20.10. They are the same string
 * only when you are the one ANSWERING.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  ContractSnapshot,
  ExecutionSource,
  IngredientManifest,
  RecipeDefinition,
} from '@recued/contracts';

import Database from 'better-sqlite3';

import { createSQLiteCollection } from '../sqlite-collection.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { projectRunResultForAgent } from '../run-result-agent-projection.js';
import type { Checkpoint } from '@recued/contracts';
import { createCheckpointStore, type AuditEntry } from '@recued/storage';
import { ensureCheckpointSchema } from '../memory-schema.js';

const CATALOG = 'd232-fire-catalog';
/** A second catalog binding the SAME tool — installed only by the ambiguity
 *  test, because two packs claiming one tool name must refuse rather than let
 *  install order decide which one answers. */
const RIVAL = 'd232-rival-catalog';
const FIRER = 'd232-firer';
const SINK = 'd232-answer-sink';

const GATED_SINK = 'd232-gated-sink';

const SINK_TOOL = `recued-core/${SINK}`;
const FIRER_TOOL = `recued-core/${FIRER}`;
const GATED_TOOL = `recued-core/${GATED_SINK}`;

/** `answer` is what an exchange fires through: an `mcp` binding naming the sink.
 *  `answer_self` names the FIRER, so a fire can be made to close a loop. */
const catalogManifest = (slug: string): IngredientManifest => ({
  slug,
  name: 'D-232 fire fixture catalog',
  description: 'Exchange fire targets for the D-232 host drive.',
  author: 'recued-core',
  version: 1,
  kind: 'connection',
  category: 'action',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: {
    answer: { operation_id: `${slug}.answer`, risk_tier: 'read', groups: ['g'] },
    answer_self: { operation_id: `${slug}.answer_self`, risk_tier: 'read', groups: ['g'] },
    // Same target, `write` risk — floored to `ask` by `RISK_APPROVAL_FLOOR`, so
    // firing through it is how the hold path gets exercised.
    answer_gated: { operation_id: `${slug}.answer_gated`, risk_tier: 'write', groups: ['g'] },
  },
  surfaces: {
    api: {
      transport: 'rest',
      default_base_url: 'https://fixture.invalid',
      auth: { kind: 'none' },
      executes: {
        answer: { kind: 'mcp', tool: SINK_TOOL },
        answer_self: { kind: 'mcp', tool: FIRER_TOOL },
        answer_gated: { kind: 'mcp', tool: GATED_TOOL },
      },
    },
  },
} as unknown as IngredientManifest);

/** The recipe that answers. It RETURNS nothing — `output.exchange` is the whole
 *  output block, which is what makes result-XOR-fire structural. */
const firingRecipe = (
  exchange: Record<string, unknown>,
  opts: { fail?: boolean } = {},
): RecipeDefinition => ({
  recipe_id: FIRER,
  version: 1,
  ttl: 0,
  metadata: {
    name: FIRER,
    description: 'D-232 exchange-fire fixture.',
    author: 'recued-core',
    supported_platforms: ['test'],
    tags: ['test', 'd-232'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    { id: 'ref', transform: 'template', template: 'exch_fire_1' },
    // ⚠ `fail_on` reports its own message ("fail_on triggered on step boom"),
    // NOT the step's template — the first version of this fixture asserted on
    // the template and reddened on a run that had fired perfectly.
    ...(opts.fail
      ? [{ id: 'boom', transform: 'template', template: 'unreachable', fail_on: 'true equal true' }]
      : []),
  ],
  output: { exchange },
} as unknown as RecipeDefinition);

/** Where the answer lands. It declares the fire's arg names as variables —
 *  a nested run meets the declared-variable boundary like any wire caller, so
 *  this doubles as a statement of what the fire actually puts on the wire. */
const sinkRecipe = (): RecipeDefinition => ({
  recipe_id: SINK,
  version: 1,
  ttl: 0,
  metadata: {
    name: SINK,
    description: 'D-232 exchange-fire sink.',
    author: 'recued-core',
    supported_platforms: ['test'],
    tags: ['test', 'd-232'],
  },
  variables: {
    exchange_ref: { label: 'ref', type: 'string' },
    outcome: { label: 'outcome', type: 'string' },
    errors: { label: 'errors', type: 'json', optional: true },
    decision: { label: 'decision', type: 'string', optional: true },
  },
  prefetch_steps: [],
  steps: [{ id: 'echo', transform: 'template', template: 'answered {{config.exchange_ref}}' }],
  output: { render: [{ type: 'json', source: 'step.echo', label: 'echo' }] },
} as unknown as RecipeDefinition);

/** The sink an `ask`-class send reaches — identical to {@link sinkRecipe} but
 *  for its id, so the two hold tests differ only in whether the send was
 *  gated. */
const gatedSinkRecipe = (): RecipeDefinition => ({
  ...sinkRecipe(),
  recipe_id: GATED_SINK,
} as unknown as RecipeDefinition);

const MCP_SOURCE: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'agent_peer',
  tool_call_id: 'tc_1',
  mcp_token_id: 'tok_peer',
  contract_id: 'ct_peer_alice',
};

const CONTRACT: ContractSnapshot = {
  contract_id: 'ct_peer_alice',
  contract_version: '1',
  allowed_tools: [CATALOG, RIVAL, FIRER, SINK, GATED_SINK],
  approval_required: [],
  scope_restrictions: [],
  resolved_at: 1_900_000_000_000,
};

interface Env {
  deps: ExecuteHandlerDeps;
  audit: AuditEntry[];
}

const buildEnv = (
  recipes: readonly RecipeDefinition[],
  opts: {
    rival?: boolean;
    durable?: boolean;
    /** § 20.17 — mcp connection records carrying the contract each one reaches. */
    peerConnections?: readonly { name: string; contract: string }[];
  } = {},
): Env => {
  const recipeStore: RecipeStore = createRecipeStore('/nonexistent-d232-fire-drive');
  for (const r of recipes) recipeStore.register(r);
  const manifests = createManifestRegistry('/nonexistent-d232-fire-drive');
  manifests.register(catalogManifest(CATALOG));
  if (opts.rival) manifests.register(catalogManifest(RIVAL));
  const audit: AuditEntry[] = [];
  return {
    audit,
    deps: {
      recipeStore,
      executorConfig: { manifests },
      baseVault: {},
      instanceId: 'd232-fire-drive',
      auditLog: {
        append: (entry: AuditEntry) => { audit.push(entry); return Promise.resolve(); },
      } as unknown as ExecuteHandlerDeps['auditLog'],
      ...(opts.peerConnections
        ? {
            connectionStore: {
              list: () => opts.peerConnections!.map((c) => ({
                kind: 'mcp', name: c.name,
                config_json: JSON.stringify({ peer_contract_id: c.contract }),
              })),
              get: () => null,
            } as unknown as ExecuteHandlerDeps['connectionStore'],
          }
        : {}),
      // A hold cannot be DURABLE without somewhere to write the checkpoint, and
      // `handleExecute` downgrades a non-durable pause to a plain failure. Both
      // postures are under test, so the store is opt-in per env.
      ...(opts.durable ? { checkpointStore: durableCheckpointStore() } : {}),
    },
  };
};

const durableCheckpointStore = (): ExecuteHandlerDeps['checkpointStore'] => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // ⚠ ORDER: the COLLECTION creates the table, `ensureCheckpointSchema` only
  // adds its indexes. Reversed, the store fails `no such table: checkpoints`.
  const store = createCheckpointStore(createSQLiteCollection<Checkpoint>(db, 'checkpoints'));
  ensureCheckpointSchema(db);
  return store;
};

const run = (env: Env) => handleExecute(env.deps, {
  recipe_id: FIRER,
  execution_source: MCP_SOURCE,
  contract_snapshot: CONTRACT,
  trigger_source: 'mcp',
});

const rowsFor = (env: Env, recipe_id: string): AuditEntry[] =>
  env.audit.filter((e) => e.recipe_id === recipe_id);

const errorText = (res: { errors: readonly unknown[] }): string => JSON.stringify(res.errors);

/** What the answer arrived as, read off the sink run's own audit row. */
const delivered = (env: Env): Record<string, unknown> | undefined =>
  rowsFor(env, SINK)[0]?.config_snapshot;

describe('D-232 § 19 — output.exchange fires a real, gated dispatch', () => {
  let env: Env;

  beforeEach(() => {
    env = buildEnv([
      firingRecipe({ ref: '{{step.ref}}', deliver_to: SINK_TOOL, callback_op: SINK_TOOL, data: { decision: 'accepted' } }),
      sinkRecipe(),
    ]);
  });

  it('✅✅ the answer is DISPATCHED — resolved from deliver_to, delivered to the bound op', async () => {
    const res = await run(env);
    expect(res.success, errorText(res)).toBe(true);
    expect(rowsFor(env, SINK), 'the fire never reached a dispatch').toHaveLength(1);
    expect(delivered(env)).toMatchObject({
      exchange_ref: 'exch_fire_1',
      outcome: 'succeeded',
      decision: 'accepted',
    });
  });

  it('✅ the fire is ITS OWN run — one anchor for the answer, distinct from the declaring run', async () => {
    // Not cosmetic: it is what gives a gated send somewhere to hold. A fire
    // dispatched inside the declaring run would have to fail on an `ask`,
    // because that run is already over.
    await run(env);
    expect(rowsFor(env, 'run-ingredient'), 'the fire had no run of its own').toHaveLength(1);
    const ids = new Set(env.audit.map((e) => e.run_id));
    expect(ids.size, 'the fire wrote into the declaring run').toBe(env.audit.length);
  });

  it('✅✅ the dispatch runs under the DECLARING run\'s contract', async () => {
    // Same property the local invoker has, and it matters more here: an answer
    // sent under a fresh identity is an answer that escaped its own gate.
    await run(env);
    for (const id of ['run-ingredient', SINK]) {
      expect(rowsFor(env, id)[0]!.contract_snapshot?.contract_id, id)
        .toBe(CONTRACT.contract_id);
      expect(rowsFor(env, id)[0]!.execution_source, id).toEqual(MCP_SOURCE);
    }
  });

  it('⛔⛔ `data` CANNOT overwrite the outcome — an author may not declare their own failure a success', async () => {
    // `buildExchangeFirePayload` reads `success` off the RUN precisely so a
    // recipe cannot call its own failure a success. Spreading the authored
    // `data` over the derived fields would undo that one layer down, on the
    // wire, where nobody would see it.
    env = buildEnv([
      firingRecipe(
        { ref: '{{step.ref}}', deliver_to: SINK_TOOL, data: { outcome: 'succeeded', decision: 'accepted' } },
        { fail: true },
      ),
      sinkRecipe(),
    ]);
    await run(env);
    expect(rowsFor(env, SINK)).toHaveLength(1);
    expect(delivered(env)?.outcome, 'the recipe declared its failure a success').toBe('failed');
  });

  it('⛔ a FAILED run still fires, carrying its errors as the body', async () => {
    // § 19.4 — a reply is always owed, and "undeliverable" beats a swallowed
    // letter. The declaring run is failed (it failed), and the answer still went.
    env = buildEnv([
      firingRecipe({ ref: '{{step.ref}}', deliver_to: SINK_TOOL, callback_op: SINK_TOOL }, { fail: true }),
      sinkRecipe(),
    ]);
    const res = await run(env);
    expect(res.success).toBe(false);
    expect(rowsFor(env, SINK), 'the peer was left waiting on a failed run').toHaveLength(1);
    expect(delivered(env)?.outcome).toBe('failed');
    // The BODY is the run's own errors, not a stand-in — assert the failing
    // step and its code, so an empty-but-well-formed body cannot pass here.
    const body = JSON.stringify(delivered(env)?.errors);
    expect(body).toContain('RECIPE_FAIL_ON_TRIGGERED');
    expect(body).toContain('boom');
    // ── D-232 § 21 — THE CLASSIFICATION RIDES WITH THE BODY ──
    // `outcome: 'failed'` alone gives the far side one move (retry) for four
    // different causes. `kind` is what makes the answer actionable, and it must
    // arrive at the RECEIVER, not merely exist on the payload — the wire args
    // are built by an enumerating copier that has already dropped a field once
    // in this feature.
    const wire = delivered(env) as Record<string, unknown>;
    expect(wire.kind, 'a fail_on guard is the run breaking, not the peer refusing')
      .toBe('error');
    expect(wire.reason, 'the reason carries the real message, not just a label')
      .toContain('boom');
  });

  /** ⛔⛔ "NO CONNECTION ⇒ ROUTE LOCAL" IS RIGHT FOR THE OWNER AND CATASTROPHIC
   *  FOR A PEER, AND NOTHING AT FIRE TIME DISTINGUISHES THEM: same shape, same
   *  empty connection, a contracted caller in both. A first attempt at this
   *  guard keyed on "contracted caller + no connection" and broke five
   *  legitimate local deliveries — which is how the ambiguity was established
   *  rather than assumed. Only the AUTHOR can say which they meant. */
  it('⛔ refuses rather than delivering a peer answer to ourselves', async () => {
    env = buildEnv([
      firingRecipe({ ref: '{{step.ref}}', deliver_to: SINK_TOOL, require_connection: true }),
      sinkRecipe(),
    ]);
    const res = await run(env);
    expect(res.success).toBe(false);
    expect(JSON.stringify(res.errors)).toMatch(/must be delivered to a peer/);
    // 🔑 THE LOAD-BEARING HALF: nothing was delivered. A guard that failed the
    // run but still posted the letter locally would be worse than none — the
    // peer's ref would carry a self-answer AND an error.
    expect(rowsFor(env, SINK), 'it must not answer itself on the way out').toHaveLength(0);
  });

  it('without the declaration, a local delivery still works', async () => {
    // The owner's own recipe→recipe exchange is the case the local route exists
    // for, and it must be untouched by this guard.
    env = buildEnv([
      firingRecipe({ ref: '{{step.ref}}', deliver_to: SINK_TOOL }),
      sinkRecipe(),
    ]);
    const res = await run(env);
    expect(res.success).toBe(true);
    expect(rowsFor(env, SINK)).toHaveLength(1);
  });

  it('§ 21 — the envelope reaches a receiver that declares NONE of it', async () => {
    /** ⛔⛔ THE PROTOCOL COULD NOT GROW A FIELD, AND THIS IS THE REGRESSION.
     *
     *  Every config key a recipe does not declare is refused with
     *  `UNDECLARED_CONFIG_ARGUMENT` (400). So adding `kind` + `reason` to the
     *  exchange broke EVERY existing receiver at once — and broke them at the FAR
     *  side, where the asker sees only that no answer ever came. Any future
     *  protocol field would do the same to every third-party receiver on servers
     *  the author does not control.
     *
     *  `EXCHANGE_ENVELOPE_KEYS` is the fix: the envelope always rides along, and
     *  declaring a member is how a receiver opts IN to READING it, never a
     *  condition of delivery. The sink here declares nothing, which is exactly
     *  the deployed-receiver case. */
    env = buildEnv([
      firingRecipe({ ref: '{{step.ref}}', deliver_to: SINK_TOOL }, { fail: true }),
      sinkRecipe(),
    ]);
    await run(env);
    expect(rowsFor(env, SINK), 'an undeclared envelope must not bounce the delivery')
      .toHaveLength(1);
    expect((delivered(env) as Record<string, unknown>).kind).toBe('error');
  });

  it('⛔ a deliver_to nobody installed is REFUSED, and nothing is sent', async () => {
    // The first narrowing: the peer's vocabulary is exactly the owner's install
    // set. Asserted on the REASON — a bare `success: false` cannot tell a
    // refusal from a dispatch that went out and failed.
    env = buildEnv([
      firingRecipe({ ref: '{{step.ref}}', deliver_to: 'recued-core/never-installed' }),
      sinkRecipe(),
    ]);
    const res = await run(env);
    expect(res.success).toBe(false);
    expect(errorText(res)).toContain('matches no installed operation binding');
    expect(env.audit.filter((e) => e.recipe_id !== FIRER), 'something dispatched').toEqual([]);
  });

  it('⛔⛔ an AMBIGUOUS deliver_to refuses rather than letting install order decide', async () => {
    // Two installed catalogs binding one tool name. Picking either would make
    // WHICH operation answers a peer depend on the order the owner installed
    // their packs — invisible, and different on two servers with the same packs.
    env = buildEnv(
      [firingRecipe({ ref: '{{step.ref}}', deliver_to: SINK_TOOL }), sinkRecipe()],
      { rival: true },
    );
    const res = await run(env);
    expect(res.success).toBe(false);
    expect(errorText(res)).toContain('refusing rather than choosing one');
    expect(errorText(res)).toContain(CATALOG);
    expect(errorText(res)).toContain(RIVAL);
    expect(rowsFor(env, SINK), 'one of the two answered anyway').toHaveLength(0);
  });

  it('⛔ the declared CONNECTION rides — it routes remote instead of local', async () => {
    // `run-ingredient`'s step declares no `connection`, so the name has to
    // travel in the input (`resolveCatalogConnection` reads `s.connection ??
    // input.connection`). If it did not, this fire would silently take the LOCAL
    // route and answer a recipe on this server while claiming to have reached a
    // peer — the worst possible way for this plumbing to fail.
    env = buildEnv([
      firingRecipe({ ref: '{{step.ref}}', deliver_to: SINK_TOOL, connection: 'peer-alice' }),
      sinkRecipe(),
    ]);
    const res = await run(env);
    expect(res.success).toBe(false);
    expect(errorText(res)).toContain('no_connection_profile');
    expect(rowsFor(env, SINK), 'it answered locally while naming a peer').toHaveLength(0);
  });

  it('✅✅ a GATED send HOLDS as its own run — the answer is queued, not lost, not sent', async () => {
    // THE REASON THE FIRE IS ITS OWN RUN. `answer_gated` is `write`, floored to
    // `ask`, so the send cannot go out unasked. The declaring run is already
    // over and cannot hold — but the fire's run can, and does: a durable
    // checkpoint against THAT dispatch, an owner card, and delivery on approval.
    //
    // ⛔ The declaring run must NOT be failed here. "This recipe did not answer"
    // is false about a run whose answer is durably queued behind a card.
    env = buildEnv(
      [
        firingRecipe({ ref: '{{step.ref}}', deliver_to: GATED_TOOL }),
        gatedSinkRecipe(),
      ],
      { durable: true },
    );
    const res = await run(env);
    expect(res.success, errorText(res)).toBe(true);
    expect(rowsFor(env, GATED_SINK), 'the peer was answered before the owner decided')
      .toHaveLength(0);
    const fire = rowsFor(env, 'run-ingredient')[0];
    expect(fire, 'the fire had no run to hold on').toBeDefined();
    expect(fire!.commit_status, 'the send did not hold').toBe('awaiting_approval');
  });

  it('⛔ a hold the host CANNOT make durable fails loudly instead of pretending', async () => {
    // Same fire, no checkpoint store. `handleExecute` downgrades a pause it
    // cannot persist to a real failure, and the fire must carry that up rather
    // than treat it as the queued case — otherwise a recipe reports having
    // answered a peer that will never hear anything.
    env = buildEnv([
      firingRecipe({ ref: '{{step.ref}}', deliver_to: GATED_TOOL }),
      gatedSinkRecipe(),
    ]);
    const res = await run(env);
    expect(res.success).toBe(false);
    expect(errorText(res)).toContain('EXCHANGE_FIRE_FAILED');
    expect(rowsFor(env, GATED_SINK)).toHaveLength(0);
  });

  it('✅✅ THE CALLER GETS A RECEIPT — the ref, on the response', async () => {
    // ⛔ THE ONE THING THE EXCHANGE EXISTS TO PROVIDE. A sender expects nothing
    // back; what the substrate adds over a real letter is that you can ask what
    // happened to it, and the ref is the handle for asking. The engine derived
    // this receipt so no recipe could forget it — and then nothing carried it,
    // so every answer went out and every caller was left with nothing to ask
    // about. This asserts the whole path: engine → run result → response.
    const res = await run(env);
    expect(res.success, errorText(res)).toBe(true);
    expect(res.exchange_ack).toEqual({
      ref: 'exch_fire_1',
      callback_op: SINK_TOOL,
      accepted: true,
    });
  });

  it('✅✅ a FIRING run files ITSELF under the ref it answered with', async () => {
    // The firer's config is empty — the ref comes from a STEP — so this is the
    // only source that can file this run: the receipt it just produced. A run
    // that answered knows its own ref better than anything handed to it, which
    // is why that source wins at the audit stamp.
    const res = await run(env);
    expect(res.success, errorText(res)).toBe(true);
    const filed = env.audit.filter((a) => a.exchange_ref === 'exch_fire_1');
    expect(filed.map((a) => a.recipe_id), 'the answering run is not in its own exchange')
      .toContain(FIRER);
  });

  it('✅ a FAILED run that answered still gets a receipt — the letter DID go', async () => {
    // § 19.4: the exchange always fires, carrying the errors as its body. The
    // run failed; the answer was still delivered, so the caller still has
    // something to ask about. Tying the ack to `success` would withhold the ref
    // for exactly the exchanges most worth querying.
    env = buildEnv([
      firingRecipe({ ref: '{{step.ref}}', deliver_to: SINK_TOOL, callback_op: SINK_TOOL }, { fail: true }),
      sinkRecipe(),
    ]);
    const res = await run(env);
    expect(res.success).toBe(false);
    expect(res.exchange_ack?.ref).toBe('exch_fire_1');
  });

  it('✅ a QUEUED answer is accepted too — a hold is an acceptance, not a refusal', async () => {
    // The gated send holds behind the owner's card and will go out on approval.
    // "Accepted" is the honest word for that: the letter is in the system.
    env = buildEnv(
      [firingRecipe({ ref: '{{step.ref}}', deliver_to: GATED_TOOL }), gatedSinkRecipe()],
      { durable: true },
    );
    const res = await run(env);
    expect(res.exchange_ack?.accepted).toBe(true);
  });

  it('⛔⛔ a fire that could NOT happen returns the HANDLE, and says it did not go', async () => {
    /** ⚠⚠ THIS INVARIANT WAS DELIBERATELY REVERSED — D-232 § 25. Recorded rather
     *  than silently re-expected, because the old expectation was defensible.
     *
     *  It read: a fire that could not happen carries NO receipt, on the argument
     *  that `accepted: true` for a letter that was never posted is worse than
     *  the failure it papers over. That argument is CORRECT ABOUT `accepted` and
     *  WRONG ABOUT THE REF — it conflated the delivery claim with the handle.
     *
     *  The carrier run is filed under this ref either way, § 23 can answer
     *  questions about it, and § 24 may already be retrying it. Withholding it
     *  left the one party who needed all of that — the asker — unable to name
     *  their own exchange. A live drive had to recover the ref by scanning the
     *  audit trail, which no real caller can do.
     *
     *  ⇒ The handle goes back with `accepted: FALSE` plus the § 21 `kind` and
     *  whether a retry is coming. The old guard's real content survives intact
     *  and is asserted below: nothing here ever claims the letter went. */
    env = buildEnv([
      firingRecipe({ ref: '{{step.ref}}', deliver_to: 'recued-core/never-installed' }),
      sinkRecipe(),
    ]);
    const res = await run(env);
    expect(res.success).toBe(false);
    expect(res.exchange_ack?.accepted, 'it must never claim the letter went').toBe(false);
    expect(res.exchange_ack?.ref, 'and the caller must be able to name it').toBeTruthy();
    // A deliver_to nobody installed is a CONFIG fault — retrying cannot fix it,
    // so the receipt must not invite one.
    expect(res.exchange_ack?.retrying).toBe(false);
  });

  it('✅✅ an AGENT is told the answer was sent — not handed an empty result', async () => {
    // An exchange recipe renders NOTHING by construction, so what an agent sees
    // otherwise is `success: true` beside an empty `output.render`. That exact
    // shape is on the record in this projection's own comments: a model read an
    // empty result as a confident "you have none" and told the owner so. Every
    // agent surface (MCP runRecipe, the Tier-2 registry dispatch a peer arrives
    // through, chat) funnels here, so this is where it gets a sentence.
    const res = await run(env);
    const projected = projectRunResultForAgent(res) as Record<string, unknown>;
    expect(projected.status).toBe('exchange_accepted');
    expect(projected.ref).toBe('exch_fire_1');
    expect(projected.callback_op).toBe(SINK_TOOL);
    expect(String(projected.message)).toContain('has been sent');
    // ⛔ And no bare `success: true` + empty output survives into the agent's
    // view, which is the whole reason this projection exists.
    expect(projected.output).toBeUndefined();
    expect(projected.success).toBeUndefined();
  });

  it('⛔ an ordinary run is untouched by the exchange branch', async () => {
    // The projection is a chain of third states; a new branch that swallowed
    // ordinary results would be invisible here and catastrophic everywhere.
    const ordinary = { recipe_id: 'x', success: true, output: { render: [], sidebar: [] } };
    expect(projectRunResultForAgent(ordinary)).toBe(ordinary);
  });

  it('✅✅ § 20.17 — an answer with NO declared connection routes to the CALLER\'s peer', async () => {
    // ⛔ THE FAILURE THIS PREVENTS IS SILENT AND WRONG-WAY. A receiver cannot
    // name its caller's connection: install pins one, and the inbound call
    // carries a request, not a return path. Leaving it empty is not an error —
    // it is the gateway's LOCAL discriminator — so the answer would run the
    // peer's landing recipe on THIS server and report success.
    env = buildEnv([firingRecipe({ ref: '{{step.ref}}', deliver_to: SINK_TOOL }), sinkRecipe()], {
      peerConnections: [{ name: 'peer-alice', contract: 'ct_peer_alice' }],
    });
    const res = await run(env);
    // The connection resolved, so the dispatch went REMOTE — and this harness
    // wires no connection profile, which is exactly how a remote route announces
    // itself. Had it stayed local, the sink would have run instead.
    expect(res.success).toBe(false);
    expect(errorText(res)).toContain('no_connection_profile');
    expect(rowsFor(env, SINK), 'it answered ITSELF instead of the peer').toHaveLength(0);
  });

  it('⛔ a peer with NO bound connection does not silently answer itself', async () => {
    // The same run with no binding: nothing resolves, the fire routes local, and
    // the sink runs. Pinned so the difference between "routed to my peer" and
    // "ran on my own server" is a test, not a hope.
    env = buildEnv([firingRecipe({ ref: '{{step.ref}}', deliver_to: SINK_TOOL }), sinkRecipe()]);
    const res = await run(env);
    expect(res.success, errorText(res)).toBe(true);
    expect(rowsFor(env, SINK), 'nothing ran locally either').toHaveLength(1);
  });

  it('⛔⛔ TWO connections claiming one peer contract REFUSE rather than pick', async () => {
    // Picking either would route an answer to a peer by install order —
    // invisible, and different on two servers with the same records.
    env = buildEnv([firingRecipe({ ref: '{{step.ref}}', deliver_to: SINK_TOOL }), sinkRecipe()], {
      peerConnections: [
        { name: 'peer-alice', contract: 'ct_peer_alice' },
        { name: 'peer-alice-2', contract: 'ct_peer_alice' },
      ],
    });
    const res = await run(env);
    // Ambiguous ⇒ no connection ⇒ the local route, which the sink proves. It
    // does NOT pick one and send to a peer.
    expect(rowsFor(env, SINK)).toHaveLength(1);
  });

  it('⛔⛔ a fire that loops back to the declaring recipe is REFUSED', async () => {
    // A connection-less fire routes local, so a recipe whose callback_op resolves
    // to an op bound at ITSELF would run again, fire again, and never stop. The
    // declaring run's held stack is threaded into the fire for exactly this.
    env = buildEnv([
      firingRecipe({ ref: '{{step.ref}}', deliver_to: FIRER_TOOL }),
      sinkRecipe(),
    ]);
    const res = await run(env);
    expect(res.success).toBe(false);
    expect(errorText(res)).toContain('cycle');
    expect(rowsFor(env, FIRER), 'the loop closed and ran the firer again').toHaveLength(1);
  });
});

