/** D-329 §3.4 — the `#contracts` panel for the write rules an AI's approvals teach.
 *
 *  Two lists, each shown only when it has something in it (no heading, no noise):
 *
 *  - **Suggestions.** A Tier-1 write the owner keeps approving — the same tool on the same
 *    kind of thing, asked by their own chats or by one AI app, on three occasions in 30
 *    days with no refusal. **Accept** opens the bounds (days, uses), both at most the
 *    ceilings and tighten-only; "Make the rule" mints it. **Dismiss** asks once more, since
 *    it is for good.
 *  - **Rules.** The live ones: what each lets happen, who asks, the uses left and until
 *    when. **End rule** asks once more, then revokes it; its key never suggests again.
 *
 *  The rpc family is `collection.contract.*`, which MCP never reaches: an AI never sees its
 *  own suggestion. Spec: D-329 §3.4. */

import {
  describeWriteRule,
  WRITE_RULE_MAX_USES,
  WRITE_RULE_TTL_MS,
  type WriteRuleKey,
  type WriteRuleRow,
  type WriteRuleSuggestionRow,
} from '@recued/contracts';

import { humanizeRpcError } from '../shell/rpc-error-copy.js';

export type WriteRuleSuggestionsListCaller = () => Promise<{ suggestions: ReadonlyArray<WriteRuleSuggestionRow> }>;
export type WriteRuleAcceptCaller = (args: {
  key_hash: string;
  ttl_ms?: number;
  max_uses?: number;
}) => Promise<{ rule: WriteRuleRow; suggestion: WriteRuleSuggestionRow }>;
export type WriteRuleDismissCaller = (args: { key_hash: string }) => Promise<{ key_hash: string }>;
export type WriteRulesListCaller = () => Promise<{ rules: ReadonlyArray<WriteRuleRow> }>;
export type WriteRuleRevokeCaller = (args: { rule_id: string }) => Promise<{ rule: WriteRuleRow }>;

export interface WriteRulesPanelCallers {
  readonly listSuggestions: WriteRuleSuggestionsListCaller;
  readonly accept: WriteRuleAcceptCaller;
  readonly dismiss: WriteRuleDismissCaller;
  readonly listRules: WriteRulesListCaller;
  readonly revoke: WriteRuleRevokeCaller;
  /** Names an AI app's agreement by its contract id; absent or unknown ⇒ "an AI app". */
  readonly listContracts?: () => Promise<{ contracts: ReadonlyArray<{ contract_id: string; display_name: string }> }>;
}

export interface MountWriteRulesPanelOptions extends WriteRulesPanelCallers {
  readonly host: HTMLElement;
  readonly document?: Document;
}

export interface WriteRulesPanelMount {
  refresh(): Promise<void>;
  whenLoaded(): Promise<void>;
  hasInFlightWork(): boolean;
  dispose(): void;
}

export const WRITE_RULES_PANEL_HOST_ATTR = 'data-recued-write-rules-panel';
export const WRITE_RULES_SUGGESTION_ATTR = 'data-recued-write-rule-suggestion';
export const WRITE_RULES_RULE_ATTR = 'data-recued-write-rule';
export const WRITE_RULES_ACCEPT_ATTR = 'data-recued-write-rule-accept';
export const WRITE_RULES_DAYS_ATTR = 'data-recued-write-rule-days';
export const WRITE_RULES_USES_ATTR = 'data-recued-write-rule-uses';
export const WRITE_RULES_MINT_ATTR = 'data-recued-write-rule-mint';
export const WRITE_RULES_DISMISS_ATTR = 'data-recued-write-rule-dismiss';
export const WRITE_RULES_REVOKE_ATTR = 'data-recued-write-rule-revoke';
export const WRITE_RULES_CONFIRM_ATTR = 'data-recued-write-rule-confirm';
export const WRITE_RULES_CANCEL_ATTR = 'data-recued-write-rule-cancel';
export const WRITE_RULES_ERROR_ATTR = 'data-recued-write-rule-error';

