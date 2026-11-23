import { randomUUID } from 'node:crypto';
import { IngredientError, type ResolvedCall } from '@recued/ingredients';
import { canonicalJSONStringify } from '@recued/crypto/canonical-json';
import { isBrowserSourceIssues, type BrowserSourceIssue } from '@recued/contracts';

export const BROWSER_DATA_LIMITS = { bytes: 4_000_000, nodes: 100_000, rows: 5_000, depth: 24,
  entries: 64, total_bytes: 32_000_000, ttl_ms: 30 * 60_000, result_chars: 16_000 } as const;
export interface BrowserDataSource {
  kind: 'read' | 'table' | 'collection'; page: string; url: string; title: string;
  complete: boolean; truncated: boolean; loading: boolean;
  coverage?: unknown;
  issues?: BrowserSourceIssue[];
}
export interface BrowserDataDescriptor {
  data_ref: string; kind: string; row_count?: number;
  fields: Array<{ field: string; types: string[] }>;
  fields_complete: boolean; source_complete: boolean;
  sources: BrowserDataSource[]; derived_from?: string[];
  source_issues?: BrowserSourceIssue[];
  source_issues_truncated?: true;
}
export interface BrowserDataValue { value: unknown; descriptor: BrowserDataDescriptor }
export const browserDataSourceIssues = (sources: readonly BrowserDataSource[]): Pick<BrowserDataDescriptor, 'source_issues' | 'source_issues_truncated'> => {
  const issues = [...new Map(sources.flatMap(source => source.issues ?? []).map(issue => [canonicalJSONStringify(issue), issue])).values()];
  return { ...(issues.length ? { source_issues: structuredClone(issues.slice(-2)) } : {}), ...(issues.length > 2 ? { source_issues_truncated: true as const } : {}) };
};
export interface BrowserDataStore {
  keep(scope: string, value: unknown, sources: readonly BrowserDataSource[], parents?: readonly string[]): BrowserDataValue;
  read(scope: string, ref: string): BrowserDataValue;
  readBounded(scope: string, ref: string, maxChars: number): BrowserDataValue | undefined;
  describe(scope: string, ref: string): BrowserDataDescriptor;
}
export const browserDataError = (message: string): IngredientError => new IngredientError('DOM_CHECK_FAILED',
  `Browser data: ${message}`, { slug: 'dom-act', executed: false });

/** JSON snapshots only, with limits applied before serializing or retaining.
 * Never silently coerce non-finite calculations to JSON null. */
export const browserDataJson = (value: unknown): string => {
  let nodes = 0;
  const ancestors = new Set<object>();
  const problem = (message: string, path: string, reason: 'undefined' | 'non_finite' | 'cycle' | 'non_json' | 'limit') =>
    Object.assign(browserDataError(message), { browser_data_problem: { path: path.slice(0, 256), ...(path.length > 256 ? { path_truncated: true } : {}), reason } });
  const visit = (item: unknown, depth: number, path: string): void => {
    if (++nodes > BROWSER_DATA_LIMITS.nodes || depth > BROWSER_DATA_LIMITS.depth) throw problem('data exceeds the node or depth limit', path, 'limit');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || item === null || ancestors.has(item)) throw problem('operation must return finite, acyclic JSON data', path,
      item === undefined ? 'undefined' : typeof item === 'number' ? 'non_finite' : typeof item === 'object' ? 'cycle' : 'non_json');
    ancestors.add(item);
    if (Array.isArray(item)) {
      if (item.length > BROWSER_DATA_LIMITS.rows) throw problem(`an array exceeds ${BROWSER_DATA_LIMITS.rows} items; narrow the capture or operation`, path, 'limit');
      for (let index = 0; index < item.length; index++) visit(item[index], depth + 1, `${path}[${index}]`);
    } else {
      const prototype: unknown = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw problem('operation returned a non-JSON object', path, 'non_json');
      for (const [key, child] of Object.entries(item)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw problem('prototype-sensitive keys cannot be retained', path, 'non_json');
        visit(child, depth + 1, `${path}[${JSON.stringify(key)}]`);
      }
    }
    ancestors.delete(item);
  };
  visit(value, 0, '$');
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > BROWSER_DATA_LIMITS.bytes) throw problem('data exceeds the 4 MB snapshot limit', '$', 'limit');
  return json;
};

/** Host lineage is independent of authored arguments. Keep chat/session/token
 * and contract boundaries, while allowing a subsequent tool call in that scope. */
