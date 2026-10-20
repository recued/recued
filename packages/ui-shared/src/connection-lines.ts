/** D-320 §4 — a Connection line: which of the pack's connections a dish, or one
 *  run, uses for a slot (the connection name a pack's catalog declares).
 *
 *  Shown only where there is a choice: two or more connections on the pack's list
 *  for the slot (`packs.connections.recipe`). The settings a slot stands in for are
 *  left out of the form, and never asked for: the pack holds the connection.
 *
 *  Where a line starts:
 *  - the dish's choice, when it made one;
 *  - else an old connection SETTING the dish holds (recipes read their connection
 *    from a setting until phase 3 removes them), so the line shows what actually
 *    runs. A value not on the pack's list is offered as it is, marked so, and kept
 *    if left alone: saving the form must not move a dish to another account;
 *  - else the pack's default; with none, "Choose one".
 *
 *  D-320 ruling 20 — a recipe's vendor-neutral FAMILY (`crm`, `acct`) is a line too
 *  (`family`), listing every connection of any vendor that can serve its steps. It
 *  has no default, and unchosen is a real answer (a search reads every connection,
 *  a step on a record takes the record's), so its empty option is "Any connection".
 *
 *  A dish saves a line the owner moved, and a line that started on a choice or a
 *  setting (it was pinned, and stays pinned). A line left on the default it
 *  started on saves nothing, so the dish follows the pack's default. One run sends
 *  only the lines it moved (§3.5: this run only). */

/** One slot a recipe signs in through, as `packs.connections.recipe` lists it. */
export interface ConnectionLineSlot {
  readonly slot: string;
  /** The settings it stands in for. */
  readonly variables: readonly string[];
  readonly connections: ReadonlyArray<{
    readonly connection_name: string;
    readonly connection_revision?: string;
    readonly display_name: string;
    readonly is_default: boolean;
  }>;
  /** A vendor-neutral family rather than a pack's slot (see the module comment). */
  readonly family?: true;
}

/** Where a line started. */
export type ConnectionLineStart = 'chosen' | 'setting' | 'stale' | 'default' | 'none';

export interface ConnectionLine {
  readonly slot: string;
  readonly label: string;
  /** `stale`: an old setting's connection, not on the pack's list. */
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string; readonly stale?: true }>;
  /** The value it starts on (`''` with no default and nothing chosen). */
  readonly selected: string;
  readonly start: ConnectionLineStart;
  /** The settings it stands in for. */
  readonly variables: readonly string[];
}

/** Every setting the slots stand in for: the form leaves them out. */
export const connectionSettings = (slots: ReadonlyArray<ConnectionLineSlot>): Set<string> =>
  new Set(slots.flatMap((slot) => slot.variables));

const settingValue = (
  slot: ConnectionLineSlot,
  settings: Readonly<Record<string, unknown>> | undefined,
): string | undefined => {
  for (const variable of slot.variables) {
    const value = settings?.[variable];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
};

/** The lines for the slots that offer a choice. `chosen` is the dish's choice,
 *  `settings` the settings the form starts from. */
export const connectionLines = (
  slots: ReadonlyArray<ConnectionLineSlot>,
  start: {
    readonly chosen?: Readonly<Record<string, string>> | undefined;
    readonly settings?: Readonly<Record<string, unknown>> | undefined;
  },
): ConnectionLine[] => {
  const shown = slots.filter((slot) => slot.connections.length >= 2);
  return shown.map((slot) => {
    const names = slot.connections.map((c) => c.connection_name);
    const options: Array<{ value: string; label: string; stale?: true }> = slot.connections.map((c) => ({
      value: c.connection_name,
      label: `${c.display_name !== '' ? c.display_name : c.connection_name}${c.is_default ? ' (default)' : ''}`,
    }));
    const theDefault = slot.connections.find((c) => c.is_default)?.connection_name;
    const chosen = start.chosen?.[slot.slot];
    const setting = settingValue(slot, start.settings);
    let selected = '';
    let from: ConnectionLineStart = 'none';
    if (chosen !== undefined && names.includes(chosen)) {
      selected = chosen;
      from = 'chosen';
    } else if (setting !== undefined) {
      selected = setting;
      from = names.includes(setting) ? 'setting' : 'stale';
      if (from === 'stale') options.push({ value: setting, label: `${setting} (not on the pack's list)`, stale: true });
    } else if (theDefault !== undefined) {
      selected = theDefault;
      from = 'default';
    }
    if (from === 'none') options.unshift({ value: '', label: slot.family === true ? 'Any connection' : 'Choose one' });
    return {
      slot: slot.slot,
      label: shown.length === 1 ? 'Connection' : `Connection — ${slot.slot}`,
      options,
      selected,
      start: from,
      variables: [...slot.variables],
    };
  });
};

const selectedOf = (line: ConnectionLine, selected: Readonly<Record<string, string>>): string =>
  selected[line.slot] ?? line.selected;

/** What a dish saves from its lines: its choice per slot, and the settings the
 *  saved lines now stand in for (dropped from its settings, so an old value can
 *  no longer disagree with the choice). */
export const dishChoiceFromLines = (
  lines: ReadonlyArray<ConnectionLine>,
  selected: Readonly<Record<string, string>>,
): { connections: Record<string, string>; dropSettings: string[] } => {
  const connections: Record<string, string> = {};
  const dropSettings: string[] = [];
  for (const line of lines) {
    const value = selectedOf(line, selected);
    if (value === '') continue;
    const moved = value !== line.selected;
    // Left as it started: a stale setting stays the setting it was, and a line on
    // the default it started on follows the default.
    if (!moved && (line.start === 'stale' || line.start === 'default')) continue;
    connections[line.slot] = value;
    dropSettings.push(...line.variables);
  }
  return { connections, dropSettings };
};

/** What one run sends from its lines: the ones it moved, and only to a connection
 *  on the list. */
export const runChoiceFromLines = (
  lines: ReadonlyArray<ConnectionLine>,
  selected: Readonly<Record<string, string>>,
): Record<string, string> => {
  const connections: Record<string, string> = {};
  for (const line of lines) {
    const value = selectedOf(line, selected);
    if (value === '' || value === line.selected) continue;
    if (!line.options.some((option) => option.value === value && option.stale !== true)) continue;
    connections[line.slot] = value;
  }
  return connections;
};
