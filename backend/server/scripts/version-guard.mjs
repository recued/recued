/** The `yy.m.d[.n]` ordering + the one rule that bounds a same-day hotfix.
 *
 *  ⛔⛔ THIS FILE EXISTS BECAUSE THE RULE HAD ONE ENFORCEMENT POINT AND THREE
 *  WAYS PAST IT. `release.mjs` refused an unreadable hotfix at its final publish
 *  step — but internal design notes documents `npm run release:build` +
 *  `npm run release:publish` invoked DIRECTLY, and `version-date.mjs --hotfix`
 *  minted the version in the first place. Three entry points, one of them the
 *  official runbook, none of them gated. A guard the documented path walks past
 *  is a guard for the path nobody takes.
 *
 *  ⇒ the rule lives here, and every boundary that can still stop it calls it:
 *  the stamper (refuse to MINT), the builder (refuse to SIGN), the publisher
 *  (refuse to UPLOAD — the last irreversible boundary), and the driver.
 *
 *  ⚠ PLACEMENT IS LOAD-BEARING. This must be importable by `version-date.mjs`,
 *  `release-build.mjs`, `release-publish.mjs` AND repo-root `release/release.mjs`.
 *  `release/` is a `forbidden_path_prefixes` entry in the public export, so a
 *  published script may not import from it; `packages/release` is TypeScript
 *  that needs a `dist/` the release's own build step produces. `backend/server/
 *  scripts/` is the only directory all four can reach and the public tree still
 *  ships — which is why `release.mjs` already imports `version-date.mjs` from
 *  here for `VERSION_STAMPED_FILES`. */

/** Ordering for `yy.m.d[.n]` release versions — the MIRROR of `compareVersions`
 *  in `packages/release/src/resolve.ts`, which is the authority because it is
 *  what runs on the installed server.
 *
 *  ⛔ Two copies, on purpose. `packages/` may never import from `backend/`, and
 *  the release tooling must run without a built `dist/` — before and after the
 *  build step it drives. So it is mirrored, and the mirror is RATCHETED:
 *  `test/four-segment-comparator-ratchet.test.ts` drives both over one table and
 *  fails if they ever disagree. A silent divergence here means the publish guard
 *  reasons about a different ordering than the servers it is protecting — which
 *  is the exact failure the guard exists to prevent.
 *
 *  Four segments: a same-day hotfix is `yy.m.d.n`. A missing segment reads as 0,
 *  so plain triples order exactly as they did with three. */
export const compareVersions = (a, b) => {
  const parse = (v) => String(v).split('.').slice(0, 4).map((p) => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 4; i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
};

/** The first release whose binary reads four version segments. A `yy.m.d.n`
 *  hotfix is only VISIBLE to servers at or past this.
 *
 *  ⚠ THIS IS A FORWARD PROMISE UNTIL 26.9.1 ACTUALLY SHIPS. The constant asserts
 *  that the release it names carries the 4-segment comparator; nothing in code
 *  can check that, because the claim is about a build that does not exist yet.
 *  If `26.9.1` is ever cut from a tree without D-258's `compareVersions`, this
 *  gate passes a hotfix the fleet cannot read — the exact failure it exists to
 *  prevent, with the guard reporting success. Cutting 26.9.1 from a commit that
 *  contains D-258 is what makes it true. */
export const FIRST_FOUR_SEGMENT_VERSION = '26.9.1';

/** The ONLY shape a release version may take — MIRROR of `RELEASE_VERSION_RE` in
 *  `packages/release/src/manifest.ts`, ratcheted alongside the comparator.
 *
 *  ⛔⛔ THE COMPARATOR IS NOT THE GRAMMAR. It slices to four segments and
 *  `parseInt`s each, so a malformed version becomes a NUMBER rather than an
 *  error, and all four of these passed the fleet-readability guard:
 *
 *    26.9.1.0     == 26.9.1    (a zero ordinal is not an ordinal)
 *    26.9.1.dev   == 26.9.1    (parseInt('dev') → NaN → coerced to 0)
 *    26.9.1.1.1   == 26.9.1.1  (the fifth segment is sliced off, not rejected)
 *    26.9.1-rc.1   > 26.9.1    (parseInt('1-rc') → 1; the ordinal then wins)
 *
 *  The first three SILENTLY HIDE a release — D-258's own failure arriving through
 *  the parser instead of the comparator. The fourth installs a prerelease OVER
 *  the final release. And `isHotfixVersion` answered `true` for every one of
 *  them, so the "is this a hotfix" question was being asked of a string that was
 *  not a version at all. */
/** ⛔ 9-DIGIT SEGMENT BOUND, mirrored from the authority. An unbounded segment is
 *  only orderable in a runtime with unbounded integers, and none of the three
 *  that compare these strings has them: JS `parseInt` collides past 2^53 and
 *  yields `Infinity` beyond ~309 digits (so a 400-digit ordinal compares EQUAL
 *  to the release it should supersede), PowerShell's `[int]::TryParse` is signed
 *  32-bit and reads an over-long segment as 0, and POSIX shell arithmetic is
 *  platform-bounded. 9 digits is below 2^31 and exact as a double, so all three
 *  agree — and a calendar version needs 2. */
export const RELEASE_VERSION_RE = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})(?:\.[1-9]\d{0,8})?$/;

