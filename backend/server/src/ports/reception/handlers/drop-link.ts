/** D-149 P7 § A.5.4 — `drop_link` packet handlers (GET + POST).
 *
 *  The pre-handler dispatcher in `handler.ts` already verified the
 *  bearer token, the per-IP rate limit, the post-verify daily cap, and
 *  that the cached registry row is enabled + non-revoked + non-expired.
 *  By the time these handlers run the request is authorized — the
 *  remaining work is:
 *
 *    GET (upload-form picker):
 *      1. Parse the stored `DropLinkConfig` blob.
 *      2. Build the redacted packet (strict-pick + reshape).
 *      3. Issue a per-render form-nonce (single-use; bound to endpoint).
 *      4. Render the upload form HTML in public mode.
 *
 *    POST (multipart/form-data upload):
 *      1. Parse the `multipart/form-data` body — fixed closed shape:
 *         `form_nonce` + optional `visitor_name` / `visitor_email` /
 *         `visitor_description` + `blob` (the file part).
 *      2. Single-use form-nonce consume (CSRF guard).
 *      3. Origin / Referer same-origin verify (CSRF guard).
 *      4. Per-form rolling-day cap check against the substrate per
 *         spec § A.5.4 line 779 + § DROP_BLOB_LIMITS default 50/day.
 *      5. Stream the blob to scratch while computing sha256 + size +
 *         head-bytes, then write it to the shared CAS BlobStore; abort
 *         + 413 if size_cap_bytes exceeded; abort + 415 if magic-byte
 *         detector disagrees with the visitor-reported MIME against
 *         the per-config allowlist; sanitize the filename
 *         (path-traversal defense per § T-16); persist the row.
 *      6. Encrypt visitor PII (name / email / description) via
 *         `drop-pii.ts` with AAD bound to `(endpoint_id, blob_id, field)`.
 *      7. Emit signed `drop_blob.received` audit row (one per blob per
 *         § N.3).
 *      8. Return the success page (200).
 *
 *  Spec § Must Hold I-7: blob bytes NEVER traverse Recued's cloud. The
 *  request thread streams visitor → user's server scratch → local CAS
 *  directly via `writeDropBlobStream`.
 *
 *  Spec § Must Hold I-12: visitor writes are async — the substrate
 *  persists the metadata row + returns success; engine-side reactive
 *  trigger fires the `data.file` entity creation + optional virus-scan
 *  recipe off-thread. */

