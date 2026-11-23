/** The owner, 2026-11-20: "go ahead" (the notice fix). The "did not confirm completion" notice (`9fbd4deb4`) went in
 *  front of a correct answer in all four runs of browser task P that failed on it alone. Each was raised by a failed
 *  run whose actions were all accounted for: a refusal before any step ran (the release candidate,
 *  `recued-bridge-vs-browser-use/results/analysis/2026-11-20-P-release-candidate-8913dedde`), or a wait that failed
 *  after every action was acknowledged (`…-P-navigation-rules-pj86u2m8`). The first cut missed two more kinds, and two
 *  runs on `6eb71cdae` failed on them: a refusal before any action while the page's state was unknown, and a step sent
 *  once that the page answered "not found" (`…-P-release-candidate-6eb71cdae`). It stays for an outcome that is
 *  unknown. */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatDispatchResult, InternalToolRegistry, ToolEntry } from '@recued/contracts';
import { failedRunEffectsKnown } from '../chat-failed-run-outcome.js';
import { BRIEF_INSTRUCTION, __clearSessionBriefs, __clearUnfoldedUserMessages } from '../chat-rolling-brief.js';
import { runChatTurn } from '../chat-turn-executor.js';

beforeEach(() => { __clearSessionBriefs(); __clearUnfoldedUserMessages(); });

/** A failed browser-batch run as the dispatch projects it (the shape the P runs recorded). */
const run = (error: Record<string, unknown>) => ({ recipe_id: 'act-on-web-page', success: false,
  output: { render: [{ type: 'json', data: null, label: 'Done' }] },
  steps: [{ id: 'act', type: 'ingredient', skipped: false, duration_ms: 24, error: { error_id: 'act-on-web-page:act:1',
    severity: 'warn', source: { recipe_id: 'act-on-web-page', step_id: 'act', ingredient_slug: 'dom-act' }, ...error } }] });
const nothingRan = { code: 'DOM_SELECTOR_MISSING',
  message: 'Document binding mismatch: this URL continues on https://notes.example/app/, page bridge:a:1:B. The request used a document ref with a URL instead of that page handle. No batch steps ran.',
  details: { batch_progress: { total_steps: 3, failed_step: 1, completed_steps: [], effects: [], page_state: 'ready', current_page: 'bridge:a:1:B' },
    binding_mismatch: { kind: 'document_binding_mismatch', source: 'host_navigation_lineage', executed: false, page: 'bridge:a:1:B' } } };
const checkFailed = { code: 'DOM_CHECK_FAILED',
  message: 'Stopped at step 2 of 3: within 3 seconds “input[placeholder*=\'Email\']” did not show. Done: 1. clicked e12.',
  details: { batch_progress: { total_steps: 3, failed_step: 2, completed_steps: [1], effects: [{ step: 1, attempted: 1, acknowledged: 1 }],
    page_state: 'loading', current_page: 'bridge:a:1:B' },
  check_failure: { step: 2, status: 'failed', kind: 'condition_not_met', selector: 'input[placeholder*=\'Email\']' } } };
// The three refusals the first cut missed (`…-P-release-candidate-6eb71cdae`, r2 and r3).
const pageChanged = { code: 'DOM_SELECTOR_NOT_FOUND',
  message: 'Stopped at step 1 of 5: The page changed since it was inspected: inspect it again. No step was confirmed complete.',
  details: { batch_progress: { total_steps: 5, failed_step: 1, completed_steps: [], effects: [{ step: 1, attempted: 1, acknowledged: 0 }],
    page_state: 'loading' } } };
const notEditable = { code: 'DOM_WRITE_FAILED',
  message: 'Stopped at step 1 of 4: The request targets e24 for typing. The current observation identifies a link named "Login", not an editable field. No typing was attempted.',
  details: { batch_progress: { total_steps: 4, failed_step: 1, completed_steps: [], effects: [], page_state: 'unknown' } } };
const noSuchControl = { code: 'DOM_SELECTOR_NOT_FOUND',
  message: 'Stopped at step 1 of 3: nothing a person can act on is called “Home” on the page as far as it was read.',
  details: { batch_progress: { total_steps: 3, failed_step: 1, completed_steps: [], effects: [], page_state: 'unknown' } } };
