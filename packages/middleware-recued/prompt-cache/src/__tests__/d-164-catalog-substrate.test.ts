import { describe, expect, it } from 'vitest';

import {
  COMMITMENT_FOLLOWTHROUGH_SCORE_DECLARATION,
  SOURCE_FRESHNESS_DEGRADATION_DECLARATION,
  TASK_DUPLICATE_CANDIDATE_DECLARATION,
  type EnrichmentDeclaration,
  type IngredientKind,
  type ToolEntry,
} from '@recued/contracts';

import {
  assembleCatalog,
  assembleEnrichmentSection,
  assembleEntityActionSection,
  assembleEntityQuerySection,
  assembleOtherSection,
} from '../catalog/index';
import {
  recipeKindsAllowed,
  tier3VendorVisible,
  vendorOfTier3Name,
} from '../catalog/filter';
import { buildEnrichmentNotFound } from '../catalog/suggest';
import type { CatalogAssemblyInput, CatalogCapabilities } from '../types';

const capabilities = (
  overrides: Partial<CatalogCapabilities> = {},
): CatalogCapabilities => ({
  connectedVendors: new Set<string>(),
  enabledKinds: new Set<IngredientKind>(),
  enabledEnrichmentTopics: new Set<string>(),
  ...overrides,
});

const catalogInput = (
  overrides: Partial<CatalogAssemblyInput> = {},
): CatalogAssemblyInput => ({
  registryTools: [],
  enrichmentDeclarations: new Map<string, EnrichmentDeclaration>(),
  enrichmentDescriptions: new Map<string, string>(),
  capabilities: capabilities(),
  ...overrides,
});

const toolEntry = (
  overrides: Pick<ToolEntry, 'name' | 'tier'> & Partial<ToolEntry>,
): ToolEntry => {
  const classification: ToolEntry['classification'] =
    overrides.classification ?? (overrides.tier === 1 ? 'read' : 'unknown');

  // Tier-derived production default for `concurrency_safe`:
  //   - Tier 1 `*.search` (classification 'read') → true (local
  //     warehouse reads, idempotent; matches TIER1_CONCURRENCY_SAFE);
  //   - Tier 1 `recipe.run` (classification 'unknown') → false (umbrella
  //     dispatcher; matches TIER1_CONCURRENCY_SAFE);
  //   - Tier 2 / Tier 3 → false (mutation recipes + external APIs
  //     default sequential).
  // Specific tests that exercise a non-default value pass an explicit
  // `concurrency_safe:` override (which the spread below preserves).
  const concurrency_safe =
    overrides.tier === 1 && classification === 'read';

  return {
    description: `${overrides.name} description`,
    arg_schema: { type: 'object', properties: {} },
    topic_tags: [],
    classification,
    concurrency_safe,
    ...overrides,
  };
};

describe('D-164 P3 catalog substrate - assembleCatalog', () => {
  it('returns exactly six empty sections in bench display order for an empty snapshot', () => {
    const catalog = assembleCatalog(catalogInput());

    expect(catalog.sections).toHaveLength(6);
    expect(catalog.sections.map((section) => section.section)).toEqual([
      'enrichment',
      'entity-query',
      'memory-recall',
      'entity-action',
      'recipes',
      'other',
    ]);
    expect(catalog.sections.map((section) => section.tools)).toEqual([
      [],
      [],
      [],
      [],
      [],
      [],
    ]);
  });

  it('partitions Tier 1 tools by closed section list and omits enrichment.search everywhere', () => {
    const registryTools = [
      toolEntry({ name: 'mail.search', tier: 1 }),
      toolEntry({ name: 'memory.search', tier: 1 }),
      toolEntry({ name: 'recipe.run', tier: 1, classification: 'unknown' }),
      toolEntry({ name: 'contact.search', tier: 1 }),
      toolEntry({ name: 'enrichment.search', tier: 1 }),
      toolEntry({ name: 'deal.search', tier: 1 }),
      toolEntry({ name: 'calendar.search', tier: 1 }),
    ];

    const catalog = assembleCatalog(catalogInput({ registryTools }));
    const toolNamesBySection = new Map(
      catalog.sections.map((section) => [
        section.section,
        section.tools.map((tool) => tool.name),
      ]),
    );

    expect(toolNamesBySection.get('entity-query')).toEqual([
      'calendar.search',
      'contact.search',
      'deal.search',
      'mail.search',
    ]);
    expect(toolNamesBySection.get('memory-recall')).toEqual(['memory.search']);
    expect(toolNamesBySection.get('recipes')).toEqual(['recipe.run']);
    expect(toolNamesBySection.get('entity-action')).toEqual([]);
    expect(toolNamesBySection.get('other')).toEqual([]);
    expect(catalog.sections.flatMap((section) => section.tools.map((tool) => tool.name)))
      .not.toContain('enrichment.search');
  });
});