import { randomBytes, randomUUID } from 'node:crypto';
import { verifyReceptionSameOrigin } from './same-origin.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createBoundedNonceStore } from '../../../bounded-nonce-store.js';
import { Readable } from 'node:stream';
import {
  DROP_LINK_DEFAULT_SUBMIT_BUTTON_LABEL,
  DROP_LINK_DEFAULT_SUCCESS_MESSAGE,
  DROP_LINK_VISITOR_DESCRIPTION_MAX,
  DROP_LINK_VISITOR_EMAIL_MAX,
  DROP_LINK_VISITOR_NAME_MAX,
  validateDropLinkConfig,
  validateDropLinkUpload,
  type DropLinkProcessingOutcome,
  type DropLinkUploadInput,
  type DropLinkUploadValidationFailure,
  type RedactedPacketBuildAuditEvent,
  type TrustFooterDeploymentMode,
  type VisitorReceiptFieldEcho,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import { buildReceptionPacket } from '../redacted-packet.js';
import { resolveReceptionTrustFooter } from './trust-footer.js';
import { resolveVisitorReceipt } from './visitor-receipt.js';
import {
  buildDropLinkPacketRawInput,
  buildDropLinkSourceView,
  parseDropLinkConfig,
} from '../transformations/drop-link.js';
import { sanitizeFilename, writeDropBlobStream } from '../drop-blob-storage.js';
import { sealDropBlobPiiField } from '../drop-pii.js';
import {
  renderDropLinkErrorHtml,
  renderDropLinkHtml,
  renderDropLinkPlaceholderHtml,
  renderDropLinkSuccessHtml,
  type DropLinkRenderInput,
} from './drop-link-render.js';
import {
  RECEPTION_DROP_UPLOADER_SRC,
  RECEPTION_DROP_UPLOADER_SRI,
} from '../static-assets.js';
import type { ReceptionEndpointContext } from '../redacted-packet.js';
import type { ReceptionKindHandler } from './types.js';
import type { PublicEndpointRegistryStore } from '../../../storage/public-endpoint-registry-store.js';
import type { DropBlobStore } from '../../../storage/reception-drop-store.js';
import type { BlobStore } from '../../../storage/blob-store.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Surrounding-fields cap. The blob itself has its own size_cap;
 *  surrounding text fields combined (name + email + description +
 *  form_nonce + boundary overhead) shouldn't exceed this. The handler
 *  parses these BEFORE the file part to enforce. */
const MAX_TEXT_FIELDS_BYTES = 16 * 1024;

/** Hard ceiling on the raw parse buffer BEFORE the file part starts
 *  streaming (the preamble + part headers + leading text fields). Past
 *  that point the file pump drains `buf` every iteration, so it stays
 *  bounded; before it, a body with no boundary or an unterminated header
 *  block would otherwise grow `buf` without limit (memory-exhaustion
 *  DoS). 1 MiB is far above any legitimate pre-file framing yet caps the
 *  flood. Exceeding it aborts the upload with 413. */
const MAX_PREFILE_BUFFER_BYTES = 1024 * 1024;

/** Form-nonce TTL — visitors have 30 minutes to upload after loading.
 *  Mirrors the intake_form nonce. */
export const DROP_LINK_NONCE_TTL_MS = 30 * 60 * 1000;

/** Bytes of entropy for the per-render CSP script nonce. Its own constant
 *  because it is a DIFFERENT thing from the single-use form nonce (which the
 *  shared bounded store now mints) — the two only ever coincidentally shared a
 *  size. */
const CSP_SCRIPT_NONCE_BYTES = 24;


// ────────────────────────────────────────────────────────────────
// Form-nonce store (in-memory, per-process)
// ────────────────────────────────────────────────────────────────

export interface DropLinkNonceStore {
  issue(endpoint_id: string, now: number): string;
  consume(endpoint_id: string, nonce: string, now: number): boolean;
}

/** ⚠ NO `maxPerScope`: the scope is `endpoint_id`, shared by every concurrent
 *  visitor to this door. A per-scope cap would let the Nth visitor evict the
 *  first visitor's nonce. See `bounded-nonce-store.ts`. */
export const createInMemoryDropLinkNonceStore = (): DropLinkNonceStore => {
  const store = createBoundedNonceStore<null>({ ttlMs: DROP_LINK_NONCE_TTL_MS });
  return {
    issue: (endpoint_id, now) => store.issue(endpoint_id, now, null),
    consume: (endpoint_id, nonce, now) =>
      store.consume(endpoint_id, nonce, now) !== null,
  };
};

// ────────────────────────────────────────────────────────────────
// Response helpers
// ────────────────────────────────────────────────────────────────

/** D-172 step 5c — the drop page's Content-Security-Policy, delivered via the
 *  RESPONSE HEADER (nonces are robust in the header, spotty in `<meta>`). The
 *  full strict policy minus `script-src`, which is parameterized: a per-render
 *  `'nonce-<random>'` admits ONLY the one SRI-pinned uploader `<script>` (the GET
 *  render), `'none'` on every JS-free page (success / error / placeholder). Any
 *  other script — inline OR same-origin without the nonce — stays blocked, so the
 *  page is inert to injection except the single uploader. */
const buildDropLinkCsp = (scriptNonce?: string): string => {
  const scriptSrc = scriptNonce !== undefined ? `'nonce-${scriptNonce}'` : `'none'`;
  return [
    `default-src 'self'`,
    `img-src 'self' http: https: data:`,
    `style-src 'self'`,
    `script-src ${scriptSrc}`,
    `frame-ancestors 'none'`,
    `base-uri 'none'`,
    `form-action 'self'`,
    `object-src 'none'`,
  ].join('; ');
};

const writeHtmlResponse = (
  res: ServerResponse,
  body: string,
  status = 200,
  scriptNonce?: string,
): void => {
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('content-security-policy', buildDropLinkCsp(scriptNonce));
  res.setHeader('cache-control', 'no-store');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('content-length', String(Buffer.byteLength(body, 'utf8')));
  res.end(body);
};

const writeErrorPage = (
  res: ServerResponse,
  display_name: string,
  message: string,
  status: number,
): void => {
  writeHtmlResponse(res, renderDropLinkErrorHtml({ display_name, message }), status);
};

// ────────────────────────────────────────────────────────────────
// Bearer extract (mirrors intake_form / dispatcher)
// ────────────────────────────────────────────────────────────────

const extractBearer = (req: IncomingMessage): string => {
  const url = new URL(req.url ?? '/', 'http://x');
  const q = url.searchParams.get('t');
  if (q && q.length > 0) return q;
  const headerToken = req.headers['x-recued-endpoint-token'];
  if (typeof headerToken === 'string' && headerToken.length > 0) return headerToken;
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  return '';
};

// ────────────────────────────────────────────────────────────────
// Origin / Referer verification (CSRF guard)
// ────────────────────────────────────────────────────────────────

const verifyOrigin = verifyReceptionSameOrigin;

// ────────────────────────────────────────────────────────────────
// Multipart split — small focused parser for the closed shape
// ────────────────────────────────────────────────────────────────

/** Extract the boundary token from the `content-type` header. Returns
 *  `null` for malformed / missing values; caller treats as 400. */
export const extractMultipartBoundary = (
  contentType: string | undefined,
): string | null => {
  if (typeof contentType !== 'string') return null;
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) return null;
  const m = /boundary=("([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return null;
  const raw = (m[2] ?? m[3] ?? '').trim();
  if (raw.length === 0 || raw.length > 70) return null;
  return raw;
};

interface PartHeaders {
  readonly name: string;
  readonly filename: string | null;
  readonly content_type: string | null;
}

/** Parse the header block of a single multipart part. Returns null on
 *  malformed headers / missing `name`. */
const parsePartHeaders = (raw: string): PartHeaders | null => {
  const lines = raw.split(/\r?\n/);
  let disposition: string | null = null;
  let content_type: string | null = null;
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'content-disposition') disposition = value;
    else if (key === 'content-type') content_type = value;
  }
  if (disposition === null) return null;
  const nameMatch = /name="([^"]*)"/i.exec(disposition);
  if (!nameMatch || !nameMatch[1]) return null;
  const filenameMatch = /filename="([^"]*)"/i.exec(disposition);
  return {
    name: nameMatch[1],
    filename: filenameMatch?.[1] ?? null,
    content_type: content_type,
  };
};

