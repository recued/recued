import { KIND_ALLOWED_TIERS, OPERATION_APPROVALS, OPERATION_IDEMPOTENCIES, API_EXECUTION_BINDING_KINDS,
  CATALOG_MIN_OP_TIMEOUT_MS, CATALOG_DEFAULT_TIMEOUT_MS, CATALOG_OP_TIMEOUT_MULTIPLIER,
  CATALOG_DEFAULT_CACHE_TTL_MS, CATALOG_MAX_CACHE_TTL_MS, CATALOG_CACHE_OUTLIER_MULTIPLIER,
  type OperationApproval, type OperationIdempotency, type PackOperationRow, type RiskTier } from '@recued/contracts';

type Policies = Pick<PackOperationRow, 'risk' | 'approval' | 'idempotency' | 'timeout_ms' | 'cache_ttl_ms' | 'spends_per_call' | 'approval_reason'>;
export type OperationPolicyKey = keyof Policies;
export interface OperationPolicyField { key: OperationPolicyKey; type: 'string' | 'number' | 'boolean'; required: boolean; description: string; values: readonly (string | boolean)[] }
export const OPERATION_SETTING_KEYS = ['timeout_ms', 'cache_ttl_ms', 'spends_per_call', 'approval_reason'] as const satisfies readonly OperationPolicyKey[];
export const operationApprovalReasonValid = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_]{2,63}$/.test(value);
const riskHelp: Record<RiskTier, string> = {
  read: 'Reads data without changing it.',
  write: 'Creates or changes data.',
  admin: 'Changes administrative configuration or access.',
  destructive: 'Deletes or irreversibly changes data.',
};
const approvalHelp: Record<OperationApproval, string> = {
  never: 'Requests admission without an operation-authored approval hold. Stricter connection and provider policy still applies.',
  ask: 'Routes through the approval checkpoint. Resolution remains stricter-wins against connection and provider policy.',
  always: 'Always requests approval. Held reads should also explain their reason through approval_reason.',
};
const idempotencyHelp: Record<OperationIdempotency, string> = {
  safe: 'Classifies repeat calls as safe for dispatch retry decisions.',
  idempotent: 'Repeating the same request has the same effect as calling it once.',
  non_idempotent: 'Repeated calls can cause additional effects; dispatch must not assume replay is safe.',
};
type ScalarType<T> = Exclude<T, undefined> extends number ? 'number' : Exclude<T, undefined> extends boolean ? 'boolean' : Exclude<T, undefined> extends string ? 'string' : never;
const fields: { [K in keyof Policies]-?: { type: ScalarType<Policies[K]>; required: {} extends Pick<Policies, K> ? false : true; description: string } } = {
  risk: { type: 'string', required: true, description: 'Describe the operation effects. This classification does not itself grant execution authority.' },
  approval: { type: 'string', required: true, description: 'The author approval intent; connection and provider policy may require stricter approval.' },
  idempotency: { type: 'string', required: false, description: 'The operation repeat-call classification used by dispatch. Choose it from the operation behavior; the editor does not infer it.' },
  timeout_ms: { type: 'number', required: false, description: 'Catalog operation deadline in milliseconds. Zero declares no operation wall deadline; omission inherits a catalog or connector invocation default. Shared validation uses ' + CATALOG_DEFAULT_TIMEOUT_MS + ' ms when no valid catalog default is declared. Choose the duration explicitly. Plain 1x1 API wrappers do not carry this operation override.' },
  cache_ttl_ms: { type: 'number', required: false, description: 'Catalog operation cache lifetime in milliseconds. Zero disables operation caching; omission inherits the catalog default (shared validation fallback ' + CATALOG_DEFAULT_CACHE_TTL_MS + ' ms). Positive values are read-tier only; real-time subscription bindings cannot cache. Values above ' + CATALOG_MAX_CACHE_TTL_MS + ' ms or ' + CATALOG_CACHE_OUTLIER_MULTIPLIER + ' times a positive catalog default produce an outlier warning. Plain 1x1 API wrappers do not carry this operation override. Choose freshness explicitly.' },
  spends_per_call: { type: 'boolean', required: false, description: 'Explicitly mark whether every call costs money or metered credit. Recipes using marked operations are treated as actions rather than automatic views. Choose from provider billing behavior; false or omission is an author claim, not proof of free execution. This does not change risk or approval.' },
  approval_reason: { type: 'string', required: false, description: 'An extensible author code: 3-64 lowercase letters, digits or underscores, starting with a letter. Recommended for deliberately held reads and used by the uniform-held-read exemption. It can also describe what a sensitive read returns. A reason does not itself add an approval hold; the editor chooses no reason.' },
};
export const operationPolicyValues = (key: OperationPolicyKey): readonly (string | boolean)[] => key === 'risk' ? [...KIND_ALLOWED_TIERS.connection]
  : key === 'approval' ? OPERATION_APPROVALS : key === 'idempotency' ? OPERATION_IDEMPOTENCIES : key === 'spends_per_call' ? [true, false] : [];
