import { expect, it } from 'vitest';
import { decodeMailWorkReview, MAIL_WORK_CONDITION_REF_FORMAT, MAIL_WORK_QUOTED_CONDITION_FORMAT, MAIL_WORK_SECTION_FORMAT } from '../mail-work-review-sections.js';
import { groundLinkedMailWorkClaims } from '../mail-work-linked-source-review.js';
import { renderMailWorkAction } from '../mail-work-action-renderer.js';
import { MAIL_WORK_SECTION_EXAMPLE, MAIL_WORK_SCOPED_EXAMPLE_SOURCES, MAIL_WORK_SCOPED_SECTION_EXAMPLE,
  MAIL_WORK_CONDITION_EXAMPLE_SOURCES, MAIL_WORK_CONDITION_SECTION_EXAMPLE,
  MAIL_WORK_ACTION_SELECTION_EXAMPLE_SOURCES, MAIL_WORK_ACTION_SELECTION_SECTION_EXAMPLE,
  MAIL_WORK_QUOTED_CONDITION_SECTION_EXAMPLE } from '../mail-work-prompt-templates.js';

const owner = 'Ask me before contacting anyone. You may send the outline to Jo.';
const sources = new Map([
  ['mail_source_1', { text: 'Please explore a private outline.', label: 'Email' }],
  ['owner_notes', { text: owner, label: 'Your notes' }],
]);
const example = () => JSON.parse(JSON.stringify(MAIL_WORK_SECTION_EXAMPLE));
const run = (value: unknown) => {
  const decoded = decodeMailWorkReview(value);
  return groundLinkedMailWorkClaims(decoded.claims as unknown[], sources).map(c => c.kind === 'next_action'
    ? { ...c, rendered: renderMailWorkAction(c.action, String(c.text), owner, new Set(['mail_source_1'])) } : c);
};

it('the complete displayed format binds selected facts and declares all four action modes once', () => {
  const input = example(), before = structuredClone(input);
  const claims = run(input);
  expect(input).toEqual(before);
  expect(claims.filter(c => c.kind === 'next_action').map(c => (c as { rendered?: { text: string } }).rendered?.text)).toEqual([
    'Private preparation: Draft a private outline with placeholders.',
    'After your approval: Ask the requester about open details.',
    'Proposed next step: Choose the next draft in this Chat.',
    'Waiting for your approval: Await the owner decision about contact.',
  ]);
  expect(claims.find(c => c.id === 'a1')).toMatchObject({ sources: ['mail_source_1'], targets: ['f1', 'f2'],
    action: { scope: 'Draft a private outline with placeholders.', permission: 'not_contact', permission_quote: null } });
  expect(claims.find(c => c.id === 'a4')).toMatchObject({ sources: [], targets: ['f2'] });
});

it('the worked example keeps the private draft available and binds both contact approvals and the scoped prerequisite', () => {
  const input = structuredClone(MAIL_WORK_SCOPED_SECTION_EXAMPLE), before = structuredClone(input);
  const examples = new Map(Object.entries(MAIL_WORK_SCOPED_EXAMPLE_SOURCES).map(([source, text]) => [source, { text, label: source }]));
  const claims = groundLinkedMailWorkClaims(decodeMailWorkReview(input).claims as unknown[], examples);
  const actions = claims.filter(c => c.kind === 'next_action');
  expect(actions.map(c => renderMailWorkAction(c.action, String(c.text), MAIL_WORK_SCOPED_EXAMPLE_SOURCES.owner_notes, new Set(examples.keys())))).toEqual([
    { text: 'Private preparation: Draft the audio guide with quotation placeholders.', sources: [] },
    { text: 'After your approval: Ask the editor to check quotations.', sources: [] },
    { text: 'After your approval: Ask the artist to record the guide. Conditions for Ask the artist to record the guide.: The editor has checked the quotations.', sources: ['mail_source_2'] },
  ]);
  expect(actions.map(c => c.sources)).toEqual([['mail_source_1'], ['mail_source_1', 'mail_source_2'], ['mail_source_1', 'mail_source_2']]);
  expect(claims.find(c => c.id === 'f3')).toMatchObject({ basis: 'owner', excerpt: { state: 'current', source: 'owner_notes' } });
  expect(claims.find(c => c.id === 'f4')).toMatchObject({ basis: 'owner', excerpt: { state: 'current', quote: 'Ask me before contacting anyone.' } });
  expect(input).toEqual(before);
});

