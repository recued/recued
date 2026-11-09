/** Can the release a rollback returns to run on the schema another one creates?
 *
 *  ⛔ A ROLLBACK RUNS THE PREVIOUS BINARY ON WHATEVER SCHEMA THE NEW ONE LEFT, unless a
 *  snapshot of the database was taken before the update. The signed manifest's
 *  `migration` decides that snapshot, and it is typed by hand at release time. Two
 *  places now read the schema from the binaries themselves, with the rules below: the
 *  release (release/lib/schema-fingerprint.mjs), against the releases a rollback can
 *  return to across the fleet, and an updating server (apply-orchestrator.ts), against
 *  the one binary its own rollback returns to. They import this one copy, so they
 *  cannot come to disagree about what a release may do to the database.
 *
 *  WHAT THE PREVIOUS RELEASE CAN RUN ON is the rule, not "nothing changed":
 *    - a new table or view: it never reads one it does not know.
 *    - a new index on a new table, or a plain index on any table: its writes keep it.
 *  and what it cannot:
 *    - a higher stored schema version, if it keeps one: it refuses the database
 *      (DATABASE_SCHEMA_TOO_NEW). A release from before versions began never reads it.
 *    - anything removed or changed, a table that only gained a column included: its
 *      statements name the old shape, and an insert that names no columns
 *      (`INSERT INTO database_schema_migrations VALUES (?, ?, ?, ?)`) fails on a new one.
 *    - a UNIQUE index or a trigger on a table it writes: its inserts can now fail, or
 *      something runs on its writes that it never asked for.
 *    - a new table whose foreign key names a table it writes, unless deletes cascade or
 *      set null: the server runs with `foreign_keys = ON`, so its deletes can be refused.
 *
 *  ⚠ A FRESH REALM IS A PROXY. Tables a feature creates on first use (a mail account's,
 *  say) are not in it, and an owner's database reached its shape by upgrades rather than
 *  by one boot. The check covers what every server creates at boot, which is where a
 *  schema change usually lands; it does not prove the rest. Measured 2026-11-06: one
 *  binary booted twice gives the same 970 objects, and each boot takes about 3 s.
 *
 *  ⚠ NODE BUILT-INS ONLY, and `storage/disk-free.ts`, which is one call into `node:fs`.
 *  The release tooling imports this file, and the database is opened through a function
 *  the caller passes, so nothing here loads the native addon. */

import { spawn } from 'node:child_process';
import {
  chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync,
} from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { osFreeBytes } from '../storage/disk-free.js';

export interface SchemaObject {
  type: string;
  name: string;
  table: string;
  sql: string;
}

export interface Schema {
  user_version: number;
  objects: SchemaObject[];
}

export interface ChangedSchemaObject extends SchemaObject {
  before: string;
}

export interface SchemaDiff {
  version: { from: number; to: number } | null;
  added: SchemaObject[];
  removed: SchemaObject[];
  changed: ChangedSchemaObject[];
}

/** A database handle as both SQLite drivers have it. */
export interface SchemaReadable {
  pragma(source: string, options: { simple: true }): unknown;
  prepare(sql: string): { all(): unknown[] };
  close(): unknown;
}

/** A space between two tokens survives only where both sides are word characters;
 *  anywhere else SQLite reads the same thing with or without it. */
const WORD = /[A-Za-z0-9_$]/;

/** DDL minus what does not change the object: comments, whitespace, and letter case
 *  outside quotes. A reformatted CREATE statement is the same table; anything inside
 *  quotes (a default, a CHECK's literal, a quoted name) is kept exactly. */
