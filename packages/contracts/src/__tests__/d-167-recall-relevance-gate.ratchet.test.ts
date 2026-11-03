/** D-167 — recall relevance-gate descriptor ratchet.
 *
 *  The relevance gate (design §3/§6 of
 *  D-167) is the SOFTER,
 *  within-session half of the §2 ambiguity gate: the agent should skip
 *  `memory.search` when the answer is already in the current conversation
 *  (`chat_tail`) — `memory.search`'s real job is CROSS-SESSION recall (earlier
 *  sessions / older history / raw context the conversation never carried), not
 *  re-fetching what was already said. It is enacted as agent-read copy in the
 *  `memory.search` Tier-1 descriptor (LLM-read at runtime, § A.13), which flows into
 *  every turn's `available_tools`. These tests pin that guidance so it can't silently
 *  regress.
 */

import { describe, expect, it } from 'vitest';
import { TIER1_TOOL_DESCRIPTORS } from '../chat.js';

describe('D-167 — memory.search recall relevance gate', () => {
  const memorySearchDescription =
    TIER1_TOOL_DESCRIPTORS['memory.search'].description;

  it('frames memory.search as CROSS-SESSION recall', () => {
    expect(memorySearchDescription).toMatch(/cross-session/i);
  });

  it('directs the agent NOT to re-fetch what is already in this conversation', () => {
    expect(memorySearchDescription).toMatch(/do not call it to re-fetch/i);
    expect(memorySearchDescription).toMatch(/this conversation/i);
  });
});

/* 2026-08-11 — the match-quality signals are worth exactly as much as the
 * instruction that comes with them.
 *
 * `match` and `top_margin` are emitted so the agent can tell an answer from a
 * best-guess, but a field the model has not been told how to READ is noise it
 * pays context for. The whole value is the behavioural clause — "treat them as
 * candidates, never as the answer" on a loose match, "do not silently pick one"
 * on a flat margin. Shipping the fields without the copy would be a measurable
 * cost with no measurable benefit, so the copy is pinned. */
