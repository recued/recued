/** D-333 — Kitchen home: start something, or pick up work in progress.
 *
 *  Recipes and packs are the things you keep; they live in Recipes and Packs. Kitchen keeps
 *  only what you have not finished: a new recipe, a new pack, changes to a saved recipe, or
 *  source an AI app handed over. Each item stays here until it is saved as the real thing or
 *  discarded. */
import type { IngredientDraftSummary, KitchenWorkItem, KitchenWorkItemList } from '@recued/contracts';
import { renderActionLabel } from '@recued/ui-shared';
import { serializeShellRoute } from '../shell/route.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

export const KITCHEN_HOME_ATTR = 'data-recued-kitchen-home';
export const KITCHEN_HOME_ITEM_ATTR = 'data-recued-kitchen-home-item';

const KITCHEN_HOME_STYLES = `
[${KITCHEN_HOME_ATTR}] {
  box-sizing: border-box;
  max-width: 1200px;
  margin: 0 auto;
  padding: 16px 24px 32px;
}
[${KITCHEN_HOME_ATTR}] .kitchen-home-start { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
[${KITCHEN_HOME_ATTR}] .kitchen-home-start > a { display: inline-flex; align-items: center; min-height: 44px; }
[${KITCHEN_HOME_ATTR}] .kitchen-home-list { list-style: none; margin: 0; padding: 0; }
[${KITCHEN_HOME_ITEM_ATTR}] {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 16px;
  padding: 12px 0;
  border-top: 1px solid var(--border);
}
[${KITCHEN_HOME_ATTR}] .kitchen-home-row-info { display: contents; }
[${KITCHEN_HOME_ATTR}] .kitchen-home-actions { margin-left: auto; display: flex; gap: 8px; }
[${KITCHEN_HOME_ATTR}] .kitchen-home-action { display: inline-flex; align-items: center; gap: 6px; }
[${KITCHEN_HOME_ATTR}] .kitchen-home-action > svg { flex-shrink: 0; }
[${KITCHEN_HOME_ATTR}] .kitchen-home-action[aria-busy="true"] { cursor: wait; opacity: 0.65; }

@media (min-width: 1280px) and (hover: hover) and (pointer: fine) {
  [${KITCHEN_HOME_ATTR}] .kitchen-home-lead { margin: 0 0 16px; color: var(--fg-muted); }
  [${KITCHEN_HOME_ATTR}] .kitchen-home-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 28%);
    align-items: start;
    gap: var(--wc-space-lg, 24px);
  }
  [${KITCHEN_HOME_ATTR}] .kitchen-home-layout > * {
    min-width: 0;
    padding: 16px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--wc-radius-lg, 14px);
  }
  [${KITCHEN_HOME_ATTR}] .kitchen-home-queue { grid-area: 1 / 1; }
  [${KITCHEN_HOME_ATTR}] .kitchen-home-start {
    grid-area: 1 / 2;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px 8px;
  }
  [${KITCHEN_HOME_ATTR}] .kitchen-home-start > span {
    grid-column: 1 / -1;
    color: var(--fg-muted);
    font-size: 13px;
  }
  [${KITCHEN_HOME_ATTR}] .kitchen-home-start > a,
  [${KITCHEN_HOME_ATTR}] .kitchen-home-actions > :is(a, button) {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: var(--wc-control-h, 40px);
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: var(--wc-radius, 9px);
    background: var(--surface);
    color: var(--fg);
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    text-align: center;
    text-decoration: none;
  }
  [${KITCHEN_HOME_ATTR}] .kitchen-home-start > a:first-child {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--on-accent);
  }
  [${KITCHEN_HOME_ATTR}] .kitchen-home-actions > a { color: var(--accent); }
  [${KITCHEN_HOME_ATTR}] .kitchen-home-actions > button:not([aria-disabled="true"]) { cursor: pointer; }
  [${KITCHEN_HOME_ATTR}] .kitchen-home-actions > button:hover { color: var(--danger); }
  [${KITCHEN_HOME_ATTR}] :is(a, button):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  [${KITCHEN_HOME_ATTR}] .kitchen-home-queue h2 { margin: 0 0 12px; color: var(--fg-strong); font-size: 16px; }
  [${KITCHEN_HOME_ATTR}] .kitchen-home-status { margin: 0; color: var(--fg-muted); }
  [${KITCHEN_HOME_ITEM_ATTR}] {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 8rem) auto;
    column-gap: 12px;
    overflow-wrap: anywhere;
  }
  [${KITCHEN_HOME_ATTR}] .kitchen-home-row-info { display: grid; gap: 4px; min-width: 0; }
  [${KITCHEN_HOME_ATTR}] .kitchen-home-row-info > span,
  [${KITCHEN_HOME_ATTR}] .kitchen-home-row-status { color: var(--fg-muted); font-size: 13px; }
  [${KITCHEN_HOME_ATTR}] .kitchen-home-actions { margin: 0; white-space: nowrap; }
}
`;

