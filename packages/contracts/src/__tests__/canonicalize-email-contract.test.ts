/** `canonicalizeEmail` returns '' on failure, and nothing may guard it with null.
 *
 *  ⛔⛔ WHY THIS IS A RATCHET AND NOT FIVE FIXED LINES. The function returns
 *  `string`, so `canonical !== null` type-checks, always evaluates true, and reads
 *  exactly like a real guard. Five call sites in the contact-import family had it
 *  — two in the CSV/vCard parser, one in the file matcher, two in the rpc handler
 *  — while the eight sites outside that family all used a falsy check. One author's
 *  wrong mental model of a return contract, reproduced across one feature.
 *
 *  Driven before the fix: `not-an-email` and `a@b@c.com` came out of
 *  `parseContactFile` as `email: ""` with `issues: []`, and at apply time the
 *  empty string reached `resolveCanonicalEmail` and surfaced as *"corrupt redirect
 *  chain"* — a true sentence about the wrong thing.
 *
 *  ⚠ A UNIT TEST OF THE FUNCTION CANNOT CATCH THIS. The function was always
 *  correct; the defect lived entirely in how callers read its contract. So the
 *  assertion has to be over the CALL SITES, which means scanning source.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalizeEmail } from '../contact.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const ROOTS = ['packages', 'backend', 'apps'];

const tsFiles = (dir: string, out: string[] = []): string[] => {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsFiles(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
};

describe('canonicalizeEmail — the empty-string contract', () => {
  it('returns the EMPTY STRING for every failure shape, never null/undefined', () => {
    for (const bad of ['', '   ', 'not-an-email', 'a@b@c.com', '@x.com', 'bob@', '<>']) {
      const out = canonicalizeEmail(bad);
      expect(out, JSON.stringify(bad)).toBe('');
      expect(out, JSON.stringify(bad)).not.toBeNull();
    }
  });

  it('⛔ is NOT an address parser — the display-name forms do not collapse', () => {
    // Pinned so the module header cannot drift back to claiming otherwise.
    // These are exactly the inputs the header used to say it collapsed.
    expect(canonicalizeEmail('<BOB@X.COM>')).toBe('bob@x.com');
    expect(canonicalizeEmail('Bob Smith <bob@x.com>')).toBe('bob smith <bob@x.com>');
    expect(canonicalizeEmail('bob@x.com (Bob)')).toBe('bob@x.com (bob)');
  });

  it('⚠ KNOWN, UNRESOLVED: no unicode normalization, so one person can split', () => {
    // NOT asserting this is right — asserting it is the CURRENT behaviour, so a
    // future normalization lands as a deliberate change with a migration rather
    // than as a surprise. Both pairs render identically to a human.
    expect(canonicalizeEmail('josé@x.com'))
      .not.toBe(canonicalizeEmail('josé@x.com'));
    expect(canonicalizeEmail('bob@münchen.de'))
      .not.toBe(canonicalizeEmail('bob@xn--mnchen-3ya.de'));
  });

  it('⛔ no CONTRACTS call site guards the result against null', () => {
    // ⛔⛔ RESOLVE THE IMPORT, NOT THE NAME. Four functions in this repo are
    // called `canonicalizeEmail`, and only THIS one returns ''. The CRM layer has
    // its own in `data/{hubspot,salesforce}/engagement-shared.ts` (plus one
    // defined inline in `hubspot/contact-reconciler.ts`) typed
    // `(raw) => string | null`, where `!== null` is exactly right.
    //
    // 🔑 A name-keyed scan cannot tell them apart, and I proved that the
    // expensive way: the first version of this test flagged six CRM sites, I
    // "fixed" them, and two HubSpot tests went red because the guards had been
    // correct. Same shape as the sibling lesson about one predicate under four
    // names — inverted. So this only considers files that import the symbol
    // FROM `@recued/contracts`, and skips any file defining its own.
    const offenders: string[] = [];
    let scanned = 0;
    const importsFromContracts = (src: string): boolean => {
      if (/^export const canonicalizeEmail/m.test(src)) return false;
      for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
        if (/\bcanonicalizeEmail\b/.test(m[1] ?? '')) return m[2] === '@recued/contracts';
      }
      return false;
    };
    for (const root of ROOTS) {
      for (const file of tsFiles(join(REPO, root))) {
        const src = readFileSync(file, 'utf8');
        if (!src.includes('canonicalizeEmail(')) continue;
        if (!importsFromContracts(src)) continue;
        scanned += 1;
        // ⚠ STRIP COMMENTS FIRST. The first draft flagged the fix's OWN comment,
        // which spells `!== null` while explaining why not to write it — a scanner
        // that reads prose as code reports the documentation as the defect.
        const lines = src.split('\n').map((line) => {
          const trimmed = line.trimStart();
          if (trimmed.startsWith('*') || trimmed.startsWith('/*')) return '';
          return line.split('//')[0] ?? '';
        });
        lines.forEach((line, i) => {
          if (!/canonicalizeEmail\(/.test(line)) return;
          // The guard is usually the assignment's own line or the next two.
          const window = lines.slice(i, i + 3).join('\n');
          if (/(?:===|!==)\s*null/.test(window)) {
            offenders.push(`${file.slice(REPO.length)}:${i + 1}`);
          }
        });
      }
    }
    // ⛔ THE FLOOR. A scanner that stopped matching would report a clean tree
    // while looking at nothing — the exact failure this whole file is about.
    // ⛔ THE FLOOR, and it must count only the resolved set — an import matcher
    // that stopped working would skip every file and report a clean tree.
    expect(scanned, 'the scan resolved no contracts-importing callers at all').toBeGreaterThan(3);
    expect(
      offenders,
      'canonicalizeEmail returns "" and never null, so a null comparison is '
        + 'vacuous: it type-checks, always passes, and reads like a real guard. '
        + 'Use a falsy check (`if (!email)`).',
    ).toEqual([]);
  });
});