export const normalizeSql = (sql: string): string => {
  let out = '';
  let space = false;
  const emit = (token: string): void => {
    if (space && out.length > 0 && WORD.test(out[out.length - 1]!) && WORD.test(token[0]!)) out += ' ';
    space = false;
    out += token;
  };
  for (let i = 0; i < sql.length;) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === c && sql[j + 1] !== c)) j += sql[j] === c ? 2 : 1;
      emit(sql.slice(i, j + 1));
      i = j + 1;
    } else if (c === '[') {
      const j = sql.indexOf(']', i + 1);
      const end = j === -1 ? sql.length : j + 1;
      emit(sql.slice(i, end));
      i = end;
    } else if (c === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i + 2);
      i = j === -1 ? sql.length : j + 1;
      space = true;
    } else if (c === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2);
      i = j === -1 ? sql.length : j + 2;
      space = true;
    } else if (/\s/.test(c)) {
      space = true;
      i += 1;
    } else {
      emit(c.toLowerCase());
      i += 1;
    }
  }
  return out;
};

/** Every object a database's schema holds, normalized, plus its stored version. The
 *  caller owns the handle. */
export const readSchemaFrom = (db: SchemaReadable): Schema => {
  const user_version = Number(db.pragma('user_version', { simple: true }));
  const objects = (db.prepare(
    "SELECT type, name, tbl_name AS tbl, sql FROM sqlite_master WHERE sql IS NOT NULL"
      + " AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name",
  ).all() as { type: string; name: string; tbl: string; sql: string }[])
    .map((row) => ({ type: row.type, name: row.name, table: row.tbl, sql: normalizeSql(row.sql) }));
  return { user_version, objects };
};

const keyOf = (object: SchemaObject): string => `${object.type} ${object.name}`;

/** `changed` objects carry the new `sql` and the old as `before`. */
export const diffSchemas = (before: Schema, after: Schema): SchemaDiff => {
  const prior = new Map(before.objects.map((object) => [keyOf(object), object]));
  const next = new Map(after.objects.map((object) => [keyOf(object), object]));
  return {
    version: before.user_version === after.user_version
      ? null
      : { from: before.user_version, to: after.user_version },
    added: after.objects.filter((object) => !prior.has(keyOf(object))),
    removed: before.objects.filter((object) => !next.has(keyOf(object))),
    changed: after.objects
      .filter((object) => prior.has(keyOf(object)) && prior.get(keyOf(object))!.sql !== object.sql)
      .map((object) => ({ ...object, before: prior.get(keyOf(object))!.sql })),
  };
};

