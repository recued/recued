/** D-402 slice E2 (§6.3) — the owner's chat says why: one call to the owner's models labels where the
 *  request used judgement, each label checked against the record (`plan-labels.ts`), and "Make a recipe"
 *  compiles the ones it holds into AI steps (E1); the others are left out and said. */
import { describe, expect, it, vi } from 'vitest';
import type { BrowserPlanActedStep, BrowserPlanCallWithSteps } from '../bridges/browser-flow-record.js';
import type { ExecuteChatAiCall } from '../chat-orchestrator.js';
import { labelPlan, planLabelsData, PLAN_LABELS_INSTRUCTION, PLAN_LABELS_MANIFEST } from '../plan-labels.js';
import { makeRequestRecipeDraft } from '../request-recipe.js';

const MAIL = 'https://mail.example.com/inbox/42';
const HANDLE = 'bridge:work:3:M1';
const acted = (position: number, kind: BrowserPlanActedStep['do'], role: string, label: string, over: Partial<BrowserPlanActedStep> = {}): BrowserPlanActedStep =>
  ({ do: kind, url: MAIL, title: 'Inbox', element: { role, label, selector: `#${label.toLowerCase()}` }, at: 1, position, ...over });
/** A reply: the message read, Reply clicked, a password typed (a secret: no value kept), the answer typed and sent. */
const calls = (): BrowserPlanCallWithSteps[] => [
  { run_id: 'r1', recipe_id: 'inspect-web-page', args: { page: MAIL }, started_at: 1, finished_at: 1, outcome: 'done', bridge_ids: ['work'], acted: [],
    results: [{ step_id: 'inspect', result: { page: HANDLE, url: MAIL } }], reads: [{ page: HANDLE, url: MAIL, html: '<main><p>Can we meet on Monday?</p></main>' }] },
  { run_id: 'r2', recipe_id: 'act-on-web-page', args: { page: HANDLE, steps: [{ do: 'click', ref: 'e1' }, { do: 'type', ref: 'e2', typed: true },
    { do: 'type', ref: 'e3', typed: true }, { do: 'click', ref: 'e4' }] }, started_at: 2, finished_at: 2, outcome: 'done', bridge_ids: ['work'],
  acted: [acted(1, 'click', 'button', 'Reply'), acted(2, 'type', 'text box', 'Password', { secret: true, value: 'hunter2' }),
    acted(3, 'type', 'text box', 'Message', { value: 'Yes, Monday at 10 works for me.' }), acted(4, 'click', 'button', 'Send')],
  results: [{ step_id: 'act', result: { done: 4, of: 4, page: HANDLE, url: MAIL } }] },
];
const WRITE = { kind: 'write', chose: 'Monday at 10 works for me', criterion: 'A short reply that accepts the meeting.' };
const answering = (body: unknown) => vi.fn<ExecuteChatAiCall>(async () => ({ body }));

