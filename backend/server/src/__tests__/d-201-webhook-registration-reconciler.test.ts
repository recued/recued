import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebhookIngressStore } from '../storage/webhook-ingress-store.js';
import {
  createWebhookManagedRegistrationService,
  WEBHOOK_UNSETTLED_CREATE_GIVE_UP_MS,
  WEBHOOK_UNSETTLED_CREATE_WINDOW_MS,
} from '../webhook-registration-reconciler.js';
import {
  createWebhookRegistrationRuntimeRegistry,
  WebhookRegistrationAdapterError,
  type ManagedWebhookEndpointSnapshot,
  type WebhookManagedEndpointRegistrationAdapter,
} from '../webhook-registration-runtime.js';

const databases: Database.Database[] = [];
afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

const key = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));

const makeHarness = () => {
  const db = new Database(':memory:');
  databases.push(db);
  const store = createWebhookIngressStore(db, {
    getEncryptionKey: () => key,
    newIngressId: () => 'whi_0123456789abcdef0123456789abcdef',
    newPublicId: () => 'opaquePublicId_0123456789abcdef',
    newCredentialSetRef: () => 'whc_0123456789abcdef0123456789abcdef',
  });
  const ingress = store.create({
    display_name: 'Stripe test events',
    profile_id: 'stripe.event.v1',
    environment: 'test',
    paired_connection_id: 'stripe-test',
    registration_mode: 'managed_endpoint',
    selected_event_types: ['invoice.paid'],
  });
  const endpointUrl = `https://hooks.example/v1/webhooks/${ingress.public_id}`;
  const snapshot = (overrides: Partial<ManagedWebhookEndpointSnapshot> = {}) => ({
    remote_endpoint_id: 'we_1234567890abcdef',
    environment: 'test' as const,
    endpoint_url: endpointUrl,
    event_types: ['invoice.paid'],
    enabled: true,
    correlation_valid: true,
    ...overrides,
  });
  const adapter: WebhookManagedEndpointRegistrationAdapter = {
    profile_id: 'stripe.event.v1',
    find: vi.fn(async () => []),
    create: vi.fn(async () => ({
      endpoint: snapshot(),
      credential_result: { endpoint_secret: 'whsec_ReconcilerSecret123' },
    })),
    read: vi.fn(async () => snapshot()),
    update: vi.fn(async () => snapshot()),
    delete: vi.fn(async () => undefined),
  };
  const service = createWebhookManagedRegistrationService({
    store,
    adapters: createWebhookRegistrationRuntimeRegistry([adapter]),
    resolveCanonicalEndpoint: () => endpointUrl,
  });
  return { store, ingress, endpointUrl, snapshot, adapter, service };
};

