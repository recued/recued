import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { startServer } from '../server.js';
import type { LocalChangeSetInspection } from '@recued/contracts';
import { resourceFixture, resourceFixtureDisposers } from './preapproval-resources-fixture.js';
afterEach(async () => { for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose(); });
it('authenticates every atomic RPC against the live paired owner and refuses forged authority',async () => {
  const f = await resourceFixture(), source = await f.service.prepare(f.request(),f.origin);
  const server = await startServer(0,{ clientTokens: f.clients,preapprovalDeps: f.composed.handlers });
  const sockets: WebSocket[] = [];
  interface Reply { request_id: string; result?: unknown; error?: { code: string } }
  const rpc = (ws: WebSocket,method: string,args: unknown): Promise<Reply> => new Promise((resolve,reject) => {
    const request_id = randomUUID(), timer = setTimeout(() => { ws.off('message',receive); reject(new Error('Atomic RPC timed out')); },5000);
    const receive = (data: WebSocket.RawData): void => {
      const reply = JSON.parse(data.toString()) as Reply;
      if (reply.request_id !== request_id) return;
      clearTimeout(timer); ws.off('message',receive); resolve(reply);
    };
    ws.on('message',receive); ws.send(JSON.stringify({ type: 'rpc',request_id,method,args }));
  });
  try {
    for (const kind of ['cli','unpaired','owner'] as const) {
      const token = kind === 'owner' ? f.token : await f.clients.issue({ client_kind: kind === 'cli' ? 'cli' : 'webclient' });
      const ws = await new Promise<WebSocket>((resolve,reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${encodeURIComponent(token.token_id + '.' + token.bearer)}`);
        sockets.push(socket); socket.once('open',() => resolve(socket)); socket.once('error',reject);
      });
      if (kind !== 'owner') {
        for (const method of ['local_changes.prepare','local_changes.get','local_changes.list','local_changes.decide','local_changes.prepare_undo']) {
          expect(await rpc(ws,method,{})).toMatchObject({ error: { code: 'preapproval_invalid_proof' } });
        }
        continue;
      }
      expect(await rpc(ws,'local_changes.prepare',{ proposal_id: source.proposal_id,request_id: randomUUID(),origin: f.origin }))
        .toMatchObject({ error: { code: 'bad_request' } });
      const prepared = await rpc(ws,'local_changes.prepare',{ proposal_id: source.proposal_id,request_id: randomUUID() });
      expect(prepared.error).toBeUndefined(); const view = prepared.result as LocalChangeSetInspection;
      expect((await rpc(ws,'local_changes.get',{ change_set_id: view.change_set_id })).result).toEqual(view);
      expect((await rpc(ws,'local_changes.list',{ cursor: '' })).result).toMatchObject({ items: [{ change_set_id: view.change_set_id }],next_cursor: null });
      const decided = await rpc(ws,'local_changes.decide',{ change_set_id: view.change_set_id,review_hash: view.review!.review_hash,decision: 'approve' });
      expect(decided).toMatchObject({ result: { status: 'completed',receipts: [{},{},{}] } });
      const reverse = await rpc(ws,'local_changes.prepare_undo',{ change_set_id: view.change_set_id,request_id: randomUUID() });
      expect(reverse).toMatchObject({ result: { status: 'pending',undo_of: view.change_set_id } });
      f.clients.revoke(f.token.token_id,'Revoked after commit');
      expect(await rpc(ws,'local_changes.get',{ change_set_id: view.change_set_id })).toMatchObject({ error: { code: 'preapproval_invalid_proof' } });
    }
  } finally { for (const socket of sockets) socket.terminate(); await server.close(); }
  expect(f.row('a')!._record.revision).toBe(1);
});
