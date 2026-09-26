/** D-200 Slices 6g.4/6g.7/6g.10/6g.11/6g.14/6h.3b1 — Reception owner UI for one exact intake-form/recipe
 * pair (`#reception/endpoints/pair/<endpoint-id>`).
 *
 * The server remains the authority: bind sends only the selected local recipe
 * id plus the row clock returned by `get`; configuration sends only the closed
 * deployment block plus that ready pair's exact observation. The browser
 * never derives field mappings, commerce terms, Seller-row authority, or pack
 * identity. It may name one optional stable local offer id inside the exact
 * recipe configuration; the next pair revision pins that association.
 * `recipe.list` is rendered without a
 * Seller/pack/publisher/bundle admission filter, so any durable local recipe
 * the server exposes can be selected; `bind` performs the real parser and
 * compatibility checks.
 *
 * Readiness separately reports whether the exact saved recipe fits the
 * bounded direct-submit role; ineligibility never unpairs or hides it. This
 * surface also reports exact recipe-pinned local claim-source readiness. Its
 * separate recovery form can replay only an already-durable claim and presents
 * one fresh hosted URL without storing or auto-opening it. */

import type {
  Conn,
  PaidDocumentDirectCheckoutClaimConfiguration,
  ReceptionIntakeRecipePairClaimConfigurationBlockerCode,
  ReceptionIntakeRecipePairView,
  ServerRecipeListEntry,
  ServerRpcRegistry,
} from '@recued/contracts';
import {
  PAID_DOCUMENT_CHECKOUT_MAX_EXPIRY_WINDOW_MS,
  PAID_DOCUMENT_CHECKOUT_MIN_EXPIRY_WINDOW_MS,
  PAID_DOCUMENT_DIRECT_CHECKOUT_SELLER_ASSOCIATION_CONFIGURATION_VERSION,
  isSellerOfferId,
} from '@recued/contracts';
import { createActionDispatcher } from '@recued/ui-shared/action-dispatcher';
import { actionBar, badge, button, emptyHint, panel } from '@recued/ui-shared/primitives';
import { e } from '@recued/ui-shared/template';

import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { listAllRecipes } from '../shell/paged-lists.js';
import { classifyRpcError } from '../shell/rpc-error-copy.js';
import { serializeShellRoute } from '../shell/route.js';
import { RECEPTION_ERROR_COPY } from './spine.js';

export type ReceptionIntakeRecipePairSectionConn = Conn<
  Pick<
    ServerRpcRegistry,
    | 'recipe.list'
    | 'reception.intake_recipe_pair.get'
    | 'reception.intake_recipe_pair.bind'
    | 'reception.intake_recipe_pair.configure'
    | 'reception.intake_recipe_pair.clear'
  >
>;

const PAIR_SECTION_ACTIONS = [
  'reception-pair-select',
  'reception-pair-bind',
  // D-207 slice 1c — the owner accepts (or declines) the door's capability list.
  'reception-pair-consent-confirm',
  'reception-pair-consent-cancel',
  // D-207 follow-on — the owner also grants the confirmed closure standing
  // approval, so these ops stop asking per submission on THIS door.
  'reception-pair-consent-standing',
  'reception-pair-config-connection',
  'reception-pair-config-success-url',
  'reception-pair-config-cancel-url',
  'reception-pair-config-expiry-seconds',
  'reception-pair-config-template-ref',
  'reception-pair-config-seller-offer-id',
  'reception-pair-config-save',
  'reception-pair-refresh',
  'reception-pair-clear-request',
  'reception-pair-clear-confirm',
  'reception-pair-clear-cancel',
] as const;
type PairSectionAction = (typeof PAIR_SECTION_ACTIONS)[number];

const PAIR_SECTION_CHANGE_ACTIONS: ReadonlySet<PairSectionAction> = new Set([
  'reception-pair-select',
  // A checkbox reports through `change`, not `input`.
  'reception-pair-consent-standing',
]);

const PAIR_SECTION_CONFIG_INPUT_ACTIONS: ReadonlySet<PairSectionAction> = new Set([
  'reception-pair-config-connection',
  'reception-pair-config-success-url',
  'reception-pair-config-cancel-url',
  'reception-pair-config-expiry-seconds',
  'reception-pair-config-template-ref',
  'reception-pair-config-seller-offer-id',
]);

type ClaimConfigurationDraft = {
  readonly stripeConnectionName: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly expirySeconds: string;
  readonly templateFileRef: string;
  readonly sellerOfferId: string;
};

const EMPTY_CLAIM_CONFIGURATION_DRAFT: ClaimConfigurationDraft = {
  stripeConnectionName: '',
  successUrl: '',
  cancelUrl: '',
  expirySeconds: String(PAID_DOCUMENT_CHECKOUT_MIN_EXPIRY_WINDOW_MS / 1_000),
  templateFileRef: '',
  sellerOfferId: '',
};

const claimConfigurationDraftFor = (
  pair: ReceptionIntakeRecipePairView,
): ClaimConfigurationDraft => {
  // D-210 R-2 slice 4 — a claim is a property of an intake form's FIELDS, so only a FORM
  // pair has one. A ready SCHEDULING pair reaches none of this section's claim UI.
  if (pair.status !== 'ready' || pair.pair_subject !== 'form') {
    return EMPTY_CLAIM_CONFIGURATION_DRAFT;
  }
  const configuration = pair.claim_configuration_readiness.configuration;
  if (configuration === null) return EMPTY_CLAIM_CONFIGURATION_DRAFT;
  return {
    stripeConnectionName: configuration.stripe_connection_name,
    successUrl: configuration.success_url,
    cancelUrl: configuration.cancel_url,
    expirySeconds: String(configuration.expiry_window_ms / 1_000),
    templateFileRef: configuration.template_file_ref,
    sellerOfferId: configuration.version
      === PAID_DOCUMENT_DIRECT_CHECKOUT_SELLER_ASSOCIATION_CONFIGURATION_VERSION
      ? configuration.seller_offer_id
      : '',
  };
};

