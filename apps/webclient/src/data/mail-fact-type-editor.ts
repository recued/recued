/**
 * D-315 §4.5 — a kind of email the owner makes: its name, the variables a fact
 * of it has (a kind each; the needed ones are its default entrance), its
 * states and notices, how one thing is told from another across emails, and
 * data fields for the template editor and the AI.
 *
 * Made from the template editor's "Kind of email" picker, or from the list of
 * kinds the owner made. Once saved it only grows: a variable, value, state or
 * notice its facts, templates or triggers name cannot go, and how one thing is
 * told from another stays (the server refuses the same).
 *
 * Renders HTML strings like the rest of Mail facts; the Templates view forwards
 * its actions (`mail-facts-ty-*`), selects and checkboxes (`change`) and text
 * fields (`input`, keys `ty:*`). A text field updates the form without a
 * repaint, so typing is never interrupted — and never on its `change` either:
 * that fires as focus leaves, on the press of whatever is clicked next, and a
 * repaint then replaces the button under the pointer and the click is lost.
 * So nothing on the form is drawn from a name while it is typed: whether a
 * variable tells one thing from another is ticked on its own row.
 */

import {
  MAIL_FACT_VARIABLE_KINDS,
  type MailFactDataFieldSpec,
  type MailFactTypeSpec,
  type MailFactVariableKind,
} from '@recued/contracts';
import { e } from '@recued/ui-shared';

import { humanizeRpcError } from '../shell/rpc-error-copy.js';

export interface MailFactTypeCallers {
  readonly listTypes?: () => Promise<{ readonly types: readonly MailFactTypeSpec[] }>;
  readonly createType?: (args: { spec: MailFactTypeSpec }) => Promise<{ readonly type: MailFactTypeSpec }>;
  readonly updateType?: (args: { spec: MailFactTypeSpec }) => Promise<{ readonly type: MailFactTypeSpec }>;
  readonly deleteType?: (args: { type_id: string }) => Promise<{ readonly deleted: boolean }>;
}

interface VariableRow {
  readonly name: string;
  readonly kind: MailFactVariableKind;
  readonly required: boolean;
  /** An enum's values, as typed: comma-separated. */
  readonly values: string;
  readonly description: string;
  /** A new kind only: one of the values that tell one thing from another. */
  readonly identity: boolean;
  /** Saved before: its name and kind stay, and its values can only grow. */
  readonly locked: boolean;
}

interface DataRow {
  readonly path: string;
  readonly kind: MailFactDataFieldSpec['kind'];
  readonly description: string;
}

interface TypeForm {
  readonly original: MailFactTypeSpec | null;
  readonly name: string;
  readonly description: string;
  readonly variables: readonly VariableRow[];
  readonly states: string;
  readonly notices: string;
  readonly dataFields: readonly DataRow[];
  readonly saving: boolean;
  readonly error: string | null;
  readonly problems: readonly string[];
  /** "Data fields", open or shut across repaints. */
  readonly dataOpen: boolean;
  /** Which form this is: a save answers only the form it came from. A new
   *  kind's form has no original, so that cannot tell two new forms apart. */
  readonly session: number;
  /** A save landed while the owner went on editing: what it sent is saved,
   *  and the changes since are not. */
  readonly saved: boolean;
}

const KIND_WORDS: Readonly<Record<MailFactVariableKind, string>> = {
  text: 'Text',
  number: 'A number',
  boolean: 'Yes or no',
  enum: 'One of a list',
  money: 'Money',
  date: 'A date',
  datetime: 'A date and time',
  id: 'An id or code',
  file: 'An attachment',
};

const DATA_KIND_WORDS: Readonly<Record<MailFactDataFieldSpec['kind'], string>> = {
  ...KIND_WORDS,
  list: 'A list (line items)',
  object: 'A group of values',
};

/** A name as it is saved (§4.5): lower-case words joined by _, so "Box-ID"
 *  is `box_id` rather than a refusal. */
