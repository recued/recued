/** D-219 item 2b — `#kitchen/new/execution-case/<draft_key>`: the Kitchen,
 *  opened on a recipe the owner's own model just wrote.
 *
 *  ⛔ **IT DOES NOT REGENERATE.** The sibling form-response seed route rebuilds
 *  its draft from the route's own form id, so a refresh costs nothing. This one
 *  cannot: rebuilding means another slow call against the owner's model quota,
 *  and doing that because a hash was revisited would spend it without them
 *  asking. An unmatched key is a NOT-FOUND with a way back, not a regeneration.
 *
 *  ⛔ **AND THE EDITOR IS THE ORDINARY ONE.** Validating and saving a
 *  machine-written recipe is exactly the manual authoring path — there is no
 *  separate blessing for one, and no "AI-approved" shortcut past the review that
 *  is the whole reason this lands in an editor rather than in the recipe store.
 */

import type { DraftRecovery } from './editor-history.js';
import { humanizeRpcError } from '../../shell/rpc-error-copy.js';
import { serializeShellRoute } from '../../shell/route.js';
import type { StashedExecutionCaseDraft } from './execution-case-draft-stash.js';
import {
  bootstrapRecipeEditorRoute,
  type RecipeEditorRoute,
} from './recipe-editor-route.js';
import type { MountRecipeEditorRoute } from './mount-recipe-editor-route.js';

export const EXECUTION_CASE_DRAFT_HOST_ATTR =
  'data-recued-execution-case-draft';
export const EXECUTION_CASE_DRAFT_MISSING_ATTR =
  'data-recued-execution-case-draft-missing';
/** Shown when the owner's request could not be safely aliased and was withheld
 *  from the authoring model. */
export const EXECUTION_CASE_DRAFT_THIN_ATTR =
  'data-recued-execution-case-draft-thin';
export const EXECUTION_CASE_DRAFT_BACK_ATTR =
  'data-recued-execution-case-draft-back';
/** D-219 — the refine control: ask the model to revise the draft on screen. */
export const EXECUTION_CASE_DRAFT_REFINE_ATTR =
  'data-recued-execution-case-draft-refine';
export const EXECUTION_CASE_DRAFT_REFINE_PANEL_ATTR =
  'data-recued-execution-case-draft-refine-panel';
export const EXECUTION_CASE_DRAFT_REFINE_PROMPT_ATTR =
  'data-recued-execution-case-draft-refine-prompt';
export const EXECUTION_CASE_DRAFT_REFINE_ERROR_ATTR =
  'data-recued-execution-case-draft-refine-error';

const EXECUTION_CASE_DRAFT_STYLES_MARKER =
  'data-recued-execution-case-draft-styles';

