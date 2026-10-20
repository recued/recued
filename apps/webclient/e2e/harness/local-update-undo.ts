/** UI-only transport fixture. Real authorization, atomicity and process death
 * are exercised separately against SQLite in the server tests. */
import type { LocalUpdateUndoReview, LocalUpdateUndoResult, LocalUpdateUndoDecision } from '@recued/contracts';

export const localUpdateUndoDemoReply = (method: string, args: unknown): {
  result?: unknown; error?: { code: string; message: string };
} | null => {
  if (!method.startsWith('local_undo.')) return null;
  const query = new URLSearchParams(location.search), now = Date.now();
  const records = query.has('preapproval') || query.get('journey') === 'verification';
  const key = 'recued-test-local-update-undo';
  const review: LocalUpdateUndoReview = { undo_id: 'undo_88888888-8888-4888-8888-888888888888',
    predecessor_receipt_id: 'lmr_77777777-7777-4777-8777-777777777777', review_hash: 'sha256:' + 'a'.repeat(64),
    expires_at: now + 600_000, resource_review: { schema_version: 1, operation: records ? 'fixture.note.update' : 'calendar-update',
      input_hash: 'b'.repeat(64), captured_at: now, resources: [{ kind: records ? 'records' : 'calendar', key: 'fixture',
        label: records ? 'Note a' : 'Meeting', binding: 'binding', version: 'post-update',
        precondition: { kind: 'local_version', value: 'post-update' },
        before: records ? { title: 'Saved first row' } : { summary: 'Reviewed meeting', location: 'New room' },
        after: records ? { title: 'First row' } : { summary: 'Original meeting', location: null } }] } };
  const savedKey = key + '-result';
  if (method === 'local_undo.get') return { result: JSON.parse(sessionStorage.getItem(savedKey) ?? 'null') };
  if (method === 'local_undo.review') {
    if (JSON.parse(sessionStorage.getItem(savedKey) ?? 'null')?.status === 'completed') {
      return { error: { code: 'local_undo_conflict', message: 'This change already has an undo receipt.' } };
    }
    return { result: review };
  }
  if (method === 'local_undo.decide') {
    const input = args as LocalUpdateUndoDecision;
    const attempts = JSON.parse(sessionStorage.getItem(key) ?? '[]') as LocalUpdateUndoDecision[];
    attempts.push(input); sessionStorage.setItem(key, JSON.stringify(attempts));
    if (query.get('undo') === 'not_received') return { error: { code: 'UNAVAILABLE', message: 'Undo request was not delivered. Check the result.' } };
    const status = query.get('undo') === 'conflict' ? 'failed' : input.decision === 'approve' ? 'completed' : 'denied';
    const result: LocalUpdateUndoResult = { undo_id: input.undo_id, predecessor_receipt_id: review.predecessor_receipt_id, status,
      ...(status === 'completed' ? { local_receipt: { receipt_id: 'lmr_99999999-9999-4999-8999-999999999999',
        kind: records ? 'records' : 'local_calendar', committed_at: now } } : {}) };
    sessionStorage.setItem(savedKey, JSON.stringify(result));
    if (status === 'failed') return { error: { code: 'local_undo_conflict', message: 'The record changed after review. No undo was applied.' } };
    if (query.get('undo') === 'lost' && attempts.length === 1) return { error: { code: 'UNAVAILABLE', message: 'Undo response was lost. Check the result.' } };
    return { result };
  }
  return null;
};
