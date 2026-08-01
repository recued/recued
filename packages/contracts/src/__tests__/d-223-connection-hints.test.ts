/** D-223 Slice 0 — the `connection_hints` contract.
 *
 *  The decision's safety argument is that a hint lands on a field the owner can
 *  SEE and CHANGE, so these tests care about two things: that the admission gate
 *  is the same one the setup guide already applies to inferred suggestions (one
 *  implementation, not a fork), and that a hint cannot reach any cell carrying
 *  authority. */

import { describe, expect, it } from 'vitest';

import {
  APPLICABLE_GUIDE_FIELD_KEYS,
  BULK_PACK_MAX_CONNECTION_HINTS,
  RESERVED_CONNECTION_REQUIREMENT_CELLS,
  canApplyConnectionSetupGuideSuggestion,
  parseBulkPackManifest,
  validateConnectionHintShape,
} from '../index.js';

const codes = (entry: unknown): string[] => {
  const out: string[] = [];
  validateConnectionHintShape(entry, 'connection_hints[0]', (code) => { out.push(code); });
  return out;
};

const hint = (over: Record<string, unknown> = {}) => ({
  connection: 'acme',
  values: { 'config.base_url': 'https://api.acme.example' },
  ...over,
});

const pack = (over: Record<string, unknown> = {}) => ({
  manifest_version: 2,
  artifact_type: 'pack',
  pack_kind: 'app_pack',
  slug: 'acme-tasks',
  publisher: 'some-third-party',
  name: 'Acme Tasks',
  description: 'Read and act on Acme tasks.',
  version: 1,
  recipes: [],
  requires: ['install_bulk_pack'],
  tags: ['pack:acme'],
  // A v2 pack needs at least one content entry; the hint path is what is under
  // test, so this is the smallest valid carrier.
  contents: [{ type: 'recipe', slug: 'list-tasks-acme', version: 1, visible: true }],
  ...over,
});

const packIssues = (over: Record<string, unknown> = {}): string[] => {
  const parsed = parseBulkPackManifest(pack(over)) as {
    issues: Array<{ severity: string; code: string }>;
  };
  return parsed.issues.filter((i) => i.severity === 'error').map((i) => i.code);
};

describe('D-223 — a hint is a value on a visible field', () => {
  it('admits a well-formed hint from a NON-first-party publisher', () => {
    // ⭐ THE PERMITTING CASE. Every other test here proves something is refused,
    // and a rule that only ever refuses is indistinguishable from a blanket ban.
    // This is the input that would do the thing if the design were absent: a
    // third-party pack pre-filling a connection field, which must WORK.
    expect(codes(hint())).toEqual([]);
    expect(packIssues({ connection_hints: [hint()] })).toEqual([]);
  });

  it('needs no publisher gate — unlike connection_requirements', () => {
    // The contrast is the decision: a descriptor is reserved because four of its
    // five cells carry authority; a hint carries none, so the admission filter is
    // the whole control.
    const asCore = packIssues({ publisher: 'recued-core', connection_hints: [hint()] });
    const asThirdParty = packIssues({ publisher: 'anyone-at-all', connection_hints: [hint()] });
    expect(asCore).toEqual([]);
    expect(asThirdParty).toEqual([]);
  });

  it('refuses every cell that belongs to connection_requirements', () => {
    // Refused, never ignored: an ignored declaration reads to its author as an
    // accepted one, which is the failure mode the output-key and variable-key
    // fences exist to prevent.
    for (const cell of RESERVED_CONNECTION_REQUIREMENT_CELLS) {
      expect(codes(hint({ [cell]: 'anything' })), cell)
        .toContain('pack_connection_hint_reserved_cell');
    }
    // `vendor` is the one worth naming: it SELECTS a registered vendor schema,
    // and so would reach the hidden/readonly fields a hint must never touch.
    expect(codes(hint({ vendor: 'google' }))).toContain('pack_connection_hint_reserved_cell');
  });

  it('refuses a field key outside the admitted set', () => {
    expect(codes(hint({ values: { 'auth.client_secret': 'nope' } })))
      .toContain('pack_connection_hint_field_unknown');
    expect(codes(hint({ values: { 'config.vendor': 'google' } })))
      .toContain('pack_connection_hint_field_unknown');
  });

  it('applies the setup guide gate verbatim to endpoint values', () => {
    for (const bad of [
      'http://api.acme.example',              // not https
      'https://localhost/api',                // private host
      'https://192.168.1.10/api',             // RFC1918
      'https://user:pw@api.acme.example',     // embedded credentials
      'not a url',
    ]) {
      expect(codes(hint({ values: { 'config.base_url': bad } })), bad)
        .toContain('pack_connection_hint_value_rejected');
    }
    // A non-endpoint key is not held to the URL bar — it is a scope string.
    expect(codes(hint({ values: { 'auth.scope': 'tasks.read tasks.write' } }))).toEqual([]);
  });

  it('holds setup_url to the same bar as an endpoint', () => {
    expect(codes(hint({ setup_url: 'https://acme.example/developers' }))).toEqual([]);
    expect(codes(hint({ setup_url: 'http://acme.example/developers' })))
      .toContain('pack_connection_hint_setup_url');
    expect(codes(hint({ setup_url: 'https://10.0.0.4/developers' })))
      .toContain('pack_connection_hint_setup_url');
  });

  it('refuses a shapeless hint, an empty value map, and an oversized array', () => {
    expect(codes('nope')).toContain('pack_connection_hint_shape');
    expect(codes(hint({ connection: '' }))).toContain('pack_connection_hint_connection');
    expect(codes(hint({ values: {} }))).toContain('pack_connection_hint_values_empty');
    expect(codes(hint({ values: [] }))).toContain('pack_connection_hint_values_shape');
    expect(codes(hint({ values: { 'config.base_url': 42 } })))
      .toContain('pack_connection_hint_value_shape');
    expect(packIssues({
      connection_hints: Array.from({ length: BULK_PACK_MAX_CONNECTION_HINTS + 1 }, () => hint()),
    })).toContain('pack_connection_hints_too_many');
    expect(packIssues({ connection_hints: 'no' })).toContain('pack_connection_hints_shape');
  });

  it('shares ONE admission implementation with the setup guide', () => {
    // The filter moved into contracts so the manifest validator could reach it.
    // If a second copy ever appears, these diverge — the point of asserting the
    // hint path and the direct call agree on the same inputs.
    for (const [key, value] of [
      ['config.base_url', 'https://api.acme.example'],
      ['config.base_url', 'https://127.0.0.1'],
      ['auth.scope', 'a b c'],
      ['auth.token_endpoint', 'https://acme.example/token'],
      ['auth.token_endpoint', 'ftp://acme.example/token'],
    ] as Array<[string, string]>) {
      const direct = canApplyConnectionSetupGuideSuggestion(key, value);
      const viaHint = codes(hint({ values: { [key]: value } })).length === 0;
      expect(viaHint, `${key}=${value}`).toBe(direct);
    }
  });

  it('the admitted key set is the capability surface', () => {
    // Stated in the decision as the widening mechanism: one entry plus its
    // validation, never a new authoring cell. Pinned so a silent widening shows.
    expect([...APPLICABLE_GUIDE_FIELD_KEYS].sort()).toEqual([
      'auth.authorize_url',
      'auth.param_name',
      'auth.scope',
      'auth.scopes',
      'auth.token_endpoint',
      'config.base_url',
      'subresource_path',
    ]);
  });
});
