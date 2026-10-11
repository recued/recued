/** D-320 §3.5 — a run's own choice of connection.
 *
 *  A run may carry `connections: { <slot>: <connection name> }` beside its values
 *  (`ExecuteRequest.connections`). It applies to that run only, and nothing is
 *  saved. Which connection a slot uses, each overriding the one before (§3.3): the
 *  default of the pack that holds the slot, the dish's choice, the run's own.
 *
 *  A run reads a step's connection from a setting (`{{config.<var>}}`); a step that
 *  names no connection reads the one the run gives its slot (phase 3,
 *  `slot-settings.ts`). So a choice is applied by writing the chosen connection into
 *  each setting whose steps sign in through that slot, over the dish's value. The
 *  gateway then checks that connection's grants as it always does.
 *
 *  Refused, and never swapped for another connection:
 *  - a slot the run's steps do not sign in through;
 *  - a connection not on the list for that slot: one that some step's catalog is not
 *    bound to, or that is not set up;
 *  - a setting the run's own values also give, as another connection.
 *  The owner's refusal names the list. Anyone else's does not: connection names are
 *  owner-surface information (ruling 12), as the pick layer already treats them.
 *
 *  A recipe that another one calls (D-232, `localRecipeInvoker`) inherits the
 *  caller's settled connection for each slot they share, so one run's steps stay on
 *  one account. A slot the called recipe does not use is skipped, not refused.
 *
 *  A DISH's choice (`Dish.connections`, §3.4) is applied first, under the run's:
 *  the run's own value for a setting wins over it without a conflict, and a slot
 *  the recipe no longer uses is skipped. A connection no longer on the list is
 *  still refused, never swapped: the owner removed it, and the run names the dish
 *  to change. */

import { RpcError, type RecipeDefinition } from '@recued/contracts';

/** The refusal's code; `details.problem` says which rule refused. */
export const CONNECTION_CHOICE_INVALID = 'connection_choice_invalid';
/** A slot's pack lists connections, and none of them is set up. */
export const CONNECTION_NOT_SET_UP = 'connection_not_set_up';

export type ConnectionChoiceProblem =
  | 'malformed'
  | 'unknown_slot'
  | 'not_on_list'
  | 'conflict'
  | 'ambiguous';