const wordOf = (raw: string): string => raw.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** A kind of email's id from its name: `custom_` and at most 40 of
 *  `[a-z0-9_]` (§4.5). */
export const mailFactTypeIdOf = (name: string): string => {
  const slug = wordOf(name).slice(0, 40).replace(/_+$/g, '');
  return `custom_${slug.length > 0 ? slug : 'kind'}`;
};

const variableName = wordOf;

const words = (text: string): string[] =>
  [...new Set(text.split(',').map(wordOf).filter((word) => word.length > 0))];

/** A data path as it is saved: its parts, each a name, joined by dots. */
const dataPath = (raw: string): string => raw.split('.').map(wordOf).filter((part) => part.length > 0).join('.');

const blankVariable = (): VariableRow =>
  ({ name: '', kind: 'text', required: false, values: '', description: '', identity: false, locked: false });

const formOf = (spec: MailFactTypeSpec | null): TypeForm => ({
  original: spec,
  name: spec?.name ?? '',
  description: spec?.description ?? '',
  variables: spec === null
    ? [{ ...blankVariable(), required: true }]
    : spec.variables.map((variable) => ({
        name: variable.name,
        kind: variable.kind,
        required: variable.required,
        values: (variable.values ?? []).join(', '),
        description: variable.description ?? '',
        // A saved kind keeps how it tells one thing from another (§4.5).
        identity: false,
        locked: true,
      })),
  states: (spec?.states ?? []).join(', '),
  notices: (spec?.notices ?? []).join(', '),
  dataFields: (spec?.data_fields ?? []).map((field) => ({ path: field.path, kind: field.kind, description: field.description ?? '' })),
  saving: false,
  error: null,
  problems: [],
  dataOpen: (spec?.data_fields ?? []).length > 0,
  session: 0,
  saved: false,
});

/** The form as the type it describes: one way to tell one thing from another
 *  (the contract allows several; a saved type keeps what it has). */
export const specFromTypeForm = (form: Pick<TypeForm, 'original' | 'name' | 'description' | 'variables' | 'states' | 'notices' | 'dataFields'>): MailFactTypeSpec => {
  const named = form.variables.filter((variable) => variableName(variable.name).length > 0);
  const variables = named
    .map((variable) => ({
      name: variableName(variable.name),
      kind: variable.kind,
      required: variable.required,
      ...(variable.kind === 'enum' ? { values: words(variable.values) } : {}),
      ...(variable.description.trim().length > 0 ? { description: variable.description.trim() } : {}),
    }));
  const telling = [...new Set(named
    .filter((variable) => variable.identity && variable.kind !== 'file')
    .map((variable) => variableName(variable.name)))];
  const identity = form.original !== null ? form.original.identity : telling.length > 0 ? [telling] : [];
  return {
    id: (form.original?.id ?? mailFactTypeIdOf(form.name)) as MailFactTypeSpec['id'],
    name: form.name.trim(),
    description: form.description.trim(),
    variables,
    states: words(form.states),
    notices: words(form.notices),
    identity,
    data_fields: form.dataFields
      .filter((field) => dataPath(field.path).length > 0)
      .map((field) => ({
        path: dataPath(field.path),
        kind: field.kind,
        ...(field.description.trim().length > 0 ? { description: field.description.trim() } : {}),
      })),
  };
};

const problemsOf = (error: unknown): string[] => {
  const problems = (error as { details?: { problems?: unknown } } | null)?.details?.problems;
  return Array.isArray(problems) ? problems.filter((p): p is string => typeof p === 'string') : [];
};

const option = (value: string, label: string, selected: boolean): string =>
  `<option value="${e(value)}"${selected ? ' selected' : ''}>${e(label)}</option>`;

