import type { Asset } from './assets.js';

/** Owner-provided context for a file attached to one asset. These describe the
 * document, not the file's opaque selection token or the asset's own model. */
export interface AssetDocumentDetails {
  purpose?: string;
  applies_to?: string;
  revision?: string;
}

/** Stored under Asset.attributes, keyed by file record id. Files and attachment
 * links retain their existing identities and lifecycles. */
export const ASSET_DOCUMENT_DETAILS_ATTRIBUTE = 'document_details';
const LIMITS = { purpose: 200, applies_to: 200, revision: 100 } as const;
const LABELS = { purpose: 'Purpose', applies_to: 'Applies to', revision: 'Document revision' } as const;

export const normalizeAssetDocumentDetails = (value: unknown): AssetDocumentDetails => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Enter document details');
  const result: AssetDocumentDetails = {};
  for (const key of Object.keys(LIMITS) as Array<keyof AssetDocumentDetails>) {
    const raw = (value as Record<string, unknown>)[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'string' || raw.length > LIMITS[key]) throw new Error(`${LABELS[key]} must be text of at most ${LIMITS[key]} characters`);
    if (raw.trim()) result[key] = raw.trim();
  }
  return result;
};

/** Tolerate older or externally supplied attributes without presenting malformed
 * values as document facts. */
export const assetDocumentDetails = (asset: Pick<Asset, 'attributes'>, recordId: string): AssetDocumentDetails => {
  const documents = asset.attributes[ASSET_DOCUMENT_DETAILS_ATTRIBUTE];
  if (!documents || typeof documents !== 'object' || Array.isArray(documents) || !Object.hasOwn(documents, recordId)) return {};
  try { return normalizeAssetDocumentDetails((documents as Record<string, unknown>)[recordId]); }
  catch { return {}; }
};
