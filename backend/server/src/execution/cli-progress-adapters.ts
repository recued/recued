/** D-259 semantic progress adapters for finite CLI processes.
 *
 * A heartbeat is deliberately narrower than "the process wrote bytes". Each
 * adapter recognizes a monotonic unit in a documented machine-readable
 * protocol and suppresses repeats. The executor feeds both stdout and stderr;
 * the adapter decides which records matter.
 */
import type { CliProgressAdapter } from '@recued/contracts';
import { StringDecoder } from 'node:string_decoder';

export interface CliSemanticProgressAdapter {
  /** Consume a stream chunk and return the number of newly-observed semantic
   * progress units. Chunks may end midway through a line. `stream` keeps
   * stdout/stderr framing independent when an adapter intentionally watches
   * both; the semantic observer remains shared so duplicate units still
   * collapse. */
  push(chunk: Buffer, stream?: 'stdout' | 'stderr'): number;
  /** Consume final unterminated lines. With no stream, flush every buffer. */
  end(stream?: 'stdout' | 'stderr'): number;
  /** Identifiers read off the protocol — never content. The executor merges
   *  them into the op's result beside its output, never over an existing
   *  field. Codex reports its session id here, which the resume ops take. */
  facts?(): Readonly<Record<string, string>>;
  /** The tool's final answer, read off its protocol. CONTENT, unlike `facts`:
   *  it never enters a value — the executor writes it only into the
   *  engine-owned file of an `output_capture.from_progress_answer` op.
   *  Undefined when the stream carried no successful final answer. */
  answer?(): string | undefined;
  /** The failure the tool reported on its protocol. Claude Code reports an
   *  API error or a refused resume only in its result record, often with
   *  nothing on stderr; the executor adds it to a failed run's message. */
  failure?(): string | undefined;
}

/** pi and opencode print their event stream on stdout and, when a run ends
 *  without an answer, often say why only on stderr — pi's "Session found in
 *  different project", opencode's "permission requested … auto-rejecting" — so
 *  their adapters read both, keeping stderr for the failure text alone. */
export const cliProgressAdapterStream = (
  name: CliProgressAdapter,
): 'stdout' | 'stderr' | 'both' =>
  name === 'codex-jsonl' || name === 'claude-stream-json'
    ? 'stdout'
    : name === 'yt-dlp-progress' || name === 'pi-json' || name === 'opencode-json'
      ? 'both'
      : 'stderr';

/** `stream` is the key the chunk was pushed under (`stdout`, `stderr`, or
 *  `default` when the caller named none). */
type LineObserver = (line: string, stream: string) => boolean;

// Machine progress protocols are line-oriented, but a hostile or broken child
// can omit delimiters forever. Bound each pending line independently; once the
// cap is crossed, discard that whole record through its next delimiter and
// resume parsing subsequent records. This bounds adapter memory without
// accidentally treating a suffix of an overlong record as valid progress.
const MAX_PENDING_LINE_CHARS = 1024 * 1024;

/** `onDiscard` hears of each record dropped for crossing the cap — an adapter
 *  that keeps the LAST record of a kind must know the true last one was lost,
 *  or it reports an earlier one in its place. It names the stream, because a
 *  dropped diagnostic line is not a dropped protocol record. */
