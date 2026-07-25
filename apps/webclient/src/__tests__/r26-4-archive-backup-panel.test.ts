/** R26.4 Delta 2b — Settings ▸ Backup & Recovery: full-data backup & restore.
 *
 *  Drives the `server.archive.*` flows over injected caller seams + a no-op
 *  poll scheduler (the loop is stepped manually with `tickPoll()`). Covers the
 *  async export → poll → path-shown path, the client-side BIP39 guard, the
 *  two-step destructive restore (dry-run preview → two-tap confirm → commit),
 *  wrong-key surfacing, and — critically — that the server-restart WS drop on a
 *  committing import is treated as "restarting; reconnecting…", never an error.
 *
 *  Fake DOM mirrors the Delta-1 recovery-panel test (`createElement` element
 *  tree + per-element listeners) with a `checked` field for the two checkboxes. */

import { afterEach, describe, expect, it } from 'vitest';
import { generateRecoveryKey } from '@recued/crypto';
import type {
  ArchiveImportRebind,
  ArchiveJobStatus,
  ArchiveManifest,
  ArchiveRealmRelation,
} from '@recued/contracts';

import {
  ARCHIVE_BACKUP_PANEL_ATTR,
  ARCHIVE_BACKUP_VIEW_ATTR,
  ARCHIVE_BACKUP_START_BTN_ATTR,
  ARCHIVE_RESTORE_START_BTN_ATTR,
  ARCHIVE_BACKUP_MNEMONIC_ATTR,
  ARCHIVE_BACKUP_BLOBS_ATTR,
  ARCHIVE_BACKUP_PASSPORT_ATTR,
  ARCHIVE_BACKUP_RUN_BTN_ATTR,
  ARCHIVE_BACKUP_PROGRESS_ATTR,
  ARCHIVE_BACKUP_PATH_OUT_ATTR,
  ARCHIVE_RESTORE_MANIFEST_ATTR,
  ARCHIVE_RESTORE_REALM_KEY_ATTR,
  ARCHIVE_RESTORE_ARM_ATTR,
  ARCHIVE_RESTORE_COMMIT_BTN_ATTR,
  ARCHIVE_RESTORE_SCHEMA_WARN_ATTR,
  ARCHIVE_PASSPORT_START_BTN_ATTR,
  ARCHIVE_PASSPORT_JSON_ATTR,
  ARCHIVE_PASSPORT_DOWNLOAD_BTN_ATTR,
  ARCHIVE_BACKUP_DOWNLOAD_BTN_ATTR,
  ARCHIVE_BACKUP_CANCEL_BTN_ATTR,
  ARCHIVE_RESTORE_UPLOAD_INPUT_ATTR,
  ARCHIVE_RESTORE_UPLOAD_PROGRESS_ATTR,
  ARCHIVE_BACKUP_RESULT_ATTR,
  mountArchiveBackupPanel,
  type ArchiveExportCaller,
  type ArchiveImportCaller,
  type ArchivePassportExportCaller,
  type ArchivePassportDownloadFn,
  type ArchiveDownloadFn,
  type ArchiveUploadFn,
  type ArchiveUploadFile,
  type ArchivePollScheduler,
  type ArchiveRebindStashFn,
  type ArchiveStatusCaller,
} from '../settings/archive-backup-panel.js';

// ──────────────────────────────────────────────────────────────────
// Fake DOM (recovery-panel test shape + `checked`)
// ──────────────────────────────────────────────────────────────────

interface FakeElement {
  tagName: string;
  textContent: string;
  value: string;
  placeholder: string;
  className: string;
  checked: boolean;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeElement): FakeElement;
  removeChild(el: FakeElement): FakeElement;
  readonly firstChild: FakeElement | null;
  remove(): void;
  addEventListener(name: string, fn: (ev: unknown) => void): void;
  removeEventListener(name: string, fn: (ev: unknown) => void): void;
  click(): void;
  type: string;
}

const makeFakeElement = (tagName: string): FakeElement => {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const attrs = new Map<string, string>();
  const children: FakeElement[] = [];
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    value: '',
    placeholder: '',
    className: '',
    checked: false,
    type: '',
    children,
    parent: null,
    attrs,
    listeners,
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
    getAttribute: (k) => attrs.get(k) ?? null,
    hasAttribute: (k) => attrs.has(k),
    appendChild: (next) => {
      children.push(next);
      next.parent = el;
      return next;
    },
    removeChild: (target) => {
      const idx = children.indexOf(target);
      if (idx < 0) throw new Error('removeChild: not a child');
      children.splice(idx, 1);
      target.parent = null;
      return target;
    },
    get firstChild() {
      return children[0] ?? null;
    },
    remove: () => {
      if (el.parent) el.parent.removeChild(el);
    },
    addEventListener: (name, fn) => {
      const arr = listeners.get(name) ?? [];
      arr.push(fn);
      listeners.set(name, arr);
    },
    removeEventListener: (name, fn) => {
      const arr = listeners.get(name);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    click: () => {
      for (const fn of listeners.get('click') ?? []) fn({ target: el });
    },
  };
  return el;
};

const makeFakeDocument = () => ({
  createElement: (tag: string) => makeFakeElement(tag),
});

const findByAttr = (root: FakeElement, attr: string): FakeElement | null => {
  if (root.hasAttribute(attr)) return root;
  for (const c of root.children) {
    const hit = findByAttr(c, attr);
    if (hit) return hit;
  }
  return null;
};

const textOf = (root: FakeElement): string => {
  let out = root.textContent ?? '';
  for (const c of root.children) out += textOf(c);
  return out;
};

// ──────────────────────────────────────────────────────────────────
// Setup
// ──────────────────────────────────────────────────────────────────

const KNOWN = generateRecoveryKey().mnemonic;
const DONE_PATH = '/data/exports/recued-2026-06-25.recued.archive';

const noopScheduler: ArchivePollScheduler = {
  schedule: () => () => {},
};

interface SetupOptions {
  runExport?: ArchiveExportCaller;
  runStatus?: ArchiveStatusCaller;
  runImport?: ArchiveImportCaller;
  runPassportExport?: ArchivePassportExportCaller;
  passportDownload?: ArchivePassportDownloadFn;
  archiveDownload?: ArchiveDownloadFn;
  archiveUpload?: ArchiveUploadFn;
  stashRebind?: ArchiveRebindStashFn;
  scheduler?: ArchivePollScheduler;
}

