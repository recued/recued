import { describe, expect, it, vi } from 'vitest';

import {
  SERVER_SWITCH_CONTINUITY_SESSION_KEY,
  consumeServerSwitchArrival,
  requestServerSwitchReload,
  safeServerSwitchLandingHash,
  serverSwitchLandingAreaLabel,
} from '../shell/server-switch-continuity.js';

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    data,
  };
};

describe('deliberate server-switch continuity', () => {
  it('keeps a useful area but strips source-server record identities', () => {
    expect(safeServerSwitchLandingHash('#chat/session/chat_1/answer/msg_7'))
      .toBe('#chat');
    expect(safeServerSwitchLandingHash('#logs/run_1/return/chat/session/chat_1'))
      .toBe('#logs');
    expect(safeServerSwitchLandingHash('#connections/mail/account_1'))
      .toBe('#connections/mail');
    expect(safeServerSwitchLandingHash('#data/files/record/source/42'))
      .toBe('#data/files');
    expect(safeServerSwitchLandingHash('#settings/server/reachability'))
      .toBe('#settings/server');
    expect(safeServerSwitchLandingHash('#automation/triggers/rule_1'))
      .toBe('#automation/triggers');
    expect(safeServerSwitchLandingHash('#automation/source-recipe-id'))
      .toBe('#automation');
    // D-319 §5.4 — the page's views survive a switch like its lists do.
    expect(safeServerSwitchLandingHash('#automation/coming-up'))
      .toBe('#automation/coming-up');
    expect(serverSwitchLandingAreaLabel('#automation/coming-up')).toBe('Automation · Coming up');
    expect(safeServerSwitchLandingHash('#settings/source-record-id/detail'))
      .toBe('#settings');
    expect(safeServerSwitchLandingHash('#kitchen/recipe/recipe_1'))
      .toBe('#recipes');
    expect(serverSwitchLandingAreaLabel('#data/files')).toBe('Data · Files');
    expect(serverSwitchLandingAreaLabel('#logs')).toBe('Runs');
  });

  it('carries only an opaque target id and consumes it once', () => {
    const storage = memoryStorage();
    const reload = vi.fn();

    requestServerSwitchReload({
      targetProfileId: 'profile-office',
      storage,
      reload,
    });

    expect(reload).toHaveBeenCalledOnce();
    const raw = storage.data.get(SERVER_SWITCH_CONTINUITY_SESSION_KEY) ?? '';
    expect(raw).toContain('profile-office');
    expect(raw).not.toContain('wss://');
    expect(raw).not.toContain('#chat');
    expect(consumeServerSwitchArrival(storage)).toEqual({
      targetProfileId: 'profile-office',
    });
    expect(consumeServerSwitchArrival(storage)).toBeNull();
  });

  it('carries one canonical recovery-return area without source-owned detail', () => {
    const storage = memoryStorage();
    const reload = vi.fn();

    requestServerSwitchReload({
      targetProfileId: 'profile-home',
      recoveryReturnLandingHash: '#data/files',
      storage,
      reload,
    });

    expect(reload).toHaveBeenCalledOnce();
    const raw = storage.data.get(SERVER_SWITCH_CONTINUITY_SESSION_KEY) ?? '';
    expect(JSON.parse(raw)).toEqual({
      v: 2,
      target_profile_id: 'profile-home',
      kind: 'recovery_return',
      landing_hash: '#data/files',
    });
    expect(raw).not.toContain('source-record');
    expect(raw).not.toContain('wss://');
    expect(raw).not.toContain('recovery-key');
    expect(consumeServerSwitchArrival(storage)).toEqual({
      targetProfileId: 'profile-home',
      recoveryReturnLandingHash: '#data/files',
    });
    expect(consumeServerSwitchArrival(storage)).toBeNull();
  });

  it('carries only a closed-list freshness posture on new recovery returns', () => {
    const storage = memoryStorage();
    const reload = vi.fn();

    requestServerSwitchReload({
      targetProfileId: 'profile-home',
      recoveryReturnLandingHash: '#data/files',
      recoveryReturnContext: 'detail_withheld',
      storage,
      reload,
    });

    const raw = storage.data.get(SERVER_SWITCH_CONTINUITY_SESSION_KEY) ?? '';
    expect(JSON.parse(raw)).toEqual({
      v: 3,
      target_profile_id: 'profile-home',
      kind: 'recovery_return',
      landing_hash: '#data/files',
      return_context: 'detail_withheld',
    });
    expect(raw).not.toContain('record');
    expect(raw).not.toContain('session');
    expect(raw).not.toContain('draft');
    expect(consumeServerSwitchArrival(storage)).toEqual({
      targetProfileId: 'profile-home',
      recoveryReturnLandingHash: '#data/files',
      recoveryReturnContext: 'detail_withheld',
    });
  });

  it('refuses detail-bearing recovery landings before persistence or reload', () => {
    const storage = memoryStorage();
    const reload = vi.fn();

    expect(() => requestServerSwitchReload({
      targetProfileId: 'profile-home',
      recoveryReturnLandingHash: '#data/files/source-record-42',
      storage,
      reload,
    })).toThrow('no longer safe to go back there');
    expect(reload).not.toHaveBeenCalled();
    expect(storage.data.has(SERVER_SWITCH_CONTINUITY_SESSION_KEY)).toBe(false);

    expect(() => requestServerSwitchReload({
      targetProfileId: 'profile-home',
      recoveryReturnContext: 'area',
      storage,
      reload,
    })).toThrow('can no longer take you back there');
    expect(() => requestServerSwitchReload({
      targetProfileId: 'profile-home',
      recoveryReturnLandingHash: '#data/files',
      recoveryReturnContext: 'record-42' as never,
      storage,
      reload,
    })).toThrow('can no longer take you back there');
    expect(reload).not.toHaveBeenCalled();
    expect(storage.data.has(SERVER_SWITCH_CONTINUITY_SESSION_KEY)).toBe(false);
  });

  it('retires recovery markers with extra or non-canonical material', () => {
    for (const marker of [
      {
        v: 2,
        target_profile_id: 'profile-home',
        kind: 'recovery_return',
        landing_hash: '#data/files/source-record-42',
      },
      {
        v: 2,
        target_profile_id: 'profile-home',
        kind: 'recovery_return',
        landing_hash: '#data/files',
        profile_label: 'Home',
      },
      {
        v: 3,
        target_profile_id: 'profile-home',
        kind: 'recovery_return',
        landing_hash: '#data/files',
        return_context: 'record-42',
      },
      {
        v: 3,
        target_profile_id: 'profile-home',
        kind: 'recovery_return',
        landing_hash: '#data/files',
        return_context: 'area',
        record_id: 'must-not-survive',
      },
    ]) {
      const storage = memoryStorage();
      storage.setItem(
        SERVER_SWITCH_CONTINUITY_SESSION_KEY,
        JSON.stringify(marker),
      );
      expect(consumeServerSwitchArrival(storage)).toBeNull();
      expect(storage.data.has(SERVER_SWITCH_CONTINUITY_SESSION_KEY)).toBe(false);
    }
  });

  it('retires malformed markers and a marker whose reload throws', () => {
    const storage = memoryStorage();
    storage.setItem(SERVER_SWITCH_CONTINUITY_SESSION_KEY, '{bad');
    expect(consumeServerSwitchArrival(storage)).toBeNull();
    expect(storage.getItem(SERVER_SWITCH_CONTINUITY_SESSION_KEY)).toBeNull();

    expect(() => requestServerSwitchReload({
      targetProfileId: 'profile-office',
      storage,
      reload: () => { throw new Error('reload blocked'); },
    })).toThrow('reload blocked');
    expect(consumeServerSwitchArrival(storage)).toBeNull();

    expect(() => requestServerSwitchReload({
      targetProfileId: 'profile-office',
      recoveryReturnLandingHash: '#chat',
      storage,
      reload: () => { throw new Error('recovery reload blocked'); },
    })).toThrow('recovery reload blocked');
    expect(consumeServerSwitchArrival(storage)).toBeNull();
  });

  it('reloads without a receipt when session storage is unavailable', () => {
    const reload = vi.fn();
    const denied = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    };

    expect(() => requestServerSwitchReload({
      targetProfileId: 'profile-office',
      storage: denied,
      reload,
    })).not.toThrow();
    expect(reload).toHaveBeenCalledOnce();
  });
});
