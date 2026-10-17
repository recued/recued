/** D-172 P2 — files attached to a webclient chat turn.
 *
 *  ⛔ UNTIL THIS EXISTED, MESSENGER WAS THE ONLY WAY A FILE COULD ENTER A CHAT
 *  SESSION. `attachments` was set on exactly one code path (the messenger
 *  turn), and `apps/webclient/src/chat/` had no upload affordance at all — the
 *  only `media` in it was CSS `@media`. So the model-facing half (the tail
 *  marker, `file.search`) was built and had nothing to see from the webclient.
 *
 *  ── Why the engine, not the widget ────────────────────────────────
 *  `wireUploadWidget` ATTACHES to a rendered shell with its own drop-zone and
 *  progress chrome — right for the Data → Files panel, wrong for a chat
 *  composer, where the affordance is one button and a row of chips. This drives
 *  `createUploadEngine` directly: same resumable path, same binary socket, same
 *  `upload.*` control plane, no borrowed layout.
 *
 *  ── What it holds ─────────────────────────────────────────────────
 *  Finalized `data.file` ids ONLY. Existing files reuse those ids and carry a
 *  selection revision until Send. New bytes go up the binary socket and are
 *  never held here; reading them back is the separately-gated `data-file-read`. The
 *  ids ride on `chat.send`, and from there the orchestrator persists them on
 *  the user row and names them on the model's copy of the turn.
 *
 *  ⚠ A file is added to the pending list at FINALIZE, never at selection. A
 *  half-uploaded file is not attachable, and showing it as a chip before the
 *  server has it would let someone press Send on an attachment that does not
 *  exist yet — the message would go without it, silently. In-flight files are
 *  surfaced separately, and `hasInFlight()` is what the composer disables Send
 *  on. */

import { Upload } from '@recued/ui-shared';
import type { ChatMessageAttachment } from '@recued/contracts';
import type { ChatInterruptedUpload } from './draft-recovery.js';

export interface ComposerAttachmentsDeps {
  callers?: Upload.UploadCallers;
  connect?: Upload.UploadConnectFactory;
  /** Fired whenever the pending set or an in-flight upload changes, so the
   *  host repaints. */
  onChange: () => void;
}

/** One file the composer is showing: either climbing, failed, or attached. */
export interface ComposerAttachmentRow {
  /** ⛔ STABLE, NOT POSITIONAL. Each row's progress listener has to find its
   *  own row after an arbitrary number of removals, and an index captured at
   *  attach time stops naming the same file the moment an earlier row is
   *  removed — the listener then writes another file's progress, or nothing.
   *  Removal is by id for the same reason. */
  id: number;
  filename: string;
  /** Present once finalized — this is the id that rides on `chat.send`. */
  file_id?: string;
  media_class: string;
  selection_revision?: string;
  phase: 'uploading' | 'attached' | 'failed' | 'needs-file';
  /** 0–1, for the in-flight bar. */
  progress: number;
  error?: string;
}

export interface ComposerAttachments {
  attach(file: File, draftId?: string | null): number | undefined;
  /** Change the visible draft without cancelling another draft's uploads. */
  activateDraft(draftId: string | null): void;
  /** Lazy session creation gives the current blank draft its durable id. */
  moveDraft(from: string | null, to: string): void;
  discardDraft(draftId: string | null): void;
  hasDrafts(): boolean;
  hasDraft(draftId: string | null): boolean;
  /** Reuse retained selections, recovered drafts or withdrawn attachments. */
  restore(files: readonly ChatMessageAttachment[], draftId?: string | null): void;
  /** Rows to render, in the order they were added. */
  rows(): readonly ComposerAttachmentRow[];
  /** What rides on `chat.send` — finalized ids only. */
  payload(draftId?: string | null): ChatMessageAttachment[];
  /** Capture unfinished rows for in-memory pairing recovery. */
  recoveryUploads(draftId?: string | null): ChatInterruptedUpload[];
  restoreInterrupted(uploads: readonly ChatInterruptedUpload[], draftId?: string | null): void;
  /** Replace one failed or interrupted row, even if its draft is parked. */
  retry(id: number, file: File): number | undefined;
  /** Unfinished files must be chosen again or removed before Send. */
  hasUnfinished(): boolean;
  /** True while any file is still climbing. Send waits on this. */
  hasInFlight(): boolean;
  remove(id: number): void;
  /** Called after a successful send. */
  clear(): void;
  destroy(): void;
}

