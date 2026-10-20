import { RpcError, regressionObject, regressionText, regressionBytes,
  type HandlerSlice, type ServerRpcRegistry, type PackUpdateStage } from '@recued/contracts';
import type { WsClient } from './ws-server.js';
import type { ClientTokenStore } from './pairing/client-tokens.js';
import type { RecipeRegressionRunner } from './recipe-regression-handler.js';
import type { RecipeRegressionStore } from './storage/recipe-regression-store.js';
import type { PackUpdateStore } from './storage/pack-update-store.js';
import { preparePackUpdate, preparePackRestore, type PackInstallRpcDeps } from './pack-install-handler.js';
import { writePackUpdateGroup } from './pack-update-plan.js';
import { recordsManifestReviewHash } from './records/index.js';

export interface PackUpdateDeps {
  store: PackUpdateStore; suites: RecipeRegressionStore; clientTokens: Pick<ClientTokenStore,'get'>;
}
export const packUpdateOwner = (deps: Pick<PackUpdateDeps,'clientTokens'>, client: WsClient): { actor: string; check(): void } => {
  const check = (): void => {
    const token = client.client_token_id ? deps.clientTokens.get(client.client_token_id) : null;
    const instance = client.token_instance_id ?? client.instance_id;
    if (client.client_kind !== 'webclient' || !token || token.client_kind !== 'webclient' || token.revoked_at !== null
      || !instance || token.metadata?.instance_id !== instance) throw new RpcError('unauthorized','Use the paired webclient to review pack updates.',403);
  };
  check(); return { actor: JSON.stringify([client.client_token_id,client.token_instance_id ?? client.instance_id]),check };
};
const revision = (raw: unknown): number => {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || raw >= Number.MAX_SAFE_INTEGER) throw new RpcError('bad_request','Provide a valid update revision.',400);
  return raw;
};
const identifier = (raw: unknown): string => {
  const value = regressionText(raw,'an identifier',200);
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new RpcError('bad_request','Invalid update identifier.',400);
  return value;
};
type Methods = 'packs.update.get' | 'packs.update.stage' | 'packs.update.test' | 'packs.update.apply' | 'packs.update.release' | 'packs.update.restore';
export const makePackUpdateHandlers = (deps: PackUpdateDeps | undefined, install: PackInstallRpcDeps | undefined,
  runner: RecipeRegressionRunner): HandlerSlice<ServerRpcRegistry,Methods,WsClient> => {
  const owner = (client: WsClient) => {
    if (!deps || !install) throw new RpcError('not_configured','Reviewed pack updates are unavailable on this server.',503);
    return { current: deps,install, ...packUpdateOwner(deps,client) };
  };
  const input = (raw: unknown, fields: string[]): Record<string,unknown> => {
    if (regressionBytes(raw) > 4096) throw new RpcError('bad_request','Keep update requests under 4 KB.',400);
    return regressionObject(raw,fields);
  };
  return { methods: ['packs.update.get','packs.update.stage','packs.update.test','packs.update.apply','packs.update.release','packs.update.restore'],handlers: {
    'packs.update.get': async (raw,client) => {
      const { current,actor,check } = owner(client), value = input(raw,['pack_slug']);
      return current.store.read(identifier(value.pack_slug),actor,check);
    },
    'packs.update.stage': async (raw,client) => {
      const { current,install,actor,check } = owner(client), value = input(raw,['pack_slug','source','expected_revision','expected_manifest_hash','request_id','include_dependencies']);
      if (value.source !== 'bundled' && value.source !== 'marketplace') throw new RpcError('bad_request','Choose a bundled or marketplace update.',400);
      if (value.include_dependencies !== undefined && typeof value.include_dependencies !== 'boolean') throw new RpcError('bad_request','Choose whether to include required dependency upgrades.',400);
      const hash = regressionText(value.expected_manifest_hash,'the reviewed manifest hash',64);
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new RpcError('bad_request','Refresh the pack manifest review.',400);
      const request: PackUpdateStage = { pack_slug: identifier(value.pack_slug),source: value.source,expected_revision: revision(value.expected_revision),
        expected_manifest_hash: hash,request_id: identifier(value.request_id),
        ...(value.include_dependencies !== undefined ? { include_dependencies: value.include_dependencies } : {}) };
      return current.store.stage(request,actor,check,() => preparePackUpdate(install,request.pack_slug,request.source,hash,{ includeDependencies: request.include_dependencies }));
    },
    'packs.update.restore': async (raw,client) => {
      const { current,install,actor,check } = owner(client), value = input(raw,['pack_slug','release_id','expected_revision','request_id']);
      return current.store.stageRestore({ pack_slug: identifier(value.pack_slug),release_id: identifier(value.release_id),
        expected_revision: revision(value.expected_revision),request_id: identifier(value.request_id) },actor,check,target => preparePackRestore(install,target));
    },
    'packs.update.test': async (raw,client) => {
      const { current,actor } = owner(client), value = input(raw,['pack_slug','expected_revision','run_id']);
      const slug = identifier(value.pack_slug), expected = revision(value.expected_revision), run_id = identifier(value.run_id); let attempt = '';
      return runner.runBatchPrepared(run_id,client,async check => {
        const staged = await current.store.beginTest(slug,expected,check); attempt = staged.attempt;
        const requests = [];
        for (const entry of staged.recipes) {
          const suite = await current.suites.read(entry.slug,undefined,check); check();
          if (!suite.version) throw new RpcError('not_found',`Save recipe tests for ${entry.slug} in Kitchen before testing this update.`,404);
          requests.push({ recipe_id: entry.slug,revision: suite.version.revision,run_id,candidate: entry.recipe!.recipe });
        }
        return requests;
      },async (comparisons,check) => {
        const view = await current.store.qualify(slug,expected,attempt,comparisons,actor,check); check(); return { ...view,comparisons };
      });
    },
    'packs.update.release': async (raw,client) => {
      const { current,actor,check } = owner(client), value = input(raw,['pack_slug','expected_revision','request_id']);
      return current.store.releaseGroup({ pack_slug: identifier(value.pack_slug),expected_revision: revision(value.expected_revision),request_id: identifier(value.request_id) },actor,check);
    },
    'packs.update.apply': async (raw,client) => {
      const { current,install,actor,check } = owner(client), value = input(raw,['pack_slug','expected_revision','review_id','request_id']);
      const request = { pack_slug: identifier(value.pack_slug),expected_revision: revision(value.expected_revision),
        review_id: identifier(value.review_id),request_id: identifier(value.request_id) };
      return current.store.applyGroup(request,actor,check,
        async (target,restore) => restore ? preparePackRestore(install,target) : preparePackUpdate(install,target.manifest.slug,target.source,
          // The root manifest hash was already verified when the owner staged it.
          // Re-resolve the entire graph and compare all its exact bodies at apply.
          recordsManifestReviewHash(target.manifest),{ includeDependencies: true }),
        (target,permit,at) => writePackUpdateGroup(target,install,permit,at));
    },
  } };
};
