/** D-169 P2 Slice 3 — shared approval (D-158 `ask`) card.
 *
 *  ONE interactive primitive both the webclient and the bridge side panel
 *  render for a pending D-158 `notification.ask` (I-12 / TR-9 / O-3 — no
 *  per-client copy). It renders the ask's title / body + one button per
 *  option; clicking a button fires `onAnswer(optionId)`. The host owns the
 *  actual submit — the bridge side panel round-trips to its service worker,
 *  which calls the `notification.submitAnswer` rpc; the webclient (a
 *  Slice-3b follow-on) will call the same rpc — and the notification block
 *  dedups first-answer-wins across every surface (D-158 I-6).
 *
 *  ⚠️  Render model — DOM node, not an HTML string. Most `@recued/ui-shared`
 *  primitives return an HTML string wired by `data-action` delegation, but
 *  the bridge side panel (the primary consumer) is a DOM-node builder with
 *  no `innerHTML` and no delegation dispatcher, and an *interactive* card
 *  needs real click handlers. Returning an `HTMLElement` + taking an
 *  `onAnswer` callback fits both consumers (each `appendChild`s the node)
 *  and keeps the click wiring inside the primitive. All user / server
 *  derived text is set via `textContent` — inert, no HTML injection.
 *
 *  ⚠️  Prop is a STRUCTURAL shape, NOT an import of `PendingAsk` from
 *  `@recued/notification` — `@recued/ui-shared` keeps zero dependency on
 *  the notification block. Both the bridge side-panel store row and the
 *  contracts `ServerPendingAsk` wire type satisfy `AskCardModel`
 *  (`AskOption` is just `{ id, label }`).
 *
 *  Spec: docs/d-169-spec.md § N.5 #4 / I-11 / I-12 / TR-9. */

/** One answer choice — mirrors the D-158 `AskOption` ({ id, label }) and
 *  the `ServerPendingAsk.options[]` wire shape without importing either. */
export interface AskCardOption {
  /** Stable option slug — the value submitted as the answer. */
  id: string;
  /** Human-readable button label. */
  label: string;
}

/** The renderable subset of a pending ask. Satisfied by the bridge
 *  side-panel store's approval row and the contracts `ServerPendingAsk`. */
export interface AskCardModel {
  ask_id: string;
  title?: string;
  text: string;
  options: ReadonlyArray<AskCardOption>;
}

export interface AskCardHandlers {
  /** Fired with the chosen option's `id` when the user clicks its button.
   *  The host submits the answer via the `notification.submitAnswer` rpc.
   *  MAY be async: while the returned promise is pending the card disables
   *  its buttons (an in-flight guard against a double-tap firing two
   *  answers). On success the host removes the card (the answered ask drops
   *  out of the list). If the promise REJECTS (transient failure / not
   *  paired) the card re-enables its buttons + shows a brief inline error
   *  so the user can retry — the disable is in-flight-only, never sticky. */
  onAnswer: (optionId: string) => void | Promise<void>;
}

/** Stable hook on the card root — the value is the `ask_id` so a host can
 *  query a specific card. */
export const ASK_CARD_ATTR = 'data-recued-ask-card';
/** Stable hook on each option button — the value is the `AskOption.id`. */
export const ASK_CARD_OPTION_ATTR = 'data-recued-ask-option';
/** Stable hook on the inline submit-error line (hidden until a submit fails). */
export const ASK_CARD_ERROR_ATTR = 'data-recued-ask-error';

/** Treat a blank / whitespace-only title as absent (matches the bridge
 *  side panel's `nonBlankTitle`) so a present-but-empty title doesn't
 *  render a blank heading line. */
const nonBlankAskTitle = (title: string | undefined): string | undefined =>
  title !== undefined && title.trim() !== '' ? title : undefined;

/** Render one pending ask as an interactive card. Returns a detached
 *  `HTMLElement` the host appends into its panel. */
