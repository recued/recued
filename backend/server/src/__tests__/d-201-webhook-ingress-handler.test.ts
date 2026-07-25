import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleWebhookCredentialRetire,
  handleWebhookCredentialWrite,
  handleWebhookIngressCreate,
  handleWebhookIngressDisable,
  handleWebhookIngressEnable,
  handleWebhookIngressGet,
  handleWebhookIngressList,
  handleWebhookIngressTestDelivery,
  handleWebhookManualRegistrationConfirm,
  handleWebhookManagedRegistrationReconcile,
  handleWebhookIngressRetire,
  handleWebhookIngressUpdate,
  makeWebhookIngressHandlers,
  projectWebhookIngress,
  type WebhookIngressRpcDeps,
} from '../webhook-ingress-handler.js';
import { createWebhookIngressStore } from '../storage/webhook-ingress-store.js';
import { WebhookTestDeliveryError } from '../webhook-test-delivery.js';
import { startServer } from '../server.js';
import {
  WEBHOOK_PROFILE_IDS,
  WEBHOOK_PROFILE_REGISTRY,
} from '@recued/contracts';

const profileCapability = (
  profileId: keyof typeof WEBHOOK_PROFILE_REGISTRY,
  registrationModes = WEBHOOK_PROFILE_REGISTRY[profileId].registration_modes,
) => ({
  profile_id: profileId,
  registration_modes: [...registrationModes],
  deduplication: WEBHOOK_PROFILE_REGISTRY[profileId].deduplication,
});

const databases: Database.Database[] = [];
afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

const makeDeps = (): WebhookIngressRpcDeps => {
  const db = new Database(':memory:');
  databases.push(db);
  let stamp = 1_900_000_000_000;
  return {
    store: createWebhookIngressStore(db, {
      now: () => ++stamp,
      getEncryptionKey: () => new Uint8Array(32).fill(7),
      newIngressId: () => 'whi_0123456789abcdef0123456789abcdef',
      newPublicId: () => 'opaquePublicId_0123456789abcdef',
      newCredentialSetRef: () => 'whc_0123456789abcdef0123456789abcdef',
    }),
    profileCapabilities: WEBHOOK_PROFILE_IDS.map((profileId) =>
      profileCapability(profileId)),
    generateSecret: () => 'recued-generated-secret-once',
    countConsumerBindings: () => 0,
    pairedConnectionAvailable: () => true,
    runtimeReadiness: (ingress) => ({
      endpoint_url: `https://hooks.example/v1/webhooks/${ingress.public_id}`,
      profile_runtime_available: true,
      paired_connection_available: true,
      listener_available: true,
      public_reachability_enabled: true,
      tls_ready: true,
      clock_ready: true,
      test_delivery_supported: false,
      vault_unlocked: true,
      server_unpaused: true,
    }),
  };
};

const owner = { instance_id: 'owner-webclient' };
const credentialSet = (
  credentials: Record<string, string>,
): Record<string, string> => credentials;

const createStripe = (deps: WebhookIngressRpcDeps) => handleWebhookIngressCreate(
  deps,
  {
    display_name: 'Stripe billing',
    profile_id: 'stripe.event.v1',
    environment: 'live',
    paired_connection_id: 'stripe-live',
    registration_mode: 'manual',
    selected_event_types: ['checkout.session.completed'],
  },
  owner,
);

