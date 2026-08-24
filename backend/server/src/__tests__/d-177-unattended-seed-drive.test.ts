/** D-177 N.6 follow-on — the owner's UNATTENDED automation can be taught to
 *  stand: `(schedule, system)` + `(reactive, system)` join
 *  `SESSION_GRANT_DEFAULT_SEEDS`.
 *
 *  ⛔⛔ THE PREMISE THE OMISSION RESTED ON WAS FALSE, AND EVERY TEST HERE
 *  DRIVES RATHER THAN READS. The seed table said "the EVENT-FIRE channels
 *  never raise an ask, so a seed there would be a provable no-op". They raise
 *  asks constantly: `resolveTrustCeiling` floors a contract-free `system`
 *  dispatch to the LOW `read` ceiling, so every write a scheduled or reactive
 *  recipe attempts resolves to `ask` and HOLDS. That sentence had already been
 *  quoted once as evidence and found wrong (N.14.1, for reception) — so this
 *  file does not re-read it a third time. § 1 fires a real recipe through the
 *  real gate with a real notification block and reads the hold back out of the
 *  approvals-panel projection.
 *
 *  🔑 The instrument this unlocks was already fully built: every tick of one
 *  scheduled recipe shares a stable `channel_session_id`
 *  (`schedule:<source_recipe>`), which is the binding a session grant needs.
 *  The D-177 N.14 decisions-log entry named this very cell as the follow-on
 *  ("owner-automation learning — same stable-session structure on
 *  `schedule:<source_recipe>`"). Only the seed row was missing.
 *
 *  ⚠ § 4 pins what the seed does NOT buy, deliberately. An `exact` grant
 *  binds `canonical_payload_hash`, so it absorbs REPEAT IDENTICAL ticks and
 *  nothing else — a digest whose text carries last night's counts moves the
 *  hash and re-asks every fire. Anyone reading "the unattended cell is seeded"
 *  as "unattended writes stop asking" is wrong, and § 4 is where that is
 *  written down.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  D165_CONTRACT_SCHEMA,
  DELEGATION_RULE_MAX_USES,
  DELEGATION_RULE_TTL_MS,
  deriveDelegationRuleSuggestionKey,
  REACTIVE_SESSION_GRANT_DEFAULTS,
  SCHEDULE_SESSION_GRANT_DEFAULTS,
  matchesSessionGrant,
  resolveSessionGrantOffer,
  resolveTrustCeiling,
  type Checkpoint,
  type Commit,
  type ExecutionSource,
  type RecipeDefinition,
  type SessionGrantMatchContext,
  type SessionGrantMintContext,
} from '@recued/contracts';
import {
  deriveChannelSessionId,
  registerPreflightHandler,
} from '@recued/gateway';
import {
  createAuditLogStore,
  createCommitStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
  type CheckpointStore,
} from '@recued/storage';
import {
  createAskStore,
  createNotificationBlock,
  createNotificationSettingsStore,
  createUiChannel,
  type NotificationSettings,
  type PendingAsk,
} from '@recued/notification';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { handlePendingAsks } from '../history-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { createSessionGrantResolver } from '../session-grant-resolver.js';
import {
  createContractDefinitionStore,
  type ContractDefinitionStore,
} from '../storage/contract-definition-store.js';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';

const NOW = 1_700_000_000_000;

const scheduleSource = (source_recipe: string): ExecutionSource => ({
  channel: 'schedule',
  actor: 'system',
  cron: '0 9 * * *',
  source_recipe,
});

const reactiveSource = (source_recipe: string): ExecutionSource => ({
  channel: 'reactive',
  actor: 'system',
  event_kind: 'auto_run_tick',
  source_recipe,
});

/** A recipe whose ONLY step is a kernel write.
 *
 *  ⛔ THE VEHICLE MOVED, AND THE MOVE IS THE POINT. This was
 *  `core.notification.send` until that op was retiered to `read` and de-listed
 *  from the outbound-send set (owner ruling 2026-08-20 — it authors no
 *  recipient, so gating it only ever produced a second notification). Seven
 *  tests here went red the moment it stopped holding, which is the correct
 *  signal: they measure "an unattended WRITE holds", and a `read` op cannot
 *  carry that. `core.storage.shared.write` is the canonical INTERNAL write —
 *  `risk_tier: 'write'`, deliberately not an outbound send — so the suite
 *  measures exactly what it always did. */
