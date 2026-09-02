import { describe, expect, it } from 'vitest';
import { isDockerArtifact, MANIFEST_SCHEMA_VERSION, ManifestError, parseManifest } from '../manifest.js';

/** ONE description of a well-formed manifest, and everything else is a mutation
 *  of it. Two fixtures grew here — a string-returning `valid()` and an
 *  object-returning `good()` added alongside it — describing the same shape with
 *  different values, so a field tightened against one could stay untested against
 *  the other. `wellFormed()` is the object; `valid()` is its serialisation. */
const wellFormed = () => ({
  schema_version: 1,
  sequence: 184,
  expires_at: '2026-07-16T10:00:00Z',
  min_launcher_version: 1,
  channels: {
    stable: {
      version: '1.4.2',
      released_at: '2026-07-02T10:00:00Z',
      min_supported: '1.2.0',
      migration: true,
      rollout_pct: 100,
      notes_url: 'https://recued.com/releases/1.4.2',
      artifacts: {
        'linux-x64': { url: 'https://x/l', sha256: 'aa', sig: 'ss' },
        'docker-thin': { image: 'recued/recued:managed', digest: `sha256:${'d'.repeat(64)}` },
      },
    },
    edge: {
      version: '1.5.0', released_at: '2026-07-03T10:00:00Z', min_supported: '1.2.0',
      migration: false, rollout_pct: 25, notes_url: '', artifacts: { 'linux-x64': { url: 'u', sha256: 'a', sig: 's' } },
    },
  },
});

const valid = (): string => JSON.stringify(wellFormed());

