/** 2026-11-20 (the owner: "go ahead, take slice 4 too, but with the extra tokens spending does get the job done
 *  correctly, so we are not just looking for a lower cost solution but a correct solution that happens to be lower").
 *  A browser call's receipt in the main turn's records keeps what ran and how it ended, and leaves out the pages it
 *  read: in five captured post-fold packets of browser task P, the earlier ref the model then clicked was in these
 *  records' raw pages 7 to 11 times (recued-bridge-vs-browser-use/results/analysis/2026-11-20-P-four-way-handoff-386igzlf). */
import { expect, it } from 'vitest';
import { withoutBrowserPages, type RequestExecutionEvidence } from '../chat-request-evidence.js';

const PAGE = '[button: Edit](e43) Bench stock review';
const view = { page: 'p-1', url: 'https://notes.example/app', outline: PAGE, read_state: { complete: true } };
const act = {
  success: true, recipe_id: 'act-on-web-page', duration_ms: 2_100,
  errors: [{ code: 'DOM_CHECK_FAILED', message: 'Stopped at step 2 of 3', details: { batch_progress: { failed_step: 2, effects: [{ step: 1, attempted: 1, acknowledged: 1 }] },
    post_action: { action_status: 'acknowledged', view } } }],
  browser_state: { action_status: 'acknowledged', check_status: 'passed', transition: 'same_document', view },
  browser_attention: { note: 'Read the view before acting', view },
  browser_check: { step: 2, status: 'passed' },
  output: {
    render: [{ type: 'json', data: { page: 'p-1', url: 'https://notes.example/app', title: 'Notes', steps: ['1. clicked e5', '2. saved'],
      post_action: { action_status: 'acknowledged', view }, tabs: [{ page: 'p-1', url: 'https://notes.example/app',
        reads: [{ step: 3, outline: PAGE, text: PAGE }], interaction_targets: { items: [PAGE] } }] } }],
    sidebar: [{ type: 'json', data: { outline: PAGE, tabs: [{ reads: [{ outline: PAGE }] }] } }],
  },
};
const receipt = (tool_name: string, result: unknown, request = 't2') => ({ invocation_id: `i-${tool_name}`, completed_for_request_id: request,
  tool_name, args: { page: 'p-1' }, result, started_at: 3, completed_at: 4 });
const evidence = (calls: unknown[], earlier: unknown[] = []): RequestExecutionEvidence => ({
  current_request: { request_id: 't2', message_id: 'm2', text: 'Edit the note.', received_at: 2 },
  successful_calls_for_current_request: calls as never, earlier_requests: [], successful_actions_for_earlier_requests: earlier as never,
  recorded_assistant_replies: [],
});
const texts = (value: unknown) => JSON.stringify(value);

it('keeps what a browser batch did and how it ended, and none of the pages it read', () => {
  const [kept] = withoutBrowserPages(evidence([receipt('recued-core/act-on-web-page', act)])).successful_calls_for_current_request;
  expect(texts(kept)).not.toContain('e43');
  for (const key of ['"view"', '"outline"', '"text"', '"reads"', '"sidebar"', '"browser_attention"', '"interaction_targets"']) {
    expect(texts(kept), key).not.toContain(key);
  }
  expect(kept?.result).toEqual({
    success: true, recipe_id: 'act-on-web-page', duration_ms: 2_100,
    errors: [{ code: 'DOM_CHECK_FAILED', message: 'Stopped at step 2 of 3', details: { batch_progress: { failed_step: 2,
      effects: [{ step: 1, attempted: 1, acknowledged: 1 }] }, post_action: { action_status: 'acknowledged' } } }],
    browser_state: { action_status: 'acknowledged', check_status: 'passed', transition: 'same_document' },
    browser_check: { step: 2, status: 'passed' },
    output: { render: [{ type: 'json', data: { page: 'p-1', url: 'https://notes.example/app', title: 'Notes', steps: ['1. clicked e5', '2. saved'],
      post_action: { action_status: 'acknowledged' }, tabs: [{ page: 'p-1', url: 'https://notes.example/app' }] } }] },
  });
});

it('knows a browser tool by its name, or by a browser field in its result, and leaves every other tool\'s result whole', () => {
  const read = { output: { render: [{ type: 'json', data: { page: 'p-1', outline: PAGE } }] }, ran_without_asking: true };
  const mail = { sent: true, message_id: 'x-1', text: 'The note is saved.' };
  const [inspect, copy, other, sent] = withoutBrowserPages(evidence([receipt('recued-core/inspect-web-page', read),
    receipt('kitchen/inspect-web-page', read), receipt('fixture.helper', { browser_state: { action_status: 'acknowledged', view } }),
    receipt('recued-core/mail-send', mail)])).successful_calls_for_current_request;
  expect(inspect?.result).toEqual({ output: { render: [{ type: 'json', data: { page: 'p-1' } }] }, ran_without_asking: true });
  // A copy the owner saved in Kitchen is the browser's by its name alone: this result has no browser field.
  expect(copy?.result).toEqual({ output: { render: [{ type: 'json', data: { page: 'p-1' } }] }, ran_without_asking: true });
  expect(other?.result).toEqual({ browser_state: { action_status: 'acknowledged' } });
  expect(sent?.result).toEqual(mail);
});

it('does the same for earlier requests\' actions, and leaves the evidence the brief\'s writer reads whole', () => {
  const original = evidence([receipt('recued-core/act-on-web-page', act)], [receipt('recued-core/act-on-web-page', act, 't1')]);
  const kept = withoutBrowserPages(original);
  expect(texts(kept.successful_actions_for_earlier_requests)).not.toContain('e43');
  expect(kept.successful_actions_for_earlier_requests[0]?.completed_for_request_id).toBe('t1');
  expect(texts(original)).toContain('e43');
  expect(original.successful_calls_for_current_request[0]?.result).toBe(act);
});
