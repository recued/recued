/** D-177 P2b — Tier-3 MCP dispatch routes through kernel manifests.
 *
 *  The chat Tier-3 path cannot dispatch an arbitrary external MCP tool directly.
 *  It must select one of these kernel ingredients so the manifest risk_tier feeds
 *  the ordinary policy verdict: read-classified tools stay pass-through, while
 *  write-classified tools hold for approval at attended user_self cells. */

import { describe, expect, it } from 'vitest';

import {
  CONNECTION_MCP_READ_SLUG,
  CONNECTION_MCP_WRITE_SLUG,
  OUTBOUND_SEND_INGREDIENT_SLUGS,
  admitByOpRisk,
  isOutboundSendSlug,
  resolveTrustCeiling,
  type ExecutionSource,
  type IngredientManifest,
  type ToolUnderEvaluation,
} from '../index.js';

// Inline fixtures mirroring the moved kernel manifests. connection-mcp-read/write are now inlined in
// backend KERNEL_MANIFESTS (out of community/), which a contracts test can't import across the public
// boundary — so the read/write shape that feeds the policy verdict is pinned here directly.
const MCP_MANIFESTS: Record<string, IngredientManifest> = {
  [CONNECTION_MCP_READ_SLUG]: {
    slug: CONNECTION_MCP_READ_SLUG,
    name: 'MCP tool call (read)',
    description: 'Read-classified MCP tool call over a connection.',
    author: 'recued',
    kind: 'connection',
    category: 'data',
    risk_tier: 'read',
    permission: 'connection.mcp_tool',
    input: { connection_kind: 'mcp', connection: null, tool: null, args: {} },
    output: {},
  } as unknown as IngredientManifest,
  [CONNECTION_MCP_WRITE_SLUG]: {
    slug: CONNECTION_MCP_WRITE_SLUG,
    name: 'MCP tool call (write)',
    description: 'Write-classified MCP tool call over a connection.',
    author: 'recued',
    kind: 'connection',
    category: 'action',
    risk_tier: 'write',
    permission: 'connection.mcp_tool',
    input: { connection_kind: 'mcp', connection: null, tool: null, args: {} },
    output: {},
  } as unknown as IngredientManifest,
};

const loadManifest = (slug: string): IngredientManifest => MCP_MANIFESTS[slug];

const CHAT_SOURCE: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'chat-session-1',
  user_id: 'user-1',
};

const SCHEDULE_SOURCE: ExecutionSource = {
  channel: 'schedule',
  actor: 'system',
  cron: '0 9 * * 1-5',
  source_recipe: 'daily-digest',
};

// D-209 §1.4 — an admin-shell SYSTEM source (housekeeping; a webhook door resolves the
// same). It KEEPS the `admin` ceiling, so a Tier-3 write admits — proving the lift is
// system-exempt. A `schedule`/`reactive` system source now fails closed to `read`.
const HOUSEKEEPING_SOURCE: ExecutionSource = {
  channel: 'housekeeping',
  actor: 'system',
  cycle_id: 'cyc',
  task: 'maintenance',
  visible_to_user: false,
};

const toolFromManifest = (manifest: IngredientManifest): ToolUnderEvaluation => ({
  slug: manifest.slug,
  kind: manifest.kind,
  risk_tier: manifest.risk_tier,
});

