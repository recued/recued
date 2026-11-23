/** D-402 slice F3 (§7.4) — the question before a run: whether a run is held before its first step to
 *  ask the owner one question about the whole run, what it asks, and its ask.
 *
 *  Which runs get it: a fresh, top-level run of an installed recipe that the owner's chat (in the app
 *  or a messenger) or an AI app started. Never a kernel recipe (`metadata.author` `recued`), the
 *  Browser Toolkit pack's own recipes (whose writes keep their own asks, site answers and the chat's
 *  switch), a run another runs, a resumed run, one D-261 prepared, a trial, or a schedule's or a
 *  trigger's (their source names no caller).
 *
 *  When it is raised: only when a step that a pre-approval can stand in for would ask (the classifier,
 *  `classifyRecipeAsks`: `ahead`) and nothing covers it already: a live "Always" this caller holds for
 *  this version, or, for a browser action, the chat's switch. Steps nothing can cover (`still`) are
 *  listed as "will still ask" and never raise it by themselves.
 *
 *  The hold is the host's ordinary approval hold (checkpoint, anchor, receipt, the chat's wait, an AI
 *  app's action reference), marked `Checkpoint.run_question`: the engine never ran, its `gated_step_id`
 *  only names where the run begins, and the answer starts the run afresh under the same `run_id`
 *  (`preflight-resumer.ts`), never as a resume that would let step 1's call past its own ask. */

import {
  browserPassSiteOf,
  isBrowserActionSlug,
  isRunQuestionAnswer,
  RUN_QUESTION_ALWAYS,
  RUN_QUESTION_ASK_KIND,
  RUN_QUESTION_EACH_STEP,
  RUN_QUESTION_NO,
  RUN_QUESTION_ONCE,
  runQuestionLine,
  samePreapprovalCaller,
  samePreapprovalBrowsers,
  samePreapprovalNested,
  callerPreapprovalCovers,
  type PreapprovalBrowsers,
  type RunQuestionBrowser,
  runQuestionFirstBlock,
  runQuestionOptions,
  runQuestionText,
  runQuestionTitle,
  type Checkpoint,
  type ExecutionSource,
  type PreapprovalCaller,
  type RecipeDefinition,
  type RecipeError,
  type RunQuestion,
  type RunQuestionAnswer,
  type RunQuestionHold,
  type RunQuestionStill,
  type RunQuestionWrite,
} from '@recued/contracts';
import type { PreflightNotifier, PreflightResumer } from '@recued/gateway';
import type { CheckpointStore } from '@recued/storage';

import { classifyRecipeAsks, RECIPE_STILL_ASKS_SAID, type RecipeAskLookups, type RecipeStepAsk } from './recipe-asks-owner.js';
import type { TriggerPreapprovalStore } from './storage/trigger-preapproval-store.js';
import { recipeStepOpLabels, recipeStepOps, type TriggerPreapprovalOpDeps } from './trigger-preapproval-ops.js';
import { triggerPreapprovalRecipeSha256 } from './trigger-preapproval-rpc.js';

/** The Browser Toolkit pack, whose own recipes never get the question. */
export const BROWSER_TOOLKIT_PACK_SLUG = 'browser-toolkit';

/** A step whose action no word names before the run: one not readable before it runs. */
const UNNAMED_STEP = 'A step whose action is only known when it runs';

