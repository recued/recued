/** D-149 P3 § A.3 — `reception.*` rpc handler slice.
 *
 *  Reserved admin-only rpc methods over Reception's local stores.
 *  Each method:
 *
 *    1. Requires a paired client (mirrors `tls_domain.*` / `pro_acme.*`
 *       posture — operator-only).
 *    2. Validates wire-shaped args against closed lists
 *       (`ReceptionEndpointKind`, packet_declaration shape, source-query
 *       allowlist, per-kind expiry ceiling).
 *    3. Calls the `PublicEndpointRegistryStore` for the persistence
 *       leg.
 *    4. For mutations: emits the corresponding D-120 high-assurance
 *       signed audit row (via `audit.logActivity` which auto-signs the
 *       closed-list `RECEPTION_HIGH_ASSURANCE_AUDIT_KINDS` per
 *       `createSigningAuditLog`) AND a `reception.endpoint_changed`
 *       broadcast bus event (per § Must Hold I-5 60s cache invalidation).
 *
 *  Channel isolation: `reception.*` is in `MCP_RESERVED_RPC_PREFIXES`
 *  (P3 ratchet test asserts the prefix stays reserved). External AI
 *  agents must never drive endpoint creation / token rotation /
 *  emergency disable — the public-facing reception surface exposes
 *  user data to anonymous visitors; an MCP-channel mutation would be
 *  catastrophic.
 *
 *  Spec: D-149 § A.3 + § N.3 + § Must Hold I-1 / I-5 /
 *  I-10. */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  ABUSE_INBOX_DEFAULT_WINDOW_MS,
  APPROVAL_LINK_DEFAULT_SUBMIT_BUTTON_LABEL,
  COMPOSE_CONTRACT_VERSION,
  COMPOSE_TEMPLATE_BY_REF,
  COMPOSE_TEMPLATE_CATALOG,
  DROP_LINK_DEFAULT_SUBMIT_BUTTON_LABEL,
  INTAKE_FORM_DEFAULT_SUBMIT_BUTTON_LABEL,
  RECEPTION_PAIR_RECIPE_ID_MAX_LENGTH,
  PAID_DOCUMENT_DIRECT_CHECKOUT_CONFIGURATION_METADATA_KEY,
  PACKET_FIELDS_VISIBLE,
  RECEPTION_ENDPOINT_KIND_SET,
  RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND,
  RECEPTION_PER_KIND_EXPIRY_MAX_MS,
  RECEPTION_RATE_LIMIT_DEFAULTS,
  RpcError,
  buildAbuseInbox,
  buildViewAsVisitorPanel,
  compileProposedEndpointConfig,
  isReceptionFormPairBinding,
  isReceptionPairRevision,
  isReceptionSchedulingPairBinding,
  receptionPairBindingEquals,
  isCompileError,
  isReceptionEndpointKind,
  isReceptionPairableKind,
  parseIntakeFormTemplate,
  parseReceptionConfigTemplate,
  parseSourceQueryRef,
  evaluateFormFieldContract,
  recipeFormResponseScope,
  resolvePaidDocumentDirectCheckoutClaimConfiguration,
  isSourceQueryPermittedFor,
  validateApprovalLinkConfig,
  validateDropLinkConfig,
  validateIntakeFormConfig,
  validateReceptionPageConfig,
  validateSchedulingLinkConfig,
  validateStatusLinkConfig,
  type AccessLogEntry,
  type AIComposeTraceRedacted,
  type CompileError,
  type ComposeEndpointKind,
  type EndpointSummary,
  type HandlerSlice,
  type IntakeFormTemplate,
  type ReceptionConfigTemplate,
  type PacketDeclaration,
  type ReceptionAbuseInboxBanIpInput,
  type ReceptionAbuseInboxBanIpResult,
  type ReceptionAbuseInboxListInput,
  type ReceptionAbuseInboxListResult,
  type ReceptionAbuseInboxUnbanIpInput,
  type ReceptionAbuseInboxUnbanIpResult,
  type ReceptionComposeProposeInput,
  type ReceptionComposeProposeResult,
  type ReceptionEndpointKind,
  type ReceptionEndpointAccessLogInput,
  type ReceptionEndpointAccessLogResult,
  type ReceptionEmergencyDisableAllInput,
  type ReceptionEmergencyDisableAllResult,
  type RecipeDefinition,
  type ReceptionPairBinding,
  type ReceptionDoorBindView,
  type ReceptionIntakeRecipePairBindInput,
  type ReceptionIntakeRecipePairBindResult,
  type ReceptionIntakeRecipePairClaimConfigurationBlockerCode,
  type ReceptionIntakeRecipePairClaimConfigurationAuthoring,
  type ReceptionIntakeRecipePairClaimConfigurationReadiness,
  type ReceptionIntakeRecipePairClearInput,
  type ReceptionIntakeRecipePairClearResult,
  type ReceptionIntakeRecipePairConfigureInput,
  type ReceptionIntakeRecipePairConfigureResult,
  type ReceptionIntakeRecipePairGetInput,
  type ReceptionIntakeRecipePairGetResult,
  type ReceptionIntakeRecipePairView,
  type FormFieldContractMismatch,
  type FormFieldContractFormView,
  type FormResponseTriggerFormScope,
  type RecipeFormFieldRequirement,
  type ReceptionEndpointCreateInput,
  type ReceptionEndpointCreateResult,
  type ReceptionEndpointExtendInput,
  type ReceptionEndpointMutationInput,
  type ReceptionEndpointPreviewInput,
  type ReceptionEndpointPreviewResult,
  type ReceptionEndpointRevokeInput,
  type ReceptionEndpointRotateInput,
  type ReceptionEndpointRotateResult,
  type ReceptionEndpointsListFilter,
  type ReceptionEndpointsListResult,
  type ReceptionHighAssuranceAuditKind,
  type ReceptionIpBlockEntry,
  type ReceptionPageConfig,
  type ReceptionPageGetResult,
  type ReceptionPageUpsertInput,
  type ReceptionPageUpsertResult,
  type ReceptionRpcErrorCode,
  type ReceptionTemplateListResult,
  // D-220 Slice B — pack-shipped intake templates on the list result.
  type PackReceptionTemplateListing,
  type PackReceptionTemplateUnavailable,
  type ProposedEndpointConfig,
  type RecuedPlan,
  type ServerEvent,
  type ServerRpcRegistry,
  type SourceQueryRef,
  type TemplateSafetyMatrix,
} from '@recued/contracts';
import { parseJSONObject } from '@recued/llm';
import {
  validateRecipe,
} from '@recued/recipes';
import {
  executeRecuedRequest,
  type ExecuteRecuedRequestContext,
  type OrchestrationPolicy,
} from '@recued/middleware/orchestrator/index.js';
import {
  createPrimitiveRegistry,
  type AISynthesizeAdapter,
  type PrimitiveRegistry,
  type PrimitiveRegistryDeps,
} from '@recued/middleware/primitives/index.js';
import {
  createCapacityAuditEmitter,
  createCapacityCache,
  createCapacityInvalidationSource,
  createCapacityProbeRegistry,
  createNoopTransparencyEmitter,
} from '@recued/middleware/capacity/index.js';
import type { AuditLogStore } from '@recued/storage';
import {
  buildShareUrl,
  generateBearerSecret,
  generateEndpointId,
} from './ports/reception/token-primitives.js';
import { computeBearerHmac } from './ports/reception/server-secret-pepper.js';
import {
  buildReceptionPacket,
  type ReceptionEndpointContext,
  type ReceptionPacketKind,
} from './ports/reception/redacted-packet.js';
import {
  computePreviewHash,
  type PreviewHashStore,
} from './ports/reception/preview-hash.js';
import {
  assembleReceptionPageSourceView,
  buildReceptionPagePacketRawInput,
} from './ports/reception/transformations/reception-page.js';
import {
  buildSchedulingLinkPacketRawInput,
  parseSchedulingLinkConfig,
} from './ports/reception/transformations/scheduling-link.js';
import {
  computeSchedulingLookAheadWindow,
  enumerateSchedulingSlots,
  intersectWithAvailabilityWindows,
  type SchedulingSlotCandidate,
} from './ports/reception/transformations/scheduling-link-slots.js';
import {
  buildIntakeFormPacketRawInput,
  buildIntakeFormSourceView,
  parseIntakeFormConfig,
} from './ports/reception/transformations/intake-form.js';
import {
  buildDropLinkPacketRawInput,
  buildDropLinkSourceView,
  parseDropLinkConfig,
} from './ports/reception/transformations/drop-link.js';
import {
  buildApprovalLinkPacketRawInput,
  buildApprovalLinkSourceView,
  parseApprovalLinkConfig,
} from './ports/reception/transformations/approval-link.js';
import {
  buildStatusLinkPacketRawInput,
  buildStatusLinkSourceView,
  parseStatusLinkConfig,
} from './ports/reception/transformations/status-link.js';
import {
  renderReceptionPageHtml,
  renderReceptionPagePlaceholderHtml,
  type ReceptionPageRenderInput,
} from './ports/reception/handlers/reception-page-render.js';
import {
  renderSchedulingLinkHtml,
  renderSchedulingLinkPlaceholderHtml,
  type SchedulingSlot,
} from './ports/reception/handlers/scheduling-link-render.js';
import {
  renderIntakeFormHtml,
  renderIntakeFormPlaceholderHtml,
} from './ports/reception/handlers/intake-form-render.js';
import {
  renderDropLinkHtml,
  renderDropLinkPlaceholderHtml,
} from './ports/reception/handlers/drop-link-render.js';
import {
  renderApprovalLinkHtml,
  renderApprovalLinkPlaceholderHtml,
} from './ports/reception/handlers/approval-link-render.js';
import {
  renderStatusLinkHtml,
  renderStatusLinkPlaceholderHtml,
} from './ports/reception/handlers/status-link-render.js';
import type { PublicEndpointRegistryStore } from './storage/public-endpoint-registry-store.js';
import {
  resolveConnectionVendor,
  type ConnectionStoreSqlite,
} from './storage/connection-store.js';
import type { InboundFileCollection } from './collections/file/inbound-file-collection.js';
import { loadPaidDocumentDirectCheckoutTemplateClaim } from './paid-document-direct-checkout-template-source.js';
import {
  isPaidDocumentDirectCheckoutSellerOfferSource,
  paidDocumentDirectCheckoutSellerOfferRecipeAuthorized,
} from './paid-document-direct-checkout-seller-source.js';
import {
  ReceptionIntakeRecipePairStoreError,
  type ReceptionIntakeRecipePairStore,
  type ReceptionIntakeRecipePairSummary,
} from './storage/reception-intake-recipe-pair-store.js';
import type { SellerStore } from './storage/seller-store.js';
import { deriveReceptionIntakeRecipePairBinding } from './reception-intake-recipe-pair-derivation.js';
import { deriveReceptionSchedulingRecipePairBinding } from './reception-scheduling-recipe-pair-derivation.js';
import {
  makeReceptionRecordHandlers,
  type ReceptionRecordDeps,
} from './reception-record-handler.js';
import {
  makeReceptionLookupRevokeHandlers,
  type ReceptionLookupRevokeDeps,
} from './reception-lookup-revoke-handler.js';
import {
  makeReceptionManageMintHandlers,

  type ReceptionManageMintDeps,
} from './reception-manage-mint-handler.js';
import {
  bindReceptionDoor,
  type ReceptionDoorBindDeps,
} from './reception-door-bind.js';
import { retireDoorContract } from './mint-door-contract.js';
import type { ReceptionDoorRefusal } from './reception-door-bind.js';
import type { WsClient } from './ws-server.js';
import {
  makeReceptionInboxHandlers,
  type ReceptionInboxDeps,
  type ReceptionInboxHandlers,
} from './reception-inbox-handler.js';

// ────────────────────────────────────────────────────────────────
// Deps + slice typing
// ────────────────────────────────────────────────────────────────

export interface ReceptionRpcDeps {
  readonly getStore: () => PublicEndpointRegistryStore;
  readonly getPreviewStore: () => PreviewHashStore;
  /** Source the active reception pepper. Throws when the FileVault is
   *  locked — caller surfaces as `not_configured` / 503 (mirrors the
   *  TLS-domain vault-locked posture). */
  readonly getPepper: () => Buffer;
  /** Base URL used to construct visitor-facing share URLs. Set by
   *  bin.ts from the resolved public-listener hostname; tests pin a
   *  deterministic value (`https://localhost:8443`). */
  readonly getShareBaseUrl: () => string;
  /** D-120 audit-log emitter. `createSigningAuditLog` auto-signs rows
   *  whose `action` is in `HIGH_ASSURANCE_AUDIT_KINDS` (which P3
   *  extends to include `RECEPTION_HIGH_ASSURANCE_AUDIT_KINDS`). */
  readonly auditLog: AuditLogStore;
  /** Broadcast bus emit seam. The bus assigns the cursor at emit
   *  time; the rpc supplies the kind + payload. Narrowed to the
   *  reception broadcast variants via distributive `Omit`. */
  readonly broadcast: (event: ReceptionBroadcastEvent) => void;
  /** Deterministic clock seam for tests. Production wires `Date.now`. */
  readonly now: () => number;
  /** D-149 P8 § A.5.5 — approval-intent store. When wired, the
   *  `endpoint.create` path seeds a pre-consumption intent row for
   *  every newly-created `approval_link` endpoint so the visitor
   *  consume flow has a target to flip. When absent at boot the rpc
   *  surface still accepts approval_link creates (the validator gates
   *  the config); the visitor consume path returns the substrate
   *  placeholder until the store is wired. */
  readonly getApprovalIntentStore?: () => import('./storage/reception-approval-store.js').ApprovalIntentStore;
  /** D-149 P9 § A.5.6 — status-projection store. When wired, the
   *  `endpoint.create` path seeds a 1:1 projection row for every
   *  newly-created `status_link` endpoint so the visitor GET path has
   *  a target to read. When absent at boot the rpc surface still
   *  accepts status_link creates (the validator gates the config); the
   *  visitor flow degrades to the placeholder until the store is wired. */
  readonly getStatusProjectionStore?: () => import('./storage/reception-status-projection-store.js').StatusProjectionStore;
  /** D-149 P12 § A.20.5 — Abuse Inbox per-server IP block store. When
   *  wired, `reception.abuse_inbox.list` annotates each cluster's
   *  `ip_blocked` flag + returns the block list, and `ban_ip` /
   *  `unban_ip` mutate it. When absent at boot `list` still aggregates
   *  (with an empty block list) but `ban_ip` / `unban_ip` raise
   *  `not_configured` — bin.ts wires the store unconditionally. */
  readonly getIpBlockStore?: () => import('./storage/reception-ip-block-store.js').ReceptionIpBlockStore;
  /** D-200 Slice 6g.3 — owner authoring over the compact pair registry and
   * current effective RecipeStore. Both are required for bind; get/clear need
   * only pair storage, and get reports a configured row stale without recipes. */
  readonly getIntakeRecipePairStore?: () => ReceptionIntakeRecipePairStore;
  readonly getRecipeStore?: () => import('./recipe-store.js').RecipeStore;
  /** D-221 §3.3.3 — production exposure preflight. Reception bind is the
   * owner gesture that makes a recipe non-owner reachable, so the check runs
   * before either the pair row or its door contract is written. */
  readonly preflightNonOwnerRecipeExposure?: (
    recipe: import('@recued/contracts').RecipeDefinition,
    surface: 'reception',
  ) => void;
  /** D-207 slice 1c — the DOOR-BIND seam. A pair says WHICH recipe a public form runs;
   *  the door says UNDER WHAT AUTHORITY. Minting it is the only thing that lets an
   *  anonymous submission dispatch a single op — without it every op hard-denies against
   *  `PUBLIC_CONTRACT_ID`, which grants nothing.
   *
   *  Absent ⇒ this server cannot hang a door, so `bind` REFUSES up front (`not_configured`)
   *  for any recipe that needs one, rather than writing a pair whose form looks live and
   *  kills every submission. In production the seam is present whenever the pair store is
   *  (both require the per-pair DB). The one exception that needs no door is D-200's legacy
   *  direct-checkout profile, which still owns its own submit path until Slice 3. */
  readonly getDoorBindDeps?: () => ReceptionDoorBindDeps;
  /** D-200 Slices 6g.10/6h.3b2 — exact local source reads for owner-visible claim
   * configuration readiness. Absence is projected as a closed blocker rather
   * than treating a syntactically valid locator as enrolled/readable. */
  readonly getConnectionStore?: () => Pick<ConnectionStoreSqlite, 'get'>;
  readonly getInboundFileCollection?: () => Pick<
    InboundFileCollection,
    'get' | 'readBytes'
  >;
  readonly getSellerOfferStore?: () => Pick<SellerStore, 'getOffer'>;
  /** D-149 follow-on § A.10 — override the `recued-core/personal-organizer-foundation`
   *  pack `templates/` directory `reception.template.list` reads. Production
   *  leaves it unset (the handler resolves the bundled `community/` tree
   *  via the same project-root convention as `foundation-pack-pre-install.ts`);
   *  tests pin a fixture / the repo's real templates directory. */
  readonly getTemplatesDir?: () => string;
  /** D-151 — override the Foundation pack's `config-templates/` directory
   *  (the `scheduling_link` + `reception_page` templates the same
   *  `reception.template.list` rpc carries alongside the intake ones).
   *  Production leaves it unset (resolved off the bundled `community/`
   *  tree); tests pin a fixture / the repo's real directory. */
  readonly getConfigTemplatesDir?: () => string;
  /** D-220 Slice B — the `intake_form` templates INSTALLED PACKS shipped,
   *  read from the rows the pack install persisted (`pack-reception-templates.ts`
   *  over the contract store). Wired by the composition root whenever it has
   *  the store; absent ⇒ `reception.template.list` carries empty pack arrays,
   *  which a gallery renders as "no pack templates", never as an error. */
  readonly listPackReceptionTemplates?: () => {
    readonly listings: ReadonlyArray<PackReceptionTemplateListing>;
    readonly unavailable: ReadonlyArray<PackReceptionTemplateUnavailable>;
  };
  /** D-151 P2 — intent-first Compose proposal substrate. When wired,
   *  `reception.compose.propose` routes its fixed endpoint-authoring
   *  policy through `executeRecuedRequest`; when absent the method is
   *  listed but returns a typed 503 so boot without LLM config keeps the
   *  rest of reception available. */
  readonly composePropose?: ReceptionComposeProposeDeps;
  /** Internal server-side `reception.preflight_enable` gate. Absent means
   *  disabled (legacy happy path); when wired, endpoint.enable must pass
   *  this check before flipping a public endpoint on. */
  readonly preflightEnable?: (input: ReceptionPreflightEnableInput) => ReceptionPreflightEnableResult;
}

export interface ReceptionComposeProposeDeps {
  readonly registry: PrimitiveRegistry;
  readonly persist?: ExecuteRecuedRequestContext['persist'];
  readonly safetyMatrices?: ReadonlyArray<TemplateSafetyMatrix>;
  readonly now?: () => number;
  readonly mintId?: () => string;
  readonly mintRequestId?: () => string;
  readonly defaultAiProvider?: string;
  readonly defaultAiModelId?: string;
}

export interface ReceptionComposePrimitiveRegistryOptions {
  /** Optional production `capacity_spec` deps, normally composed by
   *  `composeCapacitySpecDeps`. `reception.compose.propose` is a
   *  preview-only authoring flow and does not invoke `capacity_spec`
   *  today; this seam prevents the compose-only registry from baking in
   *  fake green probes when a future caller does intend to enforce a
   *  capacity walk. */
  readonly capacitySpecDeps?: PrimitiveRegistryDeps['capacity_spec'];
}

export interface ReceptionPreflightEnableInput {
  readonly endpoint: EndpointSummary;
  readonly now: number;
}

export interface ReceptionPreflightEnableResult {
  readonly ok: boolean;
  readonly passed?: ReadonlyArray<string>;
  readonly blocked?: ReadonlyArray<string>;
}

type ReceptionMethods =
  | 'reception.endpoints.list'
  | 'reception.endpoint.preview_draft'
  | 'reception.endpoint.create'
  | 'reception.endpoint.rotate_token'
  | 'reception.endpoint.enable'
  | 'reception.endpoint.disable'
  | 'reception.endpoint.revoke'
  | 'reception.endpoint.extend'
  | 'reception.endpoint.access_log'
  | 'reception.intake_recipe_pair.get'
  | 'reception.intake_recipe_pair.bind'
  | 'reception.intake_recipe_pair.configure'
  | 'reception.intake_recipe_pair.clear'
  | 'reception.emergency_disable_all'
  | 'reception.page.get'
  | 'reception.page.upsert'
  | 'reception.abuse_inbox.list'
  | 'reception.abuse_inbox.ban_ip'
  | 'reception.abuse_inbox.unban_ip'
  | 'reception.template.list'
  | 'reception.compose.propose';

/** D-149 P3 § A.3 — reception broadcast event variants minus the
 *  bus-assigned `cursor` field. Mirrors `ServerEventInput` in
 *  `events/bus.ts` but narrowed to the reception kinds so the rpc
 *  handler signs a closed-list emit shape. Distributive `Omit` over
 *  the discriminated union — see the comment on `ServerEventInput`
 *  for rationale (non-distributive `Omit` collapses to the
 *  intersection of shared keys). */
export type ReceptionBroadcastEvent =
  Extract<ServerEvent, { kind: 'reception.endpoint_changed' | 'reception.emergency_disabled' }> extends infer T
    ? T extends { cursor: number }
      ? Omit<T, 'cursor'>
      : never
    : never;

// ────────────────────────────────────────────────────────────────
// Caller-identity gate + helpers
// ────────────────────────────────────────────────────────────────

const requireCallerInstance = (
  caller: { instance_id: string | null | undefined } | undefined,
  method: string,
): string => {
  if (!caller?.instance_id) {
    throw new RpcError(
      'permission_denied',
      `${method}: requires a paired client (D-121); rpc dispatched from an unregistered connection`,
      403,
    );
  }
  return caller.instance_id;
};

const badRequest = (code: ReceptionRpcErrorCode | 'bad_request', message: string): RpcError =>
  new RpcError(code, message, 400);

const notFound = (method: string, endpoint_id: string): RpcError =>
  new RpcError(
    'endpoint_not_found',
    `${method}: endpoint '${endpoint_id}' not found`,
    404,
  );

// ────────────────────────────────────────────────────────────────
// Validators
// ────────────────────────────────────────────────────────────────

/** Validate a caller-supplied packet_declaration shape. Returns the
 *  parsed shape on success; throws RpcError on any failure with the
 *  closed-list error code. */
