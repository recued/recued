/** D-167 P1 — Gateway chat-mode AI-egress PII aliasing (public surface).
 *
 *  Re-exports the session-ledger store + the egress alias / restore / gate
 *  primitives. Consumed via the `piiEgress` namespace on `@recued/gateway`.
 *
 *  Spec: D-167 §"Runtime flow", §"Gateway".
 */

export {
  createSessionLedgerStore,
  type SessionLedgerStore,
} from './session-ledger-store.js';
export {
  noopFieldPrivacyResolver,
  shouldAliasForEgress,
  buildRedactionSummary,
  preScanPacketForEgress,
  hasPotentialPiiAliasLiteral,
  aliasPacketForEgress,
  restoreForDisplay,
  restoreForDisplayWithAuthority,
  restoreArgsForApproval,
  restoreArgsForApprovalWithAuthority,
  restoreArgsAndKeysForApproval,
  restoreArgsAndKeysForApprovalWithAuthority,
  restoreArgKeysForApprovalWithAuthority,
  deriveRequestRestoreAuthority,
  stageLedgerForRequest,
  restrictStagedLedgerForRequest,
  commitLedgerForRequest,
  aliasArgsForEgress,
  // D-167 (recall path) — contact-index recall re-aliasing for memory.* results.
  buildRecallIndex,
  aliasRecallArgsForEgress,
  aliasCandidateValuesForEgress,
  type FieldPrivacyResolver,
  type EgressGateInput,
  type AliasPacketInput,
  type AliasPacketResult,
  type RecallContactSeeds,
  type RecallIndex,
  type CandidateValueSeed,
  type RequestRestoreAuthority,
} from './egress-aliasing.js';
// D-167 B3 — the pure alias→kind shape function, surfaced on the `piiEgress`
// namespace so the chat dispatch boundary can field-scope a follow-up
// `contact.search` by an aliased arg's kind before the value-restore (D6). It
// reads no ledger, but lives behind this namespace with the other PII primitives
// so the backend stays on the gateway consumer surface.
export { ledgerKindForAlias } from '@recued/transforms';
// D-167 — the deterministic slot-ordering seeder. Surfaced here for the same
// reason as `ledgerKindForAlias`: the backend stays on this consumer namespace
// rather than importing the transform directly. A reservation is not an
// allocation, so this does not widen P1.
export {
  reserveAliasSlotOrdering,
  type AliasSlotSeed,
} from '@recued/transforms';
// D-167 — the structured-address substrate, surfaced for the same reason. A
// second producer of address candidates must DERIVE "coarse" and the composite
// prose forms from these, never restate them: the postcode is NOT coarse (it is
// aliased at its leaf) and a BARE postcode is never a match form.
export {
  ADDRESS_COARSE_KEYS,
  readAddressComponents,
  addressMatchForms,
  type AddressComponents,
} from '@recued/transforms';
