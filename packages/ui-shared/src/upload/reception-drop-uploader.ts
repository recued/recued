/** Reception drop-link resumable uploader — the bundled client (D-172 step 5b).
 *
 *  Progressive enhancement of the server-rendered, JS-FREE single-POST drop
 *  `<form>`: when this bundle loads (one SRI-pinned, nonce'd `<script>` under the
 *  drop page's strict CSP — step 5c), it intercepts the form submit and drives a
 *  RESUMABLE upload instead — the shared engine over the HTTP transport
 *  (fetch-per-chunk) + reception HTTP callers. If the script never loads (no JS /
 *  CSP-blocked / older browser) the plain `<form>` still uploads in one POST, so
 *  resume is strictly additive.
 *
 *  Two exported pieces:
 *   - `createReceptionUploadCallers` — the CONTROL plane over `fetch` (create /
 *     probe / finalize / delete), mapping the reception HTTP protocol onto the
 *     engine's `UploadCallers` shapes (form_nonce on create, visitor PII on
 *     finalize, reception reject codes → throw). Pure + headless-testable.
 *   - `mountReceptionDropUploader` — the DOM glue (find the form, wire submit,
 *     render CSP-safe progress). Self-mounts at the bottom when bundled.
 *
 *  Protocol: `backend/server/src/ports/reception/handlers/drop-upload.ts`.
 *  Progress is rendered WITHOUT inline `style=` attributes (the drop page's CSP
 *  is `style-src 'self'` — no `unsafe-inline`); the bar fill width is set through
 *  the CSSOM (`el.style.width`), which CSP does not gate.
 */

import { createUploadEngine } from './engine.js';
import { createHttpUploadTransport } from './http-transport.js';
// rpc-shape types only — `import type` is erased, so the reception bundle never
// pulls a runtime value (or the barrel) from `@recued/contracts`.
import type {
  UploadCreateRpcResponse,
  UploadDeleteRpcResponse,
  UploadFinalizeRpcResponse,
  UploadProbeRpcResponse,
} from '@recued/contracts';
import type {
  UploadCallers,
  UploadFetch,
  UploadHandle,
  UploadProgress,
} from './types.js';

// ────────────────────────────────────────────────────────────────
// Control plane — reception HTTP callers
// ────────────────────────────────────────────────────────────────

/** Visitor-typed fields that ride FINALIZE (sealed there, exactly as the
 *  single-POST path), read fresh from the form at finalize time. */
export interface ReceptionVisitorFields {
  readonly visitor_name?: string;
  readonly visitor_email?: string;
  readonly visitor_description?: string;
}

export interface ReceptionUploadCallersOptions {
  /** Absolute path to the upload collection, e.g. `/reception/drop/<id>/uploads`
   *  (NO query string; the bearer is appended per request). */
  readonly uploadsBase: string;
  /** The drop link's bearer secret (the `?t=` value off the form action). */
  readonly token: string;
  /** Single-use form-nonce — read fresh per `create` (the hidden field's current
   *  value), consumed server-side as the CSRF + admission gate. */
  readonly getFormNonce: () => string;
  /** Visitor PII snapshot — read at `finalize` time. */
  readonly getVisitorFields: () => ReceptionVisitorFields;
  /** `fetch` impl. Default `globalThis.fetch`. */
  readonly fetchImpl?: UploadFetch;
}

const jsonHeaders = { 'content-type': 'application/json' } as const;

const defaultFetch: UploadFetch = (url, init) =>
  globalThis.fetch(url, init as RequestInit | undefined);

/** Read `error.code` (a string) from a JSON error body — `'failed'` fallback. */
const bodyErrorCode = (body: unknown): string => {
  if (typeof body === 'object' && body !== null) {
    const err = (body as { error?: unknown }).error;
    if (typeof err === 'object' && err !== null) {
      const code = (err as { code?: unknown }).code;
      if (typeof code === 'string') return code;
    }
  }
  return 'failed';
};

