/** D-151 P2 — route-level `onProposeIntent` seam acceptance.
 *
 *  `mountReceptionRoute` wires an `onProposeIntent` into the settings host:
 *  it runs `reception.compose.propose` over the free text, converts the
 *  `ProposedEndpointConfig` into a per-kind authoring seed (dropping
 *  forbidden field types at the contract boundary), and surfaces a friendly
 *  `{ ok: false }` on rpc failure. This suite mocks the settings host to
 *  capture that seam + drives it directly — the mount-level UX (Drafting…
 *  status, onUseProposed → openAuthoringForm) is covered in
 *  `d-149-settings-reception-templates-mount.test.ts`. */

import { describe, expect, it, vi } from 'vitest';

// Capture the opts the route passes into the settings host.
const captured: { opts?: Record<string, any> } = {};
vi.mock('../settings/reception-settings-host.js', () => ({
  mountReceptionSettings: (opts: Record<string, any>) => {
    captured.opts = opts;
    return { update: () => {}, dispose: () => {} };
  },
}));
// The inbox panel is constructed only when an inboxHost is supplied; we
// supply none, so no mock is needed for it.

import { mountReceptionRoute } from '../settings/reception-route.js';

const makeFakeHost = (): HTMLElement =>
  ({
    innerHTML: '',
    addEventListener: () => {},
    removeEventListener: () => {},
    contains: () => true,
  }) as unknown as HTMLElement;

const makeShell = () =>
  ({
    getState: () => ({}),
    subscribe: () => () => {},
    loadPage: () => {},
    // R19 Slice 4 — `mountReceptionRoute` reconciles the drill-in view state
    // on mount, so the (minimal) fake shell must stub these.
    closeViewAsVisitor: () => {},
    closeDetail: () => {},
    openDetail: () => Promise.resolve(),
  }) as unknown as Parameters<typeof mountReceptionRoute>[0]['shell'];

interface ConnCall {
  method: string;
  payload: unknown;
}

const mountWithConn = (
  conn: (method: string, payload?: unknown) => Promise<unknown>,
) => {
  const calls: ConnCall[] = [];
  const tracked = (method: string, payload?: unknown): Promise<unknown> => {
    calls.push({ method, payload });
    return conn(method, payload);
  };
  const route = mountReceptionRoute({
    pageHost: makeFakeHost(),
    modalHost: makeFakeHost(),
    promptsHost: makeFakeHost(),
    shell: makeShell(),
    conn: tracked as unknown as Parameters<typeof mountReceptionRoute>[0]['conn'],
    exposureProfile: 'p',
  });
  return { route, calls };
};

describe('D-151 P2 — mountReceptionRoute: onProposeIntent', () => {
  it('runs reception.compose.propose + converts the result to an authoring seed', async () => {
    const proposed = {
      version: '1.0.0',
      kind: 'intake_form',
      title: 'Speaker bios',
      description: 'Collect bios.',
      form_definition: {
        form_definition_id: 'fd_bios',
        fields: [
          { name: 'your_name', type: 'text', label: 'Your name', required: true },
          // A forbidden type — must be dropped by the converter at the boundary.
          { name: 'secret', type: 'password', label: 'Password', required: true },
        ],
        email_requirement: 'required',
      },
      expiry_policy: { mode: 'never' },
      notification: { on_submit: true, channels: ['webclient_inbox'] },
      exposure_intent: 'public_anonymous',
      source_path: 'intent',
      ai_trace_redacted: {
        version: '1.0.0',
        source_path: 'intent',
        detected_slots: {},
        selected_kind: 'intake_form',
        selection_reason_short: 'detected a form intent',
      },
    };
    const { route, calls } = mountWithConn((method) =>
      method === 'reception.compose.propose'
        ? Promise.resolve(proposed)
        : Promise.resolve({ config: null, last_updated_at: null, templates: [] }),
    );
    const onProposeIntent = captured.opts!.onProposeIntent as (
      intent: string,
    ) => Promise<any>;
    const result = await onProposeIntent('a form for speaker bios');

    expect(calls).toContainEqual({
      method: 'reception.compose.propose',
      payload: { intent_text: 'a form for speaker bios' },
    });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('intake_form');
    expect(result.reason).toBe('detected a form intent');
    // The forbidden `password` field was dropped at the contract boundary.
    const fields = result.config.form_definition.fields as Array<{ name: string }>;
    expect(fields.map((f) => f.name)).toEqual(['your_name']);
    route.dispose();
  });

  it('returns a friendly { ok: false } when the propose rpc rejects', async () => {
    const { route } = mountWithConn((method) =>
      method === 'reception.compose.propose'
        ? Promise.reject(new Error('no AI configured'))
        : Promise.resolve({ config: null, last_updated_at: null, templates: [] }),
    );
    const onProposeIntent = captured.opts!.onProposeIntent as (
      intent: string,
    ) => Promise<any>;
    const result = await onProposeIntent('something');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('needs AI set up');
    route.dispose();
  });
});