/** Streaming multipart split. Calls `onTextField` for each text field
 *  (buffered) + `onFilePart` ONCE for the first `name="blob"` file part
 *  (the substrate accepts a single file per upload).
 *
 *  The text-field buffer cap is the same `MAX_TEXT_FIELDS_BYTES` ceiling
 *  shared across all surrounding fields combined — exceeding it throws.
 *  The file part is delivered as a `Readable` so the caller can stream
 *  it directly to disk without buffering the full blob.
 *
 *  Single-file constraint: extra file parts after `blob` raise
 *  `extra_file_part`. Substrate-reserved field names rejected.
 *
 *  Reads from `req` directly. Caller is responsible for setting up
 *  `req.on('aborted')` defenses; the parser surfaces stream errors as
 *  exceptions. */
interface MultipartParseInput {
  readonly req: IncomingMessage;
  readonly boundary: string;
  readonly onTextField: (name: string, value: string) => void;
  readonly onFilePart: (input: {
    name: string;
    filename: string | null;
    content_type: string | null;
    stream: Readable;
  }) => Promise<void>;
}

const ALLOWED_TEXT_FIELD_NAMES: ReadonlySet<string> = new Set([
  'form_nonce',
  'visitor_name',
  'visitor_email',
  'visitor_description',
]);

const FILE_PART_NAME = 'blob' as const;

/** Find the index of `needle` in `haystack` starting at `from`. Returns
 *  -1 when not present. */
const findIndex = (haystack: Buffer, needle: Buffer, from: number): number => {
  return haystack.indexOf(needle, from);
};

/** Streaming-ish multipart parser. Buffers up to MAX_TEXT_FIELDS_BYTES
 *  for the leading text parts + treats the first `name="blob"` file
 *  part as a `Readable` so the caller streams directly to disk. The
 *  parser pulls subsequent file-part data from the underlying request
 *  stream as it arrives.
 *
 *  This is intentionally a focused parser for the closed shape D-149
 *  ships — not a general multipart implementation. Adding a new field
 *  requires touching ALLOWED_TEXT_FIELD_NAMES + this parser.
 *
 *  Algorithm:
 *    1. Buffer chunks until we hit the file part's header CRLF CRLF.
 *    2. Emit text-field callbacks for fields encountered before the
 *       file part.
 *    3. Wrap the remaining buffer + the rest of the stream in a
 *       Readable that yields blob bytes up to (but not including) the
 *       closing `\r\n--boundary` delimiter; pass to onFilePart.
 *    4. After onFilePart resolves, drain any trailing text-field
 *       segments + the closing `--boundary--` epilogue. */
