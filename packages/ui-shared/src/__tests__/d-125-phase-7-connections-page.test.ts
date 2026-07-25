/** D-125 P7.1 + P7.2 — Settings → Connections page + per-kind
 *  enrollment dialogs.
 *
 *  Pure-render coverage: list view groups by kind, dialog stages
 *  (kind-picker / subtype-picker / form), per-kind schema field
 *  visibility (`showWhen`), schema → rpc payload projection drops
 *  hidden + empty optionals, and validators reject malformed names. */

import { describe, expect, it } from 'vitest';
import {
  HUBSPOT_API_BASE,
  HUBSPOT_OAUTH_TOKEN_URL,
  NOTIFICATION_SUBTYPES,
  SALESFORCE_OAUTH_TOKEN_URL_SANDBOX,
} from '@recued/contracts';
import {
  renderConnectionsPage,
  initialConnectionsPageState,
  initialConnectionsDialogState,
  projectConnectionPayload,
  shouldPatchConnectionAuth,
  flattenConnectionViewIntoValues,
  buildConnectionEditDialogPatch,
  resolveConnectionSchema,
  CONNECTION_KIND_CHOICES,
  CONNECTION_SUBTYPE_CHOICES,
  CONNECTION_NAME_REGEX,
  apiSchema,
  mcpSchemas,
  notificationSchemas,
} from '../index.js';
import type {
  ConnectionsPageState,
  ConnectionsDialogState,
  ConnectionPayload,
} from '../connections/index.js';

const sampleConnections = [
  { name: 'hubspot', kind: 'api' as const, display_name: 'HubSpot', base_url: 'https://api.hubapi.com' },
  { name: 'hubspot-sandbox', kind: 'api' as const, display_name: 'HubSpot Sandbox', base_url: 'https://sandbox.hubapi.com' },
  { name: 'gh-mcp', kind: 'mcp' as const, subtype: 'sse', display_name: 'GitHub MCP', endpoint: 'https://mcp.github.com/sse' },
  { name: 'team-slack', kind: 'notification' as const, subtype: 'slack', display_name: 'Eng Slack', channel_id: 'C0123456789' },
];

const baseState = (overrides?: Partial<ConnectionsPageState>): ConnectionsPageState => ({
  ...initialConnectionsPageState(),
  connections: sampleConnections,
  ...(overrides ?? {}),
});

describe('D-125 P7.1 — list view', () => {
  it('renders three kind groups with their counts', () => {
    const html = renderConnectionsPage(baseState());
    expect(html).toContain('API (2)');
    expect(html).toContain('MCP (1)');
    expect(html).toContain('Notification (1)');
  });

  it('omits empty kind groups so an api-only deployment is uncluttered', () => {
    const apiOnly = baseState({
      connections: sampleConnections.filter((c) => c.kind === 'api'),
    });
    const html = renderConnectionsPage(apiOnly);
    expect(html).toContain('API (2)');
    expect(html).not.toContain('MCP (');
    expect(html).not.toContain('Notification (');
  });

  it('renders each row with kind + name + summary + actions', () => {
    const html = renderConnectionsPage(baseState());
    expect(html).toContain('hubspot');
    expect(html).toContain('https://api.hubapi.com');
    expect(html).toContain('data-action="connections-edit"');
    expect(html).toContain('data-action="connections-probe"');
    expect(html).toContain('data-action="connections-delete"');
  });

  it('marks per-row probe in flight as "Probing…" and disables the button', () => {
    const html = renderConnectionsPage(
      baseState({ probeInFlight: new Set(['api/hubspot']) }),
    );
    expect(html).toContain('Probing…');
  });

  it('shows + Add Connection button on the list view', () => {
    const html = renderConnectionsPage(baseState());
    expect(html).toContain('data-action="connections-open-add"');
    expect(html).toContain('+ Add Connection');
  });

  it('renders empty hint when no connections enrolled', () => {
    const html = renderConnectionsPage(baseState({ connections: [] }));
    expect(html).toContain('No connections enrolled yet');
  });

  it('surfaces loading + error states', () => {
    const loading = renderConnectionsPage(baseState({ loading: true }));
    expect(loading).toContain('Loading enrolled connections');

    const errored = renderConnectionsPage(baseState({ error: 'rpc failed' }));
    expect(errored).toContain('rpc failed');
  });

  it('renders the back-to-Settings link in standalone layout (default)', () => {
    const html = renderConnectionsPage(baseState());
    expect(html).toContain('data-action="connections-close-page"');
    expect(html).toContain('← Settings');
  });

  it('omits the back link in embedded layout', () => {
    const html = renderConnectionsPage({ ...baseState(), layout: 'embedded' });
    expect(html).not.toContain('data-action="connections-close-page"');
  });
});

