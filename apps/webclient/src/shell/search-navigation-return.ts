export interface SearchNavigationReturn<State> {
  destinationHash: string;
  destinationAliases?: readonly string[];
  returnHash: string;
  state: State;
  focus: { action: string; attribute: string; id: string };
  scrollTop: number;
}
const visits = new WeakMap<Document, WeakMap<object, SearchNavigationReturn<unknown>>>();
export const saveSearchNavigationReturn = <State>(doc: Document, owner: object, value: SearchNavigationReturn<State>): void => {
  let owners = visits.get(doc);
  if (!owners) { owners = new WeakMap(); visits.set(doc, owners); }
  owners.set(owner, value);
};
export const readSearchNavigationReturn = <State>(doc: Document, owner: object): SearchNavigationReturn<State> | undefined =>
  visits.get(doc)?.get(owner) as SearchNavigationReturn<State> | undefined;
export const clearSearchNavigationReturn = (doc: Document, owner: object): void => { visits.get(doc)?.delete(owner); };

/** Only the originating search and addressed result share this transient
 * snapshot. Following another route retires it, including on the same server. */
export const trackSearchNavigationRoute = (doc: Document, owner: object, hash: string): void => {
  const saved = readSearchNavigationReturn(doc, owner);
  if (saved && hash !== saved.returnHash && hash !== saved.destinationHash && !saved.destinationAliases?.includes(hash)) visits.get(doc)?.delete(owner);
};