const claimConfigurationFromDraft = (
  draft: ClaimConfigurationDraft,
): PaidDocumentDirectCheckoutClaimConfiguration | null => {
  const expirySeconds = Number(draft.expirySeconds);
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(draft.stripeConnectionName)
    || !Number.isSafeInteger(expirySeconds)
    || expirySeconds * 1_000 < PAID_DOCUMENT_CHECKOUT_MIN_EXPIRY_WINDOW_MS
    || expirySeconds * 1_000 > PAID_DOCUMENT_CHECKOUT_MAX_EXPIRY_WINDOW_MS
    || !/^file:[0-9a-f]{32}$/.test(draft.templateFileRef)) {
    return null;
  }
  const isHttpsUrl = (value: string): boolean => {
    if (value.length === 0 || value.length > 2_048 || !value.startsWith('https://')) {
      return false;
    }
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:'
        && parsed.hostname.length > 0
        && parsed.username === ''
        && parsed.password === '';
    } catch {
      return false;
    }
  };
  if (!isHttpsUrl(draft.successUrl) || !isHttpsUrl(draft.cancelUrl)) return null;
  const common = {
    stripe_connection_name: draft.stripeConnectionName,
    success_url: draft.successUrl,
    cancel_url: draft.cancelUrl,
    expiry_window_ms: expirySeconds * 1_000,
    template_file_ref: draft.templateFileRef,
  };
  if (draft.sellerOfferId === '') {
    return { version: 1, ...common };
  }
  if (!isSellerOfferId(draft.sellerOfferId)) return null;
  return {
    version: PAID_DOCUMENT_DIRECT_CHECKOUT_SELLER_ASSOCIATION_CONFIGURATION_VERSION,
    ...common,
    seller_offer_id: draft.sellerOfferId,
  };
};

interface PairSectionState {
  loading: boolean;
  pairRefreshing: boolean;
  saving: boolean;
  /** True only after a successful server pair read or mutation response.
   *  False blocks writes when the visible pair is retained merely as the
   *  last observation after a failed refresh. */
  authorityCurrent: boolean;
  pair: ReceptionIntakeRecipePairView | null;
  recipes: ReadonlyArray<ServerRecipeListEntry>;
  selectedRecipeId: string;
  configurationDraft: ClaimConfigurationDraft;
  confirmingClear: boolean;
  /** D-207 slice 1c — the door WIDENED and is waiting on the owner. The pair is saved; the
   *  door is SHUT until they accept. `added` is the list of ops the anonymous public could
   *  not reach before and now could — it is the prompt, not a footnote to it. */
  pendingDoorConsent: {
    added: readonly string[];
    recipeId: string;
    /** Ops that keep asking even with the tick. ⚠ Usually EMPTY — a responding
     *  door cannot carry one — and an empty list must render NOTHING, not a
     *  warning about a delete this form does not have. */
    asksAnyway: readonly string[];
  } | null;
  /** The owner's standing-approval choice for the consent block on screen.
   *  ⛔ Reset to false every time a NEW consent block is raised — a choice made
   *  about one closure must never carry onto a different one. */
  standingClosure: boolean;
  error: string | null;
  notice: string | null;
}

export interface ReceptionIntakeRecipePairSectionOptions {
  host: HTMLElement;
  conn: ReceptionIntakeRecipePairSectionConn;
  endpointId: string;
  /** Optional broadcast seam. Any mutation of this endpoint can change the
   * form snapshot or pair row, so the section re-reads the pair on the
   * endpoint-wide invalidation rather than interpreting the event payload. */
  subscribe?: BroadcastSubscriber['on'];
}

export interface ReceptionIntakeRecipePairSectionMount {
  /** Re-read both the exact pair and the complete durable recipe list. */
  update(): void;
  /** Detach dispatch/broadcast listeners and clear the host. Idempotent. */
  dispose(): void;
}

const pairErrorCopy = (error: unknown): string | null => {
  const classified = classifyRpcError(error);
  if (classified.suppressible) return null;
  if (classified.code !== null) {
    const receptionCopy = (RECEPTION_ERROR_COPY as Readonly<Record<string, string>>)[
      classified.code
    ];
    if (receptionCopy !== undefined) return receptionCopy;
  }
  if (classified.connectionCaused) return classified.copy;
  // Do not leak method names or store diagnostics from an unexpected server
  // error into owner-facing copy. The connection classifier already gives
  // safe, specific copy for offline / timeout / in-doubt failures.
  return 'Recued could not load or change what this form is joined to. Refresh and try again.';
};

const bindingOf = (
  pair: ReceptionIntakeRecipePairView | null,
): ReceptionIntakeRecipePairView['binding'] => pair?.binding ?? null;

const selectedRecipeFor = (
  pair: ReceptionIntakeRecipePairView,
  recipes: ReadonlyArray<ServerRecipeListEntry>,
): string => {
  const recipeId = pair.binding?.recipe_id;
  return recipeId !== undefined && recipes.some((entry) => entry.recipe_id === recipeId)
    ? recipeId
    : '';
};

const CLAIM_CONFIGURATION_BLOCKER_COPY: Record<
  ReceptionIntakeRecipePairClaimConfigurationBlockerCode,
  string
> = {
  claim_configuration_missing: 'The payment set-up for this Recipe is missing',
  claim_configuration_invalid: 'The payment set-up for this Recipe is wrong',
  stripe_connection_lookup_unavailable: 'Recued cannot see your Stripe Connections',
  stripe_connection_missing: 'That exact Stripe Connection is not set up',
  stripe_connection_source_mismatch: 'The Connection list came back about something else',
  stripe_connection_not_stripe: 'That Connection is not a Stripe one',
  template_lookup_unavailable: 'Recued cannot see your templates',
  template_missing: 'That template is gone',
  template_not_local: 'That template is not saved on your own server',
  template_mime_unsupported: 'The template has to be Markdown or plain text',
  template_too_large: 'The template is bigger than 1 MiB',
  template_source_mismatch: 'The template file and what your server says about it do not match',
  template_unreadable: 'Recued cannot read that template',
  seller_offer_lookup_unavailable: 'Recued cannot see your Seller offers',
  seller_offer_missing: 'That Seller offer is gone',
  seller_offer_source_mismatch: 'Seller came back with a different offer',
  seller_offer_recipe_mismatch: 'This Recipe did not make that Seller offer, and does not fill it',
};

