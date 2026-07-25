/** D-172 P5 / N.8 — server-executor ai-* file_ref → ContentPart resolution. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { extractFileRecordId, extractTempFileRef, resolveAiFileRef } from '../server-executor.js';
import {
  allocateRunScratchDir,
  cleanupRunScratch,
} from '../execution/run-scratch.js';
import type { TempFileRef } from '@recued/contracts';

const fileRead = (over: Partial<{ bytes_b64: string; mime_type: string; filename: string }> = {}) =>
  vi.fn(async (_id: string) => ({ bytes_b64: 'BYTES', mime_type: 'image/png', filename: 'receipt.png', ...over }));

describe('extractFileRecordId', () => {
  it('reads the explicit { file_ref } wrapper', () => {
    expect(extractFileRecordId({ file_ref: 'file:abc' })).toBe('file:abc');
  });
  it('reads a resolved file record (record_id + storage_ref / blob_hash)', () => {
    expect(extractFileRecordId({ record_id: 'file:x', storage_ref: { kind: 'cas', blob_hash: 'h' } })).toBe('file:x');
    expect(extractFileRecordId({ record_id: 'file:z', blob_hash: 'abc' })).toBe('file:z');
  });
  it('does NOT mis-detect a non-file record with record_id + hot_fields (mail/calendar/contact shape)', () => {
    // The storage marker is load-bearing — a mail/calendar/contact record has
    // record_id + hot_fields but no storage_ref/blob_hash, so it stays a text/object datum.
    expect(extractFileRecordId({ record_id: 'mail:1', hot_fields: { subject: 'hi', from: 'a@b.com' } })).toBeNull();
  });
  it('returns null for non-file shapes', () => {
    expect(extractFileRecordId('hello')).toBeNull();
    expect(extractFileRecordId(['a', 'b'])).toBeNull();
    expect(extractFileRecordId({ foo: 'bar' })).toBeNull();        // no record_id / file_ref
    expect(extractFileRecordId({ record_id: 'x' })).toBeNull();    // record_id but no storage marker
    expect(extractFileRecordId(null)).toBeNull();
    expect(extractFileRecordId(42)).toBeNull();
  });
});

describe('resolveAiFileRef', () => {
  it('rewrites llm.data to a placeholder + carries the image as a content part', async () => {
    const fr = fileRead();
    const out = await resolveAiFileRef('ai-summarize', { 'llm.data': { file_ref: 'file:abc' }, 'llm.max_length': 50 }, fr);
    expect(fr).toHaveBeenCalledWith('file:abc');
    expect(out['llm.data']).toBe('[image: receipt.png]');
    expect(out['llm.content_parts']).toEqual([
      { type: 'image', source: { kind: 'base64', media_type: 'image/png', data: 'BYTES' } },
    ]);
    expect(out['llm.max_length']).toBe(50); // other fields preserved
  });

  it('classifies media_class from MIME (audio / document)', async () => {
    const audio = await resolveAiFileRef('ai-extract', { 'llm.data': { file_ref: 'f' }, 'llm.fields': ['x'] }, fileRead({ mime_type: 'audio/wav', filename: 'note.wav' }));
    expect((audio['llm.content_parts'] as any)[0].type).toBe('audio');
    expect(audio['llm.data']).toBe('[audio: note.wav]');

    const doc = await resolveAiFileRef('ai-summarize', { 'llm.data': { file_ref: 'f' } }, fileRead({ mime_type: 'application/pdf', filename: 'contract.pdf' }));
    expect((doc['llm.content_parts'] as any)[0].type).toBe('document');
  });

  it('is a no-op when llm.data is a plain string (text path unchanged), and never calls fileRead', async () => {
    const fr = fileRead();
    const input = { 'llm.data': 'just text', 'llm.categories': ['a'] };
    const out = await resolveAiFileRef('ai-classify', input, fr);
    expect(out).toBe(input);
    expect(fr).not.toHaveBeenCalled();
  });

  it('is a no-op when content_parts already supplied (no double-resolve)', async () => {
    const fr = fileRead();
    const input = { 'llm.data': { file_ref: 'f' }, 'llm.content_parts': [] };
    const out = await resolveAiFileRef('ai-summarize', input, fr);
    expect(out).toBe(input);
    expect(fr).not.toHaveBeenCalled();
  });

  it('is a no-op for slugs that do not take a single llm.data (ai-compare / ai-prompt)', async () => {
    const fr = fileRead();
    const cmp = { 'llm.data': { file_ref: 'f' } };
    expect(await resolveAiFileRef('ai-compare', cmp, fr)).toBe(cmp);
    expect(await resolveAiFileRef('ai-prompt', cmp, fr)).toBe(cmp);
    expect(fr).not.toHaveBeenCalled();
  });

  it('is a no-op when llm.data is an array (batch mode untouched)', async () => {
    const fr = fileRead();
    const batch = { 'llm.data': [{ id: '1' }], 'llm.id_field': 'id' };
    const out = await resolveAiFileRef('ai-classify', batch, fr);
    expect(out).toBe(batch);
    expect(fr).not.toHaveBeenCalled();
  });
});

// D-185 Slice 2 — the `temp` backing (asymmetric union: a cas ref is a bare
// string, a temp ref is a { backing:'temp', path } object).
describe('extractTempFileRef', () => {
  it('narrows a temp file_ref object', () => {
    const ref: TempFileRef = { backing: 'temp', path: '/tmp/x/out.mp3', mime_type: 'audio/mpeg', filename: 'out.mp3' };
    expect(extractTempFileRef({ file_ref: ref })).toBe(ref);
  });
  it('returns null for a cas (string) ref and non-file shapes', () => {
    expect(extractTempFileRef({ file_ref: 'file:abc' })).toBeNull();
    expect(extractTempFileRef({ file_ref: { backing: 'cas', record_id: 'file:abc' } })).toBeNull();
    expect(extractTempFileRef('hello')).toBeNull();
    expect(extractTempFileRef(null)).toBeNull();
  });
  it('extractFileRecordId returns null for a temp object — the CAS gate never fires for temp', () => {
    // Load-bearing: the execute-handler `data-file-read` admission probe keys on
    // extractFileRecordId !== null. A temp ref must NOT trigger it (it carries no
    // file.read gate; the producing op was already gated — D-185 §3.2).
    const ref: TempFileRef = { backing: 'temp', path: '/tmp/x/out.mp3', mime_type: 'audio/mpeg', filename: 'out.mp3' };
    expect(extractFileRecordId({ file_ref: ref })).toBeNull();
  });
});

describe('resolveAiFileRef — temp backing', () => {
  const runIds: string[] = [];
  const freshRun = (label: string): string => {
    const id = `d185-srv-${label}-${runIds.length}`;
    runIds.push(id);
    return id;
  };
  afterEach(() => { for (const id of runIds.splice(0)) cleanupRunScratch(id); });

  const stageTemp = (run_id: string, name: string, content: string, mime: string): TempFileRef => {
    const dir = allocateRunScratchDir(run_id);
    const path = join(dir, name);
    writeFileSync(path, content);
    return { backing: 'temp', path, mime_type: mime, filename: name };
  };

  it('realizes a confined temp ref to a content part WITHOUT a wired fileRead (no gate)', async () => {
    const id = freshRun('ok');
    const ref = stageTemp(id, 'clip.mp3', 'AUDIO', 'audio/mpeg');
    // fileRead intentionally undefined — temp needs no Gateway file.read.
    const out = await resolveAiFileRef('ai-summarize', { 'llm.data': { file_ref: ref } }, undefined, id);
    expect(out['llm.data']).toBe('[audio: clip.mp3]');
    expect(out['llm.content_parts']).toEqual([
      { type: 'audio', source: { kind: 'base64', media_type: 'audio/mpeg', data: Buffer.from('AUDIO').toString('base64') } },
    ]);
  });

  it('refuses a temp ref whose path escapes the run-scratch root (arbitrary-read guard)', async () => {
    const id = freshRun('escape');
    allocateRunScratchDir(id); // root exists, but the ref points elsewhere
    const evil: TempFileRef = { backing: 'temp', path: '/etc/hostname', mime_type: 'text/plain', filename: 'hostname' };
    await expect(
      resolveAiFileRef('ai-summarize', { 'llm.data': { file_ref: evil } }, undefined, id),
    ).rejects.toThrow(/escapes the run-scratch root|does not exist/);
  });

  it('does not touch the gated fileRead when the ref is temp', async () => {
    const id = freshRun('no-cas');
    const ref = stageTemp(id, 'page.png', 'IMG', 'image/png');
    const fr = fileRead();
    const out = await resolveAiFileRef('ai-summarize', { 'llm.data': { file_ref: ref } }, fr, id);
    expect(fr).not.toHaveBeenCalled();
    expect((out['llm.content_parts'] as any)[0].type).toBe('image');
  });
});