describe('D-125 P7.1 — dialog stages', () => {
  const withDialog = (over: Partial<ConnectionsDialogState>): ConnectionsPageState => ({
    ...baseState(),
    dialog: { ...initialConnectionsDialogState(), ...over },
  });

  it('kind-picker stage renders all three kind cards', () => {
    const html = renderConnectionsPage(withDialog({ stage: 'kind-picker' }));
    for (const choice of CONNECTION_KIND_CHOICES) {
      expect(html).toContain(`data-kind="${choice.kind}"`);
      expect(html).toContain(choice.label);
    }
  });

  it('subtype-picker for mcp lists three subtypes', () => {
    const html = renderConnectionsPage(
      withDialog({ stage: 'subtype-picker', kind: 'mcp' }),
    );
    for (const choice of CONNECTION_SUBTYPE_CHOICES.mcp) {
      expect(html).toContain(`data-subtype="${choice.subtype}"`);
    }
  });

  it('subtype-picker for notification lists four subtypes', () => {
    const html = renderConnectionsPage(
      withDialog({ stage: 'subtype-picker', kind: 'notification' }),
    );
    for (const choice of CONNECTION_SUBTYPE_CHOICES.notification) {
      expect(html).toContain(`data-subtype="${choice.subtype}"`);
    }
  });

  it('form stage for kind=api renders auth-type dependent fields when bearer is selected', () => {
    const html = renderConnectionsPage(
      withDialog({
        stage: 'form',
        kind: 'api',
        values: { 'auth.type': 'bearer' },
      }),
    );
    expect(html).toContain('Bearer Token');
    expect(html).not.toContain('Refresh Token'); // oauth2_refresh field hidden
  });

  it('switching auth.type to oauth2_refresh swaps in OAuth fields', () => {
    const html = renderConnectionsPage(
      withDialog({
        stage: 'form',
        kind: 'api',
        values: { 'auth.type': 'oauth2_refresh' },
      }),
    );
    expect(html).toContain('Refresh Token');
    expect(html).toContain('Client ID');
    expect(html).toContain('Token Endpoint');
    expect(html).not.toContain('Bearer Token');
  });

  it('form for mcp/sse requires endpoint URL', () => {
    const html = renderConnectionsPage(
      withDialog({ stage: 'form', kind: 'mcp', subtype: 'sse', values: {} }),
    );
    expect(html).toContain('Endpoint URL');
  });

  it('form for notification/slack requires channel id', () => {
    const html = renderConnectionsPage(
      withDialog({ stage: 'form', kind: 'notification', subtype: 'slack', values: {} }),
    );
    expect(html).toContain('Channel ID');
    expect(html).toContain('Bot Token');
  });

  it('edit-mode form omits the Back button (no kind picker to step back to)', () => {
    const html = renderConnectionsPage(
      withDialog({
        stage: 'form',
        mode: 'edit',
        kind: 'api',
        editingId: 'api/hubspot',
        values: { 'auth.type': 'bearer' },
      }),
    );
    expect(html).not.toMatch(/data-action="connections-back-to-(kind|subtype)"/);
    expect(html).toContain('data-action="connections-cancel-dialog"');
  });

  it('Save button label switches to Save changes in edit mode', () => {
    const html = renderConnectionsPage(
      withDialog({
        stage: 'form',
        mode: 'edit',
        kind: 'api',
        values: { 'auth.type': 'bearer' },
      }),
    );
    expect(html).toContain('Save changes');
  });

  it('edit-mode locks the connection name because row identity is immutable', () => {
    const html = renderConnectionsPage(
      withDialog({
        stage: 'form',
        mode: 'edit',
        kind: 'api',
        editingId: 'api/hubspot',
        values: {
          name: 'hubspot',
          display_name: 'HubSpot',
          'config.base_url': 'https://api.hubapi.com',
          'auth.type': 'bearer',
        },
      }),
    );
    expect(html).toMatch(/<input[^>]*readonly[^>]*data-conn-field="name"/);
  });

  it('edit-mode allows legacy names that no longer satisfy the create regex', () => {
    const html = renderConnectionsPage(
      withDialog({
        stage: 'form',
        mode: 'edit',
        kind: 'api',
        editingId: 'api/legacy_hubspot',
        values: {
          name: 'legacy_hubspot',
          display_name: 'Legacy HubSpot',
          'config.base_url': 'https://api.hubapi.com',
          'auth.type': 'bearer',
          'auth.token': 'pat-xxx',
        },
      }),
    );
    expect(html).not.toContain('Name must be lowercase letters');
    expect(html).not.toMatch(/data-action="connections-submit-form"[^>]*disabled/);
  });

  it('edit-mode can save config/display changes without re-entering auth', () => {
    const html = renderConnectionsPage(
      withDialog({
        stage: 'form',
        mode: 'edit',
        kind: 'api',
        editingId: 'api/hubspot',
        values: {
          name: 'hubspot',
          display_name: 'HubSpot renamed',
          'config.base_url': 'https://api.hubapi.com',
          'auth.type': 'bearer',
        },
      }),
    );
    expect(html).not.toMatch(/data-action="connections-submit-form"[^>]*disabled/);
  });

  it('edit-mode still validates auth when the user starts replacing it', () => {
    const html = renderConnectionsPage(
      withDialog({
        stage: 'form',
        mode: 'edit',
        kind: 'api',
        editingId: 'api/hubspot',
        values: {
          name: 'hubspot',
          display_name: 'HubSpot',
          'config.base_url': 'https://api.hubapi.com',
          'auth.type': 'basic',
          'auth.username': 'user',
        },
      }),
    );
    expect(html).toMatch(/data-action="connections-submit-form"[^>]*disabled/);
  });

  it('saving-in-flight disables the submit + shows Saving…', () => {
    const html = renderConnectionsPage(
      withDialog({
        stage: 'form',
        kind: 'api',
        saving: true,
        values: { 'auth.type': 'bearer' },
      }),
    );
    expect(html).toContain('Saving…');
  });
});

