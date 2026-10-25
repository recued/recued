/** D-322 §23 — the switch form pins identity and requires review before verification. */
import { describe, expect, it } from 'vitest';
import { initialConnectionsDialogState, initialConnectionsPageState, renderConnectionsPage,
  resolveConnectionSchema, withAuthenticationSwitchSchema, connectionFormValidationIssue, connectionFormValidationSummary,
  type ConnectionsPageProps } from '../index.js';
import type { ConnectionView } from '@recued/contracts';

const original: ConnectionView = { name: 'work-sheets', kind: 'api', display_name: 'Work sheets',
  base_url: 'https://sheets.googleapis.com/v4', auth_type: 'oauth2_refresh', updated_at: 2 };
const values = { name: original.name, display_name: original.display_name,
  'config.base_url': original.base_url as string, 'auth.type': 'managed_oauth',
  'auth.broker_profile_id': 'cloud', 'auth.integration_id': 'sheets', 'auth.connection_id': 'new-account',
  'auth.target_origin': 'https://sheets.googleapis.com', 'auth.requested_scopes': '[]',
  'switch.verification_url': 'https://docs.google.com/spreadsheets/d/test-sheet/edit' };
const state = (): ConnectionsPageProps => ({ ...initialConnectionsPageState(), managedOAuthAvailable: true,
  dialog: { ...initialConnectionsDialogState(), stage: 'form' as const, mode: 'edit' as const, kind: 'api' as const,
    editingId: 'api/work-sheets', values: { ...values }, authenticationSwitch: original } });

