/** Shared OS free-space probe.
 *
 *  First home was the D-118 service quota tracker (`osFreeBytes` was a
 *  private helper there); the M1 archive export pre-flight needs the same
 *  probe, so both now share this module rather than duplicating the
 *  `bavail × bsize` coercion.
 */

import { statfsSync } from 'node:fs';

/** Live OS free-space probe via `fs.statfs`. Returns the bytes available
 *  to the calling (non-root) user (`bavail × bsize`). Throws on platforms
 *  / paths that don't support statfs — the caller decides whether to
 *  gate-open or gate-closed on that failure. */
export const osFreeBytes = (path: string): number => {
  const stat = statfsSync(path);
  // bavail = blocks available to non-root processes; bsize = block size
  // in bytes. Coerce via Number() because Node returns BigInt on some
  // platforms; Number is safe for any realistic free-space value
  // (< 2^53 covers > 9 PB).
  return Number(stat.bavail) * Number(stat.bsize);
};
