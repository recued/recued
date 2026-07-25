/** D-149 follow-on § A.9 — Reception Settings prompts host runtime.
 *
 *  `mountReceptionPageHost` catches the page mount's eight host-forwarded
 *  actions; four of them launch a satellite mount (`mountAuthoringForm` /
 *  `mountLaunchWizard`) and the other four need a *prompt* the page host
 *  doesn't draw — a date for `reception-extend`, a rotation-reason for
 *  `reception-rotate-token`, a free-text revocation reason for
 *  `reception-revoke`, an irreversibility-confirm phrase for
 *  `reception-emergency-disable-all`. **This is the host that catches
 *  those four prompt-driven forwards.** The natural composition target:
 *  the page host's `onPromptAction` bridges into `promptsHost.open(...)`,
 *  the prompts host lands the appropriate modal in a third host element
 *  (separate from the page mount + the satellite mount slot — see DD#1).
 *
 *  ── What the prompts host owns ─────────────────────────────────────
 *  Four small modal forms — one per prompt kind. Each modal seeds a tiny
 *  working state, captures `input` / `change` events via a delegated
 *  listener, and on Submit fires the matching `ReceptionPageShell` rpc
 *  (`extendEndpoint` / `rotateToken` / `revokeEndpoint` /
 *  `emergencyDisableAll`). On `rotateToken` success the rotate result
 *  carries a fresh one-shot `share_url_once` the substrate never
 *  re-surfaces — the prompts host looks the row up in the shell's loaded
 *  page model to compose the per-kind share-card copy + registers it via
 *  `shell.setEndpointShare`. The other three calls have no share path.
 *
 *  ── Key design decisions (non-obvious — READ before touching) ──────
 *
 *  DD#1 — Third host element, not the page host's `modalHost`.
 *  Sharing `modalHost` with `mountReceptionPageHost`'s satellite mount
 *  slot would race the page host's "opening a second modal disposes the
 *  first" rule: a prompt + an authoring mount can legitimately want to
 *  coexist (e.g. a prompt-driven action surfaces on the same DOM column
 *  as the open detail view). The prompts host owns its own host
 *  element; the page host owns its `pageHost` + `modalHost`; the
 *  consumer arranges them visually (typically an overlay z-stack).
 *
 *  DD#2 — Singleton guard at the prompts boundary, not the renderer.
 *  The page renderer never emits any prompt action for the
 *  `reception_page` singleton (no expiry / token / revocation), but a
 *  hand-crafted dataset can still land on `open()` — defensively, the
 *  three endpoint-id-bound prompts (`extend` / `rotate` / `revoke`)
 *  bail when `endpointId === RECEPTION_PAGE_SINGLETON_ENDPOINT_ID`.
 *
 *  DD#3 — Inline error rendering keeps the modal open on rpc failure.
 *  The shell's `run()` wraps every action: clears `last_error`, calls
 *  the rpc, captures + re-throws on failure. The page renderer
 *  surfaces `last_error` as a flash banner — but that's underneath the
 *  prompt modal, which on a thrown rpc would otherwise close silently
 *  and lose the user's typed input. The prompt mount catches the
 *  rejection, copies `err.message` into the modal's inline-error slot,
 *  and re-renders; the user can fix + retry without retyping.
 *
 *  DD#4 — Rotate-share registration looks up the kind from the loaded
 *  page model, not a separate seam. `rotateToken` returns only
 *  `{ bearer_secret_once, share_url_once }` — no `endpoint_id` / no
 *  `kind`. The page-shell already holds a loaded `page.sections[].rows`
 *  with `kind` + `expires_at` per row; the prompts host reads it. When
 *  the row is not found (the page never loaded, or the endpoint
 *  vanished from the list), the rotate still completes — the share
 *  registration is the part that gets skipped, and the user can re-open
 *  the prompt to re-rotate after refreshing.
 *
 *  DD#5 — Long-lived extend is gated on the same hard-ceiling table the
 *  authoring mount uses. `drop_link` / `approval_link` / `status_link`
 *  reject long-lived at the rpc layer; the prompts host disables the
 *  "Never expires" toggle for those kinds (looking the row up the same
 *  way DD#4 does for rotate). For `scheduling_link` / `intake_form` the
 *  toggle is enabled and `new_expires_at: null` flows through.
 *
 *  DD#6 — Emergency-disable phrase is a literal exported constant, not
 *  a substrate gate. The rpc itself does not require a phrase
 *  (`reception.emergency_disable_all` takes only an optional reason);
 *  the phrase gate exists purely as a client-side speed bump against an
 *  accidental click on a kill-switch button. The constant lives here so
 *  the test suite can assert the exact phrase + a future translation
 *  pass has one place to land.
 *
 *  DD#7 — Preserve the original expiry's time-of-day. `<input type="date">`
 *  is a yyyy-mm-dd surface; parsing back to epoch ms yields UTC midnight
 *  of that day. For an endpoint whose existing `expires_at` carries a
 *  time-of-day (e.g. 14:30 UTC), seeding `date_value` from the row +
 *  letting the user submit without editing would otherwise *shorten* the
 *  endpoint by up to ~24h (or, worse, push a still-future same-day
 *  expiry into the past and trip the substrate's `expires_at_in_past`
 *  validator). The state therefore tracks `original_expires_at` + a
 *  `date_edited` flag; submit uses the original epoch verbatim until the
 *  user touches the date input, at which point the typed yyyy-mm-dd
 *  becomes the source of truth.
 *
 *  DD#8 — Stale completions never touch a later modal. The in-flight rpc
 *  for prompt A can settle *after* the user cancelled A and opened a
 *  fresh prompt B. Without a guard, A's `.then` would call `close()` on
 *  B (dismissing it) or A's `.catch` would write A's error string into
 *  B's modal. Every submit captures a monotonic token; the success +
 *  rejection paths bail when the token no longer matches the current
 *  submit (state was reset by cancel / new open / dispose).
 *
 *  Spec: docs/d-149-spec.md § A.9 (Settings UX integration). */

