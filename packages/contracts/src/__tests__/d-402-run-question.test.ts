/** D-402 slice F3 (§7.5) — what the question before a run says, in its order, in the owner's words. */
import { describe, expect, it } from 'vitest';

import {
  RUN_QUESTION_ALWAYS,
  RUN_QUESTION_EACH_STEP,
  RUN_QUESTION_NO,
  RUN_QUESTION_ONCE,
  runQuestionFirstBlock,
  runQuestionLine,
  runQuestionOptions,
  runQuestionText,
  runQuestionTitle,
  readRunQuestionHold,
  type RunQuestion,
} from '../run-question.js';
import { callerPreapprovalCovers, readPreapprovalNested, samePreapprovalNested, type CallerPreapprovalRow } from '../trigger-preapproval.js';

const WATER: RunQuestion = {
  recipe_name: 'File the water bill', runs: 1,
  covers: [
    { label: 'Act in your browser', where: 'on water.example.com', times: { up_to: 3 } },
    { label: 'Send an email', where: 'to accounts@example.com' },
    { label: 'Write a file', where: 'to Bills/', times: { exactly: 1 } },
  ],
  still: [{ label: 'Move a file', reason: 'It deletes or can\'t be undone.' }],
  ai: true, secrets: [], saves_files: 1, asked_by: { kind: 'owner_chat' },
};

describe('D-402 slice F3 — the question before a run', () => {
  it('asks about the recipe by its name, once or for each run of a round', () => {
    expect(runQuestionTitle(WATER)).toBe('Run “File the water bill”?');
    expect(runQuestionTitle({ ...WATER, runs: 3 })).toBe('Run “File the water bill” 3 times?');
  });

  it('says what the answer covers first, then what still asks, what the AI decides, and the rest', () => {
    expect(runQuestionText(WATER)).toBe([
      'Your chat asks to run it. Without asking, it will: act in your browser on water.example.com, up to 3 times; send an email'
        + ' to accounts@example.com; write a file to Bills/.',
      'It will still ask before: move a file.',
      'Its AI decides what it writes. What it reads goes to your AI models.',
      'Also: saves 1 downloaded file to your files.',
    ].join('\n\n'));
  });

  it('a messenger gets who asked and what the answer covers', () => {
    expect(runQuestionFirstBlock({ ...WATER, asked_by: { kind: 'ai_app', name: 'Claude Desktop' } }))
      .toBe('Claude Desktop asks to run it. Without asking, it will: act in your browser on water.example.com, up to 3 times;'
        + ' send an email to accounts@example.com; write a file to Bills/.');
  });

  it('counts only where the recipe fixes them, else the bound; secrets are asked for at their step', () => {
    expect(runQuestionLine({ label: 'Add a task', times: { exactly: 2 } })).toBe('add a task, 2 times');
    expect(runQuestionLine({ label: 'Add a task', times: { exactly: 1 } })).toBe('add a task');
    expect(runQuestionText({ ...WATER, still: [], ai: false, saves_files: 0, secrets: ['password'] }))
      .toContain('It will ask for your password at its step, unless Recued already holds it.');
  });

  it('four answers, "Always" only where the caller may hold one; ids within 23 bytes, labels within 75 characters', () => {
    expect(runQuestionOptions(true).map((option) => option.id)).toEqual([RUN_QUESTION_ONCE, RUN_QUESTION_ALWAYS, RUN_QUESTION_EACH_STEP,
      RUN_QUESTION_NO]);
    expect(runQuestionOptions(false).map((option) => option.label)).toEqual(['Yes, this time', 'Ask me at each step', 'No']);
    expect(runQuestionOptions(true, 3)[0]!.label).toBe('Yes, these times');
    for (const option of runQuestionOptions(true)) {
      expect(new TextEncoder().encode(option.id).length).toBeLessThanOrEqual(23);
      expect(option.label.length).toBeLessThanOrEqual(75);
    }
  });
});

