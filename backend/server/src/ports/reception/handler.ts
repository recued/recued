/** D-149 P3 § A.2 + § A.3 — Reception path-mount handler.
 *
 *  Reception is the user's server's anonymous-visitor surface — D-148
 *  § A.6 / § A.7 path-routing dispatcher mounts this handler at
 *  `/reception/*` on each of the two listeners (port 80 LAN + port 443
 *  public TLS) per the per-path resolution bits (W3.7 path-mount swap;
 *  supersedes the pre-amendment 4th-port-binding framing on port 8446).
 *
 *  P1 shipped the canonical health probe + the vendor-agnostic 404
 *  floor. P3 wires the path-routing dispatch into the per-kind handler
 *  skeletons (P2's 503-returning stubs at `handlers/*.ts`) — the dispatch
 *  layer pulls together six concerns per request:
 *
 *    1. Extract token from query (`?t=`) / `X-Recued-Endpoint-Token`
 *       header / `Authorization: Bearer` header (per § A.18.1
 *       presentation method per kind). Approval-link URLs DO NOT carry
 *       the secret; the visitor pastes the secret out-of-band into the
 *       consent form.
 *    2. Per-IP rate-limit check BEFORE HMAC compute per § Must Hold I-10
 *       (rate-limit-before-verify ordering).
 *    3. Registry lookup with 60s staleness ceiling per § Must Hold I-5
 *       (cache hit avoids the SQL roundtrip + HMAC fetch).
 *    4. Constant-time bearer verify per § A.18.2.
 *    5. Per-endpoint daily-cap check post-verify (endpoint_id required).
 *    6. Dispatch to the per-kind handler skeleton in
 *       `RECEPTION_KIND_HANDLERS` (P2-shipped; returns 503
 *       `not_implemented` until P4-P9 fill the live render).
 *
 *  Every request emits a row to `public_endpoint_access_log` regardless
 *  of outcome (`view` / `submit` / `upload` / `approve` / `expired` /
 *  `invalid_token` / `rate_limited` / `revoked`). High-assurance audit
 *  rows (D-120 signed entries) fire only on mutations + revocations +
 *  drop receipt + approval consumption + form submission — see
 *  `RECEPTION_HIGH_ASSURANCE_AUDIT_KINDS` (§ N.3 + § A.16.5).
 *
 *  Health surface — single canonical path:
 *    - `/reception/_health` — D-149 § A.2 path-routing-table entry.
 *      Owned here (the generic `/health` is the dedicated `health`
 *      PathRole, dispatched before this handler runs).
 *
 *  Reception code paths MUST NOT import from `packages/engine/` or
 *  `packages/recipes/` (Must Hold I-12 + role-boundary lint at
 *  `__tests__/d-149-phase-1-reception-role-boundary.test.ts`) and
 *  MUST NOT reference the Pro entitlement registry or per-tier flags
 *  (Must Hold I-3 + same lint).
 *
 *  Spec: D-149 § A.2 + § A.3 + § A.16 + § A.18. */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  RECEPTION_EVENT_PLATFORM,
  RECEPTION_IP_BLOCKED_REJECTION_REASON,
  RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
  RECEPTION_PAGE_STATIC_PATH_PREFIX,
  RpcError,
  type ReceptionAccessAction,
  type ReceptionAccessOutcome,
  type ReceptionEndpointKind,
  type TrustFooterDeploymentMode,
} from '@recued/contracts';
import type { WarehouseEventBus } from '@recued/warehouse-events';
import { receptionSourceKey } from '../../watch/source-registry.js';
import { writeJson } from '../common/respond.js';
import type { PublicEndpointRegistryStore } from '../../storage/public-endpoint-registry-store.js';
import type { AuditLogStore } from '@recued/storage';
import type { ReceptionRegistryCache } from './registry-cache.js';
import type { ReceptionRateLimiter } from './rate-limiter.js';
import {
  computeBearerHmac,
  hashSourceIpEndpointScoped,
  hashSourceIpServerWide,
} from './server-secret-pepper.js';
import { verifyBearerSecret } from './token-primitives.js';
import { RECEPTION_KIND_HANDLERS } from './handlers/index.js';
import { createReceptionPagePacketHandler } from './handlers/reception-page.js';
import {
  createSchedulingLinkPacketHandler,
  type SchedulingCalendarEventsReader,
  type SchedulingFormNonceStore,
} from './handlers/scheduling-link.js';
import { createSchedulingLinkBookHandler } from './handlers/scheduling-link-book.js';
import {
  createIntakeFormPacketHandler,
  createIntakeFormSubmitHandler,
  type CoordinateIntakeFormPairedRun,
  type IntakeFormNonceStore,
  type ResolveIntakeFormRecipePair,
} from './handlers/intake-form.js';
import {
  createDropLinkPacketHandler,
  createDropLinkUploadHandler,
  type DropLinkNonceStore,
} from './handlers/drop-link.js';
import {
  createDropUploadHandler,
  type ReceptionUploadOp,
} from './handlers/drop-upload.js';
import type { ReceptionUploadService } from '../../upload/reception-upload-service.js';
import type { DropBlobStore } from '../../storage/reception-drop-store.js';
import {
  createApprovalLinkConsumeHandler,
  createApprovalLinkPacketHandler,
  type ApprovalLinkNonceStore,
} from './handlers/approval-link.js';
import type { ApprovalIntentStore } from '../../storage/reception-approval-store.js';
import {
  createStatusLinkPacketHandler,
  type StatusEntitySourceReader,
} from './handlers/status-link.js';
import type { StatusProjectionStore } from '../../storage/reception-status-projection-store.js';
import { lookupReceptionStaticAsset } from './static-assets.js';
import type { ReceptionEndpointContext, ReceptionPacketKind } from './redacted-packet.js';
import type { FormSubmissionStore } from '../../storage/reception-form-store.js';
import type { ReceptionIpBlockStore } from '../../storage/reception-ip-block-store.js';
import type { SellerClaimStore } from '../../storage/seller-claim-store.js';
import {
  createSellerClaimHandler,
  RECEPTION_SELLER_CLAIM_ENDPOINT_ID,
  RECEPTION_SELLER_CLAIM_PATH,
} from './handlers/seller-claim.js';
import type { ReceptionManageCredentialStore } from '../../storage/reception-manage-credential-store.js';
import {
  createReceptionManageHandler,
  RECEPTION_MANAGE_ENDPOINT_ID,
  RECEPTION_MANAGE_PATH,
  type ReceptionManageRescheduleRun,
} from './handlers/manage.js';
import {
  createReceptionLookupHandler,
  parseLookupSecretFromPath,
} from './handlers/lookup.js';
import { RECEPTION_LOOKUP_PATH } from './handlers/visitor-lookup-mint.js';

/** D-149 § A.2 — canonical Reception health-probe path. */
export const RECEPTION_HEALTH_PATH = '/reception/_health' as const;

/** Per-endpoint-kind path prefix. The `reception_page` kind has the
 *  bare `/reception/` path (no kind segment); other kinds nest under
 *  `/reception/<segment>/<endpoint_id>`. */
const PATH_PREFIX_FOR_KIND: Record<
  Exclude<ReceptionEndpointKind, 'reception_page'>,
  string
> = {
  scheduling_link: '/reception/scheduling/',
  intake_form: '/reception/intake/',
  drop_link: '/reception/drop/',
  approval_link: '/reception/approve/',
  status_link: '/reception/status/',
} as const;

const ENDPOINT_KIND_TO_PACKET_KIND: Record<ReceptionEndpointKind, ReceptionPacketKind> = {
  reception_page: 'reception_page_packet',
  scheduling_link: 'scheduling_link_packet',
  intake_form: 'intake_form_packet',
  drop_link: 'drop_link_packet',
  approval_link: 'approval_link_packet',
  status_link: 'status_link_packet',
};