import { e } from '@recued/ui-shared/template';
import { createActionDispatcher } from '@recued/ui-shared/action-dispatcher';
import {
  actionBar,
  button,
  inlineMessage,
  panel,
} from '@recued/ui-shared/primitives';

import {
  RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
  type ReceptionEndpointKind,
  type ReceptionEndpointRotateReason,
  type ShareCardsInput,
} from '@recued/contracts';

import {
  RECEPTION_KIND_COPY,
  computeExpiryLabel,
  type ReceptionEndpointRow,
} from './reception.js';
import type { ReceptionPageShell } from './reception-page-shell.js';
import type { ReceptionHostPromptAction } from './reception-page-host.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

// ════════════════════════════════════════════════════════════════
// Closed lists — prompt kinds + actions + rotate-reason copy
// ════════════════════════════════════════════════════════════════

/** Closed list of the four prompt kinds, one per host-prompt action. */
export const RECEPTION_PROMPT_KINDS = [
  'extend',
  'rotate',
  'revoke',
  'emergency-disable-all',
] as const;

export type ReceptionPromptKind = (typeof RECEPTION_PROMPT_KINDS)[number];

/** Action → kind map. Source of truth for the open() dispatcher. */
const PROMPT_KIND_FOR_ACTION: Readonly<
  Record<ReceptionHostPromptAction, ReceptionPromptKind>
> = {
  'reception-extend': 'extend',
  'reception-rotate-token': 'rotate',
  'reception-revoke': 'revoke',
  'reception-emergency-disable-all': 'emergency-disable-all',
};

/** Every `data-action` the prompts mount's dispatcher handles. */
export const RECEPTION_PROMPT_ACTIONS = [
  'reception-prompt-submit',
  'reception-prompt-cancel',
] as const;

export type ReceptionPromptAction = (typeof RECEPTION_PROMPT_ACTIONS)[number];

/** Closed list of `data-prompt-field` keys + their per-prompt-kind
 *  meanings. A small, hand-tracked union — saves carrying a second
 *  field-delegator across the surface. Each entry stays bounded:
 *  text-shaped values (date string / free-form reason / confirm
 *  phrase / select-value) are stored as strings in the working state,
 *  the toggle for never-expire stores a boolean. */
const PROMPT_FIELD_KEYS = [
  'expires_at_date', // extend: <input type="date"> ISO yyyy-mm-dd
  'never_expire', // extend: <input type="checkbox">
  'rotate_reason', // rotate: <select> over RotateReason ∪ ''
  'revoke_reason', // revoke: <textarea>, optional
  'disable_all_reason', // emergency-disable-all: <textarea>, optional
  'confirm_phrase', // emergency-disable-all: <input type="text">
] as const;
type PromptFieldKey = (typeof PROMPT_FIELD_KEYS)[number];

const PROMPT_FIELD_KEY_SET: ReadonlySet<string> = new Set(PROMPT_FIELD_KEYS);

const isPromptFieldKey = (value: string | undefined): value is PromptFieldKey =>
  value !== undefined && PROMPT_FIELD_KEY_SET.has(value);

/** The literal phrase the user types to confirm the irreversible
 *  emergency-disable-all kill switch (see DD#6). Exported so tests can
 *  assert the exact string + a future copy pass has one place to land. */