describe('parseManifest', () => {
  it('parses a well-formed manifest', () => {
    const m = parseManifest(valid());
    expect(m.sequence).toBe(184);
    expect(m.channels.stable?.version).toBe('1.4.2');
    expect(m.channels.stable?.migration).toBe(true);
    expect(m.channels.edge?.rollout_pct).toBe(25);
  });

  it('⛔ refuses a version the comparator would COERCE rather than order', () => {
    // Each of these reached `compareVersions`, became a number, and silently
    // mis-ordered. `26.9.1.0` / `26.9.1.dev` / `26.9.1.1.1` compare EQUAL to the
    // release they should supersede (a release that is invisible, D-258's exact
    // failure arriving through the parser); `1.5.0-rc1` compares EQUAL to
    // `1.5.0`, and a trailer one segment further right compares NEWER — so a
    // prerelease would install OVER the final release.
    //
    // ⚠ This fixture itself carried `1.5.0-rc1` as the edge version until the
    // grammar landed: the placeholder was an instance of the defect.
    const withVersion = (v: string): string => {
      const m = JSON.parse(valid());
      m.channels.stable.version = v;
      return JSON.stringify(m);
    };
    for (const bad of ['26.9.1.0', '26.9.1.dev', '26.9.1.1.1', '26.9.1-rc.1', '1.5.0-rc1', '26.09.1', '26.9']) {
      expect(() => parseManifest(withVersion(bad)), bad).toThrow(ManifestError);
    }
    for (const ok of ['26.9.1', '26.9.1.1', '1.4.2', '0.2.0']) {
      expect(() => parseManifest(withVersion(ok)), ok).not.toThrow();
    }
  });

  it('⛔ holds min_supported to the same grammar — a malformed floor is a malformed gate', () => {
    // `min_supported` decides who is LOCKED OUT of updating, so a value the
    // comparator coerces is a gate that admits or excludes the wrong fleet.
    const withFloor = (v: string): string => {
      const m = JSON.parse(valid());
      m.channels.stable.min_supported = v;
      return JSON.stringify(m);
    };
    expect(() => parseManifest(withFloor('26.8.12.0'))).toThrow(ManifestError);
    expect(() => parseManifest(withFloor('26.8.12.dev'))).toThrow(ManifestError);
    expect(() => parseManifest(withFloor('26.8.12'))).not.toThrow();
    expect(() => parseManifest(withFloor('26.8.12.1'))).not.toThrow();
  });

  it('⛔ a docker digest must be a DIGEST, not a non-empty string', () => {
    // The pull is digest-anchored precisely so the image cannot be swapped under
    // a tag (I-2, rev 2) — and `reqEntryStr` accepted the literal
    // `sha256:REPLACE_WITH_REAL_DIGEST` that `release.config.example.json`
    // shipped, exactly as readily as a real one. A manifest naming an unpullable
    // image is a channel that fails at apply time, on every server, after the
    // release is irreversible.
    const withDigest = (digest: unknown): string => {
      const m = wellFormed();
      (m.channels.stable.artifacts as Record<string, Record<string, unknown>>)['docker-thin'] =
        { image: 'recued/server:1.4.2', digest } as Record<string, unknown>;
      return JSON.stringify(m);
    };
    for (const bad of ['sha256:REPLACE_WITH_REAL_DIGEST', 'sha256:abc', 'latest',
                       `sha256:${'A'.repeat(64)}`, `sha256:${'d'.repeat(63)}`, '']) {
      expect(() => parseManifest(withDigest(bad)), JSON.stringify(bad)).toThrow(ManifestError);
    }
    expect(() => parseManifest(withDigest(`sha256:${'d'.repeat(64)}`))).not.toThrow();
  });

  it('exposes docker artifacts as digest-anchored', () => {
    const m = parseManifest(valid());
    const thin = m.channels.stable?.artifacts['docker-thin'];
    expect(thin && isDockerArtifact(thin)).toBe(true);
    const bin = m.channels.stable?.artifacts['linux-x64'];
    expect(bin && isDockerArtifact(bin)).toBe(false);
  });

  it('ignores unknown fields (forward-compat I-9)', () => {
    const m = parseManifest(JSON.stringify({ ...JSON.parse(valid()), future_field: { whatever: 1 } }));
    expect(m.sequence).toBe(184);
  });

  it('refuses a newer schema_version', () => {
    const bad = JSON.parse(valid());
    bad.schema_version = MANIFEST_SCHEMA_VERSION + 1;
    expect(() => parseManifest(JSON.stringify(bad))).toThrow(ManifestError);
  });

  it('rejects malformed JSON, missing fields, bad rollout, and no channels', () => {
    expect(() => parseManifest('{')).toThrow(ManifestError);
    const noSeq = JSON.parse(valid()); delete noSeq.sequence;
    expect(() => parseManifest(JSON.stringify(noSeq))).toThrow(/sequence/);
    const badRollout = JSON.parse(valid()); badRollout.channels.stable.rollout_pct = 150;
    expect(() => parseManifest(JSON.stringify(badRollout))).toThrow(/rollout_pct/);
    const noChan = JSON.parse(valid()); noChan.channels = {};
    expect(() => parseManifest(JSON.stringify(noChan))).toThrow(/no known channels/);
  });

  it('rejects a binary artifact missing its detached signature (integrity boundary)', () => {
    const m = JSON.parse(valid());
    delete m.channels.stable.artifacts['linux-x64'].sig;
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/artifact "linux-x64" missing "sig"/);
  });

  it('rejects a docker artifact missing its pinned digest', () => {
    const m = JSON.parse(valid());
    delete m.channels.stable.artifacts['docker-thin'].digest;
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/missing "digest"/);
  });

  it('ignores unknown artifact kinds (forward-compat)', () => {
    const m = JSON.parse(valid());
    m.channels.stable.artifacts['flatpak-x64'] = { whatever: true };
    expect(() => parseManifest(JSON.stringify(m))).not.toThrow();
  });

  it('requires migration to be an explicit boolean', () => {
    const missing = JSON.parse(valid()); delete missing.channels.stable.migration;
    expect(() => parseManifest(JSON.stringify(missing))).toThrow(/migration/);
    const stringy = JSON.parse(valid()); stringy.channels.stable.migration = 'true';
    expect(() => parseManifest(JSON.stringify(stringy))).toThrow(/migration/);
  });

  // D-152 § A.16 — the arch-neutral webclient artifact (a binary-shaped
  // {url,sha256,sig}, keyed `webclient`).
  it('parses a webclient artifact + exposes it as a non-docker binary artifact', () => {
    const m = JSON.parse(valid());
    m.channels.stable.artifacts.webclient = { url: 'https://x/wc', sha256: 'ww', sig: 'wsig' };
    const parsed = parseManifest(JSON.stringify(m));
    const wc = parsed.channels.stable?.artifacts.webclient;
    expect(wc).toEqual({ url: 'https://x/wc', sha256: 'ww', sig: 'wsig' });
    expect(wc && isDockerArtifact(wc)).toBe(false);
  });

  it('accepts a manifest with no webclient artifact (binaries-only, backward-compat)', () => {
    const parsed = parseManifest(valid());
    expect(parsed.channels.stable?.artifacts.webclient).toBeUndefined();
  });

  it('rejects a webclient artifact missing its sig (the integrity boundary)', () => {
    const m = JSON.parse(valid());
    m.channels.stable.artifacts.webclient = { url: 'https://x/wc', sha256: 'ww' }; // no sig
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/webclient.*sig|"sig"/);
  });

  // ── D-178 S1 rev 2 — the per-triple native `lib/` sidecar ────────────────
  describe('lib-<triple> sidecar artifact', () => {
    it('parses a sidecar keyed off the triple', () => {
      const m = JSON.parse(valid());
      m.channels.stable.artifacts['lib-linux-x64'] = { url: 'https://x/lib', sha256: 'll', sig: 'lsig' };
      const parsed = parseManifest(JSON.stringify(m));
      expect(parsed.channels.stable?.artifacts['lib-linux-x64']).toEqual({
        url: 'https://x/lib', sha256: 'll', sig: 'lsig',
      });
    });

    it('⛔ REJECTS a sidecar missing its sig, rather than ignoring it as an unknown key', () => {
      // The case that motivated validating `lib-*` instead of letting it fall
      // through the forward-compat `continue`. Silently skipped, a sig-less
      // sidecar reaches a consumer as an UNVERIFIABLE download — the one thing
      // I-2 exists to prevent.
      const m = JSON.parse(valid());
      m.channels.stable.artifacts['lib-linux-x64'] = { url: 'https://x/lib', sha256: 'll' }; // no sig
      expect(() => parseManifest(JSON.stringify(m))).toThrow(/lib-linux-x64.*sig|"sig"/);
    });

    it('still ignores a genuinely unknown artifact kind (forward-compat, I-9)', () => {
      // Proves the case above bites because `lib-*` is RECOGNISED, not because
      // validation got stricter across the board.
      const m = JSON.parse(valid());
      m.channels.stable.artifacts['flatpak-x64'] = { url: 'https://x/f' }; // no sha256, no sig
      expect(() => parseManifest(JSON.stringify(m))).not.toThrow();
    });

    it('does not mistake a lib-shaped key for a real triple', () => {
      // `lib-nonsense` is not `lib-<Platform>`, so it must fall through to the
      // unknown-key path rather than be validated as a sidecar.
      const m = JSON.parse(valid());
      m.channels.stable.artifacts['lib-nonsense'] = { url: 'https://x/n' };
      expect(() => parseManifest(JSON.stringify(m))).not.toThrow();
    });

    it('accepts a manifest with no sidecar (docker-only / pre-sidecar release)', () => {
      const parsed = parseManifest(valid());
      expect(parsed.channels.stable?.artifacts['lib-linux-x64']).toBeUndefined();
    });
  });
});

