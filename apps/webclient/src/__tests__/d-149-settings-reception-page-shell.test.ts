/** D-149 follow-on § A.9 — Reception page shell wiring acceptance.
 *
 *  The shell is the one stateful piece tying the pure projection
 *  modules (the § A.9 spine + the five satellites) to the `reception.*`
 *  rpc surface + the broadcast subscription. These tests inject a
 *  deterministic fake conn + a fake broadcast subscriber and assert:
 *
 *    - creation registers the two reception broadcast kinds
 *    - each action method fires the right rpc with the right payload,
 *      feeds the result to the right satellite builder, and lands it in
 *      the right state field
 *    - mutations refetch + re-project the list
 *    - the two broadcast handlers refetch / optimistically reduce
 *    - rpc failures are captured into `last_error` AND re-thrown
 *    - the shell is observable + `dispose()` tears the subscriptions down
 */

import { describe, expect, it } from 'vitest';
import { RpcError } from '@recued/contracts';
import type {
  AbuseInboxSummary,
  BroadcastEventKind,
  EndpointSummary,
  ServerEvent,
} from '@recued/contracts';

import type {
  BroadcastListener,
  BroadcastSubscriber,
} from '../realtime/subscriber.js';
import { WEBCLIENT_DEFAULT_SUBSCRIPTIONS } from '../realtime/subscriber.js';
import {
  createReceptionPageShell,
  RECEPTION_PAGE_SHELL_BROADCAST_KINDS,
  type ReceptionConn,
  type ReceptionPageShellDeps,
} from '../settings/reception-page-shell.js';
import type { ReceptionStatusInput } from '../settings/reception.js';
import {
  buildEndpointPreviewDispatch,
  buildEndpointCreateDispatch,
  buildReceptionPageUpsertDispatch,
} from '../settings/reception-authoring.js';

const NOW = 1_700_000_000_000;

// ── Fixtures ──────────────────────────────────────────────────────

const buildEndpointSummary = (
  overrides: Partial<EndpointSummary> = {},
): EndpointSummary => ({
  endpoint_id: 'ep-1',
  kind: 'scheduling_link',
  enabled: true,
  packet_declaration: {
    packet_kind: 'scheduling_link_packet',
    source_query_ref: { kind: 'data.calendar.combined' },
  },
  created_at: NOW - 60_000,
  created_by_client_id: 'client-A',
  expires_at: null,
  long_lived_acknowledged_at: NOW - 60_000,
  revoked_at: null,
  revocation_reason: null,
  audit_count: 0,
  last_accessed_at: null,
  metadata: {},
  ...overrides,
});

const emptyAbuseSummary = (): AbuseInboxSummary => ({
  rows: [],
  total_signals: 0,
  window_start_at: NOW - 7 * 24 * 60 * 60 * 1000,
  window_end_at: NOW,
  cluster_threshold: 3,
});

const initialStatus = (): ReceptionStatusInput => ({
  emergency_disabled: false,
  reception_public: true,
  base_url: 'https://alice.recued.cloud',
});

// ── Fake conn ─────────────────────────────────────────────────────

type ConnResponse = unknown | ((payload: unknown) => unknown);

interface FakeConn {
  conn: ReceptionConn;
  calls: Array<{ method: string; payload: unknown }>;
  setResponse(method: string, response: ConnResponse): void;
}

const defaultResponses = (): Record<string, ConnResponse> => ({
  'reception.endpoints.list': { endpoints: [] },
  'reception.endpoint.access_log': { entries: [] },
  'reception.endpoint.enable': { ok: true },
  'reception.endpoint.disable': { ok: true },
  'reception.endpoint.revoke': { ok: true },
  'reception.endpoint.extend': { ok: true },
  'reception.endpoint.rotate_token': {
    bearer_secret_once: 'sec',
    share_url_once: 'https://alice.recued.cloud/reception/x?t=sec',
  },
  'reception.emergency_disable_all': { disabled_count: 0 },
  'reception.page.get': { config: null, last_updated_at: null },
  'reception.page.upsert': { ok: true, last_updated_at: NOW },
  'reception.endpoint.preview_draft': (payload: unknown) => ({
    html: '<p>preview</p>',
    visible_fields: [],
    preview_hash: `hash-${(payload as { kind?: string }).kind ?? 'x'}`,
    expires_at: NOW + 600_000,
  }),
  'reception.endpoint.create': {
    endpoint_id: 'ep-new',
    public_locator: '/reception/new',
    bearer_secret_once: 'sec',
    share_url_once: 'https://alice.recued.cloud/reception/new?t=sec',
    enabled: false,
  },
  'reception.abuse_inbox.list': { summary: emptyAbuseSummary(), blocked: [] },
  'reception.abuse_inbox.ban_ip': { ok: true, created: true },
  'reception.abuse_inbox.unban_ip': { ok: true, removed: true },
  'reception.template.list': { templates: [] },
});

