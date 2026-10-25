/** Adding an API connection: what it is, then how it signs in, chosen first
 *  from the three ways most services take. */
import { describe, expect, it } from 'vitest';
import { initialConnectionsDialogState, initialConnectionsPageState, renderConnectionsPage, type ConnectionsPageProps } from '../index.js';

const add = (authType: string, managedOAuthAvailable = true, vendor: string | null = null): ConnectionsPageProps => ({
  ...initialConnectionsPageState(), managedOAuthAvailable,
  dialog: { ...initialConnectionsDialogState(), stage: 'form' as const, mode: 'create' as const, kind: 'api' as const, vendor,
    values: { 'auth.type': authType, ...(vendor === null ? {} : { 'config.vendor': vendor }) } },
});
const at = (html: string, needle: string): number => { const index = html.indexOf(needle); expect(index, needle).toBeGreaterThan(-1); return index; };
const otherWays = (html: string): string => html.slice(at(html, 'data-conn-field="auth.type"'), html.indexOf('</select>', at(html, 'data-conn-field="auth.type"')));

describe('adding an API connection', () => {
  it('asks how it signs in with three cards under Sign-in, and every other way in one select', () => {
    const html = renderConnectionsPage(add('bearer'));
    const order = ['data-connection-form-group="connection"', 'data-connection-form-group="sign-in"', 'How it signs in',
      'data-auth-type="oauth2_refresh"', 'data-auth-type="managed_oauth"', 'data-auth-type="bearer"', 'Other ways to sign in'].map(needle => at(html, needle));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toMatch(/data-auth-type="bearer" aria-pressed="true"/);
    // One select still carries the field; it lists only what the cards do not.
    expect(html.match(/data-conn-field="auth.type"/g)).toHaveLength(1);
    for (const card of ['oauth2_refresh', 'managed_oauth', 'bearer']) expect(otherWays(html)).not.toContain('value="' + card + '"');
    expect(otherWays(html)).toContain('value="header"');
    // The page around it can tell a new connection is being added.
    expect(html).toContain('data-dialog-mode="create"');
  });

  it('shows a method chosen from the select there, with no card pressed', () => {
    const html = renderConnectionsPage(add('header'));
    expect(html).not.toMatch(/data-action="connections-choose-auth"[^>]*aria-pressed="true"/);
    expect(otherWays(html)).toMatch(/<option value="header" selected>/);
  });

  it('offers the broker card only where the server can use a broker', () => {
    expect(renderConnectionsPage(add('bearer', false))).not.toContain('data-auth-type="managed_oauth"');
  });

  it('asks for the OAuth app before the refresh token that Authorize fills in', () => {
    const html = renderConnectionsPage(add('oauth2_refresh'));
    expect(at(html, 'data-conn-field="auth.client_id"')).toBeLessThan(at(html, 'data-conn-field="auth.scopes"'));
    expect(at(html, 'data-conn-field="auth.scopes"')).toBeLessThan(at(html, 'data-conn-field="auth.refresh_token"'));
  });

  it('keeps a service-specific form on its own list of ways to connect', () => {
    expect(renderConnectionsPage(add('oauth2_refresh', true, 'google'))).not.toContain('data-action="connections-choose-auth"');
  });
});
