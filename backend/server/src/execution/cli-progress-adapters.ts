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

export const cliProgressAdapterStream = (
  name: CliProgressAdapter,
): 'stdout' | 'stderr' | 'both' =>
  name === 'codex-jsonl' || name === 'claude-stream-json'
    ? 'stdout'
    : name === 'yt-dlp-progress' ? 'both' : 'stderr';

type LineObserver = (line: string) => boolean;

// Machine progress protocols are line-oriented, but a hostile or broken child
// can omit delimiters forever. Bound each pending line independently; once the
// cap is crossed, discard that whole record through its next delimiter and
// resume parsing subsequent records. This bounds adapter memory without
// accidentally treating a suffix of an overlong record as valid progress.
const MAX_PENDING_LINE_CHARS = 1024 * 1024;

/** `onDiscard` hears of each record dropped for crossing the cap — an adapter
 *  that keeps the LAST record of a kind must know the true last one was lost,
 *  or it reports an earlier one in its place. */
const lineAdapter = (
  observe: LineObserver,
  onDiscard?: () => void,
): CliSemanticProgressAdapter => {
  interface PendingLine {
    text: string;
    discarding: boolean;
    decoder: StringDecoder;
  }
  const pending = new Map<string, PendingLine>();
  const getState = (key: string): PendingLine => {
    const current = pending.get(key);
    if (current !== undefined) return current;
    const created = { text: '', discarding: false, decoder: new StringDecoder('utf8') };
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
      if (state.discarding) onDiscard?.();
      else if (observe(state.text.trim())) signals += 1;
      state.text = '';
      state.discarding = false;
      cursor = delimiter + 1;
      // Treat an in-chunk CRLF as one delimiter. A split CRLF can only produce
      // an empty record on the next push, which every registered observer
      // ignores.
      if (input[delimiter] === '\r' && input[cursor] === '\n') cursor += 1;
    }

    if (flush) {
      if (state.discarding) onDiscard?.();
      else if (observe(state.text.trim())) signals += 1;
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
    case 'yt-dlp-progress': return ytDlpProgressAdapter();
  }
};