/** ⛔⛔⛔ A FRESHNESS FIELD THAT FAILS OPEN. `reqStr` accepted any non-empty string,
 *  so `expires_at: "not-a-date"` parsed; `resolve.ts` then got NaN from
 *  `Date.parse` and its `Number.isFinite` guard SKIPPED the staleness check —
 *  the manifest was fresh forever, fleet-wide and silently. I-10 promises the
 *  opposite in as many words. */
describe('manifest grammar: instants and counters', () => {
  const parse = (over: Record<string, unknown>) =>
    () => parseManifest(JSON.stringify({ ...wellFormed(), ...over }));
  const parseChannel = (over: Record<string, unknown>) => () => {
    const m = wellFormed();
    m.channels.stable = { ...m.channels.stable, ...over } as typeof m.channels.stable;
    return parseManifest(JSON.stringify(m));
  };

  it('accepts the shape the pipeline publishes', () => {
    expect(parse({})()).toMatchObject({ sequence: 184, min_launcher_version: 1 });
  });

  // ⚠ `rollout_pct: 0` IS THE LIVE VALUE and a standing decision — nothing
  // auto-applies — so the grammar must accept it. A `> 0` rule would have refused
  // every manifest we actually publish.
  it('accepts rollout_pct 0, the value stable ships', () => {
    expect(parseChannel({ rollout_pct: 0 })()).toBeTruthy();
  });

  it('refuses an expiry it cannot compare', () => {
    for (const bad of ['not-a-date', '', 'Sep 30 2026', '2026-09-30', '2026-09-30T00:00:00+01:00']) {
      expect(parse({ expires_at: bad }), `expires_at: ${JSON.stringify(bad)}`)
        .toThrow(/canonical RFC 3339/);
    }
  });

  // 🔑 CANONICAL, NOT MERELY PARSEABLE: `install.sh` compares this field LEXICALLY
  // with `sort`, which is correct for a fixed-width UTC instant and nothing else.
  // `Date.parse` would accept "Sep 30 2026", which the shell orders as garbage.
  it('accepts only the fixed-width UTC form the shell can sort', () => {
    expect(parse({ expires_at: '2026-09-30T00:00:00Z' })()).toBeTruthy();
    expect(parse({ expires_at: '2026-09-30T00:00:00.250Z' })()).toBeTruthy();
  });

  it('refuses counters that are not counters', () => {
    expect(parse({ sequence: 200.7 })).toThrow(/non-negative integer/);
    expect(parse({ sequence: -1 })).toThrow(/non-negative integer/);
    expect(parse({ min_launcher_version: 1.5 })).toThrow(/non-negative integer/);
    expect(parseChannel({ rollout_pct: 33.3 })).toThrow(/non-negative integer/);
    expect(parseChannel({ rollout_pct: 101 })).toThrow(/no greater than 100/);
  });

  // ⛔ `schema_version` WAS THE COUNTER THIS RULE MISSED. It stayed on `reqNum`
  // while its three siblings were tightened, so `0.5` and `-1` PARSED as a
  // supported schema and the document was then walked field-by-field on the
  // assumption the shape held. `1.5` was refused, but by the ceiling check and
  // with a misleading "newer than supported" — a right answer for a wrong reason,
  // which is why the fraction did not look like a hole.
  //
  // 🔑 It also made `install.sh` STRICTER THAN THE CANONICAL PARSER: the shell
  // refuses a non-digit schema_version outright, so a manifest existed that the
  // installer rejected and `parseManifest` accepted.
  it('⛔ holds schema_version to the counter rule too', () => {
    expect(parse({ schema_version: 0.5 })).toThrow(/non-negative integer/);
    expect(parse({ schema_version: -1 })).toThrow(/non-negative integer/);
    expect(parse({ schema_version: '1' })).toThrow(/non-negative integer/);
    // Still refused by the CEILING when it is a well-formed but too-new integer,
    // and that message must stay distinguishable from the grammar one.
    expect(parse({ schema_version: 2 })).toThrow(/newer than supported/);
    expect(parse({ schema_version: 1 })()).toBeTruthy();
  });
});

