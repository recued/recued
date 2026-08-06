/** A setting written outside its table applies NOTHING and must say so.
 *
 *  ⛔ THE BUG THIS EXISTS FOR (2026-08-05). `"cloud.base_url" = …` written at
 *  the top level of a config file is valid TOML, resolves to a real schema key,
 *  and is silently discarded — `parseToml` only ever inspected keys already
 *  inside `[runtime]`, so it came back exactly as clean as a correct file. A
 *  live drive lost hours to it: the server stayed on the production cloud URL,
 *  its entitlement mint therefore failed against the wrong Worker, and Pro
 *  provisioning skipped — without one diagnostic anywhere in the chain.
 *
 *  The tolerance for UNRECOGNISED top-level sections is deliberate (plugins /
 *  later phases) and must survive, so the detection is keyed on "this resolves
 *  to a key the schema knows", not on "this is not a table I recognise".
 */

import { describe, expect, it } from 'vitest';

import { parseToml } from '../parse.js';

const KEY = 'cloud.base_url';
const VAL = 'https://api.recued2.com';

describe('misplaced settings', () => {
  it('flags a known runtime key written at the TOP LEVEL — the exact slip', () => {
    const { parsed, misplaced } = parseToml(`"${KEY}" = "${VAL}"\n`);
    // It genuinely did not apply…
    expect(parsed.runtime[KEY]).toBeUndefined();
    // …so it must be reported, and name the table it belongs under.
    expect(misplaced).toHaveLength(1);
    expect(misplaced[0]).toContain(KEY);
    expect(misplaced[0]).toContain('[runtime]');
  });

  it('flags the same key written as its own SECTION', () => {
    const { parsed, misplaced } = parseToml(`[cloud]\nbase_url = "${VAL}"\n`);
    expect(parsed.runtime[KEY]).toBeUndefined();
    expect(misplaced.join(' ')).toContain(KEY);
  });

  it('flags a bootstrap field outside [bootstrap]', () => {
    const { misplaced } = parseToml(`bind_port = 8080\n`);
    expect(misplaced).toHaveLength(1);
    expect(misplaced[0]).toContain('bind_port');
    expect(misplaced[0]).toContain('[bootstrap]');
  });

  it('says NOTHING when the key is correctly placed', () => {
    const { parsed, misplaced, unknown } = parseToml(`[runtime]\n"${KEY}" = "${VAL}"\n`);
    expect(parsed.runtime[KEY]).toBe(VAL);
    expect(misplaced).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it('still tolerates a genuinely unrecognised top-level section in silence', () => {
    // The forward-compat / plugin behaviour the parser documents. Widening the
    // detection to "any top-level key" would break this and bury the real
    // signal in noise.
    const { misplaced } = parseToml(
      `[someplugin]\nwhatever = 1\n\n"totally.made.up" = "x"\n`,
    );
    expect(misplaced).toEqual([]);
  });

  it('reports EVERY misplaced key, not just the first', () => {
    const { misplaced } = parseToml(
      `"${KEY}" = "${VAL}"\n"llm.free_pool_strategy" = "weighted"\n`,
    );
    expect(misplaced).toHaveLength(2);
    expect(misplaced.join(' ')).toContain('llm.free_pool_strategy');
  });

  it('keeps unknown-inside-[runtime] separate from misplaced', () => {
    const { unknown, misplaced } = parseToml(
      `[runtime]\n"not.a.real.key" = 1\n`,
    );
    // A typo inside the right table is UNKNOWN; it is not misplaced.
    expect(unknown).toContain('runtime.not.a.real.key');
    expect(misplaced).toEqual([]);
  });
});