export const renderAskCard = (
  doc: Document,
  model: AskCardModel,
  handlers: AskCardHandlers,
): HTMLElement => {
  const card = doc.createElement('div');
  card.className = 'rx-ask-card';
  card.setAttribute(ASK_CARD_ATTR, model.ask_id);

  const title = nonBlankAskTitle(model.title);
  if (title !== undefined) {
    const heading = doc.createElement('div');
    heading.className = 'rx-ask-card-title';
    heading.textContent = title;
    card.appendChild(heading);
  }

  const body = doc.createElement('div');
  body.className = 'rx-ask-card-text';
  body.textContent = model.text;
  card.appendChild(body);

  // Inline error line — hidden until a submit fails. Created up front so
  // the click handlers can toggle it; appended after the action row.
  const errorEl = doc.createElement('div');
  errorEl.className = 'rx-ask-card-error';
  errorEl.setAttribute(ASK_CARD_ERROR_ATTR, model.ask_id);
  errorEl.textContent = 'Could not submit — try again.';
  errorEl.hidden = true;

  const actions = doc.createElement('div');
  actions.className = 'rx-ask-card-actions';

  const buttons: HTMLButtonElement[] = [];
  let pending = false;
  const setDisabled = (disabled: boolean): void => {
    for (const b of buttons) b.disabled = disabled;
  };
  for (const option of model.options) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'rx-ask-card-btn';
    btn.setAttribute(ASK_CARD_OPTION_ATTR, option.id);
    btn.textContent = option.label;
    btn.addEventListener('click', () => {
      // First click wins on this surface: disable while the submit is in
      // flight so a double-tap can't fire two answers (the server block
      // also dedups first-answer-wins, D-158 I-6). On a SUCCESSFUL submit
      // the host removes the card (the answered ask drops out of the
      // list), so the buttons stay disabled only as long as the card
      // lives. On a FAILED submit we re-enable so the user can retry —
      // the disable is in-flight-only, never sticky (Codex Slice-3 fold).
      if (pending) return;
      pending = true;
      setDisabled(true);
      errorEl.hidden = true;
      // Call `onAnswer` SYNCHRONOUSLY (the async IIFE body runs up to the
      // first `await` before suspending), so a click fires the submit in
      // the same tick — then await its promise only to drive the reject →
      // re-enable + inline-error path.
      void (async () => {
        try {
          await handlers.onAnswer(option.id);
        } catch {
          pending = false;
          setDisabled(false);
          errorEl.hidden = false;
        }
      })();
    });
    buttons.push(btn);
    actions.appendChild(btn);
  }
  card.appendChild(actions);
  card.appendChild(errorEl);
  return card;
};

export type ApprovalCardDecision = 'approve' | 'reject';

/** Renderable subset of a server-side pending approval. Kept structural
 *  instead of importing `ServerPendingApproval` so `ui-shared` stays a
 *  leaf renderer for every client surface. */
export interface ApprovalCardModel {
  approval_id: string;
  recipe_id: string;
  step_id: string;
  ingredient_slug: string;
  risk_tier: 'write' | 'admin' | 'destructive';
  description: string;
  resolved_input: Record<string, unknown>;
  created_at: number;
  timeout_at: number;
  initiator_instance: string;
  /** D-174 #4 — optional route-resolved display names. The card prefers
   *  them over the raw ids in the meta line; absent → renders the id
   *  (back-compat: `recipe_id` / `initiator_instance` stay authoritative
   *  for the recipe href + any keying). */
  recipe_name?: string;
  initiator_label?: string;
}

export interface ApprovalCardLinks {
  recipeHref?: string;
  connectionHref?: string;
  runHref?: string;
}

export interface ApprovalCardHandlers {
  onResolve: (decision: ApprovalCardDecision) => void | Promise<void>;
  /** R20 — a `destructive` gate does not resolve on the first Approve click;
   *  it arms a confirm step. `onArm` fires on that first click (the host marks
   *  the card armed + re-renders → the danger-styled Confirm replaces Approve);
   *  `onDisarm` fires on Cancel. The host owns the armed flag so a confirm-in-
   *  progress survives a benign re-render (a background bus event shouldn't yank
   *  it away). There is NO auto-confirm — resolving needs a deliberate Confirm
   *  click — and a pending gate is immutable, so the armed decision stays bound
   *  to exactly the reviewed operation. Both are no-ops for non-destructive
   *  tiers, and an absent `onArm` makes a destructive card fall back to
   *  immediate resolve (back-compat for any non-route consumer). */
  onArm?: () => void;
  onDisarm?: () => void;
}