describe('D-201 Slice 6A managed webhook registration reconciler', () => {
  it('creates, reads back, and atomically captures the secret without returning it', async () => {
    const harness = makeHarness();
    const createResult = {
      endpoint: harness.snapshot(),
      credential_result: { endpoint_secret: 'whsec_ReconcilerSecret123' },
    };
    vi.mocked(harness.adapter.create).mockResolvedValueOnce(createResult);

    const result = await harness.service.reconcile(harness.ingress.ingress_id);
    expect(result).toMatchObject({
      remote_endpoint_id: 'we_1234567890abcdef',
      confirmed_endpoint_url: harness.endpointUrl,
      registration_state: 'registered',
      intake_state: 'ready',
    });
    expect(result).not.toHaveProperty('credentials');
    expect(harness.adapter.find).toHaveBeenCalledTimes(1);
    expect(harness.adapter.create).toHaveBeenCalledWith(
      expect.objectContaining({
        paired_connection_id: 'stripe-test',
        desired: expect.objectContaining({
          endpoint_url: harness.endpointUrl,
          registration_target: null,
        }),
      }),
      expect.stringMatching(/^recued-d201-[a-f0-9]{32}-1-create-[a-f0-9]{32}$/),
    );
    expect(harness.adapter.read).toHaveBeenCalledWith(
      expect.anything(),
      'we_1234567890abcdef',
    );
    expect(createResult.credential_result.endpoint_secret).toBe('');
    await expect(harness.store.readActiveCredentialVersions(result.ingress_id))
      .resolves.toEqual([expect.objectContaining({
        credentials: { endpoint_secret: 'whsec_ReconcilerSecret123' },
      })]);

    await expect(harness.service.reconcile(result.ingress_id))
      .resolves.toMatchObject({ registration_state: 'registered' });
    expect(harness.adapter.create).toHaveBeenCalledTimes(1);
    expect(harness.store.listCredentialVersions(result.ingress_id)).toHaveLength(1);
  });

  it('requires explicit provider read-back before a same-name connection can recover intake', async () => {
    const harness = makeHarness();
    const registered = await harness.service.reconcile(harness.ingress.ingress_id);
    harness.store.enable(registered.ingress_id);

    harness.store.failCloseForDeletedPairedConnection('stripe-test', 'api');
    expect(harness.store.get(registered.ingress_id)).toMatchObject({
      paired_connection_id: 'stripe-test',
      registration_state: 'drifted',
      intake_state: 'disabled',
      last_error_code: 'paired_connection_deleted',
    });
    expect(() => harness.store.enable(registered.ingress_id))
      .toThrow('explicit rebind or reconciliation');

    await expect(harness.service.reconcile(registered.ingress_id)).resolves.toMatchObject({
      paired_connection_id: 'stripe-test',
      registration_state: 'registered',
      intake_state: 'disabled',
      last_error_code: null,
    });
    expect(harness.adapter.read).toHaveBeenLastCalledWith(
      expect.objectContaining({ paired_connection_id: 'stripe-test' }),
      'we_1234567890abcdef',
    );
    expect(harness.store.enable(registered.ingress_id).intake_state).toBe('enabled');
  });

  it('deletes a conclusively-owned orphan and rotates before recreating its lost secret', async () => {
    const harness = makeHarness();
    vi.mocked(harness.adapter.find).mockResolvedValueOnce([{
      correlation: 'owned',
      endpoint: harness.snapshot({ remote_endpoint_id: 'we_orphan123456789' }),
    }]);
    vi.mocked(harness.adapter.create).mockResolvedValueOnce({
      endpoint: harness.snapshot({ remote_endpoint_id: 'we_recreated123456' }),
      credential_result: { endpoint_secret: 'whsec_FreshAfterOrphan' },
    });
    vi.mocked(harness.adapter.read).mockResolvedValueOnce(
      harness.snapshot({ remote_endpoint_id: 'we_recreated123456' }),
    );

    await expect(harness.service.reconcile(harness.ingress.ingress_id))
      .resolves.toMatchObject({ remote_endpoint_id: 'we_recreated123456' });
    expect(harness.adapter.delete).toHaveBeenCalledWith(
      expect.anything(),
      'we_orphan123456789',
    );
    expect(harness.adapter.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/^recued-d201-[a-f0-9]{32}-2-create-[a-f0-9]{32}$/),
    );
  });

  it('removes a created endpoint its read-back does not confirm, so the vendor keeps no secret Recued discarded', async () => {
    // D-201 Slice 10G (10D finding 3): the create's secret is never stored on
    // this path, and deliveries signed with it would all be refused.
    const harness = makeHarness();
    vi.mocked(harness.adapter.read).mockResolvedValueOnce(
      harness.snapshot({ event_types: ['invoice.created'] }),
    );
    await expect(harness.service.reconcile(harness.ingress.ingress_id))
      .rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(harness.adapter.delete).toHaveBeenCalledWith(
      expect.anything(),
      'we_1234567890abcdef',
    );
    expect(harness.store.listCredentialVersions(harness.ingress.ingress_id)).toEqual([]);
    expect(harness.store.get(harness.ingress.ingress_id)).toMatchObject({
      remote_endpoint_id: null,
      last_error_code: 'managed_registration_drift',
    });
  });

  it('when removing it fails too, the next pass finds it by its URL and removes it before creating again', async () => {
    const harness = makeHarness();
    vi.mocked(harness.adapter.read).mockResolvedValueOnce(
      harness.snapshot({ event_types: ['invoice.created'] }),
    );
    vi.mocked(harness.adapter.delete).mockRejectedValueOnce(
      new WebhookRegistrationAdapterError('upstream_unavailable', 'Stripe is unavailable'),
    );
    await expect(harness.service.reconcile(harness.ingress.ingress_id))
      .rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(harness.store.get(harness.ingress.ingress_id)).toMatchObject({ remote_endpoint_id: null });

    // The endpoint is still there: the next pass's search finds it.
    vi.mocked(harness.adapter.find).mockResolvedValueOnce([{
      correlation: 'owned',
      endpoint: harness.snapshot(),
    }]);
    await expect(harness.service.reconcile(harness.ingress.ingress_id))
      .resolves.toMatchObject({ registration_state: 'registered' });
    expect(vi.mocked(harness.adapter.delete).mock.calls.map(([, id]) => id))
      .toEqual(['we_1234567890abcdef', 'we_1234567890abcdef']);
    expect(harness.store.listCredentialVersions(harness.ingress.ingress_id)).toHaveLength(1);
  });

  it('stops on duplicate or URL-only correlation without mutating a remote endpoint', async () => {
    const harness = makeHarness();
    vi.mocked(harness.adapter.find).mockResolvedValueOnce([{
      correlation: 'url_only',
      endpoint: harness.snapshot({ remote_endpoint_id: 'we_someoneelse12345' }),
    }]);

    await expect(harness.service.reconcile(harness.ingress.ingress_id))
      .rejects.toMatchObject({ code: 'ambiguous' });
    expect(harness.adapter.delete).not.toHaveBeenCalled();
    expect(harness.adapter.create).not.toHaveBeenCalled();
    expect(harness.store.get(harness.ingress.ingress_id)).toMatchObject({
      registration_state: 'drifted',
      last_error_code: 'managed_registration_ambiguous',
      remote_endpoint_id: null,
    });
  });

  it('treats partial profile metadata as collision evidence, never deletion authority', async () => {
    const harness = makeHarness();
    vi.mocked(harness.adapter.find).mockResolvedValueOnce([{
      correlation: 'metadata_conflict',
      endpoint: harness.snapshot({
        remote_endpoint_id: 'we_wrongprofile12345',
        endpoint_url: 'https://old.example/webhook',
        correlation_valid: false,
      }),
    }]);

    await expect(harness.service.reconcile(harness.ingress.ingress_id))
      .rejects.toMatchObject({ code: 'ambiguous' });
    expect(harness.adapter.delete).not.toHaveBeenCalled();
    expect(harness.adapter.create).not.toHaveBeenCalled();
    expect(harness.store.get(harness.ingress.ingress_id)).toMatchObject({
      registration_state: 'drifted',
      last_error_code: 'managed_registration_ambiguous',
    });
  });

  it('repairs URL/event/status drift and requires a second provider read', async () => {
    const harness = makeHarness();
    await harness.service.reconcile(harness.ingress.ingress_id);
    vi.mocked(harness.adapter.read)
      .mockResolvedValueOnce(harness.snapshot({
        endpoint_url: 'https://old.example/webhook',
        event_types: ['invoice.payment_failed'],
        enabled: false,
      }))
      .mockResolvedValueOnce(harness.snapshot());

    await expect(harness.service.reconcile(harness.ingress.ingress_id))
      .resolves.toMatchObject({ registration_state: 'registered' });
    expect(harness.adapter.update).toHaveBeenCalledWith(
      expect.anything(),
      'we_1234567890abcdef',
      expect.stringMatching(/-1-update-[a-f0-9]{32}$/),
    );
    expect(harness.adapter.read).toHaveBeenCalledTimes(3);
  });

  it('marks a committed endpoint missing instead of silently creating a second endpoint', async () => {
    const harness = makeHarness();
    await harness.service.reconcile(harness.ingress.ingress_id);
    vi.mocked(harness.adapter.read).mockResolvedValueOnce(null);

    await expect(harness.service.reconcile(harness.ingress.ingress_id))
      .rejects.toMatchObject({ code: 'remote_missing' });
    expect(harness.adapter.create).toHaveBeenCalledTimes(1);
    expect(harness.store.get(harness.ingress.ingress_id)).toMatchObject({
      registration_state: 'drifted',
      last_error_code: 'managed_remote_missing',
    });
  });

  it('rebinds a second credential for the same provider account without endpoint churn', async () => {
    const harness = makeHarness();
    await harness.service.reconcile(harness.ingress.ingress_id);

    await expect(harness.service.rebind(
      harness.ingress.ingress_id,
      'stripe-test-rotated',
    )).resolves.toMatchObject({
      paired_connection_id: 'stripe-test-rotated',
      pending_paired_connection_id: null,
      remote_endpoint_id: 'we_1234567890abcdef',
      registration_state: 'registered',
      intake_state: 'ready',
    });
    expect(harness.adapter.read).toHaveBeenLastCalledWith(
      expect.objectContaining({ paired_connection_id: 'stripe-test-rotated' }),
      'we_1234567890abcdef',
    );
    expect(harness.adapter.delete).not.toHaveBeenCalled();
    expect(harness.adapter.create).toHaveBeenCalledTimes(1);
    expect(harness.store.listCredentialVersions(harness.ingress.ingress_id))
      .toEqual([expect.objectContaining({ active: true })]);
  });

  it('cuts over a different account only after old endpoint absence is confirmed', async () => {
    const harness = makeHarness();
    await harness.service.reconcile(harness.ingress.ingress_id);
    vi.mocked(harness.adapter.read)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await expect(harness.service.rebind(
      harness.ingress.ingress_id,
      'stripe-test-other-account',
    )).resolves.toMatchObject({
      paired_connection_id: 'stripe-test-other-account',
      pending_paired_connection_id: null,
      remote_endpoint_id: null,
      registration_state: 'managed_pending',
      intake_state: 'disabled',
    });
    expect(harness.adapter.delete).toHaveBeenCalledWith(
      expect.objectContaining({ paired_connection_id: 'stripe-test' }),
      'we_1234567890abcdef',
    );
    expect(harness.store.listCredentialVersions(harness.ingress.ingress_id))
      .toEqual([expect.objectContaining({ active: false })]);
    expect(harness.adapter.create).toHaveBeenCalledTimes(1);

    await expect(harness.service.reconcile(harness.ingress.ingress_id))
      .resolves.toMatchObject({
        paired_connection_id: 'stripe-test-other-account',
        registration_state: 'registered',
        intake_state: 'disabled',
      });
    expect(harness.adapter.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ paired_connection_id: 'stripe-test-other-account' }),
      expect.stringMatching(/^recued-d201-[a-f0-9]{32}-2-create-[a-f0-9]{32}$/),
    );
  });

  it('rejects an incompatible or colliding target before closing the current ingress', async () => {
    const incompatible = makeHarness();
    await incompatible.service.reconcile(incompatible.ingress.ingress_id);
    vi.mocked(incompatible.adapter.read).mockRejectedValueOnce(
      new WebhookRegistrationAdapterError(
        'environment_mismatch',
        'Stripe API key mode does not match the ingress environment',
      ),
    );

    await expect(incompatible.service.rebind(
      incompatible.ingress.ingress_id,
      'stripe-live-wrong-mode',
    )).rejects.toMatchObject({ code: 'environment_mismatch' });
    expect(incompatible.store.get(incompatible.ingress.ingress_id)).toMatchObject({
      paired_connection_id: 'stripe-test',
      pending_paired_connection_id: null,
      registration_state: 'registered',
      intake_state: 'ready',
    });
    expect(incompatible.adapter.delete).not.toHaveBeenCalled();

    const collision = makeHarness();
    await collision.service.reconcile(collision.ingress.ingress_id);
    vi.mocked(collision.adapter.read).mockResolvedValueOnce(null);
    vi.mocked(collision.adapter.find).mockResolvedValueOnce([{
      correlation: 'url_only',
      endpoint: collision.snapshot({ remote_endpoint_id: 'we_targetcollision123' }),
    }]);
    await expect(collision.service.rebind(
      collision.ingress.ingress_id,
      'stripe-test-colliding-account',
    )).rejects.toMatchObject({ code: 'ambiguous' });
    expect(collision.store.get(collision.ingress.ingress_id)).toMatchObject({
      paired_connection_id: 'stripe-test',
      pending_paired_connection_id: null,
      registration_state: 'registered',
      intake_state: 'ready',
    });
    expect(collision.adapter.delete).not.toHaveBeenCalled();
  });

  it('keeps a failed old-account cleanup bound to its durable target and retries it', async () => {
    const harness = makeHarness();
    await harness.service.reconcile(harness.ingress.ingress_id);
    vi.mocked(harness.adapter.read)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    vi.mocked(harness.adapter.delete)
      .mockRejectedValueOnce(new WebhookRegistrationAdapterError(
        'upstream_unavailable',
        'Stripe webhook registration request did not complete',
      ))
      .mockResolvedValueOnce(undefined);

    await expect(harness.service.rebind(
      harness.ingress.ingress_id,
      'stripe-test-retry-target',
    )).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(harness.store.get(harness.ingress.ingress_id)).toMatchObject({
      paired_connection_id: 'stripe-test',
      pending_paired_connection_id: 'stripe-test-retry-target',
      registration_state: 'cleanup_pending',
      intake_state: 'disabled',
      last_error_code: 'managed_cleanup_unconfirmed',
    });

    await expect(harness.service.rebind(
      harness.ingress.ingress_id,
      'stripe-test-other-target',
    )).rejects.toMatchObject({ code: 'state_changed' });
    await expect(harness.service.cleanup(
      harness.ingress.ingress_id,
      'disable',
    )).resolves.toMatchObject({
      paired_connection_id: 'stripe-test-retry-target',
      pending_paired_connection_id: null,
      registration_state: 'managed_pending',
      intake_state: 'disabled',
    });
    expect(harness.adapter.find).toHaveBeenCalledTimes(2);
    expect(harness.adapter.delete).toHaveBeenCalledTimes(2);
  });

  it('collapses a queued duplicate cutover retry after the first retry completes', async () => {
    const harness = makeHarness();
    await harness.service.reconcile(harness.ingress.ingress_id);
    vi.mocked(harness.adapter.read)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    let signalDeleteStarted!: () => void;
    let releaseDelete!: () => void;
    const deleteStarted = new Promise<void>((resolve) => { signalDeleteStarted = resolve; });
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
    vi.mocked(harness.adapter.delete)
      .mockRejectedValueOnce(new WebhookRegistrationAdapterError(
        'upstream_unavailable',
        'Stripe webhook registration request did not complete',
      ))
      .mockImplementationOnce(async () => {
        signalDeleteStarted();
        await deleteGate;
      });

    await expect(harness.service.rebind(
      harness.ingress.ingress_id,
      'stripe-test-queued-target',
    )).rejects.toMatchObject({ code: 'upstream_unavailable' });

    const firstRetry = harness.service.cleanup(harness.ingress.ingress_id, 'disable');
    await deleteStarted;
    const queuedRetry = harness.service.cleanup(harness.ingress.ingress_id, 'disable');
    releaseDelete();

    await expect(firstRetry).resolves.toMatchObject({
      paired_connection_id: 'stripe-test-queued-target',
      pending_paired_connection_id: null,
      registration_state: 'managed_pending',
      intake_state: 'disabled',
    });
    await expect(queuedRetry).resolves.toMatchObject({
      paired_connection_id: 'stripe-test-queued-target',
      pending_paired_connection_id: null,
      registration_state: 'managed_pending',
      intake_state: 'disabled',
    });
    expect(harness.adapter.delete).toHaveBeenCalledTimes(2);
  });

  it('rejects adapters for profiles that do not declare managed registration', () => {
    expect(() => createWebhookRegistrationRuntimeRegistry([{
      ...makeHarness().adapter,
      profile_id: 'generic.http-basic.v1',
    }])).toThrow('does not declare connection-bound managed registration');
  });

  it('does not start or lock registration when no adapter is installed', async () => {
    const harness = makeHarness();
    const unavailable = createWebhookManagedRegistrationService({
      store: harness.store,
      adapters: createWebhookRegistrationRuntimeRegistry([]),
      resolveCanonicalEndpoint: () => harness.endpointUrl,
    });

    await expect(unavailable.reconcile(harness.ingress.ingress_id))
      .rejects.toMatchObject({ code: 'unsupported' });
    expect(harness.store.update(harness.ingress.ingress_id, {
      paired_connection_id: 'stripe-other',
    })).toMatchObject({ paired_connection_id: 'stripe-other' });
  });

  it('pins the GitHub target across provider search before allocating a mutation attempt', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    const store = createWebhookIngressStore(db, {
      getEncryptionKey: () => key,
      newIngressId: () => 'whi_githubtarget0123456789abcdef0123',
      newPublicId: () => 'githubTargetPublicId_0123456789',
      newCredentialSetRef: () => 'whc_githubtarget0123456789abcdef0123',
    });
    const ingress = store.create({
      display_name: 'GitHub target race',
      profile_id: 'github.webhook.v1',
      environment: 'live',
      paired_connection_id: 'github-api',
      registration_target: { kind: 'repository', key: 'openai/example' },
      registration_mode: 'managed_endpoint',
      selected_event_types: ['issues'],
    });
    const endpointUrl = `https://hooks.example/v1/webhooks/${ingress.public_id}`;
    const adapter: WebhookManagedEndpointRegistrationAdapter = {
      profile_id: 'github.webhook.v1',
      find: vi.fn(async (context) => {
        expect(context.desired.registration_target).toEqual({
          kind: 'repository',
          key: 'openai/example',
        });
        store.update(ingress.ingress_id, {
          registration_target: { kind: 'organization', key: 'openai' },
        });
        return [];
      }),
      create: vi.fn(async () => {
        throw new Error('target race must stop before create');
      }),
      read: vi.fn(async () => null),
      update: vi.fn(async () => {
        throw new Error('target race must stop before update');
      }),
      delete: vi.fn(async () => undefined),
    };
    const service = createWebhookManagedRegistrationService({
      store,
      adapters: createWebhookRegistrationRuntimeRegistry([adapter]),
      resolveCanonicalEndpoint: () => endpointUrl,
    });

    await expect(service.reconcile(ingress.ingress_id)).rejects.toMatchObject({
      code: 'state_changed',
    });
    expect(adapter.create).not.toHaveBeenCalled();
    expect(store.get(ingress.ingress_id)).toMatchObject({
      registration_target: { kind: 'organization', key: 'openai' },
      registration_state: 'managed_pending',
    });
    expect(db.prepare(`
      SELECT registration_attempt FROM webhook_ingresses WHERE ingress_id = ?
    `).pluck().get(ingress.ingress_id)).toBe(0);
  });

  it('domain-separates managed create idempotency by canonical registration target', async () => {
    const createKeyFor = async (
      registrationTarget: { kind: string; key: string },
    ): Promise<string> => {
      const db = new Database(':memory:');
      databases.push(db);
      const store = createWebhookIngressStore(db, {
        getEncryptionKey: () => key,
        newIngressId: () => 'whi_samegithub0123456789abcdef012345',
        newPublicId: () => 'sameGitHubPublicId_0123456789ab',
        newCredentialSetRef: () => `whc_${registrationTarget.kind}0123456789abcdef012345`,
      });
      const ingress = store.create({
        display_name: 'GitHub idempotency target',
        profile_id: 'github.webhook.v1',
        environment: 'live',
        paired_connection_id: 'github-api',
        registration_target: registrationTarget,
        registration_mode: 'managed_endpoint',
        selected_event_types: ['issues'],
      });
      const endpointUrl = `https://hooks.example/v1/webhooks/${ingress.public_id}`;
      const endpoint = {
        remote_endpoint_id: 'github-hook-123',
        environment: 'live' as const,
        endpoint_url: endpointUrl,
        event_types: ['issues'],
        enabled: true,
        correlation_valid: true,
      };
      const adapter: WebhookManagedEndpointRegistrationAdapter = {
        profile_id: 'github.webhook.v1',
        find: vi.fn(async () => []),
        create: vi.fn(async () => ({
          endpoint,
          credential_result: { webhook_secret: 'G'.repeat(43) },
        })),
        read: vi.fn(async () => endpoint),
        update: vi.fn(async () => endpoint),
        delete: vi.fn(async () => undefined),
      };
      const service = createWebhookManagedRegistrationService({
        store,
        adapters: createWebhookRegistrationRuntimeRegistry([adapter]),
        resolveCanonicalEndpoint: () => endpointUrl,
      });
      await service.reconcile(ingress.ingress_id);
      return vi.mocked(adapter.create).mock.calls[0]![1];
    };

    const repositoryKey = await createKeyFor({
      kind: 'repository',
      key: 'openai/example',
    });
    const organizationKey = await createKeyFor({
      kind: 'organization',
      key: 'openai',
    });
    expect(repositoryKey).toMatch(
      /^recued-d201-[a-f0-9]{32}-1-create-[a-f0-9]{32}$/,
    );
    expect(organizationKey).not.toBe(repositoryKey);
  });

  it('does not start or lock registration when the paired connection cannot be read', async () => {
    const harness = makeHarness();
    vi.mocked(harness.adapter.find).mockRejectedValueOnce(
      new WebhookRegistrationAdapterError(
        'connection_locked',
        'Stripe connection credential is unavailable while the vault is locked',
      ),
    );

    await expect(harness.service.reconcile(harness.ingress.ingress_id))
      .rejects.toMatchObject({ code: 'connection_unavailable' });
    expect(harness.adapter.create).not.toHaveBeenCalled();
    expect(harness.adapter.delete).not.toHaveBeenCalled();
    expect(harness.store.update(harness.ingress.ingress_id, {
      paired_connection_id: 'stripe-other',
    })).toMatchObject({ paired_connection_id: 'stripe-other' });
  });

  it('closes locally, deletes remotely, confirms absence, and retires the captured secret', async () => {
    const harness = makeHarness();
    await harness.service.reconcile(harness.ingress.ingress_id);
    vi.mocked(harness.adapter.read).mockResolvedValueOnce(null);

    await expect(harness.service.cleanup(harness.ingress.ingress_id, 'disable'))
      .resolves.toMatchObject({
        intake_state: 'disabled',
        registration_state: 'managed_pending',
        remote_endpoint_id: null,
        confirmed_endpoint_url: null,
      });
    expect(harness.adapter.delete).toHaveBeenCalledWith(
      expect.anything(),
      'we_1234567890abcdef',
    );
    expect(harness.adapter.read).toHaveBeenLastCalledWith(
      expect.anything(),
      'we_1234567890abcdef',
    );
    expect(harness.store.listCredentialVersions(harness.ingress.ingress_id))
      .toEqual([expect.objectContaining({ active: false })]);
  });

  it('keeps failed cleanup closed and owner-retryable', async () => {
    const harness = makeHarness();
    await harness.service.reconcile(harness.ingress.ingress_id);
    vi.mocked(harness.adapter.delete)
      .mockRejectedValueOnce(new WebhookRegistrationAdapterError(
        'upstream_unavailable',
        'Stripe webhook registration request did not complete',
      ))
      .mockResolvedValueOnce(undefined);
    vi.mocked(harness.adapter.read).mockResolvedValueOnce(null);

    await expect(harness.service.cleanup(harness.ingress.ingress_id, 'disable'))
      .rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(harness.store.get(harness.ingress.ingress_id)).toMatchObject({
      intake_state: 'disabled',
      registration_state: 'cleanup_pending',
      remote_endpoint_id: 'we_1234567890abcdef',
      last_error_code: 'managed_cleanup_unconfirmed',
    });

    await expect(harness.service.cleanup(harness.ingress.ingress_id, 'disable'))
      .resolves.toMatchObject({
        intake_state: 'disabled',
        registration_state: 'managed_pending',
        remote_endpoint_id: null,
      });
    expect(harness.adapter.delete).toHaveBeenCalledTimes(2);
  });

  it.each(['disable', 'retire'] as const)(
    'treats a queued duplicate %s cleanup as an idempotent replay',
    async (intent) => {
      const harness = makeHarness();
      await harness.service.reconcile(harness.ingress.ingress_id);
      let signalDeleteStarted!: () => void;
      let releaseDelete!: () => void;
      const deleteStarted = new Promise<void>((resolve) => { signalDeleteStarted = resolve; });
      const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
      vi.mocked(harness.adapter.delete).mockImplementationOnce(async () => {
        signalDeleteStarted();
        await deleteGate;
      });
      vi.mocked(harness.adapter.read).mockResolvedValueOnce(null);

      const first = harness.service.cleanup(harness.ingress.ingress_id, intent);
      await deleteStarted;
      const duplicate = harness.service.cleanup(harness.ingress.ingress_id, intent);
      releaseDelete();

      const expected = intent === 'disable'
        ? { intake_state: 'disabled', registration_state: 'managed_pending' }
        : { intake_state: 'retired', registration_state: 'retired' };
      await expect(first).resolves.toMatchObject(expected);
      await expect(duplicate).resolves.toMatchObject(expected);
      expect(harness.adapter.delete).toHaveBeenCalledTimes(1);
    },
  );

  it('searches exact correlation before retiring an uncommitted orphan', async () => {
    const harness = makeHarness();
    harness.store.prepareManagedRegistration(harness.ingress.ingress_id);
    vi.mocked(harness.adapter.find).mockResolvedValueOnce([{
      correlation: 'owned',
      endpoint: harness.snapshot({ remote_endpoint_id: 'we_orphan123456789' }),
    }]);
    vi.mocked(harness.adapter.read).mockResolvedValueOnce(null);

    await expect(harness.service.cleanup(harness.ingress.ingress_id, 'retire'))
      .resolves.toMatchObject({
        intake_state: 'retired',
        registration_state: 'retired',
        remote_endpoint_id: null,
      });
    expect(harness.adapter.delete).toHaveBeenCalledWith(
      expect.anything(),
      'we_orphan123456789',
    );
    expect(harness.store.list()).toEqual([]);
  });

  it('serializes cleanup behind an in-flight create without losing the orphan', async () => {
    const harness = makeHarness();
    let signalCreateStarted!: () => void;
    let releaseCreate!: () => void;
    const createStarted = new Promise<void>((resolve) => { signalCreateStarted = resolve; });
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    vi.mocked(harness.adapter.find)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        correlation: 'owned',
        endpoint: harness.snapshot({ remote_endpoint_id: 'we_racing123456789' }),
      }]);
    vi.mocked(harness.adapter.create).mockImplementationOnce(async () => {
      signalCreateStarted();
      await createGate;
      return {
        endpoint: harness.snapshot({ remote_endpoint_id: 'we_racing123456789' }),
        credential_result: { endpoint_secret: 'whsec_racing-secret' },
      };
    });
    vi.mocked(harness.adapter.read)
      .mockResolvedValueOnce(harness.snapshot({ remote_endpoint_id: 'we_racing123456789' }))
      .mockResolvedValueOnce(null);

    const registration = harness.service.reconcile(harness.ingress.ingress_id);
    await createStarted;
    const cleanup = harness.service.cleanup(harness.ingress.ingress_id, 'retire');
    expect(harness.store.get(harness.ingress.ingress_id)).toMatchObject({
      intake_state: 'retired',
      registration_state: 'cleanup_pending',
    });
    releaseCreate();

    await expect(registration).rejects.toMatchObject({ code: 'state_changed' });
    await expect(cleanup).resolves.toMatchObject({
      intake_state: 'retired',
      registration_state: 'retired',
      remote_endpoint_id: null,
    });
    expect(harness.adapter.delete).toHaveBeenCalledWith(
      expect.anything(),
      'we_racing123456789',
    );
  });

  it('serializes connection cutover behind an in-flight create before deleting it', async () => {
    const harness = makeHarness();
    let signalCreateStarted!: () => void;
    let releaseCreate!: () => void;
    const createStarted = new Promise<void>((resolve) => { signalCreateStarted = resolve; });
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    vi.mocked(harness.adapter.create).mockImplementationOnce(async () => {
      signalCreateStarted();
      await createGate;
      return {
        endpoint: harness.snapshot({ remote_endpoint_id: 'we_cutoverrace123456' }),
        credential_result: { endpoint_secret: 'whsec_cutover-race' },
      };
    });
    vi.mocked(harness.adapter.read)
      .mockResolvedValueOnce(harness.snapshot({ remote_endpoint_id: 'we_cutoverrace123456' }))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const registration = harness.service.reconcile(harness.ingress.ingress_id);
    await createStarted;
    const cutover = harness.service.rebind(
      harness.ingress.ingress_id,
      'stripe-test-racing-target',
    );
    expect(harness.store.get(harness.ingress.ingress_id)).toMatchObject({
      paired_connection_id: 'stripe-test',
      pending_paired_connection_id: null,
      intake_state: 'draft',
    });
    releaseCreate();

    await expect(registration).resolves.toMatchObject({
      remote_endpoint_id: 'we_cutoverrace123456',
      registration_state: 'registered',
    });
    await expect(cutover).resolves.toMatchObject({
      paired_connection_id: 'stripe-test-racing-target',
      pending_paired_connection_id: null,
      remote_endpoint_id: null,
      registration_state: 'managed_pending',
      intake_state: 'disabled',
    });
    expect(harness.adapter.delete).toHaveBeenCalledWith(
      expect.objectContaining({ paired_connection_id: 'stripe-test' }),
      'we_cutoverrace123456',
    );
    expect(harness.store.listCredentialVersions(harness.ingress.ingress_id))
      .toEqual([expect.objectContaining({ active: false })]);
  });
});

