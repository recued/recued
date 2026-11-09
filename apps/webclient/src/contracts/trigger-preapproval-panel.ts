/** D-341 slice B2b — "What it may do without asking", on a trigger's own page: a schedule's and an
 *  event trigger's detail under Automation, a webhook's card under Connections.
 *
 *  For each recipe the trigger starts (`collection.contract.triggerPreapprovalChoices`):
 *  - **Its pre-approvals** for this trigger, while they cover anything or say why not: what it
 *    makes without asking, in the owner's words, and what is left. **End it** asks once more.
 *  - **What it could make without asking:** each write its steps make that no live pre-approval
 *    covers, ticked to start with, how many times a run (at most 100), and **Allow without
 *    asking**. It lasts until the owner ends it (ruling 10: no end date, no use cap). A write that
 *    always asks is listed, not offered. For a recipe that asks an AI, the page says its AI decides
 *    what it writes (ruling 8).
 *  - **A scheduled prompt** (B3) lists its prompt and its pre-approvals, and offers none here: its
 *    changes are its AI's, so each is allowed from its own ask ("Always allow for this scheduled
 *    prompt"), which names exactly what it does.
 *
 *  The rpc family is `collection.contract.*`, which MCP never reaches: no AI grants one. Kept
 *  mounted across its route's refreshes, like the scheduled local writes panel. */

import {
  TRIGGER_PREAPPROVAL_AI_NOTE,
  TRIGGER_PREAPPROVAL_MAX_PER_RUN,
  TRIGGER_PREAPPROVAL_TRIGGER_NOUNS,
  triggerPreapprovalOption,
  triggerPreapprovalTerms,
  type TriggerPreapprovalChoice,
  type TriggerPreapprovalKind,
  type TriggerPreapprovalGrantRequest,
  type TriggerPreapprovalTrigger,
  type TriggerPreapprovalView,
} from '@recued/contracts';

import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';

export interface TriggerPreapprovalPanelCallers {
  readonly choices: (args: { trigger: TriggerPreapprovalTrigger }) => Promise<{ recipes: ReadonlyArray<TriggerPreapprovalChoice> }>;
  readonly grant: (args: TriggerPreapprovalGrantRequest) => Promise<{ preapproval: TriggerPreapprovalView }>;
  readonly revoke: (args: { id: string }) => Promise<{ preapproval: TriggerPreapprovalView }>;
}

/** D-341 — whether the paired server offers pre-approvals, asked once per page that shows them. A
 *  server from before them answers `unknown_method`. Its sections ("What it may do without asking")
 *  are then hidden, and so is any the page makes later, where each would have said it could not load.
 *  Until it answers, and when its read fails some other way (the panel says why once opened), they
 *  show. */
export interface TriggerPreapprovalSupport {
  /** A section the page made for `trigger`: hidden now if the server is known not to offer
   *  pre-approvals, or once it answers so. */
  show(section: HTMLElement, trigger: TriggerPreapprovalTrigger): void;
}

export const createTriggerPreapprovalSupport = (
  choices: TriggerPreapprovalPanelCallers['choices'],
): TriggerPreapprovalSupport => {
  let offered: boolean | undefined;
  let asking = false;
  const waiting = new Set<HTMLElement>();
  return {
    show(section, trigger) {
      if (offered === false) { section.hidden = true; return; }
      if (offered === true) return;
      waiting.add(section);
      if (asking) return;
      asking = true;
      void choices({ trigger }).then(() => { offered = true; waiting.clear(); }, (error: unknown) => {
        asking = false;
        // Any other failure says nothing of what the server offers: the next section asks again.
        if (classifyRpcError(error).code !== 'unknown_method') return;
        offered = false;
        for (const one of waiting) one.hidden = true;
        waiting.clear();
      });
    },
  };
};

export interface TriggerPreapprovalPanelMount {
  refresh(): Promise<void>;
  whenLoaded(): Promise<void>;
  /** Whether a grant or an end is in flight: its host keeps it mounted until it settles. */
  pending(): boolean;
  dispose(): void;
}

