/** Client queue over existing owner-reviewed access jobs; receipts stay on the server. */
import { authenticationIncidentScope, authenticationAccessRecheckResults, isAuthenticationAccessPreview, isAuthenticationAccessRequest,
  isAuthenticationAccessVerification, isAuthenticationAccessSelection, managedOAuthVerificationUrl,
  type AuthenticationAccessChoice, type AuthenticationAccessPreview, type AuthenticationAccessRequest,
  type AuthenticationAccessSelection, type AuthenticationAccessVerification, type AuthenticationRepairGroup } from '@recued/contracts';
import type { ManagedOAuthCaller } from '../settings/managed-oauth-panel.js';
import { matchesAuthenticationAccessTargets } from './authentication-access-panel.js';
import { accessEvidenceVerification, type BulkAuthenticationAccessRecheck } from './bulk-authentication-access-rechecks.js';

export const BULK_ACCESS_ACCOUNT_LIMIT = 16;
export const BULK_ACCESS_TARGET_LIMIT = 128;
export interface BulkAuthenticationAccessRow {
  id: string; label: string; selection: Extract<AuthenticationAccessSelection, { kind: 'group' | 'verification' }>;
  state: 'preparing' | 'ready' | 'unavailable' | 'duplicate' | 'queued' | 'starting' | 'checking' | 'completed' | 'unconfirmed' | 'stopped';
  preview?: AuthenticationAccessPreview; target_ids: string[];
  source?: AuthenticationAccessVerification;
  result?: AuthenticationAccessVerification; message?: string;
}
type Run = Extract<AuthenticationAccessRequest, { action: 'authentication_access_run' }>;
type Phase = 'idle' | 'preparing' | 'review' | 'running' | 'paused' | 'finished' | 'stopped';
type Plan = Pick<BulkAuthenticationAccessRow, 'id' | 'label' | 'selection'> & {
  targets: AuthenticationRepairGroup['targets']; evidence?: BulkAuthenticationAccessRecheck['evidence'];
};
const key = (target: AuthenticationRepairGroup['targets'][number]): string => JSON.stringify(authenticationIncidentScope(target));
const nonce = (): string => { const bytes = new Uint8Array(32); globalThis.crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
export const createBulkAuthenticationAccess = (deps: { call: ManagedOAuthCaller; changed(): void; updated?(): void; now?(): number }) => {
  let phase: Phase = 'idle'; let rows: BulkAuthenticationAccessRow[] = []; let error = ''; let generation = 0; let disposed = false; let issued = false;
  let pending = Promise.resolve(); let timer: ReturnType<typeof setTimeout> | undefined;
  const payloads = new Map<string, Run>(); const now = deps.now ?? Date.now;
  const changed = (): void => { if (!disposed) deps.changed(); };
  const stopTimer = (): void => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const retire = (id: string | undefined): void => { if (id) try { void deps.call({ action: 'authentication_access_retire', review_id: id }).catch(() => {}); } catch { /* Closing remains local. */ } };
  const reset = (): void => { generation++; stopTimer(); for (const r of rows) retire(r.preview?.id);
    rows = []; payloads.clear(); phase = 'idle'; error = ''; issued = false; changed(); };
  const poll = (row: BulkAuthenticationAccessRow): void => { stopTimer(); if (!disposed && phase === 'running' && row.result?.status === 'checking') {
    timer = setTimeout(() => { pending = issue(row, true); }, 1500);
  } };
  const advance = async (): Promise<void> => {
    if (disposed || phase !== 'running' || issued) return;
    const row = rows.find(r => r.state === 'queued');
    if (!row) { phase = 'finished'; changed(); return; }
    if (row.preview!.expires_at <= now()) { row.state = 'unavailable'; row.message = 'This review expired before its check started. Review this selection again.'; retire(row.preview!.id); changed(); return advance(); }
    await issue(row, false);
  };
  const issue = async (row: BulkAuthenticationAccessRow, status: boolean): Promise<void> => {
    if (disposed || issued) return;
    const gen = generation; const previous = row.result; issued = true; row.state = status ? 'checking' : 'starting'; row.message = undefined; changed();
    try {
      const request = status && previous ? { action: 'authentication_access_status' as const, id: previous.id } : payloads.get(row.id)!;
      const reply = await deps.call(request);
      if (disposed || gen !== generation) return;
      const expected = row.preview!.targets.filter(t => row.target_ids.includes(t.id));
      if (reply.action !== (status ? 'authentication_access_status' : 'authentication_access_run')
        || !('verification' in reply) || !isAuthenticationAccessVerification(reply.verification)
        || reply.verification.selection.kind !== row.selection.kind || reply.verification.selection.id !== row.selection.id
        || !matchesAuthenticationAccessTargets(reply.verification, expected)
        || previous && (reply.verification.id !== previous.id || reply.verification.started_at !== previous.started_at
          || previous.status === 'completed' && (reply.verification.status !== 'completed' || reply.verification.finished_at !== previous.finished_at))) throw new Error('Invalid saved outcome');
      row.result = structuredClone(reply.verification); row.state = row.result.status === 'completed' ? 'completed' : 'checking';
      if (row.state === 'completed') deps.updated?.();
    } catch {
      if (!disposed && gen === generation) {
        row.state = 'unconfirmed'; row.message = status ? 'Saved status could not be read. Earlier results are still shown.'
          : 'The start outcome is unknown. Recover it with the same request before continuing.';
        if (phase === 'running') phase = 'paused';
      }
    } finally {
      if (!disposed && gen === generation) {
        issued = false; changed();
        if (phase === 'running' && row.state === 'completed') await advance(); else poll(row);
      }
    }
  };
  const prepare = (input: readonly Plan[]): Promise<void> => {
      if (disposed || phase === 'running' || phase === 'preparing') return pending;
      reset(); const gen = generation;
      if (!input.length || input.length > BULK_ACCESS_ACCOUNT_LIMIT || new Set(input.map(p => p.id)).size !== input.length
        || input.some(p => p.id !== p.selection.id || !isAuthenticationAccessSelection(p.selection)
          || p.selection.kind === 'verification' && (!p.evidence?.length || p.evidence.length > 32
            || new Set(p.evidence.map(e => key(e.result.target))).size !== p.evidence.length
            || p.evidence.some(e => e.id !== p.id || !isAuthenticationAccessVerification(accessEvidenceVerification(e))
              || e.result.target.kind === 'oauth_apps' || !authenticationAccessRecheckResults(accessEvidenceVerification(e)).length)))) {
        error = 'Choose up to ' + BULK_ACCESS_ACCOUNT_LIMIT + ' saved accounts or completed checks with failed or unconfirmed reads.'; changed(); return pending;
      }
      const plans = structuredClone(input);
      rows = plans.map(p => ({ id: p.id, label: p.label, selection: p.selection, state: 'preparing', target_ids: [] })); phase = 'preparing'; changed();
      pending = (async () => {
        for (const [index, plan] of plans.entries()) {
          if (disposed || gen !== generation) return;
          const row = rows[index]!;
          try {
            if (plan.evidence) {
              const saved = await deps.call({ action: 'authentication_access_status', id: plan.id });
              if (disposed || gen !== generation) return;
              if (saved.action !== 'authentication_access_status' || !isAuthenticationAccessVerification(saved.verification)
                || saved.verification.id !== plan.id || saved.verification.status !== 'completed'
                || plan.evidence.some(e => saved.verification.selection.kind !== e.selection.kind || saved.verification.selection.id !== e.selection.id
                  || saved.verification.started_at !== e.started_at || saved.verification.finished_at !== e.finished_at
                  || !saved.verification.results.some(r => matchesAuthenticationAccessTargets({ results: [r] }, [e.result])
                    && JSON.stringify(r.checks) === JSON.stringify(e.result.checks)))) throw new Error('Changed source check');
              row.source = structuredClone(saved.verification);
            }
            const reply = await deps.call({ action: 'authentication_access_preview', selection: plan.selection });
            if (disposed || gen !== generation) { if (reply.action === 'authentication_access_preview' && isAuthenticationAccessPreview(reply.preview)) retire(reply.preview.id); return; }
            if (reply.action !== 'authentication_access_preview' || !isAuthenticationAccessPreview(reply.preview)) throw new Error('Invalid review');
            const preview = reply.preview; const allowed = new Set(plan.targets.map(key));
            const sourceTargets = row.source ? new Set(authenticationAccessRecheckResults(row.source).map(r => key(r.target))) : allowed;
            const targets = preview.targets.filter(t => allowed.has(key(t.target)));
            if (preview.selection.kind !== plan.selection.kind || preview.selection.id !== plan.selection.id || preview.running
              || preview.targets.some(t => t.target.kind === 'oauth_apps' || !sourceTargets.has(key(t.target)))
              || row.source && targets.length !== allowed.size) { retire(preview.id); throw new Error('Changed review'); }
            row.preview = structuredClone(preview); row.target_ids = targets.map(t => t.id); row.state = 'ready';
          } catch { if (!disposed && gen === generation) { row.state = 'unavailable'; row.message = 'This account or saved check could not be reviewed. Refresh the list or unlock Recued, then review again.'; } }
          if (disposed || gen !== generation) return; changed();
        }
        if (disposed || gen !== generation) return;
        const resources = new Map<string, string>(); const ids = new Map<string, string>(); const conflicts = new Set<string>();
        for (const row of rows) for (const t of row.preview?.targets.filter(t => row.target_ids.includes(t.id)) ?? []) {
          const resource = key(t.target); const signature = JSON.stringify([t.id, t.authentication_revision]);
          if (resources.has(resource) && resources.get(resource) !== signature || ids.has(t.id) && ids.get(t.id) !== resource) conflicts.add(resource);
          if (ids.has(t.id) && ids.get(t.id) !== resource) conflicts.add(ids.get(t.id)!);
          resources.set(resource, signature); ids.set(t.id, resource);
        }
        const included = new Set<string>();
        for (const row of rows) if (row.preview) {
          const available = row.preview.targets.filter(t => row.target_ids.includes(t.id));
          if (available.some(t => conflicts.has(key(t.target)))) { row.state = 'unavailable'; row.message = 'Authentication changed between reviews. Review these selections again.'; }
          else {
            const targets = available.filter(t => !included.has(key(t.target)));
            if (included.size + targets.length > BULK_ACCESS_TARGET_LIMIT) { row.state = 'unavailable'; row.message = 'This selection exceeds the batch limit of ' + BULK_ACCESS_TARGET_LIMIT + ' resources. Choose fewer selections.'; }
            else { row.target_ids = targets.map(t => t.id); for (const t of targets) included.add(key(t.target)); row.state = targets.length ? 'ready' : 'duplicate';
              if (!targets.length) row.message = 'These resources are already included under another selected check.'; }
          }
          if (row.state !== 'ready') { row.target_ids = []; retire(row.preview.id); }
        }
        phase = 'review'; changed();
      })(); return pending;
  };
  return {
    snapshot: () => structuredClone({ phase, rows, error, issued }),
    phase: (): Phase => phase,
    prepare(groups: readonly AuthenticationRepairGroup[]): Promise<void> {
      return prepare(groups.every(g => g.kind === 'account') ? groups.map(g => ({ id: g.id, label: g.label, targets: g.targets, selection: { kind: 'group', id: g.id } })) : []);
    },
    prepareRechecks(checks: readonly BulkAuthenticationAccessRecheck[]): Promise<void> {
      return prepare(checks.map(c => ({ id: c.id, label: c.label, selection: { kind: 'verification', id: c.id }, evidence: c.evidence, targets: c.evidence.map(e => e.result.target) })));
    },
    start(choices: readonly AuthenticationAccessChoice[]): Promise<void> {
      if (disposed || phase !== 'review' || !rows.some(r => r.state === 'ready')) return pending;
      const selected = rows.filter(r => r.state === 'ready'); const targets = selected.flatMap(r => r.preview!.targets.filter(t => r.target_ids.includes(t.id)));
      if (new Set(choices.map(c => c.target_id)).size !== choices.length || choices.some(c => !targets.some(t => t.id === c.target_id
        && (!c.url || t.check === 'api_read' && !!t.base_url && !!managedOAuthVerificationUrl(t.base_url, c.url))
        && (!c.file_id || t.check === 'file_metadata')))) { error = 'Choose resources only for the reviewed accounts and their saved vendor API.'; changed(); return pending; }
      const plans = selected.map(row => ({ row, request: { action: 'authentication_access_run' as const, review_id: row.preview!.id,
        fingerprint: row.preview!.fingerprint, attempt_id: nonce(), target_ids: row.target_ids.slice(),
        choices: choices.filter(c => row.target_ids.includes(c.target_id)).map(c => ({ target_id: c.target_id, ...(c.url ? { url: c.url } : {}), ...(c.file_id ? { file_id: c.file_id } : {}) })) } }));
      if (plans.some(p => !isAuthenticationAccessRequest(p.request))) { error = 'Choose valid resource URLs or files before running checks.'; changed(); return pending; }
      for (const p of plans) { payloads.set(p.row.id, p.request); p.row.state = 'queued'; }
      error = ''; phase = 'running'; changed(); pending = advance(); return pending;
    },
    recover(): Promise<void> {
      if (disposed || issued || phase !== 'paused') return pending;
      const row = rows.find(r => r.state === 'unconfirmed'); if (!row) return pending;
      phase = 'running'; pending = issue(row, !!row.result); return pending;
    },
    stop(): void { if (disposed || phase !== 'running' && phase !== 'paused') return; phase = 'stopped'; stopTimer();
      for (const row of rows) if (row.state === 'queued') { row.state = 'stopped'; row.message = 'Stopped before starting.'; retire(row.preview?.id); }
      changed();
    },
    refresh(): Promise<void> {
      if (disposed || issued || phase !== 'stopped' && phase !== 'finished') return pending;
      const gen = generation;
      pending = (async () => { for (const row of rows) { if (disposed || gen !== generation) return; if (row.result) await issue(row, true); } })(); return pending;
    },
    reset,
    whenLoaded: () => pending,
    dispose(): void { disposed = true; reset(); },
  };
};
