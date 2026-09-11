import type { ParamDef } from '@recued/transforms';

export interface FieldDraft { text: string; error: string }
export interface ReferenceChoice { value: string; label: string }
const isReference = (value: unknown): value is string => typeof value === 'string' && /\{\{[^}]+\}\}/.test(value);
const editorType = (value: unknown, schema?: ParamDef): string => schema?.type
  ?? (value === null || value === undefined || isReference(value) ? 'any' : Array.isArray(value) ? 'array' : typeof value);

export const parseEditorValue = (
  text: string, value: unknown, schema?: ParamDef, allowBareText = false,
): { value: unknown; error?: never } | { error: string; value?: never } => {
  const raw = text.trim();
  if (/\{\{[^}]+\}\}/.test(raw) && (raw.startsWith('{{') || (!raw.startsWith('[') && !raw.startsWith('{') && !raw.startsWith('"')))) return { value: text };
  const type = editorType(value, schema);
  if (raw === '' && schema?.required) return { error: 'This field is required.' };
  if (raw === '' && allowBareText) return { value: '' };
  if (raw === '' && type !== 'string') return { value: undefined };
  if (type === 'string') return { value: text };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (type === 'number' && (typeof parsed !== 'number' || !Number.isFinite(parsed))) {
      return { error: 'Enter a number or a reference.' };
    }
    if (type === 'array' && !Array.isArray(parsed)) return { error: 'Enter a JSON array or a reference.' };
    if (type === 'object' && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) {
      return { error: 'Enter a JSON object or a reference.' };
    }
    if (type === 'boolean' && typeof parsed !== 'boolean') return { error: 'Enter true or false.' };
    return { value: parsed };
  } catch {
    // Operation arguments retain their existing plain-text shorthand, but an
    // unfinished JSON container or quoted string must never become plain text.
    if (allowBareText && !/^[\[{"]/.test(raw)) return { value: text };
    return { error: 'Enter valid JSON (put text in double quotes) or a reference.' };
  }
};

/** Keeps unfinished JSON in a separate draft; it never silently saves an old value. */
export const createValueEditor = (options: {
  document: Document;
  fieldAttribute: string;
  fieldKey: string;
  label: string;
  value: unknown;
  schema?: ParamDef;
  draft?: FieldDraft;
  references?: () => ReferenceChoice[];
  change(value: unknown, draft?: FieldDraft): void;
  chooseReference(value: string): void;
}): HTMLElement => {
  const { document: doc, value, schema } = options;
  const host = doc.createElement('div');
  host.className = 'recipe-editor-value';
  const isRef = isReference(value);
  const type = editorType(value, schema);
  const error = doc.createElement('span');
  error.className = 'recipe-editor-field-error';
  error.setAttribute('role', 'status');
  error.textContent = options.draft?.error ?? '';
  const text = options.draft?.text ?? (value === undefined || (value === null && type !== 'any')
    ? '' : typeof value === 'string' && (type !== 'any' || isRef) ? value : JSON.stringify(value, null, 2));
  let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  const apply = (): void => {
    const parsed = parseEditorValue(input.value, value, schema);
    error.textContent = parsed.error ?? '';
    if (parsed.error !== undefined) {
      input.setAttribute('aria-invalid', 'true');
      options.change(value, { text: input.value, error: parsed.error });
    } else {
      input.removeAttribute('aria-invalid');
      options.change(parsed.value);
    }
  };
  if (!isRef && options.draft === undefined && schema?.enum) {
    input = doc.createElement('select');
    const choices = ['', ...schema.enum];
    if (typeof value === 'string' && !choices.includes(value)) choices.push(value);
    for (const choice of choices) {
      const option = doc.createElement('option');
      option.value = choice;
      option.textContent = choice || 'Not set';
      option.selected = value === choice || (choice === '' && value === undefined);
      input.appendChild(option);
    }
    input.value = text;
    input.addEventListener('change', () => {
      if (input.value === '' && !schema.required) options.change(undefined);
      else apply();
    });
  } else if (!isRef && type === 'boolean' && options.draft === undefined) {
    const checkbox = doc.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = value === true;
    checkbox.addEventListener('change', () => options.change(checkbox.checked));
    input = checkbox;
  } else {
    const structured = !isRef && (type === 'array' || type === 'object' || type === 'any');
    if (structured || text.length > 100 || text.includes('\n')) {
      const area = doc.createElement('textarea');
      area.rows = Math.min(8, Math.max(2, text.split('\n').length));
      input = area;
    } else {
      const field = doc.createElement('input');
      // Native number inputs expose unfinished '-' / exponent text as an
      // empty value, so a repaint would erase the owner's actual draft.
      field.type = 'text';
      if (type === 'number' && !isRef) field.inputMode = 'decimal';
      input = field;
    }
    input.value = text;
    input.addEventListener('input', apply);
    if (structured) input.setAttribute('placeholder', type === 'array' ? '[] or {{step.source}}' : 'JSON or {{step.source}}');
  }
  input.setAttribute(options.fieldAttribute, options.fieldKey);
  input.setAttribute('aria-label', options.label);
  if (options.draft) input.setAttribute('aria-invalid', 'true');
  host.appendChild(input);
  host.appendChild(error);
  if (options.references) {
    const picker = doc.createElement('select');
    picker.className = 'recipe-editor-reference-picker';
    picker.setAttribute('aria-label', `Use a reference for ${options.label}`);
    picker.setAttribute('data-recued-recipe-reference', options.fieldKey);
    const placeholder = doc.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Insert reference…';
    picker.appendChild(placeholder);
    // Populate only when used: hundreds of fields must not each mount hundreds of options.
    const populate = (): void => {
      while (picker.children.length > 1) picker.removeChild(picker.children[1]!);
      for (const choice of options.references?.() ?? []) {
        const option = doc.createElement('option');
        option.value = choice.value;
        option.textContent = choice.label;
        picker.appendChild(option);
      }
    };
    picker.addEventListener('focus', populate);
    picker.addEventListener('pointerdown', populate);
    picker.addEventListener('change', () => {
      if (picker.value) options.chooseReference(picker.value);
    });
    host.appendChild(picker);
  }
  return host;
};
