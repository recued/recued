import { describe, expect, it, vi } from 'vitest';
import type { ConnectionView } from '@recued/contracts';
import {
  buildConnectionEditDialogPatch,
  projectConnectionPayload,
  resolveConnectionSchema,
  BLUESKY_API_BASE,
  TAVILY_API_BASE,
} from '@recued/ui-shared';

import {
  bootstrapConnectionsRoute,
} from '../connections/bootstrap-connections-route.js';
import {
  makeFakeDocument,
  flush,
  deferred,
  clickAction,
  field,
  connection,
  httpIngredient,
  op,
  installedPackWith,
  makeEnrollCallers,
  mountPanel,
} from './helpers/vendor-prefilled-enroll-rig.js';

describe('packs item E — vendor-prefilled connection enroll deep link', () => {
  it('replaces automatic direct-app scopes when switching a generic vendor form to managed OAuth', async () => {
    const { host, panel } = mountPanel({ initialVendor: 'google', runPacksList: async () => ({ packs: [] }) });
    await panel.whenLoaded(); await flush();
    expect(panel.getState().dialog.values['auth.scopes']).toContain('drive');
    field(host, 'auth.type', 'managed_oauth');
    expect(panel.getState().dialog.values['auth.scopes']).toBe('');
    panel.dispose();
  });
  it('requires an explicit API service if the requested pack metadata cannot be resolved', async () => {
    const { panel } = mountPanel({ initialVendor: 'google', initialPack: { slug: 'unavailable-sheets' }, runPacksList: async () => ({ packs: [] }) });
    await panel.whenLoaded(); await flush();
    expect(panel.getState().dialog.values['config.base_url']).toBe('');
    expect(panel.getState().dialog.error).toContain('unavailable or ambiguous');
    panel.dispose();
  });
  it('⛔⛔⛔ the deep-linked enroll form carries THIS origin\'s callback URL', async () => {
    /** `#connections/others/enroll/<vendor>` — where the packs "Set up" CTA lands.
     *  It opens through `openVendorEnrollForm`, which MUTATES the dialog field by
     *  field instead of rebuilding it, and its hand-written list never included the
     *  callback fields. The renderer falls back to the cloud URL on an unset field,
     *  so this form told the owner to register `https://app.recued.com/oauth-callback`
     *  while they were on `http://localhost:7891` — a URL the flow does not send and
     *  the provider cannot match. The re-authorize dialog REBUILDS its state and so
     *  showed the correct one: the same screen disagreeing with itself, which is what
     *  made it read as a caching problem rather than a code one.
     *  ⚠ Asserted on the DIALOG STATE, not the HTML, so the fallback in the renderer
     *  cannot mask an unset field — that fallback is exactly what hid this. */
    /** ⚠ The resolver reads `globalThis.location.origin` and falls back to the cloud
     *  URL off-browser — correctly. Without an origin here the test would "reproduce"
     *  the bug for an environment reason and pass on a fix that changed nothing, so
     *  the origin is supplied and restored. */
    const priorLocation = (globalThis as { location?: unknown }).location;
    Object.defineProperty(globalThis, 'location', {
      value: { origin: 'http://localhost:7891' }, configurable: true, writable: true,
    });
    const { panel } = mountPanel({ initialVendor: 'onedrive' });
    await panel.whenLoaded();
    await flush();

    const { dialog } = panel.getState();
    if (priorLocation === undefined) {
      delete (globalThis as { location?: unknown }).location;
    } else {
      Object.defineProperty(globalThis, 'location', {
        value: priorLocation, configurable: true, writable: true,
      });
    }
    expect(dialog.stage).toBe('form');
    expect(dialog.oauthCallbackUrl,
      'the deep-linked form must resolve a callback URL, not leave it unset')
      .toBeDefined();
    expect(dialog.oauthCallbackUrl,
      'and it must NOT be the cloud callback while on a loopback origin')
      .not.toBe('https://app.recued.com/oauth-callback');
    expect(dialog.oauthCallbackUrl).toBe(
      'http://localhost:7891/webclient/oauth-callback.html');
    /** ⚠ The alternate must be the OTHER one, so "register both" names a real pair. */
    expect(dialog.oauthCallbackAlternateUrl).toBe('https://app.recued.com/oauth-callback');
    panel.dispose();
  });

  it('auto-opens a registered HubSpot vendor form from initialVendor', async () => {
    const { panel } = mountPanel({ initialVendor: 'hubspot' });

    await panel.whenLoaded();
    await flush();

    const { dialog } = panel.getState();
    expect(dialog.stage).toBe('form');
    expect(dialog.kind).toBe('api');
    expect(dialog.vendor).toBe('hubspot');
    expect(dialog.values['config.vendor']).toBe('hubspot');
    panel.dispose();
  });

  it('auto-opens the registered OneDrive vendor form from initialVendor (D-192 interim enroll)', async () => {
    // The `#connections/others/enroll/onedrive` deep link — makes the already-
    // shipped OneDrive file-source leaf user-reachable. Seeds the locked hidden
    // config.vendor + base_url + token_endpoint from ONEDRIVE_SCHEMA_INITIAL_VALUES.
    const { panel } = mountPanel({ initialVendor: 'onedrive' });

    await panel.whenLoaded();
    await flush();

    const { dialog } = panel.getState();
    expect(dialog.stage).toBe('form');
    expect(dialog.kind).toBe('api');
    expect(dialog.vendor).toBe('onedrive');
    expect(dialog.values['config.vendor']).toBe('onedrive');
    expect(dialog.values['config.base_url']).toBe('https://graph.microsoft.com/v1.0');
    expect(dialog.values['auth.token_endpoint']).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    );
    panel.dispose();
  });

  it('auto-opens Tavily with its fixed API origin and bearer mode prefilled', async () => {
    const { panel } = mountPanel({ initialVendor: 'tavily' });

    await panel.whenLoaded();
    await flush();

    const { dialog } = panel.getState();
    expect(dialog.stage).toBe('form');
    expect(dialog.kind).toBe('api');
    expect(dialog.vendor).toBe('tavily');
    expect(dialog.values.name).toBe('tavily');
    expect(dialog.values['config.vendor']).toBe('tavily');
    expect(dialog.values['config.base_url']).toBe(TAVILY_API_BASE);
    expect(dialog.values['auth.type']).toBe('bearer');
    panel.dispose();
  });

  it('auto-opens Bluesky with AT Protocol session auth, not generic bearer', async () => {
    const { panel } = mountPanel({ initialVendor: 'bluesky' });

    await panel.whenLoaded();
    await flush();

    const { dialog } = panel.getState();
    expect(dialog.stage).toBe('form');
    expect(dialog.kind).toBe('api');
    expect(dialog.vendor).toBe('bluesky');
    expect(dialog.values['config.vendor']).toBe('bluesky');
    expect(dialog.values['config.base_url']).toBe(BLUESKY_API_BASE);
    expect(dialog.values['auth.type']).toBe('atproto_session');
    panel.dispose();
  });

  it('waits for packs.list before pre-filling registered vendor scopes', async () => {
    const pack = installedPackWith(
      [httpIngredient('hubspot-catalog', 'hubspot')],
      [op('deal.read', 'hubspot-catalog', ['crm.objects.deals.read'])],
    );
    const { panel } = mountPanel({
      initialVendor: 'hubspot',
      runPacksList: async () => ({ packs: [pack] }),
    });

    await panel.whenLoaded();
    await flush();

    const scopes = (panel.getState().dialog.values['auth.scopes'] ?? '').split(/\s+/);
    expect(scopes).toContain('crm.objects.deals.read');
    panel.dispose();
  });

  it('auto-opens an unregistered API-key vendor as a bare api form', async () => {
    const { panel } = mountPanel({ initialVendor: 'stripe' });

    await panel.whenLoaded();
    await flush();

    const { dialog } = panel.getState();
    expect(dialog.stage).toBe('form');
    expect(dialog.kind).toBe('api');
    expect(dialog.vendor).toBeNull();
    expect(dialog.values.name).toBe('stripe');
    expect(dialog.values['config.vendor']).toBe('stripe');
    expect(dialog.values['auth.type']).toBe('bearer');
    panel.dispose();
  });

  it('projects the unregistered vendor tag on submit', async () => {
    const { host, panel, calls } = mountPanel({ initialVendor: 'stripe' });
    await panel.whenLoaded();
    await flush();

    field(host, 'display_name', 'Stripe');
    field(host, 'config.base_url', 'https://api.stripe.com');
    field(host, 'auth.token', 'sk_test');
    clickAction(host, { action: 'connections-submit-form' });
    await flush();

    expect(calls.runEnroll).toHaveBeenCalledTimes(1);
    const payload = calls.runEnroll.mock.calls[0]![0];
    expect(payload.name).toBe('stripe');
    expect(payload.kind).toBe('api');
    expect(payload.config.vendor).toBe('stripe');
    panel.dispose();
  });

  it('keeps bare api enroll inert when no initialVendor seeded config.vendor', async () => {
    const { host, panel, calls } = mountPanel();
    await panel.whenLoaded();

    clickAction(host, { action: 'connections-open-add' });
    clickAction(host, { action: 'connections-pick-kind', kind: 'api' });
    field(host, 'name', 'my-api');
    field(host, 'display_name', 'My API');
    field(host, 'config.base_url', 'https://api.example.com');
    field(host, 'auth.token', 'secret');
    clickAction(host, { action: 'connections-submit-form' });
    await flush();

    expect(calls.runEnroll).toHaveBeenCalledTimes(1);
    const payload = calls.runEnroll.mock.calls[0]![0];
    expect(payload.config).not.toHaveProperty('vendor');
    panel.dispose();
  });

  it('ignores an invalid initialVendor segment', async () => {
    const { panel } = mountPanel({ initialVendor: 'Not$Valid' });

    await panel.whenLoaded();
    await flush();

    expect(panel.getState().dialog.stage).toBe('closed');
    panel.dispose();
  });

  it('does not clobber user dialog navigation that wins the load race', async () => {
    const list = deferred<{ connections: ReadonlyArray<ConnectionView> }>();
    const { host, panel } = mountPanel({
      initialVendor: 'stripe',
      runList: () => list.promise,
    });

    clickAction(host, { action: 'connections-open-add' });
    expect(panel.getState().dialog.stage).toBe('kind-picker');
    list.resolve({ connections: [] });
    await panel.whenLoaded();
    await flush();

    expect(panel.getState().dialog.stage).toBe('kind-picker');
    panel.dispose();
  });

  it('forwards initialEnrollVendor only to the Others enroll panel', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const callers = makeEnrollCallers();
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'others',
      initialEnrollVendor: 'stripe',
      connectionsEnrollListCaller: callers.runList,
      connectionsEnrollCaller: callers.runEnroll,
      connectionsUpdateCaller: callers.runUpdate,
      connectionsDeleteCaller: callers.runDelete,
      connectionsProbeCaller: callers.runProbe,
    });

    expect(route.connectionsEnrollPanel()).not.toBeNull();
    await route.connectionsEnrollPanel()!.whenLoaded();
    await flush();
    expect(route.connectionsEnrollPanel()!.getState().dialog.stage).toBe('form');
    expect(route.connectionsEnrollPanel()!.getState().dialog.values['config.vendor'])
      .toBe('stripe');
    route.dispose();

    const mailDoc = makeFakeDocument();
    const mailRoot = mailDoc.createElement('div');
    const mailRoute = bootstrapConnectionsRoute({
      root: mailRoot as unknown as HTMLElement,
      document: mailDoc as unknown as Document,
      initialTab: 'mail',
      initialEnrollVendor: 'stripe',
      mail: {
        list: vi.fn(async () => ({ instances: [] })),
        enrollImap: vi.fn(async () => ({ slug: 'mail', send_capable: true })),
        delete: vi.fn(async () => ({ ok: true as const })),
      },
      connectionsEnrollListCaller: callers.runList,
      connectionsEnrollCaller: callers.runEnroll,
      connectionsUpdateCaller: callers.runUpdate,
      connectionsDeleteCaller: callers.runDelete,
      connectionsProbeCaller: callers.runProbe,
    });

    expect(mailRoute.connectionsEnrollPanel()).toBeNull();
    mailRoute.dispose();
  });

  it('round-trips config.vendor for an unregistered vendor edit patch', () => {
    const patch = buildConnectionEditDialogPatch({
      name: 'my-stripe',
      kind: 'api',
      display_name: 'Stripe',
      vendor: 'stripe',
      base_url: 'https://api.stripe.com',
    } as ConnectionView);

    expect(patch.vendor).toBeNull();
    const schema = resolveConnectionSchema(patch.kind, patch.subtype ?? undefined);
    expect(schema).toBeDefined();
    const payload = projectConnectionPayload(
      schema!,
      patch.values,
      patch.kind,
      patch.subtype,
    );

    expect(payload.name).toBe('my-stripe');
    expect(payload.config.vendor).toBe('stripe');
    expect(payload.config.vendor).not.toBe('my-stripe');
  });
});
