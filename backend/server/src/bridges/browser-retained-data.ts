import { BROWSER_RETAINED_DATA_CHARS, type BrowserRetainedData } from '@recued/contracts';
import type { BrowserDataDescriptor } from './browser-data-store.js';

/** Compact metadata only. Reading a descriptor neither copies the retained rows
 * nor changes their capture coverage, freshness, ownership or expiration. */
export const browserRetainedData = (descriptor: BrowserDataDescriptor, maxChars = BROWSER_RETAINED_DATA_CHARS): BrowserRetainedData => {
  const fields = descriptor.fields.filter(field => field.field.length > 0).slice(0, 12);
  const out: BrowserRetainedData = { data_ref: descriptor.data_ref, kind: descriptor.kind as BrowserRetainedData['kind'],
    ...(descriptor.row_count !== undefined ? { row_count: descriptor.row_count } : {}),
    fields: fields.map(field => ({ field: field.field, types: [...field.types] })),
    fields_complete: descriptor.fields_complete && fields.length === descriptor.fields.length,
    source_complete: descriptor.source_complete, value_omitted: true,
    ...(descriptor.source_issues ? { source_issues: structuredClone(descriptor.source_issues) } : {}),
    ...(descriptor.source_issues_truncated ? { source_issues_truncated: true } : {}) };
  const limit = Math.min(BROWSER_RETAINED_DATA_CHARS - 40, Math.max(256, maxChars));
  while (JSON.stringify(out).length > limit && out.fields.length) { out.fields.pop(); out.fields_complete = false; }
  while (JSON.stringify(out).length > limit && out.source_issues?.length) { out.source_issues.shift(); out.source_issues_truncated = true; }
  if (out.source_issues?.length === 0) delete out.source_issues;
  return out;
};
