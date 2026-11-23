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
  WEBHOOK_LAST_DELIVERY_AHEAD_TOLERANCE_MS,
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

    expect(store.failCloseForDeletedPairedConnection('shared-api', 'api')).toBe(2);
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

    store.failCloseForDeletedPairedConnection('provider-api', 'api');
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
      if (kind === 'api') store.failCloseForDeletedPairedConnection(name, kind);
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

describe('D-201 Slices 10K + 10O — every success, rotation, rebind and cleanup clears the unknown-names codes', () => {
  const CODES = [
    'managed_registration_event_types_unknown',
    'managed_registration_event_types_unrestored',
  ] as const;
  const setCode = (db: Database.Database, ingressId: string, code: string): void => {
    db.prepare(`
      UPDATE webhook_ingresses SET last_error_code = ?, last_error_event_types_json = '["mesage"]'
      WHERE ingress_id = ?
    `).run(code, ingressId);
  };
  const codeOf = (store: WebhookIngressStore, ingressId: string) => store.get(ingressId)?.last_error_code;

  for (const code of CODES) {
    it(`${code}: a rotation, a committed create and a confirmed read-back`, async () => {
      const { db, store } = makeStore();
      const ingress = createManagedStripe(store);
      const endpointUrl = `https://hooks.example/v1/webhooks/${ingress.public_id}`;
      const first = store.prepareManagedRegistration(ingress.ingress_id);
      setCode(db, ingress.ingress_id, code);
      const rotated = store.rotateManagedRegistrationAttempt(first.expected);
      expect(codeOf(store, ingress.ingress_id)).toBeNull();
      setCode(db, ingress.ingress_id, code);
      await store.commitManagedRegistrationCreate({
        expected: rotated.expected,
        remote_endpoint_id: 'we_1234567890abcdef',
        endpoint_url: endpointUrl,
        credentials: { endpoint_secret: 'whsec_managed-one-time' },
        requires_handshake: false,
      });
      expect(codeOf(store, ingress.ingress_id)).toBeNull();
      setCode(db, ingress.ingress_id, code);
      const current = store.prepareManagedRegistration(ingress.ingress_id);
      store.confirmManagedRegistrationReadBack({
        expected: current.expected,
        remote_endpoint_id: 'we_1234567890abcdef',
        endpoint_url: endpointUrl,
        requires_handshake: false,
      });
      expect(codeOf(store, ingress.ingress_id)).toBeNull();
    });

    it(`${code}: a rebind that needs cleanup, its cleanup, and a rebind that needs none`, async () => {
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
      setCode(db, ingress.ingress_id, code);
      expect(store.prepareManagedConnectionRebind({
        expected: store.snapshotManagedRegistration(ingress.ingress_id).expected,
        paired_connection_id: 'stripe-test-other-account',
      })).toMatchObject({ cleanup_required: true });
      expect(codeOf(store, ingress.ingress_id)).toBeNull();
      setCode(db, ingress.ingress_id, code);
      const cleanup = store.prepareManagedRegistrationCleanup(ingress.ingress_id, 'rebind');
      store.completeManagedRegistrationCleanup({ expected: cleanup.expected, intent: 'rebind' });
      expect(codeOf(store, ingress.ingress_id)).toBeNull();
      setCode(db, ingress.ingress_id, code);
      expect(store.prepareManagedConnectionRebind({
        expected: store.snapshotManagedRegistration(ingress.ingress_id).expected,
        paired_connection_id: 'stripe-test-third-account',
      })).toMatchObject({ cleanup_required: false });
      expect(codeOf(store, ingress.ingress_id)).toBeNull();
    });
  }
});