const notifyRecipe = (recipe_id: string, marker: string): RecipeDefinition =>
  ({
    recipe_id,
    version: 1,
    ttl: 60,
    metadata: {
      name: recipe_id,
      description: 'Unattended seed drive fixture.',
      author: 'test',
      supported_platforms: ['test'],
      tags: ['test'],
    },
    variables: {},
    prefetch_steps: [],
    steps: [
      {
        id: 'notify',
        op: 'core.storage.shared.write',
        args: { key: `unattended_seed_drive.${marker}`, value: { at: 'tick' } },
      },
    ],
    output: { sidebar: [] },
  }) as unknown as RecipeDefinition;

/** The kernel `shared-write` dispatcher, RECORDING instead of persisting.
 *
 *  ⛔ The stub is the DELIVERY, never the gate. Every layer under test — the
 *  trust ceiling, the preflight gate, the ask, the answer handler, the mint and
 *  the match — runs for real; this only stands in for the channel fan-out, the
 *  same posture the semi-live pack drive takes with outbound mail.
 *
 *  ⚠ It is also load-bearing for the RESUME. Without a `kernel` adapter the
 *  resumed dispatch dies at `INGREDIENT_ADAPTER_ALL_FAILED` BEFORE it reaches
 *  the commit Gateway, so no grant is ever minted — and the join test then
 *  fails for a harness reason that reads exactly like a product defect. It cost
 *  one instrumented run to tell those apart. */
const recordingKernelDispatchers = (written: Array<{ key: string }>) => ({
  write: async (input: { key: string; value: unknown; ttl?: number }) => {
    written.push({ key: input.key });
    return { key: input.key, revision: written.length };
  },
});

const inMemoryCheckpointStore = (): CheckpointStore => {
  const written = new Map<string, Checkpoint>();
  return {
    write: vi.fn(async (c: Checkpoint) => {
      written.set(c.checkpoint_id, c);
    }),
    get: vi.fn(async (id: string) => written.get(id) ?? null),
    delete: vi.fn(async (id: string) => {
      written.delete(id);
    }),
    listByRun: vi.fn(async (r: string) =>
      [...written.values()].filter((c) => c.run_id === r),
    ),
    list: vi.fn(async () => [...written.values()]),
    size: vi.fn(async () => written.size),
  } as unknown as CheckpointStore;
};

let db: Database.Database;
let contractStore: ContractStore;
let definitionStore: ContractDefinitionStore;
let nowMs: number;
let idSeq: number;

beforeEach(() => {
  db = new Database(':memory:');
  nowMs = NOW;
  idSeq = 0;
  contractStore = createContractStore(db, { now: () => nowMs });
  contractStore.seedSchema(D165_CONTRACT_SCHEMA);
  definitionStore = createContractDefinitionStore(contractStore, {
    now: () => nowMs,
    newId: () => {
      idSeq += 1;
      return `ct_${idSeq}`;
    },
  });
});

afterEach(() => {
  db.close();
});

// ════════════════════════════════════════════════════════════════
// § 1 — the premise: an unattended fire DOES raise an ask
// ════════════════════════════════════════════════════════════════

/** Fire one recipe on one unattended source through the REAL gate, the REAL
 *  kernel manifests and a REAL notification block. Returns the hold + every
 *  surface the owner would meet it on. */
