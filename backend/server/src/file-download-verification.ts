/** Selected-file proof using the same byte resolvers as ordinary file reads. */
import { createHash } from 'node:crypto';
import { FILE_DOWNLOAD_VERIFICATION_MAX_BYTES, RpcError, type FileDownloadChoice, type FileMetaProjection,
  type FileSourceOAuthProvider } from '@recued/contracts';
import type { FileConnectionCredential, FileFetch, FileFetchResponse } from './file-source-adapters/index.js';
import { resolveFileBearerTransport } from './file-source-adapters/bearer-transport.js';
import { buildRemoteFileByteResolvers } from './collections/file/remote-byte-resolvers/index.js';
import { describeRemoteFileDownload } from './collections/file/remote-file-byte-resolver.js';

export const refuseFileDownload = (message: string): RpcError => new RpcError('credential_verification_failed',
  message + ' Saved authentication and file data were kept.', 422, 'collection.connection.managedOAuth',
  { verification_status: 'unknown', reason: 'file_download_access_unconfirmed', existing_credential_preserved: true });
const headerRecord = (headers: Headers): Record<string,string> => { const values: Record<string,string> = {}; headers.forEach((value,name) => { values[name] = value; }); return values; };
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const fileDownloadMetadataSignature = (meta: FileMetaProjection): string => hash(JSON.stringify([
  meta.provider, meta.remote_id, meta.filename, meta.path, meta.mime_type, meta.size, meta.mtime, meta.revision,
]));
const descriptors = buildRemoteFileByteResolvers();
export const fileDownloadChoice = (meta: FileMetaProjection): FileDownloadChoice => {
  const download = describeRemoteFileDownload(descriptors, meta); const exported = download.export_as;
  const invalidMime = meta.mime_type !== undefined && !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(meta.mime_type);
  const reason = download.unavailable_reason ?? (invalidMime ? 'Sync this source to refresh this file’s format before verifying it.' : undefined) ?? (!exported && meta.size !== undefined &&
    (!Number.isSafeInteger(meta.size) || meta.size > FILE_DOWNLOAD_VERIFICATION_MAX_BYTES) ? 'Choose a file no larger than 10 MiB.' : undefined);
  const label = meta.filename.replace(/[\x00-\x1f\x7f]/g, ' ').trim() || 'File';
  const path = meta.path?.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  return { remote_id: meta.remote_id, filename: label, output_filename: exported?.filename.replace(/[\x00-\x1f\x7f]/g,' ').trim() || label,
    ...(path ? {path} : {}),
    mode: exported ? 'export' : 'download', mime_type: exported?.mime_type ?? (invalidMime ? 'application/octet-stream' : meta.mime_type) ?? 'application/octet-stream',
    ...(Number.isSafeInteger(meta.size) && meta.size! >= 0 ? { size_bytes: meta.size } : {}), ...(reason ? { unavailable_reason: reason } : {}) };
};

/** Validate the Office package directory without extracting or decompressing untrusted bytes. */
const validOfficePackage = (bytes: Buffer, mime: string): boolean => {
  const part = ({
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'word/document.xml',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xl/workbook.xml',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'ppt/presentation.xml',
  } as Record<string,string>)[mime];
  if (!part || bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) return false;
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) break;
  }
  if (end < 0 || end < Math.max(0, bytes.length - 65557) || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) return false;
  const entries = bytes.readUInt16LE(end + 10); const length = bytes.readUInt32LE(end + 12); const directory = bytes.readUInt32LE(end + 16); let at = directory;
  if (entries < 3 || entries > 10000 || bytes.readUInt16LE(end + 8) !== entries || at + length !== end) return false;
  const names = new Set<string>();
  for (let i = 0; i < entries; i++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) return false;
    const nameLength = bytes.readUInt16LE(at + 28); const next = at + 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42); const compressed = bytes.readUInt32LE(at + 20);
    if (!nameLength || nameLength > 2048 || next > end || bytes.readUInt16LE(at + 8) & 1 || ![0,8].includes(bytes.readUInt16LE(at + 10))
      || local + 30 > directory || bytes.readUInt32LE(local) !== 0x04034b50
      || bytes.readUInt16LE(local + 6) !== bytes.readUInt16LE(at + 8) || bytes.readUInt16LE(local + 8) !== bytes.readUInt16LE(at + 10)) return false;
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const localLength = bytes.readUInt16LE(local + 26); const start = local + 30 + localLength + bytes.readUInt16LE(local + 28);
    if (names.has(name) || name.includes('\0') || name.includes('\\') || name.startsWith('/') || name.split('/').includes('..')
      || localLength !== nameLength || bytes.subarray(local + 30, local + 30 + localLength).toString('utf8') !== name || start + compressed > directory) return false;
    names.add(name); at = next;
  }
  return at === end && names.has('[Content_Types].xml') && names.has('_rels/.rels') && names.has(part);
};

