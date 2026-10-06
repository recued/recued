import { expect, it } from 'vitest';
import { MAIL_WORK_OWNER_NOTES_TIME_GUIDANCE } from '@recued/contracts';
import { buildMailWorkPrompts, MAIL_WORK_JSON_INSTRUCTION, MAIL_WORK_ACTION_SHAPES, MAIL_WORK_ASSERTION_GUIDANCE,
  MAIL_WORK_DELIVERABLE_GUIDANCE, MAIL_WORK_SECTION_EXAMPLE, MAIL_WORK_WORKED_GUIDANCE,
  MAIL_WORK_SCOPED_EXAMPLE_SOURCES, MAIL_WORK_SCOPED_SECTION_EXAMPLE,
  MAIL_WORK_SUPPORTED_PLAN_GUIDANCE, MAIL_WORK_RESPONSE_INVARIANTS_V1, MAIL_WORK_STATEMENT_GUIDANCE, MAIL_WORK_CASE_RESOLUTION_GUIDANCE, MAIL_WORK_ASSERTION_SCOPE_GUIDANCE, MAIL_WORK_EVIDENCE_PLAN_GUIDANCE, MAIL_WORK_ACTION_SELECTION_GUIDANCE, MAIL_WORK_ACTION_SELECTION_SECTION_EXAMPLE,
  MAIL_WORK_SOURCE_ASSERTION_GUIDANCE, MAIL_WORK_QUOTED_CONDITION_SECTION_EXAMPLE,
  MAIL_WORK_PLAN_SCOPE_GUIDANCE, MAIL_WORK_ACTIVITY_GUIDANCE, MAIL_WORK_CONDITION_SECTION_EXAMPLE } from '../mail-work-prompt-templates.js';
import { MAIL_WORK_INVESTIGATION_GUIDANCE, MAIL_WORK_LINKED_REVIEW_PROMPT, MAIL_WORK_OUTPUT_SHAPE,
  MAIL_WORK_REFINEMENT_GUIDANCE } from '../mail-work-investigation-guidance.js';
import { renderMailWorkAction } from '../mail-work-action-renderer.js';
import { groundLinkedMailWorkClaims } from '../mail-work-linked-source-review.js';
import { mailWorkSourceCatalog, renderMailWorkSourceRecap, type MailWorkQuoteSource } from '../mail-work-source-recap.js';
import { createMailWorkEvidence } from '../mail-work-evidence.js';

const prompts = buildMailWorkPrompts(MAIL_WORK_OWNER_NOTES_TIME_GUIDANCE, 4);
const sources = new Map<string, MailWorkQuoteSource>([
  ['desired_outcome', { label: 'Your outcome', text: 'Explore an indoor gathering.' }],
  ['owner_notes', { label: 'Your notes', text: 'The outdoor idea is cancelled. Ask me before contacting anyone.' }],
]);
const facts = () => [
  { id: 'direction', kind: 'request', basis: 'owner', sources: [],
    excerpt: { source: 'desired_outcome', quote: 'Explore an indoor gathering.', state: 'current' } },
  { id: 'permission', kind: 'dependency', basis: 'owner', sources: [],
    excerpt: { source: 'owner_notes', quote: 'Ask me before contacting anyone.', state: 'current' } },
];

