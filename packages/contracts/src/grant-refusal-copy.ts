/** D-346 follow-up (2026-11-08) — one wording for an action, a tool or a recipe its caller may
 *  not use. The owner ruled the two callers apart: *"owner deserved to know everything, so the
 *  refusals should be clear for owner to act upon (set it, install it etc), for other contracts
 *  & llm_gateway … a simple not available for those contract is sufficient"*. So the owner's own
 *  call names where it is turned on (Contracts is its own page; the owner's row reads "Self
 *  (you)", with the tabs Ops, Entities and Recipes, the label a pack's Access tab uses too since
 *  the owner chose the more used of the two on 2026-11-08), and any other contract's call reads only
 *  that it is not available: not why, not whether it is installed, not how to change it, even
 *  when the owner is the one using that contract. Before, the refusals said "is not granted to
 *  this dispatch's governing contract (revoked)", "is not granted by this customer contract" to
 *  every app, and "Re-enable it in Settings → Contracts", a page that is not there.
 *
 *  ⚠ Model-facing: the AI relays these words (`chat-prompt-optimization-log.md`). */
import { CLI_REACHABILITY_OWNER_PRINCIPAL, cliPrincipalFromExecutionSource } from './cli-reachability.js';
import { COLLECTION_GRANT_PREFIX, TOPIC_GRANT_PREFIX } from './grant-entry.js';
import { grantSwitchText } from './grant-switch-guide.js';

/** The tab of a row on the Contracts page that holds the switch. */
export type GrantRefusalTab = 'Ops' | 'Recipes' | 'Ops or Recipes';

/** Whether a run or call is the owner's own: their chat, their app sessions, their schedules. */
export const isOwnersOwnCall = (
  source: Parameters<typeof cliPrincipalFromExecutionSource>[0] | undefined,
): boolean => source !== undefined && cliPrincipalFromExecutionSource(source) === CLI_REACHABILITY_OWNER_PRINCIPAL;

/** `<subject> is turned off for you …` with where to turn it on, for the owner's own call;
 *  `<subject> is not available for this contract.` for any other. `subject` names the thing,
 *  quoted as the caller called it. */
export const grantRefusalSentence = (subject: string, ownersOwn: boolean, tab: GrantRefusalTab): string =>
  ownersOwn
    ? `${subject} is turned off for you, so it did not run. To use it, turn it on under Self (you) → ${tab} `
      + 'on the Contracts page.'
    : contractUnavailableSentence(subject);

/** What any caller but the owner reads when something is not there for its contract, whether it
 *  is switched off, never granted, or not installed: nothing more. */
export const contractUnavailableSentence = (subject: string): string =>
  `${subject} is not available for this contract.`;

/** An AI tool whose own switch is on reached another switch it needs, and that one is off:
 *  "Save to your memory" for `memory.write`, "Your contacts" for `contact.write`. The owner's own
 *  call names that switch by the title the Contracts page shows, on Ops for an action (`core.*`)
 *  and on Entities for your data (`data.*`); any other contract's call reads only that the tool
 *  is not available. `entryKey` is the grant entry the tool checked. */
export const neededSwitchRefusalSentence = (subject: string, entryKey: string, ownersOwn: boolean): string => {
  if (!ownersOwn) return contractUnavailableSentence(subject);
  const named = switchNamed(entryKey);
  return `${subject} needs ${named}, which is turned off for you, so it did not run. `
    + `To use it, turn on ${named} under Self (you) → ${switchTab(entryKey)} on the Contracts page.`;
};

/** A read its caller may not make: the owner's own call reads which of their switches is off
 *  and where (*"Reading contacts is turned off for you. To allow it, turn on "Your contacts"
 *  under Self (you) → Entities on the Contracts page."*); any other contract only that it is
 *  not available (*"Reading contacts is not available for this contract."*), naming no grant.
 *  `what` names the reading, `entryKey` the switch it needs. */
export const readRefusalSentence = (what: string, entryKey: string, ownersOwn: boolean): string =>
  ownersOwn
    ? `${what} is turned off for you. To allow it, turn on ${switchNamed(entryKey)} under Self (you) → `
      + `${switchTab(entryKey)} on the Contracts page.`
    : contractUnavailableSentence(what);

/** A switch as the Contracts page names it: its title in quotes, else its entry key. */
const switchNamed = (entryKey: string): string => {
  const title = grantSwitchText(entryKey)?.title;
  return title === undefined ? `'${entryKey}'` : `"${title}"`;
};

/** The tab of the owner's row that holds a switch: your data and topics on Entities, actions
 *  and AI tools on Ops. */
const switchTab = (entryKey: string): 'Entities' | 'Ops' =>
  entryKey.startsWith(COLLECTION_GRANT_PREFIX) || entryKey.startsWith(TOPIC_GRANT_PREFIX) ? 'Entities' : 'Ops';
