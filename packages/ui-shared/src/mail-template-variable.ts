/** D-315 §5.2 — a recipe setting that is one of the owner's mail templates:
 *  the list the recipe's Settings offer, "Open it" and "Duplicate to edit".
 *
 *  `renderVariableWidget` draws the row — a `<select>` holding the stored id
 *  until the list loads, so no value is lost to a slow list — and this fills
 *  it. What is offered and what each button may do are pure functions, so a
 *  test needs no DOM. */

import { e } from './template.js';
import {
  MAIL_TEMPLATE_ACTION_ATTR,
  MAIL_TEMPLATE_TYPE_ATTR,
  MAIL_TEMPLATE_VARIABLE_ATTR,
} from './variable-widgets.js';

/** One of the owner's templates, as the setting shows it. */
export interface MailTemplateChoice {
  readonly template_id: string;
  readonly name: string;
  /** The kind of email it reads. */
  readonly type: string;
  readonly active: boolean;
  /** The recipe it came with, by name; absent for the owner's own. */
  readonly recipe?: string;
}

export interface MailTemplateVariableCallers {
  /** The owner's templates. */
  readonly list: () => Promise<readonly MailTemplateChoice[]>;
  /** Show one where templates are edited. */
  readonly open?: (template_id: string) => void;
  /** "Duplicate to edit": the owner's own copy of a recipe's template. The
   *  server re-points every setting that held the original to it. */
  readonly duplicate?: (template_id: string) => Promise<MailTemplateChoice>;
}

export interface MailTemplateOption {
  readonly value: string;
  readonly label: string;
  readonly selected: boolean;
}

/** What a template setting offers: the owner's templates of its kind (all of
 *  them when it names none), the ones on first, then by name. The held one is
 *  kept even when it is not among them, said as it is — a template gone, or
 *  one of another kind — and never dropped: a save would lose it. */
export const mailTemplateOptions = (
  choices: readonly MailTemplateChoice[],
  input: { readonly type: string; readonly value: string },
): MailTemplateOption[] => {
  const offered = choices
    .filter((choice) => input.type === '' || choice.type === input.type)
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  const options: MailTemplateOption[] = offered.map((choice) => ({
    value: choice.template_id,
    label: `${choice.name} — ${choice.recipe !== undefined ? `from the recipe ${choice.recipe}` : 'yours'}${choice.active ? '' : ' (off)'}`,
    selected: choice.template_id === input.value,
  }));
  if (input.value === '') return [{ value: '', label: 'Choose a template', selected: true }, ...options];
  if (!options.some((option) => option.selected)) {
    const held = choices.find((choice) => choice.template_id === input.value);
    options.unshift({
      value: input.value,
      label: held !== undefined ? `${held.name} — reads another kind of email` : `Missing template — ${input.value}`,
      selected: true,
    });
  }
  return options;
};

/** What the row's buttons may do for the template the setting holds: open
 *  one that exists; duplicate one a recipe brought, whose rules the owner does
 *  not edit in place. */
export const mailTemplateActions = (
  choices: readonly MailTemplateChoice[],
  value: string,
  callers: Pick<MailTemplateVariableCallers, 'open' | 'duplicate'>,
): { readonly open: boolean; readonly duplicate: boolean } => {
  const held = choices.find((choice) => choice.template_id === value);
  return {
    open: held !== undefined && callers.open !== undefined,
    duplicate: held?.recipe !== undefined && callers.duplicate !== undefined,
  };
};

export interface MailTemplateVariablesHandle {
  destroy(): void;
}

/** Fill every template setting under `root` from the owner's templates, and
 *  answer its buttons. A duplicate becomes the setting's value at once
 *  (`onChange`): the server already moved the saved setting to the copy, and
 *  a save of the form must not move it back. */
