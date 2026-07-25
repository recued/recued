/** D-149 P8 § A.5.5 — `approval_link` packet handlers (GET + POST).
 *
 *  The pre-handler dispatcher in `handler.ts` already verified the
 *  bearer token, the per-IP rate limit, the post-verify daily cap, and
 *  that the cached registry row is enabled + non-revoked + non-expired.
 *  By the time these handlers run the request is authorized — the
 *  remaining work is:
 *
 *    GET (consent form):
 *      1. Parse the stored `ApprovalLinkConfig` blob.
 *      2. Load the associated `reception_approval_intent` row via
 *         `findByEndpoint(endpoint_id)`. When the intent has already
 *         been consumed render the already-consumed page (200 OK with
 *         distinct copy; visitors who revisit a consumed link see the
 *         status rather than a "broken page").
 *      3. Build the redacted packet (strict-pick + reshape — the
 *         substrate strips counterparty_aliases + private_notes at
 *         the boundary).
 *      4. Issue a per-render form-nonce (single-use; bound to endpoint).
 *      5. Render the approval form HTML.
 *
 *    POST (consume):
 *      1. Parse `application/x-www-form-urlencoded` body — fixed
 *         closed shape: `form_nonce` + visitor_name + visitor_email +
 *         per-action-kind fields (option_id / decision / comment /
 *         answer).
 *      2. Single-use form-nonce consume (CSRF guard).
 *      3. Origin / Referer same-origin verify (CSRF guard).
 *      4. Build the `ApprovalLinkConsumedOutcome` from the parsed
 *         fields per the config's `action_kind`.
 *      5. Run the consume validator (per-action-kind + email-match
 *         constraint + length bounds).
 *      6. Seal the PII fields (visitor_email + visitor_name + outcome
 *         string).
 *      7. Call `ApprovalIntentStore.tryConsume` — EXCLUSIVE transaction
 *         flips `consumed_at` atomically; concurrent presentations
 *         race-resolve (only one wins, others see `already_consumed`).
 *      8. Emit signed `approval_intent.consumed` audit row.
 *      9. Return the success page.
 *
 *  Single-use enforcement (Must Hold I-11):
 *    First valid presentation flips `consumed_at`. Subsequent
 *    presentations return the already-consumed page (200) — distinct
 *    from the 410-Gone the dispatcher would emit for an expired /
 *    revoked endpoint. The substrate emits a signed audit row marked
 *    `outcome: 'consumed_already'` so abuse-inbox can see the attempt.
 *
 *  Visitor writes are async per § Must Hold I-12 — the substrate
 *  persists the consumed row + returns success; engine-side reactive
 *  trigger fires the downstream effect (resolve proposal / create
 *  commitment / fire recipe) off-thread.
 *
 *  Spec: D-149 § A.5.5 + § Must Hold I-11 + I-12 + § N.6. */

