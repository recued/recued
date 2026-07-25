/** D-149 P6 § A.5.3 — `intake_form` packet handlers (GET + POST).
 *
 *  The pre-handler dispatcher in `handler.ts` already verified the
 *  bearer token, the per-IP rate limit, the post-verify daily cap, and
 *  that the cached registry row is enabled + non-revoked + non-expired.
 *  By the time these handlers run the request is authorized — the only
 *  work left is:
 *
 *    GET (slot-picker analog):
 *      1. Parse the stored `IntakeFormConfig` blob.
 *      2. Build the redacted packet (strict-pick + reshape).
 *      3. Issue a per-render form-nonce (single-use; bound to endpoint).
 *      4. Render the form HTML in public mode (closed-list field types).
 *
 *    POST (submission):
 *      1. Parse `application/x-www-form-urlencoded` body.
 *      2. Single-use form-nonce consume (CSRF guard).
 *      3. Origin / Referer same-origin verify (CSRF guard).
 *      4. Honeypot check (`'spam'` outcome when tripped).
 *      5. Domain-allowlist check (`'rejected_domain'` outcome when tripped).
 *      6. Per-field validation against the form_definition schema.
 *      7. Encrypt PII via `form-pii.ts` AAD-bound to `(endpoint, id, field)`.
 *      8. Insert `reception_form_submission` row.
 *      9. For a paired pending row, run the paired recipe through the
 *         D-207 gated runner (`coordinatePairedRun`).
 *     10. Emit signed `form_submission.received` audit row.
 *     11. Return the success page (or redirect_url_after_submit when set).
 *
 *  Engine-side reactive trigger fires on the row insert; the engine
 *  path handles target-entity creation (`task` / `note` / `commitment` /
 *  `inbox_item`) + reactive recipe dispatch + notification per
 *  `submission_processing_rule`. Substrate never blocks the visitor
 *  thread on engine work (§ Must Hold I-12).
 *
 *  Privacy contract (§ A.5.3 lines 760-762): the visitor sees only the
 *  visitor-visible form fields + the configured display name +
 *  instructions + submit button. User-only metadata never crosses the
 *  packet boundary; user_only_field_names + per_field_visibility maps
 *  stay server-side at every step.
 *
 *  Spec: docs/d-149-spec.md § A.5.3 + § Must Hold I-12 + I-12b + § N.6. */

import { randomBytes, randomUUID } from 'node:crypto';
import { verifyReceptionSameOrigin } from './same-origin.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  validateIntakeFormSubmission,
  isReceptionFormPairBinding,
  receptionPairBindingEquals,
  INTAKE_FORM_DEFAULT_SUBMIT_BUTTON_LABEL,
  INTAKE_FORM_DEFAULT_SUCCESS_MESSAGE,
  type FormResponse,
  type IntakeFormConfigField,
  type IntakeFormSubmissionInput,
  type IntakeFormSubmissionProcessingOutcome,
  type IntakeFormConfig,
  type ReceptionFormPairBinding,
  type RedactedPacketBuildAuditEvent,
  type TrustFooterDeploymentMode,
  type VisitorReceiptFieldEcho,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import { buildReceptionPacket } from '../redacted-packet.js';
import { resolveReceptionTrustFooter } from './trust-footer.js';
import { resolveVisitorReceipt } from './visitor-receipt.js';
import {
  buildIntakeFormPacketRawInput,
  buildIntakeFormSourceView,
  parseIntakeFormConfig,
} from '../transformations/intake-form.js';
import { sealFormSubmissionField } from '../form-pii.js';
import {
  renderIntakeFormHtml,
  renderIntakeFormPlaceholderHtml,
  renderIntakeFormErrorHtml,
  renderIntakeFormSuccessHtml,
  type IntakeFormRenderInput,
} from './intake-form-render.js';
import type { ReceptionOutputBlock } from './reception-page-render.js';
import type { ReceptionEndpointContext } from '../redacted-packet.js';
import type { ReceptionKindHandler } from './types.js';
import type { PublicEndpointRegistryStore } from '../../../storage/public-endpoint-registry-store.js';
import type { FormResponseStore } from '../../../storage/form-response-store.js';
import type { FormSubmissionStore } from '../../../storage/reception-form-store.js';
import type { ReceptionIntakeRecipePairResolution } from '../intake-recipe-pair.js';

/** Substrate-level submission schema version, stamped on the encrypted
 *  `reception_form_submission` row AND mirrored into the canonical
 *  `form_response` log's metadata. ONE constant because the two must agree:
 *  the approve-time promotion derives the log's `schema_version` from the ROW
 *  (`responseMetadataFor`), so a submit-time literal that drifted from the
 *  row's would make two logs of the same shape disagree about their schema.
 *  Bumped only when `form_definition` gains versioning (D-149 § A.5.3). */
const SUBMISSION_SCHEMA_VERSION = 1;

/** Max POST body bytes. Each form field caps at 4KB (textarea); 16
 *  fields + email + nonce ⇒ comfortable ceiling at 64 KB. */
const MAX_BODY_BYTES = 64 * 1024;

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
  writeHtmlResponse(
    res,
    renderIntakeFormErrorHtml({ display_name, message }),
    status,
  );
};

// ────────────────────────────────────────────────────────────────
// Form-nonce store (in-memory, per-process)
// ────────────────────────────────────────────────────────────────

/** Per-issued form-nonce stamp. The POST submit handler consumes
 *  these once + cross-checks against the registry. Keys are
 *  `${endpoint_id}|${form_nonce}`; values retain the issue clock and the
 *  source-checked pair (or explicit unpaired state) seen by GET. */
export interface IntakeFormNonceStore {
  /** Issue a fresh nonce + return the encoded form-nonce. */
  issue(
    endpoint_id: string,
    now: number,
    pair_binding?: ReceptionFormPairBinding | null,
  ): string;
  /** Consume a nonce — returns its immutable render stamp on a single-use
   * match within the TTL, `null` otherwise. Generic forms carry a null pair. */
  consume(endpoint_id: string, nonce: string, now: number): IntakeFormNonceStamp | null;
}

export interface IntakeFormNonceStamp {
  readonly pair_binding: ReceptionFormPairBinding | null;
}

/** Default TTL — visitors have 30 minutes to submit after loading. */
export const INTAKE_FORM_NONCE_TTL_MS = 30 * 60 * 1000;

