import { isPackVendorPermissionReview, type PackVendorPermissionReview } from '@recued/contracts';
import type { InstallPreview } from './packs-install-dialog.js';
export const PACK_VENDOR_PERMISSION_REVIEW_ATTR = 'data-recued-pack-vendor-permissions';
export const PACK_VENDOR_PERMISSION_CONSENT_ATTR = 'data-recued-pack-vendor-permissions-consent';
export const PACK_VENDOR_PERMISSION_REFRESH_ATTR = 'data-recued-pack-vendor-permissions-refresh';
export const PACK_VENDOR_PERMISSION_RECONNECT_ATTR = 'data-recued-pack-vendor-permissions-reconnect';
export const vendorPermissionReview = (preview: InstallPreview | undefined): PackVendorPermissionReview | undefined =>
  isPackVendorPermissionReview(preview?.vendor_permissions) ? preview.vendor_permissions : undefined;
export const vendorPermissionReviewRequired = (preview: InstallPreview | undefined): boolean => {
  const review = vendorPermissionReview(preview);
  return preview?.vendor_permission_review_failed === true
    || preview?.vendor_permissions !== undefined && (!review || review.changes.length > 0 || !review.resolved);
};
export const vendorPermissionAcknowledgementKey = (review: PackVendorPermissionReview, chosen?: string): string =>
  review.fingerprint + ':' + (chosen ?? '');
export const renderPackVendorPermissions = (props: {
  document: Document; preview?: InstallPreview; packSlug: string; chosen?: string; also?: readonly string[];
  reviewed: boolean; disabled: boolean; onReview(checked: boolean): void; onRefresh(): void;
  onReconnect?(name: string): void;
}): HTMLElement | null => {
  if (props.preview?.vendor_permissions === undefined && !props.preview?.vendor_permission_review_failed) return null;
  const doc = props.document; const review = vendorPermissionReview(props.preview);
  if (review?.resolved && !review.changes.length) return null;
  const section = doc.createElement('section'); section.setAttribute(PACK_VENDOR_PERMISSION_REVIEW_ATTR, '');
  section.setAttribute('style', 'overflow-wrap:anywhere;min-width:0;border:1px solid var(--border);border-radius:8px;padding:12px;margin:12px 0');
  section.id = 'packs-dialog-vendor-permissions'; section.className = 'packs-dialog-vendor-permissions';
  const paragraph = (text: string): void => { const p = doc.createElement('p'); p.textContent = text; section.appendChild(p); };
  const heading = doc.createElement('h4'); heading.textContent = 'Vendor permissions'; section.appendChild(heading);
  paragraph('Installing this Pack does not grant vendor permissions. Recued access choices still control what its actions may do.');
  if (!review) paragraph('The vendor permission review could not be read. Refresh it before installing.');
  else {
    if (!review.resolved) paragraph('Saved account permissions could not be checked. You can explicitly install and reconnect later.');
    for (const change of review.changes) {
      const title = doc.createElement('h5'); title.textContent = change.pack_name + ' · ' + change.slot; section.appendChild(title);
      paragraph('Required: ' + (change.required_scopes.join(', ') || 'No vendor scopes remain required.'));
      if (change.previous_scopes === undefined) paragraph('Previous installed permissions are unknown; a precise change list is unavailable.');
      else {
        paragraph('Added: ' + (change.added_scopes?.join(', ') || 'None.'));
        if (change.removed_scopes?.length) paragraph('No longer required: ' + change.removed_scopes.join(', ') + '. Existing vendor consent is retained.');
      }
      // The install forwards the owner's account to dependencies on the same API.
      // An update retains its existing account list, which is labelled separately.
      const selected = props.chosen && (change.pack_slug === props.packSlug || change.uses_selected_connection === true)
        ? [props.chosen, ...(change.pack_slug === props.packSlug ? props.also ?? [] : [])] : [];
      const names = [...new Set([...selected, ...change.current_connections])];
      if (!names.length) paragraph('No saved account is selected for this service. You can connect later.');
      for (const name of names) {
        const connection = change.connections.find(c => c.name === name);
        paragraph((selected.includes(name) ? 'Selected account: ' : 'Existing account: ') + (connection?.display_name ?? name) + ' · ' + (connection?.authentication === 'direct_oauth' ? 'Recued direct OAuth'
          : connection?.authentication === 'broker' ? 'Broker account' : 'Saved authentication') + ': '
          + (connection?.coverage === 'covered' ? 'Recorded vendor grants cover these scopes.'
            : connection?.coverage === 'missing' ? 'Reauthorize for: ' + connection.missing_scopes.join(', ') + '.'
              : 'Vendor grant coverage is unknown. Review permissions before using the new actions.'));
        const link = doc.createElement('a'); link.href = '#connections/others/review-access/api/' + encodeURIComponent(name);
        link.textContent = 'Review permissions in Apps & APIs'; section.appendChild(link);
        if (props.onReconnect && review.resolved && change.required_scopes.length
          && connection && ['direct_oauth', 'broker'].includes(connection.authentication)) {
          const reconnect = doc.createElement('button'); reconnect.type = 'button'; reconnect.disabled = props.disabled;
          reconnect.setAttribute(PACK_VENDOR_PERMISSION_RECONNECT_ATTR, name); reconnect.textContent = 'Reconnect now';
          reconnect.addEventListener('click', () => props.onReconnect?.(name)); section.appendChild(reconnect);
        }
      }
      if (change.required_scopes.length) {
        const copy = doc.createElement('button'); copy.type = 'button'; copy.disabled = props.disabled;
        copy.textContent = 'Copy required scopes';
        copy.addEventListener('click', () => { const clipboard = doc.defaultView?.navigator.clipboard;
          if (!clipboard) { copy.textContent = 'Select the scopes above to copy'; return; }
          void clipboard.writeText(change.required_scopes.join(' ')).then(() => { copy.textContent = 'Scopes copied'; })
            .catch(() => { copy.textContent = 'Select the scopes above to copy'; }); });
        section.appendChild(copy);
      }
    }
    const label = doc.createElement('label'); const input = doc.createElement('input'); input.type = 'checkbox';
    input.setAttribute(PACK_VENDOR_PERMISSION_CONSENT_ATTR, ''); input.checked = props.reviewed; input.disabled = props.disabled;
    input.addEventListener('change', () => props.onReview(input.checked)); label.appendChild(input);
    const text = doc.createElement('span'); text.textContent = 'I reviewed vendor permissions. Install now; I can reconnect later if needed.';
    label.appendChild(text); section.appendChild(label);
  }
  const refresh = doc.createElement('button'); refresh.type = 'button'; refresh.disabled = props.disabled;
  refresh.setAttribute(PACK_VENDOR_PERMISSION_REFRESH_ATTR, ''); refresh.textContent = 'Refresh permission review';
  refresh.addEventListener('click', props.onRefresh); section.appendChild(refresh); return section;
};
