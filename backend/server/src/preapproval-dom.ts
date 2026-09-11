/** The bridge adapter owns the request builder and final document selection.
 * Preparation only reads authenticated metadata already held by that host. */
import type Database from 'better-sqlite3';
import { BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS, BRIDGE_COMMAND_MAX_TIMEOUT_MS, parsePreapprovalJson,
  type PreapprovalJson } from '@recued/contracts';
import type { PreapprovalCall, PreapprovalRuntimeIdentity } from './preapproval-dispatch-description.js';
import { describeBridgeDomCall } from './bridges/dom-adapter.js';
import type { BridgeDispatcher, DispatchRequest, ReviewedBridgeBinding } from './bridges/dispatcher.js';
import { recordPreapprovalContractRead, PREAPPROVAL_CLIENT_TOKEN_QUERY } from './storage/preapproval-contract-reads.js';

export const describeDomCommand = (request: DispatchRequest) => ({ ingredient: request.ingredient,
  action: request.action, args: request.args, expects_output_keys: request.expects_output_keys,
  target_domain_pattern: request.target_domain_pattern ?? request.ingredient.domain_allowlist[0] ?? null,
  timeout_ms: typeof request.timeout_ms === 'number' && Number.isFinite(request.timeout_ms) && request.timeout_ms > 0
    ? Math.min(BRIDGE_COMMAND_MAX_TIMEOUT_MS, request.timeout_ms) : BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS });

export interface ReviewedDomSnapshot {
  version: 1;
  binding: ReviewedBridgeBinding;
  commands: ReturnType<typeof describeDomCommand>[];
}
export const readReviewedDomSnapshot = (value: PreapprovalJson | undefined): ReviewedDomSnapshot | null =>
  value && typeof value === 'object' && !Array.isArray(value) && value.version === 1
    && value.binding && Array.isArray(value.commands) ? value as unknown as ReviewedDomSnapshot : null;

export const describeReviewedDom = (db: Database.Database, dispatcher: BridgeDispatcher | undefined,
  call: PreapprovalCall): PreapprovalRuntimeIdentity => {
  if (!dispatcher?.describeDocument) throw new Error('This bridge dispatcher cannot describe reviewed documents.');
  const description = describeBridgeDomCall(call.manifest, call);
  if (!description.entries.length) throw new Error('This DOM invocation has no concrete action.');
  const requests = description.entries.map(({ action, args, expects_output_keys }): DispatchRequest => ({
    ingredient: description.ingredient, action, args, expects_output_keys,
    recipe_run_id: 'preparation', step_id: 'preparation', idempotency_key: 'preparation',
  }));
  const bindings = requests.map(request => dispatcher.describeDocument!(request));
  const binding = bindings[0];
  if (!binding || bindings.some(row => !row || row.client_token_id !== binding.client_token_id
    || row.document.document_id !== binding.document.document_id || row.document.tab_id !== binding.document.tab_id
    || row.document.url !== binding.document.url)) throw new Error('The browser target is missing or ambiguous; review one concrete document.');
  // Pair rotation/revocation is a material writer dependency, independent of
  // transient WS sessions. No browser token/secret is put in review content.
  recordPreapprovalContractRead(db, PREAPPROVAL_CLIENT_TOKEN_QUERY, [binding.client_token_id], true);
  const token = db.prepare('SELECT client_kind,revoked_at FROM client_tokens WHERE token_id=?')
    .get(binding.client_token_id) as { client_kind: string; revoked_at: number | null } | undefined;
  if (!token || token.client_kind !== 'bridge' || token.revoked_at !== null) throw new Error('The reviewed browser pairing is no longer valid.');
  const snapshot: ReviewedDomSnapshot = { version: 1, binding, commands: requests.map(describeDomCommand) };
  return { family: 'dom', label: call.manifest.name,
    detail: `Use the displayed selectors and values in the existing browser document ${binding.document.url}.`,
    binding: parsePreapprovalJson(snapshot), dispatch_snapshot: parsePreapprovalJson(snapshot),
    connection_id: binding.client_token_id, account_id: null, resources: [], dependencies: [],
    children: [], child_inventory: { complete: true }, nested_recipe: null };
};
