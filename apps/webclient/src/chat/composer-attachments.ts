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
 *  Finalized `data.file` ids ONLY. Bytes go up the binary socket and are never
 *  held here; reading them back is the separately-gated `data-file-read`. The
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

export interface ComposerAttachmentsDeps {
  callers: Upload.UploadCallers;
  connect: Upload.UploadConnectFactory;
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
  phase: 'uploading' | 'attached' | 'failed';
  /** 0–1, for the in-flight bar. */
  progress: number;
  error?: string;
}

export interface ComposerAttachments {
  attach(file: File): void;
  /** Rows to render, in the order they were added. */
  rows(): readonly ComposerAttachmentRow[];
  /** What rides on `chat.send` — finalized ids only. */
  payload(): ChatMessageAttachment[];
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
  const rows: ComposerAttachmentRow[] = [];
  // One engine per file: the engine models a single run, and a composer
  // legitimately climbs two files at once. Keyed by the row's stable id.
  const engines = new Map<number, Upload.UploadEngine>();
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

  return {
    attach(file) {
      const id = nextId++;
      rows.push({
        id,
        filename: file.name,
        media_class: mediaClassForBrowserFile(file.type),
        phase: 'uploading',
        progress: 0,
      });
      const engine = Upload.createUploadEngine({
        callers: deps.callers,
        transport: Upload.createWsUploadTransport({ connect: deps.connect }),
      });
      engines.set(id, engine);
      engine.on('progress', (p) => {
        const row = rows.find((r) => r.id === id);
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
        deps.onChange();
      });
      engine.start(file);
      deps.onChange();
    },
    rows: () => rows,
    payload: () =>
      rows
        .filter((r): r is ComposerAttachmentRow & { file_id: string } =>
          r.phase === 'attached' && typeof r.file_id === 'string')
        .map((r) => ({ file_id: r.file_id, media_class: r.media_class })),
    hasInFlight: () => rows.some((r) => r.phase === 'uploading'),
    remove(id) {
      const at = rows.findIndex((r) => r.id === id);
      if (at === -1) return;
      destroyEngine(id);
      rows.splice(at, 1);
      deps.onChange();
    },
    clear() {
      for (const id of [...engines.keys()]) destroyEngine(id);
      rows.length = 0;
      deps.onChange();
    },
    destroy() {
      for (const id of [...engines.keys()]) destroyEngine(id);
      rows.length = 0;
    },
  };
};
