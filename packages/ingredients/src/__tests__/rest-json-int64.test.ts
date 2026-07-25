import { describe, expect, it, vi } from 'vitest';
import type { ConnectionAuth, ConnectionRow } from '@recued/contracts';
import { createConnectionApiHandler } from '../connection-api.js';
import type { ConnectionApiHandlerDeps } from '../connection-api.js';
import { IngredientError, type ResolvedCall } from '../types.js';

const row: ConnectionRow = {
  pk: 'api:basecamp',
  kind: 'api',
  name: 'basecamp',
  display_name: 'Basecamp',
  config_json: '{"base_url":"https://3.basecampapi.com"}',
  auth_ciphertext: 'opaque',
  enrolled_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
};

const auth: ConnectionAuth = { type: 'none' };

const call = (risk_tier: 'read' | 'write' = 'read'): ResolvedCall => ({
  slug: 'basecamp-int64',
  risk_tier,
  input: {},
  output: {},
});

const handlerFor = (fetchImpl: typeof fetch) => createConnectionApiHandler({
  decodeAuth: async () => auth,
  persistAuth: async () => {},
  fetchImpl,
} satisfies ConnectionApiHandlerDeps);

describe('connection.api exact REST JSON integer modes', () => {
  it('preserves only unsafe plain response integers as exact decimal strings', async () => {
    const responseBody = '{'
      + '"safe":9007199254740991,'
      + '"documented_basecamp_id":9007199254741623,'
      + '"negative":-9007199254740992,'
      + '"fraction":1.25,'
      + '"exponent":1e3,'
      + '"already_text":"9007199254741623"'
      + '}';
    const handler = handlerFor((async () => new Response(responseBody, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch);

    const result = await handler(row, {
      method: 'GET',
      path: '/123/projects.json',
      __rc_json_unsafe_integers: 'string',
    }, call()) as { result: Record<string, unknown> };

    expect(result.result).toEqual({
      safe: 9007199254740991,
      documented_basecamp_id: '9007199254741623',
      negative: '-9007199254740992',
      fraction: 1.25,
      exponent: 1000,
      already_text: '9007199254741623',
    });
  });

  it('keeps native response parsing when the binding mode is absent', async () => {
    const handler = handlerFor((async () => new Response('{"id":9007199254741623}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch);

    const result = await handler(row, {
      method: 'GET',
      path: '/123/projects.json',
    }, call()) as { result: { id: number } };

    expect(result.result.id).toBe(9007199254741624);
  });

  it('serializes selected decimal-string body fields as exact JSON integers', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).toBe(
        '{"person_id":9007199254741623,"assignee_ids":[9007199254741601,9007199254741650],"label":"Owner"}',
      );
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const handler = handlerFor(fetchImpl);

    await handler(row, {
      method: 'POST',
      path: '/123/example.json',
      'header.Content-Type': 'application/json',
      'body.person_id': '9007199254741623',
      'body.assignee_ids': ['9007199254741601', '9007199254741650'],
      'body.label': 'Owner',
      __rc_json_decimal_integer_fields: '["person_id","assignee_ids[]"]',
    }, call('write'));

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('fails closed before dispatch when a selected request integer is not exact decimal text', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const handler = handlerFor(fetchImpl);

    await expect(handler(row, {
      method: 'POST',
      path: '/123/example.json',
      'body.person_id': 9007199254741624,
      __rc_json_decimal_integer_fields: '["person_id"]',
    }, call('write'))).rejects.toBeInstanceOf(IngredientError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
