/** D-348 slice 3 — the `#contracts` panel for the chains the owner's approvals teach: a request
 *  they repeat in their chats, in their own words, and the calls it leads to.
 *
 *  Two lists, each shown only when it has something in it, in the write rules' cards
 *  (`ruleCardStyles`):
 *
 *  - **Suggestions.** A request whose held calls the owner approved as proposed, and which ran, on
 *    three days in 30, nothing refused, failed or undone since. Its words, each call (by its name,
 *    with whom it reaches or what it changes), and the days. **Accept** opens the bounds (days,
 *    uses), both at most the ceilings and tighten-only; "Make the rule" mints it. One that adds to
 *    a rule the owner has replaces it and keeps that rule's days and uses left. **Dismiss** asks
 *    once more, since it is for good.
 *  - **Its delete, on its own (Q7).** A delete the request led to, approved and run on five days,
 *    is offered below the rest with its own two answers: **Also let this run**, or **Not this**
 *    (for good). It only ever deletes what the request's own run found.
 *  - **Rules.** The live ones: the words, each call, the uses left and until when. **End rule** asks
 *    once more, then ends it; the request is never suggested again.
 *
 *  The rpc family is `collection.contract.*`, which MCP never reaches: an AI never sees its own
 *  suggestion. Spec: D-348 §7. */

import {
  askDetailLabel,
  chainTier1CallArgs,
  CHAIN_RULE_MAX_USES,
  CHAIN_RULE_TTL_MS,
  tier1CallDetails,
  type ChainCallView,
  type ChainRuleRow,
  type ChainSuggestionRow,
} from '@recued/contracts';

import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import { ruleCardStyles } from './write-rules-panel.js';

export interface ChainRulesPanelCallers {
  readonly listSuggestions: () => Promise<{ suggestions: ReadonlyArray<ChainSuggestionRow> }>;
  readonly accept: (args: {
    key_hash: string;
    deletes?: boolean;
    ttl_ms?: number;
    max_uses?: number;
  }) => Promise<{ rule: ChainRuleRow; suggestion: ChainSuggestionRow }>;
  readonly dismiss: (args: { key_hash: string; part?: 'all' | 'deletes' }) => Promise<{ key_hash: string; part: 'all' | 'deletes' }>;
  readonly listRules: () => Promise<{ rules: ReadonlyArray<ChainRuleRow> }>;
  readonly revoke: (args: { rule_id: string }) => Promise<{ rule: ChainRuleRow }>;
}

export interface MountChainRulesPanelOptions extends ChainRulesPanelCallers {
  readonly host: HTMLElement;
  readonly document?: Document;
}

export interface ChainRulesPanelMount {
  refresh(): Promise<void>;
  whenLoaded(): Promise<void>;
  hasInFlightWork(): boolean;
  dispose(): void;
}

export const CHAIN_RULES_PANEL_HOST_ATTR = 'data-recued-chain-rules-panel';
export const CHAIN_SUGGESTION_ATTR = 'data-recued-chain-suggestion';
export const CHAIN_RULE_ATTR = 'data-recued-chain-rule';
export const CHAIN_CALL_ATTR = 'data-recued-chain-call';
export const CHAIN_ACCEPT_ATTR = 'data-recued-chain-accept';
export const CHAIN_DAYS_ATTR = 'data-recued-chain-days';
export const CHAIN_USES_ATTR = 'data-recued-chain-uses';
export const CHAIN_MINT_ATTR = 'data-recued-chain-mint';
export const CHAIN_DISMISS_ATTR = 'data-recued-chain-dismiss';
export const CHAIN_DELETE_ACCEPT_ATTR = 'data-recued-chain-delete-accept';
export const CHAIN_DELETE_DISMISS_ATTR = 'data-recued-chain-delete-dismiss';
export const CHAIN_REVOKE_ATTR = 'data-recued-chain-revoke';
export const CHAIN_CONFIRM_ATTR = 'data-recued-chain-confirm';
export const CHAIN_CANCEL_ATTR = 'data-recued-chain-cancel';
export const CHAIN_ERROR_ATTR = 'data-recued-chain-error';

const DAY_MS = 86_400_000;
const TTL_CEILING_DAYS = Math.floor(CHAIN_RULE_TTL_MS / DAY_MS);