const lineAdapter = (
  observe: LineObserver,
  onDiscard?: (stream: string) => void,
): CliSemanticProgressAdapter => {
  interface PendingLine {
    key: string;
    text: string;
    discarding: boolean;
    decoder: StringDecoder;
  }
  const pending = new Map<string, PendingLine>();
  const getState = (key: string): PendingLine => {
    const current = pending.get(key);
    if (current !== undefined) return current;
    const created = { key, text: '', discarding: false, decoder: new StringDecoder('utf8') };
    pending.set(key, created);
    return created;
  };
  const consume = (state: PendingLine, input: string, flush: boolean): number => {
    let signals = 0;
    let cursor = 0;
    while (cursor < input.length) {
      const lf = input.indexOf('\n', cursor);
      const cr = input.indexOf('\r', cursor);
      const delimiter = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
      const end = delimiter < 0 ? input.length : delimiter;

      if (!state.discarding) {
        const segmentLength = end - cursor;
        if (state.text.length + segmentLength > MAX_PENDING_LINE_CHARS) {
          state.text = '';
          state.discarding = true;
        } else if (segmentLength > 0) {
          state.text += input.slice(cursor, end);
        }
      }

      if (delimiter < 0) break;
      if (state.discarding) onDiscard?.(state.key);
      else if (observe(state.text.trim(), state.key)) signals += 1;
      state.text = '';
      state.discarding = false;
      cursor = delimiter + 1;
      // Treat an in-chunk CRLF as one delimiter. A split CRLF can only produce
      // an empty record on the next push, which every registered observer
      // ignores.
      if (input[delimiter] === '\r' && input[cursor] === '\n') cursor += 1;
    }

    if (flush) {
      if (state.discarding) onDiscard?.(state.key);
      else if (observe(state.text.trim(), state.key)) signals += 1;
    }
    return signals;
  };
  const endOne = (key: string): number => {
    const state = pending.get(key);
    if (state === undefined) return 0;
    const signals = consume(state, state.decoder.end(), true);
    pending.delete(key);
    return signals;
  };
  return {
    push(chunk, stream) {
      const key = stream ?? 'default';
      const state = getState(key);
      return consume(state, state.decoder.write(chunk), false);
    },
    end(stream) {
      if (stream !== undefined) return endOne(stream);
      let signals = 0;
      for (const key of [...pending.keys()]) signals += endOne(key);
      return signals;
    },
  };
};

/** A Codex thread id as `exec --json` prints it (`01a11547-8fbc-7fe0-…`). The
 *  value later becomes an argv token of `codex exec resume`, so anything else —
 *  above all a leading `-` — is not a session id and is not reported. */
const CODEX_SESSION_ID_RE = /^[0-9a-f][0-9a-f-]{7,63}$/i;

const codexJsonlAdapter = (): CliSemanticProgressAdapter => {
  const completedItems = new Set<string>();
  let ordinal = 0;
  let terminalSeen = false;
  let sessionId: string | undefined;
  const adapter = lineAdapter((line) => {
    if (line.length === 0 || line[0] !== '{') return false;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return false;
    }
    // Codex `exec --json` emits JSONL events. Only completed work units and
    // terminal turn records advance liveness; deltas/log messages do not.
    const type = row.type;
    // The session (thread) id opens the stream, on a new run and on a resumed
    // one alike. A fact, not progress. The first one wins.
    if (type === 'thread.started') {
      const id = row.thread_id;
      if (sessionId === undefined && typeof id === 'string' && CODEX_SESSION_ID_RE.test(id)) {
        sessionId = id;
      }
      return false;
    }
    if (type === 'item.completed') {
      const item = row.item;
      const id = item && typeof item === 'object'
        ? (item as Record<string, unknown>).id
        : undefined;
      const key = typeof id === 'string' && id.length > 0
        ? id
        : `ordinal:${ordinal++}`;
      if (completedItems.has(key)) return false;
      completedItems.add(key);
      return true;
    }
    if (type === 'turn.completed' || type === 'turn.failed') {
      if (terminalSeen) return false;
      terminalSeen = true;
      return true;
    }
    return false;
  });
  return {
    ...adapter,
    facts: (): Readonly<Record<string, string>> =>
      (sessionId === undefined ? {} : { session_id: sessionId }),
  };
};

/** A Claude Code session id as `stream-json` prints it: a UUID, the only form
 *  `--resume` takes. It becomes an argv token of the resume ops, so anything
 *  else is not a session id and is not reported. */
const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The most failure text carried onto an error message. */
const MAX_FAILURE_CHARS = 1000;

