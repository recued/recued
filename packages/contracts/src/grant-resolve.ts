/** Grant-foundation slice 3 (D-187 AMENDMENT `693b7d03`) — the pure grant-resolution
 *  rule + the read-gate composition.
 *
 *  The unified `(contract × grant)` matrix answers every admission/read decision with
 *  ONE three-state rule: an explicit stored grant/revoke wins; absence falls back to
 *  the per-entry AUTHOR DEFAULT. This module is the single source of truth for that
 *  rule and for the amendment's `verb-op ∧ entry` read gate — both pure, both taking
 *  the resolved booleans as inputs so they stay decoupled from the store + the
 *  registry (the caller reads `store.get` + computes the author default, exactly as
 *  the obsoleted D-187 S2 `resolveEnrichmentVisibility(toggle, registryDefault)` took
 *  its `registryDefault` as an input).
 *
 *  Author default per entry kind (computed by the caller, NOT here):
 *    - `op`         — the pack's `composition.default_grants` (read / `approval:ask`
 *                     ops the author pre-grants); kernel `core.*` = the standard
 *                     toolset (default-available).
 *    - `enrichment.<topic>` — the registry `mcp_exposed` hint (`'public'` ⇒ default
 *                     granted, `'private'` ⇒ default not), demoted to an authoring
 *                     default by the amendment.
 *    - `data.<collection>`  — the door/pack's authored read scope.
 *
 *  The OWNER contract is seeded COMPLETE by the boot reconcile, so its reads always
 *  hit an explicit row — the author-default branch is reached only for DOORS' sparse,
 *  un-toggled entries.
 *
 *  Spec: D-187 AMENDMENT block §3; handover
 *  `handover_grant_foundation_slice3_amended.md`. */

import { OWNER_CONTRACT_ID } from './contract-definition.js';

/** The three-state grant rule. `explicit` is the contract's stored value for the
 *  entry — `true` (grant) / `false` (explicit revoke) / `undefined` (no row). A
 *  present row (grant OR revoke) is authoritative; only `undefined` falls back to
 *  `authorDefault`. So an owner revoke (`false`) beats a permissive author default,
 *  and a door's un-toggled entry inherits the author's intent. Pure; total. */
export const resolveGrantEntry = (
  explicit: boolean | undefined,
  authorDefault: boolean,
): boolean => explicit ?? authorDefault;

/** The amendment §3 read gate — a read is admissible iff the contract holds the
 *  VERB-OP grant (`may this contract use this read tool at all`) AND the per-entry
 *  grant resolves true (`may it see THIS topic/collection`). The cross-topic verbs
 *  (`timeline` / `vector_search` / `enrichment.read` / `registry.describe`) are gated
 *  by their verb-op; the per-entry grants filter what they return — a topic/collection
 *  grant does NOT imply the verb. Consumers call THIS rather than AND-ing by hand, so
 *  the gate rule has one definition. Pure. */
export const isGrantedReadAdmissible = (
  verbOpGranted: boolean,
  entryGranted: boolean,
): boolean => verbOpGranted && entryGranted;

// ────────────────────────────────────────────────────────────────
// D-187 slice 3b — OWNER-default-only sensitive read surfaces
// ────────────────────────────────────────────────────────────────

/** The closed set of grant ENTRY KEYS that default-grant to the OWNER contract ONLY
 *  — sensitive read surfaces a door must be EXPLICITLY granted (no wildcard-door /
 *  scope-fence "default on" applies). Owner → default ON; EVERY other contract (door,
 *  incl. a WILDCARD door) → default OFF.
 *
 *  Why these surface families (owner-directed): they expose raw,
 *  high-sensitivity data
 *  with no per-record sensitivity hint of their own (unlike enrichment topics, which
 *  carry an `mcp_exposed` author default):
 *    - `core.contact.engagements.read` — a contact's full engagement history (the
 *      `recued_contactEngagementsList` native tool).
 *    - `core.audit.read` — run history / the audit log (the `recued_getAudit`
 *      native tool), revealing the owner's automation activity.
 *    - `core.memory.read` / `core.memory.write` — the D-198 collective memory pool.
 *    - `core.work-entity.read` — the whole work graph (task / note / commitment /
 *      project) behind the Tier-1 `work.search` / `work.read` tools.
 *    - `core.data.webhook.get` / `core.data.webhook.list` + the `data.webhook`
 *      collection — raw incoming external webhook payloads; and
 *      `core.webhook.event.get`, whose additional active-run authority gate
 *      scopes one accepted decoded event.
 *    - `core.data.form-response.list/get` + `data.form_response` — arbitrary accepted
 *      visitor form contents. Unlike a typed entity, the free-form payload has no
 *      per-field sensitivity contract.
 *
 *  Entry-key form (the value the grant store + the gates key on): an op grant entry is
 *  the bare `operation_id`; a collection grant entry is `data.<collection>`. */
