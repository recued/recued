/** D-348 slice 3 — a chain's call by the name the owner knows it by, for the page that lists them.
 *
 *  The same names their approvals use: a chat write as its "Allow in this chat" names it ("Add a
 *  task", `describeTriggerPreapprovalTier1Op`); a recipe's step or a pack action as the approval
 *  card's Action row names it (`heldActionName`: "Send mail" from its manifest, "Update deal ·
 *  HubSpot" composed from a catalog operation's id). Display only: undefined when there is none,
 *  and the page shows the call by its operation then. */

import {
  chainTier1CallArgs, describeTriggerPreapprovalTier1Op, RESERVED_LOCAL_CALENDAR_SLUG,
  type ApprovalValueLabels, type ChainCallSignature, type InternalToolRegistry,
} from '@recued/contracts';

import { heldActionName, type ActionManifestLookup } from './ask-card-action-name.js';

export const chainCallName = (
  signature: Pick<ChainCallSignature, 'op'>,
  getManifest: ActionManifestLookup,
): string | undefined => {
  const at = signature.op.indexOf(':');
  if (at < 0) return undefined;
  const kind = signature.op.slice(0, at);
  const rest = signature.op.slice(at + 1);
  if (kind === 'tier1') {
    const described = describeTriggerPreapprovalTier1Op(rest);
    // It hands the op's own key back when it has no name for it.
    return described === rest ? undefined : described;
  }
  const parts = rest.split('|');
  if (kind === 'step') {
    const [, ingredient = '', operation = ''] = parts;
    return (operation !== '' ? heldActionName(operation, getManifest) : undefined)
      ?? (ingredient !== '' ? heldActionName(ingredient, getManifest) : undefined);
  }
  if (kind === 'op') {
    const [catalog = '', operation = ''] = parts;
    return catalog !== '' && operation !== '' ? heldActionName(`${catalog}.${operation}`, getManifest) : undefined;
  }
  return undefined;
};

/** How the owner knows the values a chat write names, as its approval card names them: an event by
 *  its title and when it is, a record by its title (the chat's own lookup, `askValueLabels`, on
 *  the owner's clock). A suggestion read "Source ID: 54d0ecc0-…" (live, 2026-11-13). Undefined for
 *  any other call, one that names nothing, and where none is known: the page shows the value.
 *  Asked with no conversation's source, so a lookup a source gates (a contact's name) answers as
 *  its defaults allow, and otherwise names nothing. Never throws. */
export const chainCallPinLabels = async (
  signature: Pick<ChainCallSignature, 'op' | 'pins'>,
  registry: Pick<InternalToolRegistry, 'askValueLabels'> | undefined,
  time_zone: string | undefined,
): Promise<ApprovalValueLabels | undefined> => {
  const call = chainTier1CallArgs(signature);
  if (call === undefined || registry?.askValueLabels === undefined || Object.keys(signature.pins).length === 0) return undefined;
  // On the calendar its scope names: Recued's own, unless another (`writeRuleScopeOf`).
  const args = (call.tool === 'calendar.update' || call.tool === 'calendar.create') && call.scope !== RESERVED_LOCAL_CALENDAR_SLUG
    ? { ...call.args, calendar_id: call.scope } : call.args;
  try {
    return await registry.askValueLabels(call.tool, args,
      { channel: 'internal_function_call', ...(time_zone !== undefined ? { time_zone } : {}) });
  } catch { return undefined; }
};
