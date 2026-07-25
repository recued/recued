import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  IngredientManifest,
  NamespaceStores,
  PackWebhookRequirement,
  RecipeDefinition,
} from '@recued/contracts';
import { runCatalogOperation, type ExecutionContext } from '@recued/engine';
import { createWebhookConsumerStore } from '../storage/webhook-consumer-store.js';
import {
  WebhookConsumerStoreError,
  type WebhookConsumerStore,
} from '../storage/webhook-consumer-store.js';
import { createWebhookIngressStore } from '../storage/webhook-ingress-store.js';
import { handlePacksUninstall } from '../pack-uninstall-handler.js';
import type { RecipeStore } from '../recipe-store.js';
import {
  OPERATION_BOUND_FIXTURE_ATTACH,
  OPERATION_BOUND_FIXTURE_CATALOG,
  OPERATION_BOUND_FIXTURE_DETACH,
  createOperationBoundWebhookFixtureAdapters,
  createWebhookCallbackBindingRuntimeRegistry,
  createWebhookOperationBindingResolver,
} from '../webhook-operation-binding.js';

const databases: Database.Database[] = [];
afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

const CONNECTION = 'fixture-connection';
const BINDING = 'fixture_events';
const KEY = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));

const requirement: PackWebhookRequirement = {
  binding: BINDING,
  profile_ids: ['generic.static-header-token.v1'],
  paired_connection_slot: 'fixture',
  required_event_types: ['delivery'],
  registration_modes: ['operation_bound'],
  environment_policy: 'test_only',
  decoded_payload_access: 'scoped_read',
  source_truth_policy: 'delivery_payload_allowed',
};

const recipe: RecipeDefinition = {
  recipe_id: 'operation-bound-fixture-recipe',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Operation-bound fixture',
    description: 'D-201 Slice 6B3 fixture',
    author: 'recued-core',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { render: [] },
  webhook_requirements: [requirement],
};

const manifest = (
  operation: string,
  intent: 'attach' | 'detach',
  staticCallback?: string,
): IngredientManifest => ({
  slug: OPERATION_BOUND_FIXTURE_CATALOG,
  name: 'Webhook operation fixture',
  description: 'Trusted callback injection fixture',
  author: 'recued-core',
  kind: 'connection',
  category: 'action',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: {
    [operation]: {
      operation_id: `${OPERATION_BOUND_FIXTURE_CATALOG}.${operation}`,
      risk_tier: 'write',
      approval: 'never',
      cache_ttl_ms: 0,
      operation_bound_webhook: { binding: BINDING, intent },
    },
  },
  surfaces: {
    api: {
      transport: 'rest',
      default_base_url: 'https://fixture.invalid',
      auth: { kind: 'none' },
      executes: {
        [operation]: {
          kind: 'rest',
          method: intent === 'attach' ? 'POST' : 'PATCH',
          path_template: intent === 'attach'
            ? '/resources'
            : '/resources/{{resource_id}}',
          ...(staticCallback !== undefined
            ? { static_body: { callback_url: staticCallback } }
            : {}),
        },
      },
    },
  },
});

