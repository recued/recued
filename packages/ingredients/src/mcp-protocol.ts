/** MCP protocol-version policy shared by Recued's MCP client and server.
 *
 * MCP 2026-07-28 begins the modern, per-request-metadata era. Older revisions
 * use the initialize/initialized lifecycle. Recued intentionally advertises
 * only versions whose wire behavior it implements; adding a date here is a
 * compatibility claim and must arrive with protocol tests.
 */

export const MCP_MODERN_PROTOCOL_VERSION = '2026-07-28' as const;
export const MCP_LEGACY_PROTOCOL_VERSION = '2024-11-05' as const;

/** What Recued's OWN MCP server advertises — in `server/discover`'s
 * `supportedVersions` and in every `UnsupportedProtocolVersionError.supported`.
 * This is a compatibility CLAIM: a date belongs here only once Recued's server
 * implements that revision's wire behavior, and only with protocol tests. */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_LEGACY_PROTOCOL_VERSION,
] as const;

/** What Recued's CLIENT will ACCEPT when a peer server names its own revision
 * in an `initialize` result. Deliberately wider than what we advertise: the
 * spec's legacy era spans every handshake revision through `2025-11-25`, and a
 * server that has dropped `2024-11-05` answers our request with the nearest
 * revision it does support. Recued's legacy usage is `tools/list` +
 * `tools/call` + `resources/*`, whose wire shape is unchanged across these
 * four, so accepting the server's choice is safe — whereas rejecting it
 * strands the majority of deployed servers. Accepting ≠ advertising: this list
 * must NOT be fed to `supportedVersions`. */
export const MCP_ACCEPTED_LEGACY_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  MCP_LEGACY_PROTOCOL_VERSION,
] as const;

export type RecuedMcpLegacyProtocolVersion =
  (typeof MCP_ACCEPTED_LEGACY_PROTOCOL_VERSIONS)[number];
export type RecuedMcpProtocolVersion =
  | typeof MCP_MODERN_PROTOCOL_VERSION
  | RecuedMcpLegacyProtocolVersion;
export type RecuedMcpProtocolEra = 'modern' | 'legacy';

/** Ceiling for one era-detection round trip. The spec's fallback trigger is
 * "does not respond within a reasonable timeout"; a remote endpoint's TLS
 * handshake plus a cold start routinely exceeds a second, so a tighter bound
 * mis-classifies healthy modern servers as legacy (and, on HTTP, used to fail
 * them outright). Still well under a dispatch's own timeout so a silent legacy
 * server does not stall the call. */
export const MCP_NEGOTIATION_PROBE_TIMEOUT_MS = 10_000;

export interface McpImplementationInfo {
  name: string;
  version: string;
}

export interface McpHttpHeaderBinding {
  /** Header suffix: the wire name is `Mcp-Param-${name}`. */
  name: string;
  /** Exact chain of JSON object properties beneath `tools/call.arguments`. */
  path: string[];
  type: 'string' | 'integer' | 'boolean';
}

export type McpHttpHeaderSchemaResult =
  | { ok: true; bindings: McpHttpHeaderBinding[] }
  | { ok: false; reason: string };

export const MCP_PROTOCOL_VERSION_META_KEY =
  'io.modelcontextprotocol/protocolVersion' as const;
export const MCP_CLIENT_INFO_META_KEY =
  'io.modelcontextprotocol/clientInfo' as const;
export const MCP_CLIENT_CAPABILITIES_META_KEY =
  'io.modelcontextprotocol/clientCapabilities' as const;
export const MCP_SERVER_INFO_META_KEY =
  'io.modelcontextprotocol/serverInfo' as const;

export const MCP_UNSUPPORTED_PROTOCOL_VERSION = -32022;
export const MCP_MISSING_REQUIRED_CLIENT_CAPABILITY = -32021;
export const MCP_HEADER_MISMATCH = -32020;

/** Modern protocol errors prove that the peer understood the per-request era.
 * They must never trigger a downgrade to the legacy initialize lifecycle. */