/** A normalized CREATE TABLE's column definitions by name; table constraints left out. */
const columnsOf = (sql: string): Map<string, string> => {
  const parts: string[] = [];
  let depth = 0;
  let start = -1;
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === '`') {
      quote = c;
    } else if (c === '[') {
      quote = ']';
    } else if (c === '(') {
      depth += 1;
      if (depth === 1) start = i + 1;
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0) {
        parts.push(sql.slice(start, i));
        break;
      }
    } else if (c === ',' && depth === 1) {
      parts.push(sql.slice(start, i));
      start = i + 1;
    }
  }
  return new Map(parts
    .filter((part) => !/^(constraint|primary key|unique|check|foreign key)\b/.test(part))
    .map((part) => [/^("[^"]*"|`[^`]*`|\[[^\]]*\]|[^\s(]+)/.exec(part)?.[1] ?? part, part]));
};

/** A changed object as the operator needs it: a table's change names its columns. */
export const describeChange = (object: ChangedSchemaObject): string => {
  if (object.type !== 'table') return `${object.type} ${object.name} changed`;
  const before = columnsOf(object.before);
  const after = columnsOf(object.sql);
  const notes = [
    ...[...after.keys()].filter((name) => !before.has(name)).map((name) => `adds column ${name}`),
    ...[...before.keys()].filter((name) => !after.has(name)).map((name) => `drops column ${name}`),
    ...[...after.keys()].filter((name) => before.has(name) && before.get(name) !== after.get(name))
      .map((name) => `redefines column ${name}`),
  ];
  return `table ${object.name} changed (${notes.length > 0 ? notes.join(', ') : 'its constraints or options'})`;
};

/** The tables a foreign key in `sql` names without letting their deletes go through. */
const blockingReferences = (sql: string): string[] => {
  const names: string[] = [];
  for (const match of sql.matchAll(/references\s?("([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z0-9_$]+))/g)) {
    const rest = sql.slice(match.index! + match[0].length);
    const clause = rest.replace(/^\s?\([^)]*\)/, '').split(/[,)]/)[0]!;
    if (!/on delete (cascade|set null|set default)/.test(clause)) {
      names.push((match[2] ?? match[3] ?? match[4] ?? match[5])!.toLowerCase());
    }
  }
  return names;
};

/** Sort a diff into what the previous release can run on and what it cannot. */
export const assessSchemaDiff = (before: Schema, diff: SchemaDiff): { breaking: string[]; additive: string[] } => {
  const priorTables = new Set(before.objects
    .filter((object) => object.type === 'table')
    .map((object) => object.name.toLowerCase()));
  const breaking: string[] = [];
  const additive: string[] = [];
  // A release that keeps a stored schema version refuses a database past its own
  // (DATABASE_SCHEMA_TOO_NEW). One from before versions began (2026-10-19) never reads
  // it, and its fresh realm says 0: what the journal changed shows up object by object.
  if (diff.version && diff.version.from !== 0) {
    breaking.push(`the stored schema version goes from ${diff.version.from} to ${diff.version.to}: `
      + 'the previous release refuses to open the database');
  }
  for (const object of diff.removed) breaking.push(`${object.type} ${object.name} is gone`);
  for (const object of diff.changed) breaking.push(describeChange(object));
  for (const object of diff.added) {
    const onPrior = priorTables.has(object.table.toLowerCase());
    if (object.type === 'index' && onPrior && object.sql.startsWith('create unique index')) {
      breaking.push(`unique index ${object.name} on ${object.table}, which the previous release writes: `
        + 'its inserts can now fail');
    } else if (object.type === 'trigger' && onPrior) {
      breaking.push(`trigger ${object.name} on ${object.table}, which the previous release writes: `
        + 'it runs on that release\'s writes');
    } else if (object.type === 'table' && blockingReferences(object.sql).some((name) => priorTables.has(name))) {
      breaking.push(`table ${object.name} has a foreign key to a table the previous release writes `
        + 'and does not cascade: that release\'s deletes can be refused');
    } else {
      additive.push(`${object.type} ${object.name}`);
    }
  }
  return { breaking, additive };
};

/** The verdict for one pair of schemas: `ok` false is a stop. */
export const schemaGate = ({ previous, current, migration }: {
  previous: Schema;
  current: Schema;
  migration: unknown;
}): { ok: boolean; breaking: string[]; additive: string[]; diff: SchemaDiff } => {
  const diff = diffSchemas(previous, current);
  const { breaking, additive } = assessSchemaDiff(previous, diff);
  return { ok: breaking.length === 0 || migration === true, breaking, additive, diff };
};

const freePort = (): Promise<number> => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as AddressInfo;
    server.close(() => resolvePort(port));
  });
});

/** Lines a failure may show: never a pairing code, a key or a token. */
const shareable = (output: string): string => output.split('\n')
  .filter((line) => !/pair|recovery|token|secret|passphrase|bearer|key/i.test(line))
  .slice(-30)
  .join('\n');

/** Where a throwaway boot's folder starts its name, so a later one can clear what a
 *  killed process left. */
const WORK_PREFIX = '.recued-schema-';
const STALE_WORK_MS = 60 * 60 * 1000;

const mb = (bytes: number): number => Math.floor(bytes / (1024 * 1024));

/** ⛔ A THROWAWAY BOOT WRITES ITS OWN REALM, ON THE DISK THE BINARIES ARE ON. Never the
 *  owner's database: each boot makes a new, empty one, and a real one wrote 9.4 MB at its
 *  peak (6.3 MB once stopped; 26.11.5 on macOS, 2026-11-06). This is room for several. */
export const SCHEMA_BOOT_MIN_DISK_BYTES = 64 * 1024 * 1024;

/** Free bytes where `path` is, or null where the filesystem cannot say: like the update's
 *  own storage preflight, an unknown is not a reason to stop. */
