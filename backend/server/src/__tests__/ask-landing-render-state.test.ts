import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PendingAsk } from '@recued/notification';
import { ASK_LANDING_LINK_TTL_MS, createAskLandingPortHandler, type AskLandingPortHandlerDeps } from '../ask-landing-port.js';
import { ASK_LANDING_NONCE_TTL_MS, createInMemoryAskLandingNonceStore } from '../ask-landing-nonce-store.js';
import { allowingAskLandingAbuseDeps, attachAskTestSocket } from './ask-landing-test-helpers.js';

const NOW = 1_700_000_000_000;
const ASK_ID = 'ask-render-race';
const PRIVATE_DETAIL = 'private-held-arguments';
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const liveAsk = (overrides: Partial<PendingAsk> = {}): PendingAsk => ({
  ask_id: ASK_ID, message: { title: 'Fixture approval', text: 'Approve this fixture?' },
  options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }],
  handler_kind: 'gateway.preflight', handler_payload: { checkpoint_id: 'fixture-checkpoint' },
  fanout_channels: ['email'], status: 'open', created_at: NOW, ...overrides,
});

const active: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(active.splice(0).map(close => close())); });

const fixture = (options: { ask?: PendingAsk; holdPhrase?: boolean; holdFinalRead?: boolean } = {}) => {
  let current: PendingAsk | null = options.ask ?? liveAsk();
  let clock = NOW;
  let detailsFinished = false;
  let detailError: Error | undefined, stateReadError: Error | undefined;
  const detailGate = deferred(), detailsStarted = deferred();
  const phraseGate = deferred(), phraseStarted = deferred();
  const finalReadGate = deferred();
  let finalReadStarted = false;
  const nonceStore = createInMemoryAskLandingNonceStore();
  const issue = vi.spyOn(nonceStore, 'issue');
  const logs: unknown[] = [];
  const resolveDetails = vi.fn(async () => {
    detailsStarted.resolve();
    await detailGate.promise;
    detailsFinished = true;
    if (detailError) throw detailError;
    return { heading: 'Fixture held operation', details: [{ label: 'Value', value: PRIVATE_DETAIL }] };
  });
  const deps: AskLandingPortHandlerDeps = {
    getAsk: async id => {
      // Store reads return independent snapshots, not a mutable object shared
      // with the renderer. A later answer cannot update the old snapshot.
      const snapshot = id === ASK_ID && current !== null ? structuredClone(current) : null;
      if (detailsFinished) {
        if (options.holdFinalRead) { finalReadStarted = true; await finalReadGate.promise; }
        if (stateReadError) throw stateReadError;
      }
      return snapshot;
    },
    getVerificationPhrase: async () => {
      phraseStarted.resolve();
      if (options.holdPhrase) await phraseGate.promise;
      return 'fixture verification';
    },
    submitAnswer: vi.fn(async () => {}),
    resolveDetails, nonceStore, now: () => clock,
    abuse: { ...allowingAskLandingAbuseDeps(), getStore: () => ({ appendAccessLog: row => { logs.push(row); } }) },
  };
  const handler = createAskLandingPortHandler(deps);
  const requests: Promise<void>[] = [];
  active.push(async () => {
    phraseGate.resolve(); detailGate.resolve(); finalReadGate.resolve();
    await Promise.allSettled(requests);
  });
  const get = () => {
    const req = attachAskTestSocket(Readable.from([]) as unknown as IncomingMessage);
    req.method = 'GET'; req.url = `/ask/${ASK_ID}`; req.headers = { host: 'fixture.local' };
    const response = { statusCode: 0, body: '', headers: new Map<string, string>(),
      setHeader(name: string, value: string | number | readonly string[]) { this.headers.set(name.toLowerCase(), String(value)); },
      end(body?: string | Buffer) { this.body = body === undefined ? '' : String(body); },
    };
    const pending = Promise.resolve(handler(req, response as unknown as ServerResponse));
    requests.push(pending);
    return { response, pending };
  };
  return { get, issue, nonceStore, logs, resolveDetails, detailsStarted, phraseStarted,
    releaseDetails: detailGate.resolve, releasePhrase: phraseGate.resolve, releaseFinalRead: finalReadGate.resolve,
    setNow: (value: number) => { clock = value; },
    setAsk: (ask: PendingAsk | null) => { current = ask; },
    answerElsewhere: () => { current = liveAsk({ status: 'answered', answer: { option: 'approve', answered_at: clock }, answered_via: 'telegram' }); },
    failDetails: () => { detailError = new Error('fixture detail read failed'); },
    failStateRead: () => { stateReadError = new Error('fixture state read failed'); },
    currentAsk: () => current, finalReadStarted: () => finalReadStarted,
  };
};

const expectNoActionableDetails = (response: { body: string }) => {
  expect(response.body).not.toContain(PRIVATE_DETAIL);
  expect(response.body).not.toContain('Fixture held operation');
  expect(response.body).not.toContain('<form');
  expect(response.body).not.toContain('name="form_nonce"');
};

