/** D-145 PA10 follow-on — `packs.install` rpc-deps composer.
 *
 *  Builds the `PackInstallRpcDeps` shape consumed by `packs.install`.
 *  Returns `{ packInstallDeps: undefined }` when the per-pair
 *  `RecipeStore` isn't composed yet (dbless harnesses + pre-D-103-Phase-A
 *  boots) — the caller drops the conditional spread + the rpc surfaces
 *  `not_configured`. Threaded through `composeRpcContext` into
 *  `createServerHandlerSet({ packInstallDeps })`. */

import type { EventBus } from '../../events/bus.js';
import type {
  PackInstallBroadcastEmitter,
  PackInstallRpcDeps,
} from '../../pack-install-handler.js';
import type { IngredientManifest } from '@recued/contracts';
import type { RecipeStore } from '../../recipe-store.js';
import type { ContractStore } from '../../storage/contract-store.js';
import type { ChatInboundTokenStore } from '../../storage/chat-inbound-token-store.js';
import type { McpBodyVisibilityStore } from '../../storage/mcp-body-visibility-store.js';
import type { WebhookConsumerStore } from '../../storage/webhook-consumer-store.js';
import type { SellerInstallAudienceStore } from '../../ingredient-authoring/install-composition.js';
import type { RecordsStore } from '../../records/index.js';

type RecipeTrustWriter = NonNullable<PackInstallRpcDeps['recipeTrustStore']>;

export interface ComposePackInstallRpcDepsInput {
  /** Per-pair recipe store. Absent → composer returns the
   *  undefined-bundle + caller drops the `packInstallDeps` spread. */
  recipeStore: RecipeStore | undefined;
  recordsStore?: RecordsStore;
  /** D-201 Slice 4 — exact ingress binding and trigger materialization store. */
  webhookConsumerStore?: WebhookConsumerStore;
  /** D-139 P6.B — MCP body-content visibility grant store. Optional —
   *  present → pack-declared body grants persist on install; absent →
   *  skipped (MCP body content stays stripped). */
  mcpBodyVisibilityStore?: McpBodyVisibilityStore;
  /** D-165 P3.1 — gateway-read-only `contract.*` store. Optional — when
   *  present the install handler records `installed_pack` +
   *  `installed_ingredient` inventory after a successful install; absent
   *  (dbless / pre-contract-store boot) → no inventory recorded. */
  contractStore?: ContractStore;
  /** D-196 install grant audiences. Optional — customer-scoped fan-out sees no
   *  seller customer rows when absent. */
  sellerStore?: SellerInstallAudienceStore;
  /** D-196 existing customer bearer snapshots. */
  inboundTokenStore?: Pick<ChatInboundTokenStore, 'getTokenById' | 'updateTokenGrants'>;
  /** D-145 PA10 follow-on — D-121 broadcast bus. Optional — when
   *  present the composer builds a narrow `PackInstallBroadcastEmitter`
   *  that drops `pack_installed` onto the bus after every successful
   *  install transaction, and threads it onto `packInstallDeps.broadcast`.
   *  Absent → the handler runs without broadcast emit (dbless harness
   *  / pre-D-121 boot paths). Mirrors the shape used by the
   *  housekeeping composer in `wire-housekeeping-substrate.ts`. */
  eventBus?: EventBus;
  /** Test seam — production passes `Date.now`. */
  now?: () => number;
  /** Optional staged-trust store; pure-workflow recipes install as auto-trusted. */
  recipeTrustStore?: RecipeTrustWriter;
  /** Override the default community/packs directory. Tests pass a scratch
   *  directory; production callers leave undefined to use the bundled location. */
  packDir?: string;
  /** D-247 D15 — ingredient-manifest lookup, so `packs.install_preview` can
   *  resolve a recipe's ops to a RISK TIER. ⛔ Absent ⇒ every previewed recipe
   *  reports `grant_class: 'unknown'` ("what this can reach could not be
   *  determined") — the disclosure renders and says nothing. */
  getManifest?: (slug: string) => IngredientManifest | undefined;
  /** D-247 D15.1 — the owner's grant rows, so an install can pre-write each
   *  recipe's row with the ACCESS CEILING the owner picked applied. ⛔ Absent ⇒
   *  the store's mutation hook seeds on `chat_exposed` alone and the ceiling is
   *  silently ignored. */
  grantEntryStore?: PackInstallRpcDeps['grantEntryStore'];
}

export interface PackInstallRpcBundle {
  /** Threaded into `createServerHandlerSet({ packInstallDeps })`.
   *  Undefined when `recipeStore` is missing → caller drops the
   *  conditional spread. */
  packInstallDeps: PackInstallRpcDeps | undefined;
}

/** D-145 PA10 follow-on — bus-backed emitter the composer hands the
 *  install handler. Mirrors `broadcastEmitterFromBus` in
 *  `chat-orchestrator.ts` but narrowed to the single `pack_installed`
 *  kind (cursor stamped by the bus on emit). */
const packInstallEmitterFromBus = (
  bus: EventBus,
): PackInstallBroadcastEmitter => ({
  emit: (event) => {
    bus.emit(event);
  },
});

export const composePackInstallRpcDeps = (
  input: ComposePackInstallRpcDepsInput,
): PackInstallRpcBundle => {
  const {
    recipeStore,
    recordsStore,
    webhookConsumerStore,
    mcpBodyVisibilityStore,
    contractStore,
    sellerStore,
    inboundTokenStore,
    eventBus,
    now,
    recipeTrustStore,
    packDir,
    getManifest,
    grantEntryStore,
  } = input;

  if (!recipeStore) {
    return { packInstallDeps: undefined };
  }

  const packInstallDeps: PackInstallRpcDeps = {
    recipeStore,
    ...(recordsStore ? { recordsStore } : {}),
    ...(webhookConsumerStore ? { webhookConsumerStore } : {}),
    ...(mcpBodyVisibilityStore ? { mcpBodyVisibilityStore } : {}),
    ...(contractStore ? { contractStore } : {}),
    ...(sellerStore ? { sellerStore } : {}),
    ...(inboundTokenStore ? { inboundTokenStore } : {}),
    ...(eventBus ? { broadcast: packInstallEmitterFromBus(eventBus) } : {}),
    ...(now ? { now } : {}),
    ...(recipeTrustStore ? { recipeTrustStore } : {}),
    ...(packDir !== undefined ? { packDir } : {}),
    ...(getManifest ? { getManifest } : {}),
    ...(grantEntryStore ? { grantEntryStore } : {}),
  };

  return { packInstallDeps };
};