const fireUnattended = async (
  recipe: RecipeDefinition,
  execution_source: ExecutionSource,
  trigger_source: 'schedule' | 'auto_run',
  opts: { withResolver?: boolean } = {},
) => {
  const askStore = createAskStore(createInMemoryCollection<PendingAsk>());
  const block = createNotificationBlock({
    askStore,
    channels: [createUiChannel({ busSink: () => undefined })],
    settingsStore: createNotificationSettingsStore(
      createInMemoryCollection<NotificationSettings>(),
    ),
  });
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);
  const deps = {
    recipeStore,
    // No `communityDir` argument ⇒ the registry seeds the bundled KERNEL
    // manifests. `register()` refuses a `core-*` slug into the local layer
    // (the §5 anti-shadow guard), so hand-registering them is a silent no-op
    // and the gate would deny `kind_not_allowed` instead of deciding.
    executorConfig: {
      manifests: createManifestRegistry(),
      kernelDispatchers: recordingKernelDispatchers([]),
    },
    baseVault: {},
    instanceId: 'unattended-seed-drive',
    auditLog: createAuditLogStore(
      createInMemoryCollection<AuditEntry>(),
      createInMemoryCollection<ActivityEntry>(),
    ) as AuditLogStore,
    checkpointStore: inMemoryCheckpointStore(),
    preflightNotifier: block,
    ...(opts.withResolver === true
      ? {
          sessionGrantResolver: createSessionGrantResolver({
            definitionStore,
            now: () => nowMs,
          }),
        }
      : {}),
  } as unknown as ExecuteHandlerDeps;

  const result = await handleExecute(deps, {
    recipe_id: recipe.recipe_id,
    trigger_source,
    execution_source,
  } as never);

  const open = await askStore.listByStatus('open');
  const panel = await handlePendingAsks({
    listOpenAsks: () => askStore.listByStatus('open'),
  } as never);
  return { result, open, panel };
};

describe('§ 1 — an unattended fire raises a real, owner-visible ask', () => {
  it.each([
    ['schedule', scheduleSource('nightly-digest'), 'schedule'],
    ['reactive', reactiveSource('inbox-digest'), 'auto_run'],
  ] as const)(
    '%s/system holds its write and the ask reaches the approvals panel',
    async (name, execution_source, trigger_source) => {
      // The ceiling is the whole reason: a contract-free `system` dispatch is
      // floored LOW, so a `write` op cannot admit.
      expect(resolveTrustCeiling(execution_source), name).toBe('read');

      const { result, open, panel } = await fireUnattended(
        notifyRecipe(`seed-drive-${name}`, 'mark-a'),
        execution_source,
        trigger_source,
      );

      // A held run is `success: false` with EMPTY errors — check the hold
      // FIRST or a gate reads as a failure.
      expect(result.errors ?? [], name).toEqual([]);
      expect(
        (result as { awaiting_approval?: unknown }).awaiting_approval,
        name,
      ).toBeDefined();

      // The ask is durable and the owner can SEE it: this is the exact
      // projection `notification.pending_asks` serves the approvals panel.
      expect(open, name).toHaveLength(1);
      expect(panel.asks, name).toHaveLength(1);
      expect(panel.asks[0]!.title, name).toContain('shared-write');
      expect(panel.asks[0]!.created_at, name).toBeGreaterThan(0);
    },
  );
});

// ════════════════════════════════════════════════════════════════
// § 2 — the seed makes the hold ANSWERABLE with "and keep saying yes"
// ════════════════════════════════════════════════════════════════

