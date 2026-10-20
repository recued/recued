/** The real approval route against a persistent local provider-proof fixture. */
import { bootstrapPreapprovalRoute } from '../../src/approvals/preapproval-route.js';
import { preapprovalContinuationDemoReply, CONTINUATION_PARENT } from './preapproval-continuation.js';
import type { Conn, PreapprovalInspection, PreapprovalReconcileResult, ServerRpcRegistry } from '@recued/contracts';
const query = new URLSearchParams(location.search), scenario = query.get('scenario'), key = 'provider-proof-fixture';
const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null') as { verified: boolean; calls: Array<{ method: string; args: unknown }> } | null;
const state = saved ?? { verified: false, calls: [] };
const persist = () => sessionStorage.setItem(key, JSON.stringify(state));
const inspect = (): PreapprovalInspection => {
  const result = structuredClone(preapprovalContinuationDemoReply('preapproval.get', { proposal_id: CONTINUATION_PARENT })!.result) as PreapprovalInspection;
  result.members[0] = { ...result.members[0]!, op_id: 'core.mail.send', label: 'Reviewed email', status: 'in_doubt', provider_verification: 'mail', reconciled_outcome: state.verified ? 'succeeded' : null };
  if (scenario === 'legacy') delete result.members[0].provider_verification;
  result.members[1] = { ...result.members[1]!, status: 'available' };
  result.recovery = { eligible: state.verified, successor_proposal_id: null, reason: state.verified ? null : 'Verified reconciliation is required before another review can continue.' };
  const reviewed = result.reviewed!;reviewed.members[0] = { ...reviewed.members[0]!, op_id: 'core.mail.send', label: 'Reviewed email', arguments: {
    sender_mail_instance: 'work', to: ['recipient@example.com'], subject: 'Reviewed message', body: 'The reviewed content.' } };
  delete reviewed.members[0].resource_review;
  return result;
};
const call: Conn<ServerRpcRegistry> = async (method: keyof ServerRpcRegistry, args?: unknown) => {
  state.calls.push({ method, args });persist();
  if (method === 'preapproval.get') return inspect() as never;
  if (method === 'preapproval.reconcile') {
    const checks = state.calls.filter(item => item.method === method).length;
    if (scenario === 'slow' || scenario === 'retry-slow' && checks > 1) await new Promise<void>(resolve => addEventListener('finish-proof', () => resolve(), { once: true }));
    if (scenario === 'error' && checks === 1) throw new Error('Provider check unavailable. Retry or refresh.');
    const unknown = scenario === 'missing' || scenario === 'ambiguous' || scenario === 'retry-slow' && checks === 1;state.verified = !unknown;persist();
    if (scenario === 'lost' && checks === 1) throw new Error('Verification reply lost. Refresh the recorded outcome.');
    const result: PreapprovalReconcileResult = { status: unknown ? 'unknown' : 'verified', checked_at: Date.now(),
      message: unknown ? scenario === 'ambiguous' ? 'Provider evidence is ambiguous. The outcome remains uncertain.' : 'Absence does not prove failure. The outcome remains uncertain.'
        : 'The original mail attempt is verified as sent.', ...(unknown ? {} : { evidence_id: 'provider-proof-receipt' }), inspection: inspect() };
    return result as never;
  }
  throw new Error('Unexpected fixture method: ' + method);
};
const route = bootstrapPreapprovalRoute({ root: document.querySelector<HTMLElement>('#root')!, document, proposalId: CONTINUATION_PARENT, call });
addEventListener('query-proof-work', () => { document.body.dataset.busy = String(route.hasInFlightWork()); });
persist();
