import { resolveBearerAccessToken } from '@recued/contracts';
import type { FileConnectionCredential, FileFetch } from './index.js';

/** Credential transport is immutable for one walk; concurrent accounts never share it. */
export interface FileBearerTransport {
  fetch: FileFetch;
  headers: Record<string, string>;
}

const ORIGINS: Readonly<Record<string, string>> = {
  google: 'https://www.googleapis.com',
  onedrive: 'https://graph.microsoft.com',
  sharepoint: 'https://graph.microsoft.com',
  box: 'https://api.box.com',
  dropbox: 'https://api.dropboxapi.com',
  notion: 'https://api.notion.com',
};

export const resolveFileBearerTransport = (cred: FileConnectionCredential, directFetch: FileFetch,
  vendor: string): FileBearerTransport | undefined => {
  if (cred.auth.type === 'managed_oauth') {
    if (!cred.managedFetch || cred.auth.target_origin !== ORIGINS[vendor]) return undefined;
    return { fetch: cred.managedFetch, headers: {} };
  }
  const token = resolveBearerAccessToken(cred.auth);
  return token === undefined ? undefined : { fetch: directFetch,
    headers: { [vendor === 'notion' ? 'Authorization' : 'authorization']: `Bearer ${token}` } };
};
