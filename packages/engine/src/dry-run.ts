/** Dry-run executor — stubs all ingredient calls with mock data.
 *
 *  Use this instead of a real dispatcher when you want to run a
 *  recipe through the engine pipeline without hitting any external
 *  APIs, DOM, or LLM providers. The engine still executes every
 *  transform, evaluates every condition, and produces a full
 *  ExecutionResult — but ingredient steps return plausible synthetic
 *  data derived from the manifest's `output` field.
 *
 *  Zero tokens spent. Zero network requests. Zero side effects.
 *
 *  The executor loads each ingredient's manifest via the same
 *  `ManifestLoader` the real runtime uses, so a dry-run against a
 *  recipe that references a non-existent ingredient fails fast with
 *  INGREDIENT_NOT_FOUND — exactly like a real run would.
 *
 *  Mock data quality is "plausible, not realistic" — field names
 *  drive heuristic value generation (e.g., a field named `amount`
 *  gets a number, `deal_name` gets a string). The goal is to
 *  exercise the transform/condition pipeline, not to produce
 *  business-realistic data.
 */

import type { IngredientManifest } from '@recued/contracts';
import type { IngredientExecutor } from './types.js';

const PROTOTYPE_SENSITIVE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Manifest loader signature — matches the one in @recued/ingredients.
 *  Declared locally to avoid a cross-package dependency from engine →
 *  ingredients (engine is a lower-level package). */
export type ManifestLoader = (slug: string) => Promise<IngredientManifest | null>;

/** Build a dry-run ingredient executor.
 *
 *  Every ingredient call resolves to synthetic data generated from
 *  the manifest's output schema. No HTTP, DOM, LLM, or MCP calls.
 *
 *  @param manifestLoader — same loader the real runtime uses
 *  @param fixtures — optional slug → data overrides; when provided,
 *    the fixture is returned verbatim instead of auto-generated data.
 *    Useful for tests that need deterministic output.
 */
export const createDryRunExecutor = (
  manifestLoader: ManifestLoader,
  fixtures?: Record<string, unknown>,
): IngredientExecutor =>
  async (slug, _input) => {
    // Check for caller-supplied fixture first
    if (fixtures && slug in fixtures) return fixtures[slug];

    const manifest = await manifestLoader(slug);
    if (!manifest) {
      throw Object.assign(
        new Error(`Dry-run: no manifest found for ingredient '${slug}'`),
        { code: 'INGREDIENT_NOT_FOUND' },
      );
    }
    return generateMockData(manifest);
  };

/** Generate plausible mock data from a manifest's `output` field.
 *
 *  The output field maps response paths to field names:
 *  ```json
 *  { "category": "category", "confidence": "confidence" }
 *  ```
 *  We build an object with one entry per field, using the field name
 *  to heuristically pick a value type. Exported so tests can call it
 *  directly and verify the heuristics.
 */
export const generateMockData = (
  manifest: IngredientManifest,
): Record<string, unknown> => {
  const output = manifest.output;
  if (!output || typeof output !== 'object') return {};

  const mock: Record<string, unknown> = {};
  for (const [, fieldName] of Object.entries(output)) {
    if (typeof fieldName !== 'string') continue;
    if (PROTOTYPE_SENSITIVE_KEYS.has(fieldName)) continue;
    mock[fieldName] = mockValueForField(fieldName, manifest);
  }
  return mock;
};

// ────────────────────────────────────────────────────────────────
// Field-name heuristics
// ────────────────────────────────────────────────────────────────

/** Generate a plausible mock value based on the field name. Pure and
 *  deterministic for a given field name (no random — determinism
 *  makes dry-run results reproducible and testable). */
const mockValueForField = (
  field: string,
  manifest: IngredientManifest,
): unknown => {
  const f = field.toLowerCase();

  // ── ID fields ──
  if (f === 'id' || f.endsWith('_id') || f.endsWith('id')) {
    return `mock-${field}-001`;
  }

  // ── Numeric fields ──
  if (
    f.includes('amount') || f.includes('price') || f.includes('revenue') ||
    f.includes('cost') || f.includes('total') || f.includes('count')
  ) {
    return 42000;
  }
  if (f.includes('score') || f.includes('confidence') || f.includes('percentage')) {
    return 0.85;
  }

  // ── Date fields ──
  if (f.includes('date') || f.includes('timestamp') || f.endsWith('_at')) {
    return '2025-01-15T10:30:00Z';
  }

  // ── Boolean fields ──
  if (f.startsWith('is_') || f.startsWith('has_')) return true;

  // ── Array fields (common patterns) ──
  if (f.includes('breakdown') || f.includes('signals') || f.includes('key_points')) {
    return [
      { label: `Mock ${field} item 1`, value: 'placeholder' },
      { label: `Mock ${field} item 2`, value: 'placeholder' },
    ];
  }
  if (f.includes('differences') || f.includes('similarities')) {
    return [`Mock ${field} entry 1`, `Mock ${field} entry 2`];
  }

  // ── AI-specific fields ──
  if (f === 'category') return 'medium';
  if (f === 'sentiment') return 'positive';
  if (f === 'reasoning' || f === 'recommendation') {
    return `Mock ${manifest.slug} reasoning: analysis based on provided data.`;
  }
  if (f === 'summary' || f === 'content' || f === 'rewritten' || f === 'translated') {
    return `Mock ${manifest.slug} output for ${field}.`;
  }
  if (f === 'result') {
    return `Mock result from ${manifest.slug}.`;
  }
  if (f === 'source_language') return 'en';

  // ── Name / string fields ──
  if (f.includes('name') || f.includes('title') || f.includes('label')) {
    return `Mock ${field}`;
  }
  if (f.includes('email')) return 'mock@example.com';
  if (f.includes('phone')) return '+1-555-0100';
  if (f.includes('url') || f.includes('domain')) return 'https://mock.example.com';
  if (f.includes('stage')) return 'open';
  if (f.includes('pipeline')) return 'default';
  if (f.includes('industry')) return 'Technology';
  if (f.includes('company')) return 'Mock Corp';
  if (f.includes('body') || f.includes('subject') || f.includes('description')) {
    return `Mock ${field} content for dry-run testing.`;
  }

  // ── Catch-all: custom_fields and unknowns ──
  if (f === 'custom_fields') return {};

  return `mock-${field}`;
};
