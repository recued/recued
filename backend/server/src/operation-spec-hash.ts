/** Compatibility export for server leaves written before the D-211 audit moved
 * the canonical helper to contracts. Runtime ask generation now shares this
 * exact primitive with row writes and pack-update review. */
export { operationSpecHash } from '@recued/contracts';