export interface ReceptionPortHandlerDeps {
  readonly getStore: () => PublicEndpointRegistryStore;
  readonly getCache: () => ReceptionRegistryCache;
  readonly getRateLimiter: () => ReceptionRateLimiter;
  readonly getPepper: () => Buffer;
  readonly now: () => number;
  /** Codex review P1 #4 fold — trust gate for `X-Forwarded-For`. Direct
   *  LAN / public listeners (no reverse proxy in front) MUST NOT trust
   *  caller-supplied XFF — an anonymous visitor could rotate the
   *  header per request to poison source-IP hashes + bypass per-IP
   *  rate-limit buckets. Default false (cautious). Operators behind a
   *  trusted proxy / Pro tunnel flip this on at boot.
   *
   *  Future hardening: a `trustedProxyCIDRs: string[]` config would
   *  let mixed deployments accept XFF only when the socket peer is in
   *  a configured CIDR; v1 ships the binary toggle. */
  readonly trustForwardedFor?: boolean;
  /** D-188 — master "Pause server" flag. When true, the reception door is
   *  CLOSED: every visitor-facing path (page render, static assets, intake
   *  submits, status) is rejected (503 server_paused) EXCEPT the `_health`
   *  liveness probe (monitoring must survive a pause). Reception intake
   *  bypasses the op-admission gate, so closing it here is how pause reaches
   *  the public reception port. Read per-request → resume is instant.
   *  Absent ⇒ never paused. */
  readonly isPaused?: () => boolean;
  readonly getSchedulingCalendarReader?: () => SchedulingCalendarEventsReader;
  readonly getSchedulingFormNonceStore?: () => SchedulingFormNonceStore;
  /** D-149 P6 § A.5.3 — intake_form dependencies. Both are required
   *  for the kind's GET render + POST submit flow to be live; when
   *  either is absent the dispatcher falls back to the kind-registry
   *  503 stub. */
  readonly getIntakeFormSubmissionStore?: () => FormSubmissionStore;
  readonly getIntakeFormNonceStore?: () => IntakeFormNonceStore;
  /** D-200 Slice 6g.2 — optional source-checked pair resolver. Absent keeps
   * the generic D-149 intake path; stale configured pairs fail closed. */
  readonly resolveIntakeFormRecipePair?: ResolveIntakeFormRecipePair;
  /** D-200 Slice 6g.13 — source-derived synchronous Checkout callback. The
   * submit handler invokes it only after a paired pending submission is
   * durable; only its checked hosted URL can authorize a 303. */
  readonly coordinateIntakeFormPairedRun?: CoordinateIntakeFormPairedRun;
  /** Form-PII AEAD key derived from the reception sub-DEK via
   *  `deriveFormSubmissionPiiKeyFromSubDek`. Separate from the
   *  booking-PII key by HKDF info label so the two streams stay
   *  cryptographically distinct. Throws when the FileVault is locked. */
  readonly getIntakeFormSubmissionPiiKey?: () => Uint8Array;
  /** D-240 slice 3b — run an endpoint's bound viewback recipe. Absent ⇒ the
   *  lookup page renders the substrate-projected status instead. */
  readonly runReceptionLookupRecipe?: (input: {
    readonly endpoint_id: string;
    readonly record_id: string;
    readonly record: Readonly<Record<string, unknown>>;
  }) => Promise<import('../../reception-lookup-recipe-runner.js').ReceptionLookupRunOutcome>;
  /** D-149 P7 § A.5.4 — drop_link dependencies. All four are required
   *  for the kind's GET render + POST upload flow to be live; when any
   *  is absent the dispatcher falls back to the kind-registry 503 stub.
   *  Drop-PII key derives from the reception sub-DEK via
   *  `deriveDropBlobPiiKeyFromSubDek`. */
  readonly getDropBlobStore?: () => DropBlobStore;
  /** D-172 P1 — unified CAS for uploaded file bytes. */
  readonly getBlobStore?: () => import('../../storage/blob-store.js').BlobStore;
  readonly getDropLinkNonceStore?: () => DropLinkNonceStore;
  readonly getDropBlobPiiKey?: () => Uint8Array;
  /** Absolute filesystem root for drop blob scratch space (per spec
   *  § A.5.4 line 825 — `backend/server/src/storage/drop_blobs/`).
   *  The handler streams through `<root>/_tmp`, writes the complete
   *  bytes to the shared CAS BlobStore, and persists the CAS hash on
   *  the metadata row. */
  readonly getDropBlobsRoot?: () => string;
  /** D-172 step 5a — resumable drop-link upload service. When wired, the
   *  dispatcher mounts the create / probe / chunk / finalize / delete HTTP
   *  endpoints under `/reception/drop/<id>/uploads` (the data plane is gated by
   *  the unguessable `upload_id` + the core disk caps, NOT the link-style
   *  request limiter). Absent ⇒ those sub-paths 404 — the JS-free single-POST
   *  `<form>` stays the only upload path. */
  readonly getReceptionUploadService?: () => ReceptionUploadService;
  /** D-149 P8 § A.5.5 — approval_link dependencies. All four are
   *  required for the kind's GET render + POST consume flow to be
   *  live; when any is absent the dispatcher falls back to the kind-
   *  registry 503 stub. Approval-PII key derives from the reception
   *  sub-DEK via `deriveApprovalIntentPiiKeyFromSubDek`. */
  readonly getApprovalIntentStore?: () => ApprovalIntentStore;
  readonly getApprovalLinkNonceStore?: () => ApprovalLinkNonceStore;
  readonly getApprovalIntentPiiKey?: () => Uint8Array;
  /** D-149 P9 § A.5.6 — status_link dependencies. Both are required
   *  for the kind's GET render (HTML + JSON polling) to be live; when
   *  either is absent the dispatcher falls back to the kind-registry
   *  503 stub. The entity-source reader resolves `data.*.<id>` rows
   *  via the warehouse layer; bin.ts wires the production reader and
   *  passes `NULL_STATUS_ENTITY_SOURCE_READER` as the placeholder
   *  before the warehouse layer is ready. */
  readonly getStatusProjectionStore?: () => StatusProjectionStore;
  readonly getStatusEntitySourceReader?: () => StatusEntitySourceReader;
  /** D-120 audit log emitter. Required for the signed
   *  `form_submission.received` row at booking time. When absent the
   *  POST /book handler still persists the booking row + the
   *  operational log entry; only the signed audit emit is skipped. */
  readonly auditLog?: AuditLogStore;
  /** D-149 P12 § A.20.5 — Abuse Inbox per-server IP block store. When
   *  wired, the dispatcher checks `(endpoint_id, source_ip_hash)`
   *  against the block list BEFORE the per-IP rate-limit consume, so a
   *  banned visitor is rejected (403) before any further substrate
   *  work. When absent the check is skipped (fail-open — a missing
   *  store is a boot-phase posture, not an attack). bin.ts wires it
   *  unconditionally. */
  readonly getIpBlockStore?: () => ReceptionIpBlockStore;
  /** D-149 P12 § A.20.7 — deployment mode for the Public Trust Footer,
   *  threaded into every per-kind GET-render handler factory. A
   *  boot-constant derived in `bin.ts` from the resolved public base
   *  URL host (`isProDdnsHost` → `pro_cloud` / `byo_ddns`). When absent
   *  (the P1 deps-less baseline) no handler renders a trust footer. */
  readonly receptionDeploymentMode?: TrustFooterDeploymentMode;
  /** D-196 S3b — short-lived customer claim credentials. This is a dedicated
   * `/reception/claim` surface, not a seventh endpoint kind. */
  readonly getSellerClaimStore?: () => SellerClaimStore;
  /** D-210 Appendix B — the on-the-go reschedule surface (`/reception/manage`),
   *  a dedicated single-use-credential path like `/reception/claim` (NOT an
   *  endpoint kind). All three are required for the surface to be live; absent ⇒
   *  the path 404s. The runner is typed structurally (just `{ run }`) so the
   *  port stays decoupled from the engine-side reschedule runner (I-12).
   *  `receptionManageCalendarSlug` is fed from the wire because the port cannot
   *  import `collections/calendar` for the local calendar slug the manage
   *  handler targets the booking's event with. */
  readonly getReceptionManageCredentialStore?: () => ReceptionManageCredentialStore;
  readonly getReceptionManageRescheduleRunner?: () => { run: ReceptionManageRescheduleRun };
  readonly receptionManageCalendarSlug?: string;
  /** WatchSource reception push source — when present, every VERIFIED
   *  mutation arrival (the post-verify `submit` / `upload` / `approve`
   *  access-log write; never `view` renders) emits one canonical
   *  `data.reception.<kind>.request.created` warehouse event so
   *  `event_triggers` recipes can react to inbound reception traffic.
   *  The event `record` carries `{ endpoint_id, kind, action }` ONLY —
   *  visitor payloads stay sealed in the reception stores (I-9). The
   *  emit happens BEFORE the per-kind handler runs: it signals a
   *  verified ARRIVAL, not a successful materialization (review-mode
   *  processing happens later at the drain). */
  readonly warehouseBus?: Pick<WarehouseEventBus, 'emit'>;
  /** WatchSource registry liveness hook — `(source_key, at)` after
   *  each arrival emit. */
  readonly markSourceEvent?: (source_key: string, at: number) => void;
}

/** Per-request parse — extract endpoint_kind + endpoint_id from the
 *  path. Returns null for paths that don't match any kind (caller
 *  responds 404). The `action` segment is the per-kind verb after the
 *  endpoint_id (e.g. `'book'` for `scheduling_link` POST, `'consume'`
 *  for `approval_link` POST). */
const parsePath = (
  pathname: string,
): {
  kind: ReceptionEndpointKind;
  endpoint_id: string | null;
  action: string | null;
  /** Path segments AFTER the first action segment. Empty for every kind
   *  except the drop_link resumable sub-tree (`…/uploads/<upload_id>[/…]`),
   *  which the dispatcher parses further (D-172 step 5a). Other kinds keep
   *  consulting `action` alone, so their routing is unchanged. */
  action_rest: readonly string[];
} | null => {
  // The bare `/reception/` or `/reception` route maps to `reception_page`
  // (the user's homepage surface); endpoint_id is implicit (the
  // server-singleton row).
  if (pathname === '/reception/' || pathname === '/reception') {
    return { kind: 'reception_page', endpoint_id: null, action: null, action_rest: [] };
  }
  for (const [kind, prefix] of Object.entries(PATH_PREFIX_FOR_KIND) as Array<
    [Exclude<ReceptionEndpointKind, 'reception_page'>, string]
  >) {
    if (pathname.startsWith(prefix)) {
      const rest = pathname.slice(prefix.length);
      const segments = rest.split('/');
      const endpoint_id = segments[0];
      if (!endpoint_id) return null;
      const action = segments[1];
      return {
        kind,
        endpoint_id,
        action: typeof action === 'string' && action.length > 0 ? action : null,
        action_rest: segments.slice(2),
      };
    }
  }
  return null;
};

