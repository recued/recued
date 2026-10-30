import { forgetListContinuity, readListContinuity, updateListContinuity, type ListScrollPosition } from './list-preview-continuity.js';

const owners = new WeakMap<object, string>();
let sequence = 0;
const keyFor = (owner: object): string => {
  let key = owners.get(owner);
  if (!key) { key = `search-asset-return-${++sequence}`; owners.set(owner, key); }
  return key;
};
export interface SearchAssetReturn<State> {
  assetId: string;
  returnHash: string;
  state: State;
  scroll: ListScrollPosition;
}
export const saveSearchAssetReturn = <State>(doc: Document, owner: object, value: SearchAssetReturn<State>): void => {
  updateListContinuity(doc, keyFor(owner), { filter: value });
};
export const readSearchAssetReturn = <State>(doc: Document, owner: object): SearchAssetReturn<State> | undefined =>
  readListContinuity<SearchAssetReturn<State>>(doc, keyFor(owner))?.filter;

/** A return belongs to this asset visit and server connection. Other routes
 * retire it; Back/Forward between Search and the addressed asset keep it. */
export const trackSearchAssetRoute = (doc: Document, owner: object, hash: string): void => {
  const saved = readSearchAssetReturn(doc, owner);
  if (!saved) return;
  if (hash !== saved.returnHash && hash !== `#yours/asset/${encodeURIComponent(saved.assetId)}`)
    forgetListContinuity(doc, keyFor(owner));
};
