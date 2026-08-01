/** D-145 PA10 follow-on Slice B — `packs.uninstall` rpc-deps composer.
 *
 *  Builds the `PackUninstallRpcDeps` shape consumed by `packs.uninstall`.
 *  Returns `{ packUninstallDeps: undefined }` when the per-pair
 *  `RecipeStore` isn't composed yet (dbless harnesses + pre-D-103-Phase-A
 *  boots) — the caller drops the conditional spread + the rpc surfaces
 *  `not_configured`. Threaded through `composeRpcContext` into
 *  `createServerHandlerSet({ packUninstallDeps })`. */

import type { EventBus } from '../../events/bus.js';
import type {
  PackUninstallBroadcastEmitter,
  PackUninstallRpcDeps,
} from '../../pack-uninstall-handler.js';
import type { RecipeStore } from '../../recipe-store.js';
import type { ContractStore } from '../../storage/contract-store.js';
import type { ChatInboundTokenStore } from '../../storage/chat-inbound-token-store.js';
import type { McpBodyVisibilityStore } from '../../storage/mcp-body-visibility-store.js';
import type { WebhookConsumerStore } from '../../storage/webhook-consumer-store.js';
import type { SellerInstallAudienceStore } from '../../ingredient-authoring/install-composition.js';
import type { RecordsStore } from '../../records/store.js';

export interface ComposePackUninstallRpcDepsInput {
  /** Per-pair recipe store. Absent → composer returns the
   *  undefined-bundle + caller drops the `packUninstallDeps` spread. */
  recipeStore: RecipeStore | undefined;
  /** D-221 full-ref Records lifecycle store. */
  recordsStore?: RecordsStore;
  /** D-201 Slice 4 — binding/trigger teardown store. */
  webhookConsumerStore?: WebhookConsumerStore;
  /** D-139 P6.B — MCP body-content visibility grant store. Optional —
   *  present → the uninstalling pack's body grants are revoked; absent →
   *  the body-grant step is a no-op (symmetric with the install composer). */
  mcpBodyVisibilityStore?: McpBodyVisibilityStore;
  /** D-165 P3.1 — gateway-read-only `contract.*` store. Optional — when
   *  present the uninstall handler drops this pack's `installed_pack` +
   *  owned `installed_ingredient` inventory; absent → no inventory removed. */
  contractStore?: ContractStore;
  /** D-196 customer grant-snapshot cleanup on uninstall. */
  sellerStore?: SellerInstallAudienceStore;
  inboundTokenStore?: Pick<ChatInboundTokenStore, 'getTokenById' | 'updateTokenGrants'>;
  /** D-145 PA10 follow-on — D-121 broadcast bus. Optional — when
   *  present the composer builds a narrow
   *  `PackUninstallBroadcastEmitter` that drops `pack_uninstalled`
   *  onto the bus after every successful uninstall transaction, and
   *  threads it onto `packUninstallDeps.broadcast`. Mirrors
   *  `composePackInstallRpcDeps.eventBus` for parity. */
  eventBus?: EventBus;
  /** Override the default community/packs directory. Tests pass a
   *  scratch dir; production callers leave undefined to use the bundled
   *  location. Mirrors `ComposePackListRpcDepsInput.packDir`. */
  packDir?: string;
  /** Test seam for customer token updated_at. */
  now?: () => number;
}

export interface PackUninstallRpcBundle {
  /** Threaded into `createServerHandlerSet({ packUninstallDeps })`.
   *  Undefined when `recipeStore` is missing → caller drops the
   *  conditional spread. */
  packUninstallDeps: PackUninstallRpcDeps | undefined;
}

/** D-145 PA10 follow-on Slice B — bus-backed emitter the composer
 *  hands the uninstall handler. Same shape as the install emitter
 *  builder above but narrowed to the `pack_uninstalled` event kind. */
const packUninstallEmitterFromBus = (
  bus: EventBus,
): PackUninstallBroadcastEmitter => ({
  emit: (event) => {
    bus.emit(event);
  },
});

export const composePackUninstallRpcDeps = (
  input: ComposePackUninstallRpcDepsInput,
): PackUninstallRpcBundle => {
  const {
    recipeStore,
    recordsStore,
    webhookConsumerStore,
    mcpBodyVisibilityStore,
    contractStore,
    sellerStore,
    inboundTokenStore,
    eventBus,
    packDir,
    now,
  } = input;

  if (!recipeStore) {
    return { packUninstallDeps: undefined };
  }

  const packUninstallDeps: PackUninstallRpcDeps = {
    recipeStore,
    ...(recordsStore ? { recordsStore } : {}),
    ...(webhookConsumerStore ? { webhookConsumerStore } : {}),
    ...(mcpBodyVisibilityStore ? { mcpBodyVisibilityStore } : {}),
    ...(contractStore ? { contractStore } : {}),
    ...(sellerStore ? { sellerStore } : {}),
    ...(inboundTokenStore ? { inboundTokenStore } : {}),
    ...(eventBus ? { broadcast: packUninstallEmitterFromBus(eventBus) } : {}),
    ...(packDir !== undefined ? { packDir } : {}),
    ...(now ? { now } : {}),
  };

  return { packUninstallDeps };
};
