/** D-145 PA7 / D-172 P2 — the webclient host for the mail compose dialog.
 *
 *  ── What a "host" owns here ───────────────────────────────────────
 *  The dialog (`@recued/ui-shared` `renderMailComposeDialog`) is a pure
 *  string renderer and the state machine (`@recued/contracts`
 *  `mail-compose/state`) is pure transitions. Neither touches the DOM or the
 *  wire. This module is the only piece that does: it holds the state, mounts
 *  the markup, delegates events back into the transitions, and dispatches the
 *  send.
 *
 *  It is deliberately mount-shaped rather than route-shaped so Chat can reuse
 *  it verbatim — `mountMailCompose(host, deps)` takes any element. The
 *  `#mail` route is one caller, not the owner.
 *
 *  ── The send is a RUN, not a send ─────────────────────────────────
 *  ⛔ There is no rpc that sends mail, by design. D-177 N.12 removed
 *  `collection.mail.send` from the wire method set — with a ratchet pinning
 *  its absence — because outbound mail is a side-effecting action and every
 *  action is gated at the one enforcement boundary. So Send dispatches
 *  `execute({ recipe_id: SEND_COMPOSED_MAIL_RECIPE_ID, config })`; the server
 *  runs the engine, the `core.mail.send` step lifts to `ask` at the D-157
 *  gate, and the owner approves in Approvals before anything leaves.
 *
 *  ⚠ THAT MEANS A SUCCESSFUL DISPATCH IS NOT A SENT MESSAGE, and this surface
 *  must never say it is. `submitOutcome` distinguishes the two so the copy
 *  can: `held` (the normal path — waiting on approval) vs `sent` (the run
 *  completed outright, which happens only if the gate is pre-satisfied).
 *  Reporting "Sent" on a held run would be the failure this whole gate exists
 *  to prevent, stated by the UI.
 *
 *  ── Deps are seams, not rpc ───────────────────────────────────────
 *  Every server touch is a narrow caller the bootstrap supplies, matching the
 *  convention in the other routes. Tests drive the real module with stubbed
 *  callers instead of hand-building requests. */

import {
  MAIL_MESSAGE_SCHEMA,
  MAIL_COMPOSE_REWRITE_ACTIONS,
  REWRITE_COMPOSED_MAIL_RECIPE_ID,
  SEND_COMPOSED_MAIL_RECIPE_ID,
  addComposeAttachmentsTransition,
  closeComposeTransition,
  composeDialog,
  composePayloadToSendRecipeConfig,
  composeRewriteRecipeConfig,
  composeStateToSendPayload,
  formFromCanonicalSchema,
  initialMailComposeState,
  openCreateComposeTransition,
  openReplyComposeTransition,
  removeComposeAttachmentTransition,
  setComposeErrorsTransition,
  setComposeSubmitErrorTransition,
  setComposeSubmittingTransition,
  setComposeValuesTransition,
  type MailComposeAttachment,
  type MailComposeState,
  type MailReplyContext,
  type MailComposeRewriteAction,
  type MailSenderSourceOption,
} from '@recued/contracts';
import { renderMailComposeDialog } from '@recued/ui-shared';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

// ════════════════════════════════════════════════════════════════
// Caller seams
// ════════════════════════════════════════════════════════════════

/** One `collection.mail.list` row — enough to identify the mailbox and decide
 * whether the compose surface may honestly open. */
export interface MailInstanceSummary {
  slug: string;
  adapter_type: string;
  send_capable: boolean;
  account_email: string;
}

/** `collection.mail.list` — enrolled mail instances with send capability. */
export type MailInstanceListCaller = () => Promise<{
  instances: ReadonlyArray<MailInstanceSummary>;
}>;

/** The closed readiness answer shared by every compose entry point.
 *
 * `none` and `unavailable` must never collapse together: the former authorizes
 * a setup suggestion, while the latter proves only that Recued could not check.
 * Likewise, a read-only mailbox deserves a repair path rather than the new-
 * account path. */
export type MailSendReadiness =
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'read_only'; mailboxes: readonly MailSenderSourceOption[] }
  | { status: 'ready'; mailboxes: readonly MailSenderSourceOption[] }
  | { status: 'unavailable' };

