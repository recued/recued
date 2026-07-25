import { describe, expect, it } from 'vitest';

import {
  FORM_RESPONSE_CREATED_EVENT_PATTERN,
  FORM_RESPONSE_EVENT_ENTITY_TYPE,
  FORM_RESPONSE_EVENT_PLATFORM,
  FORM_RESPONSE_EVENT_SLUG,
  MCP_RESERVED_RPC_PREFIXES,
  SERVER_RPC_METHODS,
  SERVER_RPC_METHOD_SET,
  isReservedLocalRpc,
} from '../index.js';

describe('form_response paired-owner RPC contracts', () => {
  const methods = [
    'form_response.list',
    'form_response.get',
    'form_response.set_state',
    'form_response.update',
    'form_response.export',
  ] as const;

  it('registers every method exactly once', () => {
    for (const method of methods) {
      expect(SERVER_RPC_METHODS).toContain(method);
      expect(SERVER_RPC_METHOD_SET.has(method)).toBe(true);
      expect(SERVER_RPC_METHODS.filter((candidate) => candidate === method)).toHaveLength(1);
    }
  });

  it('reserves the full-shape visitor response namespace out of MCP', () => {
    expect(MCP_RESERVED_RPC_PREFIXES).toContain('form_response.');
    for (const method of methods) expect(isReservedLocalRpc(method)).toBe(true);
  });

  it('publishes one stable privacy-safe watcher address', () => {
    expect(FORM_RESPONSE_EVENT_PLATFORM).toBe('form_response');
    expect(FORM_RESPONSE_EVENT_SLUG).toBe('accepted');
    expect(FORM_RESPONSE_EVENT_ENTITY_TYPE).toBe('response');
    expect(FORM_RESPONSE_CREATED_EVENT_PATTERN).toBe(
      'data.form_response.accepted.response.created',
    );
  });
});
