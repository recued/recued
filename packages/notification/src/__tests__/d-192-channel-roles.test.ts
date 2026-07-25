/** D-192 — the THREE axes: notification / approval / messenger.
 *
 *  What a channel is FOR is now DECLARED (`CHANNEL_ROLES`), not branched. The gate
 *  that used to read `if (channel === 'bridge') return false` — a per-channel
 *  capability fact hardcoded inside shared logic — reads the declaration instead.
 *
 *  The three axes are genuinely independent, and every combination is occupied. That
 *  is the whole point, and it is what these tests pin: the model is not "is it a
 *  messenger?" (a boolean) but three separate questions with different answers per
 *  channel.
 */

import { describe, expect, it } from 'vitest';
import {
  CHANNEL_ROLES,
  MESSENGER_VENDOR_DECLARATIONS,
  NOTIFICATION_CHANNEL_NAMES,
  getMessengerVendorDeclaration,
} from '@recued/contracts';

import {
  DEFAULT_NOTIFICATION_SETTINGS,
  channelApprovalEnabled,
  channelMessengerEnabled,
  channelNotifyEnabled,
} from '../settings.js';
import type { NotificationSettings } from '../types.js';

/** Everything a channel could possibly be asked to do, all switched ON. The gates
 *  must STILL refuse the roles a channel does not have — that is what makes the
 *  support check fail-closed rather than advisory. */
const allOn = (): NotificationSettings => {
  const s = structuredClone(DEFAULT_NOTIFICATION_SETTINGS) as NotificationSettings;
  s.bridge = true;
  for (const key of ['slack', 'telegram', 'whatsapp', 'discord', 'email'] as const) {
    s[key] = { notification: true, approval: true, messenger: true };
  }
  return s;
};

describe('D-192 — every combination of the three axes is occupied', () => {
  it('places each channel in its own quadrant, and none of them is a boolean', () => {
    // ⚠ This table IS the model. If a future edit collapses two axes into one, this
    // is what says no — and it says it by naming the vendor that would break.
    expect(CHANNEL_ROLES).toMatchObject({
      // The floor: an ask must ALWAYS be resolvable somewhere, which is exactly what
      // lets every other channel be best-effort.
      ui: { notification: true, approval: true, messenger: true },
      // Notify-only (D-163 N.1).
      bridge: { notification: true, approval: false, messenger: false },
      // Notify + approve (via a landing page). You do not chat by email.
      email: { notification: true, approval: true, messenger: false },
      slack: { notification: true, approval: true, messenger: true },
      telegram: { notification: true, approval: true, messenger: true },
      // Presses but no messages (no Gateway) — the mirror image of WhatsApp.
      discord: { notification: true, approval: true, messenger: false },
      // Messages but no unprompted reach (Meta's 24h window) — the mirror of Discord.
      whatsapp: { notification: false, approval: false, messenger: true },
    });
  });

  it('gives discord and email IDENTICAL roles by completely different routes', () => {
    // The clearest proof that ROLES and CAPABILITY are orthogonal and both needed:
    // same triple, and yet one renders inline buttons while the other sends a link.
    expect(CHANNEL_ROLES.discord).toEqual(CHANNEL_ROLES.email);
  });

  it('derives every chat transport’s roles from its own declaration', () => {
    // Not a second hand-written list agreeing with the first. A new transport states
    // its roles once, where it is declared, and CHANNEL_ROLES picks them up.
    for (const d of MESSENGER_VENDOR_DECLARATIONS) {
      expect(CHANNEL_ROLES[d.vendor as 'slack']).toBe(d.roles);
    }
  });
});