/** `execute` — narrowed to the two fields this surface sets. */
export type MailComposeExecuteCaller = (args: {
  recipe_id: string;
  config: Record<string, unknown>;
}) => Promise<unknown>;

/** The owner's file inventory, already projected to picker options. Supplied
 *  by the bootstrap so this module stays free of the `data.mirror.search`
 *  id-prefix rules (which the D-200 `file-ref-picker` already owns). */
export type MailComposeFileInventoryCaller = () => Promise<
  ReadonlyArray<MailComposeAttachment>
>;

/** Prompt the owner for files to attach. The host does not own a file browser;
 *  the route supplies one and returns the chosen `data.file` record ids.
 *  Returning `[]` (or the caller being absent) means "nothing picked". The
 *  optional signal retires a body-level chooser when its compose owner closes. */
export type MailComposeFilePickCaller = (
  selected: readonly string[],
  signal?: AbortSignal,
) => Promise<readonly string[]>;

export interface MailComposeDeps {
  listMailInstances: MailInstanceListCaller;
  runExecute: MailComposeExecuteCaller;
  /** Absent ⇒ chips render unresolved (id + "size unknown") rather than
   *  vanishing. The compose still works; only the labels degrade. */
  listFiles?: MailComposeFileInventoryCaller;
  /** Absent ⇒ the Attach control is inert. Surfaced rather than hidden so the
   *  affordance does not silently disappear on a partially wired host. */
  pickFiles?: MailComposeFilePickCaller;
  /** Resolve a recipient ref to an address. Default: pass through anything
   *  that already looks like an address, reject otherwise — a host with a
   *  contact graph supplies the real resolver. */
  resolveContactEmail?: (ref: string) => string | null;
}

/** What a dispatch actually achieved. See the header — `held` is the normal
 *  outcome and MUST NOT be reported as sent. */
export type MailComposeSubmitOutcome = 'held' | 'sent';

export interface MailComposeMount {
  /** Open a blank compose. */
  openCreate(): boolean;
  /** Open a compose prefilled from a thread. */
  openReply(context: MailReplyContext): boolean;
  /** Current state — exposed for the route's own empty-state decisions. */
  state(): MailComposeState;
  /** Current send-readiness projection. */
  readiness(): MailSendReadiness;
  /** Re-read mail instances from the server. */
  refresh(): Promise<MailSendReadiness>;
  /** Live-DOM-aware draft check for shell leave guards. */
  hasUnsavedChanges(): boolean;
  /** A send, file choice, or rewrite action that has not settled yet. */
  hasInFlightWork(): boolean;
  /** Last dispatch outcome, or null if none has completed. */
  lastOutcome(): MailComposeSubmitOutcome | null;
  destroy(): void;
}

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════

const MAIL_ADAPTER_LABELS: Readonly<Record<string, string>> = {
  gmail: 'Gmail',
  graph: 'Outlook',
  imap: 'IMAP',
};

/** A mail instance row → the dialog's sender option.
 *
 *  ⛔ `mail_instance_slug` IS THE ROW'S OWN `slug`, NEVER DERIVED FROM THE ID.
 *  `MailSenderSourceOption` documents why: a trailing-segment heuristic
 *  collapsed `recued.mail_message` and `hubspot.<conn>.mail_message` onto the
 *  same slug. The row carries the real one; use it. */
export const senderOptionFromInstance = (row: {
  slug: string;
  adapter_type: string;
  send_capable: boolean;
  account_email: string;
}): MailSenderSourceOption => {
  const kind = MAIL_ADAPTER_LABELS[row.adapter_type] ?? row.adapter_type;
  const email = row.account_email.length > 0 ? row.account_email : row.slug;
  return {
    id: row.slug,
    label: `${email} (${kind})`,
    account_email: row.account_email,
    send_capable: row.send_capable,
    mail_instance_slug: row.slug,
  };
};

/** Project a successful mailbox roster read into the one readiness vocabulary
 * every entry point consumes. This is deliberately pure so the no-mailbox and
 * read-only distinctions stay pinned without a browser harness. */