const EXECUTION_CASE_DRAFT_STYLES = `
[${EXECUTION_CASE_DRAFT_HOST_ATTR}] .execution-case-refine {
  display: grid;
  gap: 14px;
  margin: 0 0 20px;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background:
    linear-gradient(135deg, var(--accent-weak), transparent 42%),
    var(--surface);
  box-shadow: 0 1px 2px rgba(24, 24, 27, 0.04);
}
[${EXECUTION_CASE_DRAFT_HOST_ATTR}] .execution-case-refine-header {
  display: grid;
  gap: 4px;
}
[${EXECUTION_CASE_DRAFT_HOST_ATTR}] .execution-case-refine-eyebrow {
  color: var(--accent);
  font-size: 10px;
  font-weight: 750;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
[${EXECUTION_CASE_DRAFT_HOST_ATTR}] .execution-case-refine h2 {
  margin: 0;
  color: var(--fg-strong);
  font-size: 17px;
  letter-spacing: -0.01em;
}
[${EXECUTION_CASE_DRAFT_HOST_ATTR}] .execution-case-refine-copy,
[${EXECUTION_CASE_DRAFT_HOST_ATTR}] .execution-case-refine-status {
  margin: 0;
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 1.45;
}
[${EXECUTION_CASE_DRAFT_HOST_ATTR}] .execution-case-refine-field {
  display: grid;
  gap: 6px;
  color: var(--fg-muted);
  font-size: 12px;
  font-weight: 650;
}
[${EXECUTION_CASE_DRAFT_HOST_ATTR}] .execution-case-refine textarea {
  width: 100%;
  min-height: 76px;
  box-sizing: border-box;
  resize: vertical;
  border: 1px solid var(--border-strong);
  border-radius: 9px;
  padding: 10px 11px;
  background: var(--surface);
  color: var(--fg);
  font: inherit;
  font-size: 13px;
  line-height: 1.4;
}
[${EXECUTION_CASE_DRAFT_HOST_ATTR}] .execution-case-refine textarea:focus-visible,
[${EXECUTION_CASE_DRAFT_HOST_ATTR}] .execution-case-refine button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
[${EXECUTION_CASE_DRAFT_HOST_ATTR}] .execution-case-refine-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
[${EXECUTION_CASE_DRAFT_HOST_ATTR}] .execution-case-refine button {
  min-height: 38px;
  border: 1px solid var(--accent);
  border-radius: 8px;
  padding: 8px 14px;
  background: var(--accent);
  color: var(--on-accent);
  font: inherit;
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
}
[${EXECUTION_CASE_DRAFT_HOST_ATTR}] .execution-case-refine button:hover:not([aria-disabled="true"]) {
  filter: brightness(1.05);
}
[${EXECUTION_CASE_DRAFT_HOST_ATTR}] .execution-case-refine button[aria-disabled="true"] {
  cursor: progress;
  opacity: 0.7;
}
[${EXECUTION_CASE_DRAFT_HOST_ATTR}] .execution-case-refine-status {
  flex: 1 1 240px;
  min-height: 1.45em;
}
`;

const injectExecutionCaseDraftStyles = (doc: Document): void => {
  if (doc.head.querySelector(
    `style[${EXECUTION_CASE_DRAFT_STYLES_MARKER}]`,
  ) !== null) return;
  const style = doc.createElement('style');
  style.setAttribute(EXECUTION_CASE_DRAFT_STYLES_MARKER, '');
  style.textContent = EXECUTION_CASE_DRAFT_STYLES;
  doc.head.appendChild(style);
};

export interface MountExecutionCaseDraftRouteOptions {
  recovery?: DraftRecovery;
  root: HTMLElement;
  /** Null when the key matched nothing — a stale hash, another tab's draft, or
   *  a storage the browser cleared. */
  draft: StashedExecutionCaseDraft | null;
  validateCaller: Parameters<typeof bootstrapRecipeEditorRoute>[0]['validateCaller'];
  simulateCaller?: Parameters<typeof bootstrapRecipeEditorRoute>[0]['simulateCaller'];
  saveCaller: Parameters<typeof bootstrapRecipeEditorRoute>[0]['saveCaller'];
  onSaved?: Parameters<typeof bootstrapRecipeEditorRoute>[0]['onSaved'];
  /** D-219 — iterative refinement. Wired as a PAIR with `onRefined`: a control
   *  that produces a revision nothing then opens is a dead end, and an
   *  expensive one. Absent ⇒ no refine control renders at all, and the route is
   *  exactly the one that shipped before. */
  runDraftRecipe?: (args: {
    case_id: string;
    prompt: string;
    previous_recipe: unknown;
  }) => Promise<{
    ok: boolean;
    recipe?: unknown;
    issues: string[];
    reason?: string;
    request_aliased?: boolean;
  }>;
  /** Hands the revision back. The shell re-stashes it and reopens the route, so
   *  this module never learns a Kitchen route. Returns false when the hand-off
   *  could not be completed. */
  onRefined?: (draft: {
    case_id: string;
    recipe: unknown;
    request_aliased: boolean;
    /** True when this route is already disposed: STASH the revision, but do not
     *  navigate. A call the owner paid for must survive them leaving; it must
     *  not steal the page back. */
    silent?: boolean;
  }) => boolean | void;
  /** Server-owned cost copy, threaded rather than restated — a refinement costs
   *  the same as a first draft and the owner must be told the same thing. */
  refineConfirmation?: string;
  /** D-219 — called after the owner SAVES, so the Learning list can say they
   *  already made a recipe from this case.
   *
   *  ⚠ BEST EFFORT, and deliberately after the save rather than part of it: the
   *  recipe is what mattered. A rejected promise here must never surface as a
   *  save failure. */
  onAuthored?: (input: { case_id: string; recipe_id: string }) => void;
  document?: Document;
}

