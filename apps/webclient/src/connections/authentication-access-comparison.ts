import { authenticationAccessRecheckResults, authenticationIncidentScope, isAuthenticationAccessVerification,
  type AuthenticationAccessVerification, type AuthenticationAccessResult, type AuthenticationAccessCheckKind } from '@recued/contracts';
import type { ManagedOAuthCaller } from '../settings/managed-oauth-panel.js';
import { authenticationAccessCheckLabels, authenticationAccessCheckText } from './authentication-access-result.js';
import { connectionsAccessResultAddress, connectionsAccessCheckAddress } from './connections-navigation.js';

export interface AuthenticationAccessComparison {
  original: AuthenticationAccessVerification; recheck: AuthenticationAccessVerification; read_at: number;
  inconsistent_authentication: string[];
}
const resource = (r: AuthenticationAccessResult): string => JSON.stringify(authenticationIncidentScope(r.target));
const evidence = (v: AuthenticationAccessVerification): string => JSON.stringify([v.id, v.selection.kind, v.selection.id, v.status, v.started_at, v.finished_at,
  v.results.map(r => [r.id, resource(r), r.authentication_revision, r.checks.map(c => [c.kind, c.status, c.reason]).sort()]).sort()]);
export const matchesAuthenticationAccessEvidence = (value: AuthenticationAccessVerification, expected: AuthenticationAccessVerification): boolean => evidence(value) === evidence(expected);
const displayStamp = (v: AuthenticationAccessVerification): string => evidence(v) + JSON.stringify(v.results.map(r => [r.id, r.current]));
const comparable = (v: AuthenticationAccessVerification): boolean => isAuthenticationAccessVerification(v) && v.status === 'completed' && v.selection.kind === 'verification' && v.id !== v.selection.id;
class AccessComparisonError extends Error {}

/** Both replies are saved local status. Dynamic current-authentication flags are deliberately refreshed. */
export const resolveAuthenticationAccessComparison = async (call: ManagedOAuthCaller, expected: AuthenticationAccessVerification,
  current: () => boolean = () => true): Promise<AuthenticationAccessComparison> => {
  const snapshot = structuredClone(expected);
  if (!comparable(snapshot) || !current()) throw new AccessComparisonError('Wait for the recheck to finish, then compare its saved results.');
  let replies: Awaited<ReturnType<ManagedOAuthCaller>>[];
  try { replies = await Promise.all([snapshot.id, snapshot.selection.id].map(async id => call({ action: 'authentication_access_status', id }))); }
  catch { throw new AccessComparisonError('The saved checks could not be read. Unlock Recued or refresh history, then retry. The original may no longer be retained.'); }
  if (!current()) throw new AccessComparisonError('This comparison is no longer open.');
  const [after, before] = replies;
  if (!after || after.action !== 'authentication_access_status' || !isAuthenticationAccessVerification(after.verification)
    || !before || before.action !== 'authentication_access_status' || !isAuthenticationAccessVerification(before.verification)) {
    throw new AccessComparisonError('The saved checks could not be confirmed. Refresh history before comparing again.');
  }
  const recheck = after.verification; const original = before.verification;
  const candidates = authenticationAccessRecheckResults(original);
  if (!matchesAuthenticationAccessEvidence(recheck, snapshot) || original.id !== snapshot.selection.id || original.status !== 'completed'
    || original.finished_at! > recheck.started_at || !recheck.results.every(r => candidates.some(o => o.id === r.id && resource(o) === resource(r)))) {
    throw new AccessComparisonError('These saved checks do not form a matching original and recheck. Refresh history before comparing again.');
  }
  const value: AuthenticationAccessComparison = { original: structuredClone(original), recheck: structuredClone(recheck), read_at: Date.now(), inconsistent_authentication: [] };
  for (const after of value.recheck.results) {
    const before = value.original.results.find(r => r.id === after.id)!;
    // Each status request compares authentication independently. A concurrent
    // edit can make their projections impossible as one current observation.
    const sameRevision = before.authentication_revision === after.authentication_revision;
    if (before.current !== 'unknown' && after.current !== 'unknown'
      && (sameRevision ? before.current !== after.current : before.current === 'yes' && after.current === 'yes')) {
      value.inconsistent_authentication.push(after.id);
      before.current = after.current = 'unknown'; delete before.file_connection; delete after.file_connection;
    }
  }
  return value;
};