export const parseMultipartUpload = async (input: MultipartParseInput): Promise<void> => {
  const { req, boundary, onTextField, onFilePart } = input;
  const delimiter = Buffer.from(`--${boundary}`, 'utf8');
  const crlf = Buffer.from('\r\n', 'utf8');
  const doubleCrlf = Buffer.from('\r\n\r\n', 'utf8');

  let buf: Buffer = Buffer.alloc(0);
  let textBytesSeen = 0;
  let fileEmitted = false;

  // Accumulate chunks until the first delimiter line; ignore preamble.
  const readUntil = (target: Buffer, fromHint = 0): number => {
    return findIndex(buf, target, fromHint);
  };

  // Sequential generator over multipart parts. We pull one chunk at a
  // time + advance `buf`. Helper closure used inside the main loop.
  const consumeText = (
    partBuf: Buffer,
    headers: PartHeaders,
  ): void => {
    if (!ALLOWED_TEXT_FIELD_NAMES.has(headers.name)) {
      throw new Error(`unknown_field:${headers.name}`);
    }
    textBytesSeen += partBuf.length;
    if (textBytesSeen > MAX_TEXT_FIELDS_BYTES) {
      throw new Error('text_fields_too_large');
    }
    onTextField(headers.name, partBuf.toString('utf8'));
  };

  // Pull next chunk into buf; resolves false at stream end.
  let streamEnded = false;
  let streamError: Error | null = null;
  const pendingDataResolvers: Array<() => void> = [];
  req.on('data', (chunk: Buffer) => {
    // Once the stream has ended or overflowed, stop buffering — otherwise
    // `buf` keeps growing on the bytes still in flight after the cap trips.
    if (streamEnded) return;
    buf = Buffer.concat([buf, chunk]);
    // Bound the pre-file accumulation: once the blob part is streaming the
    // pump drains `buf`, but until then (preamble / part headers / text
    // fields) an attacker could send unbounded bytes with no boundary. The
    // 1 MiB ceiling is ~16x a default socket read, so the fast parse loop
    // flips `fileEmitted` (lifting the cap) long before a legitimate upload
    // could reach it.
    if (!fileEmitted && buf.length > MAX_PREFILE_BUFFER_BYTES) {
      streamError = new Error('prefile_buffer_overflow');
      streamEnded = true;
      req.pause(); // stop the flood at the source
    }
    const resolvers = pendingDataResolvers.splice(0, pendingDataResolvers.length);
    for (const r of resolvers) r();
  });
  req.on('end', () => {
    streamEnded = true;
    const resolvers = pendingDataResolvers.splice(0, pendingDataResolvers.length);
    for (const r of resolvers) r();
  });
  req.on('error', (err) => {
    streamError = err instanceof Error ? err : new Error(String(err));
    streamEnded = true;
    const resolvers = pendingDataResolvers.splice(0, pendingDataResolvers.length);
    for (const r of resolvers) r();
  });
  const waitForData = async (): Promise<boolean> => {
    if (streamError) throw streamError;
    if (streamEnded) return false;
    await new Promise<void>((resolve) => pendingDataResolvers.push(resolve));
    if (streamError) throw streamError;
    return !(streamEnded && buf.length === 0);
  };

  // Skip preamble until we find the first delimiter.
  while (true) {
    const idx = readUntil(delimiter);
    if (idx >= 0) {
      buf = buf.slice(idx + delimiter.length);
      break;
    }
    if (streamEnded) throw new Error('no_initial_boundary');
    if (!(await waitForData())) {
      throw new Error('no_initial_boundary');
    }
  }

  // Each iteration: read the trailing `\r\n` after the delimiter, then
  // collect headers up to `\r\n\r\n`, then collect the body up to the
  // next delimiter prefixed by `\r\n`.
  while (true) {
    // Check for closing `--` immediately after the delimiter — denotes
    // the end of the multipart payload.
    while (buf.length < 2 && !streamEnded) await waitForData();
    if (buf.length >= 2 && buf[0] === 0x2d && buf[1] === 0x2d) {
      return; // final boundary
    }
    // Skip `\r\n` after the delimiter.
    while (buf.length < 2 && !streamEnded) await waitForData();
    if (buf.length < 2) throw new Error('malformed_part_header');
    if (buf[0] !== 0x0d || buf[1] !== 0x0a) {
      throw new Error('malformed_part_header');
    }
    buf = buf.slice(2);

    // Read part headers until `\r\n\r\n`.
    let headerEnd = -1;
    while (true) {
      headerEnd = findIndex(buf, doubleCrlf, 0);
      if (headerEnd >= 0) break;
      if (streamEnded) throw new Error('malformed_part_header');
      if (!(await waitForData())) {
        throw new Error('malformed_part_header');
      }
    }
    const headerRaw = buf.slice(0, headerEnd).toString('utf8');
    buf = buf.slice(headerEnd + doubleCrlf.length);
    const headers = parsePartHeaders(headerRaw);
    if (!headers) throw new Error('malformed_part_header');

    // Closing delimiter is `\r\n--boundary`; the leading CRLF is part
    // of the boundary syntax, NOT the body.
    const closingDelim = Buffer.concat([crlf, delimiter]);

    if (headers.name === FILE_PART_NAME) {
      if (fileEmitted) throw new Error('extra_file_part');
      fileEmitted = true;
      // Build a Readable that pumps body bytes (excluding the trailing
      // CRLF + delimiter) into the file writer. We emit chunks as they
      // are confirmed to NOT contain the closing delimiter; the residual
      // tail is held back so we don't emit a partial delimiter.
      const stream = new Readable({ read() { /* pull-based via close vars below */ } });
      let pumpDone = false;
      const pump = async (): Promise<void> => {
        try {
          while (!pumpDone) {
            const idx = findIndex(buf, closingDelim, 0);
            if (idx >= 0) {
              if (idx > 0) stream.push(buf.slice(0, idx));
              buf = buf.slice(idx + closingDelim.length);
              stream.push(null);
              pumpDone = true;
              break;
            }
            // No delimiter found — emit up to (buf.length - closingDelim.length)
            // bytes so we never split the delimiter across pushes.
            const safeEmit = buf.length - closingDelim.length;
            if (safeEmit > 0) {
              stream.push(buf.slice(0, safeEmit));
              buf = buf.slice(safeEmit);
            }
            if (streamEnded) {
              // No closing delimiter encountered → malformed; surface to
              // file callback via stream error.
              stream.destroy(new Error('truncated_multipart'));
              pumpDone = true;
              break;
            }
            await waitForData();
          }
        } catch (err) {
          stream.destroy(err instanceof Error ? err : new Error(String(err)));
        }
      };
      // Run pump concurrently; await the file-write callback completion.
      const pumpPromise = pump();
      await onFilePart({
        name: headers.name,
        filename: headers.filename,
        content_type: headers.content_type,
        stream,
      });
      await pumpPromise;
      continue;
    }

    // Text part — buffer until the closing delimiter. Codex review
    // P1 #1 fold (2026-05-13) — enforce the MAX_TEXT_FIELDS_BYTES
    // ceiling during the READ loop, not only after the part is fully
    // assembled. Without the in-loop check, an attacker can stream
    // arbitrarily many bytes without a closing delimiter + buffer
    // them in `buf` indefinitely (the closing-delimiter scan never
    // finds a match). The cap is enforced cumulatively across all
    // text parts so the worst-case memory footprint stays bounded.
    while (true) {
      const idx = findIndex(buf, closingDelim, 0);
      if (idx >= 0) {
        const part = buf.slice(0, idx);
        buf = buf.slice(idx + closingDelim.length);
        consumeText(part, headers);
        break;
      }
      // Hard cap — `buf` always carries the current text part's bytes
      // (file parts hand off to the streaming pump above, so this
      // branch only fires for text parts). A buf > MAX_TEXT_FIELDS_BYTES
      // means a single text part is oversize OR the closing delimiter
      // is being withheld; either way abort.
      if (textBytesSeen + buf.length > MAX_TEXT_FIELDS_BYTES) {
        throw new Error('text_fields_too_large');
      }
      if (streamEnded) throw new Error('truncated_multipart');
      if (!(await waitForData())) {
        throw new Error('truncated_multipart');
      }
    }
  }
};

