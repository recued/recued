/** D-320 slice 2b — `packs.connections.*`: a pack's connections per slot, behind
 *  the Access page's Connections block (D-320 §4).
 *
 *  - A slot is the connection name the pack's catalog declares (`http.connection`).
 *  - The pack's LIST for a slot is the connections its catalog is bound to
 *    (`connection_catalog_binding`). The binding is what lets the gateway serve
 *    the pack's operations on a connection; grants have not gated since 2026-08-07,
 *    but the pack's grants follow its list so they read the same.
 *  - One connection on a slot's list is the slot's default: the stored one
 *    (`pack_connection_default`), or the only one on the list.
 *
 *  Owner-only by the `packs.` prefix, which MCP reserves (`MCP_RESERVED_RPC_PREFIXES`):
 *  a door's agent cannot move a pack to another connection. */

import {
  RpcError,
  catalogSlugForVendor,
  connectionViewFromRow,
  getVendorProvider,
  endpointHost,
  findEndpointCandidates,
  type BulkPackManifest,
  type ConnectionAuthType,
  type ConnectionRow,
  type ConnectionView,
  type DishWebhookDoorChange,
  type HandlerSlice,
  type IngredientManifest,
  type RecipeDefinition,
  type RpcRequest,
  type RpcResponse,
  type ServerRpcRegistry,
} from '@recued/contracts';

import { resolveBundledPackManifest } from './bundled-pack-source.js';
import { decodeAuthFromStorage, type ConnectionRpcDeps } from './connection-handler.js';
import type { PackInstallRpcDeps } from './pack-install-handler.js';
import { getInstalledPack, listInstalledPacks, packIngredientIds } from './pack-inventory.js';
import { createConnectionCatalogBindingStore } from './storage/connection-catalog-binding-store.js';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';
import { createContractScanFn, type ContractStore } from './storage/contract-store.js';
import { createPackConnectionDefaultStore } from './storage/pack-connection-default-store.js';
import { createPackConnectionHolderStore } from './storage/pack-connection-holder-store.js';
import { addConnectionToPackList, syncBorrowersOf } from './pack-connection-borrowing.js';
import { effectiveSlotDefault, removalOutcome } from './pack-connection-outcomes.js';
import { authoredSlotOf, slotOfCatalog } from './pack-connection-slots.js';
import { recipeConnectionSlots, recipeRemovalEffects } from './recipe-connection-choices.js';
import { notOnList, unknownSlot } from './run-connection-choice.js';
import type { DishHandlerDeps } from './dish-handler.js';
import type { WsClient } from './ws-server.js';
import { createPackAccessHandler } from './pack-access-handler.js';

/** The wire shapes, read off the registry (`packages/contracts/src/pack-connections.ts`). */
type PackConnectionsView = RpcResponse<ServerRpcRegistry, 'packs.connections.list'>;
type PackConnectionSlot = PackConnectionsView['slots'][number];
type PackConnectionCandidate = PackConnectionSlot['candidates'][number];
type PackConnectionChange = RpcRequest<ServerRpcRegistry, 'packs.connections.add'>;
type ConnectionRemovalView = RpcResponse<ServerRpcRegistry, 'packs.connections.removal'>;
type ConnectionRemovalArgs = RpcRequest<ServerRpcRegistry, 'packs.connections.removal'>;
type PackSignInsView = RpcResponse<ServerRpcRegistry, 'packs.connections.signins'>;
type PackSignInCell = PackSignInsView['signins'][number]['rows'][number]['cells'][string];
type PackConnectionAddMany = RpcRequest<ServerRpcRegistry, 'packs.connections.add_many'>;

export interface PackConnectionsDeps {
  /** D-322 §24 — isolated diagnostics on this pack's actual connection list. */
  access?: (args: unknown) => Promise<import('@recued/contracts').PackAccessResponse>;
  contractStore: ContractStore;
  connectionStore: Pick<ConnectionStoreSqlite, 'list'>;
  /** Catalog manifests, from the live registry. */
  getManifest: (slug: string) => IngredientManifest | null | undefined;
  /** The pack's own manifest: its connection requirement (which connections could
   *  join) and, for a binding written before slice 2b, its slot. */
  resolvePackManifest?: (pack_slug: string) => BulkPackManifest | null;
  /** Re-derive a connection's operation profile once its bindings change. */
  reconcileConnectionProfile?: (connection_name: string) => void;
  /** Recipes may now run, or stop running: recompute and broadcast. */
  onChanged?: () => void;
  /** D-320 phase 3 (3b) — a webhook door follows its pack's list and default, as
   *  its run does: re-derive every webhook recipe's door after a change, and say
   *  what moved. Absent ⇒ no webhook doors on this server. */
  webhookDoors?: () => readonly DishWebhookDoorChange[];
  /** D-320 §3.4 — a recipe by id, for `packs.connections.recipe`. Absent ⇒ that
   *  rpc answers `not_found`. */
  getRecipe?: (recipe_id: string) => RecipeDefinition | null;
  /** D-320 audit — the installed recipes, for `packs.connections.removal`'s answer per
   *  recipe whose sign-in spans two or more packs' lists. Absent ⇒ none is answered. */
  listRecipes?: () => readonly RecipeDefinition[];
  /** A connection's auth type, which only its decrypted auth carries. The
   *  requirement match (`findEndpointCandidates`) needs it and fails closed
   *  without it, as `collection.connection.list` does. */
  authTypeOf?: (row: ConnectionRow) => Promise<ConnectionAuthType | undefined>;
  /** D-320 ruling 20 — the connections' operation profiles and the installed
   *  compositions, by which a run picks a connection for a vendor-neutral step:
   *  `packs.connections.recipe` lists each family with them (and so a dish may
   *  choose one). Absent ⇒ no family is listed. */
  operationProfiles?: import('./recipe-connection-choices.js').RecipeConnectionChoicesDeps['profiles'];
  localManifestStore?: import('./recipe-connection-choices.js').RecipeConnectionChoicesDeps['localManifestStore'];
}

