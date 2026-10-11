/** The hostname the Reachability Doctor's external probe asks about.
 *
 *  ⛔ It was `<handle>.recued.cloud`, a zone that serves no handles. The cloud
 *  probe's authorizer (`createProDdnsTargetAuthorizer`) accepts a hostname only
 *  when `isProDdnsHost` does, so every check for a paired handle came back
 *  `diagnostic_target_unauthorized` (2026-10-09). The assertion that would have
 *  caught it is the authorizer's own predicate, not a literal. */

import { isProDdnsHost } from '@recued/contracts';
import { describe, expect, it } from 'vitest';

import { hostnameFromHandle } from '../webclient-bootstrap.js';

describe('hostnameFromHandle', () => {
  it('names a bare handle under a zone the cloud probe accepts', () => {
    const hostname = hostnameFromHandle('alice');
    expect(hostname).toBe('alice.recued.net');
    expect(isProDdnsHost(hostname)).toBe(true);
  });

  it('normalises case and whitespace the way the zone registry does', () => {
    expect(hostnameFromHandle('  Alice ')).toBe('alice.recued.net');
  });

  it('keeps a name that is already qualified, and has nothing for an empty handle', () => {
    expect(hostnameFromHandle('server.example.com')).toBe('server.example.com');
    expect(hostnameFromHandle('   ')).toBeNull();
  });
});
