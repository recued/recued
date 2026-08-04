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
export const EXECUTION_CASE_DRAFT_REFINE_PROMPT_ATTR =
  'data-recued-execution-case-draft-refine-prompt';
export const EXECUTION_CASE_DRAFT_REFINE_ERROR_ATTR =
  'data-recued-execution-case-draft-refine-error';

export interface MountExecutionCaseDraftRouteOptions {
  root: HTMLElement;
  /** Null when the key matched nothing — a stale hash, another tab's draft, or
   *  a storage the browser cleared. */
  draft: StashedExecutionCaseDraft | null;
  validateCaller: Parameters<typeof bootstrapRecipeEditorRoute>[0]['validateCaller'];
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
      'That draft is no longer available — it lives only in the tab that '
      + 'generated it, and is not saved anywhere. Open Settings → Learning and '
      + 'make a recipe from the turn again.';
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
      'Your original request was not sent to the AI — Recued could not '
      + 'establish which parts of it were personal, and does not send it '
      + 'unprotected. This draft was written from the steps alone, so expect '
      + 'to fill in more of it than usual.';
    host.appendChild(note);
  }

  let editor: RecipeEditorRoute | undefined;
  /** Test seam: resolves once an in-flight refinement has settled. */
  let refineSettled: () => Promise<void> = () => Promise.resolve();
  /** ⛔ A refinement that lands after the owner has left must still be SAVED but
   *  must not drag them back — the same rule the first draft follows. */
  let disposed = false;
  try {
    editor = bootstrapRecipeEditorRoute({
      root: host,
      ...(options.document !== undefined ? { document: options.document } : {}),
      initialRecipe: options.draft.recipe as never,
      // ⛔ DIRTY FROM THE MOMENT IT MOUNTS. Nothing is saved yet, and the shell's
      // unsaved-work guard is what stops a stray navigation discarding a draft
      // the owner just paid for.
      initialDirty: true,
      validateCaller: options.validateCaller,
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
    const line = doc.createElement('p');
    line.setAttribute(EXECUTION_CASE_DRAFT_MISSING_ATTR, '');
    line.textContent =
      `Couldn't open that draft: ${humanizeRpcError(error)}`;
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
  if (
    options.runDraftRecipe !== undefined
    && options.onRefined !== undefined
    && editor !== undefined
  ) {
    const draft = options.draft;
    const block = doc.createElement('div');
    let armed = false;
    let busy = false;

    const instruction = doc.createElement('textarea');
    instruction.setAttribute(EXECUTION_CASE_DRAFT_REFINE_PROMPT_ATTR, '');
    instruction.setAttribute(
      'placeholder',
      'What should be different? (e.g. only my own meetings, and send it on Mondays)',
    );

    const button = doc.createElement('button');
    button.setAttribute('type', 'button');
    button.setAttribute(EXECUTION_CASE_DRAFT_REFINE_ATTR, draft.case_id);

    const note = doc.createElement('p');
    note.setAttribute(EXECUTION_CASE_DRAFT_REFINE_ERROR_ATTR, '');

    const paint = (): void => {
      button.textContent = busy
        ? 'Asking your AI...'
        : armed ? 'Yes, revise it' : 'Ask AI to revise this';
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
              ? result.issues[0] ?? 'A revision is already being written.'
              : result.issues.length > 0
                ? `Your AI's revision was not a valid recipe: ${result.issues[0]}`
                : 'Your AI did not return a recipe. Try saying more about what '
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
            note.textContent = 'Your AI wrote the revision, but this browser '
              + 'could not open it. Free up space and try again.';
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
    block.appendChild(instruction);
    block.appendChild(button);
    block.appendChild(note);
    host.appendChild(block);
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