describe('D-201 Slice 10Z — a create that may still land, as the store keeps it', () => {
  it('keeps one with its connection and canonical address, oldest first, and settling twice is a no-op', () => {
    const { store } = makeStore();
    const ingress = createManagedStripe(store);
    const url = `https://hooks.example/v1/webhooks/${ingress.public_id}`;
    const first = store.recordUnsettledCreate({ ingress_id: ingress.ingress_id, connection_id: 'stripe-test', endpoint_url: url });
    const second = store.recordUnsettledCreate({ ingress_id: ingress.ingress_id, connection_id: 'stripe-other', endpoint_url: url });
    expect(first.create_id).toMatch(/^whu_[0-9a-f]{32}$/);
    expect(store.listUnsettledCreates()).toEqual([first, second]);
    expect(second.sent_at).toBeGreaterThan(first.sent_at);
    store.settleUnsettledCreate(first.create_id);
    store.settleUnsettledCreate(first.create_id);
    expect(store.listUnsettledCreates()).toEqual([second]);
  });

  it('refuses one without a connection, at another address, or for no webhook', () => {
    const { store } = makeStore();
    const ingress = createManagedStripe(store);
    const url = `https://hooks.example/v1/webhooks/${ingress.public_id}`;
    for (const input of [
      { ingress_id: ingress.ingress_id, connection_id: ' ', endpoint_url: url },
      { ingress_id: ingress.ingress_id, connection_id: 'stripe-test', endpoint_url: 'https://hooks.example/v1/webhooks/someoneElse_0123456789abcdef' },
      { ingress_id: ingress.ingress_id, connection_id: 'stripe-test', endpoint_url: `http://hooks.example/v1/webhooks/${ingress.public_id}` },
    ]) {
      expect(() => store.recordUnsettledCreate(input)).toThrow(expect.objectContaining({ code: 'invalid_state' }));
    }
    expect(() => store.recordUnsettledCreate({ ingress_id: 'whi_missing', connection_id: 'stripe-test', endpoint_url: url }))
      .toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(store.listUnsettledCreates()).toEqual([]);
  });

  it('stores a refusal on a default it was on already apart from one it could not be put back from, its names beside it', () => {
    const { store } = makeStore();
    const ingress = createManagedStripe(store);
    store.prepareManagedRegistration(ingress.ingress_id);
    const mark = (options: { left_on_default?: boolean; was_on_default?: boolean }) => {
      store.markManagedRegistrationEventTypesUnknown(
        store.snapshotManagedRegistration(ingress.ingress_id).expected,
        ['mesage'],
        options,
      );
      return store.get(ingress.ingress_id)!;
    };
    expect(mark({ left_on_default: true, was_on_default: true })).toMatchObject({
      last_error_code: 'managed_registration_event_types_on_default',
      last_error_event_types: ['mesage'],
    });
    expect(mark({ left_on_default: true })).toMatchObject({
      last_error_code: 'managed_registration_event_types_unrestored',
      last_error_event_types: ['mesage'],
    });
    // Without left_on_default, was_on_default says nothing.
    expect(mark({ was_on_default: true }).last_error_code).toBe('managed_registration_event_types_unknown');
  });

  // D-201 Slice 10AD (10AA finding 26) — the other four of its six sites: a
  // new attempt, a commit, and a rebind with and without a cleanup.
  it('a new attempt, a commit, and a rebind either way clear a stored on-default refusal too', async () => {
    const onDefault = (store: ReturnType<typeof makeStore>['store'], id: string) => store
      .markManagedRegistrationEventTypesUnknown(
        store.snapshotManagedRegistration(id).expected,
        ['mesage'],
        { left_on_default: true, was_on_default: true },
      ).last_error_code;
    // A new attempt, nothing committed.
    {
      const { store } = makeStore();
      const id = createManagedStripe(store).ingress_id;
      store.prepareManagedRegistration(id);
      expect(onDefault(store, id)).toBe('managed_registration_event_types_on_default');
      store.rotateManagedRegistrationAttempt(store.snapshotManagedRegistration(id).expected);
      expect(store.get(id)!.last_error_code).toBeNull();
    }
    // A commit, and a rebind that has an endpoint to clean up.
    {
      const { store } = makeStore();
      const ingress = createManagedStripe(store);
      const id = ingress.ingress_id;
      store.prepareManagedRegistration(id);
      expect(onDefault(store, id)).toBe('managed_registration_event_types_on_default');
      const committed = await store.commitManagedRegistrationCreate({
        expected: store.snapshotManagedRegistration(id).expected,
        remote_endpoint_id: 'we_0000000000000002',
        endpoint_url: `https://hooks.example/v1/webhooks/${ingress.public_id}`,
        credentials: { endpoint_secret: 'whsec_StoreFixtureSecret123' },
        requires_handshake: false,
      });
      expect(committed.last_error_code).toBeNull();
      expect(onDefault(store, id)).toBe('managed_registration_event_types_on_default');
      const rebound = store.prepareManagedConnectionRebind({
        expected: store.snapshotManagedRegistration(id).expected,
        paired_connection_id: 'stripe-other',
      });
      expect(rebound.cleanup_required).toBe(true);
      expect(rebound.ingress.last_error_code).toBeNull();
    }
    // A rebind with nothing to clean up: no attempt made, nothing committed.
    {
      const { store } = makeStore();
      const id = createManagedStripe(store).ingress_id;
      expect(onDefault(store, id)).toBe('managed_registration_event_types_on_default');
      const rebound = store.prepareManagedConnectionRebind({
        expected: store.snapshotManagedRegistration(id).expected,
        paired_connection_id: 'stripe-other',
      });
      expect(rebound.cleanup_required).toBe(false);
      expect(rebound.ingress.last_error_code).toBeNull();
    }
  });

  it('a confirmation, and a switch-off whose cleanup completes, clear a stored on-default refusal as they clear the others', async () => {
    const { store } = makeStore();
    const ingress = createManagedStripe(store);
    const id = ingress.ingress_id;
    const url = `https://hooks.example/v1/webhooks/${ingress.public_id}`;
    const remoteId = 'we_0000000000000001';
    await store.commitManagedRegistrationCreate({
      expected: store.prepareManagedRegistration(id).expected,
      remote_endpoint_id: remoteId,
      endpoint_url: url,
      credentials: { endpoint_secret: 'whsec_StoreFixtureSecret123' },
      requires_handshake: false,
    });
    const onDefault = () => store.markManagedRegistrationEventTypesUnknown(
      store.snapshotManagedRegistration(id).expected,
      ['mesage'],
      { left_on_default: true, was_on_default: true },
    ).last_error_code;
    expect(onDefault()).toBe('managed_registration_event_types_on_default');
    expect(store.confirmManagedRegistrationReadBack({
      expected: store.snapshotManagedRegistration(id).expected,
      remote_endpoint_id: remoteId,
      endpoint_url: url,
      requires_handshake: false,
    }).last_error_code).toBeNull();
    store.enable(id);
    expect(onDefault()).toBe('managed_registration_event_types_on_default');
    expect(store.disable(id)).toMatchObject({ registration_state: 'cleanup_pending' });
    expect(store.completeManagedRegistrationCleanup({
      expected: store.prepareManagedRegistrationCleanup(id, 'disable').expected,
      intent: 'disable',
    }).last_error_code).toBeNull();
  });
});

