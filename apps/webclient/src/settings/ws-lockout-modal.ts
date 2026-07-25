/** D-148 § A.6.6 — `/ws` lockout-protection modal renderer (W3.8).
 *
 *  `/ws` is structurally Mary's primary admin access channel into
 *  Settings. Toggling it off without a backup access path locks her
 *  out. The substrate gates the transition behind a confirmation
 *  phrase; this module is the modal renderer + flavor picker.
 *
 *  Three flavors of confirmation phrase based on caller channel +
 *  active connection count (spec § A.6.6 table):
 *
 *    | Caller channel | Active WS connections | Required phrase | UI flavor |
 *    |:--|:--:|:--|:--|
 *    | webclient (over /ws) | > 0 | `disconnect webclients` | Strong — caller is sawing the branch they're on |
 *    | CLI / other non-WS rpc | > 0 | `disconnect webclients` | Standard — disconnects others |
 *    | any | 0 | `disable ws` | Lighter — no immediate disconnect; future access blocked |
 *
 *  Closed list of two phrases at the substrate (`disconnect webclients`
 *  / `disable ws`); the three flavors map to the same two phrases —
 *  the difference is UI tone, not phrase.
 *
 *  The modal fires for two trigger shapes:
 *    - **Per-path mutation** — Mary unchecks both `/ws` cells in the
 *      grid; the page-shell wraps `set_path_resolution` in the modal.
 *    - **Preset application** — Mary clicks `maintenance` (the only
 *      preset projecting `/ws` fully off); the page-shell wraps
 *      `apply_preset` in the modal.
 */

import {
  WS_LOCKOUT_DISABLE_PHRASE,
  WS_LOCKOUT_DISCONNECT_PHRASE,
  isValidWsLockoutPhrase,
  type ExposurePreset,
  type NetworkErrorCode,
  type PathResolution,
  type WsLockoutPhrase,
} from '@recued/contracts';
import {
  buildPathResolutionDispatch,
  buildPresetDispatch,
  type ExposurePathResolutionDispatch,
  type ExposurePresetDispatch,
} from './exposure-surface.js';

/** Caller channel — the substrate doesn't care, but the UI tone does.
 *  `'webclient_over_ws'` is the "sawing the branch you sit on" case;
 *  `'cli_or_non_ws'` is the standard remote admin case. */
export type WsLockoutCallerChannel = 'webclient_over_ws' | 'cli_or_non_ws';

/** Three flavors closed-list. Drives the modal's title + body copy. */
export type WsLockoutFlavor =
  | 'webclient_self_disconnect'
  | 'cli_disconnects_others'
  | 'no_active_clients';

/** Returns the appropriate flavor for the given context. */
export const pickWsLockoutFlavor = (args: {
  caller_channel: WsLockoutCallerChannel;
  active_ws_connections: number;
}): WsLockoutFlavor => {
  if (args.active_ws_connections <= 0) return 'no_active_clients';
  return args.caller_channel === 'webclient_over_ws'
    ? 'webclient_self_disconnect'
    : 'cli_disconnects_others';
};

/** Returns the required phrase for the chosen flavor. Both
 *  webclient-self-disconnect and cli-disconnects-others map to
 *  `disconnect webclients`; no-active-clients maps to `disable ws`. */
export const requiredPhraseForFlavor = (flavor: WsLockoutFlavor): WsLockoutPhrase => {
  if (flavor === 'no_active_clients') return WS_LOCKOUT_DISABLE_PHRASE;
  return WS_LOCKOUT_DISCONNECT_PHRASE;
};

/** Per-flavor modal copy. */
export const WS_LOCKOUT_MODAL_COPY: Record<
  WsLockoutFlavor,
  { title: string; subtitle: string; bullets: ReadonlyArray<string> }
