import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveImportCaller } from './archive-backup-panel.js';
import { createArchiveImportReceiptController, createBrowserArchiveImportReceiptController } from './archive-import-receipt.js';
import { createInMemoryWebclientLocalStore } from '../storage/local-store.js';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const INPUT = { path: 'fixture.recued.archive', recoveryKey: 'synthetic key never saved', dry_run: false };
const RESULT: Awaited<ReturnType<ArchiveImportCaller>> = {
  manifest: { format_version: 1, schema_version: 1, exported_at: '2026-10-19T00:00:00Z',
    record_count: 1, tables: { fixture: 1 }, includes_blobs: true, includes_passport: false },
  restored_at: 100, realm: 'same',
};
const memory = () => {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
};
afterEach(() => { vi.useRealTimers(); });

describe('archive import receipt continuity', () => {
  it('persists an opaque identity before sending and never stores the path or key', async () => {
    const storage = memory();
    const tracker = createArchiveImportReceiptController({ scope: 'server', storage, newId: () => ID,
      verify: async () => ({ status: 'unknown' }), autoCheck: false });
    const call = vi.fn<ArchiveImportCaller>(async input => {
      expect([...storage.values.values()]).toEqual([JSON.stringify({ id: ID, seen_terminal: false })]);
      expect(input.operation_id).toBe(ID); return RESULT;
    });
    await tracker.wrapImport(call)(INPUT);
    expect(call).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([...storage.values])).not.toContain(INPUT.path);
    expect(JSON.stringify([...storage.values])).not.toContain(INPUT.recoveryKey);
    expect(tracker.read()).toBe('waiting_for_restart'); tracker.dispose();
  });

  it('previews do not reserve an identifier or change a saved receipt', async () => {
    const storage = memory(), call = vi.fn<ArchiveImportCaller>(async () => RESULT);
    const tracker = createArchiveImportReceiptController({ scope: 'server', storage, autoCheck: false,
      verify: async () => ({ status: 'unknown' }) });
    await tracker.wrapImport(call)({ ...INPUT, dry_run: true });
    expect(storage.values.size).toBe(0); expect(call).toHaveBeenCalledWith({ ...INPUT, dry_run: true });
    tracker.dispose();
  });

  it('refuses a destructive send when its identity cannot be persisted', async () => {
    const storage = memory(); storage.setItem = () => { throw new Error('storage unavailable'); };
    const call = vi.fn<ArchiveImportCaller>();
    const tracker = createArchiveImportReceiptController({ scope: 'server', storage, newId: () => ID,
      verify: async () => ({ status: 'unknown' }), autoCheck: false });
    await expect(tracker.wrapImport(call)(INPUT)).rejects.toThrow();
    expect(call).not.toHaveBeenCalled(); tracker.dispose();
  });

  it('resolves a lost reply after reload using only the exact saved receipt', async () => {
    const storage = memory(), original = vi.fn<ArchiveImportCaller>(async () => { throw new Error('lost reply'); });
    const first = createArchiveImportReceiptController({ scope: 'server', storage, newId: () => ID,
      verify: async () => ({ status: 'unknown' }), autoCheck: false });
    await expect(first.wrapImport(original)(INPUT)).rejects.toThrow('lost reply'); first.dispose();
    const verify = vi.fn(async () => ({ status: 'completed' as const }));
    const second = createArchiveImportReceiptController({ scope: 'server', storage, verify });
    expect(second.reviewOnBoot).toBe(true);
    await vi.waitFor(() => expect(second.read()).toBe('completed'));
    expect(verify).toHaveBeenCalledWith(ID); expect(original).toHaveBeenCalledTimes(1); second.dispose();
    const third = createArchiveImportReceiptController({ scope: 'server', storage, verify, autoCheck: false });
    expect(third.reviewOnBoot).toBe(false); expect(third.read()).toBe('checking'); third.dispose();
  });

  it('cannot turn a connected socket or a failed status read into completion', async () => {
    vi.useFakeTimers(); const storage = memory();
    const call = vi.fn<ArchiveImportCaller>(async () => RESULT), verify = vi.fn(async () => { throw new Error('temporary failure'); });
    const tracker = createArchiveImportReceiptController({ scope: 'server', storage, newId: () => ID, verify,
      isConnected: () => true, retryDelayMs: 10 });
    await tracker.wrapImport(call)(INPUT);
    await vi.advanceTimersByTimeAsync(100);
    expect(tracker.read()).toBe('unavailable'); expect(verify).toHaveBeenCalledTimes(3);
    expect(call).toHaveBeenCalledTimes(1); expect(storage.values.size).toBe(1); tracker.dispose();
  });

  it.each(['preparing', 'waiting_for_restart', 'recovery_required'] as const)('requires the pending %s operation to settle before another import', async status => {
    const storage = memory();
    const tracker = createArchiveImportReceiptController({ scope: 'server', storage, newId: () => ID,
      verify: async () => ({ status }), autoCheck: false });
    const call = vi.fn<ArchiveImportCaller>(async () => RESULT);
    await tracker.wrapImport(call)(INPUT);
    await expect(tracker.wrapImport(call)(INPUT)).rejects.toThrow('still being checked');
    expect(call).toHaveBeenCalledTimes(1); tracker.dispose();
  });

  it('uses the response identity when a compatible server assigns another identifier', async () => {
    const storage = memory(), verify = vi.fn(async () => ({ status: 'not_applied' as const }));
    const tracker = createArchiveImportReceiptController({ scope: 'server', storage, newId: () => ID, verify, autoCheck: false });
    await tracker.wrapImport(async () => ({ ...RESULT, operation_id: OTHER }))(INPUT);
    tracker.refresh(); await vi.waitFor(() => expect(tracker.read()).toBe('not_applied'));
    expect(verify).toHaveBeenCalledWith(OTHER); tracker.dispose();
  });

  it('keeps an accepted response authoritative even if storage fails after the send', async () => {
    const storage = memory();
    const tracker = createArchiveImportReceiptController({ scope: 'server', storage, newId: () => ID,
      verify: async () => ({ status: 'completed' }), autoCheck: false });
    const result = await tracker.wrapImport(async () => {
      storage.getItem = () => { throw new Error('storage failed after acceptance'); };
      return { ...RESULT, operation_id: ID };
    })(INPUT);
    expect(result.operation_id).toBe(ID); expect(tracker.read()).toBe('unavailable'); tracker.dispose();
  });

  it('drops stale lookup responses after an explicit clear and a new import', async () => {
    const storage = memory(); let resolve!: (result: { status: 'completed' }) => void, nextId = ID;
    const tracker = createArchiveImportReceiptController({ scope: 'server', storage, newId: () => nextId,
      verify: () => new Promise(r => { resolve = r; }), autoCheck: false });
    await tracker.wrapImport(async () => RESULT)(INPUT); tracker.refresh();
    tracker.dismiss(); nextId = OTHER;
    await tracker.wrapImport(async () => RESULT)(INPUT); resolve({ status: 'completed' });
    await Promise.resolve(); await Promise.resolve();
    expect(tracker.read()).toBe('waiting_for_restart');
    expect([...storage.values.values()][0]).toContain(OTHER); tracker.dispose();
  });

  it('does not dispatch when its controller closes while checking an older receipt', async () => {
    const storage = memory(); let resolve!: (result: { status: 'completed' }) => void;
    const tracker = createArchiveImportReceiptController({ scope: 'server', storage, newId: () => ID,
      verify: () => new Promise(r => { resolve = r; }), autoCheck: false });
    const call = vi.fn<ArchiveImportCaller>(async () => RESULT);
    await tracker.wrapImport(call)(INPUT);
    const pending = tracker.wrapImport(call)(INPUT); tracker.dispose(); resolve({ status: 'completed' });
    await expect(pending).rejects.toThrow('closed'); expect(call).toHaveBeenCalledTimes(1);
  });

  it('binds saved checks to both the address and pinned identity', async () => {
    const storage = memory(), localStore = createInMemoryWebclientLocalStore();
    await localStore.ensureProfile('ws://first.fixture.test/ws'); await localStore.set('server_public_key', 'first-public-key');
    const first = await createBrowserArchiveImportReceiptController({ localStore, storage,
      verify: async () => ({ status: 'unknown' }), autoCheck: false });
    await first!.wrapImport(async () => RESULT)(INPUT); first!.dispose();
    await localStore.set('server_public_key', 'other-public-key');
    const other = await createBrowserArchiveImportReceiptController({ localStore, storage,
      verify: async () => ({ status: 'completed' }), autoCheck: false });
    expect(other!.read()).toBeNull(); other!.dispose();
    await localStore.set('server_public_key', 'first-public-key');
    const again = await createBrowserArchiveImportReceiptController({ localStore, storage,
      verify: async () => ({ status: 'completed' }), autoCheck: false });
    expect(again!.reviewOnBoot).toBe(true); again!.dispose();
  });

  it('refuses to send if the selected server changes after opening Backup', async () => {
    const storage = memory(), localStore = createInMemoryWebclientLocalStore();
    await localStore.ensureProfile('ws://first.fixture.test/ws'); await localStore.set('server_public_key', 'first-key');
    const tracker = await createBrowserArchiveImportReceiptController({ localStore, storage, autoCheck: false,
      verify: async () => ({ status: 'unknown' }) });
    await localStore.ensureProfile('ws://second.fixture.test/ws');
    const call = vi.fn<ArchiveImportCaller>();
    await expect(tracker!.wrapImport(call)(INPUT)).rejects.toThrow('selected server changed');
    expect(call).not.toHaveBeenCalled(); expect(storage.values.size).toBe(0); tracker!.dispose();
  });

  it('keeps app setup usable but blocks restore when its scope cannot be established', async () => {
    const localStore = createInMemoryWebclientLocalStore();
    await localStore.ensureProfile('ws://fixture.test/ws'); await localStore.set('server_public_key', 'key');
    const read = vi.spyOn(localStore, 'get').mockRejectedValue(new Error('browser store blocked'));
    const tracker = await createBrowserArchiveImportReceiptController({ localStore, autoCheck: false,
      verify: async () => ({ status: 'unknown' }) });
    const call = vi.fn<ArchiveImportCaller>();
    expect(tracker!.read()).toBe('unavailable');
    await expect(tracker!.wrapImport(call)(INPUT)).rejects.toThrow('could not save');
    expect(call).not.toHaveBeenCalled(); tracker!.dispose(); read.mockRestore();
  });

  it.each(['server_url', 'server_public_key'] as const)('blocks committing imports when %s is missing', async missing => {
    const localStore = createInMemoryWebclientLocalStore();
    await localStore.ensureProfile('ws://fixture.test/ws'); await localStore.set('server_public_key', 'key');
    const get = localStore.get.bind(localStore);
    vi.spyOn(localStore, 'get').mockImplementation(key => key === missing ? Promise.resolve(null) : get(key));
    const tracker = await createBrowserArchiveImportReceiptController({ localStore, storage: memory(), autoCheck: false,
      verify: async () => ({ status: 'unknown' }) });
    const call = vi.fn<ArchiveImportCaller>(async () => RESULT);
    // Match both production callers, including their optional feature fallback.
    const importArchive = tracker?.wrapImport(call) ?? call;
    await expect(importArchive(INPUT)).rejects.toThrow('could not save');
    expect(call).not.toHaveBeenCalled(); tracker?.dispose();
  });

  it('does not look up a saved receipt after the selected server changes', async () => {
    const storage = memory(); let currentPair = true;
    const verify = vi.fn(async () => ({ status: 'completed' as const }));
    const tracker = createArchiveImportReceiptController({ scope: 'server', storage, newId: () => ID, verify,
      isCurrentPair: async () => currentPair, autoCheck: false });
    await tracker.wrapImport(async () => RESULT)(INPUT);
    currentPair = false; tracker.refresh();
    await vi.waitFor(() => expect(tracker.read()).toBe('unavailable'));
    expect(verify).not.toHaveBeenCalled(); tracker.dispose();
  });

  it('does not look up an older receipt through another selected server before a new confirmation', async () => {
    const storage = memory(); let currentPair = true;
    const verify = vi.fn(async () => ({ status: 'completed' as const }));
    const tracker = createArchiveImportReceiptController({ scope: 'server', storage, newId: () => ID, verify,
      isCurrentPair: async () => currentPair, autoCheck: false });
    const call = vi.fn<ArchiveImportCaller>(async () => RESULT);
    await tracker.wrapImport(call)(INPUT); currentPair = false;
    await expect(tracker.wrapImport(call)(INPUT)).rejects.toThrow('selected server changed');
    expect(verify).not.toHaveBeenCalled(); expect(call).toHaveBeenCalledTimes(1); tracker.dispose();
  });

  it('does not accept a terminal lookup that arrives after the selected server changes', async () => {
    const storage = memory(); let currentPair = true;
    let resolve!: (result: { status: 'completed' }) => void;
    const verify = vi.fn(() => new Promise<{ status: 'completed' }>(r => { resolve = r; }));
    const tracker = createArchiveImportReceiptController({ scope: 'server', storage, newId: () => ID, verify,
      isCurrentPair: async () => currentPair, autoCheck: false });
    await tracker.wrapImport(async () => RESULT)(INPUT); tracker.refresh();
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
    currentPair = false; resolve({ status: 'completed' });
    await vi.waitFor(() => expect(tracker.read()).toBe('unavailable')); tracker.dispose();
    const reloaded = createArchiveImportReceiptController({ scope: 'server', storage, verify, autoCheck: false });
    expect(reloaded.reviewOnBoot).toBe(true); reloaded.dispose();
  });
});
