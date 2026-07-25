/** D-163 P0 — Settings render model carries capability badges + Bridge
 *  install CTA.
 *
 *  Invariants under test:
 *   - I-6: every `ChannelToggleView` carries its `capability`; Bridge's
 *          row carries the `install_url` CTA target.
 */

import { createInMemoryCollection } from '@recued/storage';
import { describe, expect, it } from 'vitest';
import {
  BRIDGE_INSTALL_URL,
  createNotificationSettings,
  createNotificationSettingsStore,
  type ChannelReadinessProbe,
  type ChannelToggleView,
  type NotificationSettings,
} from '../index.js';

const createSurface = (readinessProbe: ChannelReadinessProbe) =>
  createNotificationSettings({
    store: createNotificationSettingsStore(
      createInMemoryCollection<NotificationSettings>(),
    ),
    readinessProbe,
  });

const byName = (
  rows: readonly ChannelToggleView[],
  name: string,
): ChannelToggleView => {
  const row = rows.find((r) => r.channel === name);
  if (!row) throw new Error(`row missing: ${name}`);
  return row;
};

describe('D-163 I-6 — capability badges on Settings render model', () => {
  it('every row carries the matching capability', async () => {
    const rows = await createSurface(() => true).describe();
    expect(byName(rows, 'ui').capability).toBe('inline');
    expect(byName(rows, 'bridge').capability).toBe('notify-only');
    expect(byName(rows, 'slack').capability).toBe('inline');
    expect(byName(rows, 'telegram').capability).toBe('inline');
    expect(byName(rows, 'email').capability).toBe('landing-page');
  });

  it('row order: ui first, bridge second, then credential-backed channels', async () => {
    const rows = await createSurface(() => false).describe();
    expect(rows.map((r) => r.channel)).toEqual([
      'ui',
      'bridge',
      'slack',
      'telegram',
      // D-192 — Discord (notify + approve) appears; WhatsApp (messenger-only) does
      // not. The panel is derived from `CHANNEL_ROLES`, not hand-spelled.
      'discord',
      'email',
    ]);
  });
});

describe('D-163 I-6 — Bridge install CTA', () => {
  it('bridge row carries install_url targeting the install guide', async () => {
    const rows = await createSurface(() => false).describe();
    const bridge = byName(rows, 'bridge');
    expect(bridge.install_url).toBe(BRIDGE_INSTALL_URL);
  });

  it('credential-backed togglable rows leave install_url undefined (Settings → Connections routes them)', async () => {
    const rows = await createSurface(() => false).describe();
    expect(byName(rows, 'slack').install_url).toBeUndefined();
    expect(byName(rows, 'telegram').install_url).toBeUndefined();
    expect(byName(rows, 'email').install_url).toBeUndefined();
  });

  it('ui row is non-togglable, always-ready, no install_url', async () => {
    const rows = await createSurface(() => false).describe();
    const ui = byName(rows, 'ui');
    expect(ui.notification_togglable).toBe(false);
    expect(ui.approval_togglable).toBe(false);
    expect(ui.ready).toBe(true);
    expect(ui.install_url).toBeUndefined();
  });
});
