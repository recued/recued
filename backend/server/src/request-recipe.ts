/** D-402 slice A4 — "Make a recipe" on a request in the owner's chat.
 *
 *  The request's plan is what every turn of it did (an action held for approval runs in a turn of
 *  its own, so the turns are joined by their request, as W3 joins them): its steps and its calls,
 *  as the recorder holds them for an hour. It is compiled into a recipe and kept in Kitchen as
 *  Recued's (`recued:chat`, slice A3), with the compiler's notes; the owner reviews and saves it
 *  there. ⛔ DRAFTS, NEVER SAVES.
 *
 *  Slice B compiles the request's whole plan, reads included (`plan-compiler.ts`); a request whose
 *  plan holds nothing a recipe can repeat answers `no_actions` rather than a recipe that does nothing. */

import {
  KITCHEN_DRAFT_MAX_NOTES, KITCHEN_DRAFT_NOTE_MAX_CHARS, kitchenCompiledOrigin, kitchenDraftPath, kitchenRecipePath,
  type KitchenDraftMadeFrom, type KitchenImportDraft,
} from '@recued/contracts';
import { decisionWays, mergeHandOffBranch } from './hand-off-branch.js';
import type { RecipeDefinition } from '@recued/contracts';
import { parseRecipe } from '@recued/recipes';
import type { BrowserFlowRecorder, BrowserPlanCallWithSteps } from './bridges/browser-flow-record.js';
import type { KitchenDraftStore } from './kitchen-draft-store.js';
import { answerValuesOf } from './answer-values.js';
import { compilePlan, type PlanCompileInput } from './plan-compiler.js';
import type { PlanLabelsAnswer, PlanLabelsCarriedOn } from './plan-labels.js';
import { validateRecipeInline } from './recipe-save-handler.js';

/** What a request whose plan holds nothing a recipe can repeat answers. */
export const NO_ACTIONS_ISSUE = 'Nothing in this request worked in a web page that a recipe can repeat.';

/** D-402 slices A4, A5 and B — a plan compiled into a recipe (`plan-compiler.ts`), checked as a
 *  recipe saved in Kitchen is, and kept as Recued's draft under `origin`, with `notes` before the
 *  compiler's own. Each draft gets a recipe id of its own, so saving one never replaces another. */
export const compilePlanDraft = (input: {
  calls: readonly BrowserPlanCallWithSteps[];
  /** Who did the work, for the description. */
  by: 'chat' | 'app';
  made_from: KitchenDraftMadeFrom;
  origin: string;
  kitchenDrafts: Pick<KitchenDraftStore, 'createCompiled'>;
  notes?: readonly string[];
  /** The recipe's name, when the caller gave one. */
  title?: string;
  /** Slice B2b — the values the job's answer gave. */
  answer?: ReadonlyArray<{ name?: string; value: string }>;
  /** Slice D (§5.1) — the owner's words (the chat's request), or the inputs an AI app named. */
  request?: string;
  /** Rule 7 (2026-11-20, task E) — the chat's reply as written, for an answer written from what was read. */
  reply?: string;
  inputs?: ReadonlyArray<{ name: string; value: string; label?: string }>;
  /** Slice D2 — the owner's zone, for a typed day relative to the run's day. */
  time_zone?: string;
  /** Slice E1 (§6) — where the work used judgement, as its caller labelled it. */
  judgements?: PlanCompileInput['judgements'];
  /** Slice H2 — the paired browsers, so each browser setting holds the lasting id of the one it ran in. */
  browsers?: PlanCompileInput['browsers'];
  /** 2026-11-21 (task K, live) — the reader Recued reads each document-read file with now. */
  document_readers?: PlanCompileInput['document_readers'];
}): { ok: true; draft: KitchenImportDraft; issues: string[] }
  | { ok: false; reason: 'no_actions' | 'invalid_recipe'; issues: string[] } => {
  const checked = compilePlanChecked(input);
  if (!checked.ok) return checked;
  const notes = [...(input.notes ?? []), ...checked.issues].slice(0, KITCHEN_DRAFT_MAX_NOTES)
    .map((note) => note.slice(0, KITCHEN_DRAFT_NOTE_MAX_CHARS));
  const draft = input.kitchenDrafts.createCompiled({ origin: input.origin, kind: 'recipe',
    source: JSON.stringify(checked.recipe, null, 2), notes, made_from: input.made_from,
    ...(input.title !== undefined ? { title: input.title.slice(0, 100) } : {}) });
  return { ok: true, draft, issues: checked.issues };
};

