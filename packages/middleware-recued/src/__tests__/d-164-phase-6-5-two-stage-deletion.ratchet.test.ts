/** D-164 P6.5 — two-stage substrate deletion ratchets.
 *
 *  Pins:
 *    - Every one of the 12 source files in
 *      `packages/middleware-recued/src/two-stage/` stays deleted, and
 *      the directory itself stays absent.
 *    - Every one of the 13 retired two-stage test files in
 *      `packages/middleware-recued/src/__tests__/` stays deleted.
 *    - `packages/middleware-recued/src/index.ts` has no `from
 *      './two-stage'` import, no `export * as twoStage` namespace, no
 *      `twoStageMiddleware` symbol, and `FIRST_PARTY_MIDDLEWARES` is
 *      the readonly four-adapter tuple with no `'two-stage'` id.
 *    - Across `backend/`, `packages/`, `apps/`, no source file imports
 *      from any `/two-stage/` path, references the `twoStageMiddleware`
 *      identifier, or references any `TWO_STAGE_*_STATE_KEY` constant.
 *      Each load-bearing allow-list entry declares an exact expected
 *      hit-count per pattern — the ratchet fails if a hit count drifts
 *      either up (regression — new reference) or down (vestigial entry
 *      — fold to drop the exemption).
 *
 *  Out of scope for this ratchet (Codex test-review MAJOR #1 fold):
 *    - Renamed two-stage equivalents (`two-stage-v2/`, `legacyTwoStage*`,
 *      `../two-stage-archive/`). This file ratchets the *exact* P6.5
 *      deletion set; the final grep-negative acceptance sweep that
 *      catches semantic resurrection under new names belongs to P6.8
 *      (see D-164
 *      § P6 table line 522 — Open Q1 resolved + grep-negative slice).
 *
 *  Grep technique caveats (Codex test-review MINOR #4 fold):
 *    - `PATH_IMPORT_RE` matches static `from '...'` imports + dynamic
 *      `import('...')` expressions. `require('.../two-stage/...')` and
 *      side-effect-only imports (`import '../two-stage/setup.js'`) are
 *      NOT covered — none survive in the post-P6.4 tree, and P6.8's
 *      AST-level full sweep is the catch-all.
 *    - The identifier patterns are word-bounded `\b` greps; a comment
 *      that names them is sufficient to flag. The allow-list expected-
 *      count assertions are how the (few) intentional comment mentions
 *      stay quarantined.
 *
 *  Spec: D-164
 *  line 519 (P6.5 row). Prior slice: D-164 P6.4 chat-stage adapter
 *  delete (commit `2a4c24e1`).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  FIRST_PARTY_MIDDLEWARES,
  registerFirstPartyMiddlewares,
} from '../index.js';
import {
  createMiddlewareRegistry,
  type Middleware,
} from '@recued/middleware';
import { isTypeScriptSource } from '../../../../test/source-file-extensions.js';

// ── Absolute path resolution ─────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

const TWO_STAGE_DIR = path.resolve(HERE, '..', 'two-stage');
const BUNDLE_INDEX = path.resolve(HERE, '..', 'index.ts');

const twoStageSource = (fileName: string): string =>
  path.resolve(TWO_STAGE_DIR, fileName);

const twoStageTest = (fileName: string): string =>
  path.resolve(HERE, fileName);

// The 12 source files retired by P6.5 (one ratchet per file). Listed by
// hand so a mutation that resurrects ANY single file flips ONE specific
// assertion — and so the closed list is reviewable here in source.
const RETIRED_TWO_STAGE_SOURCES = [
  'chat-decoder.ts',
  'commitment-context.ts',
  'compose-stage1.ts',
  'compose-stage2.ts',
  'filter-recipes.ts',
  'filter-tools.ts',
  'index.ts',
  'local-classifier.ts',
  'middleware.ts',
  'orchestrator.ts',
  'per-intent-capacity.ts',
  'validate-stage1.ts',
] as const;

// The 13 retired two-stage test files (PB17 + D-137 trio + D-164 P6
// pre-cursors). Listed by hand for the same reason.
const RETIRED_TWO_STAGE_TESTS = [
  'd-137-phase-1-3-filter-tools.test.ts',
  'd-137-phase-1-4-chat-decoder.test.ts',
  'd-137-wave-2-4-stage1-routing.test.ts',
  'd-137-wave-2-5-stage2-routing.test.ts',
  'd-145-phase-pb17-commitment-context.test.ts',
  'd-145-phase-pb17-compose-stage2.test.ts',
  'd-145-phase-pb17-filter-recipes.test.ts',
  'd-145-phase-pb17-local-classifier.test.ts',
  'd-145-phase-pb17-orchestrator-scenarios.test.ts',
  'd-145-phase-pb17-per-intent-capacity.test.ts',
  'd-145-phase-pb17-validate-stage1.test.ts',
  'd-164-p6bc-two-stage-cognition.ratchet.test.ts',
  'd-164-p6f-two-stage-emit.test.ts',
] as const;

// ── Repo-wide source scan ───────────────────────────────────────────

const REPO_SCAN_ROOTS = ['backend', 'packages', 'apps'] as const;
const REPO_SCAN_SKIP_DIR = new Set([
  'node_modules',
  'dist',
  '.git',
  '.tsbuild',
]);
const REPO_SCAN_SKIP_FILE_SUFFIX = ['.d.ts', '.d.ts.map', '.js.map'];

const isScannableFile = (filePath: string): boolean => {
  if (!isTypeScriptSource(filePath)) {
    return false;
  }
  for (const suffix of REPO_SCAN_SKIP_FILE_SUFFIX) {
    if (filePath.endsWith(suffix)) {
      return false;
    }
  }
  return true;
};

const walk = (dirAbs: string, out: string[]): void => {
  let entries: ReadonlyArray<string>;
  try {
    entries = readdirSync(dirAbs);
  } catch {
    return;
  }
  for (const name of entries) {
    if (REPO_SCAN_SKIP_DIR.has(name)) {
      continue;
    }
    const abs = path.join(dirAbs, name);
    let info;
    try {
      info = statSync(abs);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      walk(abs, out);
    } else if (info.isFile() && isScannableFile(abs)) {
      out.push(abs);
    }
  }
};

const collectRepoSources = (): ReadonlyArray<string> => {
  const out: string[] = [];
  for (const root of REPO_SCAN_ROOTS) {
    walk(path.join(REPO_ROOT, root), out);
  }
  return out;
};

const relFromRepo = (abs: string): string => path.relative(REPO_ROOT, abs);

// ── Pattern catalog ─────────────────────────────────────────────────

// `g` flag so `.match()` returns every hit, not just the first; the
// expected-count assertion needs full hit counts.
//
// PATH_IMPORT_RE matches `from '...'` static imports + `import('...')`
// dynamic imports targeting any `/two-stage/` path (relative or via
// `@recued/middleware-recued/two-stage`).
const PATH_IMPORT_RE =
  /(?:\bfrom\s+['"][^'"]*\/two-stage\/[^'"]*['"]|\bimport\s*\(\s*['"][^'"]*\/two-stage\/[^'"]*['"])/g;
const TWO_STAGE_MW_RE = /\btwoStageMiddleware\b/g;
const TWO_STAGE_STATE_KEY_RE = /\bTWO_STAGE_[A-Z_]+_STATE_KEY\b/g;

const countMatches = (src: string, re: RegExp): number => {
  const matches = src.match(re);
  return matches === null ? 0 : matches.length;
};

interface ExpectedCounts {
  readonly pathImports: number;
  readonly twoStageMiddleware: number;
  readonly twoStageStateKey: number;
}

// Per-allow-listed-file expected hit-count for each enforced pattern.
// Codex test-review MAJOR #2 + MINOR #3 fold: replaces whole-file skip
// (which silently granted amnesty for future drift) with exact-count
// assertions. A vestigial entry self-destructs (actual < expected →
// fails); a new offender in an allow-listed file still fails (actual >
// expected). Counts were captured against the post-P6.5 tree.
//
// Files dropped from the prior whole-file allow-list because all three
// pattern counts are zero post-P6.5/P6.6/P6.7/P6.8: prompt-cache/d-164-
// p4b-register (was scrubbed in P6.5), chat-orchestrator.ts (prose
// swept in P6.8), d-164-p6f-cognition-emit-grep (the two-stage entry
// was dropped in P6.5), contracts/{chat,token-usage-report,recued-plan}
// (swept in P6.6), backend tests d-137-wave-2-{2,3} (swept in P6.8),
// wire-chat-orchestrator.ts (final narrative reference swept in P6.8).
const ALLOW_LIST_EXPECTED: ReadonlyMap<string, ExpectedCounts> = new Map([
  // This ratchet file itself — names the symbols in regex sources, in
  // mutation-comment text, and in the allow-list keys above.
  [
    'packages/middleware-recued/src/__tests__/d-164-phase-6-5-two-stage-deletion.ratchet.test.ts',
    { pathImports: 2, twoStageMiddleware: 20, twoStageStateKey: 0 },
  ],
  // d-160-phase-2-registry-integration.test.ts holds the bundle-index
  // source-grep ratchets — it names `twoStageMiddleware` once inside
  // the `\btwoStageMiddleware\b` regex source.
  [
    'packages/middleware-recued/src/__tests__/d-160-phase-2-registry-integration.test.ts',
    { pathImports: 0, twoStageMiddleware: 1, twoStageStateKey: 0 },
  ],
  // d-160-phase-2-adapters.test.ts — single mention in the comment
  // documenting the retirement of the `D-160 P2 twoStageMiddleware`
  // describe block.
  [
    'packages/middleware-recued/src/__tests__/d-160-phase-2-adapters.test.ts',
    { pathImports: 0, twoStageMiddleware: 1, twoStageStateKey: 0 },
  ],
]);

const zeroCounts: ExpectedCounts = {
  pathImports: 0,
  twoStageMiddleware: 0,
  twoStageStateKey: 0,
};

const expectedFor = (rel: string): ExpectedCounts =>
  ALLOW_LIST_EXPECTED.get(rel) ?? zeroCounts;

interface FileScan {
  readonly rel: string;
  readonly counts: ExpectedCounts;
}

// One-shot scan shared across the cross-repo describe blocks. Codex
// test-review NIT #6 fold (hoist).
let cachedScans: ReadonlyArray<FileScan> | null = null;

const scanAllFiles = (): ReadonlyArray<FileScan> => {
  if (cachedScans !== null) {
    return cachedScans;
  }
  const out: FileScan[] = [];
  for (const abs of collectRepoSources()) {
    const rel = relFromRepo(abs);
    const src = readFileSync(abs, 'utf8');
    out.push({
      rel,
      counts: {
        pathImports: countMatches(src, PATH_IMPORT_RE),
        twoStageMiddleware: countMatches(src, TWO_STAGE_MW_RE),
        twoStageStateKey: countMatches(src, TWO_STAGE_STATE_KEY_RE),
      },
    });
  }
  cachedScans = out;
  return out;
};

// ── File-existence ratchets ──────────────────────────────────────────

describe('D-164 P6.5 — two-stage directory + source files stay deleted', () => {
  it('the two-stage directory itself stays absent', () => {
    // mutate: recreate packages/middleware-recued/src/two-stage/ →
    // this assertion fails.
    expect(existsSync(TWO_STAGE_DIR)).toBe(false);
  });

  for (const fileName of RETIRED_TWO_STAGE_SOURCES) {
    it(`source file ${fileName} stays deleted`, () => {
      // mutate: re-add packages/middleware-recued/src/two-stage/${fileName} →
      // this assertion fails.
      expect(existsSync(twoStageSource(fileName))).toBe(false);
    });
  }
});

describe('D-164 P6.5 — retired two-stage test files stay deleted', () => {
  for (const fileName of RETIRED_TWO_STAGE_TESTS) {
    it(`test file ${fileName} stays deleted`, () => {
      // mutate: re-add packages/middleware-recued/src/__tests__/${fileName} →
      // this assertion fails.
      expect(existsSync(twoStageTest(fileName))).toBe(false);
    });
  }
});

// ── Bundle-index ratchets ────────────────────────────────────────────

describe('D-164 P6.5 — middleware-recued bundle index is two-stage-free', () => {
  const readBundle = (): string => readFileSync(BUNDLE_INDEX, 'utf8');

  it('no import statement targets `./two-stage`', () => {
    // mutate: restore `import { twoStageMiddleware } from './two-stage/middleware.js'` →
    // this assertion fails.
    expect(
      /^\s*import\s+[^;]*\s+from\s+['"]\.\/two-stage[^'"]*['"]/m.test(
        readBundle(),
      ),
    ).toBe(false);
  });

  it('no `export * as twoStage` namespace re-export', () => {
    // mutate: restore `export * as twoStage from './two-stage/index.js'` →
    // this assertion fails.
    expect(/^\s*export\s+\*\s+as\s+twoStage\b/m.test(readBundle())).toBe(false);
  });

  it('no `twoStageMiddleware` identifier in the bundle source', () => {
    // mutate: restore the `twoStageMiddleware` export line →
    // this assertion fails.
    expect(/\btwoStageMiddleware\b/.test(readBundle())).toBe(false);
  });

  it('FIRST_PARTY_MIDDLEWARES is the readonly four-adapter tuple (value)', () => {
    // mutate: re-add twoStageMiddleware to the tuple → this assertion fails.
    expect(FIRST_PARTY_MIDDLEWARES).toHaveLength(4);
    expect(FIRST_PARTY_MIDDLEWARES.map((mw) => mw.id)).toEqual([
      'scope-search',
      'correction-learning',
      'confidence-shape',
      'personal-recipes',
    ]);
  });

  it('FIRST_PARTY_MIDDLEWARES is typed as a readonly tuple, not a mutable array', () => {
    // mutate: drop `as const` from the tuple declaration → TS narrows
    // to `readonly Middleware[]` and this assignment fails to compile.
    // Codex test-review MINOR #5 fold: pins the structural shape so a
    // widening edit that preserves the runtime values is still caught.
    type FourAdapterTuple = readonly [
      Middleware,
      Middleware,
      Middleware,
      Middleware,
    ];
    const _shape: FourAdapterTuple = FIRST_PARTY_MIDDLEWARES;
    expect(_shape).toBe(FIRST_PARTY_MIDDLEWARES);
  });

  it('FIRST_PARTY_MIDDLEWARES contains no `two-stage` id', () => {
    // mutate: restore a `{ id: 'two-stage', ... }` entry → this assertion fails.
    expect(FIRST_PARTY_MIDDLEWARES.some((mw) => mw.id === 'two-stage')).toBe(
      false,
    );
  });

  it('registerFirstPartyMiddlewares registers no `two-stage` adapter', () => {
    // mutate: bring twoStageMiddleware back into the bundle → this assertion fails.
    const registry = createMiddlewareRegistry();

    registerFirstPartyMiddlewares(registry);

    expect(registry.has('two-stage')).toBe(false);
    expect(
      registry.all().some((entry) => entry.middleware.id === 'two-stage'),
    ).toBe(false);
  });
});

// ── Cross-repo source-grep ratchets ─────────────────────────────────

describe('D-164 P6.5 — cross-repo source grep matches the allow-list exactly', () => {
  let scans: ReadonlyArray<FileScan> = [];

  beforeAll(() => {
    scans = scanAllFiles();
  });

  it('the scan found at least one source file (sanity)', () => {
    // mutate: change REPO_SCAN_ROOTS so nothing is scanned → this assertion fails.
    expect(scans.length).toBeGreaterThan(100);
  });

  // Exhaustive offender report — one `expect` per pattern, every file
  // that drifts from its expected count shows up by relative path in
  // the assertion error so a maintainer can read the regression in
  // one shot.
  it('every file matches its expected `/two-stage/` import hit-count', () => {
    const offenders: string[] = [];
    for (const { rel, counts } of scans) {
      const expected = expectedFor(rel).pathImports;
      if (counts.pathImports !== expected) {
        offenders.push(
          `${rel}: pathImports actual=${counts.pathImports} expected=${expected}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every file matches its expected `twoStageMiddleware` hit-count', () => {
    const offenders: string[] = [];
    for (const { rel, counts } of scans) {
      const expected = expectedFor(rel).twoStageMiddleware;
      if (counts.twoStageMiddleware !== expected) {
        offenders.push(
          `${rel}: twoStageMiddleware actual=${counts.twoStageMiddleware} expected=${expected}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every file matches its expected `TWO_STAGE_*_STATE_KEY` hit-count', () => {
    const offenders: string[] = [];
    for (const { rel, counts } of scans) {
      const expected = expectedFor(rel).twoStageStateKey;
      if (counts.twoStageStateKey !== expected) {
        offenders.push(
          `${rel}: twoStageStateKey actual=${counts.twoStageStateKey} expected=${expected}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every allow-list entry resolves to a file the walker actually visited', () => {
    // Sanity: an allow-list entry that doesn't resolve to a scanned
    // file silently grants amnesty for paths that no longer exist
    // (or were never under REPO_SCAN_ROOTS). The expected-count
    // assertions above catch vestigial counts within scanned files;
    // this assertion catches typos in the allow-list keys.
    const scannedRel = new Set(scans.map(({ rel }) => rel));
    const missing: string[] = [];
    for (const rel of ALLOW_LIST_EXPECTED.keys()) {
      if (!scannedRel.has(rel)) {
        missing.push(rel);
      }
    }
    expect(missing).toEqual([]);
  });
});
