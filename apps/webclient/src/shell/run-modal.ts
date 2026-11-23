/** The webclient's run dialog: the shared `RunModal.wireRunModal`, told how to
 *  turn a refused run into a next step (D-321 P2).
 *
 *  ── Why a wrapper ────────────────────────────────────────────────────
 *  Seven places open the dialog (the packs route, the recipes route, the chat
 *  run palette, automation, data and two reception lenses). The pack install
 *  offer reached the pack app view and a recipe's page, and none of them, so a
 *  run refused for a missing pack or connection ended in the dialog on a bare
 *  sentence. Each of them opens it through here, and
 *  `src/__tests__/d-321-run-modal-next-step.test.ts` fails on a direct call, so a
 *  new one gets the next step without being told.
 *
 *  ── What it offers ───────────────────────────────────────────────────
 *  The same as the pages do: a missing pack links to its page to install it
 *  (`pack-install-offer.ts`), a connection not set up links to its form
 *  (`connection-setup-offer.ts`), and a run that stopped on a step offers what
 *  the step needed (`run-needs-offer.ts`). Each says what it says on those
 *  pages, so the owner reads one sentence for one problem wherever the run was
 *  started. */

import { CLI_REACHABILITY_OWNER_PRINCIPAL, type PacksToolStatusResult, type RunProgramNeed, type ServerRecipeListEntry } from '@recued/contracts';
import { RunModal } from '@recued/ui-shared';

import { recipePackRefs, type PackProvenanceRecipe } from '../recipes/recipe-pack-provenance.js';
import { programDisplayName, programStopsRuns } from '../settings/pack-programs-controls.js';

import {
  connectionSetupFromError,
  connectionSetupLead,
  connectionSetupLink,
} from './connection-setup-offer.js';
import {
  missingPacksFromError,
  packInstallOfferHref,
  packInstallOfferLead,
  packInstallOfferName,
} from './pack-install-offer.js';
import {
  programNeedStep,
  programNeedsFromError,
  runNeedsNextStep,
  runNeedsStep,
  type BrowserMove,
  type ProgramSwitchSet,
} from './run-needs-offer.js';

/** A refused run's next step, or null when the error has none. */
export const runModalNextStep = (err: unknown): RunModal.RunModalNextStep | null => {
  const packs = missingPacksFromError(err);
  if (packs !== null) {
    return {
      lead: packInstallOfferLead(packs),
      links: packs.map((ref) => ({ text: `Get ${packInstallOfferName(ref)}`, href: packInstallOfferHref(ref) })),
    };
  }
  // D-346 A — refused before it started: a program a step launches is gone.
  const programs = programNeedsFromError(err);
  if (programs !== null) return runNeedsStep(programs);
  const need = connectionSetupFromError(err);
  if (need !== null) return { lead: connectionSetupLead(need), links: [connectionSetupLink(need)] };
  return null;
};

/** D-321 C2 — `packs.tool_status` for one pack. */
export type RunModalToolStatusRead = (args: { pack_slug: string }) => Promise<PacksToolStatusResult>;

let toolStatusRead: RunModalToolStatusRead | null = null;

/** D-321 C2 — how every run dialog reads a recipe's programs before a run. Set
 *  once by the webclient's composition (`webclient-bootstrap.ts`), so the seven
 *  places that open the dialog need no caller of their own; null turns it off. */
export const setRunModalToolStatus = (read: RunModalToolStatusRead | null): void => {
  toolStatusRead = read;
};

let programSwitchSet: ProgramSwitchSet | null = null;

/** D-346 follow-up — what the dialog reads to say, before a run, that a program the recipe
 *  runs is switched off for the owner: every installed program's actions
 *  (`cli.reachability.universe`) and the switches set (`cli.reachability.list`). */
export interface RunModalProgramSwitchReads {
  readonly universe: () => Promise<{
    readonly tools: ReadonlyArray<{ readonly operations: ReadonlyArray<{ readonly catalog_slug: string; readonly operation_id: string }> }>;
  }>;
  /** The recipe whole (`recipe.get` → its definition): a `recipe.list` row carries no steps,
   *  and the steps are what name the program's actions (live, 2026-11-08: the dialog opened
   *  from a list row said nothing before the run for that reason). Absent ⇒ only a recipe that
   *  carries its steps is checked. */
  readonly recipeBody?: (recipe_id: string) => Promise<unknown>;
  readonly list: () => Promise<{
    readonly rows: ReadonlyArray<{ readonly principal: string; readonly ingredient_id: string; readonly operation_id: string; readonly allowed: boolean }>;
  }>;
}