describe('D-192 — the gates check SUPPORT before the toggle (fail-closed)', () => {
  it('refuses a role the channel does not have, even with every toggle ON', () => {
    // The load-bearing property. A stale, hand-edited, or future-schema settings row
    // must never be able to enable something the channel cannot do — the owner's
    // toggle can only ever turn OFF what the channel could already do.
    const on = allOn();

    // Discord: alert + approve, never a conversation.
    expect(channelNotifyEnabled(on, 'discord')).toBe(true);
    expect(channelApprovalEnabled(on, 'discord')).toBe(true);
    expect(channelMessengerEnabled(on, 'discord')).toBe(false);

    // WhatsApp: the exact inverse — a conversation, never an unprompted word.
    expect(channelNotifyEnabled(on, 'whatsapp')).toBe(false);
    expect(channelApprovalEnabled(on, 'whatsapp')).toBe(false);
    expect(channelMessengerEnabled(on, 'whatsapp')).toBe(true);

    // Bridge: notify-only. This used to be `if (channel === 'bridge') return false`
    // hardcoded in the gate; it now falls out of the declaration.
    expect(channelNotifyEnabled(on, 'bridge')).toBe(true);
    expect(channelApprovalEnabled(on, 'bridge')).toBe(false);
    expect(channelMessengerEnabled(on, 'bridge')).toBe(false);

    // Email: notify + approve (via the landing page), never a conversation.
    expect(channelMessengerEnabled(on, 'email')).toBe(false);
  });

  it('still honours the owner turning something OFF that the channel CAN do', () => {
    // Support is a ceiling, not an override — the toggle still means something.
    const off = structuredClone(DEFAULT_NOTIFICATION_SETTINGS) as NotificationSettings;
    expect(channelNotifyEnabled(off, 'slack')).toBe(false);
    expect(channelApprovalEnabled(off, 'slack')).toBe(false);
    expect(channelMessengerEnabled(off, 'slack')).toBe(false);

    off.slack = { notification: true, approval: false, messenger: true };
    expect(channelNotifyEnabled(off, 'slack')).toBe(true);
    expect(channelApprovalEnabled(off, 'slack')).toBe(false);
    expect(channelMessengerEnabled(off, 'slack')).toBe(true);
  });

  it('keeps ui as the always-on floor across all three axes', () => {
    const off = structuredClone(DEFAULT_NOTIFICATION_SETTINGS) as NotificationSettings;
    expect(channelNotifyEnabled(off, 'ui')).toBe(true);
    expect(channelApprovalEnabled(off, 'ui')).toBe(true);
    // The webclient IS the chat surface (D-137) — not a togglable destination.
    expect(channelMessengerEnabled(off, 'ui')).toBe(true);
  });

  it('defaults every credential channel to all-three-off (opt-in)', () => {
    // Consistent with the other two axes, and a real security property: enrolling
    // Slack should not silently expose an agent-driving surface until you say so.
    for (const c of ['slack', 'telegram', 'whatsapp', 'discord', 'email'] as const) {
      expect(DEFAULT_NOTIFICATION_SETTINGS[c]).toEqual({
        notification: false,
        approval: false,
        messenger: false,
      });
    }
  });
});

describe('D-192 — the declaration cannot lie', () => {
  it('refuses a channel that declares no role at all', () => {
    // Enforced by a boot check in contracts (this pins WHY): a channel that can
    // neither notify, approve, nor converse would enrol, probe healthy, and be
    // completely inert — the silent-until-runtime shape this arc keeps meeting.
    for (const c of NOTIFICATION_CHANNEL_NAMES) {
      const r = CHANNEL_ROLES[c];
      expect(
        r.notification || r.approval || r.messenger,
        `channel '${c}' declares no role at all`,
      ).toBe(true);
    }
  });

  it('never lets a vendor claim a messenger role it cannot serve', () => {
    // The turn gates on this declaration now, rather than on `parseInbound` happening
    // to return null. So a vendor claiming `messenger: true` is claiming its transport
    // really does deliver plain user messages — pin the two shipped exceptions, since
    // getting either wrong silently kills (or silently opens) the chat surface.
    expect(getMessengerVendorDeclaration('discord')?.roles.messenger).toBe(false);
    expect(getMessengerVendorDeclaration('whatsapp')?.roles.messenger).toBe(true);
    expect(getMessengerVendorDeclaration('whatsapp')?.roles.notification).toBe(false);
  });
});
