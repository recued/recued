/** D-345 slice B — the HTTP Toolkit's three actions: Get, Read and Download a web address, from the
 *  server, with no browser. Each fetches through `publicFetch` (public addresses only, nothing of the
 *  owner's sent), so what they reach is what anyone on the internet reaches.
 *
 *  - **Get** answers what the site answered: status, type, size, final address and headers; JSON
 *    parsed, text up to {@link GET_TEXT_CHARS}, and for anything else what it is (Download keeps it).
 *  - **Read** answers a page as readable text (`readableText`) in parts of {@link READ_PART_CHARS}.
 *  - **Download** keeps the file among the owner's files (the handoff of D-335 slice AP, origin
 *    `http_download`) and answers its ref, never its bytes. */
import type { BrowserFiles } from '../bridges/browser-files.js';
import { publicFetch, PublicFetchError, type PublicFetchOptions, type PublicFetchResult } from './public-fetch.js';
import { readableText } from './readable-text.js';

/** The most a Get or a Read fetches, decompressed: a page's HTML rarely passes it. */
export const PAGE_MAX_BYTES = 2_000_000;
/** The most a Download keeps: what `document.read` reads. */
export const DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;
/** How much of a text answer Get hands back. */
export const GET_TEXT_CHARS = 40_000;
/** One part of a page Read answers. */
export const READ_PART_CHARS = 40_000;
const PAGE_TIMEOUT_MS = 45_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** 2026-11-23 — how long a download waits with nothing new from the site, however long it may take in all: a site that
 *  stalled is let go in 20 s, not held to the end of its two minutes, while a large file still arriving keeps its time
 *  (`publicFetch`'s `idleTimeoutMs`; the owner, after task L's fix: "Same idle limit for the HTTP Toolkit's own download"). */
export const DOWNLOAD_IDLE_MS = 20_000;

/** What every action is given besides its input: tests stand a local server in for a site. */
export interface HttpActionDeps {
  readonly fetchOptions?: Pick<PublicFetchOptions, 'resolve' | 'treatAsPublic' | 'userAgent'>;
}

/** The owner's files, for a download to be kept among. */
export interface HttpDownloadDeps extends HttpActionDeps {
  readonly files: Pick<BrowserFiles, 'keep'>;
}

/** An action's refusal: its code and what the model is told. */
export class HttpActionError extends Error {
  constructor(readonly code: 'BAD_INPUT' | 'NOT_PUBLIC' | 'FETCH_FAILED' | 'TOO_LARGE' | 'NOT_TEXT', message: string) {
    super(message);
    this.name = 'HttpActionError';
  }
}

const addressOf = (input: { address?: unknown }): string => {
  if (typeof input.address !== 'string' || input.address.trim() === '') {
    throw new HttpActionError('BAD_INPUT', 'Give the web address to fetch, such as https://example.com/page.');
  }
  return input.address.trim();
};

const fetching = async (address: string, options: PublicFetchOptions): Promise<PublicFetchResult> => {
  try {
    return await publicFetch(address, options);
  } catch (error) {
    if (!(error instanceof PublicFetchError)) throw error;
    if (error.code === 'not_public') {
      throw new HttpActionError('NOT_PUBLIC', `${error.message} The server fetches public web addresses only: a page on your own `
        + 'network or one that needs you signed in is read in your browser, with the Browser Toolkit.');
    }
    if (error.code === 'bad_address') throw new HttpActionError('BAD_INPUT', error.message);
    if (error.code === 'too_large') throw new HttpActionError('TOO_LARGE', error.message);
    throw new HttpActionError('FETCH_FAILED', error.message);
  }
};

/** The MIME type a response gives, lower-cased, without its parameters. */
const essenceOf = (result: PublicFetchResult): string => (result.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();

const isJson = (essence: string) => essence === 'application/json' || essence.endsWith('+json');
const isText = (essence: string) => essence.startsWith('text/') || isJson(essence) || essence.endsWith('+xml')
  || ['application/xml', 'application/javascript', 'application/x-javascript', 'application/ecmascript', 'application/csv',
    'application/x-ndjson', 'application/yaml', 'application/x-yaml'].includes(essence);

/** The body as text, by the charset the response names, else UTF-8. */
const textOf = (result: PublicFetchResult): string => {
  const charset = /charset\s*=\s*"?([\w-]+)/i.exec(result.headers['content-type'] ?? '')?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(result.body);
  } catch {
    return new TextDecoder('utf-8').decode(result.body);
  }
};

