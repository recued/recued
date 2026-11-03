import { isRecordsAction, RECORDS_ACTIONS, type RecordsAuthorBinding } from '@recued/contracts';
import { RECORDS_BIND_KEYS } from './records.js';

export interface RecordsBindingField { key: string; type: 'string' | 'array' | 'object'; description: string; required: boolean }
type Field = Omit<RecordsBindingField, 'key' | 'required'>;
const fields: Record<keyof RecordsAuthorBinding, Field> = {
  kind: { type: 'string', description: 'core.records binds this operation to this pack\'s Records store. It does not select risk, approval or grants.' },
  action: { type: 'string', description: 'The Records action owned by this binding. Review its argument contract and operation policies after changing it.' },
  entity: { type: 'string', description: 'The exact entity declared in this Records composition. Caller arguments cannot change its namespace.' },
  filter_fields: { type: 'array', description: 'Non-empty unique friendly fields admitted for query filters. Protected id, unindexed text and dotted aliases are excluded.' },
  sort_fields: { type: 'array', description: 'Non-empty unique ordered fields admitted for sorting, plus _record.created_at or _record.updated_at. Text, reference and ordinary string slots are not ordered.' },
  natural_key: { type: 'array', description: 'Create only: declared required writable fields that identify a natural-key row. A natural-key create must not declare a caller id argument.' },
  select: { type: 'object', description: 'Aggregate only: the binding-owned rollup shape. Caller filters do not choose what is computed.' },
  group_by: { type: 'string', description: 'Aggregate only: the binding-owned grouping field. Its eligible kinds are checked by canonical validation.' },
  allow: { type: 'array', description: 'Batch only: the binding-owned entity/action pairs admitted in the caller\'s ops. These are explicit policy decisions.' },
};
export const recordsBindingFields = (action: unknown): RecordsBindingField[] => [...(isRecordsAction(action) ? RECORDS_BIND_KEYS[action] : ['kind', 'action', 'entity'])].map(key => ({
  key, ...fields[key as keyof RecordsAuthorBinding], required: ['kind', 'action', 'entity'].includes(key) || key === 'select' && action === 'aggregate' || key === 'allow' && action === 'batch',
}));
export const recordsBindingActions = (): readonly string[] => RECORDS_ACTIONS;
