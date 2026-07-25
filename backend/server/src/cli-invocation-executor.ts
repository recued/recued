import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { CliInvocationCall, CliInvocationExecutor } from '@recued/engine';
import {
  cliSpawnErrorReason,
  isPinnedCasFileRef,
  isTempFileRef,
  runAttentionForTriggerSource,
  type CliFailureDetail,
  type CliMethodBinding,
  type CliOutputCaptureSpec,
  type CliOutputShape,
  type StallReason,
  type TempFileRef,
} from '@recued/contracts';
import {
  StallMonitor,
  createFileGrowthSource,
  type ProgressSource,
} from './execution/stall-monitor.js';
import { allocateRunScratchDir } from './execution/run-scratch.js';
import type { InFlightRegistry } from './execution/in-flight-registry.js';
import { isInboundFileRecordId } from './collections/file/inbound-file-collection.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120_000;
const CAPTURE_CAP_BYTES = 1024 * 1024;
const DEFAULT_LAUNCH_TIMEOUT_MS = 1_000;
const CLI_FILE_REF_ARRAY_MAX_ITEMS = 32;
/** Default ceiling on a captured tool-output file (`output_capture`). A parsed
 *  document is text and small; a runaway / malformed tool output must fail loud
 *  rather than read an unbounded file into memory before ingest. Overridable via
 *  `CliInvocationExecutorOptions.outputCaptureMaxBytes` (tests shrink it). */
const DEFAULT_OUTPUT_CAPTURE_MAX_BYTES = 64 * 1024 * 1024;

type SpawnFn = typeof nodeSpawn;

/** D-181 Slice 3 — optional overrides for the foreground stall monitor's
 *  windows. Production leaves them at the contract defaults; tests shrink them
 *  so a hung subprocess is detected in milliseconds. */
export interface StallTuning {
  pollMs?: number;
  factorK?: number;
  expectedIntervalMs?: number;
  silentHardCapMs?: number;
}

export interface CliInvocationExecutorOptions {
  spawn?: SpawnFn;
  launchTimeoutMs?: number;
  now?: () => number;
  /** D-181 Slice 3 — foreground stall-monitor window overrides. */
  stallTuning?: StallTuning;
  /** D-181 slice 4 — the in-flight registry. When provided, a foreground
   *  `service` subprocess registers a SIGKILL handle keyed by its run id (from
   *  `call.stepMeta.run_id`) for the duration it runs, so the owner's
   *  `execution.kill` can reach the child. Detached on close/error. Absent ⇒ no
   *  external kill handle (the stall monitor's auto-kill still applies). */
  inFlightRegistry?: InFlightRegistry;
  /** Document-toolkit — sink for `CliOutputCaptureSpec`. When an op declares
   *  `binding.output_capture`, the executor reads the file the cli produced in
   *  its engine-managed temp dir and hands the bytes here to land as a
   *  `data.file.received` record; the returned `record_id` becomes
   *  `result.file_ref`. Absent ⇒ an op that declares `output_capture` fails
   *  closed (it would otherwise silently drop the parsed output). */
  ingestToolOutput?: ToolOutputIngestor;
  /** Document-toolkit — override the captured-output size ceiling (bytes).
   *  Default `DEFAULT_OUTPUT_CAPTURE_MAX_BYTES`. */
  outputCaptureMaxBytes?: number;
  /** SMB-finance slice 3 — read CAS bytes for a `file_ref` so an op that
   *  declares `input_materialize` can materialize that arg to a temp file the
   *  cli reads (storage-gdrive `file.download` → `file_ref` → docling). Absent
   *  ⇒ an op declaring `input_materialize` fails closed. */
  readFileBytes?: (
    record_id: string,
  ) => Promise<{ bytes: Buffer; mime_type: string; filename: string }>;
}

/** A captured cli output file, handed to the ingest sink to become a
 *  `data.file.received` record. Bytes are content-addressed (CAS) by the sink. */
export interface ToolOutputIngestInput {
  bytes: Buffer;
  filename: string;
  mime_type: string;
  /** Per-ingest identity seed
   *  (`<run_id>:<operation_id>:<filename>:<content_sha256>`) — equal-byte resume
   *  is idempotent while fixed-name foreach outputs cannot alias. */
  source_id: string;
}

export type ToolOutputIngestor = (
  input: ToolOutputIngestInput,
) => Promise<{ record_id: string }>;

interface CapturedStream {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

const TEMPLATE_REF_RE = /\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g;
const SCALAR_TYPES = new Set(['string', 'number', 'boolean', 'bigint']);

const resolveTimeoutMs = (raw: unknown): number => {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_TIMEOUT_MS;
  if (raw < MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS;
  if (raw > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
  return raw;
};

const readArg = (args: Record<string, unknown>, key: string): unknown => {
  if (Object.prototype.hasOwnProperty.call(args, key)) return args[key];
  let cur: unknown = args;
  for (const segment of key.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
};

const scalarString = (value: unknown, key: string): string => {
  if (value === null || value === undefined) {
    throw new Error(`cli_invocation arg '${key}' is required`);
  }
  if (!SCALAR_TYPES.has(typeof value)) {
    throw new Error(`cli_invocation arg '${key}' must resolve to a scalar`);
  }
  return String(value);
};

const resolveTemplate = (
  template: string,
  args: Record<string, unknown>,
  extra: Record<string, string> = {},
  opts: { keepCodePlaceholder?: boolean } = {},
): string =>
  template.replace(TEMPLATE_REF_RE, (_match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(extra, key)) return extra[key];
    if (key === 'code' && opts.keepCodePlaceholder) return '{code}';
    return scalarString(readArg(args, key), key);
  });

const scalarStringArray = (value: unknown, key: string): string[] => {
  if (!Array.isArray(value)) {
    throw new Error(`cli_invocation arg '${key}' must resolve to an array`);
  }
  return value.map((item, idx) => scalarString(item, `${key}[${idx}]`));
};

const resolveArgv = (call: CliInvocationCall): string[] => {
  const out: string[] = [];
  for (const entry of call.binding.argv_template) {
    if (typeof entry === 'string') {
      out.push(resolveTemplate(entry, call.args));
      continue;
    }
    out.push(...scalarStringArray(readArg(call.args, entry.expand_arg), entry.expand_arg));
  }
  return out;
};

const commandLabel = (call: CliInvocationCall): string | undefined => {
  const command = call.binding.argv_template[0];
  return typeof command === 'string' && !command.includes('{') ? command : undefined;
};

const resolveCwd = (call: CliInvocationCall): string | undefined => {
  const spec = call.binding.cwd;
  if (spec === undefined) return undefined;
  const tool = commandLabel(call);
  if (typeof spec.arg !== 'string') {
    throw makeCliFailureError(
      `cli_invocation '${call.operation_id}' cwd.arg must be a string template token`,
      { reason: 'spawn_error', ...cliFailureIdentity(call, tool) },
    );
  }
  let raw: string;
  try {
    raw = resolveTemplate(spec.arg, call.args);
  } catch (err) {
    throw makeCliFailureError(
      `cli_invocation '${call.operation_id}' cwd could not be resolved (${err instanceof Error ? err.message : String(err)})`,
      { reason: 'spawn_error', ...cliFailureIdentity(call, tool) },
    );
  }
  const resolved = resolve(raw);
  try {
    const real = realpathSync(resolved);
    if (!statSync(real).isDirectory()) {
      throw new Error('not a directory');
    }
    return real;
  } catch (err) {
    throw makeCliFailureError(
      `cli_invocation '${call.operation_id}' cwd '${raw}' must resolve to an existing directory`,
      {
        reason: 'spawn_error',
        ...cliFailureIdentity(call, tool),
        stderr: err instanceof Error ? err.message : String(err),
      },
    );
  }
};

const isWithinDir = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel));
};