export const TRIGGER_PREAPPROVAL_PANEL_ATTR = 'data-recued-trigger-preapproval-panel';
export const TRIGGER_PREAPPROVAL_PANEL_RECIPE_ATTR = 'data-recued-trigger-preapproval-recipe';
export const TRIGGER_PREAPPROVAL_PANEL_ROW_ATTR = 'data-recued-trigger-preapproval-row';
export const TRIGGER_PREAPPROVAL_PANEL_END_ATTR = 'data-recued-trigger-preapproval-end';
export const TRIGGER_PREAPPROVAL_PANEL_CONFIRM_ATTR = 'data-recued-trigger-preapproval-confirm';
export const TRIGGER_PREAPPROVAL_PANEL_WRITE_ATTR = 'data-recued-trigger-preapproval-write';
export const TRIGGER_PREAPPROVAL_PANEL_PER_RUN_ATTR = 'data-recued-trigger-preapproval-per-run';
export const TRIGGER_PREAPPROVAL_PANEL_AI_ATTR = 'data-recued-trigger-preapproval-ai';
export const TRIGGER_PREAPPROVAL_PANEL_GRANT_ATTR = 'data-recued-trigger-preapproval-grant';
export const TRIGGER_PREAPPROVAL_PANEL_ERROR_ATTR = 'data-recued-trigger-preapproval-error';

/** How the trigger runs the recipe, said on the trigger's own page (the ask, about a recipe, says
 *  "its webhook"): "when this webhook runs it"; for an auto-run "when it runs on its own"; for a
 *  scheduled prompt, its own recipe, "when it runs on its schedule". */
const runsHere = (kind: TriggerPreapprovalKind): string =>
  kind === 'auto_run' ? 'when it runs on its own'
    : kind === 'prompt_schedule' ? 'when it runs on its schedule'
      : `when this ${TRIGGER_PREAPPROVAL_TRIGGER_NOUNS[kind]} runs it`;

/** Why a pre-approval covers nothing now, for the ones still listed. */
const IDLE: Readonly<Record<string, string>> = {
  outdated: 'Not in use: the recipe changed since.',
  detached: 'Not in use: this no longer runs the recipe as it did.',
};
/** D-341 slice B3 — a scheduled prompt's: its "recipe" is its prompt. */
const PROMPT_IDLE: Readonly<Record<string, string>> = {
  outdated: 'Not in use: its prompt changed since.',
  detached: 'Not in use: this scheduled prompt is gone.',
};

/** "Once a run · used 4 times · until you end it", or why it covers nothing now. */
const terms = (row: TriggerPreapprovalView): string =>
  (row.trigger.kind === 'prompt_schedule' ? PROMPT_IDLE : IDLE)[row.state] ?? triggerPreapprovalTerms(row);

/** The server's words, without the method name its refusals start with. */
const ownerWords = (error: unknown): string => humanizeRpcError(error).replace(/^collection\.contract\.\w+: /u, '');

/** A whole number within [1, ceiling], or null: never clamped past what the owner typed. */
const parseBound = (raw: string, ceiling: number): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= ceiling ? n : null;
};