describe('D-125 P7.2 — schemas', () => {
  it('apiSchema covers every supported auth type', () => {
    const types = apiSchema.fields.find((f) => f.key === 'auth.type')?.options ?? [];
    expect(types).toEqual([
      'bearer',
      'basic',
      'header',
      'query',
      'oauth2_refresh',
      'oauth2_client_credentials',
    ]);
  });

  it('mcp schemas cover sse / websocket / stdio', () => {
    expect(Object.keys(mcpSchemas).sort()).toEqual(['sse', 'stdio', 'websocket']);
  });

  it('has an enroll card for every notification subtype', () => {
    // Was a hand-spelled list of four. Assert the RELATIONSHIP instead: the cards
    // must cover exactly the enrollable subtypes. (The compiler already forces this
    // — `notificationSchemas` is `satisfies Record<NotificationSubtype, …>` — so a
    // new vendor cannot ship cardless; this pins the runtime shape and, unlike a
    // literal, costs the next vendor nothing.)
    expect(Object.keys(notificationSchemas).sort()).toEqual(
      [...NOTIFICATION_SUBTYPES].sort(),
    );
  });

  it('resolveConnectionSchema returns api regardless of subtype', () => {
    expect(resolveConnectionSchema('api')).toBe(apiSchema);
    expect(resolveConnectionSchema('api', 'irrelevant')).toBe(apiSchema);
  });

  it('resolveConnectionSchema requires subtype for mcp / notification', () => {
    expect(resolveConnectionSchema('mcp')).toBeUndefined();
    expect(resolveConnectionSchema('mcp', 'sse')).toBe(mcpSchemas.sse);
    expect(resolveConnectionSchema('notification', 'slack')).toBe(notificationSchemas.slack);
    expect(resolveConnectionSchema('notification', 'unknown')).toBeUndefined();
  });
});

