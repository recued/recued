/** D-163 Slice C — `notifications.*` rpc handlers.
 *
 *  Settings → Notifications surface. Three rpcs wrap the
 *  `@recued/notification` block's settings surface:
 *    describe                  — render model for the 5-row panel.
 *    set_channel               — toggle one channel; readiness-gated.
 *    set_verification_phrase   — set / clear the anti-phishing phrase.
 *
 *  The block owns its settings record (D-158 I-7); these rpcs are the
 *  thin wire surface. The block's typed result discriminators
 *  (`ui_fixed` / `not_ready` / `too_long`) ride through as data, NOT as
 *  rpc errors — the Settings UI renders them inline.
 *
 *  Per spec § B.11.6-style discipline (mirrored here): the namespace is
 *  in `MCP_RESERVED_RPC_PREFIXES`, gated by the D-138 ratchet. The
 *  handler set is gated on `notificationsDeps` presence so dbless
 *  harnesses surface `not_configured`.
 *
 *  Spec: docs/d-163-spec.md § N.5 / N.6 / A.5. */

import {
  RpcError,
  type HandlerSlice,
  type NotificationBridgeModeRow,
  type NotificationBridgeRow,
  type NotificationChannelModeRow,
  type NotificationChannelName,
  type NotificationChannelToggleView,
  type NotificationSetBridgeModeResult,
  type NotificationSetChannelResult,
  type NotificationSetVerificationPhraseResult,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { NotificationBlock } from '@recued/notification';
import { NOTIFICATION_CHANNEL_NAMES } from '@recued/contracts';

import type { ServerEventInput } from './events/bus.js';
import type { WsClient } from './ws-server.js';

// D-192 seam 10 — from contracts (structural channels + every declared chat
// transport), so a new transport is accepted here with no edit.
const CHANNEL_NAMES: ReadonlySet<NotificationChannelName> = new Set(
  NOTIFICATION_CHANNEL_NAMES,
);

const isChannelName = (v: unknown): v is NotificationChannelName =>
  typeof v === 'string' && CHANNEL_NAMES.has(v as NotificationChannelName);

export interface NotificationRpcDeps {
  /** The `@recued/notification` block instance — the single source of
   *  truth for the settings surface (D-158 I-7). Composer drops the
   *  bundle when the block is absent (dbless harness / boot failed
   *  before the block composed), surfacing `not_configured` on the
   *  wire. */
  block: NotificationBlock;
  /** D-169 P2 Slice 4 (live-mode propagation) — D-121 broadcast-bus
   *  emitter, threaded by the composer from `storage.eventBus`. When
   *  present, a successful `set_bridge_mode` fans out a
   *  `notification.bridge_mode_changed` event so the affected bridge
   *  flips its side-panel approval gate live instead of waiting on its
   *  periodic `my_bridge_mode` re-poll. Optional — the dbless / pre-bus
   *  harness omits it and the handler simply skips the emit (the toggle
   *  itself still applies; liveness degrades to the poll cadence). */
  emit?: (event: ServerEventInput) => void;
}

export const handleNotificationsDescribe = async (
  deps: NotificationRpcDeps,
): Promise<{
  rows: ReadonlyArray<NotificationChannelToggleView>;
  verification_phrase?: string;
}> => {
  const rows = await deps.block.describeNotificationChannels();
  // R31 — surface the current verification phrase alongside the matrix
  // so the panel renders it as a panel-level setting (the phrase is set
  // via `set_verification_phrase` but `describe` is the only read path).
  const settings = await deps.block.getNotificationSettings();
  return settings.verification_phrase !== undefined
    ? { rows, verification_phrase: settings.verification_phrase }
    : { rows };
};

export const handleNotificationsSetChannel = async (
  deps: NotificationRpcDeps,
  args: { channel: NotificationChannelName; patch: Partial<NotificationChannelModeRow> },
): Promise<NotificationSetChannelResult> => {
  if (!isChannelName(args?.channel)) {
    throw new RpcError(
      'bad_request',
      'notifications.set_channel: channel must be ui | bridge | slack | telegram | email',
    );
  }
  // R31 — the payload is a two-axis patch (was a single `enabled`
  // boolean). Reuses the same `{ notification?, approval? }` validator as
  // `set_bridge_mode`; the block applies the readiness + capability gates.
  if (!isModePatch(args.patch)) {
    throw new RpcError(
      'bad_request',
      'notifications.set_channel: patch must be { notification?: boolean; approval?: boolean }',
    );
  }
  if (args.patch.notification === undefined && args.patch.approval === undefined) {
    throw new RpcError(
      'bad_request',
      'notifications.set_channel: patch must specify at least one of notification / approval',
    );
  }
  return deps.block.setNotificationChannelMode(args.channel, args.patch);
};

export const handleNotificationsSetVerificationPhrase = async (
  deps: NotificationRpcDeps,
  args: { phrase: string | null },
): Promise<NotificationSetVerificationPhraseResult> => {
  // `null` and `string` are both accepted; anything else is bad input.
  // (`undefined` would surface as missing `phrase` field — also reject.)
  if (args === undefined || args === null) {
    throw new RpcError(
      'bad_request',
      'notifications.set_verification_phrase: phrase is required (string or null)',
    );
  }
  const phrase = args.phrase;
  if (phrase !== null && typeof phrase !== 'string') {
    throw new RpcError(
      'bad_request',
      'notifications.set_verification_phrase: phrase must be a string or null',
    );
  }
  return deps.block.setNotificationVerificationPhrase(phrase);
};

/** D-169 P1 — per-bridge sub-row render model. The block's
 *  `describeNotificationBridges` joins the per-pair `bridges` map with
 *  the injected `BridgeRosterProbe` (durable + connected snapshot from
 *  `paired_instances` × `client_tokens` × live ws roster). */
export const handleNotificationsDescribeBridges = async (
  deps: NotificationRpcDeps,
): Promise<{ rows: ReadonlyArray<NotificationBridgeRow> }> => {
  const rows = await deps.block.describeNotificationBridges();
  return { rows };
};

const isModePatch = (v: unknown): v is Partial<NotificationBridgeModeRow> => {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.notification !== undefined && typeof o.notification !== 'boolean') return false;
  if (o.approval !== undefined && typeof o.approval !== 'boolean') return false;
  return true;
};