type Mode =
  | { readonly kind: 'idle' }
  | { readonly kind: 'accepting'; readonly key_hash: string }
  | { readonly kind: 'dismissing'; readonly key_hash: string }
  | { readonly kind: 'delete-accepting'; readonly key_hash: string }
  | { readonly kind: 'delete-dismissing'; readonly key_hash: string }
  | { readonly kind: 'revoking'; readonly rule_id: string };

const formatDate = (ms: number): string => (Number.isFinite(ms) ? new Date(ms).toLocaleDateString() : '—');

/** A whole number within [1, ceiling], or null: never clamped past what the owner typed. */
const parseBound = (raw: string, ceiling: number): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= ceiling ? n : null;
};

/** The request, in the owner's words. */
const requestHeading = (words: string | undefined): string =>
  (words !== undefined && words.trim() !== '' ? `When you ask “${words.trim()}”` : 'A request you repeat');

/** A call's operation, for one the server has no name for: a pack action's (`deal.update`), a
 *  recipe step's operation or its ingredient (`mail-send`), a chat write's kind. */
const operationOf = (op: string): string => {
  const at = op.indexOf(':');
  const kind = op.slice(0, at);
  const parts = op.slice(at + 1).split('|');
  if (kind === 'op') return parts[1] || op;
  if (kind === 'step') return parts[3] === undefined ? op : (parts[2] || parts[1] || op);
  return parts[0] || op;
};

/** What a call names, each value as the owner knows it (`pin_labels`): a chat write's fields as
 *  its approval card names them ("Event: Team sync, Sat 14 Nov 10:00", "Task: Pay rent"), any
 *  other's by its field ("To: ann@example.com"). It read "Source ID: 54d0ecc0-…" (live, 2026-11-13). */
/** A record's id, which says nothing to the owner: a UUID, a qualified work id (`we1:…`), or a long
 *  token with no spaces, address or dots. An address, a number or a word is a value and shows as is. */
const opaqueId = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/iu.test(value) || /^we\d+:/u.test(value)
  || (value.length >= 20 && /^[A-Za-z0-9_-]+$/u.test(value) && /\d/u.test(value));

const pinParts = (view: ChainCallView, pins: Readonly<Record<string, readonly string[]>>): string[] => {
  const known = view.pin_labels ?? {};
  // A record nobody could name now (removed since, or one this read cannot see) is said so, never by
  // its id: it read "Event: 54d0ecc0-…".
  const valueText = (value: string, labels: Readonly<Record<string, string>> | undefined): string =>
    labels !== undefined && Object.hasOwn(labels, value) ? labels[value]! : opaqueId(value) ? 'one Recued cannot show now' : value;
  const said = (field: string, values: readonly string[], labels: Readonly<Record<string, string>> | undefined): string =>
    `${askDetailLabel(field)}: ${values.map((value) => valueText(value, labels)).join(', ')}`;
  const call = view.signature === undefined ? undefined : chainTier1CallArgs(view.signature);
  if (call === undefined) return Object.entries(pins).map(([field, values]) => said(field, values, known[field]));
  const shown = tier1CallDetails(call.tool, call.args, known);
  // A value inside the call (a guest's address) is not among its arguments: shown as it is.
  const inside = Object.entries(pins).filter(([field]) => field.includes('.'));
  return [
    ...Object.entries(shown.args).map(([field, value]) =>
      said(field, (Array.isArray(value) ? value : [value]).map(String), shown.labels?.[field])),
    ...inside.map(([field, values]) => said(field, values, known[field])),
  ];
};

/** One call, as the owner reads it: its name (or, without one, its operation), then whom it
 *  reaches and what it changes ("Send mail · To: ann@example.com"). */
export const chainCallLine = (view: ChainCallView): string => {
  const signature = view.signature;
  if (signature === undefined) return 'A call Recued cannot show now';
  const name = view.title ?? operationOf(signature.op);
  const line = [name, ...pinParts(view, signature.pins)].join(' · ');
  return signature.delete === true ? `${line} (only what this request found itself)` : line;
};