it('preserves the version 16 investigation, refinement and review templates for historical replay', () => {
  const production = buildMailWorkPrompts(MAIL_WORK_OWNER_NOTES_TIME_GUIDANCE, 15);
  expect(MAIL_WORK_OUTPUT_SHAPE).toBe(`${MAIL_WORK_JSON_INSTRUCTION}\n${production.output}`);
  expect(MAIL_WORK_INVESTIGATION_GUIDANCE).toBe(`${MAIL_WORK_JSON_INSTRUCTION}\n${production.investigation}`);
  expect(MAIL_WORK_REFINEMENT_GUIDANCE).toBe(`${MAIL_WORK_JSON_INSTRUCTION}\n${production.refinement}`);
  expect(MAIL_WORK_LINKED_REVIEW_PROMPT).toBe(`${MAIL_WORK_JSON_INSTRUCTION}\n${production.linkedReview}`);
  for (const prompt of [production.investigation, production.refinement, production.linkedReview]) {
    expect(prompt).toContain(MAIL_WORK_SUPPORTED_PLAN_GUIDANCE);
    expect(prompt.split(MAIL_WORK_RESPONSE_INVARIANTS_V1)).toHaveLength(2);
    expect(prompt).not.toContain(MAIL_WORK_ACTION_SELECTION_GUIDANCE);
    expect(prompt).not.toMatch(/Cobalt|Quartz|23 October|9 October|4,800|record_observation_[0-9]/u);
  }
  expect(production.linkedReview).toContain(JSON.stringify(MAIL_WORK_ACTION_SELECTION_SECTION_EXAMPLE));
  const statement = buildMailWorkPrompts(MAIL_WORK_OWNER_NOTES_TIME_GUIDANCE, 14);
  for (const key of ['investigation', 'refinement', 'linkedReview'] as const) {
    expect(statement[key]).toContain(MAIL_WORK_STATEMENT_GUIDANCE);
    expect(statement[key]).not.toContain(MAIL_WORK_RESPONSE_INVARIANTS_V1);
    expect(production[key]).toBe(statement[key].replace(MAIL_WORK_STATEMENT_GUIDANCE, MAIL_WORK_SUPPORTED_PLAN_GUIDANCE));
  }
  const caseResolution = buildMailWorkPrompts(MAIL_WORK_OWNER_NOTES_TIME_GUIDANCE, 13);
  for (const key of ['investigation', 'refinement', 'linkedReview'] as const) {
    expect(caseResolution[key]).toContain(MAIL_WORK_CASE_RESOLUTION_GUIDANCE);
    expect(caseResolution[key]).not.toContain(MAIL_WORK_STATEMENT_GUIDANCE);
    expect(statement[key]).toBe(caseResolution[key].replace(MAIL_WORK_CASE_RESOLUTION_GUIDANCE, MAIL_WORK_STATEMENT_GUIDANCE));
  }
  const assertionScope = buildMailWorkPrompts(MAIL_WORK_OWNER_NOTES_TIME_GUIDANCE, 12);
  for (const prompt of [assertionScope.investigation, assertionScope.refinement, assertionScope.linkedReview]) {
    expect(prompt).toContain(MAIL_WORK_ASSERTION_SCOPE_GUIDANCE);
    expect(prompt).not.toContain(MAIL_WORK_CASE_RESOLUTION_GUIDANCE);
  }
  expect(production.output).toBe(assertionScope.output);
  for (const key of ['investigation', 'refinement', 'linkedReview'] as const) {
    expect(caseResolution[key]).toBe(assertionScope[key].replace(MAIL_WORK_ASSERTION_SCOPE_GUIDANCE, MAIL_WORK_CASE_RESOLUTION_GUIDANCE));
  }
  const evidencePlan = buildMailWorkPrompts(MAIL_WORK_OWNER_NOTES_TIME_GUIDANCE, 11);
  for (const prompt of [evidencePlan.investigation, evidencePlan.refinement, evidencePlan.linkedReview]) {
    expect(prompt).toContain(MAIL_WORK_EVIDENCE_PLAN_GUIDANCE);
    expect(prompt).not.toContain(MAIL_WORK_ASSERTION_SCOPE_GUIDANCE);
  }
  const actionSelection = buildMailWorkPrompts(MAIL_WORK_OWNER_NOTES_TIME_GUIDANCE, 10);
  for (const prompt of [actionSelection.investigation, actionSelection.refinement, actionSelection.linkedReview]) {
    expect(prompt).toContain(MAIL_WORK_ACTION_SELECTION_GUIDANCE);
    expect(prompt).not.toContain(MAIL_WORK_EVIDENCE_PLAN_GUIDANCE);
  }
  const assertions = buildMailWorkPrompts(MAIL_WORK_OWNER_NOTES_TIME_GUIDANCE, 9);
  expect(assertions.linkedReview).toContain(JSON.stringify(MAIL_WORK_QUOTED_CONDITION_SECTION_EXAMPLE));
  for (const prompt of [assertions.investigation, assertions.refinement, assertions.linkedReview]) {
    expect(prompt).toContain(MAIL_WORK_SOURCE_ASSERTION_GUIDANCE);
    expect(prompt).not.toContain(MAIL_WORK_ACTION_SELECTION_GUIDANCE);
  }
  expect(production.output).toContain('source_catalog');
  expect(production.output).toContain('recap_source');
  const scope = buildMailWorkPrompts(MAIL_WORK_OWNER_NOTES_TIME_GUIDANCE, 8);
  expect(scope.linkedReview).toContain(JSON.stringify(MAIL_WORK_CONDITION_SECTION_EXAMPLE));
  for (const prompt of [scope.investigation, scope.refinement, scope.linkedReview]) {
    expect(prompt).toContain(MAIL_WORK_PLAN_SCOPE_GUIDANCE);
    expect(prompt).not.toContain(MAIL_WORK_SOURCE_ASSERTION_GUIDANCE);
  }
  const activity = buildMailWorkPrompts(MAIL_WORK_OWNER_NOTES_TIME_GUIDANCE, 7);
  for (const prompt of [activity.investigation, activity.refinement, activity.linkedReview]) {
    expect(prompt).toContain(MAIL_WORK_ACTIVITY_GUIDANCE);
    expect(prompt).not.toContain(MAIL_WORK_PLAN_SCOPE_GUIDANCE);
  }
  const worked = buildMailWorkPrompts(MAIL_WORK_OWNER_NOTES_TIME_GUIDANCE, 6);
  expect(worked.linkedReview).toContain(JSON.stringify(MAIL_WORK_SCOPED_SECTION_EXAMPLE));
  for (const prompt of [worked.investigation, worked.refinement, worked.linkedReview]) {
    expect(prompt).toContain(MAIL_WORK_WORKED_GUIDANCE);
    expect(prompt).not.toContain(MAIL_WORK_ACTIVITY_GUIDANCE);
  }
  const earlier = buildMailWorkPrompts(MAIL_WORK_OWNER_NOTES_TIME_GUIDANCE, 5);
  expect(earlier.linkedReview).toContain(JSON.stringify(MAIL_WORK_SECTION_EXAMPLE));
  for (const prompt of [earlier.investigation, earlier.refinement, earlier.linkedReview]) {
    expect(prompt).toContain(MAIL_WORK_DELIVERABLE_GUIDANCE);
    expect(prompt).not.toContain(MAIL_WORK_WORKED_GUIDANCE);
  }
  for (const prompt of [prompts.investigation, prompts.refinement, prompts.linkedReview]) {
    expect(prompt).toContain(MAIL_WORK_ASSERTION_GUIDANCE);
    expect(prompt).not.toMatch(/Cobalt|Quartz|23 October|9 October|4,800|record_observation_[0-9]/u);
  }
  expect(prompts.investigation).toContain('host appends the proposal reminder');
  expect(prompts.refinement).toContain('If the owner changes the purpose, answer that request instead');
});

