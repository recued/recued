export type BootCommandProfile =
  | 'none'
  | 'daemon'
  | 'pair'
  | 'audit'
  | 'llm'
  | 'archive'
  | 'update'
  /** D-212 §7.11 — re-create an unopenable keyfile from the recovery key. Its
   *  own profile because it must run when the server cannot boot. */
  | 'recover-keyfile'
  /** D-212 — re-seal the keyfile under a new passphrase. Separate from
   *  recovery: it keeps the identity, and needs no recovery key. */
  | 'rotate-passphrase'
  /** D-178 — the outer supervisor's verdict. Its own profile because it must run
   *  when the LIVE binary cannot start at all; `recued.old` executes it. */
  | 'report-boot-failure'
  | 'revert-release'
  | 'self-test'
  | 'update-lease'
  | 'release-floor'
  | 'mcp'
  | 'serve'
  | 'command';

export interface BootProfileInput {
  subcommand?: string;
  version: boolean;
  help?: boolean;
  mcp: boolean;
}

export interface BootTraceEvent {
  tag: 'recued.boot';
  entrypoint: string;
  profile: BootCommandProfile;
  phase: string;
  elapsed_ms: number;
  db_open_attempted: boolean;
  command?: string;
  detail?: string;
}

export interface BootTrace {
  enabled: boolean;
  mark: (phase: string, detail?: string) => void;
  markImport: (specifier: string) => void;
  markDbOpenAttempted: (detail?: string) => void;
  finish: (phase?: string, detail?: string) => void;
}

export interface BootTraceOptions {
  entrypoint: string;
  profile: BootCommandProfile;
  command?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  sink?: (line: string) => void;
}

const DAEMON_SUBCOMMANDS = new Set([
  'start',
  'stop',
  'status',
  'restart',
  'logs',
  'auth-status',
  'unlock',
  'lock',
]);

const defaultNow = (): number => Date.now();

const defaultSink = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

export const isBootTraceEnabled = (
  env: Record<string, string | undefined> = process.env,
): boolean => env.RECUED_BOOT_TRACE === '1';

export const classifyBootProfile = (input: BootProfileInput): BootCommandProfile => {
  if (input.version || input.help) return 'none';
  if (input.mcp) return 'mcp';
  if (!input.subcommand || input.subcommand === 'serve') return 'serve';
  if (DAEMON_SUBCOMMANDS.has(input.subcommand)) return 'daemon';
  if (input.subcommand === 'pair') return 'pair';
  if (input.subcommand === 'audit') return 'audit';
  if (input.subcommand === 'llm') return 'llm';
  if (input.subcommand === 'archive') return 'archive';
  if (input.subcommand === 'update') return 'update';
  if (input.subcommand === 'recover-keyfile') return 'recover-keyfile';
  if (input.subcommand === 'rotate-passphrase') return 'rotate-passphrase';
  if (input.subcommand === 'report-boot-failure') return 'report-boot-failure';
  // The `docker-thin` launcher's half of the same supervisor pair — see
  // `cli-context/revert-release.ts`. Its own profile rather than `command`
  // because, like its sibling, it must open nothing and boot nothing.
  if (input.subcommand === 'revert-release') return 'revert-release';
  // The installer's post-swap probe. Its own profile because, like its siblings,
  // it must boot nothing — the whole point is to load ONE thing and see if it
  // works.
  if (input.subcommand === 'self-test') return 'self-test';
  if (input.subcommand === 'update-lease') return 'update-lease';
  if (input.subcommand === 'release-floor') return 'release-floor';
  return 'command';
};

export const createBootTrace = (options: BootTraceOptions): BootTrace => {
  const enabled = isBootTraceEnabled(options.env);
  const now = options.now ?? defaultNow;
  const sink = options.sink ?? defaultSink;
  const startedAt = now();
  let dbOpenAttempted = false;
  let finished = false;

  const emit = (phase: string, detail?: string): void => {
    if (!enabled) return;
    const event: BootTraceEvent = {
      tag: 'recued.boot',
      entrypoint: options.entrypoint,
      profile: options.profile,
      phase,
      elapsed_ms: Math.max(0, Math.round(now() - startedAt)),
      db_open_attempted: dbOpenAttempted,
      ...(options.command ? { command: options.command } : {}),
      ...(detail ? { detail } : {}),
    };
    sink(`[recued boot] ${JSON.stringify(event)}`);
  };

  const trace: BootTrace = {
    enabled,
    mark: emit,
    markImport: (specifier) => emit('import', specifier),
    markDbOpenAttempted: (detail) => {
      dbOpenAttempted = true;
      emit('db-open-attempted', detail);
    },
    finish: (phase = 'complete', detail) => {
      if (finished) return;
      finished = true;
      emit(phase, detail);
    },
  };

  emit('trace-start');
  return trace;
};