> = {
  webclient_self_disconnect: {
    title: 'Disconnect this webclient?',
    subtitle: 'You are about to saw the branch you sit on.',
    bullets: [
      'You are calling from this webclient over /ws — disabling /ws drops your connection immediately.',
      'Active WS connections will be terminated in the 30s graceful drain window.',
      'To get back in: open Settings on the LAN listener (port 80) or use the CLI to re-enable /ws.',
    ],
  },
  cli_disconnects_others: {
    title: 'Disconnect every connected webclient?',
    subtitle: 'Webclients over /ws will be dropped.',
    bullets: [
      'Active WS connections will be terminated in the 30s graceful drain window.',
      'Pending approvals + real-time renders will pause until the user re-pairs or you re-enable /ws.',
      'You will still have CLI access; consider scheduling a maintenance window for the affected users.',
    ],
  },
  no_active_clients: {
    title: 'Disable /ws?',
    subtitle: 'No webclients are currently connected.',
    bullets: [
      'No connections will be terminated immediately.',
      'Future webclient access via /ws will be blocked until you re-enable it.',
      'Re-enable from the CLI or by editing config files locally if you cannot reach Settings.',
    ],
  },
};

/** Trigger discriminator — `path` (per-path toggle) vs `preset`. */
export type WsLockoutTrigger =
  | { kind: 'path'; resolution: PathResolution }
  | { kind: 'preset'; preset: ExposurePreset };

/** Modal state — same shape pattern as the public-MCP modal. */
export type WsLockoutModalState =
  | { kind: 'idle' }
  | {
      kind: 'open';
      trigger: WsLockoutTrigger;
      flavor: WsLockoutFlavor;
      active_ws_connections: number;
      required_phrase: WsLockoutPhrase;
      typed_phrase: string;
      phrase_valid: boolean;
    }
  | {
      kind: 'submitting';
      trigger: WsLockoutTrigger;
      flavor: WsLockoutFlavor;
      typed_phrase: string;
    }
  | {
      kind: 'error';
      trigger: WsLockoutTrigger;
      flavor: WsLockoutFlavor;
      typed_phrase: string;
      error: NetworkErrorCode;
    };

/** Open the modal for the given trigger + caller channel. The
 *  page-shell computes `active_ws_connections` from the server's
 *  broadcast bus (or an rpc lookup) before opening. */
export const openWsLockoutModal = (args: {
  trigger: WsLockoutTrigger;
  caller_channel: WsLockoutCallerChannel;
  active_ws_connections: number;
}): WsLockoutModalState => {
  const flavor = pickWsLockoutFlavor({
    caller_channel: args.caller_channel,
    active_ws_connections: args.active_ws_connections,
  });
  return {
    kind: 'open',
    trigger: args.trigger,
    flavor,
    active_ws_connections: args.active_ws_connections,
    required_phrase: requiredPhraseForFlavor(flavor),
    typed_phrase: '',
    phrase_valid: false,
  };
};

/** Type a character (or paste a longer string) into the phrase field.
 *
 *  Codex W3.8 P2 #3 fold — typing on `'error'` transitions back to
 *  `'open'` so the user can correct a rejected phrase without
 *  re-opening the modal. `failWsLockoutModal` parks the state in
 *  `'error'` after an rpc rejection; without this branch the field
 *  would become read-only + `submitWsLockoutModal` would reject the
 *  retry, dead-ending `ws_lockout_phrase_mismatch` recovery. */
export const typeWsLockoutPhrase = (
  state: WsLockoutModalState,
  next_phrase: string,
): WsLockoutModalState => {
  if (state.kind !== 'open' && state.kind !== 'error') return state;
  const required_phrase =
    state.kind === 'open' ? state.required_phrase : requiredPhraseForFlavor(state.flavor);
  const active_ws_connections =
    state.kind === 'open' ? state.active_ws_connections : pickActiveCountFromFlavor(state.flavor);
  return {
    kind: 'open',
    trigger: state.trigger,
    flavor: state.flavor,
    active_ws_connections,
    required_phrase,
    typed_phrase: next_phrase,
    phrase_valid: isValidWsLockoutPhrase(next_phrase, required_phrase),
  };
};

