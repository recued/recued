/** D-320 — the Access tab's Connections block (D-320 §4): which of
 *  the owner's connections a pack signs in with, which one is its default, and
 *  Add another / Make default / Remove. Backed by `packs.connections.*`.
 *
 *  - A pack's list for a sign-in (a slot: the connection name its catalog
 *    declares) is the connections its catalog is bound to. A run with no
 *    connection chosen uses the default.
 *  - Two or more on the list and no default: runs ask which one, and scheduled
 *    runs fail. The block says so rather than leaving the owner to find out.
 *  - Removing asks first, inline: taking a connection off a pack stops the pack's
 *    operations from running there. The question says where the pack's runs go
 *    next (slice 2g, ruling 16): taking one off a list of two moves them to the
 *    other, which used to happen without a word.
 *
 *  Same controller shape as the Access panel beside it (`pack-access-controls.ts`):
 *  injected callers, a host re-render hook, a sync `renderForPack` over cached
 *  state that loads on first sight. */

import type { PackListEntry, RpcRequest, RpcResponse, ServerRpcRegistry } from '@recued/contracts';
import {
  connectionRemovalRecipeChanges,
  connectionRemovalRecipeSentence,
  connectionRemovalSentence,
  type ConnectionRemovalEffect,
  type ConnectionRemovalRecipeEffect,
} from '@recued/ui-shared';

import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import { connectionsEnrollAddress } from '../connections/connections-navigation.js';

export type PackConnectionsView = RpcResponse<ServerRpcRegistry, 'packs.connections.list'>;
type PackConnectionSlot = PackConnectionsView['slots'][number];
type PackConnectionChange = RpcRequest<ServerRpcRegistry, 'packs.connections.add'>;

/** The four `packs.connections.*` calls, and what a removal does. */
export interface PackConnectionsCallers {
  list: (args: { pack_slug: string }) => Promise<PackConnectionsView>;
  add: (args: PackConnectionChange) => Promise<PackConnectionsView>;
  remove: (args: PackConnectionChange) => Promise<PackConnectionsView>;
  setDefault: (args: PackConnectionChange) => Promise<PackConnectionsView>;
  /** D-320 slice 2g — `packs.connections.removal`. Absent, or a server without
   *  it: Remove asks without saying where the runs go. */
  removal?: (args: { connection_name: string; pack_slug: string }) => Promise<
    RpcResponse<ServerRpcRegistry, 'packs.connections.removal'>
  >;
}

export const PACK_CONNECTIONS_ATTR = 'data-recued-pack-connections';
/** On each connection row: the connection's name. */
export const PACK_CONNECTIONS_ROW_ATTR = 'data-recued-pack-connection';
/** On a row's action buttons: `make-default` / `remove` / `confirm-remove` / `keep`. */
export const PACK_CONNECTIONS_ACTION_ATTR = 'data-recued-pack-connection-action';
/** The Add another select and its button. */
export const PACK_CONNECTIONS_ADD_SELECT_ATTR = 'data-recued-pack-connection-add-select';
export const PACK_CONNECTIONS_ADD_ATTR = 'data-recued-pack-connection-add';
/** The "no default" warning. */
export const PACK_CONNECTIONS_NO_DEFAULT_ATTR = 'data-recued-pack-connection-no-default';
/** D-320 slice 2g — under "Stop using X?": where the pack's runs go next. Its
 *  value is the outcome (`moves` / `no_default` / `stops` / `unchanged`), or
 *  `loading` / `failed`. */
export const PACK_CONNECTIONS_EFFECT_ATTR = 'data-recued-pack-connection-effect';
/** D-320 audit — one line per recipe reading this pack's list and another's, whose
 *  runs go elsewhere than the pack's; the value is the recipe's id. */
export const PACK_CONNECTIONS_RECIPE_EFFECT_ATTR = 'data-recued-pack-connection-recipe-effect';
/** D-320 slice 2j — "Set up a new connection": the vendor's form. */
export const PACK_CONNECTIONS_SET_UP_ATTR = 'data-recued-pack-connection-set-up';
/** D-320 ruling 9 — on a borrowing pack's note: the holder's slug. */
export const PACK_CONNECTIONS_HELD_BY_ATTR = 'data-recued-pack-connection-held-by';
export const PACK_CONNECTIONS_ERROR_ATTR = 'data-recued-pack-connection-error';