export const RECEPTION_EMERGENCY_DISABLE_CONFIRM_PHRASE = 'EMERGENCY DISABLE ALL';

/** Closed list of rotate reasons + their human copy. Mirrors the
 *  contract type — three reasons + a `''` "no reason" sentinel for the
 *  select's leading option. */
const ROTATE_REASON_OPTIONS: ReadonlyArray<{
  value: '' | ReceptionEndpointRotateReason;
  label: string;
}> = [
  { value: '', label: 'No reason given' },
  { value: 'lost_url', label: 'Lost the share URL' },
  { value: 'suspected_leak', label: 'Suspected leak / compromise' },
  { value: 'hygiene', label: 'Routine hygiene rotation' },
];

/** Kinds with a hard-ceiling expiry — they reject long-lived at the
 *  rpc layer. Mirrors `AUTHORING_HARD_CEILING_KINDS` in the authoring
 *  mount. Imported as a literal set here to avoid pulling the whole
 *  authoring-mount surface (the prompts host has zero other authoring
 *  deps). */
const HARD_CEILING_KINDS: ReadonlySet<ReceptionEndpointKind> = new Set([
  'drop_link',
  'approval_link',
  'status_link',
]);

// ════════════════════════════════════════════════════════════════
// Working state
// ════════════════════════════════════════════════════════════════

interface ExtendState {
  readonly prompt: 'extend';
  readonly endpoint_id: string;
  /** Resolved row from the loaded page model — null when the page hasn't
   *  loaded or the row vanished. Used for hard-ceiling detection (DD#5). */
  readonly row: ReceptionEndpointRow | null;
  /** The endpoint's existing expiry at mount time — kept separately from
   *  `date_value` so the submit path can preserve the time-of-day component
   *  when the user has not edited the date input (DD#7). `null` for a
   *  currently-long-lived endpoint or a missing row. */
  readonly original_expires_at: number | null;
  date_value: string;
  /** True once the user has edited the date input. Until then, submit
   *  uses `original_expires_at` verbatim rather than `Date.parse(date_value)`
   *  to avoid shortening an existing expiry to UTC midnight (DD#7). */
  date_edited: boolean;
  never_expire: boolean;
  error: string | null;
}

interface RotateState {
  readonly prompt: 'rotate';
  readonly endpoint_id: string;
  reason: '' | ReceptionEndpointRotateReason;
  error: string | null;
}

interface RevokeState {
  readonly prompt: 'revoke';
  readonly endpoint_id: string;
  reason: string;
  error: string | null;
}

interface EmergencyDisableState {
  readonly prompt: 'emergency-disable-all';
  reason: string;
  confirm_phrase: string;
  error: string | null;
}

type PromptState =
  | ExtendState
  | RotateState
  | RevokeState
  | EmergencyDisableState;

// ════════════════════════════════════════════════════════════════
// Date-input helpers
// ════════════════════════════════════════════════════════════════

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse an `<input type="date">` value (yyyy-mm-dd) into a UTC midnight
 *  epoch ms timestamp. Returns null for an empty / malformed value.
 *  The server-side validators expect a future epoch ms — the date input
 *  is the user's local calendar date, but the prompt promises only that
 *  the chosen day is in the future; UTC midnight is the simplest
 *  unambiguous epoch (the substrate cares about ordering against
 *  `now`, not local TZ semantics). */
