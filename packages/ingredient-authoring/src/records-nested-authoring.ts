import {
  isRecordsAggregateFn, RECORDS_AGGREGATE_FNS, RECORDS_AGGREGATE_VALIDITY, RECORDS_AGGREGATE_ORDERABLE,
  RECORDS_GROUP_BY_KINDS, type RecordsFieldKind,
} from '@recued/contracts';

interface Field { key: string; description: string; required: boolean }
const countHelp = 'Without field, count counts rows; with field, it counts only non-null values. No field is added automatically.';
export const recordsAggregateFields = (fn: unknown): Field[] => [
  { key: 'fn', required: true, description: 'The declared rollup function. Compatible functions follow the selected field kind. ' + countHelp },
  { key: 'field', required: isRecordsAggregateFn(fn) && fn !== 'count', description: 'A friendly field of this binding entity, compatible with the chosen function. ' + countHelp },
  ...(['latest', 'earliest'].includes(String(fn)) ? [{ key: 'by', required: true, description: 'Explicit ordering field for latest/earliest: number, decimal, date or datetime. The returned value comes from field.' }] : []),
];
export const recordsAggregateFunctions = (kind?: RecordsFieldKind): readonly string[] =>
  kind ? RECORDS_AGGREGATE_VALIDITY[kind] : RECORDS_AGGREGATE_FNS;
export const recordsAggregateFieldAllowed = (key: 'field' | 'by' | 'group_by', fn: unknown, kind: RecordsFieldKind): boolean =>
  key === 'group_by' ? RECORDS_GROUP_BY_KINDS.includes(kind)
    : key === 'by' ? (fn === 'latest' || fn === 'earliest') && RECORDS_AGGREGATE_ORDERABLE.includes(kind)
      : fn === undefined || fn === '' || isRecordsAggregateFn(fn) && RECORDS_AGGREGATE_VALIDITY[kind].includes(fn);
export const recordsBatchFields = (): Field[] => [
  { key: 'entity', required: true, description: 'The exact local entity this batch may write. The caller supplies rows, not the admitted entity/action pairs.' },
  { key: 'action', required: true, description: 'An explicitly admitted batch write action. Nested batches and reads are excluded. Review risk and approval when changing the allow list.' },
];
