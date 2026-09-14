/** Settings → Learning (D-219 slice 9c).
 *
 *  One control: whether Recued asks, after a turn where it worked through
 *  several steps, how the result turned out. That answer is the ONLY thing that
 *  becomes precedent — the substrate stopped counting its own account of a turn
 *  in D-219 — so this toggle is the tap for everything the AI learns from you.
 *
 *  Persisted as the per-pair `chat.execution_case_offer` instance pref
 *  (`prefs.get` / `prefs.set` pair rpc), like the Transparency panel next door.
 *
 *  ── Key design decisions (READ before touching) ────────────────────
 *
 *  DD#1 — Caller seams are narrow Promise functions (`runPrefsGet` /
 *  `runPrefsSet`), mirroring `transparency-panel.ts` / `notifications-panel.ts`.
 *  The bootstrap wires the pair rpc conn through thunks; tests inject fakes.
 *
 *  DD#2 — Render-on-transition rebuild via `createElement`, same as the sibling
 *  panels. Every state change rebuilds the panel's inner DOM; no diffing.
 *
 *  DD#3 — Saves are authoritative: one change → one single-key `prefs.set`, the
 *  control is ARIA-locked while in flight, and the response's merged `prefs`
 *  replaces local state. The server is the source of truth.
 *
 *  DD#4 — ⚠ THE COPY SAYS THE PREF IS NOT PER-DEVICE, because it isn't in
 *  effect. Prefs are stored per paired instance, but the ask is raised ONCE by
 *  the server and fanned out by the notification block, so the server resolves
 *  the roster off-anywhere-wins: turning this off here stops the question on
 *  every device. Hiding that would make the row a lie on the second device.
 */

import type {
  ExecutionCaseLearnedEntry,
  InstancePrefs,
} from '@recued/contracts';
import { getPref } from '@recued/contracts';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

// ════════════════════════════════════════════════════════════════
// Attribute constants — stable hooks for DOM tests + host introspection
// ════════════════════════════════════════════════════════════════

export const LEARNING_PANEL_HOST_ATTR = 'data-recued-learning-panel';
/** The offer toggle; the attribute VALUE is the pref key. */
export const LEARNING_PANEL_TOGGLE_ATTR = 'data-recued-learning-toggle';
export const LEARNING_PANEL_ERROR_ATTR = 'data-recued-learning-error';
/** Muted note shown while the ask is off. */
export const LEARNING_PANEL_OFF_HINT_ATTR = 'data-recued-learning-off-hint';
/** D-219 item 2 — the learned-case list container. */
export const LEARNING_PANEL_CASES_ATTR = 'data-recued-learning-cases';
/** One learned case; the attribute VALUE is its case id. */
export const LEARNING_PANEL_CASE_ATTR = 'data-recued-learning-case';
/** Marks a case that is stored but currently reaches no model. */
export const LEARNING_PANEL_CASE_INERT_ATTR = 'data-recued-learning-case-inert';
/** The per-case forget control; the attribute VALUE is its case id. */
export const LEARNING_PANEL_FORGET_ATTR = 'data-recued-learning-forget';
/** A failed Forget belongs to its case and leaves that case actionable. */
export const LEARNING_PANEL_FORGET_ERROR_ATTR =
  'data-recued-learning-forget-error';
export const LEARNING_PANEL_CASES_EMPTY_ATTR =
  'data-recued-learning-cases-empty';
export const LEARNING_PANEL_CASES_ERROR_ATTR =
  'data-recued-learning-cases-error';
/** D-219 item 2b — the per-case "make a recipe" control. */
export const LEARNING_PANEL_DRAFT_ATTR = 'data-recued-learning-draft';
/** D-219 — "you already made a recipe from this"; VALUE is the case id. */
export const LEARNING_PANEL_CASE_AUTHORED_ATTR =
  'data-recued-learning-case-authored';
/** The confirmation shown before the expensive call, never skipped. */
export const LEARNING_PANEL_DRAFT_CONFIRM_ATTR =
  'data-recued-learning-draft-confirm';
/** The owner's optional instruction for the draft. */
export const LEARNING_PANEL_DRAFT_PROMPT_ATTR =
  'data-recued-learning-draft-prompt';
export const LEARNING_PANEL_DRAFT_ERROR_ATTR =
  'data-recued-learning-draft-error';

// ════════════════════════════════════════════════════════════════
// Caller seams + handle
// ════════════════════════════════════════════════════════════════

export type LearningPrefsGetCaller = () => Promise<{ prefs: InstancePrefs }>;
export type LearningPrefsSetCaller = (args: {
  patch: Partial<InstancePrefs>;
}) => Promise<{ prefs: InstancePrefs }>;

/** D-219 item 2. Optional as a PAIR: a host that wires neither renders exactly
 *  the panel that shipped with 9c. ⛔ Never wire only the list — a page that
 *  shows what was learned and cannot unlearn it is worse than one that shows
 *  nothing, because it reads as a control surface and is not one. */
export type LearningCasesListCaller =
  () => Promise<{ cases: ExecutionCaseLearnedEntry[] }>;
export type LearningCaseForgetCaller = (args: {
  case_id: string;
}) => Promise<{ removed: boolean; cases_remaining: number }>;