/** `system` records that mark completed work: a background task (a subagent, a
 *  long command) finished. Not `task_started`, and not `tool_progress` — a
 *  running command emits that every 30 s whether or not it advances, so a hung
 *  command would emit it too. */
const CLAUDE_PROGRESS_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set(['task_notification']);

/** Claude Code `-p --output-format stream-json --verbose` (measured against
 *  2.1.292): one JSON record per line. Completed units are a model response
 *  (`assistant`), a tool result (`user`), a finished background task and a
 *  turn's `result` — a subagent's own records included, which carry
 *  `parent_tool_use_id`. The session id opens the stream (`system`/`init`).
 *  The final answer is the LAST `result` record's `result`: a run that waits
 *  on a background subagent ends with one result per turn, and the earlier
 *  one is only "launched the agent". */
const claudeStreamJsonAdapter = (): CliSemanticProgressAdapter => {
  const seen = new Set<string>();
  let ordinal = 0;
  let sessionId: string | undefined;
  let lastResult: Record<string, unknown> | undefined;
  // A record dropped for size after the last result kept may have been the
  // real last result, so the kept one is no longer known to be the answer.
  let droppedAfterResult = false;
  const adapter = lineAdapter((line) => {
    if (line.length === 0 || line[0] !== '{') return false;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return false;
    }
    const type = row.type;
    // A fact, not progress. The first one wins: the turn that follows a
    // background task re-announces the same session.
    if (type === 'system' && row.subtype === 'init') {
      const id = row.session_id;
      if (sessionId === undefined && typeof id === 'string' && CLAUDE_SESSION_ID_RE.test(id)) {
        sessionId = id;
      }
      return false;
    }
    const unit = type === 'assistant' || type === 'user' || type === 'result'
      || (type === 'system' && typeof row.subtype === 'string'
        && CLAUDE_PROGRESS_SYSTEM_SUBTYPES.has(row.subtype));
    if (!unit) return false;
    if (type === 'result') {
      lastResult = row;
      droppedAfterResult = false;
    }
    const key = typeof row.uuid === 'string' && row.uuid.length > 0
      ? row.uuid
      : `ordinal:${ordinal++}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }, () => {
    droppedAfterResult = true;
  });
  return {
    ...adapter,
    facts: (): Readonly<Record<string, string>> =>
      (sessionId === undefined ? {} : { session_id: sessionId }),
    answer: (): string | undefined => {
      if (lastResult === undefined || droppedAfterResult || lastResult.is_error === true) {
        return undefined;
      }
      return typeof lastResult.result === 'string' ? lastResult.result : undefined;
    },
    failure: (): string | undefined => {
      if (droppedAfterResult) {
        return `a stream record over ${MAX_PENDING_LINE_CHARS} characters was dropped after the last result`;
      }
      if (lastResult === undefined || lastResult.is_error !== true) return undefined;
      const errors = Array.isArray(lastResult.errors)
        ? lastResult.errors.filter((e): e is string => typeof e === 'string' && e.length > 0)
        : [];
      const text = errors.length > 0
        ? errors.join('; ')
        : typeof lastResult.result === 'string' && lastResult.result.length > 0
          ? lastResult.result
          : typeof lastResult.subtype === 'string' ? lastResult.subtype : undefined;
      return text === undefined ? undefined : text.slice(0, MAX_FAILURE_CHARS);
    },
  };
};

/** How many stderr lines a failure keeps — enough to say what happened, not a log. */
const STDERR_FAILURE_LINES = 3;

const ANSI_ESCAPE_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** The last few non-empty stderr lines, for a run that ended without saying
 *  why on its protocol. Bounded like every failure text. */
const stderrFailureLines = (): { push: (line: string) => void; text: () => string | undefined } => {
  const lines: string[] = [];
  return {
    push(line) {
      const clean = line.replace(ANSI_ESCAPE_RE, '').trim();
      if (clean.length === 0) return;
      lines.push(clean.slice(0, MAX_FAILURE_CHARS));
      if (lines.length > STDERR_FAILURE_LINES) lines.shift();
    },
    text: () => (lines.length === 0 ? undefined : lines.join('; ').slice(0, MAX_FAILURE_CHARS)),
  };
};

const parseJsonRecord = (line: string): Record<string, unknown> | undefined => {
  if (line.length === 0 || line[0] !== '{') return undefined;
  try {
    const row: unknown = JSON.parse(line);
    return row !== null && typeof row === 'object' ? row as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  (value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined);

/** A pi session id as `--mode json` prints it in its `session` header: a UUID
 *  (pi 1.1 writes version 7). It becomes the value of `--session`, which also
 *  takes a file path or a PARTIAL id, so anything but a whole UUID is not a
 *  session id and is not reported. */
const PI_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The stop reasons that end a pi turn with an answer. `error`, `aborted` and
 *  a pending `toolUse` are not one — and an unknown reason fails closed. */
const PI_ANSWER_STOP_REASONS: ReadonlySet<string> = new Set(['stop', 'length']);

const piMessageText = (message: Record<string, unknown>): string => {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => asRecord(block))
    .filter((block): block is Record<string, unknown> => block?.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('');
};

/** pi `--mode json` (measured against pi 1.1.0): one JSON record per line on
 *  stdout, opened by a `session` header whose `id` is the session id.
 *  Completed units are a finished assistant or tool-result message, a finished
 *  tool execution or turn, a finished retry or compaction, and
 *  `agent_settled` — NOT `tool_execution_update`, which streams a running
 *  command's output: bytes, not a finished unit. A failed model call still
 *  EXITS 0, so the answer is decided here: the LAST assistant `message_end`,
 *  only once pi has settled without an abort, and only when that message
 *  stopped with `stop` or `length`. An `error` stop carries pi's
 *  `errorMessage`; an unreachable model is retried, then reported by
 *  `auto_retry_end`. */
const piJsonAdapter = (): CliSemanticProgressAdapter => {
  let sessionId: string | undefined;
  let lastAssistant: Record<string, unknown> | undefined;
  let settled = false;
  let aborted = false;
  let retryFailure: string | undefined;
  // A record dropped for size after the last assistant message may have been
  // the real last one, so the kept one is no longer known to be the answer.
  let droppedAfterAssistant = false;
  const stderr = stderrFailureLines();
  const adapter = lineAdapter((line, stream) => {
    if (stream === 'stderr') {
      stderr.push(line);
      return false;
    }
    const row = parseJsonRecord(line);
    if (row === undefined) return false;
    const type = row.type;
    if (type === 'session') {
      const id = row.id;
      if (sessionId === undefined && typeof id === 'string' && PI_SESSION_ID_RE.test(id)) sessionId = id;
      return false;
    }
    if (type === 'agent_start') {
      // More work for the same invocation: whatever settled before is not the end.
      settled = false;
      return false;
    }
    if (type === 'message_end') {
      const message = asRecord(row.message);
      if (message?.role === 'assistant') {
        lastAssistant = message;
        droppedAfterAssistant = false;
        return true;
      }
      return message?.role === 'toolResult';
    }
    if (type === 'auto_retry_end') {
      if (row.success === false && typeof row.finalError === 'string' && row.finalError.length > 0) {
        retryFailure = row.finalError;
      }
      return true;
    }
    if (type === 'agent_settled') {
      settled = true;
      aborted = row.aborted === true;
      return true;
    }
    return type === 'tool_execution_end' || type === 'turn_end' || type === 'compaction_end';
  }, (stream) => {
    if (stream !== 'stderr') droppedAfterAssistant = true;
  });
  const stopReason = (): string | undefined =>
    (typeof lastAssistant?.stopReason === 'string' ? lastAssistant.stopReason : undefined);
  return {
    ...adapter,
    facts: (): Readonly<Record<string, string>> =>
      (sessionId === undefined ? {} : { session_id: sessionId }),
    answer: (): string | undefined => {
      if (!settled || aborted || droppedAfterAssistant || lastAssistant === undefined) return undefined;
      const stop = stopReason();
      return stop !== undefined && PI_ANSWER_STOP_REASONS.has(stop) ? piMessageText(lastAssistant) : undefined;
    },
    failure: (): string | undefined => {
      if (droppedAfterAssistant) {
        return `a stream record over ${MAX_PENDING_LINE_CHARS} characters was dropped after the last assistant message`;
      }
      const stop = stopReason();
      if (lastAssistant !== undefined && stop !== undefined && !PI_ANSWER_STOP_REASONS.has(stop)) {
        const message = lastAssistant.errorMessage;
        return (typeof message === 'string' && message.length > 0 ? message : `pi stopped with '${stop}'`)
          .slice(0, MAX_FAILURE_CHARS);
      }
      if (retryFailure !== undefined) return retryFailure.slice(0, MAX_FAILURE_CHARS);
      if (settled && aborted) return 'pi aborted the run';
      const said = stderr.text();
      if (said !== undefined) return said;
      return sessionId !== undefined && !settled ? 'pi stopped before it settled' : undefined;
    },
  };
};

/** An opencode session id as `run --format json` prints it on every record:
 *  `ses_` and 26 letters and digits (measured). It becomes the value of
 *  `--session`, so anything else is not a session id and is not reported. */
const OPENCODE_SESSION_ID_RE = /^ses_[0-9A-Za-z]{20,40}$/;

/** The step finish reasons that end an opencode turn with an answer.
 *  `tool-calls` is mid-turn; an unknown reason fails closed. */
const OPENCODE_ANSWER_FINISH_REASONS: ReadonlySet<string> = new Set(['stop', 'length']);

const opencodeErrorText = (error: unknown): string => {
  const record = asRecord(error);
  const data = asRecord(record?.data);
  const name = typeof record?.name === 'string' && record.name.length > 0 ? record.name : 'opencode error';
  const status = typeof data?.statusCode === 'number' ? ` ${String(data.statusCode)}` : '';
  const message = typeof data?.message === 'string' && data.message.length > 0 ? `: ${data.message}` : '';
  return `${name}${status}${message}`.slice(0, MAX_FAILURE_CHARS);
};

/** opencode `run --format json` (measured against opencode 1.15.13 and
 *  1.18.35): one JSON record per line on stdout — `step_start`, `text`,
 *  `tool_use`, `step_finish`, `error` — each naming its `sessionID`; the first
 *  is the session id. Completed units are a text part, a finished tool and a
 *  finished step. A tool is printed only once it is done, so a long command
 *  is silent until then. The answer is the text of the LAST step to finish,
 *  when it finished with `stop` or `length` — a step finishing `tool-calls` is
 *  mid-turn. A failed model call prints an `error` record and exits 0 (1.15.13)
 *  or 1 (1.18.35); a permission opencode would have asked about is refused,
 *  which ends the run and is said only on stderr; and a `--session` belonging
 *  to another folder is continued THERE with nothing printed at all, then exits
 *  0 (1.15.13) or never exits (1.18.35 — the op's `first_output_ms` ends it).
 *  Records of another session (a subagent's) never decide the answer. */
const opencodeJsonAdapter = (): CliSemanticProgressAdapter => {
  const seen = new Set<string>();
  let ordinal = 0;
  let sessionId: string | undefined;
  let records = 0;
  let stepTexts: string[] = [];
  let finalText: string | undefined;
  let lastFinish: string | undefined;
  let errorText: string | undefined;
  let droppedAfterFinish = false;
  const stderr = stderrFailureLines();
  const adapter = lineAdapter((line, stream) => {
    if (stream === 'stderr') {
      stderr.push(line);
      return false;
    }
    const row = parseJsonRecord(line);
    if (row === undefined || typeof row.type !== 'string') return false;
    records += 1;
    const type = row.type;
    const rowSession = typeof row.sessionID === 'string' ? row.sessionID : undefined;
    if (sessionId === undefined && rowSession !== undefined && OPENCODE_SESSION_ID_RE.test(rowSession)) {
      sessionId = rowSession;
    }
    const own = rowSession === undefined || rowSession === sessionId;
    const part = asRecord(row.part);
    if (type === 'error') {
      if (own) {
        errorText = opencodeErrorText(row.error);
        finalText = undefined;
      }
      return true;
    }
    if (type === 'step_start') {
      if (own) stepTexts = [];
      return false;
    }
    if (type !== 'text' && type !== 'tool_use' && type !== 'step_finish') return false;
    const key = typeof part?.id === 'string' && part.id.length > 0 ? part.id : `ordinal:${ordinal++}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (own && type === 'text' && typeof part?.text === 'string') stepTexts.push(part.text);
    if (own && type === 'step_finish') {
      lastFinish = typeof part?.reason === 'string' ? part.reason : undefined;
      finalText = lastFinish !== undefined && OPENCODE_ANSWER_FINISH_REASONS.has(lastFinish)
        ? stepTexts.join('\n\n')
        : undefined;
      droppedAfterFinish = false;
    }
    return true;
  }, (stream) => {
    if (stream !== 'stderr') droppedAfterFinish = true;
  });
  return {
    ...adapter,
    facts: (): Readonly<Record<string, string>> =>
      (sessionId === undefined ? {} : { session_id: sessionId }),
    answer: (): string | undefined =>
      (droppedAfterFinish || errorText !== undefined ? undefined : finalText),
    failure: (): string | undefined => {
      if (droppedAfterFinish) {
        return `a stream record over ${MAX_PENDING_LINE_CHARS} characters was dropped after the last finished step`;
      }
      if (errorText !== undefined) return errorText;
      const said = stderr.text();
      if (said !== undefined) return said;
      if (lastFinish !== undefined && !OPENCODE_ANSWER_FINISH_REASONS.has(lastFinish)) {
        return `opencode's last step finished with '${lastFinish}'`;
      }
      return records === 0
        ? 'opencode printed no events; it does that when the session belongs to another folder, or while it cannot reach its model host'
        : undefined;
    },
  };
};

