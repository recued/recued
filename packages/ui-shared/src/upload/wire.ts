/** Shared resumable-upload widget — DOM glue (`wireUploadWidget`).
 *
 *  ATTACH-based, like ref-picker: the host renders the shell (via
 *  `renderUploadWidget`) inside its own markup; this function finds that shell
 *  and wires it. It never builds the shell from its own innerHTML, so it stays
 *  testable against a string-only fake DOM (it degrades to a no-op there).
 *
 *  The engine + the last progress tick live in THIS closure (not the DOM), so
 *  they survive a host re-paint: after the host overwrites its container's
 *  innerHTML, call `handle.rewire(root)` and the widget re-attaches + repaints
 *  the progress bar from state — an in-flight upload keeps running untouched.
 *
 *  Each engine tick repaints ONLY the progress region, leaving the file input
 *  alone so a mid-flight native picker / drag isn't disturbed.
 */

import { createUploadEngine } from './engine.js';
import { createWsUploadTransport } from './ws-transport.js';
import {
  UPLOAD_CANCEL_ATTR,
  UPLOAD_DROPZONE_ATTR,
  UPLOAD_INPUT_ATTR,
  UPLOAD_PROGRESS_ATTR,
  UPLOAD_SHELL_ATTR,
  renderUploadProgress,
} from './render.js';
import type {
  UploadEngine,
  UploadFile,
  UploadHandle,
  UploadProgress,
  WireUploadWidgetOptions,
} from './types.js';

/** Minimal structural views — duck-typed so the production DOM and the
 *  fake-DOM test harness both compose without pulling in lib.dom. */
interface ElementLike {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  querySelector(selector: string): ElementLike | null;
  addEventListener(type: string, fn: (event: EventLike) => void): void;
  removeEventListener(type: string, fn: (event: EventLike) => void): void;
  parentElement?: ElementLike | null;
  innerHTML?: string;
}
interface EventLike {
  target?: unknown;
  preventDefault?: () => void;
  dataTransfer?: { files?: ArrayLike<UploadFile> } | null;
}

