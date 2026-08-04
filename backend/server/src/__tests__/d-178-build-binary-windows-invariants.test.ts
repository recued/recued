/** D-178 S1 — the Windows build driver's invariants.
 *
 *  Every assertion below is a failure that ACTUALLY HAPPENED while getting the
 *  first Windows binaries out, and none of them was caught by anything. The
 *  build itself cannot be exercised in CI — it needs a Windows host over SSH —
 *  so these pin the properties that a future edit could quietly drop.
 *
 *  ⚠ Source assertions are weaker than execution. Each one below therefore names
 *  the specific failure it prevents, so a reader can tell whether a rewrite that
 *  reddens it is a regression or just a rename.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { binaryFileName } from '@recued/release';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '../../scripts');
const driver = readFileSync(join(SCRIPTS, 'build-binary-windows.mjs'), 'utf8');
const buildPs1 = readFileSync(join(SCRIPTS, 'windows/build.ps1'), 'utf8');
const smokePs1 = readFileSync(join(SCRIPTS, 'windows/smoke.ps1'), 'utf8');

const TRIPLES = ['windows-x64', 'windows-arm64'] as const;

/** PowerShell comments, stripped. These files discuss npm.cmd and --version at
 *  length — deliberately, since the point is why NOT to use them — so an
 *  absence assertion against the raw text always fails. Only executable lines
 *  can regress. */
const code = (text: string) =>
  text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const buildCode = code(buildPs1);
const smokeCode = code(smokePs1);

describe('the .ps1 payloads stay parseable on Windows', () => {
  it.each([
    ['build.ps1', buildPs1],
    ['smoke.ps1', smokePs1],
  ])('⛔ %s is ASCII-only — one stray byte breaks the ANSI parse', (_name, text) => {
    // A downloaded .ps1 is read as ANSI. An em dash in a COMMENT was enough to
    // make PowerShell fail with an error pointing nowhere near the character,
    // and it cost a full build pass. The driver asserts this at run time too;
    // this catches it at commit time, before a VM is involved.
    const offenders = text
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /[^\x09\x20-\x7e]/.test(line));
    expect(offenders.map(([n]) => n)).toEqual([]);
  });
});

describe('the addon architecture is asserted, never assumed', () => {
  it('⛔ checks the PE machine type against a per-triple expectation', () => {
    // `npm rebuild` is a NO-OP when build/Release is populated — prebuild-install
    // skips — and it STILL prints "rebuilt dependencies successfully". Measured:
    // driving it with an x64 node returned the ARM64 addon, same length. Only
    // reading the COFF header catches that.
    expect(buildPs1).toMatch(/0x8664/);
    expect(buildPs1).toMatch(/0xAA64/);
    expect(buildPs1).toMatch(/Get-Machine/);
    expect(buildPs1).toMatch(/if \(\$got -ne \$want\)/);
  });

  it('⛔ deletes the addon build dir BEFORE rebuilding, or the check has nothing to catch', () => {
    const rm = buildPs1.indexOf("Remove-Item -Recurse -Force (Join-Path $PKG 'build')");
    const rebuild = buildPs1.indexOf('rebuild better-sqlite3-multiple-ciphers');
    expect(rm).toBeGreaterThan(-1);
    expect(rm).toBeLessThan(rebuild);
  });

  it('drives npm through the target node, not the npm.cmd shim', () => {
    // npm.cmd resolves node from PATH — the HOST arch — so prebuild-install
    // would fetch a prebuild for the wrong architecture on the foreign triple.
    expect(buildCode).toMatch(/\$nodeExe \$npmCli rebuild/);
    expect(buildCode).not.toMatch(/npm\.cmd/);
  });
});

