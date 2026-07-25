/** D-148 W3.8 — settings: /ws lockout-protection modal. */

import { describe, expect, it } from 'vitest';
import {
  WS_LOCKOUT_DISABLE_PHRASE,
  WS_LOCKOUT_DISCONNECT_PHRASE,
} from '@recued/contracts';
import {
  WS_LOCKOUT_MODAL_COPY,
  closeWsLockoutModal,
  failWsLockoutModal,
  openWsLockoutModal,
  pickWsLockoutFlavor,
  requiredPhraseForFlavor,
  submitWsLockoutModal,
  typeWsLockoutPhrase,
  type WsLockoutModalState,
} from '../settings/ws-lockout-modal.js';

describe('D-148 W3.8 — ws-lockout modal flavor picker', () => {
  it('webclient_self_disconnect flavor when caller=webclient_over_ws + active>0', () => {
    expect(
      pickWsLockoutFlavor({
        caller_channel: 'webclient_over_ws',
        active_ws_connections: 3,
      }),
    ).toBe('webclient_self_disconnect');
  });

  it('cli_disconnects_others flavor when caller=cli_or_non_ws + active>0', () => {
    expect(
      pickWsLockoutFlavor({
        caller_channel: 'cli_or_non_ws',
        active_ws_connections: 2,
      }),
    ).toBe('cli_disconnects_others');
  });

  it('no_active_clients flavor when active=0 regardless of caller', () => {
    expect(
      pickWsLockoutFlavor({
        caller_channel: 'webclient_over_ws',
        active_ws_connections: 0,
      }),
    ).toBe('no_active_clients');
    expect(
      pickWsLockoutFlavor({
        caller_channel: 'cli_or_non_ws',
        active_ws_connections: 0,
      }),
    ).toBe('no_active_clients');
  });

  it('required phrase per flavor', () => {
    expect(requiredPhraseForFlavor('webclient_self_disconnect')).toBe(
      WS_LOCKOUT_DISCONNECT_PHRASE,
    );
    expect(requiredPhraseForFlavor('cli_disconnects_others')).toBe(
      WS_LOCKOUT_DISCONNECT_PHRASE,
    );
    expect(requiredPhraseForFlavor('no_active_clients')).toBe(WS_LOCKOUT_DISABLE_PHRASE);
  });

  it('every flavor has copy + at least two bullets', () => {
    for (const flavor of [
      'webclient_self_disconnect',
      'cli_disconnects_others',
      'no_active_clients',
    ] as const) {
      const copy = WS_LOCKOUT_MODAL_COPY[flavor];
      expect(copy.title).toBeTruthy();
      expect(copy.subtitle).toBeTruthy();
      expect(copy.bullets.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('D-148 W3.8 — ws-lockout modal state machine', () => {
  it('opens with required phrase pinned to the flavor', () => {
    const state = openWsLockoutModal({
      trigger: { kind: 'path', resolution: { lan: false, public: false } },
      caller_channel: 'webclient_over_ws',
      active_ws_connections: 1,
    });
    expect(state.kind).toBe('open');
    if (state.kind === 'open') {
      expect(state.required_phrase).toBe(WS_LOCKOUT_DISCONNECT_PHRASE);
      expect(state.flavor).toBe('webclient_self_disconnect');
      expect(state.phrase_valid).toBe(false);
    }
  });

  it('typing the wrong phrase keeps phrase_valid=false', () => {
    let state: WsLockoutModalState = openWsLockoutModal({
      trigger: { kind: 'path', resolution: { lan: false, public: false } },
      caller_channel: 'cli_or_non_ws',
      active_ws_connections: 1,
    });
    state = typeWsLockoutPhrase(state, 'goodbye');
    expect(state.kind).toBe('open');
    if (state.kind === 'open') {
      expect(state.phrase_valid).toBe(false);
    }
  });

  it('typing the disconnect phrase flips phrase_valid=true', () => {
    let state: WsLockoutModalState = openWsLockoutModal({
      trigger: { kind: 'path', resolution: { lan: false, public: false } },
      caller_channel: 'cli_or_non_ws',
      active_ws_connections: 4,
    });
    state = typeWsLockoutPhrase(state, WS_LOCKOUT_DISCONNECT_PHRASE);
    expect(state.kind).toBe('open');
    if (state.kind === 'open') {
      expect(state.phrase_valid).toBe(true);
    }
  });

  it('typing the disable phrase only validates when active=0', () => {
    let active = openWsLockoutModal({
      trigger: { kind: 'preset', preset: 'maintenance' },
      caller_channel: 'cli_or_non_ws',
      active_ws_connections: 1,
    });
    active = typeWsLockoutPhrase(active, WS_LOCKOUT_DISABLE_PHRASE);
    if (active.kind === 'open') {
      expect(active.phrase_valid).toBe(false);
    }
    let zero = openWsLockoutModal({
      trigger: { kind: 'preset', preset: 'maintenance' },
      caller_channel: 'cli_or_non_ws',
      active_ws_connections: 0,
    });
    zero = typeWsLockoutPhrase(zero, WS_LOCKOUT_DISABLE_PHRASE);
    if (zero.kind === 'open') {
      expect(zero.phrase_valid).toBe(true);
    }
  });

  it('submit (path) builds the path-resolution dispatch + threads the phrase', () => {
    let state: WsLockoutModalState = openWsLockoutModal({
      trigger: { kind: 'path', resolution: { lan: false, public: false } },
      caller_channel: 'webclient_over_ws',
      active_ws_connections: 2,
    });
    state = typeWsLockoutPhrase(state, WS_LOCKOUT_DISCONNECT_PHRASE);
    const r = submitWsLockoutModal(state);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dispatch.op).toBe('exposure.set_path_resolution');
      if (r.dispatch.op === 'exposure.set_path_resolution') {
        expect(r.dispatch.path).toBe('ws');
        expect(r.dispatch.lockout_confirmation_phrase).toBe(WS_LOCKOUT_DISCONNECT_PHRASE);
      }
    }
  });

  it('submit (preset) builds the preset dispatch + threads the phrase', () => {
    let state: WsLockoutModalState = openWsLockoutModal({
      trigger: { kind: 'preset', preset: 'maintenance' },
      caller_channel: 'cli_or_non_ws',
      active_ws_connections: 0,
    });
    state = typeWsLockoutPhrase(state, WS_LOCKOUT_DISABLE_PHRASE);
    const r = submitWsLockoutModal(state, { reason: 'maintenance window' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dispatch.op).toBe('exposure.apply_preset');
      if (r.dispatch.op === 'exposure.apply_preset') {
        expect(r.dispatch.preset).toBe('maintenance');
        expect(r.dispatch.lockout_confirmation_phrase).toBe(WS_LOCKOUT_DISABLE_PHRASE);
        expect(r.dispatch.reason).toBe('maintenance window');
      }
    }
  });

  it('submit fails with phrase_required when empty', () => {
    const state = openWsLockoutModal({
      trigger: { kind: 'path', resolution: { lan: false, public: false } },
      caller_channel: 'cli_or_non_ws',
      active_ws_connections: 1,
    });
    const r = submitWsLockoutModal(state);
    expect(r).toEqual({ ok: false, error: 'phrase_required' });
  });

  it('submit fails with phrase_mismatch when wrong phrase typed', () => {
    let state: WsLockoutModalState = openWsLockoutModal({
      trigger: { kind: 'path', resolution: { lan: false, public: false } },
      caller_channel: 'cli_or_non_ws',
      active_ws_connections: 1,
    });
    state = typeWsLockoutPhrase(state, WS_LOCKOUT_DISABLE_PHRASE);
    const r = submitWsLockoutModal(state);
    expect(r).toEqual({ ok: false, error: 'phrase_mismatch' });
  });

  it('failWsLockoutModal moves state to error preserving typed phrase', () => {
    let state: WsLockoutModalState = openWsLockoutModal({
      trigger: { kind: 'path', resolution: { lan: false, public: false } },
      caller_channel: 'cli_or_non_ws',
      active_ws_connections: 1,
    });
    state = typeWsLockoutPhrase(state, 'something');
    state = failWsLockoutModal(state, 'ws_lockout_phrase_mismatch');
    expect(state.kind).toBe('error');
    if (state.kind === 'error') {
      expect(state.error).toBe('ws_lockout_phrase_mismatch');
      expect(state.typed_phrase).toBe('something');
    }
  });

  it('closeWsLockoutModal returns idle', () => {
    expect(closeWsLockoutModal()).toEqual({ kind: 'idle' });
  });

  it('Codex P2 #3 — typing on error state transitions back to open + re-validates', () => {
    let state: WsLockoutModalState = openWsLockoutModal({
      trigger: { kind: 'path', resolution: { lan: false, public: false } },
      caller_channel: 'cli_or_non_ws',
      active_ws_connections: 3,
    });
    state = typeWsLockoutPhrase(state, 'wrong');
    state = failWsLockoutModal(state, 'ws_lockout_phrase_mismatch');
    expect(state.kind).toBe('error');
    state = typeWsLockoutPhrase(state, WS_LOCKOUT_DISCONNECT_PHRASE);
    expect(state.kind).toBe('open');
    if (state.kind === 'open') {
      expect(state.phrase_valid).toBe(true);
      expect(state.required_phrase).toBe(WS_LOCKOUT_DISCONNECT_PHRASE);
    }
  });

  it('Codex P2 #3 — retry flow: type → fail → re-type → submit succeeds', () => {
    let state: WsLockoutModalState = openWsLockoutModal({
      trigger: { kind: 'path', resolution: { lan: false, public: false } },
      caller_channel: 'cli_or_non_ws',
      active_ws_connections: 3,
    });
    state = typeWsLockoutPhrase(state, WS_LOCKOUT_DISABLE_PHRASE);
    const first = submitWsLockoutModal(state);
    expect(first.ok).toBe(false);
    state = failWsLockoutModal(state, 'ws_lockout_phrase_mismatch');
    state = typeWsLockoutPhrase(state, WS_LOCKOUT_DISCONNECT_PHRASE);
    const second = submitWsLockoutModal(state);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.dispatch.lockout_confirmation_phrase).toBe(WS_LOCKOUT_DISCONNECT_PHRASE);
    }
  });

  it('Codex P2 #3 — failWsLockoutModal with refresh re-opens at updated flavor', () => {
    let state: WsLockoutModalState = openWsLockoutModal({
      trigger: { kind: 'path', resolution: { lan: false, public: false } },
      caller_channel: 'cli_or_non_ws',
      active_ws_connections: 0,
    });
    state = typeWsLockoutPhrase(state, WS_LOCKOUT_DISABLE_PHRASE);
    // Server reports a client connected between modal open + submit;
    // refresh with the new required phrase + flavor.
    state = failWsLockoutModal(state, 'ws_lockout_phrase_mismatch', {
      required_phrase: WS_LOCKOUT_DISCONNECT_PHRASE,
      active_ws_connections: 1,
      caller_channel: 'cli_or_non_ws',
    });
    expect(state.kind).toBe('open');
    if (state.kind === 'open') {
      expect(state.flavor).toBe('cli_disconnects_others');
      expect(state.required_phrase).toBe(WS_LOCKOUT_DISCONNECT_PHRASE);
      // The typed (now-stale) `disable ws` phrase doesn't validate
      // against the upgraded `disconnect webclients` requirement.
      expect(state.phrase_valid).toBe(false);
    }
  });
});