const statusBadge = (
  pair: ReceptionIntakeRecipePairView | null,
  loading: boolean,
  authorityCurrent: boolean,
): string => {
  if (loading) return badge({ label: 'Loading', tone: 'idle' });
  if (!authorityCurrent) return badge({ label: 'Needs a refresh', tone: 'off' });
  if (pair === null) {
    return badge({ label: 'Unavailable', tone: 'off' });
  }
  switch (pair.status) {
    case 'unpaired':
      return badge({ label: 'Unpaired', tone: 'idle' });
    case 'ready':
      return badge({ label: 'Paired', tone: 'ok' });
    case 'stale':
      return badge({ label: 'Stale', tone: 'off' });
  }
};

const claimConfigurationReadinessSummary = (
  pair: Extract<
    ReceptionIntakeRecipePairView,
    { readonly status: 'ready'; readonly pair_subject: 'form' }
  >,
): string => {
  const readiness = pair.claim_configuration_readiness;
  const configuration = readiness.configuration;
  const configurationDetails = configuration === null
    ? ''
    : `
      <dl class="reception-pair-binding" data-claim-configuration="configured">
        <div><dt>Stripe connection</dt><dd><code>${e(configuration.stripe_connection_name)}</code></dd></div>
        <div><dt>Template</dt><dd><code>${e(configuration.template_file_ref)}</code></dd></div>
        <div><dt>Success URL</dt><dd><code>${e(configuration.success_url)}</code></dd></div>
        <div><dt>Cancel URL</dt><dd><code>${e(configuration.cancel_url)}</code></dd></div>
        <div><dt>Checkout expiry</dt><dd>${configuration.expiry_window_ms / 1_000} seconds</dd></div>
        <div><dt>Seller outcome offer</dt><dd>${configuration.version
          === PAID_DOCUMENT_DIRECT_CHECKOUT_SELLER_ASSOCIATION_CONFIGURATION_VERSION
          ? `<code>${e(configuration.seller_offer_id)}</code>`
          : 'Not joined up'}</dd></div>
      </dl>
    `;
  if (readiness.status === 'ready') {
    const sourceCopy = configuration?.version
      === PAID_DOCUMENT_DIRECT_CHECKOUT_SELLER_ASSOCIATION_CONFIGURATION_VERSION
      ? `
          The exact Stripe Connection, template, Seller row and Recipe route
          this Recipe pins are all here now. What the offer says is looked at
          again from the real answer before Recued makes a task, saves
          anything, or writes to the service. This does not say yes to taking
          a payment, or to sending anyone anywhere.
        `
      : `
          The exact Stripe Connection and template this Recipe pins are here
          now. This does not say yes to taking a payment, or to sending anyone
          anywhere.
        `;
    return `
      <div class="reception-pair-readiness" data-claim-configuration-readiness="ready">
        ${badge({ label: 'Everything the payment needs is ready', tone: 'ok' })}
        <p class="reception-pair-help">${sourceCopy}</p>
        ${configurationDetails}
      </div>
    `;
  }
  const blockerItems = readiness.blockers.map(
    (code) => `<li>${e(CLAIM_CONFIGURATION_BLOCKER_COPY[code])}</li>`,
  ).join('');
  return `
    <div class="reception-pair-readiness" data-claim-configuration-readiness="blocked">
      ${badge({ label: 'The payment set-up is not finished', tone: 'off' })}
      <p class="reception-pair-help">
        This exact pair remains saved. Its recipe-local deployment sources must
        be fixed before a direct Checkout claim can be created.
      </p>
      <ul class="reception-pair-blockers">${blockerItems}</ul>
      ${configurationDetails}
    </div>
  `;
};

const pairSummary = (
  pair: ReceptionIntakeRecipePairView | null,
  loading: boolean,
  authorityCurrent: boolean,
): string => {
  if (pair === null) {
    return `<p class="reception-pair-copy">${loading
      ? 'Loading what this form is joined to…'
      : 'Recued cannot show what this form is joined to. Refresh to try again.'}</p>`;
  }
  if (!authorityCurrent) {
    if (pair.binding === null) {
      return `<p class="reception-pair-copy">The last observed status was ${e(pair.status)}. Refresh before treating it as current.</p>`;
    }
    return `
      <p class="reception-pair-copy">This is the last observed pair. Refresh before treating it as current.</p>
      <dl class="reception-pair-binding">
        <div><dt>Recipe</dt><dd><code>${e(pair.binding.recipe_id)}</code> · v${pair.binding.recipe_version}</dd></div>
        <div><dt>Pair revision</dt><dd><code>${e(pair.binding.pair_revision)}</code></dd></div>
        <div><dt>Seller outcome offer</dt><dd>${'seller_offer_id' in pair.binding
          ? `<code>${e(pair.binding.seller_offer_id)}</code>`
          : 'Not joined up'}</dd></div>
      </dl>
    `;
  }
  if (pair.status === 'unpaired') {
    return '<p class="reception-pair-copy">This remains a generic intake form. No checkout recipe is paired.</p>';
  }
  if (pair.binding === null) {
    return `
      <p class="reception-pair-copy">
        The stored pair cannot be decoded. Clear it before selecting and binding a recipe again.
      </p>
    `;
  }
  const binding = pair.binding;
  const headline = pair.status === 'ready'
    ? 'This form and the saved Recipe still match.'
    : 'The form or the saved Recipe has changed since you joined them.';
  return `
    <p class="reception-pair-copy">${headline}</p>
    <dl class="reception-pair-binding">
      <div><dt>Recipe</dt><dd><code>${e(binding.recipe_id)}</code> · v${binding.recipe_version}</dd></div>
      <div><dt>Pair revision</dt><dd><code>${e(binding.pair_revision)}</code></dd></div>
      <div><dt>Seller outcome offer</dt><dd>${'seller_offer_id' in binding
        ? `<code>${e(binding.seller_offer_id)}</code>`
        : 'Not joined up'}</dd></div>
    </dl>
    ${pair.status === 'ready' && pair.pair_subject === 'form' ? `
      ${claimConfigurationReadinessSummary(pair)}
    ` : ''}
  `;
};

