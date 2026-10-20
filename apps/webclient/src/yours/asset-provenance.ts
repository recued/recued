import type { Asset, AssetContributionKind, AssetEvidence, AssetFactSource, AssetPatch } from '@recued/contracts';

/** D-325 §15.3 — where an asset's facts came from, in the owner's words. */

const FACT_MAPS = new Set(['dates', 'readings', 'observations', 'attributes', 'settings']);
const canonical = (value: unknown): string => JSON.stringify(value ?? null, (_key, inner: unknown) =>
  inner && typeof inner === 'object' && !Array.isArray(inner)
    ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))) : inner);

/** An edit sends only what the owner changed. The store stamps every value it is
 * sent with the owner's source, so re-sending an untouched extracted date claimed
 * the owner typed it, and the owner's rank then refused the next extraction. */
export const changedAssetPatch = (patch: AssetPatch, own: Partial<Asset>): AssetPatch => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const before = (own as Record<string, unknown>)[key];
    if (FACT_MAPS.has(key) && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const prior = (before ?? {}) as Record<string, unknown>;
      const changed = Object.entries(value).filter(([field, next]) => canonical(next) !== canonical(prior[field]));
      if (changed.length) out[key] = Object.fromEntries(changed);
    } else if (canonical(value) !== canonical(before)) out[key] = value;
  }
  return out as AssetPatch;
};

/** The field a source stamp covers, for each fact the page lists. */
export const assetFactPath = (group: 'dates' | 'attributes' | 'settings' | 'core', name: string): string =>
  group === 'core' ? name : `${group}.${name}`;

const FROM: Record<AssetContributionKind, string> = {
  owner: 'Entered by you',
  confirmed_document: 'From a document you confirmed',
  observation: 'Reported by a device or recipe',
  extracted: 'Extracted from your data',
  ai_guess: 'An AI guess',
};
/** What can replace the value, which is what its rank means to the owner. */
const OUTRANKED_BY: Record<AssetContributionKind, string> = {
  owner: 'Nothing automatic replaces it.',
  confirmed_document: 'Only your own entry outranks it.',
  observation: 'A document you confirm or your own entry outranks it.',
  extracted: 'A device report, a document you confirm or your own entry outranks it.',
  ai_guess: 'Anything else outranks it.',
};
export const assetSourceWords = (source: AssetFactSource): { from: string; rank: string } => ({
  from: `${source.ref.startsWith('reception:') ? 'From a request that came in' : FROM[source.kind]}, ${new Date(source.at)
    .toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`,
  rank: OUTRANKED_BY[source.kind],
});

const COLLECTION_WORDS: Record<string, string> = {
  'home-assistant': 'Home Assistant', file: 'Document', mail: 'Email', calendar: 'Calendar event', asset: 'Asset', paperless: 'Paperless',
};
/** One line of evidence: where it is, and the value it showed. */
export const assetEvidenceText = (evidence: AssetEvidence): string => {
  const where = evidence.collection === 'file' ? COLLECTION_WORDS.file! : `${COLLECTION_WORDS[evidence.collection] ?? evidence.collection} · ${evidence.id}`;
  const field = evidence.field?.replace(/^(?:dates|readings|observations|attributes|settings)\./u, '').replaceAll('_', ' ');
  const value = evidence.value === undefined || evidence.value === null ? '' : String(evidence.value);
  return [where, field && value ? `${field}: ${value}` : field || value].filter(Boolean).join(' · ');
};