const timeoutLimits = (bindingKind: unknown) => {
  const floor = 'Positive values must be integers of at least ' + CATALOG_MIN_OP_TIMEOUT_MS + ' ms. ';
  const cli = 'CLI invocation durations are author-declared, bounded by the safe integer limit. Awaited unbounded CLI commands also require progress/stall detection; detached services use their supervision contract.';
  const network = 'Network operation validation caps a positive value at the catalog default times ' + CATALOG_OP_TIMEOUT_MULTIPLIER + ' (' + CATALOG_DEFAULT_TIMEOUT_MS * CATALOG_OP_TIMEOUT_MULTIPLIER + ' ms with the shared fallback).';
  return floor + (bindingKind === 'cli_invocation' ? cli : (API_EXECUTION_BINDING_KINDS as readonly unknown[]).includes(bindingKind) ? network : cli + ' ' + network);
};
export const operationPolicyFields = (bindingKind?: unknown): OperationPolicyField[] => (Object.keys(fields) as OperationPolicyKey[]).map(key => ({ key, ...fields[key],
  description: fields[key].description + (key === 'timeout_ms' ? '\n\n' + timeoutLimits(bindingKind) : ''), values: operationPolicyValues(key) }));
export const operationPolicyValueHelp = (key: OperationPolicyKey, value: string | boolean): string | undefined => {
  if (key === 'spends_per_call' && typeof value === 'boolean') return value ? 'Every call is declared to spend money or metered credit.' : 'The author declares no per-call cost; billing is not verified by the editor.';
  const rows: Record<string, string> | undefined = key === 'risk' ? riskHelp : key === 'approval' ? approvalHelp : key === 'idempotency' ? idempotencyHelp : undefined;
  return rows && typeof value === 'string' && Object.hasOwn(rows, value) ? rows[value] : undefined;
};

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Project only exact existing catalog timing/cache paths, without rechecking their rules. */
export const operationPolicyIssueLocations = (operations: unknown, catalogOperations: unknown): Map<string, string> => {
  const locations = new Map<string, string>();
  if (!Array.isArray(operations) || !object(catalogOperations)) return locations;
  const counts = new Map<string, number>();
  for (const row of operations) if (object(row) && typeof row.op === 'string') counts.set(row.op, (counts.get(row.op) ?? 0) + 1);
  for (const [index, row] of operations.entries()) {
    if (!object(row) || typeof row.op !== 'string' || counts.get(row.op) !== 1) continue;
    const lowered = Object.hasOwn(catalogOperations, row.op) ? catalogOperations[row.op] : undefined;
    if (!object(lowered) || lowered.timeout_ms !== row.timeout_ms || lowered.cache_ttl_ms !== row.cache_ttl_ms || lowered.risk_tier !== row.risk) continue;
    locations.set(JSON.stringify(['CATALOG_TIMEOUT_INVALID', 'operations.' + row.op + '.timeout_ms']), 'operations[' + index + '].timeout_ms');
    for (const code of ['CATALOG_CACHE_POLICY_INVALID', 'CATALOG_CACHE_TTL_OUTLIER']) locations.set(JSON.stringify([code, 'operations.' + row.op + '.cache_ttl_ms']), 'operations[' + index + '].cache_ttl_ms');
  }
  return locations;
};