const makeHarness = async () => {
  const db = new Database(':memory:');
  databases.push(db);
  const ingressStore = createWebhookIngressStore(db, {
    getEncryptionKey: () => KEY,
    newIngressId: () => 'whi_0123456789abcdef0123456789abcdef',
    newPublicId: () => 'opaquePublicId_0123456789abcdef',
    newCredentialSetRef: () => 'whc_0123456789abcdef0123456789abcdef',
  });
  const ingress = ingressStore.create({
    display_name: 'Operation-bound fixture ingress',
    profile_id: 'generic.static-header-token.v1',
    environment: 'test',
    paired_connection_id: CONNECTION,
    registration_mode: 'operation_bound',
    selected_event_types: ['delivery'],
  });
  await ingressStore.writeCredentialVersion(ingress.ingress_id, {
    header_name: 'X-Fixture-Token',
    header_token: 'fixture-secret-token',
  });
  ingressStore.confirmOperationBoundReadiness(ingress.ingress_id);
  ingressStore.enable(ingress.ingress_id);

  const consumerStore = createWebhookConsumerStore(db, { ingressStore });
  consumerStore.replaceConsumer({
    consumer_kind: 'local_recipe',
    consumer_id: recipe.recipe_id,
    requirements: [requirement],
    selections: [{ binding: BINDING, ingress_id: ingress.ingress_id }],
    recipes: [{
      recipe_id: recipe.recipe_id,
      publisher_id: 'recued-core',
      webhook_triggers: [],
    }],
  });

  const endpoint = `https://hooks.example/v1/webhooks/${ingress.public_id}`;
  let endpointAvailable = true;
  const operationBoundWebhook = createWebhookOperationBindingResolver({
    ingressStore,
    consumerStore,
    adapters: createWebhookCallbackBindingRuntimeRegistry(
      createOperationBoundWebhookFixtureAdapters(),
    ),
    resolveCanonicalEndpoint: () => endpointAvailable ? endpoint : null,
  });
  const executor = vi.fn(async (_slug: string, input: Record<string, unknown>) => ({
    status: 200,
    headers: {},
    result: {
      id: 'remote_fixture_resource_1',
      callback_url: input['body.callback_url'],
    },
  }));
  const dispatchProceed = vi.fn();
  const gatewayAudit = vi.fn();
  const context = (): ExecutionContext => ({
    recipe,
    stores: {} as NamespaceStores,
    ingredientExecutor: executor,
    // D-209 §1.4 — the operation-bound attach/detach op is a `write` (it creates the
    // remote resource + callback binding), so the gateway now resolves the dispatch's
    // stage-trust ceiling from `execution_source`. In production it runs as a recipe
    // step carrying the recipe's real source; this fixture models the owner setting up
    // their integration directly (HID → `admin` ceiling → the write admits), so the
    // callback-injection path under test actually reaches dispatch. Absent, the source
    // would fail closed to `read` and the write would hold before injection.
    execution_source: {
      channel: 'user',
      actor: 'user_self',
      user_id: 'owner-1',
      client_token_id: 'client-token-1',
    },
    connectionProfileResolver: () => ({
      allowed_operations: [
        OPERATION_BOUND_FIXTURE_ATTACH,
        OPERATION_BOUND_FIXTURE_DETACH,
      ],
    }),
    operationBoundWebhook,
    operationBoundWebhookConsumer: {
      kind: 'local_recipe',
      id: recipe.recipe_id,
    },
    onCatalogDispatchProceed: dispatchProceed,
    onGatewayCall: gatewayAudit,
  });
  const run = (
    operation: string,
    intent: 'attach' | 'detach',
    args: Record<string, unknown>,
    ctx = context(),
    connection = CONNECTION,
    operationManifest = manifest(operation, intent),
  ) => runCatalogOperation(
    ctx,
    operationManifest,
    OPERATION_BOUND_FIXTURE_CATALOG,
    { operation, args, connection },
    connection,
    undefined,
    undefined,
    {
      step_id: 'operation-bound-fixture-step',
      ...(ctx.recipe ? { recipe_id: ctx.recipe.recipe_id } : {}),
    },
  );
  return {
    ingress,
    ingressStore,
    consumerStore,
    endpoint,
    executor,
    dispatchProceed,
    gatewayAudit,
    context,
    run,
    setEndpointAvailable(value: boolean) { endpointAvailable = value; },
  };
};

