/** D-121 Phase 3 — guard test: `packages/ui-shared/` must remain
 *  free of `chrome.*` references.
 *
 *  Originally introduced so the webapp surface could mount the same
 *  components as the extension without modification. Post-D-148 P11
 *  the only client surface is `apps/webclient/`, but the gate stays
 *  load-bearing — webclient is a plain PWA with no `chrome.*` API
 *  available, so any reach into `globalThis.chrome` would fail at
 *  runtime. */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGE_SRC = join(__dirname, '..');

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js']);

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (SOURCE_EXTS.has(full.slice(full.lastIndexOf('.')))) {
      out.push(full);
    }
  }
  return out;
};

const isCommentLine = (line: string): boolean => {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*')
  );
};

describe('packages/ui-shared/ has no chrome.* references', () => {
  it('matches no `chrome.<api>` outside test files + comments', () => {
    const files = walk(PACKAGE_SRC).filter(
      (f) => !f.includes('__tests__') && !f.endsWith('.test.ts'),
    );
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        if (isCommentLine(line)) return;
        // Match `chrome.<word>` but ignore the substring inside doc
        // comments (handled above) and string literals like a fallback
        // URL `chrome-extension://`. The bare `chrome.` token is the
        // signal we care about.
        if (/\bchrome\.[a-zA-Z]/.test(line)) {
          violations.push(
            `${relative(PACKAGE_SRC, file)}:${idx + 1} → ${line.trim()}`,
          );
        }
      });
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
