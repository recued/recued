import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntimeConfigStore } from '@recued/config';
import { afterEach, describe, expect, it } from 'vitest';

import { createBootTrace } from '../cli/boot-trace.js';
import { composeAppContext } from '../serve/compose-app-context.js';
import { composeStorageContext } from '../serve/compose-storage-context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const appContextPath = join(repoRoot, 'backend/server/src/serve/compose-app-context.ts');

let tmp: string | undefined;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

const makeTmp = (): string => {
  tmp = mkdtempSync(join(tmpdir(), 'recued-serve-app-'));
  return tmp;
};

describe('composeAppContext', () => {
  it('composes server state, key/LLM deps, data stores, and chat substrate', async () => {
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

      expect(app.serverState).toBeDefined();
      expect(app.keys?.state()).toBe('uninitialized');
      expect(app.authDeps?.keys).toBe(app.keys);
      expect(app.bundleStoreRef).toBeDefined();
      expect(app.llmManager).toBeDefined();
      expect(app.llmQuota).toBeDefined();
      expect(app.llmAdapterRegistry).toBeDefined();
      expect(app.llmEmbeddingsAdapterRegistry).toBeDefined();
      await expect(app.emptyTabProbe()).resolves.toEqual(new Set());
      expect(app.cacheStore).toBeDefined();
      expect(app.cacheDeps?.store).toBe(app.cacheStore);
      expect(app.cacheDeps?.gate).toBe(storageContext.gateRegistry?.cache);
      expect(app.cacheBlobs).toBeDefined();
      // D-212 slice 4 — all production CAS roots are encrypted, while the
      // content-family root split keeps each orphan sweep's references isolated.
      expect(basename(app.cacheBlobs!.root)).toBe('cache_blobs');
      expect(app.cacheBlobs!.encrypted).toBe(true);
      expect(app.sharedBlobs).toBeDefined();
      expect(basename(app.sharedBlobs!.root)).toBe('blobs');
      expect(app.sharedBlobs!.encrypted).toBe(true);
      expect(app.cacheBlobs!.root).not.toBe(app.sharedBlobs!.root);
      expect(app.sharedStoreRef).toBeDefined();
      expect(app.sharedDeps?.store).toBe(app.sharedStoreRef);
      expect(app.annotationStoreRef).toBeDefined();
      expect(app.annotationDeps?.store).toBe(app.annotationStoreRef);
      expect(app.chatStoreRef).toBeDefined();
      expect(app.chatToolCatalogStoreRef).toBeDefined();
      expect(app.chatConnectionMcpStoreRef).toBeDefined();
      expect(app.chatInboundTokenStoreRef).toBeDefined();
      expect(app.chatOrchestratorRef).toBeDefined();
      expect(app.chatDeps).toBeDefined();
      expect(app.sellerClaimStoreRef).toBeDefined();
      expect(app.internalRegistryRef).toBeDefined();
      expect(app.warehouseBus).toBeDefined();
      expect(app.housekeepingConfigRef).toBeDefined();
      expect(app.housekeepingStateRef).toBeDefined();
      expect(app.housekeepingTrustRef).toBeDefined();
      expect(app.housekeepingTunableParamsRef).toBeDefined();
      expect(app.housekeepingLlmResultCacheRef).toBeDefined();
      expect(app.enrichmentStoreRef).toBeDefined();
      expect(app.enrichmentCascadeRef).toBeDefined();
      expect(app.externalContextRegistryRef).toBeDefined();
      expect(app.connectionStoreRef).toBeDefined();
      expect(app.webhookIngressStoreRef).toBeDefined();
      expect(app.webhookDeliveryStoreRef).toBeDefined();
      const pairedApi = {
        kind: 'api' as const,
        name: 'd201-delete-proof',
        display_name: 'D-201 delete proof',
        config_json: '{}',
        auth_ciphertext: 'ciphertext',
        enrolled_at: 1,
        updated_at: 1,
      };
      app.connectionStoreRef!.upsert(pairedApi);
      const requiredIngress = app.webhookIngressStoreRef!.create({
        display_name: 'Required paired ingress',
        profile_id: 'stripe.event.v1',
        environment: 'test',
        paired_connection_id: pairedApi.name,
        registration_mode: 'managed_endpoint',
        selected_event_types: ['invoice.paid'],
      });
      const manualIngress = app.webhookIngressStoreRef!.create({
        display_name: 'Connection-free manual ingress',
        profile_id: 'generic.static-header-token.v1',
        environment: 'test',
        paired_connection_id: pairedApi.name,
        registration_mode: 'manual',
        selected_event_types: ['delivery'],
      });
      expect(app.connectionStoreRef!.delete('api', pairedApi.name)).toBe(true);
      expect(app.webhookIngressStoreRef!.get(requiredIngress.ingress_id)).toMatchObject({
        intake_state: 'disabled',
        registration_state: 'drifted',
        last_error_code: 'paired_connection_deleted',
      });
      expect(app.webhookIngressStoreRef!.get(manualIngress.ingress_id)).toMatchObject({
        intake_state: 'draft',
        last_error_code: null,
      });
      app.connectionStoreRef!.upsert({ ...pairedApi, updated_at: 2 });
      expect(app.webhookIngressStoreRef!.get(requiredIngress.ingress_id)).toMatchObject({
        intake_state: 'disabled',
        last_error_code: 'paired_connection_deleted',
      });
      expect(app.clientTokensRef).toBeDefined();
      expect(app.engagementStoreRef).toBeDefined();
      expect(app.engagementRateControlStoreRef).toBeDefined();
      expect(app.engagementCapabilityStoreRef).toBeDefined();
      expect(app.contactStoreRef).toBeDefined();
      expect(app.remergePromptStoreRef).toBeDefined();
      expect(app.contactMergeCycleObserverRef).toBeDefined();
      expect(app.upstreamMergeStoreRef).toBeDefined();

      // D-192 remote byte-fetch — the ONE shared `remote` bundle builder every
      // file-read channel spreads. With a real db the file-source mirror + its
      // connection resolver are wired, so the getter yields a bundle keyed on
      // exactly those refs, with a MEMOIZED byte-resolver registry.
      expect(app.getRemoteFileReadDeps).toEqual(expect.any(Function));
      const remoteDeps = app.getRemoteFileReadDeps();
      expect(remoteDeps).toBeDefined();
      expect(remoteDeps?.fileMetaStore).toBe(app.fileMetaStoreRef);
      expect(remoteDeps?.resolveConnection).toBe(app.fileSourceConnResolverRef);
      expect(remoteDeps?.byteResolvers.s3).toEqual(expect.any(Function));
      // Memoized — the stateless registry is built once, reused across calls.
      expect(app.getRemoteFileReadDeps()?.byteResolvers).toBe(remoteDeps?.byteResolvers);

      const warehouseEvents: unknown[] = [];
      storageContext.eventBus.subscribe(
        { test: 'serve-compose-app-context' },
        { kinds: ['warehouse'] },
        (event) => warehouseEvents.push(event),
      );
      app.warehouseBus.emit({
        platform: 'mail',
        slug: 'work',
        entity_type: 'message',
        event_kind: 'updated',
        record_id: 'msg-1',
        at: 1,
      });
      expect(warehouseEvents).toMatchObject([
        {
          kind: 'warehouse',
          collection: 'mail',
          op: 'update',
          id: 'msg-1',
        },
      ]);
    } finally {
      storageContext.db.close();
    }
  });

  it('keeps app substrate late-bound and avoids serve orchestration imports', () => {
    const source = readFileSync(appContextPath, 'utf8');

    expect(source).toMatch(/composeLlmSubstrate/);
    expect(source).toMatch(/composeChatOrchestrator/);
    expect(source).toMatch(/createWarehouseEventBus/);
    expect(source).toMatch(/composeHousekeepingStores/);
    expect(source).toMatch(/createEnrichmentStore/);
    expect(source).toMatch(/createEnrichmentCascade/);
    expect(source).toMatch(/createConnectionStore/);
    expect(source).toMatch(
      /profileDeduplicationRequirements:\s*Object\.values\(WEBHOOK_PROFILE_REGISTRY\)/,
    );
    expect(source).toMatch(/createEngagementStore/);
    expect(source).toMatch(/composeContactStore/);
    expect(source).toMatch(/bridgeWarehouseEvents/);
    expect(source).toMatch(/bridgeEnrichmentCascade/);
    expect(source).toMatch(/getContactStore:\s*\(\)\s*=>\s*contactStoreRef/);
    expect(source).toMatch(/getCollectionRegistry:\s*\(\)\s*=>\s*chatLateBound\.getCollectionRegistry\(\)/);
    expect(source).toMatch(/getEnrichmentStore:\s*\(\)\s*=>\s*enrichmentStoreRef/);
    expect(source).toMatch(/getConnectionStore:\s*\(\)\s*=>\s*connectionStoreRef/);
    expect(source).toMatch(/getExecutorConfig:\s*\(\)\s*=>\s*chatLateBound\.getExecutorConfig\(\)/);
    expect(source).toMatch(/getExecuteDeps:\s*\(\)\s*=>\s*chatLateBound\.getExecuteDeps\(\)/);
    expect(source).not.toMatch(/createServerHandlerSet|path-listener|listener-coordinator/);
    expect(source).not.toMatch(/composeSchedulers|composeHousekeepingScheduler|background-services/);
    expect(source).not.toMatch(/mcp-server|wire-mcp-http-transport/);
    expect(source).not.toMatch(/composeCalendarBoot|composeMailBoot|composeServiceBoot/);
    expect(source).not.toMatch(/createCollectionRegistry|composeExecutorConfig|composeExecuteDeps/);
    expect(source).not.toMatch(/createLifecycle|LockHeldError|process\.on/);
  });
});
