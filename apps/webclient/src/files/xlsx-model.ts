export const XLSX_PREVIEW_LIMITS = {
  xmlBytes: 2 * 1024 * 1024, totalXmlBytes: 8 * 1024 * 1024, sheets: 50,
  rows: 10_000, columns: 100, cells: 100_000, characters: 1_000_000, cellCharacters: 10_000,
} as const;
export interface XlsxParts { files: [string, string][] }
export class XlsxPreviewError extends Error {}
export const xlsxLimitError = () => new XlsxPreviewError('This workbook exceeds the preview limits. Download it to open it.');