export interface KitchenHomeOptions {
  root: HTMLElement;
  listWork: () => Promise<KitchenWorkItemList>;
  listPacks: () => Promise<{ drafts: IngredientDraftSummary[] }>;
  discardWork: (id: string, revision: number) => Promise<unknown>;
  discardPack: (id: string) => Promise<unknown>;
  confirm?: (message: string) => boolean;
  now?: () => number;
  document?: Document;
}

interface Row {
  key: string;
  title: string;
  started: string;
  updated_at: number;
  state?: string;
  href: string;
  discard: () => Promise<unknown>;
}

/** "edited 5 min ago" — coarse on purpose; the exact time is in the title attribute. */
export const editedAgo = (at: number, now: number): string => {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'edited just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `edited ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `edited ${hours} h ago`;
  if (hours < 48) return 'edited yesterday';
  return `edited ${new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
};

const workRow = (item: KitchenWorkItem, options: KitchenHomeOptions): Row => ({
  key: `work:${item.draft_id}`,
  title: item.title,
  started: item.base !== undefined ? 'Changes to your recipe'
    : item.from === 'Kitchen' ? (item.kind === 'recipe' ? 'New recipe' : 'New pack') : `From ${item.from}`,
  updated_at: item.updated_at,
  state: item.ready ? 'Ready to save' : `${item.problems} ${item.problems === 1 ? 'problem' : 'problems'} to fix`,
  // Changes to a saved recipe continue on the recipe itself.
  href: item.base !== undefined
    ? serializeShellRoute('kitchen', 'recipe', item.base.recipe_id)
    : serializeShellRoute('kitchen', 'import', item.draft_id),
  discard: () => options.discardWork(item.draft_id, item.revision),
});
const packRow = (draft: IngredientDraftSummary, options: KitchenHomeOptions): Row => ({
  key: `pack:${draft.draft_id}`,
  title: draft.title?.trim() || draft.slug || 'New pack',
  started: draft.base_pack_slug !== undefined ? 'Changes to your pack' : 'New pack',
  updated_at: draft.updated_at,
  href: serializeShellRoute('kitchen', 'pack', draft.draft_id),
  discard: () => options.discardPack(draft.draft_id),
});

export const mountKitchenHomeRoute = (options: KitchenHomeOptions): { dispose(): void } => {
  const doc = options.document ?? options.root.ownerDocument;
  const now = options.now ?? Date.now;
  const confirmDiscard = options.confirm ?? ((message: string) => doc.defaultView?.confirm(message) ?? false);
  const host = doc.createElement('section');
  host.setAttribute(KITCHEN_HOME_ATTR, '');
  const style = doc.createElement('style');
  style.textContent = KITCHEN_HOME_STYLES;
  host.append(style);
  const lead = doc.createElement('p');
  lead.className = 'kitchen-home-lead';
  lead.textContent = 'Start something new, or pick up where you left off.';
  const layout = doc.createElement('div');
  layout.className = 'kitchen-home-layout';
  const start = doc.createElement('nav');
  start.className = 'kitchen-home-start';
  start.setAttribute('aria-label', 'Start new work or open saved work');
  const link = (label: string, href: string): HTMLAnchorElement => {
    const anchor = doc.createElement('a'); anchor.setAttribute('href', href); anchor.textContent = label; return anchor;
  };
  const newRecipe = link('New recipe', serializeShellRoute('kitchen', 'new', 'recipe'));
  const newPack = link('New pack', serializeShellRoute('kitchen', 'pack'));
  const saved = doc.createElement('span');
  saved.append('Edit a saved one: ', link('Recipes', serializeShellRoute('recipes')), ' · ', link('Packs', serializeShellRoute('packs')));
  start.append(newRecipe, newPack, saved);
  const progress = doc.createElement('section');
  progress.setAttribute('aria-label', 'In progress');
  const status = doc.createElement('p'); status.setAttribute('role', 'status'); status.textContent = 'Loading what is in progress…';
  status.className = 'kitchen-home-status';
  const queue = doc.createElement('div');
  queue.className = 'kitchen-home-queue';
  queue.append(progress, status);
  layout.append(start, queue);
  host.append(lead, layout);
  options.root.append(host);
  let disposed = false;

  const render = (rows: Row[]): void => {
    progress.replaceChildren();
    if (rows.length === 0) { status.textContent = 'Nothing in progress.'; return; }
    status.textContent = '';
    const heading = doc.createElement('h2'); heading.textContent = 'In progress';
    const list = doc.createElement('ul');
    list.className = 'kitchen-home-list';
    for (const row of rows) {
      const entry = doc.createElement('li');
      entry.setAttribute(KITCHEN_HOME_ITEM_ATTR, row.key);
      const info = doc.createElement('div');
      info.className = 'kitchen-home-row-info';
      const title = doc.createElement('strong'); title.textContent = row.title;
      const meta = doc.createElement('span');
      meta.textContent = `${row.started} · ${editedAgo(row.updated_at, now())}`;
      meta.setAttribute('title', new Date(row.updated_at).toLocaleString());
      info.append(title, meta);
      const state = doc.createElement('span'); state.textContent = row.state ?? '';
      state.className = 'kitchen-home-row-status';
      state.setAttribute('aria-live', 'polite');
      const actions = doc.createElement('span');
      actions.className = 'kitchen-home-actions';
      const resume = link('Continue', row.href);
      const remove = doc.createElement('button'); remove.type = 'button';
      remove.className = 'kitchen-home-action';
      remove.innerHTML = renderActionLabel('delete', 'Discard');
      remove.addEventListener('click', async () => {
        if (remove.getAttribute('aria-busy') === 'true') return;
        remove.focus?.({ preventScroll: true });
        if (!confirmDiscard(`Discard "${row.title}"? It is removed from Kitchen and cannot be brought back.`)) return;
        remove.setAttribute('aria-busy', 'true');
        remove.setAttribute('aria-disabled', 'true');
        try {
          await row.discard();
        } catch (error) {
          if (disposed) return;
          remove.removeAttribute('aria-busy');
          remove.removeAttribute('aria-disabled');
          state.textContent = humanizeRpcError(error);
          return;
        }
        if (disposed) return;
        const restoreFocus = doc.activeElement === remove || doc.activeElement === resume;
        const adjacent = entry.nextElementSibling ?? entry.previousElementSibling;
        entry.remove();
        if (list.children.length === 0) render([]);
        if (restoreFocus) (adjacent?.querySelector<HTMLAnchorElement>('a') ?? newRecipe).focus();
      });
      actions.append(resume, remove);
      entry.append(info, state, actions);
      list.append(entry);
    }
    progress.append(heading, list);
  };

  const unavailable = (error: unknown): boolean => {
    const code = (error as { code?: string } | null)?.code;
    return code === 'unknown_method' || code === 'not_configured';
  };
  // A server from before D-333 has pack work but no list of the rest: show what it has.
  void Promise.all([
    options.listWork().then((result) => result.items, (error: unknown) => { if (unavailable(error)) return [] as KitchenWorkItem[]; throw error; }),
    options.listPacks().then((result) => result.drafts, (error: unknown) => { if (unavailable(error)) return [] as IngredientDraftSummary[]; throw error; }),
  ]).then(([work, packs]) => {
    if (disposed) return;
    render([...work.map((item) => workRow(item, options)), ...packs.map((draft) => packRow(draft, options))]
      .sort((a, b) => b.updated_at - a.updated_at));
  }).catch((error: unknown) => {
    if (!disposed) status.textContent = `Could not load what is in progress: ${humanizeRpcError(error)}`;
  });

  return { dispose(): void { disposed = true; host.remove(); } };
};
