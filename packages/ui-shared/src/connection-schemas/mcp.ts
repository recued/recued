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
  description: 'The usual way to reach a hosted AI-tools server over the web.',
  fields: [
    {
      key: 'name',
      label: 'Name',
      type: 'identifier',
      help: 'A short lower-case name you use in Recipes, such as `gh-mcp`, `internal-tools`).',
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
      help: 'Sent every time. Add one line per header. Most need only one.',
    },
  ],
  probe: { description: 'Recued asks what tools it offers, and remembers the list.' },
};

const websocket: ConnectionSchema = {
  kind: 'mcp',
  subtype: 'websocket',
  label: 'MCP — WebSocket',
  description: 'Over a live web connection. Recued cannot use this yet, but you can set it up now.',
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
  description: 'A tools server Recued starts itself. Only your server can do this, not a browser.',
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
      help: 'You can leave this empty. Write it as a JSON list of words.',
    },
  ],
};

export const mcpSchemas = { sse, websocket, stdio } as const;

export type McpSubtype = keyof typeof mcpSchemas;
