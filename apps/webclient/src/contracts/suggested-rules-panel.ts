/** D-177 N.13 (P6c) — the `#contracts` "Suggested rules" panel: the owner
 *  surface for staged-trust delegation-rule suggestions (ladder step 6 — the
 *  background learner SUGGESTS a bounded rule after repeated cross-session
 *  approvals; only the human mints it, N.9.7).
 *
 *  Renders the OPEN suggestions as cards (resolved rows never render — an
 *  accepted key's rule lives in the contract inventory; a dismissed key is
 *  per-key permanent). Each card shows the would-be rule's bound axes + the
 *  evidence line ("3 approvals across 3 sessions…"), and two resolutions:
 *
 *  - **Accept** — two-stage: the first click expands the bounds editor (TTL
 *    days + use budget, both TIGHTEN-ONLY against the code-constant ceilings
 *    `DELEGATION_RULE_TTL_MS` / `DELEGATION_RULE_MAX_USES` — fork 3; values
 *    above the ceiling are clamped by the input's max and re-checked before
 *    the call); "Mint rule" commits via
 *    `collection.contract.acceptDelegationSuggestion`, which mints FROM THE
 *    STORED SNAPSHOT server-side and returns the minted rule + the flipped
 *    suggestion.
 *  - **Dismiss** — two-stage inline confirm (mirroring the contracts panel's
 *    revoke discipline) because dismissal is per-key PERMANENT.
 *
 *  The panel owns its whole section INCLUDING the heading: with zero open
 *  suggestions it renders nothing visible (the `#contracts` page carries no
 *  "No suggested rules" noise — the section exists exactly when there is
 *  something to decide). Hosts read `getOpenSuggestions()` for badges.
 *
 *  Live coherence: re-lists on `contract.delegation_rule_suggested` (the
 *  learner surfaced a new suggestion) and on
 *  `contract.delegation_rule_suggestion_resolved` (the owner resolved one —
 *  here or on another paired client; a dismissal on the laptop must not keep
 *  offering standing authority on the phone). Same `loadGeneration` stale-
 *  write guard as the sibling panels.
 *
 *  Suggestions are NEVER serialized into model-visible context (N.9.1): the
 *  rpc family is reserved out of MCP; this panel is the only consumer.
 *
 *  Spec: D-177 § N.13; landing order P6c. */

import {
  DELEGATION_RULE_MAX_USES,
  DELEGATION_RULE_TTL_MS,
  type ContractDefinitionView,
  type DelegationRuleSuggestionRow,
} from '@recued/contracts';

import type { BroadcastSubscriber } from '../realtime/subscriber.js';
// `contract-grants-panel` OWNS the grant-rpc caller type family (its own module
// doc says so) — import the type rather than fork a structurally-identical copy
// here. Type-only: erased at compile, so no runtime coupling between panels.
import type { GrantContractsCaller } from './contract-grants-panel.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

// ════════════════════════════════════════════════════════════════
// Caller seams + handle
// ════════════════════════════════════════════════════════════════

/** `collection.contract.listDelegationSuggestions` caller seam. */
export type SuggestionsListCaller = () => Promise<{
  suggestions: ReadonlyArray<DelegationRuleSuggestionRow>;
}>;

/** `collection.contract.acceptDelegationSuggestion` caller seam. */
export type SuggestionsAcceptCaller = (args: {
  key_hash: string;
  ttl_ms?: number;
  max_uses?: number;
}) => Promise<{ rule: ContractDefinitionView; suggestion: DelegationRuleSuggestionRow }>;

/** `collection.contract.dismissDelegationSuggestion` caller seam. */
export type SuggestionsDismissCaller = (args: {
  key_hash: string;
}) => Promise<{ suggestion: DelegationRuleSuggestionRow }>;

export type SuggestedRulesPanelState = 'loading' | 'ready' | 'error';