const createFakeConn = (
  overrides: Record<string, ConnResponse> = {},
): FakeConn => {
  const calls: Array<{ method: string; payload: unknown }> = [];
  const responses = new Map<string, ConnResponse>(
    Object.entries({ ...defaultResponses(), ...overrides }),
  );
  const call = (method: string, payload?: unknown): Promise<unknown> => {
    calls.push({ method, payload });
    if (!responses.has(method)) {
      return Promise.reject(
        new RpcError('not_configured', `fake conn: no response for ${method}`, 500, method),
      );
    }
    const r = responses.get(method);
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(typeof r === 'function' ? r(payload) : r);
  };
  return {
    conn: call as unknown as ReceptionConn,
    calls,
    setResponse: (m, r) => responses.set(m, r),
  };
};

// ── Fake broadcast subscriber ─────────────────────────────────────

interface FakeSubscriber {
  subscribe: BroadcastSubscriber['on'];
  emit(event: ServerEvent): void;
  /** Live registrations — an entry is removed when its unsubscribe fires. */
  active: Array<{ kind: BroadcastEventKind }>;
}

const createFakeSubscriber = (): FakeSubscriber => {
  const byKind = new Map<BroadcastEventKind, Set<BroadcastListener>>();
  const active: Array<{ kind: BroadcastEventKind }> = [];
  const subscribe = (<K extends BroadcastEventKind>(
    kind: K,
    listener: BroadcastListener<K>,
  ): (() => void) => {
    let set = byKind.get(kind);
    if (!set) {
      set = new Set();
      byKind.set(kind, set);
    }
    // Same widening cast the real `createBroadcastSubscriber` uses — the
    // per-kind narrowing is preserved by the `byKind` keying.
    set.add(listener as unknown as BroadcastListener);
    const reg = { kind };
    active.push(reg);
    return () => {
      set?.delete(listener as unknown as BroadcastListener);
      const idx = active.indexOf(reg);
      if (idx >= 0) active.splice(idx, 1);
    };
  }) as BroadcastSubscriber['on'];
  const emit = (event: ServerEvent): void => {
    const set = byKind.get(event.kind);
    if (!set) return;
    for (const listener of [...set]) {
      (listener as unknown as (e: ServerEvent) => void)(event);
    }
  };
  return { subscribe, emit, active };
};

// ── Harness ───────────────────────────────────────────────────────

const buildShell = (overrides: Partial<ReceptionPageShellDeps> = {}) => {
  const fakeConn = createFakeConn();
  const fakeSub = createFakeSubscriber();
  const deps: ReceptionPageShellDeps = {
    call: fakeConn.conn,
    subscribe: fakeSub.subscribe,
    now: () => NOW,
    initialStatus: initialStatus(),
    ...overrides,
  };
  const shell = createReceptionPageShell(deps);
  return { shell, fakeConn, fakeSub };
};