const setupMount = (overrides: SetupOptions = {}) => {
  const host = makeFakeElement('div');
  const doc = makeFakeDocument();
  const exportLog: Array<{
    include_blobs?: boolean;
    include_passport?: boolean;
    recoveryKey: string;
  }> = [];
  const importLog: Array<{
    path: string;
    recoveryKey: string;
    currentRealmKey?: string;
    dry_run?: boolean;
  }> = [];
  const passportLog: Array<{ profile: string }> = [];
  const downloadLog: Array<{ filename: string; json: string }> = [];

  const defaultExport: ArchiveExportCaller = async (input) => {
    exportLog.push(input);
    return { job_id: 'job-1' };
  };
  const defaultStatus: ArchiveStatusCaller = async () => ({
    state: 'done',
    bytes_written: 2048,
    progress_pct: 100,
    path: DONE_PATH,
  });
  const defaultImport: ArchiveImportCaller = async (input) => {
    importLog.push(input);
    return {
      manifest: {
        format_version: 1,
        schema_version: 1,
        exported_at: '2026-06-25T12:00:00.000Z',
        record_count: 1243,
        tables: { mail: 800, calendar: 443 },
        includes_blobs: true,
        includes_passport: false,
      },
      restored_at: input.dry_run ? null : 1_750_000_000_000,
      realm: 'same',
    };
  };
  const defaultPassportExport: ArchivePassportExportCaller = async (input) => {
    passportLog.push({ profile: input.profile });
    return { passport: { profile: input.profile, signed: true } as never };
  };
  const defaultPassportDownload: ArchivePassportDownloadFn = (filename, json) => {
    downloadLog.push({ filename, json });
  };

  const mount = mountArchiveBackupPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runExport: overrides.runExport ?? defaultExport,
    runStatus: overrides.runStatus ?? defaultStatus,
    runImport: overrides.runImport ?? defaultImport,
    runPassportExport: overrides.runPassportExport ?? defaultPassportExport,
    passportDownload: overrides.passportDownload ?? defaultPassportDownload,
    ...(overrides.archiveDownload ? { archiveDownload: overrides.archiveDownload } : {}),
    ...(overrides.archiveUpload ? { archiveUpload: overrides.archiveUpload } : {}),
    ...(overrides.stashRebind ? { stashRebind: overrides.stashRebind } : {}),
    poll: overrides.scheduler ?? noopScheduler,
  });
  return { host, mount, exportLog, importLog, passportLog, downloadLog };
};

const rpcError = (code: string, message = code): Error =>
  Object.assign(new Error(message), { code });

/** Drain the microtask + macrotask queues so an in-flight `clickCommit()` runs
 *  up to a parked `await` (used to observe state mid-commit). */
const flush = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

const statusSequence = (...items: ArchiveJobStatus[]): ArchiveStatusCaller => {
  let i = 0;
  return async () => items[Math.min(i++, items.length - 1)]!;
};

const previewOkManifest: ArchiveManifest = {
  format_version: 1,
  schema_version: 1,
  exported_at: '2026-06-25T12:00:00.000Z',
  record_count: 5,
  tables: { mail: 5 },
  includes_blobs: false,
  includes_passport: false,
};

/** Drive a restore to the armed commit with a dry-run that succeeds and a
 *  commit that throws `err`; returns the mount post-commit for assertions. */
const commitFailingWith = async (err: Error) => {
  const runImport: ArchiveImportCaller = async (input) => {
    if (input.dry_run) {
      return { manifest: previewOkManifest, restored_at: null, realm: 'same' };
    }
    throw err;
  };
  const { mount } = setupMount({ runImport });
  mount.clickRestore();
  mount.setRestorePath(DONE_PATH);
  mount.setRestoreMnemonic(KNOWN);
  await mount.clickPreview();
  expect(mount.getView()).toBe('restore-preview');
  mount.setArmed(true);
  await mount.clickCommit();
  return mount;
};

// ══════════════════════════════════════════════════════════════════
// Construction
// ══════════════════════════════════════════════════════════════════

