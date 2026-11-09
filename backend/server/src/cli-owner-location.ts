/** D-321 — running a cli pack's program from where the owner set it
 *  (`owner-tool-path.ts` in contracts; internal design notes § 2.1).
 *
 *  The executor, the version check and the pack page all read the location the
 *  same way, so the file the page calls ready is the file a run starts, and the
 *  version a check reads is that file's.
 *
 *  🔑 THE FOLDERS GO AFTER THE PATH, NEVER BEFORE. The program's own folder is
 *  added so a script whose first line is `#!/usr/bin/env node` finds the `node`
 *  beside it (nvm puts both in one folder), and so do the programs it starts:
 *  codex's npm launcher starts a native binary, which starts the agent's own
 *  commands. Added at the end, it changes nothing the PATH already finds. */

import { closeSync, openSync, readSync } from 'node:fs';
import { dirname } from 'node:path';

import { PACK_COPY_SUFFIX, readOwnerToolPathRow } from '@recued/contracts';

import { createCliBinaryPathResolver } from './cli-binary-reachability.js';
import { findProgramOutsidePath, type OutsidePathOptions } from './cli-path-diagnosis.js';

/** D-346 — the catalog whose location row a catalog's program reads: its own; or,
 *  for a Kitchen copy with none of its own, its original's.
 *
 *  A copy (D-333, `packCopyFor`) runs the original's program from a catalog named
 *  the original's plus `-copy`, and a location is kept per catalog, so a copy of a
 *  pack whose program the owner had to locate could not find it (the owner, asked:
 *  "including the copy location fallback"). Its own row still wins, and
 *  `ownerLocationFor` uses the original's only while it names the same program, so a
 *  catalog that merely ends in `-copy` can at most reach the owner's location for the
 *  program it runs. A read that throws reads as no row. */
export const ownerLocationSource = (
  readRow: (ingredientId: string) => unknown,
  ingredientId: string,
): string => {
  let own: unknown;
  try {
    own = readRow(ingredientId);
  } catch {
    own = undefined;
  }
  if (own !== undefined && own !== null) return ingredientId;
  return ingredientId.endsWith(PACK_COPY_SUFFIX) && ingredientId.length > PACK_COPY_SUFFIX.length
    ? ingredientId.slice(0, -PACK_COPY_SUFFIX.length)
    : ingredientId;
};

/** The location the owner set for the program a catalog launches, while it
 *  applies: a row written for another program, or one that does not read, is
 *  none. A read that throws is none too: the PATH lookup is the default. A Kitchen
 *  copy with no row of its own reads its original's (`ownerLocationSource`). */
export const ownerLocationFor = (
  readRow: ((ingredientId: string) => unknown) | undefined,
  ingredientId: string,
  binary: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined => {
  if (readRow === undefined || binary === undefined) return undefined;
  try {
    const row = readOwnerToolPathRow(readRow(ownerLocationSource(readRow, ingredientId)), platform === 'win32');
    return row !== undefined && row.binary === binary ? row.path : undefined;
  } catch {
    return undefined;
  }
};

/** The interpreter a script names by name on its first line (`#!/usr/bin/env
 *  node`, `#!/usr/bin/env -S node --flag`), or undefined: a native program, an
 *  interpreter named by its own path, or a file that cannot be read. */
export const scriptInterpreter = (path: string): string | undefined => {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(256);
    const read = readSync(fd, head, 0, head.length, 0);
    const first = head.subarray(0, read).toString('utf8').split('\n')[0] ?? '';
    return /^#!\s*\/usr\/bin\/env\s+(?:-S\s+)?([^\s/]+)/u.exec(first)?.[1];
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

/** The folders a program run from `path` gets at the end of its PATH: its own,
 *  and its interpreter's when neither the PATH nor its own folder reaches it
 *  (npm with its own prefix, `node` from Homebrew). Never on Windows, whose
 *  programs name no interpreter this way. */
export const ownerLocationFolders = (path: string, opts: OutsidePathOptions = {}): string[] => {
  const platform = opts.platform ?? process.platform;
  const own = dirname(path);
  if (platform === 'win32') return [own];
  const serverPath = opts.path ?? process.env.PATH ?? '';
  const interpreter = scriptInterpreter(path);
  if (interpreter === undefined) return [own];
  const reach = createCliBinaryPathResolver({ path: `${serverPath}:${own}`, delimiter: ':', platform });
  if (reach(interpreter) !== undefined) return [own];
  const found = findProgramOutsidePath(interpreter, { ...opts, path: `${serverPath}:${own}` });
  return found === undefined ? [own] : [own, dirname(found)];
};

/** The interpreter a program run from `path` names and cannot reach, even with
 *  `folders` added: the run would fail inside `env`, so the page says why. */
export const unreachableInterpreter = (
  path: string,
  folders: readonly string[],
  serverPath: string = process.env.PATH ?? '',
): string | undefined => {
  const interpreter = scriptInterpreter(path);
  if (interpreter === undefined) return undefined;
  const reach = createCliBinaryPathResolver({ path: [serverPath, ...folders].join(':'), delimiter: ':' });
  return reach(interpreter) === undefined ? interpreter : undefined;
};

/** `env` with `folders` added at the end of its PATH, each only once. Windows
 *  spells the variable as it likes (`Path`), so the existing key is kept. */
export const withFoldersAfterPath = (
  env: NodeJS.ProcessEnv,
  folders: readonly string[],
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv => {
  if (folders.length === 0) return env;
  const key = platform === 'win32'
    ? Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'Path'
    : 'PATH';
  const delimiter = platform === 'win32' ? ';' : ':';
  const entries = (env[key] ?? '').split(delimiter).filter((entry) => entry.length > 0);
  const added = folders.filter((folder) => !entries.includes(folder));
  return { ...env, [key]: [...entries, ...added].join(delimiter) };
};