/** D-201 Slice 10Z — the reconciler over a vendor's endpoints kept in memory:
 *  `land` adds one a create made late, and the clock is the store's and the
 *  sweep's. Ingress ids count up, for more than one webhook. */
const unsettledHarness = () => {
  const db = new Database(':memory:');
  databases.push(db);
  const clock = { now: 2_000_000_000_000 };
  let ingresses = 0;
  const store = createWebhookIngressStore(db, {
    now: () => clock.now,
    getEncryptionKey: () => key,
    newIngressId: () => `whi_${(++ingresses).toString(16).padStart(32, '0')}`,
    newPublicId: () => `opaquePublicId_${ingresses.toString(16).padStart(16, '0')}`,
    newCredentialSetRef: () => `whc_${ingresses.toString(16).padStart(32, '0')}`,
  });
  /** The server's public address: the owner can move it. D-201 Slice 10BY —
   *  with the names the server holds as its own (`ownEndpointUrls`), and an
   *  address now that is unknown or cannot be read. */
  const host: { base: string; own: string[]; now?: 'none' | 'unreadable' } = {
    base: 'https://hooks.example', own: [],
  };
  const urlOf = (row: { public_id: string }) => `${host.base}/v1/webhooks/${row.public_id}`;
  const addIngress = () => store.create({
    display_name: 'Stripe test events',
    profile_id: 'stripe.event.v1',
    environment: 'test',
    paired_connection_id: 'stripe-test',
    registration_mode: 'managed_endpoint',
    selected_event_types: ['invoice.paid'],
  });
  /** The vendor's endpoints, by id: each this ingress's (owned) or another's. */
  const remote = new Map<string, ManagedWebhookEndpointSnapshot & { ingress_id: string }>();
  let made = 0;
  const make = (ingressId: string): ManagedWebhookEndpointSnapshot & { ingress_id: string } => {
    const row = store.get(ingressId)!;
    made += 1;
    const snap = {
      ingress_id: ingressId,
      remote_endpoint_id: `we_${made.toString(16).padStart(16, '0')}`,
      environment: 'test' as const,
      endpoint_url: urlOf(row),
      event_types: row.selected_event_types.slice(),
      enabled: true,
      correlation_valid: true,
    };
    remote.set(snap.remote_endpoint_id, snap);
    return snap;
  };
  const strip = ({ ingress_id: _ingress, ...snap }: ManagedWebhookEndpointSnapshot & { ingress_id: string }) => snap;
  const adapter: WebhookManagedEndpointRegistrationAdapter = {
    profile_id: 'stripe.event.v1',
    // Owned by its address, as GitHub's and Paddle's are.
    find: vi.fn(async (context) => [...remote.values()]
      .filter((entry) => entry.ingress_id === context.desired.ingress_id
        && entry.endpoint_url === context.desired.endpoint_url)
      .map((entry) => ({ endpoint: strip(entry), correlation: 'owned' as const }))),
    create: vi.fn(async (context) => ({
      endpoint: strip(make(context.desired.ingress_id)),
      credential_result: { endpoint_secret: 'whsec_ReconcilerSecret123' },
    })),
    read: vi.fn(async (_context, id: string) => {
      const entry = remote.get(id);
      return entry === undefined ? null : strip(entry);
    }),
    update: vi.fn(async (_context, id: string) => strip(remote.get(id)!)),
    delete: vi.fn(async (_context, id: string) => { remote.delete(id); }),
  };
  const service = createWebhookManagedRegistrationService({
    store,
    adapters: createWebhookRegistrationRuntimeRegistry([adapter]),
    resolveCanonicalEndpoint: (row) => {
      if (host.now === 'unreadable') throw new Error('the address now cannot be read');
      return host.now === 'none' ? null : urlOf(row);
    },
    ownEndpointUrls: (row) => host.own.map((base) => `${base}/v1/webhooks/${row.public_id}`),
    now: () => clock.now,
  });
  return { db, store, clock, adapter, service, remote, make, addIngress, host };
};

