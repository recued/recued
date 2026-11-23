/** Coverage of the returned view, independent of document readiness and action
 * permission. Unknown readiness must not be promoted to a settled document. */
export interface BrowserReadState {
  source: 'bridge_read' | 'kept_snapshot';
  scope: {
    kind: 'page' | 'page_text' | 'page_part' | 'element' | 'section' | 'search' | 'block' | 'unknown';
    form: 'outline' | 'text';
    ref?: string; selector?: string; find?: string; block?: string; from?: number;
    first_match?: true;
    /** Number of elements matched by the CSS selector in this document. */
    matched_count?: number;
    /** 1-based position in DOM order among selector matches: 1 is first, 2 is second.
     * The returned view is scoped to that element's subtree, not the full match list. */
    selected_index?: number;
  };
  loading: boolean | 'unknown';
  complete: boolean | 'unknown';
  truncated: boolean | 'unknown';
  /** 2026-11-20 — whether the page's content had stopped changing when it was read (`BRIDGE_READ_QUIET_MS`): absent
   *  when the read did not wait for it (an older Bridge, a snapshot kept from before). */
  settled?: boolean;
}
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every(k => allowed.includes(k));
const flag = (v: unknown) => typeof v === 'boolean' || v === 'unknown';
export const isBrowserReadState = (v: unknown): v is BrowserReadState => {
  if (!record(v) || !keys(v, ['source', 'scope', 'loading', 'complete', 'truncated', 'settled'])
    || !['bridge_read', 'kept_snapshot'].includes(String(v.source)) || !flag(v.loading) || !flag(v.complete) || !flag(v.truncated)
    || (v.settled !== undefined && typeof v.settled !== 'boolean')
    || !record(v.scope)) return false;
  const scope = v.scope;
  const fields: Record<string, readonly string[]> = { page: [], page_text: [], page_part: ['from'],
    element: ['ref', 'selector', 'first_match', 'matched_count', 'selected_index'], section: ['find'], search: ['find'], block: ['block'], unknown: [] };
  const allowed = Object.hasOwn(fields, String(scope.kind)) ? fields[String(scope.kind)] : undefined;
  return allowed !== undefined && keys(scope, ['kind', 'form', ...allowed]) && ['outline', 'text'].includes(String(scope.form))
    && ['ref', 'selector', 'find', 'block'].every(k => scope[k] === undefined || typeof scope[k] === 'string' && scope[k].length > 0 && scope[k].length <= (k === 'selector' ? 1_000 : 256))
    && (scope.kind !== 'element' || (scope.ref === undefined) !== (scope.selector === undefined))
    && (!['section', 'search'].includes(String(scope.kind)) || typeof scope.find === 'string')
    && (scope.kind !== 'block' || typeof scope.block === 'string')
    && (scope.ref === undefined || /^e[1-9]\d{0,8}$/.test(String(scope.ref)))
    && (scope.kind !== 'page_part' || Number.isSafeInteger(scope.from) && Number(scope.from) > 0)
    && (scope.first_match === undefined || scope.first_match === true && typeof scope.selector === 'string')
    && (scope.matched_count === undefined && scope.selected_index === undefined
      || typeof scope.selector === 'string' && Number.isSafeInteger(scope.matched_count) && Number(scope.matched_count) > 0
      && Number.isSafeInteger(scope.selected_index) && Number(scope.selected_index) > 0 && Number(scope.selected_index) <= Number(scope.matched_count));
};
