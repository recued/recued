/** D-320 slice 2h (ruling 16) — the Connections page's grid per sign-in: which of
 *  the owner's connections each pack may use, and which one it uses by default
 *  (D-320 §4). Backed by `packs.connections.signins` and the
 *  `packs.connections.*` writes.
 *
 *  - A sign-in is the connection name a pack's catalog declares (`hubspot`). Its
 *    grid is drawn once two or more of the owner's connections can serve it; with one,
 *    the connection's "Used by packs" says it all.
 *  - A row per pack holding its own list. A family is one row, its holder's: the
 *    packs signing in through it are listed under it, read-only, and follow it.
 *  - A column per connection. Ticked: the pack may use it (runs, dishes and the AI
 *    may pick it). Unticked: it never does. The round button: its default, the
 *    one its runs use unless a run or a dish picks another. A dash: the connection
 *    cannot serve that pack.
 *  - Unticking asks first, saying where the pack's runs go next (slice 2g).
 *  - "Use with all" puts a connection on every row's list at once. It is one
 *    action, not a standing rule (ruling 16): a pack installed later is offered
 *    the connections its sign-in shares by the install dialog instead.
 *  - Slice 2i: once a connection is set up, the packs of its sign-in that could
 *    use it are offered, every one ticked ("Which HubSpot packs may use it?").
 *    Their default stays unless the owner makes it the new one; "Not now"
 *    leaves them. Ticked means the pack may use it; unticked, it never does.
 *
 *  The page host renders HTML strings and mounts this DOM into a placeholder
 *  after each render (`SIGNIN_GRIDS_HOST_ATTR`), as it mounts the MCP pack scope
 *  picker; its styles are the page's (`CONNECTIONS_PAGE_STYLES`, `.sg-*`). Same controller shape as the Access tab's block
 *  (`pack-connections-controls.ts`): injected callers, a host re-render hook, a
 *  sync render over cached state that loads on first sight. */

import type { RpcRequest, RpcResponse, ServerRpcRegistry } from '@recued/contracts';
import {
  connectionRemovalRecipeChanges,
  connectionRemovalRecipeSentence,
  connectionRemovalSentence,
  type ConnectionRemovalEffect,
  type ConnectionRemovalRecipeEffect,
} from '@recued/ui-shared';

import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';

export type PackSignInsView = RpcResponse<ServerRpcRegistry, 'packs.connections.signins'>;
type PackSignIn = PackSignInsView['signins'][number];
type PackSignInRow = PackSignIn['rows'][number];
type PackConnectionChange = RpcRequest<ServerRpcRegistry, 'packs.connections.add'>;
type AddManyRequest = RpcRequest<ServerRpcRegistry, 'packs.connections.add_many'>;

/** The calls the grid makes. */
export interface SignInGridCallers {
  signins: () => Promise<PackSignInsView>;
  add: (args: PackConnectionChange) => Promise<unknown>;
  remove: (args: PackConnectionChange) => Promise<unknown>;
  setDefault: (args: PackConnectionChange) => Promise<unknown>;
  addMany: (args: AddManyRequest) => Promise<PackSignInsView>;
  /** Where a pack's runs go if a connection is taken off its list (slice 2g).
   *  Absent: the question asks without saying. */
  removal?: (args: { connection_name: string; pack_slug: string }) => Promise<
    RpcResponse<ServerRpcRegistry, 'packs.connections.removal'>
  >;
}

