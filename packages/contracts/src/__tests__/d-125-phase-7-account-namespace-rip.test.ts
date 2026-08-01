/** D-125 P7.3 — CI assert that no live source code reads or writes
 *  the retired `account.*` namespace.
 *
 *  Spec § 7.3: "Confirm zero callsites reference `account.*` post-P5.2
 *  with a CI assert." The literal `'account'` entry stays in
 *  `Namespace` as reserved (load-bearing decision 8 — future categories
 *  that don't fit `connection.*` could re-use the slot without a
 *  Namespace contract change). What this test forbids is *runtime*
 *  references — callsites that read `{{account.X}}`, dispatch on the
 *  account namespace, or import any `account.*` data store the way
 *  P5.2 deleted them.
 *
 *  Allowlist:
 *    - Test files (asserting account.* is gone is, itself, a fine ref).
 *    - Comments + doc strings (historical context survives).
 *    - The validator error message in `references.ts` (warns recipe
 *      authors who try to use the retired namespace).
 *    - The Namespace literal entry in `namespaces.ts` (the reserved
 *      type-level placeholder).
 *    - The D-125 P5.2 commit's slack/telegram approvals copy that
 *      mentions the retired token name as historical breadcrumb.
 *
 *  We scan the live code surfaces: `packages/`, `apps/`, `backend/`.
 *  Anything matching `{{account.` or the dotted runtime forms we
 *  forbid (`account.slack.token`, `account.<vendor>.<field>`) outside
 *  the allowlist is a violation. */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js']);

const SCAN_ROOTS = [
  'packages',
  'apps',
  'backend',
];

/** Skip entire subtrees that aren't live source. */
const isSkippedDir = (segment: string): boolean =>
  segment === 'node_modules' ||
  segment === 'dist' ||
  segment === 'coverage' ||
  segment === '.cache';

/** Test files + this gate test itself are allowlisted — they routinely
 *  reference `account.*` to assert it's gone. */
const isTestFile = (path: string): boolean =>
  path.includes('__tests__') ||
  path.endsWith('.test.ts') ||
  path.endsWith('.spec.ts');

const walk = (dir: string, out: string[] = []): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (isSkippedDir(entry)) continue;
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (SOURCE_EXTS.has(full.slice(full.lastIndexOf('.')))) {
      out.push(full);
    }
  }
  return out;
};

/** Live source is TRACKED source. 57% of the walk (52 MB of 92 MB, in 13 files)
 *  was gitignored build output — three ~13 MB `dist-bench` bundles, the
 *  webclient and bridge builds, the marketplace SSR assets, the e2e harness
 *  bundles. Reading them is not merely slow, it is wrong twice over: a bundle
 *  contains whatever its sources contain, so it adds no coverage the scan does
 *  not already have, and a STALE bundle can fire this fence for a violation
 *  that no longer exists in any source file — a false positive indistinguishable
 *  from the flake this test was written off as.
 *
 *  Directory-name skipping cannot express it: `apps/webclient/e2e/harness/`
 *  holds tracked `.ts` harness source beside gitignored `.js` bundles, and two
 *  tracked `.js` files elsewhere (`public/sw.js`, `functions/recipe-validator.js`)
 *  are genuine runtime code this fence must keep covering.
 *
 *  One batched `git check-ignore` call. If git is unavailable the filter is a
 *  no-op — the fence stays CORRECT and merely slow, never silently empty; the
 *  non-empty-corpus assertion below is measured on the filtered list precisely
 *  so an over-broad result cannot pass as green. */
const withoutIgnored = (files: string[]): string[] => {
  if (files.length === 0) return files;
  let ignored: Set<string>;
  try {
    const out = spawnSync('git', ['check-ignore', '--stdin'], {
      cwd: REPO_ROOT,
      input: files.join('\n'),
      encoding: 'utf8',
    });
    // Exit 0 = some paths ignored, 1 = none ignored. Anything else (git absent,
    // not a checkout) means we learned nothing — keep every file.
    if (out.error !== undefined || (out.status !== 0 && out.status !== 1)) return files;
    ignored = new Set((out.stdout ?? '').split('\n').filter((p) => p !== ''));
  } catch {
    return files;
  }
  return files.filter((f) => !ignored.has(f) && !ignored.has(relative(REPO_ROOT, f)));
};

const liveSourceFiles = (): string[] =>
  withoutIgnored(
    SCAN_ROOTS.flatMap((root) => walk(join(REPO_ROOT, root))).filter((f) => !isTestFile(f)),
  );

const isCommentLine = (line: string): boolean => {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*')
  );
};

/** A line is allowlisted when it carries an `account.*` reference but
 *  the reference is clearly historical / explanatory rather than
 *  runtime. Two narrow exceptions:
 *    1. The validator error message that warns recipe authors who try
 *       to reach the retired namespace ("`{{account.${path}}}` — the
 *       account namespace was retired…").
 *    2. The `Namespace` type entry (`'account'` literal kept reserved
 *       per D-125 load-bearing decision 8). */
