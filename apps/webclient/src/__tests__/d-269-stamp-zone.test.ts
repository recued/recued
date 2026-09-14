/** D-269 step 1 — the durable stamps carry the SERVER's zone, not the browser's.
 *
 *  ⛔⛔ WHAT WAS WRONG. Three surfaces wrote a zone into rows the SERVER later
 *  evaluates — a saved-view alert (frozen at first enable), a scheduled mail
 *  send and a scheduled recipe run (re-stamped every time) — and all three took
 *  it from `Intl.DateTimeFormat().resolvedOptions().timeZone`, i.e. whichever
 *  browser happened to be open. An alert switched on from a laptop abroad
 *  carried the travel zone for good.
 *
 *  🔑 THE TEST THAT MATTERS IS THE SWEEP, NOT THE UNIT. Each call site is one
 *  line and a unit test per line proves only that I edited the line I edited.
 *  What can regress is a FOURTH stamp appearing, so the last test counts the
 *  idiom across the tree and names the two places it is still correct. */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stampZone } from '@recued/ui-shared';

describe('D-269 — stampZone', () => {
  it('prefers the server zone, because the row is evaluated server-side', () => {
    expect(stampZone(() => 'Asia/Hong_Kong')).toBe('Asia/Hong_Kong');
    expect(stampZone('Asia/Hong_Kong')).toBe('Asia/Hong_Kong');
  });

  it('⚠ falls back to the browser rather than writing nothing', () => {
    // A pre-D-269 server answers `not_configured`, and the host's one fetch can
    // simply not have landed when a click handler fires. The field is required,
    // so an empty zone would fail the write — today's value is strictly better
    // than no value, and it is exactly what every caller did before.
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(stampZone(undefined)).toBe(browser);
    expect(stampZone(() => undefined)).toBe(browser);
    expect(stampZone(() => '')).toBe(browser);
  });
});

/** Walk the client trees. ⚠ `src` only — `dist` holds stale compiled copies and
 *  would make the sweep report matches nobody can edit. */
const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
};

describe('D-269 — the browser-zone idiom is accounted for, file by file', () => {
  it('⛔ every remaining `Intl…resolvedOptions().timeZone` is one of the two CORRECT ones', () => {
    const roots = [
      join(process.cwd(), 'apps/webclient/src'),
      join(process.cwd(), 'packages/ui-shared/src'),
    ];
    const hits: string[] = [];
    for (const root of roots) {
      for (const file of walk(root)) {
        const src = readFileSync(file, 'utf8');
        if (src.includes('resolvedOptions().timeZone')) {
          hits.push(file.slice(process.cwd().length + 1));
        }
      }
    }

    // ⚠ NAMED, NOT COUNTED. A bare count is a ratchet against colleagues — it
    // fails when anyone adds an unrelated file and says nothing about WHICH
    // reading is wrong. These two are the readings that SHOULD stay:
    //
    //  · the chat route — D-193's per-turn `time_zone`. That answers "what time
    //    is it WHERE I AM", and a connected browser is live evidence of it, so
    //    the browser's zone is the right answer there and the server's is not.
    //    ⛔ Do not "unify" it with the stamps; they disagree on purpose.
    //  · two-clock.ts — the fallback implementations themselves (`stampZone`
    //    and the preview's own client-zone default). This is where the reading
    //    is supposed to live, exactly once.
    expect(hits.sort()).toEqual([
      'apps/webclient/src/chat/bootstrap-chat-route.ts',
      'packages/ui-shared/src/two-clock.ts',
    ]);
  });

  it('🔑 the three durable stamps now read stampZone', () => {
    // The complement of the sweep above: proving the idiom is gone is only half
    // of it, since deleting the line would also pass. These assert the
    // replacement actually landed at each site.
    for (const [file, needle] of [
      ['apps/webclient/src/data/saved-data-route.ts', 'stampZone(opts.serverTimeZone)'],
      ['apps/webclient/src/mail/mail-compose-host.ts', 'stampZone(deps.serverTimeZone)'],
      ['packages/ui-shared/src/run-modal/wire.ts', 'stampZone(opts.serverTimeZone)'],
    ] as const) {
      expect(readFileSync(join(process.cwd(), file), 'utf8')).toContain(needle);
    }
  });

  it('⛔ and the value is SUPPLIED, not merely accepted — the declared-not-backed trap', () => {
    // Every `serverTimeZone` option is optional and falls back to the browser,
    // so a missing supplier is INVISIBLE: the stamps keep working and keep
    // being wrong. This pins that the composition root actually passes it.
    const boot = readFileSync(
      join(process.cwd(), 'apps/webclient/src/webclient-bootstrap.ts'),
      'utf8',
    );
    expect(boot).toContain('const getServerTimeZone = ()');
    // One supplier per surface that owns a stamp, plus the routes that forward
    // to a run modal.
    const supplied = boot.split('serverTimeZone: getServerTimeZone').length - 1;
    expect(supplied).toBeGreaterThanOrEqual(6);
  });
});