export interface RunQuestionPlanInput {
  readonly recipe: RecipeDefinition;
  readonly recipe_sha256: string;
  readonly caller: PreapprovalCaller | undefined;
  /** D-402 slice H4 — the browsers the run's settings name, by setting: a standing "Always" granted for
   *  others does not stand, and an answer's pre-approval records these. */
  readonly browsers?: PreapprovalBrowsers;
  /** D-402 slice H4a (§7.5) — what the run does in each of its browsers, for a recipe that uses several
   *  (`runBrowserWork`): the question says what it reads in each, and what crosses. */
  readonly browserWork?: readonly RunQuestionBrowser[];
  /** D-402 slice H4a (§4.2 item 4) — the name of the browser a step of this recipe acts in, for a recipe
   *  that uses several: each action's line names it ("act in Home on b.example"). */
  readonly browserOfStep?: (step_id: string) => string | undefined;
  /** The run is of an installed recipe, by its id (not one the caller sent whole). */
  readonly installed: boolean;
  /** The pack the installed recipe came with, or null for the owner's own. */
  readonly pack_slug: string | null | undefined;
  /** Why it is not a fresh top-level run, when it is not: an answered question, a resume, D-261, a
   *  trial, a run another runs. */
  readonly not_fresh: boolean;
  readonly source: ExecutionSource;
  readonly lookups: RecipeAskLookups;
  readonly opDeps: TriggerPreapprovalOpDeps;
  readonly store: Pick<TriggerPreapprovalStore, 'listCallers'>;
  /** The chat's "Don't ask about browser actions" switch is on for this conversation. */
  readonly browserSwitchOn: boolean;
  /** F3b — whether something the owner already granted would let this step through without asking:
   *  "Allow in this chat" (a session grant naming its op), or a site pass for a browser step's site.
   *  Absent: nothing else covers. */
  readonly coveredBy?: (ask: RecipeStepAsk, where: { readonly site?: string }) => boolean;
  /** An AI app's name, as the question says who asked. */
  readonly appName?: string;
}

/** A step's site, for a browser action: its `target`'s host. */
const siteOf = (step: Record<string, unknown> | undefined): string | undefined => {
  const call = step === undefined ? undefined
    : (step.args ?? step.input) as Record<string, unknown> | undefined;
  const target = typeof call?.target === 'string' ? call.target : undefined;
  if (target === undefined || target.includes('{{')) return undefined;
  const host = /^[a-z*]+:\/\/([^/]+)/iu.exec(target)?.[1];
  return host !== undefined && host !== '*' && !host.startsWith('*.') ? host.replace(/^\*\./u, '') : undefined;
};