const validatePacketDeclaration = (
  raw: unknown,
  kind: ReceptionEndpointKind,
  method: string,
): { decl: PacketDeclaration; source_query_ref: SourceQueryRef } => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequest(
      'unknown_packet_kind',
      `${method}: packet_declaration must be an object`,
    );
  }
  const obj = raw as Record<string, unknown>;
  const packet_kind = obj.packet_kind;
  const expectedPacketKind = RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND[kind];
  if (typeof packet_kind !== 'string') {
    throw badRequest(
      'unknown_packet_kind',
      `${method}: packet_declaration.packet_kind must be a string`,
    );
  }
  if (packet_kind !== expectedPacketKind) {
    throw badRequest(
      'packet_kind_disallowed_for_endpoint_kind',
      `${method}: kind='${kind}' requires packet_kind='${expectedPacketKind}'; got '${packet_kind}'`,
    );
  }
  const sqParse = parseSourceQueryRef(obj.source_query_ref);
  if (!sqParse.ok) {
    throw badRequest(sqParse.code, `${method}: ${sqParse.detail}`);
  }
  const source_query_ref = sqParse.value;
  if (!isSourceQueryPermittedFor(expectedPacketKind, source_query_ref)) {
    throw badRequest(
      'source_query_disallowed_for_packet',
      `${method}: source_query_ref.kind='${source_query_ref.kind}' not permitted for packet_kind='${expectedPacketKind}'`,
    );
  }
  const decl: PacketDeclaration = {
    packet_kind: expectedPacketKind,
    source_query_ref,
  };
  if (Array.isArray(obj.fields_visible_override)) {
    const override: string[] = [];
    for (const v of obj.fields_visible_override) {
      if (typeof v !== 'string') {
        throw badRequest(
          'fields_visible_override_exceeds_ceiling',
          `${method}: fields_visible_override must be a string[]`,
        );
      }
      override.push(v);
    }
    (decl as { fields_visible_override?: ReadonlyArray<string> }).fields_visible_override =
      override;
  }
  if (Array.isArray(obj.transformations)) {
    const tx: string[] = [];
    for (const v of obj.transformations) {
      if (typeof v !== 'string') {
        throw badRequest(
          'transformation_unknown',
          `${method}: transformations must be a string[]`,
        );
      }
      tx.push(v);
    }
    (decl as { transformations?: ReadonlyArray<string> }).transformations = tx;
  }
  if (Array.isArray(obj.allowed_actions)) {
    if (kind !== 'approval_link' && obj.allowed_actions.length > 0) {
      throw badRequest(
        'allowed_action_unknown_for_kind',
        `${method}: allowed_actions only permitted for kind='approval_link'`,
      );
    }
    const acts: string[] = [];
    for (const v of obj.allowed_actions) {
      if (typeof v !== 'string') {
        throw badRequest(
          'allowed_action_unknown_for_kind',
          `${method}: allowed_actions must be a string[]`,
        );
      }
      acts.push(v);
    }
    (decl as { allowed_actions?: ReadonlyArray<string> }).allowed_actions = acts;
  }
  return { decl, source_query_ref };
};

const validateExpiresAt = (
  raw: unknown,
  kind: ReceptionEndpointKind,
  now: number,
  method: string,
): number | null => {
  // Codex review P1 #5 fold — kinds with a non-null ceiling reject BOTH
  // explicit `null` AND omitted-undefined input. Pre-fold only `null`
  // was rejected, so a caller could mint long-lived drop / approval /
  // status links by omitting expires_at entirely. The closed-list
  // RECEPTION_PER_KIND_EXPIRY_MAX_MS is the gate: `null` ⇒ kind permits
  // long-lived; any number ⇒ kind has a hard ceiling that requires an
  // explicit bounded expiry.
  const ceiling = RECEPTION_PER_KIND_EXPIRY_MAX_MS[kind];
  if (raw === undefined || raw === null) {
    if (ceiling !== null) {
      throw badRequest(
        'long_lived_not_permitted_for_kind',
        `${method}: kind='${kind}' requires explicit expires_at (≤ ${ceiling}ms ceiling); long-lived not permitted`,
      );
    }
    return null;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw badRequest('expires_at_in_past', `${method}: expires_at must be a number or null`);
  }
  if (raw <= now) {
    throw badRequest('expires_at_in_past', `${method}: expires_at must be in the future`);
  }
  if (ceiling !== null && raw - now > ceiling) {
    throw badRequest(
      'expires_at_exceeds_ceiling',
      `${method}: kind='${kind}' allows expires_at ≤ now + ${ceiling}ms; got delta=${raw - now}ms`,
    );
  }
  return raw;
};

