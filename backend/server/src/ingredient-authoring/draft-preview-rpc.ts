/** D-170 N.4 / N.15 / #2 — `ingredient.draft.{save,list,get,delete}` +
 *  `ingredient.preview` + `ingredient.compose.decompose` rpc handlers.
 *
 *  The authoring side that precedes `ingredient.install`. The draft methods are
 *  thin pass-throughs to the per-pair `DraftStore`; `ingredient.preview` runs
 *  one operation of a draft through the real connection adapter (N.4
 *  test-before-save) via `runIngredientPreview`, whose risk gate guarantees a
 *  mutation is never executed. The compose/decompose method validates +
 *  decomposes the saved draft and returns the install review projection.
 *
 *  Every domain outcome rides the typed result union (`{ ok: false, code }`) —
 *  including arg-shape problems (`bad_request`) — so the Kitchen / Connection
 *  Setup UI renders one result shape per method. The rpc error channel is not
 *  used; a missing `draftStore` instead leaves the whole slice un-wired (the
 *  `make…Handlers` factory returns `undefined`, mirroring `makeIngredientAuth-
 *  oringHandlers`), so a db-less harness surfaces a clean "method not wired".
 *
 *  Channel-isolation: every method is under the `ingredient.` reserved prefix
 *  (`MCP_RESERVED_RPC_PREFIXES`) — an MCP-channel agent can never author /
 *  preview / install its own capability surface. Settings / Kitchen is the
 *  sole writer.
 *
 *  Spec: D-170 § N.4 (test-before-save), N.15 (rpc surface). */

import {
  INGREDIENT_DRAFT_PACK_MAX_BYTES,
  type HandlerSlice,
  type CompositionDecomposeArgs,
  type CompositionDecomposeResult,
  type IngredientSaveAsNewArgs,
  type IngredientSaveAsNewResult,
  type BulkPackManifest,
  type IngredientDraftDeleteArgs,
  type IngredientDraftDeleteResult,
  type IngredientDraftEditArgs,
  type IngredientDraftEditResult,
  type IngredientDraftGetArgs,
  type IngredientDraftGetResult,
  type IngredientDraftListResult,
  type IngredientDraftSaveArgs,
  type IngredientDraftSaveResult,
  type IngredientPreviewArgs,
  type IngredientPreviewResult,
  type ServerRpcRegistry,
} from '@recued/contracts';

import type { DraftStore } from './draft-store.js';
import { handleCompositionDecompose } from './compose-decompose-rpc.js';
import { handleIngredientSaveAsNew } from './save-as-new-rpc.js';
import type { LocalManifestStore } from './local-manifest-store.js';
import { runIngredientPreview, type IngredientPreviewDeps } from './preview.js';
import type { WsClient } from '../ws-server.js';

