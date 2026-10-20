import { expect,it,vi } from 'vitest';
import WebSocket from 'ws';
import type { PackRemovalPlan,PackRemovalApplyResult } from '@recued/contracts';
import { startServer } from '../server.js';
import { packRemovalFixture,installRemovalRecords } from './pack-removal-fixture.js';
interface Reply { request_id: string;result?: unknown;error?: { code: string;message: string } }
const rpc = (ws: WebSocket,method: string,args: unknown): Promise<Reply> => new Promise((resolve,reject) => {
  const request_id = crypto.randomUUID(),timer = setTimeout(() => { ws.off('message',receive);reject(new Error('Removal RPC timed out')); },8000);
  const receive = (data: WebSocket.RawData) => { const reply = JSON.parse(data.toString()) as Reply;if (reply.request_id === request_id) { clearTimeout(timer);ws.off('message',receive);resolve(reply); } };
  ws.on('message',receive);ws.send(JSON.stringify({ type: 'rpc',request_id,method,args }));
});
it('keeps reviewed removal paired-owner-only, rejects extra payloads, and recovers exact receipts',async () => {
  const f = await packRemovalFixture(),remove = vi.spyOn(f.recipes,'delete');
  const server = await startServer(0,{ clientTokens: f.clients,packUninstallDeps: f.deps,
    packUpdateDeps: { store: f.updates,suites: f.store,clientTokens: f.clients } });
  const sockets: WebSocket[] = [];
  const connect = async (kind: 'webclient' | 'cli',instance?: string) => {
    const token = await f.clients.issue({ client_kind: kind,...(instance ? { metadata: { instance_id: instance } } : {}) });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${encodeURIComponent(token.token_id+'.'+token.bearer)}`);sockets.push(ws);
    await new Promise<void>((resolve,reject) => { ws.once('open',resolve);ws.once('error',reject); });return ws;
  };
  try {
    const owner = await connect('webclient','owner'),other = await connect('webclient','other'),cli = await connect('cli');
    const request = f.request();expect(await rpc(cli,'packs.removal.review',request)).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await rpc(owner,'packs.removal.review',{ ...request,target: f.manifest })).toMatchObject({ error: { code: 'bad_request' } });
    const reviewed = await rpc(owner,'packs.removal.review',request);expect(reviewed.error).toBeUndefined();const plan = reviewed.result as PackRemovalPlan;
    expect(plan.blockers).toEqual([]);expect((await rpc(owner,'packs.removal.review',request)).result).toEqual(plan);
    const apply = { review_id: plan.review_id,request_id: crypto.randomUUID() };
    expect(await rpc(other,'packs.removal.apply',apply)).toMatchObject({ error: { code: 'not_found' } });
    expect(await rpc(owner,'packs.removal.apply',{ ...apply,recipes: [] })).toMatchObject({ error: { code: 'bad_request' } });
    expect(await rpc(owner,'packs.removal.apply',{ ...apply,acknowledge_unknown_dependencies: 'yes' })).toMatchObject({ error: { code: 'bad_request' } });
    const result = await rpc(owner,'packs.removal.apply',apply);expect(result.error).toBeUndefined();expect((result.result as PackRemovalApplyResult).receipt.result.ok).toBe(true);
    expect((await rpc(owner,'packs.removal.apply',apply)).result).toEqual(result.result);expect(remove).toHaveBeenCalledTimes(2);
    expect(await rpc(other,'packs.removal.apply',apply)).toMatchObject({ error: { code: 'not_found' } });
  } finally { for (const ws of sockets) ws.terminate();await server.close();f.close(); }
},20000);

it('retires the selected Records inventory history and preserves a same-name publisher',async () => {
  const f = await packRemovalFixture(),first = await installRemovalRecords(f,'publisher-first'),second = await installRemovalRecords(f,'publisher-second');
  for (const record of [first,second]) {
    f.db.prepare('INSERT INTO pack_update_tracks VALUES(?,1,0,?,?)').run(record.catalog,'retained fixture protection','');
    f.db.prepare('INSERT INTO pack_release_history VALUES(?,1,?)').run(record.catalog,'retained fixture history');
  }
  const server = await startServer(0,{ clientTokens: f.clients,packUninstallDeps: f.deps,
    packUpdateDeps: { store: f.updates,suites: f.store,clientTokens: f.clients } });
  let ws: WebSocket | undefined;
  try {
    const token = await f.clients.issue({ client_kind: 'webclient',metadata: { instance_id: 'owner' } });
    ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${encodeURIComponent(token.token_id+'.'+token.bearer)}`);
    await new Promise<void>((resolve,reject) => { ws!.once('open',resolve);ws!.once('error',reject); });
    const reviewed = await rpc(ws,'packs.removal.review',{ ...f.request(first.catalog),publisher: first.owner.publisher });
    expect(reviewed.error).toBeUndefined();const plan = reviewed.result as PackRemovalPlan;
    expect(plan.protection).toEqual({ roots: [first.catalog],release_history: true });
    const result = await rpc(ws,'packs.removal.apply',{ review_id: plan.review_id,request_id: crypto.randomUUID() });
    expect(result.error).toBeUndefined();expect((result.result as PackRemovalApplyResult).receipt.result.ok).toBe(true);
    expect(f.db.prepare('SELECT deleted FROM pack_update_tracks WHERE pack_slug=?').pluck().get(first.catalog)).toBe(1);
    expect(f.db.prepare('SELECT 1 FROM pack_release_history WHERE pack_slug=?').get(first.catalog)).toBeUndefined();
    expect(f.db.prepare('SELECT deleted FROM pack_update_tracks WHERE pack_slug=?').pluck().get(second.catalog)).toBe(0);
    expect(f.db.prepare('SELECT 1 FROM pack_release_history WHERE pack_slug=?').get(second.catalog)).toBeDefined();
    expect(second.records.getNamespace(second.owner)?.state.state).toBe('ready');
  } finally { ws?.terminate();await server.close();f.close(); }
},20000);
