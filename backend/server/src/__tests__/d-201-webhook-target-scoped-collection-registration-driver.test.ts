import { describe, expect, it, vi } from 'vitest';

import {
  compileWebhookTargetScopedCollectionRegistrationDriverPreset,
  createWebhookTargetScopedCollectionRegistrationDriver,
  type WebhookTargetScopedCollectionRegistrationDriverPreset,
  type WebhookTargetScopedCollectionRegistrationOperations,
  type WebhookTargetScopedCollectionSearchPageInput,
} from '../webhook-target-scoped-collection-registration-driver.js';
import {
  WEBHOOK_REGISTRATION_DRIVER_PROFILE_PRESETS,
  webhookAddressableCollectionRegistrationDriverPreset,
  webhookTargetScopedCollectionRegistrationDriverPreset,
} from '../webhook-registration-driver-profile-presets.js';
import type {
  ManagedWebhookEndpointCreateResult,
  ManagedWebhookEndpointMatch,
  ManagedWebhookEndpointSnapshot,
  ManagedWebhookRegistrationContext,
} from '../webhook-registration-runtime.js';

const PRESET = {
  kind: 'target_scoped_endpoint_collection.v1',
  profile_id: 'github.webhook.v1',
  pagination: {
    kind: 'bounded_page_number.v1',
    max_pages: 2,
    page_size: 2,
  },
  search_exhausted_message: 'Target-scoped endpoint search was incomplete',
} as const satisfies WebhookTargetScopedCollectionRegistrationDriverPreset;

const CONTEXT: ManagedWebhookRegistrationContext = {
  paired_connection_id: 'connection-1',
  desired: {
    ingress_id: 'whi_0123456789abcdef0123456789abcdef',
    environment: 'test',
    registration_target: {
      kind: 'repository',
      key: 'openai/example',
    },
    endpoint_url: 'https://hooks.example.test/v1/webhooks/opaque',
    event_types: ['push'],
  },
};