const NONCE_BYTES = 24;

export const createInMemoryIntakeFormNonceStore = (): IntakeFormNonceStore => {
  const inner = new Map<string, {
    readonly issued_at: number;
    readonly pair_binding: ReceptionFormPairBinding | null;
  }>();
  return {
    issue(endpoint_id, now, pair_binding = null) {
      if (pair_binding !== null
        && !isReceptionFormPairBinding(pair_binding)) {
        throw new Error('intake form nonce: invalid pair binding');
      }
      const nonce = randomBytes(NONCE_BYTES).toString('hex');
      inner.set(`${endpoint_id}|${nonce}`, {
        issued_at: now,
        pair_binding: pair_binding === null ? null : { ...pair_binding },
      });
      return nonce;
    },
    consume(endpoint_id, nonce, now) {
      const key = `${endpoint_id}|${nonce}`;
      const stamp = inner.get(key);
      if (stamp === undefined) return null;
      inner.delete(key);
      if (now - stamp.issued_at > INTAKE_FORM_NONCE_TTL_MS) return null;
      return {
        pair_binding: stamp.pair_binding === null
          ? null
          : { ...stamp.pair_binding },
      };
    },
  };
};

export type ResolveIntakeFormRecipePair = (input: {
  readonly endpoint_id: string;
  readonly form_config: IntakeFormConfig;
}) => ReceptionIntakeRecipePairResolution;

/** D-200 Slice 6g.13 — narrow post-insert seam. The public handler supplies no
 * recipe, economics, Seller identity, template, provider result, or URL. The
 * production adapter source-derives those inputs from the durable row/pair and
 * returns only a checked ephemeral hosted redirect after its durable fences. */
export type CoordinateIntakeFormPairedRun = (input: {
  readonly submission_id: string;
  readonly form_config: IntakeFormConfig;
}) => Promise<
  /** D-207 slice 1c — the paired recipe RAN TO COMPLETION through the Gateway. Nothing is
   *  outstanding: the visitor gets the ordinary success page and it is true.
   *
   *  This is the outcome a NON-PAYMENT door produces — a lead-capture, a support triage, a
   *  booking. It is the whole point of D-207: a public form whose recipe finished, with no
   *  payment code anywhere in the path.
   *
   *  D-207 slice 2 — `render` mode. The run's resolved `output.render` blocks ride along and
   *  are rendered INTO the success page by the shared block renderer. An empty array is the
   *  ordinary case and means exactly what it did before: a recipe that declares no output
   *  finishes, and the visitor gets the plain thank-you. */
  | { readonly kind: 'completed'; readonly render: ReadonlyArray<ReceptionOutputBlock> }
  /** D-207 slice 1c — the paired recipe HELD at the D-157 gate (`awaiting_approval`).
   *  The submission is durable and the owner will review it in the D-173 Inbox, so the
   *  ordinary success page is the HONEST answer here: "we got it, we'll be in touch".
   *  An anonymous actor is pinned to the `read` ceiling, so EVERY write a public form
   *  performs surfaces here rather than firing silently for a stranger — this is the
   *  common outcome for a door that writes, not an edge case. */
  | { readonly kind: 'held' }
  /** Could not proceed. The visitor was on a form that promised something further (a
   *  checkout) and is not getting it — so they MUST be told. See the fall-through below. */
  | { readonly kind: 'refused' }
>;

/** D-207 slice 1c — the visitor-facing response for a paired submit.
 *
 *  THE SILENT-SUCCESS-PAGE BUG lived in the absence of this function. A visitor filled in a
 *  form bound to a paired recipe, submitted, and — when the recipe could not produce the
 *  redirect it promised — the handler fell straight through to the success page. They were
 *  told "thank you, we got your submission" and were NEVER ASKED TO PAY. The `catch` branch
 *  did the same, so a provider outage produced the identical lie.
 *
 *  A thank-you page is a CLAIM: "nothing is outstanding — we have what we need." Only
 *  these outcomes may make it:
 *
 *    - `completed` — the paired recipe ran to completion through the Gateway. Nothing is
 *      outstanding. This is the ordinary D-207 non-payment door (lead capture, triage).
 *    - `held` — the run is parked at the D-157 gate. The submission is durable and the
 *      owner will review it in the D-173 Inbox. "We got it, we'll be in touch" is TRUE.
 *    - `null` — an ordinary intake with no paired recipe. Success, as before.
 *
 *  And these may NOT:
 *
 *    - `refused` / `unavailable` — the submission is durable (the owner still sees it) but
 *      the visitor was promised a checkout and is not getting one, and ONLY THEY can act on
 *      that. Tell them, and tell them nothing was charged.
 *
 *  Exported so the contract is asserted against the REAL decision the handler makes, not a
 *  restatement of it in a test. */
export type IntakeFormPairedRunDisposition =
  | 'completed' | 'held' | 'refused' | 'unavailable' | null;

export type IntakeFormSubmitResponse =
  | { readonly kind: 'success' }
  | { readonly kind: 'error'; readonly status: 503 }
  /** D-207 slice 2c — the submission was NOT accepted, and on this form that
   *  cannot be hidden, so it is not hidden. 400, not 503: 503 means WE failed
   *  (the run refused, the provider was down); this means we did not take it. */
  | { readonly kind: 'rejected'; readonly status: 400; readonly message: string };

/** The domain allowlist bounced this address. The visitor is a HUMAN who will
 *  otherwise never hear another thing, and they can act on this — with a
 *  different address, or by mailing the owner. */
export const INTAKE_FORM_DOMAIN_REJECTED_MESSAGE =
  'We can’t accept submissions from that email address. '
  + 'Please try a different one, or contact us directly.';

/** The honeypot tripped. Deliberately says nothing about WHY — a bot learns
 *  nothing here it did not already have. It is worded for the case that
 *  actually matters: a real person whose password manager or screen reader
 *  filled a field they could not see. Under the silent design, that person was
 *  thanked and dropped forever. */
export const INTAKE_FORM_NOT_PROCESSED_MESSAGE =
  'We couldn’t process this submission. Nothing was sent. '
  + 'Please try again, or contact us directly.';

