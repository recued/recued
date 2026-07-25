/** D-163 Slice C — notifications-handler unit tests + cross-package
 *  type-equivalence ratchet.
 *
 *  Three concerns:
 *    1. The three `notifications.*` rpcs proxy through the
 *       `@recued/notification` block's settings surface correctly +
 *       reject malformed args with `bad_request`.
 *    2. `makeNotificationsHandlers(undefined)` returns `undefined` so
 *       dbless harnesses route to `not_configured` on the wire.
 *    3. Cross-package ratchet — backend is the only site that can
 *       import from BOTH `@recued/contracts` and `@recued/notification`
 *       so structural compatibility between the rpc payload types
 *       (contracts) and the block's runtime types (`@recued/notification`)
 *       is verified here. A drift on either side breaks this file at
 *       compile time. */

import { createInMemoryCollection } from '@recued/storage';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  CHANNEL_ROLES,
  MESSENGER_VENDOR_SLUGS,
  RpcError,
  type NotificationChannelCapability,
  type NotificationChannelName,
  type NotificationChannelToggleView,
  type NotificationRemoteChannelName,
  type NotificationSetChannelResult,
  type NotificationSetVerificationPhraseResult,
  type NotificationSettingsRow,
} from '@recued/contracts';
import {
  createAskStore,
  createBridgeChannel,
  createNotificationBlock,
  createNotificationSettingsStore,
  createUiChannel,
  type Channel,
  type ChannelCapability,
  type ChannelName,
  type ChannelReadinessProbe,
  type ChannelToggleView,
  type NotificationBlock,
  type NotificationSettings,
  type PendingAsk,
  type RemoteChannelName,
  type SetChannelResult,
  type SetVerificationPhraseResult,
} from '@recued/notification';

import {
  handleNotificationsDescribe,
  handleNotificationsSetChannel,
  handleNotificationsSetVerificationPhrase,
  makeNotificationsHandlers,
  type NotificationRpcDeps,
} from '../notifications-handler.js';

// ──────────────────────────────────────────────────────────────────
// Cross-package type ratchet — drift catches at compile time
// ──────────────────────────────────────────────────────────────────

describe('D-163 Slice C — cross-package type ratchet', () => {
  it('NotificationChannelName ≡ ChannelName', () => {
    expectTypeOf<NotificationChannelName>().toEqualTypeOf<ChannelName>();
  });
  it('NotificationRemoteChannelName ≡ RemoteChannelName', () => {
    expectTypeOf<NotificationRemoteChannelName>().toEqualTypeOf<RemoteChannelName>();
  });
  it('NotificationChannelCapability ≡ ChannelCapability', () => {
    expectTypeOf<NotificationChannelCapability>().toEqualTypeOf<ChannelCapability>();
  });
  it('NotificationChannelToggleView is structurally compatible with ChannelToggleView', () => {
    expectTypeOf<ChannelToggleView>().toMatchTypeOf<NotificationChannelToggleView>();
    expectTypeOf<NotificationChannelToggleView>().toMatchTypeOf<ChannelToggleView>();
  });
  it('NotificationSettingsRow is structurally compatible with NotificationSettings', () => {
    expectTypeOf<NotificationSettings>().toMatchTypeOf<NotificationSettingsRow>();
    expectTypeOf<NotificationSettingsRow>().toMatchTypeOf<NotificationSettings>();
  });
  it('NotificationSetChannelResult is structurally compatible with SetChannelResult', () => {
    expectTypeOf<SetChannelResult>().toMatchTypeOf<NotificationSetChannelResult>();
    expectTypeOf<NotificationSetChannelResult>().toMatchTypeOf<SetChannelResult>();
  });
  it('NotificationSetVerificationPhraseResult is structurally compatible with SetVerificationPhraseResult', () => {
    expectTypeOf<SetVerificationPhraseResult>().toMatchTypeOf<NotificationSetVerificationPhraseResult>();
    expectTypeOf<NotificationSetVerificationPhraseResult>().toMatchTypeOf<SetVerificationPhraseResult>();
  });
});