export const mailSendReadinessFromInstances = (
  instances: readonly MailInstanceSummary[],
): MailSendReadiness => {
  if (instances.length === 0) return { status: 'none' };
  const mailboxes = instances.map(senderOptionFromInstance);
  return mailboxes.some((mailbox) => mailbox.send_capable)
    ? { status: 'ready', mailboxes }
    : { status: 'read_only', mailboxes };
};

/** Classify the execute response without treating transport success as mail
 * success. A durable approval pause is accepted but not sent; only a terminal
 * successful run is sent. Any contradictory or incomplete shape fails closed
 * so the draft stays open instead of reporting an outcome Recued cannot prove. */
export const mailComposeSubmitOutcomeFromExecuteResponse = (
  response: unknown,
): MailComposeSubmitOutcome | null => {
  if (response === null || typeof response !== 'object' || Array.isArray(response)) {
    return null;
  }
  const record = response as Record<string, unknown>;
  if (record.success === false && record.awaiting_approval === true) return 'held';
  if (record.success === true && record.awaiting_approval !== true) return 'sent';
  return null;
};

/** Read the hidden rewrite recipe's single text output without trusting a
 * loosely-shaped execute response. Approval pauses and non-success responses
 * are never draft text, and blank model output must not erase the message. */
export const rewrittenMailBodyFromExecuteResponse = (
  response: unknown,
): string | null => {
  if (response === null || typeof response !== 'object' || Array.isArray(response)) {
    return null;
  }
  const record = response as Record<string, unknown>;
  if (record.success !== true || record.awaiting_approval === true) return null;
  const output = record.output;
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return null;
  const render = (output as Record<string, unknown>).render;
  if (!Array.isArray(render)) return null;
  for (const section of render) {
    if (section === null || typeof section !== 'object' || Array.isArray(section)) continue;
    const row = section as Record<string, unknown>;
    if (
      row.type === 'text'
      && typeof row.data === 'string'
      && row.data.trim().length > 0
    ) return row.data;
  }
  return null;
};

/** Default recipient resolution: accept a bare address, reject anything else.
 *
 *  ⚠ Deliberately NOT a permissive pass-through. `composeStateToSendPayload`
 *  treats a `null` as "not in the contact graph" and surfaces it on the field,
 *  so a typo fails visibly at compose time instead of becoming an invalid
 *  RCPT TO the provider bounces later. */
const looksLikeEmail = (ref: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(ref.trim());

const defaultResolveContactEmail = (ref: string): string | null =>
  looksLikeEmail(ref) ? ref.trim() : null;

/** Read the compose form's live field values out of the DOM.
 *
 *  The form renderer emits `data-form-field` / `data-form-array-item` hooks;
 *  this reads them back so a submit reflects what the user typed rather than
 *  the last value we happened to patch into state. */
const readFormValues = (root: HTMLElement): Record<string, unknown> => {
  const values: Record<string, unknown> = {};
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-form-field]'))) {
    const name = el.getAttribute('data-form-field');
    if (name === null || name.length === 0) continue;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      values[name] = el.value;
    }
  }
  const arrays = new Map<string, string[]>();
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-form-array-item]'))) {
    const name = el.getAttribute('data-form-array-item');
    if (name === null || name.length === 0) continue;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) continue;
    const list = arrays.get(name) ?? [];
    // ⛔ EMPTY ROWS ARE PRESERVED POSITIONALLY. Filtering here would renumber
    // the array, and Remove is INDEX-based — dropping a blank row 0 makes a
    // click on row 2 delete row 3's value. Blanks are stripped once, at
    // submit, where renumbering is harmless.
    list.push(el.value.trim());
    arrays.set(name, list);
  }
  for (const [name, list] of arrays) values[name] = list;
  return values;
};

/** Drop the blank rows an Add click creates. Applied at submit only — see the
 *  positional note in `readFormValues`. */
const withoutBlankRecipients = (
  values: Parameters<typeof composeStateToSendPayload>[0],
): Parameters<typeof composeStateToSendPayload>[0] => ({
  ...values,
  to: values.to.filter((v) => v.trim().length > 0),
  cc: values.cc.filter((v) => v.trim().length > 0),
  bcc: values.bcc.filter((v) => v.trim().length > 0),
});

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

