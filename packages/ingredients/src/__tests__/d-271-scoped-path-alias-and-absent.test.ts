import { describe, expect, it } from 'vitest';
import { crossCheckCatalogOpenApi, validateIngredient } from '@recued/ingredients';
import { OPENAPI_ABSENT_REASONS } from '@recued/contracts';

/** A minimally valid CATALOG-FORM ingredient, which is what reaches the surface
 *  gate these tests assert on.
 *
 *  ⚠ Two entry conditions, and missing either makes every `.some(...)`
 *  assertion below read FALSE for a reason that has nothing to do with the rule
 *  under test — a vacuous red that looks like a real one. `isCatalogForm`
 *  requires a NON-EMPTY `operations` map (an empty one routes to the wrapper
 *  validator, which never calls `validateApiSurface`), and a
 *  `kind: 'connection'` manifest must additionally declare
 *  `input.connection_kind` + `input.connection`. */
const ingredient = (surfaces: Record<string, unknown>): Record<string, unknown> => ({
  slug: 'd-271-fixture',
  name: 'D-271 fixture',
  description: 'D-271 shape-gate fixture for path_alias lists and openapi_absent.',
  author: 'recued-core',
  kind: 'connection',
  version: 1,
  category: 'data',
  risk_tier: 'read',
  input: {
    operation: null,
    args: null,
    connection_kind: 'api',
    connection: '{{config.connection}}',
  },
  output: { result: 'result' },
  operations: {
    x: {
      operation_id: 'recued-core/d-271.x',
      description: 'Fixture operation carrying the binding under test.',
      risk_tier: 'read',
    },
  },
  ...surfaces,
});

// D-271 — two additions to the publish-time OpenAPI op-prover, both found by
// running `audit:pack-pins` against the four Microsoft Graph packs (39 declared
// ops that the pinned document could not prove):
//
//   1. `path_alias` may be an ORDERED LIST of SCOPED rules. The missing axis was
//      SCOPE, not a new rewrite: Graph keys drive items under `/drives/{id}/…`
//      while the packs call the `/me/drive/…` singleton shortcut, yet the SAME
//      catalog's `/me` is documented verbatim. One uniform rule cannot say that.
//   2. `openapi_absent` — a per-op declaration, with a CLOSED reason and an
//      https evidence URL, that the pinned document structurally cannot prove
//      this op. Counted apart from proven; never folded into a pass.

const SHA = 'a'.repeat(64);
const EVIDENCE = 'https://learn.microsoft.com/en-us/graph/api/driveitem-list-children';

const manifest = (
  ops: Array<{
    key: string;
    method: string;
    path_template: string;
    openapi_path?: string;
    openapi_absent?: unknown;
  }>,
  pathAlias?: unknown,
): Record<string, unknown> => ({
  surfaces: {
    api: {
      openapi_source: {
        url: 'https://example.com/openapi.json',
        sha256: SHA,
        ...(pathAlias !== undefined ? { path_alias: pathAlias } : {}),
      },
      executes: Object.fromEntries(ops.map((op) => [op.key, {
        kind: 'rest',
        method: op.method,
        path_template: op.path_template,
        ...(op.openapi_path !== undefined ? { openapi_path: op.openapi_path } : {}),
        ...(op.openapi_absent !== undefined ? { openapi_absent: op.openapi_absent } : {}),
      }])),
    },
  },
});

const doc = (paths: Record<string, Record<string, unknown>>) => ({ openapi: '3.1.0', paths });

type Issue = { severity: string; code: string; path: string; message: string };
const errs = (r: { issues: Issue[] }) => r.issues.filter((i) => i.severity === 'error');
const exempts = (r: { issues: Issue[] }) =>
  r.issues.filter((i) => i.code === 'CATALOG_OPENAPI_OP_EXEMPT');

// The Graph shape, reduced to its essentials: the singleton IS documented, its
// children are NOT, and the children live under a different, parameterized root.
const GRAPH_DOC = doc({
  '/me': { get: {} },
  '/me/drive': { get: {} },
  '/drives/{drive-id}/root': { get: {} },
  '/drives/{drive-id}/items/{driveItem-id}': { get: {}, patch: {} },
  '/me/mailFolders/{mailFolder-id}/messageRules': { get: {} },
});

const GRAPH_ALIAS = [{ wire_prefix: '/me/drive', doc_base: '/drives/{drive-id}' }];

