/** D-186 — the messenger (Slack / Telegram) "Active passes" surface.
 *
 *  Extends the D-181 slice-6b live-control composer with a `/recued passes`
 *  pull + `Revoke` buttons over the session-grant seam. Pins:
 *
 *    - `/recued passes` (+ the `grants` / `access` aliases) renders the active
 *      session grants as an interactive prompt carrying the SAME
 *      `LIVE_CONTROL_CORRELATION_ID` the run list uses, one `revoke:<contract_id>`
 *      button per pass; an empty list falls back to a plain message.
 *    - A `revoke` press routes to the `passes.revoke` seam (NOT the in-flight
 *      registry — disjoint id-spaces, the action prefix routes) with a one-line
 *      confirmation, and inherits the canonical-row + bound-conversation gate.
 *    - Graceful degrade: with no `passes` seam wired, `/recued passes` is an
 *      unknown subcommand (usage note) and a revoke press reads as not-found.
 *    - The Telegram `revoke` callback_data stays within the 64-byte cap.
 *
 *  Harness mirrors `d-181-slice-6b-messenger-live-control.test.ts`. */

import { describe, expect, it, vi } from 'vitest';
import type { SessionGrantView } from '@recued/contracts';

import {
  composeMessengerLiveControl,
  LIVE_CONTROL_CORRELATION_ID,
  type ComposeMessengerLiveControlDeps,
  type MessengerLiveControl,
} from '../composition/bin/wire-messenger-live-control.js';
import type { InFlightRegistry } from '../execution/in-flight-registry.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import {
  buildConnectionRow,
  encodePlaintextAuth,
  stubConnectionStore,
} from './d-163-remote-channel-test-helpers.js';

const NOW = Date.UTC(2031, 0, 2, 3, 4, 5);
const SLACK_TOKEN = 'xoxb-passes';
const TELEGRAM_TOKEN = '321:passes';
const SLACK_CHANNEL = 'C-bound';
const TELEGRAM_CHAT = '4242';
// A real-shape session-grant id (`ct_${randomUUID()}`, 39 chars) — the
// callback payload `recued-live-ctl|revoke:ct_<uuid>` is 62 bytes (< 64).
const GRANT_ID = 'ct_11111111-2222-3333-4444-555555555555';

// ── fixtures ────────────────────────────────────────────────────────

const connectionRow = (
  vendor: 'slack' | 'telegram',
  config: Record<string, unknown>,
  token: string,
) => {
  const auth = { type: 'bearer', token } as const;
  return {
    ...buildConnectionRow({ name: vendor, auth, config }),
    auth_ciphertext: encodePlaintextAuth(auth),
  };
};

const slackStore = (channel = SLACK_CHANNEL): ConnectionStoreSqlite =>
  stubConnectionStore(connectionRow('slack', { channel_id: channel }, SLACK_TOKEN));

const telegramStore = (chat: number | string = TELEGRAM_CHAT): ConnectionStoreSqlite =>
  stubConnectionStore(connectionRow('telegram', { chat_id: chat }, TELEGRAM_TOKEN));