const authenticationText = (r: AuthenticationAccessResult): string => r.current === 'yes' ? 'Matches current saved authentication'
  : r.current === 'no' ? 'Superseded · Authentication or source changed' : 'Unknown · Current authentication could not be compared';
const appendComparison = (doc: Document, parent: HTMLElement, value: AuthenticationAccessComparison, targetId?: string): void => {
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => { const n = doc.createElement(tag); if (text !== undefined) n.textContent = text; return n; };
  const section = node('section'); section.className = 'access-comparison'; section.setAttribute('aria-label', 'Original and recheck results'); section.setAttribute('data-access-comparison', value.recheck.id);
  section.appendChild(node('h4', 'Original and recheck results'));
  section.appendChild(node('p', 'Comparison read: ' + new Date(value.read_at).toLocaleString() + '. Refresh this comparison after changing authentication.'));
  const clocks = node('div'); clocks.className = 'access-comparison-clocks';
  for (const [side, v] of [['original', value.original], ['recheck', value.recheck]] as const) {
    const column = node('div'); column.setAttribute('data-access-comparison-' + side, v.id); column.appendChild(node('h5', side === 'original' ? 'Original check' : 'Recheck'));
    for (const [label, timestamp] of [['Started', v.started_at], ['Finished', v.finished_at!]] as const) {
      const p = node('p', label + ': '); const time = node('time', new Date(timestamp).toLocaleString()); time.dateTime = new Date(timestamp).toISOString(); p.appendChild(time); column.appendChild(p);
    }
    clocks.appendChild(column);
  }
  section.appendChild(clocks);
  for (const after of value.recheck.results.filter(r => !targetId || r.id === targetId)) {
    const before = value.original.results.find(r => r.id === after.id)!;
    const article = node('div'); article.setAttribute('data-access-comparison-target', after.id); article.appendChild(node('h5', after.label));
    if (value.inconsistent_authentication.includes(after.id)) article.appendChild(node('p', 'Current authentication could not be compared consistently across these saved checks. Refresh comparison before relying on either result.'));
    const oldAuth = node('p', 'Original: ' + authenticationText(before)); oldAuth.setAttribute('data-access-comparison-before-current', before.current); article.appendChild(oldAuth);
    const newAuth = node('p', 'Recheck: ' + authenticationText(after)); newAuth.setAttribute('data-access-comparison-after-current', after.current); article.appendChild(newAuth);
    article.appendChild(node('p', before.authentication_revision === after.authentication_revision ? 'Both checks recorded the same authentication revision.' : 'The recorded authentication revision changed between these checks.'));
    const table = node('table'); table.setAttribute('role', 'table'); const caption = node('caption', 'Read outcomes for ' + after.label); table.appendChild(caption);
    const head = node('thead'); head.setAttribute('role', 'rowgroup'); const headers = node('tr'); headers.setAttribute('role', 'row');
    for (const text of ['Check', 'Original', 'Recheck']) { const th = node('th', text); th.scope = 'col'; th.setAttribute('role', 'columnheader'); headers.appendChild(th); } head.appendChild(headers); table.appendChild(head);
    const body = node('tbody'); body.setAttribute('role', 'rowgroup');
    for (const kind of Object.keys(authenticationAccessCheckLabels) as AuthenticationAccessCheckKind[]) {
      const oldCheck = before.checks.find(c => c.kind === kind); const newCheck = after.checks.find(c => c.kind === kind); if (!oldCheck && !newCheck) continue;
      const row = node('tr'); row.setAttribute('role', 'row'); const heading = node('th', authenticationAccessCheckLabels[kind]); heading.scope = 'row'; heading.setAttribute('role', 'rowheader'); row.appendChild(heading);
      const left = node('td', authenticationAccessCheckText(oldCheck, before.current)); left.setAttribute('role', 'cell'); left.setAttribute('data-access-comparison-column', 'Original'); left.setAttribute('data-access-comparison-before', kind); row.appendChild(left);
      const right = node('td', authenticationAccessCheckText(newCheck, after.current)); right.setAttribute('role', 'cell'); right.setAttribute('data-access-comparison-column', 'Recheck'); right.setAttribute('data-access-comparison-after', kind); row.appendChild(right); body.appendChild(row);
    }
    table.appendChild(body); article.appendChild(table);
    const original = node('a', 'Open original saved result'); original.href = connectionsAccessResultAddress({ verification_id: value.original.id, target_id: before.id }).hash;
    original.setAttribute('href', original.href); article.appendChild(original); section.appendChild(article);
  }
  section.appendChild(node('p', 'These checks cover the same local account or source. API URLs, chosen files and selected folders or calendars may differ between attempts; saved results do not retain every choice. A pass covers only the read in that attempt.'));
  section.appendChild(node('p', 'This comparison does not establish which repair caused a change. Sending, editing, workflows, sync and incident recovery remain separate.'));
  parent.appendChild(section);
};

