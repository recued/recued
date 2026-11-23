export const BROWSER_CONTROL_EVIDENCE_CHARS = 2_500;
export interface BrowserControlItem {
  ref: string;
  kind: 'select' | 'checkbox' | 'radio' | 'combobox' | 'switch' | 'option';
  label: string;
  native: boolean;
  disabled: boolean;
  checked?: boolean | 'mixed';
  expanded?: boolean;
  selected?: boolean;
  group?: string;
  owner_ref?: string;
  options?: Array<{ label: string; value: string; selected: boolean; disabled: boolean }>;
  options_complete?: boolean;
  action: { do: 'type' } | { do: 'click' };
  /** Describes a value to supply; never an action argument. */
  value_kind?: 'option_value_or_label' | 'option_lines' | 'true_or_false' | 'true';
  /** A separate batch step, not a then_read selector. */
  follow_up?: { do: 'read' };
}
export interface BrowserControlEvidence {
  scope: 'page' | 'region' | 'dialog';
  items: BrowserControlItem[];
  complete: boolean;
  incomplete?: string[];
  note: string;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const bool = (value: unknown): value is boolean => typeof value === 'boolean';
const oneOf = (value: unknown, allowed: readonly string[]) => typeof value === 'string' && allowed.includes(value);
const ref = (value: unknown) => text(value, 32) && /^e\d+$/.test(value);
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);
export const isBrowserControlEvidence = (value: unknown): value is BrowserControlEvidence => {
  if (!object(value) || !keys(value, ['scope', 'items', 'complete', 'incomplete', 'note'])
    || !oneOf(value.scope, ['page', 'region', 'dialog']) || !bool(value.complete) || !text(value.note, 500)
    || !optional(value.incomplete, item => Array.isArray(item) && item.length <= 8 && item.every(reason =>
      oneOf(reason, ['page_truncated', 'source_limit', 'scope_limit', 'value_limit', 'item_limit', 'option_limit', 'character_limit', 'observation_limit'])))
    || !Array.isArray(value.items) || value.items.length > 12) return false;
  for (const item of value.items) {
    if (!object(item) || !keys(item, ['ref', 'kind', 'label', 'native', 'disabled', 'checked', 'expanded', 'selected', 'group', 'owner_ref',
      'options', 'options_complete', 'action', 'value_kind', 'follow_up']) || !ref(item.ref) || !text(item.label, 160) || !bool(item.native) || !bool(item.disabled)
      || !oneOf(item.kind, ['select', 'checkbox', 'radio', 'combobox', 'switch', 'option'])
      || !optional(item.checked, state => bool(state) || state === 'mixed') || !optional(item.expanded, bool) || !optional(item.selected, bool)
      || !optional(item.group, group => text(group, 128)) || !optional(item.owner_ref, ref) || !optional(item.options_complete, bool)) return false;
    if (!optional(item.options, options => Array.isArray(options) && options.length <= 12 && options.every(option => object(option)
      && keys(option, ['label', 'value', 'selected', 'disabled']) && text(option.label, 160) && text(option.value, 160)
      && bool(option.selected) && bool(option.disabled)))) return false;
    const action = item.action;
    if (!object(action)) return false;
    if (action.do === 'type') {
      if (!keys(action, ['do']) || !item.native || item.follow_up !== undefined
        || !(item.kind === 'select' ? oneOf(item.value_kind, ['option_value_or_label', 'option_lines'])
          : item.kind === 'checkbox' ? item.value_kind === 'true_or_false' : item.kind === 'radio' && item.value_kind === 'true')) return false;
    } else if (action.do !== 'click' || !keys(action, ['do']) || item.native || item.value_kind !== undefined
      || !object(item.follow_up) || !keys(item.follow_up, ['do']) || item.follow_up.do !== 'read') return false;
  }
  return JSON.stringify(value).length <= BROWSER_CONTROL_EVIDENCE_CHARS;
};