describe('D-125 P7.2 — payload projection', () => {
  it('projects api/bearer values into the rpc shape and drops hidden auth fields', () => {
    const payload = projectConnectionPayload(
      apiSchema,
      {
        name: 'hubspot',
        display_name: 'HubSpot',
        'config.base_url': 'https://api.hubapi.com',
        'auth.type': 'bearer',
        'auth.token': 'pat-xxx',
        // Stale value from a previous switch — must be dropped because
        // basic auth fields aren't visible.
        'auth.username': 'leftover',
      },
      'api',
      null,
    );
    expect(payload.name).toBe('hubspot');
    expect(payload.display_name).toBe('HubSpot');
    expect(payload.config).toEqual({ base_url: 'https://api.hubapi.com' });
    expect(payload.auth).toEqual({ type: 'bearer', token: 'pat-xxx' });
  });

  it('projects mcp/stdio values with subtype stamped into the payload', () => {
    const payload = projectConnectionPayload(
      mcpSchemas.stdio,
      {
        name: 'local-mcp',
        display_name: 'Local MCP',
        'config.command': '/usr/local/bin/mcp-server',
        'config.args': '["--config", "/etc/mcp.toml"]',
      },
      'mcp',
      'stdio',
    );
    expect(payload.subtype).toBe('stdio');
    expect(payload.config).toEqual({
      command: '/usr/local/bin/mcp-server',
      args: ['--config', '/etc/mcp.toml'],
    });
  });

  it('projects notification/slack with channel + bot token', () => {
    const payload = projectConnectionPayload(
      notificationSchemas.slack,
      {
        name: 'team-slack',
        display_name: 'Eng Slack',
        'config.channel_id': 'C123',
        'auth.type': 'bearer',
        'auth.token': 'xoxb-…',
      },
      'notification',
      'slack',
    );
    expect(payload.kind).toBe('notification');
    expect(payload.subtype).toBe('slack');
    expect(payload.config).toEqual({ channel_id: 'C123' });
    expect(payload.auth).toEqual({ type: 'bearer', token: 'xoxb-…' });
  });

  it('drops empty optional fields (oauth2_refresh client_secret left blank)', () => {
    const payload = projectConnectionPayload(
      apiSchema,
      {
        name: 'svc',
        display_name: 'Svc',
        'config.base_url': 'https://svc.example.com',
        'auth.type': 'oauth2_refresh',
        'auth.refresh_token': 'r',
        'auth.client_id': 'cid',
        'auth.client_secret': '', // optional — should be dropped
        'auth.token_endpoint': 'https://svc.example.com/token',
      },
      'api',
      null,
    );
    const auth = payload.auth as { type: 'oauth2_refresh'; client_secret?: string };
    expect(auth.type).toBe('oauth2_refresh');
    expect(auth.client_secret).toBeUndefined();
  });

  it('projects hidden vendor defaults into the rpc payload', () => {
    const schema = resolveConnectionSchema('api', undefined, 'hubspot');
    expect(schema).toBeDefined();
    const payload = projectConnectionPayload(
      schema!,
      {
        name: 'hubspot',
        display_name: 'HubSpot',
        'config.vendor': 'hubspot',
        'config.base_url': HUBSPOT_API_BASE,
        'auth.type': 'oauth2_refresh',
        'auth.client_id': 'cid',
        'auth.client_secret': 'secret',
        'auth.token_endpoint': HUBSPOT_OAUTH_TOKEN_URL,
        'auth.refresh_token': 'refresh',
      },
      'api',
      null,
    );

    expect(payload.config).toEqual({
      vendor: 'hubspot',
      base_url: HUBSPOT_API_BASE,
    });
    expect(payload.auth).toEqual({
      type: 'oauth2_refresh',
      client_id: 'cid',
      client_secret: 'secret',
      token_endpoint: HUBSPOT_OAUTH_TOKEN_URL,
      refresh_token: 'refresh',
    });
  });

  it('detects edit auth patch intent only from credential-bearing auth fields', () => {
    const schema = resolveConnectionSchema('api', undefined, 'hubspot');
    expect(schema).toBeDefined();
    expect(shouldPatchConnectionAuth(schema!, {
      name: 'hubspot',
      display_name: 'HubSpot',
      'config.vendor': 'hubspot',
      'config.base_url': HUBSPOT_API_BASE,
      'auth.type': 'oauth2_refresh',
      'auth.token_endpoint': HUBSPOT_OAUTH_TOKEN_URL,
    })).toBe(false);
    expect(shouldPatchConnectionAuth(schema!, {
      name: 'hubspot',
      display_name: 'HubSpot',
      'config.vendor': 'hubspot',
      'config.base_url': HUBSPOT_API_BASE,
      'auth.type': 'oauth2_refresh',
      'auth.token_endpoint': HUBSPOT_OAUTH_TOKEN_URL,
      'auth.refresh_token': 'refresh',
    })).toBe(true);
  });
});