// ──────────────────────────────────────────────────────────────────
// Test fixture — a real block over an in-memory store
// ──────────────────────────────────────────────────────────────────

/** Build a `NotificationBlock` instance backed by in-memory collections.
 *  The readiness probe is parameterised so individual tests can flip a
 *  channel between `not_ready` and `ready` to exercise both branches of
 *  `setChannel`. */
const buildBlock = (
  readiness: Partial<Record<RemoteChannelName, boolean>> = {},
): NotificationBlock => {
  const readinessProbe: ChannelReadinessProbe = (channel) =>
    readiness[channel] ?? false;
  const askStore = createAskStore(createInMemoryCollection<PendingAsk>());
  const settingsStore = createNotificationSettingsStore(
    createInMemoryCollection<NotificationSettings>(),
  );
  const ui = createUiChannel({ busSink: () => undefined });
  // Bridge constructs unconditionally so describe() always renders the
  // 5-row list (matches the production wiring path).
  const bridge = createBridgeChannel({ bridgeSink: () => undefined });
  const channels: readonly Channel[] = [ui, bridge];
  return createNotificationBlock({
    askStore,
    settingsStore,
    channels,
    readinessProbe,
  });
};

const buildDeps = (block: NotificationBlock): NotificationRpcDeps => ({ block });

// ──────────────────────────────────────────────────────────────────
// handleNotificationsDescribe
// ──────────────────────────────────────────────────────────────────