/** The section holding the grids. */
export const SIGNIN_GRIDS_ATTR = 'data-recued-signin-grids';
/** One sign-in's grid; its value is the slot. */
export const SIGNIN_GRID_ATTR = 'data-recued-signin-grid';
/** One pack's row; its value is the pack's slug. */
export const SIGNIN_ROW_ATTR = 'data-recued-signin-row';
/** One cell; its value is `<pack>::<connection>`, its state in `SIGNIN_CELL_STATE_ATTR`. */
export const SIGNIN_CELL_ATTR = 'data-recued-signin-cell';
export const SIGNIN_CELL_STATE_ATTR = 'data-recued-signin-cell-state';
/** A cell's controls: the tick (`list`) and the default (`default`). */
export const SIGNIN_CONTROL_ATTR = 'data-recued-signin-control';
/** "Use with all"; its value is the connection's name. */
export const SIGNIN_USE_ALL_ATTR = 'data-recued-signin-use-all';
/** The open "Stop using X for Y?" question and its buttons. */
export const SIGNIN_CONFIRM_ATTR = 'data-recued-signin-confirm';
export const SIGNIN_CONFIRM_ACTION_ATTR = 'data-recued-signin-confirm-action';
/** Where the pack's runs go if the connection leaves; its value is the outcome, or
 *  `loading` / `failed`. */
export const SIGNIN_EFFECT_ATTR = 'data-recued-signin-effect';
/** D-320 audit — one line per recipe reading the pack's list and another's, whose
 *  runs go elsewhere than the pack's; the value is the recipe's id. */
export const SIGNIN_RECIPE_EFFECT_ATTR = 'data-recued-signin-recipe-effect';
export const SIGNIN_ERROR_ATTR = 'data-recued-signin-error';
/** D-320 slice 2i — a newly set-up connection's question; its value is the connection. */
export const SIGNIN_OFFER_ATTR = 'data-recued-signin-offer';
/** One pack's tick box in it; its value is `<pack>::<slot>`. */
export const SIGNIN_OFFER_PACK_ATTR = 'data-recued-signin-offer-pack';
/** Its buttons: `done` / `make-default` / `not-now`. */
export const SIGNIN_OFFER_ACTION_ATTR = 'data-recued-signin-offer-action';

const COPY = {
  heading: 'Which packs use which connection',
  intro: 'Tick the connections each pack may use, and choose the one it uses by default.',
  signin: (label: string, connections: number) => `${label} · ${connections} connections`,
  pack_column: 'Pack',
  members: (n: number) => `and ${n} ${n === 1 ? 'pack that signs' : 'packs that sign'} in through it`,
  may_use: (pack: string, connection: string) => `${pack} may use ${connection}`,
  is_default: (pack: string, connection: string) => `${pack} uses ${connection} by default`,
  cannot: (pack: string, connection: string) => `${connection} cannot serve ${pack}`,
  use_all: 'Use with all',
  use_all_label: (connection: string) => `Let every pack here use ${connection}`,
  confirm: (connection: string, pack: string) => `Stop using ${connection} for ${pack}?`,
  remove: 'Remove',
  keep: 'Keep',
  effect_loading: 'Checking where its runs go…',
  effect_failed: 'Could not check where its runs go next.',
  loading: 'Loading which packs use which connection…',
  load_failed: (message: string) => `Could not load which packs use which connection: ${message}`,
  retry: 'Try again',
  action_failed: (message: string) => `That did not work: ${message}`,
  offer_title: (connection: string) => `${connection} is connected.`,
  offer_question: (label: string) => `Which ${label} packs may use it?`,
  offer_keeps_one: (connection: string) => `Their default stays ${connection}.`,
  offer_keeps_each: 'Each keeps its default.',
  offer_becomes: 'It will be their only connection, so they will use it.',
  offer_mixed: 'Packs that have a connection keep their default; the others will use this one.',
  offer_done: 'Done',
  offer_make_default: 'Make it the default',
  offer_not_now: 'Not now',
} as const;

export interface SignInGridControllerOptions {
  document: Document;
  /** Absent ⇒ nothing is shown (the host cannot make the calls). */
  callers?: SignInGridCallers;
  /** Host re-render hook, fired after every state change. */
  onChange: () => void;
}

