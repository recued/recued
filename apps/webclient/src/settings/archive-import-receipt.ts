/** The tab saves an opaque import identifier before sending. It survives page
 * reload and server restart in sessionStorage, scoped to the selected address
 * and pinned server identity. No key, bearer, archive path or RPC args persist.
 * Status checks are read-only; neither reconnect nor a failed check retries an
 * import. Clear this browser already wipes this session storage. */
import type { ArchiveImportOperationStatus } from '@recued/contracts';
import type { WebclientLocalStore } from '../storage/local-store.js';
import type { ArchiveImportCaller } from './archive-backup-panel.js';
import { mountPostRestoreReadiness, type RestoreReadinessOptions } from './post-restore-readiness.js';

export type ArchiveImportReceiptState = ArchiveImportOperationStatus['status'] | 'checking' | 'unavailable';
export interface ArchiveImportReceiptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface ArchiveImportReceiptController {
  read(): ArchiveImportReceiptState | null;
  readonly reviewOnBoot: boolean;
  wrapImport(call: ArchiveImportCaller): ArchiveImportCaller;
  refresh(): void;
  dismiss(): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}
const PREFIX = 'recued.webclient.archive-import.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const STATUSES: ReadonlySet<string> = new Set<ArchiveImportOperationStatus['status']>([
  'unknown', 'preparing', 'waiting_for_restart', 'completed', 'not_applied', 'recovery_required',
]);
const terminal = (status: ArchiveImportReceiptState): boolean => status === 'completed' || status === 'not_applied';
const canDismiss = (status: ArchiveImportReceiptState | null): boolean =>
  status !== null && ['completed', 'not_applied', 'unknown', 'unavailable'].includes(status);
interface Saved { id: string; seen_terminal: boolean }