/** D-172 step 5a — classify a `/reception/drop/<id>/uploads…` request (the
 *  caller has already matched `kind === 'drop_link'` + `action === 'uploads'`).
 *  Returns null for an unsupported method / sub-shape (the caller 404s). */
const classifyUploadOp = (
  action_rest: readonly string[],
  method: string | undefined,
): { op: ReceptionUploadOp; upload_id: string | null } | null => {
  if (action_rest.length === 0) {
    return method === 'POST' ? { op: 'create', upload_id: null } : null;
  }
  const upload_id = action_rest[0];
  if (!upload_id) return null;
  if (action_rest.length === 1) {
    if (method === 'GET') return { op: 'probe', upload_id };
    if (method === 'POST') return { op: 'chunk', upload_id };
    if (method === 'DELETE') return { op: 'delete', upload_id };
    return null;
  }
  if (action_rest.length === 2 && action_rest[1] === 'finalize' && method === 'POST') {
    return { op: 'finalize', upload_id };
  }
  return null;
};

/** Per § A.18 token presentation. Query string is the canonical visitor
 *  surface; header forms accepted for tooling. Approval-link kind
 *  ignores all three sources at the URL — secret is form-field-borne. */
const extractBearer = (req: IncomingMessage, url: URL): string | null => {
  const q = url.searchParams.get('t');
  if (q && q.length > 0) return q;
  const headerToken = req.headers['x-recued-endpoint-token'];
  if (typeof headerToken === 'string' && headerToken.length > 0) return headerToken;
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  return null;
};

/** Redact `?t=` from the URL the access log writes. Per § A.16
 *  visitor PII contract: tokens never appear in the operational log. */
const redactUrl = (rawUrl: string): string => {
  const idx = rawUrl.indexOf('?');
  if (idx < 0) return rawUrl;
  const path = rawUrl.slice(0, idx);
  const query = rawUrl.slice(idx + 1);
  const params = new URLSearchParams(query);
  params.delete('t');
  const out = params.toString();
  return out.length === 0 ? path : `${path}?${out}`;
};

/** Best-effort client IP. Codex review P1 #4 fold — `X-Forwarded-For`
 *  is trusted ONLY when the deployment is behind a known proxy /
 *  Pro tunnel (caller sets `trustForwardedFor: true`). On direct LAN
 *  / public listeners the header is caller-supplied + would let an
 *  anonymous visitor rotate the value per request, poisoning the
 *  source-IP hashes + bypassing per-IP rate-limit buckets. The hash
 *  function in `server-secret-pepper.ts` is the single boundary at
 *  which the raw IP turns into the persisted shape. */
const clientIp = (req: IncomingMessage, trustForwardedFor: boolean): string => {
  if (trustForwardedFor) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length > 0) {
      const [first] = fwd.split(',');
      if (first) return first.trim();
    }
  }
  return req.socket.remoteAddress ?? '0.0.0.0';
};

const writeAccessLog = (
  deps: ReceptionPortHandlerDeps,
  input: {
    endpoint_id: string;
    accessed_at: number;
    source_ip_hash: string | null;
    action_taken: ReceptionAccessAction;
    outcome: ReceptionAccessOutcome;
    url_path_redacted: string;
    /** Optional structured metadata — e.g. `{ rejection_reason: 'ip_blocked' }`
     *  so the Abuse Inbox classifier can fan a `rejected` outcome out
     *  by reason. Defaults to `{}` (the common case). */
    metadata?: Readonly<Record<string, unknown>>;
  },
): void => {
  try {
    deps.getStore().appendAccessLog({
      id: randomUUID(),
      endpoint_id: input.endpoint_id,
      accessed_at: input.accessed_at,
      source_ip_hash: input.source_ip_hash,
      user_agent_hash: null,
      action_taken: input.action_taken,
      outcome: input.outcome,
      url_path_redacted: input.url_path_redacted,
      metadata: input.metadata ?? {},
    });
  } catch {
    // Never fail a request on log-write error. Operational logs are
    // best-effort; the substrate's visibility is more important than
    // 100% logging fidelity.
  }
};

/** D-149 P12 § A.20.5 — IP-block-list membership check. Returns `false`
 *  when the store is not wired (boot-phase posture, not an attack) +
 *  fails OPEN on a store error (a block-store fault is a substrate bug;
 *  503-ing every visitor is worse than letting a request through —
 *  mirrors the § A.21 "rate limiter unavailable → fail-open" posture).
 *  The `(endpoint_id, source_ip_hash)` pair uses the ENDPOINT-SCOPED
 *  source-IP hash — the same value the access log persists. */
const isIpBlocked = (
  deps: ReceptionPortHandlerDeps,
  endpoint_id: string,
  source_ip_hash: string,
): boolean => {
  const store = deps.getIpBlockStore?.();
  if (!store) return false;
  try {
    return store.isBlocked(endpoint_id, source_ip_hash);
  } catch {
    return false;
  }
};