export const isModernMcpProtocolError = (envelope: unknown): boolean => {
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return false;
  }
  const error = (envelope as { error?: unknown }).error;
  if (error === null || typeof error !== 'object' || Array.isArray(error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === MCP_HEADER_MISMATCH
    || code === MCP_MISSING_REQUIRED_CLIENT_CAPABILITY
    || code === MCP_UNSUPPORTED_PROTOCOL_VERSION;
};

export const mcpProtocolEra = (
  version: RecuedMcpProtocolVersion,
): RecuedMcpProtocolEra =>
  version === MCP_MODERN_PROTOCOL_VERSION ? 'modern' : 'legacy';

export const isRecuedMcpProtocolVersion = (
  value: unknown,
): value is RecuedMcpProtocolVersion =>
  value === MCP_MODERN_PROTOCOL_VERSION
  || MCP_ACCEPTED_LEGACY_PROTOCOL_VERSIONS.some((version) => version === value);

/** Required `_meta` envelope for a modern MCP request. */
export const modernMcpRequestMeta = (
  clientInfo: McpImplementationInfo,
): Record<string, unknown> => ({
  [MCP_PROTOCOL_VERSION_META_KEY]: MCP_MODERN_PROTOCOL_VERSION,
  [MCP_CLIENT_INFO_META_KEY]: clientInfo,
  [MCP_CLIENT_CAPABILITIES_META_KEY]: {},
});

/** Preserve authored params while installing Recued's modern wire metadata. */
export const withModernMcpRequestMeta = (
  params: unknown,
  clientInfo: McpImplementationInfo,
): Record<string, unknown> => ({
  ...(params !== null && typeof params === 'object' && !Array.isArray(params)
    ? params as Record<string, unknown>
    : {}),
  _meta: modernMcpRequestMeta(clientInfo),
});

/** Read the modern protocol version declaration, if the envelope has one. */
export const readMcpRequestProtocolVersion = (params: unknown): unknown => {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return undefined;
  }
  const meta = (params as Record<string, unknown>)._meta;
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return undefined;
  }
  return (meta as Record<string, unknown>)[MCP_PROTOCOL_VERSION_META_KEY];
};

export const hasModernMcpClientCapabilities = (params: unknown): boolean => {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return false;
  }
  const meta = (params as Record<string, unknown>)._meta;
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return false;
  }
  const capabilities = (meta as Record<string, unknown>)[MCP_CLIENT_CAPABILITIES_META_KEY];
  return capabilities !== null && typeof capabilities === 'object' && !Array.isArray(capabilities);
};

/** A discover response is modern evidence only when it explicitly offers a
 * version Recued implements. Unknown/malformed responses select no version and
 * allow the caller's conservative legacy fallback policy to run. */
export const selectMcpDiscoverVersion = (
  result: unknown,
): typeof MCP_MODERN_PROTOCOL_VERSION | undefined => {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return undefined;
  }
  const versions = (result as Record<string, unknown>).supportedVersions;
  if (!Array.isArray(versions)) return undefined;
  return versions.includes(MCP_MODERN_PROTOCOL_VERSION)
    ? MCP_MODERN_PROTOCOL_VERSION
    : undefined;
};

/** Validate the server-selected legacy initialize version. The legacy
 * lifecycle lets the server answer with a revision OTHER than the one
 * requested when it does not implement ours, so this accepts any handshake-era
 * revision Recued can speak — not just the one we asked for. */
export const selectMcpLegacyInitializeVersion = (
  result: unknown,
): RecuedMcpLegacyProtocolVersion | undefined => {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return undefined;
  }
  const declared = (result as Record<string, unknown>).protocolVersion;
  return MCP_ACCEPTED_LEGACY_PROTOCOL_VERSIONS.find((version) => version === declared);
};

