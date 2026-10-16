import type { CollectionAuthenticationProvider, CollectionPermissionChoices, CollectionPermissionPreview } from '@recued/contracts';
import { e } from '../template.js';

export const sameCollectionPermissionChoices = (a: CollectionPermissionChoices, b: CollectionPermissionChoices): boolean =>
  a.platform === b.platform && a.slug === b.slug && (a.platform === 'mail' && b.platform === 'mail'
    ? a.send === b.send && a.organize === b.organize : a.platform === 'calendar' && b.platform === 'calendar' && a.edit_events === b.edit_events);

/** Capability choices are local policy; broader vendor scopes never select another choice. */
export const renderCollectionPermissionChoices = (props: {
  owner: 'oauth-app' | 'collection-auth'; disabled: boolean;
  rows: readonly (CollectionPermissionPreview & { provider: CollectionAuthenticationProvider })[];
}): string => {
  if (!props.rows.length) return '';
  return '<section data-collection-permissions><h4>What Recued can do</h4><p>Reading stays on for sync. Turning a choice off disables it in Recued; it does not revoke vendor consent or change other connections.</p>'
    + props.rows.map(({ current, selected, provider }) => {
      const checkbox = (feature: string, label: string, value: boolean, before: boolean, help: string, required = false): string =>
        '<div style="margin:10px 0"><label style="display:flex;align-items:flex-start;gap:8px"><input type="checkbox"'
          + ' data-collection-permission-owner="' + props.owner + '" data-permission-platform="' + selected.platform + '"'
          + ' data-permission-slug="' + e(selected.slug) + '" data-permission-feature="' + feature + '"'
          + (value ? ' checked' : '') + (props.disabled || required ? ' disabled' : '') + '><span>' + e(label) + '</span></label>'
          + '<p style="margin:4px 0 0 24px">' + e(help) + '</p>'
          + (!required ? '<p data-collection-permission-summary style="margin:4px 0 0 24px">' + e(label) + ': '
            + (before ? 'On' : 'Off') + (before !== value ? ' → ' + (value ? 'On' : 'Off') : ' (kept)') + '</p>' : '') + '</div>';
      return '<fieldset style="min-width:0;margin:12px 0;border:1px solid var(--border);border-radius:8px"><legend>'
        + e((selected.platform === 'mail' ? 'Mail' : 'Calendar') + ' · ' + selected.slug) + '</legend>'
        + checkbox('read', selected.platform === 'mail' ? 'Read mail' : 'Read calendars', true, true, 'Required to keep this collection in sync.', true)
        + (selected.platform === 'mail' && current.platform === 'mail'
          ? checkbox('send', 'Send mail', selected.send, current.send, provider === 'graph'
            ? 'Microsoft requires Mail.Send and Mail.ReadWrite: Recued creates a draft, then sends it. Organize mail stays a separate choice.'
            : 'Allow Recued to send mail on your behalf. Organize mail stays a separate choice.')
            + checkbox('organize', 'Organize mail', selected.organize, current.organize, 'Mark messages read or unread, archive them, move them or put them in Trash.')
          : selected.platform === 'calendar' && current.platform === 'calendar'
            ? checkbox('edit_events', 'Create, edit and delete events', selected.edit_events, current.edit_events, 'Also allows responding to event invitations. Calendar sharing settings are not changed.') : '')
        + '</fieldset>';
    }).join('') + '<p>Write actions still follow Recued’s approval rules. Verification reads existing data and checks vendor-reported permissions; it does not send mail or change events.</p></section>';
};