/** One explicit comparison per view, retained across renders and cancelled on snapshot replacement. */
let comparisonViewCounter = 0;
export const createAuthenticationAccessComparisons = (deps: { document: Document; call: ManagedOAuthCaller;
  host(): HTMLElement | null; active(): boolean; changed(): void }) => {
  const doc = deps.document; const viewId = 'access-comparison-view-' + ++comparisonViewCounter;
  let disposed = false; let generation = 0; let opening: string | undefined; let pending = Promise.resolve();
  let saved: { key: string; stamp: string; value?: AuthenticationAccessComparison; error?: string } | undefined;
  const controls = new Map<string, { stamp: string; container: HTMLElement; button: HTMLButtonElement; open(): Promise<void> }[]>();
  const live = (key: string, stamp: string): boolean => !disposed && deps.active() && !!controls.get(key)?.some(c => c.stamp === stamp && deps.host()?.contains(c.container));
  const reset = (): void => { generation++; opening = undefined; saved = undefined; controls.clear(); pending = Promise.resolve(); };
  const append = (parent: HTMLElement, source: AuthenticationAccessVerification, targetId?: string): void => {
    if (disposed || !comparable(source) || targetId && !source.results.some(r => r.id === targetId)) return;
    const key = source.id + (targetId ? ':' + targetId : '');
    const stamp = displayStamp(source);
    const displayed = saved?.key === key && saved.stamp === stamp ? saved : undefined;
    const container = doc.createElement('div'); container.className = 'access-comparison-controls';
    const content = doc.createElement('div'); const contentId = viewId + '-' + key.replace(/:/g, '-') + '-' + (controls.get(key)?.length ?? 0);
    content.setAttribute('id', contentId); content.setAttribute('aria-busy', String(opening === key)); content.hidden = !displayed?.value;
    const b = doc.createElement('button'); b.type = 'button'; b.textContent = opening === key ? 'Reading saved checks…' : displayed?.value ? 'Refresh comparison' : 'Compare with original check';
    b.disabled = !!opening || !deps.active(); b.setAttribute('data-access-compare', key); b.setAttribute('aria-controls', contentId); b.setAttribute('aria-expanded', String(!!displayed?.value)); container.appendChild(b);
    controls.set(key, [...controls.get(key) ?? [], { stamp, container, button: b, open: () => start(false) }]);
    const page = doc.createElement('a'); page.className = 'authentication-access-page'; page.textContent = 'Open comparison page';
    page.href = connectionsAccessCheckAddress({ verification_id: source.id, view: 'comparison', ...(targetId ? { target_id: targetId } : {}) }).hash;
    page.setAttribute('href', page.href); page.setAttribute('data-access-comparison-page', key); container.appendChild(page);
    if (opening === key) { const status = doc.createElement('p'); status.setAttribute('role', 'status'); status.textContent = 'Reading saved checks for comparison…'; container.appendChild(status); }
    if (displayed?.error) { const p = doc.createElement('p'); p.setAttribute('role', 'alert'); p.textContent = displayed.error; container.appendChild(p); }
    container.appendChild(content);
    if (displayed?.value) {
      appendComparison(doc, content, displayed.value, targetId);
      const hide = doc.createElement('button'); hide.type = 'button'; hide.textContent = 'Hide comparison'; hide.disabled = !!opening || !deps.active();
      hide.setAttribute('aria-controls', contentId);
      hide.setAttribute('data-access-comparison-hide', key); hide.addEventListener('click', () => {
        if (hide.disabled || !live(key, stamp) || !deps.host()?.contains(hide)) return;
        const occurrence = controls.get(key)!.findIndex(c => c.container === container);
        saved = undefined; deps.changed(); controls.get(key)?.[occurrence]?.button.focus({ preventScroll: true });
      }); container.appendChild(hide);
    }
    const proof = structuredClone(source);
    const start = (focusComparison = true): Promise<void> => {
      if (b.disabled || opening || !live(key, stamp) || !deps.host()?.contains(b)) return pending;
      const occurrence = controls.get(key)!.findIndex(c => c.button === b); const gen = generation; const focusAtStart = doc.activeElement;
      opening = key; saved = { key, stamp }; deps.changed(); const focusAfterRender = deps.host()?.contains(doc.activeElement) ? doc.activeElement : null;
      const current = (): boolean => gen === generation && live(key, stamp);
      pending = (async () => {
        try { const value = await resolveAuthenticationAccessComparison(deps.call, proof, current); if (current()) saved = { key, stamp, value }; }
        catch (e) { if (current()) saved = { key, stamp, error: e instanceof AccessComparisonError ? e.message : 'These saved checks could not be compared. Refresh history and try again.' }; }
        finally { if (!disposed && gen === generation) {
          const restore = focusComparison && (doc.activeElement === focusAtStart || doc.activeElement === doc.body || focusAfterRender !== null && doc.activeElement === focusAfterRender);
          const chosenFocus = doc.activeElement;
          const chosenHref = !restore && deps.host()?.contains(chosenFocus) ? chosenFocus?.getAttribute('href') ?? null : null;
          const matchingLinks = (): HTMLElement[] => Array.from(deps.host()?.querySelectorAll<HTMLElement>('[href]') ?? []).filter(a => a.getAttribute('href') === chosenHref);
          const linkOccurrence = chosenHref !== null ? matchingLinks().findIndex(a => a === chosenFocus) : -1;
          opening = undefined; deps.changed(); const control = controls.get(key)?.[occurrence];
          if (restore && control?.stamp === stamp && deps.host()?.contains(control.container)) control.button.focus({ preventScroll: true });
          else if (linkOccurrence >= 0 && (doc.activeElement === doc.body || doc.activeElement === chosenFocus)) matchingLinks()[linkOccurrence]?.focus({ preventScroll: true });
        } }
      })(); return pending;
    };
    b.addEventListener('click', () => { void start(); }); parent.appendChild(container);
  };
  return { append,
    open(source: AuthenticationAccessVerification, targetId?: string): Promise<void> {
      if (disposed || !comparable(source)) return pending;
      return controls.get(source.id + (targetId ? ':' + targetId : ''))?.find(c => c.stamp === displayStamp(source))?.open() ?? pending;
    },
    beginRender(): void { controls.clear(); }, busy: (): boolean => !!opening, whenLoaded: (): Promise<void> => pending,
    reset, dispose(): void { disposed = true; reset(); } };
};
export const AUTHENTICATION_ACCESS_COMPARISON_STYLES = `
.access-comparison-controls{margin:12px 0}
.access-comparison{min-width:0;overflow-wrap:anywhere;padding:12px;border:1px solid var(--border,#d9dfeb);border-radius:8px}
.access-comparison h5{font-size:inherit;margin:12px 0 4px}
.access-comparison-clocks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.access-comparison table{width:100%;table-layout:fixed;border-collapse:collapse;margin:12px 0}
.access-comparison caption{text-align:left;margin:4px 0}
.access-comparison th,.access-comparison td{text-align:left;vertical-align:top;border:1px solid var(--border,#d9dfeb);padding:8px;overflow-wrap:anywhere}
.access-comparison-controls button{font:inherit;min-height:44px;max-width:100%;white-space:normal;margin:4px 8px 4px 0;padding:7px 12px}
.access-comparison-controls [role=alert]{color:var(--danger,#b42318)}
@media(max-width:600px){
  .access-comparison-clocks{grid-template-columns:minmax(0,1fr)}
  .access-comparison table,.access-comparison caption,.access-comparison tbody{display:block}
  .access-comparison thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
  .access-comparison tbody tr{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;padding:10px;border:1px solid var(--border,#d9dfeb);border-radius:6px;margin:8px 0}
  .access-comparison tbody th,.access-comparison td{display:block;border:0;padding:0}
  .access-comparison td::before{content:attr(data-access-comparison-column);display:block;font-weight:600;margin-bottom:3px}
}`;
