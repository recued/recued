import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAuditEntry,
  createAuditLogStore,
  createInMemoryCollection,
} from '@recued/storage';
import { handleAuditExportPage } from '../audit-export-handler.js';
import { ensureMemorySchema } from '../memory-schema.js';
import {
  WebhookIngressStoreError,
  createWebhookIngressStore,
  type WebhookIngressStore,
} from '../storage/webhook-ingress-store.js';
import { createConnectionStore } from '../storage/connection-store.js';

const KEY = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));

const databases: Database.Database[] = [];
afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

const makeStore = (input: {
  key?: Uint8Array | null;
  getEncryptionKey?: () => Uint8Array | null;
  ids?: boolean;
} = {}): { db: Database.Database; store: WebhookIngressStore } => {
  const db = new Database(':memory:');
  databases.push(db);
  let stamp = 1_800_000_000_000;
  const ids = input.ids === false ? {} : {
    newIngressId: () => 'whi_0123456789abcdef0123456789abcdef',
    newPublicId: () => 'opaquePublicId_0123456789abcdef',
    newCredentialSetRef: () => 'whc_0123456789abcdef0123456789abcdef',
  };
  const key = Object.prototype.hasOwnProperty.call(input, 'key') ? input.key : KEY;
  return {
    db,
    store: createWebhookIngressStore(db, {
      now: () => ++stamp,
      getEncryptionKey: input.getEncryptionKey ?? (() => key ?? null),
      ...ids,
    }),
  };
};

const createStripe = (store: WebhookIngressStore) => store.create({
  display_name: 'Billing events',
  profile_id: 'stripe.event.v1',
  environment: 'live',
  paired_connection_id: 'stripe-live',
  registration_mode: 'manual',
  selected_event_types: ['checkout.session.completed'],
});

const createManagedStripe = (store: WebhookIngressStore) => store.create({
  display_name: 'Managed billing events',
  profile_id: 'stripe.event.v1',
  environment: 'test',
  paired_connection_id: 'stripe-test',
  registration_mode: 'managed_endpoint',
  selected_event_types: ['invoice.paid'],
});