/** The headers worth an answer: what the body is, how old, and where it was sent from. */
const HEADERS_ANSWERED = ['content-type', 'content-length', 'content-disposition', 'content-language', 'last-modified', 'etag',
  'cache-control', 'expires', 'retry-after', 'location', 'server'];
const answeredHeaders = (result: PublicFetchResult): Record<string, string> =>
  Object.fromEntries(HEADERS_ANSWERED.filter((name) => result.headers[name] !== undefined)
    .map((name) => [name, result.headers[name]!.slice(0, 300)]));

/** The size the site gives, else the bytes read. */
const sizeOf = (result: PublicFetchResult): number => {
  const declared = Number(result.headers['content-length']);
  return Number.isFinite(declared) && declared >= 0 ? declared : result.body.length;
};

/** Get a web address: what the site answers, as it answers it. */
export const httpGet = async (deps: HttpActionDeps, input: { address?: unknown; headers_only?: unknown }) => {
  const address = addressOf(input);
  const headersOnly = input.headers_only === true;
  const result = await fetching(address, { ...deps.fetchOptions, method: headersOnly ? 'HEAD' : 'GET', maxBytes: PAGE_MAX_BYTES,
    overflow: 'truncate', timeoutMs: PAGE_TIMEOUT_MS });
  const essence = essenceOf(result);
  const answer = { url: result.url, status: result.status, status_text: result.status_text, type: essence || 'unknown',
    size: sizeOf(result), headers: answeredHeaders(result), ...(result.redirects.length > 0 ? { redirected: true } : {}) };
  if (headersOnly) return answer;
  if (isText(essence) || essence === '') {
    const text = textOf(result);
    if (isJson(essence)) {
      try {
        if (!result.truncated) return { ...answer, json: JSON.parse(text) as unknown };
      } catch {
        // Not JSON after all: answered as text.
      }
    }
    const cut = text.length > GET_TEXT_CHARS || result.truncated;
    return { ...answer, text: text.slice(0, GET_TEXT_CHARS), ...(cut ? { truncated: true,
      note: `Only the first ${String(Math.min(text.length, GET_TEXT_CHARS))} characters are here: Read a web address reads a page in parts.` } : {}) };
  }
  return { ...answer, note: `This is a ${essence} file of ${String(sizeOf(result))} bytes, not text: Download a file from a web address `
    + 'keeps it among your files, to read or use from there.' };
};

/** Read a web address: a page as readable text, a part at a time from `from`. */
export const httpRead = async (deps: HttpActionDeps, input: { address?: unknown; from?: unknown }) => {
  const address = addressOf(input);
  const from = input.from === undefined ? 0 : Number(input.from);
  if (!Number.isSafeInteger(from) || from < 0) throw new HttpActionError('BAD_INPUT', '`from` is a character offset from 0, as `next` answers it.');
  const result = await fetching(address, { ...deps.fetchOptions, maxBytes: PAGE_MAX_BYTES, overflow: 'truncate',
    timeoutMs: PAGE_TIMEOUT_MS, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' });
  const essence = essenceOf(result);
  if (!isText(essence) && essence !== '') {
    throw new HttpActionError('NOT_TEXT', `${result.url} is a ${essence} file, not a page: Download a file from a web address keeps it `
      + 'among your files, where a reader for it takes it (a PDF\'s text with document.read).');
  }
  const html = essence === 'text/html' || essence === 'application/xhtml+xml' || essence === '';
  const { title, text } = html ? readableText(textOf(result), result.url) : { title: '', text: textOf(result) };
  if (from > text.length) throw new HttpActionError('BAD_INPUT', `The page has ${String(text.length)} characters; \`from\` is past its end.`);
  const end = Math.min(text.length, from + READ_PART_CHARS);
  return { url: result.url, status: result.status, ...(title ? { title } : {}), text: text.slice(from, end), from,
    next: end < text.length ? end : null, of: text.length, ...(result.truncated ? { cut_at_bytes: PAGE_MAX_BYTES } : {}) };
};

/** A file's name: what its site sends it as, else the last part of its address. */
export const filenameFor = (result: Pick<PublicFetchResult, 'headers' | 'url'>): string => {
  const decoded = (text: string): string => {
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  };
  const disposition = result.headers['content-disposition'] ?? '';
  const encoded = /filename\*\s*=\s*[\w-]+''([^;]+)/i.exec(disposition)?.[1];
  const quoted = /filename\s*=\s*"([^"]*)"/i.exec(disposition)?.[1] ?? /filename\s*=\s*([^;"]+)/i.exec(disposition)?.[1];
  let last = '';
  try {
    last = new URL(result.url).pathname.split('/').filter((part) => part !== '').pop() ?? '';
  } catch {
    last = '';
  }
  const name = (encoded !== undefined ? decoded(encoded.trim()) : quoted !== undefined ? quoted.trim() : decoded(last))
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim();
  return name === '' ? 'download' : name;
};