const validateKind = (raw: unknown, method: string): ReceptionEndpointKind => {
  if (!isReceptionEndpointKind(raw)) {
    throw badRequest(
      'unknown_endpoint_kind',
      `${method}: kind must be one of ${[...RECEPTION_ENDPOINT_KIND_SET].join(', ')}; got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
};

const validateMetadata = (raw: unknown, method: string): Readonly<Record<string, unknown>> => {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequest(
      'unknown_endpoint_kind',
      `${method}: metadata must be an object when present`,
    );
  }
  return raw as Record<string, unknown>;
};

/** D-149 P5 § A.5.2 — per-kind metadata validator. The substrate's
 *  scheduling_link kind stores its `SchedulingLinkConfig` in the
 *  registry row's `metadata_blob`; validating at rpc edge keeps a
 *  corrupt blob out of the SQL store so the visitor path never sees
 *  it. Other kinds carry free-form metadata + bypass this branch. */
const validateKindMetadataConfig = (
  kind: ReceptionEndpointKind,
  metadata: Readonly<Record<string, unknown>>,
  method: string,
): void => {
  if (kind === 'scheduling_link') {
    // The scheduling_link rpc surface stores the config inside the
    // metadata blob. Empty metadata is also rejected — admins must
    // supply a config at create-time so the visitor render path has
    // something to read.
    const failures = validateSchedulingLinkConfig(metadata);
    if (failures.length > 0) {
      throw badRequest(
        'scheduling_link_config_invalid',
        `${method}: scheduling_link metadata is not a valid config: ${failures[0]!.code} — ${failures[0]!.detail}`,
      );
    }
  }
  if (kind === 'intake_form') {
    // D-149 P6 § A.5.3 — mirror the scheduling_link guard. The
    // intake_form rpc surface stores the config inside metadata_blob;
    // a corrupt config never reaches the visitor render path.
    const failures = validateIntakeFormConfig(metadata);
    if (failures.length > 0) {
      throw badRequest(
        'intake_form_config_invalid',
        `${method}: intake_form metadata is not a valid config: ${failures[0]!.code} — ${failures[0]!.detail}`,
      );
    }
  }
  if (kind === 'drop_link') {
    // D-149 P7 § A.5.4 — mirror the intake_form guard. The drop_link
    // rpc surface stores the config inside metadata_blob; a corrupt
    // config (bad MIME / oversize cap / unknown notification target)
    // never reaches the visitor render path.
    const failures = validateDropLinkConfig(metadata);
    if (failures.length > 0) {
      throw badRequest(
        'drop_link_config_invalid',
        `${method}: drop_link metadata is not a valid config: ${failures[0]!.code} — ${failures[0]!.detail}`,
      );
    }
  }
  if (kind === 'approval_link') {
    // D-149 P8 § A.5.5 — mirror the drop_link guard. The approval_link
    // rpc surface stores the config inside metadata_blob; a corrupt
    // config (unknown action_kind / oversize prompt / mismatched
    // options vs action_kind / unknown notification target) never
    // reaches the visitor render path.
    const failures = validateApprovalLinkConfig(metadata);
    if (failures.length > 0) {
      throw badRequest(
        'approval_link_config_invalid',
        `${method}: approval_link metadata is not a valid config: ${failures[0]!.code} — ${failures[0]!.detail}`,
      );
    }
  }
  if (kind === 'status_link') {
    // D-149 P9 § A.5.6 — mirror the approval_link guard. The status_link
    // rpc surface stores the config inside metadata_blob; a corrupt
    // config (unknown projection_kind / disallowed source_ref / oversize
    // override / comments_enabled=true / out-of-range refresh interval)
    // never reaches the visitor render path.
    const failures = validateStatusLinkConfig(metadata);
    if (failures.length > 0) {
      throw badRequest(
        'status_link_config_invalid',
        `${method}: status_link metadata is not a valid config: ${failures[0]!.code} — ${failures[0]!.detail}`,
      );
    }
  }
};

/** Codex review P2 fold (2026-05-13) — `packet_declaration.source_query_ref`
 *  and `StatusLinkConfig.source_ref` are both `SourceQueryRef` shapes; one
 *  drives the registry's declared source + preview hash, the other seeds
 *  the projection row the handler reads at render time. Pre-fold the two
 *  could diverge: validator passed each independently, projection seed
 *  silently followed `metadata.source_ref`, the registry kept the
 *  declared `source_query_ref`. The visitor would see the projection's
 *  entity while the substrate declared a different one.
 *
 *  Fix: cross-check the two at preview_draft + create. They MUST match
 *  on `kind` AND the per-kind id field (`task_id` / `note_id` /
 *  `commitment_id` / `project_id` / `event_id` / `list_id` /
 *  `itinerary_id`). Mismatch surfaces as `status_link_config_invalid`
 *  with the closed-list `source_ref_mismatch_with_packet_declaration`
 *  detail code so the UX can localize the message. */
const STATUS_LINK_SOURCE_REF_ID_FIELD_BY_KIND: Readonly<Record<string, string>> = {
  'data.task': 'task_id',
  'data.note': 'note_id',
  'data.commitment': 'commitment_id',
  'data.project': 'project_id',
  'data.event': 'event_id',
  'data.packing_list': 'list_id',
  'data.itinerary': 'itinerary_id',
};

const crossCheckStatusLinkSources = (
  kind: ReceptionEndpointKind,
  declSource: SourceQueryRef,
  metadata: Readonly<Record<string, unknown>>,
  method: string,
): void => {
  if (kind !== 'status_link') return;
  const metaSource = (metadata as { source_ref?: unknown }).source_ref;
  if (!metaSource || typeof metaSource !== 'object' || Array.isArray(metaSource)) {
    // validateStatusLinkConfig already rejected this shape; defensive
    // bail keeps the cross-check guard noiseless.
    return;
  }
  const m = metaSource as Record<string, unknown>;
  if (m.kind !== declSource.kind) {
    throw badRequest(
      'status_link_config_invalid',
      `${method}: status_link metadata.source_ref.kind='${String(m.kind)}' must match packet_declaration.source_query_ref.kind='${declSource.kind}'`,
    );
  }
  const idField = STATUS_LINK_SOURCE_REF_ID_FIELD_BY_KIND[declSource.kind];
  if (typeof idField !== 'string') return;
  const declId = (declSource as unknown as Record<string, unknown>)[idField];
  const metaId = m[idField];
  if (declId !== metaId) {
    throw badRequest(
      'status_link_config_invalid',
      `${method}: status_link metadata.source_ref.${idField} must match packet_declaration.source_query_ref.${idField}`,
    );
  }
};

const validateEndpointId = (raw: unknown, method: string): string => {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw notFound(method, JSON.stringify(raw));
  }
  return raw;
};

const longLivedAck = (expires_at: number | null, now: number): number | null =>
  expires_at === null ? now : null;

const PREVIEW_ENDPOINT_ID = '__reception_preview__';
const PREVIEW_BEARER_SECRET = 'preview-token';
const PREVIEW_FORM_NONCE = 'preview-form-nonce';
const PREVIEW_FALLBACK_TZ = 'UTC';

const LOCAL_SHARE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const requirePublicShareBaseUrl = (deps: ReceptionRpcDeps, method: string): string => {
  const raw = deps.getShareBaseUrl().trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new RpcError(
      'not_configured',
      `${method}: set RECUED_PUBLIC_BASE_URL or configure a verified public hostname before sharing reception endpoints`,
      503,
    );
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.hostname.length === 0 ||
    LOCAL_SHARE_HOSTS.has(parsed.hostname.toLowerCase())
  ) {
    throw new RpcError(
      'not_configured',
      `${method}: set RECUED_PUBLIC_BASE_URL or configure a verified public hostname before sharing reception endpoints`,
      503,
    );
  }
  return raw;
};

const runPreflightEnable = (
  deps: ReceptionRpcDeps,
  endpoint: EndpointSummary,
  now: number,
  method: string,
): void => {
  const result = deps.preflightEnable?.({ endpoint, now });
  if (!result || result.ok) return;
  const reason = result.blocked && result.blocked.length > 0
    ? result.blocked.join('; ')
    : 'preflight failed';
  throw new RpcError(
    'not_configured',
    `${method}: reception.preflight_enable blocked endpoint enable: ${reason}`,
    503,
  );
};

const previewEndpointContext = (kind: ReceptionPacketKind): ReceptionEndpointContext => ({
  endpoint_id: PREVIEW_ENDPOINT_ID,
  kind,
});

const previewPacketOpts = (now: number): Parameters<typeof buildReceptionPacket>[3] => ({
  now,
  randomToken: () => PREVIEW_BEARER_SECRET,
});

const slotsForPreviewRender = (
  candidates: ReadonlyArray<SchedulingSlotCandidate>,
): ReadonlyArray<SchedulingSlot> =>
  candidates.map((c) => ({
    start_at: c.start_at,
    end_at: c.end_at,
    duration_minutes: c.duration_minutes,
    display_label: c.display_label,
  }));

const previewStatusEntityRow = (displayName: string): Readonly<Record<string, unknown>> => ({
  title: `${displayName} preview`,
  state: 'Open',
  due_at_relative: 'today',
  counterparty_first_name_initial: 'A.',
  date: 'Today',
  location_label: 'Preview location',
  tz_label: PREVIEW_FALLBACK_TZ,
  agenda_summary: 'Preview agenda',
  visible_attendees: ['Recipient'],
  open_commitment_count: 1,
  last_activity_at_relative: 'just now',
  milestone_summary: 'Preview milestone',
  packed_count: 1,
  total_count: 3,
  items: ['Preview item'],
  date_range: { start_at: Date.UTC(2026, 0, 1), end_at: Date.UTC(2026, 0, 2) },
  visible_legs: [
    { origin: 'Home', destination: 'Destination', mode: 'Flight', time: '9:00 AM' },
  ],
  summary: 'Preview summary',
  updated_at_relative: 'just now',
  tags: ['preview'],
});

const refreshSecondsForPreview = (
  config: NonNullable<ReturnType<typeof parseStatusLinkConfig>>,
): number | undefined => {
  const policy = config.refresh_policy;
  if (!policy.auto_refresh_enabled) return undefined;
  return typeof policy.refresh_interval_seconds === 'number'
    ? policy.refresh_interval_seconds
    : undefined;
};

const renderDraftPreviewHtml = (input: {
  kind: ReceptionEndpointKind;
  decl: PacketDeclaration;
  expires_at: number | null;
  metadata: Readonly<Record<string, unknown>>;
  now: number;
}): string => {
  switch (input.kind) {
    case 'reception_page': {
      const config = input.metadata as unknown as ReceptionPageConfig;
      const source = assembleReceptionPageSourceView(config);
      if (!source) return renderReceptionPagePlaceholderHtml(PREVIEW_FALLBACK_TZ);
      const built = buildReceptionPacket(
        'reception_page_packet',
        buildReceptionPagePacketRawInput(source),
        previewEndpointContext('reception_page_packet'),
        previewPacketOpts(input.now),
      );
      const renderInput: ReceptionPageRenderInput = {
        display_name: built.payload.display_name,
        tagline: built.payload.tagline,
        tz_label: built.payload.tz_label,
        preferred_contact_methods: built.payload.preferred_contact_methods,
        cta_buttons: built.payload.cta_buttons,
        trust_footer: null,
        ...(built.payload.avatar_url !== undefined ? { avatar_url: built.payload.avatar_url } : {}),
        ...(built.payload.response_time_estimate !== undefined
          ? { response_time_estimate: built.payload.response_time_estimate }
          : {}),
        ...(config.custom_links !== undefined && config.sections_enabled?.custom_links === true
          ? { custom_links: config.custom_links }
          : {}),
        ...(config.link_buttons !== undefined && config.sections_enabled?.link_buttons === true
          ? { link_buttons: config.link_buttons }
          : {}),
      };
      return renderReceptionPageHtml(renderInput);
    }
    case 'scheduling_link': {
      const config = parseSchedulingLinkConfig(input.metadata);
      if (!config) return renderSchedulingLinkPlaceholderHtml(PREVIEW_FALLBACK_TZ);
      const { window_start, window_end } = computeSchedulingLookAheadWindow({
        config,
        now: input.now,
      });
      const raw = buildSchedulingLinkPacketRawInput({
        calendar_events: [],
        window_start,
        window_end,
        tz: config.available_window_definition.tz,
        duration_options: config.duration_options_minutes,
        required_visitor_fields: config.required_visitor_fields,
        min_advance_notice_hours: config.min_advance_notice_hours,
        max_lead_time_days: config.max_lead_time_days,
      });
      const built = buildReceptionPacket(
        'scheduling_link_packet',
        raw,
        previewEndpointContext('scheduling_link_packet'),
        previewPacketOpts(input.now),
      );
      const activeDuration =
        config.duration_options_minutes[0] ?? built.payload.duration_options[0] ?? 30;
      const freeWindows = intersectWithAvailabilityWindows({
        free_windows: built.payload.free_windows,
        explicit_windows: config.available_window_definition.explicit_windows ?? [],
        tz: built.payload.tz,
        window_start,
        window_end,
      });
      const candidates = enumerateSchedulingSlots({
        free_windows: freeWindows,
        duration_minutes: activeDuration,
        tz: built.payload.tz,
        min_advance_notice_hours: built.payload.min_advance_notice_hours,
        max_lead_time_days: built.payload.max_lead_time_days,
        now: input.now,
      });
      return renderSchedulingLinkHtml({
        display_name: config.display_name,
        tz_label: built.payload.tz,
        free_windows: built.payload.free_windows,
        duration_options: built.payload.duration_options,
        slots: slotsForPreviewRender(candidates),
        required_visitor_fields: built.payload.required_visitor_fields,
        min_advance_notice_hours: built.payload.min_advance_notice_hours,
        max_lead_time_days: built.payload.max_lead_time_days,
        endpoint_id: PREVIEW_ENDPOINT_ID,
        bearer_secret: PREVIEW_BEARER_SECRET,
        form_nonce: PREVIEW_FORM_NONCE,
        active_duration_minutes: activeDuration,
        trust_footer: null,
        ...(config.instructions !== undefined ? { instructions: config.instructions } : {}),
      });
    }
    case 'intake_form': {
      const config = parseIntakeFormConfig(input.metadata);
      if (!config) return renderIntakeFormPlaceholderHtml();
      const source = buildIntakeFormSourceView(
        config,
        `Submissions are rate-limited at ${config.anti_spam.rate_limit_per_ip}/hour per IP.`,
      );
      const built = buildReceptionPacket(
        'intake_form_packet',
        buildIntakeFormPacketRawInput(source),
        previewEndpointContext('intake_form_packet'),
        previewPacketOpts(input.now),
      );
      const visibleNames = new Set(
        built.payload.form_definition.visitor_visible_fields.map((f) => f.name),
      );
      return renderIntakeFormHtml({
        display_name: config.display_name,
        ...(config.instructions ? { instructions: config.instructions } : {}),
        fields: config.form_definition.fields.filter((f) => visibleNames.has(f.name)),
        honeypot_fields: config.anti_spam.honeypot_fields,
        visitor_email_requirement: config.required_visitor_fields.email,
        submit_button_label:
          config.submit_button_label ?? INTAKE_FORM_DEFAULT_SUBMIT_BUTTON_LABEL,
        endpoint_id: PREVIEW_ENDPOINT_ID,
        bearer_secret: PREVIEW_BEARER_SECRET,
        form_nonce: PREVIEW_FORM_NONCE,
        trust_footer: null,
      });
    }
    case 'drop_link': {
      const config = parseDropLinkConfig(input.metadata);
      if (!config) return renderDropLinkPlaceholderHtml();
      const source = buildDropLinkSourceView(config);
      buildReceptionPacket(
        'drop_link_packet',
        buildDropLinkPacketRawInput(source),
        previewEndpointContext('drop_link_packet'),
        previewPacketOpts(input.now),
      );
      return renderDropLinkHtml({
        display_name: config.display_name,
        ...(config.instructions ? { instructions: config.instructions } : {}),
        visitor_name_requirement: config.required_visitor_fields.name,
        visitor_email_requirement: config.required_visitor_fields.email,
        visitor_description_requirement: config.required_visitor_fields.description,
        submit_button_label:
          config.submit_button_label ?? DROP_LINK_DEFAULT_SUBMIT_BUTTON_LABEL,
        size_cap_bytes: config.size_cap_bytes,
        allowed_mime_types: config.allowed_mime_types,
        endpoint_id: PREVIEW_ENDPOINT_ID,
        bearer_secret: PREVIEW_BEARER_SECRET,
        form_nonce: PREVIEW_FORM_NONCE,
        trust_footer: null,
      });
    }
    case 'approval_link': {
      const config = parseApprovalLinkConfig(input.metadata);
      if (!config) return renderApprovalLinkPlaceholderHtml();
      const source = buildApprovalLinkSourceView(config, input.expires_at, input.now);
      buildReceptionPacket(
        'approval_link_packet',
        buildApprovalLinkPacketRawInput(source),
        previewEndpointContext('approval_link_packet'),
        previewPacketOpts(input.now),
      );
      return renderApprovalLinkHtml({
        display_name: config.display_name,
        action_kind: config.action_kind,
        prompt: config.prompt,
        context_summary: config.context_raw.summary,
        visitor_field_constraints: config.visitor_field_constraints,
        expiry_display: source.expiry_display,
        submit_button_label:
          config.submit_button_label ?? APPROVAL_LINK_DEFAULT_SUBMIT_BUTTON_LABEL,
        endpoint_id: PREVIEW_ENDPOINT_ID,
        bearer_secret: PREVIEW_BEARER_SECRET,
        form_nonce: PREVIEW_FORM_NONCE,
        trust_footer: null,
        ...(config.options !== undefined ? { options: config.options } : {}),
      });
    }
    case 'status_link': {
      const config = parseStatusLinkConfig(input.metadata);
      if (!config) return renderStatusLinkPlaceholderHtml();
      const source = buildStatusLinkSourceView(
        config,
        previewStatusEntityRow(config.display_name),
        input.now,
        input.now,
      );
      const built = buildReceptionPacket(
        'status_link_packet',
        buildStatusLinkPacketRawInput(source),
        previewEndpointContext('status_link_packet'),
        previewPacketOpts(input.now),
      );
      return renderStatusLinkHtml({
        display_name: config.display_name,
        projection_kind: built.payload.projection_kind,
        visible_fields: built.payload.visible_fields,
        last_updated_at_relative: built.payload.last_updated_at_relative,
        updates_visible: built.payload.updates_visible,
        comments_enabled: built.payload.comments_enabled,
        trust_footer: null,
        ...(config.caption !== undefined ? { caption: config.caption } : {}),
        ...(refreshSecondsForPreview(config) !== undefined
          ? { refresh_interval_seconds: refreshSecondsForPreview(config) }
          : {}),
      });
    }
  }
};

// ────────────────────────────────────────────────────────────────
// Audit emission
// ────────────────────────────────────────────────────────────────

const emitAuditRow = async (
  deps: ReceptionRpcDeps,
  input: {
    action: ReceptionHighAssuranceAuditKind;
    target: string;
    detail: string;
    actor_instance_id: string;
    /** Codex P2 fold — extra activity_id discriminator. The id is
     *  derived from `action`-`now()`-`target`; for endpoint-lifecycle
     *  rows the `(action, endpoint_id)` pair is unique per millisecond
     *  (one endpoint = one create / enable / revoke). The Abuse Inbox
     *  IP ban / unban rows break that assumption — many `(endpoint_id,
     *  *)` rows share an action + endpoint_id, so a same-millisecond
     *  burst would collide on the id + the audit store (which preserves
     *  supplied ids) would overwrite the earlier row. Ban / unban pass
     *  the `source_ip_hash` here so every mutation lands a distinct
     *  forensic row. D-200 pair bind/configure/clear can also repeat for the same
     *  endpoint inside one tick, so those mutations pass a random suffix. */
    id_suffix?: string;
  },
): Promise<void> => {
  // `createSigningAuditLog` (wired downstream in bin.ts) auto-signs
  // every action in the closed-list HIGH_ASSURANCE_AUDIT_KINDS set.
  // P3 extended that set to include RECEPTION_HIGH_ASSURANCE_AUDIT_KINDS
  // verbatim — the audit-signing wrapper covers the reception rows
  // without a second predicate import here.
  const activity_id =
    input.id_suffix !== undefined && input.id_suffix.length > 0
      ? `${input.action}-${deps.now()}-${input.target}-${input.id_suffix}`
      : `${input.action}-${deps.now()}-${input.target}`;
  await deps.auditLog.logActivity({
    activity_id,
    timestamp: deps.now(),
    action: input.action,
    target: input.target,
    detail: input.detail,
    // The wrapper sets reserve: true at sign time; setting it here too
    // keeps the row classification consistent across the path.
    reserve: true,
  });
};

const bumpAuditAndEmit = async (
  deps: ReceptionRpcDeps,
  input: {
    action: ReceptionHighAssuranceAuditKind;
    endpoint_id: string;
    detail: string;
    actor_instance_id: string;
    audit_id_suffix?: string;
    broadcast_op?:
      | 'create'
      | 'enable'
      | 'disable'
      | 'revoke'
      | 'extend'
      | 'rotate_token'
      | 'pair_bind'
      | 'pair_configure'
      | 'pair_clear';
  },
): Promise<void> => {
  deps.getStore().bumpAuditCounter(input.endpoint_id, deps.now());
  await emitAuditRow(deps, {
    action: input.action,
    target: input.endpoint_id,
    detail: input.detail,
    actor_instance_id: input.actor_instance_id,
    ...(input.audit_id_suffix !== undefined
      ? { id_suffix: input.audit_id_suffix }
      : {}),
  });
  if (input.broadcast_op) {
    deps.broadcast({
      kind: 'reception.endpoint_changed',
      op: input.broadcast_op,
      endpoint_id: input.endpoint_id,
    });
  }
};

// ────────────────────────────────────────────────────────────────
// Handler implementations
// ────────────────────────────────────────────────────────────────

export const handleReceptionEndpointsList = async (
  deps: ReceptionRpcDeps,
  args: ReceptionEndpointsListFilter | undefined,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<ReceptionEndpointsListResult> => {
  const method = 'reception.endpoints.list';
  requireCallerInstance(caller, method);
  const filter: {
    kind?: ReceptionEndpointKind;
    enabled?: boolean;
    include_revoked?: boolean;
  } = {};
  if (args?.kind !== undefined) {
    filter.kind = validateKind(args.kind, method);
  }
  if (args?.enabled !== undefined) {
    if (typeof args.enabled !== 'boolean') {
      throw badRequest('unknown_endpoint_kind', `${method}: enabled must be boolean when present`);
    }
    filter.enabled = args.enabled;
  }
  if (args?.include_revoked !== undefined) {
    if (typeof args.include_revoked !== 'boolean') {
      throw badRequest(
        'unknown_endpoint_kind',
        `${method}: include_revoked must be boolean when present`,
      );
    }
    filter.include_revoked = args.include_revoked;
  }
  const endpoints = deps.getStore().list(filter);
  return { endpoints };
};

export const handleReceptionEndpointPreviewDraft = async (
  deps: ReceptionRpcDeps,
  args: ReceptionEndpointPreviewInput,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<ReceptionEndpointPreviewResult> => {
  const method = 'reception.endpoint.preview_draft';
  requireCallerInstance(caller, method);
  const kind = validateKind(args.kind, method);
  const { decl } = validatePacketDeclaration(args.packet_declaration, kind, method);
  const now = deps.now();
  const expires_at = validateExpiresAt(args.expires_at, kind, now, method);
  const metadata = validateMetadata(args.metadata, method);
  validateKindMetadataConfig(kind, metadata, method);
  crossCheckStatusLinkSources(kind, decl.source_query_ref, metadata, method);

  // The substrate-side `visible_fields` projection comes from D-145's
  // closed `PACKET_FIELDS_VISIBLE` registry. The rendered preview is built
  // through the same per-kind packet transformations + HTML renderers used
  // by the visitor path, with inert preview endpoint/token values.
  const previewInput: {
    kind: ReceptionEndpointKind;
    packet_declaration: PacketDeclaration;
    expires_at?: number | null;
    metadata?: Readonly<Record<string, unknown>>;
  } = { kind, packet_declaration: decl };
  if (args.expires_at !== undefined) previewInput.expires_at = expires_at;
  if (args.metadata !== undefined) previewInput.metadata = metadata;

  const hash = computePreviewHash(previewInput);
  const stamp = deps.getPreviewStore().remember({ hash, now });
  // Codex review P2 #1 fold — when no fields_visible_override, the
  // endpoint exposes `PACKET_FIELDS_VISIBLE[packet_kind]` by default
  // (D-145 PB12 substrate). Returning `[]` from preview under-reports
  // the visitor-visible surface and undermines the preview-hash
  // approval gate Pass-3 ships. Surface the closed-list default so
  // Mary's confirmation UI shows what the visitor will actually see.
  const visible_fields = decl.fields_visible_override
    ?? PACKET_FIELDS_VISIBLE[decl.packet_kind]
    ?? [];
  // D-149 P12 § A.20.2 — the View-As-Visitor panel. Built from the same
  // validated `kind` + `packet_declaration` + `expires_at` the preview
  // hash commits to, so a later edit to the rendered surface re-runs
  // preview + re-derives the panel. `synthetic: true` is hard-coded by
  // `buildViewAsVisitorPanel` — the panel can never be mistaken for a
  // real visitor access-log entry.
  const view_as_visitor = buildViewAsVisitorPanel({
    kind,
    packet_declaration: decl,
    expires_at: expires_at ?? null,
    now,
  });
  // ── D-220 Slice A2c — the advisory half ─────────────────────────────────────
  //
  // The same computation `create` gates on, reported one step earlier so the
  // owner fixes the form while still editing. It also surfaces the two cases
  // create deliberately does NOT refuse (`all_forms` / `this_form_filtered`),
  // which is the whole reason an advisory channel exists: those are real risks
  // the substrate should NOT decide on the owner's behalf.
  //
  // ⚠ `blocks_create` is computed from the SAME predicate `create` uses, not
  // re-derived from the scope alone — a renderer that shows "this will be
  // refused" must agree with the thing that does the refusing.
  const previewIntakeView = intakeFormViewFromMetadata(kind, metadata);
  const previewConflicts = previewIntakeView === null
    ? null
    : formContractConflicts(deps, previewIntakeView.form_definition_id, previewIntakeView.form);
  const form_contract_advisories = previewConflicts === null
    ? undefined
    : [
        ...previewConflicts.blocking.map((c) => ({ ...c, blocks_create: true })),
        ...previewConflicts.advisory.map((c) => ({ ...c, blocks_create: false })),
      ];

  return {
    html: renderDraftPreviewHtml({
      kind,
      decl,
      expires_at,
      metadata,
      now,
    }),
    visible_fields,
    preview_hash: hash,
    expires_at: stamp.expires_at,
    view_as_visitor,
    ...(form_contract_advisories === undefined || form_contract_advisories.length === 0
      ? {}
      : { form_contract_advisories }),
  };
};

// ────────────────────────────────────────────────────────────────
// D-220 Slice A2c — create-time gates over an intake form's field set
// ────────────────────────────────────────────────────────────────

/** The live intake_form endpoint already claiming `form_definition_id`, or null.
 *
 *  ⚠ REVOKED endpoints are deliberately ignored. `form_definition_id` is an
 *  owner-typed free-text field and there is no update rpc — revoke-and-recreate
 *  IS the only way to edit a form, and an owner doing that reuses the id on
 *  purpose so the recipes armed on it stay pointed at it. Refusing every reuse
 *  would break the only editing path there is. What must never happen is TWO
 *  LIVE forms claiming one id: a `form_response.accepted` trigger filters on the
 *  id alone, so it would fire for both, and the second form's differently-named
 *  answers would read as nothing. */
const liveIntakeFormClaimingDefinitionId = (
  deps: ReceptionRpcDeps,
  form_definition_id: string,
): string | null => {
  const store = deps.getStore?.();
  if (!store) return null;
  // ⚠ `include_revoked: true` is DELIBERATE, and the skip below is the real
  // filter. `list()` already excludes revoked rows by default, so relying on
  // that default would leave this function's central property — "reuse after
  // revoke is allowed, because that is the edit path" — resting on a filter
  // default that never mentions it, and a mutation removing the skip would
  // survive. Asking for everything and excluding revoked HERE makes the
  // intent explicit and the guard load-bearing. `kind` still filters in SQL.
  for (const endpoint of store.list({ kind: 'intake_form', include_revoked: true })) {
    if (endpoint.revoked_at !== null) continue;
    const config = parseIntakeFormConfig(endpoint.metadata);
    if (config?.form_definition.form_definition_id === form_definition_id) {
      return endpoint.endpoint_id;
    }
  }
  return null;
};

export interface FormContractConflict {
  readonly recipe_id: string;
  readonly scope: FormResponseTriggerFormScope;
  readonly mismatches: ReadonlyArray<{ readonly code: string; readonly field_name: string }>;
}

/** Which already-armed recipes this form's field set would break.
 *
 *  The reverse of the bind-time check: there the form exists and the recipe is
 *  being wired, here the recipes exist and the FORM is being created. Both are
 *  needed because either act can be the later one.
 *
 *  ⛔ `this_form` and `this_form_filtered` BLOCK; only `all_forms` is advisory:
 *   - `all_forms` — an unscoped trigger with a required field contract would
 *     otherwise let ONE recipe veto every future form on the server. That is a
 *     contradiction for its author to resolve, not a reason to refuse an
 *     unrelated form.
 *   - `this_form_filtered` — ⚠ was exempted on "it may never fire here", which
 *     adversarial review (Codex, 2026-07-29) disproved: an accepted-response
 *     event carries BOTH `endpoint_id` and `form_definition_id`, compiled into
 *     exact equality filters, so a trigger naming this form plus its live
 *     endpoint fires with certainty. A filter narrows WHICH responses match; the
 *     contract still has to hold for those.
 *
 *  Scans `listStored()` only — one query over the SQLite rows. Bundled pack
 *  recipes are inert by contract (`isInstalledFormResponseWorkflowTemplate`
 *  requires empty `event_triggers`), so an ARMED trigger only ever exists on a
 *  stored clone. A corrupt stored row is SKIPPED rather than failing the create:
 *  one bad row must not make the owner unable to publish a form. */
const formContractConflicts = (
  deps: ReceptionRpcDeps,
  form_definition_id: string,
  form: FormFieldContractFormView,
): { readonly blocking: FormContractConflict[]; readonly advisory: FormContractConflict[] } => {
  const blocking: FormContractConflict[] = [];
  const advisory: FormContractConflict[] = [];
  const recipes = deps.getRecipeStore?.();
  // No recipe store ⇒ no recipes to conflict with (dbless / one-shot CLI). There
  // is nothing to fail closed ABOUT: the check compares against a set that is
  // empty by construction, not one it failed to read.
  if (!recipes) return { blocking, advisory };
  for (const row of recipes.listStored()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.recipe_json);
    } catch {
      continue;
    }
    const scope = recipeFormResponseScope(parsed, form_definition_id);
    if (scope === null) continue;
    const declared = (parsed as { metadata?: { requires_form_fields?: unknown } })
      .metadata?.requires_form_fields;
    if (!Array.isArray(declared)) continue;
    const verdict = evaluateFormFieldContract(
      declared as ReadonlyArray<RecipeFormFieldRequirement>,
      form,
    );
    const mismatches = [...verdict.blocking, ...verdict.advisory]
      .map((m) => ({ code: m.code, field_name: m.field_name }));
    if (mismatches.length === 0) continue;
    const conflict: FormContractConflict = { recipe_id: row.recipe_id, scope, mismatches };
    // A required-field mismatch on a trigger that NAMES this form is certain
    // breakage whether or not it carries an extra filter; only an unscoped
    // trigger is reported rather than refused.
    if (scope !== 'all_forms' && verdict.blocking.length > 0) blocking.push(conflict);
    else advisory.push(conflict);
  }
  return { blocking, advisory };
};

/** The form-definition id + field view for an intake_form create/preview, or
 *  null for any other endpoint kind. */
const intakeFormViewFromMetadata = (
  kind: ReceptionEndpointKind,
  metadata: Readonly<Record<string, unknown>>,
): { readonly form_definition_id: string; readonly form: FormFieldContractFormView } | null => {
  if (kind !== 'intake_form') return null;
  const config = parseIntakeFormConfig(metadata);
  if (config === null) return null;
  return {
    form_definition_id: config.form_definition.form_definition_id,
    form: config.form_definition as unknown as FormFieldContractFormView,
  };
};

export const handleReceptionEndpointCreate = async (
  deps: ReceptionRpcDeps,
  args: ReceptionEndpointCreateInput,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<ReceptionEndpointCreateResult> => {
  const method = 'reception.endpoint.create';
  const actor = requireCallerInstance(caller, method);
  const kind = validateKind(args.kind, method);
  const { decl } = validatePacketDeclaration(args.packet_declaration, kind, method);
  const now = deps.now();
  const expires_at = validateExpiresAt(args.expires_at, kind, now, method);
  const metadata = validateMetadata(args.metadata, method);
  validateKindMetadataConfig(kind, metadata, method);
  crossCheckStatusLinkSources(kind, decl.source_query_ref, metadata, method);
  if (typeof args.preview_hash !== 'string' || args.preview_hash.length === 0) {
    throw badRequest('preview_hash_missing', `${method}: preview_hash is required (Pass-3)`);
  }

  // ── D-220 Slice A2c — two gates over the form this create would publish ─────
  //
  // Placed here, before the preview-hash round-trip, because both are properties
  // of the SHAPE the owner submitted rather than of the preview ceremony, and a
  // refusal should not depend on whether their hash is still fresh.
  const intakeView = intakeFormViewFromMetadata(kind, metadata);
  if (intakeView !== null) {
    // (3) One id, one live form. See `liveIntakeFormClaimingDefinitionId` for why
    // revoked endpoints are excluded — reuse after revoke is the edit path.
    const clash = liveIntakeFormClaimingDefinitionId(deps, intakeView.form_definition_id);
    if (clash !== null) {
      throw new RpcError(
        'form_definition_id_already_live',
        `${method}: endpoint '${clash}' is already live with form definition id `
          + `'${intakeView.form_definition_id}'. A recipe armed on that id filters on the id alone, `
          + 'so two live forms would both fire it and the second form\'s answers would read as '
          + 'nothing. Revoke the other endpoint first, or choose a different id.',
        409,
        method,
        { conflicting_endpoint_id: clash, form_definition_id: intakeView.form_definition_id },
      );
    }
    // (1) Does this form still feed the recipes already armed on its id?
    const conflicts = formContractConflicts(deps, intakeView.form_definition_id, intakeView.form);
    if (conflicts.blocking.length > 0) {
      throw new RpcError(
        'form_contract_breaks_armed_recipe',
        `${method}: this form omits answers a recipe already armed on `
          + `'${intakeView.form_definition_id}' reads, so every submission would store nothing. `
          + `Nothing was created. Affected: ${conflicts.blocking
            .map((c) => `${c.recipe_id} (${c.mismatches.map((m) => m.field_name).join(', ')})`)
            .join('; ')}`,
        409,
        method,
        { blocking: conflicts.blocking, advisory: conflicts.advisory },
      );
    }
  }

  // Recompute the hash from the supplied shape; mismatch → reject.
  const previewInput: {
    kind: ReceptionEndpointKind;
    packet_declaration: PacketDeclaration;
    expires_at?: number | null;
    metadata?: Readonly<Record<string, unknown>>;
  } = { kind, packet_declaration: decl };
  if (args.expires_at !== undefined) previewInput.expires_at = expires_at;
  if (args.metadata !== undefined) previewInput.metadata = metadata;
  const expected = computePreviewHash(previewInput);
  if (expected !== args.preview_hash) {
    throw badRequest(
      'preview_hash_mismatch',
      `${method}: preview_hash does not match canonical serialization of the supplied input`,
    );
  }
  const validateRes = deps.getPreviewStore().validate({ hash: args.preview_hash, now });
  if (validateRes === 'preview_hash_unknown') {
    throw badRequest(
      'preview_hash_mismatch',
      `${method}: preview_hash unknown — re-run preview_draft to mint a fresh hash`,
    );
  }
  if (validateRes === 'preview_hash_expired') {
    throw badRequest(
      'preview_hash_expired',
      `${method}: preview_hash expired (10-min TTL) — re-run preview_draft`,
    );
  }

  const shareBaseUrl = requirePublicShareBaseUrl(deps, method);

  // Mint the endpoint_id + bearer; HMAC store.
  const endpoint_id = generateEndpointId();
  const bearer_secret = generateBearerSecret();
  const bearer_secret_hmac = computeBearerHmac(bearer_secret, deps.getPepper());
  const created = deps.getStore().create({
    endpoint_id,
    kind,
    packet_declaration: decl,
    bearer_secret_hmac,
    created_at: now,
    created_by_client_id: actor,
    expires_at,
    long_lived_acknowledged_at: longLivedAck(expires_at, now),
    metadata,
  });

  // D-149 P8 § A.5.5 — seed a pre-consumption row in
  // `reception_approval_intent` for every new approval_link endpoint
  // so the visitor consume flow has a target to atomically flip. The
  // intent_id is derived from the endpoint_id (1:1 binding) so a
  // future rotate / re-issue can find the same row without storing
  // an extra mapping. Skipped when the optional store isn't wired
  // (visitor flow degrades to placeholder until bin.ts wires the
  // store).
  if (kind === 'approval_link' && deps.getApprovalIntentStore !== undefined) {
    const approvalConfig = metadata as {
      action_kind?: unknown;
      on_action?: { target_id?: unknown };
    };
    const action_kind =
      typeof approvalConfig.action_kind === 'string'
        ? (approvalConfig.action_kind as import('@recued/contracts').ApprovalLinkActionKind)
        : 'answer_question';
    const target_id =
      approvalConfig.on_action &&
      typeof approvalConfig.on_action.target_id === 'string' &&
      approvalConfig.on_action.target_id.length > 0
        ? approvalConfig.on_action.target_id
        : null;
    deps.getApprovalIntentStore().create({
      intent_id: endpoint_id,
      endpoint_id,
      action_kind,
      target_id,
    });
  }

  // D-149 P9 § A.5.6 — seed a 1:1 projection row in
  // `reception_status_projection` for every new status_link endpoint
  // so the visitor GET path has a target to resolve. The projection_id
  // is derived from the endpoint_id (1:1 binding) so a future rotate /
  // re-issue can find the same row without storing an extra mapping.
  // Skipped when the optional store isn't wired (visitor flow degrades
  // to placeholder until bin.ts wires the store). The metadata has
  // already passed `validateStatusLinkConfig` above so every required
  // field is structurally present.
  //
  // Codex review P2 fold (2026-05-13) — derive the entity ref from the
  // PARSED packet_declaration (`decl.source_query_ref`), not from
  // `metadata.source_ref`. Pre-fold the two were validated independently
  // + the projection seed silently followed `metadata.source_ref`, so a
  // mismatched config (validator passed both shapes) would publish a
  // projection that rendered a different entity than the registry's
  // declared source. The cross-check above (`crossCheckStatusLinkSources`)
  // already guarantees the two match by this point; using
  // `decl.source_query_ref` as the canonical source closes the leak
  // path defense-in-depth.
  if (kind === 'status_link' && deps.getStatusProjectionStore !== undefined) {
    const statusConfig = metadata as unknown as import('@recued/contracts').StatusLinkConfig;
    const declRef = decl.source_query_ref;
    const refRecord = declRef as unknown as Record<string, string>;
    const idFieldByKind: Record<string, string> = {
      'data.task': 'task_id',
      'data.note': 'note_id',
      'data.commitment': 'commitment_id',
      'data.project': 'project_id',
      'data.event': 'event_id',
      'data.packing_list': 'list_id',
      'data.itinerary': 'itinerary_id',
    };
    const idKey = idFieldByKind[declRef.kind];
    const source_entity_id =
      typeof idKey === 'string' && typeof refRecord[idKey] === 'string'
        ? refRecord[idKey]
        : '';
    deps.getStatusProjectionStore().create({
      projection_id: endpoint_id,
      endpoint_id,
      projection_kind: statusConfig.projection_kind,
      source_entity_kind: declRef.kind,
      source_entity_id,
      ...(statusConfig.fields_visible_override !== undefined
        ? { fields_visible_override: statusConfig.fields_visible_override }
        : {}),
      refresh_policy: statusConfig.refresh_policy,
      comments_enabled: statusConfig.comments_enabled,
      shows_update_history: statusConfig.shows_update_history,
    });
  }

  await bumpAuditAndEmit(deps, {
    action: 'endpoint.created',
    endpoint_id,
    detail: `kind=${kind}, packet_kind=${decl.packet_kind}, expires_at=${expires_at ?? 'null'}`,
    actor_instance_id: actor,
    broadcast_op: 'create',
  });

  const share_url_once = buildShareUrl({
    base_url: shareBaseUrl,
    kind,
    endpoint_id,
    bearer_secret,
  });
  return {
    endpoint_id: created.endpoint_id,
    public_locator: created.endpoint_id,
    bearer_secret_once: bearer_secret,
    share_url_once,
    enabled: created.enabled,
  };
};

export const handleReceptionEndpointRotateToken = async (
  deps: ReceptionRpcDeps,
  args: ReceptionEndpointRotateInput,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<ReceptionEndpointRotateResult> => {
  const method = 'reception.endpoint.rotate_token';
  const actor = requireCallerInstance(caller, method);
  const endpoint_id = validateEndpointId(args.endpoint_id, method);
  const reason = args.reason;
  const summary = deps.getStore().findById(endpoint_id);
  if (!summary) throw notFound(method, endpoint_id);
  if (summary.revoked_at !== null) {
    throw new RpcError(
      'endpoint_already_revoked',
      `${method}: endpoint '${endpoint_id}' is revoked; rotate not allowed`,
      409,
    );
  }
  const shareBaseUrl = requirePublicShareBaseUrl(deps, method);
  const new_secret = generateBearerSecret();
  const new_hmac = computeBearerHmac(new_secret, deps.getPepper());
  const outcome = deps.getStore().rotateToken({
    endpoint_id,
    new_bearer_secret_hmac: new_hmac,
    now: deps.now(),
  });
  if (outcome === 'not_found') throw notFound(method, endpoint_id);
  if (outcome === 'already_revoked') {
    throw new RpcError(
      'endpoint_already_revoked',
      `${method}: endpoint '${endpoint_id}' is revoked; rotate not allowed`,
      409,
    );
  }
  await bumpAuditAndEmit(deps, {
    action: 'endpoint.token_rotated',
    endpoint_id,
    detail: `reason=${reason ?? 'unspecified'}`,
    actor_instance_id: actor,
    broadcast_op: 'rotate_token',
  });
  const share_url_once = buildShareUrl({
    base_url: shareBaseUrl,
    kind: summary.kind,
    endpoint_id,
    bearer_secret: new_secret,
  });
  return { bearer_secret_once: new_secret, share_url_once };
};

const applyMutation = async (
  deps: ReceptionRpcDeps,
  args: ReceptionEndpointMutationInput,
  caller: { instance_id: string | null | undefined } | undefined,
  method: string,
  outcome:
    | 'enable'
    | 'disable',
): Promise<{ ok: true }> => {
  const actor = requireCallerInstance(caller, method);
  const endpoint_id = validateEndpointId(args.endpoint_id, method);
  const store = deps.getStore();
  const now = deps.now();
  const summary = store.findById(endpoint_id);
  if (!summary) throw notFound(method, endpoint_id);
  if (outcome === 'enable' && !summary.enabled && summary.revoked_at === null) {
    runPreflightEnable(deps, summary, now, method);
  }
  const result = outcome === 'enable' ? store.enable(endpoint_id, now) : store.disable(endpoint_id, now);
  if (result === 'not_found') throw notFound(method, endpoint_id);
  if (result === 'already_revoked') {
    throw new RpcError(
      'endpoint_already_revoked',
      `${method}: endpoint '${endpoint_id}' is revoked`,
      409,
    );
  }
  if (result === 'already_enabled') {
    throw new RpcError(
      'endpoint_already_enabled',
      `${method}: endpoint '${endpoint_id}' is already enabled`,
      409,
    );
  }
  if (result === 'already_disabled') {
    throw new RpcError(
      'endpoint_already_disabled',
      `${method}: endpoint '${endpoint_id}' is already disabled`,
      409,
    );
  }
  await bumpAuditAndEmit(deps, {
    action: outcome === 'enable' ? 'endpoint.enabled' : 'endpoint.disabled',
    endpoint_id,
    detail: outcome === 'enable' ? 'enabled by operator' : 'disabled by operator',
    actor_instance_id: actor,
    broadcast_op: outcome,
  });
  return { ok: true };
};

export const handleReceptionEndpointEnable = async (
  deps: ReceptionRpcDeps,
  args: ReceptionEndpointMutationInput,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<{ ok: true }> => {
  return applyMutation(deps, args, caller, 'reception.endpoint.enable', 'enable');
};

export const handleReceptionEndpointDisable = async (
  deps: ReceptionRpcDeps,
  args: ReceptionEndpointMutationInput,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<{ ok: true }> => {
  return applyMutation(deps, args, caller, 'reception.endpoint.disable', 'disable');
};

export const handleReceptionEndpointRevoke = async (
  deps: ReceptionRpcDeps,
  args: ReceptionEndpointRevokeInput,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<{ ok: true }> => {
  const method = 'reception.endpoint.revoke';
  const actor = requireCallerInstance(caller, method);
  const endpoint_id = validateEndpointId(args.endpoint_id, method);
  const reason = typeof args.reason === 'string' ? args.reason : null;
  const result = deps.getStore().revoke({ endpoint_id, now: deps.now(), reason });
  if (result === 'not_found') throw notFound(method, endpoint_id);
  if (result === 'already_revoked') {
    throw new RpcError(
      'endpoint_already_revoked',
      `${method}: endpoint '${endpoint_id}' is already revoked`,
      409,
    );
  }
  await bumpAuditAndEmit(deps, {
    action: 'endpoint.revoked',
    endpoint_id,
    detail: `reason=${reason ?? 'unspecified'}`,
    actor_instance_id: actor,
    broadcast_op: 'revoke',
  });
  return { ok: true };
};

export const handleReceptionEndpointExtend = async (
  deps: ReceptionRpcDeps,
  args: ReceptionEndpointExtendInput,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<{ ok: true }> => {
  const method = 'reception.endpoint.extend';
  const actor = requireCallerInstance(caller, method);
  const endpoint_id = validateEndpointId(args.endpoint_id, method);
  const summary = deps.getStore().findById(endpoint_id);
  if (!summary) throw notFound(method, endpoint_id);
  const now = deps.now();
  // The substrate validator gates the per-kind ceiling BEFORE the
  // store call so we never pollute the row with a value the registry
  // would reject downstream.
  const new_expires_at = validateExpiresAt(args.new_expires_at, summary.kind, now, method);
  const result = deps.getStore().extend({ endpoint_id, new_expires_at, now });
  if (result === 'not_found') throw notFound(method, endpoint_id);
  if (result === 'already_revoked') {
    throw new RpcError(
      'endpoint_revoked_cannot_extend',
      `${method}: endpoint '${endpoint_id}' is revoked; extend not allowed`,
      409,
    );
  }
  await bumpAuditAndEmit(deps, {
    action: 'endpoint.extended',
    endpoint_id,
    detail: `new_expires_at=${new_expires_at ?? 'null'}`,
    actor_instance_id: actor,
    broadcast_op: 'extend',
  });
  return { ok: true };
};

export const handleReceptionEndpointAccessLog = async (
  deps: ReceptionRpcDeps,
  args: ReceptionEndpointAccessLogInput,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<ReceptionEndpointAccessLogResult> => {
  const method = 'reception.endpoint.access_log';
  requireCallerInstance(caller, method);
  const endpoint_id = validateEndpointId(args.endpoint_id, method);
  if (args.since !== undefined && (typeof args.since !== 'number' || !Number.isFinite(args.since))) {
    throw badRequest('unknown_endpoint_kind', `${method}: since must be a finite number`);
  }
  if (args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isFinite(args.limit) || args.limit <= 0)) {
    throw badRequest('unknown_endpoint_kind', `${method}: limit must be a positive number`);
  }
  const summary = deps.getStore().findById(endpoint_id);
  if (!summary) throw notFound(method, endpoint_id);
  const readInput: { endpoint_id: string; since?: number; limit?: number } = { endpoint_id };
  if (args.since !== undefined) readInput.since = args.since;
  if (args.limit !== undefined) readInput.limit = args.limit;
  const entries: ReadonlyArray<AccessLogEntry> = deps.getStore().readAccessLog(readInput);
  return { entries };
};

// ────────────────────────────────────────────────────────────────
// D-200 Slices 6g.3/6g.11 — owner-only intake-form/recipe pair authoring
// ────────────────────────────────────────────────────────────────

const PAIR_GET_KEYS = new Set(['endpoint_id']);
const PAIR_BIND_KEYS = new Set(['endpoint_id', 'recipe_id', 'expected_updated_at']);
/** D-207 slice 1c — the owner has seen the capability widening and accepts it. OPTIONAL:
 *  a first bind and a narrowing never send it, and the closed-args check is an exact key-set
 *  match, so listing it as required would reject every caller that omits it. */
const PAIR_BIND_OPTIONAL_KEYS = new Set(['confirm_capability', 'standing_closure']);
const PAIR_CONFIGURE_KEYS = new Set([
  'endpoint_id',
  'expected_updated_at',
  'expected_pair_revision',
  'configuration',
]);
const PAIR_CLEAR_KEYS = new Set([
  'endpoint_id',
  'expected_status',
  'expected_updated_at',
  'expected_pair_revision',
]);

const NO_OPTIONAL_PAIR_KEYS: ReadonlySet<string> = new Set();

/** Closed args: every REQUIRED key present, every key known, nothing else admitted.
 *
 *  `optional` exists because the check is an EXACT key-set match, so merely listing a key
 *  as allowed makes it mandatory — which is how D-207's `confirm_capability` silently broke
 *  every existing `bind` caller the moment it was added to the required set. An optional key
 *  may be omitted; it may never be unknown. */
const requireClosedPairArgs = (
  raw: unknown,
  allowed: ReadonlySet<string>,
  method: string,
  optional: ReadonlySet<string> = NO_OPTIONAL_PAIR_KEYS,
): Record<string, unknown> => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequest('intake_recipe_pair_invalid', `${method}: args must be an object`);
  }
  const input = raw as Record<string, unknown>;
  const keys = Object.keys(input);
  const unknownKey = keys.some((key) => !allowed.has(key) && !optional.has(key));
  const missingRequired = [...allowed].some((key) => !keys.includes(key));
  if (unknownKey || missingRequired) {
    throw badRequest(
      'intake_recipe_pair_invalid',
      `${method}: args must contain exactly ${[...allowed].join(', ')}`
      + (optional.size > 0 ? ` (optional: ${[...optional].join(', ')})` : ''),
    );
  }
  return input;
};

const requireIntakePairStore = (
  deps: ReceptionRpcDeps,
  method: string,
): ReceptionIntakeRecipePairStore => {
  const store = deps.getIntakeRecipePairStore?.();
  if (!store) {
    throw new RpcError(
      'not_configured',
      `${method}: intake recipe pair store is not configured`,
      503,
    );
  }
  return store;
};

/** The endpoint for a pair rpc that serves EVERY pairable kind (`get` / `bind` / `clear`).
 *
 *  ⛔ Derives from the contracts' `RECEPTION_PAIR_CONSUMER` rather than listing kinds here —
 *  the webclient reads the SAME const to decide whether to offer the button, and a second
 *  list would eventually offer a control this refuses. */
const requirePairableEndpoint = (
  deps: ReceptionRpcDeps,
  endpoint_id: string,
  method: string,
): EndpointSummary => {
  const endpoint = deps.getStore().findById(endpoint_id);
  if (!endpoint) throw notFound(method, endpoint_id);
  if (!isReceptionPairableKind(endpoint.kind)) {
    throw new RpcError(
      'intake_recipe_pair_wrong_endpoint_kind',
      `${method}: endpoint '${endpoint_id}' is '${endpoint.kind}', which has nothing that runs `
      + 'a paired recipe — binding one would save a row nothing reads',
      409,
    );
  }
  return endpoint;
};

/** The endpoint for a pair rpc that is genuinely FORM-ONLY.
 *
 *  ⚠ Not the same question as `requirePairableEndpoint`, and the difference is load-bearing:
 *  `configure` authors a D-200 CLAIM CONFIGURATION, which is a property of an intake form's
 *  fields, not of pairing. A `scheduling_link` is pairable and has no claim to configure, so
 *  it must still be refused here. Widening the shared guard would have opened this rpc too.
 *  [[enumerate_asymmetric_guards_before_unifying_gates]] */
const requireIntakeEndpoint = (
  deps: ReceptionRpcDeps,
  endpoint_id: string,
  method: string,
): EndpointSummary => {
  const endpoint = deps.getStore().findById(endpoint_id);
  if (!endpoint) throw notFound(method, endpoint_id);
  if (endpoint.kind !== 'intake_form') {
    throw new RpcError(
      'intake_recipe_pair_wrong_endpoint_kind',
      `${method}: endpoint '${endpoint_id}' is '${endpoint.kind}', not 'intake_form'`,
      409,
    );
  }
  return endpoint;
};

/** D-210 R-2 slice 4 — derive the pair binding for ONE endpoint, whatever kind it is.
 *
 *  The kind fork lives HERE, once, because a pair's subject is per-kind but everything the
 *  rpcs do with the result — compare it to the stored row, prove the recipe id, mint the door
 *  from its closure — is not. The deriver a kind gets is the SAME one its runtime consumer
 *  re-derives with (`resolveReceptionIntakeRecipePair` for a form, the drain's
 *  `resolveReceptionSchedulingRecipePair` for a booking), which is what keeps a bind from
 *  writing a row its own consumer would immediately read as `stale`.
 *
 *  `config_incompatible` is distinct from `pair_incompatible`: the ENDPOINT's own config is
 *  unusable (unparseable, or a form whose declared source disagrees with it), rather than a
 *  usable config that cannot pair with this recipe. */
type EndpointPairDerivation =
  | { readonly kind: 'ready'; readonly binding: ReceptionPairBinding }
  | { readonly kind: 'recipe_invalid' }
  | { readonly kind: 'pair_incompatible' }
  | { readonly kind: 'config_incompatible' };

const deriveEndpointPairBinding = (
  endpoint: EndpointSummary,
  recipe: RecipeDefinition,
): EndpointPairDerivation => {
  switch (endpoint.kind) {
    case 'intake_form': {
      const config = intakePairConfigFor(endpoint);
      if (config === null) return { kind: 'config_incompatible' };
      return deriveReceptionIntakeRecipePairBinding({ form_config: config, recipe });
    }
    case 'scheduling_link': {
      const config = parseSchedulingLinkConfig(endpoint.metadata);
      if (config === null) return { kind: 'config_incompatible' };
      // ⛔ `required_visitor_fields` ONLY — the owner-ruled digest subject. Durations,
      // windows and copy change what the VISITOR sees, never what the recipe RECEIVES.
      return deriveReceptionSchedulingRecipePairBinding({
        required_visitor_fields: config.required_visitor_fields,
        recipe,
      });
    }
    default:
      // Unreachable through `requirePairableEndpoint`, which refuses every kind with no
      // consumer. Fail closed rather than assume the two lists agree.
      return { kind: 'config_incompatible' };
  }
};

const intakePairConfigFor = (
  endpoint: EndpointSummary,
): import('@recued/contracts').IntakeFormConfig | null => {
  const config = parseIntakeFormConfig(endpoint.metadata);
  if (config === null) return null;
  const declaration = endpoint.packet_declaration;
  const source = declaration.source_query_ref;
  if (declaration.packet_kind !== 'intake_form_packet'
    || source.kind !== 'reception_form_definition'
    || source.form_definition_id !== config.form_definition.form_definition_id) {
    return null;
  }
  return config;
};

function pairView(
  endpoint_id: string,
  status: 'ready',
  pair: ReceptionIntakeRecipePairSummary,
  claim_configuration_readiness: ReceptionIntakeRecipePairClaimConfigurationReadiness,
  claim_configuration_authoring: ReceptionIntakeRecipePairClaimConfigurationAuthoring,
): Extract<ReceptionIntakeRecipePairView, { readonly status: 'ready'; readonly pair_subject: 'form' }>;
/** D-210 R-2 slice 4 — a ready SCHEDULING pair: no claim configuration, by construction.
 *  The overload takes none rather than accepting `undefined`, so a caller cannot reach the
 *  scheduling arm by simply forgetting the claim a form pair owes. */
function pairView(
  endpoint_id: string,
  status: 'ready',
  pair: ReceptionIntakeRecipePairSummary,
): Extract<ReceptionIntakeRecipePairView, { readonly status: 'ready' }>;
function pairView(
  endpoint_id: string,
  status: 'unpaired',
  pair: null,
): Extract<ReceptionIntakeRecipePairView, { readonly status: 'unpaired' }>;
function pairView(
  endpoint_id: string,
  status: 'stale',
  pair: ReceptionIntakeRecipePairSummary | null,
): Extract<ReceptionIntakeRecipePairView, { readonly status: 'stale' }>;
function pairView(
  endpoint_id: string,
  status: ReceptionIntakeRecipePairView['status'],
  pair: ReceptionIntakeRecipePairSummary | null,
  claim_configuration_readiness?: ReceptionIntakeRecipePairClaimConfigurationReadiness,
  claim_configuration_authoring?: ReceptionIntakeRecipePairClaimConfigurationAuthoring,
): ReceptionIntakeRecipePairView {
  if (pair === null) {
    return {
      endpoint_id,
      status: status === 'stale' ? 'stale' : 'unpaired',
      binding: null,
      created_at: null,
      updated_at: null,
    };
  }
  // ── D-210 R-2 slice 4 — the v3 branch the slice-3b comment promised ──────────────────
  //
  // The store has been general since the owner-ruled rebuild, and since slice 4 this rpc
  // serves every PAIRABLE kind, so a scheduling binding here is no longer a kind mismatch —
  // it is a booking page's pair, and the view describes it on its own arm.
  //
  // ⛔ `pair_subject` is DERIVED from the binding right here, at the single constructor, and
  // never passed in beside it. It exists only because TypeScript cannot narrow a union on a
  // nested discriminant (`view.binding.version`); the binding remains the truth.
  if (isReceptionSchedulingPairBinding(pair.binding)) {
    // ⛔ NO claim configuration, and no throw when it is absent: a scheduling pair has no
    // claim to configure (D-200 slice 6g.11 claims are a property of an intake form's
    // FIELDS). A caller that passed one would be describing a form.
    if (status === 'ready') {
      return {
        endpoint_id,
        status: 'ready',
        pair_subject: 'scheduling',
        binding: pair.binding,
        created_at: pair.created_at,
        updated_at: pair.updated_at,
      };
    }
    return {
      endpoint_id,
      status: 'stale',
      binding: pair.binding,
      created_at: pair.created_at,
      updated_at: pair.updated_at,
    };
  }
  // Neither variant ⇒ a row that decodes as no binding this substrate knows. The store's own
  // reader would have thrown; this is the belt on that brace. Answer with the view's
  // "there is a row, but nothing here can back it" arm rather than describe it.
  if (!isReceptionFormPairBinding(pair.binding)) {
    return {
      endpoint_id,
      status: 'stale',
      binding: null,
      created_at: null,
      updated_at: null,
    };
  }
  if (status === 'ready') {
    if (claim_configuration_readiness === undefined
      || claim_configuration_authoring === undefined) {
      throw new Error('ready intake recipe pair view requires readiness and authoring projections');
    }
    return {
      endpoint_id,
      status: 'ready',
      pair_subject: 'form',
      binding: pair.binding,
      claim_configuration_readiness,
      claim_configuration_authoring,
      created_at: pair.created_at,
      updated_at: pair.updated_at,
    };
  }
  return {
    endpoint_id,
    status: 'stale',
    binding: pair.binding,
    created_at: pair.created_at,
    updated_at: pair.updated_at,
  };
}

/** D-207 slice 1c — why this recipe cannot back a public door, in the owner's words.
 *
 *  Each refusal is the same underlying fault: the recipe's dispatch targets are not
 *  knowable until runtime, so its op closure — the "this form may: …" list the owner is
 *  asked to consent to — could not be derived honestly. Saying so at BIND is the whole
 *  point: the alternative is a form that looks live and kills every submission at the
 *  first ungranted op, with the visitor eating the failure. */
const describeDoorRefusal = (refusal: ReceptionDoorRefusal): string => {
  switch (refusal.reason) {
    case 'dispatch_unresolvable':
      return `this recipe cannot be lowered to the exact operations and account bindings the public form would run: ${refusal.detail}`;
    case 'dynamic_dispatch':
      return `step '${refusal.step_id}' chooses what to run at runtime (${refusal.field}), so what this form could do is not knowable in advance. A public form must be statically analyzable.`;
    case 'dynamic_connection':
      return `step '${refusal.step_id}' resolves its connection at runtime (${refusal.ref}), so which account it would use is not knowable in advance.`;
    case 'literal_connection':
      return `step '${refusal.step_id}' names a connection directly ('${refusal.ref}'). A connection is a slot filled by the pack's enrollment, never hard-coded in a recipe.`;
    case 'cost_step_limit':
      return `this recipe has ${refusal.steps} steps, above the public-form limit of ${refusal.max_steps}. Split the workflow or keep it owner-run so one anonymous submission cannot spend unbounded work.`;
    case 'cost_dynamic_fanout':
      return `step '${refusal.step_id}' uses foreach. A public form cannot bind a step whose dispatch count expands with runtime data; replace the fan-out with a bounded server operation or keep this recipe owner-run.`;
    case 'cost_unknown_dispatch_kind':
      return `step '${refusal.step_id}' runs '${refusal.target}', but this server cannot classify its execution kind. The public-form cost gate cannot prove it is non-AI, so binding fails closed.`;
    // D-207 slice 3c. Say the whole causal chain, because the owner's instinct will be that
    // an approval queue is a fine place for this write to sit — and it is, on a form that
    // owes the visitor nothing. The point they need is that a HELD run produces NO OUTPUT,
    // so on THIS form the write does not merely wait: it silently eats the response.
    case 'write_on_responding_door': {
      const owed = refusal.responds === 'sells'
        ? 'this form sells an offer, so a visitor who submits it is expecting a way to pay'
        : 'this form renders a response, so a visitor who submits it is expecting to be shown something';
      const what = refusal.risk === undefined
        ? `step '${refusal.step_id}' runs '${refusal.op}', whose risk this server cannot determine, so it cannot be shown to be safe on a public form`
        : `step '${refusal.step_id}' runs '${refusal.op}', which is a '${refusal.risk}' operation`;
      return `${what}. A public visitor is not allowed to authorize that, so it would pause for your approval — and a paused run produces no response at all. ${owed}, and they would get a bare thank-you page instead, every single time. Either remove that step, or drop the response so this becomes a plain intake form (the submission is still recorded, and the step still runs once you approve it).`;
    }
  }
};

/** D-207 slice 1c — hang the door on a written pair.
 *
 *  The pair says WHICH recipe a public form runs. On its own that is INERT: an anonymous
 *  dispatch carrying no `contract_id` floors to `PUBLIC_CONTRACT_ID`, which grants nothing,
 *  so every op hard-denies. THIS is what makes the form actually run — and every byte of the
 *  authority it grants is derived from the saved recipe, never from anything the caller
 *  sent. The caller's only say is `confirm_capability`: whether the owner has SEEN the list.
 *
 *  A `needs_consent` or `refused` outcome leaves the pair saved and the door SHUT. That is
 *  the fail-closed intermediate state by design — a form with no door denies, it never
 *  opens. */
const bindPairDoor = (
  doorDeps: ReceptionDoorBindDeps,
  input: {
    readonly endpoint_id: string;
    readonly recipe_id: string;
    readonly recipe: RecipeDefinition;
    readonly actor: string;
    readonly confirm_capability: boolean;
    readonly standing_closure: boolean;
  },
): ReceptionDoorBindView => {
  const result = bindReceptionDoor(
    {
      endpointId: input.endpoint_id,
      recipeId: input.recipe_id,
      recipe: input.recipe,
      mintedBy: input.actor,
      confirmed: input.confirm_capability,
      ...(input.standing_closure ? { standingClosure: true } : {}),
    },
    doorDeps,
  );
  if (result.kind === 'refused') {
    return {
      status: 'refused',
      reason: result.refusal.reason,
      step_id: result.refusal.step_id,
      detail: describeDoorRefusal(result.refusal),
    };
  }
  if (result.kind === 'needs_consent') {
    return {
      status: 'needs_consent',
      added: result.added,
      removed: result.removed,
      operation_ids: result.capability.operation_ids,
      asks_anyway: result.asks_anyway,
    };
  }
  return {
    status: 'bound',
    contract_id: result.contract_id,
    operation_ids: result.capability.operation_ids,
    unchanged: result.unchanged,
  };
};

const blockedClaimConfigurationReadiness = (
  configuration: ReceptionIntakeRecipePairClaimConfigurationReadiness['configuration'],
  rawBlockers: readonly ReceptionIntakeRecipePairClaimConfigurationBlockerCode[],
): ReceptionIntakeRecipePairClaimConfigurationReadiness => {
  const blockers = [...new Set(rawBlockers)];
  const [first, ...rest] = blockers;
  return {
    status: 'blocked',
    configuration,
    blockers: first === undefined
      ? ['claim_configuration_invalid']
      : [first, ...rest],
  };
};

const stripeConnectionReadinessBlocker = (
  store: Pick<ConnectionStoreSqlite, 'get'>,
  connectionName: string,
): ReceptionIntakeRecipePairClaimConfigurationBlockerCode | null => {
  try {
    const connection = store.get('api', connectionName);
    if (connection === null) return 'stripe_connection_missing';
    if (connection.kind !== 'api' || connection.name !== connectionName) {
      return 'stripe_connection_source_mismatch';
    }
    return resolveConnectionVendor(connection) === 'stripe'
      ? null
      : 'stripe_connection_not_stripe';
  } catch {
    return 'stripe_connection_lookup_unavailable';
  }
};

const sellerOfferReadinessBlocker = (
  store: Pick<SellerStore, 'getOffer'>,
  offerId: string,
  recipeId: string,
): ReceptionIntakeRecipePairClaimConfigurationBlockerCode | null => {
  try {
    const offer = store.getOffer(offerId);
    if (offer === null) return 'seller_offer_missing';
    if (!isPaidDocumentDirectCheckoutSellerOfferSource(offer, offerId)) {
      return 'seller_offer_source_mismatch';
    }
    return paidDocumentDirectCheckoutSellerOfferRecipeAuthorized(offer, recipeId)
      ? null
      : 'seller_offer_recipe_mismatch';
  } catch {
    return 'seller_offer_lookup_unavailable';
  }
};

const claimConfigurationRecipeId = (recipe: unknown): string | null => {
  try {
    if (recipe === null || typeof recipe !== 'object' || Array.isArray(recipe)) {
      return null;
    }
    const recipeId = Reflect.get(recipe, 'recipe_id');
    return typeof recipeId === 'string'
      && recipeId.length > 0
      && recipeId.length <= RECEPTION_PAIR_RECIPE_ID_MAX_LENGTH
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(recipeId)
      ? recipeId
      : null;
  } catch {
    return null;
  }
};

/** Source-prove only the recipe-pinned deployment configuration. This remains
 * distinct from mapper eligibility and does not authorize a provider attempt:
 * the later post-insert coordinator must re-read the same sources when a claim
 * is born. */
export const receptionIntakeRecipePairClaimConfigurationReadiness = async (
  deps: Pick<
    ReceptionRpcDeps,
    'getConnectionStore' | 'getInboundFileCollection' | 'getSellerOfferStore'
  >,
  recipe: unknown,
): Promise<ReceptionIntakeRecipePairClaimConfigurationReadiness> => {
  const resolution = resolvePaidDocumentDirectCheckoutClaimConfiguration(recipe);
  if (resolution.kind === 'missing') {
    return blockedClaimConfigurationReadiness(null, ['claim_configuration_missing']);
  }
  if (resolution.kind === 'invalid') {
    return blockedClaimConfigurationReadiness(null, ['claim_configuration_invalid']);
  }

  const configuration = resolution.configuration;
  const blockers: ReceptionIntakeRecipePairClaimConfigurationBlockerCode[] = [];

  let connectionStore: Pick<ConnectionStoreSqlite, 'get'> | undefined;
  try {
    connectionStore = deps.getConnectionStore?.();
  } catch {
    connectionStore = undefined;
  }
  if (connectionStore === undefined) {
    blockers.push('stripe_connection_lookup_unavailable');
  } else {
    const blocker = stripeConnectionReadinessBlocker(
      connectionStore,
      configuration.stripe_connection_name,
    );
    if (blocker !== null) blockers.push(blocker);
  }

  let files: Pick<InboundFileCollection, 'get' | 'readBytes'> | undefined;
  try {
    files = deps.getInboundFileCollection?.();
  } catch {
    files = undefined;
  }
  if (files === undefined) {
    blockers.push('template_lookup_unavailable');
  } else {
    const template = await loadPaidDocumentDirectCheckoutTemplateClaim(
      files,
      configuration.template_file_ref,
    );
    blockers.push(...template.blockers);
  }

  // Connection storage is synchronous, but it may mutate while the template
  // CAS read yields. Re-probe an initially-ready exact row after that await.
  if (connectionStore !== undefined
    && !blockers.some((blocker) => blocker.startsWith('stripe_connection_'))) {
    const blocker = stripeConnectionReadinessBlocker(
      connectionStore,
      configuration.stripe_connection_name,
    );
    if (blocker !== null) blockers.push(blocker);
  }

  // A v2 locator is not ready merely because its syntax is valid. Re-read the
  // core Seller row after template I/O and prove that this exact recipe owns a
  // creator-or-fulfillment route. Exact mapped terms remain submission-derived
  // and are therefore rechecked only when a new claim is born.
  if (configuration.version === 2) {
    const recipeId = claimConfigurationRecipeId(recipe);
    if (recipeId === null) {
      blockers.push('seller_offer_recipe_mismatch');
    } else {
      let sellerStore: Pick<SellerStore, 'getOffer'> | undefined;
      try {
        sellerStore = deps.getSellerOfferStore?.();
      } catch {
        sellerStore = undefined;
      }
      if (sellerStore === undefined) {
        blockers.push('seller_offer_lookup_unavailable');
      } else {
        const blocker = sellerOfferReadinessBlocker(
          sellerStore,
          configuration.seller_offer_id,
          recipeId,
        );
        if (blocker !== null) blockers.push(blocker);
      }
    }
  }

  if (blockers.length > 0) {
    return blockedClaimConfigurationReadiness(configuration, blockers);
  }
  return { status: 'ready', configuration, blockers: [] };
};

/** The template source proof above may await encrypted CAS I/O. Re-prove the
 * pair after that yield so a concurrent recipe/form re-save or rebind cannot
 * turn an old readiness snapshot into a current `ready` response. */
const receptionIntakeRecipePairStillCurrent = (
  deps: ReceptionRpcDeps,
  pairStore: ReceptionIntakeRecipePairStore,
  recipeStore: import('./recipe-store.js').RecipeStore,
  observed: ReceptionIntakeRecipePairSummary,
): boolean => {
  try {
    const current = pairStore.findByEndpoint(observed.endpoint_id);
    if (current === null
      || current.created_at !== observed.created_at
      || current.updated_at !== observed.updated_at
      || !receptionPairBindingEquals(
        current.binding,
        observed.binding,
      )) {
      return false;
    }
    const endpoint = deps.getStore().findById(observed.endpoint_id);
    // ⛔ STAYS `intake_form`, and D-210 R-2 slice 4 did not widen it. This helper re-proves a
    // pair across the CLAIM projection's encrypted-CAS yield, and only a form pair has a
    // claim — both callers early-return for a scheduling pair before reaching here, because
    // that path never yields and so has no race to close. The check is now an INVARIANT
    // (a scheduling pair arriving means a caller lost its fork), not the kind gate.
    if (endpoint === null || endpoint.kind !== 'intake_form') return false;
    const config = intakePairConfigFor(endpoint);
    if (config === null) return false;
    const recipe = recipeStore.get(observed.binding.recipe_id);
    if (recipe === null) return false;
    const derived = deriveReceptionIntakeRecipePairBinding({
      form_config: config,
      recipe,
    });
    return derived.kind === 'ready'
      && receptionPairBindingEquals(
        observed.binding,
        derived.binding,
      );
  } catch {
    return false;
  }
};

/** Project editability from the effective RecipeStore source, then derive the
 * observed pair from that returned snapshot too. This second derivation keeps
 * a source/provenance race from showing an editable badge for bytes that no
 * longer back the ready pair. */
const receptionIntakeRecipePairClaimConfigurationAuthoring = (
  recipes: import('./recipe-store.js').RecipeStore,
  formConfig: import('@recued/contracts').IntakeFormConfig,
  pair: ReceptionIntakeRecipePairSummary,
): ReceptionIntakeRecipePairClaimConfigurationAuthoring => {
  try {
    if (typeof recipes.inspectLocalRecipeEdit !== 'function') {
      return { status: 'unavailable' };
    }
    const inspection = recipes.inspectLocalRecipeEdit(pair.binding.recipe_id);
    if (inspection.kind === 'unavailable') return { status: 'unavailable' };
    const derived = deriveReceptionIntakeRecipePairBinding({
      form_config: formConfig,
      recipe: inspection.recipe,
    });
    if (derived.kind !== 'ready'
      || !receptionPairBindingEquals(
        pair.binding,
        derived.binding,
      )) {
      return { status: 'unavailable' };
    }
    return inspection.kind === 'editable'
      ? { status: 'editable' }
      : { status: 'fork_required' };
  } catch {
    return { status: 'unavailable' };
  }
};

const requireRecipeId = (raw: unknown, method: string): string => {
  if (typeof raw !== 'string'
    || raw.length === 0
    || raw.length > RECEPTION_PAIR_RECIPE_ID_MAX_LENGTH
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(raw)) {
    throw badRequest(
      'intake_recipe_pair_invalid',
      `${method}: recipe_id must be a canonical saved recipe id`,
    );
  }
  return raw;
};

const requireExpectedPairToken = (raw: unknown, method: string): number | null => {
  if (raw === null) return null;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw badRequest(
      'intake_recipe_pair_invalid',
      `${method}: expected_updated_at must be null or a non-negative safe integer`,
    );
  }
  return raw;
};

