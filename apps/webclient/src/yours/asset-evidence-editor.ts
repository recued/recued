import { yoursFieldError } from './yours-field-errors.js';
import { assetDocumentDetails, type Asset, type AssetAddEvidenceCommand, type FileAttachmentSelection, type Link } from '@recued/contracts';
import { yoursChoice, yoursEmpty, yoursNode } from './yours-view.js';

export const mountAssetEvidenceEditor = (host: HTMLFormElement, asset: Asset, group: 'readings' | 'observations', field: string, links: readonly Link[], changed: () => void,
  readMetadata?: (id: string, retry: boolean) => Promise<FileAttachmentSelection>, isCurrent: () => boolean = () => host.isConnected) => {
  const observed = asset[group][field]; if (!observed) throw new Error('Record the observation before adding evidence');
  const attached = links.filter(file => file.role === 'attachment' && file.to_collection === 'file');
  yoursNode(host, 'p', '', 'Cite a supporting file without changing the recorded value, observation time, or which source may update it.');
  const choice = yoursChoice(host, 'Supporting file', 'evidence-file', [['', 'Choose an attached file'], ...attached.map(file => [file._id, assetDocumentDetails(asset, file.to_id).purpose ?? 'Attached file · loading name…'] as [string, string])], '', changed);
  choice.required = true;
  if (!attached.length) yoursEmpty(host, 'Attach a supporting file to this asset first.');
  if (attached.length && !readMetadata) yoursEmpty(host, 'File details are unavailable here. Open Files to review the supporting document.');
  const open = yoursNode(host, 'a', '', 'Open this asset’s files'); open.href = `#yours/asset/${encodeURIComponent(asset.id)}/view/files`;
  for (const file of attached) {
    const option = [...choice.options].find(option => option.value === file._id)!; option.disabled = true;
    const status = yoursNode(host, 'div', 'yours-muted'); status.hidden = true; status.setAttribute('role', 'status'); let pending = false;
    const load = async (retry = false) => {
      if (!readMetadata || pending || !isCurrent()) return;
      pending = true; option.disabled = true; status.hidden = true; status.replaceChildren();
      try {
        const metadata = await readMetadata(file.to_id, retry);
        if (isCurrent() && option.isConnected) { option.textContent = metadata.filename; option.disabled = false; }
      } catch {
        if (!isCurrent() || !option.isConnected) return;
        status.hidden = false;
        option.textContent = `${assetDocumentDetails(asset, file.to_id).purpose ?? 'Attached file'} · details unavailable`;
        yoursNode(status, 'p', '', 'Read the file’s name before choosing it as evidence.');
        const button = yoursNode(status, 'button', '', 'Retry file name'); button.type = 'button'; button.addEventListener('click', () => { void load(true); });
      } finally { pending = false; }
    };
    void load();
  }
  return { read(): AssetAddEvidenceCommand {
    const file = attached.find(file => file._id === choice.value);
    if (!file || choice.selectedOptions[0]?.disabled) yoursFieldError(choice, 'Choose an attached file whose details can be read');
    const path = `${group}.${field}` as const;
    return { action: 'asset.add_evidence', id: asset.id, path, expected: { value: observed, source: asset.field_sources[path] ?? null }, attachment_id: file._id, evidence: { collection: 'file', id: file.to_id } };
  } };
};