describe('D-164 P3 catalog substrate - entity-action section', () => {
  it('admits non-read Tier 2 tools only when every required kind is enabled', () => {
    const section = assembleEntityActionSection(catalogInput({
      registryTools: [
        toolEntry({
          name: 'team/send-summary',
          tier: 2,
          classification: 'write',
          requires_kinds: ['storage'],
        }),
        toolEntry({
          name: 'team/http-storage-sync',
          tier: 2,
          classification: 'unknown',
          requires_kinds: ['http', 'storage'],
        }),
        toolEntry({
          name: 'team/dom-extract',
          tier: 2,
          classification: 'write',
          requires_kinds: ['dom'],
        }),
        toolEntry({
          name: 'team/read-report',
          tier: 2,
          classification: 'read',
          requires_kinds: ['storage'],
        }),
        toolEntry({
          name: 'team/no-requirements',
          tier: 2,
          classification: 'write',
        }),
        toolEntry({
          name: 'team/empty-requirements',
          tier: 2,
          classification: 'write',
          requires_kinds: [],
        }),
      ],
      capabilities: capabilities({
        enabledKinds: new Set<IngredientKind>(['http', 'storage']),
      }),
    }));

    expect(section.tools.map((tool) => ({
      name: tool.name,
      concurrency_safe: tool.concurrency_safe,
    }))).toEqual([
      { name: 'team/empty-requirements', concurrency_safe: false },
      { name: 'team/http-storage-sync', concurrency_safe: false },
      { name: 'team/no-requirements', concurrency_safe: false },
      { name: 'team/send-summary', concurrency_safe: false },
    ]);
  });

  it('recipeKindsAllowed requires a full enabled-kind subset and treats omitted or empty requirements as allowed', () => {
    const enabledKinds = new Set<IngredientKind>(['http', 'storage']);

    expect(recipeKindsAllowed(
      toolEntry({ name: 'team/storage-only', tier: 2, requires_kinds: ['storage'] }),
      enabledKinds,
    )).toBe(true);
    expect(recipeKindsAllowed(
      toolEntry({ name: 'team/http-storage', tier: 2, requires_kinds: ['http', 'storage'] }),
      enabledKinds,
    )).toBe(true);
    expect(recipeKindsAllowed(
      toolEntry({ name: 'team/storage-dom', tier: 2, requires_kinds: ['storage', 'dom'] }),
      enabledKinds,
    )).toBe(false);
    expect(recipeKindsAllowed(
      toolEntry({ name: 'team/omitted-kinds', tier: 2 }),
      enabledKinds,
    )).toBe(true);
    expect(recipeKindsAllowed(
      toolEntry({ name: 'team/empty-kinds', tier: 2, requires_kinds: [] }),
      enabledKinds,
    )).toBe(true);
  });
});

describe('D-164 P3 catalog substrate - other section', () => {
  it('parses the Tier 3 vendor as the prefix before the first dot and rejects malformed names', () => {
    expect(vendorOfTier3Name('hubspot.contact_lookup')).toBe('hubspot');
    expect(vendorOfTier3Name('acme.crm.lookup')).toBe('acme');
    expect(vendorOfTier3Name('hubspot')).toBeNull();
    expect(vendorOfTier3Name('hubspot.')).toBeNull();
    expect(vendorOfTier3Name('.contact_lookup')).toBeNull();
  });

  it('hides disconnected vendors and malformed Tier 3 names from the other section', () => {
    const connectedHubspot = capabilities({
      connectedVendors: new Set<string>(['hubspot']),
    });

    expect(tier3VendorVisible(
      toolEntry({ name: 'hubspot.contact_lookup', tier: 3 }),
      connectedHubspot,
    )).toBe(true);
    expect(tier3VendorVisible(
      toolEntry({ name: 'salesforce.contact_lookup', tier: 3 }),
      connectedHubspot,
    )).toBe(false);
    expect(tier3VendorVisible(
      toolEntry({ name: 'hubspot', tier: 3 }),
      connectedHubspot,
    )).toBe(false);
    expect(tier3VendorVisible(
      toolEntry({ name: 'hubspot.', tier: 3 }),
      connectedHubspot,
    )).toBe(false);

    const section = assembleOtherSection(catalogInput({
      registryTools: [
        toolEntry({ name: 'salesforce.contact_lookup', tier: 3 }),
        toolEntry({ name: 'hubspot', tier: 3 }),
        toolEntry({ name: 'hubspot.', tier: 3 }),
        toolEntry({ name: 'hubspot.contact_lookup', tier: 3 }),
      ],
      capabilities: connectedHubspot,
    }));

    expect(section.tools.map((tool) => ({
      name: tool.name,
      concurrency_safe: tool.concurrency_safe,
    }))).toEqual([
      { name: 'hubspot.contact_lookup', concurrency_safe: false },
    ]);
  });
});