describe('D-201 Slice 10Z — a create that may still land is kept, and a stray it leaves is removed', () => {
  it('a create refused outright or never sent is settled; one that may have landed is kept', async () => {
    const outcomes: Array<[unknown, number]> = [
      [new WebhookRegistrationAdapterError('upstream_rejected', 'refused'), 0],
      [new WebhookRegistrationAdapterError('connection_unavailable', 'no connection'), 0],
      [new WebhookRegistrationAdapterError('registration_input_invalid', 'bad input'), 0],
      // A vendor that takes no key says nothing more than this of a request
      // with no answer: it may have landed.
      [new WebhookRegistrationAdapterError('upstream_unavailable', 'did not complete'), 1],
      [new WebhookRegistrationAdapterError('upstream_unavailable', 'no response', [], { no_response: true }), 1],
      [new WebhookRegistrationAdapterError('upstream_unavailable', 'still running', [], { in_progress: true }), 1],
      [new WebhookRegistrationAdapterError('upstream_response_invalid', 'unreadable'), 1],
      [new Error('unexpected'), 1],
    ];
    for (const [error, kept] of outcomes) {
      const h = unsettledHarness();
      const ingress = h.addIngress();
      vi.mocked(h.adapter.create).mockRejectedValueOnce(error);
      await expect(h.service.reconcile(ingress.ingress_id)).rejects.toBeDefined();
      expect(h.store.listUnsettledCreates()).toHaveLength(kept);
    }
  });

  it('a create committed is settled, and so is one removed after its read-back failed; one whose removal failed is kept', async () => {
    const committed = unsettledHarness();
    await committed.service.reconcile(committed.addIngress().ingress_id);
    expect(committed.store.listUnsettledCreates()).toEqual([]);

    const removed = unsettledHarness();
    vi.mocked(removed.adapter.read).mockRejectedValueOnce(
      new WebhookRegistrationAdapterError('upstream_unavailable', 'read failed'));
    await expect(removed.service.reconcile(removed.addIngress().ingress_id)).rejects.toBeDefined();
    expect(removed.remote.size).toBe(0);
    expect(removed.store.listUnsettledCreates()).toEqual([]);

    const left = unsettledHarness();
    vi.mocked(left.adapter.read).mockRejectedValueOnce(
      new WebhookRegistrationAdapterError('upstream_unavailable', 'read failed'));
    vi.mocked(left.adapter.delete).mockRejectedValueOnce(
      new WebhookRegistrationAdapterError('upstream_unavailable', 'delete failed'));
    await expect(left.service.reconcile(left.addIngress().ingress_id)).rejects.toBeDefined();
    expect(left.remote.size).toBe(1);
    expect(left.store.listUnsettledCreates()).toHaveLength(1);
    // The sweep removes it.
    await expect(left.service.sweepUnsettledCreates()).resolves.toMatchObject({ removed: 1 });
    expect(left.remote.size).toBe(0);
  });

  it('a keyless create with no answer that lands after the next pass committed another is removed, the committed one kept (the GitHub and Paddle limit)', async () => {
    const h = unsettledHarness();
    const ingress = h.addIngress();
    vi.mocked(h.adapter.create).mockRejectedValueOnce(
      new WebhookRegistrationAdapterError('upstream_unavailable', 'did not complete'));
    await expect(h.service.reconcile(ingress.ingress_id)).rejects.toBeDefined();
    await expect(h.service.reconcile(ingress.ingress_id)).resolves.toMatchObject({ registration_state: 'registered' });
    const kept = h.store.get(ingress.ingress_id)!.remote_endpoint_id!;
    const late = h.make(ingress.ingress_id).remote_endpoint_id;
    await expect(h.service.sweepUnsettledCreates()).resolves.toEqual({ removed: 1, settled: 0, given_up: 0, failed: 0 });
    expect([...h.remote.keys()]).toEqual([kept]);
    expect(h.remote.has(late)).toBe(false);
  });

  it('a create at an address the owner has since moved is searched for at that address', async () => {
    const h = unsettledHarness();
    const ingress = h.addIngress();
    vi.mocked(h.adapter.create).mockRejectedValueOnce(
      new WebhookRegistrationAdapterError('upstream_unavailable', 'did not complete'));
    await expect(h.service.reconcile(ingress.ingress_id)).rejects.toBeDefined();
    // It lands at the address it was sent with; the owner moves the server's.
    const late = h.make(ingress.ingress_id);
    h.host.base = 'https://moved.example';
    await expect(h.service.reconcile(ingress.ingress_id)).resolves.toMatchObject({ registration_state: 'registered' });
    await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ removed: 1 });
    expect(h.remote.has(late.remote_endpoint_id)).toBe(false);
    expect([...h.remote.values()].map((entry) => entry.endpoint_url))
      .toEqual([`https://moved.example/v1/webhooks/${ingress.public_id}`]);
  });

  // D-201 Slice 10AD (10AA finding 11) — each account and each address its
  // creates went to is searched, and only what is provably this webhook's
  // goes. Dropping the ownership filter, the connection or the address from
  // the grouping left 1,343 tests green.
  it("searches each account and each address its lost creates went to, and removes only this webhook's own", async () => {
    const h = unsettledHarness();
    const ingress = h.addIngress();
    const oldUrl = `https://hooks.example/v1/webhooks/${ingress.public_id}`;
    const newUrl = `https://moved.example/v1/webhooks/${ingress.public_id}`;
    // Creates lost through two connections (a rebind between them), and at two
    // addresses (the owner moved the server's between them).
    h.store.recordUnsettledCreate({ ingress_id: ingress.ingress_id, connection_id: 'stripe-a', endpoint_url: oldUrl });
    h.store.recordUnsettledCreate({ ingress_id: ingress.ingress_id, connection_id: 'stripe-b', endpoint_url: oldUrl });
    h.store.recordUnsettledCreate({ ingress_id: ingress.ingress_id, connection_id: 'stripe-a', endpoint_url: newUrl });
    type Endpoint = { id: string; connection: string; url: string; owned: boolean };
    const endpoints: Endpoint[] = [
      { id: 'we_a_old', connection: 'stripe-a', url: oldUrl, owned: true },
      { id: 'we_b_old', connection: 'stripe-b', url: oldUrl, owned: true },
      { id: 'we_a_new', connection: 'stripe-a', url: newUrl, owned: true },
      // One the owner made by hand at the address, in the same account.
      { id: 'we_by_hand', connection: 'stripe-a', url: oldUrl, owned: false },
    ];
    const snapshot = (endpoint: Endpoint): ManagedWebhookEndpointSnapshot => ({
      remote_endpoint_id: endpoint.id,
      environment: 'test',
      endpoint_url: endpoint.url,
      event_types: ['invoice.paid'],
      enabled: true,
      correlation_valid: endpoint.owned,
    });
    const reached = (connection: string) => endpoints.filter((endpoint) => endpoint.connection === connection);
    vi.mocked(h.adapter.find).mockImplementation(async (context) => reached(context.paired_connection_id)
      .filter((endpoint) => endpoint.url === context.desired.endpoint_url)
      .map((endpoint) => ({
        endpoint: snapshot(endpoint),
        correlation: endpoint.owned ? 'owned' as const : 'metadata_conflict' as const,
      })));
    vi.mocked(h.adapter.delete).mockImplementation(async (context, id: string) => {
      const index = endpoints.findIndex((endpoint) => endpoint.id === id && endpoint.connection === context.paired_connection_id);
      if (index >= 0) endpoints.splice(index, 1);
    });
    vi.mocked(h.adapter.read).mockImplementation(async (context, id: string) => {
      const found = reached(context.paired_connection_id).find((endpoint) => endpoint.id === id);
      return found === undefined ? null : snapshot(found);
    });
    await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ removed: 3, failed: 0 });
    expect(endpoints.map((endpoint) => endpoint.id)).toEqual(['we_by_hand']);
  });

  // D-201 Slice 10AD (10AA finding 24) — a week of failed searches, never a
  // week since the send: a server off for a week gave it up at its first.
  // D-201 Slice 10AH (10AE finding 9) — nor a week since the first failed
  // search: one failure, a week with no sweeps and one more gave it up.
  it('gives a create up after a week of failed searches, each gap counting at most an hour, and a search that reaches it starts afresh', async () => {
    const h = unsettledHarness();
    const ingress = h.addIngress();
    vi.mocked(h.adapter.create).mockRejectedValueOnce(
      new WebhookRegistrationAdapterError('upstream_unavailable', 'did not complete'));
    await expect(h.service.reconcile(ingress.ingress_id)).rejects.toBeDefined();
    const find = vi.mocked(h.adapter.find).getMockImplementation()!;
    let reached = false;
    vi.mocked(h.adapter.find).mockImplementation(async (context) => {
      if (!reached) throw new WebhookRegistrationAdapterError('upstream_unavailable', 'the account cannot be reached');
      return find(context);
    });
    const sweep = () => h.service.sweepUnsettledCreates();
    const record = () => h.store.listUnsettledCreates()[0];
    const HOUR = 60 * 60 * 1000;
    // Within its window: one failed search, then one that reaches it.
    h.clock.now += 60_000;
    await expect(sweep()).resolves.toEqual({ removed: 0, settled: 0, given_up: 0, failed: 1 });
    expect(record()).toMatchObject({ unreached_ms: 0, unreached_last_at: h.clock.now, unreached_since: h.clock.now });
    h.clock.now += 60_000;
    reached = true;
    await expect(sweep()).resolves.toEqual({ removed: 0, settled: 0, given_up: 0, failed: 0 });
    expect(record()).toMatchObject({ unreached_ms: 0, unreached_last_at: null, unreached_since: null });
    reached = false;
    // A failed search, a week with no sweeps, and one more: an hour of failures.
    h.clock.now += 60_000;
    await expect(sweep()).resolves.toMatchObject({ given_up: 0, failed: 1 });
    h.clock.now += WEBHOOK_UNSETTLED_CREATE_GIVE_UP_MS;
    await expect(sweep()).resolves.toMatchObject({ given_up: 0, failed: 1 });
    expect(record()).toMatchObject({ unreached_ms: HOUR });
    // A gap shorter than an hour counts as it is.
    h.clock.now += 2 * 60_000;
    await expect(sweep()).resolves.toMatchObject({ given_up: 0, failed: 1 });
    expect(record()).toMatchObject({ unreached_ms: HOUR + 2 * 60_000 });
    // Failing every hour: kept until a week of failures.
    for (let hour = 1; hour <= 166; hour += 1) {
      h.clock.now += HOUR;
      await expect(sweep()).resolves.toMatchObject({ given_up: 0, failed: 1 });
    }
    expect(record()).toMatchObject({ unreached_ms: 167 * HOUR + 2 * 60_000 });
    h.clock.now += HOUR;
    await expect(sweep()).resolves.toMatchObject({ given_up: 1, failed: 0 });
    expect(h.store.listUnsettledCreates()).toEqual([]);
  });

  // D-201 Slice 10AH (10AE finding 19) — the limit says so: a stray the search
  // reaches but cannot remove is given up as an account it cannot reach is.
  it('a stray the search reaches but cannot remove is given up after a week of failed tries too', async () => {
    const h = unsettledHarness();
    const ingress = h.addIngress();
    vi.mocked(h.adapter.create).mockRejectedValueOnce(
      new WebhookRegistrationAdapterError('upstream_unavailable', 'did not complete'));
    await expect(h.service.reconcile(ingress.ingress_id)).rejects.toBeDefined();
    const stray = h.make(ingress.ingress_id);
    vi.mocked(h.adapter.delete).mockRejectedValue(
      new WebhookRegistrationAdapterError('upstream_rejected', 'the endpoint cannot be deleted'));
    const HOUR = 60 * 60 * 1000;
    await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ removed: 0, failed: 1 });
    // D-201 Slice 10AL (10AI finding 20) — the stray it found standing is
    // recorded, counted for the owner, and swept with the create from then on.
    expect(h.store.countStrayEndpoints(ingress.ingress_id)).toBe(1);
    for (let hour = 1; hour < 168; hour += 1) {
      h.clock.now += HOUR;
      await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ given_up: 0, failed: 2 });
    }
    h.clock.now += HOUR;
    await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ given_up: 1, failed: 1 });
    // The stray's own week ends an hour later: kept, given up, and said
    // (D-201 Slice 10AL, 10AI finding 21). It went silently with its record.
    h.clock.now += HOUR;
    await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ given_up: 1, failed: 0 });
    expect(h.store.listUnsettledCreates()).toEqual([]);
    expect(h.store.countStrayEndpoints(ingress.ingress_id)).toBe(0);
    expect(h.store.countGivenUpStrayEndpoints(ingress.ingress_id)).toBe(1);
    expect(h.remote.has(stray.remote_endpoint_id)).toBe(true);
  });

  // D-201 Slice 10AH (10AE finding 20) — the reached note threw out of the
  // whole sweep, and every account after it waited a round.
  it("a write the sweep cannot make keeps that record as it was, and the other accounts are swept", async () => {
    const h = unsettledHarness();
    const first = h.addIngress();
    const second = h.addIngress();
    for (const ingress of [first, second]) {
      vi.mocked(h.adapter.create).mockRejectedValueOnce(
        new WebhookRegistrationAdapterError('upstream_unavailable', 'did not complete'));
      await expect(h.service.reconcile(ingress.ingress_id)).rejects.toBeDefined();
      h.clock.now += 1_000;
    }
    const busy = () => Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    // The first's account fails once, then is reached, and the note of that
    // cannot be written; the second's stray has landed meanwhile.
    vi.mocked(h.adapter.find).mockRejectedValueOnce(
      new WebhookRegistrationAdapterError('upstream_unavailable', 'the account cannot be reached'));
    await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ failed: 1 });
    const stray = h.make(second.ingress_id);
    const reachedNote = h.store.noteUnsettledCreateReached;
    h.store.noteUnsettledCreateReached = () => { throw busy(); };
    // Nothing failed in either account: the note waits for the next search.
    await expect(h.service.sweepUnsettledCreates()).resolves.toEqual({ removed: 1, settled: 0, given_up: 0, failed: 0 });
    expect(h.remote.has(stray.remote_endpoint_id)).toBe(false);
    h.store.noteUnsettledCreateReached = reachedNote;
    expect(h.store.listUnsettledCreates()
      .find((row) => row.ingress_id === first.ingress_id)).toMatchObject({ unreached_last_at: expect.any(Number) });
    // A settle that cannot be written keeps that record; the next sweep settles it.
    h.clock.now += WEBHOOK_UNSETTLED_CREATE_WINDOW_MS;
    const settle = h.store.settleUnsettledCreate;
    h.store.settleUnsettledCreate = (createId) => {
      if (h.store.listUnsettledCreates()[0]?.create_id === createId) throw busy();
      settle(createId);
    };
    await expect(h.service.sweepUnsettledCreates()).resolves.toEqual({ removed: 0, settled: 1, given_up: 0, failed: 0 });
    h.store.settleUnsettledCreate = settle;
    expect(h.store.listUnsettledCreates().map((row) => row.ingress_id)).toEqual([first.ingress_id]);
    await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ settled: 1 });
    expect(h.store.listUnsettledCreates()).toEqual([]);
    // Any other fault in one account is that account's, for the next sweep.
    for (const ingress of [first, second]) {
      vi.mocked(h.adapter.create).mockRejectedValueOnce(
        new WebhookRegistrationAdapterError('upstream_unavailable', 'did not complete'));
      await expect(h.service.reconcile(ingress.ingress_id)).rejects.toBeDefined();
    }
    const strayTwo = h.make(second.ingress_id);
    const get = h.store.get;
    h.store.get = (ingressId) => {
      if (ingressId === first.ingress_id) throw busy();
      return get(ingressId);
    };
    await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ removed: 1, failed: 1 });
    h.store.get = get;
    expect(h.remote.has(strayTwo.remote_endpoint_id)).toBe(false);
  });

  // D-201 Slice 10AD (10AA finding 27) — the owner's call: never refused.
  it("a rebind to another key on the same account removes a stray its lost create left there, and goes on", async () => {
    const h = unsettledHarness();
    const ingress = h.addIngress();
    vi.mocked(h.adapter.create).mockRejectedValueOnce(
      new WebhookRegistrationAdapterError('upstream_unavailable', 'did not complete'));
    await expect(h.service.reconcile(ingress.ingress_id)).rejects.toBeDefined();
    const stray = h.make(ingress.ingress_id);
    await expect(h.service.rebind(ingress.ingress_id, 'stripe-test-rotated'))
      .resolves.toMatchObject({ paired_connection_id: 'stripe-test-rotated' });
    expect(h.remote.has(stray.remote_endpoint_id)).toBe(false);
  });

  // On the same account the rebind's cleanup, searching the account it
  // leaves, would remove the stray anyway: here only the new connection
  // reaches it, as when a lost create of this webhook stands on an account it
  // is moved back to.
  it('a stray of its own only the new connection can reach is removed by the rebind itself', async () => {
    const h = unsettledHarness();
    const ingress = h.addIngress();
    const { ingress_id: _owner, ...stray } = h.make(ingress.ingress_id);
    vi.mocked(h.adapter.find).mockImplementation(async (context) => (
      context.paired_connection_id === 'stripe-test-rotated' && h.remote.has(stray.remote_endpoint_id)
        ? [{ endpoint: stray, correlation: 'owned' as const }]
        : []));
    await expect(h.service.rebind(ingress.ingress_id, 'stripe-test-rotated'))
      .resolves.toMatchObject({ paired_connection_id: 'stripe-test-rotated' });
    expect(h.remote.has(stray.remote_endpoint_id)).toBe(false);
    expect(h.adapter.delete).toHaveBeenCalledWith(
      expect.objectContaining({ paired_connection_id: 'stripe-test-rotated' }),
      stray.remote_endpoint_id,
    );
  });

  // D-201 Slice 10AH (10AE finding 8) — one it could not remove stood with no
  // record: the sweep never searched for it, and the owner was told nothing.
  it('a stray the rebind could not remove is kept for the sweep and counted for the owner, and the sweep removes it', async () => {
    for (const fault of ['refused', 'still there'] as const) {
      const h = unsettledHarness();
      const ingress = h.addIngress();
      const { ingress_id: _owner, ...stray } = h.make(ingress.ingress_id);
      vi.mocked(h.adapter.find).mockImplementation(async (context) => (
        context.paired_connection_id === 'stripe-test-rotated' && h.remote.has(stray.remote_endpoint_id)
          ? [{ endpoint: stray, correlation: 'owned' as const }]
          : []));
      if (fault === 'refused') {
        vi.mocked(h.adapter.delete).mockRejectedValueOnce(
          new WebhookRegistrationAdapterError('upstream_unavailable', 'the removal did not go through'));
      } else {
        vi.mocked(h.adapter.delete).mockResolvedValueOnce(undefined);
      }
      // Never refused for it: the owner's call.
      await expect(h.service.rebind(ingress.ingress_id, 'stripe-test-rotated'))
        .resolves.toMatchObject({ paired_connection_id: 'stripe-test-rotated' });
      expect(h.remote.has(stray.remote_endpoint_id)).toBe(true);
      expect(h.store.listUnsettledCreates()).toEqual([expect.objectContaining({
        kind: 'stray',
        connection_id: 'stripe-test-rotated',
        endpoint_url: stray.endpoint_url,
      })]);
      expect(h.store.countStrayEndpoints(ingress.ingress_id)).toBe(1);
      // Removed by the next sweep, and settled at once: it had landed.
      await expect(h.service.sweepUnsettledCreates())
        .resolves.toEqual({ removed: 1, settled: 1, given_up: 0, failed: 0 });
      expect(h.remote.has(stray.remote_endpoint_id)).toBe(false);
      expect(h.store.listUnsettledCreates()).toEqual([]);
      expect(h.store.countStrayEndpoints(ingress.ingress_id)).toBe(0);
    }
  });

  it('a stray the rebind removed leaves no record', async () => {
    const h = unsettledHarness();
    const ingress = h.addIngress();
    const { ingress_id: _owner, ...stray } = h.make(ingress.ingress_id);
    vi.mocked(h.adapter.find).mockImplementation(async (context) => (
      context.paired_connection_id === 'stripe-test-rotated' && h.remote.has(stray.remote_endpoint_id)
        ? [{ endpoint: stray, correlation: 'owned' as const }]
        : []));
    await expect(h.service.rebind(ingress.ingress_id, 'stripe-test-rotated')).resolves.toBeDefined();
    expect(h.remote.has(stray.remote_endpoint_id)).toBe(false);
    expect(h.store.listUnsettledCreates()).toEqual([]);
  });

  // D-201 Slice 10AH (10AE finding 8) — no shipped adapter reaches it: each one's
  // read finds nothing only when the endpoint is gone. A vendor whose read
  // misses what its search lists would have the rebind remove the endpoint the
  // webhook committed, as a stray.
  it('the endpoint it committed, listed where its read finds nothing, refuses the rebind and stays', async () => {
    const h = unsettledHarness();
    const ingress = h.addIngress();
    await expect(h.service.reconcile(ingress.ingress_id)).resolves.toMatchObject({ registration_state: 'registered' });
    const committed = h.store.get(ingress.ingress_id)!.remote_endpoint_id!;
    vi.mocked(h.adapter.read).mockResolvedValueOnce(null);
    await expect(h.service.rebind(ingress.ingress_id, 'stripe-test-rotated'))
      .rejects.toMatchObject({ code: 'ambiguous' });
    expect(h.remote.has(committed)).toBe(true);
    expect(h.adapter.delete).not.toHaveBeenCalled();
    expect(h.store.listUnsettledCreates()).toEqual([]);
    expect(h.store.get(ingress.ingress_id)).toMatchObject({
      paired_connection_id: 'stripe-test',
      remote_endpoint_id: committed,
    });
  });

  // D-201 Slice 10AH (10AE finding 22) — a confirmation by a read: it cleared
  // only the deleted connection, so the webhook read registered beside a stale
  // code.
  it('an alias rebind clears every code a confirmation clears', async () => {
    for (const code of [
      'managed_registration_ambiguous',
      'managed_registration_unconfirmed',
      'managed_registration_drift',
      // D-201 Slice 10BQ (10BM finding 16) — left out, and the rebind's own list
      // could drop it with every test green.
      'managed_registration_certificate_unheld',
      'managed_registration_event_types_unknown',
      'managed_registration_event_types_unrestored',
      'managed_registration_event_types_on_default',
      'managed_remote_missing',
      'paired_connection_deleted',
    ]) {
      const h = unsettledHarness();
      const ingress = h.addIngress();
      await h.service.reconcile(ingress.ingress_id);
      h.db.prepare(`
        UPDATE webhook_ingresses SET last_error_code = ?, last_error_event_types_json = '["invoice.paid"]'
        WHERE ingress_id = ?
      `).run(code, ingress.ingress_id);
      await expect(h.service.rebind(ingress.ingress_id, 'stripe-test-rotated')).resolves.toMatchObject({
        paired_connection_id: 'stripe-test-rotated',
        registration_state: 'registered',
        last_error_code: null,
      });
      expect(h.store.get(ingress.ingress_id)).not.toHaveProperty('last_error_event_types');
    }
  });

  // D-201 Slice 10BT (10BS finding 11) — a confirmation by read, as the
  // read-back's own is: while it still holds the certificate, the word for it
  // stays. 10BQ pinned it cleared, the certificate standing.
  it("an alias rebind keeps the certificate's word while the read-back still holds the certificate", async () => {
    const h = unsettledHarness();
    const ingress = h.addIngress();
    await h.service.reconcile(ingress.ingress_id);
    h.db.prepare(`UPDATE webhook_ingresses SET last_error_code = 'managed_registration_certificate_unheld' WHERE ingress_id = ?`)
      .run(ingress.ingress_id);
    const read = vi.mocked(h.adapter.read).getMockImplementation()!;
    vi.mocked(h.adapter.read).mockImplementation(async (context, id) => {
      const snap = await read(context, id);
      return snap === null ? null : { ...snap, holds_unsendable: true as const };
    });
    await expect(h.service.rebind(ingress.ingress_id, 'stripe-test-rotated')).resolves.toMatchObject({
      paired_connection_id: 'stripe-test-rotated',
      registration_state: 'registered',
      last_error_code: 'managed_registration_certificate_unheld',
    });
  });

  it("one there that is not provably this webhook's still refuses the rebind, and is left alone", async () => {
    const h = unsettledHarness();
    const ingress = h.addIngress();
    const theirs = h.make(ingress.ingress_id);
    vi.mocked(h.adapter.find).mockResolvedValueOnce([{
      endpoint: { ...theirs, ingress_id: undefined } as unknown as ManagedWebhookEndpointSnapshot,
      correlation: 'url_only',
    }]);
    await expect(h.service.rebind(ingress.ingress_id, 'stripe-test-rotated'))
      .rejects.toMatchObject({ code: 'ambiguous' });
    expect(h.remote.has(theirs.remote_endpoint_id)).toBe(true);
    expect(h.store.get(ingress.ingress_id)).toMatchObject({ paired_connection_id: 'stripe-test' });
  });

  it('a stray that is still there after its removal is kept for the next sweep', async () => {
    const h = unsettledHarness();
    const ingress = h.addIngress();
    vi.mocked(h.adapter.create).mockRejectedValueOnce(
      new WebhookRegistrationAdapterError('upstream_unavailable', 'did not complete'));
    await expect(h.service.reconcile(ingress.ingress_id)).rejects.toBeDefined();
    h.make(ingress.ingress_id);
    vi.mocked(h.adapter.delete).mockResolvedValueOnce(undefined);
    h.clock.now += WEBHOOK_UNSETTLED_CREATE_WINDOW_MS;
    await expect(h.service.sweepUnsettledCreates()).resolves.toEqual({ removed: 0, settled: 0, given_up: 0, failed: 1 });
    // D-201 Slice 10AL (10AI finding 20) — and the stray it found standing is
    // recorded beside it, counted for the owner.
    expect(h.store.listUnsettledCreates().map((record) => record.kind)).toEqual(['create', 'stray']);
    expect(h.store.countStrayEndpoints(ingress.ingress_id)).toBe(1);
    await expect(h.service.sweepUnsettledCreates()).resolves.toEqual({ removed: 1, settled: 2, given_up: 0, failed: 0 });
    expect(h.store.countStrayEndpoints(ingress.ingress_id)).toBe(0);
  });

  it("waits for a pass of the same ingress, never sweeps twice at once, and a stop ends it between ingresses", async () => {
    const h = unsettledHarness();
    const first = h.addIngress();
    const second = h.addIngress();
    // The first ingress's create is the older, so its account is swept first.
    for (const ingress of [first, second]) {
      vi.mocked(h.adapter.create).mockRejectedValueOnce(
        new WebhookRegistrationAdapterError('upstream_unavailable', 'did not complete'));
      await expect(h.service.reconcile(ingress.ingress_id)).rejects.toBeDefined();
      h.clock.now += 1_000;
    }
    // A pass of the first is making its endpoint when the sweep starts.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(h.adapter.create).mockImplementationOnce(async (context) => {
      await held;
      return {
        endpoint: (({ ingress_id: _i, ...snap }) => snap)(h.make(context.desired.ingress_id)),
        credential_result: { endpoint_secret: 'whsec_ReconcilerSecret123' },
      };
    });
    const pass = h.service.reconcile(first.ingress_id);
    await vi.waitFor(() => expect(h.adapter.create).toHaveBeenCalledTimes(3));
    vi.mocked(h.adapter.find).mockClear();
    let stopping = false;
    const sweep = h.service.sweepUnsettledCreates({ isStopping: () => stopping });
    expect(h.service.sweepUnsettledCreates()).toBe(sweep);
    await Promise.resolve();
    expect(h.adapter.find).not.toHaveBeenCalled();
    stopping = true;
    release();
    await expect(pass).resolves.toMatchObject({ registration_state: 'registered' });
    // The first ingress's account is searched after its pass, its endpoint kept;
    // the stop came before the second's.
    await expect(sweep).resolves.toEqual({ removed: 0, settled: 0, given_up: 0, failed: 0 });
    expect(vi.mocked(h.adapter.find).mock.calls.map(([context]) => context.desired.ingress_id))
      .toEqual([first.ingress_id]);
    expect(h.remote.size).toBe(1);
  });
});