const GRANT_SCOPE = 'grant';

/** The owner's connections that could join a slot: set up, an API connection the
 *  pack's requirement accepts (`findEndpointCandidates`, as the install dialog
 *  offers them), not already listed. A pack whose manifest is not at hand offers
 *  the connections at the same API host as the ones already listed. */
const candidatesFor = (
  manifest: BulkPackManifest | null,
  views: readonly ConnectionView[],
  listed: readonly string[],
): PackConnectionCandidate[] => {
  const requirement = manifest?.connection_requirements?.[0];
  const found = requirement !== undefined
    ? findEndpointCandidates(requirement, views).map((c) => ({ name: c.name, display_name: c.display_name }))
    : (() => {
        const hosts = new Set(
          listed
            .map((name) => endpointHost(views.find((v) => v.name === name)?.base_url))
            .filter((host): host is string => host !== null),
        );
        return views
          .filter((v) => hosts.has(endpointHost(v.base_url) ?? ''))
          .map((v) => ({ name: v.name, display_name: v.display_name }));
      })();
  return found
    .filter((c) => !listed.includes(c.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({ connection_name: c.name, display_name: c.display_name }));
};

/** The api connections' views, with each one's auth type as the list rpc reads it. */
const apiViews = async (
  deps: PackConnectionsDeps,
  rows: readonly ConnectionRow[],
): Promise<ConnectionView[]> =>
  Promise.all(rows.filter((row) => row.kind === 'api').map(async (row) => {
    const view = connectionViewFromRow(row);
    const authType = await deps.authTypeOf?.(row);
    return authType === undefined ? view : { ...view, auth_type: authType };
  }));

/** A pack's catalogs that a connection serves, from its inventory. */
const connectionCatalogsOf = (deps: PackConnectionsDeps, pack_slug: string): string[] =>
  packIngredientIds(deps.contractStore, pack_slug)
    .filter((id) => deps.getManifest(id)?.surfaces?.api !== undefined);

/** A connection's alias: its api row's Display Name, else any row's, else its name. */
const displayNameOf = (rows: readonly ConnectionRow[], name: string): string =>
  (rows.find((r) => r.name === name && r.kind === 'api') ?? rows.find((r) => r.name === name))
    ?.display_name || name;

/** A pack's manifest and its name (its slug when the manifest is not at hand),
 *  each read once per call: one read over many packs resolves each once. */
const packManifests = (deps: PackConnectionsDeps) => {
  const manifests = new Map<string, BulkPackManifest | null>();
  const manifestOf = (pack_slug: string): BulkPackManifest | null => {
    if (!manifests.has(pack_slug)) manifests.set(pack_slug, deps.resolvePackManifest?.(pack_slug) ?? null);
    return manifests.get(pack_slug)!;
  };
  const nameOf = (pack_slug: string): string => {
    const name = manifestOf(pack_slug)?.name;
    return typeof name === 'string' && name.trim().length > 0 ? name : pack_slug;
  };
  return { manifestOf, nameOf };
};

/** What one read needs once: the connection rows and their views, the bindings,
 *  the holders, and the manifests it resolves. */
interface ViewContext extends ReturnType<typeof packManifests> {
  rows: ConnectionRow[];
  enrolled: Set<string>;
  scan: ReturnType<typeof createContractScanFn>;
  all: ReturnType<ReturnType<typeof createConnectionCatalogBindingStore>['list']>;
  views: ConnectionView[];
  holders: ReturnType<typeof createPackConnectionHolderStore>;
}

const viewContext = async (deps: PackConnectionsDeps): Promise<ViewContext> => {
  const rows = deps.connectionStore.list();
  return {
    ...packManifests(deps),
    rows,
    enrolled: new Set(rows.map((r) => r.name)),
    scan: createContractScanFn(deps.contractStore),
    all: createConnectionCatalogBindingStore(deps.contractStore).list(),
    views: await apiViews(deps, rows),
    holders: createPackConnectionHolderStore(deps.contractStore),
  };
};

/** The vendor a pack's connection requirement names. */
const requirementVendor = (manifest: BulkPackManifest | null): string | undefined => {
  const vendor = manifest?.connection_requirements?.[0]?.vendor;
  return typeof vendor === 'string' && vendor.length > 0 ? vendor : undefined;
};

/** A pack's catalogs grouped by slot: the binding's recorded slot, else the one
 *  its manifest authors (`slotOfCatalog`). */
const catalogsBySlot = (
  catalogs: readonly string[],
  mine: Parameters<typeof slotOfCatalog>[1],
  manifest: BulkPackManifest | null,
): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  for (const catalog of catalogs) {
    const slot = slotOfCatalog(catalog, mine, manifest);
    out.set(slot, [...(out.get(slot) ?? []), catalog]);
  }
  return out;
};

/** The pack's connections per slot, as the Access page shows them. A pack that
 *  signs in through another's (D-320 ruling 9) shows its holder's, marked
 *  `held_by`. */
export const packConnectionsView = async (
  deps: PackConnectionsDeps,
  pack_slug: string,
): Promise<PackConnectionsView> => {
  const ctx = await viewContext(deps);
  const holder = ctx.holders.get(pack_slug);
  if (holder === undefined || holder.holder_pack_id === pack_slug) return ownView(deps, ctx, pack_slug);
  const catalogs = connectionCatalogsOf(deps, pack_slug);
  const holderView = ownView(deps, ctx, holder.holder_pack_id);
  const held = holderView.slots.find((s) => holder.slot === undefined || s.slot === holder.slot)
    ?? holderView.slots[0];
  if (held === undefined || catalogs.length === 0) return { pack_slug, slots: [] };
  return {
    pack_slug,
    slots: [{
      slot: held.slot,
      catalogs,
      connections: held.connections,
      candidates: [],
      held_by: holder.holder_pack_id,
      held_by_name: ctx.nameOf(holder.holder_pack_id),
      ...(held.vendor !== undefined ? { vendor: held.vendor } : {}),
    }],
  };
};

