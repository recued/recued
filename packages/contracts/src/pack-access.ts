/** D-322 §24 — owner-only, bounded read checks for an installed pack's account. */
import type { BulkPackManifest } from './bulk-pack.js';
import type { PackConnectionChange } from './pack-connections.js';
import { publisherMayDeclare } from './publisher-trust.js';

export interface PackAccessCheck {
  id: string;
  label: string;
  catalog: string;
  operation: string;
  /** Only response masks and small list limits; never owner-supplied query fields. */
  query?: Readonly<Record<string, string>>;
  input?: {
    key: string;
    label: string;
    format: 'id' | 'google_spreadsheet';
    default_value?: string;
  };
}

export interface PackAccessCheckView {
  id: string;
  label: string;
  operation: string;
  required_scopes: readonly string[];
  input?: PackAccessCheck['input'];
}

export interface PackAccessPlan extends PackConnectionChange {
  action: 'plan';
  fingerprint: string;
  connection_updated_at: number;
  checks: readonly PackAccessCheckView[];
  /** Other operations, including writes, remain unverified after these checks. */
  other_operation_count: number;
  unavailable_reason?: 'not_declared' | 'pack_update_required' | 'unsupported_connection';
}

export type PackAccessStatus = 'passed' | 'denied' | 'unverified';
export type PackAccessReason = 'protected_read_passed' | 'access_denied' | 'resource_not_found'
  | 'public_resource' | 'provider_error' | 'unreachable' | 'auth_unavailable' | 'unsupported_auth' | 'check_in_progress';

export interface PackAccessResult extends PackConnectionChange {
  action: 'check';
  fingerprint: string;
  /** Continue this review only across the diagnostic's own fenced token-cache update. */
  next_fingerprint?: string;
  connection_updated_at: number;
  check_id: string;
  status: PackAccessStatus;
  reason: PackAccessReason;
  checked_at: number;
  http_status?: number;
}

export type PackAccessRequest = PackConnectionChange & (
  | { action: 'plan' }
  | { action: 'check'; fingerprint: string; check_id: string; input?: string }
);
export type PackAccessResponse = PackAccessPlan | PackAccessResult;

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const shortText = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= 200 && !/[\r\n\0]/.test(v);
const key = (v: unknown): v is string =>
  shortText(v) && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(v) && !['constructor', 'prototype', '__proto__'].includes(v);
const inputShape = (v: unknown): v is NonNullable<PackAccessCheck['input']> => {
  if (!record(v) || !key(v.key) || !shortText(v.label) || typeof v.format !== 'string'
    || !['id', 'google_spreadsheet'].includes(v.format)
    || Object.keys(v).some(k => !['key', 'label', 'format', 'default_value'].includes(k))) return false;
  if (v.default_value === undefined) return true;
  if (!shortText(v.default_value)) return false;
  try { packAccessInput(v as unknown as PackAccessCheck['input'], v.default_value); return true; }
  catch { return false; }
};

/** Keep the probe vocabulary narrower than ordinary operations. */
const queryShape = (v: unknown): boolean => {
  if (v === undefined) return true;
  if (!record(v) || Object.keys(v).length > 4) return false;
  return Object.entries(v).every(([name, value]) => {
    if (typeof value !== 'string' || value.length > 256) return false;
    if (name === 'maxResults' || name === '$top') return /^[1-5]$/.test(value);
    if (name === 'fields') return /^[a-zA-Z0-9_.,/()*]+$/.test(value);
    if (name === '$select') return /^[a-zA-Z0-9_,]+$/.test(value);
    return false;
  });
};

export const isPackAccessCheck = (v: unknown): v is PackAccessCheck => record(v)
  && key(v.id) && shortText(v.label) && shortText(v.catalog) && shortText(v.operation)
  && queryShape(v.query) && (v.input === undefined || inputShape(v.input))
  && Object.keys(v).every(k => ['id', 'label', 'catalog', 'operation', 'query', 'input'].includes(k));