/** ⛔ The draft rpc needs its OWN timeout. `WEBCLIENT_RPC_DEFAULT_TIMEOUT_MS`
 *  is 30s, sized for local reads — this call waits on the owner's model writing
 *  a whole recipe, which on a reasoning model runs well past that. A live run
 *  on 2026-07-29 lost a completed draft exactly at 30s: the server finished,
 *  the client had already given up, the owner saw "Your server isn't responding
 *  right now" and had paid for nothing.
 *
 *  ⚠ 3 minutes is deliberately generous and still BOUNDED. The failure this
 *  prevents (paying for a draft and being told the server is down) is much
 *  worse than the one it risks (waiting a while for a slow model), and the
 *  button says "Asking your AI..." throughout so the wait is legible. */
export const LEARNING_DRAFT_RPC_TIMEOUT_MS = 180_000;

/** D-219 item 2b. ⛔ Wired as a PAIR with `onDraftReady`: a Generate control
 *  that produces a draft nothing then opens is a dead end, and an expensive one.
 *  The panel never routes — it hands the draft back and the shell decides where
 *  it goes, which keeps the Kitchen out of a Settings panel's concerns. */
export type LearningDraftRecipeCaller = (args: {
  case_id: string;
  prompt: string;
}) => Promise<{
  ok: boolean;
  recipe?: unknown;
  issues: string[];
  reason?: string;
  request_aliased?: boolean;
}>;

export interface MountLearningPanelOptions {
  host: HTMLElement;
  document: Document;
  runPrefsGet: LearningPrefsGetCaller;
  runPrefsSet: LearningPrefsSetCaller;
  runCasesList?: LearningCasesListCaller;
  runCaseForget?: LearningCaseForgetCaller;
  runDraftRecipe?: LearningDraftRecipeCaller;
  /** Called with the unsaved draft. The shell opens the Kitchen on it. */
  /** ⛔ Returns false when the hand-off could not be completed (no storage, a
   *  full quota). The panel then SAYS SO rather than clearing the draft into
   *  nothing — an earlier version returned void and the shell's silent `return`
   *  discarded a draft the owner had just paid for, with no error anywhere. */
  onDraftReady?: (draft: {
    case_id: string;
    recipe: unknown;
    request_aliased: boolean;
  }) => boolean | void;
  /** ⛔ Server-owned copy (`RECIPE_DRAFT_CONFIRMATION`), threaded rather than
   *  restated here — a surface must not be able to quietly soften what the
   *  owner is agreeing to. */
  draftConfirmation?: string;
}

export interface LearningPanelState {
  phase: 'loading' | 'ready' | 'error';
  /** Authoritative merged prefs from the last get/set response. */
  prefs: InstancePrefs | null;
  saving: boolean;
  /** Load failure (phase 'error') or save failure (phase 'ready'). */
  error: string | null;
  /** D-219 item 2 — null while the list is unwired or still loading. */
  cases: ExecutionCaseLearnedEntry[] | null;
  casesError: string | null;
  /** The case id whose Forget is ARMED (tapped once), or null. */
  armed: string | null;
  /** The case id currently being forgotten, or null. */
  forgetting: string | null;
  /** A failed Forget stays beside its case instead of replacing the list. */
  forgetError: { case_id: string; message: string } | null;
  /** D-219 item 2b — the case whose Generate is ARMED (confirmation shown). */
  draftArmed: string | null;
  /** The case a draft is being generated for, or null. */
  drafting: string | null;
  /** ⚠ Carries its CASE id: the panel renders one node per case, so a bare
   *  message would appear under every one of them. */
  draftError: { case_id: string; message: string } | null;
}

export interface LearningPanelMount {
  getState(): LearningPanelState;
  /** User-started preference, Forget, or recipe-draft work that has not
   *  settled. The synchronous Kitchen handoff is deliberately excluded. */
  hasInFlightWork(): boolean;
  /** A finished, already-paid-for recipe draft whose local Kitchen handoff
   *  failed and would be lost if this panel were torn down. */
  hasUnsavedChanges(): boolean;
  whenLoaded(): Promise<void>;
  whenSaveSettled(): Promise<void>;
  whenForgetSettled(): Promise<void>;
  whenDraftSettled(): Promise<void>;
  dispose(): void;
}

const OFFER_PREF = 'chat.execution_case_offer' as const;

const OFFER_LABEL = 'Ask how it went when Recued did several things';
const DRAFT_HANDOFF_ERROR =
  'Your AI finished the Recipe, but this browser could not pass it to the '
  + 'Kitchen, because there is no room to save it. The finished draft is still '
  + 'on this page. Make some room, then choose Open finished draft. That '
  + 'only passes it over again. It does not ask your AI, and it does not cost you anything '
  + 'again.';
/** ⛔ "the only thing it learns from" WAS NOT TRUE, and this is owner-facing
 *  PRIVACY copy, which is the worst place to overclaim. A Codex audit on
 *  2026-07-29 found it: `verification_pass` / `verification_fail` are both in
 *  `strongKinds`, and a deterministic verifier is composed in production — so a
 *  checked outcome becomes precedent without the owner answering anything.
 *
 *  ⚠ The claim it REPLACES is still worth making, because it is the real
 *  guarantee and it is unusual: Recued does not count the AI's own account of
 *  how a turn went. Say that, and name the other source instead of implying
 *  there is none. */
const OFFER_DETAIL =
  'When Recued takes several steps to answer you, it asks whether '
  + 'it got it right. It never takes its own word for it. It only counts '
  + 'what you say, or something it can check for itself. This is the same on '
  + 'every device. You are asked once, not once per screen.';

