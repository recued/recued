/** Editing a saved API connection: what it is, then how it signs in, with the
 *  status beside Save and the first sign-in's setup left to new connections. */
import { describe, expect, it } from 'vitest';
import { initialConnectionsDialogState, initialConnectionsPageState, renderConnectionsPage, type ConnectionsPageProps } from '../index.js';

const edit = (values: Record<string, string> = {}, vendor: string | null = null): ConnectionsPageProps => ({
  ...initialConnectionsPageState(), managedOAuthAvailable: true,
  dialog: { ...initialConnectionsDialogState(), stage: 'form' as const, mode: 'edit' as const, kind: 'api' as const, vendor,
    editingId: 'api/work-sheets', values: { name: 'work-sheets', display_name: 'Work sheets',
      'config.base_url': 'https://sheets.googleapis.com/v4', 'auth.type': 'oauth2_refresh',
      ...(vendor === null ? {} : { 'config.vendor': vendor }), ...values } },
});
const at = (html: string, needle: string): number => { const index = html.indexOf(needle); expect(index, needle).toBeGreaterThan(-1); return index; };

describe('editing a saved API connection', () => {
  it('reads as Connection then Sign-in, with what happens to the saved credentials leading the sign-in fields', () => {
    const html = renderConnectionsPage(edit());
    const order = ['data-connection-form-group="connection"', 'data-conn-field="display_name"', 'data-connection-form-group="sign-in"',
      'data-credential-rotation="current"', 'data-conn-field="auth.type"'].map(needle => at(html, needle));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The note is said once, in its group, and names the tool for signing in again.
    expect(html.match(/data-credential-rotation=/g)).toHaveLength(1);
    expect(html).toContain('To sign in again or change how it signs in, use Manage authentication.');
    expect(html).toContain('data-action="connections-manage-authentication"');
  });

  it('shows the sign-in card only once a replacement is under way, and lists only credentials in it', () => {
    let html = renderConnectionsPage(edit());
    // Nothing to enter yet: no "required details left" beside a form that is complete.
    expect(html).not.toContain('data-action="connections-authorize-vendor"'); expect(html).not.toContain('data-oauth-requirement');
    expect(html).toMatch(/<label[^>]*>Client ID<\/label>/);
    html = renderConnectionsPage(edit({ 'auth.client_id': 'replacement-app' }));
    expect(html).toContain('data-action="connections-authorize-vendor"'); expect(html).toContain('data-credential-rotation="replacement"');
    expect(html).toContain('data-oauth-requirement="auth.client_id"');
    // The saved name and label are not credentials to collect.
    expect(html).not.toContain('data-oauth-requirement="name"'); expect(html).not.toContain('data-oauth-requirement="display_name"');
    expect(html).toMatch(/<label[^>]*>Client ID <span class="connections-field-required">\*<\/span><\/label>/);
  });

  it('leaves first sign-in notices to new connections, keeps its help below the fields and its status by Save', () => {
    const create = edit({}, 'google'); create.dialog.mode = 'create'; create.dialog.editingId = null;
    expect(renderConnectionsPage(create)).toContain('Connection consent');
    const html = renderConnectionsPage(edit({}, 'google'));
    expect(html).not.toContain('Connection consent');
    const order = ['data-conn-field="auth.refresh_token"', 'data-connection-guide-panel', 'data-connection-form-validation',
      'data-action="connections-submit-form"'].map(needle => at(html, needle));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The locked name carries no required mark and says why it stays.
    expect(html).toMatch(/<label[^>]*>Name<\/label>/);
    expect(html).toContain('refer to the connection by this name, so it stays as it is');
  });
});