/** Is this a well-formed release version? */
export const isValidReleaseVersion = (version) => RELEASE_VERSION_RE.test(String(version));

/** Why `version` is not a release version, or `null` when it is. */
export const grammarRefusal = (version) => {
  if (isValidReleaseVersion(version)) return null;
  return `"${version}" is not a release version.\n`
    + '  Expected yy.m.d, or a same-day hotfix yy.m.d.n — exactly 3 or 4 numeric\n'
    + '  segments, no leading zeros, and a POSITIVE fourth ordinal.\n'
    + '  The comparator would coerce this to a number instead of refusing it:\n'
    + '  26.9.1.0, 26.9.1.dev and 26.9.1.1.1 all compare EQUAL to the release they\n'
    + '  should supersede, and 26.9.1-rc.1 compares NEWER than 26.9.1.';
};

/** Is this a `yy.m.d.n` same-day hotfix rather than an ordinary `yy.m.d`?
 *
 *  ⚠ ONLY MEANINGFUL FOR A VALID VERSION — check the grammar first. This asks a
 *  shape question, and asking it of `26.9.1-rc.1` (which splits into four parts)
 *  answered `true` for a string that is not a version. */
export const isHotfixVersion = (version) => String(version).split('.').length > 3;

/** Why the fleet cannot READ this version, or `null` when it can.
 *
 *  ⛔⛔ A 4-SEGMENT VERSION IS INVISIBLE TO AN OLD SERVER, NOT REFUSED BY IT.
 *  `compareVersions` runs on the INSTALLED server; one that truncates at three
 *  reads `26.9.1.1` as `26.9.1`, compares EQUAL to itself, and answers
 *  `up-to-date`. The manifest is ACCEPTED — `sequence` is a separate gate and
 *  passes normally — and the owner is told there is nothing to install. Silent,
 *  on the one path that exists to deliver an urgent fix, and not undoable
 *  remotely.
 *
 *  🔑 The arithmetic makes the rule simple: a 4-part version is blind only to
 *  servers running its exact BASE TRIPLE. Every older server compares that
 *  triple against its own lower one and updates normally. So a hotfix is safe
 *  once the fleet's newest release carries the extension — and never before.
 *
 *  ⚠ Decided LOCALLY from the version being cut, never from a fetched manifest:
 *  a failed `curl` must not be able to switch the gate off. */
export const hotfixRefusal = (version) => {
  // ⛔ GRAMMAR FIRST. Every judgement below is arithmetic on the parsed segments,
  // and arithmetic on a malformed string produces an answer rather than an error.
  const malformed = grammarRefusal(version);
  if (malformed !== null) return malformed;
  if (!isHotfixVersion(version)) return null;
  const base = String(version).split('.').slice(0, 3).join('.');
  if (compareVersions(base, FIRST_FOUR_SEGMENT_VERSION) >= 0) return null;
  return `${version} is a same-day hotfix on ${base}, and ${base} predates `
    + `${FIRST_FOUR_SEGMENT_VERSION} — the first release\n`
    + `  carrying the 4-segment comparator. A server running exactly ${base} would\n`
    + `  truncate ${version} to ${base}, compare EQUAL to itself, and report "up-to-date".\n`
    + '  Cut a plain yy.m.d release instead; it reaches every server.';
};