/** D-169 P1 — toggle one bridge's mode flags. The block enforces the
 *  "bridge exists" check via the injected roster probe; an unknown id
 *  surfaces `bridge_unknown` so the rpc returns it as data (not a
 *  throw) for the Settings UI to refresh on. */
export const handleNotificationsSetBridgeMode = async (
  deps: NotificationRpcDeps,
  args: { bridge_id: string; patch: Partial<NotificationBridgeModeRow> },
): Promise<NotificationSetBridgeModeResult> => {
  if (args === null || args === undefined || typeof args.bridge_id !== 'string') {
    throw new RpcError(
      'bad_request',
      'notifications.set_bridge_mode: bridge_id must be a string',
    );
  }
  if (args.bridge_id.length === 0) {
    throw new RpcError(
      'bad_request',
      'notifications.set_bridge_mode: bridge_id must not be empty',
    );
  }
  if (!isModePatch(args.patch)) {
    throw new RpcError(
      'bad_request',
      'notifications.set_bridge_mode: patch must be { notification?: boolean; approval?: boolean }',
    );
  }
  if (args.patch.notification === undefined && args.patch.approval === undefined) {
    throw new RpcError(
      'bad_request',
      'notifications.set_bridge_mode: patch must specify at least one of notification / approval',
    );
  }
  const result = await deps.block.setNotificationBridgeMode(
    args.bridge_id,
    args.patch,
  );
  // D-169 P2 Slice 4 — fan out the change so the affected bridge re-reads
  // its own mode live. Only on a successful set: `bridge_unknown` changed
  // nothing, so there is nothing to broadcast. `args.bridge_id` IS the
  // durable `client_token_id` (the key the per-pair `bridges` map is keyed
  // on — see `setBridgeMode`'s roster probe). We read the merged post-change
  // flags straight off the result rather than re-deriving them from the
  // (possibly single-field) patch, and project explicitly to the wire shape
  // so a future field on the block's mode row can't leak (mirrors
  // `handleNotificationsMyBridgeMode`'s I-10 projection). Best-effort like
  // every bus emit — `emit` is fire-and-forget and absent in the dbless
  // harness.
  if (result.ok) {
    const modes = result.settings.bridges?.[args.bridge_id];
    if (modes) {
      deps.emit?.({
        kind: 'notification.bridge_mode_changed',
        client_token_id: args.bridge_id,
        modes: { notification: modes.notification, approval: modes.approval },
      });
    }
  }
  return result;
};

