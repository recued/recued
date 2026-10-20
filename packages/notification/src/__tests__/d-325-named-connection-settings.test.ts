import { createInMemoryCollection } from '@recued/storage';
import { describe, expect, it } from 'vitest';
import { createNotificationSettings, createNotificationSettingsStore, type NotificationSettings } from '../index.js';

describe('D-325 named notification connection', () => {
  it('requires a choice among two connections and keeps its enrollment pinned across other axis edits', async () => {
    let roster = [
      { name: 'private', display_name: 'My chat', enrolled_at: 100 },
      { name: 'household', display_name: 'Family group', enrolled_at: 200 },
    ];
    const backing = createInMemoryCollection<NotificationSettings>();
    const store = createNotificationSettingsStore(backing);
    const surface = () => createNotificationSettings({ store, readinessProbe: () => true,
      connectionRosterProbe: async channel => channel === 'telegram' ? roster : [] });
    expect((await surface().describe()).find(row => row.channel === 'telegram')?.ready).toBe(false);
    expect(await surface().setChannelMode('telegram', { notification: true })).toMatchObject({ ok: false, reason: 'not_ready' });
    expect(await surface().setChannelMode('telegram', { connection: { name: 'private', enrolled_at: 100 }, notification: true }))
      .toMatchObject({ ok: true });
    await surface().setChannelMode('telegram', { approval: true });
    const restarted = createNotificationSettingsStore(backing);
    expect((await restarted.get()).telegram).toEqual({ connection: { name: 'private', enrolled_at: 100 },
      notification: true, approval: true, messenger: false });
    // Re-enrolling the same name must not acquire the old selection.
    roster = [{ name: 'private', display_name: 'New private', enrolled_at: 300 }];
    expect((await surface().describe()).find(row => row.channel === 'telegram')?.ready).toBe(false);
    expect((await store.get()).telegram.connection?.enrolled_at).toBe(100);
    expect(await surface().setChannelMode('telegram', { connection: { name: 'private', enrolled_at: 300 } })).toMatchObject({ ok: true });
    expect((await surface().describe()).find(row => row.channel === 'telegram')?.ready).toBe(true);
  });

  it('allows a sole legacy connection but never silently replaces an explicitly missing selection', async () => {
    const store = createNotificationSettingsStore(createInMemoryCollection<NotificationSettings>());
    const surface = createNotificationSettings({ store, readinessProbe: () => true,
      connectionRosterProbe: async channel => channel === 'email' ? [{ name: 'email', display_name: 'Email', enrolled_at: 1 }] : [] });
    expect(await surface.setChannelMode('email', { notification: true })).toMatchObject({ ok: true });
    expect(await surface.setChannelMode('email', { connection: { name: 'other', enrolled_at: 9 } })).toMatchObject({ ok: false });
    await surface.setChannelMode('email', { connection: null });
    expect((await surface.describe()).find(row => row.channel === 'email')?.ready).toBe(false);
    expect((await store.get()).email.notification).toBe(true);
  });
});

describe('D-158 amendment 2026-10-19 — the connection plain notifications go through', () => {
  it('shows it on each messenger and email row, beside the reminders’ choice, and never for the Bridge', async () => {
    const asked: string[] = [];
    const surface = createNotificationSettings({
      store: createNotificationSettingsStore(createInMemoryCollection<NotificationSettings>()),
      readinessProbe: () => true,
      plainConnectionProbe: async channel => {
        asked.push(channel);
        return channel === 'telegram' ? { name: 'telegram', display_name: 'Recued bot' } : null;
      },
    });
    const rows = await surface.describe();
    expect(rows.find(row => row.channel === 'telegram')?.plain_connection).toEqual({ name: 'telegram', display_name: 'Recued bot' });
    expect(rows.find(row => row.channel === 'email')?.plain_connection).toBeNull();
    expect(rows.find(row => row.channel === 'bridge')).not.toHaveProperty('plain_connection');
    expect(rows.find(row => row.channel === 'ui')).not.toHaveProperty('plain_connection');
    expect(asked).not.toContain('bridge');
    // Without the probe, as on a surface composed without one, the field is absent, not null.
    const unprobed = await createNotificationSettings({
      store: createNotificationSettingsStore(createInMemoryCollection<NotificationSettings>()),
      readinessProbe: () => true,
    }).describe();
    expect(unprobed.filter(row => 'plain_connection' in row)).toEqual([]);
  });
});