export const mountMailCompose = (
  host: HTMLElement,
  deps: MailComposeDeps,
): MailComposeMount => {
  const definition = formFromCanonicalSchema(MAIL_MESSAGE_SCHEMA);
  const resolveContactEmail = deps.resolveContactEmail ?? defaultResolveContactEmail;

  let state: MailComposeState = initialMailComposeState();
  let sources: MailSenderSourceOption[] = [];
  let files: MailComposeAttachment[] = [];
  let readinessState: MailSendReadiness = { status: 'loading' };
  let refreshGeneration = 0;
  let draftGeneration = 0;
  let attachmentGeneration = 0;
  let attachmentAbort: AbortController | null = null;
  let attachmentBusy = false;
  let assistGeneration = 0;
  let assistState: {
    busyAction: MailComposeRewriteAction | null;
    error: string | null;
    undo: { previous: string; applied: string } | null;
  } = { busyAction: null, error: null, undo: null };
  let outcome: MailComposeSubmitOutcome | null = null;
  let destroyed = false;

  const sendCapable = (): MailSenderSourceOption[] =>
    sources.filter((s) => s.send_capable);

  const render = (): void => {
    if (destroyed) return;
    const dialog = composeDialog(state);
    if (dialog === null) {
      host.innerHTML = '';
      return;
    }
    host.innerHTML = renderMailComposeDialog({
      definition,
      state: dialog,
      sources,
      // Only the ids currently attached need labels; passing the whole
      // inventory would leak every filename the owner has into the markup of
      // a dialog that shows four of them.
      attachments: files.filter((f) => dialog.values.attachments.includes(f.id)),
      aiAssist: {
        busyAction: assistState.busyAction,
        error: assistState.error,
        canUndo: assistState.undo !== null,
      },
      attachmentBusy,
    });
  };

  const setState = (next: MailComposeState): void => {
    if (next === state) return;
    state = next;
    render();
  };

  /** Fold the live DOM values into state before any transition that depends on
   *  them. Without this, typing in Subject and pressing Send would dispatch the
   *  last patched value — which is empty on a fresh compose. */
  const syncFromDom = (): void => {
    const dialog = composeDialog(state);
    if (dialog === null) return;
    const read = readFormValues(host);
    const patch: Record<string, unknown> = {};
    for (const key of ['subject', 'body', 'to', 'cc', 'bcc'] as const) {
      if (read[key] !== undefined) patch[key] = read[key];
    }
    if (Object.keys(patch).length > 0) {
      state = setComposeValuesTransition(state, patch as never);
    }
  };

  const submit = async (): Promise<void> => {
    syncFromDom();
    const dialog = composeDialog(state);
    if (
      dialog === null
      || dialog.submitting
      || attachmentBusy
      || assistState.busyAction !== null
    ) return;

    const result = composeStateToSendPayload(withoutBlankRecipients(dialog.values), {
      resolveContactEmail,
      findSenderSource: (id) => sources.find((s) => s.id === id) ?? null,
    });
    if (!result.ok) {
      setState(setComposeErrorsTransition(state, result.errors));
      return;
    }

    setState(setComposeErrorsTransition(state, {}));
    setState(setComposeSubmittingTransition(state, true));
    const generation = draftGeneration;
    try {
      const response = await deps.runExecute({
        recipe_id: SEND_COMPOSED_MAIL_RECIPE_ID,
        config: composePayloadToSendRecipeConfig(result.payload),
      });
      if (destroyed || generation !== draftGeneration) return;
      const nextOutcome = mailComposeSubmitOutcomeFromExecuteResponse(response);
      if (nextOutcome === null) {
        setState(setComposeSubmitErrorTransition(
          state,
          'Mail could not be queued. Your draft is unchanged.',
        ));
        return;
      }
      outcome = nextOutcome;
      setState(setComposeSubmittingTransition(state, false));
      setState(closeComposeTransition(state));
    } catch (err) {
      if (destroyed || generation !== draftGeneration) return;
      setState(setComposeSubmitErrorTransition(state, humanizeRpcError(err)));
    }
  };

  const attach = async (): Promise<void> => {
    const dialog = composeDialog(state);
    if (
      deps.pickFiles === undefined
      || dialog === null
      || dialog.submitting
      || attachmentBusy
      || assistState.busyAction !== null
    ) return;
    const selected = dialog.values.attachments;
    const draft = draftGeneration;
    const generation = ++attachmentGeneration;
    const controller = new AbortController();
    attachmentAbort = controller;
    attachmentBusy = true;
    render();
    try {
      const picked = await deps.pickFiles(selected, controller.signal);
      if (
        destroyed
        || controller.signal.aborted
        || draft !== draftGeneration
        || generation !== attachmentGeneration
      ) return;
      if (picked.length === 0) return;
      // Refresh labels so a just-uploaded file does not render "size unknown".
      if (deps.listFiles !== undefined) {
        try {
          files = [...(await deps.listFiles())];
        } catch {
          /* labels degrade; the attachment itself is unaffected */
        }
      }
      if (
        destroyed
        || controller.signal.aborted
        || draft !== draftGeneration
        || generation !== attachmentGeneration
      ) return;
      // The owner can resume typing after the picker closes while the label
      // refresh is still in flight. Fold those edits before repainting chips.
      syncFromDom();
      setState(addComposeAttachmentsTransition(state, picked));
    } catch (err) {
      if (
        destroyed
        || controller.signal.aborted
        || draft !== draftGeneration
        || generation !== attachmentGeneration
      ) return;
      syncFromDom();
      setState(setComposeSubmitErrorTransition(
        state,
        `Couldn’t open files. ${humanizeRpcError(err)}`,
      ));
    } finally {
      if (generation === attachmentGeneration) {
        attachmentAbort = null;
        attachmentBusy = false;
        render();
      }
    }
  };

  const retireAttachment = (): void => {
    attachmentGeneration += 1;
    attachmentAbort?.abort();
    attachmentAbort = null;
    attachmentBusy = false;
  };

  const resetAssist = (): void => {
    assistGeneration += 1;
    assistState = { busyAction: null, error: null, undo: null };
  };

  const close = (): void => {
    const next = closeComposeTransition(state);
    if (next === state) return;
    draftGeneration += 1;
    retireAttachment();
    resetAssist();
    setState(next);
  };

  const runAssist = async (action: MailComposeRewriteAction): Promise<void> => {
    syncFromDom();
    const dialog = composeDialog(state);
    if (
      dialog === null
      || dialog.submitting
      || attachmentBusy
      || assistState.busyAction !== null
    ) return;
    if (dialog.values.body.trim().length === 0) {
      assistState = {
        busyAction: null,
        error: 'Write a message before asking AI to rewrite it.',
        undo: null,
      };
      render();
      return;
    }

    const source = sources.find(
      (candidate) => candidate.id === dialog.values.sender_source,
    );
    const baseline = dialog.values.body;
    const generation = ++assistGeneration;
    assistState = { busyAction: action, error: null, undo: null };
    render();
    try {
      const response = await deps.runExecute({
        recipe_id: REWRITE_COMPOSED_MAIL_RECIPE_ID,
        config: composeRewriteRecipeConfig({
          values: {
            ...dialog.values,
            // Recipient slots can carry contact refs. Seed the privacy ledger
            // with resolved addresses when the host knows them, so an address
            // repeated in the body is still aliased before model egress.
            to: dialog.values.to.map(
              (ref) => resolveContactEmail(ref) ?? ref,
            ),
            cc: dialog.values.cc.map(
              (ref) => resolveContactEmail(ref) ?? ref,
            ),
            bcc: dialog.values.bcc.map(
              (ref) => resolveContactEmail(ref) ?? ref,
            ),
          },
          sender_email: source?.account_email ?? '',
        }, action),
      });
      if (destroyed || generation !== assistGeneration) return;
      syncFromDom();
      const current = composeDialog(state);
      if (current === null) return;
      if (current.values.body !== baseline) {
        assistState = {
          busyAction: null,
          error: 'The message changed while AI was working, so Recued left your newer text untouched.',
          undo: null,
        };
        render();
        return;
      }
      const rewritten = rewrittenMailBodyFromExecuteResponse(response);
      if (rewritten === null) {
        assistState = {
          busyAction: null,
          error: 'AI did not return a usable rewrite. Your message is unchanged.',
          undo: null,
        };
        render();
        return;
      }
      assistState = {
        busyAction: null,
        error: null,
        undo: { previous: baseline, applied: rewritten },
      };
      setState(setComposeValuesTransition(state, { body: rewritten }));
    } catch (err) {
      if (destroyed || generation !== assistGeneration) return;
      // The body stays editable while the read-only AI call runs. Preserve any
      // newer typing before painting the failure banner.
      syncFromDom();
      assistState = {
        busyAction: null,
        error: humanizeRpcError(err),
        undo: null,
      };
      render();
    }
  };

  const undoAssist = (): void => {
    syncFromDom();
    const dialog = composeDialog(state);
    const undo = assistState.undo;
    if (
      dialog === null
      || dialog.submitting
      || undo === null
      || assistState.busyAction !== null
    ) return;
    if (dialog.values.body !== undo.applied) {
      assistState = {
        busyAction: null,
        error: 'Undo was not applied because the message changed after the rewrite.',
        undo: null,
      };
      render();
      return;
    }
    assistState = { busyAction: null, error: null, undo: null };
    setState(setComposeValuesTransition(state, { body: undo.previous }));
  };

  /** ⛔⛔ THE FORM RENDERER'S Add / Remove BUTTONS ARE INERT MARKUP. `renderForm`
   *  emits `data-form-array-add` / `data-form-array-remove` and stops there —
   *  wiring them is the HOST's job (`form-renderer/mount.ts` exists for hosts
   *  that render a bare form). Without this, `to` / `cc` / `bcc` can never gain
   *  a row, so the compose window renders perfectly and CANNOT SEND A MESSAGE
   *  TO ANYONE. Found by driving the real route in Chrome; the unit tests, the
   *  typecheck, and 5,652 webclient tests were all green.
   *
   *  ⚠ NOT delegated to `mountForm`: that helper re-paints `host.innerHTML`
   *  with `renderForm` alone, which would erase the dialog chrome around it
   *  (sender picker, attachment picker, footer). One re-render owner — this
   *  host — is the whole point. The generic seeding logic it carries is not
   *  needed either: every array in the compose form is an array of strings. */
  const mutateArray = (
    field: string,
    mutate: (list: string[]) => string[],
  ): void => {
    const dialog = composeDialog(state);
    if (dialog === null) return;
    if (field !== 'to' && field !== 'cc' && field !== 'bcc') return;
    // Read the LIVE dom first so a row the user has already typed into is not
    // reverted by an Add click on a sibling row.
    syncFromDom();
    const current = composeDialog(state)?.values[field] ?? [];
    setState(setComposeValuesTransition(state, { [field]: mutate([...current]) } as never));
  };

  const onClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    // ⛔⛔ SYNC BEFORE ANY TRANSITION, NOT JUST BEFORE SUBMIT. Every branch below
    // re-renders from state, and `renderMailComposeDialog` paints input VALUES
    // from state — so a transition that has not absorbed the live DOM first
    // silently reverts everything the person typed. Attaching a file wiped the
    // subject, body and recipients; the markup was correct, the state was
    // stale, and nothing failed. Found by driving the route in Chrome.
    syncFromDom();

    const addEl = target.closest<HTMLElement>('[data-form-array-add]');
    if (addEl !== null) {
      const field = addEl.getAttribute('data-form-array-add');
      // An empty string is a real row the user is about to type into. It is
      // dropped at submit by `readFormValues` (blank entries are filtered), so
      // an abandoned row never becomes an empty recipient.
      if (field !== null) mutateArray(field, (list) => [...list, '']);
      return;
    }
    const removeEl = target.closest<HTMLElement>('[data-form-array-remove]');
    if (removeEl !== null) {
      const field = removeEl.getAttribute('data-form-array-remove');
      const index = Number(removeEl.getAttribute('data-form-array-index'));
      if (field !== null && Number.isInteger(index)) {
        mutateArray(field, (list) => list.filter((_, i) => i !== index));
      }
      return;
    }

    const actionEl = target.closest<HTMLElement>('[data-action]');
    const action = actionEl?.getAttribute('data-action') ?? null;

    // ⛔ BACKDROP MUST CHECK target === currentTarget. The dialog's own header
    // says so: click-bubbling from a form field would otherwise dismiss the
    // dialog and discard the draft (the PA6 P1 fold, replicated here).
    if (action === 'close-mail-compose-on-backdrop') {
      if (event.target !== event.currentTarget && target !== actionEl) return;
      if (target === actionEl) close();
      return;
    }
    if (action === 'close-mail-compose') {
      close();
      return;
    }
    if (action === 'submit-mail-compose') {
      void submit();
      return;
    }
    if (action === 'mail-compose-attachment-add') {
      void attach();
      return;
    }
    if (action === 'mail-compose-attachment-remove') {
      const id = actionEl?.getAttribute('data-attachment-id');
      if (id !== null && id !== undefined) {
        setState(removeComposeAttachmentTransition(state, id));
      }
      return;
    }
    if (action === 'mail-compose-ai-undo') {
      undoAssist();
      return;
    }
    const rewriteAction = MAIL_COMPOSE_REWRITE_ACTIONS.find(
      (candidate) => action === `mail-compose-ai-${candidate}`,
    );
    if (rewriteAction !== undefined) {
      void runAssist(rewriteAction);
    }
  };

  const onChange = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    if (target.getAttribute('data-action') !== 'select-mail-compose-sender') return;
    // Same reason as the click path — changing the From account re-renders.
    syncFromDom();
    setState(setComposeValuesTransition(state, { sender_source: target.value }));
  };

  host.addEventListener('click', onClick);
  host.addEventListener('change', onChange);

  const refresh = async (): Promise<MailSendReadiness> => {
    const generation = ++refreshGeneration;
    readinessState = { status: 'loading' };
    try {
      const listed = await deps.listMailInstances();
      if (destroyed || generation !== refreshGeneration) return readinessState;
      sources = listed.instances.map(senderOptionFromInstance);
      readinessState = mailSendReadinessFromInstances(listed.instances);
    } catch {
      if (destroyed || generation !== refreshGeneration) return readinessState;
      sources = [];
      readinessState = { status: 'unavailable' };
    }
    if (destroyed || generation !== refreshGeneration) return readinessState;
    render();
    return readinessState;
  };

  return {
    openCreate() {
      const first = sendCapable()[0];
      const dialog = composeDialog(state);
      if (
        readinessState.status !== 'ready'
        || first === undefined
        || dialog?.submitting === true
        || attachmentBusy
        || assistState.busyAction !== null
      ) return false;
      draftGeneration += 1;
      retireAttachment();
      resetAssist();
      setState(
        openCreateComposeTransition(state, {
          default_sender_source_id: first.id,
        }),
      );
      return true;
    },
    openReply(context) {
      const dialog = composeDialog(state);
      if (
        readinessState.status !== 'ready'
        || !sendCapable().some((source) => source.id === context.original_source_id)
        || dialog?.submitting === true
        || attachmentBusy
        || assistState.busyAction !== null
      ) {
        return false;
      }
      draftGeneration += 1;
      retireAttachment();
      resetAssist();
      setState(openReplyComposeTransition(state, context));
      return true;
    },
    state: () => state,
    readiness: () => readinessState,
    refresh,
    hasUnsavedChanges: () => {
      syncFromDom();
      const dialog = composeDialog(state);
      if (dialog === null) return false;
      const values = dialog.values;
      return values.subject.trim().length > 0
        || values.body.trim().length > 0
        || values.to.length > 0
        || values.cc.length > 0
        || values.bcc.length > 0
        || values.attachments.length > 0;
    },
    hasInFlightWork: () =>
      composeDialog(state)?.submitting === true
      || attachmentBusy
      || assistState.busyAction !== null,
    lastOutcome: () => outcome,
    destroy() {
      destroyed = true;
      draftGeneration += 1;
      refreshGeneration += 1;
      retireAttachment();
      assistGeneration += 1;
      host.removeEventListener('click', onClick);
      host.removeEventListener('change', onChange);
      host.innerHTML = '';
    },
  };
};