const requireClearPairObservation = (
  input: Readonly<Record<string, unknown>>,
  method: string,
): {
  expected_status: ReceptionIntakeRecipePairView['status'];
  expected_updated_at: number | null;
  expected_pair_revision: string | null;
} => {
  const expected_status = input.expected_status;
  if (expected_status !== 'unpaired'
    && expected_status !== 'ready'
    && expected_status !== 'stale') {
    throw badRequest(
      'intake_recipe_pair_invalid',
      `${method}: expected_status must be unpaired, ready, or stale`,
    );
  }
  const expected_updated_at = requireExpectedPairToken(
    input.expected_updated_at,
    method,
  );
  const rawRevision = input.expected_pair_revision;
  const expected_pair_revision = rawRevision === null
    ? null
    : isReceptionPairRevision(rawRevision)
      ? rawRevision
      : undefined;
  if (expected_pair_revision === undefined) {
    throw badRequest(
      'intake_recipe_pair_invalid',
      `${method}: expected_pair_revision must be null or an exact pair revision`,
    );
  }
  const hasNullLocators = expected_updated_at === null
    && expected_pair_revision === null;
  const hasExactLocators = expected_updated_at !== null
    && expected_pair_revision !== null;
  const observationIsClosed = expected_status === 'unpaired'
    ? hasNullLocators
    : expected_status === 'ready'
      ? hasExactLocators
      : hasNullLocators || hasExactLocators;
  if (!observationIsClosed) {
    throw badRequest(
      'intake_recipe_pair_invalid',
      `${method}: expected status, clock, and pair revision must come from one get result`,
    );
  }
  return {
    expected_status,
    expected_updated_at,
    expected_pair_revision,
  };
};

