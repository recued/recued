/** D-321 P2 / C2 — what a step that failed needed and did not have
 *  (`ServerExecuteResponse.run_needs`, contracts `run-needs.ts`).
 *
 *  A step's error names neither its pack nor its connection: a vendor's 401
 *  reads "exa-catalog returned 401 Unauthorized", a missing program names its
 *  op. The run knows both. Its resolved recipe gives each step's catalog; the
 *  run's slots give the catalog's sign-in and the connection it settled on; the
 *  bindings and the installed packs give the pack. So the server names them, and
 *  a run surface links to the fix: the connection to reconnect or set up, or the
 *  pack whose page says how to install the program.
 *
 *  Read from the error, in this order:
 *  - a program: the step error's `cli_failure` carrier (`reason`), else its code
 *    for the two a code alone tells apart (a prefetch step keeps no carrier).
 *    One that ran and failed needs nothing set up, so it is not a need;
 *  - a program switched off for the owner: the gateway's `program_switch` carrier
 *    (D-346 follow-up), which the run dialog turns on in one click;
 *  - a connection: `OAUTH_EXPIRED` (the service did not accept the sign-in), or
 *    the gateway's `no_connection_profile` deny, which ends its sentence with the
 *    reason in parentheses (`catalog-gateway.ts` `denyError`, pinned by
 *    `d-182-cli-reachability-gate.test.ts`). A step whose catalog signs in
 *    through none of the run's slots names no need.
 *
 *  Pure: the caller reads the stores. */

import {
  RUN_PROGRAM_NEED_PROBLEMS,
  isCliFailureDetail,
  isProgramSwitchDetail,
  type CliFailureDetail,
  type RecipeDefinition,
  type RunNeed,
  type RunProgramNeed,
} from '@recued/contracts';

import type { ConnectionUsed, RunConnectionSlot } from './run-connection-choice.js';

/** Each step's catalog (`ingredient`), by step id: prefetch, steps and trigger
 *  steps of the run's resolved recipe. A step that names no catalog is absent. */
export const stepCatalogs = (recipe: RecipeDefinition): Map<string, string> => {
  const out = new Map<string, string>();
  const steps = [
    ...(recipe.prefetch_steps ?? []),
    ...(recipe.steps ?? []),
    ...(recipe.trigger_steps ?? []),
  ] as ReadonlyArray<Readonly<Record<string, unknown>>>;
  for (const step of steps) {
    if (typeof step.id === 'string' && typeof step.ingredient === 'string' && step.ingredient.length > 0) {
      out.set(step.id, step.ingredient);
    }
  }
  return out;
};

const PROGRAM_PROBLEMS: ReadonlySet<string> = new Set(RUN_PROGRAM_NEED_PROBLEMS);

/** A program problem a code alone names, for an error that kept no carrier. */
const PROGRAM_PROBLEM_BY_CODE: Readonly<Record<string, RunProgramNeed['problem']>> = {
  CLI_TOOL_NOT_FOUND: 'not_found',
  CLI_TOOL_VERSION_UNTESTED: 'untested_version',
};

/** The gateway's deny sentence ends with its reason (`denyError`). */
const NO_CONNECTION_PROFILE = /\(no_connection_profile\)$/;

export interface RunNeedsInput {
  /** The run's errors (`RecipeError`s), as the engine returned them. */
  errors: readonly unknown[];
  /** The recipe as the run ran it: dispatch-resolved, so each step names its catalog. */
  recipe: RecipeDefinition;
  /** The run's slots and the catalogs signing in through each. */
  slots: readonly RunConnectionSlot[];
  /** The connection each slot settled on, and each one a followed call used. */
  used: readonly ConnectionUsed[];
  /** The bindings the run read for its catalogs. */
  bindings: readonly { connection_name: string; catalog_slug: string; installed_pack_id?: string }[];
  /** The installed pack a catalog belongs to, when no binding names it. */
  packOfCatalog: (catalog: string) => string | undefined;
  /** The vendor a pack's requirement names, and what to call the sign-in. */
  signInOf: (pack_slug: string, slot: string) => { vendor?: string; label: string };
  /** A pack's name. */
  packNameOf: (pack_slug: string) => string | undefined;
  /** D-402 slice H3c — for a run its browsers refused before step 1: the dish whose settings it used,
   *  the browsers its settings name (never offered in place of another: a recipe that reads in one browser
   *  and types in another must not end up doing both in one), and the browsers connected now. */
  browsers?: {
    readonly dish_id?: string;
    readonly named: ReadonlySet<string>;
    readonly connected: () => ReadonlyArray<{ readonly browser_id: string; readonly name: string }>;
  };
}

/** A browser the check before step 1 found gone or not connected (`details.browsers`). */
const browserProblemOf = (value: unknown): { step_id: string; problem: 'not_paired' | 'offline'; setting: string;
  browser_id: string; name?: string } | undefined => {
  if (value === null || typeof value !== 'object') return undefined;
  const one = value as { step_id?: unknown; problem?: unknown; setting?: unknown; browser_id?: unknown; name?: unknown };
  if ((one.problem !== 'not_paired' && one.problem !== 'offline') || typeof one.step_id !== 'string'
    || typeof one.setting !== 'string' || typeof one.browser_id !== 'string') return undefined;
  return { step_id: one.step_id, problem: one.problem, setting: one.setting, browser_id: one.browser_id,
    ...(typeof one.name === 'string' && one.name !== '' ? { name: one.name } : {}) };
};

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined;

