/** D-322 §26 — reviewed bulk plans; every saved row uses the durable switch handler. */
import { createHash, randomUUID } from 'node:crypto';
import {
  RpcError, CONNECTION_CREDENTIAL_ROTATION_ATTEMPT_ID_REGEX, MANAGED_OAUTH_MIGRATION_LIMIT,
  managedOAuthVerificationUrl,
  type ConnectionRow, type AuthenticationSwitchAuthorization, type ManagedOAuthMigrationRequest,
  type ManagedOAuthMigrationResponse, type ManagedOAuthMigrationView, type ManagedOAuthMigrationRow,
  type ManagedOAuthImpactPreview,
} from '@recued/contracts';
import type { ManagedOAuthService, ManagedOAuthMigrationAuthority } from './managed-oauth-service.js';
import { verifyManagedOAuthAccess } from './managed-oauth-verification.js';
import { verifyDirectOAuthAccess } from './managed-oauth-verification.js';
import type { DirectOAuthMigrationAuthority, createDirectOAuthSwitch } from './direct-oauth-switch.js';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rowHash = (row: ConnectionRow): string => hash([row.pk, row.updated_at, row.config_json, row.auth_ciphertext,
  row.display_name, row.subtype, row.subresource_path, row.granted_scopes_json]);
// Earlier selected rows can join this account through their own approved swaps.
// Every other shared user and this row's account/use must still match its review.
const impactHash = (impact: ManagedOAuthImpactPreview | undefined, name: string, selected: readonly string[]): string =>
  hash([impact?.current, impact?.target, impact?.file_source, impact?.connections.filter(c => c.name === name || !selected.includes(c.name))]);
