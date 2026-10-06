import { expect, it } from 'vitest';
import { coerceAIOutput } from '@recued/contracts';
import { MAIL_WORK_PLANNING_CHOICE, MAIL_WORK_PROPOSAL_REMINDER, mailWorkContractTask,
  mailWorkTurnContractPrompt, measureMailWorkEdit, validateMailWorkTurn } from '../mail-work-turn-contract.js';
import type { MailWorkTurnContract } from '../mail-work-turn-contract.js';

const ids = new Set(['s1', 's2']);
const ending = `${MAIL_WORK_PROPOSAL_REMINDER} ${MAIL_WORK_PLANNING_CHOICE}`;
const original = `Privately draft a client reply explaining the changed scope. Keep the remaining questions about timing and cost visible. ${ending}`;
const edit: MailWorkTurnContract = { task: 'refine', original_plan: original, require_shorter: true };
const proposal = () => ({ turn_type: 'propose', mail_work_recap: [{ id: 's1', state: 'current' }],
  response: `Privately draft the reply. Scope and timing remain uncertain. ${ending}`,
  uncertainties: ['Scope and timing'], events: [], tool_calls: [], nothing_outstanding: true });
const refined = () => ({ ...proposal(), turn_type: 'refine', changes: ['Shortened the first private step.'] });
const investigation = () => ({ turn_type: 'investigate', mail_work_recap: [{ id: 's1', state: 'current' }],
  response: 'The sources support a provisional plan; scope is still open.', gaps: ['Scope'], next: 'ready',
  events: [], tool_calls: [] as unknown[], nothing_outstanding: false });
const investigate: MailWorkTurnContract = { task: 'investigate', available_tools: ['mail.read', 'mail.search'] };

it('allows investigation to continue, reach provisional readiness with gaps, or ask the owner', () => {
  const next = investigation();
  expect(validateMailWorkTurn(next, investigate, ids)).toMatchObject({ ok: true, semantic_review: 'required' });
  next.next = 'continue'; next.tool_calls = [{ tool: 'mail.search', args: { query: 'scope' } }]; next.mail_work_recap = [];
  expect(validateMailWorkTurn(next, investigate, ids).ok).toBe(true);
  next.next = 'ask_owner'; next.tool_calls = []; next.response = 'Which work should I investigate?';
  expect(validateMailWorkTurn(next, investigate, ids).ok).toBe(true);
});

it.each(['continue without tools', 'ready with tools', 'unknown tool', 'missing gap', 'ready without sources', 'closed planning', 'array next'])(
  'rejects investigation mismatch: %s', failure => {
    const reply: any = investigation();
    if (failure === 'continue without tools') reply.next = 'continue';
    if (failure === 'ready with tools') reply.tool_calls = [{ tool: 'mail.read', args: {} }];
    if (failure === 'unknown tool') { reply.next = 'continue'; reply.tool_calls = [{ tool: 'invented', args: {} }]; }
    if (failure === 'missing gap') { reply.next = 'ask_owner'; reply.gaps = []; }
    if (failure === 'ready without sources') reply.mail_work_recap = [];
    if (failure === 'closed planning') reply.nothing_outstanding = true;
    if (failure === 'array next') reply.next = ['ready'];
    expect(validateMailWorkTurn(reply, investigate, ids).ok).toBe(false);
  });

it('requires raw fields before Chat coercion can conceal their omission', () => {
  const reply: any = proposal(); delete reply.events; delete reply.tool_calls;
  expect(validateMailWorkTurn(reply, { task: 'propose' }, ids)).toMatchObject({ ok: false, issues: expect.arrayContaining(['missing_required_fields']) });
  expect(validateMailWorkTurn(coerceAIOutput(reply), { task: 'propose' }, ids).ok).toBe(true);
});