/** Assert the fleet can read `version`, naming `where` in the refusal. `exit` is
 *  the caller's own failure path so each site keeps its established prefix and
 *  exit code. */
export const assertFleetReadable = (version, where, exit) => {
  const refusal = hotfixRefusal(version);
  if (refusal !== null) exit(`${where}: ${refusal}`);
};

/** Why this channel's declared version does not match the build it labels, or
 *  `null` when they agree.
 *
 *  ⛔⛔ THE ARTIFACTS CARRY HASHES FROM THE BINARIES AND LABELS FROM THE CONFIG,
 *  AND NOTHING ON THE DOCUMENTED PATH CHECKED THAT THE TWO AGREE. `release.config.json`
 *  is GITIGNORED — deliberately, it holds the sequence and expiry — so it is
 *  invisible in the diff reviewed before tagging, and `version-date.mjs` does not
 *  stamp it. On 2026-08-09 that shipped 26.8.8 binaries under a manifest saying
 *  `26.8.5`: the hashes matched the bytes so every install VERIFIED, servers were
 *  simply told the wrong version, and the unchanged sequence meant nobody was
 *  offered anything. The release had, in effect, not shipped, and steps 1–7 all
 *  passed.
 *
 *  🔑 BOTH DIRECTIONS FAIL, AND THEY FAIL DIFFERENTLY:
 *   · `.n` binary + base config → the hotfix is PUBLISHED AS THE BASE VERSION, so
 *     servers on the base compare equal and report `up-to-date`. Silent.
 *   · base binary + `.n` config → the updater stages it, the booted binary reports
 *     the base, `currentReleaseIdentity !== release`, and boot reconciliation
 *     never commits — it counts boot failures and auto-reverts. Loud, but only
 *     after it has been published and downloaded.
 *
 *  ⚠ The gate lived only in the `npm run release` wrapper, and internal design notes
 *  invokes `release:build` / `release:publish` directly. Same shape as the
 *  fleet-readability guard: one enforcement point, and the documented path went
 *  around it. */
export const configAlignmentRefusal = (packageVersion, channelName, channelVersion) => {
  if (!channelVersion || channelVersion === packageVersion) return null;
  return `channel '${channelName}' declares version ${channelVersion}, but `
    + `backend/server/package.json says ${packageVersion}.\n`
    + `  The manifest takes its LABEL from the config and its HASHES from the binaries,\n`
    + `  so this would ship ${packageVersion} bytes labelled ${channelVersion} — verifying\n`
    + '  correctly and installing as the wrong release. Bump the channel to '
    + `${packageVersion}, or re-stamp the tree.`;
};

/** What an executable for `triple` must identify as in its native object header.
 *
 *  ⛔⛔ A STRING SEARCH IS NOT AN IDENTITY CHECK. `assertBinaryCarriesVersion`
 *  proves the bytes MENTION the version; it says nothing about them being a
 *  program. Measured: copying `package.json` into all six executable slots and
 *  all six `.node` slots produced twelve artifacts that `file` identifies as
 *  JSON, and the build signed every one and emitted the manifest — because
 *  package.json contains its own version string, which is exactly what the
 *  search was looking for. The dev-key marker stopped that probe reaching a
 *  publish, but custody signing runs the same artifact validation.
 *
 *  🔑 BOTH OS AND CPU ARE LOAD-BEARING. Magic alone catches a Linux binary in a
 *  Windows slot, but it does not distinguish linux-x64 from linux-arm64. One host
 *  signs every triple, so the native header is the only source of truth available
 *  at this boundary: ELF e_machine, PE COFF Machine, or Mach-O cputype/fat slices.
 *
 *  ⚠ THIS PROVES FORMAT, NOT PROVENANCE OR FUNCTION. A truncated or corrupt
 *  executable still starts with the right magic. Together with the version
 *  binding it says "a program of the right kind, built at the right version";
 *  it does not say the program works. Say what it proves. */