describe('D-201 Slices 1 / 5A / 5B2B / 7D / 7E / 8A / 8G webhook control-plane RPCs', () => {
  it('admits creation only through the server-projected profile and mode surface', async () => {
    const deps = makeDeps();
    deps.profileCapabilities = [profileCapability(
      'generic.static-header-token.v1',
      ['manual'],
    )];
    await expect(createStripe(deps)).rejects.toMatchObject({
      code: 'webhook_profile_unavailable',
    });
    await expect(handleWebhookIngressCreate(deps, {
      display_name: 'Uncomposed operation binding',
      profile_id: 'generic.static-header-token.v1',
      environment: 'test',
      paired_connection_id: 'fixture-provider',
      registration_mode: 'operation_bound',
      selected_event_types: ['delivery'],
    }, owner)).rejects.toMatchObject({
      code: 'webhook_profile_unavailable',
    });
    expect(deps.store.list()).toEqual([]);
    await expect(handleWebhookIngressList(deps, undefined, owner)).resolves.toMatchObject({
      ingresses: [],
      profiles: [{
        profile_id: 'generic.static-header-token.v1',
        registration_modes: ['manual'],
        deduplication: WEBHOOK_PROFILE_REGISTRY['generic.static-header-token.v1']
          .deduplication,
      }],
    });
  });

  it('revokes configuration lifecycle authority without blocking local retirement', async () => {
    const deps = makeDeps();
    const created = await createStripe(deps);
    await handleWebhookCredentialWrite(deps, {
      ingress_id: created.ingress.ingress_id,
      credentials: { endpoint_secret: 'whsec_before-capability-revocation' },
    }, owner);
    deps.profileCapabilities = [profileCapability(
      'generic.static-header-token.v1',
      ['manual'],
    )];

    await expect(handleWebhookIngressUpdate(deps, {
      ingress_id: created.ingress.ingress_id,
      patch: { selected_event_types: ['invoice.paid'] },
    }, owner)).rejects.toMatchObject({ code: 'webhook_profile_unavailable' });
    await expect(handleWebhookCredentialWrite(deps, {
      ingress_id: created.ingress.ingress_id,
      credentials: { endpoint_secret: 'whsec_after-capability-revocation' },
    }, owner)).rejects.toMatchObject({ code: 'webhook_profile_unavailable' });
    await expect(handleWebhookManualRegistrationConfirm(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).rejects.toMatchObject({ code: 'webhook_profile_unavailable' });
    await expect(handleWebhookIngressEnable(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).rejects.toMatchObject({ code: 'webhook_profile_unavailable' });
    expect(deps.store.listCredentialVersions(created.ingress.ingress_id)).toHaveLength(1);
    expect(deps.store.get(created.ingress.ingress_id)?.selected_event_types)
      .toEqual(['checkout.session.completed']);

    await expect(handleWebhookIngressUpdate(deps, {
      ingress_id: created.ingress.ingress_id,
      patch: { display_name: 'Renamed while runtime is unavailable' },
    }, owner)).resolves.toMatchObject({
      ingress: { display_name: 'Renamed while runtime is unavailable' },
    });
    await expect(handleWebhookIngressRetire(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).resolves.toMatchObject({
      ingress: {
        intake_state: 'retired',
        registration_state: 'retired',
      },
    });
  });

  it('requires a registered paired owner even for topology reads', async () => {
    const deps = makeDeps();
    await expect(handleWebhookIngressList(deps, undefined, undefined)).rejects.toMatchObject({
      code: 'permission_denied',
    });
    await expect(handleWebhookIngressCreate(
      deps,
      {
        display_name: 'Denied',
        profile_id: 'stripe.event.v1',
        environment: 'live',
        registration_mode: 'manual',
        selected_event_types: ['invoice.paid'],
      },
      { instance_id: null },
    )).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('projects readiness/health without the credential-set ref or values', async () => {
    const deps = makeDeps();
    const created = await createStripe(deps);
    expect(created.ingress).toMatchObject({
      profile_id: 'stripe.event.v1',
      intake_state: 'draft',
      configured_fields: [],
      missing_required_fields: ['endpoint_secret'],
      readiness: {
        credentials_complete: false,
        registration_complete: false,
        local_configuration_complete: false,
      },
      health: { status: 'draft' },
    });
    expect('credential_set_ref' in created.ingress).toBe(false);

    const secret = 'whsec_owner-supplied-never-echoed';
    const written = await handleWebhookCredentialWrite(deps, {
      ingress_id: created.ingress.ingress_id,
      credentials: { endpoint_secret: secret },
    }, owner);
    expect(JSON.stringify(written)).not.toContain(secret);
    expect(written).not.toHaveProperty('one_time_generated_credentials');
    expect(written.ingress).toMatchObject({
      intake_state: 'verification_pending',
      configured_fields: ['endpoint_secret'],
      missing_required_fields: [],
      readiness: {
        credentials_complete: true,
        registration_complete: false,
        local_configuration_complete: false,
      },
      health: { status: 'pending' },
    });

    const got = await handleWebhookIngressGet(
      deps,
      { ingress_id: created.ingress.ingress_id },
      owner,
    );
    const listed = await handleWebhookIngressList(deps, undefined, owner);
    expect(JSON.stringify({ got, listed })).not.toContain(secret);
    expect('credential_set_ref' in got.ingress!).toBe(false);
  });

  it('rejects a noncanonical Stripe endpoint secret before encrypted storage', async () => {
    const deps = makeDeps();
    const created = await createStripe(deps);
    await expect(handleWebhookCredentialWrite(deps, {
      ingress_id: created.ingress.ingress_id,
      credentials: { endpoint_secret: 'not-a-stripe-endpoint-secret' },
    }, owner)).rejects.toMatchObject({ code: 'bad_request' });
    expect(deps.store.listCredentialVersions(created.ingress.ingress_id)).toEqual([]);
  });

  it('requires exact connection pairing and readies operation-bound intake after credentials', async () => {
    const deps = makeDeps();
    const request = {
      display_name: 'Per-resource callbacks',
      profile_id: 'generic.static-header-token.v1' as const,
      environment: 'test' as const,
      registration_mode: 'operation_bound' as const,
      selected_event_types: ['delivery'],
    };

    await expect(handleWebhookIngressCreate(deps, request, owner)).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('paired_connection_id is required'),
    });
    await expect(handleWebhookIngressCreate(deps, {
      ...request,
      profile_id: 'generic.http-basic.v1',
      paired_connection_id: 'fixture-provider-test',
    }, owner)).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining("registration_mode 'operation_bound' is not supported"),
    });

    const created = await handleWebhookIngressCreate(deps, {
      ...request,
      paired_connection_id: 'fixture-provider-test',
    }, owner);
    expect(created.ingress).toMatchObject({
      paired_connection_id: 'fixture-provider-test',
      registration_mode: 'operation_bound',
      registration_state: 'not_applicable',
      intake_state: 'draft',
      readiness: {
        credentials_complete: false,
        registration_complete: true,
        can_enable: false,
      },
    });

    const written = await handleWebhookCredentialWrite(deps, {
      ingress_id: created.ingress.ingress_id,
      credentials: {
        header_name: 'X-Webhook-Token',
        header_token: 'write-only-operation-bound-token',
      },
    }, owner);
    expect(JSON.stringify(written)).not.toContain('write-only-operation-bound-token');
    expect(written.ingress).toMatchObject({
      registration_state: 'not_applicable',
      intake_state: 'ready',
      readiness: {
        credentials_complete: true,
        registration_complete: true,
        local_configuration_complete: true,
        can_enable: true,
        blockers: [],
      },
    });
    expect(() => deps.store.disable(created.ingress.ingress_id))
      .toThrow(/must be retired instead of disabled/);

    await expect(handleWebhookIngressEnable(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).resolves.toMatchObject({
      ingress: { intake_state: 'enabled' },
    });
  });

  it('re-resolves paired authority and requires an explicit operation-bound rebind after deletion', async () => {
    const deps = makeDeps();
    const created = await handleWebhookIngressCreate(deps, {
      display_name: 'Connection deletion recovery',
      profile_id: 'generic.static-header-token.v1',
      environment: 'test',
      paired_connection_id: 'fixture-provider-test',
      registration_mode: 'operation_bound',
      selected_event_types: ['delivery'],
    }, owner);
    await handleWebhookCredentialWrite(deps, {
      ingress_id: created.ingress.ingress_id,
      credentials: {
        header_name: 'X-Webhook-Token',
        header_token: 'write-only-operation-bound-token',
      },
    }, owner);

    const ready = deps.runtimeReadiness!;
    deps.runtimeReadiness = async (ingress, profile) => ({
      ...await ready(ingress, profile),
      paired_connection_available: false,
    });
    await expect(handleWebhookIngressEnable(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).rejects.toMatchObject({
      code: 'webhook_not_ready',
      details: { blockers: ['paired_connection_unavailable'] },
    });

    deps.runtimeReadiness = ready;
    await handleWebhookIngressEnable(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner);
    deps.store.failCloseForDeletedPairedConnection('fixture-provider-test');
    await expect(handleWebhookIngressGet(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).resolves.toMatchObject({
      ingress: {
        intake_state: 'disabled',
        readiness: {
          paired_connection_available: true,
          can_enable: false,
          blockers: expect.arrayContaining(['paired_connection_rebind_required']),
        },
        health: { last_error_code: 'paired_connection_deleted' },
      },
    });
    await expect(handleWebhookIngressEnable(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).rejects.toMatchObject({
      code: 'webhook_not_ready',
      details: { blockers: ['paired_connection_rebind_required'] },
    });

    deps.pairedConnectionAvailable = () => false;
    await expect(handleWebhookIngressUpdate(deps, {
      ingress_id: created.ingress.ingress_id,
      patch: { paired_connection_id: 'fixture-provider-test' },
    }, owner)).rejects.toMatchObject({ code: 'webhook_connection_unavailable' });
    expect(deps.store.get(created.ingress.ingress_id)?.last_error_code)
      .toBe('paired_connection_deleted');

    deps.pairedConnectionAvailable = () => true;
    await expect(handleWebhookIngressUpdate(deps, {
      ingress_id: created.ingress.ingress_id,
      patch: {
        paired_connection_id: 'fixture-provider-test',
        display_name: 'must remain atomic',
      },
    }, owner)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(handleWebhookIngressUpdate(deps, {
      ingress_id: created.ingress.ingress_id,
      patch: { paired_connection_id: 'fixture-provider-test' },
    }, owner)).rejects.toMatchObject({ code: 'webhook_connection_rebind_unavailable' });
    deps.proveOperationBoundConnectionRebind = async () => false;
    await expect(handleWebhookIngressUpdate(deps, {
      ingress_id: created.ingress.ingress_id,
      patch: { paired_connection_id: 'fixture-provider-test' },
    }, owner)).rejects.toMatchObject({ code: 'webhook_connection_rebind_unconfirmed' });
    const proveRebind = vi.fn(async () => true);
    deps.proveOperationBoundConnectionRebind = proveRebind;
    await expect(handleWebhookIngressUpdate(deps, {
      ingress_id: created.ingress.ingress_id,
      patch: { paired_connection_id: 'fixture-provider-test' },
    }, owner)).resolves.toMatchObject({
      ingress: {
        paired_connection_id: 'fixture-provider-test',
        intake_state: 'disabled',
        readiness: { can_enable: true, blockers: [] },
        health: { last_error_code: null },
      },
    });
    expect(proveRebind).toHaveBeenCalledWith({
      ingress: expect.objectContaining({
        ingress_id: created.ingress.ingress_id,
        last_error_code: 'paired_connection_deleted',
      }),
      paired_connection_id: 'fixture-provider-test',
    });
  });

  it('keeps a deletion-latched never-enabled operation-bound ingress retirable', async () => {
    const deps = makeDeps();
    const created = await handleWebhookIngressCreate(deps, {
      display_name: 'Unused per-resource callbacks',
      profile_id: 'generic.static-header-token.v1',
      environment: 'test',
      paired_connection_id: 'unused-fixture-provider',
      registration_mode: 'operation_bound',
      selected_event_types: ['delivery'],
    }, owner);
    expect(created.ingress.intake_state).toBe('draft');
    deps.store.failCloseForDeletedPairedConnection('unused-fixture-provider');
    expect(deps.store.get(created.ingress.ingress_id)).toMatchObject({
      intake_state: 'draft',
      last_error_code: 'paired_connection_deleted',
    });
    await handleWebhookCredentialWrite(deps, {
      ingress_id: created.ingress.ingress_id,
      credentials: {
        header_name: 'X-Webhook-Token',
        header_token: 'never-exposed-operation-token',
      },
    }, owner);
    expect(deps.store.get(created.ingress.ingress_id)).toMatchObject({
      intake_state: 'ready',
      last_error_code: 'paired_connection_deleted',
    });

    await expect(handleWebhookIngressRetire(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).resolves.toMatchObject({
      ingress: {
        intake_state: 'retired',
        registration_state: 'retired',
        active_credential_versions: [],
      },
    });
  });

  it('projects a failed live-readiness dependency as unavailable instead of throwing', async () => {
    const deps = makeDeps();
    const created = await createStripe(deps);
    deps.runtimeReadiness = async () => {
      throw new Error('exposure authority unavailable');
    };

    await expect(handleWebhookIngressGet(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).resolves.toMatchObject({
      ingress: {
        endpoint_url: null,
        readiness: {
          can_enable: false,
          profile_runtime_available: false,
          paired_connection_available: false,
          listener_available: false,
          public_url_available: false,
          public_reachability_enabled: false,
          tls_ready: false,
          clock_ready: false,
          vault_unlocked: false,
          blockers: expect.arrayContaining([
            'profile_runtime_unavailable',
            'listener_unavailable',
            'public_url_unavailable',
            'public_reachability_disabled',
            'tls_unavailable',
            'clock_unverified',
            'vault_locked',
          ]),
        },
      },
    });
  });

  it('never labels an enabled but drifted/erroring ingress healthy', () => {
    const deps = makeDeps();
    const row = deps.store.create({
      display_name: 'Drifted Stripe',
      profile_id: 'stripe.event.v1',
      environment: 'live',
      paired_connection_id: 'stripe-live',
      registration_mode: 'manual',
      selected_event_types: ['invoice.paid'],
    });
    expect(projectWebhookIngress(deps.store, {
      ...row,
      intake_state: 'enabled',
      registration_state: 'drifted',
      last_error_code: 'remote_endpoint_drift',
    }).health.status).toBe('degraded');
  });

  it('returns Recued-generated credentials once, then keeps reads secret-free', async () => {
    const deps = makeDeps();
    const created = await handleWebhookIngressCreate(deps, {
      display_name: 'Telegram callbacks',
      profile_id: 'telegram.bot-webhook.v1',
      environment: 'live',
      registration_mode: 'manual',
      selected_event_types: ['message'],
    }, owner);
    const written = await handleWebhookCredentialWrite(deps, {
      ingress_id: created.ingress.ingress_id,
      credentials: {},
    }, owner);
    expect(written.one_time_generated_credentials).toEqual({
      secret_token: 'recued-generated-secret-once',
    });
    expect(await deps.store.readActiveCredentialVersions(created.ingress.ingress_id))
      .toEqual([
        expect.objectContaining({
          credentials: { secret_token: 'recued-generated-secret-once' },
        }),
      ]);
    const got = await handleWebhookIngressGet(
      deps,
      { ingress_id: created.ingress.ingress_id },
      owner,
    );
    expect(JSON.stringify(got)).not.toContain('recued-generated-secret-once');
    expect(got.ingress).not.toHaveProperty('one_time_generated_credentials');
  });

  it('generates GitHub webhook authority instead of accepting an owner-selected secret', async () => {
    const deps = makeDeps();
    const generatedSecret = 'G'.repeat(43);
    deps.generateSecret = () => generatedSecret;
    const created = await handleWebhookIngressCreate(deps, {
      display_name: 'GitHub repository events',
      profile_id: 'github.webhook.v1',
      environment: 'live',
      registration_mode: 'manual',
      selected_event_types: ['issues'],
    }, owner);
    await expect(handleWebhookCredentialWrite(deps, {
      ingress_id: created.ingress.ingress_id,
      credentials: { webhook_secret: 'owner-must-not-select-authority' },
    }, owner)).rejects.toMatchObject({ code: 'bad_request' });
    expect(deps.store.listCredentialVersions(created.ingress.ingress_id)).toEqual([]);

    const written = await handleWebhookCredentialWrite(deps, {
      ingress_id: created.ingress.ingress_id,
      credentials: {},
    }, owner);
    expect(written.one_time_generated_credentials).toEqual({
      webhook_secret: generatedSecret,
    });
    expect(await deps.store.readActiveCredentialVersions(created.ingress.ingress_id))
      .toEqual([
        expect.objectContaining({ credentials: { webhook_secret: generatedSecret } }),
      ]);
    expect(JSON.stringify(await handleWebhookIngressGet(
      deps,
      { ingress_id: created.ingress.ingress_id },
      owner,
    ))).not.toContain(generatedSecret);
  });

  it('accepts only Paddle provider-shaped endpoint secret keys', async () => {
    const deps = makeDeps();
    const created = await handleWebhookIngressCreate(deps, {
      display_name: 'Paddle subscription events',
      profile_id: 'paddle.notification.v1',
      environment: 'live',
      registration_mode: 'manual',
      selected_event_types: ['subscription.updated'],
    }, owner);
    await expect(handleWebhookCredentialWrite(deps, {
      ingress_id: created.ingress.ingress_id,
      credentials: { endpoint_secret_key: 'not-a-paddle-secret' },
    }, owner)).rejects.toMatchObject({ code: 'bad_request' });
    expect(deps.store.listCredentialVersions(created.ingress.ingress_id)).toEqual([]);

    const endpointSecretKey =
      'pdl_ntfset_01gkpjp8bkm3tm53kdgkx6sms7_6h3qd3uFSi9YCD3OLYAShQI90XTI5vEI';
    const written = await handleWebhookCredentialWrite(deps, {
      ingress_id: created.ingress.ingress_id,
      credentials: { endpoint_secret_key: endpointSecretKey },
    }, owner);
    expect(written.one_time_generated_credentials).toBeUndefined();
    expect(await deps.store.readActiveCredentialVersions(created.ingress.ingress_id))
      .toEqual([
        expect.objectContaining({
          credentials: { endpoint_secret_key: endpointSecretKey },
        }),
      ]);
    expect(JSON.stringify(await handleWebhookIngressGet(
      deps,
      { ingress_id: created.ingress.ingress_id },
      owner,
    ))).not.toContain(endpointSecretKey);
  });

  it('canonicalizes a closed GitHub managed target and freezes it once registration starts', async () => {
    const deps = makeDeps();
    const base = {
      display_name: 'Managed GitHub events',
      profile_id: 'github.webhook.v1' as const,
      environment: 'live' as const,
      paired_connection_id: 'github-api',
      registration_mode: 'managed_endpoint' as const,
      selected_event_types: ['issues'],
    };

    await expect(handleWebhookIngressCreate(deps, base, owner)).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('requires registration_target'),
    });
    await expect(handleWebhookIngressCreate(deps, {
      ...base,
      registration_target: {
        kind: 'repository',
        key: 'https://github.com/openai/example',
      },
    }, owner)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(handleWebhookIngressCreate(deps, {
      ...base,
      profile_id: 'stripe.event.v1',
      environment: 'test',
      registration_target: { kind: 'repository', key: 'openai/example' },
      selected_event_types: ['invoice.paid'],
    }, owner)).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('registration_target is not supported'),
    });
    await expect(handleWebhookIngressCreate(deps, {
      ...base,
      registration_mode: 'manual',
      registration_target: { kind: 'repository', key: 'openai/example' },
    }, owner)).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('registration_target is not supported'),
    });

    const created = await handleWebhookIngressCreate(deps, {
      ...base,
      registration_target: { kind: 'repository', key: 'OpenAI/.GitHub' },
    }, owner);
    expect(created.ingress).toMatchObject({
      registration_mode: 'managed_endpoint',
      registration_target: { kind: 'repository', key: 'openai/.github' },
      registration_state: 'managed_pending',
    });
    expect(deps.store.get(created.ingress.ingress_id)?.registration_target).toEqual({
      kind: 'repository',
      key: 'openai/.github',
    });

    const retargeted = await handleWebhookIngressUpdate(deps, {
      ingress_id: created.ingress.ingress_id,
      patch: {
        registration_target: { kind: 'organization', key: 'OpenAI' },
      },
    }, owner);
    expect(retargeted.ingress.registration_target).toEqual({
      kind: 'organization',
      key: 'openai',
    });

    deps.store.prepareManagedRegistration(created.ingress.ingress_id);
    await expect(handleWebhookIngressUpdate(deps, {
      ingress_id: created.ingress.ingress_id,
      patch: {
        registration_target: { kind: 'repository', key: 'openai/example' },
      },
    }, owner)).rejects.toMatchObject({
      code: 'invalid_state',
      message: expect.stringContaining('registration target is immutable'),
    });
  });

  it('rejects an invalid generated Telegram secret before persistence', async () => {
    const deps = makeDeps();
    deps.generateSecret = () => 'invalid generated secret';
    const created = await handleWebhookIngressCreate(deps, {
      display_name: 'Telegram invalid secret fixture',
      profile_id: 'telegram.bot-webhook.v1',
      environment: 'live',
      registration_mode: 'manual',
      selected_event_types: ['message'],
    }, owner);
    await expect(handleWebhookCredentialWrite(deps, {
      ingress_id: created.ingress.ingress_id,
      credentials: {},
    }, owner)).rejects.toMatchObject({ code: 'bad_request' });
    expect(deps.store.listCredentialVersions(created.ingress.ingress_id)).toEqual([]);
  });

  it('keeps managed provider credentials out of owner writes and exposes only ingress-id reconciliation', async () => {
    const telegramDeps = makeDeps();
    const managedTelegram = await handleWebhookIngressCreate(telegramDeps, {
      display_name: 'Managed Telegram callbacks',
      profile_id: 'telegram.bot-webhook.v1',
      environment: 'live',
      paired_connection_id: 'telegram-bot',
      registration_mode: 'managed_endpoint',
      selected_event_types: ['message'],
    }, owner);
    await expect(handleWebhookCredentialWrite(telegramDeps, {
      ingress_id: managedTelegram.ingress.ingress_id,
      credentials: {},
    }, owner)).rejects.toMatchObject({ code: 'invalid_state' });
    expect(telegramDeps.store.listCredentialVersions(managedTelegram.ingress.ingress_id))
      .toEqual([]);

    const deps = makeDeps();
    const created = await handleWebhookIngressCreate(deps, {
      display_name: 'Managed Stripe callbacks',
      profile_id: 'stripe.event.v1',
      environment: 'test',
      paired_connection_id: 'stripe-test',
      registration_mode: 'managed_endpoint',
      selected_event_types: ['invoice.paid'],
    }, owner);
    await expect(handleWebhookCredentialWrite(deps, {
      ingress_id: created.ingress.ingress_id,
      credentials: { endpoint_secret: 'owner-must-not-inject' },
    }, owner)).rejects.toMatchObject({ code: 'invalid_state' });

    const reconcile = vi.fn(async (ingressId: string) => {
      const prepared = deps.store.prepareManagedRegistration(ingressId);
      return deps.store.commitManagedRegistrationCreate({
        expected: prepared.expected,
        remote_endpoint_id: 'we_1234567890abcdef',
        endpoint_url: created.ingress.endpoint_url!,
        credentials: { endpoint_secret: 'whsec_core-captured' },
        requires_handshake: false,
      });
    });
    deps.managedRegistration = {
      reconcile,
      cleanup: vi.fn(async (ingressId: string) => deps.store.get(ingressId)!),
      rebind: vi.fn(async (ingressId: string) => deps.store.get(ingressId)!),
    };

    await expect(handleWebhookManagedRegistrationReconcile(deps, {
      ingress_id: created.ingress.ingress_id,
    }, undefined)).rejects.toMatchObject({ code: 'permission_denied' });
    const result = await handleWebhookManagedRegistrationReconcile(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner);
    expect(reconcile).toHaveBeenCalledWith(created.ingress.ingress_id);
    expect(result.ingress).toMatchObject({
      registration_state: 'registered',
      remote_endpoint_id: 'we_1234567890abcdef',
      configured_fields: ['endpoint_secret'],
    });
    expect(JSON.stringify(result)).not.toContain('whsec_core-captured');

    deps.runtimeReadiness = () => ({
      endpoint_url: 'https://new-hooks.example/v1/webhooks/opaquePublicId_0123456789abcdef',
      profile_runtime_available: true,
      paired_connection_available: true,
      listener_available: true,
      public_reachability_enabled: true,
      tls_ready: true,
      clock_ready: true,
      test_delivery_supported: false,
      vault_unlocked: true,
      server_unpaused: true,
    });
    await expect(handleWebhookIngressGet(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).resolves.toMatchObject({
      ingress: {
        readiness: {
          registration_endpoint_matches: false,
          can_enable: false,
          blockers: expect.arrayContaining(['registration_endpoint_changed']),
        },
      },
    });
  });

  it('routes bounded paired-connection replacement through managed core', async () => {
    const deps = makeDeps();
    const created = await handleWebhookIngressCreate(deps, {
      display_name: 'Managed Stripe connection cutover',
      profile_id: 'stripe.event.v1',
      environment: 'test',
      paired_connection_id: 'stripe-test',
      registration_mode: 'managed_endpoint',
      selected_event_types: ['invoice.paid'],
    }, owner);
    const prepared = deps.store.prepareManagedRegistration(created.ingress.ingress_id);
    await deps.store.commitManagedRegistrationCreate({
      expected: prepared.expected,
      remote_endpoint_id: 'we_handlerrebind12345',
      endpoint_url: created.ingress.endpoint_url!,
      credentials: { endpoint_secret: 'whsec_handler-rebind' },
      requires_handshake: false,
    });
    const rebind = vi.fn(async (ingressId: string, pairedConnectionId: string) =>
      deps.store.commitManagedConnectionAliasRebind({
        expected: deps.store.snapshotManagedRegistration(ingressId).expected,
        paired_connection_id: pairedConnectionId,
      }));
    deps.managedRegistration = {
      reconcile: vi.fn(async (ingressId: string) => deps.store.get(ingressId)!),
      cleanup: vi.fn(async (ingressId: string) => deps.store.get(ingressId)!),
      rebind,
    };

    await expect(handleWebhookManagedRegistrationReconcile(deps, {
      ingress_id: created.ingress.ingress_id,
      paired_connection_id: 'stripe-test-rotated',
    }, owner)).resolves.toMatchObject({
      ingress: {
        paired_connection_id: 'stripe-test-rotated',
        pending_paired_connection_id: null,
        remote_endpoint_id: 'we_handlerrebind12345',
      },
    });
    expect(rebind).toHaveBeenLastCalledWith(
      created.ingress.ingress_id,
      'stripe-test-rotated',
    );

    await expect(handleWebhookIngressUpdate(deps, {
      ingress_id: created.ingress.ingress_id,
      patch: { paired_connection_id: 'stripe-test-third' },
    }, owner)).resolves.toMatchObject({
      ingress: { paired_connection_id: 'stripe-test-third' },
    });
    expect(rebind).toHaveBeenLastCalledWith(
      created.ingress.ingress_id,
      'stripe-test-third',
    );
    await expect(handleWebhookIngressUpdate(deps, {
      ingress_id: created.ingress.ingress_id,
      patch: {
        paired_connection_id: 'stripe-test-fourth',
        display_name: 'must not partially apply',
      },
    }, owner)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(handleWebhookManagedRegistrationReconcile(deps, {
      ingress_id: created.ingress.ingress_id,
      paired_connection_id: null,
    } as never, owner)).rejects.toMatchObject({ code: 'bad_request' });

    const pendingConnectionId = 'stripe-test-persisted-cutover';
    const pending = deps.store.prepareManagedConnectionRebind({
      expected: deps.store.snapshotManagedRegistration(created.ingress.ingress_id).expected,
      paired_connection_id: pendingConnectionId,
    });
    expect(pending).toMatchObject({
      cleanup_required: true,
      ingress: {
        registration_state: 'cleanup_pending',
        pending_paired_connection_id: pendingConnectionId,
      },
    });
    const retryPersistedCutover = vi.fn(async (ingressId: string) =>
      deps.store.get(ingressId)!);
    deps.managedRegistration.rebind = retryPersistedCutover;
    deps.profileCapabilities = [profileCapability(
      'generic.static-header-token.v1',
      ['manual'],
    )];
    await expect(handleWebhookManagedRegistrationReconcile(deps, {
      ingress_id: created.ingress.ingress_id,
      paired_connection_id: 'stripe-test-substituted-cutover',
    }, owner)).rejects.toMatchObject({ code: 'webhook_profile_unavailable' });
    expect(retryPersistedCutover).not.toHaveBeenCalled();
    await expect(handleWebhookManagedRegistrationReconcile(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).resolves.toMatchObject({
      ingress: { pending_paired_connection_id: pendingConnectionId },
    });
    expect(retryPersistedCutover).toHaveBeenCalledWith(
      created.ingress.ingress_id,
      pendingConnectionId,
    );
  });

  it('routes managed disable and retirement through provider cleanup while closing locally first', async () => {
    const deps = makeDeps();
    const created = await handleWebhookIngressCreate(deps, {
      display_name: 'Managed Stripe cleanup',
      profile_id: 'stripe.event.v1',
      environment: 'test',
      paired_connection_id: 'stripe-test',
      registration_mode: 'managed_endpoint',
      selected_event_types: ['invoice.paid'],
    }, owner);
    const prepared = deps.store.prepareManagedRegistration(created.ingress.ingress_id);
    await deps.store.commitManagedRegistrationCreate({
      expected: prepared.expected,
      remote_endpoint_id: 'we_cleanup123456789',
      endpoint_url: created.ingress.endpoint_url!,
      credentials: { endpoint_secret: 'whsec_cleanup-handler' },
      requires_handshake: false,
    });
    const cleanup = vi.fn(async (ingressId: string, intent: 'disable' | 'retire') => {
      const closed = intent === 'disable'
        ? deps.store.disable(ingressId)
        : deps.store.retire(ingressId);
      if (closed.registration_state !== 'cleanup_pending') return closed;
      const pending = deps.store.prepareManagedRegistrationCleanup(ingressId, intent);
      return deps.store.completeManagedRegistrationCleanup({
        expected: pending.expected,
        intent,
      });
    });
    deps.managedRegistration = {
      reconcile: vi.fn(async (ingressId: string) => deps.store.get(ingressId)!),
      cleanup,
      rebind: vi.fn(async (ingressId: string) => deps.store.get(ingressId)!),
    };

    await expect(handleWebhookIngressDisable(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).resolves.toMatchObject({
      ingress: {
        intake_state: 'disabled',
        registration_state: 'managed_pending',
        remote_endpoint_id: null,
        active_credential_versions: [],
      },
    });
    expect(cleanup).toHaveBeenLastCalledWith(created.ingress.ingress_id, 'disable');

    const reprepare = deps.store.prepareManagedRegistration(created.ingress.ingress_id);
    await deps.store.commitManagedRegistrationCreate({
      expected: reprepare.expected,
      remote_endpoint_id: 'we_cleanupagain1234',
      endpoint_url: created.ingress.endpoint_url!,
      credentials: { endpoint_secret: 'whsec_cleanup-handler-again' },
      requires_handshake: false,
    });
    await expect(handleWebhookIngressRetire(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).resolves.toMatchObject({
      ingress: {
        intake_state: 'retired',
        registration_state: 'retired',
        remote_endpoint_id: null,
      },
    });
    expect(cleanup).toHaveBeenLastCalledWith(created.ingress.ingress_id, 'retire');
  });

  it('keeps local intake closed when the managed cleanup runtime is unavailable', async () => {
    const deps = makeDeps();
    const created = await handleWebhookIngressCreate(deps, {
      display_name: 'Managed Stripe unavailable cleanup',
      profile_id: 'stripe.event.v1',
      environment: 'test',
      paired_connection_id: 'stripe-test',
      registration_mode: 'managed_endpoint',
      selected_event_types: ['invoice.paid'],
    }, owner);
    const prepared = deps.store.prepareManagedRegistration(created.ingress.ingress_id);
    await deps.store.commitManagedRegistrationCreate({
      expected: prepared.expected,
      remote_endpoint_id: 'we_unavailable123456',
      endpoint_url: created.ingress.endpoint_url!,
      credentials: { endpoint_secret: 'whsec_cleanup-unavailable' },
      requires_handshake: false,
    });

    await expect(handleWebhookIngressDisable(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).rejects.toMatchObject({ code: 'webhook_registration_unavailable' });
    expect(deps.store.get(created.ingress.ingress_id)).toMatchObject({
      intake_state: 'disabled',
      registration_state: 'cleanup_pending',
      remote_endpoint_id: 'we_unavailable123456',
    });
  });

  it('validates profile-owned fields and never lets the caller supply generated values', async () => {
    const deps = makeDeps();
    const created = await handleWebhookIngressCreate(deps, {
      display_name: 'Telegram callbacks',
      profile_id: 'telegram.bot-webhook.v1',
      environment: 'live',
      registration_mode: 'manual',
      selected_event_types: ['message'],
    }, owner);
    await expect(handleWebhookCredentialWrite(deps, {
      ingress_id: created.ingress.ingress_id,
      credentials: { secret_token: 'caller-chosen' },
    }, owner)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(handleWebhookCredentialWrite(deps, {
      ingress_id: created.ingress.ingress_id,
      credentials: { unexpected: 'value' },
    }, owner)).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('never accepts inherited RPC or credential fields', async () => {
    const deps = makeDeps();
    Object.defineProperty(Object.prototype, 'profile_id', {
      value: 'stripe.event.v1',
      configurable: true,
    });
    try {
      await expect(handleWebhookIngressCreate(deps, {
        display_name: 'Missing own profile',
        environment: 'live',
        registration_mode: 'manual',
        selected_event_types: ['invoice.paid'],
      } as never, owner)).rejects.toMatchObject({ code: 'bad_request' });
    } finally {
      delete (Object.prototype as Record<string, unknown>).profile_id;
    }

    const created = await createStripe(deps);
    Object.defineProperty(Object.prototype, 'endpoint_secret', {
      value: 'inherited-secret',
      configurable: true,
    });
    try {
      await expect(handleWebhookCredentialWrite(deps, {
        ingress_id: created.ingress.ingress_id,
        credentials: {},
      }, owner)).rejects.toMatchObject({ code: 'bad_request' });
    } finally {
      delete (Object.prototype as Record<string, unknown>).endpoint_secret;
    }
    expect(deps.store.listCredentialVersions(created.ingress.ingress_id)).toEqual([]);
  });

  it('allows draft identity correction but locks profile/environment/mode after credentials', async () => {
    const deps = makeDeps();
    const created = await createStripe(deps);
    const corrected = await handleWebhookIngressUpdate(deps, {
      ingress_id: created.ingress.ingress_id,
      patch: {
        environment: 'test',
        display_name: 'Stripe test billing',
      },
    }, owner);
    expect(corrected.ingress).toMatchObject({
      environment: 'test',
      display_name: 'Stripe test billing',
    });
    await handleWebhookCredentialWrite(deps, {
      ingress_id: created.ingress.ingress_id,
      credentials: { endpoint_secret: 'whsec_bound-to-test-environment' },
    }, owner);
    await expect(handleWebhookIngressUpdate(deps, {
      ingress_id: created.ingress.ingress_id,
      patch: { environment: 'live' },
    }, owner)).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(handleWebhookIngressUpdate(deps, {
      ingress_id: created.ingress.ingress_id,
      patch: { public_id: 'attacker-route' } as never,
    }, owner)).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rotates with overlap, retires versions explicitly, then retires ingress', async () => {
    const deps = makeDeps();
    const created = await createStripe(deps);
    const first = await handleWebhookCredentialWrite(deps, {
      ingress_id: created.ingress.ingress_id,
      credentials: { endpoint_secret: 'whsec_first-secret' },
    }, owner);
    const second = await handleWebhookCredentialWrite(deps, {
      ingress_id: created.ingress.ingress_id,
      credentials: { endpoint_secret: 'whsec_second-secret' },
    }, owner);
    expect(second.ingress.active_credential_versions.map((v) => v.version)).toEqual(['2', '1']);

    const retiredVersion = await handleWebhookCredentialRetire(deps, {
      ingress_id: created.ingress.ingress_id,
      credential_version: first.credential_version.version,
    }, owner);
    expect(retiredVersion.ingress.active_credential_versions.map((v) => v.version)).toEqual(['2']);

    const beforeBlockedRetirement = deps.store.get(created.ingress.ingress_id);
    deps.countConsumerBindings = undefined;
    await expect(handleWebhookIngressRetire(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).rejects.toMatchObject({ code: 'not_configured' });
    deps.countConsumerBindings = () => 2;
    await expect(handleWebhookIngressRetire(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).rejects.toMatchObject({
      code: 'webhook_in_use',
      details: { binding_count: 2 },
    });
    expect(deps.store.get(created.ingress.ingress_id)).toEqual(beforeBlockedRetirement);
    deps.countConsumerBindings = () => 0;

    const retired = await handleWebhookIngressRetire(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner);
    expect(retired.ingress).toMatchObject({
      intake_state: 'retired',
      active_credential_versions: [],
      readiness: { local_configuration_complete: false },
      health: { status: 'retired' },
    });
    expect((await handleWebhookIngressList(deps, undefined, owner)).ingresses).toEqual([]);
    expect((await handleWebhookIngressList(
      deps,
      { include_retired: true },
      owner,
    )).ingresses).toHaveLength(1);
    deps.countConsumerBindings = undefined;
    await expect(handleWebhookIngressRetire(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).resolves.toMatchObject({
      ingress: { intake_state: 'retired' },
    });
  });

  it('preserves credential-version shape and range errors before retirement', async () => {
    const deps = makeDeps();
    const created = await createStripe(deps);
    const toPrimitive = vi.fn(() => '1');
    const valueOf = vi.fn(() => 1);
    const toString = vi.fn(() => '1');
    const coercible = {
      [Symbol.toPrimitive]: toPrimitive,
      valueOf,
      toString,
    };
    for (const credentialVersion of [
      '',
      '0',
      '01',
      '+1',
      1,
      Symbol('1'),
      new String('1'),
      coercible,
    ]) {
      await expect(handleWebhookCredentialRetire(deps, {
        ingress_id: created.ingress.ingress_id,
        credential_version: credentialVersion as never,
      }, owner)).rejects.toMatchObject({
        code: 'bad_request',
        message: 'webhook.ingress.credentials.retire: credential_version has invalid shape',
      });
    }
    for (const credentialVersion of [
      String(Number.MAX_SAFE_INTEGER + 1),
      '1'.repeat(1_000),
    ]) {
      await expect(handleWebhookCredentialRetire(deps, {
        ingress_id: created.ingress.ingress_id,
        credential_version: credentialVersion,
      }, owner)).rejects.toMatchObject({
        code: 'bad_request',
        message: 'webhook.ingress.credentials.retire: credential_version is out of range',
      });
    }
    expect(toPrimitive).not.toHaveBeenCalled();
    expect(valueOf).not.toHaveBeenCalled();
    expect(toString).not.toHaveBeenCalled();
  });

  it('confirms manual registration, then enables, disables, and re-enables explicitly', async () => {
    const deps = makeDeps();
    const created = await handleWebhookIngressCreate(deps, {
      display_name: 'Generic signed delivery',
      profile_id: 'generic.raw-body-hmac-sha256.v1',
      environment: 'live',
      registration_mode: 'manual',
      selected_event_types: ['delivery'],
    }, owner);
    await expect(handleWebhookManualRegistrationConfirm(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).rejects.toMatchObject({
      code: 'webhook_not_ready',
      details: { blockers: ['credentials_incomplete'] },
    });
    await handleWebhookCredentialWrite(deps, {
      ingress_id: created.ingress.ingress_id,
      credentials: {
        signature_header: 'X-Webhook-Signature',
        signing_secret: 'owner-secret',
      },
    }, owner);
    const confirmed = await handleWebhookManualRegistrationConfirm(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner);
    expect(confirmed.ingress).toMatchObject({
      registration_state: 'registered',
      intake_state: 'ready',
      endpoint_url: 'https://hooks.example/v1/webhooks/opaquePublicId_0123456789abcdef',
      readiness: { can_enable: true, blockers: [] },
    });

    const enabled = await handleWebhookIngressEnable(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner);
    expect(enabled.ingress).toMatchObject({
      intake_state: 'enabled',
      health: { status: 'healthy' },
    });
    const disabled = await handleWebhookIngressDisable(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner);
    expect(disabled.ingress).toMatchObject({
      intake_state: 'disabled',
      enabled_at: null,
      health: { status: 'disabled' },
    });
    await expect(handleWebhookIngressEnable(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).resolves.toMatchObject({ ingress: { intake_state: 'enabled' } });

    deps.runtimeReadiness = (ingress) => ({
      endpoint_url: `https://new-hooks.example/v1/webhooks/${ingress.public_id}`,
      profile_runtime_available: true,
      paired_connection_available: true,
      listener_available: true,
      public_reachability_enabled: true,
      tls_ready: true,
      clock_ready: true,
      test_delivery_supported: false,
      vault_unlocked: true,
      server_unpaused: true,
    });
    const endpointDrifted = await handleWebhookIngressGet(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner);
    expect(endpointDrifted.ingress).toMatchObject({
      intake_state: 'enabled',
      readiness: {
        registration_complete: true,
        registration_endpoint_matches: false,
        can_enable: false,
        blockers: expect.arrayContaining(['registration_endpoint_changed']),
      },
      health: { status: 'degraded' },
    });
    await expect(handleWebhookIngressEnable(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).rejects.toMatchObject({
      code: 'webhook_not_ready',
      details: {
        blockers: expect.arrayContaining(['registration_endpoint_changed']),
      },
    });
    const reconfirmed = await handleWebhookManualRegistrationConfirm(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner);
    expect(reconfirmed.ingress).toMatchObject({
      endpoint_url: `https://new-hooks.example/v1/webhooks/${created.ingress.public_id}`,
      readiness: {
        registration_complete: true,
        registration_endpoint_matches: true,
        can_enable: true,
      },
      health: { status: 'healthy' },
    });
    expect(deps.store.get(created.ingress.ingress_id)?.confirmed_endpoint_url)
      .toBe(`https://new-hooks.example/v1/webhooks/${created.ingress.public_id}`);
  });

  it('sends an exact owner-only test through the injected profile service only for an enabled test ingress', async () => {
    const deps = makeDeps();
    deps.runtimeReadiness = (ingress) => ({
      endpoint_url: `https://hooks.example/v1/webhooks/${ingress.public_id}`,
      profile_runtime_available: true,
      paired_connection_available: true,
      listener_available: true,
      public_reachability_enabled: true,
      tls_ready: true,
      clock_ready: true,
      test_delivery_supported: ingress.environment === 'test',
      vault_unlocked: true,
      server_unpaused: true,
    });
    const created = await handleWebhookIngressCreate(deps, {
      display_name: 'Generic test delivery',
      profile_id: 'generic.static-header-token.v1',
      environment: 'test',
      registration_mode: 'manual',
      selected_event_types: ['delivery'],
    }, owner);
    await handleWebhookCredentialWrite(deps, {
      ingress_id: created.ingress.ingress_id,
      credentials: {
        header_name: 'x-test-token',
        header_token: 'write-only-test-token',
      },
    }, owner);
    await handleWebhookManualRegistrationConfirm(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner);
    await handleWebhookIngressEnable(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner);
    const observedAt = 2_000_000_000_123;
    const deliver = vi.fn(async ({ ingress }: {
      ingress: { ingress_id: string };
    }) => {
      deps.store.recordAcceptedDelivery(ingress.ingress_id, observedAt);
      return {
        delivery_id: 'whd_testdelivery0000000000000000000',
        observed_at: observedAt,
      };
    });
    deps.testDelivery = {
      supports: () => true,
      deliver,
    };

    await expect(handleWebhookIngressTestDelivery(deps, {
      ingress_id: created.ingress.ingress_id,
    }, undefined)).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(handleWebhookIngressTestDelivery(deps, {
      ingress_id: created.ingress.ingress_id,
      extra: true,
    } as never, owner)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(handleWebhookIngressTestDelivery(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).resolves.toMatchObject({
      delivery_id: 'whd_testdelivery0000000000000000000',
      observed_at: observedAt,
      ingress: {
        ingress_id: created.ingress.ingress_id,
        health: {
          test_observed_at: observedAt,
          last_delivery_at: observedAt,
        },
      },
    });
    expect(deliver).toHaveBeenCalledWith({
      ingress: expect.objectContaining({
        ingress_id: created.ingress.ingress_id,
        environment: 'test',
        intake_state: 'enabled',
      }),
      endpoint_url: `https://hooks.example/v1/webhooks/${created.ingress.public_id}`,
    });
    deliver.mockRejectedValueOnce(new WebhookTestDeliveryError(
      'accepted_response_unconfirmed',
      'delivery whd_testdelivery0000000000000000000 was durably accepted and may have dispatched; inspect it before retrying',
    ));
    await expect(handleWebhookIngressTestDelivery(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).rejects.toMatchObject({
      code: 'webhook_test_accepted_unconfirmed',
      status: 409,
      message: expect.stringContaining('may have dispatched'),
    });
    deliver.mockRejectedValueOnce(new WebhookTestDeliveryError(
      'request_failed',
      'the request may still arrive, so inspect before retrying',
    ));
    await expect(handleWebhookIngressTestDelivery(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).rejects.toMatchObject({
      code: 'webhook_test_unconfirmed',
      status: 409,
      message: expect.stringContaining('inspect before retrying'),
    });

    await handleWebhookIngressDisable(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner);
    await expect(handleWebhookIngressTestDelivery(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).rejects.toMatchObject({ code: 'invalid_state' });
    expect(deliver).toHaveBeenCalledTimes(3);
  });

  it.each([
    {
      profile_id: 'generic.static-header-token.v1' as const,
      credentials: credentialSet({
        header_name: 'Content-Type',
        header_token: 'owner-token',
      }),
    },
    {
      profile_id: 'generic.http-basic.v1' as const,
      credentials: credentialSet({
        username: 'owner:name',
        password: 'owner-password',
      }),
    },
    {
      profile_id: 'generic.raw-body-hmac-sha256.v1' as const,
      credentials: credentialSet({
        signature_header: 'X-Forwarded-For',
        signing_secret: 'owner-secret',
      }),
    },
  ])('rejects malformed $profile_id credentials before persistence', async ({
    profile_id,
    credentials,
  }) => {
    const deps = makeDeps();
    const created = await handleWebhookIngressCreate(deps, {
      display_name: 'Malformed primitive credentials',
      profile_id,
      environment: 'live',
      registration_mode: 'manual',
      selected_event_types: ['delivery'],
    }, owner);

    await expect(handleWebhookCredentialWrite(deps, {
      ingress_id: created.ingress.ingress_id,
      credentials,
    }, owner)).rejects.toMatchObject({ code: 'bad_request' });
    expect(deps.store.listCredentialVersions(created.ingress.ingress_id)).toEqual([]);
  });

  it('revalidates legacy credential ciphertext before confirmation and enablement', async () => {
    const deps = makeDeps();
    const created = await handleWebhookIngressCreate(deps, {
      display_name: 'Legacy malformed credentials',
      profile_id: 'generic.static-header-token.v1',
      environment: 'live',
      registration_mode: 'manual',
      selected_event_types: ['delivery'],
    }, owner);
    // Models a Slice-1 row written before primitive control-plane validation.
    await deps.store.writeCredentialVersion(created.ingress.ingress_id, {
      header_name: 'Content-Type',
      header_token: 'legacy-token',
    });

    await expect(handleWebhookManualRegistrationConfirm(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).rejects.toMatchObject({
      code: 'webhook_not_ready',
      details: { blockers: ['credential_shape_invalid'] },
    });
    expect(deps.store.get(created.ingress.ingress_id)?.registration_state)
      .toBe('manual_pending');

    // Even a legacy/bypassed registration transition cannot skip the same
    // validation at the final enable boundary.
    deps.store.confirmManualRegistration(created.ingress.ingress_id, {
      requires_handshake: false,
      endpoint_url: created.ingress.endpoint_url!,
    });
    await expect(handleWebhookIngressEnable(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).rejects.toMatchObject({
      code: 'webhook_not_ready',
      details: { blockers: ['credential_shape_invalid'] },
    });
    expect(deps.store.get(created.ingress.ingress_id)?.intake_state).toBe('ready');
  });

  it('revalidates legacy Slack credential shape before entering handshake state', async () => {
    const deps = makeDeps();
    const created = await handleWebhookIngressCreate(deps, {
      display_name: 'Legacy malformed Slack credentials',
      profile_id: 'slack.request.v0',
      environment: 'live',
      registration_mode: 'manual',
      selected_event_types: ['event_callback'],
    }, owner);
    await deps.store.writeCredentialVersion(created.ingress.ingress_id, {
      signing_secret: 'slack-signing-secret',
      ignored_secret: 'must-not-carry-authority',
    });

    await expect(handleWebhookManualRegistrationConfirm(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).rejects.toMatchObject({
      code: 'webhook_not_ready',
      details: { blockers: ['credential_shape_invalid'] },
    });
    expect(deps.store.get(created.ingress.ingress_id)).toMatchObject({
      registration_state: 'manual_pending',
      intake_state: 'verification_pending',
    });
  });

  it('revalidates legacy Telegram credential shape before registration', async () => {
    const deps = makeDeps();
    const created = await handleWebhookIngressCreate(deps, {
      display_name: 'Legacy malformed Telegram credentials',
      profile_id: 'telegram.bot-webhook.v1',
      environment: 'live',
      registration_mode: 'manual',
      selected_event_types: ['message'],
    }, owner);
    await deps.store.writeCredentialVersion(created.ingress.ingress_id, {
      secret_token: 'telegram-secret-token',
      ignored_secret: 'must-not-carry-authority',
    });

    await expect(handleWebhookManualRegistrationConfirm(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).rejects.toMatchObject({
      code: 'webhook_not_ready',
      details: { blockers: ['credential_shape_invalid'] },
    });
    expect(deps.store.get(created.ingress.ingress_id)).toMatchObject({
      registration_state: 'manual_pending',
      intake_state: 'verification_pending',
    });
  });

  it('revalidates legacy GitHub credential shape before registration', async () => {
    const deps = makeDeps();
    const created = await handleWebhookIngressCreate(deps, {
      display_name: 'Legacy malformed GitHub credentials',
      profile_id: 'github.webhook.v1',
      environment: 'live',
      registration_mode: 'manual',
      selected_event_types: ['issues'],
    }, owner);
    await deps.store.writeCredentialVersion(created.ingress.ingress_id, {
      webhook_secret: 'G'.repeat(43),
      ignored_secret: 'must-not-carry-authority',
    });

    await expect(handleWebhookManualRegistrationConfirm(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).rejects.toMatchObject({
      code: 'webhook_not_ready',
      details: { blockers: ['credential_shape_invalid'] },
    });
    expect(deps.store.get(created.ingress.ingress_id)).toMatchObject({
      registration_state: 'manual_pending',
      intake_state: 'verification_pending',
    });
  });

  it('revalidates legacy Paddle credential shape before registration', async () => {
    const deps = makeDeps();
    const created = await handleWebhookIngressCreate(deps, {
      display_name: 'Legacy malformed Paddle credentials',
      profile_id: 'paddle.notification.v1',
      environment: 'live',
      registration_mode: 'manual',
      selected_event_types: ['subscription.updated'],
    }, owner);
    await deps.store.writeCredentialVersion(created.ingress.ingress_id, {
      endpoint_secret_key:
        'pdl_ntfset_01gkpjp8bkm3tm53kdgkx6sms7_6h3qd3uFSi9YCD3OLYAShQI90XTI5vEI',
      ignored_secret: 'must-not-carry-authority',
    });

    await expect(handleWebhookManualRegistrationConfirm(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).rejects.toMatchObject({
      code: 'webhook_not_ready',
      details: { blockers: ['credential_shape_invalid'] },
    });
    expect(deps.store.get(created.ingress.ingress_id)).toMatchObject({
      registration_state: 'manual_pending',
      intake_state: 'verification_pending',
    });
  });

  it('keeps a locally-ready ingress disabled when live readiness fails', async () => {
    const deps = makeDeps();
    const created = await createStripe(deps);
    await handleWebhookCredentialWrite(deps, {
      ingress_id: created.ingress.ingress_id,
      credentials: { endpoint_secret: 'whsec_write-only' },
    }, owner);
    await handleWebhookManualRegistrationConfirm(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner);
    deps.runtimeReadiness = () => ({
      endpoint_url: null,
      profile_runtime_available: true,
      paired_connection_available: true,
      listener_available: true,
      public_reachability_enabled: false,
      tls_ready: false,
      clock_ready: true,
      test_delivery_supported: false,
      vault_unlocked: true,
      server_unpaused: true,
    });
    const confirmed = await handleWebhookIngressGet(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner);
    expect(confirmed.ingress!.readiness).toMatchObject({
      local_configuration_complete: true,
      can_enable: false,
      blockers: expect.arrayContaining([
        'public_url_unavailable',
        'public_reachability_disabled',
        'tls_unavailable',
      ]),
    });
    await expect(handleWebhookIngressEnable(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).rejects.toMatchObject({
      code: 'webhook_not_ready',
      details: {
        blockers: expect.arrayContaining(['public_url_unavailable']),
      },
    });
    expect(deps.store.get(created.ingress.ingress_id)?.intake_state).toBe('ready');
  });

  it('rechecks trusted clock health immediately before enabling intake', async () => {
    const deps = makeDeps();
    const created = await handleWebhookIngressCreate(deps, {
      display_name: 'Timestamped generic delivery',
      profile_id: 'generic.timestamped-raw-body-hmac-sha256.v1',
      environment: 'live',
      registration_mode: 'manual',
      selected_event_types: ['delivery'],
    }, owner);
    await handleWebhookCredentialWrite(deps, {
      ingress_id: created.ingress.ingress_id,
      credentials: {
        signature_header: 'x-timestamped-signature',
        signing_secret: 'write-only-timestamped-secret',
      },
    }, owner);
    await handleWebhookManualRegistrationConfirm(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner);
    let readinessChecks = 0;
    deps.runtimeReadiness = (ingress) => ({
      endpoint_url: `https://hooks.example/v1/webhooks/${ingress.public_id}`,
      profile_runtime_available: true,
      paired_connection_available: true,
      listener_available: true,
      public_reachability_enabled: true,
      tls_ready: true,
      clock_ready: readinessChecks++ === 0,
      test_delivery_supported: false,
      vault_unlocked: true,
      server_unpaused: true,
    });

    await expect(handleWebhookIngressEnable(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).rejects.toMatchObject({
      code: 'webhook_not_ready',
      details: { blockers: ['clock_unverified'] },
    });
    expect(readinessChecks).toBe(2);
    expect(deps.store.get(created.ingress.ingress_id)?.intake_state).toBe('ready');
  });

  it('does not record a manual vendor confirmation without a canonical HTTPS URL', async () => {
    const deps = makeDeps();
    const created = await createStripe(deps);
    await handleWebhookCredentialWrite(deps, {
      ingress_id: created.ingress.ingress_id,
      credentials: { endpoint_secret: 'whsec_write-only' },
    }, owner);
    deps.runtimeReadiness = () => ({
      endpoint_url: null,
      profile_runtime_available: true,
      paired_connection_available: true,
      listener_available: true,
      public_reachability_enabled: true,
      tls_ready: false,
      clock_ready: true,
      test_delivery_supported: false,
      vault_unlocked: true,
      server_unpaused: true,
    });
    await expect(handleWebhookManualRegistrationConfirm(deps, {
      ingress_id: created.ingress.ingress_id,
    }, owner)).rejects.toMatchObject({
      code: 'webhook_not_ready',
      details: { blockers: ['public_url_unavailable'] },
    });
    expect(deps.store.get(created.ingress.ingress_id)?.registration_state)
      .toBe('manual_pending');
  });

  it('registers the ingress and accepted-delivery control-plane methods', () => {
    const handlers = makeWebhookIngressHandlers(makeDeps());
    expect(handlers?.methods).toEqual([
      'webhook.ingress.list',
      'webhook.ingress.get',
      'webhook.ingress.create',
      'webhook.ingress.update',
      'webhook.ingress.credentials.write',
      'webhook.ingress.credentials.retire',
      'webhook.ingress.manual.confirm',
      'webhook.ingress.registration.reconcile',
      'webhook.ingress.enable',
      'webhook.ingress.disable',
      'webhook.ingress.test.deliver',
      'webhook.ingress.retire',
      'webhook.delivery.list',
      'webhook.delivery.get',
      'webhook.delivery.event.get',
      'webhook.delivery.rejected.list',
      'webhook.delivery.retention.prune',
    ]);
  });

  it('does not mount the public route from control-plane RPC deps alone', async () => {
    const server = await startServer(0, { webhookIngressDeps: makeDeps() });
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/v1/webhooks/opaquePublicId_0123456789abcdef`,
        { method: 'POST', body: '{}' },
      );
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'not_found' },
      });
    } finally {
      await server.close();
    }
  });
});
