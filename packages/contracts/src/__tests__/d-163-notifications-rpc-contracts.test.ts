/** D-163 Slice C — contracts surface tests.
 *
 *  Asserts the rpc payload contract shape — the literal unions, the
 *  `NotificationChannelToggleView` field set, and the discriminated
 *  union branches on the two `Set*Result` types.
 *
 *  Bidirectional structural compatibility with the
 *  `@recued/notification` block's runtime types is verified by the
 *  backend-side handler test (`d-163-notifications-handler.test.ts`),
 *  which is the only place both surfaces are visible (contracts cannot
 *  import from `@recued/notification` — that would invert the canonical
 *  dependency direction). */

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  NOTIFICATION_VERIFICATION_PHRASE_MAX_LENGTH,
  type NotificationChannelCapability,
  type NotificationChannelName,
  type NotificationChannelToggleView,
  type NotificationRemoteChannelName,
  type NotificationSetChannelResult,
  type NotificationSetVerificationPhraseResult,
  type NotificationSettingsRow,
} from '../notifications.js';

describe('D-163 Slice C — notifications rpc contracts', () => {
  describe('channel name + capability literal unions', () => {
    it('NotificationChannelName covers the 5 closed-list slugs', () => {
      const all: NotificationChannelName[] = [
        'ui',
        'bridge',
        'slack',
        'telegram',
        'email',
      ];
      expect(all).toHaveLength(5);
      // A widening attempt fails compile — caught at type level.
      expectTypeOf<'ui'>().toMatchTypeOf<NotificationChannelName>();
      expectTypeOf<'bridge'>().toMatchTypeOf<NotificationChannelName>();
      expectTypeOf<'email'>().toMatchTypeOf<NotificationChannelName>();
    });

    it('NotificationRemoteChannelName excludes ui', () => {
      const all: NotificationRemoteChannelName[] = [
        'bridge',
        'slack',
        'telegram',
        'email',
      ];
      expect(all).toHaveLength(4);
      expectTypeOf<NotificationRemoteChannelName>().toEqualTypeOf<
        Exclude<NotificationChannelName, 'ui'>
      >();
    });

    it('NotificationChannelCapability covers the 3 closed-list classes', () => {
      const all: NotificationChannelCapability[] = [
        'inline',
        'landing-page',
        'notify-only',
      ];
      expect(all).toHaveLength(3);
    });
  });

  describe('NotificationChannelToggleView', () => {
    it('carries channel + capability + two axes + per-axis togglable + ready + optional install_url', () => {
      const row: NotificationChannelToggleView = {
        channel: 'bridge',
        capability: 'notify-only',
        notification: false,
        approval: false,
        notification_togglable: true,
        approval_togglable: false,
        ready: false,
        install_url: 'https://recued.com/install/bridge',
      };
      expect(row.channel).toBe('bridge');
      expect(row.install_url).toBe('https://recued.com/install/bridge');

      // install_url is optional — a row that omits it is also valid.
      const ready: NotificationChannelToggleView = {
        channel: 'slack',
        capability: 'inline',
        notification: true,
        approval: true,
        notification_togglable: true,
        approval_togglable: true,
        ready: true,
      };
      expect(ready.install_url).toBeUndefined();
    });
  });

  describe('NotificationSettingsRow', () => {
    it('forces ui to literal true', () => {
      const row: NotificationSettingsRow = {
        ui: true,
        bridge: false,
        slack: { notification: false, approval: false, messenger: false },
        telegram: { notification: false, approval: false, messenger: false },
        whatsapp: { notification: false, approval: false, messenger: false },
        discord: { notification: false, approval: false, messenger: false },
        email: { notification: false, approval: false, messenger: false },
      };
      expect(row.ui).toBe(true);
      // `ui: false` would not type-check — the contract pins it to the
      // literal `true` so the always-on invariant survives a malformed
      // wire payload.
      expectTypeOf<NotificationSettingsRow['ui']>().toEqualTypeOf<true>();
    });

    it('accepts an optional verification_phrase', () => {
      const row: NotificationSettingsRow = {
        ui: true,
        bridge: false,
        slack: { notification: false, approval: false, messenger: false },
        telegram: { notification: false, approval: false, messenger: false },
        whatsapp: { notification: false, approval: false, messenger: false },
        discord: { notification: false, approval: false, messenger: false },
        email: { notification: false, approval: false, messenger: false },
        verification_phrase: 'my secret phrase',
      };
      expect(row.verification_phrase).toBe('my secret phrase');
    });
  });

  describe('NotificationSetChannelResult', () => {
    it('carries ok:true with settings on success', () => {
      const ok: NotificationSetChannelResult = {
        ok: true,
        settings: {
          ui: true,
          bridge: true,
          slack: { notification: false, approval: false, messenger: false },
          telegram: { notification: false, approval: false, messenger: false },
          whatsapp: { notification: false, approval: false, messenger: false },
          discord: { notification: false, approval: false, messenger: false },
          email: { notification: false, approval: false, messenger: false },
        },
      };
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(ok.settings.bridge).toBe(true);
    });

    it('carries ok:false ui_fixed', () => {
      const result: NotificationSetChannelResult = {
        ok: false,
        reason: 'ui_fixed',
      };
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('ui_fixed');
    });

    it('carries ok:false not_ready with channel narrowed to RemoteChannelName', () => {
      const result: NotificationSetChannelResult = {
        ok: false,
        reason: 'not_ready',
        channel: 'bridge',
      };
      expect(result.ok).toBe(false);
      if (!result.ok && result.reason === 'not_ready') {
        expect(result.channel).toBe('bridge');
        // `not_ready.channel` is `NotificationRemoteChannelName` —
        // `'ui'` is excluded by construction.
        expectTypeOf(result.channel).toEqualTypeOf<NotificationRemoteChannelName>();
      }
    });
  });

  describe('NotificationSetVerificationPhraseResult', () => {
    it('carries ok:true settings + ok:false too_long max', () => {
      const ok: NotificationSetVerificationPhraseResult = {
        ok: true,
        settings: {
          ui: true,
          bridge: false,
          slack: { notification: false, approval: false, messenger: false },
          telegram: { notification: false, approval: false, messenger: false },
          whatsapp: { notification: false, approval: false, messenger: false },
          discord: { notification: false, approval: false, messenger: false },
          email: { notification: false, approval: false, messenger: false },
        },
      };
      const too_long: NotificationSetVerificationPhraseResult = {
        ok: false,
        reason: 'too_long',
        max: 80,
      };
      expect(ok.ok).toBe(true);
      expect(too_long.ok).toBe(false);
      if (!too_long.ok) expect(too_long.max).toBe(80);
    });
  });

  describe('NOTIFICATION_VERIFICATION_PHRASE_MAX_LENGTH', () => {
    it('is 80 (mirrors the @recued/notification block constant; ratchet asserted backend-side)', () => {
      expect(NOTIFICATION_VERIFICATION_PHRASE_MAX_LENGTH).toBe(80);
    });
  });
});
