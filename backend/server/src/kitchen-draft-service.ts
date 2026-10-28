import { KITCHEN_DRAFT_IMPORT_OP, KITCHEN_DRAFT_LIST_OP, KITCHEN_DRAFT_GET_OP, KITCHEN_DRAFT_UPDATE_OP,
  RpcError, type StepMeta } from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import type { OpAdmissionGate } from './op-admission-gate.js';
import type { KitchenDraftStore } from './kitchen-draft-store.js';

interface KitchenDraftDeps {
  store: KitchenDraftStore;
  gate: Pick<OpAdmissionGate, 'isOpGranted' | 'isFrozenByPause'>;
  auditLog?: AuditLogStore;
}
/** Ordinary kernel dispatch: attribution comes only from trusted engine metadata. */
const authorize = (deps: KitchenDraftDeps, op: string, meta: StepMeta | undefined): string => {
  const source = meta?.execution_source;
  if (!source || (source.actor !== 'user_self' && source.actor !== 'contracted_user')
    || !deps.gate.isOpGranted(source, op)) {
    throw new RpcError('op_not_granted', 'This Kitchen draft operation is not granted to this caller.', 403);
  }
  if (deps.gate.isFrozenByPause(source)) throw new RpcError('op_not_granted', 'Recued is paused.', 403);
  if (source.channel === 'mcp' && !source.mcp_token_id) throw new RpcError('unauthorized', 'An authenticated MCP token is required.', 401);
  return source.channel === 'mcp' ? `mcp:${source.mcp_token_id}`
    : `source:${source.channel}:${source.actor}:${'contract_id' in source ? source.contract_id : 'owner'}`;
};
export const createKitchenDraftImporter = (deps: KitchenDraftDeps) => async (raw: unknown, meta: StepMeta | undefined) => {
  const origin = authorize(deps, KITCHEN_DRAFT_IMPORT_OP, meta);
  const result = deps.store.import(origin, raw);
  if (!result.replayed) {
    await deps.auditLog?.logActivity({ activity_id: `kitchen-import-${result.draft_id}`,
      timestamp: result.created_at, action: 'kitchen_draft_imported', target: result.draft_id,
      detail: JSON.stringify({ kind: result.kind, source_hash: result.source_hash, origin, installed: false }) }).catch(() => {});
  }
  return result;
};

export const createKitchenDraftAccess = (deps: KitchenDraftDeps) => async (
  method: 'list' | 'get' | 'update', raw: unknown, meta: StepMeta | undefined,
) => {
  const op = method === 'list' ? KITCHEN_DRAFT_LIST_OP : method === 'get' ? KITCHEN_DRAFT_GET_OP : KITCHEN_DRAFT_UPDATE_OP;
  const origin = authorize(deps, op, meta);
  const bad = (): never => { throw new RpcError('bad_request', 'Provide only the declared Kitchen draft arguments.', 400); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad();
  const input: Record<string, unknown> = Object.fromEntries(Object.entries(raw));
  const keys = method === 'list' ? [] : method === 'get' ? ['draft_id'] : ['draft_id', 'expected_revision', 'source'];
  if (Object.keys(input).some(key => !keys.includes(key))) return bad();
  if (method === 'list') return { drafts: deps.store.list(origin) };
  if (typeof input.draft_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.draft_id)) return bad();
  if (method === 'get') {
    const draft = deps.store.get(input.draft_id, origin);
    if (!draft) throw new RpcError('not_found', 'This is no longer in progress in Kitchen.', 404);
    return draft;
  }
  if (typeof input.expected_revision !== 'number' || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1
    || typeof input.source !== 'string') return bad();
  const result = deps.store.update(input.draft_id, input.expected_revision, input.source, origin);
  await deps.auditLog?.logActivity({ activity_id: `kitchen-update-${result.draft_id}-${result.revision}`,
    timestamp: result.updated_at, action: 'kitchen_draft_updated', target: result.draft_id,
    detail: JSON.stringify({ source_hash: result.source_hash, revision: result.revision, origin, installed: false }) }).catch(() => {});
  const { source: _source, ...receipt } = result;
  return { ...receipt, installed: false as const };
};