/** Fallback active-count when reconstituting `'open'` from `'error'`.
 *  The error state doesn't carry the original count; only the flavor.
 *  Worst case the recomputed phrase still matches the flavor's
 *  closed-list value, so this is purely for the typed-state struct's
 *  numeric slot. The server is still authoritative on submit. */
const pickActiveCountFromFlavor = (flavor: WsLockoutFlavor): number =>
  flavor === 'no_active_clients' ? 0 : 1;

export const closeWsLockoutModal = (): WsLockoutModalState => ({ kind: 'idle' });

/** Submit outcome. The dispatch threads the typed phrase into the
 *  `lockout_confirmation_phrase` slot per spec § A.6.6 rpc shape. */
export type WsLockoutSubmitOutcome =
  | {
      ok: true;
      dispatch: ExposurePathResolutionDispatch | ExposurePresetDispatch;
      next: WsLockoutModalState;
    }
  | { ok: false; error: 'phrase_required' | 'phrase_mismatch' };

export const submitWsLockoutModal = (
  state: WsLockoutModalState,
  args: { reason?: string } = {},
): WsLockoutSubmitOutcome => {
  if (state.kind !== 'open') {
    return { ok: false, error: 'phrase_required' };
  }
  if (state.typed_phrase.trim().length === 0) {
    return { ok: false, error: 'phrase_required' };
  }
  if (!state.phrase_valid) {
    return { ok: false, error: 'phrase_mismatch' };
  }
  const dispatch =
    state.trigger.kind === 'path'
      ? buildPathResolutionDispatch({
          path: 'ws',
          resolution: state.trigger.resolution,
          lockout_confirmation_phrase: state.typed_phrase,
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
        })
      : buildPresetDispatch({
          preset: state.trigger.preset,
          lockout_confirmation_phrase: state.typed_phrase,
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
        });
  return {
    ok: true,
    dispatch,
    next: {
      kind: 'submitting',
      trigger: state.trigger,
      flavor: state.flavor,
      typed_phrase: state.typed_phrase,
    },
  };
};

/** Move the modal into the error state after an rpc rejection.
 *
 *  When the server's response carries an updated `ws_lockout_required_-
 *  phrase` (e.g., the active-client count changed between modal open
 *  and submit), the page-shell may want to reopen with the new
 *  required-phrase + flavor. Codex W3.8 P2 #3 fold — the optional
 *  `refresh` arg supports that flow: if supplied, the next state is
 *  `'open'` with the recomputed flavor; otherwise the state stays
 *  `'error'` and the user can re-type to transition back. */
export const failWsLockoutModal = (
  state: WsLockoutModalState,
  error: NetworkErrorCode,
  refresh?: {
    required_phrase: WsLockoutPhrase;
    active_ws_connections: number;
    caller_channel: WsLockoutCallerChannel;
  },
): WsLockoutModalState => {
  if (state.kind !== 'submitting' && state.kind !== 'open') return state;
  if (refresh) {
    const flavor = pickWsLockoutFlavor({
      caller_channel: refresh.caller_channel,
      active_ws_connections: refresh.active_ws_connections,
    });
    return {
      kind: 'open',
      trigger: state.trigger,
      flavor,
      active_ws_connections: refresh.active_ws_connections,
      required_phrase: refresh.required_phrase,
      typed_phrase: state.typed_phrase,
      phrase_valid: isValidWsLockoutPhrase(state.typed_phrase, refresh.required_phrase),
    };
  }
  return {
    kind: 'error',
    trigger: state.trigger,
    flavor: state.flavor,
    typed_phrase: state.typed_phrase,
    error,
  };
};

export { WS_LOCKOUT_DISABLE_PHRASE, WS_LOCKOUT_DISCONNECT_PHRASE };
