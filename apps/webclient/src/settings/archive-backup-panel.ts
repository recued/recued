/** Settings ▸ Backup & Recovery — the unified Backup & Recovery surface
 *  (R26.4 Backup & Migration Unification, M1 slice 4).
 *
 *  This ONE panel collapses what used to be three sibling blocks (recovery-key
 *  re-verify · full-data archive · identity-passport export) into a single
 *  Export/Import surface, per the locked M1 design:
 *    - The recovery key is the IN-FLOW access gate — entering it during export
 *      / restore proves ownership (no standalone re-verify block; decision 3).
 *    - The identity passport rides INSIDE the archive as an opt-out toggle
 *      ("include identity passport", default-on; decision 1/2) — the import-
 *      paste migration flow is superseded by that embed.
 *    - A separate lightweight "Export identity passport only" action stays for
 *      support / audit JSON (decision 2).
 *
 *  Drives the LIVE `server.archive.*` rpc (export / status / import) +
 *  `passport.export`. The archive is encrypted under the realm's 24-word
 *  recovery key; that phrase is sent per-call (transient, never persisted — the
 *  server holds only the Master DEK, never the raw key, and derives the archive
 *  key from the mnemonic) and wiped from panel state the moment its rpc
 *  resolves.
 *
 *  Three flows under one block:
 *
 *    • Back up — collect the recovery key (+ "include files" + "include identity
 *      passport" toggles) → `server.archive.export` returns a `job_id` → poll
 *      `server.archive.status` on an interval, rendering a progress bar → on
 *      `done` show "<filename> · download by <date> · <size>" (the archive stays
 *      server-side; a browser download is a separate later milestone). A status
 *      poll that 404s (`archive_job_unknown` — the export expired / was GC'd) is
 *      surfaced as "no longer available", NOT a hard error. The poll loop
 *      cancels on dispose / leaving the flow.
 *
 *    • Restore (destructive) — a server-side `path` + the recovery key →
 *      `server.archive.import { dry_run: true }` FIRST (decrypts, validates the
 *      key, returns the `ArchiveManifest` + the `realm` relation for a preview)
 *      → a strong two-tap confirm (arm the checkbox, THEN the danger button) →
 *      `{ dry_run: false }`. The Q2 realm gate splits the preview: a `same`-realm
 *      archive (your own backup) needs the one key; a `cross`-realm archive (a
 *      foreign identity) ALSO requires this server's current realm key + warns
 *      that the restore gives this server a new identity (re-pair other devices).
 *
 *    • Export identity passport only — a lightweight `passport.export`
 *      (`support_redacted`) → signed JSON for copy / download (support / audit).
 *
 *  ★ The committing import RESTARTS the server. `import { dry_run: false }`
 *  responds with `{ manifest, restored_at }` and THEN the server drains, swaps
 *  the db, and restarts — the WS connection drops right after the response, BY
 *  DESIGN (see memory `project_online_server_op_invariants` +
 *  internal design notes). So the commit path treats both
 *  a resolved call AND a transport-family rejection (the response racing the
 *  drain) as "restore committed — restarting; reconnecting…", leaning on the
 *  global pair/reconnect logic to re-establish the socket. A dropped WS here is
 *  NEVER an error. Only a genuine pre-commit rejection (wrong key / bad path)
 *  surfaces as a failure — the old db is fully intact in that case.
 *
 *  Style: mirrors `backup-recovery-panel.ts` — a self-scoped `*_STYLES` sheet
 *  under `[data-recued-archive-backup-panel]`, shared `rx-btn` primitives,
 *  `createElement` + per-element listeners, a `getView()`/`dispose()` handle
 *  with test affordances. */

import { isValidRecoveryKey } from '@recued/crypto';
import type {
  ArchiveImportRebind,
  ArchiveJobStatus,
  ArchiveManifest,
  ArchiveRealmRelation,
  ArchiveSchemaCompat,
  ServerPassportExportOptions,
  ServerPassportProjection,
} from '@recued/contracts';

// ════════════════════════════════════════════════════════════════
// Element attrs — stable for DOM tests + host introspection
// ════════════════════════════════════════════════════════════════

export const ARCHIVE_BACKUP_PANEL_ATTR = 'data-recued-archive-backup-panel';
export const ARCHIVE_BACKUP_VIEW_ATTR = 'data-recued-archive-backup-view';
// Menu
export const ARCHIVE_BACKUP_START_BTN_ATTR =
  'data-recued-archive-backup-start';
export const ARCHIVE_RESTORE_START_BTN_ATTR =
  'data-recued-archive-restore-start';
// Export
export const ARCHIVE_BACKUP_MNEMONIC_ATTR =
  'data-recued-archive-backup-mnemonic';
export const ARCHIVE_BACKUP_BLOBS_ATTR = 'data-recued-archive-backup-blobs';
export const ARCHIVE_BACKUP_PASSPORT_ATTR =
  'data-recued-archive-backup-passport';
export const ARCHIVE_BACKUP_RUN_BTN_ATTR = 'data-recued-archive-backup-run';
export const ARCHIVE_BACKUP_PROGRESS_ATTR =
  'data-recued-archive-backup-progress';
export const ARCHIVE_BACKUP_PATH_OUT_ATTR = 'data-recued-archive-backup-path';
// Restore
export const ARCHIVE_RESTORE_PATH_ATTR = 'data-recued-archive-restore-path';
export const ARCHIVE_RESTORE_MNEMONIC_ATTR =
  'data-recued-archive-restore-mnemonic';
export const ARCHIVE_RESTORE_PREVIEW_BTN_ATTR =
  'data-recued-archive-restore-preview';
export const ARCHIVE_RESTORE_MANIFEST_ATTR =
  'data-recued-archive-restore-manifest';
export const ARCHIVE_RESTORE_ARM_ATTR = 'data-recued-archive-restore-arm';
/** The preview's "some tables could not be counted" note — present ONLY when
 *  the server reported `uncounted_tables`, so `record_count` is a floor. */
export const ARCHIVE_RESTORE_UNCOUNTED_ATTR =
  'data-recued-archive-restore-uncounted';
/** M5 S3.0 — the "this backup needs a newer server" block shown in the restore
 *  preview when `schema_compat.status === 'archive_too_new'` (no arm/commit). */
export const ARCHIVE_RESTORE_SCHEMA_WARN_ATTR =
  'data-recued-archive-restore-schema-warn';
// Q2 cross-realm — the current server's recovery key, required to authorize a
// destructive swap of a FOREIGN archive (different identity).
export const ARCHIVE_RESTORE_REALM_KEY_ATTR =
  'data-recued-archive-restore-realm-key';
export const ARCHIVE_RESTORE_COMMIT_BTN_ATTR =
  'data-recued-archive-restore-commit';
// M4b.2 — restore-via-upload (no-SSH migrate): a file picker on restore-entry +
// a progress bar on the upload view.
export const ARCHIVE_RESTORE_UPLOAD_INPUT_ATTR =
  'data-recued-archive-restore-upload';
export const ARCHIVE_RESTORE_UPLOAD_PROGRESS_ATTR =
  'data-recued-archive-restore-upload-progress';
// Passport-only export (support / audit JSON)
export const ARCHIVE_PASSPORT_START_BTN_ATTR =
  'data-recued-archive-passport-start';
export const ARCHIVE_PASSPORT_JSON_ATTR = 'data-recued-archive-passport-json';
export const ARCHIVE_PASSPORT_DOWNLOAD_BTN_ATTR =
  'data-recued-archive-passport-download';
export const ARCHIVE_BACKUP_DOWNLOAD_BTN_ATTR =
  'data-recued-archive-backup-download';
// Shared
export const ARCHIVE_BACKUP_CANCEL_BTN_ATTR =
  'data-recued-archive-backup-cancel';
export const ARCHIVE_BACKUP_RESULT_ATTR = 'data-recued-archive-backup-result';

// ════════════════════════════════════════════════════════════════
// Caller seams + handle
// ════════════════════════════════════════════════════════════════

/** `server.archive.export` — starts an async export, returns a `job_id`.
 *  `include_passport` (default-on server-side) embeds the signed identity
 *  passport (`passport.json`) inside the archive; only an explicit `false`
 *  opts out. */
export type ArchiveExportCaller = (input: {
  include_blobs?: boolean;
  include_passport?: boolean;
  recoveryKey: string;
}) => Promise<{ job_id: string }>;

/** `server.archive.status` — polls an in-flight / completed export. */
export type ArchiveStatusCaller = (input: {
  job_id: string;
}) => Promise<ArchiveJobStatus>;

