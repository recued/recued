import { expect, it } from 'vitest';
import { createMailWorkEvidence, parseMailWorkEvidence, MAIL_WORK_EVIDENCE_MAX_CHARS } from '../mail-work-evidence.js';
import { mailWorkPassageCatalog } from '../mail-work-source-recap.js';
import { mailWorkEditTarget, mailWorkEditPrompt, mailWorkEditSchema, renderMailWorkEdits,
  readMailWorkEditTarget, withMailWorkEditTarget } from '../mail-work-plan-edit.js';

const setup = () => {
  const carry = createMailWorkEvidence(null, 'Privately prepare a guide and response. Timing and cost are open.', true, 1);
  carry.record({ tool_name: 'mail.read', tier: 1, args: { slug: 'mail', record_id: 'one' },
    status: 'ok', started_at: 1, completed_at: 2, result: { body: 'Please explore a guide.', source_url: '#data/mail/record/mail/one' } });
  const facts = mailWorkPassageCatalog(carry.snapshot()).map(row => row.id);
  const plan = { task: 'propose', facts, actions: [
    { operation: 'draft', target: 'the response', context: facts, source_notes: [] },
    { operation: 'outline', target: 'the guide', context: facts, source_notes: [] },
  ], questions: [{ kind: 'cost', context: facts }, { kind: 'timing', context: facts }] };
  const target = mailWorkEditTarget(plan, carry.snapshot())!;
  const edits = { task: 'refine', base: target.base, facts: null, action_edits: [] as any[], question_edits: [] as any[] };
  return { carry, facts, plan, target, edits };
};

it('retains every unedited deliverable, its order, and open questions when shortening one item', () => {
  const { carry, plan, target, edits } = setup();
  edits.action_edits.push({ kind: 'update', id: 'action_1', value: { ...plan.actions[0], target: 'a brief response' }, after: null });
  const result = renderMailWorkEdits(edits, target, carry.snapshot());
  expect(result.ok).toBe(true);
  expect(result.declaration).toEqual({ ...target.plan, actions: [{ ...plan.actions[0], target: 'a brief response' }, plan.actions[1]] });
  expect(target.plan.actions).toEqual(plan.actions);
  expect(result.text).toContain('What cost information');
  expect(result.text).toContain('What timing');
});

it('allows explicit removal, reordering, additions and corrections without executing work', () => {
  const { carry, plan, target, edits } = setup();
  edits.action_edits.push({ kind: 'move', id: 'action_2', value: null, after: 'start' },
    { kind: 'update', id: 'action_1', value: { ...plan.actions[0], operation: 'send' }, after: null },
    { kind: 'add', id: null, value: { ...plan.actions[0], operation: 'compare', target: 'two formats' }, after: null });
  edits.question_edits.push({ kind: 'remove', id: 'question_1', value: null, after: null });
  const result = renderMailWorkEdits(edits, target, carry.snapshot());
  expect(result.ok).toBe(true);
  expect((result.declaration!.actions as any[]).map(row => row.target)).toEqual(['the guide', 'the response', 'two formats']);
  expect(result.declaration!.questions).toEqual([plan.questions[1]]);
  expect(result.text).toContain('After your approval: Send the response');
});

it.each(['wrong_base', 'unknown_id', 'duplicate_update', 'unknown_passage', 'extra_field', 'invalid_remove',
  'removed_destination', 'self_move', 'too_many_items', 'alias', 'wrong_task'])(
  'rejects %s atomically without changing the previous plan', defect => {
    const { carry, plan, target, edits } = setup();
    edits.action_edits.push({ kind: 'update', id: 'action_1', value: { ...plan.actions[0], target: 'a brief response' }, after: null });
    const change = edits.action_edits[0];
    if (defect === 'wrong_base') edits.base += 'wrong';
    if (defect === 'unknown_id') change.id = 'action_42';
    if (defect === 'duplicate_update') edits.action_edits.push(change);
    if (defect === 'unknown_passage') change.value.context = ['passage_unknown'];
    if (defect === 'extra_field') change.permission = true;
    if (defect === 'invalid_remove') change.kind = 'remove';
    if (defect === 'removed_destination') edits.action_edits = [
      { kind: 'remove', id: 'action_1', value: null, after: null }, { kind: 'move', id: 'action_2', value: null, after: 'action_1' }];
    if (defect === 'self_move') edits.action_edits = [{ kind: 'move', id: 'action_1', value: null, after: 'action_1' }];
    if (defect === 'too_many_items') edits.action_edits = Array(5).fill({ kind: 'add', id: null, value: plan.actions[0], after: null });
    if (defect === 'alias') change.value.target = 'a note for pii.Person9';
    if (defect === 'wrong_task') edits.task = 'propose';
    const before = structuredClone(target);
    expect(renderMailWorkEdits(edits, target, carry.snapshot())).toMatchObject({ ok: false, items: [] });
    expect(target).toEqual(before);
  });