it.each(['wrong task', 'unknown source', 'duplicate source', 'array state', 'missing uncertainties', 'unexpected field', 'blank response', 'tool in plan', 'event in plan', 'missing ending'])(
  'rejects a plan with %s without repairing the object', failure => {
    const reply: any = proposal();
    if (failure === 'wrong task') reply.turn_type = 'refine';
    if (failure === 'unknown source') reply.mail_work_recap[0].id = 'unknown';
    if (failure === 'duplicate source') reply.mail_work_recap.push({ ...reply.mail_work_recap[0] });
    if (failure === 'array state') reply.mail_work_recap[0].state = ['current'];
    if (failure === 'missing uncertainties') delete reply.uncertainties;
    if (failure === 'unexpected field') reply.success = true;
    if (failure === 'blank response') reply.response = ' ';
    if (failure === 'tool in plan') reply.tool_calls = [{ tool: 'mail.send', args: {} }];
    if (failure === 'event in plan') reply.events = [{ kind: 'new_task' }];
    if (failure === 'missing ending') reply.response = 'A draft without the requested choice.';
    const saved = structuredClone(reply);
    expect(validateMailWorkTurn(reply, { task: 'propose' }, ids).ok).toBe(false);
    expect(reply).toEqual(saved);
  });

it('detects exact and whitespace-only copies even when the change summary claims success', () => {
  const reply = refined(); reply.response = original;
  expect(validateMailWorkTurn(reply, edit, ids)).toMatchObject({ ok: false,
    issues: expect.arrayContaining(['unchanged_edit', 'edit_not_shorter']), edit: { changed: false, shorter: false } });
  reply.response = original.replaceAll(' ', '\n  ');
  expect(validateMailWorkTurn(reply, edit, ids)).toMatchObject({ ok: false, edit: { changed: false, shorter: false } });
});

it('distinguishes a real shortening from a longer or equally long rewrite', () => {
  expect(validateMailWorkTurn(refined(), edit, ids)).toMatchObject({ ok: true, edit: { changed: true, shorter: true } });
  const reply = refined(); reply.response = original.replace('Privately', 'Initially');
  expect(validateMailWorkTurn(reply, edit, ids)).toMatchObject({ ok: false, issues: ['edit_not_shorter'], edit: { changed: true, shorter: false } });
  expect(validateMailWorkTurn(reply, { ...edit, require_shorter: false }, ids).ok).toBe(true);
  reply.response = 'Add further details. ' + original;
  expect(validateMailWorkTurn(reply, edit, ids).issues).toContain('edit_not_shorter');
});

it('does not invent an editing target or accept an empty change summary', () => {
  expect(validateMailWorkTurn(refined(), { ...edit, original_plan: '' }, ids).issues).toContain('missing_original_plan');
  expect(validateMailWorkTurn({ ...refined(), changes: [] }, edit, ids).issues).toContain('invalid_change_summary');
});

it('leaves fact meaning, permission scope and preservation of work for semantic review', () => {
  const reply = refined(); reply.mail_work_recap[0]!.state = 'superseded';
  reply.response = `Contact everyone immediately. ${ending}`;
  const result = validateMailWorkTurn(reply, edit, ids);
  expect(result).toMatchObject({ ok: true, semantic_review: 'required', edit: { changed: true, shorter: true } });
  // A shorter, well-shaped answer is not a semantic pass or execution authority.
});

it('derives editing limits from the actual target and names the exact measurement', () => {
  const measure = measureMailWorkEdit('one two three', 'one two');
  expect(measure).toMatchObject({ original_words: 3, revised_words: 2, changed: true, shorter: true });
  expect(mailWorkContractTask({ task: 'refine', original_plan: 'one two three', require_shorter: true })).toMatchObject({
    task: 'refine', maximum_response_words: 2, maximum_response_characters: 12, require_change: true });
});

it.each([investigate, { task: 'propose' } as const, edit])('supplies only the current task format for $task', contract => {
  const prompt = mailWorkTurnContractPrompt(contract);
  const shape = JSON.parse(prompt.split('Return exactly: ')[1]!);
  expect(shape.turn_type).toBe(contract.task);
  expect(prompt).not.toMatch(/Cobalt|Quartz|October|\$4,800/u);
  expect(Object.hasOwn(shape, 'changes')).toBe(contract.task === 'refine');
  expect(Object.hasOwn(shape, 'gaps')).toBe(contract.task === 'investigate');
  expect(Object.hasOwn(shape, 'uncertainties')).toBe(contract.task !== 'investigate');
});
