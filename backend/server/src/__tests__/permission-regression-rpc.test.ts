import { afterEach, expect, it } from 'vitest';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { PermissionMutation, PermissionWorkbenchView, PermissionReview } from '@recued/contracts';
import { startServer } from '../server.js';
import { permissionFixture } from './permission-regression-fixture.js';
import { resourceFixtureDisposers } from './preapproval-resources-fixture.js';
interface Reply { request_id: string; result?: unknown; error?: { code: string; message: string } }
const rpc = (ws: WebSocket, method: string, args: unknown): Promise<Reply> => new Promise((resolve, reject) => {
  const request_id = randomUUID(), timer = setTimeout(() => { ws.off('message', receive); reject(new Error('Permission RPC timeout')); }, 10_000);
  const receive = (data: WebSocket.RawData) => { const reply = JSON.parse(data.toString()) as Reply;
    if (reply.request_id === request_id) { clearTimeout(timer); ws.off('message', receive); resolve(reply); } };
  ws.on('message', receive); ws.send(JSON.stringify({ type: 'rpc', request_id, method, args }));
});
afterEach(async () => { for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose(); });
it('exposes saved cases, qualification and atomic activation only to a live paired webclient', async () => {
  const f = await permissionFixture(), server = await startServer(0, { clientTokens: f.clients, permissionRegressionDeps: { store: f.store, clientTokens: f.clients } });
  const sockets: WebSocket[] = [];
  const connect = async (kind: 'webclient' | 'cli', instance?: string) => {
    const token = await f.clients.issue({ client_kind: kind, ...(instance ? { metadata: { instance_id: instance } } : {}) });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${encodeURIComponent(token.token_id + '.' + token.bearer)}`); sockets.push(ws);
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }); return { ws, token };
  };
  try {
    const owner = await connect('webclient', 'permission-owner'), cli = await connect('cli'), unpaired = await connect('webclient');
    for (const client of [cli, unpaired]) for (const method of ['get', 'save', 'restore', 'test', 'prepare', 'activate', 'delete']) {
      expect(await rpc(client.ws, 'contract.regression.' + method, {})).toMatchObject({ error: { code: 'unauthorized' } });
    }
    const contract_id = f.contract.contract_id;
    const first = await rpc(owner.ws, 'contract.regression.get', { contract_id }); expect(first.error).toBeUndefined();
    const initial = first.result as PermissionWorkbenchView;
    expect(await rpc(owner.ws, 'contract.regression.get', { contract_id, source: { actor: 'user_self' } })).toMatchObject({ error: { code: 'bad_request' } });
    const savedReply = await rpc(owner.ws, 'contract.regression.save', { contract_id, expected_revision: 0, expected_live_digest: initial.live_digest, request_id: randomUUID(), document: f.document() });
    expect(savedReply.error).toBeUndefined(); const saved = savedReply.result as PermissionMutation;
    expect(await rpc(owner.ws, 'contract.regression.test', { contract_id, expected_revision: saved.revision, draft_revision: saved.draft!.revision, outcome: 'passed' })).toMatchObject({ error: { code: 'bad_request' } });
    const testedReply = await rpc(owner.ws, 'contract.regression.test', { contract_id, expected_revision: saved.revision, draft_revision: saved.draft!.revision });
    expect(testedReply.error).toBeUndefined(); const tested = testedReply.result as PermissionWorkbenchView;
    const reviewReply = await rpc(owner.ws, 'contract.regression.prepare', { contract_id, expected_revision: tested.revision,
      draft_revision: tested.draft!.revision, receipt_id: tested.qualification!.receipt_id });
    expect(reviewReply.error).toBeUndefined(); const review = reviewReply.result as PermissionReview;
    const request = { contract_id, expected_revision: tested.revision, review_id: review.review_id, request_id: randomUUID() };
    const activated = await rpc(owner.ws, 'contract.regression.activate', request); expect(activated.error).toBeUndefined();
    expect(activated).toMatchObject({ result: { activated: { sequence: 2 }, revision: 2 } });
    expect(await rpc(owner.ws, 'contract.regression.activate', request)).toMatchObject({ result: { activated: { sequence: 2 }, mutation_revision: 2 } });
    expect(f.grants.get(contract_id, f.remove)).toBe(false); expect(f.calendarDeletes).not.toHaveBeenCalled();
  } finally { for (const ws of sockets) ws.terminate(); await server.close(); }
}, 45_000);