export const mountLearningPanel = (
  opts: MountLearningPanelOptions,
): LearningPanelMount => {
  const doc = opts.document;
  let disposed = false;
  let state: LearningPanelState = {
    phase: 'loading',
    prefs: null,
    saving: false,
    error: null,
    cases: null,
    casesError: null,
    armed: null,
    forgetting: null,
    forgetError: null,
    draftArmed: null,
    drafting: null,
    draftError: null,
  };
  let pendingLoad: Promise<void> = Promise.resolve();
  let pendingSave: Promise<void> | null = null;
  let pendingForget: Promise<void> | null = null;
  let pendingDraft: Promise<void> | null = null;
  // ⚠ Held OUTSIDE `state`, because every state change rebuilds the panel's DOM
  // (DD#2) and a textarea rebuilt from state would lose the caret on each
  // keystroke. The value is read back at press time.
  const drafts = new Map<string, string>();
  const retainedDrafts = new Map<string, {
    case_id: string;
    recipe: unknown;
    request_aliased: boolean;
  }>();
  let draftHandoffInProgress = false;
  let pendingOfferValue: boolean | null = null;
  const promptFor = (case_id: string): string => drafts.get(case_id) ?? '';

  opts.host.setAttribute(LEARNING_PANEL_HOST_ATTR, '');

  const clearChildren = (node: HTMLElement): void => {
    while (node.firstChild) node.removeChild(node.firstChild);
  };

  const toggleHasFocus = (): boolean => {
    const active = (doc as Document & { activeElement?: Element | null })
      .activeElement;
    return active?.hasAttribute?.(LEARNING_PANEL_TOGGLE_ATTR) === true;
  };

  const focusToggle = (): void => {
    const toggle = opts.host.querySelector?.(
      `[${LEARNING_PANEL_TOGGLE_ATTR}]`,
    ) as HTMLElement | null | undefined;
    toggle?.focus?.();
  };

  const elementHasFocus = (attribute: string, value?: string): boolean => {
    const active = (doc as Document & { activeElement?: Element | null })
      .activeElement;
    return active?.hasAttribute?.(attribute) === true
      && (value === undefined || active.getAttribute(attribute) === value);
  };

  const focusByAttribute = (attribute: string, value?: string): boolean => {
    const candidates = opts.host.querySelectorAll<HTMLElement>(
      `[${attribute}]`,
    );
    const target = Array.from(candidates).find((candidate) =>
      value === undefined || candidate.getAttribute(attribute) === value
    );
    target?.focus();
    return target !== undefined;
  };

  const focusForgetOutcome = (case_id: string, previousIndex: number): void => {
    if (focusByAttribute(LEARNING_PANEL_FORGET_ATTR, case_id)) return;
    const remaining = state.cases ?? [];
    const next = remaining.length > 0
      ? remaining[Math.min(Math.max(previousIndex, 0), remaining.length - 1)]
      : undefined;
    if (
      next !== undefined
      && focusByAttribute(LEARNING_PANEL_FORGET_ATTR, next.case_id)
    ) return;
    if (focusByAttribute(LEARNING_PANEL_CASES_ERROR_ATTR)) return;
    if (focusByAttribute(LEARNING_PANEL_CASES_EMPTY_ATTR)) return;
    focusByAttribute(LEARNING_PANEL_CASES_ATTR);
  };

  const setState = (patch: Partial<LearningPanelState>): void => {
    if (disposed) return;
    state = { ...state, ...patch };
    render();
  };

  const loadCases = async (
    beforeRender?: () => void,
    settledPatch: Partial<LearningPanelState> = {},
  ): Promise<void> => {
    if (!opts.runCasesList) return;
    try {
      const { cases } = await opts.runCasesList();
      if (disposed) return;
      beforeRender?.();
      setState({ ...settledPatch, cases, casesError: null });
    } catch (err) {
      if (disposed) return;
      // ⚠ The LIST fails on its own. A corpus read that could not complete must
      // not blank the toggle above it — that control is the tap for everything
      // learned, and losing it because a list query failed would be the larger
      // loss. `cases: []` is NOT used here: an empty list is a claim that
      // nothing was learned, which is exactly what is unknown right now.
      beforeRender?.();
      setState({
        ...settledPatch,
        casesError: humanizeRpcError(err),
      });
    }
  };

  const doLoad = async (): Promise<void> => {
    setState({ phase: 'loading', error: null });
    try {
      const { prefs } = await opts.runPrefsGet();
      if (disposed) return;
      setState({ phase: 'ready', prefs, error: null });
    } catch (err) {
      if (disposed) return;
      setState({ phase: 'error', error: humanizeRpcError(err) });
      return;
    }
    await loadCases();
  };

  const doForget = async (case_id: string): Promise<void> => {
    if (!opts.runCaseForget) return;
    const previousIndex = state.cases?.findIndex(
      (entry) => entry.case_id === case_id,
    ) ?? 0;
    const returnFromForget = elementHasFocus(
      LEARNING_PANEL_FORGET_ATTR,
      case_id,
    );
    setState({
      forgetting: case_id,
      armed: null,
      forgetError: null,
    });
    if (returnFromForget) {
      focusByAttribute(LEARNING_PANEL_FORGET_ATTR, case_id);
    }
    try {
      await opts.runCaseForget({ case_id });
      if (disposed) return;
      // ⛔ RE-READ rather than splicing the row out locally. Forgetting removes
      // the case's SOURCE reports, and a report shared with another case takes
      // that one with it — the server says what actually went, and a local
      // removal would show the owner a list that quietly disagreed.
      let returnToForgetOutcome = false;
      await loadCases(
        () => {
          returnToForgetOutcome = elementHasFocus(
            LEARNING_PANEL_FORGET_ATTR,
            case_id,
          );
        },
        { forgetting: null },
      );
      if (returnToForgetOutcome) {
        focusForgetOutcome(case_id, previousIndex);
      }
    } catch (err) {
      if (disposed) return;
      const returnToForget = elementHasFocus(
        LEARNING_PANEL_FORGET_ATTR,
        case_id,
      );
      setState({
        forgetting: null,
        armed: case_id,
        forgetError: { case_id, message: humanizeRpcError(err) },
      });
      if (returnToForget) {
        focusByAttribute(LEARNING_PANEL_FORGET_ATTR, case_id);
      }
    }
  };

  const doSave = async (value: boolean): Promise<void> => {
    const returnFromToggle = toggleHasFocus();
    pendingOfferValue = value;
    setState({ saving: true, error: null });
    if (returnFromToggle) focusToggle();
    try {
      const { prefs } = await opts.runPrefsSet({
        patch: { [OFFER_PREF]: value },
      });
      if (disposed) return;
      const returnToToggle = toggleHasFocus();
      pendingOfferValue = null;
      // Authoritative merged set replaces local state (DD#3).
      setState({ saving: false, prefs, error: null });
      if (returnToToggle) focusToggle();
    } catch (err) {
      if (disposed) return;
      const returnToToggle = toggleHasFocus();
      pendingOfferValue = null;
      setState({ saving: false, error: humanizeRpcError(err) });
      if (returnToToggle) focusToggle();
    }
  };

  /** ⛔ TWO PRESSES, and the first one SHOWS THE COPY. This is a slow call
   *  against the owner's model quota, so an accidental tap must not spend it —
   *  and the confirmation is the server's own wording, threaded in, because a
   *  surface that could paraphrase it could also soften it. */
  const doDraft = async (case_id: string): Promise<void> => {
    if (!opts.runDraftRecipe) return;
    const settleDraft = (
      patch: Pick<LearningPanelState, 'drafting' | 'draftArmed' | 'draftError'>,
    ): void => {
      const returnToDraft = elementHasFocus(
        LEARNING_PANEL_DRAFT_ATTR,
        case_id,
      );
      setState(patch);
      if (returnToDraft) {
        focusByAttribute(LEARNING_PANEL_DRAFT_ATTR, case_id);
      }
    };
    const returnFromDraft = elementHasFocus(
      LEARNING_PANEL_DRAFT_ATTR,
      case_id,
    );
    setState({ drafting: case_id, draftArmed: case_id, draftError: null });
    if (returnFromDraft) {
      focusByAttribute(LEARNING_PANEL_DRAFT_ATTR, case_id);
    }
    try {
      const result = await opts.runDraftRecipe({
        case_id,
        prompt: promptFor(case_id),
      });
      // ⛔⛔ A COMPLETED DRAFT IS HANDED OVER EVEN IF THIS PANEL IS GONE. It used
      // to `if (disposed) return`, so navigating away during a 90-second call
      // silently threw away a draft the owner had PAID FOR — the worst failure
      // this feature has, and invisible. The hand-off stashes; only the
      // NAVIGATION is suppressed once disposed, which the shell decides.
      //
      // ⚠ State updates still bail: touching a disposed panel's DOM is the thing
      // the guard was actually for.
      if (disposed) {
        if (result.ok && result.recipe !== undefined) {
          opts.onDraftReady?.({
            case_id,
            recipe: result.recipe,
            request_aliased: result.request_aliased !== false,
          });
        }
        return;
      }
      if (!result.ok) {
        // ⚠ A model that wrote something unusable is an ANSWER, not a crash.
        // Show what the validator found — the owner can retry with a clearer
        // instruction, which is the only lever they actually have.
        settleDraft({
          drafting: null,
          draftArmed: case_id,
          draftError: {
            case_id,
            // ⛔ NOT EVERY FAILURE IS A BAD DRAFT. `already_running` means a
            // first press is still out — nothing was written and the model is
            // blameless, so the validator framing would tell the owner to
            // rewrite an instruction when the answer is to wait. Seen live on
            // 2026-07-29 when a second press produced "Your AI's draft was not
            // a valid recipe: A draft for this turn is already being written."
            message: result.reason === 'already_running'
              ? result.issues[0] ?? 'A draft for this is already being '
                + 'written. Wait for it to finish.'
              : result.issues.length > 0
                ? `What your AI wrote was not a working Recipe: ${result.issues[0]}`
                : 'Your AI did not give back a Recipe. Try again, or say more '
                  + 'about what you want it to do.',
          },
        });
        return;
      }
      const completed = {
        case_id,
        recipe: result.recipe,
        request_aliased: result.request_aliased !== false,
      };
      // ⛔ Retain the already-paid-for result BEFORE the hand-off. If browser
      // storage is full, retrying must retry only this local transfer — never
      // ask the model to write the same recipe (and spend quota) again.
      retainedDrafts.set(case_id, completed);
      // The host may synchronously route to the Kitchen. During that one
      // callback the draft is neither an external in-flight change nor an
      // abandoned local result, so the Settings leave guard must not
      // self-confirm the handoff it was asked to perform.
      draftHandoffInProgress = true;
      let handed: boolean | void;
      try {
        handed = opts.onDraftReady?.(completed);
      } finally {
        draftHandoffInProgress = false;
      }
      if (handed !== false) retainedDrafts.delete(case_id);
      settleDraft({
        drafting: null,
        draftArmed: handed === false ? case_id : null,
        draftError: handed === false
          ? {
              case_id,
              message: DRAFT_HANDOFF_ERROR,
            }
          : null,
      });
    } catch (err) {
      if (disposed) return;
      settleDraft({
        drafting: null,
        draftArmed: case_id,
        draftError: {
          case_id,
          message: retainedDrafts.has(case_id)
            ? DRAFT_HANDOFF_ERROR
            : humanizeRpcError(err),
        },
      });
    }
  };

  const retryDraftHandoff = (case_id: string): void => {
    const retained = retainedDrafts.get(case_id);
    if (retained === undefined) return;
    const returnToDraft = elementHasFocus(LEARNING_PANEL_DRAFT_ATTR, case_id);
    draftHandoffInProgress = true;
    try {
      const handed = opts.onDraftReady?.(retained);
      if (handed !== false) retainedDrafts.delete(case_id);
      setState({
        draftArmed: handed === false ? case_id : null,
        draftError: handed === false
          ? { case_id, message: DRAFT_HANDOFF_ERROR }
          : null,
      });
    } catch {
      setState({
        draftArmed: case_id,
        draftError: { case_id, message: DRAFT_HANDOFF_ERROR },
      });
    } finally {
      draftHandoffInProgress = false;
    }
    if (returnToDraft) {
      focusByAttribute(LEARNING_PANEL_DRAFT_ATTR, case_id);
    }
  };

  const render = (): void => {
    if (disposed) return;
    clearChildren(opts.host);

    if (state.phase === 'loading') {
      const loading = doc.createElement('div');
      loading.className = 'learning-muted';
      loading.textContent = 'Loading…';
      opts.host.appendChild(loading);
      return;
    }
    if (state.phase === 'error') {
      const error = doc.createElement('div');
      error.setAttribute(LEARNING_PANEL_ERROR_ATTR, '');
      error.textContent =
        `Recued could not load these settings: ${state.error ?? 'unknown error'}`;
      opts.host.appendChild(error);
      return;
    }

    const authoritativeEnabled =
      getPref(state.prefs ?? undefined, OFFER_PREF) === true;
    const enabled = state.saving && pendingOfferValue !== null
      ? pendingOfferValue
      : authoritativeEnabled;

    const row = doc.createElement('label');
    row.className = 'learning-row';
    const checkbox = doc.createElement('input');
    checkbox.setAttribute('type', 'checkbox');
    checkbox.setAttribute(LEARNING_PANEL_TOGGLE_ATTR, OFFER_PREF);
    (checkbox as HTMLInputElement).checked = enabled;
    if (state.saving) {
      checkbox.setAttribute('aria-disabled', 'true');
      checkbox.setAttribute('aria-busy', 'true');
    }
    checkbox.addEventListener('change', () => {
      if (state.saving) {
        (checkbox as HTMLInputElement).checked = enabled;
        return;
      }
      pendingSave = doSave((checkbox as HTMLInputElement).checked);
    });
    row.appendChild(checkbox);
    const text = doc.createElement('span');
    text.className = 'learning-row-text';
    const label = doc.createElement('span');
    label.className = 'learning-row-label';
    label.textContent = OFFER_LABEL;
    text.appendChild(label);
    const detail = doc.createElement('span');
    detail.className = 'learning-row-detail';
    detail.textContent = OFFER_DETAIL;
    text.appendChild(detail);
    row.appendChild(text);
    opts.host.appendChild(row);

    if (!enabled) {
      const hint = doc.createElement('div');
      hint.setAttribute(LEARNING_PANEL_OFF_HINT_ATTR, '');
      hint.className = 'learning-muted';
      // ⚠ Says what is LOST, not just that a switch is off — and says it
      // ACCURATELY. This claimed the turns "will not become precedent", which
      // overstated the switch: an independently verified outcome still can,
      // because verification is strong evidence that does not run through the
      // ask. Past answers being kept is the reassuring half.
      hint.textContent =
        'Recued will not ask, so it will not learn from these. '
        + 'Anything it can check for itself may still count. '
        + 'What you have already told it is kept.';
      opts.host.appendChild(hint);
    }

    if (state.error !== null) {
      const error = doc.createElement('div');
      error.setAttribute(LEARNING_PANEL_ERROR_ATTR, '');
      error.textContent = `Recued could not save it: ${state.error}`;
      opts.host.appendChild(error);
    }

    renderCases();
  };

  /** D-219 item 2 — WHAT RECUED HAS LEARNED.
   *
   *  Until this existed the owner was asked "was that right?", answered, and
   *  had no way to see that anything came of it: a model got a card, they got
   *  nothing. The list is the answer to *"what does it know about me"*, and the
   *  Forget control is what makes it a control surface rather than a display.
   *
   *  ⚠ This once read "there is deliberately no Make-a-recipe action here",
   *  because a case records CHAT TOOL names while a recipe's steps are kernel
   *  ops and nothing declares a correspondence between them. Item 2b did not
   *  refute that — it moved where the correspondence is resolved: the owner's
   *  own model does the translation, and the draft lands UNSAVED in the
   *  ordinary Kitchen editor. The objection was never to generating a recipe,
   *  it was to a plausible-looking wrong one arriving without review — so the
   *  review is the part that had to exist before the button could. */
  const renderCases = (): void => {
    if (!opts.runCasesList) return;

    const block = doc.createElement('div');
    block.setAttribute(LEARNING_PANEL_CASES_ATTR, '');
    block.setAttribute('tabindex', '-1');
    const heading = doc.createElement('h4');
    heading.className = 'learning-row-label';
    heading.textContent = 'What Recued has learned';
    block.appendChild(heading);

    if (state.casesError !== null) {
      const error = doc.createElement('div');
      error.setAttribute(LEARNING_PANEL_CASES_ERROR_ATTR, '');
      error.setAttribute('tabindex', '-1');
      error.textContent =
        `Recued could not load what it has learned: ${state.casesError}`;
      block.appendChild(error);
      opts.host.appendChild(block);
      return;
    }
    if (state.cases === null) {
      const loading = doc.createElement('div');
      loading.className = 'learning-muted';
      loading.textContent = 'Loading...';
      block.appendChild(loading);
      opts.host.appendChild(block);
      return;
    }
    if (state.cases.length === 0) {
      const empty = doc.createElement('div');
      empty.setAttribute(LEARNING_PANEL_CASES_EMPTY_ATTR, '');
      empty.setAttribute('tabindex', '-1');
      empty.className = 'learning-muted';
      // Names the ONE way anything gets here, so an empty list reads as a
      // stage rather than as a failure.
      empty.textContent =
        'Nothing yet. Recued only learns from the ones you answer, so this fills '
        + 'up as you tell it how things went.';
      block.appendChild(empty);
      opts.host.appendChild(block);
      return;
    }

    for (const entry of state.cases) {
      block.appendChild(renderCase(entry));
    }
    opts.host.appendChild(block);
  };

  const caseRequestLabel = (entry: ExecutionCaseLearnedEntry): string =>
    entry.request.length > 0
      ? entry.request.join(' · ')
      : 'Something Recued could not sum up';

  const caseAccessibleLabel = (entry: ExecutionCaseLearnedEntry): string =>
    `what it learned: ${caseRequestLabel(entry)} (${entry.case_id})`;

  const renderCase = (entry: ExecutionCaseLearnedEntry): HTMLElement => {
    const item = doc.createElement('div');
    item.setAttribute(LEARNING_PANEL_CASE_ATTR, entry.case_id);
    item.className = 'learning-case';

    const request = doc.createElement('div');
    request.className = 'learning-row-label';
    // A shape with no intent facet is possible and must still be legible
    // rather than rendering as a blank row the owner cannot act on.
    request.textContent = caseRequestLabel(entry);
    item.appendChild(request);

    for (const flow of entry.flows) {
      const steps = doc.createElement('div');
      steps.className = 'learning-row-detail';
      // ⛔⛔ A COMMA LIST, NOT AN ARROW CHAIN — and the distinction is the whole
      // point of the field it reads.
      //
      // This was `flow.tool_sequence.join(' → ')`, with a comment calling the
      // arrow "a reading aid, not a dependency claim". The field no longer
      // exists: three live A/B rounds showed what a claimed route does to a
      // reader, and the card stopped describing a RUN at all. What arrives now
      // is a deduped, alphabetically SORTED candidate set — so an arrow would
      // render sort order as though it were the order things happened, which is
      // a claim about the owner's own history that nothing ever observed. On a
      // page whose entire purpose is to be the honest answer to "what does it
      // know about me", that is the one thing it must not do.
      //
      // ⚠ The prefix is not decoration. Without it the row is a bare list of op
      // names, and the arrow was at least implicitly saying what the list WAS.
      steps.textContent = `May need: ${flow.tools_that_may_be_needed.join(', ')}`;
      item.appendChild(steps);
      for (const line of flow.outcome) {
        const outcome = doc.createElement('div');
        outcome.className = 'learning-row-detail';
        outcome.textContent = line;
        item.appendChild(outcome);
      }
    }

    if (!entry.shown_to_model) {
      // ⛔ Said out loud. An inert case listed identically to a live one would
      // misreport the reach of everything on the page — the owner would read
      // the list as "what the AI is using" when part of it is not.
      const inert = doc.createElement('div');
      inert.setAttribute(LEARNING_PANEL_CASE_INERT_ATTR, '');
      inert.className = 'learning-muted';
      inert.textContent =
        'Kept, but not used, because it points at steps that are no '
        + 'longer available.';
      item.appendChild(inert);
    }

    const meta = doc.createElement('div');
    meta.className = 'learning-muted';
    // A real date in the VIEWER's zone. The model-bound card omits the
    // timestamp entirely because a prompt has no zone to render one in.
    meta.textContent =
      `Seen ${entry.request_observations === 1 ? 'once' : `${entry.request_observations} times`}`
      + `, last on ${new Date(entry.last_seen_at).toLocaleDateString()}`;
    item.appendChild(meta);

    // D-219 — "you already made one of these". ⛔ Rendered from the SERVER's
    // record, not inferred from the recipe list: a recipe of a similar name
    // proves nothing about where it came from.
    if (entry.authored !== undefined && entry.authored.length > 0) {
      const made = doc.createElement('div');
      made.setAttribute(LEARNING_PANEL_CASE_AUTHORED_ATTR, entry.case_id);
      made.className = 'learning-row-detail';
      // ⛔ SAY WHAT THEY WOULD FIND. "You made a recipe from this" is actively
      // misleading when the recipe is gone, and merely incomplete when they have
      // since edited it — the server resolves the stored hash against the live
      // recipe so this line can be honest about both.
      const describe = (row: { recipe_id: string; state: string }): string =>
        row.state === 'gone'
          ? `${row.recipe_id} (no longer saved)`
          : row.state === 'edited'
            ? `${row.recipe_id} (edited since)`
            : row.recipe_id;
      made.textContent = entry.authored.length === 1
        ? `You made a recipe from this: ${describe(entry.authored[0]!)}`
        : `You made ${entry.authored.length} recipes from this: `
          + entry.authored.map(describe).join(', ');
      item.appendChild(made);
    }

    if (opts.runDraftRecipe && opts.onDraftReady) {
      for (const node of renderDraft(entry)) item.appendChild(node);
    }
    if (opts.runCaseForget) {
      item.appendChild(renderForget(entry));
      if (state.forgetError?.case_id === entry.case_id) {
        const error = doc.createElement('div');
        error.setAttribute(LEARNING_PANEL_FORGET_ERROR_ATTR, entry.case_id);
        error.setAttribute('role', 'alert');
        error.textContent = `Recued could not forget it: ${state.forgetError.message}`;
        item.appendChild(error);
      }
    }
    return item;
  };

  /** D-219 item 2b — turn this case into a recipe.
   *
   *  ⛔ The confirmation is shown BEFORE the call, not after, and the first
   *  press only reveals it. What it says is the server's copy verbatim: this is
   *  slow, it spends model quota, and what comes back is a first draft whose
   *  review is the step that makes it safe.
   *
   *  ⚠ The panel does not route. It hands the draft to `onDraftReady` and the
   *  shell opens the Kitchen — a Settings panel that knew about Kitchen routes
   *  would be the wrong thing to have to change when they move. */
  const renderDraft = (entry: ExecutionCaseLearnedEntry): HTMLElement[] => {
    const nodes: HTMLElement[] = [];
    const armed = state.draftArmed === entry.case_id;
    const busy = state.drafting === entry.case_id;
    const retained = retainedDrafts.has(entry.case_id);
    const actionsLocked = state.drafting !== null || state.forgetting !== null;
    const caseLabel = caseAccessibleLabel(entry);

    if (armed) {
      const confirm = doc.createElement('div');
      confirm.setAttribute(LEARNING_PANEL_DRAFT_CONFIRM_ATTR, entry.case_id);
      confirm.className = 'learning-row-detail';
      confirm.textContent = opts.draftConfirmation ?? '';
      nodes.push(confirm);

      const prompt = doc.createElement('textarea');
      prompt.setAttribute(LEARNING_PANEL_DRAFT_PROMPT_ATTR, entry.case_id);
      prompt.setAttribute('aria-label', `What the Recipe should do, for ${caseLabel}`);
      prompt.setAttribute(
        'placeholder',
        // ⚠ Invites BOTH readings on purpose. This asked only "what should this
        // recipe do", which fits a turn the owner CONFIRMED — but a case is
        // listed on any verdict, so the card above may say "You rejected the
        // result." For that one the useful instruction is what was WRONG, and
        // nothing here asked for it. Worded generally rather than switched on
        // the verdict: the polarity is only available as rendered prose, and
        // matching on prose to pick a placeholder would break the moment the
        // wording changed.
        'You can say what this Recipe should do, or what should be different '
        + 'from last time. For example: run it every Monday.',
      );
      (prompt as HTMLTextAreaElement).value = promptFor(entry.case_id);
      prompt.addEventListener('input', () => {
        drafts.set(entry.case_id, (prompt as HTMLTextAreaElement).value);
      });
      nodes.push(prompt);
    }

    const button = doc.createElement('button');
    button.setAttribute('type', 'button');
    button.setAttribute(LEARNING_PANEL_DRAFT_ATTR, entry.case_id);
    button.className = `rx-btn ${armed && !retained
      ? 'rx-btn-primary'
      : 'rx-btn-secondary'}`;
    button.textContent = retained
      ? 'Open finished draft'
      : busy
        ? 'Asking your AI…'
        : armed
          ? 'Yes, write the draft'
          : 'Make a Recipe…';
    button.setAttribute(
      'aria-label',
      retained
        ? `Open finished draft from ${caseLabel}`
        : busy
          ? `Asking your AI to write a Recipe from ${caseLabel}`
          : armed
            ? `Say yes to the Recipe from ${caseLabel}`
            : `Make a Recipe from ${caseLabel}`,
    );
    if (actionsLocked) {
      button.setAttribute('aria-disabled', 'true');
      if (busy) button.setAttribute('aria-busy', 'true');
    }
    button.addEventListener('click', () => {
      if (state.drafting !== null || state.forgetting !== null) return;
      if (retainedDrafts.has(entry.case_id)) {
        retryDraftHandoff(entry.case_id);
        return;
      }
      if (state.draftArmed !== entry.case_id) {
        const returnToDraft = elementHasFocus(
          LEARNING_PANEL_DRAFT_ATTR,
          entry.case_id,
        );
        setState({ draftArmed: entry.case_id, draftError: null });
        if (returnToDraft) {
          focusByAttribute(LEARNING_PANEL_DRAFT_ATTR, entry.case_id);
        }
        return;
      }
      pendingDraft = doDraft(entry.case_id);
    });
    nodes.push(button);

    if (state.draftError?.case_id === entry.case_id) {
      const error = doc.createElement('div');
      error.setAttribute(LEARNING_PANEL_DRAFT_ERROR_ATTR, entry.case_id);
      error.setAttribute('role', 'alert');
      error.textContent = state.draftError.message;
      nodes.push(error);
    }
    return nodes;
  };

  /** Two-tap, like the destructive control in `clear-this-browser-panel`.
   *  Forgetting deletes the source turns and the answer the owner gave about
   *  them; there is no undo, so a single stray tap must not do it. */
  const renderForget = (entry: ExecutionCaseLearnedEntry): HTMLElement => {
    const armed = state.armed === entry.case_id;
    const busy = state.forgetting === entry.case_id;
    const actionsLocked = state.forgetting !== null || state.drafting !== null;
    const caseLabel = caseAccessibleLabel(entry);
    const button = doc.createElement('button');
    button.setAttribute('type', 'button');
    button.setAttribute(LEARNING_PANEL_FORGET_ATTR, entry.case_id);
    button.className = 'rx-btn rx-btn-danger';
    button.textContent = busy
      ? 'Forgetting...'
      : armed
        ? 'Tap again to forget'
        : 'Forget';
    button.setAttribute(
      'aria-label',
      busy
        ? `Forgetting ${caseLabel}`
        : armed
          ? `Confirm forgetting ${caseLabel}`
          : `Forget ${caseLabel}`,
    );
    if (actionsLocked) {
      button.setAttribute('aria-disabled', 'true');
      if (busy) button.setAttribute('aria-busy', 'true');
    }
    button.addEventListener('click', () => {
      if (state.forgetting !== null || state.drafting !== null) return;
      if (state.armed !== entry.case_id) {
        const returnToForget = elementHasFocus(
          LEARNING_PANEL_FORGET_ATTR,
          entry.case_id,
        );
        setState({ armed: entry.case_id, forgetError: null });
        if (returnToForget) {
          focusByAttribute(LEARNING_PANEL_FORGET_ATTR, entry.case_id);
        }
        return;
      }
      pendingForget = doForget(entry.case_id);
    });
    return button;
  };

  render();
  pendingLoad = doLoad();

  return {
    getState: () => state,
    hasInFlightWork: () => !disposed
      && !draftHandoffInProgress
      && (
        state.saving
        || state.forgetting !== null
        || state.drafting !== null
      ),
    hasUnsavedChanges: () => !disposed
      && !draftHandoffInProgress
      && retainedDrafts.size > 0,
    whenLoaded: () => pendingLoad,
    whenSaveSettled: () => pendingSave ?? Promise.resolve(),
    whenForgetSettled: () => pendingForget ?? Promise.resolve(),
    whenDraftSettled: () => pendingDraft ?? Promise.resolve(),
    dispose: () => {
      disposed = true;
      clearChildren(opts.host);
      opts.host.removeAttribute(LEARNING_PANEL_HOST_ATTR);
    },
  };
};