const claimConfigurationAuthoringPanel = (
  state: PairSectionState,
): string => {
  const pair = state.pair;
  if (pair === null
    || pair.status !== 'ready'
    || pair.pair_subject !== 'form'
    || !state.authorityCurrent) return '';
  const authoring = pair.claim_configuration_authoring;
  if (authoring.status === 'fork_required') {
    return panel({
      tone: 'warn',
      title: 'Set up your own copy',
      body: `
        <p class="reception-pair-copy" data-claim-configuration-authoring="fork_required">
          This exact recipe is owned by a pack or bundled read-only. Create a
          local fork under a new recipe id, return here, and pair that fork.
          Core will not replace pack provenance to make this configuration look editable.
        </p>
      `,
    });
  }
  if (authoring.status === 'unavailable') {
    return panel({
      tone: 'info',
      title: 'You can look, but not change',
      body: `
        <p class="reception-pair-copy" data-claim-configuration-authoring="unavailable">
          Your server cannot find a saved Recipe of your own for this.
          Refresh, or save your own copy, before you set up checkout.
        </p>
      `,
    });
  }

  const draft = state.configurationDraft;
  const configuration = claimConfigurationFromDraft(draft);
  const disabled = state.loading || state.pairRefreshing || state.saving;
  return panel({
    title: 'Payment set-up',
    body: `
      <div data-claim-configuration-authoring="editable">
        <p class="reception-pair-copy">
          These only say where things are on your server. What is sold, how
          much, in what money, and which answers are looked at all stay in the
          Recipe. A Seller offer id only points somewhere — it does not prove
          the offer, the price, the payment, or that anything was sent.
        </p>
        <div class="reception-pair-config-grid">
          <label class="reception-pair-label">
            Stripe Connection name
            <input class="reception-pair-input" data-action="reception-pair-config-connection"
              value="${e(draft.stripeConnectionName)}" ${disabled ? 'disabled' : ''}>
          </label>
          <label class="reception-pair-label">
            Which template file
            <input class="reception-pair-input" data-action="reception-pair-config-template-ref"
              value="${e(draft.templateFileRef)}" placeholder="file:32-lowercase-hex"
              ${disabled ? 'disabled' : ''}>
          </label>
          <label class="reception-pair-label reception-pair-config-wide">
            Success URL
            <input class="reception-pair-input" data-action="reception-pair-config-success-url"
              type="url" value="${e(draft.successUrl)}" ${disabled ? 'disabled' : ''}>
          </label>
          <label class="reception-pair-label reception-pair-config-wide">
            Cancel URL
            <input class="reception-pair-input" data-action="reception-pair-config-cancel-url"
              type="url" value="${e(draft.cancelUrl)}" ${disabled ? 'disabled' : ''}>
          </label>
          <label class="reception-pair-label">
            Checkout expiry (seconds)
            <input class="reception-pair-input" data-action="reception-pair-config-expiry-seconds"
              type="number" min="${PAID_DOCUMENT_CHECKOUT_MIN_EXPIRY_WINDOW_MS / 1_000}"
              max="${PAID_DOCUMENT_CHECKOUT_MAX_EXPIRY_WINDOW_MS / 1_000}" step="1"
              value="${e(draft.expirySeconds)}" ${disabled ? 'disabled' : ''}>
          </label>
          <label class="reception-pair-label">
            Seller outcome offer ID (optional)
            <input class="reception-pair-input"
              data-action="reception-pair-config-seller-offer-id"
              value="${e(draft.sellerOfferId)}"
              placeholder="documents.prepared-pdf" ${disabled ? 'disabled' : ''}>
          </label>
        </div>
        <p class="reception-pair-help">
          Saving compares the exact local recipe bytes and provenance. A real
          change intentionally makes this pair stale; rebind it to pin the new revision.
        </p>
        ${configuration === null ? `
          <p class="reception-pair-help" data-claim-configuration-draft="invalid">
            Use a canonical connection name, two credential-free HTTPS URLs,
            a 1,800–86,400 second expiry, one canonical local file ref, and a
            lowercase Seller offer id when association is enabled.
          </p>
        ` : ''}
        ${actionBar({
          gap: 4,
          children: [button({
            label: state.saving ? 'Saving…' : 'Save the payment set-up',
            action: 'reception-pair-config-save',
            variant: 'primary',
            size: 'sm',
            disabled,
          })],
        })}
      </div>
    `,
  });
};

const recipeOption = (
  recipe: ServerRecipeListEntry,
  selectedRecipeId: string,
): string => {
  const label = `${recipe.recipe.metadata.name} · ${recipe.recipe_id} · v${recipe.version} · ${recipe.publisher_id} · ${recipe.source}`;
  return `<option value="${e(recipe.recipe_id)}"${recipe.recipe_id === selectedRecipeId ? ' selected' : ''}>${e(label)}</option>`;
};

