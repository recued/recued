/** D-145 PA7 — mail-compose substrate, contract-side types.
 *
 *  Substrate exists at `packages/contracts/src/mail-compose/` (pure
 *  logic — types + state machine + reply-context derivation + dispatch
 *  shape) + `packages/ui-shared/src/mail-compose/` (HTML rendering).
 *  The two halves form one substrate, mirroring the PA5 form-renderer
 *  + PA6 work-entity-page split. PA7 substrate consumes:
 *    - `MAIL_MESSAGE_SCHEMA` (from `canonical-schemas/mail-message.ts`)
 *      → `formFromCanonicalSchema` → `FormDefinition` for the body of
 *      the compose dialog
 *    - PA6 dialog patterns (backdrop click-through wiring,
 *      submit / cancel actions, submitting state)
 *    - D-127 `collection.mail.send` rpc shape (the dispatch payload
 *      mirrors this rpc's input)
 *
 *  The compose substrate is parallel to the PA6 work-entity-page
 *  substrate — both wrap the form-renderer + a dialog envelope, but
 *  compose adds reply-context prepopulation, a sender-Source picker
 *  scoped to send-capable mail Sources only, and an AI-assist sidebar
 *  slot (PA7 ships as a stub — engine integration lands in PB).
 *
 *  Spec: D-145 § A.5 (Email compose UI). */

/** Closed list of compose modes — `create` opens a fresh compose;
 *  `reply` is opened from a thread context with reply-context
 *  prepopulation pre-applied (see `reply-context.ts`). PA7 ships only
 *  these two; future modes (`forward` / `draft`) ride on the same
 *  state machine. */
export const MAIL_COMPOSE_MODES = ['create', 'reply'] as const;
export type MailComposeMode = (typeof MAIL_COMPOSE_MODES)[number];

/** A compose-dialog values shape. Refs (`to` / `cc` / `bcc` /
 *  `attachments` / `in_reply_to` / `sender_source`) carry the host's
 *  canonical id form — typically a contact email or contact_id for
 *  recipient refs, a file id for attachments, a mail-message id for
 *  `in_reply_to`, a Source id for `sender_source`. The dispatch helper
 *  (`dispatch.ts`) walks the recipient refs through a host-supplied
 *  resolver before producing the rpc payload. */
export interface MailComposeValues {
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
  subject: string;
  body: string;
  attachments: readonly string[];
  in_reply_to: string | null;
  sender_source: string;
}

/** Compose dialog state. The `dialog: MailComposeDialogState | null`
 *  shape mirrors PA6's work-entity-page dialog — `null` means the
 *  compose dialog is closed, an object means it's open. */
export interface MailComposeDialogState {
  mode: MailComposeMode;
  values: MailComposeValues;
  /** Field-level inline errors keyed by canonical field name. */
  errors: Readonly<Record<string, string>>;
  /** True while the rpc is in flight; the dialog disables submit + the
   *  close button locks the in-flight state so the user can't dismiss
   *  mid-send. */
  submitting: boolean;
  /** Banner-level error from the most recent send attempt. Cleared when
   *  the user retries by editing values or pressing submit again. */
  submit_error: string | null;
}

/** Top-level compose surface state. Hosts that integrate the compose
 *  substrate carry `MailComposeState` somewhere in their state tree;
 *  transitions return the same shape. */
export interface MailComposeState {
  dialog: MailComposeDialogState | null;
}

/** Empty values seed — used as the default `values` shape when
 *  initializing or resetting compose state. Public so tests +
 *  callers can compare against it cheaply. */
export const EMPTY_MAIL_COMPOSE_VALUES: MailComposeValues = {
  to: [],
  cc: [],
  bcc: [],
  subject: '',
  body: '',
  attachments: [],
  in_reply_to: null,
  sender_source: '',
};

/** D-172 P2 — one entry the compose attachment picker can display.
 *
 *  ⛔ THE COMPOSE STATE HOLDS `data.file` RECORD IDS, NEVER BYTES — that is the
 *  whole point of the attachment design. `MailComposeValues.attachments` is a
 *  list of ids; the send payload carries the same ids; `MailCollection.send`
 *  resolves them to bytes server-side through the Gateway-gated `file.read`.
 *  This shape exists ONLY so the picker can show a human something better than
 *  a raw `file:9a3c…` string. It is display metadata the host supplies
 *  alongside the ids — losing it degrades the label, never the attachment.
 *
 *  ⇒ the same property is what makes an AI-composed mail safe: a model names a
 *  file it has seen; it never carries, re-encodes, or re-uploads the bytes. */
