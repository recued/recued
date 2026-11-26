/** D-335 slice J — a sequence of steps on one page (`core.dom.act`), as the DOM adapter runs it once
 *  approved: each step through the Bridge's own action, Recued's checks after each (a CAPTCHA
 *  stops it, a sent form may update the same document), a step's own `expect`, and a stop that says how
 *  far it got and where the tab is. The Bridge here is a stub answering by action; what the
 *  Bridge does in real Chrome is pinned by `browser-toolkit-browser.test.ts`. The hold and its
 *  ask are pinned by `held-browser-target.test.ts`. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_FILL_OUTPUT_KEYS,
  BRIDGE_PICK_OUTPUT_KEYS,
  BRIDGE_SUBMIT_OUTPUT_KEYS,
  BRIDGE_WAIT_OUTPUT_KEYS,
  bridgeElementChangedMessage,
  bridgeRunsCommand,
  readBrowserFailure,
  type BridgeCapabilityProfile,
  type BridgeResult,
} from '@recued/contracts';
import type { ResolvedCall } from '@recued/ingredients';

import type { BridgeDispatcher, DispatchOutcome, DispatchRequest } from '../bridges/dispatcher.js';
import type { BrowserFiles } from '../bridges/browser-files.js';
import { createBridgeDomAdapter, describeBridgeDomCall, PAGE_UNCHANGED_NOTE, PICK_NOT_REVIEWABLE_MESSAGE } from '../bridges/dom-adapter.js';
import { createBrowserBatchAdmissions, type BrowserBatchAdmissions } from '../bridges/browser-batch-admission.js';
import { createPageReadStore } from '../bridges/page-outline.js';
import { createBrowserFlowRecorder } from '../bridges/browser-flow-record.js';
import type { BrowserSecretRequest, BrowserSecretSource } from '../bridges/browser-secrets.js';
import { describeReviewedDom } from '../preapproval-dom.js';
import { withRunAbortContext } from '../execution/run-abort-context.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { withPreapprovalIo, type PreapprovalIoContext } from '../preapproval-io-context.js';

afterEach(() => { vi.useRealTimers(); });

const PAGE = '7:DOC1';
const LOGIN_URL = 'https://example.com/login';
const HOME = { page: '7:DOC2', url: 'https://example.com/home', title: 'Home' };
const noObservation = (requested_page = PAGE) => ({ page_observation: { state: 'unavailable', reason: 'read_failed', requested_page } });

const ok = (outputs: Record<string, unknown>): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'bridge-1',
  attempts: 1, result: { command_id: 'c', duration_ms: 3, bridge_version: '0.0.7', idempotency_key_seen: false, status: 'ok',
    outputs } as BridgeResult });
const failed = (code: string, message: string): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'bridge-1',
  attempts: 1, result: { command_id: 'c', duration_ms: 3, bridge_version: '0.0.7', idempotency_key_seen: false,
    status: 'error', error: { code, message } } as BridgeResult });

/** The answers a Bridge gives, one per command in order (the last repeating), or by action. */
type Answer = DispatchOutcome | ((request: DispatchRequest) => DispatchOutcome);
const act = async (steps: unknown, answers: Answer[] | Partial<Record<string, Answer>>, runs?: BridgeDispatcher['runs'],
  files?: BrowserFiles) => {
  const requests: DispatchRequest[] = [];
  const dispatch = vi.fn<BridgeDispatcher['dispatch']>(async (request) => {
    requests.push(request);
    const answer = Array.isArray(answers) ? answers[Math.min(requests.length - 1, answers.length - 1)]
      : answers[request.action];
    if (answer === undefined) throw new Error(`no answer for ${request.action}`);
    return typeof answer === 'function' ? answer(request) : answer;
  });
  const adapter = createBridgeDomAdapter({
    manifests: { get: (slug) => KERNEL_MANIFESTS.find((manifest) => manifest.slug === slug) ?? null },
    getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: vi.fn(() => false), ...(runs ? { runs } : {}) }),
    ...(files ? { files } : {}),
  });
  const manifest = KERNEL_MANIFESTS.find((m) => m.slug === 'dom-act')!;
  const call: ResolvedCall = { slug: 'dom-act', risk_tier: 'write', output: manifest.output,
    input: { target: '*://*/*', page: PAGE, steps },
    stepMeta: { recipe_id: 'act-on-web-page', step_id: 'act', run_id: 'run-1' } };
  const settled: { result?: unknown; error?: unknown } = await adapter(call)
    .then((result) => ({ result }), (error: unknown) => ({ error }));
  // Slice T — once a sequence is over, the server reads the page it ended on for what changed: a
  // read of its own, pinned by `d-335-inspect-outline.test.ts`, so set apart from the steps' commands.
  return { ...settled, requests: requests.filter((r) => r.action !== 'reread'), rereads: requests.filter((r) => r.action === 'reread') };
};
const message = (error: unknown) => (error as { message?: string }).message;
const code = (error: unknown) => (error as { code?: string }).code;

it('preserves the first file and click receipt when storing a later export file fails', async () => {
  const file = { file_ref: 'file:' + '1'.repeat(32), filename: 'overview.csv', mime_type: 'text/csv',
    size_bytes: 1, sha256: 'a'.repeat(64) };
  const keep = vi.fn<BrowserFiles['keep']>().mockResolvedValueOnce(file).mockRejectedValueOnce(new Error('storage unavailable'));
  const downloads = ['overview.csv', 'details.csv'].map(filename => ({ filename, mime_type: 'text/csv', size: 1, data: 'YQ==' }));
  const { error, requests } = await act([
    { do: 'click', ref: 'e1', download_wait: 0.2 }, { do: 'click', ref: 'e2' },
  ], { click: ok({ clicked: true, generated_downloads: downloads }) }, undefined,
  { keep, read: vi.fn(), about: vi.fn() });
  expect(requests.map(request => request.args.ref)).toEqual(['e1']);
  expect(keep.mock.calls.map(([input]) => input.step_id)).toEqual(['act#download1.1', 'act#download1.2']);
  expect(message(error)).toContain('1 of 2 files were kept');
  const details = readBrowserFailure(error)?.details;
  expect(details?.batch_progress?.effects).toEqual([{ step: 1, attempted: 1, acknowledged: 1 }]);
  expect(details?.completed_files).toEqual([{ step: 1, file_ref: file.file_ref, filename: file.filename,
    mime_type: file.mime_type, size_bytes: file.size_bytes }]);
});

const SIGN_IN = [
  { do: 'type', ref: 'e3', value: 'ada@example.com' },
  { do: 'type', ref: 'e5', value: 'hunter2', submit: true },
];

