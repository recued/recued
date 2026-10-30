import type { SituationRef, Sphere, YoursCommand, YoursCommandResult, YoursSpherePlacement } from '@recued/contracts';
import { classifyRpcError } from '../shell/rpc-error-copy.js';
export interface SpherePlacementCallers {
  read(ref: SituationRef): Promise<YoursSpherePlacement>;
  readMany?(refs: SituationRef[]): Promise<Array<YoursSpherePlacement & { ref: SituationRef }>>;
  change(input: YoursCommand): Promise<YoursCommandResult>;
}
/** Owner control shared by Data and Yours. It never derives a sphere in the
 * browser or treats a missing result as a personal default. */
export const mountSpherePlacement = (host: HTMLElement, ref: SituationRef, callers: SpherePlacementCallers, before: Element | null = null) => {
  const doc = host.ownerDocument; const root = doc.createElement('details'); root.dataset.spherePlacement = ''; host.insertBefore(root, before);
  root.style.cssText = 'padding:12px;margin:12px 0;border:1px solid var(--border,#ccc);border-radius:8px;';
  let disposed = false; let busy = false; let placement: YoursSpherePlacement | undefined;
  const summary = doc.createElement('summary'); summary.textContent = 'Sphere · loading'; root.append(summary);
  const body = doc.createElement('div'); root.append(body);
  const note = doc.createElement('p'); note.textContent = 'Placement controls which AI contracts may read this record. Unknown items stay unsorted.'; body.append(note);
  const label = doc.createElement('label'); label.textContent = 'This item’s sphere '; body.append(label);
  const choice = doc.createElement('select'); choice.setAttribute('aria-label', 'This item’s sphere'); label.append(choice);
  choice.style.cssText = 'min-height:44px;max-width:100%;font:inherit;';
  for (const [value, title] of [['', 'Use source or derivation'], ['personal', 'Personal'], ['professional', 'Professional']]) { const option = doc.createElement('option'); option.value = value!; option.textContent = title!; choice.append(option); }
  const status = doc.createElement('p'); status.setAttribute('role', 'status'); body.append(status);
  const error = doc.createElement('p'); error.setAttribute('role', 'alert'); body.append(error);
  const source = doc.createElement('button'); source.type = 'button'; source.textContent = 'Apply this placement to its source'; body.append(source);
  const resetSource = doc.createElement('button'); resetSource.type = 'button'; resetSource.textContent = 'Reset source placement'; body.append(resetSource);
  source.className = resetSource.className = 'data-button';
  const refresh = async () => {
    const next = await callers.read(ref); if (disposed || !root.isConnected) return;
    placement = next;
    const sphereLabel = next.sphere === 'personal' ? 'Personal' : next.sphere === 'professional' ? 'Professional' : 'Unsorted';
    summary.textContent = next.reason === 'unsorted' ? `Sphere · ${sphereLabel}` : `${sphereLabel} · ${next.reason}`;
    choice.value = next.pinned ? next.sphere ?? '' : ''; source.hidden = !next.source; resetSource.hidden = !next.source;
    source.disabled = !next.sphere;
  };
  const update = async (input: YoursCommand) => {
    if (busy || disposed) return; busy = true; choice.disabled = source.disabled = resetSource.disabled = true; error.textContent = '';
    try { const result = await callers.change(input); if (disposed || !root.isConnected) return; status.textContent = result.message; await refresh(); }
    catch (failure) { if (!disposed) error.textContent = failure instanceof Error ? failure.message : String(failure); }
    finally { busy = false; if (!disposed) { choice.disabled = resetSource.disabled = false; source.disabled = !placement?.sphere; } }
  };
  choice.addEventListener('change', () => { void update({ action: 'sphere.item', ref, sphere: choice.value ? choice.value as Sphere : null }); });
  source.addEventListener('click', () => { if (placement?.source && placement.sphere) void update({ action: 'sphere.source', source: placement.source, sphere: placement.sphere }); });
  resetSource.addEventListener('click', () => { if (placement?.source) void update({ action: 'sphere.source', source: placement.source, sphere: null }); });
  choice.disabled = true;
  void refresh().then(() => { if (!disposed) choice.disabled = false; }).catch(failure => { if (!disposed && classifyRpcError(failure).code === 'unknown_method') { root.remove(); return; } if (!disposed) { summary.textContent = 'Sphere unavailable'; error.textContent = failure instanceof Error ? failure.message : String(failure); } });
  return { dispose() { disposed = true; root.remove(); } };
};
