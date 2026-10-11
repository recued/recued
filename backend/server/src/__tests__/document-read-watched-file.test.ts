/** D-106 follow-up — `document.read` on a file in a folder Recued watches.
 *
 *  ⛔ Driven live with a real model (2026-10-10): asked what a kickoff note in a
 *  watched folder said, it found the file with `file.search`, then called
 *  `document.read` three times with its `file:local:*` id, was refused as
 *  `invalid_arguments` each time (the reader took received files only), and
 *  told the owner it could not read the file — 81k tokens for no answer.
 *
 *  Here the reader runs over a real watched folder, and the governed read it
 *  starts is answered by the real `handleFileRead`, as the kernel's
 *  `core.storage.data-file-read` answers it. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatDispatchContext } from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';

import { buildChatTier1Handlers, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { handleFileRead } from '../collections/file/file-read-handler.js';
import { watchedFileRecordId } from '../collections/file/watched-folder-collection.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createBlobStore } from '../storage/blob-store.js';
import type { ExecuteRequest, ExecuteResponse } from '../types.js';
import { startWatchedFolder } from './helpers/watched-folder.js';

const NOTE = '# Sandhurst kickoff\n\nRenewal is due in 83 days. Dana owns the follow-up.\n';
const ctx: ChatDispatchContext = { channel: 'internal_function_call', session_id: 's', turn_id: 't',
  execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'local' } };
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const summary = (data: Record<string, unknown>): ExecuteResponse => ({ recipe_id: 'read-work-document', recipe_hash: 'h',
  success: true, output: { render: [{ type: 'summary', data }], sidebar: [] }, steps: [], errors: [], duration_ms: 1 });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const world = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'document-read-watched-'));
  const db = new Database(':memory:');
  const registry = createCollectionRegistry();
  const root = join(dir, 'Clients');
  mkdirSync(join(root, 'Sandhurst'), { recursive: true });
  writeFileSync(join(root, 'Sandhurst', 'kickoff-notes.md'), NOTE);
  writeFileSync(join(root, 'Sandhurst', 'brief.pdf'), Buffer.from('%PDF-1.4\n%%EOF\n'));
  const folder = await startWatchedFolder({ db, bus: createWarehouseEventBus(), registry, slug: 'clients', root });
  cleanups.push(async () => { await folder.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const readDeps = { registry, blobs: createBlobStore(join(dir, 'cas')) };
  /** The governed run: its `read` step is the kernel's data-file-read. */
  let duringRead: (() => Promise<void>) | undefined;
  const execute = vi.fn(async (request: ExecuteRequest): Promise<ExecuteResponse> => {
    const recipe = request.recipe as { steps: Array<{ id: string; args?: Record<string, unknown> }> };
    const [step] = recipe.steps;
    if (step?.id !== 'read') return summary({});
    const file = await handleFileRead(readDeps, { record_id: String((request.config as { source: unknown }).source) });
    await duringRead?.();
    const { bytes_b64, ...metadata } = file;
    return summary(step.args?.metadata_only === true ? metadata : { ...metadata, bytes_b64 });
  });
  const manifests = createManifestRegistry('/nonexistent');
  manifests.register({ slug: 'markitdown-catalog', name: 'markitdown', description: 'Document conversion', author: 'recued-core',
    kind: 'connection', version: 1, category: 'data', risk_tier: 'write', input: {}, output: {},
    operations: { 'document.to_markdown': { operation_id: 'document.to_markdown', risk_tier: 'write', description: 'Convert' } } } as never);
  const deps = {
    getCollectionRegistry: () => registry, getContactStore: () => undefined, getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined, getRecipeStore: () => { throw new Error('unused'); },
    getExecutorConfig: () => ({ manifests }) as ReturnType<ChatToolHandlerDeps['getExecutorConfig']>,
    getExecuteRecipe: () => execute,
    documentPacks: () => [{ segments: ['markitdown'], value: { publisher: 'recued-core', ingredient_ids: ['markitdown-catalog'] } }],
  } as unknown as ChatToolHandlerDeps;
  const read = (args: Record<string, unknown>) =>
    buildChatTier1Handlers(deps)['document.read']!(args, ctx) as Promise<{ result: Record<string, unknown> }>;
  return {
    root, folder, execute, read,
    note: watchedFileRecordId('clients', 'Sandhurst/kickoff-notes.md'),
    pdf: watchedFileRecordId('clients', 'Sandhurst/brief.pdf'),
    whileReading: (fn: () => Promise<void>) => { duringRead = fn; },
  };
};

describe('document.read on a watched folder’s file', () => {
  it('reads its text from the folder, citing the hash of the bytes read', async () => {
    const w = await world();
    const { result } = await w.read({ file_ref: w.note });
    expect(result).toMatchObject({
      status: 'read', file_ref: w.note, filename: 'kickoff-notes.md', converter: 'text',
      body: NOTE, content_hash: sha(NOTE), next_offset: null,
    });
    expect(w.execute).toHaveBeenCalledTimes(1);
    expect((w.execute.mock.calls[0]![0].config as { source: unknown }).source).toBe(w.note);
  });

  it('sends a document to its converter by id, with no content address to pin', async () => {
    const w = await world();
    await w.read({ file_ref: w.pdf });
    const request = w.execute.mock.calls[0]![0];
    expect((request.recipe as { steps: Array<{ id: string }> }).steps.map((s) => s.id)).toEqual(['convert', 'read']);
    expect((request.config as { source: unknown }).source).toBe(w.pdf);
  });

  it('says the file changed when it is edited while it is read', async () => {
    const w = await world();
    w.whileReading(async () => {
      writeFileSync(join(w.root, 'Sandhurst', 'kickoff-notes.md'), `${NOTE}A later line.\n`);
      await w.folder.collection.ingest({ type: 'change', path: join(w.root, 'Sandhurst', 'kickoff-notes.md') });
    });
    expect((await w.read({ file_ref: w.note })).result.status).toBe('changed');
  });

  it('refuses one gone from its folder or too large, without reading it', async () => {
    const w = await world();
    const record = w.folder.collection.get(w.note)!;
    w.folder.collection.upsert({ ...record, hot_fields: { ...record.hot_fields, size: 30 * 1024 * 1024 } });
    expect((await w.read({ file_ref: w.note })).result.status).toBe('too_large');
    await w.folder.collection.ingest({ type: 'remove', path: join(w.root, 'Sandhurst', 'kickoff-notes.md') });
    expect((await w.read({ file_ref: w.note })).result).toMatchObject({
      status: 'unavailable', hint: 'This file is no longer in its folder.',
    });
    expect(w.execute).not.toHaveBeenCalled();
  });
});