export interface IngredientDraftRpcDeps {
  /** Per-pair draft store. Its presence gates the whole slice. */
  draftStore: DraftStore;
  /** Local authored body store. Present in normal per-pair db boots; when absent
   *  the save-as-new method stays un-wired while draft/decompose/preview still
   *  work for db-less test harnesses. */
  localManifestStore?: LocalManifestStore;
  /** Resolve an enrolled api connection row for preview redaction + the
   *  enrolled check. Absent → preview reads degrade to `no_connection`. */
  connectionLookup?: IngredientPreviewDeps['connectionLookup'];
  /** Execute a preview READ through the real connection adapter. Absent →
   *  preview reads degrade to `preview_unavailable`. NEVER invoked for a
   *  mutation (the gate is in `runIngredientPreview`). */
  previewExecute?: IngredientPreviewDeps['execute'];
  /** D-333 — the source a pack was installed from in Kitchen, while that install is the
   *  installed one. Absent: no installed pack can be edited. */
  packSourceFor?: (packSlug: string) => BulkPackManifest | null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const handleSave = (
  store: DraftStore,
  args: IngredientDraftSaveArgs,
): IngredientDraftSaveResult => {
  if (!isPlainObject(args) || !('body' in args) || !isPlainObject(args.body)) {
    return { ok: false, code: 'bad_request', message: 'ingredient.draft.save: body must be an object' };
  }
  // D-333 — the pack it installs as: a small object, kept beside the composition.
  if (args.pack !== undefined && (!isPlainObject(args.pack)
    || Buffer.byteLength(JSON.stringify(args.pack), 'utf8') > INGREDIENT_DRAFT_PACK_MAX_BYTES)) {
    return { ok: false, code: 'bad_request', message: 'ingredient.draft.save: pack must be a small object' };
  }
  const result = store.save({
    ...(typeof args.draft_id === 'string' && args.draft_id !== '' ? { draft_id: args.draft_id } : {}),
    ...(typeof args.title === 'string' ? { title: args.title } : {}),
    body: args.body,
    ...(args.pack !== undefined ? { pack: args.pack } : {}),
  });
  if ('error' in result) {
    return result.error === 'too_large'
      ? { ok: false, code: 'too_large', message: 'ingredient.draft.save: body exceeds the draft size cap' }
      : { ok: false, code: 'limit_reached', message: 'ingredient.draft.save: per-pair draft limit reached' };
  }
  return { ok: true, draft: result };
};

/** D-333 — a pack's identity is its manifest without the contents. */
const packIdentity = (manifest: BulkPackManifest): Record<string, unknown> => {
  const { contents: _contents, recipes: _recipes, ...identity } = manifest as unknown as Record<string, unknown>;
  return identity;
};

const handleGet = (
  store: DraftStore,
  args: IngredientDraftGetArgs,
  packSourceFor?: (packSlug: string) => BulkPackManifest | null,
): IngredientDraftGetResult => {
  if (!isPlainObject(args) || typeof args.draft_id !== 'string' || args.draft_id === '') {
    return { ok: false, code: 'bad_request', message: 'ingredient.draft.get: draft_id is required' };
  }
  const draft = store.get(args.draft_id);
  if (!draft) return { ok: false, code: 'not_found', message: `no draft '${args.draft_id}'` };
  // D-333 — changes to an installed pack install as that pack: hand over its identity.
  const source = draft.base_pack !== undefined ? packSourceFor?.(draft.base_pack.pack_slug) ?? null : null;
  return source === null
    ? { ok: true, draft }
    : { ok: true, draft: { ...draft, base_pack: { pack_slug: draft.base_pack!.pack_slug, identity: packIdentity(source) } } };
};

/** D-333 — the draft of changes to a pack made in Kitchen: the one open, or a new one from
 *  the composition the pack was installed from. */
const handleEdit = (
  store: DraftStore,
  args: IngredientDraftEditArgs,
  packSourceFor?: (packSlug: string) => BulkPackManifest | null,
): IngredientDraftEditResult => {
  if (!isPlainObject(args) || typeof args.pack_slug !== 'string' || args.pack_slug.trim() === '') {
    return { ok: false, code: 'bad_request', message: 'ingredient.draft.edit: pack_slug is required' };
  }
  const source = packSourceFor?.(args.pack_slug) ?? null;
  const content = Array.isArray(source?.contents)
    ? (source!.contents as unknown[]).find((entry) =>
      isPlainObject(entry) && entry.type === 'composition' && isPlainObject(entry.composition)) as
        { composition: Record<string, unknown> } | undefined
    : undefined;
  if (source === null || content === undefined) {
    return { ok: false, code: 'not_found',
      message: 'This pack was not made in Kitchen on this server, so there is nothing here to edit.' };
  }
  const title = typeof source.name === 'string' && source.name.trim() ? source.name.trim() : args.pack_slug;
  const opened = store.openForPack(args.pack_slug, content.composition, title);
  if ('error' in opened) {
    return opened.error === 'limit_reached'
      ? { ok: false, code: 'limit_reached', message: 'Kitchen has no room for another pack in progress. Finish or discard one first.' }
      : { ok: false, code: 'bad_request', message: 'This pack is too large to edit here.' };
  }
  const summary = store.list().find((entry) => entry.draft_id === opened.draft_id);
  return summary !== undefined
    ? { ok: true, draft: summary }
    : { ok: false, code: 'not_found', message: 'This pack was not made in Kitchen on this server, so there is nothing here to edit.' };
};

const handleDelete = (
  store: DraftStore,
  args: IngredientDraftDeleteArgs,
): IngredientDraftDeleteResult => {
  if (!isPlainObject(args) || typeof args.draft_id !== 'string' || args.draft_id === '') {
    return { ok: false, code: 'bad_request', message: 'ingredient.draft.delete: draft_id is required' };
  }
  return { ok: true, deleted: store.delete(args.draft_id) };
};

type IngredientDraftMethods =
  | 'ingredient.draft.save'
  | 'ingredient.draft.list'
  | 'ingredient.draft.get'
  | 'ingredient.draft.delete'
  | 'ingredient.draft.edit'
  | 'ingredient.compose.decompose'
  | 'ingredient.saveAsNew'
  | 'ingredient.preview';

type IngredientDraftCoreMethods = Exclude<IngredientDraftMethods, 'ingredient.saveAsNew'>;

export const makeIngredientDraftHandlers = (
  deps: IngredientDraftRpcDeps | undefined,
):
  | HandlerSlice<ServerRpcRegistry, IngredientDraftCoreMethods, WsClient>
  | HandlerSlice<ServerRpcRegistry, IngredientDraftMethods, WsClient>
  | undefined => {
  if (!deps?.draftStore) return undefined;
  const store = deps.draftStore;
  const previewDeps: IngredientPreviewDeps = {
    draftStore: store,
    ...(deps.connectionLookup ? { connectionLookup: deps.connectionLookup } : {}),
    ...(deps.previewExecute ? { execute: deps.previewExecute } : {}),
  };
  const core = {
    methods: [
      'ingredient.draft.save',
      'ingredient.draft.list',
      'ingredient.draft.get',
      'ingredient.draft.delete',
      'ingredient.draft.edit',
      'ingredient.compose.decompose',
      'ingredient.preview',
    ],
    handlers: {
      'ingredient.draft.save': async (args) =>
        handleSave(store, args as IngredientDraftSaveArgs),
      'ingredient.draft.list': async (): Promise<IngredientDraftListResult> => ({
        ok: true,
        drafts: store.list(),
      }),
      'ingredient.draft.get': async (args) =>
        handleGet(store, args as IngredientDraftGetArgs, deps.packSourceFor),
      'ingredient.draft.delete': async (args) =>
        handleDelete(store, args as IngredientDraftDeleteArgs),
      'ingredient.draft.edit': async (args) =>
        handleEdit(store, args as IngredientDraftEditArgs, deps.packSourceFor),
      'ingredient.compose.decompose': async (args): Promise<CompositionDecomposeResult> =>
        handleCompositionDecompose({ draftStore: store }, args as CompositionDecomposeArgs),
      'ingredient.preview': async (args): Promise<IngredientPreviewResult> =>
        runIngredientPreview(previewDeps, args as IngredientPreviewArgs),
    },
  } satisfies HandlerSlice<ServerRpcRegistry, IngredientDraftCoreMethods, WsClient>;
  const localManifestStore = deps.localManifestStore;
  if (!localManifestStore) return core;

  return {
    methods: [
      'ingredient.draft.save',
      'ingredient.draft.list',
      'ingredient.draft.get',
      'ingredient.draft.delete',
      'ingredient.draft.edit',
      'ingredient.compose.decompose',
      'ingredient.saveAsNew',
      'ingredient.preview',
    ],
    handlers: {
      ...core.handlers,
      'ingredient.saveAsNew': async (args): Promise<IngredientSaveAsNewResult> =>
        handleIngredientSaveAsNew(
          { draftStore: store, localManifestStore },
          args as IngredientSaveAsNewArgs,
        ),
    },
  };
};
