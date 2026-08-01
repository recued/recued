import { describe, expect, it } from 'vitest';
import { OAUTH_CLOUD_CALLBACK_URL } from '@recued/contracts';

import {
  apiSchema,
  buildConnectionSetupGuidePreview,
  canApplyConnectionSetupGuideSuggestion,
  canonicalizeConnectionSetupGuideUrl,
  connectionSetupGuideReturnTarget,
  initialConnectionsPageState,
  renderConnectionsPage,
  type ConnectionsPageState,
} from '../index.js';

const oauthValues = {
  name: 'example',
  display_name: 'Example',
  'config.base_url': 'https://api.example.com',
  'auth.type': 'oauth2_refresh',
  'auth.refresh_token': 'REFRESH-SECRET-DO-NOT-SHARE',
  'auth.client_id': 'CLIENT-ID-DO-NOT-SHARE',
  'auth.client_secret': 'CLIENT-SECRET-DO-NOT-SHARE',
  'auth.token_endpoint': 'https://oauth.example.com/token',
  'auth.authorize_url': 'https://oauth.example.com/authorize',
  'auth.scopes': 'read write',
};

const formState = (): ConnectionsPageState => {
  const state = initialConnectionsPageState();
  state.dialog.stage = 'form';
  state.dialog.kind = 'api';
  state.dialog.values = { ...oauthValues };
  return state;
};

describe('connection setup guide request minimization', () => {
  it('builds a reviewed request from schema shape, not entered values', () => {
    const result = buildConnectionSetupGuidePreview(
      apiSchema,
      oauthValues,
      'https://developer.example.com/apps?token=URL-SECRET#fragment',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.target_url).toBe('https://developer.example.com/apps');
    expect(result.preview.auth_type).toBe('oauth2_refresh');
    expect(result.preview.field_keys).toContain('auth.client_secret');
    expect(result.preview.field_keys).not.toContain('config.vendor');
    const serialized = JSON.stringify(result.preview);
    expect(serialized).not.toContain('REFRESH-SECRET-DO-NOT-SHARE');
    expect(serialized).not.toContain('CLIENT-ID-DO-NOT-SHARE');
    expect(serialized).not.toContain('CLIENT-SECRET-DO-NOT-SHARE');
    expect(serialized).not.toContain('URL-SECRET');
  });

  it.each([
    ['plain HTTP', 'http://developer.example.com/apps'],
    ['localhost', 'https://localhost/apps'],
    ['localhost with trailing dot', 'https://localhost./apps'],
    ['private IPv4', 'https://10.0.0.8/apps'],
    ['IPv4-mapped private IPv6', 'https://[::ffff:10.0.0.8]/apps'],
    ['embedded password', 'https://owner:secret@developer.example.com/apps'],
  ])('rejects %s before the review step', (_label, url) => {
    expect(canonicalizeConnectionSetupGuideUrl(url).ok).toBe(false);
  });

  it('accepts a public domain that merely begins with IPv6-looking letters', () => {
    expect(canonicalizeConnectionSetupGuideUrl('https://fd.example.com/apps'))
      .toEqual({ ok: true, url: 'https://fd.example.com/apps' });
  });

  it('keeps secret and provider-issued identity fields out of the apply lane', () => {
    expect(canApplyConnectionSetupGuideSuggestion(
      'auth.token_endpoint',
      'https://oauth.example.com/token',
    )).toBe(true);
    expect(canApplyConnectionSetupGuideSuggestion('auth.client_id', 'invented-id'))
      .toBe(false);
    expect(canApplyConnectionSetupGuideSuggestion('auth.client_secret', 'invented-secret'))
      .toBe(false);
    expect(canApplyConnectionSetupGuideSuggestion(
      'auth.token_endpoint',
      'http://oauth.example.com/token',
    )).toBe(false);
    expect(canApplyConnectionSetupGuideSuggestion(
      'auth.token_endpoint',
      'https://127.0.0.1/token',
    )).toBe(false);
  });

  it('derives the return target from visible unfinished OAuth fields', () => {
    expect(connectionSetupGuideReturnTarget(apiSchema, oauthValues)).toEqual({
      kind: 'authorize',
    });
    expect(connectionSetupGuideReturnTarget(apiSchema, {
      ...oauthValues,
      'auth.client_id': '',
    })).toEqual({
      kind: 'field',
      fieldKey: 'auth.client_id',
    });
    expect(connectionSetupGuideReturnTarget(apiSchema, {
      ...oauthValues,
      'auth.client_secret': '',
      'auth.scopes': '',
    })).toEqual({
      kind: 'authorize',
    });
    expect(connectionSetupGuideReturnTarget(apiSchema, {
      ...oauthValues,
      'auth.type': 'oauth2_client_credentials',
      'auth.client_secret': 'client-secret',
      'auth.scope': '',
    })).toEqual({
      kind: 'submit',
    });
    expect(connectionSetupGuideReturnTarget(apiSchema, {
      ...oauthValues,
      name: '',
      'auth.type': 'oauth2_client_credentials',
      'auth.client_secret': 'client-secret',
      'auth.scope': '',
    })).toEqual({
      kind: 'field',
      fieldKey: 'name',
    });
  });
});

