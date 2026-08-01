import { describe, expect, it, vi } from 'vitest';
import { WEBCLIENT_INDEXED_DB_NAME } from '@recued/contracts';

import {
  PERSISTENT_STORAGE_RECOVERY_ATTR,
  PERSISTENT_STORAGE_RELOAD_ATTR,
  PERSISTENT_STORAGE_RETRY_ATTR,
  PERSISTENT_STORAGE_STATUS_ATTR,
  PersistentStorageStartupError,
  WEBCLIENT_LOCAL_STORE_NAME,
  WEBCLIENT_TOKEN_KEY_STORE_NAME,
  classifyPersistentStorageFailure,
  closeAbandonedPersistentStorageOpen,
  mountPersistentStorageRecoveryHost,
  openPersistentStorageWithRecovery,
  openWebclientDatabase,
} from './persistent-storage-startup.js';

interface FakeRecoveryDom {
  readonly document: Document;
  readonly getHtml: () => string;
  readonly retryFocus: ReturnType<typeof vi.fn>;
  readonly reloadFocus: ReturnType<typeof vi.fn>;
  readonly statusFocus: ReturnType<typeof vi.fn>;
  readonly fireAction: (attribute: string) => void;
}

const fakeRecoveryDom = (): FakeRecoveryDom => {
  let html = '';
  const listeners = new Set<(event: Event) => void>();
  const retryFocus = vi.fn();
  const reloadFocus = vi.fn();
  const statusFocus = vi.fn();
  const splash = {
    get innerHTML() {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
    },
    addEventListener: (type: string, listener: (event: Event) => void) => {
      if (type === 'click') listeners.add(listener);
    },
    removeEventListener: (type: string, listener: (event: Event) => void) => {
      if (type === 'click') listeners.delete(listener);
    },
    querySelector: (selector: string) => {
      if (selector === `[${PERSISTENT_STORAGE_RETRY_ATTR}]`) {
        return { focus: retryFocus };
      }
      if (selector === `[${PERSISTENT_STORAGE_STATUS_ATTR}]`) {
        return { focus: statusFocus };
      }
      if (selector === `[${PERSISTENT_STORAGE_RELOAD_ATTR}]`) {
        return { focus: reloadFocus };
      }
      return null;
    },
  } as unknown as HTMLElement;
  let styleNode: unknown = null;
  const document = {
    head: {
      querySelector: () => styleNode,
      appendChild: (node: unknown) => {
        styleNode = node;
        return node;
      },
    },
    createElement: () => ({
      setAttribute: vi.fn(),
      textContent: '',
    }),
    getElementById: (id: string) =>
      id === 'webclient-boot-splash-message' ? splash : null,
  } as unknown as Document;

  return {
    document,
    getHtml: () => html,
    retryFocus,
    reloadFocus,
    statusFocus,
    fireAction: (attribute) => {
      for (const listener of [...listeners]) {
        listener({
          target: {
            closest: (selector: string) =>
              selector === `[${attribute}]` ? {} : null,
          },
          preventDefault: vi.fn(),
        } as unknown as Event);
      }
    },
  };
};

interface FakeOpenRequest {
  readonly factory: IDBFactory;
  readonly request: IDBOpenDBRequest;
  readonly db: IDBDatabase;
  readonly createObjectStore: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
}

const fakeOpenRequest = (): FakeOpenRequest => {
  const createObjectStore = vi.fn();
  const close = vi.fn();
  const db = {
    objectStoreNames: {
      contains: vi.fn(() => false),
    },
    createObjectStore,
    close,
    onversionchange: null,
  } as unknown as IDBDatabase;
  const request = {
    result: db,
    error: null,
    onupgradeneeded: null,
    onsuccess: null,
    onerror: null,
    onblocked: null,
  } as unknown as IDBOpenDBRequest;
  const factory = {
    open: vi.fn(() => request),
  } as unknown as IDBFactory;
  return { factory, request, db, createObjectStore, close };
};

describe('persistent storage failure classification', () => {
  it('distinguishes browser denial, quota, blocked upgrades, and unknown errors', () => {
    expect(classifyPersistentStorageFailure({ name: 'SecurityError' })).toBe(
      'denied',
    );
    expect(classifyPersistentStorageFailure({ name: 'NotAllowedError' })).toBe(
      'denied',
    );
    expect(
      classifyPersistentStorageFailure({ name: 'QuotaExceededError' }),
    ).toBe('quota');
    expect(classifyPersistentStorageFailure({ name: 'VersionError' })).toBe(
      'outdated',
    );
    expect(classifyPersistentStorageFailure(
      new PersistentStorageStartupError('blocked', 'blocked'),
    )).toBe('blocked');
    expect(classifyPersistentStorageFailure(new Error('unknown'))).toBe(
      'unavailable',
    );
  });
});

