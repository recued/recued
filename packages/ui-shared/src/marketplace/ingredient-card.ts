/** D-174 P7 - marketplace ingredient current-model renderer.
 *
 *  Pure render for public marketplace ingredient cards/details. Hosts pass
 *  published listing metadata plus the manifest; this module surfaces the
 *  current grant model (kind, operations, operation groups, approval intent,
 *  reversibility, catalog governance) while tolerating legacy partial
 *  manifests from older marketplace rows.
 */

import type {
  CatalogKind,
  IngredientKind,
  IngredientManifest,
  OperationApproval,
  OperationGroupSpec,
  OperationRiskTier,
  OperationSpec,
} from '@recued/contracts';
import { isRiskTier, riskTierLabel } from '@recued/contracts';
import { e } from '../template.js';

export const MARKETPLACE_INGREDIENT_KIND_FILTERS = [
  'http',
  'dom',
  'ai',
  'chat',
  'mcp',
  'service',
  'storage',
  'connection',
  'cli',
] as const satisfies readonly IngredientKind[];

export type MarketplaceIngredientKindFilter =
  (typeof MARKETPLACE_INGREDIENT_KIND_FILTERS)[number];

export interface MarketplaceIngredientRenderState {
  slug: string;
  publisher_id: string;
  publisher_certified?: boolean;
  name?: string;
  description?: string;
  tags?: readonly string[];
  manifest?: Partial<IngredientManifest> & Record<string, unknown>;
  /** Pre-rendered host-owned badge, e.g. execution-scope. Kept as HTML
   *  because the host owns scope derivation and CSS classes. */
  scope_badge_html?: string;
  install_href?: string;
}

interface OperationEntry {
  key: string;
  spec: Partial<OperationSpec> & Record<string, unknown>;
}

interface OperationGroupEntry {
  key: string;
  spec: Partial<OperationGroupSpec> & Record<string, unknown>;
}

const KIND_LABEL: Record<IngredientKind, string> = {
  http: 'HTTP',
  dom: 'DOM',
  ai: 'AI',
  chat: 'Chat',
  mcp: 'MCP',
  service: 'Service',
  storage: 'Storage',
  connection: 'Connection',
  cli: 'CLI',
};


const APPROVAL_LABEL: Record<OperationApproval, string> = {
  never: 'Runs without approval',
  ask: 'Pauses for approval card',
  always: 'Always pauses for approval card',
};