export const OWNER_DEFAULT_ONLY_GRANT_ENTRIES: ReadonlySet<string> = new Set([
  'core.contact.engagements.read',
  'core.audit.read',
  'core.data.form-response.list',
  // D-198 Slice 4 — collective memory is OWNER-on / door-off by default; the
  // seller grants a customer tier in per §3 (fail-closed, opt-in write + read).
  'core.memory.write',
  'core.memory.read',
  // The work graph (task / note / commitment / project) via the Tier-1
  // `work.search` / `work.read` tools — OWNER-on / door-off by default, the
  // same posture as `core.memory.read` and `core.contact.engagements.read`.
  // Before this op existed the reads had NO grant handle, so they were
  // default-ON for any door (Tier-1 + `classification: 'read'` →
  // `buildDefaultMcpInboundTokenGrants` = true) and the only thing standing
  // between a door and the owner's whole work graph was the per-Source
  // `mcp_exposed` flag — which is GLOBAL, not per-door.
  //
  // ⚠ This does NOT contradict the 2026-07-12 raw-collection ruling ("raw
  // collections stay author-default ADMIT … do not harden it by adding
  // `data.contact` to OWNER_DEFAULT_ONLY"). That ruling governs the DATA axis,
  // and `data.task` / `data.note` / … keep their admit-all default untouched.
  // This is the CAPABILITY axis, where every sensitive peer already sits
  // owner-default-only. The two compose AND, so the spine stays open and the
  // door still needs the verb.
  'core.work-entity.read',
  'core.data.webhook.get',
  'core.data.webhook.list',
  'core.webhook.event.get',
  'core.data.form-response.get',
  // D-210 A.8 slice 2 — the lifecycle WRITE. A read of visitor answers is
  // owner-default-only; a write that moves a visitor's state must be at least
  // as closed, or a door could mark an applicant declined.
  'core.data.form-response.set-state',
  'data.webhook',
  'data.form_response',
]);

/** True iff `entryKey` is an OWNER-default-only sensitive surface
 *  ({@link OWNER_DEFAULT_ONLY_GRANT_ENTRIES}). */
export const isOwnerDefaultOnlyEntry = (entryKey: string): boolean =>
  OWNER_DEFAULT_ONLY_GRANT_ENTRIES.has(entryKey);

/** The author-default for an entry, honoring the OWNER-default-only override. A
 *  sensitive entry ({@link isOwnerDefaultOnlyEntry}) defaults ON for the owner and OFF
 *  for a LIVE non-owner DOOR — a fail-safe TIGHTEN over `normalDefault` (it can only turn
 *  a permissive `normalDefault` into a deny for a door; it never loosens). A non-sensitive
 *  entry keeps `normalDefault` unchanged. An explicit stored grant/revoke row still wins
 *  over BOTH (the caller passes the result to `resolveGrantEntry`), so an owner can grant a
 *  door a sensitive surface and the door honours it.
 *
 *  "The owner" here is BOTH the owner contract (`OWNER_CONTRACT_ID`, the chat / messenger
 *  AI) AND a CONTRACT-FREE dispatch (`boundContractId === ''` — the owner's own unbound
 *  stdio / canonical-CLI MCP, the human HID, the system channels): a contract-free read is
 *  owner-trust / not-gated and ADMITS, matching `isOpGranted`'s `undefined`-governing
 *  short-circuit (so the op gate and the read gate agree). ONLY a LIVE bound door (a real
 *  non-owner `contract_id`) is denied by default — the "off for others" the owner asked
 *  for, INCLUDING a wildcard door (whose `normalDefault` is otherwise permissive).
 *
 *  Applied UNIFORMLY at every author-default site — the op-admission gate
 *  (`isOpGranted`, which only reaches here with a real governing id) AND the read-grant
 *  checker (`isVerbOpGranted` / `isCollectionReadGranted`, which can pass `''`) — so the
 *  two seams resolve a sensitive surface identically (no drift). Pure. */
export const ownerOnlyAdjustedAuthorDefault = (
  entryKey: string,
  boundContractId: string,
  normalDefault: boolean,
): boolean => {
  if (!isOwnerDefaultOnlyEntry(entryKey)) return normalDefault;
  return boundContractId === OWNER_CONTRACT_ID || boundContractId === '';
};
