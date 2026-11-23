import { browserItemReferences } from '@recued/contracts';
import { browserDataError } from './browser-data-store.js';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const lookup = (value: unknown, path: string[]): unknown => path.reduce<unknown>((current, key) =>
  current !== null && typeof current === 'object' && Object.hasOwn(current, key)
    ? (current as Record<string, unknown>)[key] : undefined, value);

/** Adapt exact quoted keys to the existing pure expression engine. Aliases are
 * host-only, non-enumerable and collision-free; snapshots and returned row keys
 * stay unchanged. No evaluation of authored JavaScript participates. */
export const prepareBrowserQuotedExpression = (expression: unknown): ((input: unknown, assertActive: () => void) => {
  expression: unknown; input: unknown;
}) | undefined => {
  const paths = new Map<string, string[]>();
  const authoredKeys = new Set<string>();
  const inspect = (value: unknown): void => {
    if (typeof value === 'string') {
      const refs = browserItemReferences(value);
      if (!refs) throw browserDataError('invalid bounded item path');
      for (const ref of refs) {
        if (ref.path[0]) authoredKeys.add(ref.path[0]);
        if (ref.quoted) paths.set(JSON.stringify(ref.path), ref.path);
      }
    } else if (Array.isArray(value)) value.forEach(inspect);
    else if (object(value)) Object.values(value).forEach(inspect);
    if (paths.size > 64) throw browserDataError('an expression exceeds 64 exact column references');
  };
  inspect(expression);
  if (!paths.size) return undefined;
  return (input, assertActive) => {
    const items = Array.isArray(input) ? input : [input];
    const keys = new Set([...authoredKeys, ...items.flatMap(item => object(item) ? Object.keys(item) : [])]);
    let prefix = '__recued_column_';
    while ([...paths.keys()].some((_, index) => keys.has(prefix + index))) prefix += '_';
    const aliases = new Map([...paths].map(([key, path], index) => [key, { name: prefix + index, path }]));
    const rewrite = (value: unknown): unknown => {
      if (typeof value === 'string') {
        const refs = browserItemReferences(value)!;
        let end = 0, text = '';
        for (const ref of refs) {
          text += value.slice(end, ref.start) + (ref.quoted ? '{{item.' + aliases.get(JSON.stringify(ref.path))!.name + '}}' : value.slice(ref.start, ref.end));
          end = ref.end;
        }
        return text + value.slice(end);
      }
      if (Array.isArray(value)) return value.map(rewrite);
      if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewrite(child)]));
      return value;
    };
    const wrap = (item: unknown) => {
      assertActive();
      if (item === null || typeof item !== 'object') throw browserDataError('quoted item paths require object or array items');
      const wrapped = Array.isArray(item) ? [...item] : { ...(item as Record<string, unknown>) };
      for (const { name, path } of aliases.values()) Object.defineProperty(wrapped, name, { value: lookup(item, path), enumerable: false });
      return wrapped;
    };
    return { expression: rewrite(expression), input: Array.isArray(input) ? items.map(wrap) : wrap(input) };
  };
};
