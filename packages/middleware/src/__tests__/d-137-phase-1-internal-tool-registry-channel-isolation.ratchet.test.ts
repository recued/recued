/** D-137 P1 — InternalToolRegistry channel-isolation lint.
 *
 *  Per spec § A.1 + § A.2 + `project_mcp_channel_invariant.md`:
 *  the chat agent is **internal-channel** — it accesses engine
 *  primitives via direct function-call through `InternalToolRegistry`.
 *  It MUST NOT loop back through the MCP wire (which would conflate
 *  channels: introduce token gymnastics for self-access, apply
 *  per-token rate limits to the owner's own usage, etc.).
 *
 *  This file is the executable form of that invariant. It scans every
 *  TypeScript source under `packages/engine/src/internal-tool-registry/`
 *  for forbidden token references:
 *
 *    - `mcp-server` / `mcp_dispatch` — MCP wire surfaces; the chat
 *      registry calls engine primitives directly, never via the wire.
 *    - `entitlements.` / `pro_tier.` — chat is free; never Pro-gated.
 *
 *  Test failures here mean a future PR has introduced a violation.
 *  Fix the import / token reference at the source; do NOT widen the
 *  forbidden list (that would dilute the contract). */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REGISTRY_ROOT = resolve(__dirname, '..', 'internal-tool-registry');

/** Closed list of forbidden source-text patterns. Each pattern is a
 *  load-bearing channel-isolation marker; the chat registry MUST NOT
 *  participate in any of the MCP-wire / Pro-gating paths.
 *
 *  Pattern notes:
 *   - `\bmcp_dispatch\b` matches the audit kind without flagging
 *     unrelated `mcp` substrings (e.g. `connection.mcp.*` namespace).
 *   - `mcp-server` matches the file/module name explicitly so a
 *     `from '../../mcp-server.js'` import path lights up.
 *   - `entitlements\.` + `pro_tier\.` catch direct Pro consultation. */
const FORBIDDEN_TOKEN_PATTERNS: ReadonlyArray<RegExp> = [
  /\bmcp_dispatch\b/,
  /from\s+['"][^'"]*mcp-server[^'"]*['"]/,
  /\bentitlements\./,
  /\bpro_tier\./,
];

/** Closed list of `packages/*` directories the chat registry MUST NOT
 *  import. The registry's caller (backend/server's chat-handler slice
 *  + the MCP server adapter that wraps the same registry for external
 *  agents) is what threads the wire-channel concerns; the registry
 *  itself stays at the engine-primitive layer. */
const FORBIDDEN_PACKAGE_IMPORTS: ReadonlyArray<string> = [
  // Backend server is the wire-handler layer. The registry MUST stay
  // in packages/engine — it cannot reach back into server code.
  // Relative paths into backend/server are blocked.
  '../../../backend',
  '../../backend',
  // No direct imports of the MCP wire handler.
  '../mcp',
  '../../mcp-server',
];

const collectTsFiles = (dir: string): string[] => {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    if (entry === '__tests__') continue;
    if (entry.startsWith('.')) continue;
    const path = join(dir, entry);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...collectTsFiles(path));
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(path);
    }
  }
  return out;
};

const findForbiddenTokens = (file: string): string[] => {
  const src = readFileSync(file, 'utf8');
  const violations: string[] = [];
  for (const re of FORBIDDEN_TOKEN_PATTERNS) {
    if (re.test(src)) violations.push(re.source);
  }
  return violations;
};

const findForbiddenImports = (file: string): string[] => {
  const src = readFileSync(file, 'utf8');
  const violations: string[] = [];
  for (const forbidden of FORBIDDEN_PACKAGE_IMPORTS) {
    const escaped = forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`from\\s+['"]${escaped}(/[^'"]*)?['"]`);
    if (re.test(src)) violations.push(forbidden);
    const dynRe = new RegExp(`import\\s*\\(\\s*['"]${escaped}(/[^'"]*)?['"]`);
    if (dynRe.test(src)) violations.push(`(dynamic) ${forbidden}`);
  }
  return violations;
};

describe('D-137 P1 — InternalToolRegistry channel-isolation lint (§ A.2)', () => {
  const files = collectTsFiles(REGISTRY_ROOT);

  it('substrate exists and ships at least one source file', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no registry file references MCP-channel audit kinds or wire handlers', () => {
    const offenders: Array<{ file: string; violations: string[] }> = [];
    for (const file of files) {
      const v = findForbiddenTokens(file);
      if (v.length > 0) offenders.push({ file, violations: v });
    }
    expect(offenders).toEqual([]);
  });

  it('no registry file imports backend server or MCP wire handler', () => {
    const offenders: Array<{ file: string; violations: string[] }> = [];
    for (const file of files) {
      const v = findForbiddenImports(file);
      if (v.length > 0) offenders.push({ file, violations: v });
    }
    expect(offenders).toEqual([]);
  });
});

describe('D-137 P1 — channel-isolation lint synthetic-regression sanity', () => {
  it('forbidden-token matcher catches a synthetic mcp_dispatch reference', () => {
    const synthetic = `action: 'mcp_dispatch' as ActivityAction,`;
    expect(/\bmcp_dispatch\b/.test(synthetic)).toBe(true);
  });

  it('forbidden-token matcher catches a synthetic entitlements reference', () => {
    const synthetic = `if (entitlements.pro) skipGate();`;
    expect(/\bentitlements\./.test(synthetic)).toBe(true);
  });

  it('does not flag legitimate `connection.mcp.*` namespace references', () => {
    const ok = `// Tier 3 — connection.mcp.* passthroughs surface here`;
    // None of the forbidden patterns should match this legitimate prose.
    for (const re of FORBIDDEN_TOKEN_PATTERNS) {
      expect(re.test(ok)).toBe(false);
    }
  });

  it('does not flag legitimate @recued/contracts imports', () => {
    const ok = `import { TIER1_TOOL_NAMES } from '@recued/contracts';`;
    for (const forbidden of FORBIDDEN_PACKAGE_IMPORTS) {
      const escaped = forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`from\\s+['"]${escaped}(/[^'"]*)?['"]`);
      expect(re.test(ok)).toBe(false);
    }
  });
});
