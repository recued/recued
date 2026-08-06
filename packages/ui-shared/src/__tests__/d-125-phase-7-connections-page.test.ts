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
  OAUTH_CLOUD_CALLBACK_URL,
  SALESFORCE_OAUTH_TOKEN_URL_SANDBOX,
} from '@recued/contracts';
import {
  renderConnectionsPage,
  CONNECTIONS_PAGE_STYLES,
  initialConnectionsPageState,
  initialConnectionsDialogState,
  connectionFormValidationIssue,
  connectionCredentialRegenerationAdminHandoff,
  validateConnectionForm,
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
    expect(html).toContain('role="region" aria-labelledby="connections-embedded-heading"');
    expect(html).toContain(
      '<h2 class="connections-embedded-title" id="connections-embedded-heading">Enrolled connections</h2>',
    );
    expect(CONNECTIONS_PAGE_STYLES).toMatch(
      /\.connections-embedded-title\s*\{[^}]*clip-path:\s*inset\(50%\)/s,
    );
  });

  it('stacks enrolled connection actions on narrow screens', () => {
    expect(CONNECTIONS_PAGE_STYLES).toMatch(
      /@media \(max-width: 560px\)\s*\{\s*\.connections-row\s*\{[^}]*flex-direction:\s*column/s,
    );
    expect(CONNECTIONS_PAGE_STYLES).toMatch(
      /@media \(max-width: 560px\)[\s\S]*?\.connections-row-actions\s*\{[^}]*flex-wrap:\s*wrap/s,
    );
  });

  it('contains long connection and pack identities through removal review', () => {
    expect(CONNECTIONS_PAGE_STYLES).toContain(
      '.connections-page {\n  box-sizing: border-box;\n  min-width: 0;\n  max-width: 100%;',
    );
    expect(CONNECTIONS_PAGE_STYLES).toContain(
      '.connections-row {\n  box-sizing: border-box;\n  min-width: 0;\n  max-width: 100%;',
    );
    expect(CONNECTIONS_PAGE_STYLES).toContain(
      '.connections-row-name {\n  min-width: 0;\n  overflow-wrap: anywhere;',
    );
    expect(CONNECTIONS_PAGE_STYLES).toContain(
      '.connections-row-display {\n  min-width: 0;\n  overflow-wrap: anywhere;',
    );
    expect(CONNECTIONS_PAGE_STYLES).toContain(
      '.connections-pack-usage-item {\n  min-width: 0;\n  overflow-wrap: anywhere;',
    );
    expect(CONNECTIONS_PAGE_STYLES).toContain(
      '.connections-delete-confirm {\n  box-sizing: border-box;\n  min-width: 0;',
    );
    expect(CONNECTIONS_PAGE_STYLES).toContain(
      '.connections-delete-title {\n  min-width: 0;\n  margin: 0 0 8px;\n  overflow-wrap: anywhere;',
    );
    expect(CONNECTIONS_PAGE_STYLES).toMatch(
      /@media \(max-width: 560px\)[\s\S]*?\.connections-row-info\s*\{[^}]*flex-direction:\s*column/s,
    );
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

  it('keeps repeatable credential headers usable on narrow screens', () => {
    expect(CONNECTIONS_PAGE_STYLES).toContain(
      '.connections-header-row {\n  min-width: 0;\n  display: flex;',
    );
    expect(CONNECTIONS_PAGE_STYLES).toContain(
      '.connections-header-row .connections-header-name {\n  box-sizing: border-box; min-width: 0; width: 100%;',
    );
    expect(CONNECTIONS_PAGE_STYLES).toContain(
      '.connections-header-row .connections-header-value {\n  box-sizing: border-box; min-width: 0; width: 100%;',
    );
    expect(CONNECTIONS_PAGE_STYLES).toMatch(
      /@media \(max-width: 520px\)[\s\S]*?\.connections-header-row\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;/s,
    );
    expect(CONNECTIONS_PAGE_STYLES).toContain(
      '.connections-header-row .connections-header-name { grid-column: 1 / -1; }',
    );
  });

  it('subtype-picker for mcp lists three subtypes', () => {
    const html = renderConnectionsPage(
      withDialog({ stage: 'subtype-picker', kind: 'mcp' }),
    );
    for (const choice of CONNECTION_SUBTYPE_CHOICES.mcp) {
      expect(html).toContain(`data-subtype="${choice.subtype}"`);
    }
  });

  it('renders an accessible stale-editor boundary and disables save until latest is reloaded', () => {
    const html = renderConnectionsPage(withDialog({
      stage: 'form',
      mode: 'edit',
      kind: 'api',
      editingId: 'api/shared-api',
      values: {
        name: 'shared-api',
        display_name: 'Shared API',
        'config.base_url': 'https://api.example.com',
        'auth.type': 'bearer',
      },
      externalChange: {
        kind: 'api',
        name: 'shared-api',
        phase: 'changed',
        reloading: false,
        error: null,
      },
    }));

    expect(html).toContain('data-connection-external-change="changed"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Your unsaved entries remain only in this tab');
    expect(html).toContain('data-action="connections-reload-stale-editor"');
    expect(html).toContain('Reload latest');
    expect(html).toMatch(/data-action="connections-submit-form"[^>]*disabled/);
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

  it('turns a disabled save into one explicit first-fix action', () => {
    const blocked = renderConnectionsPage(
      withDialog({
        stage: 'form',
        kind: 'api',
        values: { 'auth.type': 'bearer' },
      }),
    );

    expect(blocked).toContain('data-connection-form-validation');
    expect(blocked).toContain('data-status="blocked"');
    expect(blocked).toContain('role="status"');
    expect(blocked).toContain('aria-live="polite"');
    expect(blocked).toContain('Next: Name');
    expect(blocked).toContain('Name is required.');
    expect(blocked).toContain('data-action="connections-focus-first-invalid"');
    expect(blocked).toContain('data-field-key="name"');
    expect(blocked).toContain('Go to Name');
    expect(blocked).toMatch(/data-action="connections-submit-form"[^>]*disabled/);

    const ready = renderConnectionsPage(
      withDialog({
        stage: 'form',
        kind: 'api',
        values: {
          name: 'my-api',
          display_name: 'My API',
          'config.base_url': 'https://api.example.com',
          'auth.type': 'bearer',
          'auth.token': 'secret-token',
        },
      }),
    );
    expect(ready).toContain('data-status="ready"');
    expect(ready).toContain('Required details complete');
    expect(ready).toContain('Review the values before saving.');
    expect(ready).toMatch(/data-connection-form-validation-action hidden/);
    expect(ready).not.toMatch(/data-action="connections-submit-form"[^>]*disabled/);
  });

  it('replaces local readiness with one exact server-rejection correction', () => {
    const html = renderConnectionsPage(
      withDialog({
        stage: 'form',
        mode: 'edit',
        kind: 'api',
        editingId: 'api/my-api',
        values: {
          name: 'my-api',
          display_name: 'My API',
          'config.base_url': 'https://api.example.com',
          'auth.type': 'bearer',
          'auth.token': 'memory-only-draft',
        },
        credentialCorrection: {
          message: 'The provider rejected the replacement credentials. Your saved connection was not changed.',
          fieldKeys: ['auth.token'],
        },
      }),
    );

    expect(html).toContain('data-connection-credential-correction');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Replacement rejected');
    expect(html).toContain('Review Bearer Token, then verify the replacement again.');
    expect(html).toContain('data-action="connections-focus-credential-correction"');
    expect(html).toContain('data-field-key="auth.token"');
    const tokenInput = html.match(
      /<input[^>]*data-conn-field="auth\.token"[^>]*>/,
    )?.[0];
    expect(tokenInput).toContain('aria-invalid="true"');
    expect(tokenInput).toContain(
      'aria-errormessage="connections-credential-correction-message"',
    );
    expect(html).not.toContain('data-connection-form-validation');
    expect(html).not.toMatch(/data-action="connections-submit-form"[^>]*disabled/);
  });

  it('turns a repeated provider rejection into bounded endpoint and setup actions', () => {
    const html = renderConnectionsPage(
      withDialog({
        stage: 'form',
        mode: 'edit',
        kind: 'api',
        editingId: 'api/my-api',
        values: {
          name: 'my-api',
          display_name: 'My API',
          'config.base_url': 'https://api.example.com',
          'auth.type': 'bearer',
          'auth.token': 'memory-only-draft',
        },
        credentialCorrection: {
          message: 'The provider rejected the replacement credentials. Your saved connection was not changed.',
          fieldKeys: ['auth.token'],
          triage: {
            stage: 'provider_probe',
            endpointFieldKeys: ['config.base_url'],
          },
        },
      }),
    );

    expect(html).toContain('Replacement rejected again');
    expect(html).toContain('data-connection-credential-triage');
    expect(html).toContain('data-stage="provider_probe"');
    expect(html).toContain(
      'configured endpoint check rejected this replacement again',
    );
    expect(html).toContain(
      'credential and endpoint belong to the intended provider account or tenant',
    );
    expect(html).toContain('data-action="connections-focus-credential-triage"');
    expect(html).toContain('data-field-key="config.base_url"');
    expect(html).toContain('>Review Base URL</button>');
    expect(html).toContain('>Check provider setup</button>');
    expect(html).not.toContain('Base URL is wrong');
    expect(CONNECTIONS_PAGE_STYLES).toContain(
      '.connections-credential-correction-action .rx-btn { min-height: 44px; }',
    );
  });

  it('turns a third rejection into a safe regeneration or administrator handoff', () => {
    const state = withDialog({
      stage: 'form',
      mode: 'edit',
      kind: 'api',
      editingId: 'api/my-api',
      values: {
        name: 'my-api',
        display_name: 'My API',
        'config.base_url': 'https://private-api.example.com',
        'auth.type': 'bearer',
        'auth.token': 'memory-only-secret',
      },
      credentialCorrection: {
        message: 'The provider rejected another replacement.',
        fieldKeys: ['auth.token'],
        triage: {
          stage: 'provider_probe',
          endpointFieldKeys: ['config.base_url'],
          resolution: 'regenerate_credential_or_contact_admin',
        },
      },
    });
    const html = renderConnectionsPage(state);

    expect(html).toContain('data-credential-safe-stop="true"');
    expect(html).toContain('Pause before retrying');
    expect(html).toContain('Do not resend this replacement unchanged');
    expect(html).toContain('>Create or rotate credential</button>');
    expect(html).toContain('>Enter fresh Bearer Token</button>');
    expect(html).toContain('>Provider/admin confirmed a fix</button>');
    expect(html).toContain('Safe details for the provider administrator');
    expect(html).toContain('Nothing is sent automatically');
    expect(html).toContain('data-credential-admin-handoff-summary');
    expect(html).toContain('>Copy safe handoff</button>');
    expect(html).toMatch(
      /data-action="connections-submit-form"[^>]*disabled/,
    );
    expect(CONNECTIONS_PAGE_STYLES).toContain(
      '.connections-credential-admin-handoff > summary',
    );
    expect(CONNECTIONS_PAGE_STYLES).toContain('min-height: 44px');

    const handoff = connectionCredentialRegenerationAdminHandoff(
      state.dialog,
      apiSchema,
    );
    expect(handoff).toContain('Connection: api/my-api');
    expect(handoff).toContain('Sign-in method: Bearer token');
    expect(handoff).toContain('Server-observed step: configured provider endpoint check');
    expect(handoff).toContain('Non-secret fields to review: Base URL');
    expect(handoff).toContain('saved credential was not changed');
    expect(handoff).not.toContain('memory-only-secret');
    expect(handoff).not.toContain('https://private-api.example.com');
    expect(handoff).not.toContain('The provider rejected another replacement.');

    state.dialog.values['auth.token'] = '';
    const withoutDraft = renderConnectionsPage(state);
    expect(withoutDraft).toContain('No rejected credential was restored');
    expect(withoutDraft).toContain('Provider/admin confirmed a fix');
    expect(withoutDraft).toMatch(
      /data-action="connections-submit-form"[^>]*disabled/,
    );

    state.dialog.editingId = 'api/another-connection';
    expect(connectionCredentialRegenerationAdminHandoff(
      state.dialog,
      apiSchema,
    )).toBeNull();
  });

  it('makes server-authoritative safe-stop closure explicit without rendering its token', () => {
    const state = withDialog({
      stage: 'form',
      mode: 'edit',
      kind: 'api',
      editingId: 'api/my-api',
      values: {
        name: 'my-api',
        display_name: 'My API',
        'config.base_url': 'https://api.example.com',
        'auth.type': 'bearer',
        'auth.token': 'memory-only-secret',
      },
      credentialCorrection: {
        message: 'The provider rejected another replacement.',
        fieldKeys: ['auth.token'],
        triage: {
          stage: 'provider_probe',
          endpointFieldKeys: ['config.base_url'],
          resolution: 'regenerate_credential_or_contact_admin',
        },
        safeStopClosure: { phase: 'checking', error: null },
      },
    });

    const checking = renderConnectionsPage(state);
    expect(checking).toContain('Checking server support…');
    expect(checking).toContain('data-credential-safe-stop-closure-status="checking"');
    expect(checking).toMatch(
      /data-action="connections-confirm-credential-handoff"[^>]*disabled/,
    );

    state.dialog.credentialCorrection!.safeStopClosure = {
      phase: 'ready',
      error: null,
    };
    const ready = renderConnectionsPage(state);
    expect(ready).toContain('Provider/admin confirmed a fix');
    expect(ready).toContain(
      'ask the paired server to record this fix before closing the recovery stop',
    );
    expect(ready).not.toMatch(
      /data-action="connections-confirm-credential-handoff"[^>]*disabled/,
    );

    state.dialog.credentialCorrection = null;
    state.dialog.credentialSafeStopClosureNotice = {
      kind: 'api',
      name: 'my-api',
      nextStep: 'verify_replacement',
    };
    const closed = renderConnectionsPage(state);
    expect(closed).toContain('Recovery stop closed');
    expect(closed).toContain('acknowledgement did not send or replace a credential');
    const closureNotice = closed.match(
      /<section class="connections-credential-rotation"[\s\S]*?data-credential-safe-stop-closure="confirmed"[\s\S]*?<\/section>/,
    )?.[0] ?? '';
    expect(closureNotice).not.toContain('memory-only-secret');
    expect(closed).not.toMatch(/[a-f0-9]{64}/);
    expect(CONNECTIONS_PAGE_STYLES).toContain(
      '.connections-credential-rotation[data-credential-safe-stop-closure] .rx-btn',
    );
  });

  it('distinguishes a repeated OAuth exchange rejection from a provider probe', () => {
    const html = renderConnectionsPage(
      withDialog({
        stage: 'form',
        mode: 'edit',
        kind: 'api',
        editingId: 'api/oauth-api',
        values: {
          name: 'oauth-api',
          display_name: 'OAuth API',
          'config.base_url': 'https://api.example.com',
          'auth.type': 'oauth2_refresh',
          'auth.refresh_token': 'memory-only-refresh',
          'auth.client_id': 'client-id',
          'auth.token_endpoint': 'https://oauth.example.com/token',
        },
        credentialCorrection: {
          message: 'The provider rejected the replacement credentials.',
          fieldKeys: [
            'auth.refresh_token',
            'auth.client_id',
            'auth.client_secret',
            'auth.token_endpoint',
          ],
          triage: {
            stage: 'credential_exchange',
            endpointFieldKeys: ['auth.token_endpoint'],
          },
        },
      }),
    );

    expect(html).toContain('data-stage="credential_exchange"');
    expect(html).toContain('another rejection during credential exchange');
    expect(html).toContain('credential details and exchange endpoint');
    expect(html).toContain('>Review Token Endpoint</button>');
    expect(html).not.toContain('configured provider check');
  });

  it('does not invent an endpoint action when the live schema has none', () => {
    const html = renderConnectionsPage(
      withDialog({
        stage: 'form',
        mode: 'edit',
        kind: 'notification',
        subtype: 'slack',
        editingId: 'notification/slack-alerts',
        values: {
          name: 'slack-alerts',
          display_name: 'Slack alerts',
          'auth.type': 'bearer',
          'auth.token': 'memory-only-token',
        },
        credentialCorrection: {
          message: 'The provider rejected the replacement credentials.',
          fieldKeys: ['auth.token'],
          triage: {
            stage: 'provider_probe',
            endpointFieldKeys: [],
          },
        },
      }),
    );

    expect(html).toContain(
      'configured provider check rejected this replacement again',
    );
    expect(html).toContain('intended provider account, tenant, or workspace');
    expect(html).not.toContain('connection endpoint is correct');
    expect(html).not.toContain('connections-focus-credential-triage');
    expect(html).not.toContain('Check provider setup');
  });

  it('keeps a newly blocking local fix visible beside an authoritative rejection', () => {
    const html = renderConnectionsPage(
      withDialog({
        stage: 'form',
        mode: 'edit',
        kind: 'api',
        editingId: 'api/my-api',
        values: {
          name: 'my-api',
          display_name: '',
          'config.base_url': 'https://api.example.com',
          'auth.type': 'bearer',
          'auth.token': 'memory-only-draft',
        },
        credentialCorrection: {
          message: 'The provider rejected the replacement credentials. Your saved connection was not changed.',
          fieldKeys: ['auth.token'],
        },
      }),
    );

    expect(html).toContain('data-connection-credential-correction');
    expect(html).toContain('Replacement rejected');
    expect(html).toContain('data-connection-form-validation');
    expect(html).toContain('data-status="blocked"');
    expect(html).toContain('role="group"');
    expect(html).not.toContain('aria-live="polite"');
    expect(html).toContain('Next: Display name');
    expect(html).toContain('Display name is required.');
    expect(html).toContain('data-field-key="display_name"');
    expect(html).toMatch(/data-action="connections-submit-form"[^>]*disabled/);
  });

  it('names the whole rejected compound credential without blaming one value', () => {
    const html = renderConnectionsPage(
      withDialog({
        stage: 'form',
        mode: 'edit',
        kind: 'api',
        editingId: 'api/basic-api',
        values: {
          name: 'basic-api',
          display_name: 'Basic API',
          'config.base_url': 'https://api.example.com',
          'auth.type': 'basic',
          'auth.username': 'owner',
          'auth.password': 'memory-only-draft',
        },
        credentialCorrection: {
          message: 'The provider rejected the replacement credentials.',
          fieldKeys: ['auth.username', 'auth.password'],
        },
      }),
    );

    expect(html).toContain(
      'Review this credential set together: Username, Password. Start with Username, then verify again.',
    );
    expect(html).toContain('>Review Username</button>');
    expect(html).not.toContain('Username is wrong');
  });

  it('associates a rejected repeatable credential with its exact field group', () => {
    const html = renderConnectionsPage(
      withDialog({
        stage: 'form',
        mode: 'edit',
        kind: 'api',
        editingId: 'api/header-api',
        values: {
          name: 'header-api',
          display_name: 'Header API',
          'config.base_url': 'https://api.example.com',
          'auth.type': 'header',
          'auth.headers.0.header_name': 'X-API-Key',
          'auth.headers.0.value': 'memory-only-draft',
        },
        credentialCorrection: {
          message: 'The provider rejected the replacement credentials.',
          fieldKeys: ['auth.headers'],
        },
      }),
    );

    expect(html).toContain(
      'data-field-key="auth.headers" data-credential-rejected="true" role="group"',
    );
    expect(html).toContain('aria-describedby="connections-credential-correction-message"');
    expect(html.match(/aria-invalid="true"/g)).toHaveLength(2);
    expect(html).toContain('>Review Headers</button>');
  });

  it('identifies the exact missing control inside repeatable credentials', () => {
    const issue = connectionFormValidationIssue(
      apiSchema,
      {
        name: 'custom-api',
        display_name: 'Custom API',
        'config.base_url': 'https://api.example.com',
        'auth.type': 'header',
        'auth.headers.0.header_name': 'X-API-Key',
        'auth.headers.0.value': '',
      },
      undefined,
      'create',
    );

    expect(issue).toEqual({
      fieldKey: 'auth.headers.0.value',
      fieldLabel: 'Headers',
      message: 'Headers: each header needs both a name and a value.',
    });

    const invalidTrigger = connectionFormValidationIssue(
      notificationSchemas.slack,
      {
        name: 'team-slack',
        display_name: 'Team Slack',
        'config.channel_id': 'C0123456789',
        'auth.type': 'bearer',
        'auth.token': 'xoxb-token',
        'config.match_patterns.3.kind': 'tag',
        'config.match_patterns.3.value': 'two words',
      },
      undefined,
      'create',
    );
    expect(invalidTrigger).toMatchObject({
      fieldKey: 'config.match_patterns.3.value',
      fieldLabel: 'Message triggers',
    });
  });

  it('lets a higher-priority server error own the live announcement', () => {
    const html = renderConnectionsPage(
      withDialog({
        stage: 'form',
        kind: 'api',
        error: 'The paired server rejected this connection.',
        values: {
          name: 'my-api',
          display_name: 'My API',
          'config.base_url': 'https://api.example.com',
          'auth.type': 'bearer',
          'auth.token': 'secret-token',
        },
      }),
    );

    expect(html).toContain('The paired server rejected this connection.');
    const validationPanel = html.match(
      /<section[^>]*data-connection-form-validation[^>]*>/u,
    )?.[0];
    expect(validationPanel).toContain('role="group"');
    expect(validationPanel).not.toContain('aria-live="polite"');
  });

  it('switching auth.type to oauth2_refresh swaps in OAuth fields', () => {
    const html = renderConnectionsPage(
      withDialog({
        stage: 'form',
        kind: 'api',
        values: { name: 'acme', display_name: 'Acme', 'auth.type': 'oauth2_refresh' },
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

  it.each([
    {
      subtype: 'slack',
      mode: 'socket',
      guide: 'slack-socket',
      title: 'Connect Slack from this machine',
      option: 'Local — Socket Mode (recommended)',
      portal: 'Open Slack app settings',
      localField: 'auth.app_token',
    },
    {
      subtype: 'telegram',
      mode: 'poll',
      guide: 'telegram-poll',
      title: 'Connect Telegram from this machine',
      option: 'Local — long polling (recommended)',
      portal: 'Open BotFather',
      localField: 'config.match_patterns',
    },
    {
      subtype: 'discord',
      mode: 'socket',
      guide: 'discord-gateway',
      title: 'Connect Discord from this machine',
      option: 'Local — Gateway (recommended)',
      portal: 'Open Discord Developer Portal',
      localField: 'config.match_patterns',
    },
  ] as const)(
    'puts the recommended $subtype setup path before its credentials',
    ({ subtype, mode, guide, title, option, portal, localField }) => {
      const html = renderConnectionsPage(withDialog({
        stage: 'form',
        kind: 'notification',
        subtype,
        values: {
          'config.ingress_mode': mode,
          'auth.type': 'bearer',
        },
      }));

      expect(html).toContain('data-connection-onboarding-selector');
      expect(html).toContain(`data-connection-onboarding="${guide}"`);
      expect(html).toContain('data-tone="recommended"');
      expect(html).toContain(title);
      expect(html).toContain(`<option value="${mode}" selected>${option}</option>`);
      expect(html).toContain(`${portal} (new tab) <span aria-hidden="true">↗</span>`);
      expect(html).toContain('target="_blank" rel="noopener noreferrer"');
      expect(html).toContain('What Save and probe checks:');
      expect(html).toContain('read status');
      expect(html).toContain(`data-field-key="${localField}"`);
      expect(html).not.toContain('data-field-key="auth.type"');

      const selectorAt = html.indexOf('data-connection-onboarding-selector');
      const guideAt = html.indexOf(`data-connection-onboarding="${guide}"`);
      const credentialsAt = html.indexOf('data-field-key="display_name"');
      expect(selectorAt).toBeGreaterThan(-1);
      expect(guideAt).toBeGreaterThan(selectorAt);
      expect(credentialsAt).toBeGreaterThan(guideAt);
    },
  );

  it.each([
    {
      subtype: 'slack',
      guide: 'slack-webhook',
      localGuide: 'slack-socket',
      requiredField: 'config.signing_secret',
      hiddenField: 'auth.app_token',
      endpoint: '/webhooks/slack/slack',
    },
    {
      subtype: 'telegram',
      guide: 'telegram-webhook',
      localGuide: 'telegram-poll',
      requiredField: 'config.webhook_secret',
      hiddenField: null,
      endpoint: '/webhooks/telegram/telegram',
    },
    {
      subtype: 'discord',
      guide: 'discord-webhook',
      localGuide: 'discord-gateway',
      requiredField: 'config.public_key',
      hiddenField: 'config.match_patterns',
      endpoint: '/webhooks/discord/discord',
    },
  ] as const)(
    'switches $subtype to an honest advanced-webhook checklist',
    ({ subtype, guide, localGuide, requiredField, hiddenField, endpoint }) => {
      const html = renderConnectionsPage(withDialog({
        stage: 'form',
        kind: 'notification',
        subtype,
        values: {
          'config.ingress_mode': 'webhook',
          'auth.type': 'bearer',
        },
      }));

      expect(html).toContain(`data-connection-onboarding="${guide}"`);
      expect(html).toContain('data-tone="advanced"');
      expect(html).not.toContain(`data-connection-onboarding="${localGuide}"`);
      expect(html).toContain('Public webhook');
      expect(html).toContain(`&lt;public-host&gt;${endpoint}`);
      expect(html).toContain(`data-field-key="${requiredField}"`);
      if (hiddenField !== null) {
        expect(html).not.toContain(`data-field-key="${hiddenField}"`);
      }
      expect(html).toContain('does not test');
    },
  );

  it('keeps edit mode compact while retaining the friendly mode labels', () => {
    const html = renderConnectionsPage(withDialog({
      stage: 'form',
      mode: 'edit',
      kind: 'notification',
      subtype: 'slack',
      editingId: 'notification/slack',
      values: {
        name: 'slack',
        display_name: 'Slack',
        'config.ingress_mode': 'socket',
        'config.channel_id': 'C123',
        'auth.type': 'bearer',
      },
    }));

    expect(html).not.toContain('data-connection-onboarding-selector');
    expect(html).not.toContain('data-connection-onboarding=');
    expect(html).toContain('data-field-key="config.ingress_mode"');
    expect(html).toContain('Local — Socket Mode (recommended)');
    expect(html).toContain('Checks Slack bot identity');
    expect(html).not.toContain('data-field-key="auth.type"');
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
    expect(html).toContain('Current credentials stay active');
    expect(html).toContain('Leave credential fields blank to keep');
  });

  it('makes a started credential rotation explicit before submit', () => {
    const html = renderConnectionsPage(
      withDialog({
        stage: 'form',
        mode: 'edit',
        kind: 'api',
        values: {
          name: 'hubspot',
          display_name: 'HubSpot',
          'config.base_url': 'https://api.hubapi.com',
          'auth.type': 'bearer',
          'auth.token': 'replacement',
        },
      }),
    );
    expect(html).toContain('data-credential-rotation="replacement"');
    expect(html).toContain('Replacement ready to verify');
    expect(html).toContain('If verification fails, nothing in this connection changes');
    expect(html).toContain('Verify and replace');
    expect(html).not.toContain('Save changes');
  });

  it('renders a secret-free, accessible credential verification receipt', () => {
    const state = baseState();
    state.dialog.recentProbe = {
      kind: 'api',
      name: 'hubspot',
      status: 'verified',
      purpose: 'credential_rotation',
      verified_at: Date.UTC(2024, 4, 5, 12, 30),
      auth_type: 'oauth2_refresh',
      access_expires_at: Date.UTC(2024, 4, 5, 13, 30),
    };
    const html = renderConnectionsPage(state);
    expect(html).toContain('data-connection-credential-receipt="verified"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('OAuth refresh credential verified and now active for api/hubspot');
    expect(html).toContain('Verified 2024-05-05 12:30 UTC');
    expect(html).toContain('Access token valid until 2024-05-05 13:30 UTC');
    expect(html).toContain('Future provider calls use the replacement');
  });

  it('renders authoritative post-ack resolution, correction, and retry states with one next action', () => {
    const state = baseState();
    state.dialog.recentProbe = {
      kind: 'api',
      name: 'hubspot',
      status: 'ok',
      purpose: 'post_safe_stop',
      resolution: 'resolved',
      checked_at: Date.UTC(2024, 4, 5, 12, 30),
    };
    const resolved = renderConnectionsPage({
      ...state,
      postSafeStopProfileLabel: 'Home NAS',
    });
    expect(resolved).toContain('data-post-safe-stop-verification="resolved"');
    expect(resolved).toContain('Recovery verified');
    expect(resolved).toContain('provider accepted it');
    expect(resolved).toContain('no credential was changed or replayed');
    expect(resolved).toContain('Server profile: Home NAS');
    expect(resolved).not.toContain('connections-recheck-post-safe-stop');
    expect(resolved).not.toContain('connections-review-post-safe-stop');

    state.dialog.recentProbe = {
      kind: 'api',
      name: 'hubspot',
      status: 'auth_failed',
      purpose: 'post_safe_stop',
      resolution: 'reopen',
      credential_correction: {
        auth_type: 'bearer',
        field_keys: ['auth.token'],
      },
    };
    const reopened = renderConnectionsPage(state);
    expect(reopened).toContain('data-post-safe-stop-verification="reopen"');
    expect(reopened).toContain('Saved credential still needs attention');
    expect(reopened).toContain('data-action="connections-review-post-safe-stop"');
    expect(reopened).toContain('Review saved credential');
    expect(reopened).not.toContain('auth.token');

    state.dialog.recentProbe = {
      kind: 'api',
      name: 'hubspot',
      status: 'unreachable',
      purpose: 'post_safe_stop',
      resolution: 'retry',
    };
    const retry = renderConnectionsPage(state);
    expect(retry).toContain('Provider could not be reached');
    expect(retry).toContain('does not prove the saved credential is wrong');
    expect(retry).toContain('data-action="connections-recheck-post-safe-stop"');
    expect(retry).toContain('Check again');
    expect(retry).toContain('role="status"');
    expect(retry).toContain('aria-live="polite"');

    state.dialog.recentProbe = {
      kind: 'api',
      name: 'hubspot',
      status: 'ok',
      purpose: 'post_safe_stop',
      resolution: 'unsupported',
    };
    const unsupported = renderConnectionsPage(state);
    expect(unsupported).toContain('Server update needed for an exact check');
    expect(unsupported).toContain('cannot prove which saved version it checked');
    expect(unsupported).toContain('Check after update');
  });

  it('renders a responsive, escaped profile-bound recovery handoff without selecting current-server work', () => {
    const state = baseState({
      postSafeStopRecoveries: [{
        kind: 'api',
        name: 'same-name',
        status: 'pending',
        acknowledgedAt: Date.UTC(2024, 4, 5, 12, 30),
      }],
    });
    const html = renderConnectionsPage({
      ...state,
      postSafeStopProfileHandoff: {
        reason: 'profile_mismatch',
        activeProfileLabel: 'Office <server>',
        sourceProfileLabel: 'Home & NAS',
        serverProfilesAvailable: true,
      },
    });

    expect(html).toContain(
      'data-post-safe-stop-profile-handoff="profile_mismatch"',
    );
    expect(html).toContain('This recovery belongs to another server');
    expect(html).toContain('Home &amp; NAS');
    expect(html).toContain('Office &lt;server&gt;');
    expect(html).not.toContain('Office <server>');
    expect(html).toContain('data-action="connections-open-post-safe-stop-profile"');
    expect(html).toContain('data-action="connections-review-active-post-safe-stop"');
    expect(html).toContain('data-action="connections-dismiss-post-safe-stop-profile"');
    expect(html).not.toContain('data-post-safe-stop-verification=');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(CONNECTIONS_PAGE_STYLES).toContain(
      '.connections-post-safe-stop-profile-actions',
    );
    expect(CONNECTIONS_PAGE_STYLES).toContain('flex-wrap: wrap');
    expect(CONNECTIONS_PAGE_STYLES).toContain('min-height: 44px');
  });

  it('gives an unbound legacy recovery a useful stop without dead actions', () => {
    const html = renderConnectionsPage({
      ...baseState({ connections: [] }),
      postSafeStopProfileHandoff: {
        reason: 'unbound',
        activeProfileLabel: 'Current server',
        serverProfilesAvailable: false,
      },
    });

    expect(html).toContain('This recovery link needs a server check');
    expect(html).toContain('older or incomplete link');
    expect(html).toContain('You are using Current server');
    expect(html).toContain('connections-dismiss-post-safe-stop-profile');
    expect(html).not.toContain('connections-open-post-safe-stop-profile');
    expect(html).not.toContain('connections-review-active-post-safe-stop');
  });

  it('does not offer to replace an open editor with current-profile recovery', () => {
    const state = baseState({
      postSafeStopRecoveries: [{
        kind: 'api',
        name: 'same-name',
        status: 'pending',
        acknowledgedAt: Date.UTC(2024, 4, 5, 12, 30),
      }],
    });
    state.dialog.stage = 'form';
    state.dialog.kind = 'api';
    state.dialog.values.name = 'another-connection';

    const html = renderConnectionsPage({
      ...state,
      postSafeStopProfileHandoff: {
        reason: 'profile_mismatch',
        activeProfileLabel: 'Office server',
        sourceProfileLabel: 'Home server',
        serverProfilesAvailable: true,
      },
    });

    expect(html).toContain('This recovery belongs to another server');
    expect(html).not.toContain('connections-review-active-post-safe-stop');
    expect(html).toContain('connections-open-post-safe-stop-profile');
    expect(html).toContain('connections-dismiss-post-safe-stop-profile');
  });

  it('renders an interrupted rotation as an explicit no-retry recovery step', () => {
    const state = baseState();
    state.credentialRotationRecovery = {
      kind: 'api',
      name: 'hubspot',
      phase: 'pending',
    };
    const html = renderConnectionsPage(state);
    expect(html).toContain('data-connection-credential-recovery="pending"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Do not retry while this outcome is pending');
    expect(html).toContain('data-action="connections-check-credential-rotation"');
    expect(html).not.toContain('attempt_id');
  });

  it('renders server-authoritative post-update evidence without looping back to generic update copy', () => {
    const state = baseState();
    state.credentialRotationRecovery = {
      kind: 'api',
      name: 'hubspot',
      phase: 'restart_unsupported',
      returnedFromServerUpdate: true,
      serverUpdateTriage: {
        reason: 'update_still_available',
        checkStatus: 'update-available',
        baselineVersion: '26.7.3',
        currentVersion: '26.8.0',
        channel: 'stable',
        availableVersion: '26.9.0',
      },
    };
    const html = renderConnectionsPage({
      ...state,
      credentialRotationServerUpdateGuideAvailable: true,
    });
    expect(html).toContain('moved from version 26.7.3 to 26.8.0');
    expect(html).toContain('still offers version 26.9.0');
    expect(html).toContain('An update landed');
    expect(html).toContain(
      'Server evidence: running 26.8.0 · stable channel · update check update available · before update 26.7.3.',
    );
    expect(html).toContain('Continue server update');
    expect(html).toContain('Check again');
    expect(html).not.toContain('The update may not have finished');
    expect(html).not.toContain('replacement-token');
    expect(html).not.toContain('server_url');
  });

  it('turns release-integrity evidence into a stop-and-correct action', () => {
    const state = baseState();
    state.credentialRotationRecovery = {
      kind: 'api',
      name: 'hubspot',
      phase: 'restart_unsupported',
      returnedFromServerUpdate: true,
      serverUpdateTriage: {
        reason: 'release_check_inconclusive',
        checkStatus: 'bad-signature',
        baselineVersion: '26.7.3',
        currentVersion: '26.7.3',
        channel: 'stable',
      },
    };

    const html = renderConnectionsPage({
      ...state,
      credentialRotationServerUpdateGuideAvailable: true,
    });
    expect(html).toContain('rejected the release manifest signature');
    expect(html).toContain('Do not apply from that feed');
    expect(html).toContain('update check bad signature');
    expect(html).not.toContain('Restart or redeploy the actual server');
  });

  it('renders freshly confirmed capability as an explicit same-tab continuation without opening a form', () => {
    const state = baseState();
    state.credentialRotationRecovery = {
      kind: 'api',
      name: 'hubspot',
      phase: 'restart_resolved',
      returnedFromServerUpdate: true,
      baselineUpdatedAt: 100,
    };

    const html = renderConnectionsPage(state);

    expect(html).toContain(
      'data-connection-credential-recovery="restart_resolved"',
    );
    expect(html).toContain(
      'A fresh, read-only check confirmed that this server can safely check a credential replacement for api/hubspot',
    );
    expect(html).toContain('You stayed on this page');
    expect(html).toContain('Continue in this tab');
    expect(html).toContain(
      'data-action="connections-start-fresh-credential-rotation"',
    );
    expect(html).toContain('data-action="connections-dismiss-credential-rotation"');
    expect(html).not.toContain('replacement-token');
    expect(html).not.toContain('server_url');
  });

  it('renders an interrupted untouched editor as a target-only resume without receipt replay', () => {
    const state = baseState();
    state.credentialRotationRecovery = {
      kind: 'api',
      name: 'hubspot',
      phase: 'editor_ready',
      returnedFromServerUpdate: true,
    };

    const interrupted = renderConnectionsPage(state);
    expect(interrupted).toContain(
      'data-connection-credential-recovery="editor_ready"',
    );
    expect(interrupted).toContain(
      'clean credential editor for api/hubspot closed before any field changed',
    );
    expect(interrupted).toContain('Resume clean editor');
    expect(interrupted).toContain(
      'No field value, credential, or server-recovery receipt will be restored',
    );
    expect(interrupted).not.toContain('Recovery finished');
    expect(interrupted).not.toContain('replacement-token');

    state.dialog = {
      ...state.dialog,
      stage: 'form',
      mode: 'edit',
      kind: 'api',
      editingId: 'api/hubspot',
      values: {
        name: 'hubspot',
        'auth.type': 'bearer',
      },
    };
    const reopened = renderConnectionsPage(state);
    expect(reopened).toContain(
      'read-only safety check finished and the clean credential editor',
    );
    expect(reopened).toContain('No field value or credential was restored');
    expect(reopened).not.toContain('Resume clean editor');
  });

  it('renders server-change progress as a busy passive state with no retry action', () => {
    const state = baseState();
    state.credentialRotationRecovery = {
      kind: 'api',
      name: 'hubspot',
      phase: 'restart_unsupported',
      returnedFromServerUpdate: true,
      serverUpdateProgress: {
        phase: 'applying',
        operation: 'update',
        startedAt: 100,
      },
    };

    const applying = renderConnectionsPage({
      ...state,
      credentialRotationServerUpdateGuideAvailable: true,
    });
    expect(applying).toContain('aria-busy="true"');
    expect(applying).toContain(
      'An open Recued tab is applying the server update',
    );
    expect(applying).toContain('wait instead of sending a duplicate action');
    expect(applying).toContain(
      'opaque ID for the selected server profile',
    );
    expect(applying).not.toContain(
      'data-action="connections-start-fresh-credential-rotation"',
    );
    expect(applying).not.toContain(
      'data-action="connections-review-server-update"',
    );
    expect(applying).not.toContain('replacement-token');
    expect(applying).not.toContain('server_url');

    state.credentialRotationRecovery.serverUpdateProgress = {
      phase: 'awaiting_reconnect',
      operation: 'rollback',
      startedAt: 100,
      operationId: 'server-ledger-receipt',
    };
    const waiting = renderConnectionsPage(state);
    expect(waiting).toContain('server accepted the rollback');
    expect(waiting).toContain('verifies the exact opaque receipt');
    expect(waiting).not.toContain('server-ledger-receipt');
    expect(waiting).not.toContain(
      'data-action="connections-start-fresh-credential-rotation"',
    );

    state.credentialRotationRecovery.serverUpdateVerification = {
      phase: 'unknown',
      operation: 'rollback',
      startedAt: 100,
      reason: 'unknown_receipt',
    };
    const unknown = renderConnectionsPage(state);
    expect(unknown).toContain('aria-busy="false"');
    expect(unknown).toContain('did not recognize this rollback receipt');
    expect(unknown).toContain('all server controls remain paused');
    expect(unknown).toContain('privacy-safe diagnostic');
    expect(unknown).not.toContain('server-ledger-receipt');

    state.credentialRotationRecovery.serverUpdateVerification = {
      phase: 'closed',
      operation: 'rollback',
      startedAt: 100,
      reason: 'server_closed_unresolved',
    };
    const closed = renderConnectionsPage(state);
    expect(closed).toContain('aria-busy="false"');
    expect(closed).toContain('durably closed this receipt as unresolved');
    expect(closed).toContain('without claiming the rollback succeeded or failed');
    expect(closed).toContain(
      'Confirm its current version, release posture, and api/hubspot activity',
    );
    expect(closed).not.toContain('server-ledger-receipt');

    state.credentialRotationRecovery.serverUpdateVerification = {
      phase: 'checking_baseline',
      operation: 'rollback',
      startedAt: 100,
      reason: 'server_closed_unresolved',
    };
    const checkingBaseline = renderConnectionsPage(state);
    expect(checkingBaseline).toContain('aria-busy="true"');
    expect(checkingBaseline).toContain(
      'freshly reading the selected server’s running version',
    );
    expect(checkingBaseline).toContain('original rollback outcome remains unknown');

    state.credentialRotationRecovery.serverUpdateVerification = {
      phase: 'baseline_confirmed',
      operation: 'rollback',
      startedAt: 100,
      reason: 'server_closed_unresolved',
      baseline: {
        currentVersion: '26.8.1',
        channel: 'stable',
        updateStatus: 'up-to-date',
        affectedConnection: {
          kind: 'api',
          name: 'hubspot',
          activity: 'idle',
        },
      },
    };
    const confirmedBaseline = renderConnectionsPage(state);
    expect(confirmedBaseline).toContain('aria-busy="false"');
    expect(confirmedBaseline).toContain(
      'Current state confirmed: running 26.8.1 on the stable channel',
    );
    expect(confirmedBaseline).toContain(
      'the release feed reports this version is current',
    );
    expect(confirmedBaseline).toContain(
      'api/hubspot has no credential verification pending',
    );
    expect(confirmedBaseline).toContain(
      'original rollback outcome remains unknown',
    );
    expect(confirmedBaseline).not.toContain('server-ledger-receipt');

    state.credentialRotationRecovery.serverUpdateVerification = {
      ...state.credentialRotationRecovery.serverUpdateVerification,
      reason: 'finish_unavailable',
    };
    const finishRetry = renderConnectionsPage(state);
    expect(finishRetry).toContain(
      'exact browser latch could not be retired',
    );
    expect(finishRetry).toContain('retry Finish recovery');
    expect(finishRetry).toContain('No server action will repeat');

    state.credentialRotationRecovery = {
      kind: 'api',
      name: 'hubspot',
      phase: 'restart_ready',
      baselineUpdatedAt: 100,
      returnedFromServerUpdate: true,
      serverUpdateVerification: {
        phase: 'completed',
        operation: 'rollback',
        startedAt: 100,
        reason: 'server_closed_unresolved',
        baseline: {
          currentVersion: '26.8.1',
          channel: 'stable',
          updateStatus: 'up-to-date',
          affectedConnection: {
            kind: 'api',
            name: 'hubspot',
            activity: 'idle',
          },
        },
      },
    };
    const completed = renderConnectionsPage(state);
    expect(completed).toContain(
      'Server recovery is finished and server-change controls are unlocked',
    );
    expect(completed).toContain(
      'confirmed running 26.8.1 on the stable channel',
    );
    expect(completed).toContain(
      'original rollback outcome remains unknown',
    );
    expect(completed).toContain('Start fresh');
    expect(completed).not.toContain('server-ledger-receipt');
  });

  it('lands a terminal recovery failure on the exact connection review', () => {
    const state = baseState();
    state.credentialRotationRecovery = {
      kind: 'api',
      name: 'hubspot',
      phase: 'failed',
      failureReason: 'auth_failed',
      correction: {
        auth_type: 'bearer',
        field_keys: ['auth.token'],
      },
    };
    const html = renderConnectionsPage(state);
    expect(html).toContain('saved credential was preserved');
    expect(html).toContain('data-action="connections-review-credential-rotation"');
    expect(html).toContain('data-kind="api"');
    expect(html).toContain('data-name="hubspot"');
    expect(html).toContain('Correct replacement');
    expect(html).toContain(
      'aria-label="Correct the rejected credential replacement for api/hubspot"',
    );
  });

  it('names a recovered repeated rejection as a resolution handoff', () => {
    const state = baseState();
    state.credentialRotationRecovery = {
      kind: 'api',
      name: 'hubspot',
      phase: 'failed',
      failureReason: 'auth_failed',
      correction: {
        auth_type: 'bearer',
        field_keys: ['auth.token'],
        triage: {
          reason: 'repeated_auth_rejection',
          stage: 'provider_probe',
          endpoint_field_keys: ['config.base_url', 'config.endpoint'],
        },
      },
    };

    const html = renderConnectionsPage(state);
    expect(html).toContain('Resolve repeated rejection');
    expect(html).toContain(
      'aria-label="Resolve the repeated credential rejection for api/hubspot"',
    );
    expect(html).not.toContain('>Correct replacement</button>');
  });

  it('keeps a recovered regeneration safe stop explicit until its exact editor opens', () => {
    const state = baseState();
    state.credentialRotationRecovery = {
      kind: 'api',
      name: 'hubspot',
      phase: 'failed',
      failureReason: 'auth_failed',
      correction: {
        auth_type: 'bearer',
        field_keys: ['auth.token'],
        triage: {
          reason: 'repeated_auth_rejection',
          stage: 'provider_probe',
          endpoint_field_keys: ['config.base_url', 'config.endpoint'],
          resolution: 'regenerate_credential_or_contact_admin',
        },
      },
    };

    const html = renderConnectionsPage(state);
    expect(html).toContain('Resume credential recovery');
    expect(html).toContain(
      'aria-label="Resume safe credential recovery for api/hubspot"',
    );
    expect(html).toContain('saved credential remains active');
    expect(html).toContain('no credential draft was stored');
    expect(html).not.toContain('Resolve repeated rejection');

    state.dialog = {
      ...initialConnectionsDialogState(),
      stage: 'form',
      mode: 'edit',
      kind: 'api',
      editingId: 'api/hubspot',
      values: {
        name: 'hubspot',
        display_name: 'HubSpot',
        'auth.type': 'bearer',
      },
    };
    const exact = renderConnectionsPage(state);
    expect(exact).toContain('Safe credential recovery is open');
    expect(exact).toContain('Verify and replace stays paused');
    expect(exact).not.toContain('>Resume credential recovery</button>');
  });

  it('does not promise an exact recovery landing before its row is available', () => {
    const loadingState = baseState({ loading: true, connections: [] });
    loadingState.credentialRotationRecovery = {
      kind: 'api',
      name: 'hubspot',
      phase: 'failed',
      failureReason: 'server_error',
    };
    const loading = renderConnectionsPage(loadingState);
    expect(loading).toContain('Loading connection…');
    expect(loading).toContain('disabled');

    loadingState.loading = false;
    const missing = renderConnectionsPage(loadingState);
    expect(missing).toContain('>Dismiss</button>');
    expect(missing).not.toContain('Review connection');
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
      // D-218 — ⚠ this ratchet FIRED on the widened vocabulary, which is
      // exactly its job. The form list DERIVES from `CONNECTION_AUTH_TYPES`
      // now, so a new type arrives here automatically; the pin is what makes
      // that arrival visible rather than silent.
      'atproto_session',
      // Request signing. Arrived here automatically because the list derives —
      // the pin is what makes the arrival a decision rather than a surprise.
      'request_signature',
    ]);
  });

  it('D-218 — the atproto fields are gated, and there is NO endpoint field', () => {
    // ⛔ The absence is the security property (§ 7.5b): every other exchanging
    // type on this form asks for a token endpoint, and this one derives the
    // session URLs from Base URL instead — so the app password can only reach
    // the host the connection already talks to. A field here would quietly
    // become a credential-only destination.
    const shown = (authType: string): string[] =>
      apiSchema.fields
        .filter((f) => f.showWhen === undefined || f.showWhen({ 'auth.type': authType }))
        .map((f) => f.key);

    const atproto = shown('atproto_session');
    expect(atproto).toContain('auth.identifier');
    expect(atproto).toContain('auth.app_password');
    expect(atproto).not.toContain('auth.token_endpoint');
    expect(atproto).not.toContain('auth.client_id');
    expect(atproto).not.toContain('auth.client_secret');

    // …and the new fields stay out of every other type's form.
    expect(shown('bearer')).not.toContain('auth.app_password');
    expect(shown('oauth2_refresh')).not.toContain('auth.identifier');
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

  it('makes local ingress the first choice and reveals only mode-specific credentials', () => {
    const modeField = (subtype: 'slack' | 'telegram' | 'discord') =>
      notificationSchemas[subtype].fields.find((field) => field.key === 'config.ingress_mode');
    expect(modeField('slack')?.options).toEqual(['socket', 'webhook']);
    expect(modeField('telegram')?.options).toEqual(['poll', 'webhook']);
    expect(modeField('discord')?.options).toEqual(['socket', 'webhook']);
    expect(modeField('slack')?.optionLabels?.socket).toContain('recommended');
    expect(modeField('telegram')?.optionLabels?.poll).toContain('recommended');
    expect(modeField('discord')?.optionLabels?.webhook).toContain('approvals only');

    for (const subtype of ['slack', 'telegram', 'discord'] as const) {
      expect(notificationSchemas[subtype].onboarding?.selectorKey)
        .toBe('config.ingress_mode');
      expect(notificationSchemas[subtype].onboarding?.guides).toHaveLength(2);
      expect(notificationSchemas[subtype].fields.find((field) => field.key === 'auth.type')?.hidden)
        .toBe(true);
    }

    const slackFields = (mode: string) => notificationSchemas.slack.fields
      .filter((field) => field.showWhen?.({ 'config.ingress_mode': mode }) ?? true)
      .map((field) => field.key);
    expect(slackFields('socket')).toContain('auth.app_token');
    expect(slackFields('socket')).not.toContain('config.signing_secret');
    expect(slackFields('webhook')).toContain('config.signing_secret');
    expect(slackFields('webhook')).not.toContain('auth.app_token');

    const webhookValues = {
      name: 'telegram',
      display_name: 'Telegram',
      'config.ingress_mode': 'webhook',
      'config.chat_id': '1',
      'auth.type': 'bearer',
      'auth.token': 'bot-token',
    };
    expect(connectionFormValidationIssue(
      notificationSchemas.telegram,
      webhookValues,
      undefined,
      'create',
    )).toMatchObject({ fieldKey: 'config.webhook_secret' });
    expect(connectionFormValidationIssue(
      notificationSchemas.telegram,
      webhookValues,
      undefined,
      'edit',
    )).toBeNull();
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

  it('projects Slack Socket Mode with both encrypted auth credentials', () => {
    const payload = projectConnectionPayload(
      notificationSchemas.slack,
      {
        name: 'slack',
        display_name: 'Slack',
        'config.ingress_mode': 'socket',
        'config.channel_id': 'C123',
        'auth.type': 'bearer',
        'auth.token': 'xoxb-token',
        'auth.app_token': 'xapp-token',
      },
      'notification',
      'slack',
    );
    expect(payload.config).toEqual({ ingress_mode: 'socket', channel_id: 'C123' });
    expect(payload.auth).toEqual({
      type: 'bearer',
      token: 'xoxb-token',
      app_token: 'xapp-token',
    });
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

    const api = resolveConnectionSchema('api');
    expect(api).toBeDefined();
    expect(shouldPatchConnectionAuth(api!, {
      name: 'header-api',
      display_name: 'Header API',
      'config.base_url': 'https://api.example.com',
      'auth.type': 'header',
      'auth.headers.0.header_name': 'X-API-Key',
      'auth.headers.0.value': 'memory-only-secret',
    })).toBe(true);
  });
});

describe('D-125 P7.2 — view → values flatten', () => {
  it('hydrates name + display_name + flattened config keys, never auth', () => {
    const values = flattenConnectionViewIntoValues({
      name: 'hubspot',
      kind: 'api',
      display_name: 'HubSpot',
      updated_at: 1_700_000_000_000,
      base_url: 'https://api.hubapi.com',
    });
    expect(values.name).toBe('hubspot');
    expect(values.display_name).toBe('HubSpot');
    expect(values['config.base_url']).toBe('https://api.hubapi.com');
    expect(values['config.updated_at']).toBeUndefined();
    // No auth keys in the projection — `ConnectionView` excludes them
    // by construction; the test asserts the flattener mirrors that.
    expect(values['auth.token']).toBeUndefined();
  });

  it('uses non-secret auth metadata to reopen the correct rotation fields', () => {
    const patch = buildConnectionEditDialogPatch({
      name: 'basic-api',
      kind: 'api',
      display_name: 'Basic API',
      auth_type: 'basic',
      base_url: 'https://api.example.com',
      granted_scopes: ['read'],
    });

    expect(patch.values['auth.type']).toBe('basic');
    expect(patch.values['auth.username']).toBeUndefined();
    expect(patch.values['auth.password']).toBeUndefined();
    expect(patch.values['config.auth_type']).toBeUndefined();
    expect(patch.values['config.granted_scopes']).toBeUndefined();
  });

  it('shows the historical webhook mode when editing a messenger row that predates ingress_mode', () => {
    const patch = buildConnectionEditDialogPatch({
      name: 'telegram',
      kind: 'notification',
      subtype: 'telegram',
      display_name: 'Telegram',
      auth_type: 'bearer',
      chat_id: '1',
    });

    expect(patch.values['config.ingress_mode']).toBe('webhook');
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
        values: { name: 'acme', display_name: 'Acme', 'auth.type': 'oauth2_refresh' },
      }),
    );
    expect(html).toContain('Authorize URL');
    expect(html).toContain('Scopes');
    expect(html).toContain('data-action="connections-authorize-vendor"');
    // Generic flow → no vendor name in the label, and no vendor consent block.
    expect(html).not.toContain('Authorize with');
    expect(html).not.toContain('data-vendor=');
  });

  it('marks an entered but unsafe generic endpoint as needing attention', () => {
    const html = renderConnectionsPage(
      withDialog({
        stage: 'form',
        kind: 'api',
        values: {
          name: 'acme',
          display_name: 'Acme',
          'auth.type': 'oauth2_refresh',
          'auth.client_id': 'client-id',
          'auth.token_endpoint': 'http://provider.example/token',
          'auth.authorize_url': 'https://provider.example/authorize',
        },
      }),
    );
    expect(html).toContain('1 detail needs attention');
    expect(html).toContain('data-oauth-requirement="auth.token_endpoint" data-status="invalid"');
    expect(html).toContain('<small>Check</small>');
  });

  it('rejects an unsafe token endpoint when saving a pasted refresh token', () => {
    const error = validateConnectionForm(
      apiSchema,
      {
        name: 'provider',
        display_name: 'Provider',
        'config.base_url': 'https://api.provider.example',
          'auth.type': 'oauth2_refresh',
        'auth.client_id': 'client-id',
        'auth.refresh_token': 'pasted-token',
        'auth.token_endpoint': 'http://provider.example/token',
      },
      {},
      'create',
    );

    expect(error).toContain('complete HTTPS URL');
  });

  it('keeps a valid pasted-token path complete without requiring an Authorize URL', () => {
    const html = renderConnectionsPage(
      withDialog({
        stage: 'form',
        kind: 'api',
        values: {
          name: 'acme',
          display_name: 'Acme',
          'auth.type': 'oauth2_refresh',
          'auth.client_id': 'client-id',
          'auth.refresh_token': 'pasted-token',
          'auth.token_endpoint': 'https://provider.example/token',
        },
      }),
    );
    expect(html).toContain('data-oauth-state="authorized"');
    expect(html).toContain('Refresh token ready to save');
    expect(html).toContain('Add re-authorization details');
    expect(html).not.toContain('Review provider credentials');
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
        name: 'acme',
          display_name: 'Acme',
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
          name: 'acme',
          display_name: 'Acme',
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

  it('shows the live-only credential checklist before an incomplete app can authorize', () => {
    const html = renderConnectionsPage(hubspotForm());
    expect(html).toContain('data-action="connections-authorize-vendor"');
    expect(html).toContain('Provider credentials');
    expect(html).toContain('2 required details left');
    expect(html).toContain('Review provider credentials');
    expect(html).toContain('Excluded from AI');
    expect(html).toContain("provider's OAuth endpoints");
    expect(html).toContain('Saving stores them on your server');
    expect(html).toContain('reload recovery never receive their values');
    expect(html).toContain(OAUTH_CLOUD_CALLBACK_URL);
    expect(html).toContain('Register this unchanged in the provider app');
    // The checklist follows the fields it describes instead of putting an
    // unusable authorization action ahead of the required entries.
    expect(html.indexOf('class="connections-form-fields"')).toBeLessThan(
      html.indexOf('aria-labelledby="connections-oauth-title"'),
    );
  });

  it('makes the authorization action explicit only when registered credentials are ready', () => {
    const html = renderConnectionsPage(
      hubspotForm({
        values: {
          'config.vendor': 'hubspot',
          name: 'acme',
          display_name: 'Acme',
          'auth.type': 'oauth2_refresh',
          'auth.client_id': 'client-id',
          'auth.client_secret': 'client-secret',
        },
      }),
    );
    expect(html).toContain('data-oauth-state="ready"');
    expect(html).toContain('Ready to authorize');
    expect(html).toContain('Authorize with HubSpot');
    expect(html).not.toContain('Review provider credentials');
  });

  it('shows "Re-authorize with HubSpot" button when refresh_token already filled', () => {
    const html = renderConnectionsPage(
      hubspotForm({
        values: {
          'config.vendor': 'hubspot',
          name: 'acme',
          display_name: 'Acme',
          'auth.type': 'oauth2_refresh',
          'auth.client_id': 'client-id',
          'auth.client_secret': 'client-secret',
          'auth.refresh_token': 'pre-existing-token',
        },
      }),
    );
    expect(html).toContain('Re-authorize with HubSpot');
  });

  it('does not call a pasted token complete while its refresh credentials are missing', () => {
    const html = renderConnectionsPage(
      hubspotForm({
        values: {
          'config.vendor': 'hubspot',
          name: 'acme',
          display_name: 'Acme',
          'auth.type': 'oauth2_refresh',
          'auth.refresh_token': 'pasted-token',
        },
      }),
    );
    expect(html).toContain('data-oauth-state="incomplete"');
    expect(html).toContain('2 required details left');
    expect(html).toContain('Review provider credentials');
    expect(html).not.toContain('Authorization received');
    expect(html).not.toContain('Re-authorize with HubSpot');
  });

  it('locks captured provider credentials and Save while OAuth is in flight', () => {
    const html = renderConnectionsPage(hubspotForm({
      oauthInFlight: true,
      values: {
        'config.vendor': 'hubspot',
        name: 'acme',
          display_name: 'Acme',
          'auth.type': 'oauth2_refresh',
        'auth.client_id': 'client-id',
        'auth.client_secret': 'client-secret',
        'config.base_url': 'https://api.hubapi.com',
      },
    }));
    expect(html).toContain('Authorizing…');
    const clientIdInput = html.match(/<input[^>]*data-conn-field="auth\.client_id"[^>]*>/)?.[0];
    const clientSecretInput = html.match(/<input[^>]*data-conn-field="auth\.client_secret"[^>]*>/)?.[0];
    const baseUrlInput = html.match(/<input[^>]*data-conn-field="config\.base_url"[^>]*>/)?.[0];
    const saveButton = html.match(/<button[^>]*data-action="connections-submit-form"[^>]*>/)?.[0];
    expect(clientIdInput).toContain('readonly');
    expect(clientSecretInput).toContain('readonly');
    expect(baseUrlInput).toContain('readonly');
    expect(saveButton).toContain('disabled');
  });

  it('disables provider authorization while Save is committing', () => {
    const html = renderConnectionsPage(hubspotForm({
      saving: true,
      values: {
        'config.vendor': 'hubspot',
        name: 'acme',
          display_name: 'Acme',
          'auth.type': 'oauth2_refresh',
        'auth.client_id': 'client-id',
        'auth.client_secret': 'client-secret',
      },
    }));
    const authorizeButton = html.match(
      /<button[^>]*data-action="connections-authorize-vendor"[^>]*>/,
    )?.[0];
    expect(authorizeButton).toContain('disabled');
  });

  it('surfaces granted scopes inline after a successful exchange', () => {
    const html = renderConnectionsPage(
      hubspotForm({
        values: {
          'config.vendor': 'hubspot',
          name: 'acme',
          display_name: 'Acme',
          'auth.type': 'oauth2_refresh',
          'auth.client_id': 'client-id',
          'auth.client_secret': 'client-secret',
          'auth.refresh_token': 'fresh-token',
        },
        oauthGrantedScopes: ['crm.objects.deals.read', 'crm.objects.contacts.read', 'oauth'],
      }),
    );
    expect(html).toContain('Granted scopes (3)');
    expect(html).toContain('crm.objects.deals.read');
  });

  /** A live drive stopped at exactly this state and asked three questions the
   *  panel did not answer: is the connection saved now? why probe when the
   *  authorization just succeeded? does Cancel undo the authorization?
   *
   *  The exchange patches the DRAFT only — nothing is on disk until Save — so
   *  all three have the same answer and it has to be on screen here, next to
   *  the token, not inferable from the privacy paragraph. */
  it('after a successful exchange, states the draft is unsaved and why the probe is a separate check', () => {
    const html = renderConnectionsPage(
      hubspotForm({
        values: {
          'config.vendor': 'hubspot',
          name: 'acme',
          display_name: 'Acme',
          'auth.type': 'oauth2_refresh',
          'auth.client_id': 'client-id',
          'auth.client_secret': 'client-secret',
          'auth.refresh_token': 'fresh-token',
          'config.base_url': 'https://api.hubapi.com',
        },
        oauthGrantedScopes: ['crm.objects.contacts.read'],
      }),
    );
    expect(html).toContain('Not saved yet');
    expect(html).toContain('Save and probe');
    // The probe's job, named as distinct from the exchange's.
    expect(html).toContain('the token actually reaches');
    expect(html).toContain('https://api.hubapi.com');
    // And what Cancel costs, since that was the third question.
    expect(html).toContain('Cancel discards this authorization');
    // ⚠ CSS is invisible to a render test, so assert the STYLED primitive is on
    // it. No stylesheet targets any `connections-oauth-*` class — `rx-msg` is
    // what carries the panel's message typography. Without it the most
    // important sentence in the form renders as unstyled body text and every
    // assertion above still passes.
    expect(html).toMatch(/class="rx-msg rx-msg-warn connections-oauth-next-step"/);
  });

  it('says nothing about an unsaved authorization before one has happened', () => {
    // Negative control: the notice must be bound to a COMPLETED exchange, not
    // rendered into every OAuth form where it would be noise (and wrong).
    const html = renderConnectionsPage(hubspotForm());
    expect(html).not.toContain('Not saved yet');
  });

  it('retires Back once a provider consent has completed, keeping Cancel', () => {
    // Back returns to the picker and WIPES `values` — post-consent it is a
    // strictly worse Cancel, discarding a token the user paid a consent screen
    // for while reading as mere navigation.
    const before = renderConnectionsPage(
      hubspotForm({
        values: {
          'config.vendor': 'hubspot',
          name: 'acme',
          display_name: 'Acme',
          'auth.type': 'oauth2_refresh',
          'auth.client_id': 'client-id',
          'auth.client_secret': 'client-secret',
        },
      }),
    );
    expect(before).toContain('connections-back-to-kind');
    expect(before).toContain('connections-cancel-dialog');

    const after = renderConnectionsPage(
      hubspotForm({
        values: {
          'config.vendor': 'hubspot',
          name: 'acme',
          display_name: 'Acme',
          'auth.type': 'oauth2_refresh',
          'auth.client_id': 'client-id',
          'auth.client_secret': 'client-secret',
          'auth.refresh_token': 'fresh-token',
        },
        oauthGrantedScopes: ['crm.objects.contacts.read'],
      }),
    );
    expect(after).not.toContain('connections-back-to-kind');
    // The exit is still reachable — this removes a duplicate, not the escape.
    expect(after).toContain('connections-cancel-dialog');
  });

  it('keeps Back when the refresh token was pasted rather than authorized', () => {
    // The gate is `oauthGrantedScopes`, not the token: a hand-pasted token
    // consumed nothing external, so there is no consent to protect.
    const html = renderConnectionsPage(
      hubspotForm({
        values: {
          'config.vendor': 'hubspot',
          name: 'acme',
          display_name: 'Acme',
          'auth.type': 'oauth2_refresh',
          'auth.client_id': 'client-id',
          'auth.client_secret': 'client-secret',
          'auth.refresh_token': 'pasted-by-hand',
        },
      }),
    );
    expect(html).toContain('connections-back-to-kind');
  });

  it('explains when changed app details invalidate an in-app authorization', () => {
    const html = renderConnectionsPage(
      hubspotForm({
        values: {
          'config.vendor': 'hubspot',
          name: 'acme',
          display_name: 'Acme',
          'auth.type': 'oauth2_refresh',
          'auth.client_id': 'replacement-client-id',
          'auth.client_secret': 'client-secret',
        },
        oauthNeedsReauthorization: true,
      }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('cleared the previous authorization');
    expect(html).toContain('Authorize again or paste a matching refresh token');
  });

  it('associates a correctable OAuth error with the exact credential field', () => {
    const html = renderConnectionsPage(
      hubspotForm({
        oauthError: 'token exchange failed (400): bad code',
        oauthErrorFieldKey: 'auth.client_id',
      }),
    );
    expect(html).toContain('id="connections-oauth-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('token exchange failed (400): bad code');
    const clientIdInput = html.match(/<input[^>]*data-conn-field="auth\.client_id"[^>]*>/)?.[0];
    expect(clientIdInput).toContain('aria-invalid="true"');
    expect(clientIdInput).toContain('aria-errormessage="connections-oauth-error"');
    expect(html).toContain('data-field-key="auth.client_id" data-oauth-invalid="true"');
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
    expect(s.oauthErrorFieldKey).toBeNull();
    expect(s.credentialCorrection).toBeNull();
    expect(s.oauthNeedsReauthorization).toBe(false);
    expect(s.oauthGrantedScopes).toBeNull();
    expect(s.setupGuide).toEqual({
      stage: 'closed',
      targetUrl: '',
      preview: null,
      result: null,
      error: null,
      resumeAvailable: false,
      resumeFieldKey: null,
    });
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

describe('autofilled — a required value the OWNER does not type', () => {
  const apiSchema = resolveConnectionSchema('api');
  const refreshField = apiSchema?.fields.find((f) => f.key === 'auth.refresh_token');

  it('the generic api Refresh Token is marked autofilled, and still NOT optional', () => {
    // Both halves matter. `autofilled` fixes the affordance; leaving `optional`
    // false keeps the data rule — a connection with no refresh token can never
    // mint an access token, so submit must still block.
    expect(refreshField).toBeDefined();
    expect(refreshField?.autofilled).toBe(true);
    expect(refreshField?.optional).toBeUndefined();
  });

  it('⛔ renders NO required asterisk for it — the `*` is the owner\'s obligation', () => {
    const html = renderConnectionsPage({
      ...initialConnectionsPageState(),
      dialog: {
        ...initialConnectionsDialogState(),
        stage: 'form',
        mode: 'create',
        kind: 'api',
        values: { name: 'acme', display_name: 'Acme', 'auth.type': 'oauth2_refresh' },
      },
    } as never);
    // The field renders…
    expect(html).toContain('auth.refresh_token');
    // …and its label carries no `*`, unlike a field the owner really must type.
    const refreshLabel = html.slice(html.indexOf('Refresh Token') - 200, html.indexOf('Refresh Token') + 60);
    expect(refreshLabel).not.toContain('connections-field-required');
  });

  it('blocking submit names the ACTION, not the obligation', () => {
    // Every earlier required field filled, so the refresh token is the one that
    // blocks — otherwise this would assert on whichever field happens to be first.
    const message = validateConnectionForm(
      apiSchema!,
      {
        name: 'ms',
        display_name: 'Microsoft',
        'config.base_url': 'https://graph.microsoft.com/v1.0',
          'auth.type': 'oauth2_refresh',
        'auth.client_id': 'cid',
        'auth.client_secret': 'secret',
        'auth.token_endpoint': 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        'auth.refresh_token': '',
      },
      undefined,
      'create',
    );
    // "Refresh Token is required." names something the owner cannot discharge
    // by typing — the whole defect. It must name Authorize instead.
    expect(message).toBe('Refresh Token: click Authorize to obtain one.');
    expect(message).not.toContain('is required');
  });
});
