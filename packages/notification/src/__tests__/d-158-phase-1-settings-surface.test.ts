import { CHANNEL_ROLES, MESSENGER_VENDOR_SLUGS } from '@recued/contracts';
import { createInMemoryCollection } from '@recued/storage';
import { describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_INSTALL_URL,
  createNotificationSettings,
  createNotificationSettingsStore,
  type ChannelReadinessProbe,
  type NotificationSettings,
  type NotificationSettingsStore,
} from '../index.js';

const createSettingsStore = (): NotificationSettingsStore =>
  createNotificationSettingsStore(createInMemoryCollection<NotificationSettings>());

describe('D-158 P1 / D-163 P0 NotificationSettings surface', () => {
  it('get delegates to the injected store', async () => {
    const settings: NotificationSettings = {
      ui: true,
      bridge: false,
      slack: { notification: true, approval: true, messenger: false },
      telegram: { notification: false, approval: false, messenger: false },
      whatsapp: { notification: false, approval: false, messenger: false },
      discord: { notification: false, approval: false, messenger: false },
      teams: { notification: false, approval: false, messenger: false },
      email: { notification: true, approval: true, messenger: false },
    };
    const store: NotificationSettingsStore = {
      get: vi.fn(async () => settings),
      setChannelMode: vi.fn(),
      setVerificationPhrase: vi.fn(),
      setBridgeMode: vi.fn(),
      clearBridgeMode: vi.fn(),
    };
    const surface = createNotificationSettings({ store });

    await expect(surface.get()).resolves.toBe(settings);
    expect(store.get).toHaveBeenCalledTimes(1);
  });

  it('describe returns rows in channel order with capability badges and the bridge install_url CTA', async () => {
    const surface = createNotificationSettings({
      store: createSettingsStore(),
      readinessProbe: () => false,
    });

    await expect(surface.describe()).resolves.toEqual([
      {
        channel: 'ui',
        capability: 'inline',
        notification: true,
        approval: true,
        notification_togglable: false,
        approval_togglable: false,
        ready: true,
      },
      {
        channel: 'bridge',
        capability: 'notify-only',
        notification: false,
        approval: false,
        notification_togglable: true,
        approval_togglable: false,
        ready: false,
        install_url: BRIDGE_INSTALL_URL,
      },
      {
        channel: 'slack',
        capability: 'inline',
        notification: false,
        approval: false,
        notification_togglable: true,
        approval_togglable: true,
        ready: false,
      },
      {
        channel: 'telegram',
        capability: 'inline',
        notification: false,
        approval: false,
        notification_togglable: true,
        approval_togglable: true,
        ready: false,
      },
      // D-192 — Discord supports notify + approve here and conversation through
      // Gateway. WhatsApp is deliberately absent: its only role is `messenger`,
      // so there is nothing to toggle in this panel.
      {
        channel: 'discord',
        capability: 'inline',
        notification: false,
        approval: false,
        notification_togglable: true,
        approval_togglable: true,
        ready: false,
      },
      {
        // D-238 — the first chat transport whose capability is NOT `inline`.
        // Its ask is a link to the answer page, because Graph cannot deliver a
        // button press to a poller. The badge differing from its neighbours is
        // the point of the row, not an oddity.
        channel: 'teams',
        capability: 'landing-page',
        notification: false,
        approval: false,
        notification_togglable: true,
        approval_togglable: true,
        ready: false,
      },
      {
        channel: 'email',
        capability: 'landing-page',
        notification: false,
        approval: false,
        notification_togglable: true,
        approval_togglable: true,
        ready: false,
      },
    ]);
  });

  it('describe carries togglable enabled state from the record and ready from the probe', async () => {
    const store = createSettingsStore();
    await store.setChannelMode('slack', { notification: true, approval: true });
    await store.setChannelMode('email', { notification: true, approval: true });
    const readinessProbe: ChannelReadinessProbe = (channel) =>
      channel !== 'telegram' && channel !== 'bridge';
    const surface = createNotificationSettings({ store, readinessProbe });

    await expect(surface.describe()).resolves.toMatchObject([
      { channel: 'ui', notification: true, approval: true, ready: true },
      { channel: 'bridge', notification: false, approval: false, ready: false },
      { channel: 'slack', notification: true, approval: true, ready: true },
      { channel: 'telegram', notification: false, approval: false, ready: false },
      { channel: 'discord', notification: false, approval: false, ready: true },
      { channel: 'teams', notification: false, approval: false, ready: true },
      { channel: 'email', notification: true, approval: true, ready: true },
    ]);
  });

  it('describe awaits an async readiness probe for togglable rows', async () => {
    const calls: string[] = [];
    const readinessProbe: ChannelReadinessProbe = async (channel) => {
      calls.push(channel);
      return channel === 'email';
    };
    const surface = createNotificationSettings({
      store: createSettingsStore(),
      readinessProbe,
    });

    const rows = await surface.describe();

    expect(calls).toEqual(['bridge', 'slack', 'telegram', 'discord', 'teams', 'email']);
    expect(rows.map((row) => row.ready)).toEqual([
      true,    // ui — always ready
      false,   // bridge — probe false
      false,   // slack — probe false
      false,   // telegram — probe false
      false,   // discord — probe false
      false,   // teams — probe false
      true,    // email — probe true
    ]);
  });

  it('D-192 — the notify/approval panel is DERIVED from channel roles, never hand-spelled', async () => {
    // Regression guard for the green-but-mute class. `CHANNEL_ORDER` used to be a
    // hand-spelled `[ui, bridge, slack, telegram, email]` that silently dropped
    // Discord: it enrolled, probed green, reported ready, yet no row was ever
    // drawn so its axes could never be enabled. This panel toggles the
    // notification + approval axes, so a chat transport must appear IFF it can be
    // toggled on at least one of them — tying `describe()` to `CHANNEL_ROLES` so a
    // future hand-spelling regression (or a new transport) can't slip through.
    const rows = await createNotificationSettings({
      store: createSettingsStore(),
      readinessProbe: () => false,
    }).describe();
    const shown = new Set(rows.map((r) => r.channel));

    for (const vendor of MESSENGER_VENDOR_SLUGS) {
      const roles = CHANNEL_ROLES[vendor];
      expect(shown.has(vendor)).toBe(roles.notification || roles.approval);
    }
    // Concretely today: Discord (notify + approve) is shown; WhatsApp
    // (messenger-only — its 24h window forbids unprompted notify/approve) is not.
    expect(shown.has('discord')).toBe(true);
    expect(shown.has('whatsapp')).toBe(false);
  });

  it('setChannel refuses both ui enable and ui disable', async () => {
    const store = createSettingsStore();
    const surface = createNotificationSettings({
      store,
      readinessProbe: () => true,
    });

    await expect(
      surface.setChannelMode('ui', { notification: true, approval: true }),
    ).resolves.toEqual({
      ok: false,
      reason: 'ui_fixed',
    });
    await expect(
      surface.setChannelMode('ui', { notification: false, approval: false }),
    ).resolves.toEqual({
      ok: false,
      reason: 'ui_fixed',
    });
    await expect(store.get()).resolves.toEqual({
      ui: true,
      bridge: false,
      slack: { notification: false, approval: false, messenger: false },
      telegram: { notification: false, approval: false, messenger: false },
      whatsapp: { notification: false, approval: false, messenger: false },
      discord: { notification: false, approval: false, messenger: false },
      teams: { notification: false, approval: false, messenger: false },
      email: { notification: false, approval: false, messenger: false },
      // D-169 P1 — `DEFAULT_NOTIFICATION_SETTINGS` gains a per-bridge
      // mode map (defaults empty on a fresh pair). Stored rows that
      // pre-date the field merge in `{}` via the read-merge path.
      bridges: {},
    });
  });

  it('setChannel refuses to enable a togglable channel without readiness and does not write', async () => {
    const store: NotificationSettingsStore = {
      get: vi.fn(),
      setChannelMode: vi.fn(),
      setVerificationPhrase: vi.fn(),
      setBridgeMode: vi.fn(),
      clearBridgeMode: vi.fn(),
    };
    const surface = createNotificationSettings({
      store,
      readinessProbe: (channel) => channel !== 'slack',
    });

    await expect(
      surface.setChannelMode('slack', { notification: true, approval: true }),
    ).resolves.toEqual({
      ok: false,
      reason: 'not_ready',
      channel: 'slack',
    });
    expect(store.setChannelMode).not.toHaveBeenCalled();
  });

  it('setChannel refuses to enable bridge with no paired Bridge and does not write', async () => {
    const store: NotificationSettingsStore = {
      get: vi.fn(),
      setChannelMode: vi.fn(),
      setVerificationPhrase: vi.fn(),
      setBridgeMode: vi.fn(),
      clearBridgeMode: vi.fn(),
    };
    const surface = createNotificationSettings({
      store,
      readinessProbe: (channel) => channel !== 'bridge',
    });

    await expect(
      surface.setChannelMode('bridge', { notification: true }),
    ).resolves.toEqual({
      ok: false,
      reason: 'not_ready',
      channel: 'bridge',
    });
    expect(store.setChannelMode).not.toHaveBeenCalled();
  });

  it('R31 — setChannelMode refuses an approval patch on the notify-only bridge channel', async () => {
    const store: NotificationSettingsStore = {
      get: vi.fn(),
      setChannelMode: vi.fn(),
      setVerificationPhrase: vi.fn(),
      setBridgeMode: vi.fn(),
      clearBridgeMode: vi.fn(),
    };
    const surface = createNotificationSettings({
      store,
      readinessProbe: () => true, // ready — the refusal is capability, not readiness
    });

    // Bridge is notify-only (D-163 N.1) — it has no approval axis.
    await expect(
      surface.setChannelMode('bridge', { approval: true }),
    ).resolves.toEqual({
      ok: false,
      reason: 'approval_unsupported',
      channel: 'bridge',
    });
    expect(store.setChannelMode).not.toHaveBeenCalled();
  });

  it('setChannel enables a togglable channel when the readiness probe passes', async () => {
    const store = createSettingsStore();
    const surface = createNotificationSettings({
      store,
      readinessProbe: () => true,
    });

    await expect(
      surface.setChannelMode('slack', { notification: true, approval: true }),
    ).resolves.toEqual({
      ok: true,
      settings: {
        ui: true,
        bridge: false,
        slack: { notification: true, approval: true, messenger: false },
        telegram: { notification: false, approval: false, messenger: false },
        whatsapp: { notification: false, approval: false, messenger: false },
        discord: { notification: false, approval: false, messenger: false },
        teams: { notification: false, approval: false, messenger: false },
        email: { notification: false, approval: false, messenger: false },
        bridges: {},
      },
    });
    await expect(store.get()).resolves.toEqual({
      ui: true,
      bridge: false,
      slack: { notification: true, approval: true, messenger: false },
      telegram: { notification: false, approval: false, messenger: false },
      whatsapp: { notification: false, approval: false, messenger: false },
      discord: { notification: false, approval: false, messenger: false },
      teams: { notification: false, approval: false, messenger: false },
      email: { notification: false, approval: false, messenger: false },
      bridges: {},
    });
  });

  it('setChannel disables a togglable channel even when the readiness probe fails', async () => {
    const store = createSettingsStore();
    await store.setChannelMode('slack', { notification: true, approval: true });
    const surface = createNotificationSettings({
      store,
      readinessProbe: () => false,
    });

    await expect(
      surface.setChannelMode('slack', { notification: false, approval: false }),
    ).resolves.toEqual({
      ok: true,
      settings: {
        ui: true,
        bridge: false,
        slack: { notification: false, approval: false, messenger: false },
        telegram: { notification: false, approval: false, messenger: false },
        whatsapp: { notification: false, approval: false, messenger: false },
        discord: { notification: false, approval: false, messenger: false },
        teams: { notification: false, approval: false, messenger: false },
        email: { notification: false, approval: false, messenger: false },
        bridges: {},
      },
    });
    await expect(store.get()).resolves.toMatchObject({
      slack: { notification: false, approval: false, messenger: false },
    });
  });

  it('fails closed when no readiness probe is injected for a togglable enable', async () => {
    const store: NotificationSettingsStore = {
      get: vi.fn(),
      setChannelMode: vi.fn(),
      setVerificationPhrase: vi.fn(),
      setBridgeMode: vi.fn(),
      clearBridgeMode: vi.fn(),
    };
    const surface = createNotificationSettings({ store });

    await expect(
      surface.setChannelMode('telegram', { notification: true, approval: true }),
    ).resolves.toEqual({
      ok: false,
      reason: 'not_ready',
      channel: 'telegram',
    });
    expect(store.setChannelMode).not.toHaveBeenCalled();
  });

  it('setChannel awaits an async readiness probe before enabling', async () => {
    const store = createSettingsStore();
    const surface = createNotificationSettings({
      store,
      readinessProbe: async (channel) => channel === 'email',
    });

    await expect(
      surface.setChannelMode('email', { notification: true, approval: true }),
    ).resolves.toEqual({
      ok: true,
      settings: {
        ui: true,
        bridge: false,
        slack: { notification: false, approval: false, messenger: false },
        telegram: { notification: false, approval: false, messenger: false },
        whatsapp: { notification: false, approval: false, messenger: false },
        discord: { notification: false, approval: false, messenger: false },
        teams: { notification: false, approval: false, messenger: false },
        email: { notification: true, approval: true, messenger: false },
        bridges: {},
      },
    });
    await expect(store.get()).resolves.toMatchObject({
      email: { notification: true, approval: true, messenger: false },
    });
  });
});