type FetchImpl = NonNullable<ComposeMessengerLiveControlDeps['fetchImpl']>;
const okFetch = (): ReturnType<typeof vi.fn<FetchImpl>> =>
  vi.fn<FetchImpl>(async () =>
    new Response(JSON.stringify({ ok: true, ts: '1', result: { message_id: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

const bodyOf = (init: RequestInit | undefined): Record<string, unknown> => {
  if (init === undefined || typeof init.body !== 'string') {
    throw new Error('expected a JSON request body');
  }
  return JSON.parse(init.body) as Record<string, unknown>;
};

const sectionText = (body: Record<string, unknown>): string => {
  const blocks = body.blocks as Array<Record<string, unknown>>;
  const section = blocks.find((b) => b.type === 'section') as { text: { text: string } };
  return section.text.text;
};

const buttonValues = (body: Record<string, unknown>): string[] => {
  const blocks = body.blocks as Array<Record<string, unknown>>;
  const actions = blocks.find((b) => b.type === 'actions') as
    | { block_id: string; elements: Array<{ value: string }> }
    | undefined;
  expect(actions).toBeDefined();
  expect(actions!.block_id).toBe(LIVE_CONTROL_CORRELATION_ID);
  return actions!.elements.map((e) => e.value);
};

const grantView = (over: Partial<SessionGrantView> = {}): SessionGrantView => ({
  contract_id: GRANT_ID,
  display_name: 'Batched approval — send-email (3 items)',
  grant_mode: 'batch',
  permits: { operation_ids: ['mail.send'] },
  expiry_at: NOW + 15 * 60_000,
  remaining_ttl_ms: 15 * 60_000,
  uses_remaining: 2,
  max_uses: 3,
  member_count: 3,
  lifecycle_state: 'active',
  ...over,
});

interface RegistryStub {
  registry: InFlightRegistry;
  kill: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  promote: ReturnType<typeof vi.fn>;
}

const stubRegistry = (opts: { killStatus?: string } = {}): RegistryStub => {
  const snapshot = vi.fn(() => ({ entries: [], lanes: [] }));
  const kill = vi.fn(() => opts.killStatus ?? 'killed');
  const cancel = vi.fn(() => 'cancelled_before_dispatch');
  const promote = vi.fn(() => 'promoted');
  return {
    kill,
    cancel,
    promote,
    registry: { snapshot, kill, cancel, promote } as unknown as InFlightRegistry,
  };
};

interface PassesStub {
  passes: NonNullable<ComposeMessengerLiveControlDeps['passes']>;
  list: ReturnType<typeof vi.fn>;
  revoke: ReturnType<typeof vi.fn>;
}

const stubPasses = (
  opts: { grants?: SessionGrantView[]; revoked?: SessionGrantView | null } = {},
): PassesStub => {
  const list = vi.fn(() => opts.grants ?? []);
  // Default: a successful early-revoke (the now-`revoked` view). Pass
  // `revoked: null` for the already-inert / unknown-id case.
  const revoke = vi.fn(() =>
    opts.revoked === undefined ? grantView({ lifecycle_state: 'revoked' }) : opts.revoked,
  );
  return { list, revoke, passes: { list, revoke } };
};

const compose = (deps: {
  registry?: InFlightRegistry;
  passes?: ComposeMessengerLiveControlDeps['passes'];
  connectionStore?: ConnectionStoreSqlite;
  fetchImpl?: ReturnType<typeof okFetch>;
  omitPasses?: boolean;
}): { control: MessengerLiveControl; fetchImpl: ReturnType<typeof okFetch> } => {
  const fetchImpl = deps.fetchImpl ?? okFetch();
  const control = composeMessengerLiveControl({
    registry: deps.registry ?? stubRegistry().registry,
    connectionStore: deps.connectionStore ?? slackStore(),
    ...(deps.omitPasses ? {} : { passes: deps.passes ?? stubPasses().passes }),
    fetchImpl,
    now: () => NOW,
  });
  if (control === undefined) throw new Error('expected live control to compose');
  return { control, fetchImpl };
};

// ── inbound payloads ────────────────────────────────────────────────

const slackText = (text: string, channel = SLACK_CHANNEL): unknown => ({
  type: 'event_callback',
  event: { type: 'message', user: 'U1', text, ts: '1730000000.000100', channel },
});

const slackPress = (
  correlation_id: string,
  option_id: string,
  channel = SLACK_CHANNEL,
): unknown => ({
  type: 'block_actions',
  user: { id: 'U1' },
  actions: [{ type: 'button', value: `${correlation_id}|${option_id}` }],
  container: { message_ts: '1730000000.000200', channel_id: channel },
});

const telegramText = (text: string, chatId: number | string = TELEGRAM_CHAT): unknown => ({
  update_id: 1,
  message: { message_id: 5, text, from: { id: 7, is_bot: false }, chat: { id: chatId } },
});

// ════════════════════════════════════════════════════════════════════
// /recued passes — the pull
// ════════════════════════════════════════════════════════════════════

describe('D-186 — messenger /recued passes', () => {
  it('renders the active passes as an interactive prompt with Revoke buttons', async () => {
    const passes = stubPasses({
      grants: [
        grantView(),
        grantView({
          contract_id: 'ct_aaaaaaaa-2222-3333-4444-555555555555',
          display_name: 'Session grant (raw op)',
          grant_mode: 'raw_op',
          permits: {},
        }),
      ],
    });
    const { control, fetchImpl } = compose({ passes: passes.passes });

    const consumed = await control.handleCommand('slack', 'slack', slackText('/recued passes'));

    expect(consumed).toBe(true);
    expect(passes.list).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = bodyOf(fetchImpl.mock.calls[0]![1]);
    const values = buttonValues(body);
    expect(values).toContain(`${LIVE_CONTROL_CORRELATION_ID}|revoke:${GRANT_ID}`);
    expect(values).toContain(
      `${LIVE_CONTROL_CORRELATION_ID}|revoke:ct_aaaaaaaa-2222-3333-4444-555555555555`,
    );
    const text = sectionText(body);
    expect(text).toContain('Active passes — 2');
    expect(text).toContain('Batched approval');
    expect(text).toContain('expires in 15m');
  });

  it('accepts the grants / access aliases', async () => {
    const { control, fetchImpl } = compose({ passes: stubPasses({ grants: [grantView()] }).passes });
    expect(await control.handleCommand('slack', 'slack', slackText('/recued grants'))).toBe(true);
    expect(await control.handleCommand('slack', 'slack', slackText('/recued access'))).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('sends a plain "no active passes" message when there are none', async () => {
    const { control, fetchImpl } = compose({ passes: stubPasses({ grants: [] }).passes });

    const consumed = await control.handleCommand('slack', 'slack', slackText('/recued passes'));

    expect(consumed).toBe(true);
    const body = bodyOf(fetchImpl.mock.calls[0]![1]);
    expect(body.blocks).toBeUndefined();
    expect(String(body.text)).toContain('No active passes');
  });

  it('summarises permits by specificity (ops → ingredients → connections → any)', async () => {
    const grants = [
      grantView({ contract_id: 'ct_a', display_name: 'A', permits: { operation_ids: ['mail.send', 'mail.read'] } }),
      grantView({ contract_id: 'ct_b', display_name: 'B', permits: { ingredient_ids: ['deal-reader-hubspot'] } }),
      grantView({ contract_id: 'ct_c', display_name: 'C', permits: { connection_names: ['x', 'y'] } }),
      grantView({ contract_id: 'ct_d', display_name: 'D', permits: {} }),
    ];
    const { control, fetchImpl } = compose({ passes: stubPasses({ grants }).passes });

    await control.handleCommand('slack', 'slack', slackText('/recued passes'));

    const text = sectionText(bodyOf(fetchImpl.mock.calls[0]![1]));
    expect(text).toContain('2 ops');
    expect(text).toContain('deal-reader-hubspot');
    expect(text).toContain('2 connections');
    expect(text).toContain('any op');
  });

  it('falls to the usage note for /recued passes when the passes seam is unwired', async () => {
    const { control, fetchImpl } = compose({ omitPasses: true });

    const consumed = await control.handleCommand('slack', 'slack', slackText('/recued passes'));

    expect(consumed).toBe(true);
    // No passes seam → an unknown subcommand → the usage note (which still
    // names both surfaces).
    expect(String(bodyOf(fetchImpl.mock.calls[0]![1]).text)).toContain('/recued passes');
  });

  it('encodes the Telegram revoke callback_data within the 64-byte cap', async () => {
    const passes = stubPasses({
      grants: [
        grantView(),
        grantView({
          contract_id: 'ct_99999999-8888-7777-6666-555555555555',
          display_name:
            'Session grant (raw op) — a very long human label that exceeds the button width by far',
        }),
      ],
    });
    const { control, fetchImpl } = compose({ passes: passes.passes, connectionStore: telegramStore() });

    const consumed = await control.handleCommand('telegram', 'telegram', telegramText('/recued passes'));

    expect(consumed).toBe(true);
    const body = bodyOf(fetchImpl.mock.calls[0]![1]);
    const keyboard = (body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> })
      .inline_keyboard;
    const datas = keyboard.flat().map((b) => b.callback_data);
    expect(datas.length).toBeGreaterThan(0);
    for (const data of datas) {
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
    }
    // The prompt was not rejected for an over-cap payload (no plain fallback).
    expect(body.reply_markup).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════
// Revoke — the press
// ════════════════════════════════════════════════════════════════════

describe('D-186 — messenger revoke press', () => {
  it('routes a revoke press to the passes seam and confirms', async () => {
    const passes = stubPasses({ revoked: grantView({ lifecycle_state: 'revoked' }) });
    const reg = stubRegistry();
    const { control, fetchImpl } = compose({ registry: reg.registry, passes: passes.passes });

    const consumed = await control.handleControlPress(
      'slack',
      'slack',
      slackPress(LIVE_CONTROL_CORRELATION_ID, `revoke:${GRANT_ID}`),
    );

    expect(consumed).toBe(true);
    expect(passes.revoke).toHaveBeenCalledWith(GRANT_ID);
    // Disjoint id-spaces: a revoke never touches the in-flight registry.
    expect(reg.kill).not.toHaveBeenCalled();
    expect(reg.cancel).not.toHaveBeenCalled();
    expect(reg.promote).not.toHaveBeenCalled();
    expect(String(bodyOf(fetchImpl.mock.calls[0]![1]).text)).toContain('Revoked the access pass');
  });

  it('confirms "no longer active" when the grant is already inert', async () => {
    const passes = stubPasses({ revoked: null });
    const { control, fetchImpl } = compose({ passes: passes.passes });

    await control.handleControlPress(
      'slack',
      'slack',
      slackPress(LIVE_CONTROL_CORRELATION_ID, `revoke:${GRANT_ID}`),
    );

    expect(passes.revoke).toHaveBeenCalledWith(GRANT_ID);
    expect(String(bodyOf(fetchImpl.mock.calls[0]![1]).text)).toContain('no longer active');
  });

  it('refuses a revoke press from outside the bound conversation', async () => {
    const passes = stubPasses();
    const { control, fetchImpl } = compose({ passes: passes.passes });

    const consumed = await control.handleControlPress(
      'slack',
      'slack',
      slackPress(LIVE_CONTROL_CORRELATION_ID, `revoke:${GRANT_ID}`, 'C-other'),
    );

    // Consumed (it IS our correlation id), but no mutation + no confirmation.
    expect(consumed).toBe(true);
    expect(passes.revoke).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('still routes a kill press to the registry when the passes seam is wired', async () => {
    const passes = stubPasses();
    const reg = stubRegistry({ killStatus: 'killed' });
    const { control } = compose({ registry: reg.registry, passes: passes.passes });

    await control.handleControlPress(
      'slack',
      'slack',
      slackPress(LIVE_CONTROL_CORRELATION_ID, 'kill:20260101T000000000-aaa111'),
    );

    expect(reg.kill).toHaveBeenCalledWith('20260101T000000000-aaa111');
    expect(passes.revoke).not.toHaveBeenCalled();
  });

  it('consumes a revoke press as not-found when the passes seam is unwired', async () => {
    const { control, fetchImpl } = compose({ omitPasses: true });

    const consumed = await control.handleControlPress(
      'slack',
      'slack',
      slackPress(LIVE_CONTROL_CORRELATION_ID, `revoke:${GRANT_ID}`),
    );

    expect(consumed).toBe(true);
    expect(String(bodyOf(fetchImpl.mock.calls[0]![1]).text)).toContain('no longer active');
  });
});