describe('openWebclientDatabase', () => {
  it('creates the closed-list stores and returns the opened database', async () => {
    const fake = fakeOpenRequest();
    const opening = openWebclientDatabase(fake.factory);

    expect(fake.factory.open).toHaveBeenCalledWith(
      WEBCLIENT_INDEXED_DB_NAME,
      1,
    );
    fake.request.onupgradeneeded?.({} as IDBVersionChangeEvent);
    expect(fake.createObjectStore.mock.calls.map(([name]) => name)).toEqual([
      WEBCLIENT_LOCAL_STORE_NAME,
      WEBCLIENT_TOKEN_KEY_STORE_NAME,
    ]);
    fake.request.onsuccess?.({} as Event);

    await expect(opening).resolves.toBe(fake.db);
    expect(fake.close).not.toHaveBeenCalled();
  });

  it('types a blocked upgrade and exposes that same request when it succeeds', async () => {
    const fake = fakeOpenRequest();
    const opening = openWebclientDatabase(fake.factory);
    fake.request.onblocked?.({} as IDBVersionChangeEvent);
    const failure = await opening.catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: 'PersistentStorageStartupError',
      kind: 'blocked',
    });
    const pendingOpen = (failure as PersistentStorageStartupError).pendingOpen;
    expect(pendingOpen).not.toBeNull();

    fake.request.onsuccess?.({} as Event);

    await expect(pendingOpen!).resolves.toBe(fake.db);
    expect(fake.close).not.toHaveBeenCalled();
  });

  it('maps synchronous platform denial without losing its diagnostic error', async () => {
    const denied = Object.assign(new Error('site data disabled'), {
      name: 'SecurityError',
    });
    const factory = {
      open: vi.fn(() => {
        throw denied;
      }),
    } as unknown as IDBFactory;

    await expect(openWebclientDatabase(factory)).rejects.toMatchObject({
      kind: 'denied',
      originalError: denied,
    });
  });

  it('closes a late blocked handle for direct callers that cannot resume it', async () => {
    const close = vi.fn();
    let resolvePending!: (database: IDBDatabase) => void;
    const pendingOpen = new Promise<IDBDatabase>((resolve) => {
      resolvePending = resolve;
    });
    const error = new PersistentStorageStartupError(
      'blocked',
      'blocked maintenance open',
      undefined,
      pendingOpen,
    );

    closeAbandonedPersistentStorageOpen(error);
    resolvePending({ close } as unknown as IDBDatabase);
    await pendingOpen;
    await Promise.resolve();

    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('mountPersistentStorageRecoveryHost', () => {
  it('explains a blocked tab, keeps server safety explicit, and focuses retry', () => {
    const dom = fakeRecoveryDom();
    const reload = vi.fn();
    mountPersistentStorageRecoveryHost({
      document: dom.document,
      failure: new PersistentStorageStartupError('blocked', 'blocked'),
      onRetry: async () => undefined,
      onReload: reload,
    });

    expect(dom.getHtml()).toContain(PERSISTENT_STORAGE_RECOVERY_ATTR);
    expect(dom.getHtml()).toContain('Close another Recued tab');
    expect(dom.getHtml()).toContain('Your server data is safe.');
    expect(dom.getHtml()).toContain('keeps this tab on the page you opened');
    expect(dom.getHtml()).toContain('Waiting for other Recued tabs');
    expect(dom.getHtml()).not.toContain('blocked by another open connection');
    expect(dom.retryFocus).toHaveBeenCalledTimes(1);

    dom.fireAction(PERSISTENT_STORAGE_RELOAD_ATTR);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('acknowledges an explicit reload that still cannot open storage', () => {
    const dom = fakeRecoveryDom();
    const reload = vi.fn();
    mountPersistentStorageRecoveryHost({
      document: dom.document,
      failure: Object.assign(
        new Error('private storage detail token=DO-NOT-RENDER'),
        { name: 'SecurityError' },
      ),
      onRetry: async () => undefined,
      onReload: reload,
      reloadAttempted: true,
    });

    expect(dom.getHtml()).toContain('Browser storage is blocked');
    expect(dom.getHtml()).toContain(
      'This tab reloaded, but browser storage still did not open.',
    );
    expect(dom.getHtml()).toContain('exact page you opened is still selected');
    expect(dom.getHtml()).toContain(
      'aria-describedby="webclient-persistent-storage-recovery-safety webclient-persistent-storage-recovery-context"',
    );
    expect(dom.getHtml()).not.toContain('DO-NOT-RENDER');
    expect(dom.retryFocus).toHaveBeenCalledTimes(1);

    dom.fireAction(PERSISTENT_STORAGE_RELOAD_ATTR);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('updates its diagnosis after a failed retry and announces success', async () => {
    const dom = fakeRecoveryDom();
    const onRecovered = vi.fn();
    const onRetry = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('full'), {
        name: 'QuotaExceededError',
      }))
      .mockResolvedValueOnce(undefined);
    const host = mountPersistentStorageRecoveryHost({
      document: dom.document,
      failure: new PersistentStorageStartupError('blocked', 'blocked'),
      onRetry,
      onRecovered,
    });

    await host.retry();
    expect(dom.getHtml()).toContain('Make room for browser storage');
    expect(dom.getHtml()).toContain('Storage is still full');
    expect(dom.retryFocus).toHaveBeenCalledTimes(2);

    await host.retry();
    expect(dom.getHtml()).toContain('Browser storage is ready');
    expect(dom.getHtml()).toContain('Starting Recued');
    expect(dom.statusFocus).toHaveBeenCalled();
    expect(onRecovered).toHaveBeenCalledTimes(1);
  });

  it('makes reload primary for a stale tab that cannot retry an older schema', () => {
    const dom = fakeRecoveryDom();
    mountPersistentStorageRecoveryHost({
      document: dom.document,
      failure: Object.assign(new Error('newer database'), {
        name: 'VersionError',
      }),
      onRetry: async () => undefined,
    });

    expect(dom.getHtml()).toContain('Reload the latest Recued');
    expect(dom.getHtml()).toContain('older Recued version');
    expect(dom.getHtml().indexOf(PERSISTENT_STORAGE_RELOAD_ATTR)).toBeLessThan(
      dom.getHtml().indexOf(PERSISTENT_STORAGE_RETRY_ATTR),
    );
    expect(dom.reloadFocus).toHaveBeenCalledTimes(1);
  });

  it('keeps reload available while an explicit storage check is pending', async () => {
    const dom = fakeRecoveryDom();
    const reload = vi.fn();
    let resolveRetry!: () => void;
    const pendingRetry = new Promise<void>((resolve) => {
      resolveRetry = resolve;
    });
    const host = mountPersistentStorageRecoveryHost({
      document: dom.document,
      failure: new PersistentStorageStartupError('blocked', 'blocked'),
      onRetry: () => pendingRetry,
      onReload: reload,
    });

    const retrying = host.retry();
    expect(dom.getHtml()).toContain('Checking browser storage');
    expect(dom.getHtml()).not.toContain(
      `${PERSISTENT_STORAGE_RELOAD_ATTR} disabled`,
    );
    dom.fireAction(PERSISTENT_STORAGE_RELOAD_ATTR);
    expect(reload).toHaveBeenCalledTimes(1);

    resolveRetry();
    await retrying;
  });
});

describe('openPersistentStorageWithRecovery', () => {
  it('waits for an explicit retry, reports the reason, then resumes in place', async () => {
    const dom = fakeRecoveryDom();
    const storage = { name: 'opened-storage' };
    const openStorage = vi.fn()
      .mockRejectedValueOnce(
        new PersistentStorageStartupError('blocked', 'other tab'),
      )
      .mockResolvedValueOnce(storage);
    const onFailure = vi.fn();
    const reload = vi.fn();

    const opening = openPersistentStorageWithRecovery({
      document: dom.document,
      openStorage,
      onFailure,
      reload,
      reloadAttempted: true,
    });
    await vi.waitFor(() => {
      expect(dom.getHtml()).toContain('Close another Recued tab');
    });
    expect(openStorage).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(expect.any(Error), 'blocked');
    expect(dom.getHtml()).toContain(
      'This tab reloaded, but browser storage still did not open.',
    );

    dom.fireAction(PERSISTENT_STORAGE_RELOAD_ATTR);
    expect(reload).toHaveBeenCalledTimes(1);

    dom.fireAction(PERSISTENT_STORAGE_RETRY_ATTR);

    await expect(opening).resolves.toBe(storage);
    expect(openStorage).toHaveBeenCalledTimes(2);
    expect(dom.getHtml()).toContain('Continuing from the page you opened');
  });

  it('reuses and automatically resumes the original blocked open request', async () => {
    const dom = fakeRecoveryDom();
    const storage = { close: vi.fn() } as unknown as IDBDatabase;
    let resolveBlocked!: (database: IDBDatabase) => void;
    const pendingOpen = new Promise<IDBDatabase>((resolve) => {
      resolveBlocked = resolve;
    });
    const openStorage = vi.fn().mockRejectedValueOnce(
      new PersistentStorageStartupError(
        'blocked',
        'other tab',
        undefined,
        pendingOpen,
      ),
    );

    const opening = openPersistentStorageWithRecovery({
      document: dom.document,
      openStorage,
    });
    await vi.waitFor(() => {
      expect(dom.getHtml()).toContain('continues automatically');
    });

    resolveBlocked(storage);

    await expect(opening).resolves.toBe(storage);
    expect(openStorage).toHaveBeenCalledTimes(1);
    expect(dom.getHtml()).toContain('Browser storage is ready');
  });
});