const COPY = {
  heading: 'Connections',
  intro: 'The connections this pack signs in with. A run uses the default.',
  slot_label: (slot: string) => `Signs in to ${slot}`,
  default_badge: 'Default',
  make_default: 'Make default',
  remove: 'Remove',
  confirm_remove: (alias: string) => `Stop using ${alias} for this pack?`,
  keep: 'Keep',
  not_set_up: 'No longer set up. Set it up again under Connections, or remove it here.',
  not_set_up_held: 'No longer set up.',
  none_yet: 'This pack has no connection yet.',
  no_default:
    'No default: runs ask which connection to use, and scheduled runs fail until you choose one.',
  add_label: 'Add another',
  add_button: 'Add',
  no_candidates: 'To add another connection, set it up under Connections first.',
  set_up_new: 'Set up a new connection',
  no_candidates_vendor: 'No other connection can join yet.',
  connections_link: 'Connections',
  loading: 'Loading connections…',
  load_failed: (message: string) => `Could not load this pack's connections: ${message}`,
  retry: 'Try again',
  action_failed: (message: string) => `That did not work: ${message}`,
  held_by_before: 'Uses the connections of ',
  held_by_after: '. Change them there.',
  shared_with: (packs: readonly string[]) => `Also used by ${packs.join(', ')}.`,
  effect_subject: 'This pack',
  effect_loading: 'Checking where its runs go…',
  effect_failed: 'Could not check where its runs go next.',
} as const;

export interface PackConnectionsControllerOptions {
  document: Document;
  /** Absent ⇒ the block is not shown (the server does not offer the calls). */
  callers?: PackConnectionsCallers;
  /** Host re-render hook, fired after every state change. */
  onChange: () => void;
}

export interface PackConnectionsController {
  readonly enabled: boolean;
  /** Forget what was loaded, so the next render reloads (the packs list changed). */
  refresh(): void;
  /** The block for one pack: null while disabled, or once loaded when the pack
   *  signs in to nothing (no catalog of its own). */
  renderForPack(pack: PackListEntry): HTMLElement | null;
  /** Test seam: resolves once nothing is loading or writing. */
  whenSettled(): Promise<void>;
  dispose(): void;
}

type PackState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  /** The server predates `packs.connections.*` (self-hosted servers update on
   *  their own schedule): the block is not shown, rather than an error. */
  | { status: 'unsupported' }
  | { status: 'ready'; view: PackConnectionsView };

const messageOf = (error: unknown): string => humanizeRpcError(error);

