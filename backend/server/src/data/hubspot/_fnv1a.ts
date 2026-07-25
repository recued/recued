/** D-129 Phase 2 — FNV-1a 32-bit hash for reconciler canonical-field
 *  diffing. The implementation lives in the shared source-mirror spine
 *  since D-192 P1.5 (`../../source-mirror/hash.js`) — this module stays
 *  as the HubSpot adapter tree's import point so its reconcilers are
 *  untouched by the lift. Deterministic + order-sensitive — the
 *  reconciler joins canonical fields with the unit-separator `\x1f` to
 *  keep ordering meaningful. */

export { fnv1aHex } from '../../source-mirror/hash.js';