/** A pack's own list per slot (it holds its connections). */
const ownView = (
  deps: PackConnectionsDeps,
  ctx: ViewContext,
  pack_slug: string,
): PackConnectionsView => {
  const { all, rows, enrolled, scan, views } = ctx;
  const manifest = ctx.manifestOf(pack_slug);
  const vendor = requirementVendor(manifest);
  // The pack's own catalogs: the ones it installed that a connection can serve.
  const catalogs = connectionCatalogsOf(deps, pack_slug);
  const borrowers = ctx.holders.borrowersOf(pack_slug);
  const mine = all.filter((b) => b.installed_pack_id === pack_slug && catalogs.includes(b.catalog_slug));
  const slots: PackConnectionSlot[] = [...catalogsBySlot(catalogs, mine, manifest)].map(([slot, ofSlot]) => {
    const listed = [...new Set(mine.filter((b) => ofSlot.includes(b.catalog_slug)).map((b) => b.connection_name))];
    // D-320 slice 2g — the connection a run that names none uses, by the run's own
    // rule. A deleted connection is never it, though the pack stays bound to it;
    // reading the stored row instead showed a deleted default, or "no default"
    // while every run went to the connection left.
    const theDefault = effectiveSlotDefault(scan, ofSlot, all.filter((b) => ofSlot.includes(b.catalog_slug)), enrolled);
    return {
      slot,
      catalogs: ofSlot,
      connections: listed.map((name) => ({
        connection_name: name,
        display_name: displayNameOf(rows, name),
        enrolled: enrolled.has(name),
        is_default: name === theDefault,
      })),
      candidates: candidatesFor(manifest, views, listed),
      ...(borrowers.length > 0 ? { shared_with: borrowers, shared_with_names: borrowers.map(ctx.nameOf) } : {}),
      ...(vendor !== undefined ? { vendor } : {}),
    };
  });
  return { pack_slug, slots };
};

/** What to call a sign-in: its vendor's display name; else the vendor as its
 *  packs' own names write it (`paypal` in "Checkout Orders - PayPal" is
 *  "PayPal", `azure-devops` in "Azure DevOps Build" is "Azure DevOps"); else the
 *  vendor, else the slot. Found by a visual pass: the grid read "paypal · 3
 *  connections" beside "HubSpot · 2 connections". */
export const signInLabel = (vendor: string | undefined, slot: string, packNames: readonly string[]): string => {
  if (vendor === undefined) return slot;
  const provider = getVendorProvider(vendor)?.display_name;
  if (provider !== undefined && provider.length > 0) return provider;
  const letters = [...vendor.replace(/[^a-z0-9]/gi, '')];
  if (letters.length > 0) {
    // The vendor's letters, one separator allowed between any two of them.
    const pattern = new RegExp(`\\b${letters.join('[\\s._-]?')}\\b`, 'i');
    for (const name of packNames) {
      const found = pattern.exec(name)?.[0];
      if (found !== undefined) return found;
    }
  }
  return vendor;
};

/** D-320 slice 2h (ruling 16) — `packs.connections.signins`: each sign-in the
 *  installed packs hold a list for, as the Connections page's grid draws it. A
 *  row per pack holding its own list; a pack signing in through another's is
 *  listed under its holder's row (ruling 9). The columns are the owner's set-up
 *  connections on some row's list or able to join one. */
export const packSignInsView = async (deps: PackConnectionsDeps): Promise<PackSignInsView> => {
  const ctx = await viewContext(deps);
  const groups = new Map<string, {
    vendor?: string;
    connections: Map<string, string>;
    rows: Array<{
      pack_slug: string;
      listed: string[];
      candidates: string[];
      theDefault?: string;
    }>;
  }>();
  for (const { pack_slug } of listInstalledPacks(deps.contractStore)) {
    const holder = ctx.holders.get(pack_slug)?.holder_pack_id;
    if (holder !== undefined && holder !== pack_slug) continue;
    for (const slot of ownView(deps, ctx, pack_slug).slots) {
      const group = groups.get(slot.slot) ?? { connections: new Map<string, string>(), rows: [] };
      if (group.vendor === undefined && slot.vendor !== undefined) group.vendor = slot.vendor;
      const listed = slot.connections.filter((c) => c.enrolled);
      for (const c of [...listed, ...slot.candidates]) group.connections.set(c.connection_name, c.display_name);
      group.rows.push({
        pack_slug,
        listed: listed.map((c) => c.connection_name),
        candidates: slot.candidates.map((c) => c.connection_name),
        ...(listed.some((c) => c.is_default)
          ? { theDefault: listed.find((c) => c.is_default)!.connection_name }
          : {}),
      });
      groups.set(slot.slot, group);
    }
  }
  const signins = [...groups].map(([slot, group]) => {
    const connections = [...group.connections]
      .map(([connection_name, display_name]) => ({ connection_name, display_name }))
      .sort((a, b) => a.display_name.localeCompare(b.display_name) || a.connection_name.localeCompare(b.connection_name));
    const cellOf = (row: (typeof group.rows)[number], name: string): PackSignInCell =>
      row.theDefault === name ? 'default'
        : row.listed.includes(name) ? 'listed'
          : row.candidates.includes(name) ? 'available'
            : 'unavailable';
    const rows = group.rows
      .map((row) => ({
        pack_slug: row.pack_slug,
        pack_name: ctx.nameOf(row.pack_slug),
        members: ctx.holders.borrowersOf(row.pack_slug)
          .map((member) => ({ pack_slug: member, pack_name: ctx.nameOf(member) })),
        cells: Object.fromEntries(connections.map((a) => [a.connection_name, cellOf(row, a.connection_name)])),
        ...(row.theDefault !== undefined ? { default: row.theDefault } : {}),
      }))
      .sort((a, b) => a.pack_name.localeCompare(b.pack_name));
    const label = signInLabel(group.vendor, slot, rows.map((row) => row.pack_name));
    return { slot, label, ...(group.vendor !== undefined ? { vendor: group.vendor } : {}), connections, rows };
  }).sort((a, b) => a.label.localeCompare(b.label) || a.slot.localeCompare(b.slot));
  return { signins };
};