// 2026-11-20, later — a click the Bridge refused because a dialog covered its element (`…-P-plain-wait-a5c8a9dcf`, r3).
const covered = { code: 'DOM_WRITE_FAILED',
  message: 'Stopped at step 1 of 3: Something else on the page covers it (“Edit note Category: Home Work Personal Completed Title: Description: Save Cancel”), so it was not clicked. Close or answer that first. No step was confirmed complete.',
  details: { batch_progress: { total_steps: 3, failed_step: 1, completed_steps: [], effects: [{ step: 1, attempted: 1, acknowledged: 0 }],
    page_state: 'ready', current_page: 'bridge:a:1:B' },
  click_obstruction: { operation: 'click', executed: false, reason: 'target_occluded', source: 'hit_test', target: { tag: 'button', ref: 'e35' },
    blocker: { tag: 'div', label: 'Edit note', role: 'dialog' }, waited_ms: 0 } } };
// 2026-11-20, later still — text the Bridge refused for a link, as recorded (`…-P-brief-windows-2c22c26b9`, D64-r3).
const typedIntoLink = { code: 'DOM_WRITE_FAILED',
  message: 'Stopped at step 1 of 5: The element is not a field or an editor. No step was confirmed complete.',
  details: { batch_progress: { total_steps: 5, failed_step: 1, completed_steps: [], effects: [{ step: 1, attempted: 1, acknowledged: 0 }],
    page_state: 'ready', current_page: 'bridge:a:1:B' },
  post_action: { after_step: 1, action_status: 'refused', target: { source: 'kept_read', ref: 'e1', tag: 'a' },
    check_status: 'not_requested', application_outcome: 'unverified', before_page: 'bridge:a:1:B', current_page: 'bridge:a:1:B',
    transition: 'same_document', view_status: 'fresh' },
  control_correction: { ref: 'e1', kind: 'link', name: 'PMP Practice', requested_action: 'type', supported_actions: ['click'],
    source: 'fresh_kept_read' } } };
// 2026-11-21 (the owner: "c yes") — text the Bridge refused for a button behind the open "Edit note" dialog, as recorded
// (`…-P-calibration-F-ec66850f1`, T64-r3), with the host's record a fresh, whole read now adds (`control_blocked`).
const typedBehindDialog = { code: 'DOM_WRITE_FAILED',
  message: 'Stopped at step 1 of 7: An open dialog blocks this field. Use the control inside the active dialog. No step was confirmed complete.',
  details: { batch_progress: { total_steps: 7, failed_step: 1, completed_steps: [], effects: [{ step: 1, attempted: 1, acknowledged: 0 }],
    page_state: 'ready', current_page: 'bridge:a:1:B' },
  post_action: { after_step: 1, action_status: 'refused', target: { source: 'kept_read', ref: 'e58', tag: 'button' },
    check_status: 'not_requested', application_outcome: 'unverified', before_page: 'bridge:a:1:B', current_page: 'bridge:a:1:B',
    transition: 'same_document', view_status: 'fresh' },
  control_blocked: { ref: 'e58', kind: 'button', name: 'Edit', requested_action: 'type', blocked_by: 'dialog', source: 'fresh_kept_read' } } };
// 2026-11-21 — a step whose page had gone since it was read, as recorded (`…-P-brief-windows-2c22c26b9`, A128-r2): the
// page's state is unknown, the step's is not.
const pageGone = { code: 'DOM_SELECTOR_NOT_FOUND',
  message: 'Stopped at step 1 of 6: The page has reloaded, gone to another address or closed since it was read: list the tabs for its current page handle, then inspect it. No step was confirmed complete.',
  details: { batch_progress: { total_steps: 6, failed_step: 1, completed_steps: [], effects: [{ step: 1, attempted: 1, acknowledged: 0 }],
    page_state: 'unknown' } } };
const unacknowledged = { code: 'DOM_CHECK_FAILED', message: 'Stopped at step 2 of 2: the page did not answer after the click.',
  details: { batch_progress: { total_steps: 2, failed_step: 2, completed_steps: [], effects: [{ step: 1, attempted: 1, acknowledged: 0 }],
    page_state: 'unknown' } } };

