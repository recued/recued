/** ⛔⛔ TWENTY-SEVEN COPIES OF ONE PROTOTYPE-POLLUTION DENYLIST, AND THEY ALL
 *  HAVE TO AGREE.
 *
 *  `const PROTOTYPE_SENSITIVE_* = new Set([...])` is declared privately in 27
 *  places — webhook parsers, the MCP server, the vault, the resolver, the
 *  transform layer, the ingredient dispatchers — under TWO names
 *  (`..._KEYS` and `..._FIELDS`) that mean the same thing. Every one of them is
 *  the guard that stops an attacker-supplied key reaching `__proto__`.
 *
 *  🔑 THEY AGREE TODAY. That is precisely why this is a test and not a fix: a
 *  denylist that is missing a member in ONE parser is a hole that no suite can
 *  see, because each copy is self-consistent and every test written against it
 *  passes. The failure only appears as a live prototype-pollution path in the
 *  one surface that drifted.
 *
 *  ⚠ THE SHARED-HELPER FIX IS NOT TAKEN HERE, DELIBERATELY. Consolidating means
 *  editing 27 security-relevant files at once, and there is no divergence to
 *  repair — the risk of the change today exceeds the risk it removes. This
 *  converts an invisible drift into a loud one at zero blast radius; the
 *  consolidation stays available and now cannot happen by halves unnoticed.
 *
 *  ⚠ AND THE TWO NAMES ARE THE HAZARD WORTH SEEING. `..._FIELDS` and `..._KEYS`
 *  sit in sibling webhook parsers guarding the same thing, so a reader fixing
 *  one will not grep the other's name. The scan keys on the PREFIX for that
 *  reason.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOTS = ['backend/server/src', 'packages', 'apps'];
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

const DECL = /const (PROTOTYPE_SENSITIVE_\w+) = new Set\(\[(.*?)\]\)/gs;

interface Site {
  readonly file: string;
  readonly name: string;
  readonly members: readonly string[];
}

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
    // ⚠ PRODUCTION ONLY. Test files declare denylists as FIXTURES — including
    //   the deliberately-short one in the mutation check below, which this
    //   scan duly found and reported on its first run. A fixture is not a
    //   guard, and counting it would make the ratchet fail on itself.
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
};

const collect = (): Site[] => {
  const sites: Site[] = [];
  for (const root of ROOTS) {
    for (const file of walk(join(REPO, root), [])) {
      const src = readFileSync(file, 'utf8');
      if (!src.includes('PROTOTYPE_SENSITIVE_')) continue;
      for (const m of src.matchAll(DECL)) {
        const members = [...(m[2] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]!);
        sites.push({ file: file.slice(REPO.length), name: m[1]!, members: members.sort() });
      }
    }
  }
  return sites;
};

describe('the prototype-sensitive denylist is one set, however many times it is written', () => {
  const sites = collect();

  /** ⛔ THE SCAN'S OWN FLOOR. A scanner that found nothing would pass every
   *  assertion below — the "a correct-looking absence is usually a failure"
   *  shape. The tree had 27 when this was written; a number far under that
   *  means the scan broke, not that the copies went away. */
  it('the scan finds the copies at all', () => {
    expect(sites.length).toBeGreaterThanOrEqual(20);
  });

  it('every copy denies exactly the same keys', () => {
    const distinct = new Map<string, string[]>();
    for (const s of sites) {
      const key = s.members.join(',');
      if (!distinct.has(key)) distinct.set(key, []);
      distinct.get(key)!.push(`${s.file} ${s.name}`);
    }
    // The failure message has to name the ODD ONE OUT, not just say "2 sets" —
    // with 27 sites, a bare count is a search, and a search is what a reader
    // does instead of reading the message.
    const summary = [...distinct.entries()]
      .map(([members, where]) => `[${members}] × ${where.length}: ${where.slice(0, 3).join(' | ')}`)
      .join('\n');
    expect(distinct.size, `more than one denylist membership:\n${summary}`).toBe(1);
  });

  it('and that set is the three prototype-reachable keys', () => {
    // Pinned by value, not just by agreement: 27 copies that agree on the WRONG
    // set would pass the test above and fail every user of it.
    for (const s of sites) {
      expect(s.members, `${s.file} ${s.name}`).toEqual(['__proto__', 'constructor', 'prototype']);
    }
  });

  it('MUTATION: the scan can see a denylist that differs', () => {
    // ⚠ Without this, the agreement above passes just as happily against a
    //   regex that matches nothing, or one that drops members while parsing.
    const planted = "const PROTOTYPE_SENSITIVE_KEYS = new Set(['__proto__', 'constructor']);";
    const found = [...planted.matchAll(DECL)];
    expect(found).toHaveLength(1);
    const members = [...(found[0]![2] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]!);
    expect(members).toEqual(['__proto__', 'constructor']);
    expect(members).not.toEqual(['__proto__', 'constructor', 'prototype']);
  });
});