describe('D-335 slice J — a sequence runs step by step, one approval for all of them', () => {
  it('a sign-in: types, then types and sends, and answers the page the tab lands on', async () => {
    const { result, requests, rereads } = await act(SIGN_IN, {
      fill: ok({ filled: true }),
      submit: ok({ filled: true, submitted: true, moved: true, ...HOME }),
    });
    expect(result).toMatchObject({ done: 2, of: 2, steps: ['typed into e3', 'typed into e5 and sent its form'], ...HOME, post_action: { action_status: 'acknowledged', view_status: 'unavailable', application_outcome: 'unverified' } });
    expect(requests.map((r) => [r.action, r.args])).toEqual([
      ['fill', { page: PAGE, ref: 'e3', value: 'ada@example.com' }],
      // Sending is Recued's own check: the page must move on, so the Bridge watches for it.
      ['submit', { page: PAGE, ref: 'e5', value: 'hunter2', watch_ms: 5_000 }],
    ]);
    expect(requests[0]!.expects_output_keys).toEqual([...BRIDGE_FILL_OUTPUT_KEYS]);
    expect(requests[1]!.expects_output_keys).toEqual([...BRIDGE_SUBMIT_OUTPUT_KEYS]);
    // Each command its own idempotency cell, so a retried run replays what was done.
    expect(new Set(requests.map((r) => r.idempotency_key)).size).toBe(2);
    expect(requests.every((r) => r.step_id === 'act')).toBe(true);
    // Then the page it landed on is read for what changed (slice T).
    expect(rereads.map((r) => r.args.page)).toEqual([HOME.page]);
  });

  it('a retried run sends the same commands, so the Bridge replays them rather than acting twice', async () => {
    const answers = { fill: ok({ filled: true }), submit: ok({ submitted: true, filled: true, moved: true, ...HOME }) };
    const first = await act(SIGN_IN, answers);
    const again = await act(SIGN_IN, answers);
    expect(again.requests.map((r) => r.idempotency_key)).toEqual(first.requests.map((r) => r.idempotency_key));
  });

  it('requires horizontal scrolling support before a batch starts', async () => {
    const older = { supported_actions: ['click', 'scroll', 'describe', 'reread'] };
    expect(bridgeRunsCommand(older, 'scroll', { page: PAGE, to: 'next' })).toBe(true);
    const result = await act([{ do: 'click', ref: 'e1' }, { do: 'scroll', to: 'right' }], {},
      ({ action, args }) => bridgeRunsCommand(older, action, args));
    expect(code(result.error)).toBe('ROLE_RESTRICTION');
    expect(message(result.error)).toContain('scroll horizontally at step 2');
    expect(result.requests).toEqual([]);
    expect(result.rereads).toEqual([]);
  });

  it('a CAPTCHA stops the sequence where it shows, saying how far it got and where the tab is', async () => {
    const { error, requests } = await act([...SIGN_IN, { do: 'click', ref: 'e9' }], [ok({ filled: true, challenge: 'reCAPTCHA' })]);
    expect(code(error)).toBe('DOM_CHECK_FAILED');
    expect(message(error)).toContain('Stopped at step 1 of 3: the page now shows a reCAPTCHA CAPTCHA that nobody has solved');
    expect(message(error)).toContain('no fresh tab snapshot was returned');
    expect(readBrowserFailure(error)?.details.batch_progress).toMatchObject({ failed_step: 1, completed_steps: [] });
    expect(requests).toHaveLength(1);
  });

  it('a CAPTCHA a sent form meets stops it too, on the page the tab shows', async () => {
    const { error } = await act(SIGN_IN, { fill: ok({ filled: true }),
      submit: ok({ submitted: true, filled: true, moved: false, page: PAGE, url: LOGIN_URL, title: 'Sign in', challenge: 'hCaptcha' }) });
    expect(code(error)).toBe('DOM_CHECK_FAILED');
    expect(message(error)).toContain('Stopped at step 2 of 2: the page now shows a hCaptcha CAPTCHA that nobody has solved');
    expect(message(error)).toContain('last observed tab snapshot');
    expect(readBrowserFailure(error)?.details.batch_progress).toMatchObject({ failed_step: 2, completed_steps: [1] });
  });

  it('an acknowledged form that stays on the same document leaves application success unverified', async () => {
    const { result, error } = await act(SIGN_IN, { fill: ok({ filled: true }),
      submit: ok({ submitted: true, filled: true, moved: false, page: PAGE, url: LOGIN_URL, title: 'Sign in' }) });
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ done: 2, post_action: { action_status: 'acknowledged', check_status: 'not_requested',
      transition: 'unknown', application_outcome: 'unverified', view_status: 'unavailable' } });
  });

  it('a form whose success_when names what shows is checked by it, not by the page moving on', async () => {
    const steps = [{ do: 'type', ref: 'e3', value: 'cats', submit: true, success_when: { shows: '#results', text: 'cats' } }];
    const unmoved = ok({ submitted: true, filled: true, moved: false, page: PAGE, url: 'https://example.com/', title: 'Search' });
    const found = await act(steps, { submit: unmoved, wait_for_element: ok({ found: true, page: PAGE, url: '', title: '' }) });
    expect(found.result).toMatchObject({ done: 1, of: 1 });
    // No longer watch for a move: what shows is the check, waited for in the page as it is, with
    // an eye on any error message the form led to (slice K).
    expect(found.requests[0]!.args).toEqual({ page: PAGE, ref: 'e3', value: 'cats' });
    expect(found.requests[1]).toMatchObject({ action: 'wait_for_element',
      args: { page: PAGE, selector: '#results', until: 'shown', text: 'cats', timeout_ms: 5_000, problems: true },
      expects_output_keys: [...BRIDGE_WAIT_OUTPUT_KEYS] });
    const missing = await act(steps, { submit: unmoved, wait_for_element: ok({ found: false, page: PAGE, url: '', title: '' }) });
    expect(message(missing.error)).toMatch(/^Stopped at step 1 of 1: within 5 seconds “#results” holding “cats” did not show\./);
  });

  it('checks the address, the page staying, something going, and text anywhere', async () => {
    const click = (success_when: object) => [{ do: 'click', ref: 'e9', success_when }];
    const landed = ok({ clicked: true, moved: true, ...HOME });
    expect((await act(click({ url_includes: '/home' }), { click: landed })).result).toMatchObject({ done: 1 });
    expect((await act(click({ url_includes: '/home', seconds: 8 }), { click: landed })).requests[0]!.args)
      .toEqual({ page: PAGE, ref: 'e9', watch_ms: 8_000 });
    expect(message((await act(click({ url_includes: '/inbox' }), { click: landed })).error))
      .toMatch(/^Stopped at step 1 of 1: the address is https:\/\/example\.com\/home, which does not contain “\/inbox”\./);
    expect(message((await act(click({ page_changes: false }), { click: landed })).error))
      .toMatch(/^Stopped at step 1 of 1: the page moved on, and the step expected it to stay\./);
    const gone = await act(click({ gone: '#login' }), { click: landed, wait_for_element: ok({ found: true }) });
    expect(gone.requests[1]!.args).toEqual({ page: HOME.page, selector: '#login', until: 'gone', timeout_ms: 5_000 });
    const text = await act(click({ text: 'Welcome back' }), { click: landed, wait_for_element: ok({ found: false }) });
    expect(text.requests[1]!.args).toEqual({ page: HOME.page, selector: 'body', until: 'shown', text: 'Welcome back', timeout_ms: 5_000 });
    expect(message(text.error)).toMatch(/^Stopped at step 1 of 1: within 5 seconds the text “Welcome back” did not show\./);
  });

  it('a ref after a step that loaded a new page is refused before it is sent; a selector goes on there', async () => {
    const moved = ok({ clicked: true, moved: true, ...HOME });
    const byRef = await act([{ do: 'click', ref: 'e3' }, { do: 'click', ref: 'e4' }], { click: moved });
    expect(code(byRef.error)).toBe('DOM_SELECTOR_NOT_FOUND');
    expect(message(byRef.error)).toContain('Stopped at step 2 of 2: it names e4, a ref from the page before step 1 loaded a new one');
    expect(message(byRef.error)).toContain('last observed tab snapshot');
    expect(readBrowserFailure(byRef.error)?.details.batch_progress).toMatchObject({ failed_step: 2, completed_steps: [1], page_state: 'unknown' });
    expect(readBrowserFailure(byRef.error)?.details.batch_progress).not.toHaveProperty('current_page');
    expect(byRef.requests).toHaveLength(1);
    const bySelector = await act([{ do: 'click', ref: 'e3' }, { do: 'click', selector: '#next' }], { click: moved });
    expect(bySelector.result).toMatchObject({ done: 2, steps: ['clicked e3', 'clicked “#next”'] });
    // A click with no success_when is watched as a send if it turns out to send a form (slice K).
    expect(bySelector.requests[1]!.args).toEqual({ page: HOME.page, selector: '#next', send_watch_ms: 5_000 });
  });

  it('a step that fails keeps its own error, and says how far the sequence got', async () => {
    const { error } = await act(SIGN_IN, [ok({ filled: true }),
      failed('value_not_applied', 'The form was not sent: password: Please fill in this field.')]);
    expect(code(error)).toBe('DOM_WRITE_FAILED');
    expect(message(error)).toContain('Stopped at step 2 of 2: The form was not sent: password: Please fill in this field.');
    expect(message(error)).toContain('its current document is unverified');
    const progress = readBrowserFailure(error)?.details.batch_progress;
    expect(progress).toMatchObject({ failed_step: 2, completed_steps: [1], page_state: 'unknown' });
    expect(progress).not.toHaveProperty('current_page');
    // A Bridge that predates sending a form says so, after the steps before it.
    const old = await act(SIGN_IN, [ok({ filled: true }), { kind: 'capacity_gap', capacity_gap: { kind: 'bridge_online' },
      reason: 'bridge_update_required', attempts: 0 }]);
    expect(message(old.error)).toMatch(/^Stopped at step 2 of 2: Update the Browser Bridge: the connected one cannot run 'submit'/);
  });

  it('a page still loading when the Bridge stopped waiting ends the sequence there, unless nothing is left', async () => {
    const loading = ok({ submitted: true, filled: true, moved: true });
    const last = await act(SIGN_IN, { fill: ok({ filled: true }), submit: loading });
    // No handle yet: the model lists the tabs for it.
    expect(last.result).toMatchObject({ done: 2, of: 2, steps: ['typed into e3', 'typed into e5 and sent its form'], post_action: { view_status: 'unavailable', reason: 'page_loading', transition: 'unknown' } });
    const more = await act([...SIGN_IN, { do: 'click', selector: '#continue' }], { fill: ok({ filled: true }), submit: loading });
    expect(message(more.error)).toBe('Stopped at step 2 of 3: the page started loading and was not ready within 10 seconds, so '
      + 'the next step could not be done: list the tabs for its page handle, then inspect it. Done: 1. typed into e3; '
      + '2. typed into e5 and sent its form. The tab was loading a new page.');
    expect(more.requests).toHaveLength(2);
  });

  it('a pause waits, and a run stopped during it sends nothing more', async () => {
    vi.useFakeTimers();
    const steps = [{ do: 'click', ref: 'e3' }, { do: 'wait', seconds: 2 }, { do: 'click', ref: 'e4' }];
    const answers = { click: ok({ clicked: true, moved: false, page: PAGE, url: LOGIN_URL, title: 'Sign in' }) };
    const paused = act(steps, answers);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await paused).result).toMatchObject({ done: 3, steps: ['clicked e3', 'waited 2 s', 'clicked e4'] });

    const stop = new AbortController();
    const stopped = withRunAbortContext({ run_id: 'run-1', signal: stop.signal }, () => act(steps, answers));
    await vi.advanceTimersByTimeAsync(500);
    stop.abort(new Error('The owner stopped the run.'));
    const { error, requests } = await stopped;
    expect(message(error)).toBe('The owner stopped the run.');
    expect(requests).toHaveLength(1);
  });

  it('checks the steps before anything is sent, and never runs in a reviewed run', async () => {
    const empty = await act([], [ok({})]);
    expect(code(empty.error)).toBe('DOM_SELECTOR_MISSING');
    expect(message(empty.error)).toBe('core.dom.act: steps must be a list of at least one step');
    expect(empty.requests).toEqual([]);
    const reviewed = await withPreapprovalIo({} as PreapprovalIoContext, () => act(SIGN_IN, [ok({ filled: true })]));
    expect(code(reviewed.error)).toBe('ROLE_RESTRICTION');
    expect(reviewed.requests).toEqual([]);
    // Preparing a reviewed run says why, rather than that the op names no site.
    const manifest = KERNEL_MANIFESTS.find((m) => m.slug === 'dom-act')!;
    expect(() => describeBridgeDomCall(manifest, { slug: 'dom-act', output: manifest.output,
      input: { target: '*://*/*', page: PAGE, steps: SIGN_IN } }))
      .toThrow('core.dom.act cannot run in a reviewed run: its steps are sent one at a time, as each is reached');
  });
});