/** D-207 slice 2c — WHAT THE VISITOR IS TOLD. One function, so the contract is
 *  asserted against the real decision rather than a restatement of it in a test.
 *
 *  A thank-you page is a CLAIM: "nothing is outstanding — we have what we need."
 *  D-149 lets a SPAM or DOMAIN-REJECTED submission make that claim on purpose:
 *  the response carried nothing either way, so the lie cost no one anything and
 *  it stopped a bot from fingerprinting the honeypot by comparing two
 *  submissions.
 *
 *  ⛔ THAT TRADE INVERTS THE MOMENT THE RESPONSE CARRIES A PRODUCT. On a form
 *  whose paired recipe renders — a checkout button, a quote — the bot ALREADY
 *  knows it was rejected, because the product is not there. The silence is spent
 *  no matter what we do here, so it buys nothing; and its only remaining victim
 *  is the human. So on those forms, and ONLY those, rejection is honest.
 *
 *  Everywhere else the D-149 default stands untouched, because there the silence
 *  still works. That is why this takes `pair_renders_response` and not a toggle:
 *  the condition under which silence is sound is a FACT about the form, derived
 *  from the recipe, and not something anyone should have to remember to set. */
export const intakeFormSubmitResponse = (input: {
  readonly disposition: IntakeFormPairedRunDisposition;
  readonly processing_outcome: IntakeFormSubmissionProcessingOutcome;
  readonly pair_renders_response: boolean;
}): IntakeFormSubmitResponse => {
  if (input.disposition === 'refused' || input.disposition === 'unavailable') {
    return { kind: 'error', status: 503 };
  }
  if (input.pair_renders_response) {
    if (input.processing_outcome === 'rejected_domain') {
      return { kind: 'rejected', status: 400, message: INTAKE_FORM_DOMAIN_REJECTED_MESSAGE };
    }
    if (input.processing_outcome === 'spam') {
      return { kind: 'rejected', status: 400, message: INTAKE_FORM_NOT_PROCESSED_MESSAGE };
    }
  }
  // `pending` — including a run that COMPLETED or is HELD at the D-157 gate.
  // Held is durable and the owner reviews it, so "we got it" stays true.
  return { kind: 'success' };
};

const resolvePairOrUnpaired = (
  resolver: ResolveIntakeFormRecipePair | undefined,
  endpoint_id: string,
  form_config: IntakeFormConfig,
): ReceptionIntakeRecipePairResolution => resolver?.({ endpoint_id, form_config })
  ?? { kind: 'unpaired' };

const nonceMatchesCurrentPair = (
  stamp: IntakeFormNonceStamp,
  current: ReceptionIntakeRecipePairResolution,
): boolean => {
  if (current.kind === 'stale') return false;
  if (current.kind === 'unpaired') return stamp.pair_binding === null;
  return stamp.pair_binding !== null
    && receptionPairBindingEquals(stamp.pair_binding, current.binding);
};

// ────────────────────────────────────────────────────────────────
// Bearer extract (re-used for the hidden form field)
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

/** Always-present reserved form-key set (the substrate's own fields).
 *  Field names from the form_definition extend this allowlist at parse
 *  time; an unknown key triggers a 400. */
const RESERVED_FORM_KEYS = new Set<string>(['t', 'form_nonce', 'visitor_email']);

interface ParsedFormBody {
  /** Reserved fields (form_nonce, visitor_email) the substrate handles. */
  readonly form_nonce: string;
  readonly visitor_email: string;
  /** Per-field visitor values keyed by form_definition name. */
  readonly fields: Record<string, string | ReadonlyArray<string>>;
  /** Closed-list field types from the spec — substrate keeps `string`
   *  / `array<string>` at this layer; type coercion lives in the
   *  validator. */
  readonly honeypotsTripped: ReadonlyArray<string>;
}

export const parseFormBody = (
  raw: string,
  fields: ReadonlyArray<IntakeFormConfigField>,
  honeypotNames: ReadonlySet<string>,
): ParsedFormBody | { error: 'unknown_field' | 'malformed' } => {
  const params = new URLSearchParams(raw);
  const allowedKeys = new Set<string>(RESERVED_FORM_KEYS);
  for (const f of fields) allowedKeys.add(f.name);
  for (const n of honeypotNames) allowedKeys.add(n);

  for (const [key] of params) {
    if (!allowedKeys.has(key)) {
      return { error: 'unknown_field' };
    }
  }

  const fieldByName = new Map<string, IntakeFormConfigField>();
  for (const f of fields) fieldByName.set(f.name, f);

  const out: Record<string, string | ReadonlyArray<string>> = {};
  const honeypotsTripped: string[] = [];
  for (const f of fields) {
    if (honeypotNames.has(f.name)) continue;
    if (f.type === 'array<text>') {
      const raw = params.get(f.name);
      if (raw !== null) {
        const items = raw
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        out[f.name] = items;
      }
      continue;
    }
    if (f.type === 'boolean') {
      const raw = params.get(f.name);
      // Browsers omit the key entirely when the checkbox is unchecked;
      // present-and-empty is treated as `false`.
      if (raw === null) continue;
      out[f.name] = raw === 'true' || raw === 'on' ? 'true' : 'false';
      continue;
    }
    const raw = params.get(f.name);
    if (raw !== null) out[f.name] = raw;
  }

  for (const n of honeypotNames) {
    // `getAll`, not `get`: a bot can prefix an EMPTY duplicate of the
    // honeypot field (`website=&website=filled`) so `get` returns only
    // the leading '' and the trap never trips. Trip if ANY value is
    // non-empty.
    if (params.getAll(n).some((v) => v.length > 0)) {
      honeypotsTripped.push(n);
    }
  }

  return {
    form_nonce: params.get('form_nonce') ?? '',
    visitor_email: params.get('visitor_email') ?? '',
    fields: out,
    honeypotsTripped,
  };
};

// ────────────────────────────────────────────────────────────────
// Coerce typed fields for submission validator + AEAD payload
// ────────────────────────────────────────────────────────────────