export const createPackConnectionsController = (
  opts: PackConnectionsControllerOptions,
): PackConnectionsController => {
  const doc = opts.document;
  const callers = opts.callers;
  const enabled = callers !== undefined;
  const states = new Map<string, PackState>();
  /** `pack::slot::connection` with a write in flight. */
  const busy = new Set<string>();
  /** The row asking "Stop using …?", if any, and its change. */
  let confirming: string | null = null;
  let confirmingChange: PackConnectionChange | null = null;
  /** The last write's failure, per pack, shown above the rows until the next write. */
  const writeErrors = new Map<string, string>();
  /** Where the pack's runs go if a row is removed, per row key (slice 2g). */
  const effects = new Map<
    string,
    | { status: 'loading' }
    | { status: 'failed' }
    | {
      status: 'ready';
      effect: ConnectionRemovalEffect | undefined;
      /** The recipes that read this list and another's, whose runs change. */
      recipes: readonly ConnectionRemovalRecipeEffect[];
    }
  >();
  let inFlight = new Set<Promise<unknown>>();
  let disposed = false;

  const track = <T>(p: Promise<T>): Promise<T> => {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
    return p;
  };
  const changed = (): void => {
    if (!disposed) opts.onChange();
  };

  const load = (packSlug: string): void => {
    if (callers === undefined) return;
    states.set(packSlug, { status: 'loading' });
    void track(callers.list({ pack_slug: packSlug }).then(
      (view) => {
        states.set(packSlug, { status: 'ready', view });
        changed();
      },
      (error: unknown) => {
        states.set(
          packSlug,
          classifyRpcError(error).code === 'unknown_method'
            ? { status: 'unsupported' }
            : { status: 'error', message: messageOf(error) },
        );
        changed();
      },
    ));
  };

  /** Ask where the pack's runs go if this connection leaves its list. A server
   *  without the call says nothing more, rather than an error. */
  const loadEffect = (change: PackConnectionChange, key: string): void => {
    const removal = callers?.removal;
    if (removal === undefined) return;
    effects.set(key, { status: 'loading' });
    void track(removal({ connection_name: change.connection_name, pack_slug: change.pack_slug }).then(
      (view) => {
        effects.set(key, {
          status: 'ready',
          effect: view.packs.find((p) => p.slot === change.slot) ?? view.packs[0],
          recipes: connectionRemovalRecipeChanges(view.recipes),
        });
        changed();
      },
      (error: unknown) => {
        effects.set(
          key,
          classifyRpcError(error).code === 'unknown_method'
            ? { status: 'ready', effect: undefined, recipes: [] }
            : { status: 'failed' },
        );
        changed();
      },
    ));
  };

  const write = (
    call: (args: PackConnectionChange) => Promise<PackConnectionsView>,
    change: PackConnectionChange,
  ): void => {
    const key = `${change.pack_slug}::${change.slot}::${change.connection_name}`;
    if (busy.has(key)) return;
    busy.add(key);
    writeErrors.delete(change.pack_slug);
    changed();
    void track(call(change).then(
      (view) => {
        busy.delete(key);
        states.set(change.pack_slug, { status: 'ready', view });
        // The list changed, so where a removal sends the runs may have too.
        effects.clear();
        if (confirming !== null && confirmingChange !== null && confirmingChange.pack_slug === change.pack_slug) {
          loadEffect(confirmingChange, confirming);
        }
        changed();
      },
      (error: unknown) => {
        busy.delete(key);
        writeErrors.set(change.pack_slug, messageOf(error));
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

  const button = (
    parent: HTMLElement,
    label: string,
    action: string,
    primary: boolean,
    disabled: boolean,
    onClick: () => void,
  ): HTMLButtonElement => {
    const b = el(parent, 'button', primary ? 'rx-btn rx-btn-primary' : 'rx-btn rx-btn-secondary', label);
    b.type = 'button';
    b.setAttribute(PACK_CONNECTIONS_ACTION_ATTR, action);
    if (disabled) b.setAttribute('disabled', '');
    b.addEventListener('click', () => {
      if (!disabled) onClick();
    });
    return b;
  };

  const renderSlot = (
    parent: HTMLElement,
    packSlug: string,
    slot: PackConnectionSlot,
    labelled: boolean,
  ): void => {
    const block = el(parent, 'div', 'pc-slot');
    if (labelled) el(block, 'p', 'pc-slot-label', COPY.slot_label(slot.slot));
    // D-320 ruling 9 — this pack signs in through another pack's connections: the
    // list shown is the holder's, read-only here, changed on the holder.
    const heldBy = slot.held_by;
    if (heldBy !== undefined) {
      const note = el(block, 'p', 'pc-note', COPY.held_by_before);
      note.setAttribute(PACK_CONNECTIONS_HELD_BY_ATTR, heldBy);
      // D-320 slice 2h — named by its name (its slug from an older server).
      const link = el(note, 'a', 'rx-link', slot.held_by_name ?? heldBy);
      link.setAttribute('href', `#packs/${heldBy}`);
      el(note, 'span', undefined, COPY.held_by_after);
    }
    if (slot.connections.length === 0) el(block, 'p', 'pc-note', COPY.none_yet);
    const list = el(block, 'ul', 'pc-list');
    for (const connection of slot.connections) {
      const change = { pack_slug: packSlug, slot: slot.slot, connection_name: connection.connection_name };
      const key = `${packSlug}::${slot.slot}::${connection.connection_name}`;
      const isBusy = busy.has(key);
      const row = el(list, 'li', 'pc-row');
      row.setAttribute(PACK_CONNECTIONS_ROW_ATTR, connection.connection_name);
      const name = el(row, 'span', 'pc-name', connection.display_name);
      name.title = connection.connection_name;
      if (connection.is_default) el(row, 'span', 'pc-badge', COPY.default_badge);
      if (!connection.enrolled) {
        el(row, 'span', 'pc-note', heldBy !== undefined ? COPY.not_set_up_held : COPY.not_set_up);
      }
      if (heldBy !== undefined) continue;
      const actions = el(row, 'span', 'pc-actions');
      if (confirming === key) {
        el(actions, 'span', 'pc-confirm', COPY.confirm_remove(connection.display_name));
        button(actions, COPY.remove, 'confirm-remove', true, isBusy, () => {
          confirming = null;
          write(callers!.remove, change);
        });
        button(actions, COPY.keep, 'keep', false, isBusy, () => {
          confirming = null;
          changed();
        });
        const effect = effects.get(key);
        if (effect !== undefined && !(effect.status === 'ready' && effect.effect === undefined)) {
          const line = el(
            row,
            'p',
            effect.status === 'failed' ? 'pc-error pc-effect' : 'pc-note pc-effect',
            effect.status === 'loading'
              ? COPY.effect_loading
              : effect.status === 'failed'
                ? COPY.effect_failed
                : connectionRemovalSentence(effect.effect!, COPY.effect_subject),
          );
          line.setAttribute(
            PACK_CONNECTIONS_EFFECT_ATTR,
            effect.status === 'ready' ? effect.effect!.outcome : effect.status,
          );
        }
        // D-320 audit — and each recipe reading this list and another's, whose runs
        // need a connection on both: its answer is not the pack's.
        if (effect?.status === 'ready') {
          for (const recipe of effect.recipes) {
            el(row, 'p', 'pc-note pc-effect', connectionRemovalRecipeSentence(recipe))
              .setAttribute(PACK_CONNECTIONS_RECIPE_EFFECT_ATTR, recipe.recipe_id);
          }
        }
        continue;
      }
      if (!connection.is_default && connection.enrolled) {
        button(actions, COPY.make_default, 'make-default', false, isBusy, () => write(callers!.setDefault, change));
      }
      button(actions, COPY.remove, 'remove', false, isBusy, () => {
        confirming = key;
        confirmingChange = change;
        loadEffect(change, key);
        changed();
      });
    }
    if (slot.connections.length >= 2 && !slot.connections.some((c) => c.is_default)) {
      const warn = el(block, 'p', 'pc-warning', COPY.no_default);
      warn.setAttribute(PACK_CONNECTIONS_NO_DEFAULT_ATTR, '');
    }
    if (slot.shared_with !== undefined && slot.shared_with.length > 0) {
      el(block, 'p', 'pc-note', COPY.shared_with(slot.shared_with_names ?? slot.shared_with));
    }
    if (heldBy !== undefined) return;
    const add = el(block, 'div', 'pc-add');
    // D-320 slice 2j — set a new connection up from here: the vendor's form, and the
    // connection it makes asks which packs may use it (this one ticked).
    const setUpLink = (parent: HTMLElement): void => {
      if (slot.vendor === undefined) return;
      const link = el(parent, 'a', 'rx-link', COPY.set_up_new);
      link.setAttribute('href', connectionsEnrollAddress(slot.vendor, { slug: packSlug, slot: slot.slot }).hash);
      link.setAttribute(PACK_CONNECTIONS_SET_UP_ATTR, slot.vendor);
    };
    if (slot.candidates.length === 0) {
      if (slot.vendor !== undefined) {
        const note = el(add, 'p', 'pc-note', `${COPY.no_candidates_vendor} `);
        setUpLink(note);
        return;
      }
      const note = el(add, 'p', 'pc-note', `${COPY.no_candidates} `);
      const link = el(note, 'a', 'rx-link', COPY.connections_link);
      link.setAttribute('href', '#connections');
      return;
    }
    const label = el(add, 'label', 'pc-add-label', COPY.add_label);
    const select = el(label, 'select', 'pc-add-select');
    select.setAttribute(PACK_CONNECTIONS_ADD_SELECT_ATTR, slot.slot);
    for (const candidate of slot.candidates) {
      const option = el(select, 'option', undefined, candidate.display_name);
      option.value = candidate.connection_name;
    }
    select.value = slot.candidates[0]!.connection_name;
    const addBusy = [...busy].some((k) => k.startsWith(`${packSlug}::${slot.slot}::`));
    const addButton = button(add, COPY.add_button, 'add', true, addBusy, () => {
      const chosen = select.value;
      if (chosen.length === 0) return;
      write(callers!.add, { pack_slug: packSlug, slot: slot.slot, connection_name: chosen });
    });
    addButton.setAttribute(PACK_CONNECTIONS_ADD_ATTR, slot.slot);
    setUpLink(add);
  };

  const renderForPack = (pack: PackListEntry): HTMLElement | null => {
    if (!enabled || disposed) return null;
    const state = states.get(pack.slug);
    if (state === undefined) load(pack.slug);
    const current = states.get(pack.slug) ?? { status: 'loading' as const };
    if (current.status === 'unsupported') return null;
    if (current.status === 'ready' && current.view.slots.length === 0) return null;
    const section = doc.createElement('section');
    section.setAttribute(PACK_CONNECTIONS_ATTR, pack.slug);
    el(section, 'h4', 'pc-heading', COPY.heading);
    if (current.status === 'loading') {
      el(section, 'p', 'pc-note', COPY.loading);
      return section;
    }
    if (current.status === 'error') {
      const error = el(section, 'p', 'pc-error', COPY.load_failed(current.message));
      error.setAttribute(PACK_CONNECTIONS_ERROR_ATTR, '');
      button(section, COPY.retry, 'retry', false, false, () => {
        load(pack.slug);
        changed();
      });
      return section;
    }
    el(section, 'p', 'pc-note', COPY.intro);
    const writeError = writeErrors.get(pack.slug);
    if (writeError !== undefined) {
      const error = el(section, 'p', 'pc-error', COPY.action_failed(writeError));
      error.setAttribute(PACK_CONNECTIONS_ERROR_ATTR, '');
    }
    const labelled = current.view.slots.length > 1;
    for (const slot of current.view.slots) renderSlot(section, pack.slug, slot, labelled);
    return section;
  };

  return {
    enabled,
    refresh: () => {
      states.clear();
      writeErrors.clear();
      effects.clear();
      confirming = null;
    },
    renderForPack,
    whenSettled: async () => {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
    dispose: () => {
      disposed = true;
      inFlight = new Set();
    },
  };
};

export const PACK_CONNECTIONS_STYLES = `
[${PACK_CONNECTIONS_ATTR}] {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}
[${PACK_CONNECTIONS_ATTR}] .pc-heading {
  margin: 0;
  font-size: 13px;
}
[${PACK_CONNECTIONS_ATTR}] .pc-note,
[${PACK_CONNECTIONS_ATTR}] .pc-slot-label {
  margin: 0;
  font-size: 12px;
  color: var(--fg-muted);
}
[${PACK_CONNECTIONS_ATTR}] .pc-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
[${PACK_CONNECTIONS_ATTR}] .pc-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 13px;
}
[${PACK_CONNECTIONS_ATTR}] .pc-name {
  font-weight: 600;
  overflow-wrap: anywhere;
}
[${PACK_CONNECTIONS_ATTR}] .pc-badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent-bg, var(--bg-muted));
  color: var(--accent, var(--fg));
}
[${PACK_CONNECTIONS_ATTR}] .pc-actions {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-left: auto;
}
[${PACK_CONNECTIONS_ATTR}] .pc-confirm {
  font-size: 12px;
}
[${PACK_CONNECTIONS_ATTR}] .pc-warning {
  margin: 0;
  padding: 6px 8px;
  border-radius: 4px;
  font-size: 12px;
  background: var(--warning-bg, var(--bg-muted));
  color: var(--warning, var(--fg));
}
[${PACK_CONNECTIONS_ATTR}] .pc-error {
  margin: 0;
  padding: 6px 8px;
  border-radius: 4px;
  font-size: 12px;
  background: var(--danger-bg);
  color: var(--danger);
  word-break: break-word;
}
[${PACK_CONNECTIONS_ATTR}] .pc-add {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12px;
}
[${PACK_CONNECTIONS_ATTR}] .pc-effect {
  flex-basis: 100%;
}
[${PACK_CONNECTIONS_ATTR}] .pc-add-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
`;