const parseDateInputToEpochMs = (value: string): number | null => {
  if (value === '') return null;
  // `Date.parse('yyyy-mm-dd')` returns UTC midnight for a valid date,
  // NaN otherwise — narrower than `new Date(value)` and avoids the
  // local-TZ surprise of the constructor.
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Format an epoch ms into a yyyy-mm-dd UTC date string — the inverse
 *  of `parseDateInputToEpochMs` for prefilling the date input when an
 *  endpoint already has an `expires_at`. */
const formatEpochMsAsDateInput = (epoch_ms: number): string => {
  const d = new Date(epoch_ms);
  // toISOString() is utc → ymd is the substring before 'T'.
  return d.toISOString().slice(0, 10);
};

// ════════════════════════════════════════════════════════════════
// Page-state helpers
// ════════════════════════════════════════════════════════════════

/** Look up a row by endpoint_id from the shell's loaded page model.
 *  Returns null when the page hasn't loaded, the endpoint vanished, or
 *  the id maps to the singleton (the prompts host never opens for the
 *  singleton — see DD#2). */
const lookupRow = (
  shell: ReceptionPageShell,
  endpoint_id: string,
): ReceptionEndpointRow | null => {
  if (endpoint_id === RECEPTION_PAGE_SINGLETON_ENDPOINT_ID) return null;
  const page = shell.getState().page;
  if (page === null) return null;
  for (const section of page.sections) {
    for (const row of section.rows) {
      if (row.endpoint_id === endpoint_id) return row;
    }
  }
  return null;
};

/** Compose a `ShareCardsInput` for a rotate-token result — the per-kind
 *  copy + the existing row's `expires_at` (rotate does not change the
 *  expiry). Pure — no I/O. Mirrors the page host's create-side
 *  `buildShareInputForCreate` shape so the substrate carries one
 *  share-card layout across both flows. */
const composeRotateShareInput = (
  row: ReceptionEndpointRow,
  share_url: string,
  now: number,
): ShareCardsInput => {
  const copy = RECEPTION_KIND_COPY[row.kind];
  const expiry_note =
    row.expires_at !== null ? computeExpiryLabel(row.expires_at, now) : undefined;
  return {
    share_url,
    title: `Your rotated ${copy.singular}`,
    description: copy.description,
    ...(expiry_note !== undefined ? { expiry_note } : {}),
  };
};

// ════════════════════════════════════════════════════════════════
// Render helpers
// ════════════════════════════════════════════════════════════════

const renderInlineError = (message: string | null): string =>
  message === null ? '' : inlineMessage({ tone: 'error', message });

const renderActionBar = (submitLabel: string, submitVariant: 'primary' | 'danger'): string =>
  actionBar({
    gap: 8,
    bordered: true,
    children: [
      button({
        label: 'Cancel',
        size: 'sm',
        action: 'reception-prompt-cancel',
      }),
      button({
        label: submitLabel,
        size: 'sm',
        variant: submitVariant,
        action: 'reception-prompt-submit',
      }),
    ],
  });

const renderExtendForm = (state: ExtendState): string => {
  // Hard-ceiling kinds reject long-lived — disable the never-expire
  // toggle (DD#5). When the row is unknown, default to *not* hard-
  // ceiling so the toggle stays usable; the server still re-checks.
  const isHardCeiling =
    state.row !== null && HARD_CEILING_KINDS.has(state.row.kind);
  const neverChecked = state.never_expire && !isHardCeiling;
  const dateDisabled = neverChecked ? 'disabled' : '';
  const neverDisabled = isHardCeiling ? 'disabled' : '';
  const ceilingHint = isHardCeiling
    ? `<p class="rx-msg rx-msg-hint">This endpoint kind carries a hard expiry ceiling — long-lived is not permitted.</p>`
    : '';
  const body = `
    <p class="rx-msg rx-msg-hint">Pick a new expiry date for <code>${e(state.endpoint_id)}</code>.</p>
    <div class="reception-prompt-field">
      <label class="reception-prompt-label">New expiry</label>
      <input class="reception-prompt-input"
             type="date"
             data-prompt-field="expires_at_date"
             value="${e(state.date_value)}"
             ${dateDisabled}
             aria-label="New expiry date" />
    </div>
    <label class="reception-prompt-toggle">
      <input type="checkbox"
             data-prompt-field="never_expire"
             ${neverChecked ? 'checked' : ''}
             ${neverDisabled} />
      <span>Never expires (long-lived)</span>
    </label>
    ${ceilingHint}
    ${renderInlineError(state.error)}
    ${renderActionBar('Extend', 'primary')}
  `;
  return panel({ tone: 'neutral', title: 'Extend endpoint', body });
};

const renderRotateForm = (state: RotateState): string => {
  const options = ROTATE_REASON_OPTIONS.map(
    (opt) =>
      `<option value="${e(opt.value)}"${opt.value === state.reason ? ' selected' : ''}>${e(opt.label)}</option>`,
  ).join('');
  const body = `
    <p class="rx-msg rx-msg-hint">Rotating mints a fresh share URL and invalidates the previous one immediately. The new URL is shown once on success — capture it before closing the next prompt.</p>
    <div class="reception-prompt-field">
      <label class="reception-prompt-label">Reason</label>
      <select class="reception-prompt-input"
              data-prompt-field="rotate_reason"
              aria-label="Rotation reason">
        ${options}
      </select>
    </div>
    ${renderInlineError(state.error)}
    ${renderActionBar('Rotate token', 'primary')}
  `;
  return panel({ tone: 'neutral', title: 'Rotate token', body });
};

const renderRevokeForm = (state: RevokeState): string => {
  const body = `
    <p class="rx-msg rx-msg-warn">Revoking is irreversible. The endpoint and its share URL stop working immediately; the access log is preserved for forensics.</p>
    <div class="reception-prompt-field">
      <label class="reception-prompt-label">Reason (optional)</label>
      <textarea class="reception-prompt-input reception-prompt-textarea"
                data-prompt-field="revoke_reason"
                rows="3"
                aria-label="Revocation reason">${e(state.reason)}</textarea>
    </div>
    ${renderInlineError(state.error)}
    ${renderActionBar('Revoke', 'danger')}
  `;
  return panel({ tone: 'danger', title: 'Revoke endpoint', body });
};

const renderEmergencyDisableForm = (state: EmergencyDisableState): string => {
  // Note: the renderer deliberately does NOT live-show a "phrase doesn't
  // match yet" hint while the user is typing. Re-rendering on every
  // keystroke would steal focus from the input (every webclient re-render
  // rebuilds `innerHTML`, same focus cost the authoring mount documents).
  // The submit gate surfaces the mismatch via the inline error slot once
  // the user clicks the button.
  const body = `
    <p class="rx-msg rx-msg-warn">Emergency-disable-all flips a server-wide kill switch — every Reception endpoint stops serving immediately. You can re-enable from this page; until then visitors see the page as offline.</p>
    <div class="reception-prompt-field">
      <label class="reception-prompt-label">Reason (optional)</label>
      <textarea class="reception-prompt-input reception-prompt-textarea"
                data-prompt-field="disable_all_reason"
                rows="2"
                aria-label="Disable-all reason">${e(state.reason)}</textarea>
    </div>
    <div class="reception-prompt-field">
      <label class="reception-prompt-label">Type <code>${e(RECEPTION_EMERGENCY_DISABLE_CONFIRM_PHRASE)}</code> to confirm</label>
      <input class="reception-prompt-input"
             type="text"
             data-prompt-field="confirm_phrase"
             value="${e(state.confirm_phrase)}"
             aria-label="Confirmation phrase" />
    </div>
    ${renderInlineError(state.error)}
    ${renderActionBar('Disable all', 'danger')}
  `;
  return panel({
    tone: 'danger',
    title: 'Emergency: disable Reception?',
    body,
  });
};

const renderPrompt = (state: PromptState): string => {
  switch (state.prompt) {
    case 'extend':
      return renderExtendForm(state);
    case 'rotate':
      return renderRotateForm(state);
    case 'revoke':
      return renderRevokeForm(state);
    case 'emergency-disable-all':
      return renderEmergencyDisableForm(state);
  }
};

// ════════════════════════════════════════════════════════════════
// Mount options + handle
// ════════════════════════════════════════════════════════════════

/** Options for `mountReceptionPromptsHost`. */
export interface ReceptionPromptsHostOptions {
  /** Host element where the modal renders. Cleared on close + dispose;
   *  the listeners stay attached for the host's full lifetime so any
   *  click after a re-render still dispatches (the click delegator is
   *  re-render-survivable, same as every other mount in this layer). */
  host: HTMLElement;
  /** The page shell — the prompts fire `extendEndpoint` / `rotateToken`
   *  / `revokeEndpoint` / `emergencyDisableAll` through this. */
  shell: ReceptionPageShell;
  /** Clock seam — defaults to `Date.now`. Threaded into the share-card
   *  composition for rotate-token success (the expiry-note copy). */
  now?: () => number;
  /** Optional close callback — fires once per modal close (success +
   *  cancel). The consumer typically uses this to repaint surrounding
   *  layout or refocus the page mount; the prompts host owns its own
   *  modal lifecycle so the callback is purely informational. */
  onClose?: (kind: ReceptionPromptKind) => void;
}

/** Mounted prompts-host handle. */
export interface ReceptionPromptsHost {
  /** Open the appropriate prompt modal for one of the four host-prompt
   *  actions. No-op when:
   *    - the action is not one of the four (defensive); or
   *    - the endpoint-id-bound prompts (`extend` / `rotate` / `revoke`)
   *      have a missing or singleton `endpointId` in the dataset
   *      (DD#2 — singleton has no expiry / token / revocation);
   *    - the host has been disposed.
   *
   *  Opening a prompt while another is open replaces it (the user
   *  cancelled the prior implicitly). The new modal seeds fresh state. */
  open(action: ReceptionHostPromptAction, dataset: DOMStringMap): void;
  /** Close the open prompt without firing the rpc. No-op when no
   *  prompt is open. */
  close(): void;
  /** Detach the listeners + clear the host. Idempotent. */
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// mountReceptionPromptsHost
// ════════════════════════════════════════════════════════════════

export const mountReceptionPromptsHost = (
  opts: ReceptionPromptsHostOptions,
): ReceptionPromptsHost => {
  const { host, shell } = opts;
  const now = opts.now ?? ((): number => Date.now());

  let state: PromptState | null = null;
  let disposed = false;
  let lastHtml = '';

  const render = (): void => {
    if (disposed) return;
    const html = state === null ? '' : renderPrompt(state);
    if (html === lastHtml) return;
    host.innerHTML = html;
    lastHtml = html;
  };

  const close = (): void => {
    if (state === null) return;
    const closing = state.prompt;
    state = null;
    // Invalidate any in-flight rpc — its completion handler bails on
    // the token mismatch (DD#8). Same logic applies on `open()` +
    // `dispose()` below; everywhere `state` is reset, the token ticks.
    submitToken += 1;
    render();
    opts.onClose?.(closing);
  };

  const swallow = (promise: Promise<unknown>, onError: (message: string) => void): void => {
    void promise.catch((err: unknown) => {
      const message = humanizeRpcError(err);
      onError(message);
    });
  };

  const setError = (message: string): void => {
    if (state === null) return;
    switch (state.prompt) {
      case 'extend':
        state = { ...state, error: message };
        break;
      case 'rotate':
        state = { ...state, error: message };
        break;
      case 'revoke':
        state = { ...state, error: message };
        break;
      case 'emergency-disable-all':
        state = { ...state, error: message };
        break;
    }
    // Force a re-render — a same-state lastHtml dedup would suppress an
    // identical re-failure with the same message string.
    lastHtml = '';
    render();
  };

  // ── Field-input capture ────────────────────────────────────────
  // A small delegated listener — the prompts use a private
  // `data-prompt-field` namespace to stay isolated from the authoring
  // mount's `data-field-*` machinery. Mirrors the de-dupe gate in
  // `attachFieldDelegator`: a `<select>` fires both `input` + `change`,
  // so the listener only acts on the control's natural commit event.

  const resolveCommitEvent = (target: {
    tagName?: string;
    type?: string;
  }): 'input' | 'change' => {
    if (target.tagName === 'SELECT') return 'change';
    if (target.tagName === 'INPUT' && target.type === 'checkbox') return 'change';
    return 'input';
  };

  const onFieldEvent = (event: Event): void => {
    if (state === null) return;
    const target = event.target as
      | (HTMLElement & { value?: string; checked?: boolean; type?: string })
      | null;
    if (target === null) return;
    const el = target.closest<HTMLElement & { value?: string; checked?: boolean; type?: string }>(
      '[data-prompt-field]',
    );
    if (el === null || !host.contains(el)) return;
    if (resolveCommitEvent(el) !== event.type) return;
    const key = el.dataset.promptField;
    if (!isPromptFieldKey(key)) return;
    const value = el.value ?? '';
    const checked = el.checked ?? false;
    applyFieldEdit(key, value, checked);
  };

  /** Apply one delegated field edit. Mutates `state`; re-renders only
   *  for the toggle path (changes the date input's disabled state).
   *  Pure text edits (date / reason / phrase) stay silent so the user
   *  does not lose focus mid-typing — every webclient re-render rebuilds
   *  `innerHTML`, same focus cost the authoring mount documents. Any
   *  stale inline error on the modal is cleared when the toggle drives
   *  a re-render anyway; otherwise it stays visible until the next
   *  submit retry repaints it. */
  const applyFieldEdit = (
    key: PromptFieldKey,
    value: string,
    checked: boolean,
  ): void => {
    if (state === null) return;
    let needsRender = false;
    switch (state.prompt) {
      case 'extend':
        if (key === 'expires_at_date') {
          // DD#7 — every edit (including clearing the field) flips
          // `date_edited` so submit no longer treats the seeded date as
          // a verbatim representation of the original expiry's epoch.
          state = { ...state, date_value: value, date_edited: true };
        } else if (key === 'never_expire') {
          state = { ...state, never_expire: checked };
          needsRender = true;
        } else {
          return;
        }
        break;
      case 'rotate':
        if (key === 'rotate_reason') {
          if (
            value === '' ||
            value === 'lost_url' ||
            value === 'suspected_leak' ||
            value === 'hygiene'
          ) {
            state = { ...state, reason: value };
          }
        } else {
          return;
        }
        break;
      case 'revoke':
        if (key === 'revoke_reason') {
          state = { ...state, reason: value };
        } else {
          return;
        }
        break;
      case 'emergency-disable-all':
        if (key === 'disable_all_reason') {
          state = { ...state, reason: value };
        } else if (key === 'confirm_phrase') {
          state = { ...state, confirm_phrase: value };
        } else {
          return;
        }
        break;
    }
    if (needsRender) {
      // Clear any stale inline error so the re-render does not re-show
      // it — same discipline as the authoring mount's validation-summary
      // clear on first edit after a failed submit.
      if (state.error !== null) {
        state = clearError(state);
      }
      render();
    }
  };

  /** Narrow-preserving error clear — spreading the union directly
   *  forces TS into a type-assertion since the spread loses the
   *  discriminator literal. Switching by `prompt` keeps each branch's
   *  literal intact. */
  const clearError = (s: PromptState): PromptState => {
    switch (s.prompt) {
      case 'extend':
        return { ...s, error: null };
      case 'rotate':
        return { ...s, error: null };
      case 'revoke':
        return { ...s, error: null };
      case 'emergency-disable-all':
        return { ...s, error: null };
    }
  };

  host.addEventListener('input', onFieldEvent);
  host.addEventListener('change', onFieldEvent);

  // ── Action handlers ────────────────────────────────────────────

  /** Monotonic token for every in-flight rpc. Incremented on each
   *  submit; the success / failure paths bail when the captured token
   *  no longer matches the live counter (the user cancelled + opened
   *  another prompt before the rpc settled — DD#8). The counter also
   *  ticks on every `close()` / `open()` / `dispose()` so an open
   *  → submit → cancel → open sequence (without a new submit) still
   *  invalidates the stale completion. */
  let submitToken = 0;
  const nextToken = (): number => {
    submitToken += 1;
    return submitToken;
  };

  const handleSubmit = (): void => {
    if (state === null) return;
    const myToken = nextToken();
    // Guard a success completion: ignore if the user cancelled / opened
    // another prompt while the rpc was in flight (DD#8).
    const onSettled = (apply: () => void): void => {
      if (myToken !== submitToken) return;
      apply();
    };
    const onFailure = (message: string): void => {
      if (myToken !== submitToken) return;
      setError(message);
    };
    switch (state.prompt) {
      case 'extend': {
        const isHardCeiling =
          state.row !== null && HARD_CEILING_KINDS.has(state.row.kind);
        const wantsLongLived = state.never_expire && !isHardCeiling;
        let new_expires_at: number | null = null;
        if (!wantsLongLived) {
          // DD#7 — until the user touches the date input, the seeded
          // yyyy-mm-dd is just a display projection of `original_expires_at`;
          // re-parsing it would shift the epoch to UTC midnight + shorten
          // the endpoint. Submit the original verbatim until edited.
          if (!state.date_edited && state.original_expires_at !== null) {
            new_expires_at = state.original_expires_at;
          } else {
            const parsed = parseDateInputToEpochMs(state.date_value);
            if (parsed === null) {
              setError('Pick a valid expiry date.');
              return;
            }
            // The substrate rejects past expiries; pre-check here so the
            // user sees the message inside the modal without a round-trip.
            if (parsed <= now()) {
              setError('Expiry date must be in the future.');
              return;
            }
            new_expires_at = parsed;
          }
        }
        const endpoint_id = state.endpoint_id;
        swallow(
          shell.extendEndpoint(endpoint_id, new_expires_at).then(() => {
            onSettled(close);
          }),
          onFailure,
        );
        return;
      }
      case 'rotate': {
        const endpoint_id = state.endpoint_id;
        const reason = state.reason;
        const callReason = reason === '' ? undefined : reason;
        swallow(
          shell.rotateToken(endpoint_id, callReason).then((result) => {
            onSettled(() => {
              // DD#4 — look the row up to compose the per-kind share
              // card. A missing row (page never loaded, or endpoint
              // vanished mid-flight) means we skip the registration; the
              // rotate still completes.
              const row = lookupRow(shell, endpoint_id);
              if (row !== null) {
                shell.setEndpointShare(
                  endpoint_id,
                  composeRotateShareInput(row, result.share_url_once, now()),
                );
              }
              close();
            });
          }),
          onFailure,
        );
        return;
      }
      case 'revoke': {
        const endpoint_id = state.endpoint_id;
        const reason = state.reason.trim();
        swallow(
          shell
            .revokeEndpoint(endpoint_id, reason === '' ? undefined : reason)
            .then(() => {
              onSettled(close);
            }),
          onFailure,
        );
        return;
      }
      case 'emergency-disable-all': {
        if (state.confirm_phrase !== RECEPTION_EMERGENCY_DISABLE_CONFIRM_PHRASE) {
          setError(
            `Type "${RECEPTION_EMERGENCY_DISABLE_CONFIRM_PHRASE}" exactly to confirm.`,
          );
          return;
        }
        const reason = state.reason.trim();
        swallow(
          shell
            .emergencyDisableAll(reason === '' ? undefined : reason)
            .then(() => {
              onSettled(close);
            }),
          onFailure,
        );
        return;
      }
    }
  };

  const handlers = {
    'reception-prompt-submit': handleSubmit,
    'reception-prompt-cancel': close,
  } satisfies Record<ReceptionPromptAction, (dataset: DOMStringMap) => void>;

  const detachActions = createActionDispatcher<ReceptionPromptAction>({
    root: host,
    handlers,
  });

  // ── open() dispatch ────────────────────────────────────────────

  /** Seed the working state for `extend`. Looks the row up so the
   *  date input prefills with the existing expiry + the hard-ceiling
   *  kinds disable the long-lived toggle. The original epoch (with its
   *  time-of-day component) is preserved alongside the yyyy-mm-dd date
   *  string so an un-edited submit can re-use it verbatim (DD#7). */
  const seedExtend = (endpoint_id: string): ExtendState | null => {
    if (endpoint_id === RECEPTION_PAGE_SINGLETON_ENDPOINT_ID) return null;
    const row = lookupRow(shell, endpoint_id);
    const original_expires_at = row !== null ? row.expires_at : null;
    const date_value =
      original_expires_at !== null
        ? formatEpochMsAsDateInput(original_expires_at)
        : formatEpochMsAsDateInput(now() + DAY_MS);
    const never_expire = row !== null && row.expires_at === null;
    return {
      prompt: 'extend',
      endpoint_id,
      row,
      original_expires_at,
      date_value,
      date_edited: false,
      never_expire,
      error: null,
    };
  };

  const seedRotate = (endpoint_id: string): RotateState | null => {
    if (endpoint_id === RECEPTION_PAGE_SINGLETON_ENDPOINT_ID) return null;
    return { prompt: 'rotate', endpoint_id, reason: '', error: null };
  };

  const seedRevoke = (endpoint_id: string): RevokeState | null => {
    if (endpoint_id === RECEPTION_PAGE_SINGLETON_ENDPOINT_ID) return null;
    return { prompt: 'revoke', endpoint_id, reason: '', error: null };
  };

  const seedEmergencyDisable = (): EmergencyDisableState => ({
    prompt: 'emergency-disable-all',
    reason: '',
    confirm_phrase: '',
    error: null,
  });

  const open = (
    action: ReceptionHostPromptAction,
    dataset: DOMStringMap,
  ): void => {
    if (disposed) return;
    const kind = PROMPT_KIND_FOR_ACTION[action];
    if (kind === undefined) return;
    let next: PromptState | null = null;
    switch (kind) {
      case 'extend': {
        const endpoint_id = dataset.endpointId;
        if (endpoint_id === undefined) return;
        next = seedExtend(endpoint_id);
        break;
      }
      case 'rotate': {
        const endpoint_id = dataset.endpointId;
        if (endpoint_id === undefined) return;
        next = seedRotate(endpoint_id);
        break;
      }
      case 'revoke': {
        const endpoint_id = dataset.endpointId;
        if (endpoint_id === undefined) return;
        next = seedRevoke(endpoint_id);
        break;
      }
      case 'emergency-disable-all':
        next = seedEmergencyDisable();
        break;
    }
    if (next === null) return;
    // Invalidate any in-flight rpc from a prior prompt (DD#8). Even if
    // this open() replaces the same prompt kind, the new modal is a
    // fresh form and the prior submit's completion must not touch it.
    submitToken += 1;
    state = next;
    // A consecutive open() of the same prompt kind would otherwise be
    // dedup-suppressed by `lastHtml`; force the render so the seed
    // state's freshly prefilled values surface.
    lastHtml = '';
    render();
  };

  return {
    open,
    close,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // Invalidate any in-flight rpc completion (DD#8) — the modal is
      // gone, the host listeners are about to detach, and the success
      // path's call into `setEndpointShare` / `close` would otherwise
      // race the teardown.
      submitToken += 1;
      detachActions();
      host.removeEventListener('input', onFieldEvent);
      host.removeEventListener('change', onFieldEvent);
      state = null;
      host.innerHTML = '';
      lastHtml = '';
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Styles — minimal additive layer atop the shared primitive styles.
// The panel / button / action-bar / inline-message primitives carry
// their own styles; this only adds the small layout for the per-prompt
// label + input rows.
// ════════════════════════════════════════════════════════════════

export const RECEPTION_PROMPTS_HOST_STYLES = `
.reception-prompt-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
}
.reception-prompt-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg);
}
.reception-prompt-input {
  font: inherit;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--fg);
  width: 100%;
  box-sizing: border-box;
}
.reception-prompt-input:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}
.reception-prompt-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.reception-prompt-textarea {
  resize: vertical;
  min-height: 60px;
  font-family: inherit;
}
.reception-prompt-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  margin-bottom: 12px;
  cursor: pointer;
}
`;
