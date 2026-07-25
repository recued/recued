/** D-125 P7.2 — schemas for `connection.mcp` enrollment.
 *
 *  One schema per transport (sse / websocket / stdio). The connection.mcp
 *  handler (P4.2) implements `sse` end-to-end; `websocket` and `stdio`
 *  raise `MCP_TRANSPORT_NOT_IMPLEMENTED` until their handlers ship. The
 *  dialog still surfaces the picker so the user can enroll the record
 *  ahead of handler readiness — the rpc accepts subtype freely; only
 *  the call-time dispatch is gated. */

import type { ConnectionSchema } from './types.js';

const sse: ConnectionSchema = {
  kind: 'mcp',
  subtype: 'sse',
  label: 'MCP — Server-Sent Events',
  description: 'JSON-RPC over an HTTP SSE endpoint. The most common transport for hosted MCP servers.',
  fields: [
    {
      key: 'name',
      label: 'Name',
      type: 'identifier',
      help: 'Lowercase identifier used in recipes (e.g. `gh-mcp`, `internal-tools`).',
      placeholder: 'gh-mcp',
    },
    { key: 'display_name', label: 'Display Name', type: 'text', placeholder: 'GitHub MCP' },
    {
      key: 'config.endpoint',
      label: 'Endpoint URL',
      type: 'url',
      placeholder: 'https://mcp.github.com/sse',
    },
    {
      key: 'auth.type',
      label: 'Auth Type',
      type: 'select',
      options: ['none', 'bearer', 'header'],
    },
    {
      key: 'auth.token',
      label: 'Bearer Token',
      type: 'secret',
      showWhen: (v) => v['auth.type'] === 'bearer',
    },
    // A repeatable list of N custom credential headers (one for the common
    // single-key case; add more for split-credential vendors). The `header-list`
    // renderer manages the `auth.headers.<i>.*` rows → the `auth.headers` array.
    {
      key: 'auth.headers',
      label: 'Headers',
      type: 'header-list',
      showWhen: (v) => v['auth.type'] === 'header',
      help: 'Sent on every tool call. Add one per credential header — most need just one.',
    },
  ],
  probe: { description: 'Initialize + tools/list — caches the available tool catalog.' },
};

const websocket: ConnectionSchema = {
  kind: 'mcp',
  subtype: 'websocket',
  label: 'MCP — WebSocket',
  description: 'JSON-RPC over WebSocket. Handler ships in a follow-up — the record can still be enrolled now.',
  fields: [
    {
      key: 'name',
      label: 'Name',
      type: 'identifier',
      placeholder: 'streaming-mcp',
    },
    { key: 'display_name', label: 'Display Name', type: 'text' },
    {
      key: 'config.endpoint',
      label: 'WebSocket URL',
      type: 'url',
      placeholder: 'wss://mcp.example.com/ws',
    },
    {
      key: 'auth.type',
      label: 'Auth Type',
      type: 'select',
      options: ['none', 'bearer'],
    },
    {
      key: 'auth.token',
      label: 'Bearer Token',
      type: 'secret',
      showWhen: (v) => v['auth.type'] === 'bearer',
    },
  ],
};

const stdio: ConnectionSchema = {
  kind: 'mcp',
  subtype: 'stdio',
  label: 'MCP — stdio (subprocess)',
  description: 'Child-process MCP server. Server-side only — extension clients cannot fork processes.',
  fields: [
    {
      key: 'name',
      label: 'Name',
      type: 'identifier',
      placeholder: 'local-mcp',
    },
    { key: 'display_name', label: 'Display Name', type: 'text' },
    {
      key: 'config.command',
      label: 'Command',
      type: 'text',
      placeholder: '/usr/local/bin/mcp-server',
      help: 'Absolute path to the executable.',
    },
    {
      key: 'config.args',
      label: 'Arguments (JSON array)',
      type: 'json',
      placeholder: '["--config", "/etc/mcp.toml"]',
      optional: true,
      help: 'Optional. Parsed as JSON; pass an array of strings.',
    },
  ],
};

export const mcpSchemas = { sse, websocket, stdio } as const;

export type McpSubtype = keyof typeof mcpSchemas;