export const createReceptionPortHandler = (
  deps?: ReceptionPortHandlerDeps,
): ((req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
  // P1 baseline — handler runs without deps for the 404 floor (the
  // path-routing dispatcher mounts the handler before the persistence
  // layer is composed). P3 + downstream pass deps when wired.
  if (!deps) {
    return async (req, res) => {
      const url = req.url ?? '/';
      const [pathname] = url.split('?');
      if (req.method === 'GET' && pathname === RECEPTION_HEALTH_PATH) {
        writeJson(res, 200, { status: 'ok' });
        return;
      }
      writeJson(res, 404, { error: { code: 'not_found' } });
    };
  }

  // D-149 P4 — singleton handler is deps-bound; built once per dispatcher
  // boot so the registry cursor isn't re-resolved per request.
  const receptionPageHandler = createReceptionPagePacketHandler({
    getStore: deps.getStore,
    now: deps.now,
    ...(deps.receptionDeploymentMode !== undefined
      ? { receptionDeploymentMode: deps.receptionDeploymentMode }
      : {}),
  });

  const sellerClaimHandler = deps.getSellerClaimStore
    ? createSellerClaimHandler({
        getClaimStore: deps.getSellerClaimStore,
        now: deps.now,
        trustForwardedProto: deps.trustForwardedFor === true,
      })
    : null;

  // D-210 Appendix B — the `/reception/manage/<secret>` on-the-go reschedule
  // surface. Live only when its credential store + reschedule runner + the
  // scheduling stores (it reuses the booking + calendar + form-nonce plumbing)
  // + the injected calendar slug are all wired; otherwise the path 404s. The
  // target booking event is resolved server-side from the credential — the form
  // only carries the new slot (see `manage.ts`).
  const manageHandler =
    deps.getReceptionManageCredentialStore &&
    deps.getReceptionManageRescheduleRunner &&
    deps.getIntakeFormSubmissionStore &&
    deps.getSchedulingCalendarReader &&
    deps.getSchedulingFormNonceStore &&
    deps.receptionManageCalendarSlug !== undefined
      ? createReceptionManageHandler({
          getCredentialStore: deps.getReceptionManageCredentialStore,
          // D-210 A.8 slice 4b-ii — the reservation is a `reception_form_submission`
          // row now. Same id, same lookup; different table.
          findBooking: (id) => deps.getIntakeFormSubmissionStore!().findById(id),
          getRegistryStore: deps.getStore,
          getCalendarReader: deps.getSchedulingCalendarReader,
          getFormNonceStore: deps.getSchedulingFormNonceStore,
          calendarSlug: deps.receptionManageCalendarSlug,
          runReschedule: (input) => deps.getReceptionManageRescheduleRunner!().run(input),
          now: deps.now,
          trustForwardedProto: deps.trustForwardedFor === true,
        })
      : null;

  // D-149 P5 — scheduling_link GET render + POST /book handlers are
  // deps-bound when the substrate-side stores are wired. When ANY of
  // the four deps is absent we fall through to the kind-registry 503
  // stub (the P2-shipped placeholder).
  const schedulingDepsReady =
    deps.getIntakeFormSubmissionStore !== undefined &&
    deps.getSchedulingCalendarReader !== undefined &&
    deps.getSchedulingFormNonceStore !== undefined;

  const schedulingGetHandler = schedulingDepsReady
    ? createSchedulingLinkPacketHandler({
        getStore: deps.getStore,
        getCalendarReader: deps.getSchedulingCalendarReader!,
        getFormNonceStore: deps.getSchedulingFormNonceStore!,
        now: deps.now,
        ...(deps.receptionDeploymentMode !== undefined
          ? { receptionDeploymentMode: deps.receptionDeploymentMode }
          : {}),
      })
    : null;

  const schedulingBookHandler =
    schedulingDepsReady &&
    deps.getIntakeFormSubmissionPiiKey !== undefined &&
    deps.auditLog !== undefined
      ? createSchedulingLinkBookHandler({
          getStore: deps.getStore,
          getSubmissionStore: deps.getIntakeFormSubmissionStore!,
          getCalendarReader: deps.getSchedulingCalendarReader!,
          getFormNonceStore: deps.getSchedulingFormNonceStore!,
          // ⚠ The FORM key, not the booking one — see `booking-blob.ts`.
          getFormSubmissionPiiKey: deps.getIntakeFormSubmissionPiiKey,
          auditLog: deps.auditLog,
          now: deps.now,
          ...(deps.receptionDeploymentMode !== undefined
            ? { receptionDeploymentMode: deps.receptionDeploymentMode }
            : {}),
          // D-240 — the booking arm of the viewback mint.
          ...(deps.getReceptionManageCredentialStore
            ? { getCredentialStore: deps.getReceptionManageCredentialStore }
            : {}),
        })
      : null;

  // D-149 P6 § A.5.3 — intake_form GET render + POST submit handlers.
  // Both are deps-bound when the substrate-side stores are wired. When
  // either nonce store or submission store is absent we fall through to
  // the kind-registry 503 stub. PII key + audit log are required for
  // POST only — GET works without them.
  const intakeFormGetReady =
    deps.getIntakeFormNonceStore !== undefined;
  const intakeFormPostReady =
    intakeFormGetReady &&
    deps.getIntakeFormSubmissionStore !== undefined &&
    deps.getIntakeFormSubmissionPiiKey !== undefined &&
    deps.auditLog !== undefined;

  // D-200 Slice 6g.12 audit fold — once an endpoint has an exact paid pair,
  // the visitor path is live only when the claim adapter is composed too.
  // Treating a ready pair as generic/unpaired would reinterpret the form;
  // rendering it as ready without a coordinator would accept a paid intent
  // that cannot enter transaction state. The lower submit handler repeats the
  // check before persistence for direct callers and defense in depth.
  const resolvePublicIntakeFormRecipePair =
    deps.resolveIntakeFormRecipePair === undefined
      ? undefined
      : ((input: Parameters<ResolveIntakeFormRecipePair>[0]) => {
          const resolved = deps.resolveIntakeFormRecipePair!(input);
          return resolved.kind === 'ready'
            && deps.coordinateIntakeFormPairedRun === undefined
            ? { kind: 'stale' as const }
            : resolved;
        });

  const intakeFormGetHandler = intakeFormGetReady
    ? createIntakeFormPacketHandler({
        getStore: deps.getStore,
        getFormNonceStore: deps.getIntakeFormNonceStore!,
        now: deps.now,
        ...(resolvePublicIntakeFormRecipePair
          ? { resolveRecipePair: resolvePublicIntakeFormRecipePair }
          : {}),
        ...(deps.receptionDeploymentMode !== undefined
          ? { receptionDeploymentMode: deps.receptionDeploymentMode }
          : {}),
      })
    : null;

  const intakeFormSubmitHandler = intakeFormPostReady
    ? createIntakeFormSubmitHandler({
        getStore: deps.getStore,
        getSubmissionStore: deps.getIntakeFormSubmissionStore!,
        getFormNonceStore: deps.getIntakeFormNonceStore!,
        getFormSubmissionPiiKey: deps.getIntakeFormSubmissionPiiKey!,
        auditLog: deps.auditLog!,
        now: deps.now,
        ...(resolvePublicIntakeFormRecipePair
          ? { resolveRecipePair: resolvePublicIntakeFormRecipePair }
          : {}),
        ...(deps.coordinateIntakeFormPairedRun
          ? {
              coordinatePairedRun: deps.coordinateIntakeFormPairedRun,
            }
          : {}),
        ...(deps.receptionDeploymentMode !== undefined
          ? { receptionDeploymentMode: deps.receptionDeploymentMode }
          : {}),
        // D-240 slice 2 — the submit-time viewback mint. OPTIONAL: a server
        // without the credential store simply renders receipts with no link,
        // which is the pre-D-240 behaviour byte for byte.
        ...(deps.getReceptionManageCredentialStore
          ? { getCredentialStore: deps.getReceptionManageCredentialStore }
          : {}),
      })
    : null;

  // D-240 slice 3 — the submitter's viewback route. Live only when the
  // credential store + the submission store are both wired; otherwise the path
  // 404s exactly as it did before D-240.
  const lookupHandler =
    deps.getReceptionManageCredentialStore && deps.getIntakeFormSubmissionStore
      ? createReceptionLookupHandler({
          getCredentialStore: deps.getReceptionManageCredentialStore,
          findRecord: (id) => deps.getIntakeFormSubmissionStore!().findById(id),
          now: deps.now,
          // D-240 slice 3b — optional: without it the page renders the substrate
          // status, which is what slice 3 shipped and remains correct.
          ...(deps.runReceptionLookupRecipe
            ? { runLookupRecipe: deps.runReceptionLookupRecipe }
            : {}),
        })
      : null;

  // D-149 P7 § A.5.4 — drop_link GET render + POST upload handlers.
  // GET only needs the nonce store; POST needs the metadata store + CAS
  // blob store + nonce store + drop-PII key + scratch root + audit log. When
  // any required dep is absent the dispatcher falls back to the kind-
  // registry 503 stub.
  const dropLinkGetReady = deps.getDropLinkNonceStore !== undefined;
  const dropLinkPostReady =
    dropLinkGetReady &&
    deps.getDropBlobStore !== undefined &&
    deps.getBlobStore !== undefined &&
    deps.getDropBlobPiiKey !== undefined &&
    deps.getDropBlobsRoot !== undefined &&
    deps.auditLog !== undefined;

  const dropLinkGetHandler = dropLinkGetReady
    ? createDropLinkPacketHandler({
        getStore: deps.getStore,
        getDropLinkNonceStore: deps.getDropLinkNonceStore!,
        now: deps.now,
        ...(deps.receptionDeploymentMode !== undefined
          ? { receptionDeploymentMode: deps.receptionDeploymentMode }
          : {}),
      })
    : null;

  const dropLinkUploadHandler = dropLinkPostReady
    ? createDropLinkUploadHandler({
        getStore: deps.getStore,
        getDropBlobStore: deps.getDropBlobStore!,
        getBlobStore: deps.getBlobStore!,
        getDropLinkNonceStore: deps.getDropLinkNonceStore!,
        getDropBlobPiiKey: deps.getDropBlobPiiKey!,
        getDropBlobsRoot: deps.getDropBlobsRoot!,
        auditLog: deps.auditLog!,
        now: deps.now,
        // § Must Hold I-5 — a `one_time` self-revoke on upload must drop
        // the registry-cache entry so the dispatcher stops serving the
        // stale enabled row (mirrors the rpc `endpoint.revoke` →
        // `reception.endpoint_changed` → `registryCache.invalidate` path).
        invalidateRegistryCache: (id) => deps.getCache().invalidate(id),
        ...(deps.receptionDeploymentMode !== undefined
          ? { receptionDeploymentMode: deps.receptionDeploymentMode }
          : {}),
      })
    : null;

  // D-172 step 5a — resumable drop-link upload HTTP endpoints
  // (create / probe / chunk / finalize / delete). Deps-bound when the reception
  // upload service is wired (db + CAS + drop store + nonce + PII key + audit);
  // absent ⇒ the `…/uploads` sub-tree 404s and the single-POST stays the only
  // upload path.
  const dropUploadHandler = deps.getReceptionUploadService
    ? createDropUploadHandler({
        getService: deps.getReceptionUploadService,
        trustForwardedProto: deps.trustForwardedFor === true,
      })
    : null;

  // D-149 P8 § A.5.5 — approval_link GET render + POST consume
  // handlers. GET only needs the nonce store + intent store; POST
  // needs both + the approval-PII key + audit log. When any required
  // dep is absent the dispatcher falls back to the kind-registry 503
  // stub.
  const approvalLinkGetReady =
    deps.getApprovalIntentStore !== undefined &&
    deps.getApprovalLinkNonceStore !== undefined;
  const approvalLinkPostReady =
    approvalLinkGetReady &&
    deps.getApprovalIntentPiiKey !== undefined &&
    deps.auditLog !== undefined;

  const approvalLinkGetHandler = approvalLinkGetReady
    ? createApprovalLinkPacketHandler({
        getStore: deps.getStore,
        getApprovalIntentStore: deps.getApprovalIntentStore!,
        getApprovalLinkNonceStore: deps.getApprovalLinkNonceStore!,
        now: deps.now,
        ...(deps.receptionDeploymentMode !== undefined
          ? { receptionDeploymentMode: deps.receptionDeploymentMode }
          : {}),
      })
    : null;

  const approvalLinkConsumeHandler = approvalLinkPostReady
    ? createApprovalLinkConsumeHandler({
        getStore: deps.getStore,
        getApprovalIntentStore: deps.getApprovalIntentStore!,
        getApprovalLinkNonceStore: deps.getApprovalLinkNonceStore!,
        getApprovalIntentPiiKey: deps.getApprovalIntentPiiKey!,
        auditLog: deps.auditLog!,
        now: deps.now,
        ...(deps.receptionDeploymentMode !== undefined
          ? { receptionDeploymentMode: deps.receptionDeploymentMode }
          : {}),
      })
    : null;

  // D-149 P9 § A.5.6 — status_link GET handler. Both the projection
  // store + entity-source reader are required for the live wiring;
  // when either is absent the dispatcher falls back to the kind-
  // registry 503 stub.
  const statusLinkReady =
    deps.getStatusProjectionStore !== undefined &&
    deps.getStatusEntitySourceReader !== undefined;
  const statusLinkGetHandler = statusLinkReady
    ? createStatusLinkPacketHandler({
        getStore: deps.getStore,
        getStatusProjectionStore: deps.getStatusProjectionStore!,
        getEntitySourceReader: deps.getStatusEntitySourceReader!,
        now: deps.now,
        ...(deps.receptionDeploymentMode !== undefined
          ? { receptionDeploymentMode: deps.receptionDeploymentMode }
          : {}),
      })
    : null;

  return async (req, res) => {
    const rawUrl = req.url ?? '/';
    const [pathname] = rawUrl.split('?');
    if (req.method === 'GET' && pathname === RECEPTION_HEALTH_PATH) {
      writeJson(res, 200, { status: 'ok' });
      return;
    }
    if (!pathname || !pathname.startsWith('/reception/') && pathname !== '/reception') {
      writeJson(res, 404, { error: { code: 'not_found' } });
      return;
    }
    const isSellerClaimPath = pathname === RECEPTION_SELLER_CLAIM_PATH;
    // D-210 Appendix B — `/reception/manage[/<secret>]` also carries a
    // short-lived credential (the reschedule link). Anchored on `/` so it never
    // swallows a hypothetical future `/reception/manage-*` sibling.
    const isManagePath =
      pathname === RECEPTION_MANAGE_PATH || pathname.startsWith(`${RECEPTION_MANAGE_PATH}/`);
    // D-240 — the viewback URL carries its credential in the PATH too, so it
    // takes the same no-store / no-referrer posture, and takes it here so an
    // outer gate rejecting before the handler still answers with it.
    const isLookupPath =
      pathname === RECEPTION_LOOKUP_PATH || pathname.startsWith(`${RECEPTION_LOOKUP_PATH}/`);
    if (isSellerClaimPath || isManagePath || isLookupPath) {
      // This URL carries a short-lived claim credential. Keep the sensitive
      // response posture even when an outer gate rejects before the HTML
      // handler runs (including the server-pause gate immediately below).
      res.setHeader('cache-control', 'no-store, max-age=0');
      res.setHeader('pragma', 'no-cache');
      res.setHeader('referrer-policy', 'no-referrer');
    }
    // D-188 — a paused server closes the reception door: every reception
    // path (page, assets, intake submits, status) returns 503, EXCEPT the
    // `_health` probe handled above. Checked after the prefix 404 so a
    // non-reception path still 404s, and before intake so no visitor
    // request lands while paused.
    if (deps.isPaused?.()) {
      writeJson(res, 503, {
        error: {
          code: 'server_paused',
          message: 'server is paused — reception is closed until the owner resumes',
        },
      });
      return;
    }

    // D-196 S3b — claim links are a dedicated one-time credential surface,
    // deliberately outside the ReceptionEndpointKind registry. Rate-limit
    // before touching the claim hash/store, and require the unlocked Reception
    // key posture for the same source-IP hashing used by every other path.
    if (isSellerClaimPath) {
      if (!sellerClaimHandler) {
        writeJson(res, 404, { error: { code: 'not_found' } });
        return;
      }
      let claimPepper: Buffer;
      try {
        claimPepper = deps.getPepper();
      } catch (err) {
        if (err instanceof RpcError) {
          writeJson(res, err.status ?? 503, { error: { code: err.code } });
          return;
        }
        throw err;
      }
      const claimIp = clientIp(req, deps.trustForwardedFor === true);
      const claimRateKey = hashSourceIpServerWide(claimIp, claimPepper);
      const claimSourceHash = hashSourceIpEndpointScoped(
        claimIp,
        RECEPTION_SELLER_CLAIM_ENDPOINT_ID,
        claimPepper,
      );
      const claimNow = deps.now();
      const claimUrlPathRedacted = redactUrl(rawUrl);
      if (isIpBlocked(
        deps,
        RECEPTION_SELLER_CLAIM_ENDPOINT_ID,
        claimSourceHash,
      )) {
        writeAccessLog(deps, {
          endpoint_id: RECEPTION_SELLER_CLAIM_ENDPOINT_ID,
          accessed_at: claimNow,
          source_ip_hash: claimSourceHash,
          action_taken: 'reject',
          outcome: 'rejected',
          url_path_redacted: claimUrlPathRedacted,
          metadata: { rejection_reason: RECEPTION_IP_BLOCKED_REJECTION_REASON },
        });
        writeJson(res, 403, { error: { code: 'forbidden' } });
        return;
      }
      const claimRate = deps.getRateLimiter().consumePreVerify({
        source_ip_hash: claimRateKey,
        endpoint_kind: 'reception_page',
        now: claimNow,
      });
      if (!claimRate.ok) {
        writeAccessLog(deps, {
          endpoint_id: RECEPTION_SELLER_CLAIM_ENDPOINT_ID,
          accessed_at: claimNow,
          source_ip_hash: claimSourceHash,
          action_taken: 'rate_limited',
          outcome: 'rate_limited',
          url_path_redacted: claimUrlPathRedacted,
        });
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((claimRate.retry_after_at - claimNow) / 1000),
        );
        res.setHeader('Retry-After', String(retryAfterSeconds));
        writeJson(res, 429, { error: { code: 'rate_limited' } });
        return;
      }
      const claimResult = await sellerClaimHandler(req, res);
      writeAccessLog(deps, {
        endpoint_id: RECEPTION_SELLER_CLAIM_ENDPOINT_ID,
        accessed_at: claimNow,
        source_ip_hash: claimSourceHash,
        action_taken: claimResult.action_taken,
        outcome: claimResult.outcome,
        url_path_redacted: claimUrlPathRedacted,
      });
      return;
    }

    // D-210 Appendix B — the manage/reschedule link is a dedicated single-use
    // credential surface (like `/reception/claim`), deliberately outside the
    // ReceptionEndpointKind registry. Same gate order as the claim path: IP
    // block → rate-limit → handler → access log. The URL carries the secret, so
    // it runs BEFORE `parsePath` (it is not one of the six kinds). The handler
    // returns the `{ action_taken, outcome }` the access log records, so a probe
    // hammering spent/invalid links surfaces as `rejected` in the Abuse Inbox.
    if (isManagePath) {
      if (!manageHandler) {
        writeJson(res, 404, { error: { code: 'not_found' } });
        return;
      }
      let managePepper: Buffer;
      try {
        managePepper = deps.getPepper();
      } catch (err) {
        if (err instanceof RpcError) {
          writeJson(res, err.status ?? 503, { error: { code: err.code } });
          return;
        }
        throw err;
      }
      const manageIp = clientIp(req, deps.trustForwardedFor === true);
      const manageRateKey = hashSourceIpServerWide(manageIp, managePepper);
      const manageSourceHash = hashSourceIpEndpointScoped(
        manageIp,
        RECEPTION_MANAGE_ENDPOINT_ID,
        managePepper,
      );
      const manageNow = deps.now();
      // The manage credential is in the PATH (`/reception/manage/<secret>`), not
      // the `?t=` query `redactUrl` masks — so redact the path explicitly, else
      // the live single-use link would sit in the access log in plaintext. The
      // access log only needs "a manage request happened"; the secret is noise.
      const manageUrlPathRedacted = `${RECEPTION_MANAGE_PATH}/<redacted>`;
      if (isIpBlocked(deps, RECEPTION_MANAGE_ENDPOINT_ID, manageSourceHash)) {
        writeAccessLog(deps, {
          endpoint_id: RECEPTION_MANAGE_ENDPOINT_ID,
          accessed_at: manageNow,
          source_ip_hash: manageSourceHash,
          action_taken: 'reject',
          outcome: 'rejected',
          url_path_redacted: manageUrlPathRedacted,
          metadata: { rejection_reason: RECEPTION_IP_BLOCKED_REJECTION_REASON },
        });
        writeJson(res, 403, { error: { code: 'forbidden' } });
        return;
      }
      const manageRate = deps.getRateLimiter().consumePreVerify({
        source_ip_hash: manageRateKey,
        endpoint_kind: 'reception_page',
        now: manageNow,
      });
      if (!manageRate.ok) {
        writeAccessLog(deps, {
          endpoint_id: RECEPTION_MANAGE_ENDPOINT_ID,
          accessed_at: manageNow,
          source_ip_hash: manageSourceHash,
          action_taken: 'rate_limited',
          outcome: 'rate_limited',
          url_path_redacted: manageUrlPathRedacted,
        });
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((manageRate.retry_after_at - manageNow) / 1000),
        );
        res.setHeader('Retry-After', String(retryAfterSeconds));
        writeJson(res, 429, { error: { code: 'rate_limited' } });
        return;
      }
      const manageResult = await manageHandler(req, res);
      writeAccessLog(deps, {
        endpoint_id: RECEPTION_MANAGE_ENDPOINT_ID,
        accessed_at: manageNow,
        source_ip_hash: manageSourceHash,
        action_taken: manageResult.action_taken,
        outcome: manageResult.outcome,
        url_path_redacted: manageUrlPathRedacted,
      });
      return;
    }

    // D-240 slice 3 — `/reception/lookup/<secret>`. Same gate order as the
    // manage door above (IP block → rate limit → handler → access log) and for
    // the same reasons: the URL carries its credential, so it runs BEFORE
    // `parsePath` (it is not one of the six kinds), and a probe hammering
    // invalid links must surface as `rejected` in the Abuse Inbox rather than
    // silently.
    //
    // ⚠ It reuses `RECEPTION_MANAGE_ENDPOINT_ID` for IP-hash scoping and the
    // access log. That is deliberate: the endpoint-scoped hash exists so the
    // SAME visitor at DIFFERENT endpoints produces different hashes (§ A.16.3),
    // and both of these are per-server credential doors rather than per-endpoint
    // ones — giving the viewback its own scope id would split one abuser's
    // traffic across two buckets and weaken exactly the correlation the Abuse
    // Inbox needs.
    if (isLookupPath) {
      const lookupSecret = pathname === null ? null : parseLookupSecretFromPath(pathname);
      if (!lookupHandler || lookupSecret === null) {
        writeJson(res, 404, { error: { code: 'not_found' } });
        return;
      }
      let lookupPepper: Buffer;
      try {
        lookupPepper = deps.getPepper();
      } catch (err) {
        if (err instanceof RpcError) {
          writeJson(res, err.status ?? 503, { error: { code: err.code } });
          return;
        }
        throw err;
      }
      const lookupIp = clientIp(req, deps.trustForwardedFor === true);
      const lookupRateKey = hashSourceIpServerWide(lookupIp, lookupPepper);
      const lookupSourceHash = hashSourceIpEndpointScoped(
        lookupIp,
        RECEPTION_MANAGE_ENDPOINT_ID,
        lookupPepper,
      );
      const lookupNow = deps.now();
      // The secret is in the PATH, so redact the path explicitly — otherwise a
      // live credential sits in the access log in plaintext, and this one lives
      // for weeks rather than a day.
      const lookupUrlPathRedacted = `${RECEPTION_LOOKUP_PATH}/<redacted>`;
      if (isIpBlocked(deps, RECEPTION_MANAGE_ENDPOINT_ID, lookupSourceHash)) {
        writeAccessLog(deps, {
          endpoint_id: RECEPTION_MANAGE_ENDPOINT_ID,
          accessed_at: lookupNow,
          source_ip_hash: lookupSourceHash,
          action_taken: 'reject',
          outcome: 'rejected',
          url_path_redacted: lookupUrlPathRedacted,
          metadata: { rejection_reason: RECEPTION_IP_BLOCKED_REJECTION_REASON },
        });
        writeJson(res, 403, { error: { code: 'forbidden' } });
        return;
      }
      const lookupRate = deps.getRateLimiter().consumePreVerify({
        source_ip_hash: lookupRateKey,
        endpoint_kind: 'reception_page',
        now: lookupNow,
      });
      if (!lookupRate.ok) {
        writeAccessLog(deps, {
          endpoint_id: RECEPTION_MANAGE_ENDPOINT_ID,
          accessed_at: lookupNow,
          source_ip_hash: lookupSourceHash,
          action_taken: 'rate_limited',
          outcome: 'rate_limited',
          url_path_redacted: lookupUrlPathRedacted,
        });
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((lookupRate.retry_after_at - lookupNow) / 1000),
        );
        res.setHeader('Retry-After', String(retryAfterSeconds));
        writeJson(res, 429, { error: { code: 'rate_limited' } });
        return;
      }
      // ⚠ AWAITED. The handler became async when the viewback recipe landed, and
      // the access-log line below reads `res.statusCode` — which is 0 until the
      // response is written. An unawaited call would log every request as a
      // rejection while serving it correctly, i.e. an Abuse Inbox full of
      // fictional failures.
      await lookupHandler(req, res, lookupSecret);
      writeAccessLog(deps, {
        endpoint_id: RECEPTION_MANAGE_ENDPOINT_ID,
        accessed_at: lookupNow,
        source_ip_hash: lookupSourceHash,
        action_taken: 'view',
        // ⚠ `ok` / `invalid_token`, not a hand-rolled pair — this vocabulary is
        // closed (`ReceptionAccessOutcome`) and the Abuse Inbox groups on it. A
        // 404 here is always an unresolvable credential (expired, revoked, wrong
        // purpose, or never real); the handler deliberately does not tell the
        // VISITOR which, and the log records the class rather than inventing a
        // distinction the handler did not make.
        outcome: res.statusCode === 200 ? 'ok' : 'invalid_token',
        url_path_redacted: lookupUrlPathRedacted,
      });
      return;
    }

    // D-149 P4 § A.5.1 — static-asset subtree. Substrate-bundled
    // closed-list of assets; path-traversal-safe lookup. Served BEFORE
    // the singleton/per-kind path because the static-asset URLs share
    // the `/reception/` prefix + are intentionally token-less.
    if (
      req.method === 'GET' &&
      pathname &&
      pathname.startsWith(RECEPTION_PAGE_STATIC_PATH_PREFIX)
    ) {
      const asset = lookupReceptionStaticAsset(pathname);
      if (!asset) {
        writeJson(res, 404, { error: { code: 'not_found' } });
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', asset.content_type);
      res.setHeader('cache-control', asset.cache_control);
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('content-length', String(asset.bytes.byteLength));
      res.end(asset.bytes);
      return;
    }

    const route = parsePath(pathname);
    if (!route) {
      writeJson(res, 404, { error: { code: 'not_found' } });
      return;
    }

    const now = deps.now();
    const url_path_redacted = redactUrl(rawUrl);
    const ip = clientIp(req, deps.trustForwardedFor === true);

    // D-149 P4 § A.5.1 — singleton reception_page path. No token
    // extract; no HMAC verify; no per-endpoint daily cap (uncapped per
    // RECEPTION_RATE_LIMIT_DEFAULTS). The pre-verify per-IP rate-limit
    // still applies (per_ip_global + per_endpoint_kind:reception_page)
    // so a bot flood at the front door is rejected the same as any
    // other reception path.
    if (!route.endpoint_id) {
      // Pepper still required for IP hashing; locked-vault posture
      // surfaces the same 503 the link-style path emits.
      let singletonPepper: Buffer;
      try {
        singletonPepper = deps.getPepper();
      } catch (err) {
        if (err instanceof RpcError) {
          writeJson(res, err.status ?? 503, { error: { code: err.code } });
          return;
        }
        throw err;
      }
      const singletonRateKey = hashSourceIpServerWide(ip, singletonPepper);
      const singletonSourceHash = hashSourceIpEndpointScoped(
        ip,
        RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
        singletonPepper,
      );
      // D-149 P12 § A.20.5 — IP-block-list check BEFORE the rate-limit
      // consume. A banned `(endpoint_id, source_ip_hash)` pair is
      // rejected (403) without consuming a rate-limit token or touching
      // the registry. The row still lands in the operational log (for
      // forensics) tagged `ip_blocked` so the Abuse Inbox classifier
      // skips re-clustering an already-actioned IP.
      if (isIpBlocked(deps, RECEPTION_PAGE_SINGLETON_ENDPOINT_ID, singletonSourceHash)) {
        writeAccessLog(deps, {
          endpoint_id: RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
          accessed_at: now,
          source_ip_hash: singletonSourceHash,
          action_taken: 'view',
          outcome: 'rejected',
          url_path_redacted,
          metadata: { rejection_reason: RECEPTION_IP_BLOCKED_REJECTION_REASON },
        });
        writeJson(res, 403, { error: { code: 'forbidden' } });
        return;
      }
      const singletonPreVerify = deps.getRateLimiter().consumePreVerify({
        source_ip_hash: singletonRateKey,
        endpoint_kind: 'reception_page',
        now,
      });
      if (!singletonPreVerify.ok) {
        writeAccessLog(deps, {
          endpoint_id: RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
          accessed_at: now,
          source_ip_hash: singletonSourceHash,
          action_taken: 'rate_limited',
          outcome: 'rate_limited',
          url_path_redacted,
        });
        const retry_after_sec = Math.max(
          1,
          Math.ceil((singletonPreVerify.retry_after_at - now) / 1000),
        );
        res.setHeader('Retry-After', String(retry_after_sec));
        writeJson(res, 429, { error: { code: 'rate_limited' } });
        return;
      }
      writeAccessLog(deps, {
        endpoint_id: RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
        accessed_at: now,
        source_ip_hash: singletonSourceHash,
        action_taken: 'view',
        outcome: 'ok',
        url_path_redacted,
      });
      const ctx: ReceptionEndpointContext = {
        endpoint_id: RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
        kind: 'reception_page_packet',
      };
      await receptionPageHandler(req, res, ctx);
      return;
    }
    // Codex P2 #1 fold (D-149 P3 bin.ts wiring) — `getPepper()` throws
    // `RpcError('not_configured', ..., 503)` when the FileVault is
    // locked or uninitialised. Map the typed sentinel to a 503 visitor
    // response (matches the rpc-side `not_configured` wire shape) so
    // locked-vault state is surfaced intentionally instead of falling
    // through to the path-listener-set's generic `internal_error` 500.
    let pepper: Buffer;
    try {
      pepper = deps.getPepper();
    } catch (err) {
      if (err instanceof RpcError) {
        writeJson(res, err.status ?? 503, { error: { code: err.code } });
        return;
      }
      throw err;
    }
    // Codex review P1 #3 fold — rate-limit buckets keyed on the
    // SERVER-WIDE hash (same visitor → same hash across every endpoint),
    // NOT the endpoint-scoped hash. Endpoint-scoped keys would let a
    // bot rotate endpoint IDs (or invent nonexistent IDs) to avoid
    // exhausting the global / per-kind buckets. Access-log writes
    // still use the endpoint-scoped hash to preserve § Must Hold I-9
    // "no cross-endpoint visitor tracking by default."
    const rate_limit_ip_key = hashSourceIpServerWide(ip, pepper);
    const source_ip_hash = hashSourceIpEndpointScoped(ip, route.endpoint_id, pepper);

    // D-149 P12 § A.20.5 — IP-block-list check BEFORE the per-IP
    // rate-limit consume + before the HMAC verify. A banned
    // `(endpoint_id, source_ip_hash)` pair is rejected (403) without
    // consuming a rate-limit token, touching the registry cache, or
    // running the constant-time bearer compare. The row still lands in
    // the operational log tagged `ip_blocked` (forensics) so the Abuse
    // Inbox classifier skips re-clustering an already-actioned IP.
    if (isIpBlocked(deps, route.endpoint_id, source_ip_hash)) {
      writeAccessLog(deps, {
        endpoint_id: route.endpoint_id,
        accessed_at: now,
        source_ip_hash,
        action_taken: 'view',
        outcome: 'rejected',
        url_path_redacted,
        metadata: { rejection_reason: RECEPTION_IP_BLOCKED_REJECTION_REASON },
      });
      writeJson(res, 403, { error: { code: 'forbidden' } });
      return;
    }

    // D-172 step 5a — resumable drop-link upload sub-tree
    // (`/reception/drop/<id>/uploads…`). The DATA plane (chunk / probe /
    // finalize / delete) is gated by the unguessable `upload_id` + the core
    // disk caps, NOT the link-style request limiter: a chunked GiB upload is
    // 60+ requests, which would blow the drop_link 5/hr per-IP + 50/day buckets.
    // So only CREATE runs the per-IP pre-verify, and NO resumable verb consumes
    // the per-endpoint daily cap (the daily cap counts COMPLETED uploads,
    // enforced in the service's create gate against the drop store). The IP
    // block + bearer verify + registry checks below STILL apply to every verb.
    const uploadRoute =
      route.kind === 'drop_link' && route.action === 'uploads' && dropUploadHandler
        ? classifyUploadOp(route.action_rest, req.method)
        : null;
    const isResumableUpload = uploadRoute !== null;
    const isResumableCreate = uploadRoute?.op === 'create';

    // Per Must Hold I-10 — pre-verify rate limit FIRST. Resumable chunk/probe/
    // finalize/delete bypass it (upload_id capability + disk caps); create runs
    // it (the design's "per-IP rate-limit on Creation").
    if (!isResumableUpload || isResumableCreate) {
      const preVerify = deps.getRateLimiter().consumePreVerify({
        source_ip_hash: rate_limit_ip_key,
        endpoint_kind: route.kind,
        now,
      });
      if (!preVerify.ok) {
        writeAccessLog(deps, {
          endpoint_id: route.endpoint_id,
          accessed_at: now,
          source_ip_hash,
          action_taken: 'rate_limited',
          outcome: 'rate_limited',
          url_path_redacted,
        });
        const retry_after_sec = Math.max(1, Math.ceil((preVerify.retry_after_at - now) / 1000));
        res.setHeader('Retry-After', String(retry_after_sec));
        writeJson(res, 429, { error: { code: 'rate_limited' } });
        return;
      }
    }

    // Token presentation (approval_link uses form-field at POST time;
    // P8 wires the form parse. At P3 the approval-link GET surface
    // still rejects token-less requests at the handler skeleton).
    const bearer = extractBearer(req, new URL(rawUrl, 'http://x'));
    if (!bearer) {
      writeAccessLog(deps, {
        endpoint_id: route.endpoint_id,
        accessed_at: now,
        source_ip_hash,
        action_taken: 'invalid_token',
        outcome: 'invalid_token',
        url_path_redacted,
      });
      writeJson(res, 401, { error: { code: 'unauthorized' } });
      return;
    }

    // Registry lookup — cache-first per § Must Hold I-5 60s ceiling.
    const cache = deps.getCache();
    let cached = cache.get(route.endpoint_id, now);
    if (!cached) {
      const row = deps.getStore().loadForVerify(route.endpoint_id, now);
      if (row) {
        cached = {
          summary: {
            endpoint_id: row.endpoint_id,
            kind: row.kind as ReceptionEndpointKind,
            enabled: row.enabled === 1,
            packet_declaration: JSON.parse(row.packet_declaration),
            created_at: row.created_at,
            created_by_client_id: row.created_by_client_id,
            expires_at: row.expires_at,
            long_lived_acknowledged_at: row.long_lived_acknowledged_at,
            revoked_at: row.revoked_at,
            revocation_reason: row.revocation_reason,
            audit_count: row.audit_count,
            last_accessed_at: row.last_accessed_at,
            metadata: row.metadata_blob ? JSON.parse(row.metadata_blob) : {},
          },
          bearer_secret_hmac: row.bearer_secret_hmac,
          inserted_at: now,
        };
        cache.put({
          endpoint_id: route.endpoint_id,
          summary: cached.summary,
          bearer_secret_hmac: cached.bearer_secret_hmac,
          now,
        });
      }
    }

    if (!cached) {
      writeAccessLog(deps, {
        endpoint_id: route.endpoint_id,
        accessed_at: now,
        source_ip_hash,
        action_taken: 'invalid_token',
        outcome: 'invalid_token',
        url_path_redacted,
      });
      writeJson(res, 401, { error: { code: 'unauthorized' } });
      return;
    }

    if (cached.summary.revoked_at !== null) {
      writeAccessLog(deps, {
        endpoint_id: route.endpoint_id,
        accessed_at: now,
        source_ip_hash,
        action_taken: 'revoked',
        outcome: 'revoked',
        url_path_redacted,
      });
      writeJson(res, 410, { error: { code: 'gone' } });
      return;
    }
    if (cached.summary.expires_at !== null && cached.summary.expires_at <= now) {
      writeAccessLog(deps, {
        endpoint_id: route.endpoint_id,
        accessed_at: now,
        source_ip_hash,
        action_taken: 'expired',
        outcome: 'expired',
        url_path_redacted,
      });
      writeJson(res, 410, { error: { code: 'gone' } });
      return;
    }
    if (!cached.summary.enabled) {
      writeAccessLog(deps, {
        endpoint_id: route.endpoint_id,
        accessed_at: now,
        source_ip_hash,
        action_taken: 'invalid_token',
        outcome: 'invalid_token',
        url_path_redacted,
      });
      writeJson(res, 401, { error: { code: 'unauthorized' } });
      return;
    }
    if (cached.summary.kind !== route.kind) {
      // Cross-endpoint token reuse — token presented to wrong kind's
      // URL fails per § A.18 isolation. Generic 401 (no kind leak).
      writeAccessLog(deps, {
        endpoint_id: route.endpoint_id,
        accessed_at: now,
        source_ip_hash,
        action_taken: 'invalid_token',
        outcome: 'invalid_token',
        url_path_redacted,
      });
      writeJson(res, 401, { error: { code: 'unauthorized' } });
      return;
    }

    const verified = verifyBearerSecret({
      submitted_secret: bearer,
      stored_hmac: cached.bearer_secret_hmac,
      pepper,
    });
    if (!verified) {
      writeAccessLog(deps, {
        endpoint_id: route.endpoint_id,
        accessed_at: now,
        source_ip_hash,
        action_taken: 'invalid_token',
        outcome: 'invalid_token',
        url_path_redacted,
      });
      writeJson(res, 401, { error: { code: 'unauthorized' } });
      return;
    }

    // Post-verify daily-cap (endpoint_id now known). Resumable verbs bypass it
    // — the daily cap counts COMPLETED uploads (the service's create gate
    // enforces it against the drop store), so a 60-chunk upload doesn't burn
    // 60 of the 50/day budget. The single-POST + every other kind still consume.
    if (!isResumableUpload) {
      const postVerify = deps.getRateLimiter().consumePostVerify({
        endpoint_id: route.endpoint_id,
        endpoint_kind: route.kind,
        now,
      });
      if (!postVerify.ok) {
        writeAccessLog(deps, {
          endpoint_id: route.endpoint_id,
          accessed_at: now,
          source_ip_hash,
          action_taken: 'rate_limited',
          outcome: 'capacity_full',
          url_path_redacted,
        });
        const retry_after_sec = Math.max(1, Math.ceil((postVerify.retry_after_at - now) / 1000));
        res.setHeader('Retry-After', String(retry_after_sec));
        writeJson(res, 429, { error: { code: 'capacity_full' } });
        return;
      }
    }

    // Write the access-log row + dispatch to per-kind handler. The
    // per-kind handler is responsible for any further auditing (e.g.,
    // approval-link consumption emits a separate D-120 signed row).
    const action_taken: ReceptionAccessAction =
      req.method === 'GET'
        ? 'view'
        : route.kind === 'drop_link'
          ? 'upload'
          : route.kind === 'approval_link'
            ? 'approve'
            : 'submit';
    // For resumable uploads, log only the control plane (create / finalize /
    // delete) — the high-frequency chunk + probe data plane would otherwise
    // write N rows per upload (and a probe's `?filename=` could leak into the
    // redacted URL). The persisted `reception_drop_blob_metadata` row is the
    // real per-upload record.
    const logThisRequest =
      !isResumableUpload ||
      uploadRoute?.op === 'create' ||
      uploadRoute?.op === 'finalize' ||
      uploadRoute?.op === 'delete';
    if (logThisRequest) {
      writeAccessLog(deps, {
        endpoint_id: route.endpoint_id,
        accessed_at: now,
        source_ip_hash,
        action_taken,
        outcome: 'ok',
        url_path_redacted,
      });
    }

    // WatchSource reception push source — a verified, correctly-SHAPED
    // mutation arrival emits onto the warehouse bus (see
    // ReceptionPortHandlerDeps doc). Called from each kind's valid
    // mutation branch BEFORE the live/stub fork — a 404/405 shape never
    // rings the doorbell (codex MEDIUM fold), while a 503-degraded
    // substrate still does (governance sees requests arriving while the
    // drain is down; the visitor's 503 is retriable).
    const emitVerifiedMutationArrival = (): void => {
      if (!deps.warehouseBus || action_taken === 'view') return;
      try {
        deps.warehouseBus.emit({
          platform: RECEPTION_EVENT_PLATFORM,
          slug: route.kind,
          entity_type: 'request',
          event_kind: 'created',
          record_id: randomUUID(),
          at: now,
          record: { endpoint_id: route.endpoint_id, kind: route.kind, action: action_taken },
        });
        deps.markSourceEvent?.(receptionSourceKey(route.kind), now);
      } catch {
        // A bus-subscriber throw must never fail a visitor request —
        // same best-effort posture as the access log.
      }
    };

    const ctx: ReceptionEndpointContext = {
      endpoint_id: route.endpoint_id,
      kind: ENDPOINT_KIND_TO_PACKET_KIND[route.kind],
      ...(cached.summary.expires_at !== null ? { expires_at: cached.summary.expires_at } : {}),
    };

    // D-149 P5 § A.5.2 — scheduling_link gets a per-action dispatch.
    // GET → slot-picker render; POST `/book` → booking submission.
    // Other actions on `/reception/scheduling/<id>/<verb>` fall through
    // to a 404 since the substrate ships only the single `book` verb
    // at P5. When deps aren't yet wired we fall back to the kind-
    // registry 503 stub so the substrate stays observably degraded
    // rather than partially-live.
    if (route.kind === 'scheduling_link') {
      if (req.method === 'POST' && route.action === 'book') {
        emitVerifiedMutationArrival();
        if (schedulingBookHandler) {
          await schedulingBookHandler(req, res, ctx);
        } else {
          writeJson(res, 503, { error: { code: 'not_configured' } });
        }
        return;
      }
      if (req.method === 'GET' && route.action === null) {
        if (schedulingGetHandler) {
          await schedulingGetHandler(req, res, ctx);
        } else {
          const stubHandler = RECEPTION_KIND_HANDLERS[ENDPOINT_KIND_TO_PACKET_KIND[route.kind]];
          await stubHandler(req, res, ctx);
        }
        return;
      }
      // Any other method / action combo on the scheduling kind is a 404.
      writeJson(res, 404, { error: { code: 'not_found' } });
      return;
    }

    // D-149 P6 § A.5.3 — intake_form gets per-method dispatch. GET →
    // form render; POST → submission. No verb segment — both flow
    // through `/reception/intake/<endpoint_id>` (POST writes back to
    // the same URL; the rendered form's action attribute matches).
    // When deps aren't yet wired we fall back to the kind-registry
    // 503 stub.
    if (route.kind === 'intake_form') {
      // The intake_form URL space takes no per-action verb; any
      // additional path segment beyond endpoint_id is a 404.
      if (route.action !== null) {
        writeJson(res, 404, { error: { code: 'not_found' } });
        return;
      }
      if (req.method === 'GET') {
        if (intakeFormGetHandler) {
          await intakeFormGetHandler(req, res, ctx);
        } else {
          const stubHandler = RECEPTION_KIND_HANDLERS[ENDPOINT_KIND_TO_PACKET_KIND[route.kind]];
          await stubHandler(req, res, ctx);
        }
        return;
      }
      if (req.method === 'POST') {
        emitVerifiedMutationArrival();
        if (intakeFormSubmitHandler) {
          // Carry the endpoint-scoped HMAC projection already computed for the
          // access log. The form handler needs the same privacy-preserving value
          // to enforce its advertised per-IP cap; never pass the raw address.
          await intakeFormSubmitHandler(req, res, ctx, source_ip_hash);
        } else {
          writeJson(res, 503, { error: { code: 'not_configured' } });
        }
        return;
      }
      // Any other method on the intake kind is a 405.
      res.setHeader('allow', 'GET, POST');
      writeJson(res, 405, { error: { code: 'method_not_allowed' } });
      return;
    }

    // D-149 P7 § A.5.4 — drop_link gets per-method dispatch. GET →
    // upload-form render; POST → multipart upload. No verb segment —
    // both flow through `/reception/drop/<endpoint_id>` (POST writes
    // back to the same URL; the rendered form's action attribute
    // matches). When deps aren't yet wired we fall back to the kind-
    // registry 503 stub.
    if (route.kind === 'drop_link') {
      // D-172 step 5a — resumable upload sub-tree
      // (`/reception/drop/<id>/uploads…`). Intercepted before the single-POST
      // 404 below. `uploadRoute` is non-null only when the upload service is
      // wired AND the method/sub-shape is a recognized verb; the arrival
      // doorbell is handed to the handler (fired once, on a clean finalize).
      if (uploadRoute && dropUploadHandler) {
        await dropUploadHandler(req, res, {
          endpoint: ctx,
          op: uploadRoute.op,
          upload_id: uploadRoute.upload_id,
          source_ip_hash,
          emitArrival: emitVerifiedMutationArrival,
        });
        return;
      }
      // The drop_link URL space takes no per-action verb; any
      // additional path segment beyond endpoint_id is a 404.
      if (route.action !== null) {
        writeJson(res, 404, { error: { code: 'not_found' } });
        return;
      }
      if (req.method === 'GET') {
        if (dropLinkGetHandler) {
          await dropLinkGetHandler(req, res, ctx);
        } else {
          const stubHandler = RECEPTION_KIND_HANDLERS[ENDPOINT_KIND_TO_PACKET_KIND[route.kind]];
          await stubHandler(req, res, ctx);
        }
        return;
      }
      if (req.method === 'POST') {
        emitVerifiedMutationArrival();
        if (dropLinkUploadHandler) {
          await dropLinkUploadHandler(req, res, ctx);
        } else {
          writeJson(res, 503, { error: { code: 'not_configured' } });
        }
        return;
      }
      // Any other method on the drop_link kind is a 405.
      res.setHeader('allow', 'GET, POST');
      writeJson(res, 405, { error: { code: 'method_not_allowed' } });
      return;
    }

    // D-149 P8 § A.5.5 — approval_link gets per-method dispatch. GET
    // → consent form render; POST → single-use consume. No verb
    // segment — both flow through `/reception/approve/<endpoint_id>`.
    // When deps aren't yet wired we fall back to the kind-registry
    // 503 stub.
    if (route.kind === 'approval_link') {
      if (route.action !== null) {
        writeJson(res, 404, { error: { code: 'not_found' } });
        return;
      }
      if (req.method === 'GET') {
        if (approvalLinkGetHandler) {
          await approvalLinkGetHandler(req, res, ctx);
        } else {
          const stubHandler = RECEPTION_KIND_HANDLERS[ENDPOINT_KIND_TO_PACKET_KIND[route.kind]];
          await stubHandler(req, res, ctx);
        }
        return;
      }
      if (req.method === 'POST') {
        emitVerifiedMutationArrival();
        if (approvalLinkConsumeHandler) {
          await approvalLinkConsumeHandler(req, res, ctx);
        } else {
          writeJson(res, 503, { error: { code: 'not_configured' } });
        }
        return;
      }
      res.setHeader('allow', 'GET, POST');
      writeJson(res, 405, { error: { code: 'method_not_allowed' } });
      return;
    }

    // D-149 P9 § A.5.6 — status_link is GET-only (read-only entity
    // projection). No verb segment; no POST. Anything other than GET
    // returns 405. When deps aren't yet wired we fall back to the
    // kind-registry 503 stub.
    if (route.kind === 'status_link') {
      if (route.action !== null) {
        writeJson(res, 404, { error: { code: 'not_found' } });
        return;
      }
      if (req.method === 'GET') {
        if (statusLinkGetHandler) {
          await statusLinkGetHandler(req, res, ctx);
        } else {
          const stubHandler = RECEPTION_KIND_HANDLERS[ENDPOINT_KIND_TO_PACKET_KIND[route.kind]];
          await stubHandler(req, res, ctx);
        }
        return;
      }
      res.setHeader('allow', 'GET');
      writeJson(res, 405, { error: { code: 'method_not_allowed' } });
      return;
    }

    const handler = RECEPTION_KIND_HANDLERS[ENDPOINT_KIND_TO_PACKET_KIND[route.kind]];
    await handler(req, res, ctx);
  };
};

// Suppress unused-symbol warning during incremental wiring (the HMAC
// helper is currently re-exported for tests through this barrel but the
// dispatch path doesn't otherwise consume it). Once P4-P9 wire the
// per-kind handlers we drop this guard.
void computeBearerHmac;