const ytDlpProgressAdapter = (): CliSemanticProgressAdapter => {
  let maxPercent = -1;
  return lineAdapter((line) => {
    const match = line.match(/^\[download\]\s+([0-9]+(?:\.[0-9]+)?)%(?:\s|$)/);
    if (!match) return false;
    const percent = Number(match[1]);
    if (!Number.isFinite(percent) || percent <= maxPercent) return false;
    maxPercent = percent;
    return true;
  });
};

const ffmpegProgressAdapter = (): CliSemanticProgressAdapter => {
  let maxTime = -1;
  let maxFrame = -1;
  return lineAdapter((line) => {
    const separator = line.indexOf('=');
    if (separator <= 0) return false;
    const key = line.slice(0, separator);
    const value = Number(line.slice(separator + 1));
    if (!Number.isFinite(value)) return false;
    if (key === 'out_time_us' || key === 'out_time_ms') {
      if (value <= maxTime) return false;
      maxTime = value;
      return true;
    }
    if (key === 'frame') {
      if (value <= maxFrame) return false;
      maxFrame = value;
      return true;
    }
    return false;
  });
};

export const createCliProgressAdapter = (
  name: CliProgressAdapter,
): CliSemanticProgressAdapter => {
  switch (name) {
    case 'claude-stream-json': return claudeStreamJsonAdapter();
    case 'codex-jsonl': return codexJsonlAdapter();
    case 'ffmpeg-progress': return ffmpegProgressAdapter();
    case 'opencode-json': return opencodeJsonAdapter();
    case 'pi-json': return piJsonAdapter();
    case 'yt-dlp-progress': return ytDlpProgressAdapter();
  }
};