describe('D-201 Slice 10AH — what the store keeps of a stray and of its failed searches (10AE findings 8 and 9)', () => {
  it('keeps a stray a rebind found apart from a create, and counts the strays of each webhook', () => {
    const { store } = makeStore();
    const ingress = createManagedStripe(store);
    const url = `https://hooks.example/v1/webhooks/${ingress.public_id}`;
    const create = store.recordUnsettledCreate({ ingress_id: ingress.ingress_id, connection_id: 'stripe-test', endpoint_url: url });
    const stray = store.recordUnsettledCreate({
      ingress_id: ingress.ingress_id, connection_id: 'stripe-other', endpoint_url: url, kind: 'stray',
    });
    expect(create).toMatchObject({ kind: 'create', unreached_ms: 0, unreached_last_at: null, unreached_since: null });
    expect(stray).toMatchObject({ kind: 'stray' });
    expect(store.listUnsettledCreates()).toEqual([create, stray]);
    expect(store.countStrayEndpoints(ingress.ingress_id)).toBe(1);
    expect(store.countStrayEndpoints('whi_ffffffffffffffffffffffffffffffff')).toBe(0);
    store.settleUnsettledCreate(stray.create_id);
    expect(store.countStrayEndpoints(ingress.ingress_id)).toBe(0);
  });

  it('notes how long its searches have failed, and a search that reaches it clears that', () => {
    const { store } = makeStore();
    const ingress = createManagedStripe(store);
    const url = `https://hooks.example/v1/webhooks/${ingress.public_id}`;
    const record = store.recordUnsettledCreate({ ingress_id: ingress.ingress_id, connection_id: 'stripe-test', endpoint_url: url });
    store.noteUnsettledCreateUnreached(record.create_id, 5_000, 0);
    store.noteUnsettledCreateUnreached(record.create_id, 9_000, 4_000);
    expect(store.listUnsettledCreates()[0]).toMatchObject({
      unreached_since: 5_000, unreached_ms: 4_000, unreached_last_at: 9_000,
    });
    store.noteUnsettledCreateReached(record.create_id);
    expect(store.listUnsettledCreates()[0]).toMatchObject({
      unreached_since: null, unreached_ms: 0, unreached_last_at: null,
    });
  });

  it('opens a table from before 10AH in place: a run of failures counts on from its first failed search', () => {
    const db = new Database(':memory:');
    databases.push(db);
    const options = {
      now: () => 1_800_000_000_000,
      getEncryptionKey: () => KEY,
      newIngressId: () => 'whi_0123456789abcdef0123456789abcdef',
      newPublicId: () => 'opaquePublicId_0123456789abcdef',
      newCredentialSetRef: () => 'whc_0123456789abcdef0123456789abcdef',
    };
    const ingress = createManagedStripe(createWebhookIngressStore(db, options));
    const url = `https://hooks.example/v1/webhooks/${ingress.public_id}`;
    // The table as 10AD left it, with one record whose searches began to fail.
    db.exec(`
      DROP TABLE webhook_registration_unsettled_creates;
      CREATE TABLE webhook_registration_unsettled_creates (
        create_id TEXT PRIMARY KEY,
        ingress_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        endpoint_url TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        unreached_since INTEGER,
        FOREIGN KEY (ingress_id) REFERENCES webhook_ingresses(ingress_id) ON DELETE CASCADE
      );
    `);
    db.prepare(`
      INSERT INTO webhook_registration_unsettled_creates VALUES (?, ?, 'stripe-test', ?, 1000, 7000)
    `).run('whu_0123456789abcdef0123456789abcdef', ingress.ingress_id, url);
    const reopened = createWebhookIngressStore(db, options);
    expect(reopened.listUnsettledCreates()).toEqual([{
      create_id: 'whu_0123456789abcdef0123456789abcdef',
      ingress_id: ingress.ingress_id,
      connection_id: 'stripe-test',
      endpoint_url: url,
      sent_at: 1000,
      kind: 'create',
      remote_endpoint_id: null,
      unreached_since: 7000,
      unreached_ms: 0,
      unreached_last_at: 7000,
    }]);
    // Opened again: nothing changes.
    expect(createWebhookIngressStore(db, options).listUnsettledCreates()).toEqual(reopened.listUnsettledCreates());
  });
});