describe('D-335 slice K — failure, caught as it happens', () => {
  const SIGN_IN_PAGE = { page: PAGE, url: LOGIN_URL, title: 'Sign in' };
  const AGAIN = { page: '7:DOC3', url: LOGIN_URL, title: 'Sign in' };
  const INVALID = 'Your password is invalid!';

  it('an error message a sent form leads to stops the sequence then, quoting it', async () => {
    const { error } = await act(SIGN_IN, { fill: ok({ filled: true }),
      submit: ok({ submitted: true, filled: true, moved: false, ...SIGN_IN_PAGE, problem: INVALID }) });
    expect(code(error)).toBe('DOM_CHECK_FAILED');
    expect(message(error)).toContain(`Stopped at step 2 of 2: the page shows an error message: “${INVALID}”.`);
    expect(message(error)).toContain('last observed tab snapshot');
    expect(readBrowserFailure(error)?.details.batch_progress).toMatchObject({ failed_step: 2, completed_steps: [1] });
  });

  it('a form sent back to its page with an error is a failure, though the page moved on', async () => {
    // As the-internet's sign-in does: the form posts, and the page comes back with its error.
    const { error } = await act(SIGN_IN, { fill: ok({ filled: true }),
      submit: ok({ submitted: true, filled: true, moved: true, ...AGAIN, problem: INVALID }) });
    expect(message(error)).toMatch(new RegExp(`^Stopped at step 2 of 2: the page shows an error message: “${INVALID}”\\.`));
  });

  it('a success_when that holds outweighs an error message Recued only recognizes', async () => {
    const steps = [{ do: 'click', ref: 'e9', success_when: { url_includes: '/home' } }];
    const { result } = await act(steps, { click: ok({ clicked: true, moved: true, ...HOME, problem: '1 error in your plan' }) });
    expect(result).toMatchObject({ done: 1, url: HOME.url });
    // One that does not hold: the message says more than the address would.
    const away = await act([{ do: 'click', ref: 'e9', success_when: { url_includes: '/inbox' } }],
      { click: ok({ clicked: true, moved: true, ...HOME, problem: INVALID }) });
    expect(message(away.error)).toMatch(/^Stopped at step 1 of 1: the page shows an error message: /);
  });

  it('a fail_when on the page is watched for during the click, and stops it as soon as it shows', async () => {
    const steps = [{ do: 'click', ref: 'e4', fail_when: { shows: '.flash.error' } }];
    const { error, requests } = await act(steps,
      { click: ok({ clicked: true, moved: false, ...SIGN_IN_PAGE, failed: true, problem: INVALID }) });
    // Watched for as long as the step checks, beside the page moving.
    expect(requests[0]!.args).toEqual({ page: PAGE, ref: 'e4', watch_ms: 5_000, send_watch_ms: 5_000,
      fail: { selector: '.flash.error' } });
    expect(message(error)).toContain('Stopped at step 1 of 1: the step\'s fail_when holds: “.flash.error” shows');
    expect(message(error)).toContain(INVALID);
    expect(message(error)).toContain('last observed tab snapshot');
    expect(readBrowserFailure(error)?.details.batch_progress).toMatchObject({ failed_step: 1, completed_steps: [] });
  });

  it('a fail_when on the address stops a click that lands there', async () => {
    const steps = [{ do: 'click', ref: 'e4', fail_when: { url_includes: '/login' } }];
    const { error, requests } = await act(steps, { click: ok({ clicked: true, moved: true, ...AGAIN }) });
    // Nothing on the page to watch: the Bridge is not asked for it.
    expect(requests[0]!.args).not.toHaveProperty('fail');
    expect(message(error)).toMatch(/^Stopped at step 1 of 1: the step's fail_when holds: the address is https:\/\/example\.com\/login, which contains “\/login”\./);
  });

  it('a click on a form\'s send button is checked as a sent form', async () => {
    const steps = [SIGN_IN[0], { do: 'click', ref: 'e4' }];
    const unmoved = await act(steps, { fill: ok({ filled: true }),
      click: ok({ clicked: true, sent: true, moved: false, ...SIGN_IN_PAGE }) });
    expect(unmoved.requests[1]!.args).toEqual({ page: PAGE, ref: 'e4', send_watch_ms: 5_000 });
    expect(unmoved.error).toBeUndefined();
    expect(unmoved.result).toMatchObject({ post_action: { action_status: 'acknowledged', application_outcome: 'unverified', transition: 'unknown', view_status: 'unavailable' } });
    const signedIn = await act(steps, { fill: ok({ filled: true }), click: ok({ clicked: true, sent: true, moved: true, ...HOME }) });
    expect(signedIn.result).toMatchObject({ done: 2, steps: ['typed into e3', 'clicked e4, which sent its form'], ...HOME });
    // A click that sends nothing has no such check.
    const plain = await act([{ do: 'click', ref: 'e9' }], { click: ok({ clicked: true, moved: false, ...SIGN_IN_PAGE }) });
    expect(plain.result).toMatchObject({ done: 1 });
  });

  it('a wait for what shows races the fail_when and an error message', async () => {
    const steps = [{ do: 'submit', ref: 'e5', success_when: { shows: '#welcome' }, fail_when: { text: 'Invalid' } }];
    const sent = ok({ submitted: true, moved: false, ...SIGN_IN_PAGE });
    const raced = (wait: DispatchOutcome) => act(steps, { submit: sent, wait_for_element: wait });
    const welcomed = await raced(ok({ found: true, ...SIGN_IN_PAGE }));
    expect(welcomed.result).toMatchObject({ done: 1 });
    expect(welcomed.requests[1]!.args).toEqual({ page: PAGE, selector: '#welcome', until: 'shown', timeout_ms: 5_000,
      fail: { selector: 'body', text: 'Invalid' }, problems: true });
    expect(message((await raced(ok({ found: false, failed: true, ...SIGN_IN_PAGE }))).error))
      .toMatch(/^Stopped at step 1 of 1: the step's fail_when holds: the text “Invalid” shows\./);
    expect(message((await raced(ok({ found: false, problem: INVALID, ...SIGN_IN_PAGE }))).error))
      .toMatch(new RegExp(`^Stopped at step 1 of 1: the page shows an error message: “${INVALID}”\\.`));
    expect(message((await raced(ok({ found: false, ...SIGN_IN_PAGE }))).error))
      .toMatch(/^Stopped at step 1 of 1: within 5 seconds “#welcome” did not show\./);
  });

  it('a wait step watches for error messages only on the page a click or a send noted', async () => {
    const wait = { do: 'wait', selector: '#results', fail_when: { shows: '.error' } };
    const stayed = await act([{ do: 'click', ref: 'e2' }, wait], { click: ok({ clicked: true, moved: false, ...SIGN_IN_PAGE }),
      wait_for_element: ok({ found: false, failed: true, ...SIGN_IN_PAGE }) });
    expect(stayed.requests[1]!.args).toEqual({ page: PAGE, selector: '#results', until: 'shown', timeout_ms: 5_000,
      fail: { selector: '.error' }, problems: true });
    expect(message(stayed.error)).toMatch(/^Stopped at step 2 of 2: the step's fail_when holds: “\.error” shows\./);
    // A new page has no note to compare with.
    const moved = await act([{ do: 'click', ref: 'e2' }, wait], { click: ok({ clicked: true, moved: true, ...HOME }),
      wait_for_element: ok({ found: true, ...HOME }) });
    expect(moved.requests[1]!.args).not.toHaveProperty('problems');
    // Typing notes nothing and asks the Bridge for neither.
    const typed = await act([{ do: 'type', ref: 'e3', value: 'x', success_when: { shows: '.ok' }, fail_when: { text: 'taken' } }],
      { fill: ok({ filled: true }), wait_for_element: ok({ found: true }) });
    expect(typed.requests[0]!.args).toEqual({ page: PAGE, ref: 'e3', value: 'x' });
    expect(typed.requests[1]!.args).toEqual({ page: PAGE, selector: '.ok', until: 'shown', timeout_ms: 5_000,
      fail: { selector: 'body', text: 'taken' } });
  });
});

describe('D-335 slice L — typing that picks one of the field\'s suggestions', () => {
  const NEW_DEAL = { page: PAGE, url: 'https://example.com/deals/new', title: 'New deal' };
  const COMPANY = { do: 'type', ref: 'e3', value: 'Acme', pick: 'Acme Corp' };

  it('sends one pick: the text, the suggestion and how long to wait for it, inside a longer command', async () => {
    const { result, requests } = await act([COMPANY], { pick: ok({ filled: true, picked: 'Acme Corp', moved: false, ...NEW_DEAL }) });
    expect(result).toEqual({ done: 1, of: 1, steps: ['typed into e3 and picked “Acme Corp”'], ...NEW_DEAL, ...noObservation() });
    expect(requests.map((r) => [r.action, r.args])).toEqual([
      ['pick', { page: PAGE, ref: 'e3', value: 'Acme', pick: 'Acme Corp', pick_ms: 5_000 }]]);
    expect(requests[0]!.expects_output_keys).toEqual([...BRIDGE_PICK_OUTPUT_KEYS]);
    expect(requests[0]!.timeout_ms).toBe(25_000);
  });

  it('with submit: picks, then sends the form, watched as a send is', async () => {
    const { result, requests } = await act([{ ...COMPANY, submit: true }], {
      pick: ok({ filled: true, picked: 'Acme Corp', moved: false, ...NEW_DEAL }),
      submit: ok({ submitted: true, moved: true, ...HOME }),
    });
    expect(result).toMatchObject({ done: 1, of: 1, steps: ['typed into e3, picked “Acme Corp” and sent its form'], ...HOME, post_action: { action_status: 'acknowledged', application_outcome: 'unverified' } });
    expect(requests.map((r) => [r.action, r.args])).toEqual([
      ['pick', { page: PAGE, ref: 'e3', value: 'Acme', pick: 'Acme Corp', pick_ms: 5_000 }],
      // Nothing typed again: the pick put the text in.
      ['submit', { page: PAGE, ref: 'e3', watch_ms: 5_000 }]]);
    expect(new Set(requests.map((r) => r.idempotency_key)).size).toBe(2);
  });

  it('a suggestion that loaded a new page: no send after it, and a ref after it is refused', async () => {
    const article = { page: '7:DOC5', url: 'https://example.com/wiki/Ada_Lovelace', title: 'Ada Lovelace' };
    const sent = await act([{ ...COMPANY, submit: true }], { pick: ok({ filled: true, picked: 'Acme Corp', moved: true, ...article }) });
    expect(sent.result).toEqual({ done: 1, of: 1,
      steps: ['typed into e3 and picked “Acme Corp”, which loaded a new page, so its form was not sent'], ...article, ...noObservation(article.page) });
    expect(sent.requests.map((r) => r.action)).toEqual(['pick']);
    const after = await act([COMPANY, { do: 'click', ref: 'e7' }], { pick: ok({ filled: true, picked: 'Acme Corp', moved: true, ...article }) });
    expect(message(after.error)).toMatch(/^Stopped at step 2 of 2: it names e7, a ref from the page before step 1 loaded a new one/);
  });

  it('a suggestion the Bridge could not pick stops the sequence with its words', async () => {
    const none = 'None of its suggestions is “Acme Corp”. They were: “Acme Inc”; “Acme Ltd”. Pick one of them by its text.';
    const { error } = await act([COMPANY, { do: 'click', ref: 'e9' }], [failed('value_not_applied', none)]);
    expect(message(error)).toContain(`Stopped at step 1 of 2: ${none} No step was confirmed complete.`);
    expect(message(error)).toContain('its current document is unverified');
    const progress = readBrowserFailure(error)?.details.batch_progress;
    expect(progress).toMatchObject({ failed_step: 1, completed_steps: [], page_state: 'unknown' });
    expect(progress).not.toHaveProperty('current_page');
  });

  it('a Bridge that predates picking says to update it, after the steps before', async () => {
    const old = await act([{ do: 'type', ref: 'e2', value: 'Big deal' }, COMPANY], [ok({ filled: true }),
      { kind: 'capacity_gap', capacity_gap: { kind: 'bridge_online' }, reason: 'bridge_update_required', attempts: 0 }]);
    expect(message(old.error)).toMatch(/^Stopped at step 2 of 2: Update the Browser Bridge: the connected one cannot run 'pick'/);
  });
});

describe('D-335 slice N — a single typing that picks one of the field\'s suggestions', () => {
  const NEW_DEAL = { page: PAGE, url: 'https://example.com/deals/new', title: 'New deal' };
  /** One `core.dom.write`, as Type into a web page calls it. */
  const write = async (input: Record<string, unknown>, answers: Answer[] | Partial<Record<string, Answer>>) => {
    const requests: DispatchRequest[] = [];
    const dispatch = vi.fn<BridgeDispatcher['dispatch']>(async (request) => {
      requests.push(request);
      const answer = Array.isArray(answers) ? answers[Math.min(requests.length - 1, answers.length - 1)] : answers[request.action];
      if (answer === undefined) throw new Error(`no answer for ${request.action}`);
      return typeof answer === 'function' ? answer(request) : answer;
    });
    const adapter = createBridgeDomAdapter({
      manifests: { get: (slug) => KERNEL_MANIFESTS.find((manifest) => manifest.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: vi.fn(() => false) }),
    });
    const manifest = KERNEL_MANIFESTS.find((m) => m.slug === 'dom-write')!;
    const call: ResolvedCall = { slug: 'dom-write', risk_tier: 'write', output: manifest.output,
      input: { target: '*://*/*', page: PAGE, ref: 'e3', value: 'Acme', ...input },
      stepMeta: { recipe_id: 'type-into-web-page', step_id: 'type', run_id: 'run-1' } };
    const settled: { result?: unknown; error?: unknown } = await adapter(call).then((result) => ({ result }), (error: unknown) => ({ error }));
    // Slice T's read of the page afterwards, set apart as in `act`.
    return { ...settled, requests: requests.filter((r) => r.action !== 'reread') };
  };

  it('sends one pick, waiting for the suggestion inside a longer command, and answers what it picked and the page', async () => {
    const { result, requests } = await write({ pick: 'Acme Corp' }, { pick: ok({ filled: true, picked: 'Acme Corp', moved: false, ...NEW_DEAL }) });
    expect(requests.map((r) => [r.action, r.args])).toEqual([
      ['pick', { page: PAGE, ref: 'e3', value: 'Acme', pick: 'Acme Corp', pick_ms: 5_000 }]]);
    expect(requests[0]!.expects_output_keys).toEqual([...BRIDGE_PICK_OUTPUT_KEYS]);
    expect(requests[0]!.timeout_ms).toBe(25_000);
    expect(result).toEqual({ written: 1, fields: ['__core_dom_value'], failed: [], picked: 'Acme Corp', ...NEW_DEAL, ...noObservation() });
  });

  it('an empty pick is plain typing, as before', async () => {
    const { result, requests } = await write({ pick: '' }, { fill: ok({ filled: true }) });
    expect(requests.map((r) => r.action)).toEqual(['fill']);
    expect(result).toEqual({ written: 1, fields: ['__core_dom_value'], failed: [], ...noObservation() });
  });

  it('a suggestion the Bridge could not pick fails the write with its words', async () => {
    const none = 'None of its suggestions is “Acme Corp”. They were: “Acme Inc”; “Acme Ltd”. Pick one of them by its text.';
    const { error } = await write({ pick: 'Acme Corp' }, [failed('value_not_applied', none)]);
    expect(code(error)).toBe('DOM_WRITE_FAILED');
    expect(message(error)).toContain(none);
  });

  it('needs the page it names, picks with no Enter on another element, and never in a reviewed run', async () => {
    const bySelector = await write({ page: undefined, ref: undefined, selector: '#company', pick: 'Acme Corp' }, [ok({})]);
    expect(code(bySelector.error)).toBe('DOM_SELECTOR_MISSING');
    expect(bySelector.requests).toEqual([]);
    const both = await write({ pick: 'Acme Corp', submit_selector: '#save' }, [ok({})]);
    expect(code(both.error)).toBe('DOM_WRITE_FAILED');
    expect(both.requests).toEqual([]);
    const reviewed = await withPreapprovalIo({} as PreapprovalIoContext, () => write({ pick: 'Acme Corp' }, [ok({})]));
    expect(code(reviewed.error)).toBe('ROLE_RESTRICTION');
    expect(message(reviewed.error)).toBe(PICK_NOT_REVIEWABLE_MESSAGE);
    expect(reviewed.requests).toEqual([]);
    // Preparing one says why.
    const manifest = KERNEL_MANIFESTS.find((m) => m.slug === 'dom-write')!;
    expect(() => describeReviewedDom({} as never, { describeDocument: () => null } as never, { slug: 'dom-write', manifest,
      output: manifest.output, input: { target: '*://*/*', page: PAGE, ref: 'e3', value: 'Acme', pick: 'Acme Corp' } } as never))
      .toThrow(PICK_NOT_REVIEWABLE_MESSAGE);
  });
});

describe('D-335 slice X — one batch across tabs, reading as it goes', () => {
  const PY = { page: '11:PY1', url: 'https://en.wikipedia.org/wiki/Python_(programming_language)', title: 'Python' };
  const GO = { page: '12:GO1', url: 'https://en.wikipedia.org/wiki/Go_(programming_language)', title: 'Go' };
  const HN = { page: '13:HN1', url: 'https://news.ycombinator.com/', title: 'Hacker News' };
  const html = (text: string) => `<main><h1>${text}</h1><p>${text} first appeared long ago.</p></main>`;
  const read = (tab: { page: string; url: string; title: string }, text = tab.title) =>
    ok({ ...tab, html: html(text), truncated: false });
  const tabs = (...open: Array<{ page: string; url: string; title: string }>) => ok({ tabs: open, truncated: false });
  type Respond = (request: DispatchRequest) => DispatchOutcome | Promise<DispatchOutcome>;
  const batch = async (input: Record<string, unknown>, respond: Respond,
    stepMeta: Partial<NonNullable<ResolvedCall['stepMeta']>> = {}, admissions?: BrowserBatchAdmissions) => {
    const requests: DispatchRequest[] = [];
    const dispatch = vi.fn<BridgeDispatcher['dispatch']>(async (request) => {
      requests.push(request);
      return respond(request);
    });
    const adapter = createBridgeDomAdapter({
      manifests: { get: (slug) => KERNEL_MANIFESTS.find((manifest) => manifest.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: vi.fn(() => false) }),
      pageReads: createPageReadStore(),
      ...(admissions !== undefined ? { batchAdmissions: admissions } : {}),
    });
    const manifest = KERNEL_MANIFESTS.find((m) => m.slug === 'dom-act')!;
    const call: ResolvedCall = { slug: 'dom-act', risk_tier: 'write', output: manifest.output,
      input: { target: '*://*/*', ...input },
      stepMeta: { recipe_id: 'act-on-web-page', step_id: 'act', run_id: 'run-x', ...stepMeta } };
    const settled: { result?: Record<string, unknown>; error?: unknown } = await adapter(call)
      .then((result) => ({ result: result as Record<string, unknown> }), (error: unknown) => ({ error }));
    return { ...settled, requests };
  };

  it('three tabs by address, read side by side in one call, answered one entry per tab', async () => {
    const RUST = { page: '14:RS1', url: 'https://en.wikipedia.org/wiki/Rust_(programming_language)', title: 'Rust' };
    const started: string[] = [];
    let open = 0;
    let most = 0;
    const { result, requests, error } = await batch({ steps: [
      { url: 'https://en.wikipedia.org/wiki/Python_%28programming_language%29', do: 'read', chars: 2000 },
      { url: RUST.url, do: 'read', chars: 2000 },
      { url: GO.url, do: 'read', chars: 2000 },
    ] }, async (request) => {
      if (request.action === 'list_tabs') return tabs(PY, GO, RUST);
      started.push(String(request.args.page));
      open += 1;
      most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 30));
      open -= 1;
      return read([PY, RUST, GO].find((tab) => tab.page === request.args.page)!);
    });
    expect(error).toBeUndefined();
    // One listing of the tabs, then the three reads at once: the server does not wait for one to start the next.
    expect(requests.map((r) => r.action)).toEqual(['list_tabs', 'inspect', 'inspect', 'inspect']);
    expect(most).toBe(3);
    expect(started).toEqual([PY.page, RUST.page, GO.page]);
    const entries = result!.tabs as Array<Record<string, unknown>>;
    expect(entries.map((tab) => [tab.page, tab.title])).toEqual([[PY.page, 'Python'], [RUST.page, 'Rust'], [GO.page, 'Go']]);
    expect(entries[0]!.steps).toEqual(['1. on en.wikipedia.org/wiki/Python_(programming_language): read the page']);
    const reads = entries.map((tab) => (tab.reads as Array<Record<string, unknown>>)[0]!);
    expect(reads.map((r) => r.step)).toEqual([1, 2, 3]);
    expect(String(reads[1]!.outline)).toContain('Rust first appeared long ago.');
    // A read changes nothing, so nothing is read again for what changed.
    expect(entries.some((tab) => 'changes' in tab)).toBe(false);
    expect(result).toMatchObject({ done: 3, of: 3, page: GO.page, title: 'Go' });
  });

  it('an address no tab shows: a new tab for it, which an approved batch opens', async () => {
    const { result, requests } = await batch({ steps: [{ url: 'https://news.ycombinator.com', do: 'read', chars: 1000 }] },
      (request) => request.action === 'list_tabs' ? tabs(PY) : request.action === 'open_tab' ? ok(HN) : read(HN),
      { preflight_admitted: true });
    expect(requests.map((r) => [r.action, r.args.url ?? r.args.page])).toEqual([
      ['list_tabs', undefined], ['open_tab', 'https://news.ycombinator.com'], ['inspect', HN.page]]);
    expect((result!.tabs as Array<Record<string, unknown>>)[0]).toMatchObject({ page: HN.page, opened: true });
  });

  // The admission this records, "open no tab", was a batch of reads' until 2026-11-23, when opening a page became a read
  // (it now records any tab); the mechanism stands for an admission that lets a batch open none.
  it('a batch whose admission lets it open no tab: one that closed in between stops its step', async () => {
    const admissions = createBrowserBatchAdmissions();
    const steps = [{ url: PY.url, do: 'read' }];
    admissions.record('run-x', { page: undefined, steps }, { open: new Set() });
    const { error, requests } = await batch({ steps }, (request) => request.action === 'list_tabs' ? tabs(GO) : read(GO),
      {}, admissions);
    expect(code(error)).toBe('DOM_PAGE_NOT_MATCHING');
    expect(message(error)).toContain(`Stopped at step 1 of 1: no open tab shows ${PY.url}, and this batch ran without an ask, `
      + 'which opens no tab');
    expect(requests.map((r) => r.action)).toEqual(['list_tabs']);
  });

  it('a batch a pass let through opens a tab on the pass\'s site only', async () => {
    const admissions = createBrowserBatchAdmissions();
    const own = [{ url: 'https://en.wikipedia.org/wiki/Main_Page', do: 'read' }];
    admissions.record('run-x', { page: undefined, steps: own }, { open: new Set(['https://en.wikipedia.org']) });
    const MAIN = { page: '15:MAIN', url: 'https://en.wikipedia.org/wiki/Main_Page', title: 'Wikipedia' };
    const opened = await batch({ steps: own }, (request) => request.action === 'list_tabs' ? tabs()
      : request.action === 'open_tab' ? ok(MAIN) : read(MAIN), {}, admissions);
    expect(opened.error).toBeUndefined();
    const other = [{ url: HN.url, do: 'read' }];
    admissions.record('run-x', { page: undefined, steps: other }, { open: new Set(['https://en.wikipedia.org']) });
    const refused = await batch({ steps: other }, (request) => request.action === 'list_tabs' ? tabs() : ok(HN), {}, admissions);
    expect(code(refused.error)).toBe('DOM_PAGE_NOT_MATCHING');
    expect(refused.requests.map((r) => r.action)).toEqual(['list_tabs']);
  });

  it('D-402 ruling 18 — a batch a pre-approval let through opens a tab at an address it found, within its recipe\'s sites', async () => {
    // A pre-approval stands in for the ask, so the batch has no admission of its own (`browser-batch-admission.ts`).
    const admissions = createBrowserBatchAdmissions();
    const BILL = { page: '16:BILL', url: 'https://en.wikipedia.org/wiki/Invoice', title: 'Invoice' };
    // The address the run found as it went (on a bill, say), as a step's address.
    const { result, requests, error } = await batch({ target: 'https://en.wikipedia.org/*', steps: [{ url: BILL.url, do: 'read' }] },
      (request) => request.action === 'list_tabs' ? tabs() : request.action === 'open_tab' ? ok(BILL) : read(BILL), {}, admissions);
    expect(error).toBeUndefined();
    const open = requests.find((request) => request.action === 'open_tab');
    expect(open?.args.url).toBe(BILL.url);
    // Within the recipe's own sites: its command may reach only the batch's target, which the Bridge opens under.
    expect(open?.ingredient.domain_allowlist).toEqual(['https://en.wikipedia.org/*']);
    expect((result!.tabs as Array<Record<string, unknown>>)[0]).toMatchObject({ page: BILL.page, opened: true });
  });

  it('a read before a click and one after it are two commands, never one answer replayed', async () => {
    const MAIN = { page: '16:MAIN', url: 'https://en.wikipedia.org/wiki/Main_Page', title: 'Wikipedia' };
    let clicked = false;
    const { result, requests } = await batch({ page: MAIN.page, steps: [
      { do: 'read' }, { do: 'click', selector: '#more' }, { do: 'read' },
    ] }, (request) => {
      if (request.action === 'click') {
        clicked = true;
        return ok({ clicked: 1, page: MAIN.page, url: MAIN.url, title: MAIN.title });
      }
      return read(MAIN, clicked ? 'After' : 'Before');
    });
    const reads = requests.filter((r) => r.action === 'inspect');
    expect(reads).toHaveLength(2);
    expect(new Set(reads.map((r) => r.idempotency_key)).size).toBe(2);
    const entry = (result!.tabs as Array<Record<string, unknown>>)[0]!;
    expect((entry.reads as Array<Record<string, unknown>>).map((r) => String(r.outline).includes('After'))).toEqual([false, true]);
    // The final fresh read already answers the changed page; no third read or duplicate body.
    expect(requests.map(r => r.action)).toEqual(['inspect', 'click', 'inspect']);
    expect(entry.changes).toBeUndefined();
  });

  it('a batch\'s reads hold at most 60,000 characters: one past that is named, not sent', async () => {
    const big = (tab: { page: string; url: string; title: string }) =>
      ok({ ...tab, html: `<main>${Array.from({ length: 900 }, (_, i) => `<p>${tab.title} line ${i} ${'x'.repeat(60)}</p>`).join('')}</main>`,
        truncated: false });
    const RUST = { page: '14:RS2', url: 'https://en.wikipedia.org/wiki/Rust_(programming_language)', title: 'Rust' };
    const { result } = await batch({ steps: [
      { page: PY.page, do: 'read', chars: 25_000 }, { page: GO.page, do: 'read', chars: 25_000 }, { page: RUST.page, do: 'read', chars: 25_000 },
    ] }, (request) => big([PY, GO, RUST].find((tab) => tab.page === request.args.page)!));
    const reads = (result!.tabs as Array<Record<string, unknown>>).map((tab) => (tab.reads as Array<Record<string, unknown>>)[0]!);
    expect(reads.slice(0, 2).every((r) => typeof r.outline === 'string')).toBe(true);
    expect(String(reads[2]!.not_read)).toContain('together they hold at most 60000: read this page in a call of its own');
  });

  it('waits for the tab\'s address, asking the browser for it, then reads the page it moved to', async () => {
    const INBOX = { page: '17:INBOX', url: 'https://mail.example.com/inbox', title: 'Inbox' };
    let listed = 0;
    const { result, requests } = await batch({ page: '17:LOGIN', steps: [
      { do: 'wait', url_includes: '/inbox', seconds: 5 }, { do: 'read', chars: 1000 },
    ] }, (request) => {
      if (request.action === 'list_tabs') {
        listed += 1;
        return tabs(listed < 2 ? { page: '17:LOGIN', url: 'https://login.example.com/', title: 'Sign in' } : INBOX);
      }
      return read(INBOX);
    });
    expect(listed).toBe(2);
    // Each poll its own command, so the browser is asked again rather than an answer replayed.
    expect(new Set(requests.filter((r) => r.action === 'list_tabs').map((r) => r.idempotency_key)).size).toBe(2);
    expect(requests.at(-1)!.args.page).toBe(INBOX.page);
    expect((result!.tabs as Array<Record<string, unknown>>)[0]!.steps).toEqual([
      '1. on login.example.com: waited for the address to contain “/inbox”; the tab is now at https://mail.example.com/inbox',
      '2. on mail.example.com/inbox: read the page']);
  });

  it('scrolls, goes to an address, back, reloads, points and closes, each the Bridge\'s own action on the step\'s tab', async () => {
    const NEXT = { page: '18:NEXT', url: 'https://example.com/next', title: 'Next' };
    const START = { page: '18:START', url: 'https://example.com/', title: 'Start' };
    const { result, requests } = await batch({ page: START.page, steps: [
      { do: 'scroll', to: 'bottom' }, { do: 'hover', selector: 'nav li' }, { do: 'go', address: NEXT.url }, { do: 'back' },
      { do: 'reload' }, { do: 'close' },
    ] }, (request) => {
      switch (request.action) {
        case 'scroll': return ok({ ...START, screen: 4, screens: 4 });
        case 'hover': return ok({ hovered: true, ...START });
        case 'navigate': return ok(NEXT);
        case 'go_back': case 'reload_page': return ok(START);
        case 'close_tab': return ok({ closed: true });
        default: return read(START);
      }
    });
    expect(requests.filter((r) => r.action !== 'reread').map((r) => [r.action, r.args])).toEqual([
      ['scroll', { page: START.page, to: 'bottom' }],
      ['hover', { page: START.page, selector: 'nav li' }],
      ['navigate', { page: START.page, url: NEXT.url }],
      ['go_back', { page: NEXT.page }],
      ['reload_page', { page: START.page }],
      ['close_tab', { page: START.page }],
    ]);
    expect(result).toMatchObject({ done: 6, of: 6, steps: ['scrolled the page to the bottom (screen 4 of 4)', 'pointed at “nav li”',
      `went to ${NEXT.url}`, 'went back a page', 'reloaded the page', 'closed the tab'] });
    // A closed tab has no page to answer.
    expect(result).not.toHaveProperty('page');
  });

  it('a step on a tab the batch closed stops there; an older Bridge stops at a step it cannot run, saying to update it', async () => {
    const START = { page: '19:START', url: 'https://example.com/', title: 'Start' };
    const closed = await batch({ page: START.page, steps: [{ do: 'close' }, { do: 'read' }] },
      () => ok({ closed: true }));
    expect(message(closed.error)).toContain('Stopped at step 2 of 2: its tab was closed at step 1.');
    const older = await batch({ page: START.page, steps: [{ do: 'back' }] }, () => ({ kind: 'capacity_gap', reason:
      'bridge_update_required', capacity_gap: { kind: 'unsupported_action', action: 'go_back' } } as unknown as DispatchOutcome));
    expect(message(older.error)).toContain('Stopped at step 1 of 1: Update the Browser Bridge: the connected one cannot run \'go_back\'');
  });

  it('a batch that names no tab and passes no page is refused before anything is sent', async () => {
    const { error, requests } = await batch({ steps: [{ do: 'read' }] }, () => read(PY));
    expect(message(error)).toBe('core.dom.act: pass the page handle, or name the first step\'s tab with "page" or "url"');
    expect(requests).toHaveLength(0);
  });
});

describe('D-335 slice X — the tabs showing one address (core.dom.tabs with address)', () => {
  const list = async (address: unknown) => {
    const adapter = createBridgeDomAdapter({
      manifests: { get: (slug) => KERNEL_MANIFESTS.find((manifest) => manifest.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch: async () => ok({ tabs: [
        { page: '1:A', url: 'https://news.ycombinator.com/', title: 'Hacker News' },
        { page: '2:B', url: 'https://news.ycombinator.com/newest', title: 'New' },
        { page: '3:C', url: 'https://www.example.com/a/', title: 'A' },
      ], truncated: false }), cancel: vi.fn(), canResolve: vi.fn(() => false) }),
    });
    const manifest = KERNEL_MANIFESTS.find((m) => m.slug === 'dom-tabs')!;
    const settled: { result?: unknown; error?: unknown } = await adapter({ slug: 'dom-tabs', risk_tier: 'read',
      output: manifest.output, input: { target: '*://*/*', address },
      stepMeta: { recipe_id: 'open-web-page', step_id: 'found', run_id: 'run-t' } })
      .then((result) => ({ result }), (error: unknown) => ({ error }));
    return settled;
  };

  it('answers only the tabs showing it, an empty address every tab, and refuses one that is no web address', async () => {
    const matched = { page: '1:A', url: 'https://news.ycombinator.com/', title: 'Hacker News' };
    expect((await list('http://news.ycombinator.com')).result).toEqual({ tabs: [matched], matched_tab: matched, truncated: false });
    expect((await list('https://example.com/a')).result).toMatchObject({ tabs: [{ page: '3:C' }] });
    expect((await list('https://example.com/b')).result).toEqual({ tabs: [], truncated: false });
    expect(((await list('')).result as { tabs: unknown[] }).tabs).toHaveLength(3);
    expect(message((await list('mailto:me@example.com')).error)).toBe("core.dom.tabs: 'address' is an http or https address");
  });
});

describe('D-335 slice Y — an element named by its text', () => {
  const SEARCH = { page: '21:S1', url: 'https://en.wikipedia.org/wiki/Main_Page', title: 'Wikipedia' };
  const LOGIN = { page: '21:L1', url: 'https://en.wikipedia.org/w/index.php?title=Special:UserLogin', title: 'Log in' };
  const MAIN_HTML = '<main><form><input ref="e1" id="q" type="search" aria-label="Search Wikipedia">'
    + '<button ref="e2">Search</button></form><p><a ref="e3" href="https://en.wikipedia.org/login">Log in</a></p>'
    + '<div><button ref="e7">Save</button><button ref="e8">Save</button><button ref="e9">Delete</button></div></main>';
  const DIALOG_HTML = MAIN_HTML.replace('</main>', '<div role="dialog" aria-modal="true" aria-label="Delete it?">'
    + '<button ref="e10">Confirm</button></div></main>');
  const LOGIN_HTML = '<main><label for="u">Username</label><input ref="e1" id="u"><button ref="e2">Log in</button></main>';
  type Respond = (request: DispatchRequest) => DispatchOutcome | Promise<DispatchOutcome>;
  const run = async (slug: 'dom-act' | 'dom-click' | 'dom-write', input: Record<string, unknown>, respond: Respond,
    reads = createPageReadStore(), options: { textLookupLoadingMs?: number; itemShownMs?: number } = {}) => {
    const requests: DispatchRequest[] = [];
    const dispatch = vi.fn<BridgeDispatcher['dispatch']>(async (request) => {
      requests.push(request);
      return respond(request);
    });
    const adapter = createBridgeDomAdapter({
      manifests: { get: (slug) => KERNEL_MANIFESTS.find((manifest) => manifest.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: vi.fn(() => false) }),
      pageReads: reads,
      ...options,
    });
    const manifest = KERNEL_MANIFESTS.find((m) => m.slug === slug)!;
    const call: ResolvedCall = { slug, risk_tier: 'write', output: manifest.output, input: { target: '*://*/*', ...input },
      stepMeta: { recipe_id: 'act-on-web-page', step_id: 'act', run_id: 'run-y' } };
    const settled: { result?: Record<string, unknown>; error?: unknown } = await adapter(call)
      .then((result) => ({ result: result as Record<string, unknown> }), (error: unknown) => ({ error }));
    // What the steps sent, without the read for what changed at the end (slice T).
    return { ...settled, requests: requests.filter((r) => r.action !== 'reread'), allRequests: requests };
  };
  const page = (tab: { page: string; url: string; title: string }, html: string, truncated = false) =>
    ok({ ...tab, html, truncated });
  const sent = (requests: DispatchRequest[]) => requests.map((r) => [r.action, r.args.ref ?? null]);

  it('types into and presses in the field its text names, reading the page once before each', async () => {
    const { result, error, requests } = await run('dom-act', { page: SEARCH.page, steps: [
      { do: 'type', text: 'Search Wikipedia', value: 'Ada Lovelace' }, { do: 'press', text: 'search wikipedia', key: 'Enter' },
    ] }, (request) => request.action === 'inspect' ? page(SEARCH, MAIN_HTML)
      : request.action === 'fill' ? ok({ filled: true }) : ok({ pressed: 'Enter', ...SEARCH }));
    expect(error).toBeUndefined();
    // Typing may change the page, so the press finds its field in a read made after it.
    expect(sent(requests)).toEqual([['inspect', null], ['fill', 'e1'], ['inspect', null], ['press', 'e1']]);
    expect(requests[1]!.args).toMatchObject({ page: SEARCH.page, ref: 'e1', value: 'Ada Lovelace' });
    expect(result!.steps).toEqual(['typed into “Search Wikipedia”', 'pressed Enter in “search wikipedia”']);
  });

  it('a young read of the page from before the batch serves its first step; the batch\'s own read serves the next', async () => {
    const reads = createPageReadStore();
    reads.outline(SEARCH.page, { url: SEARCH.url, title: SEARCH.title, html: MAIN_HTML, truncated: false, whole: true });
    const kept = await run('dom-act', { page: SEARCH.page, steps: [{ do: 'click', text: 'Log in' }] },
      () => ok({ clicked: 1, ...SEARCH }), reads);
    expect(sent(kept.requests)).toEqual([['click', 'e3']]);
    // A read step of the batch, then a step by text with nothing between: no second read.
    const own = await run('dom-act', { page: SEARCH.page, steps: [{ do: 'read' }, { do: 'click', text: 'Search', role: 'button' }] },
      (request) => request.action === 'inspect' ? page(SEARCH, MAIN_HTML) : ok({ clicked: 1, ...SEARCH }));
    expect(sent(own.requests)).toEqual([['inspect', null], ['click', 'e2']]);
  });

  // D-347 follow-up (2026-11-08) — a ref from before its tab loaded a new page names the element shown and
  // called as it was: one call pages through by the ref it read.
  const QUOTES = (n: number) => ({ page: `31:Q${String(n)}`, url: `https://quotes.toscrape.com/page/${String(n)}/`,
    title: 'Quotes to Scrape' });
  const quotesHtml = (n: number, next: boolean) => `<main><p>Page ${String(n)} of the quotes.</p>`
    + (next ? `<nav><a ref="e${String(40 + n)}" href="/page/${String(n + 1)}/">Next →</a></nav>` : '') + '</main>';
  const readFirst = () => {
    const reads = createPageReadStore();
    reads.outline(QUOTES(1).page, { url: QUOTES(1).url, title: QUOTES(1).title, html: quotesHtml(1, true), truncated: false, whole: true });
    return reads;
  };
  const numberOf = (page: unknown) => Number(/Q(\d+)$/.exec(String(page))![1]);

  it('a ref from before a page change clicks what is called the same on the new page, so one call pages through', async () => {
    const { result, error, requests } = await run('dom-act', { page: QUOTES(1).page, steps: [
      { do: 'click', ref: 'e41' }, { do: 'read' }, { do: 'click', ref: 'e41' }, { do: 'read' },
    ] }, (request) => {
      const on = numberOf(request.args.page);
      return request.action === 'inspect' ? page(QUOTES(on), quotesHtml(on, true)) : ok({ clicked: true, moved: true, ...QUOTES(on + 1) });
    }, readFirst());
    expect(error).toBeUndefined();
    // Page 2's "Next →" is e42 in its own read: the second click is sent there, on page 2.
    expect(sent(requests)).toEqual([['click', 'e41'], ['inspect', null], ['click', 'e42'], ['inspect', null]]);
    expect(requests[2]!.args.page).toBe(QUOTES(2).page);
    expect(result).toMatchObject({ done: 4, of: 4, page: QUOTES(3).page });
  });

  it('a ref from before a page change that nothing there is called stops, naming what it was called', async () => {
    const { error } = await run('dom-act', { page: QUOTES(1).page, steps: [
      { do: 'click', ref: 'e41' }, { do: 'read' }, { do: 'click', ref: 'e41' },
    ] }, (request) => request.action === 'inspect' ? page(QUOTES(2), quotesHtml(2, false)) : ok({ clicked: true, moved: true, ...QUOTES(2) }),
    readFirst());
    expect(code(error)).toBe('DOM_SELECTOR_NOT_FOUND');
    expect(message(error)).toMatch(new RegExp('^Stopped at step 3 of 3: it names e41, “Next →” on the page before step 1 loaded a new '
      + 'one, and here nothing a person can act on is called “Next →” \\(link\\) on the page'));
  });

  // Many sites show the pager above the list and below it: page n's two are e<n>0 and e<n>1, and more after.
  const pagedHtml = (n: number, next: (ref: string) => string, count = 2) => `<main>${next(`e${String(10 * n)}`)}`
    + `<p>Page ${String(n)} of the quotes.</p>${Array.from({ length: count - 1 }, (_, i) => next(`e${String(10 * n + 1 + i)}`)).join('')}</main>`;
  const nextLink = (n: number) => (ref: string) => `<nav><a ref="${ref}" href="/page/${String(n + 1)}/">Next →</a></nav>`;
  const nextButton = (ref: string) => `<nav><button ref="${ref}">Next</button></nav>`;
  const paged = (steps: unknown[], html: (n: number) => string) => {
    const reads = createPageReadStore();
    reads.outline(QUOTES(1).page, { url: QUOTES(1).url, title: QUOTES(1).title, html: html(1), truncated: false, whole: true });
    return run('dom-act', { page: QUOTES(1).page, steps }, (request) => {
      const on = numberOf(request.args.page);
      return request.action === 'inspect' ? page(QUOTES(on), html(on)) : ok({ clicked: true, moved: true, ...QUOTES(on + 1) });
    }, reads);
  };
  const clicks = (requests: DispatchRequest[]) => sent(requests).filter(([action]) => action === 'click').map(([, ref]) => ref);

  it('a pager above the list and below it: a ref from before a page change takes the one in its place there', async () => {
    const { result, error, requests } = await paged([{ do: 'click', ref: 'e11' }, { do: 'read' }, { do: 'click', ref: 'e11' },
      { do: 'read' }], (n) => pagedHtml(n, nextButton));
    expect(error).toBeUndefined();
    // The lower "Next" of page 1, so the lower one of page 2.
    expect(sent(requests)).toEqual([['click', 'e11'], ['inspect', null], ['click', 'e21'], ['inspect', null]]);
    expect(result).toMatchObject({ done: 4, of: 4, page: QUOTES(3).page });
  });

  it('links to one address are one: a text naming them takes the first, as does a ref whose place there is not', async () => {
    // Page 1 shows two "Next →" to page 2; page 2 three, all to page 3. "Next" is a word of their name, as
    // the steps help writes it.
    const html = (n: number) => pagedHtml(n, nextLink(n), n === 1 ? 2 : 3);
    const byText = await paged([{ do: 'click', text: 'Next' }, { do: 'read' }, { do: 'click', text: 'Next →' }], html);
    expect(byText.error).toBeUndefined();
    expect(clicks(byText.requests)).toEqual(['e10', 'e20']);
    const byRef = await paged([{ do: 'click', ref: 'e11' }, { do: 'read' }, { do: 'click', ref: 'e11' }], html);
    expect(byRef.error).toBeUndefined();
    expect(clicks(byRef.requests)).toEqual(['e11', 'e20']);
  });

  it('buttons called the same, as many on the new page as there were not, stop the step, naming them', async () => {
    const { error, requests } = await paged([{ do: 'click', ref: 'e11' }, { do: 'read' }, { do: 'click', ref: 'e11' }],
      (n) => pagedHtml(n, nextButton, n === 1 ? 2 : 3));
    expect(code(error)).toBe('DOM_SELECTOR_NOT_FOUND');
    expect(message(error)).toMatch(new RegExp('^Stopped at step 3 of 3: it names e11, “Next” on the page before step 1 loaded a new '
      + 'one, and here “Next” \\(button\\) names 3 elements on the page: the button “Next” \\(e20\\), the button “Next” \\(e21\\), '
      + 'the button “Next” \\(e22\\)'));
    expect(clicks(requests)).toEqual(['e11']);
  });

  // D-347 follow-up (2026-11-08) — F's runs: a form sent and the page it led to read in one call. The call's
  // closing read answered that page again as new, numbering its one line b2, so the b1 its read had shown
  // was refused, and the page's first lines came a second time.
  const FORM = { page: '33:F1', url: 'https://httpbin.org/forms/post', title: '' };
  const SENT = { page: '33:F2', url: 'https://httpbin.org/post', title: '' };
  const sentHtml = (more = '') => '<main><pre>{ "form": { "custname": "Ada Test", "size": "large", "topping": [ "bacon", '
    + `"mushroom" ] }, "headers": { "Accept": "text/html,application/xhtml+xml" } }</pre>${more}</main>`;
  const sendAndRead = async (atTheEnd: string, reads = createPageReadStore(), later: unknown[] = []) => {
    const { result, error, allRequests } = await run('dom-act', { page: FORM.page,
      steps: [{ do: 'click', ref: 'e13' }, { do: 'read' }, ...later] },
      (request) => request.action === 'click' ? ok({ clicked: 1, moved: true, ...SENT })
        : page(SENT, request.action === 'reread' ? atTheEnd : sentHtml()), reads);
    expect(error).toBeUndefined();
    expect(allRequests.filter(r => r.action === 'reread')).toHaveLength(later.length ? 1 : 0);
    return (result!.tabs as Array<Record<string, unknown>>)[0]!;
  };

  it('reuses a final fresh whole-page read after navigation and preserves its block numbers', async () => {
    const reads = createPageReadStore();
    const tab = await sendAndRead(sentHtml(), reads);
    expect(String((tab.reads as Array<Record<string, unknown>>)[0]!.outline)).toContain('(b1)');
    expect(tab.changes).toBeUndefined();
    expect(reads.block(SENT.page, 'b1')).toMatchObject({ text: expect.stringContaining('"bacon", "mushroom"') });
  });

  it('still rereads after cached search/continuation reads or a loading snapshot', async () => {
    for (const tail of [{ find: 'form' }, { from: 1 }, { loading: true }]) {
      const { error, allRequests } = await run('dom-act', { page: FORM.page, steps: [
        { do: 'click', ref: 'e13' }, { do: 'read', ...('loading' in tail ? {} : tail) },
      ] }, request => request.action === 'click' ? ok({ clicked: 1, moved: true, ...SENT })
        : ok({ ...SENT, html: sentHtml(), truncated: false, ...('loading' in tail ? tail : {}) }));
      expect(error).toBeUndefined();
      expect(allRequests.filter(r => r.action === 'reread')).toHaveLength(1);
    }
  });

  // D-347 follow-up 17 (2026-11-08) — a step refused because the page drew something else into the element its
  // ref names since it was read: the call stops there, and what changed on the page, read again, comes with it.
  it('a step whose element the page drew something else into stops the call with what changed, read again', async () => {
    const LIST = { page: '34:L1', url: 'https://example.com/people', title: 'People' };
    const listHtml = (second: string) => `<main><ul><li>Ada <button ref="e1">Delete</button></li><li>${second} `
      + '<button ref="e2">Delete</button></li></ul></main>';
    const reads = createPageReadStore();
    reads.outline(LIST.page, { url: LIST.url, title: LIST.title, html: listHtml('Bob'), truncated: false, whole: true });
    const refusal = bridgeElementChangedMessage('e2', '“Delete” in “Dee Delete”', '“Delete” in “Bob Delete”');
    const { error, requests } = await run('dom-act', { page: LIST.page, steps: [{ do: 'click', ref: 'e2' }] },
      (request) => request.action === 'click' ? failed('selector_not_found', refusal) : page(LIST, listHtml('Dee')), reads);
    expect(code(error)).toBe('DOM_SELECTOR_NOT_FOUND');
    expect(message(error)!.startsWith(`Stopped at step 1 of 1: ${refusal.replace(/\.$/, '')}. No step was confirmed complete.`)).toBe(true);
    const observed = readBrowserFailure(error)?.details.post_action;
    expect(observed).toMatchObject({ action_status: 'refused', view_status: 'fresh' });
    expect(observed?.view?.outline).toMatch(/Dee \[button: Delete\]\(e2\)/);
    expect(sent(requests)).toEqual([['click', 'e2']]);
  });

  it('an action after the last read still gets a closing reread with the later changes', async () => {
    const tab = await sendAndRead(sentHtml('<p>Order received.</p>'), createPageReadStore(), [{ do: 'click', selector: '#more' }]);
    expect(tab.post_action).toMatchObject({ view_status: 'fresh', view: { outline: expect.stringContaining('Order received.') } });
  });

  it('after a click opens a dialog, the next step finds its button in the page read again', async () => {
    let opened = false;
    const { error, requests } = await run('dom-act', { page: SEARCH.page, steps: [
      { do: 'click', text: 'Delete' }, { do: 'click', text: 'Confirm' },
    ] }, (request) => {
      if (request.action === 'inspect') return page(SEARCH, opened ? DIALOG_HTML : MAIN_HTML);
      opened = true;
      return ok({ clicked: 1, ...SEARCH });
    });
    expect(error).toBeUndefined();
    expect(sent(requests)).toEqual([['inspect', null], ['click', 'e9'], ['inspect', null], ['click', 'e10']]);
  });

  it('after a step loads a new form page, the pending field step stops before typing there', async () => {
    const { error, requests, result } = await run('dom-act', { page: SEARCH.page, steps: [
      { do: 'click', text: 'Log in', role: 'link' }, { do: 'type', text: 'Username', value: 'ada' },
    ] }, (request) => {
      if (request.action === 'inspect') return request.args.page === LOGIN.page ? page(LOGIN, LOGIN_HTML) : page(SEARCH, MAIN_HTML);
      return request.action === 'click' ? ok({ clicked: 1, ...LOGIN }) : ok({ filled: true });
    });
    expect(readBrowserFailure(error)?.details.navigation_boundary).toMatchObject({ kind: 'unobserved_form_document', page: LOGIN.page, pending_step: 2 });
    expect(requests.filter(request => ['fill', 'submit'].includes(request.action))).toEqual([]);
    expect(requests.filter(request => request.action === 'click')).toHaveLength(1);
    expect(result).toBeUndefined();
  });

  it('a text several elements share, or none has, stops the step before anything is sent, naming them', async () => {
    const several = await run('dom-act', { page: SEARCH.page, steps: [{ do: 'click', text: 'Save' }] },
      () => page(SEARCH, MAIN_HTML));
    expect(code(several.error)).toBe('DOM_SELECTOR_NOT_FOUND');
    expect(message(several.error)).toContain('Stopped at step 1 of 1: “Save” names 2 elements on the page: the button “Save” (e7), '
      + 'the button “Save” (e8); name one by its ref, or add its role');
    expect(sent(several.requests)).toEqual([['inspect', null]]);
    const none = await run('dom-act', { page: SEARCH.page, steps: [{ do: 'click', text: 'Sign up', role: 'link' }] },
      () => page(SEARCH, MAIN_HTML));
    expect(message(none.error)).toContain('Stopped at step 1 of 1: nothing a person can act on is called “Sign up” (link) on the page');
    // A read the Bridge cut short says so: what is further down was never seen.
    const cut = await run('dom-act', { page: SEARCH.page, steps: [{ do: 'click', text: 'Next page' }] },
      () => page(SEARCH, MAIN_HTML, true));
    expect(message(cut.error)).toContain('nothing a person can act on is called “Next page” on the page as far as it was read '
      + '(it is long, and the read stopped before its end)');
  });

  it('Click a web element and Type into a web page by text: the page read, then the op by the ref', async () => {
    const clicked = await run('dom-click', { page: SEARCH.page, text: 'Log in' },
      (request) => request.action === 'inspect' ? page(SEARCH, MAIN_HTML) : ok({ clicked: 1, ...LOGIN }));
    expect(clicked.error).toBeUndefined();
    expect(sent(clicked.requests)).toEqual([['inspect', null], ['click', 'e3']]);
    expect(clicked.requests[1]!.args).not.toHaveProperty('text');
    const typed = await run('dom-write', { page: SEARCH.page, text: 'Search Wikipedia', role: 'field', value: 'Ada' },
      (request) => request.action === 'inspect' ? page(SEARCH, MAIN_HTML) : ok({ filled: true }));
    expect(typed.error).toBeUndefined();
    expect(sent(typed.requests)).toEqual([['inspect', null], ['fill', 'e1']]);
    // Text names an element on a page by handle, in place of a ref or a selector.
    const both = await run('dom-click', { page: SEARCH.page, text: 'Log in', ref: 'e3' }, () => page(SEARCH, MAIN_HTML));
    expect(message(both.error)).toBe("core.dom.click: 'text' names the element on the page its 'page' handle names, in place of a ref or a selector");
    expect(both.requests).toHaveLength(0);
  });

  // 2026-11-20 — the page still loading when a step names an element by its text and nothing read the page
  // before: a recipe's first step on the page it opens. A Bridge with `dom_readiness` answers a read before
  // `readyState` is complete, which ads or trackers can hold off for 7 to 12 s; the lookup refused at once,
  // saying the page "is long" (D-402's benchmark tasks C, L, N and P, all four).
  // 2026-11-21 (D-402, task P) — an app draws its list after it answers (P's notes, after a sign-in or a save).
  describe('a step named inside its card, when no card shows its texts yet', () => {
    const NOTE = (title: string) => '<div class="col"><div data-testid="note-card" class="card"><div class="card-header">'
      + `${title}</div><div class="card-footer"><button ref="e${title === 'Bench stock review' ? '7' : '8'}">Edit</button></div></div></div>`;
    const NOTES = (...titles: string[]) => ok({ ...SEARCH, html: `<main><div class="row">${titles.map(NOTE).join('')}</div></main>`, truncated: false });
    const EDIT = { page: SEARCH.page, steps: [{ do: 'click', text: 'Edit', role: 'button',
      within: { text: ['Bench stock review'], card: 'div[data-testid="note-card"]' } }] };

    it('reads again until one does, then acts in it, with the card for the Bridge to check', async () => {
      let reads = 0;
      const { error, requests } = await run('dom-act', EDIT, (request) => request.action !== 'inspect' ? ok({ clicked: 1, ...SEARCH })
        : ++reads < 3 ? NOTES('Grocery list') : NOTES('Grocery list', 'Bench stock review'));
      expect(error).toBeUndefined();
      expect(sent(requests)).toEqual([['inspect', null], ['inspect', null], ['inspect', null], ['click', 'e7']]);
      expect(requests.find((request) => request.action === 'click')?.args).toMatchObject({ within: ['Bench stock review'],
        within_card: 'div[data-testid="note-card"]' });
    });

    it('none showing once the time is up is refused, and nothing is clicked', async () => {
      const { error, requests } = await run('dom-act', EDIT, (request) => request.action !== 'inspect' ? ok({ clicked: 1, ...SEARCH })
        : NOTES('Grocery list'), createPageReadStore(), { itemShownMs: 1_200 });
      expect(code(error)).toBe('DOM_SELECTOR_NOT_FOUND');
      expect(message(error)).toContain('no card on the page shows “Bench stock review”');
      expect(requests.filter((request) => request.action === 'inspect').length).toBeGreaterThan(2);
      expect(requests.filter((request) => request.action !== 'inspect')).toEqual([]);
    });
  });

  describe('a page still loading when its element is named by its text', () => {
    const CLICK_SEARCH = { page: SEARCH.page, steps: [{ do: 'click', text: 'Search', role: 'button' }] };
    const loading = (html: string, settled = true) => ok({ ...SEARCH, html, truncated: false, loading: true, settled });

    it('acts once two reads of the same still-loading document show the same element, never on one', async () => {
      const { error, requests } = await run('dom-act', CLICK_SEARCH,
        (request) => request.action === 'inspect' ? loading(MAIN_HTML) : ok({ clicked: 1, ...SEARCH }));
      expect(error).toBeUndefined();
      expect(sent(requests)).toEqual([['inspect', null], ['inspect', null], ['click', 'e2']]);
      // The single-op tools look elements up the same way.
      const clicked = await run('dom-click', { page: SEARCH.page, text: 'Log in' },
        (request) => request.action === 'inspect' ? loading(MAIN_HTML) : ok({ clicked: 1, ...LOGIN }));
      expect(clicked.error).toBeUndefined();
      expect(sent(clicked.requests)).toEqual([['inspect', null], ['inspect', null], ['click', 'e3']]);
    });

    it('a page that finishes loading answers from its loaded read', async () => {
      let reads = 0;
      const { error, requests } = await run('dom-act', CLICK_SEARCH, (request) => request.action !== 'inspect'
        ? ok({ clicked: 1, ...SEARCH }) : ++reads === 1 ? loading(MAIN_HTML) : page(SEARCH, MAIN_HTML));
      expect(error).toBeUndefined();
      expect(sent(requests)).toEqual([['inspect', null], ['inspect', null], ['click', 'e2']]);
    });

    it('a later read that had not held still is not enough: it reads on, and acts on one that had', async () => {
      let reads = 0;
      const { error, requests } = await run('dom-act', CLICK_SEARCH, (request) => request.action !== 'inspect'
        ? ok({ clicked: 1, ...SEARCH }) : loading(MAIN_HTML, ++reads !== 2));
      expect(error).toBeUndefined();
      expect(sent(requests)).toEqual([['inspect', null], ['inspect', null], ['inspect', null], ['click', 'e2']]);
    });

    it('never acts on an element that changes between reads of a loading page, and says so', async () => {
      let reads = 0;
      // Each read numbers the button anew, as a page that keeps drawing above it does.
      const { error, requests } = await run('dom-act', CLICK_SEARCH, (request) => request.action !== 'inspect'
        ? ok({ clicked: 1, ...SEARCH }) : loading(MAIN_HTML.replace('ref="e2">Search', `ref="e${String(20 + ++reads)}">Search`)),
      createPageReadStore(), { textLookupLoadingMs: 1_200 });
      expect(code(error)).toBe('DOM_SELECTOR_NOT_FOUND');
      expect(message(error)).toContain('“Search” (button) did not hold still while the page loaded: it changed between reads '
        + 'for the 1.2 s Recued looked, so nothing was sent to it');
      expect(requests.filter((request) => request.action !== 'inspect')).toEqual([]);
    });

    it('a loading page that never shows the element is refused once the time is up, saying it was loading', async () => {
      const { error, requests } = await run('dom-act', CLICK_SEARCH, (request) => request.action !== 'inspect'
        ? ok({ clicked: 1, ...SEARCH }) : loading(LOGIN_HTML), createPageReadStore(), { textLookupLoadingMs: 1_200 });
      expect(code(error)).toBe('DOM_SELECTOR_NOT_FOUND');
      expect(message(error)).toContain('nothing a person can act on is called “Search” (button) on the page as it loaded '
        + '(Recued read it for 1.2 s, and it was still loading)');
      expect(message(error)).not.toContain('it is long');
      expect(requests.filter((request) => request.action !== 'inspect')).toEqual([]);
    });
  });
});

describe('D-335 slice Z — a step that types a secret the model never holds', () => {
  const LOGIN = { page: '31:L1', url: 'https://mail.google.com/signin', title: 'Sign in' };
  const INBOX = { page: '31:I1', url: 'https://mail.google.com/mail/u/0/#inbox', title: 'Inbox' };
  const PASSWORD_PAGE = '<main><form><input ref="e3" name="email" type="email" aria-label="Email">'
    + '<input ref="e5" name="passwd" type="password" aria-label="Password"><button ref="e6">Next</button></form></main>';
  type Respond = (request: DispatchRequest) => DispatchOutcome;
  /** D-402 slice H5 — the paired browsers routing knows, for the browser a secret is typed in. */
  type Roster = ReturnType<NonNullable<BridgeDispatcher['listBrowsers']>>;
  const run = async (steps: unknown[], respond: Respond, source: BrowserSecretSource, run_id = 'run-z',
    at: { page?: string; bridge_id?: string; roster?: Roster } = {}) => {
    const requests: DispatchRequest[] = [];
    const flows = createBrowserFlowRecorder({ now: () => 50 });
    flows.bindRun(run_id, { session_id: 's1', turn_id: 't1' });
    const adapter = createBridgeDomAdapter({
      manifests: { get: (slug) => KERNEL_MANIFESTS.find((manifest) => manifest.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch: vi.fn<BridgeDispatcher['dispatch']>(async (request) => {
        requests.push(request);
        return respond(request);
      }), cancel: vi.fn(), canResolve: vi.fn(() => false), ...(at.roster !== undefined ? { listBrowsers: () => at.roster! } : {}) }),
      pageReads: createPageReadStore(),
      browserFlows: flows,
      secrets: source,
    });
    const manifest = KERNEL_MANIFESTS.find((m) => m.slug === 'dom-act')!;
    const call: ResolvedCall = { slug: 'dom-act', risk_tier: 'write', output: manifest.output,
      input: { target: '*://*/*', page: at.page ?? LOGIN.page, steps, ...(at.bridge_id !== undefined ? { bridge_id: at.bridge_id } : {}) },
      stepMeta: { recipe_id: 'act-on-web-page', step_id: 'act', run_id } };
    const settled: { result?: Record<string, unknown>; error?: unknown } = await adapter(call)
      .then((result) => ({ result: result as Record<string, unknown> }), (error: unknown) => ({ error }));
    return { ...settled, requests: requests.filter((r) => r.action !== 'reread'), flows: flows.stepsFor('s1', () => true) };
  };
  const bridge = (url = LOGIN.url): Respond => (request) => {
    if (request.action === 'describe') return ok({ ...LOGIN, url, role: 'password field', label: 'Password', protected: true });
    if (request.action === 'inspect') return ok({ ...LOGIN, html: PASSWORD_PAGE, truncated: false });
    return ok({ filled: true, submitted: true, ...INBOX, acted_on: { url: LOGIN.url, title: LOGIN.title, role: 'password field',
      label: 'Password', protected: false, selector: '#passwd' } });
  };
  const source = (answer: Awaited<ReturnType<BrowserSecretSource['resolve']>>) => {
    const asked: BrowserSecretRequest[] = [];
    return { asked, source: { resolve: vi.fn(async (request: BrowserSecretRequest) => { asked.push(request); return answer; }) } };
  };

  it('D-402 slice H5 — asks for the secret of the browser it is typed in, by its lasting id and its owner\'s name', async () => {
    const roster: Roster = [{ bridge_id: 'tok-work', browser_id: 'inst-work', name: 'Work', online: true },
      { bridge_id: 'tok-home', browser_id: 'inst-home', name: 'Home', online: true }];
    // A page whose handle names its pairing (as every page the Bridge answered for does).
    const byHandle = source({ value: 'hunter2', from: 'saved' });
    await run([{ do: 'type', ref: 'e5', secret: 'password', submit: true }], bridge(), byHandle.source, 'run-z',
      { page: `bridge:tok-work:${LOGIN.page}`, roster });
    expect(byHandle.asked).toEqual([expect.objectContaining({ browser: 'inst-work', browser_name: 'Work' })]);
    // A draft's step, naming its browser by its setting: the lasting id.
    const bySetting = source({ value: 'hunter2', from: 'saved' });
    await run([{ do: 'type', ref: 'e5', secret: 'password', submit: true }], bridge(), bySetting.source, 'run-z',
      { bridge_id: 'inst-home', roster });
    expect(bySetting.asked).toEqual([expect.objectContaining({ browser: 'inst-home', browser_name: 'Home' })]);
    // No browser to name (no handle, no setting): none, so nothing is read or kept for it.
    const unnamed = source({ value: 'hunter2', from: 'owner' });
    await run([{ do: 'type', ref: 'e5', secret: 'password', submit: true }], bridge(), unnamed.source);
    expect(unnamed.asked[0]).not.toHaveProperty('browser');
  });

  it('finds the field\'s site and name first, types what the source gives in that one command, and says only what it was', async () => {
    const saved = source({ value: 'hunter2', from: 'saved' });
    const { result, error, requests, flows } = await run([{ do: 'type', ref: 'e5', secret: 'password', submit: true }], bridge(), saved.source);
    expect(error).toBeUndefined();
    // The field described on its own document, a read for its name, then the typing and the send.
    expect(requests.map((r) => r.action)).toEqual(['describe', 'inspect', 'submit']);
    expect(requests[0]!.args).toEqual({ page: LOGIN.page, ref: 'e5' });
    expect(saved.asked).toEqual([expect.objectContaining({ run_id: 'run-z', kind: 'password', origin: 'https://mail.google.com',
      field: 'name:passwd', label: 'Password' })]);
    expect(requests[2]!.args).toMatchObject({ page: LOGIN.page, ref: 'e5', value: 'hunter2' });
    expect(result!.steps).toEqual(['typed your saved password for mail.google.com into e5 and sent its form']);
    expect(JSON.stringify(result)).not.toContain('hunter2');
    // Recorded for the owner's flows as a secret, whatever the field looked like to the Bridge.
    expect(flows).toEqual([expect.objectContaining({ do: 'submit', secret: true })]);
    expect(JSON.stringify(flows)).not.toContain('hunter2');
  });

  it('the command\'s key is made without the secret: another secret, the same key', async () => {
    const keyFor = async (value: string) => (await run([{ do: 'type', ref: 'e5', secret: 'password', submit: true }], bridge(),
      source({ value, from: 'owner' }).source)).requests.find((r) => r.action === 'submit')!.idempotency_key;
    expect(await keyFor('hunter2')).toBe(await keyFor('correct horse battery staple'));
  });

  it('no secret given stops the step before anything is typed; nor is one typed on a page that is no web site', async () => {
    const refused = await run([{ do: 'type', ref: 'e5', secret: 'password', submit: true }], bridge(),
      source({ refused: 'nobody gave your password for mail.google.com within 5 minutes, so the task stopped at this step' }).source);
    expect(message(refused.error)).toContain('Stopped at step 1 of 1: nobody gave your password for mail.google.com within 5 minutes, '
      + 'so the task stopped at this step. No step was confirmed complete.');
    expect(refused.requests.map((r) => r.action)).toEqual(['describe', 'inspect']);
    const local = source({ value: 'hunter2', from: 'saved' });
    const file = await run([{ do: 'type', ref: 'e5', secret: 'password' }], bridge('file:///Users/me/login.html'), local.source);
    expect(message(file.error)).toContain('Stopped at step 1 of 1: a password is typed on a web site only, and this field is on '
      + 'file:///Users/me/login.html');
    expect(local.asked).toHaveLength(0);
  });
});

// D-347 follow-up (2026-11-08) — a wait written with page_changes after a click is that click's check
// (`parseBrowserActSteps`): the Bridge watches the click for the page to move on, and no wait is sent.
describe('a wait written with page_changes, run as the check of the click before it', () => {
  const steps = [{ do: 'click', ref: 'e9' }, { do: 'wait', page_changes: true }];

  it('watches the click for the page to move on, and sends no wait', async () => {
    const run = await act(steps, { click: ok({ clicked: true, moved: true, ...HOME }) });
    expect(run.result).toMatchObject({ done: 1, of: 1, ...HOME });
    expect(run.requests.map((r) => [r.action, r.args])).toEqual([['click', { page: PAGE, ref: 'e9', watch_ms: 5_000 }]]);
  });

  it('stops when the page stays, as the check written on the click does', async () => {
    const stayed = await act(steps, { click: ok({ clicked: true, moved: false, page: PAGE, url: LOGIN_URL, title: 'Sign in' }) });
    expect(message(stayed.error)).toMatch(/^Stopped at step 1 of 1: within 5 seconds the page did not move on, and the step expected it to\./);
  });
});

// 2026-11-21 (D-402, benchmark task M, live) — a recipe names its browser by its lasting id (its `browser` setting) and a
// step's page by the handle a step before it gave, which names the same browser by its current token. One browser, so one
// batch: the pairing roster says which ids are the same browser. Before, the batch was refused as two.
describe('one batch, one browser, named by its lasting id and by a page handle', () => {
  const roster = [{ bridge_id: 'token-1', browser_id: 'lasting-1', name: 'Chrome', online: true },
    { bridge_id: 'token-2', browser_id: 'lasting-2', name: 'Laptop', online: true }];
  const run = async (bridge_id: string, page: string, listBrowsers?: () => typeof roster) => {
    const requests: DispatchRequest[] = [];
    const dispatch = vi.fn<BridgeDispatcher['dispatch']>(async (request) => {
      requests.push(request);
      return request.action === 'reread' ? ok(noObservation()) : ok({ clicked: true, moved: true, ...HOME });
    });
    const adapter = createBridgeDomAdapter({
      manifests: { get: (slug) => KERNEL_MANIFESTS.find((manifest) => manifest.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: vi.fn(() => false), ...(listBrowsers ? { listBrowsers } : {}) }),
    });
    const manifest = KERNEL_MANIFESTS.find((m) => m.slug === 'dom-act')!;
    const call: ResolvedCall = { slug: 'dom-act', risk_tier: 'write', output: manifest.output,
      input: { target: '*://*/*', bridge_id, steps: [{ do: 'click', page, ref: 'e9', success_when: { url_includes: '/home' } }] },
      stepMeta: { recipe_id: 'browser-plan-example', step_id: 'act_2', run_id: 'run-1' } };
    return adapter(call).then((result) => ({ result, requests }), (error: unknown) => ({ error, requests }));
  };

  it('runs a step on a page of the browser the setting names', async () => {
    const same = await run('lasting-1', 'bridge:token-1:7:DOC1', () => roster);
    expect('error' in same ? message(same.error) : undefined).toBeUndefined();
    expect(same.requests.filter((r) => r.action === 'click')).toHaveLength(1);
  });

  it('refuses a page of another browser, and with no roster one it cannot tell is the same', async () => {
    for (const refused of [await run('lasting-1', 'bridge:token-2:7:DOC1', () => roster), await run('lasting-1', 'bridge:token-1:7:DOC1')]) {
      expect('error' in refused ? code(refused.error) : undefined).toBe('DOM_PAGE_NOT_MATCHING');
      expect(refused.requests).toHaveLength(0);
    }
  });
});

// 2026-11-21 (D-402, benchmark task H, live) — one wait or check may take 30 s. A click or a sent form watched longer than a
// Bridge before 0.0.14 watches (10 s) needs one that can (`long_waits`), and a command long enough to hold the watch.
describe('a check watched longer than 10 seconds after a click', () => {
  const long = [{ do: 'click', ref: 'e9', success_when: { url_includes: '/home', seconds: 20 } }];
  it('is sent to a Bridge that can, in a command long enough for the click, the watch and the answer', async () => {
    const run = await act(long, { click: ok({ clicked: true, moved: true, ...HOME }) });
    expect(run.result).toMatchObject({ done: 1 });
    expect(run.requests[0]!.args).toEqual({ page: PAGE, ref: 'e9', watch_ms: 20_000 });
    expect(run.requests[0]!.timeout_ms).toBe(40_000);
    // A watch a Bridge has always held goes in the usual command.
    const usual = await act([{ do: 'click', ref: 'e9', success_when: { url_includes: '/home', seconds: 8 } }], { click: ok({ clicked: true, moved: true, ...HOME }) });
    expect(usual.requests[0]!.timeout_ms).toBeUndefined();
  });

  it.each([
    { unsupported: long, refused: 'Update the Browser Bridge: step 2 checks for longer than 10 seconds after it acts, which the connected '
      + 'Browser Bridge cannot watch (0.0.14 or later can). Nothing was done.' },
    { unsupported: [{ do: 'click', ref: 'e9', count: 2 }],
      refused: 'Update the Browser Bridge to double-click at step 2. Nothing was done.' },
    { unsupported: [{ do: 'type', ref: 'e9', value: 'a\tb', delivery: 'paste' }],
      refused: 'Update the Browser Bridge to paste text at step 2. Nothing was done.' },
  ])('refuses a batch with an unsupported second step before any write ($refused)', async ({ unsupported, refused }) => {
    const requests: DispatchRequest[] = [];
    const older = { software_version: '0.0.13', chrome_version: '140', permissions_granted: ['tabs', 'scripting'], granted_origins: ['*://*/*'],
      offscreen_supported: true, alarms_supported: true, supported_actions: ['click', 'fill', 'describe', 'inspect', 'reread'] } as unknown as BridgeCapabilityProfile;
    const adapter = createBridgeDomAdapter({
      manifests: { get: (slug) => KERNEL_MANIFESTS.find((manifest) => manifest.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch: vi.fn(async (request: DispatchRequest) => { requests.push(request); return ok({ clicked: true, moved: true, ...HOME }); }),
        cancel: vi.fn(), canResolve: vi.fn(() => false),
        runs: (request: Pick<DispatchRequest, 'action' | 'args'>) => bridgeRunsCommand(older, request.action, request.args) }),
    });
    const manifest = KERNEL_MANIFESTS.find((m) => m.slug === 'dom-act')!;
    const error = await adapter({ slug: 'dom-act', risk_tier: 'write', output: manifest.output,
      input: { target: '*://*/*', page: PAGE, steps: [{ do: 'click', ref: 'e1' }, ...unsupported] },
      stepMeta: { recipe_id: 'act-on-web-page', step_id: 'act', run_id: 'run-1' } }).then(() => undefined, (failure: unknown) => failure);
    expect(code(error)).toBe('ROLE_RESTRICTION');
    expect(message(error)).toBe(refused);
    expect(requests).toHaveLength(0);
  });
});
