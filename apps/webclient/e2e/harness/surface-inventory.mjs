#!/usr/bin/env node
/**
 * Source-level inventory of the webclient's interactive surface.
 *
 *   node apps/webclient/e2e/harness/surface-inventory.mjs
 *   node apps/webclient/e2e/harness/surface-inventory.mjs --sweep round1.json
 *
 * ## Why this reads SOURCE and not a rendered page
 *
 * Enumerating controls from a rendered page can only ever find what already
 * renders — which is the same blind spot as the defect being hunted. A panel
 * that fails to mount contributes zero controls to a page scrape and therefore
 * looks like a surface with nothing on it. Read from source and it is a
 * DENOMINATOR instead: the sweep's coverage becomes a fraction, and a surface
 * that never rendered shows up as a gap rather than as silence.
 *
 * With `--sweep <report.json>` it joins the sweep's `attrsSeen` against this
 * inventory and prints what was never reached — the "surfaces I could not
 * audit" list, which is a first-class output. "Not audited" must never be
 * silently indistinguishable from "audited, clean".
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');

/** Source roots that render the app. Tests are excluded — a `data-recued-*`
 *  that exists only in a test file is not a shipped control. */
const ROOTS = ['apps/webclient/src', 'packages/ui-shared/src'];

const listFiles = () => execFileSync(
  'git',
  ['ls-files', ...ROOTS.map((r) => `${r}/**/*.ts`)],
  { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
)
  .split('\n')
  .filter((f) => f.length > 0)
  .filter((f) => !f.includes('__tests__') && !f.endsWith('.test.ts'));

const ATTR = /data-recued-[a-z0-9-]+/g;

/** Which area a file belongs to — the first path segment under src/. */
const areaOf = (file) => {
  const m = file.match(/apps\/webclient\/src\/([^/]+)\//);
  if (m) return m[1];
  if (file.includes('packages/ui-shared')) return 'ui-shared';
  if (file.endsWith('webclient-bootstrap.ts')) return 'shell(bootstrap)';
  return 'root';
};

const files = listFiles();
const byAttr = new Map();
const byArea = new Map();

for (const file of files) {
  let text;
  try { text = readFileSync(resolve(REPO, file), 'utf8'); } catch { continue; }
  const found = new Set(text.match(ATTR) ?? []);
  if (found.size === 0) continue;
  const area = areaOf(file);
  if (!byArea.has(area)) byArea.set(area, new Set());
  for (const attr of found) {
    byArea.get(area).add(attr);
    if (!byAttr.has(attr)) byAttr.set(attr, new Set());
    byAttr.get(attr).add(file);
  }
}

const args = process.argv.slice(2);
const sweepIdx = args.indexOf('--sweep');
const sweepPath = sweepIdx >= 0 ? args[sweepIdx + 1] : null;

console.log(`── source inventory: ${byAttr.size} distinct data-recued-* attributes `
  + `across ${files.length} non-test source files\n`);

const areas = [...byArea.entries()].sort((a, b) => b[1].size - a[1].size);
console.log('  area                     attrs');
for (const [area, attrs] of areas) {
  console.log(`  ${area.padEnd(24)} ${String(attrs.size).padStart(5)}`);
}

if (!sweepPath) {
  console.log('\n  (pass --sweep <report.json> to join against a sweep run)');
  process.exit(0);
}

const report = JSON.parse(readFileSync(resolve(process.cwd(), sweepPath), 'utf8'));
const seen = new Set();
for (const s of report.surfaces) for (const a of s.attrsSeen ?? []) seen.add(a);

// An attribute the sweep never saw is either on an unreachable surface or on a
// state the BFS did not open. Either way it is UNAUDITED, and saying so is the
// point of this join.
const unseenByArea = new Map();
for (const [attr, filesFor] of byAttr) {
  if (seen.has(attr)) continue;
  const area = areaOf([...filesFor][0]);
  if (!unseenByArea.has(area)) unseenByArea.set(area, []);
  unseenByArea.get(area).push(attr);
}

const totalUnseen = [...unseenByArea.values()].reduce((n, a) => n + a.length, 0);
const reached = byAttr.size - totalUnseen;
console.log(`\n── sweep coverage: ${reached}/${byAttr.size} attributes reached `
  + `(${((reached / byAttr.size) * 100).toFixed(1)}%) · ${totalUnseen} never rendered in any swept state\n`);
console.log('  area                     reached  unreached');
for (const [area, attrs] of areas) {
  const un = (unseenByArea.get(area) ?? []).length;
  console.log(`  ${area.padEnd(24)} ${String(attrs.size - un).padStart(7)}  ${String(un).padStart(9)}`);
}