describe('D-271 — scoped path_alias rules', () => {
  it('rewrites the claimed sub-tree and PROVES ops a single uniform rule could not', () => {
    const r = crossCheckCatalogOpenApi(manifest([
      { key: 'drive.root.read', method: 'get', path_template: '/me/drive/root' },
      { key: 'file.read', method: 'get', path_template: '/me/drive/items/{{item_id}}' },
    ], GRAPH_ALIAS), GRAPH_DOC);
    expect(errs(r)).toEqual([]);
  });

  it('⛔ leaves the PREFIX ITSELF alone — strict descendants only', () => {
    // The regression this rule exists to prevent. `/me/drive` is documented; a
    // rule that claimed `pfx` as well as `pfx + '/'` would rewrite it to
    // `/drives/{drive-id}/` and break the one op that never needed help.
    const r = crossCheckCatalogOpenApi(manifest([
      { key: 'drive.current', method: 'get', path_template: '/me/drive' },
    ], GRAPH_ALIAS), GRAPH_DOC);
    expect(errs(r)).toEqual([]);
  });

  it('⛔ leaves an op NO rule claims completely alone', () => {
    // `/me` shares no prefix with the rule. Under the pre-D-271 single-rule
    // shape a `doc_base` applied unconditionally, which would graft
    // `/drives/{drive-id}` onto `/me` and turn a proving op red.
    const r = crossCheckCatalogOpenApi(manifest([
      { key: 'user.current', method: 'get', path_template: '/me' },
    ], GRAPH_ALIAS), GRAPH_DOC);
    expect(errs(r)).toEqual([]);
  });

  it('MUTATION: removing the alias turns the same ops RED', () => {
    // Without this arm every assertion above would also pass against a prover
    // that ignored `path_alias` entirely.
    const r = crossCheckCatalogOpenApi(manifest([
      { key: 'drive.root.read', method: 'get', path_template: '/me/drive/root' },
      { key: 'file.read', method: 'get', path_template: '/me/drive/items/{{item_id}}' },
    ]), GRAPH_DOC);
    expect(errs(r)).toHaveLength(2);
  });

  it('MUTATION: a WRONG doc_base still fails — nothing is fuzzy-matched', () => {
    const r = crossCheckCatalogOpenApi(manifest([
      { key: 'drive.root.read', method: 'get', path_template: '/me/drive/root' },
    ], [{ wire_prefix: '/me/drive', doc_base: '/wrong/{id}' }]), GRAPH_DOC);
    expect(errs(r)).toHaveLength(1);
  });

  it('MUTATION: a WRONG wire_prefix claims nothing, so the op stays RED', () => {
    const r = crossCheckCatalogOpenApi(manifest([
      { key: 'drive.root.read', method: 'get', path_template: '/me/drive/root' },
    ], [{ wire_prefix: '/me/driveX', doc_base: '/drives/{drive-id}' }]), GRAPH_DOC);
    expect(errs(r)).toHaveLength(1);
  });

  it('matches at a SEGMENT BOUNDARY — /me/drive never claims /me/driveItems/…', () => {
    const r = crossCheckCatalogOpenApi(manifest([
      { key: 'x', method: 'get', path_template: '/me/driveItems/7' },
    ], GRAPH_ALIAS), doc({ '/me/driveItems/7': { get: {} } }));
    expect(errs(r)).toEqual([]);
  });

  it('FIRST matching rule wins; a later rule for the same sub-tree is not applied', () => {
    const r = crossCheckCatalogOpenApi(manifest([
      { key: 'drive.root.read', method: 'get', path_template: '/me/drive/root' },
    ], [
      { wire_prefix: '/me/drive', doc_base: '/drives/{drive-id}' },
      { wire_prefix: '/me/drive', doc_base: '/never/{id}' },
    ]), GRAPH_DOC);
    expect(errs(r)).toEqual([]);
  });

  it('a bare OBJECT still behaves exactly as it did before D-271', () => {
    // The compatibility assertion for the 100 shipped catalogs that carry one.
    const r = crossCheckCatalogOpenApi(manifest([
      { key: 'x.list', method: 'get', path_template: '/ex/jira/{{cloud_id}}/rest/api/3/issue' },
    ], { wire_prefix: '/ex/jira/{cloud_id}' }), doc({ '/rest/api/3/issue': { get: {} } }));
    expect(errs(r)).toEqual([]);
  });
});

