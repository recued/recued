/** Bounded collection from cleaned HTML; positional selectors negotiate sibling-preserving reads.
 * No page program, generated selector, write loop or additional model call. */
export const BROWSER_COLLECT_MAX_PAGES = 20;
export const BROWSER_COLLECT_MAX_ITEMS = 500;
export const BROWSER_COLLECT_MAX_SECONDS = 120;
export const BROWSER_COLLECT_MAX_CHARS = 40_000;
export const BROWSER_COLLECT_VALUE_CHARS = 2_000;
export const BROWSER_COLLECT_KEYS = ['items', 'fields', 'next', 'max_pages', 'max_items', 'max_seconds', 'dedupe_by', 'where'] as const;

export interface BrowserCollectField {
  readonly selector: string;
  readonly attribute?: 'href' | 'src' | 'title' | 'alt' | 'value' | 'aria-label' | 'name' | 'id';
  readonly many?: boolean;
  readonly required?: boolean;
}
export interface BrowserCollectSpec {
  readonly items: string;
  readonly fields: Readonly<Record<string, BrowserCollectField>>;
  readonly next?: { readonly text: string } | { readonly selector: string };
  readonly max_pages: number;
  /** Source items inspected, including filtered and duplicate items. */
  readonly max_items: number;
  readonly max_seconds: number;
  readonly dedupe_by?: readonly string[];
  /** Exact text match, or membership when the field collects several values. */
  readonly where?: { readonly field: string; readonly equals: string };
  /** 2026-11-21 (D-402, benchmark task I, live) — the bounds the step asked for above their maxima, each read at its
   *  maximum instead ({@link BROWSER_COLLECT_MAX_PAGES}, {@link BROWSER_COLLECT_MAX_ITEMS}, {@link BROWSER_COLLECT_MAX_SECONDS}). */
  readonly asked?: { readonly max_pages?: number; readonly max_items?: number; readonly max_seconds?: number };
}

export interface BrowserCollectPosition {
  readonly siblings: 'all' | 'type';
  readonly from: 'start' | 'end';
  readonly a: number;
  readonly b: number;
}
export interface BrowserCollectSelectorPart {
  readonly relation: 'descendant' | 'child';
  readonly tag?: string;
  readonly scope?: boolean;
  readonly id?: string;
  readonly classes: readonly string[];
  readonly attributes: readonly { readonly name: string; readonly value?: string }[];
  readonly positions?: readonly BrowserCollectPosition[];
}
export type BrowserCollectSelector = readonly (readonly BrowserCollectSelectorPart[])[];

/** Small CSS subset over cleaned HTML: tags, *, #id, .class, [attr="value"],
 * descendant/child combinators, comma alternatives, :scope and sibling positions
 * (:nth-child/:nth-of-type, their last variants, first/last/only). Other syntax
 * is rejected before any browser command, rather than partially interpreted. */