describe('§ 2 — the unattended hold now offers allow_session', () => {
  it.each([
    ['schedule', scheduleSource('nightly-digest'), 'schedule', SCHEDULE_SESSION_GRANT_DEFAULTS],
    ['reactive', reactiveSource('inbox-digest'), 'auto_run', REACTIVE_SESSION_GRANT_DEFAULTS],
  ] as const)('%s/system offers the third option with its seed bounds', async (
    name,
    execution_source,
    trigger_source,
    seed,
  ) => {
    const { open } = await fireUnattended(
      notifyRecipe(`seed-offer-${name}`, 'mark-b'),
      execution_source,
      trigger_source,
      { withResolver: true },
    );

    expect(open, name).toHaveLength(1);
    expect(open[0]!.options.map((o) => o.id), name).toEqual([
      'approve',
      'allow_session',
      'deny',
    ]);
    expect(
      resolveSessionGrantOffer({
        channel: execution_source.channel,
        actor: execution_source.actor,
        risk_tier: 'write',
        pre_lift_approval: 'ask',
      }),
      name,
    ).toEqual({ ttl_ms: seed.ttl_ms, max_uses: seed.max_uses, risk_tier: 'write' });
  });

  it('⚠ the offer needs the RESOLVER too — the seed alone is not enough', async () => {
    // Found by driving: with the cell seeded but no `sessionGrantResolver` on
    // the deps, the ask still rendered the binary options. The host suppresses
    // an offer it could not mint or later match, which is correct — and it
    // means "the seed resolves" is NOT evidence the owner sees a third button.
    // Production wires the resolver off the contract-definition store
    // (`wire-execute-deps.ts`); a dbless harness does not.
    const { open } = await fireUnattended(
      notifyRecipe('seed-offer-no-resolver', 'mark-c'),
      scheduleSource('nightly-digest'),
      'schedule',
    );
    expect(open[0]!.options.map((o) => o.id)).toEqual(['approve', 'deny']);
  });
});

// ════════════════════════════════════════════════════════════════
// § 3 — mint → match across TICKS (the point of the whole change)
// ════════════════════════════════════════════════════════════════

const mintCtx = (
  execution_source: ExecutionSource,
  overrides: Partial<SessionGrantMintContext> = {},
): SessionGrantMintContext => ({
  channel: execution_source.channel,
  actor: execution_source.actor,
  channel_session_id: deriveChannelSessionId(execution_source),
  ingredient_slug: 'shared-write',
  recipe_id: 'nightly-digest',
  recipe_hash: 'recipe-hash-1',
  risk_tier: 'write',
  pre_lift_approval: 'ask',
  arg_shape_hash: 'arg-shape-hash',
  canonical_payload_hash: 'payload-hash-tick-1',
  ttl_ms: SCHEDULE_SESSION_GRANT_DEFAULTS.ttl_ms,
  max_uses: SCHEDULE_SESSION_GRANT_DEFAULTS.max_uses,
  approved_action_ref: 'run-tick-1',
  ...overrides,
});

