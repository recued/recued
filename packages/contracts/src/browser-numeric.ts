export interface BrowserNumberFormat {
  style: 'number' | 'currency' | 'percent';
  decimal?: '.' | ',';
  group?: '.' | ',' | ' ';
  unit?: string;
}
export interface BrowserNumericReport {
  converted: number;
  invalid: number;
  excluded: number;
  format: BrowserNumberFormat;
  field?: string;
  output_field?: string;
  suggested_format?: BrowserNumberFormat;
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isBrowserNumberFormat = (v: unknown): v is BrowserNumberFormat => object(v)
  && Object.keys(v).every(key => ['style', 'decimal', 'group', 'unit'].includes(key))
  && ['number', 'currency', 'percent'].includes(String(v.style))
  && (v.decimal === undefined || v.decimal === '.' || v.decimal === ',')
  && (v.group === undefined || ['.', ',', ' '].includes(String(v.group)) && v.group !== (v.decimal ?? '.'))
  && (v.style === 'currency' ? typeof v.unit === 'string' && /^(?:[£$€¥]|[A-Z]{3})$/.test(v.unit) : v.unit === undefined);
export const isBrowserNumericReport = (v: unknown): v is BrowserNumericReport => object(v)
  && Object.keys(v).every(key => ['converted', 'invalid', 'excluded', 'format', 'field', 'output_field', 'suggested_format'].includes(key))
  && ['converted', 'invalid', 'excluded'].every(key => Number.isSafeInteger(v[key]) && Number(v[key]) >= 0 && Number(v[key]) <= 5_000)
  && Number(v.excluded) <= Number(v.invalid) && isBrowserNumberFormat(v.format)
  && ['field', 'output_field'].every(key => v[key] === undefined || typeof v[key] === 'string' && v[key].length > 0 && v[key].length <= 160)
  && (v.suggested_format === undefined || isBrowserNumberFormat(v.suggested_format));