describe('failedRunEffectsKnown — whether a failed run leaves an action\'s outcome unknown', () => {
  it('is known when nothing ran, or every attempted action was acknowledged and a check failed', () => {
    expect(failedRunEffectsKnown(run(nothingRan))).toBe(true);
    expect(failedRunEffectsKnown(run(checkFailed))).toBe(true);
  });

  it('is known when nothing was attempted, whatever the page last showed', () => {
    expect(failedRunEffectsKnown(run(notEditable))).toBe(true);
    expect(failedRunEffectsKnown(run(noSuchControl))).toBe(true);
  });

  it('is known when the failed step, sent once, was answered "not there"', () => {
    expect(failedRunEffectsKnown(run(pageChanged))).toBe(true);
  });

  it('is known when the failed click, sent once, was covered and not clicked', () => {
    expect(failedRunEffectsKnown(run(covered))).toBe(true);
  });

  it('is known when the failed text, sent once, was refused by a control that only clicks', () => {
    expect(failedRunEffectsKnown(run(typedIntoLink))).toBe(true);
  });

  it('is unknown for refused text without the correction, or for another action, code, step or attempt, or an unknown page', () => {
    const { control_correction: correction, post_action: post, batch_progress: progress } = typedIntoLink.details;
    // An editor that did not take the text: refused, but it was typed into, and the host attaches no correction.
    const untaken = { ...typedIntoLink, message: 'Stopped at step 1 of 5: The editor did not take the text.',
      details: { batch_progress: progress, post_action: post } };
    const typable = { ...typedIntoLink, details: { ...typedIntoLink.details,
      control_correction: { ...correction, supported_actions: ['click', 'type'] } } };
    const otherAction = { ...typedIntoLink, details: { ...typedIntoLink.details,
      control_correction: { ...correction, requested_action: 'press', supported_actions: ['click'] } } };
    const otherCode = { ...typedIntoLink, code: 'DOM_CHECK_FAILED' };
    const uncertain = { ...typedIntoLink, details: { ...typedIntoLink.details, post_action: { ...post, action_status: 'uncertain' } } };
    const unobserved = { ...typedIntoLink, details: { batch_progress: progress, control_correction: correction } };
    const twice = { ...typedIntoLink, details: { ...typedIntoLink.details,
      batch_progress: { ...progress, effects: [{ step: 1, attempted: 2, acknowledged: 0 }] } } };
    const otherStep = { ...typedIntoLink, details: { ...typedIntoLink.details, batch_progress: { ...progress, failed_step: 2 } } };
    for (const error of [untaken, typable, otherAction, otherCode, uncertain, unobserved, twice, otherStep]) {
      expect(failedRunEffectsKnown(run(error))).toBe(false);
    }
  });

  // 2026-11-21 — this was a negative too, kept from the page-state check rather than from a failure: the step's own
  //   answer says nothing was done, so the page's later state cannot make its outcome unknown. Every other action still
  //   has to be acknowledged.
  it('is known for a step the page said it did not carry out, whatever state the page was left in', () => {
    for (const error of [typedIntoLink, covered, pageChanged]) {
      expect(failedRunEffectsKnown(run({ ...error, details: { ...error.details,
        batch_progress: { ...error.details.batch_progress, page_state: 'unknown' } } }))).toBe(true);
    }
    expect(failedRunEffectsKnown(run(pageGone))).toBe(true);
  });

  it('is known when the failed text, sent once, was refused for a field behind an open dialog', () => {
    expect(failedRunEffectsKnown(run(typedBehindDialog))).toBe(true);
  });

  it('is unknown for text refused behind a dialog without the host\'s record of it, or sent twice, or not refused', () => {
    const { control_blocked: blocked, post_action: post, batch_progress: progress } = typedBehindDialog.details;
    const unrecorded = { ...typedBehindDialog, details: { batch_progress: progress, post_action: post } };
    const otherBlock = { ...typedBehindDialog, details: { ...typedBehindDialog.details, control_blocked: { ...blocked, blocked_by: 'overlay' } } };
    const otherAction = { ...typedBehindDialog, details: { ...typedBehindDialog.details, control_blocked: { ...blocked, requested_action: 'press' } } };
    const uncertain = { ...typedBehindDialog, details: { ...typedBehindDialog.details, post_action: { ...post, action_status: 'uncertain' } } };
    const twice = { ...typedBehindDialog, details: { ...typedBehindDialog.details,
      batch_progress: { ...progress, effects: [{ step: 1, attempted: 2, acknowledged: 0 }] } } };
    const otherCode = { ...typedBehindDialog, code: 'DOM_CHECK_FAILED' };
    for (const error of [unrecorded, otherBlock, otherAction, uncertain, twice, otherCode]) {
      expect(failedRunEffectsKnown(run(error))).toBe(false);
    }
  });

  it('is unknown for a page gone since it was read when the step was sent twice, an earlier action went unanswered, or delivery was uncertain', () => {
    const progress = pageGone.details.batch_progress;
    const twice = { ...pageGone, details: { batch_progress: { ...progress, effects: [{ step: 1, attempted: 2, acknowledged: 0 }] } } };
    const earlier = { ...pageGone, details: { batch_progress: { ...progress, failed_step: 2, completed_steps: [],
      effects: [{ step: 1, attempted: 1, acknowledged: 0 }, { step: 2, attempted: 1, acknowledged: 0 }] } } };
    for (const error of [twice, earlier, { ...pageGone, code: 'ACTION_DELIVERY_UNCERTAIN' }]) {
      expect(failedRunEffectsKnown(run(error))).toBe(false);
    }
  });

  it('is unknown for a covered click the Bridge does not say it left undone, sent twice, or on another step', () => {
    const progress = covered.details.batch_progress;
    const clicked = { ...covered, details: { ...covered.details, click_obstruction: { ...covered.details.click_obstruction, executed: true } } };
    const unsaid = { ...covered, details: { batch_progress: progress } };
    const twice = { ...covered, details: { ...covered.details, batch_progress: { ...progress, effects: [{ step: 1, attempted: 2, acknowledged: 0 }] } } };
    const otherStep = { ...covered, details: { ...covered.details, batch_progress: { ...progress, failed_step: 2 } } };
    for (const error of [clicked, unsaid, twice, otherStep]) expect(failedRunEffectsKnown(run(error))).toBe(false);
  });

  it('is unknown when a "not there" could follow a lost answer, belongs to another step, or a write was attempted', () => {
    const progress = pageChanged.details.batch_progress;
    const twice = { ...pageChanged, details: { batch_progress: { ...progress, effects: [{ step: 1, attempted: 2, acknowledged: 0 }] } } };
    expect(failedRunEffectsKnown(run(twice))).toBe(false);
    const otherStep = { ...pageChanged, details: { batch_progress: { ...progress, failed_step: 2 } } };
    expect(failedRunEffectsKnown(run(otherStep))).toBe(false);
    const typed = { ...notEditable, details: { batch_progress: { ...notEditable.details.batch_progress,
      effects: [{ step: 1, attempted: 1, acknowledged: 0 }], page_state: 'ready' } } };
    expect(failedRunEffectsKnown(run(typed))).toBe(false);
  });

  it('is unknown when an attempted action went unacknowledged, even on a page that answered', () => {
    expect(failedRunEffectsKnown(run(unacknowledged))).toBe(false);
    const answered = { ...unacknowledged, details: { batch_progress: { ...unacknowledged.details.batch_progress, page_state: 'ready' } } };
    expect(failedRunEffectsKnown(run(answered))).toBe(false);
  });

  it('is unknown for the codes and page state the batch itself calls unconfirmed', () => {
    for (const code of ['ACTION_DELIVERY_UNCERTAIN', 'DOM_PAGE_NOT_MATCHING']) {
      expect(failedRunEffectsKnown(run({ ...checkFailed, code }))).toBe(false);
    }
    const unknownPage = { ...checkFailed, details: { batch_progress: { ...checkFailed.details.batch_progress, page_state: 'unknown' } } };
    expect(failedRunEffectsKnown(run(unknownPage))).toBe(false);
  });

  it('is unknown without the batch\'s own record, and for any step error that leaves one unknown', () => {
    expect(failedRunEffectsKnown(run({ code: 'MAIL_SEND_FAILED', message: 'The server closed the connection after DATA.' }))).toBe(false);
    expect(failedRunEffectsKnown({ success: false })).toBe(false);
    expect(failedRunEffectsKnown('failed')).toBe(false);
    expect(failedRunEffectsKnown(undefined)).toBe(false);
    const both = run(checkFailed);
    both.steps.push({ ...both.steps[0]!, id: 'second', error: { ...both.steps[0]!.error, ...unacknowledged } });
    expect(failedRunEffectsKnown(both)).toBe(false);
  });
});

