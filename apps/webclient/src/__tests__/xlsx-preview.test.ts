import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { readXlsxParts } from '../files/xlsx-parts.js';
import { XLSX_PREVIEW_LIMITS } from '../files/xlsx-model.js';
import { formatXlsxNumber, xlsxString } from '../files/xlsx-values.js';

const archive = (sheet = '<worksheet/>') => zipSync({
  'xl/worksheets/sheet1.xml': strToU8(sheet), '[Content_Types].xml': strToU8('<Types/>'),
  'xl/workbook.xml': strToU8('<workbook/>'), 'xl/_rels/workbook.xml.rels': strToU8('<Relationships/>'),
  'xl/media/large.bin': new Uint8Array(XLSX_PREVIEW_LIMITS.xmlBytes + 1),
});

describe('XLSX preview input and saved values', () => {
  it('extracts worksheet parts without inflating embedded content or changing the original download', () => {
    const bytes = archive(), original = bytes.slice();
    expect(new Map(readXlsxParts(bytes).files)).toEqual(new Map([
      ['xl/worksheets/sheet1.xml', '<worksheet/>'], ['[Content_Types].xml', '<Types/>'],
      ['xl/workbook.xml', '<workbook/>'], ['xl/_rels/workbook.xml.rels', '<Relationships/>'],
    ]));
    expect(bytes).toEqual(original);
  });

  it('rejects actual oversized expansion, forged lengths, broken packages and XML entities', () => {
    expect(() => readXlsxParts(archive('x'.repeat(XLSX_PREVIEW_LIMITS.xmlBytes + 1)))).toThrow('limits');
    const forged = archive('x'.repeat(XLSX_PREVIEW_LIMITS.xmlBytes + 1));
    const view = new DataView(forged.buffer, forged.byteOffset, forged.byteLength);
    // Lie about the first entry in both headers; actual expansion must still stop.
    view.setUint32(22, 0, true);
    for (let index = 0; index + 28 < forged.length; index++) if (view.getUint32(index, true) === 0x02014b50) { view.setUint32(index + 24, 0, true); break; }
    expect(() => readXlsxParts(forged)).toThrow('limits');
    expect(() => readXlsxParts(new Uint8Array())).toThrow('supported XLSX');
    expect(() => readXlsxParts(zipSync({ 'other.xml': strToU8('<worksheet/>') }))).toThrow('supported XLSX');
    expect(() => readXlsxParts(archive('<!DOCTYPE a [<!ENTITY x "expanded">]><worksheet/>'))).toThrow('XML declarations');
  });

  it('preserves raw precision and escaped strings while displaying common dates and saved numbers', () => {
    expect(xlsxString('_x005F_x0041_ / first_x000A_second')).toBe('_x0041_ / first\nsecond');
    expect(formatXlsxNumber('00125.500', 'General', false)).toBe('00125.500');
    expect(formatXlsxNumber('9007199254740993', '0', false)).toBe('9007199254740993');
    expect(formatXlsxNumber('0.125', '0.00%', false)).toBe('12.50%');
    expect(formatXlsxNumber('1234.5', '#,##0.00', false)).toBe('1,234.50');
    expect(formatXlsxNumber('59.99', 'mm-dd-yy', false)).toBe('1900-02-28');
    expect(formatXlsxNumber('60', 'mm-dd-yy', false)).toBe('1900-02-29');
    expect(formatXlsxNumber('61', 'mm-dd-yy', false)).toBe('1900-03-01');
    expect(formatXlsxNumber('0', 'mm-dd-yy', true)).toBe('1904-01-01');
    expect(formatXlsxNumber('2958465', 'mm-dd-yy', false)).toBe('9999-12-31');
    expect(formatXlsxNumber('2957004', 'mm-dd-yy', true)).toBe('2957004');
    expect(formatXlsxNumber('2958465.5', 'yyyy-mm-dd hh:mm:ss', false)).toBe('9999-12-31 12:00:00');
    expect(formatXlsxNumber('1.5', '[h]:mm:ss', false)).toBe('36:00:00');
    expect(formatXlsxNumber('0.5', '[m]', false)).toBe('720');
    expect(formatXlsxNumber('0.5', '[m]:ss', false)).toBe('720:00');
    expect(formatXlsxNumber('0.000001', '[s].000', false)).toBe('0.000001');
    expect(formatXlsxNumber('12', '0 "m; units"', false)).toBe('12');
    expect(formatXlsxNumber('0.5', '[>=1]yyyy-mm-dd;0.00', false)).toBe('0.5');
    expect(formatXlsxNumber('-.125', '0.0%;0.00', false)).toBe('-.125');
    expect(formatXlsxNumber('45292', 'unsupported', false)).toBe('45292');
  });
});
