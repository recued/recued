/** D-322 §22 — account status cannot overstate authorization or expose markup. */
import { describe, expect, it } from 'vitest';
import type { ManagedOAuthAccountUsage } from '@recued/contracts';
import { renderManagedOAuthAccountUsage } from '../settings/managed-oauth-account-view.js';

const usage: ManagedOAuthAccountUsage = { connection_id: 'account', auth_error: false, warnings: ['Other tools may use it.'],
  connections: [{ name: 'sheets', display_name: 'Sheets', updated_at: 2, health: { status: 'unknown' }, uses: [], usage_available: true }] };
const render = (patch: Partial<Parameters<typeof renderManagedOAuthAccountUsage>[0]> = {}) =>
  renderManagedOAuthAccountUsage({ usage, loading: false, error: '', canOpen: true, canCheck: true, disabled: false, ...patch });

describe('D-322 account usage view', () => {
  it('keeps broker authorization separate from API access and names the timestamps', () => {
    const html = render();
    expect(html).toContain('Nango reports no authorization error');
    expect(html).toContain('API access needs a check');
    expect(html).toContain('Last API check'); expect(html).toContain('Last recorded use');
    expect(html).toContain('Other tools may use it.'); expect(html).not.toContain('healthy');
  });
  it('shows concrete repair, probe and usage actions', () => {
    const html = render({ usage: { ...usage, auth_error: true, connections: [{ ...usage.connections[0]!,
      health: { status: 'auth_failed', last_probed_at: 1 }, uses: [{ kind: 'pack', id: 'sales', label: 'Sales' },
        { kind: 'mail', id: 'mail', label: 'Work inbox' }, { kind: 'calendar', id: 'cal', label: 'Work calendar' },
        { kind: 'file', id: 'drive', label: 'Work files' }] }] } });
    expect(html).toContain('sign in again'); expect(html).toContain('Open connection'); expect(html).toContain('Check API access');
    for (const label of ['Sales', 'Work inbox', 'Work calendar', 'Work files']) expect(html).toContain(label);
  });
  it('escapes all names and labels, including action identities', () => {
    const html = render({ usage: { ...usage, warnings: ['<script>'], connections: [{ ...usage.connections[0]!,
      name: '" onclick="bad()', display_name: '<img src=x>', uses: [{ kind: 'file', id: 'file', label: '<iframe>' }] }] } });
    expect(html).not.toMatch(/<script>|<img|<iframe|data-managed-name="" onclick/);
    expect(html).toContain('&lt;img'); expect(html).toContain('data-managed-name="&quot; onclick=');
  });
  it('shows incomplete references, empty accounts, loading and retry as distinct states', () => {
    expect(render({ usage: { ...usage, connections: [] } })).toContain('No saved Recued API connections');
    expect(render({ usage: { ...usage, connections: [{ ...usage.connections[0]!, usage_available: false }] } })).toContain('Local bindings could not be read');
    expect(render({ loading: true })).toContain('Loading account usage');
    const failed = render({ error: 'Network failed' });
    expect(failed).toContain('Retry account usage'); expect(failed).not.toContain('No saved');
  });
  it('omits unsupported actions and disables repeated checks', () => {
    expect(render({ canOpen: false, canCheck: false })).not.toMatch(/Open connection|Check API access/);
    expect(render({ checking: 'sheets' })).toContain('Checking API access…');
    expect(render({ checking: 'sheets' })).toMatch(/data-managed-action="check-connection"[^>]+ disabled/);
  });
  it('keeps known failures visible when the browser clock trails the server', () => {
    for (const status of ['auth_failed', 'unreachable'] as const) {
      expect(render({ now: 100, usage: { ...usage, connections: [{ ...usage.connections[0]!,
        health: { status, last_probed_at: 200 } }] } })).toContain(`data-managed-health="${status}"`);
    }
  });
});
