import { authenticationIncidentScope, isAuthenticationAccessVerification,
  type AuthenticationAccessResult, type AuthenticationAccessVerification } from '@recued/contracts';
import type { ManagedOAuthCaller } from '../settings/managed-oauth-panel.js';
import { connectionsAccessRepairReturn, connectionsAccountAuthenticationAddress, connectionsFileAuthenticationAddress, connectionsReviewAccessAddress } from './connections-navigation.js';

export type AccessRepairSource = Pick<AuthenticationAccessVerification, 'id' | 'selection' | 'status' | 'started_at' | 'finished_at'>;
export type AccessRepairRenderer = (parent: HTMLElement, source: AccessRepairSource, result: AuthenticationAccessResult) => void;
const snapshot = (source: AccessRepairSource, result: AuthenticationAccessResult): AuthenticationAccessVerification => ({
  id: source.id, selection: source.selection, status: source.status, started_at: source.started_at,
  ...(source.finished_at !== undefined ? { finished_at: source.finished_at } : {}), results: [result], targets_truncated: false, uses: [], usage_available: true,
});
const key = (source: AccessRepairSource, result: AuthenticationAccessResult): string =>
  [source.id, result.id, result.authentication_revision, source.started_at, source.finished_at].join(':');
const resource = (r: AuthenticationAccessResult): string => JSON.stringify(authenticationIncidentScope(r.target));
const sameChecks = (a: AuthenticationAccessResult, b: AuthenticationAccessResult): boolean => a.checks.length === b.checks.length
  && a.checks.every(c => b.checks.some(other => other.kind === c.kind && other.status === c.status && other.reason === c.reason));
class RepairReviewError extends Error {}
export const authenticationAccessRepairLabel = (source: AccessRepairSource, result: AuthenticationAccessResult): string | undefined => {
  if (!isAuthenticationAccessVerification(snapshot(source, result)) || source.status !== 'completed' || result.current !== 'yes'
    || !result.checks.some(c => c.kind !== 'write_permissions' && c.status !== 'passed')) return;
  return result.target.kind === 'connection' ? 'Review API authentication' : result.target.kind === 'collection'
    ? 'Review ' + (result.target.platform === 'mail' ? 'Mail' : 'Calendar') + ' authentication' : result.target.kind === 'file_source' ? 'Review file authentication' : undefined;
};

/** Reads saved status only. The destination starts its existing authoritative review. */
export const resolveAuthenticationAccessRepair = async (call: ManagedOAuthCaller, source: AccessRepairSource,
  result: AuthenticationAccessResult, current: () => boolean = () => true): Promise<string> => {
  const original = structuredClone(snapshot(source, result)); const before = original.results[0]!;
  if (!authenticationAccessRepairLabel(original, before) || !current()) throw new RepairReviewError('Refresh this saved check before opening authentication settings.');
  let reply: Awaited<ReturnType<ManagedOAuthCaller>>;
  try { reply = await call({ action: 'authentication_access_status', id: original.id }); }
  catch { throw new RepairReviewError('The saved check could not be read. Unlock Recued or refresh before opening authentication settings.'); }
  if (!current()) throw new RepairReviewError('This access review is no longer open.');
  if (!reply || reply.action !== 'authentication_access_status' || !isAuthenticationAccessVerification(reply.verification)) throw new RepairReviewError('The saved check could not be confirmed. Refresh it before opening authentication settings.');
  const value = reply.verification; const target = value.results.find(r => r.id === before.id);
  if (value.id !== original.id || value.selection.kind !== original.selection.kind || value.selection.id !== original.selection.id
    || value.status !== 'completed' || value.started_at !== original.started_at || value.finished_at !== original.finished_at
    || !target || target.authentication_revision !== before.authentication_revision || resource(target) !== resource(before)
    || !sameChecks(target, before) || !authenticationAccessRepairLabel(value, target)) {
    throw new RepairReviewError('The saved check or its authentication changed, or could not be compared. Refresh the result before opening a repair review.');
  }
  const withReturn = (hash: string): string => connectionsAccessRepairReturn(hash, { verification_id: value.id, target_id: target.id });
  if (target.target.kind === 'connection') return withReturn(connectionsReviewAccessAddress(target.target.name).hash);
  if (target.target.kind === 'collection' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(target.target.slug)) {
    return withReturn(connectionsAccountAuthenticationAddress(target.target.platform, target.target.slug).hash);
  }
  if (target.target.kind === 'file_source' && target.file_connection) return withReturn(connectionsFileAuthenticationAddress(target.file_connection.name).hash);
  throw new RepairReviewError('This resource has no confirmed authentication review. Open its current settings in Connections or refresh after updating the server.');
};