// ────────────────────────────────────────────────────────────────
// GET handler
// ────────────────────────────────────────────────────────────────

export interface DropLinkGetHandlerDeps {
  readonly getStore: () => PublicEndpointRegistryStore;
  readonly getDropLinkNonceStore: () => DropLinkNonceStore;
  readonly now: () => number;
  readonly emitAudit?: (event: RedactedPacketBuildAuditEvent) => string | undefined;
  /** D-149 P12 § A.20.7 — deployment mode for the Public Trust Footer.
   *  Boot-constant derived in `bin.ts` from the public base URL host
   *  (`isProDdnsHost`). Absent ⇒ the handler renders no trust footer. */
  readonly receptionDeploymentMode?: TrustFooterDeploymentMode;
}

export const createDropLinkPacketHandler = (
  deps: DropLinkGetHandlerDeps,
): ReceptionKindHandler => {
  return async (req: IncomingMessage, res: ServerResponse, endpoint: ReceptionEndpointContext) => {
    const endpoint_id = endpoint.endpoint_id;
    if (!endpoint_id) {
      writeHtmlResponse(res, renderDropLinkPlaceholderHtml(), 503);
      return;
    }

    const row = deps.getStore().findById(endpoint_id);
    if (!row) {
      writeHtmlResponse(res, renderDropLinkPlaceholderHtml(), 503);
      return;
    }
    const config = parseDropLinkConfig(row.metadata);
    if (!config) {
      writeHtmlResponse(res, renderDropLinkPlaceholderHtml(), 503);
      return;
    }

    const now = deps.now();
    const source = buildDropLinkSourceView(config);
    const rawInput = buildDropLinkPacketRawInput(source);
    const opts: Parameters<typeof buildReceptionPacket>[3] = {
      now,
      randomToken: () => randomUUID(),
      ...(deps.emitAudit !== undefined ? { emitAudit: deps.emitAudit } : {}),
    };
    // Defense in depth — substrate strict-picks at packet build.
    buildReceptionPacket('drop_link_packet', rawInput, endpoint, opts);

    const nonce = deps.getDropLinkNonceStore().issue(endpoint_id, now);
    const bearer = extractBearer(req);

    // D-149 P12 § A.20.7 — resolve the Public Trust Footer (reads the
    // per-server toggle off the reception_page singleton).
    const trust_footer =
      deps.receptionDeploymentMode !== undefined
        ? resolveReceptionTrustFooter({
            store: deps.getStore(),
            deployment_mode: deps.receptionDeploymentMode,
          })
        : null;

    // D-172 step 5c — a fresh per-render CSP nonce admits the ONE SRI-pinned
    // resumable-uploader script (progressive enhancement over the JS-free form).
    // DISTINCT from `form_nonce` (the single-use anti-replay upload token above).
    const scriptNonce = randomBytes(CSP_SCRIPT_NONCE_BYTES).toString('base64');

    const renderInput: DropLinkRenderInput = {
      display_name: config.display_name,
      ...(config.instructions ? { instructions: config.instructions } : {}),
      visitor_name_requirement: config.required_visitor_fields.name,
      visitor_email_requirement: config.required_visitor_fields.email,
      visitor_description_requirement: config.required_visitor_fields.description,
      submit_button_label:
        config.submit_button_label ?? DROP_LINK_DEFAULT_SUBMIT_BUTTON_LABEL,
      size_cap_bytes: config.size_cap_bytes,
      allowed_mime_types: config.allowed_mime_types,
      endpoint_id,
      bearer_secret: bearer,
      form_nonce: nonce,
      trust_footer,
      uploader_script: {
        nonce: scriptNonce,
        src: RECEPTION_DROP_UPLOADER_SRC,
        integrity: RECEPTION_DROP_UPLOADER_SRI,
      },
    };

    writeHtmlResponse(res, renderDropLinkHtml(renderInput), 200, scriptNonce);
  };
};

// ────────────────────────────────────────────────────────────────
// POST upload handler
// ────────────────────────────────────────────────────────────────

export interface DropLinkUploadHandlerDeps {
  readonly getStore: () => PublicEndpointRegistryStore;
  readonly getDropBlobStore: () => DropBlobStore;
  readonly getBlobStore: () => BlobStore;
  readonly getDropLinkNonceStore: () => DropLinkNonceStore;
  readonly getDropBlobPiiKey: () => Uint8Array;
  readonly getDropBlobsRoot: () => string;
  readonly auditLog: AuditLogStore;
  readonly now: () => number;
  /** D-149 § A.20.3 / § A.20.7 — deployment mode for the Public Trust
   *  Footer carried in the Visitor Receipt's `privacy_footer` slot.
   *  Absent ⇒ the receipt renders without a privacy footer. */
  readonly receptionDeploymentMode?: TrustFooterDeploymentMode;
  /** D-149 § Must Hold I-5 — drop the visitor-facing registry-cache entry
   *  when a `one_time` link self-revokes on a clean upload. The rpc
   *  `endpoint.revoke` path fires `reception.endpoint_changed` →
   *  `registryCache.invalidate`; this in-handler revoke bypasses the bus,
   *  so without an explicit invalidate the dispatcher keeps serving the
   *  stale enabled entry (and accepting further uploads) for up to
   *  `REGISTRY_CACHE_STALENESS_MS` (60s) — defeating `one_time`. Absent ⇒
   *  the handler relies on the staleness ceiling alone. */
  readonly invalidateRegistryCache?: (endpoint_id: string) => void;
}

