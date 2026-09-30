/**
 * D-315 §5.2 — the templates recipes bring. A recipe's `mail_template`
 * variable may carry a `starter`: the template its author built and tested it
 * with. Installing the recipe creates it here as the recipe's template, with
 * the AI off whatever the starter says; each update re-applies it; uninstalling
 * the recipe removes it.
 *
 * Who owns what (the split D-289 made for pack views):
 *   - the recipe owns the definition — entrance, rules, the AI's prompt and
 *     slots. The owner does not edit it in place (the rpc refuses); they
 *     duplicate it to edit (`duplicate`), which makes their own copy;
 *   - the owner owns the settings — the AI on or off, its pool, and which
 *     template is on. Updates keep them.
 *
 * Of one kind and one set of conditions, one template is on (ruling 31). A
 * starter that reads the same mail as a template already on asks which stays
 * on — the recipe's by default, the one its author tested. Whichever is
 * switched off, the dish settings that named it name the one that reads that
 * mail now, so a dish keeps reading the mail it read.
 *
 * D-319 — the setting is PER DISH: each dish of a recipe holds its own
 * template id, `{{config.<name>}}` resolves to it, and each dish's fact
 * trigger narrowed by `template_variable` follows it (the reconciler reads
 * the dish's settings). Installing makes no dish, so it writes no setting; a
 * new dish starts from the template the install chose (`defaultsFor`).
 */

import {
  getMailFactBuiltinType,
  isMailFactStandardsType,
  mailFactTypeVariables,
  MAIL_FACT_BUILTIN_TYPES,
  mailTemplateDefinitionOf,
  mailTemplateReads,
  mailTemplateStarterProblems,
  mailTemplateStarters,
  parseTriggerOn,
  MAIL_TEMPLATE_VARIABLE_TYPE,
  validateMailTemplateDefinition,
  type EventTrigger,
  type MailTemplate,
  type MailTemplateDefinition,
  type MailTemplateInstallChoice,
  type MailTemplateInstallOutcome,
  type MailFactSourcesPreview,
  type MailFactTypeId,
  type MailTemplateInstallPreview,
  type MailTemplateOrigin,
  type RecipeDefinition,
} from '@recued/contracts';

import type { MailFactStore } from '../storage/mail-fact-store.js';
import { conditionSetAsRead } from './rules-pass.js';

export interface RecipeMailTemplatesDeps {
  readonly store: MailFactStore;
  /** The installed recipes. */
  readonly recipes: {
    get(recipe_id: string): RecipeDefinition | null;
    listStored(): ReadonlyArray<{ readonly recipe_id: string; readonly publisher_id: string; readonly recipe_json: string }>;
  };
  /** D-319 — the dishes' settings: each dish of a recipe holds its own. */
  readonly settings: {
    /** Every dish of this recipe. */
    dishesOf(recipe_id: string): ReadonlyArray<SettingsDish>;
    /** Set one setting of one dish, keeping the others; `null` removes it. */
    set(dish_id: string, variable: string, value: string | null): void;
  };
  /** Re-make the recipes' triggers: one narrowed to a recipe's template
   *  follows its setting. */
  readonly reconcileTriggers?: () => void;
  /** Switch off the rows narrowed to a template that is gone. */
  readonly switchOffTriggers?: (match: (trigger: EventTrigger) => boolean) => Promise<number>;
  readonly onTemplatesChanged?: () => void;
  readonly log?: (message: string) => void;
}

/** The slice of a dish the templates read. */
export interface SettingsDish {
  readonly dish_id: string;
  readonly is_default: boolean;
  readonly config_overlay: Readonly<Record<string, unknown>>;
}

export interface RecipeMailTemplateInstall {
  readonly recipe: RecipeDefinition;
  readonly publisher_id: string;
  readonly version: number;
  /** The pack it came in, if any. */
  readonly pack?: string;
}