const CATALOG_LABEL: Record<CatalogKind, string> = {
  official: 'Official catalog',
  unofficial_acknowledged: 'Unofficial catalog',
  private_byo: 'Private BYO catalog',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined;

const isIngredientKind = (value: unknown): value is IngredientKind =>
  typeof value === 'string'
  && (MARKETPLACE_INGREDIENT_KIND_FILTERS as readonly string[]).includes(value);

export const marketplaceIngredientKind = (
  state: Pick<MarketplaceIngredientRenderState, 'manifest'>,
): IngredientKind | null => {
  const kind = state.manifest?.kind;
  return isIngredientKind(kind) ? kind : null;
};

export const marketplaceIngredientKindLabel = (
  kind: IngredientKind | null | undefined,
): string => kind ? KIND_LABEL[kind] : 'Legacy';

const riskLabel = (risk: unknown): string =>
  isRiskTier(risk) ? riskTierLabel(risk) : 'Risk uses catalog default';

const approvalLabel = (approval: unknown): string =>
  typeof approval === 'string' && approval in APPROVAL_LABEL
    ? APPROVAL_LABEL[approval as OperationApproval]
    : 'Approval uses catalog default';

const catalogLabel = (catalog: unknown): string | null =>
  typeof catalog === 'string' && catalog in CATALOG_LABEL
    ? CATALOG_LABEL[catalog as CatalogKind]
    : null;

const normalizeOperations = (
  manifest: MarketplaceIngredientRenderState['manifest'],
): OperationEntry[] => {
  const raw = manifest?.operations;
  if (!isRecord(raw)) return [];
  return Object.entries(raw)
    .filter(([, value]) => isRecord(value))
    .map(([key, value]) => ({
      key,
      spec: value as Partial<OperationSpec> & Record<string, unknown>,
    }));
};

const normalizeOperationGroups = (
  manifest: MarketplaceIngredientRenderState['manifest'],
): OperationGroupEntry[] => {
  const raw = manifest?.operation_groups;
  if (Array.isArray(raw)) {
    return raw
      .filter(isRecord)
      .map((value, idx) => {
        const groupId = asString(value.group_id) ?? `group-${idx + 1}`;
        return {
          key: groupId,
          spec: value as Partial<OperationGroupSpec> & Record<string, unknown>,
        };
      });
  }
  if (!isRecord(raw)) return [];
  return Object.entries(raw)
    .filter(([, value]) => isRecord(value))
    .map(([key, value]) => ({
      key,
      spec: value as Partial<OperationGroupSpec> & Record<string, unknown>,
    }));
};

const operationDisplayName = (entry: OperationEntry): string =>
  asString(entry.spec.operation_id) ?? entry.key;

const renderCertifiedPill = (certified: boolean | undefined): string =>
  certified
    ? '<span class="mp-certified-pill" title="Certified author">Certified</span>'
    : '';

const renderKindTag = (kind: IngredientKind | null): string =>
  `<span class="mp-tag" data-ingredient-kind="${e(kind ?? 'legacy')}">kind: ${e(marketplaceIngredientKindLabel(kind))}</span>`;

const renderGovernanceTags = (
  state: MarketplaceIngredientRenderState,
  kind: IngredientKind | null,
): string => {
  const manifest = state.manifest;
  const catalog = catalogLabel(manifest?.catalog_kind);
  const cancellation = asString(manifest?.cancellation_partner);
  const operations = normalizeOperations(manifest);
  return `
    <div class="mp-card-tags">
      ${renderKindTag(kind)}
      ${catalog ? `<span class="mp-tag">${e(catalog)}</span>` : ''}
      ${operations.length > 0 ? `<span class="mp-tag">${operations.length} operation${operations.length === 1 ? '' : 's'}</span>` : ''}
      ${cancellation ? '<span class="mp-tag">reversible</span>' : ''}
    </div>
  `;
};

const renderGrantSummary = (
  manifest: MarketplaceIngredientRenderState['manifest'],
): string => {
  const operations = normalizeOperations(manifest);
  if (operations.length === 0) {
    const risk = asString(manifest?.risk_tier);
    return `
      <div class="mp-card-tags" aria-label="Grant summary">
        ${risk ? `<span class="mp-tag">${e(riskLabel(risk))}</span>` : ''}
        <span class="mp-tag">legacy manifest</span>
      </div>
    `;
  }
  const highest = [...operations].sort((a, b) =>
    riskRank(b.spec.risk_tier) - riskRank(a.spec.risk_tier),
  )[0];
  const pauses = operations.filter((op) => op.spec.approval === 'ask' || op.spec.approval === 'always').length;
  return `
    <div class="mp-card-tags" aria-label="Grant summary">
      <span class="mp-tag">highest: ${e(riskLabel(highest?.spec.risk_tier))}</span>
      <span class="mp-tag">${pauses} approval pause${pauses === 1 ? '' : 's'}</span>
    </div>
  `;
};

const riskRank = (risk: unknown): number => {
  switch (risk) {
    case 'read': return 1;
    case 'write': return 2;
    case 'admin': return 3;
    case 'destructive': return 4;
    default: return 0;
  }
};

const renderOperationList = (
  manifest: MarketplaceIngredientRenderState['manifest'],
): string => {
  const operations = normalizeOperations(manifest);
  if (operations.length === 0) {
    return `
      <div class="mp-detail-section">
        <h3>Operations you grant</h3>
        <p class="mp-card-desc">This legacy manifest does not declare catalog operations. Installs fall back to the ingredient-level kind and risk declaration.</p>
      </div>
    `;
  }
  return `
    <div class="mp-detail-section">
      <h3>Operations you grant (${operations.length})</h3>
      <div class="dep-list">
        ${operations.map((entry) => `
          <div class="dep-item" data-operation-key="${e(entry.key)}">
            <span class="viz-type-badge">${e(riskLabel(entry.spec.risk_tier))}</span>
            <span>${e(operationDisplayName(entry))}</span>
            <span class="viz-type-badge">${e(approvalLabel(entry.spec.approval))}</span>
            ${asString(entry.spec.description) ? `<span class="mp-card-desc">${e(asString(entry.spec.description) ?? '')}</span>` : ''}
          </div>
        `).join('')}
      </div>
    </div>
  `;
};

const renderOperationGroups = (
  manifest: MarketplaceIngredientRenderState['manifest'],
): string => {
  const groups = normalizeOperationGroups(manifest);
  if (groups.length === 0) return '';
  return `
    <div class="mp-detail-section">
      <h3>Operation groups (${groups.length})</h3>
      <div class="dep-list">
        ${groups.map((entry) => {
          const name = asString(entry.spec.display_name) ?? asString(entry.spec.group_id) ?? entry.key;
          const ops = Array.isArray(entry.spec.operations) ? entry.spec.operations.length : 0;
          const grant = asString(entry.spec.grant_default) ?? 'off';
          const upgrade = asString(entry.spec.upgrade_behavior) ?? 'new_operations_off';
          return `
            <div class="dep-item" data-operation-group="${e(entry.key)}">
              <span class="viz-type-badge">${e(riskLabel(entry.spec.risk_floor))}</span>
              <span>${e(name)}</span>
              <span class="viz-type-badge">${ops} op${ops === 1 ? '' : 's'}</span>
              <span class="viz-type-badge">grant: ${e(grant)}</span>
              <span class="viz-type-badge">upgrade: ${e(upgrade)}</span>
              ${asString(entry.spec.description) ? `<span class="mp-card-desc">${e(asString(entry.spec.description) ?? '')}</span>` : ''}
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
};

const renderReversibility = (
  manifest: MarketplaceIngredientRenderState['manifest'],
): string => {
  const partner = asString(manifest?.cancellation_partner);
  return `
    <div class="mp-detail-section">
      <h3>Reversibility</h3>
      <div class="mp-card-tags">
        ${partner
          ? `<span class="mp-tag">Cancellation partner: ${e(partner)}</span>`
          : '<span class="mp-tag">No cancellation partner declared</span>'}
      </div>
    </div>
  `;
};

const renderInstall = (state: MarketplaceIngredientRenderState): string => {
  const href = state.install_href
    ?? `chrome-extension://recued/install.html?ingredient=${encodeURIComponent(state.slug)}`;
  return `
    <div class="mp-detail-section">
      <h3>Install</h3>
      <div class="mp-card-actions">
        <a href="${e(href)}" class="mp-install-btn" title="Opens the Recued extension install page">Install in Recued</a>
        <button class="mp-copy-btn" data-action="copy" data-value="${e(state.slug)}" title="Copy ingredient slug">Copy slug</button>
      </div>
      <p class="mp-card-desc">Review the operation grants above before installing this ingredient.</p>
    </div>
  `;
};

const displayName = (state: MarketplaceIngredientRenderState): string =>
  state.name ?? asString(state.manifest?.name) ?? state.slug;

const displayDescription = (state: MarketplaceIngredientRenderState): string =>
  state.description ?? asString(state.manifest?.description) ?? '';

export const renderMarketplaceIngredientCard = (
  state: MarketplaceIngredientRenderState,
): string => {
  const kind = marketplaceIngredientKind(state);
  return `
    <article class="mp-card" data-ingredient-slug="${e(state.slug)}" data-ingredient-kind="${e(kind ?? 'legacy')}">
      <a href="/marketplace/ingredients/${e(state.slug)}" class="mp-card-name">${e(displayName(state))}</a>
      <p class="mp-card-desc">${e(displayDescription(state))}</p>
      ${renderGovernanceTags(state, kind)}
      ${renderGrantSummary(state.manifest)}
      <div class="mp-card-meta">
        <span>by ${e(state.publisher_id)}${renderCertifiedPill(state.publisher_certified)}</span>
        ${state.scope_badge_html ?? ''}
      </div>
      <div class="mp-card-actions">
        <a href="/marketplace/ingredients/${e(state.slug)}" class="mp-install-btn">Review grants &rarr;</a>
      </div>
    </article>
  `;
};

export const renderMarketplaceIngredientDetail = (
  state: MarketplaceIngredientRenderState,
): string => {
  const kind = marketplaceIngredientKind(state);
  const catalog = catalogLabel(state.manifest?.catalog_kind);
  return `
    <section class="mp-detail" data-ingredient-slug="${e(state.slug)}" data-ingredient-kind="${e(kind ?? 'legacy')}">
      <div class="mp-detail-header">
        <h2>${e(displayName(state))}</h2>
        <div class="mp-detail-meta">
          <span>by <strong>${e(state.publisher_id)}</strong>${renderCertifiedPill(state.publisher_certified)}</span>
          ${renderKindTag(kind)}
          ${catalog ? `<span class="mp-tag">${e(catalog)}</span>` : ''}
          ${state.scope_badge_html ?? ''}
        </div>
      </div>
      ${displayDescription(state) ? `<p class="mp-detail-desc">${e(displayDescription(state))}</p>` : ''}

      ${renderOperationList(state.manifest)}
      ${renderOperationGroups(state.manifest)}
      ${renderReversibility(state.manifest)}
      ${renderInstall(state)}

      <div class="mp-detail-section">
        <h3>Slug</h3>
        <div class="mp-json-url">${e(state.slug)}</div>
      </div>
    </section>
  `;
};
