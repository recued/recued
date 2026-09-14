/** Guided recovery for persistent browser storage that is unavailable at boot.
 *
 * Recued cannot safely pair or reconnect until IndexedDB is available: the
 * encrypted bearer and its non-extractable key live there. This surface keeps
 * that platform failure distinct from damaged credentials. It never clears
 * local or server data; it explains the likely cause and lets the owner retry
 * in place or intentionally reload without losing the route they opened. */

import {
  WEBCLIENT_INDEXED_DB_NAME,
  WEBCLIENT_OBJECT_STORES,
} from '@recued/contracts';

export const WEBCLIENT_LOCAL_STORE_NAME = WEBCLIENT_OBJECT_STORES[0];
export const WEBCLIENT_TOKEN_KEY_STORE_NAME = WEBCLIENT_OBJECT_STORES[1];

export const PERSISTENT_STORAGE_RECOVERY_ATTR =
  'data-recued-persistent-storage-recovery';
export const PERSISTENT_STORAGE_RETRY_ATTR =
  'data-recued-persistent-storage-retry';
export const PERSISTENT_STORAGE_RELOAD_ATTR =
  'data-recued-persistent-storage-reload';
export const PERSISTENT_STORAGE_STATUS_ATTR =
  'data-recued-persistent-storage-status';

const PERSISTENT_STORAGE_TITLE_ID =
  'webclient-persistent-storage-recovery-title';
const PERSISTENT_STORAGE_SAFETY_ID =
  'webclient-persistent-storage-recovery-safety';
const PERSISTENT_STORAGE_CONTEXT_ID =
  'webclient-persistent-storage-recovery-context';
const PERSISTENT_STORAGE_STYLES_MARKER =
  'data-recued-persistent-storage-recovery-styles';
const BOOT_SPLASH_MESSAGE_ID = 'webclient-boot-splash-message';

export type PersistentStorageFailureKind =
  | 'blocked'
  | 'denied'
  | 'quota'
  | 'outdated'
  | 'unavailable';

/** Typed boundary between the platform open request and user-facing recovery.
 * Raw DOMException text is retained for diagnostics but never rendered. */
export class PersistentStorageStartupError extends Error {
  readonly kind: PersistentStorageFailureKind;
  readonly originalError: unknown;
  /** A blocked version-change request remains pending by platform contract.
   * Recovery reuses it instead of queueing another open behind it. */
  readonly pendingOpen: Promise<IDBDatabase> | null;

  constructor(
    kind: PersistentStorageFailureKind,
    message: string,
    originalError?: unknown,
    pendingOpen?: Promise<IDBDatabase>,
  ) {
    super(message);
    this.name = 'PersistentStorageStartupError';
    this.kind = kind;
    this.originalError = originalError;
    this.pendingOpen = pendingOpen ?? null;
  }
}

const errorName = (error: unknown): string | null => {
  if (
    typeof error === 'object'
    && error !== null
    && 'name' in error
    && typeof error.name === 'string'
  ) {
    return error.name;
  }
  return null;
};

/** Conservative DOMException classification. We only claim a specific cause
 * for names the platform defines; everything else gets honest generic copy. */
export const classifyPersistentStorageFailure = (
  error: unknown,
): PersistentStorageFailureKind => {
  if (error instanceof PersistentStorageStartupError) return error.kind;
  switch (errorName(error)) {
    case 'SecurityError':
    case 'NotAllowedError':
      return 'denied';
    case 'QuotaExceededError':
      return 'quota';
    case 'VersionError':
      return 'outdated';
    default:
      return 'unavailable';
  }
};

const asPersistentStorageError = (
  error: unknown,
): PersistentStorageStartupError => {
  if (error instanceof PersistentStorageStartupError) return error;
  return new PersistentStorageStartupError(
    classifyPersistentStorageFailure(error),
    error instanceof Error
      ? error.message
      : 'browser storage did not open',
    error,
  );
};

/** Direct non-startup callers cannot resume a blocked open request. Arrange to
 * close its eventual handle so an abandoned maintenance action cannot become
 * the next tab's blocker. Startup recovery claims the pending promise instead. */
export const closeAbandonedPersistentStorageOpen = (error: unknown): void => {
  if (
    !(error instanceof PersistentStorageStartupError)
    || error.pendingOpen === null
  ) {
    return;
  }
  void error.pendingOpen.then(
    (database) => database.close(),
    () => undefined,
  );
};

interface PendingDatabaseOpen {
  readonly promise: Promise<IDBDatabase>;
  readonly resolve: (database: IDBDatabase) => void;
  readonly reject: (error: unknown) => void;
}