/** A plan compiled into a recipe and checked as a recipe saved in Kitchen is, not yet kept. */
export const compilePlanChecked = (input: Omit<Parameters<typeof compilePlanDraft>[0], 'kitchenDrafts' | 'origin' | 'made_from'>):
  { ok: true; recipe: RecipeDefinition; issues: string[] } | { ok: false; reason: 'no_actions' | 'invalid_recipe'; issues: string[] } => {
  const { recipe, notes: issues } = compilePlan({ calls: input.calls, by: input.by,
    ...(input.title !== undefined ? { title: input.title } : {}), ...(input.answer !== undefined ? { answer: input.answer } : {}),
    ...(input.request !== undefined ? { request: input.request } : {}), ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
    ...(input.reply !== undefined ? { reply: input.reply } : {}),
    ...(input.time_zone !== undefined ? { time_zone: input.time_zone } : {}),
    ...(input.judgements !== undefined && input.judgements.length > 0 ? { judgements: input.judgements } : {}),
    ...(input.browsers !== undefined ? { browsers: input.browsers } : {}),
    ...(input.document_readers !== undefined ? { document_readers: input.document_readers } : {}) });
  if (recipe.steps.length === 0) return { ok: false, reason: 'no_actions', issues: [...issues, NO_ACTIONS_ISSUE] };
  const parsed = parseRecipe(recipe);
  if (!parsed.ok) return { ok: false, reason: 'invalid_recipe', issues: [...issues, ...parsed.issues.map((issue) => issue.message)] };
  const checked = validateRecipeInline(parsed.recipe);
  if (!checked.ok) {
    return { ok: false, reason: 'invalid_recipe', issues: [...issues,
      ...checked.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message)] };
  }
  return { ok: true, recipe: parsed.recipe, issues };
};

export type RequestRecipeAnswer =
  | { ok: true; draft_id: string; kitchen_path: string; recipe_id?: string; issues: string[] }
  | { ok: false; reason: 'nothing_kept' | 'no_actions' | 'invalid_recipe' | 'changes_in_progress'; issues: string[] };

/** The compiler's own note on a decision: the chat's decision is the merged branch's, said by its
 *  own note, so this one would describe a guard the draft does not have. */
const DECISION_NOTE = 'The job decided which way to go';

/** 2026-11-21 (task K, live) — for each document read that ran no reader (the chat answered it from text a reader
 *  had kept), the reader Recued reads that file with: what the recipe reads it with (`document_readers`). */
