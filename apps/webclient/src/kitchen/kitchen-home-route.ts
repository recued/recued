/** D-333 — Kitchen home: start something, or pick up work in progress.
 *
 *  Recipes and packs are the things you keep; they live in Recipes and Packs. Kitchen keeps
 *  only what you have not finished: a new recipe, a new pack, changes to a saved recipe, or
 *  source an AI app handed over. Each item stays here until it is saved as the real thing or
 *  discarded. */
import type { IngredientDraftSummary, KitchenWorkItem, KitchenWorkItemList } from '@recued/contracts';
import { serializeShellRoute } from '../shell/route.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

export const KITCHEN_HOME_ATTR = 'data-recued-kitchen-home';
export const KITCHEN_HOME_ITEM_ATTR = 'data-recued-kitchen-home-item';

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
  host.style.cssText = 'max-width:1200px;margin:0 auto;padding:16px 24px 32px;box-sizing:border-box;';
  const lead = doc.createElement('p');
  lead.textContent = 'Start something new, or pick up where you left off.';
  const start = doc.createElement('div');
  start.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;';
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
  host.append(lead, start, progress, status);
  options.root.append(host);
  let disposed = false;

  const render = (rows: Row[]): void => {
    progress.replaceChildren();
    if (rows.length === 0) { status.textContent = 'Nothing in progress.'; return; }
    status.textContent = '';
    const heading = doc.createElement('h2'); heading.textContent = 'In progress';
    const list = doc.createElement('ul');
    list.style.cssText = 'list-style:none;margin:0;padding:0;';
    for (const row of rows) {
      const entry = doc.createElement('li');
      entry.setAttribute(KITCHEN_HOME_ITEM_ATTR, row.key);
      entry.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:4px 16px;padding:12px 0;border-top:1px solid var(--border);';
      const title = doc.createElement('strong'); title.textContent = row.title;
      const meta = doc.createElement('span');
      meta.textContent = `${row.started} · ${editedAgo(row.updated_at, now())}`;
      meta.setAttribute('title', new Date(row.updated_at).toLocaleString());
      const state = doc.createElement('span'); state.textContent = row.state ?? '';
      const actions = doc.createElement('span');
      actions.style.cssText = 'margin-left:auto;display:flex;gap:8px;';
      const resume = link('Continue', row.href);
      const remove = doc.createElement('button'); remove.type = 'button'; remove.textContent = 'Discard';
      remove.addEventListener('click', () => {
        if (!confirmDiscard(`Discard "${row.title}"? It is removed from Kitchen and cannot be brought back.`)) return;
        remove.disabled = true;
        void row.discard().then(() => {
          if (disposed) return;
          entry.remove();
          if (list.children.length === 0) render([]);
        }).catch((error: unknown) => {
          if (disposed) return;
          remove.disabled = false;
          state.textContent = humanizeRpcError(error);
        });
      });
      actions.append(resume, remove);
      entry.append(title, meta, state, actions);
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