const coerceSubmissionFields = (
  parsed: Record<string, string | ReadonlyArray<string>>,
  fieldDefs: ReadonlyArray<IntakeFormConfigField>,
): Record<string, string | number | boolean | ReadonlyArray<string>> => {
  const fieldByName = new Map<string, IntakeFormConfigField>();
  for (const f of fieldDefs) fieldByName.set(f.name, f);
  const out: Record<string, string | number | boolean | ReadonlyArray<string>> = {};
  for (const [name, raw] of Object.entries(parsed)) {
    const def = fieldByName.get(name);
    if (!def) {
      // Unknown — validator will reject; pass through verbatim.
      out[name] = raw as string;
      continue;
    }
    if (def.type === 'number') {
      // Validator handles string-form numbers; pass through.
      out[name] = raw as string;
      continue;
    }
    if (def.type === 'boolean') {
      out[name] = raw === 'true';
      continue;
    }
    if (def.type === 'array<text>') {
      out[name] = Array.isArray(raw) ? raw : [String(raw)];
      continue;
    }
    out[name] = raw as string;
  }
  return out;
};

// ────────────────────────────────────────────────────────────────
// GET handler
// ────────────────────────────────────────────────────────────────

export interface IntakeFormPacketHandlerDeps {
  readonly getStore: () => PublicEndpointRegistryStore;
  readonly getFormNonceStore: () => IntakeFormNonceStore;
  readonly now: () => number;
  readonly resolveRecipePair?: ResolveIntakeFormRecipePair;
  readonly emitAudit?: (event: RedactedPacketBuildAuditEvent) => string | undefined;
  /** D-149 P12 § A.20.7 — deployment mode for the Public Trust Footer.
   *  Boot-constant derived in `bin.ts` from the public base URL host
   *  (`isProDdnsHost`). Absent ⇒ the handler renders no trust footer. */
  readonly receptionDeploymentMode?: TrustFooterDeploymentMode;
}

export const createIntakeFormPacketHandler = (
  deps: IntakeFormPacketHandlerDeps,
): ReceptionKindHandler => {
  return async (req: IncomingMessage, res: ServerResponse, endpoint: ReceptionEndpointContext) => {
    const endpoint_id = endpoint.endpoint_id;
    if (!endpoint_id) {
      writeHtmlResponse(res, renderIntakeFormPlaceholderHtml(), 503);
      return;
    }

    const row = deps.getStore().findById(endpoint_id);
    if (!row) {
      writeHtmlResponse(res, renderIntakeFormPlaceholderHtml(), 503);
      return;
    }
    const config = parseIntakeFormConfig(row.metadata);
    if (!config) {
      writeHtmlResponse(res, renderIntakeFormPlaceholderHtml(), 503);
      return;
    }

    const now = deps.now();
    const source = buildIntakeFormSourceView(
      config,
      `Submissions are rate-limited at ${config.anti_spam.rate_limit_per_ip}/hour per IP.`,
    );
    const rawInput = buildIntakeFormPacketRawInput(source);
    const opts: Parameters<typeof buildReceptionPacket>[3] = {
      now,
      randomToken: () => randomUUID(),
      ...(deps.emitAudit !== undefined ? { emitAudit: deps.emitAudit } : {}),
    };
    const built = buildReceptionPacket('intake_form_packet', rawInput, endpoint, opts);

    // The substrate-built packet exposes the visitor-visible fields the
    // RENDERER consumes; honeypot fields are intentionally absent there.
    // The renderer mixes honeypots back in from the source view at HTML
    // emit time so bots see + fill them. Visible fields are mirrored
    // from the config (closed shape) for type info; user-only fields
    // are gone by virtue of the source view's filter.
    const visibleFieldDefs: ReadonlyArray<IntakeFormConfigField> = config.form_definition.fields.filter(
      (f) => {
        if (config.form_definition.user_only_field_names?.includes(f.name)) return false;
        if (config.anti_spam.honeypot_fields.includes(f.name)) return false;
        return true;
      },
    );

    const pairResolution = resolvePairOrUnpaired(
      deps.resolveRecipePair,
      endpoint_id,
      config,
    );
    if (pairResolution.kind === 'stale') {
      writeHtmlResponse(res, renderIntakeFormPlaceholderHtml(), 503);
      return;
    }
    const nonce = deps.getFormNonceStore().issue(
      endpoint_id,
      now,
      pairResolution.kind === 'ready' ? pairResolution.binding : null,
    );
    const bearer = extractBearer(req);

    // The redacted-packet build result is the source of truth for what
    // the visitor sees — but the renderer needs richer per-field info
    // (enum values; per-type details) than what `IntakeFormVisitorField`
    // carries. Mirror from the config's visibleFieldDefs (which match
    // the redacted-packet's visitor_visible_fields by name).
    // D-149 P12 § A.20.7 — resolve the Public Trust Footer (reads the
    // per-server toggle off the reception_page singleton).
    const trust_footer =
      deps.receptionDeploymentMode !== undefined
        ? resolveReceptionTrustFooter({
            store: deps.getStore(),
            deployment_mode: deps.receptionDeploymentMode,
          })
        : null;

    const renderInput: IntakeFormRenderInput = {
      display_name: config.display_name,
      ...(config.instructions ? { instructions: config.instructions } : {}),
      fields: visibleFieldDefs,
      honeypot_fields: config.anti_spam.honeypot_fields,
      visitor_email_requirement: config.required_visitor_fields.email,
      submit_button_label:
        config.submit_button_label ?? INTAKE_FORM_DEFAULT_SUBMIT_BUTTON_LABEL,
      endpoint_id,
      bearer_secret: bearer,
      form_nonce: nonce,
      trust_footer,
    };

    // Defense in depth — assert the substrate's redacted packet didn't
    // emit a field that's NOT in the renderer's visibleFieldDefs set.
    // (The redacted-packet substrate already strict-picks, so this is
    // tautological; the check is a no-op in production but a guard
    // rail for any future shape drift.)
    const visibleSet = new Set(visibleFieldDefs.map((f) => f.name));
    for (const vf of built.payload.form_definition.visitor_visible_fields) {
      if (!visibleSet.has(vf.name)) {
        // Substrate drift — strip the renderer's input rather than
        // emitting an inconsistent form (no half-rendered UI).
        writeHtmlResponse(res, renderIntakeFormPlaceholderHtml(), 503);
        return;
      }
    }

    writeHtmlResponse(res, renderIntakeFormHtml(renderInput));
  };
};

// ────────────────────────────────────────────────────────────────
// POST submit handler
// ────────────────────────────────────────────────────────────────