export interface RecipeMailTemplates {
  /** What installing these recipes would add or re-apply (the dialog). */
  preview(recipes: readonly RecipeDefinition[]): MailTemplateInstallPreview[];
  /** For each recipe that starts on facts: where they would come from here —
   *  the standards pass, the owner's templates, a template this install adds. */
  factSources(recipes: readonly RecipeDefinition[]): MailFactSourcesPreview[];
  /** Create or re-apply a recipe's starters once it is saved. */
  sync(install: RecipeMailTemplateInstall, choices?: readonly MailTemplateInstallChoice[]): MailTemplateInstallOutcome[];
  /** The recipe is gone: its templates go with it, unless another recipe's
   *  setting holds one — that one stays, as the owner's. Facts stay: they
   *  belong to their emails (§5.3). */
  removeFor(recipe_id: string): Promise<void>;
  /** "Duplicate to edit": the owner's own copy, which reads that mail in the
   *  original's place; every setting that held the original holds the copy. */
  duplicate(template_id: string): MailTemplate | null;
  /** The dishes whose settings hold this template. */
  usersOf(template_id: string): Array<{ readonly recipe_id: string; readonly dish_id: string; readonly variable: string }>;
  /** D-319 — what a new dish of this recipe starts from: for each of its
   *  `mail_template` settings, the template the install chose — the recipe's
   *  own when it is on, else the owner's twin that kept it off. */
  defaultsFor(recipe_id: string): Record<string, unknown>;
}

/** The pool an AI the owner has not set up uses: the free one, which costs
 *  them nothing. A starter's pool is its author's, not the installer's. */
const DEFAULT_POOL = 'free_only';

const ownTemplateOf = (store: MailFactStore, recipe_id: string, variable: string): MailTemplate | undefined =>
  store.listTemplates().find((template) =>
    template.origin.kind === 'recipe' && template.origin.recipe === recipe_id && template.origin.variable === variable);

/** The definition a recipe's template holds: the starter's, with the owner's
 *  settings — the AI off unless the owner switched it on, their pool. `null`
 *  when the starter cannot be stored. */
const templateDefinition = (
  starter: MailTemplateDefinition,
  existing: MailTemplate | undefined,
): MailTemplateDefinition | null => {
  if (mailTemplateStarterProblems(starter).length > 0) return null;
  const read = mailTemplateDefinitionOf(starter);
  const prompt = read.ai.prompt;
  const kept = prompt === undefined ? null : { prompt, slots: [...(read.ai.slots ?? [])] };
  const pool = existing?.ai.pool ?? DEFAULT_POOL;
  const spec = getMailFactBuiltinType(read.type);
  const off: MailTemplateDefinition = { ...read, ai: kept === null ? { enabled: false } : { enabled: false, ...kept, pool } };
  if (existing?.ai.enabled !== true || kept === null) {
    return validateMailTemplateDefinition(off, spec).length === 0 ? off : null;
  }
  // The owner had it on. The new rules may not let it be (an AI-on template
  // needs more than a sender's domain): then it is off, its prompt kept.
  const on: MailTemplateDefinition = { ...read, ai: { enabled: true, ...kept, pool } };
  if (validateMailTemplateDefinition(on, spec).length === 0) return on;
  return validateMailTemplateDefinition(off, spec).length === 0 ? off : null;
};

const sameDefinition = (a: MailTemplateDefinition, b: MailTemplateDefinition): boolean =>
  JSON.stringify(mailTemplateDefinitionOf(a)) === JSON.stringify(mailTemplateDefinitionOf(b));

const sameOrigin = (a: MailTemplateOrigin, b: MailTemplateOrigin): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** The template on of this kind that reads the same mail, other than `self`. */
const activeTwin = (
  store: MailFactStore,
  definition: MailTemplateDefinition,
  self: string | null,
): MailTemplate | undefined => {
  const key = conditionSetAsRead(definition.entrance.conditions);
  return store
    .listTemplates({ type: definition.type, active: true })
    .find((template) => template.template_id !== self && conditionSetAsRead(template.entrance.conditions) === key);
};

const startsOnFacts = (recipe: RecipeDefinition): boolean =>
  (recipe.event_triggers ?? []).some((entry) =>
    typeof entry?.on === 'string' && (entry.on === 'mail_fact' || entry.on.startsWith('mail_fact.')));

const parsed = (json: string): RecipeDefinition | null => {
  try {
    return JSON.parse(json) as RecipeDefinition;
  } catch {
    return null;
  }
};

