import type { Sphere, YoursCommand, YoursCommandResult, YoursSnapshot } from '@recued/contracts';
import { classifyRpcError } from '../shell/rpc-error-copy.js';

export interface SourceSpheresOptions {
  read(): Promise<YoursSnapshot>;
  change(input: YoursCommand): Promise<YoursCommandResult>;
}
export const mountSourceSpheresPanel = (host: HTMLElement, options: SourceSpheresOptions) => {
  const doc = host.ownerDocument; const root = doc.createElement('details'); root.dataset.sourceSpheres = ''; host.append(root);
  let rows: NonNullable<YoursSnapshot['sphere_sources']> = []; let selected = ''; let sphere = ''; let dirty = false; let busy = false; let disposed = false; let error = ''; let message = '';
  const render = () => {
    root.replaceChildren(); root.hidden = !rows.length && !error;
    const summary = doc.createElement('summary'); summary.textContent = 'Default spheres'; root.append(summary);
    const copy = doc.createElement('p'); copy.textContent = 'Place a source in Personal or Work. Items you placed individually keep their placement when this default changes.'; root.append(copy);
    const form = doc.createElement('form'); form.style.cssText = 'display:grid;gap:12px;max-width:520px'; root.append(form);
    const field = (name: string, choices: Array<[string, string]>, value: string) => {
      const label = doc.createElement('label'); label.textContent = name; label.style.display = 'grid'; const input = doc.createElement('select'); input.setAttribute('aria-label', name); input.style.minHeight = '44px'; input.disabled = busy;
      for (const [id, title] of choices) { const option = doc.createElement('option'); option.value = id; option.textContent = title; input.append(option); } input.value = value; label.append(input); form.append(label); return input;
    };
    const source = field('Source to place', rows.map(row => [row.source, row.name]), selected);
    const placement = field('Source sphere', [['', 'Unsorted'], ['personal', 'Personal'], ['professional', 'Work']], sphere);
    source.addEventListener('change', () => { selected = source.value; sphere = rows.find(row => row.source === selected)?.sphere ?? ''; placement.value = sphere; dirty = false; });
    placement.addEventListener('change', () => { sphere = placement.value; dirty = sphere !== (rows.find(row => row.source === selected)?.sphere ?? ''); });
    const save = doc.createElement('button'); save.type = 'submit'; save.textContent = 'Save source sphere'; save.disabled = busy || !selected; save.style.minHeight = '44px'; form.append(save);
    const status = doc.createElement('p'); status.setAttribute('role', 'status'); status.textContent = message; root.append(status);
    const alert = doc.createElement('p'); alert.setAttribute('role', 'alert'); alert.textContent = error; root.append(alert);
    form.addEventListener('submit', event => { event.preventDefault(); if (busy || disposed || !selected) return;
      busy = true; error = ''; render();
      void options.change({ action: 'sphere.source', source: selected, sphere: sphere ? sphere as Sphere : null }).then(result => {
        if (disposed) return; message = result.message; dirty = false; const row = rows.find(row => row.source === selected); if (row) row.sphere = sphere ? sphere as Sphere : undefined;
      }).catch(value => { if (!disposed) error = value instanceof Error ? value.message : String(value); })
        .finally(() => { busy = false; if (!disposed) { render(); root.querySelector<HTMLButtonElement>('button')?.focus(); } });
    });
  };
  root.hidden = true;
  const loaded = options.read().then(snapshot => { if (disposed) return; rows = snapshot.sphere_sources ?? []; selected = rows[0]?.source ?? ''; sphere = rows[0]?.sphere ?? ''; render(); })
    .catch(value => { if (!disposed && classifyRpcError(value).code === 'unknown_method') { root.remove(); return; }
      if (!disposed) { error = value instanceof Error ? value.message : String(value); render(); } });
  return { hasDraft: () => dirty, busy: () => busy, whenLoaded: () => loaded, dispose() { disposed = true; root.remove(); } };
};