/** D-345 slice E — what the server's own fetch of a file's address found: the file; a page (most
 *  often a sign-in, where a file was linked); or nothing it could fetch (an address that is not
 *  public, an answer that is not a success, a site that did not answer in time). */
export type PublicFileOutcome =
  | { readonly kind: 'file'; readonly url: string; readonly bytes: Buffer; readonly filename: string; readonly mime_type: string }
  | { readonly kind: 'page'; readonly url: string }
  | { readonly kind: 'refused'; readonly reason: string };
export type PublicFileFetch = (address: string) => Promise<PublicFileOutcome>;

/** How long a step that saves a file waits, in all, for the server's own fetch before the Bridge fetches it. 120 s since
 *  2026-11-23, as the HTTP Toolkit's own download, where it was 60 s: task L's 12.5 MB file took 12 to 17 s on the owner's
 *  network, and a machine under load gave it up at 60 s while it was still arriving, leaving it to a Bridge that hands
 *  over 2.5 MB at most. */
export const SERVER_FIRST_TIMEOUT_MS = 120_000;
/** 2026-11-23 — and how long with nothing new from the site, as the HTTP Toolkit's own download: a fetch that stalled
 *  still falls to the Bridge quickly. */
export const SERVER_FIRST_IDLE_MS = DOWNLOAD_IDLE_MS;

/** D-345 slice E — the server's fetch of a file at a public address, for a step that saves one: the
 *  file, up to {@link DOWNLOAD_MAX_BYTES}, or why the Bridge should fetch it instead. Nothing of the
 *  owner's is sent, so a file behind a sign-in answers a page or a refusal, never the file. */
export const createPublicFileFetch = (fetchOptions: HttpActionDeps['fetchOptions'] = {}): PublicFileFetch => async (address) => {
  let fetched: PublicFetchResult;
  try {
    fetched = await publicFetch(address, { ...fetchOptions, maxBytes: DOWNLOAD_MAX_BYTES, overflow: 'fail',
      timeoutMs: SERVER_FIRST_TIMEOUT_MS, idleTimeoutMs: SERVER_FIRST_IDLE_MS });
  } catch (error) {
    return { kind: 'refused', reason: error instanceof Error ? error.message : String(error) };
  }
  if (fetched.status < 200 || fetched.status >= 300) {
    return { kind: 'refused', reason: `${fetched.url} answered ${String(fetched.status)}` };
  }
  const mime = essenceOf(fetched);
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return { kind: 'page', url: fetched.url };
  return { kind: 'file', url: fetched.url, bytes: fetched.body, filename: filenameFor(fetched),
    mime_type: mime === '' ? 'application/octet-stream' : mime };
};

/** Download a file from a web address into the owner's files. */
export const httpDownload = async (deps: HttpDownloadDeps, input: { address?: unknown },
  step: { run_id?: string; step_id?: string } = {}) => {
  const address = addressOf(input);
  const result = await fetching(address, { ...deps.fetchOptions, maxBytes: DOWNLOAD_MAX_BYTES, overflow: 'fail',
    timeoutMs: DOWNLOAD_TIMEOUT_MS, idleTimeoutMs: DOWNLOAD_IDLE_MS });
  if (result.status < 200 || result.status >= 300) {
    throw new HttpActionError('FETCH_FAILED', `${result.url} answered ${String(result.status)}${result.status_text ? ` ${result.status_text}` : ''}: `
      + 'nothing was kept.');
  }
  const mime = essenceOf(result) || 'application/octet-stream';
  const kept = await deps.files.keep({ bytes: result.body, filename: filenameFor(result), mime_type: mime, origin: 'http_download',
    ...(step.run_id !== undefined ? { run_id: step.run_id } : {}), ...(step.step_id !== undefined ? { step_id: step.step_id } : {}) });
  return { url: result.url, file_ref: kept.file_ref, filename: kept.filename, mime_type: kept.mime_type, size_bytes: kept.size_bytes,
    sha256: kept.sha256 };
};