describe('D-201 Slice 10AL — the sweep\'s edges in the store (10AI findings 18, 20 and 21)', () => {
  const HOUR = 60 * 60 * 1000;
  const storeOptions = () => ({
    now: () => 1_800_000_000_000,
    getEncryptionKey: () => KEY,
    newIngressId: () => 'whi_0123456789abcdef0123456789abcdef',
    newPublicId: () => 'opaquePublicId_0123456789abcdef',
    newCredentialSetRef: () => 'whc_0123456789abcdef0123456789abcdef',
  });
  const stripeStray = (store: ReturnType<typeof makeStore>['store'], ingress: { ingress_id: string; public_id: string }, id: string, connection = 'stripe-other') =>
    store.recordUnsettledCreate({
      ingress_id: ingress.ingress_id,
      connection_id: connection,
      endpoint_url: `https://hooks.example/v1/webhooks/${ingress.public_id}`,
      kind: 'stray',
      remote_endpoint_id: id,
    });

  it("a run of failures a server before 10AH ended, or began again after, counts from nothing (finding 18)", () => {
    const { store, db } = makeStore();
    const ingress = createManagedStripe(store);
    const url = `https://hooks.example/v1/webhooks/${ingress.public_id}`;
    const record = store.recordUnsettledCreate({ ingress_id: ingress.ingress_id, connection_id: 'stripe-test', endpoint_url: url });
    store.noteUnsettledCreateUnreached(record.create_id, 5_000, 0);
    store.noteUnsettledCreateUnreached(record.create_id, 5_000 + 166 * HOUR, 166 * HOUR);
    // That server's reached note clears `unreached_since` alone.
    db.prepare('UPDATE webhook_registration_unsettled_creates SET unreached_since = NULL WHERE create_id = ?')
      .run(record.create_id);
    expect(store.listUnsettledCreates()[0]).toMatchObject({
      unreached_since: null, unreached_ms: 0, unreached_last_at: null,
    });
    // Then its failed search notes when the next run began, and nothing else.
    const began = 5_000 + 170 * HOUR;
    db.prepare('UPDATE webhook_registration_unsettled_creates SET unreached_since = ? WHERE create_id = ?')
      .run(began, record.create_id);
    expect(store.listUnsettledCreates()[0]).toMatchObject({
      unreached_since: began, unreached_ms: 0, unreached_last_at: began,
    });
    // A run this server noted reads as it was.
    store.noteUnsettledCreateUnreached(record.create_id, began + HOUR, HOUR);
    expect(store.listUnsettledCreates()[0]).toMatchObject({
      unreached_since: began, unreached_ms: HOUR, unreached_last_at: began + HOUR,
    });
  });

  it('keeps one record per stray, taken up again when it is found again, and counts each once (finding 20)', () => {
    const { store } = makeStore();
    const ingress = createManagedStripe(store);
    const first = stripeStray(store, ingress, 'we_stray_one');
    store.noteUnsettledCreateUnreached(first.create_id, 5_000, 0);
    store.noteUnsettledCreateUnreached(first.create_id, 9_000, 4_000);
    store.giveUpStrayEndpoint(first.create_id, 9_000);
    // A rebind tried again finds it again, through another connection.
    const again = stripeStray(store, ingress, 'we_stray_one', 'stripe-third');
    expect(again).toMatchObject({
      create_id: first.create_id, connection_id: 'stripe-third', sent_at: first.sent_at,
      remote_endpoint_id: 'we_stray_one', unreached_ms: 0, unreached_last_at: null, unreached_since: null,
    });
    expect(store.listUnsettledCreates()).toEqual([again]);
    expect(store.countStrayEndpoints(ingress.ingress_id)).toBe(1);
    expect(store.countGivenUpStrayEndpoints(ingress.ingress_id)).toBe(0);
    // Another stray is another record.
    stripeStray(store, ingress, 'we_stray_two');
    expect(store.countStrayEndpoints(ingress.ingress_id)).toBe(2);
    // The sweep's note of one standing records it only when none is kept.
    const url = `https://hooks.example/v1/webhooks/${ingress.public_id}`;
    store.noteStrayEndpointStanding({
      ingress_id: ingress.ingress_id, connection_id: 'stripe-other', endpoint_url: url, remote_endpoint_id: 'we_stray_two',
    });
    store.noteStrayEndpointStanding({
      ingress_id: ingress.ingress_id, connection_id: 'stripe-other', endpoint_url: url, remote_endpoint_id: 'we_stray_three',
    });
    expect(store.listUnsettledCreates().map((record) => record.remote_endpoint_id))
      .toEqual(['we_stray_one', 'we_stray_two', 'we_stray_three']);
    // A read that finds one gone settles it.
    store.settleStrayEndpoint(ingress.ingress_id, 'we_stray_two');
    expect(store.countStrayEndpoints(ingress.ingress_id)).toBe(2);
    // Only a stray names its endpoint, and an id is short and plain.
    expect(() => store.recordUnsettledCreate({
      ingress_id: ingress.ingress_id, connection_id: 'stripe-test', endpoint_url: url, remote_endpoint_id: 'we_x',
    })).toThrow(expect.objectContaining({ code: 'invalid_state' }));
    expect(() => stripeStray(store, ingress, 'we stray/with spaces'))
      .toThrow(expect.objectContaining({ code: 'invalid_state' }));
  });

  it('keeps a stray given up, unswept, for the owner to be told, until they say it is gone or a read finds it gone (finding 21)', () => {
    const { store } = makeStore();
    const ingress = createManagedStripe(store);
    const url = `https://hooks.example/v1/webhooks/${ingress.public_id}`;
    const create = store.recordUnsettledCreate({ ingress_id: ingress.ingress_id, connection_id: 'stripe-test', endpoint_url: url });
    const one = stripeStray(store, ingress, 'we_stray_one');
    const two = stripeStray(store, ingress, 'we_stray_two');
    store.giveUpStrayEndpoint(one.create_id, 9_000);
    store.giveUpStrayEndpoint(two.create_id, 9_000);
    // A create is never kept as given up.
    store.giveUpStrayEndpoint(create.create_id, 9_000);
    expect(store.listUnsettledCreates()).toEqual([create]);
    expect(store.countStrayEndpoints(ingress.ingress_id)).toBe(0);
    expect(store.countGivenUpStrayEndpoints(ingress.ingress_id)).toBe(2);
    // A read that finds one gone settles it, given up as it is.
    store.settleStrayEndpoint(ingress.ingress_id, 'we_stray_one');
    expect(store.countGivenUpStrayEndpoints(ingress.ingress_id)).toBe(1);
    // The owner says the rest are gone: only those go.
    const standing = stripeStray(store, ingress, 'we_stray_three');
    expect(store.dismissGivenUpStrayEndpoints(ingress.ingress_id)).toBe(1);
    expect(store.countGivenUpStrayEndpoints(ingress.ingress_id)).toBe(0);
    expect(store.listUnsettledCreates()).toEqual([create, standing]);
    expect(store.dismissGivenUpStrayEndpoints(ingress.ingress_id)).toBe(0);
  });

  it('opens a table from 10AH in place, its strays counted once each', () => {
    const { store, db } = makeStore();
    const ingress = createManagedStripe(store);
    const url = `https://hooks.example/v1/webhooks/${ingress.public_id}`;
    // The table as 10AH left it: one stray recorded twice, as a rebind tried
    // again recorded it.
    db.exec(`
      DROP TABLE webhook_registration_unsettled_creates;
      CREATE TABLE webhook_registration_unsettled_creates (
        create_id TEXT PRIMARY KEY,
        ingress_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        endpoint_url TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        unreached_since INTEGER,
        kind TEXT NOT NULL DEFAULT 'create',
        unreached_ms INTEGER NOT NULL DEFAULT 0,
        unreached_last_at INTEGER,
        FOREIGN KEY (ingress_id) REFERENCES webhook_ingresses(ingress_id) ON DELETE CASCADE
      );
    `);
    for (const id of ['whu_0123456789abcdef0123456789abcdea', 'whu_0123456789abcdef0123456789abcdeb']) {
      db.prepare(`
        INSERT INTO webhook_registration_unsettled_creates (create_id, ingress_id, connection_id, endpoint_url, sent_at, kind)
        VALUES (?, ?, 'stripe-test', ?, 1000, 'stray')
      `).run(id, ingress.ingress_id, url);
    }
    const reopened = createWebhookIngressStore(db, storeOptions());
    expect(reopened.listUnsettledCreates()).toEqual([
      expect.objectContaining({ kind: 'stray', remote_endpoint_id: null }),
      expect.objectContaining({ kind: 'stray', remote_endpoint_id: null }),
    ]);
    // A record from before 10AL names no endpoint: each counts as itself.
    expect(reopened.countStrayEndpoints(ingress.ingress_id)).toBe(2);
    // Opened again: nothing changes.
    expect(createWebhookIngressStore(db, storeOptions()).listUnsettledCreates()).toEqual(reopened.listUnsettledCreates());
  });
});