/** D-169 P2 Slice 4 — the CALLER's OWN bridge mode flags, resolved from
 *  the authenticated `WsClient.client_token_id` (the durable
 *  `client_tokens.token_id` — the same key the per-pair `bridges` map is
 *  keyed on, proven at `wire-notification-block.ts` roster probe). The
 *  handler reads the full per-bridge roster from the block then returns
 *  ONLY the caller's own row's modes, so no bridge ever sees another
 *  bridge's flags on the wire (channel-isolation, I-10). Returns
 *  `{ modes: null }` when the caller carries no `client_token_id` (an
 *  un-bearer-verified WS) or is not a recognised paired bridge (the
 *  webclient, or a token with no bridge row) — the bridge side panel
 *  treats `null` as both-modes-off (fail-closed: no interactive approval
 *  card unless the server affirmatively reports approval ON). */
export const handleNotificationsMyBridgeMode = async (
  deps: NotificationRpcDeps,
  ctx: WsClient,
): Promise<{ modes: NotificationBridgeModeRow | null }> => {
  const id = ctx.client_token_id;
  if (typeof id !== 'string' || id.length === 0) return { modes: null };
  const rows = await deps.block.describeNotificationBridges();
  const mine = rows.find((row) => row.client_token_id === id);
  // Project explicitly to the wire shape — never pass the block's row
  // object through, so a future field on the block's mode type can't leak.
  return {
    modes: mine
      ? { notification: mine.modes.notification, approval: mine.modes.approval }
      : null,
  };
};

type NotificationsMethods =
  | 'notifications.describe'
  | 'notifications.set_channel'
  | 'notifications.set_verification_phrase'
  | 'notifications.describe_bridges'
  | 'notifications.set_bridge_mode'
  | 'notifications.my_bridge_mode';

export const makeNotificationsHandlers = (
  deps: NotificationRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, NotificationsMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: [
      'notifications.describe',
      'notifications.set_channel',
      'notifications.set_verification_phrase',
      'notifications.describe_bridges',
      'notifications.set_bridge_mode',
      'notifications.my_bridge_mode',
    ],
    handlers: {
      'notifications.describe': async () => handleNotificationsDescribe(deps),
      'notifications.set_channel': async (args) =>
        handleNotificationsSetChannel(
          deps,
          args as Parameters<typeof handleNotificationsSetChannel>[1],
        ),
      'notifications.set_verification_phrase': async (args) =>
        handleNotificationsSetVerificationPhrase(
          deps,
          args as Parameters<typeof handleNotificationsSetVerificationPhrase>[1],
        ),
      'notifications.describe_bridges': async () =>
        handleNotificationsDescribeBridges(deps),
      'notifications.set_bridge_mode': async (args) =>
        handleNotificationsSetBridgeMode(
          deps,
          args as Parameters<typeof handleNotificationsSetBridgeMode>[1],
        ),
      'notifications.my_bridge_mode': async (_args, ctx) =>
        handleNotificationsMyBridgeMode(deps, ctx),
    },
  };
};
