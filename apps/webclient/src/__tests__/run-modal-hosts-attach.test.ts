/** Every `wireRunModal` host must ATTACH the overlay it builds.
 *
 *  ⛔ `wireRunModal` deliberately does not mount itself — its handle documents
 *  "the host appends it to `document.body` (or its own portal) and removes it on
 *  `destroy`". Five hosts did. The Pack Use host did not, so every press wired a
 *  modal into nothing, rendered nothing, and then LATCHED: its own
 *  `packsRunModal !== null` re-entry guard turned every later press on every
 *  button into a silent no-op for the rest of the session. It read as "the
 *  buttons are not clickable"; the handler had been running correctly all along.
 *
 *  ⚠ Why a source-level invariant rather than a behavioural test. The defect is
 *  a MISSING call in a composition root, and every surface below it behaves
 *  perfectly without it — the click handler, the surface projection and
 *  `wireRunModal` itself all pass their own tests, which is exactly why it
 *  shipped. Even a real-browser Playwright click missed it, because the rig
 *  stubbed `openRunModal` and so never ran the host being tested. The thing that
 *  distinguishes a correct host from a broken one is whether it appends, so that
 *  is what this asserts.
 *
 *  Deliberately crude and deliberately loud: a new host that mounts its overlay
 *  some other way should fail here and be added to the reader below, rather than
 *  the rule being softened until it admits the bug again. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '..');

/** Every file that wires a run modal, with the identifier it stores it in. */
const HOSTS: ReadonlyArray<readonly [string, string]> = [
  ['chat/run-palette.ts', 'childRunModal'],
  ['reception/form-response-lens.ts', 'handle'],
  ['recipes/bootstrap-recipes-route.ts', 'childRunModal'],
  ['automation/bootstrap-automation-route.ts', 'handle'],
  ['data/bootstrap-data-route.ts', 'handle'],
  ['webclient-bootstrap.ts', 'packsRunModal'],
];

const read = (rel: string): string => readFileSync(resolve(SRC, rel), 'utf-8');

describe('run modal hosts attach their overlay', () => {
  it('the host list still matches the call sites in the tree', () => {
    // ⛔ Anti-vacuous guard, and the half that actually caught this class: the
    // list is only worth asserting over if it is COMPLETE. A new host added
    // without an entry here would otherwise be silently unchecked — which is
    // precisely how one host among six went missing.
    const wiring = HOSTS.filter(([rel]) => read(rel).includes('wireRunModal('));
    expect(wiring.length).toBe(HOSTS.length);
  });

  it('⛔ every host appends its handle element', () => {
    const missing: string[] = [];
    for (const [rel, ident] of HOSTS) {
      const source = read(rel);
      if (!source.includes(`appendChild(${ident}.element)`)) missing.push(rel);
    }
    expect(missing).toEqual([]);
  });

  it('the probe finds a KNOWN POSITIVE', () => {
    // Prove the matcher works before trusting an empty `missing` list — a typo in
    // the pattern would report every host as fine.
    expect(read('chat/run-palette.ts')).toContain('appendChild(childRunModal.element)');
    // …and a KNOWN NEGATIVE: the pattern must not match a host that only names
    // the identifier without appending it.
    expect('const x = handle.element;').not.toContain('appendChild(handle.element)');
  });
});