describe('D-201 Slice 10AL — the sweep\'s edges (10AI findings 18 to 21)', () => {
  const HOUR = 60 * 60 * 1000;
  /** A create that may have landed, its account failing every search from now on. */
  const lostCreate = async () => {
    const h = unsettledHarness();
    const ingress = h.addIngress();
    vi.mocked(h.adapter.create).mockRejectedValueOnce(
      new WebhookRegistrationAdapterError('upstream_unavailable', 'did not complete'));
    await expect(h.service.reconcile(ingress.ingress_id)).rejects.toBeDefined();
    return { h, ingress, record: () => h.store.listUnsettledCreates()[0]! };
  };
  const unreachable = (h: ReturnType<typeof unsettledHarness>) => {
    vi.mocked(h.adapter.find).mockRejectedValue(
      new WebhookRegistrationAdapterError('upstream_unavailable', 'the account cannot be reached'));
  };
  /** A stray at the connection a rebind moves to, as the 10AH cases set it. */
  const strayAtTheTarget = (h: ReturnType<typeof unsettledHarness>, ingressId: string) => {
    const { ingress_id: _owner, ...stray } = h.make(ingressId);
    vi.mocked(h.adapter.find).mockImplementation(async (context) => (
      context.paired_connection_id === 'stripe-test-rotated' && h.remote.has(stray.remote_endpoint_id)
        ? [{ endpoint: stray, correlation: 'owned' as const }]
        : []));
    return stray;
  };
  const refusedOnce = (h: ReturnType<typeof unsettledHarness>) => {
    vi.mocked(h.adapter.delete).mockRejectedValueOnce(
      new WebhookRegistrationAdapterError('upstream_unavailable', 'the removal did not go through'));
  };

  it("a run of failures a server before 10AH ended counts from nothing: one failed search never gives it up (finding 18)", async () => {
    for (const older of ['its reached note', 'its reached note, then its failed search'] as const) {
      const { h, record } = await lostCreate();
      const id = record().create_id;
      // Most of a week of failures noted here.
      h.store.noteUnsettledCreateUnreached(id, h.clock.now, 167 * HOUR + 30 * 60_000);
      // A server before 10AH reaches its account: it clears `unreached_since`
      // alone. Then, maybe, its next search fails, and it notes when.
      h.db.prepare('UPDATE webhook_registration_unsettled_creates SET unreached_since = NULL WHERE create_id = ?').run(id);
      h.clock.now += 2 * HOUR;
      if (older !== 'its reached note') {
        h.db.prepare('UPDATE webhook_registration_unsettled_creates SET unreached_since = ? WHERE create_id = ?')
          .run(h.clock.now, id);
      }
      unreachable(h);
      h.clock.now += older === 'its reached note' ? HOUR : 20 * 60_000;
      // Before 10AL: given up at once, the stale week carried over.
      await expect(h.service.sweepUnsettledCreates(), older)
        .resolves.toEqual({ removed: 0, settled: 0, given_up: 0, failed: 1 });
      // Its run counted from that server's first failed search.
      expect(record().unreached_ms, older).toBe(older === 'its reached note' ? 0 : 20 * 60_000);
    }
  });

  it('a stray already gone when the sweep searches is settled at once, its hour never waited out (finding 19)', async () => {
    const h = unsettledHarness();
    const ingress = h.addIngress();
    const stray = strayAtTheTarget(h, ingress.ingress_id);
    refusedOnce(h);
    await expect(h.service.rebind(ingress.ingress_id, 'stripe-test-rotated')).resolves.toBeDefined();
    expect(h.store.countStrayEndpoints(ingress.ingress_id)).toBe(1);
    // Removed meanwhile (the owner, or a later pass): the next sweep finds nothing.
    h.remote.delete(stray.remote_endpoint_id);
    h.clock.now += 60_000;
    await expect(h.service.sweepUnsettledCreates()).resolves.toEqual({ removed: 0, settled: 1, given_up: 0, failed: 0 });
    expect(h.store.countStrayEndpoints(ingress.ingress_id)).toBe(0);
  });

  it('a clock set back never takes failed time off a record (finding 19)', async () => {
    const { h, record } = await lostCreate();
    unreachable(h);
    h.clock.now += 60_000;
    await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ failed: 1 });
    h.clock.now += 30 * 60_000;
    await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ failed: 1 });
    expect(record().unreached_ms).toBe(30 * 60_000);
    h.clock.now -= 20 * 60_000;
    await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ failed: 1 });
    expect(record().unreached_ms).toBe(30 * 60_000);
  });

  it("a rebind whose stray's record cannot be written goes on, and removes it (finding 19)", async () => {
    const h = unsettledHarness();
    const ingress = h.addIngress();
    const stray = strayAtTheTarget(h, ingress.ingress_id);
    vi.spyOn(h.store, 'recordUnsettledCreate').mockImplementationOnce(() => {
      throw new Error('the database is busy');
    });
    // Never refused for it: the owner's call.
    await expect(h.service.rebind(ingress.ingress_id, 'stripe-test-rotated'))
      .resolves.toMatchObject({ paired_connection_id: 'stripe-test-rotated' });
    expect(h.remote.has(stray.remote_endpoint_id)).toBe(false);
  });

  it('a rebind tried again after it failed counts its stray once, and one it removes then leaves the card at once (finding 20)', async () => {
    for (const second of ['left again', 'removed'] as const) {
      const h = unsettledHarness();
      const ingress = h.addIngress();
      const stray = strayAtTheTarget(h, ingress.ingress_id);
      refusedOnce(h);
      // It fails after its stray loop: the connection never changed.
      vi.spyOn(h.store, 'prepareManagedConnectionRebind').mockImplementationOnce(() => {
        throw new Error('the database is busy');
      });
      await expect(h.service.rebind(ingress.ingress_id, 'stripe-test-rotated'), second).rejects.toBeDefined();
      expect(h.store.get(ingress.ingress_id)?.paired_connection_id, second).toBe('stripe-test');
      expect(h.store.countStrayEndpoints(ingress.ingress_id), second).toBe(1);
      if (second === 'left again') refusedOnce(h);
      await expect(h.service.rebind(ingress.ingress_id, 'stripe-test-rotated'), second)
        .resolves.toMatchObject({ paired_connection_id: 'stripe-test-rotated' });
      // Before 10AL: two when it was left again, and one when it was removed,
      // until the next sweep.
      expect(h.store.countStrayEndpoints(ingress.ingress_id), second).toBe(second === 'left again' ? 1 : 0);
      expect(h.remote.has(stray.remote_endpoint_id), second).toBe(second === 'left again');
    }
  });

  it('a stray the sweep finds and cannot remove is counted for the owner once, and leaves the count when it is removed (finding 20)', async () => {
    const { h, ingress } = await lostCreate();
    const landed = h.make(ingress.ingress_id);
    vi.mocked(h.adapter.delete).mockRejectedValue(
      new WebhookRegistrationAdapterError('upstream_unavailable', 'the removal did not go through'));
    h.clock.now += 60_000;
    await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ removed: 0, failed: 1 });
    // Before 10AL: counted nowhere, the card saying nothing.
    expect(h.store.countStrayEndpoints(ingress.ingress_id)).toBe(1);
    h.clock.now += 60_000;
    await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ removed: 0, failed: 2 });
    expect(h.store.countStrayEndpoints(ingress.ingress_id)).toBe(1);
    vi.mocked(h.adapter.delete).mockImplementation(async (_context, id: string) => { h.remote.delete(id); });
    h.clock.now += HOUR;
    await expect(h.service.sweepUnsettledCreates()).resolves.toEqual({ removed: 1, settled: 2, given_up: 0, failed: 0 });
    expect(h.store.countStrayEndpoints(ingress.ingress_id)).toBe(0);
    expect(h.remote.has(landed.remote_endpoint_id)).toBe(false);
    expect(h.store.listUnsettledCreates()).toEqual([]);
  });

  it('a stray given up after a week of failed tries is kept and said, and no longer swept (finding 21)', async () => {
    const h = unsettledHarness();
    const ingress = h.addIngress();
    const stray = strayAtTheTarget(h, ingress.ingress_id);
    refusedOnce(h);
    await expect(h.service.rebind(ingress.ingress_id, 'stripe-test-rotated')).resolves.toBeDefined();
    unreachable(h);
    await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ given_up: 0, failed: 1 });
    for (let hour = 1; hour < 168; hour += 1) {
      h.clock.now += HOUR;
      await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ given_up: 0, failed: 1 });
    }
    h.clock.now += HOUR;
    await expect(h.service.sweepUnsettledCreates()).resolves.toEqual({ removed: 0, settled: 0, given_up: 1, failed: 0 });
    // Before 10AL its record went, and the card's row with it.
    expect(h.store.countStrayEndpoints(ingress.ingress_id)).toBe(0);
    expect(h.store.countGivenUpStrayEndpoints(ingress.ingress_id)).toBe(1);
    expect(h.remote.has(stray.remote_endpoint_id)).toBe(true);
    vi.mocked(h.adapter.find).mockClear();
    h.clock.now += HOUR;
    await expect(h.service.sweepUnsettledCreates()).resolves.toEqual({ removed: 0, settled: 0, given_up: 0, failed: 0 });
    expect(h.adapter.find).not.toHaveBeenCalled();
  });

  it('a stray given up that a later search of its account meets standing, and cannot remove, stays given up', async () => {
    const h = unsettledHarness();
    const ingress = h.addIngress();
    const stray = strayAtTheTarget(h, ingress.ingress_id);
    refusedOnce(h);
    await expect(h.service.rebind(ingress.ingress_id, 'stripe-test-rotated')).resolves.toBeDefined();
    const [kept] = h.store.listUnsettledCreates();
    h.store.giveUpStrayEndpoint(kept!.create_id, h.clock.now);
    h.store.recordUnsettledCreate({
      ingress_id: ingress.ingress_id, connection_id: 'stripe-test-rotated', endpoint_url: stray.endpoint_url,
    });
    refusedOnce(h);
    h.clock.now += HOUR;
    await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ removed: 0, failed: 1 });
    // Taken up again, it would start another week of tries, the card back to
    // saying Recued keeps trying.
    expect(h.store.countGivenUpStrayEndpoints(ingress.ingress_id)).toBe(1);
    expect(h.store.countStrayEndpoints(ingress.ingress_id)).toBe(0);
    expect(h.remote.has(stray.remote_endpoint_id)).toBe(true);
  });

  it('a stray given up that a later search of its account removes leaves the card at once', async () => {
    const h = unsettledHarness();
    const ingress = h.addIngress();
    const stray = strayAtTheTarget(h, ingress.ingress_id);
    refusedOnce(h);
    await expect(h.service.rebind(ingress.ingress_id, 'stripe-test-rotated')).resolves.toBeDefined();
    const [kept] = h.store.listUnsettledCreates();
    h.store.giveUpStrayEndpoint(kept!.create_id, h.clock.now);
    expect(h.store.countGivenUpStrayEndpoints(ingress.ingress_id)).toBe(1);
    // A later create lost at that account and address has its account searched.
    h.store.recordUnsettledCreate({
      ingress_id: ingress.ingress_id, connection_id: 'stripe-test-rotated', endpoint_url: stray.endpoint_url,
    });
    h.clock.now += HOUR;
    await expect(h.service.sweepUnsettledCreates()).resolves.toEqual({ removed: 1, settled: 1, given_up: 0, failed: 0 });
    expect(h.remote.has(stray.remote_endpoint_id)).toBe(false);
    expect(h.store.countGivenUpStrayEndpoints(ingress.ingress_id)).toBe(0);
  });
});