/** Flush queued microtasks + one macrotask — lets a fire-and-forget
 *  broadcast-triggered refetch settle. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — reception page shell: creation + broadcast wiring', () => {
  it('subscribes to exactly the two reception broadcast kinds on creation', () => {
    const { fakeSub } = buildShell();
    expect(fakeSub.active.map((r) => r.kind).sort()).toEqual([
      'reception.emergency_disabled',
      'reception.endpoint_changed',
    ]);
  });

  it('RECEPTION_PAGE_SHELL_BROADCAST_KINDS is in WEBCLIENT_DEFAULT_SUBSCRIPTIONS', () => {
    for (const kind of RECEPTION_PAGE_SHELL_BROADCAST_KINDS) {
      expect(WEBCLIENT_DEFAULT_SUBSCRIPTIONS).toContain(kind);
    }
  });

  it('dispose() tears down both broadcast subscriptions', () => {
    const { shell, fakeSub } = buildShell();
    expect(fakeSub.active).toHaveLength(2);
    shell.dispose();
    expect(fakeSub.active).toHaveLength(0);
  });

  it('dispose() is idempotent', () => {
    const { shell } = buildShell();
    shell.dispose();
    expect(() => shell.dispose()).not.toThrow();
  });

  it('seeds state from initialStatus with every projection null', () => {
    const { shell } = buildShell();
    const s = shell.getState();
    expect(s.status).toEqual(initialStatus());
    expect(s.page).toBeNull();
    expect(s.detail).toBeNull();
    expect(s.abuse_inbox).toBeNull();
    expect(s.view_as_visitor).toBeNull();
    expect(s.last_error).toBeNull();
    expect(s.loading).toBe(false);
  });
});

describe('D-149 follow-on — reception page shell: spine list + status', () => {
  it('loadPage() fetches reception.endpoints.list + builds the page model', async () => {
    const { shell, fakeConn } = buildShell();
    fakeConn.setResponse('reception.endpoints.list', {
      endpoints: [buildEndpointSummary({ endpoint_id: 'ep-1', kind: 'scheduling_link' })],
    });
    await shell.loadPage();
    expect(fakeConn.calls.map((c) => c.method)).toEqual(['reception.endpoints.list']);
    const page = shell.getState().page;
    expect(page).not.toBeNull();
    expect(page?.sections).toHaveLength(6);
    expect(page?.total_endpoints).toBe(1);
    expect(page?.status_header.reception_public).toBe(true);
  });

  it('setStatus() re-projects the page model without an rpc call', async () => {
    const { shell, fakeConn } = buildShell();
    await shell.loadPage();
    const callCountBefore = fakeConn.calls.length;
    shell.setStatus({ emergency_disabled: true, reception_public: true, base_url: 'https://a/' });
    expect(fakeConn.calls).toHaveLength(callCountBefore);
    const page = shell.getState().page;
    expect(page?.status_header.emergency_disabled).toBe(true);
    expect(page?.status_header.status_label).toBe('Switched off in a hurry');
  });

  it('setStatus() before loadPage updates status but leaves page null', () => {
    const { shell } = buildShell();
    shell.setStatus({ emergency_disabled: false, reception_public: false, base_url: null });
    const s = shell.getState();
    expect(s.status.reception_public).toBe(false);
    expect(s.page).toBeNull();
  });
});

describe('D-149 follow-on — reception page shell: spine lifecycle dispatch', () => {
  it('enableEndpoint() fires reception.endpoint.enable then refetches the list', async () => {
    const { shell, fakeConn } = buildShell();
    await shell.enableEndpoint('ep-7');
    expect(fakeConn.calls).toEqual([
      { method: 'reception.endpoint.enable', payload: { endpoint_id: 'ep-7' } },
      { method: 'reception.endpoints.list', payload: undefined },
    ]);
  });

  it('disableEndpoint() fires reception.endpoint.disable then refetches', async () => {
    const { shell, fakeConn } = buildShell();
    await shell.disableEndpoint('ep-7');
    expect(fakeConn.calls[0]).toEqual({
      method: 'reception.endpoint.disable',
      payload: { endpoint_id: 'ep-7' },
    });
  });

  it('revokeEndpoint() threads an optional reason; omits it when absent', async () => {
    const withReason = buildShell();
    await withReason.shell.revokeEndpoint('ep-7', 'suspected leak');
    expect(withReason.fakeConn.calls[0]).toEqual({
      method: 'reception.endpoint.revoke',
      payload: { endpoint_id: 'ep-7', reason: 'suspected leak' },
    });
    const without = buildShell();
    await without.shell.revokeEndpoint('ep-7');
    expect(without.fakeConn.calls[0]).toEqual({
      method: 'reception.endpoint.revoke',
      payload: { endpoint_id: 'ep-7' },
    });
  });

  it('extendEndpoint() carries new_expires_at (including null for long-lived)', async () => {
    const { shell, fakeConn } = buildShell();
    await shell.extendEndpoint('ep-7', null);
    expect(fakeConn.calls[0]).toEqual({
      method: 'reception.endpoint.extend',
      payload: { endpoint_id: 'ep-7', new_expires_at: null },
    });
  });

  it('rotateToken() threads the optional reason + returns the one-shot result', async () => {
    const { shell, fakeConn } = buildShell();
    const result = await shell.rotateToken('ep-7', 'hygiene');
    expect(fakeConn.calls[0]).toEqual({
      method: 'reception.endpoint.rotate_token',
      payload: { endpoint_id: 'ep-7', reason: 'hygiene' },
    });
    // The one-shot `share_url_once` reaches the caller (the substrate
    // never re-surfaces it — the renderer captures it from the return).
    expect(result.share_url_once).toBe(
      'https://alice.recued.cloud/reception/x?t=sec',
    );
  });

  it('emergencyDisableAll() fires the rpc, flips the status override, refetches', async () => {
    const { shell, fakeConn } = buildShell();
    fakeConn.setResponse('reception.endpoints.list', {
      endpoints: [buildEndpointSummary({ enabled: true })],
    });
    await shell.emergencyDisableAll('incident-001');
    expect(fakeConn.calls[0]).toEqual({
      method: 'reception.emergency_disable_all',
      payload: { reason: 'incident-001' },
    });
    expect(fakeConn.calls[1]?.method).toBe('reception.endpoints.list');
    expect(shell.getState().status.emergency_disabled).toBe(true);
    expect(shell.getState().page?.status_header.status_label).toBe('Switched off in a hurry');
  });
});

describe('D-149 follow-on — reception page shell: per-endpoint detail', () => {
  it('openDetail() fetches the access log + builds the detail model from the cached summary', async () => {
    const { shell, fakeConn } = buildShell();
    fakeConn.setResponse('reception.endpoints.list', {
      endpoints: [buildEndpointSummary({ endpoint_id: 'ep-1' })],
    });
    await shell.loadPage();
    await shell.openDetail('ep-1');
    expect(fakeConn.calls.some((c) => c.method === 'reception.endpoint.access_log')).toBe(true);
    const detail = shell.getState().detail;
    expect(detail?.row.endpoint_id).toBe('ep-1');
    expect(detail?.share_url_available).toBe(false);
  });

  it('openDetail() on an unknown id clears the detail (no throw)', async () => {
    const { shell } = buildShell(); // endpoints.list defaults to []
    await shell.openDetail('ep-missing');
    expect(shell.getState().detail).toBeNull();
  });

  it('setEndpointShare() makes the next openDetail surface Share Cards', async () => {
    const { shell, fakeConn } = buildShell();
    fakeConn.setResponse('reception.endpoints.list', {
      endpoints: [buildEndpointSummary({ endpoint_id: 'ep-1', kind: 'intake_form' })],
    });
    await shell.loadPage();
    shell.setEndpointShare('ep-1', {
      share_url: 'https://alice.recued.cloud/reception/ep-1?t=sec',
      title: 'Send an intake',
      description: 'Tell me what you need.',
    });
    await shell.openDetail('ep-1');
    const detail = shell.getState().detail;
    expect(detail?.share_url_available).toBe(true);
    expect(detail?.share_cards.length).toBeGreaterThan(0);
  });

  it('closeDetail() clears the open detail', async () => {
    const { shell, fakeConn } = buildShell();
    fakeConn.setResponse('reception.endpoints.list', {
      endpoints: [buildEndpointSummary({ endpoint_id: 'ep-1' })],
    });
    await shell.loadPage();
    await shell.openDetail('ep-1');
    shell.closeDetail();
    expect(shell.getState().detail).toBeNull();
  });

  it('R19 Slice 4 — a slow openDetail that resolves AFTER closeDetail does NOT repopulate the detail (re-mount race)', async () => {
    const { shell, fakeConn } = buildShell();
    fakeConn.setResponse('reception.endpoints.list', {
      endpoints: [buildEndpointSummary({ endpoint_id: 'ep-1' })],
    });
    await shell.loadPage();
    // Make the access-log rpc hang until we release it — a slow detail fetch
    // the user navigates away from (Slice 4 routes detail open/close as spine
    // re-mounts over this long-lived shell).
    let releaseLog: (v: unknown) => void = () => undefined;
    fakeConn.setResponse(
      'reception.endpoint.access_log',
      () => new Promise<unknown>((resolve) => { releaseLog = resolve; }),
    );
    const opening = shell.openDetail('ep-1'); // in flight — access-log hangs
    // The user goes Back → a re-mount reconcile closes the detail mid-fetch.
    shell.closeDetail();
    expect(shell.getState().detail).toBeNull();
    // The stale fetch finally resolves — its trailing write must be dropped.
    releaseLog({ entries: [] });
    await opening;
    expect(shell.getState().detail).toBeNull();
  });

  it('R19 Slice 4 — a newer openDetail supersedes a slow older one (the stale resolve does not clobber the new detail)', async () => {
    const { shell, fakeConn } = buildShell();
    fakeConn.setResponse('reception.endpoints.list', {
      endpoints: [
        buildEndpointSummary({ endpoint_id: 'ep-1' }),
        buildEndpointSummary({ endpoint_id: 'ep-2' }),
      ],
    });
    await shell.loadPage();
    // The first access-log call hangs; later calls resolve immediately.
    let releaseFirst: (v: unknown) => void = () => undefined;
    let callIdx = 0;
    fakeConn.setResponse('reception.endpoint.access_log', () => {
      const idx = callIdx++;
      return idx === 0
        ? new Promise<unknown>((resolve) => { releaseFirst = resolve; })
        : { entries: [] };
    });
    const first = shell.openDetail('ep-1'); // hangs
    await shell.openDetail('ep-2'); // resolves → detail = ep-2
    expect(shell.getState().detail?.row.endpoint_id).toBe('ep-2');
    // The stale ep-1 fetch resolves last — it must NOT clobber ep-2.
    releaseFirst({ entries: [] });
    await first;
    expect(shell.getState().detail?.row.endpoint_id).toBe('ep-2');
  });
});

describe('D-149 follow-on — reception page shell: authoring + page upsert', () => {
  it('runPreview() fires preview_draft, projects the View-As-Visitor panel, returns the result', async () => {
    const { shell, fakeConn } = buildShell();
    const dispatch = buildEndpointPreviewDispatch({
      kind: 'scheduling_link',
      packet_declaration: {
        packet_kind: 'scheduling_link_packet',
        source_query_ref: { kind: 'data.calendar.combined' },
      },
      metadata: {},
    });
    const result = await shell.runPreview(dispatch);
    expect(fakeConn.calls[0]?.method).toBe('reception.endpoint.preview_draft');
    expect(result.preview_hash).toBe('hash-scheduling_link');
    expect(shell.getState().view_as_visitor).not.toBeNull();
  });

  it('createEndpoint() fires reception.endpoint.create, returns the result, refetches', async () => {
    const { shell, fakeConn } = buildShell();
    const dispatch = buildEndpointCreateDispatch({
      kind: 'scheduling_link',
      packet_declaration: {
        packet_kind: 'scheduling_link_packet',
        source_query_ref: { kind: 'data.calendar.combined' },
      },
      metadata: {},
      preview_hash: 'hash-scheduling_link',
    });
    const result = await shell.createEndpoint(dispatch);
    expect(result.endpoint_id).toBe('ep-new');
    expect(fakeConn.calls.map((c) => c.method)).toEqual([
      'reception.endpoint.create',
      'reception.endpoints.list',
    ]);
  });

  it('upsertReceptionPage() fires reception.page.upsert then refetches', async () => {
    const { shell, fakeConn } = buildShell();
    const dispatch = buildReceptionPageUpsertDispatch({
      display_overrides: {},
      sections_enabled: {},
      linked_endpoints: {},
    } as never);
    await shell.upsertReceptionPage(dispatch);
    expect(fakeConn.calls.map((c) => c.method)).toEqual([
      'reception.page.upsert',
      'reception.endpoints.list',
    ]);
  });

  it('closeViewAsVisitor() clears the panel', async () => {
    const { shell } = buildShell();
    await shell.runPreview(
      buildEndpointPreviewDispatch({
        kind: 'scheduling_link',
        packet_declaration: {
          packet_kind: 'scheduling_link_packet',
          source_query_ref: { kind: 'data.calendar.combined' },
        },
        metadata: {},
      }),
    );
    expect(shell.getState().view_as_visitor).not.toBeNull();
    shell.closeViewAsVisitor();
    expect(shell.getState().view_as_visitor).toBeNull();
  });
});

describe('D-149 follow-on — reception page shell: View-As-Visitor', () => {
  it('previewEndpointAsVisitor() looks up the summary + runs preview_draft', async () => {
    const { shell, fakeConn } = buildShell();
    fakeConn.setResponse('reception.endpoints.list', {
      endpoints: [buildEndpointSummary({ endpoint_id: 'ep-1', kind: 'scheduling_link' })],
    });
    await shell.loadPage();
    await shell.previewEndpointAsVisitor('ep-1');
    expect(fakeConn.calls.some((c) => c.method === 'reception.endpoint.preview_draft')).toBe(true);
    expect(shell.getState().view_as_visitor).not.toBeNull();
  });

  it('previewEndpointAsVisitor() on an unknown id captures endpoint_not_found + rejects', async () => {
    const { shell } = buildShell();
    await expect(shell.previewEndpointAsVisitor('ep-missing')).rejects.toThrow(
      /not in the loaded list/,
    );
    expect(shell.getState().last_error?.code).toBe('endpoint_not_found');
  });
});

describe('D-149 follow-on — reception page shell: Abuse Inbox', () => {
  it('loadAbuseInbox() fetches reception.abuse_inbox.list + builds the subview', async () => {
    const { shell, fakeConn } = buildShell();
    await shell.loadAbuseInbox();
    expect(fakeConn.calls[0]?.method).toBe('reception.abuse_inbox.list');
    expect(shell.getState().abuse_inbox?.header.is_empty).toBe(true);
  });

  it('loadAbuseInbox() threads the window / threshold options into the dispatch', async () => {
    const { shell, fakeConn } = buildShell();
    await shell.loadAbuseInbox({ since: 1000, cluster_threshold: 5 });
    expect(fakeConn.calls[0]).toEqual({
      method: 'reception.abuse_inbox.list',
      payload: { since: 1000, cluster_threshold: 5 },
    });
  });

  it('banIp() fires reception.abuse_inbox.ban_ip then refetches the inbox with the last opts', async () => {
    const { shell, fakeConn } = buildShell();
    await shell.loadAbuseInbox({ cluster_threshold: 5 });
    await shell.banIp('ep-1', 'abc12345def', 'persistent abuse');
    const methods = fakeConn.calls.map((c) => c.method);
    expect(methods).toEqual([
      'reception.abuse_inbox.list',
      'reception.abuse_inbox.ban_ip',
      'reception.abuse_inbox.list',
    ]);
    expect(fakeConn.calls[1]?.payload).toEqual({
      endpoint_id: 'ep-1',
      source_ip_hash: 'abc12345def',
      reason: 'persistent abuse',
    });
    // The refetch replays the prior opts.
    expect(fakeConn.calls[2]?.payload).toEqual({ cluster_threshold: 5 });
  });

  it('unbanIp() fires reception.abuse_inbox.unban_ip then refetches', async () => {
    const { shell, fakeConn } = buildShell();
    await shell.unbanIp('ep-1', 'abc12345def');
    expect(fakeConn.calls.map((c) => c.method)).toEqual([
      'reception.abuse_inbox.unban_ip',
      'reception.abuse_inbox.list',
    ]);
  });
});

describe('D-149 follow-on — reception page shell: Launch Wizard orchestration', () => {
  it('runLaunchWizard() runs page.upsert, then preview→create per draft, then refetches', async () => {
    const { shell, fakeConn } = buildShell();
    const plan = {
      page_upsert: buildReceptionPageUpsertDispatch({
        display_overrides: {},
        sections_enabled: {},
        linked_endpoints: {},
      } as never),
      drafts: [
        {
          draft: {
            kind: 'scheduling_link' as const,
            packet_declaration: {
              packet_kind: 'scheduling_link_packet' as const,
              source_query_ref: { kind: 'data.calendar.combined' as const },
            },
            metadata: {},
          },
          preview: buildEndpointPreviewDispatch({
            kind: 'scheduling_link',
            packet_declaration: {
              packet_kind: 'scheduling_link_packet',
              source_query_ref: { kind: 'data.calendar.combined' },
            },
            metadata: {},
          }),
        },
      ],
    };
    const result = await shell.runLaunchWizard(plan);
    expect(result.page_upserted).toBe(true);
    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.kind).toBe('scheduling_link');
    expect(fakeConn.calls.map((c) => c.method)).toEqual([
      'reception.page.upsert',
      'reception.endpoint.preview_draft',
      'reception.endpoint.create',
      'reception.endpoints.list',
    ]);
    // The create dispatch carries the preview's hash.
    expect((fakeConn.calls[2]?.payload as { preview_hash: string }).preview_hash).toBe(
      'hash-scheduling_link',
    );
  });
});

describe('D-149 follow-on — reception page shell: broadcast handlers', () => {
  it('reception.endpoint_changed refetches reception.endpoints.list', async () => {
    const { shell, fakeConn, fakeSub } = buildShell();
    fakeSub.emit({
      kind: 'reception.endpoint_changed',
      op: 'enable',
      endpoint_id: 'ep-1',
      cursor: 1,
    });
    await tick();
    expect(fakeConn.calls.map((c) => c.method)).toContain('reception.endpoints.list');
    expect(shell.getState().page).not.toBeNull();
  });

  it('reception.endpoint_changed refreshes an open detail for the same endpoint', async () => {
    const { shell, fakeConn, fakeSub } = buildShell();
    fakeConn.setResponse('reception.endpoints.list', {
      endpoints: [buildEndpointSummary({ endpoint_id: 'ep-1' })],
    });
    await shell.loadPage();
    await shell.openDetail('ep-1');
    const before = fakeConn.calls.filter((c) => c.method === 'reception.endpoint.access_log').length;
    fakeSub.emit({
      kind: 'reception.endpoint_changed',
      op: 'rotate_token',
      endpoint_id: 'ep-1',
      cursor: 2,
    });
    await tick();
    const after = fakeConn.calls.filter((c) => c.method === 'reception.endpoint.access_log').length;
    expect(after).toBeGreaterThan(before);
  });

  it('reception.emergency_disabled flips the status override + optimistically reduces the page', async () => {
    const { shell, fakeConn, fakeSub } = buildShell();
    fakeConn.setResponse('reception.endpoints.list', {
      endpoints: [buildEndpointSummary({ endpoint_id: 'ep-1', enabled: true })],
    });
    await shell.loadPage();
    expect(shell.getState().page?.active_endpoints).toBe(1);
    fakeSub.emit({
      kind: 'reception.emergency_disabled',
      disabled_count: 1,
      reason: 'incident',
      cursor: 3,
    });
    // Synchronous optimistic apply — before the refetch settles.
    const optimistic = shell.getState();
    expect(optimistic.status.emergency_disabled).toBe(true);
    expect(optimistic.page?.active_endpoints).toBe(0);
    expect(optimistic.page?.status_header.status_label).toBe('Switched off in a hurry');
    await tick();
    // Authoritative refetch still reflects the emergency-disabled status.
    expect(shell.getState().page?.status_header.emergency_disabled).toBe(true);
  });
});

describe('D-149 follow-on — reception page shell: errors + observability', () => {
  it('captures an RpcError code into last_error AND re-throws', async () => {
    const { shell, fakeConn } = buildShell();
    fakeConn.setResponse(
      'reception.endpoint.enable',
      new RpcError('endpoint_already_enabled', 'already on', 409, 'reception.endpoint.enable'),
    );
    await expect(shell.enableEndpoint('ep-1')).rejects.toThrow('already on');
    expect(shell.getState().last_error).toEqual({
      code: 'endpoint_already_enabled',
      message: 'already on',
    });
    expect(shell.getState().loading).toBe(false);
  });

  it('a non-RpcError throw is captured as a transport error', async () => {
    const { shell, fakeConn } = buildShell();
    fakeConn.setResponse('reception.endpoints.list', new Error('socket dropped'));
    await expect(shell.loadPage()).rejects.toThrow('socket dropped');
    expect(shell.getState().last_error?.code).toBe('transport');
  });

  it('a successful action clears a prior last_error', async () => {
    const { shell, fakeConn } = buildShell();
    fakeConn.setResponse('reception.endpoints.list', new Error('boom'));
    await expect(shell.loadPage()).rejects.toThrow();
    expect(shell.getState().last_error).not.toBeNull();
    fakeConn.setResponse('reception.endpoints.list', { endpoints: [] });
    await shell.loadPage();
    expect(shell.getState().last_error).toBeNull();
  });

  it('subscribe() observers fire on state change; unsubscribe stops them', async () => {
    const { shell } = buildShell();
    const seen: number[] = [];
    const off = shell.subscribe((s) => seen.push(s.page === null ? 0 : s.page.total_endpoints));
    await shell.loadPage();
    expect(seen.length).toBeGreaterThan(0);
    const countAfterFirstLoad = seen.length;
    off();
    await shell.loadPage();
    expect(seen.length).toBe(countAfterFirstLoad);
  });

  it('loading is true mid-flight and false once settled', async () => {
    const { shell, fakeConn } = buildShell();
    let loadingDuringCall = false;
    fakeConn.setResponse('reception.endpoints.list', () => {
      loadingDuringCall = shell.getState().loading;
      return { endpoints: [] };
    });
    await shell.loadPage();
    expect(loadingDuringCall).toBe(true);
    expect(shell.getState().loading).toBe(false);
  });
});

describe('D-149 follow-on — reception page shell: Codex fold (one-shot results + broadcast ordering)', () => {
  it('rotateToken() still returns the one-shot result when the post-rotate refetch fails', async () => {
    const { shell, fakeConn } = buildShell();
    fakeConn.setResponse('reception.endpoints.list', new Error('refetch failed'));
    const result = await shell.rotateToken('ep-7');
    // The never-re-readable URL reaches the caller despite the refetch
    // failure; the refetch error is captured into `last_error`.
    expect(result.share_url_once).toBe(
      'https://alice.recued.cloud/reception/x?t=sec',
    );
    expect(shell.getState().last_error?.code).toBe('transport');
  });

  it('createEndpoint() still returns the create result when the post-create refetch fails', async () => {
    const { shell, fakeConn } = buildShell();
    fakeConn.setResponse('reception.endpoints.list', new Error('refetch failed'));
    const result = await shell.createEndpoint(
      buildEndpointCreateDispatch({
        kind: 'scheduling_link',
        packet_declaration: {
          packet_kind: 'scheduling_link_packet',
          source_query_ref: { kind: 'data.calendar.combined' },
        },
        metadata: {},
        preview_hash: 'hash-scheduling_link',
      }),
    );
    expect(result.endpoint_id).toBe('ep-new');
    expect(result.share_url_once).toContain('https://');
    expect(shell.getState().last_error?.code).toBe('transport');
  });

  it('runLaunchWizard() still returns the created results when the final refetch fails', async () => {
    const { shell, fakeConn } = buildShell();
    fakeConn.setResponse('reception.endpoints.list', new Error('refetch failed'));
    const result = await shell.runLaunchWizard({
      page_upsert: buildReceptionPageUpsertDispatch({
        display_overrides: {},
        sections_enabled: {},
        linked_endpoints: {},
      } as never),
      drafts: [
        {
          draft: {
            kind: 'scheduling_link' as const,
            packet_declaration: {
              packet_kind: 'scheduling_link_packet' as const,
              source_query_ref: { kind: 'data.calendar.combined' as const },
            },
            metadata: {},
          },
          preview: buildEndpointPreviewDispatch({
            kind: 'scheduling_link',
            packet_declaration: {
              packet_kind: 'scheduling_link_packet',
              source_query_ref: { kind: 'data.calendar.combined' },
            },
            metadata: {},
          }),
        },
      ],
    });
    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.result.share_url_once).toContain('https://');
  });

  it('reception.endpoint_changed refreshes the open detail from the FRESH list, not the stale summary', async () => {
    const { shell, fakeConn, fakeSub } = buildShell();
    fakeConn.setResponse('reception.endpoints.list', {
      endpoints: [buildEndpointSummary({ endpoint_id: 'ep-1', audit_count: 0 })],
    });
    await shell.loadPage();
    await shell.openDetail('ep-1');
    expect(shell.getState().detail?.row.audit_count).toBe(0);
    // The endpoint mutates server-side — the next list refetch returns
    // the updated summary.
    fakeConn.setResponse('reception.endpoints.list', {
      endpoints: [buildEndpointSummary({ endpoint_id: 'ep-1', audit_count: 5 })],
    });
    fakeSub.emit({
      kind: 'reception.endpoint_changed',
      op: 'rotate_token',
      endpoint_id: 'ep-1',
      cursor: 9,
    });
    await tick();
    // The detail reflects the FRESH summary — the detail refetch was
    // chained AFTER the list refetch, not raced against it.
    expect(shell.getState().detail?.row.audit_count).toBe(5);
  });
});
