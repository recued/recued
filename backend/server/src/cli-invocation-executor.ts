import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
  createReadStream,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { CliInvocationCall, CliInvocationExecutor } from '@recued/engine';
import {
  CLI_BINDING_ENV_NAMES,
  cliSpawnErrorReason,
  isD259CliProgressSpec,
  isReadyCliDetachedSupervisionSpec,
  isInPlaceCapture,
  isProgressAnswerCapture,
  isStdoutCapture,
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
import { ResourceProgressSource } from './execution/resource-progress-source.js';
import type { ProgressContract } from '@recued/contracts';
import { allocateRunScratchDir } from './execution/run-scratch.js';
import { envForOthers } from './supervision/env-for-others.js';
import { assertPreapprovalOrdinaryRun, currentPreapprovalIo } from './preapproval-io-context.js';
import type { InFlightRegistry } from './execution/in-flight-registry.js';
import { isInboundFileRecordId } from './collections/file/inbound-file-collection.js';
import { parseRemoteFileRecordId } from './file-view-resolver.js';
import {
  killProcessGroup,
  reapProcessGroupAfterLeaderExit,
} from './supervision/process-group-kill.js';
import {
  cliProgressAdapterStream,
  createCliProgressAdapter,
} from './execution/cli-progress-adapters.js';

/** D-241 P4 — the two id shapes `input_materialize` will fetch: a CAS
 *  `data.file.received` record (`file:<32 hex>`) and a File Source MIRROR row
 *  (`file:remote:<scope>:<target>`), whose bytes the wired reader pulls from the
 *  vendor.
 *
 *  ⛔ **`isInboundFileRecordId` is deliberately NOT widened to cover both.** It
 *  means "a CAS record id" and `file-view-resolver.ts` uses it to ROUTE cas-vs-
 *  remote — widening it there would make the router answer "cas" for a remote
 *  row. The union belongs here, at the one caller that treats both the same.
 *
 *  ⚠ Anything else is a literal path / URL and passes through to the cli
 *  untouched (docling's `source` serves both lanes) — which is exactly why a
 *  remote id had to JOIN this predicate rather than rely on the reader: an
 *  unrecognized ref is not an error, it is a filename, so the failure would
 *  have been the tool reporting it could not open a file called
 *  `file:remote:ZHJvcGJveC…`. */
const isMaterializableFileRef = (value: unknown): value is string =>
  isInboundFileRecordId(value)
  || (typeof value === 'string' && parseRemoteFileRecordId(value) !== null);

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 100;
// ⛔ NO UPPER CLAMP. The authored `timeout_ms` is honoured as declared; this
// end and the authoring end are floor-only for cli, and clamping here would
// silently hand a pack a shorter wall than it asked for — which is what the
// old 120s clamp did to a 90s-capped author for as long as both existed.
/** Keep the existing by-value stdout channel small. D-259 removes the 64 MiB
 * produced-file ceiling by streaming file refs; it must not turn that old file
 * bound into permission to send 64 MiB of stdout through recipes/the model. */
const CAPTURE_CAP_BYTES = 1024 * 1024;
const DEFAULT_LAUNCH_TIMEOUT_MS = 1_000;
const CLI_FILE_REF_ARRAY_MAX_ITEMS = 32;
/** Compatibility-only guard for the legacy byte ingestor. Production streams
 * captured files by path and has no file-size ceiling; embedders that still
 * accept a single Buffer must remain bounded to avoid an unbounded read. */
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
  /** D-274 — how often the `resource` source actually samples the process
   *  tree. Production leaves it at `RESOURCE_SAMPLE_MS` (15s, deliberately slow
   *  so a `ps` spawn per poll never happens); tests shrink it so a stalled tree
   *  is observed in milliseconds. */
  resourceSampleMs?: number;
  /** D-274 — the meaningful-window floor below which "did not move" is not a
   *  claim the sampler can make (`MIN_COMPARISON_MS`). Tests shrink it so a
   *  stalled tree is CONCLUDED in milliseconds rather than after 5s. */
  resourceMinComparisonMs?: number;
  /** D-274 — inject the process-tree sampler. Tests use this so an executor-level
   *  assertion about FLAGGING does not depend on how fast a real `ps -A` returns
   *  under whatever else the machine is doing. The physics (does a still tree
   *  read as still?) is covered deterministically in
   *  `resource-progress-source.test.ts`; this seam lets the executor suite assert
   *  the WIRING without re-asserting the physics. */
  resourceSampler?: ConstructorParameters<typeof ResourceProgressSource>[0]['sampler'];
}

