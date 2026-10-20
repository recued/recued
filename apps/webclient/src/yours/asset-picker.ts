import type { Asset, AssetClassPreset, YoursReadRequest, YoursSnapshot } from '@recued/contracts';
import { RefPicker } from '@recued/ui-shared';

export interface AssetPicker extends RefPicker.RefPickerHandle {
  read(required?: boolean): string | null;
}

interface AssetPickerOptions {
  id: string;
  label: string;
  value?: string;
  assets: readonly Asset[];
  classes: readonly AssetClassPreset[];
  read(input: YoursReadRequest): Promise<YoursSnapshot>;
  allowed?(asset: Asset, known: readonly Asset[]): boolean;
  onChange?(selection: RefPicker.RefPickerSelection | null): void;
  onInput?(): void;
}

/** One asset-backed adapter over the shared combobox. Searches the server's
 * inventory rather than the page that happened to be loaded by Yours. */
export const mountAssetPicker = (parent: HTMLElement, options: AssetPickerOptions): AssetPicker => {
  const doc = parent.ownerDocument;
  if (!doc.head.querySelector('style[data-yours-asset-picker-styles]')) {
    const style = doc.createElement('style'); style.dataset.yoursAssetPickerStyles = '';
    style.textContent = RefPicker.REF_PICKER_STYLES + `
      [data-recued-yours] .ref-picker-input {padding-right:52px}
      [data-recued-yours] .ref-picker-results {position:static;box-sizing:border-box;width:100%;max-height:240px}
    `;
    doc.head.append(style);
  }
  const caption = doc.createElement('label'); caption.textContent = options.label; caption.htmlFor = `${options.id}-input`;
  const host = doc.createElement('div'); host.dataset.yoursAssetPicker = options.id;
  const status = doc.createElement('p'); status.className = 'yours-muted'; status.setAttribute('role', 'status'); status.hidden = true;
  parent.append(caption, host, status);
  const known = new Map(options.assets.map(asset => [asset.id, asset]));
  const initialAsset = options.value ? known.get(options.value) : undefined;
  const initial = options.value ? { id: options.value, label: initialAsset?.name ?? 'Saved asset' } : null;
  const config: RefPicker.RefPickerRenderConfig = { pickerId: options.id, ariaLabel: options.label,
    placeholder: 'Search assets by name…', emptyText: 'No matching assets.',
    truncatedText: 'More assets match. Type a more specific name to narrow the results.' };
  host.innerHTML = RefPicker.renderRefPicker(RefPicker.initialRefPickerState(initial), config);
  const input = host.querySelector<HTMLInputElement>('[data-ref-picker-input]')!;
  input.id = caption.htmlFor; input.maxLength = 200; input.dataset.yoursFocus = options.id;
  let destroyed = false; let selectionChanged = false;
  const allowed = (asset: Asset) => asset.deleted_at == null && (options.allowed?.(asset, [...known.values()]) ?? true);
  const handle = RefPicker.wireRefPicker(host, { config, initialValue: initial, minChars: 0,
    search: async query => {
      const result = await options.read({ search: query, limit: 50, offset: 0, mark_shown: false });
      if (destroyed) return [];
      for (const asset of result.assets) known.set(asset.id, asset);
      return { options: result.assets.filter(allowed).map(asset => {
        const type = options.classes.find(preset => preset.id === asset.class_id)?.name ?? 'Asset';
        const place = asset.anchors.flatMap(anchor => anchor.kind === 'place' && anchor.name ? [anchor.name] : [])[0];
        return { id: asset.id, label: asset.name,
          sublabel: [type, asset.status, place, asset.serial_number ? `Serial ${asset.serial_number}` : undefined].filter(Boolean).join(' · ') };
      }), truncated: result.total_assets > result.assets.length };
    },
    onChange: selection => { selectionChanged = true; status.hidden = true; options.onChange?.(selection); },
  });
  const onInput = () => options.onInput?.(); host.addEventListener('input', onInput);
  // Blurring collapses the inline list. Reserve its height for the pointer
  // gesture so Clear, Save and Cancel cannot move between down and click.
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  const releaseActionPosition = () => {
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => { host.style.removeProperty('min-height'); }, 0);
  };
  const keepActionPosition = (event: Event) => {
    const button = (event.target as Element | null)?.closest?.('button');
    if (button && host.contains(doc.activeElement)) {
      clearTimeout(releaseTimer); host.style.minHeight = `${host.getBoundingClientRect().height}px`;
    }
  };
  parent.addEventListener('pointerdown', keepActionPosition, true);
  parent.addEventListener('mousedown', keepActionPosition, true);
  doc.addEventListener('pointerup', releaseActionPosition);
  doc.addEventListener('pointercancel', releaseActionPosition);
  doc.addEventListener('mouseup', releaseActionPosition);
  // Proposal references can be outside the current page. Resolve their label
  // without replacing a query or a selection the owner made in the meantime.
  if (initial && !initialAsset) void (async () => {
    const result = await options.read({ asset_id: initial.id, mark_shown: false });
    const asset = result.assets.find(asset => asset.id === initial.id);
    if (destroyed || !host.isConnected || selectionChanged || handle.getValue()?.id !== initial.id) return;
    if (!asset || asset.deleted_at != null) throw new Error('Saved asset unavailable');
    // Same-id label hydration preserves the shared picker's live query. Escape
    // or blur can then restore the real name instead of the temporary label.
    known.set(asset.id, asset); handle.setValue({ id: asset.id, label: asset.name });
  })().catch(() => {
    if (destroyed || !host.isConnected || selectionChanged || handle.getValue()?.id !== initial.id || handle.getQuery() !== initial.label) return;
    status.textContent = 'The saved asset could not be read. Search to choose another asset.'; status.hidden = false;
  });
  return { ...handle,
    read(required = true) {
      const selection = handle.getValue();
      if (handle.getQuery() !== (selection?.label ?? '') || required && !selection) throw new Error(`Choose ${options.label.toLowerCase()} from the matches`);
      if (selection && known.has(selection.id) && !allowed(known.get(selection.id)!)) throw new Error('Choose a different asset');
      return selection?.id ?? null;
    },
    destroy() {
      destroyed = true; handle.destroy(); host.removeEventListener('input', onInput);
      parent.removeEventListener('pointerdown', keepActionPosition, true);
      parent.removeEventListener('mousedown', keepActionPosition, true);
      doc.removeEventListener('pointerup', releaseActionPosition);
      doc.removeEventListener('pointercancel', releaseActionPosition);
      doc.removeEventListener('mouseup', releaseActionPosition); clearTimeout(releaseTimer); known.clear();
    },
  };
};