let programSwitchReads: RunModalProgramSwitchReads | null = null;

/** Set once by the webclient's composition, beside `setRunModalProgramSwitch`; null leaves
 *  the dialog saying, before a run, only what is missing. */
export const setRunModalProgramSwitchReads = (reads: RunModalProgramSwitchReads | null): void => {
  programSwitchReads = reads;
};

/** The pack actions a recipe's steps name in the op form (`<publisher>.<pack>.<key>`, a key
 *  may hold dots), and the catalog actions it names directly (`ingredient` + its
 *  `input.operation`). */
export const recipeStepActions = (
  recipe: unknown,
): Array<{ readonly pack?: string; readonly catalog?: string; readonly key: string }> => {
  const out: Array<{ pack?: string; catalog?: string; key: string }> = [];
  const r = recipe as Record<string, unknown> | null;
  if (r === null || typeof r !== 'object') return out;
  for (const list of [r.prefetch_steps, r.steps, r.trigger_steps]) {
    for (const step of Array.isArray(list) ? list : []) {
      if (step === null || typeof step !== 'object') continue;
      const { op, ingredient, input } = step as { op?: unknown; ingredient?: unknown; input?: { operation?: unknown } };
      if (typeof op === 'string') {
        const parts = op.split('.');
        if (parts.length >= 3) out.push({ pack: parts[1]!, key: parts.slice(2).join('.') });
      } else if (typeof ingredient === 'string' && typeof input?.operation === 'string') {
        out.push({ catalog: ingredient, key: input.operation });
      }
    }
  }
  return out;
};

/** D-346 follow-up (2026-11-08) — how every run dialog turns on a program switched off
 *  for the owner ("Turn it on"). Set once by the webclient's composition, like
 *  `setRunModalToolStatus`; null leaves the dialog linking to the pack instead. */
export const setRunModalProgramSwitch = (set: ProgramSwitchSet | null): void => {
  programSwitchSet = set;
};

let browserMove: BrowserMove | null = null;

/** D-402 slice H3c (ruling 14) — how every run dialog moves a dish's settings off a browser no longer
 *  paired, or not connected, to the only other one connected ("Use “Work” instead", `dishes.use_browser`).
 *  Set once by the webclient's composition; null turns it off. */
export const setRunModalBrowserMove = (move: BrowserMove | null): void => {
  browserMove = move;
};

const PROGRAM_PROBLEM: Readonly<Record<string, RunProgramNeed['problem']>> = {
  missing: 'not_found',
  broken: 'broken',
  untested: 'untested_version',
  unreadable: 'untested_version',
};

/** D-321 C2 — a program the recipe's packs run that would stop it, said before
 *  the run: missing, failing to start, or at a version its pack refuses (one under
 *  Warn runs, so it is not said). Null when every one is ready or nothing can be
 *  read. */
export const programsBeforeRun = async (
  recipe: Pick<ServerRecipeListEntry, 'recipe'>,
  read: RunModalToolStatusRead,
  /** D-346 follow-up — with these, a program switched off for the owner is said too, and
   *  turned on from the dialog ("Turn it on"). */
  switches?: { readonly reads: RunModalProgramSwitchReads; readonly set?: ProgramSwitchSet },
): Promise<RunModal.RunModalNextStep | null> => {
  const packs = [...new Set(recipePackRefs(recipe.recipe as PackProvenanceRecipe).map((ref) => ref.pack))].slice(0, 4);
  if (packs.length === 0) return null;
  const results = await Promise.all(packs.map((pack_slug) => read({ pack_slug }).catch(() => null)));
  const entries = results.flatMap((result) => result?.packs ?? []);
  const steps = entries.flatMap((entry) => entry.tools
    .filter(programStopsRuns)
    .map((tool) => programNeedStep({
      problem: PROGRAM_PROBLEM[tool.state] ?? 'not_found',
      tool: programDisplayName(tool.binary),
      pack_slug: entry.slug,
    })));
  const off = switches === undefined ? [] : await switchedOffActions(recipe.recipe, entries, switches.reads);
  if (steps.length === 0 && off.length === 0) return null;
  const links = new Map(steps.flatMap((step) => (step.link === null ? [] : [[step.link.href, step.link] as const])));
  const leads = [
    ...new Set(steps.map((step) => step.lead)),
    ...new Set(off.map((action) => `${action.program} is switched off for you, so a run would stop there.`)),
  ];
  const turnOn = switches?.set;
  return {
    lead: leads.join(' '),
    links: [...links.values()],
    ...(turnOn !== undefined && off.length > 0
      ? {
          action: {
            text: off.length === 1 ? 'Turn it on' : 'Turn them on',
            run: async () => {
              for (const action of off) await turnOn({ ingredient_id: action.catalog, operation_id: action.key });
            },
            // Said in place of what was off, so it names what is on.
            done: `${[...new Set(off.map((action) => action.program))].join(', ')} ${
              new Set(off.map((action) => action.program)).size === 1 ? 'is' : 'are'} on now.`,
          },
        }
      : {}),
  };
};