export const mountTriggerPreapprovalPanel = (options: {
  readonly host: HTMLElement;
  readonly trigger: TriggerPreapprovalTrigger;
  readonly callers: TriggerPreapprovalPanelCallers;
  readonly document?: Document;
}): TriggerPreapprovalPanelMount => {
  const { host, trigger, callers } = options;
  const doc = options.document ?? host.ownerDocument;
  const root = doc.createElement('div');
  root.setAttribute(TRIGGER_PREAPPROVAL_PANEL_ATTR, '');
  // Focus waits here while a repaint has no control to put it on (Chromium drops it to <body>).
  root.tabIndex = -1;
  host.appendChild(root);

  let recipes: ReadonlyArray<TriggerPreapprovalChoice> | undefined;
  let listError: string | null = null;
  let actionError: { id: string; message: string } | null = null;
  let ending: string | null = null;
  let busy: string | null = null;
  let disposed = false;
  let generation = 0;
  let loading: Promise<void> = Promise.resolve();
  /** The owner's choices in each recipe's form, kept across a refresh. */
  const unticked = new Map<string, Set<string>>();
  const perRun = new Map<string, string>();
  /** The controls of the last paint, by what they are (`end:<id>`, `grant:<recipe>`), and the one the
   *  next paint puts focus back on: a repaint replaces every node, the focused one too. */
  const focusables = new Map<string, HTMLElement>();
  let focusNext: string | null = null;

  const el = (tag: string, className?: string, text?: string): HTMLElement => {
    const node = doc.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  /** While a grant or an end runs, every control says it is unavailable and does nothing: by
   *  `aria-disabled`, not `disabled`, so the one the owner pressed keeps focus (as the webhooks
   *  panel's actions do). */
  const button = (key: string, attr: string, className: string, label: string, onClick: () => void): HTMLButtonElement => {
    const node = el('button', className, label) as HTMLButtonElement;
    node.type = 'button';
    node.setAttribute(attr, '');
    if (busy !== null) node.setAttribute('aria-disabled', 'true');
    node.addEventListener('click', () => { if (busy === null) onClick(); });
    focusables.set(key, node);
    return node;
  };
  const working = (node: HTMLButtonElement): HTMLButtonElement => {
    node.textContent = 'Working…';
    node.setAttribute('aria-busy', 'true');
    return node;
  };
  const errorLine = (id: string): HTMLElement | null => {
    if (actionError === null || actionError.id !== id) return null;
    const line = el('p', 'tpa-error', actionError.message);
    line.setAttribute('role', 'alert');
    line.setAttribute(TRIGGER_PREAPPROVAL_PANEL_ERROR_ATTR, '');
    return line;
  };

  /** Run a grant or an end: focus stays on `pressed` while it runs, then goes to it again once the
   *  list shows what is so (to the panel when it is gone: the end that worked, the grant that left
   *  nothing to offer). One at a time. */
  const act = async (id: string, pressed: string, run: () => Promise<unknown>): Promise<void> => {
    if (busy !== null) return;
    busy = id;
    actionError = null;
    focusNext = pressed;
    render();
    try {
      await run();
      ending = null;
    } catch (error) {
      actionError = { id, message: ownerWords(error) };
    } finally {
      busy = null;
    }
    if (disposed) return;
    focusNext = pressed;
    await refresh();
  };

  const renderRow = (row: TriggerPreapprovalView): HTMLElement => {
    const card = el('div', 'tpa-row');
    card.setAttribute(TRIGGER_PREAPPROVAL_PANEL_ROW_ATTR, row.id);
    const info = el('div', 'tpa-info');
    info.appendChild(el('div', 'tpa-heading', `Without asking: ${row.write_labels.join('; ')}`));
    info.appendChild(el('div', 'tpa-terms', terms(row)));
    card.appendChild(info);
    const actions = el('div', 'tpa-actions');
    if (ending === row.id) {
      actions.appendChild(el('span', 'tpa-confirm-prompt', 'It asks again from now on.'));
      const confirm = button(`confirm:${row.id}`, TRIGGER_PREAPPROVAL_PANEL_CONFIRM_ATTR, 'tpa-danger', 'End it', () => {
        void act(row.id, `confirm:${row.id}`, () => callers.revoke({ id: row.id }));
      });
      actions.appendChild(busy === row.id ? working(confirm) : confirm);
      actions.appendChild(button(`cancel:${row.id}`, 'data-recued-trigger-preapproval-cancel', 'tpa-secondary', 'Cancel', () => {
        ending = null;
        focusNext = `end:${row.id}`;
        render();
      }));
    } else {
      actions.appendChild(button(`end:${row.id}`, TRIGGER_PREAPPROVAL_PANEL_END_ATTR, 'tpa-secondary', 'End it', () => {
        ending = row.id;
        actionError = null;
        focusNext = `confirm:${row.id}`;
        render();
      }));
    }
    card.appendChild(actions);
    const error = errorLine(row.id);
    if (error !== null) card.appendChild(error);
    return card;
  };

  const boundInput = (attr: string, label: string, value: string, ceiling: number, onInput: (value: string) => void): HTMLElement => {
    const wrap = el('label', 'tpa-bound');
    wrap.appendChild(el('span', undefined, label));
    const input = el('input', 'tpa-input') as HTMLInputElement;
    input.type = 'number';
    input.min = '1';
    input.max = String(ceiling);
    input.value = value;
    input.setAttribute(attr, '');
    input.addEventListener('input', () => onInput(input.value));
    wrap.appendChild(input);
    return wrap;
  };

  const renderForm = (choice: TriggerPreapprovalChoice): HTMLElement | null => {
    // A write a live pre-approval covers is not offered again: one grant says what it may do.
    const covered = new Set(choice.preapprovals.filter((row) => row.state === 'live').flatMap((row) => row.writes));
    const offerable = choice.writes.filter((write) => write.offerable && !covered.has(write.op));
    const asking = choice.writes.filter((write) => !write.offerable);
    const form = el('div', 'tpa-form');
    // D-341 slice B3 — a scheduled prompt's changes are its AI's, so none is listed here: each is
    // allowed from its own ask, which names exactly what it does.
    if (trigger.kind === 'prompt_schedule') {
      const answer = `“${triggerPreapprovalOption('prompt_schedule').label}”`;
      form.appendChild(el('p', 'tpa-copy', covered.size > 0
        ? `Its other changes still ask you. To stop asking about one, answer ${answer} on its ask.`
        : `Its changes ask you. To stop asking about one, answer ${answer} on its ask.`));
      return form;
    }
    if (offerable.length === 0 && asking.length === 0) {
      if (covered.size > 0) return null;
      form.appendChild(el('p', 'tpa-copy', 'It makes no change that asks you.'));
      return form;
    }
    const off = unticked.get(choice.recipe_id) ?? new Set<string>();
    unticked.set(choice.recipe_id, off);
    const chosen = perRun.get(choice.recipe_id) ?? '1';
    perRun.set(choice.recipe_id, chosen);
    if (offerable.length > 0) {
      form.appendChild(el('p', 'tpa-copy', `${covered.size > 0 ? 'Also let' : 'Let'} these happen without asking `
        + `${runsHere(trigger.kind)}:`));
      for (const write of offerable) {
        const line = el('label', 'tpa-write');
        const box = el('input') as HTMLInputElement;
        box.type = 'checkbox';
        box.checked = !off.has(write.op);
        box.setAttribute(TRIGGER_PREAPPROVAL_PANEL_WRITE_ATTR, write.op);
        box.addEventListener('change', () => {
          if (box.checked) off.delete(write.op);
          else off.add(write.op);
        });
        line.appendChild(box);
        line.appendChild(el('span', undefined, write.label));
        form.appendChild(line);
      }
    }
    for (const write of asking) {
      form.appendChild(el('p', 'tpa-asks', `Always asks: ${write.label}. ${write.reason ?? ''}`.trim()));
    }
    if (offerable.length === 0) return form;
    const row = el('div', 'tpa-bounds');
    row.appendChild(boundInput(TRIGGER_PREAPPROVAL_PANEL_PER_RUN_ATTR, 'Times a run', chosen,
      TRIGGER_PREAPPROVAL_MAX_PER_RUN, (value) => { perRun.set(choice.recipe_id, value); }));
    form.appendChild(row);
    form.appendChild(el('p', 'tpa-asks', 'It stays on until you end it.'));
    const id = `grant:${choice.recipe_id}`;
    const actions = el('div', 'tpa-actions');
    const grant = button(id, TRIGGER_PREAPPROVAL_PANEL_GRANT_ATTR, 'tpa-primary', 'Allow without asking', () => {
      const writes = offerable.map((write) => write.op).filter((op) => !off.has(op));
      const per_run = parseBound(perRun.get(choice.recipe_id) ?? '1', TRIGGER_PREAPPROVAL_MAX_PER_RUN);
      if (writes.length === 0) {
        actionError = { id, message: 'Tick at least one change to allow.' };
        focusNext = id;
        render();
        return;
      }
      if (per_run === null) {
        actionError = { id, message: `Times a run is a whole number from 1 to ${TRIGGER_PREAPPROVAL_MAX_PER_RUN}.` };
        focusNext = id;
        render();
        return;
      }
      void act(id, id, () => callers.grant({ trigger, recipe_id: choice.recipe_id, writes, max_per_run: per_run }));
    });
    actions.appendChild(busy === id ? working(grant) : grant);
    form.appendChild(actions);
    const error = errorLine(id);
    if (error !== null) form.appendChild(error);
    return form;
  };

  function render(): void {
    if (disposed) return;
    // Focus is the panel's to put back only while it is in the panel, or went with a node it replaced:
    // an owner who moved on while a grant ran keeps their place.
    const active = doc.activeElement;
    const ours = active === null || active === undefined || active === doc.body || root.contains?.(active) === true;
    focusables.clear();
    while (root.firstChild) root.removeChild(root.firstChild);
    paint();
    if (focusNext === null) return;
    const key = focusNext;
    focusNext = null;
    if (ours) (focusables.get(key) ?? root).focus?.({ preventScroll: true });
  }

  function paint(): void {
    root.setAttribute('aria-busy', String(recipes === undefined && listError === null));
    if (listError !== null) {
      const line = el('p', 'tpa-error', `Recued could not load what this may do without asking: ${listError}`);
      line.setAttribute('role', 'alert');
      line.setAttribute(TRIGGER_PREAPPROVAL_PANEL_ERROR_ATTR, '');
      root.appendChild(line);
    }
    if (recipes === undefined) {
      if (listError === null) root.appendChild(el('p', 'tpa-copy', 'Loading…'));
      return;
    }
    if (recipes.length === 0) {
      root.appendChild(el('p', 'tpa-copy', trigger.kind === 'prompt_schedule'
        ? 'Recued could not read this scheduled prompt now.' : 'It runs no recipe now.'));
      return;
    }
    for (const choice of recipes) {
      const section = el('section', 'tpa-recipe');
      section.setAttribute(TRIGGER_PREAPPROVAL_PANEL_RECIPE_ATTR, choice.recipe_id);
      // Named every time: "when this webhook runs it" says nothing until the owner knows what "it" is.
      section.appendChild(el('h4', 'tpa-recipe-name', choice.recipe_name));
      if (choice.ai_steps.length > 0) {
        const note = el('p', 'tpa-copy', TRIGGER_PREAPPROVAL_AI_NOTE);
        note.setAttribute(TRIGGER_PREAPPROVAL_PANEL_AI_ATTR, '');
        section.appendChild(note);
      }
      for (const row of choice.preapprovals) {
        if (row.state === 'live' || row.state === 'outdated' || row.state === 'detached') section.appendChild(renderRow(row));
      }
      const form = renderForm(choice);
      if (form !== null) section.appendChild(form);
      root.appendChild(section);
    }
  }

  const refresh = (): Promise<void> => {
    const mine = (generation += 1);
    loading = (async () => {
      try {
        const { recipes: listed } = await callers.choices({ trigger });
        if (disposed || mine !== generation) return;
        recipes = listed;
        listError = null;
      } catch (error) {
        if (disposed || mine !== generation) return;
        // A server from before pre-approvals: the section goes, as its page's others do
        // (`createTriggerPreapprovalSupport`), rather than saying it could not load.
        if (recipes === undefined && classifyRpcError(error).code === 'unknown_method') {
          host.hidden = true;
          root.remove();
          return;
        }
        listError = ownerWords(error);
      }
      render();
    })();
    return loading;
  };

  render();
  void refresh();

  return {
    refresh,
    whenLoaded: () => loading,
    pending: () => busy !== null,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try { host.removeChild(root); } catch { /* a detached host */ }
    },
  };
};

