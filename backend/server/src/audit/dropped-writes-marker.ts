/** R13 T4-6.1 — out-of-band marker for audit writes dropped after drain.
 *
 * Once `closeAndDrain()` closes admission, a late audit append becomes a
 * contained no-op by design (the store must not resurrect mid-shutdown). The
 * defect was that nothing counted the drops. The count cannot be surfaced
 * through the audit store itself — the store is the thing that can no longer
 * record — so it rides a sidecar JSON file next to the database, written
 * synchronously at drop time (the process is shutting down) and consumed at
 * the next boot, where compose-storage surfaces it as one reserve-class
 * `audit_writes_dropped` activity row.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

export interface DroppedWritesMarker {
  /** Total writes refused after drain in the previous process. */
  dropped: number;
  /** Wall-clock ms when the last drop was recorded. */
  at: number;
}

/** Sidecar path for a real on-disk database; `null` for in-memory DBs
 *  (tests / ephemeral harnesses), where a sidecar would land in cwd. */
export const droppedWritesMarkerPath = (dbPath: string): string | null =>
  dbPath === '' || dbPath === ':memory:' || dbPath.startsWith('file::memory:')
    ? null
    : `${dbPath}.dropped-audit-writes.json`;

/** Overwrite-write the marker. Never throws — this runs on the shutdown path,
 *  and a failed marker write costs observability, not correctness. */
export const writeDroppedWritesMarker = (
  path: string,
  marker: DroppedWritesMarker,
): void => {
  try {
    writeFileSync(path, JSON.stringify(marker));
  } catch { /* best-effort by construction */ }
};

/** Read + delete the marker. Returns `null` when absent or malformed — a
 *  malformed marker is still consumed (deleted) so it cannot resurface on
 *  every boot forever. */
export const consumeDroppedWritesMarker = (
  path: string,
): DroppedWritesMarker | null => {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    unlinkSync(path);
    const parsed = JSON.parse(raw) as Partial<DroppedWritesMarker>;
    if (typeof parsed.dropped !== 'number' || typeof parsed.at !== 'number') {
      return null;
    }
    return { dropped: parsed.dropped, at: parsed.at };
  } catch {
    try { unlinkSync(path); } catch { /* already gone */ }
    return null;
  }
};