describe('authentication switch form', () => {
  it('pins the saved name, label and API while allowing scopes and a resource check', () => {
    const schema = withAuthenticationSwitchSchema(resolveConnectionSchema('api', undefined, undefined, 'managed_oauth')!);
    expect(schema.fields.filter(field => !field.key.startsWith('auth.') && field.key !== 'switch.verification_url')
      .every(field => field.readonly)).toBe(true);
    expect(schema.fields.find(field => field.key === 'auth.type')?.hidden).toBe(false);
    expect(schema.fields.find(field => field.key === 'auth.type')?.options).toEqual(['oauth2_refresh', 'managed_oauth']);
    expect(schema.fields.find(field => field.key === 'auth.scopes')?.readonly).not.toBe(true);
    expect(connectionFormValidationIssue(schema, values, undefined, 'edit')?.message).toContain('Review permissions');
    expect(connectionFormValidationIssue(schema, { ...values, 'auth.authorization_receipt': 'reviewed' }, undefined, 'edit')).toBeNull();
    expect(schema.onboarding).toBeUndefined(); expect(schema.probe).toBeUndefined();
  });
  it('offers direct OAuth review while keeping the service pinned and apply disabled before review', () => {
    const view = state(); view.dialog.values['auth.type'] = 'oauth2_refresh';
    const html = renderConnectionsPage(view);
    expect(html).toContain('Recued direct OAuth'); expect(html).toContain('connections-review-direct-authentication');
    expect(html).toMatch(/data-action="connections-submit-form"[^>]*disabled/);
    const schema = withAuthenticationSwitchSchema(resolveConnectionSchema('api', undefined, undefined, 'oauth2_refresh')!);
    expect(connectionFormValidationIssue(schema, view.dialog.values, undefined, 'edit')?.message).toContain('review its account');
    expect(schema.fields.find(field => field.key === 'config.base_url')?.readonly).toBe(true);
  });
  it('explains the account change and gates Verify and switch on its authorization receipt', () => {
    const view = state(); const html = renderConnectionsPage(view);
    expect(html).toContain('Switch authentication'); expect(html).toContain('Work sheets');
    expect(html).toContain('Read-only access check URL'); expect(html).toContain('Keep current authentication');
    expect(html).toMatch(/data-action="connections-submit-form"[^>]*disabled/);
    view.dialog.values['auth.authorization_receipt'] = 'reviewed';
    expect(renderConnectionsPage(view)).not.toMatch(/data-action="connections-submit-form"[^>]*disabled/);
    view.dialog.saving = true;
    expect(renderConnectionsPage(view)).toContain('Verifying and switching');
    expect(renderConnectionsPage(view)).toMatch(/data-action="connections-cancel-authentication-switch"[^>]*disabled/);
  });
  it('names the connection an edit changes, groups a broker form into connection and sign-in, and keeps the draft note by the buttons', () => {
    const view = state(); view.dialog.authenticationSwitch = null;
    const html = renderConnectionsPage(view);
    expect(html).toMatch(/data-connection-dialog-heading[^>]*>\s*Edit Work sheets\s*</);
    const connectionGroup = html.indexOf('data-connection-form-group="connection"');
    const signInGroup = html.indexOf('data-connection-form-group="sign-in"');
    expect(connectionGroup).toBeGreaterThan(-1);
    expect(signInGroup).toBeGreaterThan(html.indexOf('data-conn-field="config.base_url"'));
    expect(signInGroup).toBeLessThan(html.indexOf('data-conn-field="auth.type"'));
    expect(html.match(/data-connection-form-group=/g)).toHaveLength(2);
    // The draft note sits with the actions it is about, after every field.
    expect(html.indexOf('data-connection-draft-protection')).toBeGreaterThan(html.indexOf('data-managed-oauth-host'));
    expect(html.indexOf('data-connection-draft-protection')).toBeLessThan(html.indexOf('data-action="connections-submit-form"'));
  });
  it('lays a direct switch out as numbered steps, each holding its own controls, in the order they are done', () => {
    const view = state(); view.dialog.authenticationManagement = 'reauthorize'; view.dialog.values['auth.type'] = 'oauth2_refresh';
    const html = renderConnectionsPage(view);
    const at = (needle: string): number => { const index = html.indexOf(needle); expect(index, needle).toBeGreaterThan(-1); return index; };
    const order = ['data-authentication-switch-step="sign-in"', 'data-conn-field="auth.scopes"', 'data-action="connections-authorize-vendor"',
      'data-authentication-switch-step="review"', 'data-action="connections-review-direct-authentication"',
      'data-authentication-switch-step="check"', 'data-conn-field="switch.verification_url"',
      // What still holds Apply back is said right above it, after every step.
      'data-connection-form-validation', 'data-action="connections-submit-form"'].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The saved name and label cannot change, so the intro names them instead of two locked fields.
    expect(html).not.toContain('data-conn-field="name"'); expect(html).not.toContain('data-conn-field="display_name"');
    expect(html).toContain('Its name (<code>work-sheets</code>), linked Packs and saved data stay the same.');
    expect(html).toContain('Your current sign-in stays active until the check passes.');
    // The title already says Manage authentication: the box under it carries no second heading.
    expect(html).not.toContain('data-manage-authentication-heading');
  });
  it('a broker switch signs in through the broker panel, then checks access; the address it cannot change is shown once', () => {
    const html = renderConnectionsPage(state());
    expect(html).not.toContain('data-authentication-switch-step="review"');
    const signIn = html.indexOf('data-authentication-switch-step="sign-in"'); const check = html.indexOf('data-authentication-switch-step="check"');
    expect(signIn).toBeGreaterThan(-1); expect(check).toBeGreaterThan(signIn);
    expect(html.indexOf('data-managed-oauth-host')).toBeGreaterThan(signIn); expect(html.indexOf('data-managed-oauth-host')).toBeLessThan(check);
    expect(html.match(/data-connection-form-group="[a-z-]+"/g)).toEqual(['data-connection-form-group="connection"']);
    expect(html.indexOf('data-conn-field="config.base_url"')).toBeLessThan(signIn);
  });
  it('sends "Go to" to the step that comes next, and calls a finished switch ready to verify rather than to save', () => {
    const schema = withAuthenticationSwitchSchema(resolveConnectionSchema('api', undefined, undefined, 'oauth2_refresh')!);
    const direct = { ...values, 'auth.type': 'oauth2_refresh' };
    expect(connectionFormValidationSummary(connectionFormValidationIssue(schema, direct, undefined, 'edit')))
      .toMatchObject({ title: 'Next: Sign in', fieldKey: 'switch.step.sign-in', actionLabel: 'Go to step 1' });
    // A pasted refresh token stands in for authorizing: review is next.
    expect(connectionFormValidationSummary(connectionFormValidationIssue(schema, { ...direct, 'auth.refresh_token': 'pasted' }, undefined, 'edit')))
      .toMatchObject({ title: 'Next: Review the sign-in', fieldKey: 'switch.step.review', actionLabel: 'Go to step 2' });
    expect(connectionFormValidationSummary(connectionFormValidationIssue(withAuthenticationSwitchSchema(
      resolveConnectionSchema('api', undefined, undefined, 'managed_oauth')!), values, undefined, 'edit')))
      .toMatchObject({ fieldKey: 'switch.step.sign-in', actionLabel: 'Go to step 1' });
    // Each target is on the page, as the step it names.
    const view = state(); view.dialog.values['auth.type'] = 'oauth2_refresh';
    const html = renderConnectionsPage(view);
    expect(html).toContain('data-field-key="switch.step.sign-in"'); expect(html).toContain('data-field-key="switch.step.review"');
    expect(connectionFormValidationSummary(null, true)).toMatchObject({ status: 'ready', title: 'Ready to verify' });
    expect(connectionFormValidationSummary(null)).toMatchObject({ status: 'ready', title: 'Required details complete' });
  });
  it('says why a locked method or app cannot change, with no required mark on it', () => {
    const view = state(); view.dialog.authenticationManagement = 'reauthorize'; view.dialog.values['auth.type'] = 'oauth2_refresh';
    view.dialog.values['auth.client_id'] = 'current-app';
    let html = renderConnectionsPage(view);
    expect(html).toContain('Re-authorizing keeps this method.'); expect(html).toContain('Your current OAuth app.');
    expect(html).toMatch(/<label[^>]*>Authentication method<\/label>/);
    // Re-authorizing keeps the app, so there is no new app for the setup guide to help with.
    expect(html).not.toContain('data-connection-guide-panel');
    view.dialog.authenticationManagement = 'method';
    html = renderConnectionsPage(view);
    expect(html).toMatch(/<label[^>]*>New authentication <span class="connections-field-required">\*<\/span><\/label>/);
    expect(html.indexOf('data-connection-guide-panel')).toBeGreaterThan(html.indexOf('data-authentication-switch-step="check"'));
  });
  it('offers switching only for a saved compatible credential when the broker RPC is available', () => {
    const view = state(); view.dialog.authenticationSwitch = null;
    view.dialog.values['auth.type'] = 'oauth2_refresh';
    expect(renderConnectionsPage(view)).toContain('data-action="connections-manage-authentication"');
    expect(renderConnectionsPage({ ...view, managedOAuthAvailable: false })).not.toContain('data-action="connections-manage-authentication"');
    view.dialog.values['auth.type'] = 'basic';
    expect(renderConnectionsPage(view)).not.toContain('data-action="connections-manage-authentication"');
    view.dialog.mode = 'create';
    expect(renderConnectionsPage(view)).not.toContain('data-action="connections-manage-authentication"');
  });
});


it('offers a shared authentication chooser with reauthorization as its explicit current-method operation', () => {
  const view = state(); view.dialog.authenticationManagement = 'reauthorize'; view.dialog.authenticationManagementCanChangeApp = true;
  view.dialog.values['auth.type'] = 'oauth2_refresh';
  const html = renderConnectionsPage(view);
  expect(html).toContain('Manage authentication'); expect(html).toContain('Re-authorize current sign-in');
  expect(html).toContain('Change OAuth app'); expect(html).toContain('Change authentication method');
  expect(html).toContain('Verify and apply');
  view.dialog.authenticationRepair = true;
  expect(renderConnectionsPage(view)).not.toContain('Change authentication method');
});