describe('R26.4 Delta 2b — mountArchiveBackupPanel: construction', () => {
  const originalDoc = (globalThis as { document?: unknown }).document;
  afterEach(() => {
    (globalThis as { document?: unknown }).document = originalDoc;
  });

  it('throws when no document is available', () => {
    const host = makeFakeElement('div');
    (globalThis as { document?: unknown }).document = undefined;
    expect(() =>
      mountArchiveBackupPanel({
        host: host as unknown as HTMLElement,
        runExport: async () => ({ job_id: 'x' }),
        runStatus: async () => ({ state: 'done', bytes_written: 0, progress_pct: 100 }),
        runImport: async () => ({
          manifest: {
            format_version: 1,
            schema_version: 1,
            exported_at: '',
            record_count: 0,
            tables: {},
            includes_blobs: false,
            includes_passport: false,
          },
          restored_at: null,
          realm: 'same',
        }),
      }),
    ).toThrow(/no document available/);
  });

  it('appends a wrapper at view="menu" with both Back up + Restore CTAs', () => {
    const { host, mount } = setupMount();
    const panel = findByAttr(host, ARCHIVE_BACKUP_PANEL_ATTR);
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute(ARCHIVE_BACKUP_VIEW_ATTR)).toBe('menu');
    expect(mount.getView()).toBe('menu');
    expect(findByAttr(host, ARCHIVE_BACKUP_START_BTN_ATTR)).not.toBeNull();
    expect(findByAttr(host, ARCHIVE_RESTORE_START_BTN_ATTR)).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
// Export
// ══════════════════════════════════════════════════════════════════

describe('R26.4 Delta 2b — export', () => {
  it('Back up → entry reveals the mnemonic field + Start button', () => {
    const { host, mount } = setupMount();
    mount.clickBackup();
    expect(mount.getView()).toBe('export-entry');
    expect(findByAttr(host, ARCHIVE_BACKUP_RUN_BTN_ATTR)).not.toBeNull();
  });

  it('a client-side-invalid phrase never reaches the server', async () => {
    const { mount, exportLog } = setupMount();
    mount.clickBackup();
    mount.setExportMnemonic('not a real recovery phrase just filler words');
    await mount.clickStartBackup();
    expect(mount.getView()).toBe('export-entry');
    expect(mount.getError()).toMatch(/valid 24-word/);
    expect(exportLog).toHaveLength(0);
  });

  it('export → poll(running → done) renders progress then the written path', async () => {
    const runStatus = statusSequence(
      { state: 'running', bytes_written: 1024, progress_pct: 40 },
      { state: 'done', bytes_written: 4096, progress_pct: 100, path: DONE_PATH },
    );
    const { host, mount, exportLog } = setupMount({ runStatus });
    mount.clickBackup();
    mount.setExportMnemonic(KNOWN);
    await mount.clickStartBackup();
    // First poll landed `running` → progress bar at 40%, still running.
    expect(mount.getView()).toBe('export-running');
    expect(mount.getProgress().pct).toBe(40);
    expect(findByAttr(host, ARCHIVE_BACKUP_PROGRESS_ATTR)?.getAttribute('data-pct')).toBe('40');
    // The key crossed the wire exactly once, blobs + passport default ON.
    expect(exportLog).toEqual([
      { recoveryKey: KNOWN, include_blobs: true, include_passport: true },
    ]);
    // Next poll lands `done`.
    await mount.tickPoll();
    expect(mount.getView()).toBe('export-done');
    expect(mount.getExportPath()).toBe(DONE_PATH);
    expect(textOf(host)).toContain(DONE_PATH);
    expect(findByAttr(host, ARCHIVE_BACKUP_PATH_OUT_ATTR)?.getAttribute('data-tone')).toBe('ok');
  });

  it('the include-files toggle is forwarded as include_blobs:false', async () => {
    const { mount, exportLog } = setupMount();
    mount.clickBackup();
    mount.setExportMnemonic(KNOWN);
    mount.setIncludeBlobs(false);
    await mount.clickStartBackup();
    expect(exportLog[0]?.include_blobs).toBe(false);
  });

  it('export-entry renders both the files + passport include toggles', () => {
    const { host, mount } = setupMount();
    mount.clickBackup();
    expect(findByAttr(host, ARCHIVE_BACKUP_BLOBS_ATTR)).not.toBeNull();
    expect(findByAttr(host, ARCHIVE_BACKUP_PASSPORT_ATTR)).not.toBeNull();
  });

  it('the include-passport toggle is forwarded as include_passport:false', async () => {
    const { mount, exportLog } = setupMount();
    mount.clickBackup();
    mount.setExportMnemonic(KNOWN);
    mount.setIncludePassport(false);
    await mount.clickStartBackup();
    expect(exportLog[0]?.include_passport).toBe(false);
  });

  it('export-done renders "<filename> · download by <date> · <size>"', async () => {
    const EXPIRES = Date.UTC(2026, 6, 2, 12, 0, 0); // 2026-07-02
    const runStatus = statusSequence({
      state: 'done',
      bytes_written: 5 * 1024 * 1024,
      progress_pct: 100,
      path: DONE_PATH,
      expires_at: EXPIRES,
    });
    const { host, mount } = setupMount({ runStatus });
    mount.clickBackup();
    mount.setExportMnemonic(KNOWN);
    await mount.clickStartBackup();
    expect(mount.getView()).toBe('export-done');
    const headline = findByAttr(host, ARCHIVE_BACKUP_PATH_OUT_ATTR);
    const text = headline ? textOf(headline) : '';
    // basename of DONE_PATH, the +7d expiry date, the human size — all present.
    expect(text).toContain('recued-2026-06-25.recued.archive');
    expect(text).toContain('download by 2026-07-02');
    expect(text).toContain('5 MB');
    expect(mount.getExportExpiresAt()).toBe(EXPIRES);
    // The full server path stays visible (M1 is server-path only, no download).
    expect(textOf(host)).toContain(DONE_PATH);
  });

  it('a status 404 (archive_job_unknown) is surfaced softly, not as an error', async () => {
    const runStatus: ArchiveStatusCaller = async () => {
      throw rpcError('archive_job_unknown', 'no such job');
    };
    const { host, mount } = setupMount({ runStatus });
    mount.clickBackup();
    mount.setExportMnemonic(KNOWN);
    await mount.clickStartBackup();
    expect(mount.getView()).toBe('export-error');
    // Soft: NOT a hard error (getError only returns bad-tone lines).
    expect(mount.getError()).toBeNull();
    expect(textOf(host).toLowerCase()).toContain('no longer available');
  });

  it('a status `error` state surfaces the message + moves to export-error', async () => {
    const runStatus = statusSequence({
      state: 'error',
      bytes_written: 0,
      progress_pct: 0,
      error: 'disk full',
    });
    const { mount } = setupMount({ runStatus });
    mount.clickBackup();
    mount.setExportMnemonic(KNOWN);
    await mount.clickStartBackup();
    expect(mount.getView()).toBe('export-error');
    expect(mount.getError()).toContain('disk full');
  });

  it('a rejected export call surfaces an error', async () => {
    const runExport: ArchiveExportCaller = async () => {
      throw new Error('socket closed');
    };
    const { mount } = setupMount({ runExport });
    mount.clickBackup();
    mount.setExportMnemonic(KNOWN);
    await mount.clickStartBackup();
    expect(mount.getView()).toBe('export-error');
    expect(mount.getError()).toContain('socket closed');
  });

  it('the poll loop schedules a follow-up while running and cancels on dispose', async () => {
    let scheduledCount = 0;
    let cancelCount = 0;
    const scheduler: ArchivePollScheduler = {
      schedule: () => {
        scheduledCount += 1;
        return () => {
          cancelCount += 1;
        };
      },
    };
    const runStatus = statusSequence({
      state: 'running',
      bytes_written: 10,
      progress_pct: 5,
    });
    const { mount } = setupMount({ runStatus, scheduler });
    mount.clickBackup();
    mount.setExportMnemonic(KNOWN);
    await mount.clickStartBackup();
    expect(mount.getView()).toBe('export-running');
    expect(scheduledCount).toBe(1);
    mount.dispose();
    expect(cancelCount).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════
// Restore — dry-run preview
// ══════════════════════════════════════════════════════════════════

describe('R26.4 Delta 2b — restore preview', () => {
  it('Preview calls dry_run:true and renders the manifest', async () => {
    const { host, mount, importLog } = setupMount();
    mount.clickRestore();
    mount.setRestorePath(DONE_PATH);
    mount.setRestoreMnemonic(KNOWN);
    await mount.clickPreview();
    expect(mount.getView()).toBe('restore-preview');
    expect(importLog).toEqual([
      { path: DONE_PATH, recoveryKey: KNOWN, dry_run: true },
    ]);
    const manifest = findByAttr(host, ARCHIVE_RESTORE_MANIFEST_ATTR);
    expect(manifest).not.toBeNull();
    const text = textOf(host);
    expect(text).toContain('1,243 records');
    expect(text).toContain('2026-06-25T12:00:00.000Z');
    expect(text).toContain('Includes files: yes');
    expect(mount.getManifest()?.record_count).toBe(1243);
  });

  it('the preview surfaces whether the archive embeds an identity passport', async () => {
    const runImport: ArchiveImportCaller = async (input) => ({
      manifest: { ...previewOkManifest, includes_passport: true },
      restored_at: input.dry_run ? null : 1,
      realm: 'same',
    });
    const { host, mount } = setupMount({ runImport });
    mount.clickRestore();
    mount.setRestorePath(DONE_PATH);
    mount.setRestoreMnemonic(KNOWN);
    await mount.clickPreview();
    expect(textOf(host)).toContain('Includes identity passport: yes');
  });

  it('a missing path never reaches the server', async () => {
    const { mount, importLog } = setupMount();
    mount.clickRestore();
    mount.setRestoreMnemonic(KNOWN);
    await mount.clickPreview();
    expect(mount.getView()).toBe('restore-entry');
    expect(mount.getError()).toMatch(/path to the backup file/);
    expect(importLog).toHaveLength(0);
  });

  it('a client-side-invalid phrase never reaches the server', async () => {
    const { mount, importLog } = setupMount();
    mount.clickRestore();
    mount.setRestorePath(DONE_PATH);
    mount.setRestoreMnemonic('filler words that are not a real phrase at all');
    await mount.clickPreview();
    expect(mount.getView()).toBe('restore-entry');
    expect(mount.getError()).toMatch(/valid 24-word/);
    expect(importLog).toHaveLength(0);
  });

  it('a wrong key (ARCHIVE_INVALID_SIGNATURE) returns to entry as "doesn\'t match"', async () => {
    const runImport: ArchiveImportCaller = async () => {
      throw new Error(
        'ARCHIVE_INVALID_SIGNATURE: HMAC trailer mismatch — archive tampered or wrong recovery key',
      );
    };
    const { mount } = setupMount({ runImport });
    mount.clickRestore();
    mount.setRestorePath(DONE_PATH);
    mount.setRestoreMnemonic(KNOWN);
    await mount.clickPreview();
    expect(mount.getView()).toBe('restore-entry');
    expect(mount.getError()).toMatch(/doesn't match/);
  });

  it('a server-side bad_request (malformed key) shows the invalid-key copy, not the mismatch copy', async () => {
    // A key that passes the client BIP39 guard but the server rejects as
    // malformed comes back as `bad_request` — distinct from a valid-but-wrong
    // key (`ARCHIVE_INVALID_SIGNATURE`). It must surface the invalid copy.
    const runImport: ArchiveImportCaller = async () => {
      throw rpcError(
        'bad_request',
        'recoveryKey is not a valid 24-word recovery phrase',
      );
    };
    const { mount } = setupMount({ runImport });
    mount.clickRestore();
    mount.setRestorePath(DONE_PATH);
    mount.setRestoreMnemonic(KNOWN);
    await mount.clickPreview();
    expect(mount.getView()).toBe('restore-entry');
    expect(mount.getError()).toMatch(/valid 24-word/);
    expect(mount.getError()).not.toMatch(/doesn't match/);
  });

  // M5 S3.0 — a backup whose db schema is newer than this server: the preview
  // must BLOCK confirm (upgrade message, no arm, no commit button).
  it('a schema_compat archive_too_new preview blocks confirm (upgrade message, no commit)', async () => {
    const runImport: ArchiveImportCaller = async (input) => ({
      manifest: previewOkManifest,
      restored_at: input.dry_run ? null : 1,
      realm: 'same',
      schema_compat: { status: 'archive_too_new', server_schema_version: 2 },
    });
    const { host, mount } = setupMount({ runImport });
    mount.clickRestore();
    mount.setRestorePath(DONE_PATH);
    mount.setRestoreMnemonic(KNOWN);
    await mount.clickPreview();
    expect(mount.getView()).toBe('restore-preview');
    expect(findByAttr(host, ARCHIVE_RESTORE_SCHEMA_WARN_ATTR)).not.toBeNull();
    expect(textOf(host).toLowerCase()).toContain('upgrade this server');
    // No path to a destructive commit: neither the arm toggle nor the commit
    // button is rendered.
    expect(findByAttr(host, ARCHIVE_RESTORE_ARM_ATTR)).toBeNull();
    expect(findByAttr(host, ARCHIVE_RESTORE_COMMIT_BTN_ATTR)).toBeNull();
  });

  it('a schema_compat ok preview renders the normal confirm path (no upgrade block)', async () => {
    const runImport: ArchiveImportCaller = async (input) => ({
      manifest: previewOkManifest,
      restored_at: input.dry_run ? null : 1,
      realm: 'same',
      schema_compat: { status: 'ok', server_schema_version: 2 },
    });
    const { host, mount } = setupMount({ runImport });
    mount.clickRestore();
    mount.setRestorePath(DONE_PATH);
    mount.setRestoreMnemonic(KNOWN);
    await mount.clickPreview();
    expect(mount.getView()).toBe('restore-preview');
    expect(findByAttr(host, ARCHIVE_RESTORE_SCHEMA_WARN_ATTR)).toBeNull();
    expect(findByAttr(host, ARCHIVE_RESTORE_COMMIT_BTN_ATTR)).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
// Restore — two-tap confirm + commit
// ══════════════════════════════════════════════════════════════════

describe('R26.4 Delta 2b — restore commit', () => {
  const toPreview = async (over: SetupOptions = {}) => {
    const ctx = setupMount(over);
    ctx.mount.clickRestore();
    ctx.mount.setRestorePath(DONE_PATH);
    ctx.mount.setRestoreMnemonic(KNOWN);
    await ctx.mount.clickPreview();
    expect(ctx.mount.getView()).toBe('restore-preview');
    return ctx;
  };

  it('cannot commit without arming the confirm (two-tap gate)', async () => {
    const { mount, importLog } = await toPreview();
    // Commit while NOT armed — no destructive call, still on preview.
    await mount.clickCommit();
    expect(mount.getView()).toBe('restore-preview');
    // Only the dry_run call so far — no destructive commit.
    expect(importLog.filter((c) => c.dry_run === false)).toHaveLength(0);
  });

  it('the commit button is disabled until the arm checkbox is ticked', async () => {
    const { host, mount } = await toPreview();
    expect(findByAttr(host, ARCHIVE_RESTORE_COMMIT_BTN_ATTR)?.hasAttribute('disabled')).toBe(true);
    mount.setArmed(true);
    expect(findByAttr(host, ARCHIVE_RESTORE_COMMIT_BTN_ATTR)?.hasAttribute('disabled')).toBe(false);
  });

  it('armed commit calls dry_run:false and shows the restarting state', async () => {
    const { mount, importLog } = await toPreview();
    mount.setArmed(true);
    await mount.clickCommit();
    expect(mount.getView()).toBe('restore-committed');
    expect(importLog).toEqual([
      { path: DONE_PATH, recoveryKey: KNOWN, dry_run: true },
      { path: DONE_PATH, recoveryKey: KNOWN, dry_run: false },
    ]);
  });

  it('shows "restarting; reconnecting" copy on commit (the WS drop is expected)', async () => {
    const { host, mount } = await toPreview();
    mount.setArmed(true);
    await mount.clickCommit();
    expect(textOf(host).toLowerCase()).toContain('restarting');
    expect(textOf(host).toLowerCase()).toContain('reconnecting');
  });

  // ★ The committing import restarts the server; the response can race the
  // drain, so the in-flight call rejects with a transport-family code. EVERY
  // one of these means the restore committed — surface "restarting", never a
  // failure. (Parameterized so dropping any code from `isTransportDropError`
  // is caught.)
  it.each([
    'transport',
    'transport_disposed',
    'timeout',
    'webclient_reauth_required',
  ])('a %s rejection on commit is treated as committed, NOT an error', async (code) => {
    const mount = await commitFailingWith(rpcError(code, `${code} drop`));
    expect(mount.getView()).toBe('restore-committed');
    expect(mount.getError()).toBeNull();
  });

  // A genuine pre-commit rejection leaves the old db fully intact → it must be
  // surfaced as a failure, NOT swallowed as "committed".
  it.each(['internal', 'bad_request', 'aborted'])(
    'a %s rejection on commit surfaces an error (db intact)',
    async (code) => {
      const mount = await commitFailingWith(rpcError(code, `${code}: boom`));
      expect(mount.getView()).toBe('restore-error');
      expect(mount.getError()).toContain('boom');
    },
  );

  // A wrong key that somehow reaches commit (e.g. key changed after preview)
  // still maps to the dedicated "doesn't match" copy, not a generic failure.
  it('a wrong-key (ARCHIVE_INVALID_SIGNATURE) rejection on commit shows the mismatch copy', async () => {
    const mount = await commitFailingWith(
      new Error('ARCHIVE_INVALID_SIGNATURE: AEAD tag mismatch'),
    );
    expect(mount.getView()).toBe('restore-error');
    expect(mount.getError()).toMatch(/doesn't match/);
  });

  // M5 S3.0 backstop — if a too-new archive somehow reaches commit (preview
  // normally blocks it), the server's `archive_schema_too_new` 409 maps to the
  // upgrade-server copy, not a generic failure.
  it('an archive_schema_too_new rejection on commit shows the upgrade-server copy', async () => {
    const mount = await commitFailingWith(rpcError('archive_schema_too_new', 'schema too new'));
    expect(mount.getView()).toBe('restore-error');
    expect(mount.getError()?.toLowerCase()).toContain('upgrade this server');
  });
});

// ══════════════════════════════════════════════════════════════════
// Restore — M5 S2b rebind stash (driving-client bearer-handoff)
// ══════════════════════════════════════════════════════════════════

describe('R26.4 M5 S2b — restore: rebind bearer stash', () => {
  const REBIND: ArchiveImportRebind = {
    token_id: 'tok-rebind',
    bearer: 'fresh-rebind-bearer',
    instance_id: 'inst-driving',
  };

  /** Drive a restore to an armed commit whose `dry_run:false` resolves with
   *  `commit`. Optionally wire a `stashRebind` seam. Returns the mount. */
  const commitResolvingWith = async (
    commit: {
      manifest: ArchiveManifest;
      restored_at: number | null;
      realm: ArchiveRealmRelation;
      rebind?: ArchiveImportRebind;
    },
    stashRebind?: ArchiveRebindStashFn,
  ) => {
    const runImport: ArchiveImportCaller = async (input) =>
      input.dry_run
        ? { manifest: previewOkManifest, restored_at: null, realm: 'same' }
        : commit;
    const ctx = setupMount({
      runImport,
      ...(stashRebind ? { stashRebind } : {}),
    });
    ctx.mount.clickRestore();
    ctx.mount.setRestorePath(DONE_PATH);
    ctx.mount.setRestoreMnemonic(KNOWN);
    await ctx.mount.clickPreview();
    expect(ctx.mount.getView()).toBe('restore-preview');
    ctx.mount.setArmed(true);
    await ctx.mount.clickCommit();
    return ctx.mount;
  };

  const okCommit = (rebind?: ArchiveImportRebind) => ({
    manifest: previewOkManifest,
    restored_at: 1_750_000_000_000,
    realm: 'same' as ArchiveRealmRelation,
    ...(rebind ? { rebind } : {}),
  });

  it('a committing restore with a rebind stashes the new bearer, then shows restarting', async () => {
    const stashed: ArchiveImportRebind[] = [];
    const stashRebind: ArchiveRebindStashFn = async (r) => {
      stashed.push(r);
    };
    const mount = await commitResolvingWith(okCommit(REBIND), stashRebind);
    expect(stashed).toEqual([REBIND]);
    expect(mount.getView()).toBe('restore-committed');
    expect(mount.getError()).toBeNull();
  });

  it('the committed view waits for the stash to RESOLVE (the bearer write is awaited, not fire-and-forget)', async () => {
    // A controlled deferred: the stash parks until the test releases it. If the
    // panel regressed from `await stashRebind(...)` to fire-and-forget, the view
    // would flip to restore-committed BEFORE the release and the mid-flight
    // assertion below would fail. (A stash that only does synchronous work can't
    // distinguish the two — an async body runs synchronously up to its first
    // await either way — so this test deliberately PARKS on an await.)
    let releaseStash: (() => void) | undefined;
    const stashGate = new Promise<void>((resolve) => {
      releaseStash = resolve;
    });
    let stashStarted = false;
    const stashRebind: ArchiveRebindStashFn = async () => {
      stashStarted = true;
      await stashGate;
    };
    const runImport: ArchiveImportCaller = async (input) =>
      input.dry_run
        ? { manifest: previewOkManifest, restored_at: null, realm: 'same' }
        : okCommit(REBIND);
    const { mount } = setupMount({ runImport, stashRebind });
    mount.clickRestore();
    mount.setRestorePath(DONE_PATH);
    mount.setRestoreMnemonic(KNOWN);
    await mount.clickPreview();
    mount.setArmed(true);
    // Start the commit but DON'T await it — the stash parks mid-flight.
    const commitDone = mount.clickCommit();
    await flush();
    // The stash is in-flight (awaited); the committed view must NOT have flipped.
    expect(stashStarted).toBe(true);
    expect(mount.getView()).toBe('restore-busy');
    // Release the parked stash; only now does the commit finish + the view flip.
    releaseStash?.();
    await commitDone;
    expect(mount.getView()).toBe('restore-committed');
  });

  it('a commit WITHOUT a rebind (server resolved no driving identity) never calls the stash', async () => {
    const stashed: ArchiveImportRebind[] = [];
    const stashRebind: ArchiveRebindStashFn = async (r) => {
      stashed.push(r);
    };
    const mount = await commitResolvingWith(okCommit(/* no rebind */), stashRebind);
    expect(stashed).toHaveLength(0);
    expect(mount.getView()).toBe('restore-committed');
    expect(mount.getError()).toBeNull();
  });

  it('a rebind with NO stash seam wired does not crash — still commits', async () => {
    const mount = await commitResolvingWith(okCommit(REBIND) /* stashRebind omitted */);
    expect(mount.getView()).toBe('restore-committed');
    expect(mount.getError()).toBeNull();
  });

  it('a throwing stash is swallowed (best-effort) — still restore-committed, never an error', async () => {
    const stashRebind: ArchiveRebindStashFn = async () => {
      throw new Error('idb-write-blew-up mid-stash');
    };
    const mount = await commitResolvingWith(okCommit(REBIND), stashRebind);
    expect(mount.getView()).toBe('restore-committed');
    expect(mount.getError()).toBeNull();
  });

  it('a transport-drop commit (response raced the drain) never calls the stash — no result to read', async () => {
    const stashed: ArchiveImportRebind[] = [];
    const stashRebind: ArchiveRebindStashFn = async (r) => {
      stashed.push(r);
    };
    const runImport: ArchiveImportCaller = async (input) => {
      if (input.dry_run) {
        return { manifest: previewOkManifest, restored_at: null, realm: 'same' };
      }
      throw rpcError('transport', 'transport drop racing the drain');
    };
    const ctx = setupMount({ runImport, stashRebind });
    ctx.mount.clickRestore();
    ctx.mount.setRestorePath(DONE_PATH);
    ctx.mount.setRestoreMnemonic(KNOWN);
    await ctx.mount.clickPreview();
    ctx.mount.setArmed(true);
    await ctx.mount.clickCommit();
    expect(stashed).toHaveLength(0);
    expect(ctx.mount.getView()).toBe('restore-committed');
    expect(ctx.mount.getError()).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
// Restore — Q2 cross-realm gate
// ══════════════════════════════════════════════════════════════════

describe('R26.4 M1 — restore: Q2 cross-realm gate', () => {
  type ImportCall = { dry_run?: boolean; currentRealmKey?: string };
  /** A dry-run that reports `cross`; a commit that demands `currentRealmKey`.
   *  Records every call into `calls` (the override bypasses setupMount's own
   *  importLog, so capture locally). */
  const crossImport =
    (calls: ImportCall[]): ArchiveImportCaller =>
    async (input) => {
      calls.push({ dry_run: input.dry_run, currentRealmKey: input.currentRealmKey });
      if (!input.dry_run && input.currentRealmKey === undefined) {
        throw rpcError('archive_realm_mismatch', 'need current realm key');
      }
      return {
        manifest: { ...previewOkManifest, includes_passport: true },
        restored_at: input.dry_run ? null : 1,
        realm: 'cross',
      };
    };

  const toCrossPreview = async (runImport: ArchiveImportCaller) => {
    const ctx = setupMount({ runImport });
    ctx.mount.clickRestore();
    ctx.mount.setRestorePath(DONE_PATH);
    ctx.mount.setRestoreMnemonic(KNOWN);
    await ctx.mount.clickPreview();
    return ctx;
  };

  it('a same-realm preview does NOT reveal the current-realm key field', async () => {
    const { host, mount } = setupMount();
    mount.clickRestore();
    mount.setRestorePath(DONE_PATH);
    mount.setRestoreMnemonic(KNOWN);
    await mount.clickPreview();
    expect(mount.getRestoreRealm()).toBe('same');
    expect(findByAttr(host, ARCHIVE_RESTORE_REALM_KEY_ATTR)).toBeNull();
  });

  it('a cross-realm preview reveals the current-realm key field + re-pair warning', async () => {
    const { host, mount } = await toCrossPreview(crossImport([]));
    expect(mount.getView()).toBe('restore-preview');
    expect(mount.getRestoreRealm()).toBe('cross');
    expect(findByAttr(host, ARCHIVE_RESTORE_REALM_KEY_ATTR)).not.toBeNull();
    expect(textOf(host).toLowerCase()).toContain('re-pair');
  });

  it('a cross-realm commit WITHOUT a valid current-realm key shows a hint, no swap', async () => {
    const calls: ImportCall[] = [];
    const { mount } = await toCrossPreview(crossImport(calls));
    mount.setArmed(true);
    await mount.clickCommit(); // no realm key entered
    expect(mount.getView()).toBe('restore-preview');
    expect(mount.getError()).toMatch(/valid 24-word/);
    // The destructive commit never reached the server — only the dry-run did.
    expect(calls.filter((c) => c.dry_run === false)).toHaveLength(0);
  });

  it('a cross-realm commit WITH the current-realm key forwards it + restarts', async () => {
    const REALM = generateRecoveryKey().mnemonic;
    const calls: ImportCall[] = [];
    const { mount } = await toCrossPreview(crossImport(calls));
    mount.setArmed(true);
    mount.setRestoreCurrentRealmKey(REALM);
    await mount.clickCommit();
    expect(mount.getView()).toBe('restore-committed');
    const commit = calls.find((c) => c.dry_run === false);
    expect(commit?.currentRealmKey).toBe(REALM);
  });

  it('an archive_realm_mismatch rejection surfaces the realm-key hint (db intact)', async () => {
    const runImport: ArchiveImportCaller = async (input) => {
      if (!input.dry_run) throw rpcError('archive_realm_mismatch', '403');
      return { manifest: previewOkManifest, restored_at: null, realm: 'cross' };
    };
    const REALM = generateRecoveryKey().mnemonic;
    const { mount } = await toCrossPreview(runImport);
    mount.setArmed(true);
    mount.setRestoreCurrentRealmKey(REALM);
    await mount.clickCommit();
    expect(mount.getView()).toBe('restore-error');
    expect(mount.getError()).toMatch(/current recovery key/);
  });
});

// ══════════════════════════════════════════════════════════════════
// Passport-only export (support / audit JSON)
// ══════════════════════════════════════════════════════════════════

describe('R26.4 M1 — passport-only export', () => {
  it('the menu shows the Export-identity-passport action when wired', () => {
    const { host } = setupMount();
    expect(findByAttr(host, ARCHIVE_PASSPORT_START_BTN_ATTR)).not.toBeNull();
  });

  it('the passport action is hidden when no passport caller is wired', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    mountArchiveBackupPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runExport: async () => ({ job_id: 'x' }),
      runStatus: async () => ({ state: 'done', bytes_written: 0, progress_pct: 100 }),
      runImport: async () => ({
        manifest: {
          format_version: 1,
          schema_version: 1,
          exported_at: '',
          record_count: 0,
          tables: {},
          includes_blobs: false,
          includes_passport: false,
        },
        restored_at: null,
        realm: 'same',
      }),
      poll: noopScheduler,
      // runPassportExport deliberately omitted
    });
    expect(findByAttr(host, ARCHIVE_PASSPORT_START_BTN_ATTR)).toBeNull();
  });

  it('Export identity passport → signed JSON + a wired download seam', async () => {
    const { host, mount, passportLog, downloadLog } = setupMount();
    await mount.clickPassportExport();
    expect(mount.getView()).toBe('passport-done');
    // Only the lightweight support/audit profile is driven.
    expect(passportLog).toEqual([{ profile: 'support_redacted' }]);
    const ta = findByAttr(host, ARCHIVE_PASSPORT_JSON_ATTR);
    expect(ta?.value ?? '').toContain('support_redacted');
    expect(mount.getPassportJson()).toContain('support_redacted');
    expect(findByAttr(host, ARCHIVE_PASSPORT_DOWNLOAD_BTN_ATTR)).not.toBeNull();
    mount.clickPassportDownload();
    expect(downloadLog).toHaveLength(1);
    expect(downloadLog[0]?.filename).toMatch(/\.json$/);
    expect(downloadLog[0]?.json).toContain('support_redacted');
  });

  it('a failed passport export surfaces an error', async () => {
    const runPassportExport: ArchivePassportExportCaller = async () => {
      throw new Error('sign failed');
    };
    const { mount } = setupMount({ runPassportExport });
    await mount.clickPassportExport();
    expect(mount.getView()).toBe('passport-error');
    expect(mount.getError()).toContain('sign failed');
  });
});

// ══════════════════════════════════════════════════════════════════
// Navigation + lifecycle
// ══════════════════════════════════════════════════════════════════

describe('R26.4 Delta 2b — navigation + lifecycle', () => {
  it('Cancel from export-entry returns to the menu', () => {
    const { mount } = setupMount();
    mount.clickBackup();
    expect(mount.getView()).toBe('export-entry');
    mount.clickCancel();
    expect(mount.getView()).toBe('menu');
  });

  it('re-entering export after a run starts with an empty mnemonic field', async () => {
    const { host, mount } = setupMount();
    mount.clickBackup();
    mount.setExportMnemonic(KNOWN);
    await mount.clickStartBackup();
    expect(mount.getView()).toBe('export-done');
    mount.clickCancel();
    expect(mount.getView()).toBe('menu');
    mount.clickBackup();
    const field = findByAttr(host, ARCHIVE_BACKUP_MNEMONIC_ATTR);
    expect(field?.value ?? '').toBe('');
  });

  it('cancelling out of a running export cancels the pending poll timer', async () => {
    let cancelCount = 0;
    const scheduler: ArchivePollScheduler = {
      schedule: () => () => {
        cancelCount += 1;
      },
    };
    const runStatus = statusSequence({
      state: 'running',
      bytes_written: 10,
      progress_pct: 5,
    });
    const { mount } = setupMount({ runStatus, scheduler });
    mount.clickBackup();
    mount.setExportMnemonic(KNOWN);
    await mount.clickStartBackup();
    expect(mount.getView()).toBe('export-running');
    // Leaving the running view (NOT via dispose) must cancel the scheduled poll.
    mount.clickCancel();
    expect(mount.getView()).toBe('menu');
    expect(cancelCount).toBe(1);
  });

  it('a running → done transition cancels the pending poll timer', async () => {
    let cancelCount = 0;
    const scheduler: ArchivePollScheduler = {
      schedule: () => () => {
        cancelCount += 1;
      },
    };
    const runStatus = statusSequence(
      { state: 'running', bytes_written: 10, progress_pct: 5 },
      { state: 'done', bytes_written: 20, progress_pct: 100, path: DONE_PATH },
    );
    const { mount } = setupMount({ runStatus, scheduler });
    mount.clickBackup();
    mount.setExportMnemonic(KNOWN);
    await mount.clickStartBackup();
    expect(mount.getView()).toBe('export-running');
    await mount.tickPoll();
    expect(mount.getView()).toBe('export-done');
    expect(cancelCount).toBe(1);
  });

  it('dispose detaches the wrapper from the host', () => {
    const { host, mount } = setupMount();
    expect(findByAttr(host, ARCHIVE_BACKUP_PANEL_ATTR)).not.toBeNull();
    mount.dispose();
    expect(findByAttr(host, ARCHIVE_BACKUP_PANEL_ATTR)).toBeNull();
  });

  it('no stale result line leaks after dispose', () => {
    const { host, mount } = setupMount();
    mount.dispose();
    expect(findByAttr(host, ARCHIVE_BACKUP_RESULT_ATTR)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// M4 — browser download (export-done)
// ──────────────────────────────────────────────────────────────────

describe('M4 browser download', () => {
  /** A capturing archive-download seam — records each call so the test can
   *  drive onDone / onError, mirroring how the real socket would resolve. */
  const captureDownload = () => {
    const calls: Array<{ name: string; onDone: () => void; onError: (m: string) => void }> = [];
    const fn: ArchiveDownloadFn = (req) => {
      calls.push(req);
      return () => {};
    };
    return { calls, fn };
  };

  const driveToExportDone = async (
    s: ReturnType<typeof setupMount>,
  ): Promise<void> => {
    s.mount.clickBackup();
    s.mount.setExportMnemonic(KNOWN);
    await s.mount.clickStartBackup();
    if (s.mount.getView() === 'export-running') await s.mount.tickPoll();
    expect(s.mount.getView()).toBe('export-done');
  };

  it('shows a Download button on export-done + streams on click → done note', async () => {
    const dl = captureDownload();
    const s = setupMount({ archiveDownload: dl.fn });
    await driveToExportDone(s);

    const btn = findByAttr(s.host, ARCHIVE_BACKUP_DOWNLOAD_BTN_ATTR);
    expect(btn).not.toBeNull();

    btn!.click();
    expect(s.mount.isDownloading()).toBe(true);
    expect(dl.calls).toHaveLength(1);
    // The name is the basename of the completed export path (DONE_PATH).
    expect(dl.calls[0].name).toBe('recued-2026-06-25.recued.archive');

    dl.calls[0].onDone();
    expect(s.mount.isDownloading()).toBe(false);
    expect(textOf(s.host)).toContain('Downloaded to this device');
  });

  it('surfaces a download failure note', async () => {
    const dl = captureDownload();
    const s = setupMount({ archiveDownload: dl.fn });
    await driveToExportDone(s);
    findByAttr(s.host, ARCHIVE_BACKUP_DOWNLOAD_BTN_ATTR)!.click();
    dl.calls[0].onError('the server is gone');
    expect(s.mount.isDownloading()).toBe(false);
    expect(textOf(s.host)).toContain('Download failed: the server is gone');
  });

  it('hides the Download button when no seam is wired (server-path only)', async () => {
    const s = setupMount(); // no archiveDownload
    await driveToExportDone(s);
    expect(findByAttr(s.host, ARCHIVE_BACKUP_DOWNLOAD_BTN_ATTR)).toBeNull();
  });

  it('is re-entrancy guarded — a second click while downloading does not re-invoke', async () => {
    const dl = captureDownload();
    const s = setupMount({ archiveDownload: dl.fn });
    await driveToExportDone(s);
    findByAttr(s.host, ARCHIVE_BACKUP_DOWNLOAD_BTN_ATTR)!.click();
    // Re-render relabeled the button to "Downloading…" + disabled; clicking
    // again is a no-op (the guard lives in startDownload, not the DOM).
    findByAttr(s.host, ARCHIVE_BACKUP_DOWNLOAD_BTN_ATTR)!.click();
    expect(dl.calls).toHaveLength(1);
    expect(textOf(s.host)).toContain('Downloading…');
  });

  it('cancels an in-flight download when leaving the view', async () => {
    let cancelled = 0;
    const fn: ArchiveDownloadFn = () => () => { cancelled += 1; };
    const s = setupMount({ archiveDownload: fn });
    await driveToExportDone(s);
    findByAttr(s.host, ARCHIVE_BACKUP_DOWNLOAD_BTN_ATTR)!.click();
    expect(s.mount.isDownloading()).toBe(true);
    s.mount.clickCancel(); // back to menu
    expect(cancelled).toBe(1);
    expect(s.mount.isDownloading()).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────
// M4b.2 — restore via browser upload (the no-SSH migrate path)
// ──────────────────────────────────────────────────────────────────

describe('M4b.2 restore upload', () => {
  /** A capturing archive-upload seam — records each call so the test drives
   *  onProgress / onDone / onError, mirroring how the real socket would. */
  const captureUpload = () => {
    const calls: Array<{
      file: ArchiveUploadFile;
      onProgress: (sent: number, total: number) => void;
      onDone: (r: { staged_name: string; size_bytes: number }) => void;
      onError: (m: string) => void;
    }> = [];
    let cancelled = 0;
    const fn: ArchiveUploadFn = (req) => {
      calls.push(req);
      return () => {
        cancelled += 1;
      };
    };
    return { calls, fn, cancelled: () => cancelled };
  };

  const fakeFile = (
    name = 'my-backup.recued.archive',
    size = 2048,
  ): ArchiveUploadFile => ({
    name,
    size,
    type: '',
    lastModified: 0,
    slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
  });

  it('shows the file picker on restore-entry only when the seam is wired', () => {
    const wired = setupMount({ archiveUpload: captureUpload().fn });
    wired.mount.clickRestore();
    expect(findByAttr(wired.host, ARCHIVE_RESTORE_UPLOAD_INPUT_ATTR)).not.toBeNull();

    const bare = setupMount(); // no archiveUpload
    bare.mount.clickRestore();
    expect(findByAttr(bare.host, ARCHIVE_RESTORE_UPLOAD_INPUT_ATTR)).toBeNull();
  });

  it('the file input change handler starts the upload with the picked file', () => {
    const up = captureUpload();
    const { host, mount } = setupMount({ archiveUpload: up.fn });
    mount.clickRestore();
    const input = findByAttr(host, ARCHIVE_RESTORE_UPLOAD_INPUT_ATTR)!;
    // Stub the browser FileList the change handler reads.
    (input as unknown as { files: ArchiveUploadFile[] }).files = [fakeFile()];
    for (const fn of input.listeners.get('change') ?? []) fn({ target: input });
    expect(up.calls).toHaveLength(1);
    expect(up.calls[0].file.name).toBe('my-backup.recued.archive');
    expect(mount.getView()).toBe('restore-uploading');
  });

  it('uploads, renders progress, then feeds the staged name into Preview', async () => {
    const up = captureUpload();
    const { host, mount, importLog } = setupMount({ archiveUpload: up.fn });
    mount.clickRestore();
    mount.chooseRestoreFile(fakeFile());
    expect(mount.getView()).toBe('restore-uploading');
    expect(mount.isUploading()).toBe(true);
    expect(up.calls).toHaveLength(1);

    // A progress tick repaints the bar at the right percentage.
    up.calls[0].onProgress(1024, 2048);
    expect(mount.getUploadProgress()).toEqual({ sent: 1024, total: 2048 });
    expect(
      findByAttr(host, ARCHIVE_RESTORE_UPLOAD_PROGRESS_ATTR)?.getAttribute('data-pct'),
    ).toBe('50');

    // Done → drop back to entry, capture the staged name + a friendly note.
    up.calls[0].onDone({
      staged_name: 'recued-upload-abc.recued.archive',
      size_bytes: 2048,
    });
    expect(mount.getView()).toBe('restore-entry');
    expect(mount.isUploading()).toBe(false);
    expect(textOf(host)).toContain('Uploaded my-backup.recued.archive');

    // The staged basename now drives the EXISTING import flow as the path.
    mount.setRestoreMnemonic(KNOWN);
    await mount.clickPreview();
    expect(mount.getView()).toBe('restore-preview');
    expect(importLog).toEqual([
      {
        path: 'recued-upload-abc.recued.archive',
        recoveryKey: KNOWN,
        dry_run: true,
      },
    ]);
  });

  it('preserves a pre-typed recovery key across the upload', async () => {
    const up = captureUpload();
    const { mount, importLog } = setupMount({ archiveUpload: up.fn });
    mount.clickRestore();
    mount.setRestoreMnemonic(KNOWN); // key entered BEFORE picking the file
    mount.chooseRestoreFile(fakeFile());
    up.calls[0].onDone({ staged_name: 'recued-upload-xy.recued.archive', size_bytes: 1 });
    // No re-typing needed — Preview works straight away.
    await mount.clickPreview();
    expect(importLog[0]).toEqual({
      path: 'recued-upload-xy.recued.archive',
      recoveryKey: KNOWN,
      dry_run: true,
    });
  });

  it('surfaces an upload failure note and returns to entry', () => {
    const up = captureUpload();
    const { mount } = setupMount({ archiveUpload: up.fn });
    mount.clickRestore();
    mount.chooseRestoreFile(fakeFile());
    up.calls[0].onError('the connection was lost.');
    expect(mount.getView()).toBe('restore-entry');
    expect(mount.getError()).toContain('Upload failed: the connection was lost.');
    expect(mount.isUploading()).toBe(false);
  });

  it('the upload-view Cancel button aborts the seam and returns to entry', () => {
    const up = captureUpload();
    const { host, mount } = setupMount({ archiveUpload: up.fn });
    mount.clickRestore();
    mount.chooseRestoreFile(fakeFile());
    findByAttr(host, ARCHIVE_BACKUP_CANCEL_BTN_ATTR)!.click();
    expect(up.cancelled()).toBe(1);
    expect(mount.getView()).toBe('restore-entry');
    expect(mount.isUploading()).toBe(false);
  });

  it('ignores a second file choice while an upload is already in flight', () => {
    const up = captureUpload();
    const { mount } = setupMount({ archiveUpload: up.fn });
    mount.clickRestore();
    mount.chooseRestoreFile(fakeFile());
    mount.chooseRestoreFile(fakeFile('other.recued.archive'));
    expect(up.calls).toHaveLength(1);
  });

  it('dispose cancels an in-flight upload', () => {
    const up = captureUpload();
    const { mount } = setupMount({ archiveUpload: up.fn });
    mount.clickRestore();
    mount.chooseRestoreFile(fakeFile());
    mount.dispose();
    expect(up.cancelled()).toBe(1);
  });
});