/** Name the `resultType` in a result Recued cannot consume, else undefined.
 *
 * 2026-07-28 made results polymorphic: `complete` carries the answer, while
 * `input_required` carries an MRTR `inputRequests` list the client is expected
 * to satisfy and re-send. Recued declares no client capabilities, so a
 * conformant server owes us `MissingRequiredClientCapability` rather than an
 * input request — but "conformant" is not a property we can assume of an
 * enrolled third-party endpoint, and the spec is explicit that an unrecognized
 * `resultType` MUST be treated as invalid. Passing one through unread would
 * hand a recipe the server's QUESTION as if it were the tool's ANSWER.
 * An absent `resultType` is `complete`, for pre-2026-07-28 servers. */
export const unsupportedMcpResultType = (result: unknown): string | undefined => {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return undefined;
  }
  const resultType = (result as Record<string, unknown>).resultType;
  if (resultType === undefined || resultType === 'complete') return undefined;
  return typeof resultType === 'string' ? resultType : JSON.stringify(resultType);
};

export const mcpServerResultMeta = (
  serverInfo: McpImplementationInfo,
): Record<string, unknown> => ({
  [MCP_SERVER_INFO_META_KEY]: serverInfo,
});

const MCP_NAME_METHODS = new Set(['tools/call', 'resources/read', 'prompts/get']);
const MCP_BASE64_HEADER_SENTINEL_RE = /^=\?base64\?.*\?=$/;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Encode an MCP mirrored header value without relying on Node-only Buffer. */
export const encodeMcpHttpHeaderValue = (value: string): string => {
  if (
    value.length > 0
    && value.trim() === value
    && /^[\x20-\x7e]+$/.test(value)
    && !MCP_BASE64_HEADER_SENTINEL_RE.test(value)
  ) {
    return value;
  }
  const bytes = new TextEncoder().encode(value);
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const bits = (a << 16) | (b << 8) | c;
    encoded += BASE64_ALPHABET[(bits >> 18) & 63];
    encoded += BASE64_ALPHABET[(bits >> 12) & 63];
    encoded += index + 1 < bytes.length ? BASE64_ALPHABET[(bits >> 6) & 63] : '=';
    encoded += index + 2 < bytes.length ? BASE64_ALPHABET[bits & 63] : '=';
  }
  return `=?base64?${encoded}?=`;
};

/** Reverse `encodeMcpHttpHeaderValue`. A value that is not in the sentinel
 * form, or whose payload is not strict base64, is returned unchanged — it is
 * then a plain header value by definition.
 *
 * Servers MUST decode before comparing a mirrored header to the request body:
 * encoding is a CLIENT choice (only some values force it), so comparing our
 * own re-encoded form would reject conforming clients that encode more
 * eagerly than we do. */
export const decodeMcpHttpHeaderValue = (value: string): string => {
  const match = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(value);
  if (match === null) return value;
  const encoded = match[1] ?? '';
  if (encoded.length % 4 !== 0) return value;
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index += 4) {
    const chunk = [0, 1, 2, 3].map((offset) => {
      const char = encoded[index + offset] ?? '=';
      return char === '=' ? -1 : BASE64_ALPHABET.indexOf(char);
    });
    if (chunk[0]! < 0 || chunk[1]! < 0) return value;
    bytes.push(((chunk[0]! << 2) | (chunk[1]! >> 4)) & 0xff);
    if (chunk[2]! >= 0) bytes.push(((chunk[1]! << 4) | (chunk[2]! >> 2)) & 0xff);
    if (chunk[3]! >= 0) bytes.push(((chunk[2]! << 6) | chunk[3]!) & 0xff);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return value;
  }
};

/** The body field `Mcp-Name` mirrors for `method`, unencoded — or undefined
 * when this method carries no name header. One definition, so the client that
 * WRITES the header and the server that VALIDATES it cannot drift. */