/** D-320 slice 2j (ruling 16) — the connections a pack being installed shares with
 *  its sign-in: on the list of EVERY other installed pack holding a list for the
 *  same sign-in (one at least), set up, and accepted by the pack's connection
 *  requirement (as the install dialog's candidates are). So an owner who put a
 *  second connection on all their HubSpot packs gets it on the next one too, and
 *  one who kept it off any of them does not. A pack signing in through an
 *  installed holder (`from_pack`) shares nothing of its own: it follows the
 *  holder's list. The install dialog offers them ticked (`shared_connections`). */
export const sharedSignInConnections = async (
  deps: PackConnectionsDeps,
  manifest: BulkPackManifest,
): Promise<Array<{ connection_name: string; display_name: string }>> => {
  const requirement = manifest.connection_requirements?.[0];
  if (requirement === undefined) return [];
  if (requirement.from_pack !== undefined && getInstalledPack(deps.contractStore, requirement.from_pack) !== null) {
    return [];
  }
  const slots = new Set(
    (manifest.contents ?? [])
      .flatMap((content) => (content.type === 'composition' ? [authoredSlotOf(manifest, content.composition.slug)] : []))
      .filter((slot): slot is string => slot !== undefined),
  );
  if (slots.size === 0) return [];
  const ctx = await viewContext(deps);
  // Each other pack's list for the sign-in; what is on all of them is shared.
  const lists: Array<Set<string>> = [];
  for (const { pack_slug } of listInstalledPacks(deps.contractStore)) {
    if (pack_slug === manifest.slug) continue;
    const holder = ctx.holders.get(pack_slug)?.holder_pack_id;
    if (holder !== undefined && holder !== pack_slug) continue;
    for (const slot of ownView(deps, ctx, pack_slug).slots) {
      if (!slots.has(slot.slot)) continue;
      lists.push(new Set(slot.connections.filter((c) => c.enrolled).map((c) => c.connection_name)));
    }
  }
  if (lists.length === 0) return [];
  const shared = [...lists[0]!].filter((name) => lists.every((list) => list.has(name)));
  if (shared.length === 0) return [];
  const accepted = new Set(findEndpointCandidates(requirement, ctx.views).map((c) => c.name));
  return shared
    .filter((name) => accepted.has(name))
    .map((name) => ({ connection_name: name, display_name: displayNameOf(ctx.rows, name) }))
    .sort((a, b) => a.display_name.localeCompare(b.display_name) || a.connection_name.localeCompare(b.connection_name));
};

/** A borrowing pack's list is its holder's: changes go there. */
const requireOwnList = (deps: PackConnectionsDeps, method: string, pack_slug: string): void => {
  const holder = createPackConnectionHolderStore(deps.contractStore).get(pack_slug);
  if (holder !== undefined && holder.holder_pack_id !== pack_slug) {
    throw new RpcError(
      'bad_request',
      `${method}: '${pack_slug}' signs in through '${holder.holder_pack_id}''s connections; change them on '${holder.holder_pack_id}'`,
    );
  }
};

/** Re-derive the profiles of the connections a change touched, then announce it. */
const afterListChange = (deps: PackConnectionsDeps, connections: Iterable<string>): void => {
  for (const name of new Set(connections)) deps.reconcileConnectionProfile?.(name);
  deps.onChanged?.();
};

const requireString = (method: string, field: string, value: unknown): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RpcError('bad_request', `${method}: ${field} must be a non-empty string`);
  }
  return value;
};

const parseChange = (method: string, args: unknown): PackConnectionChange => {
  if (args === null || typeof args !== 'object') {
    throw new RpcError('bad_request', `${method}: args must be an object`);
  }
  const a = args as Record<string, unknown>;
  return {
    pack_slug: requireString(method, 'pack_slug', a.pack_slug),
    slot: requireString(method, 'slot', a.slot),
    connection_name: requireString(method, 'connection_name', a.connection_name),
  };
};

const requireSlot = (method: string, view: PackConnectionsView, slot: string): PackConnectionSlot => {
  const found = view.slots.find((s) => s.slot === slot);
  if (found === undefined) {
    throw new RpcError('bad_request', `${method}: pack '${view.pack_slug}' signs in to no '${slot}'`);
  }
  return found;
};

/** A catalog the connection already serves for ANOTHER pack (two packs sharing
 *  one catalog) cannot be put on this pack's list too: its row is that pack's. */
const refuseHeldElsewhere = (
  method: string,
  all: ReadonlyArray<{ connection_name: string; catalog_slug: string; installed_pack_id: string }>,
  change: PackConnectionChange,
  catalogs: readonly string[],
): void => {
  const heldElsewhere = all.find((b) =>
    b.connection_name === change.connection_name
    && catalogs.includes(b.catalog_slug)
    && b.installed_pack_id !== change.pack_slug);
  if (heldElsewhere !== undefined) {
    throw new RpcError(
      'bad_request',
      `${method}: '${change.connection_name}' already serves '${heldElsewhere.catalog_slug}' for pack '${heldElsewhere.installed_pack_id}'`,
    );
  }
};

