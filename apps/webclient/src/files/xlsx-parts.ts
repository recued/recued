import { Unzip, UnzipInflate } from 'fflate';
import { FILE_PREVIEW_MAX_BYTES } from '@recued/contracts';
import { XLSX_PREVIEW_LIMITS, XlsxPreviewError, xlsxLimitError, type XlsxParts } from './xlsx-model.js';

/** Inflate only worksheet data and the metadata needed to interpret it. The
 * worker is disposable; images, embedded files and executable content are skipped.
 * Actual expansion is bounded independently of the ZIP's declared sizes. */
export const readXlsxParts = (bytes: Uint8Array): XlsxParts => {
  if (bytes.length < 22 || bytes.length > FILE_PREVIEW_MAX_BYTES) throw new XlsxPreviewError('This is not a supported XLSX workbook. Download it to open it.');
  const metadata = new Map([['[Content_Types].xml', 64 * 1024], ['xl/workbook.xml', 128 * 1024],
    ['xl/_rels/workbook.xml.rels', 64 * 1024], ['xl/sharedStrings.xml', XLSX_PREVIEW_LIMITS.xmlBytes], ['xl/styles.xml', 256 * 1024]]);
  const seen = new Set<string>(), files: [string, string][] = [];
  let total = 0, sheets = 0;
  const unzip = new Unzip(file => {
    const worksheet = /^xl\/worksheets\/[^/]+\.xml$/.test(file.name);
    const limit = metadata.get(file.name) ?? (worksheet ? XLSX_PREVIEW_LIMITS.xmlBytes : undefined);
    if (limit === undefined) { file.terminate(); return; }
    if (seen.has(file.name)) throw new XlsxPreviewError('This workbook contains duplicate parts. Download it to open it.');
    if (file.name.length > 512 || worksheet && ++sheets > XLSX_PREVIEW_LIMITS.sheets
      || file.originalSize !== undefined && file.originalSize > limit) throw xlsxLimitError();
    if (![0, 8].includes(file.compression)) throw new XlsxPreviewError('This workbook uses unsupported compression. Download it to open it.');
    seen.add(file.name);
    let size = 0;
    const chunks: Uint8Array[] = [];
    file.ondata = (error, chunk, final) => {
      if (error) throw error instanceof XlsxPreviewError ? error
        : new XlsxPreviewError('This workbook is incomplete or corrupt. Download it to open it.');
      size += chunk.length; total += chunk.length;
      if (size > limit || total > XLSX_PREVIEW_LIMITS.totalXmlBytes) throw xlsxLimitError();
      chunks.push(chunk);
      if (!final) return;
      if (file.originalSize !== undefined && file.originalSize !== size) throw new XlsxPreviewError('This workbook is incomplete or corrupt. Download it to open it.');
      const value = new Uint8Array(size); let offset = 0;
      for (const part of chunks) { value.set(part, offset); offset += part.length; }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(value);
      if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(text)) throw new XlsxPreviewError('This workbook contains unsupported XML declarations. Download it to open it.');
      files.push([file.name, text]);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    // Bound the Inflate allocation before its output callback checks actual size.
    for (let offset = 0; offset < bytes.length; offset += 1024) unzip.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length);
  } catch (error) {
    if (error instanceof XlsxPreviewError) throw error;
    throw new XlsxPreviewError('This workbook could not be read. Download it to open it.');
  }
  if (!['[Content_Types].xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels'].every(name => files.some(file => file[0] === name))) {
    throw new XlsxPreviewError('This is not a supported XLSX workbook. Download it to open it.');
  }
  return { files };
};
