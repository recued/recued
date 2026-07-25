/** D-167 P1 — Gateway chat-mode AI-egress PII aliasing (public surface).
 *
 *  Re-exports the session-ledger store + the egress alias / restore / gate
 *  primitives. Consumed via the `piiEgress` namespace on `@recued/gateway`.
 *
 *  Spec: docs/d-167-spec.md §"Runtime flow", §"Gateway".
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
  aliasPacketForEgress,
  restoreForDisplay,
  restoreArgsForApproval,
  restoreArgsAndKeysForApproval,
  aliasArgsForEgress,
  // D-167 (recall path) — contact-index recall re-aliasing for memory.* results.
  buildRecallIndex,
  aliasRecallArgsForEgress,
  type FieldPrivacyResolver,
  type EgressGateInput,
  type AliasPacketInput,
  type AliasPacketResult,
  type RecallContactSeeds,
  type RecallIndex,
} from './egress-aliasing.js';
// D-167 B3 — the pure alias→kind shape function, surfaced on the `piiEgress`
// namespace so the chat dispatch boundary can field-scope a follow-up
// `contact.search` by an aliased arg's kind before the value-restore (D6). It
// reads no ledger, but lives behind this namespace with the other PII primitives
// so the backend stays on the gateway consumer surface.
export { ledgerKindForAlias } from '@recued/transforms';