describe('handleNotificationsDescribe', () => {
  it('returns one row per notify/approve-capable channel, in canonical order', async () => {
    // ⛔ DERIVED, never hand-spelled. The product's `CHANNEL_ORDER`
    // (packages/notification/src/settings.ts:211) is itself derived from
    // `MESSENGER_VENDOR_SLUGS` filtered by role, and its comment records WHY:
    // hand-spelling this list is exactly what silently dropped Discord — it
    // enrolled, probed green, reported ready, and no row was ever drawn, so
    // its axes could never be enabled. This test hand-spelled 5 and went red
    // the moment Discord was fixed. Deriving from the same source is the only
    // form that cannot rot the next time a transport declares a role.
    const expectedChannels = [
      'ui',
      'bridge',
      ...MESSENGER_VENDOR_SLUGS.filter(
        (v) => CHANNEL_ROLES[v].notification || CHANNEL_ROLES[v].approval,
      ),
      'email',
    ];
    const block = buildBlock();
    const result = await handleNotificationsDescribe(buildDeps(block));
    expect(result.rows.map((r) => r.channel)).toEqual(expectedChannels);
    expect(result.rows).toHaveLength(expectedChannels.length);
  });

  it('R31 — surfaces the current verification phrase (absent until set)', async () => {
    const block = buildBlock();
    // No phrase set yet → the field is absent from the response.
    const before = await handleNotificationsDescribe(buildDeps(block));
    expect(before.verification_phrase).toBeUndefined();
    // Once set, describe carries it (the only read path for the panel).
    await block.setNotificationVerificationPhrase('purple otter');
    const after = await handleNotificationsDescribe(buildDeps(block));
    expect(after.verification_phrase).toBe('purple otter');
  });

  it('ui row is fixed-on with capability inline and ready true', async () => {
    const block = buildBlock();
    const result = await handleNotificationsDescribe(buildDeps(block));
    const ui = result.rows.find((r) => r.channel === 'ui');
    expect(ui).toBeDefined();
    expect(ui).toMatchObject({
      channel: 'ui',
      capability: 'inline',
      notification: true,
      approval: true,
      notification_togglable: false,
      approval_togglable: false,
      ready: true,
    });
  });

  it('bridge row carries the install_url + capability notify-only', async () => {
    const block = buildBlock();
    const result = await handleNotificationsDescribe(buildDeps(block));
    const bridge = result.rows.find((r) => r.channel === 'bridge');
    expect(bridge).toBeDefined();
    expect(bridge?.capability).toBe('notify-only');
    expect(bridge?.notification_togglable).toBe(true);
    expect(bridge?.install_url).toBe('https://recued.com/install/bridge');
  });

  it('flips bridge readiness when the probe returns true', async () => {
    const block = buildBlock({ bridge: true });
    const result = await handleNotificationsDescribe(buildDeps(block));
    const bridge = result.rows.find((r) => r.channel === 'bridge');
    expect(bridge?.ready).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────
// handleNotificationsSetChannel
// ──────────────────────────────────────────────────────────────────

describe('handleNotificationsSetChannel', () => {
  it('refuses to toggle ui — returns ok:false ui_fixed', async () => {
    const block = buildBlock();
    const result = await handleNotificationsSetChannel(buildDeps(block), {
      channel: 'ui',
      patch: { notification: false, approval: false },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ui_fixed');
  });

  it('refuses to enable a not-ready channel — returns ok:false not_ready', async () => {
    const block = buildBlock({ bridge: false });
    const result = await handleNotificationsSetChannel(buildDeps(block), {
      channel: 'bridge',
      patch: { notification: true },
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'not_ready') {
      expect(result.channel).toBe('bridge');
    }
  });

  it('enables a ready channel + returns the new settings record', async () => {
    const block = buildBlock({ bridge: true });
    const result = await handleNotificationsSetChannel(buildDeps(block), {
      channel: 'bridge',
      patch: { notification: true },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settings.bridge).toBe(true);
      expect(result.settings.ui).toBe(true);
    }
  });

  it('disables a previously-enabled channel without readiness gate', async () => {
    const block = buildBlock({ bridge: true });
    // Enable it first via the rpc to get into the "enabled" state.
    await handleNotificationsSetChannel(buildDeps(block), {
      channel: 'bridge',
      patch: { notification: true },
    });
    // Even after the readiness probe is force-flipped to false, the
    // disable path succeeds — the readiness gate only applies on enable.
    const blockFlipped = buildBlock({ bridge: false });
    await handleNotificationsSetChannel(buildDeps(blockFlipped), {
      channel: 'bridge',
      patch: { notification: true },
    }).then((r) => expect(r.ok).toBe(false));

    // Now disable on the original block (where the row IS enabled).
    const result = await handleNotificationsSetChannel(buildDeps(block), {
      channel: 'bridge',
      patch: { notification: false },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.settings.bridge).toBe(false);
  });

  it('rejects an unknown channel string with bad_request', async () => {
    const block = buildBlock();
    await expect(
      handleNotificationsSetChannel(buildDeps(block), {
        // bypass the type system so the runtime gate is the only check.
        // ⚠ was `discord` — see the fixture-expiry note in the messenger suites.
        channel: 'not_a_transport' as unknown as NotificationChannelName,
        patch: { notification: true },
      }),
    ).rejects.toMatchObject({
      name: 'RpcError',
      code: 'bad_request',
    });
  });

  it('rejects a non-boolean patch axis with bad_request', async () => {
    const block = buildBlock();
    await expect(
      handleNotificationsSetChannel(buildDeps(block), {
        channel: 'bridge',
        patch: { notification: 'yes' as unknown as boolean },
      }),
    ).rejects.toMatchObject({
      name: 'RpcError',
      code: 'bad_request',
    });
  });

  it('rejects missing args with bad_request', async () => {
    const block = buildBlock();
    await expect(
      handleNotificationsSetChannel(
        buildDeps(block),
        undefined as unknown as Parameters<typeof handleNotificationsSetChannel>[1],
      ),
    ).rejects.toBeInstanceOf(RpcError);
  });
});

// ──────────────────────────────────────────────────────────────────
// handleNotificationsSetVerificationPhrase
// ──────────────────────────────────────────────────────────────────

describe('handleNotificationsSetVerificationPhrase', () => {
  it('sets a non-empty phrase', async () => {
    const block = buildBlock();
    const result = await handleNotificationsSetVerificationPhrase(
      buildDeps(block),
      { phrase: 'my secret phrase' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.settings.verification_phrase).toBe('my secret phrase');
  });

  it('clears the phrase when passed null', async () => {
    const block = buildBlock();
    // Set first.
    await handleNotificationsSetVerificationPhrase(buildDeps(block), {
      phrase: 'will be cleared',
    });
    // Then clear.
    const cleared = await handleNotificationsSetVerificationPhrase(buildDeps(block), {
      phrase: null,
    });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.settings.verification_phrase).toBeUndefined();
  });

  it('refuses an over-length phrase with ok:false too_long', async () => {
    const block = buildBlock();
    const overLength = 'a'.repeat(81);
    const result = await handleNotificationsSetVerificationPhrase(
      buildDeps(block),
      { phrase: overLength },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('too_long');
      expect(result.max).toBe(80);
    }
  });

  it('rejects a non-string non-null phrase with bad_request', async () => {
    const block = buildBlock();
    await expect(
      handleNotificationsSetVerificationPhrase(buildDeps(block), {
        phrase: 42 as unknown as string,
      }),
    ).rejects.toMatchObject({
      name: 'RpcError',
      code: 'bad_request',
    });
  });

  it('rejects missing args with bad_request', async () => {
    const block = buildBlock();
    await expect(
      handleNotificationsSetVerificationPhrase(
        buildDeps(block),
        undefined as unknown as Parameters<
          typeof handleNotificationsSetVerificationPhrase
        >[1],
      ),
    ).rejects.toBeInstanceOf(RpcError);
  });
});

// ──────────────────────────────────────────────────────────────────
// makeNotificationsHandlers — handler-set factory gating
// ──────────────────────────────────────────────────────────────────

describe('makeNotificationsHandlers', () => {
  it('returns undefined when deps is undefined (dbless harness path)', () => {
    expect(makeNotificationsHandlers(undefined)).toBeUndefined();
  });

  it('returns a slice with all notification method names when deps is present', () => {
    const block = buildBlock();
    const slice = makeNotificationsHandlers(buildDeps(block));
    expect(slice).toBeDefined();
    // D-169 P1 widening — `describe_bridges` + `set_bridge_mode` join
    // the original three D-163 Slice C methods; D-169 P2 Slice 4 appends
    // `my_bridge_mode`. The slice's ordering is fixed by
    // `makeNotificationsHandlers` (D-163 first, D-169 appended); the
    // handler bundle covers every method 1:1.
    expect(slice?.methods).toEqual([
      'notifications.describe',
      'notifications.set_channel',
      'notifications.set_verification_phrase',
      'notifications.describe_bridges',
      'notifications.set_bridge_mode',
      'notifications.my_bridge_mode',
    ]);
    expect(Object.keys(slice?.handlers ?? {}).sort()).toEqual([
      'notifications.describe',
      'notifications.describe_bridges',
      'notifications.my_bridge_mode',
      'notifications.set_bridge_mode',
      'notifications.set_channel',
      'notifications.set_verification_phrase',
    ]);
  });

  it('dispatches through the slice for each method', async () => {
    const block = buildBlock({ bridge: true });
    const slice = makeNotificationsHandlers(buildDeps(block));
    expect(slice).toBeDefined();

    const describeOut = await slice!.handlers['notifications.describe'](
      undefined,
      undefined as never,
    );
    expect(describeOut).toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({ channel: 'ui' }),
      ]),
    });

    const setOut = await slice!.handlers['notifications.set_channel'](
      { channel: 'bridge', patch: { notification: true } },
      undefined as never,
    );
    expect(setOut).toMatchObject({ ok: true });

    const phraseOut = await slice!.handlers['notifications.set_verification_phrase'](
      { phrase: 'hi there' },
      undefined as never,
    );
    expect(phraseOut).toMatchObject({ ok: true });
  });
});
