/** D-321 — where the owner told the server a cli pack's program is
 * (internal design notes § 2.1; the owner's ruling of 2026-11-07).
 *
 * The server finds a pack's program on its PATH, and a server started at login
 * has a short one: launchd's has no Homebrew, npm or pipx folder. The installer
 * gives its own unit the installing terminal's PATH, but a clone, a binary
 * installed by hand or a service someone wrote never ran it. So the owner can
 * name the file, per program, on the pack's page: the one the server found
 * outside its PATH, or one they type. The server then runs exactly that file,
 * with its folder (and its interpreter's) added at the END of that program's
 * PATH, so a script starting `#!/usr/bin/env node` starts, and nothing the PATH
 * already finds changes.
 *
 * ⛔ A PATH, NEVER PARAMETERS. A location stays a location: its file must carry
 * the program's own name, so `rg` can point at a file called `rg` and never at
 * `/bin/sh -c …`. An arbitrary command line is something no pack can declare
 * either (an install hint is a manager and a package; a version probe asks only
 * for the version), and an owner setting must not become the way to one.
 *
 * One row per cli catalog, as `owner_tool_version` is, stamped with the program
 * the pack launched when the owner chose: a pack update that launches another
 * program leaves the row aside until the owner chooses again. */

/** Actorless row key: `(ingredient_id)`, the cli catalog's slug. */
export const OWNER_TOOL_PATH_SCOPE = 'owner_tool_path';

/** The longest location accepted, as the longest path most systems allow. */
export const OWNER_TOOL_PATH_MAX = 4096;

/** One stored location. */
export interface OwnerToolPathRow {
  /** The program the pack launched when the owner chose (`rg`). */
  binary: string;
  /** The file to run: absolute, and named like the program. */
  path: string;
}

/** One location, as the rpc returns it. */
export interface OwnerToolPathView {
  ingredient_id: string;
  binary: string;
  path: string;
  written_at: number;
}

const lastSegment = (value: string, windows: boolean): string => {
  const parts = value.split(windows ? /[\\/]/u : /\//u);
  return parts[parts.length - 1] ?? '';
};

/** Whether a file name is the program's: the same name, or on Windows the same
 *  name with `.exe` or `.com`, in any case. */
const namesProgram = (file: string, program: string, windows: boolean): boolean => {
  if (!windows) return file === program;
  const lower = file.toLowerCase();
  return [program, `${program}.exe`, `${program}.com`].some((name) => name.toLowerCase() === lower);
};

/** Why `path` cannot be where `binary` is, as the end of a sentence starting
 *  "The location …", or null when it can be. Only the server can see whether a
 *  file is there and runs; this checks what the words alone can show. */
export const ownerToolPathProblem = (binary: string, path: string, windows = false): string | null => {
  // eslint-disable-next-line no-control-regex
  if (path.length === 0 || path.length > OWNER_TOOL_PATH_MAX || /[\u0000-\u001f]/u.test(path)) {
    return 'is not a path';
  }
  const absolute = windows ? /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(path) : path.startsWith('/');
  if (!absolute) {
    return windows ? 'must be a full path, starting with a drive letter' : 'must be a full path, starting with /';
  }
  const program = lastSegment(binary, windows);
  return namesProgram(lastSegment(path, windows), program, windows) ? null : `must be a file named ${program}`;
};

/** Narrow a stored row value. A malformed hand-stored row, or one whose path
 *  no longer passes, reads as no location, so the server's PATH applies. */
export const readOwnerToolPathRow = (value: unknown, windows = false): OwnerToolPathRow | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { binary, path } = value as Record<string, unknown>;
  if (typeof binary !== 'string' || binary.length === 0 || typeof path !== 'string') return undefined;
  return ownerToolPathProblem(binary, path, windows) === null ? { binary, path } : undefined;
};
