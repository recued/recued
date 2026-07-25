/** D-122 Phase 4 — bulk-install pack confirmation dialog.
 *
 *  Renders the consent surface every bulk-install path goes through
 *  before the engine's atomic transaction starts. The host (extension
 *  sidebar / webapp install flow) calls `renderBulkPackDialog` with a
 *  fully-resolved `BulkPackDialogState` and wires the action buttons
 *  (`install-pack`, `cancel-pack`).
 *
 *  Pure render module — no IO, no rpc. Pre-install resolution + cost
 *  estimation happen upstream so this file is just shape → HTML.
 */

import {
  type BulkPackManifest,
  type BulkPackRecipeRef,
  type ConnectionKind,
  type PackContentRef,
} from '@recued/contracts';
import { e } from '../template.js';

/** UX-review flow-10 — a connection a pack's recipes need, for the
 *  pre-install disclosure. `kind` is null when only a `read_connection_*`
 *  permission (no `connection.<kind>.<name>` ref) declared it. */
export interface BulkPackConnectionNeed {
  kind: ConnectionKind | null;
  name: string;
}

/** D-179 P5b — a registered file slug a pack's recipes need, for the
 *  pre-install disclosure. `slug` is the pinned literal when a
 *  `file-*` step names one inline; `variable`/`label` describe a
 *  `type:'file_slug'` variable the user fills at config time. */
export interface BulkPackFileSlugNeed {
  slug: string | null;
  variable: string | null;
  label: string | null;
}

/** Per-recipe cost line the dialog renders under "Cost & usage". */
export interface BulkPackRecipeCost {
  slug: string;
  /** Recipe display name (manifest metadata.name). */
  name: string;
  /** Estimated daily fire count. */
  daily_fires: number;
  /** Estimated daily token spend (`daily_fires × per_fire_tokens`). */
  daily_tokens: number;
}

/** Resolved entry the host hands the dialog. Only what's surfaced in
 *  the recipes list — full `RecipeDefinition` lives upstream. */
export interface BulkPackDialogRecipe {
  ref: BulkPackRecipeRef;
  /** Human-readable name. From the marketplace listing's metadata.name. */
  name: string;
  /** Optional one-line description. */
  description?: string;
  /** True when the resolver flagged this recipe (404 / version drift
   *  / fetch error). The dialog renders failed entries struck-through
   *  with a per-row reason and the install button stays disabled. */
  failure?: 'not_found' | 'version_drift' | 'fetch_error';
  /** Reason text the host can pass through (e.g., resolver's error
   *  message). */
  failure_message?: string;
}

/** Permission disclosure entry — one bullet per requested permission. */
export interface BulkPackPermission {
  slug: string;
  /** User-facing summary. */
  description: string;
  /** True when this permission is the pack-install permission itself
   *  (always required, rendered first). */
  required: boolean;
}

export interface BulkPackDialogState {
  manifest: BulkPackManifest;
  recipes: BulkPackDialogRecipe[];
  /** Aggregate-style summary the dialog quotes verbatim (e.g.
   *  "Send a notification before each upcoming meeting"). The host
   *  composes this from the manifest + cost estimator; the dialog
   *  renders as a bulleted "This pack will…" block. */
  pack_will: string[];
  /** Per-recipe cost rows under "Cost & usage". */
  recipe_costs: BulkPackRecipeCost[];
  /** Daily free-pool throughput summary line (e.g.,
   *  "~50 fires/day, free pool covers comfortably"). Empty string
   *  suppresses the line. */
  free_pool_summary?: string;
  /** Optional BYOK estimate line ("If you bring your own API key:
   *  ~$0.30/day"). Renders informationally; no toggle. */
  byok_dollars_per_day?: number;
  /** Permissions the manifest requested. The pack-install permission
   *  surfaces first; per-recipe permissions follow. */
  permissions: BulkPackPermission[];
  /** D-165 app-pack v2 — the manifest's NON-recipe contents (catalog
   *  ingredients, operation-group grants, channel bindings, policies).
   *  The host filters `normalizeBulkPackInstallPlan(manifest).contents`
   *  to `type !== 'recipe'` and passes them here; the dialog renders an
   *  "App capabilities" consent-disclosure section (spec § Install
   *  consent disclosure shape). Omitted / empty for v1 recipe-only packs
   *  → the section is suppressed. Disclosure only — actual provisioning
   *  (connection binding, pack-owned grants, channel registration) is the
   *  P3 install planner. */
  app_contents?: PackContentRef[];
  /** UX-review flow-10 — the outbound connections the pack's recipes
   *  need, aggregated + deduped across recipes. Rendered as a pre-install
   *  "Connections needed" disclosure so the requirement is visible BEFORE
   *  Install (the actionable enroll status + CTA show per-recipe in
   *  #recipes after install). Omitted / empty → the section is suppressed. */
  required_connections?: ReadonlyArray<BulkPackConnectionNeed>;
  /** D-179 P5b — registered file slug(s) the pack's recipes need (the
   *  queue-sweeper drop dir), aggregated + deduped across recipes.
   *  Rendered as a pre-install "File access needed" disclosure
   *  prompting registration (Connections → Files). Omitted / empty → the
   *  section is suppressed. */
  required_file_slugs?: ReadonlyArray<BulkPackFileSlugNeed>;
  /** True when the resolver returned ready=true AND every recipe
   *  passed validation. The install button gates on this. */
  install_enabled: boolean;
  /** Optional alert above the buttons (e.g., "Pack manifest is older
   *  than this runtime supports — update the pack"). */
  blocking_message?: string;
}

