/** A running entry as Live control and the messenger's list name it (owner, 2026-11-13: "do
 *  naming Live control's running recipes properly"; it read "daily-brief · summarize"). */

import { describe, expect, it } from 'vitest';

import { activeEntryOriginWords, activeEntryRecipeTitle, activeEntryTitle, executionLaneWords } from '../execution-control.js';

describe('a running entry, by name', () => {
  it('an installed recipe by its name, and the step it is on by what it does', () => {
    const entry = { recipe_id: 'daily-brief', recipe_name: 'Daily brief', step_id: 'summarize', step_name: 'Summarize text' };
    expect(activeEntryTitle(entry)).toBe('Daily brief · Summarize text');
    expect(activeEntryRecipeTitle(entry)).toBe('Daily brief');
    // A step with no name is left out: its id is the recipe author's.
    const { step_name: _none, ...unnamedStep } = entry;
    expect(activeEntryTitle(unnamedStep)).toBe('Daily brief');
  });

  it('a recipe passed in with the run as a one-off, by the name it came with, never as an installed one', () => {
    const entry = { recipe_id: 'daily-brief', recipe_inline: true as const, intent: 'Daily brief', step_id: 'summarize' };
    expect(activeEntryTitle(entry)).toBe('One-off recipe “Daily brief”');
    expect(activeEntryTitle({ ...entry, step_name: 'Summarize text' })).toBe('One-off recipe “Daily brief” · Summarize text');
    const { intent: _none, ...unnamed } = entry;
    expect(activeEntryRecipeTitle(unnamed)).toBe('One-off recipe “daily-brief”');
  });

  it('an entry an older server sent, by its ids as before', () => {
    expect(activeEntryTitle({ recipe_id: 'daily-brief', step_id: 'summarize' })).toBe('daily-brief · summarize');
    expect(activeEntryTitle({ recipe_id: 'daily-brief' })).toBe('daily-brief');
    expect(activeEntryRecipeTitle({ recipe_id: 'daily-brief', recipe_name: '  ' })).toBe('daily-brief');
  });
});

describe('who started a running entry, and its lane, in words', () => {
  it('names each origin and lane, and never shows a code', () => {
    expect(activeEntryOriginWords('attended')).toBe('started by you');
    expect(activeEntryOriginWords('unattended')).toBe('started on its own');
    expect(activeEntryOriginWords('detached-future')).toBeUndefined();
    expect(executionLaneWords('local-heavy')).toBe('Heavy work on your server');
    expect(executionLaneWords('external-io')).toBe('Calls to other services');
    expect(executionLaneWords('gpu-future')).toBe('Work');
  });
});