/** A pure `{{config.<var>}}` connection ref — the only shape a choice applies to. */
const PURE_CONFIG_REF = /^\{\{\s*config\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

/** One step that signs in through a connection setting. */
export interface ConnectionStep {
  catalog: string;
  variable: string;
}

/** The steps of `recipe` that fetch from a catalog through a connection setting:
 *  `connection` is a pure `{{config.<var>}}` ref to a declared `type: 'connection'`
 *  setting. Prefetch, steps and trigger steps, in that order. An op-step that names
 *  no catalog yet (a vendor-neutral `core.crm.*` before dispatch resolves it) has no
 *  `ingredient`, and is not one. */
export const connectionSteps = (recipe: RecipeDefinition): ConnectionStep[] => {
  const declared = (recipe.variables ?? {}) as Readonly<Record<string, { type?: unknown } | undefined>>;
  const steps = [
    ...(recipe.prefetch_steps ?? []),
    ...(recipe.steps ?? []),
    ...(recipe.trigger_steps ?? []),
  ] as ReadonlyArray<Readonly<Record<string, unknown>>>;
  const out: ConnectionStep[] = [];
  for (const step of steps) {
    if (typeof step.connection !== 'string' || typeof step.ingredient !== 'string') continue;
    const variable = PURE_CONFIG_REF.exec(step.connection.trim())?.[1];
    if (variable === undefined || declared[variable]?.type !== 'connection') continue;
    out.push({ catalog: step.ingredient, variable });
  }
  return out;
};

/** One slot a run signs in through. */
export interface RunConnectionSlot {
  slot: string;
  /** The run's catalogs that sign in through it, in step order. */
  catalogs: string[];
  /** The settings their steps read the connection from. */
  variables: string[];
}

/** Group a run's connection steps by slot (`slotOf`: each catalog's slot, from
 *  `catalogSlotsFrom`), in step order. */
export const runConnectionSlots = (
  steps: readonly ConnectionStep[],
  slotOf: ReadonlyMap<string, string>,
): RunConnectionSlot[] => {
  const bySlot = new Map<string, RunConnectionSlot>();
  for (const { catalog, variable } of steps) {
    const slot = slotOf.get(catalog) ?? catalog;
    const entry = bySlot.get(slot) ?? { slot, catalogs: [], variables: [] };
    if (!entry.catalogs.includes(catalog)) entry.catalogs.push(catalog);
    if (!entry.variables.includes(variable)) entry.variables.push(variable);
    bySlot.set(slot, entry);
  }
  return [...bySlot.values()];
};

const refuse = (
  problem: ConnectionChoiceProblem,
  message: string,
  slot?: string,
): RpcError =>
  new RpcError(CONNECTION_CHOICE_INVALID, message, 400, undefined, {
    problem,
    ...(slot !== undefined ? { slot } : {}),
  });

/** Read a request's `connections`: connection names by slot, each a non-empty
 *  string. Absent or empty is no choice. */
export const readConnectionChoices = (raw: unknown): Record<string, string> | undefined => {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw refuse('malformed', '`connections` must be an object naming a connection for each slot, like { "hubspot": "<connection name>" }.');
  }
  const out: Record<string, string> = {};
  for (const [slot, name] of Object.entries(raw as Record<string, unknown>)) {
    if (slot.trim() === '' || typeof name !== 'string' || name.trim() === '') {
      throw refuse('malformed', `\`connections.${slot}\` must be a connection's name.`, slot);
    }
    out[slot] = name.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

/** The connections a slot can take: those bound to every one of its catalogs in
 *  this run, and set up. */
export const slotList = (
  slot: RunConnectionSlot,
  bindings: readonly { connection_name: string; catalog_slug: string }[],
  enrolled: ReadonlySet<string>,
): string[] => {
  const names = [...new Set(bindings.map((b) => b.connection_name))].sort();
  return names.filter((name) => enrolled.has(name)
    && slot.catalogs.every((catalog) =>
      bindings.some((b) => b.catalog_slug === catalog && b.connection_name === name)));
};

export interface ApplyConnectionChoicesInput {
  recipe_id: string;
  slots: readonly RunConnectionSlot[];
  choices: Readonly<Record<string, string>>;
  /** From a calling recipe: a slot this run does not use is skipped, not refused. */
  inherited: boolean;
  config: Readonly<Record<string, unknown>>;
  /** The settings the run's own caller gave, before its dish's merged in. */
  callerKeys: ReadonlySet<string>;
  /** The bindings of the run's catalogs (`bindingsForCatalogs`). */
  bindings: readonly { connection_name: string; catalog_slug: string }[];
  /** Connections set up on this server (each has an operation profile). */
  enrolled: ReadonlySet<string>;
  /** The owner's own run: a refusal may name the list. */
  owner: boolean;
  /** The owner's alias for a connection, for an owner's refusal. */
  displayName?: (connection_name: string) => string | undefined;
  /** D-320 §3.4 — the choice is a DISH's (its name, for a refusal): it yields to
   *  the run's own values for a setting, rather than conflicting with them. */
  dish?: string;
}

const namedList = (
  names: readonly string[],
  displayName: ApplyConnectionChoicesInput['displayName'],
): string =>
  names
    .map((name) => {
      const alias = displayName?.(name);
      return alias !== undefined && alias !== '' && alias !== name ? `${name} (${alias})` : name;
    })
    .join(', ');

/** The refusal for a connection the run cannot use for `slotName`. */
export const notOnList = (
  input: Pick<ApplyConnectionChoicesInput, 'recipe_id' | 'inherited' | 'owner' | 'displayName' | 'dish'>,
  slotName: string,
  chosen: string,
  list: readonly string[],
): RpcError => {
  // A dish's choice and a calling run's are the owner's: only the owner is told
  // which connection they name (ruling 12). A caller's own choice is its own.
  if (input.dish !== undefined) {
    return refuse(
      'not_on_list',
      input.owner
        ? `Dish '${input.dish}' uses '${chosen}' for '${slotName}', and '${chosen}' is not one of the connections recipe '${input.recipe_id}' can use for '${slotName}'. It did not run on another: choose one on the dish.${list.length > 0 ? ` They are: ${namedList(list, input.displayName)}.` : ''}`
        : `Dish '${input.dish}' uses a connection for '${slotName}' that recipe '${input.recipe_id}' cannot use. It did not run on another: the owner can choose one on the dish.`,
      slotName,
    );
  }
  if (input.inherited) {
    return refuse(
      'not_on_list',
      input.owner
        ? `Recipe '${input.recipe_id}' was called by a run that uses '${chosen}' for '${slotName}', and '${chosen}' is not one of the connections this recipe's packs use for '${slotName}'. One run stays on one account, so it did not run on another. Add '${chosen}' on the pack's Access page.`
        : `Recipe '${input.recipe_id}' was called by a run whose connection for '${slotName}' this recipe's packs do not use. One run stays on one account, so it did not run on another.`,
      slotName,
    );
  }
  return refuse(
    'not_on_list',
    input.owner
      ? `'${chosen}' is not one of the connections recipe '${input.recipe_id}' can use for '${slotName}'. ${list.length > 0 ? `They are: ${namedList(list, input.displayName)}.` : 'It has none set up.'}`
      : `'${chosen}' is not one of the connections recipe '${input.recipe_id}' can use for '${slotName}'. Ask the owner which connection to use, or leave '${slotName}' out to use the owner's default.`,
    slotName,
  );
};

/** Write each chosen connection into the settings its slot's steps read. Returns
 *  the new config and the slots it applied to; throws `connection_choice_invalid`
 *  for a choice it cannot apply. A slot no step signs in through yet (a
 *  vendor-neutral op-step's, before dispatch resolves it) is left for
 *  `chooseForVendorNeutral` and the final check. */
export const applyConnectionChoices = (
  input: ApplyConnectionChoicesInput,
): { config: Record<string, unknown>; applied: string[] } => {
  const config: Record<string, unknown> = { ...input.config };
  const applied: string[] = [];
  for (const [slotName, chosen] of Object.entries(input.choices)) {
    const slot = input.slots.find((s) => s.slot === slotName);
    if (slot === undefined) continue;
    // A dish's choice the run's own values set aside entirely is not used, so it
    // cannot stand in the way of the run, stale or not.
    if (input.dish !== undefined && slot.variables.every((variable) => {
      const own = input.callerKeys.has(variable) ? config[variable] : undefined;
      return typeof own === 'string' && own.trim() !== '';
    })) continue;
    const list = slotList(slot, input.bindings, input.enrolled);
    if (!list.includes(chosen)) throw notOnList(input, slotName, chosen, list);
    for (const variable of slot.variables) {
      const own = input.callerKeys.has(variable) ? config[variable] : undefined;
      // A dish's choice yields to the run's own value for a setting.
      if (input.dish !== undefined && typeof own === 'string' && own.trim() !== '') continue;
      if (typeof own === 'string' && own.trim() !== '' && own.trim() !== chosen) {
        throw refuse(
          'conflict',
          `Recipe '${input.recipe_id}': config.${variable} names '${own.trim()}' and connections.${slotName} names '${chosen}'. Give one of them.`,
          slotName,
        );
      }
      config[variable] = chosen;
    }
    applied.push(slotName);
  }
  return { config, applied };
};

export interface ChooseForVendorNeutralInput {
  recipe_id: string;
  /** The settings vendor-neutral op-steps read (`canonicalSlotVariables`). */
  variables: readonly string[];
  /** The choices not applied to a slot yet, by slot. */
  choices: Readonly<Record<string, string>>;
  config: Readonly<Record<string, unknown>>;
  callerKeys: ReadonlySet<string>;
  /** The connections that can serve a setting's op-steps (`derivePickCandidates`). */
  candidatesFor: (variable: string) => readonly string[];
  /** A dish's choice: a setting the run's own values give keeps that value. */
  yieldToCaller?: boolean;
}

/** A vendor-neutral op-step (`core.crm.deal.read`) names no pack: the connection it
 *  is given decides the vendor, and so the slot. Bind its setting to the one chosen
 *  connection that can serve it. None can: the setting keeps what it had, and
 *  `assertChoicesPlaced` refuses a choice nothing took. Two can, or the run's own
 *  values give the setting as another connection: refused. */
export const chooseForVendorNeutral = (
  input: ChooseForVendorNeutralInput,
): { config: Record<string, unknown>; applied: string[] } => {
  const config: Record<string, unknown> = { ...input.config };
  const applied: string[] = [];
  const named = Object.entries(input.choices);
  if (named.length === 0) return { config, applied };
  for (const variable of input.variables) {
    const candidates = new Set(input.candidatesFor(variable));
    const fits = named.filter(([, name]) => candidates.has(name));
    if (fits.length === 0) continue;
    if (fits.length > 1) {
      throw refuse(
        'ambiguous',
        `Recipe '${input.recipe_id}': config.${variable} can take ${fits.map(([slot, name]) => `'${name}' (for '${slot}')`).join(' or ')}. Name one.`,
      );
    }
    const [slot, name] = fits[0]!;
    const own = input.callerKeys.has(variable) ? config[variable] : undefined;
    if (input.yieldToCaller === true && typeof own === 'string' && own.trim() !== '') continue;
    if (typeof own === 'string' && own.trim() !== '' && own.trim() !== name) {
      throw refuse(
        'conflict',
        `Recipe '${input.recipe_id}': config.${variable} names '${own.trim()}' and connections.${slot} names '${name}'. Give one of them.`,
        slot,
      );
    }
    config[variable] = name;
    if (!applied.includes(slot)) applied.push(slot);
  }
  return { config, applied };
};

/** The refusal for a slot the recipe's steps do not sign in through. */
export const unknownSlot = (recipe_id: string, slot: string, used: readonly string[]): RpcError =>
  refuse(
    'unknown_slot',
    used.length > 0
      ? `Recipe '${recipe_id}' signs in to no '${slot}'. The connections it uses: ${used.map((s) => `'${s}'`).join(', ')}.`
      : `Recipe '${recipe_id}' signs in to no '${slot}': it uses no connection.`,
    slot,
  );

/** Before the steps are resolved: a choice that no slot of the run's steps took,
 *  and that no vendor-neutral op-step can use either, is refused now, rather than
 *  left for the pick layer to ask about or for a dish's value to stand in for. A
 *  choice a calling run passed down is skipped instead. */
export const assertChoicesPlaced = (input: {
  recipe_id: string;
  choices: Readonly<Record<string, string>>;
  inherited: boolean;
  /** The slots a choice was written into, by either rule. */
  placed: readonly string[];
  /** The run's slots its pack-named steps sign in through. */
  slots: readonly RunConnectionSlot[];
  /** The connections that can serve its vendor-neutral op-steps; absent when it
   *  has none. */
  vendorNeutralCandidates?: readonly string[];
  owner: boolean;
  displayName?: (connection_name: string) => string | undefined;
}): void => {
  if (input.inherited) return;
  for (const [slot, chosen] of Object.entries(input.choices)) {
    if (input.placed.includes(slot)) continue;
    const candidates = input.vendorNeutralCandidates;
    if (candidates === undefined) throw unknownSlot(input.recipe_id, slot, input.slots.map((s) => s.slot));
    throw refuse(
      'not_on_list',
      input.owner
        ? `'${chosen}' cannot run recipe '${input.recipe_id}'s steps for '${slot}'. ${candidates.length > 0 ? `Connections that can: ${namedList(candidates, input.displayName)}.` : 'None of the connections set up can.'}`
        : `'${chosen}' cannot run recipe '${input.recipe_id}'s steps for '${slot}'. Ask the owner which connection to use, or leave '${slot}' out to use the owner's default.`,
      slot,
    );
  }
};

/** The final check, once the run's steps are resolved: every chosen slot is one
 *  the run signs in through, and every setting its steps read holds the chosen
 *  connection. A vendor-neutral op-step learns its slot only now, and a dish's
 *  value may be what it resolved with: that would run on another account than the
 *  one named, so it is refused. A choice a calling run passed down is held to the
 *  second rule only. */
export const assertChoicesHeld = (input: {
  recipe_id: string;
  slots: readonly RunConnectionSlot[];
  choices: Readonly<Record<string, string>>;
  inherited: boolean;
  config: Readonly<Record<string, unknown>>;
  variables: RecipeDefinition['variables'];
  bindings: readonly { connection_name: string; catalog_slug: string }[];
  enrolled: ReadonlySet<string>;
  owner: boolean;
  displayName?: (connection_name: string) => string | undefined;
  /** A DISH's choices (its name, for a refusal): a slot the run does not use is
   *  skipped, as an inherited one is. */
  dish?: string;
  /** Settings the run's own values give: a dish's choice yields to them. */
  exempt?: ReadonlySet<string>;
}): void => {
  const declared = (input.variables ?? {}) as Readonly<Record<string, { default?: unknown } | undefined>>;
  const valueOf = (variable: string): string | undefined => {
    const value = input.config[variable] ?? declared[variable]?.default;
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };
  for (const [slotName, chosen] of Object.entries(input.choices)) {
    const slot = input.slots.find((s) => s.slot === slotName);
    if (slot === undefined) {
      if (input.inherited || input.dish !== undefined) continue;
      throw unknownSlot(input.recipe_id, slotName, input.slots.map((s) => s.slot));
    }
    const held = slot.variables
      .filter((variable) => !(input.exempt?.has(variable) ?? false))
      .every((variable) => valueOf(variable) === chosen);
    if (held) continue;
    throw notOnList(input, slotName, chosen, slotList(slot, input.bindings, input.enrolled));
  }
};

/** One slot and a connection the run used for it. */
export interface ConnectionUsed {
  slot: string;
  connection_name: string;
}

/** The connections a run's slots settled on: the value each setting holds, else its
 *  default. Sorted by slot, then connection. A slot whose steps read two settings
 *  holding two connections (a hand-written recipe) is listed with both. */
export const settledConnections = (
  slots: readonly RunConnectionSlot[],
  config: Readonly<Record<string, unknown>>,
  variables: RecipeDefinition['variables'],
): ConnectionUsed[] => {
  const declared = (variables ?? {}) as Readonly<Record<string, { default?: unknown } | undefined>>;
  const out: ConnectionUsed[] = [];
  for (const slot of slots) {
    const names = new Set<string>();
    for (const variable of slot.variables) {
      const value = config[variable] ?? declared[variable]?.default;
      if (typeof value === 'string' && value.trim() !== '') names.add(value.trim());
    }
    for (const connection_name of names) out.push({ slot: slot.slot, connection_name });
  }
  return out.sort((a, b) =>
    a.slot === b.slot ? a.connection_name.localeCompare(b.connection_name) : a.slot.localeCompare(b.slot));
};

/** D-320 audit — a slot the run settled no connection for, whose pack lists
 *  connections none of which is set up (deleted, or named at install and never set
 *  up): refused here, saying so. It reached the gateway naming none and was refused
 *  as "needs a connection and this run named none", which does not say why; before
 *  the audit, a name never set up still had an operation profile, so the run took it
 *  and failed on the missing connection instead. The owner is told the names; any
 *  other caller is told none (ruling 12). A slot whose list holds a connection that
 *  is set up is left alone: the pick layer or the pack's default has answered it. */
export const assertListedConnectionsSetUp = (input: {
  recipe_id: string;
  slots: readonly RunConnectionSlot[];
  used: readonly ConnectionUsed[];
  bindings: readonly { connection_name: string; catalog_slug: string }[];
  /** Read only for a slot that settled none and whose pack lists some: a run that
   *  settled every slot never reads it. */
  enrolled: () => ReadonlySet<string>;
  owner: boolean;
}): void => {
  let enrolled: ReadonlySet<string> | undefined;
  for (const slot of input.slots) {
    if (input.used.some((used) => used.slot === slot.slot)) continue;
    const listed = [...new Set(input.bindings
      .filter((binding) => slot.catalogs.includes(binding.catalog_slug))
      .map((binding) => binding.connection_name))].sort();
    if (listed.length === 0) continue;
    enrolled ??= input.enrolled();
    if (listed.some((name) => enrolled!.has(name))) continue;
    const quoted = listed.map((name) => `'${name}'`);
    const which = quoted.length === 1
      ? `its pack's connection ${quoted[0]} is not set up`
      : `its pack's connections ${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)} are not set up`;
    throw new RpcError(
      CONNECTION_NOT_SET_UP,
      input.owner
        ? `Recipe '${input.recipe_id}' needs a connection for '${slot.slot}', and ${which}. `
          + `Set ${quoted.length === 1 ? 'it' : 'one'} up under Connections, or add a connection to the pack on its Access tab.`
        : `Recipe '${input.recipe_id}' needs a connection for '${slot.slot}', and no connection on its pack's list is set up.`,
      400,
      undefined,
      { slot: slot.slot },
    );
  }
};

/** What a called recipe inherits: each slot that settled on one connection. */
export const inheritableConnections = (used: readonly ConnectionUsed[]): Record<string, string> => {
  const counts = new Map<string, number>();
  for (const u of used) counts.set(u.slot, (counts.get(u.slot) ?? 0) + 1);
  const out: Record<string, string> = {};
  for (const u of used) if (counts.get(u.slot) === 1) out[u.slot] = u.connection_name;
  return out;
};
