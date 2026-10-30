import { outputVariableBindings } from './output-variable-bindings.js';
/** Shared output-filter eligibility; declaration existence is checked by the caller. */
export const filterVariableProblem = (definition: unknown, field: 'fields' | 'hidden'): 'unlabeled' | 'credential' | undefined => {
  const hint = definition !== null && typeof definition === 'object' && !Array.isArray(definition)
    ? definition as Record<string, unknown> : undefined;
  if (field === 'fields' && (!hint || typeof hint.label !== 'string' || !hint.label.trim()
    || typeof hint.type !== 'string' || !hint.type.trim())) return 'unlabeled';
  if (hint?.type === 'secret' || hint?.type === 'oauth') return 'credential';
  return;
};

/** Literal names in active filter sections are usages, including hidden carriers. */
export const filterVariableBindings = (recipe: Record<string, unknown>): string[] => {
  return outputVariableBindings(recipe).filter(binding => binding.role.startsWith('filter_')).map(binding => binding.name);
};
