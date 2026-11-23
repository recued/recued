/** D-402 slice E4c (§6.6) — the way a carried-on chat took, added to the recipe as a branch.
 *
 *  A hand-off (slice E3b) is a guard after a decision the page turned on, `T not_contains A`: T is the
 *  page's text, read where the job read it, and A what the page showed when the job went on. A run whose
 *  page did not show A stopped there (E4a), and the owner carried it on in the chat (E4b). "Make a
 *  recipe" in that chat compiles what the chat did, whose own decision names what the page showed this
 *  time, B. This adds the steps the chat took after its decision to the recipe, as the way it goes when
 *  the page shows B (the owner's ruling, 2026-11-17: a branch on the same recipe):
 *
 *  - an `any` step says whether the page shows a way the recipe knows, and the guard stops the run only
 *    on a page that shows none of them;
 *  - the recipe's own steps after the decision run when the page shows A (`skip_when … not_contains A`);
 *  - the chat's steps, renamed and continued on the recipe's tab, run when the page shows B and no way
 *    added before it. A page that shows two ways goes the first.
 *
 *  ⛔ It merges only what it can follow. The chat's steps may refer to the page its decision read, to
 *  each other and to its settings; anything else is refused with why, and the caller drafts the chat's
 *  recipe on its own. */
import type { RecipeDefinition } from '@recued/contracts';
import { handOffReason } from './plan-compiler.js';

type Step = Record<string, unknown> & { id: string };