// D-201 Slice 10AH (10AE finding 23) — its two checks after the decrypt, which
// no test pinned: the key, and whether it is still a retire to clean up.
describe('D-201 Slice 10AH — the retiring read checks what changed while it decrypted', () => {
  const retiringStripe = async (getEncryptionKey?: () => Uint8Array | null) => {
    const made = makeStore(getEncryptionKey === undefined ? {} : { getEncryptionKey });
    const ingress = createManagedStripe(made.store);
    await made.store.commitManagedRegistrationCreate({
      expected: made.store.prepareManagedRegistration(ingress.ingress_id).expected,
      remote_endpoint_id: 'we_1234567890abcdef',
      endpoint_url: `https://hooks.example/v1/webhooks/${ingress.public_id}`,
      credentials: { endpoint_secret: 'whsec_retiring-one' },
      requires_handshake: false,
    });
    made.store.retire(ingress.ingress_id);
    return { ...made, ingress };
  };

  it('refuses one the vault locked, or changed its key, during', async () => {
    let key: Uint8Array | null = KEY;
    const { store, ingress } = await retiringStripe(() => key);
    expect(await store.readRetiringCredentialVersions(ingress.ingress_id)).toHaveLength(1);
    const locked = store.readRetiringCredentialVersions(ingress.ingress_id);
    key = null;
    await expect(locked).rejects.toMatchObject({ code: 'locked' });
    key = KEY;
    const rekeyed = store.readRetiringCredentialVersions(ingress.ingress_id);
    key = new Uint8Array(32).fill(9);
    await expect(rekeyed).rejects.toMatchObject({ code: 'conflict' });
  });

  it('reads nothing once its cleanup completed during', async () => {
    const { store, ingress } = await retiringStripe();
    const pending = store.readRetiringCredentialVersions(ingress.ingress_id);
    store.completeManagedRegistrationCleanup({
      expected: store.prepareManagedRegistrationCleanup(ingress.ingress_id, 'retire').expected,
      intent: 'retire',
    });
    await expect(pending).resolves.toEqual([]);
  });
});

