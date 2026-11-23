/** D-339 slice 12a (D-339 §5.6) — the owner's chats' switch for a Body's numbers, shown
 *  on every Body page: Off · Ask · Allow (`body-numbers.ts` in contracts).
 *
 *  ⛔ ONE STATE, TWO PLACES. Off and on are the read's recipe's own switch in the owner's contract, the
 *  one Self (you) → Recipes on the Contracts page shows, so the two pages cannot disagree: switched there,
 *  the Body page reads it, and the reverse. Allow is a row of the held-read store, for the owner's chats
 *  alone. */
import {
  BODY_NUMBERS_OPERATION_ID,
  BODY_NUMBERS_RECIPE,
  OWNER_CONTRACT_ID,
  recipeGrantEntry,
  writeRulePrincipalOf,
  type BodyNumbersMode,
  type ExecutionSource,
  type HeldReadHooks,
} from '@recued/contracts';

import type { ContractGrantEntryStore } from './storage/contract-grant-entry-store.js';
import type { HeldReadStore } from './storage/held-read-store.js';

const OWNER_CHAT = { kind: 'owner_chat' } as const;

/** The read's recipe's switch, as the pack's install seeds it (`recipe-grant-seed.ts`). */
export const BODY_NUMBERS_RECIPE_GRANT = recipeGrantEntry(BODY_NUMBERS_RECIPE.publisher_id, BODY_NUMBERS_RECIPE.recipe_id);

export interface BodyNumbersSetting {
  /** As it stands: Off while the read's recipe is switched off for the owner, else Allow when set, else Ask. */
  forChats(): BodyNumbersMode;
  /** Sets it, and returns it as it then stands. */
  setForChats(mode: BodyNumbersMode): BodyNumbersMode;
}

export const createBodyNumbersSetting = (deps: {
  grants: Pick<ContractGrantEntryStore, 'get' | 'set'>;
  heldReads: HeldReadStore;
  now?: () => number;
}): BodyNumbersSetting => {
  const now = deps.now ?? Date.now;
  const forChats = (): BodyNumbersMode => {
    // A recipe is the owner's only when its row says so: a recipe key's default is off (D-247 D7), and
    // the pack's install writes the row.
    if (deps.grants.get(OWNER_CONTRACT_ID, BODY_NUMBERS_RECIPE_GRANT) !== true) return 'off';
    return deps.heldReads.allows(OWNER_CHAT, BODY_NUMBERS_OPERATION_ID) ? 'allow' : 'ask';
  };
  return {
    forChats,
    setForChats(mode) {
      const at = now();
      deps.grants.set(OWNER_CONTRACT_ID, BODY_NUMBERS_RECIPE_GRANT, mode !== 'off', at);
      // Off forgets Allow too: switched on again, from here or from the Contracts page, the chats ask.
      deps.heldReads.setAllows(OWNER_CHAT, BODY_NUMBERS_OPERATION_ID, mode === 'allow', at);
      return forChats();
    },
  };
};

/** The run's answer at the gate for a read held at `always`: the owner's chats make a Body's numbers'
 *  read without asking while the switch says Allow. Any other caller, or any other held read, asks. The
 *  caller is the run's source, never the call; `onAdmit` is told each read it lets through. */
export const bodyNumbersHeldReads = (deps: {
  setting: Pick<BodyNumbersSetting, 'forChats'>;
  source: ExecutionSource | undefined;
  onAdmit?: (operation_id: string) => void;
}): HeldReadHooks | undefined => {
  if (deps.source === undefined || writeRulePrincipalOf(deps.source)?.kind !== 'owner_chat') return undefined;
  return {
    admit: ({ operation_id }) => {
      if (operation_id !== BODY_NUMBERS_OPERATION_ID || deps.setting.forChats() !== 'allow') return false;
      deps.onAdmit?.(operation_id);
      return true;
    },
  };
};

/** What a held Body's note tells this caller (`WithheldValues.chats`): the owner's chats' switch, for
 *  the owner's chats; nothing for any other caller, who is told the read asks. */
export const bodyNumbersFor = (
  setting: Pick<BodyNumbersSetting, 'forChats'> | undefined,
  source: ExecutionSource | undefined,
): BodyNumbersMode | undefined =>
  setting !== undefined && source !== undefined && writeRulePrincipalOf(source)?.kind === 'owner_chat'
    ? setting.forChats()
    : undefined;

/** A held Body's names as this caller's read shows them: with the owner's chats' switch for the owner's
 *  chats (`bodyNumbersFor`), as they were for anyone else. One composition for every read that holds them. */
export const withBodyNumbers = (
  withheld: import('./situations/values-on-request.js').WithheldValues | undefined,
  setting: Pick<BodyNumbersSetting, 'forChats'> | undefined,
  source: ExecutionSource | undefined,
): import('./situations/values-on-request.js').WithheldValues | undefined => {
  if (withheld === undefined) return undefined;
  const chats = bodyNumbersFor(setting, source);
  return chats !== undefined ? { ...withheld, chats } : withheld;
};

/** The classifier's question (`RecipeAskLookups.heldReadAllowed`): would the gate's host let this caller
 *  make this held read without asking? The gate's own answer (`bodyNumbersHeldReads`), unrecorded. */
export const bodyNumbersAllowsRead = (
  setting: Pick<BodyNumbersSetting, 'forChats'> | undefined,
  source: ExecutionSource,
  slug: string,
  operation_id: string,
): boolean => setting !== undefined && bodyNumbersHeldReads({ setting, source })?.admit({ slug, operation_id }) === true;
