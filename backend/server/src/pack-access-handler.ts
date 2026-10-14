/** D-322 §24 — isolated owner diagnostics; no recipe, grant or vendor write. */
import { createHash } from 'node:crypto';
import {
  RpcError, isPackAccessCheck, packAccessDefinition, packAccessInput, validatePackAccessChecks,
  type BulkPackManifest, type ConnectionAuth, type ConnectionRow, type PackAccessCheck, type PackAccessPlan,
  type PackAccessRequest, type PackAccessResponse, type PackAccessResult, type PackConnectionsView,
} from '@recued/contracts';
import { createEnsureFreshAuth, injectConnectionApiAuth } from '@recued/ingredients';
import { decodeAuthFromStorage, encodeAuthForStorage, type ConnectionRpcDeps } from './connection-handler.js';

export interface PackAccessDeps {
  connections: ConnectionRpcDeps;
  view(pack: string): Promise<PackConnectionsView>;
  manifest(pack: string): BulkPackManifest | null;
  installed(pack: string): { publisher?: string; version?: number } | null;
}

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rowIdentity = (row: ConnectionRow): unknown => [
  row.pk, row.name, row.kind, row.enrolled_at, row.config_json, row.auth_ciphertext,
  row.subresource_path, row.granted_scopes_json, row.display_name, row.subtype,
];
const conflict = (): RpcError => new RpcError('conflict', 'The pack, account or connection changed. Refresh the access check before trying again.');
const requestText = (v: unknown): v is string => typeof v === 'string'
  && v.length > 0 && v.length <= 200 && !/[\r\n\0]/.test(v);

const parseRequest = (args: unknown): PackAccessRequest => {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new RpcError('bad_request', 'A pack access check is required.');
  const a = args as Record<string, unknown>;
  if (typeof a.action !== 'string' || !['plan', 'check'].includes(a.action)
    || !requestText(a.pack_slug) || !requestText(a.slot) || !requestText(a.connection_name)
    || Object.keys(a).some(k => !['action', 'pack_slug', 'slot', 'connection_name', 'fingerprint', 'check_id', 'input'].includes(k))) {
    throw new RpcError('bad_request', 'Choose a pack, slot and saved connection for the access check.');
  }
  if (a.action === 'check' && (typeof a.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(a.fingerprint)
    || !requestText(a.check_id) || a.input !== undefined && (typeof a.input !== 'string' || a.input.length > 2048))) {
    throw new RpcError('bad_request', 'Review the access check and enter a valid resource ID.');
  }
  return a as unknown as PackAccessRequest;
};

/** Reject mismatched API roots even when the vendor tag or origin happens to match. */
const sameBase = (configured: unknown, authored: string): boolean => {
  if (typeof configured !== 'string') return false;
  try {
    const a = new URL(configured); const b = new URL(authored);
    return a.protocol === 'https:' && !a.username && !a.password && !a.search && !a.hash
      && !/[\\%]/.test(a.pathname) && a.origin === b.origin
      && a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '');
  } catch { return false; }
};

const configOf = (row: ConnectionRow): Record<string, unknown> => {
  try { const v: unknown = JSON.parse(row.config_json); if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>; }
  catch { /* Invalid saved config has no testable endpoint. */ }
  return {};
};