export const createArchiveImportReceiptController = (options: {
  scope: string;
  storage: ArchiveImportReceiptStorage | null;
  verify(id: string): Promise<ArchiveImportOperationStatus>;
  isConnected?: () => boolean;
  onConnected?: (listener: () => void) => () => void;
  newId?: () => string;
  autoCheck?: boolean;
  retryDelayMs?: number;
  isCurrentPair?: () => Promise<boolean>;
}): ArchiveImportReceiptController => {
  const key = PREFIX + options.scope, storage = options.storage;
  let disposed = false, generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let state: ArchiveImportReceiptState | null = null;
  let sending = false;
  let memoryAlias: { stored: string; actual: string } | null = null;
  const listeners = new Set<() => void>();
  const readSaved = (): Saved | null => {
    if (!storage) throw new Error('This browser could not save a restore check. No new restore was started.');
    const raw = storage.getItem(key);
    if (raw === null) return null;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error('The saved restore check could not be read.'); }
    if (!value || typeof value !== 'object') throw new Error('The saved restore check could not be read.');
    const saved = value as Partial<Saved>;
    if (typeof saved.id !== 'string' || !UUID.test(saved.id) || typeof saved.seen_terminal !== 'boolean') {
      throw new Error('The saved restore check could not be read.');
    }
    return { id: saved.id, seen_terminal: saved.seen_terminal };
  };
  const save = (saved: Saved): void => {
    if (!storage) throw new Error('This browser could not save a restore check. No new restore was started.');
    const value = JSON.stringify(saved); storage.setItem(key, value);
    if (storage.getItem(key) !== value) throw new Error('This browser could not save a restore check. No new restore was started.');
  };
  const emit = (next: ArchiveImportReceiptState | null): void => {
    if (disposed || next === state) return;
    state = next;
    for (const listener of listeners) { try { listener(); } catch { /* a view cannot change delivery or the server verdict */ } }
  };
  const cancel = (): void => { generation++; if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const effectiveId = (saved: Saved): string => memoryAlias?.stored === saved.id ? memoryAlias.actual : saved.id;
  let reviewOnBoot = false;
  try { const saved = readSaved(); reviewOnBoot = saved !== null && !saved.seen_terminal; state = saved ? 'checking' : null; }
  catch { state = 'unavailable'; }

  const check = async (attempt: number): Promise<void> => {
    if (disposed) return;
    cancel(); const ownGeneration = generation;
    let saved: Saved | null;
    try { saved = readSaved(); } catch { emit('unavailable'); return; }
    if (!saved) { emit(null); return; }
    const id = effectiveId(saved);
    emit('checking');
    let status: ArchiveImportReceiptState;
    try {
      if (options.isCurrentPair !== undefined) {
        const currentPair = await options.isCurrentPair();
        if (disposed || ownGeneration !== generation) return;
        if (!currentPair) { emit('unavailable'); return; }
      }
      if (options.isConnected?.() === false) throw new Error('offline');
      const result = await options.verify(id);
      if (disposed || ownGeneration !== generation) return;
      if (options.isCurrentPair !== undefined) {
        const currentPair = await options.isCurrentPair();
        if (disposed || ownGeneration !== generation) return;
        if (!currentPair) { emit('unavailable'); return; }
      }
      status = STATUSES.has(result?.status) ? result.status : 'unavailable';
    } catch { status = 'unavailable'; }
    if (disposed || ownGeneration !== generation) return;
    try {
      const current = readSaved();
      if (current?.id !== saved.id || effectiveId(current) !== id) return;
      if (terminal(status) && !current.seen_terminal) {
        try { save({ ...current, seen_terminal: true }); } catch { /* routing hints do not overrule an observed server verdict */ }
      }
    } catch { status = 'unavailable'; }
    emit(status);
    if (options.autoCheck !== false && !terminal(status) && status !== 'recovery_required' && attempt < 3) {
      timer = setTimeout(() => { void check(attempt + 1); }, options.retryDelayMs ?? 2500);
    }
  };
  const refresh = (): void => { void check(1); };
  const detach = options.autoCheck === false ? undefined : options.onConnected?.(refresh);
  const controller: ArchiveImportReceiptController = {
    read: () => state,
    reviewOnBoot,
    wrapImport: call => async input => {
      if (input.dry_run === true) return call(input);
      if (disposed) throw new Error('This restore check is closed. Reload before trying again.');
      if (sending) throw new Error('A backup restore is already waiting for a reply.');
      sending = true;
      try {
        if (options.isCurrentPair !== undefined && !await options.isCurrentPair()) {
          throw new Error('The selected server changed. Reopen Backup & Recovery before trying again.');
        }
        if (disposed) throw new Error('This restore check is closed. Reload before trying again.');
        // This runs only behind a new owner confirmation. A known pending or
        // unsettled server operation must not be replaced by a fresh import.
        const previous = readSaved();
        if (previous) {
          const prior = await options.verify(effectiveId(previous));
          if (!STATUSES.has(prior?.status) || ['preparing', 'waiting_for_restart', 'recovery_required'].includes(prior.status)) {
            throw new Error('A backup restore is still being checked. Check its status before starting another.');
          }
        }
        if (options.isCurrentPair !== undefined && !await options.isCurrentPair()) {
          throw new Error('The selected server changed. Reopen Backup & Recovery before trying again.');
        }
        if (disposed) throw new Error('This restore check is closed. Reload before trying again.');
        cancel(); memoryAlias = null;
        const id = options.newId?.() ?? globalThis.crypto.randomUUID();
        if (!UUID.test(id)) throw new Error('This browser could not create a restore check. No restore was started.');
        save({ id, seen_terminal: false }); emit('preparing');
        try {
          const result = await call({ ...input, operation_id: id });
          try {
            const responseId = typeof result.operation_id === 'string' ? result.operation_id.toLowerCase() : undefined;
            if (responseId !== undefined && UUID.test(responseId)) {
              const current = readSaved();
              if (current?.id === id && responseId !== id) {
                try { save({ id: responseId, seen_terminal: false }); }
                catch { memoryAlias = { stored: id, actual: responseId }; }
              }
            }
            const current = readSaved();
            if (current?.id === id || current?.id === responseId) emit('waiting_for_restart');
          } catch { emit('unavailable'); }
          return result;
        } finally {
          if (!disposed && options.autoCheck !== false) refresh();
        }
      } finally { sending = false; }
    },
    refresh,
    dismiss() {
      cancel();
      try { storage?.removeItem(key); memoryAlias = null; emit(null); }
      catch { emit('unavailable'); }
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { disposed = true; cancel(); detach?.(); listeners.clear(); },
  };
  if (state !== null && options.autoCheck !== false) refresh();
  return controller;
};

interface BrowserReceiptStorageOptions {
  localStore: WebclientLocalStore;
  storage?: ArchiveImportReceiptStorage | null;
}
interface BrowserReceiptPorts {
  verify(id: string): Promise<ArchiveImportOperationStatus>;
  isConnected?: () => boolean;
  onConnected?: (listener: () => void) => () => void;
  autoCheck?: boolean;
}
/** Prepare storage before the app arms its initial connection grace timer.
 * Bind RPC/status ports synchronously once those services exist. */
export const prepareBrowserArchiveImportReceipt = async (
  options: BrowserReceiptStorageOptions,
): Promise<(ports: BrowserReceiptPorts) => ArchiveImportReceiptController | null> => {
  try {
    const [address, identity] = await Promise.all([options.localStore.get('server_url'), options.localStore.get('server_public_key')]);
    if (!address || !identity) throw new Error('The restore check needs the paired server address and identity.');
    const url = new URL(address.trim());
    if (url.protocol === 'ws:') url.protocol = 'http:';
    if (url.protocol === 'wss:') url.protocol = 'https:';
    url.pathname = url.pathname.replace(/\/ws\/?$/u, '').replace(/\/+$/u, '');
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([url.toString(), identity])));
    const scope = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    let storage = options.storage;
    if (storage === undefined) {
      try { storage = (globalThis as { sessionStorage?: ArchiveImportReceiptStorage }).sessionStorage; } catch { storage = null; }
      if (storage === undefined && typeof (globalThis as { window?: unknown }).window === 'undefined') {
        const values = new Map<string, string>();
        storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
      }
    }
    return ports => createArchiveImportReceiptController({ ...ports, scope, storage: storage ?? null,
      isCurrentPair: async () => (await options.localStore.get('server_url')) === address
        && (await options.localStore.get('server_public_key')) === identity,
    });
  } catch {
    // Receipt setup must not break unrelated app routes. Refuse a committing
    // import if the browser cannot establish and persist its pair binding.
    return ports => createArchiveImportReceiptController({ ...ports, scope: 'unavailable', storage: null });
  }
};