/** ⛔ THE PANEL SET THESE CLASSES AND NOTHING DEFINED THEM. Until this existed
 *  `learning-row-label` / `-detail` were bare `<span>`s — inline, unstyled — so
 *  the label and its description rendered as one run-together sentence
 *  ("…turned outAfter Recued works through…"), un-bolded, directly beneath the
 *  Transparency rows that DO carry styles and look right. Every render test
 *  passed throughout: they assert structure and text, and a missing stylesheet
 *  changes neither. Only a real browser shows it.
 *
 *  Mirrors `TRANSPARENCY_PANEL_STYLES` deliberately — the two sit adjacent in
 *  Privacy and a person reads them as one list, so divergence here is a visible
 *  seam rather than a style choice.
 *
 *  ⚠ Selectors scope to `[data-recued-learning-panel]`, so the rules are inert
 *  when the bootstrap omits the prefs callers and the section never mounts. */
export const LEARNING_PANEL_STYLES = `
[${LEARNING_PANEL_HOST_ATTR}] {
  display: grid;
  gap: 10px;
  max-width: 64ch;
  font-size: 13px;
  color: var(--fg);
}
[${LEARNING_PANEL_HOST_ATTR}] .learning-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  cursor: pointer;
}
[${LEARNING_PANEL_HOST_ATTR}] .learning-row input {
  margin-top: 2px;
}
[${LEARNING_PANEL_HOST_ATTR}] .learning-row-text {
  display: grid;
  gap: 2px;
}
[${LEARNING_PANEL_HOST_ATTR}] .learning-row-label {
  font-weight: 650;
}
[${LEARNING_PANEL_HOST_ATTR}] .learning-row-detail,
[${LEARNING_PANEL_HOST_ATTR}] .learning-muted {
  font-size: 12px;
  color: var(--muted);
}
[${LEARNING_PANEL_HOST_ATTR}] .learning-case {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
}
[${LEARNING_PANEL_HOST_ATTR}] .learning-case button {
  justify-self: start;
}
`;
