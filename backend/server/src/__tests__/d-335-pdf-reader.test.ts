/** D-335 slice AR — `document.read` reads a PDF with the PDFToText pack when that is the reader installed.
 *
 *  ⛔ Driven live with a real model (2026-11-07, task K of the head to head): it saved the PDF a W3C page
 *  links to among the owner's files, called `document.read` with its ref, and was told to install
 *  MarkItDown or Docling, though the PDFToText pack was installed: the reader converted with those two
 *  only. The owner: "then join other pack for pdf/md/unzip etc".
 *
 *  Here the real `document.read` plans over a real watched folder, with the packs each case names
 *  installed; the governed run it starts is recorded, not run. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatDispatchContext } from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';

import { buildChatTier1Handlers, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { watchedFileRecordId } from '../collections/file/watched-folder-collection.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { documentReadRecipe } from '../document-read-recipe.js';
import { createManifestRegistry } from '../manifest-loader.js';
import type { ExecuteRequest, ExecuteResponse } from '../types.js';
import { startWatchedFolder } from './helpers/watched-folder.js';

const ctx: ChatDispatchContext = { channel: 'internal_function_call', session_id: 's', turn_id: 't',
  execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'local' } };
const OPS: Record<string, string> = { markitdown: 'document.to_markdown', docling: 'document.to_markdown', pdftotext: 'pdf.to_text' };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

/** A folder holding a PDF and a Word document, with `packs` installed. */
const world = async (packs: readonly string[]) => {
  const dir = mkdtempSync(join(tmpdir(), 'd335-pdf-reader-'));
  const db = new Database(':memory:');
  const registry = createCollectionRegistry();
  const root = join(dir, 'Papers');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'alt-entry-to-an-image.pdf'), Buffer.from('%PDF-1.4\n%%EOF\n'));
  writeFileSync(join(root, 'plan.docx'), Buffer.from('PK\u0003\u0004 a Word document'));
  const folder = await startWatchedFolder({ db, bus: createWarehouseEventBus(), registry, slug: 'papers', root });
  cleanups.push(async () => { await folder.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const execute = vi.fn(async (_request: ExecuteRequest): Promise<ExecuteResponse> => ({ recipe_id: 'read-work-document',
    recipe_hash: 'h', success: true, output: { render: [{ type: 'summary', data: {} }], sidebar: [] }, steps: [], errors: [], duration_ms: 1 }));
  const manifests = createManifestRegistry('/nonexistent');
  for (const name of packs) {
    manifests.register({ slug: `${name}-catalog`, name, description: 'A document reader', author: 'recued-core',
      kind: 'connection', version: 1, category: 'data', risk_tier: 'write', input: {}, output: {},
      operations: { [OPS[name]!]: { operation_id: OPS[name]!, risk_tier: 'write', description: 'Convert' } } } as never);
  }
  const deps = {
    getCollectionRegistry: () => registry, getContactStore: () => undefined, getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined, getRecipeStore: () => { throw new Error('unused'); },
    getExecutorConfig: () => ({ manifests }) as ReturnType<ChatToolHandlerDeps['getExecutorConfig']>,
    getExecuteRecipe: () => execute,
    documentPacks: () => packs.map((name) => ({ segments: [name], value: { publisher: 'recued-core', ingredient_ids: [`${name}-catalog`] } })),
  } as unknown as ChatToolHandlerDeps;
  /** The whole answer, `missing_packs` beside its result. */
  const readWhole = async (file_ref: string) =>
    (await buildChatTier1Handlers(deps)['document.read']!({ file_ref }, ctx)) as { result: Record<string, unknown>; missing_packs?: string[] };
  const read = async (file_ref: string) => (await readWhole(file_ref)).result;
  /** The operation the governed run converted with, if it ran one. */
  const convertedWith = () => {
    const recipe = execute.mock.calls.at(-1)?.[0].recipe as { steps: Array<{ id: string; op: string }> } | undefined;
    return recipe?.steps.find((step) => step.id === 'convert')?.op;
  };
  return { read, readWhole, execute, convertedWith,
    pdf: watchedFileRecordId('papers', 'alt-entry-to-an-image.pdf'), docx: watchedFileRecordId('papers', 'plan.docx') };
};

describe('D-335 slice AR — a PDF reads with PDFToText', () => {
  it('converts a PDF with PDFToText when it is the reader installed', async () => {
    const w = await world(['pdftotext']);
    await w.read(w.pdf);
    expect(w.convertedWith()).toBe('recued-core.pdftotext.pdf.to_text');
  });

  it('leaves a PDF with MarkItDown or Docling when either is installed', async () => {
    for (const [packs, op] of [[['markitdown', 'pdftotext'], 'recued-core.markitdown.document.to_markdown'],
      [['docling', 'pdftotext'], 'recued-core.docling.document.to_markdown']] as const) {
      const w = await world(packs);
      await w.read(w.pdf);
      expect(w.convertedWith(), packs.join(' and ')).toBe(op);
    }
  });

  it('takes no other kind of file: a Word document with only PDFToText asks for MarkItDown or Docling', async () => {
    const w = await world(['pdftotext']);
    const result = await w.read(w.docx);
    expect(result).toMatchObject({ status: 'needs_pack', suggested_packs: ['markitdown', 'docling'] });
    expect(String(result.hint)).not.toContain('PDFToText');
    expect(w.execute).not.toHaveBeenCalled();
  });

  it('a PDF with no reader installed offers PDFToText beside the others', async () => {
    const w = await world([]);
    const answer = await w.readWhole(w.pdf);
    expect(answer.result).toMatchObject({ status: 'needs_pack', suggested_packs: ['markitdown', 'docling', 'pdftotext'] });
    expect(String(answer.result.hint)).toContain('PDFToText reads the text of a PDF');
    expect(answer.missing_packs).toEqual(['recued-core.markitdown', 'recued-core.docling', 'recued-core.pdftotext']);
    expect(w.execute).not.toHaveBeenCalled();
  });

  it('builds no run for a reader it does not know', () => {
    expect(documentReadRecipe('pdftotext').steps[0]).toMatchObject({ op: 'recued-core.pdftotext.pdf.to_text' });
    expect(() => documentReadRecipe('pandoc')).toThrow('There is no document reader named pandoc.');
  });
});
