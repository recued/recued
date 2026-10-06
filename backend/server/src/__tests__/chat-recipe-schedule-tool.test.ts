/** D-193 amendment (2026-10-05) — chat's `recipe.schedule`.
 *
 *  The owner ruled that no recipe step may schedule another recipe ("take out
 *  core.schedule.recipe, not to be used in recipe step"), which retired the D-193
 *  "Schedule recipe" recipe, chat's only way to schedule. Chat now schedules
 *  through this Tier-1 tool, granted by the owner's contract.
 *
 *  Driven through `buildChatTier1Handlers` with the REAL admission gate over real
 *  contract stores, a real recipe store and a real schedule store, so who may
 *  schedule is decided by the same resolution every other gate uses, not by a
 *  stub that answers whatever the test wants. Each refusal first proves its
 *  cause: a door is refused for being a door, not for lacking the grant. */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  opGrantEntry,
  OWNER_CONTRACT_ID,
  STDIO_MCP_TOKEN_ID,
  TIER1_CLASSIFICATIONS,
  TIER1_TOOL_DESCRIPTORS,
  TIER1_TOOL_NAMES,
  type ChatDispatchContext,
  type ChatDispatchResult,
  type DishWebhookDoorChange,
  type ExecutionSource,
  type RecipeDefinition,
} from '@recued/contracts';

import { buildChatTier1Handlers, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { createOpAdmissionGate, type OpAdmissionGate } from '../op-admission-gate.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import { createScheduleStore, type ScheduleStore } from '../schedule-store.js';
import { createInstalledRecipeScheduler } from '../schedule-installed-recipe.js';
import type { ScheduleHandlerDeps } from '../schedule-handler.js';
import { createContractStore } from '../storage/contract-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';

const NOW = 1_750_000_000_000;
const OP = 'core.schedule.recipe';

const ownerChat: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 's1', user_id: 'owner' };
const ownerMessenger: ExecutionSource = { channel: 'messenger', actor: 'user_self', vendor: 'slack', from: 'owner' };
const mcp = (contract_id: string): ExecutionSource => ({
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'a1',
  tool_call_id: 'tc1',
  mcp_token_id: 'tok1',
  contract_id,
});
/** The owner's own local MCP client (stdio / canonical CLI): no token, so the
 *  reserved sentinel, and a synthetic contract id equal to it. */
const ownerLocalMcp: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'claude-desktop',
  tool_call_id: 'tc2',
  mcp_token_id: STDIO_MCP_TOKEN_ID,
  contract_id: STDIO_MCP_TOKEN_ID,
};

const ctx = (execution_source?: ExecutionSource): ChatDispatchContext => ({
  channel: 'internal_function_call',
  session_id: 's1',
  turn_id: 't1',
  ...(execution_source !== undefined ? { execution_source } : {}),
});

const recipe = (recipe_id: string): RecipeDefinition => ({
  recipe_id,
  version: 1,
  metadata: { name: 'Daily digest', description: 'fixture', author: 'recued-core', tags: [] },
  steps: [],
}) as unknown as RecipeDefinition;

let dir: string;
let recipeDb: Database.Database;
let contractDb: Database.Database;
let recipes: RecipeStore;
let schedules: ScheduleStore;
let gate: OpAdmissionGate;
let grants: ReturnType<typeof createContractGrantEntryStore>;
let defs: ReturnType<typeof createContractDefinitionStore>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chat-recipe-schedule-'));
  recipeDb = new Database(':memory:');
  recipes = createRecipeStore(dir, recipeDb);
  recipes.save(recipe('daily-digest'), 'recued-core', 'bundled');
  schedules = createScheduleStore(new Database(':memory:'));
  contractDb = new Database(':memory:');
  const contracts = createContractStore(contractDb, { now: () => NOW });
  grants = createContractGrantEntryStore(contracts);
  defs = createContractDefinitionStore(contracts, { now: () => NOW });
  gate = createOpAdmissionGate({ grantEntryStore: grants, definitionStore: defs, now: () => NOW });
});
afterEach(() => {
  recipeDb.close();
  contractDb.close();
  rmSync(dir, { recursive: true, force: true });
});