describe('D-125 P7.2 — view → values flatten', () => {
  it('hydrates name + display_name + flattened config keys, never auth', () => {
    const values = flattenConnectionViewIntoValues({
      name: 'hubspot',
      kind: 'api',
      display_name: 'HubSpot',
      base_url: 'https://api.hubapi.com',
    });
    expect(values.name).toBe('hubspot');
    expect(values.display_name).toBe('HubSpot');
    expect(values['config.base_url']).toBe('https://api.hubapi.com');
    // No auth keys in the projection — `ConnectionView` excludes them
    // by construction; the test asserts the flattener mirrors that.
    expect(values['auth.token']).toBeUndefined();
  });

  it('builds an edit dialog patch that restores vendor schema defaults', () => {
    const patch = buildConnectionEditDialogPatch({
      name: 'salesforce-sandbox',
      kind: 'api',
      display_name: 'Salesforce Sandbox',
      vendor: 'salesforce',
      sandbox: 'sandbox',
      base_url: 'https://mycompany--sandbox.sandbox.my.salesforce.com',
    });

    expect(patch.stage).toBe('form');
    expect(patch.mode).toBe('edit');
    expect(patch.kind).toBe('api');
    expect(patch.vendor).toBe('salesforce');
    expect(patch.editingId).toBe('api/salesforce-sandbox');
    expect(patch.values.name).toBe('salesforce-sandbox');
    expect(patch.values['config.vendor']).toBe('salesforce');
    expect(patch.values['config.sandbox']).toBe('sandbox');
    expect(patch.values['config.base_url']).toBe(
      'https://mycompany--sandbox.sandbox.my.salesforce.com',
    );
    expect(patch.values['auth.type']).toBe('oauth2_refresh');
    expect(patch.values['auth.token_endpoint']).toBe(SALESFORCE_OAUTH_TOKEN_URL_SANDBOX);
    expect(patch.values['auth.refresh_token']).toBeUndefined();
  });
});

describe('CONNECTION_NAME_REGEX', () => {
  it('accepts lowercase + dashes', () => {
    expect(CONNECTION_NAME_REGEX.test('hubspot')).toBe(true);
    expect(CONNECTION_NAME_REGEX.test('hubspot-sandbox-2')).toBe(true);
  });

  it('rejects uppercase / underscores / leading dash', () => {
    expect(CONNECTION_NAME_REGEX.test('HubSpot')).toBe(false);
    expect(CONNECTION_NAME_REGEX.test('-hubspot')).toBe(false);
    expect(CONNECTION_NAME_REGEX.test('hub_spot')).toBe(false);
  });

  it('rejects empty and over-length strings', () => {
    expect(CONNECTION_NAME_REGEX.test('')).toBe(false);
    expect(CONNECTION_NAME_REGEX.test('a'.repeat(49))).toBe(false);
    expect(CONNECTION_NAME_REGEX.test('a'.repeat(48))).toBe(true);
  });
});

