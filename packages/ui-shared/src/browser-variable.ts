/** D-402 slice H2b — a setting that names one of the owner's browsers: the list of their paired
 *  browsers the dish form and the run dialog offer, by name, where they offered a text box holding an id.
 *
 *  `renderVariableWidget` draws the row: a `<select>` holding the saved browser until the list loads, so
 *  no value is lost to a slow list. This fills it. What is offered, and what a row starts on, are pure
 *  functions, so a test needs no DOM.
 *
 *  A browser is the account a recipe acts in (D-349), held by its lasting id (the paired instance, slice
 *  H1a), which a credential rotation keeps. One no longer paired stays held, said as such, and is never
 *  dropped: a save would lose it, and the run then says which browser is missing (slice H3).
 *
 *  🔑 THE ONLY BROWSER IS CHOSEN FOR THE OWNER, AND THE FORM SAVES IT, as the only mailbox is
 *  (`mailbox-variable.ts`): a dish keeps acting in it after a second browser is paired. */
import { e } from './template.js';
import { BROWSER_PLACEHOLDER, BROWSER_VARIABLE_ATTR } from './variable-widgets.js';

/** One of the owner's paired browsers, as a setting offers it (`pair.browsers`). */
export interface BrowserChoice {
  /** Its lasting id: what the setting holds. */
  readonly browser_id: string;
  /** The name routing uses: the owner's, told apart from another of the same name. */
  readonly name: string;
  readonly online: boolean;
}
export interface BrowserVariableCallers {
  /** The owner's paired browsers. */
  readonly list: () => Promise<readonly BrowserChoice[]>;
}
export interface BrowserOption {
  readonly value: string;
  readonly label: string;
  readonly selected: boolean;
}

/** What a row's list offers: each paired browser by name, one not connected now said so. The held
 *  browser stays when it is not paired any more, said as such. With nothing held, the first line asks;
 *  with nothing to offer, it says where a browser comes from. */
export const browserOptions = (choices: readonly BrowserChoice[], held: string): BrowserOption[] => {
  const options: BrowserOption[] = [...choices]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((choice) => ({ value: choice.browser_id, label: choice.online ? choice.name : `${choice.name} (not connected)`,
      selected: choice.browser_id === held }));
  if (held === '') {
    return [{ value: '', label: choices.length > 0 ? BROWSER_PLACEHOLDER : 'No browser is paired yet: pair one with the Browser Bridge.',
      selected: true }, ...options];
  }
  if (!options.some((option) => option.selected)) {
    options.unshift({ value: held, label: 'A browser no longer paired', selected: true });
  }
  return options;
};

/** The browser a row starts on when it holds none: the only one paired. `null` otherwise. */
export const browserPrefill = (choices: readonly BrowserChoice[], held: string): string | null =>
  held === '' && choices.length === 1 ? choices[0]!.browser_id : null;

/** The list read once, for a surface that paints its rows more than once (the run dialog). */
export const memoBrowserCallers = (callers: BrowserVariableCallers): BrowserVariableCallers => {
  let list: Promise<readonly BrowserChoice[]> | undefined;
  return { list: () => (list ??= callers.list()) };
};

export interface BrowserVariablesHandle {
  destroy(): void;
}

/** Fill every browser row under `root` from the owner's paired browsers, and start a row holding none
 *  on the only one (`onChange`, so the form saves it). A list that cannot load leaves each row holding
 *  what it held, said as such: the value is kept, never guessed. */
export const wireBrowserVariables = (
  root: Element,
  opts: {
    readonly callers: BrowserVariableCallers;
    readonly onChange: (key: string, browser_id: string) => void;
  },
): BrowserVariablesHandle => {
  if (typeof root.querySelectorAll !== 'function') return { destroy: () => undefined };
  const rows = Array.from(root.querySelectorAll<HTMLElement>(`[${BROWSER_VARIABLE_ATTR}]`));
  if (rows.length === 0) return { destroy: () => undefined };
  let destroyed = false;
  const selectOf = (element: HTMLElement): HTMLSelectElement | null =>
    element.querySelector<HTMLSelectElement>('select[data-var-type="browser"]');
  const paint = (element: HTMLElement, options: readonly BrowserOption[], value: string): void => {
    const select = selectOf(element);
    if (select === null) return;
    select.innerHTML = options
      .map((option) => `<option value="${e(option.value)}"${option.selected ? ' selected' : ''}>${e(option.label)}</option>`)
      .join('');
    select.value = value;
  };
  void opts.callers.list().then(
    (choices) => {
      if (destroyed) return;
      for (const element of rows) {
        const select = selectOf(element);
        const key = element.getAttribute(BROWSER_VARIABLE_ATTR);
        if (select === null || key === null) continue;
        const start = browserPrefill(choices, select.value);
        const value = start ?? select.value;
        paint(element, browserOptions(choices, value), value);
        if (start !== null) opts.onChange(key, start);
      }
    },
    () => {
      if (destroyed) return;
      for (const element of rows) {
        const select = selectOf(element);
        if (select === null) continue;
        const held = select.value;
        paint(element, [{ value: held, label: held === '' ? BROWSER_PLACEHOLDER : 'The browser this holds (the list did not load)',
          selected: true }], held);
      }
    },
  );
  return { destroy: () => { destroyed = true; } };
};
