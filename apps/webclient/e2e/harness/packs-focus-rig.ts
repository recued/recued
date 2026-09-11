import type {
  BulkPackInstallResultLike,
  BulkPackManifest,
  BulkPackUninstallResultLike,
  PackListEntry,
  ServerRecipeListEntry,
} from '@recued/contracts';
import { bootstrapPacksRoute } from '../../src/packs/bootstrap-packs-route.js';
import { createBroadcastSubscriber } from '../../src/realtime/subscriber.js';

const PACK_SLUG = 'mail-tools';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
};

const manifest: BulkPackManifest = {
  manifest_version: 1,
  slug: PACK_SLUG,
  publisher: 'recued-core',
  name: 'Mail Tools',
  description: 'Daily mail workflows.',
  version: 1,
  recipes: [{ slug: 'mail-digest', version: 1 }],
  requires: ['install_bulk_pack', 'read_mail'],
  tags: ['mail', 'workflow'],
  service_kind: 'workflow',
};

const pack: PackListEntry = {
  slug: manifest.slug,
  publisher: manifest.publisher,
  name: manifest.name,
  description: manifest.description,
  version: manifest.version,
  pre_install: false,
  installed: true,
  installed_any_version: true,
  requires: [...manifest.requires],
  recipe_count: manifest.recipes.length,
  recipe_refs: manifest.recipes.map(({ slug, version }) => ({ slug, version })),
  body_visibility_grant_count: 0,
  body_visibility_grant_keys: [],
  manifest,
};

const root = document.querySelector<HTMLElement>('#root');
if (root === null) throw new Error('Packs focus rig needs a root.');
const subscriber = createBroadcastSubscriber();
const recipes = deferred<{ recipes: ReadonlyArray<ServerRecipeListEntry> }>();
const install = deferred<{ result: BulkPackInstallResultLike }>();
const uninstall = deferred<{ result: BulkPackUninstallResultLike }>();
let installed = true;
let installCalls = 0;
let uninstallCalls = 0;

const mountRoute = (initialPackSlug?: string) => bootstrapPacksRoute({
  root,
  document,
  packsListCaller: async () => ({
    packs: [{ ...pack, installed, installed_any_version: installed }],
    installed_versions: installed
      ? [{ slug: pack.slug, version: pack.version }]
      : [],
  }),
  packsInstallCaller: () => {
    installCalls += 1;
    return install.promise;
  },
  packsUninstallCaller: () => {
    uninstallCalls += 1;
    return uninstall.promise;
  },
  recipesListCaller: () => recipes.promise,
  subscribe: subscriber.on,
  ...(initialPackSlug === undefined ? {} : { initialPackSlug }),
});

export interface PacksFocusRig {
  finishRecipes(): void;
  finishInstall(): void;
  failInstall(): void;
  getInstallCalls(): number;
  finishUninstall(): void;
  failUninstall(): void;
  getUninstallCalls(): number;
  showUninstalled(): void;
  firePackChanged(): void;
  remountDeepLink(): void;
}

declare global {
  var __packsFocusRig: PacksFocusRig;
}

let route = mountRoute();
globalThis.__packsFocusRig = {
  finishRecipes: () => recipes.resolve({ recipes: [] }),
  finishInstall: () => {
    installed = true;
    install.resolve({ result: { ok: true, installed: [], rolled_back: [] } });
  },
  failInstall: () => install.resolve({
    result: {
      ok: false,
      installed: [],
      rolled_back: [],
      failure: { code: 'permission_denied', message: 'Permission missing.' },
    },
  }),
  getInstallCalls: () => installCalls,
  finishUninstall: () => {
    installed = false;
    uninstall.resolve({ result: { ok: true, removed: { recipes: [], body_grants: [] } } });
  },
  failUninstall: () => uninstall.resolve({
    result: {
      ok: false,
      removed: { recipes: [], body_grants: [] },
      failure: { code: 'not_found', message: 'Pack disappeared.' },
    },
  }),
  getUninstallCalls: () => uninstallCalls,
  showUninstalled: () => {
    installed = false;
    subscriber.dispatch({ kind: 'pack_uninstalled' });
  },
  firePackChanged: () => subscriber.dispatch({ kind: 'pack_installed' }),
  remountDeepLink: () => {
    route.dispose();
    route = mountRoute(PACK_SLUG);
  },
};
