import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntimeConfigStore } from '@recued/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBootTrace } from '../cli/boot-trace.js';
import { composeAppContext } from '../serve/compose-app-context.js';
import { composeCollectionContext } from '../serve/compose-collection-context.js';
import { composeStorageContext } from '../serve/compose-storage-context.js';
import { createVaultStateBus } from '../vault-state-bus.js';
import { createServerTimeZoneStore } from '../storage/server-timezone-store.js';
import { wallClockAt } from '@recued/contracts';

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
          getScheduleDeps: () => undefined,
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
        mailFactStore: storageContext.mailFactStoreRef,
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
      expect(context.collectionRegistry).toBeDefined();
      expect(context.watcherDispatcher).toBeDefined();
      expect(context.notificationDeps).toBeDefined();
      expect(context.notificationHandler).toBeDefined();
      expect(Object.keys(context.channelDispatchers ?? {})).toEqual(
        expect.arrayContaining(['email', 'in_app']),
      );
      expect(context.workEntityDispatchers).toBeDefined();
      expect(context.oauthClientConfigDeps.getClientId('gmail')).toBeNull();

      // The webhook watcher and its queue were retired 2026-10-05 (D-201
      // webhook triggers replace them): the context composes neither.
      expect(context).not.toHaveProperty('webhookWatcherQueue');

      // D-269 (2026-10-05) — the composed watcher reads a time window on the
      // owner's DECLARED zone, as the cron schedules do, not on this process's.
      // UTC+14 is at least 3 hours from any host this runs on, so a two-hour
      // window around its hour holds there and not on the host's clock.
      createServerTimeZoneStore(storageContext.db).write('fixed', 'Pacific/Kiritimati', Date.now());
      const declared = wallClockAt(Date.now(), 'Pacific/Kiritimati');
      const host = wallClockAt(Date.now());
      const around = (at: { day: number; hour: number }) => ({
        weekdays: [at.day, (at.day + 1) % 7], start_hour: at.hour, end_hour: (at.hour + 2) % 24,
      });
      await expect(context.watcherDispatcher({ slug: 'time-watcher', args: around(declared) }))
        .resolves.toMatchObject({ should_run: true });
      await expect(context.watcherDispatcher({ slug: 'time-watcher', args: around(host) }))
        .resolves.toMatchObject({ should_run: false });

      await expect(context.startCollectionAdapters()).resolves.toBeUndefined();
    } finally {
      storageContext.db.close();
    }
  });

  // ⛔ THE WIRING, NOT THE ACTION. `calendar-compose.test.ts` calls
  // `stack.resumeSync()` directly and `vault-state-bus.ts` is tested on its own —
  // both pass with the subscribe block in `startCollectionAdapters` DELETED,
  // while mail and calendar then silently never sync after a locked boot. The
  // deferral is only safe because something re-arms it; nothing proved anything
  // did. These two go through the real `composeCollectionContext` and a real
  // `createVaultStateBus`, and assert the edge reaches the stacks.
  //
  // ⚠ The stacks' own resume/pause are replaced AFTER `startCollectionAdapters`
  // (which is where the subscription is registered) and BEFORE the emit. The
  // listener resolves `.resumeSync` on the stack object at call time, and
  // `context.calendarStack` is that same object, so a substituted method is
  // what the real listener reaches. Deliberately NOT asserting what
  // resume/pauseSync then do — that is `vault-gated-sync.ts`'s contract and is
  // covered where it lives.
  const composeWithVaultBus = async (): Promise<{
    context: ReturnType<typeof composeCollectionContext>;
    vaultStateBus: ReturnType<typeof createVaultStateBus>;
    close: () => void;
  }> => {
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
      vaultQuotas: { perPublisherBytes: 1_234_000, totalBytes: 5_678_000 },
    });
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
        getScheduleDeps: () => undefined,
      },
    });
    const vaultStateBus = createVaultStateBus();
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
      mailFactStore: storageContext.mailFactStoreRef,
      gateRegistry: storageContext.gateRegistry,
      accountStore: storageContext.accountStore,
      eventBus: storageContext.eventBus,
      keys: app.keys,
      vaultStateBus,
      connectionStore: app.connectionStoreRef,
      workEntityStore: storageContext.workEntityStoreRef,
      enrichmentCascade: app.enrichmentCascadeRef,
    });
    return { context, vaultStateBus, close: () => storageContext.db.close() };
  };

  it('the vault→unlocked edge reaches mail + calendar resumeSync', async () => {
    const { context, vaultStateBus, close } = await composeWithVaultBus();
    try {
      await context.startCollectionAdapters();

      const calendarResume = vi.fn(async () => {});
      const mailResume = vi.fn(async () => {});
      context.calendarStack!.resumeSync = calendarResume;
      context.mailStack!.resumeSync = mailResume;

      vaultStateBus.emit('unlocked', 'locked');

      expect(calendarResume).toHaveBeenCalledTimes(1);
      expect(mailResume).toHaveBeenCalledTimes(1);
    } finally {
      close();
    }
  });

  it('the vault→locked edge reaches mail + calendar pauseSync', async () => {
    const { context, vaultStateBus, close } = await composeWithVaultBus();
    try {
      await context.startCollectionAdapters();

      const calendarPause = vi.fn(async () => {});
      const mailPause = vi.fn(async () => {});
      context.calendarStack!.pauseSync = calendarPause;
      context.mailStack!.pauseSync = mailPause;

      // Non-'unlocked' is the pause branch — an auto-lock mid-life must stop
      // polling before the next tick can drop a CAS item (D-117).
      vaultStateBus.emit('locked', 'unlocked');

      expect(calendarPause).toHaveBeenCalledTimes(1);
      expect(mailPause).toHaveBeenCalledTimes(1);
    } finally {
      close();
    }
  });

  it('keeps collection context out of executor, listener, scheduler, lifecycle, and MCP imports', () => {
    const source = readFileSync(collectionContextPath, 'utf8');

    expect(source).toMatch(/composeCalendarBoot/);
    expect(source).toMatch(/composeMailBoot/);
    expect(source).toMatch(/composeServiceBoot/);
    expect(source).toMatch(/createCollectionRegistry/);
    expect(source).toMatch(/createWatcherDispatcher/);
    expect(source).toMatch(/composeConnectionNotification/);
    expect(source).toMatch(/createWorkEntityDispatchers/);
    expect(source).toMatch(/oauthClientConfigDeps/);
    expect(source).not.toMatch(/composeExecutorConfig|composeExecuteDeps|handleExecute/);
    expect(source).not.toMatch(/createServerHandlerSet|path-listener|listener-coordinator|composeWebhookListeners/);
    expect(source).not.toMatch(/composeSchedulers|composeHousekeepingScheduler|background-services/);
    expect(source).not.toMatch(/mcp-server|wire-mcp-http-transport/);
    expect(source).not.toMatch(/createLifecycle|LockHeldError|process\.on/);
  });
});