/** A recipe's `mail_template` variables, starter or not. */
const templateVariablesOf = (recipe: RecipeDefinition): string[] =>
  Object.entries((recipe.variables ?? {}) as Record<string, unknown>).flatMap(([name, hint]) =>
    hint !== null && typeof hint === 'object' && (hint as { type?: unknown }).type === MAIL_TEMPLATE_VARIABLE_TYPE
      ? [name]
      : []);

/** The id a recipe's `mail_template` setting holds, or null. The reconciler
 *  narrows a `template_variable` trigger to it. */
export const templateSettingOf = (
  settings: Readonly<Record<string, unknown>>,
  variable: string,
): string | null => {
  const value = settings[variable];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

export const createRecipeMailTemplates = (deps: RecipeMailTemplatesDeps): RecipeMailTemplates => {
  const { store } = deps;
  const log = deps.log ?? ((message: string) => console.warn(message));

  const usersOf = (template_id: string): Array<{ recipe_id: string; dish_id: string; variable: string }> =>
    deps.recipes.listStored().flatMap((row) => {
      const recipe = parsed(row.recipe_json);
      if (recipe === null) return [];
      const variables = templateVariablesOf(recipe);
      return deps.settings.dishesOf(row.recipe_id).flatMap((dish) => variables
        .filter((variable) => templateSettingOf(dish.config_overlay, variable) === template_id)
        .map((variable) => ({ recipe_id: row.recipe_id, dish_id: dish.dish_id, variable })));
    });

  /** Every setting that held `from` holds `to`: the one that reads that mail now. */
  const repoint = (from: string, to: string): number => {
    const users = usersOf(from);
    for (const user of users) deps.settings.set(user.dish_id, user.variable, to);
    return users.length;
  };

  /** The template a new dish's setting starts from: the recipe's own when it
   *  is on, else the owner's twin that kept it off (the install's choice). */
  const chosenFor = (recipe_id: string, variable: string): string | null => {
    const own = ownTemplateOf(store, recipe_id, variable);
    if (own === undefined) return null;
    if (own.active) return own.template_id;
    return activeTwin(store, own, own.template_id)?.template_id ?? own.template_id;
  };

  const settled = (changed: boolean): void => {
    if (!changed) return;
    try {
      deps.onTemplatesChanged?.();
    } catch {
      /* best-effort: the change is stored */
    }
    try {
      deps.reconcileTriggers?.();
    } catch (error) {
      log(`[d-315] re-making the triggers after a template change failed: ${(error as Error).message ?? String(error)}`);
    }
  };

  /** Remove one of a recipe's templates, or leave it to the owner when another
   *  recipe's setting holds it. */
  const release = async (template: MailTemplate, except: string): Promise<void> => {
    if (usersOf(template.template_id).some((user) => user.recipe_id !== except)) {
      store.updateTemplate(template.template_id, { origin: { kind: 'owner' } });
      return;
    }
    if (!store.deleteTemplate(template.template_id)) return;
    // A row narrowed to it would wait forever.
    await deps.switchOffTriggers?.((trigger) => trigger.filter?.['record.template'] === template.template_id);
  };

  return {
    preview: (recipes) =>
      recipes.flatMap((recipe) =>
        mailTemplateStarters(recipe.variables).flatMap(({ variable, starter }) => {
          const existing = ownTemplateOf(store, recipe.recipe_id, variable);
          const definition = templateDefinition(starter, existing);
          if (definition === null) return [];
          // Only a template that will be on can meet one already on.
          const twin = existing === undefined || existing.active
            ? activeTwin(store, definition, existing?.template_id ?? null)
            : undefined;
          return [{
            recipe_id: recipe.recipe_id,
            recipe_name: recipe.metadata?.name ?? recipe.recipe_id,
            variable,
            name: definition.name,
            type: definition.type,
            conditions: definition.entrance.conditions,
            reads: mailTemplateReads(definition),
            action: existing === undefined ? 'add' as const : 'update' as const,
            ...(twin !== undefined ? { twin: { template_id: twin.template_id, name: twin.name } } : {}),
            trigger: startsOnFacts(recipe),
          }];
        })),

    factSources: (recipes) => {
      const kinds = [...MAIL_FACT_BUILTIN_TYPES, ...store.listCustomTypes()];
      const off = store.standardsOff();
      const brought = new Set(recipes.flatMap((recipe) =>
        mailTemplateStarters(recipe.variables).map(({ starter }) => starter.type)));
      return recipes.flatMap((recipe) => {
        const watched = new Map<MailFactTypeId, { name: string; variables: Set<string> }>();
        for (const entry of recipe.event_triggers ?? []) {
          // One narrowed to the recipe's own template reads what its starter brings.
          if (entry === null || typeof entry !== 'object' || typeof entry.on !== 'string'
            || entry.template_variable !== undefined) continue;
          const parsed = parseTriggerOn(entry.on);
          if (parsed?.kind !== 'mail_fact') continue;
          const fields = Array.isArray(entry.fields)
            ? entry.fields.filter((field): field is string => typeof field === 'string')
            : [];
          // Any kind, on any change: every kind of email, too broad to say.
          if (parsed.type === null && fields.length === 0) continue;
          for (const spec of kinds) {
            const names = new Set(mailFactTypeVariables(spec).map((variable) => variable.name));
            if (parsed.type !== null ? spec.id !== parsed.type : !fields.some((field) => names.has(field))) continue;
            const slot = watched.get(spec.id) ?? { name: spec.name, variables: new Set<string>() };
            for (const field of fields) if (names.has(field)) slot.variables.add(field);
            watched.set(spec.id, slot);
          }
        }
        if (watched.size === 0) return [];
        return [{
          recipe_id: recipe.recipe_id,
          recipe_name: recipe.metadata?.name ?? recipe.recipe_id,
          kinds: [...watched].map(([type, slot]) => ({
            type,
            name: slot.name,
            variables: [...slot.variables],
            standards: isMailFactStandardsType(type) && !off.has(type),
            templates: store.listTemplates({ type, active: true }).length,
            brought: brought.has(type),
          })),
        }];
      });
    },

    sync: (install, choices = []) => {
      const { recipe, publisher_id } = install;
      const recipe_id = recipe.recipe_id;
      const outcomes: MailTemplateInstallOutcome[] = [];
      let changed = false;
      const origin: (variable: string) => MailTemplateOrigin = (variable) => ({
        kind: 'recipe',
        publisher: publisher_id,
        recipe: recipe_id,
        variable,
        version: install.version,
        ...(install.pack !== undefined ? { pack: install.pack } : {}),
      });
      // D-319 — each dish holds its own setting. A fresh install has no dish,
      // so nothing is written: a new dish starts from `defaultsFor`. An update
      // fills the dishes whose setting names no template now.
      const dishes = (): ReadonlyArray<SettingsDish> => deps.settings.dishesOf(recipe_id);
      const fill = (variable: string, template_id: string): void => {
        for (const dish of dishes()) {
          const held = templateSettingOf(dish.config_overlay, variable);
          if (held !== null && store.getTemplate(held) !== null) continue;
          deps.settings.set(dish.dish_id, variable, template_id);
          changed = true;
        }
      };
      /** The template the recipe reads, when it is another: its main dish's
       *  setting, or — with no dish yet — what a new dish starts from. */
      const mainUses = (variable: string, template_id: string): MailTemplate | null => {
        const main = dishes().find((dish) => dish.is_default);
        const held = main === undefined ? chosenFor(recipe_id, variable) : templateSettingOf(main.config_overlay, variable);
        return held !== null && held !== template_id ? store.getTemplate(held) : null;
      };
      const starters = mailTemplateStarters(recipe.variables);
      for (const { variable, starter } of starters) {
        const keep = choices.find((choice) => choice.recipe_id === recipe_id && choice.variable === variable)?.keep ?? 'recipe';
        const existing = ownTemplateOf(store, recipe_id, variable);
        const definition = templateDefinition(starter, existing);
        if (definition === null) {
          log(`[d-315] recipe ${JSON.stringify(recipe_id)}: the starter of '${variable}' cannot be stored — skipped`);
          continue;
        }
        if (existing === undefined) {
          const twin = activeTwin(store, definition, null);
          const recipeOn = twin === undefined || keep === 'recipe';
          if (twin !== undefined && recipeOn) store.updateTemplate(twin.template_id, { active: false });
          const created = store.createTemplate({ definition, origin: origin(variable), active: recipeOn });
          changed = true;
          if (twin !== undefined && recipeOn) repoint(twin.template_id, created.template_id);
          fill(variable, recipeOn ? created.template_id : twin!.template_id);
          const uses = mainUses(variable, created.template_id);
          outcomes.push({
            recipe_id,
            variable,
            template_id: created.template_id,
            name: created.name,
            action: 'created',
            active: recipeOn,
            ...(twin !== undefined && recipeOn ? { switched_off: { template_id: twin.template_id, name: twin.name } } : {}),
            ...(uses !== null ? { uses: { template_id: uses.template_id, name: uses.name } } : {}),
          });
          continue;
        }
        // An update: the recipe's rules, the owner's settings.
        const redefined = !sameDefinition(existing, definition);
        let active = existing.active;
        let switchedOff: MailTemplate | undefined;
        let keptOn: MailTemplate | undefined;
        if (active && redefined) {
          const twin = activeTwin(store, definition, existing.template_id);
          if (twin !== undefined && keep === 'recipe') {
            store.updateTemplate(twin.template_id, { active: false });
            switchedOff = twin;
          } else if (twin !== undefined) {
            active = false;
            keptOn = twin;
          }
        }
        const newOrigin = origin(variable);
        if (redefined || active !== existing.active || !sameOrigin(existing.origin, newOrigin)) {
          store.updateTemplate(existing.template_id, {
            ...(redefined ? { definition } : {}),
            active,
            origin: newOrigin,
          });
          changed = true;
        }
        if (switchedOff !== undefined) repoint(switchedOff.template_id, existing.template_id);
        if (keptOn !== undefined) repoint(existing.template_id, keptOn.template_id);
        fill(variable, existing.template_id);
        const uses = mainUses(variable, existing.template_id);
        outcomes.push({
          recipe_id,
          variable,
          template_id: existing.template_id,
          name: definition.name,
          action: redefined ? 'updated' : 'unchanged',
          active,
          ...(switchedOff !== undefined ? { switched_off: { template_id: switchedOff.template_id, name: switchedOff.name } } : {}),
          ...(uses !== null ? { uses: { template_id: uses.template_id, name: uses.name } } : {}),
        });
      }
      // A starter this version no longer brings goes, as on uninstall.
      const brought = new Set(starters.map((entry) => entry.variable));
      const dropped = store.listTemplates().filter((template) =>
        template.origin.kind === 'recipe' && template.origin.recipe === recipe_id && !brought.has(template.origin.variable));
      for (const template of dropped) {
        changed = true;
        void release(template, '').catch((error: unknown) => {
          log(`[d-315] removing the template a recipe no longer brings failed: ${(error as Error).message ?? String(error)}`);
        });
      }
      settled(changed);
      return outcomes;
    },

    removeFor: async (recipe_id) => {
      const own = store.listTemplates().filter((template) =>
        template.origin.kind === 'recipe' && template.origin.recipe === recipe_id);
      for (const template of own) await release(template, recipe_id);
      settled(own.length > 0);
    },

    duplicate: (template_id) => {
      const original = store.getTemplate(template_id);
      if (original === null) return null;
      // The copy reads that mail in the original's place (ruling 31).
      if (original.active) store.updateTemplate(template_id, { active: false });
      const copy = store.createTemplate({
        definition: { ...mailTemplateDefinitionOf(original), name: `${original.name} (copy)` },
        origin: { kind: 'owner' },
        active: original.active,
      });
      repoint(template_id, copy.template_id);
      settled(true);
      return copy;
    },

    usersOf,

    defaultsFor: (recipe_id) => {
      const recipe = deps.recipes.get(recipe_id);
      if (recipe === null) return {};
      const defaults: Record<string, unknown> = {};
      for (const variable of templateVariablesOf(recipe)) {
        const chosen = chosenFor(recipe_id, variable);
        if (chosen !== null) defaults[variable] = chosen;
      }
      return defaults;
    },
  };
};
