/** D-405 slice 4 — the "Set up" page. The owner's ruling (P4): the same server-computed gaps the chat's
 *  hints read, in one list: what is connected, what is empty, and what each pack still needs, each with
 *  the step that sets it up, in place of fixed first-run cards.
 *
 *  Every line comes from what the server says, read the way the surface that owns it reads it: mail, a
 *  calendar and files from `chat.setup.features` (the fact behind "Connect your mail"), chat's model as the
 *  chat reads it, each installed pack's needs by the Packs page's own rule (`packNeedsOf`), recipes as the
 *  first-run card read them, and the hints set aside from `chat.hints.list`.
 *
 *  ⛔ A read that fails says so on its own line. It never reads as "nothing to set up": a list that left
 *  out what it could not read would tell the owner it was all done.
 *
 *  D-405 slice 9 — it stays current while open. A pack installed or removed, a connection or a sign-in
 *  that changes what a recipe can run, a vendor's sign-in completing, and mail, calendar or file records
 *  arriving each read again the lines they can change, and coming back to the page's tab reads every
 *  line: a mailbox connected in another tab shows here. A burst of events is one read. These reads are
 *  quiet: a line keeps what it says until the new answer lands, and the page is drawn again only when a
 *  line changed, with focus kept on the line it was on. */
import {
  chatHintsNotNowOf,
  chatSetupFeaturesOf,
  featureStepWords,
  isChatSetupFeature,
  type ChatHintNotNow,
  type ChatSetupFeature,
  type ChatSetupFeatureState,
} from '@recued/contracts';

import { chatHintUntilText } from '../chat/chat-hints.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { serializeShellRoute } from '../shell/route.js';
import { watchPackNeeds, type PackNeedsReads, type PackNeedsView } from './setup-pack-needs.js';
import { FOCUS_BLOCK_SETUP_STYLES, mountFocusBlockSetup, type FocusBlockSetupCallers } from './focus-block-setup.js';

/** Marks the page's root. */
export const SETUP_ROUTE_ATTR = 'data-recued-setup-route';
/** On the page's heading: where a recovered landing puts focus. */
export const SETUP_ROUTE_HEADING_ATTR = 'data-recued-setup-route-heading';
/** On each line: what it is about (`chat`, `feature:mail`, `pack:<slug>`, `packs`, `recipes`, `hint:<key>`). */
export const SETUP_ROW_ATTR = 'data-setup-row';
/** On each line: `done`, `todo`, `unknown`, `checking`, or `aside` (a hint set aside). */
export const SETUP_ROW_STATE_ATTR = 'data-setup-state';
/** The line at the top that counts what is left. */
export const SETUP_SUMMARY_ATTR = 'data-setup-summary';
/** On each "Show it again": the hint's key. */
export const SETUP_RESTORE_ATTR = 'data-setup-restore';

const STYLES_MARKER = 'data-recued-setup-route-styles';
const SETUP_DESKTOP_MEDIA = '(min-width: 1280px) and (hover: hover) and (pointer: fine)';

/** What the page reads. Each one it is not handed is a line saying so, never a line saying "done". */
export interface SetupRouteCallers {
  /** `chat.setup.features`. */
  readonly features: () => Promise<{ readonly features?: unknown }>;
  /** Whether chat has a model to answer with, as the chat itself reads it. */
  readonly chatReady?: () => Promise<boolean>;
  /** Whether any recipe is installed. */
  readonly anyRecipe?: () => Promise<boolean>;
  readonly focusBlocks?: FocusBlockSetupCallers;
  /** The Packs page's reads, for what each installed pack still needs. */
  readonly packs?: PackNeedsReads;
  /** `chat.hints.list` and `chat.hints.restore`: the hints set aside, and "Show it again". */
  readonly hints?: {
    readonly list: () => Promise<{ readonly not_now?: unknown } | undefined>;
    readonly restore: (key: string) => Promise<unknown>;
  };
}

export interface BootstrapSetupRouteOptions {
  readonly container: HTMLElement;
  readonly callers: SetupRouteCallers;
  readonly document?: Document;
  /** D-405 slice 9 — the server's events, as the app's subscriber hands them out (`subscriber.on`): the
   *  page reads again what an event can change. Absent: it reads when opened, on `refresh`, and when its
   *  tab is shown again. */
  readonly subscribe?: BroadcastSubscriber['on'];
  /** How long the page waits for a burst of events to end before it reads again. */
  readonly settleMs?: number;
}

