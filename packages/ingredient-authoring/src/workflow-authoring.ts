import type { RecipeTemplateRow } from '@recued/contracts';
import { CANONICAL_WORKFLOW_TEMPLATE_REGISTRY } from './schema.js';
export interface WorkflowAuthoringField { key: string; type: 'string' | 'object' | 'number'; description: string; required?: boolean }
type Help = Omit<WorkflowAuthoringField, 'key'>;
const row = {
  template: { type: 'string', required: true, description: 'Canonical trigger-to-operation handling template. The shared compiler determines the actual generated recipe; the registry structure is descriptive.' },
  trigger: { type: 'object', required: true, description: 'Authored event entity and optional field/value or schedule. External entity names remain legal; the editor does not invent source identities or event payloads.' },
  operation: { type: 'string', required: true, description: 'Declared local operation. Existing operation completion, F12 and Rename apply. Selection does not establish a grant or runtime availability.' },
  sync_target: { type: 'object', description: 'Optional review-then-approve write-back declaration. Its source identity remains authored; the write-back operation must be declared locally.' },
  notify_target: { type: 'string', description: 'Optional notification target for a template that declares this setting. The target and delivery permissions remain authored.' },
  escalate_after_ms: { type: 'number', description: 'Optional positive finite escalation timeout in milliseconds. Choose the value explicitly; the compiler carries it into the approval step.' },
} satisfies Record<keyof RecipeTemplateRow, Help>;
const trigger = {
  entity: { type: 'string', required: true, description: 'Non-empty authored event entity. It is required for every canonical template, including scheduled-operate; it does not establish an installed entity.' },
  field: { type: 'string', description: 'Optional authored trigger field. The compiler handles Reception and vendor event payloads differently; inspect the generated recipe for its exact guard.' },
  value: { type: 'string', description: 'Optional literal string compared by the compiler-generated guard. This is not a template expression or an inferred enum.' },
  cron: { type: 'string', description: 'Non-empty authored cron for scheduled-operate. Shared authoring validation requires presence, not cron syntax, time-zone validation or a running schedule.' },
} satisfies Record<keyof RecipeTemplateRow['trigger'], Help>;
const sync = {
  source_id: { type: 'string', required: true, description: 'Non-empty authored write-back source identity. The editor does not discover or create sources.' },
  write_back_op: { type: 'string', required: true, description: 'Declared local write-back operation. Existing operation completion, F12 and Rename apply; authority remains governed at execution.' },
} satisfies Record<keyof NonNullable<RecipeTemplateRow['sync_target']>, Help>;
export const RECIPE_TEMPLATE_KEYS = Object.keys(row);
export const RECIPE_TRIGGER_KEYS = Object.keys(trigger);
export const RECIPE_SYNC_TARGET_KEYS = Object.keys(sync);
export const workflowTemplate = (value: unknown) => typeof value === 'string' && Object.hasOwn(CANONICAL_WORKFLOW_TEMPLATE_REGISTRY, value)
  ? CANONICAL_WORKFLOW_TEMPLATE_REGISTRY[value as keyof typeof CANONICAL_WORKFLOW_TEMPLATE_REGISTRY] : undefined;
export const workflowTemplateChoices = () => Object.entries(CANONICAL_WORKFLOW_TEMPLATE_REGISTRY).map(([value, entry]) => ({ value, description: entry.description }));
export const workflowAuthoringFields = (group: 'row' | 'trigger' | 'sync', template: unknown, includeForbidden = false): WorkflowAuthoringField[] => {
  const entry = workflowTemplate(template), holes: readonly string[] = entry && 'optional_holes' in entry ? entry.optional_holes : [];
  return Object.entries(group === 'row' ? row : group === 'trigger' ? trigger : sync)
    .filter(([key]) => group !== 'row' || includeForbidden || ['template', 'trigger', 'operation'].includes(key) || holes.includes(key))
    .map(([key, field]) => ({ key, ...field, ...(group === 'trigger' && key === 'cron' && template === 'scheduled-operate' ? { required: true } : {}) }));
};