/** "Add another". */
export const addPackConnection = async (deps: PackConnectionsDeps, args: unknown): Promise<PackConnectionsView> => {
  const method = 'packs.connections.add';
  const change = parseChange(method, args);
  requireOwnList(deps, method, change.pack_slug);
  const view = await packConnectionsView(deps, change.pack_slug);
  const slot = requireSlot(method, view, change.slot);
  if (slot.connections.some((c) => c.connection_name === change.connection_name)) return view;
  if (!slot.candidates.some((c) => c.connection_name === change.connection_name)) {
    throw new RpcError(
      'bad_request',
      `${method}: '${change.connection_name}' is not a connection this pack can use for '${change.slot}'`,
    );
  }
  refuseHeldElsewhere(method, createConnectionCatalogBindingStore(deps.contractStore).list(), change, slot.catalogs);
  const touched = new Set<string>([change.connection_name]);
  const setUp = new Set(deps.connectionStore.list().map((row) => row.name));
  deps.contractStore.transaction(() => {
    // Bound, its grants mirrored, and the one set-up connection stored as the
    // default when none was, so runs that used it keep using it.
    addConnectionToPackList(
      deps.contractStore,
      change.pack_slug,
      slot.catalogs,
      change.slot,
      change.connection_name,
      (name) => setUp.has(name),
    );
    // The packs that sign in through this one follow its list.
    for (const name of syncBorrowersOf(deps.contractStore, change.pack_slug, (p) => connectionCatalogsOf(deps, p))) {
      touched.add(name);
    }
  });
  afterListChange(deps, touched);
  return packConnectionsView(deps, change.pack_slug);
};

const parseAddMany = (method: string, args: unknown): PackConnectionAddMany => {
  if (args === null || typeof args !== 'object') {
    throw new RpcError('bad_request', `${method}: args must be an object`);
  }
  const a = args as Record<string, unknown>;
  const connection_name = requireString(method, 'connection_name', a.connection_name);
  if (!Array.isArray(a.targets) || a.targets.length === 0) {
    throw new RpcError('bad_request', `${method}: targets must name at least one pack`);
  }
  const seen = new Set<string>();
  const targets: PackConnectionAddMany['targets'] = [];
  for (const raw of a.targets as unknown[]) {
    const target = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const pack_slug = requireString(method, 'targets[].pack_slug', target.pack_slug);
    const slot = requireString(method, 'targets[].slot', target.slot);
    if (seen.has(`${pack_slug}::${slot}`)) continue;
    seen.add(`${pack_slug}::${slot}`);
    targets.push({ pack_slug, slot });
  }
  if (a.make_default !== undefined && typeof a.make_default !== 'boolean') {
    throw new RpcError('bad_request', `${method}: make_default must be a boolean`);
  }
  return { connection_name, targets, ...(a.make_default === true ? { make_default: true } : {}) };
};

/** D-320 slice 2h (ruling 16) — `packs.connections.add_many`: "Use with all",
 *  and a new connection's "Which packs may use it?". Every target is checked as
 *  "Add another" checks it before anything is written; then all are added in
 *  one transaction, or none. With `make_default`, the connection also becomes each
 *  target's default. */
export const addConnectionToPacks = async (deps: PackConnectionsDeps, args: unknown): Promise<PackSignInsView> => {
  const method = 'packs.connections.add_many';
  const request = parseAddMany(method, args);
  const ctx = await viewContext(deps);
  const plan: Array<{ pack_slug: string; slot: string; catalogs: string[]; add: boolean }> = [];
  for (const target of request.targets) {
    requireOwnList(deps, method, target.pack_slug);
    const slot = requireSlot(method, ownView(deps, ctx, target.pack_slug), target.slot);
    const listed = slot.connections.some((c) => c.connection_name === request.connection_name);
    if (!listed) {
      if (!slot.candidates.some((c) => c.connection_name === request.connection_name)) {
        throw new RpcError(
          'bad_request',
          `${method}: '${request.connection_name}' is not a connection pack '${target.pack_slug}' can use for '${target.slot}'`,
        );
      }
      refuseHeldElsewhere(method, ctx.all, { ...target, connection_name: request.connection_name }, slot.catalogs);
    }
    plan.push({ ...target, catalogs: slot.catalogs, add: !listed });
  }
  const touched = new Set<string>([request.connection_name]);
  const defaults = createPackConnectionDefaultStore(deps.contractStore);
  deps.contractStore.transaction(() => {
    for (const step of plan) {
      if (step.add) {
        addConnectionToPackList(
          deps.contractStore,
          step.pack_slug,
          step.catalogs,
          step.slot,
          request.connection_name,
          (name) => ctx.enrolled.has(name),
        );
      }
      if (request.make_default === true) defaults.set(step.pack_slug, step.slot, request.connection_name);
      for (const name of syncBorrowersOf(deps.contractStore, step.pack_slug, (p) => connectionCatalogsOf(deps, p))) {
        touched.add(name);
      }
    }
  });
  afterListChange(deps, touched);
  return packSignInsView(deps);
};

/** "Remove". */
export const removePackConnection = async (deps: PackConnectionsDeps, args: unknown): Promise<PackConnectionsView> => {
  const method = 'packs.connections.remove';
  const change = parseChange(method, args);
  requireOwnList(deps, method, change.pack_slug);
  const view = await packConnectionsView(deps, change.pack_slug);
  const slot = requireSlot(method, view, change.slot);
  if (!slot.connections.some((c) => c.connection_name === change.connection_name)) return view;
  const bindings = createConnectionCatalogBindingStore(deps.contractStore);
  const defaults = createPackConnectionDefaultStore(deps.contractStore);
  const touched = new Set<string>([change.connection_name]);
  deps.contractStore.transaction(() => {
    for (const catalog of slot.catalogs) {
      bindings.unbind(change.connection_name, catalog);
      deps.contractStore.deleteByPrefix(GRANT_SCOPE, [change.pack_slug, catalog, change.connection_name]);
    }
    // Not replaced (spec §7): one left is the default by itself; with two or more
    // the slot has none until the owner picks, so no run moves connection unasked.
    if (defaults.get(change.pack_slug, change.slot) === change.connection_name) {
      defaults.clear(change.pack_slug, change.slot);
    }
    for (const name of syncBorrowersOf(deps.contractStore, change.pack_slug, (p) => connectionCatalogsOf(deps, p))) {
      touched.add(name);
    }
  });
  afterListChange(deps, touched);
  return packConnectionsView(deps, change.pack_slug);
};

