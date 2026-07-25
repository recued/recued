/** D-112 C3 — dispatch-layer locked-key filter tests.
 *
 *  parseRecipe is the primary user-facing gate, but bundled recipes +
 *  hand-assembled step input can reach the dispatcher without being
 *  validated. This test family exercises the belt-and-suspenders
 *  filter: locked keys in step input must never reach the adapter,
 *  even when the manifest doesn't declare them. */

import { describe, expect, it } from 'vitest';
import type { IngredientManifest } from '@recued/contracts';
import {
  createIngredientExecutor,
  type Adapter,
} from '../dispatch.js';
import type { ManifestLoader } from '../types.js';

const mkManifest = (overrides: Partial<IngredientManifest> = {}): IngredientManifest => ({
  slug: 'patch-deal',
  name: 'Patch',
  description: 't',
  author: 't',
  kind: 'http',
  category: 'action',
  risk_tier: 'write',
  input: {
    method: 'PATCH',
    url: 'https://api.hubapi.com/crm/v3/objects/deals/{{step.id}}',
    'header.authorization': 'Bearer {{vault.hubspot_token}}',
    'body.properties.dealname': null,
  },
  output: { ok: '$.ok' },
  ...overrides,
});

describe('D-112 C3 — dispatch locked-key filter', () => {
  let seenInput: Record<string, unknown> = {};
  const mkAdapters = () => {
    const http: Adapter = async (resolved) => {
      seenInput = resolved.input;
      return { ok: true };
    };
    return { http };
  };
  const loader: ManifestLoader = async (_slug: string) => mkManifest();

  it('drops recipe overrides of `url` + `method` before the adapter sees them', async () => {
    const exec = createIngredientExecutor({
      manifestLoader: loader,
      adapterRegistry: mkAdapters(),
    });
    await exec('patch-deal', {
      url: 'https://evil.example/x', // locked — must be stripped
      method: 'DELETE', // locked — must be stripped
      'body.properties.dealname': 'Acme',
    });
    expect(seenInput.url).toBe('https://api.hubapi.com/crm/v3/objects/deals/{{step.id}}');
    expect(seenInput.method).toBe('PATCH');
    expect(seenInput['body.properties.dealname']).toBe('Acme');
  });

  it('drops `header.authorization` overrides', async () => {
    seenInput = {};
    const exec = createIngredientExecutor({
      manifestLoader: loader,
      adapterRegistry: mkAdapters(),
    });
    await exec('patch-deal', {
      'header.authorization': 'Bearer pwned',
      'body.properties.dealname': 'x',
    });
    expect(seenInput['header.authorization']).toBe('Bearer {{vault.hubspot_token}}');
  });

  it('drops `header.cookie` + `header.host` overrides', async () => {
    seenInput = {};
    const exec = createIngredientExecutor({
      manifestLoader: loader,
      adapterRegistry: mkAdapters(),
    });
    await exec('patch-deal', {
      'header.cookie': 'session=attacker',
      'header.host': 'evil.example',
      'body.properties.dealname': 'x',
    });
    expect(seenInput['header.cookie']).toBeUndefined();
    expect(seenInput['header.host']).toBeUndefined();
  });

  it('drops MIXED-CASE locked overrides (case-insensitive — HTTP header names are case-insensitive)', async () => {
    seenInput = {};
    const exec = createIngredientExecutor({
      manifestLoader: loader,
      adapterRegistry: mkAdapters(),
    });
    await exec('patch-deal', {
      Method: 'DELETE',
      URL: 'https://evil.example/x',
      'header.Authorization': 'Bearer pwned',
      'header.Cookie': 'session=attacker',
      'header.Host': 'evil.example',
      'body.properties.dealname': 'x',
    });
    // None of the mixed-case variants survive the case-insensitive lock strip.
    expect(seenInput.Method).toBeUndefined();
    expect(seenInput.URL).toBeUndefined();
    expect(seenInput['header.Authorization']).toBeUndefined();
    expect(seenInput['header.Cookie']).toBeUndefined();
    expect(seenInput['header.Host']).toBeUndefined();
    // The manifest's own (lowercase) locked defaults remain; legit body passes.
    expect(seenInput.method).toBe('PATCH');
    expect(seenInput['header.authorization']).toBe('Bearer {{vault.hubspot_token}}');
    expect(seenInput['body.properties.dealname']).toBe('x');
  });

  it('non-locked header overrides still pass through', async () => {
    seenInput = {};
    const exec = createIngredientExecutor({
      manifestLoader: loader,
      adapterRegistry: mkAdapters(),
    });
    await exec('patch-deal', {
      'header.x-api-key': 'user-supplied',
      'header.content-type': 'application/json',
      'body.properties.dealname': 'x',
    });
    expect(seenInput['header.x-api-key']).toBe('user-supplied');
    expect(seenInput['header.content-type']).toBe('application/json');
  });

  it('empty step input + locked manifest defaults still reach the adapter', async () => {
    seenInput = {};
    const exec = createIngredientExecutor({
      manifestLoader: loader,
      adapterRegistry: mkAdapters(),
    });
    await exec('patch-deal', {});
    // Manifest-declared locks still present as defaults.
    expect(seenInput.method).toBe('PATCH');
    expect(seenInput.url).toBeDefined();
    expect(seenInput['header.authorization']).toBeDefined();
  });

  it('drops prototype-sensitive keys from step input before the adapter sees them', async () => {
    seenInput = {};
    const proto = Object.prototype as Record<string, unknown>;
    delete proto.dispatchPolluted;
    const exec = createIngredientExecutor({
      manifestLoader: loader,
      adapterRegistry: mkAdapters(),
    });
    await exec('patch-deal', JSON.parse(
      '{"__proto__":{"dispatchPolluted":true},"constructor":{"leak":true},"prototype":{"leak":true},"body.properties.dealname":"x"}',
    ) as Record<string, unknown>);
    const polluted = Object.prototype.hasOwnProperty.call(proto, 'dispatchPolluted');
    delete proto.dispatchPolluted;

    expect(polluted).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(seenInput, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(seenInput, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(seenInput, 'prototype')).toBe(false);
    expect(seenInput['body.properties.dealname']).toBe('x');
  });

  it('drops prototype-sensitive keys from manifest defaults too', async () => {
    seenInput = {};
    const manifest = mkManifest({
      input: JSON.parse(
        '{"__proto__":{"leak":true},"method":"PATCH","url":"https://api.hubapi.com/crm/v3/objects/deals/1","body.properties.dealname":null}',
      ) as Record<string, unknown>,
    });
    const exec = createIngredientExecutor({
      manifestLoader: async () => manifest,
      adapterRegistry: mkAdapters(),
    });
    await exec('patch-deal', { 'body.properties.dealname': 'x' });

    expect(Object.prototype.hasOwnProperty.call(seenInput, '__proto__')).toBe(false);
    expect(seenInput.method).toBe('PATCH');
    expect(seenInput['body.properties.dealname']).toBe('x');
  });
});