describe('connection setup guide renderer', () => {
  it('starts with a clear API-form affordance and stays absent on non-API forms', () => {
    const api = renderConnectionsPage(formState());
    expect(api).toContain('Suggest and guide');
    expect(api).toContain('creating a provider app');

    const mcp = formState();
    mcp.dialog.kind = 'mcp';
    mcp.dialog.subtype = 'sse';
    expect(renderConnectionsPage(mcp)).not.toContain('connections-guide-open');
  });

  it('labels the URL field and explains the review boundary before egress', () => {
    const state = formState();
    state.dialog.setupGuide.stage = 'entry';
    const html = renderConnectionsPage(state);
    expect(html).toContain('for="connection-setup-guide-url"');
    expect(html).toContain('data-connection-guide-url');
    expect(html).toContain('data-connection-guide-panel tabindex="-1"');
    expect(html).toContain('Review what will be shared');
    expect(html).toContain('All other connection-form values');
    expect(html).toContain('passwords, and secrets—are never shared');
  });

  it('renders the exact reviewed context and an explicit not-shared list', () => {
    const state = formState();
    const built = buildConnectionSetupGuidePreview(
      apiSchema,
      state.dialog.values,
      'https://developer.example.com/apps?secret=x',
    );
    if (!built.ok) throw new Error(built.error);
    state.dialog.setupGuide = {
      stage: 'preview',
      targetUrl: built.preview.target_url,
      preview: built.preview,
      result: null,
      error: null,
      resumeAvailable: false,
      resumeFieldKey: null,
    };
    const html = renderConnectionsPage(state);
    expect(html).toContain('Review before asking AI');
    expect(html).toContain('https://developer.example.com/apps');
    expect(html).toContain('OAuth with refresh token');
    expect(html).toContain('<strong>Not shared:</strong>');
    expect(html).toContain('standard, value-free descriptions');
    expect(html).toContain('Recued does not sign in to, fetch, or submit the page');
  });

  it('announces progress and safely renders a structured result', () => {
    const state = formState();
    const built = buildConnectionSetupGuidePreview(
      apiSchema,
      state.dialog.values,
      'https://developer.example.com/apps',
    );
    if (!built.ok) throw new Error(built.error);
    state.dialog.setupGuide = {
      stage: 'loading',
      targetUrl: built.preview.target_url,
      preview: built.preview,
      result: null,
      error: null,
      resumeAvailable: false,
      resumeFieldKey: null,
    };
    const loading = renderConnectionsPage(state);
    expect(loading).toContain('role="status"');
    expect(loading).toContain('aria-live="polite"');

    state.dialog.setupGuide.stage = 'ready';
    state.dialog.setupGuide.result = {
      shared_context: {
        target_url: built.preview.target_url,
        auth_type: built.preview.auth_type,
        field_keys: [...built.preview.field_keys],
      },
      guide: {
        provider_name: '<Example Cloud>',
        overview: 'Create an OAuth app and verify every value.',
        field_suggestions: [
          {
            field_key: 'config.base_url',
            suggested_value: 'https://api.example.com/',
            guidance: 'Use the production API root.',
            confidence: 'high',
          },
          {
            field_key: 'auth.client_id',
            suggested_value: 'MODEL-MUST-NOT-APPLY-THIS',
            guidance: 'Copy the issued value from the provider.',
            confidence: 'low',
          },
        ],
        steps: [{
          title: 'Create the app',
          instruction: 'Choose a confidential web application.',
          field_keys: ['auth.client_id'],
        }],
        cautions: ['Use least-privilege scopes.'],
      },
    };
    const ready = renderConnectionsPage(state);
    expect(ready).toContain('&lt;Example Cloud&gt;');
    expect(ready).not.toContain('<Example Cloud>');
    expect(ready).toContain('Provider app handoff');
    expect(ready).toContain('Create the app, then return to this form');
    expect(ready).toContain(OAUTH_CLOUD_CALLBACK_URL);
    expect(ready).toContain('connections-guide-copy-callback');
    expect(ready).toContain('connections-guide-return-to-form');
    expect(ready).toContain('data-scope-source="form"');
    expect(ready).toContain('<code>read</code>');
    expect(ready).toContain('<code>write</code>');
    expect(ready).toContain('Suggested form values');
    expect(ready).toContain('Only explicit, non-secret suggestions');
    expect(ready).toContain('Use in form after checking');
    expect(ready.match(/connections-guide-use-suggestion/gu)).toHaveLength(1);
    expect(ready).toContain('Provider setup walkthrough');
    expect(ready).toContain('target="_blank" rel="noopener noreferrer"');
    expect(ready).toContain('Open provider page (new tab)');
    expect(ready).toContain('connections-setup-guide-step-number" aria-hidden="true"');
    expect(ready).toContain('AI-generated guidance can be outdated');

    state.dialog.setupGuide.resumeAvailable = true;
    const restored = renderConnectionsPage(state);
    expect(restored).toContain('Provider setup restored');
    expect(restored).toContain('role="status" aria-live="polite" aria-atomic="true"');
    expect(restored.match(/aria-live="polite"/gu)).toHaveLength(1);
    expect(restored).toContain('Resume provider setup');
    expect(restored).toContain('Other form entries were not retained');
    expect(restored).toContain('were never stored in this resume');
    expect(restored).not.toContain('connections-guide-return-to-form');
    expect(restored).not.toContain('connections-guide-use-suggestion');
  });

  it('explains that client-credentials apps do not use a browser callback', () => {
    const state = formState();
    state.dialog.values = {
      ...state.dialog.values,
      'auth.type': 'oauth2_client_credentials',
      'auth.client_id': '',
      'auth.client_secret': '',
      'auth.token_endpoint': 'https://oauth.example.com/token',
      'auth.scope': 'records.read',
    };
    const built = buildConnectionSetupGuidePreview(
      apiSchema,
      state.dialog.values,
      'https://developer.example.com/apps',
    );
    if (!built.ok) throw new Error(built.error);
    state.dialog.setupGuide = {
      stage: 'ready',
      targetUrl: built.preview.target_url,
      preview: built.preview,
      error: null,
      resumeAvailable: false,
      resumeFieldKey: null,
      result: {
        shared_context: {
          target_url: built.preview.target_url,
          auth_type: built.preview.auth_type,
          field_keys: [...built.preview.field_keys],
        },
        guide: {
          provider_name: 'Example Cloud',
          overview: 'Create a machine-to-machine app.',
          field_suggestions: [],
          steps: [{
            title: 'Create app',
            instruction: 'Create a client-credentials app.',
            field_keys: ['auth.client_id'],
          }],
          cautions: [],
        },
      },
    };
    const html = renderConnectionsPage(state);
    expect(html).toContain('No callback URL is used');
    expect(html).toContain('machine-to-machine client-credentials flow');
    expect(html).not.toContain(OAUTH_CLOUD_CALLBACK_URL);
    expect(html).toContain('Continue in connection form');
  });

  it('associates a URL error with the URL field', () => {
    const state = formState();
    state.dialog.setupGuide.stage = 'entry';
    state.dialog.setupGuide.error = 'The provider URL must use HTTPS.';
    const html = renderConnectionsPage(state);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-errormessage="connection-setup-guide-url-error"');
    expect(html).toContain('id="connection-setup-guide-url-error"');
  });
});
