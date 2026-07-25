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
  type HandlerSlice,
  type CompositionDecomposeArgs,
  type CompositionDecomposeResult,
  type IngredientSaveAsNewArgs,
  type IngredientSaveAsNewResult,
  type IngredientDraftDeleteArgs,
  type IngredientDraftDeleteResult,
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
  const result = store.save({
    ...(typeof args.draft_id === 'string' && args.draft_id !== '' ? { draft_id: args.draft_id } : {}),
    ...(typeof args.title === 'string' ? { title: args.title } : {}),
    body: args.body,
  });
  if ('error' in result) {
    return result.error === 'too_large'
      ? { ok: false, code: 'too_large', message: 'ingredient.draft.save: body exceeds the draft size cap' }
      : { ok: false, code: 'limit_reached', message: 'ingredient.draft.save: per-pair draft limit reached' };
  }
  return { ok: true, draft: result };
};

const handleGet = (
  store: DraftStore,
  args: IngredientDraftGetArgs,
): IngredientDraftGetResult => {
  if (!isPlainObject(args) || typeof args.draft_id !== 'string' || args.draft_id === '') {
    return { ok: false, code: 'bad_request', message: 'ingredient.draft.get: draft_id is required' };
  }
  const draft = store.get(args.draft_id);
  return draft
    ? { ok: true, draft }
    : { ok: false, code: 'not_found', message: `no draft '${args.draft_id}'` };
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
        handleGet(store, args as IngredientDraftGetArgs),
      'ingredient.draft.delete': async (args) =>
        handleDelete(store, args as IngredientDraftDeleteArgs),
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