export const createPackAccessHandler = (deps: PackAccessDeps) => {
  const rpc = deps.connections;
  const now = rpc.now ?? Date.now;
  const nativeFetch = rpc.resolveFetch ?? globalThis.fetch.bind(globalThis);
  const boundedFetch: typeof fetch = (url, init) => nativeFetch(url, {
    ...init, redirect: 'error', credentials: 'omit',
    signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  // Share a refresh gate across checks; only the normal encrypted token cache is written.
  const activeRefresh = new Map<string, { persisted?: ConnectionRow; failed: boolean }>();
  const freshAuth = createEnsureFreshAuth({
    fetchImpl: boundedFetch, now,
    persistAuth: async (row, auth, configPatch) => {
      const active = activeRefresh.get(row.name);
      const current = rpc.store.get('api', row.name);
      if (!active || !current || hash(rowIdentity(current)) !== hash(rowIdentity(row))) throw conflict();
      const encrypted = await encodeAuthForStorage(auth, { kind: 'api', name: row.name }, rpc.getEncryptionKey);
      if (!rpc.store.persistRefreshedAuth?.(row, encrypted, Math.max(now(), row.updated_at + 1), configPatch)) throw conflict();
      active.persisted = rpc.store.get('api', row.name) ?? undefined;
    },
    onPersistFailure: (row) => { const active = activeRefresh.get(row.name); if (active) active.failed = true; },
  });

  const snapshot = async (request: PackAccessRequest) => {
    const installed = deps.installed(request.pack_slug);
    if (!installed) throw new RpcError('not_found', 'This pack is no longer installed.');
    const view = await deps.view(request.pack_slug);
    const slot = view.slots.find(s => s.slot === request.slot);
    if (!slot?.connections.some(c => c.connection_name === request.connection_name && c.enrolled)) {
      throw new RpcError('bad_request', 'This saved connection is not on the pack’s list. Refresh its connections.');
    }
    const row = rpc.store.get('api', request.connection_name);
    if (!row) throw new RpcError('not_found', 'The API connection is no longer saved.');
    const manifest = deps.manifest(request.pack_slug);
    const currentPack = deps.installed(request.pack_slug);
    if (JSON.stringify(installed) !== JSON.stringify(currentPack)) throw conflict();
    let unavailable: PackAccessPlan['unavailable_reason'];
    if (!manifest || manifest.version !== installed.version || manifest.publisher !== installed.publisher) unavailable = 'pack_update_required';
    else if (installed.publisher !== 'recued-core' || !manifest.connection_access_checks?.length) unavailable = 'not_declared';
    else if (validatePackAccessChecks(manifest).length) unavailable = 'not_declared';
    const checks = unavailable || !manifest ? [] : manifest.connection_access_checks!.filter(c => {
      if (!isPackAccessCheck(c) || !slot.catalogs.includes(c.catalog)) return false;
      const def = packAccessDefinition(manifest, c);
      return def?.slot === request.slot && sameBase(configOf(row).base_url, def.base_url);
    });
    if (!unavailable && checks.length === 0) unavailable = 'unsupported_connection';
    const authority = hash([installed, manifest, slot, rpc.managedOAuth?.diagnosticProfileSignature?.()]);
    const fingerprint = hash([authority, rowIdentity(row)]);
    const operations = manifest?.contents?.flatMap(c => c.type === 'composition' ? c.composition.operations ?? [] : []) ?? [];
    const plan: PackAccessPlan = {
      action: 'plan', pack_slug: request.pack_slug, slot: request.slot, connection_name: request.connection_name,
      fingerprint, connection_updated_at: row.updated_at,
      checks: checks.map(check => ({
        id: check.id, label: check.label, operation: check.operation,
        required_scopes: packAccessDefinition(manifest!, check)!.operation.required_scopes ?? [],
        ...(check.input ? { input: check.input } : {}),
      })),
      other_operation_count: Math.max(0, operations.length - new Set(checks.map(c => c.operation)).size),
      ...(unavailable ? { unavailable_reason: unavailable } : {}),
    };
    return { row, manifest, checks, plan, authority };
  };

  const assertCurrent = async (request: PackAccessRequest, fingerprint: string): Promise<void> => {
    try { if ((await snapshot(request)).plan.fingerprint === fingerprint) return; }
    catch { /* Lost pack, binding or account is stale work, too. */ }
    throw conflict();
  };
  const result = (plan: PackAccessPlan, check: PackAccessCheck, status: PackAccessResult['status'],
    reason: PackAccessResult['reason'], http_status?: number): PackAccessResult => ({
    action: 'check', pack_slug: plan.pack_slug, slot: plan.slot, connection_name: plan.connection_name,
    fingerprint: plan.fingerprint, connection_updated_at: plan.connection_updated_at,
    check_id: check.id, status, reason, checked_at: now(), ...(http_status ? { http_status } : {}),
  });

  type Review = Awaited<ReturnType<typeof snapshot>>;
  type Prepared = { current: Review; auth?: ConnectionAuth; stop?: PackAccessResult['reason'];
    account?: { identity?: string; profile_revision: number; auth_error: boolean } };

  const prepare = async (request: PackAccessRequest, prepared: Prepared): Promise<void> => {
    const initial = prepared.current;
    if (rpc.getEncryptionKey && !rpc.getEncryptionKey()) { prepared.stop = 'auth_unavailable'; return; }
    const decoded = await decodeAuthFromStorage(initial.row.auth_ciphertext, { kind: 'api', name: initial.row.name }, rpc.getEncryptionKey);
    await assertCurrent(request, initial.plan.fingerprint);
    if (decoded.type === 'none' || decoded.type === 'body_field') { prepared.stop = 'unsupported_auth'; return; }
    const refresh: { persisted?: ConnectionRow; failed: boolean } = { failed: false };
    activeRefresh.set(initial.row.name, refresh);
    try { prepared.auth = await freshAuth(initial.row, decoded); }
    finally { activeRefresh.delete(initial.row.name); }
    if (refresh.failed) { prepared.stop = 'auth_unavailable'; return; }
    if (refresh.persisted) {
      const next = await snapshot(request);
      // Accept only our token-cache update, never a changed binding or configuration.
      const old = { ...initial.row, auth_ciphertext: refresh.persisted.auth_ciphertext };
      if (hash(rowIdentity(old)) !== hash(rowIdentity(next.row)) || initial.authority !== next.authority) throw conflict();
      prepared.current = next;
    }
    await assertCurrent(request, prepared.current.plan.fingerprint);
    if (prepared.auth.type === 'managed_oauth') {
      prepared.account = await rpc.managedOAuth?.inspectAccount?.(prepared.auth);
      if (!prepared.account?.identity) prepared.stop = 'auth_unavailable';
      else if (prepared.account.auth_error) prepared.stop = 'access_denied';
    }
  };

  const readProbe = async (request: PackAccessRequest, prepared: Prepared, check: PackAccessCheck, unsigned: URL): Promise<PackAccessResult> => {
    const plan = prepared.current.plan;
    if (prepared.stop) return result(plan, check, prepared.stop === 'access_denied' ? 'denied' : 'unverified', prepared.stop);
    const auth = prepared.auth!;
    await assertCurrent(request, plan.fingerprint);
    const headers = new Headers({ Accept: 'application/json' });
    const authenticated = new URL(unsigned);
    injectConnectionApiAuth(auth, headers, authenticated, { method: 'GET', nowMs: now() });
    const response = auth.type === 'managed_oauth'
      ? await rpc.managedOAuth?.fetch(auth, authenticated.toString(), { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(15_000) })
      : await boundedFetch(authenticated, { method: 'GET', headers });
    if (!response) return result(plan, check, 'unverified', 'auth_unavailable');
    const status = response.status;
    void response.body?.cancel().catch(() => {});
    if (status === 401 || status === 403) return result(plan, check, 'denied', 'access_denied', status);
    if (status === 404) return result(plan, check, 'unverified', 'resource_not_found', status);
    if (!response.ok) return result(plan, check, 'unverified', 'provider_error', status);
    await assertCurrent(request, plan.fingerprint);
    const anonymous = await boundedFetch(unsigned, { method: 'GET', headers: { Accept: 'application/json' } });
    void anonymous.body?.cancel().catch(() => {});
    return [401, 403].includes(anonymous.status)
      ? result(plan, check, 'passed', 'protected_read_passed', status)
      : result(plan, check, 'unverified', 'public_resource', status);
  };

  const assertAccount = async (prepared: Prepared): Promise<void> => {
    if (prepared.auth?.type !== 'managed_oauth' || prepared.stop) return;
    const after = await rpc.managedOAuth?.inspectAccount?.(prepared.auth);
    if (!after?.identity || after.identity !== prepared.account?.identity
      || after.profile_revision !== prepared.account.profile_revision || after.auth_error) throw conflict();
  };

  const selected = (review: Review, id: string): PackAccessCheck => {
    const check = review.checks.find(c => c.id === id);
    if (!check || !review.manifest) throw new RpcError('bad_request', 'This pack has no declared read check for this selection.');
    return check;
  };
  const resourceUrl = (review: Review, check: PackAccessCheck, raw: unknown): URL => {
    let input: string | undefined;
    try { input = packAccessInput(check.input, raw); }
    catch { throw new RpcError('bad_request', 'Enter a valid resource ID or supported resource URL.'); }
    const definition = packAccessDefinition(review.manifest!, check)!;
    const path = input === undefined ? definition.path : definition.path.replace('{{' + check.input!.key + '}}', encodeURIComponent(input));
    const url = new URL(definition.base_url.replace(/\/$/, '') + path);
    for (const [name, value] of Object.entries(definition.query)) url.searchParams.set(name, value);
    return url;
  };
  const run = async (request: Extract<PackAccessRequest, { action: 'check' }>): Promise<PackAccessResult> => {
    const initial = await snapshot(request);
    if (initial.plan.fingerprint !== request.fingerprint) throw conflict();
    const check = selected(initial, request.check_id);
    const unsigned = resourceUrl(initial, check, request.input);
    const prepared: Prepared = { current: initial };
    let outcome: PackAccessResult;
    try {
      await prepare(request, prepared);
      outcome = await readProbe(request, prepared, check, unsigned);
      await assertAccount(prepared);
    } catch (error) {
      if (error instanceof RpcError && error.code === 'conflict') throw error;
      outcome = result(prepared.current.plan, check, 'unverified', 'unreachable');
    }
    await assertCurrent(request, prepared.current.plan.fingerprint);
    return { ...outcome, fingerprint: initial.plan.fingerprint,
      ...(prepared.current.plan.fingerprint !== initial.plan.fingerprint
        ? { next_fingerprint: prepared.current.plan.fingerprint } : {}) };
  };

  // Different accounts may be checked concurrently; one credential refresh per account.
  const checking = new Set<string>();
  return async (args: unknown): Promise<PackAccessResponse> => {
    const request = parseRequest(args);
    if (request.action === 'plan') return (await snapshot(request)).plan;
    if (checking.has(request.connection_name)) {
      const review = await snapshot(request);
      if (review.plan.fingerprint !== request.fingerprint) throw conflict();
      return result(review.plan, selected(review, request.check_id), 'unverified', 'check_in_progress');
    }
    checking.add(request.connection_name);
    try { return await run(request); } finally { checking.delete(request.connection_name); }
  };
};