/** `server.archive.import` — `dry_run: true` previews + validates the key +
 *  reports the `realm` relation; `dry_run: false` commits (and restarts the
 *  server). `currentRealmKey` authorizes a destructive swap of a `cross`-realm
 *  archive (a foreign identity) — the Q2 ownership gate; omit it for `same`. */
export type ArchiveImportCaller = (input: {
  path: string;
  recoveryKey: string;
  currentRealmKey?: string;
  force?: boolean;
  dry_run?: boolean;
}) => Promise<{
  manifest: ArchiveManifest;
  restored_at: number | null;
  realm: ArchiveRealmRelation;
  /** M5 S2b — present only on a COMMITTING import (`dry_run: false`) when the
   *  server resolved THIS driving client's identity: a fresh bearer minted
   *  into the restored db (the swap wiped the old bearer row). The panel hands
   *  it to `stashRebind` so the post-restart reconnect re-pairs seamlessly.
   *  Absent ⇒ the client re-pairs the old way. */
  rebind?: ArchiveImportRebind;
  /** M5 S3.0 — db-schema compatibility verdict, present on `dry_run` so the
   *  preview can warn + block confirm when the backup needs a newer server. */
  schema_compat?: ArchiveSchemaCompat;
}>;

/** M5 S2b — stash the rebind bearer a committing import returns. The panel
 *  can't reach the token / local stores (same decoupling as the upload /
 *  download seams), so the host injects this: it re-wraps `<token_id>.<bearer>`
 *  under the same AES-GCM envelope the bootstrap reads + overwrites the
 *  `webclient_token` field IN PLACE (server identity unchanged — only the
 *  bearer row rotated). Best-effort by contract: it resolves whether or not
 *  the stash lands (a failure degrades to the pre-S2b re-pair on reconnect), so
 *  the panel never blocks the "restarting" view on it. When omitted (host
 *  didn't wire it) the panel simply skips the stash. */
export type ArchiveRebindStashFn = (rebind: ArchiveImportRebind) => Promise<void>;

/** `passport.export` — signs + audits a passport projection server-side and
 *  returns it. The unified surface drives ONLY the `support_redacted` profile
 *  (a lightweight standalone support / audit JSON); the migration profile is
 *  superseded by the in-archive passport embed. */
export type ArchivePassportExportCaller = (
  input: ServerPassportExportOptions,
) => Promise<{ passport: ServerPassportProjection }>;

/** Browser-download seam — defaults to an anchor + object-URL click; tests
 *  inject a spy + assert the filename / payload. Mirrors the retired passport
 *  panel's `PassportDownloadFn`. */
export type ArchivePassportDownloadFn = (filename: string, json: string) => void;

/** Browser archive-download seam (M4). Opens the dedicated binary `/ws/download`
 *  socket, streams the named export off the server, assembles a Blob, and
 *  triggers a browser save. Injected by the host because it needs the token
 *  store + WebSocket the panel can't reach; when omitted the Download button is
 *  hidden and the export stays server-path-only. Returns a cancel fn (called on
 *  dispose / when leaving the view). Tests inject a fake to drive onDone /
 *  onError without a real socket. */
export type ArchiveDownloadFn = (req: {
  /** The export file basename to fetch (confined server-side to `exports/`). */
  name: string;
  onError: (message: string) => void;
  onDone: () => void;
}) => () => void;

/** A sliceable byte source the upload reads — a browser `File` satisfies it
 *  structurally (`slice` returns a `Blob` whose `arrayBuffer()` reads the
 *  range). Kept minimal + local so the panel's seam stays self-describing (the
 *  driver in `archive-upload.ts` maps it onto the shared upload engine's
 *  `UploadFile`). */
