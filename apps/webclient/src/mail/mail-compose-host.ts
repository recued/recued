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
  EMPTY_MAIL_COMPOSE_VALUES,
  MAIL_MESSAGE_SCHEMA,
  SEND_COMPOSED_MAIL_RECIPE_ID,
  addComposeAttachmentsTransition,
  closeComposeTransition,
  composeDialog,
  composePayloadToSendRecipeConfig,
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
  type MailSenderSourceOption,
} from '@recued/contracts';
import { renderMailComposeDialog } from '@recued/ui-shared';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

// ════════════════════════════════════════════════════════════════
// Caller seams
// ════════════════════════════════════════════════════════════════

/** `collection.mail.list` — enrolled mail instances with send capability. */
export type MailInstanceListCaller = () => Promise<{
  instances: ReadonlyArray<{
    slug: string;
    adapter_type: string;
    send_capable: boolean;
    account_email: string;
  }>;
}>;

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
 *  Returning `[]` (or the caller being absent) means "nothing picked". */
export type MailComposeFilePickCaller = () => Promise<readonly string[]>;

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
  openCreate(): void;
  /** Open a compose prefilled from a thread. */
  openReply(context: MailReplyContext): void;
  /** Current state — exposed for the route's own empty-state decisions. */
  state(): MailComposeState;
  /** Re-read mail instances + file inventory from the server. */
  refresh(): Promise<void>;
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
    if (dialog === null || dialog.submitting) return;

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
    try {
      await deps.runExecute({
        recipe_id: SEND_COMPOSED_MAIL_RECIPE_ID,
        config: composePayloadToSendRecipeConfig(result.payload),
      });
      // ⚠ The run was ACCEPTED. Whether the message left is the gate's answer,
      // not ours — see the header. `held` is the honest default.
      outcome = 'held';
      setState(setComposeSubmittingTransition(state, false));
      setState(closeComposeTransition(state));
    } catch (err) {
      setState(setComposeSubmitErrorTransition(state, humanizeRpcError(err)));
    }
  };

  const attach = async (): Promise<void> => {
    if (deps.pickFiles === undefined) return;
    const picked = await deps.pickFiles();
    if (picked.length === 0) return;
    // Refresh labels so a just-uploaded file does not render "size unknown".
    if (deps.listFiles !== undefined) {
      try {
        files = [...(await deps.listFiles())];
      } catch {
        /* labels degrade; the attachment itself is unaffected */
      }
    }
    setState(addComposeAttachmentsTransition(state, picked));
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
      if (target === actionEl) setState(closeComposeTransition(state));
      return;
    }
    if (action === 'close-mail-compose') {
      setState(closeComposeTransition(state));
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
    // `mail-compose-ai-*` are PA7 stubs with no engine behind them. Swallowing
    // them silently would read as a broken button, so they are simply not
    // handled here and the sidebar keeps saying "Coming soon".
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

  const refresh = async (): Promise<void> => {
    try {
      const listed = await deps.listMailInstances();
      sources = listed.instances.map(senderOptionFromInstance);
    } catch {
      sources = [];
    }
    if (deps.listFiles !== undefined) {
      try {
        files = [...(await deps.listFiles())];
      } catch {
        files = [];
      }
    }
    render();
  };

  return {
    openCreate() {
      const first = sendCapable()[0];
      setState(
        openCreateComposeTransition(state, {
          default_sender_source_id: first?.id ?? EMPTY_MAIL_COMPOSE_VALUES.sender_source,
        }),
      );
    },
    openReply(context) {
      setState(openReplyComposeTransition(state, context));
    },
    state: () => state,
    refresh,
    lastOutcome: () => outcome,
    destroy() {
      destroyed = true;
      host.removeEventListener('click', onClick);
      host.removeEventListener('change', onChange);
      host.innerHTML = '';
    },
  };
};
