/** Real Data route; only its read callers are fixtures. Responses stay pending
 * until the browser test releases them, so latency and ordering are explicit. */
import type { CollectionInstanceRow, CollectionPlatform, CollectionRecord, CollectionSearchGroup, ContactRecord, ServerRecipeListEntry } from '@recued/contracts';
import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';
import { bootstrapDataRoute } from '../../src/data/bootstrap-data-route.js';
import { WEBCLIENT_POLISH_STYLES } from '../../src/shell/webclient-polish-styles.js';
import { createWorkSearchFixture } from './work-search-fixture.js';

type Kind = 'records' | 'recipes' | 'packs' | 'marketplace' | 'instances' | 'list' | 'get' | 'work' | 'work-page' | 'contacts' | 'contacts-page';
/** `unsupported` answers as a server before the method existed does. */
type Outcome = 'empty' | 'match' | 'error' | 'unsupported';
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
  hot_fields: { subject: `${slug} record`, summary: `${slug} record`, path: `${slug}-file.txt`,
    start_at: Date.parse('2026-10-28T16:00:00Z'), end_at: Date.parse('2026-10-28T17:00:00Z'), is_all_day: false },
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
      else if (outcome === 'unsupported') reject(Object.assign(new Error(`Unknown rpc method: ${kind}`), { code: 'unknown_method' }));
      else resolve(result(outcome === 'match'));
    } });
  });
};
const query = () => document.querySelector<HTMLInputElement>('[data-recued-universal-search-input]')?.value.trim() ?? '';
const nativeMode = new URLSearchParams(location.search).get('native');
const manualContacts = new URLSearchParams(location.search).get('contacts') === 'manual';
const contact = (index: number): ContactRecord => ({
  _id: `person${index}@example.test`, _collection: 'contact',
  email: `person${index}@example.test`, name: `Contact ${index}`, company: 'Northwind',
  first_seen: 1, last_interaction: 1, interaction_count: 0, source: 'manual', created_at: 1, updated_at: 1,
});
const nativeWork = createWorkSearchFixture((kind, query, result) => nativeMode === 'manual'
  ? read(kind, query, () => result())
  : (calls.push({ kind, query }), Promise.resolve(result())));
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
  contactListCaller: args => !manualContacts || !args.query ? Promise.resolve({ contacts: [], total: 0 })
    : read(args.offset ? 'contacts-page' : 'contacts', args.query, match => ({
      contacts: match ? Array.from({ length: Math.max(0, Math.min(args.limit ?? 5, 8 - (args.offset ?? 0))) },
        (_, index) => contact((args.offset ?? 0) + index)) : [], total: match ? 8 : 0,
    })),
  ...(nativeMode ? nativeWork.callers : {}),
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
    collectionListCaller: ({ platform, slug, filters }) => platform === 'calendar' && filters?.is_all_day
      ? Promise.resolve({ records: [] }) : read('list', `${platform}/${slug}`, () => ({ records: [record(slug)] })),
    collectionGetCaller: ({ platform, slug, record_id }) => read('get', `${platform}/${slug}/${record_id}`, () => ({ record: record(slug, record_id) })),
  } satisfies Partial<Parameters<typeof bootstrapDataRoute>[0]>),
});
let route = mount('search');
const controls = {
  ready: false, calls,
  workRequests: nativeWork.requests, workWrites: nativeWork.writes, failWorkKind: nativeWork.fail,
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
