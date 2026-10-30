import { TABLE_EDIT_KEYS, TABLE_SELECT_KEYS, TABLE_COLUMN_KEYS, TABLE_COLUMN_CONTROLS, TABLE_EDIT_ROW_MODES,
  type TableEditSpec, type TableSelectSpec, type TableAppendedColumn } from '@recued/contracts';
export type TableAuthoringKind = 'edit' | 'select' | 'column';
export interface TableAuthoringField { key: string; type: 'string' | 'array' | 'object'; description: string; required: boolean }
type Field = Omit<TableAuthoringField, 'key' | 'required'>;
const edit: Record<keyof TableEditSpec, Field> = {
  into: { type: 'string', description: 'Declared variable receiving an array of edited row objects. Submission starts a fresh recipe run.' },
  submit: { type: 'string', description: 'Non-empty label on the button that submits the rows.' },
  rows: { type: 'string', description: 'fixed corrects existing rows and requires an entity for identity. add_remove composes rows and also works without an entity.' },
  hidden: { type: 'array', description: 'Declared run-level variables carried into the fresh submission so settings do not revert to their defaults. Prefer visible columns for row data.' },
  columns: { type: 'array', description: 'Column keys the owner may edit. Required without an entity; with declared table fields, each must be shown.' },
  scopes: { type: 'object', description: 'Picker equality scopes by editable column, as { column: { field: value } }. A discovery aid; execution authority is checked separately.' },
};
const select: Record<keyof TableSelectSpec, Field> = {
  into: { type: 'string', description: 'Declared variable receiving an array of selected row ids. A typed declaration must be array; use an empty-array default for a view that can run before a selection.' },
  submit: { type: 'string', description: 'Non-empty label on the selection action button.' },
  id_field: { type: 'string', description: 'Row field carrying the submitted identity. Required without an entity; an entity can supply its identity field. This need not be a shown column.' },
  hidden: { type: 'array', description: 'Declared run-level variables carried with the selected ids into the fresh recipe run. Excludes the selection variable itself.' },
};
const column: Record<keyof TableAppendedColumn, Field> = {
  field: { type: 'string', description: 'Key on the source row; also the identity used by edit.columns. Matching an entity field overrides its presentation.' },
  label: { type: 'string', description: 'Required visible column heading. Authored columns have no label to derive automatically.' },
  kind: { type: 'string', description: 'Open-ended entity field kind, such as date or decimal. Omit to inherit the entity kind or use plain text for an appended field.' },
  control: { type: 'string', description: 'Input presentation for an editable cell. Select and radio require options. Read-only cells ignore it; the receiving recipe still validates submitted strings.' },
  options: { type: 'array', description: 'Non-empty string choices for select or radio controls. Choices describe presentation and do not grant write authority.' },
};
const rowHelp: Record<NonNullable<TableEditSpec['rows']>, string> = {
  fixed: 'Correct existing rows, preserving identity from the entity schema.',
  add_remove: 'Allow new rows and row removal; editable columns must be explicit without an entity.',
};
const controlHelp: Record<NonNullable<TableAppendedColumn['control']>, string> = {
  text: 'A single-line string input.', select: 'A choice from the declared options.', radio: 'Radio choices from the declared options.', textarea: 'A multiline string input.',
};
export const tableAuthoringFields = (kind: TableAuthoringKind, hasEntity: boolean): TableAuthoringField[] => {
  const [keys, fields] = kind === 'edit' ? [TABLE_EDIT_KEYS, edit] : kind === 'select' ? [TABLE_SELECT_KEYS, select] : [TABLE_COLUMN_KEYS, column];
  return keys.map(key => ({ key, ...(fields as Record<string, Field>)[key]!, required: kind === 'column' ? key === 'field' || key === 'label'
    : key === 'into' || key === 'submit' || !hasEntity && (kind === 'edit' ? key === 'columns' : key === 'id_field') }));
};
export const tableAuthoringChoices = (kind: TableAuthoringKind, field: string, hasEntity: boolean): { value: string; description: string }[] =>
  kind === 'edit' && field === 'rows' ? TABLE_EDIT_ROW_MODES.filter(value => hasEntity || value !== 'fixed').map(value => ({ value, description: rowHelp[value] }))
    : kind === 'column' && field === 'control' ? [...TABLE_COLUMN_CONTROLS].map(value => ({ value, description: controlHelp[value] })) : [];
