/** Long-horizon audit — Phase 1 inventory, from SOURCE.
 *
 *  ⛔ Two lists, deliberately kept separate:
 *
 *   - the STATIC list, parsed out of the source tree. A subsystem that
 *     fails to register at boot still appears here, which is the whole
 *     point: "registered but never started" is invisible to a process
 *     scrape, because the process has nothing to scrape.
 *   - the RUNTIME list, captured off the instrumented boot.
 *
 *  The difference between them is a finding, in both directions. */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface StaticIntervalSite {
  readonly file: string;
  readonly line: number;
  readonly name: string;
}

const SRC = new URL('../../src/', import.meta.url).pathname;

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
};

/** Scan for `registerInterval({ … name: '<x>' … })` registration sites.
 *
 *  ⚠ Deliberately matches the CALL, then reads forward for the `name:` field,
 *  rather than grepping for names — a name is a string that could appear
 *  anywhere, but a call site is the thing that would actually run. */
/** Resolve `name: SOME_CONSTANT` against a `const SOME_CONSTANT = '…'` in the
 *  same file.
 *
 *  ⚠ Instrument correction #1 (2026-08-04). Without this the scanner emitted
 *  `(unresolved)` for `hostname-reconciliation-daily`, which then failed the
 *  static-vs-runtime name comparison and printed "DECLARED IN SOURCE BUT NOT
 *  REGISTERED AT BOOT" for a subsystem that registers perfectly well. The
 *  first finding this harness produced was its own. */
const resolveNameExpr = (expr: string, text: string): string | undefined => {
  const literal = /^'([^']+)'$/.exec(expr);
  if (literal) return literal[1];
  if (!/^[A-Za-z_$][\w$]*$/.test(expr)) return undefined;
  const decl = new RegExp(
    `(?:const|let|var)\\s+${expr}\\s*(?::[^=]+)?=\\s*'([^']+)'`,
  ).exec(text);
  return decl?.[1];
};

export const staticIntervalSites = (): StaticIntervalSite[] => {
  const sites: StaticIntervalSite[] = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('registerInterval')) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/\.registerInterval\(\{/.test(lines[i])) continue;
      let name = '(unresolved)';
      for (let j = i; j < Math.min(i + 12, lines.length); j++) {
        const m = /name:\s*([^,]+),/.exec(lines[j]);
        if (!m) continue;
        name = resolveNameExpr(m[1].trim(), text) ?? `(unresolved:${m[1].trim()})`;
        break;
      }
      sites.push({ file: file.slice(SRC.length), line: i + 1, name });
    }
  }
  return sites.sort((a, b) => a.name.localeCompare(b.name));
};

export interface StaticServiceSite {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly kind: string;
}

export const staticServiceSites = (): StaticServiceSite[] => {
  const sites: StaticServiceSite[] = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    if (!/\.register\(\{/.test(text)) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/\.register\(\{/.test(lines[i])) continue;
      let name = '(unresolved)';
      let kind = '(unresolved)';
      for (let j = i; j < Math.min(i + 14, lines.length); j++) {
        const n = /name:\s*'([^']+)'/.exec(lines[j]);
        if (n && name === '(unresolved)') name = n[1];
        const k = /kind:\s*'([^']+)'/.exec(lines[j]);
        if (k && kind === '(unresolved)') kind = k[1];
      }
      sites.push({ file: file.slice(SRC.length), line: i + 1, name, kind });
    }
  }
  return sites.sort((a, b) => a.name.localeCompare(b.name));
};