/** A browser step's site as a pass names one (an origin), when its `target` names one origin. */
const passSiteOf = (step: Record<string, unknown> | undefined): string | undefined => {
  const call = step === undefined ? undefined : (step.args ?? step.input) as Record<string, unknown> | undefined;
  const target = typeof call?.target === 'string' ? call.target : undefined;
  if (target === undefined || target.includes('{{') || !/^https?:\/\/[^*/]+\//iu.test(target)) return undefined;
  return browserPassSiteOf(target.replace(/\*$/u, ''));
};

/** Each step of a recipe by its id, the recipe's own and those of a recipe it runs, keyed by both. */
const stepsById = (recipe: RecipeDefinition): Map<string, Record<string, unknown>> => {
  const steps = new Map<string, Record<string, unknown>>();
  for (const where of ['trigger_steps', 'prefetch_steps', 'steps'] as const) {
    for (const step of (recipe[where] ?? []) as unknown[]) {
      const record = step as Record<string, unknown>;
      if (typeof record?.id === 'string') steps.set(record.id, record);
    }
  }
  return steps;
};

/** D-402 slice D5 (ruling 11) — the most items a list a step names can hold, as the recipe bounds it:
 *  a cut (`slice` with a written `end`, which no caller's setting changes), a collect's `max_items`
 *  (the records of an Act call's one collect), or a list written in the recipe (D5c), through any
 *  `filter` or `map` of these. Undefined: nothing the recipe writes bounds it. */
const boundOf = (ref: unknown, steps: Map<string, Record<string, unknown>>, depth = 0): number | undefined => {
  const match = typeof ref === 'string' && depth < 8 ? /^\{\{\s*step\.([\w-]+)((?:\.[\w-]+)*)\s*\}\}$/u.exec(ref) : null;
  const source = match !== null ? steps.get(match[1]!) : undefined;
  if (match === null || source === undefined) return undefined;
  const path = match[2]!;
  if (path === '' && source.transform === 'slice') {
    const start = source.start === undefined ? 0 : source.start;
    return typeof start === 'number' && typeof source.end === 'number' && source.end > start ? source.end - start : undefined;
  }
  if (path === '' && (source.transform === 'filter' || source.transform === 'map')) {
    // A list written in the recipe holds what it holds (D5c's pages); any other, what bounds its source.
    return Array.isArray(source.array) ? (source.array.length > 0 ? source.array.length : undefined) : boundOf(source.array, steps, depth + 1);
  }
  // An Act call as the recipe writes it (`core.dom.act`), or as a run has it lowered (`dom-act`).
  const acts = source.op === 'core.dom.act' || source.ingredient === 'dom-act'
    ? ((source.args ?? source.input) as { steps?: unknown } | undefined)?.steps : undefined;
  if (Array.isArray(acts) && /^\.tabs\.0\.reads\.\d+\.collection\.records$/u.test(path)) {
    const collects = acts.filter((act) => (act as { do?: unknown } | null)?.do === 'collect') as Array<{ max_items?: unknown }>;
    return collects.length === 1 && typeof collects[0]!.max_items === 'number' ? collects[0]!.max_items : undefined;
  }
  return undefined;
};

/** The question's lines for the steps that ask, in the owner's words: what each does (as D-341's page
 *  names it), a browser action by its site, the same line once with its count. D-402 slice D5 — a
 *  step run for each item of a list counts the most its list can hold, as "up to". */
const linesOf = (
  asks: readonly RecipeStepAsk[],
  recipe: RecipeDefinition,
  input: Pick<RunQuestionPlanInput, 'opDeps' | 'lookups' | 'browserOfStep'>,
): { covers: RunQuestionWrite[]; still: RunQuestionStill[] } => {
  const byRecipe = new Map<string, { ops: Map<string, string>; labels: Map<string, string>; steps: Map<string, Record<string, unknown>> }>();
  const lookup = (recipe_id: string) => {
    let known = byRecipe.get(recipe_id);
    if (known !== undefined) return known;
    const of = recipe_id === recipe.recipe_id ? recipe : input.lookups.recipeOf?.(recipe_id) ?? undefined;
    known = of === undefined ? { ops: new Map(), labels: new Map(), steps: new Map() }
      : { ops: recipeStepOps(of, input.opDeps), labels: recipeStepOpLabels(of, input.opDeps), steps: stepsById(of) };
    byRecipe.set(recipe_id, known);
    return known;
  };
  const tally = new Map<string, { write: RunQuestionWrite & { reason?: string }; count: number; bounded: boolean }>();
  for (const ask of asks) {
    if (ask.verdict === 'never') continue;
    const known = lookup(ask.recipe_id);
    const browser = ask.slug !== undefined && isBrowserActionSlug(ask.slug);
    const op = known.ops.get(ask.step_id) ?? ask.operation_id ?? ask.slug;
    // D-402 slice H4a — in the browser it acts in, by name, when the recipe uses several.
    const browserName = browser && ask.recipe_id === recipe.recipe_id ? input.browserOfStep?.(ask.step_id) : undefined;
    const label = browser ? (browserName !== undefined ? `Act in ${browserName}` : 'Act in your browser')
      : op !== undefined ? known.labels.get(op) ?? UNNAMED_STEP : UNNAMED_STEP;
    const step = known.steps.get(ask.step_id);
    const site = browser ? siteOf(step) : undefined;
    const write: RunQuestionWrite & { reason?: string } = { label, ...(site !== undefined ? { where: `on ${site}` } : {}),
      ...(ask.verdict === 'still' && ask.reason !== undefined ? { reason: RECIPE_STILL_ASKS_SAID[ask.reason] } : {}) };
    const bound = step?.foreach !== undefined ? boundOf(step.foreach, known.steps) : undefined;
    const key = JSON.stringify([ask.verdict, write.label, write.where ?? '']);
    const kept = tally.get(key);
    if (kept !== undefined) {
      kept.count += bound ?? 1;
      kept.bounded ||= bound !== undefined;
    } else tally.set(key, { write, count: bound ?? 1, bounded: bound !== undefined });
  }
  const covers: RunQuestionWrite[] = [];
  const still: RunQuestionStill[] = [];
  for (const [key, { write, count, bounded }] of tally) {
    const counted = bounded ? { ...write, times: { up_to: count } } : count > 1 ? { ...write, times: { exactly: count } } : write;
    if (JSON.parse(key)[0] === 'still') still.push({ ...counted, reason: write.reason ?? RECIPE_STILL_ASKS_SAID.unread });
    else {
      const { reason: _reason, ...plain } = counted;
      covers.push(plain);
    }
  }
  return { covers, still };
};

/** D-402 slices F3 and H4 — whether this caller holds a standing "Always" for this recipe version and for
 *  the browsers a run would act in. One rule for the question (`planRunQuestion`) and the chat's "not asked
 *  yet" (`standingPreapproval`), so the two never disagree. Ruling 17 — and for each recipe the run starts
 *  whose steps would ask (`nestedAskingVersions`), at its version now. */
export const holdsStandingPreapproval = (input: {
  readonly store: Pick<TriggerPreapprovalStore, 'listCallers'>;
  readonly caller: PreapprovalCaller;
  readonly recipe_id: string;
  readonly recipe_sha256: string;
  readonly browsers?: PreapprovalBrowsers;
  readonly nested?: ReadonlyMap<string, string>;
}): boolean => input.store.listCallers().some((row) => row.run_id === undefined
  && callerPreapprovalCovers(row, { caller: input.caller, recipe_id: input.recipe_id, recipe_sha256: input.recipe_sha256, run_id: '',
    ...(input.browsers !== undefined ? { browsers: input.browsers } : {}) })
  && [...(input.nested ?? new Map<string, string>())].every(([recipe_id, sha]) => row.nested?.[recipe_id] === sha));

/** D-402 ruling 17 — the recipes a run starts through a pack's binding (D-232), as the question reads
 *  them (`classifyRecipeAsks` walks into each): every one it walked into, at its version now. */
export const nestedRecipeVersions = (
  asks: readonly RecipeStepAsk[],
  recipe: RecipeDefinition,
  recipeOf: RecipeAskLookups['recipeOf'],
): Map<string, string> => {
  const versions = new Map<string, string>();
  for (const ask of asks) {
    if (ask.via.length === 0 || ask.recipe_id === recipe.recipe_id || versions.has(ask.recipe_id)) continue;
    const inner = recipeOf?.(ask.recipe_id) ?? undefined;
    if (inner !== undefined) versions.set(ask.recipe_id, triggerPreapprovalRecipeSha256(inner));
  }
  return versions;
};

/** D-402 ruling 17 — of those, the ones whose steps ask where an answer can stand in: what a standing
 *  "Always" must also name, at these versions, to cover the run. */
export const nestedAskingVersions = (
  asks: readonly RecipeStepAsk[],
  recipe: RecipeDefinition,
  recipeOf: RecipeAskLookups['recipeOf'],
): Map<string, string> => {
  const asking = new Set(asks.filter((ask) => ask.via.length > 0 && ask.verdict === 'ahead').map((ask) => ask.recipe_id));
  return new Map([...nestedRecipeVersions(asks, recipe, recipeOf)].filter(([recipe_id]) => asking.has(recipe_id)));
};

/** What lets a step through without asking, outside a pre-approval: the chat's switch for a browser
 *  action, and what `coveredBy` reads (a session grant, a site pass, a write rule). */
const coverageOf = (input: RunQuestionPlanInput) => {
  const own = stepsById(input.recipe);
  return (ask: RecipeStepAsk): boolean => {
    if (ask.verdict !== 'ahead') return false;
    if (input.browserSwitchOn && ask.slug !== undefined && isBrowserActionSlug(ask.slug)) return true;
    const site = ask.via.length === 0 && ask.slug !== undefined && isBrowserActionSlug(ask.slug) ? passSiteOf(own.get(ask.step_id)) : undefined;
    return input.coveredBy?.(ask, site !== undefined ? { site } : {}) === true;
  };
};

/** D-402 ruling 17 — why a run cannot start, when a recipe it runs (D-232) would stop to ask: a step that
 *  asks every time (a delete, one set to ask every time, one not readable before the run), or a browser
 *  action nothing already allows. An inner run cannot stop to ask, so the run stops before step 1 and
 *  names them. Undefined: nothing in the recipes it runs would stop to ask. The runs the question is for
 *  alone, as `planRunQuestion` reads them. */
export const nestedRunRefusal = (input: RunQuestionPlanInput): { readonly message: string; readonly step_id: string } | undefined => {
  const { recipe, caller } = input;
  if (caller === undefined || input.not_fresh || !input.installed) return undefined;
  if (recipe.metadata?.author === 'recued' || input.pack_slug === BROWSER_TOOLKIT_PACK_SLUG) return undefined;
  const asks = classifyRecipeAsks(recipe, input.source, input.lookups);
  const covered = coverageOf(input);
  const blocked = asks.filter((ask) => ask.via.length > 0 && (ask.verdict === 'still'
    || (ask.verdict === 'ahead' && ask.slug !== undefined && isBrowserActionSlug(ask.slug) && !covered(ask))));
  if (blocked.length === 0) return undefined;
  const byRecipe = new Map<string, RecipeStepAsk[]>();
  for (const ask of blocked) byRecipe.set(ask.recipe_id, [...(byRecipe.get(ask.recipe_id) ?? []), ask]);
  const nameOf = (recipe_id: string): string => input.lookups.recipeOf?.(recipe_id)?.metadata?.name ?? recipe_id;
  const each = [...byRecipe].map(([recipe_id, steps]) => {
    const { covers, still } = linesOf(steps, recipe, input);
    return `It runs “${nameOf(recipe_id)}”, which would stop to ask you before it can ${[...still, ...covers].map(runQuestionLine).join('; ')}.`;
  });
  const instead = byRecipe.size === 1 ? `Run “${nameOf([...byRecipe.keys()][0]!)}” on its own, where it can ask.`
    : 'Run each of them on its own, where it can ask.';
  return {
    message: `“${recipe.metadata?.name ?? recipe.recipe_id}” can’t start. ${each.join(' ')} `
      + `A recipe that another recipe runs can’t stop to ask, so nothing was done. ${instead}`,
    // The run's own step that starts the first of them.
    step_id: blocked[0]!.via[0] ?? blocked[0]!.step_id,
  };
};

/** D-402 ruling 17 — the run's error for `nestedRunRefusal`: the refusal, at the step that starts the inner
 *  recipe, before step 1. The same code a refusal before step 1 has (slice H3's browsers). */
export const nestedRunRefusalError = (
  recipe: RecipeDefinition,
  refusal: { readonly message: string; readonly step_id: string },
  at: Date = new Date(),
): RecipeError => ({
  error_id: `nested-${at.getTime().toString(36)}`,
  code: 'ROLE_RESTRICTION',
  message: refusal.message,
  severity: 'fatal',
  source: { recipe_id: recipe.recipe_id, step_id: refusal.step_id, ingredient_slug: null },
  details: { nested_runs: true },
  timestamp: at.toISOString(),
  retryable: false,
});

/** The question a run gets, with what it keeps on its hold, or undefined: no question for this run. */
export const planRunQuestion = (input: RunQuestionPlanInput): RunQuestionHold | undefined => {
  const { recipe, caller } = input;
  if (caller === undefined || input.not_fresh || !input.installed) return undefined;
  if (recipe.metadata?.author === 'recued' || input.pack_slug === BROWSER_TOOLKIT_PACK_SLUG) return undefined;
  const asks = classifyRecipeAsks(recipe, input.source, input.lookups);
  // A standing "Always" this caller holds for this version covers every write it would ask about.
  // D-402 slice H4 — and for the browsers this run's settings name: a browser setting changed under "Always"
  // asks again (§8 item 7). Ruling 17 — and for each recipe it runs whose steps would ask, at its version
  // now: one changed since asks again.
  const standing = holdsStandingPreapproval({ store: input.store, caller, recipe_id: recipe.recipe_id,
    recipe_sha256: input.recipe_sha256, ...(input.browsers !== undefined ? { browsers: input.browsers } : {}),
    nested: nestedAskingVersions(asks, recipe, input.lookups.recipeOf) });
  if (standing) return undefined;
  // What the chat's switch, "Allow in this chat" or a site pass lets through goes ahead without
  // asking: no reason to ask first, and nothing the question needs to list.
  const covered = coverageOf(input);
  const uncovered = asks.filter((ask) => ask.verdict === 'ahead' && !covered(ask));
  if (uncovered.length === 0) return undefined;
  const asking = asks.filter((ask) => ask.verdict !== 'never' && !covered(ask));
  const { covers, still } = linesOf(asking, recipe, input);
  // Ruling 17 — the recipes it runs, at their versions now: what an answer's pre-approval covers too.
  const nested = nestedRecipeVersions(asks, recipe, input.lookups.recipeOf);
  const question: RunQuestion = {
    recipe_name: recipe.metadata?.name ?? recipe.recipe_id,
    runs: 1,
    covers,
    still,
    ai: asks.some((ask) => ask.ai === true),
    secrets: [...new Set(asks.flatMap((ask) => ask.secrets ?? []))],
    saves_files: asks.filter((ask) => ask.saves_files === true).length,
    asked_by: caller.kind === 'ai_app' ? { kind: 'ai_app', name: input.appName ?? 'Your AI app' } : { kind: 'owner_chat' },
    ...(input.browserWork !== undefined && input.browserWork.length >= 2 ? { browsers: input.browserWork } : {}),
    ...(nested.size > 0 ? { runs_also: [...nested.keys()].map((id) => input.lookups.recipeOf?.(id)?.metadata?.name ?? id) } : {}),
  };
  // D-402 ruling 4 — "Always" for an AI app too, since slice F4 built the revoke that takes it back: the
  // owner's chat ends it by the app's name (`recipe.stop_allowing`), and the app can give up its own
  // (`recued_stopAllowing`). Kept on the hold: a question asked before this offered no "Always", and an
  // answer it never offered still grants nothing.
  return { question, caller, recipe_sha256: input.recipe_sha256, always: true,
    ...(input.browsers !== undefined && Object.keys(input.browsers).length > 0 ? { browsers: input.browsers } : {}),
    ...(nested.size > 0 ? { nested: Object.fromEntries(nested) } : {}),
    // Ruling 17 — an inner run cannot stop to ask, so "Ask me at each step" is not offered when one would.
    ...(uncovered.some((ask) => ask.via.length > 0) ? { each_step: false as const } : {}) };
};

/** The step a held run names as where it begins: the first of its first phase. */
export const runQuestionStartOf = (recipe: RecipeDefinition): { gated_step_id: string; execution_phase: 'trigger' | 'prefetch' | 'sequential' } | undefined => {
  for (const [where, phase] of [['trigger_steps', 'trigger'], ['prefetch_steps', 'prefetch'], ['steps', 'sequential']] as const) {
    const first = ((recipe[where] ?? []) as unknown[])[0] as { id?: unknown } | undefined;
    if (typeof first?.id === 'string' && first.id !== '') return { gated_step_id: first.id, execution_phase: phase };
  }
  return undefined;
};

/** What a round gathers questions by (D-402 ruling 13): one recipe version, one caller. */
const RUN_QUESTION_GATHER_PREFIX = 'run_question:';
export const runQuestionGatherKey = (checkpoint: Checkpoint): string => {
  const hold = checkpoint.run_question!;
  const caller = hold.caller.kind === 'ai_app' ? `ai_app:${hold.caller.contract_id}` : 'owner_chat';
  return `${RUN_QUESTION_GATHER_PREFIX}${JSON.stringify([checkpoint.recipe_id, hold.recipe_sha256, caller])}`;
};
export const isRunQuestionGatherKey = (key: string): boolean => key.startsWith(RUN_QUESTION_GATHER_PREFIX);

/** Raise one question for the runs of one recipe a round held (ruling 13: "Run “…” 3 times?"), or for
 *  one run: the whole question in the app, its first block on a messenger, each answer a button. Its
 *  own ask, never an approval of a held call or a batch's. */
export const raiseGatheredRunQuestionAsk = (
  notifier: Pick<PreflightNotifier, 'ask'>,
  checkpoints: readonly Checkpoint[],
): Promise<{ ask_id: string }> => {
  const lead = checkpoints[0]!;
  const hold = lead.run_question!;
  const question = { ...hold.question, runs: checkpoints.length };
  const title = runQuestionTitle(question);
  return notifier.ask(
    { title, text: runQuestionText(question), plain: { title, text: runQuestionFirstBlock(question) } },
    runQuestionOptions(hold.always, question.runs, hold.each_step !== false).map((option) => ({ id: option.id, label: option.label })),
    { kind: RUN_QUESTION_ASK_KIND, payload: {
      checkpoint_id: lead.checkpoint_id, run_id: lead.run_id,
      ...(lead.recipe_id !== undefined ? { recipe_id: lead.recipe_id } : {}),
      checkpoint_ids: checkpoints.map((checkpoint) => checkpoint.checkpoint_id),
    } },
  );
};

/** One run's question. */
export const raiseRunQuestionAsk = (notifier: Pick<PreflightNotifier, 'ask'>, checkpoint: Checkpoint): Promise<{ ask_id: string }> =>
  raiseGatheredRunQuestionAsk(notifier, [checkpoint]);

/** D-402 slice F4 — end the pre-approvals a run held for itself alone ("Yes, this time"), at its terminal
 *  end: a one-run row covers that run and is never reused. Best effort: a store that cannot be read
 *  leaves them, and they cover only that run anyway. */
export const endRunPreapprovals = (
  store: Pick<TriggerPreapprovalStore, 'listCallers' | 'revokeCaller'> | undefined,
  run_id: string,
  now: number = Date.now(),
): void => {
  if (store === undefined) return;
  try {
    for (const row of store.listCallers()) if (row.run_id === run_id && row.revoked_at === undefined) store.revokeCaller(row.id, now);
  } catch (error) {
    console.warn(`[run-question] the pre-approvals of run ${run_id} were not ended with it`, error);
  }
};

/** What answering the question needs: the hold's checkpoint, the resumer that starts or ends the run,
 *  and the store the answer grants in. */
export interface RunQuestionAnswerDeps {
  readonly checkpointStore: Pick<CheckpointStore, 'get' | 'delete'>;
  readonly resumer: Pick<PreflightResumer, 'resumeRun' | 'denyRun'>;
  readonly store: Pick<TriggerPreapprovalStore, 'grantCaller' | 'listCallers'>;
  readonly now?: () => number;
}

/** D-402 slice F3 (§7.4) — the owner's answer to the question before a run:
 *  - "Yes, this time" grants a pre-approval for this run alone, then starts it;
 *  - "Always, for this recipe" grants the standing one for this caller and version, then starts it;
 *  - "Ask me at each step" starts it with nothing granted: each step asks when the run reaches it;
 *  - "No" ends it as declined, nothing having run.
 *  Started afresh under its `run_id` (`preflight-resumer.ts`), with the answer, so it is not asked again.
 *  At least once: a crash after the answer replays it (`recoverPendingAsks`), so a grant already made is
 *  not made twice, and the resumer's own checks keep a run from starting twice. */
export const createRunQuestionAnswerHandler = (deps: RunQuestionAnswerDeps) => {
  /** The answer, for one run the question was about. */
  const answerOne = async (checkpoint_id: string, option: RunQuestionAnswer): Promise<void> => {
    const checkpoint = await deps.checkpointStore.get(checkpoint_id);
    if (checkpoint === null || checkpoint.run_question === undefined || checkpoint.recipe_id === undefined) return;
    const hold = checkpoint.run_question;
    // An "Always" the ask never offered grants nothing (the block refuses one; this is the narrow).
    if (option === RUN_QUESTION_ALWAYS && !hold.always) return;
    // Ruling 17 — nor does "Ask me at each step" where it was not offered: an inner run cannot stop to ask.
    if (option === RUN_QUESTION_EACH_STEP && hold.each_step === false) return;
    const context = { recipe_id: checkpoint.recipe_id, ...(checkpoint.gated_step_id !== undefined ? { gated_step_id: checkpoint.gated_step_id } : {}),
      run_question_answer: option };
    if (option === RUN_QUESTION_NO) {
      await deps.resumer.denyRun(checkpoint, context);
      await deps.checkpointStore.delete(checkpoint_id);
      return;
    }
    const now = deps.now?.() ?? Date.now();
    const recipe_id = checkpoint.recipe_id;
    // D-402 slice H4 — for the browsers the run's settings named when it was asked: an "Always" granted for
    // others is not this one, so the answer grants its own.
    const live = deps.store.listCallers().filter((row) => row.revoked_at === undefined && row.recipe_id === recipe_id
      && row.recipe_sha256 === hold.recipe_sha256 && samePreapprovalCaller(row.caller, hold.caller)
      && samePreapprovalBrowsers(row.browsers, hold.browsers) && samePreapprovalNested(row.nested, hold.nested));
    // Ruling 17 — for the recipes the run starts, at the versions the question saw.
    const browsers = { ...(hold.browsers !== undefined ? { browsers: hold.browsers } : {}),
      ...(hold.nested !== undefined ? { nested: hold.nested } : {}) };
    if (option === RUN_QUESTION_ONCE && !live.some((row) => row.run_id === checkpoint.run_id)) {
      deps.store.grantCaller({ caller: hold.caller, recipe_id, recipe_sha256: hold.recipe_sha256, run_id: checkpoint.run_id, ...browsers, now });
    }
    if (option === RUN_QUESTION_ALWAYS && !live.some((row) => row.run_id === undefined)) {
      deps.store.grantCaller({ caller: hold.caller, recipe_id, recipe_sha256: hold.recipe_sha256, ...browsers, now });
    }
    await deps.resumer.resumeRun(checkpoint, context);
    await deps.checkpointStore.delete(checkpoint_id);
  };
  return async (payload: Record<string, unknown>, answer: { option: string }): Promise<void> => {
    if (!isRunQuestionAnswer(answer.option)) return;
    // Ruling 13 — a round's question is about each run of the recipe it held, in the order they held.
    const ids = Array.isArray(payload.checkpoint_ids)
      ? payload.checkpoint_ids.filter((id): id is string => typeof id === 'string' && id !== '')
      : typeof payload.checkpoint_id === 'string' ? [payload.checkpoint_id] : [];
    for (const checkpoint_id of ids) await answerOne(checkpoint_id, answer.option);
  };
};

/** Register the question's answer handler with the notification block, once at boot. */
export const registerRunQuestionHandler = (
  block: { registerAskHandler(kind: string, fn: (payload: Record<string, unknown>, answer: { option: string }) => Promise<void>): void },
  deps: RunQuestionAnswerDeps,
): void => {
  block.registerAskHandler(RUN_QUESTION_ASK_KIND, createRunQuestionAnswerHandler(deps));
};