it('the selection example renders status separately from the two exact checks on the affected contact', () => {
  const input = structuredClone(MAIL_WORK_ACTION_SELECTION_SECTION_EXAMPLE), before = structuredClone(input);
  const examples = new Map(Object.entries(MAIL_WORK_ACTION_SELECTION_EXAMPLE_SOURCES).map(([source, text]) => [source, { text, label: source }]));
  const claims = groundLinkedMailWorkClaims(decodeMailWorkReview(input).claims as unknown[], examples);
  const actions = claims.filter(c => c.kind === 'next_action');
  const rendered = actions.map(c => renderMailWorkAction(c.action, String(c.text), MAIL_WORK_ACTION_SELECTION_EXAMPLE_SOURCES.owner_notes, new Set(examples.keys())));
  expect(claims.find(c => c.id === 'f2')).toMatchObject({ kind: 'progress', excerpt: { quote: 'The studio has not approved a slot.' } });
  expect(actions[0]).toMatchObject({ sources: ['mail_source_1'], action: { permission: 'not_contact', conditions: [] } });
  expect(actions[1]).toMatchObject({ action: { permission: 'requires_owner_approval', conditions: [] } });
  expect(actions[2]).toMatchObject({ action: { permission: 'requires_owner_approval', conditions: [
    { text: 'Check available slots before asking the artist to record.', sources: ['mail_source_2'], owner_quote: null, source_quote: true },
    { text: 'Check pronunciation with me before asking the artist to record.', sources: [], owner_quote: 'Check pronunciation with me before asking the artist to record.', source_quote: true },
  ] } });
  expect(rendered[0]?.text).toBe('Private preparation: Draft the audio guide with placeholders.');
  expect(rendered[1]?.text).toBe('After your approval: Ask the studio for available slots.');
  expect(rendered[2]?.text).toContain('After your approval: Ask the artist to record the guide.');
  expect(rendered[2]?.text).not.toContain('not approved a slot');
  expect(rendered[2]?.sources).toEqual(['mail_source_2']);
  expect(input).toEqual(before);
  // These are the authored example's bindings, not proof of model selection.
});

it('binds a condition to its activity without treating legacy permission prose as a grant', () => {
  const input = example();
  input.actions[1].activity = 'Send the outline to Jo.';
  input.actions[1].conditions = [{ text: 'Use the supplied scope.', sources: ['mail_source_1'], owner_quote: null }];
  const action = run(input).find(c => c.id === 'a2');
  expect(action).toMatchObject({ action: { scope: 'Send the outline to Jo.',
    conditions: [{ scope: 'Send the outline to Jo.', text: 'Use the supplied scope.' }] } });
  expect((action as { rendered: { text: string } }).rendered.text).toContain('After your approval:');
  input.actions[1].permission = { kind: 'explicitly_permitted', quote: 'You may send the outline to Jo.' };
  expect(() => run(input)).toThrow();
});

it.each([
  ['missing permission', (v: any) => { delete v.actions[0].permission; }],
  ['missing activity', (v: any) => { delete v.actions[0].activity; }],
  ['missing conditions', (v: any) => { delete v.actions[0].conditions; }],
  ['missing section', (v: any) => { delete v.questions; }],
  ['question masquerading as fact', (v: any) => { v.facts[0].kind = 'question'; }],
  ['legacy basis on fact', (v: any) => { v.facts[0].basis = 'email'; }],
  ['legacy action object', (v: any) => { v.actions[0].action = {}; }],
  ['wait restriction used as permission', (v: any) => { v.actions[3].permission.quote = 'Ask me before contacting anyone.'; }],
  ['null quote on required approval', (v: any) => { v.actions[1].permission.quote = null; }],
  ['approval-free contact', (v: any) => { v.actions[1].permission.kind = 'not_contact'; }],
  ['explicit permission on wait', (v: any) => { v.actions[3].permission = { kind: 'explicitly_permitted', quote: 'You may send the outline to Jo.' }; }],
  ['missing explicit quote', (v: any) => { v.actions[1].permission = { kind: 'explicitly_permitted' }; }],
  ['approval before private work', (v: any) => { v.actions[0].permission.kind = 'requires_owner_approval'; }],
  ['condition tries another scope', (v: any) => { v.actions[0].conditions = [{ scope: 'another activity', text: 'Wait.', sources: [], owner_quote: null }]; }],
  ['undeclared current target', (v: any) => { v.actions[0].targets = ['missing']; }],
  ['targeting a question', (v: any) => { v.actions[0].targets = ['q1']; }],
  ['missing factual targets', (v: any) => { v.actions[0].targets = []; }],
  ['duplicate ID', (v: any) => { v.actions[0].id = 'f1'; }],
  ['unknown top-level field', (v: any) => { v.claims = []; }],
  ['oversize activity', (v: any) => { v.actions[0].activity = 'x'.repeat(161); }],
] as const)('rejects %s instead of filling or reclassifying a declaration', (_name, mutate) => {
  const value = example(); mutate(value);
  expect(() => run(value)).toThrow('previous review is unchanged');
});