export const createDropLinkUploadHandler = (
  deps: DropLinkUploadHandlerDeps,
): ((req: IncomingMessage, res: ServerResponse, endpoint: ReceptionEndpointContext) => Promise<void>) => {
  return async (req, res, endpoint) => {
    const endpoint_id = endpoint.endpoint_id;
    if (!endpoint_id) {
      writeErrorPage(res, 'this drop link', 'Upload unavailable.', 503);
      return;
    }
    if (req.method !== 'POST') {
      writeErrorPage(res, 'this drop link', 'Method not allowed.', 405);
      return;
    }
    if (!verifyOrigin(req)) {
      writeErrorPage(res, 'this drop link', 'Upload blocked by origin policy.', 403);
      return;
    }

    const row = deps.getStore().findById(endpoint_id);
    if (!row) {
      writeErrorPage(res, 'this drop link', 'Upload unavailable.', 503);
      return;
    }
    const config = parseDropLinkConfig(row.metadata);
    if (!config) {
      writeErrorPage(res, 'this drop link', 'Upload unavailable.', 503);
      return;
    }
    const display_name = config.display_name;

    const boundary = extractMultipartBoundary(req.headers['content-type']);
    if (!boundary) {
      writeErrorPage(res, display_name, 'Upload must be multipart/form-data.', 400);
      return;
    }

    const now = deps.now();

    // Per-day cap pre-check. Substrate's per_endpoint_daily_cap kicks
    // in at the dispatcher; the per-config knob can clamp tighter (or
    // looser; the substrate-side default is 50/day). We re-check here
    // against the per-config `max_uploads_per_endpoint_per_day`.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const dayCount = deps.getDropBlobStore().countWithinWindow({
      endpoint_id,
      window_start_at: now - DAY_MS,
      now,
    });
    if (dayCount >= config.max_uploads_per_endpoint_per_day) {
      res.setHeader('Retry-After', '3600');
      writeErrorPage(
        res,
        display_name,
        'This drop link has hit its daily upload limit. Please try again tomorrow.',
        429,
      );
      return;
    }

    // Parse multipart — buffer the leading text fields + stream the
    // blob to disk while computing sha256 + size + magic-byte signature.
    //
    // Codex review P1 #2 fold (2026-05-13) — `form_nonce` is consumed
    // INSIDE `onTextField` as soon as it arrives. A well-formed POST
    // emits the hidden form_nonce field BEFORE the blob part (the
    // renderer places it first in the form), so a valid visitor flow
    // never streams the blob with a bad nonce. A crafted POST that
    // reorders parts to send the blob first is still safe: any failure
    // path (bad / missing / replayed nonce, oversize text field,
    // truncated stream) blows away the temp+final blob in the outer
    // cleanup below so no orphaned files survive on disk.
    const textFields: Record<string, string> = {};
    const blob_id = randomUUID();
    type WriteResult = Awaited<ReturnType<typeof writeDropBlobStream>>;
    let blobResult: WriteResult | null = null;
    let blobMimeReported: string | null = null;
    let blobFilenameRaw: string | null = null;
    let parseError: { code: 'parse'; message: string; status: number } | null = null;
    let nonceConsumed = false;
    try {
      await parseMultipartUpload({
        req,
        boundary,
        onTextField: (name, value) => {
          if (name === 'visitor_name' && value.length > DROP_LINK_VISITOR_NAME_MAX) {
            throw new Error('visitor_name_too_long');
          }
          if (name === 'visitor_email' && value.length > DROP_LINK_VISITOR_EMAIL_MAX) {
            throw new Error('visitor_email_too_long');
          }
          if (
            name === 'visitor_description' &&
            value.length > DROP_LINK_VISITOR_DESCRIPTION_MAX
          ) {
            throw new Error('visitor_description_too_long');
          }
          if (name === 'form_nonce') {
            if (nonceConsumed) throw new Error('duplicate_form_nonce');
            const ok = deps.getDropLinkNonceStore().consume(endpoint_id, value, now);
            nonceConsumed = true;
            if (!ok) throw new Error('invalid_form_nonce');
          }
          textFields[name] = value;
        },
        onFilePart: async (part) => {
          // Require the single-use form_nonce part BEFORE the blob part. The
          // renderer always emits form_nonce first, so a legitimate visitor
          // passes; a crafted blob-first POST is rejected HERE — before the
          // bytes are streamed into the CAS — so a bad/absent nonce can no
          // longer orphan a CAS blob (the prior behavior left it for sweep).
          if (!nonceConsumed) throw new Error('nonce_required_before_blob');
          blobMimeReported = part.content_type ?? '';
          blobFilenameRaw = part.filename;
          blobResult = await writeDropBlobStream(part.stream, {
            drop_blobs_root: deps.getDropBlobsRoot(),
            blobs: deps.getBlobStore(),
            size_cap_bytes: config.size_cap_bytes,
            now,
          });
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'size_cap_exceeded') {
        parseError = { code: 'parse', message: 'Upload exceeded the size cap.', status: 413 };
      } else if (message === 'text_fields_too_large' || message === 'prefile_buffer_overflow') {
        parseError = { code: 'parse', message: 'Upload metadata too large.', status: 413 };
      } else if (
        message === 'visitor_name_too_long' ||
        message === 'visitor_email_too_long' ||
        message === 'visitor_description_too_long'
      ) {
        parseError = { code: 'parse', message: 'Upload metadata too long.', status: 400 };
      } else if (
        message === 'invalid_form_nonce' ||
        message === 'duplicate_form_nonce' ||
        message === 'nonce_required_before_blob'
      ) {
        parseError = {
          code: 'parse',
          message: 'This upload form is stale. Please reload the page and try again.',
          status: 400,
        };
      } else {
        parseError = { code: 'parse', message: 'Upload could not be parsed.', status: 400 };
      }
    }

    if (parseError) {
      writeErrorPage(res, display_name, parseError.message, parseError.status);
      return;
    }
    if (!blobResult) {
      writeErrorPage(res, display_name, 'Upload missing a file part.', 400);
      return;
    }
    if (!nonceConsumed) {
      // Reached the end of the multipart payload without ever seeing
      // form_nonce — treat as a stale / crafted POST. The CAS blob is
      // left for the D-172 caller-derived keep-set sweep rather than
      // deleted inline, because identical bytes may already be shared.
      writeErrorPage(
        res,
        display_name,
        'This upload form is stale. Please reload the page and try again.',
        400,
      );
      return;
    }
    const blob: WriteResult = blobResult;

    // Filename sanitize.
    const filename_sanitized = sanitizeFilename(blobFilenameRaw ?? '');
    if (filename_sanitized === null) {
      // Persist with `'rejected_filename'` to record the attempt in
      // Mary's abuse inbox; return a 400 so the visitor sees the
      // failure but the substrate retains the row.
      try {
        deps.getDropBlobStore().insert({
          blob_id,
          endpoint_id,
          uploaded_at: now,
          source_ip_hash: null,
          visitor_email_encrypted: null,
          visitor_name_encrypted: null,
          visitor_description_encrypted: null,
          filename_sanitized: '(rejected)',
          mime_type_reported: blobMimeReported ?? '',
          mime_type_detected: '',
          size_bytes: 0,
          content_hash: '',
          storage_path: '',
          processing_outcome: 'rejected_filename',
        });
      } catch {
        /* swallow */
      }
      writeErrorPage(res, display_name, 'Filename is invalid.', 400);
      return;
    }

    // Build the upload input + run the validator (covers MIME +
    // size + filename + visitor-field requirements).
    const uploadInput: DropLinkUploadInput = {
      ...(textFields.visitor_name ? { visitor_name: textFields.visitor_name } : {}),
      ...(textFields.visitor_email ? { visitor_email: textFields.visitor_email } : {}),
      ...(textFields.visitor_description
        ? { visitor_description: textFields.visitor_description }
        : {}),
      mime_type_reported: blobMimeReported ?? '',
      filename: filename_sanitized,
      size_bytes: blob.size_bytes,
    };
    const validationFailures = validateDropLinkUpload(uploadInput, config);

    // Magic-byte cross-check — server-detected MIME MUST match the
    // visitor-reported MIME AND be in the per-config allowlist. The
    // validator already gates the reported MIME against the allowlist;
    // the magic-byte detector adds a payload-vs-claim check (a
    // disguised .exe renamed .pdf fails here).
    const reported = blobMimeReported ?? '';
    const detected = blob.mime_detected;
    const magicMismatch =
      detected === null ||
      (reported.length > 0 && detected !== (reported as typeof detected));

    // Map first validation failure to a processing outcome the abuse
    // inbox can sort by.
    const outcomeFromFailure = (
      f: DropLinkUploadValidationFailure,
    ): DropLinkProcessingOutcome => {
      switch (f.code) {
        case 'size_cap_exceeded':
          return 'rejected_size';
        case 'mime_type_not_allowed':
          return 'rejected_mime';
        case 'filename_invalid':
          return 'rejected_filename';
        case 'visitor_email_domain_rejected':
          return 'rejected_domain';
        default:
          return 'failed';
      }
    };

    let outcome: DropLinkProcessingOutcome = 'pending';
    if (validationFailures.length > 0) {
      outcome = outcomeFromFailure(validationFailures[0]!);
    } else if (magicMismatch) {
      outcome = 'rejected_mime';
    }

    // Encrypt PII.
    const key = deps.getDropBlobPiiKey();
    const [
      visitor_email_encrypted,
      visitor_name_encrypted,
      visitor_description_encrypted,
    ] = await Promise.all([
      sealDropBlobPiiField({
        key,
        endpoint_id,
        blob_id,
        field: 'visitor_email',
        plaintext: textFields.visitor_email ?? null,
      }),
      sealDropBlobPiiField({
        key,
        endpoint_id,
        blob_id,
        field: 'visitor_name',
        plaintext: textFields.visitor_name ?? null,
      }),
      sealDropBlobPiiField({
        key,
        endpoint_id,
        blob_id,
        field: 'visitor_description',
        plaintext: textFields.visitor_description ?? null,
      }),
    ]);

    // Persist the metadata row regardless of outcome. Mary's abuse
    // inbox reads rejected outcomes for review; engine reactive
    // trigger fires only on `'pending'`.
    deps.getDropBlobStore().insert({
      blob_id,
      endpoint_id,
      uploaded_at: now,
      source_ip_hash: null, // dispatcher writes the per-IP hash to the access log
      visitor_email_encrypted,
      visitor_name_encrypted,
      visitor_description_encrypted,
      filename_sanitized,
      mime_type_reported: reported,
      mime_type_detected: detected ?? '',
      size_bytes: blob.size_bytes,
      content_hash: blob.content_hash,
      storage_path: blob.relative_path,
      scan_status: 'unscanned',
      processing_outcome: outcome,
    });

    // Signed `drop_blob.received` audit row per § N.3 (one per upload).
    try {
      await deps.auditLog.logActivity({
        activity_id: `drop_blob.received-${now}-${blob_id}`,
        timestamp: now,
        action: 'drop_blob.received',
        target: endpoint_id,
        detail: JSON.stringify({
          blob_id,
          processing_outcome: outcome,
          content_hash: blob.content_hash,
          size_bytes: blob.size_bytes,
          mime_type_reported: reported,
          mime_type_detected: detected,
        }),
        reserve: true,
      });
    } catch {
      // Audit failure must not block the success page — row is persisted.
    }

    // Validator failure surfaces a 400 with the first failure's detail
    // (matches the intake_form posture). Magic-mismatch + size-cap
    // outcomes also return error pages so the visitor sees the rejection.
    if (validationFailures.length > 0) {
      writeErrorPage(res, display_name, validationFailures[0]!.detail, 400);
      return;
    }
    if (magicMismatch) {
      writeErrorPage(res, display_name, 'Uploaded file type did not match what was declared.', 415);
      return;
    }

    // Codex review P1 #3 fold (2026-05-13) — when `link_kind === 'one_time'`
    // the endpoint MUST be revoked on a successful upload so the visitor
    // can't GET a fresh form_nonce + replay the bearer for a second
    // file. The revoke is gated on a clean upload (validation passed
    // + magic-byte match) so rejected attempts don't burn the link.
    // Revoke is idempotent at the registry (a second call with the
    // same endpoint_id stays a no-op). Audit failure on revoke is
    // surfaced via the registry store's own audit hook; the substrate
    // doesn't double-audit here.
    if (config.link_kind === 'one_time') {
      try {
        deps.getStore().revoke({
          endpoint_id,
          now,
          reason: 'one_time_drop_consumed',
        });
        // § Must Hold I-5 — drop the visitor-facing registry-cache entry
        // immediately. The store row is now revoked, but the dispatcher
        // gates every request on the in-memory registry cache; without
        // this invalidate a second visitor reads the stale enabled entry
        // for up to REGISTRY_CACHE_STALENESS_MS (60s) and uploads a
        // second blob onto a `one_time` link. Runs only after revoke
        // succeeds (so a revoke throw leaves the cache untouched).
        deps.invalidateRegistryCache?.(endpoint_id);
      } catch {
        // Revoke failure must not block the success page — the blob
        // is already persisted. Operators see the failure in the
        // registry-store error path.
      }
    }

    const successMessage = config.success_message ?? DROP_LINK_DEFAULT_SUCCESS_MESSAGE;

    // D-149 § A.20.3 — Visitor Receipt. Echoes the visitor-submitted
    // PII fields (verbatim) + the sanitized filename; `null` when the
    // endpoint's `visitor_receipt` config is absent / disabled. Reached
    // only on a clean upload (validator passed + magic-byte match).
    const fieldsEcho: VisitorReceiptFieldEcho[] = [];
    if (textFields.visitor_name) {
      fieldsEcho.push({ label: 'Name', value: textFields.visitor_name });
    }
    if (textFields.visitor_email) {
      fieldsEcho.push({ label: 'Email', value: textFields.visitor_email });
    }
    if (textFields.visitor_description) {
      fieldsEcho.push({ label: 'Description', value: textFields.visitor_description });
    }
    fieldsEcho.push({ label: 'File', value: filename_sanitized });
    const receipt = resolveVisitorReceipt({
      store: deps.getStore(),
      receptionDeploymentMode: deps.receptionDeploymentMode,
      config: config.visitor_receipt,
      reference_id: blob_id,
      submitted_at: now,
      endpoint_kind: 'drop_link',
      fields_echo: fieldsEcho,
    });

    writeHtmlResponse(
      res,
      renderDropLinkSuccessHtml({
        display_name,
        success_message: successMessage,
        receipt,
      }),
      200,
    );
  };
};

// ────────────────────────────────────────────────────────────────
// Default fallback (deps-absent stub)
// ────────────────────────────────────────────────────────────────

/** Substrate-compatible default handler — registered in
 *  `handlers/index.ts`. The dispatcher in `handler.ts` re-binds the
 *  handler with deps at boot; this default is the deps-absent fallback
 *  + preserves the substrate-wide 503 JSON contract the P2 stub
 *  shipped. */
export const handleDropLinkPacket: ReceptionKindHandler = async (
  _req,
  res,
  _endpoint,
) => {
  res.statusCode = 503;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: { code: 'not_implemented' } }));
};

// Internal helper exposed for tests.
export { parseDropLinkConfig, validateDropLinkConfig };
