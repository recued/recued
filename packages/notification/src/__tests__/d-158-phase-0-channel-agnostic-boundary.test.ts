import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(__dirname, '..', '..', '..', '..');
const PACKAGES = resolve(REPO, 'packages');
const FLOW_CONTROLLER_ROOTS = [
  join(PACKAGES, 'gateway', 'src'),
  join(PACKAGES, 'engine', 'src'),
];
const NOTIFICATION_SRC = join(PACKAGES, 'notification', 'src');
const FORBIDDEN_LITERALS = ['slack', 'telegram', 'email', 'ui'] as const;
const FORBIDDEN_LITERAL_RE = /(['"])(slack|telegram|email|ui)\1/g;
const FORBIDDEN_IMPORT_RE =
  /(?:from\s+|import\s*\(\s*|import\s+)['"](@recued\/(?:gateway|engine)(?:\/[^'"]*)?)['"]/g;

type ForbiddenLiteral = (typeof FORBIDDEN_LITERALS)[number];

interface LiteralOccurrence {
  file: string;
  literal: ForbiddenLiteral;
  quote: string;
  line: number;
  column: number;
  lineText: string;
}

const ALLOWLIST: Array<{
  file: string;
  literal: ForbiddenLiteral;
  reason: string;
}> = [
  {
    file: 'packages/engine/src/dry-run.ts',
    literal: 'email',
    reason: 'field-name substring for mock-data synthesis, not a channel discriminant',
  },
  {
    file: 'packages/gateway/src/pii-egress/egress-aliasing.ts',
    literal: 'email',
    reason: 'D-167 PII identifier-kind discriminant (EntityFieldPrivacy), not a channel discriminant',
  },
];

const collectSourceFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === '__tests__') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...collectSourceFiles(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
};

const repoPath = (path: string): string => path.slice(REPO.length + 1);

const lineAndColumn = (
  text: string,
  index: number,
): { line: number; column: number; lineText: string } => {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const lastNewline = before.lastIndexOf('\n');
  const column = index - lastNewline;
  const lineText = text.split(/\r?\n/)[line - 1]?.trim() ?? '';
  return { line, column, lineText };
};

const forbiddenLiteralOccurrences = (
  file: string,
  text: string,
): LiteralOccurrence[] => {
  const occurrences: LiteralOccurrence[] = [];
  for (const match of text.matchAll(FORBIDDEN_LITERAL_RE)) {
    const [, quote, literal] = match;
    if (match.index === undefined) continue;
    const location = lineAndColumn(text, match.index);
    occurrences.push({
      file,
      literal: literal as ForbiddenLiteral,
      quote,
      ...location,
    });
  }
  return occurrences;
};

const isAllowlisted = (occurrence: LiteralOccurrence): boolean =>
  ALLOWLIST.some(
    (entry) =>
      entry.file === repoPath(occurrence.file) &&
      entry.literal === occurrence.literal,
  );

const formatLiteralOccurrence = (occurrence: LiteralOccurrence): string =>
  `${repoPath(occurrence.file)}:${occurrence.line}:${occurrence.column}: `
  + `${occurrence.quote}${occurrence.literal}${occurrence.quote} in `
  + occurrence.lineText;

const forbiddenImports = (file: string, text: string): string[] => {
  const imports: string[] = [];
  for (const match of text.matchAll(FORBIDDEN_IMPORT_RE)) {
    const [, specifier] = match;
    if (match.index === undefined) continue;
    const location = lineAndColumn(text, match.index);
    imports.push(
      `${repoPath(file)}:${location.line}:${location.column}: ${specifier}`,
    );
  }
  return imports;
};

describe('D-158 I-1 channel-agnostic boundary', () => {
  it('scans gateway and engine source while excluding tests', () => {
    const scanned = FLOW_CONTROLLER_ROOTS.flatMap(collectSourceFiles).map(repoPath);

    expect(scanned).toContain('packages/gateway/src/index.ts');
    expect(scanned).toContain('packages/engine/src/index.ts');
    expect(scanned).toContain('packages/engine/src/dry-run.ts');
    expect(scanned.some((file) => file.includes('/__tests__/'))).toBe(false);
  });

  it('finds no channel-name literals in flow controllers except the documented allowlist entry', () => {
    expect(ALLOWLIST).toEqual([
      {
        file: 'packages/engine/src/dry-run.ts',
        literal: 'email',
        reason: 'field-name substring for mock-data synthesis, not a channel discriminant',
      },
      {
        file: 'packages/gateway/src/pii-egress/egress-aliasing.ts',
        literal: 'email',
        reason: 'D-167 PII identifier-kind discriminant (EntityFieldPrivacy), not a channel discriminant',
      },
    ]);

    const offenders = FLOW_CONTROLLER_ROOTS.flatMap(collectSourceFiles)
      .flatMap((file) =>
        forbiddenLiteralOccurrences(file, readFileSync(file, 'utf8')),
      )
      .filter((occurrence) => !isAllowlisted(occurrence))
      .map(formatLiteralOccurrence);

    expect(offenders).toEqual([]);
  });

  it('keeps both email allowlist entries live and exact', () => {
    const allowlistedOccurrences = FLOW_CONTROLLER_ROOTS.flatMap(collectSourceFiles)
      .flatMap((file) =>
        forbiddenLiteralOccurrences(file, readFileSync(file, 'utf8')),
      )
      .filter(isAllowlisted);

    expect(allowlistedOccurrences).toHaveLength(2);
    expect(allowlistedOccurrences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: join(PACKAGES, 'engine', 'src', 'dry-run.ts'),
          literal: 'email',
          lineText: "if (f.includes('email')) return 'mock@example.com';",
        }),
        // D-167 — PII identifier-kind discriminant, not a channel name.
        expect.objectContaining({
          file: join(PACKAGES, 'gateway', 'src', 'pii-egress', 'egress-aliasing.ts'),
          literal: 'email',
        }),
      ]),
    );
  });

  it('synthetic regression: the scanner flags single- and double-quoted channel literals', () => {
    const hits = forbiddenLiteralOccurrences(
      join(REPO, 'synthetic.ts'),
      `
        if (channel === 'slack') return true;
        if (channel === "ui") return false;
      `,
    );

    expect(hits.map((hit) => `${hit.quote}${hit.literal}${hit.quote}`)).toEqual([
      "'slack'",
      '"ui"',
    ]);
  });
});

describe('D-158 A.9 notification import boundary', () => {
  it('keeps the notification leaf block from importing gateway or engine', () => {
    const offenders = collectSourceFiles(NOTIFICATION_SRC)
      .flatMap((file) => forbiddenImports(file, readFileSync(file, 'utf8')));

    expect(offenders).toEqual([]);
  });
});
