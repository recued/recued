/** D-319 §5.2 — the switch-on form, one for every place a dish is made or
 *  set: the recipe page's "Running as" and Automation's "Not switched on" and
 *  dish Settings.
 *
 *  The same form serves Switch on, Save settings, + Add another and a dish's
 *  Settings: a name from the second dish, every setting of the recipe (a mail
 *  template too — it is the dish's), one sentence of what will start it, and
 *  "Also on a schedule". It will not confirm while a setting the recipe asks
 *  for is empty: the dish would run without it.
 *
 *  The host owns what is around it: its busy and error state, where the
 *  fields start (a first dish from `dishes.defaults`, which the host reads),
 *  and re-reading its lists afterwards (`onSaved`). */

import {
  CRON_PRESETS,
  describeCron,
  type Dish,
  type ServerRecipeListEntry,
} from '@recued/contracts';
import {
  whatStartsIt,
  wireConfigEditorOverlay,
  type ConfigEditorOverlayHandle,
  type MailTemplateVariableCallers,
  type RecordRefVariableSearch,
  RefPicker,
} from '@recued/ui-shared';

export type DishFormMode = 'switch-on' | 'save-settings' | 'add' | 'settings';

/** "Also on a schedule": a few cadences, said as the presets say them. */
export const SWITCH_ON_SCHEDULES: ReadonlyArray<{ readonly label: string; readonly cron: string }> =
  ['0 * * * *', '0 8 * * *', '0 9 * * *', '0 9 * * 1-5', '0 9 * * 1', '0 9 1 * *'].map((cron) => ({
    cron,
    label: CRON_PRESETS.find((preset) => preset.expression === cron)?.label ?? describeCron(cron),
  }));

export interface DishFormCallers {
  readonly create?: (args: {
    recipe_id: string;
    publisher_id: string;
    name?: string;
    config_overlay?: Record<string, unknown>;
  }) => Promise<{ dish: Dish }>;
  readonly update?: (args: {
    dish_id: string;
    name?: string;
    config_overlay?: Record<string, unknown>;
  }) => Promise<{ dish: Dish }>;
  readonly schedulesCreate?: (args: {
    recipe_id: string;
    publisher_id?: string;
    cron_expression?: string;
    dish_id?: string;
  }) => Promise<unknown>;
}

export interface OpenDishFormArgs {
  readonly document: Document;
  readonly mode: DishFormMode;
  readonly entry: ServerRecipeListEntry;
  /** This recipe's dishes. */
  readonly dishes: readonly Dish[];
  /** The dish whose Settings open (`settings`). */
  readonly dish?: Dish;
  /** Where the fields start (`dishFormStart`). */
  readonly start: Record<string, unknown>;
  readonly callers: DishFormCallers;
  readonly fileRefSearch?: RefPicker.RefPickerSearchCaller;
  readonly recordRefSearch?: RecordRefVariableSearch;
  readonly mailTemplates?: MailTemplateVariableCallers;
  /** A dish was made; `scheduleError` when its schedule could not be added
   *  (the dish stands — saving again would make a second one). */
  readonly onCreated?: (dish: Dish, scheduleError: unknown) => void;
  /** Anything saved: the host re-reads its lists. */
  readonly onSaved?: () => void;
  readonly onClose: () => void;
}

/** Where a form's fields start, when the host needs no read for it: a dish's
 *  Settings from its own settings, + Add another from the main dish's.
 *  `null` for a first dish: the host reads `dishes.defaults`. */
export const dishFormStart = (
  mode: DishFormMode,
  dishes: readonly Dish[],
  dish?: Dish,
): Record<string, unknown> | null => {
  if (mode === 'settings') return dish === undefined ? null : { ...dish.config_overlay };
  if (mode === 'add') {
    const main = dishes.find((candidate) => candidate.is_default) ?? dishes[0];
    return { ...(main?.config_overlay ?? {}) };
  }
  return null;
};

const recipeNameOf = (entry: ServerRecipeListEntry): string =>
  entry.recipe.metadata?.name?.trim() || entry.recipe_id;

/** Open the form. `null` when the host has no caller for what it would do. */
export const openDishForm = (args: OpenDishFormArgs): ConfigEditorOverlayHandle | null => {
  const { mode, entry, dishes, dish, callers } = args;
  const update = callers.update;
  const create = callers.create;
  if (mode === 'settings' ? dish === undefined || update === undefined : create === undefined) return null;
  const recipeName = recipeNameOf(entry);
  const name = mode === 'add'
    ? { value: '', required: true }
    : mode === 'settings' && (dishes.length > 1 || dish!.name !== '')
      ? { value: dish!.name, required: dishes.length > 1 }
      : undefined;
  return wireConfigEditorOverlay({
    document: args.document,
    title: mode === 'switch-on' ? `Switch on “${recipeName}”`
      : mode === 'save-settings' ? `Settings for “${recipeName}”`
        : mode === 'add' ? `Add another “${recipeName}”`
          : `Settings of “${dish!.name !== '' ? dish!.name : recipeName}”`,
    ...(mode === 'settings'
      ? { copy: 'Every run of this dish uses these settings, from its next run. Each run keeps the settings it ran with.' }
      : mode === 'save-settings'
        ? { copy: 'Every run and schedule of this recipe uses these settings. You can still change them for one run.' }
        : {}),
    confirmLabel: mode === 'switch-on' ? 'Switch on' : mode === 'add' ? 'Add' : 'Save',
    confirmingLabel: mode === 'switch-on' ? 'Switching on…' : 'Saving…',
    confirmFailureCopy: 'Recued could not save that. What you typed is still here. Try again.',
    variables: entry.recipe.variables ?? {},
    currentOverlay: args.start,
    ...(name !== undefined ? { name } : {}),
    ...(mode === 'settings' ? {} : { lead: whatStartsIt(entry.recipe) }),
    // A recipe on its own timer already runs every so often.
    ...(mode === 'settings' || entry.recipe.auto_run !== undefined || callers.schedulesCreate === undefined
      ? {}
      : { schedules: SWITCH_ON_SCHEDULES }),
    requireSettings: true,
    ...(args.fileRefSearch !== undefined ? { fileRefSearch: args.fileRefSearch } : {}),
    ...(args.recordRefSearch !== undefined ? { recordRefSearch: args.recordRefSearch } : {}),
    ...(args.mailTemplates !== undefined ? { mailTemplates: args.mailTemplates } : {}),
    onConfirm: async (config, extras) => {
      if (mode === 'settings') {
        await update!({
          dish_id: dish!.dish_id,
          config_overlay: config,
          ...(extras.name !== undefined && extras.name !== dish!.name ? { name: extras.name } : {}),
        });
      } else {
        const { dish: made } = await create!({
          recipe_id: entry.recipe_id,
          publisher_id: entry.publisher_id,
          config_overlay: config,
          ...(extras.name !== undefined && extras.name !== '' ? { name: extras.name } : {}),
        });
        // The dish exists now. A schedule that fails must not fail the
        // form: saving again would switch on a second dish.
        let scheduleError: unknown = null;
        const schedule = callers.schedulesCreate;
        if (extras.cron !== undefined && extras.cron !== '' && schedule !== undefined) {
          try {
            await schedule({
              recipe_id: entry.recipe_id,
              publisher_id: entry.publisher_id,
              cron_expression: extras.cron,
              dish_id: made.dish_id,
            });
          } catch (error) {
            scheduleError = error;
          }
        }
        args.onCreated?.(made, scheduleError);
      }
      args.onSaved?.();
    },
    onClose: args.onClose,
  });
};
