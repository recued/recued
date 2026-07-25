/** D-145 PB2 — content_stored discipline lint ratchet (§ B.5.2).
 *
 *  The compile-time `ContentStoredFalse` literal type catches direct
 *  attempts to set `OmittedItem.content_stored: true`. This ratchet
 *  catches the runtime workarounds: parsed-JSON paths,
 *  `Object.assign(omittedItem, { content_stored: true })`,
 *  `as { content_stored: true }` casts, and other shapes that smuggle
 *  `content_stored: true` past the type system at runtime.
 *
 *  Scans every TS / JS source file under `packages/`, `apps/`,
 *  `backend/` (excluding node_modules + test fixtures that
 *  deliberately exercise the rejection path). Fails on any match
 *  outside the allowlist.
 *
 *  Allowlist:
 *    - `packages/contracts/src/recued-plan.ts` — substrate file
 *      defining the literal type itself.
 *    - `packages/contracts/src/__tests__/d-145-phase-pb2-*.test.ts` —
 *      ratchet + validator tests asserting the rejection path. */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Repo root (`recued-dev/`). */
const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** Substrate-internal allowlist. Files where `content_stored: true`
 *  may legitimately appear (defining the literal type, asserting the
 *  rejection path in tests). Paths are relative to REPO_ROOT. */
const ALLOWLIST: ReadonlyArray<string> = [
  // Substrate file defining the type / validator. References
  // `content_stored: true` only in comments + diagnostic strings —
  // never as a real assignment.
  'packages/contracts/src/recued-plan.ts',
  // Ratchet test (this file). Quotes the forbidden pattern only as
  // string literals in the regex + allowlist for self-reference.
  'packages/contracts/src/__tests__/d-145-phase-pb2-lint.ratchet.test.ts',
  // Validator tests deliberately exercise the rejection path with
  // `as unknown as` casts.
  'packages/contracts/src/__tests__/d-145-phase-pb2-contracts.test.ts',
  // Storage tests assert that `RecuedPlanStore.append` rejects plans
  // carrying a forbidden `content_stored: true` payload (defense in
  // depth — runtime validator gate at write).
  'packages/storage/src/__tests__/recued-plan.test.ts',
];

/** Directories the scanner walks. Other top-level dirs (community/,
 *  docs/, scripts/) are out of scope for runtime invariants. */
const SCAN_ROOTS: ReadonlyArray<string> = [
  'packages',
  'apps',
  'backend',
];

/** Directories to skip during recursion. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.cache',
]);

/** File extensions the ratchet examines. */
const SCAN_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

const walk = (dir: string, out: string[]): void => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      walk(full, out);
    } else if (SCAN_EXTENSIONS.has(path.extname(entry))) {
      out.push(full);
    }
  }
};

/** Collect every scannable source file under SCAN_ROOTS. */
const collectFiles = (): string[] => {
  const out: string[] = [];
  for (const root of SCAN_ROOTS) {
    walk(path.join(REPO_ROOT, root), out);
  }
  return out;
};

const isAllowlisted = (relPath: string): boolean => {
  for (const allowed of ALLOWLIST) {
    if (relPath === allowed) return true;
  }
  return false;
};

/** Patterns that smuggle `content_stored: true` past the type system.
 *  Each pattern matches a runtime assignment shape; documentation /
 *  diagnostic strings inside the substrate file pass through the
 *  allowlist. */
const FORBIDDEN_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // Direct object-literal assignment in non-fixture code:
  //   { content_stored: true }
  //   { content_stored : true }
  // Note: matches both bare and quoted-key forms.
  {
    name: 'object_literal_content_stored_true',
    re: /["']?content_stored["']?\s*:\s*true\b/,
  },
  // Object.assign workaround:
  //   Object.assign(item, { content_stored: true })
  {
    name: 'object_assign_content_stored_true',
    re: /Object\.assign\([^)]*content_stored\s*:\s*true/,
  },
  // Reflect.set / direct property write:
  //   item.content_stored = true
  //   item['content_stored'] = true
  {
    name: 'property_assignment_content_stored_true',
    re: /\.content_stored\s*=\s*true\b/,
  },
  {
    name: 'bracket_property_assignment_content_stored_true',
    re: /\[\s*['"]content_stored['"]\s*\]\s*=\s*true\b/,
  },
];

interface Violation {
  file: string;
  line: number;
  pattern: string;
  snippet: string;
}

const scanForViolations = (): Violation[] => {
  const violations: Violation[] = [];
  for (const filePath of collectFiles()) {
    const relPath = path.relative(REPO_ROOT, filePath);
    if (isAllowlisted(relPath)) continue;
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const { name, re } of FORBIDDEN_PATTERNS) {
        if (re.test(line)) {
          violations.push({
            file: relPath,
            line: i + 1,
            pattern: name,
            snippet: line.trim().slice(0, 200),
          });
        }
      }
    }
  }
  return violations;
};

describe('D-145 PB2 — content_stored discipline lint ratchet (§ B.5.2)', () => {
  it('no source file outside the allowlist contains content_stored: true workarounds', () => {
    const violations = scanForViolations();
    if (violations.length > 0) {
      const formatted = violations
        .map(
          (v) =>
            `  ${v.file}:${v.line} [${v.pattern}] — ${v.snippet}`,
        )
        .join('\n');
      throw new Error(
        `D-145 PB2 lint ratchet found ${violations.length} violation(s):\n${formatted}\n\n` +
          `OmittedItem.content_stored is a TypeScript literal-false invariant per § B.5.2. ` +
          `Runtime workarounds (Object.assign / property assignment / object literals) bypass ` +
          `the compile-time gate and reach the audit log with content payloads attached. ` +
          `If a fixture deliberately exercises the rejection path, add the test file to ALLOWLIST in ` +
          `packages/contracts/src/__tests__/d-145-phase-pb2-lint.ratchet.test.ts.`,
      );
    }
    expect(violations).toEqual([]);
  });

  it('allowlist entries are each ≤ 1 file (no glob wildcards)', () => {
    // Glob wildcards would silently widen the rule; keep it explicit
    // so audits can grep for added entries.
    for (const entry of ALLOWLIST) {
      expect(entry.includes('*')).toBe(false);
    }
  });
});