const documentReaders = (calls: readonly BrowserPlanCallWithSteps[], reader: ((record_id: string) => string | undefined) | undefined):
  { document_readers?: Record<string, string> } => {
  if (reader === undefined) return {};
  const found: Record<string, string> = {};
  for (const call of calls) {
    if (call.recipe_id.replace(/^.*\//u, '') !== 'read-work-document' || (call.ops ?? []).some((op) => op.startsWith('recued-core.'))) continue;
    const source = call.args?.source;
    const id = typeof source === 'string' ? source
      : source !== null && typeof source === 'object' && typeof (source as { record_id?: unknown }).record_id === 'string'
        ? (source as { record_id: string }).record_id : undefined;
    const op = id === undefined ? undefined : reader(id);
    if (id !== undefined && op !== undefined) found[id] = op;
  }
  return Object.keys(found).length > 0 ? { document_readers: found } : {};
};

export const makeRequestRecipeDraft = (deps: {
  flows: Pick<BrowserFlowRecorder, 'planFor'>;
  /** The request a turn belongs to: its root. Undefined for a turn the compiler does not know. */
  resolveRoot: (session_id: string, turn_id: string) => string | undefined;
  kitchenDrafts: Pick<KitchenDraftStore, 'createCompiled'>;
  /** Slice B2b — the request's final reply, whose values the recipe reads out (§3.1), and (slice B4)
   *  the owner's words, whose values were context, not answers. */
  answerOf?: (session_id: string, inRequest: (turn_id: string) => boolean) => Promise<{ reply?: string; request?: string } | undefined>;
  /** Slice D2 — the owner's zone, read when the draft is made. */
  timeZone?: () => string | undefined;
  /** Slice E2 (§6.3) — the owner's models say where the request used judgement (`plan-labels.ts`). */
  labelPlan?: (input: { request?: string; reply?: string; calls: readonly BrowserPlanCallWithSteps[];
    carried_on?: PlanLabelsCarriedOn }) => Promise<PlanLabelsAnswer>;
  /** Slice E4c — the run a chat carries on (`run-carry-on.ts`): its recipe, and the step that handed off. */
  carryOn?: (session_id: string) => { recipe_id: string; step_id: string } | undefined;
  /** Slice E4c — an installed recipe. */
  recipes?: (recipe_id: string) => RecipeDefinition | undefined;
  /** Slice H2 — the paired browsers when the draft is made (`listBrowsers`). */
  browsers?: () => PlanCompileInput['browsers'];
  /** 2026-11-21 (task K, live) — the op of the reader Recued reads a stored file with now (`documentReadPlan`),
   *  undefined for a file read as it is (text) or one it no longer holds. */
  documentReader?: (record_id: string) => string | undefined;
}) => async (input: { session_id: string; turn_id: string }): Promise<RequestRecipeAnswer> => {
  const { session_id, turn_id } = input;
  const root = deps.resolveRoot(session_id, turn_id);
  const inRequest = (turn: string): boolean => turn === turn_id
    || (root !== undefined && deps.resolveRoot(session_id, turn) === root);
  const calls = deps.flows.planFor(session_id, inRequest);
  if (calls.length === 0) {
    return { ok: false, reason: 'nothing_kept',
      issues: ['Recued no longer holds what this request did: it keeps it for an hour after the request.'] };
  }
  const made_from: KitchenDraftMadeFrom = { kind: 'chat_request', session_id, turn_id };
  const said = await deps.answerOf?.(session_id, inRequest).catch(() => undefined);
  // Slice E4c — the run this chat carries on, if it does, and its recipe as installed.
  const carried = deps.carryOn?.(session_id);
  const carriedRecipe = carried === undefined ? undefined : deps.recipes?.(carried.recipe_id);
  const carriedName = typeof carriedRecipe?.metadata?.name === 'string' && carriedRecipe.metadata.name.trim() !== ''
    ? carriedRecipe.metadata.name.trim() : undefined;
  // Slice E4d — the ways the recipe goes on with, so the labelling call names the way this chat took by
  // what the page showed instead, though the owner, not a condition in the request, chose it.
  const ways = carried === undefined || carriedRecipe === undefined ? undefined : decisionWays(carriedRecipe, carried.step_id);
  // Slice E2 — where it used judgement, which the draft then leaves to AI at each run (E1). A label the
  // record does not hold is left out, and a call that failed leaves the draft as it was; either is said.
  const labelled = deps.labelPlan === undefined ? undefined : await deps.labelPlan({ calls,
    ...(said?.request !== undefined ? { request: said.request } : {}), ...(said?.reply !== undefined ? { reply: said.reply } : {}),
    ...(ways !== undefined ? { carried_on: { ...(carriedName !== undefined ? { recipe: carriedName } : {}), went_on_when: ways } } : {}) })
    .catch((error: unknown): PlanLabelsAnswer => ({ ok: false, reason: error instanceof Error ? error.message : 'the call failed' }));
  const labelNotes = labelled === undefined ? [] : labelled.ok
    ? labelled.left_out.map((judgement) => `Your AI said it used judgement${judgement.chose !== undefined ? ` choosing “${judgement.chose}”` : ''}, `
      + 'but nothing this request did or read shows it, so the draft does not use that label.')
    : [`Your AI could not say where the request used judgement (${labelled.reason}), so the draft repeats what the request typed and read.`];
  const plan = { calls, by: 'chat' as const,
    ...(labelled?.ok === true && labelled.judgements.length > 0 ? { judgements: labelled.judgements } : {}),
    ...(said?.reply !== undefined ? { answer: answerValuesOf(said.reply, said.request).map((value) => ({ value })) } : {}),
    // Slice D — the owner's words: a typed value found there is asked for at each run, another is fixed.
    ...(said?.request !== undefined ? { request: said.request } : {}),
    // Rule 7 (2026-11-20) — and the reply as written: an answer written from what was read is written again.
    ...(said?.reply !== undefined ? { reply: said.reply } : {}),
    ...((): { time_zone?: string } => { const zone = deps.timeZone?.(); return zone !== undefined ? { time_zone: zone } : {}; })(),
    ...((): { browsers?: PlanCompileInput['browsers'] } => { const browsers = deps.browsers?.(); return browsers !== undefined ? { browsers } : {}; })(),
    ...documentReaders(calls, deps.documentReader) };
  const origin = kitchenCompiledOrigin(made_from);
  // Slice E4c (§6.6) — a chat that carries on a run a hand-off stopped: the way it took is added to that
  // run's recipe as a branch, kept as changes to it. When it cannot be, a note says why and the draft is
  // a recipe of its own.
  const carriedNotes: string[] = [];
  if (carried !== undefined) {
    const recipe = carriedRecipe;
    const name = carriedName;
    if (recipe === undefined) {
      carriedNotes.push('The recipe this chat carried on is no longer installed, so this is a recipe of its own.');
    } else {
      const branch = compilePlanChecked(plan);
      if (!branch.ok) return { ok: false, reason: branch.reason, issues: branch.issues };
      const merged = mergeHandOffBranch({ recipe, step_id: carried.step_id, branch: branch.recipe });
      const checked = merged.ok ? checkRecipe(merged.recipe) : undefined;
      if (merged.ok && checked?.ok === true) {
        const notes = [merged.note, ...labelNotes, ...branch.issues.filter((note) => !note.startsWith(DECISION_NOTE))]
          .slice(0, KITCHEN_DRAFT_MAX_NOTES).map((note) => note.slice(0, KITCHEN_DRAFT_NOTE_MAX_CHARS));
        let draft: KitchenImportDraft;
        try {
          draft = deps.kitchenDrafts.createCompiled({ origin, kind: 'recipe', source: JSON.stringify(checked.recipe, null, 2),
            notes, made_from, ...(name !== undefined ? { title: name.slice(0, 100) } : {}),
            base: { recipe_id: recipe.recipe_id, version: recipe.version } });
        } catch (error) {
          if ((error as { code?: unknown }).code !== 'conflict') throw error;
          return { ok: false, reason: 'changes_in_progress', issues: [`Changes to ${name !== undefined ? `“${name}”` : 'this recipe'} are `
            + 'already in progress in Kitchen. Save or discard them there, then make the recipe again.'] };
        }
        return { ok: true, draft_id: draft.draft_id, kitchen_path: kitchenRecipePath(recipe.recipe_id), recipe_id: recipe.recipe_id,
          issues: notes };
      }
      const why = merged.ok ? (checked?.ok === false ? checked.issues[0] ?? 'it did not check out as a recipe' : '') : merged.why;
      carriedNotes.push(`Recued could not add this way to ${name !== undefined ? `“${name}”` : 'the recipe this chat carried on'}, `
        + `because ${why}, so this is a recipe of its own.`);
    }
  }
  const compiled = compilePlanDraft({ ...plan, made_from, origin, kitchenDrafts: deps.kitchenDrafts,
    ...(carriedNotes.length + labelNotes.length > 0 ? { notes: [...carriedNotes, ...labelNotes] } : {}) });
  if (!compiled.ok) return { ok: false, reason: compiled.reason, issues: compiled.issues };
  return { ok: true, draft_id: compiled.draft.draft_id, kitchen_path: kitchenDraftPath(compiled.draft.draft_id),
    issues: [...carriedNotes, ...compiled.issues] };
};

/** A recipe checked as one saved in Kitchen is. */
const checkRecipe = (recipe: RecipeDefinition): { ok: true; recipe: RecipeDefinition } | { ok: false; issues: string[] } => {
  const parsed = parseRecipe(recipe);
  if (!parsed.ok) return { ok: false, issues: parsed.issues.map((issue) => issue.message) };
  const checked = validateRecipeInline(parsed.recipe);
  return checked.ok ? { ok: true, recipe: parsed.recipe }
    : { ok: false, issues: checked.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message) };
};
