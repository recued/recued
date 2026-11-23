import { isBrowserNumberFormat, type BrowserNumberFormat, type BrowserNumericReport } from '@recued/contracts';
import type { TransformSchema } from '@recued/transforms';
import { browserDataField as getField } from './browser-data-fields.js';
import { browserDataError } from './browser-data-store.js';

const ranked = new Set(['sort', 'min_by', 'max_by', 'sum']);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const browserNumericSchema = (name: string, schema: TransformSchema | undefined): TransformSchema | undefined => {
  if (!schema || name !== 'to_number' && name !== 'map' && !ranked.has(name)) return schema;
  return { ...schema, format: { type: 'object' }, on_invalid: { type: 'string', enum: name === 'to_number' || name === 'map' ? ['error', 'null'] : ['error', 'exclude'] },
    ...(ranked.has(name) ? { value_type: { type: 'string', enum: ['number'] } } : {}) };
};
export const validateBrowserNumeric = (name: string, params: Record<string, unknown>): void => {
  if ((name === 'map' && params.apply === 'to_number' || name === 'to_number' || ranked.has(name) && params.value_type === 'number')
    && ['field', 'output_field'].some(key => params[key] !== undefined && (typeof params[key] !== 'string' || !params[key].length || params[key].length > 160)))
    throw browserDataError('numeric field/output_field must contain 1-160 characters');
  if (name === 'map' && params.apply !== 'to_number' && (params.format !== undefined || params.on_invalid !== undefined)) throw browserDataError('format/on_invalid on map require apply:"to_number"');
  if (name !== 'to_number' && !ranked.has(name)) return;
  if (params.format !== undefined && !isBrowserNumberFormat(params.format)) throw browserDataError('format needs style:number/currency/percent, distinct decimal/group separators, and an exact currency unit for currency');
  if (ranked.has(name) && (params.format !== undefined || params.on_invalid !== undefined) && params.value_type !== 'number')
    throw browserDataError('numeric ranking needs value_type:"number" before format or on_invalid');
  if (ranked.has(name) && params.value_type === 'number' && params.fields !== undefined) throw browserDataError('typed numeric sort uses one field, not fields');
};

const parse = (input: unknown, format: BrowserNumberFormat): number | undefined => {
  if (typeof input === 'number') return Number.isFinite(input) && (!Number.isInteger(input) || Number.isSafeInteger(input)) ? input : undefined;
  if (typeof input !== 'string' || !input.trim()) return undefined;
  let text = input.trim(), sign = '';
  if (/^[+-]/.test(text)) { sign = text[0]!; text = text.slice(1); }
  if (format.style === 'currency') {
    if (!text.startsWith(format.unit!)) return undefined;
    text = text.slice(format.unit!.length).trim();
    if (!sign && /^[+-]/.test(text)) { sign = text[0]!; text = text.slice(1); }
  }
  if (format.style === 'percent') {
    if (!text.endsWith('%')) return undefined;
    text = text.slice(0, -1).trim();
  }
  const decimal = format.decimal ?? '.';
  if (format.group && text.includes(format.group)) {
    const [mantissa, exponent] = text.split(/[eE]/);
    if (exponent !== undefined) return undefined; // grouped exponent formats need an explicit prior normalization
    const pieces = mantissa!.split(decimal);
    if (pieces.length > 2) return undefined;
    const groups = pieces[0]!.split(format.group);
    if (!/^[0-9]{1,3}$/.test(groups[0]!) || groups.slice(1).some(group => !/^[0-9]{3}$/.test(group))) return undefined;
    text = groups.join('') + (pieces.length === 2 ? '.' + pieces[1] : '');
  } else if (decimal !== '.') {
    if (text.includes('.')) return undefined;
    text = text.replace(decimal, '.');
  }
  if (!/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(text)) return undefined;
  const value = Number(sign + text) / (format.style === 'percent' ? 100 : 1);
  return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)) ? value : undefined;
};
const suggestion = (values: unknown[]): BrowserNumberFormat | undefined => {
  if (!values.length || !values.every(value => typeof value === 'string')) return undefined;
  for (const unit of ['£', '$', '€', '¥']) if (values.every(value => {
    const text = (value as string).trim();
    return text.startsWith(unit) && /^[+-]?[0-9]+(?:\.[0-9]+)?$/.test(text.slice(unit.length));
  })) return { style: 'currency', unit, decimal: '.' };
  return undefined;
};

/** Browser-only strict conversion. Global recipe transforms retain their
 * existing behavior. Failed conversions never masquerade as valid rankings. */
export const executeBrowserNumeric = (name: string, params: Record<string, unknown>): { value: unknown; report: BrowserNumericReport } | undefined => {
  const mapped = name === 'map' && params.apply === 'to_number' && params.expression === undefined;
  const typedRank = ranked.has(name) && params.value_type === 'number';
  if (name !== 'to_number' && !mapped && !typedRank) {
    if (ranked.has(name) && Array.isArray(params.array) && params.array.length && typeof params.field === 'string'
      && params.array.every(row => getField(row, params.field as string) == null)) throw browserDataError('ranking field has no present values; no minimum or first ranked row is established');
    return undefined;
  }
  const format = isBrowserNumberFormat(params.format) ? params.format : { style: 'number' as const };
  const items = name === 'to_number' ? [params.input] : params.array as unknown[];
  const values = items.map(item => name === 'to_number' || params.field === undefined ? item : getField(item, params.field as string));
  const numbers = values.map(value => parse(value, format));
  const invalid = numbers.filter(value => value === undefined).length;
  const report: BrowserNumericReport = { converted: numbers.length - invalid, invalid,
    excluded: params.on_invalid === 'exclude' ? invalid : 0, format,
    ...(typeof params.field === 'string' ? { field: params.field } : {}),
    ...(typeof params.output_field === 'string' ? { output_field: params.output_field } : {}) };
  const suggested = invalid ? suggestion(values) : undefined;
  if (suggested) report.suggested_format = suggested;
  if (invalid && (params.on_invalid ?? 'error') === 'error' || typedRank && items.length > 0 && report.converted === 0) {
    throw Object.assign(browserDataError(`numeric conversion failed for ${invalid} of ${items.length} values; declare the observed format before comparing. No raw values were changed`), { browser_numeric_issue: report });
  }
  if (name === 'to_number') return { value: numbers[0] ?? null, report };
  if (mapped) return { value: items.map((item, index) => ({ ...(item as Record<string, unknown>), [params.output_field as string]: numbers[index] ?? null })), report };
  const selected = items.flatMap((item, index) => numbers[index] === undefined ? [] : [{ item, number: numbers[index]! }]);
  if (name === 'sum') {
    const total = selected.reduce((sum, entry) => sum + entry.number, 0);
    if (!Number.isFinite(total) || Number.isInteger(total) && !Number.isSafeInteger(total))
      throw Object.assign(browserDataError('numeric sum exceeds the finite, safe numeric range'), { browser_numeric_issue: report });
    return { value: total, report };
  }
  const descending = name === 'max_by' || name === 'sort' && params.direction === 'desc';
  selected.sort((a, b) => (descending ? -1 : 1) * (a.number - b.number));
  if (name === 'sort') return { value: selected.map(entry => entry.item), report };
  return { value: selected[0]?.item ?? null, report };
};
