/** D-164 P6.6 — contracts surface cleanup deletion ratchets.
 *
 *  Pins:
 *    - `packages/contracts/src/stage1.ts` stays deleted.
 *    - The three retired test files in `packages/contracts/src/__tests__/`
 *      (`d-145-phase-pb17-stage1-contracts`, `d-137-wave-2-4-stage1-routing`,
 *      `d-137-wave-2-5-stage2-routing`) stay deleted.
 *    - `packages/contracts/src/index.ts` has no `from './stage1'`
 *      import + no re-exports of the retired symbols
 *      (`Stage1Input`, `Stage1Output`, `Stage1ChatMessage`,
 *      `STAGE2_TOOL_LOOP_CAP`, `STAGE1_VALIDATION_ISSUE_KINDS`,
 *      `CHAT_STAGE1_INGREDIENT_SLUG`, `CHAT_STAGE1_MODEL_HINT`,
 *      `CHAT_STAGE2_INGREDIENT_SLUG`, `CHAT_STAGE2_DEFAULT_MODEL_HINT`,
 *      `ChatStage1ForceLayer`, etc.).
 *    - `packages/contracts/src/chat.ts` has no `CHAT_STAGE1_*` /
 *      `CHAT_STAGE2_*` constants (the kernel slug renamed to
 *      `CHAT_MAIN_TURN_INGREDIENT_SLUG`) and no `ChatStage1ForceLayer`
 *      type (renamed to `ChatForceLayer`).
 *    - The migrated surfaces ARE present:
 *      `CHAT_MAIN_TURN_INGREDIENT_SLUG = 'recued/chat-main-turn'`,
 *      `CHAT_MAIN_TURN_TOOL_LOOP_CAP`, `ChatTailMessage`,
 *      `ChatForceLayer`.
 *    - Cross-repo source-grep ratchets that no file under
 *      `backend/` / `packages/` / `apps/` references any retired
 *      symbol or imports from any `./stage1` path. Per-pattern
 *      expected-hit-count `ALLOW_LIST_EXPECTED` Map (2 load-bearing
 *      entries — this file itself + `d-164-p6bc-cognition-grep`
 *      which carries the `@ts-expect-error` pins) — drift in either
 *      direction fails.
 *
 *  Out of scope (deferred slices):
 *    - `TransparencyStage1FallbackReason` /
 *      `TRANSPARENCY_STAGE1_FALLBACK_REASONS` in
 *      `packages/contracts/src/transparency-stream/` — retires in P6.7
 *      alongside the `engine.stage{1,2}_*` event kinds.
 *    - `runChatTwoStage` / `Stage 1` / `Stage 2` historical prose
 *      tokens in `chat-orchestrator.ts` JSDoc + a few backend test
 *      files — retires in P6.8 (grep-negative acceptance).
 *
 *  Spec: D-164
 *  line 520 (P6.6 row). Prior slice: D-164 P6.5 commit `e8ddad90`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  CHAT_MAIN_TURN_INGREDIENT_SLUG,
  CHAT_MAIN_TURN_TOOL_LOOP_CAP,
  type ChatForceLayer,
  type ChatTailMessage,
} from '../index.js';
import { isTypeScriptSource } from '../../../../test/source-file-extensions.js';

// ── Path resolution ─────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

const CONTRACTS_SRC = path.resolve(HERE, '..');
const STAGE1_PATH = path.resolve(CONTRACTS_SRC, 'stage1.ts');
const BARREL_PATH = path.resolve(CONTRACTS_SRC, 'index.ts');
const CHAT_TS_PATH = path.resolve(CONTRACTS_SRC, 'chat.ts');

const RETIRED_TEST_FILES = [
  'd-137-wave-2-4-stage1-routing.test.ts',
  'd-137-wave-2-5-stage2-routing.test.ts',
  'd-145-phase-pb17-stage1-contracts.test.ts',
] as const;

const retiredTestPath = (fileName: string): string =>
  path.resolve(HERE, fileName);

// ── Pattern catalog ─────────────────────────────────────────────────

// `g` flag so `.match()` returns every hit (per-pattern hit-counts
// drive the cross-repo allow-list assertions below).
//
// Imports of `./stage1` (relative or via the package alias). Three
// shapes covered: `from '...stage1[.js]'` static import; bare
// side-effect `import '...stage1[.js]'`; dynamic `import('...stage1[.js]')`
// (Codex P6.6 test-review MAJOR fold — original regex omitted the
// side-effect static-import form).
const STAGE1_IMPORT_RE =
  /(?:\bfrom\s+['"][^'"]*\/stage1(?:\.js)?['"]|\bimport\s+['"][^'"]*\/stage1(?:\.js)?['"]|\bimport\s*\(\s*['"][^'"]*\/stage1(?:\.js)?['"])/g;
// Retired identifier patterns. The `_RE` suffix collects all hits;
// the per-file expected count enforces "exactly these surfaces in
// these spots, no more, no less."
const CHAT_STAGE1_INGREDIENT_SLUG_RE = /\bCHAT_STAGE1_INGREDIENT_SLUG\b/g;
const CHAT_STAGE1_MODEL_HINT_RE = /\bCHAT_STAGE1_MODEL_HINT\b/g;
const CHAT_STAGE2_INGREDIENT_SLUG_RE = /\bCHAT_STAGE2_INGREDIENT_SLUG\b/g;
const CHAT_STAGE2_DEFAULT_MODEL_HINT_RE = /\bCHAT_STAGE2_DEFAULT_MODEL_HINT\b/g;
const CHAT_STAGE1_FORCE_LAYER_RE = /\bChatStage1ForceLayer\b/g;
const STAGE2_TOOL_LOOP_CAP_RE = /\bSTAGE2_TOOL_LOOP_CAP\b/g;
const STAGE1_CHAT_MESSAGE_RE = /\bStage1ChatMessage\b/g;
// Bare-word `Stage1Input`/`Stage1Output` — the cognition-grep ratchet
// still names these inside its `@ts-expect-error` blocks, so the
// allow-list carries an expected count for the lab files only.
const STAGE1_INPUT_RE = /\bStage1Input\b/g;
const STAGE1_OUTPUT_RE = /\bStage1Output\b/g;
const STAGE1_VALIDATION_ISSUE_KINDS_RE = /\bSTAGE1_VALIDATION_ISSUE_KINDS\b/g;

const countMatches = (src: string, re: RegExp): number => {
  const matches = src.match(re);
  return matches === null ? 0 : matches.length;
};

interface ExpectedCounts {
  readonly stage1Import: number;
  readonly chatStage1IngredientSlug: number;
  readonly chatStage1ModelHint: number;
  readonly chatStage2IngredientSlug: number;
  readonly chatStage2DefaultModelHint: number;
  readonly chatStage1ForceLayer: number;
  readonly stage2ToolLoopCap: number;
  readonly stage1ChatMessage: number;
  readonly stage1Input: number;
  readonly stage1Output: number;
  readonly stage1ValidationIssueKinds: number;
}

const zeroCounts: ExpectedCounts = {
  stage1Import: 0,
  chatStage1IngredientSlug: 0,
  chatStage1ModelHint: 0,
  chatStage2IngredientSlug: 0,
  chatStage2DefaultModelHint: 0,
  chatStage1ForceLayer: 0,
  stage2ToolLoopCap: 0,
  stage1ChatMessage: 0,
  stage1Input: 0,
  stage1Output: 0,
  stage1ValidationIssueKinds: 0,
};

// Files allow-listed for documented residue. Per-pattern counts are
// captured against the post-P6.6 tree.
//
// 2 load-bearing entries (post-Codex test-review NIT fold — original
// comment overstated "4 entries"):
//  - This ratchet file itself: regex sources + allow-list keys name
//    every retired symbol.
//  - `d-164-p6bc-cognition-grep.ratchet.test.ts`: cognition-residue
//    ratchet — names the retired symbols inside `@ts-expect-error`
//    type-level blocks + the new chat.ts cognition-absence grep
//    (Codex P6.6 impl-review Q2 + Q7 folds).
//
// `packages/contracts/src/chat.ts` (migrated surface) + `index.ts`
// (barrel) carry the new `CHAT_MAIN_TURN_*` / `ChatTailMessage` /
// `ChatForceLayer` surfaces but ZERO hits of the retired patterns —
// so they fall under the default-zero allow-list path and don't need
// explicit entries.
const ALLOW_LIST_EXPECTED: ReadonlyMap<string, ExpectedCounts> = new Map([
  // This ratchet file: every retired symbol appears in the regex
  // sources + the per-test mutation comments + the per-file expected
  // count entries. Counts captured against the post-P6.6 tree.
  [
    'packages/contracts/src/__tests__/d-164-phase-6-6-contracts-deletion.ratchet.test.ts',
    {
      ...zeroCounts,
      stage1Import: 2,
      chatStage1IngredientSlug: 3,
      chatStage1ModelHint: 3,
      chatStage2IngredientSlug: 3,
      chatStage2DefaultModelHint: 3,
      chatStage1ForceLayer: 6,
      stage2ToolLoopCap: 2,
      stage1ChatMessage: 4,
      stage1Input: 5,
      stage1Output: 5,
      stage1ValidationIssueKinds: 2,
    },
  ],
  // The cognition-residue ratchet — names the retired symbols in
  // type-level `@ts-expect-error` blocks (P6.6 Q2 fold expanded
  // coverage to barrel-reintroduction). Counts capture each ts-
  // expect-error pin + its mutation comment + the descriptive header.
  [
    'packages/contracts/src/__tests__/d-164-p6bc-cognition-grep.ratchet.test.ts',
    {
      ...zeroCounts,
      stage1Input: 2,
      stage1Output: 2,
      stage1ChatMessage: 3,
      stage1ValidationIssueKinds: 3,
      stage2ToolLoopCap: 3,
      chatStage2IngredientSlug: 2,
      chatStage1ForceLayer: 2,
    },
  ],
]);

const expectedFor = (rel: string): ExpectedCounts =>
  ALLOW_LIST_EXPECTED.get(rel) ?? zeroCounts;

// ── Repo-wide scan helpers ──────────────────────────────────────────

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

interface FileScan {
  readonly rel: string;
  readonly counts: ExpectedCounts;
}

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
        stage1Import: countMatches(src, STAGE1_IMPORT_RE),
        chatStage1IngredientSlug: countMatches(src, CHAT_STAGE1_INGREDIENT_SLUG_RE),
        chatStage1ModelHint: countMatches(src, CHAT_STAGE1_MODEL_HINT_RE),
        chatStage2IngredientSlug: countMatches(src, CHAT_STAGE2_INGREDIENT_SLUG_RE),
        chatStage2DefaultModelHint: countMatches(src, CHAT_STAGE2_DEFAULT_MODEL_HINT_RE),
        chatStage1ForceLayer: countMatches(src, CHAT_STAGE1_FORCE_LAYER_RE),
        stage2ToolLoopCap: countMatches(src, STAGE2_TOOL_LOOP_CAP_RE),
        stage1ChatMessage: countMatches(src, STAGE1_CHAT_MESSAGE_RE),
        stage1Input: countMatches(src, STAGE1_INPUT_RE),
        stage1Output: countMatches(src, STAGE1_OUTPUT_RE),
        stage1ValidationIssueKinds: countMatches(src, STAGE1_VALIDATION_ISSUE_KINDS_RE),
      },
    });
  }
  cachedScans = out;
  return out;
};

// ── File-existence ratchets ──────────────────────────────────────────

describe('D-164 P6.6 — stage1.ts + retired test files stay deleted', () => {
  it('packages/contracts/src/stage1.ts stays absent', () => {
    // mutate: recreate packages/contracts/src/stage1.ts → this assertion fails.
    expect(existsSync(STAGE1_PATH)).toBe(false);
  });

  for (const fileName of RETIRED_TEST_FILES) {
    it(`test file ${fileName} stays deleted`, () => {
      // mutate: re-add packages/contracts/src/__tests__/${fileName} → this assertion fails.
      expect(existsSync(retiredTestPath(fileName))).toBe(false);
    });
  }
});

// ── Barrel-shape ratchets ──────────────────────────────────────────

describe('D-164 P6.6 — contracts barrel surface is stage1-free', () => {
  const readBarrel = (): string => readFileSync(BARREL_PATH, 'utf8');

  it('no import statement targets `./stage1`', () => {
    // mutate: restore `export ... from './stage1.js'` → this assertion fails.
    expect(STAGE1_IMPORT_RE.test(readBarrel())).toBe(false);
  });

  it('barrel does not re-export `Stage1Input` / `Stage1Output` / `Stage1ChatMessage`', () => {
    const src = readBarrel();
    expect(/^\s*Stage1Input,\s*$/m.test(src)).toBe(false);
    expect(/^\s*Stage1Output,\s*$/m.test(src)).toBe(false);
    expect(/^\s*Stage1ChatMessage,\s*$/m.test(src)).toBe(false);
  });

  it('barrel does not re-export `CHAT_STAGE1_*` / `CHAT_STAGE2_*` constants', () => {
    const src = readBarrel();
    expect(/^\s*CHAT_STAGE1_INGREDIENT_SLUG,/m.test(src)).toBe(false);
    expect(/^\s*CHAT_STAGE1_MODEL_HINT,/m.test(src)).toBe(false);
    expect(/^\s*CHAT_STAGE2_INGREDIENT_SLUG,/m.test(src)).toBe(false);
    expect(/^\s*CHAT_STAGE2_DEFAULT_MODEL_HINT,/m.test(src)).toBe(false);
  });

  it('barrel does not re-export `ChatStage1ForceLayer`', () => {
    expect(/^\s*ChatStage1ForceLayer,/m.test(readBarrel())).toBe(false);
  });

  it('barrel re-exports the migrated surfaces', () => {
    // mutate: drop the chat.ts re-exports of CHAT_MAIN_TURN_INGREDIENT_SLUG
    // / CHAT_MAIN_TURN_TOOL_LOOP_CAP / ChatForceLayer / ChatTailMessage →
    // these assertions fail.
    const src = readBarrel();
    expect(/\bCHAT_MAIN_TURN_INGREDIENT_SLUG\b/.test(src)).toBe(true);
    expect(/\bCHAT_MAIN_TURN_TOOL_LOOP_CAP\b/.test(src)).toBe(true);
    expect(/\bChatForceLayer\b/.test(src)).toBe(true);
    expect(/\bChatTailMessage\b/.test(src)).toBe(true);
  });
});

// ── Chat.ts shape ratchets ─────────────────────────────────────────

describe('D-164 P6.6 — chat.ts retirement + migration shape', () => {
  const readChat = (): string => readFileSync(CHAT_TS_PATH, 'utf8');

  it('chat.ts has no `CHAT_STAGE1_*` or `CHAT_STAGE2_*` const declarations', () => {
    const src = readChat();
    expect(/^export\s+const\s+CHAT_STAGE1_/m.test(src)).toBe(false);
    expect(/^export\s+const\s+CHAT_STAGE2_/m.test(src)).toBe(false);
  });

  it('chat.ts has no `ChatStage1ForceLayer` type alias (renamed to `ChatForceLayer`)', () => {
    expect(/\bChatStage1ForceLayer\b/.test(readChat())).toBe(false);
  });

  it('chat.ts declares the migrated `CHAT_MAIN_TURN_INGREDIENT_SLUG` const', () => {
    const src = readChat();
    // mutate: rename or drop CHAT_MAIN_TURN_INGREDIENT_SLUG → this assertion fails.
    expect(
      /^export\s+const\s+CHAT_MAIN_TURN_INGREDIENT_SLUG\s*=\s*['"]recued\/chat-main-turn['"]/m.test(
        src,
      ),
    ).toBe(true);
  });

  it('chat.ts declares the migrated `CHAT_MAIN_TURN_TOOL_LOOP_CAP` const', () => {
    const src = readChat();
    // mutate: rename or drop CHAT_MAIN_TURN_TOOL_LOOP_CAP → this assertion fails.
    expect(
      /^export\s+const\s+CHAT_MAIN_TURN_TOOL_LOOP_CAP\s*=\s*\d+/m.test(src),
    ).toBe(true);
  });

  it('chat.ts declares the migrated `ChatTailMessage` interface', () => {
    const src = readChat();
    // mutate: drop ChatTailMessage → this assertion fails.
    expect(/^export\s+interface\s+ChatTailMessage\b/m.test(src)).toBe(true);
  });
});

// ── Runtime surface ratchets ───────────────────────────────────────

describe('D-164 P6.6 — migrated runtime values are stable', () => {
  it('CHAT_MAIN_TURN_INGREDIENT_SLUG pins the wire-level literal', () => {
    // mutate: change the kernel slug literal → this assertion fails.
    expect(CHAT_MAIN_TURN_INGREDIENT_SLUG).toBe('recued/chat-main-turn');
  });

  it('CHAT_MAIN_TURN_TOOL_LOOP_CAP pins the chat loop ceiling (=10)', () => {
    // mutate: change the loop cap → this assertion fails.
    //
    // ⚠ Was `=8`, the PB17 default this ratchet originally proved the D-164
    // migration had not dropped. Raised to 10 on 2026-08-18 because a
    // lean-core packet omits Tier-2 entries, so each unknown recipe costs a
    // `tools.search` round before its call and a deep procedure exhausted the
    // loop mid-flight (see the constant's own note). The ratchet stays: this
    // value is a deliberate interactive-latency ceiling, so it should only
    // ever move by someone editing this line on purpose.
    expect(CHAT_MAIN_TURN_TOOL_LOOP_CAP).toBe(10);
  });

  it('ChatForceLayer typed as `"free" | "byok"` (closed two-value codomain)', () => {
    // mutate: widen ChatForceLayer to admit "any" / "web_chat" → this
    // assignment fails to compile.
    const free: ChatForceLayer = 'free';
    const byok: ChatForceLayer = 'byok';
    expect(free).toBe('free');
    expect(byok).toBe('byok');
  });

  it('ChatTailMessage shape stays `{ role, content, turn? }`', () => {
    // mutate: drop a required field → this construction fails to compile.
    const tail: ChatTailMessage = {
      role: 'user',
      content: 'hello',
    };
    expect(tail.role).toBe('user');
  });
});

// ── Cross-repo source-grep ratchets ─────────────────────────────────

describe('D-164 P6.6 — cross-repo source grep matches the allow-list exactly', () => {
  let scans: ReadonlyArray<FileScan> = [];

  beforeAll(() => {
    scans = scanAllFiles();
  });

  it('the scan found at least one source file (sanity)', () => {
    expect(scans.length).toBeGreaterThan(100);
  });

  // One assertion per retired pattern — the offender list reports
  // every file that drifts from its expected count, so a maintainer
  // can read the regression in one shot.
  const PATTERN_LABELS: ReadonlyArray<readonly [keyof ExpectedCounts, string]> = [
    ['stage1Import', '`./stage1` import'],
    ['chatStage1IngredientSlug', '`CHAT_STAGE1_INGREDIENT_SLUG`'],
    ['chatStage1ModelHint', '`CHAT_STAGE1_MODEL_HINT`'],
    ['chatStage2IngredientSlug', '`CHAT_STAGE2_INGREDIENT_SLUG`'],
    ['chatStage2DefaultModelHint', '`CHAT_STAGE2_DEFAULT_MODEL_HINT`'],
    ['chatStage1ForceLayer', '`ChatStage1ForceLayer`'],
    ['stage2ToolLoopCap', '`STAGE2_TOOL_LOOP_CAP`'],
    ['stage1ChatMessage', '`Stage1ChatMessage`'],
    ['stage1Input', '`Stage1Input`'],
    ['stage1Output', '`Stage1Output`'],
    ['stage1ValidationIssueKinds', '`STAGE1_VALIDATION_ISSUE_KINDS`'],
  ];

  for (const [field, label] of PATTERN_LABELS) {
    it(`every file matches its expected ${label} hit-count`, () => {
      const offenders: string[] = [];
      for (const { rel, counts } of scans) {
        const expected = expectedFor(rel)[field];
        const actual = counts[field];
        if (actual !== expected) {
          offenders.push(
            `${rel}: ${field} actual=${actual} expected=${expected}`,
          );
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it('every allow-list entry resolves to a file the walker actually visited', () => {
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
