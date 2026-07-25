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

describe('D-125 P7.3 — account.* namespace runtime RIP', () => {
  it('no source file outside the allowlist references account.* at runtime', () => {
    const violations: string[] = [];
    for (const root of SCAN_ROOTS) {
      const files = walk(join(REPO_ROOT, root)).filter((f) => !isTestFile(f));
      for (const file of files) {
        let content: string;
        try {
          content = readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        const lines = content.split('\n');
        lines.forEach((line, idx) => {
          if (isCommentLine(line)) return;
          if (isAllowlistedLine(file, line)) return;
          if (ACCOUNT_INTERPOLATION.test(line) || ACCOUNT_DOTTED_PATH.test(line)) {
            violations.push(
              `${relative(REPO_ROOT, file)}:${idx + 1} → ${line.trim()}`,
            );
          }
        });
      }
    }
    expect(violations, violations.length > 0
      ? `account.* runtime callsites found:\n${violations.join('\n')}`
      : '',
    ).toEqual([]);
  });
});
