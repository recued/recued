/** The approval card's "Action" row, in the owner's words.
 *
 *  ⛔ IT SHOWED THE ACTION'S ID. A held send's card read "Action: mail-send"
 *  under a title in the owner's words ("Approve: Send a composed email"), the
 *  last engine word on it (owner, 2026-10-19). The ask names its action by id —
 *  `handler_payload.tool_slug`, the same value its `Technical:` line prints —
 *  and that id already leads to a name the owner can read:
 *    - an ingredient's manifest names it: `mail-send` is "Send mail", and a
 *      built-in op id (`core.mail.send`) reaches it through its backing slug;
 *    - a catalog operation's id composes into one (`describeCatalogOperation`):
 *      `recued-core/hubspot.deal.update` is "Update deal · HubSpot".
 *  Neither ⇒ no name, and the card keeps the id in its technical bits.
 *
 *  ⚠ DISPLAY ONLY, and read off the ask itself: no store is touched, so naming
 *  costs the ask list nothing and can never fail it. */

import { describeCatalogOperation, kernelOpBackingSlug } from '@recued/contracts';
import { PREFLIGHT_HANDLER_KIND } from '@recued/gateway';
import type { PendingAsk } from '@recued/notification';

/** `<publisher>/<catalog>.<entity>.<action>` — a catalog operation's id. */
const CATALOG_OPERATION_ID = /^[^/\s]+\/([^/.\s]+)\.([^/\s]+)$/;

/** An ingredient's manifest, as far as naming needs it. */
export type ActionManifestLookup = (slug: string) => { readonly name?: unknown } | null | undefined;

/** The owner's name for the action an ask holds, or undefined when its id
 *  leads to none. */
export const heldActionName = (action: string, getManifest: ActionManifestLookup): string | undefined => {
  for (const slug of [action, kernelOpBackingSlug(action)]) {
    if (slug === undefined) continue;
    const name = getManifest(slug)?.name;
    if (typeof name === 'string' && name.trim() !== '') return name.trim();
  }
  const catalog = CATALOG_OPERATION_ID.exec(action);
  if (catalog === null) return undefined;
  const phrase = describeCatalogOperation({
    operation_key: catalog[2]!, operation_id: action, catalog_slug: catalog[1]!,
  });
  // The helper hands the id back when it cannot compose one, and the id is
  // not a name.
  return phrase === action ? undefined : phrase;
};

/** Names the held action of a recipe's approval, or null. */
export const createAskActionNamer = (deps: { readonly getManifest: ActionManifestLookup }) =>
  (ask: Pick<PendingAsk, 'handler_kind' | 'handler_payload'>): string | null => {
    if (ask.handler_kind !== PREFLIGHT_HANDLER_KIND) return null;
    // An AI agent's raw op is the action its ask names, not `tool_slug`, and
    // the card shows that ask's text as written.
    if (ask.handler_payload.raw_op_id !== undefined) return null;
    const action = ask.handler_payload.tool_slug;
    if (typeof action !== 'string' || action.trim() === '') return null;
    try {
      return heldActionName(action.trim(), deps.getManifest) ?? null;
    } catch {
      // A lookup that throws names nothing; it never costs the owner the list.
      return null;
    }
  };
