/** Same-account, same-file-set proof composed into the existing atomic API switch. */
import { createHash, randomBytes } from 'node:crypto';
import { CONNECTION_SOURCE_ID, RpcError, compileImportScope, normalizeScopePath, fileSourceOAuthProvider,
  getFileVendorDeclaration, validateFileMetaProjection, FILE_DOWNLOAD_VERIFICATION_MAX_BYTES, type FileDownloadChoices, type FileDownloadVerification, type FileMetaProjection, type ConnectionAuth, type ConnectionRow, type FileSourceAuthenticationPreview,
  type FileSourceOAuthProvider, type ManagedOAuthAccountIdentity } from '@recued/contracts';
import { buildFileSourceAdapterResolver, defaultFileFetch, type FileConnectionCredential, type FileConnectionResolver,
  type FileFetch } from './file-source-adapters/index.js';
import { resolveFileBearerTransport } from './file-source-adapters/bearer-transport.js';
import { assertPersistedOAuthAccess } from './native-oauth-renewal.js';
import { fetchFileSourceApi } from './file-source-adapters/http-json.js';
import { projectFileVendorRow } from './file-source-projector.js';

import type { FileMetaStore } from './storage/file-meta-store.js';
import { fileDownloadChoice, verifyFileSourceDownload, refuseFileDownload, type FileDownloadProof } from './file-download-verification.js';

const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown): string | undefined => typeof v === 'string' && v.trim().length > 0 && v.length <= 2048 && !/[\r\n\0]/.test(v) ? v : undefined;
const email = (v: unknown): string | undefined => typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : undefined;
const refuse = (message: string): RpcError => new RpcError('credential_verification_failed', message + ' Saved authentication and file data were kept.',
  422, 'collection.connection.managedOAuth', { verification_status: 'unknown', reason: 'file_source_access_unconfirmed', existing_credential_preserved: true });
