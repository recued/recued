/** D-212 — the systemd-creds rung never hands /dev/null to systemd as a file.
 *
 *  ⛔ MEASURED 2026-10-05 on Ubuntu 24.04 (systemd 255.4), as root. The
 *  availability probe ran `systemd-creds encrypt --name=recued-probe
 *  --with-key=host - /dev/null`, and /dev/null came out a REGULAR 0644 root file
 *  holding the encrypted blob. systemd writes an output path atomically — a
 *  temp file beside it, then rename() over the target — and a rename replaces a
 *  device node like any file. The probe runs on every first boot that
 *  provisions a keyfile, so every root install broke apt on its host: apt
 *  verifies signatures as `_apt`, which could no longer write /dev/null
 *  ("cannot create /dev/null: Permission denied", "gpgv … not installed"). It
 *  then declined the rung on a droplet anyway — all of the damage, none of the
 *  benefit.
 *
 *  '-' sends the blob to stdout, which `runWithInput` captures and drops; the
 *  host key still materializes (measured: credential.secret created, /dev/null
 *  still a character device).
 *
 *  Source-level, like the `input`-option scan in d-212-machine-secret-stdin:
 *  the probe runs only on Linux outside a test runner, by design, so the suite
 *  cannot execute it. The behaviour was driven in an Ubuntu 24.04 container
 *  against this module, bundled, before and after the fix.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const code = readFileSync(
  fileURLToPath(new URL('../keys/machine-secret.ts', import.meta.url)),
  'utf8',
)
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n');

/** The argv array of every `systemd-creds` call in the module. */
const systemdCredsArgvs = (): string[] =>
  [...code.matchAll(/'systemd-creds',\s*\[([\s\S]*?)\]/g)].map((m) => m[1]!.replace(/\s+/g, ' '));

describe('the systemd-creds rung never hands /dev/null to systemd as a file', () => {
  it('finds every systemd-creds call, so the scan below cannot pass on nothing', () => {
    // --version, the probe's encrypt, provision's encrypt, fetch's decrypt.
    expect(systemdCredsArgvs()).toHaveLength(4);
  });

  it('⛔ no systemd-creds call names /dev/null — systemd renames its output over the path', () => {
    for (const argv of systemdCredsArgvs()) expect(argv).not.toContain('/dev/null');
  });

  it('the probe encrypts stdin to stdout', () => {
    const probe = systemdCredsArgvs().find((argv) => argv.includes('recued-probe'));
    expect(probe).toMatch(/'--with-key=host', '-', '-'/);
  });
});