const readJson = async (res: { json(): Promise<unknown> }): Promise<unknown> => {
  try {
    return await res.json();
  } catch {
    return null;
  }
};

/** The reception control plane as the engine's `UploadCallers`. Success +
 *  resumable outcomes map onto the engine's shapes; a TERMINAL reception
 *  rejection (bad nonce, magic-byte/MIME/size/filename/domain reject) THROWS —
 *  the engine's create/finalize try/catch turns it into a terminal `error`
 *  phase carrying the reception code. `delete` is best-effort (the engine
 *  swallows its errors). */
export const createReceptionUploadCallers = (
  opts: ReceptionUploadCallersOptions,
): UploadCallers => {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const t = encodeURIComponent(opts.token);
  const sessionUrl = (uploadId: string): string => `${opts.uploadsBase}/${encodeURIComponent(uploadId)}?t=${t}`;

  return {
    async create(req): Promise<UploadCreateRpcResponse> {
      const res = await fetchImpl(`${opts.uploadsBase}?t=${t}`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          filename: req.filename,
          declared_size: req.declared_size,
          mime_reported: req.mime_reported,
          form_nonce: opts.getFormNonce(),
          ...(req.fingerprint != null ? { fingerprint: req.fingerprint } : {}),
        }),
      });
      const body = await readJson(res);
      if (res.status === 201) {
        const upload_id = (body as { upload_id?: unknown } | null)?.upload_id;
        if (typeof upload_id === 'string') return { status: 'created', upload_id };
        throw new Error('bad_create_response');
      }
      // invalid_nonce / daily_cap / size_cap_exceeded / too_many_sessions /
      // pending_bytes_exceeded / not_configured … — terminal, surface the code.
      throw new Error(bodyErrorCode(body));
    },

    async probe(req): Promise<UploadProbeRpcResponse> {
      const url =
        `${sessionUrl(req.upload_id)}` +
        `&filename=${encodeURIComponent(req.filename)}` +
        `&declared_size=${encodeURIComponent(String(req.declared_size))}` +
        (req.fingerprint != null ? `&fingerprint=${encodeURIComponent(req.fingerprint)}` : '');
      const res = await fetchImpl(url, { method: 'GET' });
      const body = await readJson(res);
      if (res.ok) {
        const b = body as { offset?: unknown; complete?: unknown } | null;
        if (b !== null && typeof b.offset === 'number' && typeof b.complete === 'boolean') {
          return { resumable: true, offset: b.offset, complete: b.complete };
        }
        throw new Error('bad_probe_response');
      }
      if (res.status === 410) return { resumable: false, reason: 'expired' };
      if (res.status === 409) return { resumable: false, reason: 'file_mismatch' };
      if (res.status === 404) return { resumable: false, reason: 'not_found' };
      throw new Error(bodyErrorCode(body));
    },

    async finalize(req): Promise<UploadFinalizeRpcResponse> {
      const visitor = opts.getVisitorFields();
      const res = await fetchImpl(`${opts.uploadsBase}/${encodeURIComponent(req.upload_id)}/finalize?t=${t}`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          ...(visitor.visitor_name ? { visitor_name: visitor.visitor_name } : {}),
          ...(visitor.visitor_email ? { visitor_email: visitor.visitor_email } : {}),
          ...(visitor.visitor_description
            ? { visitor_description: visitor.visitor_description }
            : {}),
        }),
      });
      const body = await readJson(res);
      if (res.ok) {
        // 200 { status:'accepted', blob_id } — map onto the engine's `finalized`.
        const blob_id = (body as { blob_id?: unknown } | null)?.blob_id;
        return {
          status: 'finalized',
          record_id: typeof blob_id === 'string' ? blob_id : '',
          content_hash: '',
          size_bytes: 0,
        };
      }
      if (res.status === 409) {
        // incomplete — the server's offset wins; the engine resumes.
        const off = (body as { offset?: unknown } | null)?.offset;
        return { status: 'pending', reason: 'incomplete', offset: typeof off === 'number' ? off : 0 };
      }
      if (res.status === 410) return { status: 'gone', reason: 'expired' };
      if (res.status === 404) return { status: 'gone', reason: 'not_found' };
      // 415 rejected_mime / 413 rejected_size / 400 rejected_filename|domain /
      // 422 failed — terminal content rejection; surface the code.
      throw new Error(bodyErrorCode(body));
    },

    async delete(req): Promise<UploadDeleteRpcResponse> {
      const res = await fetchImpl(sessionUrl(req.upload_id), { method: 'DELETE' });
      const body = await readJson(res);
      const deleted = (body as { deleted?: unknown } | null)?.deleted;
      return { deleted: deleted === true };
    },
  };
};

