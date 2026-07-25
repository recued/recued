import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyBootProfile,
  createBootTrace,
  type BootTraceEvent,
} from '../cli/boot-trace.js';

const parseTrace = (line: string): BootTraceEvent =>
  JSON.parse(line.replace(/^\[recued boot\] /, '')) as BootTraceEvent;

describe('boot trace', () => {
  it('stays disabled unless RECUED_BOOT_TRACE=1', () => {
    const lines: string[] = [];
    const trace = createBootTrace({
      entrypoint: 'bin',
      profile: 'none',
      command: '--version',
      env: {},
      sink: (line) => lines.push(line),
      now: () => 10,
    });

    trace.mark('cli-parsed');
    trace.markDbOpenAttempted();
    trace.finish();

    expect(trace.enabled).toBe(false);
    expect(lines).toEqual([]);
  });

  it('emits profile, phase, db-open status, and elapsed milliseconds', () => {
    const lines: string[] = [];
    let now = 100;
    const trace = createBootTrace({
      entrypoint: 'bin',
      profile: 'none',
      command: '--version',
      env: { RECUED_BOOT_TRACE: '1' },
      sink: (line) => lines.push(line),
      now: () => now,
    });

    trace.mark('cli-parsed');
    now = 112;
    trace.markImport('./commands/version.js');
    now = 130;
    trace.finish('dispatch-complete');

    expect(lines.map(parseTrace)).toEqual([
      {
        tag: 'recued.boot',
        entrypoint: 'bin',
        profile: 'none',
        phase: 'trace-start',
        elapsed_ms: 0,
        db_open_attempted: false,
        command: '--version',
      },
      {
        tag: 'recued.boot',
        entrypoint: 'bin',
        profile: 'none',
        phase: 'cli-parsed',
        elapsed_ms: 0,
        db_open_attempted: false,
        command: '--version',
      },
      {
        tag: 'recued.boot',
        entrypoint: 'bin',
        profile: 'none',
        phase: 'import',
        elapsed_ms: 12,
        db_open_attempted: false,
        command: '--version',
        detail: './commands/version.js',
      },
      {
        tag: 'recued.boot',
        entrypoint: 'bin',
        profile: 'none',
        phase: 'dispatch-complete',
        elapsed_ms: 30,
        db_open_attempted: false,
        command: '--version',
      },
    ]);
  });

  it('records db-open attempts before construction can fail', () => {
    const lines: string[] = [];
    const trace = createBootTrace({
      entrypoint: 'bin',
      profile: 'command',
      command: 'pair',
      env: { RECUED_BOOT_TRACE: '1' },
      sink: (line) => lines.push(line),
      now: () => 50,
    });

    trace.markDbOpenAttempted('./recued-server.db');

    expect(parseTrace(lines.at(-1) ?? '')).toMatchObject({
      phase: 'db-open-attempted',
      db_open_attempted: true,
      detail: './recued-server.db',
    });
  });

  it('classifies cheap, daemon, pair, audit, archive, upgrade, mcp, serve, and command profiles', () => {
    expect(classifyBootProfile({ version: true, mcp: false, subcommand: undefined })).toBe('none');
    expect(classifyBootProfile({ version: false, help: true, mcp: false, subcommand: undefined })).toBe('none');
    expect(classifyBootProfile({ version: false, mcp: false, subcommand: 'status' })).toBe('daemon');
    expect(classifyBootProfile({ version: false, mcp: false, subcommand: 'logs' })).toBe('daemon');
    expect(classifyBootProfile({ version: false, mcp: false, subcommand: 'auth-status' })).toBe('daemon');
    expect(classifyBootProfile({ version: false, mcp: false, subcommand: 'unlock' })).toBe('daemon');
    expect(classifyBootProfile({ version: false, mcp: false, subcommand: 'lock' })).toBe('daemon');
    expect(classifyBootProfile({ version: false, mcp: false, subcommand: 'pair' })).toBe('pair');
    expect(classifyBootProfile({ version: false, mcp: false, subcommand: 'audit' })).toBe('audit');
    expect(classifyBootProfile({ version: false, mcp: false, subcommand: 'llm' })).toBe('llm');
    expect(classifyBootProfile({ version: false, mcp: false, subcommand: 'archive' })).toBe('archive');
    // D-178 — `recued update` (the standalone check) profiles as 'update'.
    expect(classifyBootProfile({ version: false, mcp: false, subcommand: 'update' })).toBe('update');
    // D-178 slice 5 — legacy `upgrade` retired; falls through to 'command'.
    expect(classifyBootProfile({ version: false, mcp: false, subcommand: 'upgrade' })).toBe('command');
    expect(classifyBootProfile({ version: false, mcp: true, subcommand: undefined })).toBe('mcp');
    expect(classifyBootProfile({ version: false, mcp: false, subcommand: undefined })).toBe('serve');
    expect(classifyBootProfile({ version: false, mcp: false, subcommand: 'reindex' })).toBe('command');
  });

  it('does not import database, server, or composition modules', () => {
    const source = readFileSync(new URL('../cli/boot-trace.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/better-sqlite3/);
    expect(source).not.toMatch(/server\.js/);
    expect(source).not.toMatch(/composition\/bin/);
  });
});