describe('D-201 Slice 10AQ — the strays, said and named (10AM findings 8, 9, 21 and 26)', () => {
  const HOUR = 60 * 60 * 1000;
  const unreachable = (h: ReturnType<typeof unsettledHarness>) => {
    vi.mocked(h.adapter.find).mockRejectedValue(
      new WebhookRegistrationAdapterError('upstream_unavailable', 'the account cannot be reached'));
  };
  /** A create lost at the webhook's own account: kept, its account searched. */
  const lostCreate = async () => {
    const h = unsettledHarness();
    const ingress = h.addIngress();
    vi.mocked(h.adapter.create).mockRejectedValueOnce(
      new WebhookRegistrationAdapterError('upstream_unavailable', 'did not complete'));
    await expect(h.service.reconcile(ingress.ingress_id)).rejects.toBeDefined();
    return { h, ingress };
  };
  /** Removal of the endpoints named here is refused, every time. */
  const refusing = (h: ReturnType<typeof unsettledHarness>, ...ids: string[]) => {
    vi.mocked(h.adapter.delete).mockImplementation(async (_context, id: string) => {
      if (ids.includes(id)) throw new WebhookRegistrationAdapterError('upstream_unavailable', 'the removal did not go through');
      h.remote.delete(id);
    });
  };
  /** Its strays, by endpoint: two noted in one sweep share a time. */
  const named = (h: ReturnType<typeof unsettledHarness>, ingressId: string) =>
    h.store.listStrayEndpoints(ingressId).map((stray) => [stray.remote_endpoint_id, stray.given_up])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])));

  it('a stray a search no longer finds is settled, whatever else in its account fails, and given up never (finding 8)', async () => {
    const { h, ingress } = await lostCreate();
    const gone = h.make(ingress.ingress_id);
    const standing = h.make(ingress.ingress_id);
    refusing(h, gone.remote_endpoint_id, standing.remote_endpoint_id);
    h.clock.now += 60_000;
    await h.service.sweepUnsettledCreates();
    expect(named(h, ingress.ingress_id)).toEqual([[gone.remote_endpoint_id, false], [standing.remote_endpoint_id, false]]);
    // The owner removes one at the service; the other's removal is refused still.
    h.remote.delete(gone.remote_endpoint_id);
    h.clock.now += HOUR;
    await h.service.sweepUnsettledCreates();
    // Before 10AQ: still 2, the one gone kept with the account's failure.
    expect(named(h, ingress.ingress_id)).toEqual([[standing.remote_endpoint_id, false]]);
    for (let hour = 0; hour < 170; hour += 1) {
      h.clock.now += HOUR;
      await h.service.sweepUnsettledCreates();
    }
    // Before 10AQ both were given up: "stopped trying to remove 2 earlier setups", 1 there.
    expect(named(h, ingress.ingress_id)).toEqual([[standing.remote_endpoint_id, true]]);
  });

  it('one removed beside one refused: the removed one is counted nowhere as failed, nor noted standing again (finding 26)', async () => {
    const { h, ingress } = await lostCreate();
    const removable = h.make(ingress.ingress_id);
    const kept = h.make(ingress.ingress_id);
    // Both refused at first: both recorded, beside the create.
    refusing(h, removable.remote_endpoint_id, kept.remote_endpoint_id);
    h.clock.now += 60_000;
    await expect(h.service.sweepUnsettledCreates()).resolves.toEqual({ removed: 0, settled: 0, given_up: 0, failed: 1 });
    expect(named(h, ingress.ingress_id)).toEqual([[removable.remote_endpoint_id, false], [kept.remote_endpoint_id, false]]);
    // The first goes now, the second is refused still.
    refusing(h, kept.remote_endpoint_id);
    h.clock.now += 60_000;
    // Before 10AQ: `failed: 3`, the removed stray's record among them.
    await expect(h.service.sweepUnsettledCreates()).resolves.toEqual({ removed: 1, settled: 0, given_up: 0, failed: 2 });
    expect(h.remote.has(removable.remote_endpoint_id)).toBe(false);
    // Never noted standing again once removed.
    expect(named(h, ingress.ingress_id)).toEqual([[kept.remote_endpoint_id, false]]);
  });

  it('a stray given up that a later search of its account finds gone is settled: its notice goes (findings 8 and 26)', async () => {
    const { h, ingress } = await lostCreate();
    const stray = h.make(ingress.ingress_id);
    refusing(h, stray.remote_endpoint_id);
    h.clock.now += 60_000;
    await h.service.sweepUnsettledCreates();
    const [kept] = h.store.listStrayEndpoints(ingress.ingress_id);
    h.store.giveUpStrayEndpoint(kept!.create_id, h.clock.now);
    expect(h.store.countGivenUpStrayEndpoints(ingress.ingress_id)).toBe(1);
    // The owner removes it there without saying so; the create's search finds it gone.
    h.remote.delete(stray.remote_endpoint_id);
    h.clock.now += HOUR;
    await h.service.sweepUnsettledCreates();
    // Before 10AQ it stayed, given up, until the owner said they removed it.
    expect(h.store.countGivenUpStrayEndpoints(ingress.ingress_id)).toBe(0);
  });

  it('a stray the next reconcile removes leaves the count at once, given up or not (finding 21)', async () => {
    for (const given of [false, true]) {
      const { h, ingress } = await lostCreate();
      const stray = h.make(ingress.ingress_id);
      refusing(h, stray.remote_endpoint_id);
      h.clock.now += 60_000;
      await h.service.sweepUnsettledCreates();
      expect(h.store.countStrayEndpoints(ingress.ingress_id), String(given)).toBe(1);
      if (given) {
        h.store.giveUpStrayEndpoint(h.store.listStrayEndpoints(ingress.ingress_id)[0]!.create_id, h.clock.now);
      }
      // Its removal goes through now: the reconcile takes it as its orphan.
      refusing(h);
      await expect(h.service.reconcile(ingress.ingress_id), String(given)).resolves.toBeDefined();
      expect(h.remote.has(stray.remote_endpoint_id), String(given)).toBe(false);
      // Before 10AQ: counted until the next sweep, and a given-up one kept its notice.
      expect(h.store.countStrayEndpoints(ingress.ingress_id), String(given)).toBe(0);
      expect(h.store.countGivenUpStrayEndpoints(ingress.ingress_id), String(given)).toBe(0);
    }
  });

  it('a search settles only the strays recorded at the address it searched: one at an earlier address stays (finding 8)', async () => {
    const { h, ingress } = await lostCreate();
    const before = h.make(ingress.ingress_id);
    refusing(h, before.remote_endpoint_id);
    h.clock.now += 60_000;
    await h.service.sweepUnsettledCreates();
    expect(named(h, ingress.ingress_id)).toEqual([[before.remote_endpoint_id, false]]);
    // The server's address moves: a create lost there has its account searched
    // at the new address, which cannot find what the old one set up.
    h.host.base = 'https://hooks.example.net';
    vi.mocked(h.adapter.create).mockRejectedValueOnce(
      new WebhookRegistrationAdapterError('upstream_unavailable', 'did not complete'));
    await expect(h.service.reconcile(ingress.ingress_id)).rejects.toBeDefined();
    h.clock.now += HOUR;
    await h.service.sweepUnsettledCreates();
    expect(h.remote.has(before.remote_endpoint_id)).toBe(true);
    expect(named(h, ingress.ingress_id)).toEqual([[before.remote_endpoint_id, false]]);
  });

  it('a stray found standing is recorded at the account it was found at, not the connection the webhook moved to (finding 26)', async () => {
    const { h, ingress } = await lostCreate();
    // The webhook moves to another connection; the create lost at the first lands there.
    h.db.prepare("UPDATE webhook_ingresses SET paired_connection_id = 'stripe-other' WHERE ingress_id = ?")
      .run(ingress.ingress_id);
    const landed = h.make(ingress.ingress_id);
    refusing(h, landed.remote_endpoint_id);
    h.clock.now += 60_000;
    await h.service.sweepUnsettledCreates();
    expect(h.store.listStrayEndpoints(ingress.ingress_id)).toEqual([
      expect.objectContaining({ remote_endpoint_id: landed.remote_endpoint_id, connection_id: 'stripe-test' }),
    ]);
  });

  it('a clock set back past the start of a run takes no failed time off it: the give-up comes on time (finding 9)', async () => {
    const { h, ingress } = await lostCreate();
    const [record] = h.store.listUnsettledCreates();
    unreachable(h);
    // A hundred hours of failed searches noted, then the clock set back two hundred.
    h.store.noteUnsettledCreateUnreached(record!.create_id, h.clock.now, 100 * HOUR);
    h.clock.now -= 200 * HOUR;
    for (let sweep = 1; sweep < 69; sweep += 1) {
      await expect(h.service.sweepUnsettledCreates(), String(sweep)).resolves.toMatchObject({ given_up: 0, failed: 1 });
      expect(h.store.listUnsettledCreates()[0]?.unreached_ms, String(sweep)).toBe((100 + sweep - 1) * HOUR);
      h.clock.now += HOUR;
    }
    // Before 10AQ each later read counted 0 until the clock passed the run's
    // start, two hundred hours on: given up some 370 sweeps late.
    await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ given_up: 1, failed: 0 });
    expect(h.store.listUnsettledCreates().filter((row) => row.ingress_id === ingress.ingress_id)).toEqual([]);
  });

  it("a write that fails stays that write's: the rest of its account's sweep goes on (finding 26)", async () => {
    // A stray's settle fails after its removal: the next stray is still removed.
    {
      const { h, ingress } = await lostCreate();
      const first = h.make(ingress.ingress_id);
      const second = h.make(ingress.ingress_id);
      vi.spyOn(h.store, 'settleStrayEndpoint').mockImplementationOnce(() => { throw new Error('the database is busy'); });
      h.clock.now += 60_000;
      await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ removed: 2 });
      expect([h.remote.has(first.remote_endpoint_id), h.remote.has(second.remote_endpoint_id)]).toEqual([false, false]);
    }
    // A stray gone already cannot be settled: the one standing is still removed.
    {
      const { h, ingress } = await lostCreate();
      const gone = h.make(ingress.ingress_id);
      const standing = h.make(ingress.ingress_id);
      refusing(h, gone.remote_endpoint_id, standing.remote_endpoint_id);
      h.clock.now += 60_000;
      await h.service.sweepUnsettledCreates();
      h.remote.delete(gone.remote_endpoint_id);
      refusing(h);
      vi.spyOn(h.store, 'settleStrayEndpoint').mockImplementationOnce(() => { throw new Error('the database is busy'); });
      h.clock.now += HOUR;
      await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ removed: 1 });
      expect(h.remote.has(standing.remote_endpoint_id)).toBe(false);
    }
    // The list of strays cannot be read: the search goes on, and removes what stands.
    {
      const { h, ingress } = await lostCreate();
      const stray = h.make(ingress.ingress_id);
      vi.spyOn(h.store, 'listStrayEndpoints').mockImplementationOnce(() => { throw new Error('the database is busy'); });
      h.clock.now += 60_000;
      await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ removed: 1 });
      expect(h.remote.has(stray.remote_endpoint_id)).toBe(false);
    }
    // A stray found standing cannot be recorded: the account's records are still noted as unreached.
    {
      const { h, ingress } = await lostCreate();
      const stray = h.make(ingress.ingress_id);
      refusing(h, stray.remote_endpoint_id);
      vi.spyOn(h.store, 'noteStrayEndpointStanding').mockImplementationOnce(() => { throw new Error('the database is busy'); });
      h.clock.now += 60_000;
      await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ failed: 1 });
      expect(h.store.listUnsettledCreates()[0]?.unreached_last_at).toBe(h.clock.now);
    }
    // A give-up cannot be written: counted as failed, and the account's next record still swept.
    {
      const { h, ingress } = await lostCreate();
      const stray = h.make(ingress.ingress_id);
      refusing(h, stray.remote_endpoint_id);
      h.clock.now += 60_000;
      await h.service.sweepUnsettledCreates();
      // Both its records a week of failed searches along.
      for (const row of h.store.listUnsettledCreates()) {
        h.store.noteUnsettledCreateUnreached(row.create_id, h.clock.now, 168 * HOUR);
      }
      unreachable(h);
      vi.spyOn(h.store, 'giveUpStrayEndpoint').mockImplementationOnce(() => { throw new Error('the database is busy'); });
      h.clock.now += HOUR;
      // The stray's give-up fails; the create is still given up, its record gone.
      await expect(h.service.sweepUnsettledCreates()).resolves.toEqual({ removed: 0, settled: 0, given_up: 1, failed: 1 });
      expect(h.store.listUnsettledCreates().map((row) => row.kind)).toEqual(['stray']);
    }
  });
});