const renderPairSection = (
  endpointId: string,
  state: PairSectionState,
): string => {
  const pair = state.pair;
  const corrupt = pair?.status === 'stale' && pair.binding === null;
  const canBind =
    !state.loading
    && !state.pairRefreshing
    && !state.saving
    && state.authorityCurrent
    && !corrupt
    && state.selectedRecipeId !== '';
  const canClear =
    !state.loading
    && !state.pairRefreshing
    && !state.saving
    && state.authorityCurrent
    && pair !== null
    && pair.status !== 'unpaired';
  const bindLabel = pair === null || pair.status === 'unpaired'
    ? 'Join a Recipe'
    : 'Join it again';

  const feedback = state.error !== null
    ? panel({
        tone: 'danger',
        role: 'alert',
        title: 'That change did not work',
        body: `<p class="reception-pair-feedback">${e(state.error)}</p>`,
      })
    : state.notice !== null
      ? panel({
          tone: 'info',
          role: 'status',
          body: `<p class="reception-pair-feedback">${e(state.notice)}</p>`,
        })
      : '';

  const recipePicker = state.recipes.length === 0
    ? emptyHint({
        message: state.loading
          ? 'Loading saved recipes…'
          : 'You have no saved Recipes. Install or save one, then refresh.',
      })
    : `
      <label class="reception-pair-label" for="reception-pair-recipe">Saved recipe</label>
      <select
        class="reception-pair-select"
        id="reception-pair-recipe"
        data-action="reception-pair-select"
        ${state.loading || state.pairRefreshing || state.saving || !state.authorityCurrent ? 'disabled' : ''}
      >
        <option value="">Choose a saved recipe…</option>
        ${state.recipes.map((recipe) => recipeOption(recipe, state.selectedRecipeId)).join('')}
      </select>
      <p class="reception-pair-help">
        This is the complete durable recipe list returned by your server. Seller,
        pack, publisher, and recipe-bundle membership do not grant or restrict eligibility.
      </p>
    `;

  // D-207 slice 1c — the consent moment. This form is about to become reachable by anyone on
  // the internet, and these are the operations it would then be able to perform on the
  // owner's behalf. Naming them is the entire point: a prompt that says "capabilities
  // changed, approve?" is a rubber stamp, and the owner learns to click it without reading.
  //
  // Until they accept, the pair is saved and the door is SHUT — the form denies everything.
  const doorConsentBlock = state.pendingDoorConsent === null
    ? ''
    : `
      <div class="reception-door-consent" role="alert">
        <p class="reception-door-consent-lede">
          This public form would be able to:
        </p>
        <ul class="reception-door-consent-ops">
          ${state.pendingDoorConsent.added.map((op) => `<li><code>${e(op)}</code></li>`).join('')}
        </ul>
        <p class="reception-pair-help">
          Anyone who can reach this form can trigger these.
          ${state.standingClosure
            ? `They will run <strong>without asking you</strong>, on every submission to
               <strong>this form</strong> — that is what the box below grants.${
                 state.pendingDoorConsent.asksAnyway.length > 0
                   ? ` ${state.pendingDoorConsent.asksAnyway.length === 1
                       ? 'One action still asks'
                       : `${state.pendingDoorConsent.asksAnyway.length} actions still ask`
                     } every time: ${state.pendingDoorConsent.asksAnyway
                       .map((op) => `<code>${e(op)}</code>`).join(', ')}.`
                   : ''
               }`
            : `Anything that changes something still asks you every time. Just looking does not.`}
          The form will not run until you allow this.
        </p>
        <label class="reception-pair-help reception-door-consent-standing">
          <input type="checkbox" data-action="reception-pair-consent-standing"
                 ${state.standingClosure ? 'checked' : ''} />
          Let this form run unattended
        </label>
        <p class="reception-pair-help">
          ${state.standingClosure
            ? `You are approving the list above ONCE instead of once per submission.
               <strong>Only this form</strong> — another form, or this one re-bound to a
               recipe that needs something new, asks you again.`
            : `Leave this off and everything that changes something waits for you — good for a
               form you want to watch, hopeless for one that gets hundreds of answers a day.`}
        </p>
        ${actionBar({
          gap: 4,
          children: [
            button({
              label: state.saving ? 'Saving…' : 'Allow and go live',
              action: 'reception-pair-consent-confirm',
              variant: 'primary',
              size: 'sm',
              disabled: state.saving,
            }),
            button({
              label: 'Cancel',
              action: 'reception-pair-consent-cancel',
              size: 'sm',
              disabled: state.saving,
            }),
          ],
        })}
      </div>
    `;

  const clearControls = state.confirmingClear
    ? panel({
        tone: 'warn',
        compact: true,
        body: `
          <p class="reception-pair-feedback">Clear this exact observed pair? The intake form will remain available as a generic form.</p>
          ${actionBar({
            gap: 4,
            children: [
              button({
                label: 'Yes, unjoin them',
                action: 'reception-pair-clear-confirm',
                variant: 'danger',
                size: 'sm',
                disabled: !canClear,
              }),
              button({
                label: 'Keep them joined',
                action: 'reception-pair-clear-cancel',
                size: 'sm',
                disabled: state.saving,
              }),
            ],
          })}
        `,
      })
    : '';

  return `
    <div class="reception-page reception-intake-recipe-pair-section" data-reception-intake-recipe-pair-section="${e(endpointId)}">
      <header class="reception-pair-head">
        <a class="reception-pair-back" href="${e(serializeShellRoute('reception', 'endpoints'))}">← Endpoints</a>
        <div>
          <div class="reception-pair-title-row">
            <h2 class="reception-pair-title">Checkout recipe</h2>
            ${statusBadge(
              pair,
              state.loading || state.pairRefreshing,
              state.authorityCurrent,
            )}
          </div>
          <p class="reception-pair-endpoint">Intake endpoint <code>${e(endpointId)}</code></p>
        </div>
      </header>
      ${state.loading || state.pairRefreshing ? '<div class="reception-loading-bar" role="status" aria-label="Loading pair…"></div>' : ''}
      ${feedback}
      ${panel({
        title: 'Joined to',
        body: pairSummary(
          pair,
          state.loading || state.pairRefreshing,
          state.authorityCurrent,
        ),
      })}
      ${claimConfigurationAuthoringPanel(state)}
      ${panel({
        title: 'Pick where the Recipe comes from',
        body: `
          <p class="reception-pair-copy">
            The intake form and recipe are designed as one exact pair. The recipe owns
            field validation and the product, amount, and currency mapping; core only
            derives and stores the binding from the two saved sources.
          </p>
          <p class="reception-pair-copy">
            Direct checkout is intentionally limited to one item at quantity one. Pairing
            here does not execute the recipe or contact a payment provider.
          </p>
          ${recipePicker}
          ${doorConsentBlock}
          ${actionBar({
            gap: 4,
            children: [
              button({
                label: state.saving ? 'Saving…' : bindLabel,
                action: 'reception-pair-bind',
                variant: 'primary',
                size: 'sm',
                disabled: !canBind,
              }),
              button({
                label: 'Refresh',
                action: 'reception-pair-refresh',
                size: 'sm',
                disabled: state.loading || state.pairRefreshing || state.saving,
              }),
              button({
                label: 'Unjoin them',
                action: 'reception-pair-clear-request',
                variant: 'danger-text',
                size: 'sm',
                disabled: !canClear,
              }),
            ],
          })}
          ${clearControls}
        `,
      })}
    </div>
  `;
};