/** D-405 slice 9 — how long a burst of events waits before one read (a mail sync sends many). */
export const SETUP_SETTLE_MS = 500;

export interface SetupRoute {
  /** Read everything again. */
  readonly refresh: () => void;
  readonly dispose: () => void;
}

/** One read's state. */
type Read<T> = { readonly state: 'checking' } | { readonly state: 'failed' } | { readonly state: 'ready'; readonly value: T };
/** The page's lines, each read on its own. */
type Line = 'features' | 'chat' | 'recipes' | 'packs' | 'hints';
const EVERY_LINE: readonly Line[] = ['features', 'chat', 'recipes', 'packs', 'hints'];

/** What a feature is called on the page when it is connected, and the Connections lane it is managed in. */
const FEATURE_DONE: Readonly<Record<ChatSetupFeature, string>> = {
  mail: 'A mailbox is connected.',
  calendar: 'A calendar of yours is connected.',
  file: 'A file source is connected.',
};
const FEATURE_NAME: Readonly<Record<ChatSetupFeature, string>> = { mail: 'mail', calendar: 'calendar', file: 'files' };

export const SETUP_ROUTE_STYLES = `
[${SETUP_ROUTE_ATTR}] { box-sizing: border-box; max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; color: var(--fg);
  display: grid; gap: 20px; min-width: 0; }
[${SETUP_ROUTE_ATTR}][data-setup-desktop] { max-width: var(--wc-content-max, 1160px); padding-inline: 24px;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; column-gap: var(--wc-space-lg, 24px); }
[${SETUP_ROUTE_ATTR}][data-setup-desktop] > header { grid-column: 1 / -1; }
[${SETUP_ROUTE_ATTR}] h1 { margin: 0; font-size: 22px; line-height: 1.3; }
[${SETUP_ROUTE_ATTR}] .setup-intro { margin: 4px 0 0; color: var(--muted); font-size: 14px; }
[${SETUP_ROUTE_ATTR}] [${SETUP_SUMMARY_ATTR}] { margin: 8px 0 0; font-size: 14px; font-weight: 600; }
.setup-checklist { display:grid; gap:20px; min-width:0; }
.setup-section { display: grid; gap: 8px; min-width: 0; }
.setup-section h2 { margin: 0; font-size: 15px; }
.setup-rows { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; border: 1px solid var(--border);
  border-radius: 0.5rem; background: var(--surface); }
/* The mark, the words, and the step: the step under the words on a narrow screen, never under the mark. */
.setup-row { display: grid; grid-template-columns: 1.2em minmax(0, 1fr) auto; align-items: baseline; gap: 4px 12px;
  padding: 10px 12px; min-width: 0; }
.setup-row + .setup-row { border-top: 1px solid var(--border); }
.setup-row-mark { color: var(--muted); }
.setup-row[${SETUP_ROW_STATE_ATTR}="done"] .setup-row-mark { color: var(--accent, var(--fg)); }
.setup-row-text { min-width: 0; font-size: 14px; overflow-wrap: anywhere; }
.setup-row-detail { display: block; color: var(--muted); font-size: 13px; }
.setup-row-action { font-size: 13px; font-weight: 600; text-decoration: none; overflow-wrap: anywhere; }
.setup-row-action:hover, .setup-row-action:focus-visible { text-decoration: underline; }
button.setup-row-action { font: inherit; font-size: 13px; font-weight: 600; padding: 4px 10px; border-radius: 0.375rem;
  border: 1px solid var(--border); background: var(--surface); color: var(--fg); cursor: pointer; }
button.setup-row-action[disabled] { opacity: 0.6; cursor: progress; }
.setup-row-error { grid-column: 2 / -1; margin: 0; font-size: 12px; color: var(--danger, var(--fg)); }
@media (max-width: 480px) {
  .setup-row { grid-template-columns: 1.2em minmax(0, 1fr); }
  .setup-row > .setup-row-action { grid-column: 2; justify-self: start; }
}
`;