export interface ApprovalCardOptions {
  links?: ApprovalCardLinks;
  disabled?: boolean;
  disabledReason?: string;
  errorMessage?: string | null;
  /** R20 — host-owned armed state for a `destructive` gate's confirm step
   *  (see `ApprovalCardHandlers.onArm`). Ignored for non-destructive tiers. */
  armed?: boolean;
}

/** Stable hook on the server-approval card root. */
export const APPROVAL_CARD_ATTR = 'data-recued-approval-card';
/** Stable hook on approve/reject buttons. */
export const APPROVAL_CARD_ACTION_ATTR = 'data-recued-approval-action';
/** Stable hook on cross-route links. */
export const APPROVAL_CARD_LINK_ATTR = 'data-recued-approval-link';
/** Stable hook on the inline resolve-error line. */
export const APPROVAL_CARD_ERROR_ATTR = 'data-recued-approval-error';
/** Stable hook on the stale/disabled reason line. */
export const APPROVAL_CARD_STATUS_ATTR = 'data-recued-approval-status';
/** Stable hook on the destructive-confirm caution line (armed state only). */
export const APPROVAL_CARD_CAUTION_ATTR = 'data-recued-approval-caution';

const formatEpochMs = (value: number): string => {
  if (!Number.isFinite(value)) return 'unknown time';
  return new Date(value).toISOString();
};

const formatResolvedInput = (input: Record<string, unknown>): string => {
  try {
    const text = JSON.stringify(input);
    if (text === undefined || text === '{}') return 'No resolved input';
    return text.length > 320 ? `${text.slice(0, 317)}...` : text;
  } catch {
    return 'Resolved input could not be displayed';
  }
};