export interface SignInGridController {
  readonly enabled: boolean;
  /** Forget what was loaded, so the next render reloads. */
  refresh(): void;
  /** The grids, or null: disabled, a server without the calls, or no sign-in
   *  with two or more connections and no question open. */
  render(): HTMLElement | null;
  /** D-320 slice 2i — a connection was just set up: ask which packs of its
   *  sign-in may use it (when any could). */
  offerNewConnection(connection_name: string): void;
  /** Test seam: resolves once nothing is loading or writing. */
  whenSettled(): Promise<void>;
  dispose(): void;
}

type ViewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'unsupported' }
  | { status: 'ready'; view: PackSignInsView };

interface Confirming {
  change: PackConnectionChange;
  pack_name: string;
  display_name: string;
  effect:
    | { status: 'loading' }
    | { status: 'failed' }
    | {
      status: 'ready';
      effect: ConnectionRemovalEffect | undefined;
      /** The recipes that read this list and another's, whose runs change. */
      recipes: readonly ConnectionRemovalRecipeEffect[];
    }
    | null;
}

/** A newly set-up connection's question: the connection, the packs ticked (null until
 *  the grid is read), and its write. */
interface Offer {
  connection_name: string;
  ticked: Set<string> | null;
  writing: boolean;
  error: string | null;
}

/** One pack the new connection could join. */
interface OfferTarget {
  signin: PackSignIn;
  row: PackSignInRow;
  /** `<pack>::<slot>`. */
  key: string;
}

/** The packs a newly set-up connection could join: in every sign-in it can serve,
 *  the rows where it is not yet listed but could be. */
export const offerTargets = (view: PackSignInsView, connection_name: string): OfferTarget[] =>
  view.signins.flatMap((signin) =>
    signin.rows
      .filter((row) => row.cells[connection_name] === 'available')
      .map((row) => ({ signin, row, key: `${row.pack_slug}::${signin.slot}` })));

/** Whether a row holds any connection already. */
const hasConnection = (row: PackSignInRow): boolean =>
  Object.values(row.cells).some((cell) => cell === 'default' || cell === 'listed');

/** The sign-ins drawn as grids: two or more connections. */
export const signInsWithChoice = (view: PackSignInsView): PackSignIn[] =>
  view.signins.filter((signin) => signin.connections.length >= 2 && signin.rows.length > 0);

