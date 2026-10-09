/** Why the last `recued serve` failed to start — kept beside the database so
 *  `recued status` can say it.
 *
 *  ⛔ WHY THIS EXISTS. A server started by autostart has no terminal: the
 *  macOS LaunchAgent sets no `StandardErrorPath`, so its stderr goes nowhere,
 *  and a systemd unit's goes to a journal the owner does not think to read.
 *  A passphrase-sealed key file whose service lacks `RECUED_IDENTITY_PASSPHRASE`
 *  therefore exits at every start, the supervisor restarts it, and the only
 *  thing an owner sees is `recued status` answering "stopped" (raised by the
 *  owner, 2026-10-07). Any failure before the server listens is covered — a
 *  locked keychain, a busy port, a corrupt database — not only that one.
 *  (Since 2026-10-08 the server also keeps that discarded output in
 *  `recued-server.log` — `cli/server-log.ts` — but this record is still what
 *  lets `status` say why without anyone opening a log.)
 *
 *  - **Cleared at the start of EVERY attempt** (`clearLastStartError`, `bin.ts`),
 *    so it only ever describes the latest one. A start that dies without an
 *    error reaching here — killed, or a path that exits directly — leaves no
 *    record rather than an OLDER one blaming the wrong cause.
 *  - **Written** by the router when `serve` throws BEFORE the server listens
 *    (`recordLastStartError`, `bin.ts`), and by `serve-entry.ts` when an
 *    autostart's realm database cannot be opened (that path exits directly).
 *  - **Cleared** once it listens (`markStartedListening`, the boot-banner tail),
 *    and a later crash is not recorded as a failed START: the flag stops it.
 *  - **Read** by `recued status` when this realm's server is not running.
 *
 *  Node built-ins only: the router imports it, and must not pull in the app. */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const LAST_START_ERROR_FILE = 'recued-server.last-start-error.json';

export interface LastStartError {
  /** Epoch ms of the failed start. */
  readonly at: number;
  /** The version that failed. */
  readonly version: string;
  /** The error, as the process printed it. */
  readonly message: string;
}

export const lastStartErrorPath = (dbPath: string): string =>
  join(dirname(resolve(dbPath)), LAST_START_ERROR_FILE);

/** This process got as far as listening: a later throw is not a failed start. */
let startedListening = false;

/** Record a start that failed. Best-effort: never the reason a boot error is lost. */
export const recordLastStartError = (dbPath: string, error: LastStartError): void => {
  if (startedListening) return;
  try {
    const path = lastStartErrorPath(dbPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(error)}\n`, { mode: 0o600 });
  } catch {
    // The process still prints the error and exits non-zero.
  }
};

/** A new attempt begins: forget the last one's error. */
export const clearLastStartError = (dbPath: string): void => {
  try {
    unlinkSync(lastStartErrorPath(dbPath));
  } catch {
    // Absent is the normal case.
  }
};

/** The server is listening: forget an earlier failed start. */
export const markStartedListening = (dbPath: string): void => {
  startedListening = true;
  try {
    unlinkSync(lastStartErrorPath(dbPath));
  } catch {
    // Absent is the normal case.
  }
};

/** The recorded failed start, or null — absent, unreadable or malformed. */
export const readLastStartError = (dbPath: string): LastStartError | null => {
  try {
    const parsed = JSON.parse(readFileSync(lastStartErrorPath(dbPath), 'utf8')) as Partial<LastStartError>;
    if (typeof parsed.at !== 'number' || typeof parsed.message !== 'string' || typeof parsed.version !== 'string') {
      return null;
    }
    return { at: parsed.at, version: parsed.version, message: parsed.message };
  } catch {
    return null;
  }
};

const ago = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
};

/** What `recued status` prints for it. A value, so the words can be asserted. */
export const lastStartErrorLines = (error: LastStartError, now: number): string[] => [
  `  Its last start failed (${ago(now - error.at)}, ${error.version}):`,
  `    ${error.message}`,
];

/** Tests only: a fresh process. */
export const resetLastStartErrorForTests = (): void => {
  startedListening = false;
};
