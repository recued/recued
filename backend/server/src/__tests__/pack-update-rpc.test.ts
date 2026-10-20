import { expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import type { PackUpdateView } from '@recued/contracts';
import { startServer } from '../server.js';
import { makePackUpdateHandlers } from '../pack-update-handler.js';
import { makeRecipeRegressionHandlers } from '../recipe-regression-handler.js';
import type { WsClient } from '../ws-server.js';
import { packUpdateFixture } from './pack-update-fixture.js';
import { packUpdatePlanFixture } from './pack-update-plan-fixture.js';
import { getInstalledPack } from '../pack-inventory.js';

interface Reply { request_id: string; result?: unknown; error?: { code: string; message: string } }
const rpc = (ws: WebSocket,method: string,args: unknown): Promise<Reply> => new Promise((resolve,reject) => {
  const request_id = crypto.randomUUID(), timeout = setTimeout(() => { ws.off('message',receive); reject(new Error('Update RPC timeout: ' + method)); },8000);
  const receive = (data: WebSocket.RawData): void => { const reply = JSON.parse(data.toString()) as Reply;
    if (reply.request_id === request_id) { clearTimeout(timeout); ws.off('message',receive); resolve(reply); } };
  ws.on('message',receive); ws.send(JSON.stringify({ type: 'rpc',request_id,method,args }));
});
it('wires paired-only staging and whole-pack tests into the real install and uninstall RPCs',async () => {
  const f = await packUpdateFixture();
  const updateDeps = { store: f.updates,suites: f.store,clientTokens: f.clients };
  const server = await startServer(0,{ clientTokens: f.clients,packInstallDeps: f.deps,
    recipeListDeps: { store: f.recipes,serverStartedAt: 0 },recipeSaveDeps: { store: f.recipes },
    packUninstallDeps: { recipeStore: f.recipes,contractStore: f.contracts,packDir: f.deps.packDir },
    recipeRegressionDeps: { store: f.store,clientTokens: f.clients },packUpdateDeps: updateDeps });
  const sockets: WebSocket[] = [];
  const connect = async (kind: 'webclient' | 'cli',instance?: string) => {
    const token = await f.clients.issue({ client_kind: kind,...(instance ? { metadata: { instance_id: instance } } : {}) });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${encodeURIComponent(token.token_id + '.' + token.bearer)}`); sockets.push(ws);
    await new Promise<void>((resolve,reject) => { ws.once('open',resolve); ws.once('error',reject); }); return ws;
  };
  try {
    const owner = await connect('webclient','owner'), cli = await connect('cli');
    for (const method of ['get','stage','test','apply','release']) expect(await rpc(cli,'packs.update.' + method,{})).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await rpc(owner,'packs.update.get',{ pack_slug: f.manifest.slug,proof: true })).toMatchObject({ error: { code: 'bad_request' } });
    const request = f.request();
    expect(await rpc(owner,'packs.update.stage',request)).toMatchObject({ result: { managed: true,revision: 1 } });
    expect(await rpc(owner,'packs.install',{ manifest: f.manifest,granted_permissions: ['install_bulk_pack'] })).toMatchObject({ error: { code: 'pack_update_required' } });
    const tested = await rpc(owner,'packs.update.test',{ pack_slug: f.manifest.slug,expected_revision: 1,run_id: 'whole-pack' });
    expect(tested.error).toBeUndefined(); const proof = (tested.result as PackUpdateView).qualification!; expect(proof.passed).toBe(2);
    expect(await rpc(cli,'packs.install',{ manifest: f.manifest,granted_permissions: ['install_bulk_pack'],regression_review_id: proof.review_id })).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await rpc(owner,'packs.install',{ manifest: f.manifest,granted_permissions: ['install_bulk_pack'],regression_review_id: proof.review_id })).toMatchObject({ result: { result: { ok: true } } });
    expect(await rpc(owner,'packs.update.get',{ pack_slug: f.manifest.slug })).toMatchObject({ result: { applied: true,qualification: null } });
    expect(await rpc(owner,'packs.uninstall',{ pack_slug: f.manifest.slug })).toMatchObject({ result: { result: { ok: true } } });
    expect(f.updates.managed(f.manifest.slug)).toBe(false);
  } finally { for (const ws of sockets) ws.terminate(); await server.close(); f.close(); }
},20000);

it('cancels before private draft loading finishes and invalidates previous passing proof',async () => {
  const f = await packUpdateFixture(); await f.stage();
  const token = await f.clients.issue({ client_kind: 'webclient',metadata: { instance_id: 'owner' } });
  const ws = new EventEmitter(), client: WsClient = { ws,realm: 'realm',instance_id: 'owner',token_instance_id: 'owner',client_token_id: token.token_id,client_kind: 'webclient',display_name: 'Owner',connected_at: 1 };
  const runner = makeRecipeRegressionHandlers({ store: f.store,clientTokens: f.clients });
  const handlers = makePackUpdateHandlers({ store: f.updates,suites: f.store,clientTokens: f.clients },f.deps,runner).handlers;
  let release: (() => void) | undefined;
  const open = f.codec.open.bind(f.codec);
  try {
    expect((await handlers['packs.update.test']({ pack_slug: f.manifest.slug,expected_revision: 1,run_id: 'passing' },client)).qualification).not.toBeNull();
    vi.spyOn(f.codec,'open').mockImplementationOnce(async value => { const material = await open(value); await new Promise<void>(resolve => { release = resolve; }); return material; });
    const pending = handlers['packs.update.test']({ pack_slug: f.manifest.slug,expected_revision: 1,run_id: 'cancelled' },client);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(await runner.handlers['recipe.regression.cancel']({ run_id: 'cancelled' },{ ...client,ws: new EventEmitter() })).toEqual({ cancelled: false });
    expect(await runner.handlers['recipe.regression.cancel']({ run_id: 'cancelled' },client)).toEqual({ cancelled: true });
    release!(); await rejected; expect(ws.listenerCount('close')).toBe(0); vi.restoreAllMocks();
    const actor = JSON.stringify([token.token_id,'owner']); expect((await f.updates.read(f.manifest.slug,actor,() => {})).qualification).toBeNull();
    await f.store.remove({ recipe_id: f.active[1]!.recipe_id,expected_revision: 1,request_id: crypto.randomUUID() },() => {});
    await expect(handlers['packs.update.test']({ pack_slug: f.manifest.slug,expected_revision: 1,run_id: 'missing-suite' },client)).rejects.toMatchObject({ code: 'not_found' });
  } finally { release?.(); vi.restoreAllMocks(); f.close(); }
});

it('tests and atomically applies a dependency group through the paired RPC, with a durable exact retry',async () => {
  const f = await packUpdatePlanFixture();
  const server = await startServer(0,{ clientTokens: f.clients,packInstallDeps: f.deps,
    recipeRegressionDeps: { store: f.store,clientTokens: f.clients },
    packUpdateDeps: { store: f.updates,suites: f.store,clientTokens: f.clients } });
  const sockets: WebSocket[] = [];
  const connect = async (kind: 'webclient' | 'cli',instance: string) => {
    const token = await f.clients.issue({ client_kind: kind,metadata: { instance_id: instance } });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${encodeURIComponent(token.token_id + '.' + token.bearer)}`); sockets.push(ws);
    await new Promise<void>((resolve,reject) => { ws.once('open',resolve); ws.once('error',reject); }); return ws;
  };
  try {
    const owner = await connect('webclient','graph-owner'), other = await connect('webclient','other-owner'), cli = await connect('cli','cli');
    const { include_dependencies: _include,...legacyStage } = f.request();
    expect(await rpc(owner,'packs.update.stage',legacyStage)).toMatchObject({ error: { code: 'pack_update_unsupported' } });
    expect(await rpc(owner,'packs.update.stage',{ ...f.request(),include_dependencies: true })).toMatchObject({ result: { candidate: { packs: expect.any(Array) } } });
    expect(await rpc(cli,'packs.update.apply',{})).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await rpc(owner,'packs.update.apply',{ pack_slug: f.manifest.slug,expected_revision: 1,review_id: 'fake',request_id: 'fake' }))
      .toMatchObject({ error: { code: 'pack_update_conflict' } });
    const tested = await rpc(owner,'packs.update.test',{ pack_slug: f.manifest.slug,expected_revision: 1,run_id: 'dependency-batch' });
    expect(tested.error).toBeUndefined(); const view = tested.result as PackUpdateView; expect(view.qualification!.passed).toBe(3);
    const request = { pack_slug: f.manifest.slug,expected_revision: 1,review_id: view.qualification!.review_id,request_id: crypto.randomUUID() };
    expect(await rpc(other,'packs.update.apply',request)).toMatchObject({ error: { code: 'pack_update_conflict' } });
    expect(await rpc(owner,'packs.update.apply',{ ...request,permit: {} })).toMatchObject({ error: { code: 'bad_request' } });
    const applied = await rpc(owner,'packs.update.apply',request); expect(applied.error).toBeUndefined();
    expect(applied).toMatchObject({ result: { applied: true,receipt: { request_id: request.request_id,packs: [{ pack_slug: f.dependency.slug,version: 3 },{ pack_slug: f.manifest.slug,version: 2 }] } } });
    expect(await rpc(owner,'packs.update.apply',request)).toEqual(expect.objectContaining({ result: applied.result }));
    expect(await rpc(other,'packs.update.apply',request)).toMatchObject({ error: { code: 'pack_update_conflict' } });
    expect(getInstalledPack(f.contracts,f.dependency.slug)!.version).toBe(3);
    expect(await rpc(owner,'packs.update.release',{ pack_slug: f.manifest.slug,expected_revision: 1,request_id: crypto.randomUUID() }))
      .toMatchObject({ result: { managed: true,revision: 2,candidate: null } });
    expect(getInstalledPack(f.contracts,f.dependency.slug)!.version).toBe(3);
  } finally { for (const ws of sockets) ws.terminate(); await server.close(); f.close(); }
},20000);