describe('§ 3 — one press stands across subsequent ticks of the same recipe', () => {
  it('a grant minted on tick 1 matches tick 2 of the SAME schedule', () => {
    const resolver = createSessionGrantResolver({ definitionStore, now: () => nowMs });
    const ctx = mintCtx(scheduleSource('nightly-digest'));

    // The session id is the binding, and it is the SAME string every tick —
    // that is the property the whole change rests on.
    expect(ctx.channel_session_id).toBe('schedule:nightly-digest');

    resolver.mint(ctx);
    const grants = definitionStore.listSessionGrants(ctx.channel_session_id);
    expect(grants).toHaveLength(1);

    // Tick 2, one day later: same recipe, same args, a fresh run.
    nowMs = NOW + 24 * 60 * 60 * 1000;
    const tick2: SessionGrantMatchContext = { ...ctx, approved_action_ref: undefined } as never;
    expect(resolver.match(tick2)).toBe(grants[0]!.contract_id);
  });

  it('and it still stands at the far edge of the TTL, then stops', () => {
    const resolver = createSessionGrantResolver({ definitionStore, now: () => nowMs });
    const ctx = mintCtx(scheduleSource('nightly-digest'));
    resolver.mint(ctx);

    // A daily cron's 29th tick — the case a sitting-scaled TTL would have
    // dropped on day one. This is why the cell is cadence-scaled.
    nowMs = NOW + 29 * 24 * 60 * 60 * 1000;
    expect(resolver.match(ctx)).not.toBeNull();

    // Past the TTL it holds again and the next ask re-offers: the designed
    // re-affirm rhythm, not a failure.
    nowMs = NOW + SCHEDULE_SESSION_GRANT_DEFAULTS.ttl_ms + 1;
    expect(resolver.match(ctx)).toBeNull();
  });

  it('never leaks to ANOTHER scheduled recipe — the session names one recipe', () => {
    const resolver = createSessionGrantResolver({ definitionStore, now: () => nowMs });
    resolver.mint(mintCtx(scheduleSource('nightly-digest')));

    // Same channel, same actor, same op, same args — a DIFFERENT recipe. The
    // grant must not travel: "allow for this schedule", never "allow schedules".
    const otherRecipe: SessionGrantMatchContext = {
      ...mintCtx(scheduleSource('weekly-invoice-run')),
      recipe_id: 'weekly-invoice-run',
    } as never;
    expect(otherRecipe.channel_session_id).toBe('schedule:weekly-invoice-run');
    expect(resolver.match(otherRecipe)).toBeNull();
  });

  it('never leaks across the schedule/reactive channel boundary', () => {
    const resolver = createSessionGrantResolver({ definitionStore, now: () => nowMs });
    resolver.mint(mintCtx(scheduleSource('nightly-digest')));
    // `deriveChannelSessionId` prefixes the channel precisely so a schedule
    // and a reactive fire of the same recipe id cannot share a session.
    const asReactive = mintCtx(reactiveSource('nightly-digest'));
    expect(asReactive.channel_session_id).toBe('reactive:nightly-digest');
    expect(resolver.match(asReactive)).toBeNull();
  });

  it('a recipe EDIT re-asks — the grant is bound to the content it approved', () => {
    const resolver = createSessionGrantResolver({ definitionStore, now: () => nowMs });
    const ctx = mintCtx(scheduleSource('nightly-digest'));
    resolver.mint(ctx);
    expect(
      resolver.match({ ...ctx, recipe_hash: 'recipe-hash-EDITED' } as never),
    ).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// § 4 — what the seed does NOT buy (the honest limit)
// ════════════════════════════════════════════════════════════════

describe('§ 4 — an exact grant absorbs REPEAT IDENTICAL ticks and nothing more', () => {
  it('a tick whose payload MOVED re-asks — the digest case, pinned', () => {
    // ⛔ This is the limit anyone quoting "the unattended cell is seeded" must
    // know. `matchesGateGrant`'s `'exact'` arm compares
    // `canonical_payload_hash`, so a digest whose text carries last night's
    // counts lands on a different hash and holds again — every single fire.
    // ⚠ AND A SESSION GRANT IS NOT THE ONLY INSTRUMENT — corrected 2026-08-20,
    // after this comment's first draft implied it was. Two others exist and
    // both outrank it for a varying payload:
    //   - `grant_mode: 'open'` absorbs varying fires, but needs an
    //     `authority_args` declaration on the op (the runtime gate is literally
    //     `if (op.authority_args === undefined) return undefined`). Three
    //     kernel manifests carry one; ZERO packs do.
    //   - the OWNER'S OWN RULING (D-211
    //     `collection.operation.upsertOwnerOverride`) replaces the op's RISK
    //     TIER outright, which moves its approval floor with it. That is the
    //     escape three sessions recorded as non-existent — see
    //     `fleet-money-owner-override-drive.test.ts`, which drives it live.
    // ⛔ `owner_override.approval` alone does NOT do this: it is clamped UP to
    // the risk floor, which is exactly why probing only that half produced
    // "the ceiling beats the override" and made the escape look unreachable.
    const resolver = createSessionGrantResolver({ definitionStore, now: () => nowMs });
    const ctx = mintCtx(scheduleSource('nightly-digest'));
    resolver.mint(ctx);

    expect(resolver.match(ctx)).not.toBeNull(); // identical tick: absorbed
    expect(
      resolver.match({
        ...ctx,
        canonical_payload_hash: 'payload-hash-tick-2-different-counts',
      } as never),
    ).toBeNull(); // varying tick: re-asks
  });
});

// ════════════════════════════════════════════════════════════════
// § 5 — the bounds, and the ceiling they may never cross
// ════════════════════════════════════════════════════════════════

describe('§ 5 — the unattended seeds sit AT the standing ceiling, never above', () => {
  it.each([
    ['schedule', SCHEDULE_SESSION_GRANT_DEFAULTS],
    ['reactive', REACTIVE_SESSION_GRANT_DEFAULTS],
  ] as const)('%s stays within the ratified standing-delegation bounds', (name, seed) => {
    // An unattended session grant is materially the standing `write`-only
    // posture a delegation rule already occupies, so it may SIT AT that
    // ceiling — and must never exceed it. The constants are literal per this
    // file's per-cell copy idiom; THIS is what stops the copy drifting up.
    expect(seed.ttl_ms, name).toBeLessThanOrEqual(DELEGATION_RULE_TTL_MS);
    expect(seed.max_uses, name).toBeLessThanOrEqual(DELEGATION_RULE_MAX_USES);
  });

  it.each([
    ['schedule', 'schedule'],
    ['reactive', 'reactive'],
  ] as const)('%s offers write only — never admin, never destructive', (name, channel) => {
    expect(
      resolveSessionGrantOffer({
        channel: channel as never,
        actor: 'system',
        risk_tier: 'write',
        pre_lift_approval: 'ask',
      }),
      name,
    ).toBeDefined();
    for (const risk_tier of ['admin', 'destructive'] as const) {
      // `admin` is excluded DELIBERATELY: administering the server on a timer
      // with nobody watching is a wider posture than running the owner's own
      // scheduled work. `destructive` is never session-grantable at all.
      expect(
        resolveSessionGrantOffer({
          channel: channel as never,
          actor: 'system',
          risk_tier,
          pre_lift_approval: 'ask',
        }),
        `${name}/${risk_tier}`,
      ).toBeUndefined();
    }
  });

  it('a hand-shaped grant above the tier ceiling is INERT at the matcher', () => {
    // Belt to the offer's suspenders: the offer refuses to mint an admin row,
    // and the matcher independently refuses to honour one.
    const resolver = createSessionGrantResolver({ definitionStore, now: () => nowMs });
    const ctx = mintCtx(scheduleSource('nightly-digest'));
    resolver.mint(ctx);
    const grant = definitionStore.listSessionGrants(ctx.channel_session_id)[0]!;
    expect(
      matchesSessionGrant(grant, { ...ctx, risk_tier: 'destructive' } as never, nowMs),
    ).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// § 6 — the ladder stops here, deliberately
// ════════════════════════════════════════════════════════════════

describe('§ 6 — an unattended grant is NOT learnable into a delegation rule', () => {
  it('the N.13 learner derives no key from a system-actor grant', () => {
    // ⛔ NEGATIVE PIN — do not "fix" this by relaxing the learner's actor gate.
    // The N.13 delegation tier exists to carry an approval ACROSS SESSIONS.
    // Owner automation has no across-sessions to reach: `channel_session_id`
    // is `schedule:<source_recipe>`, i.e. the recipe's ENTIRE cadence, so the
    // session tier already spans every tick the delegation tier would. Keying
    // `system` here would mint a scope-bound rule that adds no reach and
    // subtracts the per-recipe binding.
    //
    // It also fails closed the other way today: `mintDelegationRule` requires
    // `scope.actors` to be exactly `['user_self']` or `['anonymous']`+door, so
    // a suggested `system` rule could be shown and then REFUSED at accept —
    // an offer the substrate cannot honour. The learner's exhaustive
    // `else return undefined` is what keeps those two consistent.
    const resolver = createSessionGrantResolver({ definitionStore, now: () => nowMs });
    const ctx = mintCtx(scheduleSource('nightly-digest'));
    resolver.mint(ctx);
    const grant = definitionStore.listSessionGrants(ctx.channel_session_id)[0]!;

    expect(deriveDelegationRuleSuggestionKey(grant)).toBeUndefined();

    // ⚠ POSITIVE CONTROL — without it this assertion is worthless. The
    // derivation returns `undefined` for a dozen unrelated reasons (a missing
    // operation id, a missing recipe hash, an unbounded row), so an
    // `undefined` here proves the ACTOR gate only if an otherwise-identical
    // owner grant DOES key. Same op, same recipe, same hashes, same bounds —
    // the actor and its session are the only things that differ.
    const ownerCtx: SessionGrantMintContext = {
      ...ctx,
      channel: 'chat',
      actor: 'user_self',
      channel_session_id: 'chat:sitting-1',
    } as never;
    resolver.mint(ownerCtx);
    const ownerGrant = definitionStore.listSessionGrants('chat:sitting-1')[0]!;
    expect(deriveDelegationRuleSuggestionKey(ownerGrant)).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════
// § 7 — THE JOIN: answer the offer, and the NEXT tick runs silently
// ════════════════════════════════════════════════════════════════

/** ⛔⛔ § 2 proves the offer is MADE. § 3 proves a grant, once it exists,
 *  MATCHES a later tick. Neither proves that ANSWERING the offer produces
 *  that grant — and two suites stubbing one boundary from opposite sides is
 *  the shape where a defect survives every green test. This section runs the
 *  join: one notification block, one checkpoint store, one execute-deps
 *  bundle, the real `gateway.preflight` answer handler and the real resumer.
 *  Fire → hold → the owner presses "allow" → fire again. */
describe('§ 7 — one press, then the automation runs itself', () => {
  // ⛔ BOTH CHANNELS, not just `schedule`. `reactive` is where the corpus
  // actually lives — 189 shipped recipes pair `auto_run` with
  // `core.notification.send` — and a boundary is covered only by a test that
  // goes THROUGH it. The two channels reach the ceiling by different arms of
  // `resolveTrustCeiling` and derive different session ids, so one passing is
  // not evidence about the other.
  it.each([
    ['schedule', scheduleSource('nightly-digest'), 'schedule', 'schedule:nightly-digest'],
    ['reactive', reactiveSource('nightly-digest'), 'auto_run', 'reactive:nightly-digest'],
  ] as const)('%s — fire 2 proceeds without holding', async (
    _name,
    source,
    trigger_source,
    sessionId,
  ) => {
    const recipe = notifyRecipe('nightly-digest', 'the-same-mark');

    const askStore = createAskStore(createInMemoryCollection<PendingAsk>());
    const block = createNotificationBlock({
      askStore,
      channels: [createUiChannel({ busSink: () => undefined })],
      settingsStore: createNotificationSettingsStore(
        createInMemoryCollection<NotificationSettings>(),
      ),
    });
    const checkpoints = inMemoryCheckpointStore();
    const auditLog = createAuditLogStore(
      createInMemoryCollection<AuditEntry>(),
      createInMemoryCollection<ActivityEntry>(),
    ) as AuditLogStore;
    const recipeStore = createRecipeStore('/nonexistent');
    recipeStore.register(recipe);

    const sent: Array<{ key: string }> = [];
    const deps = {
      recipeStore,
      executorConfig: {
        manifests: createManifestRegistry(),
        kernelDispatchers: recordingKernelDispatchers(sent),
      },
      baseVault: {},
      instanceId: 'unattended-seed-join',
      auditLog,
      checkpointStore: checkpoints,
      preflightNotifier: block,
      // ⛔ LOAD-BEARING, and the reason the first cut of this test failed with
      // a symptom that read like a product defect. The session-grant MINT lives
      // at the commit Gateway's ask-branch, and `commitGatewayActive` is
      // `runIdentity !== undefined && deps.commitStore !== undefined` — so with
      // no commit store the Gateway never runs, the mint site is never reached,
      // and answering `allow_session` silently mints nothing. Production wires
      // one (`wire-execute-deps.ts`); a harness that omits it is testing a
      // server that cannot mint.
      commitStore: createCommitStore(createInMemoryCollection<Commit>()),
      sessionGrantResolver: createSessionGrantResolver({
        definitionStore,
        now: () => nowMs,
      }),
    } as unknown as ExecuteHandlerDeps;

    // The answer path, wired exactly as `wire-notification-block.ts` wires it.
    registerPreflightHandler(block, {
      checkpointStore: checkpoints,
      resumer: createPreflightResumer({ getExecuteDeps: () => deps, auditLog }),
    });

    const fire = () =>
      handleExecute(deps, {
        recipe_id: recipe.recipe_id,
        trigger_source,
        execution_source: source,
      } as never);

    // ── Tick 1: holds, and asks with the third option ──────────────
    const tick1 = await fire();
    expect((tick1 as { awaiting_approval?: unknown }).awaiting_approval).toBeDefined();
    const [ask] = await askStore.listByStatus('open');
    expect(ask).toBeDefined();
    expect(ask!.options.map((o) => o.id)).toContain('allow_session');
    // Nothing stands yet — the grant is what the ANSWER creates.
    expect(definitionStore.listSessionGrants(sessionId)).toHaveLength(0);

    // ── The owner presses "allow for this schedule" ────────────────
    await block.submitAnswer({ ask_id: ask!.ask_id, option: 'allow_session', via: 'ui' });

    const granted = definitionStore.listSessionGrants(sessionId);
    expect(granted, 'answering allow_session must mint a grant').toHaveLength(1);
    // The mint pinned what the ask offered — the seed's own bounds, on the
    // session that names this one schedule.
    expect(granted[0]!.channel_session_id).toBe(sessionId);
    expect(granted[0]!.risk_tier).toBe('write');
    expect(granted[0]!.uses_remaining).toBeLessThanOrEqual(
      SCHEDULE_SESSION_GRANT_DEFAULTS.max_uses,
    );

    // ── Tick 2, next morning: the whole point ─────────────────────
    const asksAfterAnswer = (await askStore.listByStatus('open')).length;
    nowMs = NOW + 24 * 60 * 60 * 1000;
    const tick2 = await fire();

    expect(
      (tick2 as { awaiting_approval?: unknown }).awaiting_approval,
      'tick 2 must NOT hold — the grant absorbs it',
    ).toBeUndefined();
    // ⚠ And it must not have asked QUIETLY either: "did not hold" and "held
    // somewhere I did not look" read identically on the result object alone.
    expect(
      (await askStore.listByStatus('open')).length,
      'tick 2 must raise no new ask',
    ).toBe(asksAfterAnswer);
    // ⛔ AND IT MUST ACTUALLY HAVE RUN. "Did not hold" is also what a run that
    // never reached the step looks like — the two are indistinguishable on the
    // result object, so assert the EFFECT. Two deliveries: the approved resume
    // of tick 1, then tick 2 riding the grant.
    expect(sent.map((m) => m.key), 'the write must actually dispatch')
      .toEqual([
        'unattended_seed_drive.the-same-mark',
        'unattended_seed_drive.the-same-mark',
      ]);
    // One use spent per dispatch — the budget is the real fence.
    const after = definitionStore.listSessionGrants(sessionId)[0]!;
    expect(after.uses_remaining).toBe(SCHEDULE_SESSION_GRANT_DEFAULTS.max_uses - 1);
  });
});