describe('D-201 Slice 1 webhook ingress store', () => {
  it('migrates pre-Slice-5A readiness metadata without touching ciphertext', async () => {
    const { db, store } = makeStore();
    const ingress = createStripe(store);
    await store.writeCredentialVersion(ingress.ingress_id, {
      endpoint_secret: 'migration-secret',
    });
    const ciphertextBefore = db.prepare(`
      SELECT ciphertext FROM webhook_credential_versions
    `).pluck().get();
    db.exec(
      'ALTER TABLE webhook_ingresses DROP COLUMN confirmed_endpoint_url',
    );
    db.exec(
      'ALTER TABLE webhook_ingresses DROP COLUMN registration_attempt',
    );
    db.exec(
      'ALTER TABLE webhook_ingresses DROP COLUMN pending_paired_connection_id',
    );
    db.exec(
      'ALTER TABLE webhook_ingresses DROP COLUMN registration_target_json',
    );
    db.exec(
      'ALTER TABLE webhook_ingresses DROP COLUMN registration_attempt_connection_id',
    );
    db.exec(
      'ALTER TABLE webhook_credential_versions DROP COLUMN last_verified_at',
    );
    createWebhookIngressStore(db);
    const ingressColumns = db.prepare(
      'PRAGMA table_info(webhook_ingresses)',
    ).all() as Array<{ name: string }>;
    const columns = db.prepare(
      'PRAGMA table_info(webhook_credential_versions)',
    ).all() as Array<{ name: string }>;
    expect(ingressColumns.map((column) => column.name))
      .toContain('confirmed_endpoint_url');
    expect(ingressColumns.map((column) => column.name))
      .toContain('registration_attempt');
    expect(ingressColumns.map((column) => column.name))
      .toContain('pending_paired_connection_id');
    expect(ingressColumns.map((column) => column.name))
      .toContain('registration_target_json');
    expect(ingressColumns.map((column) => column.name))
      .toContain('registration_attempt_connection_id');
    expect(columns.map((column) => column.name)).toContain('last_verified_at');
    expect(db.prepare(`
      SELECT ciphertext FROM webhook_credential_versions
    `).pluck().get()).toBe(ciphertextBefore);
    expect(store.get(ingress.ingress_id)?.registration_target).toBeNull();
  });

  it('persists a secret-free registration target and pins it in remote mutation CAS', () => {
    const { db, store } = makeStore();
    const ingress = store.create({
      display_name: 'Managed GitHub events',
      profile_id: 'github.webhook.v1',
      environment: 'live',
      paired_connection_id: 'github-api',
      registration_target: { kind: 'repository', key: 'openai/example' },
      registration_mode: 'managed_endpoint',
      selected_event_types: ['issues'],
    });
    expect(store.get(ingress.ingress_id)?.registration_target).toEqual({
      kind: 'repository',
      key: 'openai/example',
    });

    const snapshot = store.snapshotManagedRegistration(ingress.ingress_id);
    store.update(ingress.ingress_id, {
      registration_target: { kind: 'organization', key: 'openai' },
    });
    expect(() => store.markManagedRegistrationDrift(
      snapshot.expected,
      'managed_registration_drift',
    )).toThrow('registration inputs changed');

    db.prepare(`
      UPDATE webhook_ingresses SET registration_target_json = ? WHERE ingress_id = ?
    `).run('{"kind":"repository","key":3}', ingress.ingress_id);
    expect(() => store.get(ingress.ingress_id)).toThrowError(
      expect.objectContaining({ code: 'corrupt' }),
    );
  });

  it('conservatively binds ambiguous pre-6B2 attempts during the atomic migration', async () => {
    const { db, store } = makeStore();
    const ingress = createManagedStripe(store);
    store.prepareManagedRegistration(ingress.ingress_id);
    // This is both the pre-6B2 completed-disable shape and the crash-after-
    // provider-create/before-local-commit shape. Migration must choose the
    // latter, fail-closed interpretation because no old column can distinguish
    // them safely.
    db.exec('ALTER TABLE webhook_ingresses DROP COLUMN registration_attempt_connection_id');
    createWebhookIngressStore(db);
    expect(db.prepare(`
      SELECT registration_attempt_connection_id FROM webhook_ingresses
      WHERE ingress_id = ?
    `).pluck().get(ingress.ingress_id)).toBe('stripe-test');

    // Once the new column exists, a confirmed cleanup's null marker is durable
    // and ordinary restarts must not reclaim it.
    db.prepare(`
      UPDATE webhook_ingresses
      SET registration_attempt_connection_id = NULL
      WHERE ingress_id = ?
    `).run(ingress.ingress_id);
    createWebhookIngressStore(db);
    expect(db.prepare(`
      SELECT registration_attempt_connection_id FROM webhook_ingresses
      WHERE ingress_id = ?
    `).pluck().get(ingress.ingress_id)).toBeNull();
  });

  it('allocates an opaque public route id with no vendor or row identity', () => {
    const { store } = makeStore({ ids: false });
    const row = createStripe(store);
    expect(row.ingress_id).toMatch(/^whi_[a-f0-9]{32}$/);
    expect(row.public_id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(row.public_id).not.toContain('stripe');
    expect(row.public_id).not.toContain(row.ingress_id);
    expect(store.getByPublicId(row.public_id)?.ingress_id).toBe(row.ingress_id);
  });

  it('atomically commits a managed remote id and encrypted one-time credential after read-back', async () => {
    const { db, store } = makeStore();
    const ingress = createManagedStripe(store);
    const prepared = store.prepareManagedRegistration(ingress.ingress_id);
    expect(prepared.expected.attempt).toBe(1);
    expect(prepared.ingress).not.toHaveProperty('registration_attempt');

    const endpointUrl = `https://hooks.example/v1/webhooks/${ingress.public_id}`;
    const committed = await store.commitManagedRegistrationCreate({
      expected: prepared.expected,
      remote_endpoint_id: 'we_1234567890abcdef',
      endpoint_url: endpointUrl,
      credentials: { endpoint_secret: 'whsec_managed-one-time' },
      requires_handshake: false,
    });

    expect(committed).toMatchObject({
      remote_endpoint_id: 'we_1234567890abcdef',
      confirmed_endpoint_url: endpointUrl,
      registration_state: 'registered',
      intake_state: 'ready',
      last_error_code: null,
    });
    await expect(store.readActiveCredentialVersions(ingress.ingress_id))
      .resolves.toEqual([expect.objectContaining({
        version: '1',
        credentials: { endpoint_secret: 'whsec_managed-one-time' },
      })]);
    const persisted = JSON.stringify(db.prepare(
      'SELECT * FROM webhook_ingresses',
    ).all()) + JSON.stringify(db.prepare(
      'SELECT * FROM webhook_credential_versions',
    ).all());
    expect(persisted).not.toContain('whsec_managed-one-time');

    expect(store.update(ingress.ingress_id, {
      registration_mode: 'managed_endpoint',
    }).registration_state).toBe('registered');

    expect(() => store.retireCredentialVersion(ingress.ingress_id, 1))
      .toThrow('must be replaced through provider registration');

    const drifted = store.update(ingress.ingress_id, {
      selected_event_types: ['invoice.payment_failed'],
    });
    expect(drifted).toMatchObject({
      registration_state: 'drifted',
      last_error_code: 'managed_registration_drift',
    });
    expect(store.prepareManagedRegistration(ingress.ingress_id).expected.attempt)
      .toBe(2);
  });

  it('clears only registration faults after managed read-back', async () => {
    const { db, store } = makeStore();
    const ingress = createManagedStripe(store);
    const prepared = store.prepareManagedRegistration(ingress.ingress_id);
    const endpointUrl = `https://hooks.example/v1/webhooks/${ingress.public_id}`;
    await store.commitManagedRegistrationCreate({
      expected: prepared.expected,
      remote_endpoint_id: 'we_1234567890abcdef',
      endpoint_url: endpointUrl,
      credentials: { endpoint_secret: 'whsec_managed-one-time' },
      requires_handshake: false,
    });
    db.prepare(`
      UPDATE webhook_ingresses
      SET intake_state = 'degraded', last_error_code = 'profile_internal_error'
      WHERE ingress_id = ?
    `).run(ingress.ingress_id);

    const current = store.prepareManagedRegistration(ingress.ingress_id);
    expect(store.confirmManagedRegistrationReadBack({
      expected: current.expected,
      remote_endpoint_id: 'we_1234567890abcdef',
      endpoint_url: endpointUrl,
      requires_handshake: false,
    })).toMatchObject({
      intake_state: 'degraded',
      last_error_code: 'profile_internal_error',
      registration_state: 'registered',
    });
  });

  it('never commits a remote id when managed credential encryption is unavailable', async () => {
    let key: Uint8Array | null = KEY;
    const { store } = makeStore({ getEncryptionKey: () => key });
    const ingress = createManagedStripe(store);
    const prepared = store.prepareManagedRegistration(ingress.ingress_id);
    key = null;

    await expect(store.commitManagedRegistrationCreate({
      expected: prepared.expected,
      remote_endpoint_id: 'we_1234567890abcdef',
      endpoint_url: `https://hooks.example/v1/webhooks/${ingress.public_id}`,
      credentials: { endpoint_secret: 'whsec_not-committed' },
      requires_handshake: false,
    })).rejects.toMatchObject({ code: 'locked' });
    expect(store.get(ingress.ingress_id)).toMatchObject({
      remote_endpoint_id: null,
      registration_state: 'managed_pending',
      credential_set_ref: null,
    });
    expect(store.listCredentialVersions(ingress.ingress_id)).toEqual([]);
  });

  it('compare-and-sets managed commits and rotates the hidden idempotency generation', async () => {
    const { store } = makeStore();
    const ingress = createManagedStripe(store);
    const first = store.prepareManagedRegistration(ingress.ingress_id);
    const second = store.rotateManagedRegistrationAttempt(first.expected);
    expect(second.expected.attempt).toBe(2);
    expect(store.prepareManagedRegistration(ingress.ingress_id).expected.attempt).toBe(2);

    store.update(ingress.ingress_id, { selected_event_types: ['invoice.payment_failed'] });
    await expect(store.commitManagedRegistrationCreate({
      expected: second.expected,
      remote_endpoint_id: 'we_1234567890abcdef',
      endpoint_url: `https://hooks.example/v1/webhooks/${ingress.public_id}`,
      credentials: { endpoint_secret: 'whsec_stale' },
      requires_handshake: false,
    })).rejects.toMatchObject({ code: 'conflict' });
    expect(store.get(ingress.ingress_id)?.remote_endpoint_id).toBeNull();
    expect(() => store.update(ingress.ingress_id, {
      paired_connection_id: 'stripe-other',
    })).toThrow('paired connection is immutable');
  });

  it('does not let stale ambiguity and create outcomes overwrite each other', async () => {
    const endpoint = 'https://hooks.example/v1/webhooks/opaquePublicId_0123456789abcdef';

    const first = makeStore();
    const firstIngress = createManagedStripe(first.store);
    const staleFailure = first.store.prepareManagedRegistration(firstIngress.ingress_id);
    await first.store.commitManagedRegistrationCreate({
      expected: staleFailure.expected,
      remote_endpoint_id: 'we_1234567890abcdef',
      endpoint_url: endpoint,
      credentials: { endpoint_secret: 'whsec_concurrent-success' },
      requires_handshake: false,
    });
    expect(() => first.store.markManagedRegistrationDrift(
      staleFailure.expected,
      'managed_registration_ambiguous',
    )).toThrow('registration inputs changed');
    expect(first.store.get(firstIngress.ingress_id)).toMatchObject({
      remote_endpoint_id: 'we_1234567890abcdef',
      registration_state: 'registered',
    });

    const second = makeStore();
    const secondIngress = createManagedStripe(second.store);
    const staleCreate = second.store.prepareManagedRegistration(secondIngress.ingress_id);
    second.store.markManagedRegistrationDrift(
      staleCreate.expected,
      'managed_registration_ambiguous',
    );
    await expect(second.store.commitManagedRegistrationCreate({
      expected: staleCreate.expected,
      remote_endpoint_id: 'we_abcdef1234567890',
      endpoint_url: endpoint,
      credentials: { endpoint_secret: 'whsec_must-not-commit' },
      requires_handshake: false,
    })).rejects.toMatchObject({ code: 'conflict' });
    expect(second.store.get(secondIngress.ingress_id)).toMatchObject({
      remote_endpoint_id: null,
      registration_state: 'drifted',
      credential_set_ref: null,
    });
    expect(second.store.listCredentialVersions(secondIngress.ingress_id)).toEqual([]);
  });

  it('keeps an in-flight managed retirement visible for provider cleanup', () => {
    const { store } = makeStore();
    const ingress = createManagedStripe(store);
    store.prepareManagedRegistration(ingress.ingress_id);

    const retired = store.retire(ingress.ingress_id);
    expect(retired).toMatchObject({
      intake_state: 'retired',
      registration_state: 'cleanup_pending',
      remote_endpoint_id: null,
    });
    expect(store.list()).toEqual([expect.objectContaining({
      ingress_id: ingress.ingress_id,
      registration_state: 'cleanup_pending',
    })]);
    expect(() => store.update(ingress.ingress_id, {
      selected_event_types: ['invoice.payment_failed'],
    })).toThrow('retired webhook ingress is immutable');
  });

  it('atomically finalizes managed disable and retirement cleanup', async () => {
    const first = makeStore();
    const firstIngress = createManagedStripe(first.store);
    const firstPrepared = first.store.prepareManagedRegistration(firstIngress.ingress_id);
    const endpoint = `https://hooks.example/v1/webhooks/${firstIngress.public_id}`;
    await first.store.commitManagedRegistrationCreate({
      expected: firstPrepared.expected,
      remote_endpoint_id: 'we_cleanup123456789',
      endpoint_url: endpoint,
      credentials: { endpoint_secret: 'whsec_cleanup-disable' },
      requires_handshake: false,
    });
    expect(first.store.disable(firstIngress.ingress_id)).toMatchObject({
      intake_state: 'disabled',
      registration_state: 'cleanup_pending',
      remote_endpoint_id: 'we_cleanup123456789',
    });
    expect(() => first.store.update(firstIngress.ingress_id, {
      selected_event_types: ['invoice.payment_failed'],
    })).toThrow('event selection is immutable while managed registration cleanup is pending');
    const disableCleanup = first.store.prepareManagedRegistrationCleanup(
      firstIngress.ingress_id,
      'disable',
    );
    expect(first.store.completeManagedRegistrationCleanup({
      expected: disableCleanup.expected,
      intent: 'disable',
    })).toMatchObject({
      intake_state: 'disabled',
      registration_state: 'managed_pending',
      remote_endpoint_id: null,
      confirmed_endpoint_url: null,
    });
    expect(first.store.listCredentialVersions(firstIngress.ingress_id))
      .toEqual([expect.objectContaining({ active: false })]);
    expect(first.store.prepareManagedRegistration(firstIngress.ingress_id).expected.attempt)
      .toBe(2);

    const second = makeStore();
    const secondIngress = createManagedStripe(second.store);
    const secondPrepared = second.store.prepareManagedRegistration(secondIngress.ingress_id);
    await second.store.commitManagedRegistrationCreate({
      expected: secondPrepared.expected,
      remote_endpoint_id: 'we_retire1234567890',
      endpoint_url: `https://hooks.example/v1/webhooks/${secondIngress.public_id}`,
      credentials: { endpoint_secret: 'whsec_cleanup-retire' },
      requires_handshake: false,
    });
    expect(second.store.retire(secondIngress.ingress_id)).toMatchObject({
      intake_state: 'retired',
      registration_state: 'cleanup_pending',
    });
    const retireCleanup = second.store.prepareManagedRegistrationCleanup(
      secondIngress.ingress_id,
      'retire',
    );
    expect(second.store.completeManagedRegistrationCleanup({
      expected: retireCleanup.expected,
      intent: 'retire',
    })).toMatchObject({
      intake_state: 'retired',
      registration_state: 'retired',
      remote_endpoint_id: null,
    });
    expect(second.store.list()).toEqual([]);
  });

  it('rebinds a proven same-account connection without replacing the endpoint secret', async () => {
    const { db, store } = makeStore();
    const ingress = createManagedStripe(store);
    const prepared = store.prepareManagedRegistration(ingress.ingress_id);
    await store.commitManagedRegistrationCreate({
      expected: prepared.expected,
      remote_endpoint_id: 'we_aliasrebind1234567',
      endpoint_url: `https://hooks.example/v1/webhooks/${ingress.public_id}`,
      credentials: { endpoint_secret: 'whsec_alias-rebind' },
      requires_handshake: false,
    });
    store.enable(ingress.ingress_id);
    const snapshot = store.snapshotManagedRegistration(ingress.ingress_id);

    expect(store.commitManagedConnectionAliasRebind({
      expected: snapshot.expected,
      paired_connection_id: 'stripe-test-rotated',
    })).toMatchObject({
      paired_connection_id: 'stripe-test-rotated',
      pending_paired_connection_id: null,
      remote_endpoint_id: 'we_aliasrebind1234567',
      registration_state: 'registered',
      intake_state: 'enabled',
    });
    expect(store.listCredentialVersions(ingress.ingress_id))
      .toEqual([expect.objectContaining({ active: true })]);
    expect(db.prepare(`
      SELECT registration_attempt_connection_id FROM webhook_ingresses
      WHERE ingress_id = ?
    `).pluck().get(ingress.ingress_id)).toBe('stripe-test-rotated');
  });

  it('persists a different-account target until old cleanup atomically rebinds it', async () => {
    const { db, store } = makeStore();
    const ingress = createManagedStripe(store);
    const prepared = store.prepareManagedRegistration(ingress.ingress_id);
    await store.commitManagedRegistrationCreate({
      expected: prepared.expected,
      remote_endpoint_id: 'we_accountcutover12345',
      endpoint_url: `https://hooks.example/v1/webhooks/${ingress.public_id}`,
      credentials: { endpoint_secret: 'whsec_account-cutover' },
      requires_handshake: false,
    });
    store.enable(ingress.ingress_id);
    const snapshot = store.snapshotManagedRegistration(ingress.ingress_id);
    const cutover = store.prepareManagedConnectionRebind({
      expected: snapshot.expected,
      paired_connection_id: 'stripe-test-other-account',
    });
    expect(cutover).toMatchObject({
      cleanup_required: true,
      ingress: {
        paired_connection_id: 'stripe-test',
        pending_paired_connection_id: 'stripe-test-other-account',
        registration_state: 'cleanup_pending',
        intake_state: 'disabled',
      },
    });

    const cleanup = store.prepareManagedRegistrationCleanup(
      ingress.ingress_id,
      'rebind',
    );
    expect(store.completeManagedRegistrationCleanup({
      expected: cleanup.expected,
      intent: 'rebind',
    })).toMatchObject({
      paired_connection_id: 'stripe-test-other-account',
      pending_paired_connection_id: null,
      remote_endpoint_id: null,
      confirmed_endpoint_url: null,
      registration_state: 'managed_pending',
      intake_state: 'disabled',
    });
    expect(store.listCredentialVersions(ingress.ingress_id))
      .toEqual([expect.objectContaining({ active: false })]);
    expect(db.prepare(`
      SELECT registration_attempt, registration_attempt_connection_id
      FROM webhook_ingresses WHERE ingress_id = ?
    `).get(ingress.ingress_id)).toEqual({
      registration_attempt: 2,
      registration_attempt_connection_id: null,
    });

    const direct = store.prepareManagedConnectionRebind({
      expected: store.snapshotManagedRegistration(ingress.ingress_id).expected,
      paired_connection_id: 'stripe-test-third-account',
    });
    expect(direct).toMatchObject({
      cleanup_required: false,
      ingress: {
        paired_connection_id: 'stripe-test-third-account',
        registration_state: 'managed_pending',
        intake_state: 'disabled',
      },
    });
  });

  it('cancels a pending connection target when retirement supersedes cutover', async () => {
    const { store } = makeStore();
    const ingress = createManagedStripe(store);
    const prepared = store.prepareManagedRegistration(ingress.ingress_id);
    await store.commitManagedRegistrationCreate({
      expected: prepared.expected,
      remote_endpoint_id: 'we_cancelcutover123456',
      endpoint_url: `https://hooks.example/v1/webhooks/${ingress.public_id}`,
      credentials: { endpoint_secret: 'whsec_cancel-cutover' },
      requires_handshake: false,
    });
    store.prepareManagedConnectionRebind({
      expected: store.snapshotManagedRegistration(ingress.ingress_id).expected,
      paired_connection_id: 'stripe-test-never-bind',
    });
    store.retire(ingress.ingress_id);
    const cleanup = store.prepareManagedRegistrationCleanup(
      ingress.ingress_id,
      'retire',
    );

    expect(store.completeManagedRegistrationCleanup({
      expected: cleanup.expected,
      intent: 'retire',
    })).toMatchObject({
      paired_connection_id: 'stripe-test',
      pending_paired_connection_id: null,
      registration_state: 'retired',
      intake_state: 'retired',
    });
  });

  it('keeps cleanup snapshots out of registration-only store mutations', async () => {
    const { store } = makeStore();
    const ingress = createManagedStripe(store);
    store.prepareManagedRegistration(ingress.ingress_id);
    store.retire(ingress.ingress_id);
    const cleanup = store.prepareManagedRegistrationCleanup(
      ingress.ingress_id,
      'retire',
    );

    expect(() => store.rotateManagedRegistrationAttempt(cleanup.expected))
      .toThrow('webhook ingress is retired');
    expect(() => store.markManagedRegistrationDrift(
      cleanup.expected,
      'managed_registration_drift',
    )).toThrow('webhook ingress is retired');
    await expect(store.commitManagedRegistrationCreate({
      expected: cleanup.expected,
      remote_endpoint_id: 'we_mustnotresurrect123',
      endpoint_url: `https://hooks.example/v1/webhooks/${ingress.public_id}`,
      credentials: { endpoint_secret: 'whsec_must-not-resurrect' },
      requires_handshake: false,
    })).rejects.toMatchObject({ code: 'retired' });
    expect(store.get(ingress.ingress_id)).toMatchObject({
      intake_state: 'retired',
      registration_state: 'cleanup_pending',
      remote_endpoint_id: null,
      credential_set_ref: null,
    });
    expect(store.listCredentialVersions(ingress.ingress_id)).toEqual([]);
  });

  it('finishes cleanup at an exhausted generation but refuses unsafe recreation', async () => {
    const { db, store } = makeStore();
    const ingress = createManagedStripe(store);
    const prepared = store.prepareManagedRegistration(ingress.ingress_id);
    await store.commitManagedRegistrationCreate({
      expected: prepared.expected,
      remote_endpoint_id: 'we_exhaustedcleanup123',
      endpoint_url: `https://hooks.example/v1/webhooks/${ingress.public_id}`,
      credentials: { endpoint_secret: 'whsec_exhausted-cleanup' },
      requires_handshake: false,
    });
    db.prepare(`
      UPDATE webhook_ingresses SET registration_attempt = ? WHERE ingress_id = ?
    `).run(Number.MAX_SAFE_INTEGER, ingress.ingress_id);

    store.disable(ingress.ingress_id);
    const cleanup = store.prepareManagedRegistrationCleanup(
      ingress.ingress_id,
      'disable',
    );
    expect(store.completeManagedRegistrationCleanup({
      expected: cleanup.expected,
      intent: 'disable',
    })).toMatchObject({
      intake_state: 'disabled',
      registration_state: 'managed_pending',
      remote_endpoint_id: null,
    });
    expect(() => store.prepareManagedRegistration(ingress.ingress_id))
      .toThrow('webhook registration attempt counter is exhausted');
  });

  it('treats reordered event selections as the same cleanup CAS input', async () => {
    const { store } = makeStore();
    const ingress = createManagedStripe(store);
    store.update(ingress.ingress_id, {
      selected_event_types: ['invoice.paid', 'invoice.payment_failed'],
    });
    const prepared = store.prepareManagedRegistration(ingress.ingress_id);
    await store.commitManagedRegistrationCreate({
      expected: prepared.expected,
      remote_endpoint_id: 'we_reorderedcleanup123',
      endpoint_url: `https://hooks.example/v1/webhooks/${ingress.public_id}`,
      credentials: { endpoint_secret: 'whsec_reordered-cleanup' },
      requires_handshake: false,
    });
    store.disable(ingress.ingress_id);
    const cleanup = store.prepareManagedRegistrationCleanup(
      ingress.ingress_id,
      'disable',
    );
    store.update(ingress.ingress_id, {
      selected_event_types: ['invoice.payment_failed', 'invoice.paid'],
    });

    expect(store.completeManagedRegistrationCleanup({
      expected: cleanup.expected,
      intent: 'disable',
    })).toMatchObject({
      intake_state: 'disabled',
      registration_state: 'managed_pending',
      remote_endpoint_id: null,
    });
  });

  it('persists only AEAD ciphertext and decrypts active versions internally', async () => {
    const { db, store } = makeStore();
    const row = createStripe(store);
    const secret = 'whsec_super-sensitive-value';
    const metadata = await store.writeCredentialVersion(row.ingress_id, {
      endpoint_secret: secret,
    });

    expect(metadata).toMatchObject({
      version: '1',
      retired_at: null,
      configured_fields: ['endpoint_secret'],
    });
    const stored = db.prepare(`
      SELECT ciphertext, configured_fields_json
      FROM webhook_credential_versions
    `).get() as { ciphertext: string; configured_fields_json: string };
    expect(stored.ciphertext).not.toContain(secret);
    expect(stored.configured_fields_json).toBe('["endpoint_secret"]');
    expect(JSON.stringify(db.prepare('SELECT * FROM webhook_ingresses').all()))
      .not.toContain(secret);

    await expect(store.readActiveCredentialVersions(row.ingress_id)).resolves.toEqual([
      {
        version: '1',
        created_at: metadata.created_at,
        credentials: { endpoint_secret: secret },
      },
    ]);
    expect(store.get(row.ingress_id)?.intake_state).toBe('verification_pending');
  });

  it('keeps encrypted credential rows out of the server audit export', async () => {
    const { db, store } = makeStore();
    const row = createStripe(store);
    const secret = 'whsec_must-not-enter-export';
    await store.writeCredentialVersion(row.ingress_id, { endpoint_secret: secret });
    const stored = db.prepare(`
      SELECT ciphertext, credential_set_ref FROM webhook_credential_versions
    `).get() as { ciphertext: string; credential_set_ref: string };

    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_entries (
        key TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
    `);
    ensureMemorySchema(db);
    const auditLog = createAuditLogStore(
      createInMemoryCollection(),
      createInMemoryCollection(),
    );
    await auditLog.append(buildAuditEntry({
      run_id: 'run-webhook-export-regression',
      recipe_id: 'recipe-safe',
      recipe_hash: 'hash-safe',
      now: 1_800_000_000_100,
      duration_ms: 0,
      commit_status: 'succeeded',
      config_snapshot: {},
      errors: [],
      trigger_url: null,
      trigger_source: 'manual',
      instance_id: 'owner-webclient',
    }));

    const page = await handleAuditExportPage({
      db,
      auditLog,
      serverInstanceId: 'server-webhook-export-regression',
    }, { format: 'json' });
    const exported = JSON.stringify(page);
    expect(exported).not.toContain(secret);
    expect(exported).not.toContain(stored.ciphertext);
    expect(exported).not.toContain(stored.credential_set_ref);
    expect(exported).not.toContain('webhook_credential_versions');
  });

  it('keeps bounded-overlap versions active until an explicit retirement', async () => {
    const { store } = makeStore();
    const row = createStripe(store);
    await store.writeCredentialVersion(row.ingress_id, { endpoint_secret: 'old-secret' });
    await store.writeCredentialVersion(row.ingress_id, { endpoint_secret: 'new-secret' });

    expect((await store.readActiveCredentialVersions(row.ingress_id)).map((v) => v.version))
      .toEqual(['2', '1']);
    await expect(store.writeCredentialVersion(row.ingress_id, {
      endpoint_secret: 'third-secret-before-retirement',
    })).rejects.toMatchObject({ code: 'invalid_state' });
    store.retireCredentialVersion(row.ingress_id, 1);
    await store.writeCredentialVersion(row.ingress_id, { endpoint_secret: 'third-secret' });
    expect((await store.readActiveCredentialVersions(row.ingress_id)).map((v) => v.version))
      .toEqual(['3', '2']);
    expect(store.listCredentialVersions(row.ingress_id)).toEqual([
      expect.objectContaining({ version: '3', retired_at: null }),
      expect.objectContaining({ version: '2', retired_at: null }),
      expect.objectContaining({ version: '1', retired_at: expect.any(Number) }),
    ]);
  });

  it('does not retire the last verifier credential from a ready ingress', async () => {
    const { db, store } = makeStore();
    const row = createStripe(store);
    await store.writeCredentialVersion(row.ingress_id, { endpoint_secret: 'only-secret' });
    db.prepare(`
      UPDATE webhook_ingresses
      SET intake_state = 'ready', registration_state = 'registered'
      WHERE ingress_id = ?
    `).run(row.ingress_id);

    expect(() => store.retireCredentialVersion(row.ingress_id, 1))
      .toThrowError(WebhookIngressStoreError);
    expect(() => store.retireCredentialVersion(row.ingress_id, 1))
      .toThrow('disable the ingress or activate a replacement');
    expect(store.listCredentialVersions(row.ingress_id)).toEqual([
      expect.objectContaining({ version: '1', active: true, retired_at: null }),
    ]);
  });

  it('does not clear an unrelated health fault when a manual URL is reconfirmed', async () => {
    const { db, store } = makeStore();
    const row = createStripe(store);
    await store.writeCredentialVersion(row.ingress_id, { endpoint_secret: 'secret' });
    store.confirmManualRegistration(row.ingress_id, {
      requires_handshake: false,
      endpoint_url: `https://hooks-one.example/v1/webhooks/${row.public_id}`,
    });
    db.prepare(`
      UPDATE webhook_ingresses
      SET intake_state = 'degraded', last_error_code = 'remote_endpoint_drift'
      WHERE ingress_id = ?
    `).run(row.ingress_id);

    const reconfirmed = store.confirmManualRegistration(row.ingress_id, {
      requires_handshake: false,
      endpoint_url: `https://hooks-two.example/v1/webhooks/${row.public_id}`,
    });
    expect(reconfirmed).toMatchObject({
      intake_state: 'degraded',
      last_error_code: 'remote_endpoint_drift',
      confirmed_endpoint_url: `https://hooks-two.example/v1/webhooks/${row.public_id}`,
    });
  });

  it('re-arms a required handshake when the confirmed manual URL changes', async () => {
    const { store } = makeStore();
    const row = store.create({
      display_name: 'Slack events',
      profile_id: 'slack.request.v0',
      environment: 'live',
      paired_connection_id: null,
      registration_mode: 'manual',
      selected_event_types: ['event_callback'],
    });
    await store.writeCredentialVersion(row.ingress_id, {
      signing_secret: 'slack-signing-secret',
    });
    const firstEndpoint = `https://hooks-one.example/v1/webhooks/${row.public_id}`;
    store.confirmManualRegistration(row.ingress_id, {
      requires_handshake: true,
      endpoint_url: firstEndpoint,
    });
    store.confirmHandshakeReadiness(row.ingress_id);
    store.enable(row.ingress_id);
    expect(store.get(row.ingress_id)).toMatchObject({
      intake_state: 'enabled',
      enabled_at: expect.any(Number),
    });

    expect(store.confirmManualRegistration(row.ingress_id, {
      requires_handshake: true,
      endpoint_url: firstEndpoint,
    })).toMatchObject({
      intake_state: 'enabled',
      enabled_at: expect.any(Number),
    });

    const secondEndpoint = `https://hooks-two.example/v1/webhooks/${row.public_id}`;
    expect(store.confirmManualRegistration(row.ingress_id, {
      requires_handshake: true,
      endpoint_url: secondEndpoint,
    })).toMatchObject({
      confirmed_endpoint_url: secondEndpoint,
      intake_state: 'verification_pending',
      enabled_at: null,
    });
    expect(() => store.enable(row.ingress_id))
      .toThrow('webhook ingress is not ready to enable');
  });

  it('binds ciphertext to ingress/profile/environment/version with AAD', async () => {
    const { db, store } = makeStore();
    const row = createStripe(store);
    await store.writeCredentialVersion(row.ingress_id, { endpoint_secret: 'bound-secret' });
    db.prepare(`
      UPDATE webhook_credential_versions SET version = 2 WHERE ingress_id = ?
    `).run(row.ingress_id);
    await expect(store.readActiveCredentialVersions(row.ingress_id)).rejects.toMatchObject({
      code: 'corrupt',
    });
  });

  it('authenticates configured-field readiness metadata with the ciphertext', async () => {
    const { db, store } = makeStore();
    const row = createStripe(store);
    await store.writeCredentialVersion(row.ingress_id, { endpoint_secret: 'bound-secret' });
    db.prepare(`
      UPDATE webhook_credential_versions
      SET configured_fields_json = '["endpoint_secret","forged_field"]'
      WHERE ingress_id = ?
    `).run(row.ingress_id);
    await expect(store.readActiveCredentialVersions(row.ingress_id)).rejects.toMatchObject({
      code: 'corrupt',
    });
  });

  it('rejects a credential write whose profile/environment changes during encryption', async () => {
    const { store } = makeStore();
    const row = createStripe(store);
    const pending = store.writeCredentialVersion(row.ingress_id, {
      endpoint_secret: 'stale-aad-secret',
    });
    store.update(row.ingress_id, { environment: 'test' });

    await expect(pending).rejects.toMatchObject({ code: 'conflict' });
    expect(store.listCredentialVersions(row.ingress_id)).toEqual([]);
    expect(store.get(row.ingress_id)).toMatchObject({
      environment: 'test',
      intake_state: 'draft',
      credential_set_ref: null,
    });
  });

  it('cannot commit an active credential after ingress retirement wins the race', async () => {
    const { store } = makeStore();
    const row = createStripe(store);
    const pending = store.writeCredentialVersion(row.ingress_id, {
      endpoint_secret: 'must-not-reactivate',
    });
    store.retire(row.ingress_id);

    await expect(pending).rejects.toMatchObject({ code: 'retired' });
    expect(store.listCredentialVersions(row.ingress_id)).toEqual([]);
    expect(store.get(row.ingress_id)).toMatchObject({
      intake_state: 'retired',
      credential_set_ref: null,
    });
  });

  it('cannot commit ciphertext after the vault locks during encryption', async () => {
    let unlocked = true;
    const { store } = makeStore({
      getEncryptionKey: () => unlocked ? KEY : null,
    });
    const row = createStripe(store);
    const pending = store.writeCredentialVersion(row.ingress_id, {
      endpoint_secret: 'must-not-land-after-lock',
    });
    unlocked = false;

    await expect(pending).rejects.toMatchObject({ code: 'locked' });
    expect(store.listCredentialVersions(row.ingress_id)).toEqual([]);
    expect(store.get(row.ingress_id)).toMatchObject({
      intake_state: 'draft',
      credential_set_ref: null,
    });
  });

  it('does not return credentials after a vault lock or retirement wins the decrypt race', async () => {
    let unlocked = true;
    const { store } = makeStore({
      getEncryptionKey: () => unlocked ? KEY : null,
    });
    const row = createStripe(store);
    await store.writeCredentialVersion(row.ingress_id, { endpoint_secret: 'read-race' });

    const lockedRead = store.readActiveCredentialVersions(row.ingress_id);
    unlocked = false;
    await expect(lockedRead).rejects.toMatchObject({ code: 'locked' });

    unlocked = true;
    const retiredRead = store.readActiveCredentialVersions(row.ingress_id);
    store.retireCredentialVersion(row.ingress_id, 1);
    await expect(retiredRead).resolves.toEqual([]);
  });

  it('fails closed while locked without breaking secret-free metadata reads', async () => {
    const { store } = makeStore({ key: null });
    const row = createStripe(store);
    expect(store.list()).toHaveLength(1);
    await expect(store.writeCredentialVersion(row.ingress_id, {
      endpoint_secret: 'must-not-persist',
    })).rejects.toBeInstanceOf(WebhookIngressStoreError);
    await expect(store.writeCredentialVersion(row.ingress_id, {
      endpoint_secret: 'must-not-persist',
    })).rejects.toMatchObject({ code: 'locked' });
    expect(store.listCredentialVersions(row.ingress_id)).toEqual([]);
  });

  it('closes only connection-required ingresses and preserves manual profiles on API deletion', async () => {
    const { store } = makeStore({ ids: false });
    const managed = store.create({
      display_name: 'Managed connection',
      profile_id: 'stripe.event.v1',
      environment: 'test',
      paired_connection_id: 'shared-api',
      registration_mode: 'managed_endpoint',
      selected_event_types: ['invoice.paid'],
    });
    const operationBound = store.create({
      display_name: 'Operation-bound connection',
      profile_id: 'generic.static-header-token.v1',
      environment: 'test',
      paired_connection_id: 'shared-api',
      registration_mode: 'operation_bound',
      selected_event_types: ['delivery'],
    });
    const manual = store.create({
      display_name: 'Connection-free manual setup',
      profile_id: 'generic.static-header-token.v1',
      environment: 'test',
      paired_connection_id: 'shared-api',
      registration_mode: 'manual',
      selected_event_types: ['delivery'],
    });
    const unrelated = store.create({
      display_name: 'Other API connection',
      profile_id: 'stripe.event.v1',
      environment: 'test',
      paired_connection_id: 'other-api',
      registration_mode: 'managed_endpoint',
      selected_event_types: ['invoice.paid'],
    });
    await store.writeCredentialVersion(manual.ingress_id, {
      header_name: 'X-Manual-Token',
      header_token: 'manual-token',
    });
    store.confirmManualRegistration(manual.ingress_id, {
      requires_handshake: false,
      endpoint_url: `https://hooks.example/v1/webhooks/${manual.public_id}`,
    });
    store.enable(manual.ingress_id);

    expect(store.failCloseForDeletedPairedConnection('shared-api')).toBe(2);
    expect(store.get(managed.ingress_id)).toMatchObject({
      intake_state: 'disabled',
      registration_state: 'drifted',
      last_error_code: 'paired_connection_deleted',
    });
    expect(store.get(operationBound.ingress_id)).toMatchObject({
      intake_state: 'draft',
      registration_state: 'not_applicable',
      last_error_code: 'paired_connection_deleted',
    });
    expect(store.get(manual.ingress_id)).toMatchObject({
      intake_state: 'enabled',
      registration_state: 'registered',
      last_error_code: null,
    });
    expect(store.get(unrelated.ingress_id)).toMatchObject({
      intake_state: 'draft',
      registration_state: 'managed_pending',
      last_error_code: null,
    });
    expect(store.retire(operationBound.ingress_id)).toMatchObject({
      intake_state: 'retired',
      registration_state: 'retired',
    });
  });

  it('keeps a deleted-connection latch closed until explicit operation-bound recovery', async () => {
    const { store } = makeStore({ ids: false });
    const row = store.create({
      display_name: 'Operation-bound recovery',
      profile_id: 'generic.static-header-token.v1',
      environment: 'test',
      paired_connection_id: 'provider-api',
      registration_mode: 'operation_bound',
      selected_event_types: ['delivery'],
    });
    await store.writeCredentialVersion(row.ingress_id, {
      header_name: 'X-Provider-Signature',
      header_token: 'provider-secret',
    });
    store.confirmOperationBoundReadiness(row.ingress_id);
    store.enable(row.ingress_id);

    store.failCloseForDeletedPairedConnection('provider-api');
    expect(() => store.enable(row.ingress_id)).toThrow('explicit rebind');
    expect(store.recoverDeletedOperationBoundConnection(
      row.ingress_id,
      'provider-api',
    )).toMatchObject({
      paired_connection_id: 'provider-api',
      intake_state: 'disabled',
      last_error_code: null,
    });
    expect(store.enable(row.ingress_id)).toMatchObject({
      intake_state: 'enabled',
      last_error_code: null,
    });
  });

  it('preserves the API connection and every ingress when fail-close metadata is corrupt', () => {
    const { db, store } = makeStore({ ids: false });
    const connections = createConnectionStore(db);
    connections.upsert({
      kind: 'api',
      name: 'atomic-api',
      display_name: 'Atomic API',
      config_json: '{}',
      auth_ciphertext: 'ciphertext',
      enrolled_at: 1,
      updated_at: 1,
    });
    const first = store.create({
      display_name: 'First required ingress',
      profile_id: 'stripe.event.v1',
      environment: 'test',
      paired_connection_id: 'atomic-api',
      registration_mode: 'managed_endpoint',
      selected_event_types: ['invoice.paid'],
    });
    const corrupt = store.create({
      display_name: 'Corrupt required ingress',
      profile_id: 'stripe.event.v1',
      environment: 'test',
      paired_connection_id: 'atomic-api',
      registration_mode: 'managed_endpoint',
      selected_event_types: ['invoice.paid'],
    });
    db.prepare(`
      UPDATE webhook_ingresses SET profile_id = 'future.unknown.v1'
      WHERE ingress_id = ?
    `).run(corrupt.ingress_id);
    connections.addBeforeDelete((kind, name) => {
      if (kind === 'api') store.failCloseForDeletedPairedConnection(name);
      return undefined;
    });

    expect(() => connections.delete('api', 'atomic-api'))
      .toThrow('references an unknown profile');
    expect(connections.get('api', 'atomic-api')).not.toBeNull();
    expect(store.get(first.ingress_id)).toMatchObject({
      intake_state: 'draft',
      registration_state: 'managed_pending',
      last_error_code: null,
    });
  });

  it('retires the public identity and every active credential atomically', async () => {
    const { db, store } = makeStore();
    const row = createStripe(store);
    await store.writeCredentialVersion(row.ingress_id, { endpoint_secret: 'retire-me' });
    const retired = store.retire(row.ingress_id);
    expect(retired).toMatchObject({
      intake_state: 'retired',
      registration_state: 'retired',
      enabled_at: null,
    });
    expect(store.list()).toEqual([]);
    expect(store.list({ include_retired: true })).toHaveLength(1);
    expect(await store.readActiveCredentialVersions(row.ingress_id)).toEqual([]);
    expect(db.prepare(`
      SELECT state FROM webhook_credential_versions
    `).pluck().all()).toEqual(['retired']);
  });
});
