import type { ApprovalWorkflowTargetsResult, ReceptionEndpointKind, ReceptionPageConfig, ViewAsVisitorPanel } from '@recued/contracts';

export const installReceptionAuthoringFixture = (fixture: { page: ReceptionPageConfig; panels: Partial<Record<ReceptionEndpointKind, ViewAsVisitorPanel>> }) => {
  const view = window as any, original = view.__receptionFixture;
  const params = new URLSearchParams(location.search), now = 1_700_000_000_000;
  const state = view.__authoring = { page: params.has('authoring_new_page') ? null : fixture.page,
    previews: {} as Record<string, string>, created: [] as Array<Record<string, any>>, saves: [] as ReceptionPageConfig[] };
  const canonical = (args: any) => JSON.stringify({ kind: args.kind, packet: args.packet_declaration, expires: args.expires_at ?? null, metadata: args.metadata });
  view.__receptionFixture = async (method: string, raw: unknown) => {
    const args = structuredClone((raw ?? {}) as Record<string, any>);
    const result = await original(method, raw); // Includes every call in the shared recorder and honors holds/failures.
    if (result?.error) return result;
    if (method === 'reception.page.get') return { result: { config: structuredClone(state.page), last_updated_at: state.page ? now : null } };
    if (method === 'reception.page.upsert') { state.page = args.config; state.saves.push(structuredClone(args.config)); return { result: { ok: true, last_updated_at: now } }; }
    if (method === 'reception.approval.targets') return { result: { targets: [
      { kind: 'task', id: 'task-project', label: 'Prepare customer project' },
      { kind: 'commitment', id: 'commitment-project', label: 'Deliver customer project' },
      { kind: 'recipe', id: 'recipe-project', label: 'Customer project intake' },
    ], truncated: false } satisfies ApprovalWorkflowTargetsResult };
    if (method === 'reception.endpoint.preview_draft') {
      const hash = 'authoring-preview-' + (Object.keys(state.previews).length + 1); state.previews[hash] = canonical(args);
      return { result: { html: '<!doctype html><html><body><h1>Customer project preview</h1><p>Preview supplied by the local fixture.</p></body></html>',
        preview_hash: hash, visible_fields: [], expires_at: now + 600_000, view_as_visitor: fixture.panels[args.kind as ReceptionEndpointKind] } };
    }
    if (method === 'reception.endpoint.create') {
      if (state.previews[args.preview_hash] !== canonical(args)) return { error: { code: 'preview_hash_mismatch', message: 'Review the updated settings before creating the link.' } };
      const id = 'created-' + (state.created.length + 1); state.created.push(args);
      view.__endpoints.endpoints.push({ endpoint_id: id, kind: args.kind, enabled: false, packet_declaration: args.packet_declaration,
        metadata: args.metadata, expires_at: args.expires_at ?? null, created_at: now, created_by_client_id: 'fixture-owner',
        long_lived_acknowledged_at: args.expires_at ? null : now, revoked_at: null, revocation_reason: null, audit_count: 0, last_accessed_at: null });
      return { result: { endpoint_id: id, public_locator: '/reception/created/' + id, bearer_secret_once: 'created-once',
        share_url_once: 'https://fixture.example.test/reception/created/' + id + '?t=created-once', enabled: false } };
    }
    return result;
  };
};