export interface MountSuggestedRulesPanelOptions {
  /** Host element the panel renders into. The panel appends a single wrapper
   *  div + rebuilds its inner contents across state changes. */
  host: HTMLElement;
  /** DOM document seam. Defaults to `globalThis.document`. */
  document?: Document;
  runListSuggestions: SuggestionsListCaller;
  runAcceptSuggestion: SuggestionsAcceptCaller;
  runDismissSuggestion: SuggestionsDismissCaller;
  /** `collection.contract.listContracts` — resolves a door row's
   *  `bound_contract_id` to the `display_name` the contract inventory shows, so
   *  the door facet names something the owner can actually find. Optional:
   *  absent ⇒ the facet falls back to the raw id (the pre-resolution rendering).
   *  Cosmetic only — a failure here never fails the suggestions load. */
  runListContracts?: GrantContractsCaller;
  /** D-121 broadcast subscribe seam (`subscriber.on`). Optional — a no-bus
   *  harness stays current via post-resolution re-lists + `refresh()`. */
  subscribe?: BroadcastSubscriber['on'];
}

export interface SuggestedRulesPanelMount {
  getState(): SuggestedRulesPanelState;
  /** The OPEN suggestions in display order (server order: most-recently-
   *  updated first). Resolved rows are filtered out at load. */
  getOpenSuggestions(): ReadonlyArray<DelegationRuleSuggestionRow>;
  /** Top-level list-error message. Null when the last list succeeded. */
  getListError(): string | null;
  /** Host-driven refresh — re-lists suggestions. Returns the load promise. */
  refresh(): Promise<void>;
  /** Initial load promise — resolves after the most recent list settles. */
  whenLoaded(): Promise<void>;
  /** Accept one suggestion programmatically (the equivalent of expanding the
   *  editor and committing with the given bounds). No-op for an unknown key
   *  or a card with a resolution already in flight. Test seam. */
  acceptSuggestion(keyHash: string, bounds?: { ttl_ms?: number; max_uses?: number }): Promise<void>;
  /** Dismiss one suggestion programmatically (the equivalent of the armed
   *  Confirm). Same no-op guards. Test seam. */
  dismissSuggestion(keyHash: string): Promise<void>;
  /** Tear down the panel DOM. Idempotent. */
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// Attribute constants — stable hooks for tests + the route shell
// ════════════════════════════════════════════════════════════════

/** Wrapper the panel owns inside the caller's host. */
export const SUGGESTED_RULES_PANEL_HOST_ATTR = 'data-recued-suggested-rules-panel';
/** The section heading (rendered only when open suggestions exist). */
export const SUGGESTED_RULES_HEADING_ATTR = 'data-recued-suggested-rules-heading';
/** The top-level list-error chip. */
export const SUGGESTED_RULES_ERROR_ATTR = 'data-recued-suggested-rules-error';
/** One suggestion card. Carries `data-key-hash`. */
export const SUGGESTED_RULES_CARD_ATTR = 'data-recued-suggested-rules-card';
/** The Accept button (first stage — expands the bounds editor). */
export const SUGGESTED_RULES_ACCEPT_ATTR = 'data-recued-suggested-rules-accept';
/** The expanded editor's TTL (days) input. */
/** D-177 N.14.3 — the door riding-disclosure line (open-mode door rules). */
export const SUGGESTED_RULES_DOOR_DISCLOSURE_ATTR =
  'data-recued-suggested-rules-door-disclosure';
export const SUGGESTED_RULES_TTL_INPUT_ATTR = 'data-recued-suggested-rules-ttl';
/** The expanded editor's use-budget input. */
export const SUGGESTED_RULES_USES_INPUT_ATTR = 'data-recued-suggested-rules-uses';
/** The expanded editor's commit button ("Mint rule"). */
export const SUGGESTED_RULES_MINT_ATTR = 'data-recued-suggested-rules-mint';
/** The Dismiss button (first stage — arms the confirm). */
export const SUGGESTED_RULES_DISMISS_ATTR = 'data-recued-suggested-rules-dismiss';
/** The armed "Confirm" button (second stage — commits the dismiss). */
export const SUGGESTED_RULES_DISMISS_CONFIRM_ATTR =
  'data-recued-suggested-rules-dismiss-confirm';
/** Any "Cancel" button (collapses the editor / disarms the confirm). */
export const SUGGESTED_RULES_CANCEL_ATTR = 'data-recued-suggested-rules-cancel';
/** A per-card error chip (an accept/dismiss failure scoped to one card). */
export const SUGGESTED_RULES_CARD_ERROR_ATTR = 'data-recued-suggested-rules-card-error';

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════

const DAY_MS = 24 * 60 * 60 * 1000;
/** The TTL ceiling in whole days — the editor's unit (fork 3: 30). */
const TTL_CEILING_DAYS = Math.floor(DELEGATION_RULE_TTL_MS / DAY_MS);

/** Which resolution affordance a card currently shows. */
type CardMode = 'idle' | 'accepting' | 'dismiss-armed';

interface InternalState {
  phase: SuggestedRulesPanelState;
  suggestions: ReadonlyArray<DelegationRuleSuggestionRow>;
  listError: string | null;
  /** Per-card resolution-error messages, keyed by `key_hash`. Reset on each
   *  successful list. */
  cardErrors: ReadonlyMap<string, string>;
  /** The single card with a non-idle affordance (arming one disarms any
   *  other — one decision at a time, mirroring the contracts panel). */
  activeKeyHash: string | null;
  activeMode: CardMode;
  /** `contract_id` → `display_name`, for the door facet. Empty when no
   *  contracts caller is wired or the list failed ⇒ facets fall back to ids. */
  doorNames: ReadonlyMap<string, string>;
}

const errMessage = (err: unknown): string =>
  humanizeRpcError(err);

const formatDate = (ms: number): string =>
  Number.isFinite(ms) ? new Date(ms).toLocaleDateString() : '—';

/** The card's facet chips — EVERY authority-bearing axis of the would-be
 *  rule (codex MEDIUM fold: the accept mints exactly this surface, so the
 *  card must show all of it — notably `actor` and the explicit ingredient,
 *  which the heading's operation-first label can elide). Vocabulary matches
 *  the contracts panel's minted-row chips. */
const suggestionFacets = (
  row: DelegationRuleSuggestionRow,
  doorNames: ReadonlyMap<string, string>,
): string[] => {
  const snap = row.snapshot;
  const parts: string[] = [
    `channel: ${snap.channel}`,
    `actor: ${snap.actor}`,
    `ingredient: ${snap.ingredient_id}`,
  ];
  if (snap.operation_id !== undefined) parts.push(`operation: ${snap.operation_id}`);
  if (snap.connection_name !== undefined) {
    parts.push(`connection: ${snap.connection_name}`);
  }
  parts.push(`recipe: ${snap.recipe_id}`, `risk: ${snap.risk_tier}`, `mode: ${snap.grant_mode}`);
  if (snap.entity_scope !== undefined) parts.push(`entity: ${snap.entity_scope}`);
  // D-177 N.14 — a door suggestion names its door (the rule the accept
  // mints matches ONLY fires supplying this door contract id).
  //
  // 🔑 WHY THE NAME AND NOT THE ID: a `ct_…` is rendered on NO owner-facing
  // surface — `contracts-panel.ts` lists a contract by `display_name` and never
  // by id — so the raw id was a join key to nothing: unlookupable, unmatchable,
  // unactionable. `display_name` is the EXACT string the owner's own contract
  // inventory shows, which is what makes this facet cross-referenceable.
  //
  // ⚠ It reads partly redundant with `recipe:` above, and that is the point,
  // not an oversight: the door mint composes the name as
  // `${profile.display} — ${recipeId}` (`mint-door-contract.ts`), so the shared
  // half IS the anchor a reader matches on. Do not "de-duplicate" it away.
  //
  // Unresolved (no caller wired, the contracts list failed, or the door is
  // revoked/absent) falls back to the id: a stale name would misidentify the
  // door this rule binds to, and this facet's whole job is naming it exactly.
  if (snap.bound_contract_id !== undefined) {
    const name = doorNames.get(snap.bound_contract_id);
    parts.push(`form door: ${name ?? snap.bound_contract_id}`);
  }
  return parts;
};

/** The evidence sentence — what earned this suggestion. Door rows (N.14)
 *  drop the sessions phrasing: every fire on a door shares its one stable
 *  session id, so "across 1 session" would misread as thin evidence when
 *  each row is a distinct deliberate inbox answer. */
const evidenceLine = (row: DelegationRuleSuggestionRow): string => {
  const ev = row.evidence;
  const approvals = `${ev.row_count} approval${ev.row_count === 1 ? '' : 's'}`;
  const uses = `${ev.consumed_uses} use${ev.consumed_uses === 1 ? '' : 's'}`;
  const range = `${formatDate(ev.first_minted_at)} – ${formatDate(ev.last_minted_at)}`;
  if (row.snapshot.bound_contract_id !== undefined) {
    // D-177 N.14.8 fork 3 (owner: "surface") — say the COUNTER-EVIDENCE out
    // loud. Without it this sentence asserts a clean run of approvals while
    // silently omitting that the owner may have refused far more on the same
    // form — and accepting mints a rule that runs WITHOUT review, so the
    // 3-approvals/20-rejections case is exactly where the card was quietest and
    // automating is most wrong. [[a_rendering_is_a_claim_about_what_it_shows]]
    //
    // ⛔ It never suppresses the card: a reception owner reviews STRANGERS, so
    // rejecting spam is the normal case, not distrust of the recipe. The human
    // reads this and decides; human-mint is the backstop.
    //
    // Absent ⇒ NOT COUNTED (no counter wired), which is not the same claim as
    // zero — so say nothing rather than assert a clean record we can't back.
    // Zero IS earned, and worth saying: "no rejections" is real evidence FOR.
    const rejected = ev.door_rejected_count;
    const rejections =
      rejected === undefined
        ? undefined
        : rejected === 0
          ? 'no rejections'
          : `${rejected} rejection${rejected === 1 ? '' : 's'}`;
    return rejections === undefined
      ? `${approvals} on this form (${uses}), ${range}`
      : `${approvals}, ${rejections} on this form (${uses}), ${range}`;
  }
  const sessions = `${ev.distinct_session_count} session${
    ev.distinct_session_count === 1 ? '' : 's'
  }`;
  return `${approvals} across ${sessions} (${uses}), ${range}`;
};

/** D-177 N.14.3 — the riding disclosure for an OPEN-mode door rule: the
 *  authority args whose roots are `door_submission` (visitor-supplied)
 *  VARY per submission once the rule operates — the card must say so
 *  (the accept mints exactly this surface). Defensive over the unknown-
 *  typed stored projection; anything unparseable discloses nothing extra
 *  (the facets still name mode + door). */
const doorRidingDisclosure = (row: DelegationRuleSuggestionRow): string | null => {
  const snap = row.snapshot;
  if (snap.bound_contract_id === undefined || snap.grant_mode !== 'open') return null;
  const projection = snap.open_projection as
    | { args?: ReadonlyArray<{ path?: unknown; roots?: ReadonlyArray<{ origin?: unknown }> }> }
    | undefined;
  if (projection === undefined || !Array.isArray(projection.args)) return null;
  const riding = projection.args
    .filter(
      (arg) =>
        Array.isArray(arg.roots)
        && arg.roots.some((root: { origin?: unknown }) => root.origin === 'door_submission'),
    )
    .map((arg) => (typeof arg.path === 'string' ? arg.path : ''))
    .filter((path) => path.length > 0);
  if (riding.length === 0) return null;
  return `Visitor-supplied at dispatch: ${riding.join(', ')} — these vary with every submission; everything else is pinned as approved.`;
};

/** Parse a bounds input value: integer within [1, ceiling] or null (the
 *  caller surfaces a card error — never clamp silently past what the owner
 *  typed on a standing-authority surface). */
const parseBound = (raw: string, ceiling: number): number | null => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > ceiling) return null;
  return n;
};

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

