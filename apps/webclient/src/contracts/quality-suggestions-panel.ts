/** D-202 — the `#contracts` "Auto-accept rules" panel: the owner surface for
 *  quality-delegation suggest→accept + the active-grant governance (list/revoke).
 *  Sits below the Switch A/B kill-switch (`quality-switch-panel.ts`).
 *
 *  Two sections, both owner-only (the rpc family is reserved out of MCP):
 *   - **Suggestions** — open quality-delegation OFFERS (the Slice 1 learner
 *     surfaces a `(recipe, op)` that earned auto-accept). Each card shows the op
 *     + evidence ("4 approvals across 2 sessions") and two resolutions:
 *     **Accept** (one click → mints a STANDING quality delegation) and
 *     **Dismiss** (two-stage confirm — per-key permanent).
 *   - **Active** — the minted quality delegations, each with a two-stage
 *     **Revoke** (a tightening — matching sends return to per-artifact review).
 *
 *  With nothing to show (no open suggestions AND no active grants) the panel
 *  renders nothing — the section exists exactly when there is something to
 *  decide or govern. Self-contained styles + disposable, mirroring
 *  `suggested-rules-panel.ts`.
 *
 *  Spec: D-202 §5 / §12.4. */

import type {
  ContractDefinitionView,
  QualityDelegationSuggestionRow,
} from '@recued/contracts';

import { humanizeRpcError } from '../shell/rpc-error-copy.js';

// ════════════════════════════════════════════════════════════════
// Caller seams + handle
// ════════════════════════════════════════════════════════════════

/** `collection.contract.listQualityDelegationSuggestions` caller. */
export type QualitySuggestionsListCaller = () => Promise<{
  suggestions: ReadonlyArray<QualityDelegationSuggestionRow>;
}>;
/** `collection.contract.acceptQualityDelegationSuggestion` caller. */
export type QualitySuggestionAcceptCaller = (args: {
  key_hash: string;
  ttl_ms?: number;
}) => Promise<{ grant: ContractDefinitionView; suggestion: QualityDelegationSuggestionRow }>;
/** `collection.contract.dismissQualityDelegationSuggestion` caller. */
export type QualitySuggestionDismissCaller = (args: {
  key_hash: string;
}) => Promise<{ suggestion: QualityDelegationSuggestionRow }>;
/** `collection.contract.listQualityDelegations` caller. */
export type QualityDelegationsListCaller = () => Promise<{
  contracts: ReadonlyArray<ContractDefinitionView>;
}>;
/** `collection.contract.revokeQualityDelegation` caller. */
export type QualityDelegationRevokeCaller = (args: {
  contract_id: string;
}) => Promise<ContractDefinitionView>;

export type QualitySuggestionsPanelState = 'loading' | 'ready' | 'error';

export interface MountQualitySuggestionsPanelOptions {
  host: HTMLElement;
  document?: Document;
  runListSuggestions: QualitySuggestionsListCaller;
  runAcceptSuggestion: QualitySuggestionAcceptCaller;
  runDismissSuggestion: QualitySuggestionDismissCaller;
  runListGrants: QualityDelegationsListCaller;
  runRevokeGrant: QualityDelegationRevokeCaller;
}