interface Plan {
  view: ManagedOAuthMigrationView; signature: string; expected: Map<string, string>; names: string[];
  authority?: ManagedOAuthMigrationAuthority | DirectOAuthMigrationAuthority; stopped: boolean; request: string; direct: boolean;
}
export const createManagedOAuthMigration = (deps: {
  broker: ManagedOAuthService; rows(): ConnectionRow[]; fetchImpl: typeof fetch; now(): number;
  direct?: ReturnType<typeof createDirectOAuthSwitch>;
  apply(input: { auth: AuthenticationSwitchAuthorization; name: string; revision: number; url: string; attempt_id: string;
    impact_fingerprint: string; beforeSwap(): void }): Promise<void>;
  changed?(): void;
}) => {
  const plans = new Map<string, Plan>();
  const broker = deps.broker;
  const enabled = (): void => {
    if (!broker.migrationCandidates || !broker.migrationSignature || !broker.claimMigration || !broker.verifyImpact) {
      throw new RpcError('not_configured', 'Upgrade the server to use bulk authentication migration.');
    }
  };
  const prune = (): void => {
    for (const [id, plan] of plans) {
      if (plan.view.expires_at > deps.now()) continue;
      plan.stopped = true; plan.authority?.close(); plan.authority = undefined;
      if (plan.view.state === 'ready' || plan.view.state === 'preparing') plan.view.state = 'expired';
      if (plan.view.expires_at + 30 * 60_000 <= deps.now() && plan.view.state !== 'applying') plans.delete(id);
    }
  };
  const assertCurrent = (plan: Plan): void => {
    if (plan.stopped || plan.view.expires_at <= deps.now()) throw new RpcError('conflict', 'The migration was stopped or expired.');
    if ((plan.direct ? broker.directMigrationSignature!(plan.names) : broker.migrationSignature!(plan.names)) !== plan.signature) throw new RpcError('conflict', 'Permission needs or local use changed after review.');
    if (plan.direct && plan.authority && 'renewals' in plan.authority) {
      for (const change of plan.authority.renewals()) {
        if (plan.expected.get(change.previous.name) === rowHash(change.previous)) {
          plan.expected.set(change.previous.name, rowHash(change.current));
        }
      }
    }
    const rows = deps.rows();
    for (const [name, expected] of plan.expected) {
      const row = rows.find(r => r.kind === 'api' && r.name === name);
      if (!row || rowHash(row) !== expected) throw new RpcError('conflict', 'A selected connection changed after review.');
    }
  };
  const failed = (row: ManagedOAuthMigrationRow, error: unknown, stopped = false): void => {
    const code = error instanceof RpcError ? error.code : undefined;
    row.state = stopped ? 'skipped' : 'failed';
    row.reason = stopped ? 'stopped' : code === 'conflict' ? 'changed' : code === 'credential_verification_failed' ? 'access_failed' : 'unavailable';
    const reason = error instanceof RpcError ? error.details?.reason : undefined;
    const status = typeof reason === 'string' ? /^http_status_([1-5]\d\d)$/.exec(reason)?.[1] : undefined;
    if (status) row.http_status = Number(status);
  };
  const publicView = (plan: Plan): ManagedOAuthMigrationView => structuredClone(plan.view);
  const check = async (plan: Plan): Promise<void> => {
    for (const row of plan.view.rows) {
      let issued: Awaited<ReturnType<ManagedOAuthMigrationAuthority['issue'] | DirectOAuthMigrationAuthority['issue']>> | undefined;
      try {
        assertCurrent(plan); issued = await plan.authority!.issue(row.connection.name);
        row.impact = issued.impact; plan.view.target ??= issued.impact.target;
        if (issued.auth.type === 'direct_oauth') {
          const direct = await deps.direct!.resolve(issued.auth, row.connection.name, row.connection.updated_at, issued.impact.fingerprint);
          await direct.verify();
          const fileHealth = await broker.verifyFileSourceSwitch?.(row.connection.name, direct.auth);
          if (!fileHealth) await verifyDirectOAuthAccess({ fetchImpl: deps.fetchImpl, now: deps.now }, direct.auth, row.connection.verification_url);
          await direct.verify();
        } else {
          const fileHealth = await broker.verifyFileSourceSwitch?.(row.connection.name, issued.auth);
          if (!fileHealth) await verifyManagedOAuthAccess({ broker, fetchImpl: deps.fetchImpl, now: deps.now }, issued.auth, row.connection.verification_url);
        }
        assertCurrent(plan); row.state = 'verified';
      } catch (error) { failed(row, error, plan.stopped); }
      finally { issued?.retire(); }
    }
    plan.view.state = plan.stopped ? 'stopped' : 'ready';
    try {
      assertCurrent(plan);
      if (plan.view.rows.some(row => row.impact && JSON.stringify(row.impact.target) !== JSON.stringify(plan.view.target))) {
        throw new RpcError('conflict', 'The selected account changed during verification.');
      }
    } catch (error) {
      for (const row of plan.view.rows) if (row.state === 'verified') failed(row, error, plan.stopped);
    }
    plan.view.fingerprint = hash(plan.view);
    if (plan.stopped) { plan.authority?.close(); plan.authority = undefined; }
    deps.changed?.();
  };
  const prepare = async (args: Extract<ManagedOAuthMigrationRequest, { action: 'migration_prepare' }>): Promise<ManagedOAuthMigrationResponse> => {
    if (typeof args.id !== 'string' || !CONNECTION_CREDENTIAL_ROTATION_ATTEMPT_ID_REGEX.test(args.id)
      || !Array.isArray(args.selections) || args.selections.length === 0 || args.selections.length > MANAGED_OAUTH_MIGRATION_LIMIT
      || args.selections.some(s => !s || typeof s !== 'object' || typeof s.name !== 'string' || !s.name
        || !Number.isSafeInteger(s.expected_updated_at) || s.expected_updated_at < 0 || typeof s.verification_url !== 'string')
      || new Set(args.selections.map(s => s?.name)).size !== args.selections.length) throw new RpcError('bad_request', 'Select up to 20 unique API connections.');
    const request = hash(args);
    const old = plans.get(args.id);
    if (old) {
      if (old.request !== request) throw new RpcError('conflict', 'This migration ID already belongs to another review.');
      return { action: 'migration_prepare', migration: publicView(old) };
    }
    if (!args.auth || !['managed_oauth', 'direct_oauth'].includes(args.auth.type) || typeof args.impact_fingerprint !== 'string'
      || !Array.isArray(args.auth.requested_scopes) || args.auth.requested_scopes.some(s => typeof s !== 'string')
      || !/^[a-f0-9]{64}$/.test(args.impact_fingerprint)) throw new RpcError('bad_request', 'Review a verified OAuth authorization before preparing.');
    const direct = args.auth.type === 'direct_oauth';
    if (direct && (!deps.direct || !broker.directMigrationSignature)) throw new RpcError('not_configured', 'Upgrade the server to migrate to direct OAuth.');
    const candidates = await broker.migrationCandidates!();
    const rows = args.selections.map(selection => {
      try {
        if ([...new URL(selection.verification_url).searchParams.keys()].some(key => /^(?:access_token|refresh_token|client_secret|api_key|token|authorization)$/i.test(key))) {
          throw new RpcError('bad_request', 'Use a protected resource URL without credentials in its query.');
        }
      } catch (error) { if (error instanceof RpcError) throw error; }
      const candidate = candidates.find(c => c.name === selection.name);
      const url = candidate && typeof selection.verification_url === 'string'
        ? managedOAuthVerificationUrl(candidate.base_url, selection.verification_url) : undefined;
      if (!candidate || selection.expected_updated_at !== candidate.updated_at || !url) {
        throw new RpcError('conflict', 'Refresh selected connections and enter a protected read-only URL for each one.');
      }
      return { connection: { ...candidate, verification_url: url }, state: 'pending' as const };
    });
    if (rows.some(row => row.connection.base_url !== rows[0]!.connection.base_url || row.connection.vendor !== rows[0]!.connection.vendor)) {
      throw new RpcError('bad_request', 'Migrate one vendor API service at a time.');
    }
    const names = rows.map(r => r.connection.name); const saved = deps.rows().filter(r => r.kind === 'api' && names.includes(r.name));
    const plan: Plan = { view: { id: args.id, created_at: deps.now(), expires_at: deps.now() + 30 * 60_000, state: 'preparing',
      requested_scopes: [...args.auth.requested_scopes], rows,
      warnings: ['Each connection switches only after its protected read check passes.',
        'Failed connections keep their saved authentication. Successful switches remain applied.',
        ...(direct ? ['The existing direct OAuth app is reused. Nango authorizations are kept.']
          : ['Sign-in can affect other tools sharing the Nango account before local switches.']),
        'Read checks do not prove write access or all permissions. Mail and Calendar bindings need review after an account switch.'] },
      names, expected: new Map(saved.map(r => [r.name, rowHash(r)])), signature: direct ? broker.directMigrationSignature!(names) : broker.migrationSignature!(names),
      stopped: false, request, direct };
    // Reserve the ID before transferring the receipt, including while a native check is pending.
    if (plans.has(args.id)) return prepare(args);
    prune();
    if (plans.size >= 16) {
      const old = [...plans.values()].filter(p => ['completed', 'stopped', 'expired'].includes(p.view.state))
        .sort((a, b) => a.view.created_at - b.view.created_at)[0];
      if (old) plans.delete(old.view.id);
      else throw new RpcError('conflict', 'Too many migration reviews are pending. Stop an old review or let it expire.');
    }
    plans.set(args.id, plan);
    try {
      if (args.auth.type === 'direct_oauth') plan.authority = await deps.direct!.claim(args.auth, names, args.impact_fingerprint);
      else {
        await broker.verifyImpact!(args.auth, args.impact_fingerprint);
        plan.authority = await broker.claimMigration!(args.auth, names);
      }
      plan.view.expires_at = plan.authority.expires_at;
      assertCurrent(plan);
      plan.names = [...plan.authority.names]; plan.signature = plan.authority.signature;
      for (const row of deps.rows()) if (row.kind === 'api' && plan.names.includes(row.name)) plan.expected.set(row.name, rowHash(row));
      void check(plan).catch(() => { plan.stopped = true; plan.view.state = 'stopped'; plan.authority?.close(); plan.authority = undefined; });
      return { action: 'migration_prepare', migration: publicView(plan) };
    } catch (error) {
      plan.authority?.close(); plan.authority = undefined; plan.stopped = true; plan.view.state = 'stopped';
      for (const row of plan.view.rows) if (row.state === 'pending') failed(row, error);
      throw new RpcError('conflict', 'This migration could not be prepared. Saved connections were kept. Review authorization again.');
    }
  };
  const apply = async (plan: Plan): Promise<void> => {
    const selected = plan.view.rows.map(row => row.connection.name);
    try {
      for (const row of plan.view.rows) {
        if (row.state !== 'verified') continue;
        let issued: Awaited<ReturnType<ManagedOAuthMigrationAuthority['issue'] | DirectOAuthMigrationAuthority['issue']>> | undefined;
        try {
          assertCurrent(plan); row.state = 'applying'; row.attempt_id = randomUUID();
          issued = await plan.authority!.issue(row.connection.name);
          if (impactHash(issued.impact, row.connection.name, selected) !== impactHash(row.impact, row.connection.name, selected)) {
            throw new RpcError('conflict', 'The account or its shared connections changed after review.');
          }
          await deps.apply({ auth: issued.auth, name: row.connection.name, revision: row.connection.updated_at,
            url: row.connection.verification_url, attempt_id: row.attempt_id, impact_fingerprint: issued.impact.fingerprint,
            beforeSwap: () => assertCurrent(plan) });
          const saved = deps.rows().find(r => r.kind === 'api' && r.name === row.connection.name)!;
          plan.expected.set(saved.name, rowHash(saved)); row.state = 'migrated';
        } catch (error) { failed(row, error, plan.stopped); }
        finally { issued?.retire(); deps.changed?.(); }
      }
      plan.view.state = plan.stopped ? 'stopped' : 'completed';
    } finally { plan.authority?.close(); plan.authority = undefined; deps.changed?.(); }
  };
  const handle = async (args: ManagedOAuthMigrationRequest): Promise<ManagedOAuthMigrationResponse> => {
    if (!args || typeof args !== 'object' || !['migration_candidates', 'migration_prepare', 'migration_status', 'migration_stop', 'migration_apply'].includes(args.action)) {
      throw new RpcError('bad_request', 'Unknown bulk authentication migration action.');
    }
    if (args.action !== 'migration_candidates' && (args.action !== 'migration_status' || args.id !== undefined)
      && (typeof args.id !== 'string' || !CONNECTION_CREDENTIAL_ROTATION_ATTEMPT_ID_REGEX.test(args.id))) {
      throw new RpcError('bad_request', 'A valid migration review ID is required.');
    }
    enabled(); prune();
    if (args.action === 'migration_candidates') {
      if (args.names !== undefined && (!Array.isArray(args.names) || args.names.length > MANAGED_OAUTH_MIGRATION_LIMIT
        || args.names.some(name => typeof name !== 'string'))) throw new RpcError('bad_request', 'Choose up to 20 connection names.');
      return { action: args.action, candidates: await broker.migrationCandidates!(args.names) };
    }
    if (args.action === 'migration_prepare') return prepare(args);
    if (args.action === 'migration_status') {
      const selected = args.id ? [plans.get(args.id)].filter((v): v is Plan => !!v) : [...plans.values()];
      return { action: args.action, migrations: selected.map(publicView).sort((a, b) => b.created_at - a.created_at) };
    }
    const plan = plans.get(args.id);
    if (!plan) throw new RpcError('not_found', 'This server has no migration review. Check the saved connections before starting again.');
    if (args.action === 'migration_stop') {
      plan.stopped = true;
      if (plan.view.state !== 'applying') { plan.authority?.close(); plan.authority = undefined; plan.view.state = 'stopped'; }
      return { action: args.action, migration: publicView(plan) };
    }
    if (!args.fingerprint || args.fingerprint !== plan.view.fingerprint) throw new RpcError('conflict', 'Review the verified account and results before applying.');
    if (plan.view.state === 'ready') {
      assertCurrent(plan); plan.view.state = 'applying';
      void apply(plan).catch(() => { plan.view.state = 'stopped'; plan.stopped = true; plan.authority?.close(); });
    }
    return { action: args.action, migration: publicView(plan) };
  };
  return { handle };
};