const DAY_MS = 86_400_000;
const TTL_CEILING_DAYS = Math.floor(WRITE_RULE_TTL_MS / DAY_MS);

type Mode =
  | { readonly kind: 'idle' }
  | { readonly kind: 'accepting'; readonly key_hash: string }
  | { readonly kind: 'dismissing'; readonly key_hash: string }
  | { readonly kind: 'revoking'; readonly rule_id: string };

const formatDate = (ms: number): string => (Number.isFinite(ms) ? new Date(ms).toLocaleDateString() : '—');

/** What a rule lets happen, in a line: "Add a calendar event, on your Recued calendar". */
export const writeRuleTitle = (key: WriteRuleKey): string => {
  const { action, on } = describeWriteRule(key);
  return on === undefined ? action : `${action}, for ${on}`;
};

const whoAsks = (key: WriteRuleKey, names: ReadonlyMap<string, string>): string =>
  key.principal.kind === 'owner_chat'
    ? 'Asked by your chats'
    : `Asked by ${names.get(key.principal.contract_id) ?? 'an AI app'}`;

/** A whole number within [1, ceiling], or null: never clamped past what the owner typed. */
const parseBound = (raw: string, ceiling: number): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= ceiling ? n : null;
};

export const mountWriteRulesPanel = (opts: MountWriteRulesPanelOptions): WriteRulesPanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) throw new Error('mountWriteRulesPanel: no document available');
  const root = doc.createElement('div');
  root.setAttribute(WRITE_RULES_PANEL_HOST_ATTR, '');
  opts.host.appendChild(root);

  let suggestions: ReadonlyArray<WriteRuleSuggestionRow> = [];
  let rules: ReadonlyArray<WriteRuleRow> = [];
  let names: ReadonlyMap<string, string> = new Map();
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
  const errorLine = (id: string): HTMLElement | null => {
    if (actionError === null || actionError.id !== id) return null;
    const line = el('div', 'wr-error', actionError.message);
    line.setAttribute(WRITE_RULES_ERROR_ATTR, '');
    return line;
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

  const renderSuggestion = (row: WriteRuleSuggestionRow): HTMLElement => {
    const card = el('div', 'wr-card');
    card.setAttribute(WRITE_RULES_SUGGESTION_ATTR, row.key_hash);
    const info = el('div', 'wr-card-info');
    info.appendChild(el('div', 'wr-card-heading', writeRuleTitle(row.key)));
    info.appendChild(el('div', 'wr-evidence', whoAsks(row.key, names)));
    const ev = row.evidence;
    info.appendChild(el('div', 'wr-evidence',
      `You said yes ${ev.approvals} time${ev.approvals === 1 ? '' : 's'}, on ${ev.occasions} different occasions`
      + (ev.first_at !== undefined && ev.last_at !== undefined
        ? `, ${formatDate(ev.first_at)} – ${formatDate(ev.last_at)}`
        : '')));
    card.appendChild(info);
    const actions = el('div', 'wr-actions');
    if (mode.kind === 'accepting' && mode.key_hash === row.key_hash) {
      const days = el('input', 'wr-input') as HTMLInputElement;
      days.type = 'number';
      days.setAttribute(WRITE_RULES_DAYS_ATTR, '');
      days.setAttribute('min', '1');
      days.setAttribute('max', String(TTL_CEILING_DAYS));
      days.setAttribute('aria-label', 'Days the rule lasts');
      days.value = String(TTL_CEILING_DAYS);
      const uses = el('input', 'wr-input') as HTMLInputElement;
      uses.type = 'number';
      uses.setAttribute(WRITE_RULES_USES_ATTR, '');
      uses.setAttribute('min', '1');
      uses.setAttribute('max', String(WRITE_RULE_MAX_USES));
      uses.setAttribute('aria-label', 'Times it may run');
      uses.value = String(WRITE_RULE_MAX_USES);
      const daysLabel = el('label', 'wr-label', `Days (at most ${TTL_CEILING_DAYS})`);
      daysLabel.appendChild(days);
      const usesLabel = el('label', 'wr-label', `Times (at most ${WRITE_RULE_MAX_USES})`);
      usesLabel.appendChild(uses);
      actions.appendChild(daysLabel);
      actions.appendChild(usesLabel);
      actions.appendChild(button(WRITE_RULES_MINT_ATTR, 'wr-primary', 'Make the rule', () => {
        const d = parseBound(days.value, TTL_CEILING_DAYS);
        const u = parseBound(uses.value, WRITE_RULE_MAX_USES);
        if (d === null || u === null) {
          actionError = { id: row.key_hash, message: `Days must be 1 to ${TTL_CEILING_DAYS}, and times 1 to ${WRITE_RULE_MAX_USES}.` };
          render();
          return;
        }
        void act(row.key_hash, () => opts.accept({ key_hash: row.key_hash, ttl_ms: d * DAY_MS, max_uses: u }));
      }));
      actions.appendChild(button(WRITE_RULES_CANCEL_ATTR, 'wr-secondary', 'Cancel', () => { mode = { kind: 'idle' }; render(); }));
    } else if (mode.kind === 'dismissing' && mode.key_hash === row.key_hash) {
      actions.appendChild(el('span', 'wr-confirm-prompt', 'Recued will not suggest this again.'));
      actions.appendChild(button(WRITE_RULES_CONFIRM_ATTR, 'wr-danger', 'Dismiss for good', () => {
        void act(row.key_hash, () => opts.dismiss({ key_hash: row.key_hash }));
      }));
      actions.appendChild(button(WRITE_RULES_CANCEL_ATTR, 'wr-secondary', 'Cancel', () => { mode = { kind: 'idle' }; render(); }));
    } else {
      actions.appendChild(button(WRITE_RULES_ACCEPT_ATTR, 'wr-primary', busy === row.key_hash ? 'Working…' : 'Accept', () => {
        mode = { kind: 'accepting', key_hash: row.key_hash };
        actionError = null;
        render();
      }));
      actions.appendChild(button(WRITE_RULES_DISMISS_ATTR, 'wr-secondary', 'Dismiss', () => {
        mode = { kind: 'dismissing', key_hash: row.key_hash };
        actionError = null;
        render();
      }));
    }
    card.appendChild(actions);
    const error = errorLine(row.key_hash);
    if (error !== null) card.appendChild(error);
    return card;
  };

  const renderRule = (rule: WriteRuleRow): HTMLElement => {
    const card = el('div', 'wr-card');
    card.setAttribute(WRITE_RULES_RULE_ATTR, rule.rule_id);
    const info = el('div', 'wr-card-info');
    info.appendChild(el('div', 'wr-card-heading', writeRuleTitle(rule.key)));
    info.appendChild(el('div', 'wr-evidence', whoAsks(rule.key, names)));
    info.appendChild(el('div', 'wr-evidence',
      `${rule.uses_remaining} of ${rule.max_uses} left, until ${formatDate(rule.expires_at)}`));
    card.appendChild(info);
    const actions = el('div', 'wr-actions');
    if (mode.kind === 'revoking' && mode.rule_id === rule.rule_id) {
      actions.appendChild(el('span', 'wr-confirm-prompt', 'It asks again from now on, and Recued will not suggest it again.'));
      actions.appendChild(button(WRITE_RULES_CONFIRM_ATTR, 'wr-danger', 'End it', () => {
        void act(rule.rule_id, () => opts.revoke({ rule_id: rule.rule_id }));
      }));
      actions.appendChild(button(WRITE_RULES_CANCEL_ATTR, 'wr-secondary', 'Cancel', () => { mode = { kind: 'idle' }; render(); }));
    } else {
      actions.appendChild(button(WRITE_RULES_REVOKE_ATTR, 'wr-secondary', busy === rule.rule_id ? 'Working…' : 'End rule', () => {
        mode = { kind: 'revoking', rule_id: rule.rule_id };
        actionError = null;
        render();
      }));
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
      const line = el('div', 'wr-error', `Recued could not load the write rules: ${listError}`);
      line.setAttribute(WRITE_RULES_ERROR_ATTR, '');
      root.appendChild(line);
    }
    if (suggestions.length > 0) {
      root.appendChild(el('h2', 'wr-heading', 'Let these happen without asking?'));
      root.appendChild(el('p', 'wr-copy',
        'You keep saying yes to these when an AI asks. Accept one and Recued makes a rule: it runs without asking, '
        + `for up to ${TTL_CEILING_DAYS} days and ${WRITE_RULE_MAX_USES} times, and you can end it here at any time. `
        + 'Dismiss one and Recued will not suggest it again.'));
      for (const row of suggestions) root.appendChild(renderSuggestion(row));
    }
    if (rules.length > 0) {
      root.appendChild(el('h2', 'wr-heading', 'Happening without asking'));
      for (const rule of rules) root.appendChild(renderRule(rule));
    }
  }

  const loadNames = async (): Promise<ReadonlyMap<string, string>> => {
    if (opts.listContracts === undefined) return new Map();
    try {
      const { contracts } = await opts.listContracts();
      return new Map(contracts.map((c) => [c.contract_id, c.display_name]));
    } catch {
      return new Map();
    }
  };

  const refresh = (): Promise<void> => {
    const mine = (generation += 1);
    loading = (async () => {
      try {
        const [listed, live, named] = await Promise.all([opts.listSuggestions(), opts.listRules(), loadNames()]);
        if (disposed || mine !== generation) return;
        suggestions = listed.suggestions;
        rules = live.rules;
        names = named;
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

/** Self-scoped CSS, joined into the contracts route's one `<style>` bundle. */
export const WRITE_RULES_PANEL_STYLES = `
[${WRITE_RULES_PANEL_HOST_ATTR}] .wr-heading { margin: 0; font-size: 15px; font-weight: 650; }
[${WRITE_RULES_PANEL_HOST_ATTR}] .wr-copy { margin: 6px 0 0; font-size: 13px; color: var(--muted); line-height: 1.45; }
[${WRITE_RULES_PANEL_HOST_ATTR}] .wr-error { font-size: 13px; color: var(--fail); padding: 6px 2px; flex-basis: 100%; }
[${WRITE_RULES_PANEL_HOST_ATTR}] .wr-card {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin: 8px 0;
}
[${WRITE_RULES_PANEL_HOST_ATTR}] .wr-card-info { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
[${WRITE_RULES_PANEL_HOST_ATTR}] .wr-card-heading { font-size: 14px; font-weight: 600; }
[${WRITE_RULES_PANEL_HOST_ATTR}] .wr-evidence { font-size: 12px; color: var(--muted); }
[${WRITE_RULES_PANEL_HOST_ATTR}] .wr-actions { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap; }
[${WRITE_RULES_PANEL_HOST_ATTR}] .wr-label { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--muted); }
[${WRITE_RULES_PANEL_HOST_ATTR}] .wr-input {
  width: 90px; font-size: 13px; padding: 3px 6px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--surface); color: var(--fg);
}
[${WRITE_RULES_PANEL_HOST_ATTR}] .wr-confirm-prompt { font-size: 12px; color: var(--fail); }
[${WRITE_RULES_PANEL_HOST_ATTR}] .wr-primary,
[${WRITE_RULES_PANEL_HOST_ATTR}] .wr-secondary,
[${WRITE_RULES_PANEL_HOST_ATTR}] .wr-danger {
  font-size: 13px; padding: 4px 12px; border-radius: 6px; background: var(--surface); cursor: pointer; white-space: nowrap;
  min-height: 32px;
}
[${WRITE_RULES_PANEL_HOST_ATTR}] .wr-primary { border: 1px solid var(--accent); color: var(--accent); }
[${WRITE_RULES_PANEL_HOST_ATTR}] .wr-secondary { border: 1px solid var(--border); color: var(--fg); }
[${WRITE_RULES_PANEL_HOST_ATTR}] .wr-danger { border: 1px solid var(--fail); color: var(--fail); }
[${WRITE_RULES_PANEL_HOST_ATTR}] button[disabled] { opacity: 0.6; cursor: default; }
`;