const pendingDatabaseOpen = (): PendingDatabaseOpen => {
  let resolve!: (database: IDBDatabase) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<IDBDatabase>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // A user may reload instead of waiting. Mark a later platform rejection as
  // observed without changing what callers receive when they do await it.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
};

/** Open the documented two-store database. A blocked upgrade is typed so the
 * boot surface can give tab-specific guidance. The platform keeps that request
 * queued until older connections close; expose its continuation so recovery
 * can await the same request rather than deadlocking a second open behind it. */
export const openWebclientDatabase = (
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    if (factory === undefined) {
      reject(new PersistentStorageStartupError(
        'unavailable',
        'this browser does not offer storage',
      ));
      return;
    }

    let request: IDBOpenDBRequest;
    try {
      request = factory.open(WEBCLIENT_INDEXED_DB_NAME, 1);
    } catch (error) {
      reject(asPersistentStorageError(error));
      return;
    }

    let settled = false;
    let blockedContinuation: PendingDatabaseOpen | null = null;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(asPersistentStorageError(error));
    };

    request.onupgradeneeded = (): void => {
      const db = request.result;
      if (!db.objectStoreNames.contains(WEBCLIENT_LOCAL_STORE_NAME)) {
        db.createObjectStore(WEBCLIENT_LOCAL_STORE_NAME);
      }
      if (!db.objectStoreNames.contains(WEBCLIENT_TOKEN_KEY_STORE_NAME)) {
        db.createObjectStore(WEBCLIENT_TOKEN_KEY_STORE_NAME);
      }
    };
    request.onsuccess = (): void => {
      const db = request.result;
      if (blockedContinuation !== null) {
        blockedContinuation.resolve(db);
        return;
      }
      if (settled) return;
      settled = true;
      resolve(db);
    };
    request.onerror = (): void => {
      const error = asPersistentStorageError(
        request.error ?? new Error('indexedDB.open rejected'),
      );
      if (blockedContinuation !== null) {
        blockedContinuation.reject(error);
        return;
      }
      fail(error);
    };
    request.onblocked = (): void => {
      if (settled) return;
      blockedContinuation = pendingDatabaseOpen();
      fail(
        new PersistentStorageStartupError(
          'blocked',
          'another Recued tab or window is holding storage open',
          undefined,
          blockedContinuation.promise,
        ),
      );
    };
  });

interface PersistentStorageRecoveryCopy {
  readonly kicker: string;
  readonly title: string;
  readonly summary: string;
  readonly steps: readonly [string, string];
  readonly retryError: string;
}

const recoveryCopy = (
  kind: PersistentStorageFailureKind,
): PersistentStorageRecoveryCopy => {
  switch (kind) {
    case 'blocked':
      return {
        kicker: 'Browser storage is busy',
        title: 'Close another Recued tab',
        summary:
          'Another Recued tab or window is still using an older copy of what this browser saved.',
        steps: [
          'Close other Recued tabs and installed Recued windows for this site.',
          'This tab carries on by itself once storage is free. If you have already closed them, choose Check again.',
        ],
        retryError:
          'Storage is still in use. Close the last Recued tab or window, then check again.',
      };
    case 'denied':
      return {
        kicker: 'Browser storage is blocked',
        title: 'Allow storage to continue',
        summary:
          'This browser will not let Recued save anything here. Recued needs to save a little, to keep you signed in safely.',
        steps: [
          'If this is a private window, open this page in a normal window instead.',
          'If it is not, let this Recued address save data, come back, then choose Check again.',
        ],
        retryError:
          'Storage is still blocked. Let this address save data, or use a normal window, then check again.',
      };
    case 'quota':
      return {
        kicker: 'Browser storage is full',
        title: 'Make room for browser storage',
        summary:
          'There is not enough room left on this browser or device. Recued needs a little room to keep you signed in.',
        steps: [
          'Make a little room on this device or browser.',
          'Do not delete Recued’s own saved data unless you have your recovery key. Then come back and choose Check again.',
        ],
        retryError:
          'There is still no room. Make a little more space, then check again.',
      };
    case 'outdated':
      return {
        kicker: 'This tab needs an update',
        title: 'Reload the latest Recued',
        summary:
          'This tab is running an older Recued than the one that saved data on this device.',
        steps: [
          'Reload this tab to get the Recued that matches what is saved here.',
          'If an installed Recued window brings you back here, close every Recued window, then open it again.',
        ],
        retryError:
          'This tab still cannot read the newer saved data. Reload to get the latest Recued.',
      };
    case 'unavailable':
      return {
        kicker: 'Browser storage did not open',
        title: 'Try browser storage again',
        summary:
          'The browser could not open the small store Recued keeps here. This is often temporary.',
        steps: [
          'Close any other Recued tabs. Check that this is not a private window.',
          'Choose Check again. If it still fails, reload this tab, or check whether this address is allowed to save data.',
        ],
        retryError:
          'Browser storage still will not open. Follow the steps above, then check again.',
      };
  }
};