const requireConfigurePairObservation = (
  input: Readonly<Record<string, unknown>>,
  method: string,
): {
  readonly expected_updated_at: number;
  readonly expected_pair_revision: string;
  readonly configuration: import('@recued/contracts').PaidDocumentDirectCheckoutClaimConfiguration;
} => {
  const expected_updated_at = requireExpectedPairToken(
    input.expected_updated_at,
    method,
  );
  if (expected_updated_at === null) {
    throw badRequest(
      'intake_recipe_pair_invalid',
      `${method}: expected_updated_at must identify an observed ready pair`,
    );
  }
  if (!isReceptionPairRevision(input.expected_pair_revision)) {
    throw badRequest(
      'intake_recipe_pair_invalid',
      `${method}: expected_pair_revision must be an exact pair revision`,
    );
  }
  const configuration = resolvePaidDocumentDirectCheckoutClaimConfiguration({
    metadata: {
      [PAID_DOCUMENT_DIRECT_CHECKOUT_CONFIGURATION_METADATA_KEY]: input.configuration,
    },
  });
  if (configuration.kind !== 'configured') {
    throw badRequest(
      'intake_recipe_pair_invalid',
      `${method}: configuration must be the closed v1 or v2 direct-checkout block`,
    );
  }
  return {
    expected_updated_at,
    expected_pair_revision: input.expected_pair_revision,
    configuration: configuration.configuration,
  };
};