describe('D-164 P3 catalog substrate - enrichment section', () => {
  it('filters to enabled topics, sorts by topic, and threads declaration metadata', () => {
    const commitment = COMMITMENT_FOLLOWTHROUGH_SCORE_DECLARATION;
    const sourceFreshness = SOURCE_FRESHNESS_DEGRADATION_DECLARATION;
    const taskDuplicate = TASK_DUPLICATE_CANDIDATE_DECLARATION;

    const section = assembleEnrichmentSection(catalogInput({
      enrichmentDeclarations: new Map<string, EnrichmentDeclaration>([
        [sourceFreshness.topic, sourceFreshness],
        [taskDuplicate.topic, taskDuplicate],
        [commitment.topic, commitment],
      ]),
      enrichmentDescriptions: new Map<string, string>([
        [commitment.topic, 'Followthrough score by contact.'],
      ]),
      capabilities: capabilities({
        enabledEnrichmentTopics: new Set<string>([
          sourceFreshness.topic,
          commitment.topic,
        ]),
      }),
    }));

    expect(section.tools).toEqual([
      {
        name: commitment.topic,
        description: 'Followthrough score by contact.',
        concurrency_safe: commitment.concurrency_safe,
        return_shape: commitment.return_shape,
        suggest_directive: commitment.suggest_directive,
      },
      {
        name: sourceFreshness.topic,
        description: '(no description)',
        concurrency_safe: sourceFreshness.concurrency_safe,
        return_shape: sourceFreshness.return_shape,
        suggest_directive: sourceFreshness.suggest_directive,
      },
    ]);
    expect(section.tools.map((tool) => tool.name)).not.toContain(taskDuplicate.topic);
  });
});

describe('D-164 P3 catalog substrate - buildEnrichmentNotFound', () => {
  it('returns null for declarations without a suggest_directive', () => {
    expect(buildEnrichmentNotFound(SOURCE_FRESHNESS_DEGRADATION_DECLARATION))
      .toBeNull();
  });

  it('wraps a populated suggest_directive without reshaping it', () => {
    expect(buildEnrichmentNotFound(COMMITMENT_FOLLOWTHROUGH_SCORE_DECLARATION))
      .toEqual({
        found: false,
        suggest: COMMITMENT_FOLLOWTHROUGH_SCORE_DECLARATION.suggest_directive,
      });
  });
});

// ────────────────────────────────────────────────────────────────
// D-164 § 6 — per-tier `concurrency_safe` sourcing ratchet.
//
// Pre-P5-follow-on the section assemblers applied section-level
// defaults (`entity-query` → true; `entity-action` → false; etc.).
// Post-fold the assemblers source per-entry off the registry-projected
// ToolEntry — so a fixture's `concurrency_safe` value MUST flow
// through verbatim to the catalog output. These cases guard against
// reintroducing a hard-coded section default in any of the five
// registry-sourced sections (enrichment is a separate source —
// `EnrichmentDeclaration` — and stays unchanged).
// ────────────────────────────────────────────────────────────────

