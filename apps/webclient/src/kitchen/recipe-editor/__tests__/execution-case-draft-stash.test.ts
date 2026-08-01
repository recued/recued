/** D-219 item 2b — carrying an AI-written draft from Settings to the Kitchen.
 *
 *  Unlike the form-response seed, this draft cannot be rebuilt from its route:
 *  regenerating means paying the owner's model quota again. So the recipe
 *  itself travels, and these pin the three properties that makes load-bearing.
 */

import { describe, expect, it } from 'vitest';

import {
  clearExecutionCaseDraft,
  createExecutionCaseDraftKey,
  EXECUTION_CASE_DRAFT_SLOT,
  readExecutionCaseDraft,
  stashExecutionCaseDraft,
  type ExecutionCaseDraftStorage,
} from '../execution-case-draft-stash.js';

const memory = (): ExecutionCaseDraftStorage & { size(): number } => {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
    size: () => map.size,
  };
};

const draft = { case_id: 'case_one', recipe: { recipe_id: 'r' }, request_aliased: true };

describe('D-219 — the draft survives the trip, and only the right one', () => {
  it('round-trips the recipe under the key it was stashed with', () => {
    const storage = memory();
    const key = stashExecutionCaseDraft(storage, draft)!;
    expect(key).toMatch(/^[a-f0-9]{32}$/u);
    expect(readExecutionCaseDraft(storage, key)).toEqual({ ...draft, draft_key: key });
  });

  it('⛔ refuses a key that does not match the stored draft', () => {
    // A stale `#kitchen/new/execution-case/<key>` in history must not open
    // whatever draft happens to be in the slot now — that would show a recipe
    // for a DIFFERENT case under a URL naming this one.
    const storage = memory();
    const first = stashExecutionCaseDraft(storage, draft)!;
    const second = stashExecutionCaseDraft(
      storage, { ...draft, case_id: 'case_two' },
    )!;
    expect(second).not.toBe(first);
    expect(readExecutionCaseDraft(storage, first)).toBeNull();
    expect(readExecutionCaseDraft(storage, second)?.case_id).toBe('case_two');
  });

  it('⛔ keeps ONE slot, so drafts cannot accumulate', () => {
    // A keyed pool would leave expensive JSON in storage with no natural moment
    // to prune it. Writing replaces, which is bounded without a policy.
    const storage = memory();
    for (let index = 0; index < 5; index += 1) {
      stashExecutionCaseDraft(storage, { ...draft, case_id: `c${index}` });
    }
    expect(storage.size()).toBe(1);
  });

  it('⚠ READS without removing, so a refresh reopens the same draft', () => {
    // One-shot would be the tidier instinct and the wrong one: losing an
    // expensive draft to a stray reload is the worst small failure here.
    const storage = memory();
    const key = stashExecutionCaseDraft(storage, draft)!;
    expect(readExecutionCaseDraft(storage, key)).not.toBeNull();
    expect(readExecutionCaseDraft(storage, key)).not.toBeNull();
  });

  it('⚠ fails SOFT — a throwing or absent storage costs the hand-off, not the turn', () => {
    // Private mode, a quota'd origin, a host with no storage at all. The draft
    // was already paid for; a thrown error here would lose it AND the turn.
    const throwing: ExecutionCaseDraftStorage = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    };
    expect(stashExecutionCaseDraft(throwing, draft)).toBeNull();
    expect(readExecutionCaseDraft(throwing, 'k')).toBeNull();
    expect(stashExecutionCaseDraft(null, draft)).toBeNull();
    expect(readExecutionCaseDraft(undefined, 'k')).toBeNull();
    expect(() => clearExecutionCaseDraft(throwing)).not.toThrow();
  });

  it('survives a corrupt slot rather than throwing at the route', () => {
    const storage = memory();
    storage.setItem(EXECUTION_CASE_DRAFT_SLOT, 'not json');
    expect(readExecutionCaseDraft(storage, 'k')).toBeNull();
    storage.setItem(EXECUTION_CASE_DRAFT_SLOT, JSON.stringify({ draft_key: 'k' }));
    expect(readExecutionCaseDraft(storage, 'k')).toBeNull();
  });

  it('mints keys that are not guessable from the route', () => {
    // ⛔ Not a counter or a timestamp: the key is what stops a stale route
    // opening the current slot, so it must not be derivable from the thing that
    // produced it.
    const keys = new Set(
      Array.from({ length: 50 }, () => createExecutionCaseDraftKey()),
    );
    expect(keys.size).toBe(50);
  });
});