const TEXT_REF = /^\{\{step\.([A-Za-z0-9_]+)\.tabs\.0\.reads\.0\.text\}\}$/u;
/** A decision as E3b compiles it: the page's text does not contain what it showed. */
const PLAIN_GUARD = /^(\{\{step\.[A-Za-z0-9_]+\.tabs\.0\.reads\.0\.text\}\}) not_contains (.+)$/su;
/** A decision a merge has made: whether the page showed any way the recipe knows. */
const MET_GUARD = /^\{\{step\.([A-Za-z0-9_]+)\}\} equal false$/u;
const STEP_REF = /\{\{step\.([A-Za-z0-9_]+)/gu;
const CONFIG_REF = /\{\{config\.([A-Za-z0-9_]+)/gu;

export type HandOffBranchMerge =
  | { readonly ok: true; readonly recipe: RecipeDefinition; readonly shown: string; readonly note: string }
  | { readonly ok: false; readonly why: string };

const quoted = (value: string): string => `“${value.length > 60 ? `${value.slice(0, 60).trimEnd()}…` : value}”`;

/** Whether steps use AI at a run: a model step, or an Act call that asks a question of a page. */
const usesAi = (steps: readonly Step[]): boolean => steps.some((step) =>
  (typeof step.op === 'string' && step.op.startsWith('core.ai.'))
  || JSON.stringify(step.args ?? {}).includes('"do":"ask"'));

/** A hand-off's decision: the page's text it tests, the ways it knows in the order it tries them, and
 *  the `any` step a merge made, if one did. Undefined for a guard it cannot read. */
const readDecision = (steps: readonly Step[], guard: string): { text: string; known: string[]; met?: Step } | undefined => {
  const plain = PLAIN_GUARD.exec(guard);
  if (plain !== null) return { text: plain[1]!, known: [plain[2]!.trim()] };
  const metId = MET_GUARD.exec(guard)?.[1];
  const met = steps.find((step) => step.id === metId);
  const conditions = met?.transform === 'any' && Array.isArray(met.conditions) ? met.conditions as unknown[] : [];
  const parsed = conditions.map((condition) => typeof condition === 'string'
    ? /^(\{\{step\.[A-Za-z0-9_]+\.tabs\.0\.reads\.0\.text\}\}) contains (.+)$/su.exec(condition) : null);
  if (met === undefined || parsed.length === 0 || parsed.some((one) => one === null) || new Set(parsed.map((one) => one![1])).size !== 1) {
    return undefined;
  }
  return { text: parsed[0]![1]!, known: parsed.map((one) => one![2]!.trim()), met };
};

/** D-402 slice E4d — the ways a recipe's hand-off goes on with, for the chat's labelling call, which
 *  then names the way a carried-on chat took by what the page showed instead. Undefined when the step
 *  is gone, no longer hands off, or cannot be read. */
export const decisionWays = (recipe: RecipeDefinition, step_id: string): string[] | undefined => {
  const steps = recipe.steps as unknown as Step[];
  const decision = steps.find((step) => step.id === step_id);
  if (decision?.hand_off !== true || typeof decision.guard !== 'string') return undefined;
  return readDecision(steps, decision.guard)?.known;
};

export const mergeHandOffBranch = (input: {
  /** The recipe the run was of. */
  readonly recipe: RecipeDefinition;
  /** The step that handed off (`decide_N`). */
  readonly step_id: string;
  /** What the carried-on chat did, compiled (`plan-compiler.ts`). */
  readonly branch: RecipeDefinition;
}): HandOffBranchMerge => {
  const steps = (input.recipe.steps as unknown as Step[]).map((step) => ({ ...step }));
  const at = steps.findIndex((step) => step.id === input.step_id);
  const decision = steps[at];
  if (decision === undefined) return { ok: false, why: 'the step where it stopped is no longer in the recipe' };
  if (decision.hand_off !== true || typeof decision.guard !== 'string') {
    return { ok: false, why: 'the step where it stopped no longer hands off' };
  }
  // The decision as it stands: the page's text and the ways the recipe knows.
  const read = readDecision(steps, decision.guard);
  if (read === undefined) {
    // Slice D4's check that a page still shows a value the recipe types hands off too, but chooses no way.
    return { ok: false, why: / is_empty$/u.test(decision.guard)
      ? 'it stopped where a page no longer showed a value the recipe types, which is not a choice between ways'
      : 'its decision was changed since, so Recued cannot tell what it tests' };
  }
  const { text, known, met } = read;
  const plain = met === undefined;
  const source = TEXT_REF.exec(text)![1]!;

  // The chat's decision: its first hand-off, and the steps it took after it.
  const chat = input.branch.steps as unknown as Step[];
  const chatAt = chat.findIndex((step) => step.hand_off === true && typeof step.guard === 'string');
  const chatGuard = chatAt < 0 ? null : PLAIN_GUARD.exec(chat[chatAt]!.guard as string);
  if (chatGuard === null) return { ok: false, why: 'nothing says what the page showed when your AI took this way' };
  const shown = chatGuard[2]!.trim();
  const chatSource = TEXT_REF.exec(chatGuard[1]!)![1]!;
  const way = chat.slice(chatAt + 1);
  if (way.length === 0) return { ok: false, why: 'your AI did nothing after the page showed it' };
  if (known.includes(shown)) return { ok: false, why: `the recipe already goes on when the page shows ${quoted(shown)}` };
  const before = known.find((one) => shown.includes(one));
  if (before !== undefined) {
    return { ok: false, why: `a page that shows ${quoted(shown)} also shows ${quoted(before)}, which the recipe goes on with first` };
  }
  if (way.some((step) => step.skip_when !== undefined)) return { ok: false, why: 'a step your AI took is already conditional' };
  if (plain && steps.slice(at + 1).some((step) => step.skip_when !== undefined)) {
    return { ok: false, why: 'a step after its decision already has a condition of its own' };
  }

  // The chat's steps under ids of their own, continued on the recipe's tab.
  const taken = new Set(steps.map((step) => step.id));
  const fresh = (base: string): string => {
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base}_${String(n)}`;
    taken.add(id);
    return id;
  };
  const letter = String.fromCharCode(97 + Math.min(known.length, 25));
  const prefix = `${input.step_id}_${letter}`;
  const rename = new Map<string, string>([[chatSource, source]]);
  for (const step of way) rename.set(step.id, fresh(`${prefix}_${step.id}`));
  let foreign: string | undefined;
  const settings = new Set<string>();
  const repoint = (value: unknown): unknown => {
    if (typeof value === 'string') {
      for (const [, name] of value.matchAll(CONFIG_REF)) settings.add(name!);
      return value.replace(STEP_REF, (whole, id: string) => {
        const to = rename.get(id);
        if (to === undefined) { foreign ??= id; return whole; }
        return `{{step.${to}`;
      });
    }
    if (Array.isArray(value)) return value.map(repoint);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, repoint(inner)]));
    }
    return value;
  };
  const moved = way.map((step) => ({ ...(repoint(step) as Step), id: rename.get(step.id)! }));
  if (foreign !== undefined) return { ok: false, why: 'a step your AI took uses something it read before the page showed it' };

  // Its settings, beside the recipe's own.
  const variables = { ...((input.recipe.variables ?? {}) as Record<string, unknown>) };
  for (const name of settings) {
    const theirs = (input.branch.variables as Record<string, unknown> | undefined)?.[name];
    if (theirs === undefined) continue;
    if (variables[name] === undefined) variables[name] = theirs;
    else if (JSON.stringify(variables[name]) !== JSON.stringify(theirs)) {
      return { ok: false, why: `a setting your AI's way needs, ${quoted(name)}, means something else in the recipe` };
    }
  }

  const host = /the job went on when (.+?) showed “/u.exec(String(decision.fail_reason ?? ''))?.[1] ?? 'the page';
  const all = [...known, shown];
  const ownWay = steps.slice(at + 1).map((step) => (plain ? { ...step, skip_when: `${text} not_contains ${known[0]!}` } : step));
  const metId = met?.id ?? fresh(`${input.step_id}_met`);
  const metStep: Step = { ...(met ?? {}), id: metId, transform: 'any', conditions: all.map((one) => `${text} contains ${one}`) };
  const gate: Step = { id: fresh(prefix), transform: 'any',
    conditions: [`${text} not_contains ${shown}`, ...known.map((one) => `${text} contains ${one}`)] };
  const guard: Step = { ...decision, guard: `{{step.${metId}}} equal false`, fail_reason: handOffReason(host, all) };
  const earlier = steps.slice(0, at).map((step) => (step.id === metId ? metStep : step));
  const merged = [
    ...earlier,
    ...(met === undefined ? [metStep] : []),
    guard,
    ...ownWay,
    gate,
    ...moved.map((step) => ({ ...step, skip_when: `{{step.${gate.id}}} equal true` })),
  ];

  const ai = usesAi(moved);
  const description = String(input.recipe.metadata?.description ?? '');
  const metadata = {
    ...input.recipe.metadata,
    description: `${ai ? description.replace(' It uses no AI.', '') : description} When ${host} shows ${quoted(shown)}, it goes on `
      + `the way your AI took then in the chat.${ai ? ' That way uses AI.' : ''}`,
  };
  return {
    ok: true,
    shown,
    recipe: { ...input.recipe, metadata, variables, steps: merged } as unknown as RecipeDefinition,
    note: `When ${host} shows ${quoted(shown)}, the recipe now goes on the way your AI took in the chat. It still stops, for you `
      + `to carry on, on a page that shows none of ${all.map(quoted).join(', ')}.`,
  };
};