export const mountChainRulesPanel = (opts: MountChainRulesPanelOptions): ChainRulesPanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) throw new Error('mountChainRulesPanel: no document available');
  const root = doc.createElement('div');
  root.setAttribute(CHAIN_RULES_PANEL_HOST_ATTR, '');
  opts.host.appendChild(root);

  let suggestions: ReadonlyArray<ChainSuggestionRow> = [];
  let rules: ReadonlyArray<ChainRuleRow> = [];
  let listError: string | null = null;
  let actionError: { id: string; message: string } | null = null;
  let mode: Mode = { kind: 'idle' };
  let busy: string | null = null;
  let disposed = false;
  let generation = 0;
  let loading: Promise<void> = Promise.resolve();

  const el = (tag: string, className?: string, text?: string): HTMLElement => {
    const node = doc.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (attr: string, className: string, label: string, onClick: () => void): HTMLElement => {
    const node = el('button', className, label) as HTMLButtonElement;
    node.type = 'button';
    node.setAttribute(attr, '');
    if (busy !== null) node.disabled = true;
    node.addEventListener('click', onClick);
    return node;
  };
  const cancel = (): HTMLElement =>
    button(CHAIN_CANCEL_ATTR, 'wr-secondary', 'Cancel', () => { mode = { kind: 'idle' }; render(); });
  const errorLine = (id: string): HTMLElement | null => {
    if (actionError === null || actionError.id !== id) return null;
    const line = el('div', 'wr-error', actionError.message);
    line.setAttribute(CHAIN_ERROR_ATTR, '');
    return line;
  };
  const enter = (next: Mode): void => {
    mode = next;
    actionError = null;
    render();
  };

  const act = async (id: string, run: () => Promise<unknown>): Promise<void> => {
    busy = id;
    actionError = null;
    render();
    try {
      await run();
      mode = { kind: 'idle' };
    } catch (error) {
      actionError = { id, message: humanizeRpcError(error) };
    } finally {
      busy = null;
    }
    if (!disposed) await refresh();
  };

  const callList = (views: readonly ChainCallView[]): HTMLElement => {
    const list = el('ul', 'cr-calls');
    for (const view of views) {
      const item = el('li', 'cr-call', chainCallLine(view));
      item.setAttribute(CHAIN_CALL_ATTR, view.signature_hash);
      list.appendChild(item);
    }
    return list;
  };

  /** The rule a suggestion would replace, and whether it only offers that rule's delete. */
  const ruleOf = (row: ChainSuggestionRow): ChainRuleRow | undefined =>
    row.rule_id === undefined ? undefined : rules.find((rule) => rule.rule_id === row.rule_id);
  const deleteOnly = (row: ChainSuggestionRow): boolean => {
    const rule = ruleOf(row);
    if (rule === undefined) return false;
    const held = new Set(rule.members.map((view) => view.signature_hash));
    return row.members.every((view) => held.has(view.signature_hash));
  };

  const renderSuggestion = (row: ChainSuggestionRow): HTMLElement => {
    const card = el('div', 'wr-card');
    card.setAttribute(CHAIN_SUGGESTION_ATTR, row.key_hash);
    const info = el('div', 'wr-card-info');
    info.appendChild(el('div', 'wr-card-heading', requestHeading(row.words)));
    const onlyDelete = deleteOnly(row);
    if (!onlyDelete) info.appendChild(callList(row.members));
    const ev = row.evidence;
    info.appendChild(el('div', 'wr-evidence',
      `You said yes to it on ${ev.occasions} different day${ev.occasions === 1 ? '' : 's'}`
      + (ev.first_at !== undefined && ev.last_at !== undefined ? `, ${formatDate(ev.first_at)} – ${formatDate(ev.last_at)}` : '')));
    if (row.rule_id !== undefined && !onlyDelete) {
      info.appendChild(el('div', 'wr-evidence', 'It adds to the rule you have for this request, and keeps its days and uses left.'));
    }
    card.appendChild(info);

    if (!onlyDelete) {
      const actions = el('div', 'wr-actions');
      if (mode.kind === 'accepting' && mode.key_hash === row.key_hash) {
        if (row.rule_id !== undefined) {
          actions.appendChild(el('span', 'wr-confirm-prompt', 'It replaces the rule you have for this request.'));
          actions.appendChild(button(CHAIN_MINT_ATTR, 'wr-primary', 'Make the rule', () => {
            void act(row.key_hash, () => opts.accept({ key_hash: row.key_hash }));
          }));
        } else {
          const days = el('input', 'wr-input') as HTMLInputElement;
          days.type = 'number';
          days.setAttribute(CHAIN_DAYS_ATTR, '');
          days.setAttribute('min', '1');
          days.setAttribute('max', String(TTL_CEILING_DAYS));
          days.setAttribute('aria-label', 'Days the rule lasts');
          days.value = String(TTL_CEILING_DAYS);
          const uses = el('input', 'wr-input') as HTMLInputElement;
          uses.type = 'number';
          uses.setAttribute(CHAIN_USES_ATTR, '');
          uses.setAttribute('min', '1');
          uses.setAttribute('max', String(CHAIN_RULE_MAX_USES));
          uses.setAttribute('aria-label', 'Times it may run');
          uses.value = String(CHAIN_RULE_MAX_USES);
          const daysLabel = el('label', 'wr-label', `Days (at most ${TTL_CEILING_DAYS})`);
          daysLabel.appendChild(days);
          const usesLabel = el('label', 'wr-label', `Times (at most ${CHAIN_RULE_MAX_USES})`);
          usesLabel.appendChild(uses);
          actions.appendChild(daysLabel);
          actions.appendChild(usesLabel);
          actions.appendChild(button(CHAIN_MINT_ATTR, 'wr-primary', 'Make the rule', () => {
            const d = parseBound(days.value, TTL_CEILING_DAYS);
            const u = parseBound(uses.value, CHAIN_RULE_MAX_USES);
            if (d === null || u === null) {
              actionError = { id: row.key_hash, message: `Days must be 1 to ${TTL_CEILING_DAYS}, and times 1 to ${CHAIN_RULE_MAX_USES}.` };
              render();
              return;
            }
            void act(row.key_hash, () => opts.accept({ key_hash: row.key_hash, ttl_ms: d * DAY_MS, max_uses: u }));
          }));
        }
        actions.appendChild(cancel());
      } else if (mode.kind === 'dismissing' && mode.key_hash === row.key_hash) {
        actions.appendChild(el('span', 'wr-confirm-prompt', 'Recued will not suggest this request again.'));
        actions.appendChild(button(CHAIN_CONFIRM_ATTR, 'wr-danger', 'Dismiss for good', () => {
          void act(row.key_hash, () => opts.dismiss({ key_hash: row.key_hash, part: 'all' }));
        }));
        actions.appendChild(cancel());
      } else {
        actions.appendChild(button(CHAIN_ACCEPT_ATTR, 'wr-primary', busy === row.key_hash ? 'Working…' : 'Accept',
          () => enter({ kind: 'accepting', key_hash: row.key_hash })));
        actions.appendChild(button(CHAIN_DISMISS_ATTR, 'wr-secondary', 'Dismiss',
          () => enter({ kind: 'dismissing', key_hash: row.key_hash })));
      }
      card.appendChild(actions);
    }

    if (row.deletes.length > 0) {
      const block = el('div', 'cr-delete');
      block.appendChild(el('div', 'wr-evidence', 'Also, on its own, if you want it to run without asking too:'));
      block.appendChild(callList(row.deletes));
      const answers = el('div', 'wr-actions');
      if (mode.kind === 'delete-accepting' && mode.key_hash === row.key_hash) {
        answers.appendChild(el('span', 'wr-confirm-prompt',
          'It runs without asking when you ask this, only on what the request found itself.'));
        answers.appendChild(button(CHAIN_CONFIRM_ATTR, 'wr-danger', 'Let it run', () => {
          void act(row.key_hash, () => opts.accept({ key_hash: row.key_hash, deletes: true }));
        }));
        answers.appendChild(cancel());
      } else if (mode.kind === 'delete-dismissing' && mode.key_hash === row.key_hash) {
        answers.appendChild(el('span', 'wr-confirm-prompt', 'Recued will not offer this again; it keeps asking.'));
        answers.appendChild(button(CHAIN_CONFIRM_ATTR, 'wr-danger', 'Not this, for good', () => {
          void act(row.key_hash, () => opts.dismiss({ key_hash: row.key_hash, part: 'deletes' }));
        }));
        answers.appendChild(cancel());
      } else {
        answers.appendChild(button(CHAIN_DELETE_ACCEPT_ATTR, 'wr-secondary', 'Also let this run',
          () => enter({ kind: 'delete-accepting', key_hash: row.key_hash })));
        answers.appendChild(button(CHAIN_DELETE_DISMISS_ATTR, 'wr-secondary', 'Not this',
          () => enter({ kind: 'delete-dismissing', key_hash: row.key_hash })));
      }
      block.appendChild(answers);
      card.appendChild(block);
    }
    const error = errorLine(row.key_hash);
    if (error !== null) card.appendChild(error);
    return card;
  };

  const renderRule = (rule: ChainRuleRow): HTMLElement => {
    const card = el('div', 'wr-card');
    card.setAttribute(CHAIN_RULE_ATTR, rule.rule_id);
    const info = el('div', 'wr-card-info');
    info.appendChild(el('div', 'wr-card-heading', requestHeading(rule.words)));
    info.appendChild(callList([...rule.members, ...rule.deletes]));
    info.appendChild(el('div', 'wr-evidence',
      `${rule.uses_remaining} of ${rule.max_uses} left, until ${formatDate(rule.expires_at)}`));
    card.appendChild(info);
    const actions = el('div', 'wr-actions');
    if (mode.kind === 'revoking' && mode.rule_id === rule.rule_id) {
      actions.appendChild(el('span', 'wr-confirm-prompt', 'It asks again from now on, and Recued will not suggest it again.'));
      actions.appendChild(button(CHAIN_CONFIRM_ATTR, 'wr-danger', 'End it', () => {
        void act(rule.rule_id, () => opts.revoke({ rule_id: rule.rule_id }));
      }));
      actions.appendChild(cancel());
    } else {
      actions.appendChild(button(CHAIN_REVOKE_ATTR, 'wr-secondary', busy === rule.rule_id ? 'Working…' : 'End rule',
        () => enter({ kind: 'revoking', rule_id: rule.rule_id })));
    }
    card.appendChild(actions);
    const error = errorLine(rule.rule_id);
    if (error !== null) card.appendChild(error);
    return card;
  };

  function render(): void {
    if (disposed) return;
    while (root.firstChild) root.removeChild(root.firstChild);
    if (listError !== null) {
      const line = el('div', 'wr-error', `Recued could not load the requests you repeat: ${listError}`);
      line.setAttribute(CHAIN_ERROR_ATTR, '');
      root.appendChild(line);
    }
    if (suggestions.length > 0) {
      root.appendChild(el('h2', 'wr-heading', 'Let these requests run without asking?'));
      root.appendChild(el('p', 'wr-copy',
        'You ask these in your chats again and again, and say yes to what they do each time. Accept one and '
        + 'Recued makes a rule: the next time you ask it, those things run without asking, for up to '
        + `${TTL_CEILING_DAYS} days and ${CHAIN_RULE_MAX_USES} times. Anything else it leads to still asks. `
        + 'Dismiss one and Recued will not suggest it again.'));
      for (const row of suggestions) root.appendChild(renderSuggestion(row));
    }
    if (rules.length > 0) {
      root.appendChild(el('h2', 'wr-heading', 'Requests that run without asking'));
      for (const rule of rules) root.appendChild(renderRule(rule));
    }
  }

  const refresh = (): Promise<void> => {
    const mine = (generation += 1);
    loading = (async () => {
      try {
        // A server from before chains has no methods for them: nothing is listed.
        const none = <T>(error: unknown): T | undefined => {
          const { code } = classifyRpcError(error);
          if (code === 'unknown_method' || code === 'not_configured') return undefined;
          throw error;
        };
        const [suggested, live] = await Promise.all([
          opts.listSuggestions().catch((error: unknown) => none<{ suggestions: ReadonlyArray<ChainSuggestionRow> }>(error)),
          opts.listRules().catch((error: unknown) => none<{ rules: ReadonlyArray<ChainRuleRow> }>(error)),
        ]);
        if (disposed || mine !== generation) return;
        suggestions = suggested?.suggestions ?? [];
        rules = live?.rules ?? [];
        listError = null;
      } catch (error) {
        if (disposed || mine !== generation) return;
        listError = humanizeRpcError(error);
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
    hasInFlightWork: () => busy !== null,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try { opts.host.removeChild(root); } catch { /* a detached host */ }
    },
  };
};

/** Self-scoped CSS, joined into the contracts route's one `<style>` bundle: the write rules' cards,
 *  and the request's calls listed in them. */
export const CHAIN_RULES_PANEL_STYLES = `${ruleCardStyles(CHAIN_RULES_PANEL_HOST_ATTR)}
[${CHAIN_RULES_PANEL_HOST_ATTR}] .cr-calls { margin: 2px 0; padding-left: 18px; font-size: 13px; }
[${CHAIN_RULES_PANEL_HOST_ATTR}] .cr-call { margin: 2px 0; overflow-wrap: anywhere; }
[${CHAIN_RULES_PANEL_HOST_ATTR}] .cr-delete {
  flex-basis: 100%; display: flex; flex-direction: column; gap: 4px;
  border-top: 1px solid var(--border); padding-top: 8px;
}
`;