/** ⚠ Widened over `MountRecipeEditorRoute` with ONE test seam. The shell only
 *  ever uses the base shape; `whenRefineSettled` exists so a test can await an
 *  in-flight revision without sleeping. */
export type MountExecutionCaseDraftRoute = MountRecipeEditorRoute & {
  whenRefineSettled(): Promise<void>;
};

export const mountExecutionCaseDraftRoute = (
  options: MountExecutionCaseDraftRouteOptions,
): MountExecutionCaseDraftRoute => {
  const doc = options.document ?? globalThis.document;
  const host = doc.createElement('section');
  host.setAttribute(
    EXECUTION_CASE_DRAFT_HOST_ATTR,
    options.draft?.case_id ?? 'missing',
  );
  options.root.appendChild(host);

  const backLink = (): HTMLElement => {
    const back = doc.createElement('a');
    back.setAttribute(EXECUTION_CASE_DRAFT_BACK_ATTR, '');
    back.setAttribute('href', serializeShellRoute('settings'));
    back.textContent = '← Back to Learning';
    return back;
  };

  if (options.draft === null) {
    // ⚠ Says what to DO, not just that something is absent. The draft lived in
    // this tab's session; a person arriving from a bookmark or a second tab has
    // no way to know that, and "generate it again" is the only move.
    const line = doc.createElement('p');
    line.setAttribute(EXECUTION_CASE_DRAFT_MISSING_ATTR, '');
    line.textContent =
      'That draft is gone. It only ever lived in the tab that '
      + 'made it, and it is not saved anywhere. Open Settings, then Learning, and '
      + 'make a Recipe from it again.';
    host.appendChild(line);
    host.appendChild(backLink());
    return {
      dispose: () => {
        host.remove();
      },
      // Nothing mounted, so there is nothing to lose — the leave guard must not
      // block on a draft that never opened.
      hasUnsavedChanges: () => false,
      hasInFlightWork: () => false,
      whenRefineSettled: () => Promise.resolve(),
    };
  }

  if (!options.draft.request_aliased) {
    // ⛔ Said out loud, because the owner cannot otherwise tell WHY the draft is
    // thin. Their request was withheld from the model — it could not be safely
    // aliased — so the model worked from the tool shape and their instruction
    // alone. Silence here would read as "your AI is not very good".
    const note = doc.createElement('p');
    note.setAttribute(EXECUTION_CASE_DRAFT_THIN_ATTR, '');
    note.textContent =
      'Recued did not send your original words to the AI. It could not '
      + 'tell which parts were personal, and it will not send them '
      + 'unprotected. This draft comes from the steps alone, so expect '
      + 'to fill in more than usual.';
    host.appendChild(note);
  }

  let editor: RecipeEditorRoute | undefined;
  /** Test seam: resolves once an in-flight refinement has settled. */
  let refineSettled: () => Promise<void> = () => Promise.resolve();
  /** ⛔ A refinement that lands after the owner has left must still be SAVED but
   *  must not drag them back — the same rule the first draft follows. */
  let disposed = false;
  const canRefine = options.runDraftRecipe !== undefined
    && options.onRefined !== undefined;
  const refineBlock = canRefine ? doc.createElement('section') : undefined;
  if (refineBlock !== undefined) {
    injectExecutionCaseDraftStyles(doc);
    refineBlock.className = 'execution-case-refine';
    refineBlock.setAttribute(EXECUTION_CASE_DRAFT_REFINE_PANEL_ATTR, '');
    refineBlock.setAttribute('aria-label', 'Change the AI draft');
    // Keep the revision affordance discoverable before a potentially enormous
    // recipe. It still sends editor.getRecipe() at click time, so manual edits
    // made below are included even though this panel precedes the editor.
    host.appendChild(refineBlock);
  }
  try {
    editor = bootstrapRecipeEditorRoute({
      recovery: options.recovery,
      root: host,
      ...(options.document !== undefined ? { document: options.document } : {}),
      initialRecipe: options.draft.recipe as never,
      // ⛔ DIRTY FROM THE MOMENT IT MOUNTS. Nothing is saved yet, and the shell's
      // unsaved-work guard is what stops a stray navigation discarding a draft
      // the owner just paid for.
      initialDirty: true,
      validateCaller: options.validateCaller,
      simulateCaller: options.simulateCaller,
      saveCaller: options.saveCaller,
      onSaved: (saved) => {
        // ⛔ RECORD FIRST, then forward. `onSaved` navigates away in the shell,
        // and a call made after that has no reason to survive.
        // ⚠ Swallowed on purpose — see `onAuthored`'s note. The owner's recipe
        // is saved either way, and an annotation is not worth a scary dialog.
        try {
          options.onAuthored?.({
            case_id: options.draft!.case_id,
            recipe_id: (saved as { recipe_id?: string } | undefined)?.recipe_id
              ?? (editor?.getRecipe().recipe_id ?? ''),
          });
        } catch { /* annotation only */ }
        options.onSaved?.(saved as never);
      },
    });
  } catch (error) {
    refineBlock?.remove();
    const line = doc.createElement('p');
    line.setAttribute(EXECUTION_CASE_DRAFT_MISSING_ATTR, '');
    line.textContent =
      `Recued could not open that draft: ${humanizeRpcError(error)}`;
    host.appendChild(line);
    host.appendChild(backLink());
  }

  // ── D-219: refine the draft on screen ──────────────────────────
  //
  //  ⛔ SENDS WHAT THE OWNER CURRENTLY HAS, not the draft that arrived. By the
  //  time they refine they may have renamed steps or filled in variables, and
  //  sending the original would silently discard that work — the owner would
  //  watch their edits vanish into a "refinement". `editor.getRecipe()` is the
  //  live value.
  //
  //  ⛔ TWO PRESSES, like the first draft: this is the same slow, quota-spending
  //  call, and an accidental click must not make it.
  if (canRefine && editor !== undefined && refineBlock !== undefined) {
    const draft = options.draft;
    const block = refineBlock;
    let armed = false;
    let busy = false;

    const header = doc.createElement('div');
    header.className = 'execution-case-refine-header';
    const eyebrow = doc.createElement('span');
    eyebrow.className = 'execution-case-refine-eyebrow';
    eyebrow.textContent = 'AI draft';
    header.appendChild(eyebrow);
    const heading = doc.createElement('h2');
    heading.textContent = 'Change this draft';
    header.appendChild(heading);
    const copy = doc.createElement('p');
    copy.className = 'execution-case-refine-copy';
    copy.textContent =
      'Say what one thing should change. Recued includes the edits you have made, and '
      + 'asks you before it spends anything.';
    header.appendChild(copy);
    block.appendChild(header);

    const instruction = doc.createElement('textarea');
    instruction.setAttribute(EXECUTION_CASE_DRAFT_REFINE_PROMPT_ATTR, '');
    instruction.setAttribute('aria-label', 'What should change?');
    instruction.rows = 3;
    instruction.setAttribute(
      'placeholder',
      'What should be different? For example: only my own meetings, and send it on Mondays.',
    );

    const button = doc.createElement('button');
    button.setAttribute('type', 'button');
    button.setAttribute(EXECUTION_CASE_DRAFT_REFINE_ATTR, draft.case_id);

    const note = doc.createElement('p');
    note.setAttribute(EXECUTION_CASE_DRAFT_REFINE_ERROR_ATTR, '');
    note.className = 'execution-case-refine-status';
    note.setAttribute('role', 'status');
    note.setAttribute('aria-live', 'polite');

    const paint = (): void => {
      button.textContent = busy
        ? 'Asking your AI…'
        : armed ? 'Yes, change it' : 'Ask your AI to change this';
      // This is the keyboard owner's exact control through the slow, paid
      // request. Native `disabled` blurs it to <body> in Chromium; keep it in
      // the tab order and let the busy guard above enforce single-flight.
      if (busy) {
        button.setAttribute('aria-disabled', 'true');
        button.setAttribute('aria-busy', 'true');
      } else {
        button.removeAttribute('aria-disabled');
        button.removeAttribute('aria-busy');
      }
      // ⚠ The instruction is REQUIRED to arm: "revise it" with nothing said is a
      // second call that spends the owner's quota to produce the same thing.
      note.textContent = armed && instruction.value.trim().length === 0
        ? 'Say what should change first.'
        : note.textContent;
    };

    let pending: Promise<void> | undefined;
    button.addEventListener('click', () => {
      if (busy) return;
      if (instruction.value.trim().length === 0) {
        note.textContent = 'Say what should change first.';
        return;
      }
      if (!armed) {
        armed = true;
        note.textContent = options.refineConfirmation ?? '';
        paint();
        return;
      }
      busy = true;
      armed = false;
      note.textContent = '';
      paint();
      pending = (async () => {
        try {
          const result = await options.runDraftRecipe!({
            case_id: draft.case_id,
            prompt: instruction.value,
            previous_recipe: editor!.getRecipe(),
          });
          if (!result.ok || result.recipe === undefined) {
            note.textContent = result.reason === 'already_running'
              ? result.issues[0] ?? 'A new version is already being written.'
              : result.issues.length > 0
                ? `What your AI wrote was not a working Recipe: ${result.issues[0]}`
                : 'Your AI did not give back a Recipe. Try saying more about what '
                  + 'should change.';
            return;
          }
          const handed = options.onRefined!({
            case_id: draft.case_id,
            recipe: result.recipe,
            request_aliased: result.request_aliased !== false,
            // The shell stashes regardless and skips the navigation when true.
            silent: disposed,
          });
          if (disposed) return;
          if (handed === false) {
            note.textContent = 'Your AI wrote it, but this browser '
              + 'could not open it. Make some room and try again.';
          }
        } catch (error) {
          note.textContent = humanizeRpcError(error);
        } finally {
          busy = false;
          paint();
        }
      })();
    });

    paint();
    const field = doc.createElement('label');
    field.className = 'execution-case-refine-field';
    const fieldLabel = doc.createElement('span');
    fieldLabel.textContent = 'What should change?';
    field.appendChild(fieldLabel);
    field.appendChild(instruction);
    block.appendChild(field);
    const actions = doc.createElement('div');
    actions.className = 'execution-case-refine-actions';
    actions.appendChild(button);
    actions.appendChild(note);
    block.appendChild(actions);
    refineSettled = () => pending ?? Promise.resolve();
  }

  return {
    dispose: () => {
      disposed = true;
      editor?.dispose();
      host.remove();
    },
    // ⛔ The leave guard, and it is load-bearing here in a way it is not for a
    // rebuildable seed: navigating away discards a draft the owner PAID for and
    // this route cannot regenerate it.
    hasUnsavedChanges: () => editor?.hasUnsavedChanges() ?? false,
    whenRefineSettled: () => refineSettled(),
    hasInFlightWork: () => editor?.hasInFlightWork() ?? false,
  };
};