export const wireUploadWidget = (
  root: ParentNode,
  opts: WireUploadWidgetOptions,
): UploadHandle => {
  const { config } = opts;

  // The widget's host injects a `connect` factory (the binary `/ws/upload`
  // socket); wrap it in the WS transport seam the engine now drives.
  const engine: UploadEngine = createUploadEngine({
    callers: opts.callers,
    transport: createWsUploadTransport({ connect: opts.connect }),
    ...(opts.digest !== undefined ? { digest: opts.digest } : {}),
    ...(opts.chunkBytes !== undefined ? { chunkBytes: opts.chunkBytes } : {}),
    ...(opts.store !== undefined ? { store: opts.store } : {}),
  });

  let shellEl: ElementLike | null = null;
  let inputEl: ElementLike | null = null;
  let dropzoneEl: ElementLike | null = null;
  let progressEl: ElementLike | null = null;
  let lastProgress: UploadProgress | null = null;
  let destroyed = false;
  const bound: Array<[ElementLike, string, (event: EventLike) => void]> = [];

  // ── DOM patch (surgical: only the progress region) ─────────────────
  const paint = (): void => {
    if (progressEl !== null && progressEl.innerHTML !== undefined) {
      progressEl.innerHTML = renderUploadProgress(lastProgress);
    }
    if (dropzoneEl !== null) {
      const busy =
        lastProgress !== null &&
        (lastProgress.phase === 'uploading' || lastProgress.phase === 'finalizing');
      setBoolAttr(dropzoneEl, 'data-busy', busy);
    }
  };

  const offProgress = engine.on('progress', (progress) => {
    lastProgress = progress;
    paint();
    if (progress.phase === 'done') opts.onDone?.(progress);
  });

  // ── start helpers ──────────────────────────────────────────────────
  const startFile = (file: UploadFile | null | undefined): void => {
    if (file === null || file === undefined) return;
    // A fresh pick supersedes a finished/failed run's resting status.
    lastProgress = null;
    engine.start(file);
  };

  const firstFile = (
    files: ArrayLike<UploadFile> | null | undefined,
  ): UploadFile | null =>
    files !== null && files !== undefined && files.length > 0 ? files[0]! : null;

  // ── event handlers ─────────────────────────────────────────────────
  const onInputChange = (event: EventLike): void => {
    const files = (event.target as { files?: ArrayLike<UploadFile> } | null)?.files;
    startFile(firstFile(files));
  };
  const onDragover = (event: EventLike): void => {
    prevent(event); // required so the subsequent `drop` fires
    dropzoneEl?.setAttribute('data-dragover', '');
  };
  const onDragleave = (): void => {
    dropzoneEl?.removeAttribute('data-dragover');
  };
  const onDrop = (event: EventLike): void => {
    prevent(event);
    dropzoneEl?.removeAttribute('data-dragover');
    startFile(firstFile(event.dataTransfer?.files));
  };
  const onClick = (event: EventLike): void => {
    if (closestWithAttr(event.target, UPLOAD_CANCEL_ATTR, shellEl) !== null) {
      prevent(event);
      engine.cancel();
      lastProgress = null;
      paint();
    }
  };

  // ── attach / detach ────────────────────────────────────────────────
  const detach = (): void => {
    for (const [el, type, fn] of bound) el.removeEventListener(type, fn);
    bound.length = 0;
  };

  const bind = (
    el: ElementLike,
    type: string,
    fn: (event: EventLike) => void,
  ): void => {
    el.addEventListener(type, fn);
    bound.push([el, type, fn]);
  };

  const attach = (searchRoot: ParentNode): void => {
    detach();
    const queryable = searchRoot as unknown as ElementLike;
    // Degrade on a root that can't be queried (a string-only test host /
    // surface): don't mount rather than throw.
    if (typeof queryable.querySelector !== 'function') {
      shellEl = inputEl = dropzoneEl = progressEl = null;
      return;
    }
    shellEl = queryable.querySelector(`[${UPLOAD_SHELL_ATTR}="${config.widgetId}"]`);
    if (shellEl === null) {
      inputEl = dropzoneEl = progressEl = null;
      return;
    }
    inputEl = shellEl.querySelector(`[${UPLOAD_INPUT_ATTR}]`);
    dropzoneEl = shellEl.querySelector(`[${UPLOAD_DROPZONE_ATTR}]`);
    progressEl = shellEl.querySelector(`[${UPLOAD_PROGRESS_ATTR}]`);
    if (inputEl !== null) bind(inputEl, 'change', onInputChange);
    if (dropzoneEl !== null) {
      bind(dropzoneEl, 'dragover', onDragover);
      bind(dropzoneEl, 'dragleave', onDragleave);
      bind(dropzoneEl, 'drop', onDrop);
    }
    // Cancel is delegated off the shell (the button repaints in/out).
    bind(shellEl, 'click', onClick);
    // Reconcile the freshly-rendered shell with our live progress.
    paint();
  };

  attach(root);

  return {
    rewire: (nextRoot: ParentNode) => {
      if (destroyed) return;
      attach(nextRoot);
    },
    destroy: () => {
      destroyed = true;
      offProgress();
      engine.destroy();
      detach();
    },
  };
};

// ── helpers ────────────────────────────────────────────────────────────

const prevent = (event: EventLike): void => {
  if (typeof event.preventDefault === 'function') event.preventDefault();
};

const setBoolAttr = (el: ElementLike, name: string, on: boolean): void => {
  if (on) el.setAttribute(name, '');
  else el.removeAttribute(name);
};

/** Walk up from `target` (inclusive) to `boundary` (inclusive), returning the
 *  first element carrying `attr`. */
const closestWithAttr = (
  target: unknown,
  attr: string,
  boundary: ElementLike | null,
): ElementLike | null => {
  let cur = isElementLike(target) ? target : null;
  while (cur !== null) {
    if (cur.getAttribute(attr) !== null) return cur;
    if (cur === boundary) break;
    cur = cur.parentElement ?? null;
  }
  return null;
};

const isElementLike = (value: unknown): value is ElementLike =>
  value !== null &&
  typeof value === 'object' &&
  typeof (value as { getAttribute?: unknown }).getAttribute === 'function';