describe('payload typing', () => {
  it('ConnectionPayload is exported and shaped right', () => {
    const payload: ConnectionPayload = {
      name: 'x',
      kind: 'api',
      display_name: 'X',
      config: {},
      auth: { type: 'none' },
    };
    expect(payload.name).toBe('x');
  });
});

// ────────────────────────────────────────────────────────────────
// D-129 P1.3 — vendor-picker + OAuth dance affordances
// ────────────────────────────────────────────────────────────────

describe('R13/R14 — kind picker + generic free-edit OAuth', () => {
  const withDialog = (over: Partial<ConnectionsDialogState>): ConnectionsPageState => ({
    ...baseState(),
    dialog: { ...initialConnectionsDialogState(), ...over },
  });

  it('renders the three bare kinds and NO vendor preset cards (R13 — presets retired)', () => {
    const html = renderConnectionsPage(withDialog({ stage: 'kind-picker' }));
    expect(html).toContain('data-kind="api"');
    expect(html).toContain('data-kind="mcp"');
    expect(html).toContain('data-kind="notification"');
    // The vendor preset card grid + its "Generic kinds" header are gone.
    expect(html).not.toContain('Vendor presets');
    expect(html).not.toContain('Generic kinds');
    expect(html).not.toContain('data-action="connections-pick-vendor"');
  });

  it('the generic api oauth2_refresh form surfaces Authorize URL + Scopes + an in-app Authorize button (R14)', () => {
    const html = renderConnectionsPage(
      withDialog({
        stage: 'form',
        kind: 'api',
        values: { 'auth.type': 'oauth2_refresh' },
      }),
    );
    expect(html).toContain('Authorize URL');
    expect(html).toContain('Scopes');
    expect(html).toContain('data-action="connections-authorize-vendor"');
    // Generic flow → no vendor name in the label, and no vendor consent block.
    expect(html).not.toContain('Authorize with');
    expect(html).not.toContain('data-vendor=');
  });

  it('a non-oauth api form shows no Authorize button', () => {
    const html = renderConnectionsPage(
      withDialog({ stage: 'form', kind: 'api', values: { 'auth.type': 'bearer' } }),
    );
    expect(html).not.toContain('data-action="connections-authorize-vendor"');
  });
});