export const wireMailTemplateVariables = (
  root: Element,
  opts: {
    readonly callers: MailTemplateVariableCallers;
    readonly onChange: (key: string, template_id: string) => void;
  },
): MailTemplateVariablesHandle => {
  if (typeof root.querySelectorAll !== 'function') return { destroy: () => undefined };
  const rows = Array.from(root.querySelectorAll<HTMLElement>(`[${MAIL_TEMPLATE_VARIABLE_ATTR}]`));
  if (rows.length === 0) return { destroy: () => undefined };
  let choices: readonly MailTemplateChoice[] = [];
  let destroyed = false;

  const partsOf = (row: HTMLElement) => ({
    select: row.querySelector<HTMLSelectElement>('select[data-var-type="mail_template"]'),
    open: row.querySelector<HTMLButtonElement>(`[${MAIL_TEMPLATE_ACTION_ATTR}="open"]`),
    duplicate: row.querySelector<HTMLButtonElement>(`[${MAIL_TEMPLATE_ACTION_ATTR}="duplicate"]`),
  });
  const buttons = (row: HTMLElement): void => {
    const { select, open, duplicate } = partsOf(row);
    if (select === null) return;
    const can = mailTemplateActions(choices, select.value, opts.callers);
    if (open !== null) open.disabled = !can.open;
    if (duplicate !== null) duplicate.hidden = !can.duplicate;
  };
  const paint = (row: HTMLElement, value?: string): void => {
    const { select } = partsOf(row);
    if (select === null) return;
    const held = value ?? select.value;
    select.innerHTML = mailTemplateOptions(choices, { type: row.getAttribute(MAIL_TEMPLATE_TYPE_ATTR) ?? '', value: held })
      .map((option) => `<option value="${e(option.value)}"${option.selected ? ' selected' : ''}>${e(option.label)}</option>`)
      .join('');
    select.value = held;
    buttons(row);
  };
  const load = async (): Promise<void> => {
    choices = await opts.callers.list();
    if (!destroyed) for (const row of rows) paint(row);
  };

  const onChange = (event: Event): void => {
    const row = (event.target as Element | null)?.closest?.(`[${MAIL_TEMPLATE_VARIABLE_ATTR}]`) as HTMLElement | null;
    if (row !== null && row !== undefined) buttons(row);
  };
  const onClick = (event: Event): void => {
    const button = (event.target as Element | null)?.closest?.(`[${MAIL_TEMPLATE_ACTION_ATTR}]`) as HTMLButtonElement | null;
    if (button === null || button === undefined || button.disabled || button.hidden) return;
    const row = button.closest(`[${MAIL_TEMPLATE_VARIABLE_ATTR}]`) as HTMLElement | null;
    const key = row?.getAttribute(MAIL_TEMPLATE_VARIABLE_ATTR);
    const select = row === null ? null : partsOf(row).select;
    if (row === null || key === null || key === undefined || select === null || select.value === '') return;
    const action = button.getAttribute(MAIL_TEMPLATE_ACTION_ATTR);
    if (action === 'open') {
      opts.callers.open?.(select.value);
      return;
    }
    if (action === 'duplicate' && opts.callers.duplicate !== undefined) {
      button.disabled = true;
      void opts.callers.duplicate(select.value)
        .then(async (copy) => {
          choices = await opts.callers.list();
          if (destroyed) return;
          paint(row, copy.template_id);
          opts.onChange(key, copy.template_id);
        })
        .catch(() => undefined)
        .finally(() => { if (!destroyed) buttons(row); button.disabled = false; });
    }
  };

  for (const row of rows) {
    row.addEventListener('change', onChange);
    row.addEventListener('click', onClick);
  }
  // A list that cannot load leaves each held id as it is: no worse than a text box.
  void load().catch(() => undefined);
  return {
    destroy: () => {
      destroyed = true;
      for (const row of rows) {
        row.removeEventListener('change', onChange);
        row.removeEventListener('click', onClick);
      }
    },
  };
};
