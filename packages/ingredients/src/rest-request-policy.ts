import { isLockedInputKey, type AuthoringReferenceSpan } from '@recued/contracts';

export interface RestRequestProblem {
  path: (string | number)[];
  message: string;
  reference_span?: AuthoringReferenceSpan;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const restRequestPathSuffix = (path: readonly (string | number)[]) => path.map(key => typeof key === 'number' ? '[' + key + ']'
  : /^[A-Za-z_]\w*$/.test(key) ? '.' + key : '[' + JSON.stringify(key) + ']').join('');
const keySpan = (key: string): AuthoringReferenceSpan | undefined => key.length ? { target: 'key', offset: 0, length: key.length } : undefined;

/** Existing catalog request rules, with structured source targets. No new admission rule. */
export const restStaticRequestProblems = (binding: Record<string, unknown>, opKey: string): RestRequestProblem[] => {
  const out: RestRequestProblem[] = [];
  for (const staticKey of ['static_query', 'static_headers', 'static_body'] as const) {
    const sv = binding[staticKey];
    if (sv === undefined) continue;
    if (!object(sv) || Object.values(sv).some(value => typeof value !== 'string')) {
      const invalidKey = object(sv) ? Object.keys(sv).find(key => typeof sv[key] !== 'string') : undefined;
      out.push({ path: invalidKey === undefined ? [staticKey] : [staticKey, invalidKey],
        message: `rest binding for '${opKey}' ${staticKey} must be an object of string values` });
      continue;
    }
    if (staticKey === 'static_headers') for (const hName of Object.keys(sv)) {
      if (isLockedInputKey(`header.${hName.trim().toLowerCase()}`)) out.push({ path: [staticKey, hName], reference_span: keySpan(hName),
        message: `rest binding for '${opKey}' static_headers cannot set the engine-locked header '${hName}' (host / authorization / cookie are owned by the connection adapter, D-112)` });
    }
  }
  if (binding.static_body !== undefined && typeof binding.method === 'string' && !['POST', 'PUT', 'PATCH'].includes(binding.method)) {
    out.push({ path: ['static_body'], reference_span: keySpan('static_body'),
      message: `rest binding for '${opKey}' static_body requires a body-carrying method (POST/PUT/PATCH), got ${binding.method}` });
  }
  if (object(binding.static_body)) for (const bodyKey of Object.keys(binding.static_body)) {
    if (bodyKey.includes('.')) out.push({ path: ['static_body', bodyKey], reference_span: keySpan(bodyKey),
      message: `rest binding for '${opKey}' static_body key '${bodyKey}' contains a dot — keys are literal top-level JSON property names, not nested paths; compose nested bodies upstream or flatten the key` });
  }
  return out;
};

/** Keep merge-list order and issue multiplicity, including repeated unknown names. */
export const restMergeQueryProblems = (binding: Record<string, unknown>, opKey: string): RestRequestProblem[] => {
  const mq = binding.merge_query;
  if (mq === undefined) return [];
  const sq = object(binding.static_query) ? binding.static_query : {};
  if (!Array.isArray(mq) || mq.some(key => typeof key !== 'string')) {
    const index = Array.isArray(mq) ? mq.findIndex(key => typeof key !== 'string') : -1;
    return [{ path: index < 0 ? ['merge_query'] : ['merge_query', index],
      message: `rest binding for '${opKey}' merge_query must be an array of static_query key names` }];
  }
  const out: RestRequestProblem[] = [];
  // entries(), like the original for-of, visits sparse slots on direct JS input.
  for (const [index, key] of mq.entries()) if (!Object.hasOwn(sq, key)) out.push({ path: ['merge_query', index],
    message: `rest binding for '${opKey}' merge_query names '${key}', which is not a declared static_query key` });
  return out;
};