export interface MailFactTypeEditorDeps {
  readonly callers: MailFactTypeCallers;
  readonly actionAttr: string;
  readonly fieldAttr: string;
  readonly focusAttr: string;
  readonly render: () => void;
  readonly focus: (key: string) => void;
  /** Saved: the kind as the server stored it. `current` is false when the
   *  form was left while it saved: the kind exists, and nothing else moves. */
  readonly onSaved: (type: MailFactTypeSpec, current: boolean) => void;
  /** Closed without saving. */
  readonly onCancelled: () => void;
}

export interface MailFactTypeEditor {
  isOpen(): boolean;
  /** `null` for a new kind of email. */
  open(spec: MailFactTypeSpec | null): void;
  close(): void;
  /** The form has changes not saved. */
  isDirty(): boolean;
  isSaving(): boolean;
  render(): string;
  handleAction(action: string, target: HTMLElement): boolean;
  handleChange(target: HTMLElement): boolean;
  handleInput(target: HTMLElement): boolean;
}

export const createMailFactTypeEditor = (deps: MailFactTypeEditorDeps): MailFactTypeEditor => {
  const { actionAttr, fieldAttr, focusAttr } = deps;
  let form: TypeForm | null = null;
  /** Forms opened so far: each is a session its save must still be in. */
  let sessions = 0;
  /** The kind as the form opened, or as it was last saved, to tell a change
   *  from none. */
  let opened = '';
  const asSaved = (current: TypeForm): string => JSON.stringify(specFromTypeForm(current));

  const set = (next: Partial<TypeForm>): void => {
    if (form !== null) form = { ...form, ...next };
  };
  /** A variable that is saved, or being saved, keeps its name and kind: a
   *  kind grows and never loses one (§4.5). */
  const fixedVariable = (index: number): boolean =>
    form !== null && (form.saving || form.variables[index]?.locked === true);
  const setVariable = (index: number, next: Partial<VariableRow>): void => {
    if (form === null) return;
    set({ variables: form.variables.map((variable, i) => (i === index ? { ...variable, ...next } : variable)), problems: [] });
  };
  const setData = (index: number, next: Partial<DataRow>): void => {
    if (form === null) return;
    set({ dataFields: form.dataFields.map((field, i) => (i === index ? { ...field, ...next } : field)) });
  };

  const save = async (): Promise<void> => {
    if (form === null || form.saving) return;
    const spec = specFromTypeForm(form);
    const call = form.original === null ? deps.callers.createType : deps.callers.updateType;
    if (call === undefined) return;
    // What this save sends: the fields stay editable while it runs.
    const { session } = form;
    const sent = asSaved(form);
    set({ saving: true, error: null, problems: [], saved: false });
    deps.render();
    try {
      const { type } = await call({ spec });
      // The form was left, or another opened — a new one included — while it saved.
      const current = form !== null && form.session === session;
      if (current && asSaved(form!) === sent) {
        form = null;
      } else if (current) {
        // Changed while it saved: the form stays open on the kind it saved, so
        // its next save grows that kind, and its saved variables are fixed.
        const names = new Set(type.variables.map((variable) => variable.name));
        form = {
          ...form!,
          original: type,
          saving: false,
          saved: true,
          variables: form!.variables.map((variable) => (names.has(variableName(variable.name))
            ? { ...variable, identity: false, locked: true }
            : variable)),
        };
        opened = asSaved(formOf(type));
      }
      deps.onSaved(type, current);
    } catch (error) {
      if (form === null || form.session !== session) return;
      set({ saving: false, error: humanizeRpcError(error), problems: problemsOf(error) });
      deps.focus('ty:title');
      deps.render();
    }
  };

  const renderVariable = (variable: VariableRow, index: number): string => `
    <li class="mail-facts-ty-var" role="group" aria-label="Variable ${index + 1}">
      <input type="text" ${fieldAttr}="ty:var-name:${index}" ${focusAttr}="ty:var-name:${index}" value="${e(variable.name)}"
        aria-label="Variable ${index + 1}: name" placeholder="for example box_id"${fixedVariable(index) ? ' disabled' : ''}>
      <select ${fieldAttr}="ty:var-kind:${index}" ${focusAttr}="ty:var-kind:${index}" aria-label="Variable ${index + 1}: what it holds"${fixedVariable(index) ? ' disabled' : ''}>
        ${MAIL_FACT_VARIABLE_KINDS.map((kind) => option(kind, KIND_WORDS[kind], kind === variable.kind)).join('')}
      </select>
      <label class="mail-facts-switch"><input type="checkbox" ${fieldAttr}="ty:var-required:${index}" ${focusAttr}="ty:var-required:${index}"${variable.required ? ' checked' : ''}> Needed for a fact</label>
      ${form!.original === null && variable.kind !== 'file'
        ? `<label class="mail-facts-switch"><input type="checkbox" ${fieldAttr}="ty:var-identity:${index}" ${focusAttr}="ty:var-identity:${index}"${variable.identity ? ' checked' : ''}> Tells one apart</label>`
        : ''}
      ${variable.kind === 'enum'
        ? `<input type="text" ${fieldAttr}="ty:var-values:${index}" ${focusAttr}="ty:var-values:${index}" value="${e(variable.values)}"
            aria-label="Variable ${index + 1}: its values, separated by commas" placeholder="for example red, white, rose">`
        : ''}
      ${fixedVariable(index)
        ? ''
        : `<button type="button" class="data-button" ${actionAttr}="mail-facts-ty-var-remove" data-index="${index}"
            ${focusAttr}="ty:var-remove:${index}" aria-label="Remove variable ${index + 1}">Remove</button>`}
    </li>`;

  const renderData = (field: DataRow, index: number): string => `
    <li class="mail-facts-ty-var" role="group" aria-label="Data field ${index + 1}">
      <input type="text" ${fieldAttr}="ty:data-path:${index}" ${focusAttr}="ty:data-path:${index}" value="${e(field.path)}"
        aria-label="Data field ${index + 1}: name" placeholder="for example bottles">
      <select ${fieldAttr}="ty:data-kind:${index}" ${focusAttr}="ty:data-kind:${index}" aria-label="Data field ${index + 1}: what it holds">
        ${(Object.keys(DATA_KIND_WORDS) as MailFactDataFieldSpec['kind'][]).map((kind) => option(kind, DATA_KIND_WORDS[kind], kind === field.kind)).join('')}
      </select>
      <input type="text" ${fieldAttr}="ty:data-description:${index}" ${focusAttr}="ty:data-description:${index}" value="${e(field.description)}"
        aria-label="Data field ${index + 1}: what it is, for the AI" placeholder="what it is, for the AI">
      <button type="button" class="data-button" ${actionAttr}="mail-facts-ty-data-remove" data-index="${index}"
        ${focusAttr}="ty:data-remove:${index}" aria-label="Remove data field ${index + 1}">Remove</button>
    </li>`;

  /** How a saved kind tells one thing from another, which it keeps. */
  const renderIdentity = (identity: MailFactTypeSpec['identity']): string => identity.length === 0
    ? 'Each email’s fact stands on its own: none are joined. That cannot change once saved.'
    : `Emails are joined as one when ${identity.map((set) => set.map((name) => `<code>${e(name)}</code>`).join(' and ')).join(', or ')} match. That cannot change once saved: it decided which one each fact joined.`;

  const render = (): string => {
    if (form === null) return '';
    const isNew = form.original === null;
    return `
      <section class="mail-facts-editor mail-facts-type-editor" aria-labelledby="mail-facts-ty-title">
        <h3 class="mail-facts-subheading" id="mail-facts-ty-title" tabindex="-1" ${focusAttr}="ty:title">${isNew ? 'A new kind of email' : `Edit “${e(form.original!.name)}”`}</h3>
        ${form.error !== null ? `<p class="mail-facts-error" role="alert">${e(form.error)}</p>` : ''}
        ${form.problems.length > 0 ? `<ul class="mail-facts-problems" role="list">${form.problems.map((p) => `<li>${e(p)}</li>`).join('')}</ul>` : ''}
        <p class="mail-facts-subtle">${isNew
          ? 'A kind of email is what a fact of it has: the variables a trigger can test, and data for the recipe that runs. It exists on this server only.'
          : `Its id is <code>${e(form.original!.id)}</code>. It can grow, but nothing it has can go: its facts, templates and triggers name it.`}</p>
        <div class="mail-facts-editor-top">
          <label>Name <input type="text" ${fieldAttr}="ty:name" ${focusAttr}="ty:name" value="${e(form.name)}" placeholder="for example Wine club box"></label>
          <label>What it is <input type="text" ${fieldAttr}="ty:description" ${focusAttr}="ty:description" value="${e(form.description)}" placeholder="for example A box from the wine club"></label>
        </div>
        <div class="mail-facts-editor-block">
          <h4 class="mail-facts-subheading">Its variables</h4>
          <p class="mail-facts-subtle">The values a trigger tests. The needed ones must be read for a fact to exist, unless a template says otherwise.${isNew
            ? ' Tick “Tells one apart” on the values that say which one an email is about, like a box id or a tracking number: emails that share them all are joined as one. None ticked: each email’s fact stands on its own.'
            : ''}</p>
          <ul class="mail-facts-ty-vars" role="list">${form.variables.map(renderVariable).join('')}</ul>
          <button type="button" class="data-button" ${actionAttr}="mail-facts-ty-var-add" ${focusAttr}="ty:var-add">Add a variable</button>
          ${isNew ? '' : `<p class="mail-facts-subtle">${renderIdentity(form.original!.identity)}</p>`}
        </div>
        <div class="mail-facts-editor-block mail-facts-ty-words">
          <label>States: where one is now <input type="text" ${fieldAttr}="ty:states" ${focusAttr}="ty:states" value="${e(form.states)}" placeholder="for example shipped, delivered"></label>
          <label>Notices: what is said about one <input type="text" ${fieldAttr}="ty:notices" ${focusAttr}="ty:notices" value="${e(form.notices)}" placeholder="for example reminder"></label>
        </div>
        <details class="mail-facts-advanced"${form.dataOpen ? ' open' : ''}>
          <summary ${actionAttr}="mail-facts-ty-data-toggle" ${focusAttr}="ty:data">Data fields</summary>
          <p class="mail-facts-subtle">Named for the template editor and the AI. A recipe reads them; a trigger does not.</p>
          <ul class="mail-facts-ty-vars" role="list">${form.dataFields.map(renderData).join('')}</ul>
          <button type="button" class="data-button" ${actionAttr}="mail-facts-ty-data-add" ${focusAttr}="ty:data-add">Add a data field</button>
        </details>
        <div class="mail-facts-editor-actions">
          <button type="button" class="data-button" ${actionAttr}="mail-facts-ty-save" ${focusAttr}="ty:save"${form.saving ? ' aria-disabled="true" aria-busy="true"' : ''}>${form.saving ? 'Saving…' : 'Save kind of email'}</button>
          <button type="button" class="data-button" ${actionAttr}="mail-facts-ty-cancel" ${focusAttr}="ty:cancel">Cancel</button>
        </div>
        ${form.saved && asSaved(form) !== opened ? '<p class="mail-facts-subtle" role="status">Saved. Your changes since are not saved yet.</p>' : ''}
      </section>`;
  };

  return {
    isOpen: () => form !== null,
    open: (spec) => {
      form = { ...formOf(spec), session: ++sessions };
      opened = asSaved(form);
      deps.focus('ty:title');
    },
    close: () => {
      form = null;
    },
    isDirty: () => form !== null && asSaved(form) !== opened,
    isSaving: () => form?.saving === true,
    render,
    handleAction: (action, target) => {
      if (form === null || !action.startsWith('mail-facts-ty-')) return false;
      const index = Number(target.getAttribute('data-index') ?? '-1');
      switch (action) {
        case 'mail-facts-ty-var-add':
          set({ variables: [...form.variables, blankVariable()] });
          deps.focus(`ty:var-name:${form.variables.length - 1}`);
          break;
        case 'mail-facts-ty-var-remove':
          if (!fixedVariable(index)) {
            set({ variables: form.variables.filter((_, i) => i !== index) });
            deps.focus('ty:var-add');
          }
          break;
        case 'mail-facts-ty-data-toggle':
          // The browser opens or shuts it; a repaint here would undo that.
          set({ dataOpen: !form.dataOpen });
          return true;
        case 'mail-facts-ty-data-add':
          set({ dataFields: [...form.dataFields, { path: '', kind: 'text', description: '' }], dataOpen: true });
          deps.focus(`ty:data-path:${form.dataFields.length - 1}`);
          break;
        case 'mail-facts-ty-data-remove':
          set({ dataFields: form.dataFields.filter((_, i) => i !== index) });
          deps.focus('ty:data-add');
          break;
        case 'mail-facts-ty-save':
          void save();
          return true;
        case 'mail-facts-ty-cancel':
          form = null;
          deps.onCancelled();
          return true;
        default:
          return false;
      }
      deps.render();
      return true;
    },
    handleChange: (target) => {
      const field = target.getAttribute(fieldAttr);
      if (form === null || field === null || !field.startsWith('ty:')) return false;
      const value = (target as HTMLInputElement).value ?? '';
      const checked = (target as HTMLInputElement).checked === true;
      const [, key, arg] = /^ty:([a-z-]+)(?::(.*))?$/.exec(field) ?? [];
      const index = Number(arg ?? '-1');
      switch (key) {
        case 'var-kind':
          if (fixedVariable(index)) break;
          // An attachment cannot tell one thing from another.
          setVariable(index, { kind: value as MailFactVariableKind, ...(value === 'file' ? { identity: false } : {}) });
          break;
        case 'var-required':
          setVariable(index, { required: checked });
          break;
        case 'var-identity':
          setVariable(index, { identity: checked });
          break;
        case 'data-kind':
          setData(index, { kind: value as MailFactDataFieldSpec['kind'] });
          break;
        default:
          // A text field's `change` after its `input`s: the form has it, and a
          // repaint now would take the click that moved focus away (above).
          return true;
      }
      deps.focus(field);
      deps.render();
      return true;
    },
    handleInput: (target) => {
      const field = target.getAttribute(fieldAttr);
      if (form === null || field === null || !field.startsWith('ty:')) return false;
      const value = (target as HTMLInputElement).value ?? '';
      const [, key, arg] = /^ty:([a-z-]+)(?::(.*))?$/.exec(field) ?? [];
      const index = Number(arg ?? '-1');
      switch (key) {
        case 'name': set({ name: value }); break;
        case 'description': set({ description: value }); break;
        case 'states': set({ states: value }); break;
        case 'notices': set({ notices: value }); break;
        case 'var-name': if (!fixedVariable(index)) setVariable(index, { name: value }); break;
        case 'var-values': setVariable(index, { values: value }); break;
        case 'data-path': setData(index, { path: value }); break;
        case 'data-description': setData(index, { description: value }); break;
        default: return false;
      }
      return true;
    },
  };
};

/** The type editor's styles, scoped with the tab's. */
export const MAIL_FACT_TYPE_EDITOR_STYLES = (host: string): string => `
[${host}] .mail-facts-ty-vars { display: grid; gap: 6px; margin: 0 0 8px; padding: 0; list-style: none; font-size: 13px; }
[${host}] .mail-facts-ty-var { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; min-width: 0; }
[${host}] .mail-facts-ty-var input[type="text"] { flex: 1 1 10em; min-width: 0; }
[${host}] .mail-facts-ty-words { display: grid; gap: 8px; }
[${host}] .mail-facts-ty-words label { display: grid; gap: 2px; max-width: 720px; font-size: 12px; color: var(--muted); }
`;