const tool = (overrides: {
  scheduleDeps?: Partial<ScheduleHandlerDeps>;
  gate?: OpAdmissionGate | null;
  scheduler?: false;
} = {}) => {
  const deps: ChatToolHandlerDeps = {
    getContactStore: () => undefined,
    getCollectionRegistry: () => undefined,
    getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined,
    getRecipeStore: () => recipes,
    getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
    getExecuteRecipe: () => undefined,
    getOpAdmissionGate: () => (overrides.gate === null ? undefined : overrides.gate ?? gate),
    getInstalledRecipeScheduler: () => (overrides.scheduler === false
      ? undefined
      : createInstalledRecipeScheduler({
          scheduleDeps: { store: schedules, instanceId: 'i-1', ...overrides.scheduleDeps } as ScheduleHandlerDeps,
          recipeStore: recipes,
          packs: { scanInstalledPacks: () => [], getManifest: () => null },
        })),
  };
  const handler = buildChatTier1Handlers(deps)['recipe.schedule'];
  if (handler === undefined) throw new Error('recipe.schedule is not in the Tier-1 handler table');
  // `null` = a dispatch carrying no source at all (a default parameter would
  // quietly turn `undefined` into the owner).
  return (args: unknown, source: ExecutionSource | null = ownerChat): Promise<ChatDispatchResult> =>
    handler(args, ctx(source ?? undefined));
};

const refusedWith = (reason: string, detail: RegExp) => expect.objectContaining({ ok: false, reason, detail: expect.stringMatching(detail) });

describe('recipe.schedule — the owner schedules from chat', () => {
  it('a recurring schedule, written for the recipe\'s own publisher', async () => {
    const out = await tool()({ recipe_id: 'daily-digest', mode: 'recurring', cron_expression: '0 8 * * 1' });
    expect(out).toMatchObject({
      ok: true,
      result: { status: 'scheduled', recipe_id: 'recued-core/daily-digest', mode: 'recurring', enabled: true },
    });
    const [row] = schedules.list();
    expect(row).toMatchObject({ recipe_id: 'daily-digest', publisher_id: 'recued-core', cron_expression: '0 8 * * 1' });
    expect((out as { result: { schedule_id: string } }).result.schedule_id).toBe(row!.schedule_id);
  });

  it('a one-shot at an instant with an offset, reported back in the zone the schedule runs in', async () => {
    const out = await tool({ scheduleDeps: { serverTimeZone: () => 'America/Los_Angeles' } })(
      { recipe_id: 'recued-core/daily-digest', mode: 'one_shot', run_at: '2030-07-04T15:00:00-07:00' },
    );
    // The wall clock the user asked for, with its offset: no UTC for the model
    // to convert before it tells them.
    expect(out).toMatchObject({ ok: true, result: { mode: 'one_shot', next_run_at: '2030-07-04T15:00:00-07:00' } });
    expect(schedules.list()).toEqual([expect.objectContaining({ run_at: Date.parse('2030-07-04T22:00:00Z') })]);
  });

  it('the next run reads in the schedule\'s own zone, so a server elsewhere shows its offset', async () => {
    const out = await tool({ scheduleDeps: { serverTimeZone: () => 'Asia/Tokyo' } })(
      { recipe_id: 'daily-digest', mode: 'one_shot', run_at: '2030-07-04T15:00:00-07:00' },
    );
    expect(out).toMatchObject({ ok: true, result: { next_run_at: '2030-07-05T07:00:00+09:00' } });
  });

  it('from the owner\'s messenger too: the owner\'s contract governs both', async () => {
    const out = await tool()({ recipe_id: 'daily-digest', mode: 'recurring', cron_expression: '0 8 * * *' }, ownerMessenger);
    expect(out).toMatchObject({ ok: true });
  });

  it('can create it switched off, and says so', async () => {
    const out = await tool()({ recipe_id: 'daily-digest', mode: 'recurring', cron_expression: '0 8 * * *', enabled: false });
    expect(out).toMatchObject({ ok: true, result: { enabled: false } });
    expect(schedules.list()).toEqual([expect.objectContaining({ enabled: false })]);
  });
});

