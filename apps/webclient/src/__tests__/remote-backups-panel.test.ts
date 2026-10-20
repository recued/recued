import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveRemoteBackup, ArchiveRemoteDestination } from '@recued/contracts';
import { mountRemoteBackups, type RemoteBackupsPorts } from '../settings/remote-backups-panel.js';
import { PickerElement } from './helpers/file-download-picker-dom.js';

const destination: ArchiveRemoteDestination = { connection_name: 'safe', destination_id: 'a'.repeat(64), bucket: 'backup-bucket', region: 'us-east-1', endpoint: 'https://s3.example.test', prefix: '' };
const receipt: ArchiveRemoteBackup = { operation_id: '12345678-1234-4234-8234-123456789abc', job_id: 'job-1', destination, object_key: 'recued-backups/example/archive', created_at: 1_700_000_000_000, state: 'verified', keep_last: 5, bytes: 8000, sha256: 'b'.repeat(64), verified_at: 1_700_000_000_001 };
const stage = `recued-upload-${'a'.repeat(32)}.recued.archive`;
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); vi.useRealTimers(); });
const setup = async (overrides: Partial<RemoteBackupsPorts> = {}) => {
  // Match native node movement and document focus, which the small picker
  // fixture does not otherwise need to model.
  let focused: PickerElement | null = null;
  class Element extends PickerElement {
    parent: Element | undefined;
    override appendChild(child: Element): Element { child.parent?.removeChild(child); super.appendChild(child); child.parent = this; return child; }
    override removeChild(child: Element): Element { super.removeChild(child); child.parent = undefined; return child; }
    override focus(): void { focused = this; }
  }
  const host = new Element();
  const document = { createElement: () => new Element(), get activeElement() { return focused; } } as unknown as Document;
  const onRestore = vi.fn(() => true), retrieve = vi.fn(async () => ({ staged_name: stage }));
  const ports: RemoteBackupsPorts = { destinations: async () => ({ destinations: [destination] }), list: async () => ({ backups: [receipt] }), check: async () => ({ ...receipt, state: 'verifying' }), retrieve, ...overrides };
  const mounted = mountRemoteBackups({ host: host as unknown as HTMLElement, document, ports, onRestore }); disposals.push(() => mounted.dispose());
  const node = (attr: string) => { const value = host.querySelector(`[${attr}]`); if (!value) throw new Error(`Missing ${attr}`); return value; };
  await vi.waitFor(() => expect(host.querySelector('[data-remote-backup-check]')).not.toBeNull());
  return { host, document, node, mounted, onRestore, retrieve };
};

describe('remote backup selection and restore continuity', () => {
  it('observes retention finishing after the replacement is already verified', async () => {
    vi.useFakeTimers();
    let backups: ArchiveRemoteBackup[] = [receipt, { ...receipt, operation_id: '22345678-1234-4234-8234-123456789abc', state: 'pruning' }];
    const list = vi.fn(async () => ({ backups }));
    const h = await setup({ list });
    expect(list).toHaveBeenCalledTimes(1);
    backups = [receipt, { ...backups[1]!, state: 'pruned' }];
    await vi.advanceTimersByTimeAsync(5000);
    expect(list).toHaveBeenCalledTimes(2);
    expect(h.host.querySelector('[data-remote-backup-state="pruned"]')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(15000);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('binds the displayed destination, refuses a changed choice, and keeps local export explicit', async () => {
    let choices = [destination];
    const h = await setup({ destinations: async () => ({ destinations: choices }) }); await h.mounted.refresh();
    expect(h.mounted.target()).toBeUndefined();
    const select = h.node('data-remote-backup-destination'); select.value = 'safe'; select.fire('change');
    expect(h.mounted.target()).toMatchObject({ connection_name: 'safe', destination_id: destination.destination_id, keep_last: 5 });
    const options = [...select.children]; await h.mounted.refresh(); expect(select.children).toEqual(options);
    choices = [{ ...destination, destination_id: 'c'.repeat(64), bucket: 'changed-bucket' }]; await h.mounted.refresh();
    expect(select.value).toBe('stale:safe'); expect(() => h.mounted.target()).toThrow('select the destination again');
    select.value = 'safe'; select.fire('change'); expect(h.mounted.target()?.destination_id).toBe('c'.repeat(64));
    h.node('data-remote-backup-keep').value = '0'; expect(() => h.mounted.target()).toThrow('1 and 30');
    select.value = ''; select.fire('change'); expect(h.mounted.target()).toBeUndefined();
  });

  it('keeps a focused history control attached when receipts refresh', async () => {
    let backups = [receipt]; const h = await setup({ list: async () => ({ backups }) }); await h.mounted.refresh();
    const button = h.node('data-remote-backup-check'); button.focus();
    backups = [{ ...receipt, operation_id: '22345678-1234-4234-8234-123456789abc' }, { ...receipt, retention_pending: true }];
    await h.mounted.refresh(); expect(h.node('data-remote-backup-check')).toBe(button); expect(h.document.activeElement).toBe(button);
    backups = []; await h.mounted.refresh(); expect(h.document.activeElement).toBe(h.node('data-remote-backups-refresh'));
  });

  it('requires a separate owner action after retrieval before opening the key form', async () => {
    let settle: (value: { staged_name: string }) => void = () => {};
    const h = await setup({ retrieve: () => new Promise(resolve => { settle = resolve; }) }); await h.mounted.refresh();
    const button = h.node('data-remote-backup-restore'); button.focus(); button.click();
    expect(button.getAttribute('aria-disabled')).toBe('true'); expect(h.onRestore).not.toHaveBeenCalled();
    settle({ staged_name: stage }); await vi.waitFor(() => expect(button.textContent).toBe('Open restore preview'));
    expect(h.onRestore).not.toHaveBeenCalled(); expect(h.document.activeElement).toBe(button);
    button.click(); expect(h.onRestore).toHaveBeenCalledExactlyOnceWith(stage);
  });

  it('does not navigate on a late retrieval after route disposal or on a malformed staged name', async () => {
    let settle: (value: { staged_name: string }) => void = () => {};
    const h = await setup({ retrieve: () => new Promise(resolve => { settle = resolve; }) }); await h.mounted.refresh();
    h.node('data-remote-backup-restore').click(); h.mounted.dispose(); settle({ staged_name: stage }); await Promise.resolve(); await Promise.resolve();
    expect(h.onRestore).not.toHaveBeenCalled();
    const invalid = await setup({ retrieve: async () => ({ staged_name: '../../other-file' }) }); await invalid.mounted.refresh();
    invalid.node('data-remote-backup-restore').click(); await vi.waitFor(() => expect(invalid.host.textContent).toContain('No restore was started'));
    expect(invalid.onRestore).not.toHaveBeenCalled();
  });
});
