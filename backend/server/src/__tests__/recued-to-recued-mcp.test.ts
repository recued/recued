/** Case 3 — Recued subscribing to Recued, which is not a case at all.
 *
 *  🔑 THERE IS NOTHING PEER-SPECIFIC HERE, AND THAT IS THE FINDING. A peer
 *  Recued reached over MCP is an ordinary `connection.mcp` row — the codebase
 *  says so in its own words ("exa, GitHub, peer Recued all share this shape"),
 *  and there is no peer branch anywhere in the connection path. So this file
 *  builds no peer machinery. It composes the two halves that already exist —
 *  the case-1 listen SOURCE and the case-2 listen SERVER — and pins what they
 *  actually do when joined.
 *
 *  ⛔ WHY IT IS WORTH A TEST WHEN THE ANSWER IS "NOTHING FLOWS". The two halves
 *  ask for and serve DISJOINT members of the closed filter vocabulary: the
 *  source asks only for `resourceSubscriptions`, and Recued's host honours only
 *  `toolsListChanged` because it serves no resources. Every unit test on either
 *  side passes regardless — this is the only place the join is exercised, and
 *  the join is where the cost lands: an empty acknowledgement used to leave a
 *  socket open forever, because the open SUCCEEDED and only a DROPPED feed
 *  triggers the re-open path.
 *
 *  If Recued ever grows a resources surface, this test starts failing on the
 *  "nothing flows" assertion, which is the correct way to find out. */

import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { encodeMcpResourceUri } from '@recued/contracts';
import { createMcpListenOpener } from '@recued/ingredients';
import { createRateLimiter } from '../ports/common/rate-limit.js';
import { createMcpPortHandler } from '../ports/mcp/handler.js';
import { createMcpSubscriptions } from '../mcp-subscriptions.js';
import {
  createMcpListenSource,
  MCP_LISTEN_REOPEN_CEILING_MS,
} from '../watch/mcp-listen-source.js';

const TOKEN = 'peer-bearer';
const CONN = 'peer-recued';
const URI = 'recued://recipes/all';

let server: Server | undefined;
afterEach(async () => {
  if (server !== undefined) {
    server.closeAllConnections();
    await new Promise<void>((done) => { server!.close(() => done()); });
    server = undefined;
  }
});

/** A real Recued MCP door: the real port handler over the real subscriptions
 *  port, on a real socket. `liveSockets` is the assertion that matters. */
const startPeerRecued = async (): Promise<{ port: number; liveSockets: () => number }> => {
  const dispatch = async (envelope: unknown): Promise<unknown> => {
    const method = (envelope as { method?: string }).method ?? '';
    const id = (envelope as { id?: unknown }).id ?? null;
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { resultType: 'complete', tools: [] } };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  };
  const handler = createMcpPortHandler({
    verifier: (t) => t === TOKEN,
    limiter: createRateLimiter({ capacity: 1_000, refill_window_ms: 60_000 }),
    dispatch,
    subscriptions: createMcpSubscriptions({ dispatch }),
  });
  let sockets = 0;
  server = createServer((req, res) => { void handler(req, res); });
  server.on('connection', (socket) => {
    sockets += 1;
    socket.on('close', () => { sockets -= 1; });
  });
  await new Promise<void>((ready) => { server!.listen(0, '127.0.0.1', ready); });
  const address = server.address();
  return {
    port: address !== null && typeof address === 'object' ? address.port : 0,
    liveSockets: () => sockets,
  };
};

describe('a peer Recued is an ordinary MCP connection', () => {
  it('⛔ opens, learns the peer subscribes to nothing, and DROPS the socket', async () => {
    const peer = await startPeerRecued();
    const openStream = createMcpListenOpener({
      decodeAuth: async () => ({ type: 'bearer', token: TOKEN } as never),
    });
    const row = {
      pk: `mcp:${CONN}`, kind: 'mcp', name: CONN, display_name: 'Peer Recued',
      subtype: 'sse',
      config_json: JSON.stringify({
        transport: 'sse',
        endpoint: `http://127.0.0.1:${peer.port}/mcp`,
      }),
      auth_ciphertext: 'x', enrolled_at: 1, updated_at: 1,
    };
    const delays: number[] = [];
    const source = createMcpListenSource({
      listTriggers: () => ([{
        trigger_id: 't1', recipe_id: 'watch-peer', publisher_id: 'local', enabled: true,
        pattern: `data.connection.mcp.${CONN}.resource.${encodeMcpResourceUri(URI)}.updated`,
      }] as never),
      listMcpConnections: () => [CONN],
      openListen: async ({ uris, onResourceUpdated }) => {
        const opened = await openStream({ row: row as never, uris, onResourceUpdated });
        return opened.ok
          ? {
              ok: true,
              acknowledged: opened.handle.acknowledged,
              ended: opened.handle.ended,
              close: () => { opened.handle.close(); },
            }
          : { ok: false, reason: opened.reason };
      },
      pollNow: async () => {},
      schedule: (_fn, ms) => { delays.push(ms); },
    });

    source.recompute();
    // The peer answers, acknowledges nothing we asked for, and we let go.
    await vi.waitFor(() => { expect(delays).toHaveLength(1); });
    expect(source.activeFeedCount()).toBe(0);
    await vi.waitFor(() => { expect(peer.liveSockets()).toBe(0); });

    // Definitive, not transient: a peer's capability will not change in a
    // second, so this waits the ceiling rather than climbing the fast ladder.
    expect(delays[0]).toBe(MCP_LISTEN_REOPEN_CEILING_MS);

    // ⇒ and the owner is told in a sentence, not an enum.
    const governance = source.provider.list()[0]!;
    expect(governance.active).toBe(false);
    expect(governance.inactive_reason).toBe(
      'this MCP server subscribes to no resources — the resource is polled instead',
    );
    await source.stop();
  });
});
