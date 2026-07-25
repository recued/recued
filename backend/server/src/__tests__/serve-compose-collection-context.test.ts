import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntimeConfigStore } from '@recued/config';
import { afterEach, describe, expect, it } from 'vitest';

import { createBootTrace } from '../cli/boot-trace.js';
import { composeAppContext } from '../serve/compose-app-context.js';
import { composeCollectionContext } from '../serve/compose-collection-context.js';
import { composeStorageContext } from '../serve/compose-storage-context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const collectionContextPath = join(
  repoRoot,
  'backend/server/src/serve/compose-collection-context.ts',
);

let tmp: string | undefined;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

const makeTmp = (): string => {
  tmp = mkdtempSync(join(tmpdir(), 'recued-serve-collection-'));
  return tmp;
};

describe('composeCollectionContext', () => {
  it('composes collection stacks, dispatchers, notification bridge, and work-entity dispatchers', async () => {
    const dir = makeTmp();
    const dbPath = join(dir, 'server.db');
    const runtimeConfig = createRuntimeConfigStore({});
    const storageContext = await composeStorageContext({
      dbPath,
      bootTrace: createBootTrace({
        entrypoint: 'serve-entry',
        profile: 'serve',
        command: 'serve',
        env: {},
      }),
      runtimeConfig,
      vaultQuotas: {
        perPublisherBytes: 1_234_000,
        totalBytes: 5_678_000,
      },
    });

    try {
      const app = composeAppContext({
        db: storageContext.db,
        dbPath,
        envLlmConfig: storageContext.envLlmConfig,
        gateRegistry: storageContext.gateRegistry,
        auditLog: storageContext.auditLog,
        eventBus: storageContext.eventBus,
        serverInstanceId: storageContext.serverInstanceId,
        recipeStore: storageContext.recipeStore,
        pairedInstances: storageContext.pairedInstances,
        workEntityStore: storageContext.workEntityStoreRef,
        chatLateBound: {
          getCollectionRegistry: () => undefined,
          getExecutorConfig: () => undefined,
          getExecuteDeps: () => undefined,
        },
      });

      const context = composeCollectionContext({
        db: storageContext.db,
        dbPath,
        runtimeConfig,
        manifests: storageContext.manifests,
        baseVault: storageContext.baseVault,
        auditLog: storageContext.auditLog,
        cacheBlobs: app.cacheBlobs,
        warehouseBus: app.warehouseBus,
        contactStore: app.contactStoreRef,
        gateRegistry: storageContext.gateRegistry,
        accountStore: storageContext.accountStore,
        eventBus: storageContext.eventBus,
        keys: app.keys,
        connectionStore: app.connectionStoreRef,
        workEntityStore: storageContext.workEntityStoreRef,
        enrichmentCascade: app.enrichmentCascadeRef,
      });

      expect(context.calendarStack).toBeDefined();
      expect(context.mailStack).toBeDefined();
      expect(context.serviceStack).toBeDefined();
      expect(context.webhookWatcherQueue).toBeDefined();
      expect(context.collectionRegistry).toBeDefined();
      expect(context.watcherDispatcher).toBeDefined();
      expect(context.notificationDeps).toBeDefined();
      expect(context.notificationHandler).toBeDefined();
      expect(Object.keys(context.channelDispatchers ?? {})).toEqual(
        expect.arrayContaining(['email', 'in_app']),
      );
      expect(context.workEntityDispatchers).toBeDefined();
      expect(context.oauthClientConfigDeps.getClientId('gmail')).toBeNull();

      context.webhookWatcherQueue.enqueue('recipe-1', 'deploy', {
        delivery_id: 'delivery-1',
        received_at: Date.now(),
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
        source_ip: '127.0.0.1',
      });
      const webhookResult = await context.watcherDispatcher({
        slug: 'webhook-watcher',
        args: { recipe_id: 'recipe-1', slug: 'deploy' },
      });
      expect(webhookResult).toMatchObject({
        should_run: true,
        queue_size: 0,
        requests: [
          {
            delivery_id: 'delivery-1',
            body: '{"ok":true}',
          },
        ],
      });

      await expect(context.startCollectionAdapters()).resolves.toBeUndefined();
    } finally {
      storageContext.db.close();
    }
  });

  it('keeps collection context out of executor, listener, scheduler, lifecycle, and MCP imports', () => {
    const source = readFileSync(collectionContextPath, 'utf8');

    expect(source).toMatch(/composeCalendarBoot/);
    expect(source).toMatch(/composeMailBoot/);
    expect(source).toMatch(/composeServiceBoot/);
    expect(source).toMatch(/createCollectionRegistry/);
    expect(source).toMatch(/createWatcherDispatcher/);
    expect(source).toMatch(/createWebhookWatcherQueue/);
    expect(source).toMatch(/composeConnectionNotification/);
    expect(source).toMatch(/createWorkEntityDispatchers/);
    expect(source).toMatch(/oauthClientConfigDeps/);
    expect(source).not.toMatch(/composeExecutorConfig|composeExecuteDeps|handleExecute/);
    expect(source).not.toMatch(/createServerHandlerSet|path-listener|listener-coordinator|composeWebhookAndHookListeners/);
    expect(source).not.toMatch(/composeSchedulers|composeHousekeepingScheduler|background-services/);
    expect(source).not.toMatch(/mcp-server|wire-mcp-http-transport/);
    expect(source).not.toMatch(/createLifecycle|LockHeldError|process\.on/);
  });
});