// D-201 Slice 10AN (the owner's call, 2026-11-20) — Recued sets a webhook's
// secret again only where the secret is its own.
describe('D-201 Slice 10AN — a secret the service makes is never set again', () => {
  // D-201 Slice 10AU (10AS finding 27) — none to set again is no failure: null,
  // nothing sent.
  it("sets nothing again for a managed webhook whose secret the service made, and changes nothing there", async () => {
    const h = unsettledHarness();
    const ingress = h.addIngress();
    await expect(h.service.reconcile(ingress.ingress_id)).resolves.toMatchObject({ registration_state: 'registered' });
    vi.mocked(h.adapter.update).mockClear();
    vi.mocked(h.adapter.read).mockClear();
    await expect(h.service.setSecretAgain(ingress.ingress_id)).resolves.toBeNull();
    expect(h.adapter.update).not.toHaveBeenCalled();
    expect(h.adapter.read).not.toHaveBeenCalled();
  });
});

describe('D-201 Slice 10AT — the strays, again (10AS findings 3, 4 and 23)', () => {
  const HOUR = 60 * 60 * 1000;
  /** A create lost at the webhook's own account: kept, its account searched. */
  const lostCreate = async () => {
    const h = unsettledHarness();
    const ingress = h.addIngress();
    vi.mocked(h.adapter.create).mockRejectedValueOnce(
      new WebhookRegistrationAdapterError('upstream_unavailable', 'did not complete'));
    await expect(h.service.reconcile(ingress.ingress_id)).rejects.toBeDefined();
    return { h, ingress };
  };
  /** Removal of the endpoints named here is refused, every time. */
  const refusing = (h: ReturnType<typeof unsettledHarness>, ...ids: string[]) => {
    vi.mocked(h.adapter.delete).mockImplementation(async (_context, id: string) => {
      if (ids.includes(id)) throw new WebhookRegistrationAdapterError('upstream_unavailable', 'the removal did not go through');
      h.remote.delete(id);
    });
  };
  const named = (h: ReturnType<typeof unsettledHarness>, ingressId: string) =>
    h.store.listStrayEndpoints(ingressId).map((stray) => [stray.remote_endpoint_id, stray.given_up])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  /** A given-up stray of a lost create, its removal accepted again. */
  const givenUpStray = async () => {
    const { h, ingress } = await lostCreate();
    const stray = h.make(ingress.ingress_id);
    refusing(h, stray.remote_endpoint_id);
    h.clock.now += 60_000;
    await h.service.sweepUnsettledCreates();
    h.store.giveUpStrayEndpoint(h.store.listStrayEndpoints(ingress.ingress_id)[0]!.create_id, h.clock.now);
    expect(h.store.countGivenUpStrayEndpoints(ingress.ingress_id)).toBe(1);
    refusing(h);
    return { h, ingress, stray };
  };

  // 10AS finding 3 — only the reconcile's removal settled a stray, and a
  // given-up one is never searched again.
  it("a given-up stray a retire's clean-up removes leaves the card at once", async () => {
    const { h, ingress, stray } = await givenUpStray();
    await h.service.cleanup(ingress.ingress_id, 'retire');
    expect(h.remote.has(stray.remote_endpoint_id)).toBe(false);
    expect(h.store.listStrayEndpoints(ingress.ingress_id)).toEqual([]);
  });

  it("and a rebind's clean-up of the account it leaves", async () => {
    const { h, ingress, stray } = await givenUpStray();
    await h.service.rebind(ingress.ingress_id, 'stripe-test-rotated').catch(() => undefined);
    expect(h.remote.has(stray.remote_endpoint_id)).toBe(false);
    expect(h.store.listStrayEndpoints(ingress.ingress_id)).toEqual([]);
  });

  it('a fault settling it leaves the clean-up done, the stray for the next search', async () => {
    const { h, ingress, stray } = await givenUpStray();
    const settle = vi.spyOn(h.store, 'settleStrayEndpoint').mockImplementation(() => {
      throw new Error('the database is busy');
    });
    await expect(h.service.cleanup(ingress.ingress_id, 'retire')).resolves.toMatchObject({ intake_state: 'retired' });
    expect(settle).toHaveBeenCalled();
    expect(h.remote.has(stray.remote_endpoint_id)).toBe(false);
    settle.mockRestore();
  });

  // 10AS finding 4 — found, but not provably this webhook's: it stands.
  it("a stray the search finds but cannot prove is this webhook's stays recorded, in a failing sweep or a clean one", async () => {
    for (const alsoFailing of [true, false]) {
      const { h, ingress } = await lostCreate();
      const edited = h.make(ingress.ingress_id);
      const other = h.make(ingress.ingress_id);
      refusing(h, edited.remote_endpoint_id, other.remote_endpoint_id);
      h.clock.now += 60_000;
      await h.service.sweepUnsettledCreates();
      expect(named(h, ingress.ingress_id)).toHaveLength(2);
      // Its metadata edited at the service: found, no longer provably ours.
      vi.mocked(h.adapter.find).mockImplementation(async (context) => [...h.remote.values()]
        .filter((entry) => entry.ingress_id === context.desired.ingress_id)
        .map(({ ingress_id: _ingress, ...endpoint }) => ({
          endpoint,
          correlation: endpoint.remote_endpoint_id === edited.remote_endpoint_id ? 'metadata_conflict' as const : 'owned' as const,
        })));
      // The other one's removal refused still, or taken now.
      refusing(h, ...(alsoFailing ? [other.remote_endpoint_id] : []));
      h.clock.now += HOUR;
      await h.service.sweepUnsettledCreates();
      expect(h.remote.has(edited.remote_endpoint_id), String(alsoFailing)).toBe(true);
      // Before 10AT: settled as gone while it stood at the service.
      expect(named(h, ingress.ingress_id).map(([id]) => id), String(alsoFailing)).toContain(edited.remote_endpoint_id);
      // Recued cannot prove it may remove it: kept as one whose removal is
      // refused, it is given up after a week, for the owner to remove there.
      for (let hour = 0; hour < 170; hour += 1) {
        h.clock.now += HOUR;
        await h.service.sweepUnsettledCreates();
      }
      expect(named(h, ingress.ingress_id).find(([id]) => id === edited.remote_endpoint_id), String(alsoFailing))
        .toEqual([edited.remote_endpoint_id, true]);
      expect(h.remote.has(edited.remote_endpoint_id), String(alsoFailing)).toBe(true);
    }
  });

  // 10AS finding 23 — counted nowhere in the sweep's result.
  it('a stray settled as gone where another removal fails is counted as settled', async () => {
    const { h, ingress } = await lostCreate();
    const gone = h.make(ingress.ingress_id);
    const standing = h.make(ingress.ingress_id);
    refusing(h, gone.remote_endpoint_id, standing.remote_endpoint_id);
    h.clock.now += 60_000;
    await h.service.sweepUnsettledCreates();
    h.remote.delete(gone.remote_endpoint_id);
    h.clock.now += HOUR;
    await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ removed: 0, settled: 1 });
    expect(named(h, ingress.ingress_id)).toEqual([[standing.remote_endpoint_id, false]]);
  });

  // The 10AS review's survivor R3 — the account a stray is at, checked.
  it('a stray at the account the webhook left is never settled by a search of another account', async () => {
    const { h, ingress } = await lostCreate();
    const row = h.store.get(ingress.ingress_id)!;
    h.store.noteStrayEndpointStanding({
      ingress_id: ingress.ingress_id,
      connection_id: 'stripe-old',
      endpoint_url: `${h.host.base}/v1/webhooks/${row.public_id}`,
      remote_endpoint_id: 'we_left_at_the_old_account',
    });
    // The old account cannot be reached; the webhook's own one can, and holds nothing of it.
    const reachable = vi.mocked(h.adapter.find).getMockImplementation()!;
    vi.mocked(h.adapter.find).mockImplementation(async (context) => {
      if (context.paired_connection_id === 'stripe-old') {
        throw new WebhookRegistrationAdapterError('upstream_unavailable', 'the account cannot be reached');
      }
      return reachable(context);
    });
    h.clock.now += HOUR;
    await h.service.sweepUnsettledCreates();
    expect(named(h, ingress.ingress_id)).toEqual([['we_left_at_the_old_account', false]]);
  });

  // The 10AS review's survivor R11 — the reconcile's settle of its orphan.
  it("a fault settling the reconcile's orphan never stops it setting the webhook up", async () => {
    const { h, ingress } = await lostCreate();
    const stray = h.make(ingress.ingress_id);
    refusing(h, stray.remote_endpoint_id);
    h.clock.now += 60_000;
    await h.service.sweepUnsettledCreates();
    refusing(h);
    const settle = vi.spyOn(h.store, 'settleStrayEndpoint').mockImplementation(() => {
      throw new Error('the database is busy');
    });
    await expect(h.service.reconcile(ingress.ingress_id)).resolves.toMatchObject({ registration_state: 'registered' });
    expect(settle).toHaveBeenCalledWith(ingress.ingress_id, stray.remote_endpoint_id);
    expect(h.remote.has(stray.remote_endpoint_id)).toBe(false);
    settle.mockRestore();
  });
});

describe('D-201 Slice 10BA — a stray Recued cannot prove, noted for the card (10AY finding 4)', () => {
  const HOUR = 60 * 60 * 1000;
  it("found standing but not provably this webhook's: noted unproven and never removed; proven again, the note goes", async () => {
    const h = unsettledHarness();
    const ingress = h.addIngress();
    vi.mocked(h.adapter.create).mockRejectedValueOnce(
      new WebhookRegistrationAdapterError('upstream_unavailable', 'did not complete'));
    await expect(h.service.reconcile(ingress.ingress_id)).rejects.toBeDefined();
    const edited = h.make(ingress.ingress_id);
    const refused = new Set([edited.remote_endpoint_id]);
    vi.mocked(h.adapter.delete).mockImplementation(async (_context, id: string) => {
      if (refused.has(id)) throw new WebhookRegistrationAdapterError('upstream_unavailable', 'the removal did not go through');
      h.remote.delete(id);
    });
    h.clock.now += 60_000;
    await h.service.sweepUnsettledCreates();
    const stray = () => h.store.listStrayEndpoints(ingress.ingress_id)
      .find((entry) => entry.remote_endpoint_id === edited.remote_endpoint_id);
    // Provably this webhook's, its removal refused: Recued keeps trying.
    expect(stray()).toMatchObject({ given_up: false, unproven: false });
    // Its metadata edited at the service: found, no longer provably ours.
    const find = vi.mocked(h.adapter.find).getMockImplementation();
    vi.mocked(h.adapter.find).mockImplementation(async (context) => [...h.remote.values()]
      .filter((entry) => entry.ingress_id === context.desired.ingress_id)
      .map(({ ingress_id: _ingress, ...endpoint }) => ({
        endpoint,
        correlation: endpoint.remote_endpoint_id === edited.remote_endpoint_id ? 'metadata_conflict' as const : 'owned' as const,
      })));
    vi.mocked(h.adapter.delete).mockClear();
    h.clock.now += HOUR;
    await h.service.sweepUnsettledCreates();
    expect(stray()).toMatchObject({ given_up: false, unproven: true });
    expect(vi.mocked(h.adapter.delete)).not.toHaveBeenCalled();
    expect(h.remote.has(edited.remote_endpoint_id)).toBe(true);
    // Proven again, its removal still refused: no longer said to be unproven.
    vi.mocked(h.adapter.find).mockImplementation(find!);
    h.clock.now += HOUR;
    await h.service.sweepUnsettledCreates();
    expect(stray()).toMatchObject({ given_up: false, unproven: false });
    expect(vi.mocked(h.adapter.delete)).toHaveBeenCalledWith(expect.anything(), edited.remote_endpoint_id);
  });
});

