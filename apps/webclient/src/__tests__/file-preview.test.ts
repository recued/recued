import { describe, expect, it } from 'vitest';
import { filePreviewKind, FILE_PREVIEW_TEXT_CHARACTERS } from '@recued/contracts';
import { previewText } from '../files/file-preview.js';
import { CSV_PREVIEW_LIMITS, isCsvPreview, parseCsvPreview } from '../files/csv-preview.js';

describe('file preview formats and plain text', () => {
  it.each(['text/html', 'text/javascript', 'image/svg+xml', 'application/xml', 'application/example+xml', 'application/json'])(
    '%s is displayed as inert plain text', mime => {
      expect(filePreviewKind(mime)).toBe('text');
      const text = '<script>alert(1)</script><a href="https://outside.invalid">link</a>';
      expect(previewText(new TextEncoder().encode(text))).toEqual({ text, truncated: false });
    });
  it('recognizes supported preview MIME types without enabling binary formats', () => {
    expect(filePreviewKind('IMAGE/PNG; charset=binary')).toBe('image');
    expect(filePreviewKind('APPLICATION/CSV; header="absent"')).toBe('text');
    expect(filePreviewKind('application/pdf')).toBe('pdf');
    for (const mime of ['image/tiff', 'application/zip', 'video/mp4', 'application/octet-stream']) expect(filePreviewKind(mime)).toBeUndefined();
  });
  it('decodes UTF-8 and BOM-marked UTF-16, rejecting binary and unsupported encodings', () => {
    expect(previewText(new TextEncoder().encode('Hello 🌍'))).toEqual({ text: 'Hello 🌍', truncated: false });
    expect(previewText(new Uint8Array([255, 254, 65, 0]))).toEqual({ text: 'A', truncated: false });
    expect(previewText(new Uint8Array([254, 255, 0, 65]))).toEqual({ text: 'A', truncated: false });
    expect(() => previewText(new Uint8Array([0, 1]))).toThrow('binary');
    expect(() => previewText(new Uint8Array([255]))).toThrow('encoding');
  });
  it('bounds visible text without cutting an emoji in half or altering downloaded bytes', () => {
    const source = 'a'.repeat(FILE_PREVIEW_TEXT_CHARACTERS - 1) + '🌍 tail';
    const bytes = new TextEncoder().encode(source); const original = bytes.slice(); const result = previewText(bytes);
    expect(result.text).toBe('a'.repeat(FILE_PREVIEW_TEXT_CHARACTERS - 1)); expect(result.truncated).toBe(true);
    expect(bytes).toEqual(original); expect(previewText(new Uint8Array())).toEqual({ text: '', truncated: false });
  });
});

describe('CSV table preview data', () => {
  it('recognizes CSV without treating active document formats as CSV by filename', () => {
    expect(isCsvPreview('report', 'TEXT/CSV; charset=utf-8')).toBe(true);
    expect(isCsvPreview('Report.CSV', 'text/plain')).toBe(true);
    expect(isCsvPreview('report.csv', 'text/html')).toBe(false);
    expect(isCsvPreview('notes.txt', 'text/plain')).toBe(false);
  });

  it('preserves quoted values, duplicate and blank headings, and literal text values', () => {
    const result = parseCsvPreview('\ufeff__proto__,,Name,Name\r\n"North, West",00125.50,"First line\nSecond line","a""b"\r\n');
    expect(result).toEqual({ kind: 'table', columns: ['__proto__', '', 'Name', 'Name'],
      rows: [['North, West', '00125.50', 'First line\nSecond line', 'a"b']] });
  });

  it('honors header metadata without dropping a headerless first data row or reading quoted parameter contents', () => {
    const source = 'Alice,001\nBob,002\n';
    for (const mime of ['text/csv; header=absent', 'text/csv; note="a;header=present"; HEADER="ABSENT"']) {
      expect(parseCsvPreview(source, mime)).toEqual({ kind: 'table', columns: ['', ''], rows: [['Alice', '001'], ['Bob', '002']] });
    }
    expect(parseCsvPreview(source, 'text/csv; note="a;header=absent"; header=present')).toEqual({
      kind: 'table', columns: ['Alice', '001'], rows: [['Bob', '002']],
    });
    for (const mime of ['text/csv; header=unknown', 'text/csv; header=present; header=absent']) {
      expect(parseCsvPreview(source, mime)).toMatchObject({ kind: 'raw' });
    }
    expect(parseCsvPreview('value\n'.repeat(CSV_PREVIEW_LIMITS.rows + 1), 'text/csv; header=absent')).toMatchObject({ kind: 'raw' });
  });

  it('falls back to raw text for malformed or inconsistent records instead of inventing cells', () => {
    for (const source of ['Name,Comment\nAlice,"unfinished', 'Name,Comment\nAlice', 'Name\nAlice,extra']) {
      expect(parseCsvPreview(source)).toMatchObject({ kind: 'raw', reason: expect.stringContaining('Raw text') });
    }
  });

  it('refuses oversized parses without returning a partial table or misleading total', () => {
    for (const source of [
      'x'.repeat(CSV_PREVIEW_LIMITS.characters + 1),
      'Name\n' + 'value\n'.repeat(CSV_PREVIEW_LIMITS.rows + 1),
      Array(CSV_PREVIEW_LIMITS.columns + 1).fill('Name').join(','),
      'Name\n' + 'x'.repeat(CSV_PREVIEW_LIMITS.cellCharacters + 1),
      Array(CSV_PREVIEW_LIMITS.columns).fill('Name').join(',') + '\n'
        + (Array(CSV_PREVIEW_LIMITS.columns).fill('x').join(',') + '\n').repeat(CSV_PREVIEW_LIMITS.cells / CSV_PREVIEW_LIMITS.columns + 1),
    ]) expect(parseCsvPreview(source)).toMatchObject({ kind: 'raw', reason: expect.any(String) });
  });

  it('keeps empty files and header-only files distinct from unavailable tables', () => {
    expect(parseCsvPreview('')).toEqual({ kind: 'table', columns: [], rows: [] });
    expect(parseCsvPreview('Name,Amount\n')).toEqual({ kind: 'table', columns: ['Name', 'Amount'], rows: [] });
  });
});