export const parseBrowserCollectSelector = (value: unknown): BrowserCollectSelector | undefined => {
  if (typeof value !== 'string' || value.length > 256 || value.trim() === '' || value.includes('\\')) return undefined;
  const groups: BrowserCollectSelectorPart[][] = [];
  let parts: BrowserCollectSelectorPart[] = [], token = '', bracket = false, parentheses = false, quote = '', relation: 'descendant' | 'child' = 'descendant';
  let needsToken = true;
  const flush = (): boolean => {
    if (token === '') return true;
    let rest = token, tag: string | undefined, scope: boolean | undefined, id: string | undefined;
    const classes: string[] = [], attributes: { name: string; value?: string }[] = [], positions: BrowserCollectPosition[] = [];
    const head = /^(\*|[a-zA-Z][\w-]*|:scope)/.exec(rest);
    if (head) { if (head[0] === ':scope') scope = true; else tag = head[0].toLowerCase(); rest = rest.slice(head[0].length); }
    while (rest !== '') {
      if (rest.startsWith(':scope') && !scope) { scope = true; rest = rest.slice(6); continue; }
      const position = /^:(nth-child|nth-last-child|nth-of-type|nth-last-of-type)\(([^()]*)\)/i.exec(rest);
      const edge = /^:(first-child|last-child|only-child|first-of-type|last-of-type|only-of-type)\b/i.exec(rest);
      if (position || edge) {
        const name = (position ?? edge)![1]!.toLowerCase();
        const siblings = name.endsWith('of-type') ? 'type' : 'all';
        if (position) {
          // CSS An+B; whitespace may surround the offset sign, never split An.
          const expression = position[2]!.trim().toLowerCase();
          const integer = /^[+-]?\d+$/.test(expression);
          const formula = /^([+-]?\d*)n(?:\s*([+-])\s*(\d+))?$/.exec(expression);
          let a: number, b: number;
          if (expression === 'odd' || expression === 'even') { a = 2; b = expression === 'odd' ? 1 : 0; }
          else if (integer) { a = 0; b = Number(expression); }
          else if (formula) {
            a = formula[1] === '' || formula[1] === '+' ? 1 : formula[1] === '-' ? -1 : Number(formula[1]);
            b = formula[3] === undefined ? 0 : Number(`${formula[2]}${formula[3]}`);
          } else return false;
          // Bounded coefficients also keep matching arithmetic exact.
          if (![a, b].every(n => Number.isSafeInteger(n) && Math.abs(n) <= 1_000_000)) return false;
          positions.push({ siblings, from: name.includes('last') ? 'end' : 'start', a, b });
        } else {
          positions.push({ siblings, from: name.startsWith('last') ? 'end' : 'start', a: 0, b: 1 });
          if (name.startsWith('only')) positions.push({ siblings, from: 'end', a: 0, b: 1 });
        }
        rest = rest.slice((position ?? edge)![0].length); continue;
      }
      const named = /^([.#])([A-Za-z_-][\w-]*)/.exec(rest);
      if (named) {
        if (named[1] === '#') { if (id !== undefined) return false; id = named[2]!; }
        else classes.push(named[2]!);
        rest = rest.slice(named[0].length); continue;
      }
      const attribute = /^\[\s*([A-Za-z][\w:-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([\w.:/-]+))\s*)?\]/.exec(rest);
      if (!attribute) return false;
      const entry = attribute[2] ?? attribute[3] ?? attribute[4];
      attributes.push({ name: attribute[1]!.toLowerCase(), ...(entry !== undefined ? { value: entry } : {}) });
      rest = rest.slice(attribute[0].length);
    }
    if (parts.length >= 8 || classes.length + attributes.length + positions.length > 8) return false;
    parts.push({ relation, ...(tag !== undefined ? { tag } : {}), ...(scope ? { scope } : {}),
      ...(id !== undefined ? { id } : {}), classes, attributes, ...(positions.length ? { positions } : {}) });
    token = ''; relation = 'descendant'; needsToken = false; return true;
  };
  for (const character of value.trim()) {
    if (quote !== '') { token += character; if (character === quote) quote = ''; continue; }
    if (bracket && (character === '"' || character === "'")) { quote = character; token += character; continue; }
    if (character === '[') { if (bracket) return undefined; bracket = true; token += character; continue; }
    if (character === ']') { if (!bracket) return undefined; bracket = false; token += character; continue; }
    if (!bracket && character === '(') { if (parentheses) return undefined; parentheses = true; token += character; continue; }
    if (!bracket && character === ')') { if (!parentheses) return undefined; parentheses = false; token += character; continue; }
    if (!bracket && !parentheses && (character === ',' || character === '>' || /\s/.test(character))) {
      if (!flush()) return undefined;
      if (character === ',') {
        if (needsToken || parts.length === 0 || groups.length >= 3) return undefined;
        groups.push(parts); parts = []; relation = 'descendant'; needsToken = true;
      } else if (character === '>') {
        if (needsToken || parts.length === 0) return undefined;
        relation = 'child'; needsToken = true;
      }
      continue;
    }
    token += character;
  }
  if (bracket || parentheses || quote !== '' || !flush() || needsToken || parts.length === 0) return undefined;
  groups.push(parts); return groups;
};

/** Positional matching needs a negotiated snapshot of the original siblings. */
export const browserCollectNeedsStructure = (spec: BrowserCollectSpec): boolean =>
  [spec.items, ...Object.values(spec.fields).map(field => field.selector),
    ...(spec.next && 'selector' in spec.next ? [spec.next.selector] : [])]
    .some(selector => parseBrowserCollectSelector(selector)?.some(group => group.some(part => part.positions?.length)));

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const extra = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).some(key => !keys.includes(key));
const bounded = (value: unknown, limit: number): value is number => Number.isInteger(value) && (value as number) > 0 && (value as number) <= limit;
const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= 256;
const ATTRIBUTES = ['href', 'src', 'title', 'alt', 'value', 'aria-label', 'name', 'id'];

/** Caller corrections, not page evidence. Values are never echoed, except finite numeric bounds. */
export interface BrowserCollectViolation {
  readonly path: string;
  readonly code: 'invalid_value' | 'required' | 'invalid_type' | 'out_of_range';
  readonly message: string;
  readonly expected_type?: 'integer';
  readonly min?: number;
  readonly max?: number;
  readonly received?: number;
}
export const BROWSER_COLLECT_MAX_VIOLATIONS = 16;

export const parseBrowserCollectSpec = (value: Record<string, unknown>):
  { readonly ok: true; readonly spec: BrowserCollectSpec } | { readonly ok: false; readonly error: string;
    readonly violations: readonly BrowserCollectViolation[]; readonly violations_truncated?: true } => {
  const violations: BrowserCollectViolation[] = [];
  let violationsTruncated = false;
  const invalid = (path: string, message: string, limits?: { min: number; max: number; value: unknown }) => {
    if (violations.length === BROWSER_COLLECT_MAX_VIOLATIONS) { violationsTruncated = true; return; }
    violations.push({ path, code: limits ? limits.value === undefined ? 'required'
      : !Number.isInteger(limits.value) ? 'invalid_type' : 'out_of_range' : 'invalid_value', message,
      ...(limits ? { expected_type: 'integer', min: limits.min, max: limits.max,
        ...(typeof limits.value === 'number' && Number.isFinite(limits.value) ? { received: limits.value } : {}) } : {}) });
  };
  const selectorHelp = 'Use tag, .class, #id, [attribute], spaces, >, :scope or :nth-child/:nth-of-type (integer, odd/even or An+B); other CSS is unsupported.';
  if (!parseBrowserCollectSelector(value.items)) invalid('items', `items needs a selector over cleaned HTML. ${selectorHelp}`);
  const validFields = record(value.fields) && Object.keys(value.fields).length > 0 && Object.keys(value.fields).length <= 8;
  if (!validFields) invalid('fields', 'fields needs 1 to 8 named fields');
  const fields: Record<string, BrowserCollectField> = {};
  for (const [name, raw] of validFields ? Object.entries(value.fields as Record<string, unknown>) : []) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name) || ['constructor', 'prototype'].includes(name)) {
      invalid('fields', `invalid field name ${name.slice(0, 40)}`); continue;
    }
    const field = typeof raw === 'string' ? { selector: raw } : raw;
    if (!record(field) || extra(field, ['selector', 'attribute', 'many', 'required'])) {
      invalid(`fields.${name}`, `field ${name} needs a selector, with optional attribute, many or required`); continue;
    }
    if (!parseBrowserCollectSelector(field.selector)) {
      invalid(`fields.${name}.selector`, `field ${name} has an unsupported selector. ${selectorHelp}`); continue;
    }
    if (field.attribute !== undefined && (typeof field.attribute !== 'string' || !ATTRIBUTES.includes(field.attribute))) invalid(`fields.${name}.attribute`, `field ${name} names an unsupported attribute`);
    for (const key of ['many', 'required']) if (field[key] !== undefined && typeof field[key] !== 'boolean') invalid(`fields.${name}.${key}`, `field ${name}.${key} is true or false`);
    fields[name] = { selector: String(field.selector).trim(), ...(field.attribute !== undefined ? { attribute: field.attribute as BrowserCollectField['attribute'] } : {}),
      ...(field.many !== undefined ? { many: field.many as boolean } : {}), ...(field.required !== undefined ? { required: field.required as boolean } : {}) };
  }
  // 2026-11-21 (D-402, benchmark task I, live) — a bound written above its maximum is read at the maximum, and the collection
  //   says so (`asked`), rather than refused. Asked for a Travel list's 50 pages and 1,000 items in 37 of 57 runs, the model
  //   spent a round on the refusal each time. A bound that is not a whole number of at least 1 is still refused.
  const asked: { max_pages?: number; max_items?: number; max_seconds?: number } = {};
  const atMost = (key: 'max_pages' | 'max_items' | 'max_seconds', raw: unknown, max: number): unknown => {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= max) return raw;
    asked[key] = raw;
    return max;
  };
  const maxPages = atMost('max_pages', value.max_pages, BROWSER_COLLECT_MAX_PAGES);
  if (!bounded(maxPages, BROWSER_COLLECT_MAX_PAGES)) invalid('max_pages', value.max_pages === undefined
    ? `max_pages is required, from 1 to ${BROWSER_COLLECT_MAX_PAGES}` : `max_pages must be an integer from 1 to ${BROWSER_COLLECT_MAX_PAGES}`,
    { min: 1, max: BROWSER_COLLECT_MAX_PAGES, value: value.max_pages });
  const maxItems = atMost('max_items', value.max_items ?? 200, BROWSER_COLLECT_MAX_ITEMS);
  const maxSeconds = atMost('max_seconds', value.max_seconds ?? 60, BROWSER_COLLECT_MAX_SECONDS);
  if (!bounded(maxItems, BROWSER_COLLECT_MAX_ITEMS)) invalid('max_items', `max_items is from 1 to ${BROWSER_COLLECT_MAX_ITEMS}, counting source items including duplicates`,
    { min: 1, max: BROWSER_COLLECT_MAX_ITEMS, value: maxItems });
  if (!bounded(maxSeconds, BROWSER_COLLECT_MAX_SECONDS)) invalid('max_seconds', `max_seconds is from 1 to ${BROWSER_COLLECT_MAX_SECONDS}`,
    { min: 1, max: BROWSER_COLLECT_MAX_SECONDS, value: maxSeconds });
  let next: BrowserCollectSpec['next'];
  if (value.next !== undefined) {
    if (record(value.next) && Object.hasOwn(value.next, 'ref')) invalid('next.ref',
      'next.ref is unsupported: refs belong to one document. Use next:{"text":"Next"} or next:{"selector":"a.next"} from the observed page; do not guess a selector.');
    else if (!record(value.next) || extra(value.next, ['text', 'selector'])) invalid('next',
      'next accepts only {"text":"Next"} or {"selector":"a.next"} from the observed page');
    else if ((value.next.text === undefined) === (value.next.selector === undefined)) invalid('next',
      'next names a link by text or selector, not both: use {"text":"Next"} or {"selector":"a.next"}');
    else if (value.next.text !== undefined) {
      if (!text(value.next.text)) invalid('next.text', 'next.text names the next-page link');
      else next = { text: value.next.text.trim() };
    } else if (!parseBrowserCollectSelector(value.next.selector)) invalid('next.selector', `next.selector needs a selector over cleaned HTML. ${selectorHelp}`);
    else next = { selector: String(value.next.selector).trim() };
  }
  if (typeof value.max_pages === 'number' && value.max_pages > 1 && value.next === undefined) invalid('next', 'next is required when max_pages is greater than 1');
  let dedupe: string[] | undefined;
  if (value.dedupe_by !== undefined) {
    if (!Array.isArray(value.dedupe_by) || value.dedupe_by.length === 0 || value.dedupe_by.length > 8
      || value.dedupe_by.some(key => typeof key !== 'string' || !Object.hasOwn(fields, key))) invalid('dedupe_by', 'dedupe_by is a nonempty list of field names');
    else dedupe = [...new Set(value.dedupe_by)] as string[];
  }
  let where: BrowserCollectSpec['where'];
  if (value.where !== undefined) {
    if (!record(value.where) || extra(value.where, ['field', 'equals']) || typeof value.where.field !== 'string'
      || !Object.hasOwn(fields, value.where.field) || !text(value.where.equals)) invalid('where', 'where needs field and equals, using a declared field');
    else where = { field: value.where.field, equals: value.where.equals };
  }
  if (violations.length) return { ok: false, error: violations[0]!.message, violations,
    ...(violationsTruncated ? { violations_truncated: true } : {}) };
  return { ok: true, spec: { items: String(value.items).trim(), fields, max_pages: maxPages as number, max_items: maxItems as number,
    max_seconds: maxSeconds as number, ...(next !== undefined ? { next } : {}), ...(dedupe !== undefined ? { dedupe_by: dedupe } : {}), ...(where !== undefined ? { where } : {}),
    ...(Object.keys(asked).length > 0 ? { asked } : {}) } };
};