// D-201 Slice 10AR (10AM findings 10 and 28) — what the store keeps for the pass
// over webhooks whose messages are refused.
describe('D-201 Slice 10AR — the last verified message, and a set again that failed', () => {
  it('a last verified message more than a minute ahead gives way to the next; a nearer one stays', () => {
    const { store } = makeStore();
    const ingress = createStripe(store);
    const at = 1_900_000_000_000;
    const lastDelivery = () => store.get(ingress.ingress_id)!.last_delivery_at;
    store.recordAcceptedDelivery(ingress.ingress_id, at + 60 * 60 * 1000);
    store.recordAcceptedDelivery(ingress.ingress_id, at);
    expect(lastDelivery()).toBe(at);
    store.recordAcceptedDelivery(ingress.ingress_id, at + WEBHOOK_LAST_DELIVERY_AHEAD_TOLERANCE_MS);
    store.recordAcceptedDelivery(ingress.ingress_id, at + 1);
    expect(lastDelivery()).toBe(at + WEBHOOK_LAST_DELIVERY_AHEAD_TOLERANCE_MS);
  });

  it('keeps when a try to set it again last failed, as last written, beside the set again', () => {
    const { store } = makeStore();
    const ingress = createStripe(store);
    expect(store.secretSetAgainFailedAt(ingress.ingress_id)).toBeNull();
    store.noteSecretSetAgainFailed(ingress.ingress_id, 5_000);
    // As last written: one a clock that ran ahead wrote gives way.
    store.noteSecretSetAgainFailed(ingress.ingress_id, 4_000);
    expect(store.secretSetAgainFailedAt(ingress.ingress_id)).toBe(4_000);
    expect(store.secretSetAgainAt(ingress.ingress_id)).toBeNull();
    store.noteSecretSetAgain(ingress.ingress_id, 6_000);
    expect(store.secretSetAgainFailedAt(ingress.ingress_id)).toBe(4_000);
    expect(() => store.noteSecretSetAgainFailed(ingress.ingress_id, -1)).toThrow(WebhookIngressStoreError);
    expect(() => store.noteSecretSetAgainFailed('whi_ffffffffffffffffffffffffffffffff', 1)).toThrow();
  });
});