describe('public ask page final state after asynchronous reads', () => {
  it('shows the recorded cross-channel answer if the decision closes while details load', async () => {
    const f = fixture(), request = f.get();
    await f.detailsStarted.promise;
    expect(f.issue).not.toHaveBeenCalled();
    f.answerElsewhere(); f.releaseDetails(); await request.pending;
    expect(request.response.statusCode).toBe(200);
    expect(request.response.body).toContain('already been answered');
    expect(request.response.body).toContain('Response recorded: Approve via telegram');
    expectNoActionableDetails(request.response);
    expect(f.issue).not.toHaveBeenCalled();
  });

  it('closes a link that expires during detail lookup without cancelling the decision', async () => {
    const f = fixture(), request = f.get();
    await f.detailsStarted.promise;
    f.setNow(NOW + ASK_LANDING_LINK_TTL_MS + 1);
    f.releaseDetails(); await request.pending;
    expect(request.response.statusCode).toBe(404);
    expect(request.response.body).toContain('No longer available');
    expectNoActionableDetails(request.response);
    expect(f.issue).not.toHaveBeenCalled();
    expect(f.currentAsk()?.status).toBe('open');
    expect(f.logs.at(-1)).toMatchObject({ action_taken: 'expired', outcome: 'expired' });
  });

  it('discards resolved details if the decision is pruned while the lookup is pending', async () => {
    const f = fixture(), request = f.get();
    await f.detailsStarted.promise;
    f.setAsk(null); f.releaseDetails(); await request.pending;
    expect(request.response.statusCode).toBe(404);
    expectNoActionableDetails(request.response);
    expect(f.issue).not.toHaveBeenCalled();
    expect(f.logs.at(-1)).toMatchObject({ action_taken: 'invalid_token', outcome: 'invalid_token' });
  });

  it('checks the clock after a slow verification-phrase read before resolving private details', async () => {
    const f = fixture({ holdPhrase: true }), request = f.get();
    await f.phraseStarted.promise;
    f.setNow(NOW + ASK_LANDING_LINK_TTL_MS + 1);
    // Also release this gate so an old implementation completes and fails the
    // assertions rather than leaving an unresolved request in the test.
    f.releaseDetails(); f.releasePhrase(); await request.pending;
    expect(request.response.statusCode).toBe(404);
    expect(f.resolveDetails).not.toHaveBeenCalled();
    expect(f.issue).not.toHaveBeenCalled();
    expectNoActionableDetails(request.response);
  });

  it('checks expiry after the final awaited state read as well as after the details', async () => {
    const f = fixture({ holdFinalRead: true }), request = f.get();
    await f.detailsStarted.promise; f.releaseDetails();
    await vi.waitFor(() => expect(f.finalReadStarted()).toBe(true));
    f.setNow(NOW + ASK_LANDING_LINK_TTL_MS + 1);
    f.releaseFinalRead(); await request.pending;
    expect(request.response.statusCode).toBe(404);
    expectNoActionableDetails(request.response);
    expect(f.issue).not.toHaveBeenCalled();
  });

  it('gives a still-open page a usable nonce even if detail loading outlasts the nonce TTL', async () => {
    const f = fixture(), request = f.get();
    await f.detailsStarted.promise;
    const renderTime = NOW + ASK_LANDING_NONCE_TTL_MS + 1;
    f.setNow(renderTime); f.releaseDetails(); await request.pending;
    expect(request.response.statusCode).toBe(200);
    expect(request.response.body).toContain(PRIVATE_DETAIL);
    const nonce = request.response.body.match(/name="form_nonce" value="([^"]+)"/)![1]!;
    expect(f.nonceStore.consume(ASK_ID, nonce, renderTime)).toBe(true);
    expect(f.nonceStore.consume(ASK_ID, nonce, renderTime)).toBe(false);
  });

  it('still rereads decision state when the optional detail resolver throws', async () => {
    const f = fixture(), request = f.get();
    await f.detailsStarted.promise;
    f.answerElsewhere(); f.failDetails(); f.releaseDetails(); await request.pending;
    expect(request.response.statusCode).toBe(200);
    expect(request.response.body).toContain('already been answered');
    expectNoActionableDetails(request.response);
    expect(f.issue).not.toHaveBeenCalled();
  });

  it('does not fall back to the stale form if reading the final decision state fails', async () => {
    const f = fixture(), request = f.get();
    await f.detailsStarted.promise; f.failStateRead();
    const rejected = expect(request.pending).rejects.toThrow('fixture state read failed');
    f.releaseDetails(); await rejected;
    expectNoActionableDetails(request.response);
    expect(f.issue).not.toHaveBeenCalled();
  });

  it('preserves the separate lifetime policy of an open managed delivery-group ask', async () => {
    const f = fixture({ ask: liveAsk({ delivery_group_id: 'fixture-group', created_at: NOW - ASK_LANDING_LINK_TTL_MS - 1 }) });
    const request = f.get();
    await f.detailsStarted.promise; f.releaseDetails(); await request.pending;
    expect(request.response.statusCode).toBe(200);
    expect(request.response.body).toContain(PRIVATE_DETAIL);
    const nonce = request.response.body.match(/name="form_nonce" value="([^"]+)"/)![1]!;
    expect(f.nonceStore.consume(ASK_ID, nonce, NOW)).toBe(true);
  });
});