const ensureParentDir = (path: string): void => {
  const dir = dirname(path);
  if (dir !== '.' && dir.length > 0) mkdirSync(dir, { recursive: true });
};

interface DetachedRootDir {
  raw: string;
  real: string;
}

const detachedRootDir = (args: Record<string, unknown>): DetachedRootDir => {
  const root = scalarString(readArg(args, 'result_dir'), 'result_dir');
  const raw = resolve(root);
  mkdirSync(raw, { recursive: true });
  return { raw, real: realpathSync(raw) };
};

const nearestExistingAncestor = (dir: string): string => {
  let cur = dir;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return cur;
};

const confineDetachedPath = (
  label: string,
  path: string,
  root: DetachedRootDir,
): string => {
  const resolved = resolve(path);
  if (!isWithinDir(root.raw, resolved) && !isWithinDir(root.real, resolved)) {
    throw new Error(`detached cli_invocation ${label} must resolve under result_dir`);
  }
  // Anchor check BEFORE creating directories: a symlink planted inside
  // result_dir must not let the recursive mkdir create directories at its
  // target. The post-mkdir parent check stays as the race guard.
  const anchor = realpathSync(nearestExistingAncestor(dirname(resolved)));
  if (!isWithinDir(root.real, anchor)) {
    throw new Error(`detached cli_invocation ${label} parent must resolve under result_dir`);
  }
  ensureParentDir(resolved);
  const parent = realpathSync(dirname(resolved));
  if (!isWithinDir(root.real, parent)) {
    throw new Error(`detached cli_invocation ${label} parent must resolve under result_dir`);
  }
  return resolved;
};

const appendCapture = (stream: CapturedStream, chunk: Buffer): void => {
  if (stream.truncated) return;
  if (stream.bytes + chunk.byteLength > CAPTURE_CAP_BYTES) {
    const remaining = CAPTURE_CAP_BYTES - stream.bytes;
    if (remaining > 0) {
      stream.chunks.push(chunk.subarray(0, remaining));
      stream.bytes += remaining;
    }
    stream.truncated = true;
    return;
  }
  stream.chunks.push(chunk);
  stream.bytes += chunk.byteLength;
};

const capturedText = (stream: CapturedStream): string =>
  Buffer.concat(stream.chunks, stream.bytes).toString('utf8');

/** D-185 Slice 3 — a VALUE shape (`text`/`json`/`jsonl`) is the sole signal that
 *  an op captures stdout into a value; `ref` discards stdout (content via
 *  `file_ref`) and an OMITTED shape is exit-code-only. Replaces the retired
 *  `stdout_handling` field. */
const VALUE_SHAPES: ReadonlySet<string> = new Set(['text', 'json', 'jsonl']);
const isValueShape = (shape: CliOutputShape | undefined): boolean =>
  shape !== undefined && VALUE_SHAPES.has(shape);

/** D-185 Slice 3 — whether THIS op captures stdout into a value. Defense in
 *  depth for content isolation: an `output_capture` op produces a `file_ref` and
 *  must NEVER also capture stdout (the validators reject a value shape alongside
 *  output_capture, so this only fires for a hand-injected malformed binding — it
 *  fails safe by treating the op as ref-only, never emitting both result.stdout
 *  AND result.file_ref). */
const capturesStdoutValue = (binding: CliMethodBinding): boolean =>
  isValueShape(binding.shape) && binding.output_capture === undefined;

/** D-185 Slice 1 — realize captured stdout per the op's declared `shape`. `json`
 *  parses the whole text; `jsonl` parses each non-empty line into an array
 *  (NDJSON). `text` / undefined return the raw string unchanged. Throws a
 *  `SyntaxError` (via `JSON.parse`) on malformed input — the caller rejects the
 *  run with a descriptive message. */
const realizeStdoutShape = (text: string, shape: CliOutputShape | undefined): unknown => {
  if (shape === 'json') return JSON.parse(text);
  if (shape === 'jsonl') {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  }
  return text;
};

const isSuccessfulExit = (
  exit: CliInvocationCall['binding']['exit_code_handling'],
  code: number,
): boolean => {
  if (exit === 'zero_is_success') return code === 0;
  return exit.success_codes.includes(code);
};

const stdinPayload = (
  mode: CliInvocationCall['binding']['stdin_handling'],
  args: Record<string, unknown>,
): string | undefined => {
  if (mode === undefined || mode === 'none') return undefined;
  if (mode === 'pipe_args') return JSON.stringify(args);
  const body = args.body;
  if (typeof body === 'string') return body;
  if (body === undefined || body === null) return '';
  return JSON.stringify(body);
};