describe('D-201 Slice 10BA — a stray Recued cannot prove (10AY finding 4)', () => {
  const stripeStray = (
    store: ReturnType<typeof makeStore>['store'],
    ingress: { ingress_id: string; public_id: string },
    id: string,
    connection = 'stripe-other',
  ) => store.recordUnsettledCreate({
    ingress_id: ingress.ingress_id,
    connection_id: connection,
    endpoint_url: `https://hooks.example/v1/webhooks/${ingress.public_id}`,
    kind: 'stray',
    remote_endpoint_id: id,
  });
  it('notes one unproven and clears it, lists it so, and a rebind that finds it again takes it up proven', () => {
    const { store } = makeStore();
    const ingress = createManagedStripe(store);
    const stray = stripeStray(store, ingress, 'we_stray_one');
    const other = stripeStray(store, ingress, 'we_stray_two');
    expect(store.listStrayEndpoints(ingress.ingress_id).map((entry) => entry.unproven)).toEqual([false, false]);
    store.noteStrayUnproven(stray.create_id, 5_000);
    expect(store.listStrayEndpoints(ingress.ingress_id).map((entry) => [entry.remote_endpoint_id, entry.unproven]))
      .toEqual([['we_stray_one', true], ['we_stray_two', false]]);
    // Given up, it stays unproven: the card says Recued never tried.
    store.giveUpStrayEndpoint(stray.create_id, 9_000);
    expect(store.listStrayEndpoints(ingress.ingress_id)[0]).toMatchObject({ given_up: true, unproven: true });
    // A rebind that finds it again takes it up as one to remove.
    stripeStray(store, ingress, 'we_stray_one', 'stripe-third');
    expect(store.listStrayEndpoints(ingress.ingress_id)[0]).toMatchObject({ given_up: false, unproven: false });
    // Cleared by a later search that proves it.
    store.noteStrayUnproven(other.create_id, 6_000);
    store.noteStrayUnproven(other.create_id, null);
    expect(store.listStrayEndpoints(ingress.ingress_id)[1]).toMatchObject({ unproven: false });
    // D-201 Slice 10BQ (10BM finding 13) — found at another address: said so,
    // and cleared with it.
    store.noteStrayUnproven(other.create_id, 6_500, true);
    expect(store.listStrayEndpoints(ingress.ingress_id)[1]).toMatchObject({ unproven: true, elsewhere: true });
    store.noteStrayUnproven(other.create_id, 6_600);
    expect(store.listStrayEndpoints(ingress.ingress_id)[1]).toMatchObject({ unproven: true, elsewhere: false });
    store.noteStrayUnproven(other.create_id, 6_700, true);
    store.noteStrayUnproven(other.create_id, null, true);
    expect(store.listStrayEndpoints(ingress.ingress_id)[1]).toMatchObject({ unproven: false, elsewhere: false });
    // A create is never a stray.
    const url = `https://hooks.example/v1/webhooks/${ingress.public_id}`;
    const create = store.recordUnsettledCreate({ ingress_id: ingress.ingress_id, connection_id: 'stripe-test', endpoint_url: url });
    store.noteStrayUnproven(create.create_id, 7_000);
    expect(store.listStrayEndpoints(ingress.ingress_id)).toHaveLength(2);
  });
});