/** Self-scoped CSS, joined into each host route's one `<style>` bundle. ⚠ Its host can style bare
 *  elements (the webhooks panel sets every `label` bold and every `input` full width), so each
 *  rule here says what it needs rather than inheriting it. */
export const TRIGGER_PREAPPROVAL_PANEL_STYLES = `
[${TRIGGER_PREAPPROVAL_PANEL_ATTR}] { display: grid; gap: 10px; }
[${TRIGGER_PREAPPROVAL_PANEL_ATTR}] .tpa-recipe { display: grid; gap: 8px; }
[${TRIGGER_PREAPPROVAL_PANEL_ATTR}] .tpa-recipe-name { margin: 0; font-size: 14px; }
[${TRIGGER_PREAPPROVAL_PANEL_ATTR}] .tpa-copy { margin: 0; font-size: 13px; color: var(--muted); line-height: 1.45; }
[${TRIGGER_PREAPPROVAL_PANEL_ATTR}] .tpa-row {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px;
}
[${TRIGGER_PREAPPROVAL_PANEL_ATTR}] .tpa-info { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
[${TRIGGER_PREAPPROVAL_PANEL_ATTR}] .tpa-heading { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
[${TRIGGER_PREAPPROVAL_PANEL_ATTR}] .tpa-terms, [${TRIGGER_PREAPPROVAL_PANEL_ATTR}] .tpa-asks { font-size: 12px; color: var(--muted); margin: 0; }
[${TRIGGER_PREAPPROVAL_PANEL_ATTR}] .tpa-form { display: grid; gap: 8px; }
[${TRIGGER_PREAPPROVAL_PANEL_ATTR}] .tpa-write {
  display: flex; gap: 8px; align-items: flex-start; font-size: 13px; font-weight: 400; color: var(--fg); overflow-wrap: anywhere;
}
[${TRIGGER_PREAPPROVAL_PANEL_ATTR}] .tpa-write input { width: auto; flex: none; margin: 2px 0 0; }
[${TRIGGER_PREAPPROVAL_PANEL_ATTR}] .tpa-bounds { display: flex; flex-wrap: wrap; gap: 8px; }
[${TRIGGER_PREAPPROVAL_PANEL_ATTR}] .tpa-bound {
  display: flex; flex-direction: column; gap: 2px; font-size: 11px; font-weight: 400; color: var(--muted);
}
[${TRIGGER_PREAPPROVAL_PANEL_ATTR}] .tpa-input {
  width: 90px; font-size: 13px; padding: 3px 6px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--surface); color: var(--fg);
}
[${TRIGGER_PREAPPROVAL_PANEL_ATTR}] .tpa-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
[${TRIGGER_PREAPPROVAL_PANEL_ATTR}] .tpa-confirm-prompt { font-size: 12px; color: var(--fail); }
[${TRIGGER_PREAPPROVAL_PANEL_ATTR}] .tpa-error { font-size: 13px; color: var(--fail); margin: 0; flex-basis: 100%; }
[${TRIGGER_PREAPPROVAL_PANEL_ATTR}] .tpa-primary,
[${TRIGGER_PREAPPROVAL_PANEL_ATTR}] .tpa-secondary,
[${TRIGGER_PREAPPROVAL_PANEL_ATTR}] .tpa-danger {
  font-size: 13px; padding: 4px 12px; border-radius: 6px; background: var(--surface); cursor: pointer; white-space: nowrap;
  min-height: 32px;
}
[${TRIGGER_PREAPPROVAL_PANEL_ATTR}] .tpa-primary { border: 1px solid var(--accent); color: var(--accent); }
[${TRIGGER_PREAPPROVAL_PANEL_ATTR}] .tpa-secondary { border: 1px solid var(--border); color: var(--fg); }
[${TRIGGER_PREAPPROVAL_PANEL_ATTR}] .tpa-danger { border: 1px solid var(--fail); color: var(--fail); }
[${TRIGGER_PREAPPROVAL_PANEL_ATTR}] button[aria-disabled="true"] { opacity: 0.6; cursor: default; }
`;