/** Best-effort class from the browser's mime type.
 *
 *  ⚠ ADVISORY ONLY — the `data.file` record carries the authoritative
 *  `media_class`, derived server-side at ingest, and that is what `file.search`
 *  returns. This exists because `ChatMessageAttachment` requires the field on
 *  the chat row; it is a display hint, and it must never become the value
 *  anything decides on. */
export const mediaClassForBrowserFile = (type: string): string => {
  const lower = type.toLowerCase();
  if (lower.startsWith('audio/')) return 'voice';
  if (lower.startsWith('image/')) return 'image';
  if (lower.length === 0) return 'other';
  return 'document';
};

export const createComposerAttachments = (
  deps: ComposerAttachmentsDeps,
): ComposerAttachments => {
  let activeDraftId: string | null = null;
  const drafts = new Map<string | null, ComposerAttachmentRow[]>();
  let rows: ComposerAttachmentRow[] = [];
  drafts.set(activeDraftId, rows);
  // One engine per file: the engine models a single run, and a composer
  // legitimately climbs two files at once. Keyed by the row's stable id.
  const engines = new Map<number, Upload.UploadEngine>();
  const recoveryIds = new Map<number, string>();
  let nextId = 1;

  const destroyEngine = (id: number): void => {
    const engine = engines.get(id);
    if (engine === undefined) return;
    engines.delete(id);
    try {
      engine.destroy();
    } catch {
      /* idempotent */
    }
  };

  const startUpload = (file: File, attachedRows: ComposerAttachmentRow[], retryId?: number): number | undefined => {
    if (!deps.callers || !deps.connect) return;
    const id = retryId ?? nextId++;
    const row: ComposerAttachmentRow = { id, filename: file.name,
      media_class: mediaClassForBrowserFile(file.type), phase: 'uploading', progress: 0 };
    if (retryId === undefined) attachedRows.push(row);
    else {
      const at = attachedRows.findIndex(candidate => candidate.id === retryId
        && (candidate.phase === 'needs-file' || candidate.phase === 'failed'));
      if (at === -1) return;
      attachedRows[at] = row;
    }
    const engine = Upload.createUploadEngine({
      callers: deps.callers,
      transport: Upload.createWsUploadTransport({ connect: deps.connect }),
    });
    engines.set(id, engine);
    engine.on('progress', (p) => {
      if (engines.get(id) !== engine) return; // a retired attempt cannot settle its replacement
      const row = attachedRows.find((r) => r.id === id);
      if (row === undefined) return; // removed mid-flight — drop the tick

      row.progress = p.total > 0 ? p.sent / p.total : 0;
      if (p.error !== undefined) {
        row.phase = 'failed';
        row.error = p.error;
        destroyEngine(id);
      } else if (p.recordId !== undefined && p.recordId.length > 0) {
        // ⛔ ATTACHED ONLY ON A RECORD ID. `phase: 'done'` without one would
        // mean the server has the bytes but named no record — nothing to
        // send, so it must not read as attached.
        row.file_id = p.recordId;
        row.phase = 'attached';
        row.progress = 1;
        destroyEngine(id);
      }
      if (rows === attachedRows) deps.onChange();
    });
    engine.start(file);
    if (rows === attachedRows) deps.onChange();
    return id;
  };

  return {
    activateDraft(draftId) {
      if (rows.length === 0) drafts.delete(activeDraftId);
      activeDraftId = draftId;
      rows = drafts.get(draftId) ?? [];
      drafts.set(draftId, rows);
    },
    moveDraft(from, to) {
      const moved = drafts.get(from);
      drafts.delete(from);
      if (moved) drafts.set(to, moved);
      if (activeDraftId === from) activeDraftId = to;
    },
    discardDraft(draftId) {
      for (const row of drafts.get(draftId) ?? []) { destroyEngine(row.id); recoveryIds.delete(row.id); }
      drafts.delete(draftId);
      if (activeDraftId === draftId) {
        rows = [];
        drafts.set(draftId, rows);
      }
    },
    hasDraft: draftId => (drafts.get(draftId)?.length ?? 0) > 0,
    hasDrafts: () => [...drafts.values()].some(draft => draft.length > 0),
    attach(file, draftId = activeDraftId) {
      if (!deps.callers || !deps.connect) return;
      const attachedRows = drafts.get(draftId) ?? [];
      drafts.set(draftId, attachedRows);
      return startUpload(file, attachedRows);
    },
    retry(id, file) {
      const owner = [...drafts.values()].find(draft => draft.some(row => row.id === id));
      return owner ? startUpload(file, owner, id) : undefined;
    },
    restore(files, draftId = activeDraftId) {
      const restoredRows = drafts.get(draftId) ?? [];
      drafts.set(draftId, restoredRows);
      for (const file of files) {
        if (restoredRows.some(row => row.file_id === file.file_id && row.selection_revision === file.selection_revision)) continue;
        restoredRows.push({ id: nextId++, file_id: file.file_id,
          filename: file.filename ?? (file.media_class === 'image' ? 'Image attachment'
            : file.media_class === 'voice' ? 'Audio attachment' : 'Attachment'),
          ...(file.selection_revision !== undefined ? { selection_revision: file.selection_revision } : {}),
          media_class: file.media_class, phase: 'attached', progress: 1 });
      }
      if (restoredRows === rows) deps.onChange();
    },
    rows: () => rows,
    payload: (draftId = activeDraftId) =>
      (drafts.get(draftId) ?? [])
        .filter((r): r is ComposerAttachmentRow & { file_id: string } =>
          r.phase === 'attached' && typeof r.file_id === 'string')
        .map((r) => ({ file_id: r.file_id, media_class: r.media_class, filename: r.filename,
          ...(r.selection_revision !== undefined ? { selection_revision: r.selection_revision } : {}) })),
    recoveryUploads: (draftId = activeDraftId) => (drafts.get(draftId) ?? [])
      .filter(row => row.phase !== 'attached')
      .map(row => {
        const id = recoveryIds.get(row.id) ?? crypto.randomUUID();
        recoveryIds.set(row.id, id);
        return { id, filename: row.filename, media_class: row.media_class };
      }),
    restoreInterrupted(uploads, draftId = activeDraftId) {
      const restoredRows = drafts.get(draftId) ?? [];
      drafts.set(draftId, restoredRows);
      for (const upload of uploads) {
        if (restoredRows.some(row => recoveryIds.get(row.id) === upload.id)) continue;
        const id = nextId++;
        recoveryIds.set(id, upload.id);
        restoredRows.push({ id, filename: upload.filename, media_class: upload.media_class,
          phase: 'needs-file', progress: 0 });
      }
      if (restoredRows === rows) deps.onChange();
    },
    hasUnfinished: () => rows.some(row => row.phase !== 'attached'),
    hasInFlight: () => rows.some((r) => r.phase === 'uploading'),
    remove(id) {
      const owner = [...drafts.values()].find(draft => draft.some(row => row.id === id));
      if (!owner) return;
      const at = owner.findIndex((r) => r.id === id);
      if (at === -1) return;
      destroyEngine(id);
      owner.splice(at, 1);
      recoveryIds.delete(id);
      if (owner === rows) deps.onChange();
    },
    clear() {
      for (const row of rows) { destroyEngine(row.id); recoveryIds.delete(row.id); }
      rows.length = 0;
      deps.onChange();
    },
    destroy() {
      for (const id of [...engines.keys()]) destroyEngine(id);
      rows.length = 0;
      drafts.clear();
      recoveryIds.clear();
    },
  };
};
