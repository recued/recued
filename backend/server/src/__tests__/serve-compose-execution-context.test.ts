import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntimeConfigStore } from '@recued/config';
import {
  CONTRACT_DEFINITION_SCOPE,
  type ContractDefinition,
} from '@recued/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { createBootTrace } from '../cli/boot-trace.js';
import { composeAppContext } from '../serve/compose-app-context.js';
import { composeCollectionContext } from '../serve/compose-collection-context.js';
import {
  composeExecutionContext,
  createExecutionLateBoundRefs,
} from '../serve/compose-execution-context.js';
import { composeStorageContext } from '../serve/compose-storage-context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const executionContextPath = join(
  repoRoot,
  'backend/server/src/serve/compose-execution-context.ts',
);

let tmp: string | undefined;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

const makeTmp = (): string => {
  tmp = mkdtempSync(join(tmpdir(), 'recued-serve-execution-'));
  return tmp;
};

describe('composeExecutionContext', () => {
  it('composes executor config, execute deps, notification block, and chat late-bound refs', async () => {
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
      const lateBound = createExecutionLateBoundRefs();
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
        chatLateBound: lateBound,
      });
      const collection = composeCollectionContext({
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

      expect(lateBound.getCollectionRegistry()).toBeUndefined();
      expect(lateBound.getExecutorConfig()).toBeUndefined();
      expect(lateBound.getExecuteDeps()).toBeUndefined();
      expect(lateBound.getScheduleDeps()).toBeUndefined();

      const context = await composeExecutionContext({
        storage: storageContext,
        app,
        collection,
        baseVault: storageContext.baseVault,
        lateBound,
        env: {
          RECUED_SERVER_NAME: 'Execution Test Server',
        },
      });

      expect(context.executorConfig.manifests).toBe(storageContext.manifests);
      expect(context.executorConfig.vault).toBe(storageContext.baseVault);
      expect(context.executorConfig.cacheStore).toBe(app.cacheStore);
      expect(context.executorConfig.connectionStore).toBe(app.connectionStoreRef);
      const kernelDispatchers = context.executorConfig.kernelDispatchers;
      expect(kernelDispatchers).toBeDefined();
      expect(kernelDispatchers?.collectionList).toEqual(
        expect.any(Function),
      );
      expect(kernelDispatchers?.formResponseList).toEqual(expect.any(Function));
      expect(kernelDispatchers?.formResponseGet).toEqual(expect.any(Function));
      expect(kernelDispatchers?.webhookEventGet).toEqual(expect.any(Function));
      expect(kernelDispatchers?.scheduleRecipe).toEqual(expect.any(Function));
      // The claim-origin resolver is deliberately live: a hostname verified
      // after executor composition must work without restarting the server.
      storageContext.hostnameRegistryStore.upsert({
        server_identity_id: storageContext.serverInstanceId,
        hostname: 'claims.example',
        cert_source: 'byo_uploaded',
        ownership_status: 'verified',
        listener_ports: [443],
        enabled: true,
      });
      expect(app.contractStoreRef).toBeDefined();
      expect(app.sellerStoreRef).toBeDefined();
      const template: ContractDefinition = {
        contract_id: 'ct_execution_provider_template',
        minted_at: 1_000,
        minted_by: 'owner:test',
        display_name: 'Execution provider template',
        scope: { operation_ids: ['core.customer.status'] },
        door_types: ['mcp'],
        grant_kind: 'customer_template',
      };
      app.contractStoreRef!.put(
        CONTRACT_DEFINITION_SCOPE,
        [template.contract_id],
        template,
      );
      app.sellerStoreRef!.upsertTier({
        tier_id: 'tier_execution_provider',
        door_id: 'door_execution_provider',
        lifecycle_source: 'stripe',
        entitlement_key: 'basic',
        display_name: 'Basic',
        template_contract_id: template.contract_id,
        now: Date.now(),
      });
      const providerIssue = await kernelDispatchers?.customerAccessIssue?.({
        lifecycle_source: 'stripe',
        door_id: 'door_execution_provider',
        source_customer_id: 'cus_execution_provider',
        entitlement_key: 'basic',
        current_period_end: Date.now() + 24 * 60 * 60 * 1000,
        source_status: 'active',
      });
      expect(providerIssue).toMatchObject({
        result: 'created',
        claim: {
          claim_url: expect.stringMatching(
            /^https:\/\/claims\.example\/reception\/claim\?t=recued_claim_/u,
          ),
        },
        claim_email_delivery: {
          status: 'failed',
          error_code: 'CLAIM_EMAIL_RECIPIENT_MISSING',
        },
      });
      expect(providerIssue).not.toHaveProperty('issued_token');
      const accepted = storageContext.formResponseStoreRef?.accept({
        submission_id: 'submission-execution-context',
        endpoint_id: 'endpoint-1',
        form_definition_id: 'definition-1',
        definition_snapshot: { fields: [{ name: 'brief' }] },
        values: { brief: 'Prepare the launch memo' },
        visitor: { email: 'visitor@example.com' },
        submitted_at: 1_000,
        accepted_at: 2_000,
        metadata: { template_ref: 'file:template-1' },
      });
      expect(accepted?.status).toBe('created');
      await expect(
        kernelDispatchers?.formResponseGet?.({
          submission_id: 'submission-execution-context',
        }),
      ).resolves.toEqual({ record: accepted?.response });
      await expect(kernelDispatchers?.formResponseList?.({ limit: 10 }))
        .resolves.toMatchObject({ records: [accepted?.response] });
      expect(context.executeDeps.recipeStore).toBe(storageContext.recipeStore);
      expect(context.executeDeps.executorConfig).toBe(context.executorConfig);
      expect(context.executeDeps.baseVault).toBe(storageContext.baseVault);
      expect(context.executeDeps.instanceId).toBe(storageContext.serverInstanceId);
      expect(context.executeDeps.serverName).toBe('Execution Test Server');
      expect(context.executeDeps.eventBus).toBe(storageContext.eventBus);
      expect(context.executeDeps.db).toBe(storageContext.db);
      expect(context.executeDeps.gatedActionStore).toBe(
        storageContext.gatedActionStore,
      );
      expect(context.executeDeps.preflightNotifier).toBe(context.notificationBlock);
      expect(context.notificationBlock).toBeDefined();

      expect(lateBound.getCollectionRegistry()).toBe(collection.collectionRegistry);
      expect(lateBound.getExecutorConfig()).toBe(context.executorConfig);
      expect(lateBound.getExecuteDeps()).toBe(context.executeDeps);
    } finally {
      storageContext.db.close();
    }
  });

  it('hands the chat substrate its notification block for the D-219 offer', async () => {
    // ⛔ THE LAST LINK, and the only one the unit tests cannot reach. The offer
    // lifecycle is composed with the chat substrate (APP context) but needs the
    // notification block (EXECUTION context, composed after it), so this call is
    // what makes the owner-facing ask reachable at all. Asserted on the REAL
    // composition rather than by reading the source: a call site named in a file
    // is not a wired seam.
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

    try {
      const lateBound = createExecutionLateBoundRefs();
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
        chatLateBound: lateBound,
      });
      const collection = composeCollectionContext({
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
      const published: unknown[] = [];
      const realPublish = app.publishExecutionCaseOfferNotifier;
      expect(realPublish).toBeDefined();

      const context = await composeExecutionContext({
        storage: storageContext,
        app: {
          ...app,
          publishExecutionCaseOfferNotifier: (notifier) => {
            published.push(notifier);
            realPublish?.(notifier);
          },
        },
        collection,
        baseVault: storageContext.baseVault,
        lateBound,
        env: { RECUED_SERVER_NAME: 'Offer Wiring Test Server' },
      });

      // Exactly once, with the LIVE block — the same instance the preflight
      // handlers were registered on, so an answered offer re-dispatches through
      // the same store the boot sweep recovers from.
      expect(published).toEqual([context.notificationBlock]);
    } finally {
      storageContext.db.close();
    }
  });

  it('keeps execution context out of listener, scheduler, lifecycle, shutdown, and MCP imports', () => {
    const source = readFileSync(executionContextPath, 'utf8');

    expect(source).toMatch(/composeExecutorConfig/);
    expect(source).toMatch(/composeExecuteDeps/);
    expect(source).toMatch(/createExecutionLateBoundRefs/);
    expect(source).toMatch(/publishCollectionRegistry/);
    expect(source).toMatch(/publishExecutorConfig/);
    expect(source).toMatch(/publishExecuteDeps/);
    expect(source).toMatch(/emitFormResponseCreatedEvents/);
    expect(source).toMatch(/realtimeBus:\s*storage\.eventBus/);
    expect(source).toMatch(/warehouseBus:\s*app\.warehouseBus/);
    expect(source).not.toMatch(/createServerHandlerSet|path-listener|listener-coordinator|composeWebhookAndHookListeners/);
    expect(source).not.toMatch(/composeSchedulers|composeHousekeepingScheduler|background-services/);
    expect(source).not.toMatch(/mcp-server|wire-mcp-http-transport/);
    expect(source).not.toMatch(/createLifecycle|LockHeldError|process\.on|process\.exit/);
  });
});