const CPU = {
  x64: { elf: 62, pe: 0x8664, macho: 0x01000007 },
  arm64: { elf: 183, pe: 0xaa64, macho: 0x0100000c },
};

const startsWith = (bytes, magic) => magic.every((b, i) => bytes[i] === b);

/** Read the native object identity without executing it. Returns the CPU codes
 *  carried by the object, or a refusal that explains why the header is not one
 *  of the formats the target OS can load. */
const executableCpuCodes = (bytes, os) => {
  if (os === 'linux') {
    if (!startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46])) return { error: 'missing ELF magic' };
    if (bytes.length < 20) return { error: 'truncated ELF header' };
    if (bytes[4] !== 2) return { error: `ELF class ${bytes[4]} is not 64-bit` };
    if (bytes[5] !== 1) return { error: `ELF data encoding ${bytes[5]} is not little-endian` };
    const machine = bytes.readUInt16LE(18);
    return { codes: [machine], label: `ELF e_machine ${machine}` };
  }

  if (os === 'windows') {
    if (!startsWith(bytes, [0x4d, 0x5a])) return { error: 'missing PE/COFF MZ magic' };
    if (bytes.length < 0x40) return { error: 'truncated DOS header' };
    const pe = bytes.readUInt32LE(0x3c);
    if (pe > bytes.length - 6 || !startsWith(bytes.subarray(pe), [0x50, 0x45, 0x00, 0x00])) {
      return { error: 'missing or out-of-range PE signature' };
    }
    const machine = bytes.readUInt16LE(pe + 4);
    return { codes: [machine], label: `PE Machine 0x${machine.toString(16)}` };
  }

  if (os === 'macos') {
    if (bytes.length < 8) return { error: 'truncated Mach-O header' };
    if (startsWith(bytes, [0xcf, 0xfa, 0xed, 0xfe])) {
      const cpu = bytes.readUInt32LE(4);
      return { codes: [cpu], label: `Mach-O cputype 0x${cpu.toString(16)}` };
    }
    if (startsWith(bytes, [0xfe, 0xed, 0xfa, 0xcf])) {
      const cpu = bytes.readUInt32BE(4);
      return { codes: [cpu], label: `Mach-O cputype 0x${cpu.toString(16)}` };
    }

    const fat32be = startsWith(bytes, [0xca, 0xfe, 0xba, 0xbe]);
    const fat32le = startsWith(bytes, [0xbe, 0xba, 0xfe, 0xca]);
    const fat64be = startsWith(bytes, [0xca, 0xfe, 0xba, 0xbf]);
    const fat64le = startsWith(bytes, [0xbf, 0xba, 0xfe, 0xca]);
    if (!fat32be && !fat32le && !fat64be && !fat64le) return { error: 'missing Mach-O magic' };

    const little = fat32le || fat64le;
    const stride = fat64be || fat64le ? 32 : 20;
    const read32 = (offset) => little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
    const count = read32(4);
    if (count < 1 || count > 64 || 8 + count * stride > bytes.length) {
      return { error: `invalid or truncated Mach-O fat header (${count} slices)` };
    }
    const codes = [];
    for (let i = 0; i < count; i += 1) codes.push(read32(8 + i * stride));
    return { codes, label: `Mach-O fat cputypes ${codes.map((c) => `0x${c.toString(16)}`).join(', ')}` };
  }

  return { error: `unknown platform '${os}'` };
};

/** Refuse an artifact that is not an executable of the right kind for `triple`.
 *  `kind` names the slot for the message ('binary' / 'native addon'); both are
 *  the same platform formats — a `.node` is a shared object, a DLL on Windows. */
