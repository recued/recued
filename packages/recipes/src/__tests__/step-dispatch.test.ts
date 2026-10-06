/** What a step dispatches to, in either form a recipe can write it. The sweep over
 *  the shipped corpus lives in `step-dispatch-corpus.test.ts`.
 *
 *  ⛔ The AI-hygiene checks found AI steps by `ingredient` alone. Every shipped AI
 *  step is `op: "core.ai.*"`, so they ran on none of them: `no_hash_before_ai` fired
 *  on 0 of 2,402 recipes, and the zero read as health. */
import { KERNEL_OP_REGISTRY, kernelOpsInDomain } from '@recued/contracts';
import { describe, expect, it } from 'vitest';

import { aiStepDispatch, stepDispatch } from '../step-dispatch.js';

describe('stepDispatch', () => {
  it('an ingredient step dispatches to its slug, `core-` stripped, with its input', () => {
    expect(stepDispatch({ id: 'a', ingredient: 'ai-classify', input: { 'llm.data': 'x' } }))
      .toEqual({ slug: 'ai-classify', payloadKey: 'input', payload: { 'llm.data': 'x' } });
    expect(stepDispatch({ id: 'a', ingredient: 'core-ai-summarize', input: { 'llm.data': 'x' } })?.slug)
      .toBe('ai-summarize');
  });

  it('a kernel op step dispatches to its backing ingredient, with its args', () => {
    expect(stepDispatch({ id: 'a', op: 'core.ai.summarize', args: { 'llm.data': 'x' } }))
      .toEqual({ slug: 'ai-summarize', payloadKey: 'args', payload: { 'llm.data': 'x' } });
    expect(stepDispatch({ id: 'a', op: 'core.notification.send', args: { text: 'hi' } })?.slug)
      .toBe('notification-send');
    // No args: an empty payload, never the step's stray `input`.
    expect(stepDispatch({ id: 'a', op: 'core.ai.prompt', input: { 'llm.prompt': 'x' } })?.payload).toEqual({});
  });

  it('nothing for a transform, a guard, an op with no backing ingredient, or a slot that is not a step', () => {
    for (const step of [
      { id: 'a', transform: 'pick', source: '{{step.x}}' },
      { id: 'a', guard: '{{step.x}} is_null' },
      { id: 'a', op: 'deal.read', args: {} }, // canonical CRM op: resolved per connection
      { id: 'a', op: 'recued-core.whisper.audio.transcribe', args: {} }, // pack op
      { id: 'a', op: 'core.ai.nonexistent', args: {} },
      null, 'ai-classify', ['ai-classify'],
    ]) {
      expect(stepDispatch(step), JSON.stringify(step)).toBeUndefined();
    }
  });

  it('aiStepDispatch: only a step that calls a model', () => {
    expect(aiStepDispatch({ id: 'a', op: 'core.ai.extract', args: {} })?.slug).toBe('ai-extract');
    expect(aiStepDispatch({ id: 'a', ingredient: 'ai-prompt', input: {} })?.slug).toBe('ai-prompt');
    expect(aiStepDispatch({ id: 'a', op: 'core.notification.send', args: {} })).toBeUndefined();
    expect(aiStepDispatch({ id: 'a', ingredient: 'mail-get', input: {} })).toBeUndefined();
  });

  it('agrees with the kernel op registry: an op is an AI step exactly when its domain is `ai`', () => {
    expect(kernelOpsInDomain('ai').length).toBeGreaterThan(5);
    const disagree = KERNEL_OP_REGISTRY
      .filter((entry) => entry.backing_slug !== undefined)
      .filter((entry) => (aiStepDispatch({ id: 'a', op: entry.op, args: {} }) !== undefined) !== (entry.domain === 'ai'))
      .map((entry) => entry.op);
    expect(disagree).toEqual([]);
  });
});
