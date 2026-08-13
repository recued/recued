/** D-145 PA7 — pure compose-state transitions.
 *
 *  Every transition takes the current state + an input + returns a new
 *  state. No mutation. Host wires UI events to these and re-renders
 *  off the returned shape. Mirrors the PA6 work-entity-page
 *  state.ts pattern.
 *
 *  Spec: D-145 § A.5 (Email compose UI). */

import {
  EMPTY_MAIL_COMPOSE_VALUES,
  MAIL_COMPOSE_MAX_ATTACHMENTS,
  type MailComposeDialogState,
  type MailComposeState,
  type MailComposeValues,
  type MailReplyContext,
} from './types.js';
import { deriveReplyValues } from './reply-context.js';

/** Initial compose state — dialog closed. */
export const initialMailComposeState = (): MailComposeState => ({
  dialog: null,
});

/** Open a fresh compose dialog. `default_sender_source_id` is the
 *  host-resolved default Source for the mail kind (typically
 *  `prefs.mail_message.last_used_source_id` falling back to the
 *  Recued built-in mail Source); the dialog uses it as the initial
 *  `sender_source` so the user can submit without first clicking the
 *  picker. Same-state callers (re-opening an already-open dialog)
 *  receive a fresh state — the substrate doesn't preserve in-progress
 *  drafts across opens at PA7. */
export const openCreateComposeTransition = (
  state: MailComposeState,
  args: { default_sender_source_id: string },
): MailComposeState => ({
  ...state,
  dialog: {
    mode: 'create',
    values: {
      ...EMPTY_MAIL_COMPOSE_VALUES,
      sender_source: args.default_sender_source_id,
    },
    errors: {},
    submitting: false,
    submit_error: null,
  },
});

/** Open a compose dialog in reply mode with the original message's
 *  context prepopulated. Reply-context derivation is delegated to
 *  `deriveReplyValues`; the transition glues the result onto the
 *  empty-values seed. Reply mode persists across host re-opens until
 *  the user explicitly closes — i.e. opening reply on the same thread
 *  with the same context returns the same prepopulation. */
export const openReplyComposeTransition = (
  state: MailComposeState,
  context: MailReplyContext,
): MailComposeState => {
  const reply = deriveReplyValues(context);
  return {
    ...state,
    dialog: {
      mode: 'reply',
      values: { ...EMPTY_MAIL_COMPOSE_VALUES, ...reply },
      errors: {},
      submitting: false,
      submit_error: null,
    },
  };
};

/** Patch values on the open dialog. No-op (returns same ref) when the
 *  dialog is closed — the host shouldn't dispatch value patches in
 *  that case, but defensive substrate behavior keeps state coherent.
 *
 *  Editing values clears any prior `submit_error` per the
 *  `MailComposeDialogState.submit_error` contract — the user has
 *  signalled intent to retry, so the stale-failure banner shouldn't
 *  shadow the in-progress edit. */
export const setComposeValuesTransition = (
  state: MailComposeState,
  patch: Partial<MailComposeValues>,
): MailComposeState => {
  if (state.dialog === null) return state;
  return {
    ...state,
    dialog: {
      ...state.dialog,
      values: { ...state.dialog.values, ...patch },
      submit_error: null,
    },
  };
};

/** D-172 P2 — attach one or more `data.file` record ids.
 *
 *  Deliberately NOT expressed as `setComposeValuesTransition({attachments})`:
 *  that overload makes the caller own dedup and the cap, and every host would
 *  own them differently. Appends in argument order, drops ids already present
 *  (re-picking the same file is a no-op, not a duplicate part on the wire),
 *  and refuses anything past `MAIL_COMPOSE_MAX_ATTACHMENTS` — silently
 *  truncating there would let the user believe a file is attached that is not.
 *  Over-cap ids are NOT rejected here: the picker marks them and the server
 *  drops + warns, so the decision stays visible rather than swallowed.
 *
 *  Returns the same reference when nothing changed, so a host diffing on
 *  identity does not re-render for a duplicate pick. */
export const addComposeAttachmentsTransition = (
  state: MailComposeState,
  ids: readonly string[],
): MailComposeState => {
  if (state.dialog === null) return state;
  const current = state.dialog.values.attachments;
  const seen = new Set(current);
  const added: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    if (current.length + added.length >= MAIL_COMPOSE_MAX_ATTACHMENTS) break;
    seen.add(trimmed);
    added.push(trimmed);
  }
  if (added.length === 0) return state;
  return {
    ...state,
    dialog: {
      ...state.dialog,
      values: { ...state.dialog.values, attachments: [...current, ...added] },
      submit_error: null,
    },
  };
};

/** D-172 P2 — detach one `data.file` record id. No-op (same reference) when the
 *  id is not attached, so a double-click on Remove cannot drop a neighbour. */
export const removeComposeAttachmentTransition = (
  state: MailComposeState,
  id: string,
): MailComposeState => {
  if (state.dialog === null) return state;
  const current = state.dialog.values.attachments;
  if (!current.includes(id)) return state;
  return {
    ...state,
    dialog: {
      ...state.dialog,
      values: { ...state.dialog.values, attachments: current.filter((a) => a !== id) },
      submit_error: null,
    },
  };
};

/** Set field-level errors. Pass `{}` to clear. */
export const setComposeErrorsTransition = (
  state: MailComposeState,
  errors: Readonly<Record<string, string>>,
): MailComposeState => {
  if (state.dialog === null) return state;
  return {
    ...state,
    dialog: { ...state.dialog, errors },
  };
};

/** Toggle the in-flight `submitting` flag. The dialog renders Saving…
 *  + disables submit / close while submitting is true. */
export const setComposeSubmittingTransition = (
  state: MailComposeState,
  submitting: boolean,
): MailComposeState => {
  if (state.dialog === null) return state;
  if (state.dialog.submitting === submitting) return state;
  return {
    ...state,
    dialog: { ...state.dialog, submitting },
  };
};

/** Set or clear the banner-level submit error. Setting also flips
 *  `submitting` back to false (the dispatch failed; user is no longer
 *  waiting on the rpc). */
export const setComposeSubmitErrorTransition = (
  state: MailComposeState,
  submit_error: string | null,
): MailComposeState => {
  if (state.dialog === null) return state;
  return {
    ...state,
    dialog: { ...state.dialog, submit_error, submitting: false },
  };
};

/** Close the dialog. Submitting state takes precedence — closing while
 *  the rpc is in flight is a no-op (host wires the close button to
 *  ignore clicks while submitting). The substrate enforces it
 *  defensively. */
export const closeComposeTransition = (
  state: MailComposeState,
): MailComposeState => {
  if (state.dialog === null) return state;
  if (state.dialog.submitting === true) return state;
  return { ...state, dialog: null };
};

/** Force-close the dialog regardless of submitting state. Reserved for
 *  host-level cleanup paths (page navigation, error boundary) where
 *  the in-flight rpc is being torn down separately. Tests pin both
 *  affordances. */
export const forceCloseComposeTransition = (
  state: MailComposeState,
): MailComposeState => {
  if (state.dialog === null) return state;
  return { ...state, dialog: null };
};

/** Convenience accessor: the open dialog or `null`. */
export const composeDialog = (
  state: MailComposeState,
): MailComposeDialogState | null => state.dialog;