it.each([
  ['wrong quoted source', (v: any) => { v.facts[0].source = 'owner_notes'; }],
  ['unknown mail token', (v: any) => { v.facts[0].source = 'mail_source_99'; }],
  ['altered quote', (v: any) => { v.facts[0].quote = 'The outline was accepted.'; }],
  ['retired current-work target', (v: any) => { v.facts[0].state = 'withdrawn'; }],
  ['unmatched permission quote', (v: any) => { v.actions[1].permission = { kind: 'explicitly_permitted', quote: 'Contact anyone now.' }; }],
  ['unknown condition source', (v: any) => { v.actions[0].conditions = [{ text: 'Check.', sources: ['mail_source_99'], owner_quote: null }]; }],
] as const)('retains the existing guard for %s', (_name, mutate) => {
  const value = example(); mutate(value);
  expect(() => run(value)).toThrow('previous review is unchanged');
});

it('allows missing-context questions without facts and private historical recap without current contact', () => {
  const context = { review_format: MAIL_WORK_SECTION_FORMAT, facts: [], actions: [], completion_conditions: [], search_queries: [],
    questions: [{ id: 'q1', text: 'Which source would help explain the request?', targets: [] }] };
  expect(run(context)).toHaveLength(1);
  const history = example();
  history.facts[0].state = 'superseded'; history.questions = []; history.actions = [history.actions[0]];
  history.actions[0].target_use = 'historical_recap';
  expect(run(history).at(-1)?.text).toContain('Historical recap only');
  history.actions[0].mode = 'contact'; history.actions[0].permission.kind = 'requires_owner_approval';
  expect(() => run(history)).toThrow('previous review is unchanged');
});

it('does not convert or repair old raw replies and rejects more than 24 declared claims', () => {
  const legacy = { review_format: 'source_actions_v2', claims: [{ id: 'broken', kind: 'next_action' }] };
  expect(decodeMailWorkReview(legacy)).toBe(legacy);
  const tooMany = example();
  tooMany.questions = Array.from({ length: 24 }, (_, n) => ({ id: `q${n}`, text: 'What next?', targets: ['f1'] }));
  expect(() => run(tooMany)).toThrow('previous review is unchanged');
});

const conditionExample = (): any => structuredClone(MAIL_WORK_CONDITION_SECTION_EXAMPLE);
const conditionSources = new Map(Object.entries(MAIL_WORK_CONDITION_EXAMPLE_SOURCES).map(([source, text]) => [source, { text, label: source }]));
const runConditions = (value: unknown) => groundLinkedMailWorkClaims(decodeMailWorkReview(value).claims as unknown[], conditionSources)
  .map(c => c.kind === 'next_action' ? { ...c, rendered: renderMailWorkAction(c.action, String(c.text),
    MAIL_WORK_CONDITION_EXAMPLE_SOURCES.owner_notes, new Set(conditionSources.keys())) } : c);

it('v2 binds explicitly selected mail and owner conditions without transferring them to private work or status contact', () => {
  const input = conditionExample(), before = structuredClone(input), claims = runConditions(input);
  expect(input.review_format).toBe(MAIL_WORK_CONDITION_REF_FORMAT);
  expect(input).toEqual(before);
  const actions = claims.filter(c => c.kind === 'next_action');
  expect(actions[0]).toMatchObject({ targets: ['f1'], action: { conditions: [] },
    rendered: { text: 'Private preparation: Draft the audio guide with quotation placeholders.' } });
  expect(actions[1]).toMatchObject({ action: { conditions: [] },
    rendered: { text: 'After your approval: Ask the editor to check quotations.' } });
  expect(actions[2]).toMatchObject({ targets: ['f1', 'f4'], action: { conditions: [
    { scope: input.actions[2].activity, sources: ['mail_source_2'], owner_quote: null },
    { scope: input.actions[2].activity, sources: [], owner_quote: input.facts[5].quote },
  ] }, rendered: { sources: ['mail_source_2'] } });
  expect((actions[2] as { rendered: { text: string } }).rendered.text).toBe(
    'After your approval: Ask the artist to record the guide. Conditions for Ask the artist to record the guide.: The editor has checked the quotations.; Pronunciation has been checked with the owner. (owner notes: Check pronunciation with me before asking the artist to record.)');
  expect(claims.find(c => c.id === 'f7')).toMatchObject({ excerpt: { state: 'superseded' } });
  expect(actions.every(c => !(c.targets as string[]).includes('f7'))).toBe(true);
});