export interface IntakeFormSubmitHandlerDeps {
  readonly getStore: () => PublicEndpointRegistryStore;
  readonly getSubmissionStore: () => FormSubmissionStore;
  /** D-210 WS2 — the canonical `form_response` log. REQUIRED, not optional:
   *  the log is written at submit for every ordinary non-spam intake, so a
   *  handler that could not write one would accept submissions it cannot
   *  record. The dispatcher's readiness gate keeps the POST path on the
   *  kind-registry 503 stub until this store is wired. */
  readonly getFormResponseStore: () => Pick<FormResponseStore, 'accept'>;
  readonly getFormNonceStore: () => IntakeFormNonceStore;
  readonly getFormSubmissionPiiKey: () => Uint8Array;
  readonly auditLog: AuditLogStore;
  readonly now: () => number;
  /** D-210 WS2 — best-effort first-create fan-out for the submit-time log,
   *  the same seam the approve-time promotion uses (owner Data invalidation +
   *  the warehouse trigger bus). Absent ⇒ the row is still written. */
  readonly onFormResponseCreated?: (response: FormResponse) => void;
  readonly resolveRecipePair?: ResolveIntakeFormRecipePair;
  readonly coordinatePairedRun?: CoordinateIntakeFormPairedRun;
  /** D-149 § A.20.3 / § A.20.7 — deployment mode for the Public Trust
   *  Footer carried in the Visitor Receipt's `privacy_footer` slot.
   *  Absent ⇒ the receipt renders without a privacy footer. */
  readonly receptionDeploymentMode?: TrustFooterDeploymentMode;
}