export interface MailComposeAttachment {
  /** `data.file` record id — the value that actually rides in
   *  `MailComposeValues.attachments` and in the send payload. */
  id: string;
  filename: string;
  /** Byte length as recorded at ingest. Drives the over-cap mark against
   *  `MAIL_SEND_ATTACHMENT_MAX_BYTES`. `undefined` when the host could not
   *  resolve the record — the picker then shows the id and marks it unknown
   *  rather than pretending a size it does not have. */
  size_bytes?: number;
  mime_type?: string;
}

/** Upper bound on how many files one compose may carry. Not a provider limit —
 *  a UX floor against a runaway multi-select, checked in the add transition.
 *  The per-file byte cap (`MAIL_SEND_ATTACHMENT_MAX_BYTES`) is the separate,
 *  server-enforced one. */
export const MAIL_COMPOSE_MAX_ATTACHMENTS = 20;

/** Reply-context input shape. The host hands the substrate the
 *  original mail being replied to + the Source id that received the
 *  original; the substrate emits a partial values shape with
 *  `in_reply_to` / `to` / `subject` / `sender_source` prepopulated. */
export interface MailReplyContext {
  /** The mail being replied to. */
  original_message: {
    /** Canonical id of the original mail (used as the `in_reply_to`
     *  ref). */
    id: string;
    /** Subject line of the original. The compose substrate prepends
     *  `Re: ` (when not already prefixed). */
    subject: string;
    /** Sender of the original (becomes the prepopulated single
     *  `to` recipient). */
    from: string;
    /** Optional thread id — passed through to the rpc's `references`
     *  via the host's send dispatch. */
    thread_id?: string;
  };
  /** Source id of the mail Source that received the original (becomes
   *  the prepopulated `sender_source`). The host validates send-
   *  capability before opening the compose; the dispatch helper
   *  re-validates at submit time. */
  original_source_id: string;
}

/** A Source dropdown entry the compose substrate accepts for the
 *  sender-Source picker. Shape mirrors PA6's `SourceDropdownOption`
 *  but specialized for mail compose: `send_capable` is the gate
 *  (rather than PA6's `write_capable`), `account_email` is the
 *  human label the picker surfaces, and `mail_instance_slug` is the
 *  `data.mail.<slug>` instance the dispatch helper hands to the
 *  rpc — Source id ≠ instance slug, and the prior best-effort
 *  trailing-segment heuristic collapsed `recued.mail_message` and
 *  `hubspot.<conn>.mail_message` to the same `mail_message` slug. */
export interface MailSenderSourceOption {
  id: string;
  /** Human-readable label — typically the account email + a kind
   *  qualifier ("alice@gmail.com (Gmail)"). */
  label: string;
  /** Account email address — used as the `From` header on the outbound
   *  send + as the sender-loop guard's reference value. */
  account_email: string;
  /** True iff the Source is wired for outbound send. The picker omits
   *  any Source where this is false; the dispatch helper rejects send
   *  payloads keyed on a non-send-capable id. */
  send_capable: boolean;
  /** `data.mail.<slug>` instance the rpc dispatches against. The host
   *  populates from its Source registry — each registered mail Source
   *  is 1:1 with an enrolled mail collection instance. The substrate
   *  forbids deriving the slug from the Source id (multiple Source ids
   *  share the same `mail_message` kind suffix; trailing-segment
   *  extraction is structurally lossy). */
  mail_instance_slug: string;
}

/** AI-assist sidebar action kinds. PA7 ships the data-action wiring +
 *  rendered controls only — the host fires these as no-ops; engine
 *  integration lands in PB (per spec § A.5.5). The closed list covers
 *  the three primary capabilities § A.5.5 names — compose / rewrite /
 *  polish — plus the reply-mode-specific draft-reply, plus the two
 *  tone variants the rewrite call expands into in practice. */
export const MAIL_COMPOSE_AI_ACTIONS = [
  'compose',
  'rewrite-formal',
  'rewrite-friendly',
  'polish',
  'draft-reply',
] as const;
export type MailComposeAiAction = (typeof MAIL_COMPOSE_AI_ACTIONS)[number];