/** "Make default". */
export const setPackConnectionDefault = async (deps: PackConnectionsDeps, args: unknown): Promise<PackConnectionsView> => {
  const method = 'packs.connections.set_default';
  const change = parseChange(method, args);
  requireOwnList(deps, method, change.pack_slug);
  const view = await packConnectionsView(deps, change.pack_slug);
  const slot = requireSlot(method, view, change.slot);
  if (!slot.connections.some((c) => c.connection_name === change.connection_name)) {
    throw new RpcError(
      'bad_request',
      `${method}: '${change.connection_name}' is not on pack '${change.pack_slug}'s list for '${change.slot}'`,
    );
  }
  createPackConnectionDefaultStore(deps.contractStore)
    .set(change.pack_slug, change.slot, change.connection_name);
  deps.onChanged?.();
  return packConnectionsView(deps, change.pack_slug);
};

/** D-320 slice 2g (ruling 16) — `packs.connections.removal`: what taking
 *  `connection_name` off packs' lists, or deleting it, does to their runs that
 *  name no connection. Every pack holding it on its list, one per family (a pack
 *  signing in through another's follows its holder, so the holder answers for
 *  it), or only `pack_slug`'s. By the run's own rule (`removalOutcome`). */
export const connectionRemovalView = (
  deps: PackConnectionsDeps,
  args: ConnectionRemovalArgs,
): ConnectionRemovalView => {
  const connection = args.connection_name;
  const rows = deps.connectionStore.list();
  const enrolled = new Set(rows.map((row) => row.name));
  const deleting = args.delete_kind !== undefined;
  // Deleting one row leaves the name set up when a row of another kind has it,
  // and then the packs keep it: nothing changes.
  const sharedByAnotherKind = rows.some((row) => row.name === connection && row.kind !== args.delete_kind);
  // ⛔ Except the API row, for a slot whose catalogs are HTTP: only an API
  // connection serves them, and its stored default goes with it
  // (`wirePackConnectionDefaultCleanup`). An MCP row of the same name kept the
  // answer at "unchanged" while every run failed on the deleted connection.
  const leavesSlot = (catalogs: readonly string[]): boolean =>
    !deleting
    || !sharedByAnotherKind
    || (args.delete_kind === 'api'
      && catalogs.every((catalog) => deps.getManifest(catalog)?.surfaces?.api?.transport !== 'mcp'));
  // The catalog each set-up api connection serves by its registered vendor, on
  // no list (`CATALOG_VENDOR_SLUGS`).
  const vendorCatalog = new Map<string, string>();
  for (const row of rows) {
    if (row.kind !== 'api') continue;
    const slug = catalogSlugForVendor((connectionViewFromRow(row) as { vendor?: unknown }).vendor as string | undefined);
    if (slug !== undefined) vendorCatalog.set(row.name, slug);
  }
  const scan = createContractScanFn(deps.contractStore);
  const all = createConnectionCatalogBindingStore(deps.contractStore).list();
  const holders = createPackConnectionHolderStore(deps.contractStore);
  const deciderOf = (pack: string): string => {
    const holder = holders.get(pack)?.holder_pack_id;
    return holder !== undefined && holder !== pack ? holder : pack;
  };
  const deciders = args.pack_slug !== undefined
    ? [deciderOf(args.pack_slug)]
    : [...new Set(all.filter((b) => b.connection_name === connection).map((b) => deciderOf(b.installed_pack_id)))].sort();
  const ref = (name: string) => ({ connection_name: name, display_name: displayNameOf(rows, name) });
  const { manifestOf, nameOf } = packManifests(deps);
  const packs: ConnectionRemovalView['packs'] = [];
  for (const pack of deciders) {
    const catalogs = connectionCatalogsOf(deps, pack);
    const mine = all.filter((b) => b.installed_pack_id === pack && catalogs.includes(b.catalog_slug));
    const manifest = manifestOf(pack);
    for (const [slot, ofSlot] of catalogsBySlot(catalogs, mine, manifest)) {
      if (!mine.some((b) => b.connection_name === connection && ofSlot.includes(b.catalog_slug))) continue;
      const bindings = all.filter((b) => ofSlot.includes(b.catalog_slug));
      const result = leavesSlot(ofSlot)
        ? removalOutcome({
            scan,
            catalogs: ofSlot,
            bindings,
            enrolled,
            connection,
            staysSetUp: !deleting,
            servesByVendor: (name) => ofSlot.includes(vendorCatalog.get(name) ?? ''),
          })
        : (() => {
            const now = effectiveSlotDefault(scan, ofSlot, bindings, enrolled);
            return {
              outcome: 'unchanged' as const,
              ...(now !== undefined ? { before: now, after: now } : {}),
              remaining: [...new Set(bindings.filter((b) => enrolled.has(b.connection_name)).map((b) => b.connection_name))],
            };
          })();
      packs.push({
        pack_slug: pack,
        pack_name: nameOf(pack),
        slot,
        members: holders.borrowersOf(pack).map((member) => ({ pack_slug: member, pack_name: nameOf(member) })),
        outcome: result.outcome,
        ...(result.before !== undefined ? { before: ref(result.before) } : {}),
        ...(result.after !== undefined ? { after: ref(result.after) } : {}),
        remaining: result.remaining.map(ref),
        ...('fallback' in result && result.fallback !== undefined ? { fallback: result.fallback.map(ref) } : {}),
      });
    }
  }
  // D-320 audit — and each recipe reading two or more of those lists at once, whose
  // runs need a connection on every one: its packs' answers above are not its own.
  const recipes = deps.listRecipes === undefined ? undefined : recipeRemovalEffects({
    contractScan: scan,
    manifests: { get: (slug) => deps.getManifest(slug) ?? null },
    ...(deps.resolvePackManifest !== undefined ? { packManifestOf: deps.resolvePackManifest } : {}),
    recipes: deps.listRecipes(),
    connection,
    // Off one pack's list (and its family's), or off every list; a deletion keeps
    // the bindings and takes the connection out of the set-up ones instead.
    leaves: (binding) => !deleting
      && (args.pack_slug === undefined || deciderOf(binding.installed_pack_id) === deciderOf(args.pack_slug)),
    enrolled,
    enrolledAfter: deleting ? new Set([...enrolled].filter((name) => name !== connection)) : enrolled,
    deciderOf,
    reachesSlot: leavesSlot,
  }).map((effect) => ({
    recipe_id: effect.recipe_id,
    recipe_name: effect.recipe_name,
    slot: effect.slot,
    packs: effect.packs.map((pack) => ({ pack_slug: pack, pack_name: nameOf(pack) })),
    outcome: effect.outcome,
    ...(effect.before !== undefined ? { before: ref(effect.before) } : {}),
    ...(effect.after !== undefined ? { after: ref(effect.after) } : {}),
    remaining: effect.remaining.map(ref),
  }));
  return { connection_name: connection, packs, ...(recipes !== undefined && recipes.length > 0 ? { recipes } : {}) };
};

