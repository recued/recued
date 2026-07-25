/** D-122 Phase 6 — marketplace recipe card.
 *
 *  Renders one recipe entry inside marketplace search results / pack
 *  pages. The card surfaces the trigger shape (alert / reactive / url /
 *  manual) as a coloured badge; alert recipes additionally
 *  expose the notification channels they fan out to and the enrichment
 *  topics they consume; recipes that ship inside a published pack get a
 *  pack-membership chip linking to `/pack/<slug>`.
 *
 *  The card itself is pure shape → HTML. Hosts compute the trigger kind +
 *  channel list + consumed-enrichments list upstream (the recipe-shape
 *  inspector lives in @recued/recipes) and pass the result in. Mirrors
 *  the bulk-pack-dialog convention where derivation is the host's job.
 */

import { e } from '../template.js';

/** Coarse-grained trigger classification. Hosts derive from the
 *  RecipeDefinition body and pass in the resulting tag. */
export type RecipeCardTriggerKind =
  | 'alert'
  | 'reactive'
  | 'url'
  | 'manual';

/** Pack the recipe ships inside, when the marketplace returned the
 *  recipe via a pack-membership index. The badge links to the pack
 *  detail page. */
export interface RecipeCardPackMembership {
  slug: string;
  name: string;
}

/** Inputs for one card. The host populates the derived fields
 *  (`trigger_kind`, `notification_channels`, `consumed_enrichments`) by
 *  inspecting the RecipeDefinition body upstream. */
export interface RecipeCardState {
  recipe_id: string;
  publisher_id: string;
  name: string;
  description: string;
  version: number;
  author: string;
  tags: readonly string[];
  /** Coarse-grained trigger classification — drives the badge label
   *  + colour. */
  trigger_kind: RecipeCardTriggerKind;
  /** Channels this recipe routes notifications through (slack, email,
   *  telegram, in-app, …). Rendered as small pills under the badge for
   *  alert recipes; ignored for non-alert kinds. */
  notification_channels?: readonly string[];
  /** Enrichment topics this recipe reads (`calendar_event_rollup`,
   *  `meeting_reschedule_pattern`, …). Rendered as small pills under
   *  the badge for alert + reactive recipes. */
  consumed_enrichments?: readonly string[];
  /** When set, renders the pack-membership chip linking to
   *  `/pack/<slug>`. */
  pack_membership?: RecipeCardPackMembership;
  /** True when the user already has this recipe installed. Renders
   *  "Installed" instead of the install button. */
  installed?: boolean;
  /** v3 — the author's source repo URL (https, from
   *  `metadata.repo`). Renders an "Issues & support" footer link;
   *  the marketplace hosts no comment / issue tracking. */
  repo?: string;
}

/** Coarse mapping for badge label + class suffix. */
const TRIGGER_BADGE: Record<RecipeCardTriggerKind, { label: string; modifier: string }> = {
  alert:    { label: 'Alert',    modifier: 'alert' },
  reactive: { label: 'Reactive', modifier: 'reactive' },
  url:      { label: 'On page',  modifier: 'url' },
  manual:   { label: 'Manual',   modifier: 'manual' },
};

const renderTriggerBadge = (kind: RecipeCardTriggerKind): string => {
  const { label, modifier } = TRIGGER_BADGE[kind];
  return `<span class="recipe-card-badge recipe-card-badge--${modifier}" data-kind="${e(kind)}">${e(label)}</span>`;
};

const renderPackBadge = (pack: RecipeCardPackMembership): string =>
  `<a class="recipe-card-pack" data-route="/pack/${e(pack.slug)}" href="/pack/${e(pack.slug)}" data-pack-slug="${e(pack.slug)}">in ${e(pack.name)}</a>`;

const renderPills = (
  values: readonly string[] | undefined,
  klass: string,
  prefix: string,
): string => {
  if (!values || values.length === 0) return '';
  const items = values.map((v) => `<span class="${klass}">${e(prefix)}${e(v)}</span>`).join('');
  return `<div class="recipe-card-pills">${items}</div>`;
};

const renderTags = (tags: readonly string[]): string => {
  if (tags.length === 0) return '';
  return `
    <ul class="recipe-card-tags">
      ${tags.map((t) => `<li class="recipe-card-tag">${e(t)}</li>`).join('')}
    </ul>
  `;
};

/** v3 `repo` — "Issues & support" footer link to the author's source
 *  repo. Defensively re-checks the https scheme (the recipe validator
 *  already gates `metadata.repo`). */
const renderSupportLink = (repo: string | undefined): string => {
  if (!repo || !repo.startsWith('https://')) return '';
  return `<a class="recipe-card-support" href="${e(repo)}" target="_blank" rel="noopener noreferrer">Issues &amp; support</a>`;
};

const renderInstallControl = (state: RecipeCardState): string => {
  if (state.installed) {
    return `<span class="recipe-card-installed">Installed</span>`;
  }
  return `
    <button type="button" class="recipe-card-install"
      data-action="install-recipe"
      data-recipe-id="${e(state.recipe_id)}"
      data-publisher-id="${e(state.publisher_id)}"
      data-version="${state.version}">
      Install
    </button>
  `;
};

/** Render one marketplace recipe card. Returns an HTML string the host
 *  drops into search-results / pack-page lists. Action wiring happens
 *  via the shared event-dispatcher (`data-action="install-recipe"`). */
export const renderRecipeCard = (state: RecipeCardState): string => {
  const channelPills = state.trigger_kind === 'alert'
    ? renderPills(state.notification_channels, 'recipe-card-pill recipe-card-pill--channel', '→ ')
    : '';
  const enrichmentPills = state.trigger_kind === 'alert' || state.trigger_kind === 'reactive'
    ? renderPills(state.consumed_enrichments, 'recipe-card-pill recipe-card-pill--enrichment', 'reads ')
    : '';
  const packChip = state.pack_membership ? renderPackBadge(state.pack_membership) : '';
  return `
    <article class="recipe-card" data-recipe-id="${e(state.recipe_id)}" data-publisher-id="${e(state.publisher_id)}">
      <header class="recipe-card-header">
        <h3 class="recipe-card-name">${e(state.name)}</h3>
        <div class="recipe-card-badges">
          ${renderTriggerBadge(state.trigger_kind)}
          ${packChip}
        </div>
      </header>
      <p class="recipe-card-description">${e(state.description)}</p>
      ${channelPills}
      ${enrichmentPills}
      <footer class="recipe-card-footer">
        <span class="recipe-card-author">${e(state.author)}</span>
        <span class="recipe-card-version">v${state.version}</span>
        ${renderTags(state.tags)}
        ${renderSupportLink(state.repo)}
        ${renderInstallControl(state)}
      </footer>
    </article>
  `;
};
