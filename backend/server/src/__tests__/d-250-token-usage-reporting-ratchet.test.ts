/** D-250 § D — every production LLM call site reports what it spent.
 *
 *  ⛔ WHY A SOURCE RATCHET AND NOT A REQUIRED FIELD. `onTokenUsage` is optional
 *  on `LLMExecutorDeps`, and that optionality is exactly how four call sites
 *  came to discard their tokens: housekeeping's two producers, the connection
 *  setup guide, and chat's recipe drafter. Making it required is the stronger
 *  fix and was measured as the wrong trade — 86 test call sites would each have
 *  to declare a sink for a property none of them assert, which buys noise, not
 *  coverage. The property that actually matters is about PRODUCTION code, so it
 *  is asserted against production code.
 *
 *  ⛔⛔ THE COUNT IS PINNED, AND THAT IS THE HALF THAT MAKES IT A RATCHET.
 *  Checking "every call site I found passes the hook" is satisfied by finding
 *  none — a sweep whose glob silently stops matching reports success. Pinning
 *  the number means a new call site, or a file moved out of the swept roots,
 *  fails loudly instead of vanishing.
 *  ⇒ [[feedback_a_zero_from_a_literal_grep_is_not_a_zero]]
 *
 *  ⚠ WHAT IT DOES NOT PROVE: that the hook is wired to something useful. A call
 *  site could pass `() => {}` and pass this test. That is covered where it can
 *  be — `d-250-run-token-usage.test.ts` drives a real run to the audit row, and
 *  the gateway's rollup has its own test. This one answers only "did anyone
 *  forget to ask the question", which is the failure that actually happened.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Roots that may contain a production provider call. ⚠ `packages/llm` is
 *  EXCLUDED: it DEFINES the hook and invokes it, so its own call sites are the
 *  implementation, not consumers of it. */
const ROOTS = ['backend/server/src', 'packages/ingredients/src'];

/** Call expressions that reach a provider and can report usage.
 *  ⚠ NOT `resolveLLMModelId` (resolves a match, never calls a provider — its
 *  deps `Pick` has no `onTokenUsage`) and NOT `transcribeAudio` (metered in
 *  audio duration, not tokens; `TranscribeDeps` has no such field). Both were
 *  checked; neither has tokens to report. */
const CALLS = ['executeLLM(', 'executeEmbedding('];

/** ⛔ UPDATE DELIBERATELY. A change here means a provider call site was added or
 *  removed; the reviewer's job is to confirm the new one reports its usage, not
 *  to make the number match. */
const EXPECTED_CALL_SITES = 11;

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'dist' || name === 'node_modules') continue;
      out.push(...walk(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
};

/** The argument list of the call starting at `from`, by balanced parens. */
const callArgs = (src: string, from: number): string => {
  const open = src.indexOf('(', from);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
};

interface Site {
  readonly file: string;
  readonly line: number;
  readonly reports: boolean;
}

const collect = (): Site[] => {
  const sites: Site[] = [];
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const src = readFileSync(file, 'utf8');
      for (const call of CALLS) {
        let idx = src.indexOf(call);
        while (idx !== -1) {
          // Skip imports/exports and DOC COMMENTS. ⚠ The comment filter is not
          // fastidiousness: `dispatch.ts` documents its own adapter table with
          // a literal `executeLLM(...)` line, and counting prose as a call site
          // would have made the pinned count describe something untrue.
          const lineStart = src.lastIndexOf('\n', idx) + 1;
          const line = src.slice(lineStart, src.indexOf('\n', idx));
          if (!/^\s*(import|export|\*|\/\/|\/\*)/.test(line)) {
            sites.push({
              file,
              line: src.slice(0, idx).split('\n').length,
              reports: callArgs(src, idx).includes('onTokenUsage'),
            });
          }
          idx = src.indexOf(call, idx + 1);
        }
      }
    }
  }
  return sites;
};

/** D-250 § D — where each file's provider spend GOES, declared.
 *
 *  ⛔ THE RATCHET ABOVE ONLY ASKS WHETHER SOMEONE PASSED THE HOOK. Passing
 *  `() => {}` satisfies it, and four of these files reached a sink that did
 *  nothing useful before this arc. Declaring the destination per file makes a
 *  new call site fail until someone SAYS where its tokens land, which is the
 *  decision that was skipped every time this went wrong.
 *
 *  - `counter` — `llm_config`'s `usage.<YYYY-MM-DD>`, the owner's daily budget
 *    input (`isOverBudget`). A running total, no attribution.
 *  - `record`  — a durable, attributed row: the run anchor, the
 *    `chat_message_sent` activity, the `housekeeping_cycle` row's `per_task`,
 *    or the seller usage rollup.
 *
 *  ⚠ `ports/llm-gateway` IS DELIBERATELY NOT ON THE COUNTER, and that is the
 *  entry most likely to be "fixed" by someone reading this list. Gateway spend
 *  is REVENUE-generating: a customer paid for it. The daily counter caps the
 *  OWNER's discretionary spend, so folding customer work into it would let a
 *  paying customer exhaust the ceiling and shut off the owner's own automation.
 *  Its record is the seller rollup, which is per-contract and is what pricing
 *  reads. Leave it off. */
const DESTINATIONS: Readonly<Record<string, ReadonlyArray<'counter' | 'record'>>> = {
  'backend/server/src/server-executor.ts': ['counter', 'record'],
  'backend/server/src/composition/bin/wire-chat-orchestrator.ts': ['counter', 'record'],
  'backend/server/src/composition/bin/wire-llm-substrate.ts': ['counter', 'record'],
  'backend/server/src/composition/bin/wire-reception-compose-propose.ts': ['counter'],
  'backend/server/src/serve/compose-listeners.ts': ['counter'],
  'backend/server/src/serve/compose-app-context.ts': ['counter'],
  'backend/server/src/ports/llm-gateway/handler.ts': ['record'],
};

describe('D-250 § D — every call site has a DECLARED destination', () => {
  it('⛔⛔ NO UNDECLARED FILE SPENDS TOKENS', () => {
    const files = [...new Set(collect().map((s) => s.file))].sort();
    // A new file here means a new provider call site: say where its tokens go
    // before adding it, rather than adding it to make the test pass.
    expect(files).toEqual(Object.keys(DESTINATIONS).sort());
  });

  it('⚠ every declared destination is non-empty — "nowhere" is not a choice', () => {
    const empty = Object.entries(DESTINATIONS)
      .filter(([, dests]) => dests.length === 0)
      .map(([file]) => file);
    expect(empty).toEqual([]);
  });
});

describe('D-250 § D — no production LLM call spends uncounted', () => {
  it('⛔ THE SWEEP FOUND CALL SITES AT ALL — a zero here is a broken glob', () => {
    // Reported as a COUNT, not a boolean: an extraction bug and a clean bill of
    // health are indistinguishable from the outside unless the check says what
    // it FOUND.
    const sites = collect();
    expect(sites.length).toBe(EXPECTED_CALL_SITES);
  });

  it('⛔⛔ EVERY ONE OF THEM PASSES `onTokenUsage`', () => {
    const silent = collect().filter((s) => !s.reports);
    // Named, not counted — a failure must say WHICH call site forgot.
    expect(silent.map((s) => `${s.file}:${s.line}`)).toEqual([]);
  });
});
