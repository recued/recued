import type { AccessLogEntry, EndpointSummary, PacketDeclaration, ReceptionEndpointPreviewResult } from '@recued/contracts';

/** Populated owner-side inventory in the shipped app, with controllable RPC latency. */
export const installReceptionEndpointsFixture = () => {
  type Reply = { result?: unknown; error?: { code: string; message: string } };
  const view = window as Window & {
    __receptionFixture?: (method: string, args: unknown) => Promise<Reply | undefined>;
    __endpoints?: { calls: Array<{ method: string; args: Record<string, any> }>; endpoints: EndpointSummary[];
      held: string[]; failing: string[]; pending(method: string): number; release(method: string, failed?: boolean): void };
    __app?: { fireMessage(message: unknown): void };
  };
  const params = new URLSearchParams(location.search), now = 1_700_000_000_000, day = 86_400_000;
  const packets: Record<EndpointSummary['kind'], PacketDeclaration> = {
    reception_page: { packet_kind: 'reception_page_packet', source_query_ref: { kind: 'reception_page_config' } },
    scheduling_link: { packet_kind: 'scheduling_link_packet', source_query_ref: { kind: 'data.calendar.combined' } },
    intake_form: { packet_kind: 'intake_form_packet', source_query_ref: { kind: 'reception_form_definition', form_definition_id: 'customer-project' } },
    drop_link: { packet_kind: 'drop_link_packet', source_query_ref: { kind: 'reception_drop_config', drop_config_id: 'documents' } },
    approval_link: { packet_kind: 'approval_link_packet', source_query_ref: { kind: 'reception_approval_intent', intent_id: 'project-approval' } },
    status_link: { packet_kind: 'status_link_packet', source_query_ref: { kind: 'data.project', project_id: 'legacy-project' } },
  };
  const endpoint = (endpoint_id: string, kind: EndpointSummary['kind'], extra: Partial<EndpointSummary> = {}): EndpointSummary => ({
    endpoint_id, kind, enabled: true, packet_declaration: packets[kind], created_at: now - day, created_by_client_id: 'fixture-owner', expires_at: now + 7 * day,
    long_lived_acknowledged_at: null, revoked_at: null, revocation_reason: null,
    audit_count: 3, last_accessed_at: now - 60_000, metadata: {}, ...extra,
  });
  const endpoints = params.has('endpoints_empty') ? [] : [
    endpoint('__reception_page__', 'reception_page', { expires_at: null }),
    endpoint('consultation-0123456789-0123456789-0123456789-0123456789', 'scheduling_link'),
    endpoint('customer-intake', 'intake_form', { enabled: false }),
    endpoint('documents', 'drop_link', { expires_at: now - day }),
    endpoint('project-approval', 'approval_link', { revoked_at: now - 3_600_000, revocation_reason: 'Replaced by an updated project scope.' }),
    endpoint('legacy-status', 'status_link'),
  ];
  const waiting = new Map<string, Array<(failed: boolean) => void>>();
  const state = view.__endpoints = {
    calls: [], endpoints, held: params.getAll('endpoints_hold'), failing: params.getAll('endpoints_fail'),
    pending: (method: string) => waiting.get(method)?.length ?? 0,
    release(method: string, failed = false) {
      const finish = waiting.get(method)?.shift();
      if (!finish) throw new Error(`No pending ${method}`);
      finish(failed);
    },
  } as NonNullable<typeof view.__endpoints>;
  view.__receptionFixture = async (method, raw) => {
    const args = (raw ?? {}) as Record<string, any>;
    // Record every RPC so negative assertions also catch unexpected sends or execution.
    state.calls.push({ method, args: structuredClone(args) });
    if (!method.startsWith('reception.')) return undefined;
    const snapshot = method === 'reception.endpoints.list' ? structuredClone(state.endpoints) : undefined;
    const failed = state.failing.includes(method) || state.held.includes(method)
      && await new Promise<boolean>(resolve => waiting.set(method, [...waiting.get(method) ?? [], resolve]));
    if (failed) return { error: { code: params.get('endpoints_error_code') ?? 'UNAVAILABLE', message: 'Endpoint service is temporarily unavailable.' } };
    let result: unknown;
    const row = state.endpoints.find(e => e.endpoint_id === args.endpoint_id);
    if (method === 'reception.endpoints.list') result = { endpoints: snapshot };
    else if (method === 'reception.endpoint.access_log') result = { entries: params.has('endpoints_no_access') ? [] : [
      { id: 'access-1', endpoint_id: args.endpoint_id, accessed_at: now - 60_000, source_ip_hash: 'a'.repeat(64), user_agent_hash: null,
        action_taken: 'view', outcome: 'ok', url_path_redacted: '/reception/book/consultation?t=[redacted]', metadata: {} },
      { id: 'access-2', endpoint_id: args.endpoint_id, accessed_at: now - 30_000, source_ip_hash: 'b'.repeat(64), user_agent_hash: null,
        action_taken: 'submit', outcome: 'rejected', url_path_redacted: '/reception/book/consultation?t=[redacted]', metadata: {} },
    ] satisfies AccessLogEntry[] };
    else if (method === 'reception.page.get') result = { config: null, last_updated_at: null };
    else if (method === 'reception.template.list') result = { templates: [] };
    else if (method === 'reception.config_template.list') result = { templates: [] };
    else if (method === 'reception.abuse_inbox.list') result = { summary: { rows: [], total_signals: 0, window_start_at: now - 7 * day, window_end_at: now, cluster_threshold: 3 }, blocked: [] };
    else if (method === 'reception.endpoint.preview_draft') result = {
      html: '<!doctype html><html><body><h1>Customer consultation</h1><p>Choose a time to discuss your project.</p></body></html>',
      visible_fields: [], preview_hash: 'endpoint-preview-hash', expires_at: now + 600_000,
    } satisfies ReceptionEndpointPreviewResult;
    else if (method === 'reception.endpoint.rotate_token') result = { bearer_secret_once: 'rotated-fixture-token', share_url_once: 'https://fixture.example.test/reception/book/consultation?t=rotated-fixture-token' };
    else if (method === 'reception.emergency_disable_all') {
      state.endpoints = state.endpoints.map(e => ({ ...e, enabled: false })); result = { disabled_count: endpoints.filter(e => e.enabled).length };
    } else if (row && ['reception.endpoint.enable', 'reception.endpoint.disable', 'reception.endpoint.extend', 'reception.endpoint.revoke'].includes(method)) {
      state.endpoints = state.endpoints.map(e => e !== row ? e : { ...e,
        ...(method.endsWith('.enable') ? { enabled: true } : method.endsWith('.disable') ? { enabled: false }
          : method.endsWith('.extend') ? { expires_at: args.new_expires_at }
            : { revoked_at: now, revocation_reason: args.reason ?? null }),
      }); result = { ok: true };
    } else return undefined;
    return { result };
  };
  setInterval(() => view.__app?.fireMessage({ type: 'heartbeat', connection_id: 'endpoints-fixture', server_time: Date.now() }), 1000);
};