describe('memory.search — match / top_margin agent guidance', () => {
  const memorySearchDescription =
    TIER1_TOOL_DESCRIPTORS['memory.search'].description;

  it('names all five match kinds', () => {
    // D-336 slice C — +1: `claim`, a recall by the notes' claims (`about`).
    for (const kind of ['exact', 'relaxed', 'loose', 'semantic', 'claim']) {
      expect(memorySearchDescription).toContain(`\`${kind}\``);
    }
  });

  /** D-336 slice C (owner: "do slice C") — recall by a claim's ends, in any wording or
   *  language. A note saved with no claim has none to find, so the words stay. */
  it('sends a recall about a person or a thing to `about`, which finds notes by their claim', () => {
    expect(memorySearchDescription).toMatch(/To recall what is saved about a person or a thing, pass `about` too: it finds notes by their `claim`, in whatever words or language they were saved\./);
    expect(memorySearchDescription).toMatch(/`claim` = each note's claim names what you passed in `about`, either way round/);
    const about = (TIER1_TOOL_DESCRIPTORS['memory.search'].arg_schema as {
      properties: { about: { description: string; maxItems: number } };
    }).properties.about;
    expect(about.maxItems).toBe(2);
    expect(about.description).toMatch(/With `query` too, its words answer when no claim names them/);
  });

  it('⛔ tells the agent a SEMANTIC hit shares no words and must be checked', () => {
    // Rung 4 fires only when nothing lexical matched, so the entry was found by
    // meaning alone — a stronger claim than any lexical rung makes, and the one
    // most worth verifying before it becomes an answer.
    expect(memorySearchDescription).toMatch(/by MEANING alone/i);
    expect(memorySearchDescription).toMatch(/check the entry is really about/i);
  });

  it('⛔ tells the agent a LOOSE match is candidates, not an answer', () => {
    expect(memorySearchDescription).toMatch(/candidates/i);
    expect(memorySearchDescription).toMatch(/never as the answer/i);
    // …and to say so out loud rather than answering with a straight face.
    expect(memorySearchDescription).toMatch(/approximate/i);
  });

  it('⛔ tells the agent a LOW top_margin forbids silently picking a winner', () => {
    expect(memorySearchDescription).toContain('top_margin');
    expect(memorySearchDescription).toMatch(/must not silently pick one|not silently pick/i);
  });

  /* ⛔ The pool must stop SOLICITING what it cannot maintain.
   *
   * `kind` is a free-form string and there is no supersede / current-value
   * machinery anywhere in `user_memory` — verified, not assumed. A preference
   * is STATE, not an observation: when it changes, the old value is wrong
   * rather than historical. Stored here, both survive, and the retrieval work
   * makes that legible rather than harmless — two contradictory preferences
   * match equally, `top_margin` lands near 0, and the agent is told it "must
   * not silently pick one". The result is an assistant asking the owner which
   * of their own preferences is current, forever.
   *
   * Removing the invitation is not enough on its own: "a fact worth
   * persisting" still describes a preference, so the ban has to be explicit.
   *
   * 🔑 2026-10-31 — THE OWNER RE-DREW THE PREFERENCE LINE: *"maybe long term
   * preferences or habits is worth saving, session preferences aren't worth
   * saving"*. The fear above has three answers it lacked when it was written:
   * every agent save waits on the owner's card (D-329), an agent replaces its own
   * note when a fact changes (D-198 §10), and recall takes the newest of agents'
   * notes (D-198 §13). So a person's lasting preference or habit is saved, one
   * for this conversation is not, and the FIGURES stay banned: they were 128 of
   * the 129 saves below, and nothing about them changed. */
  /** ⛔⛔ 2026-09-10 — THIS PINNED THE WORD "PREFERENCES" AND THAT WAS THE HOLE.
   *  The rule always read "PREFERENCES **or any setting with a current value**",
   *  which covers a levy or a rate — but the LABEL and BOTH EXAMPLES were
   *  preferences, so the model read it as a preference rule and never applied
   *  it to a figure. Measured over 129 stored `memory.write` calls: **128 (99%)
   *  store a MOVABLE value** (levy / surcharge / retainer / quarterly rate) and
   *  **0 store an immutable event**. The catalog was simultaneously forbidding
   *  the class by rule and TEACHING it by example — `summary`'s own sample was
   *  "Acme renewal closes 2026-Q3", a date that moves.
   *  ⇒ the ratchet now pins the GENERAL rule, with preferences as one member,
   *  and requires a movable-VALUE example so the class cannot narrow back. */
  it('⛔ REFUSES any value that can change — the pool cannot supersede, so it must not invite state', () => {
    const write = TIER1_TOOL_DESCRIPTORS['memory.write'].description;
    expect(write).toMatch(/do NOT SAVE any value that can change/i);
    /** ⛔⛔ THE RULE MUST GOVERN SAVING AND NOTHING ELSE. A first cut said
     *  "a figure quoted today is a MOVABLE UNIT that gets recomputed", "never
     *  the running value itself" and "leave THE VALUE to the user" (widened
     *  from the original's narrow "leave the SETTING itself to the user").
     *  None of those is scoped to the save decision, and the model read them
     *  as licence to distrust a figure it already held: driven under pressure
     *  it REFUSED a value sitting in its own brief `constraints` —
     *  "I won't quote a number I can't point to" — where the control answered.
     *  ⇒ a storage rule that leaks into a USAGE prohibition is worse than the
     *  pollution it fixes, so the scoping sentence is pinned and the three
     *  offending phrasings are pinned ABSENT. */
    expect(write).toMatch(/governs what you SAVE, nothing else/i);
    expect(write).not.toMatch(/movable unit/i);
    expect(write).not.toMatch(/never the running value/i);
    expect(write).not.toMatch(/leave the value to the user/i);
    // A movable FIGURE is named, which is the 99% case. Since 2026-10-31 a lasting
    // preference is out of the class, and its own test below pins where it stands.
    expect(write).toMatch(/levy|surcharge|\brate\b/i);
    expect(write).toMatch(/never supersedes/i);
    // The reason travels with the rule; a bare prohibition gets rationalised away.
    expect(write).toMatch(/contradiction/i);
    // The opening still invites knowledge, not preferences in general.
    expect(write).not.toMatch(/a fact, decision, preference/i);
  });

  /** 🔑 Owner, 2026-10-31: *"maybe long term preferences or habits is worth saving,
   *  session preferences aren't worth saving"*. Both halves are pinned, since a dropped
   *  half is a dropped rule, and so is where a changed preference goes. */
  it("saves a person's lasting preference or habit, never a preference for this conversation alone", () => {
    const write = TIER1_TOOL_DESCRIPTORS['memory.write'].description;
    expect(write).toMatch(/A person's lasting preference or habit is worth saving/);
    expect(write).toMatch(/a preference for this conversation or task alone \("keep it short today"\) is not/);
    expect(write).toMatch(/a preference or habit that changed included, pass its `memory_id` as `replaces`/);
    // ⛔ The ban's examples are figures only. A preference there is what taught the
    // model to read the ban as a preference rule (2026-09-10).
    expect(write).not.toMatch(/prefers morning meetings|always cc Sam/i);
    const schema = TIER1_TOOL_DESCRIPTORS['memory.write'].arg_schema as {
      properties: { summary: { description: string } };
    };
    expect(schema.properties.summary.description).toMatch(/a lasting fact about a person, a preference or a habit among them/);
  });

  /** ⛔ D-198 §10 — AN ENTRY THE AGENT DID NOT SAVE IS NOT ITS TO CORRECT, AND A
   *  SECOND ENTRY BESIDE IT IS NOT A CORRECTION. Told "fix that" about the owner's
   *  own entry, a live model saved the corrected fact as a NEW entry in 1 of 7
   *  runs and offered to in 3 more, which leaves recall with both. With this
   *  sentence: 0 and 0 of 7, each pointing at the Memory view (bench task 381,
   *  qwen3.7-plus, 2026-10-23). Scoped to SAVING, like the rule above: it says
   *  nothing about using what the entry says. */
  it("⛔ points the agent at the Memory view for an entry it did not save, instead of a contradicting second entry", () => {
    const write = TIER1_TOOL_DESCRIPTORS['memory.write'].description;
    expect(write).toMatch(/An entry without `by_you` is the user's or another agent's, and you cannot change it/);
    expect(write).toMatch(/instead of saving a second entry that contradicts it/i);
    expect(write).toMatch(/change it in the Memory view/);
  });

  /** ⛔ THE EXAMPLE IS THE RULE THE MODEL ACTUALLY FOLLOWS. `summary`'s sample
   *  must name something that HAPPENED; a running value there teaches exactly
   *  what the description forbids one sentence earlier. */
  it('⛔ the `summary` example is an EVENT, never a running value', () => {
    const schema = TIER1_TOOL_DESCRIPTORS['memory.write'].arg_schema as {
      properties: { summary: { description: string } };
    };
    const summary = schema.properties.summary.description;
    expect(summary).toMatch(/HAPPENED and cannot change/i);
    expect(summary).not.toMatch(/Acme renewal closes/i);
    expect(summary).not.toMatch(/Prefers morning meetings/i);
  });

  it('directs the agent to read `match` BEFORE using the results', () => {
    // Ordering matters: the guidance is useless if it is read after the model
    // has already composed an answer from a loose hit.
    expect(memorySearchDescription).toMatch(/read `match` before using/i);
  });
});

/** D-198 §13 slice 4 — HOW A MODEL WEIGHS SEVERAL STATES OF ONE CLAIM. Recall returns
 *  one current version per lineage, so states meet a model only as separate notes that
 *  are not linked, the owner's rejections, and old chat rows. The order is the owner's
 *  (§13, 2026-10-30): the owner's note first whatever the dates; a revoke is never
 *  stated; the newest of agents' notes; a removal weighs nothing; chat is history. One
 *  sentence, so each clause is pinned: a dropped clause is a dropped rule. */
describe('memory.search — which of several entries about one thing holds', () => {
  const memorySearchDescription =
    TIER1_TOOL_DESCRIPTORS['memory.search'].description;

  it("puts the owner's own entry first, whatever the dates", () => {
    expect(memorySearchDescription).toMatch(/When entries disagree, the owner's own \(`origin_actor` `user_self`\) beats an agent's whatever the dates/);
  });

  it('⛔ never states an entry the owner rejected', () => {
    expect(memorySearchDescription).toMatch(/an entry under `rejected` is one the owner marked wrong, so never state it as true/);
  });

  it("takes the newest of agents' entries, and asks when the difference matters", () => {
    expect(memorySearchDescription).toMatch(/between agents' entries the newest wins, and you ask the user when the difference matters/);
  });

  /** Measured live (bench task 404, 2026-10-30): told "she's called Mia, save that" with
   *  the owner's own entry saying Maya, the model tried `despite_revoked` together with
   *  `replaces`, then alone, reading it as "the owner will be asked". Both are refused, so
   *  each try only cost a slow round. The limits sit where the model reads the argument. */
  it("⛔ despite_revoked names its limits: not with replaces, never over the owner's own entry", () => {
    const schema = TIER1_TOOL_DESCRIPTORS['memory.write'].arg_schema as {
      properties: { despite_revoked: { description: string } };
    };
    const despite = schema.properties.despite_revoked.description;
    expect(despite).toMatch(/Not with `replaces`, and not where the owner's own entry says otherwise/);
    expect(despite).toMatch(/change that in the Memory view/);
  });

  it('gives a removal no weight, and reads old chat as history', () => {
    expect(memorySearchDescription).toMatch(/a removed note counts for nothing, however often it was saved/);
    expect(memorySearchDescription).toMatch(/is only history: its `memory_now` says where that note stands now/);
  });
});
