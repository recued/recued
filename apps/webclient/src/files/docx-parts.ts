import { Unzip, UnzipInflate } from 'fflate';
import { FILE_PREVIEW_MAX_BYTES } from '@recued/contracts';

export const DOCX_XML_MAX_BYTES = 2 * 1024 * 1024;
export interface DocxParts { document: string; types: string }
export class DocxPreviewError extends Error {}

/** Only the main document and content-type declaration are inflated. Embedded
 * files, images, relationships and macros never enter the renderer. Runs in a
 * disposable worker. Both declared and actual output sizes are bounded: ZIP
 * headers must never truncate a larger stream into an apparently complete XML. */
export const readDocxParts = (bytes: Uint8Array): DocxParts => {
  if (bytes.length < 22 || bytes.length > FILE_PREVIEW_MAX_BYTES) throw new DocxPreviewError('Invalid or oversized DOCX file. Download it to open it.');
  const wanted = new Map([['word/document.xml', DOCX_XML_MAX_BYTES], ['[Content_Types].xml', 64 * 1024]]);
  const seen = new Set<string>(), parts = new Map<string, Uint8Array>();
  const unzip = new Unzip(file => {
    const limit = wanted.get(file.name);
    if (limit === undefined) { file.terminate(); return; }
    if (seen.has(file.name) || (file.originalSize !== undefined && file.originalSize > limit)
      || ![0, 8].includes(file.compression)) throw new DocxPreviewError('This DOCX document exceeds the safe preview limits. Download it to open it.');
    seen.add(file.name);
    let size = 0;
    const chunks: Uint8Array[] = [];
    file.ondata = (error, chunk, final) => {
      if (error) throw error instanceof DocxPreviewError ? error
        : new DocxPreviewError('This DOCX file could not be read. Download it to open it.');
      size += chunk.length;
      if (size > limit) throw new DocxPreviewError('This DOCX document exceeds the safe preview limits. Download it to open it.');
      chunks.push(chunk);
      if (!final) return;
      if (file.originalSize !== undefined && size !== file.originalSize) throw new DocxPreviewError('This DOCX file is incomplete or corrupt. Download it to open it.');
      const value = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { value.set(chunk, offset); offset += chunk.length; }
      parts.set(file.name, value);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  // Small compressed inputs also bound each Inflate allocation before its
  // output callback can reject a forged expansion size.
  for (let offset = 0; offset < bytes.length; offset += 1024) {
    unzip.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length);
  }
  const decode = (name: string): string => {
    const value = parts.get(name);
    if (!value || value.length > wanted.get(name)!) throw new DocxPreviewError('This file is not a supported DOCX document.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(value);
    if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(text)) throw new DocxPreviewError('This DOCX document contains unsupported XML declarations.');
    return text;
  };
  return { document: decode('word/document.xml'), types: decode('[Content_Types].xml') };
};
