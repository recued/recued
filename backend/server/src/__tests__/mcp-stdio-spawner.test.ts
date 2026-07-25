/** D-125 P4.2 (B3b) — `mcp-stdio-spawner` real-subprocess tests.
 *
 *  The handler suite (`d-125-phase-4-2-connection-mcp`) drives the stdio
 *  transport through a MOCK spawner; it cannot prove what the REAL spawner
 *  exists to guarantee:
 *    - newline-delimited JSON-RPC framing over a real child's stdin/stdout,
 *    - `config.env` reaches the child + a curated MINIMAL env (PATH curated
 *      in, the server's other env NOT inherited),
 *    - spawn failure (ENOENT) rejects, child-exit fires onClose, a
 *      pre-aborted signal rejects AbortError.
 *  Each test spawns a tiny inline node "echo MCP server" on a real pipe. */

import { describe, it, expect, afterEach } from 'vitest';
import { createStdioSpawn } from '../mcp-stdio-spawner.js';
import type { StdioClientHandle } from '@recued/ingredients';

// A minimal MCP-over-stdio server: reads newline-delimited JSON-RPC from
// stdin, answers `initialize` + `tools/call` (echoing params + a few env
// markers), and `exit`s on demand. `\\n` in this template becomes the
// two-char `\n` escape in the node source (a real newline at runtime).
const ECHO_SERVER = `
let buf = '';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') {
      send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'echo', version: '1' } } });
    } else if (m.method === 'tools/call') {
      send({ jsonrpc: '2.0', id: m.id, result: { echo: m.params, env_marker: process.env.MCP_TEST_MARKER || null, has_path: !!process.env.PATH, leaked: process.env.MCP_LEAK_SENTINEL || null } });
    } else if (m.method === 'exit') {
      process.exit(0);
    } else if (m.id !== undefined) {
      send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown' } });
    }
  }
});
`;

const open: StdioClientHandle[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
});

/** Send JSON-RPC requests + await responses correlated by id. */
const driver = (handle: StdioClientHandle): ((req: { id: number; method: string; params?: unknown }) => Promise<any>) => {
  const waiters = new Map<number, (msg: any) => void>();
  handle.onMessage((data) => {
    let msg: any;
    try { msg = JSON.parse(data); } catch { return; }
    if (typeof msg.id === 'number') {
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
    }
  });
  return (req) =>
    new Promise<any>((resolve) => {
      waiters.set(req.id, resolve);
      handle.send(JSON.stringify({ jsonrpc: '2.0', ...req }));
    });
};

describe('mcp-stdio-spawner — real subprocess', () => {
  it('frames JSON-RPC over stdio, round-trips, passes config.env, curates a minimal env', async () => {
    process.env.MCP_LEAK_SENTINEL = 'should-not-leak';
    try {
      const handle = await createStdioSpawn()(
        { command: process.execPath, args: ['-e', ECHO_SERVER], env: { MCP_TEST_MARKER: 'hi' } },
        {},
      );
      open.push(handle);
      const rpc = driver(handle);
      const init = await rpc({ id: 1, method: 'initialize', params: {} });
      expect(init.result.serverInfo.name).toBe('echo');
      const tool = await rpc({ id: 2, method: 'tools/call', params: { name: 'x', arguments: {} } });
      expect(tool.result.echo).toEqual({ name: 'x', arguments: {} });
      expect(tool.result.env_marker).toBe('hi'); // config.env reached the child
      expect(tool.result.has_path).toBe(true);    // PATH curated in
      expect(tool.result.leaked).toBeNull();      // the server's full env was NOT inherited
    } finally {
      delete process.env.MCP_LEAK_SENTINEL;
    }
  });

  it('rejects when the command does not exist (ENOENT)', async () => {
    await expect(
      createStdioSpawn()({ command: '/nonexistent/definitely-not-here-xyz', args: [] }, {}),
    ).rejects.toBeDefined();
  });

  it('fires onClose when the child exits', async () => {
    const handle = await createStdioSpawn()(
      { command: process.execPath, args: ['-e', ECHO_SERVER] },
      {},
    );
    open.push(handle);
    const closed = new Promise<{ code?: number }>((resolve) => handle.onClose(resolve));
    handle.send(JSON.stringify({ jsonrpc: '2.0', method: 'exit' }));
    const info = await closed;
    expect(info.code).toBe(0);
  });

  it('rejects with AbortError when the spawn signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createStdioSpawn()(
        { command: process.execPath, args: ['-e', 'process.stdin.resume()'] },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
