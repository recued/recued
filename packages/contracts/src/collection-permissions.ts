/** Owner choices for an existing collection. Vendor grants may be broader. */
export type CollectionPermissionChoices =
  | { platform: 'mail'; slug: string; read: true; send: boolean; organize: boolean }
  | { platform: 'calendar'; slug: string; read: true; edit_events: boolean };

export interface CollectionPermissionPreview {
  current: CollectionPermissionChoices;
  selected: CollectionPermissionChoices;
}

export const isCollectionPermissionChoices = (value: unknown): value is CollectionPermissionChoices => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.slug !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(v.slug) || v.read !== true) return false;
  const keys = v.platform === 'mail' ? ['platform', 'slug', 'read', 'send', 'organize']
    : v.platform === 'calendar' ? ['platform', 'slug', 'read', 'edit_events'] : [];
  return keys.length > 0 && Object.keys(v).length === keys.length && Object.keys(v).every(k => keys.includes(k))
    && (v.platform === 'mail' ? typeof v.send === 'boolean' && typeof v.organize === 'boolean' : typeof v.edit_events === 'boolean');
};

export const isCollectionPermissionPreview = (value: unknown): value is CollectionPermissionPreview => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return isCollectionPermissionChoices(v.current) && isCollectionPermissionChoices(v.selected)
    && v.current.platform === v.selected.platform && v.current.slug === v.selected.slug;
};

/** Recued's Microsoft send creates a draft before sending: both grants are required. */
export const collectionPermissionScopes = (provider: 'gmail' | 'gcal' | 'graph', choice: CollectionPermissionChoices): string[] => {
  if (choice.platform === 'mail') {
    if (provider === 'gcal') return [];
    return [...new Set(provider === 'gmail' ? ['https://www.googleapis.com/auth/gmail.readonly',
      ...(choice.send ? ['https://www.googleapis.com/auth/gmail.send'] : []),
      ...(choice.organize ? ['https://www.googleapis.com/auth/gmail.modify'] : [])]
      : ['Mail.Read', ...(choice.send ? ['Mail.Send', 'Mail.ReadWrite'] : []), ...(choice.organize ? ['Mail.ReadWrite'] : [])])].sort();
  }
  if (provider === 'gmail') return [];
  return (provider === 'gcal' ? ['https://www.googleapis.com/auth/calendar.readonly',
    ...(choice.edit_events ? ['https://www.googleapis.com/auth/calendar.events'] : [])]
    : ['Calendars.Read', ...(choice.edit_events ? ['Calendars.ReadWrite'] : [])]).sort();
};