export const handleReceptionIntakeRecipePairGet = async (
  deps: ReceptionRpcDeps,
  args: ReceptionIntakeRecipePairGetInput,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<ReceptionIntakeRecipePairGetResult> => {
  const method = 'reception.intake_recipe_pair.get';
  requireCallerInstance(caller, method);
  const input = requireClosedPairArgs(args, PAIR_GET_KEYS, method);
  const endpoint_id = validateEndpointId(input.endpoint_id, method);
  const endpoint = requirePairableEndpoint(deps, endpoint_id, method);
  const store = requireIntakePairStore(deps, method);
  let stored: ReceptionIntakeRecipePairSummary | null;
  try {
    stored = store.findByEndpoint(endpoint_id);
  } catch (error) {
    if (error instanceof ReceptionIntakeRecipePairStoreError
      && error.code === 'invalid_stored_binding') {
      return pairView(endpoint_id, 'stale', null);
    }
    throw error;
  }
  if (stored === null) return pairView(endpoint_id, 'unpaired', null);
  const recipes = deps.getRecipeStore?.();
  if (!recipes) return pairView(endpoint_id, 'stale', stored);
  let recipe: ReturnType<typeof recipes.get>;
  try {
    recipe = recipes.get(stored.binding.recipe_id);
  } catch {
    return pairView(endpoint_id, 'stale', stored);
  }
  if (recipe === null) return pairView(endpoint_id, 'stale', stored);
  // D-210 R-2 slice 4 — the kind fork. `deriveEndpointPairBinding` picks the subject the
  // endpoint's OWN runtime consumer re-derives with, so `ready` here means the same thing it
  // will mean at submit / drain time.
  const derived = deriveEndpointPairBinding(endpoint, recipe);
  if (derived.kind !== 'ready'
    || !receptionPairBindingEquals(stored.binding, derived.binding)) {
    return pairView(endpoint_id, 'stale', stored);
  }
  // ── The pair is ready. Only a FORM pair has a claim to project. ──────────────────────
  //
  // A scheduling pair takes the early return: no claim configuration means no CAS read,
  // which also means no yield, which is why it needs no re-proof (the `StillCurrent`
  // re-check below exists to close the race that awaiting the claim's encrypted I/O opens).
  if (isReceptionSchedulingPairBinding(stored.binding)) {
    return pairView(endpoint_id, 'ready', stored);
  }
  const config = intakePairConfigFor(endpoint);
  if (config === null) return pairView(endpoint_id, 'stale', stored);
  const claim_configuration_readiness =
    await receptionIntakeRecipePairClaimConfigurationReadiness(deps, recipe);
  if (!receptionIntakeRecipePairStillCurrent(deps, store, recipes, stored)) {
    return pairView(endpoint_id, 'stale', stored);
  }
  return pairView(
    endpoint_id,
    'ready',
    stored,
    claim_configuration_readiness,
    receptionIntakeRecipePairClaimConfigurationAuthoring(
      recipes,
      config,
      stored,
    ),
  );
};

export const handleReceptionIntakeRecipePairBind = async (
  deps: ReceptionRpcDeps,
  args: ReceptionIntakeRecipePairBindInput,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<ReceptionIntakeRecipePairBindResult> => {
  const method = 'reception.intake_recipe_pair.bind';
  const actor = requireCallerInstance(caller, method);
  const input = requireClosedPairArgs(
    args,
    PAIR_BIND_KEYS,
    method,
    PAIR_BIND_OPTIONAL_KEYS,
  );
  const endpoint_id = validateEndpointId(input.endpoint_id, method);
  const recipe_id = requireRecipeId(input.recipe_id, method);
  const expected_updated_at = requireExpectedPairToken(
    input.expected_updated_at,
    method,
  );
  // D-207 slice 1c — consent is a BOOLEAN the owner sets, never a truthy coincidence.
  if (input.confirm_capability !== undefined
    && typeof input.confirm_capability !== 'boolean') {
    throw badRequest(
      'intake_recipe_pair_invalid',
      `${method}: confirm_capability must be a boolean`,
    );
  }
  const confirm_capability = input.confirm_capability === true;
  // Same posture as `confirm_capability`: a standing approval is a BOOLEAN the
  // owner sets, never a truthy coincidence.
  if (input.standing_closure !== undefined
    && typeof input.standing_closure !== 'boolean') {
    throw badRequest(
      'intake_recipe_pair_invalid',
      `${method}: standing_closure must be a boolean`,
    );
  }
  // ⛔ A STANDING APPROVAL REQUIRES THE OWNER TO HAVE SEEN WHAT THEY ARE
  // APPROVING. `confirm_capability` is "I have read this closure";
  // `standing_closure` is "and it may run without asking me again". The second
  // without the first would let a caller grant standing authority over a list
  // the owner never saw — which is the whole thing the confirm step exists for.
  if (input.standing_closure === true && input.confirm_capability !== true) {
    throw badRequest(
      'intake_recipe_pair_invalid',
      `${method}: standing_closure requires confirm_capability — the owner must have seen the closure they are granting`,
    );
  }
  const standing_closure = input.standing_closure === true;
  const endpoint = requirePairableEndpoint(deps, endpoint_id, method);
  if (endpoint.revoked_at !== null) {
    throw new RpcError(
      'endpoint_already_revoked',
      `${method}: endpoint '${endpoint_id}' is revoked`,
      409,
    );
  }
  const store = requireIntakePairStore(deps, method);
  const recipes = deps.getRecipeStore?.();
  if (!recipes) {
    throw new RpcError('not_configured', `${method}: recipe store is not configured`, 503);
  }
  let recipe: ReturnType<typeof recipes.get>;
  try {
    recipe = recipes.get(recipe_id);
  } catch {
    throw new RpcError(
      'intake_recipe_pair_recipe_invalid',
      `${method}: saved recipe '${recipe_id}' could not be decoded`,
      422,
    );
  }
  if (recipe === null) {
    throw new RpcError(
      'intake_recipe_pair_recipe_not_found',
      `${method}: saved recipe '${recipe_id}' was not found`,
      404,
    );
  }
  // D-210 R-2 slice 4 — the kind fork. A form hashes its whole config; a booking hashes only
  // its `required_visitor_fields` (owner-ruled). Both land on one comparable binding.
  const derived = deriveEndpointPairBinding(endpoint, recipe);
  if (derived.kind === 'config_incompatible') {
    throw new RpcError(
      'intake_recipe_pair_incompatible',
      endpoint.kind === 'intake_form'
        ? `${method}: endpoint form config and declared form source do not match`
        : `${method}: endpoint '${endpoint_id}' config does not parse, so no pair can be derived from it`,
      422,
    );
  }
  if (derived.kind === 'recipe_invalid') {
    throw new RpcError(
      'intake_recipe_pair_recipe_invalid',
      `${method}: saved recipe '${recipe_id}' failed the standard recipe parser`,
      422,
    );
  }
  if (derived.kind === 'pair_incompatible') {
    throw new RpcError(
      'intake_recipe_pair_incompatible',
      `${method}: current ${endpoint.kind === 'intake_form' ? 'form' : 'booking page'} and recipe cannot form a pair`,
      422,
    );
  }
  if (derived.binding.recipe_id !== recipe_id) {
    throw new RpcError(
      'intake_recipe_pair_recipe_invalid',
      `${method}: saved recipe '${recipe_id}' decoded with a different recipe_id`,
      422,
    );
  }
  deps.preflightNonOwnerRecipeExposure?.(recipe, 'reception');
  // Evaluate the distinct submit-time role against the same current saved
  // recipe before any await. This is owner visibility only: an ineligible
  // profile remains bindable and persists as an exact pair.


  // ── D-207 slice 1c — can this server hang a door at all? ─────────────────────────────
  //
  // Asked BEFORE the pair write, because the answer decides whether a written pair could
  // ever run. A door-less server that accepted the bind would leave a public form that
  // looks live and hard-denies every submission — the pair saved, the visitor's work lost,
  // and nothing on screen saying why. Refuse up front instead; nothing is written.
  //
  // D-200's legacy direct-checkout profile is the one recipe shape that needs NO door: it
  // still runs on its own crippled-by-construction path until Slice 3 retires it onto
  // `core.seller.order`. Everything else — every general recipe D-207 exists to admit —
  // runs through the Gateway and therefore requires one.
  const doorDeps = deps.getDoorBindDeps?.();
  if (doorDeps === undefined) {
    throw new RpcError(
      'not_configured',
      `${method}: this server cannot mint a reception door contract, so recipe '${recipe_id}' could not run on a public form. Nothing was bound.`,
      503,
    );
  }

  // ── D-220 Slice A2 — does THIS form carry the answers the recipe reads? ──────────────
  //
  // Asked here for exactly the reason the door check above is: the answer decides whether
  // a written pair could ever do its job. A recipe reads named answers by STATIC path
  // (`record.values.<name>`), so a form that spells a required field differently — or omits
  // it, or hides it behind `user_only_field_names` — makes that read resolve `undefined`,
  // a `default` transform substitute its fallback, and every submission "succeed" having
  // stored nothing. The visitor's work is lost and there is no error anywhere to chase.
  //
  // Refuse at BIND, where the owner is present and can fix the form, never at fire, where
  // an anonymous visitor is. Nothing is written.
  //
  // Scope: FORM pairs only. A scheduling pair has no authored fields to contract over
  // (D-210 R-2 — it hashes only `required_visitor_fields`), so there is nothing to compare.
  // An UNDECLARED recipe (`requires_form_fields` absent) passes untouched: A2 enforces what
  // a recipe declared, and must not retroactively refuse the pairs that already work.
  if (endpoint.kind === 'intake_form') {
    const formConfig = intakePairConfigFor(endpoint);
    // `derived.kind === 'ready'` above already proves this parses; the guard is for the
    // typechecker, and returning early rather than throwing keeps a parse regression from
    // turning into a spurious contract refusal.
    if (formConfig !== null) {
      const contract = evaluateFormFieldContract(
        recipe.metadata?.requires_form_fields,
        formConfig.form_definition,
      );
      if (!contract.satisfied) {
        throw new RpcError(
          'intake_recipe_pair_form_contract_unsatisfied',
          `${method}: recipe '${recipe_id}' reads answers this form does not collect, so every submission `
            + `would store nothing. Nothing was bound. ${contract.blocking.map((m: FormFieldContractMismatch) => m.detail).join('; ')}`,
          422,
          method,
          {
            blocking: contract.blocking.map((m: FormFieldContractMismatch) => ({ code: m.code, field_name: m.field_name })),
            advisory: contract.advisory.map((m: FormFieldContractMismatch) => ({ code: m.code, field_name: m.field_name })),
          },
        );
      }
    }
  }

  let written: ReturnType<ReceptionIntakeRecipePairStore['compareAndSet']>;
  try {
    written = store.compareAndSet({
      endpoint_id,
      binding: derived.binding,
      expected_updated_at,
      now: deps.now(),
    });
  } catch (error) {
    if (error instanceof ReceptionIntakeRecipePairStoreError) {
      throw new RpcError(
        error.code === 'invalid_stored_binding'
          ? 'intake_recipe_pair_stored_invalid'
          : 'intake_recipe_pair_invalid',
        `${method}: ${error.message}`,
        409,
      );
    }
    throw error;
  }
  if (written.kind === 'conflict') {
    throw new RpcError(
      'intake_recipe_pair_conflict',
      `${method}: pair changed after it was read`,
      409,
      method,
      { current_updated_at: written.current?.updated_at ?? null },
    );
  }
  // ── D-207 slice 1c — HANG THE DOOR ───────────────────────────────────────────────────
  //
  // The pair row exists now, which `setContractId` requires — so this must follow the
  // write, and a `needs_consent` / `refused` outcome deliberately leaves a pair with no
  // door. That state is fail-CLOSED, not half-open: no contract ⇒ `PUBLIC_CONTRACT_ID` ⇒
  // nothing granted ⇒ every op denies.
  // Unconditional now. Until D-207 slice 3c, `bind` deliberately minted NO door for
  // D-200's legacy direct-checkout profile, so those pairs answered `no_door` and fell
  // through to a coordinator that ran the recipe OUTSIDE the Gateway. That path is gone,
  // and with it the only recipe shape that was exempt from the door.
  const door: ReceptionDoorBindView = bindPairDoor(doorDeps, {
    endpoint_id,
    recipe_id,
    recipe,
    actor,
    confirm_capability,
    standing_closure,
  });

  // The door mint is the moment the ANONYMOUS PUBLIC gains authority on this server, so it
  // is audited whenever it happens — including when the pair itself did not move. That
  // case is not exotic, it is the NORMAL consent flow: bind (pair `created`, door
  // `needs_consent`) → owner confirms → re-bind with the identical recipe (pair
  // `unchanged`, door MINTED). Auditing only on a pair change would leave the one write
  // that opened the door to the internet with no audit row at all.
  const doorMinted = door.status === 'bound' && !door.unchanged;
  if (written.kind !== 'unchanged' || doorMinted) {
    const doorDetail = door.status === 'bound'
      ? `door=bound, contract_id=${door.contract_id}, door_ops=[${door.operation_ids.join(' ')}]`
      : `door=${door.status}`;
    await bumpAuditAndEmit(deps, {
      action: 'reception.intake_recipe_pair.bound',
      endpoint_id,
      detail: `outcome=${written.kind}, recipe_id=${derived.binding.recipe_id}, recipe_version=${derived.binding.recipe_version}, pair_revision=${derived.binding.pair_revision}, ${doorDetail}`,
      actor_instance_id: actor,
      audit_id_suffix: randomUUID(),
      broadcast_op: 'pair_bind',
    });
  }
  // ── D-210 R-2 slice 4 — a SCHEDULING pair has no claim to read ───────────────────────
  //
  // The early return is the whole difference. The claim projection below is the only thing
  // in this tail that AWAITS (encrypted CAS I/O), and `receptionIntakeRecipePairStillCurrent`
  // exists solely to re-prove the pair across that yield. A scheduling bind does neither: it
  // never yields, so there is no race to close, and re-proving would only re-read the row it
  // just wrote.
  if (isReceptionSchedulingPairBinding(written.pair.binding)) {
    return {
      outcome: written.kind,
      door,
      pair: pairView(endpoint_id, 'ready', written.pair),
    };
  }
  const config = intakePairConfigFor(endpoint);
  if (config === null) {
    // Unreachable: `deriveEndpointPairBinding` already refused a form endpoint whose config
    // does not match its declared source, above and before the write. Fail closed rather
    // than assume the two agree — the pair IS written at this point, and the owner re-reads
    // it through `get`.
    throw new RpcError(
      'intake_recipe_pair_conflict',
      `${method}: endpoint form source changed while the pair was written`,
      409,
    );
  }
  const claim_configuration_readiness =
    await receptionIntakeRecipePairClaimConfigurationReadiness(deps, recipe);
  if (!receptionIntakeRecipePairStillCurrent(deps, store, recipes, written.pair)) {
    throw new RpcError(
      'intake_recipe_pair_conflict',
      `${method}: pair or authoring source changed while claim readiness was read`,
      409,
    );
  }
  return {
    outcome: written.kind,
    door,
    pair: pairView(
      endpoint_id,
      'ready',
      written.pair,
      claim_configuration_readiness,
      receptionIntakeRecipePairClaimConfigurationAuthoring(
        recipes,
        config,
        written.pair,
      ),
    ),
  };
};

/** D-200 Slice 6g.11 — mutate only the recipe-pinned claim configuration on
 * one exact, persistent, pack-unowned recipe. The pair row is intentionally
 * not rewritten in this operation: a real recipe change makes it stale, and
 * the owner's later explicit bind derives and pins the new pair revision. */
export const handleReceptionIntakeRecipePairConfigure = async (
  deps: ReceptionRpcDeps,
  args: ReceptionIntakeRecipePairConfigureInput,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<ReceptionIntakeRecipePairConfigureResult> => {
  const method = 'reception.intake_recipe_pair.configure';
  const actor = requireCallerInstance(caller, method);
  const input = requireClosedPairArgs(args, PAIR_CONFIGURE_KEYS, method);
  const endpoint_id = validateEndpointId(input.endpoint_id, method);
  const observation = requireConfigurePairObservation(input, method);
  const endpoint = requireIntakeEndpoint(deps, endpoint_id, method);
  if (endpoint.revoked_at !== null) {
    throw new RpcError(
      'endpoint_already_revoked',
      `${method}: endpoint '${endpoint_id}' is revoked`,
      409,
    );
  }
  const formConfig = intakePairConfigFor(endpoint);
  if (formConfig === null) {
    throw new RpcError(
      'intake_recipe_pair_conflict',
      `${method}: endpoint form source changed after the pair was read`,
      409,
    );
  }
  const pairStore = requireIntakePairStore(deps, method);
  let pair: ReceptionIntakeRecipePairSummary | null;
  try {
    pair = pairStore.findByEndpoint(endpoint_id);
  } catch (error) {
    if (error instanceof ReceptionIntakeRecipePairStoreError
      && error.code === 'invalid_stored_binding') {
      throw new RpcError(
        'intake_recipe_pair_stored_invalid',
        `${method}: stored pair cannot be decoded`,
        409,
      );
    }
    throw error;
  }
  if (pair === null
    || pair.updated_at !== observation.expected_updated_at
    || pair.binding.pair_revision !== observation.expected_pair_revision) {
    throw new RpcError(
      'intake_recipe_pair_conflict',
      `${method}: pair changed after it was read`,
      409,
      method,
      {
        current_updated_at: pair?.updated_at ?? null,
        current_pair_revision: pair?.binding.pair_revision ?? null,
      },
    );
  }

  const recipes = deps.getRecipeStore?.();
  if (!recipes) {
    throw new RpcError('not_configured', `${method}: recipe store is not configured`, 503);
  }
  const inspectLocalRecipeEdit = recipes.inspectLocalRecipeEdit;
  const compareAndSaveLocalRecipe = recipes.compareAndSaveLocalRecipe;
  if (typeof inspectLocalRecipeEdit !== 'function'
    || typeof compareAndSaveLocalRecipe !== 'function') {
    throw new RpcError(
      'not_configured',
      `${method}: safe local recipe writer is not configured`,
      503,
    );
  }
  let effectiveRecipe: ReturnType<typeof recipes.get>;
  try {
    effectiveRecipe = recipes.get(pair.binding.recipe_id);
  } catch {
    effectiveRecipe = null;
  }
  if (effectiveRecipe === null) {
    throw new RpcError(
      'intake_recipe_pair_conflict',
      `${method}: paired recipe source is no longer readable`,
      409,
    );
  }
  const effectivePair = deriveReceptionIntakeRecipePairBinding({
    form_config: formConfig,
    recipe: effectiveRecipe,
  });
  if (effectivePair.kind !== 'ready'
    || !receptionPairBindingEquals(
      pair.binding,
      effectivePair.binding,
    )) {
    throw new RpcError(
      'intake_recipe_pair_conflict',
      `${method}: current form or recipe no longer matches the observed pair`,
      409,
    );
  }

  let inspection: ReturnType<typeof inspectLocalRecipeEdit>;
  try {
    inspection = inspectLocalRecipeEdit(pair.binding.recipe_id);
  } catch {
    inspection = { kind: 'unavailable' };
  }
  if (inspection.kind !== 'unavailable') {
    const inspectedPair = deriveReceptionIntakeRecipePairBinding({
      form_config: formConfig,
      recipe: inspection.recipe,
    });
    if (inspectedPair.kind !== 'ready'
      || !receptionPairBindingEquals(
        pair.binding,
        inspectedPair.binding,
      )) {
      throw new RpcError(
        'intake_recipe_pair_conflict',
        `${method}: editable recipe source changed after the pair was read`,
        409,
      );
    }
  }
  if (inspection.kind !== 'editable') {
    throw new RpcError(
      'intake_recipe_pair_recipe_not_editable',
      `${method}: paired recipe requires a new-id local fork before configuration`,
      409,
    );
  }

  const existingConfiguration =
    resolvePaidDocumentDirectCheckoutClaimConfiguration(inspection.recipe);
  const configurationUnchanged = existingConfiguration.kind === 'configured'
    && JSON.stringify(existingConfiguration.configuration)
      === JSON.stringify(observation.configuration);
  const nextRecipe = structuredClone(inspection.recipe);
  if (!configurationUnchanged) {
    nextRecipe.metadata = {
      ...nextRecipe.metadata,
      [PAID_DOCUMENT_DIRECT_CHECKOUT_CONFIGURATION_METADATA_KEY]:
        observation.configuration,
    };
  }
  if (!validateRecipe(nextRecipe).valid) {
    throw new RpcError(
      'intake_recipe_pair_recipe_invalid',
      `${method}: configured recipe failed the standard recipe validator`,
      422,
    );
  }

  const saved = compareAndSaveLocalRecipe({
    recipe: nextRecipe,
    expected_recipe_json: inspection.recipe_json,
    now: deps.now(),
  });
  if (saved.kind === 'not_configured') {
    throw new RpcError(
      'not_configured',
      `${method}: persistent recipe writer is not configured`,
      503,
    );
  }
  if (saved.kind === 'not_editable') {
    throw new RpcError(
      'intake_recipe_pair_recipe_not_editable',
      `${method}: recipe provenance changed and now requires a local fork`,
      409,
    );
  }
  if (saved.kind === 'not_found' || saved.kind === 'conflict') {
    throw new RpcError(
      'intake_recipe_pair_conflict',
      `${method}: recipe changed after it was read`,
      409,
    );
  }
  if (saved.kind === 'unchanged') {
    return {
      outcome: 'unchanged',
      recipe_id: pair.binding.recipe_id,
      pair_requires_rebind: false,
    };
  }

  const affectedEndpointIds = new Set<string>([endpoint_id]);
  try {
    for (const affected of pairStore.listByRecipeId(pair.binding.recipe_id)) {
      affectedEndpointIds.add(affected.endpoint_id);
    }
  } catch {
    // The origin endpoint still receives its authoritative invalidation. A
    // fan-out scan is owner-UX freshness only; submit/render source checks do
    // not depend on it and must not turn a committed recipe write into a lie.
  }
  await bumpAuditAndEmit(deps, {
    action: 'reception.intake_recipe_pair.configured',
    endpoint_id,
    detail: `recipe_id=${pair.binding.recipe_id}, prior_recipe_hash=${saved.prior_recipe_hash}, recipe_hash=${saved.recipe_hash}, affected_pair_count=${affectedEndpointIds.size}`,
    actor_instance_id: actor,
    audit_id_suffix: randomUUID(),
    broadcast_op: 'pair_configure',
  });
  for (const affectedEndpointId of [...affectedEndpointIds].sort()) {
    if (affectedEndpointId === endpoint_id) continue;
    deps.broadcast({
      kind: 'reception.endpoint_changed',
      op: 'pair_configure',
      endpoint_id: affectedEndpointId,
    });
  }
  return {
    outcome: 'updated',
    recipe_id: pair.binding.recipe_id,
    pair_requires_rebind: true,
  };
};

export const handleReceptionIntakeRecipePairClear = async (
  deps: ReceptionRpcDeps,
  args: ReceptionIntakeRecipePairClearInput,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<ReceptionIntakeRecipePairClearResult> => {
  const method = 'reception.intake_recipe_pair.clear';
  const actor = requireCallerInstance(caller, method);
  const input = requireClosedPairArgs(args, PAIR_CLEAR_KEYS, method);
  const endpoint_id = validateEndpointId(input.endpoint_id, method);
  // D-210 R-2 slice 4 — every kind `bind` accepts, `clear` must accept. An unbind gated
  // more narrowly than its bind is a pair the owner can create and never remove, and this
  // one also shuts the door (it reads the contract id before the delete).
  requirePairableEndpoint(deps, endpoint_id, method);
  const observation = requireClearPairObservation(input, method);
  const pairStore = requireIntakePairStore(deps, method);

  // D-207 slice 1c — read the door's contract id BEFORE the delete. `compareAndDelete`
  // removes the whole pair row, and the row IS the `reception_id → contract_id` hop, so
  // afterwards there is nothing left to look the door up by.
  //
  // `readContractId`, not `findByEndpoint`: this rpc RECOVERS corrupt rows, and
  // `findByEndpoint` throws on one. A corrupt pair still has a live door, and it is the
  // case where you most want the public's grants revoked rather than orphaned.
  const priorContractId = pairStore.readContractId(endpoint_id);

  let cleared: ReturnType<ReceptionIntakeRecipePairStore['compareAndDelete']>;
  try {
    cleared = pairStore.compareAndDelete({
      endpoint_id,
      ...observation,
    });
  } catch (error) {
    if (error instanceof ReceptionIntakeRecipePairStoreError) {
      throw new RpcError(
        error.code === 'invalid_stored_binding'
          ? 'intake_recipe_pair_stored_invalid'
          : 'intake_recipe_pair_invalid',
        `${method}: ${error.message}`,
        409,
      );
    }
    throw error;
  }
  if (cleared.kind === 'conflict') {
    throw new RpcError(
      'intake_recipe_pair_conflict',
      `${method}: pair changed after it was read`,
      409,
      method,
      {
        current_updated_at: cleared.current?.updated_at ?? null,
        current_pair_revision: cleared.current?.binding.pair_revision ?? null,
        current_invalid: cleared.current_invalid,
      },
    );
  }
  const removed = cleared.kind === 'deleted';
  if (cleared.kind === 'deleted') {
    // D-207 slice 1c — retire the door with the pair. The form is ALREADY shut at this
    // point (the row that resolved `reception_id → contract_id` is gone, so a dispatch
    // floors to `PUBLIC_CONTRACT_ID` and grants nothing) — so this is not the safety step,
    // it is the hygiene one: an un-retired definition would linger as an unreachable
    // contract still carrying grant rows for the anonymous public. Leave that litter
    // behind often enough and "which doors can the internet open?" stops being answerable.
    //
    // Retire by the id captured ABOVE, never via `unbindReceptionDoor`: that helper
    // re-reads the pair to find the contract id, and the pair row is gone by now — it
    // would find nothing, retire nothing, and report success.
    const doorDeps = deps.getDoorBindDeps?.();
    let doorRetired = false;
    if (priorContractId !== null && doorDeps !== undefined) {
      retireDoorContract(priorContractId, 'pair_cleared', doorDeps);
      doorRetired = true;
    }
    const detail = cleared.prior_invalid
      ? `removed=true, stored_invalid=true, door_retired=${doorRetired}`
      : `removed=true, recipe_id=${cleared.prior.binding.recipe_id}, recipe_version=${cleared.prior.binding.recipe_version}, pair_revision=${cleared.prior.binding.pair_revision}, door_retired=${doorRetired}`;
    await bumpAuditAndEmit(deps, {
      action: 'reception.intake_recipe_pair.cleared',
      endpoint_id,
      detail,
      actor_instance_id: actor,
      audit_id_suffix: randomUUID(),
      broadcast_op: 'pair_clear',
    });
  }
  return { removed };
};

// ────────────────────────────────────────────────────────────────
// D-200 Slice 6g.14 — owner-only direct Checkout recovery
// ────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────
// D-149 P4 — reception_page singleton config rpcs
// ────────────────────────────────────────────────────────────────

export const handleReceptionPageGet = async (
  deps: ReceptionRpcDeps,
  _args: void,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<ReceptionPageGetResult> => {
  const method = 'reception.page.get';
  requireCallerInstance(caller, method);
  const stored = deps.getStore().loadReceptionPageSingleton();
  if (!stored) return { config: null, last_updated_at: null };
  return { config: stored.config, last_updated_at: stored.last_updated_at };
};

/** Strict-shape parser for the caller-supplied `ReceptionPageConfig`.
 *  Rejects non-object input + caller-supplied extra keys; the
 *  `validateReceptionPageConfig` pure-fn does the deep field-level
 *  checks. Returns the parsed config (closed-shape) on success;
 *  throws `RpcError` with the closed-list code on failure. */
const parseAndValidatePageConfig = (
  raw: unknown,
  method: string,
): ReceptionPageConfig => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequest(
      'reception_page_config_invalid',
      `${method}: config must be an object`,
    );
  }
  const obj = raw as Record<string, unknown>;
  if (
    !obj.display_overrides ||
    typeof obj.display_overrides !== 'object' ||
    Array.isArray(obj.display_overrides)
  ) {
    throw badRequest(
      'reception_page_config_invalid',
      `${method}: config.display_overrides must be an object`,
    );
  }
  if (
    !obj.sections_enabled ||
    typeof obj.sections_enabled !== 'object' ||
    Array.isArray(obj.sections_enabled)
  ) {
    throw badRequest(
      'reception_page_config_invalid',
      `${method}: config.sections_enabled must be an object`,
    );
  }
  if (
    !obj.linked_endpoints ||
    typeof obj.linked_endpoints !== 'object' ||
    Array.isArray(obj.linked_endpoints)
  ) {
    throw badRequest(
      'reception_page_config_invalid',
      `${method}: config.linked_endpoints must be an object`,
    );
  }
  const config = obj as unknown as ReceptionPageConfig;
  const failures = validateReceptionPageConfig(config);
  if (failures.length > 0) {
    // Surface the FIRST failure's code + detail; the full failure list
    // rides on `RpcError.details` for callers that want to render
    // per-field errors. Mirrors the `tls_domain.upload` posture.
    const first = failures[0];
    if (!first) {
      throw badRequest(
        'reception_page_config_invalid',
        `${method}: config validation failed with no specific code`,
      );
    }
    throw new RpcError(
      'reception_page_config_invalid',
      `${method}: ${first.detail}`,
      400,
      method,
      { issues: failures },
    );
  }
  return config;
};

export const handleReceptionPageUpsert = async (
  deps: ReceptionRpcDeps,
  args: ReceptionPageUpsertInput,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<ReceptionPageUpsertResult> => {
  const method = 'reception.page.upsert';
  const actor = requireCallerInstance(caller, method);
  if (!args || typeof args !== 'object') {
    throw badRequest('reception_page_config_invalid', `${method}: args must be an object`);
  }
  const config = parseAndValidatePageConfig(args.config, method);
  const now = deps.now();
  const outcome = deps.getStore().upsertReceptionPageSingleton({
    config,
    now,
    actor_instance_id: actor,
  });
  await emitAuditRow(deps, {
    action: 'reception_page.config_updated',
    target: 'reception_page',
    detail: `outcome=${outcome}, sections=${JSON.stringify(config.sections_enabled)}`,
    actor_instance_id: actor,
  });
  // Reception page singleton emits a `reception.endpoint_changed`
  // broadcast with the well-known singleton id so paired clients
  // refresh their Reception page view + invalidate any
  // cached visitor-side render.
  deps.broadcast({
    kind: 'reception.endpoint_changed',
    op: outcome === 'created' ? 'create' : 'extend',
    endpoint_id: '__reception_page__',
  });
  return {
    ok: true,
    created: outcome === 'created',
    last_updated_at: now,
  };
};

export const handleReceptionEmergencyDisableAll = async (
  deps: ReceptionRpcDeps,
  args: ReceptionEmergencyDisableAllInput | undefined,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<ReceptionEmergencyDisableAllResult> => {
  const method = 'reception.emergency_disable_all';
  const actor = requireCallerInstance(caller, method);
  const reason = typeof args?.reason === 'string' ? args.reason : null;
  const disabled_count = deps.getStore().emergencyDisableAll(deps.now());
  await emitAuditRow(deps, {
    action: 'reception.emergency_disabled',
    target: 'reception',
    detail: `disabled_count=${disabled_count}, reason=${reason ?? 'unspecified'}`,
    actor_instance_id: actor,
  });
  deps.broadcast({
    kind: 'reception.emergency_disabled',
    disabled_count,
    reason,
  });
  return { disabled_count };
};

// ────────────────────────────────────────────────────────────────
// D-149 P12 § A.20.5 — Abuse Inbox rpcs
// ────────────────────────────────────────────────────────────────

/** `ban_ip` / `unban_ip` require the IP block store. bin.ts wires it
 *  unconditionally (the `reception_ip_block_list` table exists from
 *  boot); the guard is the optional-dep-pattern safety net + maps a
 *  boot-phase-without-store call to the same `not_configured` / 503
 *  sentinel the locked-vault paths use. */
const requireIpBlockStore = (
  deps: ReceptionRpcDeps,
  method: string,
): NonNullable<ReturnType<NonNullable<ReceptionRpcDeps['getIpBlockStore']>>> => {
  const store = deps.getIpBlockStore?.();
  if (!store) {
    throw new RpcError(
      'not_configured',
      `${method}: reception IP block store is not wired`,
      503,
    );
  }
  return store;
};

const requireNonEmptyString = (raw: unknown, field: string, method: string): string => {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw badRequest('bad_request', `${method}: ${field} must be a non-empty string`);
  }
  return raw;
};

export const handleReceptionAbuseInboxList = async (
  deps: ReceptionRpcDeps,
  args: ReceptionAbuseInboxListInput | undefined,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<ReceptionAbuseInboxListResult> => {
  const method = 'reception.abuse_inbox.list';
  requireCallerInstance(caller, method);
  const now = deps.now();

  // since — default `now - 7d`; reject a non-finite value.
  let since = now - ABUSE_INBOX_DEFAULT_WINDOW_MS;
  if (args?.since !== undefined) {
    if (typeof args.since !== 'number' || !Number.isFinite(args.since)) {
      throw badRequest('bad_request', `${method}: since must be a finite number`);
    }
    since = args.since;
  }
  let limit: number | undefined;
  if (args?.limit !== undefined) {
    // Codex P2 fold — require a positive INTEGER. A fractional `limit`
    // is finite + positive but binds into SQLite `LIMIT @limit` as a
    // REAL, which throws `datatype mismatch` + turns bad input into a
    // 500. Gate it at the rpc edge for a clean 400 instead.
    if (
      typeof args.limit !== 'number' ||
      !Number.isInteger(args.limit) ||
      args.limit <= 0
    ) {
      throw badRequest('bad_request', `${method}: limit must be a positive integer`);
    }
    limit = args.limit;
  }
  let cluster_threshold: number | undefined;
  if (args?.cluster_threshold !== undefined) {
    if (
      typeof args.cluster_threshold !== 'number' ||
      !Number.isFinite(args.cluster_threshold) ||
      args.cluster_threshold < 1
    ) {
      throw badRequest('bad_request', `${method}: cluster_threshold must be a number ≥ 1`);
    }
    cluster_threshold = args.cluster_threshold;
  }

  const readInput: { since: number; limit?: number } = { since };
  if (limit !== undefined) readInput.limit = limit;
  const entries = deps.getStore().readAccessLogAcrossEndpoints(readInput);

  // The IP block store is optional at boot — when absent the inbox
  // still aggregates (with an empty block list); bin.ts wires it.
  const ipBlockStore = deps.getIpBlockStore?.();
  const blocked_keys = ipBlockStore ? ipBlockStore.listBlockedKeys() : new Set<string>();
  const blocked: ReadonlyArray<ReceptionIpBlockEntry> = ipBlockStore
    ? ipBlockStore.list()
    : [];

  const summaryInput: {
    entries: ReadonlyArray<AccessLogEntry>;
    blocked_keys: ReadonlySet<string>;
    window_start_at: number;
    window_end_at: number;
    cluster_threshold?: number;
  } = { entries, blocked_keys, window_start_at: since, window_end_at: now };
  if (cluster_threshold !== undefined) summaryInput.cluster_threshold = cluster_threshold;
  const summary = buildAbuseInbox(summaryInput);

  return { summary, blocked };
};

export const handleReceptionAbuseInboxBanIp = async (
  deps: ReceptionRpcDeps,
  args: ReceptionAbuseInboxBanIpInput,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<ReceptionAbuseInboxBanIpResult> => {
  const method = 'reception.abuse_inbox.ban_ip';
  const actor = requireCallerInstance(caller, method);
  const store = requireIpBlockStore(deps, method);
  const endpoint_id = requireNonEmptyString(args?.endpoint_id, 'endpoint_id', method);
  const source_ip_hash = requireNonEmptyString(args?.source_ip_hash, 'source_ip_hash', method);
  const reason = typeof args?.reason === 'string' && args.reason.length > 0 ? args.reason : null;
  const now = deps.now();
  const outcome = store.block({
    endpoint_id,
    source_ip_hash,
    blocked_at: now,
    blocked_by_client_id: actor,
    reason,
  });
  // Emit the signed audit row only on a real state change — an
  // idempotent re-ban (`already_blocked`) is a no-op, not a mutation.
  // `id_suffix: source_ip_hash` keeps the activity_id distinct when
  // multiple IPs are banned on the same endpoint in the same ms.
  if (outcome === 'created') {
    await emitAuditRow(deps, {
      action: 'reception.ip_blocked',
      target: endpoint_id,
      detail: `source_ip_hash=${source_ip_hash}, reason=${reason ?? 'unspecified'}`,
      actor_instance_id: actor,
      id_suffix: source_ip_hash,
    });
  }
  return { ok: true, created: outcome === 'created' };
};

export const handleReceptionAbuseInboxUnbanIp = async (
  deps: ReceptionRpcDeps,
  args: ReceptionAbuseInboxUnbanIpInput,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<ReceptionAbuseInboxUnbanIpResult> => {
  const method = 'reception.abuse_inbox.unban_ip';
  const actor = requireCallerInstance(caller, method);
  const store = requireIpBlockStore(deps, method);
  const endpoint_id = requireNonEmptyString(args?.endpoint_id, 'endpoint_id', method);
  const source_ip_hash = requireNonEmptyString(args?.source_ip_hash, 'source_ip_hash', method);
  const outcome = store.unblock({ endpoint_id, source_ip_hash });
  if (outcome === 'removed') {
    await emitAuditRow(deps, {
      action: 'reception.ip_unblocked',
      target: endpoint_id,
      detail: `source_ip_hash=${source_ip_hash}`,
      actor_instance_id: actor,
      id_suffix: source_ip_hash,
    });
  }
  return { ok: true, removed: outcome === 'removed' };
};

// ────────────────────────────────────────────────────────────────
// D-149 follow-on § A.10 — intake_form Templates browser rpc
// ────────────────────────────────────────────────────────────────

/** Default `recued-core/personal-organizer-foundation` pack templates
 *  directory. Mirrors `foundation-pack-pre-install.ts:findCommunityPackDir`'s
 *  project-root resolution so a server booting from `backend/server/dist`
 *  resolves the same bundled `community/` tree. */
const findFoundationTemplatesDir = (): string => {
  const projectRoot = resolve(import.meta.dirname ?? __dirname, '..', '..', '..');
  return join(
    projectRoot,
    'community',
    'packs',
    'recued-core',
    'personal-organizer-foundation',
    'templates',
  );
};

/** D-151 — default Foundation pack `config-templates/` directory (the
 *  `scheduling_link` + `reception_page` templates). A sibling of the
 *  intake `templates/` dir, kept separate so the intake loader + its
 *  docs-currency lint stay untouched. */
const findFoundationConfigTemplatesDir = (): string => {
  const projectRoot = resolve(import.meta.dirname ?? __dirname, '..', '..', '..');
  return join(
    projectRoot,
    'community',
    'packs',
    'recued-core',
    'personal-organizer-foundation',
    'config-templates',
  );
};

/** Read + parse the Foundation-pack `intake_form` template manifests from
 *  `dir`. Each `*.json` file is parsed via the contract's
 *  `parseIntakeFormTemplate` — the SAME validator the P11 docs-currency
 *  CI lint runs — so a listed template is guaranteed to convert cleanly
 *  via `intakeFormConfigFromTemplate` downstream. A file that fails to
 *  read / parse / validate is SKIPPED rather than failing the whole list:
 *  a single corrupt drop-in must not blank the Templates browser for its
 *  valid siblings (mirrors `loadFoundationPackManifests`'s skip-don't-throw
 *  posture). A missing `dir` (pack not installed / community tree absent)
 *  yields an empty list. Filesystem read only — no store / audit / broadcast. */
const loadFoundationIntakeFormTemplates = (dir: string): IntakeFormTemplate[] => {
  if (!existsSync(dir)) return [];
  const templates: IntakeFormTemplate[] = [];
  // `.sort()` for a deterministic rpc result regardless of readdir order;
  // the Settings projection re-canonicalises into `INTAKE_FORM_TEMPLATE_REFS`
  // order anyway, but a stable wire shape keeps tests + caches predictable.
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.json')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
    } catch {
      // Unreadable / non-JSON file — skip.
      continue;
    }
    const result = parseIntakeFormTemplate(parsed);
    if (result.ok) templates.push(result.template);
    // result.ok === false ⇒ shape / validation failure — skip silently;
    // `buildIntakeFormTemplatesBrowserModel`'s `missing_refs` surfaces it.
  }
  return templates;
};

/** D-151 — read + parse the Foundation-pack `scheduling_link` +
 *  `reception_page` config templates from `dir`. Each `*.json` is parsed
 *  via the contract's `parseReceptionConfigTemplate` — the SAME validator
 *  that delegates to `validateSchedulingLinkConfig` / `validateReceptionPageConfig`
 *  — so a listed template is guaranteed to convert cleanly via
 *  `receptionConfigFromTemplate` downstream. Skip-don't-throw on a
 *  corrupt drop-in + empty list on a missing `dir`, mirroring the intake
 *  loader. Filesystem read only — no store / audit / broadcast. */
const loadFoundationConfigTemplates = (dir: string): ReceptionConfigTemplate[] => {
  if (!existsSync(dir)) return [];
  const templates: ReceptionConfigTemplate[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.json')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
    } catch {
      continue;
    }
    const result = parseReceptionConfigTemplate(parsed);
    if (result.ok) templates.push(result.template);
    // result.ok === false ⇒ skip silently; the gallery's missing-ref
    // surface flags the gap.
  }
  return templates;
};

/** `reception.template.list` — return the Foundation-pack reception
 *  template manifests for the Reception → Templates browser:
 *  the `intake_form` templates (D-149 P11) plus the `scheduling_link` +
 *  `reception_page` config templates (D-151). Read-only: no store
 *  mutation, no audit row, no broadcast (mirrors `reception.page.get`'s
 *  posture). Admin-only — `requireCallerInstance` gates it like every
 *  reception rpc, and `reception.` stays reserved off the MCP channel.
 *  `deps.getTemplatesDir` / `deps.getConfigTemplatesDir` override the
 *  default community-tree paths (tests pin a fixture / the repo's real
 *  directories). Resolves the D-149 Templates-browser wire question: the
 *  templates are server-side pack content, so they reach the webclient
 *  FROM the server per D-148 § A.4. */
export const handleReceptionTemplateList = async (
  deps: ReceptionRpcDeps,
  _args: void,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<ReceptionTemplateListResult> => {
  const method = 'reception.template.list';
  requireCallerInstance(caller, method);
  const dir = deps.getTemplatesDir?.() ?? findFoundationTemplatesDir();
  const configDir = deps.getConfigTemplatesDir?.() ?? findFoundationConfigTemplatesDir();
  // D-220 Slice B — pack-shipped templates come from the store, not a
  // directory: a marketplace-installed pack has no files on this server.
  // Skip-don't-throw, like the Foundation loaders: a store hiccup must not
  // blank the Foundation gallery for the sake of the pack section.
  let packTemplates: { listings: ReadonlyArray<PackReceptionTemplateListing>; unavailable: ReadonlyArray<PackReceptionTemplateUnavailable> } =
    { listings: [], unavailable: [] };
  try {
    packTemplates = deps.listPackReceptionTemplates?.() ?? packTemplates;
  } catch (e) {
    console.warn(`[d-220.b] reception.template.list: pack templates unreadable: ${(e as Error).message ?? String(e)}`);
  }
  return {
    templates: loadFoundationIntakeFormTemplates(dir),
    config_templates: loadFoundationConfigTemplates(configDir),
    pack_templates: packTemplates.listings,
    pack_templates_unavailable: packTemplates.unavailable,
  };
};

// ────────────────────────────────────────────────────────────────
// D-151 P2 — `reception.compose.propose`
// ────────────────────────────────────────────────────────────────

const COMPOSE_INTENT_ALLOWED_KINDS = [
  'reception_page',
  'scheduling_link',
  'intake_form',
] as const satisfies ReadonlyArray<ComposeEndpointKind>;
const RECEPTION_COMPOSE_INTENT_TEXT_MAX = 2_000;
const COMPOSE_INTENT_ALLOWED_KIND_SET: ReadonlySet<ComposeEndpointKind> = new Set(
  COMPOSE_INTENT_ALLOWED_KINDS,
);
const COMPOSE_INTENT_DISALLOWED_KINDS = [
  'status_link',
  'drop_link',
  'approval_link',
] as const;
const COMPOSE_ALLOWED_FORM_FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'boolean',
  'date',
  'enum',
  'array<text>',
  'email',
] as const;
const COMPOSE_FORBIDDEN_FIELD_NAMES = [
  'ssn',
  'social_security',
  'tax_id',
  'government_id',
  'id_number',
  'credit_card',
  'card_number',
  'payment',
  'income',
  'salary',
  'mother_maiden_name',
  'password',
  'birthdate',
  'birthday',
  'employer',
  'address',
  'phone',
] as const;

const composeSafetyMatrix = (kind: (typeof COMPOSE_INTENT_ALLOWED_KINDS)[number]): TemplateSafetyMatrix => ({
  version: COMPOSE_CONTRACT_VERSION,
  template_ref: `compose.intent.${kind}`,
  allowed_kinds: [kind],
  allowed_field_types: COMPOSE_ALLOWED_FORM_FIELD_TYPES,
  forbidden_field_names: COMPOSE_FORBIDDEN_FIELD_NAMES,
  allowed_visitor_pii_classes: ['none', 'visitor_name', 'visitor_email'],
  default_expiry: kind === 'intake_form'
    ? { mode: 'rolling', rolling_days: 30 }
    : { mode: 'never' },
  long_lived_permitted: kind !== 'intake_form',
  // An unconstrained intake can represent anything. D-210 WS2: default it to
  // FORM-RESPONSE (the owner-approved working record is the destination); named templates may deliberately opt into a
  // task/commitment/calendar/contact target through their own safety matrix.
  //
  // Spread rather than `? undefined :` so the key is genuinely ABSENT. This
  // matrix is serialized into the model-facing proposal packet, where a
  // `"processing_target": undefined` would either survive as a confusing null
  // or vanish silently depending on the serializer — and the packet is the
  // model's only statement of what targets this template permits.
  ...(kind === 'intake_form' ? {} : { processing_target: 'task' as const }),
  // D-210 Phase C — `notification_defaults` RETIRED. It told the model this
  // template notifies on submit via the webclient inbox; after Phase C the
  // D-157 gate holds EVERY non-spam submission regardless, `inbox_fanout_mode`
  // picks the surface, and the D-158 block owns the channels. Keeping it would
  // state something untrue in the packet the model reads.
  rate_limit_policy: RECEPTION_RATE_LIMIT_DEFAULTS,
});

const DEFAULT_COMPOSE_INTENT_SAFETY_MATRICES: ReadonlyArray<TemplateSafetyMatrix> =
  COMPOSE_INTENT_ALLOWED_KINDS.map(composeSafetyMatrix);

const getComposeIntentSafetyMatrices = (
  deps: ReceptionComposeProposeDeps,
): ReadonlyArray<TemplateSafetyMatrix> =>
  deps.safetyMatrices && deps.safetyMatrices.length > 0
    ? deps.safetyMatrices
    : DEFAULT_COMPOSE_INTENT_SAFETY_MATRICES;

interface ComposeSafetyMatrixSelection {
  readonly matrix?: TemplateSafetyMatrix;
  readonly unknownTemplateRef?: string;
}

const selectComposeSafetyMatrix = (
  config: ProposedEndpointConfig,
  intentMatrices: ReadonlyArray<TemplateSafetyMatrix>,
  overrideMatrices: ReadonlyArray<TemplateSafetyMatrix> | undefined,
): ComposeSafetyMatrixSelection => {
  if (config.source_template_ref !== undefined) {
    const sourceTemplateRef = config.source_template_ref.trim();
    if (sourceTemplateRef.length === 0) return { unknownTemplateRef: config.source_template_ref };
    const overrideByRef = overrideMatrices?.find((m) => m.template_ref === sourceTemplateRef);
    const catalogByRef = COMPOSE_TEMPLATE_BY_REF.get(sourceTemplateRef)?.safety_matrix;
    const matrix = overrideByRef ?? catalogByRef;
    return matrix ? { matrix } : { unknownTemplateRef: sourceTemplateRef };
  }
  return { matrix: intentMatrices.find((m) => m.allowed_kinds.includes(config.kind)) };
};

const createComposePreviewCapacitySpecDeps = (): PrimitiveRegistryDeps['capacity_spec'] => {
  const invalidationSource = createCapacityInvalidationSource();
  const cache = createCapacityCache({ invalidationSource });

  // Compose preview deliberately bypasses capacity_spec in
  // `handleReceptionComposePropose`; the closed primitive registry still
  // requires a capacity_spec instance. Keep this fallback fail-closed so
  // an accidental capacity invocation cannot silently green-light a
  // bridge/ingredient/connection/quota check.
  const capacityRegistry = createCapacityProbeRegistry({
    bridgeStateProbe: { getOnline: () => false, getLoggedIn: () => false },
    ingredientRegistryProbe: {
      isInstalled: () => false,
      getBumpedAt: () => null,
      getSelectorTtlMs: () => null,
    },
    permissionRegistryProbe: { hasPermission: () => false },
    connectionHealthProbe: { isHealthy: () => false },
    sourceEnablementProbe: { hasEnabledSource: () => false },
    quotaHeadroomProbe: { hasHeadroom: () => false },
    warehouseRefResolver: { resolve: () => false },
  });
  return {
    registry: capacityRegistry,
    cache,
    walkContext: {
      audit_emitter: createCapacityAuditEmitter({ logActivity() {} }),
      transparency_emitter: createNoopTransparencyEmitter(),
    },
  };
};

export const createReceptionComposePrimitiveRegistry = (
  aiAdapter: AISynthesizeAdapter,
  options: ReceptionComposePrimitiveRegistryOptions = {},
): PrimitiveRegistry => {
  const primitiveDeps: PrimitiveRegistryDeps = {
    capacity_spec: options.capacitySpecDeps ?? createComposePreviewCapacitySpecDeps(),
    'data.fetch': {
      adapter: { fetch: async () => ({ rows: [], total_count: 0 }) },
    },
    'memory.recall': {
      adapter: { recall: async () => ({ entries: [], total_count: 0 }) },
    },
    'memory.write': {
      adapter: { write: async () => ({ memory_id: 'compose_memory_noop', provenance_edges_written: 0 }) },
      mint_preview_memory_id: () => 'compose_memory_preview_noop',
    },
    'enrichment.lookup': {
      adapter: { lookup: async () => ({ rows: [], total_count: 0 }) },
    },
    'ai.synthesize': {
      adapter: aiAdapter,
    },
    'bridge.dispatch': {
      adapter: { dispatch: async () => ({ success: false, detail: 'compose_noop' }) },
    },
    'recipe.invoke': {
      adapter: { invoke: async () => ({ success: false, detail: 'compose_noop' }) },
    },
    'approval.request': {
      adapter: { request: async () => ({ decision: 'cancelled', responded_at: Date.now() }) },
    },
    'provenance.link': {
      adapter: { link: async () => ({ ok: false, edges_written: 0, detail: 'compose_noop' }) },
    },
  };
  return createPrimitiveRegistry(primitiveDeps);
};

type ComposeTerminalErrorCode = Extract<
  ReceptionRpcErrorCode,
  | 'compose_intent_invalid'
  | 'compose_ai_unavailable'
  | 'compose_proposal_invalid'
  | 'compose_compile_error'
>;

interface ComposeTerminalError {
  readonly code: ComposeTerminalErrorCode;
  readonly status: number;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

const parseComposeProposeInput = (args: unknown): {
  readonly intent_text: string;
  readonly voice_input: boolean;
} => {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw badRequest(
      'compose_intent_invalid',
      'reception.compose.propose: input must be an object with intent_text',
    );
  }
  const rawIntent = (args as ReceptionComposeProposeInput).intent_text;
  if (typeof rawIntent !== 'string') {
    throw badRequest(
      'compose_intent_invalid',
      'reception.compose.propose: intent_text must be a string',
    );
  }
  const intent_text = rawIntent.trim();
  if (intent_text.length === 0) {
    throw badRequest(
      'compose_intent_invalid',
      'reception.compose.propose: intent_text is required',
    );
  }
  if (intent_text.length > RECEPTION_COMPOSE_INTENT_TEXT_MAX) {
    throw badRequest(
      'compose_intent_invalid',
      `reception.compose.propose: intent_text exceeds ${RECEPTION_COMPOSE_INTENT_TEXT_MAX} characters`,
    );
  }
  const voice = (args as ReceptionComposeProposeInput).voice_input;
  if (voice !== undefined && typeof voice !== 'boolean') {
    throw badRequest(
      'compose_intent_invalid',
      'reception.compose.propose: voice_input must be boolean when present',
    );
  }
  return { intent_text, voice_input: voice === true };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isComposeEndpointKindValue = (value: unknown): value is ComposeEndpointKind =>
  value === 'reception_page' ||
  value === 'scheduling_link' ||
  value === 'intake_form' ||
  value === 'status_link';

const isExpiryPolicyShape = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return value.mode === 'never' || value.mode === 'until_date' || value.mode === 'rolling';
};

const hasValidFormDefinitionShape = (value: unknown): boolean => {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (typeof value.form_definition_id !== 'string' || value.form_definition_id.trim() === '') {
    return false;
  }
  if (!Array.isArray(value.fields)) return false;
  return value.fields.every((field) => {
    if (!isRecord(field)) return false;
    if (typeof field.name !== 'string' || field.name.trim() === '') return false;
    if (typeof field.type !== 'string' || field.type.trim() === '') return false;
    if (typeof field.label !== 'string' || field.label.trim() === '') return false;
    if (typeof field.required !== 'boolean') return false;
    return field.values === undefined || isStringArray(field.values);
  });
};

const clippedText = (value: string, max: number): string => {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
};

const redactedSlotValue = (value: unknown): unknown => {
  if (typeof value === 'string') return clippedText(value, 80);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value === null) return null;
  if (Array.isArray(value)) return value.slice(0, 5).map(redactedSlotValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 10)
        .map(([k, v]) => [k, redactedSlotValue(v)]),
    );
  }
  return String(value);
};

const buildComposeTraceRedacted = (
  raw: Record<string, unknown>,
  selected_kind: ComposeEndpointKind,
): AIComposeTraceRedacted => {
  const rawTrace = isRecord(raw.ai_trace_redacted) ? raw.ai_trace_redacted : {};
  const rawDetected = isRecord(rawTrace.detected_slots) ? rawTrace.detected_slots : {};
  const detected_slots = Object.fromEntries(
    Object.entries(rawDetected)
      .slice(0, 20)
      .map(([k, v]) => [k, redactedSlotValue(v)]),
  );
  const templates = Array.isArray(rawTrace.templates_considered)
    ? rawTrace.templates_considered
        .filter(isRecord)
        .map((entry) => ({
          ref: typeof entry.ref === 'string' ? clippedText(entry.ref, 120) : '',
          rejected_reason: typeof entry.rejected_reason === 'string'
            ? clippedText(entry.rejected_reason, 160)
            : 'not selected',
        }))
        .filter((entry) => entry.ref.length > 0)
        .slice(0, 10)
    : undefined;
  const selectionReason = typeof rawTrace.selection_reason_short === 'string'
    ? clippedText(rawTrace.selection_reason_short, 180)
    : 'Proposed from the Compose intent.';
  return {
    version: COMPOSE_CONTRACT_VERSION,
    source_path: 'intent',
    detected_slots,
    selected_kind,
    selection_reason_short: selectionReason,
    ...(templates && templates.length > 0 ? { templates_considered: templates } : {}),
  };
};

const parseProposedEndpointConfig = (
  response: string,
  intent_text: string,
): ProposedEndpointConfig | undefined => {
  // Tolerant AI-output parse (fence + surrounding-prose extraction) via the
  // shared @recued/llm primitive — same parser the executor + contracted path
  // use, so reception no longer carries a divergent fence regex.
  const raw = parseJSONObject(response);
  if (!raw) return undefined;
  if (typeof raw.version !== 'string') return undefined;
  if (!isComposeEndpointKindValue(raw.kind)) return undefined;
  if (typeof raw.title !== 'string' || raw.title.trim() === '') return undefined;
  if (!isExpiryPolicyShape(raw.expiry_policy)) return undefined;
  // D-210 Phase C — the proposal no longer carries `notification`, so the parse
  // no longer demands it. Leaving the guard would have REJECTED every valid
  // proposal: the field left the contract, so the model stops emitting it.
  if (
    raw.exposure_intent !== 'public_anonymous' &&
    raw.exposure_intent !== 'contracted_bilateral'
  ) {
    return undefined;
  }
  if (!hasValidFormDefinitionShape(raw.form_definition)) return undefined;
  if (raw.kind === 'intake_form' && raw.form_definition === undefined) return undefined;
  if (raw.kind === 'scheduling_link' && !isRecord(raw.scheduling)) return undefined;
  if (raw.kind === 'status_link' && !isRecord(raw.status_projection)) return undefined;
  const proposed = raw as unknown as ProposedEndpointConfig;
  return {
    ...proposed,
    source_path: 'intent',
    source_intent_text: intent_text,
    ai_trace_redacted: buildComposeTraceRedacted(raw, proposed.kind),
  };
};

const compileDetails = (error: CompileError): Readonly<Record<string, unknown>> => {
  if (error.kind === 'version_mismatch') {
    return { kind: error.kind, expected: error.expected, got: error.got };
  }
  return {
    kind: error.kind,
    template_ref: error.template_ref,
    violation: error.violation,
  };
};

const throwComposeTerminal = (method: string, terminal: ComposeTerminalError): never => {
  throw new RpcError(
    terminal.code,
    `${method}: ${terminal.message}`,
    terminal.status,
    method,
    terminal.details,
  );
};

const defaultMintComposeId = (): string => {
  const random = Math.random().toString(36).slice(2, 10);
  return `compose:${Date.now()}:${random}`;
};

const composeSafetyMatrixPacket = (
  matrix: TemplateSafetyMatrix,
): Readonly<Record<string, unknown>> => ({
  version: matrix.version,
  template_ref: matrix.template_ref,
  allowed_kinds: [...matrix.allowed_kinds],
  allowed_field_types: [...matrix.allowed_field_types],
  forbidden_field_names: [...matrix.forbidden_field_names],
  allowed_visitor_pii_classes: matrix.allowed_visitor_pii_classes
    ? [...matrix.allowed_visitor_pii_classes]
    : undefined,
  default_expiry: matrix.default_expiry,
  long_lived_permitted: matrix.long_lived_permitted,
  // `processing_target` is optional on a TEMPLATE. Absence means the compiler
  // selects the explicit `form_response` destination. Spread it
  // so an absent target OMITS the key from the model-facing packet instead of
  // stating `processing_target: undefined`, which reads to a model as a
  // declared-but-empty capability rather than "this template names no
  // destination". Logged in internal design notes.
  ...(matrix.processing_target !== undefined
    ? { processing_target: matrix.processing_target }
    : {}),
  rate_limit_policy: matrix.rate_limit_policy,
});

const composeProposalPacket = (
  input: { readonly intent_text: string; readonly voice_input: boolean },
  intentMatrices: ReadonlyArray<TemplateSafetyMatrix>,
): Readonly<Record<string, unknown>> => ({
  version: COMPOSE_CONTRACT_VERSION,
  task: 'reception_endpoint_proposal',
  source_path: 'intent',
  intent_text: input.intent_text,
  voice_input: input.voice_input,
  allowed_kinds: [...COMPOSE_INTENT_ALLOWED_KINDS],
  disallowed_kinds: [...COMPOSE_INTENT_DISALLOWED_KINDS],
  output_contract: {
    type: 'ProposedEndpointConfig',
    version: COMPOSE_CONTRACT_VERSION,
    exposure_intent: 'public_anonymous',
    source_path: 'intent',
    max_ai_synthesize_calls: 1,
  },
  safety_matrices: intentMatrices.map(composeSafetyMatrixPacket),
  template_catalog: COMPOSE_TEMPLATE_CATALOG.map((template) => ({
    version: template.version,
    template_ref: template.template_ref,
    safety_matrix: composeSafetyMatrixPacket(template.safety_matrix),
  })),
});

export const handleReceptionComposePropose = async (
  deps: ReceptionRpcDeps,
  args: ReceptionComposeProposeInput,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<ReceptionComposeProposeResult> => {
  const method = 'reception.compose.propose';
  const callerId = requireCallerInstance(caller, method);
  const maybeComposeDeps = deps.composePropose;
  if (!maybeComposeDeps) {
    return throwComposeTerminal(method, {
      code: 'compose_ai_unavailable',
      status: 503,
      message: 'AI proposal substrate is not configured',
    });
  }
  const composeDeps = maybeComposeDeps;
  const input = parseComposeProposeInput(args);
  const now = composeDeps.now ?? deps.now;
  const intentMatrices = getComposeIntentSafetyMatrices(composeDeps);
  const packet = composeProposalPacket(input, intentMatrices);
  let captured: ProposedEndpointConfig | undefined;
  let terminal: ComposeTerminalError | undefined;

  const policy: OrchestrationPolicy = async (draft) => {
    draft.omitContext({
      source_ref: 'warehouse.*',
      reason_code: 'privacy_class',
      reason_detail: 'compose_intent_proposal_excludes_warehouse_context',
      content_stored: false,
    });
    await draft.invoke('memory.recall', {
      kinds: ['recued_plan'],
      limit: 0,
    });
    await draft.invoke('enrichment.lookup', {
      topic: 'compose_endpoint_authoring',
      scope: { source: 'compose', warehouse_omitted: true },
      limit: 0,
    });
    const ai = await draft.invoke('ai.synthesize', {
      tier: 'fast',
      pool_policy: 'free_then_byok',
      packet,
      max_tokens: 1_400,
    });
    if (ai.call.status === 'error') {
      terminal = {
        code: 'compose_ai_unavailable',
        status: 503,
        message: 'AI proposal call was unavailable',
      };
      return {
        status: 'cancelled_capacity_gap',
        failure_class: 'capacity',
        user_response: 'Compose proposal could not run because AI is unavailable.',
      };
    }
    const parsed = parseProposedEndpointConfig(ai.result.response, input.intent_text);
    if (!parsed) {
      terminal = {
        code: 'compose_proposal_invalid',
        status: 422,
        message: 'AI proposal did not match the Compose contract',
      };
      return {
        status: 'cancelled_malformed_ai',
        failure_class: 'synthesis',
        user_response: 'Compose proposal did not match the required contract.',
      };
    }
    if (!COMPOSE_INTENT_ALLOWED_KIND_SET.has(parsed.kind)) {
      terminal = {
        code: 'compose_proposal_invalid',
        status: 422,
        message: `intent-first Compose cannot propose kind '${parsed.kind}' at v1.0`,
        details: { proposed_kind: parsed.kind, allowed_kinds: [...COMPOSE_INTENT_ALLOWED_KINDS] },
      };
      return {
        status: 'cancelled_malformed_ai',
        failure_class: 'synthesis',
        user_response: 'Compose proposal selected an endpoint kind that is not available for intent-first authoring.',
      };
    }
    const selection = selectComposeSafetyMatrix(parsed, intentMatrices, composeDeps.safetyMatrices);
    if (selection.unknownTemplateRef) {
      terminal = {
        code: 'compose_proposal_invalid',
        status: 422,
        message: `unknown Compose template ref '${selection.unknownTemplateRef}'`,
        details: { source_template_ref: selection.unknownTemplateRef },
      };
      return {
        status: 'cancelled_malformed_ai',
        failure_class: 'synthesis',
        user_response: 'Compose proposal referenced an unknown template.',
      };
    }
    const matrix = selection.matrix;
    if (!matrix) {
      terminal = {
        code: 'compose_compile_error',
        status: 422,
        message: `no safety matrix matched kind '${parsed.kind}'`,
        details: { proposed_kind: parsed.kind },
      };
      return {
        status: 'cancelled_malformed_ai',
        failure_class: 'synthesis',
        user_response: 'Compose proposal could not be checked against a safety matrix.',
      };
    }
    let compiled: ReturnType<typeof compileProposedEndpointConfig>;
    try {
      compiled = compileProposedEndpointConfig(parsed, matrix, { now: now() });
    } catch {
      terminal = {
        code: 'compose_proposal_invalid',
        status: 422,
        message: 'AI proposal shape could not be compiled',
      };
      return {
        status: 'cancelled_malformed_ai',
        failure_class: 'synthesis',
        user_response: 'Compose proposal shape could not be compiled.',
      };
    }
    if (isCompileError(compiled)) {
      terminal = {
        code: 'compose_compile_error',
        status: 422,
        message: 'AI proposal failed Compose safety validation',
        details: compileDetails(compiled),
      };
      return {
        status: 'cancelled_malformed_ai',
        failure_class: 'synthesis',
        user_response: 'Compose proposal failed safety validation.',
      };
    }
    captured = parsed;
    return {
      status: 'completed',
      user_response: 'Compose proposal generated.',
    };
  };

  const requestId = composeDeps.mintRequestId?.() ?? defaultMintComposeId();
  const executeCtx: ExecuteRecuedRequestContext = {
    registry: composeDeps.registry,
    policy,
    default_tier: 'fast',
    default_ai_provider: composeDeps.defaultAiProvider ?? 'compose',
    default_ai_model_id: composeDeps.defaultAiModelId ?? 'compose-proposal',
    now,
    mint_id: composeDeps.mintId ?? defaultMintComposeId,
    ...(composeDeps.persist ? { persist: composeDeps.persist } : {}),
  };
  const plan: RecuedPlan = await executeRecuedRequest(
    {
      request_id: requestId,
      goal_id: requestId,
      user_request: input.intent_text,
      conversation_id: `compose:${callerId}`,
      surface: 'compose',
      model_hint: 'fast',
      context_breadth: 'narrow',
      audit_policy: {
        redact_user_request: true,
      },
      received_at: now(),
    },
    executeCtx,
  );

  const result = captured;
  if (terminal) throwComposeTerminal(method, terminal);
  if (!result) {
    return throwComposeTerminal(method, {
      code: 'compose_proposal_invalid',
      status: 422,
      message: 'proposal result sink was empty after engine execution',
      details: { plan_status: plan.status },
    });
  }
  if (plan.status !== 'completed') {
    return throwComposeTerminal(method, {
      code: 'compose_proposal_invalid',
      status: 422,
      message: 'engine did not complete the proposal plan',
      details: { plan_status: plan.status },
    });
  }
  return result;
};

// ────────────────────────────────────────────────────────────────
// Slice factory
// ────────────────────────────────────────────────────────────────

export const makeReceptionHandlers = (
  deps: ReceptionRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, ReceptionMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: [
      'reception.endpoints.list',
      'reception.endpoint.preview_draft',
      'reception.endpoint.create',
      'reception.endpoint.rotate_token',
      'reception.endpoint.enable',
      'reception.endpoint.disable',
      'reception.endpoint.revoke',
      'reception.endpoint.extend',
      'reception.endpoint.access_log',
      'reception.intake_recipe_pair.get',
      'reception.intake_recipe_pair.bind',
      'reception.intake_recipe_pair.configure',
      'reception.intake_recipe_pair.clear',
      'reception.emergency_disable_all',
      'reception.page.get',
      'reception.page.upsert',
      'reception.abuse_inbox.list',
      'reception.abuse_inbox.ban_ip',
      'reception.abuse_inbox.unban_ip',
      'reception.template.list',
      'reception.compose.propose',
    ],
    handlers: {
      'reception.endpoints.list': async (args, client) =>
        handleReceptionEndpointsList(
          deps,
          args as ReceptionEndpointsListFilter | undefined,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'reception.endpoint.preview_draft': async (args, client) =>
        handleReceptionEndpointPreviewDraft(
          deps,
          args as ReceptionEndpointPreviewInput,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'reception.endpoint.create': async (args, client) =>
        handleReceptionEndpointCreate(
          deps,
          args as ReceptionEndpointCreateInput,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'reception.endpoint.rotate_token': async (args, client) =>
        handleReceptionEndpointRotateToken(
          deps,
          args as ReceptionEndpointRotateInput,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'reception.endpoint.enable': async (args, client) =>
        handleReceptionEndpointEnable(
          deps,
          args as ReceptionEndpointMutationInput,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'reception.endpoint.disable': async (args, client) =>
        handleReceptionEndpointDisable(
          deps,
          args as ReceptionEndpointMutationInput,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'reception.endpoint.revoke': async (args, client) =>
        handleReceptionEndpointRevoke(
          deps,
          args as ReceptionEndpointRevokeInput,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'reception.endpoint.extend': async (args, client) =>
        handleReceptionEndpointExtend(
          deps,
          args as ReceptionEndpointExtendInput,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'reception.endpoint.access_log': async (args, client) =>
        handleReceptionEndpointAccessLog(
          deps,
          args as ReceptionEndpointAccessLogInput,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'reception.intake_recipe_pair.get': async (args, client) =>
        handleReceptionIntakeRecipePairGet(
          deps,
          args as ReceptionIntakeRecipePairGetInput,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'reception.intake_recipe_pair.bind': async (args, client) =>
        handleReceptionIntakeRecipePairBind(
          deps,
          args as ReceptionIntakeRecipePairBindInput,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'reception.intake_recipe_pair.configure': async (args, client) =>
        handleReceptionIntakeRecipePairConfigure(
          deps,
          args as ReceptionIntakeRecipePairConfigureInput,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'reception.intake_recipe_pair.clear': async (args, client) =>
        handleReceptionIntakeRecipePairClear(
          deps,
          args as ReceptionIntakeRecipePairClearInput,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'reception.emergency_disable_all': async (args, client) =>
        handleReceptionEmergencyDisableAll(
          deps,
          args as ReceptionEmergencyDisableAllInput | undefined,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'reception.page.get': async (_args, client) =>
        handleReceptionPageGet(
          deps,
          undefined,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'reception.page.upsert': async (args, client) =>
        handleReceptionPageUpsert(
          deps,
          args as ReceptionPageUpsertInput,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'reception.abuse_inbox.list': async (args, client) =>
        handleReceptionAbuseInboxList(
          deps,
          args as ReceptionAbuseInboxListInput | undefined,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'reception.abuse_inbox.ban_ip': async (args, client) =>
        handleReceptionAbuseInboxBanIp(
          deps,
          args as ReceptionAbuseInboxBanIpInput,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'reception.abuse_inbox.unban_ip': async (args, client) =>
        handleReceptionAbuseInboxUnbanIp(
          deps,
          args as ReceptionAbuseInboxUnbanIpInput,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'reception.template.list': async (_args, client) =>
        handleReceptionTemplateList(
          deps,
          undefined,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
      'reception.compose.propose': async (args, client) =>
        handleReceptionComposePropose(
          deps,
          args as ReceptionComposeProposeInput,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
    },
  };
};

// ────────────────────────────────────────────────────────────────
// D-173 P2 / P3-rpc — reception.inbox.* registration
// ────────────────────────────────────────────────────────────────

/** Build the `reception.inbox.*` handler map (D-173 N.2), bound to the
 *  server's `WsClient` dispatcher context. This is the registration the
 *  fence assigns to this file; the handler logic + the
 *  `checkpoint.arg_overrides` narrow writer (the N.5 security boundary)
 *  live in `reception-inbox-handler.ts`.
 *
 *  Boot-wiring is DEFERRED to a consolidator integration step (per the
 *  D-173 P2/P3 dispatch): this factory is exported ready-to-wire but is
 *  NOT composed into `recued-server` boot here, and `wire-reception-
 *  substrate.ts` is intentionally untouched. The integration step
 *  composes the returned slice AND folds the three `reception.inbox.*`
 *  method specs into `ServerRpcRegistry` + `SERVER_RPC_METHOD_SET` (so
 *  the dispatcher routes them) + the `reception_inbox` kind into the
 *  `ServerEvent` broadcast union. The shared `resolveArgEditSchema`
 *  resolver (Lane P) is injected via `deps` at that step. Returns
 *  `undefined` when deps are absent (the integration step drops the
 *  slice — matching the reception / history slice posture). */
export const makeReceptionInboxRpcHandlers = (
  deps: ReceptionInboxDeps | undefined,
):
  | {
      methods: ReadonlyArray<keyof ReceptionInboxHandlers<WsClient>>;
      handlers: ReceptionInboxHandlers<WsClient>;
    }
  | undefined => makeReceptionInboxHandlers<WsClient>(deps);

export type { ReceptionInboxDeps } from './reception-inbox-handler.js';

/** D-210 step 2a — the record read surface's rpc slice, re-exported here so `ws-server`
 *  keeps ONE import site for every reception handler factory. Typed as a real
 *  `HandlerSlice` (not the structural shape) so the registry's exhaustiveness check applies
 *  to it exactly as it does to the endpoint slice above. */
export const makeReceptionRecordRpcHandlers = (
  deps: ReceptionRecordDeps | undefined,
): HandlerSlice<ServerRpcRegistry, 'reception.record.list', WsClient> | undefined => {
  const slice = makeReceptionRecordHandlers<WsClient>(deps);
  return slice === undefined
    ? undefined
    : { methods: slice.methods, handlers: slice.handlers };
};

export type { ReceptionRecordDeps } from './reception-record-handler.js';

/** D-210 Appendix B — the on-the-go reschedule-link mint rpc slice, re-exported
 *  here so `ws-server` keeps ONE import site for every reception handler factory.
 *  Typed as a real `HandlerSlice` so the registry's exhaustiveness check applies. */
export const makeReceptionManageMintRpcHandlers = (
  deps: ReceptionManageMintDeps | undefined,
): HandlerSlice<ServerRpcRegistry, 'reception.manage.mint', WsClient> | undefined => {
  const slice = makeReceptionManageMintHandlers<WsClient>(deps);
  return slice === undefined
    ? undefined
    : { methods: slice.methods, handlers: slice.handlers };
};

export type { ReceptionManageMintDeps } from './reception-manage-mint-handler.js';

/** D-240 § D11 — the per-record viewback revoke rpc slice, re-exported here for
 *  the same reason as its neighbours: `ws-server` keeps ONE import site for
 *  every reception handler factory, and a real `HandlerSlice` type means the
 *  registry's exhaustiveness check applies. */
export const makeReceptionLookupRevokeRpcHandlers = (
  deps: ReceptionLookupRevokeDeps | undefined,
): HandlerSlice<ServerRpcRegistry, 'reception.lookup.revoke', WsClient> | undefined => {
  const slice = makeReceptionLookupRevokeHandlers<WsClient>(deps);
  return slice === undefined
    ? undefined
    : { methods: slice.methods, handlers: slice.handlers };
};

export type { ReceptionLookupRevokeDeps } from './reception-lookup-revoke-handler.js';
