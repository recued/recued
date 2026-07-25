/** D-125 P4.2 (B3b) — `child_process`-backed spawner for the
 *  `connection.mcp` stdio transport.
 *
 *  `packages/ingredients/src/connection-mcp.ts` is portable engine code
 *  (it can't import the Node-only `child_process`), so it spawns stdio MCP
 *  servers through an injected `StdioSpawn`. This is the server's
 *  implementation:
 *    - `shell: false` + an explicit args array → no shell parsing, so no
 *      shell-injection surface. The command is user-enrolled (Settings →
 *      Connections), never pack-injected (packs reference connections by
 *      name; they don't carry executable config).
 *    - A curated MINIMAL env — `PATH` + `HOME` + the record's `config.env`
 *      — NOT a full `process.env` inherit, which would hand a user
 *      subprocess the server's entire environment (potentially other
 *      connections' secrets passed via env).
 *    - Newline-delimited JSON-RPC framing over the child's stdin/stdout
 *      (the MCP stdio transport: one JSON message per line, no embedded
 *      newlines). stderr is drained (so the pipe never fills + blocks the
 *      child) with a bounded tail kept for the close diagnostic.
 *    - SIGTERM → SIGKILL teardown. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { StdioClientHandle, StdioSpawn } from '@recued/ingredients';

/** Max stderr tail kept for diagnostics (the child's logs go to stderr;
 *  we drain it so the pipe never fills + blocks the child, and surface a
 *  bounded tail in the close reason). */
const STDERR_TAIL_MAX = 4096;

/** Grace period between SIGTERM and SIGKILL on teardown. */
const KILL_GRACE_MS = 2000;

/** Build the curated child environment. Deliberately minimal — `PATH` (so
 *  PATH-resolved launchers like `npx`/`uvx`/`node` work) + `HOME` (npm /
 *  uv caches) + the connection's explicit `config.env` — NOT a full
 *  `process.env` inherit (see the file header). */
const buildEnv = (extra?: Record<string, string>): Record<string, string> => {
  const env: Record<string, string> = {};
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  if (extra) Object.assign(env, extra);
  return env;
};

/** Adapt a spawned child to the portable `StdioClientHandle`. */
const adaptChild = (child: ChildProcessWithoutNullStreams): StdioClientHandle => {
  let buffer = '';
  let stderrTail = '';
  // Drain stderr so the pipe never fills + blocks the child; keep a tail
  // for the close diagnostic.
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_MAX);
  });
  // Swallow stdin EPIPE — writing to a child that already exited would
  // otherwise emit an unhandled 'error' on the stdin stream; the pending
  // request is rejected via the 'exit' → onClose path instead.
  child.stdin.on('error', () => { /* surfaced via onClose */ });

  return {
    send: (data) => {
      child.stdin.write(`${data}\n`);
    },
    onMessage: (listener) => {
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let nl = buffer.indexOf('\n');
        while (nl !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.trim() !== '') listener(line);
          nl = buffer.indexOf('\n');
        }
      });
    },
    onClose: (listener) => {
      // 'close' (not 'exit') — fires AFTER both stdio streams have ended, so
      // a final JSON-RPC response written just before the child exits is
      // routed to its waiting request before we fail the rest as closed.
      child.on('close', (code, signal) => {
        listener({
          code: code ?? undefined,
          reason: stderrTail.trim() || (signal ? `signal ${signal}` : undefined),
        });
      });
    },
    onError: (listener) => {
      child.on('error', (err) => listener(err));
    },
    close: () => {
      try {
        child.kill('SIGTERM');
        const t = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already exited */ }
        }, KILL_GRACE_MS);
        t.unref();
      } catch { /* already exited */ }
    },
  };
};

/** Build the server-side `StdioSpawn`. One instance is shared by the
 *  executor + watch-poll mcp handlers (both read the same `connectionMcp`
 *  deps at the boot site). Resolves once the child has started ('spawn');
 *  rejects on spawn failure ('error' — ENOENT, EACCES, …) or signal abort
 *  (with an `AbortError`-named error → STEP_TIMEOUT at the handler). */
export const createStdioSpawn = (): StdioSpawn =>
  (spec, opts) =>
    new Promise<StdioClientHandle>((resolve, reject) => {
      // Don't spawn a doomed process for an already-aborted signal.
      if (opts.signal?.aborted) {
        const err = new Error('stdio MCP spawn aborted');
        err.name = 'AbortError';
        reject(err);
        return;
      }

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(spec.command, spec.args, {
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: buildEnv(spec.env),
        });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }

      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        opts.signal?.removeEventListener('abort', onAbort);
        fn();
      };
      function onAbort(): void {
        finish(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
          const err = new Error('stdio MCP spawn aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }

      // Wire the spawn / error listeners BEFORE the abort listener so a
      // synchronous-ish 'error' (bad command) is never missed.
      child.once('spawn', () => {
        finish(() => resolve(adaptChild(child)));
      });
      // Pre-start failure (the command doesn't exist / isn't executable).
      child.once('error', (err: Error) => {
        finish(() => reject(err));
      });

      opts.signal?.addEventListener('abort', onAbort, { once: true });
    });
