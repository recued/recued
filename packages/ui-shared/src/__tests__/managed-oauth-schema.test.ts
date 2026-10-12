/** D-322 — direct and managed setup, verified receipts and same-account editing. */
import { describe, expect, it } from 'vitest';
import { resolveConnectionSchema, projectConnectionPayload, buildConnectionEditDialogPatch,
  connectionFormValidationIssue, shouldPatchConnectionAuth, renderConnectionsPage, initialConnectionsPageState } from '../index.js';

const values = { name: 'work', display_name: 'Work', 'config.base_url': 'https://www.googleapis.com/drive/v3',
  'config.vendor': 'google', 'auth.type': 'managed_oauth', 'auth.broker_profile_id': 'cloud', 'auth.integration_id': 'drive' };
describe('managed OAuth form schema', () => {
  it('edits a local scope request independently of broader authorization history', () => {
    const auth = { type: 'managed_oauth' as const, broker_profile_id: 'cloud', integration_id: 'drive', connection_id: 'remote',
      target_origin: 'https://www.googleapis.com', requested_scopes: ['drive.readonly', 'drive.file'], required_scopes: ['drive.readonly'] };
    const edit = buildConnectionEditDialogPatch({ name: 'work', display_name: 'Work', kind: 'api', vendor: 'google',
      base_url: values['config.base_url'], auth_type: 'managed_oauth', managed_oauth: auth });
    const schema = resolveConnectionSchema('api', undefined, 'google', 'managed_oauth')!;
    expect(edit.values['auth.scopes']).toBe('drive.readonly');
    expect(shouldPatchConnectionAuth(schema, edit.values)).toBe(false);
    const scopeEdit = { ...edit.values, 'auth.scopes': '' };
    expect(shouldPatchConnectionAuth(schema, scopeEdit)).toBe(true);
    expect(connectionFormValidationIssue(schema, scopeEdit, undefined, 'edit')?.message).toContain('Authorize');
    const projected = projectConnectionPayload(schema, { ...edit.values, 'auth.authorization_receipt': 'receipt' }, 'api', null);
    expect(projected.auth).toMatchObject(auth);
  });
  it('offers managed setup on OAuth vendors while retaining direct setup', () => {
    const direct = resolveConnectionSchema('api', undefined, 'google', 'oauth2_refresh')!;
    expect(direct.fields.find((f) => f.key === 'auth.type')?.options).toContain('managed_oauth');
    const managed = resolveConnectionSchema('api', undefined, 'google', 'managed_oauth')!;
    expect(managed.fields.find((f) => f.key === 'auth.type')?.help).toBe('The selected broker manages vendor sign-in and token refresh.');
    expect(managed.fields.some((f) => f.key === 'auth.client_secret')).toBe(false);
    expect(connectionFormValidationIssue(managed, values, undefined, 'create')?.message).toContain('Authorize');
    expect(resolveConnectionSchema('api', undefined, 'notion', 'bearer')!.fields.find((f) => f.key === 'auth.type')?.options).toContain('managed_oauth');
  });
  it('projects server-issued references and never needs an OAuth application secret', () => {
    const schema = resolveConnectionSchema('api', undefined, 'google', 'managed_oauth')!;
    const authorized = { ...values, 'auth.connection_id': 'remote', 'auth.target_origin': 'https://www.googleapis.com',
      'auth.requested_scopes': '["drive.readonly"]', 'auth.authorization_receipt': 'receipt' };
    expect(connectionFormValidationIssue(schema, authorized, undefined, 'create')).toBeNull();
    const payload = projectConnectionPayload(schema, authorized, 'api', null);
    expect(payload.auth).toMatchObject({ type: 'managed_oauth', connection_id: 'remote', requested_scopes: ['drive.readonly'], authorization_receipt: 'receipt' });
    expect(payload.auth).not.toHaveProperty('client_secret');
    const page = initialConnectionsPageState();
    page.dialog = { ...page.dialog, stage: 'form', kind: 'api', vendor: 'google', values: authorized };
    const html = renderConnectionsPage(page);
    expect(html).toContain('data-managed-oauth-host'); expect(html).not.toContain('data-action="connections-authorize-vendor"');
  });
  it('restores non-secret account references without treating them as a credential replacement', () => {
    const edit = buildConnectionEditDialogPatch({ name: 'work', display_name: 'Work', kind: 'api', vendor: 'google', base_url: values['config.base_url'], auth_type: 'managed_oauth',
      managed_oauth: { type: 'managed_oauth', broker_profile_id: 'cloud', integration_id: 'drive', connection_id: 'remote', target_origin: 'https://www.googleapis.com', requested_scopes: ['drive.readonly'] } });
    expect(edit.values['auth.type']).toBe('managed_oauth'); expect(edit.values['auth.connection_id']).toBe('remote');
    const schema = resolveConnectionSchema('api', undefined, 'google', 'managed_oauth')!;
    expect(shouldPatchConnectionAuth(schema, edit.values)).toBe(false);
    expect(connectionFormValidationIssue(schema, edit.values, undefined, 'edit')).toBeNull();
    const scopeEdit = { ...edit.values, 'auth.scopes': 'drive.readonly drive.file' };
    expect(shouldPatchConnectionAuth(schema, scopeEdit)).toBe(true);
    expect(connectionFormValidationIssue(schema, scopeEdit, undefined, 'edit')?.message).toContain('Authorize');
    expect(shouldPatchConnectionAuth(schema, { ...edit.values, 'auth.authorization_receipt': 'receipt' })).toBe(true);
  });
  it('retains an imported account’s scope history through enrollment and edit projection', () => {
    const schema = resolveConnectionSchema('api', undefined, 'google', 'managed_oauth')!;
    const auth = { type: 'managed_oauth' as const, broker_profile_id: 'cloud', integration_id: 'drive',
      connection_id: 'remote', target_origin: 'https://www.googleapis.com', requested_scopes: [], imported: true as const };
    const input = { ...values, 'auth.connection_id': auth.connection_id, 'auth.target_origin': auth.target_origin,
      'auth.requested_scopes': '[]', 'auth.imported': 'true', 'auth.authorization_receipt': 'receipt' };
    expect(connectionFormValidationIssue(schema, input, undefined, 'create')).toBeNull();
    expect(projectConnectionPayload(schema, input, 'api', null).auth).toMatchObject(auth);
    const edit = buildConnectionEditDialogPatch({ name: 'work', display_name: 'Work', kind: 'api', vendor: 'google',
      base_url: values['config.base_url'], auth_type: 'managed_oauth', managed_oauth: auth });
    expect(edit.values['auth.imported']).toBe('true');
    expect(shouldPatchConnectionAuth(schema, edit.values)).toBe(false);
    expect(connectionFormValidationIssue(schema, edit.values, undefined, 'edit')).toBeNull();
  });
});
