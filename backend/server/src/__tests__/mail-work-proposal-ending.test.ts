import { expect, it } from 'vitest';
import { finishMailWorkProposal } from '../mail-work-proposal-ending.js';
import { MAIL_WORK_PLANNING_CHOICE, MAIL_WORK_PROPOSAL_REMINDER } from '../mail-work-turn-contract.js';
import { buildMailWorkPrompts, MAIL_WORK_RESOLUTION_GUIDANCE } from '../mail-work-prompt-templates.js';

const ending = `${MAIL_WORK_PROPOSAL_REMINDER} ${MAIL_WORK_PLANNING_CHOICE}`;

it('adds the promised owner breakpoint to an answer that omitted it, without rewriting the plan', () => {
  const plan = 'Draft the private outline. Scope and timing are open.';
  expect(finishMailWorkProposal(plan)).toBe(`${plan}\n\n${ending}`);
  expect(finishMailWorkProposal(finishMailWorkProposal(plan))).toBe(finishMailWorkProposal(plan));
});

it.each([ending, `This is a proposal awaiting your choice. ${MAIL_WORK_PLANNING_CHOICE}`])(
  'preserves an already complete ending exactly once: %s', closing => {
    const plan = `Keep this useful work.\n\n${closing}`;
    expect(finishMailWorkProposal(plan)).toBe(plan);
    expect(finishMailWorkProposal(plan).split(MAIL_WORK_PLANNING_CHOICE)).toHaveLength(2);
  });

it('supplies only the missing reminder or choice and leaves empty answers empty', () => {
  expect(finishMailWorkProposal(`Draft privately. ${MAIL_WORK_PLANNING_CHOICE}`))
    .toBe(`Draft privately.\n\n${ending}`);
  expect(finishMailWorkProposal(`Draft privately. ${MAIL_WORK_PROPOSAL_REMINDER}`))
    .toBe(`Draft privately. ${MAIL_WORK_PROPOSAL_REMINDER}\n\n${MAIL_WORK_PLANNING_CHOICE}`);
  expect(finishMailWorkProposal('  ')).toBe('  ');
});

it('does not discard text after a quoted earlier choice while adding the final breakpoint', () => {
  const plan = `The previous answer asked: ${MAIL_WORK_PLANNING_CHOICE}\nMy new draft stays private.`;
  expect(finishMailWorkProposal(plan)).toBe(`${plan}\n\n${ending}`);
});

it('shares resolution rules across production stages without forcing a planning ending onto ordinary replies', () => {
  const prompts = buildMailWorkPrompts('Keep source dates meaningful.', 3);
  for (const prompt of [prompts.investigation, prompts.refinement, prompts.linkedReview]) {
    expect(prompt).toContain(MAIL_WORK_RESOLUTION_GUIDANCE);
    expect(prompt).not.toMatch(/Cobalt|Quartz|23 October|9 October|4,800/u);
  }
  expect(prompts.investigation).toContain('host appends the proposal reminder');
  expect(prompts.refinement).toContain('If the owner changes the purpose, answer that request instead');
  expect(prompts.linkedReview).toContain('requires_owner_approval');
});