describe('D-271 — path_alias list shape gate', () => {
  const gate = (pathAlias: unknown) => validateIngredient(ingredient(
    manifest([{ key: 'x', method: 'get', path_template: '/x' }], pathAlias),
  ) as never);

  it('⛔ REFUSES a catch-all rule placed before a scoped one', () => {
    // A rule with no `wire_prefix` claims every op, so everything after it is
    // dead. The author writes a scoped rule, puts the catch-all above it, and
    // the suite stays green while the scoped rule never runs — silently.
    const r = gate([{ strip_suffix: '.json' }, { wire_prefix: '/v1', doc_base: '/api' }]);
    expect(errs(r).some((i) => i.message.includes('unreachable'))).toBe(true);
  });

  it('ALLOWS a catch-all in last position', () => {
    const r = gate([{ wire_prefix: '/v1', doc_base: '/api' }, { strip_suffix: '.json' }]);
    expect(errs(r).some((i) => i.message.includes('unreachable'))).toBe(false);
  });

  it('refuses an empty list rather than silently meaning "no alias"', () => {
    expect(errs(gate([])).some((i) => i.path.endsWith('path_alias'))).toBe(true);
  });

  it('refuses a non-object rule, naming its INDEX', () => {
    const r = gate([{ wire_prefix: '/v1' }, 'nope']);
    expect(errs(r).some((i) => i.path.endsWith('path_alias[1]'))).toBe(true);
  });

  it('still enforces the dotted strip_suffix inside a list rule', () => {
    const r = gate([{ wire_prefix: '/v1', strip_suffix: 's' }]);
    expect(errs(r).some((i) => i.path.endsWith('path_alias[0].strip_suffix'))).toBe(true);
  });
});

describe('D-271 — openapi_absent', () => {
  const ABSENT = { reason: 'odata_nav_not_expanded', evidence: EVIDENCE };
  const unprovable = [{
    key: 'folder.root.children.list', method: 'get',
    path_template: '/me/drive/root/children',
  }];

  it('the op is unprovable without it', () => {
    const r = crossCheckCatalogOpenApi(manifest(unprovable, GRAPH_ALIAS), GRAPH_DOC);
    expect(errs(r)).toHaveLength(1);
  });

  it('with it, the op stops erroring and is reported APART as exempt', () => {
    const r = crossCheckCatalogOpenApi(
      manifest([{ ...unprovable[0]!, openapi_absent: ABSENT }], GRAPH_ALIAS), GRAPH_DOC);
    expect(errs(r)).toEqual([]);
    // ⛔ The load-bearing half. Silence would read as PROVEN to every caller and
    // make the corpus look better than it is — the one outcome worse than the
    // red it replaces.
    expect(exempts(r)).toHaveLength(1);
    expect(exempts(r)[0]!.message).toContain('odata_nav_not_expanded');
  });

  it('⛔ a MALFORMED exemption buys nothing — the op stays RED', () => {
    // The prover re-checks the shape rather than trusting that the shape gate
    // ran, so a typo'd reason cannot purchase the exemption the gate refused.
    for (const bad of [
      { reason: 'made_up_reason', evidence: EVIDENCE },
      { reason: 'odata_nav_not_expanded', evidence: 'http://insecure.example' },
      { reason: 'odata_nav_not_expanded' },
      { evidence: EVIDENCE },
      'yes',
    ]) {
      const r = crossCheckCatalogOpenApi(
        manifest([{ ...unprovable[0]!, openapi_absent: bad }], GRAPH_ALIAS), GRAPH_DOC);
      expect(errs(r), JSON.stringify(bad)).toHaveLength(1);
      expect(exempts(r), JSON.stringify(bad)).toHaveLength(0);
    }
  });

  const gate = (openapiAbsent: unknown, extra: Record<string, unknown> = {}) => validateIngredient(
    ingredient(manifest([{
      key: 'x', method: 'get', path_template: '/x', openapi_absent: openapiAbsent, ...extra,
    }])) as never);

  it('the shape gate names the closed reason list', () => {
    const r = gate({ reason: 'made_up', evidence: EVIDENCE });
    const m = errs(r).find((i) => i.path.endsWith('openapi_absent.reason'))?.message ?? '';
    for (const reason of OPENAPI_ABSENT_REASONS) expect(m).toContain(reason);
  });

  it('the shape gate requires https evidence', () => {
    for (const evidence of [undefined, '', 'http://x.example', 'see the docs']) {
      const r = gate({ reason: 'odata_nav_not_expanded', ...(evidence !== undefined ? { evidence } : {}) });
      expect(errs(r).some((i) => i.path.endsWith('openapi_absent.evidence')), String(evidence)).toBe(true);
    }
  });

  it('the shape gate rejects unknown keys', () => {
    const r = gate({ reason: 'odata_nav_not_expanded', evidence: EVIDENCE, note: 'trust me' });
    expect(errs(r).some((i) => i.message.includes('unknown key(s): note'))).toBe(true);
  });

  it('⛔ rejects openapi_path and openapi_absent together', () => {
    // Incoherent rather than redundant: one says the document proves this op at
    // a given path, the other that it cannot prove it at all.
    const r = gate({ reason: 'odata_nav_not_expanded', evidence: EVIDENCE }, { openapi_path: '/x' });
    expect(errs(r).some((i) => i.message.includes('declares both openapi_path and openapi_absent'))).toBe(true);
  });

  it('accepts a well-formed exemption with no complaint', () => {
    const r = gate({ reason: 'odata_nav_not_expanded', evidence: EVIDENCE });
    expect(errs(r).filter((i) => i.path.includes('openapi_absent'))).toEqual([]);
  });
});

