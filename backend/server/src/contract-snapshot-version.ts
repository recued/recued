/** Content-addressed versioning for dispatch-time contract authority.
 *
 * A snapshot is assembled from more than one mutable source: contract lifecycle,
 * bearer/tool grants, per-contract grant rows, and door-specific trust policy. A
 * counter stored on `contract_definition` would therefore miss real authority
 * changes made outside that row. Instead, every producer finalizes through this
 * module and versions the exact authority fields it persists on the snapshot.
 *
 * The scheme name is domain-separated and versioned so a future canonicalization
 * change cannot silently reuse an old digest vocabulary. `resolved_at` is excluded:
 * two dispatches under identical authority are the same contract version.
 */

import { createHash } from 'node:crypto';

import type { ContractSnapshot } from '@recued/contracts';

const CONTRACT_SNAPSHOT_VERSION_SCHEME = 'authority-sha256-v1';

export type ContractSnapshotAuthority = Pick<
  ContractSnapshot,
  | 'contract_id'
  | 'allowed_tools'
  | 'approval_required'
  | 'scope_restrictions'
  | 'max_risk_without_approval'
>;

export type ContractSnapshotResolution = Omit<
  ContractSnapshot,
  'contract_version'
>;

/** Snapshot authority arrays are sets semantically. Canonical sorting and
 * deduplication make their version independent of store iteration order. */
const canonicalStringSet = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(values)].sort();

/** Derive the opaque content version for one resolved authority state. */
export const deriveContractSnapshotVersion = (
  authority: ContractSnapshotAuthority,
): string => {
  const canonical = JSON.stringify({
    scheme: CONTRACT_SNAPSHOT_VERSION_SCHEME,
    contract_id: authority.contract_id,
    allowed_tools: canonicalStringSet(authority.allowed_tools),
    approval_required: canonicalStringSet(authority.approval_required),
    scope_restrictions: canonicalStringSet(authority.scope_restrictions),
    max_risk_without_approval: authority.max_risk_without_approval ?? null,
  });
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `${CONTRACT_SNAPSHOT_VERSION_SCHEME}:${digest}`;
};

/** Freeze a resolved snapshot and bind its `contract_version` to the exact
 * authority fields stored beside it. Every production snapshot producer uses
 * this boundary; callers cannot supply a version independently. */
export const buildVersionedContractSnapshot = (
  input: ContractSnapshotResolution,
): ContractSnapshot => {
  const authority: ContractSnapshotAuthority = {
    contract_id: input.contract_id,
    allowed_tools: Object.freeze([...new Set(input.allowed_tools)]),
    approval_required: Object.freeze([...new Set(input.approval_required)]),
    scope_restrictions: Object.freeze([...new Set(input.scope_restrictions)]),
    ...(input.max_risk_without_approval !== undefined
      ? { max_risk_without_approval: input.max_risk_without_approval }
      : {}),
  };

  return Object.freeze({
    contract_id: authority.contract_id,
    contract_version: deriveContractSnapshotVersion(authority),
    allowed_tools: authority.allowed_tools,
    approval_required: authority.approval_required,
    scope_restrictions: authority.scope_restrictions,
    resolved_at: input.resolved_at,
    ...(authority.max_risk_without_approval !== undefined
      ? { max_risk_without_approval: authority.max_risk_without_approval }
      : {}),
  });
};