export const createIntakeFormSubmitHandler = (
  deps: IntakeFormSubmitHandlerDeps,
): ((req: IncomingMessage, res: ServerResponse, endpoint: ReceptionEndpointContext) => Promise<void>) => {
  return async (req, res, endpoint) => {
    const endpoint_id = endpoint.endpoint_id;
    if (!endpoint_id) {
      writeErrorPage(res, 'this form', 'Submission unavailable.', 503);
      return;
    }
    if (req.method !== 'POST') {
      writeErrorPage(res, 'this form', 'Method not allowed.', 405);
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
      writeErrorPage(res, 'this form', message, 413);
      return;
    }

    if (!verifyOrigin(req)) {
      writeErrorPage(res, 'this form', 'Submission blocked by origin policy.', 403);
      return;
    }

    const row = deps.getStore().findById(endpoint_id);
    if (!row) {
      writeErrorPage(res, 'this form', 'Submission unavailable.', 503);
      return;
    }
    const config = parseIntakeFormConfig(row.metadata);
    if (!config) {
      writeErrorPage(res, 'this form', 'Submission unavailable.', 503);
      return;
    }

    const display_name = config.display_name;
    const honeypotNames = new Set(config.anti_spam.honeypot_fields);
    const parsed = parseFormBody(bodyRaw, config.form_definition.fields, honeypotNames);
    if ('error' in parsed) {
      const msg =
        parsed.error === 'unknown_field'
          ? 'Submission contained an unknown field.'
          : 'Submission could not be parsed.';
      writeErrorPage(res, display_name, msg, 400);
      return;
    }

    // Form-nonce single-use consume.
    const nonceStamp = parsed.form_nonce.length === 0
      ? null
      : deps.getFormNonceStore().consume(endpoint_id, parsed.form_nonce, deps.now());
    if (nonceStamp === null) {
      writeErrorPage(
        res,
        display_name,
        'This form is stale. Please reload the page and try again.',
        400,
      );
      return;
    }

    // The page's pair state is immutable for this submit. A pair added,
    // removed, rebound, or source-drifted after render makes the page stale;
    // never reinterpret its fields under a different recipe or silently fall
    // back to the generic intake path.
    const currentPair = resolvePairOrUnpaired(
      deps.resolveRecipePair,
      endpoint_id,
      config,
    );
    if (!nonceMatchesCurrentPair(nonceStamp, currentPair)) {
      writeErrorPage(
        res,
        display_name,
        'This form changed after it was opened. Please reload the page and try again.',
        409,
      );
      return;
    }
    if (nonceStamp.pair_binding !== null
      && deps.coordinatePairedRun === undefined) {
      writeErrorPage(
        res,
        display_name,
        'Checkout is temporarily unavailable. Please reload the page and try again.',
        503,
      );
      return;
    }

    // Codex review fold (P2 #2, 2026-05-13) — when the config says
    // `required_visitor_fields.email === 'omit'`, the renderer doesn't
    // emit a `<input name="visitor_email">` at all, so a non-empty
    // value from a real visitor is structurally impossible. A crafted
    // POST (curl / bot / dev-tools form-edit) can still inject one;
    // the validator skips email checks in omit-mode, so the value
    // would silently pass through to encryption + persistence. Zero
    // it out at parse boundary to enforce the no-collection contract
    // server-side.
    const omitEmail = config.required_visitor_fields.email === 'omit';
    const visitorEmail = omitEmail ? '' : parsed.visitor_email;

    const now = deps.now();
    const submission_id = randomUUID();

    // Codex review fold (P2 #1, 2026-05-13) — enforce the per-form
    // `anti_spam.rate_limit_per_ip` AGAINST the per-form rolling-hour
    // submission count. The dispatcher's pre-verify uses the static
    // per-kind default; Mary's per-form override is consulted here so
    // a form configured tighter than the substrate default actually
    // gates correctly. Counted per-endpoint (not per-IP-per-endpoint)
    // since the submissions table is the source of truth for "how many
    // submissions this form has accepted." Effect: a 5/hr form admits
    // 5 submissions in any 1-hour window from all visitors combined,
    // tighter than the kind-default 10/hr; a 60/hr form admits up to
    // the configured ceiling instead of being silently capped at the
    // substrate default.
    const RATE_WINDOW_MS = 60 * 60 * 1000;
    const formWindowCount = deps.getSubmissionStore().countWithinWindow({
      endpoint_id,
      window_start_at: now - RATE_WINDOW_MS,
      now,
    });
    if (formWindowCount >= config.anti_spam.rate_limit_per_ip) {
      const retryAfterSec = 60; // honest "try again in a minute" hint
      res.setHeader('Retry-After', String(retryAfterSec));
      writeErrorPage(
        res,
        display_name,
        "This form has hit its hourly submission limit. Please try again later.",
        429,
      );
      return;
    }

    // Build the typed input the validator consumes.
    const fields = coerceSubmissionFields(parsed.fields, config.form_definition.fields);
    const input: IntakeFormSubmissionInput = {
      ...(visitorEmail.length > 0 ? { visitor_email: visitorEmail } : {}),
      fields,
    };

    // Honeypot tripped — persist the row marked spam (so Mary's abuse
    // inbox sees it) + return the success page to avoid signalling to
    // the bot. Per § A.5.3 line 704 substrate keeps the row.
    const honeypotTripped = parsed.honeypotsTripped.length > 0;

    // Domain-allowlist gate. Validator reports it as a failure;
    // substrate maps to the `'rejected_domain'` outcome below.
    const validationFailures = validateIntakeFormSubmission(input, config);

    let outcome: IntakeFormSubmissionProcessingOutcome = 'pending';
    if (honeypotTripped) outcome = 'spam';
    else if (validationFailures.some((f) => f.code === 'visitor_email_domain_rejected')) {
      outcome = 'rejected_domain';
    } else if (validationFailures.length > 0) {
      writeErrorPage(
        res,
        display_name,
        validationFailures[0]!.detail,
        400,
      );
      return;
    }

    // Encrypt PII. The submission_blob is JSON-serialized; the email
    // gets its own sealed ciphertext so the engine reactive path can
    // decrypt the email independently of the body.
    const key = deps.getFormSubmissionPiiKey();
    const blobJson = JSON.stringify({
      ...(visitorEmail.length > 0 ? { visitor_email: visitorEmail } : {}),
      fields,
    });
    const [visitor_email_encrypted, submission_blob_encrypted] = await Promise.all([
      sealFormSubmissionField({
        key,
        endpoint_id,
        submission_id,
        field: 'visitor_email',
        plaintext: visitorEmail.length > 0 ? visitorEmail : null,
      }),
      sealFormSubmissionField({
        key,
        endpoint_id,
        submission_id,
        field: 'submission_blob',
        plaintext: blobJson,
      }),
    ]);
    if (submission_blob_encrypted === null) {
      // Should never happen — blobJson is always non-empty (we always
      // include the `fields` object). Defense in depth: surface a
      // server-side 503 rather than persisting an empty row.
      writeErrorPage(res, display_name, 'Submission unavailable.', 503);
      return;
    }

    // Encryption yields to the event loop. Re-read the endpoint config and
    // pair immediately before the synchronous insert so an owner edit/rebind
    // during validation or sealing cannot slip an obsolete render stamp into
    // a newly persisted row. No await occurs between this check and insert.
    // D-207 slice 2c — this same resolution answers a SECOND question. It already
    // reads the paired recipe (to prove the stored binding still matches its
    // current snapshot), so it also reports whether that recipe RENDERS — which
    // decides, below, whether a rejected submission on this form may still be
    // told "Submission received".
    let pairRendersResponse = false;
    if (deps.resolveRecipePair !== undefined) {
      const latestRow = deps.getStore().findById(endpoint_id);
      const latestConfig = latestRow === null
        ? null
        : parseIntakeFormConfig(latestRow.metadata);
      const pairBeforePersist: ReceptionIntakeRecipePairResolution = latestConfig === null
        ? { kind: 'stale' }
        : resolvePairOrUnpaired(
            deps.resolveRecipePair,
            endpoint_id,
            latestConfig,
          );
      if (!nonceMatchesCurrentPair(nonceStamp, pairBeforePersist)) {
        writeErrorPage(
          res,
          display_name,
          'This form changed after it was opened. Please reload the page and try again.',
          409,
        );
        return;
      }
      // Only a `ready` pair reports it. `stale` never gets here (the currency
      // check above returned 409) and `unpaired` renders nothing by definition,
      // so both correctly leave this false — the D-149 default, untouched.
      pairRendersResponse = pairBeforePersist.kind === 'ready'
        && pairBeforePersist.renders_response;
    }

    // Persist. `schema_version` is set to 1 at substrate level until
    // the form_definition supports versioning (deferred to a follow-up
    // phase; the column lives in the schema today per spec § A.5.3).
    // Freeze the exact definition alongside the pending submission. The form
    // definition row is mutable, so looking it up only after owner approval
    // could reinterpret old answers using newer labels/types. This snapshot is
    // server-owned metadata and never comes from a visitor field.
    const metadataPayload: Record<string, unknown> = {
      definition_snapshot: config.form_definition,
    };
    if (honeypotTripped) metadataPayload.honeypots_tripped = parsed.honeypotsTripped;
    if (config.template_ref) metadataPayload.template_ref = config.template_ref;

    deps.getSubmissionStore().insert({
      submission_id,
      endpoint_id,
      form_definition_id: config.form_definition.form_definition_id,
      submitted_at: now,
      source_ip_hash: null, // dispatcher already wrote the per-IP hash to the access log
      visitor_email_encrypted,
      submission_blob_encrypted,
      schema_version: SUBMISSION_SCHEMA_VERSION,
      processing_outcome: outcome,
      pair_binding: nonceStamp.pair_binding,
      metadata: metadataPayload,
    });

    // D-210 A.8 slice 2b — the `form_response` DESTINATION, written here at
    // submit while the plaintext is still live.
    //
    // ⚠ THIS WAS THE ALWAYS-ON LOG UNTIL 2b, and the previous comment said so:
    // *"it is NOT a destination … `target_kind` no longer decides whether the
    // submission is recorded at all."* True for WS2's premise — at the time
    // nothing else universally recorded a submission, so this row had to.
    // `reception_form_submission` is now exactly that (written first, kept even
    // for spam, the provenance anchor every surface keys off), which freed
    // `form_response` to become the generic MUTABLE destination (A.4).
    // So `target_kind` decides this again — the opposite of the old sentence.
    //
    // ⛔ What did NOT move: this is still written at SUBMIT, not at approval.
    // The plaintext is live here and needs no decrypt, and the record is of
    // what was SUBMITTED. It also still closes the hole the approve-time path
    // has — a row that never reaches the pre-resume hook is logged nowhere.
    //
    // Written here because the plaintext is still live — no decrypt, unlike
    // the approve-time path (`form-response-promotion.ts`). It also closes
    // that path's gap: an `auto_accept` endpoint never reached the pre-resume
    // hook, so its submissions were never logged anywhere readable. (D-210
    // Phase C has since retired `auto_accept` entirely — but submit-time
    // logging stands on its own: the plaintext is live here, and the log is
    // the record of what was SUBMITTED, not of what was approved.)
    //
    // Two exclusions, and each is a real boundary rather than a convenience:
    //
    //  - NON-`pending` outcomes (`spam` / `rejected_domain`) are not logged.
    //    The encrypted row is still kept for the abuse inbox; the canonical
    //    log is for submissions the substrate accepted.
    //  - PAIRED rows (`pair_binding !== null`) are not logged here. A D-200
    //    direct-checkout submission must not be logged before its payment is
    //    provider-verified, and its paid-gated write still happens at approve
    //    (`form-response-promotion.ts`). ⚠ There is deliberately NO
    //    D-207-vs-D-200 discriminator on a form binding (the `d200-pair-v*`
    //    prefix is the family's storage spelling, not a payment claim), so
    //    this exclusion is necessarily wider than the payment rule: a D-207
    //    door-paired intake gets no log either. That is UNCHANGED from today
    //    (`rowOwesDefaultDispatch` returns false for it, so it never reached
    //    the promotion hook) — an unclosed gap, not a regression. Closing it
    //    needs a discriminator that does not exist yet.
    //
    // Ordering: after the submission insert, never before. The encrypted row
    // is the provenance anchor every other surface keys off (drain, inbox,
    // audit); a canonical log for a submission the substrate holds no record
    // of would be provenance that lies. Same database, next statement, so the
    // window is one synchronous insert wide — and a failure here leaves a
    // fully reviewable submission, which is why it must not 503 a visitor
    // whose row is already durable (the same rule the paired-run catch below
    // states: durable means never invite a second POST).
    // ── The DESTINATION condition (2b). Both exclusions above are unchanged;
    // this narrows only WITHIN the pending + unpaired branch.
    //
    // A non-`form_response` destination gets no row: its record is the entity
    // it materializes, and `field_not_placed` (A.8 slice 2b, contracts) now
    // guarantees that entity carries every visible non-honeypot field — which
    // is what makes dropping this row safe rather than lossy.
    //
    // ⛔ Do NOT mirror this condition into `form-response-promotion.ts`. That
    // path writes for a D-200 PAID pair, where the row IS the paid deliverable
    // ("could not be written before payment"); gating it on `target_kind` would
    // mean a paid intake with a task destination produces no paid record. The
    // resulting asymmetry — paid pairs always get a row — is the correct
    // behaviour, not an oversight.
    //
    // ⚠ ONE spelling. `target_kind` is REQUIRED as of step 3, and the absent
    // value that used to mean log-only is now written `'form_response'`.
    // Nothing here should ever reintroduce an `=== undefined` branch.
    if (
      outcome === 'pending'
      && nonceStamp.pair_binding === null
      && config.submission_processing_rule.target_kind === 'form_response'
    ) {
      try {
        // Mirrors `responseMetadataFor` in `form-response-promotion.ts`:
        // everything the submission row carries EXCEPT the frozen definition
        // snapshot (which is its own column), plus server-owned schema
        // provenance. Derived from the same object the row was built with so
        // the two write sites cannot drift into different record shapes.
        const responseMetadata: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(metadataPayload)) {
          if (key !== 'definition_snapshot') responseMetadata[key] = value;
        }
        responseMetadata.schema_version = SUBMISSION_SCHEMA_VERSION;

        const accepted = deps.getFormResponseStore().accept({
          submission_id,
          endpoint_id,
          form_definition_id: config.form_definition.form_definition_id,
          definition_snapshot: config.form_definition,
          values: fields,
          ...(visitorEmail.length > 0 ? { visitor: { email: visitorEmail } } : {}),
          submitted_at: now,
          // Submit IS the acceptance now; there is no earlier moment to clamp
          // against, so the two timestamps are the same instant.
          accepted_at: now,
          metadata: responseMetadata,
        });
        if (accepted.status === 'created') {
          try {
            deps.onFormResponseCreated?.(accepted.response);
          } catch {
            // Fan-out is best-effort. The canonical insert is the authority
            // and is never rolled back because a bus subscriber threw.
          }
        }
      } catch (e) {
        console.error(
          `[d-210] intake_form: canonical form_response log failed for submission '${submission_id}' — the submission is durable and reviewable, but has no canonical record`,
          e,
        );
      }
    }

    // The paired row is now durable. Only this exact post-insert position may run the
    // paired recipe, and only a server-derived pending outcome is eligible. Generic, spam,
    // and rejected-domain rows retain the ordinary D-149 path.
    //
    // D-207 slice 3c — there is NO redirect disposition any more. The only thing that ever
    // 303'd was D-200's coordinator, and it is gone. Under ruling (C) the product is a
    // `link_button` rendered into the page, so nothing needs a 303 — and a recipe-produced
    // one would let anonymous input steer where the owner's form sends people. The guard
    // that checked those targets went with it: an unreachable guard that looks like
    // protection is worse than no guard at all.
    let pairedRunDisposition: IntakeFormPairedRunDisposition = null;
    // D-207 slice 2 — the paired run's `output.render` blocks, when it completed.
    let pairedRunRender: ReadonlyArray<ReceptionOutputBlock> | null = null;
    if (nonceStamp.pair_binding !== null && outcome === 'pending') {
      if (deps.coordinatePairedRun === undefined) {
        pairedRunDisposition = 'unavailable';
      } else {
        try {
          const checkout = await deps.coordinatePairedRun({
            submission_id,
            form_config: config,
          });
          if (checkout.kind === 'completed') {
            // D-207 slice 1c — the paired recipe ran to completion through the Gateway.
            // Nothing outstanding; the success page is true. NOTE this branch must stay
            // ABOVE the trailing `else`, which means REFUSED: a `completed` falling through
            // to it would 503 a run that actually succeeded.
            pairedRunDisposition = 'completed';
            // D-207 slice 2 — and its blocks become the page.
            pairedRunRender = checkout.render;
          } else if (checkout.kind === 'held') {
            pairedRunDisposition = 'held';
          } else {
            pairedRunDisposition = 'refused';
          }
        } catch {
          // The intake itself is already durable and must not be duplicated by
          // inviting a second form POST. Record the unavailable disposition in
          // the signed receipt audit; a later source-driven recovery may replay
          // this same submission id.
          pairedRunDisposition = 'unavailable';
        }
      }
    }

    // Signed `form_submission.received` audit row per § A.5.3 line 50
    // + § N.3 (one per submission). Spam / rejected_domain submissions
    // still emit — Mary's abuse inbox UX reads from the audit feed.
    try {
      await deps.auditLog.logActivity({
        activity_id: `form_submission.received-${now}-${submission_id}`,
        timestamp: now,
        action: 'form_submission.received',
        target: endpoint_id,
        detail: JSON.stringify({
          submission_id,
          form_definition_id: config.form_definition.form_definition_id,
          processing_outcome: outcome,
          // `paired_run` — rows written before D-207 3d·6d carry this
          // disposition under the legacy `direct_checkout` key. The log is
          // append-only history; only new emissions use the general name.
          ...(pairedRunDisposition === null
            ? {}
            : { paired_run: pairedRunDisposition }),
        }),
        reserve: true,
      });
    } catch {
      // Audit failure must not block the success page — the row is
      // already persisted. Operators see the failure in stderr; the
      // visitor sees a confirmed submission.
    }

    // ── D-207 slice 1c — DO NOT LIE TO THE VISITOR ──────────────────────────────────
    //
    // This is the silent-success-page bug. A visitor filled in a form that was bound to a
    // paired recipe, submitted, and — when the recipe could not produce the redirect it
    // promised — fell straight through to `renderIntakeFormSuccessHtml`. They were told
    // "thank you, we got your submission" and were NEVER ASKED TO PAY. The `catch` branch
    // did the same, so a provider outage produced the identical lie.
    //
    // `held` is the ONE non-redirect outcome that may still say thank-you: the run is
    // parked at the D-157 gate, the submission is durable, and the owner will review it in
    // the D-173 Inbox. "We got it, we'll be in touch" is TRUE there.
    //
    // `refused` / `unavailable` are not. The submission is durable (so the owner still
    // sees it), but the visitor was promised a checkout and is not getting one, and only
    // they can act on that. Tell them.
    const submitResponse = intakeFormSubmitResponse({
      disposition: pairedRunDisposition,
      processing_outcome: outcome,
      pair_renders_response: pairRendersResponse,
    });
    if (submitResponse.kind === 'error') {
      writeHtmlResponse(
        res,
        renderIntakeFormErrorHtml({
          display_name: config.display_name,
          message:
            'We recorded your details, but could not start the payment. Nothing has been charged. Please try again shortly, or contact us and we will pick it up from here.',
        }),
        submitResponse.status,
      );
      return;
    }

    // ── D-207 slice 2c — DON'T LIE TO THE VISITOR, PART TWO ─────────────────────────
    //
    // Spam or a domain rejection, on a form whose recipe RENDERS. D-149 answers both
    // with the success page so a bot cannot fingerprint the honeypot by comparing
    // two submissions. On this form it can anyway — the checkout button it did not
    // get IS the fingerprint — so the silence protects nothing and the only person
    // still being lied to is a human: the visitor whose email domain was bounced, or
    // the one whose password manager filled a hidden field. The row stays durable
    // either way, so the owner still sees it.
    if (submitResponse.kind === 'rejected') {
      writeHtmlResponse(
        res,
        renderIntakeFormErrorHtml({
          display_name: config.display_name,
          message: submitResponse.message,
        }),
        submitResponse.status,
      );
      return;
    }

    // Success page. Honeypot-tripped + rejected_domain BOTH return 200
    // success to the visitor (bot doesn't get a signal; the real
    // visitor whose email failed allowlist still gets a "received"
    // page so the substrate doesn't fingerprint the allowlist).
    const successMessage = config.success_message ?? INTAKE_FORM_DEFAULT_SUCCESS_MESSAGE;

    // D-149 § A.20.3 — Visitor Receipt. Echoes the visitor-submitted
    // form fields (in form_definition order; honeypot + user-only
    // fields excluded) + the self-reported email. Built unconditionally
    // on every outcome (pending / spam / rejected_domain) so the
    // success page stays byte-shaped the same — receipt presence must
    // not fingerprint honeypot / domain-allowlist detection. `null`
    // when the endpoint's `visitor_receipt` config is absent / disabled.
    const fieldsEcho: VisitorReceiptFieldEcho[] = [];
    if (visitorEmail.length > 0) fieldsEcho.push({ label: 'Email', value: visitorEmail });
    for (const f of config.form_definition.fields) {
      if (config.anti_spam.honeypot_fields.includes(f.name)) continue;
      if (config.form_definition.user_only_field_names?.includes(f.name)) continue;
      const raw = parsed.fields[f.name];
      if (raw === undefined) continue;
      const value = Array.isArray(raw)
        ? raw.join(', ')
        : f.type === 'boolean'
          ? raw === 'true'
            ? 'Yes'
            : 'No'
          : String(raw);
      if (value.length === 0) continue;
      fieldsEcho.push({ label: f.label, value });
    }
    const receipt = resolveVisitorReceipt({
      store: deps.getStore(),
      receptionDeploymentMode: deps.receptionDeploymentMode,
      config: config.visitor_receipt,
      reference_id: submission_id,
      submitted_at: now,
      endpoint_kind: 'intake_form',
      fields_echo: fieldsEcho,
    });

    writeHtmlResponse(
      res,
      renderIntakeFormSuccessHtml({
        display_name: config.display_name,
        success_message: successMessage,
        receipt,
        // D-207 slice 2 — `render` mode. Non-empty ONLY when a paired recipe ran
        // to completion; every other path (no pair, no door, held, spam,
        // rejected_domain) leaves this empty and the page byte-identical to what
        // D-149 shipped. `held` renders nothing on purpose: the run is parked at
        // the D-157 gate and has produced no output yet, so there is nothing
        // truthful to show — the thank-you it gets is the honest answer.
        render: pairedRunRender,
      }),
      200,
    );
  };
};

/** Substrate-compatible default handler — registered in
 *  `handlers/index.ts`. The dispatcher in `handler.ts` re-binds the
 *  handler with deps at boot; this default is the deps-absent fallback
 *  + preserves the substrate-wide 503 JSON contract the P2 stub ships. */
export const handleIntakeFormPacket: ReceptionKindHandler = async (
  _req,
  res,
  _endpoint,
) => {
  res.statusCode = 503;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: { code: 'not_implemented' } }));
};

// Internal helper exposed for tests — provides a parsed config from a
// raw metadata blob without re-importing the transformation module.
export { parseIntakeFormConfig };
