import { browserStepBinding, type RecipeDefinition } from '@recued/contracts';

type BrowserArgumentKind = 'selector' | 'text' | 'steps';
const bindings: Readonly<Record<string, Readonly<Record<string, BrowserArgumentKind>>>> = {
  'core.dom.act': { steps: 'steps' },
  'core.dom.inspect': { selector: 'selector', find: 'text' },
  'core.dom.table': { selector: 'selector' },
  'core.dom.wait': { selector: 'selector', text: 'text' },
  'core.dom.scroll': { selector: 'selector', text: 'text' },
  'core.dom.screenshot': { selector: 'selector' },
  'core.dom.download': { selector: 'selector', text: 'text' },
  'core.dom.click': { selector: 'selector', text: 'text' },
  'core.dom.write': { selector: 'selector', text: 'text' },
};

/** Host-derived argument meanings. A variable reused outside these exact
 * bindings keeps ordinary grounding, including reuse in a write's value.
 * Inspect every string occurrence, including embedded/path references and
 * prefetch steps, so a browser argument cannot exempt another consumer. */
export const browserArgumentKinds = (recipe: RecipeDefinition): Map<string, BrowserArgumentKind> => {
  const uses = new Map<string, number>();
  const scan = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\{\{\s*config\.([A-Za-z0-9_]+)(?=[.\[\s}])/g)) {
        const name = match[1]!; uses.set(name, (uses.get(name) ?? 0) + 1);
      }
    } else if (Array.isArray(value)) value.forEach(scan);
    else if (value && typeof value === 'object') Object.values(value).forEach(scan);
  };
  const candidates = new Map<string, { kind: BrowserArgumentKind; count: number }>();
  for (const step of recipe.steps ?? []) {
    const browser = browserStepBinding(step);
    if (!browser) continue;
    for (const [parameter, kind] of Object.entries(bindings[browser.op] ?? {})) {
      const value = browser.args[parameter];
      const name = typeof value === 'string' ? /^\{\{config\.([A-Za-z0-9_]+)\}\}$/.exec(value)?.[1] : undefined;
      if (!name) continue;
      const previous = candidates.get(name);
      candidates.set(name, { kind, count: previous && previous.kind === kind ? previous.count + 1 : 1 });
    }
  }
  if (!candidates.size) return new Map();
  scan([recipe.steps, recipe.prefetch_steps, recipe.variables]);
  return new Map([...candidates].filter(([name, candidate]) => candidate.count === uses.get(name))
    .map(([name, candidate]) => [name, candidate.kind]));
};