const snapshot = (
  remoteEndpointId: string,
): ManagedWebhookEndpointSnapshot => ({
  remote_endpoint_id: remoteEndpointId,
  environment: 'test',
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
  credential_result: { webhook_secret: 'one-time-secret' },
};

type SearchSession = { readonly target: string };

const operations = (
  readSearchPage: WebhookTargetScopedCollectionRegistrationOperations<
    SearchSession
  >['readSearchPage'],
): WebhookTargetScopedCollectionRegistrationOperations<SearchSession> => ({
  prepareSearch: vi.fn(async () => ({ target: 'opaque-target' })),
  readSearchPage,
  create: vi.fn(async () => CREATE_RESULT),
  read: vi.fn(async () => snapshot('remote-read')),
  update: vi.fn(async () => snapshot('remote-updated')),
  delete: vi.fn(async () => undefined),
});

describe('D-201 Slice 9BJ target-scoped-collection registration driver', () => {
  it('selects only the frozen, serializable GitHub target-scoped preset', () => {
    expect(Object.keys(WEBHOOK_REGISTRATION_DRIVER_PROFILE_PRESETS)).toEqual([
      'stripe.event.v1',
      'paddle.notification.v1',
      'github.webhook.v1',
      'telegram.bot-webhook.v1',
    ]);
    const github = webhookTargetScopedCollectionRegistrationDriverPreset(
      'github.webhook.v1',
    );
    expect(github).toMatchObject({
      kind: 'target_scoped_endpoint_collection.v1',
      pagination: { max_pages: 10, page_size: 100 },
      search_exhausted_message:
        'GitHub webhook search exceeded its bounded page limit',
    });
    expect(Object.isFrozen(github)).toBe(true);
    expect(Object.isFrozen(github?.pagination)).toBe(true);
    expect(() => JSON.stringify(github)).not.toThrow();
    expect(Object.isFrozen(WEBHOOK_REGISTRATION_DRIVER_PROFILE_PRESETS))
      .toBe(true);
    expect(
      webhookAddressableCollectionRegistrationDriverPreset(
        'github.webhook.v1',
      ),
    ).toBeNull();
    expect(
      webhookTargetScopedCollectionRegistrationDriverPreset('stripe.event.v1'),
    ).toBeNull();
    expect(
      webhookTargetScopedCollectionRegistrationDriverPreset(
        'paddle.notification.v1',
      ),
    ).toBeNull();
    expect(
      webhookTargetScopedCollectionRegistrationDriverPreset(
        'telegram.bot-webhook.v1',
      ),
    ).toBeNull();
  });

  it('aggregates bounded pages and passes a frozen page-number contract', async () => {
    const first = match('remote-1');
    const second = match('remote-2');
    const session: SearchSession = { target: 'opaque-target' };
    const readSearchPage = vi.fn(async (
      _context: ManagedWebhookRegistrationContext,
      receivedSession: SearchSession,
      page: WebhookTargetScopedCollectionSearchPageInput,
    ) => {
      expect(receivedSession).toBe(session);
      expect(Object.isFrozen(page)).toBe(true);
      return page.page_number === 1
        ? { matches: [first], has_more: true }
        : { matches: [second], has_more: false };
    });
    const collaborators = operations(readSearchPage);
    Reflect.set(collaborators, 'prepareSearch', vi.fn(async () => session));
    const driver = createWebhookTargetScopedCollectionRegistrationDriver(
      PRESET,
      collaborators,
    );

    await expect(driver.find(CONTEXT)).resolves.toEqual([first, second]);
    expect(collaborators.prepareSearch).toHaveBeenCalledOnce();
    expect(readSearchPage).toHaveBeenNthCalledWith(
      1,
      CONTEXT,
      session,
      { page_number: 1, page_size: 2 },
    );
    expect(readSearchPage).toHaveBeenNthCalledWith(
      2,
      CONTEXT,
      session,
      { page_number: 2, page_size: 2 },
    );
    expect(driver.profile_id).toBe(PRESET.profile_id);
    expect(Object.isFrozen(driver)).toBe(true);
    expect(Object.isFrozen(driver.preset)).toBe(true);
  });

  it('gives create a context-bound find lifecycle and pins all collaborators', async () => {
    const readSearchPage = vi.fn(async () => ({
      matches: [],
      has_more: false,
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
    const collaborators = operations(readSearchPage);
    Reflect.set(collaborators, 'create', create);
    const originalRead = collaborators.read;
    const driver = createWebhookTargetScopedCollectionRegistrationDriver(
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

  it('fails with the preset-safe error after exactly the configured page bound', async () => {
    const readSearchPage = vi.fn(async (
      _context: ManagedWebhookRegistrationContext,
      _session: SearchSession,
      _page: WebhookTargetScopedCollectionSearchPageInput,
    ) => ({
      matches: [],
      has_more: true,
    }));
    const driver = createWebhookTargetScopedCollectionRegistrationDriver(
      PRESET,
      operations(readSearchPage),
    );

    await expect(driver.find(CONTEXT)).rejects.toMatchObject({
      code: 'search_incomplete',
      message: PRESET.search_exhausted_message,
    });
    expect(readSearchPage).toHaveBeenCalledTimes(2);
    expect(readSearchPage.mock.calls.map((call) => call[2].page_number))
      .toEqual([1, 2]);
  });

  it('accepts only exact own-data, bounded, target-bearing presets', () => {
    const compiled =
      compileWebhookTargetScopedCollectionRegistrationDriverPreset(PRESET);
    expect(compiled).toEqual(PRESET);
    expect(compiled).not.toBe(PRESET);
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.pagination)).toBe(true);

    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'owner_http_template.v1' },
      { ...PRESET, profile_id: 'unknown.vendor.v1' },
      { ...PRESET, profile_id: 'generic.static-header-token.v1' },
      { ...PRESET, profile_id: 'stripe.event.v1' },
      { ...PRESET, profile_id: 'telegram.bot-webhook.v1' },
      { ...PRESET, pagination: { ...PRESET.pagination, extra: true } },
      { ...PRESET, pagination: { ...PRESET.pagination, kind: 'offset.v1' } },
      { ...PRESET, pagination: { ...PRESET.pagination, max_pages: 0 } },
      { ...PRESET, pagination: { ...PRESET.pagination, max_pages: 101 } },
      { ...PRESET, pagination: { ...PRESET.pagination, page_size: 0 } },
      { ...PRESET, pagination: { ...PRESET.pagination, page_size: 1_001 } },
      { ...PRESET, search_exhausted_message: '' },
      { ...PRESET, search_exhausted_message: 'unsafe\nmessage' },
      { ...PRESET, search_exhausted_message: 'x'.repeat(257) },
      Object.create(PRESET),
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('hostile driver preset');
          },
        },
      ),
    ]) {
      expect(() =>
        compileWebhookTargetScopedCollectionRegistrationDriverPreset(
          invalid as never,
        ),
      ).toThrow('invalid trusted preset');
    }

    let accessorReads = 0;
    const pagination = {
      kind: PRESET.pagination.kind,
      max_pages: PRESET.pagination.max_pages,
    } as Record<string, unknown>;
    Object.defineProperty(pagination, 'page_size', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return PRESET.pagination.page_size;
      },
    });
    expect(() =>
      compileWebhookTargetScopedCollectionRegistrationDriverPreset({
        ...PRESET,
        pagination,
      } as never),
    ).toThrow('invalid trusted preset');
    expect(accessorReads).toBe(0);
  });

  it('accepts only an exact own-data collaborator set without invoking accessors', () => {
    const valid = operations(async () => ({ matches: [], has_more: false }));
    for (const invalid of [
      { ...valid, extra: vi.fn() },
      { ...valid, delete: undefined },
      Object.create(valid),
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('hostile driver collaborators');
          },
        },
      ),
    ]) {
      expect(() =>
        createWebhookTargetScopedCollectionRegistrationDriver(
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
      createWebhookTargetScopedCollectionRegistrationDriver(
        PRESET,
        accessor as never,
      ),
    ).toThrow('invalid trusted operations');
    expect(accessorReads).toBe(0);
  });

  it('rejects malformed, sparse, oversized, accessor, and boxed search pages', async () => {
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
        throw new Error('hostile match array');
      },
    });
    const matchesWithExtraProperty = [match('extra-property')];
    Reflect.set(matchesWithExtraProperty, 'extra', true);
    const accessorPage = { matches: [] } as Record<string, unknown>;
    Object.defineProperty(accessorPage, 'has_more', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return false;
      },
    });
    const hostilePage = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('hostile search page');
        },
      },
    );
    for (const rawPage of [
      null,
      { matches: [], has_more: false, extra: true },
      { matches: {}, has_more: false },
      { matches: sparseMatches, has_more: false },
      { matches: accessorMatches, has_more: false },
      { matches: hostileMatches, has_more: false },
      { matches: matchesWithExtraProperty, has_more: false },
      { matches: [match('1'), match('2'), match('3')], has_more: false },
      { matches: [], has_more: undefined },
      { matches: [], has_more: new Boolean(false) },
      accessorPage,
      hostilePage,
    ]) {
      const driver = createWebhookTargetScopedCollectionRegistrationDriver(
        PRESET,
        operations(async () => rawPage as never),
      );
      await expect(driver.find(CONTEXT)).rejects.toMatchObject({
        code: 'upstream_response_invalid',
        message:
          'webhook target-scoped-collection driver received an invalid search page',
      });
    }
    expect(accessorReads).toBe(0);
  });
});