const programProblem = (
  code: unknown,
  cli: CliFailureDetail | undefined,
): RunProgramNeed['problem'] | undefined => {
  if (cli !== undefined) {
    // D-346 § 9 — a folder or file the run named that is not there: the program is
    // fine, and its pack's page cannot fix the run's input. The step's error names
    // the path. It offered "could not be started … Its pack’s page shows what to
    // do" (found live).
    if (typeof cli.path === 'string') return undefined;
    return PROGRAM_PROBLEMS.has(cli.reason) ? cli.reason as RunProgramNeed['problem'] : undefined;
  }
  return typeof code === 'string' ? PROGRAM_PROBLEM_BY_CODE[code] : undefined;
};

/** What the run's failed steps needed, one per program or sign-in and problem,
 *  in the order the errors came. */
export const runNeedsOf = (input: RunNeedsInput): RunNeed[] => {
  const catalogs = stepCatalogs(input.recipe);
  const out: RunNeed[] = [];
  const seen = new Set<string>();
  const add = (key: string, need: RunNeed): void => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(need);
  };
  for (const raw of input.errors) {
    if (raw === null || typeof raw !== 'object') continue;
    const error = raw as {
      code?: unknown;
      message?: unknown;
      source?: { step_id?: unknown } | null;
      details?: unknown;
    };
    const step_id = text(error.source?.step_id);
    if (step_id === undefined) continue;
    const catalog = catalogs.get(step_id);

    // D-346 follow-up (2026-11-08) — a program switched off for the owner: the switch the
    // run dialog turns on ("Turn it on"), read from the gateway's carrier, never the message.
    const switched = error.details !== null && typeof error.details === 'object'
      ? (error.details as { program_switch?: unknown }).program_switch
      : undefined;
    if (isProgramSwitchDetail(switched)) {
      const pack_slug = input.packOfCatalog(switched.ingredient_id);
      const label = pack_slug === undefined ? undefined : input.packNameOf(pack_slug);
      add(`switch\u0000${switched.ingredient_id}\u0000${switched.operation_id}`, {
        kind: 'switch',
        step_id,
        ingredient_id: switched.ingredient_id,
        operation_id: switched.operation_id,
        ...(pack_slug !== undefined ? { pack_slug } : {}),
        ...(label !== undefined ? { label } : {}),
      });
      continue;
    }

    // D-402 slice H3c (ruling 14) — a browser the run's settings name, gone or not connected: the dish's
    // settings can move to another, "Use this browser instead". Read from the refusal's carrier, never
    // its message. The one browser to offer is the only one connected that the run does not already name.
    const refused = error.code === 'ROLE_RESTRICTION' && error.details !== null && typeof error.details === 'object'
      ? (error.details as { browsers?: unknown }).browsers
      : undefined;
    if (Array.isArray(refused)) {
      const offer = (input.browsers?.connected() ?? []).filter((browser) => !input.browsers!.named.has(browser.browser_id));
      for (const raw of refused) {
        const one = browserProblemOf(raw);
        if (one === undefined) continue;
        add(`browser\u0000${one.setting}\u0000${one.browser_id}`, {
          kind: 'browser',
          ...one,
          ...(input.browsers?.dish_id !== undefined ? { dish_id: input.browsers.dish_id } : {}),
          ...(offer.length === 1 ? { instead: { browser_id: offer[0]!.browser_id, name: offer[0]!.name } } : {}),
        });
      }
      continue;
    }

    const carrier = error.details !== null && typeof error.details === 'object'
      ? (error.details as { cli_failure?: unknown }).cli_failure
      : undefined;
    const cli = isCliFailureDetail(carrier) ? carrier : undefined;
    const program = programProblem(error.code, cli);
    if (program !== undefined) {
      const pack_slug = catalog === undefined ? undefined : input.packOfCatalog(catalog);
      const label = pack_slug === undefined ? undefined : input.packNameOf(pack_slug);
      const tool = text(cli?.tool);
      add(`program\u0000${pack_slug ?? tool ?? step_id}\u0000${program}`, {
        kind: 'program',
        step_id,
        problem: program,
        ...(tool !== undefined ? { tool } : {}),
        ...(pack_slug !== undefined ? { pack_slug } : {}),
        ...(label !== undefined ? { label } : {}),
      });
      continue;
    }

    const problem = error.code === 'OAUTH_EXPIRED'
      ? 'reconnect' as const
      : error.code === 'NOT_AUTHORIZED' && typeof error.message === 'string'
        && NO_CONNECTION_PROFILE.test(error.message.trim())
        ? 'set_up' as const
        : undefined;
    if (problem === undefined || catalog === undefined) continue;
    const slot = input.slots.find((candidate) => candidate.catalogs.includes(catalog));
    if (slot === undefined) continue;
    const names = [...new Set(input.used.filter((used) => used.slot === slot.slot).map((used) => used.connection_name))];
    const connection_name = names.length === 1 ? names[0] : undefined;
    const bound = (binding: RunNeedsInput['bindings'][number]): boolean =>
      binding.catalog_slug === catalog && text(binding.installed_pack_id) !== undefined;
    const pack_slug = input.bindings.find((binding) => bound(binding) && binding.connection_name === connection_name)
      ?.installed_pack_id
      ?? input.bindings.find(bound)?.installed_pack_id
      ?? input.packOfCatalog(catalog);
    const signIn = pack_slug === undefined ? undefined : input.signInOf(pack_slug, slot.slot);
    add(`connection\u0000${slot.slot}\u0000${connection_name ?? ''}\u0000${problem}`, {
      kind: 'connection',
      step_id,
      problem,
      slot: slot.slot,
      ...(connection_name !== undefined ? { connection_name } : {}),
      ...(pack_slug !== undefined ? { pack_slug } : {}),
      ...(signIn?.vendor !== undefined ? { vendor: signIn.vendor } : {}),
      ...(signIn !== undefined ? { label: signIn.label } : {}),
    });
  }
  return out;
};