/** 🔑 WHAT THE TWO GRAMMAR BLOCKS ADD UP TO, stated once so a new field cannot
 *  quietly land with only a type check.
 *
 *  Every field `parseManifest` reads is now held to a GRAMMAR, not just a type:
 *  `version` / `min_supported` to the release-version grammar (bounded segments,
 *  positive ordinal — see the `parseManifest` block above); `expires_at` to a
 *  canonical RFC 3339 UTC instant; `schema_version` / `sequence` /
 *  `min_launcher_version` / `rollout_pct` to the counter rule; `migration` to an
 *  explicit boolean; the artifact entries to their sig/digest shape.
 *
 *  ⚠ THE ONE DELIBERATE EXCEPTION IS `released_at`, and it is documented at the
 *  field: it is DISPLAY, nothing parses it, and refusing a signed feed over a
 *  cosmetic string would take the release out of reach to fix the string. If
 *  anything ever starts parsing it, tighten it there first.
 *
 *  ⛔ The failure mode this guards is not a wrong value — it is a field whose
 *  TYPE is checked and whose GRAMMAR is not, which is how `expires_at` turned the
 *  freshness gate off and how `schema_version` kept a fraction. */
describe('manifest grammar: the whole surface', () => {
  it('every field the parser reads is grammar-checked, or documented as display', () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      // ⚠ 0.5, NOT 1.5. A fraction ABOVE the ceiling throws either way — the
      // ceiling check catches it — so 1.5 would pass this test with the counter
      // rule removed, i.e. for the wrong reason. Below the ceiling, only the
      // grammar refuses it. Verified by mutation.
      ['schema_version', { schema_version: 0.5 }],
      ['sequence', { sequence: -1 }],
      ['min_launcher_version', { min_launcher_version: 0.5 }],
      ['expires_at', { expires_at: 'Sep 30 2026' }],
    ];
    for (const [field, over] of bad) {
      expect(() => parseManifest(JSON.stringify({ ...wellFormed(), ...over })), field).toThrow(ManifestError);
    }
    const badChannel: Array<[string, Record<string, unknown>]> = [
      ['version', { version: '26.9.1.0' }],
      ['min_supported', { min_supported: '26.9.1.dev' }],
      ['rollout_pct', { rollout_pct: 101 }],
      ['migration', { migration: 'yes' }],
    ];
    for (const [field, over] of badChannel) {
      const m = wellFormed();
      m.channels.stable = { ...m.channels.stable, ...over } as typeof m.channels.stable;
      expect(() => parseManifest(JSON.stringify(m)), field).toThrow(ManifestError);
    }
  });
});