describe('recipe.schedule — refused arguments schedule nothing', () => {
  it.each([
    ['no recipe_id', { mode: 'recurring', cron_expression: '0 8 * * *' }, /needs recipe_id/],
    ['an unknown mode', { recipe_id: 'daily-digest', mode: 'weekly' }, /mode must be/],
    ['a one-shot with no run_at', { recipe_id: 'daily-digest', mode: 'one_shot' }, /WITH a timezone offset/],
    // ⛔ The D-193 rule: an offset-less time would be read in the server's zone,
    // which is not necessarily the user's, and schedule the wrong instant.
    ['a one-shot without an offset', { recipe_id: 'daily-digest', mode: 'one_shot', run_at: '2030-07-04T15:00:00' }, /WITH a timezone offset/],
    ['a recurring schedule with no cron', { recipe_id: 'daily-digest', mode: 'recurring' }, /needs cron_expression/],
    ['an empty dish_id', { recipe_id: 'daily-digest', mode: 'recurring', cron_expression: '0 8 * * *', dish_id: ' ' }, /dish_id/],
    ['a non-boolean enabled', { recipe_id: 'daily-digest', mode: 'recurring', cron_expression: '0 8 * * *', enabled: 'no' }, /enabled/],
  ])('%s', async (_label, args, detail) => {
    expect(await tool()(args)).toEqual(refusedWith('invalid_args', detail));
    expect(schedules.list()).toEqual([]);
  });

  it('a recipe that is not installed is named in the refusal', async () => {
    expect(await tool()({ recipe_id: 'acme/nightly-report', mode: 'recurring', cron_expression: '0 8 * * *' }))
      .toEqual(refusedWith('execution_error', /Recipe 'acme\/nightly-report' not found/));
    expect(schedules.list()).toEqual([]);
  });

  it('a cron that fires too often is refused by the same floor as the Run dialog', async () => {
    expect(await tool()({ recipe_id: 'daily-digest', mode: 'recurring', cron_expression: '* * * * *' }))
      .toEqual(refusedWith('execution_error', /./));
    expect(schedules.list()).toEqual([]);
  });

  it('with no schedule store wired it says scheduling is unavailable', async () => {
    expect(await tool({ scheduler: false })({ recipe_id: 'daily-digest', mode: 'recurring', cron_expression: '0 8 * * *' }))
      .toEqual(refusedWith('execution_error', /unavailable/));
  });
});