const freeDisk = (probe: (path: string) => number, path: string): number | null => {
  try {
    return probe(path);
  } catch {
    return null;
  }
};

/** A hard link costs no space and no time, and on the binary's own volume always works;
 *  a copy is the fallback (another volume, a filesystem without links).
 *
 *  ⛔ A COPY OF A RELEASE BINARY IS 110 TO 150 MB, made beside a server that is running
 *  and writing to that disk. So it is made only with room for it, and for a realm after. */
export const placeFile = (from: string, to: string, { freeDiskBytes, link = linkSync }: {
  freeDiskBytes?: (path: string) => number;
  link?: (from: string, to: string) => void;
} = {}): void => {
  try {
    link(from, to);
    return;
  } catch {
    // No link: a copy, below.
  }
  const free = freeDiskBytes ? freeDisk(freeDiskBytes, dirname(to)) : null;
  const need = statSync(from).size + SCHEMA_BOOT_MIN_DISK_BYTES;
  if (free !== null && free < need) {
    throw new Error(`${from} could not be linked, and a copy needs ${mb(need)} MB where only ${mb(free)} MB `
      + 'is free, so none was made');
  }
  copyFileSync(from, to);
};

/** Boot `binary` once on an empty realm and read the schema it creates.
 *
 *  The binary runs from a folder of its own (hard links, or copies) that is also its
 *  HOME, with only PATH from this environment and an identity passphrase so the identity
 *  is sealed by that rather than by this machine's keychain. ⛔ NEVER FROM WHERE IT
 *  LIVES: a binary keys its update lease, boot-failure counter and swap files on its own
 *  path, so a server booted beside an install would find that install's staged release
 *  and reconcile it. Nothing of the realm survives. `open` reads the database it made. */
