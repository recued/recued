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
}

export const cliProgressAdapterStream = (
  name: CliProgressAdapter,
): 'stdout' | 'stderr' | 'both' =>
  name === 'codex-jsonl' ? 'stdout' : name === 'yt-dlp-progress' ? 'both' : 'stderr';

type LineObserver = (line: string) => boolean;

// Machine progress protocols are line-oriented, but a hostile or broken child
// can omit delimiters forever. Bound each pending line independently; once the
// cap is crossed, discard that whole record through its next delimiter and
// resume parsing subsequent records. This bounds adapter memory without
// accidentally treating a suffix of an overlong record as valid progress.
const MAX_PENDING_LINE_CHARS = 1024 * 1024;

const lineAdapter = (observe: LineObserver): CliSemanticProgressAdapter => {
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
      if (!state.discarding && observe(state.text.trim())) signals += 1;
      state.text = '';
      state.discarding = false;
      cursor = delimiter + 1;
      // Treat an in-chunk CRLF as one delimiter. A split CRLF can only produce
      // an empty record on the next push, which every registered observer
      // ignores.
      if (input[delimiter] === '\r' && input[cursor] === '\n') cursor += 1;
    }

    if (flush) {
      if (!state.discarding && observe(state.text.trim())) signals += 1;
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

const codexJsonlAdapter = (): CliSemanticProgressAdapter => {
  const completedItems = new Set<string>();
  let ordinal = 0;
  let terminalSeen = false;
  return lineAdapter((line) => {
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
    case 'codex-jsonl': return codexJsonlAdapter();
    case 'ffmpeg-progress': return ffmpegProgressAdapter();
    case 'yt-dlp-progress': return ytDlpProgressAdapter();
  }
};
