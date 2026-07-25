/** Resolution tests for the `context.server.*` field — the typed
 *  `ContextServer` shape exposed by the engine at recipe-execution
 *  start so recipes can gate warehouse-dependent steps via
 *  `skip_when` / `fail_on`.
 *
 *  These tests live next to the resolver (not next to the engine /
 *  SW) because the resolver is the only piece that has to know how
 *  to walk the dotted path. The injection sites (SW handler +
 *  server execute-handler) are tested in their own surface-level
 *  files. */

import { describe, expect, it } from 'vitest';
import { resolveRef } from '../resolve.js';
import type { NamespaceStores } from '../resolve.js';
import type { ContextServer } from '../context.js';

const makeStores = (server: ContextServer | undefined): NamespaceStores => ({
  vault: {},
  config: {},
  context: server ? { server } : {},
  meta: {},
  step: {},
});

describe('context.server resolution', () => {
  it('resolves available=true to a boolean', () => {
    const stores = makeStores({ available: true, name: 'Home Server' });
    expect(resolveRef('{{context.server.available}}', stores)).toBe(true);
  });

  it('resolves available=false to a boolean', () => {
    const stores = makeStores({ available: false });
    expect(resolveRef('{{context.server.available}}', stores)).toBe(false);
  });

  it('resolves the optional name field', () => {
    const stores = makeStores({ available: true, name: 'Work Mac' });
    expect(resolveRef('{{context.server.name}}', stores)).toBe('Work Mac');
  });

  it('returns undefined when name is omitted', () => {
    const stores = makeStores({ available: true });
    expect(resolveRef('{{context.server.name}}', stores)).toBeUndefined();
  });

  it('returns undefined when context.server is missing entirely', () => {
    const stores = makeStores(undefined);
    expect(resolveRef('{{context.server.available}}', stores)).toBeUndefined();
  });

  it('returns the whole object when path stops at server', () => {
    const stores = makeStores({ available: true, name: 'Home' });
    expect(resolveRef('{{context.server}}', stores)).toEqual({
      available: true,
      name: 'Home',
    });
  });
});

describe('data.* null-safety — confirms per-collection availability flags are unnecessary', () => {
  it('returns undefined for {{data.mail.foo.subject}} when data namespace is empty', () => {
    const stores: NamespaceStores = {
      vault: {}, config: {}, context: {}, meta: {}, step: {},
      // data omitted — Optional namespace, mirrors no-server case
    };
    expect(resolveRef('{{data.mail.foo.subject}}', stores)).toBeUndefined();
  });

  it('returns undefined for missing record id within an existing collection', () => {
    const stores: NamespaceStores = {
      vault: {}, config: {}, context: {}, meta: {}, step: {},
      data: { mail: { 'msg-known': { subject: 'Hi' } } },
    };
    expect(resolveRef('{{data.mail.msg-missing.subject}}', stores)).toBeUndefined();
  });

  it('returns undefined for {{data}} when no server is paired', () => {
    const stores: NamespaceStores = {
      vault: {}, config: {}, context: {}, meta: {}, step: {},
    };
    expect(resolveRef('{{data}}', stores)).toBeUndefined();
  });
});
