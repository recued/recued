import { expect,it,vi } from 'vitest';
import WebSocket from 'ws';
import type { PackUpdateView } from '@recued/contracts';
import { startServer } from '../server.js';
import { packUpdatePlanFixture } from './pack-update-plan-fixture.js';
import { getInstalledPack } from '../pack-inventory.js';

interface Reply { request_id: string; result?: unknown; error?: { code: string; message: string } }
const rpc = (ws: WebSocket,method: string,args: unknown): Promise<Reply> => new Promise((resolve,reject) => {
  const request_id = crypto.randomUUID(), timeout = setTimeout(() => { ws.off('message',receive); reject(new Error('Restore RPC timeout')); },8000);
  const receive = (data: WebSocket.RawData): void => { const reply = JSON.parse(data.toString()) as Reply;
    if (reply.request_id === request_id) { clearTimeout(timeout); ws.off('message',receive); resolve(reply); } };
  ws.on('message',receive); ws.send(JSON.stringify({ type: 'rpc',request_id,method,args }));
});
it('uses the paired owner boundary for retained release staging, fresh tests and exact restore receipts',async () => {
  const f = await packUpdatePlanFixture(), first = await f.apply(await f.ready());
  f.manifest.version++; f.dependency.version++; f.dependencyCandidate.version++; f.dependency.recipes[0]!.version++;
  f.candidates.forEach((recipe,index) => { recipe.version++; f.manifest.recipes[index]!.version++; });
  f.manifest.dependencies![0]!.min_version = f.dependency.version; f.putManifest(); f.putDependency();
  await f.stage(f.request(1)); const tested = await f.qualify();
  await f.apply({ pack_slug: f.manifest.slug,expected_revision: 2,review_id: tested.qualification!.review_id,request_id: crypto.randomUUID() });
  f.deps.marketplaceFetch = vi.fn(async () => { throw new Error('A restore must not fetch remote artifacts'); });
  const server = await startServer(0,{ clientTokens: f.clients,packInstallDeps: f.deps,
    recipeRegressionDeps: { store: f.store,clientTokens: f.clients },packUpdateDeps: { store: f.updates,suites: f.store,clientTokens: f.clients } });
  const sockets: WebSocket[] = [];
  const connect = async (kind: 'webclient' | 'cli',instance?: string) => {
    const token = await f.clients.issue({ client_kind: kind,...(instance ? { metadata: { instance_id: instance } } : {}) });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${encodeURIComponent(token.token_id + '.' + token.bearer)}`); sockets.push(ws);
    await new Promise<void>((resolve,reject) => { ws.once('open',resolve); ws.once('error',reject); }); return ws;
  };
  try {
    const owner = await connect('webclient','owner'), other = await connect('webclient','other'), cli = await connect('cli');
    const stage = { pack_slug: f.manifest.slug,release_id: first.receipt.release_id!,expected_revision: 2,request_id: crypto.randomUUID() };
    expect(await rpc(cli,'packs.update.restore',stage)).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await rpc(owner,'packs.update.restore',{ ...stage,target: f.manifest })).toMatchObject({ error: { code: 'bad_request' } });
    expect(await rpc(owner,'packs.update.restore',{ ...stage,expected_revision: 1 })).toMatchObject({ error: { code: 'pack_update_conflict' } });
    const staged = await rpc(owner,'packs.update.restore',stage); expect(staged.error).toBeUndefined(); expect((staged.result as PackUpdateView).candidate!.restore!.release_id).toBe(stage.release_id);
    expect((await rpc(owner,'packs.update.restore',stage)).result).toEqual(staged.result);
    const request = { pack_slug: f.manifest.slug,expected_revision: 3,review_id: 'old-proof',request_id: crypto.randomUUID() };
    expect(await rpc(owner,'packs.update.apply',request)).toMatchObject({ error: { code: 'pack_update_conflict' } });
    const result = await rpc(owner,'packs.update.test',{ pack_slug: f.manifest.slug,expected_revision: 3,run_id: 'restore-tests' });
    expect(result.error).toBeUndefined(); request.review_id = (result.result as PackUpdateView).qualification!.review_id;
    const applied = await rpc(owner,'packs.update.apply',request); expect(applied.error).toBeUndefined(); expect(applied.result).toMatchObject({ applied: true,receipt: { restored_release_id: stage.release_id } });
    expect((await rpc(owner,'packs.update.apply',request)).result).toEqual(applied.result);
    expect(await rpc(other,'packs.update.apply',request)).toMatchObject({ error: { code: 'pack_update_conflict' } });
    expect(getInstalledPack(f.contracts,f.manifest.slug)!.version).toBe(2); expect(getInstalledPack(f.contracts,f.dependency.slug)!.version).toBe(3);
    expect((applied.result as PackUpdateView).releases).toHaveLength(3); expect(f.deps.marketplaceFetch).not.toHaveBeenCalled();
  } finally { for (const ws of sockets) ws.terminate(); await server.close(); f.close(); }
},20000);