const isAllowlistedLine = (file: string, line: string): boolean => {
  const rel = relative(REPO_ROOT, file).replace(/\\/g, '/');
  // Validator error message — string literal that quotes the retired
  // form. Acceptable.
  if (rel.endsWith('packages/recipes/src/validate/references.ts')) {
    return line.includes('the account namespace was retired');
  }
  // Namespace contract: `'account'` literal stays as reserved.
  if (rel.endsWith('packages/contracts/src/namespaces.ts')) {
    return line.includes("'account'") || line.includes('account namespace');
  }
  return false;
};

/** The forbidden patterns. Two shapes catch the runtime forms:
 *  - `{{account.X}}` interpolation in a code or string literal
 *  - `account.<vendor>.<field>` dotted runtime path written outside a
 *    comment (the connection-handler / approval-store / sync wire
 *    code that used to reach for these is exactly what P5.2 removed).
 *
 *  We deliberately don't ban the bare token `account` (too noisy —
 *  matches `accounting`, `accountId`, `loginAccount`). The dotted
 *  + interpolation forms are the actual runtime hooks. */
const ACCOUNT_INTERPOLATION = /\{\{account\.[a-zA-Z]/;
const ACCOUNT_DOTTED_PATH = /\baccount\.(slack|telegram|email|gmail|imap|caldav|graph|google|outlook)\.\w/;
const FORBIDDEN = [ACCOUNT_INTERPOLATION, ACCOUNT_DOTTED_PATH];

/** The cheap pre-filter's premise: EVERY forbidden pattern requires the literal
 *  `account.`, so a file without that substring cannot contain a violation and
 *  need not be split into lines at all.
 *
 *  ⚠ This is the whole safety of the optimisation, so it is asserted rather
 *  than assumed (below). Add a pattern that does not contain `account.` — say a
 *  bare `{{account}}` form — and the fast path would skip every file it lives
 *  in, silently, while this gate kept reporting green. */
const PREFILTER = 'account.';

const violationsIn = (file: string, content: string): string[] => {
  // 2,480 source files / ~91 MB per run, of which fewer than 100 contain the
  // token at all. Splitting and regexing all of it took ~2s alone and blew past
  // vitest's 5s default under parallel load — a gate that fails on machine load
  // is a gate that gets written off as flaky, which is exactly what happened to
  // this one (three times in one session) before anyone read the timing.
  if (!content.includes(PREFILTER)) return [];
  const out: string[] = [];
  content.split('\n').forEach((line, idx) => {
    if (isCommentLine(line)) return;
    if (isAllowlistedLine(file, line)) return;
    if (FORBIDDEN.some((re) => re.test(line))) {
      out.push(`${relative(REPO_ROOT, file)}:${idx + 1} → ${line.trim()}`);
    }
  });
  return out;
};

// ── The fence must BITE. A scan over a clean corpus passes vacuously the day
//    the matcher — or the pre-filter that decides which files reach it —
//    becomes a no-op. These cases prove it rejects, independently of what the
//    tree happens to contain.
describe('the fence bites', () => {
  const check = (line: string): string[] =>
    violationsIn(join(REPO_ROOT, 'packages/x/src/live.ts'), line);

  it('every forbidden pattern requires the pre-filter substring', () => {
    // The optimisation's premise, asserted. A pattern that can match without
    // `account.` would be silently skipped in any file lacking the token.
    for (const re of FORBIDDEN) {
      expect(re.source, `${re.source} must contain the pre-filter literal`)
        .toContain('account\\.');
    }
  });

  it('catches the interpolation form', () => {
    expect(check('const t = "{{account.slack.token}}";')).toHaveLength(1);
  });

  it('catches the dotted runtime path', () => {
    expect(check('const t = stores.account.gmail.access_token;')).toHaveLength(1);
  });

  it('lets the comment, allowlist, and unrelated forms through', () => {
    expect(check('// historical: {{account.slack.token}} was retired')).toEqual([]);
    expect(check('const id = accountId;')).toEqual([]);
    expect(check('const a = accounting.total;')).toEqual([]);
  });

  it('the pre-filter does not skip a file that contains a violation', () => {
    // The case the fast path could break: a real violation must survive it.
    const content = 'const x = 1;\nconst t = "{{account.telegram.token}}";\n';
    expect(violationsIn(join(REPO_ROOT, 'packages/x/src/live.ts'), content))
      .toHaveLength(1);
  });
});

describe('D-125 P7.3 — account.* namespace runtime RIP', () => {
  it('scans a non-empty source corpus', () => {
    // Anti-vacuous, measured on the FILTERED list: a moved scan root, or an
    // ignore filter that swallowed everything, must FAIL here rather than
    // report a green "nothing to check".
    expect(liveSourceFiles().length).toBeGreaterThan(1000);
  });

  it('no source file outside the allowlist references account.* at runtime', () => {
    const violations: string[] = [];
    for (const file of liveSourceFiles()) {
      let content: string;
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      violations.push(...violationsIn(file, content));
    }
    expect(violations, violations.length > 0
      ? `account.* runtime callsites found:\n${violations.join('\n')}`
      : '',
    ).toEqual([]);
  });
});