const parseRemovalArgs = (args: unknown): ConnectionRemovalArgs => {
  const method = 'packs.connections.removal';
  const a = (args !== null && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const connection_name = requireString(method, 'connection_name', a.connection_name);
  if (a.pack_slug !== undefined) requireString(method, 'pack_slug', a.pack_slug);
  const kind = a.delete_kind;
  if (kind !== undefined && kind !== 'api' && kind !== 'mcp' && kind !== 'notification') {
    throw new RpcError('bad_request', `${method}: delete_kind must be api, mcp or notification`);
  }
  return {
    connection_name,
    ...(typeof a.pack_slug === 'string' ? { pack_slug: a.pack_slug } : {}),
    ...(kind !== undefined ? { delete_kind: kind } : {}),
  };
};

/** D-320 §3.4 / §4 — `packs.connections.recipe`: the slots a recipe signs in
 *  through, each with its list and default, as the dish form and the run dialog
 *  offer them. Read with this rpc's own manifest resolver, so a slot is named as
 *  the Access page names it. */
export const recipeConnectionsView = (
  deps: PackConnectionsDeps,
  recipe_id: string,
): RpcResponse<ServerRpcRegistry, 'packs.connections.recipe'> => {
  const recipe = deps.getRecipe?.(recipe_id) ?? null;
  if (recipe === null) {
    throw new RpcError('not_found', `packs.connections.recipe: no recipe '${recipe_id}'`, 404);
  }
  const rows = deps.connectionStore.list();
  return {
    recipe_id,
    slots: recipeConnectionSlots({
      contractScan: createContractScanFn(deps.contractStore),
      manifests: { get: (slug) => deps.getManifest(slug) ?? null },
      enrolled: new Set(rows.map((row) => row.name)),
      displayName: (name) => rows.find((row) => row.name === name)?.display_name,
      ...(deps.resolvePackManifest !== undefined ? { packManifestOf: deps.resolvePackManifest } : {}),
      profiles: deps.operationProfiles,
      localManifestStore: deps.localManifestStore,
    })(recipe),
  };
};

type PackConnectionsMethods =
  | 'packs.connections.access'
  | 'packs.connections.list'
  | 'packs.connections.add'
  | 'packs.connections.remove'
  | 'packs.connections.set_default'
  | 'packs.connections.recipe'
  | 'packs.connections.removal'
  | 'packs.connections.signins'
  | 'packs.connections.add_many';

export const makePackConnectionsHandlers = (
  deps: PackConnectionsDeps | undefined,
): HandlerSlice<ServerRpcRegistry, PackConnectionsMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: [
      'packs.connections.access',
      'packs.connections.list',
      'packs.connections.add',
      'packs.connections.remove',
      'packs.connections.set_default',
      'packs.connections.recipe',
      'packs.connections.removal',
      'packs.connections.signins',
      'packs.connections.add_many',
    ],
    handlers: {
      'packs.connections.access': async (args) => {
        if (!deps.access) throw new RpcError('not_configured', 'Pack access checks are unavailable on this server.');
        return deps.access(args);
      },
      'packs.connections.list': async (args) =>
        packConnectionsView(deps, requireString('packs.connections.list', 'pack_slug', (args as { pack_slug?: unknown })?.pack_slug)),
      'packs.connections.add': async (args) => withMovedDoors(deps, await addPackConnection(deps, args)),
      'packs.connections.remove': async (args) => withMovedDoors(deps, await removePackConnection(deps, args)),
      'packs.connections.set_default': async (args) => withMovedDoors(deps, await setPackConnectionDefault(deps, args)),
      'packs.connections.recipe': async (args) =>
        recipeConnectionsView(deps, requireString('packs.connections.recipe', 'recipe_id', (args as { recipe_id?: unknown })?.recipe_id)),
      'packs.connections.removal': async (args) => connectionRemovalView(deps, parseRemovalArgs(args)),
      'packs.connections.signins': async () => packSignInsView(deps),
      'packs.connections.add_many': async (args) => withMovedDoors(deps, await addConnectionToPacks(deps, args)),
    },
  };
};

/** D-320 phase 3 (3b) — a change to a pack's connections, with the webhook doors it
 *  moved (`webhook_doors`), as a dish rpc says them (D-209): only the ones that
 *  moved, since an unchanged door is not news. The webclient announces them
 *  whichever screen made the change (`DISH_WEBHOOK_DOOR_RPCS`). */