describe('recipe.schedule — only the owner, and only while granted', () => {
  const ARGS = { recipe_id: 'daily-digest', mode: 'recurring', cron_expression: '0 8 * * *' };

  it('⛔ an owner who switched off core.schedule.recipe gets a refusal, and nothing is armed', async () => {
    grants.set(OWNER_CONTRACT_ID, opGrantEntry(OP), false, NOW);
    expect(gate.isOwnerGoverned(ownerChat)).toBe(true);
    expect(await tool()(ARGS)).toEqual(refusedWith('classification_blocked', /not granted to this contract/));
    expect(schedules.list()).toEqual([]);
  });

  it('⛔ a door is refused EVEN WHEN its contract holds the op: its runs would fire with no contract at all', async () => {
    const door = defs.mint({
      minted_by: 'owner',
      display_name: 'Partner agent',
      scope: { channels: ['mcp'], actors: ['contracted_user'], operation_ids: [OP] },
    });
    grants.set(door.contract_id, opGrantEntry(OP), true, NOW);
    // The cause, proven first: the grant is there, and the door is not the owner.
    expect(gate.isOpGranted(mcp(door.contract_id), OP)).toBe(true);
    expect(gate.isOwnerGoverned(mcp(door.contract_id))).toBe(false);
    expect(await tool()(ARGS, mcp(door.contract_id))).toEqual(refusedWith('classification_blocked', /only for the owner's own chat/));
    expect(schedules.list()).toEqual([]);
  });

  it('⛔ a remote MCP token is a door even when no contract governs it', async () => {
    // Its contract id names no contract, so the op gate admits it (contract-free).
    // The tool still refuses: only the owner's local client is not a door
    // (`isDelegatedMcpToken`), and a remote token never proves its way out.
    expect(gate.isOpGranted(mcp('tok-without-a-contract'), OP)).toBe(true);
    expect(await tool()(ARGS, mcp('tok-without-a-contract'))).toEqual(refusedWith('classification_blocked', /only for the owner's own chat/));
    expect(schedules.list()).toEqual([]);
  });

  it("✅ the owner's own local MCP client (stdio / CLI) schedules (owner: \"cli: allows\")", async () => {
    expect(gate.isOwnerGoverned(ownerLocalMcp)).toBe(false);
    expect(await tool()(ARGS, ownerLocalMcp)).toMatchObject({ ok: true, result: { status: 'scheduled' } });
    expect(schedules.list()).toHaveLength(1);
  });

  it("…and no grant applies to it, as for every op on that connection: the owner's revoke governs their chat", async () => {
    grants.set(OWNER_CONTRACT_ID, opGrantEntry(OP), false, NOW);
    expect(await tool()(ARGS)).toEqual(refusedWith('classification_blocked', /not granted to this contract/));
    expect(await tool()(ARGS, ownerLocalMcp)).toMatchObject({ ok: true });
    expect(schedules.list()).toHaveLength(1);
  });

  it('⛔ fails closed with no gate or no source', async () => {
    expect(await tool({ gate: null })(ARGS)).toEqual(refusedWith('classification_blocked', /not available here/));
    expect(await tool()(ARGS, null)).toEqual(refusedWith('classification_blocked', /not available here/));
    expect(schedules.list()).toEqual([]);
  });
});

describe('recipe.schedule — a webhook door the schedule moved is the model\'s to tell', () => {
  const ARGS = { recipe_id: 'daily-digest', mode: 'recurring', cron_expression: '0 8 * * *' };
  /** The recipe's main dish, as `mainDishFor` returns it when making one moved a door. */
  const mainDishMoving = (webhook_doors: DishWebhookDoorChange[]): Partial<ScheduleHandlerDeps> => ({
    mainDish: () => ({ dish: { dish_id: 'dsh_main' } as never, webhook_doors }),
  });

  it('a door that opened is named with what messages coming in may now use', async () => {
    const out = await tool({ scheduleDeps: mainDishMoving([{
      recipe_id: 'daily-digest',
      recipe_name: 'Daily digest',
      state: 'opened',
      was_open: false,
      added: ['recued-core.home-assistant.camera.snapshot', 'connection:home-assistant'],
      removed: [],
    }]) })(ARGS);
    expect(out).toMatchObject({
      ok: true,
      result: {
        note: 'Tell the user: Daily digest\'s webhook is now on: messages coming in run with its main settings '
          + 'and may use recued-core.home-assistant.camera.snapshot, the home-assistant account.',
      },
    });
    expect(schedules.list()).toEqual([expect.objectContaining({ dish_id: 'dsh_main' })]);
  });

  it('a door that stays off says why', async () => {
    const out = await tool({ scheduleDeps: mainDishMoving([
      { recipe_id: 'daily-digest', recipe_name: 'Daily digest', state: 'closed', was_open: false, reason_code: 'no_account' },
      { recipe_id: 'daily-digest', state: 'kept_revoked', was_open: false },
    ]) })(ARGS);
    expect((out as { result: { note: string } }).result.note).toBe(
      'Tell the user: Daily digest\'s webhook is off: messages coming in are refused until its settings choose an account. '
      + 'daily-digest\'s webhook stays off: its access was turned off, and scheduling does not turn it back on.',
    );
  });

  it('says nothing when no door moved', async () => {
    const quiet = await tool({ scheduleDeps: mainDishMoving([]) })(ARGS);
    const unchanged = await tool({ scheduleDeps: mainDishMoving([
      { recipe_id: 'daily-digest', state: 'unchanged', was_open: true },
    ]) })(ARGS);
    expect((quiet as { result: Record<string, unknown> }).result).not.toHaveProperty('note');
    expect((unchanged as { result: Record<string, unknown> }).result).not.toHaveProperty('note');
  });
});

describe('recipe.schedule — on the Tier-1 table', () => {
  it('is listed with a descriptor that names the two modes, and needs only the recipe and the mode', () => {
    expect(TIER1_TOOL_NAMES).toContain('recipe.schedule');
    const descriptor = TIER1_TOOL_DESCRIPTORS['recipe.schedule'];
    expect(descriptor.arg_schema).toMatchObject({
      required: ['recipe_id', 'mode'],
      properties: { mode: { enum: ['one_shot', 'recurring'] }, run_at: { format: 'date-time' } },
    });
    // No settings: a schedule runs the recipe with its own saved ones, never
    // values a model chose.
    expect(Object.keys((descriptor.arg_schema as { properties: object }).properties).sort())
      .toEqual(['cron_expression', 'dish_id', 'enabled', 'mode', 'recipe_id', 'run_at']);
    expect(TIER1_CLASSIFICATIONS['recipe.schedule']).toBe('unknown');
  });
});