describe('D-177 P2b — Tier-3 MCP kernel manifests', () => {
  it('exports the closed read/write kernel slugs used by chat Tier-3 routing', () => {
    expect(CONNECTION_MCP_READ_SLUG).toBe('connection-mcp-read');
    expect(CONNECTION_MCP_WRITE_SLUG).toBe('connection-mcp-write');
    expect(CONNECTION_MCP_READ_SLUG).not.toBe(CONNECTION_MCP_WRITE_SLUG);
  });

  it('pins the read/write manifest metadata that feeds the policy verdict', () => {
    const read = loadManifest(CONNECTION_MCP_READ_SLUG);
    const write = loadManifest(CONNECTION_MCP_WRITE_SLUG);

    // `author: 'recued'` is load-bearing three ways: kernel-namespace
    // marketplace invisibility, the MCP-wire per-ingredient catalog's
    // `isMcpExposedKernelIngredient` hiding, and (for non-connection
    // kinds) kernel dispatch-slot routing.
    expect(read).toMatchObject({
      slug: CONNECTION_MCP_READ_SLUG,
      author: 'recued',
      kind: 'connection',
      category: 'data',
      risk_tier: 'read',
      permission: 'connection.mcp_tool',
      input: {
        connection_kind: 'mcp',
        connection: null,
        tool: null,
        args: {},
      },
    });
    expect(write).toMatchObject({
      slug: CONNECTION_MCP_WRITE_SLUG,
      author: 'recued',
      kind: 'connection',
      category: 'action',
      risk_tier: 'write',
      permission: 'connection.mcp_tool',
      input: {
        connection_kind: 'mcp',
        connection: null,
        tool: null,
        args: {},
      },
    });
  });

  it('classifies only the write manifest as outbound-send escalation', () => {
    expect(isOutboundSendSlug(CONNECTION_MCP_READ_SLUG)).toBe(false);
    expect(isOutboundSendSlug(CONNECTION_MCP_WRITE_SLUG)).toBe(true);
    expect([...OUTBOUND_SEND_INGREDIENT_SLUGS]).toContain(CONNECTION_MCP_WRITE_SLUG);
    expect([...OUTBOUND_SEND_INGREDIENT_SLUGS]).not.toContain(CONNECTION_MCP_READ_SLUG);
  });

  it('admits read-classified Tier-3 MCP calls but asks for write-classified calls in chat', () => {
    // D-187 slice 4 — the verdict is now op-risk × stage-trust (`admitByOpRisk`). At
    // the contract-less owner ceiling (`admin`) the read admits and the write relaxes
    // to admit, then the user_self-scoped outbound-send lift re-raises the write
    // (`connection-mcp-write` ∈ the send set) to `ask`.
    const readTool = toolFromManifest(loadManifest(CONNECTION_MCP_READ_SLUG));
    const writeTool = toolFromManifest(loadManifest(CONNECTION_MCP_WRITE_SLUG));
    const readDecision = admitByOpRisk({
      slug: readTool.slug,
      risk_tier: readTool.risk_tier,
      ceiling: resolveTrustCeiling(CHAT_SOURCE),
      source: CHAT_SOURCE,
    });
    const writeDecision = admitByOpRisk({
      slug: writeTool.slug,
      risk_tier: writeTool.risk_tier,
      ceiling: resolveTrustCeiling(CHAT_SOURCE),
      source: CHAT_SOURCE,
    });

    expect(readDecision.verdict).toBe('admit');
    expect(writeDecision.verdict).toBe('ask');
    if (writeDecision.verdict === 'ask') {
      expect(writeDecision.risk_tier).toBe('write');
      expect(writeDecision.detail).toContain(CONNECTION_MCP_WRITE_SLUG);
    }
  });

  it('does not ask for write-classified Tier-3 MCP calls on an admin-shell system dispatch (lift is system-exempt)', () => {
    // `system` is exempt from the lift. At the admin ceiling (housekeeping / webhook door)
    // a Tier-3 write therefore admits — the lift never re-raises it.
    const writeTool = toolFromManifest(loadManifest(CONNECTION_MCP_WRITE_SLUG));
    const decision = admitByOpRisk({
      slug: writeTool.slug,
      risk_tier: writeTool.risk_tier,
      ceiling: resolveTrustCeiling(HOUSEKEEPING_SOURCE),
      source: HOUSEKEEPING_SOURCE,
    });

    expect(decision.verdict).toBe('admit');
  });

  it('D-209 §1.4 — a write-classified Tier-3 MCP call on a (schedule) system dispatch HOLDS via the LOW ceiling', () => {
    // Unattended owner automation now fails closed to `read`, so the write surfaces
    // (write > read) — via the CEILING, not the system-exempt lift.
    const writeTool = toolFromManifest(loadManifest(CONNECTION_MCP_WRITE_SLUG));
    const decision = admitByOpRisk({
      slug: writeTool.slug,
      risk_tier: writeTool.risk_tier,
      ceiling: resolveTrustCeiling(SCHEDULE_SOURCE),
      source: SCHEDULE_SOURCE,
    });

    expect(decision.verdict).toBe('ask');
  });
});