export const bootstrapSetupRoute = (opts: BootstrapSetupRouteOptions): SetupRoute => {
  const doc = opts.document ?? opts.container.ownerDocument ?? globalThis.document;
  if (doc.head?.querySelector?.(`style[${STYLES_MARKER}]`) == null) {
    const style = doc.createElement('style');
    style.setAttribute(STYLES_MARKER, '');
    style.textContent = SETUP_ROUTE_STYLES + FOCUS_BLOCK_SETUP_STYLES;
    doc.head?.appendChild?.(style);
  }
  // ⛔ The page owns its root and removes it on dispose: the shell never clears its container.
  const root = doc.createElement('div');
  root.setAttribute(SETUP_ROUTE_ATTR, '');
  opts.container.appendChild(root);

  let disposed = false;
  /** Each line's latest read: an answer to an older one is dropped, whatever another line reads meanwhile. */
  const generations: Record<Line, number> = { features: 0, chat: 0, recipes: 0, packs: 0, hints: 0 };
  let features: Read<ChatSetupFeatureState[]> = { state: 'checking' };
  let chat: Read<boolean> = { state: 'checking' };
  let recipes: Read<boolean> = { state: 'checking' };
  let packs: Read<PackNeedsView> = { state: 'checking' };
  let hints: Read<ChatHintNotNow[]> = { state: 'checking' };
  /** A "Show it again" on its way, or the error it met, by key. */
  const restoring = new Map<string, { readonly state: 'running' } | { readonly state: 'failed'; readonly error: string }>();
  let stopPacks: (() => void) | null = null;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const link = (text: string, href: string, label?: string): HTMLAnchorElement => {
    const anchor = el('a', 'setup-row-action', text);
    anchor.setAttribute('href', href);
    if (label !== undefined) anchor.setAttribute('aria-label', label);
    return anchor;
  };
  const row = (
    key: string,
    state: 'done' | 'todo' | 'unknown' | 'checking' | 'aside',
    text: string,
    action?: HTMLElement,
    detail?: string,
  ): HTMLLIElement => {
    const item = el('li', 'setup-row');
    item.setAttribute(SETUP_ROW_ATTR, key);
    item.setAttribute(SETUP_ROW_STATE_ATTR, state);
    const mark = el('span', 'setup-row-mark', state === 'done' ? '✓' : state === 'todo' ? '○' : state === 'aside' ? '–' : '·');
    mark.setAttribute('aria-hidden', 'true');
    item.appendChild(mark);
    const words = el('span', 'setup-row-text', text);
    if (detail !== undefined) words.appendChild(el('span', 'setup-row-detail', detail));
    item.appendChild(words);
    if (action !== undefined) item.appendChild(action);
    return item;
  };
  const section = (key: string, title: string, rows: readonly HTMLElement[]): HTMLElement => {
    const block = el('section', 'setup-section');
    block.setAttribute('data-setup-section', key);
    const heading = el('h2', undefined, title);
    heading.id = `setup-${key}`;
    block.setAttribute('aria-labelledby', heading.id);
    block.appendChild(heading);
    const list = el('ul', 'setup-rows');
    for (const item of rows) list.appendChild(item);
    block.appendChild(list);
    return block;
  };

  const chatRows = (): HTMLElement[] => {
    if (chat.state === 'checking') return [row('chat', 'checking', 'Checking chat’s model…')];
    if (chat.state === 'failed') return [row('chat', 'unknown', 'Recued could not check chat’s model.',
      link('Open AI models', serializeShellRoute('settings', 'ai-models')))];
    return chat.value
      ? [row('chat', 'done', 'Chat has a model to answer with.', link('AI models', serializeShellRoute('settings', 'ai-models')))]
      : [row('chat', 'todo', 'Chat has no model yet.', link('Set up chat', serializeShellRoute('settings', 'ai-models', 'setup', 'start')))];
  };

  const featureRows = (): HTMLElement[] => {
    if (features.state === 'checking') return [row('features', 'checking', 'Checking your mail, calendar and files…')];
    if (features.state === 'failed') return [row('features', 'unknown', 'Recued could not check your mail, calendar and files.',
      link('Open Connections', serializeShellRoute('connections')))];
    const known = new Map(features.value.map((entry) => [entry.feature, entry.connected]));
    return (['mail', 'calendar', 'file'] as const).map((feature) => {
      const lane = serializeShellRoute('connections', feature);
      const connected = known.get(feature);
      if (connected === true) return row(`feature:${feature}`, 'done', FEATURE_DONE[feature], link('Open', lane, `Open ${FEATURE_NAME[feature]} in Connections`));
      if (connected === false) {
        const words = featureStepWords(feature);
        return row(`feature:${feature}`, 'todo', words.lead, link(words.link, lane));
      }
      return row(`feature:${feature}`, 'unknown', `Recued could not check your ${FEATURE_NAME[feature]}.`,
        link('Open', lane, `Open ${FEATURE_NAME[feature]} in Connections`));
    });
  };

  const packRows = (): HTMLElement[] => {
    if (opts.callers.packs === undefined) return [row('packs', 'unknown', 'Packs cannot be read here.')];
    if (packs.state === 'checking') return [row('packs', 'checking', 'Checking your packs…')];
    if (packs.state === 'failed') return [row('packs', 'unknown', 'Recued could not read your packs.', link('Open Packs', serializeShellRoute('packs')))];
    const view = packs.value;
    if (view.installed === 0) return [row('packs', 'todo', 'No pack is installed yet.', link('Browse packs', serializeShellRoute('packs')))];
    if (view.needs.length === 0) {
      return [row('packs', 'done', `${view.installed === 1 ? 'The pack' : `All ${String(view.installed)} packs`} you installed ${view.installed === 1 ? 'has' : 'have'} what ${view.installed === 1 ? 'it needs' : 'they need'}.`,
        link('Packs', serializeShellRoute('packs')))];
    }
    return view.needs.map((need) => row(`pack:${need.slug}`, 'todo', need.name,
      link('Open', serializeShellRoute('packs', need.slug), `Open ${need.name}`), need.labels.join(' · ')));
  };

  const recipeRows = (): HTMLElement[] => {
    if (opts.callers.anyRecipe === undefined) return [];
    if (recipes.state === 'checking') return [row('recipes', 'checking', 'Checking your recipes…')];
    if (recipes.state === 'failed') return [row('recipes', 'unknown', 'Recued could not check your recipes.', link('Open Recipes', serializeShellRoute('recipes')))];
    return recipes.value
      ? [row('recipes', 'done', 'Recipes are installed.', link('Recipes', serializeShellRoute('recipes')))]
      : [row('recipes', 'todo', 'No recipe is installed yet.', link('Browse recipes', serializeShellRoute('recipes')))];
  };

  const hintRows = (): HTMLElement[] => {
    if (hints.state !== 'ready') return [];
    return hints.value.map((hint) => {
      const at = restoring.get(hint.key);
      const button = el('button', 'setup-row-action', 'Show it again');
      button.setAttribute('type', 'button');
      button.setAttribute(SETUP_RESTORE_ATTR, hint.key);
      if (at?.state === 'running') button.setAttribute('disabled', '');
      button.addEventListener('click', () => { void restore(hint.key); });
      const item = row(`hint:${hint.key}`, 'aside', `“${hint.label}”`, button, `Hidden until ${chatHintUntilText(hint.until)}.`);
      if (at?.state === 'failed') {
        const error = el('p', 'setup-row-error', at.error);
        error.setAttribute('role', 'alert');
        item.appendChild(error);
      }
      return item;
    });
  };

  /** What is left to set up, or null while a read that decides it is on its way. */
  const outstanding = (): number | null => {
    if (chat.state === 'checking' || features.state === 'checking'
      || (opts.callers.packs !== undefined && packs.state === 'checking')
      || (opts.callers.anyRecipe !== undefined && recipes.state === 'checking')) return null;
    let left = 0;
    if (chat.state === 'ready' && !chat.value) left += 1;
    if (features.state === 'ready') left += features.value.filter((entry) => entry.connected === false).length;
    if (packs.state === 'ready') left += packs.value.installed === 0 ? 1 : packs.value.needs.length;
    if (recipes.state === 'ready' && !recipes.value) left += 1;
    return left;
  };
  /** Whether a line could not be read: then "nothing left" cannot be said. */
  const anyUnknown = (): boolean => chat.state === 'failed' || features.state === 'failed'
    || (features.state === 'ready' && (features.value.length < 3 || features.value.some((entry) => entry.connected === null)))
    || opts.callers.packs === undefined || packs.state === 'failed' || recipes.state === 'failed';

  const header = el('header');
  const title = el('h1', undefined, 'Set up');
  title.setAttribute(SETUP_ROUTE_HEADING_ATTR, '');
  title.setAttribute('tabindex', '-1');
  header.appendChild(title);
  header.appendChild(el('p', 'setup-intro', 'What Recued can reach, and what is still missing. Each step opens the page that does it.'));
  const summary = el('p');
  summary.setAttribute(SETUP_SUMMARY_ATTR, '');
  summary.setAttribute('role', 'status');
  header.appendChild(summary);
  root.appendChild(header);
  const focusBlocks = opts.callers.focusBlocks ? mountFocusBlockSetup(doc, opts.callers.focusBlocks) : null;
  if (focusBlocks) root.appendChild(focusBlocks.element);
  const checklist = el('div', 'setup-checklist');
  root.appendChild(checklist);
  const desktop = focusBlocks ? doc.defaultView?.matchMedia?.(SETUP_DESKTOP_MEDIA) : undefined;
  const placeSections = (): void => {
    if (!focusBlocks || !desktop) return;
    root.toggleAttribute('data-setup-desktop', desktop.matches);
    const [first, second] = desktop.matches ? [checklist, focusBlocks.element] : [focusBlocks.element, checklist];
    if (first.nextElementSibling === second) return;
    // Keep DOM order aligned with the layout. Move the sibling outside keyboard focus.
    if (first.contains(doc.activeElement)) root.appendChild(second);
    else root.insertBefore(first, second);
  };
  placeSections();
  desktop?.addEventListener('change', placeSections);

  const paint = (): void => {
    if (disposed) return;
    // D-405 slice 9 — the line focus was on, and whether on its step, so a page drawn again keeps it.
    const active = doc.activeElement as HTMLElement | null | undefined;
    const focusedInside = active !== null && active !== undefined && checklist.contains?.(active) === true;
    const focusedRow = focusedInside ? active.closest?.(`[${SETUP_ROW_ATTR}]`)?.getAttribute(SETUP_ROW_ATTR) ?? null : null;
    while (checklist.firstChild) checklist.removeChild(checklist.firstChild);
    const left = outstanding();
    summary.textContent = left === null ? 'Checking…'
      : left > 0 ? `${String(left)} ${left === 1 ? 'thing' : 'things'} to set up.`
        : anyUnknown() ? 'Nothing else to set up that Recued could check.' : 'Everything here is set up.';
    checklist.appendChild(section('chat', 'Chat', chatRows()));
    checklist.appendChild(section('features', 'Mail, calendar and files', featureRows()));
    checklist.appendChild(section('packs', 'Packs', packRows()));
    const recipeLines = recipeRows();
    if (recipeLines.length > 0) checklist.appendChild(section('recipes', 'Recipes', recipeLines));
    const hintLines = hintRows();
    if (hintLines.length > 0) checklist.appendChild(section('hints', 'Hints you set aside', hintLines));
    if (focusedInside) {
      // The same line's step, else the heading: never lost to the page's body.
      const again = focusedRow === null ? null
        : root.querySelector?.(`[${SETUP_ROW_ATTR}="${focusedRow}"] .setup-row-action`) as HTMLElement | null | undefined;
      (again ?? root.querySelector?.(`[${SETUP_ROUTE_HEADING_ATTR}]`) as HTMLElement | null | undefined)?.focus?.();
    }
  };

  const restore = async (key: string): Promise<void> => {
    const can = opts.callers.hints;
    if (can === undefined || restoring.get(key)?.state === 'running') return;
    restoring.set(key, { state: 'running' });
    paint();
    try {
      await can.restore(key);
      restoring.delete(key);
      if (hints.state === 'ready') hints = { state: 'ready', value: hints.value.filter((hint) => hint.key !== key) };
    } catch (err) {
      restoring.set(key, { state: 'failed', error: err instanceof Error ? err.message : String(err) });
    }
    paint();
  };

  /** A line's read lands: its answer is kept, and the page drawn again only when the line changed. */
  const settle = <T>(line: Line, read: Promise<T>, current: () => Read<T>, apply: (next: Read<T>) => void): void => {
    const mine = ++generations[line];
    const land = (next: Read<T>): void => {
      if (disposed || mine !== generations[line]) return;
      const changed = JSON.stringify(next) !== JSON.stringify(current());
      apply(next);
      if (changed) paint();
    };
    void read.then((value) => land({ state: 'ready', value }), () => land({ state: 'failed' }));
  };

  /** Reads these lines again. `quiet`: each keeps what it says until its answer lands (a live read). */
  const read = (lines: ReadonlySet<Line>, quiet: boolean): void => {
    if (disposed) return;
    if (!quiet) {
      if (lines.has('features')) features = { state: 'checking' };
      if (lines.has('chat')) chat = { state: 'checking' };
      if (lines.has('recipes')) recipes = { state: 'checking' };
      if (lines.has('packs')) packs = { state: 'checking' };
      if (lines.has('hints')) hints = { state: 'checking' };
      paint();
    }
    if (lines.has('features')) {
      settle('features', opts.callers.features().then((answer) => {
        const states = chatSetupFeaturesOf(answer?.features);
        // ⛔ An answer naming none is a server that could not say, not "none connected".
        if (states.length === 0) throw new Error('no features');
        return states;
      }), () => features, (next) => { features = next; });
    }
    if (lines.has('chat')) {
      if (opts.callers.chatReady !== undefined) settle('chat', opts.callers.chatReady(), () => chat, (next) => { chat = next; });
      else chat = { state: 'failed' };
    }
    if (lines.has('recipes') && opts.callers.anyRecipe !== undefined) {
      settle('recipes', opts.callers.anyRecipe(), () => recipes, (next) => { recipes = next; });
    }
    if (lines.has('hints') && opts.callers.hints !== undefined) {
      settle('hints', opts.callers.hints.list().then((answer) => chatHintsNotNowOf(answer?.not_now)
        .filter((hint) => hint.until > Date.now())), () => hints, (next) => { hints = next; });
    }
    if (lines.has('packs')) {
      stopPacks?.();
      const mine = ++generations.packs;
      stopPacks = opts.callers.packs === undefined ? null : watchPackNeeds(opts.callers.packs, (view) => {
        if (disposed || mine !== generations.packs) return;
        const next: Read<PackNeedsView> = view === null ? { state: 'failed' } : { state: 'ready', value: view };
        const changed = JSON.stringify(next) !== JSON.stringify(packs);
        packs = next;
        if (changed) paint();
      });
    }
    if (!quiet) paint();
  };

  const refresh = (): void => read(new Set(EVERY_LINE), false);

  // D-405 slice 9 — read again what an event can change, once a burst of them ends.
  const pending = new Set<Line>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const later = (lines: readonly Line[]): void => {
    if (disposed) return;
    for (const line of lines) pending.add(line);
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      const due = new Set(pending);
      pending.clear();
      read(due, true);
    }, opts.settleMs ?? SETUP_SETTLE_MS);
  };
  const stops: Array<() => void> = opts.subscribe === undefined ? [] : [
    // A pack brings recipes, and needs of its own.
    opts.subscribe('pack_installed', () => later(['packs', 'recipes'])),
    opts.subscribe('pack_uninstalled', () => later(['packs', 'recipes'])),
    // A connection or a sign-in changed what a recipe can run: a pack's needs, and a cloud file source.
    opts.subscribe('recipe_runnability_changed', () => later(['packs', 'features'])),
    opts.subscribe('connection.vendor_oauth_completed', () => later(['packs', 'features'])),
    // Records of a feature arriving: one is connected. Once the page says so, a sync's many records say
    // nothing new, and read nothing.
    opts.subscribe('warehouse', (event) => {
      const feature = event.collection;
      if (!isChatSetupFeature(feature)) return;
      if (features.state === 'ready' && features.value.some((entry) => entry.feature === feature && entry.connected === true)) return;
      later(['features']);
    }),
  ];
  // Back to the page's tab: whatever changed while it was hidden, here or on another device.
  const onShown = (): void => { if (doc.visibilityState === 'visible') later(EVERY_LINE); };
  doc.addEventListener?.('visibilitychange', onShown);

  refresh();

  return {
    refresh,
    dispose: () => {
      disposed = true;
      for (const line of EVERY_LINE) generations[line] += 1;
      if (timer !== undefined) clearTimeout(timer);
      for (const stop of stops) stop();
      doc.removeEventListener?.('visibilitychange', onShown);
      desktop?.removeEventListener('change', placeSections);
      stopPacks?.();
      focusBlocks?.dispose();
      root.remove?.();
    },
  };
};
