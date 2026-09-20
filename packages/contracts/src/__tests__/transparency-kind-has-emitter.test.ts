/** ⛔⛔ TWO TRANSPARENCY KINDS ARE FULLY DECLARED AND NEVER EMITTED.
 *
 *  `engine.catalog_assembled` and `engine.gate_short_circuit` carry a type, a
 *  redaction tier, a render template, an entry in the ordering set, a phase
 *  mapping and a `switch` case — everything except a producer. D-164 P6.7
 *  *"retired the matching transparency event kinds … replacing them with the
 *  prompt-cache main-turn kinds `engine.gate_short_circuit` and
 *  `engine.catalog_assembled`"* (`index.ts`). The retirement landed, the
 *  replacement DECLARATIONS landed, the replacement EMITTERS did not.
 *
 *  🔑 WHAT IT COSTS, WHICH IS NOT "A MISSING LOG LINE". `chat-context-budget.ts`
 *  cites this event as the way to see a catalog step-down that, in its own
 *  words, *"STEPS DOWN PAST AN EXPLICIT OWNER SETTING, deliberately"*:
 *  *"the step-down is observable — `lean-core` drops the Tier-2 listing
 *  entirely, so `engine.catalog_assembled`'s section counts and the plan IR's
 *  `tier2_selected_count` both move"*. Only the second of those moves. The
 *  owner's `full` preference is overridden and the stated evidence is absent.
 *
 *  ⚠ FOUND BY A LIVE CHAT DRIVE, not by reading. `horizon-audit/chat-long-run.ts`
 *  prints `catalog=?` on every turn, and that field exists precisely because
 *  *"three catalog configurations produced a byte-identical `input_tokens`, and
 *  'the knob did nothing' and 'the catalog is not the dominant term' look the
 *  same from the token count alone."* The measurement that would tell them apart
 *  cannot populate.
 *
 *  ⚠ THE TWO ARE LISTED, NOT SKIPPED. A hand-written exception to a generic rule
 *  is the bug report: the list is the finding, and a THIRD kind losing its
 *  emitter fails here rather than joining a quiet pattern. Delete an entry when
 *  its emitter lands.
 *
 *  ⚠ AND THE SCAN LOOKS FOR A CONSTRUCTION, NOT A MENTION. A first pass that
 *  grepped the kind string "found" it — in the type declaration and three test
 *  fixtures — and nearly produced the opposite conclusion. */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
/** Where a producer may live. Contracts itself declares; it does not emit. */
const EMITTER_ROOTS = ['backend/server/src', 'packages/engine/src', 'packages/middleware/src'];

/** Known-missing, with the reason. NOT a skip list — see the header. */
const NO_EMITTER_YET: ReadonlyMap<string, string> = new Map([
  ['engine.catalog_assembled', 'D-164 P6.7 declared it as a replacement kind; the emitter was never written'],
  ['engine.gate_short_circuit', 'same D-164 P6.7 slice, same gap'],
]);

const walk = (dir: string, out: string[]): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
};

/** Every `engine.*` kind the contracts union declares. Read from the ordering
 *  set, which is a runtime array — so this cannot drift from the vocabulary. */
const declaredEngineKinds = (): string[] => {
  const src = readFileSync(join(REPO, 'packages/contracts/src/transparency-stream/events.ts'), 'utf8');
  return [...new Set([...src.matchAll(/'(engine\.[a-z_]+)'/g)].map((m) => m[1]!))].sort();
};

/** A kind is EMITTED when production code constructs an object literal with it
 *  as `kind:`. A bare mention — a switch case, a policy map, a comment — is not
 *  a producer, which is the distinction the first pass of this got wrong. */
const emitterCount = (kind: string, files: readonly string[]): number => {
  const needle = new RegExp(`kind:\\s*'${kind.replace('.', '\\.')}'`);
  return files.filter((f) => needle.test(readFileSync(f, 'utf8'))).length;
};

describe('every declared transparency kind has a producer', () => {
  const files = EMITTER_ROOTS.flatMap((r) => walk(join(REPO, r), []));
  const kinds = declaredEngineKinds();

  it('the scan reads the vocabulary and the tree', () => {
    // ⛔ Floors on both sides: a kind list that came back empty, or a file walk
    //   that found nothing, would make every assertion below vacuous.
    expect(kinds.length).toBeGreaterThanOrEqual(5);
    expect(files.length).toBeGreaterThan(300);
  });

  it('no kind BEYOND the known-missing two lacks a producer', () => {
    const missing = kinds
      .filter((k) => emitterCount(k, files) === 0)
      .filter((k) => !NO_EMITTER_YET.has(k));
    expect(
      missing,
      `declared but never emitted:\n${missing.map((k) => `  ${k}`).join('\n')}\n`
        + 'A kind with a template, a redaction tier and a switch case still shows '
        + 'a user nothing if no code constructs it.',
    ).toEqual([]);
  });

  it('the known-missing two are still missing — delete the entry when fixed', () => {
    // ⚠ Asserting the CURRENT state, so the list cannot rot into a permanent
    //   exemption. When an emitter lands this goes red and says so.
    for (const [kind, why] of NO_EMITTER_YET) {
      expect(
        emitterCount(kind, files),
        `${kind} now has a producer (${why}) — delete its NO_EMITTER_YET entry`,
      ).toBe(0);
    }
  });

  it('MUTATION: the scan distinguishes a producer from a mention', () => {
    // ⚠ The whole check turns on this. `engine.decoder_unavailable` is emitted
    //   and reaches the live harness; `engine.catalog_assembled` appears in just
    //   as many files and reaches nobody.
    expect(emitterCount('engine.decoder_unavailable', files)).toBeGreaterThan(0);
    expect(emitterCount('engine.catalog_assembled', files)).toBe(0);
  });
});