import { randomBytes } from 'node:crypto';
import { verifyReceptionSameOrigin } from './same-origin.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createBoundedNonceStore } from '../../../bounded-nonce-store.js';
import {
  APPROVAL_LINK_DEFAULT_SUBMIT_BUTTON_LABEL,
  APPROVAL_LINK_DEFAULT_SUCCESS_MESSAGE,
  APPROVAL_LINK_VISITOR_ANSWER_MAX,
  APPROVAL_LINK_VISITOR_COMMENT_MAX,
  APPROVAL_LINK_VISITOR_EMAIL_MAX,
  APPROVAL_LINK_VISITOR_NAME_MAX,
  formatApprovalLinkConsumedOutcome,
  validateApprovalLinkConsume,
  type ApprovalLinkConfig,
  type ApprovalLinkConsumeInput,
  type ApprovalLinkConsumedOutcome,
  type RedactedPacketBuildAuditEvent,
  type TrustFooterDeploymentMode,
  type VisitorReceiptFieldEcho,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import { buildReceptionPacket } from '../redacted-packet.js';
import { resolveReceptionTrustFooter } from './trust-footer.js';
import { resolveVisitorReceipt } from './visitor-receipt.js';
import {
  buildApprovalLinkPacketRawInput,
  buildApprovalLinkSourceView,
  parseApprovalLinkConfig,
} from '../transformations/approval-link.js';
import { sealApprovalIntentPiiField } from '../approval-pii.js';
import {
  renderApprovalLinkAlreadyConsumedHtml,
  renderApprovalLinkErrorHtml,
  renderApprovalLinkHtml,
  renderApprovalLinkPlaceholderHtml,
  renderApprovalLinkSuccessHtml,
  type ApprovalLinkRenderInput,
} from './approval-link-render.js';
import type { ReceptionEndpointContext } from '../redacted-packet.js';
import type { ReceptionKindHandler } from './types.js';
import type { PublicEndpointRegistryStore } from '../../../storage/public-endpoint-registry-store.js';
import type { ApprovalIntentStore } from '../../../storage/reception-approval-store.js';

const NOT_IMPLEMENTED_BODY = { error: { code: 'not_implemented' } } as const;

/** Max POST body bytes. Approval forms are small (radio + textarea +
 *  email + name). 16 KB is a comfortable ceiling. */
const MAX_BODY_BYTES = 16 * 1024;

/** Form-nonce TTL — visitors have 30 minutes to submit after loading.
 *  Mirrors the intake_form / drop_link nonce. */
export const APPROVAL_LINK_NONCE_TTL_MS = 30 * 60 * 1000;


// ────────────────────────────────────────────────────────────────
// Form-nonce store (in-memory, per-process)
// ────────────────────────────────────────────────────────────────

export interface ApprovalLinkNonceStore {
  issue(endpoint_id: string, now: number): string;
  consume(endpoint_id: string, nonce: string, now: number): boolean;
}

/** ⚠ NO `maxPerScope`: the scope is `endpoint_id`, shared by every concurrent
 *  visitor to this door. A per-scope cap would let the Nth visitor evict the
 *  first visitor's nonce. See `bounded-nonce-store.ts`. */
export const createInMemoryApprovalLinkNonceStore = (): ApprovalLinkNonceStore => {
  const store = createBoundedNonceStore<null>({ ttlMs: APPROVAL_LINK_NONCE_TTL_MS });
  return {
    issue: (endpoint_id, now) => store.issue(endpoint_id, now, null),
    consume: (endpoint_id, nonce, now) =>
      store.consume(endpoint_id, nonce, now) !== null,
  };
};

// ────────────────────────────────────────────────────────────────
// Response helpers
// ────────────────────────────────────────────────────────────────

const writeHtmlResponse = (res: ServerResponse, body: string, status = 200): void => {
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('content-length', String(Buffer.byteLength(body, 'utf8')));
  res.end(body);
};

const writeErrorPage = (
  res: ServerResponse,
  display_name: string,
  message: string,
  status: number,
): void => {
  writeHtmlResponse(res, renderApprovalLinkErrorHtml({ display_name, message }), status);
};

// ────────────────────────────────────────────────────────────────
// Bearer extract
// ────────────────────────────────────────────────────────────────

const extractBearer = (req: IncomingMessage): string => {
  const url = new URL(req.url ?? '/', 'http://x');
  const q = url.searchParams.get('t');
  if (q && q.length > 0) return q;
  const headerToken = req.headers['x-recued-endpoint-token'];
  if (typeof headerToken === 'string' && headerToken.length > 0) return headerToken;
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  return '';
};

// ────────────────────────────────────────────────────────────────
// Origin / Referer verification (CSRF guard)
// ────────────────────────────────────────────────────────────────

const verifyOrigin = verifyReceptionSameOrigin;

// ────────────────────────────────────────────────────────────────
// Body parsing
// ────────────────────────────────────────────────────────────────

const readBody = async (req: IncomingMessage): Promise<string> => {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        aborted = true;
        reject(new Error('body_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => reject(err));
  });
};

/** Closed-list of form keys the approval handler accepts. Any other key
 *  triggers a 400. Mirrors the other reception kinds' defense-in-depth
 *  pattern. */
const ALLOWED_FORM_KEYS = new Set<string>([
  't',
  'form_nonce',
  'visitor_name',
  'visitor_email',
  // per-action-kind keys
  'option_id',         // pick_time
  'answer',            // confirm_attendance + answer_question + upload_doc
  'decision',          // approve_wording
  'comment',           // approve_wording (when decision='reject')
]);

const parseFormBody = (
  raw: string,
): Map<string, string> | { error: 'unknown_field' | 'malformed' } => {
  const out = new Map<string, string>();
  const params = new URLSearchParams(raw);
  for (const [key] of params) {
    if (!ALLOWED_FORM_KEYS.has(key)) {
      return { error: 'unknown_field' };
    }
  }
  for (const key of ALLOWED_FORM_KEYS) {
    const v = params.get(key);
    if (v !== null) out.set(key, v);
  }
  return out;
};

// ────────────────────────────────────────────────────────────────
// Per-action-kind outcome shape build
// ────────────────────────────────────────────────────────────────

const buildOutcome = (
  config: ApprovalLinkConfig,
  body: Map<string, string>,
): ApprovalLinkConsumedOutcome | { error: 'malformed' } => {
  switch (config.action_kind) {
    case 'pick_time': {
      const option_id = body.get('option_id') ?? '';
      if (option_id.length === 0) return { error: 'malformed' };
      return { kind: 'pick', option_id };
    }
    case 'confirm_attendance': {
      const answer = body.get('answer') ?? '';
      if (answer !== 'yes' && answer !== 'no') return { error: 'malformed' };
      return { kind: 'confirm', answer };
    }
    case 'approve_wording': {
      const decision = body.get('decision') ?? '';
      if (decision === 'approve') return { kind: 'approve' };
      if (decision === 'reject') {
        const rawComment = body.get('comment');
        if (rawComment !== undefined && rawComment.length > 0) {
          return { kind: 'reject', comment: rawComment };
        }
        return { kind: 'reject' };
      }
      return { error: 'malformed' };
    }
    case 'answer_question':
    case 'upload_doc': {
      const answer = body.get('answer') ?? '';
      if (answer.length === 0) return { error: 'malformed' };
      return { kind: 'answer', answer };
    }
  }
};

/** D-149 § A.20.3 — human-readable echo of the consumed outcome for the
 *  Visitor Receipt's "Response" field. `pick` resolves the option id
 *  back to its label via the config's `options` list (falls back to the
 *  raw id when the option is gone); the other kinds map to plain copy.
 *  Pure function. */
const describeApprovalOutcome = (
  outcome: ApprovalLinkConsumedOutcome,
  config: ApprovalLinkConfig,
): string => {
  switch (outcome.kind) {
    case 'pick': {
      const opt = config.options?.find((o) => o.id === outcome.option_id);
      return opt ? opt.label : outcome.option_id;
    }
    case 'approve':
      return 'Approved';
    case 'reject':
      return outcome.comment !== undefined && outcome.comment.length > 0
        ? `Changes suggested: ${outcome.comment}`
        : 'Changes suggested';
    case 'confirm':
      return outcome.answer === 'yes' ? 'Yes' : 'No';
    case 'answer':
      return outcome.answer;
  }
};

// ────────────────────────────────────────────────────────────────
// GET handler
// ────────────────────────────────────────────────────────────────

export interface ApprovalLinkPacketHandlerDeps {
  readonly getStore: () => PublicEndpointRegistryStore;
  readonly getApprovalIntentStore: () => ApprovalIntentStore;
  readonly getApprovalLinkNonceStore: () => ApprovalLinkNonceStore;
  readonly now: () => number;
  readonly emitAudit?: (event: RedactedPacketBuildAuditEvent) => string | undefined;
  /** D-149 P12 § A.20.7 — deployment mode for the Public Trust Footer.
   *  Boot-constant derived in `bin.ts` from the public base URL host
   *  (`isProDdnsHost`). Absent ⇒ the handler renders no trust footer. */
  readonly receptionDeploymentMode?: TrustFooterDeploymentMode;
}

export const createApprovalLinkPacketHandler = (
  deps: ApprovalLinkPacketHandlerDeps,
): ReceptionKindHandler => {
  return async (req: IncomingMessage, res: ServerResponse, endpoint: ReceptionEndpointContext) => {
    const endpoint_id = endpoint.endpoint_id;
    if (!endpoint_id) {
      writeHtmlResponse(res, renderApprovalLinkPlaceholderHtml(), 503);
      return;
    }

    const row = deps.getStore().findById(endpoint_id);
    if (!row) {
      writeHtmlResponse(res, renderApprovalLinkPlaceholderHtml(), 503);
      return;
    }
    const config = parseApprovalLinkConfig(row.metadata);
    if (!config) {
      writeHtmlResponse(res, renderApprovalLinkPlaceholderHtml(), 503);
      return;
    }

    const intent = deps.getApprovalIntentStore().findByEndpoint(endpoint_id);
    if (!intent) {
      // The substrate-side endpoint create flow seeds the intent row;
      // a missing row means a substrate-internal error rather than a
      // visitor-fixable state. Surface as the placeholder.
      writeHtmlResponse(res, renderApprovalLinkPlaceholderHtml(), 503);
      return;
    }
    if (intent.consumed_at !== null) {
      writeHtmlResponse(
        res,
        renderApprovalLinkAlreadyConsumedHtml({ display_name: config.display_name }),
        200,
      );
      return;
    }

    const now = deps.now();
    const expires_at = endpoint.expires_at ?? row.expires_at ?? null;
    const source = buildApprovalLinkSourceView(config, expires_at, now);
    const rawInput = buildApprovalLinkPacketRawInput(source);
    const opts: Parameters<typeof buildReceptionPacket>[3] = {
      now,
      randomToken: () => randomBytes(16).toString('hex'),
      ...(deps.emitAudit !== undefined ? { emitAudit: deps.emitAudit } : {}),
    };
    // Defense in depth — substrate strict-picks at packet build.
    buildReceptionPacket('approval_link_packet', rawInput, endpoint, opts);

    const nonce = deps.getApprovalLinkNonceStore().issue(endpoint_id, now);
    const bearer = extractBearer(req);

    // D-149 P12 § A.20.7 — resolve the Public Trust Footer (reads the
    // per-server toggle off the reception_page singleton).
    const trust_footer =
      deps.receptionDeploymentMode !== undefined
        ? resolveReceptionTrustFooter({
            store: deps.getStore(),
            deployment_mode: deps.receptionDeploymentMode,
          })
        : null;

    const renderInput: ApprovalLinkRenderInput = {
      display_name: config.display_name,
      action_kind: config.action_kind,
      prompt: config.prompt,
      context_summary: config.context_raw.summary,
      visitor_field_constraints: config.visitor_field_constraints,
      expiry_display: source.expiry_display,
      submit_button_label:
        config.submit_button_label ?? APPROVAL_LINK_DEFAULT_SUBMIT_BUTTON_LABEL,
      endpoint_id,
      bearer_secret: bearer,
      form_nonce: nonce,
      trust_footer,
      ...(config.options !== undefined ? { options: config.options } : {}),
    };

    writeHtmlResponse(res, renderApprovalLinkHtml(renderInput));
  };
};

// ────────────────────────────────────────────────────────────────
// POST consume handler
// ────────────────────────────────────────────────────────────────

export interface ApprovalLinkConsumeHandlerDeps {
  readonly getStore: () => PublicEndpointRegistryStore;
  readonly getApprovalIntentStore: () => ApprovalIntentStore;
  readonly getApprovalLinkNonceStore: () => ApprovalLinkNonceStore;
  readonly getApprovalIntentPiiKey: () => Uint8Array;
  readonly auditLog: AuditLogStore;
  readonly now: () => number;
  /** D-149 § A.20.3 / § A.20.7 — deployment mode for the Public Trust
   *  Footer carried in the Visitor Receipt's `privacy_footer` slot.
   *  Absent ⇒ the receipt renders without a privacy footer. */
  readonly receptionDeploymentMode?: TrustFooterDeploymentMode;
}

export const createApprovalLinkConsumeHandler = (
  deps: ApprovalLinkConsumeHandlerDeps,
): ((req: IncomingMessage, res: ServerResponse, endpoint: ReceptionEndpointContext) => Promise<void>) => {
  return async (req, res, endpoint) => {
    const endpoint_id = endpoint.endpoint_id;
    if (!endpoint_id) {
      writeErrorPage(res, 'this approval link', 'Submission unavailable.', 503);
      return;
    }
    if (req.method !== 'POST') {
      writeErrorPage(res, 'this approval link', 'Method not allowed.', 405);
      return;
    }

    let bodyRaw: string;
    try {
      bodyRaw = await readBody(req);
    } catch (err) {
      const message =
        err instanceof Error && err.message === 'body_too_large'
          ? 'Submission was too large.'
          : 'Submission could not be parsed.';
      writeErrorPage(res, 'this approval link', message, 413);
      return;
    }

    if (!verifyOrigin(req)) {
      writeErrorPage(res, 'this approval link', 'Submission blocked by origin policy.', 403);
      return;
    }

    const row = deps.getStore().findById(endpoint_id);
    if (!row) {
      writeErrorPage(res, 'this approval link', 'Submission unavailable.', 503);
      return;
    }
    const config = parseApprovalLinkConfig(row.metadata);
    if (!config) {
      writeErrorPage(res, 'this approval link', 'Submission unavailable.', 503);
      return;
    }

    const display_name = config.display_name;

    const parsed = parseFormBody(bodyRaw);
    if ('error' in parsed) {
      const msg =
        parsed.error === 'unknown_field'
          ? 'Submission contained an unknown field.'
          : 'Submission could not be parsed.';
      writeErrorPage(res, display_name, msg, 400);
      return;
    }

    const formNonce = parsed.get('form_nonce') ?? '';
    if (
      formNonce.length === 0 ||
      !deps.getApprovalLinkNonceStore().consume(endpoint_id, formNonce, deps.now())
    ) {
      writeErrorPage(
        res,
        display_name,
        'This approval link is stale. Please reload the page and try again.',
        400,
      );
      return;
    }

    // Build the outcome shape from the parsed body per the config's
    // action_kind. Malformed inputs short-circuit to 400.
    const built = buildOutcome(config, parsed);
    if ('error' in built) {
      writeErrorPage(res, display_name, 'Submission was incomplete.', 400);
      return;
    }

    const visitorName = parsed.get('visitor_name') ?? '';
    const visitorEmail = parsed.get('visitor_email') ?? '';

    // Cap each input at the substrate ceiling BEFORE handing to the
    // validator so a megabyte body in a single field doesn't bypass
    // the body-size cap (the body-size cap protects against gross
    // abuse; per-field caps protect against silent persistence of
    // oversize PII).
    if (visitorName.length > APPROVAL_LINK_VISITOR_NAME_MAX) {
      writeErrorPage(res, display_name, 'Submission metadata too long.', 400);
      return;
    }
    if (visitorEmail.length > APPROVAL_LINK_VISITOR_EMAIL_MAX) {
      writeErrorPage(res, display_name, 'Submission metadata too long.', 400);
      return;
    }
    if (built.kind === 'answer' && built.answer.length > APPROVAL_LINK_VISITOR_ANSWER_MAX) {
      writeErrorPage(res, display_name, 'Answer too long.', 400);
      return;
    }
    if (
      built.kind === 'reject' &&
      built.comment !== undefined &&
      built.comment.length > APPROVAL_LINK_VISITOR_COMMENT_MAX
    ) {
      writeErrorPage(res, display_name, 'Comment too long.', 400);
      return;
    }

    const consumeInput: ApprovalLinkConsumeInput = {
      ...(visitorName.length > 0 ? { visitor_name: visitorName } : {}),
      ...(visitorEmail.length > 0 ? { visitor_email: visitorEmail } : {}),
      outcome: built,
    };
    const failures = validateApprovalLinkConsume(consumeInput, config);
    if (failures.length > 0) {
      const first = failures[0]!;
      writeErrorPage(res, display_name, first.detail, 400);
      return;
    }

    // Find the intent row for this endpoint. Substrate seeds the row
    // at endpoint create; a missing row is a substrate-internal error.
    const intent = deps.getApprovalIntentStore().findByEndpoint(endpoint_id);
    if (!intent) {
      writeErrorPage(res, display_name, 'Submission unavailable.', 503);
      return;
    }
    // Defense in depth — if a concurrent presentation already consumed
    // the intent the EXCLUSIVE flip below will surface
    // 'already_consumed' regardless of this read. Skip the optimistic
    // success page when we already see consumed_at.
    if (intent.consumed_at !== null) {
      writeHtmlResponse(
        res,
        renderApprovalLinkAlreadyConsumedHtml({ display_name }),
        200,
      );
      return;
    }

    // Encrypt PII fields.
    const key = deps.getApprovalIntentPiiKey();
    const outcomeWire = formatApprovalLinkConsumedOutcome(built);
    const [visitor_email_encrypted, visitor_name_encrypted, outcome_encrypted] =
      await Promise.all([
        sealApprovalIntentPiiField({
          key,
          endpoint_id,
          intent_id: intent.intent_id,
          field: 'visitor_email',
          plaintext: visitorEmail.length > 0 ? visitorEmail : null,
        }),
        sealApprovalIntentPiiField({
          key,
          endpoint_id,
          intent_id: intent.intent_id,
          field: 'visitor_name',
          plaintext: visitorName.length > 0 ? visitorName : null,
        }),
        sealApprovalIntentPiiField({
          key,
          endpoint_id,
          intent_id: intent.intent_id,
          field: 'outcome',
          plaintext: outcomeWire,
        }),
      ]);

    if (outcome_encrypted === null) {
      // Should never happen — outcomeWire is always non-empty. Defense
      // in depth surfaces as 503 rather than silently persisting an
      // empty row.
      writeErrorPage(res, display_name, 'Submission unavailable.', 503);
      return;
    }

    // Atomic single-use flip per Must Hold I-11.
    const now = deps.now();
    const result = deps.getApprovalIntentStore().tryConsume({
      intent_id: intent.intent_id,
      endpoint_id,
      now,
      source_ip_hash: null, // dispatcher already wrote the per-IP hash
      visitor_email_encrypted,
      visitor_name_encrypted,
      outcome_encrypted,
      metadata_patch: {
        outcome_kind: built.kind,
        action_kind: config.action_kind,
      },
    });

    if (!result.ok) {
      if (result.reason === 'already_consumed') {
        // Concurrent-race loser. Visitor sees the already-consumed
        // page with the same copy as the GET-side handler emits on a
        // returning visitor. Audit row marks the attempt as
        // 'consumed_already'.
        try {
          await deps.auditLog.logActivity({
            activity_id: `approval_intent.consume_attempt-${now}-${intent.intent_id}`,
            timestamp: now,
            action: 'approval_intent.consumed',
            target: endpoint_id,
            detail: JSON.stringify({
              intent_id: intent.intent_id,
              action_kind: config.action_kind,
              outcome: 'consumed_already',
            }),
            reserve: true,
          });
        } catch {
          /* audit failure must not block the response */
        }
        writeHtmlResponse(
          res,
          renderApprovalLinkAlreadyConsumedHtml({ display_name }),
          200,
        );
        return;
      }
      // not_found — substrate-internal error.
      writeErrorPage(res, display_name, 'Submission unavailable.', 503);
      return;
    }

    // Signed `approval_intent.consumed` audit row per § N.3 (one per
    // consumption). Failure must not block the success page — row is
    // already persisted via tryConsume.
    try {
      await deps.auditLog.logActivity({
        activity_id: `approval_intent.consumed-${now}-${intent.intent_id}`,
        timestamp: now,
        action: 'approval_intent.consumed',
        target: endpoint_id,
        detail: JSON.stringify({
          intent_id: intent.intent_id,
          action_kind: config.action_kind,
          outcome_kind: built.kind,
        }),
        reserve: true,
      });
    } catch {
      /* audit failure must not block the success page */
    }

    const successMessage = config.success_message ?? APPROVAL_LINK_DEFAULT_SUCCESS_MESSAGE;

    // D-149 § A.20.3 — Visitor Receipt. Echoes the visitor's
    // self-identification fields (verbatim) + a human-readable form of
    // the consumed outcome; `null` when the endpoint's `visitor_receipt`
    // config is absent / disabled. Reached only on a genuine consume
    // (the single-use flip won the race).
    const fieldsEcho: VisitorReceiptFieldEcho[] = [];
    if (visitorName.length > 0) fieldsEcho.push({ label: 'Name', value: visitorName });
    if (visitorEmail.length > 0) fieldsEcho.push({ label: 'Email', value: visitorEmail });
    fieldsEcho.push({ label: 'Response', value: describeApprovalOutcome(built, config) });
    const receipt = resolveVisitorReceipt({
      store: deps.getStore(),
      receptionDeploymentMode: deps.receptionDeploymentMode,
      config: config.visitor_receipt,
      reference_id: intent.intent_id,
      submitted_at: now,
      endpoint_kind: 'approval_link',
      fields_echo: fieldsEcho,
    });

    writeHtmlResponse(
      res,
      renderApprovalLinkSuccessHtml({
        display_name,
        success_message: successMessage,
        receipt,
      }),
      200,
    );
  };
};

// ────────────────────────────────────────────────────────────────
// Default fallback (deps-absent stub)
// ────────────────────────────────────────────────────────────────

/** Substrate-compatible default handler — registered in
 *  `handlers/index.ts`. The dispatcher in `handler.ts` re-binds the
 *  handler with deps at boot; this default is the deps-absent fallback
 *  + preserves the substrate-wide 503 JSON contract the P2 stub
 *  shipped. */
export const handleApprovalLinkPacket: ReceptionKindHandler = async (
  _req,
  res,
  _endpoint,
) => {
  res.statusCode = 503;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(NOT_IMPLEMENTED_BODY));
};

// Internal helpers exposed for tests.
export { buildOutcome, parseApprovalLinkConfig, parseFormBody };
