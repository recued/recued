/** D-402 slice C — a trial of a draft asks the owner before each change in a web page, and waits:
 *  the ask it puts, each answer it takes, and how it ends without one. */
import { describe, expect, it } from 'vitest';
import {
  BROWSER_TRIAL_ASK_KIND, BROWSER_TRIAL_DO_OPTION, BROWSER_TRIAL_STOP_OPTION, browserTrialSentence, readBrowserTrialPrompt,
} from '@recued/contracts';

import type { BrowserSecretNotifier } from '../bridges/browser-secrets.js';
import { createBrowserTrials } from '../bridges/browser-trials.js';
import type { BridgeResult } from '@recued/contracts';
import type { ResolvedCall } from '@recued/ingredients';
import { vi } from 'vitest';
import { createBridgeDomAdapter } from '../bridges/dom-adapter.js';
import type { DispatchRequest } from '../bridges/dispatcher.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';

/** A notification block that keeps its asks and lets the test answer them. */
const block = (leftOver: Array<{ ask_id: string; handler_kind: string }> = []) => {
  const asks: Array<{ ask_id: string; message: { title: string; text: string }; options: readonly { id: string; label: string }[];
    handler: { kind: string; payload: Record<string, unknown> } }> = [];
  const cancelled: string[] = [];
  const handlers = new Map<string, (payload: Record<string, unknown>, answer: { option: string }) => void | Promise<void>>();
  const notifier: BrowserSecretNotifier = {
    ask: async (message, options, handler) => {
      const ask_id = `ask-${String(asks.length + 1)}`;
      asks.push({ ask_id, message, options, handler });
      return { ask_id };
    },
    cancelAsk: async (ask_id) => { cancelled.push(ask_id); return 'cancelled'; },
    listOpenAsks: async () => leftOver,
    registerAskHandler: (kind, handler) => { handlers.set(kind, handler); },
  };
  const answer = async (ask_id: string, option: string) => {
    const ask = asks.find((one) => one.ask_id === ask_id)!;
    await handlers.get(ask.handler.kind)?.(ask.handler.payload, { option });
  };
  return { notifier, asks, cancelled, answer };
};

const prompt = { action: 'type' as const, url: 'https://shop.example.com/search', element: { role: 'search box', label: 'Search' },
  text: 'Brass lamp', step: 1, of: 2 };
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('D-402 slice C — a trial asks before each change in a web page', () => {
  it('marks a run as a trial while it executes', () => {
    const trials = createBrowserTrials();
    expect(trials.isTrial('run-1')).toBe(false);
    trials.begin('run-1');
    expect(trials.isTrial('run-1')).toBe(true);
    expect(trials.isTrial(undefined)).toBe(false);
    trials.end('run-1');
    expect(trials.isTrial('run-1')).toBe(false);
  });

  it('asks with the element as the page names it and the whole text, and "Do it" lets the step go on', async () => {
    const b = block();
    const trials = createBrowserTrials();
    await trials.install({ notifier: b.notifier, now: () => 1_000 });
    const answer = trials.ask({ run_id: 'run-1', prompt });
    await settled();
    expect(b.asks).toHaveLength(1);
    expect(b.asks[0]!.message.title).toBe('Trying your recipe: step 1 of 2');
    expect(b.asks[0]!.message.text).toContain('Type “Brass lamp” into the search box “Search” on https://shop.example.com/search.');
    expect(b.asks[0]!.options.map((option) => option.id)).toEqual([BROWSER_TRIAL_DO_OPTION, BROWSER_TRIAL_STOP_OPTION]);
    expect(b.asks[0]!.handler.kind).toBe(BROWSER_TRIAL_ASK_KIND);
    expect(readBrowserTrialPrompt(b.asks[0]!.handler.payload)).toEqual({ ...prompt, site: 'shop.example.com', expires_at: 301_000 });
    await b.answer('ask-1', BROWSER_TRIAL_DO_OPTION);
    await expect(answer).resolves.toEqual({ done: true });
  });

  it('"Stop the trial", no answer in time, and a stopped run each end the step before it changes anything', async () => {
    const b = block();
    const trials = createBrowserTrials();
    await trials.install({ notifier: b.notifier, waitMs: 40 });
    const stopped = trials.ask({ run_id: 'run-1', prompt });
    await settled();
    await b.answer('ask-1', BROWSER_TRIAL_STOP_OPTION);
    await expect(stopped).resolves.toEqual({ refused: 'you stopped the trial here, before this step changed anything' });
    // Unanswered: the ask is closed for the owner too.
    await expect(trials.ask({ run_id: 'run-1', prompt })).resolves.toMatchObject({ refused: expect.stringContaining('nobody answered') });
    expect(b.cancelled).toContain('ask-2');
    const run = new AbortController();
    const aborted = trials.ask({ run_id: 'run-1', prompt, signal: run.signal });
    await settled();
    run.abort();
    await expect(aborted).resolves.toEqual({ refused: 'the trial was stopped while it waited for your answer' });
    // An answer after the step stopped waiting changes nothing.
    await b.answer('ask-1', BROWSER_TRIAL_DO_OPTION);
  });

  it('with no way to ask, nothing is changed; at boot, the trial asks a restart left open are ended', async () => {
    await expect(createBrowserTrials().ask({ run_id: 'run-1', prompt })).resolves.toMatchObject({ refused: expect.stringContaining('cannot ask you') });
    const b = block([{ ask_id: 'old-trial', handler_kind: BROWSER_TRIAL_ASK_KIND }, { ask_id: 'old-other', handler_kind: 'preflight' }]);
    await createBrowserTrials().install({ notifier: b.notifier });
    expect(b.cancelled).toEqual(['old-trial']);
  });

  it('says each kind of change plainly, a protected field\'s text never', () => {
    const at = { url: 'https://login.example.com/', step: 2, of: 3, site: 'login.example.com', expires_at: 0 };
    expect(browserTrialSentence({ ...at, action: 'type', element: { role: 'text field', label: 'Password' }, secret: 'password' }))
      .toBe('Type your password into the text field “Password” on https://login.example.com/.');
    expect(browserTrialSentence({ ...at, action: 'type', element: { role: 'search box', label: 'Search' }, text: 'Ada', submits: true }))
      .toBe('Type “Ada” into the search box “Search”, then send the form on https://login.example.com/.');
    expect(browserTrialSentence({ ...at, action: 'click', element: { role: 'button', label: 'Delete' } }))
      .toBe('Click the button “Delete” on https://login.example.com/.');
    // 2026-11-23 (the owner: "ditch that ask for try it") — opening a page, going to an address and a collect turning
    //   pages are reads: a trial asks before none of them, so a prompt naming one is no trial prompt.
    for (const action of ['open', 'go', 'collect']) {
      expect(readBrowserTrialPrompt({ ...at, action, url: 'https://example.com/a' })).toBeUndefined();
    }
    expect(readBrowserTrialPrompt({ ...at, action: 'back' })).toMatchObject({ action: 'back' });
    expect(browserTrialSentence({ ...at, action: 'upload', element: { role: 'file field', label: 'CV' }, file: 'cv.pdf' }))
      .toBe('Put your file “cv.pdf” into the file field “CV” on https://login.example.com/.');
  });
});

