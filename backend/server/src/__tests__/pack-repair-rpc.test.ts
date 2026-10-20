import { expect, it } from 'vitest';
import WebSocket from 'ws';
import { startServer } from '../server.js';
import { packRemovalFixture } from './pack-removal-fixture.js';
import type { PackRepairPlan, PackRepairApplyResult } from '@recued/contracts';
interface Reply { request_id: string; result?: unknown; error?: { code: string; message: string } }
const rpc = (ws: WebSocket, method: string, args: unknown): Promise<Reply> => new Promise((resolve, reject) => {
  const request_id = crypto.randomUUID(), timer = setTimeout(() => { ws.off('message', receive);reject(new Error('Repair RPC timed out')); }, 8000);
  const receive = (raw: WebSocket.RawData) => { const reply = JSON.parse(raw.toString()) as Reply;if (reply.request_id === request_id) { clearTimeout(timer);ws.off('message', receive);resolve(reply); } };
  ws.on('message', receive);ws.send(JSON.stringify({ type: 'rpc', request_id, method, args }));
});
it('exposes read-only inspection and exact atomic repair only to paired webclient owners', async () => {
  const f = await packRemovalFixture(), sockets: WebSocket[] = [];
  f.contracts.put('grant', ['orphan-pack', 'catalog', 'connection', 'read'], { allowed: true });
  const server = await startServer(0, { clientTokens: f.clients, packUninstallDeps: f.deps, packUpdateDeps: { store: f.updates, suites: f.store, clientTokens: f.clients } });
  const connect = async (kind: 'webclient' | 'cli', instance: string = kind) => {
    const token = await f.clients.issue({ client_kind: kind, metadata: { instance_id: instance } });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${encodeURIComponent(token.token_id + '.' + token.bearer)}`);sockets.push(ws);
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve);ws.once('error', reject); });return ws;
  };
  try {
    const owner = await connect('webclient', 'owner'), other = await connect('webclient', 'other'), cli = await connect('cli');
    expect(await rpc(cli, 'packs.repair.inspect', {})).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await rpc(owner, 'packs.repair.inspect', { cleanup: true })).toMatchObject({ error: { code: 'bad_request' } });
    expect((await rpc(owner, 'packs.repair.inspect', {})).error).toBeUndefined();
    const review = { inventory_key: 'orphan-pack', request_id: 'review' };
    expect(await rpc(owner, 'packs.repair.review', { ...review, manifest: {} })).toMatchObject({ error: { code: 'bad_request' } });
    expect(await rpc(owner, 'packs.repair.review', { ...review, inventory_key: '__user__' })).toMatchObject({ error: { code: 'bad_request' } });
    const reviewed = await rpc(owner, 'packs.repair.review', review);expect(reviewed.error).toBeUndefined();const plan = reviewed.result as PackRepairPlan;
    const request = { review_id: plan.review_id, request_id: 'apply', acknowledge_local_cleanup: true };
    expect(await rpc(other, 'packs.repair.apply', request)).toMatchObject({ error: { code: 'not_found' } });
    expect(await rpc(owner, 'packs.repair.apply', { ...request, acknowledge_local_cleanup: 'yes' })).toMatchObject({ error: { code: 'bad_request' } });
    expect(await rpc(owner, 'packs.repair.apply', { ...request, grants: [] })).toMatchObject({ error: { code: 'bad_request' } });
    const result = await rpc(owner, 'packs.repair.apply', request);expect(result.error).toBeUndefined();expect((result.result as PackRepairApplyResult).current?.metadata.grants).toBe(0);
    expect((await rpc(owner, 'packs.repair.apply', request)).result).toEqual(result.result);
  } finally { for (const ws of sockets) ws.terminate();await server.close();f.close(); }
}, 20000);
