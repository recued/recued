import { describe, expect, it, vi } from 'vitest';

import {
  RECOVERY_REENTRY_SESSION_KEY,
  armRecoveryReentry,
  armReplacementServerRecoveryReentry,
  armSafeStopRecoveryReentry,
  consumeRecoveryReentry,
  consumeRecoveryReentryState,
  retireRecoveryReentry,
  scrubRecoveryReentryAddress,
  type RecoveryReentryStorage,
} from './recovery-reentry.js';

const makeStorage = () => {
  const values = new Map<string, string>();
  const storage: RecoveryReentryStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  return { storage, values };
};

describe('last-tab recovery re-entry continuity', () => {
  it('stores only one unresolved constant, consumes it once, and removes it', () => {
    const { storage, values } = makeStorage();

    expect(armRecoveryReentry(storage)).toBe(true);
    expect([...values.entries()]).toEqual([
      [RECOVERY_REENTRY_SESSION_KEY, '1'],
    ]);
    expect(consumeRecoveryReentry(storage)).toBe(true);
    expect(values.size).toBe(0);
    expect(consumeRecoveryReentry(storage)).toBe(false);
  });

  it('stores safe-stop intent as one distinct constant and consumes no detail', () => {
    const { storage, values } = makeStorage();

    expect(armSafeStopRecoveryReentry(storage)).toBe(true);
    expect([...values.entries()]).toEqual([
      [RECOVERY_REENTRY_SESSION_KEY, '2'],
    ]);
    expect(consumeRecoveryReentryState(storage)).toBe('safe_stop');
    expect(values.size).toBe(0);
    expect(consumeRecoveryReentryState(storage)).toBeNull();
  });

  it('stores replacement-server intent as one constant and consumes no details', () => {
    const { storage, values } = makeStorage();

    expect(armReplacementServerRecoveryReentry(storage)).toBe(true);
    expect([...values.entries()]).toEqual([
      [RECOVERY_REENTRY_SESSION_KEY, '3'],
    ]);
    expect(consumeRecoveryReentryState(storage)).toBe('replacement_server');
    expect(values.size).toBe(0);
  });

  it('keeps the boolean consumer compatible with either constant state', () => {
    const { storage } = makeStorage();

    expect(armSafeStopRecoveryReentry(storage)).toBe(true);
    expect(consumeRecoveryReentry(storage)).toBe(true);
    expect(armRecoveryReentry(storage)).toBe(true);
    expect(consumeRecoveryReentryState(storage)).toBe('unresolved');
  });

  it('retires stale values without treating them as recovery intent', () => {
    const { storage, values } = makeStorage();
    values.set(RECOVERY_REENTRY_SESSION_KEY, 'stale-detail');

    expect(consumeRecoveryReentry(storage)).toBe(false);
    expect(values.size).toBe(0);
  });

  it('makes a marker inert when deletion is denied', () => {
    let value: string | null = '1';
    const storage: RecoveryReentryStorage = {
      getItem: () => value,
      setItem: (_key, next) => {
        value = next;
      },
      removeItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    };

    expect(consumeRecoveryReentry(storage)).toBe(true);
    expect(value).toBe('0');
    expect(consumeRecoveryReentry(storage)).toBe(false);
  });

  it('fails closed when storage cannot be read or retired', () => {
    const storage: RecoveryReentryStorage = {
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      removeItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    };

    expect(armRecoveryReentry(storage)).toBe(false);
    expect(armSafeStopRecoveryReentry(storage)).toBe(false);
    expect(armReplacementServerRecoveryReentry(storage)).toBe(false);
    expect(consumeRecoveryReentry(storage)).toBe(false);
    expect(retireRecoveryReentry(storage)).toBe(false);
  });

  it('scrubs every pairing input while preserving the exact route and query', () => {
    const replaceUrl = vi.fn();
    const cleaned = scrubRecoveryReentryAddress({
      currentUrl: () =>
        'https://app.recued.test/webclient/?keep=a%20b&code=STALE&recued_pair_resume=same-origin&keep=a+b#chat/session/chat_1',
      replaceUrl,
    });

    expect(cleaned).toBe(
      'https://app.recued.test/webclient/?keep=a%20b&keep=a+b#chat/session/chat_1',
    );
    expect(replaceUrl).toHaveBeenCalledWith(cleaned);
  });
});
