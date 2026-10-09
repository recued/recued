/** A text file handed to an AI step reaches the model as TEXT.
 *
 *  ⛔⛔ THE PROPERTY: every shipped recipe that hands an AI step a `file_ref`
 *  hands it text (OCR, pdftotext, docling, markitdown or whisper output). Sent
 *  as a `document` part, each one demanded a model that declares document input,
 *  which nothing in the product sets, so all 28 such steps failed with
 *  AI_MODALITY_UNSUPPORTED on a normal text-only setup, while their drives stubbed
 *  the AI step. Driven here through the real `resolveAiFileRef` and the real
 *  `executeLLM`, against a text-only slot, the way `capture-receipt` meets them:
 *  an OCR'd receipt in the run's scratch directory.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQuotaTracker, executeLLM } from '@recued/llm';
import type { LLMAdapter, LLMCompletionOptions, LLMConfig, LLMMessage, LLMSlot } from '@recued/llm';
import type { IngredientManifest, TempFileRef } from '@recued/contracts';

import { allocateRunScratchDir, cleanupRunScratch } from '../execution/run-scratch.js';
import { resolveAiFileRef, textFileContentPart } from '../server-executor.js';

const extract: IngredientManifest = {
  slug: 'ai-extract', name: 'Extract', description: 'Extract fields', author: 'recued',
  kind: 'ai', category: 'ai', risk_tier: 'read', input: {}, output: {},
};

/** A slot with no `modalities`: what Settings → AI / Models writes. */
const textOnly: LLMConfig = {
  slot_1: { provider: 'openai', model: 'gpt', api_key: 'sk', speed: 'fast', supports_json: true },
};

const recordingAdapter = (): LLMAdapter & { sent: () => string } => {
  const complete = vi.fn(async (_slot: LLMSlot, _messages: LLMMessage[], _options: LLMCompletionOptions) => ({
    text: '{"merchant":"Corner Cafe","total":"4.20"}',
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  }));
  return { provider: 'openai', complete, sent: () => JSON.stringify(complete.mock.calls[0]?.[1] ?? []) };
};

const run = (input: Record<string, unknown>, adapter: LLMAdapter) => executeLLM(extract, input, {
  config: textOnly, adapters: () => adapter, quota: createQuotaTracker(), tabProbe: async () => new Set(),
});

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

describe('textFileContentPart', () => {
  it('reads every text kind as text, and leaves pictures, PDFs and binaries alone', () => {
    expect(textFileContentPart({ mime_type: 'text/plain', bytes_b64: b64('TOTAL 4.20') }))
      .toEqual({ type: 'text', text: 'TOTAL 4.20' });
    expect(textFileContentPart({ mime_type: 'text/markdown', bytes_b64: b64('# Lease') })?.type).toBe('text');
    expect(textFileContentPart({ mime_type: 'application/json', bytes_b64: b64('{"a":1}') })?.type).toBe('text');
    expect(textFileContentPart({ mime_type: 'image/png', bytes_b64: b64('PNG') })).toBeUndefined();
    expect(textFileContentPart({ mime_type: 'application/pdf', bytes_b64: b64('%PDF') })).toBeUndefined();
    // A NUL is binary labelled as text: it keeps the document path.
    expect(textFileContentPart({ mime_type: 'text/plain', bytes_b64: b64('a\u0000b') })).toBeUndefined();
  });

  it('decodes with the declared charset, and strips a byte-order mark', () => {
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('base64'); // "café" in ISO-8859-1
    expect(textFileContentPart({ mime_type: 'text/plain; charset=iso-8859-1', bytes_b64: latin1 })?.type).toBe('text');
    expect((textFileContentPart({ mime_type: 'text/plain; charset=iso-8859-1', bytes_b64: latin1 }) as { text: string }).text)
      .toBe('café');
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Hello')]).toString('base64');
    expect((textFileContentPart({ mime_type: 'text/plain', bytes_b64: bom }) as { text: string }).text).toBe('Hello');
  });
});

describe('an AI step reading a text file, on a text-only setup', () => {
  const runIds: string[] = [];
  afterEach(() => { for (const id of runIds.splice(0)) cleanupRunScratch(id); });
  /** An OCR'd receipt where `tesseract.image.ocr` leaves it: the run's scratch directory. */
  const ocrdReceipt = (): { runId: string; ref: TempFileRef } => {
    const runId = `ai-text-file-${runIds.length}`;
    runIds.push(runId);
    const path = join(allocateRunScratchDir(runId), 'receipt.txt');
    writeFileSync(path, 'CORNER CAFE\nFLAT WHITE 3.20\nCROISSANT 1.00\nTOTAL 4.20\n');
    return { runId, ref: { backing: 'temp', path, mime_type: 'text/plain', filename: 'receipt.txt' } };
  };
  const step = (ref: TempFileRef) => ({ 'llm.data': { file_ref: ref }, 'llm.fields': ['merchant', 'total'] });

  it('⛔⛔ reaches the model as text, and the step returns its fields', async () => {
    const { runId, ref } = ocrdReceipt();
    const input = await resolveAiFileRef('core-ai-extract', step(ref), undefined, runId, { textAsText: true });
    expect(input['llm.content_parts']).toEqual([
      { type: 'text', text: 'CORNER CAFE\nFLAT WHITE 3.20\nCROISSANT 1.00\nTOTAL 4.20\n' },
    ]);
    const adapter = recordingAdapter();
    await expect(run(input, adapter)).resolves.toEqual({ merchant: 'Corner Cafe', total: '4.20' });
    expect(adapter.sent()).toContain('TOTAL 4.20');
  });

  it('the control: the same file as a document part still fails on this setup', async () => {
    // What every run did before, and what an owner-REVIEWED run still sends: its
    // review pinned the file by content hash, so `textAsText` stays off there.
    const { runId, ref } = ocrdReceipt();
    const input = await resolveAiFileRef('core-ai-extract', step(ref), undefined, runId);
    expect((input['llm.content_parts'] as Array<{ type: string }>)[0]!.type).toBe('document');
    await expect(run(input, recordingAdapter())).rejects.toThrow(/document input/);
  });

  it('a stored markdown file (docling output kept in the warehouse) is text too', async () => {
    const fileRead = vi.fn(async () => ({ bytes_b64: b64('# Lease\nRent: £1,200'), mime_type: 'text/markdown', filename: 'lease.md' }));
    const input = await resolveAiFileRef('core-ai-extract', { 'llm.data': { file_ref: 'file:abc' }, 'llm.fields': ['rent'] },
      fileRead, undefined, { textAsText: true });
    expect(input['llm.data']).toBe('[text: lease.md]');
    expect(input['llm.content_parts']).toEqual([{ type: 'text', text: '# Lease\nRent: £1,200' }]);
  });
});