describe('D-201 Slice 10BK — strays as each service names its endpoints (10BF finding 12)', () => {
  const HOUR = 60 * 60 * 1000;
  it('a service whose endpoints each have an id of their own: a stray whose address was edited there still stands, never settled as gone', async () => {
    const h = unsettledHarness();
    // Found by its metadata, at whatever address the service holds for it.
    vi.mocked(h.adapter.find).mockImplementation(async (context) => [...h.remote.values()]
      .filter((entry) => entry.ingress_id === context.desired.ingress_id)
      .map(({ ingress_id: _ingress, ...endpoint }) => ({ endpoint, correlation: 'owned' as const })));
    const ingress = h.addIngress();
    vi.mocked(h.adapter.create).mockRejectedValueOnce(
      new WebhookRegistrationAdapterError('upstream_unavailable', 'did not complete'));
    await expect(h.service.reconcile(ingress.ingress_id)).rejects.toBeDefined();
    const edited = h.make(ingress.ingress_id);
    vi.mocked(h.adapter.delete).mockImplementation(async (_context, id: string) => {
      if (id === edited.remote_endpoint_id) {
        throw new WebhookRegistrationAdapterError('upstream_unavailable', 'the removal did not go through');
      }
      h.remote.delete(id);
    });
    h.clock.now += 60_000;
    await h.service.sweepUnsettledCreates();
    const stray = () => h.store.listStrayEndpoints(ingress.ingress_id)
      .find((entry) => entry.remote_endpoint_id === edited.remote_endpoint_id);
    expect(stray()).toMatchObject({ given_up: false });
    const recorded = stray()!.create_id;
    // Its address edited at the service.
    h.remote.get(edited.remote_endpoint_id)!.endpoint_url = 'https://hooks.example.test/edited-at-the-service';
    vi.mocked(h.adapter.delete).mockClear();
    h.clock.now += HOUR;
    await h.service.sweepUnsettledCreates();
    // Before 10BK: not at its recorded address, so settled as gone while it
    // stood, then recorded afresh by its failed removal, at every sweep.
    expect(stray()).toMatchObject({ create_id: recorded, given_up: false });
    expect(vi.mocked(h.adapter.delete)).toHaveBeenCalledWith(expect.anything(), edited.remote_endpoint_id);
    expect(h.remote.has(edited.remote_endpoint_id)).toBe(true);
    // Its removal refused for nearly a week, then once more: given up, as any
    // stray is. Recorded afresh at each sweep, it never was.
    h.store.noteUnsettledCreateUnreached(recorded, h.clock.now, WEBHOOK_UNSETTLED_CREATE_GIVE_UP_MS - 30 * 60_000);
    h.clock.now += HOUR;
    await h.service.sweepUnsettledCreates();
    expect(stray()).toMatchObject({ create_id: recorded, given_up: true });
  });

  // D-201 Slice 10BQ (10BM finding 13) — found by what it carries, at whatever
  // address it now has: one the search cannot prove is this webhook's was said
  // to send to this webhook's address, wherever it sent.
  it('a stray the search cannot prove: noted as at this address, then, its address edited there, as elsewhere', async () => {
    const h = unsettledHarness();
    let correlation: 'owned' | 'metadata_conflict' = 'owned';
    vi.mocked(h.adapter.find).mockImplementation(async (context) => [...h.remote.values()]
      .filter((entry) => entry.ingress_id === context.desired.ingress_id)
      .map(({ ingress_id: _ingress, ...endpoint }) => ({ endpoint, correlation })));
    const ingress = h.addIngress();
    vi.mocked(h.adapter.create).mockRejectedValueOnce(
      new WebhookRegistrationAdapterError('upstream_unavailable', 'did not complete'));
    await expect(h.service.reconcile(ingress.ingress_id)).rejects.toBeDefined();
    const left = h.make(ingress.ingress_id);
    vi.mocked(h.adapter.delete).mockImplementation(async (_context, id: string) => {
      if (id === left.remote_endpoint_id) {
        throw new WebhookRegistrationAdapterError('upstream_unavailable', 'the removal did not go through');
      }
      h.remote.delete(id);
    });
    h.clock.now += 60_000;
    await h.service.sweepUnsettledCreates();
    const stray = () => h.store.listStrayEndpoints(ingress.ingress_id)
      .find((entry) => entry.remote_endpoint_id === left.remote_endpoint_id);
    expect(stray()).toMatchObject({ unproven: false, elsewhere: false });
    // Changed at the service: no longer provably this webhook's, at its address.
    correlation = 'metadata_conflict';
    vi.mocked(h.adapter.delete).mockClear();
    h.clock.now += HOUR;
    await h.service.sweepUnsettledCreates();
    expect(stray()).toMatchObject({ unproven: true, elsewhere: false });
    // Then its address edited there too.
    h.remote.get(left.remote_endpoint_id)!.endpoint_url = 'https://hooks.example.test/edited-at-the-service';
    h.clock.now += HOUR;
    await h.service.sweepUnsettledCreates();
    expect(stray()).toMatchObject({ unproven: true, elsewhere: true });
    // Never removed by Recued.
    expect(vi.mocked(h.adapter.delete)).not.toHaveBeenCalled();
    expect(h.remote.has(left.remote_endpoint_id)).toBe(true);
    // Proven again: neither note stands.
    correlation = 'owned';
    h.clock.now += HOUR;
    await h.service.sweepUnsettledCreates();
    expect(stray() ?? { unproven: false, elsewhere: false }).toMatchObject({ unproven: false, elsewhere: false });
  });

  /** D-201 Slice 10BY — a stray Recued cannot prove is this webhook's, left
   *  standing: a create that landed though its answer was lost, its removal
   *  refused, then changed at the service. */
  const anUnprovenStray = async (h: ReturnType<typeof unsettledHarness>) => {
    let correlation: 'owned' | 'metadata_conflict' = 'owned';
    vi.mocked(h.adapter.find).mockImplementation(async (context) => [...h.remote.values()]
      .filter((entry) => entry.ingress_id === context.desired.ingress_id)
      .map(({ ingress_id: _ingress, ...endpoint }) => ({ endpoint, correlation })));
    const ingress = h.addIngress();
    vi.mocked(h.adapter.create).mockRejectedValueOnce(
      new WebhookRegistrationAdapterError('upstream_unavailable', 'did not complete'));
    await expect(h.service.reconcile(ingress.ingress_id)).rejects.toBeDefined();
    const left = h.make(ingress.ingress_id);
    vi.mocked(h.adapter.delete).mockImplementation(async (_context, id: string) => {
      if (id === left.remote_endpoint_id) {
        throw new WebhookRegistrationAdapterError('upstream_unavailable', 'the removal did not go through');
      }
      h.remote.delete(id);
    });
    h.clock.now += 60_000;
    await h.service.sweepUnsettledCreates();
    const stray = () => h.store.listStrayEndpoints(ingress.ingress_id)
      .find((entry) => entry.remote_endpoint_id === left.remote_endpoint_id);
    // Changed at the service: no longer provably this webhook's.
    correlation = 'metadata_conflict';
    h.clock.now += HOUR;
    await h.service.sweepUnsettledCreates();
    vi.mocked(h.adapter.delete).mockClear();
    return { ingress, left, stray };
  };

  // D-201 Slice 10BT (10BS finding 13) — "elsewhere" against the webhook's
  // address now: after the owner moved it, a stray edited to the new address
  // read as sending elsewhere. D-201 Slice 10BY (10BX finding 2) — and against
  // every address the server takes this webhook's messages at: its listener
  // answers on every name the server serves, and moving the webhooks address
  // keeps the old name the server's own, so a stray left there still sends
  // here. 10BT read it as elsewhere.
  it("the owner moves the webhooks address: a stray left at the old one sends here while that name is the server's", async () => {
    const h = unsettledHarness();
    h.host.own = ['https://hooks.example'];
    const { ingress, left, stray } = await anUnprovenStray(h);
    expect(stray()).toMatchObject({ unproven: true, elsewhere: false });
    // The owner moves the webhooks address; the old name stays the server's own.
    h.host.base = 'https://hooks.moved.example';
    h.host.own = ['https://hooks.example', 'https://hooks.moved.example'];
    h.clock.now += HOUR;
    await h.service.sweepUnsettledCreates();
    // Before 10BY: elsewhere, and left out of what may send the messages refused here.
    expect(stray()).toMatchObject({ unproven: true, elsewhere: false });
    // The old name no longer the server's: elsewhere.
    h.host.own = ['https://hooks.moved.example'];
    h.clock.now += HOUR;
    await h.service.sweepUnsettledCreates();
    expect(stray()).toMatchObject({ unproven: true, elsewhere: true });
    // Edited at the service to the new address: it sends here.
    h.remote.get(left.remote_endpoint_id)!.endpoint_url = `https://hooks.moved.example/v1/webhooks/${ingress.public_id}`;
    h.clock.now += HOUR;
    await h.service.sweepUnsettledCreates();
    // Before 10BT: elsewhere.
    expect(stray()).toMatchObject({ unproven: true, elsewhere: false });
    // Edited to another service's address: elsewhere.
    h.remote.get(left.remote_endpoint_id)!.endpoint_url = 'https://other.example/hook';
    h.clock.now += HOUR;
    await h.service.sweepUnsettledCreates();
    expect(stray()).toMatchObject({ unproven: true, elsewhere: true });
    // Never removed by Recued.
    expect(vi.mocked(h.adapter.delete)).not.toHaveBeenCalled();
    expect(h.remote.has(left.remote_endpoint_id)).toBe(true);
  });

  // D-201 Slice 10BY (10BX finding 4) — the address now before the confirmed
  // one, and either fallback, pinned by no test: when the address now is
  // unknown or cannot be read, the confirmed one stands in, else the one the
  // stray was recorded at.
  it('a stray is judged against the address now, else the confirmed one, else the one it was recorded at', async () => {
    const h = unsettledHarness();
    const { ingress, left, stray } = await anUnprovenStray(h);
    const recorded = `https://hooks.example/v1/webhooks/${ingress.public_id}`;
    const confirmed = `https://confirmed.example/v1/webhooks/${ingress.public_id}`;
    h.db.prepare('UPDATE webhook_ingresses SET confirmed_endpoint_url = ? WHERE ingress_id = ?')
      .run(confirmed, ingress.ingress_id);
    h.host.base = 'https://now.example';
    const elsewhereAt = async (url: string, now?: 'none' | 'unreadable'): Promise<boolean | undefined> => {
      h.remote.get(left.remote_endpoint_id)!.endpoint_url = url;
      h.host.now = now;
      h.clock.now += HOUR;
      await h.service.sweepUnsettledCreates();
      return stray()?.elsewhere;
    };
    // The address now, not the confirmed one.
    expect(await elsewhereAt(`https://now.example/v1/webhooks/${ingress.public_id}`)).toBe(false);
    expect(await elsewhereAt(confirmed)).toBe(true);
    // The address now unknown, or unreadable: the confirmed one, not the recorded one.
    for (const now of ['none', 'unreadable'] as const) {
      expect(await elsewhereAt(confirmed, now)).toBe(false);
      expect(await elsewhereAt(recorded, now)).toBe(true);
    }
    // No confirmed one either: the one it was recorded at.
    h.db.prepare('UPDATE webhook_ingresses SET confirmed_endpoint_url = NULL WHERE ingress_id = ?')
      .run(ingress.ingress_id);
    expect(await elsewhereAt(recorded, 'none')).toBe(false);
    expect(await elsewhereAt(confirmed, 'unreadable')).toBe(true);
  });

  it('the registry keeps what an adapter declares of its endpoints, and only that', () => {
    const base = unsettledHarness().adapter;
    const registry = createWebhookRegistrationRuntimeRegistry([
      base,
      { ...base, profile_id: 'paddle.notification.v1', one_endpoint_per_account: true },
    ]);
    expect(registry.get('stripe.event.v1')).not.toHaveProperty('one_endpoint_per_account');
    expect(registry.get('paddle.notification.v1')?.one_endpoint_per_account).toBe(true);
  });
});

describe('D-201 Slice 10BY — the server is composed to judge strays against its own addresses', () => {
  // Source-level, as the composition root's other obligations are: the
  // reconciler passes its own tests without the line that wires it, and with
  // none, a stray left at the old name after a move read as elsewhere again.
  const SRC = readFileSync(resolve(import.meta.dirname, '..', 'serve', 'compose-listeners.ts'), 'utf8');

  it("gives the managed registration every address the server takes a webhook's messages at", () => {
    const at = SRC.indexOf('createWebhookManagedRegistrationService({');
    expect(at).toBeGreaterThan(-1);
    expect(SRC.slice(at, at + 600)).toMatch(/ownEndpointUrls: \(ingress\) => webhookOwnEndpointUrls\(ingress\.public_id\)/);
    const own = SRC.indexOf('const webhookOwnEndpointUrls');
    expect(own).toBeGreaterThan(-1);
    expect(SRC.slice(own, own + 400)).toMatch(/storage\.publicAddress\.ownBaseUrls\(\)\s*\.map\(webhookBaseFrom\)/);
    expect(SRC.slice(own, own + 400)).toMatch(/`\$\{base\}\/v1\/webhooks\/\$\{publicId\}`/);
  });
});