describe('D-402 slice E2 — the labelling call', () => {
  it('is given the request, the reply and the steps, numbered, with what was typed and never a secret', () => {
    // Even a secret's value a recorder held by mistake is never given.
    expect(JSON.stringify(planLabelsData({ calls: calls() }))).not.toContain('hunter2');
    expect(planLabelsData({ request: 'Answer Bob that Monday works', reply: 'Done: I replied to Bob.', calls: calls() })).toEqual({
      request: 'Answer Bob that Monday works', reply: 'Done: I replied to Bob.', steps: [
        { n: 1, did: 'read', page: 'mail.example.com/inbox/42' },
        { n: 2, did: 'click', page: 'mail.example.com/inbox/42', element: 'button “Reply”' },
        { n: 3, did: 'type', page: 'mail.example.com/inbox/42', element: 'text box “Password”' },
        { n: 4, did: 'type', page: 'mail.example.com/inbox/42', element: 'text box “Message”', typed: 'Yes, Monday at 10 works for me.' },
        { n: 5, did: 'click', page: 'mail.example.com/inbox/42', element: 'button “Send”' },
      ] });
  });

  it('slice E4d — a request that carried on a run says so: the recipe and the ways it goes on with', () => {
    const data = planLabelsData({ request: 'Carry on with the lamp.', calls: calls(),
      carried_on: { recipe: 'Buy the lamp', went_on_when: ['In stock', 'Pre-order'] } });
    expect(data.carried_on).toEqual({ recipe: 'Buy the lamp', went_on_when: ['In stock', 'Pre-order'] });
    expect(planLabelsData({ calls: calls() })).not.toHaveProperty('carried_on');
    // The instruction names the field, and what the way taken there is labelled.
    expect(PLAN_LABELS_INSTRUCTION).toContain('- "decide" too, when the data has "carried_on"');
    expect(PLAN_LABELS_INSTRUCTION).toContain('give that text as "chose", never one of "went_on_when".');
  });

  it('asks the owner\'s models once, fast, in the D-116 shape, and keeps each label the record holds', async () => {
    const call = answering({ judgements: [WRITE, { kind: 'pick', chose: 'Delete everything', criterion: 'x' }, { kind: 'guess', criterion: 'y' }] });
    const answer = await labelPlan(call, { request: 'Answer Bob', calls: calls() });
    expect(call).toHaveBeenCalledTimes(1);
    const [manifest, input, opts] = call.mock.calls[0]!;
    expect(manifest).toBe(PLAN_LABELS_MANIFEST);
    expect(input).toMatchObject({ 'llm.instruction_block': PLAN_LABELS_INSTRUCTION, 'llm.output_format': 'json', 'llm.model_hint': 'fast' });
    expect(input['llm.data_block']).toMatchObject({ request: 'Answer Bob' });
    expect(opts).toMatchObject({ timeout_ms: 45_000 });
    // The write is the record's; the pick names nothing the request did; the third is no kind at all.
    expect(answer).toEqual({ ok: true, judgements: [WRITE], left_out: [{ kind: 'pick', chose: 'Delete everything', criterion: 'x' }] });
  });

  it('a call that fails, or answers no list, says why', async () => {
    const failing = vi.fn<ExecuteChatAiCall>(async () => { throw new Error('no model is configured'); });
    expect(await labelPlan(failing, { calls: calls() })).toEqual({ ok: false, reason: 'no model is configured' });
    expect(await labelPlan(answering('not json'), { calls: calls() })).toEqual({ ok: false, reason: 'its answer held no list of judgements' });
  });
});

describe('D-402 slice E2 — "Make a recipe" with the labels', () => {
  const kitchen = () => {
    const made: Array<{ source: string; notes?: readonly string[] }> = [];
    return { made, store: { createCompiled: (input: { source: string; notes?: readonly string[] }) => {
      made.push(input);
      return { draft_id: `d${String(made.length)}`, ...input } as never;
    } } };
  };
  const make = (labelPlan?: Parameters<typeof makeRequestRecipeDraft>[0]['labelPlan']) => {
    const k = kitchen();
    const run = makeRequestRecipeDraft({ flows: { planFor: () => calls() }, resolveRoot: () => 'req-1', kitchenDrafts: k.store as never,
      answerOf: async () => ({ request: 'Answer Bob that Monday works', reply: 'Replied.' }), ...(labelPlan !== undefined ? { labelPlan } : {}) });
    return { k, run: () => run({ session_id: 's1', turn_id: 't1' }) };
  };

  it('a write the record holds becomes the AI step that writes the text typed, from the page, at each run (E1)', async () => {
    const seen: unknown[] = [];
    const { k, run } = make(async (input) => { seen.push(input); return { ok: true, judgements: [WRITE as never], left_out: [] }; });
    expect(await run()).toMatchObject({ ok: true });
    expect(seen).toEqual([{ calls: calls(), request: 'Answer Bob that Monday works', reply: 'Replied.' }]);
    const recipe = JSON.parse(k.made[0]!.source) as { steps: Array<{ id: string; op?: string }> };
    expect(recipe.steps.find((step) => step.op === 'core.ai.prompt')).toMatchObject({ id: 'write_1' });
  });

  it('a label left out, and a call that failed, are said; the draft is made either way', async () => {
    const left = make(async () => ({ ok: true, judgements: [], left_out: [{ kind: 'pick', chose: 'Delete everything', criterion: 'x' }] }));
    expect(await left.run()).toMatchObject({ ok: true });
    expect(left.k.made[0]!.notes).toContain('Your AI said it used judgement choosing “Delete everything”, but nothing this request did or read '
      + 'shows it, so the draft does not use that label.');
    const failed = make(async () => ({ ok: false, reason: 'no model is configured' }));
    expect(await failed.run()).toMatchObject({ ok: true });
    expect(failed.k.made[0]!.notes).toContain('Your AI could not say where the request used judgement (no model is configured), so the draft '
      + 'repeats what the request typed and read.');
    const thrown = make(async () => { throw new Error('boom'); });
    expect(await thrown.run()).toMatchObject({ ok: true });
    // Without the call, as before.
    const none = make();
    expect(await none.run()).toMatchObject({ ok: true });
    expect(JSON.parse(none.k.made[0]!.source).steps.some((step: { op?: string }) => step.op === 'core.ai.prompt')).toBe(false);
  });
});
