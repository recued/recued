/** Stand-ins for driving a real coding-agent CLI (pi, opencode) in a live test:
 *  an Anthropic Messages API answering from scripted scenarios, a proxy that
 *  refuses and records every outbound request, and a non-blocking runner.
 *
 *  The latest user message carrying a `[[NAME]]` marker — or one of the packs'
 *  fixed prompts — names the scenario; the tool calls the model made since then
 *  pick its step. A request that offers no tools is the agent's own side call
 *  (opencode titles its sessions that way) and is answered plainly, so it never
 *  consumes a step. */
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type StandInStep =
  | { tool: string; input: Record<string, unknown> }
  | { text: string }
  | { status: number; message: string };

export interface StandInRequest {
  scenario: string;
  step: number;
  tools: string[];
  /** Every user text of the conversation so far, joined — what the model saw. */
  history: string;
  /** The system prompt, joined. */
  system: string;
  /** The tool results this request carried back. */
  results: Array<{ text: string; is_error: boolean }>;
  /** The key the agent sent. */
  api_key: string | undefined;
}

export interface MessagesStandIn {
  server: Server;
  port: number;
  seen: StandInRequest[];
  /** Requests for anything but the Messages API. */
  strays: string[];
  scenarios: Record<string, StandInStep[]>;
  close: () => Promise<void>;
}

export const textOf = (content: unknown): string => typeof content === 'string'
  ? content
  : Array.isArray(content)
    ? content.map((block) => (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
      ? String((block as { text?: unknown }).text ?? '') : '')).join('\n')
    : '';

/** `fixed` maps the opening of a pack's fixed prompt to a scenario name. */
export const startMessagesStandIn = async (fixed: Record<string, string> = {}): Promise<MessagesStandIn> => {
  const seen: StandInRequest[] = [];
  const strays: string[] = [];
  const scenarios: Record<string, StandInStep[]> = {};
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      if (req.method !== 'POST' || !/^\/v1\/messages(\?|$)/.test(req.url ?? '')) {
        strays.push(`${String(req.method)} ${String(req.url)}`);
        res.writeHead(404, { 'content-type': 'application/json' })
          .end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'stand-in' } }));
        return;
      }
      const request = JSON.parse(body) as {
        messages?: Array<{ role: string; content: unknown }>;
        tools?: Array<{ name?: string }>;
        system?: unknown;
        stream?: boolean;
      };
      const messages = request.messages ?? [];
      const tools = (request.tools ?? []).map((tool) => String(tool.name));
      let scenario = 'side';
      let at = -1;
      for (let i = messages.length - 1; i >= 0 && tools.length > 0; i -= 1) {
        if (messages[i]!.role !== 'user') continue;
        const text = textOf(messages[i]!.content);
        // The LAST marker: consecutive user turns can arrive merged into one.
        const marker = [...text.matchAll(/\[\[([A-Z0-9-]+)\]\]/g)].at(-1)?.[1]
          ?? Object.entries(fixed).find(([opening]) => text.includes(opening))?.[1];
        if (marker !== undefined) { scenario = marker; at = i; break; }
      }
      const step = at < 0 ? 0 : messages.slice(at + 1)
        .filter((m) => m.role === 'assistant' && Array.isArray(m.content))
        .flatMap((m) => m.content as Array<Record<string, unknown>>)
        .filter((block) => block.type === 'tool_use').length;
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const key = req.headers['x-api-key'];
      seen.push({
        scenario,
        step,
        tools,
        history: messages.filter((m) => m.role === 'user').map((m) => textOf(m.content)).join('\n'),
        system: Array.isArray(request.system) ? textOf(request.system) : String(request.system ?? ''),
        results: Array.isArray(lastUser?.content)
          ? (lastUser.content as Array<Record<string, unknown>>).filter((b) => b.type === 'tool_result').map((b) => ({
            text: typeof b.content === 'string' ? b.content : textOf(b.content),
            is_error: b.is_error === true,
          }))
          : [],
        api_key: typeof key === 'string' ? key : undefined,
      });
      const next: StandInStep = scenario === 'side'
        ? { text: 'side-title' }
        : scenarios[scenario]?.[step] ?? { text: `${scenario}-ANSWER` };
      if ('status' in next) {
        res.writeHead(next.status, { 'content-type': 'application/json' })
          .end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: next.message } }));
        return;
      }
      // Each response gets its own message id: an agent may merge turns sharing one.
      const id = `msg_${String(seen.length)}_${String(Date.now())}`;
      const block = 'tool' in next
        ? { type: 'tool_use', id: `toolu_${String(seen.length)}`, name: next.tool, input: next.input }
        : { type: 'text', text: next.text };
      const stopReason = 'tool' in next ? 'tool_use' : 'end_turn';
      const usage = { input_tokens: 1, output_tokens: 1 };
      if (request.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          id, type: 'message', role: 'assistant', model: 'stand-in', content: [block],
          stop_reason: stopReason, stop_sequence: null, usage,
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      const send = (event: string, data: unknown): void => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      send('message_start', { type: 'message_start', message: {
        id, type: 'message', role: 'assistant', model: 'stand-in', content: [],
        stop_reason: null, stop_sequence: null, usage,
      } });
      if ('tool' in next) {
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { ...block, input: {} } });
        send('content_block_delta', { type: 'content_block_delta', index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(next.input) } });
      } else {
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: next.text } });
      }
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage });
      send('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    server,
    port: (server.address() as AddressInfo).port,
    seen,
    strays,
    scenarios,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
};

export interface RefusingProxy {
  url: string;
  /** Every target something tried to reach through the proxy. */
  escapes: string[];
  close: () => Promise<void>;
}

/** Forwards nothing: records each target and refuses it. */
export const startRefusingProxy = async (): Promise<RefusingProxy> => {
  const escapes: string[] = [];
  const server = createServer((req, res) => {
    escapes.push(`${String(req.method)} ${String(req.url)}`);
    res.writeHead(403).end();
  });
  server.on('connect', (req, socket) => {
    socket.on('error', () => { /* the client may reset a refused tunnel */ });
    escapes.push(`CONNECT ${String(req.url)}`);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  server.on('clientError', (_err, socket) => { socket.destroy(); });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    escapes,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
};

/** Runs a command to completion WITHOUT blocking this event loop — the
 *  stand-in model answers on it, so a `spawnSync` would deadlock. `PWD` names
 *  `cwd`, as a shell's would: opencode takes its folder from `PWD`. */
export const runCli = (
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; stdin?: string; timeoutMs?: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...(options.env ?? process.env), PWD: options.cwd },
      detached: true,
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
    }, options.timeoutMs ?? 120_000);
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', fail);
    child.on('close', (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
    if (options.stdin !== undefined) child.stdin!.end(options.stdin);
  });