/** Render one server-side pending approval as an interactive card. */
export const renderApprovalCard = (
  doc: Document,
  model: ApprovalCardModel,
  handlers: ApprovalCardHandlers,
  options: ApprovalCardOptions = {},
): HTMLElement => {
  const card = doc.createElement('div');
  card.className = 'rx-approval-card';
  card.setAttribute(APPROVAL_CARD_ATTR, model.approval_id);

  const heading = doc.createElement('div');
  heading.className = 'rx-approval-card-title';
  heading.textContent = model.description;
  card.appendChild(heading);

  const meta = doc.createElement('div');
  meta.className = 'rx-approval-card-meta';
  meta.textContent = [
    model.ingredient_slug,
    model.risk_tier,
    `recipe ${model.recipe_name ?? model.recipe_id}`,
    `step ${model.step_id}`,
    `from ${model.initiator_label ?? model.initiator_instance}`,
  ].join(' · ');
  card.appendChild(meta);

  const timing = doc.createElement('div');
  timing.className = 'rx-approval-card-meta';
  timing.textContent = `requested ${formatEpochMs(model.created_at)} · expires ${formatEpochMs(model.timeout_at)}`;
  card.appendChild(timing);

  const input = doc.createElement('pre');
  input.className = 'rx-approval-card-input';
  input.textContent = formatResolvedInput(model.resolved_input);
  card.appendChild(input);

  const links = doc.createElement('div');
  links.className = 'rx-approval-card-links';
  const appendLink = (
    kind: 'recipe' | 'connection' | 'run',
    label: string,
    href: string | undefined,
  ): void => {
    if (href === undefined) return;
    const link = doc.createElement('a');
    link.setAttribute('href', href);
    link.setAttribute(APPROVAL_CARD_LINK_ATTR, kind);
    link.textContent = label;
    links.appendChild(link);
  };
  appendLink('recipe', 'Recipe', options.links?.recipeHref);
  appendLink('connection', 'Connection', options.links?.connectionHref);
  appendLink('run', 'Run audit', options.links?.runHref);
  if (links.children.length > 0) card.appendChild(links);

  const errorEl = doc.createElement('div');
  errorEl.className = 'rx-approval-card-error';
  errorEl.setAttribute(APPROVAL_CARD_ERROR_ATTR, model.approval_id);
  errorEl.textContent = options.errorMessage ?? 'Could not resolve approval - try again.';
  errorEl.hidden = options.errorMessage === undefined || options.errorMessage === null;

  const statusEl = doc.createElement('div');
  statusEl.className = 'rx-approval-card-status';
  statusEl.setAttribute(APPROVAL_CARD_STATUS_ATTR, model.approval_id);
  statusEl.textContent = options.disabledReason ?? '';
  statusEl.hidden = options.disabledReason === undefined;

  const isDestructive = model.risk_tier === 'destructive';
  const armed = options.armed === true;
  // A destructive gate arms a confirm step on the first Approve click (R20).
  // Without an `onArm` handler the card keeps the immediate-resolve behavior
  // (back-compat for non-route consumers).
  const usesDestructiveConfirm = isDestructive && handlers.onArm !== undefined;

  const actions = doc.createElement('div');
  actions.className = 'rx-approval-card-actions';

  const buttons: HTMLButtonElement[] = [];
  let pending = false;
  const setDisabled = (disabled: boolean): void => {
    for (const b of buttons) b.disabled = disabled;
  };
  /** A resolve button — fires `onResolve(decision)` behind the in-flight
   *  guard. `actionAttr` is decoupled from `decision` so the destructive
   *  "Confirm" carries its own hook while still resolving `approve`. */
  const makeResolveButton = (
    decision: ApprovalCardDecision,
    actionAttr: string,
    label: string,
    className: string,
  ): HTMLButtonElement => {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.setAttribute(APPROVAL_CARD_ACTION_ATTR, actionAttr);
    btn.textContent = label;
    btn.disabled = options.disabled === true;
    btn.addEventListener('click', () => {
      if (pending || btn.disabled) return;
      pending = true;
      setDisabled(true);
      errorEl.hidden = true;
      void (async () => {
        try {
          await handlers.onResolve(decision);
        } catch {
          pending = false;
          setDisabled(options.disabled === true);
          errorEl.textContent =
            options.errorMessage ?? 'Could not resolve approval - try again.';
          errorEl.hidden = false;
        }
      })();
    });
    buttons.push(btn);
    return btn;
  };
  /** An arm / cancel toggle — flips host-owned state + triggers a re-render
   *  (which rebuilds this button), so it needs no in-flight guard. */
  const makeToggleButton = (
    actionAttr: string,
    label: string,
    className: string,
    onClick: () => void,
  ): HTMLButtonElement => {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.setAttribute(APPROVAL_CARD_ACTION_ATTR, actionAttr);
    btn.textContent = label;
    btn.disabled = options.disabled === true;
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      onClick();
    });
    buttons.push(btn);
    return btn;
  };

  if (usesDestructiveConfirm && armed) {
    // Armed: a caution line + Cancel + a danger-styled Confirm (resolves
    // approve). This is the REAL confirm that replaces the old hollow
    // Review-then-route for destructive gates.
    const caution = doc.createElement('div');
    caution.className = 'rx-approval-card-caution';
    caution.setAttribute(APPROVAL_CARD_CAUTION_ATTR, model.approval_id);
    caution.textContent =
      'Destructive action - this cannot be undone. Confirm to proceed.';
    card.appendChild(caution);
    actions.appendChild(
      makeToggleButton(
        'cancel',
        'Cancel',
        'rx-approval-card-btn rx-approval-card-btn--reject',
        () => handlers.onDisarm?.(),
      ),
    );
    actions.appendChild(
      makeResolveButton(
        'approve',
        'confirm',
        'Confirm',
        'rx-approval-card-btn rx-approval-card-btn--confirm',
      ),
    );
  } else if (usesDestructiveConfirm) {
    // Unarmed destructive: Reject resolves immediately; Approve ARMS.
    actions.appendChild(
      makeResolveButton(
        'reject',
        'reject',
        'Reject',
        'rx-approval-card-btn rx-approval-card-btn--reject',
      ),
    );
    actions.appendChild(
      makeToggleButton(
        'arm',
        'Approve',
        'rx-approval-card-btn rx-approval-card-btn--approve',
        () => handlers.onArm?.(),
      ),
    );
  } else {
    // Non-destructive (or no arm handler): Reject + immediate Approve.
    actions.appendChild(
      makeResolveButton(
        'reject',
        'reject',
        'Reject',
        'rx-approval-card-btn rx-approval-card-btn--reject',
      ),
    );
    actions.appendChild(
      makeResolveButton(
        'approve',
        'approve',
        'Approve',
        'rx-approval-card-btn rx-approval-card-btn--approve',
      ),
    );
  }

  card.appendChild(actions);
  card.appendChild(statusEl);
  card.appendChild(errorEl);
  return card;
};

