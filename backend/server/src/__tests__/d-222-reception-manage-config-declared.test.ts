/** D-222 Slice A audit fold — the manage-door reschedule runner's config must be
 *  DECLARED by the recipe it dispatches.
 *
 *  D-222 Slice A made `config` declaration-bounded at the execute boundary: a key
 *  absent from `recipe.variables` refuses the whole run as
 *  `undeclared_config_argument` (400). `reception-manage-runner` was sending
 *  `calendar_slug`, which `reschedule-booking-managed` has never declared and
 *  never read — the recipe addresses the booking by `{{config.booking_id}}` alone.
 *  So every visitor "manage my booking → reschedule" submit refused, on the one
 *  flow that runner exists to serve.
 *
 *  ⛔ WHY NOTHING WAS RED. No test reached this composition at all.
 *  `d-210-reschedule-booking-managed-exec` drives `executeRecipe` directly with a
 *  hand-built three-key config; `d-210-reception-manage-handler` stubs the runner
 *  and only records its `RunInput`. `handleExecute` was never reached from this
 *  runner, so the config it actually sends was asserted nowhere.
 *
 *  This file closes that: it drives the REAL runner and checks the config it
 *  builds against the REAL shipped recipe's declarations, using the REAL rule.
 *  Both sides are loaded, not fixtured — so a drift on either side fails here
 *  rather than at a visitor's browser. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  undeclaredConfigArguments,
  type RecipeDefinition,
} from '@recued/contracts';

const handleExecuteMock = vi.hoisted(() => vi.fn());

vi.mock('../execute-handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../execute-handler.js')>();
  return { ...actual, handleExecute: handleExecuteMock };
});

// Imported AFTER the hoisted `vi.mock` so the runner binds the mock.
import {
  createReceptionManageRescheduleRunner,
  RECEPTION_MANAGE_RESCHEDULE_RECIPE_ID,
  type ReceptionManageRunnerDeps,
} from '../reception-manage-runner.js';

/** The recipe as SHIPPED — the same authored file the bundled foundation is
 *  generated from, not a fixture that could agree with a broken runner. */
const RECIPE: RecipeDefinition = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../../community/recipes/reschedule-booking-managed.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as RecipeDefinition;

const CONTRACT_ID = 'contract-manage-door';

const makeDeps = (): ReceptionManageRunnerDeps => ({
  executeDeps: {} as ReceptionManageRunnerDeps['executeDeps'],
  definitionStore: {
    get: () => ({
      contract_id: CONTRACT_ID,
      scope: { ingredient_ids: ['booking-update'] },
    }),
  } as unknown as ReceptionManageRunnerDeps['definitionStore'],
  resolveContractId: () => CONTRACT_ID,
  now: () => 1_700_000_000_000,
});

const INPUT = {
  calendar_slug: 'local',
  booking_id: 'bk-1',
  new_start_at: 1_700_003_600_000,
  new_end_at: 1_700_007_200_000,
  credential_id: 'cred-1',
};

const dispatchedConfig = async (): Promise<Record<string, unknown>> => {
  handleExecuteMock.mockResolvedValue({ success: true, errors: [] });
  await createReceptionManageRescheduleRunner(makeDeps()).run(INPUT);
  expect(handleExecuteMock).toHaveBeenCalledTimes(1);
  const request = handleExecuteMock.mock.calls[0]![1] as {
    recipe_id: string;
    config?: Record<string, unknown>;
  };
  expect(request.recipe_id).toBe(RECEPTION_MANAGE_RESCHEDULE_RECIPE_ID);
  return request.config ?? {};
};

describe('D-222 Slice A — reception manage reschedule config is declaration-bounded', () => {
  beforeEach(() => {
    handleExecuteMock.mockReset();
  });

  it('sends no config key the shipped recipe does not declare', async () => {
    const config = await dispatchedConfig();
    // The real rule, not a re-derivation of it. `wireKeys` = every key, because
    // the runner supplies them all directly on the request.
    const undeclared = undeclaredConfigArguments(
      RECIPE.variables,
      config,
      new Set(Object.keys(config)),
    );
    expect(
      undeclared,
      `handleExecute would refuse this run as undeclared_config_argument (400). `
        + `Declared: ${JSON.stringify(Object.keys(RECIPE.variables ?? {}))}; `
        + `sent: ${JSON.stringify(Object.keys(config))}`,
    ).toEqual([]);
  });

  // The positive half: an empty config would also satisfy the rule above, so
  // assert the recipe still RECEIVES what it reads. Otherwise "fix by deleting
  // keys" would pass while the reschedule silently moved nothing.
  it('still sends every key the recipe actually reads', async () => {
    const config = await dispatchedConfig();
    expect(config).toEqual({
      booking_id: INPUT.booking_id,
      new_start_at: INPUT.new_start_at,
      new_end_at: INPUT.new_end_at,
    });
  });

  // Guards the specific regression, and names it, so a re-add is legible rather
  // than looking like an unrelated 400 at a visitor's browser.
  it('does not send calendar_slug — server-resolved scoping, not a recipe argument', async () => {
    const config = await dispatchedConfig();
    expect(Object.prototype.hasOwnProperty.call(config, 'calendar_slug')).toBe(false);
    // ...and the premise it rests on: the recipe never declared or read it.
    expect(Object.keys(RECIPE.variables ?? {})).not.toContain('calendar_slug');
    expect(JSON.stringify(RECIPE)).not.toContain('config.calendar_slug');
  });
});