const act: ToolEntry = { name: 'fixture.act', tier: 1, classification: 'write', description: 'Act in a page.',
  arg_schema: { type: 'object', properties: { page: { type: 'string' } }, required: ['page'], additionalProperties: false },
  topic_tags: [], concurrency_safe: false };
const look: ToolEntry = { ...act, name: 'fixture.look', classification: 'read', concurrency_safe: true };
const ANSWER = '{"title":"Bench stock review verified","completed":false}';

/** A turn as P runs it: one action that fails, a read of the result, then the answer as one JSON object. */
const turnAfter = async (failed: ChatDispatchResult): Promise<string> => {
  const registry: InternalToolRegistry = { list: () => [act, look], listByTier: () => [act, look],
    getByName: name => [act, look].find(tool => tool.name === name) ?? null,
    dispatch: async () => { throw Error('Use the native dispatch seam'); }, subscribeRefresh: () => () => {} };
  let calls = 0;
  const result = await runChatTurn({ session_id: 'notice', turn_id: 'owner', picker_target: 'self', dispatch_peer_name: null,
    available_tools: [act, look].map(tool => ({ recipe_slug: tool.name, args_schema: tool.arg_schema })),
    content: { chat_tail: [], user_message: 'Save the note on page P1, then answer with one JSON object.' }, correction_context: [],
    model_layer: 'byok' }, {
    registry, rollingBriefEnabled: () => true, now: () => 1000, emit() {},
    dispatchTool: async ({ tool_name }): Promise<ChatDispatchResult> => tool_name === act.name ? failed
      : { ok: true, result: { title: 'Bench stock review verified', completed: false } },
    executeAiCall: async (_manifest, input) => {
      if (String(input['llm.system_prompt']).startsWith(BRIEF_INSTRUCTION)) {
        return { body: { intent: 'Save the note.', constraints: [], pending: [], findings: ['The note reads as saved.'] } };
      }
      const body = { response: calls < 2 ? '' : ANSWER, events: [], tool_calls: calls++ < 2
        ? [{ tool: calls === 1 ? act.name : look.name, args: { page: 'P1' } }] : [] };
      return { body };
    },
  });
  expect(calls).toBe(3);
  return result.assistant_content;
};