/** One local navigation lookup per view, with retained state across status renders. */
export const createAuthenticationAccessRepairShortcuts = (deps: { document: Document; call: ManagedOAuthCaller;
  host(): HTMLElement | null; active(): boolean; changed(): void; navigate?(hash: string): void }) => {
  const doc = deps.document; let disposed = false; let generation = 0; let opening: string | undefined;
  let error: { key: string; text: string } | undefined; let pending = Promise.resolve();
  const controls = new Map<string, { container: HTMLElement; button: HTMLButtonElement }[]>();
  const live = (id: string): boolean => !disposed && deps.active() && (controls.get(id)?.some(c => deps.host()?.contains(c.container)) ?? false);
  const reset = (): void => { generation++; opening = undefined; error = undefined; controls.clear(); pending = Promise.resolve(); };
  const append: AccessRepairRenderer = (parent, source, result) => {
    const label = authenticationAccessRepairLabel(source, result); if (!label || disposed) return;
    const id = key(source, result); const container = doc.createElement('div'); container.className = 'access-repair-shortcut';
    const b = doc.createElement('button'); b.type = 'button'; b.textContent = opening === id ? 'Reading saved authentication…' : label;
    b.disabled = !!opening || !deps.active(); b.setAttribute('data-access-repair-shortcut', id); container.appendChild(b);
    controls.set(id, [...controls.get(id) ?? [], { container, button: b }]);
    if (error?.key === id) { const p = doc.createElement('p'); p.setAttribute('role', 'alert'); p.textContent = error.text; container.appendChild(p); }
    const proof = structuredClone(snapshot(source, result));
    b.addEventListener('click', () => {
      if (b.disabled || opening || !live(id) || !deps.host()?.contains(b)) return;
      const occurrence = controls.get(id)!.findIndex(control => control.button === b);
      const gen = generation; const focusAtStart = doc.activeElement; opening = id; error = undefined; deps.changed();
      // An owner may focus its section while the shortcut is disabled.
      const focusAfterRender = deps.host()?.contains(doc.activeElement) ? doc.activeElement : null;
      const current = (): boolean => gen === generation && live(id);
      pending = (async () => {
        try {
          const href = await resolveAuthenticationAccessRepair(deps.call, proof, proof.results[0]!, current);
          if (!current()) return;
          if (deps.navigate) deps.navigate(href); else if (doc.defaultView) doc.defaultView.location.hash = href;
          else throw new RepairReviewError('Authentication settings could not be opened in this browser. Open Connections and review the current resource.');
        } catch (e) {
          if (current()) error = { key: id, text: e instanceof RepairReviewError ? e.message : 'The authentication review could not be opened. Refresh the saved check and try again.' };
        } finally {
          if (!disposed && gen === generation) {
            const restore = doc.activeElement === focusAtStart || doc.activeElement === doc.body
              || focusAfterRender !== null && doc.activeElement === focusAfterRender;
            opening = undefined; deps.changed();
            const control = controls.get(id)?.[occurrence];
            if (restore && control && deps.host()?.contains(control.container)) control.button.focus({ preventScroll: true });
          }
        }
      })();
    }); parent.appendChild(container);
  };
  return { append, beginRender(): void { controls.clear(); }, busy: (): boolean => !!opening, whenLoaded: (): Promise<void> => pending,
    reset, dispose(): void { disposed = true; reset(); } };
};
