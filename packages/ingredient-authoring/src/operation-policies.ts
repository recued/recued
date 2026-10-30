import { KIND_ALLOWED_TIERS, OPERATION_APPROVALS, OPERATION_IDEMPOTENCIES,
  type OperationApproval, type OperationIdempotency, type PackOperationRow, type RiskTier } from '@recued/contracts';

type Policies = Pick<PackOperationRow, 'risk' | 'approval' | 'idempotency'>;
export type OperationPolicyKey = keyof Policies;
export interface OperationPolicyField { key: OperationPolicyKey; required: boolean; description: string; values: readonly string[] }
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
const fields: { [K in keyof Policies]-?: { required: {} extends Pick<Policies, K> ? false : true; description: string } } = {
  risk: { required: true, description: 'Describe the operation effects. This classification does not itself grant execution authority.' },
  approval: { required: true, description: 'The author approval intent; connection and provider policy may require stricter approval.' },
  idempotency: { required: false, description: 'The operation repeat-call classification used by dispatch. Choose it from the operation behavior; the editor does not infer it.' },
};
export const operationPolicyValues = (key: OperationPolicyKey): readonly string[] => key === 'risk' ? [...KIND_ALLOWED_TIERS.connection]
  : key === 'approval' ? OPERATION_APPROVALS : OPERATION_IDEMPOTENCIES;
export const operationPolicyFields = (): OperationPolicyField[] => (Object.keys(fields) as OperationPolicyKey[]).map(key => ({ key, ...fields[key], values: operationPolicyValues(key) }));
export const operationPolicyValueHelp = (key: OperationPolicyKey, value: string): string | undefined => {
  const rows: Record<string, string> = key === 'risk' ? riskHelp : key === 'approval' ? approvalHelp : idempotencyHelp;
  return Object.hasOwn(rows, value) ? rows[value] : undefined;
};