export const mountReceptionIntakeRecipePairSection = (
  opts: ReceptionIntakeRecipePairSectionOptions,
): ReceptionIntakeRecipePairSectionMount => {
  const { host, conn, endpointId } = opts;
  let disposed = false;
  let loadToken = 0;
  let pairRefreshToken = 0;
  let pendingPairRefresh = false;
  let pendingFullLoad = false;
  let state: PairSectionState = {
    loading: true,
    pairRefreshing: false,
    saving: false,
    authorityCurrent: false,
    pair: null,
    recipes: [],
    selectedRecipeId: '',
    configurationDraft: EMPTY_CLAIM_CONFIGURATION_DRAFT,
    confirmingClear: false,
    pendingDoorConsent: null,
    standingClosure: false,
    error: null,
    notice: null,
  };

  const render = (): void => {
    if (disposed) return;
    host.innerHTML = renderPairSection(endpointId, state);
  };

  const applyPair = (
    pair: ReceptionIntakeRecipePairView,
    preserveNotice = false,
  ): void => {
    state = {
      ...state,
      pair,
      pairRefreshing: false,
      authorityCurrent: true,
      selectedRecipeId: selectedRecipeFor(pair, state.recipes),
      configurationDraft: claimConfigurationDraftFor(pair),
      confirmingClear: false,
      error: null,
      notice: preserveNotice ? state.notice : null,
    };
  };

  const load = async (): Promise<void> => {
    if (state.saving) {
      pendingFullLoad = true;
      return;
    }
    const token = ++loadToken;
    // A full read supersedes any narrower pair-only read already in flight.
    // Without this cross-invalidation, an older broadcast refresh could land
    // after the full read and overwrite its newer pair/list snapshot.
    pairRefreshToken += 1;
    state = {
      ...state,
      loading: true,
      pairRefreshing: false,
      authorityCurrent: false,
      error: null,
      notice: null,
      confirmingClear: false,
    };
    render();
    try {
      const [pair, listed] = await Promise.all([
        conn('reception.intake_recipe_pair.get', { endpoint_id: endpointId }),
        listAllRecipes((request) => conn('recipe.list', request)),
      ]);
      if (disposed || token !== loadToken) return;
      state = {
        ...state,
        loading: false,
        pairRefreshing: false,
        authorityCurrent: true,
        pair,
        recipes: listed.recipes,
        selectedRecipeId: selectedRecipeFor(pair, listed.recipes),
        configurationDraft: claimConfigurationDraftFor(pair),
      };
    } catch (error) {
      if (disposed || token !== loadToken) return;
      state = {
        ...state,
        loading: false,
        pairRefreshing: false,
        authorityCurrent: false,
        error: pairErrorCopy(error),
      };
    }
    render();
    if (pendingPairRefresh) {
      pendingPairRefresh = false;
      // A same-endpoint event may have arrived after this load's pair read.
      // Re-read once after `loading` clears so the older snapshot is never
      // the terminal view.
      void refreshPair();
    }
  };

  const refreshPair = async (preserveNotice = false): Promise<void> => {
    if (state.saving || state.loading || state.pairRefreshing) {
      pendingPairRefresh = true;
      return;
    }
    const token = ++pairRefreshToken;
    state = {
      ...state,
      pairRefreshing: true,
      authorityCurrent: false,
      error: null,
    };
    render();
    try {
      const pair = await conn('reception.intake_recipe_pair.get', {
        endpoint_id: endpointId,
      });
      if (disposed || token !== pairRefreshToken) return;
      applyPair(pair, preserveNotice);
      render();
    } catch (error) {
      if (disposed || token !== pairRefreshToken) return;
      state = {
        ...state,
        pairRefreshing: false,
        authorityCurrent: false,
        error: pairErrorCopy(error),
      };
      render();
    }
    if (pendingPairRefresh) {
      pendingPairRefresh = false;
      void refreshPair(preserveNotice);
    }
  };

  const reconcileConflict = async (error: unknown): Promise<void> => {
    const copy = pairErrorCopy(error);
    try {
      const pair = await conn('reception.intake_recipe_pair.get', {
        endpoint_id: endpointId,
      });
      if (!disposed) applyPair(pair);
    } catch {
      // Preserve the original conflict/error copy. The explicit Refresh
      // action remains available when the reconciliation read also fails.
      if (!disposed) state = { ...state, authorityCurrent: false };
    }
    if (disposed) return;
    state = { ...state, error: copy, notice: null };
  };

  const finishMutation = (): void => {
    if (disposed) return;
    state = { ...state, saving: false };
    render();
    if (pendingFullLoad) {
      pendingFullLoad = false;
      void load();
      return;
    }
    if (pendingPairRefresh) {
      pendingPairRefresh = false;
      // A real local mutation commonly emits its own endpoint broadcast.
      // Reconcile it without immediately erasing the just-rendered success
      // notice; an unsolicited later broadcast clears stale feedback.
      void refreshPair(true);
    }
  };

  /** D-207 slice 1c — bind the pair AND hang its door.
   *
   *  Pairing a recipe to a public form is two facts, and only one of them used to be told.
   *  The pair says WHICH recipe the form runs. The DOOR says under what authority — and
   *  without one the form runs NOTHING: an anonymous submission carries no contract, floors
   *  to `PUBLIC_CONTRACT_ID`, and every op hard-denies.
   *
   *  So "Recipe paired with this intake form." is not a safe thing to say on its own. On a
   *  `needs_consent` result it is a LIE: the pair is saved, the door is shut, and the owner
   *  has been told it worked. That is the silent-success-page bug wearing the owner's UI.
   *  Every branch below therefore reports the DOOR, not just the pair.
   *
   *  `confirmCapability` is only ever set by the owner clicking through the consent block —
   *  never inferred, never defaulted. It does not grant anything by itself: the server
   *  re-derives the closure from the saved recipe and this flag decides only whether to
   *  PROMPT. */
  const bindSelected = async (
    confirmCapability = false,
    standingClosure = false,
  ): Promise<void> => {
    const observed = state.pair;
    if (
      disposed
      || state.loading
      || state.pairRefreshing
      || state.saving
      || !state.authorityCurrent
      || observed === null
      || (observed.status === 'stale' && observed.binding === null)
      || state.selectedRecipeId === ''
    ) return;
    const recipeId = state.selectedRecipeId;
    // Invalidate a same-endpoint refresh that began before this observed
    // write. The mutation result (or its post-error reconciliation read) is
    // newer authority and must not be overwritten by that older response.
    pairRefreshToken += 1;
    state = {
      ...state,
      saving: true,
      confirmingClear: false,
      pendingDoorConsent: null,
      standingClosure: false,
      error: null,
      notice: null,
    };
    render();
    try {
      const result = await conn('reception.intake_recipe_pair.bind', {
        endpoint_id: endpointId,
        recipe_id: recipeId,
        expected_updated_at: observed.updated_at,
        ...(confirmCapability ? { confirm_capability: true } : {}),
        // ⛔ Only ever alongside the confirm — the server refuses the pair
        // otherwise, and the UI must not be the thing that tries.
        ...(confirmCapability && standingClosure ? { standing_closure: true } : {}),
      });
      if (disposed) return;
      applyPair(result.pair);

      const door = result.door;
      if (door.status === 'needs_consent') {
        // The pair is saved and the door is SHUT. Say so, and show exactly what the public
        // would gain — the ADDED list is the consent prompt itself. A prompt that says only
        // "something changed, approve again?" trains the owner to click through unread.
        state = {
          ...state,
          pendingDoorConsent: {
            added: door.added,
            recipeId,
            asksAnyway: door.asks_anyway ?? [],
          },
          standingClosure: false,
          notice: null,
          error: null,
        };
        return;
      }
      if (door.status === 'refused') {
        // This recipe can never back a public form. Refused HERE, where the owner is
        // present — not at fire, where a visitor would eat the failure.
        state = {
          ...state,
          pendingDoorConsent: null,
          standingClosure: false,
          notice: null,
          error: `This Recipe cannot run on a form anyone can see: ${door.detail}`,
        };
        return;
      }

      const pairCopy = result.outcome === 'created'
        ? 'The Recipe is joined to this form.'
        : result.outcome === 'updated'
          ? 'Changed what this form is joined to.'
          : 'They were already joined like this.';
      const doorCopy = door.operation_ids.length === 0
        ? ' The form is live. It does nothing on its own.'
        : ` The form is live and may: ${door.operation_ids.join(', ')}.`;
      state = { ...state, pendingDoorConsent: null, notice: `${pairCopy}${doorCopy}`, error: null };
    } catch (error) {
      await reconcileConflict(error);
    } finally {
      finishMutation();
    }
  };

  const configureObserved = async (): Promise<void> => {
    const observed = state.pair;
    const configuration = claimConfigurationFromDraft(state.configurationDraft);
    if (
      disposed
      || state.loading
      || state.pairRefreshing
      || state.saving
      || !state.authorityCurrent
      || observed === null
      || observed.status !== 'ready'
      || observed.pair_subject !== 'form'
      || observed.claim_configuration_authoring.status !== 'editable'
    ) return;
    if (configuration === null) {
      state = {
        ...state,
        error:
          'Fill in the Connection, the https addresses, when it runs out, the template, and a Seller offer id if you want one, before you save.',
        notice: null,
      };
      render();
      return;
    }
    pairRefreshToken += 1;
    state = {
      ...state,
      saving: true,
      confirmingClear: false,
      error: null,
      notice: null,
    };
    render();
    try {
      const result = await conn('reception.intake_recipe_pair.configure', {
        endpoint_id: endpointId,
        expected_updated_at: observed.updated_at,
        expected_pair_revision: observed.binding.pair_revision,
        configuration,
      });
      if (disposed) return;
      const notice = result.outcome === 'updated'
        ? 'Payment set-up saved. Join this Recipe again to pin the new version.'
        : 'That payment set-up was already what you had.';
      try {
        const pair = await conn('reception.intake_recipe_pair.get', {
          endpoint_id: endpointId,
        });
        if (disposed) return;
        applyPair(pair);
        state = { ...state, notice };
      } catch {
        if (disposed) return;
        state = {
          ...state,
          authorityCurrent: false,
          error:
            'Recued saved it, but could not show you the new state. Refresh before you change anything else.',
          notice,
        };
      }
    } catch (error) {
      await reconcileConflict(error);
    } finally {
      finishMutation();
    }
  };

  const clearObserved = async (): Promise<void> => {
    const observed = state.pair;
    if (
      disposed
      || state.loading
      || state.pairRefreshing
      || state.saving
      || !state.authorityCurrent
      || observed === null
      || observed.status === 'unpaired'
    ) return;
    state = { ...state, saving: true, error: null, notice: null };
    pairRefreshToken += 1;
    render();
    try {
      const result = await conn('reception.intake_recipe_pair.clear', {
        endpoint_id: endpointId,
        expected_status: observed.status,
        expected_updated_at: observed.updated_at,
        expected_pair_revision: bindingOf(observed)?.pair_revision ?? null,
      });
      if (disposed) return;
      // `clear` is compare-and-delete over the exact observation above. Re-read
      // anyway so the rendered state is server authority, including the
      // idempotent `removed:false` path.
      const notice = result.removed
        ? 'They are no longer joined. This stays an ordinary form.'
        : 'They were not joined anyway.';
      try {
        const pair = await conn('reception.intake_recipe_pair.get', {
          endpoint_id: endpointId,
        });
        if (disposed) return;
        applyPair(pair);
        state = { ...state, notice };
      } catch {
        if (disposed) return;
        // The mutation itself returned successfully; do not mislabel a
        // follow-up read failure as a failed/unknown clear. Retain the old
        // observed pair rather than inventing unpaired authority, and require
        // a refresh before another decision. An own broadcast queued while
        // saving will retry this read immediately in `finishMutation`.
        state = {
          ...state,
          authorityCurrent: false,
          confirmingClear: false,
          error:
            'Recued unjoined them, but could not show you the new state. Refresh before you change anything else.',
          notice,
        };
      }
    } catch (error) {
      await reconcileConflict(error);
    } finally {
      finishMutation();
    }
  };

  const updateConfigurationDraft = (
    field: keyof ClaimConfigurationDraft,
    event: Event,
    element: HTMLElement,
  ): void => {
    if ((event.type !== 'input' && event.type !== 'change')
      || !state.authorityCurrent
      || state.saving
      || state.pair?.status !== 'ready'
      || state.pair.pair_subject !== 'form'
      || state.pair.claim_configuration_authoring.status !== 'editable') return;
    const value = (element as HTMLInputElement).value;
    if (typeof value !== 'string') return;
    state = {
      ...state,
      configurationDraft: {
        ...state.configurationDraft,
        [field]: value,
      },
      error: null,
      notice: null,
      confirmingClear: false,
    };
  };



  const handlers = {
    'reception-pair-select': (_d: DOMStringMap, event: Event, element: HTMLElement) => {
      if (event.type !== 'change' || !state.authorityCurrent) return;
      const value = (element as HTMLSelectElement).value;
      if (typeof value !== 'string') return;
      state = {
        ...state,
        selectedRecipeId: value,
        error: null,
        notice: null,
        confirmingClear: false,
      };
      render();
    },
    'reception-pair-bind': () => void bindSelected(),
    'reception-pair-config-connection': (_d: DOMStringMap, event: Event, element: HTMLElement) =>
      updateConfigurationDraft('stripeConnectionName', event, element),
    'reception-pair-config-success-url': (_d: DOMStringMap, event: Event, element: HTMLElement) =>
      updateConfigurationDraft('successUrl', event, element),
    'reception-pair-config-cancel-url': (_d: DOMStringMap, event: Event, element: HTMLElement) =>
      updateConfigurationDraft('cancelUrl', event, element),
    'reception-pair-config-expiry-seconds': (_d: DOMStringMap, event: Event, element: HTMLElement) =>
      updateConfigurationDraft('expirySeconds', event, element),
    'reception-pair-config-template-ref': (_d: DOMStringMap, event: Event, element: HTMLElement) =>
      updateConfigurationDraft('templateFileRef', event, element),
    'reception-pair-config-seller-offer-id': (
      _d: DOMStringMap,
      event: Event,
      element: HTMLElement,
    ) => updateConfigurationDraft('sellerOfferId', event, element),
    'reception-pair-config-save': () => void configureObserved(),
    'reception-pair-refresh': () => void load(),
    'reception-pair-clear-request': () => {
      if (
        !state.saving
        && !state.pairRefreshing
        && state.authorityCurrent
        && state.pair !== null
        && state.pair.status !== 'unpaired'
      ) {
        state = { ...state, confirmingClear: true, error: null, notice: null };
        render();
      }
    },
    'reception-pair-clear-confirm': () => void clearObserved(),
    'reception-pair-clear-cancel': () => {
      state = { ...state, confirmingClear: false };
      render();
    },
    // D-207 slice 1c — re-bind with consent. The server re-derives the closure from the
    // saved recipe; this flag only tells it the owner has SEEN the list.
    'reception-pair-consent-confirm': () => void bindSelected(true, state.standingClosure),
    'reception-pair-consent-standing': (_d: DOMStringMap, event: Event) => {
      const checked = (event.target as HTMLInputElement | null)?.checked === true;
      state = { ...state, standingClosure: checked };
      render();
    },
    'reception-pair-consent-cancel': () => {
      // The pair stays saved and the door stays SHUT. That is a coherent state, not a
      // half-finished one: the form denies every submission until a door is minted.
      state = {
        ...state,
        pendingDoorConsent: null,
        standingClosure: false,
        notice: 'Not allowed yet. This form is joined to a Recipe, but nothing runs until you allow it.',
      };
      render();
    },
  } satisfies Record<PairSectionAction, (
    dataset: DOMStringMap,
    event: Event,
    element: HTMLElement,
  ) => void>;

  const detachDispatcher = createActionDispatcher<PairSectionAction>({
    root: host,
    handlers,
    events: ['click', 'change', 'input'],
    shouldDispatch: (target, event) => {
      const action = target.dataset.action as PairSectionAction | undefined;
      if (action === undefined) return false;
      if (PAIR_SECTION_CHANGE_ACTIONS.has(action)) return event.type === 'change';
      if (PAIR_SECTION_CONFIG_INPUT_ACTIONS.has(action)) {
        return event.type === 'input' || event.type === 'change';
      }
      return event.type === 'click';
    },
  });
  const unsubscribe = opts.subscribe?.(
    'reception.endpoint_changed',
    (event): void => {
      if (event.endpoint_id !== endpointId) return;
      if (state.saving) {
        pendingPairRefresh = true;
        return;
      }
      void refreshPair();
    },
  ) ?? (() => {});

  render();
  void load();

  return {
    update: () => void load(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      loadToken += 1;
      pairRefreshToken += 1;
      unsubscribe();
      detachDispatcher();
      host.innerHTML = '';
    },
  };
};