export const freshRealmSchema = async ({
  binary, sidecar, open, timeoutMs = 120_000, workRoot = tmpdir(), freeDiskBytes,
}: {
  binary: string;
  sidecar: string;
  open: (dbPath: string) => SchemaReadable | Promise<SchemaReadable>;
  timeoutMs?: number;
  workRoot?: string;
  /** Asked only where a binary has to be copied rather than linked. */
  freeDiskBytes?: (path: string) => number;
}): Promise<Schema> => {
  const work = mkdtempSync(join(workRoot, WORK_PREFIX));
  try {
    const bin = join(work, 'bin');
    mkdirSync(join(bin, 'lib'), { recursive: true });
    const exe = join(bin, process.platform === 'win32' ? 'recued.exe' : 'recued');
    placeFile(binary, exe, { freeDiskBytes });
    placeFile(sidecar, join(bin, 'lib', 'better_sqlite3.node'), { freeDiskBytes });
    if (process.platform !== 'win32' && (statSync(exe).mode & 0o111) === 0) chmodSync(exe, 0o755);
    const realm = join(work, 'realm');
    const temp = join(work, 'tmp');
    mkdirSync(realm);
    mkdirSync(temp);
    const dbPath = join(realm, 'recued.db');
    const child = spawn(exe, ['--db', dbPath, '--port', String(await freePort())], {
      cwd: realm,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: work,
        USERPROFILE: work,
        TMPDIR: temp,
        ...(process.platform === 'win32'
          ? { TEMP: temp, TMP: temp, SystemRoot: process.env.SystemRoot ?? '' }
          : {}),
        RECUED_IDENTITY_PASSPHRASE: 'recued-schema-fingerprint',
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    // Ended by an exit code, a signal, or a spawn that never ran: 'exit' may not
    // follow 'error', and a process a signal ended has no exit code.
    let ended: string | null = null;
    const exited = new Promise<void>((resolveExit) => {
      child.once('exit', (code, signal) => { ended ??= signal ?? `exit ${code}`; resolveExit(); });
      child.once('error', (error) => { ended ??= error.message; resolveExit(); });
    });
    const until = Date.now() + timeoutMs;
    while (!/Status:/.test(output) && ended === null && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const booted = /Status:/.test(output);
    // Read before the stop below, which ends it too.
    const why = ended ?? `timed out after ${Math.round(timeoutMs / 1000)} s`;
    if (ended === null) {
      child.kill('SIGTERM');
      const killer = setTimeout(() => child.kill('SIGKILL'), 60_000);
      await exited;
      clearTimeout(killer);
    }
    if (!booted) {
      throw new Error(`${binary} did not finish booting a fresh realm (${why}):\n${shareable(output)}`);
    }
    const db = await open(dbPath);
    try {
      return readSchemaFrom(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

/** Clear throwaway boot folders a killed process left in `workRoot` (an hour old, so
 *  never one a running comparison is using). Their hard links pin old binaries' bytes. */
export const sweepStaleSchemaWork = (workRoot: string, now = Date.now()): void => {
  let names: string[];
  try {
    names = readdirSync(workRoot);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(WORK_PREFIX)) continue;
    const path = join(workRoot, name);
    try {
      if (now - statSync(path).mtimeMs > STALE_WORK_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      /* gone already, or not ours to remove */
    }
  }
};

/** ⛔ A THROWAWAY BOOT IS A SECOND SERVER, BESIDE THE ONE THAT IS RUNNING. It peaked at
 *  294 and 301 MB for 26.11.3 and 26.11.5 on linux-arm64 (VmHWM, 2026-11-06). On a small
 *  server without swap the kernel then kills something to make room, and that can be the
 *  running server. So with less than this free, no comparison is booted, and the update
 *  takes the snapshot, which costs disk rather than memory. */
export const SCHEMA_BOOT_MIN_FREE_BYTES = 512 * 1024 * 1024;

/** The binary a rollback returns to, against the one an update is about to swap in:
 *  each boots on an empty realm (about 3 s apiece, measured 2026-11-06), and the second's
 *  schema is sorted by what the first can run on. The folders go in `workRoot`, which
 *  the caller puts on the binaries' own volume so they are hard links rather than
 *  copies.
 *
 *  `availableMemory` is `process.availableMemory()`, which counts a container's limit
 *  and macOS's reclaimable memory; `os.freemem()` does neither (118 MB on a Mac with
 *  4 GB to spare). It and the free disk are asked before each boot: the first one's
 *  memory and realm are gone by the second. Short of either, nothing is started, and the
 *  update goes the way of a comparison that cannot tell: it takes the snapshot, which
 *  its own storage preflight then has to find room for. */
export const compareReleaseSchemas = async ({
  previous, next, open, workRoot, timeoutMs, availableMemory = () => process.availableMemory(),
  freeDiskBytes = osFreeBytes,
}: {
  previous: { binary: string; sidecar: string };
  next: { binary: string; sidecar: string };
  open: (dbPath: string) => SchemaReadable | Promise<SchemaReadable>;
  workRoot: string;
  timeoutMs?: number;
  availableMemory?: () => number;
  freeDiskBytes?: (path: string) => number;
}): Promise<{ breaking: string[]; additive: string[] }> => {
  sweepStaleSchemaWork(workRoot);
  const boot = (release: { binary: string; sidecar: string }): Promise<Schema> => {
    const free = availableMemory();
    if (free < SCHEMA_BOOT_MIN_FREE_BYTES) {
      throw new Error(`only ${mb(free)} MB of memory is free, under the ${mb(SCHEMA_BOOT_MIN_FREE_BYTES)} MB `
        + 'a second server needs beside this one, so none was started');
    }
    const disk = freeDisk(freeDiskBytes, workRoot);
    if (disk !== null && disk < SCHEMA_BOOT_MIN_DISK_BYTES) {
      throw new Error(`only ${mb(disk)} MB is free on the disk the binaries are on, under the `
        + `${mb(SCHEMA_BOOT_MIN_DISK_BYTES)} MB a throwaway realm needs, so none was started`);
    }
    return freshRealmSchema({ ...release, open, workRoot, freeDiskBytes, ...(timeoutMs ? { timeoutMs } : {}) });
  };
  const before = await boot(previous);
  const after = await boot(next);
  return assessSchemaDiff(before, diffSchemas(before, after));
};
