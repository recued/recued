import { VALUE_HINT_KEYS, RECIPE_PAGE_BINDING_KEYS, type RecipePageBinding, type ValueHint } from '@recued/contracts';

type Key = (typeof VALUE_HINT_KEYS)[number];
type FieldType<T> = unknown extends T ? 'any' : NonNullable<T> extends boolean ? 'boolean'
  : NonNullable<T> extends readonly unknown[] ? 'array' : NonNullable<T> extends object ? 'object' : 'string';
type Declarations = { [K in Key]: { type: FieldType<ValueHint[K]>; required: {} extends Pick<ValueHint, K> ? false : true; description: string } };
export interface ValueHintField { key: Key; type: 'any' | 'boolean' | 'array' | 'object' | 'string'; required: boolean; description: string }

/** Keys come from the contract; mapped types keep the editing hints aligned with its members. */
const fields: Declarations = {
  label: { type: 'string', required: true, description: 'A non-empty label shown when the owner configures this variable.' },
  type: { type: 'string', required: true, description: 'A non-empty input type name. New type names remain valid for forward compatibility; unknown types fall back to text rendering.' },
  optional: { type: 'boolean', required: false, description: 'true lets the owner skip this variable. Omitting optional, or setting it to false, requires a value.' },
  default: { type: 'any', required: false, description: 'The default input value. Review its meaning with the selected type; mail_template variables have no authored default.' },
  help: { type: 'string', required: false, description: 'Help text for the owner configuring this input.' },
  link: { type: 'string', required: false, description: 'A supporting link for configuring this input.' },
  options: { type: 'array', required: false, description: 'Non-empty string choices. An enum needs at least one option; its first option is the default. List settings can also use supported shared vocabularies.' },
  provider: { type: 'string', required: false, description: 'Provider name used to route an OAuth input through the broker.' },
  scopes: { type: 'array', required: false, description: 'Non-empty scope strings requested for an OAuth input.' },
  accept_mime_types: { type: 'array', required: false, description: 'Non-empty MIME type strings used to narrow file picker results. File operations still enforce access.' },
  connection_kind: { type: 'string', required: false, description: 'The connection registry family used by a connection input. This does not choose a connection or grant access.' },
  entity: { type: 'string', required: false, description: 'The local entity kind searched by a record_ref picker. Required for record_ref and meaningful only on that type.' },
  entity_filter: { type: 'object', required: false, description: 'Equality filters for a record_ref picker, with non-empty string field values. This narrows discovery and does not grant execution authority.' },
  starter: { type: 'object', required: false, description: 'An authored mail template definition for a mail_template input. Install creates its template; source cannot name the installed template ID.' },
  page_binding: { type: 'object', required: false, description: 'Seed an editable Run input from a selected page object using kind and field, with optional platform. Credentials and setup settings stay manual; record_ref must select its own entity ID.' },
};
export const valueHintFields = (): ValueHintField[] => VALUE_HINT_KEYS.map(key => ({ key, ...fields[key] }));
export const valueHintField = (name: string): ValueHintField | undefined => {
  const key = VALUE_HINT_KEYS.find(key => key === name); return key ? { key, ...fields[key] } : undefined;
};

type BindingKey = (typeof RECIPE_PAGE_BINDING_KEYS)[number];
export interface RecipePageBindingField { key: BindingKey; type: 'string'; required: boolean; description: string }
const bindingFields: { [K in BindingKey]: { type: FieldType<RecipePageBinding[K]>; required: {} extends Pick<RecipePageBinding, K> ? false : true; description: string } } = {
  kind: { type: 'string', required: true, description: 'The selected page object kind that seeds this input. For record_ref it must match the variable entity.' },
  field: { type: 'string', required: true, description: 'An own-property path on the selected page object. Internal and prototype fields are refused. A record_ref must select id.' },
  platform: { type: 'string', required: false, description: 'Vendor domain for an API page object; omit it for local objects. A record_ref page binding must omit platform.' },
};
export const recipePageBindingFields = (): RecipePageBindingField[] => RECIPE_PAGE_BINDING_KEYS.map(key => ({ key, ...bindingFields[key] }));
export const recipePageBindingField = (name: string): RecipePageBindingField | undefined => {
  const key = RECIPE_PAGE_BINDING_KEYS.find(key => key === name); return key ? { key, ...bindingFields[key] } : undefined;
};

/** These unsupported legacy keys need an explicit semantic decision, not a spelling correction. */
export const valueHintUnsupportedFieldHelp = (key: string): string | undefined => key === 'required'
  ? 'required is not a variable field. Use optional: true for a skippable input; omitting optional requires a value. Review the intended behavior before changing this key.'
  : key === 'min' || key === 'max' ? 'Variable hints have no min or max field. Review the intended bounds and express their checks explicitly in recipe logic.' : undefined;
