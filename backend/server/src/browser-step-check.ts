/** D-402 slice H3 (§4.2 item 3, §7.4) — before step 1, each browser a recipe names is checked by
 *  routing's own rule, and a run that one of them would stop is refused, naming the browser and what is
 *  missing, with nothing done.
 *
 *  Today the only check before step 1 is whether any Browser Bridge is connected
 *  (`packages/engine/src/preflight.ts`). A job that reads in one browser and types in another would run
 *  its first browser's steps and stop at the second's, half done. So the run's browsers are checked
 *  first: the browser each step's setting names (`recipeBrowserSteps`, the walk the dish's settings
 *  read), against the browsers paired and connected now and the sites each may act on
 *  (`BridgeDispatcher.checkBrowsers`, `browser-routing.ts`).
 *
 *  Called where the question before a run is decided (`execute-handler.ts`), so the question is never
 *  raised for a run that cannot start, and its answer, which starts the run afresh through the same
 *  path, checks them again: a browser can go while the owner reads it.
 *
 *  Slice H3b: and whether each browser's Bridge can run what its steps will ask
 *  (`browser-step-commands.ts`), by the rule each dispatch applies (`bridgeRunsCommand`).
 *
 *  ⚠ Only a step whose browser is a setting: a step that names none goes where routing sends it, which
 *  the dispatch itself refuses when it cannot. A setting holding no browser is left to routing too: a
 *  recipe written by hand may leave it empty for the only browser paired. */
import {
  browserActReadsOnly,
  parseBrowserActSteps,
  recipeBrowserSteps,
  type PreapprovalBrowsers,
  type RecipeDefinition,
  type RecipeError,
  type RunQuestionBrowser,
} from '@recued/contracts';
import { browserSiteOf } from './bridges/browser-routing.js';
import type { BrowserStepNeed, BrowserStepProblem } from './bridges/browser-routing.js';
import { browserStepCommands } from './bridges/browser-step-commands.js';

const CONFIG_REF = /^\{\{config\.([A-Za-z0-9_]+)\}\}$/u;

/** The value a setting has for this run: the run's own, else the recipe's, as the engine fills it. */
const settingOf = (recipe: RecipeDefinition, config: Readonly<Record<string, unknown>>, key: string): unknown =>
  Object.prototype.hasOwnProperty.call(config, key) ? config[key] : (recipe.variables as Record<string, unknown> | undefined)?.[key];

/** Each browser step's browser and site for this run. A site written out, or held by a setting, is
 *  known before step 1; one an earlier step gives is not, and is left to the dispatch. */
export const browserStepNeeds = (recipe: RecipeDefinition, config: Readonly<Record<string, unknown>>): BrowserStepNeed[] =>
  recipeBrowserSteps(recipe).flatMap((step) => {
    const held = settingOf(recipe, config, step.key);
    const browser_id = typeof held === 'string' ? held.trim() : '';
    if (browser_id === '') return [];
    const written = typeof step.target === 'string' ? step.target.trim() : '';
    const setting = CONFIG_REF.exec(written)?.[1];
    const resolved = setting !== undefined ? settingOf(recipe, config, setting) : written.includes('{{') ? undefined : written;
    const target = typeof resolved === 'string' && resolved.trim() !== '' ? resolved.trim() : undefined;
    // Slice H3b — what it will ask its Bridge to do, read from its steps as written.
    const commands = browserStepCommands(step.op, step.args);
    return [{ step_id: step.step_id, setting: step.key, browser_id, ...(target !== undefined ? { target } : {}),
      ...(commands !== undefined && commands.length > 0 ? { commands } : {}) }];
  });

/** The browser operations that only read. */
const READING_OPS: ReadonlySet<string> = new Set(['core.dom.read', 'core.dom.inspect', 'core.dom.tabs', 'core.dom.wait',
  'core.dom.table', 'core.dom.screenshot', 'core.dom.scroll', 'core.dom.bridges']);

