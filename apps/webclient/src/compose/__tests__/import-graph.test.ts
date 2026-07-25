/** D-151 I-3 — Compose webclient import boundary.
 *
 *  P0/P5's Compose surface may call contracts-owned RPCs and compile helpers,
 *  but it must not import engine or provider SDK code into the webclient. (The
 *  `home` cockpit it once guarded alongside was retired in shell-frame Step 5.)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEBCLIENT_SRC_ROOT = join(__dirname, '..', '..');
const GUARDED_SRC_ROOTS = [
  join(WEBCLIENT_SRC_ROOT, 'compose'),
] as const;

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
};

const FORBIDDEN_IMPORTS = [
  '@recued/engine',
  '@anthropic-ai/sdk',
  'openai',
  '@google/generative-ai',
] as const;

const FORBIDDEN_SOURCE_MARKERS = [
  'chart.googleapis.com',
  'api.qrserver.com',
  'quickchart.io',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'document.cookie',
] as const;

const guardedFiles = (): string[] =>
  GUARDED_SRC_ROOTS.flatMap((root) => walk(root));

describe('D-151 I-3 — Compose import graph', () => {
  it('Compose source files do not import engine or browser-side LLM SDKs', () => {
    const findings: Array<{ file: string; forbidden: string }> = [];
    for (const file of guardedFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const forbidden of FORBIDDEN_IMPORTS) {
        const quoted = forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const importRe = new RegExp(
          `(?:from\\s+['"]${quoted}(?:/[^'"]*)?['"]|import\\s*\\(\\s*['"]${quoted}(?:/[^'"]*)?['"]\\s*\\)|import\\s+['"]${quoted}(?:/[^'"]*)?['"])`,
        );
        if (importRe.test(source)) {
          findings.push({
            file: relative(WEBCLIENT_SRC_ROOT, file),
            forbidden,
          });
        }
      }
    }
    expect(findings).toEqual([]);
  });

  it('Compose source files do not use external QR services or browser storage', () => {
    const findings: Array<{ file: string; marker: string }> = [];
    for (const file of guardedFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const marker of FORBIDDEN_SOURCE_MARKERS) {
        if (source.includes(marker)) {
          findings.push({
            file: relative(WEBCLIENT_SRC_ROOT, file),
            marker,
          });
        }
      }
    }
    expect(findings).toEqual([]);
  });
});
