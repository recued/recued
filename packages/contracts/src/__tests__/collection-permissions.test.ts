import { describe, expect, it } from 'vitest';
import { collectionPermissionScopes, isCollectionPermissionChoices, isCollectionPermissionPreview } from '../collection-permissions.js';

describe('collection permission choices', () => {
  const mail = { platform: 'mail' as const, slug: 'work', read: true as const, send: false, organize: false };
  it('maps Microsoft sending to draft creation and sending without selecting organization', () => {
    const choice = { ...mail, send: true };
    expect(collectionPermissionScopes('graph', choice)).toEqual(['Mail.Read', 'Mail.ReadWrite', 'Mail.Send']);
    expect(choice.organize).toBe(false);
    expect(collectionPermissionScopes('graph', { ...mail, organize: true })).toEqual(['Mail.Read', 'Mail.ReadWrite']);
    expect(collectionPermissionScopes('graph', mail)).toEqual(['Mail.Read']);
  });
  it('keeps Gmail read, sending and organization distinct', () => {
    expect(collectionPermissionScopes('gmail', { ...mail, send: true })).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send']);
    expect(collectionPermissionScopes('gmail', { ...mail, organize: true })).toEqual([
      'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.readonly']);
  });
  it('requests Google event editing without calendar administration and Microsoft calendar writes separately', () => {
    const choice = { platform: 'calendar' as const, slug: 'work', read: true as const, edit_events: true };
    expect(collectionPermissionScopes('gcal', choice)).toEqual([
      'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.readonly']);
    expect(collectionPermissionScopes('graph', choice)).toEqual(['Calendars.Read', 'Calendars.ReadWrite']);
    expect(collectionPermissionScopes('gcal', { ...choice, edit_events: false })).toEqual(['https://www.googleapis.com/auth/calendar.readonly']);
  });
  it.each([null, [], {}, { ...mail, read: false }, { ...mail, send: 'true' }, { ...mail, edit_events: true },
    { ...mail, slug: 'invalid slug' }, { platform: 'calendar', slug: 'work', read: true, edit_events: true, send: true }])('rejects malformed or cross-platform choices %j', choice => {
    expect(isCollectionPermissionChoices(choice)).toBe(false);
  });
  it('binds a permission preview to the same collection', () => {
    expect(isCollectionPermissionPreview({ current: mail, selected: { ...mail, send: true } })).toBe(true);
    expect(isCollectionPermissionPreview({ current: mail, selected: { ...mail, slug: 'another' } })).toBe(false);
    expect(isCollectionPermissionPreview({ current: mail, selected: { platform: 'calendar', slug: 'work', read: true, edit_events: true } })).toBe(false);
  });
});
