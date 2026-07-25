/** D-137 P1.2 — chat-orchestrator channel-isolation lint.
 *
 *  Same intent as the engine-side ratchet (`packages/engine/src/__tests-
 *  __/d-137-phase-1-internal-tool-registry-channel-isolation.ratchet.
 *  test.ts`) but for the backend-side orchestrator + chat-handler. The
 *  orchestrator runs in the same process as the MCP server (both live
 *  in `backend/server/`), so importing or referencing MCP-wire surfaces
 *  here is technically *possible* — this ratchet stops it from
 *  happening accidentally during P1.3+ slices.
 *
 *  Failures here mean a future PR has introduced a violation; fix the
 *  reference at the source. Do NOT widen the forbidden list (that
 *  would dilute the contract). */

import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const ORCHESTRATOR_FILE = resolve(__dirname, '..', 'chat-orchestrator.ts');
const HANDLER_FILE = resolve(__dirname, '..', 'chat-handler.ts');

/** Forbidden text patterns. Per project_mcp_channel_invariant.md the
 *  chat-agent path MUST NOT consult `entitlements` or Pro-gating, or
 *  loop through the MCP wire. */
const FORBIDDEN_TOKEN_PATTERNS: ReadonlyArray<RegExp> = [
  /\bmcp_dispatch\b/,
  /\bentitlements\./,
  /\bpro_tier\./,
];

/** Forbidden import paths. The orchestrator stays at the engine-
 *  primitive consumer layer and the audit / broadcast surfaces; it
 *  does not reach into the MCP server adapter or the entitlement gate. */
const FORBIDDEN_PACKAGE_IMPORTS: ReadonlyArray<RegExp> = [
  // No direct import of the MCP server module
  /from\s+['"]\.\/mcp-server(?:\.js)?['"]/,
  /from\s+['"][^'"]*\/mcp-server(?:\.js)?['"]/,
  // No direct import of mcp/* wire handlers
  /from\s+['"]\.\/mcp\//,
  /from\s+['"][^'"]*\/mcp\//,
  // No entitlements imports
  /from\s+['"][^'"]*entitlements['"]/,
];

const expectsCleanFile = (path: string): void => {
  expect(() => statSync(path)).not.toThrow();
  const src = readFileSync(path, 'utf8');
  for (const pattern of FORBIDDEN_TOKEN_PATTERNS) {
    expect(
      pattern.test(src),
      `${path}: contains forbidden token matching ${pattern} — channel isolation violation`,
    ).toBe(false);
  }
  for (const pattern of FORBIDDEN_PACKAGE_IMPORTS) {
    expect(
      pattern.test(src),
      `${path}: contains forbidden import matching ${pattern} — channel isolation violation`,
    ).toBe(false);
  }
};

describe('D-137 P1.2 — chat-orchestrator channel-isolation invariant', () => {
  it('chat-orchestrator.ts does not reference MCP-wire / entitlements', () => {
    expectsCleanFile(ORCHESTRATOR_FILE);
  });

  it('chat-handler.ts does not reference MCP-wire / entitlements', () => {
    expectsCleanFile(HANDLER_FILE);
  });

  it('synthetic regression — mcp_dispatch audit kind IS flagged', () => {
    const synthetic = `logActivity({ action: 'mcp_dispatch', target: 't' });`;
    expect(FORBIDDEN_TOKEN_PATTERNS.some((p) => p.test(synthetic))).toBe(true);
  });

  it('synthetic regression — entitlements gate IS flagged', () => {
    const synthetic = `if (entitlements.pro_tier.enabled) {}`;
    expect(FORBIDDEN_TOKEN_PATTERNS.some((p) => p.test(synthetic))).toBe(true);
  });

  it('synthetic regression — MCP-server import IS flagged', () => {
    const synthetic = `import { startMCPServer } from './mcp-server.js';`;
    expect(FORBIDDEN_PACKAGE_IMPORTS.some((p) => p.test(synthetic))).toBe(true);
  });
});
