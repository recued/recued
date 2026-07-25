/** D-165 P3.consent/vendor-state - vendor enrollment UI coverage.
 *
 *  This pins the connection-enrollment half only: OAuth consent disclosure
 *  and post-auth provider-side setup status. It deliberately stays out of
 *  operation-group grant persistence / contract.grant merge behavior, which is
 *  the D-166-blocked install-planner lane. */

import { describe, expect, it } from 'vitest';

import {
  HUBSPOT_OAUTH_SCOPES,
  SALESFORCE_OAUTH_SCOPES,
} from '@recued/contracts';
import {
  initialConnectionsDialogState,
  initialConnectionsPageState,
  renderConnectionsPage,
} from '../index.js';
import type {
  ConnectionsDialogState,
  ConnectionsPageState,
} from '../connections/index.js';

const baseState = (
  dialog: Partial<ConnectionsDialogState>,
): ConnectionsPageState => ({
  ...initialConnectionsPageState(),
  dialog: {
    ...initialConnectionsDialogState(),
    stage: 'form',
    kind: 'api',
    vendor: 'hubspot',
    values: {
      name: 'hubspot',
      display_name: 'HubSpot',
      'config.vendor': 'hubspot',
      'auth.type': 'oauth2_refresh',
    },
    ...dialog,
  },
});

describe('D-165 P3.consent/vendor-state - connection enrollment UI', () => {
  it('renders the HubSpot OAuth consent scope set from the vendor provider registry', () => {
    const html = renderConnectionsPage(baseState({}));

    expect(html).toContain('Connection consent');
    expect(html).toContain('data-vendor="hubspot"');
    for (const scope of HUBSPOT_OAUTH_SCOPES) {
      expect(html).toContain(`<code>${scope}</code>`);
    }
    expect(html).not.toContain('InstalledAgentConnectionGrant');
    expect(html).not.toContain('contract.grant');
  });

  it('keeps provider-side setup in needs_connection until OAuth has completed', () => {
    const html = renderConnectionsPage(baseState({}));

    expect(html).toContain('data-vendor-state="needs_connection"');
    expect(html).toContain('Needs HubSpot OAuth consent');
    expect(html).toContain('Provider-side setup is held until OAuth completes');
  });

  it('marks Salesforce provider-side setup ready only after a refresh token is present', () => {
    const html = renderConnectionsPage(
      baseState({
        vendor: 'salesforce',
        values: {
          name: 'salesforce',
          display_name: 'Salesforce',
          'config.vendor': 'salesforce',
          'auth.type': 'oauth2_refresh',
          'auth.refresh_token': 'rtok',
        },
      }),
    );

    expect(html).toContain('data-vendor="salesforce"');
    expect(html).toContain('data-vendor-state="ready_after_auth"');
    for (const scope of SALESFORCE_OAUTH_SCOPES) {
      expect(html).toContain(`<code>${scope}</code>`);
    }
    expect(html).toContain('Ready for provider-side setup after Save');
    expect(html).toContain('Default reconciliation cadence: 6h');
  });

  it('shows the save-before-sync hold state while the connection write is in flight', () => {
    const html = renderConnectionsPage(
      baseState({
        saving: true,
        values: {
          name: 'hubspot',
          display_name: 'HubSpot',
          'config.vendor': 'hubspot',
          'auth.type': 'oauth2_refresh',
          'auth.refresh_token': 'rtok',
        },
      }),
    );

    expect(html).toContain('data-vendor-state="saving_connection"');
    expect(html).toContain('Saving connection before vendor setup');
    expect(html).toContain('Provider-side setup remains held until the connection credential is persisted');
  });
});
