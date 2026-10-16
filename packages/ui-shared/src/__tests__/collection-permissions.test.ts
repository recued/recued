import { describe, expect, it } from 'vitest';
import { renderCollectionPermissionChoices } from '../connections/collection-permissions.js';

describe('collection permission explanations', () => {
  it('offers a single Microsoft Send mail choice and explains both vendor permissions', () => {
    const current = { platform: 'mail' as const, slug: 'work', read: true as const, send: false, organize: false };
    const html = renderCollectionPermissionChoices({ owner: 'oauth-app', disabled: false,
      rows: [{ provider: 'graph', current, selected: { ...current, send: true } }] });
    expect(html).toContain('Send mail'); expect(html).toContain('Mail.Send and Mail.ReadWrite'); expect(html).toContain('creates a draft, then sends it');
    expect(html).toMatch(/data-permission-feature="send" checked>/); expect(html).toMatch(/data-permission-feature="organize">/);
    expect(html).toMatch(/data-permission-feature="read" checked disabled>/);
    expect(html).toContain('Send mail: Off → On'); expect(html).toContain('Organize mail: Off (kept)');
    expect(html).toContain('does not revoke vendor consent'); expect(html).not.toContain('data-permission-feature="Mail.ReadWrite"');
  });
  it('states event deletion and invitation access and locks choices while verifying', () => {
    const current = { platform: 'calendar' as const, slug: 'work', read: true as const, edit_events: false };
    const html = renderCollectionPermissionChoices({ owner: 'collection-auth', disabled: true,
      rows: [{ provider: 'gcal', current, selected: { ...current, edit_events: true } }] });
    expect(html).toContain('Create, edit and delete events'); expect(html).toContain('responding to event invitations');
    expect(html).toContain('does not send mail or change events'); expect(html).toMatch(/data-permission-feature="edit_events" checked disabled>/);
  });
});
