import { describe, expect, it } from 'vitest';
import { filePreviewKind, FILE_PREVIEW_TEXT_CHARACTERS } from '@recued/contracts';
import { previewText } from '../files/file-preview.js';

describe('file preview formats and plain text', () => {
  it.each(['text/html', 'text/javascript', 'image/svg+xml', 'application/xml', 'application/example+xml', 'application/json'])(
    '%s is displayed as inert plain text', mime => {
      expect(filePreviewKind(mime)).toBe('text');
      const text = '<script>alert(1)</script><a href="https://outside.invalid">link</a>';
      expect(previewText(new TextEncoder().encode(text))).toEqual({ text, truncated: false });
    });
  it('allows only supported image types and recognizes normalized MIME types', () => {
    expect(filePreviewKind('IMAGE/PNG; charset=binary')).toBe('image');
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
