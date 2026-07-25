/** D-167 P0 forward contract tests for text egress policies, alias refs, and typed transform/query shapes. */

import { describe, it, expect } from 'vitest';

import {
  ALIAS_REF_SCHEME,
  composeAliasRef,
  parseAliasRef,
} from '../pii-alias.js';
import type {
  AliasLookupRequest,
  AliasResolutionRequirement,
  PiiAliasableData,
  PiiFieldTag,
  PiiProtectInput,
  PiiProtectOutput,
  PiiRestoreInput,
  PiiRestoreOutput,
} from '../pii-alias.js';

describe('D-167 alias ref helpers', () => {
  it('exports the alias URI scheme literal', () => {
    expect(ALIAS_REF_SCHEME).toBe('alias');
  });

  it.each([
    ['session_abc', 'pii.Person1'],
    ['session_abc', 'm1@d1.invalid'],
    ['session_abc', 'pii.Phone1.gb'],
    ['session_abc', 'pii.Address1.san-francisco.ca.usa'],
  ])('round-trips scope %s and alias %s', (scopeId, aliasValue) => {
    expect(parseAliasRef(composeAliasRef(scopeId, aliasValue))).toEqual({
      scope_id: scopeId,
      alias_value: aliasValue,
    });
  });

  it('round-trips a slash-bearing scope_id by splitting on the last slash', () => {
    const ref = composeAliasRef('chat/123', 'pii.Person1');

    expect(ref).toBe('alias://chat/123/pii.Person1');
    expect(parseAliasRef(ref)).toEqual({
      scope_id: 'chat/123',
      alias_value: 'pii.Person1',
    });
  });

  it('emits the literal alias://<scope>/<alias> shape', () => {
    expect(composeAliasRef('session_abc', 'pii.Person1')).toBe(
      'alias://session_abc/pii.Person1',
    );
    expect(composeAliasRef('session_abc', 'm1@d1.invalid')).toBe(
      'alias://session_abc/m1@d1.invalid',
    );
  });

  it.each([
    ['wrong scheme', 'http://x/y'],
    ['empty alias', 'alias://s/'],
    ['empty scope', 'alias:///pii.Person1'],
    ['no slash', 'alias://pii.Person1'],
    ['non-string input', 42 as unknown as string],
  ])('returns undefined for %s', (_name, ref) => {
    expect(parseAliasRef(ref)).toBeUndefined();
  });
});

describe('D-167 AliasLookupRequest', () => {
  it('compiles refs, free_text_hints, and exact_or_bounded_search resolution', () => {
    const requiredResolution: AliasResolutionRequirement = 'exact_or_bounded_search';
    const request: AliasLookupRequest = {
      refs: [
        composeAliasRef('session_abc', 'pii.Person1'),
        composeAliasRef('session_abc', 'm1@d1.invalid'),
      ],
      free_text_hints: ['renewal thread'],
      required_resolution: requiredResolution,
    };

    expect(request.required_resolution).toBe('exact_or_bounded_search');
    expect(request.refs).toHaveLength(2);
    expect(request.free_text_hints).toEqual(['renewal thread']);
  });
});

describe('D-167 pii-protect/pii-restore typed I/O', () => {
  it('compiles PiiFieldTag with the email kind', () => {
    const tag: PiiFieldTag = { path: 'owner.email', kind: 'email' };

    expect(tag).toEqual({ path: 'owner.email', kind: 'email' });
  });

  it('compiles single-object data through protect and restore I/O', () => {
    const data: PiiAliasableData = {
      owner: { email: 'alice@example.com', name: 'Alice Chen' },
    };
    const protectInput: PiiProtectInput = {
      data,
      fields: [{ path: 'owner.email', kind: 'email' }],
    };
    const protectOutput: PiiProtectOutput = {
      aliased: { owner: { email: 'm1@d1.invalid', name: 'Alice Chen' } },
      ledger_handle: 'ledger-object',
    };
    const restoreInput: PiiRestoreInput = {
      data: protectOutput.aliased,
      ledger_handle: protectOutput.ledger_handle,
    };
    const restoreOutput: PiiRestoreOutput = {
      restored: protectInput.data,
    };

    expect(restoreInput.ledger_handle).toBe('ledger-object');
    expect(restoreOutput.restored).toEqual(data);
  });

  it('compiles string data through protect and restore I/O', () => {
    const data: PiiAliasableData = 'Email alice@example.com about renewal';
    const protectInput: PiiProtectInput = { data };
    const protectOutput: PiiProtectOutput = {
      aliased: 'Email m1@d1.invalid about renewal',
      ledger_handle: 'ledger-string',
    };
    const restoreInput: PiiRestoreInput = {
      data: protectOutput.aliased,
      ledger_handle: protectOutput.ledger_handle,
    };
    const restoreOutput: PiiRestoreOutput = {
      restored: protectInput.data,
    };

    expect(restoreInput.data).toBe('Email m1@d1.invalid about renewal');
    expect(restoreOutput.restored).toBe(data);
  });

  it('compiles D-162 batch-list data through protect and restore I/O', () => {
    const data: PiiAliasableData = [
      { id: 'a', owner: { email: 'alice@example.com' } },
      { id: 'b', owner: { email: 'alice@example.com' } },
      'Follow up with alice@example.com',
    ];
    const protectInput: PiiProtectInput = {
      data,
      fields: [{ path: 'owner.email', kind: 'email' }],
    };
    const protectOutput: PiiProtectOutput = {
      aliased: [
        { id: 'a', owner: { email: 'm1@d1.invalid' } },
        { id: 'b', owner: { email: 'm1@d1.invalid' } },
        'Follow up with m1@d1.invalid',
      ],
      ledger_handle: 'ledger-batch',
    };
    const restoreInput: PiiRestoreInput = {
      data: protectOutput.aliased,
      ledger_handle: protectOutput.ledger_handle,
    };
    const restoreOutput: PiiRestoreOutput = {
      restored: protectInput.data,
    };

    expect(Array.isArray(protectInput.data)).toBe(true);
    expect(Array.isArray(protectOutput.aliased)).toBe(true);
    expect(restoreInput.ledger_handle).toBe('ledger-batch');
    expect(restoreOutput.restored).toEqual(data);
  });
});