const withMovedDoors = <T extends object>(deps: PackConnectionsDeps, result: T): T & { webhook_doors?: DishWebhookDoorChange[] } => {
  const moved = (deps.webhookDoors?.() ?? []).filter((change) => change.state !== 'unchanged');
  return moved.length > 0 ? { ...result, webhook_doors: [...moved] } : result;
};

/** The rpc deps, from the ones the websocket server already holds: the pack install
 *  deps (the contract store, the manifests, the profile reconcile, the runnability
 *  broadcast) and the connection rpc deps (the connection store). Undefined when
 *  either is missing (a dbless harness), and the rpcs are not registered. */
export const packConnectionsDepsFrom = (
  install: PackInstallRpcDeps | undefined,
  connections: Pick<ConnectionRpcDeps, 'store' | 'getEncryptionKey' | 'managedOAuth' | 'resolveFetch' | 'now'> | undefined,
  run?: Pick<PackConnectionsDeps, 'operationProfiles' | 'localManifestStore'>,
): PackConnectionsDeps | undefined => {
  if (install?.contractStore === undefined || connections === undefined) return undefined;
  const deps: PackConnectionsDeps = {
    ...(run?.operationProfiles !== undefined ? { operationProfiles: run.operationProfiles } : {}),
    ...(run?.localManifestStore !== undefined ? { localManifestStore: run.localManifestStore } : {}),
    contractStore: install.contractStore,
    connectionStore: connections.store,
    getManifest: (slug) => install.registry?.get(slug) ?? install.getManifest?.(slug) ?? null,
    getRecipe: (recipe_id) => install.recipeStore.get(recipe_id),
    listRecipes: () => install.recipeStore.listStored()
      .map((row) => install.recipeStore.get(row.recipe_id))
      .filter((recipe): recipe is RecipeDefinition => recipe !== null),
    resolvePackManifest: (slug) =>
      resolveBundledPackManifest(install.packDir, slug) ?? install.resolveDependencyManifest?.(slug) ?? null,
    ...(install.reconcileConnectionProfile !== undefined
      ? { reconcileConnectionProfile: install.reconcileConnectionProfile }
      : {}),
    onChanged: () => install.recipeRunnabilityBroadcast?.recomputeAndEmit(),
    ...(install.packConnectionWebhookDoors !== undefined
      ? { webhookDoors: install.packConnectionWebhookDoors }
      : {}),
    authTypeOf: async (row) => {
      const key = connections.getEncryptionKey?.();
      // A locked store reads no auth type, and the match fails closed.
      if (connections.getEncryptionKey !== undefined && key === null) return undefined;
      try {
        const auth = await decodeAuthFromStorage(
          row.auth_ciphertext,
          { kind: row.kind, name: row.name },
          connections.getEncryptionKey === undefined ? undefined : () => key as Uint8Array,
        );
        return auth.type;
      } catch {
        return undefined;
      }
    },
  };
  deps.access = createPackAccessHandler({
    connections,
    view: (slug) => packConnectionsView(deps, slug),
    manifest: (slug) => deps.resolvePackManifest?.(slug) ?? null,
    installed: (slug) => getInstalledPack(deps.contractStore, slug),
  });
  return deps;
};

/** D-320 §3.4 — a dish's choice of connection, checked as it is saved: each slot
 *  one the recipe signs in through, each connection on that slot's list. A run
 *  refuses a choice that stops holding (`run-connection-choice.ts`); this keeps a
 *  dish from being saved with one that never did. */
export const checkDishConnections = (deps: PackConnectionsDeps) =>
  (recipe_id: string, connections: Readonly<Record<string, string>>): void => {
    const view = recipeConnectionsView(deps, recipe_id);
    const aliases = new Map(view.slots.flatMap((s) => s.connections.map((c) => [c.connection_name, c.display_name] as const)));
    for (const [slot, chosen] of Object.entries(connections)) {
      const found = view.slots.find((s) => s.slot === slot);
      if (found === undefined) throw unknownSlot(recipe_id, slot, view.slots.map((s) => s.slot));
      const list = found.connections.map((c) => c.connection_name);
      if (!list.includes(chosen)) {
        throw notOnList(
          { recipe_id, inherited: false, owner: true, displayName: (name) => aliases.get(name) },
          slot,
          chosen,
          list,
        );
      }
    }
  };

/** D-320 audit — a connection is set up while a row of its name is (the Access tab's
 *  rule): a deleted connection's binding stays, dormant, and must not count. */
export const isConnectionSetUpIn = (
  store: Pick<PackConnectionsDeps['connectionStore'], 'list'>,
): ((connection_name: string) => boolean) =>
  (connection_name) => store.list().some((row) => row.name === connection_name);

/** D-320 slice 2j — the pack install rpc deps with the shared-connections read,
 *  when a pack's connections are wired; otherwise as given (no connection is
 *  offered, and `also_connections` adds nothing). */
export const withSharedSignInConnections = (
  install: PackInstallRpcDeps | undefined,
  connections: PackConnectionsDeps | undefined,
): PackInstallRpcDeps | undefined =>
  install === undefined || connections === undefined
    ? install
    : {
        ...install,
        sharedSignInConnections: (manifest) => sharedSignInConnections(connections, manifest),
        isConnectionSetUp: isConnectionSetUpIn(connections.connectionStore),
      };

/** The dish rpc deps with that check, when a pack's connections are wired;
 *  otherwise as given, and a dish naming connections is refused. */
export const withDishConnectionCheck = (
  dish: DishHandlerDeps | undefined,
  connections: PackConnectionsDeps | undefined,
): DishHandlerDeps | undefined =>
  dish === undefined || connections === undefined
    ? dish
    : { ...dish, checkConnectionChoices: checkDishConnections(connections) };
