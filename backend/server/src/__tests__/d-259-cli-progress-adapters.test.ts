import { describe, expect, it } from 'vitest';

import { createCliProgressAdapter } from '../execution/cli-progress-adapters.js';

describe('D-259 semantic CLI progress adapters', () => {
  it('keeps stdout/stderr line framing separate while sharing yt-dlp monotonic state', () => {
    const adapter = createCliProgressAdapter('yt-dlp-progress');

    expect(adapter.push(Buffer.from('[download] 10'), 'stdout')).toBe(0);
    // An interleaved diagnostic must not splice into stdout's partial line.
    expect(adapter.push(Buffer.from('warning: retrying\n'), 'stderr')).toBe(0);
    expect(adapter.push(Buffer.from('.0% of 1MiB\n'), 'stdout')).toBe(1);
    // A duplicate percentage on the other stream is still the same semantic
    // unit, not a second heartbeat.
    expect(adapter.push(Buffer.from('[download] 10.0% of 1MiB\n'), 'stderr')).toBe(0);
    expect(adapter.push(Buffer.from('[download] 11.0% of 1MiB\n'), 'stderr')).toBe(1);
    expect(adapter.end()).toBe(0);
  });

  it('counts only completed Codex units, not arbitrary JSONL output', () => {
    const adapter = createCliProgressAdapter('codex-jsonl');
    expect(adapter.push(Buffer.from('{"type":"item.started","item":{"id":"a"}}\n'))).toBe(0);
    expect(adapter.push(Buffer.from('{"type":"item.completed","item":{"id":"a"}}\n'))).toBe(1);
    expect(adapter.push(Buffer.from('{"type":"item.completed","item":{"id":"a"}}\n'))).toBe(0);
    expect(adapter.push(Buffer.from('{"type":"turn.completed"}'))).toBe(0);
    expect(adapter.end()).toBe(1);
  });

  it('decodes JSONL across split UTF-8 code points and suppresses repeated terminal records', () => {
    const adapter = createCliProgressAdapter('codex-jsonl');
    const row = Buffer.from('{"type":"item.completed","item":{"id":"café"}}\n');
    const codePoint = row.indexOf(Buffer.from('é'));

    expect(adapter.push(row.subarray(0, codePoint + 1), 'stdout')).toBe(0);
    expect(adapter.push(row.subarray(codePoint + 1), 'stdout')).toBe(1);
    expect(adapter.push(Buffer.from('{"type":"turn.completed"}\n'), 'stdout')).toBe(1);
    expect(adapter.push(Buffer.from('{"type":"turn.completed"}\n'), 'stdout')).toBe(0);
    expect(adapter.push(Buffer.from('{"type":"turn.failed"}\n'), 'stdout')).toBe(0);
    expect(adapter.end()).toBe(0);
  });

  it('bounds an unterminated record and resumes only after its delimiter', () => {
    const adapter = createCliProgressAdapter('yt-dlp-progress');
    expect(adapter.push(Buffer.alloc(1024 * 1024 + 1, 'x'))).toBe(0);
    // This valid-looking suffix is still part of the discarded oversized row.
    expect(adapter.push(Buffer.from('[download] 50.0% of 1MiB'))).toBe(0);
    // The newline ends the discarded row; the next complete record is eligible.
    expect(adapter.push(Buffer.from('\n[download] 51.0% of 1MiB\n'))).toBe(1);
    expect(adapter.end()).toBe(0);
  });
});