describe('PowerShell functions do not leak into their own return value', () => {
  it('⛔ no function that RETURNS a value may write to the pipeline', () => {
    // In PowerShell every uncaptured output inside a function is part of its
    // return value. A single progress line inside Resolve-Node came back
    // concatenated onto the node path, which then failed in ReadAllBytes, in
    // Split-Path, and in the call operator — three errors, none naming the
    // cause. Write-Host goes to the host rather than the pipeline, so it is the
    // safe way to narrate from inside one.
    const offenders: string[] = [];
    for (const m of buildPs1.matchAll(/^function ([A-Za-z-]+)\(/gm)) {
      const start = buildPs1.indexOf('{', m.index!) + 1;
      let depth = 1;
      let i = start;
      while (i < buildPs1.length && depth > 0) {
        if (buildPs1[i] === '{') depth += 1;
        else if (buildPs1[i] === '}') depth -= 1;
        i += 1;
      }
      const body = buildPs1.slice(start, i);
      const returnsValue = /\breturn\s+\S/.test(body);
      const writesPipeline = /^\s*(Say|Write-Output)\b/m.test(body);
      if (returnsValue && writesPipeline) offenders.push(m[1]);
    }
    expect(offenders).toEqual([]);
  });
});

describe('artifacts survive the next triple, and reach the release staging dir', () => {
  it('⛔ stages OUTSIDE dist\\binary, which build-binary wipes every run', () => {
    // build-binary.mjs rm -rf's its whole output dir on start. Staging the
    // finished arm64 pair inside it meant the x64 build deleted it.
    expect(buildPs1).toMatch(/\$Artifacts/);
    expect(buildPs1).not.toMatch(/Join-Path \$BIN '(staged|stage)/);
  });

  it('⛔ verifies each copy landed — Copy-Item does not set $LASTEXITCODE', () => {
    // A run gated on $LASTEXITCODE printed BUILD-OK while two copies had failed
    // and an artifact had been destroyed. $LASTEXITCODE tracks native commands
    // only; a cmdlet failure leaves it untouched.
    expect(buildPs1).toMatch(/function Assert-Copy/);
    expect(buildPs1).toMatch(/copy did not land/);
    expect(buildPs1).toMatch(/copy truncated/);
    // Every copy of a build product goes through the checked helper. The one
    // legitimate bare Copy-Item is the helper's own body, so measure from the
    // line after it.
    const helper = buildPs1.indexOf('function Assert-Copy');
    const afterHelper = buildPs1.indexOf('\n}', helper);
    const bare = buildPs1
      .slice(afterHelper)
      .split('\n')
      .filter((l) => /^\s*Copy-Item /.test(l));
    expect(bare).toEqual([]);
  });

  it('⛔ uploads under EXACTLY the names release-build looks for', () => {
    // release-build.mjs REFUSES a binary whose sidecar is missing, and it finds
    // both by name. A mismatch here means a hand-rename between build and
    // release — which is precisely where a sidecar gets dropped.
    for (const triple of TRIPLES) {
      expect(buildPs1).toContain(`recued-$t.exe`);
      expect(buildPs1).toContain(`better_sqlite3-$t.node`);
      // …and those templates must expand to what the release layer expects.
      expect(binaryFileName(triple)).toBe(`recued-${triple}.exe`);
      expect(driver).toContain('`recued-${t}.exe`');
      expect(driver).toContain('`better_sqlite3-${t}.node`');
    }
  });

  it('the driver re-verifies the pair on the HOST, not from the VM report', () => {
    // Upload is the last place an artifact can silently go missing, and the VM
    // has already declared success by then.
    expect(driver).toMatch(/incomplete pair/);
  });
});

describe('the transport does not leak or over-expose', () => {
  it('⛔ never puts the VM password on a command line', () => {
    // argv is world-readable via `ps`. The password reaches expect through the
    // environment only.
    expect(driver).toMatch(/env\(WIN_VM_PASS\)/);
    expect(driver).not.toMatch(/--pass|WIN_VM_PASS.*argv|argv.*WIN_VM_PASS/);
  });

  it('⛔ binds the artifact server to loopback ONLY', () => {
    // Binding wider once served a `git archive` of the entire private tree,
    // unauthenticated, to anything that could reach the host — and it was never
    // necessary: QEMU/UTM SLIRP maps guest 10.0.2.2 to host loopback.
    expect(driver).toMatch(/listen\(0, '127\.0\.0\.1'/);
    expect(driver).not.toMatch(/listen\([^)]*'0\.0\.0\.0'/);
  });

  it('⛔ sanitises the guest-supplied upload path', () => {
    // The guest names the file. Without stripping, a traversal in that string
    // writes anywhere the dev user can reach.
    expect(driver).toMatch(/replace\(\/\[\^A-Za-z0-9\._\/-\]\/g/);
    expect(driver).toMatch(/'\.\.'/);
  });

  it('⛔ the ssh transport is ASYNC — a sync call deadlocks the whole design', () => {
    // Found by running it: `execFileSync` blocks the event loop for the entire
    // remote command, so the HTTP server started moments earlier could not
    // accept the guest's very first fetch. Neither side timed out; the run just
    // sat there. Every transfer in both directions rides that server, so a
    // synchronous spawn anywhere in the SSH path is not a slowdown, it is a
    // hang. `git archive` may stay sync — it runs before the server exists.
    const sshFn = driver.slice(driver.indexOf('const ssh ='), driver.indexOf('const runPs1'));
    expect(sshFn).toMatch(/new Promise/);
    expect(sshFn).not.toMatch(/execFileSync/);
    // and every call site must actually await it
    for (const m of driver.matchAll(/^(?!.*\bconst ssh\b).*[^t] (ssh|runPs1)\(/gm)) {
      expect(m[0]).toMatch(/await /);
    }
  });

  it('builds from a COMMITTED tree, never the working directory', () => {
    // `git archive` takes exactly what is committed at the ref. Copying the
    // working tree would let a dirty file into a binary that is then signed and
    // published, with no commit it can be attributed to.
    expect(driver).toMatch(/'git', \['archive'/);
  });
});

describe('the smoke test proves the binary RUNS', () => {
  it('⛔ boots the server — it does not settle for --version', () => {
    // --version and --help never open the database, so both pass on a binary
    // whose addon is missing or the wrong architecture. Measured: a binary
    // printed 26.8.2 correctly and then failed D178_SIDECAR_MISSING.
    expect(smokeCode).toMatch(/Start-Process/);
    expect(smokeCode).toMatch(/db-created/);
    expect(smokeCode).toMatch(/port-listens/);
    expect(smokeCode).not.toMatch(/--version/);
  });

  it('requires the sidecar to be present before it even starts', () => {
    expect(smokePs1).toMatch(/MISSING SIDECAR/);
  });

  it('a partial run cannot read as a pass', () => {
    for (const [text, ok, bad] of [
      [buildPs1, 'WINBUILD-OK', 'WINBUILD-FAILED'],
      [smokePs1, 'SMOKE-OK', 'SMOKE-FAILED'],
    ] as const) {
      expect(text).toContain(ok);
      expect(text).toContain(bad);
    }
    // The driver must gate on the marker, not on the exit code — the ssh
    // transport's exit code is expect's, not the remote command's.
    expect(driver).toMatch(/includes\('WINBUILD-OK'\)/);
    expect(driver).toMatch(/includes\('SMOKE-OK'\)/);
  });
});