export const createSignInGridController = (opts: SignInGridControllerOptions): SignInGridController => {
  const doc = opts.document;
  const callers = opts.callers;
  const enabled = callers !== undefined;
  let state: ViewState = { status: 'idle' };
  /** Cell keys (`pack::connection`) and `all::<connection>` with a write in flight. */
  const busy = new Set<string>();
  let confirming: Confirming | null = null;
  let offer: Offer | null = null;
  let writeError: string | null = null;
  const inFlight = new Set<Promise<unknown>>();
  let disposed = false;

  const track = <T>(p: Promise<T>): Promise<T> => {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
    return p;
  };
  const changed = (): void => {
    if (!disposed) opts.onChange();
  };

  const load = (): void => {
    if (callers === undefined) return;
    if (state.status !== 'ready') state = { status: 'loading' };
    void track(callers.signins().then(
      (view) => {
        state = { status: 'ready', view };
        changed();
      },
      (error: unknown) => {
        state = classifyRpcError(error).code === 'unknown_method'
          ? { status: 'unsupported' }
          : { status: 'error', message: humanizeRpcError(error) };
        changed();
      },
    ));
  };

  /** Run one write, then read the grid again: what it shows is what the server
   *  says, not what the grid assumed. */
  const write = (key: string, call: () => Promise<unknown>): void => {
    if (busy.has(key)) return;
    busy.add(key);
    writeError = null;
    changed();
    void track(call().then(
      () => {
        busy.delete(key);
        load();
        changed();
      },
      (error: unknown) => {
        busy.delete(key);
        writeError = humanizeRpcError(error);
        changed();
      },
    ));
  };

  const ask = (change: PackConnectionChange, pack_name: string, display_name: string): void => {
    const removal = callers?.removal;
    confirming = { change, pack_name, display_name, effect: removal === undefined ? null : { status: 'loading' } };
    changed();
    if (removal === undefined) return;
    const asked = confirming;
    void track(removal({ connection_name: change.connection_name, pack_slug: change.pack_slug }).then(
      (view) => {
        if (confirming !== asked) return;
        asked.effect = {
          status: 'ready',
          effect: view.packs.find((p) => p.slot === change.slot) ?? view.packs[0],
          recipes: connectionRemovalRecipeChanges(view.recipes),
        };
        changed();
      },
      (error: unknown) => {
        if (confirming !== asked) return;
        asked.effect = classifyRpcError(error).code === 'unknown_method'
          ? { status: 'ready', effect: undefined, recipes: [] }
          : { status: 'failed' };
        changed();
      },
    ));
  };

  const el = <K extends keyof HTMLElementTagNameMap>(
    parent: HTMLElement,
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    parent.appendChild(node);
    return node;
  };

  const button = (parent: HTMLElement, label: string, primary: boolean, disabled: boolean, onClick: () => void) => {
    const b = el(parent, 'button', primary ? 'rx-btn rx-btn-primary' : 'rx-btn rx-btn-secondary', label);
    b.type = 'button';
    if (disabled) b.setAttribute('disabled', '');
    b.addEventListener('click', () => {
      if (!disabled) onClick();
    });
    return b;
  };

  /** A tick box or a round button; a click asks the grid, which then shows what
   *  the server says. The browser's own toggle is cancelled. */
  const control = (
    parent: HTMLElement,
    type: 'checkbox' | 'radio',
    name: string,
    checked: boolean,
    label: string,
    disabled: boolean,
    onClick: () => void,
  ): HTMLInputElement => {
    const input = el(parent, 'input', type === 'checkbox' ? 'sg-tick' : 'sg-default');
    input.type = type;
    input.name = name;
    input.checked = checked;
    if (checked) input.setAttribute('checked', '');
    input.setAttribute('aria-label', label);
    input.setAttribute(SIGNIN_CONTROL_ATTR, type === 'checkbox' ? 'list' : 'default');
    if (disabled) input.setAttribute('disabled', '');
    input.addEventListener('click', (ev: Event) => {
      ev?.preventDefault?.();
      if (!disabled) onClick();
    });
    return input;
  };

  const renderRow = (body: HTMLElement, signin: PackSignIn, row: PackSignInRow): void => {
    const tr = el(body, 'tr', 'sg-row');
    tr.setAttribute(SIGNIN_ROW_ATTR, row.pack_slug);
    const head = el(tr, 'th', 'sg-pack');
    head.scope = 'row';
    el(head, 'span', 'sg-pack-name', row.pack_name);
    if (row.members.length > 0) {
      const details = el(head, 'details', 'sg-members');
      el(details, 'summary', undefined, COPY.members(row.members.length));
      const list = el(details, 'ul', 'sg-members-list');
      for (const member of row.members) el(list, 'li', undefined, member.pack_name);
    }
    for (const connection of signin.connections) {
      const cellState = row.cells[connection.connection_name] ?? 'unavailable';
      const key = `${row.pack_slug}::${connection.connection_name}`;
      const td = el(tr, 'td', 'sg-cell');
      td.setAttribute(SIGNIN_CELL_ATTR, key);
      td.setAttribute(SIGNIN_CELL_STATE_ATTR, cellState);
      if (cellState === 'unavailable') {
        const dash = el(td, 'span', 'sg-cannot', '—');
        dash.title = COPY.cannot(row.pack_name, connection.display_name);
        dash.setAttribute('aria-label', COPY.cannot(row.pack_name, connection.display_name));
        continue;
      }
      const change: PackConnectionChange = { pack_slug: row.pack_slug, slot: signin.slot, connection_name: connection.connection_name };
      const isBusy = busy.has(key);
      const listed = cellState === 'default' || cellState === 'listed';
      control(td, 'checkbox', key, listed, COPY.may_use(row.pack_name, connection.display_name), isBusy, () => {
        if (listed) ask(change, row.pack_name, connection.display_name);
        else write(key, () => callers!.add(change));
      });
      if (listed) {
        control(
          td,
          'radio',
          `default::${signin.slot}::${row.pack_slug}`,
          cellState === 'default',
          COPY.is_default(row.pack_name, connection.display_name),
          isBusy,
          () => {
            if (cellState !== 'default') write(key, () => callers!.setDefault(change));
          },
        );
      }
    }
  };

  const renderGrid = (section: HTMLElement, signin: PackSignIn): void => {
    const grid = el(section, 'div', 'sg-grid');
    grid.setAttribute(SIGNIN_GRID_ATTR, signin.slot);
    el(grid, 'p', 'sg-title', COPY.signin(signin.label, signin.connections.length));
    const scroll = el(grid, 'div', 'sg-scroll');
    const table = el(scroll, 'table', 'sg-table');
    const headRow = el(el(table, 'thead'), 'tr');
    const corner = el(headRow, 'th', 'sg-corner', COPY.pack_column);
    corner.scope = 'col';
    for (const connection of signin.connections) {
      const th = el(headRow, 'th', 'sg-connection', connection.display_name);
      th.scope = 'col';
      th.title = connection.connection_name;
    }
    const body = el(table, 'tbody');
    for (const row of signin.rows) renderRow(body, signin, row);
    // "Use with all", under each connection some row could still take. No footer
    // when none could: an empty row would only draw a line.
    const targetsOf = (connection_name: string) => signin.rows
      .filter((row) => row.cells[connection_name] === 'available')
      .map((row) => ({ pack_slug: row.pack_slug, slot: signin.slot }));
    const anyToAdd = signin.connections.some((connection) => targetsOf(connection.connection_name).length > 0);
    const footRow = anyToAdd ? el(el(table, 'tfoot'), 'tr') : null;
    if (footRow !== null) el(footRow, 'td');
    for (const connection of footRow === null ? [] : signin.connections) {
      const td = el(footRow!, 'td', 'sg-foot');
      const targets = targetsOf(connection.connection_name);
      if (targets.length === 0) continue;
      const key = `all::${connection.connection_name}`;
      const b = button(td, COPY.use_all, false, busy.has(key), () =>
        write(key, () => callers!.addMany({ connection_name: connection.connection_name, targets })));
      b.setAttribute(SIGNIN_USE_ALL_ATTR, connection.connection_name);
      b.setAttribute('aria-label', COPY.use_all_label(connection.display_name));
    }
    const open = confirming;
    if (open !== null && open.change.slot === signin.slot) renderConfirm(grid, open);
  };

  const renderConfirm = (grid: HTMLElement, open: Confirming): void => {
    const box = el(grid, 'div', 'sg-confirm');
    box.setAttribute(SIGNIN_CONFIRM_ATTR, `${open.change.pack_slug}::${open.change.connection_name}`);
    el(box, 'p', 'sg-confirm-question', COPY.confirm(open.display_name, open.pack_name));
    const effect = open.effect;
    if (effect !== null && !(effect.status === 'ready' && effect.effect === undefined)) {
      const line = el(
        box,
        'p',
        effect.status === 'failed' ? 'sg-error' : 'sg-note',
        effect.status === 'loading'
          ? COPY.effect_loading
          : effect.status === 'failed'
            ? COPY.effect_failed
            : connectionRemovalSentence(effect.effect!),
      );
      line.setAttribute(SIGNIN_EFFECT_ATTR, effect.status === 'ready' ? effect.effect!.outcome : effect.status);
    }
    // D-320 audit — and each recipe reading this list and another's: its runs need a
    // connection on both, so its answer is not the pack's.
    if (effect !== null && effect.status === 'ready') {
      for (const recipe of effect.recipes) {
        el(box, 'p', 'sg-note', connectionRemovalRecipeSentence(recipe))
          .setAttribute(SIGNIN_RECIPE_EFFECT_ATTR, recipe.recipe_id);
      }
    }
    const key = `${open.change.pack_slug}::${open.change.connection_name}`;
    const actions = el(box, 'div', 'sg-confirm-actions');
    button(actions, COPY.remove, true, busy.has(key), () => {
      const change = open.change;
      confirming = null;
      write(key, () => callers!.remove(change));
    }).setAttribute(SIGNIN_CONFIRM_ACTION_ATTR, 'remove');
    button(actions, COPY.keep, false, false, () => {
      confirming = null;
      changed();
    }).setAttribute(SIGNIN_CONFIRM_ACTION_ATTR, 'keep');
  };

  /** Answer the question: the ticked packs take the connection, made their
   *  default when the owner asked. None ticked: nothing to write. */
  const answer = (open: Offer, targets: readonly OfferTarget[], makeDefault: boolean): void => {
    const chosen = targets.filter((target) => open.ticked?.has(target.key) === true);
    if (chosen.length === 0) {
      offer = null;
      changed();
      return;
    }
    open.writing = true;
    open.error = null;
    changed();
    void track(callers!.addMany({
      connection_name: open.connection_name,
      targets: chosen.map((target) => ({ pack_slug: target.row.pack_slug, slot: target.signin.slot })),
      ...(makeDefault ? { make_default: true } : {}),
    }).then(
      (view) => {
        if (offer === open) offer = null;
        state = { status: 'ready', view };
        changed();
      },
      (error: unknown) => {
        open.writing = false;
        open.error = humanizeRpcError(error);
        changed();
      },
    ));
  };

  const offerDefaultLine = (chosen: readonly OfferTarget[]): string | null => {
    if (chosen.length === 0) return null;
    const withDefault = chosen.filter((target) => target.row.default !== undefined);
    if (withDefault.length === chosen.length) {
      const defaults = new Set(withDefault.map((target) => target.row.default!));
      if (defaults.size > 1) return COPY.offer_keeps_each;
      const name = [...defaults][0]!;
      const alias = chosen[0]!.signin.connections.find((c) => c.connection_name === name)?.display_name ?? name;
      return COPY.offer_keeps_one(alias);
    }
    if (chosen.every((target) => !hasConnection(target.row))) return COPY.offer_becomes;
    return COPY.offer_mixed;
  };

  const renderOffer = (section: HTMLElement, open: Offer, targets: readonly OfferTarget[]): void => {
    if (open.ticked === null) open.ticked = new Set(targets.map((target) => target.key));
    const ticked = open.ticked;
    const box = el(section, 'div', 'sg-offer');
    box.setAttribute(SIGNIN_OFFER_ATTR, open.connection_name);
    const alias = targets[0]!.signin.connections.find((c) => c.connection_name === open.connection_name)?.display_name
      ?? open.connection_name;
    el(box, 'p', 'sg-offer-title', COPY.offer_title(alias));
    const slots = [...new Set(targets.map((target) => target.signin.slot))];
    for (const slot of slots) {
      const ofSlot = targets.filter((target) => target.signin.slot === slot);
      el(box, 'p', 'sg-offer-question', COPY.offer_question(ofSlot[0]!.signin.label));
      const list = el(box, 'ul', 'sg-offer-list');
      for (const target of ofSlot) {
        const item = el(list, 'li', 'sg-offer-item');
        const label = el(item, 'label', 'sg-offer-label');
        const input = el(label, 'input', 'sg-tick');
        input.type = 'checkbox';
        input.checked = ticked.has(target.key);
        if (input.checked) input.setAttribute('checked', '');
        input.setAttribute(SIGNIN_OFFER_PACK_ATTR, target.key);
        if (open.writing) input.setAttribute('disabled', '');
        input.addEventListener('click', (ev: Event) => {
          ev?.preventDefault?.();
          if (open.writing) return;
          if (ticked.has(target.key)) ticked.delete(target.key);
          else ticked.add(target.key);
          changed();
        });
        const members = target.row.members.length;
        el(label, 'span', undefined, members === 0 ? target.row.pack_name : `${target.row.pack_name} ${COPY.members(members)}`);
      }
    }
    const chosen = targets.filter((target) => ticked.has(target.key));
    const line = offerDefaultLine(chosen);
    if (line !== null) el(box, 'p', 'sg-note', line);
    if (open.error !== null) {
      el(box, 'p', 'sg-error', COPY.action_failed(open.error)).setAttribute(SIGNIN_ERROR_ATTR, '');
    }
    const actions = el(box, 'div', 'sg-confirm-actions');
    if (chosen.some((target) => hasConnection(target.row))) {
      button(actions, COPY.offer_make_default, false, open.writing, () => answer(open, targets, true))
        .setAttribute(SIGNIN_OFFER_ACTION_ATTR, 'make-default');
    }
    button(actions, COPY.offer_done, true, open.writing, () => answer(open, targets, false))
      .setAttribute(SIGNIN_OFFER_ACTION_ATTR, 'done');
    button(actions, COPY.offer_not_now, false, open.writing, () => {
      offer = null;
      changed();
    }).setAttribute(SIGNIN_OFFER_ACTION_ATTR, 'not-now');
  };

  const render = (): HTMLElement | null => {
    if (!enabled || disposed) return null;
    if (state.status === 'idle') load();
    const current = state;
    if (current.status === 'unsupported') return null;
    // A question with nothing to ask (no pack could use the connection) closes.
    const targets = current.status === 'ready' && offer !== null ? offerTargets(current.view, offer.connection_name) : [];
    if (current.status === 'ready' && offer !== null && targets.length === 0) offer = null;
    const grids = current.status === 'ready' ? signInsWithChoice(current.view) : [];
    if (current.status === 'ready' && grids.length === 0 && offer === null) return null;
    const section = doc.createElement('section');
    section.className = 'sg-section';
    section.setAttribute(SIGNIN_GRIDS_ATTR, '');
    el(section, 'h4', 'sg-heading', COPY.heading);
    if (current.status === 'loading' || current.status === 'idle') {
      el(section, 'p', 'sg-note', COPY.loading);
      return section;
    }
    if (current.status === 'error') {
      el(section, 'p', 'sg-error', COPY.load_failed(current.message)).setAttribute(SIGNIN_ERROR_ATTR, '');
      button(section, COPY.retry, false, false, () => {
        state = { status: 'loading' };
        load();
        changed();
      });
      return section;
    }
    if (grids.length > 0) el(section, 'p', 'sg-note', COPY.intro);
    if (offer !== null) renderOffer(section, offer, targets);
    if (writeError !== null) {
      el(section, 'p', 'sg-error', COPY.action_failed(writeError)).setAttribute(SIGNIN_ERROR_ATTR, '');
    }
    for (const signin of grids) renderGrid(section, signin);
    return section;
  };

  return {
    enabled,
    refresh: () => {
      state = { status: 'idle' };
      writeError = null;
      confirming = null;
    },
    render,
    offerNewConnection: (connection_name: string) => {
      if (!enabled || disposed) return;
      offer = { connection_name, ticked: null, writing: false, error: null };
      // Read the grid again: the connection is new to it.
      state = { status: 'idle' };
      changed();
    },
    whenSettled: async () => {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
    dispose: () => {
      disposed = true;
    },
  };
};
