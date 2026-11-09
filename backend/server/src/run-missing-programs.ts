/** D-346 A — the programs a run's steps launch that the server cannot find, read
 *  before the run starts (ruling 3).
 *
 *  A step whose program is gone stops the run there, after every step before it
 *  ran: a refusal up front means none of them does. So a run is refused, whoever
 *  starts it (by hand, a schedule, an automation, chat, MCP), naming each program
 *  and the pack whose page says how to install it.
 *
 *  - Read as the launch reads it (`cli-program-presence.ts`), never run.
 *  - Only the steps that always run. A step with `skip_when` may never run on this
 *    owner's data (pandoc for a Word file, an inbox of PDFs), so its program stays
 *    the step's to report, as before. A `stop_when` on an earlier step does not
 *    excuse a later one: "nothing to do this time" is not "it can run".
 *  - `trigger_steps` run only on an auto-run tick, so only a tick checks them.
 *  - One need per program: two catalogs launching `rg` are one install.
 *
 *  The need is the shape a step that stopped on its program has
 *  (`RunProgramNeed`, `problem: 'not_found'`), so a run surface says and links it
 *  as it does that one (`run-needs-offer.ts`). Pure: the caller reads the
 *  manifests and the files. */

import {
  cliToolFromConnectorRuntime,
  type IngredientManifest,
  type RecipeDefinition,
  type RunProgramNeed,
} from '@recued/contracts';

/** The refusal's code, and the recipe step code a recipe calling it reads. */
export const PROGRAM_NOT_INSTALLED = 'program_not_installed';

export interface MissingProgramsInput {
  /** The run's recipe with its steps resolved to catalogs. */
  recipe: RecipeDefinition;
  /** An auto-run tick, whose `trigger_steps` run before everything else. */
  autoRunTick: boolean;
  manifestOf: (catalog: string) => IngredientManifest | null | undefined;
  isPresent: (catalog: string, binary: string) => boolean;
  /** The installed pack holding the catalog, when one does. */
  packOfCatalog: (catalog: string) => string | undefined;
  /** The pack's name, as the owner sees it. */
  packNameOf: (packSlug: string) => string | undefined;
}

const conditional = (step: Readonly<Record<string, unknown>>): boolean =>
  step.skip_when !== undefined && step.skip_when !== null && step.skip_when !== '';

export const missingProgramsOf = (input: MissingProgramsInput): RunProgramNeed[] => {
  const steps = [
    ...(input.autoRunTick ? input.recipe.trigger_steps ?? [] : []),
    ...(input.recipe.prefetch_steps ?? []),
    ...(input.recipe.steps ?? []),
  ] as ReadonlyArray<Readonly<Record<string, unknown>>>;
  const out: RunProgramNeed[] = [];
  const named = new Set<string>();
  for (const step of steps) {
    if (typeof step.id !== 'string' || typeof step.ingredient !== 'string' || step.ingredient === '') continue;
    if (conditional(step)) continue;
    const catalog = step.ingredient;
    const binary = cliToolFromConnectorRuntime(input.manifestOf(catalog)?.surfaces?.connector?.runtime);
    if (binary === undefined || named.has(binary)) continue;
    if (input.isPresent(catalog, binary)) continue;
    named.add(binary);
    const pack = input.packOfCatalog(catalog);
    const label = pack === undefined ? undefined : input.packNameOf(pack);
    out.push({
      kind: 'program',
      step_id: step.id,
      problem: 'not_found',
      tool: binary,
      ...(pack !== undefined ? { pack_slug: pack } : {}),
      ...(label !== undefined ? { label } : {}),
    });
  }
  return out;
};

const listOf = (words: readonly string[]): string =>
  words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;

/** The refusal's sentence: what is missing, that nothing ran, and where it is
 *  fixed. A program keeps its case (`rg`); a pack is named by its name. */
export const missingProgramsMessage = (recipeName: string, needs: readonly RunProgramNeed[]): string => {
  const tools = needs.map((need) => need.tool ?? 'a program it uses');
  if (needs.length === 1) {
    const [need] = needs;
    const where = need?.label !== undefined ? `${need.label}’s page in Packs` : 'Its pack’s page in Packs';
    return `${tools[0]} is not installed on your server, or your server cannot find it, so ‘${recipeName}’ did not start. `
      + `${where} says what to do.`;
  }
  return `${listOf(tools)} are not installed on your server, or your server cannot find them, so ‘${recipeName}’ `
    + 'did not start. Their packs’ pages in Packs say what to do.';
};
