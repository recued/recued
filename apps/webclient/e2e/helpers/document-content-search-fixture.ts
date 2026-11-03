import type { Page } from '@playwright/test';
import type { DocumentContentSearchResult, OwnerDocumentSearchReply, OwnerDocumentSearchRequest } from '@recued/contracts';

export const installDocumentSearchFixture = async (page: Page, held = false, delayedFiles = false): Promise<void> => {
  await page.addInitScript(({ held, delayedFiles }) => {
    const searches: OwnerDocumentSearchRequest[] = [], checks: string[] = [];
    const fileLists: string[] = [], fileGets: string[] = [];
    let releaseFiles: (() => void) | undefined;
    const jobs = new Map<string, OwnerDocumentSearchReply>();
    let approved = !held;
    const id = (n: number) => `file:${String(n).padStart(32, '0')}`;
    const text = 'Renewal requires thirty days notice. Read the complete terms before cancelling.';
    const match = (n: number) => ({ file_ref: id(n), filename: n === 1 ? 'Contract terms.txt' : 'Service agreement.txt', content_hash: String(n).repeat(64),
      converter: 'text', extraction_complete: true, excerpt: text, excerpt_offset: 0 });
    const result = (request: OwnerDocumentSearchRequest): DocumentContentSearchResult => ({ status: 'searched', query: request.query,
      scope: 'all', scope_version: 'saved-files-1', matches: held || request.cursor ? [match(1), match(2)] : [match(1)],
      coverage: { files_in_scope: 6, indexed: held || request.cursor ? 5 : 1, pending: held || request.cursor ? 0 : 5,
        unreadable: 0, missing_converter: held || request.cursor ? 1 : 0, too_large: 0, empty_extraction: 0, unsupported_encoding: 0,
        converted: 0, scope_limited: false, scope_changed: false }, partial: true, matches_truncated: false,
      ...(!held && !request.cursor ? { next_cursor: 'prepare-next' } : {}), hint: '' });
    const record = (n: number) => ({ record_id: id(n), source_id: id(n), received_at: 1_700_000_000_000, modified_at: 1_700_000_000_000,
      size_bytes: text.length, blob_hash: String(n).repeat(64), hot_fields: { filename: match(n).filename, mime_type: 'text/plain', size: text.length,
        origin: 'webclient_upload', media_class: 'document', scan_status: 'clean' } });
    Object.assign(window, { __documentSearchDrive: { searches, checks, fileLists, fileGets,
      approve() { approved = true; }, releaseFiles() { releaseFiles?.(); } },
      __connectionsFixture: async (method: string, raw: unknown) => {
        const args = (raw ?? {}) as Record<string, unknown>;
        if (method === 'collection.file.document.search') {
          const request = raw as OwnerDocumentSearchRequest; searches.push(structuredClone(request));
          const reply: OwnerDocumentSearchReply = { request_id: request.request_id, state: approved ? 'ready' : 'held',
            ...(approved ? { result: result(request) } : { run_id: '11111111-2222-4333-8444-555555555555', message: 'This search is waiting for approval.' }) };
          jobs.set(request.request_id, reply); return { result: structuredClone(reply) };
        }
        if (method === 'collection.file.document.result') {
          const request_id = String(args.request_id); checks.push(request_id);
          const job = jobs.get(request_id)!;
          if (approved && job?.state === 'held') {
            const input = searches.find(request => request.request_id === request_id)!;
            jobs.set(request_id, { request_id, state: 'ready', result: result(input) });
          }
          return { result: structuredClone(jobs.get(request_id)) };
        }
        if (method === 'data_views.get' || method === 'data_views.list') {
          const view = { id: 'document-search', name: 'Document search', definition: { tab: 'search', query: 'renewal' }, revision: 1, created_at: 1, updated_at: 1 };
          return { result: method === 'data_views.get' ? { view } : { views: [view] } };
        }
        if (method === 'collection.searchAll') return { result: { groups: [{ slug: 'inbox', platform: 'mail', more: false,
          matches: [{ record_id: 'renewal-mail', rank: 0, hot_fields: { subject: 'Renewal email' }, received_at: 1 }] }] } };
        if (method === 'work_entity.search') return { result: { groups: [] } };
        if (method === 'contact.search.local') return { result: { contacts: [], total: 0 } };
        if (method === 'yours.read' && args.search) return { result: { assets: [], classes: [], total_assets: 0 } };
        if (method === 'recipe.list') return { result: { recipes: [] } };
        if (method === 'packs.list') return { result: { packs: [] } };
        if (method === 'collection.listInstances') return { result: { instances: delayedFiles ? [{
          platform: 'file', slug: 'other', adapter_type: 'fixture', auth_state: 'healthy', last_synced_at: null,
          caps: { read: 'yes', write: 'no', delete: 'no', watch: 'none', mirror: 'optional', auth: 'none', path_style: 'posix' },
        }] : [] } };
        if (method === 'data.file.attachments.list') {
          fileLists.push('received');
          if (delayedFiles && fileLists.length === 1) await new Promise<void>(resolve => { releaseFiles = resolve; });
          return { result: { files: [1, 2].map(n => ({ file_id: id(n), filename: match(n).filename, mime_type: 'text/plain',
            size: text.length, media_class: 'document', selection_revision: String(n).repeat(64) })) } };
        }
        if (method === 'collection.list' && args.platform === 'file') {
          fileLists.push(String(args.slug));
          if (delayedFiles && fileLists.length === 1) await new Promise<void>(resolve => { releaseFiles = resolve; });
          return { result: { records: args.slug === 'received' ? [record(1), record(2)] : [] } };
        }
        if (method === 'collection.get' && args.platform === 'file') {
          fileGets.push(String(args.record_id));
          return { result: { record: record(args.record_id === id(2) ? 2 : 1) } };
        }
        if (method === 'data.file.attachments.preview') return { result: { record_id: args.record_id, filename: match(1).filename,
          mime_type: 'text/plain', size_bytes: text.length, transient: false, can_download: true, content: { kind: 'text', bytes_b64: btoa(text) } } };
        return undefined;
      } });
  }, { held, delayedFiles });
};

declare global {
  interface Window {
    __documentSearchDrive: { searches: OwnerDocumentSearchRequest[]; checks: string[]; fileLists: string[]; fileGets: string[]; approve(): void; releaseFiles(): void };
  }
}