// ════════════════════════════════════════════════════════════════
// Chat plan-approval card (R20) — a D-137 write-plan pulled into #approvals
// ════════════════════════════════════════════════════════════════

/** Renderable subset of a pending chat write-plan (D-137). Structural so the
 *  webclient's `PendingChatPlan` satisfies it without importing chat types. */
export interface ChatPlanCardModel {
  plan_id: string;
  tool: string;
  tier: 1 | 2 | 3;
  args: unknown;
}

export type ChatPlanCardDecision = 'approve' | 'reject';

export interface ChatPlanCardHandlers {
  /** Approve → `chat.plan.approve`; Reject → `chat.plan.cancel` (the host maps
   *  the verb — the wire verb is unchanged, only the LABEL is "Reject", R20).
   *  MAY be async: buttons disable while the promise is pending; a rejection
   *  re-enables + shows the inline error. */
  onResolve: (decision: ChatPlanCardDecision) => void | Promise<void>;
}

export interface ChatPlanCardOptions {
  disabled?: boolean;
  errorMessage?: string | null;
}

/** Stable hook on the chat-plan card root (value = plan_id). */
export const CHAT_PLAN_CARD_ATTR = 'data-recued-chat-plan-card';
/** Stable hook on approve/reject buttons (value = the decision). */
export const CHAT_PLAN_CARD_ACTION_ATTR = 'data-recued-chat-plan-action';
/** Stable hook on the inline resolve-error line. */
export const CHAT_PLAN_CARD_ERROR_ATTR = 'data-recued-chat-plan-error';

const formatPlanArgs = (args: unknown): string => {
  try {
    const text = JSON.stringify(args);
    if (text === undefined || text === '{}' || text === 'null') return 'No arguments';
    return text.length > 320 ? `${text.slice(0, 317)}...` : text;
  } catch {
    return 'Arguments could not be displayed';
  }
};

/** Render one pending chat write-plan as an interactive card. Reuses the
 *  `.rx-approval-card*` visual shell so plans sit consistently in the unified
 *  #approvals list beside gates + asks. */
export const renderChatPlanCard = (
  doc: Document,
  model: ChatPlanCardModel,
  handlers: ChatPlanCardHandlers,
  options: ChatPlanCardOptions = {},
): HTMLElement => {
  const card = doc.createElement('div');
  card.className = 'rx-approval-card';
  card.setAttribute(CHAT_PLAN_CARD_ATTR, model.plan_id);

  const heading = doc.createElement('div');
  heading.className = 'rx-approval-card-title';
  heading.textContent = `Run ${model.tool}`;
  card.appendChild(heading);

  const meta = doc.createElement('div');
  meta.className = 'rx-approval-card-meta';
  meta.textContent = `chat plan · tier ${model.tier}`;
  card.appendChild(meta);

  const input = doc.createElement('pre');
  input.className = 'rx-approval-card-input';
  input.textContent = formatPlanArgs(model.args);
  card.appendChild(input);

  const errorEl = doc.createElement('div');
  errorEl.className = 'rx-approval-card-error';
  errorEl.setAttribute(CHAT_PLAN_CARD_ERROR_ATTR, model.plan_id);
  errorEl.textContent = options.errorMessage ?? 'Could not resolve plan - try again.';
  errorEl.hidden = options.errorMessage === undefined || options.errorMessage === null;

  const actions = doc.createElement('div');
  actions.className = 'rx-approval-card-actions';

  const buttons: HTMLButtonElement[] = [];
  let pending = false;
  const setDisabled = (disabled: boolean): void => {
    for (const b of buttons) b.disabled = disabled;
  };
  const makeButton = (
    decision: ChatPlanCardDecision,
    label: string,
    className: string,
  ): HTMLButtonElement => {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.setAttribute(CHAT_PLAN_CARD_ACTION_ATTR, decision);
    btn.textContent = label;
    btn.disabled = options.disabled === true;
    btn.addEventListener('click', () => {
      if (pending || btn.disabled) return;
      pending = true;
      setDisabled(true);
      errorEl.hidden = true;
      void (async () => {
        try {
          await handlers.onResolve(decision);
        } catch {
          pending = false;
          setDisabled(options.disabled === true);
          errorEl.textContent =
            options.errorMessage ?? 'Could not resolve plan - try again.';
          errorEl.hidden = false;
        }
      })();
    });
    buttons.push(btn);
    return btn;
  };
  actions.appendChild(
    makeButton('reject', 'Reject', 'rx-approval-card-btn rx-approval-card-btn--reject'),
  );
  actions.appendChild(
    makeButton('approve', 'Approve', 'rx-approval-card-btn rx-approval-card-btn--approve'),
  );
  card.appendChild(actions);
  card.appendChild(errorEl);
  return card;
};

