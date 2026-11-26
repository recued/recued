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
 *  single-POST path), captured from the form at submit time. */
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
  readonly getFormNonce: () => string | Promise<string>;
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

/** A link-level 410 may be the dispatcher's HTML gone page. A session-level
 *  410 has the explicit `expired` code and can safely start a fresh session. */
const linkUnavailable = (status: number, code: string): boolean =>
  status === 401 || status === 403 || (status === 410 && code !== 'expired');

const finalizeRejections: Readonly<Record<string, number>> = {
  rejected_mime: 415,
  rejected_size: 413,
  rejected_filename: 400,
  rejected_domain: 400,
  failed: 422,
  day_cap: 429,
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
      const form_nonce = await opts.getFormNonce();
      const res = await fetchImpl(`${opts.uploadsBase}?t=${t}`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          filename: req.filename,
          declared_size: req.declared_size,
          mime_reported: req.mime_reported,
          form_nonce,
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
      const code = bodyErrorCode(body);
      throw new Error(linkUnavailable(res.status, code) ? 'link_unavailable' : code);
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
      if (linkUnavailable(res.status, bodyErrorCode(body))) throw new Error('link_unavailable');
      if (res.status === 410) return { resumable: false, reason: 'expired' };
      if (res.status === 409) return { resumable: false, reason: 'file_mismatch' };
      if (res.status === 404) return { resumable: false, reason: 'not_found' };
      throw new Error(bodyErrorCode(body));
    },

    async finalize(req): Promise<UploadFinalizeRpcResponse> {
      const visitor = opts.getVisitorFields();
      let res;
      try {
        res = await fetchImpl(`${opts.uploadsBase}/${encodeURIComponent(req.upload_id)}/finalize?t=${t}`, {
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
      } catch {
        // The server may have accepted the file and reaped the session before
        // the response was lost. Recreating it could deliver a second copy.
        throw new Error('confirmation_unknown');
      }
      const body = await readJson(res);
      if (res.ok) {
        // 200 { status:'accepted', blob_id } — map onto the engine's `finalized`.
        const accepted = body as { status?: unknown; blob_id?: unknown } | null;
        const blob_id = accepted?.blob_id;
        if (accepted?.status !== 'accepted' || typeof blob_id !== 'string' || blob_id.length === 0) {
          throw new Error('confirmation_unknown');
        }
        return {
          status: 'finalized',
          record_id: blob_id,
          content_hash: '',
          size_bytes: 0,
        };
      }
      const code = bodyErrorCode(body);
      if (res.status === 409 && code === 'incomplete') {
        // incomplete — the server's offset wins; the engine resumes.
        const off = (body as { offset?: unknown } | null)?.offset;
        if (typeof off !== 'number' || !Number.isSafeInteger(off) || off < 0) throw new Error('confirmation_unknown');
        return { status: 'pending', reason: 'incomplete', offset: off };
      }
      if (linkUnavailable(res.status, code)) throw new Error('link_unavailable');
      if (res.status === 410) return { status: 'gone', reason: 'expired' };
      if (res.status === 404 && code === 'not_found') return { status: 'gone', reason: 'not_found' };
      // 415 rejected_mime / 413 rejected_size / 400 rejected_filename|domain /
      // 422 failed — terminal content rejection; surface the code.
      if (finalizeRejections[code] === res.status || (res.status === 429 && code === 'rate_limited')) {
        throw new Error(code);
      }
      throw new Error('confirmation_unknown');
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

const failureMessage = (reason?: string): string => {
  switch (reason) {
    case 'confirmation_unknown':
      return 'We could not confirm whether your upload was received. Contact the sender before uploading again to avoid sending a duplicate.';
    case 'link_unavailable':
      return 'This upload link is no longer available. Ask the sender for a new link.';
    case 'daily_cap':
    case 'day_cap':
    case 'capacity_full':
      return 'This link has reached its daily upload limit. Try again later or contact the sender.';
    case 'rate_limited':
    case 'too_many_sessions':
    case 'pending_bytes_exceeded':
      return 'Uploads are temporarily busy. Wait a while, then try again.';
    case 'rejected_mime':
      return 'That file type is not accepted. Choose one of the file types listed above and upload again.';
    case 'size_cap_exceeded':
    case 'rejected_size':
      return 'That file is too large. Choose a smaller file within the limit listed above and upload again.';
    case 'rejected_filename':
      return 'That filename is not accepted. Rename the file, choose it again, and upload.';
    case 'rejected_domain':
      return 'That email domain is not accepted. Check your email address or contact the sender.';
    case 'invalid_nonce':
      return 'Your upload form has expired. Try again to refresh it without losing your details.';
    case 'expired':
    case 'not_found':
    case 'scratch_missing':
      return 'Your upload session has expired. Try again to start a new session with your details.';
    case 'connection_lost':
      return 'The connection was interrupted. Check your connection, then try again to resume your upload.';
    default:
      return 'The file could not be uploaded. Check your connection and try again, or contact the sender if it keeps failing.';
  }
};

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
  bar.setAttribute('aria-label', 'Upload progress');
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
        status.textContent = failureMessage(p.error);
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
  let nonceUsed = false;
  let destroyed = false;
  const fetchImpl = opts.fetchImpl ?? defaultFetch;

  const callers = createReceptionUploadCallers({
    uploadsBase,
    token,
    getFormNonce: async () => {
      if (destroyed) throw new Error('destroyed');
      if (!nonceUsed) {
        nonceUsed = true;
        return fieldValue(form, 'form_nonce') ?? '';
      }
      // A rejected create can also consume its nonce. Only fetch a fresh one
      // when the engine actually needs a new session; a resume needs none.
      const res = await fetchImpl(`${uploadsBase}?t=${encodeURIComponent(token)}`, { method: 'GET' });
      const body = await readJson(res);
      if (destroyed) throw new Error('destroyed');
      const code = bodyErrorCode(body);
      if (linkUnavailable(res.status, code)) throw new Error('link_unavailable');
      if (!res.ok) throw new Error(code);
      const nonce = (body as { form_nonce?: unknown } | null)?.form_nonce;
      if (typeof nonce !== 'string' || nonce.length === 0) throw new Error('invalid_nonce');
      const input = form.querySelector('[name="form_nonce"]') as HTMLInputElement | null;
      if (input) input.value = nonce;
      return nonce;
    },
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
  let state: 'ready' | 'uploading' | 'blocked' | 'done' = 'ready';
  const controls = Array.from(form.elements) as Array<Element & { disabled?: boolean }>;
  const originallyDisabled = new Map(controls.map(el => [el, el.disabled === true]));
  const submit = form.querySelector('[type="submit"]') as HTMLButtonElement | HTMLInputElement | null;
  const submitLabel = submit?.textContent ?? '';

  const unlock = (canRetry: boolean): void => {
    form.removeAttribute('data-uploading');
    for (const el of controls) el.disabled = originallyDisabled.get(el) === true;
    // Keep visitor details available to copy even when a new link or the
    // sender's confirmation is needed. Guard submission independently below.
    if (submit) {
      submit.disabled = !canRetry || originallyDisabled.get(submit) === true;
      if (canRetry) submit.textContent = 'Try again';
    }
  };

  const offProgress = engine.on('progress', (p) => {
    // Chunk failures arrive through the shared transport rather than these
    // reception callers. Give dispatcher authorization failures the same
    // terminal recovery policy in either path (session `expired` stays retryable).
    const error = ['gone', 'unauthorized', 'not_authorized', 'forbidden_origin'].includes(p.error ?? '')
      ? 'link_unavailable' : p.error;
    progress.update(error === 'link_unavailable' ? { ...p, error } : p);
    if (p.phase === 'error') {
      const canRetry = error !== 'confirmation_unknown' && error !== 'link_unavailable';
      state = canRetry ? 'ready' : 'blocked';
      unlock(canRetry);
    } else if (p.phase === 'done') {
      state = 'done';
    }
  });

  const onSubmit = (event: Event): void => {
    if (destroyed) return;
    if (state !== 'ready') {
      event.preventDefault();
      return;
    }
    const file = fileInput.files && fileInput.files.length > 0 ? fileInput.files[0] : null;
    // No file → let native validation / the plain form handle it (the file
    // input is `required`, so this is belt-and-suspenders).
    if (file === null || file === undefined) return;
    event.preventDefault();
    state = 'uploading';
    if (submit) submit.textContent = submitLabel;

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

    // Keep progress and recovery feedback beside the same submit control.
    if (!mounted) {
      (submit ?? form).insertAdjacentElement('afterend', progress.el);
      mounted = true;
    }
    form.setAttribute('data-uploading', '');
    for (const el of controls) el.disabled = true;

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