// 2026-11-23 (the owner: "make the go read no ask default too", "ditch that ask for try it") — a trial asks before each
//   change: going to an address, like opening a page and a collect turning pages, is a read, and asks nothing.
describe('a trial of a draft asks before changes only', () => {
  it('going to an address asks nothing; going back, a change, asks with the page it leaves', async () => {
    const requests: DispatchRequest[] = [];
    let url = 'https://shop.example.com/start';
    const adapter = createBridgeDomAdapter({
      manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ cancel: vi.fn(), canResolve: vi.fn(() => true), dispatch: async request => {
        requests.push(request);
        if (request.action === 'navigate') url = String(request.args.url);
        if (request.action === 'go_back') url = 'https://shop.example.com/start';
        return { kind: 'completed' as const, bridge_client_token_id: 'bridge', attempts: 1,
          result: { command_id: 'command', duration_ms: 1, bridge_version: '0.0.13', idempotency_key_seen: false, status: 'ok',
            outputs: { page: '7:DOC1', url, title: 'Shop', html: '<main><h1>Shop</h1></main>', truncated: false } } as BridgeResult };
      } }),
      trials: { isTrial: run_id => run_id === 'trial-run',
        ask: async ({ prompt }) => { asked.push({ action: prompt.action, url: prompt.url, sent: requests.length }); return { done: true }; } },
    });
    const asked: Array<{ action: string; url: string; sent: number }> = [];
    const call: ResolvedCall = { slug: 'dom-act', risk_tier: 'write', output: {}, input: { target: '*://*/*', page: '7:DOC1',
      steps: [{ do: 'go', address: 'https://shop.example.com/lamps' }, { do: 'back' }] },
      stepMeta: { recipe_id: 'draft', step_id: 'act', run_id: 'trial-run' } };
    await adapter(call);
    // One ask, for going back, on the page the step leaves, once the go had gone there and nothing more was sent.
    const went = requests.findIndex(request => request.action === 'navigate');
    expect(went).toBeGreaterThanOrEqual(0);
    expect(asked).toEqual([{ action: 'back', url: 'https://shop.example.com/lamps', sent: went + 1 }]);
    expect(requests.map(request => request.action).filter(action => ['navigate', 'go_back'].includes(action))).toEqual(['navigate', 'go_back']);
  });
});
