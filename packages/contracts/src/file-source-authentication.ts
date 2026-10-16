/** Same-source OAuth migration with an optional owner-selected file check. */
import { isFileDownloadVerification, type FileDownloadVerification } from './file-download-verification.js';
import type { ManagedOAuthAccountIdentity } from './managed-oauth.js';
export type FileSourceOAuthProvider = 'google' | 'onedrive' | 'sharepoint' | 'dropbox' | 'box';
export const fileSourceOAuthProvider = (vendor: unknown, base: unknown): FileSourceOAuthProvider | undefined => {
  if (typeof base !== 'string') return;
  const bases: Readonly<Record<string, string>> = { google: 'https://www.googleapis.com/drive/v3',
    onedrive: 'https://graph.microsoft.com/v1.0', sharepoint: 'https://graph.microsoft.com/v1.0',
    dropbox: 'https://api.dropboxapi.com', box: 'https://api.box.com/2.0' };
  if (typeof vendor === 'string' && bases[vendor] === base.replace(/\/+$/, '')) return vendor as FileSourceOAuthProvider;
};
export interface FileSourceAuthenticationPreview {
  source_id: string; connection_name: string; provider: FileSourceOAuthProvider;
  status: 'pending' | 'verified'; expires_at: number;
  current: ManagedOAuthAccountIdentity; target?: ManagedOAuthAccountIdentity;
  selections: readonly string[]; file_count: number;
  download?: FileDownloadVerification;
}
export const isFileSourceAuthenticationPreview = (value: unknown): value is FileSourceAuthenticationPreview => {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const text = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0 && v.length <= 2048 && !/[\r\n\0]/.test(v);
  const identity = (v: unknown): boolean => record(v) && v.status === 'known' && text(v.account_id)
    && ['email', 'display_name', 'user_name'].every(k => v[k] === undefined || text(v[k]));
  return record(value) && text(value.source_id) && text(value.connection_name)
    && typeof value.provider === 'string' && ['google','onedrive','sharepoint','dropbox','box'].includes(value.provider)
    && typeof value.status === 'string' && ['pending','verified'].includes(value.status) && Number.isSafeInteger(value.expires_at)
    && Number(value.expires_at) > 0 && Number.isSafeInteger(value.file_count) && Number(value.file_count) >= 0
    && Number(value.file_count) <= 100000 && identity(value.current)
    && (value.status === 'verified' ? identity(value.target) && record(value.target) && record(value.current) && value.target.account_id === value.current.account_id : value.target === undefined)
    && (value.download === undefined || isFileDownloadVerification(value.download) && value.download.status === value.status)
    && Array.isArray(value.selections) && value.selections.length <= 16 && value.selections.every(text);
};