describe('D-271 AMENDED — a Source op may be exempted ONLY as undocumented_in_spec', () => {
  const sourceManifest = (absent: unknown) => {
    const m = manifest([{
      key: 'task.list', method: 'get', path_template: '/me/drive/root/children',
      openapi_absent: absent,
    }], GRAPH_ALIAS);
    return {
      ...m,
      work_entity_sources: [{
        contract_source: { kind: 'openapi', url: 'https://example.com/openapi.json', sha256: SHA },
        ops: { list: 'task.list' },
      }],
    };
  };

  it('ADMITS `undocumented_in_spec`, and says so at WARN rather than silently', () => {
    // The relaxation exists because the proof it replaced established `(method,
    // path)` and nothing else — never `remote.version.field`, `hash_fields` or
    // pagination, which is everything Source sync actually drifts on. Refusing
    // every exemption made a real, vendor-documented capability (the Bitbucket
    // issue tracker, absent from all three Atlassian specs) permanently
    // unexpressible.
    const r = crossCheckCatalogOpenApi(
      sourceManifest({ reason: 'undocumented_in_spec', evidence: EVIDENCE }), GRAPH_DOC);
    expect(errs(r)).toEqual([]);
    // ⛔ The load-bearing half: a Source resting on an attestation must be
    // FINDABLE. Silence here would make the higher-trust case indistinguishable
    // from an ordinary proven op.
    const warned = r.issues.filter((i) => i.code === 'CATALOG_OPENAPI_SOURCE_OP_EXEMPT');
    expect(warned).toHaveLength(1);
    expect(warned[0]!.severity).toBe('warn');
  });

  it('⛔ still REFUSES a structural reason on a Source', () => {
    // `odata_*` describes a conversion artefact — a property of the vendor's
    // tooling that a different pin or profile might not share — so a Source on
    // one should be repinned, not attested.
    for (const reason of ['odata_nav_not_expanded', 'odata_function_method_absent']) {
      const r = crossCheckCatalogOpenApi(sourceManifest({ reason, evidence: EVIDENCE }), GRAPH_DOC);
      expect(errs(r).some((i) => i.code === 'CATALOG_OPENAPI_SOURCE_OP_UNPROVABLE'), reason).toBe(true);
      expect(errs(r).some((i) => i.message.includes('Repin')), reason).toBe(true);
    }
  });

  it('⛔ a MALFORMED exemption on a Source is unprovable, not exempt', () => {
    // The shape check runs first, so a Source cannot reach the relaxation with a
    // reason the gate would have refused anyway.
    const r = crossCheckCatalogOpenApi(
      sourceManifest({ reason: 'undocumented_in_spec', evidence: 'http://insecure' }), GRAPH_DOC);
    expect(errs(r).some((i) => i.code === 'CATALOG_OPENAPI_MISMATCH')).toBe(true);
    expect(r.issues.some((i) => i.code === 'CATALOG_OPENAPI_SOURCE_OP_EXEMPT')).toBe(false);
  });

  it('refuses a Source op with NO REST binding at all — the relaxation widened nothing here', () => {
    // The pre-existing rule: a Source naming an op the catalog does not bind is
    // unprovable for a different and simpler reason than exemption policy, and
    // the amendment must not have opened that door on its way past.
    const m = manifest([{ key: 'other.op', method: 'get', path_template: '/me' }], GRAPH_ALIAS);
    const withSource = {
      ...m,
      work_entity_sources: [{
        contract_source: { kind: 'openapi', url: 'https://example.com/openapi.json', sha256: SHA },
        ops: { list: 'task.list' },
      }],
    };
    const e = errs(crossCheckCatalogOpenApi(withSource, GRAPH_DOC));
    expect(e.some((i) => i.code === 'CATALOG_OPENAPI_SOURCE_OP_UNPROVABLE')).toBe(true);
    expect(e.some((i) => i.message.includes('no provable REST execution binding'))).toBe(true);
  });
});