it('the worked assertions render as separate owner and email quotes through actual Chat source handles', () => {
  const record = createMailWorkEvidence(null, MAIL_WORK_SCOPED_EXAMPLE_SOURCES.owner_notes, true, 1);
  const binding = new Map([['owner_notes', 'owner_request']]);
  for (const name of ['mail_source_1', 'mail_source_2'] as const) {
    const url = `#data/mail/record/example/${name}`;
    record.record({ tool_name: 'mail.read', tier: 1, args: { slug: 'example', record_id: name }, status: 'ok',
      started_at: 1, completed_at: 2, result: { body: MAIL_WORK_SCOPED_EXAMPLE_SOURCES[name], source_url: url } });
    binding.set(name, mailWorkSourceCatalog(record.snapshot()).find(entry => entry.source_url === url)!.source);
  }
  const recap = MAIL_WORK_SCOPED_SECTION_EXAMPLE.facts.map(({ source, quote, state }) => ({ source: binding.get(source)!, quote, state }));
  const before = structuredClone(recap), result = renderMailWorkSourceRecap(recap, record.snapshot());
  expect(result).toMatchObject({ outcome: 'matched', excerpts: 5 });
  expect(recap).toEqual(before);
  expect(result.text).toContain('Your investigation request (AI status: current): “Ask me before contacting anyone.”');
  expect(result.text).toContain('Your investigation request (AI status: current): “The evening talk was cancelled on our phone call.”');
  expect(result.text).toContain('[Email](#data/mail/record/example/mail_source_1) (AI status: current): “The outdoor display is cancelled.”');
  expect(result.text).not.toContain('still under consideration');
  // This exercises our example, not the model's ability to select these states.
  const wrongReporter = recap.map(row => row.quote.startsWith('The evening talk') ? { ...row, source: binding.get('mail_source_1')! } : row);
  expect(renderMailWorkSourceRecap(wrongReporter, record.snapshot())).toMatchObject({ outcome: 'invalid', excerpts: 4 });
});

it.each(MAIL_WORK_ACTION_SHAPES)('the displayed $mode example grounds and renders without a missing scope or inherited permission', shape => {
  const displayed = prompts.linkedReview.split('\n').map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).find(value => value?.mode === shape.mode);
  expect(displayed).toEqual(shape);
  const claims = groundLinkedMailWorkClaims([...facts(), { id: 'action', kind: 'next_action', basis: 'inference',
    sources: [], targets: ['direction', 'permission'], text: 'Prepare the next activity.', action: displayed }], sources);
  const action = claims.at(-1)!;
  const rendered = renderMailWorkAction(action.action, String(action.text), sources.get('owner_notes')!.text, new Set(sources.keys()));
  const prefix = shape.mode === 'private_preparation' ? 'Private preparation'
    : shape.mode === 'contact' ? 'After your approval'
      : shape.mode === 'wait' ? 'Waiting for your approval' : 'Proposed next step';
  expect(rendered.text).toBe(`${prefix}: Prepare the next activity.`);
  expect(rendered.sources).toEqual([]);
});

it('keeps source fields distinct and retired roots rejected despite the revised examples', () => {
  const wrongField = facts(); wrongField[0]!.excerpt.source = 'owner_notes';
  expect(() => groundLinkedMailWorkClaims(wrongField, sources)).toThrow('source excerpts');
  const retired = facts(); retired[0]!.excerpt.state = 'superseded';
  expect(() => groundLinkedMailWorkClaims([...retired, { id: 'question', kind: 'question', basis: 'inference',
    sources: [], targets: ['direction'], text: 'What should the current proposal contain?' }], sources)).toThrow('current action targets');
  expect(() => renderMailWorkAction({ ...MAIL_WORK_ACTION_SHAPES[3], scope: undefined }, 'Wait.',
    sources.get('owner_notes')!.text, new Set(sources.keys()))).toThrow('incomplete permission or scope');
});