export const mountSuggestedRulesPanel = (
  opts: MountSuggestedRulesPanelOptions,
): SuggestedRulesPanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountSuggestedRulesPanel: no document available — pass `opts.document` for non-browser environments',
    );
  }

  let state: InternalState = {
    phase: 'loading',
    suggestions: [],
    listError: null,
    cardErrors: new Map(),
    activeKeyHash: null,
    activeMode: 'idle',
    doorNames: new Map(),
  };
  let disposed = false;
  let loadGeneration = 0;
  let pendingLoad: Promise<void> = Promise.resolve();
  // Cards with an accept/dismiss rpc in flight (keyed by `key_hash`).
  const pendingByKey = new Set<string>();

  const root = doc.createElement('div');
  root.setAttribute(SUGGESTED_RULES_PANEL_HOST_ATTR, '');
  opts.host.appendChild(root);

  const clearChildren = (node: HTMLElement): void => {
    while (node.firstChild) node.removeChild(node.firstChild);
  };

  const makeButton = (
    attr: string,
    className: string,
    text: string,
    keyHash: string,
  ): HTMLElement => {
    const btn = doc.createElement('button');
    btn.setAttribute(attr, '');
    btn.setAttribute('type', 'button');
    btn.setAttribute('data-key-hash', keyHash);
    btn.className = className;
    btn.textContent = text;
    return btn;
  };

  const setActive = (keyHash: string | null, mode: CardMode): void => {
    state = { ...state, activeKeyHash: keyHash, activeMode: keyHash === null ? 'idle' : mode };
    render();
  };

  const renderCard = (row: DelegationRuleSuggestionRow): void => {
    const key = row.key_hash;

    const card = doc.createElement('div');
    card.setAttribute(SUGGESTED_RULES_CARD_ATTR, '');
    card.setAttribute('data-key-hash', key);
    card.className = 'sr-card';

    const info = doc.createElement('div');
    info.className = 'sr-card-info';

    const heading = doc.createElement('div');
    heading.className = 'sr-card-heading';
    heading.textContent = `Allow without asking: ${
      row.snapshot.operation_id ?? row.snapshot.ingredient_id
    }`;
    info.appendChild(heading);

    const evidence = doc.createElement('div');
    evidence.className = 'sr-evidence';
    evidence.textContent = evidenceLine(row);
    info.appendChild(evidence);

    // D-177 N.14.3 — the riding disclosure (door open-mode rules only).
    const disclosure = doorRidingDisclosure(row);
    if (disclosure !== null) {
      const riding = doc.createElement('div');
      riding.className = 'sr-evidence';
      riding.setAttribute(SUGGESTED_RULES_DOOR_DISCLOSURE_ATTR, '');
      riding.textContent = disclosure;
      info.appendChild(riding);
    }

    const facets = doc.createElement('div');
    facets.className = 'sr-facets';
    for (const label of suggestionFacets(row, state.doorNames)) {
      const chip = doc.createElement('span');
      chip.className = 'sr-facet';
      chip.textContent = label;
      facets.appendChild(chip);
    }
    info.appendChild(facets);

    card.appendChild(info);

    // ── Resolution affordances ─────────────────────────────────
    const isActive = state.activeKeyHash === key;
    if (pendingByKey.has(key)) {
      const busy = makeButton(SUGGESTED_RULES_ACCEPT_ATTR, 'sr-accept', 'Working…', key);
      busy.setAttribute('disabled', '');
      card.appendChild(busy);
    } else if (isActive && state.activeMode === 'accepting') {
      // The expanded bounds editor — the deliberate step before standing
      // authority exists. Defaults = the fork-3 ceilings; the inputs'
      // min/max pin the tighten-only range, and the commit re-checks.
      const editor = doc.createElement('div');
      editor.className = 'sr-editor';

      const ttlLabel = doc.createElement('label');
      ttlLabel.className = 'sr-editor-label';
      ttlLabel.textContent = 'Expires after (days)';
      const ttlInput = doc.createElement('input');
      ttlInput.setAttribute(SUGGESTED_RULES_TTL_INPUT_ATTR, '');
      ttlInput.setAttribute('type', 'number');
      ttlInput.setAttribute('min', '1');
      ttlInput.setAttribute('max', String(TTL_CEILING_DAYS));
      ttlInput.setAttribute('value', String(TTL_CEILING_DAYS));
      ttlInput.className = 'sr-editor-input';
      ttlLabel.appendChild(ttlInput);
      editor.appendChild(ttlLabel);

      const usesLabel = doc.createElement('label');
      usesLabel.className = 'sr-editor-label';
      usesLabel.textContent = 'Use budget';
      const usesInput = doc.createElement('input');
      usesInput.setAttribute(SUGGESTED_RULES_USES_INPUT_ATTR, '');
      usesInput.setAttribute('type', 'number');
      usesInput.setAttribute('min', '1');
      usesInput.setAttribute('max', String(DELEGATION_RULE_MAX_USES));
      usesInput.setAttribute('value', String(DELEGATION_RULE_MAX_USES));
      usesInput.className = 'sr-editor-input';
      usesLabel.appendChild(usesInput);
      editor.appendChild(usesLabel);

      const mint = makeButton(SUGGESTED_RULES_MINT_ATTR, 'sr-mint', 'Mint rule', key);
      mint.addEventListener('click', () => {
        const ttlDays = parseBound((ttlInput as HTMLInputElement).value, TTL_CEILING_DAYS);
        const maxUses = parseBound(
          (usesInput as HTMLInputElement).value,
          DELEGATION_RULE_MAX_USES,
        );
        if (ttlDays === null || maxUses === null) {
          const next = new Map(state.cardErrors);
          next.set(
            key,
            `Bounds must be whole numbers — days 1–${TTL_CEILING_DAYS}, uses 1–${DELEGATION_RULE_MAX_USES} (tighten-only).`,
          );
          state = { ...state, cardErrors: next };
          render();
          return;
        }
        void runAccept(row, { ttl_ms: ttlDays * DAY_MS, max_uses: maxUses });
      });
      editor.appendChild(mint);

      const cancel = makeButton(SUGGESTED_RULES_CANCEL_ATTR, 'sr-cancel', 'Cancel', key);
      cancel.addEventListener('click', () => setActive(null, 'idle'));
      editor.appendChild(cancel);

      card.appendChild(editor);
    } else if (isActive && state.activeMode === 'dismiss-armed') {
      const controls = doc.createElement('div');
      controls.className = 'sr-confirm';
      const prompt = doc.createElement('span');
      prompt.className = 'sr-confirm-prompt';
      prompt.textContent = 'Dismiss forever? This exact suggestion never returns.';
      controls.appendChild(prompt);
      const confirm = makeButton(
        SUGGESTED_RULES_DISMISS_CONFIRM_ATTR,
        'sr-dismiss sr-confirm-yes',
        'Confirm',
        key,
      );
      confirm.addEventListener('click', () => {
        void runDismiss(row);
      });
      controls.appendChild(confirm);
      const cancel = makeButton(SUGGESTED_RULES_CANCEL_ATTR, 'sr-cancel', 'Cancel', key);
      cancel.addEventListener('click', () => setActive(null, 'idle'));
      controls.appendChild(cancel);
      card.appendChild(controls);
    } else {
      const actions = doc.createElement('div');
      actions.className = 'sr-actions';
      const accept = makeButton(SUGGESTED_RULES_ACCEPT_ATTR, 'sr-accept', 'Accept…', key);
      accept.addEventListener('click', () => setActive(key, 'accepting'));
      actions.appendChild(accept);
      const dismiss = makeButton(SUGGESTED_RULES_DISMISS_ATTR, 'sr-dismiss', 'Dismiss', key);
      dismiss.addEventListener('click', () => setActive(key, 'dismiss-armed'));
      actions.appendChild(dismiss);
      card.appendChild(actions);
    }

    const cardError = state.cardErrors.get(key);
    if (cardError !== undefined) {
      const line = doc.createElement('div');
      line.setAttribute(SUGGESTED_RULES_CARD_ERROR_ATTR, '');
      line.className = 'sr-card-error';
      line.textContent = cardError;
      card.appendChild(line);
    }

    root.appendChild(card);
  };

  const render = (): void => {
    if (disposed) return;
    clearChildren(root);

    // A list error renders even with zero cards — the owner must know the
    // surface is degraded, not silently empty.
    if (state.listError !== null) {
      const line = doc.createElement('div');
      line.setAttribute(SUGGESTED_RULES_ERROR_ATTR, '');
      line.className = 'sr-error';
      line.textContent = `Could not load suggested rules: ${state.listError}`;
      root.appendChild(line);
    }

    if (state.suggestions.length === 0) return; // no heading, no noise

    const heading = doc.createElement('h2');
    heading.setAttribute(SUGGESTED_RULES_HEADING_ATTR, '');
    heading.className = 'sr-heading';
    heading.textContent = 'Suggested rules';
    root.appendChild(heading);

    const copy = doc.createElement('p');
    copy.className = 'sr-copy';
    copy.textContent =
      'You approved these exact actions repeatedly across sessions. Accept to mint a bounded, revocable standing rule (it appears in the contract inventory); dismiss to never see this suggestion again.';
    root.appendChild(copy);

    for (const row of state.suggestions) renderCard(row);
  };

  /** `contract_id` → `display_name` for the door facet. Never throws: an absent
   *  caller or a failed list yields an empty map, and the facet falls back to
   *  the raw id — degraded naming, never a lost card. */
  const loadDoorNames = async (): Promise<ReadonlyMap<string, string>> => {
    if (opts.runListContracts === undefined) return new Map();
    try {
      const { contracts } = await opts.runListContracts();
      return new Map(contracts.map((c) => [c.contract_id, c.display_name]));
    } catch {
      return new Map();
    }
  };

  const doRefresh = (): Promise<void> => {
    const gen = ++loadGeneration;
    pendingLoad = (async () => {
      try {
        // The door-name lookup rides ALONGSIDE the suggestions list, never in
        // front of it: it is cosmetic, so its failure must not cost the owner
        // the cards themselves. Hence the inline catch (→ empty map → facets
        // fall back to raw ids) rather than letting it reject the Promise.all.
        const [{ suggestions }, doorNames] = await Promise.all([
          opts.runListSuggestions(),
          loadDoorNames(),
        ]);
        if (disposed || gen !== loadGeneration) return; // stale / torn down
        state = {
          ...state,
          phase: 'ready',
          // Only OPEN rows render — resolved rows live elsewhere (the rule in
          // the inventory; a dismissal nowhere, by design).
          suggestions: suggestions.filter((s) => s.state === 'open'),
          listError: null,
          cardErrors: new Map(),
          activeKeyHash: null,
          activeMode: 'idle',
          doorNames,
        };
        render();
      } catch (err) {
        if (disposed || gen !== loadGeneration) return;
        // Keep any visible cards; surface the error above them.
        state = { ...state, phase: 'error', listError: errMessage(err) };
        render();
      }
    })();
    return pendingLoad;
  };

  /** Shared resolution runner — accept and dismiss differ only in the rpc +
   *  the optimistic local effect (both end by dropping the card + re-listing). */
  const runResolution = async (
    row: DelegationRuleSuggestionRow,
    call: () => Promise<unknown>,
  ): Promise<void> => {
    const key = row.key_hash;
    if (pendingByKey.has(key)) return;
    pendingByKey.add(key);
    // Invalidate any in-flight list so its pre-resolution write can't clobber
    // the optimistic card drop below.
    loadGeneration += 1;
    const startErrors = new Map(state.cardErrors);
    startErrors.delete(key);
    state = {
      ...state,
      cardErrors: startErrors,
      activeKeyHash: state.activeKeyHash === key ? null : state.activeKeyHash,
      activeMode: state.activeKeyHash === key ? 'idle' : state.activeMode,
    };
    render();
    try {
      await call();
      if (disposed) return;
      pendingByKey.delete(key);
      // Optimistically drop the card — the rpc is the authority for this
      // suggestion's state now; the reconciling re-list follows.
      state = {
        ...state,
        suggestions: state.suggestions.filter((s) => s.key_hash !== key),
      };
      await doRefresh();
    } catch (err) {
      if (disposed) return;
      const next = new Map(state.cardErrors);
      next.set(key, errMessage(err));
      state = { ...state, cardErrors: next };
    } finally {
      pendingByKey.delete(key);
      if (!disposed) render();
    }
  };

  const runAccept = (
    row: DelegationRuleSuggestionRow,
    bounds?: { ttl_ms?: number; max_uses?: number },
  ): Promise<void> =>
    runResolution(row, () =>
      opts.runAcceptSuggestion({
        key_hash: row.key_hash,
        ...(bounds?.ttl_ms !== undefined ? { ttl_ms: bounds.ttl_ms } : {}),
        ...(bounds?.max_uses !== undefined ? { max_uses: bounds.max_uses } : {}),
      }),
    );

  const runDismiss = (row: DelegationRuleSuggestionRow): Promise<void> =>
    runResolution(row, () => opts.runDismissSuggestion({ key_hash: row.key_hash }));

  // ── Live coherence off the two suggestion bus kinds ──────────────
  // `suggested` fires on row CREATION (the learner found a new pattern);
  // `resolved` fires on accept/dismiss from ANY paired client. Both re-list
  // (generation-guarded) — the payload alone could drop a card, but the
  // authoritative re-list also catches anything missed while disconnected.
  const broadcastUnsubscribers: Array<() => void> = [];
  if (opts.subscribe) {
    broadcastUnsubscribers.push(
      opts.subscribe('contract.delegation_rule_suggested', () => {
        if (disposed) return;
        void doRefresh();
      }),
      opts.subscribe('contract.delegation_rule_suggestion_resolved', () => {
        if (disposed) return;
        void doRefresh();
      }),
    );
  }

  // ── Initial paint + seed load ────────────────────────────────────
  render();
  void doRefresh();

  return {
    getState: () => state.phase,
    getOpenSuggestions: () => state.suggestions,
    getListError: () => state.listError,
    refresh: () => doRefresh(),
    whenLoaded: () => pendingLoad,
    acceptSuggestion: async (keyHash, bounds) => {
      const row = state.suggestions.find((s) => s.key_hash === keyHash);
      if (row === undefined) return;
      await runAccept(row, bounds);
    },
    dismissSuggestion: async (keyHash) => {
      const row = state.suggestions.find((s) => s.key_hash === keyHash);
      if (row === undefined) return;
      await runDismiss(row);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const unsub of broadcastUnsubscribers) {
        try {
          unsub();
        } catch {
          /* swallow per-handle teardown failures */
        }
      }
      broadcastUnsubscribers.length = 0;
      try {
        opts.host.removeChild(root);
      } catch {
        // Some fake DOMs / a detached host throw on removeChild; ignore.
      }
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════

/** Self-scoped CSS, joined into the contracts route's one `<style>` bundle
 *  (mirrors `CONTRACTS_PANEL_STYLES`). */
export const SUGGESTED_RULES_PANEL_STYLES = `
[${SUGGESTED_RULES_PANEL_HOST_ATTR}] .sr-heading {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}
[${SUGGESTED_RULES_PANEL_HOST_ATTR}] .sr-copy {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.45;
}
[${SUGGESTED_RULES_PANEL_HOST_ATTR}] .sr-error,
[${SUGGESTED_RULES_PANEL_HOST_ATTR}] .sr-card-error {
  font-size: 13px;
  color: var(--fail);
  padding: 6px 2px;
}
[${SUGGESTED_RULES_PANEL_HOST_ATTR}] [${SUGGESTED_RULES_CARD_ATTR}] {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin: 8px 0;
  flex-wrap: wrap;
}
[${SUGGESTED_RULES_PANEL_HOST_ATTR}] .sr-card-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
[${SUGGESTED_RULES_PANEL_HOST_ATTR}] .sr-card-heading {
  font-size: 14px;
  font-weight: 600;
}
[${SUGGESTED_RULES_PANEL_HOST_ATTR}] .sr-evidence {
  font-size: 12px;
  color: var(--muted);
}
[${SUGGESTED_RULES_PANEL_HOST_ATTR}] .sr-facets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
[${SUGGESTED_RULES_PANEL_HOST_ATTR}] .sr-facet {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--surface-subtle);
  color: var(--muted);
}
[${SUGGESTED_RULES_PANEL_HOST_ATTR}] .sr-actions,
[${SUGGESTED_RULES_PANEL_HOST_ATTR}] .sr-confirm,
[${SUGGESTED_RULES_PANEL_HOST_ATTR}] .sr-editor {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
[${SUGGESTED_RULES_PANEL_HOST_ATTR}] .sr-confirm-prompt {
  font-size: 12px;
  color: var(--fail);
}
[${SUGGESTED_RULES_PANEL_HOST_ATTR}] .sr-editor-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11px;
  color: var(--muted);
}
[${SUGGESTED_RULES_PANEL_HOST_ATTR}] .sr-editor-input {
  width: 90px;
  font-size: 13px;
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
}
[${SUGGESTED_RULES_PANEL_HOST_ATTR}] .sr-accept,
[${SUGGESTED_RULES_PANEL_HOST_ATTR}] .sr-mint {
  font-size: 13px;
  padding: 4px 12px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--surface);
  color: var(--accent);
  cursor: pointer;
  white-space: nowrap;
}
[${SUGGESTED_RULES_PANEL_HOST_ATTR}] .sr-accept[disabled] {
  opacity: 0.6;
  cursor: default;
}
[${SUGGESTED_RULES_PANEL_HOST_ATTR}] .sr-dismiss {
  font-size: 13px;
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fail);
  cursor: pointer;
  white-space: nowrap;
}
[${SUGGESTED_RULES_PANEL_HOST_ATTR}] .sr-confirm-yes {
  border-color: var(--fail);
}
[${SUGGESTED_RULES_PANEL_HOST_ATTR}] .sr-cancel {
  font-size: 13px;
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  cursor: pointer;
  white-space: nowrap;
}
`;