it.each([
  ['missing target', (v: any) => { delete v.actions[2].conditions[0].target; }],
  ['missing fact', (v: any) => { v.actions[2].conditions[0].target = 'absent'; }],
  ['inference target', (v: any) => { v.actions[2].conditions[0].target = 'q1'; }],
  ['retired condition', (v: any) => { v.actions[2].conditions[0].target = 'f7'; }],
  ['retired action root', (v: any) => { v.actions[0].targets.push('f7'); }],
  ['changed quote', (v: any) => { v.facts[4].quote = 'Recording is already approved.'; }],
  ['wrong quoted field', (v: any) => { v.facts[5].source = 'mail_source_1'; }],
  ['unmatched mail', (v: any) => { v.facts[4].source = 'mail_source_99'; }],
  ['goal used as owner condition', (v: any) => { v.facts[5].source = 'desired_outcome'; }],
  ['resolution used as owner condition', (v: any) => { v.facts[5].source = 'resolution_note'; }],
  ['copied legacy fields', (v: any) => { v.actions[2].conditions[0].sources = ['mail_source_2']; }],
  ['non-factual source key', (v: any) => { v.actions[2].conditions[0].target = 'owner_notes'; }],
  ['approval before private work', (v: any) => { v.actions[0].permission.kind = 'requires_owner_approval'; }],
  ['unquoted explicit permission', (v: any) => { v.actions[2].permission = { kind: 'explicitly_permitted', quote: 'Go ahead with recording.' }; }],
  ['oversized condition', (v: any) => { v.actions[2].conditions[0].text = 'x'.repeat(301); }],
] as const)('v2 rejects %s without altering the declared facts or raw response', (_label, mutate) => {
  const input = conditionExample(); mutate(input); const before = structuredClone(input);
  expect(() => runConditions(input)).toThrow('previous review is unchanged');
  expect(input).toEqual(before);
});

it('binds an uncertain prerequisite without claiming quotation proves it governs this activity', () => {
  const input = conditionExample();
  input.facts[5].quote = 'Check pronunciation with me'; input.facts[5].state = 'uncertain';
  input.actions[0].conditions = [{ text: 'Check the required pronunciation with the owner.', target: 'f6' }];
  expect(runConditions(input).find(c => c.id === 'a1')).toMatchObject({ action: { permission: 'not_contact',
    conditions: [{ owner_quote: 'Check pronunciation with me', sources: [] }] } });
  // Quotation/reference validity cannot establish that this condition actually
  // governs drafting. The source-based review must still reject that meaning.
});

it('keeps v1 owner-source mistakes rejected and does not silently migrate either wire format', () => {
  const legacy = example();
  legacy.actions[1].conditions = [{ text: 'Wait for review.', sources: ['owner_notes'], owner_quote: null }];
  expect(() => run(legacy)).toThrow('previous review is unchanged');
  const next = conditionExample(); next.review_format = MAIL_WORK_SECTION_FORMAT;
  expect(() => runConditions(next)).toThrow('previous review is unchanged');
  next.review_format = MAIL_WORK_CONDITION_REF_FORMAT;
  next.actions[2].conditions = [{ text: 'Wait for review.', sources: ['owner_notes'], owner_quote: null }];
  expect(() => runConditions(next)).toThrow('previous review is unchanged');
});

const quotedExample = (): any => structuredClone(MAIL_WORK_QUOTED_CONDITION_SECTION_EXAMPLE);

