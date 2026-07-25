// Local type import for the `satisfies` clause below (a re-export alone does not
// bring the name into local scope).
import type { CanonicalWorkflowTemplate } from '@recued/contracts';

export type {
  // Coarse label types kept for the rpc preview / draft summary / review.
  CompositionAuthModel,
  CompositionSurface,
  // The by-value composition + its two authoring tables (D-182 §4 / 3b).
  CompositionIngredient,
  IngredientRow,
  IngredientEntity,
  IngredientEntityField,
  PackOperationRow,
  RecipeTemplateRow,
  CanonicalWorkflowTemplate,
  ArgEditField,
  // Legacy rows still consumed by the connection-agnostic resolver (kept until
  // the §10 legacy-delete slice) + the editor's authoring drafts.
  OperationRow,
  EntityFieldRow,
} from '@recued/contracts';

export const COMPOSITION_SCHEMA_VERSION = 1;

export const COMPOSITION_MAX_OPERATIONS = 100;
export const COMPOSITION_MAX_FIELDS = 500;
export const COMPOSITION_MAX_SERIALIZED_BYTES = 256 * 1024;

export interface CanonicalWorkflowTemplateRegistryEntry {
  description: string;
  structure: readonly string[];
  optional_holes?: readonly string[];
}

export const CANONICAL_WORKFLOW_TEMPLATE_REGISTRY = {
  'review-then-approve': {
    description: 'trigger -> ask(approval-required operation) -> operation',
    structure: ['trigger', 'ask', 'operation'],
    optional_holes: ['sync_target'],
  },
  'notify-on-event': {
    description: 'trigger -> notify',
    structure: ['trigger', 'notify'],
    optional_holes: ['notify_target'],
  },
  'conditional-operate': {
    description: 'trigger -> guard -> operation',
    structure: ['trigger', 'guard', 'operation'],
  },
  'scheduled-operate': {
    description: 'cron -> operation',
    structure: ['cron', 'operation'],
  },
  escalate: {
    description: 'trigger -> ask -> no answer after X -> notify other',
    structure: ['trigger', 'ask', 'timeout', 'notify'],
    optional_holes: ['notify_target', 'escalate_after_ms'],
  },
} as const satisfies Record<CanonicalWorkflowTemplate, CanonicalWorkflowTemplateRegistryEntry>;
