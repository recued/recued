/** Owner-authored admission examples. These values are never execution permits. */
import { RpcError } from './rpc/types.js';
import { regressionJson, type RegressionJson } from './recipe-regression.js';

export const PERMISSION_REGRESSION_LIMITS = Object.freeze({ cases: 40, changes: 100, document_bytes: 256_000,
  history: 10, state_bytes: 2_000_000, tracks: 100, retained_bytes: 16_000_000,
  qualification_ms: 15 * 60_000, review_ms: 5 * 60_000, impact_entries: 50 });
export type PermissionVerdict = 'allow' | 'ask' | 'deny';
export interface PermissionGrant { entry_key: string; granted: boolean; set_at?: number; source_pack?: string }
export interface PermissionGrantChange { entry_key: string; granted: boolean | null }
export interface PermissionCase {
  id: string; name: string; credential_id: string; expected: PermissionVerdict;
  target: { kind: 'operation'; ingredient: string; input: Record<string, RegressionJson>; connection?: string }
    | { kind: 'collection'; collection: string } | { kind: 'topic'; topic: string };
}
export interface PermissionDocument { title: string; cases: PermissionCase[]; changes: PermissionGrantChange[] }
export interface PermissionDraft { revision: number; digest: string; base_digest: string; created_at: number; document: PermissionDocument }
export interface PermissionDecision { verdict: PermissionVerdict | 'unsupported'; detail: string }
export interface PermissionCaseResult { id: string; name: string; expected: PermissionVerdict; current: PermissionDecision; candidate: PermissionDecision; passed: boolean }
export interface PermissionImpactEntry { kind: 'recipe' | 'schedule' | 'auto_run' | 'trigger' | 'review'; id: string; label: string; detail: string }
export interface PermissionImpact { entries: PermissionImpactEntry[]; total: number; truncated: boolean; coverage: string[] }
export interface PermissionComparison { cases: PermissionCaseResult[]; passed: number; failed: number; impact: PermissionImpact }
export interface PermissionQualification { receipt_id: string; draft_revision: number; candidate_digest: string; expires_at: number; comparison: PermissionComparison }
export interface PermissionReview {
  review_id: string; draft_revision: number; candidate_digest: string; live_digest: string; expires_at: number;
  changes: Array<{ entry_key: string; before: boolean | null; after: boolean | null }>; impact: PermissionImpact;
}
export interface PermissionActivation { kind: 'observed' | 'activated'; sequence: number; created_at: number; digest: string; grants: PermissionGrant[] }
export interface PermissionCatalogEntry { kind: 'operation' | 'collection' | 'topic'; entry_key: string; label: string; ingredient?: string; operation?: string }
export interface PermissionWorkbenchView {
  contract_id: string; supported: boolean; reason?: string; revision: number; live_digest: string;
  grants: PermissionGrant[]; catalog: PermissionCatalogEntry[]; catalog_truncated: boolean; credentials: Array<{ id: string; label: string; active: boolean }>;
  draft: PermissionDraft | null; selected_draft?: PermissionDraft; drafts: Array<{ revision: number; title: string; created_at: number }>;
  history: PermissionActivation[]; qualification: PermissionQualification | null;
}
export interface PermissionSave { contract_id: string; expected_revision: number; expected_live_digest: string; request_id: string; document: PermissionDocument }
export interface PermissionRestore { contract_id: string; expected_revision: number; expected_live_digest: string; request_id: string; sequence: number }
export interface PermissionMutation extends PermissionWorkbenchView { mutation_revision: number; saved_draft?: PermissionDraft; activated?: PermissionActivation }
export interface PermissionTest { contract_id: string; expected_revision: number; draft_revision: number }
export interface PermissionPrepare extends PermissionTest { receipt_id: string }
export interface PermissionActivate { contract_id: string; expected_revision: number; review_id: string; request_id: string }

export const permissionObject = (raw: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !keys.includes(key))) {
    throw new RpcError('bad_request', 'Invalid permission test fields.', 400);
  }
  return raw as Record<string, unknown>;
};
export const permissionText = (raw: unknown, label: string, max = 200): string => {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > max || /[\u0000-\u001f]/u.test(raw)) {
    throw new RpcError('bad_request', `Provide ${label} using at most ${max} characters.`, 400);
  }
  return raw;
};
export const permissionBytes = (value: unknown): number => {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
  catch { throw new RpcError('bad_request', 'Permission tests must contain bounded JSON.', 400); }
};
export const parsePermissionDocument = (raw: unknown): PermissionDocument => {
  if (permissionBytes(raw) > PERMISSION_REGRESSION_LIMITS.document_bytes) throw new RpcError('bad_request', 'Keep permission tests below 256 KB.', 400);
  const value = permissionObject(raw, ['title', 'cases', 'changes']);
  if (!Array.isArray(value.cases) || !value.cases.length || value.cases.length > PERMISSION_REGRESSION_LIMITS.cases
    || !Array.isArray(value.changes) || !value.changes.length || value.changes.length > PERMISSION_REGRESSION_LIMITS.changes) {
    throw new RpcError('bad_request', 'Use one to 40 cases and one to 100 grant changes.', 400);
  }
  const cases = value.cases.map(rawCase => {
    const item = permissionObject(rawCase, ['id', 'name', 'credential_id', 'expected', 'target']);
    if (!['allow', 'ask', 'deny'].includes(String(item.expected))) throw new RpcError('bad_request', 'Choose allow, ask or deny.', 400);
    const target = permissionObject(item.target, ['kind', 'ingredient', 'input', 'connection', 'collection', 'topic']);
    let result: PermissionCase['target'];
    if (target.kind === 'operation') {
      permissionObject(target, ['kind', 'ingredient', 'input', 'connection']);
      const input = regressionJson(target.input);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RpcError('bad_request', 'Use an object for operation input.', 400);
      result = { kind: 'operation', ingredient: permissionText(target.ingredient, 'an ingredient'), input,
        ...(target.connection === undefined ? {} : { connection: permissionText(target.connection, 'a connection') }) };
    } else if (target.kind === 'collection') {
      permissionObject(target, ['kind', 'collection']); result = { kind: 'collection', collection: permissionText(target.collection, 'a collection') };
    } else if (target.kind === 'topic') {
      permissionObject(target, ['kind', 'topic']); result = { kind: 'topic', topic: permissionText(target.topic, 'a topic') };
    } else throw new RpcError('bad_request', 'Choose an operation, collection or topic test.', 400);
    return { id: permissionText(item.id, 'a case id', 100), name: permissionText(item.name, 'a case name'),
      credential_id: permissionText(item.credential_id, 'an existing credential'), expected: item.expected as PermissionVerdict, target: result };
  });
  const changes = value.changes.map(rawChange => {
    const item = permissionObject(rawChange, ['entry_key', 'granted']);
    if (item.granted !== null && typeof item.granted !== 'boolean') throw new RpcError('bad_request', 'A grant change must be true, false or null to clear.', 400);
    return { entry_key: permissionText(item.entry_key, 'a grant entry', 300), granted: item.granted };
  });
  if (new Set(cases.map(item => item.id)).size !== cases.length || new Set(changes.map(item => item.entry_key)).size !== changes.length) {
    throw new RpcError('bad_request', 'Case ids and changed grant entries must be unique.', 400);
  }
  return { title: permissionText(value.title, 'a suite title'), cases, changes };
};