const renderRecipeRow = (entry: BulkPackDialogRecipe): string => {
  const failed = entry.failure != null;
  const klass = `bulk-pack-recipe ${failed ? 'bulk-pack-recipe--failed' : ''}`.trim();
  const reason = failed
    ? `<span class="bulk-pack-recipe-reason">${e(entry.failure_message ?? entry.failure ?? '')}</span>`
    : '';
  return `
    <li class="${klass}" data-slug="${e(entry.ref.slug)}">
      <span class="bulk-pack-recipe-name">${e(entry.name)}</span>
      <span class="bulk-pack-recipe-version">v${entry.ref.version}</span>
      ${entry.description ? `<span class="bulk-pack-recipe-desc">${e(entry.description)}</span>` : ''}
      ${reason}
    </li>
  `;
};

const renderRecipeCostLine = (cost: BulkPackRecipeCost): string => {
  return `
    <li class="bulk-pack-cost" data-slug="${e(cost.slug)}">
      <span class="bulk-pack-cost-name">${e(cost.name)}</span>
      <span class="bulk-pack-cost-detail">~${cost.daily_fires.toLocaleString()} fires/day · ~${cost.daily_tokens.toLocaleString()} tokens/day</span>
    </li>
  `;
};

const renderPermissionRow = (perm: BulkPackPermission): string => {
  const klass = `bulk-pack-permission ${perm.required ? 'bulk-pack-permission--required' : ''}`.trim();
  return `
    <li class="${klass}">
      <code class="bulk-pack-permission-slug">${e(perm.slug)}</code>
      <span class="bulk-pack-permission-desc">${e(perm.description)}</span>
      ${perm.required ? `<span class="bulk-pack-permission-tag">required</span>` : ''}
    </li>
  `;
};

/** D-165 — one "App capabilities" disclosure row per non-recipe content.
 *  Each kind renders a short tag + a plain-language label (spec wants
 *  capability bullets, not endpoint sprawl). A `recipe` entry would be
 *  rendered in the Recipes section, so it's skipped here defensively. */
const renderAppContentRow = (c: PackContentRef): string => {
  let kind = '';
  let label = '';
  switch (c.type) {
    case 'recipe':
      return '';
    case 'ingredient': {
      kind = 'Catalog';
      const id = c.ingredient_id ?? c.slug ?? '(unnamed ingredient)';
      const version = c.ingredient_version ?? c.version;
      label = version != null ? `${id} v${version}` : id;
      if (c.role) label += ` · ${c.role.replace(/_/g, ' ')}`;
      break;
    }
    case 'operation_group':
      kind = 'Operations';
      label = `${c.group_id} on ${c.ingredient_id}`;
      break;
    case 'channel_binding':
      kind = 'Channel';
      label = `${c.channel_name} (${c.capability}) — backed by ${c.bound_to_catalog}`;
      break;
    case 'policy':
      kind = 'Policy';
      label = c.policy_id;
      break;
  }
  return `
    <li class="bulk-pack-capability" data-kind="${e(c.type)}">
      <span class="bulk-pack-capability-kind">${e(kind)}</span>
      <span class="bulk-pack-capability-label">${e(label)}</span>
    </li>
  `;
};

/** UX-review flow-10 — one row per connection the pack's recipes need. */
const renderConnectionNeedRow = (need: BulkPackConnectionNeed): string => {
  const label = need.kind !== null ? `${need.name} (${need.kind})` : need.name;
  return `<li class="bulk-pack-connection" data-name="${e(need.name)}">${e(label)}</li>`;
};

const renderFileSlugNeedRow = (need: BulkPackFileSlugNeed): string => {
  const label = need.slug !== null
    ? need.slug
    : (need.label ?? need.variable ?? 'a registered directory');
  const attr = need.slug ?? need.variable ?? '';
  return `<li class="bulk-pack-file-slug" data-name="${e(attr)}">${e(label)}</li>`;
};

const renderByokLine = (state: BulkPackDialogState): string => {
  if (state.byok_dollars_per_day == null) return '';
  const dollars = state.byok_dollars_per_day.toFixed(2);
  return `
    <p class="bulk-pack-byok">
      If you bring your own API key: ~$${e(dollars)}/day
    </p>
  `;
};

const renderActions = (state: BulkPackDialogState): string => {
  const disabled = state.install_enabled ? '' : 'disabled';
  return `
    <div class="bulk-pack-actions">
      <button type="button" class="bulk-pack-btn bulk-pack-btn--cancel"
        data-action="cancel-pack">
        Cancel
      </button>
      <button type="button" class="bulk-pack-btn bulk-pack-btn--primary"
        data-action="install-pack"
        ${disabled}>
        Install
      </button>
    </div>
  `;
};