export const RECEPTION_INTAKE_RECIPE_PAIR_SECTION_STYLES = `
.reception-intake-recipe-pair-section {
  max-width: 820px;
  margin: 0 auto;
}
.reception-pair-head {
  display: flex;
  align-items: flex-start;
  gap: 18px;
}
.reception-pair-back {
  color: var(--accent);
  font-size: 13px;
  font-weight: 650;
  text-decoration: none;
  white-space: nowrap;
}
.reception-pair-title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.reception-pair-title {
  margin: 0;
  color: var(--fg);
  font-size: 22px;
}
.reception-pair-endpoint,
.reception-pair-copy,
.reception-pair-feedback,
.reception-pair-help {
  margin: 6px 0 0;
  color: var(--muted);
  line-height: 1.55;
}
.reception-pair-label {
  display: block;
  margin: 14px 0 6px;
  color: var(--fg);
  font-size: 12px;
  font-weight: 700;
}
.reception-pair-select {
  width: 100%;
  min-height: 38px;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg);
  color: var(--fg);
}
.reception-pair-config-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 12px;
}
.reception-pair-config-wide { grid-column: 1 / -1; }
.reception-pair-input {
  display: block;
  width: 100%;
  min-height: 38px;
  box-sizing: border-box;
  margin-top: 6px;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg);
  color: var(--fg);
}
.reception-pair-input:disabled { opacity: .62; }
.reception-pair-help { font-size: 12px; }
.reception-pair-readiness {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.reception-pair-blockers {
  margin: 8px 0 0;
  padding-left: 20px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}
.reception-pair-binding {
  display: grid;
  gap: 6px;
  margin: 12px 0 0;
}
.reception-pair-binding > div {
  display: grid;
  grid-template-columns: minmax(90px, 120px) minmax(0, 1fr);
  gap: 10px;
}
.reception-pair-binding dt {
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
}
.reception-pair-binding dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}
.reception-intake-recipe-pair-section .rx-action-bar { margin-top: 14px; }
/* D-207 slice 1c — the door consent block. Carries the one accent the surface allows: this
   is the moment authority is handed to the anonymous public, and it should not read like
   another form row. */
.reception-door-consent {
  margin-top: 14px;
  padding: 12px 14px;
  border: 1px solid var(--rx-accent, #b58900);
  border-radius: 8px;
  background: var(--rx-surface-raised, rgba(181, 137, 0, 0.06));
}
.reception-door-consent-lede {
  margin: 0 0 8px;
  font-weight: 600;
}
.reception-door-consent-ops {
  margin: 0 0 8px;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.reception-door-consent-ops code { word-break: break-all; }
@media (max-width: 640px) {
  .reception-pair-head { flex-direction: column; gap: 10px; }
  .reception-pair-binding > div { grid-template-columns: 1fr; gap: 2px; }
  .reception-pair-config-grid { grid-template-columns: 1fr; }
  .reception-pair-config-wide { grid-column: auto; }
}
`;