const STYLES = `
.persistent-storage-recovery {
  box-sizing: border-box;
  width: min(560px, calc(100vw - 32px));
  padding: 22px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  color: var(--fg);
  box-shadow: 0 16px 40px color-mix(in srgb, var(--fg) 10%, transparent);
  text-align: left;
}
.persistent-storage-recovery-kicker {
  margin: 0 0 5px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.persistent-storage-recovery h2 {
  margin: 0;
  color: var(--fg);
  font-size: 22px;
  line-height: 1.2;
}
.persistent-storage-recovery-summary,
.persistent-storage-recovery-why,
.persistent-storage-recovery-context {
  margin: 10px 0 0;
  color: var(--fg-muted);
  font-size: 13px;
  line-height: 1.55;
}
.persistent-storage-recovery-safe {
  margin: 16px 0;
  padding: 12px 13px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
  border-radius: 9px;
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
  font-size: 12.5px;
  line-height: 1.5;
}
.persistent-storage-recovery-safe strong {
  display: block;
  margin-bottom: 3px;
  color: var(--fg);
}
.persistent-storage-recovery-steps {
  margin: 0 0 18px;
  padding-left: 20px;
  color: var(--fg-muted);
  font-size: 12.5px;
  line-height: 1.5;
}
.persistent-storage-recovery-steps li + li { margin-top: 5px; }
.persistent-storage-recovery-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.persistent-storage-recovery button {
  min-height: 44px;
  border-radius: 8px;
  padding: 9px 14px;
  font: inherit;
  font-weight: 650;
  cursor: pointer;
}
.persistent-storage-recovery button:disabled {
  cursor: wait;
  opacity: .7;
}
.persistent-storage-recovery-primary {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: var(--accent-contrast, #fff);
}
.persistent-storage-recovery-secondary {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--fg-muted);
}
.persistent-storage-recovery button:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--accent) 38%, transparent);
  outline-offset: 2px;
}
.persistent-storage-recovery-status {
  margin: 14px 0 0;
  color: var(--fg-muted);
  font-size: 12.5px;
  line-height: 1.45;
}
.persistent-storage-recovery-status.is-error {
  color: var(--danger, #b42318);
}
@media (max-width: 360px) {
  .persistent-storage-recovery {
    width: calc(100vw - 20px);
    padding: 17px 15px;
  }
  .persistent-storage-recovery-actions {
    align-items: stretch;
    flex-direction: column;
  }
  .persistent-storage-recovery button { width: 100%; }
}
`;

type RecoveryPhase = 'idle' | 'busy' | 'error' | 'ready';

export interface MountedPersistentStorageRecoveryHost {
  readonly retry: () => Promise<void>;
  readonly recover: () => void;
  readonly showFailure: (failure: unknown) => void;
  readonly dispose: () => void;
}

export interface MountPersistentStorageRecoveryHostOptions {
  readonly failure: unknown;
  readonly onRetry: () => Promise<void>;
  readonly onRecovered?: () => void;
  readonly onReload?: () => void;
  /** This document follows the card's explicit full-page reload. The value is
   * held only in memory after a constant session marker is consumed. */
  readonly reloadAttempted?: boolean;
  readonly splashElement?: HTMLElement;
  readonly document?: Document;
}

const resolveDocument = (document?: Document): Document | undefined =>
  document ?? (globalThis as { document?: Document }).document;

const injectStyles = (document: Document): void => {
  if (document.head.querySelector(`[${PERSISTENT_STORAGE_STYLES_MARKER}]`)) {
    return;
  }
  const style = document.createElement('style');
  style.setAttribute(PERSISTENT_STORAGE_STYLES_MARKER, '');
  style.textContent = STYLES;
  document.head.appendChild(style);
};