/** Render the dialog. Returns an HTML string the host injects into
 *  whichever modal/route surface is live. The classes mirror the
 *  account-devices-page convention so styles share a stylesheet. */
export const renderBulkPackDialog = (state: BulkPackDialogState): string => {
  const m = state.manifest;
  const willList = state.pack_will.length === 0
    ? ''
    : `
      <ul class="bulk-pack-will">
        ${state.pack_will.map((line) => `<li>${e(line)}</li>`).join('')}
      </ul>
    `;
  const costList = state.recipe_costs.map(renderRecipeCostLine).join('');
  const recipeList = state.recipes.map(renderRecipeRow).join('');
  const permissionList = state.permissions.map(renderPermissionRow).join('');
  // D-165 app-pack v2 — non-recipe capability disclosure. Suppressed for
  // v1 recipe-only packs (no `app_contents` → empty section string).
  const appContents = state.app_contents ?? [];
  const appCapabilitySection = appContents.length === 0
    ? ''
    : `
        <div class="bulk-pack-section">
          <h3>App capabilities</h3>
          <p class="bulk-pack-capabilities-note">Capabilities included with this app.</p>
          <ul class="bulk-pack-capabilities">${appContents.map(renderAppContentRow).join('')}</ul>
        </div>
      `;
  const capabilityMeta = appContents.length === 0
    ? ''
    : ` · ${appContents.length} ${appContents.length === 1 ? 'capability' : 'capabilities'}`;
  // UX-review flow-10 — disclose outbound connections the pack's recipes need
  // BEFORE install (per-recipe enroll status + CTA appear in #recipes after
  // install). Suppressed when the pack needs none.
  const connectionNeeds = state.required_connections ?? [];
  const connectionsSection = connectionNeeds.length === 0
    ? ''
    : `
        <div class="bulk-pack-section">
          <h3>Connections needed</h3>
          <p class="bulk-pack-connections-note">These recipes use outbound connections. Set them up in Connections — recipes still missing one say so after install.</p>
          <ul class="bulk-pack-connections">${connectionNeeds.map(renderConnectionNeedRow).join('')}</ul>
        </div>
      `;
  // D-179 P5b — prompt file-slug registration BEFORE install (the
  // queue-sweeper drop dir). Same disclosure posture as connections.
  const fileSlugNeeds = state.required_file_slugs ?? [];
  const fileSlugsSection = fileSlugNeeds.length === 0
    ? ''
    : `
        <div class="bulk-pack-section">
          <h3>File access needed</h3>
          <p class="bulk-pack-file-slugs-note">These recipes read or write a registered file collection. Register it under Connections &rarr; Files, then pick its slug in the recipe settings after install.</p>
          <ul class="bulk-pack-file-slugs">${fileSlugNeeds.map(renderFileSlugNeedRow).join('')}</ul>
        </div>
      `;
  const blocking = state.blocking_message
    ? `<div class="bulk-pack-blocking" role="alert">${e(state.blocking_message)}</div>`
    : '';
  const freePoolSummary = state.free_pool_summary
    ? `<p class="bulk-pack-free-pool">${e(state.free_pool_summary)}</p>`
    : '';

  return `
    <section class="bulk-pack-dialog" data-pack-slug="${e(m.slug)}">
      <header class="bulk-pack-header">
        <h2 class="bulk-pack-name">${e(m.name)}</h2>
        <p class="bulk-pack-meta">
          ${m.recipes.length} recipe${m.recipes.length === 1 ? '' : 's'}${capabilityMeta} —
          ${e(m.publisher)}
        </p>
        <p class="bulk-pack-description">${e(m.description)}</p>
        ${m.repo && m.repo.startsWith('https://')
          ? `<p class="bulk-pack-support"><a class="bulk-pack-support-link" href="${e(m.repo)}" target="_blank" rel="noopener noreferrer">Issues &amp; support</a></p>`
          : ''}
      </header>

      <div class="bulk-pack-body">
        ${blocking}

        <div class="bulk-pack-section">
          <h3>This pack will</h3>
          ${willList}
        </div>

        <div class="bulk-pack-section">
          <h3>Cost &amp; usage</h3>
          ${freePoolSummary}
          <ul class="bulk-pack-costs">${costList}</ul>
          ${renderByokLine(state)}
        </div>

        <div class="bulk-pack-section">
          <h3>Recipes</h3>
          <ul class="bulk-pack-recipes">${recipeList}</ul>
        </div>
        ${appCapabilitySection}
        ${connectionsSection}
        ${fileSlugsSection}
        <div class="bulk-pack-section">
          <h3>Permissions requested</h3>
          <ul class="bulk-pack-permissions">${permissionList}</ul>
        </div>

        <p class="bulk-pack-provenance">
          Provenance: every annotation links back to the source record
          (Memory tab shows the full why-trail).
        </p>
      </div>

      ${renderActions(state)}
    </section>
  `;
};
