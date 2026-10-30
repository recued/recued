export type OutputVariableBindingRole = 'filter_fields' | 'filter_hidden' | 'table_edit_into' | 'table_edit_hidden' | 'table_select_into' | 'table_select_hidden';
export interface OutputVariableBinding { name: string; path: (string | number)[]; role: OutputVariableBindingRole }

/** Relative recipe paths only. The caller also checks the active output container. */
export const outputVariableBindingRole = (path: readonly (string | number)[], sectionType: unknown): OutputVariableBindingRole | undefined => {
  if (path[0] !== 'output' || !['render', 'sidebar'].includes(String(path[1])) || typeof path[2] !== 'number') return;
  if (sectionType === 'filter' && path.length === 5 && typeof path[4] === 'number') {
    if (path[3] === 'fields') return 'filter_fields';
    if (path[3] === 'hidden') return 'filter_hidden';
  }
  if (sectionType === 'table' && (path[3] === 'edit' || path[3] === 'select')) {
    if (path.length === 5 && path[4] === 'into') return `table_${path[3]}_into`;
    if (path.length === 6 && path[4] === 'hidden' && typeof path[5] === 'number') return `table_${path[3]}_hidden`;
  }
  return;
};
/** Literal output submissions use variables even when no template reads them. */
export const outputVariableBindings = (recipe: Record<string, unknown>): OutputVariableBinding[] => {
  const output = recipe.output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return [];
  const row = output as Record<string, unknown>, key = Object.hasOwn(row, 'render') ? 'render' : 'sidebar', sections = row[key];
  if (!Array.isArray(sections)) return [];
  const found: OutputVariableBinding[] = [];
  sections.forEach((section, index) => {
    if (!section || typeof section !== 'object' || Array.isArray(section)) return;
    const root = ['output', key, index];
    const add = (value: unknown, path: (string | number)[]) => {
      const role = outputVariableBindingRole(path, section.type);
      if (role && typeof value === 'string' && value.length > 0) found.push({ name: value, path, role });
    };
    for (const field of ['fields', 'hidden']) if (Array.isArray(section[field])) section[field].forEach((value: unknown, at: number) => add(value, [...root, field, at]));
    for (const facet of ['edit', 'select']) {
      const nested = section[facet]; if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue;
      add(nested.into, [...root, facet, 'into']);
      if (Array.isArray(nested.hidden)) nested.hidden.forEach((value: unknown, at: number) => add(value, [...root, facet, 'hidden', at]));
    }
  });
  return found;
};

/** Preserve the canonical select-into rule; shorthand declarations establish no type. */
export const tableSelectVariableProblem = (definition: unknown): boolean => {
  const type = definition && typeof definition === 'object' && !Array.isArray(definition) ? (definition as Record<string, unknown>).type : undefined;
  return typeof type === 'string' && type !== 'array';
};
