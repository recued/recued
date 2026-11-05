/** D-335 slice J — a sequence of steps on one page (`core.dom.act`), as the DOM adapter runs it once
 *  approved: each step through the Bridge's own action, Recued's checks after each (a CAPTCHA
 *  stops it, a sent form must move the page on), a step's own `expect`, and a stop that says how
 *  far it got and where the tab is. The Bridge here is a stub answering by action; what the
 *  Bridge does in real Chrome is pinned by `browser-toolkit-browser.test.ts`. The hold and its
 *  ask are pinned by `held-browser-target.test.ts`. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_FILL_OUTPUT_KEYS,
  BRIDGE_PICK_OUTPUT_KEYS,
  BRIDGE_SUBMIT_OUTPUT_KEYS,
  BRIDGE_WAIT_OUTPUT_KEYS,
  type BridgeResult,
} from '@recued/contracts';
import type { ResolvedCall } from '@recued/ingredients';

import type { BridgeDispatcher, DispatchOutcome, DispatchRequest } from '../bridges/dispatcher.js';
import { createBridgeDomAdapter, describeBridgeDomCall, PICK_NOT_REVIEWABLE_MESSAGE } from '../bridges/dom-adapter.js';
import { describeReviewedDom } from '../preapproval-dom.js';
import { withRunAbortContext } from '../execution/run-abort-context.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { withPreapprovalIo, type PreapprovalIoContext } from '../preapproval-io-context.js';

afterEach(() => { vi.useRealTimers(); });

const PAGE = '7:DOC1';
const LOGIN_URL = 'https://example.com/login';
const HOME = { page: '7:DOC2', url: 'https://example.com/home', title: 'Home' };

const ok = (outputs: Record<string, unknown>): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'bridge-1',
  attempts: 1, result: { command_id: 'c', duration_ms: 3, bridge_version: '0.0.7', idempotency_key_seen: false, status: 'ok',
    outputs } as BridgeResult });
const failed = (code: string, message: string): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'bridge-1',
  attempts: 1, result: { command_id: 'c', duration_ms: 3, bridge_version: '0.0.7', idempotency_key_seen: false,
    status: 'error', error: { code, message } } as BridgeResult });

/** The answers a Bridge gives, one per command in order (the last repeating), or by action. */
type Answer = DispatchOutcome | ((request: DispatchRequest) => DispatchOutcome);
const act = async (steps: unknown, answers: Answer[] | Partial<Record<string, Answer>>) => {
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
    getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: vi.fn(() => false) }),
  });
  const manifest = KERNEL_MANIFESTS.find((m) => m.slug === 'dom-act')!;
  const call: ResolvedCall = { slug: 'dom-act', risk_tier: 'write', output: manifest.output,
    input: { target: '*://*/*', page: PAGE, steps },
    stepMeta: { recipe_id: 'act-on-web-page', step_id: 'act', run_id: 'run-1' } };
  const settled: { result?: unknown; error?: unknown } = await adapter(call)
    .then((result) => ({ result }), (error: unknown) => ({ error }));
  return { ...settled, requests };
};
const message = (error: unknown) => (error as { message?: string }).message;
const code = (error: unknown) => (error as { code?: string }).code;

const SIGN_IN = [
  { do: 'type', ref: 'e3', value: 'ada@example.com' },
  { do: 'type', ref: 'e5', value: 'hunter2', submit: true },
];

