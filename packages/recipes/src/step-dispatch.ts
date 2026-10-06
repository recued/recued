/** What a step dispatches to, in either form a recipe can write it.
 *
 *  An `ingredient` step names its slug and hands it `input`. A kernel op step
 *  (`op: "core.ai.summarize"`) dispatches as the op's backing ingredient
 *  (`core-ai-summarize`), and its `args` ARE that ingredient's `input`
 *  (`resolveKernelClosedKindOpStep`). Either way the slug comes back with any
 *  `core-` alias stripped, so `ai-summarize` names both.
 *
 *  ⛔ A check that reads only `ingredient` never sees an op step, and every shipped
 *  AI step is one: 371 steps in 328 recipes, none in ingredient form (measured
 *  2026-10-06). The AI-hygiene checks — guard-before-AI, `no_hash_before_ai`,
 *  `prefer_pii_protect`, the AI TTL floor, the ai-prompt system-prompt check, the
 *  model-hint check — ran on none of them, and the AI input rule missed 16 broken
 *  summaries the same way (`validate/contracts.ts`). The PII trace resolves an op
 *  step like this too (`recipe-pii-trace.ts`). */

import { getKernelOp, stripCorePrefix } from '@recued/contracts';

export interface StepDispatch {
  /** The ingredient the step dispatches to, `core-` stripped (`ai-summarize`). */
  slug: string;
  /** Where the step's payload sits: `input` (ingredient step) or `args` (op step). */
  payloadKey: 'input' | 'args';
  /** That payload; `{}` when the step carries none. */
  payload: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

/** The ingredient a step dispatches to and the payload it hands it; undefined for a
 *  transform, a guard, an op with no backing ingredient (a canonical CRM op, a pack
 *  op, a native verb-op), or a step slot that is not an object — validators run on
 *  partly broken recipes too. */
export const stepDispatch = (step: unknown): StepDispatch | undefined => {
  if (!isRecord(step)) return undefined;
  if (typeof step.ingredient === 'string') {
    return { slug: stripCorePrefix(step.ingredient), payloadKey: 'input', payload: asRecord(step.input) };
  }
  if (typeof step.op === 'string') {
    const backing = getKernelOp(step.op)?.backing_slug;
    if (backing !== undefined) {
      return { slug: stripCorePrefix(backing), payloadKey: 'args', payload: asRecord(step.args) };
    }
  }
  return undefined;
};

/** The step's dispatch when it calls a model (an `ai-*` function), else undefined. */
export const aiStepDispatch = (step: unknown): StepDispatch | undefined => {
  const dispatch = stepDispatch(step);
  return dispatch !== undefined && dispatch.slug.startsWith('ai-') ? dispatch : undefined;
};
