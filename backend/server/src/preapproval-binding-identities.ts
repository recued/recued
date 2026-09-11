/** Host identity resolution at the existing transport boundary. These
 * descriptions cannot grant an operation or satisfy an owner decision. */
import type Database from 'better-sqlite3';
import {
  CHUNKED_UPLOAD_WIRE_WALK_KEY, PAGINATION_MAX_PAGES, PAGINATION_MAX_RECORDS,
  parsePreapprovalJson, type PreapprovalJson,
} from '@recued/contracts';
import { catalogInvocationTimeoutMs, describeCatalogAuthority, describeCatalogDispatch, normalizeCatalogDispatchInput } from '@recued/engine';
import { buildConnectionApiBody, describeConnectionApiRequest, describeConnectionApiUpload, describeConnectionMcpRequest, describeHttpRequest, resolveDispatchSlot } from '@recued/ingredients';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';
import { synchronizePreapprovalConnection } from './storage/preapproval-connections.js';
import {
  describePreapprovalInvocation, normalizePreapprovalCall,
  type PreapprovalCall, type PreapprovalNormalAdmission, type PreapprovalRuntimeIdentity,
} from './preapproval-dispatch-description.js';
import type { PreapprovalCallDescription } from './preapproval-prepare.js';
import { describeCliInvocation } from './cli-invocation-executor.js';
import { describeProcessBinding } from './process-binding-identity.js';
import { buildStdioMcpEnvironment } from './mcp-stdio-spawner.js';
import type { createPreapprovalMail } from './preapproval-mail.js';
import { describeReviewedDom } from './preapproval-dom.js';
import type { BridgeDispatcher } from './bridges/dispatcher.js';

export interface PreapprovalBindingIdentityDeps {
  db: Database.Database;
  connections: Pick<ConnectionStoreSqlite, 'get'>;
  localRecipe?: (id: string) => { recipe_id: string; publisher_id: string } | null;
  bridgeDispatcher?: () => BridgeDispatcher | undefined;
  /** Actual dispatchers supply domain resources, required children and nested
   * calls through this same identity contract. An absent resolver is visible
   * as uncovered; it can never silently assert that there are no children. */
  describeDomain?: (call: PreapprovalCall, admission: PreapprovalNormalAdmission) => PreapprovalRuntimeIdentity | null;
  describeFileChild?: (call: PreapprovalCall, slot: string, index: number, recordId: string) => ReturnType<ReturnType<typeof createPreapprovalMail>['fileChild']>;
}

const json = (value: unknown): PreapprovalJson => parsePreapprovalJson(value);
const unsupported = (reason: string): PreapprovalCallDescription => ({ kind: 'unresolved', op_id: null, reason, subtree: true });

