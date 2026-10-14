/** D-322 §23 — the switch form pins identity and requires review before verification. */
import { describe, expect, it } from 'vitest';
import { initialConnectionsDialogState, initialConnectionsPageState, renderConnectionsPage,
  resolveConnectionSchema, withAuthenticationSwitchSchema, connectionFormValidationIssue, type ConnectionsPageProps } from '../index.js';
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
    expect(schema.fields.find(field => field.key === 'auth.type')?.hidden).toBe(true);
    expect(schema.fields.find(field => field.key === 'auth.scopes')?.readonly).not.toBe(true);
    expect(connectionFormValidationIssue(schema, values, undefined, 'edit')?.message).toContain('Review permissions');
    expect(connectionFormValidationIssue(schema, { ...values, 'auth.authorization_receipt': 'reviewed' }, undefined, 'edit')).toBeNull();
    expect(schema.onboarding).toBeUndefined(); expect(schema.probe).toBeUndefined();
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
  it('offers switching only for a saved compatible credential when the broker RPC is available', () => {
    const view = state(); view.dialog.authenticationSwitch = null;
    view.dialog.values['auth.type'] = 'oauth2_refresh';
    expect(renderConnectionsPage(view)).toContain('data-action="connections-switch-authentication"');
    expect(renderConnectionsPage({ ...view, managedOAuthAvailable: false })).not.toContain('data-action="connections-switch-authentication"');
    view.dialog.values['auth.type'] = 'basic';
    expect(renderConnectionsPage(view)).not.toContain('data-action="connections-switch-authentication"');
    view.dialog.mode = 'create';
    expect(renderConnectionsPage(view)).not.toContain('data-action="connections-switch-authentication"');
  });
});