describe('D-201 Slice 6B3 operation-bound callback binding', () => {
  it('injects only at final dispatch and returns a callback-free resource result', async () => {
    const harness = await makeHarness();
    const authoredArgs = { name: 'fixture resource' };

    await expect(harness.run(
      OPERATION_BOUND_FIXTURE_ATTACH,
      'attach',
      authoredArgs,
    )).resolves.toEqual({
      remote_resource_id: 'remote_fixture_resource_1',
      webhook_binding_state: 'attached',
    });
    expect(authoredArgs).toEqual({ name: 'fixture resource' });
    expect(harness.dispatchProceed).toHaveBeenCalledWith(expect.objectContaining({
      args: { name: 'fixture resource' },
    }));
    expect(harness.executor).toHaveBeenCalledWith(
      OPERATION_BOUND_FIXTURE_CATALOG,
      expect.objectContaining({
        method: 'POST',
        path: '/resources',
        connection: CONNECTION,
        name: 'fixture resource',
        'body.callback_url': harness.endpoint,
      }),
      undefined,
      undefined,
      expect.objectContaining({
        surface_dispatch_sensitive: true,
        surface_dispatch_authority_input: expect.not.objectContaining({
          'body.callback_url': expect.anything(),
        }),
      }),
    );
    expect(JSON.stringify(await harness.run(
      OPERATION_BOUND_FIXTURE_ATTACH,
      'attach',
      { name: 'second resource' },
    ))).not.toContain(harness.endpoint);
    expect(JSON.stringify(harness.gatewayAudit.mock.calls)).not.toContain(harness.endpoint);
  });

  it('resolves the durable pack-install binding for a bundled recipe', async () => {
    const harness = await makeHarness();
    const packRecipe: RecipeDefinition = {
      ...recipe,
      recipe_id: 'operation-bound-pack-recipe',
      metadata: {
        ...recipe.metadata,
        recipe_bundle: 'recued-core/fixture-pack',
      },
      webhook_requirements: undefined,
    };
    harness.consumerStore.replaceConsumer({
      consumer_kind: 'pack_install',
      consumer_id: 'fixture-pack',
      requirements: [requirement],
      selections: [{ binding: BINDING, ingress_id: harness.ingress.ingress_id }],
      recipes: [{
        recipe_id: packRecipe.recipe_id,
        publisher_id: 'recued-core',
        webhook_triggers: [],
      }],
    });
    const ctx = harness.context();
    ctx.recipe = packRecipe;
    ctx.operationBoundWebhookConsumer = {
      kind: 'pack_install',
      id: 'fixture-pack',
    };

    await expect(harness.run(
      OPERATION_BOUND_FIXTURE_ATTACH,
      'attach',
      { name: 'pack-owned resource' },
      ctx,
    )).resolves.toMatchObject({
      remote_resource_id: 'remote_fixture_resource_1',
      webhook_binding_state: 'attached',
    });
  });

  it('rejects authored callback args, wrong connections, missing core, and closed intake', async () => {
    const harness = await makeHarness();

    await expect(harness.run(
      OPERATION_BOUND_FIXTURE_ATTACH,
      'attach',
      { 'body.callback_url': 'https://attacker.invalid/callback' },
    )).rejects.toMatchObject({ code: 'invalid' });
    await expect(harness.run(
      OPERATION_BOUND_FIXTURE_ATTACH,
      'attach',
      { opaque: new Date() },
    )).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('bounded plain data graph'),
    });
    await expect(harness.run(
      OPERATION_BOUND_FIXTURE_ATTACH,
      'attach',
      { opaque: () => harness.endpoint },
    )).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('bounded plain data graph'),
    });
    await expect(harness.run(
      OPERATION_BOUND_FIXTURE_ATTACH,
      'attach',
      {},
      harness.context(),
      'other-connection',
    )).rejects.toMatchObject({ code: 'connection_mismatch' });
    const noResolver = harness.context();
    delete noResolver.operationBoundWebhook;
    await expect(harness.run(
      OPERATION_BOUND_FIXTURE_ATTACH,
      'attach',
      {},
      noResolver,
    )).rejects.toThrow(/no trusted resolver/);
    const noConsumerProvenance = harness.context();
    delete noConsumerProvenance.operationBoundWebhookConsumer;
    noConsumerProvenance.recipe = {
      ...recipe,
      recipe_id: 'inline-impersonator',
      metadata: {
        ...recipe.metadata,
        recipe_bundle: 'recued-core/fixture-pack',
      },
    };
    await expect(harness.run(
      OPERATION_BOUND_FIXTURE_ATTACH,
      'attach',
      {},
      noConsumerProvenance,
    )).rejects.toThrow(/requires stored consumer provenance/);
    const staleReadManifest = manifest(
      OPERATION_BOUND_FIXTURE_ATTACH,
      'attach',
    );
    staleReadManifest.operations![OPERATION_BOUND_FIXTURE_ATTACH]!.risk_tier = 'read';
    await expect(harness.run(
      OPERATION_BOUND_FIXTURE_ATTACH,
      'attach',
      {},
      harness.context(),
      CONNECTION,
      staleReadManifest,
    )).rejects.toThrow(/cannot be read-tier/);
    const staleCachedManifest = manifest(
      OPERATION_BOUND_FIXTURE_ATTACH,
      'attach',
    );
    staleCachedManifest.operations![OPERATION_BOUND_FIXTURE_ATTACH]!.cache_ttl_ms = 1_000;
    await expect(harness.run(
      OPERATION_BOUND_FIXTURE_ATTACH,
      'attach',
      {},
      harness.context(),
      CONNECTION,
      staleCachedManifest,
    )).rejects.toThrow(/cannot cache provider dispatch/);
    expect(harness.executor).not.toHaveBeenCalled();

    harness.ingressStore.disable(harness.ingress.ingress_id);
    await expect(harness.run(
      OPERATION_BOUND_FIXTURE_ATTACH,
      'attach',
      {},
    )).rejects.toMatchObject({ code: 'ingress_not_ready' });
    expect(harness.executor).not.toHaveBeenCalled();
  });

  it('rejects catalog clobbering and redacts provider errors that echo the callback', async () => {
    const harness = await makeHarness();
    await expect(harness.run(
      OPERATION_BOUND_FIXTURE_ATTACH,
      'attach',
      {},
      harness.context(),
      CONNECTION,
      manifest(
        OPERATION_BOUND_FIXTURE_ATTACH,
        'attach',
        'https://pack.invalid/clobbered-callback',
      ),
    )).rejects.toMatchObject({ code: 'adapter_invalid' });
    expect(harness.executor).not.toHaveBeenCalled();

    const redirectedManifest = manifest(
      OPERATION_BOUND_FIXTURE_ATTACH,
      'attach',
    );
    const redirectedBinding = redirectedManifest.surfaces?.api
      ?.executes?.[OPERATION_BOUND_FIXTURE_ATTACH];
    if (!redirectedBinding || redirectedBinding.kind !== 'rest') {
      throw new Error('fixture REST binding missing');
    }
    redirectedBinding.path_template = '/callback-exfiltration-target';
    await expect(harness.run(
      OPERATION_BOUND_FIXTURE_ATTACH,
      'attach',
      {},
      harness.context(),
      CONNECTION,
      redirectedManifest,
    )).rejects.toMatchObject({ code: 'adapter_invalid' });
    expect(harness.executor).not.toHaveBeenCalled();

    const loweringProjectError = vi.fn((
      _error: unknown,
      phase: 'dispatch_preparation' | 'provider',
    ) => new Error(`safe operation-bound ${phase} failure`));
    const loweringErrorContext = harness.context();
    loweringErrorContext.operationBoundWebhook = async () => {
      const dispatchArgs: Record<string, unknown> = {};
      Object.defineProperty(dispatchArgs, 'body.callback_url', {
        enumerable: true,
        get() {
          throw new Error(`lowering echoed ${harness.endpoint}`);
        },
      });
      return {
        dispatch_args: dispatchArgs,
        validateDispatchInput: () => undefined,
        projectResult: async (result: unknown) => result,
        projectError: loweringProjectError,
      };
    };
    const loweringError = await harness.run(
      OPERATION_BOUND_FIXTURE_ATTACH,
      'attach',
      {},
      loweringErrorContext,
    ).then(() => null, (cause: unknown) => cause);
    expect(loweringError).toMatchObject({
      message: expect.stringContaining('safe operation-bound dispatch_preparation failure'),
    });
    expect((loweringError as Error).message).not.toContain(harness.endpoint);
    expect(loweringProjectError).toHaveBeenCalledWith(
      expect.any(Error),
      'dispatch_preparation',
    );
    expect(harness.executor).not.toHaveBeenCalled();

    harness.executor.mockRejectedValueOnce(
      new Error(`provider echoed ${harness.endpoint}`),
    );
    const error = await harness.run(
      OPERATION_BOUND_FIXTURE_ATTACH,
      'attach',
      {},
    ).then(() => null, (cause: unknown) => cause);
    expect(error).toMatchObject({
      code: 'provider_failed',
      message: expect.not.stringContaining(harness.endpoint),
    });

    const mutatingResolver = createWebhookOperationBindingResolver({
      ingressStore: harness.ingressStore,
      consumerStore: harness.consumerStore,
      adapters: createWebhookCallbackBindingRuntimeRegistry([{
        profile_id: 'generic.static-header-token.v1',
        ingredient_slug: OPERATION_BOUND_FIXTURE_CATALOG,
        operation_id: OPERATION_BOUND_FIXTURE_ATTACH,
        intent: 'attach',
        owned_arg_keys: ['body.callback_url'],
        validateExecutionBinding: () => true,
        buildDispatchArgs(context, args) {
          (args.nested as Record<string, unknown>).value = 'mutated';
          return { ...args, 'body.callback_url': context.callback_url };
        },
        projectResult: () => ({ remote_resource_id: 'unused' }),
      }]),
      resolveCanonicalEndpoint: () => harness.endpoint,
    });
    const mutatingContext = harness.context();
    mutatingContext.operationBoundWebhook = mutatingResolver;
    const nestedArgs = { nested: { value: 'authored' } };
    await expect(harness.run(
      OPERATION_BOUND_FIXTURE_ATTACH,
      'attach',
      nestedArgs,
      mutatingContext,
    )).rejects.toMatchObject({ code: 'adapter_invalid' });
    expect(nestedArgs).toEqual({ nested: { value: 'authored' } });

    const keyEchoResolver = createWebhookOperationBindingResolver({
      ingressStore: harness.ingressStore,
      consumerStore: harness.consumerStore,
      adapters: createWebhookCallbackBindingRuntimeRegistry([{
        profile_id: 'generic.static-header-token.v1',
        ingredient_slug: OPERATION_BOUND_FIXTURE_CATALOG,
        operation_id: OPERATION_BOUND_FIXTURE_ATTACH,
        intent: 'attach',
        owned_arg_keys: ['body.callback_url'],
        validateExecutionBinding: () => true,
        buildDispatchArgs(context, args) {
          return { ...args, 'body.callback_url': context.callback_url };
        },
        projectResult(context) {
          return { [context.callback_url!]: 'provider echo as an object key' };
        },
      }]),
      resolveCanonicalEndpoint: () => harness.endpoint,
    });
    const keyEchoContext = harness.context();
    keyEchoContext.operationBoundWebhook = keyEchoResolver;
    await expect(harness.run(
      OPERATION_BOUND_FIXTURE_ATTACH,
      'attach',
      {},
      keyEchoContext,
    )).rejects.toMatchObject({
      code: 'provider_failed',
      message: expect.not.stringContaining(harness.endpoint),
    });

    const opaqueEchoResolver = createWebhookOperationBindingResolver({
      ingressStore: harness.ingressStore,
      consumerStore: harness.consumerStore,
      adapters: createWebhookCallbackBindingRuntimeRegistry([{
        profile_id: 'generic.static-header-token.v1',
        ingredient_slug: OPERATION_BOUND_FIXTURE_CATALOG,
        operation_id: OPERATION_BOUND_FIXTURE_ATTACH,
        intent: 'attach',
        owned_arg_keys: ['body.callback_url'],
        validateExecutionBinding: () => true,
        buildDispatchArgs(context, args) {
          return { ...args, 'body.callback_url': context.callback_url };
        },
        projectResult(context) {
          return new Error(context.callback_url!);
        },
      }]),
      resolveCanonicalEndpoint: () => harness.endpoint,
    });
    const opaqueEchoContext = harness.context();
    opaqueEchoContext.operationBoundWebhook = opaqueEchoResolver;
    await expect(harness.run(
      OPERATION_BOUND_FIXTURE_ATTACH,
      'attach',
      {},
      opaqueEchoContext,
    )).rejects.toMatchObject({
      code: 'provider_failed',
      message: expect.not.stringContaining(harness.endpoint),
    });
  });

  it('rejects non-plain detach dispatch and projected graphs without a callback needle', async () => {
    const harness = await makeHarness();
    const badDispatchContext = harness.context();
    badDispatchContext.operationBoundWebhook = createWebhookOperationBindingResolver({
      ingressStore: harness.ingressStore,
      consumerStore: harness.consumerStore,
      adapters: createWebhookCallbackBindingRuntimeRegistry([{
        profile_id: 'generic.static-header-token.v1',
        ingredient_slug: OPERATION_BOUND_FIXTURE_CATALOG,
        operation_id: OPERATION_BOUND_FIXTURE_DETACH,
        intent: 'detach',
        owned_arg_keys: ['body.callback_url'],
        validateExecutionBinding: () => true,
        buildDispatchArgs(_context, args) {
          return {
            ...args,
            'body.callback_url': '',
            opaque: new Date(),
          };
        },
        projectResult: () => ({ remote_resource_id: 'unused' }),
      }]),
      resolveCanonicalEndpoint: () => harness.endpoint,
    });

    await expect(harness.run(
      OPERATION_BOUND_FIXTURE_DETACH,
      'detach',
      { resource_id: 'remote_fixture_resource_1' },
      badDispatchContext,
    )).rejects.toMatchObject({ code: 'adapter_invalid' });
    expect(harness.executor).not.toHaveBeenCalled();

    const badProjectionContext = harness.context();
    badProjectionContext.operationBoundWebhook = createWebhookOperationBindingResolver({
      ingressStore: harness.ingressStore,
      consumerStore: harness.consumerStore,
      adapters: createWebhookCallbackBindingRuntimeRegistry([{
        profile_id: 'generic.static-header-token.v1',
        ingredient_slug: OPERATION_BOUND_FIXTURE_CATALOG,
        operation_id: OPERATION_BOUND_FIXTURE_DETACH,
        intent: 'detach',
        owned_arg_keys: ['body.callback_url'],
        validateExecutionBinding: () => true,
        buildDispatchArgs(_context, args) {
          return { ...args, 'body.callback_url': '' };
        },
        projectResult: () => ({
          remote_resource_id: 'remote_fixture_resource_1',
          opaque: () => 'not recipe data',
        }),
      }]),
      resolveCanonicalEndpoint: () => harness.endpoint,
    });

    await expect(harness.run(
      OPERATION_BOUND_FIXTURE_DETACH,
      'detach',
      { resource_id: 'remote_fixture_resource_1' },
      badProjectionContext,
    )).rejects.toMatchObject({ code: 'provider_failed' });
    expect(harness.executor).toHaveBeenCalledTimes(1);
  });

  it('retains cleanup authority and clears a known resource after intake and dispatch are disabled', async () => {
    const harness = await makeHarness();
    harness.consumerStore.setConsumerEnabled(
      'local_recipe',
      recipe.recipe_id,
      false,
    );
    expect(() => harness.consumerStore.removeConsumer(
      'local_recipe',
      recipe.recipe_id,
    )).toThrow(/must remain available for remote resource cleanup/);
    expect(() => harness.consumerStore.replaceConsumer({
      consumer_kind: 'local_recipe',
      consumer_id: recipe.recipe_id,
      requirements: [],
      selections: [],
      recipes: [],
      enabled: false,
    })).toThrow(/must remain available for remote resource cleanup/);
    expect(() => harness.consumerStore.replaceConsumer({
      consumer_kind: 'local_recipe',
      consumer_id: recipe.recipe_id,
      requirements: [requirement],
      selections: [{
        binding: BINDING,
        ingress_id: harness.ingress.ingress_id,
      }],
      recipes: [{
        recipe_id: recipe.recipe_id,
        publisher_id: 'recued-core',
        webhook_triggers: [],
      }],
    })).toThrow(/may be re-enabled only by the explicit arm action/);
    harness.ingressStore.disable(harness.ingress.ingress_id);
    harness.setEndpointAvailable(false);

    await expect(harness.run(
      OPERATION_BOUND_FIXTURE_DETACH,
      'detach',
      { resource_id: 'remote_fixture_resource_1' },
    )).resolves.toEqual({
      remote_resource_id: 'remote_fixture_resource_1',
      webhook_binding_state: 'detached',
    });
    expect(harness.executor).toHaveBeenCalledWith(
      OPERATION_BOUND_FIXTURE_CATALOG,
      expect.objectContaining({
        method: 'PATCH',
        path: '/resources/{{resource_id}}',
        resource_id: 'remote_fixture_resource_1',
        connection: CONNECTION,
        'body.callback_url': '',
      }),
      undefined,
      undefined,
      expect.objectContaining({
        surface_dispatch_sensitive: true,
        surface_dispatch_authority_input: expect.not.objectContaining({
          'body.callback_url': expect.anything(),
        }),
      }),
    );
    await expect(harness.run(
      OPERATION_BOUND_FIXTURE_DETACH,
      'detach',
      { resource_id: 'different_remote_resource' },
    )).rejects.toMatchObject({
      code: 'provider_failed',
      message: expect.not.stringContaining(harness.endpoint),
    });
    expect(() => harness.ingressStore.retire(harness.ingress.ingress_id))
      .toThrow(/cleanup must complete before retirement/);
  });

  it('reports operation-bound pack cleanup as a typed uninstall refusal', async () => {
    const packDir = mkdtempSync(join(tmpdir(), 'recued-d201-operation-bound-uninstall-'));
    try {
      const result = await handlePacksUninstall({
        packDir,
        recipeStore: {
          listForPack: () => [],
        } as unknown as RecipeStore,
        webhookConsumerStore: {
          listBindings: () => [{}],
          removeConsumer: () => {
            throw new WebhookConsumerStoreError(
              'cleanup_required',
              'operation-bound binding must remain available for remote resource cleanup',
            );
          },
        } as unknown as WebhookConsumerStore,
      }, { pack_slug: 'fixture-pack' });
      expect(result.result).toMatchObject({
        ok: false,
        removed: { recipes: [], body_grants: [] },
        failure: {
          code: 'webhook_cleanup_required',
          message: expect.stringContaining('must remain available'),
        },
      });
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });
});
