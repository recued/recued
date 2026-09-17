/** D-148 — the rule that decides whether saving an address discards the tab.
 *
 *  ⛔ THIS FILE EXISTS BECAUSE THE RULE HAD NO TEST AT ALL. It lived inline in
 *  the boot, and every panel test injects its own convergence callback — so
 *  deleting the dirty-work guard entirely reddened NOTHING, in a suite with
 *  twenty-five cases about this feature. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { codeOf, codeNear } from '../../__tests__/helpers/source-text.js';

import { decideAddressChangeConvergence } from '../address-change-convergence.js';
import type { ServerSwitchWorkState } from '../server-switcher.js';

/** Every member of the union, written out so a new one fails to compile here
 *  rather than silently joining whichever branch the code happens to take. */
const ALL_WORK_STATES: ReadonlyArray<ServerSwitchWorkState> = [
  'clean',
  'chat_draft',
  'unsaved_changes',
  'in_flight',
  'in_flight_with_chat_draft',
  'in_flight_with_unsaved_changes',
];

describe('decideAddressChangeConvergence', () => {
  it('reloads a clean tab — the whole point of the feature', () => {
    expect(decideAddressChangeConvergence({ workState: 'clean', canReload: true, unloadWouldLoseWork: false }))
      .toBe('reloading');
  });

  it('⛔ defers for EVERY state that is not clean', () => {
    // A reload is a discard: an in-flight chat turn, an unsaved recipe or a
    // running execution goes with it. The address is already saved by the time
    // this is asked, so deferring costs a click and discarding costs the work.
    for (const workState of ALL_WORK_STATES.filter((s) => s !== 'clean')) {
      expect(
        decideAddressChangeConvergence({ workState, canReload: true, unloadWouldLoseWork: false }),
        `${workState} must not discard the tab`,
      ).toBe('deferred');
    }
  });

  it('defers when the host has no reload seam — absence is a configuration', () => {
    for (const workState of ALL_WORK_STATES) {
      expect(decideAddressChangeConvergence({ workState, canReload: false, unloadWouldLoseWork: false }))
        .toBe('deferred');
    }
  });

  it('⛔ defers when the UNLOAD GUARD would object, even on a clean tab', () => {
    // The two lists differed by two entries: approvalAttentionPopover and
    // drawerCreateOverlay in-flight work block an unload and are NOT part of
    // the switch work snapshot. Reloading into a native "Leave site?" dialog
    // the user can CANCEL leaves them on the old address with nothing said.
    expect(
      decideAddressChangeConvergence({
        workState: 'clean',
        canReload: true,
        unloadWouldLoseWork: true,
      }),
    ).toBe('deferred');
  });

  it('⛔ the boot feeds it the SAME predicate the unload guard uses', () => {
    // The defect was two hand-written lists of "is there work". Pinning that
    // there is now one, consulted by both.
    const boot = codeOf(resolve(import.meta.dirname, '..', '..', 'webclient-bootstrap.ts'));
    // ⚠ COUNT THE LIST MEMBERS, NOT THE HELPER'S NAME. A duplicated list is
    // the defect; a duplicate would not politely reuse the name, and a check
    // for `const unloadWouldLoseWork = ` appearing once misses a twin called
    // anything else. These two predicates are what the switch snapshot does
    // NOT cover, so each must appear exactly once in the whole file.
    for (const member of [
      'approvalAttentionPopover?.hasInFlightWork()',
      'drawerCreateOverlay?.hasInFlightWork()',
    ]) {
      expect(
        boot.split(member).length - 1,
        `${member} is listed more than once — the two lists can drift again`,
      ).toBe(1);
    }
    // …used by the unload guard…
    const guard = boot.slice(boot.indexOf('const onBeforeUnload'), boot.indexOf('const onBeforeUnload') + 400);
    expect(guard).toMatch(/unloadWouldLoseWork\(\)/);
    // …and CALLED by the address-change decision. ⚠ Anchored on the call:
    // `unloadWouldLoseWork: false` contains the name and passes a bare
    // `toContain`, which is how the first version of this survived its own
    // mutation. Third time this session.
    const wiring = boot.slice(boot.indexOf('onActiveAddressChanged:'), boot.indexOf('onActiveAddressChanged:') + 800);
    expect(wiring).toMatch(/unloadWouldLoseWork:\s*unloadWouldLoseWork\(\)/);
  });

  it('⛔ decides by equality to `clean`, never by a denylist of dirty states', () => {
    // A seventh member of the union must default to KEEPING the work, not to
    // discarding it because nobody remembered to extend a list.
    const source = readFileSync(
      resolve(import.meta.dirname, '..', 'address-change-convergence.ts'),
      'utf-8',
    );
    expect(source).toMatch(/workState === 'clean'/);
    for (const dirty of ALL_WORK_STATES.filter((s) => s !== 'clean')) {
      expect(source, `names ${dirty} explicitly — that is a denylist`)
        .not.toMatch(new RegExp(`workState[^\\n]*===[^\\n]*'${dirty}'`));
    }
  });

  it('⛔ the BOOT uses this rule rather than re-deriving it inline', () => {
    // The gap that produced this file: the policy was inline, so no test could
    // reach it. A copy drifting back into the boot would be the same defect.
    // ⚠ CODE ONLY — comments stripped. `toContain('decideAddressChangeConvergence')`
    // passed against the policy inlined with the name left in a comment, which
    // is the exact regression this pin exists to stop.
    const bootPath = resolve(import.meta.dirname, '..', '..', 'webclient-bootstrap.ts');
    const wiring = codeNear(bootPath, 'onActiveAddressChanged:', 600);
    expect(wiring).toMatch(/decideAddressChangeConvergence\(\{/);
    expect(wiring).toMatch(/workState:\s*currentServerSwitchWorkState\(\)/);
  });
});
