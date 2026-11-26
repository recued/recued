/** D-327 — an agreement's grants, read as its key's tool list.
 *
 *  A key bound to an agreement whose `key_authority` is `'contract'`
 *  ({@link isKeyAuthorityContract}) carries no permissions of its own. The token
 *  store hands every reader that key's checklist computed HERE from the
 *  agreement's explicit grant rows, so the many places that read a key's
 *  checklist (the MCP wire gate and catalog, the snapshot's `allowed_tools`,
 *  approval resume, preapproval, recipe callbacks, the AI door, the peer
 *  loopback filter) all follow the agreement without each learning a second
 *  rule.
 *
 *  ⛔ ONLY WHAT A CHECKLIST CAN HOLD. The issue rpc accepts three kinds of key
 *  into a checklist (`preflightExternalToolGrant`): a Tier-1 tool name, a
 *  Tier-2 `<publisher>/<recipe_id>`, and a grantable kernel op id. Those are
 *  the only rows that project. Everything else on an agreement is read by the
 *  agreement's own checks at dispatch and needs no checklist entry: pack ops
 *  (the raw-op gate asks the agreement directly), collections and topics (the
 *  read-grant checker), peer labels (the peer-ask handler).
 *
 *  ⚠ A KEY WITH NO ENTRY HERE IS REFUSED, NOT ADMITTED. A tool with no grant
 *  handle on an agreement (`recued_listRecipes`, `recued_runRecipe`, direct
 *  ingredient calls, canonical op tools) never projects, so an agreement's key
 *  cannot reach it at all. That is the fail-closed direction, and the price of
 *  "the agreement is the only gate": a tool the agreement has no switch for is a
 *  tool its key does not get.
 *
 *  ⚠ One exception, by the owner's ruling (2026-11-23): the tools an AI app starts
 *  and ends a job with (`recued_startJob`, `recued_endJob`, D-402 slice A2) come with
 *  any browser tool the agreement grants ({@link BROWSER_JOB_TOOLS}). Live, Codex on an
 *  agreement's key was told "not available for this contract" for both, so no app on
 *  a key could make its browser work into a recipe. */

import { TIER1_TOOL_NAME_SET, type Tier1ToolName } from './chat.js';
import { parseGrantEntry, PRIMITIVE_GRANT_PREFIX } from './grant-entry.js';
import { getKernelOp, isGrantableKernelOp, isRegisteredKernelOp } from './kernel-op-registry.js';

/** The Browser Toolkit's recipes (`community/packs/browser-toolkit.json`; a test holds the two equal), by slug. */
export const BROWSER_TOOLKIT_RECIPE_SLUGS: ReadonlySet<string> = new Set([
  'list-browser-bridges', 'list-browser-tabs', 'open-web-page', 'inspect-web-page', 'read-web-text', 'read-web-element',
  'wait-for-web-element', 'read-web-table', 'save-web-file', 'screenshot-web-page', 'ask-web-page', 'scroll-web-page',
  'type-into-web-page', 'click-web-element', 'press-on-web-page', 'act-on-web-page',
]);

/** 2026-11-23 (the owner: "recued_startJob/recued_endJob should be just another tool in contracts required to be enabled
 *  if any browser tool is enabled") — the tools an AI app starts and ends a job with, so its browser calls can be made
 *  into a recipe (D-402 slice A2). They have no switch of their own: an agreement that grants any browser tool gives
 *  its key these too, and one that grants none does not. */
export const BROWSER_JOB_TOOLS = ['recued_startJob', 'recued_endJob'] as const;

/** Whether a key's tool is a browser tool: a Browser Toolkit recipe (`recued-core/<slug>`) or a browser op (`core.dom.*`). */
export const isBrowserKeyTool = (name: string): boolean => {
  if (getKernelOp(name)?.domain === 'dom') return true;
  const slash = name.indexOf('/');
  return slash > 0 && name.slice(0, slash) === 'recued-core' && BROWSER_TOOLKIT_RECIPE_SLUGS.has(name.slice(slash + 1));
};

/** The checklist name one agreement grant row stands for, or undefined when the
 *  row is read by the agreement's own checks instead (see the module note). */
export const keyToolNameForGrantEntry = (entryKey: string): string | undefined => {
  const parsed = parseGrantEntry(entryKey);
  if (parsed.kind === 'recipe') {
    const slash = parsed.value.indexOf('/');
    return slash > 0 && slash < parsed.value.length - 1 ? parsed.value : undefined;
  }
  if (parsed.kind !== 'op') return undefined;
  if (parsed.value.startsWith(PRIMITIVE_GRANT_PREFIX)) {
    const name = parsed.value.slice(PRIMITIVE_GRANT_PREFIX.length);
    return TIER1_TOOL_NAME_SET.has(name as Tier1ToolName) ? name : undefined;
  }
  // ⛔ GRANTABLE kernel ops only. `core.ai.*` and the push-side ops are kept off
  // every door on purpose (KERNEL_OP_GRANT_EXCLUSIONS), and an agreement row
  // must not become the route around that.
  return isGrantableKernelOp(parsed.value) ? parsed.value : undefined;
};

/** A key-authority agreement's grant rows as its key's checklist. An explicit
 *  revoke (`granted: false`) and a row that does not project add nothing — the
 *  checklist is an allow-list, and absence is refusal. Pure. */
export const keyChecklistFromAgreementGrants = (
  rows: ReadonlyArray<{ readonly entry_key: string; readonly granted: boolean }>,
): Record<string, boolean> => {
  const checklist: Record<string, boolean> = {};
  for (const row of rows) {
    if (row.granted !== true) continue;
    const name = keyToolNameForGrantEntry(row.entry_key);
    if (name !== undefined) checklist[name] = true;
  }
  // The job tools come with any browser tool (`BROWSER_JOB_TOOLS`), and go with the last of them.
  if (Object.keys(checklist).some(isBrowserKeyTool)) for (const tool of BROWSER_JOB_TOOLS) checklist[tool] = true;
  return checklist;
};

/** The name the issue rpc's grant check (`preflightExternalToolGrant`) judges for
 *  one agreement row, or undefined when that check has nothing to say about it.
 *
 *  ⛔ THE CHECK MOVES WITH THE GRANT. A key's checklist was only ever written
 *  through issuance, which refused a recipe over the door cost bound, a recipe
 *  exposing Records to a non-owner, and a kernel op kept off doors. An
 *  agreement's key takes its tools from the agreement's rows instead, so the
 *  same check runs when such a row is WRITTEN — otherwise the Recipes tab would
 *  be the way around it.
 *
 *  Like {@link keyToolNameForGrantEntry}, except a registered kernel op that is
 *  kept off doors is returned too, so the check refuses it and says why rather
 *  than the switch silently doing nothing. */
export const keyGrantCheckName = (entryKey: string): string | undefined => {
  const name = keyToolNameForGrantEntry(entryKey);
  if (name !== undefined) return name;
  const parsed = parseGrantEntry(entryKey);
  return parsed.kind === 'op' && isRegisteredKernelOp(parsed.value) ? parsed.value : undefined;
};