export interface QualitySuggestionsPanelMount {
  getState(): QualitySuggestionsPanelState;
  getOpenSuggestions(): ReadonlyArray<QualityDelegationSuggestionRow>;
  getActiveGrants(): ReadonlyArray<ContractDefinitionView>;
  refresh(): Promise<void>;
  whenLoaded(): Promise<void>;
  /** Test seams — resolve one item programmatically (no-op while in flight). */
  acceptSuggestion(keyHash: string): Promise<void>;
  dismissSuggestion(keyHash: string): Promise<void>;
  revokeGrant(contractId: string): Promise<void>;
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// Attribute constants — stable hooks for tests + the route shell
// ════════════════════════════════════════════════════════════════

export const QUALITY_RULES_PANEL_HOST_ATTR = 'data-recued-quality-rules-panel';
export const QUALITY_RULES_HEADING_ATTR = 'data-recued-quality-rules-heading';
export const QUALITY_RULES_ERROR_ATTR = 'data-recued-quality-rules-error';
/** One suggestion card. Carries `data-key-hash`. */
export const QUALITY_RULES_SUGGESTION_ATTR = 'data-recued-quality-rules-suggestion';
export const QUALITY_RULES_ACCEPT_ATTR = 'data-recued-quality-rules-accept';
export const QUALITY_RULES_DISMISS_ATTR = 'data-recued-quality-rules-dismiss';
export const QUALITY_RULES_DISMISS_CONFIRM_ATTR = 'data-recued-quality-rules-dismiss-confirm';
/** One active-grant row. Carries `data-contract-id`. */
export const QUALITY_RULES_GRANT_ATTR = 'data-recued-quality-rules-grant';
export const QUALITY_RULES_REVOKE_ATTR = 'data-recued-quality-rules-revoke';
export const QUALITY_RULES_REVOKE_CONFIRM_ATTR = 'data-recued-quality-rules-revoke-confirm';

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

export const mountQualitySuggestionsPanel = (
  opts: MountQualitySuggestionsPanelOptions,
): QualitySuggestionsPanelMount => {
  const doc = opts.document ?? globalThis.document;

  const wrapper = doc.createElement('section');
  wrapper.setAttribute(QUALITY_RULES_PANEL_HOST_ATTR, '');
  opts.host.appendChild(wrapper);

  let suggestions: ReadonlyArray<QualityDelegationSuggestionRow> = [];
  let grants: ReadonlyArray<ContractDefinitionView> = [];
  let panelState: QualitySuggestionsPanelState = 'loading';
  let errorMessage: string | null = null;
  let disposed = false;
  let loadGeneration = 0;
  // key_hash / contract_id currently armed for a two-stage confirm.
  let armedDismiss: string | null = null;
  let armedRevoke: string | null = null;
  const inFlight = new Set<string>();

  let settledOnce = false;
  let resolveLoaded: () => void = () => {};
  const loaded = new Promise<void>((resolve) => {
    resolveLoaded = resolve;
  });

  const el = (tag: string, className?: string, text?: string): HTMLElement => {
    const node = doc.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const openSuggestions = (): ReadonlyArray<QualityDelegationSuggestionRow> =>
    suggestions.filter((s) => s.state === 'open');
  const liveGrants = (): ReadonlyArray<ContractDefinitionView> =>
    grants.filter((g) => g.lifecycle_state === 'active');

  const opLabel = (s: QualityDelegationSuggestionRow): string =>
    s.snapshot.display_name ?? s.snapshot.operation_id ?? s.snapshot.ingredient_id;

  const evidenceLine = (s: QualityDelegationSuggestionRow): string => {
    const { approve_count, distinct_session_count } = s.evidence;
    const a = `${approve_count} approval${approve_count === 1 ? '' : 's'}`;
    const d = `${distinct_session_count} session${distinct_session_count === 1 ? '' : 's'}`;
    return `${a} across ${d}`;
  };

  const button = (
    className: string,
    label: string,
    attr: string,
    onClick: () => void,
    disabled = false,
  ): HTMLButtonElement => {
    const b = el('button', className, label) as HTMLButtonElement;
    b.type = 'button';
    b.setAttribute(attr, '');
    b.disabled = disabled;
    b.addEventListener('click', onClick);
    return b;
  };

  const render = (): void => {
    while (wrapper.firstChild !== null) wrapper.removeChild(wrapper.firstChild);

    const open = openSuggestions();
    const live = liveGrants();

    if (panelState === 'loading' && suggestions.length === 0 && grants.length === 0) {
      // Silent while the first load is in flight — no flash of an empty box.
      return;
    }
    if (panelState !== 'error' && open.length === 0 && live.length === 0) {
      return; // nothing to decide or govern → render nothing.
    }

    const heading = el('h3', 'qr-heading', 'Auto-accept rules');
    heading.setAttribute(QUALITY_RULES_HEADING_ATTR, '');
    wrapper.appendChild(heading);

    if (errorMessage !== null) {
      const err = el('p', 'qr-error', errorMessage);
      err.setAttribute(QUALITY_RULES_ERROR_ATTR, '');
      wrapper.appendChild(err);
    }

    // ── Open suggestions ──
    for (const s of open) {
      const card = el('div', 'qr-card');
      card.setAttribute(QUALITY_RULES_SUGGESTION_ATTR, '');
      card.setAttribute('data-key-hash', s.key_hash);

      const info = el('div', 'qr-card-info');
      info.appendChild(el('span', 'qr-card-title', opLabel(s)));
      info.appendChild(el('span', 'qr-card-sub', `Offer to auto-accept quality · ${evidenceLine(s)}`));
      card.appendChild(info);

      const busy = inFlight.has(s.key_hash);
      const actions = el('div', 'qr-actions');
      if (armedDismiss === s.key_hash) {
        actions.appendChild(el('span', 'qr-confirm-prompt', 'Dismiss permanently?'));
        actions.appendChild(
          button('qr-btn qr-btn-danger', 'Confirm', QUALITY_RULES_DISMISS_CONFIRM_ATTR, () => {
            void resolveSuggestion(s.key_hash, 'dismiss');
          }, busy),
        );
        actions.appendChild(
          button('qr-btn', 'Cancel', 'data-recued-quality-rules-dismiss-cancel', () => {
            armedDismiss = null;
            render();
          }),
        );
      } else {
        actions.appendChild(
          button('qr-btn qr-btn-primary', busy ? '…' : 'Accept', QUALITY_RULES_ACCEPT_ATTR, () => {
            void resolveSuggestion(s.key_hash, 'accept');
          }, busy),
        );
        actions.appendChild(
          button('qr-btn', 'Dismiss', QUALITY_RULES_DISMISS_ATTR, () => {
            armedDismiss = s.key_hash;
            armedRevoke = null;
            render();
          }, busy),
        );
      }
      card.appendChild(actions);
      wrapper.appendChild(card);
    }

    // ── Active grants ──
    if (live.length > 0) {
      wrapper.appendChild(el('p', 'qr-subhead', 'Active'));
    }
    for (const g of live) {
      const row = el('div', 'qr-grant');
      row.setAttribute(QUALITY_RULES_GRANT_ATTR, '');
      row.setAttribute('data-contract-id', g.contract_id);

      const info = el('div', 'qr-card-info');
      info.appendChild(el('span', 'qr-card-title', g.display_name));
      info.appendChild(
        el('span', 'qr-card-sub', g.expiry_at !== undefined ? 'Auto-accepting · expires' : 'Auto-accepting · standing'),
      );
      row.appendChild(info);

      const busy = inFlight.has(g.contract_id);
      const actions = el('div', 'qr-actions');
      if (armedRevoke === g.contract_id) {
        actions.appendChild(el('span', 'qr-confirm-prompt', 'Revoke?'));
        actions.appendChild(
          button('qr-btn qr-btn-danger', 'Confirm', QUALITY_RULES_REVOKE_CONFIRM_ATTR, () => {
            void revoke(g.contract_id);
          }, busy),
        );
        actions.appendChild(
          button('qr-btn', 'Cancel', 'data-recued-quality-rules-revoke-cancel', () => {
            armedRevoke = null;
            render();
          }),
        );
      } else {
        actions.appendChild(
          button('qr-btn', busy ? '…' : 'Revoke', QUALITY_RULES_REVOKE_ATTR, () => {
            armedRevoke = g.contract_id;
            armedDismiss = null;
            render();
          }, busy),
        );
      }
      row.appendChild(actions);
      wrapper.appendChild(row);
    }
  };

  const load = async (): Promise<void> => {
    const gen = ++loadGeneration;
    if (suggestions.length === 0 && grants.length === 0) {
      panelState = 'loading';
      render();
    }
    try {
      const [s, g] = await Promise.all([opts.runListSuggestions(), opts.runListGrants()]);
      if (disposed || gen !== loadGeneration) return;
      suggestions = s.suggestions;
      grants = g.contracts;
      panelState = 'ready';
      errorMessage = null;
    } catch (err) {
      if (disposed || gen !== loadGeneration) return;
      panelState = 'error';
      errorMessage = humanizeRpcError(err);
    }
    render();
    if (!settledOnce) {
      settledOnce = true;
      resolveLoaded();
    }
  };

  const resolveSuggestion = async (
    keyHash: string,
    action: 'accept' | 'dismiss',
  ): Promise<void> => {
    if (disposed || inFlight.has(keyHash)) return;
    inFlight.add(keyHash);
    armedDismiss = null;
    render();
    try {
      if (action === 'accept') await opts.runAcceptSuggestion({ key_hash: keyHash });
      else await opts.runDismissSuggestion({ key_hash: keyHash });
      if (disposed) return;
      errorMessage = null;
    } catch (err) {
      if (disposed) return;
      errorMessage = humanizeRpcError(err);
    } finally {
      inFlight.delete(keyHash);
    }
    // Re-list so the accepted offer becomes an active grant / the dismissed one drops.
    if (!disposed) await load();
  };

  const revoke = async (contractId: string): Promise<void> => {
    if (disposed || inFlight.has(contractId)) return;
    inFlight.add(contractId);
    armedRevoke = null;
    render();
    try {
      await opts.runRevokeGrant({ contract_id: contractId });
      if (disposed) return;
      errorMessage = null;
    } catch (err) {
      if (disposed) return;
      errorMessage = humanizeRpcError(err);
    } finally {
      inFlight.delete(contractId);
    }
    if (!disposed) await load();
  };

  render();
  void load();

  return {
    getState: () => panelState,
    getOpenSuggestions: () => openSuggestions(),
    getActiveGrants: () => liveGrants(),
    refresh: () => load(),
    whenLoaded: () => loaded,
    acceptSuggestion: (keyHash) => resolveSuggestion(keyHash, 'accept'),
    dismissSuggestion: (keyHash) => resolveSuggestion(keyHash, 'dismiss'),
    revokeGrant: (contractId) => revoke(contractId),
    dispose: () => {
      disposed = true;
      if (wrapper.parentNode !== null) wrapper.parentNode.removeChild(wrapper);
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Styles — joined into the contracts route's one `<style>` bundle
// ════════════════════════════════════════════════════════════════

export const QUALITY_SUGGESTIONS_PANEL_STYLES = `
[${QUALITY_RULES_PANEL_HOST_ATTR}] {
  display: block;
}
[${QUALITY_RULES_PANEL_HOST_ATTR}]:empty { display: none; }
[${QUALITY_RULES_PANEL_HOST_ATTR}] .qr-heading {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 650;
}
[${QUALITY_RULES_PANEL_HOST_ATTR}] .qr-subhead {
  margin: 14px 0 6px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
}
[${QUALITY_RULES_PANEL_HOST_ATTR}] .qr-error {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--fail);
}
[${QUALITY_RULES_PANEL_HOST_ATTR}] .qr-card,
[${QUALITY_RULES_PANEL_HOST_ATTR}] .qr-grant {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin: 8px 0;
  flex-wrap: wrap;
}
[${QUALITY_RULES_PANEL_HOST_ATTR}] .qr-card {
  border-color: var(--accent);
}
[${QUALITY_RULES_PANEL_HOST_ATTR}] .qr-card-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
[${QUALITY_RULES_PANEL_HOST_ATTR}] .qr-card-title {
  font-size: 14px;
  font-weight: 600;
}
[${QUALITY_RULES_PANEL_HOST_ATTR}] .qr-card-sub {
  font-size: 12px;
  color: var(--muted);
}
[${QUALITY_RULES_PANEL_HOST_ATTR}] .qr-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
[${QUALITY_RULES_PANEL_HOST_ATTR}] .qr-confirm-prompt {
  font-size: 12px;
  color: var(--fail);
}
[${QUALITY_RULES_PANEL_HOST_ATTR}] .qr-btn {
  font-size: 13px;
  font-weight: 600;
  padding: 4px 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--fg);
  cursor: pointer;
}
[${QUALITY_RULES_PANEL_HOST_ATTR}] .qr-btn:disabled { opacity: 0.55; cursor: default; }
[${QUALITY_RULES_PANEL_HOST_ATTR}] .qr-btn-primary {
  border-color: var(--accent);
  color: var(--accent);
}
[${QUALITY_RULES_PANEL_HOST_ATTR}] .qr-btn-danger {
  border-color: var(--danger);
  color: var(--danger);
}
`;