/** Self-contained CSS for the card. No ancestor selectors — every rule
 *  targets `.rx-ask-card*` directly so the card looks consistent wherever
 *  it is injected (the bridge side panel, the webclient). Colours read the
 *  global CSS custom properties each host shell defines, with neutral
 *  fallbacks so the card is legible even with no theme variables present. */
export const ASK_CARD_STYLES = `
.rx-ask-card {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 12px;
  margin: 6px 0;
  background: var(--surface);
}
.rx-ask-card-title {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 4px;
  color: var(--fg);
}
.rx-ask-card-text {
  font-size: 13px;
  line-height: 1.4;
  color: var(--fg);
  margin-bottom: 8px;
  white-space: pre-wrap;
}
.rx-ask-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.rx-ask-card-btn {
  padding: 6px 12px;
  border: 1px solid var(--accent);
  border-radius: 4px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  line-height: 1.2;
  cursor: pointer;
}
.rx-ask-card-btn:hover:not(:disabled) { opacity: 0.9; }
.rx-ask-card-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.rx-ask-card-error {
  margin-top: 6px;
  font-size: 12px;
  color: var(--danger);
}
.rx-ask-card-error[hidden] { display: none; }
`;

export const APPROVAL_CARD_STYLES = `
.rx-approval-card {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
  margin: 8px 0;
  background: var(--surface);
}
.rx-approval-card-title {
  font-weight: 650;
  font-size: 13px;
  line-height: 1.35;
  color: var(--fg);
  margin-bottom: 5px;
}
.rx-approval-card-meta {
  font-size: 12px;
  line-height: 1.35;
  color: var(--muted);
  margin-bottom: 5px;
}
.rx-approval-card-input {
  margin: 8px 0;
  padding: 8px;
  border: 1px solid var(--border-subtle, var(--border));
  border-radius: 4px;
  background: var(--surface-subtle, #f7f8f8);
  color: var(--fg);
  font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.rx-approval-card-links {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 8px 0;
}
.rx-approval-card-links a {
  color: var(--accent);
  font-size: 12px;
  text-decoration: none;
}
.rx-approval-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.rx-approval-card-btn {
  padding: 6px 12px;
  border: 1px solid var(--accent);
  border-radius: 4px;
  background: var(--surface);
  color: var(--accent);
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  line-height: 1.2;
  cursor: pointer;
}
.rx-approval-card-btn--approve {
  background: var(--accent);
  color: var(--on-accent);
}
.rx-approval-card-btn--reject {
  border-color: var(--danger, var(--fail));
  color: var(--danger, var(--fail));
}
/* R20 — the destructive-gate confirm: a filled danger button so the second,
   deliberate step reads unmistakably as the irreversible action. */
.rx-approval-card-btn--confirm {
  border-color: var(--danger, var(--fail));
  background: var(--danger, var(--fail));
  color: var(--on-danger, #ffffff);
}
.rx-approval-card-btn:hover:not(:disabled) { opacity: 0.9; }
.rx-approval-card-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.rx-approval-card-caution {
  margin-top: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--danger, var(--fail));
}
.rx-approval-card-error,
.rx-approval-card-status {
  margin-top: 6px;
  font-size: 12px;
}
.rx-approval-card-error { color: var(--danger, var(--fail)); }
.rx-approval-card-status { color: var(--muted); }
.rx-approval-card-error[hidden],
.rx-approval-card-status[hidden] { display: none; }
`;