/** A proxy or test transport may ignore cancellation; stop waiting and discard late bodies. */
const abortable = <T>(run: Promise<T>, signal: AbortSignal, discard?: (value: T) => void): Promise<T> => new Promise((resolve, reject) => {
  const abort = (): void => reject(refuse('The metadata check timed out.'));
  if (signal.aborted) { void run.then(value => discard?.(value), () => {}); abort(); return; }
  signal.addEventListener('abort', abort, { once: true });
  void run.then(value => { if (signal.aborted) discard?.(value); else resolve(value); }, reject)
    .finally(() => signal.removeEventListener('abort', abort));
});
interface Snapshot { identity: ManagedOAuthAccountIdentity; digest: string; count: number; selected?: FileMetaProjection }
interface SourceBroker { id: string; signature: string }
interface Prepared { material: string; registry: string; expires: number; proof: Snapshot; public: FileSourceAuthenticationPreview; download?: FileDownloadProof; broker?: SourceBroker }
export interface FileSourceAuthenticationDeps {
  rows(): ConnectionRow[];
  resolveConnection: FileConnectionResolver;
  /** Source incarnation, not sync timestamps or cursor. Missing means it is no longer registered. */
  registration(sourceId: string): string | undefined;
  authSourceId?(name: string): string | undefined;
  /** Non-secret revision of the original source's broker profile. */
  brokerSignature?(id: string): string | undefined;
  /** Decryption is a vault-access gate even while a metadata walk is in flight. */
  unlock(row: ConnectionRow): Promise<ConnectionAuth>;
  managedFetch(auth: import('@recued/contracts').ManagedOAuthAuth, url: string, init: RequestInit): Promise<Response>;
  verificationFiles?: Pick<FileMetaStore, 'browse' | 'get'>;
  /** Shares the existing explicit owner-revoke gate for remote file bytes. */
  admitRemoteFetch?(): boolean;
  fetch?: typeof fetch; now?(): number;
}
export const createFileSourceAuthentication = (deps: FileSourceAuthenticationDeps) => {
  const now = deps.now ?? Date.now; const prepared = new Map<string, Prepared>(); const preparing = new Set<string>();
  const direct: FileFetch = deps.fetch ? (url, init) => { const { body, ...rest } = init;
    return deps.fetch!(url, { ...rest, ...(body !== undefined ? { body: body as BodyInit } : {}) }); } : defaultFileFetch;
  const config = (row: ConnectionRow): Record<string, unknown> => { try { return record(JSON.parse(row.config_json)); } catch { return {}; } };
  const rowOf = (name: string): ConnectionRow => {
    const row = deps.rows().find(r => r.kind === 'api' && r.name === name);
    if (!row) throw new RpcError('not_found', 'The saved file connection no longer exists.'); return row;
  };
  const providerOf = (row: ConnectionRow): FileSourceOAuthProvider | undefined => {
    const c = config(row); return fileSourceOAuthProvider(c.vendor, c.base_url);
  };
  const material = (row: ConnectionRow): string => hash([row.pk, row.enrolled_at, row.name, row.config_json,
    deps.authSourceId?.(row.name) ?? row.auth_ciphertext]);
  const sourceId = (row: ConnectionRow, provider: FileSourceOAuthProvider): string => CONNECTION_SOURCE_ID(provider, row.name, 'file');
  const supported = (name: string): boolean => { const row = rowOf(name); const provider = providerOf(row);
    return !!provider && deps.registration(sourceId(row, provider)) !== undefined; };
  const assertBrokerCurrent = (broker: SourceBroker | undefined): void => {
    if (broker && deps.brokerSignature?.(broker.id) !== broker.signature) {
      throw new RpcError('conflict','The source OAuth broker changed. Reopen Switch authentication and review its current account.');
    }
  };
  const assertCurrent = (name: string): Prepared | undefined => {
    const row = rowOf(name); const provider = providerOf(row);
    if (!provider || !supported(name)) {
      if (prepared.has(name)) throw new RpcError('conflict', 'The reviewed file source was removed or replaced. Reopen it before switching.');
      return;
    }
    const old = prepared.get(name);
    if (!old || old.expires <= now() || old.material !== material(row) || old.registry !== deps.registration(sourceId(row, provider))) {
      throw new RpcError('conflict', 'The file-source review changed or expired. Reopen Switch authentication to check the existing source again.');
    }
    assertBrokerCurrent(old.broker);
    if (old.download && deps.admitRemoteFetch?.() !== true) throw refuseFileDownload('Remote file downloads are disabled. Review the file-fetch capability before retrying.');
    return old;
  };
  const assertSourceCurrent = (name: string, expectedMaterial: string, registry: string | undefined, broker?: SourceBroker): void => {
    const current = rowOf(name); const provider = providerOf(current);
    if (!provider || material(current) !== expectedMaterial || deps.registration(sourceId(current,provider)) !== registry) {
      throw new RpcError('conflict','The file source changed during its check. Reopen the source and review again.');
    }
    assertBrokerCurrent(broker);
  };
  const assertDownloadActive = async (row: ConnectionRow, registry: string, expectedMaterial: string, broker?: SourceBroker): Promise<void> => {
    if (deps.admitRemoteFetch?.() !== true) throw refuseFileDownload('Remote file downloads are disabled. Review the file-fetch capability before retrying.');
    await deps.unlock(rowOf(row.name));
    if (deps.admitRemoteFetch?.() !== true) throw refuseFileDownload('Remote file downloads are disabled. Review the file-fetch capability before retrying.');
    assertSourceCurrent(row.name,expectedMaterial,registry,broker);
  };
  const files = async (name: string, expected: number, query = '', after?: string): Promise<FileDownloadChoices> => {
    const row = rowOf(name); const provider = providerOf(row);
    if (row.updated_at !== expected || !provider || !supported(name)) throw new RpcError('conflict','The file source changed. Refresh before choosing a file.');
    if (typeof query !== 'string' || query.length > 200 || /[\x00-\x1f\x7f]/.test(query) || after !== undefined && (!text(after) || /[\x00-\x1f\x7f]/.test(after) || after.length > 255)) {
      throw new RpcError('bad_request','Use a short file name or path to search this source.');
    }
    const id = sourceId(row,provider); const base = {source_id:id,connection_name:name,updated_at:row.updated_at,max_bytes:FILE_DOWNLOAD_VERIFICATION_MAX_BYTES};
    if (!deps.verificationFiles || deps.admitRemoteFetch?.() !== true) return {...base,available:false,files:[],reason:'File download checks are unavailable. Review the file-fetch capability or use metadata only.'};
    const before = material(row); const registry = deps.registration(id);
    try { await deps.unlock(row); } catch { return {...base,available:false,files:[],reason:'Unlock Recued before choosing a file for download/export verification.'}; }
    if (deps.admitRemoteFetch?.() !== true) return {...base,available:false,files:[],reason:'Remote file downloads are disabled. Review the file-fetch capability or use metadata only.'};
    const result = deps.verificationFiles.browse(id,query.trim(),26,after); const page = result.slice(0,25);
    if (page.some(item => item.scope !== id || item.target_id !== item.meta.remote_id || item.meta.provider !== provider
      || !text(item.target_id) || /[\x00-\x1f\x7f]/.test(item.target_id) || item.target_id.length > 255 || validateFileMetaProjection(item.meta).length)) {
      throw new RpcError('conflict','Some file choices could not be read. Sync this source and try again.');
    }
    if (material(rowOf(name)) !== before || deps.registration(id) !== registry) throw new RpcError('conflict','The file source changed. Choose the file again.');
    return {...base,available:true,files:page.map(item => fileDownloadChoice(item.meta)),
      ...(result.length > 25 ? {next_cursor:page[24]!.target_id} : {})};
  };
  const snapshot = async (row: ConnectionRow, cred: FileConnectionCredential, expected?: Snapshot, selectedId?: string, broker?: SourceBroker, signal?: AbortSignal): Promise<Snapshot> => {
    const provider = providerOf(row)!; const c = config(row); const declaration = getFileVendorDeclaration(provider)!;
    // The auth-source ID is a live lookup. Capture it before awaiting any work,
    // rather than recomputing both sides of a comparison after a replacement.
    const expectedMaterial = material(row); const registry = deps.registration(sourceId(row,provider));
    const transport = resolveFileBearerTransport(cred, direct, provider);
    if (!transport) throw refuse('This source needs a compatible direct OAuth or broker credential.');
    const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000); let requests = 0; let bytes = 0;
    const bound = (fetchImpl: FileFetch, authenticated: boolean): FileFetch => async (url, init) => {
      if (++requests > 256 || deadline.aborted) throw refuse('The metadata check exceeded its limit.');
      const base = new URL(String(c.base_url)); const target = new URL(url);
      if (target.origin !== base.origin || target.username || target.password || target.hash) throw refuse('The file check targeted a different vendor.');
      const signal = init.signal ? AbortSignal.any([deadline, init.signal]) : deadline;
      if (authenticated) await abortable(deps.unlock(rowOf(row.name)), signal);
      if (signal.aborted) throw refuse('The metadata check timed out.');
      assertSourceCurrent(row.name,expectedMaterial,registry,broker);
      const response = await abortable(fetchImpl(url, { ...init, redirect: 'error', signal }), signal, response => { void response.body?.cancel().catch(() => {}); });
      if (deadline.aborted || response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(() => {}); throw refuse('The vendor redirected or timed out during verification.'); }
      // Bound aggregate metadata as well as the adapter's per-response ceiling.
      if (response.body) {
        const reader = response.body.getReader();
        return new Response(new ReadableStream<Uint8Array>({
          async pull(controller) { try { const part = await abortable(reader.read(), signal); if (part.done) { controller.close(); reader.releaseLock(); return; }
            bytes += part.value.byteLength; if (bytes > 64 * 1024 * 1024 || deadline.aborted) { void reader.cancel().catch(() => {}); throw refuse('The metadata check exceeded its limit.'); }
            controller.enqueue(part.value);
          } catch (error) { void reader.cancel().catch(() => {}); controller.error(error); } },
          cancel() { void reader.cancel().catch(() => {}); },
        }), { status: response.status, headers: response.headers });
      }
      return response;
    };
    const bounded = bound(transport.fetch, true);
    const read = async (url: string, method = 'GET'): Promise<Record<string, unknown>> => {
      const response = await fetchFileSourceApi(bounded, url, { method, headers: { ...transport.headers, Accept: 'application/json' } }, { maxResponseBytes: 16384 });
      if (!response.ok) throw refuse('The vendor account identity could not be verified with existing access.');
      return record(await response.json());
    };
    let identityUrl: string; let method = 'GET'; let user: Record<string, unknown>; let id: string | undefined;
    let location: string | undefined;
    if (provider === 'google') {
      identityUrl = 'https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress,displayName)';
      user = record((await read(identityUrl)).user); id = text(user.permissionId);
    } else if (provider === 'dropbox') {
      identityUrl = 'https://api.dropboxapi.com/2/users/get_current_account'; method = 'POST';
      user = await read(identityUrl, method); id = text(user.account_id); location = text(record(user.root_info).root_namespace_id);
      if (!location) throw refuse('The Dropbox namespace could not be verified.');
    } else if (provider === 'box') {
      identityUrl = 'https://api.box.com/2.0/users/me?fields=id,name,login'; user = await read(identityUrl); id = text(user.id);
    } else {
      identityUrl = 'https://graph.microsoft.com/v1.0/me/drive?$select=id';
      try {
        const drive = text((await read(identityUrl)).id);
        if (!drive) throw refuse('The personal-drive identity is unavailable.');
        id = 'drive:' + drive; user = {};
        try { user = await read('https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName'); } catch { /* Email is optional; no new scope is requested. */ }
      } catch {
        identityUrl = 'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName'; user = await read(identityUrl);
        const account = text(user.id); id = account ? 'user:' + account : undefined;
      }
    }
    if (!id) throw refuse('A known matching vendor account is required.');
    if (expected && id !== expected.identity.account_id) throw refuse('The selected authentication belongs to a different vendor account.');
    const address = email(user.emailAddress ?? user.email ?? user.mail ?? user.login);
    const display = text(user.displayName ?? record(user.name).display_name ?? (typeof user.name === 'string' ? user.name : undefined));
    const identity: ManagedOAuthAccountIdentity = { status: 'known', account_id: id,
      ...(address ? { email: address } : {}), ...(display ? { display_name: display } : {}) };
    const control = await fetchFileSourceApi(bound(direct, false), identityUrl, { method, headers: { Accept: 'application/json' } }, { maxResponseBytes: 16384 });
    assertSourceCurrent(row.name,expectedMaterial,registry,broker);
    if (control.status !== 401 && control.status !== 403) throw refuse('The identity check did not prove protected vendor access.');
    const resolver = buildFileSourceAdapterResolver({ resolveConnection: async () => ({ ...cred, config: c,
      ...(cred.auth.type === 'managed_oauth' ? { managedFetch: bounded } : {}) }), fetchImpl: bounded });
    const list = resolver(provider)!;
    const outcome = await list({ source_id: sourceId(row, provider), connection_name: row.name, vendor: provider, declaration, cursor: null });
    assertSourceCurrent(row.name,expectedMaterial,registry,broker);
    if (!outcome.ok || outcome.walk !== 'full' || !outcome.complete || outcome.rows.length > 100000) throw refuse('A complete file metadata listing could not be verified.');
    const scope = outcome.scope ? compileImportScope(outcome.scope) : undefined;
    const ids = new Map<string, string | null>(); let selected: FileMetaProjection | undefined;
    for (const raw of outcome.rows) {
      const projected = projectFileVendorRow(raw, declaration);
      if (!projected.ok || validateFileMetaProjection(projected.projection).length > 0) throw refuse('The vendor returned incomplete file metadata.');
      const p = projected.projection;
      if (scope && declaration.projection.path !== undefined) {
        if (!p.path) throw refuse('The file scope could not be verified.');
        if (!scope.matches(normalizeScopePath(p.path))) continue;
      }
      if (ids.has(p.remote_id) && ids.get(p.remote_id) !== (p.path ?? null)) throw refuse('The vendor returned ambiguous file metadata.');
      ids.set(p.remote_id, p.path ?? null);
      if (p.remote_id === selectedId) {
        if (selected && hash(selected) !== hash(p)) throw refuseFileDownload('The chosen file has ambiguous metadata. Recheck its source.');
        selected = { ...p };
      }
    }
    if (selectedId !== undefined && !selected) throw refuseFileDownload('The chosen file is no longer visible in this source. Sync it and choose a current file.');
    return { identity, count: ids.size, ...(selected ? { selected } : {}), digest: hash([id, location, [...ids].sort((a,b) => a[0].localeCompare(b[0]))]) };
  };
  const prepare = async (name: string, expected?: number, verificationFileId?: string): Promise<FileSourceAuthenticationPreview | null> => {
    const before = rowOf(name); if (expected !== undefined && before.updated_at !== expected) throw new RpcError('conflict', 'The saved connection changed. Refresh before switching.');
    const provider = providerOf(before); if (!provider || !supported(name)) return null;
    for (const [key, value] of prepared) if (value.expires <= now()) prepared.delete(key);
    if (preparing.has(name) || preparing.size + prepared.size >= 16 && !prepared.has(name)) throw new RpcError('conflict', 'A file-source check is already pending. Wait and retry.');
    preparing.add(name); prepared.delete(name);
    try {
      const originalMaterial = material(before); const registry = deps.registration(sourceId(before, provider))!;
      if (verificationFileId !== undefined) {
        if (!text(verificationFileId) || /[\x00-\x1f\x7f]/.test(verificationFileId) || verificationFileId.length > 255) throw new RpcError('bad_request', 'Choose a valid file from this source.');
        if (deps.admitRemoteFetch?.() !== true) throw refuseFileDownload('Remote file downloads are disabled. Review the file-fetch capability before retrying.');
        const selected = deps.verificationFiles?.get(sourceId(before, provider), verificationFileId);
        if (!selected || selected.scope !== sourceId(before, provider) || selected.target_id !== verificationFileId || selected.meta.remote_id !== verificationFileId
          || selected.meta.provider !== provider || validateFileMetaProjection(selected.meta).length) throw refuseFileDownload('Choose a file already listed in this source. Sync the source if it is missing.');
      }
      const cred = await deps.resolveConnection(name); if (!cred) throw refuse('The existing authentication is unavailable.');
      const row = rowOf(name);
      let broker: SourceBroker | undefined;
      if (cred.auth.type === 'managed_oauth') {
        const signature = deps.brokerSignature?.(cred.auth.broker_profile_id);
        if (!signature) throw refuse('The original OAuth broker profile could not be verified.');
        broker = {id:cred.auth.broker_profile_id,signature};
      }
      // Normal renewal keeps its server-owned auth source ID. Owner changes do not.
      assertSourceCurrent(name,originalMaterial,registry);
      const proof = await snapshot(row, cred, undefined, verificationFileId, broker);
      const download = proof.selected ? await verifyFileSourceDownload({ provider,meta:proof.selected,cred,direct,
        assertActive: () => assertDownloadActive(row, registry, originalMaterial, broker), }) : undefined;
      assertSourceCurrent(name,originalMaterial,registry,broker);
      const expires = now() + 30 * 60_000;
      const selections = [cString(config(row).drive_id) ? 'Drive/library: ' + cString(config(row).drive_id)
        : cString(config(row).folder_id) ? 'Folder: ' + cString(config(row).folder_id) : 'Existing vendor root',
        provider === 'google' ? 'All accessible Drive files (the existing adapter scope)' : 'Import scope: ' + (cString(config(row).import_scope) ?? '**')];
      const preview: FileSourceAuthenticationPreview = { source_id: sourceId(row, provider), connection_name: name, provider,
        status: 'pending', expires_at: expires, current: proof.identity, selections, file_count: proof.count, ...(download ? { download: {
          remote_id:download.choice.remote_id, filename:download.choice.filename, output_filename:download.choice.output_filename,
          ...(download.choice.path ? {path:download.choice.path} : {}),
          mode:download.choice.mode, mime_type:download.choice.mime_type,
          review_id: randomBytes(32).toString('hex'), status: 'pending', max_bytes: FILE_DOWNLOAD_VERIFICATION_MAX_BYTES,
          comparison: download.choice.mode === 'export' ? 'same_file_and_format' : 'same_bytes',
        } satisfies FileDownloadVerification } : {}) };
      prepared.set(name, { material: originalMaterial, registry, expires, proof, public: preview, ...(download ? { download } : {}), ...(broker ? {broker} : {}) }); return preview;
    } catch (error) { if (error instanceof RpcError) throw error; throw refuse('The existing file source could not be checked. Repair it and retry.'); }
    finally { preparing.delete(name); }
  };
  const preview = async (row: ConnectionRow, auth?: ConnectionAuth): Promise<FileSourceAuthenticationPreview | undefined> => {
    if (!supported(row.name)) return;
    if (!prepared.has(row.name)) await prepare(row.name);
    const current = assertCurrent(row.name)!;
    if (!auth) return current.public;
    try {
      const cred: FileConnectionCredential = { auth, config: config(row), ...(auth.type === 'managed_oauth' ? {
        managedFetch: (url, init) => { const { body, ...rest } = init; const target = new URL(url);
          const content = auth.target_origin === 'https://api.dropboxapi.com' && target.origin === 'https://content.dropboxapi.com'
            && target.pathname === '/2/files/download';
          return deps.managedFetch(content ? { ...auth,target_origin:target.origin } : auth, url,
            { ...rest, ...(body !== undefined ? { body: body as BodyInit } : {}) }); },
      } : {}) };
      const proof = await snapshot(row, cred, current.proof, current.download?.choice.remote_id, current.broker);
      if (current.download) {
        if (!proof.selected) throw refuseFileDownload('The selected file is no longer in the source.');
        await verifyFileSourceDownload({provider:providerOf(row)!,meta:proof.selected,cred,direct,expected:current.download,
          assertActive: () => assertDownloadActive(row,current.registry,current.material,current.broker)});
      }
      if (assertCurrent(row.name) !== current) throw new RpcError('conflict', 'The original file-source review changed. Review again.');
      if (proof.identity.account_id !== current.proof.identity.account_id || proof.digest !== current.proof.digest) {
        throw refuse('The selected account, namespace, or visible file set differs from the existing source. Recheck the original source if files changed.');
      }
      return { ...current.public, status: 'verified', target: proof.identity,
        ...(current.public.download ? { download: { ...current.public.download,status:'verified' } } : {}) };
    } catch (error) { if (error instanceof RpcError) throw error; throw refuse('The selected authentication could not verify the existing file source.'); }
  };
  /** Check the saved source without replacing a migration review or staging a swap. */
  const verifySaved = async (name: string, selectedId?: string, signal?: AbortSignal): Promise<import('@recued/contracts').AuthenticationAccessCheck[]> => {
    const row = rowOf(name); const provider = providerOf(row);
    if (!provider || !supported(name)) throw refuse('This file source does not support access verification.');
    const originalMaterial = material(row); const registry = deps.registration(sourceId(row, provider))!;
    if (selectedId !== undefined) {
      const selected = deps.verificationFiles?.get(sourceId(row, provider), selectedId);
      if (!text(selectedId) || selectedId.length > 255 || /[\x00-\x1f\x7f]/.test(selectedId) || !selected || selected.scope !== sourceId(row, provider)
        || selected.target_id !== selectedId || selected.meta.remote_id !== selectedId || selected.meta.provider !== provider
        || validateFileMetaProjection(selected.meta).length) throw refuseFileDownload('Choose a saved file from this source.');
      if (deps.admitRemoteFetch?.() !== true) throw refuseFileDownload('Remote file downloads are disabled.');
    }
    const cred = await deps.resolveConnection(name); if (!cred) throw refuse('Saved authentication is unavailable.');
    assertPersistedOAuthAccess(cred.auth, await deps.unlock(rowOf(name)));
    const broker = cred.auth.type === 'managed_oauth' ? { id: cred.auth.broker_profile_id, signature: deps.brokerSignature?.(cred.auth.broker_profile_id) } : undefined;
    if (broker && !broker.signature) throw refuse('The saved broker profile is unavailable.');
    const pinnedBroker = broker?.signature ? { id: broker.id, signature: broker.signature } : undefined;
    assertSourceCurrent(name, originalMaterial, registry, pinnedBroker);
    if (signal?.aborted) throw new Error('Access check cancelled');
    const proof = await snapshot(rowOf(name), cred, undefined, selectedId, pinnedBroker, signal);
    const checks: import('@recued/contracts').AuthenticationAccessCheck[] = [{ kind: 'file_metadata', status: 'passed' }];
    if (selectedId && proof.selected) {
      try {
        await verifyFileSourceDownload({ provider, meta: proof.selected, cred, direct, ...(signal ? { signal } : {}),
          assertActive: () => { if (signal?.aborted) throw new Error('Access check cancelled'); return assertDownloadActive(row, registry, originalMaterial, pinnedBroker); } });
        checks.push({ kind: 'file_download', status: 'passed' });
      } catch (error) {
        if (error instanceof RpcError && error.code === 'conflict') throw error;
        checks.push({ kind: 'file_download', status: 'unconfirmed', reason: 'inconclusive' });
      }
    } else checks.push({ kind: 'file_download', status: 'unconfirmed', reason: 'resource_required' });
    assertSourceCurrent(name, originalMaterial, registry, pinnedBroker);
    checks.push({ kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' });
    return checks;
  };
  return { prepare, preview, assertCurrent, supported, files, verifySaved };
};
const cString = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\r\n\0]/.test(value) ? value : undefined;