export interface ArchiveUploadFile {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly lastModified: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

/** Browser archive-UPLOAD seam (M4b.2 — the no-SSH migrate path). Chunks the
 *  chosen `.recued.archive` over the dedicated binary `/ws/archive-upload`
 *  socket and stages it server-side; the resolved `staged_name` is fed into the
 *  EXISTING restore import flow (it becomes the `path` the dry-run + commit
 *  use). Injected by the host because it needs the token store + WebSocket the
 *  panel can't reach; when omitted the file-picker is hidden and restore stays
 *  server-path-only. Returns a cancel fn (called on cancel / dispose / leaving
 *  the upload view). Tests inject a fake to drive onProgress / onDone / onError
 *  without a real socket. */
export type ArchiveUploadFn = (req: {
  /** The picked backup file. */
  file: ArchiveUploadFile;
  /** Byte progress ticks (sent / total) while chunking + finalizing. */
  onProgress: (sent: number, total: number) => void;
  onError: (message: string) => void;
  /** The server staged the archive under `exports/<staged_name>`; pass it as
   *  the import `path`. */
  onDone: (result: { staged_name: string; size_bytes: number }) => void;
}) => () => void;

/** A cancellable deferred-execution seam for the status poll loop. The
 *  production default is a `setTimeout` wrapper; tests inject a no-op so the
 *  loop never self-advances and is stepped manually via `tickPoll()`. */
export interface ArchivePollScheduler {
  schedule(fn: () => void, ms: number): () => void;
}

export type ArchiveBackupView =
  | 'menu'
  | 'export-entry'
  | 'export-running'
  | 'export-done'
  | 'export-error'
  | 'restore-entry'
  | 'restore-uploading'
  | 'restore-busy'
  | 'restore-preview'
  | 'restore-committed'
  | 'restore-error'
  // Passport-only export (support / audit JSON).
  | 'passport-exporting'
  | 'passport-done'
  | 'passport-error';

export interface MountArchiveBackupPanelOptions {
  /** Host element the panel renders into. */
  host: HTMLElement;
  /** DOM document seam. Defaults to `globalThis.document`. */
  document?: Document;
  /** `server.archive.export` caller seam. */
  runExport: ArchiveExportCaller;
  /** `server.archive.status` caller seam. */
  runStatus: ArchiveStatusCaller;
  /** `server.archive.import` caller seam. */
  runImport: ArchiveImportCaller;
  /** `passport.export` caller seam. When omitted the "Export identity passport
   *  only" action is not rendered (the archive backup / restore flows still
   *  work). */
  runPassportExport?: ArchivePassportExportCaller;
  /** M5 S2b — stash the rebind bearer a committing restore returns so the
   *  post-restart reconnect re-pairs seamlessly. When omitted the panel skips
   *  the stash (the client re-pairs the old way). See `ArchiveRebindStashFn`. */
  stashRebind?: ArchiveRebindStashFn;
  /** Override the passport-JSON download mechanism (tests). */
  passportDownload?: ArchivePassportDownloadFn;
  /** Browser archive-download seam (M4). When provided, the export-done view
   *  shows a Download button that pulls the archive over `/ws/download`; omitted
   *  ⇒ the view is server-path-only. */
  archiveDownload?: ArchiveDownloadFn;
  /** Browser archive-UPLOAD seam (M4b.2). When provided, restore-entry shows a
   *  file picker that uploads a `.recued.archive` over `/ws/archive-upload` and
   *  feeds the staged path into the import flow; omitted ⇒ restore is
   *  server-path-only. */
  archiveUpload?: ArchiveUploadFn;
  /** Poll scheduler. Defaults to a `setTimeout` wrapper. */
  poll?: ArchivePollScheduler;
  /** Status poll interval (ms). Defaults to 1500. */
  pollIntervalMs?: number;
}

export interface ArchiveBackupPanelMount {
  /** Current view — primary surface for tests + host introspection. */
  getView(): ArchiveBackupView;
  /** Last error message, or null. */
  getError(): string | null;
  /** Last dry-run manifest, or null. */
  getManifest(): ArchiveManifest | null;
  /** Latest export progress snapshot. */
  getProgress(): { pct: number; bytes: number };
  /** Completed export path, or null. */
  getExportPath(): string | null;
  /** Completed export expiry (unix-ms), or null. */
  getExportExpiresAt(): number | null;
  /** Last dry-run realm relation, or null. */
  getRestoreRealm(): ArchiveRealmRelation | null;
  /** Last exported passport JSON, or null. */
  getPassportJson(): string | null;
  /** Tear down the panel DOM + listeners + poll loop. Idempotent. */
  dispose(): void;
  // Export affordances
  clickBackup(): void;
  setExportMnemonic(value: string): void;
  setIncludeBlobs(value: boolean): void;
  setIncludePassport(value: boolean): void;
  clickStartBackup(): Promise<void>;
  /** Run one status poll cycle (tests step the loop with this). */
  tickPoll(): Promise<void>;
  // Restore affordances
  clickRestore(): void;
  setRestorePath(value: string): void;
  setRestoreMnemonic(value: string): void;
  setRestoreCurrentRealmKey(value: string): void;
  /** M4b.2 — drive a restore-via-upload of the picked file (the file <input>
   *  change handler calls this; tests pass a fake file). No-op when the upload
   *  seam isn't wired or an upload is already in flight. */
  chooseRestoreFile(file: ArchiveUploadFile): void;
  /** M4b.2 — true while a restore upload is streaming. */
  isUploading(): boolean;
  /** M4b.2 — latest restore-upload progress snapshot. */
  getUploadProgress(): { sent: number; total: number };
  clickPreview(): Promise<void>;
  setArmed(value: boolean): void;
  clickCommit(): Promise<void>;
  // Passport-only export affordances
  clickPassportExport(): Promise<void>;
  clickPassportDownload(): void;
  // M4 browser download of the completed export.
  clickDownload(): void;
  isDownloading(): boolean;
  // Shared
  clickCancel(): void;
}

// ════════════════════════════════════════════════════════════════
// Copy
// ════════════════════════════════════════════════════════════════

const COPY = {
  heading: 'Backup & Recovery',
  menu_body:
    'Back up everything Recued holds for you — your warehouse, contacts, memory, connections and settings — into one encrypted archive on your server, or restore your server from a previous backup. Backups are sealed with your 24-word recovery key.',
  backup_cta: 'Back up all my data',
  restore_cta: 'Restore from a backup',
  passport_only_cta: 'Export identity passport only',

  // Export
  export_body:
    'Enter your 24-word recovery key to seal the backup. The key is sent only to your server and never stored here.',
  include_blobs_label: 'Include attached files and large records',
  include_passport_label: 'Include identity passport (for migrating to a new server)',
  run_backup_cta: 'Start backup',
  export_running: 'Backing up your data…',
  export_done_prefix: 'Backup ready:',
  export_done_download_by: 'download by',
  export_expired:
    'That backup is no longer available — it expired or was cleaned up. Run a new backup.',
  download_cta: 'Download to this device',
  download_pending: 'Downloading…',
  download_done: 'Downloaded to this device.',
  download_failed: 'Download failed:',

  // Restore
  restore_body:
    'Restore replaces ALL current data on this server with the snapshot inside a backup file. Upload a backup file from this device (or give a path to one already on your server), enter your 24-word recovery key, then preview before confirming.',
  restore_upload_label: 'Upload a backup file from this device',
  restore_path_label: 'Or path to a backup already on your server',
  restore_path_placeholder: 'exports/recued-2026-06-25.recued.archive',
  restore_uploading: 'Uploading your backup…',
  restore_upload_done_prefix: 'Uploaded',
  restore_upload_done_suffix:
    '— enter your recovery key (if you haven’t) and Preview.',
  restore_upload_failed: 'Upload failed:',
  preview_cta: 'Preview backup',
  restore_busy: 'Reading the backup…',
  restore_arm_label:
    'I understand this REPLACES all current data on this server with the snapshot.',
  restore_arm_label_cross:
    'I understand this REPLACES all current data on this server with the snapshot — and gives this server a new identity.',
  restore_arm_confirm: 'Yes, replace everything.',
  restore_arm_confirm_cross: 'Yes, replace everything and its identity.',
  commit_cta: 'Restore (replace everything)',
  restore_committed:
    'Restore committed — the server is restarting to load the snapshot. Reconnecting…',
  // Q2 cross-realm
  cross_realm_warning:
    'This backup belongs to a different identity than this server. Restoring it gives this server that identity — your other paired devices will need to be re-paired afterward. Confirm with THIS server’s current recovery key to authorize the change.',
  realm_key_label: 'This server’s current recovery key',
  realm_mismatch:
    "That isn't this server's current recovery key, so this foreign backup can't be authorized. Check your written copy and try again.",

  // Passport-only export
  passport_busy: 'Signing your identity passport…',
  passport_done: 'Identity passport exported (support / audit).',
  passport_download_cta: 'Download .json',
  passport_failed: 'The passport export failed.',

  // Shared
  mnemonic_placeholder: 'word1 word2 word3 … word24',
  cancel_cta: 'Cancel',
  back_cta: 'Back',

  // Results / errors
  invalid_key:
    "That doesn't look like a valid 24-word recovery key. Check for typos or missing words.",
  invalid_realm_key:
    "That doesn't look like a valid 24-word recovery key for this server. Check for typos or missing words.",
  missing_path: 'Enter the path to the backup file on your server.',
  key_mismatch:
    "That recovery key doesn't match this archive. Check your written copy and try again.",
  export_failed: 'The backup failed.',
  preview_failed: 'Could not read the backup.',
  restore_failed: 'The restore failed.',
  // M5 S3.0 — the backup's db schema is newer than this server understands.
  // There is no downgrade path, so block the restore + tell the user to upgrade.
  schema_too_new:
    'This backup was made by a newer version of Recued than this server runs. Upgrade this server, then restore.',
} as const;

// ════════════════════════════════════════════════════════════════
// Styles (self-scoped under the panel attr; joined into the route bundle)
// ════════════════════════════════════════════════════════════════

export const ARCHIVE_BACKUP_PANEL_STYLES = `
[${ARCHIVE_BACKUP_PANEL_ATTR}] .archive-backup-block {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 560px;
}
[${ARCHIVE_BACKUP_PANEL_ATTR}] h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
  color: var(--fg);
}
[${ARCHIVE_BACKUP_PANEL_ATTR}] .archive-backup-body {
  margin: 0;
  color: var(--muted, var(--fg-muted));
  font-size: 13px;
  line-height: 1.5;
}
[${ARCHIVE_BACKUP_PANEL_ATTR}] textarea {
  width: 100%;
  box-sizing: border-box;
  min-height: 76px;
  resize: vertical;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
}
[${ARCHIVE_BACKUP_PANEL_ATTR}] input[type="text"] {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
[${ARCHIVE_BACKUP_PANEL_ATTR}] input[type="file"] {
  width: 100%;
  box-sizing: border-box;
  font-size: 12px;
  color: var(--fg);
}
[${ARCHIVE_BACKUP_PANEL_ATTR}] textarea:focus,
[${ARCHIVE_BACKUP_PANEL_ATTR}] input[type="text"]:focus {
  outline: none;
  border-color: var(--accent);
}
[${ARCHIVE_BACKUP_PANEL_ATTR}] .archive-backup-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
[${ARCHIVE_BACKUP_PANEL_ATTR}] .archive-backup-field-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg);
}
[${ARCHIVE_BACKUP_PANEL_ATTR}] .archive-backup-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--fg);
}
[${ARCHIVE_BACKUP_PANEL_ATTR}] .archive-backup-actions {
  display: flex;
  gap: 8px;
}
[${ARCHIVE_BACKUP_PANEL_ATTR}] .archive-backup-progress {
  height: 8px;
  width: 100%;
  border-radius: 4px;
  background: var(--surface-sunken, var(--surface));
  border: 1px solid var(--border);
  overflow: hidden;
}
[${ARCHIVE_BACKUP_PANEL_ATTR}] .archive-backup-progress-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.2s ease;
}
[${ARCHIVE_BACKUP_PANEL_ATTR}] .archive-backup-manifest {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  font-size: 13px;
  line-height: 1.6;
  color: var(--fg);
}
[${ARCHIVE_BACKUP_PANEL_ATTR}] .archive-backup-manifest-warning {
  margin: 6px 0 0;
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 1.45;
}
[${ARCHIVE_BACKUP_PANEL_ATTR}] .archive-backup-result {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
}
[${ARCHIVE_BACKUP_PANEL_ATTR}] .archive-backup-result[data-tone="ok"] {
  color: var(--success, var(--accent));
}
[${ARCHIVE_BACKUP_PANEL_ATTR}] .archive-backup-result[data-tone="bad"] {
  color: var(--danger);
}
[${ARCHIVE_BACKUP_PANEL_ATTR}] .archive-backup-result[data-tone="neutral"] {
  color: var(--muted, var(--fg-muted));
}
`;

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════

const normalizeRecoveryKey = (s: string): string =>
  s.trim().replace(/\s+/g, ' ').toLowerCase();

const errorCodeOf = (err: unknown): string | null => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
};

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** The realm-recovery-key derivation throws `ARCHIVE_INVALID_SIGNATURE` (AEAD
 *  tag / HMAC mismatch) for a valid-shape-but-WRONG key; the WS dispatcher maps
 *  the plain Error to wire code `internal`, so the marker lives in the message,
 *  not the code. */
