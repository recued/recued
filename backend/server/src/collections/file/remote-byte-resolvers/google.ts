/** Google Drive implements the unified file download contract. Binary files
 * use alt=media; native documents advertise and return a portable export.
 * Both transient reads and explicit retained imports use this same adapter.
 * https://developers.google.com/workspace/drive/api/guides/ref-export-formats */
import { RpcError, type FileMetaProjection } from '@recued/contracts';
import type { RemoteFileByteResolver, RemoteFileByteRequest, RemoteFileDownload } from '../remote-file-byte-resolver.js';
import type { FileFetch } from '../../../file-source-adapters/index.js';
import { bearerTokenOrThrow, fetchRemoteBytes } from './http-bytes.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const GOOGLE_EXPORT_MAX_BYTES = 10 * 1024 * 1024;
const EXPORTS: Readonly<Record<string, { extension: string; mime_type: string }>> = {
  'application/vnd.google-apps.document': {
    extension: '.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  'application/vnd.google-apps.spreadsheet': {
    extension: '.xlsx', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  'application/vnd.google-apps.presentation': {
    extension: '.pptx', mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
};

const describe = (meta: FileMetaProjection): RemoteFileDownload => {
  if (!meta.mime_type?.startsWith('application/vnd.google-apps.')) return {};
  const format = EXPORTS[meta.mime_type];
  if (!format) return { unavailable_reason: 'This Google file cannot be exported here. Download it from Google Drive, then upload it.' };
  const filename = meta.filename.toLowerCase().endsWith(format.extension) ? meta.filename : meta.filename + format.extension;
  return { export_as: { filename, mime_type: format.mime_type } };
};

export interface GoogleRemoteByteResolverDeps {
  fetchImpl: FileFetch;
}

/** Build the `google` `RemoteFileByteResolver`. */
export const buildGoogleRemoteByteResolver = (
  deps: GoogleRemoteByteResolverDeps,
): RemoteFileByteResolver => Object.assign(async (req: RemoteFileByteRequest) => {
  const download = describe(req.meta);
  if (download.unavailable_reason) throw new RpcError('remote_unresolvable', download.unavailable_reason, 422);
  const exported = download.export_as;
  const token = bearerTokenOrThrow(req.cred, 'google');
  const result = await fetchRemoteBytes({
    fetchImpl: deps.fetchImpl,
    url: `${DRIVE_API}/files/${encodeURIComponent(req.remote_id)}` + (exported
      ? `/export?mimeType=${encodeURIComponent(exported.mime_type)}`
      : '?alt=media&supportsAllDrives=true'),
    headers: { authorization: `Bearer ${token}` },
    maxBytes: exported ? Math.min(req.maxBytes, GOOGLE_EXPORT_MAX_BYTES) : req.maxBytes,
    vendorLabel: 'google',
    ref: req.remote_id,
  });
  if (!exported) return result;
  if (result.mime_type && result.mime_type.toLowerCase() !== exported.mime_type) {
    throw new RpcError('remote_fetch_failed', 'Google returned a different file format than requested.', 502);
  }
  return { bytes: result.bytes, ...exported };
}, { describe });