export const browserDataScope = (call: ResolvedCall, fallback: string): string => {
  const source = call.stepMeta?.execution_source;
  const identity = source ? Object.fromEntries(Object.entries(source).filter(([key]) => !['turn_id', 'tool_call_id', 'correlation_id'].includes(key)))
    : { internal_run: call.stepMeta?.run_id ?? fallback };
  return canonicalJSONStringify({ identity, target: call.input.target ?? null });
};
const typeOf = (value: unknown): string => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
export const browserDataShape = (value: unknown): Pick<BrowserDataDescriptor, 'kind' | 'row_count' | 'fields' | 'fields_complete'> => {
  const rows = Array.isArray(value) ? value : [value];
  const fields = new Map<string, Set<string>>();
  let complete = true;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    for (const [field, item] of Object.entries(row)) {
      if (field.length > 160 || !fields.has(field) && fields.size >= 64) { complete = false; continue; }
      const types = fields.get(field) ?? new Set<string>(); types.add(typeOf(item)); fields.set(field, types);
    }
  }
  return { kind: typeOf(value), ...(Array.isArray(value) ? { row_count: value.length } : {}),
    fields: [...fields].map(([field, types]) => ({ field, types: [...types] })), fields_complete: complete };
};

export const createBrowserDataStore = (now: () => number = Date.now): BrowserDataStore => {
  const entries = new Map<string, { scope: string; json: string; descriptor: BrowserDataDescriptor; at: number; bytes: number }>();
  const entryFor = (scope: string, ref: string) => {
    const entry = entries.get(ref);
    if (!entry || entry.scope !== scope || now() - entry.at >= BROWSER_DATA_LIMITS.ttl_ms) {
      if (entry && now() - entry.at >= BROWSER_DATA_LIMITS.ttl_ms) entries.delete(ref);
      throw browserDataError('reference is unavailable in this caller scope or expired; read or collect again');
    }
    return entry;
  };
  const sweep = () => {
    for (const [key, entry] of entries) if (now() - entry.at >= BROWSER_DATA_LIMITS.ttl_ms) entries.delete(key);
    let bytes = [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const [key, entry] of entries) {
      if (entries.size < BROWSER_DATA_LIMITS.entries && bytes <= BROWSER_DATA_LIMITS.total_bytes - BROWSER_DATA_LIMITS.bytes) break;
      entries.delete(key); bytes -= entry.bytes;
    }
  };
  return {
    keep(scope, value, sources, parents = []) {
      for (const source of sources) if (source.issues !== undefined && (source.complete || !isBrowserSourceIssues(source.issues))) throw browserDataError('invalid source coverage issue');
      const json = browserDataJson(value);
      const unique = [...new Map(sources.map(source => [canonicalJSONStringify(source), source])).values()];
      if (unique.length > 40 || JSON.stringify(unique).length > 12_000) throw browserDataError('source lineage exceeds its bound');
      const sourceKey = canonicalJSONStringify(unique);
      for (const [ref, entry] of entries) if (entry.scope === scope && entry.json === json
        && now() - entry.at < BROWSER_DATA_LIMITS.ttl_ms && canonicalJSONStringify(entry.descriptor.sources) === sourceKey
        && canonicalJSONStringify(entry.descriptor.derived_from ?? []) === canonicalJSONStringify([...new Set(parents)].slice(0, 40))) {
        return { value: JSON.parse(json), descriptor: { ...structuredClone(entry.descriptor), data_ref: ref } };
      }
      sweep();
      const ref = `data:${randomUUID()}`;
      // Source identities and coverage remain exact; source bounds are already
      // the browser's capture bounds, independently of model output clipping.
      const descriptor: BrowserDataDescriptor = { data_ref: ref, ...browserDataShape(value), source_complete: unique.length > 0 && unique.every(source => source.complete),
        sources: structuredClone(unique), ...(parents.length ? { derived_from: [...new Set(parents)].slice(0, 40) } : {}) };
      Object.assign(descriptor, browserDataSourceIssues(unique));
      entries.set(ref, { scope, json, descriptor, at: now(), bytes: Buffer.byteLength(json) });
      return { value: JSON.parse(json), descriptor: structuredClone(descriptor) };
    },
    read(scope, ref) {
      const entry = entryFor(scope, ref);
      return { value: JSON.parse(entry.json), descriptor: structuredClone(entry.descriptor) };
    },
    readBounded(scope, ref, maxChars) {
      const entry = entryFor(scope, ref);
      if (entry.json.length > maxChars) return;
      return { value: JSON.parse(entry.json), descriptor: structuredClone(entry.descriptor) };
    },
    describe(scope, ref) { return structuredClone(entryFor(scope, ref).descriptor); },
  };
};
export const browserDataStore = createBrowserDataStore();
