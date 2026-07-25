/** Filesystem durability primitives shared by every writer that publishes via
 *  temp-file + atomic rename.
 *
 *  fsyncing the file alone makes its BYTES durable; the directory entry the
 *  rename creates is a separate metadata write. Without a directory fsync a
 *  power loss can leave the old name (or no name) pointing at the right bytes —
 *  the rename is lost even though the data survived. Both halves are needed for
 *  "it is on disk under this name after a crash".
 *
 *  Both are best-effort: a platform or filesystem that cannot fsync (notably
 *  Windows, which cannot open a directory for it) must not fail the write it
 *  was protecting. The atomic rename still gives process-crash safety there.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

/** fsync a file so its bytes are durable before we rely on it across a crash. */
export const fsyncFile = (path: string): void => {
  try {
    const fd = openSync(path, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* best-effort durability */
  }
};

/** fsync a directory so a rename into it survives power loss. */
export const fsyncDir = (path: string): void => {
  try {
    const fd = openSync(path, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* best-effort — unsupported platform: skip */
  }
};

/** A publish in progress: `<target>.tmp.<pid>.<nonce>`. The nonce is what makes
 *  the name unpicked, so two publishes of the same target — or two processes —
 *  can never select each other's file; the pid is there to say whose it was
 *  when one is found stranded. Built here, and matched here by
 *  `sweepAtomicWriteTemps`, so the sweep cannot drift from what the writer
 *  actually produces. */
const atomicTempPath = (path: string): string =>
  `${path}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;

const ATOMIC_TEMP_NAME = /\.tmp\.\d+\.[0-9a-f]{16}$/;

/** Publish `body` at `path` via a private temp file + atomic rename, durably.
 *
 *  The one implementation of the pattern, because the copies drifted: the
 *  keyfile writer called `writeSync(fd, body)` once and ignored its return,
 *  while its sibling looped on offset. `writeSync` does NOT loop — it can
 *  write fewer bytes than asked and report it, and a filesystem running out of
 *  space is exactly the condition that produces a partial write. That silently
 *  truncated the file holding the server vault key: a headless lock-out
 *  recoverable only from the recovery key, with nothing on disk to say why.
 *
 *  What each step is for:
 *    - `wx` — the open has to CREATE the file. The nonce in the temp's name
 *      already makes a collision negligible, so this is not really about
 *      landing on a name in use; it is what gives the 0600 below any force.
 *      `openSync` applies a mode only when it creates, so a plain `w` onto a
 *      path that somehow existed would write key material into whatever
 *      permissions that file already carried.
 *    - the offset loop — a short write is resumed, and a zero-byte write is a
 *      refusal to make progress, so it raises rather than spinning.
 *    - `fsync` on the file, then on the DIRECTORY after the rename — the bytes
 *      and the name that points at them are two separate durability facts.
 *    - unlink on ANY failure — a half-written temp holding key material must
 *      not survive the call that failed to publish it. A kill never reaches
 *      that `catch`, which is what `sweepAtomicWriteTemps` is for.
 *
 *  0600 from creation, never chmod'd after: the file is owner-only for its
 *  whole life, including the window before the rename.
 */
export const writeFileAtomicSync = (path: string, body: string | Buffer): void => {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = atomicTempPath(path);
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset, null);
        if (written === 0) throw new Error(`short write while publishing ${path}`);
        offset += written;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    fsyncDir(dir);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort temp cleanup */ }
    throw err;
  }
};

/** Reclaim the publish temps a hard kill stranded in `dir`, returning how many
 *  went.
 *
 *  `writeFileAtomicSync` unlinks its own temp on any failure it lives to see,
 *  which covers every ordinary error and none of SIGKILL, an OOM kill, or power
 *  loss. What one of those leaves is a 0600 file holding the COMPLETE document
 *  the publish was carrying — for the keyfile in its default unencrypted mode
 *  that is the server vault key plus both Ed25519 private identity keys, in the
 *  clear. They accumulate one per crash and nothing else removes them, so a
 *  rotation that was supposed to retire a secret leaves it sitting beside the
 *  file that replaced it.
 *
 *  Unconditional rather than age-gated, for the same reason the archive's blob
 *  scratch sweep is: the caller runs it at boot behind the instance-lock claim,
 *  and `writeFileAtomicSync` is synchronous end to end, so no publish of ours
 *  can be holding a temp open while this walks. An age window would only mean
 *  key material sits until a boot that may be months away. Best-effort
 *  throughout — a missing directory or a file that will not unlink is never
 *  worth failing a boot over. */
export const sweepAtomicWriteTemps = (dir: string): number => {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!ATOMIC_TEMP_NAME.test(name)) continue;
    try {
      unlinkSync(join(dir, name));
      removed += 1;
    } catch {
      /* already gone, or not ours to remove */
    }
  }
  return removed;
};
