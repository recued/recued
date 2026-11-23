/** Bounded reasons a retained capture cannot establish complete coverage.
 * No captured values or executable writes are carried with a derived result. */
export interface BrowserSourceIssue {
  kind: 'collection';
  stop_reason: string;
  records: number;
  scanned: number;
  requested_pages: number;
  pages_processed: number;
  coverage_complete: false;
  field?: { name: string; required: boolean; many: boolean; matches: number };
  read_step?: { do: 'read'; page: string; form: 'outline' };
  restart_url?: string;
  recovery_omitted?: true;
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown, max: number) => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= max;
export const isBrowserSourceIssue = (v: unknown): v is BrowserSourceIssue => object(v)
  && Object.keys(v).every(key => ['kind', 'stop_reason', 'records', 'scanned', 'requested_pages', 'pages_processed', 'coverage_complete', 'field', 'read_step', 'restart_url', 'recovery_omitted'].includes(key))
  && v.kind === 'collection' && v.coverage_complete === false && typeof v.stop_reason === 'string' && v.stop_reason.length > 0 && v.stop_reason.length <= 128
  && count(v.records, 5_000) && count(v.scanned, 100_000) && count(v.requested_pages, 20) && Number(v.requested_pages) >= 1 && count(v.pages_processed, 20)
  && (v.field === undefined || object(v.field) && Object.keys(v.field).every(key => ['name', 'required', 'many', 'matches'].includes(key))
    && typeof v.field.name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(v.field.name)
    && typeof v.field.required === 'boolean' && typeof v.field.many === 'boolean' && count(v.field.matches, 5_000))
  && (v.read_step === undefined || object(v.read_step) && Object.keys(v.read_step).every(key => ['do', 'page', 'form'].includes(key))
    && v.read_step.do === 'read' && v.read_step.form === 'outline' && typeof v.read_step.page === 'string'
    && v.read_step.page.length > 0 && v.read_step.page.length <= 512 && !/^https?:/i.test(v.read_step.page))
  && (v.restart_url === undefined || typeof v.restart_url === 'string' && v.restart_url.length <= 512 && /^https?:\/\//i.test(v.restart_url))
  && (v.recovery_omitted === undefined || v.recovery_omitted === true) && JSON.stringify(v).length <= 1_000;
export const isBrowserSourceIssues = (v: unknown): v is BrowserSourceIssue[] => Array.isArray(v) && v.length > 0 && v.length <= 2 && v.every(isBrowserSourceIssue);
