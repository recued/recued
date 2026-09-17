/** ⛔⛔ EVERY `escapeHtml` IN THE TREE ESCAPES THE SAME FIVE CHARACTERS.
 *
 *  There are twenty implementations — server status pages, the reception
 *  handlers, the notification renderer, `@recued/ui-shared`, half a dozen
 *  webclient panels, the marketplace SSR routes. Nineteen escaped
 *  `& < > " '`. One — `apps/webclient/src/reception/records-panel.ts` —
 *  escaped four of the five, missing `'` → `&#39;`.
 *
 *  🔑 IT WAS NOT EXPLOITABLE, AND THAT IS THE POINT. Every call site in that
 *  file lands in text content or a DOUBLE-quoted attribute, where a bare `'` is
 *  inert. The guard was one single-quoted attribute away from being wrong, in a
 *  panel that renders ANONYMOUS VISITOR submissions — and a reader has
 *  nineteen other functions of the same name telling them `'` is covered.
 *
 *  ⛔ THE CRITERION IS "AT LEAST", NOT "EXACTLY". An implementation that escapes
 *  MORE (a stricter table, numeric entities for everything) is fine; one that
 *  escapes fewer is the bug. Pinning equality would reject a hardening.
 *
 *  ⚠ Found by `npm run check:near-duplicates`: `escapeHtml` appeared six times
 *  in the near-duplicate band, which is what prompted comparing the character
 *  sets rather than the bodies.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOTS = ['backend/server/src', 'packages', 'apps'];
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

/** The five characters that can break out of HTML text or an attribute value. */
const REQUIRED: ReadonlyArray<[string, RegExp]> = [
  ['&', /&amp;/],
  ['<', /&lt;/],
  ['>', /&gt;/],
  ['"', /&quot;/],
  ["'", /&#0?39;|&apos;|&#x27;/i],
];

/** A declaration that IS an HTML escaper: the function, or the table/regex pair
 *  the `.replace(RE, (c) => TABLE[c])` form uses. */
const DECL = /(?:const|function)\s+(escapeHtml|HTML_ESCAPE_TABLE)\b([\s\S]{0,400})/g;

const walk = (dir: string, out: string[]): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'build') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    // Production only — a test may legitimately assert a partial escaper.
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
};

interface Impl { readonly at: string; readonly missing: readonly string[] }

const collect = (): Impl[] => {
  const impls: Impl[] = [];
  for (const root of ROOTS) {
    for (const file of walk(join(REPO, root), [])) {
      const src = readFileSync(file, 'utf8');
      if (!src.includes('escapeHtml') && !src.includes('HTML_ESCAPE_TABLE')) continue;
      for (const m of src.matchAll(DECL)) {
        const body = m[2] ?? '';
        // A re-export or a bare import of the canonical one is not an
        // implementation and has nothing to escape.
        if (/^\s*[}:,]/.test(body) || body.trimStart().startsWith('from')) continue;
        const missing = REQUIRED.filter(([, re]) => !re.test(body)).map(([c]) => c);
        // All five absent ⇒ this matched a type, a re-export, or a call site.
        if (missing.length === REQUIRED.length) continue;
        impls.push({
          at: `${file.slice(REPO.length)}:${src.slice(0, m.index).split('\n').length} ${m[1]!}`,
          missing,
        });
      }
    }
  }
  return impls;
};

describe('every HTML escaper covers the same five characters', () => {
  const impls = collect();

  /** ⛔ THE SCAN'S OWN FLOOR — a scanner that found nothing would pass the
   *  assertion below without looking at anything.
   *
   *  ⚠⚠ THE FLOOR MUST HOLD IN BOTH TREES THIS FILE SHIPS TO. `ROOTS` includes
   *  `apps`, and the public source distribution carries only `apps/webclient` of
   *  it: measured 2026-09-17, this scan finds 16 implementations here and 13
   *  there. The floor was 15 — one below the private count and two ABOVE the
   *  public one — so it red the exported suite at release step 5 while being
   *  green on every private run. A floor calibrated against the tree you happen
   *  to be standing in is not a floor.
   *
   *  ⇒ 12 still catches the thing this guards (a scan that collapses to nothing)
   *  and cannot be tripped by the smaller tree. Raise it only against the SMALLER
   *  count. */
  it('the scan finds the implementations at all', () => {
    expect(impls.length).toBeGreaterThanOrEqual(12);
  });

  it('none of them escapes fewer than & < > " and apostrophe', () => {
    const short = impls.filter((i) => i.missing.length > 0);
    const detail = short.map((i) => `${i.at} — missing ${i.missing.join(' ')}`).join('\n');
    expect(
      short,
      `an HTML escaper that covers less than the others:\n${detail}\n`
        + 'Use `escapeHtml` from `@recued/ui-shared` rather than a narrower local copy.',
    ).toEqual([]);
  });

  it('MUTATION: the scan can see an escaper that misses the apostrophe', () => {
    // ⚠ Without this the assertion above passes just as happily against a regex
    //   that matches nothing — which is how the four-character copy survived.
    const planted = "const escapeHtml = (v: string) => v"
      + ".replace(/&/g, '&amp;').replace(/</g, '&lt;')"
      + ".replace(/>/g, '&gt;').replace(/\"/g, '&quot;');";
    const m = [...planted.matchAll(DECL)];
    expect(m).toHaveLength(1);
    const missing = REQUIRED.filter(([, re]) => !re.test(m[0]![2] ?? '')).map(([c]) => c);
    expect(missing).toEqual(["'"]);
  });
});
