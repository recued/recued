/** Real Data route; only its read callers are fixtures. Responses stay pending
 * until the browser test releases them, so latency and ordering are explicit. */
import type { CollectionInstanceRow, CollectionPlatform, CollectionRecord, CollectionSearchGroup, ServerRecipeListEntry } from '@recued/contracts';
import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';
import { bootstrapDataRoute } from '../../src/data/bootstrap-data-route.js';
import { WEBCLIENT_POLISH_STYLES } from '../../src/shell/webclient-polish-styles.js';

type Kind = 'records' | 'recipes' | 'packs' | 'marketplace' | 'instances' | 'list' | 'get';
type Outcome = 'empty' | 'match' | 'error';
const platformParameter = new URLSearchParams(location.search).get('navigation');
const navigationPlatform: CollectionPlatform | null =
  platformParameter === 'mail' || platformParameter === 'calendar' || platformParameter === 'file' ? platformParameter : null;
const instance = (platform: CollectionPlatform, slug: string): CollectionInstanceRow => ({
  platform, slug, adapter_type: 'fixture', auth_state: 'healthy', last_synced_at: null,
  caps: platform === 'calendar'
    ? { read: 'yes', list_calendars: 'yes', create_event: 'no', update_event: 'no', delete_event: 'no', rsvp: 'no', search: 'local', watch: 'none', auth: 'none', recurrence: 'client' }
    : { read: 'yes', write: 'no', delete: 'no', watch: 'none', mirror: 'optional', auth: 'none', path_style: platform === 'file' ? 'posix' : 'uri' },
});
let instances = navigationPlatform === null ? [] : ['work', 'personal'].map(slug => instance(navigationPlatform, slug));
const record = (slug: string, recordId = `${slug}-1`): CollectionRecord => ({
  record_id: recordId, received_at: 1_700_000_000_000, modified_at: 1_700_000_000_000,
  hot_fields: { subject: `${slug} record`, summary: `${slug} record`, path: `${slug}-file.txt` },
  size_bytes: 0, source_id: recordId, body_inline: `Body from ${slug}`,
});
const navigationGroups: CollectionSearchGroup[] = instances.map(source => ({
  platform: source.platform, slug: source.slug, more: true,
  source_freshness: { stale: false, last_success_at: 1_700_000_000_000, age_ms: 0, degraded: false, pending: 0 },
  matches: [{ record_id: `${source.slug}-1`, hot_fields: { subject: `Search ${source.slug}` }, body: 'Source navigation fixture.', rank: -1 }],
}));
const calls: Array<{ kind: Kind; query: string }> = [];
const pending: Array<{ kind: Kind; finish(outcome: Outcome): void }> = [];
const read = <T>(kind: Kind, query: string, result: (match: boolean) => T): Promise<T> => {
  calls.push({ kind, query });
  return new Promise<T>((resolve, reject) => {
    let released = false;
    pending.push({ kind, finish(outcome) {
      if (released) throw new Error('Fixture response was already released.');
      released = true;
      if (outcome === 'error') reject(new Error(`Failed ${kind} for ${query}`));
      else resolve(result(outcome === 'match'));
    } });
  });
};
const query = () => document.querySelector<HTMLInputElement>('[data-recued-universal-search-input]')?.value.trim() ?? '';
const style = document.createElement('style');
style.textContent = `${PRIMITIVE_STYLES}\n${WEBCLIENT_POLISH_STYLES}`;
document.head.appendChild(style);
if (navigationPlatform !== null) {
  // A real Back leaves the pending route. This fixture host disposes it and
  // mounts the production Data controller for the prior Contacts address.
  history.replaceState(null, '', '#data/contact');
  history.pushState(null, '', '#data/search');
}
const mount = (initialTab: string) => bootstrapDataRoute({
  root: document.querySelector<HTMLElement>('#root')!, document, initialTab,
  universalSearchDebounceMs: 180,
  contactListCaller: async () => ({ contacts: [], total: 0 }),
  collectionSearchAllCaller: ({ query }) => navigationPlatform !== null
    ? Promise.resolve({ groups: navigationGroups })
    : read('records', query, match => ({
    groups: match ? [{
      platform: 'mail', slug: 'work', more: false,
      source_freshness: { stale: false, last_success_at: 1_700_000_000_000, age_ms: 0, degraded: false, pending: 0 },
      matches: [{ record_id: `mail:${query}`, hot_fields: { subject: `Record for ${query}` }, body: 'Local fixture record.', rank: -1 }],
    } satisfies CollectionSearchGroup] : [],
  })),
  recipeListCaller: () => {
    if (navigationPlatform !== null) return Promise.resolve({ recipes: [] });
    const q = query();
    return read('recipes', q, match => ({ recipes: match ? [{
      recipe_id: 'fixture-recipe', publisher_id: 'kitchen', version: 1, recipe_hash: 'fixture',
      source: 'pair-sync', installed_at: 1_700_000_000_000,
      recipe: {
        recipe_id: 'fixture-recipe', version: 1, ttl: 300,
        metadata: { name: `Recipe for ${q}`, description: '', author: 'local', supported_platforms: [] },
        variables: {}, output: { render: [] },
      },
    } satisfies ServerRecipeListEntry] : [] }));
  },
  packInstalledListCaller: () => navigationPlatform !== null
    ? Promise.resolve({ packs: [] }) : read('packs', query(), () => ({ packs: [] })),
  marketplacePackSearchCaller: q => read('marketplace', q, match => ({
    packs: match ? [{ slug: `fixture-${q}`, name: `Marketplace for ${q}` }] : [],
  })),
  ...(navigationPlatform === null ? {} : {
    collectionListInstancesCaller: () => read('instances', navigationPlatform, () => ({ instances })),
    collectionListCaller: ({ platform, slug }) => read('list', `${platform}/${slug}`, () => ({ records: [record(slug)] })),
    collectionGetCaller: ({ platform, slug, record_id }) => read('get', `${platform}/${slug}/${record_id}`, () => ({ record: record(slug, record_id) })),
  } satisfies Partial<Parameters<typeof bootstrapDataRoute>[0]>),
});
let route = mount('search');
const controls = {
  ready: false, calls,
  release(kind: Kind, index: number, outcome: Outcome = 'empty') {
    const item = pending.filter(item => item.kind === kind)[index];
    if (!item) throw new Error(`Missing fixture response: ${kind} ${index}`);
    item.finish(outcome);
  },
  removeSource(slug: string) { instances = instances.filter(source => source.slug !== slug); },
  selectTab: (tab: Parameters<typeof route.selectTab>[0]) => route.selectTab(tab),
  dispose: () => route.dispose(),
};
declare global { interface Window { __universalSearch: typeof controls } }
window.__universalSearch = controls;
void route.whenLoaded().then(() => { controls.ready = true; });
if (navigationPlatform !== null) window.addEventListener('popstate', () => {
  route.dispose();
  controls.ready = false;
  route = mount(location.hash.split('/')[1] ?? 'contact');
  void route.whenLoaded().then(() => { controls.ready = true; });
});