it('invalidates source-bound edits after a denied reread instead of preserving stale work', () => {
  const { carry, target, edits } = setup();
  carry.record({ tool_name: 'mail.read', tier: 1, args: { slug: 'mail', record_id: 'one' },
    status: 'error', started_at: 3, completed_at: 4 });
  expect(mailWorkEditTarget(target.plan, carry.snapshot())).toBeNull();
  expect(renderMailWorkEdits(edits, target, carry.snapshot()).ok).toBe(false);
});

it('persists the proposal separately from evidence and exposes no private target text in the schema', () => {
  const { carry, target } = setup();
  const json = withMailWorkEditTarget(carry.serializable()!, target);
  expect(readMailWorkEditTarget(json, parseMailWorkEvidence(json))).toEqual(target);
  expect(parseMailWorkEvidence(json)).toEqual(carry.snapshot());
  expect(JSON.stringify(createMailWorkEvidence(parseMailWorkEvidence(json), 'Continue', false, 3).asCall()))
    .not.toContain('the response');
  expect(mailWorkEditPrompt(target).actions[0]).toMatchObject({ id: 'action_1', target: 'the response' });
  expect(JSON.stringify(mailWorkEditSchema(target, carry.snapshot()))).not.toContain('the response');
  expect(readMailWorkEditTarget(carry.serializable(), carry.snapshot())).toBeNull();
  expect(readMailWorkEditTarget('{bad', carry.snapshot())).toBeNull();
});

it('keeps exact evidence if the optional proposal would exceed the existing storage bound', () => {
  const { carry, target } = setup();
  const json = JSON.stringify({ ...carry.snapshot(), padding: 'x'.repeat(MAIL_WORK_EVIDENCE_MAX_CHARS - carry.serializable()!.length - 16) });
  expect(json.length).toBeLessThan(MAIL_WORK_EVIDENCE_MAX_CHARS);
  expect(withMailWorkEditTarget(json, target)).toBe(json);
});

it('does not let a valid proposal filename invalidate durable evidence at the reader boundary', () => {
  const { carry, plan } = setup();
  plan.actions[0]!.target = 'the pii.csv export';
  const target = mailWorkEditTarget(plan, carry.snapshot());
  expect(target).not.toBeNull();
  const json = withMailWorkEditTarget(carry.serializable()!, target);
  expect(parseMailWorkEvidence(json)).toEqual(carry.snapshot());
  expect(readMailWorkEditTarget(json, carry.snapshot())).toBeNull();
});


it.each(['start', 'action_1', null])('inserts new work at %s without displacing or rewriting existing items', after => {
  const { carry, plan, target, edits } = setup();
  const inserted = { ...plan.actions[0], target: 'a requirements checklist' };
  edits.action_edits = [{ kind: 'add', id: null, value: inserted, after }];
  const result = renderMailWorkEdits(edits, target, carry.snapshot());
  expect(result.ok).toBe(true);
  const actions = result.declaration!.actions as unknown[];
  expect(actions.indexOf(actions.find(row => JSON.stringify(row) === JSON.stringify(inserted))))
    .toBe(after === 'start' ? 0 : after === 'action_1' ? 1 : 2);
  expect(actions.filter(row => JSON.stringify(row) !== JSON.stringify(inserted))).toEqual(plan.actions);
  expect(result.declaration!.questions).toEqual(plan.questions);
});

it('rejects insertion after a removed or unknown item without accepting any edits', () => {
  const { carry, plan, target, edits } = setup();
  for (const after of ['action_1', 'action_99']) {
    edits.action_edits = [{ kind: 'remove', id: 'action_1', value: null, after: null },
      { kind: 'add', id: null, value: plan.actions[0], after }];
    expect(renderMailWorkEdits(edits, target, carry.snapshot()).ok).toBe(false);
  }
});
