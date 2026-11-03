import { describe, expect, it } from 'vitest';
import { filePreviewKind, FILE_PREVIEW_TEXT_CHARACTERS } from '@recued/contracts';
import { previewText } from '../files/file-preview.js';
import { CSV_PREVIEW_LIMITS, isCsvPreview, parseCsvPreview } from '../files/csv-preview.js';
import { zipSync, strToU8 } from 'fflate';
import { readDocxParts, DOCX_XML_MAX_BYTES } from '../files/docx-parts.js';

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
    expect(filePreviewKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('docx');
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

describe('bounded DOCX parts', () => {
  const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>';
  it('reads only the main document and types, leaving embedded content and original bytes alone', () => {
    const bytes = zipSync({ 'word/document.xml': strToU8(xml), '[Content_Types].xml': strToU8('<Types/>'),
      'word/embeddings/large.bin': new Uint8Array(DOCX_XML_MAX_BYTES + 1), 'word/vbaProject.bin': strToU8('ignored') });
    const original = bytes.slice();
    expect(readDocxParts(bytes)).toEqual({ document: xml, types: '<Types/>' }); expect(bytes).toEqual(original);
  });
  it('rejects malformed packages, oversized XML and entity declarations before rendering', () => {
    const archive = (document: string) => zipSync({ 'word/document.xml': strToU8(document), '[Content_Types].xml': strToU8('<Types/>') });
    const declaredSize = (bytes: Uint8Array, size: number) => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let local = false, central = false;
      for (let offset = 0; offset + 28 <= bytes.length; offset++) {
        const signature = view.getUint32(offset, true);
        if (!local && signature === 0x04034b50) { view.setUint32(offset + 22, size, true); local = true; }
        if (!central && signature === 0x02014b50) { view.setUint32(offset + 24, size, true); central = true; }
      }
      return bytes;
    };
    expect(() => readDocxParts(new Uint8Array())).toThrow('Invalid');
    expect(() => readDocxParts(zipSync({ 'other.xml': strToU8(xml) }))).toThrow('supported DOCX');
    expect(() => readDocxParts(archive('x'.repeat(DOCX_XML_MAX_BYTES + 1)))).toThrow('limits');
    expect(() => readDocxParts(declaredSize(archive('x'.repeat(DOCX_XML_MAX_BYTES + 1)), 0))).toThrow('limits');
    expect(() => readDocxParts(declaredSize(archive(xml + 'Unread trailing content'), strToU8(xml).length))).toThrow('corrupt');
    expect(() => readDocxParts(archive('<!DOCTYPE a [<!ENTITY x "expanded">]>' + xml))).toThrow('XML declarations');
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