const race = <T>(run: Promise<T>, signal: AbortSignal, discard?: (value: T) => void): Promise<T> => new Promise((resolve,reject) => {
  const stop = (): void => reject(refuseFileDownload('The file download/export check timed out.'));
  if (signal.aborted) { void run.then(v => discard?.(v), () => {}); stop(); return; }
  signal.addEventListener('abort', stop, { once:true });
  void run.then(v => { if (signal.aborted) discard?.(v); else resolve(v); }, reject).finally(() => signal.removeEventListener('abort',stop));
});
const discard = (response: FileFetchResponse): void => { void response.body?.cancel().catch(() => {}); };
const initialOrigin = (provider: FileSourceOAuthProvider): string => provider === 'google' ? 'https://www.googleapis.com'
  : provider === 'dropbox' ? 'https://content.dropboxapi.com' : provider === 'box' ? 'https://api.box.com' : 'https://graph.microsoft.com';
const signedDownload = (url: URL, provider: FileSourceOAuthProvider): boolean => {
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) return false;
  const suffixes = provider === 'google' ? ['googleusercontent.com'] : provider === 'box' ? ['boxcloud.com']
    : provider === 'dropbox' ? ['dropboxusercontent.com'] : ['1drv.com','sharepoint.com'];
  return suffixes.some(host => url.hostname === host || url.hostname.endsWith('.' + host));
};
export interface FileDownloadProof { choice: FileDownloadChoice; metadata: string; digest: string }
export const verifyFileSourceDownload = async (args: {
  provider: FileSourceOAuthProvider; meta: FileMetaProjection; cred: FileConnectionCredential;
  direct: FileFetch; assertActive(): Promise<void>; expected?: FileDownloadProof;
  /** Local test seam. Production always uses the fixed minute deadline. */
  timeoutMs?: number;
  /** A background verification job may end before the per-download deadline. */
  signal?: AbortSignal;
}): Promise<FileDownloadProof> => {
  const choice = fileDownloadChoice(args.meta); if (choice.unavailable_reason) throw refuseFileDownload(choice.unavailable_reason);
  const metadata = fileDownloadMetadataSignature(args.meta);
  if (args.expected && args.expected.metadata !== metadata) throw refuseFileDownload('The chosen file changed. Recheck the original file before switching.');
  const transport = resolveFileBearerTransport(args.cred, args.direct, args.provider);
  if (!transport) throw refuseFileDownload('The file has no compatible authentication transport.');
  const deadline = AbortSignal.timeout(args.timeoutMs ?? 60_000);
  const signal = args.signal ? AbortSignal.any([args.signal, deadline]) : deadline; let calls = 0; let started = false;
  const active = (): Promise<void> => race(args.assertActive(),signal);
  const perform = async (fetcher: FileFetch, url: string, init: Parameters<FileFetch>[1]): Promise<FileFetchResponse> => {
    if (++calls > 8) throw refuseFileDownload('The download exceeded its request limit.');
    await active(); return race(fetcher(url,{ ...init, redirect:'manual',signal }),signal,discard);
  };
  const bounded: FileFetch = async (url,init) => {
    if (started) throw refuseFileDownload('The file resolver attempted another download.'); started = true;
    const first = new URL(url); const headers = new Headers(init.headers); headers.delete('cookie');
    if (first.origin !== initialOrigin(args.provider) || first.username || first.password || first.hash
      || (args.provider === 'dropbox' ? init.method !== 'POST' || first.pathname !== '/2/files/download' : init.method !== 'GET') || init.body !== undefined) {
      throw refuseFileDownload('The file resolver requested an unexpected vendor endpoint.');
    }
    const anonymousHeaders = new Headers(headers); anonymousHeaders.delete('authorization'); anonymousHeaders.delete('host');
    const control = await perform(args.direct,url,{ method:init.method,headers:headerRecord(anonymousHeaders) });
    discard(control);
    if (control.status !== 401 && control.status !== 403) throw refuseFileDownload('Choose a protected file. This file did not prove authenticated download/export access.');
    let current = first; let method = init.method; let leftOrigin = false; let response: FileFetchResponse | undefined;
    for (let hop = 0; ; hop++) {
      const authenticated = !leftOrigin && current.origin === first.origin;
      response = await perform(authenticated ? transport.fetch : args.direct,current.toString(),{
        method,headers:authenticated ? headerRecord(headers) : { Accept:choice.mime_type },
      });
      if (![301,302,303,307,308].includes(response.status)) break;
      const location = response.headers.get('location'); discard(response);
      if (!location || hop >= 5) throw refuseFileDownload('The file download returned an unsupported redirect.');
      const next = new URL(location,current);
      if (next.username || next.password || next.hash || next.origin !== first.origin && !signedDownload(next,args.provider)) {
        throw refuseFileDownload('The file download redirected outside the vendor download service.');
      }
      if (next.origin !== first.origin) leftOrigin = true;
      if (response.status === 303 || [301,302].includes(response.status) && method === 'POST') method = 'GET';
      current = next;
    }
    if (response.status !== 200 || response.headers.has('content-range') || 'redirected' in response && response.redirected === true) {
      discard(response); throw refuseFileDownload('The vendor did not return a complete file download/export.');
    }
    const declared = response.headers.get('content-length');
    // Fetch decodes HTTP compression while retaining the encoded Content-Length.
    const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
    const compareLength = declared !== null && (!encoding || encoding === 'identity');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > FILE_DOWNLOAD_VERIFICATION_MAX_BYTES)) {
      discard(response); throw refuseFileDownload('Choose a file no larger than 10 MiB.');
    }
    let total = 0;
    if (!response.body) {
      const body = await race(response.arrayBuffer(),signal, late => new Uint8Array(late).fill(0));
      if (body.byteLength > FILE_DOWNLOAD_VERIFICATION_MAX_BYTES) { new Uint8Array(body).fill(0); throw refuseFileDownload('Choose a file no larger than 10 MiB.'); }
      if (compareLength && body.byteLength !== Number(declared)) { new Uint8Array(body).fill(0); throw refuseFileDownload('The downloaded file was incomplete.'); }
      return new Response(body,{headers:response.headers});
    }
    const reader = response.body.getReader();
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) { try {
        const part = await race(reader.read(),signal);
        if (part.done) {
          if (compareLength && total !== Number(declared)) throw refuseFileDownload('The downloaded file was incomplete.');
          controller.close(); reader.releaseLock(); return;
        }
        total += part.value.byteLength;
        if (total > FILE_DOWNLOAD_VERIFICATION_MAX_BYTES) throw refuseFileDownload('Choose a file no larger than 10 MiB.');
        controller.enqueue(part.value);
      } catch (error) { void reader.cancel().catch(() => {}); controller.error(error); } },
      cancel() { void reader.cancel().catch(() => {}); },
    }),{headers:response.headers});
  };
  const resolvers = buildRemoteFileByteResolvers({fetchImpl:bounded}); const resolver = resolvers[args.provider];
  if (!resolver) throw refuseFileDownload('This file source has no download/export adapter.');
  let bytes: Buffer | undefined;
  try {
    const result = await race(resolver({ cred:{ ...args.cred,...(args.cred.auth.type === 'managed_oauth' ? {managedFetch:bounded} : {}) },
      remote_id:args.meta.remote_id,meta:args.meta,maxBytes:FILE_DOWNLOAD_VERIFICATION_MAX_BYTES }),signal,
    late => { late.bytes.fill(0); });
    bytes = result.bytes; await active();
    if (bytes.length > FILE_DOWNLOAD_VERIFICATION_MAX_BYTES) throw refuseFileDownload('Choose a file no larger than 10 MiB.');
    const mime = result.mime_type?.toLowerCase();
    if (mime && choice.mime_type !== 'application/octet-stream' && mime !== choice.mime_type.toLowerCase()) throw refuseFileDownload('The downloaded file format differs from the chosen file.');
    if (choice.mode === 'export') {
      if (!validOfficePackage(bytes,choice.mime_type)) throw refuseFileDownload('The vendor did not return a supported Office export package.');
    } else if (args.meta.size !== undefined && bytes.length !== args.meta.size) throw refuseFileDownload('The downloaded file size differs from its metadata.');
    const digest = hash(bytes);
    if (args.expected && choice.mode === 'download' && digest !== args.expected.digest) throw refuseFileDownload('The downloaded bytes differ. Recheck the original file before switching.');
    return {choice,metadata,digest};
  } catch (error) {
    if (error instanceof RpcError && (error.code === 'conflict' || error.details?.reason === 'file_download_access_unconfirmed')) throw error;
    throw refuseFileDownload('The chosen file could not be downloaded/exported with this authentication.');
  } finally { bytes?.fill(0); }
};
