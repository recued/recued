import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { emptySqlMetrics, sqlMetricKind } from '../qualification-sql-metrics.js';

const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'recued-sql-metrics-')); directories.push(path); return path; };

it('distinguishes logical operations, retaining ambiguous CTEs as unknown work', () => {
  for (const [sql, kind] of [[' -- private comment\nSELECT 1', 'select'], ['/* x */ INSERT INTO x VALUES(1)', 'insert'],
    ['UPDATE x SET a=1', 'update'], ['DELETE FROM x', 'delete'], ['PRAGMA journal_mode', 'pragma'],
    ['BEGIN IMMEDIATE', 'transaction'], ['ROLLBACK', 'transaction'], ['CREATE TABLE x(a)', 'ddl'],
    ['WITH a AS (SELECT 1) SELECT * FROM a', 'other']] as const) expect(sqlMetricKind(sql)).toBe(kind);
});

it('is off by default and never writes SQL text, parameters or private strings', async () => {
  vi.stubEnv('RECUED_QUALIFICATION_SQL_METRICS_DIRECTORY', '');
  const { qualificationSqlMetrics } = await import('../qualification-sql-metrics.js');
  expect(qualificationSqlMetrics()).toBeUndefined();
  const path = directory(); vi.stubEnv('RECUED_QUALIFICATION_SQL_METRICS_DIRECTORY', path);
  const count = qualificationSqlMetrics()!;
  const sql = "INSERT INTO secret VALUES ('private credential é')";
  count(sql); count('SELECT 1');
  expect(qualificationSqlMetrics()).toBe(count);
  await new Promise<void>(resolve => queueMicrotask(resolve));
  const files = readdirSync(path); expect(files).toEqual([`sql-${process.pid}.json`]);
  const text = readFileSync(join(path, files[0]!), 'utf8');
  const expected = emptySqlMetrics(); expected.statements.insert = 1; expected.statements.select = 1;
  expected.expanded_statement_bytes.insert = Buffer.byteLength(sql); expected.expanded_statement_bytes.select = 8;
  expect(JSON.parse(text)).toEqual(expected);
  for (const privateText of ['secret', 'credential', 'private', 'INSERT', 'SELECT']) expect(text).not.toContain(privateText);
});

it('fails open when an output directory cannot be created', async () => {
  const file = join(directory(), 'regular-file'); writeFileSync(file, 'fixture');
  vi.stubEnv('RECUED_QUALIFICATION_SQL_METRICS_DIRECTORY', join(file, 'child'));
  const { qualificationSqlMetrics } = await import('../qualification-sql-metrics.js');
  expect(qualificationSqlMetrics()).toBeUndefined();
});
