import { describe, expect, it } from 'vitest';
import {
  MCP_ACCEPTED_LEGACY_PROTOCOL_VERSIONS,
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_SERVER_LEGACY_PROTOCOL_VERSIONS,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  decodeMcpHttpHeaderValue,
  encodeMcpHttpHeaderValue,
  handshakeMcpHttpHeaders,
  hasModernMcpClientCapabilities,
  isMcpServerMessage,
  isModernMcpProtocolError,
  mcpHttpHeaderBindingsFromSchema,
  mcpNameHeaderSource,
  mcpServerRequestReply,
  mergeMcpHttpHeaders,
  modernMcpHttpHeaders,
  modernMcpToolArgumentHeaders,
  readMcpRequestProtocolVersion,
  selectMcpDiscoverVersion,
  selectMcpLegacyInitializeVersion,
  selectMcpServerInitializeVersion,
  unsupportedMcpResultType,
  withModernMcpRequestMeta,
} from '../mcp-protocol.js';
import { parseMcpToolListPage } from '../connection-mcp.js';

describe('Recued MCP protocol policy', () => {
  it('orders the newest implemented era before the explicit legacy fallback', () => {
    expect(MCP_SUPPORTED_PROTOCOL_VERSIONS).toEqual([
      '2026-07-28',
      '2025-11-25',
      '2025-06-18',
      '2024-11-05',
    ]);
  });

  it("settles a legacy initialize on the client's revision, else the newest older one it implements", () => {
    for (const [proposed, settled] of [
      ['2025-11-25', '2025-11-25'],
      ['2025-06-18', '2025-06-18'],
      // Needs JSON-RPC batches, which this server refuses: answered with the
      // newest revision OLDER than it, never a newer one it may not know.
      ['2025-03-26', '2024-11-05'],
      ['2024-11-05', '2024-11-05'],
      ['2026-07-28', '2025-11-25'],
      ['2099-01-01', '2025-11-25'],
      ['2024-10-07', '2024-11-05'],
    ] as const) {
      expect(selectMcpServerInitializeVersion({ protocolVersion: proposed }), proposed).toBe(settled);
    }
    for (const params of [{}, { protocolVersion: 20251125 }, { protocolVersion: 'latest' }, null, []]) {
      expect(selectMcpServerInitializeVersion(params), JSON.stringify(params)).toBe('2024-11-05');
    }
  });

  it('builds the required modern per-request metadata without losing params', () => {
    const params = withModernMcpRequestMeta(
      { name: 'search', arguments: { q: 'otters' } },
      { name: 'recued-test', version: '1' },
    );

    expect(params).toMatchObject({
      name: 'search',
      arguments: { q: 'otters' },
      _meta: {
        'io.modelcontextprotocol/protocolVersion': MCP_MODERN_PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientInfo': { name: 'recued-test', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    });
    expect(readMcpRequestProtocolVersion(params)).toBe(MCP_MODERN_PROTOCOL_VERSION);
    expect(hasModernMcpClientCapabilities(params)).toBe(true);
  });

  it('accepts only an explicitly advertised modern version', () => {
    expect(selectMcpDiscoverVersion({
      supportedVersions: ['2099-01-01', MCP_MODERN_PROTOCOL_VERSION],
    })).toBe(MCP_MODERN_PROTOCOL_VERSION);
    expect(selectMcpDiscoverVersion({ supportedVersions: ['2099-01-01'] }))
      .toBeUndefined();
    expect(selectMcpDiscoverVersion({ supportedVersions: '2026-07-28' }))
      .toBeUndefined();
  });

  it('accepts any handshake-era revision the server selects', () => {
    // The legacy lifecycle lets a server answer with a revision other than the
    // one requested. Every date through 2025-11-25 is handshake-era, and
    // Recued's legacy usage (tools/list, tools/call, resources/*) is unchanged
    // across them — so rejecting the server's choice would strand it for no
    // wire-level reason.
    for (const version of MCP_ACCEPTED_LEGACY_PROTOCOL_VERSIONS) {
      expect(selectMcpLegacyInitializeVersion({ protocolVersion: version }))
        .toBe(version);
    }
  });

  it('rejects a server-selected version Recued did not implement', () => {
    // Modern is not reachable through the initialize lifecycle at all, and an
    // unknown date is not a compatibility claim Recued can honor.
    expect(selectMcpLegacyInitializeVersion({ protocolVersion: MCP_MODERN_PROTOCOL_VERSION }))
      .toBeUndefined();
    expect(selectMcpLegacyInitializeVersion({ protocolVersion: '2099-01-01' }))
      .toBeUndefined();
    expect(selectMcpLegacyInitializeVersion({ protocolVersion: 20251125 }))
      .toBeUndefined();
    expect(selectMcpLegacyInitializeVersion({})).toBeUndefined();
  });

  it('never advertises a revision Recued does not implement', () => {
    // `MCP_SUPPORTED_PROTOCOL_VERSIONS` is what Recued's OWN server publishes
    // in server/discover and in UnsupportedProtocolVersionError.supported. The
    // wider accept-list exists for talking TO other servers and must never
    // leak into that claim: only the revisions the server implements are in
    // it, and 2025-03-26, accepted from a peer but not implemented here
    // (batches), stays out.
    expect([...MCP_SUPPORTED_PROTOCOL_VERSIONS])
      .toEqual([MCP_MODERN_PROTOCOL_VERSION, ...MCP_SERVER_LEGACY_PROTOCOL_VERSIONS]);
    expect(MCP_SERVER_LEGACY_PROTOCOL_VERSIONS).toContain(MCP_LEGACY_PROTOCOL_VERSION);
    for (const version of MCP_ACCEPTED_LEGACY_PROTOCOL_VERSIONS) {
      if ((MCP_SERVER_LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(version)) continue;
      expect(MCP_SUPPORTED_PROTOCOL_VERSIONS).not.toContain(version);
    }
    expect(MCP_SUPPORTED_PROTOCOL_VERSIONS).not.toContain('2025-03-26');
  });

  it('round-trips every header value shape through the base64 sentinel', () => {
    for (const value of [
      'us-west1',
      'get_weather',
      'Hello, 世界',
      ' padded ',
      'line1\nline2',
      '=?base64?literal?=',
      'tab\there',
      '',
      '🙂 emoji + accents éàü',
    ]) {
      expect(decodeMcpHttpHeaderValue(encodeMcpHttpHeaderValue(value))).toBe(value);
    }
    // Spec-fixed encodings, so a rewrite of the hand-rolled codec cannot
    // silently change the wire.
    expect(encodeMcpHttpHeaderValue('Hello, 世界')).toBe('=?base64?SGVsbG8sIOS4lueVjA==?=');
    expect(encodeMcpHttpHeaderValue(' padded ')).toBe('=?base64?IHBhZGRlZCA=?=');
    expect(encodeMcpHttpHeaderValue('=?base64?literal?='))
      .toBe('=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=');
    // A plain value is left alone, and a non-sentinel value decodes to itself.
    expect(encodeMcpHttpHeaderValue('us-west1')).toBe('us-west1');
    expect(decodeMcpHttpHeaderValue('us-west1')).toBe('us-west1');
    // Malformed sentinel payloads are returned verbatim, never throwing.
    expect(decodeMcpHttpHeaderValue('=?base64?!!!!?=')).toBe('=?base64?!!!!?=');
    expect(decodeMcpHttpHeaderValue('=?base64?QQ?=')).toBe('=?base64?QQ?=');
  });

  it('names the Mcp-Name body source once for writer and validator', () => {
    expect(mcpNameHeaderSource('tools/call', { name: 'search' })).toBe('search');
    expect(mcpNameHeaderSource('prompts/get', { name: 'greet' })).toBe('greet');
    expect(mcpNameHeaderSource('resources/read', { uri: 'file:///a.txt' }))
      .toBe('file:///a.txt');
    // resources/read reads `uri`, never `name`.
    expect(mcpNameHeaderSource('resources/read', { name: 'search' })).toBeUndefined();
    expect(mcpNameHeaderSource('tools/list', { name: 'search' })).toBeUndefined();
    expect(mcpNameHeaderSource('tools/call', { name: 42 })).toBeUndefined();
  });

  it('treats an absent resultType as complete and names any other', () => {
    expect(unsupportedMcpResultType({ content: [] })).toBeUndefined();
    expect(unsupportedMcpResultType({ resultType: 'complete' })).toBeUndefined();
    expect(unsupportedMcpResultType({ resultType: 'input_required' }))
      .toBe('input_required');
    expect(unsupportedMcpResultType({ resultType: 'something_new' }))
      .toBe('something_new');
    expect(unsupportedMcpResultType(null)).toBeUndefined();
  });

  it('recognizes protocol errors that prove the peer is modern', () => {
    for (const code of [-32020, -32021, -32022]) {
      expect(isModernMcpProtocolError({
        jsonrpc: '2.0', id: 1, error: { code, message: 'modern error' },
      })).toBe(true);
    }
    expect(isModernMcpProtocolError({
      jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' },
    })).toBe(false);
  });

  it('builds required modern HTTP routing headers and safely encodes names', () => {
    expect(modernMcpHttpHeaders('tools/list', {})).toEqual({
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/list',
    });
    expect(modernMcpHttpHeaders('tools/call', { name: 'search' }))
      .toMatchObject({ 'Mcp-Method': 'tools/call', 'Mcp-Name': 'search' });
    expect(modernMcpHttpHeaders('resources/read', { uri: 'file:///résumé' }))
      .toMatchObject({
        'Mcp-Method': 'resources/read',
        'Mcp-Name': '=?base64?ZmlsZTovLy9yw6lzdW3DqQ==?=',
      });
    expect(modernMcpHttpHeaders('tools/call', { name: '=?base64?literal?=' }))
      .toMatchObject({
        'Mcp-Name': '=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=',
      });
  });

  it('validates and mirrors nested x-mcp-header tool parameters', () => {
    const parsed = mcpHttpHeaderBindingsFromSchema({
      type: 'object',
      properties: {
        region: { type: 'string', 'x-mcp-header': 'Region' },
        routing: {
          type: 'object',
          properties: {
            shard: { type: 'integer', 'x-mcp-header': 'Shard' },
            enabled: { type: 'boolean', 'x-mcp-header': 'Enabled' },
          },
        },
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(modernMcpToolArgumentHeaders(parsed.bindings, {
      region: ' us-west1 ',
      routing: { shard: 7, enabled: false },
    })).toEqual({
      'Mcp-Param-Region': '=?base64?IHVzLXdlc3QxIA==?=',
      'Mcp-Param-Shard': '7',
      'Mcp-Param-Enabled': 'false',
    });
  });

  it('rejects invalid or non-static x-mcp-header annotations', () => {
    expect(mcpHttpHeaderBindingsFromSchema({
      type: 'object',
      properties: {
        a: { type: 'number', 'x-mcp-header': 'Region' },
      },
    }).ok).toBe(false);
    expect(mcpHttpHeaderBindingsFromSchema({
      type: 'object',
      properties: {
        a: { type: 'string', 'x-mcp-header': 'Region' },
        b: { type: 'boolean', 'x-mcp-header': 'region' },
      },
    }).ok).toBe(false);
    expect(mcpHttpHeaderBindingsFromSchema({
      type: 'object',
      oneOf: [{ properties: { a: { type: 'string', 'x-mcp-header': 'Region' } } }],
    }).ok).toBe(false);
  });

  it('excludes an invalid custom-header tool from an HTTP tools/list page', () => {
    expect(parseMcpToolListPage({
      tools: [
        { name: 'valid', inputSchema: { type: 'object' } },
        {
          name: 'invalid',
          inputSchema: {
            type: 'object',
            properties: { amount: { type: 'number', 'x-mcp-header': 'Amount' } },
          },
        },
      ],
    }, { validateHttpHeaders: true })).toMatchObject({
      ok: true,
      tools: ['valid'],
      descriptors: [{ name: 'valid' }],
    });
  });
});

describe('MCP client wire helpers', () => {
  it('names the settled revision in a header only for the revisions that define one', () => {
    // The header arrived in 2025-06-18; 2024-11-05 and 2025-03-26 have none.
    expect(handshakeMcpHttpHeaders('2025-11-25')).toEqual({ 'MCP-Protocol-Version': '2025-11-25' });
    expect(handshakeMcpHttpHeaders('2025-06-18')).toEqual({ 'MCP-Protocol-Version': '2025-06-18' });
    expect(handshakeMcpHttpHeaders('2025-03-26')).toEqual({});
    expect(handshakeMcpHttpHeaders(MCP_LEGACY_PROTOCOL_VERSION)).toEqual({});
    expect(handshakeMcpHttpHeaders(undefined)).toEqual({});
  });

  it('merges header sets by case-insensitive name, the later one winning', () => {
    const merged = mergeMcpHttpHeaders(
      { 'Content-Type': 'application/json', Authorization: 'Bearer x' },
      { 'content-type': 'application/json; charset=utf-8' },
    );
    expect(merged).toEqual({ 'content-type': 'application/json; charset=utf-8', Authorization: 'Bearer x' });
    // ⇒ so fetch can never join two spellings into one header.
    expect(new Headers(merged).get('content-type')).toBe('application/json; charset=utf-8');
  });

  it('tells a request from the server apart from a reply carrying the same id', () => {
    expect(isMcpServerMessage({ jsonrpc: '2.0', id: 1, method: 'ping' })).toBe(true);
    expect(isMcpServerMessage({ jsonrpc: '2.0', method: 'notifications/progress' })).toBe(true);
    expect(isMcpServerMessage({ jsonrpc: '2.0', id: 1, result: {} })).toBe(false);
    expect(isMcpServerMessage({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'x' } })).toBe(false);
  });

  it('answers a ping empty and refuses what this client never declared', () => {
    expect(mcpServerRequestReply(3, 'ping')).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
    expect(mcpServerRequestReply('s-1', 'sampling/createMessage')).toEqual({
      jsonrpc: '2.0', id: 's-1', error: { code: -32601, message: 'Method not found: sampling/createMessage' },
    });
  });
});
