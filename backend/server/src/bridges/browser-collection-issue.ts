import { isBrowserSourceIssue, type BrowserSourceIssue } from '@recued/contracts';
import type { BrowserCollection } from './browser-collect.js';

export const browserCollectionIssue = (collection: BrowserCollection): BrowserSourceIssue[] | undefined => {
  if (collection.coverage.complete) return undefined;
  const field = collection.field_failure;
  const issue: BrowserSourceIssue = { kind: 'collection', stop_reason: collection.stop_reason, records: collection.count, scanned: collection.scanned,
    requested_pages: collection.coverage.page_limit, pages_processed: collection.coverage.pages_processed, coverage_complete: false,
    ...(field ? { field: { name: field.field, required: field.required, many: field.many, matches: field.matches },
      ...(field.read_step ? { read_step: field.read_step } : {}),
      ...(field.restart_url && field.restart_url.length <= 512 ? { restart_url: field.restart_url } : {}) } : {}) };
  if (JSON.stringify(issue).length > 1_000) { delete issue.restart_url; issue.recovery_omitted = true; }
  if (JSON.stringify(issue).length > 1_000) { delete issue.read_step; issue.recovery_omitted = true; }
  return isBrowserSourceIssue(issue) ? [issue] : undefined;
};
