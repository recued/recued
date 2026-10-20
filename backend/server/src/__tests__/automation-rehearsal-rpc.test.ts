import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { RehearsalView, RehearsalMutation, RehearsalReview } from '@recued/contracts';
import { startServer } from '../server.js';
import { rehearsalFixture } from './automation-rehearsal-fixture.js';
import { resourceFixtureDisposers } from './preapproval-resources-fixture.js';
interface Reply { request_id: string; result?: unknown; error?: { code: string; message: string } }
const rpc = (ws: WebSocket, method: string, args: unknown): Promise<Reply> => new Promise((resolve, reject) => {
  const request_id = randomUUID(), timeout = setTimeout(() => { ws.off('message', receive); reject(new Error('Rehearsal RPC timeout')); }, 10_000);
  const receive = (data: WebSocket.RawData) => { const value = JSON.parse(data.toString()) as Reply;
    if (value.request_id === request_id) { clearTimeout(timeout); ws.off('message', receive); resolve(value); } };
  ws.on('message', receive); ws.send(JSON.stringify({ type: 'rpc', request_id, method, args }));
});
afterEach(async () => { for (const close of resourceFixtureDisposers.splice(0).reverse()) await close(); });
it('drives real owner RPC forwarding, blocks other channels and applies only a reviewed tested configuration', async () => {
  const f = await rehearsalFixture(), server = await startServer(0, { clientTokens: f.clients,
    automationRehearsalDeps: { store: f.store, clientTokens: f.clients } });
  const sockets: WebSocket[] = [];
  const connect = async (kind: 'webclient' | 'cli', instance?: string) => {
    const token = await f.clients.issue({ client_kind: kind, ...(instance ? { metadata: { instance_id: instance } } : {}) });
    const ws = new WebSocket('ws://127.0.0.1:' + server.port + '/ws?token=' + encodeURIComponent(token.token_id + '.' + token.bearer));
    sockets.push(ws); await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }); return { ws, token };
  };
  try {
    const owner = await connect('webclient', 'rehearsal-browser'), cli = await connect('cli'), unpaired = await connect('webclient');
    for (const client of [cli, unpaired]) for (const method of ['get', 'save', 'test', 'prepare', 'activate', 'delete']) {
      expect(await rpc(client.ws, 'automation.rehearsal.' + method, {})).toMatchObject({ error: { code: 'unauthorized' } });
    }
    const initial = await rpc(owner.ws, 'automation.rehearsal.get', { target: f.target }); expect(initial.error).toBeUndefined();
    const view = initial.result as RehearsalView;
    const saveReply = await rpc(owner.ws, 'automation.rehearsal.save', { target: f.target, expected_revision: view.revision,
      expected_live_digest: view.live_digest, request_id: randomUUID(), document: f.document() });
    expect(saveReply.error).toBeUndefined(); const saved = saveReply.result as RehearsalMutation;
    expect(await rpc(owner.ws, 'automation.rehearsal.test', { target: f.target, expected_revision: saved.revision, draft_revision: saved.draft!.revision, outcome: 'passed' })).toMatchObject({ error: { code: 'bad_request' } });
    const testReply = await rpc(owner.ws, 'automation.rehearsal.test', { target: f.target, expected_revision: saved.revision, draft_revision: saved.draft!.revision });
    expect(testReply.error).toBeUndefined(); const tested = testReply.result as RehearsalView;
    const reviewReply = await rpc(owner.ws, 'automation.rehearsal.prepare', { target: f.target, expected_revision: tested.revision,
      draft_revision: tested.draft!.revision, receipt_id: tested.qualification!.receipt_id }); expect(reviewReply.error).toBeUndefined();
    const review = reviewReply.result as RehearsalReview, request = { target: f.target, expected_revision: tested.revision,
      review_id: review.review_id, request_id: randomUUID() };
    expect(f.sources.triggers.get(f.target.id)?.enabled).toBe(false);
    const activated = await rpc(owner.ws, 'automation.rehearsal.activate', request); expect(activated.error).toBeUndefined();
    expect(activated).toMatchObject({ result: { activated: { sequence: 1 }, mutation_revision: 2 } });
    expect(await rpc(owner.ws, 'automation.rehearsal.activate', request)).toMatchObject({ result: { activated: { sequence: 1 }, mutation_revision: 2 } });
    expect(f.sources.triggers.get(f.target.id)?.enabled).toBe(true); expect(f.calendarUpdates).not.toHaveBeenCalled();
    f.clients.revoke(owner.token.token_id, 'revoked at server', f.clock.now);
    expect(await rpc(owner.ws, 'automation.rehearsal.get', { target: f.target })).toMatchObject({ error: { code: 'unauthorized' } });
  } finally { for (const socket of sockets) socket.terminate(); await server.close(); }
}, 45_000);