const materializedInputBasename = (filename: string, idx: number | undefined): string => {
  const base = (filename.split(/[\\/]/).pop() ?? '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim();
  const safeBase = base.length > 0 ? base : 'input';
  return idx === undefined ? safeBase : `${String(idx + 1).padStart(4, '0')}-${safeBase}`;
};

const normalizeExitCode = (code: number | null, signal: NodeJS.Signals | null): number =>
  code ?? (signal ? -1 : -1);

const waitForLaunch = (
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('spawn', onSpawn);
      child.off('error', onError);
      fn();
    };
    const onSpawn = (): void => finish(resolve);
    const onError = (err: Error): void => finish(() => reject(err));
    const timer = setTimeout(() => {
      finish(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* process may not have spawned yet */
        }
        reject(new Error(`cli_invocation launch timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });

/** D-181 Slice 3 — build the foreground stall monitor for an op that declared
 *  a progress contract. Returns `undefined` when no contract is declared (the
 *  op keeps the tight `timeout_ms` cap, behaviour-neutral). Maps an un-watchable
 *  `file-growth` (no/failed `watch_path`) and the irrelevant `provider-event`
 *  contract down to `silent` (bounded by the generous fail-safe — never a false
 *  no-progress kill). */
const buildForegroundMonitor = (
  call: CliInvocationCall,
  now: () => number,
  tuning: StallTuning,
  cwd: string | undefined,
): StallMonitor | undefined => {
  const spec = call.binding.progress;
  if (!spec) return undefined;

  let source: ProgressSource | undefined;
  if (spec.contract === 'file-growth' && spec.watch_path) {
    try {
      const watchPath = resolveTemplate(spec.watch_path, call.args);
      source = createFileGrowthSource(cwd && !isAbsolute(watchPath) ? resolve(cwd, watchPath) : watchPath);
    } catch {
      source = undefined; // unresolvable watch path → fall back to the cap below
    }
  }
  const effectiveContract = spec.contract === 'heartbeat'
    ? 'heartbeat'
    : spec.contract === 'file-growth' && source
      ? 'file-growth'
      : 'silent';

  return new StallMonitor({
    contract: effectiveContract,
    origin: runAttentionForTriggerSource(call.stepMeta?.trigger_source),
    now,
    ...(source ? { source } : {}),
    ...(tuning.pollMs !== undefined ? { pollMs: tuning.pollMs } : {}),
    ...(tuning.factorK !== undefined ? { factorK: tuning.factorK } : {}),
    ...(tuning.expectedIntervalMs !== undefined ? { expectedIntervalMs: tuning.expectedIntervalMs } : {}),
    ...(tuning.silentHardCapMs !== undefined ? { silentHardCapMs: tuning.silentHardCapMs } : {}),
  });
};

const runForeground = async (
  call: CliInvocationCall,
  argv: string[],
  spawn: SpawnFn,
  now: () => number,
  tuning: StallTuning,
  registry: InFlightRegistry | undefined,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    if (argv.length === 0) {
      reject(makeCliFailureError(
        'cli_invocation argv_template resolved to an empty argv',
        { reason: 'spawn_error', ...cliFailureIdentity(call, undefined) },
      ));
      return;
    }
    const started = now();
    const stdout: CapturedStream = { chunks: [], bytes: 0, truncated: false };
    const stderr: CapturedStream = { chunks: [], bytes: 0, truncated: false };
    // D-182 — a bounded TAIL of stderr for a failure detail (the `stderr`
    // CapturedStream above is head-biased; a tool's real error is at the END).
    const stderrTail: StderrTail = { buf: Buffer.alloc(0), truncated: false };
    const stdin = stdinPayload(call.binding.stdin_handling, call.args);
    const [cmd, ...rest] = argv;
    const cwd = resolveCwd(call);
    let child: ChildProcess;
    try {
      child = spawn(cmd, rest, {
        shell: false,
        stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        ...(cwd ? { cwd } : {}),
      });
    } catch (err) {
      reject(spawnFailureError(call, cmd, err));
      return;
    }

    // D-181 slice 4 — register this `local-heavy` subprocess on the in-flight
    // registry so the owner's `execution.kill` can SIGKILL it. Keyed by run id
    // (a run runs its heavy cli ops sequentially within a step). Detached the
    // moment the child settles (close/error below), so a stale handle never
    // points at a reused pid.
    const killRunId = call.stepMeta?.run_id;
    let killChildId: string | undefined;
    if (registry && killRunId !== undefined && child.pid !== undefined) {
      killChildId = registry.attachSubprocess(killRunId, child.pid, () => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* process already exited */
        }
      });
    }
    const detachKill = (): void => {
      if (registry && killRunId !== undefined && killChildId !== undefined) {
        registry.detachSubprocess(killRunId, killChildId);
      }
    };

    // D-181 Slice 3 — progress-based stall detection for a gated heavy op.
    // When the op declares a progress contract the monitor governs it (no tight
    // cap — heavy ops are uncapped, bounded by progress detection + the human);
    // otherwise the existing foreground `timeout_ms` SIGKILL cap stands.
    const monitor = buildForegroundMonitor(call, now, tuning, cwd);
    const heartbeat = call.binding.progress?.contract === 'heartbeat';
    let stalled = false;
    let stalledReason: StallReason | null = null;
    let progressFlagged = false;
    if (monitor) {
      monitor.start(
        (decision) => {
          // Race guard: if the child already terminated (clean exit / crash)
          // between the last poll and this tick, do NOT declare a stall — let
          // the `close` handler report the real outcome. Otherwise a process
          // that exited successfully just as a tick fired could be rejected as
          // a false stall.
          if (child.exitCode !== null || child.signalCode !== null) return;
          stalled = true;
          stalledReason = decision.reason;
          // D-181 slice-4 follow-up #2 — flag the run stalled BEFORE the SIGKILL
          // so the active list shows it stalled for the brief window before the
          // kill fails the step (the registry clears the flag on completeRun).
          if (registry && killRunId !== undefined) registry.markStalled(killRunId);
          try {
            child.kill('SIGKILL');
          } catch {
            /* process already exited */
          }
        },
        // Attended no-progress flag: the op is NOT killed (the human governs via
        // the slice-4 active list); slice 3 surfaces it as run telemetry so the
        // computed flag is not silently dropped. D-181 slice-4 follow-up #2 —
        // also flag the run on the registry so the active list shows it stalled
        // (the run keeps running; the human decides via the live-control surface).
        () => {
          progressFlagged = true;
          if (registry && killRunId !== undefined) registry.markStalled(killRunId);
        },
      );
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      // D-185 Slice 3 — capture stdout only for a VALUE shape (and never for an
      // output_capture op); `ref`/omitted discard.
      if (capturesStdoutValue(call.binding)) appendCapture(stdout, chunk);
      if (heartbeat) monitor?.signal();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      appendCapture(stderr, chunk);
      appendStderrTail(stderrTail, chunk);
      if (heartbeat) monitor?.signal(); // many cli tools emit progress on stderr (ffmpeg)
    });
    if (stdin !== undefined) {
      child.stdin?.on('error', () => {
        /* child exited before reading stdin; close/error handles outcome */
      });
      child.stdin?.end(stdin);
    }

    let timedOut = false;
    const timeoutMs = resolveTimeoutMs(call.timeout_ms);
    const timer = monitor
      ? undefined
      : setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* process already exited */
        }
      }, timeoutMs);

    child.once('error', (err) => {
      if (timer !== undefined) clearTimeout(timer);
      monitor?.stop();
      detachKill();
      reject(spawnFailureError(call, cmd, err));
    });
    child.once('close', (rawCode, signal) => {
      if (timer !== undefined) clearTimeout(timer);
      monitor?.stop();
      detachKill();
      const exitCode = (timedOut || stalled) ? -9 : normalizeExitCode(rawCode, signal);
      const durationMs = now() - started;
      const result: Record<string, unknown> = {
        mode: 'foreground',
        exit_code: exitCode,
        duration_ms: durationMs,
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
      };
      if (monitor) {
        result.progress_signal_count = monitor.signalCount;
        if (progressFlagged) result.progress_flagged = true;
      }
      if (capturesStdoutValue(call.binding)) {
        result.stdout = capturedText(stdout);
      }
      // D-172 I-4 content isolation — an `input_materialize` op reads Gateway-gated
      // CAS file bytes into the subprocess (via the ungated internal `readBytes`,
      // NOT the audited `handleFileRead`). Its stderr can echo that content on the
      // SUCCESS path — ffmpeg/imagemagick print the input's embedded metadata
      // (title/comment/EXIF), verbose parsers echo snippets — which is the SAME
      // op-step-value echo channel the authoring + catalog validators already close
      // for stdout (an `input_materialize` op may not declare a value shape). So a
      // materialize op's raw stderr must NOT reach the actor-readable op-step value
      // either: an actor holding the cli-op grant but NOT `data-file-read` may
      // PROCESS a file (output flows only via the Gateway-gated `file_ref`) but
      // never SEE its content. The `stderr_truncated` flag stays — telemetry that
      // carries no bytes.
      if (!call.binding.input_materialize) {
        result.stderr = capturedText(stderr);
      }
      if (stalled) {
        reject(makeStallError(stalledReason, monitor?.signalCount ?? 0));
        return;
      }
      if (timedOut) {
        reject(makeCliFailureError(
          `cli tool '${cmd}' timed out after ${timeoutMs}ms`,
          {
            reason: 'timeout',
            ...cliFailureIdentity(call, cmd),
            exit_code: exitCode,
            ...cliFailureStderr(call, stderrTail),
          },
        ));
        return;
      }
      if (!isSuccessfulExit(call.binding.exit_code_handling, exitCode)) {
        reject(makeCliFailureError(
          `cli tool '${cmd}' exited with code ${exitCode}`,
          {
            reason: 'nonzero_exit',
            ...cliFailureIdentity(call, cmd),
            exit_code: exitCode,
            ...cliFailureStderr(call, stderrTail),
          },
        ));
        return;
      }
      // D-185 Slice 1 — realize a typed value from stdout on the SUCCESS path
      // only (a non-zero exit / stall / timeout already rejected above with its
      // real reason, so a parse failure never masks the actual fault). The
      // realized value carries the existing capture cap: a truncated capture
      // can't be parsed into a complete value, so it ERRORS (never silently
      // parses partial bytes) — large output must declare `shape: 'ref'`.
      const shape = call.binding.shape;
      if (capturesStdoutValue(call.binding) && (shape === 'json' || shape === 'jsonl')) {
        // D-182 — the tool exited successfully but its stdout is unusable for the
        // declared shape → `bad_output` (NOT NETWORK_ERROR). Carries exit_code 0 +
        // the stderr tail (a value-shape op is never input_materialize, so stderr
        // is surfaceable).
        if (stdout.truncated) {
          reject(makeCliFailureError(
            `cli tool '${cmd}': stdout exceeded the ${CAPTURE_CAP_BYTES}-byte realize cap for shape '${shape}' — declare shape:'ref' for large output`,
            {
              reason: 'bad_output',
              ...cliFailureIdentity(call, cmd),
              exit_code: exitCode,
              ...cliFailureStderr(call, stderrTail),
            },
          ));
          return;
        }
        try {
          result.stdout = realizeStdoutShape(result.stdout as string, shape);
        } catch (err) {
          reject(makeCliFailureError(
            `cli tool '${cmd}': stdout is not valid ${shape} (${(err as Error).message})`,
            {
              reason: 'bad_output',
              ...cliFailureIdentity(call, cmd),
              exit_code: exitCode,
              ...cliFailureStderr(call, stderrTail),
            },
          ));
          return;
        }
      }
      resolve(result);
    });
  });

/** D-181 Slice 3 — a foreground-kill error carrying the stall telemetry the
 *  Runs surface (slice 5) maps to a `HeavyOpErrorCategory`. `silent_cap` ⇒ the
 *  generous fail-safe tripped (a `timeout`-class outcome); `no_progress` ⇒ the
 *  output stalled (a `stalled`-class outcome). */
interface StallError extends Error {
  heavy_op: { kill_reason: StallReason | null; progress_signal_count: number };
}
const makeStallError = (reason: StallReason | null, signalCount: number): StallError => {
  const label = reason ?? 'no_progress';
  const err = new Error(`cli_invocation killed: ${label} stall detected`) as StallError;
  err.heavy_op = { kill_reason: reason, progress_signal_count: signalCount };
  return err;
};

/** D-182 — cap on the stderr TAIL carried on a cli-failure detail. The capture
 *  buffer holds up to 1 MiB; the failure detail carries only the tail — where a
 *  tool prints its real error after any progress noise — bounded so it rides the
 *  audit row + the chat errors[] without bloating either. */
const STDERR_DETAIL_TAIL_BYTES = 4096;

/** A bounded rolling TAIL of stderr (the LAST `STDERR_DETAIL_TAIL_BYTES` bytes).
 *  The 1 MiB `CapturedStream` is HEAD-biased (keeps the FIRST bytes, for the
 *  success-path `result.stderr`), but a tool's real error is usually at the END —
 *  so a cli-failure detail reads its stderr from this tail, not from a slice of
 *  the head capture. `truncated` flags that earlier stderr was dropped. */
interface StderrTail {
  buf: Buffer;
  truncated: boolean;
}
const appendStderrTail = (tail: StderrTail, chunk: Buffer): void => {
  tail.buf = tail.buf.byteLength === 0 ? chunk : Buffer.concat([tail.buf, chunk]);
  if (tail.buf.byteLength > STDERR_DETAIL_TAIL_BYTES) {
    tail.buf = tail.buf.subarray(tail.buf.byteLength - STDERR_DETAIL_TAIL_BYTES);
    tail.truncated = true;
  }
};

/** A cli-failure-bearing rejected error. The engine preserves `cli_failure` onto
 *  the step error's `details.cli_failure` (the `heavy_op` carrier pattern), and
 *  codes the step from `reason` instead of the catch-all NETWORK_ERROR. */
interface CliFailureError extends Error {
  cli_failure: CliFailureDetail;
}
const makeCliFailureError = (
  message: string,
  detail: CliFailureDetail,
): CliFailureError => {
  const err = new Error(message) as CliFailureError;
  err.cli_failure = detail;
  return err;
};

/** Identity fields every cli-failure detail carries — which op (`slug` →
 *  `source.ingredient_slug`) and which binary (`tool` = `argv[0]`). */
const cliFailureIdentity = (
  call: CliInvocationCall,
  tool: string | undefined,
): Pick<CliFailureDetail, 'slug' | 'operation_id' | 'tool'> => ({
  ...(call.slug ? { slug: call.slug } : {}),
  ...(call.operation_id ? { operation_id: call.operation_id } : {}),
  ...(tool ? { tool } : {}),
});

/** The stderr tail for a cli-failure detail. SUPPRESSED for an `input_materialize`
 *  op (D-172 I-4 — a materialize op's stderr can echo the input file's bytes; the
 *  same gate the success path applies to `result.stderr`). Carries the LAST
 *  `STDERR_DETAIL_TAIL_BYTES` chars; flags truncation when the capture was capped
 *  or the tail was clipped. */
const cliFailureStderr = (
  call: CliInvocationCall,
  tail: StderrTail,
): Pick<CliFailureDetail, 'stderr' | 'stderr_truncated'> => {
  if (call.binding.input_materialize) return {};
  const text = tail.buf.toString('utf8');
  if (text.length === 0) return tail.truncated ? { stderr_truncated: true } : {};
  return tail.truncated ? { stderr: text, stderr_truncated: true } : { stderr: text };
};

/** Classify a process that failed to START. `ENOENT` ⇒ the binary isn't on PATH
 *  (`not_found` — the actionable "tool not installed" case); anything else ⇒
 *  `spawn_error`. Names the binary so the message + the detail say WHICH tool. */
const spawnFailureError = (
  call: CliInvocationCall,
  cmd: string | undefined,
  err: unknown,
): CliFailureError => {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  const reason = cliSpawnErrorReason(code);
  const label = cmd ?? 'cli tool';
  const message =
    reason === 'not_found'
      ? `cli tool '${label}' was not found — the binary may not be installed or is not on the server's PATH`
      : `cli tool '${label}' failed to start (${code ?? (err instanceof Error ? err.message : String(err))})`;
  return makeCliFailureError(message, { reason, ...cliFailureIdentity(call, cmd) });
};

const runDetached = async (
  call: CliInvocationCall,
  argv: string[],
  spawn: SpawnFn,
  now: () => number,
  launchTimeoutMs: number,
): Promise<unknown> => {
  if (argv.length === 0) {
    throw makeCliFailureError(
      'cli_invocation argv_template resolved to an empty argv',
      { reason: 'spawn_error', ...cliFailureIdentity(call, undefined) },
    );
  }
  if (call.binding.stdin_handling !== undefined && call.binding.stdin_handling !== 'none') {
    throw new Error('detached cli_invocation requires stdin_handling none');
  }
  const detached = call.binding.detached;
  if (!detached) throw new Error('detached cli_invocation missing detached spec');
  const started = now();
  const rootDir = detachedRootDir(call.args);
  const logPath = detached.completion.log_pattern
    ? confineDetachedPath(
        'log_pattern',
        resolveTemplate(detached.completion.log_pattern, call.args),
        rootDir,
      )
    : undefined;
  const pidPath = detached.cancel?.pid_pattern
    ? confineDetachedPath(
        'pid_pattern',
        resolveTemplate(detached.cancel.pid_pattern, call.args),
        rootDir,
      )
    : undefined;
  const exitPattern = confineDetachedPath(
    'exit_pattern',
    resolveTemplate(
      detached.completion.exit_pattern,
      call.args,
      {},
      { keepCodePlaceholder: true },
    ),
    rootDir,
  );
  let logFd: number | undefined;
  if (logPath) {
    logFd = openSync(logPath, 'a');
  }
  const [cmd, ...rest] = argv;
  const cwd = resolveCwd(call);
  let child: ChildProcess;
  try {
    const options: SpawnOptions = {
      shell: false,
      detached: true,
      stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
      ...(cwd ? { cwd } : {}),
    };
    child = spawn(cmd, rest, options);
  } catch (err) {
    if (logFd !== undefined) closeSync(logFd);
    throw spawnFailureError(call, cmd, err);
  }
  if (logFd !== undefined) closeSync(logFd);

  child.once('close', (rawCode, signal) => {
    const exitCode = normalizeExitCode(rawCode, signal);
    try {
      const exitPath = resolveTemplate(
        detached.completion.exit_pattern,
        call.args,
        { code: String(exitCode) },
      );
      writeFileSync(confineDetachedPath('exit_pattern', exitPath, rootDir), '', 'utf8');
    } catch {
      /* marker emission is best-effort after launch */
    }
  });

  try {
    await waitForLaunch(child, launchTimeoutMs);
  } catch (err) {
    // A spawn error (ENOENT/EACCES) carries a Node `.code` → classify which tool;
    // the launch-timeout Error has none → `timeout`.
    const code = (err as NodeJS.ErrnoException | null)?.code;
    throw code
      ? spawnFailureError(call, cmd, err)
      : makeCliFailureError(
          err instanceof Error ? err.message : String(err),
          { reason: 'timeout', ...cliFailureIdentity(call, cmd), exit_code: -9 },
        );
  }
  child.unref();
  if (pidPath) {
    writeFileSync(pidPath, String(child.pid ?? ''), 'utf8');
  }

  return {
    mode: 'detached',
    launched: true,
    pid: child.pid ?? null,
    duration_ms: now() - started,
    exit_pattern: exitPattern,
    ...(logPath ? { log_path: logPath } : {}),
    ...(pidPath ? { pid_path: pidPath } : {}),
  };
};

/** Extension a captured output file is expected to carry, keyed by the
 *  `output_capture.mime_type` the binding declares. Used to pick the produced
 *  file when a tool emits sidecars (docling can drop extracted images beside the
 *  `.md`); an unmapped mime falls back to "the single regular file". */
const CAPTURE_MIME_EXT: Record<string, string> = {
  'text/markdown': 'md',
  'text/html': 'html',
  'text/plain': 'txt',
  'application/json': 'json',
  'application/pdf': 'pdf',
  // Media-toolkit by-value cli packs (ffmpeg / imagemagick) write a single
  // fixed-name file into the engine-managed temp dir (e.g. `{out_dir}/audio.mp3`)
  // rather than auto-naming like docling/whisper. Mapping their output mime to an
  // extension keeps the capture deterministic — the produced file is selected by
  // ext, so a stray temp/log file in the dir can never be mis-captured.
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

const capturedOutputError = (
  call: CliInvocationCall,
  message: string,
): CliFailureError => {
  const command = typeof call.binding.argv_template[0] === 'string'
    ? call.binding.argv_template[0]
    : undefined;
  return makeCliFailureError(message, {
    reason: 'bad_output',
    ...cliFailureIdentity(call, command),
  });
};

/** Pick the single file the cli produced in its engine-managed output dir.
 *  Only top-level regular files in the dir WE created (random `mkdtemp` name) +
 *  a name pulled straight from that listing means there is no caller-influenced
 *  path to traverse. Requires exactly one matching file: zero ⇒ the cli claimed
 *  success but wrote nothing (fail loud); more than one ⇒ ambiguous capture
 *  (fail loud rather than guess). Bounds the size BEFORE the caller reads bytes
 *  — a runaway / malformed tool output fails loud rather than OOM-ing the
 *  server. Shared by the `cas` (ingest) and `temp` (D-185 §3.4) backings. */
const selectCapturedFile = (
  outDir: string,
  capture: CliOutputCaptureSpec,
  call: CliInvocationCall,
  maxBytes: number,
): { filePath: string; filename: string } => {
  // D-182 — these are `bad_output` failures: the tool exited successfully but its
  // output is unusable (no / ambiguous / oversized produced file). Classified (not
  // NETWORK_ERROR) so the run names the failing op + tool. No stderr here — the
  // process already closed; the file listing, not stderr, is the diagnostic.
  const ext = CAPTURE_MIME_EXT[capture.mime_type];
  const files = readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const matches = ext
    ? files.filter((name) => name.toLowerCase().endsWith(`.${ext}`))
    : files;
  if (matches.length === 0) {
    throw capturedOutputError(
      call,
      `cli_invocation output_capture: '${call.operation_id}' produced no ${ext ?? 'output'} file`,
    );
  }
  if (matches.length > 1) {
    throw capturedOutputError(
      call,
      `cli_invocation output_capture: '${call.operation_id}' produced ${matches.length} ${ext ?? 'output'} files (expected one)`,
    );
  }
  const filename = matches[0];
  const filePath = join(outDir, filename);
  const { size } = statSync(filePath);
  if (size > maxBytes) {
    throw capturedOutputError(
      call,
      `cli_invocation output_capture: '${call.operation_id}' output ${filename} is ${size} bytes, over the ${maxBytes}-byte cap`,
    );
  }
  return { filePath, filename };
};

/** A fixed PDF capture is authority for the MIME recorded on the durable
 * data.file row. Verify the minimum PDF envelope before CAS ingest so a broken
 * or substituted binary cannot stamp arbitrary bytes as application/pdf. PDF
 * requires a `%PDF-` header and an EOF marker within the final 1,024 bytes. */
const assertCapturedBytesMatchMime = (
  bytes: Buffer,
  capture: CliOutputCaptureSpec,
  call: CliInvocationCall,
): void => {
  if (capture.mime_type !== 'application/pdf') return;
  const headerMatches = bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  const tail = bytes.subarray(Math.max(0, bytes.length - 1_024)).toString('latin1');
  if (!headerMatches || !tail.includes('%%EOF')) {
    throw capturedOutputError(
      call,
      `cli_invocation output_capture: '${call.operation_id}' produced invalid PDF bytes`,
    );
  }
};

/** Explicit `storage: 'cas'` — ingest the produced file into the CAS
 *  (`data.file.received`) and surface a bare `record_id` string as
 *  `result.file_ref` (asymmetric union: a `cas` ref stays a string). */
const captureToolOutputToCas = async (
  outDir: string,
  capture: CliOutputCaptureSpec,
  call: CliInvocationCall,
  ingest: ToolOutputIngestor,
  maxBytes: number,
): Promise<{
  file_ref: string;
  filename: string;
  mime_type: string;
  content_sha256?: string;
  size_bytes?: number;
}> => {
  const { filePath, filename } = selectCapturedFile(outDir, capture, call, maxBytes);
  const bytes = readFileSync(filePath);
  assertCapturedBytesMatchMime(bytes, capture, call);
  const content_sha256 = createHash('sha256').update(bytes).digest('hex');
  // The content suffix is load-bearing for foreach/repeated-op safety. A fixed
  // output name (for example D-200's `document.pdf`) is reused by every call;
  // run+op+filename alone would therefore upsert every iteration onto one
  // data.file record id, making earlier refs resolve to the final iteration's
  // bytes. Same content keeps the same id for crash-resume idempotency while
  // distinct content receives a distinct record inside the same run.
  const source_id = `${call.stepMeta?.run_id ?? 'cli'}:${call.operation_id}:${filename}:${content_sha256}`;
  const { record_id } = await ingest({
    bytes,
    filename,
    mime_type: capture.mime_type,
    source_id,
  });
  return {
    file_ref: record_id,
    filename,
    mime_type: capture.mime_type,
    // D-200 needs an exact identity for the durable PDF without reading the
    // binary back through an actor-visible step. Keep this metadata surface
    // narrow: other CAS-producing CLI ops retain their historical ref-only
    // contract (plus declared filename/MIME) and do not gain a content oracle.
    ...(capture.mime_type === 'application/pdf'
      ? { content_sha256, size_bytes: bytes.length }
      : {}),
  };
};

/** `storage: 'temp'` (D-185 §3.4) — leave the produced file at its run-scoped
 *  path and surface a `TempFileRef`. No CAS, no Gateway round-trip — the file is
 *  reclaimed when `cleanupRunScratch` removes the run-scratch root at run end.
 *  `mime_type` / `filename` ride on the ref so the doc-part consumer builds a
 *  content part without sniffing. */
const captureToolOutputToTemp = (
  outDir: string,
  capture: CliOutputCaptureSpec,
  call: CliInvocationCall,
  maxBytes: number,
): { file_ref: TempFileRef; filename: string; mime_type: string } => {
  const { filePath, filename } = selectCapturedFile(outDir, capture, call, maxBytes);
  const file_ref: TempFileRef = {
    backing: 'temp',
    path: filePath,
    mime_type: capture.mime_type,
    filename,
  };
  return { file_ref, filename, mime_type: capture.mime_type };
};

export const createCliInvocationExecutor = (
  options: CliInvocationExecutorOptions = {},
): CliInvocationExecutor => {
  const spawn = options.spawn ?? nodeSpawn;
  const now = options.now ?? (() => Date.now());
  const tuning = options.stallTuning ?? {};
  const registry = options.inFlightRegistry;
  const ingestToolOutput = options.ingestToolOutput;
  const readFileBytes = options.readFileBytes;
  const outputCaptureMaxBytes = options.outputCaptureMaxBytes ?? DEFAULT_OUTPUT_CAPTURE_MAX_BYTES;
  const launchTimeoutMs = resolveTimeoutMs(
    options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS,
  );

  // The detached / output-capture / foreground dispatch for an already-resolved
  // call (its `input_materialize` arg, if any, already replaced with a temp path).
  const runResolved = async (call: CliInvocationCall): Promise<unknown> => {
    if (call.binding.detached) {
      // Defense-in-depth (the authoring validator already forbids these combos):
      // output_capture is foreground-only — never let a detached job silently
      // drop a declared capture.
      if (call.binding.output_capture) {
        throw new Error(
          `cli_invocation '${call.operation_id}': output_capture is foreground-only and cannot combine with a detached job spec`,
        );
      }
      // D-172 I-4 — input_materialize is foreground-only too: a detached job
      // redirects BOTH stdout and stderr to an on-disk log (`runDetached`,
      // stdio → logFd) and returns its `log_path`, which would re-open the
      // content-echo channel the foreground stderr-suppression above closes (the
      // materialized file's bytes would land in that log). Refuse the combo so the
      // only durable output of a materialize op stays its Gateway-gated `file_ref`.
      if (call.binding.input_materialize) {
        throw new Error(
          `cli_invocation '${call.operation_id}': input_materialize is foreground-only and cannot combine with a detached job spec`,
        );
      }
      return runDetached(call, resolveArgv(call), spawn, now, launchTimeoutMs);
    }
    const capture = call.binding.output_capture;
    if (!capture) {
      return runForeground(call, resolveArgv(call), spawn, now, tuning, registry);
    }
    // Output-capture path: the engine owns a throwaway output dir, binds it to
    // the op's `dir_arg` token (overriding any recipe-supplied value — the
    // recipe never controls where output lands), runs the cli, then realizes the
    // produced file per `storage` (D-185 §2). The `dir_arg` token is engine-
    // owned in BOTH backings, so the captured file always lives in a dir WE made.
    // D-185 Slice 3 — the framework default is `temp` (§2): an op that omits
    // `storage` is throwaway; a kept artifact declares `storage: 'cas'` (or the
    // recipe adds a `core.storage.file.persist` keep-step).
    const storage = call.binding.storage ?? 'temp';

    if (storage === 'temp') {
      // `temp` (D-185 §3.4): the produced file goes under the RUN-SCOPED scratch
      // root and SURVIVES this call (the immediate next step consumes it by
      // `TempFileRef`). It is NOT removed here — the whole run-scratch root is
      // reclaimed in the execute-handler's run-end `finally` (`cleanupRunScratch`).
      // Run-scoped by construction: `allocateRunScratchDir` requires the call's
      // `run_id`, so a `temp` ref can never outlive its run. On a cli FAILURE the
      // partial output also rides the run-end sweep — no per-call cleanup needed.
      const outDir = allocateRunScratchDir(call.stepMeta?.run_id ?? '');
      const callWithDir: CliInvocationCall = {
        ...call,
        args: { ...call.args, [capture.dir_arg]: outDir },
      };
      const base = (await runForeground(
        callWithDir,
        resolveArgv(callWithDir),
        spawn,
        now,
        tuning,
        registry,
      )) as Record<string, unknown>;
      const captured = captureToolOutputToTemp(outDir, capture, call, outputCaptureMaxBytes);
      return { ...base, ...captured };
    }

    // Explicit `cas`: a per-call throwaway temp dir under the OS temp root,
    // ingested into the CAS as a `data.file` ref, removed in `finally` on
    // success AND on any throw — so the only durable copy is the content-
    // addressed, Gateway-gated `data.file` record.
    if (!ingestToolOutput) {
      throw new Error(
        `cli_invocation '${call.operation_id}' declares output_capture but no tool-output ingestor is wired`,
      );
    }
    const tempDir = mkdtempSync(join(tmpdir(), 'recued-cli-out-'));
    try {
      const callWithDir: CliInvocationCall = {
        ...call,
        args: { ...call.args, [capture.dir_arg]: tempDir },
      };
      const base = (await runForeground(
        callWithDir,
        resolveArgv(callWithDir),
        spawn,
        now,
        tuning,
        registry,
      )) as Record<string, unknown>;
      const captured = await captureToolOutputToCas(
        tempDir,
        capture,
        call,
        ingestToolOutput,
        outputCaptureMaxBytes,
      );
      return { ...base, ...captured };
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup — the OS temp reaper backstops a rare rm failure */
      }
    }
  };

  // SMB-finance slice 3 — input_materialize wrapper. When an op declares
  // `input_materialize` (docling's `source`), resolve that arg's bare or
  // content-pinned CAS `file_ref` to a throwaway temp file the cli reads,
  // substitute the temp path into the arg, run, then remove the temp dir in a
  // `finally`. A content pin is checked against the exact buffer written to the
  // input path, closing record-id check/use drift before spawn. Wraps
  // `runResolved` OUTSIDE its own output-capture try/finally so an op with BOTH
  // (docling: materialize `source`, capture `output_dir`) cleans both temp dirs.
  //
  // Authorization posture (Codex review HIGH-1; D-172 I-4 content isolation): the
  // materialize reads CAS bytes WITHOUT a `data-file-read` admission probe (the
  // ai-* file_ref read has one — D-172 P5). This is INTENTIONAL — an actor may
  // PROCESS a file it cannot read. The exfil is closed by isolating the content
  // from every actor-readable op-step value: (1) the op is itself grant-gated;
  // (2) the validators forbid an `input_materialize` op a value shape, so stdout
  // is discarded; (3) `runForeground` suppresses raw `stderr` for materialize ops
  // (ffmpeg/imagemagick/verbose parsers echo input metadata/snippets to stderr on
  // success — the symmetric channel to stdout, now closed); (4) `detached` +
  // `input_materialize` is refused (a detached log file would re-open both
  // channels). So the op's ONLY readable output is its own `output_capture`
  // file_ref — whose read by a later ai-* / data-file-read step IS P5-gated. An
  // actor lacking `data-file-read` can run docling on a ref but can never SEE the
  // content through any stream. (The bytes-into-subprocess read is itself
  // unaudited — a documented I-4 audit residual; it is not actor-egress once the
  // four channels above are closed.)
  return async (call) => {
    const materialize = call.binding.input_materialize;
    if (!materialize) return runResolved(call);
    const tempDir: { path?: string } = {};
    const ensureTempDir = (): string => {
      tempDir.path ??= mkdtempSync(join(tmpdir(), 'recued-cli-in-'));
      return tempDir.path;
    };
    const materializeOne = async (value: unknown, idx?: number): Promise<string> => {
      // D-185 Slice 2 — a `temp` ref (a prior `storage:'temp'` op's run-scoped
      // output, e.g. the ffmpeg→whisper pipe) ALREADY is a local file: substitute
      // its path straight into the arg — no CAS read, no re-materialize.
      if (isTempFileRef(value)) return value.path;
      // The materialize arg can otherwise carry EITHER a CAS file_ref (the
      // storage-gdrive download lane) OR a literal local path / URL (the manual
      // lane — docling's `source` serves both). Only a recognized
      // `data.file.received` record_id is materialized from the CAS; anything else
      // passes through to the cli as-is.
      const pinned = isPinnedCasFileRef(value) ? value : null;
      const recordId = pinned?.record_id ?? value;
      if (!isInboundFileRecordId(recordId)) {
        return scalarString(value, idx === undefined
          ? materialize.arg
          : `${materialize.arg}[${idx}]`);
      }
      if (!readFileBytes) {
        throw new Error(
          `cli_invocation '${call.operation_id}' declares input_materialize but no file reader is wired`,
        );
      }
      const { bytes, filename } = await readFileBytes(recordId);
      if (pinned !== null) {
        const actualSha256 = createHash('sha256').update(bytes).digest('hex');
        if (actualSha256 !== pinned.content_sha256) {
          throw new Error(
            `cli_invocation '${call.operation_id}' input_materialize arg '${materialize.arg}' content pin mismatch`,
          );
        }
      }
      const inputPath = join(ensureTempDir(), materializedInputBasename(filename, idx));
      writeFileSync(inputPath, bytes);
      return inputPath;
    };

    try {
      if (materialize.kind === 'file_ref_array') {
        const raw = readArg(call.args, materialize.arg);
        if (!Array.isArray(raw)) {
          throw new Error(
            `cli_invocation '${call.operation_id}' input_materialize arg '${materialize.arg}' must be an array`,
          );
        }
        const minItems = materialize.min_items ?? 1;
        const maxItems = materialize.max_items ?? CLI_FILE_REF_ARRAY_MAX_ITEMS;
        if (raw.length < minItems) {
          throw new Error(
            `cli_invocation '${call.operation_id}' input_materialize arg '${materialize.arg}' has ${raw.length} item(s), below min_items ${minItems}`,
          );
        }
        if (raw.length > maxItems || raw.length > CLI_FILE_REF_ARRAY_MAX_ITEMS) {
          throw new Error(
            `cli_invocation '${call.operation_id}' input_materialize arg '${materialize.arg}' has ${raw.length} item(s), over max_items ${Math.min(maxItems, CLI_FILE_REF_ARRAY_MAX_ITEMS)}`,
          );
        }
        const materialized = await Promise.all(raw.map((value, idx) => materializeOne(value, idx)));
        const callMaterialized: CliInvocationCall = {
          ...call,
          args: { ...call.args, [materialize.arg]: materialized },
        };
        return await runResolved(callMaterialized);
      }
      const inputPath = await materializeOne(readArg(call.args, materialize.arg));
      const callMaterialized: CliInvocationCall = {
        ...call,
        args: { ...call.args, [materialize.arg]: inputPath },
      };
      return await runResolved(callMaterialized);
    } finally {
      if (tempDir.path !== undefined) {
        try {
          rmSync(tempDir.path, { recursive: true, force: true });
        } catch {
          /* best-effort cleanup — the OS temp reaper backstops a rare rm failure */
        }
      }
    }
  };
};