// ────────────────────────────────────────────────────────────────
// DOM bootstrap — progressive-enhance the drop form
// ────────────────────────────────────────────────────────────────

export interface MountReceptionDropUploaderOptions {
  /** Search root — default `document`. */
  readonly root?: ParentNode;
  /** `fetch` impl — default `globalThis.fetch`. */
  readonly fetchImpl?: UploadFetch;
  /** Bytes per chunk. Default = the engine default (4 MiB), comfortably above
   *  the server's 256 KiB non-final floor + under its 16 MiB ceiling. */
  readonly chunkBytes?: number;
}

const fmtMiB = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

/** A CSP-safe progress region built with the DOM API (no innerHTML, no inline
 *  `style=` attributes — the bar width is set through the CSSOM). Styled by the
 *  `rcp-upload-*` classes in the reception stylesheet. */
const buildProgressView = (doc: Document) => {
  const wrap = doc.createElement('div');
  wrap.className = 'rcp-upload-progress';
  wrap.setAttribute('aria-live', 'polite');

  const bar = doc.createElement('div');
  bar.className = 'rcp-upload-bar';
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  const fill = doc.createElement('div');
  fill.className = 'rcp-upload-bar-fill';
  bar.appendChild(fill);

  const status = doc.createElement('p');
  status.className = 'rcp-upload-status';

  wrap.appendChild(bar);
  wrap.appendChild(status);

  return {
    el: wrap,
    update(p: UploadProgress): void {
      if (p.phase === 'done') {
        fill.style.width = '100%';
        bar.setAttribute('aria-valuenow', '100');
        status.textContent = 'Upload received ✓';
        wrap.setAttribute('data-state', 'done');
        return;
      }
      if (p.phase === 'error') {
        status.textContent = `Upload failed${p.error ? `: ${p.error}` : ''}. Reload the page to try again.`;
        wrap.setAttribute('data-state', 'error');
        return;
      }
      const pct = p.total > 0 ? Math.min(100, Math.round((p.sent / p.total) * 100)) : 0;
      fill.style.width = `${pct}%`;
      bar.setAttribute('aria-valuenow', String(pct));
      status.textContent =
        p.phase === 'finalizing'
          ? 'Finalizing…'
          : `${pct}% · ${fmtMiB(p.sent)}/${fmtMiB(p.total)} MiB`;
      wrap.setAttribute('data-state', 'uploading');
    },
  };
};

const fieldValue = (form: ParentNode, name: string): string | undefined => {
  const el = form.querySelector(`[name="${name}"]`) as
    | { value?: unknown }
    | null;
  const v = el?.value;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
};

/** Find the drop form + wire resumable upload over its submit. Returns a handle
 *  (or `null` when the form / file input is absent — the no-JS form stays the
 *  upload path). */
