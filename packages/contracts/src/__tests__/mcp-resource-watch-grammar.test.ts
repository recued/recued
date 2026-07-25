/** mcp-resource poll grammar (the 2nd WatchPollSource).
 *
 *  Wire-level pins: a resource uri (carrying `/` `:` `?` `.`) must
 *  encode into ONE dotted bus-path segment, the authored subscriber
 *  pattern must parse back to the SAME uri, and the source's
 *  `event_scope` path must be re-parseable — drift here is a silently
 *  dead subscription (the watcher emits one path, the recipe subscribes
 *  to another). */

import { describe, expect, it } from 'vitest';
import {
  MCP_RESOURCE_POLL_SOURCE_ID,
  MCP_RESOURCE_WATCH_PLATFORM,
  MCP_RESOURCE_WATCH_VENDOR,
  decodeMcpResourceUri,
  encodeMcpResourceUri,
  mcpResourceEventScope,
  parseMcpResourceWatchDemand,
} from '../watch.js';

/** The `isValidPattern` segment grammar (warehouse-events glob) — an
 *  encoded uri MUST be exactly one such segment so the authored pattern
 *  is creatable via `triggers.create`. Inlined to keep contracts tests
 *  package-local. */
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

describe('mcp-resource uri codec', () => {
  const uris = [
    'file:///notes/todo.md',
    'https://example.com/api/v1/things?since=2026-01-01&limit=50',
    'custom://server/résumé.txt', // unicode
    'a', // minimal
    'mcp+sse://host:8080/path#frag',
  ];

  it('round-trips every uri shape through a single url-safe segment', () => {
    for (const uri of uris) {
      const encoded = encodeMcpResourceUri(uri);
      expect(encoded).toMatch(SEGMENT_RE);
      expect(encoded.includes('.')).toBe(false); // never breaks the dotted path
      expect(decodeMcpResourceUri(encoded)).toBe(uri);
    }
  });

  it('decode rejects empty, padded, and corrupt segments', () => {
    expect(decodeMcpResourceUri('')).toBeNull();
    // canonical encode is unpadded — a padded variant is non-canonical
    const padded = `${encodeMcpResourceUri('file:///x')}=`;
    expect(decodeMcpResourceUri(padded)).toBeNull();
    // a `.` is not a base64url char and would never be one segment
    expect(decodeMcpResourceUri('not.base64')).toBeNull();
  });
});

describe('parseMcpResourceWatchDemand', () => {
  const enc = encodeMcpResourceUri('file:///notes/todo.md');

  it('parses connection + uri from a literal pattern (with trailing kind / **)', () => {
    expect(parseMcpResourceWatchDemand(`data.connection.mcp.my-server.resource.${enc}.updated`)).toEqual({
      connection_name: 'my-server',
      uri: 'file:///notes/todo.md',
    });
    expect(parseMcpResourceWatchDemand(`data.connection.mcp.my-server.resource.${enc}.**`)).toEqual({
      connection_name: 'my-server',
      uri: 'file:///notes/todo.md',
    });
  });

  it('returns null for non-mcp / malformed / wildcard patterns', () => {
    // wrong prefix (connection-api, not mcp)
    expect(parseMcpResourceWatchDemand('data.connection.api.hubspot.deal.**')).toBeNull();
    // too few segments
    expect(parseMcpResourceWatchDemand('data.connection.mcp.my-server.resource')).toBeNull();
    // missing the literal `resource` segment
    expect(parseMcpResourceWatchDemand(`data.connection.mcp.my-server.tool.${enc}.x`)).toBeNull();
    // wildcard connection — no enumerable poll target
    expect(parseMcpResourceWatchDemand(`data.connection.mcp.*.resource.${enc}.updated`)).toBeNull();
    // wildcard uri — no enumerable poll target
    expect(parseMcpResourceWatchDemand('data.connection.mcp.my-server.resource.*.updated')).toBeNull();
    expect(parseMcpResourceWatchDemand('data.connection.mcp.my-server.resource.**')).toBeNull();
    // undecodable uri segment
    expect(parseMcpResourceWatchDemand('data.connection.mcp.my-server.resource.not.base64.x')).toBeNull();
    // connection segment violating the connection-name grammar (uppercase)
    expect(parseMcpResourceWatchDemand(`data.connection.mcp.MyServer.resource.${enc}.updated`)).toBeNull();
  });
});

describe('mcpResourceEventScope', () => {
  it('emits the connection.mcp path triple, re-parseable to the source uri', () => {
    const uri = 'https://example.com/feed.json';
    const encoded = encodeMcpResourceUri(uri);
    const scope = mcpResourceEventScope('my-server', encoded);
    expect(scope).toEqual({
      platform: MCP_RESOURCE_WATCH_PLATFORM,
      slug: 'my-server',
      entity_type: `resource.${encoded}`,
    });
    // The emitted bus path (data.<platform>.<slug>.<entity_type>.<kind>)
    // round-trips to the SAME demand a subscriber authored.
    const emittedPath = `data.${scope.platform}.${scope.slug}.${scope.entity_type}.created`;
    expect(parseMcpResourceWatchDemand(emittedPath)).toEqual({
      connection_name: 'my-server',
      uri,
    });
  });

  it('exposes stable source id + vendor sentinel', () => {
    expect(MCP_RESOURCE_POLL_SOURCE_ID).toBe('mcp-resource');
    expect(MCP_RESOURCE_WATCH_VENDOR).toBe('mcp-resource');
    expect(MCP_RESOURCE_WATCH_PLATFORM).toBe('connection.mcp');
  });

  it('the mcp watch vendor is keyspace-disjoint from the connection-api vendor', () => {
    // A connection-api watch key leads with a SEGMENT_RE identifier
    // (parseWatchDemandFromPattern pins the pattern vendor to
    // /^[a-z][a-z0-9_]*$/). The mcp sentinel must NOT match it, so the
    // two sources can never mint colliding `watchKeyOf(...)` leading
    // segments — even if a free-form api `config_json.vendor` spells
    // `mcp`. This invariant guards the fix; do not "tidy" the hyphen away.
    expect(/^[a-z][a-z0-9_]*$/.test(MCP_RESOURCE_WATCH_VENDOR)).toBe(false);
  });
});
