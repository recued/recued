import { XLSX_PREVIEW_LIMITS as limits, XlsxPreviewError, xlsxLimitError, type XlsxParts } from './xlsx-model.js';
import { formatXlsxNumber, xlsxBuiltinFormat, xlsxString } from './xlsx-values.js';

const mainNamespaces = ['http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main'];
const documentRelationships = ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'];
const packageNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const contentNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';
const invalid = () => new XlsxPreviewError('This workbook has missing or invalid worksheet data. Download it to open it.');
const children = (element: Element, name: string) => Array.from(element.children).filter(child => child.namespaceURI === element.namespaceURI && child.localName === name);
const child = (element: Element, name: string) => children(element, name)[0];
const integer = (value: string | null, max: number): number => {
  if (value === null || !/^\d{1,8}$/.test(value) || Number(value) > max) throw invalid();
  return Number(value);
};
const xmlPart = (doc: Document, text: string | undefined, root: string, namespaces = mainNamespaces): Element => {
  if (text === undefined || /<!\s*(?:DOCTYPE|ENTITY)/i.test(text)) throw invalid();
  const xml = new doc.defaultView!.DOMParser().parseFromString(text, 'application/xml'), element = xml.documentElement;
  if (xml.getElementsByTagName('parsererror').length || element.localName !== root || !namespaces.includes(element.namespaceURI ?? '')) throw invalid();
  let count = 0;
  const stack: [Element, number][] = [[element, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (++count > 200_000 || depth > 64) throw xlsxLimitError();
    for (const item of node.children) stack.push([item, depth + 1]);
  }
  return element;
};
const richText = (element: Element): string => {
  // Phonetic guides are not the stored value. Rich-text styling stays inert.
  const text = Array.from(element.children).map(item => item.namespaceURI !== element.namespaceURI ? ''
    : item.localName === 't' ? item.textContent ?? '' : item.localName === 'r' ? children(item, 't').map(t => t.textContent ?? '').join('') : '').join('');
  if (text.length > limits.cellCharacters) throw xlsxLimitError();
  return xlsxString(text);
};
const localTarget = (target: string): string => {
  if (!target || /[\\?#]/.test(target)) throw invalid();
  const base = 'https://xlsx.invalid';
  const url = new URL(target, `${base}/xl/workbook.xml`);
  if (url.origin !== base) throw invalid();
  let path: string;
  try { path = decodeURIComponent(url.pathname).slice(1); } catch { throw invalid(); }
  if (!/^xl\/[\w .\-/]+\.xml$/.test(path) || path.split('/').some(part => part === '.' || part === '..')) throw invalid();
  return path;
};

export interface XlsxSheet { name: string; path: string; hidden: boolean }
export interface XlsxWorkbook {
  sheets: XlsxSheet[]; files: Map<string, string>; sharedStrings: string[]; formats: string[]; date1904: boolean;
}
export interface XlsxCell { text: string; raw: string; formula: boolean; missing: boolean }
export interface XlsxSheetData {
  rows: Map<number, Map<number, XlsxCell>>; rowCount: number; columnCount: number; formulas: number; missingValues: number;
}

export const parseXlsxWorkbook = (doc: Document, parts: XlsxParts): XlsxWorkbook => {
  const files = new Map(parts.files);
  const types = xmlPart(doc, files.get('[Content_Types].xml'), 'Types', [contentNamespace]);
  const overrides = new Map(children(types, 'Override').map(entry => [entry.getAttribute('PartName'), entry.getAttribute('ContentType')]));
  if (overrides.get('/xl/workbook.xml') !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml') {
    throw new XlsxPreviewError('This file is not a supported XLSX workbook. Download it to open it.');
  }
  const workbook = xmlPart(doc, files.get('xl/workbook.xml'), 'workbook');
  const rels = xmlPart(doc, files.get('xl/_rels/workbook.xml.rels'), 'Relationships', [packageNamespace]);
  const relationships = new Map<string, { type: string; path: string }>();
  for (const rel of children(rels, 'Relationship')) {
    const type = rel.getAttribute('Type') ?? '';
    if (!documentRelationships.some(ns => [ns + '/worksheet', ns + '/styles', ns + '/sharedStrings', ns + '/chartsheet'].includes(type))) continue;
    const id = rel.getAttribute('Id');
    if (!id || relationships.has(id) || rel.getAttribute('TargetMode') === 'External') throw invalid();
    relationships.set(id, { type: type.slice(type.lastIndexOf('/') + 1), path: localTarget(rel.getAttribute('Target') ?? '') });
  }
  const sheets: XlsxSheet[] = [], ids = new Set<string>(), paths = new Set<string>();
  const container = child(workbook, 'sheets');
  if (!container) throw invalid();
  for (const sheet of children(container, 'sheet')) {
    const name = xlsxString(sheet.getAttribute('name') ?? '');
    const id = documentRelationships.map(ns => sheet.getAttributeNS(ns, 'id')).find(Boolean);
    if (!name || name.length > 255 || !id || ids.has(id)) throw invalid();
    ids.add(id);
    const rel = relationships.get(id);
    if (!rel) throw invalid();
    if (rel.type === 'chartsheet') continue;
    if (rel.type !== 'worksheet' || paths.has(rel.path)
      || overrides.get('/' + rel.path) !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml') throw invalid();
    paths.add(rel.path);
    const state = sheet.getAttribute('state');
    sheets.push({ name, path: rel.path, hidden: state === 'hidden' || state === 'veryHidden' });
  }
  if (sheets.length > limits.sheets) throw xlsxLimitError();
  if (!sheets.length) throw new XlsxPreviewError('This workbook has no worksheets to preview. Download it to open it.');
  const related = (type: string) => {
    const matches = [...relationships.values()].filter(rel => rel.type === type);
    if (matches.length > 1) throw invalid();
    return matches[0] ? files.get(matches[0].path) ?? (() => { throw invalid(); })() : undefined;
  };
  const strings = related('sharedStrings');
  const sharedStrings = strings === undefined ? [] : children(xmlPart(doc, strings, 'sst'), 'si').map(richText);
  const styleText = related('styles'), formats: string[] = [];
  if (styleText !== undefined) {
    const styles = xmlPart(doc, styleText, 'styleSheet'), custom = new Map<number, string>();
    const declared = child(styles, 'numFmts');
    if (declared) for (const format of children(declared, 'numFmt')) {
      const id = integer(format.getAttribute('numFmtId'), 65535), code = format.getAttribute('formatCode');
      if (code === null || code.length > 512 || custom.has(id)) throw invalid();
      custom.set(id, code);
    }
    const xfs = child(styles, 'cellXfs');
    if (xfs) for (const xf of children(xfs, 'xf')) {
      const id = integer(xf.getAttribute('numFmtId') ?? '0', 65535);
      formats.push(custom.get(id) ?? xlsxBuiltinFormat(id));
    }
  }
  if (!formats.length) formats.push('General');
  return { sheets, files, sharedStrings, formats, date1904: ['1', 'true'].includes(child(workbook, 'workbookPr')?.getAttribute('date1904') ?? '') };
};

export const xlsxColumnName = (column: number): string => {
  let name = '';
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
  return name;
};

export const parseXlsxSheet = (doc: Document, workbook: XlsxWorkbook, sheet: XlsxSheet): XlsxSheetData => {
  const root = xmlPart(doc, workbook.files.get(sheet.path), 'worksheet');
  const data = child(root, 'sheetData');
  if (!data) throw invalid();
  const result: XlsxSheetData = { rows: new Map(), rowCount: 0, columnCount: 0, formulas: 0, missingValues: 0 };
  let previousRow = 0, cells = 0, characters = 0;
  for (const row of children(data, 'row')) {
    const rowIndex = integer(row.getAttribute('r') ?? String(previousRow + 1), 1_048_576);
    if (!rowIndex || rowIndex <= previousRow) throw invalid();
    previousRow = rowIndex;
    const values = new Map<number, XlsxCell>(); let previousColumn = 0;
    for (const cell of children(row, 'c')) {
      const address = cell.getAttribute('r'), match = address === null ? null : /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(address);
      if (address !== null && (!match || Number(match[2]) !== rowIndex)) throw invalid();
      const column = match ? [...match[1]!].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) : previousColumn + 1;
      if (column <= previousColumn || column > 16384) throw invalid();
      previousColumn = column;
      const formula = Boolean(child(cell, 'f')), stored = child(cell, 'v'), inline = child(cell, 'is');
      const raw = stored?.textContent ?? '', type = cell.getAttribute('t') ?? 'n';
      // An empty numeric <v/> is also a blank cell, including styled cells at
      // the sheet's far edge. Formula cells still need their missing-result label.
      if (!formula && !inline && (!stored || raw === '' && type === 'n')) continue;
      if (rowIndex > limits.rows || column > limits.columns || ++cells > limits.cells) throw xlsxLimitError();
      const style = integer(cell.getAttribute('s') ?? '0', workbook.formats.length - 1);
      const missing = formula && (!stored || raw === '' && type !== 'str');
      let text = raw;
      if (missing) text = 'Result not saved';
      else if (type === 's') text = workbook.sharedStrings[integer(raw, workbook.sharedStrings.length - 1)] ?? (() => { throw invalid(); })();
      else if (type === 'inlineStr') { if (!inline) throw invalid(); text = richText(inline); }
      else if (type === 'b') { if (!['0', '1'].includes(raw)) throw invalid(); text = raw === '1' ? 'TRUE' : 'FALSE'; }
      else if (type === 'str' || type === 'e' || type === 'd') text = xlsxString(raw);
      else if (type === 'n' && raw) {
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) || !Number.isFinite(Number(raw))) throw invalid();
        text = formatXlsxNumber(raw, workbook.formats[style]!, workbook.date1904);
      } else if (type !== 'n') throw invalid();
      characters += text.length;
      if (text.length > limits.cellCharacters || characters > limits.characters) throw xlsxLimitError();
      values.set(column, { text, raw: type === 'n' ? raw : text, formula, missing });
      result.formulas += Number(formula); result.missingValues += Number(missing);
      result.rowCount = Math.max(result.rowCount, rowIndex); result.columnCount = Math.max(result.columnCount, column);
    }
    if (values.size) result.rows.set(rowIndex, values);
  }
  return result;
};