export const mountReceptionDropUploader = (
  opts: MountReceptionDropUploaderOptions = {},
): UploadHandle | null => {
  const root = opts.root ?? (typeof document !== 'undefined' ? document : null);
  if (root === null || typeof (root as ParentNode).querySelector !== 'function') return null;

  const form = root.querySelector('form.rcp-form') as HTMLFormElement | null;
  if (form === null) return null;
  const fileInput = form.querySelector('input[type="file"][name="blob"]') as HTMLInputElement | null;
  if (fileInput === null) return null;

  const action = form.getAttribute('action');
  if (!action) return null;
  // Parse the action for the bearer + the endpoint path. The action is an
  // absolute PATH (`/reception/drop/<id>?t=…`), so the placeholder base only
  // satisfies the URL parser; we rebuild RELATIVE (same-origin) request paths.
  let token = '';
  let uploadsBase = '';
  try {
    const u = new URL(action, 'http://placeholder.invalid');
    token = u.searchParams.get('t') ?? '';
    uploadsBase = `${u.pathname}/uploads`;
  } catch {
    return null;
  }
  if (token.length === 0) return null;

  const doc = (form.ownerDocument ?? (typeof document !== 'undefined' ? document : null)) as
    | Document
    | null;
  if (doc === null) return null;

  // Snapshot the visitor fields when an upload STARTS (after the user filled the
  // form + clicked submit); finalize reads this snapshot, not live inputs (which
  // get disabled during the upload).
  let visitorSnapshot: ReceptionVisitorFields = {};

  const callers = createReceptionUploadCallers({
    uploadsBase,
    token,
    getFormNonce: () => fieldValue(form, 'form_nonce') ?? '',
    getVisitorFields: () => visitorSnapshot,
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const transport = createHttpUploadTransport({
    chunkUrl: (uploadId) => `${uploadsBase}/${encodeURIComponent(uploadId)}?t=${encodeURIComponent(token)}`,
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const engine = createUploadEngine({
    callers,
    transport,
    ...(opts.chunkBytes !== undefined ? { chunkBytes: opts.chunkBytes } : {}),
  });

  const progress = buildProgressView(doc);
  let mounted = false;
  let destroyed = false;

  const offProgress = engine.on('progress', (p) => {
    progress.update(p);
  });

  const onSubmit = (event: Event): void => {
    if (destroyed) return;
    const file = fileInput.files && fileInput.files.length > 0 ? fileInput.files[0] : null;
    // No file → let native validation / the plain form handle it (the file
    // input is `required`, so this is belt-and-suspenders).
    if (file === null || file === undefined) return;
    event.preventDefault();

    visitorSnapshot = {
      ...(fieldValue(form, 'visitor_name') !== undefined
        ? { visitor_name: fieldValue(form, 'visitor_name')! }
        : {}),
      ...(fieldValue(form, 'visitor_email') !== undefined
        ? { visitor_email: fieldValue(form, 'visitor_email')! }
        : {}),
      ...(fieldValue(form, 'visitor_description') !== undefined
        ? { visitor_description: fieldValue(form, 'visitor_description')! }
        : {}),
    };

    // Insert the progress region once (after the form) + lock the inputs so the
    // visitor can't re-submit or swap the file mid-upload.
    if (!mounted) {
      form.insertAdjacentElement('afterend', progress.el);
      mounted = true;
    }
    form.setAttribute('data-uploading', '');
    for (const el of Array.from(form.elements)) {
      (el as { disabled?: boolean }).disabled = true;
    }

    engine.start(file);
  };

  form.addEventListener('submit', onSubmit);

  return {
    rewire: () => {
      /* the reception form is server-rendered once + never re-painted, so
       * there's nothing to re-attach (unlike the webclient widget). */
    },
    destroy: () => {
      destroyed = true;
      offProgress();
      engine.destroy();
      form.removeEventListener('submit', onSubmit);
    },
  };
};

// Auto-mount when this module is the bundled drop-page entry. Guarded so a
// node/test import (no `document`) is inert — tests call
// `mountReceptionDropUploader` / `createReceptionUploadCallers` directly.
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      mountReceptionDropUploader();
    });
  } else {
    mountReceptionDropUploader();
  }
}
