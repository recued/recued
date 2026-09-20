import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

import type { TempFileRef } from '@recued/contracts';

/** D-185 Slice 2 — the run-scoped temp lifecycle for `storage: 'temp'` cli
 *  output (D-185 §3.4). A `temp` cli op writes its produced file under a
 *  deterministic per-run directory derived from the run's anchor `run_id`; the
 *  file survives PAST the producing call (so the immediate next step consumes it
 *  by `TempFileRef`), then the WHOLE run-scratch root is removed in the
 *  execute-handler's run-end `finally` (`cleanupRunScratch`). A `temp` ref must
 *  never outlive its run — cross-run continuity (reactive `context.recipe`)
 *  requires `cas`. The path is deterministic so the producer (the cli executor)
 *  and the run-end janitor (the execute-handler) agree on the root WITHOUT
 *  threading a stateful handle through the engine→executor call boundary, and so
 *  the engine itself (the public `packages/` boundary) does no filesystem IO.
 *
 *  The `temp` backing carries NO Gateway `file.read` gate (the producing op was
 *  already gated as its own write-tier step, §3.2) — so the ONE place a `temp`
 *  ref's bytes are read into a value channel (the ai-* doc-part realization)
 *  confines the read to THIS run's root via `assertPathUnderRunScratch`, closing
 *  an arbitrary-file-read a hand-crafted `{ backing:'temp', path:'/etc/passwd' }`
 *  ref would otherwise open. */

/** A `run_id` flattened to one safe path segment (defense against a `run_id`
 *  that ever carries a separator / traversal token; real ids are hex/uuid). */
const sanitizeRunSegment = (run_id: string): string =>
  run_id.replace(/[^A-Za-z0-9_-]/g, '_');

/** The deterministic per-run temp root. Both the producer and the run-end
 *  janitor derive it from `run_id` alone. */
export const runScratchRoot = (run_id: string): string =>
  join(tmpdir(), 'recued-run-scratch', sanitizeRunSegment(run_id));

/** Allocate a fresh throwaway directory under the run's scratch root for a
 *  single `storage: 'temp'` cli call to write into (bound to the op's
 *  engine-managed `dir_arg`). Distinct per call (a `mkdtemp` subdir), so two
 *  `temp` ops in one run never collide; all of them are reclaimed when the
 *  run-end janitor removes the shared root. */
export const allocateRunScratchDir = (run_id: string): string => {
  if (run_id.length === 0) {
    throw new Error("storage: 'temp' requires a run scope — no run_id on this call");
  }
  const root = runScratchRoot(run_id);
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, 'op-'));
};

/** Confine a `temp` ref's path to the producing run's scratch root before any
 *  read. Resolves symlinks on BOTH sides (macOS `tmpdir()` is a symlink) so the
 *  containment check is honest. Throws when the root is absent (a ref that
 *  outlived its run, or never belonged to it) or the path escapes it. */
export const assertPathUnderRunScratch = (filePath: string, run_id: string): void => {
  // Fail closed without a run scope — `runScratchRoot('')` would resolve to the
  // SHARED `recued-run-scratch` PARENT, under which EVERY run's files live, so a
  // crafted ref could read another run's temp file. The producer side
  // (`allocateRunScratchDir`) likewise refuses an empty run_id; both sides agree.
  if (run_id.length === 0) {
    throw new Error('temp file_ref: read requires a run scope — no run_id (fail closed)');
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(runScratchRoot(run_id));
  } catch {
    throw new Error(
      `temp file_ref: no run-scratch root for run '${run_id}' — a temp ref must not outlive its run (D-185 §3.4)`,
    );
  }
  let realPath: string;
  try {
    realPath = realpathSync(filePath);
  } catch {
    throw new Error(`temp file_ref: path does not exist or is unreadable: ${filePath}`);
  }
  const rel = relative(realRoot, realPath);
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `temp file_ref: path escapes the run-scratch root (refused): ${filePath}`,
    );
  }
};