/** Mount the reason-aware recovery card into the existing boot splash. */
export const mountPersistentStorageRecoveryHost = (
  options: MountPersistentStorageRecoveryHostOptions,
): MountedPersistentStorageRecoveryHost => {
  const document = resolveDocument(options.document);
  const splash = options.splashElement
    ?? document?.getElementById(BOOT_SPLASH_MESSAGE_ID)
    ?? null;
  if (document === undefined || splash === null) {
    throw new Error('persistent storage recovery requires the boot splash');
  }
  injectStyles(document);

  let failure = options.failure;
  let phase: RecoveryPhase = 'idle';
  let disposed = false;

  const render = (): void => {
    if (disposed) return;
    const failureKind = classifyPersistentStorageFailure(failure);
    const copy = recoveryCopy(failureKind);
    if (phase === 'ready') {
      splash.innerHTML = `
        <section class="persistent-storage-recovery" ${PERSISTENT_STORAGE_RECOVERY_ATTR} role="region" aria-labelledby="${PERSISTENT_STORAGE_TITLE_ID}">
          <p class="persistent-storage-recovery-kicker">Browser storage is ready</p>
          <h2 id="${PERSISTENT_STORAGE_TITLE_ID}">Starting Recued</h2>
          <p class="persistent-storage-recovery-summary">Browser storage opened successfully. Continuing from the page you opened…</p>
          <p class="persistent-storage-recovery-status" ${PERSISTENT_STORAGE_STATUS_ATTR} role="status" tabindex="-1">Storage available. Starting Recued…</p>
        </section>
      `;
      splash.querySelector<HTMLElement>(
        `[${PERSISTENT_STORAGE_STATUS_ATTR}]`,
      )?.focus();
      return;
    }

    const busy = phase === 'busy';
    const reloadIsPrimary = failureKind === 'outdated';
    const continuity = options.reloadAttempted
      ? `<p class="persistent-storage-recovery-context" id="${PERSISTENT_STORAGE_CONTEXT_ID}">This tab reloaded, but browser storage still did not open. The page you opened is still chosen, so you can keep trying here.</p>`
      : '';
    const actionDescriptionIds = options.reloadAttempted
      ? `${PERSISTENT_STORAGE_SAFETY_ID} ${PERSISTENT_STORAGE_CONTEXT_ID}`
      : PERSISTENT_STORAGE_SAFETY_ID;
    const status = busy
      ? `<p class="persistent-storage-recovery-status" ${PERSISTENT_STORAGE_STATUS_ATTR} role="status" tabindex="-1">Checking browser storage…</p>`
      : phase === 'error'
        ? `<p class="persistent-storage-recovery-status is-error" ${PERSISTENT_STORAGE_STATUS_ATTR} role="alert">${copy.retryError}</p>`
        : failureKind === 'blocked'
          ? `<p class="persistent-storage-recovery-status" ${PERSISTENT_STORAGE_STATUS_ATTR} role="status">Waiting for other Recued tabs or windows to release browser storage…</p>`
          : `<p class="persistent-storage-recovery-status" ${PERSISTENT_STORAGE_STATUS_ATTR} aria-live="polite"></p>`;
    const retryButton = `<button type="button" class="persistent-storage-recovery-${reloadIsPrimary ? 'secondary' : 'primary'}" ${PERSISTENT_STORAGE_RETRY_ATTR} aria-describedby="${actionDescriptionIds}" ${busy ? 'disabled' : ''}>${busy ? 'Checking…' : 'Check again'}</button>`;
    const reloadButton = `<button type="button" class="persistent-storage-recovery-${reloadIsPrimary ? 'primary' : 'secondary'}" ${PERSISTENT_STORAGE_RELOAD_ATTR} aria-describedby="${actionDescriptionIds}">Reload this tab</button>`;
    splash.innerHTML = `
      <section class="persistent-storage-recovery" ${PERSISTENT_STORAGE_RECOVERY_ATTR} role="region" aria-labelledby="${PERSISTENT_STORAGE_TITLE_ID}">
        <p class="persistent-storage-recovery-kicker">${copy.kicker}</p>
        <h2 id="${PERSISTENT_STORAGE_TITLE_ID}">${copy.title}</h2>
        <p class="persistent-storage-recovery-summary">${copy.summary}</p>
        <p class="persistent-storage-recovery-why">Recued uses browser storage for this browser’s encrypted sign-in and local settings.</p>
        ${continuity}
        <div class="persistent-storage-recovery-safe" id="${PERSISTENT_STORAGE_SAFETY_ID}">
          <strong>Your server data is safe.</strong>
          <span>Nothing on your server was cleared or changed. Retrying here keeps this tab on the page you opened.</span>
        </div>
        <ol class="persistent-storage-recovery-steps">
          <li>${copy.steps[0]}</li>
          <li>${copy.steps[1]}</li>
        </ol>
        <div class="persistent-storage-recovery-actions">
          ${reloadIsPrimary
            ? `${reloadButton}${retryButton}`
            : `${retryButton}${reloadButton}`}
        </div>
        ${status}
      </section>
    `;
    if (busy) {
      splash.querySelector<HTMLElement>(
        `[${PERSISTENT_STORAGE_STATUS_ATTR}]`,
      )?.focus();
    } else {
      splash.querySelector<HTMLElement>(
        `[${reloadIsPrimary
          ? PERSISTENT_STORAGE_RELOAD_ATTR
          : PERSISTENT_STORAGE_RETRY_ATTR}]`,
      )?.focus();
    }
  };

  const recover = (): void => {
    if (disposed || phase === 'ready') return;
    phase = 'ready';
    render();
    options.onRecovered?.();
  };

  const showFailure = (nextFailure: unknown): void => {
    if (disposed || phase === 'ready') return;
    failure = nextFailure;
    phase = 'error';
    render();
  };

  const retry = async (): Promise<void> => {
    if (disposed || phase === 'busy' || phase === 'ready') return;
    phase = 'busy';
    render();
    try {
      await options.onRetry();
      recover();
    } catch (error) {
      showFailure(error);
    }
  };

  const reload = (): void => {
    if (disposed || phase === 'ready') return;
    if (options.onReload !== undefined) {
      options.onReload();
      return;
    }
    (globalThis as { location?: { reload?: () => void } }).location?.reload?.();
  };

  const onClick = (event: Event): void => {
    const target = event.target as Element | null;
    if (target?.closest(`[${PERSISTENT_STORAGE_RETRY_ATTR}]`)) {
      event.preventDefault();
      void retry();
      return;
    }
    if (target?.closest(`[${PERSISTENT_STORAGE_RELOAD_ATTR}]`)) {
      event.preventDefault();
      reload();
    }
  };

  splash.addEventListener('click', onClick);
  render();
  return {
    retry,
    recover,
    showFailure,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      splash.removeEventListener('click', onClick);
      splash.innerHTML = '';
    },
  };
};

