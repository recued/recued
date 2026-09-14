/** D-269 — which datetime pickers owe the owner a "which clock?" sentence.
 *
 *  ⛔⛔ THE DISCRIMINATOR IS NOT "IS IT A DATETIME", IT IS "DOES THE SERVER'S
 *  CLOCK DECIDE ANYTHING THE OWNER WOULD WANT TO CHECK". Applying it
 *  mechanically to every picker would add lines nobody can act on, and a
 *  settings page full of those is one nobody reads.
 *
 *  ⚠ ALL FIVE ARE NAMED HERE, WITH THEIR VERDICT — not counted. A count fails
 *  the moment anyone adds a picker and says nothing about WHICH one is wrong;
 *  and the two that need no line need it recorded, or the next person re-derives
 *  the same argument from scratch. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');

describe('D-269 — the pickers that DO owe a disclosure', () => {
  /** ⚠ ASSERTS THE CALL, NOT THE NAME. The first version matched
   *  `toContain('describePickedInstantOnServer')`, which the IMPORT LINE
   *  satisfies — so deleting the actual use left the test green. A helper that
   *  is imported and never called is exactly the defect this file exists to
   *  catch. */
  const callsDisclosure = (src: string): boolean =>
    /describePickedInstantOnServer\(\s*\n?\s*picked/.test(src);

  it('⛔ a scheduled recipe run — the server executes it, so its clock is checkable', () => {
    expect(callsDisclosure(read('packages/ui-shared/src/run-modal/render.ts'))).toBe(true);
  });

  it('⛔ a scheduled mail send — the server dispatches it', () => {
    expect(callsDisclosure(read('packages/ui-shared/src/mail-compose/dialog.ts'))).toBe(true);
    // And the zone is SUPPLIED, from the same thunk the activation stamp uses,
    // so the line the owner reads cannot disagree with the row that is written.
    expect(read('apps/webclient/src/mail/mail-compose-host.ts'))
      .toContain('serverTimeZone: z');
  });
});

describe('D-269 — the pickers that do NOT, and why', () => {
  it('⚠ the pre-approval bound already says "(your time)" — a simpler, better answer', () => {
    // It is a BOUND ("run before X"), not a scheduled moment, and someone had
    // already thought about the clock. Adding a server line would be a second,
    // competing statement about the same field.
    expect(read('apps/webclient/src/approvals/preapproval-activation.ts'))
      .toContain('(your time)');
  });

  it('⛔ a booking slot is a REAL-WORLD appointment, not something the server runs', () => {
    // "New start" is when the dentist sees you. The server only REMINDS about
    // it, at `slot_start_at - offset`, which is absolute arithmetic — its zone
    // never enters. A server-clock line here would be true and useless.
    const src = read('apps/webclient/src/data/bootstrap-data-route.ts');
    // ⚠ SOURCE-TEXT BY NECESSITY, NOT BY HABIT. This is an ABSENCE / CENSUS
    // claim — "no other picker does this", "the old body is gone" — and no
    // behavioural drive can prove a thing does not exist elsewhere in a tree.
    // This is the one category where the form is the right tool. See REV 21.
    expect(src).toContain('reschedule-input');
    expect(src).not.toContain('describePickedInstantOnServer');
  });

  it('⛔ a reception form field is VISITOR-facing — the owner\'s server is not its subject', () => {
    const src = read('packages/ui-shared/src/form-renderer/render.ts');
    expect(src).toContain('datetime-local');
    expect(src).not.toContain('describePickedInstantOnServer');
  });
});

describe('D-269 — and the census is complete', () => {
  it('⛔ every `datetime-local` in the client trees is one of the five named above', () => {
    // ⚠ NAMED, NOT COUNTED. A sixth picker should fail this with its own path in
    // the diff, so whoever adds it decides which side it falls on rather than
    // inheriting a default.
    const roots = [
      'apps/webclient/src/approvals/preapproval-activation.ts',
      'apps/webclient/src/data/bootstrap-data-route.ts',
      'packages/ui-shared/src/run-modal/render.ts',
      'packages/ui-shared/src/mail-compose/dialog.ts',
      'packages/ui-shared/src/form-renderer/render.ts',
    ];
    for (const rel of roots) expect(read(rel)).toContain('datetime-local');
  });
});
