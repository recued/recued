/** D-130 Phase 2 — FNV-1a 32-bit hash for Salesforce reconciler
 *  canonical-field diffing. The "lift to a shared helper when a third
 *  vendor needs it" this file's original comment recorded happened at
 *  D-192 P1.5: the implementation lives in the source-mirror spine
 *  (`../../source-mirror/hash.js`); this module stays as the Salesforce
 *  adapter tree's import point so its reconcilers are untouched. */

export { fnv1aHex } from '../../source-mirror/hash.js';