/** The recipe as its steps name its actions: a `recipe.list` row carries none, so it is read
 *  whole when the reads can (`recipeBody`). */
const withSteps = async (recipe: unknown, reads: RunModalProgramSwitchReads): Promise<unknown> => {
  const r = recipe as { steps?: unknown; prefetch_steps?: unknown; recipe_id?: unknown } | null;
  if (r === null || typeof r !== 'object') return recipe;
  if (Array.isArray(r.steps) || Array.isArray(r.prefetch_steps)) return recipe;
  if (reads.recipeBody === undefined || typeof r.recipe_id !== 'string') return recipe;
  return (await reads.recipeBody(r.recipe_id)) ?? recipe;
};

/** The recipe's program actions switched off for the owner: each action a step names, on a
 *  program of the recipe's packs, with no switch set on for the owner. Nothing when either
 *  read fails: the run then says it, as before. */
const switchedOffActions = async (
  recipe: unknown,
  entries: PacksToolStatusResult['packs'],
  reads: RunModalProgramSwitchReads,
): Promise<Array<{ catalog: string; key: string; program: string }>> => {
  let universe: Awaited<ReturnType<RunModalProgramSwitchReads['universe']>>;
  let list: Awaited<ReturnType<RunModalProgramSwitchReads['list']>>;
  let named: unknown;
  try {
    [universe, list, named] = await Promise.all([reads.universe(), reads.list(), withSteps(recipe, reads)]);
  } catch {
    return [];
  }
  const actionsOf = new Map<string, Set<string>>();
  for (const tool of universe.tools) {
    for (const op of tool.operations) {
      if (!actionsOf.has(op.catalog_slug)) actionsOf.set(op.catalog_slug, new Set());
      actionsOf.get(op.catalog_slug)!.add(op.operation_id);
    }
  }
  const on = new Set(list.rows
    .filter((row) => row.principal === CLI_REACHABILITY_OWNER_PRINCIPAL && row.allowed)
    .map((row) => `${row.ingredient_id}\u0000${row.operation_id}`));
  const programOf = new Map(entries.flatMap((entry) => entry.tools.map((tool) => [tool.catalog, { pack: entry.slug, program: programDisplayName(tool.binary) }] as const)));
  const out = new Map<string, { catalog: string; key: string; program: string }>();
  for (const action of recipeStepActions(named)) {
    const catalogs = action.catalog !== undefined
      ? [action.catalog]
      : [...programOf.entries()].filter(([, owner]) => owner.pack === action.pack).map(([catalog]) => catalog);
    for (const catalog of catalogs) {
      const owner = programOf.get(catalog);
      if (owner === undefined || actionsOf.get(catalog)?.has(action.key) !== true) continue;
      if (on.has(`${catalog}\u0000${action.key}`)) continue;
      out.set(`${catalog}\u0000${action.key}`, { catalog, key: action.key, program: owner.program });
    }
  }
  return [...out.values()];
};

/** Open the run dialog. A host's own `nextStepFor` / `nextStepForResult` /
 *  `beforeRun` wins. A run that returned errors offers what its step needed
 *  (`run-needs-offer.ts`), and a program that would stop it is said before it. */
export const wireRunModal = (opts: RunModal.WireRunModalOptions): RunModal.RunModalHandle => {
  const read = toolStatusRead;
  const turnOn = programSwitchSet;
  const switchReads = programSwitchReads;
  const move = browserMove;
  return RunModal.wireRunModal({
    nextStepFor: runModalNextStep,
    nextStepForResult: (result) => runNeedsNextStep(result, turnOn ?? undefined, move ?? undefined),
    ...(read !== null
      ? {
          beforeRun: () => programsBeforeRun(opts.recipe, read, switchReads === null ? undefined : {
            reads: switchReads,
            ...(turnOn !== null ? { set: turnOn } : {}),
          }),
        }
      : {}),
    ...opts,
  });
};