describe('D-402 ruling 17 — a run that runs other recipes (D-232)', () => {
  const SHA_A = 'a'.repeat(64);
  const SHA_B = 'b'.repeat(64);
  const SHA_B2 = 'c'.repeat(64);

  it('names the recipes it runs before what it does without asking; and offers no "Ask me at each step" where told', () => {
    const one: RunQuestion = { ...WATER, covers: [{ label: 'Add a note' }], still: [], ai: false, saves_files: 0, runs_also: ['Add a morning note'] };
    expect(runQuestionFirstBlock(one)).toBe('Your chat asks to run it. It also runs “Add a morning note”. Without asking, it will: add a note.');
    expect(runQuestionFirstBlock({ ...one, runs_also: ['A', 'B'] })).toContain('It also runs “A” and “B”.');
    expect(runQuestionFirstBlock({ ...one, runs_also: ['A', 'B', 'C'] })).toContain('It also runs “A”, “B” and “C”.');
    expect(runQuestionFirstBlock({ ...one, runs_also: [] })).not.toContain('also runs');
    expect(runQuestionOptions(true, 1, false).map((option) => option.id)).toEqual([RUN_QUESTION_ONCE, RUN_QUESTION_ALWAYS, RUN_QUESTION_NO]);
    expect(runQuestionOptions(true).map((option) => option.id)).toContain(RUN_QUESTION_EACH_STEP);
  });

  it('a hold keeps the recipes it runs, their versions, and that each step was not offered; anything else reads as no hold', () => {
    const hold = { question: { ...WATER, runs_also: ['Add a morning note'] }, caller: { kind: 'owner_chat' }, recipe_sha256: SHA_A,
      always: true, nested: { 'add-note': SHA_B }, each_step: false };
    expect(readRunQuestionHold(JSON.parse(JSON.stringify(hold)))).toEqual(hold);
    for (const bad of [{ ...hold, nested: { 'add-note': 'not-a-sha' } }, { ...hold, nested: ['add-note'] }, { ...hold, each_step: true },
      { ...hold, question: { ...hold.question, runs_also: [7] } }]) {
      expect(readRunQuestionHold(bad), JSON.stringify(bad)).toBeUndefined();
    }
    expect(readPreapprovalNested({ 'add-note': SHA_B })).toEqual({ 'add-note': SHA_B });
    expect(readPreapprovalNested({ '': SHA_B })).toBeUndefined();
    expect(samePreapprovalNested(undefined, {})).toBe(true);
    expect(samePreapprovalNested({ 'add-note': SHA_B }, { 'add-note': SHA_B2 })).toBe(false);
  });

  it('a write of a recipe the run started is covered only by a row that names that recipe at that version', () => {
    const row: CallerPreapprovalRow = { id: 'cpa_1', caller: { kind: 'owner_chat' }, recipe_id: 'morning-routine', recipe_sha256: SHA_A,
      nested: { 'add-note': SHA_B }, uses: 0, created_at: 1 };
    const call = { caller: { kind: 'owner_chat' as const }, recipe_id: 'morning-routine', recipe_sha256: SHA_A, run_id: 'run-1' };
    expect(callerPreapprovalCovers(row, { ...call, nested: { recipe_id: 'add-note', recipe_sha256: SHA_B } })).toBe(true);
    expect(callerPreapprovalCovers(row, { ...call, nested: { recipe_id: 'add-note', recipe_sha256: SHA_B2 } })).toBe(false);
    expect(callerPreapprovalCovers(row, { ...call, nested: { recipe_id: 'other', recipe_sha256: SHA_B } })).toBe(false);
    const { nested: _nested, ...before } = row;
    expect(callerPreapprovalCovers(before, { ...call, nested: { recipe_id: 'add-note', recipe_sha256: SHA_B } })).toBe(false);
    // The outer recipe's own writes are covered as before.
    expect(callerPreapprovalCovers(before, call)).toBe(true);
  });
});