describe('D-129 P1.3 — vendor-flavored form', () => {
  const withDialog = (over: Partial<ConnectionsDialogState>): ConnectionsPageState => ({
    ...baseState(),
    dialog: { ...initialConnectionsDialogState(), ...over },
  });

  const hubspotForm = (over: Partial<ConnectionsDialogState> = {}) =>
    withDialog({
      stage: 'form',
      kind: 'api',
      vendor: 'hubspot',
      values: {
        'config.vendor': 'hubspot',
        'auth.type': 'oauth2_refresh',
      },
      ...over,
    });

  it('resolves to the HubSpot vendor schema (label + description)', () => {
    const html = renderConnectionsPage(hubspotForm());
    // The HubSpot schema's label is "HubSpot" — appears in the form
    // title alongside the "Add" prefix.
    expect(html).toContain('Add HubSpot');
    expect(html).toContain('CRM platform');
  });

  it('renders OAuth Client ID + Client Secret + Refresh Token fields', () => {
    const html = renderConnectionsPage(hubspotForm());
    expect(html).toContain('OAuth Client ID');
    expect(html).toContain('OAuth Client Secret');
    expect(html).toContain('Refresh Token');
  });

  it('does not render locked vendor discriminator or fixed OAuth defaults as editable fields', () => {
    const html = renderConnectionsPage(
      hubspotForm({
        values: {
          'config.vendor': 'hubspot',
          'config.base_url': HUBSPOT_API_BASE,
          'auth.type': 'oauth2_refresh',
          'auth.token_endpoint': HUBSPOT_OAUTH_TOKEN_URL,
        },
      }),
    );
    expect(html).not.toContain('data-conn-field="config.vendor"');
    expect(html).not.toContain('data-conn-field="auth.token_endpoint"');
    expect(html).toContain('data-conn-field="config.base_url"');
    // D-129 Service-Key enrollment — `auth.type` is now a USER CHOICE
    // (bearer Service Key / oauth2_refresh), no longer a locked default, so it
    // renders as an editable select.
    expect(html).toContain('data-conn-field="auth.type"');
  });

  it('shows "Authorize with HubSpot" button when refresh_token is empty', () => {
    const html = renderConnectionsPage(hubspotForm());
    expect(html).toContain('data-action="connections-authorize-vendor"');
    expect(html).toMatch(/Authorize with HubSpot/);
  });

  it('shows "Re-authorize with HubSpot" button when refresh_token already filled', () => {
    const html = renderConnectionsPage(
      hubspotForm({
        values: {
          'config.vendor': 'hubspot',
          'auth.type': 'oauth2_refresh',
          'auth.refresh_token': 'pre-existing-token',
        },
      }),
    );
    expect(html).toContain('Re-authorize with HubSpot');
  });

  it('disables the Authorize button while OAuth is in flight', () => {
    const html = renderConnectionsPage(hubspotForm({ oauthInFlight: true }));
    expect(html).toContain('Authorizing…');
    // Disabled button stays in the DOM — sidebar handler ignores
    // re-clicks via `oauthInFlight` guard, but the visual disable
    // matches the saving pattern.
    expect(html).toMatch(/disabled/);
  });

  it('surfaces granted scopes inline after a successful exchange', () => {
    const html = renderConnectionsPage(
      hubspotForm({
        values: {
          'config.vendor': 'hubspot',
          'auth.type': 'oauth2_refresh',
          'auth.refresh_token': 'fresh-token',
        },
        oauthGrantedScopes: ['crm.objects.deals.read', 'crm.objects.contacts.read', 'oauth'],
      }),
    );
    expect(html).toContain('Granted scopes (3)');
    expect(html).toContain('crm.objects.deals.read');
  });

  it('renders OAuth error inline above the Authorize button', () => {
    const html = renderConnectionsPage(
      hubspotForm({
        oauthError: 'token exchange failed (400): bad code',
      }),
    );
    expect(html).toContain('OAuth: token exchange failed (400): bad code');
  });

  it('Back button on a vendor flow goes back to the kind-picker (no subtype-picker for vendors)', () => {
    const html = renderConnectionsPage(hubspotForm());
    expect(html).toContain('data-action="connections-back-to-kind"');
    expect(html).not.toContain('data-action="connections-back-to-subtype"');
  });

  it('does not render the Authorize block in non-vendor flows', () => {
    const html = renderConnectionsPage(
      withDialog({
        stage: 'form',
        kind: 'api',
        values: { 'auth.type': 'bearer' },
      }),
    );
    expect(html).not.toContain('data-action="connections-authorize-vendor"');
    expect(html).not.toMatch(/Authorize with/);
  });

  it('vendor flow form carries data-vendor on the form root for host wiring', () => {
    const html = renderConnectionsPage(hubspotForm());
    expect(html).toContain('data-vendor="hubspot"');
  });
});

describe('D-129 P1.3 — initial dialog state defaults', () => {
  it('initialConnectionsDialogState carries the vendor + OAuth fields', () => {
    const s = initialConnectionsDialogState();
    expect(s.vendor).toBeNull();
    expect(s.oauthInFlight).toBe(false);
    expect(s.oauthError).toBeNull();
    expect(s.oauthGrantedScopes).toBeNull();
  });
});

describe('D-129 P1.3 — resolveConnectionSchema vendor branch (regression)', () => {
  it('vendor=hubspot returns the HubSpot schema regardless of subtype', () => {
    const schema = resolveConnectionSchema('api', undefined, 'hubspot');
    expect(schema?.label).toBe('HubSpot');
  });

  it('vendor=unknown falls through to bare-kind', () => {
    // 'salesforce' was unregistered through D-129; D-130 added it.
    // Pick a vendor that remains unregistered to keep this assertion
    // meaningful.
    const schema = resolveConnectionSchema('api', undefined, 'unknownvendor');
    expect(schema).toBe(apiSchema);
  });
});