/** Whether a browser step only reads: a reading operation, or an Act batch whose steps all read. */
const readsOnly = (op: string, args: Readonly<Record<string, unknown>>): boolean => {
  if (op !== 'core.dom.act') return READING_OPS.has(op);
  const parsed = parseBrowserActSteps(args.steps, { page: args.page });
  return parsed.ok && browserActReadsOnly(parsed.steps);
};

/** D-402 slice H4a (§7.5) — what a run does in each of its browsers, in the order it gets there: each by
 *  the owner's name for it, the sites it only reads there, and the sites it acts on there. For the
 *  question before a run, which says it by browser when there are several. A site it acts on is not also
 *  listed as one it reads. */
export const runBrowserWork = (
  recipe: RecipeDefinition,
  config: Readonly<Record<string, unknown>>,
  nameOf: (browser_id: string) => string | undefined,
): RunQuestionBrowser[] => {
  const needs = new Map(browserStepNeeds(recipe, config).map((need) => [need.step_id, need]));
  const work = new Map<string, { name: string; reads: string[]; acts: string[] }>();
  for (const step of recipeBrowserSteps(recipe)) {
    const need = needs.get(step.step_id);
    if (need === undefined || need.target === undefined) continue;
    const site = browserSiteOf(need.target);
    let entry = work.get(need.browser_id);
    if (entry === undefined) {
      entry = { name: nameOf(need.browser_id) ?? 'another browser', reads: [], acts: [] };
      work.set(need.browser_id, entry);
    }
    const list = readsOnly(step.op, step.args) ? entry.reads : entry.acts;
    if (!list.includes(site)) list.push(site);
  }
  return [...work.values()].map((entry) => ({ ...entry, reads: entry.reads.filter((site) => !entry.acts.includes(site)) }));
};

/** D-402 slice H4 — the browsers a run's settings name, by setting: what a caller's pre-approval holds each
 *  site's writes to (`PreapprovalBrowsers`). */
export const runBrowsersOf = (recipe: RecipeDefinition, config: Readonly<Record<string, unknown>>): PreapprovalBrowsers =>
  Object.fromEntries(browserStepNeeds(recipe, config).map((need) => [need.setting, need.browser_id]));

const sentenceOf = (problem: BrowserStepProblem): string => {
  switch (problem.problem) {
    case 'offline':
      return `“${problem.name}” is not connected: open Chrome with its Browser Bridge.`;
    case 'site':
      return `“${problem.name}” may not act on ${problem.site}: allow that site in its Browser Bridge.`;
    case 'update':
      return `“${problem.name}” has a Browser Bridge too old for this recipe${problem.version !== undefined ? ` (${problem.version})` : ''}: update it.`;
    case 'not_paired':
      // A fresh pairing is a new browser (ruling 14), so pairing it again does not bring it back.
      return `${problem.name !== undefined ? `“${problem.name}”, the browser this recipe acts in,` : 'The browser this recipe acts in'}`
        + ' is no longer paired: choose the browser to use instead in the recipe\'s settings.';
  }
};

/** What the owner reads: each browser and what it is missing, once each, then that nothing was done. */
export const browserStepRefusalMessage = (problems: readonly BrowserStepProblem[]): string =>
  `${[...new Set(problems.map(sentenceOf))].join(' ')} Nothing was done.`;

/** The run's error: the refusal, at the first step it stops, with what stopped each step for the
 *  surfaces that offer a fix (`details.browsers`). The same code the dispatch refuses with. */
export const browserStepRefusal = (recipe: RecipeDefinition, problems: readonly BrowserStepProblem[], at: Date = new Date()): RecipeError => ({
  error_id: `browsers-${at.getTime().toString(36)}`,
  code: 'ROLE_RESTRICTION',
  message: browserStepRefusalMessage(problems),
  severity: 'fatal',
  source: { recipe_id: recipe.recipe_id, step_id: problems[0]?.step_id ?? null, ingredient_slug: null },
  details: { browsers: problems.map((problem) => ({ ...problem })) },
  timestamp: at.toISOString(),
  retryable: false,
});