/** Both admission and runtime use the authored GET, never a URL from the browser. */
export const packAccessDefinition = (manifest: BulkPackManifest, check: PackAccessCheck) => {
  if (!Array.isArray(manifest.contents)) return undefined;
  const content = manifest.contents.find(c => c && c.type === 'composition' && c.composition?.slug === check.catalog);
  if (content?.type !== 'composition' || !Array.isArray(content.composition.operations)) return undefined;
  const operation = content.composition.operations.find(op => op && op.op === check.operation);
  if (!operation || operation.risk !== 'read' || !record(operation.bind) || operation.bind.kind !== 'rest'
    || operation.bind.method !== 'GET') return undefined;
  if (!Array.isArray(content.composition.ingredients)) return undefined;
  const ingredient = content.composition.ingredients.find(i => i && i.slug === operation.ingredient);
  const http = ingredient?.http;
  if (!http || typeof http.base !== 'string' || typeof http.connection !== 'string') return undefined;
  const path = operation.bind.path_template;
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')
    || /[\\%?#\r\n\0]/.test(path) || path.split('/').some(p => p === '.' || p === '..')) return undefined;
  const placeholders = [...path.matchAll(/\{\{([^{}]+)\}\}/g)].map(match => match[1]);
  if (/[{}]/.test(path.replace(/\{\{[^{}]+\}\}/g, ''))) return undefined;
  if (check.input ? placeholders.length !== 1 || placeholders[0] !== check.input.key : placeholders.length !== 0) return undefined;
  if (operation.args !== undefined && !Array.isArray(operation.args)) return undefined;
  if (operation.args?.some(a => typeof a !== 'string' && (!record(a) || typeof a.key !== 'string'))) return undefined;
  if (operation.args?.some(a => typeof a !== 'string' && a.required && a.key !== check.input?.key
    && (!a.key.startsWith('query.') || !Object.hasOwn(check.query ?? {}, a.key.slice(6))))) return undefined;
  if (operation.bind.static_query !== undefined && !record(operation.bind.static_query)) return undefined;
  const authoredQuery = operation.bind.static_query ?? {};
  if (Object.values(authoredQuery).some(v => !['string', 'number', 'boolean'].includes(typeof v)
    || typeof v === 'string' && /[{}\r\n\0]/.test(v) || typeof v === 'number' && !Number.isFinite(v))) return undefined;
  const query: Record<string, string> = {};
  for (const [name, value] of Object.entries(authoredQuery)) query[name] = String(value);
  Object.assign(query, check.query);
  if (Object.entries(query).some(([name, value]) => /[{}\r\n\0]/.test(name + value)
    || ['maxResults', '$top'].includes(name) && !/^[1-5]$/.test(value))) return undefined;
  return { base_url: http.base, slot: http.connection, path, operation,
    query };
};

export const validatePackAccessChecks = (value: unknown): string[] => {
  if (!record(value) || value.connection_access_checks === undefined) return [];
  const checks = value.connection_access_checks;
  if (!Array.isArray(checks) || checks.length > 8) return ['connection_access_checks must be an array of at most 8 checks'];
  if (checks.length && !publisherMayDeclare(value.publisher, 'connection_access_checks')) {
    return ['connection_access_checks is reserved for the recued-core publisher'];
  }
  const seen = new Set<string>();
  const issues: string[] = [];
  for (const check of checks) {
    if (!isPackAccessCheck(check)) { issues.push('access check has an invalid shape'); continue; }
    if (seen.has(check.id)) issues.push('access check IDs must be unique');
    seen.add(check.id);
    if (!packAccessDefinition(value as unknown as BulkPackManifest, check)) issues.push('access check must name a bounded read-only GET on its own catalog');
  }
  return issues;
};

export const packAccessInput = (input: PackAccessCheck['input'], raw: unknown): string | undefined => {
  if (!input) { if (raw !== undefined && raw !== '') throw new Error('This check takes no resource ID.'); return undefined; }
  if (typeof raw !== 'string' || raw.length > 2048) throw new Error('Enter a valid resource ID.');
  let value = raw.trim();
  if (input.format === 'google_spreadsheet' && value.startsWith('https://')) {
    const url = new URL(value);
    const match = /^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)(?:\/edit)?\/?$/.exec(url.pathname);
    if (url.origin !== 'https://docs.google.com' || url.username || url.password || !match) throw new Error('Enter a Google Sheets URL or spreadsheet ID.');
    value = match[1]!;
  }
  if (!/^[a-zA-Z0-9_@.+!:=-]{1,200}$/.test(value) || value === '.' || value === '..') throw new Error('Enter a valid resource ID.');
  return value;
};

/** Mixed-version or malformed replies must not render a successful access check. */
export const isPackAccessResponse = (value: unknown): value is PackAccessResponse => {
  if (!record(value) || !shortText(value.pack_slug) || !shortText(value.slot) || !shortText(value.connection_name)
    || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || !Number.isSafeInteger(value.connection_updated_at) || Number(value.connection_updated_at) < 0) return false;
  if (value.action === 'plan') return Array.isArray(value.checks) && value.checks.length <= 8
    && value.checks.every(c => record(c) && key(c.id) && shortText(c.label) && shortText(c.operation)
      && Array.isArray(c.required_scopes) && c.required_scopes.length <= 256 && c.required_scopes.every(shortText)
      && (c.input === undefined || inputShape(c.input)))
    && Number.isSafeInteger(value.other_operation_count) && Number(value.other_operation_count) >= 0
    && (value.unavailable_reason === undefined || typeof value.unavailable_reason === 'string'
      && ['not_declared', 'pack_update_required', 'unsupported_connection'].includes(value.unavailable_reason));
  return value.action === 'check' && key(value.check_id) && typeof value.status === 'string' && typeof value.reason === 'string'
    && (value.next_fingerprint === undefined || typeof value.next_fingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.next_fingerprint))
    && ['passed', 'denied', 'unverified'].includes(value.status)
    && ['protected_read_passed', 'access_denied', 'resource_not_found', 'public_resource', 'provider_error', 'unreachable', 'auth_unavailable', 'unsupported_auth', 'check_in_progress'].includes(value.reason)
    && (value.status === 'passed' ? value.reason === 'protected_read_passed' && Number(value.http_status) >= 200 && Number(value.http_status) <= 299
      : value.status === 'denied' ? value.reason === 'access_denied' : !['protected_read_passed', 'access_denied'].includes(value.reason))
    && Number.isSafeInteger(value.checked_at) && Number(value.checked_at) >= 0
    && (value.http_status === undefined || Number.isSafeInteger(value.http_status) && Number(value.http_status) >= 100 && Number(value.http_status) <= 599);
};
