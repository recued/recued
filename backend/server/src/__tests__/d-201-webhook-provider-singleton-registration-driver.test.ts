import { describe, expect, it, vi } from 'vitest';

import {
  compileWebhookProviderSingletonRegistrationDriverPreset,
  createWebhookProviderSingletonRegistrationDriver,
  type WebhookProviderSingletonInspection,
  type WebhookProviderSingletonRegistrationDriverPreset,
  type WebhookProviderSingletonRegistrationOperations,
} from '../webhook-provider-singleton-registration-driver.js';
import {
  WEBHOOK_REGISTRATION_DRIVER_PROFILE_PRESETS,
  webhookAddressableCollectionRegistrationDriverPreset,
  webhookProviderSingletonRegistrationDriverPreset,
  webhookTargetScopedCollectionRegistrationDriverPreset,
} from '../webhook-registration-driver-profile-presets.js';
import type {
  ManagedWebhookEndpointCreateResult,
  ManagedWebhookEndpointMatch,
  ManagedWebhookEndpointSnapshot,
  ManagedWebhookRegistrationContext,
} from '../webhook-registration-runtime.js';

const PRESET = {
  kind: 'provider_singleton_endpoint.v1',
  profile_id: 'telegram.bot-webhook.v1',
} as const satisfies WebhookProviderSingletonRegistrationDriverPreset;

const CONTEXT: ManagedWebhookRegistrationContext = {
  paired_connection_id: 'connection-1',
  desired: {
    ingress_id: 'whi_0123456789abcdef0123456789abcdef',
    environment: 'custom',
    registration_target: null,
    endpoint_url: 'https://hooks.example.test/v1/webhooks/opaque',
    event_types: ['message'],
  },
};

const snapshot = (
  remoteEndpointId: string,
): ManagedWebhookEndpointSnapshot => ({
  remote_endpoint_id: remoteEndpointId,
  environment: 'custom',
  endpoint_url: CONTEXT.desired.endpoint_url,
  event_types: CONTEXT.desired.event_types,
  enabled: true,
  correlation_valid: true,
});

const match = (remoteEndpointId: string): ManagedWebhookEndpointMatch => ({
  endpoint: snapshot(remoteEndpointId),
  correlation: 'owned',
});

const CREATE_RESULT: ManagedWebhookEndpointCreateResult = {
  endpoint: snapshot('remote-created'),
  credential_result: { secret_token: 'one-time-secret' },
};

const operations = (
  inspect: WebhookProviderSingletonRegistrationOperations['inspect'],
): WebhookProviderSingletonRegistrationOperations => ({
  inspect,
  create: vi.fn(async () => CREATE_RESULT),
  read: vi.fn(async () => snapshot('remote-read')),
  update: vi.fn(async () => snapshot('remote-updated')),
  delete: vi.fn(async () => undefined),
});