const isWrongKeyError = (err: unknown): boolean =>
  /ARCHIVE_INVALID_SIGNATURE/.test(messageOf(err));

/** Codes the rpc-conn rejects with when the socket drops / the conn is torn
 *  down / a call times out — i.e. the server-restart drop after a committing
 *  import. Treated as "committed; restarting", never as a hard error. */
const isTransportDropError = (err: unknown): boolean => {
  const code = errorCodeOf(err);
  return (
    code === 'transport' ||
    code === 'transport_disposed' ||
    code === 'timeout' ||
    code === 'webclient_reauth_required'
  );
};

/** A status poll for an export that has expired / been GC'd off disk 404s with
 *  `archive_job_unknown`. The export is simply no longer available — surface it
 *  softly (a neutral message + Back), NOT a red failure. */
const isJobUnknownError = (err: unknown): boolean =>
  errorCodeOf(err) === 'archive_job_unknown';

/** The Q2 realm gate: committing a cross-realm restore without (or with a wrong)
 *  `currentRealmKey` rejects with `archive_realm_mismatch` (403). */
const isRealmMismatchError = (err: unknown): boolean =>
  errorCodeOf(err) === 'archive_realm_mismatch';

/** M5 S3.0 — the server-side backstop: committing a newer-schema archive onto
 *  this (older) server rejects with `archive_schema_too_new` (409). The preview
 *  normally blocks confirm first; this covers a commit that slips through. */
const isSchemaTooNewError = (err: unknown): boolean =>
  errorCodeOf(err) === 'archive_schema_too_new';

const formatBytes = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
};

const clampPct = (n: number): number => {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
};

/** Locale-free UTC date (YYYY-MM-DD) for the "download by" line. */
const formatDate = (ms: number | null): string => {
  if (ms === null || !Number.isFinite(ms)) return '';
  return new Date(ms).toISOString().slice(0, 10);
};

/** Last path segment of a server-side archive path → the bare filename. */
const basename = (path: string): string => {
  const segs = path.split('/').filter((s) => s.length > 0);
  return segs[segs.length - 1] ?? path;
};

