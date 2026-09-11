import type { RecipeDefinition } from './recipe.js';

/** Fixture-only execution: no live connection, catalog, or storage access. */
export interface RecipeSimulationInput {
  config?: Record<string, unknown>;
  context?: Record<string, unknown>;
  data?: Record<string, unknown>;
  /** Final step outputs, after any provider projection. */
  mocks?: Record<string, { result: unknown } | { iterations: unknown[] } | { error: string }>;
}
export interface SimulatedStep {
  id: string;
  phase: 'trigger' | 'prefetch' | 'sequential';
  operation: string;
  mocked: boolean;
  status: 'passed' | 'skipped' | 'failed' | 'blocked';
  input: unknown;
  output?: unknown;
  message?: string;
}
export interface RecipeSimulationResult {
  steps: SimulatedStep[];
  status: 'passed' | 'failed' | 'gated';
}
export interface RecipeSimulationRequest {
  /** Identifies this temporary test on its originating connection. */
  simulation_id: string;
  recipe: RecipeDefinition;
  sample: RecipeSimulationInput;
}