describe('D-201 Slice 9BK provider-singleton registration driver', () => {
  it('selects only the frozen, serializable Telegram singleton preset', () => {
    expect(Object.keys(WEBHOOK_REGISTRATION_DRIVER_PROFILE_PRESETS)).toEqual([
      'stripe.event.v1',
      'paddle.notification.v1',
      'github.webhook.v1',
      'telegram.bot-webhook.v1',
    ]);
    const telegram = webhookProviderSingletonRegistrationDriverPreset(
      'telegram.bot-webhook.v1',
    );
    expect(telegram).toEqual(PRESET);
    expect(Object.isFrozen(telegram)).toBe(true);
    expect(() => JSON.stringify(telegram)).not.toThrow();
    expect(Object.isFrozen(WEBHOOK_REGISTRATION_DRIVER_PROFILE_PRESETS))
      .toBe(true);
    expect(
      webhookAddressableCollectionRegistrationDriverPreset(
        'telegram.bot-webhook.v1',
      ),
    ).toBeNull();
    expect(
      webhookTargetScopedCollectionRegistrationDriverPreset(
        'telegram.bot-webhook.v1',
      ),
    ).toBeNull();
    expect(
      webhookProviderSingletonRegistrationDriverPreset('stripe.event.v1'),
    ).toBeNull();
    expect(
      webhookProviderSingletonRegistrationDriverPreset('github.webhook.v1'),
    ).toBeNull();
  });

  it('assembles zero-or-one singleton matches without returning the collaborator array', async () => {
    const owned = match('remote-1');
    const rawMatches = [owned];
    const inspect = vi.fn()
      .mockResolvedValueOnce({ matches: [] })
      .mockResolvedValueOnce({ matches: rawMatches });
    const driver = createWebhookProviderSingletonRegistrationDriver(
      PRESET,
      operations(inspect),
    );

    await expect(driver.find(CONTEXT)).resolves.toEqual([]);
    const found = await driver.find(CONTEXT);
    expect(found).toEqual([owned]);
    expect(found).not.toBe(rawMatches);
    expect(inspect).toHaveBeenNthCalledWith(1, CONTEXT);
    expect(inspect).toHaveBeenNthCalledWith(2, CONTEXT);
    expect(driver.profile_id).toBe(PRESET.profile_id);
    expect(Object.isFrozen(driver)).toBe(true);
    expect(Object.isFrozen(driver.preset)).toBe(true);
  });

  it('gives create a context-bound find lifecycle and pins all collaborators', async () => {
    const inspect = vi.fn(async (): Promise<WebhookProviderSingletonInspection> => ({
      matches: [],
    }));
    let lifecycleFrozen = false;
    const create = vi.fn(
      async (
        _context: ManagedWebhookRegistrationContext,
        _idempotencyKey: string,
        lifecycle: { find(): Promise<readonly ManagedWebhookEndpointMatch[]> },
      ) => {
        lifecycleFrozen = Object.isFrozen(lifecycle);
        await expect(lifecycle.find()).resolves.toEqual([]);
        return CREATE_RESULT;
      },
    );
    const collaborators = operations(inspect);
    Reflect.set(collaborators, 'create', create);
    const originalRead = collaborators.read;
    const driver = createWebhookProviderSingletonRegistrationDriver(
      PRESET,
      collaborators,
    );
    Reflect.set(collaborators, 'read', vi.fn(async () => null));

    await expect(driver.create(CONTEXT, 'idempotency-1')).resolves.toBe(
      CREATE_RESULT,
    );
    await expect(driver.read(CONTEXT, 'remote-read')).resolves.toEqual(
      snapshot('remote-read'),
    );
    await expect(
      driver.update(CONTEXT, 'remote-1', 'idempotency-2'),
    ).resolves.toEqual(snapshot('remote-updated'));
    await expect(driver.delete(CONTEXT, 'remote-1')).resolves.toBeUndefined();
    expect(lifecycleFrozen).toBe(true);
    expect(inspect).toHaveBeenCalledWith(CONTEXT);
    expect(create).toHaveBeenCalledWith(
      CONTEXT,
      'idempotency-1',
      expect.objectContaining({ find: expect.any(Function) }),
    );
    expect(originalRead).toHaveBeenCalledOnce();
    expect(collaborators.update).toHaveBeenCalledWith(
      CONTEXT,
      'remote-1',
      'idempotency-2',
    );
    expect(collaborators.delete).toHaveBeenCalledWith(CONTEXT, 'remote-1');
  });

  it('accepts only exact own-data, targetless managed-profile presets', () => {
    const compiled =
      compileWebhookProviderSingletonRegistrationDriverPreset(PRESET);
    expect(compiled).toEqual(PRESET);
    expect(compiled).not.toBe(PRESET);
    expect(Object.isFrozen(compiled)).toBe(true);

    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'owner_http_template.v1' },
      { ...PRESET, profile_id: 'unknown.vendor.v1' },
      { ...PRESET, profile_id: 'generic.static-header-token.v1' },
      { ...PRESET, profile_id: 'github.webhook.v1' },
      Object.create(PRESET),
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('hostile singleton preset');
          },
        },
      ),
    ]) {
      expect(() =>
        compileWebhookProviderSingletonRegistrationDriverPreset(
          invalid as never,
        ),
      ).toThrow('invalid trusted preset');
    }

    let accessorReads = 0;
    const accessor = { kind: PRESET.kind } as Record<string, unknown>;
    Object.defineProperty(accessor, 'profile_id', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return PRESET.profile_id;
      },
    });
    expect(() =>
      compileWebhookProviderSingletonRegistrationDriverPreset(
        accessor as never,
      ),
    ).toThrow('invalid trusted preset');
    expect(accessorReads).toBe(0);
  });

  it('accepts only an exact own-data collaborator set without invoking accessors', () => {
    const valid = operations(async () => ({ matches: [] }));
    for (const invalid of [
      { ...valid, extra: vi.fn() },
      { ...valid, delete: undefined },
      Object.create(valid),
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('hostile singleton collaborators');
          },
        },
      ),
    ]) {
      expect(() =>
        createWebhookProviderSingletonRegistrationDriver(
          PRESET,
          invalid as never,
        ),
      ).toThrow('invalid trusted operations');
    }

    let accessorReads = 0;
    const accessor = { ...valid } as Record<string, unknown>;
    delete accessor.delete;
    Object.defineProperty(accessor, 'delete', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return valid.delete;
      },
    });
    expect(() =>
      createWebhookProviderSingletonRegistrationDriver(
        PRESET,
        accessor as never,
      ),
    ).toThrow('invalid trusted operations');
    expect(accessorReads).toBe(0);
  });

  it('rejects malformed, sparse, multiple, accessor, and hostile inspections', async () => {
    const sparseMatches = new Array<ManagedWebhookEndpointMatch>(1);
    let accessorReads = 0;
    const accessorMatches: ManagedWebhookEndpointMatch[] = [];
    Object.defineProperty(accessorMatches, '0', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return match('accessor');
      },
    });
    const hostileMatches = new Proxy([], {
      ownKeys() {
        throw new Error('hostile singleton match array');
      },
    });
    const matchesWithExtraProperty = [match('extra-property')];
    Reflect.set(matchesWithExtraProperty, 'extra', true);
    const accessorInspection = {} as Record<string, unknown>;
    Object.defineProperty(accessorInspection, 'matches', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return [];
      },
    });
    const hostileInspection = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('hostile singleton inspection');
        },
      },
    );
    for (const rawInspection of [
      null,
      {},
      { matches: [], extra: true },
      { matches: {} },
      { matches: sparseMatches },
      { matches: accessorMatches },
      { matches: hostileMatches },
      { matches: matchesWithExtraProperty },
      { matches: [match('1'), match('2')] },
      Object.create({ matches: [] }),
      accessorInspection,
      hostileInspection,
    ]) {
      const driver = createWebhookProviderSingletonRegistrationDriver(
        PRESET,
        operations(async () => rawInspection as never),
      );
      await expect(driver.find(CONTEXT)).rejects.toMatchObject({
        code: 'upstream_response_invalid',
        message:
          'webhook provider-singleton driver received an invalid inspection',
      });
    }
    expect(accessorReads).toBe(0);
  });
});
