/** Every "Settings → Server → X" in shipped copy names a tab that exists.
 *
 *  ⛔⛔ WHY THIS EXISTS. Four breadcrumbs in shipped error copy pointed at
 *  destinations a reader could not find:
 *
 *    — "use Reachability Doctor to see if the cloud is having trouble" — a tab
 *      deleted when the reachability report went.
 *    — "Settings → Server → Domains" and "Settings → Server → Pro DDNS" —
 *      SECTIONS inside Hostnames, never tabs.
 *    — "Settings → Server → DDNS → Unbind" — a control that exists on NO
 *      surface: `pro_acme.unbind` is a live rpc with no caller in the
 *      webclient, the CLI or the dashboard.
 *
 *  🔑 NONE OF IT FAILED LOUDLY. No red test, no console error, no broken link —
 *  the reader looks, does not find it, and the error message has spent the one
 *  thing an error message is for. Copy is prose: it has no import edge, so no
 *  changed-file test subset can ever select it, and a type system has nothing to
 *  check. A ratchet reading the strings is the only instrument that sees this.
 *
 *  ⚠ IT GATES THE TAB NAME, NOT THE ADVICE. "Settings → Server → Hostnames,
 *  under 'Your Pro web address'" passes because Hostnames is real; whether that
 *  section is still called that is beyond what this can know. Green here is
 *  necessary, not sufficient.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SERVER_SUBTAB_LABELS } from '../settings/bootstrap-settings-route.js';

const SETTINGS_DIR = resolve(import.meta.dirname, '..', 'settings');

/** A line that is prose ABOUT the code rather than text shown to a reader.
 *
 *  ⛔⛔ COMMENTS ARE OUT OF SCOPE STRUCTURALLY, NOT BY EXEMPTION — AND THE FIRST
 *  REASON GIVEN HERE WAS THE WEAK ONE. It used to say folding comments in would
 *  need a dozen exemptions, because the reception family's headers still named a
 *  Settings location Reception had left. Those were all fixed on 2026-09-16, so
 *  that reason expired. The real one does not:
 *
 *  🔑 A COMMENT'S JOB MAY BE TO NAME THE DEAD THING. Six comments in this tree
 *  quote a retired breadcrumb on purpose — "⚠ said Settings → Server →
 *  Housekeeping until 2026-09-16", "there is no DDNS → Unbind". A rule that
 *  forbids writing a dead name forbids RECORDING THAT IT DIED, which is the one
 *  note that stops the next reader re-deriving it. Shipped copy has no such use:
 *  naming a destination that is not there is never correct there.
 *
 *  ⇒ The harms differ too. A stale comment misleads a developer, who has the
 *  code. Stale copy misleads a user at the moment something already went wrong,
 *  when the message is all they have. */
const isComment = (line: string): boolean => {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
};

const settingsLines = function* (): Generator<{ file: string; line: number; text: string }> {
  for (const name of readdirSync(SETTINGS_DIR)) {
    if (!name.endsWith('.ts')) continue;
    const text = readFileSync(resolve(SETTINGS_DIR, name), 'utf-8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (isComment(line)) continue;
      yield { file: name, line: i + 1, text: line };
    }
  }
};

/** Every `Settings → Server → …` in shipped copy, with the text that follows it.
 *
 *  ⚠ READS THE FILES, not the copy maps. A breadcrumb can live in any string in
 *  any module, and enumerating the maps would only ever check the ones someone
 *  remembered to enumerate — the same blind spot that let four of these ship. */
const breadcrumbs = (): Array<{ file: string; rest: string; line: number }> => {
  const out: Array<{ file: string; rest: string; line: number }> = [];
  for (const { file, line, text } of settingsLines()) {
    for (const m of text.matchAll(/Settings → Server → (.*)$/g)) {
      out.push({ file, rest: m[1]!, line });
    }
  }
  return out;
};

describe('shipped copy may only name Server tabs that exist', () => {
  const labels = new Set<string>(Object.values(SERVER_SUBTAB_LABELS));

  it('⚠ the sweep actually finds breadcrumbs — a zero here would be vacuous', () => {
    // ⛔ THE GUARD ON THE GUARD. Every assertion below is over a list, so an
    // empty list passes them all. The regex, the directory and the comment
    // filter are each one edit from producing nothing.
    expect(breadcrumbs().length).toBeGreaterThan(2);
  });

  it('⛔ every one names a real tab', () => {
    // ⚠ STARTS-WITH, NOT EQUALS. A breadcrumb is followed by the rest of a
    // sentence — "…→ Hostnames, under 'Your Pro web address'" — so requiring the
    // captured segment to EQUAL a label would fail every useful message and pass
    // only bare ones. What must be true is that the words immediately after the
    // arrow are a tab's name.
    const bad = breadcrumbs().filter(
      (b) => ![...labels].some((label) => b.rest.startsWith(label)),
    );
    expect(
      bad.map((b) => `${b.file}:${String(b.line)} → "${b.rest.slice(0, 40)}…"`),
      'a breadcrumb naming something that is not a Server tab sends the reader nowhere',
    ).toEqual([]);
  });

  it('⛔ and no copy names the deleted Reachability tab', () => {
    // Its own rule rather than a breadcrumb case: the tab was referred to by
    // NAME ("use Reachability Doctor…"), not as a Settings path, so the pattern
    // above would not have caught it.
    const offenders = [...settingsLines()]
      .filter((l) => /Reachability Doctor/.test(l.text))
      .map((l) => `${l.file}:${String(l.line)}`);
    expect(offenders).toEqual([]);
  });
});
