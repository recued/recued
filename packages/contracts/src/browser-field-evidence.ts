export interface BrowserEvidenceValue { value: string; source: 'textContent' | 'title' | 'aria-label' | 'alt' | 'figcaption.textContent' | 'containing-cell.textContent'; truncated?: true }
export interface BrowserEvidenceItem { tag: string; ref?: string; fields: Record<string, BrowserEvidenceValue> }
export interface BrowserFieldEvidence { scope: 'page' | 'main' | 'region'; items: BrowserEvidenceItem[]; complete: boolean; incomplete?: string[]; note: string }

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);
const oneOf = (value: unknown, allowed: readonly string[]) => typeof value === 'string' && allowed.includes(value);

/** Shared by ordinary observations and passive views without a failure/view import cycle. */
export const isBrowserFieldEvidence = (value: unknown): value is BrowserFieldEvidence => record(value) && keys(value, ['scope', 'items', 'complete', 'incomplete', 'note'])
  && oneOf(value.scope, ['page', 'main', 'region']) && typeof value.complete === 'boolean' && text(value.note, 300)
  && optional(value.incomplete, value => Array.isArray(value) && value.length <= 8 && value.every(item => oneOf(item,
    ['page_truncated', 'source_limit', 'node_limit', 'depth_limit', 'value_truncated', 'item_limit', 'character_limit', 'observation_limit'])))
  && Array.isArray(value.items) && value.items.length <= 16 && value.items.every(item => record(item)
    && keys(item, ['tag', 'ref', 'fields']) && oneOf(item.tag, ['a', 'img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
    && optional(item.ref, value => text(value, 32) && /^e\d+$/.test(value))
    && record(item.fields) && keys(item.fields, ['text', 'title_attribute', 'aria_label', 'alt', 'caption', 'nearby_text'])
    && Object.values(item.fields).every(field => record(field) && keys(field, ['value', 'source', 'truncated']) && text(field.value, 1_000)
      && oneOf(field.source, ['textContent', 'title', 'aria-label', 'alt', 'figcaption.textContent', 'containing-cell.textContent'])
      && optional(field.truncated, value => value === true)));