export const assertExecutableFormat = (bytes, triple, fileName, kind, exit) => {
  const [os, arch, ...rest] = String(triple).split('-');
  const expected = CPU[arch];
  if (rest.length > 0 || !expected) {
    exit(`${fileName}: unknown architecture '${arch ?? ''}' in triple '${triple}'`);
    return;
  }
  const inspected = executableCpuCodes(bytes, os);
  const expectedCode = expected[os === 'macos' ? 'macho' : os === 'windows' ? 'pe' : 'elf'];
  if (inspected.codes?.includes(expectedCode)) return;
  const head = [...bytes.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const observed = inspected.error ?? inspected.label ?? 'unreadable native header';
  exit(`${fileName} is not a ${triple} ${kind}.\n`
    + `  Native header: ${observed}; first bytes: ${head || '(empty)'}. The target requires ${arch}.\n`
    + '  OS magic alone cannot distinguish x64 from arm64, so accepting only the prefix can\n'
    + '  sign a valid executable for the wrong CPU and publish an update that fails at boot.\n'
    + '  This is a staging-dir mistake: a placeholder, a wrong-architecture artifact, a\n'
    + '  wrong-platform artifact, or a download that never completed.');
};

/** The exact byte sequence a binary built at `version` must contain.
 *
 *  `build.mjs` defines `__RECUED_SERVER_VERSION__` as `JSON.stringify(VERSION)`,
 *  so the bundle — and the SEA binary that embeds it — carries the version as a
 *  QUOTED JS string literal. The quotes are what make this exact instead of a
 *  prefix test: `"26.9.1"` does not occur inside `"26.9.1.1"`, so neither
 *  mislabelling direction slips through. */
export const versionNeedle = (version) => Buffer.from(`"${version}"`, 'utf8');

/** Refuse to sign bytes that do not carry the version they are about to be
 *  labelled with. See the call site in `release-build.mjs` for why this is a
 *  byte search rather than an execution: one host signs every triple, and it
 *  cannot run four of them. */
export const assertBinaryCarriesVersion = (bytes, version, fileName, exit) => {
  if (bytes.includes(versionNeedle(version))) return;
  exit(`${fileName} does not carry version ${version}.\n`
    + `  The manifest would label these bytes ${version}, but they do not contain the\n`
    + `  embedded "${version}" literal a binary built at that version carries. That is a\n`
    + '  STALE OR WRONG BINARY in the staging dir — publishing it installs one release\n'
    + '  under another release\'s name: a fresh install reports success while running the\n'
    + '  older build, and a self-update stages, boots, sees the old identity and reverts.\n'
    + '  Rebuild the binaries from the tree you are releasing.');
};

/** Assert every channel's version matches the package the binaries were built
 *  from. Checked per channel because the manifest carries them all and each is a
 *  separate label. */
export const assertChannelsMatchPackage = (packageVersion, channels, exit) => {
  const grammar = grammarRefusal(packageVersion);
  if (grammar !== null) exit(`backend/server/package.json: ${grammar}`);
  for (const [name, ch] of Object.entries(channels ?? {})) {
    // ⛔⛔ A NON-STRING VERSION USED TO `continue`, WHICH IS A GATE THAT SKIPS THE
    // ONE INPUT IT CANNOT JUDGE. `version: 269011` (a JSON number) produced ZERO
    // refusals here while `parseManifest` rejects it outright — so the "last
    // irreversible boundary" waved through a manifest every server refuses.
    // Absent or mistyped is not "nothing to check", it is malformed.
    if (typeof ch?.version !== 'string') {
      exit(`channel '${name}' has no version string (got ${ch?.version === undefined
        ? 'nothing' : `${typeof ch.version} ${JSON.stringify(ch.version)}`}). `
        + 'The canonical parser requires a non-empty string, so an omitted or mistyped '
        + 'field is malformed — and must never be the way past this gate.');
      continue;
    }
    assertFleetReadable(ch.version, `channel '${name}'`, exit);
    const refusal = configAlignmentRefusal(packageVersion, name, ch.version);
    if (refusal !== null) exit(refusal);
    // `min_supported` may legitimately be absent from a hand-written CONFIG (the
    // assembler supplies the manifest's), but a present one that is not a string
    // is the same malformed-field case as above.
    if (ch.min_supported !== undefined) {
      const floor = typeof ch.min_supported === 'string'
        ? grammarRefusal(ch.min_supported)
        : `min_supported must be a string, got ${typeof ch.min_supported}`;
      if (floor !== null) exit(`channel '${name}' min_supported: ${floor}`);
    }
  }
};
