import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebhookIngressStore } from '../storage/webhook-ingress-store.js';
import { createWebhookManagedRegistrationService } from '../webhook-registration-reconciler.js';
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

    harness.store.failCloseForDeletedPairedConnection('stripe-test');
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