/** Production pair binding. Windowless tests use a private memory port; an
 * actual browser that cannot persist the check refuses a new destructive send. */
export const createBrowserArchiveImportReceiptController = async (
  options: BrowserReceiptStorageOptions & BrowserReceiptPorts,
): Promise<ArchiveImportReceiptController | null> =>
  (await prepareBrowserArchiveImportReceipt(options))(options);

/** Updates only this status block, never the adjacent key/file form. */
export const mountArchiveImportReceipt = (options: {
  host: HTMLElement;
  document: Document;
  controller: ArchiveImportReceiptController;
  readiness?: RestoreReadinessOptions;
  onDismissFocus?: () => void;
}): (() => void) => {
  const { host, document: doc, controller } = options;
  const heading = doc.createElement('h3'); heading.textContent = 'Last restore check'; host.appendChild(heading);
  const status = doc.createElement('p'); status.setAttribute('role', 'status'); host.appendChild(status);
  const check = doc.createElement('button'); check.type = 'button'; check.className = 'rx-btn rx-btn-secondary';
  check.textContent = 'Check again'; check.setAttribute('data-archive-import-check', '');
  check.addEventListener('click', () => { if (controller.read() !== 'checking') controller.refresh(); }); host.appendChild(check);
  const clear = doc.createElement('button'); clear.type = 'button'; clear.className = 'rx-btn rx-btn-secondary';
  clear.textContent = 'Clear this saved check'; clear.setAttribute('data-archive-import-dismiss', '');
  clear.addEventListener('click', () => {
    if (!canDismiss(controller.read())) return;
    const focused = doc.activeElement === clear; controller.dismiss();
    if (focused && controller.read() === null) options.onDismissFocus?.();
  }); host.appendChild(clear);
  const note = doc.createElement('p'); note.textContent = 'Clearing this check does not stop or undo a restore.'; host.appendChild(note);
  const copy: Record<ArchiveImportReceiptState, string> = {
    checking: 'Checking whether your backup was put back…',
    preparing: 'The server is preparing your backup. It has not confirmed a completed restore.',
    waiting_for_restart: 'The server accepted your backup. Waiting for its restore result after restart.',
    completed: 'Your backup was put back. The server confirmed this restore after reconnecting.',
    not_applied: 'Your backup was not put back. The server kept its previous database.',
    recovery_required: 'This restore needs recovery. Do not import another backup yet. Restart the server so it can finish recovery, then check again.',
    unknown: 'This server has no result for this restore. Check your data before starting another restore.',
    unavailable: 'Recued could not check this restore. Reconnect or pair with this server, then check again.',
  };
  const render = (): void => {
    const value = controller.read();
    if (value === null) { host.setAttribute('hidden', ''); return; }
    host.removeAttribute('hidden'); status.textContent = copy[value]; status.setAttribute('data-archive-import-status', value);
    check.setAttribute('aria-disabled', String(value === 'checking'));
    const canClear = canDismiss(value);
    clear.setAttribute('aria-disabled', String(!canClear));
    // A reconnect check may temporarily disable clearing. Keep its focused
    // control in place until the owner moves focus or the check settles.
    if (canClear || doc.activeElement === clear) { clear.removeAttribute('hidden'); note.removeAttribute('hidden'); }
    else { clear.setAttribute('hidden', ''); note.setAttribute('hidden', ''); }
  };
  const readinessHost = doc.createElement('section'); host.appendChild(readinessHost);
  const detachReadiness = options.readiness ? mountPostRestoreReadiness({ ...options.readiness,
    host: readinessHost, document: doc, receipt: controller }) : () => undefined;
  const detach = controller.subscribe(render); render(); return () => { detachReadiness(); detach(); };
};