describe('the answer after a failed run', () => {
  it.each([['nothing ran', nothingRan], ['a check failed after the click was acknowledged', checkFailed],
    ['the target was not an editable field', notEditable], ['no control had that name', noSuchControl],
    ['the page answered that its target was gone', pageChanged], ['a dialog covered the click, which was not made', covered],
    ['text for a link, which takes none, was refused', typedIntoLink],
    ['text for a field behind an open dialog was refused', typedBehindDialog], ['the page had gone since it was read', pageGone]])(
    'is the model\'s answer alone when %s', async (_case, error) => {
      expect(await turnAfter({ ok: true, result: run(error), run_failed: { detail: 'The run failed.' } })).toBe(ANSWER);
    });

  it('still carries the notice when an attempted action went unacknowledged', async () => {
    const answer = await turnAfter({ ok: true, result: run(unacknowledged), run_failed: { detail: 'The run failed.' } });
    expect(answer).toContain('did not confirm completion');
    expect(answer.endsWith(ANSWER)).toBe(true);
  });

  it('still carries the notice when the dispatch itself failed, with no record of what ran', async () => {
    expect(await turnAfter({ ok: false, reason: 'execution_error', detail: 'Transport failed after dispatch; outcome unknown.' }))
      .toContain('did not confirm completion');
  });
});