/** Read a `temp` ref's RAW bytes, confined to the run's scratch root. The one
 *  place the confinement check and the read are composed; every consumer goes
 *  through this or through {@link readConfinedTempFile} below it.
 *
 *  ⚠ RAW RATHER THAN BASE64 BECAUSE NOT EVERY CONSUMER WANTS BASE64. The ai-*
 *  doc-part realization builds a base64 content part, so that was the only shape
 *  needed at first; the records `csv_ref` import wants UTF-8 text, and routing it
 *  through the base64 form would cost three full copies of a file that can reach
 *  32 MiB (buffer → base64 string → decoded buffer) for no gain. The base64
 *  variant now delegates here, so the confinement check has ONE call site and a
 *  second consumer cannot arrive with its own subtly different path handling. */
export const readConfinedTempBytes = (
  temp: TempFileRef,
  run_id: string,
): { bytes: Buffer; mime_type: string; filename: string } => {
  assertPathUnderRunScratch(temp.path, run_id);
  return {
    bytes: readFileSync(temp.path),
    mime_type: temp.mime_type,
    filename: temp.filename,
  };
};

/** Read a `temp` ref's bytes into the base64 content shape the ai-* doc-part
 *  realization consumes — confined to the run's scratch root. `mime_type` /
 *  `filename` ride on the ref (the producing op's `output_capture`), so no
 *  extension sniffing. */
export const readConfinedTempFile = (
  temp: TempFileRef,
  run_id: string,
): { bytes_b64: string; mime_type: string; filename: string } => {
  const { bytes, mime_type, filename } = readConfinedTempBytes(temp, run_id);
  return { bytes_b64: bytes.toString('base64'), mime_type, filename };
};

/** Run-end reclaim, WITH the one exception that makes held runs work.
 *
 *  ⛔⛔ THIS IS A NAMED FUNCTION RATHER THAN `if (!paused) cleanup(...)` AT THE
 *  CALL SITE BECAUSE NOTHING TESTED THAT `!`. The inline form lived in the
 *  execute-handler's run-end `finally`, and a sweep for `resumablePause` across
 *  the tree found the flag in exactly three places — two assignments and that
 *  condition — and in NO test. Deleting the negation, or dropping the guard as a
 *  tidy-up, reclaims the scratch of a run that is about to resume; every `temp`
 *  ref it produced then fails on resume with "must not outlive its run", and the
 *  suite stays green because no test holds a run.
 *
 *  🔑 IT IS THE PROPERTY THE ASK-TIER TEMP CONSUMERS DEPEND ON. A records
 *  `import` taking a `csv_ref` is `approval: 'ask'` in all three shipped packs,
 *  so hold-then-resume is its NORMAL path, not an edge: the file is produced by
 *  a cli step, the owner is asked, and the bytes must still be there when they
 *  say yes. A run that is merely paused has not ended — it continues under the
 *  SAME `run_id` in a later invocation, which performs the terminal sweep.
 *
 *  ⚠ `resumable` MEANS A CHECKPOINT WAS DURABLY WRITTEN, not "an ask was
 *  raised". An orphaned checkpoint (the awaiting audit anchor failed) is rolled
 *  back to a TERMINAL failure and must reclaim — which is why the caller passes
 *  its own post-rollback flag rather than this deciding from an ask's existence. */
export const reclaimRunScratchUnlessResumable = (
  run_id: string,
  resumablePause: boolean,
): void => {
  if (resumablePause) return;
  cleanupRunScratch(run_id);
};

/** Remove the run's entire temp-scratch root. Best-effort — the OS temp reaper
 *  backstops a rare `rm` failure. Called from the execute-handler's run-end
 *  `finally` (success, throw, and pause paths). Idempotent + safe when the run
 *  produced no `temp` output (the root never existed). */
export const cleanupRunScratch = (run_id: string): void => {
  if (run_id.length === 0) return;
  try {
    rmSync(runScratchRoot(run_id), { recursive: true, force: true });
  } catch {
    /* best-effort cleanup — the OS temp reaper backstops a rare rm failure */
  }
};