export const createPreapprovalBindingIdentities = (deps: PreapprovalBindingIdentityDeps) => (
  rawCall: PreapprovalCall, admit: (call: PreapprovalCall) => PreapprovalNormalAdmission,
): PreapprovalCallDescription => {
  let call: PreapprovalCall;
  try { call = normalizePreapprovalCall(rawCall); }
  catch (error) { return unsupported(error instanceof Error ? error.message : 'The operation arguments cannot be resolved.'); }
  const admission = admit(call); // Authority errors propagate, never become an implicit admit.
  const domain = deps.describeDomain?.(call, admission);
  if (domain) return describePreapprovalInvocation(call, domain, admission);
  let wire: Record<string, unknown> = call.input;
  let family: PreapprovalRuntimeIdentity['family'] | null = null;
  let definition: unknown = null;
  const slot = resolveDispatchSlot(call.manifest);
  if (!call.catalog && slot === 'dom') {
    try { return describePreapprovalInvocation(call, describeReviewedDom(deps.db, deps.bridgeDispatcher?.(), call), admission); }
    catch (error) { return unsupported(error instanceof Error ? error.message : 'The browser document cannot be frozen.'); }
  }
  if (call.catalog) {
    const key = call.input.operation as string;
    const authority = describeCatalogAuthority(call.manifest, key, call.connection_name);
    if (authority.local_recipe) {
      const target = authority.local_recipe_id && deps.localRecipe?.(authority.local_recipe_id);
      if (!target) return unsupported('The installed local recipe identity is unavailable.');
      return describePreapprovalInvocation(call, { family: 'mcp', label: call.manifest.name,
        detail: `Run the reviewed ${target.publisher_id}/${target.recipe_id} recipe on this server.`,
        binding: json({ dispatcher_version: 1, local_recipe: target }), connection_id: null, account_id: null,
        children: [], child_inventory: { complete: true }, resources: [], dependencies: [],
        nested_recipe: { ...target, config: call.input.args as Record<string, PreapprovalJson> },
      }, admission);
    }
    const dispatch = describeCatalogDispatch(call.manifest, key, call.input.args as Record<string, unknown>, call.connection_name);
    if (!dispatch) return unsupported('The catalog binding has no supported synchronous dispatcher.');
    family = dispatch.family; definition = dispatch.binding; wire = dispatch.input;
    normalizeCatalogDispatchInput(call.manifest, key, wire, admission.risk);
    if (call.manifest.operations?.[key]?.operation_bound_webhook) {
      return unsupported('The operation requires a live callback binding that is not frozen in this review.');
    }
  } else if (slot === 'http') family = 'http';
  else if (slot === 'connection' && call.input.connection_kind === 'api') family = 'http';
  else if (slot === 'connection' && call.input.connection_kind === 'mcp') family = 'mcp';
  if (family === 'cli') {
    try {
      const key = call.input.operation as string;
      const binding = call.manifest.surfaces?.connector?.executes?.[key];
      if (binding?.kind !== 'cli_invocation') return unsupported('The CLI binding disappeared.');
      if (binding.detached || binding.input_materialize || binding.output_capture) {
        return unsupported('This CLI operation requires a frozen lifecycle or file dependency description.');
      }
      const request = describeCliInvocation({ slug: call.slug, operation_key: key,
        operation_id: call.manifest.operations![key]!.operation_id, binding, args: wire,
        timeout_ms: catalogInvocationTimeoutMs(call.manifest, key) });
      if (!request.argv[0]) return unsupported('The CLI executable is unresolved.');
      const process = describeProcessBinding({ command: request.argv[0], args: request.argv.slice(1), cwd: request.cwd });
      return describePreapprovalInvocation(call, { family: 'cli', label: call.manifest.name, detail: call.manifest.description,
        binding: json({ dispatcher_version: 1, request, process }), connection_id: null, account_id: null,
        resources: [], dependencies: [], children: [], child_inventory: { complete: true }, nested_recipe: null,
      }, admission);
    } catch (error) { return unsupported(error instanceof Error ? error.message : 'The CLI process cannot be frozen.'); }
  }
  if (family === 'mcp') {
    try {
      const connectionName = typeof wire.connection === 'string' ? wire.connection : call.connection_name;
      return deps.db.transaction(() => {
        const row = deps.connections.get('mcp', connectionName);
        if (!row) return unsupported('The enrolled MCP connection is unavailable.');
        const pins = synchronizePreapprovalConnection(deps.db, 'mcp', connectionName, row);
        const request = describeConnectionMcpRequest(row, wire, call.slug);
        const process = request.launch ? describeProcessBinding({ ...request.launch,
          env: buildStdioMcpEnvironment(request.launch.env) }) : null;
        const credential = pins.find(pin => pin.kind === 'connection_credential')!;
        return describePreapprovalInvocation(call, { family: 'mcp',
          label: call.manifest.name, detail: call.manifest.description,
          binding: json({ dispatcher_version: 1, request, process, connection: pins[0]!, credential }),
          connection_id: pins[0]!.incarnation, account_id: credential.content_hash,
          resources: pins.map(({ until_phase: _phase, ...pin }) => pin), dependencies: pins,
          children: [], child_inventory: { complete: true }, nested_recipe: null,
        }, admission);
      }).immediate();
    } catch (error) {
      return unsupported(error instanceof Error ? error.message : 'The MCP request cannot be frozen.');
    }
  }
  if (family !== 'http' && family !== 'graphql') {
    return unsupported(`The ${family ?? slot} dispatcher has not supplied a frozen invocation identity.`);
  }
  if (Object.hasOwn(wire, CHUNKED_UPLOAD_WIRE_WALK_KEY)
    || (definition && typeof definition === 'object' && 'upload' in definition
      && (definition.upload as { kind?: string } | undefined)?.kind === 'chunked')) {
    return unsupported('This chunked upload requires a frozen walk and file-read description.');
  }
  if (!call.catalog && slot === 'http' && Object.keys(wire).some(key => key === 'body_binary' || key.startsWith('body_file.'))) {
    return unsupported('A file upload requires a declared catalog upload binding.');
  }
  const base: Pick<PreapprovalRuntimeIdentity, 'family' | 'label' | 'detail' | 'children' | 'child_inventory' | 'nested_recipe'> = {
    family, label: call.manifest.name, detail: call.manifest.description,
    children: [], child_inventory: { complete: true }, nested_recipe: null,
  };
  try {
    if (!call.catalog && slot === 'http') {
      const request = describeHttpRequest({ slug: call.slug, input: call.input });
      return describePreapprovalInvocation(call, { ...base, binding: json({ dispatcher_version: 1,
        method: request.method, url: request.url, headers: request.headers, body: request.body ?? null,
        timeout_ms: request.timeoutMs, redirect_origin: request.requestOrigin }),
      connection_id: null, account_id: null, resources: [], dependencies: [] }, admission);
    }
    const connectionName = typeof wire.connection === 'string' ? wire.connection : call.connection_name;
    return deps.db.transaction(() => {
      const row = deps.connections.get('api', connectionName);
      if (!row) return unsupported('The enrolled API connection is unavailable.');
      const pins = synchronizePreapprovalConnection(deps.db, 'api', connectionName, row);
      const request = describeConnectionApiRequest(row, wire, call.slug);
      const upload = describeConnectionApiUpload(wire, request.headers);
      const children: PreapprovalRuntimeIdentity['children'] = [];
      let uploaded: PreapprovalJson | null = null;
      if (upload) {
        if (upload.kind === 'chunked') return unsupported('This upload requires a frozen chunk walk.');
        if (!deps.describeFileChild) return unsupported('The required upload file reader is unavailable.');
        if (request.method === 'GET' || request.method === 'HEAD') return unsupported('This method cannot carry the reviewed upload body.');
        let total = 0;
        const files = upload.files.map((file, index) => {
          const described = deps.describeFileChild!(call, 'http_upload', index, file.record_id);
          children.push(described.child); total += described.snapshot.file.size_bytes;
          return { field: file.field, file: described.snapshot.file };
        });
        if (total > upload.max_bytes!) return unsupported('The reviewed upload exceeds this operation\'s byte limit.');
        uploaded = json({ kind: upload.kind, max_bytes: upload.max_bytes, text_parts: upload.text_parts, files });
      }
      const body = uploaded ?? (request.method === 'GET' || request.method === 'HEAD' ? null
        : buildConnectionApiBody(wire, request.headers) ?? null);
      const target = request.resolveRequestUrl(request.baseUrl);
      const key = typeof call.input.operation === 'string' ? call.input.operation : null;
      const pagination = key ? call.manifest.operations?.[key]?.pagination ?? null : null;
      const credential = pins.find(pin => pin.kind === 'connection_credential')!;
      const headers: Record<string, string> = {};
      request.headers.forEach((value, name) => { headers[name] = value; });
      return describePreapprovalInvocation(call, { ...base, children,
        binding: json({ dispatcher_version: 1, method: request.method, url: target.url.toString(),
          headers, body, redirect_origin: target.baseOrigin,
          pagination, pagination_limits: { pages: PAGINATION_MAX_PAGES, records: PAGINATION_MAX_RECORDS },
          connection: pins[0]!, credential }),
        connection_id: pins[0]!.incarnation, account_id: credential.content_hash,
        resources: pins.map(({ until_phase: _phase, ...pin }) => pin), dependencies: pins,
      }, admission);
    }).immediate();
  } catch (error) {
    return unsupported(error instanceof Error ? error.message : 'The HTTP request cannot be frozen.');
  }
};