describe('D-335 slice J — a sequence runs step by step, one approval for all of them', () => {
  it('a sign-in: types, then types and sends, and answers the page the tab lands on', async () => {
    const { result, requests } = await act(SIGN_IN, {
      fill: ok({ filled: true }),
      submit: ok({ filled: true, submitted: true, moved: true, ...HOME }),
    });
    expect(result).toEqual({ done: 2, of: 2, steps: ['typed into e3', 'typed into e5 and sent its form'], ...HOME });
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
  });

  it('a retried run sends the same commands, so the Bridge replays them rather than acting twice', async () => {
    const answers = { fill: ok({ filled: true }), submit: ok({ submitted: true, filled: true, moved: true, ...HOME }) };
    const first = await act(SIGN_IN, answers);
    const again = await act(SIGN_IN, answers);
    expect(again.requests.map((r) => r.idempotency_key)).toEqual(first.requests.map((r) => r.idempotency_key));
  });

  it('a CAPTCHA stops the sequence where it shows, saying how far it got and where the tab is', async () => {
    const { error, requests } = await act([...SIGN_IN, { do: 'click', ref: 'e9' }], [ok({ filled: true, challenge: 'reCAPTCHA' })]);
    expect(code(error)).toBe('DOM_CHECK_FAILED');
    expect(message(error)).toBe('Stopped at step 1 of 3: the page now shows a reCAPTCHA CAPTCHA that nobody has solved: '
      + 'the owner can solve it in their browser, then ask again. Done: 1. typed into e3. The tab\'s page is 7:DOC1.');
    expect(requests).toHaveLength(1);
  });

  it('a CAPTCHA a sent form meets stops it too, on the page the tab shows', async () => {
    const { error } = await act(SIGN_IN, { fill: ok({ filled: true }),
      submit: ok({ submitted: true, filled: true, moved: false, page: PAGE, url: LOGIN_URL, title: 'Sign in', challenge: 'hCaptcha' }) });
    expect(code(error)).toBe('DOM_CHECK_FAILED');
    expect(message(error)).toBe('Stopped at step 2 of 2: the page now shows a hCaptcha CAPTCHA that nobody has solved: the '
      + 'owner can solve it in their browser, then ask again. Done: 1. typed into e3; 2. typed into e5 and sent its form. '
      + 'The tab shows “Sign in” (https://example.com/login), page 7:DOC1.');
  });

  it('a sent form that leaves the page where it was stops, and says how to check a form that answers in place', async () => {
    const { error } = await act(SIGN_IN, { fill: ok({ filled: true }),
      submit: ok({ submitted: true, filled: true, moved: false, page: PAGE, url: LOGIN_URL, title: 'Sign in' }) });
    expect(code(error)).toBe('DOM_CHECK_FAILED');
    expect(message(error)).toBe('Stopped at step 2 of 2: the form was sent, but within 5 seconds the page did not move on: '
      + 'it may be showing an error, so inspect it. For a form that answers where it is, give the step a success_when, such as '
      + '{ "shows": "…" }. Done: 1. typed into e3; 2. typed into e5 and sent its form. '
      + 'The tab shows “Sign in” (https://example.com/login), page 7:DOC1.');
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
    expect(message(byRef.error)).toBe('Stopped at step 2 of 2: it names e4, a ref from the page before step 1 loaded a new one: '
      + 'inspect the page it loaded to name its elements. Done: 1. clicked e3. The tab shows “Home” (https://example.com/home), '
      + 'page 7:DOC2.');
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
    expect(message(error)).toBe('Stopped at step 2 of 2: The form was not sent: password: Please fill in this field. '
      + 'Done: 1. typed into e3. The tab\'s page is 7:DOC1.');
    // A Bridge that predates sending a form says so, after the steps before it.
    const old = await act(SIGN_IN, [ok({ filled: true }), { kind: 'capacity_gap', capacity_gap: { kind: 'bridge_online' },
      reason: 'bridge_update_required', attempts: 0 }]);
    expect(message(old.error)).toMatch(/^Stopped at step 2 of 2: Update the Browser Bridge: the connected one cannot run 'submit'/);
  });

  it('a page still loading when the Bridge stopped waiting ends the sequence there, unless nothing is left', async () => {
    const loading = ok({ submitted: true, filled: true, moved: true });
    const last = await act(SIGN_IN, { fill: ok({ filled: true }), submit: loading });
    // No handle yet: the model lists the tabs for it.
    expect(last.result).toEqual({ done: 2, of: 2, steps: ['typed into e3', 'typed into e5 and sent its form'] });
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
    expect(message(error)).toBe(`Stopped at step 2 of 2: the page shows an error message: “${INVALID}”. Done: 1. typed `
      + 'into e3; 2. typed into e5 and sent its form. The tab shows “Sign in” (https://example.com/login), page 7:DOC1.');
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
    expect(message(error)).toBe('Stopped at step 1 of 1: the step\'s fail_when holds: “.flash.error” shows, and the page '
      + `says “${INVALID}”. Done: 1. clicked e4. The tab shows “Sign in” (https://example.com/login), page 7:DOC1.`);
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
    expect(message(unmoved.error)).toBe('Stopped at step 2 of 2: the click sent its form, but within 5 seconds the page did '
      + 'not move on: it may be showing an error, so inspect it. For a form that answers where it is, give the step a '
      + 'success_when, such as { "shows": "…" }. Done: 1. typed into e3; 2. clicked e4, which sent its form. The tab shows '
      + '“Sign in” (https://example.com/login), page 7:DOC1.');
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
    expect(result).toEqual({ done: 1, of: 1, steps: ['typed into e3 and picked “Acme Corp”'], ...NEW_DEAL });
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
    expect(result).toEqual({ done: 1, of: 1, steps: ['typed into e3, picked “Acme Corp” and sent its form'], ...HOME });
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
      steps: ['typed into e3 and picked “Acme Corp”, which loaded a new page, so its form was not sent'], ...article });
    expect(sent.requests.map((r) => r.action)).toEqual(['pick']);
    const after = await act([COMPANY, { do: 'click', ref: 'e7' }], { pick: ok({ filled: true, picked: 'Acme Corp', moved: true, ...article }) });
    expect(message(after.error)).toMatch(/^Stopped at step 2 of 2: it names e7, a ref from the page before step 1 loaded a new one/);
  });

  it('a suggestion the Bridge could not pick stops the sequence with its words', async () => {
    const none = 'None of its suggestions is “Acme Corp”. They were: “Acme Inc”; “Acme Ltd”. Pick one of them by its text.';
    const { error } = await act([COMPANY, { do: 'click', ref: 'e9' }], [failed('value_not_applied', none)]);
    expect(message(error)).toBe(`Stopped at step 1 of 2: ${none} Nothing was done. The tab's page is 7:DOC1.`);
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
    return { ...settled, requests };
  };

  it('sends one pick, waiting for the suggestion inside a longer command, and answers what it picked and the page', async () => {
    const { result, requests } = await write({ pick: 'Acme Corp' }, { pick: ok({ filled: true, picked: 'Acme Corp', moved: false, ...NEW_DEAL }) });
    expect(requests.map((r) => [r.action, r.args])).toEqual([
      ['pick', { page: PAGE, ref: 'e3', value: 'Acme', pick: 'Acme Corp', pick_ms: 5_000 }]]);
    expect(requests[0]!.expects_output_keys).toEqual([...BRIDGE_PICK_OUTPUT_KEYS]);
    expect(requests[0]!.timeout_ms).toBe(25_000);
    expect(result).toEqual({ written: 1, fields: ['__core_dom_value'], failed: [], picked: 'Acme Corp', ...NEW_DEAL });
  });

  it('an empty pick is plain typing, as before', async () => {
    const { result, requests } = await write({ pick: '' }, { fill: ok({ filled: true }) });
    expect(requests.map((r) => r.action)).toEqual(['fill']);
    expect(result).toEqual({ written: 1, fields: ['__core_dom_value'], failed: [] });
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