export const mcpNameHeaderSource = (
  method: string,
  params: unknown,
): string | undefined => {
  if (!MCP_NAME_METHODS.has(method)) return undefined;
  const record = params !== null && typeof params === 'object' && !Array.isArray(params)
    ? params as Record<string, unknown>
    : {};
  const raw = method === 'resources/read' ? record.uri : record.name;
  return typeof raw === 'string' ? raw : undefined;
};

const MCP_HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const hasMcpHeaderAnnotation = (value: unknown): boolean => {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasMcpHeaderAnnotation);
  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, 'x-mcp-header')) return true;
  return Object.values(record).some(hasMcpHeaderAnnotation);
};

/** Validate and collect the 2026-07-28 `x-mcp-header` annotations from one
 * tool input schema. Only statically reachable `properties` chains are
 * traversed; an annotation under arrays, composition, conditionals, or refs
 * invalidates the tool definition as required by the HTTP transport. */
export const mcpHttpHeaderBindingsFromSchema = (
  schema: unknown,
): McpHttpHeaderSchemaResult => {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return { ok: true, bindings: [] };
  }
  const bindings: McpHttpHeaderBinding[] = [];
  const names = new Set<string>();
  let invalid: string | undefined;

  const visit = (node: unknown, path: string[], isProperty: boolean): void => {
    if (invalid !== undefined || node === null || typeof node !== 'object' || Array.isArray(node)) {
      return;
    }
    const record = node as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, 'x-mcp-header')) {
      const rawName = record['x-mcp-header'];
      if (!isProperty) {
        invalid = 'x-mcp-header is not on a statically reachable property';
        return;
      }
      if (typeof rawName !== 'string' || !MCP_HTTP_TOKEN_RE.test(rawName)) {
        invalid = 'x-mcp-header must be a non-empty HTTP field-name token';
        return;
      }
      if (record.type !== 'string' && record.type !== 'integer' && record.type !== 'boolean') {
        invalid = 'x-mcp-header may annotate only string, integer, or boolean properties';
        return;
      }
      const foldedName = rawName.toLowerCase();
      if (names.has(foldedName)) {
        invalid = 'x-mcp-header names must be case-insensitively unique';
        return;
      }
      names.add(foldedName);
      bindings.push({ name: rawName, path: [...path], type: record.type });
    }

    const properties = record.properties;
    if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
      for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
        visit(child, [...path, key], true);
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === 'properties' || key === 'x-mcp-header') continue;
      if (hasMcpHeaderAnnotation(child)) {
        invalid = `x-mcp-header is not statically reachable through properties (${key})`;
        return;
      }
    }
  };

  visit(schema, [], false);
  return invalid === undefined
    ? { ok: true, bindings }
    : { ok: false, reason: invalid };
};

/** Materialize validated custom request headers from tool-call arguments. */
export const modernMcpToolArgumentHeaders = (
  bindings: readonly McpHttpHeaderBinding[],
  args: unknown,
): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const binding of bindings) {
    let value: unknown = args;
    for (const key of binding.path) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        value = undefined;
        break;
      }
      value = (value as Record<string, unknown>)[key];
    }
    if (value === undefined || value === null) continue;
    const valid = binding.type === 'string'
      ? typeof value === 'string'
      : binding.type === 'boolean'
        ? typeof value === 'boolean'
        : typeof value === 'number' && Number.isSafeInteger(value);
    if (!valid) {
      throw new TypeError(
        `MCP header argument ${binding.path.join('.')} must be ${binding.type}`,
      );
    }
    headers[`Mcp-Param-${binding.name}`] = encodeMcpHttpHeaderValue(String(value));
  }
  return headers;
};

/** Required HTTP headers for one modern MCP request. */
export const modernMcpHttpHeaders = (
  method: string,
  params: unknown,
): Record<string, string> => {
  const rawName = mcpNameHeaderSource(method, params);
  return {
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': MCP_MODERN_PROTOCOL_VERSION,
    'Mcp-Method': method,
    ...(rawName !== undefined
      ? { 'Mcp-Name': encodeMcpHttpHeaderValue(rawName) }
      : {}),
  };
};