describe('D-164 § 6 catalog substrate - per-tier concurrency_safe sourcing', () => {
  it('entity-query section emits each entry\'s concurrency_safe verbatim', () => {
    // Override one Tier 1 read primitive's value to false to prove the
    // assembler reads off the entry rather than baking section-level
    // `true`. The other entries keep the production-aligned tier-
    // derived default (true).
    const section = assembleEntityQuerySection(catalogInput({
      registryTools: [
        toolEntry({ name: 'contact.search', tier: 1 }),
        toolEntry({ name: 'mail.search', tier: 1, concurrency_safe: false }),
        toolEntry({ name: 'deal.search', tier: 1 }),
      ],
    }));
    expect(section.tools).toEqual([
      { name: 'contact.search', description: 'contact.search description', concurrency_safe: true },
      { name: 'deal.search', description: 'deal.search description', concurrency_safe: true },
      { name: 'mail.search', description: 'mail.search description', concurrency_safe: false },
    ]);
  });

  it('memory-recall section emits the entry\'s concurrency_safe verbatim', () => {
    // memory.search defaults to true (production-aligned). Override
    // proves the assembler isn't applying a section-level true.
    const sectionTrue = assembleCatalog(catalogInput({
      registryTools: [toolEntry({ name: 'memory.search', tier: 1 })],
    })).sections.find((s) => s.section === 'memory-recall')!;
    expect(sectionTrue.tools).toEqual([
      { name: 'memory.search', description: 'memory.search description', concurrency_safe: true },
    ]);
    const sectionFalse = assembleCatalog(catalogInput({
      registryTools: [
        toolEntry({ name: 'memory.search', tier: 1, concurrency_safe: false }),
      ],
    })).sections.find((s) => s.section === 'memory-recall')!;
    expect(sectionFalse.tools).toEqual([
      { name: 'memory.search', description: 'memory.search description', concurrency_safe: false },
    ]);
  });

  it('recipes section emits recipe.run\'s concurrency_safe verbatim (false by production default)', () => {
    // recipe.run's production default is `false` (umbrella dispatcher
    // can't infer per-recipe). Fixture default mirrors that — the
    // catalog should emit `false`. Override to `true` proves the
    // assembler reads off the entry.
    const sectionDefault = assembleCatalog(catalogInput({
      registryTools: [
        toolEntry({ name: 'recipe.run', tier: 1, classification: 'unknown' }),
      ],
    })).sections.find((s) => s.section === 'recipes')!;
    expect(sectionDefault.tools).toEqual([
      { name: 'recipe.run', description: 'recipe.run description', concurrency_safe: false },
    ]);
    const sectionOverride = assembleCatalog(catalogInput({
      registryTools: [
        toolEntry({
          name: 'recipe.run',
          tier: 1,
          classification: 'unknown',
          concurrency_safe: true,
        }),
      ],
    })).sections.find((s) => s.section === 'recipes')!;
    expect(sectionOverride.tools).toEqual([
      { name: 'recipe.run', description: 'recipe.run description', concurrency_safe: true },
    ]);
  });

  it('entity-action section emits each Tier 2 entry\'s concurrency_safe verbatim', () => {
    const section = assembleEntityActionSection(catalogInput({
      registryTools: [
        toolEntry({
          name: 'team/sealed-false',
          tier: 2,
          classification: 'write',
        }),
        toolEntry({
          name: 'team/explicit-true',
          tier: 2,
          classification: 'write',
          concurrency_safe: true,
        }),
      ],
    }));
    expect(section.tools.map((t) => ({ name: t.name, concurrency_safe: t.concurrency_safe })))
      .toEqual([
        { name: 'team/explicit-true', concurrency_safe: true },
        { name: 'team/sealed-false', concurrency_safe: false },
      ]);
  });

  it('other section emits each Tier 3 entry\'s concurrency_safe verbatim', () => {
    const section = assembleOtherSection(catalogInput({
      registryTools: [
        toolEntry({
          name: 'hubspot.contact_lookup',
          tier: 3,
          classification: 'read',
        }),
        toolEntry({
          name: 'hubspot.batched_lookup',
          tier: 3,
          classification: 'read',
          concurrency_safe: true,
        }),
      ],
      capabilities: {
        connectedVendors: new Set<string>(['hubspot']),
        enabledKinds: new Set(),
        enabledEnrichmentTopics: new Set(),
      },
    }));
    expect(section.tools.map((t) => ({ name: t.name, concurrency_safe: t.concurrency_safe })))
      .toEqual([
        { name: 'hubspot.batched_lookup', concurrency_safe: true },
        { name: 'hubspot.contact_lookup', concurrency_safe: false },
      ]);
  });
});
