import { describe, expect, it, vi } from 'vitest';

import {
  STARTUP_RELOAD_RECOVERY_SESSION_KEY,
  consumeStartupReloadRecovery,
  requestStartupRecoveryReload,
  type StartupReloadRecoveryStorage,
} from './startup-reload-recovery.js';

const makeStorage = () => {
  const values = new Map<string, string>();
  const storage: StartupReloadRecoveryStorage = {
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

describe('intentional startup reload continuity', () => {
  it('stores only a constant marker, consumes it once, and removes it', () => {
    const { storage, values } = makeStorage();
    const reload = vi.fn();

    requestStartupRecoveryReload({ storage, reload });

    expect(reload).toHaveBeenCalledOnce();
    expect([...values.entries()]).toEqual([
      [STARTUP_RELOAD_RECOVERY_SESSION_KEY, '1'],
    ]);
    expect(consumeStartupReloadRecovery(storage)).toBe(true);
    expect(values.size).toBe(0);
    expect(consumeStartupReloadRecovery(storage)).toBe(false);
  });

  it('retires an unknown value without treating it as a recovery', () => {
    const { storage, values } = makeStorage();
    values.set(
      STARTUP_RELOAD_RECOVERY_SESSION_KEY,
      'not-a-valid-recovery-marker',
    );

    expect(consumeStartupReloadRecovery(storage)).toBe(false);
    expect(values.size).toBe(0);
  });

  it('does not mutate session storage during an ordinary startup', () => {
    const setItem = vi.fn();
    const removeItem = vi.fn();
    const storage: StartupReloadRecoveryStorage = {
      getItem: () => null,
      setItem,
      removeItem,
    };

    expect(consumeStartupReloadRecovery(storage)).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  it('invalidates the marker before acknowledging it when deletion is denied', () => {
    let value: string | null = '1';
    const storage: StartupReloadRecoveryStorage = {
      getItem: () => value,
      setItem: (_key, nextValue) => {
        value = nextValue;
      },
      removeItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    };

    expect(consumeStartupReloadRecovery(storage)).toBe(true);
    expect(value).toBe('0');
    expect(consumeStartupReloadRecovery(storage)).toBe(false);
  });

  it('fails closed when an armed marker cannot be safely retired', () => {
    const storage: StartupReloadRecoveryStorage = {
      getItem: () => '1',
      setItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      removeItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    };

    expect(consumeStartupReloadRecovery(storage)).toBe(false);
  });

  it('still reloads when session storage is unavailable', () => {
    const reload = vi.fn();
    const storage: StartupReloadRecoveryStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      removeItem: () => undefined,
    };

    requestStartupRecoveryReload({ storage, reload });

    expect(reload).toHaveBeenCalledOnce();
  });

  it('clears an armed marker if reload throws', () => {
    const { storage, values } = makeStorage();

    expect(() => requestStartupRecoveryReload({
      storage,
      reload: () => {
        throw new Error('reload unavailable');
      },
    })).toThrow('reload unavailable');
    expect(values.size).toBe(0);
  });
});