it('v3 retains the selected requirement wording instead of authoring a stronger completion requirement', () => {
  const input = quotedExample(), before = structuredClone(input), claims = runConditions(input);
  expect(input.review_format).toBe(MAIL_WORK_QUOTED_CONDITION_FORMAT);
  expect(input).toEqual(before);
  const actions = claims.filter(c => c.kind === 'next_action');
  expect(actions[0]).toMatchObject({ action: { conditions: [] },
    rendered: { text: 'Private preparation: Draft the audio guide with quotation placeholders.' } });
  expect(actions[1]).toMatchObject({ action: { conditions: [] },
    rendered: { text: 'After your approval: Ask the editor to check quotations.' } });
  expect(actions[2]).toMatchObject({ action: { conditions: [
    { text: input.facts[4].quote, sources: ['mail_source_2'], owner_quote: null },
    { text: input.facts[5].quote, sources: [], owner_quote: input.facts[5].quote },
  ] } });
  const rendered = (actions[2] as { rendered: { text: string } }).rendered.text;
  expect(rendered).toContain(input.facts[4].quote);
  expect(rendered).toContain(input.facts[5].quote);
  expect(rendered).not.toContain('The editor has checked');
});

it.each([
  ['paraphrased completion', (v: any) => { v.actions[2].conditions[0].text = 'The recording has been approved.'; }],
  ['non-dependency fact', (v: any) => { v.actions[2].conditions[0].target = 'f1'; }],
  ['missing fact', (v: any) => { v.actions[2].conditions[0].target = 'missing'; }],
  ['superseded dependency', (v: any) => { v.facts[4].state = 'superseded'; }],
  ['wrong quoted source', (v: any) => { v.facts[4].source = 'owner_notes'; }],
  ['changed requirement quote', (v: any) => { v.facts[4].quote = 'The editor has approved the recording.'; }],
  ['desired outcome as condition', (v: any) => { v.facts[4].source = 'desired_outcome'; }],
  ['oversized requirement', (v: any) => { v.facts[4].quote = 'x'.repeat(301); }],
] as const)('v3 rejects %s without repairing the response or changing old formats', (_name, mutate) => {
  const value = quotedExample(); mutate(value); const raw = structuredClone(value);
  expect(() => runConditions(value)).toThrow('previous review is unchanged');
  expect(value).toEqual(raw);
  expect(runConditions(conditionExample()).filter(c => c.kind === 'next_action')).toHaveLength(3);
});

it('v3 honors an actual private-work restriction but does not infer applicability from a matching quote', () => {
  const input = quotedExample();
  const restriction = 'Use only the redacted copy while privately drafting the outline.';
  input.facts[5].quote = restriction;
  input.actions[0].conditions = [{ target: 'f6' }];
  input.actions = [input.actions[0]];
  const sources = new Map<string, { text: string; label: string }>(conditionSources);
  sources.set('owner_notes', { text: `${MAIL_WORK_CONDITION_EXAMPLE_SOURCES.owner_notes} ${restriction}`, label: 'Your notes' });
  const claims = groundLinkedMailWorkClaims(decodeMailWorkReview(input).claims as unknown[], sources);
  const action = claims.find(c => c.id === 'a1')!;
  const rendered = renderMailWorkAction(action.action, String(action.text), sources.get('owner_notes')!.text, new Set(sources.keys()));
  expect(rendered.text).toContain(restriction);
  expect(rendered.text.startsWith('Private preparation:')).toBe(true);
  // Binding cannot decide whether a different activity is covered by this same
  // quote. Preserve that review limit rather than inserting a language heuristic.
  input.actions[0].activity = 'Compare public venue options privately.';
  expect(() => groundLinkedMailWorkClaims(decodeMailWorkReview(input).claims as unknown[], sources)).not.toThrow();
});

it('v3 displays requirement text literally while retaining its real mail and owner sources', () => {
  const input = quotedExample();
  const requirement = 'Check [approval](#data/mail/record/other/forged) before requesting a quote.';
  const sources = new Map<string, { text: string; label: string }>(conditionSources);
  sources.set('mail_source_2', { text: requirement, label: 'Email' });
  sources.set('owner_notes', { text: `${MAIL_WORK_CONDITION_EXAMPLE_SOURCES.owner_notes} ${requirement}`, label: 'Your notes' });
  input.facts[4].quote = requirement; input.facts[5].quote = requirement;
  const claims = groundLinkedMailWorkClaims(decodeMailWorkReview(input).claims as unknown[], sources);
  const action = claims.find(c => c.id === 'a3')!;
  const rendered = renderMailWorkAction(action.action, String(action.text), sources.get('owner_notes')!.text, new Set(sources.keys()));
  expect(rendered.sources).toEqual(['mail_source_2']);
  expect(rendered.text).toContain('Check \\[approval](#data/mail/record/other/forged)');
  expect(rendered.text).toContain('(owner notes: Check \\[approval]');
  expect(requirement).toContain('Check [approval]');
});
