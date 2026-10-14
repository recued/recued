/** D-322 — production composition, encrypted disk reopen and recipe dispatch. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRuntimeConfigStore } from '@recued/config';
import type { IngredientManifest, ManagedOAuthRequest, RecipeDefinition } from '@recued/contracts';
import { generateRecoveryKey } from '@recued/crypto';
import { executeRecipe } from '@recued/engine';
import { describe, expect, it } from 'vitest';

import { createBootTrace } from '../cli/boot-trace.js';
import { makeConnectionHandlers } from '../connection-handler.js';
import { bootServerIdentity } from '../identity/boot.js';
import { createServerExecutor } from '../server-executor.js';
import { enrollServerVaultFromRecoveryKey } from '../server-vault-enrollment.js';
import { composeAppContext } from '../serve/compose-app-context.js';
import { composeCollectionContext } from '../serve/compose-collection-context.js';
import { composeExecutionContext, createExecutionLateBoundRefs } from '../serve/compose-execution-context.js';
import { composeStorageContext } from '../serve/compose-storage-context.js';
import { createInstanceStore } from '../collections/instance-store.js';

const environmentKey = 'd322-fixture-environment-key';
const native = { spreadsheetId: 'fixture-id', sheets: [{ properties: { sheetId: 7 } }],
  values: [[null, false, 0, '=A1']], nextPageToken: 'native-page', vendorExtension: { untouched: true } };
const manifest: IngredientManifest = {
  slug: 'd322-native-metadata', name: 'Native metadata fixture', description: 'Read native metadata',
  author: 'fixture', version: 1, kind: 'connection', category: 'action', risk_tier: 'read',
  input: { connection_kind: 'api', connection: null, method: 'GET', path: '/spreadsheets/fixture-id' }, output: {},
};
const recipe: RecipeDefinition = {
  recipe_id: 'd322-native-recipe', version: 1, ttl: 0,
  metadata: { name: 'D-322 fixture', description: 'Exercise composed dispatch', author: 'fixture', supported_platforms: [] },
  variables: {}, prefetch_steps: [],
  steps: [{ id: 'metadata', ingredient: manifest.slug, input: {
    connection: 'sheets', 'query.fields': ['spreadsheetId', 'sheets'],
  } }],
  output: { render: [] },
};

const reply = (response: ServerResponse, value: unknown, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
};
const readBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
};

const fakeBroker = async () => {
  let origin = ''; let tags: unknown; let authorized = false; let sessions = 0;
  let proxyStatus = 200;
  const proxyRequests: { path: string; account: string | undefined; integration: string | undefined;
    target: string | undefined; retries: string | undefined }[] = [];
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url!, origin);
    if (url.pathname === '/authorize') { authorized = true; response.end('Fixture consent'); return; }
    if (request.headers.authorization !== `Bearer ${environmentKey}`) { reply(response, {}, 401); return; }
    if (url.pathname === '/integrations') {
      reply(response, { data: [{ unique_key: 'sheets-fixture', provider: 'google-sheet' }] }); return;
    }
    if (url.pathname === '/integrations/sheets-fixture') {
      reply(response, { data: { unique_key: 'sheets-fixture', provider: 'google-sheet',
        credentials: { type: 'OAUTH2', scopes: 'https://www.googleapis.com/auth/spreadsheets' } } }); return;
    }
    if (url.pathname === '/providers') {
      reply(response, { data: [{ name: 'google-sheet', auth_mode: 'OAUTH2' }] }); return;
    }
    if (url.pathname === '/connect/sessions') {
      sessions += 1; tags = (await readBody(request)).tags;
      reply(response, { data: { connect_link: `${origin}/authorize`,
        expires_at: new Date(Date.now() + 600_000).toISOString() } }, 201); return;
    }
    if (url.pathname === '/connections') {
      reply(response, { connections: authorized ? [{ connection_id: 'saved-account',
        provider_config_key: 'sheets-fixture', tags, errors: [] }] : [] }); return;
    }
    if (url.pathname.startsWith('/proxy/')) {
      proxyRequests.push({ path: request.url!, account: request.headers['connection-id'] as string | undefined,
        integration: request.headers['provider-config-key'] as string | undefined,
        target: request.headers['base-url-override'] as string | undefined,
        retries: request.headers.retries as string | undefined });
      reply(response, proxyStatus === 200 ? native : { error: { code: 'fixture-denial', native: true } }, proxyStatus);
      return;
    }
    reply(response, {}, 404);
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => reply(response, { fixture: 'invalid request' }, 500));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, proxyRequests, sessionCount: () => sessions, status: (value: number) => { proxyStatus = value; },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
};

const boot = async (dbPath: string) => {
  const runtimeConfig = createRuntimeConfigStore({});
  const storage = await composeStorageContext({ dbPath, runtimeConfig,
    bootTrace: createBootTrace({ entrypoint: 'serve-entry', profile: 'serve', command: 'serve', env: {} }),
    vaultQuotas: { perPublisherBytes: 1_000_000, totalBytes: 2_000_000 } });
  try {
    const lateBound = createExecutionLateBoundRefs();
    const app = composeAppContext({ db: storage.db, dbPath, envLlmConfig: storage.envLlmConfig,
      gateRegistry: storage.gateRegistry, auditLog: storage.auditLog, eventBus: storage.eventBus,
      serverInstanceId: storage.serverInstanceId, recipeStore: storage.recipeStore,
      pairedInstances: storage.pairedInstances, workEntityStore: storage.workEntityStoreRef, chatLateBound: lateBound });
    const collection = composeCollectionContext({ db: storage.db, dbPath, runtimeConfig,
      manifests: storage.manifests, baseVault: storage.baseVault, auditLog: storage.auditLog,
      cacheBlobs: app.cacheBlobs, warehouseBus: app.warehouseBus, contactStore: app.contactStoreRef,
      mailFactStore: storage.mailFactStoreRef, gateRegistry: storage.gateRegistry,
      accountStore: storage.accountStore, eventBus: storage.eventBus, keys: app.keys,
      connectionStore: app.connectionStoreRef, workEntityStore: storage.workEntityStoreRef,
      enrichmentCascade: app.enrichmentCascadeRef });
    const execution = await composeExecutionContext({ storage, app, collection,
      baseVault: storage.baseVault, lateBound, env: {} });
    storage.manifests.register(manifest);
    const handlers = makeConnectionHandlers({ store: app.connectionStoreRef!,
      getEncryptionKey: app.keys!.keyProvider('connection'), managedOAuth: app.managedOAuth! })!.handlers;
    return { storage, app, execution, handlers, executor: createServerExecutor(execution.executorConfig),
      rpc: (args: ManagedOAuthRequest) => handlers['collection.connection.managedOAuth'](args, undefined as never),
      close: () => { app.keys!.lock(); storage.db.close(); } };
  } catch (error) { storage.db.close(); throw error; }
};

const runMetadata = async (composed: Awaited<ReturnType<typeof boot>>) => {
  const stores = { vault: {}, config: {}, context: {}, meta: {}, step: {} };
  const result = await executeRecipe({ recipe, stores, ingredientExecutor: composed.executor });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(stores.step).toMatchObject({ metadata: { status: 200, result: native } });
  expect(stores.step).toHaveProperty('metadata.result', native);
};

describe('D-322 production composition and saved-account lifetime', () => {
  it('uses saved encrypted broker credentials after disk reopen and unlock without new consent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-d322-composition-'));
    const dbPath = join(dir, 'server.sqlite');
    const broker = await fakeBroker();
    let composed: Awaited<ReturnType<typeof boot>> | undefined;
    let serverKey: Uint8Array | undefined;
    try {
      composed = await boot(dbPath);
      expect(composed.app.keys!.state()).toBe('uninitialized');
      // Compose before enrollment: production ports must consult live key providers.
      const identity = await bootServerIdentity({ dbPath, passphrase: null, machineSealing: false });
      await enrollServerVaultFromRecoveryKey({ keys: composed.app.keys!, keyStore: identity.keyStore,
        recoveryKey: generateRecoveryKey().mnemonic, database: composed.storage.db });
      serverKey = identity.keyStore.loadServerVaultKey()!;
      const saved = await composed.rpc({ action: 'save_profile', broker: 'nango', label: 'Fixture broker',
        base_url: broker.origin, api_key: environmentKey });
      if (saved.action !== 'save_profile') throw new Error('Profile fixture missing');
      const startArgs = { action: 'start' as const, profile_id: saved.profile.id,
        integration_id: 'sheets-fixture', base_url: 'https://sheets.googleapis.com/v4', scopes: [] };
      const preview = await composed.rpc({ ...startArgs, action: 'preview' });
      if (preview.action !== 'preview') throw new Error('Permission preview fixture missing');
      expect(preview.preview).toMatchObject({ decision: 'authorize', requested_scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
      expect(broker.sessionCount()).toBe(0); expect(composed.app.connectionStoreRef!.list()).toEqual([]);
      expect(JSON.stringify(preview)).not.toContain(environmentKey);
      const start = await composed.rpc({ ...startArgs, preview_fingerprint: preview.preview.fingerprint });
      if (start.action !== 'start') throw new Error('Consent fixture missing');
      await fetch(start.connect_link);
      const complete = await composed.rpc({ action: 'status', flow_id: start.flow_id, claim_secret: start.claim_secret });
      if (complete.action !== 'status' || !complete.auth) throw new Error('Receipt fixture missing');
      await composed.handlers['collection.connection.enroll']({ kind: 'api', name: 'sheets', display_name: 'Sheets',
        config: { vendor: 'google', base_url: 'https://sheets.googleapis.com/v4' }, auth: complete.auth }, undefined as never);
      const before = composed.app.connectionStoreRef!.get('api', 'sheets')!;
      const instances = createInstanceStore({ db: composed.storage.db });
      for (const platform of ['mail', 'calendar'] as const) instances.upsert({ platform, slug: `fixture-${platform}`,
        adapter_type: 'fixture', config: { managed_oauth: { connection_name: 'sheets' }, secret: 'fixture-secret-no-proj' },
        caps: { read: 'yes', write: 'no', delete: 'no', watch: 'poll', mirror: 'disabled', auth: 'oauth', path_style: 'uri' },
        auth_state: 'healthy', last_synced_at: null });
      composed.app.contractGrantStoreRef!.grantPackGroup('fixture-pack', 'fixture-catalog', 'sheets', 'read');
      const usage = await composed.rpc({ action: 'account_usage', profile_id: saved.profile.id,
        integration_id: 'sheets-fixture', connection_id: 'saved-account' });
      if (usage.action !== 'account_usage') throw new Error('Usage fixture missing');
      expect(usage.usage.connections).toHaveLength(1);
      // This fixture composes execution, without maintenance's schedule store.
      // The known source bindings remain visible; the expanded usage read is incomplete.
      expect(usage.usage.connections[0]).toMatchObject({ name: 'sheets', usage_available: false, uses: [
        { kind: 'calendar', id: 'fixture-calendar' }, { kind: 'file', id: 'google.sheets.file' },
        { kind: 'mail', id: 'fixture-mail' }, { kind: 'pack', id: 'fixture-pack' },
      ] });
      expect(JSON.stringify(usage)).not.toContain('fixture-secret-no-proj');
      expect(broker.sessionCount()).toBe(1);
      await runMetadata(composed);
      expect(broker.proxyRequests).toEqual([{ path: '/proxy/v4/spreadsheets/fixture-id?fields=spreadsheetId&fields=sheets',
        account: 'saved-account', integration: 'sheets-fixture', target: 'https://sheets.googleapis.com', retries: '0' }]);
      const pending = await composed.rpc(startArgs);
      if (pending.action !== 'start') throw new Error('Pending fixture missing');
      const sessions = broker.sessionCount();
      composed.close(); composed = undefined;
      const disk = readFileSync(dbPath);
      expect(disk.subarray(0, 16).toString()).not.toBe('SQLite format 3\0');
      expect(disk.includes(Buffer.from(environmentKey))).toBe(false);

      composed = await boot(dbPath);
      expect(composed.app.keys!.state()).toBe('locked');
      expect(composed.app.connectionStoreRef!.get('api', 'sheets')).toEqual(before);
      expect(await composed.rpc({ action: 'status', flow_id: pending.flow_id, claim_secret: pending.claim_secret }))
        .toMatchObject({ status: 'expired' });
      const proxyCount = broker.proxyRequests.length;
      await expect(composed.executor(manifest.slug, { connection: 'sheets' })).rejects.toMatchObject({ code: 'locked' });
      expect(broker.proxyRequests).toHaveLength(proxyCount);
      await composed.app.keys!.unlockWithServerKey({ serverKey });
      await runMetadata(composed);
      expect(broker.proxyRequests).toHaveLength(proxyCount + 1);
      expect(broker.proxyRequests.at(-1)).toEqual(broker.proxyRequests[0]);
      expect(broker.sessionCount()).toBe(sessions);
      expect(await composed.rpc({ action: 'profiles' })).toMatchObject({ profiles: [{ id: saved.profile.id }] });
      expect(JSON.stringify(await composed.rpc({ action: 'profiles' }))).not.toContain(environmentKey);

      broker.status(403);
      await expect(composed.executor(manifest.slug, { connection: 'sheets' })).rejects.toMatchObject({ code: 'OAUTH_EXPIRED' });
      expect(broker.proxyRequests).toHaveLength(proxyCount + 2);
      composed.storage.manifests.register({ ...manifest, slug: 'd322-fixture-write', risk_tier: 'write',
        input: { ...manifest.input, method: 'POST' } });
      broker.status(503);
      await expect(composed.executor('d322-fixture-write', { connection: 'sheets', body_raw: '{}' }))
        .rejects.toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
      expect(broker.proxyRequests).toHaveLength(proxyCount + 3);
      expect(broker.proxyRequests.at(-1)?.retries).toBe('0');
      expect(composed.app.connectionStoreRef!.get('api', 'sheets')).toEqual(before);
    } finally {
      composed?.close();
      serverKey?.fill(0);
      await broker.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