const defaultScheduler: ArchivePollScheduler = {
  schedule(fn, ms) {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
};

/** Default passport-JSON download — an anchor + object-URL click. No-op in
 *  non-browser / test environments (no `URL.createObjectURL`); tests inject a
 *  spy via `opts.passportDownload`. Mirrors the retired passport panel. */
const defaultPassportDownload =
  (doc: Document): ArchivePassportDownloadFn =>
  (filename, json) => {
    const url = (globalThis as { URL?: typeof URL }).URL;
    const blobCtor = (globalThis as { Blob?: typeof Blob }).Blob;
    if (!url?.createObjectURL || !blobCtor) return; // non-browser / test
    const href = url.createObjectURL(
      new blobCtor([json], { type: 'application/json' }),
    );
    const a = doc.createElement('a');
    a.setAttribute('href', href);
    a.setAttribute('download', filename);
    a.click();
    url.revokeObjectURL?.(href);
  };

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

export const mountArchiveBackupPanel = (
  opts: MountArchiveBackupPanelOptions,
): ArchiveBackupPanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountArchiveBackupPanel: no document available — pass `opts.document` for non-browser environments',
    );
  }
  const scheduler = opts.poll ?? defaultScheduler;
  const pollIntervalMs = opts.pollIntervalMs ?? 1500;
  const passportDownload =
    opts.passportDownload ?? defaultPassportDownload(doc);

  // ── State ──────────────────────────────────────────────────────
  let view: ArchiveBackupView = 'menu';
  let disposed = false;
  let resultLine: string | null = null;
  let resultTone: 'ok' | 'bad' | 'neutral' = 'neutral';

  // Export
  let exportMnemonic = '';
  let includeBlobs = true;
  let includePassport = true;
  let exportJobId: string | null = null;
  let exportProgress = { pct: 0, bytes: 0 };
  let exportPath: string | null = null;
  let exportExpiresAt: number | null = null;
  let pollCancel: (() => void) | null = null;
  // M4 browser download (export-done view).
  let downloading = false;
  let downloadCancel: (() => void) | null = null;
  let downloadNote: { tone: 'ok' | 'bad'; text: string } | null = null;

  // Restore
  let restorePath = '';
  let restoreMnemonic = '';
  let restoreCurrentRealmKey = '';
  let restoreManifest: ArchiveManifest | null = null;
  let restoreRealm: ArchiveRealmRelation | null = null;
  let restoreSchemaCompat: ArchiveSchemaCompat | null = null;
  let restoreArmed = false;
  // M4b.2 restore-via-upload.
  let restoreUploadProgress = { sent: 0, total: 0 };
  let restoreUploadCancel: (() => void) | null = null;
  let restoreUploadLabel = '';

  // Passport-only export
  let passportJson: string | null = null;

  // ── Wrapper ────────────────────────────────────────────────────
  const wrapper = doc.createElement('div');
  wrapper.setAttribute(ARCHIVE_BACKUP_PANEL_ATTR, '');
  wrapper.setAttribute(ARCHIVE_BACKUP_VIEW_ATTR, view);
  opts.host.appendChild(wrapper);

  const cancelPoll = (): void => {
    if (pollCancel) {
      pollCancel();
      pollCancel = null;
    }
  };

  const cancelDownload = (): void => {
    if (downloadCancel) {
      downloadCancel();
      downloadCancel = null;
    }
    downloading = false;
  };

  // M4b.2 — abort an in-flight restore upload (reaps the server scratch via the
  // seam's cancel fn). Idempotent.
  const cancelUpload = (): void => {
    if (restoreUploadCancel) {
      restoreUploadCancel();
      restoreUploadCancel = null;
    }
  };

  // M4 — kick off a browser download of the completed export over `/ws/download`.
  // Re-entrancy-guarded (one in-flight); resolves to a `download_done` / failure
  // note that the export-done view renders.
  const startDownload = (): void => {
    const fn = opts.archiveDownload;
    if (!fn || !exportPath || downloading) return;
    downloading = true;
    downloadNote = null;
    render();
    downloadCancel = fn({
      name: basename(exportPath),
      onError: (message) => {
        downloadCancel = null;
        downloading = false;
        downloadNote = { tone: 'bad', text: [COPY.download_failed, message].join(' ') };
        if (!disposed) render();
      },
      onDone: () => {
        downloadCancel = null;
        downloading = false;
        downloadNote = { tone: 'ok', text: COPY.download_done };
        if (!disposed) render();
      },
    });
  };

  // M4b.2 — upload a picked backup file over `/ws/archive-upload`, then feed the
  // server-staged path into the EXISTING restore flow (it fills `restorePath`,
  // so the user's next Preview / commit resolves the staged archive). The upload
  // itself needs no recovery key — only the later import does — so this never
  // gates on the mnemonic. Re-entrancy-guarded (one upload at a time).
  const startUpload = (file: ArchiveUploadFile): void => {
    const fn = opts.archiveUpload;
    if (!fn || restoreUploadCancel !== null) return;
    clearResult();
    restoreUploadProgress = { sent: 0, total: file.size };
    restoreUploadLabel = file.name;
    setView('restore-uploading');
    restoreUploadCancel = fn({
      file,
      onProgress: (sent, total) => {
        restoreUploadProgress = { sent, total };
        if (!disposed && view === 'restore-uploading') render();
      },
      onError: (message) => {
        restoreUploadCancel = null;
        if (disposed) return;
        resultLine = [COPY.restore_upload_failed, message].join(' ');
        resultTone = 'bad';
        setView('restore-entry');
      },
      onDone: (result) => {
        restoreUploadCancel = null;
        if (disposed) return;
        // The staged basename becomes the import path; surface a friendly note
        // referencing the user's original filename, then drop back to entry so
        // they can enter the key (if needed) and Preview.
        restorePath = result.staged_name;
        resultLine = [
          COPY.restore_upload_done_prefix,
          restoreUploadLabel,
          COPY.restore_upload_done_suffix,
        ].join(' ');
        resultTone = 'neutral';
        setView('restore-entry');
      },
    });
  };

  const setView = (next: ArchiveBackupView): void => {
    if (disposed) return;
    // Leaving the running view always stops the poll loop.
    if (view === 'export-running' && next !== 'export-running') cancelPoll();
    // Leaving export-done cancels any in-flight download + clears its note.
    if (view === 'export-done' && next !== 'export-done') {
      cancelDownload();
      downloadNote = null;
    }
    // Leaving the upload view stops any in-flight upload (a no-op once the seam
    // already settled it via onDone / onError, which null the cancel handle).
    if (view === 'restore-uploading' && next !== 'restore-uploading') {
      cancelUpload();
    }
    view = next;
    wrapper.setAttribute(ARCHIVE_BACKUP_VIEW_ATTR, view);
    render();
  };

  const clearResult = (): void => {
    resultLine = null;
    resultTone = 'neutral';
  };

  /** Reset every transient flow field + wipe all mnemonics. */
  const resetFlowState = (): void => {
    clearResult();
    cancelDownload();
    downloadNote = null;
    exportMnemonic = '';
    includeBlobs = true;
    includePassport = true;
    exportJobId = null;
    exportProgress = { pct: 0, bytes: 0 };
    exportPath = null;
    exportExpiresAt = null;
    restorePath = '';
    restoreMnemonic = '';
    restoreCurrentRealmKey = '';
    restoreManifest = null;
    restoreRealm = null;
    restoreSchemaCompat = null;
    restoreArmed = false;
    cancelUpload();
    restoreUploadProgress = { sent: 0, total: 0 };
    restoreUploadLabel = '';
    passportJson = null;
  };

  // ── Export ─────────────────────────────────────────────────────
  const runPollCycle = async (): Promise<void> => {
    if (disposed || exportJobId === null || view !== 'export-running') return;
    let status: ArchiveJobStatus;
    try {
      status = await opts.runStatus({ job_id: exportJobId });
    } catch (err) {
      if (disposed || view !== 'export-running') return;
      // A 404 (`archive_job_unknown`) means the export expired / was GC'd off
      // disk — it's gone, not failed. Surface it softly (neutral, not red).
      if (isJobUnknownError(err)) {
        resultLine = COPY.export_expired;
        resultTone = 'neutral';
      } else {
        resultLine = `${COPY.export_failed} ${messageOf(err)}`;
        resultTone = 'bad';
      }
      setView('export-error');
      return;
    }
    if (disposed || view !== 'export-running') return;
    exportProgress = {
      pct: clampPct(status.progress_pct),
      bytes: Math.max(0, status.bytes_written),
    };
    if (status.state === 'done') {
      exportPath = status.path ?? '';
      exportExpiresAt =
        typeof status.expires_at === 'number' ? status.expires_at : null;
      setView('export-done');
      return;
    }
    if (status.state === 'error') {
      resultLine = status.error
        ? `${COPY.export_failed} ${status.error}`
        : COPY.export_failed;
      resultTone = 'bad';
      setView('export-error');
      return;
    }
    // running — re-render the bar + schedule the next cycle.
    render();
    cancelPoll();
    pollCancel = scheduler.schedule(() => void runPollCycle(), pollIntervalMs);
  };

  const startExport = async (): Promise<void> => {
    if (disposed || view !== 'export-entry') return;
    const key = normalizeRecoveryKey(exportMnemonic);
    if (!isValidRecoveryKey(key)) {
      resultLine = COPY.invalid_key;
      resultTone = 'bad';
      render();
      return;
    }
    clearResult();
    exportProgress = { pct: 0, bytes: 0 };
    setView('export-running');
    let jobId: string;
    try {
      const res = await opts.runExport({
        recoveryKey: key,
        include_blobs: includeBlobs,
        include_passport: includePassport,
      });
      jobId = res.job_id;
    } catch (err) {
      // The key has done its job — don't keep it in memory.
      exportMnemonic = '';
      if (disposed) return;
      resultLine = isWrongKeyError(err)
        ? COPY.key_mismatch
        : `${COPY.export_failed} ${messageOf(err)}`;
      resultTone = 'bad';
      setView('export-error');
      return;
    }
    // Export is running server-side; the key is no longer needed.
    exportMnemonic = '';
    if (disposed) return;
    exportJobId = jobId;
    await runPollCycle();
  };

  // ── Restore ────────────────────────────────────────────────────
  const startPreview = async (): Promise<void> => {
    if (disposed || view !== 'restore-entry') return;
    const path = restorePath.trim();
    const key = normalizeRecoveryKey(restoreMnemonic);
    if (path === '') {
      resultLine = COPY.missing_path;
      resultTone = 'bad';
      render();
      return;
    }
    if (!isValidRecoveryKey(key)) {
      resultLine = COPY.invalid_key;
      resultTone = 'bad';
      render();
      return;
    }
    clearResult();
    setView('restore-busy');
    try {
      const res = await opts.runImport({ path, recoveryKey: key, dry_run: true });
      if (disposed) return;
      restoreManifest = res.manifest;
      restoreRealm = res.realm;
      restoreSchemaCompat = res.schema_compat ?? null;
      restoreCurrentRealmKey = '';
      restoreArmed = false;
      setView('restore-preview');
    } catch (err) {
      if (disposed) return;
      // dry_run failures are recoverable — return to entry with an inline
      // hint so the user can fix the key / path and retry. The key is wiped
      // (a wrong key must be re-typed).
      restoreMnemonic = '';
      if (isWrongKeyError(err)) resultLine = COPY.key_mismatch;
      else if (errorCodeOf(err) === 'bad_request') resultLine = COPY.invalid_key;
      else resultLine = `${COPY.preview_failed} ${messageOf(err)}`;
      resultTone = 'bad';
      setView('restore-entry');
    }
  };

  /** A `cross`-realm archive belongs to a different identity — the destructive
   *  swap must additionally prove ownership of THIS server's realm. */
  const isCrossRealm = (): boolean => restoreRealm === 'cross';

  const commitRestore = async (): Promise<void> => {
    if (disposed || view !== 'restore-preview' || !restoreArmed) return;
    const path = restorePath.trim();
    const key = normalizeRecoveryKey(restoreMnemonic);
    const cross = isCrossRealm();
    const realmKey = cross ? normalizeRecoveryKey(restoreCurrentRealmKey) : '';
    // Q2: a cross-realm swap needs a valid current-realm key. Validated inline
    // (NOT via a live re-render of the textarea, which would blur it while the
    // user types) — surface a hint + stay on the preview if it's missing/bad.
    if (cross && !isValidRecoveryKey(realmKey)) {
      resultLine = COPY.invalid_realm_key;
      resultTone = 'bad';
      render();
      return;
    }
    clearResult();
    setView('restore-busy');
    try {
      const result = await opts.runImport({
        path,
        recoveryKey: key,
        dry_run: false,
        // Q2: only a cross-realm swap needs to authorize against this server's
        // current realm; a same-realm restore sends just the one key.
        ...(cross ? { currentRealmKey: realmKey } : {}),
      });
      // M5 S2b — the committing import resolved BEFORE the drain closed the WS
      // (the server sends the response, then defers the restart). It carries a
      // `rebind`: a fresh bearer the server minted into the restored db for
      // THIS driving client, since the db swap wiped its old bearer row. Stash
      // it NOW (a local IDB write, independent of the WS) so the global
      // reconnect's next upgrade presents the new bearer + re-pairs seamlessly.
      // Best-effort: a missing rebind (server couldn't resolve a driving
      // identity) OR a failed stash degrades to the pre-S2b re-pair — never
      // block the committed view on it, and never let it reach the outer catch
      // (which would misread it as the restart transport-drop).
      if (result.rebind !== undefined && opts.stashRebind !== undefined) {
        try {
          await opts.stashRebind(result.rebind);
        } catch {
          // The stash seam is documented best-effort; swallow so a stash
          // throw can't masquerade as the commit's transport-drop below.
        }
      }
      restoreMnemonic = '';
      restoreCurrentRealmKey = '';
      if (disposed) return;
      setView('restore-committed');
    } catch (err) {
      restoreMnemonic = '';
      restoreCurrentRealmKey = '';
      if (disposed) return;
      // ★ The server restarts on commit, so the WS drops right after the
      // response. A transport-family rejection here means the response raced
      // the drain — the restore committed; treat it as success, NOT an error.
      if (isTransportDropError(err)) {
        setView('restore-committed');
        return;
      }
      // Q2 pre-commit rejection: the current-realm key was absent/wrong, so the
      // server refused to swap a foreign archive. The old db is fully intact.
      if (isRealmMismatchError(err)) {
        resultLine = COPY.realm_mismatch;
        resultTone = 'bad';
        setView('restore-error');
        return;
      }
      // M5 S3.0 backstop: the server refused a newer-schema archive (the preview
      // normally blocks this first). The old db is intact — surface the upgrade
      // message rather than a generic failure.
      if (isSchemaTooNewError(err)) {
        resultLine = COPY.schema_too_new;
        resultTone = 'bad';
        setView('restore-error');
        return;
      }
      // A genuine pre-commit rejection (wrong archive key / bad path) — the old
      // db is intact. Surface it.
      resultLine = isWrongKeyError(err)
        ? COPY.key_mismatch
        : `${COPY.restore_failed} ${messageOf(err)}`;
      resultTone = 'bad';
      setView('restore-error');
    }
  };

  // ── Passport-only export (support / audit JSON) ────────────────
  const startPassportExport = async (): Promise<void> => {
    if (disposed || opts.runPassportExport === undefined) return;
    // Only reachable from the menu — guard against double-fire mid-flight.
    if (view === 'passport-exporting') return;
    clearResult();
    passportJson = null;
    setView('passport-exporting');
    try {
      const res = await opts.runPassportExport({ profile: 'support_redacted' });
      if (disposed) return;
      passportJson = JSON.stringify(res.passport, null, 2);
      resultLine = COPY.passport_done;
      resultTone = 'ok';
      setView('passport-done');
    } catch (err) {
      if (disposed) return;
      resultLine = `${COPY.passport_failed} ${messageOf(err)}`;
      resultTone = 'bad';
      setView('passport-error');
    }
  };

  const triggerPassportDownload = (): void => {
    if (disposed || passportJson === null) return;
    passportDownload('recued-passport-support_redacted.json', passportJson);
  };

  // ── Render ─────────────────────────────────────────────────────
  const clearChildren = (): void => {
    while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);
  };

  const makeButton = (
    label: string,
    attr: string,
    variant: 'primary' | 'secondary' | 'danger',
    onClick: () => void,
    enabled = true,
  ): HTMLButtonElement => {
    const btn = doc.createElement('button');
    btn.setAttribute(attr, '');
    btn.type = 'button';
    btn.textContent = label;
    btn.className = `rx-btn rx-btn-${variant} rx-btn-sm`;
    if (!enabled) {
      btn.setAttribute('disabled', '');
      (btn as { disabled?: boolean }).disabled = true;
    }
    btn.addEventListener('click', onClick);
    return btn;
  };

  /** A `<label><input type=checkbox> … </label>` toggle row. */
  const makeToggle = (
    attr: string,
    checked: boolean,
    label: string,
    onChange: (next: boolean) => void,
  ): HTMLLabelElement => {
    const toggle = doc.createElement('label');
    toggle.className = 'archive-backup-toggle';
    const box = doc.createElement('input');
    box.setAttribute(attr, '');
    box.type = 'checkbox';
    (box as { checked?: boolean }).checked = checked;
    if (checked) box.setAttribute('checked', '');
    box.addEventListener('change', () => {
      onChange(!!(box as { checked?: boolean }).checked);
    });
    toggle.appendChild(box);
    const span = doc.createElement('span');
    span.textContent = label;
    toggle.appendChild(span);
    return toggle;
  };

  const makeBody = (text: string): HTMLParagraphElement => {
    const p = doc.createElement('p');
    p.className = 'archive-backup-body';
    p.textContent = text;
    return p;
  };

  const makeMnemonicField = (
    attr: string,
    value: string,
    onInput: (v: string) => void,
  ): HTMLTextAreaElement => {
    const textarea = doc.createElement('textarea');
    textarea.setAttribute(attr, '');
    textarea.setAttribute('autocomplete', 'off');
    textarea.setAttribute('spellcheck', 'false');
    textarea.setAttribute('rows', '3');
    textarea.placeholder = COPY.mnemonic_placeholder;
    textarea.value = value;
    textarea.addEventListener('input', () => {
      onInput(textarea.value ?? '');
      if (resultLine !== null) {
        clearResult();
        const stale = wrapper.querySelector?.(`[${ARCHIVE_BACKUP_RESULT_ATTR}]`);
        stale?.parentNode?.removeChild(stale);
      }
    });
    return textarea;
  };

  const makeResultLine = (): HTMLParagraphElement | null => {
    if (resultLine === null) return null;
    const p = doc.createElement('p');
    p.setAttribute(ARCHIVE_BACKUP_RESULT_ATTR, '');
    p.setAttribute('data-tone', resultTone);
    p.setAttribute('role', 'status');
    p.className = 'archive-backup-result';
    p.textContent = resultLine;
    return p;
  };

  const renderMenu = (block: HTMLElement): void => {
    block.appendChild(makeBody(COPY.menu_body));
    const actions = doc.createElement('div');
    actions.className = 'archive-backup-actions';
    actions.appendChild(
      makeButton(
        COPY.backup_cta,
        ARCHIVE_BACKUP_START_BTN_ATTR,
        'primary',
        () => {
          resetFlowState();
          setView('export-entry');
        },
      ),
    );
    actions.appendChild(
      makeButton(
        COPY.restore_cta,
        ARCHIVE_RESTORE_START_BTN_ATTR,
        'secondary',
        () => {
          resetFlowState();
          setView('restore-entry');
        },
      ),
    );
    block.appendChild(actions);

    // Separate lightweight action — a standalone identity-passport export for
    // support / audit. The migration use is covered by the in-archive embed, so
    // this drives only the no-confirm `support_redacted` profile. Gated on the
    // caller so the archive flows still work when it isn't wired.
    if (opts.runPassportExport !== undefined) {
      const passportActions = doc.createElement('div');
      passportActions.className = 'archive-backup-actions';
      passportActions.appendChild(
        makeButton(
          COPY.passport_only_cta,
          ARCHIVE_PASSPORT_START_BTN_ATTR,
          'secondary',
          () => {
            void startPassportExport();
          },
        ),
      );
      block.appendChild(passportActions);
    }
  };

  const renderExportEntry = (block: HTMLElement): void => {
    block.appendChild(makeBody(COPY.export_body));
    block.appendChild(
      makeMnemonicField(ARCHIVE_BACKUP_MNEMONIC_ATTR, exportMnemonic, (v) => {
        exportMnemonic = v;
      }),
    );

    block.appendChild(
      makeToggle(
        ARCHIVE_BACKUP_BLOBS_ATTR,
        includeBlobs,
        COPY.include_blobs_label,
        (next) => {
          includeBlobs = next;
        },
      ),
    );
    block.appendChild(
      makeToggle(
        ARCHIVE_BACKUP_PASSPORT_ATTR,
        includePassport,
        COPY.include_passport_label,
        (next) => {
          includePassport = next;
        },
      ),
    );

    const result = makeResultLine();
    if (result) block.appendChild(result);

    const actions = doc.createElement('div');
    actions.className = 'archive-backup-actions';
    actions.appendChild(
      makeButton(COPY.run_backup_cta, ARCHIVE_BACKUP_RUN_BTN_ATTR, 'primary', () => {
        void startExport();
      }),
    );
    actions.appendChild(
      makeButton(COPY.cancel_cta, ARCHIVE_BACKUP_CANCEL_BTN_ATTR, 'secondary', () => {
        resetFlowState();
        setView('menu');
      }),
    );
    block.appendChild(actions);
  };

  const renderExportRunning = (block: HTMLElement): void => {
    const status = doc.createElement('p');
    status.className = 'archive-backup-body';
    status.setAttribute('role', 'status');
    status.textContent = `${COPY.export_running} ${exportProgress.pct}% · ${formatBytes(
      exportProgress.bytes,
    )} written`;
    block.appendChild(status);

    const bar = doc.createElement('div');
    bar.setAttribute(ARCHIVE_BACKUP_PROGRESS_ATTR, '');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('data-pct', String(exportProgress.pct));
    bar.setAttribute('aria-valuenow', String(exportProgress.pct));
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.className = 'archive-backup-progress';
    const fill = doc.createElement('div');
    fill.className = 'archive-backup-progress-fill';
    fill.setAttribute('style', `width:${exportProgress.pct}%`);
    bar.appendChild(fill);
    block.appendChild(bar);
  };

  const renderExportDone = (block: HTMLElement): void => {
    // "<filename> · download by <date> · <size>" (locked M1 export-ready copy).
    const parts: string[] = [exportPath ? basename(exportPath) : ''];
    if (exportExpiresAt !== null) {
      parts.push([COPY.export_done_download_by, formatDate(exportExpiresAt)].join(' '));
    }
    parts.push(formatBytes(exportProgress.bytes));

    const done = doc.createElement('p');
    done.setAttribute(ARCHIVE_BACKUP_PATH_OUT_ATTR, '');
    done.setAttribute('data-tone', 'ok');
    done.setAttribute('role', 'status');
    done.className = 'archive-backup-result';
    done.textContent = [COPY.export_done_prefix, parts.join(' · ')].join(' ');
    block.appendChild(done);

    // The archive also stays on the server — surface the full path so an
    // operator can locate / fetch it there; the Download button below is the
    // no-SSH path for everyone else (M4).
    if (exportPath) {
      const pathLine = doc.createElement('p');
      pathLine.className = 'archive-backup-body';
      pathLine.textContent = exportPath;
      block.appendChild(pathLine);
    }

    // Browser-download result / failure note.
    if (downloadNote) {
      const note = doc.createElement('p');
      note.className = 'archive-backup-result';
      note.setAttribute('data-tone', downloadNote.tone);
      note.setAttribute('role', 'status');
      note.textContent = downloadNote.text;
      block.appendChild(note);
    }

    const actions = doc.createElement('div');
    actions.className = 'archive-backup-actions';
    // Download to this device — only when the host wired the seam + a file
    // exists. Disabled + relabeled while a download is in flight.
    if (opts.archiveDownload && exportPath) {
      actions.appendChild(
        makeButton(
          downloading ? COPY.download_pending : COPY.download_cta,
          ARCHIVE_BACKUP_DOWNLOAD_BTN_ATTR,
          'primary',
          () => startDownload(),
          !downloading,
        ),
      );
    }
    actions.appendChild(
      makeButton(COPY.back_cta, ARCHIVE_BACKUP_CANCEL_BTN_ATTR, 'secondary', () => {
        resetFlowState();
        setView('menu');
      }),
    );
    block.appendChild(actions);
  };

  const renderRestoreEntry = (block: HTMLElement): void => {
    block.appendChild(makeBody(COPY.restore_body));

    // M4b.2 — the no-SSH path: upload a backup file from this device. Only when
    // the host wired the upload seam; otherwise restore stays server-path-only.
    if (opts.archiveUpload) {
      const upField = doc.createElement('div');
      upField.className = 'archive-backup-field';
      const upLabel = doc.createElement('span');
      upLabel.className = 'archive-backup-field-label';
      upLabel.textContent = COPY.restore_upload_label;
      upField.appendChild(upLabel);
      const fileInput = doc.createElement('input');
      fileInput.setAttribute(ARCHIVE_RESTORE_UPLOAD_INPUT_ATTR, '');
      fileInput.type = 'file';
      fileInput.setAttribute('accept', '.recued.archive,.archive');
      fileInput.addEventListener('change', () => {
        const picked = (fileInput as unknown as { files?: ArrayLike<ArchiveUploadFile> | null })
          .files;
        const file = picked && picked.length > 0 ? picked[0] : null;
        if (file) startUpload(file);
      });
      upField.appendChild(fileInput);
      block.appendChild(upField);
    }

    const field = doc.createElement('div');
    field.className = 'archive-backup-field';
    const label = doc.createElement('span');
    label.className = 'archive-backup-field-label';
    label.textContent = COPY.restore_path_label;
    field.appendChild(label);
    const pathInput = doc.createElement('input');
    pathInput.setAttribute(ARCHIVE_RESTORE_PATH_ATTR, '');
    pathInput.type = 'text';
    pathInput.setAttribute('autocomplete', 'off');
    pathInput.setAttribute('spellcheck', 'false');
    pathInput.placeholder = COPY.restore_path_placeholder;
    pathInput.value = restorePath;
    pathInput.addEventListener('input', () => {
      restorePath = pathInput.value ?? '';
    });
    field.appendChild(pathInput);
    block.appendChild(field);

    block.appendChild(
      makeMnemonicField(ARCHIVE_RESTORE_MNEMONIC_ATTR, restoreMnemonic, (v) => {
        restoreMnemonic = v;
      }),
    );

    const result = makeResultLine();
    if (result) block.appendChild(result);

    const actions = doc.createElement('div');
    actions.className = 'archive-backup-actions';
    actions.appendChild(
      makeButton(COPY.preview_cta, ARCHIVE_RESTORE_PREVIEW_BTN_ATTR, 'primary', () => {
        void startPreview();
      }),
    );
    actions.appendChild(
      makeButton(COPY.cancel_cta, ARCHIVE_BACKUP_CANCEL_BTN_ATTR, 'secondary', () => {
        resetFlowState();
        setView('menu');
      }),
    );
    block.appendChild(actions);
  };

  const renderRestoreUploading = (block: HTMLElement): void => {
    const pct = clampPct(
      restoreUploadProgress.total > 0
        ? (restoreUploadProgress.sent / restoreUploadProgress.total) * 100
        : 0,
    );
    const status = doc.createElement('p');
    status.className = 'archive-backup-body';
    status.setAttribute('role', 'status');
    status.textContent = `${COPY.restore_uploading} ${pct}% · ${formatBytes(
      restoreUploadProgress.sent,
    )} sent`;
    block.appendChild(status);

    const bar = doc.createElement('div');
    bar.setAttribute(ARCHIVE_RESTORE_UPLOAD_PROGRESS_ATTR, '');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('data-pct', String(pct));
    bar.setAttribute('aria-valuenow', String(pct));
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.className = 'archive-backup-progress';
    const fill = doc.createElement('div');
    fill.className = 'archive-backup-progress-fill';
    fill.setAttribute('style', `width:${pct}%`);
    bar.appendChild(fill);
    block.appendChild(bar);

    const actions = doc.createElement('div');
    actions.className = 'archive-backup-actions';
    actions.appendChild(
      makeButton(COPY.cancel_cta, ARCHIVE_BACKUP_CANCEL_BTN_ATTR, 'secondary', () => {
        // Abort the upload + drop back to entry (key + path preserved).
        cancelUpload();
        setView('restore-entry');
      }),
    );
    block.appendChild(actions);
  };

  const renderRestorePreview = (block: HTMLElement): void => {
    const manifest = restoreManifest;
    const cross = isCrossRealm();
    const summary = doc.createElement('div');
    summary.setAttribute(ARCHIVE_RESTORE_MANIFEST_ATTR, '');
    summary.className = 'archive-backup-manifest';
    if (manifest) {
      const records = doc.createElement('div');
      // ⚠ "at least" when the server told us it couldn't count everything:
      // `record_count` is then a floor, and this line is read at the moment
      // someone decides to restore. Absent field ⇒ the server does not report
      // it, so the wording stays as it was rather than claiming completeness
      // it cannot know.
      const uncounted = manifest.uncounted_tables ?? [];
      records.textContent = uncounted.length > 0
        ? `at least ${manifest.record_count.toLocaleString()} records from ${manifest.exported_at}`
        : `${manifest.record_count.toLocaleString()} records from ${manifest.exported_at}`;
      summary.appendChild(records);
      if (uncounted.length > 0) {
        const note = doc.createElement('div');
        note.setAttribute(ARCHIVE_RESTORE_UNCOUNTED_ATTR, '');
        note.className = 'archive-backup-manifest-warning';
        note.textContent =
          `${uncounted.length} table${uncounted.length === 1 ? '' : 's'} could not be counted `
          + `(${uncounted.join(', ')}), so the total above is a minimum. The restore itself is `
          + 'unaffected — this is the preview’s count, not the archive’s contents.';
        summary.appendChild(note);
      }
      const files = doc.createElement('div');
      files.textContent = `Includes files: ${manifest.includes_blobs ? 'yes' : 'no'}`;
      summary.appendChild(files);
      const passport = doc.createElement('div');
      passport.textContent = `Includes identity passport: ${manifest.includes_passport ? 'yes' : 'no'}`;
      summary.appendChild(passport);
      const fmt = doc.createElement('div');
      fmt.textContent = `Archive format v${manifest.format_version}`;
      summary.appendChild(fmt);
    }
    block.appendChild(summary);

    // M5 S3.0 — the backup's db schema is newer than this server understands.
    // There's no downgrade path, so BLOCK the restore: show an upgrade message +
    // a Cancel-only action (no arm, no commit). The server independently refuses
    // a non-forced commit, but we stop the user before the destructive confirm.
    if (restoreSchemaCompat?.status === 'archive_too_new') {
      const swarn = doc.createElement('p');
      swarn.className = 'archive-backup-result';
      swarn.setAttribute('data-tone', 'bad');
      swarn.setAttribute('role', 'status');
      swarn.setAttribute(ARCHIVE_RESTORE_SCHEMA_WARN_ATTR, '');
      swarn.textContent =
        `${COPY.schema_too_new} (this server: schema v${restoreSchemaCompat.server_schema_version})`;
      block.appendChild(swarn);

      const actions = doc.createElement('div');
      actions.className = 'archive-backup-actions';
      actions.appendChild(
        makeButton(COPY.cancel_cta, ARCHIVE_BACKUP_CANCEL_BTN_ATTR, 'secondary', () => {
          resetFlowState();
          setView('menu');
        }),
      );
      block.appendChild(actions);
      return;
    }

    // Q2 cross-realm: this archive belongs to a DIFFERENT identity than this
    // server. Warn that the restore re-identifies the server (re-pair other
    // devices) + take THIS server's current recovery key to authorize it.
    if (cross) {
      const xwarn = doc.createElement('p');
      xwarn.className = 'archive-backup-result';
      xwarn.setAttribute('data-tone', 'bad');
      xwarn.setAttribute('role', 'status');
      xwarn.textContent = COPY.cross_realm_warning;
      block.appendChild(xwarn);

      const field = doc.createElement('div');
      field.className = 'archive-backup-field';
      const label = doc.createElement('span');
      label.className = 'archive-backup-field-label';
      label.textContent = COPY.realm_key_label;
      field.appendChild(label);
      field.appendChild(
        makeMnemonicField(
          ARCHIVE_RESTORE_REALM_KEY_ATTR,
          restoreCurrentRealmKey,
          (v) => {
            restoreCurrentRealmKey = v;
          },
        ),
      );
      block.appendChild(field);
    }

    const warn = doc.createElement('p');
    warn.className = 'archive-backup-result';
    warn.setAttribute('data-tone', 'bad');
    warn.textContent = cross ? COPY.restore_arm_label_cross : COPY.restore_arm_label;
    block.appendChild(warn);

    block.appendChild(
      makeToggle(
        ARCHIVE_RESTORE_ARM_ATTR,
        restoreArmed,
        cross ? COPY.restore_arm_confirm_cross : COPY.restore_arm_confirm,
        (next) => {
          restoreArmed = next;
          render();
        },
      ),
    );

    // Inline hint (e.g. a missing/invalid current-realm key on a cross-realm
    // commit attempt) renders below the arm, above the actions.
    const result = makeResultLine();
    if (result) block.appendChild(result);

    const actions = doc.createElement('div');
    actions.className = 'archive-backup-actions';
    actions.appendChild(
      makeButton(
        COPY.commit_cta,
        ARCHIVE_RESTORE_COMMIT_BTN_ATTR,
        'danger',
        () => {
          void commitRestore();
        },
        restoreArmed,
      ),
    );
    actions.appendChild(
      makeButton(COPY.cancel_cta, ARCHIVE_BACKUP_CANCEL_BTN_ATTR, 'secondary', () => {
        resetFlowState();
        setView('menu');
      }),
    );
    block.appendChild(actions);
  };

  const renderBusy = (block: HTMLElement, text: string): void => {
    const busy = doc.createElement('p');
    busy.className = 'archive-backup-body';
    busy.setAttribute('role', 'status');
    busy.textContent = text;
    block.appendChild(busy);
  };

  const renderCommitted = (block: HTMLElement): void => {
    const msg = doc.createElement('p');
    msg.className = 'archive-backup-result';
    msg.setAttribute('data-tone', 'neutral');
    msg.setAttribute('role', 'status');
    msg.textContent = COPY.restore_committed;
    block.appendChild(msg);
  };

  const renderError = (block: HTMLElement): void => {
    const result = makeResultLine();
    if (result) block.appendChild(result);
    const actions = doc.createElement('div');
    actions.className = 'archive-backup-actions';
    actions.appendChild(
      makeButton(COPY.back_cta, ARCHIVE_BACKUP_CANCEL_BTN_ATTR, 'secondary', () => {
        resetFlowState();
        setView('menu');
      }),
    );
    block.appendChild(actions);
  };

  const renderPassportDone = (block: HTMLElement): void => {
    const result = makeResultLine();
    if (result) block.appendChild(result);

    const ta = doc.createElement('textarea');
    ta.setAttribute(ARCHIVE_PASSPORT_JSON_ATTR, '');
    ta.setAttribute('readonly', '');
    ta.setAttribute('spellcheck', 'false');
    ta.value = passportJson ?? '';
    block.appendChild(ta);

    const actions = doc.createElement('div');
    actions.className = 'archive-backup-actions';
    actions.appendChild(
      makeButton(
        COPY.passport_download_cta,
        ARCHIVE_PASSPORT_DOWNLOAD_BTN_ATTR,
        'primary',
        () => {
          triggerPassportDownload();
        },
      ),
    );
    actions.appendChild(
      makeButton(COPY.back_cta, ARCHIVE_BACKUP_CANCEL_BTN_ATTR, 'secondary', () => {
        resetFlowState();
        setView('menu');
      }),
    );
    block.appendChild(actions);
  };

  const render = (): void => {
    if (disposed) return;
    clearChildren();

    const block = doc.createElement('div');
    block.className = 'archive-backup-block';

    const h3 = doc.createElement('h3');
    h3.textContent = COPY.heading;
    block.appendChild(h3);

    switch (view) {
      case 'menu':
        renderMenu(block);
        break;
      case 'export-entry':
        renderExportEntry(block);
        break;
      case 'export-running':
        renderExportRunning(block);
        break;
      case 'export-done':
        renderExportDone(block);
        break;
      case 'export-error':
        renderError(block);
        break;
      case 'restore-entry':
        renderRestoreEntry(block);
        break;
      case 'restore-uploading':
        renderRestoreUploading(block);
        break;
      case 'restore-busy':
        renderBusy(block, COPY.restore_busy);
        break;
      case 'restore-preview':
        renderRestorePreview(block);
        break;
      case 'restore-committed':
        renderCommitted(block);
        break;
      case 'restore-error':
        renderError(block);
        break;
      case 'passport-exporting':
        renderBusy(block, COPY.passport_busy);
        break;
      case 'passport-done':
        renderPassportDone(block);
        break;
      case 'passport-error':
        renderError(block);
        break;
    }

    wrapper.appendChild(block);
  };

  render();

  return {
    getView: () => view,
    getError: () => (resultTone === 'bad' ? resultLine : null),
    getManifest: () => restoreManifest,
    getProgress: () => ({ ...exportProgress }),
    getExportPath: () => exportPath,
    getExportExpiresAt: () => exportExpiresAt,
    getRestoreRealm: () => restoreRealm,
    getPassportJson: () => passportJson,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelPoll();
      cancelDownload();
      cancelUpload();
      exportMnemonic = '';
      restoreMnemonic = '';
      restoreCurrentRealmKey = '';
      clearChildren();
      wrapper.remove();
    },
    clickBackup: () => {
      if (disposed || view !== 'menu') return;
      resetFlowState();
      setView('export-entry');
    },
    setExportMnemonic: (value: string) => {
      if (disposed) return;
      exportMnemonic = value;
    },
    setIncludeBlobs: (value: boolean) => {
      if (disposed) return;
      includeBlobs = value;
    },
    setIncludePassport: (value: boolean) => {
      if (disposed) return;
      includePassport = value;
    },
    clickStartBackup: async () => {
      await startExport();
    },
    tickPoll: async () => {
      await runPollCycle();
    },
    clickRestore: () => {
      if (disposed || view !== 'menu') return;
      resetFlowState();
      setView('restore-entry');
    },
    setRestorePath: (value: string) => {
      if (disposed) return;
      restorePath = value;
    },
    setRestoreMnemonic: (value: string) => {
      if (disposed) return;
      restoreMnemonic = value;
    },
    setRestoreCurrentRealmKey: (value: string) => {
      if (disposed) return;
      restoreCurrentRealmKey = value;
    },
    chooseRestoreFile: (file: ArchiveUploadFile) => {
      if (disposed || view !== 'restore-entry') return;
      startUpload(file);
    },
    isUploading: () => restoreUploadCancel !== null,
    getUploadProgress: () => ({ ...restoreUploadProgress }),
    clickPreview: async () => {
      await startPreview();
    },
    setArmed: (value: boolean) => {
      if (disposed) return;
      restoreArmed = value;
      if (view === 'restore-preview') render();
    },
    clickCommit: async () => {
      await commitRestore();
    },
    clickPassportExport: async () => {
      await startPassportExport();
    },
    clickPassportDownload: () => {
      triggerPassportDownload();
    },
    clickDownload: () => {
      if (disposed || view !== 'export-done') return;
      startDownload();
    },
    isDownloading: () => downloading,
    clickCancel: () => {
      if (disposed) return;
      cancelPoll();
      resetFlowState();
      setView('menu');
    },
  };
};
