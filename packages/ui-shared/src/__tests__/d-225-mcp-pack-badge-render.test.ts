/** D-225 Slice 2 — the generated-pack badge in the connection-detail render.
 *
 *  The projection is tested separately (`d-225-mcp-pack-surfaces`); this pins
 *  that it actually REACHES the page, and the two conditions under which it
 *  must not.
 *
 *  ⚠ Asserts the DOM the host keys on (`data-mcp-pack-tone`,
 *  `data-mcp-pack-action`) rather than the CSS — a render test cannot see a
 *  stylesheet, so asserting "it looks urgent" would be asserting nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  initialConnectionsPageState,
  MCP_PACK_INSTALL_SCOPE_HOST_ATTR,
  renderConnectionsPage,
  mcpPackReviewView,
  type ConnectionsPageState,
} from '../index.js';

const CONNECTIONS = [
  { name: 'gh-mcp', kind: 'mcp' as const, subtype: 'sse', display_name: 'GitHub MCP', endpoint: 'https://mcp.github.com/sse' },
  { name: 'hubspot', kind: 'api' as const, display_name: 'HubSpot', base_url: 'https://api.hubapi.com' },
];

const state = (
  mcpPackStatus?: ConnectionsPageState['mcpPackStatus'],
): ConnectionsPageState => ({
  ...initialConnectionsPageState(),
  connections: CONNECTIONS,
  ...(mcpPackStatus !== undefined ? { mcpPackStatus } : {}),
});

const withStatus = (over: Record<string, unknown>) =>
  state({
    'mcp/gh-mcp': {
      pack_slug: `mcp-${'a'.repeat(32)}`,
      status: 'current',
      added: 0,
      removed: 0,
      ...over,
    } as never,
  });

describe('D-225 — the badge reaches the connection detail', () => {
  it('renders the drifted badge with its tone and its action', () => {
    const html = renderConnectionsPage(withStatus({ status: 'drifted', added: 2, removed: 1 }));
    expect(html).toContain('data-conn-mcp-pack="mcp/gh-mcp"');
    expect(html).toContain('data-mcp-pack-tone="attention"');
    expect(html).toContain('data-mcp-pack-action="review"');
    expect(html).toContain('Tools changed');
    expect(html).toContain('2 new or changed');
  });

  it('⛔ renders UNKNOWN visibly rather than as nothing', () => {
    // The badge's whole reason for keeping `unknown` distinct: a row that
    // rendered nothing would read as "fine" on exactly the connections nobody
    // has probed.
    const html = renderConnectionsPage(withStatus({ status: 'unknown' }));
    expect(html).toContain('data-mcp-pack-tone="attention"');
    expect(html).toContain('Not checked');
    expect(html).toContain('data-mcp-pack-action="probe"');
  });

  it('renders `current` without the attention tone', () => {
    const html = renderConnectionsPage(withStatus({ status: 'current' }));
    expect(html).toContain('data-mcp-pack-tone="ok"');
    expect(html).not.toContain('data-mcp-pack-tone="attention"');
    // No action to take when it is up to date.
    expect(html).not.toContain('data-mcp-pack-action');
  });

  it('offers to generate when there is no pack', () => {
    const html = renderConnectionsPage(withStatus({ status: 'no_pack' }));
    expect(html).toContain('data-mcp-pack-action="generate"');
    expect(html).toContain('Generate pack');
  });

  // ── the two cases where nothing must render ────────────────────────────
  it('renders no badge when the status has not been fetched', () => {
    // ⚠ Correct ONLY because absent means "not fetched yet". A host that
    // hydrated a FAILED fetch as absent would recreate the false all-clear the
    // `unknown` status exists to prevent — which is why the state field says so.
    const html = renderConnectionsPage(state());
    expect(html).not.toContain('data-conn-mcp-pack');
  });

  it('renders no badge on a NON-mcp connection, even if a status is present', () => {
    // A generated pack only ever backs an mcp connection. A stray keyed entry
    // must not paint a badge onto an api row.
    const html = renderConnectionsPage(
      state({ 'api/hubspot': { pack_slug: 'x', status: 'drifted', added: 1, removed: 0 } as never }),
    );
    expect(html).not.toContain('data-conn-mcp-pack');
  });

  it('the badge text is HTML-escaped', () => {
    // The detail is server-derived copy today, but it flows through the same
    // interpolation as any other value and must not be the one place that
    // trusts its input.
    const html = renderConnectionsPage(
      state({
        'mcp/gh-mcp': {
          pack_slug: '<script>alert(1)</script>',
          status: 'drifted',
          added: 1,
          removed: 0,
        } as never,
      }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});

describe('D-225 — the review screen', () => {
  const review = (over: Record<string, unknown> = {}) => ({
    ...initialConnectionsPageState(),
    connections: CONNECTIONS,
    mcpPackReview: {
      connection: { kind: 'mcp' as const, name: 'gh-mcp' },
      loading: false,
      error: null,
      pack_slug: `mcp-${'a'.repeat(32)}`,
      saving: false,
      view: mcpPackReviewView([
        {
          op: 'delete_all_a1b2c3d4',
          tool: 'delete_all',
          description: 'Remove everything.',
          stored: { risk: 'write', approval: 'ask' },
          suggested: { risk: 'read', approval: 'never' },
          server_says: { read_only: true },
        },
      ]),
      ...over,
    },
  } as ConnectionsPageState);

  it('lists each tool with the tier it will actually get', () => {
    const html = renderConnectionsPage(review());
    expect(html).toContain('data-mcp-pack-review="gh-mcp"');
    expect(html).toContain('delete_all');
    expect(html).toContain('Held for approval — write / ask');
    expect(html).toContain(`${MCP_PACK_INSTALL_SCOPE_HOST_ATTR}=""`);
    expect(html).toContain('data-action="connections-mcp-pack-save"');
  });

  it('⛔ renders the server’s claim as ATTRIBUTED, and offers NO relax control', () => {
    // The screen is a disclosure. A per-row relax button would route a
    // downgrade around `confirm_risk_downgrade` — the confirmation that exists
    // precisely because relaxing is the dangerous direction.
    const html = renderConnectionsPage(review());
    expect(html).toContain('The server describes this tool as read-only');
    expect(html).toContain('relax this to read / never in pack detail after installing');
    // No control that changes what Save does.
    expect(html).not.toContain('data-action="connections-mcp-pack-relax"');
  });

  it('⛔ shows a failed probe as an ERROR, never as an empty list', () => {
    // Zero rows reads as "this server has no tools" — an owner could Save that
    // believing they had reviewed something.
    const html = renderConnectionsPage(review({ error: 'probe did not return a tool list', view: null }));
    expect(html).toContain('data-review-state="error"');
    expect(html).toContain('probe did not return a tool list');
    expect(html).not.toContain('data-action="connections-mcp-pack-save"');
  });

  it('offers no Install when the server genuinely publishes nothing', () => {
    // The paired case: an empty list from a HEALTHY probe is a real answer, and
    // there is nothing to install.
    const html = renderConnectionsPage(review({ view: mcpPackReviewView([]) }));
    expect(html).toContain('data-review-state="ready"');
    expect(html).toContain('no tools');
    expect(html).not.toContain(MCP_PACK_INSTALL_SCOPE_HOST_ATTR);
    expect(html).not.toContain('data-action="connections-mcp-pack-save"');
  });

  it('disables Save while installing', () => {
    expect(renderConnectionsPage(review({ saving: true }))).toContain('Installing…');
  });

  it('renders nothing when no review is open', () => {
    expect(renderConnectionsPage(state())).not.toContain('data-mcp-pack-review');
  });
});