export interface OpenPersistentStorageWithRecoveryOptions<T> {
  readonly openStorage: () => Promise<T>;
  readonly onFailure?: (
    error: unknown,
    kind: PersistentStorageFailureKind,
  ) => void;
  readonly reload?: () => void;
  readonly reloadAttempted?: boolean;
  readonly splashElement?: HTMLElement;
  readonly document?: Document;
}

/** Attempt storage once, then wait behind a live recovery surface until an
 * in-place retry succeeds. A blocked platform request resumes automatically
 * when the older connection closes. The returned promise lets normal boot
 * continue without a reload or route mutation. */
export const openPersistentStorageWithRecovery = async <T>(
  options: OpenPersistentStorageWithRecoveryOptions<T>,
): Promise<T> => {
  const reportFailure = (error: unknown): void => {
    options.onFailure?.(error, classifyPersistentStorageFailure(error));
  };
  const attempt = async (): Promise<T> => {
    try {
      return await options.openStorage();
    } catch (error) {
      reportFailure(error);
      throw error;
    }
  };

  try {
    return await attempt();
  } catch (initialFailure) {
    return await new Promise<T>((resolve, reject) => {
      let opened: T | undefined;
      let blockedContinuation =
        initialFailure instanceof PersistentStorageStartupError
        && initialFailure.pendingOpen !== null
          ? initialFailure.pendingOpen as unknown as Promise<T>
          : null;
      try {
        const host = mountPersistentStorageRecoveryHost({
          failure: initialFailure,
          onRetry: async () => {
            const pending = blockedContinuation;
            blockedContinuation = null;
            if (pending === null) {
              opened = await attempt();
              return;
            }
            try {
              opened = await pending;
            } catch (error) {
              reportFailure(error);
              throw error;
            }
          },
          onRecovered: () => resolve(opened as T),
          ...(options.reload !== undefined ? { onReload: options.reload } : {}),
          ...(options.reloadAttempted !== undefined
            ? { reloadAttempted: options.reloadAttempted }
            : {}),
          ...(options.splashElement !== undefined
            ? { splashElement: options.splashElement }
            : {}),
          ...(options.document !== undefined
              ? { document: options.document }
              : {}),
        });
        const pending = blockedContinuation;
        if (pending !== null) {
          // Closing the older tab lets the original platform request finish.
          // Resume automatically even if the owner does not click Check again.
          void pending.then(
            (value) => {
              if (blockedContinuation !== pending) return;
              blockedContinuation = null;
              opened = value;
              host.recover();
            },
            (error: unknown) => {
              if (blockedContinuation !== pending) return;
              blockedContinuation = null;
              reportFailure(error);
              host.showFailure(error);
            },
          );
        }
      } catch (error) {
        reject(error);
      }
    });
  }
};