export interface CliInvocationExecutorOptions {
  spawn?: SpawnFn;
  /** Process-tree termination seam. Production defaults to the shared
   * cross-platform group killer. The same seam reaps any descendants left when
   * a finite leader exits. Tests with a synthetic spawn default to the child
   * mock's `kill` unless they inject this explicitly. */
  killProcessTree?: (pid: number, signal: NodeJS.Signals) => void;
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
  /** Migrated long-lived daemons are established by the single supervisor,
   *  including when invoked from a recipe. The supervisor's own raw spawn
   *  passes a binding with `supervision` removed, avoiding recursion. */
  startSupervisedDaemon?: (call: CliInvocationCall) => Promise<unknown>;
  /** Document-toolkit — sink for `CliOutputCaptureSpec`. When an op declares
   *  `binding.output_capture`, the executor reads the file the cli produced in
   *  its engine-managed temp dir and hands the bytes here to land as a
   *  `data.file.received` record; the returned `record_id` becomes
   *  `result.file_ref`. Absent ⇒ an op that declares `output_capture` fails
   *  closed (it would otherwise silently drop the parsed output). */
  ingestToolOutput?: ToolOutputIngestor;
  /** Ceiling for the compatibility byte-ingestor path. Ignored when the
   *  streaming `ingestToolOutputFile` path is wired. */
  outputCaptureMaxBytes?: number;
  /** Streaming counterpart used by production. The source path remains owned
   *  by the executor and is deleted only after this Promise resolves. */
  ingestToolOutputFile?: ToolOutputFileIngestor;
  /** SMB-finance slice 3 — read CAS bytes for a `file_ref` so an op that
   *  declares `input_materialize` can materialize that arg to a temp file the
   *  cli reads (storage-gdrive `file.download` → `file_ref` → docling). Absent
   *  ⇒ an op declaring `input_materialize` fails closed. */
  readFileBytes?: (
    record_id: string,
  ) => Promise<{ bytes: Buffer; mime_type: string; filename: string }>;
  /** Parent directory for this executor's throwaway `recued-cli-in-*` /
   *  `recued-cli-out-*` dirs. Defaults to `os.tmpdir()`, which is what the
   *  server uses.
   *
   *  ⛔ **Exists because "did the executor clean up after itself?" was being
   *  asserted against `os.tmpdir()` GLOBALLY, and a global surface is not the
   *  asserting suite's to own.** Under `pool: 'threads'` any concurrently
   *  running suite's in-flight dir enters the snapshot, so two sibling suites
   *  red each other for reasons neither one caused. Injecting the root makes the
   *  claim local and exact: a suite owns its own directory, so "empty afterwards"
   *  is both attributable and STRONGER than the old form — it catches a leaked
   *  EMPTY dir, which no content-based attribution can.
   *
   *  ⚠ A seam of the same class as `spawn` and `now`, which this executor
   *  already takes. Nothing in production passes it. */
  tempRoot?: string;
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

export interface ToolOutputFileIngestInput {
  src_path: string;
  filename: string;
  mime_type: string;
  content_hash: string;
  size_bytes: number;
  source_id: string;
}

export type ToolOutputFileIngestor = (
  input: ToolOutputFileIngestInput,
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
  if (raw === 0) return 0;
  if (raw < MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS;
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

/** The environment for the op's process: `envForOthers()` (the server's own,
 *  minus what is the server's alone), with two changes.
 *
 *  ⛔ `PWD` names the folder the child starts in. Started in another folder,
 *  the child would otherwise inherit a `PWD` naming the SERVER's — and opencode
 *  takes its working folder from `PWD` over the real one, so it ran its commands
 *  in the server's folder and refused the repository as outside it (measured).
 *  A shell sets `PWD` on every `cd`; a spawn with a `cwd` must too.
 *
 *  Then the binding's pinned variables. The validators admit only
 *  `CLI_BINDING_ENV_NAMES`; this re-checks, so a binding that reached the
 *  executor any other way still cannot set another variable (`PWD` included).
 *
 *  ⛔ NEVER `undefined`. It used to be when there was neither, and an omitted
 *  `env` hands the child the server's environment WHOLE, the identity
 *  passphrase included (`supervision/env-for-others.ts`). */
const resolveChildEnv = (call: CliInvocationCall, cwd: string | undefined): NodeJS.ProcessEnv => {
  const pinned = call.binding.env;
  const env = envForOthers();
  if (cwd !== undefined) env.PWD = cwd;
  if (pinned === undefined) return env;
  const allowed: ReadonlySet<string> = new Set(CLI_BINDING_ENV_NAMES);
  for (const [name, value] of Object.entries(pinned as Record<string, unknown>)) {
    if (!allowed.has(name) || typeof value !== 'string') {
      throw makeCliFailureError(
        `cli_invocation '${call.operation_id}' env may pin only ${CLI_BINDING_ENV_NAMES.join(', ')} to string values`,
        { reason: 'spawn_error', ...cliFailureIdentity(call, commandLabel(call)) },
      );
    }
    env[name] = value;
  }
  return env;
};

/** The live argv, working scope, stdin and timeout builders, without launching
 * a program or materializing any caller file. Pinned environment variables
 * change what the program does, so they are part of the description — but only
 * when the binding pins some, so an op that pins none keeps the identity it
 * always had. */
export const describeCliInvocation = (call: CliInvocationCall) => ({
  argv: resolveArgv(call), cwd: resolveCwd(call) ?? process.cwd(),
  stdin: stdinPayload(call.binding.stdin_handling, call.args) ?? null,
  timeout_ms: resolveTimeoutMs(call.timeout_ms),
  ...(call.binding.env !== undefined ? { env: { ...call.binding.env } } : {}),
});

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
  killProcessTree?: (pid: number, signal: NodeJS.Signals) => void,
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
        if (child.pid !== undefined && killProcessTree) {
          killProcessTree(child.pid, 'SIGKILL');
        } else {
          try {
            child.kill('SIGKILL');
          } catch {
            /* process may not have spawned yet */
          }
        }
        reject(new Error(`cli_invocation launch timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });

/** D-181 Slice 3 / D-274 — build the foreground stall monitor.
 *
 *  ⛔ D-274 — THIS USED TO RETURN `undefined` FOR AN UNDECLARED BINDING, and
 *  the caller's `if (monitor)` put BOTH the auto-kill arm and the attended
 *  flag arm behind that gate. 455 of 457 shipped cli ops declare nothing — they
 *  cannot, because `heartbeat` and `file-growth` both require the tool to EMIT
 *  something — so the whole D-181 live-control apparatus was dark for 99.6% of
 *  the surface and the authored `timeout_ms` was their only guard.
 *
 *  An undeclared binding now gets the host-assigned `resource` contract: OS
 *  accounting of the process tree, which needs no cooperation from the tool.
 *  It is REPORT-ONLY (`flagOnly`) — it surfaces the run on the active list for
 *  the watching human and never kills, because the signal is universal but
 *  noisy. An explicit declaration still wins; only the absent case changes.
 *
 *  A legacy un-watchable `file-growth` declaration maps to `silent` to preserve
 *  its fail-safe-only behavior. A strict D-259 declaration instead observes zero
 *  progress and reaches its explicit stall threshold; a broken path must not
 *  silently disable the only bound on `timeout_ms: 0`. */
const buildForegroundMonitor = (
  call: CliInvocationCall,
  now: () => number,
  tuning: StallTuning,
  cwd: string | undefined,
  // `silent` is excluded deliberately: a silent contract HAS no signal to
  // report, so a callback that accepted it would describe a call that cannot
  // happen — and the registry's own signature already says so.
  onProgressSignal?: (contract: Exclude<ProgressContract, 'silent'>, at: number) => void,
  pid?: number,
): StallMonitor | undefined => {
  const spec = call.binding.progress;
  if (!spec) {
    // No pid ⇒ nothing to sample. Returning undefined here is the honest
    // answer, not a fallback: it restores exactly the prior behaviour for a
    // call that never got a process.
    if (pid === undefined) return undefined;
    return new StallMonitor({
      contract: 'resource',
      origin: runAttentionForTriggerSource(call.stepMeta?.trigger_source),
      now,
      source: new ResourceProgressSource({
        pid,
        ...(tuning.resourceSampleMs !== undefined ? { sampleMs: tuning.resourceSampleMs } : {}),
        ...(tuning.resourceMinComparisonMs !== undefined
          ? { minComparisonMs: tuning.resourceMinComparisonMs }
          : {}),
        ...(tuning.resourceSampler !== undefined ? { sampler: tuning.resourceSampler } : {}),
      }),
      onSignal: (at: number) => onProgressSignal?.('resource', at),
      ...(tuning.pollMs !== undefined ? { pollMs: tuning.pollMs } : {}),
      ...(tuning.factorK !== undefined ? { factorK: tuning.factorK } : {}),
      ...(tuning.expectedIntervalMs !== undefined ? { expectedIntervalMs: tuning.expectedIntervalMs } : {}),
      // ⛔ D-274 L1 — `SILENT_OP_HARD_CAP_MS` is 30 minutes and `evaluateStall`
      // kills an ATTENDED run on it, so a resource monitor that inherited it
      // would SIGKILL whisper (authored 4h) at minute 30. The authored
      // `timeout_ms`, enforced below, is the real backstop.
      //
      // ⚠ HONESTLY: this line is UNREACHABLE while `flagOnly` holds — that
      // forces `stalled = false` on both origins, so the cap cannot fire and
      // deleting this changes nothing observable (verified by mutation, not
      // assumed). It is kept for ONE reason: §3 leaves "may unattended kill on
      // the resource signal?" open pending the telemetry harvest, and the
      // change that answers yes would clear `flagOnly` — silently reviving L1
      // at 30 minutes. This line is the guard for that future edit, not for
      // today's behaviour. Do not read it as the thing preventing the kill.
      silentHardCapMs: Number.POSITIVE_INFINITY,
      flagOnly: true,
    });
  }

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
    : spec.contract === 'file-growth'
      ? 'file-growth'
      : 'silent';

  return new StallMonitor({
    contract: effectiveContract,
    origin: runAttentionForTriggerSource(call.stepMeta?.trigger_source),
    now,
    ...(effectiveContract === 'heartbeat' || effectiveContract === 'file-growth'
      ? { onSignal: (at: number) => onProgressSignal?.(effectiveContract, at) }
      : {}),
    ...(source ? { source } : {}),
    ...(tuning.pollMs !== undefined ? { pollMs: tuning.pollMs } : {}),
    factorK: 1,
    expectedIntervalMs: spec.stall_ms,
    silentHardCapMs: Number.POSITIVE_INFINITY,
    killOnNoProgress: true,
  });
};

/** A stdout capture's sink: the child's stdout is written to an ENGINE-CHOSEN
 *  path as it arrives, instead of being buffered into a value. Passed only by
 *  the `from_stdout` capture branch — every other caller leaves it undefined and
 *  the stream behaves exactly as before. */
export interface StdoutFileSink {
  /** Append one chunk. May throw when a compatibility byte ceiling is active. */
  write: (chunk: Buffer) => void;
}

/** Where a successful run leaves the final answer its heartbeat adapter read
 *  off the protocol. Passed only by the `from_progress_answer` capture branch,
 *  which writes it to an engine-owned file — never into the result value. */
interface ProgressAnswerOut {
  answer?: string;
  /** The tool's own failure report, for a run that ended without an answer. */
  failure?: string;
}

const runForeground = async (
  call: CliInvocationCall,
  argv: string[],
  spawn: SpawnFn,
  now: () => number,
  tuning: StallTuning,
  registry: InFlightRegistry | undefined,
  killProcessTree: ((pid: number, signal: NodeJS.Signals) => void) | undefined,
  reapProcessTreeAfterExit: ((pid: number, signal: NodeJS.Signals) => void) | undefined,
  stdoutSink?: StdoutFileSink,
  answerOut?: ProgressAnswerOut,
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
    // Set when the stdout sink refuses a chunk (ceiling). Surfaced on exit in
    // preference to the exit code — a SIGKILLed child would otherwise report as
    // a generic tool failure and hide the real reason.
    let sinkFailure: Error | undefined;
    // D-182 — a bounded TAIL of stderr for a failure detail (the `stderr`
    // CapturedStream above is head-biased; a tool's real error is at the END).
    const stderrTail: StderrTail = { buf: Buffer.alloc(0), truncated: false };
    const stdin = stdinPayload(call.binding.stdin_handling, call.args);
    const [cmd, ...rest] = argv;
    const cwd = resolveCwd(call);
    const env = resolveChildEnv(call, cwd);
    if (call.signal?.aborted) {
      reject(new Error(`cli_invocation '${call.operation_id}' cancelled before spawn`));
      return;
    }
    let child: ChildProcess;
    try {
      assertPreapprovalOrdinaryRun();
      child = spawn(cmd, rest, {
        shell: false,
        // Waiting and ownership are independent: every finite child leads a
        // process group so timeout, owner kill, stall, and budget abort reach
        // descendants too.
        detached: true,
        stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        ...(cwd ? { cwd } : {}),
        env,
      });
    } catch (err) {
      reject(spawnFailureError(call, cmd, err));
      return;
    }

    const killTree = (): void => {
      if (child.pid !== undefined && killProcessTree !== undefined) {
        killProcessTree(child.pid, 'SIGKILL');
        return;
      }
      try {
        child.kill('SIGKILL');
      } catch {
        /* process already exited */
      }
    };

    // D-181 slice 4 — register this `local-heavy` subprocess on the in-flight
    // registry so the owner's `execution.kill` can SIGKILL it. Keyed by run id
    // (a run runs its heavy cli ops sequentially within a step). Detached the
    // moment the child settles (close/error below), so a stale handle never
    // points at a reused pid.
    const killRunId = call.stepMeta?.run_id;
    let killChildId: string | undefined;
    if (registry && killRunId !== undefined && child.pid !== undefined) {
      killChildId = registry.attachSubprocess(killRunId, child.pid, killTree, {
        // D-274 §8 — the op key + ITS start, so the active list can show the
        // op's own elapsed next to the recipe's. `operation_key` is declared
        // form, never argv or args.
        op: call.operation_key,
        started_at: now(),
      });
    }
    const detachKill = (): void => {
      if (registry && killRunId !== undefined && killChildId !== undefined) {
        registry.detachSubprocess(killRunId, killChildId);
      }
    };

    // D-181/D-259 progress-based stall detection. Legacy progress declarations
    // retain their old monitor-only behavior. A D-259 declaration adds semantic
    // stall detection without replacing the absolute timeout: `timeout_ms: 0`
    // is the explicit unbounded form, still bounded by owner cancellation and
    // (when declared) the progress contract.
    const monitor = buildForegroundMonitor(
      call,
      now,
      tuning,
      cwd,
      registry && killRunId !== undefined
        ? (contract, at) => registry.reportProgress(killRunId, contract, at)
        : undefined,
      child.pid,
    );
    const progress = call.binding.progress;
    const d259Heartbeat = progress !== undefined && progress.contract === 'heartbeat'
      ? progress
      : undefined;
    const semanticHeartbeat = d259Heartbeat
      ? createCliProgressAdapter(d259Heartbeat.adapter)
      : undefined;
    const semanticHeartbeatStream = d259Heartbeat
      ? cliProgressAdapterStream(d259Heartbeat.adapter)
      : undefined;
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
          killTree();
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
    // A tool that prints NOTHING after it starts is not slow but stuck: opencode
    // continuing another folder's session, or retrying a model host it cannot
    // reach, prints nothing and never exits (measured, 1.18.35). ANY output on
    // the adapter's stream ends this window, not only progress — a tool whose
    // progress comes when a step finishes is silent through a long first step.
    const firstOutputMs = d259Heartbeat?.first_output_ms;
    let silentStart = false;
    let firstOutputTimer: ReturnType<typeof setTimeout> | undefined = firstOutputMs === undefined
      ? undefined
      : setTimeout(() => {
        firstOutputTimer = undefined;
        if (child.exitCode !== null || child.signalCode !== null) return;
        silentStart = true;
        if (registry && killRunId !== undefined) registry.markStalled(killRunId);
        killTree();
      }, firstOutputMs);
    const endFirstOutputWindow = (): void => {
      if (firstOutputTimer === undefined) return;
      clearTimeout(firstOutputTimer);
      firstOutputTimer = undefined;
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      // D-185 Slice 3 — capture stdout only for a VALUE shape (and never for an
      // output_capture op); `ref`/omitted discard.
      if (capturesStdoutValue(call.binding)) appendCapture(stdout, chunk);
      // STDOUT CAPTURE — the bytes go to an engine-chosen FILE, never into a
      // value. Written as they arrive so output larger than memory is fine,
      // which is the whole reason this arm exists. A sink write that throws
      // (the ceiling) kills the child rather than filling the disk.
      if (stdoutSink !== undefined) {
        try {
          stdoutSink.write(chunk);
        } catch (err) {
          sinkFailure ??= err as Error;
          killTree();
        }
      }
      if (semanticHeartbeatStream === 'stdout' || semanticHeartbeatStream === 'both') {
        if (chunk.length > 0) endFirstOutputWindow();
        const count = semanticHeartbeat?.push(chunk, 'stdout') ?? 0;
        for (let idx = 0; idx < count; idx += 1) monitor?.signal();
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      appendCapture(stderr, chunk);
      appendStderrTail(stderrTail, chunk);
      if (semanticHeartbeatStream === 'stderr' || semanticHeartbeatStream === 'both') {
        if (chunk.length > 0) endFirstOutputWindow();
        const count = semanticHeartbeat?.push(chunk, 'stderr') ?? 0;
        for (let idx = 0; idx < count; idx += 1) monitor?.signal();
      }
    });
    if (stdin !== undefined) {
      child.stdin?.on('error', () => {
        /* child exited before reading stdin; close/error handles outcome */
      });
      child.stdin?.end(stdin);
    }

    let timedOut = false;
    let aborted = false;
    const timeoutMs = resolveTimeoutMs(call.timeout_ms);
    // Only an explicit `timeout_ms: 0` skips the wall deadline. Legacy
    // progress used to skip it implicitly; that shape no longer exists (§ 0.1.1).
    const timer = timeoutMs === 0
      ? undefined
      : setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      killTree();
    };
    call.signal?.addEventListener('abort', onAbort, { once: true });
    if (call.signal?.aborted) onAbort();
    const detachAbort = (): void => {
      call.signal?.removeEventListener('abort', onAbort);
    };

    child.once('error', (err) => {
      if (timer !== undefined) clearTimeout(timer);
      endFirstOutputWindow();
      monitor?.stop();
      detachAbort();
      detachKill();
      reject(spawnFailureError(call, cmd, err));
    });
    child.once('close', (rawCode, signal) => {
      if (timer !== undefined) clearTimeout(timer);
      endFirstOutputWindow();
      const finalSignals = semanticHeartbeat?.end() ?? 0;
      for (let idx = 0; idx < finalSignals; idx += 1) monitor?.signal();
      monitor?.stop();
      // A finite operation owns the WHOLE process tree even on exit 0. A tool
      // can spawn a background child with ignored stdio and then let its leader
      // exit; without this reap the Promise would settle while that descendant
      // kept running (and could keep mutating an output-capture path). POSIX
      // targets only the old group id, avoiding a bare-pid reuse race.
      if (child.pid !== undefined) {
        if (reapProcessTreeAfterExit !== undefined) {
          reapProcessTreeAfterExit(child.pid, 'SIGKILL');
        } else {
          try { child.kill('SIGKILL'); } catch { /* leader already exited */ }
        }
      }
      detachAbort();
      detachKill();
      // ⛔ Reported BEFORE the exit code. The ceiling kills the child with
      // SIGKILL, so without this the run surfaces as a generic tool failure and
      // the owner is told the tool crashed rather than that their output was too
      // large — the wrong thing to go and investigate.
      if (sinkFailure !== undefined) {
        reject(sinkFailure);
        return;
      }
      const exitCode = (timedOut || stalled || aborted || silentStart) ? -9 : normalizeExitCode(rawCode, signal);
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
      // Identifiers the progress adapter read off the protocol (Codex: the
      // session id that `codex.resume_session` takes) ride beside the output,
      // never over a field the executor set.
      for (const [key, value] of Object.entries(semanticHeartbeat?.facts?.() ?? {})) {
        if (!Object.prototype.hasOwnProperty.call(result, key)) result[key] = value;
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
      if (aborted) {
        reject(new Error(`cli_invocation '${call.operation_id}' cancelled`));
        return;
      }
      if (silentStart) {
        // The adapter knows its tool's likely reasons for saying nothing.
        const toolFailure = semanticHeartbeat?.failure?.();
        reject(makeCliFailureError(
          `cli tool '${cmd}' printed nothing in its first ${String(firstOutputMs)}ms${toolFailure ? `: ${toolFailure}` : ''}`,
          {
            reason: 'timeout',
            ...cliFailureIdentity(call, cmd),
            exit_code: exitCode,
            ...cliFailureStderr(call, stderrTail),
          },
        ));
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
        // The tool's own report, when its protocol carries one: Claude Code
        // puts "API Error: 400 …" or "No conversation found …" only in its
        // result record, and stderr is often empty.
        const toolFailure = semanticHeartbeat?.failure?.();
        reject(makeCliFailureError(
          `cli tool '${cmd}' exited with code ${exitCode}${toolFailure ? `: ${toolFailure}` : ''}`,
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
      if (answerOut !== undefined) {
        answerOut.answer = semanticHeartbeat?.answer?.();
        answerOut.failure = semanticHeartbeat?.failure?.();
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
  killProcessTree?: (pid: number, signal: NodeJS.Signals) => void,
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
    const env = resolveChildEnv(call, cwd);
    const options: SpawnOptions = {
      shell: false,
      detached: true,
      stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
      ...(cwd ? { cwd } : {}),
      env,
    };
    assertPreapprovalOrdinaryRun();
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
    await waitForLaunch(child, launchTimeoutMs, killProcessTree);
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
  // Office document toolkit. Needed for `dir_arg` capture (soffice writes
  // `<name>.pdf` beside nothing, but an office-producing op writes into a dir
  // that may also hold a lock/profile file) — selecting by extension keeps the
  // capture deterministic. In-place capture knows its path and never consults
  // this map, but the mime must still round-trip onto the record.
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

/** The OOXML mime types whose captured bytes must present a ZIP container.
 *  Kept as a set beside `CAPTURE_MIME_EXT` so adding a format touches both the
 *  extension selection and the envelope assertion in one place. */
const OOXML_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

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
 *  (fail loud rather than guess). Shared by the `cas` (ingest) and `temp`
 *  (D-185 §3.4) backings. File size is deliberately not capped: file refs are
 *  the large-output carrier. */
const selectCapturedFile = (
  outDir: string,
  capture: CliOutputCaptureSpec,
  call: CliInvocationCall,
): { filePath: string; filename: string } => {
  // D-182 — these are `bad_output` failures: the tool exited successfully but its
  // output is unusable (no or ambiguous produced file). Classified (not
  // NETWORK_ERROR) so the run names the failing op + tool. No stderr here —
  // the process already closed; the file listing, not stderr, is diagnostic.
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
  return { filePath, filename };
};

/** IN-PLACE capture — the produced file is the materialized INPUT the tool
 *  edited, so there is no directory to scan and no ambiguity to resolve: the
 *  path is the one the materialize wrapper already substituted into the arg.
 *  Uses the same `bad_output` classification when the tool exited
 *  successfully but left nothing usable behind. A missing file here means the
 *  tool deleted or renamed its input rather than editing it — fail loud rather
 *  than capture whatever else happens to be around. */
const selectInPlaceCapturedFile = (
  inputPath: string,
  call: CliInvocationCall,
): { filePath: string; filename: string } => {
  if (!existsSync(inputPath)) {
    throw capturedOutputError(
      call,
      `cli_invocation output_capture: '${call.operation_id}' in-place input ${basename(inputPath)} is missing after the run (the tool removed or renamed it instead of editing in place)`,
    );
  }
  // Do not follow a replacement symlink here. The child controls this path
  // while it runs; accepting a symlink it leaves behind would turn an
  // engine-chosen materialization path into a read/ingest of an arbitrary
  // same-user path after the process exits.
  const stat = lstatSync(inputPath);
  if (!stat.isFile()) {
    throw capturedOutputError(
      call,
      `cli_invocation output_capture: '${call.operation_id}' in-place path ${basename(inputPath)} is not a regular file`,
    );
  }
  return { filePath: inputPath, filename: basename(inputPath) };
};

const readFileWindow = (path: string, position: number, length: number): Buffer => {
  const fd = openSync(path, 'r');
  try {
    const out = Buffer.alloc(length);
    const read = readSync(fd, out, 0, length, position);
    return out.subarray(0, read);
  } finally {
    closeSync(fd);
  }
};

/** The declared capture MIME is authority for the durable data.file row. Verify
 * formats with a cheap, dependable envelope before ingest so broken or
 * substituted bytes cannot inherit a trusted PDF/OOXML label. */
const assertCapturedFileMatchesMime = (
  path: string,
  capture: CliOutputCaptureSpec,
  call: CliInvocationCall,
): void => {
  const size = statSync(path).size;
  if (capture.mime_type === 'application/pdf') {
    const head = readFileWindow(path, 0, Math.min(5, size));
    const tailSize = Math.min(1_024, size);
    const tail = readFileWindow(path, Math.max(0, size - tailSize), tailSize);
    if (head.toString('ascii') !== '%PDF-' || !tail.toString('latin1').includes('%%EOF')) {
      throw capturedOutputError(
        call,
        `cli_invocation output_capture: '${call.operation_id}' produced invalid PDF bytes`,
      );
    }
    return;
  }
  if (OOXML_MIME_TYPES.has(capture.mime_type)) {
    const sig = readFileWindow(path, 0, Math.min(4, size));
    const isZip = sig[0] === 0x50 && sig[1] === 0x4b && sig[2] === 0x03 && sig[3] === 0x04;
    if (!isZip) {
      throw capturedOutputError(
        call,
        `cli_invocation output_capture: '${call.operation_id}' produced invalid OOXML bytes (expected a ZIP container for ${capture.mime_type})`,
      );
    }
  }
};

const sha256File = async (path: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
};

/** Explicit `storage: 'cas'` — ingest the produced file into the CAS
 *  (`data.file.received`) and surface a bare `record_id` string as
 *  `result.file_ref` (asymmetric union: a `cas` ref stays a string). */
const captureToolOutputToCas = async (
  selected: { filePath: string; filename: string },
  capture: CliOutputCaptureSpec,
  call: CliInvocationCall,
  ingest: ToolOutputIngestor | undefined,
  ingestFile: ToolOutputFileIngestor | undefined,
  compatibilityMaxBytes: number,
): Promise<{
  file_ref: string;
  filename: string;
  mime_type: string;
  content_sha256?: string;
  size_bytes?: number;
}> => {
  const { filePath, filename } = selected;
  assertCapturedFileMatchesMime(filePath, capture, call);
  const size_bytes = statSync(filePath).size;
  const content_sha256 = await sha256File(filePath);
  // The content suffix is load-bearing for foreach/repeated-op safety. A fixed
  // output name (for example D-200's `document.pdf`) is reused by every call;
  // run+op+filename alone would therefore upsert every iteration onto one
  // data.file record id, making earlier refs resolve to the final iteration's
  // bytes. Same content keeps the same id for crash-resume idempotency while
  // distinct content receives a distinct record inside the same run.
  const source_id = `${call.stepMeta?.run_id ?? 'cli'}:${call.operation_id}:${filename}:${content_sha256}`;
  if (!ingestFile && size_bytes > compatibilityMaxBytes) {
    throw capturedOutputError(
      call,
      `cli_invocation output_capture: '${call.operation_id}' output ${filename} is ${size_bytes} bytes, over the ${compatibilityMaxBytes}-byte cap`,
    );
  }
  const { record_id } = ingestFile
    ? await ingestFile({
        src_path: filePath,
        filename,
        mime_type: capture.mime_type,
        content_hash: content_sha256,
        size_bytes,
        source_id,
      })
    : await ingest!({
        // Compatibility seam for existing focused tests/custom embedders.
        // Production always wires `ingestFile` and never takes this whole-file arm.
        bytes: readFileSync(filePath),
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
      ? { content_sha256, size_bytes }
      : {}),
  };
};

/** `storage: 'temp'` (D-185 §3.4) — leave the produced file at its run-scoped
 *  path and surface a `TempFileRef`. No CAS, no Gateway round-trip — the file is
 *  reclaimed when `cleanupRunScratch` removes the run-scratch root at run end.
 *  `mime_type` / `filename` ride on the ref so the doc-part consumer builds a
 *  content part without sniffing. */
const captureToolOutputToTemp = (
  selected: { filePath: string; filename: string },
  capture: CliOutputCaptureSpec,
): { file_ref: TempFileRef; filename: string; mime_type: string; size_bytes?: number } => {
  const { filePath, filename } = selected;
  const file_ref: TempFileRef = {
    backing: 'temp',
    path: filePath,
    mime_type: capture.mime_type,
    filename,
  };
  // ⛔⛔ THE SIZE RIDES BESIDE THE REF, NEVER INSIDE IT. `TempFileRef` is a
  // FROZEN WIRE SHAPE: a producing step's ref handed to the next op is checked
  // against that op's closed request schema, which walks the object's keys and
  // refuses any it does not declare. Putting `size_bytes` on the carrier broke
  // `officecli.document.template_author` with "undeclared property
  // 'size_bytes'", and would have broken any installed pack declaring the shape
  // the moment the runtime started producing it — a version skew with no deploy
  // order to hide behind. An op's OUTPUT has no such gate.
  //
  // Best-effort: a stat failure must not fail a capture that otherwise
  // succeeded, so the size is simply absent and the consumer handles that.
  let size_bytes: number | undefined;
  try { size_bytes = statSync(filePath).size; } catch { size_bytes = undefined; }
  return { file_ref, filename, mime_type: capture.mime_type,
           ...(size_bytes !== undefined ? { size_bytes } : {}) };
};

export const createCliInvocationExecutor = (
  options: CliInvocationExecutorOptions = {},
): CliInvocationExecutor => {
  const spawn = options.spawn ?? nodeSpawn;
  const now = options.now ?? (() => Date.now());
  const tuning = options.stallTuning ?? {};
  const registry = options.inFlightRegistry;
  const startSupervisedDaemon = options.startSupervisedDaemon;
  const processTreeKiller = options.killProcessTree
    ?? (options.spawn === undefined ? killProcessGroup : undefined);
  const settledProcessTreeReaper = options.killProcessTree
    ?? (options.spawn === undefined ? reapProcessGroupAfterLeaderExit : undefined);
  const ingestToolOutput = options.ingestToolOutput;
  const ingestToolOutputFile = options.ingestToolOutputFile;
  const readFileBytes = options.readFileBytes;
  // Defaults to os.tmpdir(); a suite injects its own so its cleanup assertions
  // are about a directory it owns rather than a global one it shares.
  const tempRoot = options.tempRoot ?? tmpdir();
  const outputCaptureMaxBytes = options.outputCaptureMaxBytes
    ?? DEFAULT_OUTPUT_CAPTURE_MAX_BYTES;
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
      // Pinned variables are foreground-only: a supervised daemon starts on
      // another path that would drop them, and a binding that pinned them must
      // not run without them.
      if (call.binding.env !== undefined) {
        throw new Error(
          `cli_invocation '${call.operation_id}': env is foreground-only and cannot combine with a detached job spec`,
        );
      }
      if (call.binding.detached.supervision && startSupervisedDaemon) {
        return startSupervisedDaemon(call);
      }
      return runDetached(
        call,
        resolveArgv(call),
        spawn,
        now,
        launchTimeoutMs,
        processTreeKiller,
      );
    }
    const capture = call.binding.output_capture;
    if (!capture) {
      await currentPreapprovalIo()?.beforeCliProvider(call);
      assertPreapprovalOrdinaryRun();
      return runForeground(
        call,
        resolveArgv(call),
        spawn,
        now,
        tuning,
        registry,
        processTreeKiller,
        settledProcessTreeReaper,
      );
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

    // IN-PLACE capture: the tool edits its input and offers no output path, so
    // there is no `dir_arg` to bind and no directory to scan. The materialize
    // wrapper has ALREADY substituted the engine-chosen temp path into
    // `from_input_arg` (it wraps `runResolved` from the outside), so reading the
    // arg here yields that path — never a caller-named one, because the
    // validators refuse this variant the materialize passthrough lane.
    //
    // Cleanup is the OUTER wrapper's: its `finally` removes the input temp dir
    // after this returns. That ordering is load-bearing for `cas` (bytes are
    // read here, before the sweep) and is exactly why `temp` must COPY rather
    // than hand back the materialized path — a `TempFileRef` pointing into a
    // directory about to be removed is a dangling ref the next step would fail
    // on. The copy lands in run-scratch, which outlives the call by design.
    // STDOUT capture: the tool prints, and the engine streams that to a file in
    // a dir it owns. Same posture as `dir_arg` — the recipe never names the
    // path and never sees it; the bytes come back only as a Gateway-gated
    // `file_ref`. This is what lets a stdout-only filter (csvgrep, ripgrep, jq)
    // run against a materialized warehouse file at all: before it, such an op
    // could not declare `shape: 'ref'`, and a value shape is refused alongside
    // `input_materialize`.
    if (isStdoutCapture(capture)) {
      const outDir = mkdtempSync(join(tempRoot, 'recued-cli-out-'));
      const filePath = join(outDir, basename(capture.filename));
      const fd = openSync(filePath, 'w');
      let written = 0;
      let closed = false;
      const closeFd = (): void => {
        if (closed) return;
        closed = true;
        try {
          closeSync(fd);
        } catch {
          /* already closed */
        }
      };
      try {
        const base = (await runForeground(
          call,
          resolveArgv(call),
          spawn,
          now,
          tuning,
          registry,
          processTreeKiller,
          settledProcessTreeReaper,
          {
            write: (chunk) => {
              written += chunk.length;
              // Production streams this file to the CAS and therefore has no
              // produced-file ceiling. The compatibility Buffer ingestor must
              // stop before an unbounded print fills disk and is read into RAM.
              if (!ingestToolOutputFile && written > outputCaptureMaxBytes) {
                throw new Error(
                  `cli_invocation '${call.operation_id}': stdout exceeded the ${outputCaptureMaxBytes}-byte capture ceiling`,
                );
              }
              writeSync(fd, chunk);
            },
          },
        )) as Record<string, unknown>;
        // Closed before the read. ⚠ NOT load-bearing for correctness, and the
        // first version of this comment claimed it was: `writeSync` writes
        // through synchronously, so the bytes are already visible to a reader
        // with the fd still open — a mutation that moved this line kept every
        // test green, which is what exposed the false rationale. It stays
        // because holding a write handle across the ingest is pointless, and
        // the `finally` below would close it anyway.
        closeFd();
        const selected = { filePath, filename: basename(capture.filename) };
        if (storage === 'temp') {
          const scratchDir = allocateRunScratchDir(call.stepMeta?.run_id ?? '');
          const keptPath = join(scratchDir, selected.filename);
          copyFileSync(selected.filePath, keptPath);
          return {
            ...base,
            ...captureToolOutputToTemp(
              { filePath: keptPath, filename: selected.filename },
              capture,
            ),
          };
        }
        if (!ingestToolOutput && !ingestToolOutputFile) {
          throw new Error(
            `cli_invocation '${call.operation_id}' declares output_capture but no tool-output ingestor is wired`,
          );
        }
        return {
          ...base,
          ...await captureToolOutputToCas(
            selected,
            capture,
            call,
            ingestToolOutput,
            ingestToolOutputFile,
            outputCaptureMaxBytes,
          ),
        };
      } finally {
        closeFd();
        rmSync(outDir, { recursive: true, force: true });
      }
    }

    // ANSWER capture: the tool's stdout is the event stream its heartbeat
    // adapter reads, and the op keeps only the final answer the adapter found
    // there (Claude Code). The engine writes it to a path it chose; like the
    // stdout arm, the bytes come back only as a Gateway-gated `file_ref`.
    if (isProgressAnswerCapture(capture)) {
      const answerOut: ProgressAnswerOut = {};
      const base = (await runForeground(
        call,
        resolveArgv(call),
        spawn,
        now,
        tuning,
        registry,
        processTreeKiller,
        settledProcessTreeReaper,
        undefined,
        answerOut,
      )) as Record<string, unknown>;
      if (answerOut.answer === undefined) {
        throw capturedOutputError(
          call,
          `cli_invocation output_capture: '${call.operation_id}' ended without a final answer${answerOut.failure ? `: ${answerOut.failure}` : ''}`,
        );
      }
      const outDir = mkdtempSync(join(tempRoot, 'recued-cli-out-'));
      try {
        const selected = { filePath: join(outDir, basename(capture.filename)), filename: basename(capture.filename) };
        writeFileSync(selected.filePath, answerOut.answer, 'utf8');
        if (storage === 'temp') {
          const scratchDir = allocateRunScratchDir(call.stepMeta?.run_id ?? '');
          const keptPath = join(scratchDir, selected.filename);
          copyFileSync(selected.filePath, keptPath);
          return {
            ...base,
            ...captureToolOutputToTemp({ filePath: keptPath, filename: selected.filename }, capture),
          };
        }
        if (!ingestToolOutput && !ingestToolOutputFile) {
          throw new Error(
            `cli_invocation '${call.operation_id}' declares output_capture but no tool-output ingestor is wired`,
          );
        }
        return {
          ...base,
          ...await captureToolOutputToCas(
            selected,
            capture,
            call,
            ingestToolOutput,
            ingestToolOutputFile,
            outputCaptureMaxBytes,
          ),
        };
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    }

    if (isInPlaceCapture(capture)) {
      const base = (await runForeground(
        call,
        resolveArgv(call),
        spawn,
        now,
        tuning,
        registry,
        processTreeKiller,
        settledProcessTreeReaper,
      )) as Record<string, unknown>;
      const inPlacePath = readArg(call.args, capture.from_input_arg);
      if (typeof inPlacePath !== 'string' || inPlacePath.length === 0) {
        throw new Error(
          `cli_invocation '${call.operation_id}' in-place output_capture arg '${capture.from_input_arg}' did not resolve to a materialized path`,
        );
      }
      const selected = selectInPlaceCapturedFile(inPlacePath, call);
      if (storage === 'temp') {
        const scratchDir = allocateRunScratchDir(call.stepMeta?.run_id ?? '');
        const keptPath = join(scratchDir, selected.filename);
        copyFileSync(selected.filePath, keptPath);
        const captured = captureToolOutputToTemp(
          { filePath: keptPath, filename: selected.filename },
          capture,
        );
        return { ...base, ...captured };
      }
      if (!ingestToolOutput && !ingestToolOutputFile) {
        throw new Error(
          `cli_invocation '${call.operation_id}' declares output_capture but no tool-output ingestor is wired`,
        );
      }
      const captured = await captureToolOutputToCas(
        selected,
        capture,
        call,
        ingestToolOutput,
        ingestToolOutputFile,
        outputCaptureMaxBytes,
      );
      return { ...base, ...captured };
    }

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
        processTreeKiller,
        settledProcessTreeReaper,
      )) as Record<string, unknown>;
      const captured = captureToolOutputToTemp(
        selectCapturedFile(outDir, capture, call),
        capture,
      );
      return { ...base, ...captured };
    }

    // Explicit `cas`: a per-call throwaway temp dir under the OS temp root,
    // ingested into the CAS as a `data.file` ref, removed in `finally` on
    // success AND on any throw — so the only durable copy is the content-
    // addressed, Gateway-gated `data.file` record.
    if (!ingestToolOutput && !ingestToolOutputFile) {
      throw new Error(
        `cli_invocation '${call.operation_id}' declares output_capture but no tool-output ingestor is wired`,
      );
    }
    const tempDir = mkdtempSync(join(tempRoot, 'recued-cli-out-'));
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
        processTreeKiller,
        settledProcessTreeReaper,
      )) as Record<string, unknown>;
      const captured = await captureToolOutputToCas(
        selectCapturedFile(tempDir, capture, call),
        capture,
        call,
        ingestToolOutput,
        ingestToolOutputFile,
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
      tempDir.path ??= mkdtempSync(join(tempRoot, 'recued-cli-in-'));
      return tempDir.path;
    };
    // IN-PLACE capture changes what this arg IS: the tool will WRITE to the path
    // we hand it, and that written file becomes the op's result. Two of the
    // pass-through shortcuts below are safe only for a read-only consumer and
    // must not apply here (the authoring validator already pins
    // `from_input_arg === materialize.arg`, so this is the same single arg).
    const captureSpec = call.binding.output_capture;
    const isInPlaceInput =
      captureSpec !== undefined
      && isInPlaceCapture(captureSpec)
      && captureSpec.from_input_arg === materialize.arg;
    const materializeOne = async (value: unknown, idx?: number): Promise<string> => {
      // D-185 Slice 2 — a `temp` ref (a prior `storage:'temp'` op's run-scoped
      // output, e.g. the ffmpeg→whisper pipe) ALREADY is a local file: substitute
      // its path straight into the arg — no CAS read, no re-materialize.
      if (isTempFileRef(value)) {
        // ...EXCEPT for an in-place editor, which would mutate that prior step's
        // run-scratch file underneath any other step still holding the same ref.
        // Copy into OUR throwaway dir so the edit is confined to this op.
        if (isInPlaceInput) {
          const copyPath = join(
            ensureTempDir(),
            materializedInputBasename(value.filename, idx),
          );
          copyFileSync(value.path, copyPath);
          return copyPath;
        }
        return value.path;
      }
      // The materialize arg can otherwise carry EITHER a file_ref — a CAS
      // record (the storage-gdrive download lane) or a File Source MIRROR row
      // (D-241 P4: bytes fetched from the vendor on demand) — OR a literal local
      // path / URL (the manual lane — docling's `source` serves both). Only a
      // recognized record_id is materialized; anything else passes through to
      // the cli as-is.
      const pinned = isPinnedCasFileRef(value) ? value : null;
      const recordId = pinned?.record_id ?? value;
      if (!isMaterializableFileRef(recordId)) {
        // ⛔ The passthrough lane is REFUSED for an in-place capture. Letting a
        // literal path through would hand the tool a location the RECIPE named,
        // and this op then ingests whatever is there — the caller would both
        // choose the write target and get its bytes back as a file_ref. Every
        // other guard on this path (validators, grant-gating, stdout/stderr
        // suppression) assumes the materialized path is engine-chosen; that
        // assumption is what this branch would break. A read-only consumer like
        // docling keeps the lane — it only ever reads what it was pointed at.
        if (isInPlaceInput) {
          throw new Error(
            `cli_invocation '${call.operation_id}' in-place output_capture arg '${materialize.arg}' requires a data.file ref — a literal path or URL is refused because the captured file must live at an engine-chosen path`,
          );
        }
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
