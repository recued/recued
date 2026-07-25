import { describe, expect, it } from 'vitest';

import {
  AIRBYTE_API_BASE,
  AIRBYTE_SCHEMA_INITIAL_VALUES,
  AIRBYTE_TOKEN_ENDPOINT,
  airbyteSchema,
  initialConnectionsPageState,
  projectConnectionPayload,
  renderConnectionsPage,
  resolveVendorSchema,
} from '../index.js';

describe('Airbyte connection enrollment', () => {
  it('registers a locked client-credentials vendor schema with official Cloud endpoints', () => {
    expect(resolveVendorSchema('airbyte')).toBe(airbyteSchema);
    expect(AIRBYTE_SCHEMA_INITIAL_VALUES).toMatchObject({
      name: 'airbyte',
      'config.vendor': 'airbyte',
      'config.base_url': AIRBYTE_API_BASE,
      'auth.type': 'oauth2_client_credentials',
      'auth.token_endpoint': AIRBYTE_TOKEN_ENDPOINT,
    });
    expect(AIRBYTE_API_BASE).toBe('https://api.airbyte.com/v1');
    expect(AIRBYTE_TOKEN_ENDPOINT).toBe('https://api.airbyte.com/v1/applications/token');
  });

  it('projects the client secret only into encrypted connection auth', () => {
    const payload = projectConnectionPayload(
      airbyteSchema,
      {
        ...AIRBYTE_SCHEMA_INITIAL_VALUES,
        'auth.client_id': 'client-id',
        'auth.client_secret': 'client-secret',
      },
      'api',
      null,
    );
    expect(payload).toMatchObject({
      name: 'airbyte',
      kind: 'api',
      config: { vendor: 'airbyte', base_url: AIRBYTE_API_BASE },
      auth: {
        type: 'oauth2_client_credentials',
        client_id: 'client-id',
        client_secret: 'client-secret',
        token_endpoint: AIRBYTE_TOKEN_ENDPOINT,
      },
    });
  });

  it('renders no authorization-code popup action for a machine-to-machine vendor', () => {
    const state = initialConnectionsPageState();
    state.dialog = {
      ...state.dialog,
      stage: 'form',
      kind: 'api',
      vendor: 'airbyte',
      values: {
        ...AIRBYTE_SCHEMA_INITIAL_VALUES,
        'auth.client_id': 'client-id',
        'auth.client_secret': 'client-secret',
      },
    };
    const html = renderConnectionsPage(state);
    expect(html).toContain('Airbyte Cloud');
    expect(html).not.toContain('connections-authorize-vendor');
  });
});
